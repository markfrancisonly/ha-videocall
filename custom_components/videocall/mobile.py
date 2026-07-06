"""Companion-app ring notifications — SPEC.md §7.

Phones are push-then-join: ring = actionable notification; Answer deep-links
into a dashboard whose card resource joins the call; Decline comes back as a
mobile_app_notification_action event.
"""

from __future__ import annotations

import json
import logging

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
)
from homeassistant.util import slugify

from .const import (
    DECLINE_ACTION_PREFIX,
    DEEP_LINK_PARAM,
    NOTIF_CHANNEL,
    NOTIF_TAG_PREFIX,
)
from .models import Call, EndReason

_LOGGER = logging.getLogger(__name__)

MOBILE_APP_DOMAIN = "mobile_app"
NOTIFICATION_ACTION_EVENT = "mobile_app_notification_action"


class MobileRinger:
    """Resolves person → notify services and sends/clears ring notifications."""

    def __init__(self, hass: HomeAssistant, get_options, end_call_cb) -> None:
        self.hass = hass
        self._get_options = get_options       # () -> dict (live entry options)
        self._end_call_cb = end_call_cb       # (call_id, EndReason|"decline") hook
        self._unsub_action = hass.bus.async_listen(
            NOTIFICATION_ACTION_EVENT, self._on_notification_action
        )

    @callback
    def async_unload(self) -> None:
        self._unsub_action()

    # ------------------------------------------------------------------
    # resolution (SPEC §4.3)
    # ------------------------------------------------------------------

    def resolve_notify_services(self, person_entity_id: str) -> list[str]:
        """person.x → ["notify.mobile_app_<device>", ...].

        Order: (1) manual person_notify_map option, (2) mobile_app config
        entries whose registration user_id matches the person's user_id.
        Returns [] when the person has no phones — callers treat that as
        browser-only ring.
        """
        options = self._get_options()
        try:
            manual = json.loads(options.get("person_notify_map") or "{}")
        except ValueError:
            manual = {}
        if not isinstance(manual, dict):  # stray null/scalar left in the option
            manual = {}
        if person_entity_id in manual:
            return [self._strip_notify(s) for s in manual[person_entity_id]]

        state = self.hass.states.get(person_entity_id)
        user_id = state.attributes.get("user_id") if state else None
        if not user_id:
            return []

        services = []
        available = self.hass.services.async_services().get("notify", {})
        for entry in self.hass.config_entries.async_entries(MOBILE_APP_DOMAIN):
            if entry.data.get("user_id") != user_id:
                continue
            device_name = entry.data.get("device_name") or entry.title
            service = f"mobile_app_{slugify(device_name)}"
            if service in available:
                services.append(service)
            else:
                _LOGGER.debug("mobile_app entry %s: notify.%s not found", entry.title, service)
        return services

    @staticmethod
    def _strip_notify(service: str) -> str:
        return service.removeprefix("notify.")

    # ------------------------------------------------------------------
    # companion devices as push-reachable roster entries (SPEC §4.4)
    #
    # Push reaches a CLOSED app (FCM/APNs), so these are always callable —
    # never gate them on an open session / registered endpoint.
    # ------------------------------------------------------------------

    def list_mobile_devices(self) -> list[dict]:
        """MobileInfo dicts for every mobile_app entry with a live notify service."""
        dev_reg = dr.async_get(self.hass)
        area_reg = ar.async_get(self.hass)
        available = self.hass.services.async_services().get("notify", {})

        out: list[dict] = []
        for entry in self.hass.config_entries.async_entries(MOBILE_APP_DOMAIN):
            device_name = entry.data.get("device_name") or entry.title
            service = f"mobile_app_{slugify(device_name)}"
            if service not in available:
                continue
            devices = dr.async_entries_for_config_entry(dev_reg, entry.entry_id)
            device = devices[0] if devices else None
            area_id = device.area_id if device else None
            area = area_reg.async_get_area(area_id) if area_id else None
            out.append(
                {
                    "notify_service": service,
                    "name": (device.name_by_user or device.name) if device else device_name,
                    "user_id": entry.data.get("user_id"),
                    "area_id": area_id,
                    "area_name": area.name if area else None,
                    "device_id": device.id if device else None,
                    "os_name": (entry.data.get("os_name") or "").lower(),   # ios/android
                    "model": (entry.data.get("model") or "").lower(),       # iphone17,2 …
                }
            )
        return out

    def find_companion_match(
        self, user_id: str, ua_kind: str, ua_hint: str | None
    ) -> dict | None:
        """The mobile_app device a registering companion endpoint IS (SPEC §4.4).

        Match by user + platform, narrowed by the UA hint (iphone/ipad vs the
        registration's hardware model). Returns the MobileInfo only when the
        match is UNIQUE — ambiguity (e.g. two iPads on one user, no hint)
        falls back to an unlinked endpoint rather than guessing.
        """
        # iPads register with os_name "iPadOS" (not "iOS"); older iPhones may
        # report "iPhone OS" — accept the whole Apple family for companion-ios.
        want_os = {
            "companion-ios": {"ios", "ipados", "iphone os"},
            "companion-android": {"android"},
        }.get(ua_kind)
        if not want_os:
            return None
        candidates = [
            m for m in self.list_mobile_devices()
            if m["user_id"] == user_id and m["os_name"] in want_os
        ]
        if ua_hint and len(candidates) > 1:
            hinted = [m for m in candidates if m["model"].startswith(ua_hint)]
            if hinted:
                candidates = hinted
        # Same-class tie the coarse iphone/ipad hint can't split (e.g. two iPads
        # on one user): prefer the device whose companion is actually alive.
        # A removed/retired app leaves its mobile_app entities 'unavailable', so
        # the live device wins the tie — no guessing (SPEC §4.4).
        if len(candidates) > 1:
            live = [m for m in candidates if self._device_active(m.get("device_id"))]
            if len(live) == 1:
                candidates = live
        if len(candidates) != 1:
            _LOGGER.debug(
                "companion match for user=%s kind=%s hint=%s: %d candidates — not linking",
                user_id[:8], ua_kind, ua_hint, len(candidates),
            )
            return None
        return candidates[0]

    def _device_active(self, device_id: str | None) -> bool:
        """True if the device has ≥1 entity currently reporting a real state.

        A live companion keeps its sensors reporting even when backgrounded; a
        removed/retired one goes 'unavailable'. Used only to break a same-class
        match tie (SPEC §4.4) — never to hide a phone from push targeting.
        """
        if not device_id:
            return False
        ent_reg = er.async_get(self.hass)
        for ent in er.async_entries_for_device(ent_reg, device_id):
            state = self.hass.states.get(ent.entity_id)
            if state and state.state not in ("unavailable", "unknown"):
                return True
        return False

    def services_for_area(self, area_id: str) -> list[str]:
        """Phones whose HA device is assigned to the area (area targeting)."""
        return [
            m["notify_service"] for m in self.list_mobile_devices()
            if m["area_id"] == area_id
        ]

    def validate_services(self, services: list[str]) -> list[str]:
        """Filter to notify services that actually exist right now."""
        available = self.hass.services.async_services().get("notify", {})
        return [self._strip_notify(s) for s in services
                if self._strip_notify(s) in available]

    # ------------------------------------------------------------------
    # ring / clear (SPEC §7.1)
    # ------------------------------------------------------------------

    async def async_send_ring(self, call: Call, caller_info: dict, services: list[str]) -> None:
        options = self._get_options()
        dashboard = options.get("answer_dashboard") or "/lovelace"
        ring_timeout = int(options.get("ring_timeout") or 30)
        answer_uri = f"{dashboard}?{DEEP_LINK_PARAM}={call.call_id}"
        icon = "📹" if call.media == "video" else "📞"
        # Same identity format as the in-app ring UI: "Mark (browser fc9b61)" —
        # the USER calling, with the endpoint for disambiguation (SPEC §9.3).
        name = caller_info.get("name") or (caller_info.get("client_id") or "")[:6]
        user = caller_info.get("user_name")
        caller_label = (
            f"{user} ({name})" if user and user != name else (name or "Home Assistant")
        )

        payload = {
            "title": f"{icon} Incoming {call.media} call",
            "message": f"{caller_label} is calling",
            "data": {
                "tag": f"{NOTIF_TAG_PREFIX}{call.call_id}",
                "channel": NOTIF_CHANNEL,
                "importance": "high",
                "ttl": 0,
                "priority": "high",
                "timeout": ring_timeout,
                "persistent": True,
                "sticky": True,
                "actions": [
                    {
                        "action": "URI",
                        "title": "Answer",
                        "uri": answer_uri,
                        # iOS: default activationMode is background — the app
                        # would never open. foreground is required for the
                        # Answer tap to launch into the deep link (harmless on
                        # Android, which ignores unknown keys).
                        "activationMode": "foreground",
                    },
                    {"action": f"{DECLINE_ACTION_PREFIX}{call.call_id}", "title": "Decline"},
                ],
                # iOS (ignored by Android)
                "url": answer_uri,
                # Regular (non-critical) alert with the default notification
                # sound — no "Critical Alerts" permission required. Kept
                # `time-sensitive` so an incoming call still surfaces through a
                # Focus/DND schedule, without the loudness/consent a critical
                # alert demands. To use a custom ringtone, import a 32-bit-float
                # 48kHz WAV into the HA iOS app (Settings → Companion App →
                # Notifications → Sounds) and set "sound" to its filename.
                "push": {
                    "sound": "default",
                    "interruption-level": "time-sensitive",
                },
            },
        }
        for service in services:
            try:
                await self.hass.services.async_call("notify", service, payload, blocking=False)
            except Exception:  # noqa: BLE001 — one dead phone must not kill the ring
                _LOGGER.warning("ring push via notify.%s failed", service, exc_info=True)

    async def async_clear_ring(self, call_id: str, services: list[str]) -> None:
        payload = {
            "message": "clear_notification",
            "data": {"tag": f"{NOTIF_TAG_PREFIX}{call_id}"},
        }
        for service in services:
            try:
                await self.hass.services.async_call("notify", service, payload, blocking=False)
            except Exception:  # noqa: BLE001
                _LOGGER.debug("clear push via notify.%s failed", service)

    # ------------------------------------------------------------------
    # decline action (SPEC §7.3)
    # ------------------------------------------------------------------

    @callback
    def _on_notification_action(self, event: Event) -> None:
        action = event.data.get("action") or ""
        if not action.startswith(DECLINE_ACTION_PREFIX):
            return
        call_id = action[len(DECLINE_ACTION_PREFIX):]
        self._end_call_cb(call_id)  # __init__.py maps this to a mobile-slot decline
