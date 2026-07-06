"""videocall — HA-native WebRTC video calling. See SPEC.md."""

from __future__ import annotations

import json
import logging
import re

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_send
import voluptuous as vol

from . import ws_api
from .const import (
    SIGNAL_ENDPOINT_REMOVED,
    DEFAULT_ALLOW_DROP_IN,
    DEFAULT_ANSWER_DASHBOARD,
    DEFAULT_ICE_SERVERS,
    DEFAULT_RING_TIMEOUT,
    DEFAULT_TURN_STUN,
    DOMAIN,
    ENDED_CALL_LOG_SIZE,
    OPT_ALLOW_DROP_IN,
    OPT_ANSWER_DASHBOARD,
    OPT_ICE_SERVERS,
    OPT_RING_TIMEOUT,
    OPT_TURN_CREDENTIAL,
    OPT_TURN_HOST,
    OPT_TURN_LAN_HOST,
    OPT_TURN_STUN,
    OPT_TURN_USERNAME,
)
from .frontend import async_register_frontend
from .mobile import MobileRinger
from .models import CallRegistry, EndpointRegistry, EndReason, Endpoint

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["binary_sensor", "sensor"]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

BROWSER_MOD_DOMAIN = "browser_mod"


class VideocallData:
    """hass.data[DOMAIN] — everything the ws_api/platforms need."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.endpoints = EndpointRegistry()
        self.calls = CallRegistry(log_size=ENDED_CALL_LOG_SIZE)
        self.ring_timeouts: dict[str, callable] = {}
        self.roster_unsub = None
        self.mobile = MobileRinger(hass, self._options, self._mobile_decline)

    # --- live options (no reload needed for value reads) --------------------

    def _options(self) -> dict:
        return dict(self.entry.options)

    @property
    def ice_servers(self) -> list:
        opts = self.entry.options
        host = (opts.get(OPT_TURN_HOST) or "").strip()
        lan = (opts.get(OPT_TURN_LAN_HOST) or "").strip()

        def _hostport(h: str) -> str:
            return h if ":" in h else f"{h}:3478"

        # Base STUN list, by precedence:
        #   1) "Use my TURN server for STUN" checkbox (+ a TURN host) → your own
        #      coturn for STUN, no public dependency, no JSON to hand-write.
        #   2) advanced ice_servers JSON override: blank → skip to (3);
        #      [] / null → NO default servers; a valid RTCIceServer[] → used as-is.
        #   3) the public default STUN.
        # Malformed advanced JSON falls back to the default (with a warning).
        if opts.get(OPT_TURN_STUN, DEFAULT_TURN_STUN) and host:
            stun = [f"stun:{_hostport(host)}"]
            if lan:
                stun.append(f"stun:{_hostport(lan)}")
            servers: list = [{"urls": stun}]
        else:
            raw = opts.get(OPT_ICE_SERVERS, "")
            if isinstance(raw, str) and raw.strip():
                try:
                    servers = json.loads(raw)
                except ValueError:
                    _LOGGER.warning("Invalid ice_servers option JSON; using default")
                    servers = json.loads(DEFAULT_ICE_SERVERS)
                if not isinstance(servers, list):  # e.g. null → no default servers
                    servers = []
            else:
                servers = json.loads(DEFAULT_ICE_SERVERS)

        # Compose the TURN entry from the simple fields (preferred config path)
        # so users never hand-write RTCIceServer JSON. host is "host" or
        # "host:port" (defaults to 3478); the optional LAN address lets
        # on-network clients relay without NAT hairpinning.
        if host:
            urls = [
                f"turn:{_hostport(host)}?transport=udp",
                f"turn:{_hostport(host)}?transport=tcp",
            ]
            if lan:
                urls.append(f"turn:{_hostport(lan)}?transport=udp")
            turn: dict = {"urls": urls}
            user = (opts.get(OPT_TURN_USERNAME) or "").strip()
            cred = opts.get(OPT_TURN_CREDENTIAL) or ""
            if user:
                turn["username"] = user
            if cred:
                turn["credential"] = cred
            servers.append(turn)

        # De-dupe: the checkbox/TURN fields can compose an entry a user also
        # pasted into the advanced JSON — emit each server once.
        seen: set[str] = set()
        deduped = []
        for s in servers:
            key = json.dumps(s, sort_keys=True)
            if key not in seen:
                seen.add(key)
                deduped.append(s)
        return deduped

    @property
    def ring_timeout(self) -> int:
        return int(self.entry.options.get(OPT_RING_TIMEOUT, DEFAULT_RING_TIMEOUT))

    @property
    def allow_drop_in(self) -> bool:
        return bool(self.entry.options.get(OPT_ALLOW_DROP_IN, DEFAULT_ALLOW_DROP_IN))

    def drop_in_allowed(self, target: Endpoint, caller: Endpoint) -> bool:
        """Per-endpoint drop-in consent (SPEC §5.4a) — DEVICE-OWNED.

        Each endpoint declares its own allowed callers at registration (set
        via the videocall-card ON that device; household trust model — this
        is deliberately not central/high-security config). None = follow the
        global allow_drop_in default; [] = nobody; a non-empty list admits
        ONLY those users (user_id or user name).
        """
        allow = target.drop_in_allow
        if allow is None:
            return self.allow_drop_in
        if not allow:
            return False
        ids = {str(a).lower() for a in allow}
        return bool(
            (caller.user_id and caller.user_id.lower() in ids)
            or (caller.user_name and caller.user_name.lower() in ids)
        )

    # --- endpoint device / area resolution (SPEC §4.2) ----------------------

    async def async_resolve_endpoint_device(self, endpoint: Endpoint) -> None:
        dev_reg = dr.async_get(self.hass)

        suggested_area = None
        adopted_name = None

        # 1) companion app → unify with its mobile_app device (SPEC §4.4):
        #    the phone HA already knows ("Mark's iPhone …") IS this endpoint.
        endpoint.notify_service = None
        if endpoint.ua_kind.startswith("companion") and endpoint.user_id:
            match = self.mobile.find_companion_match(
                endpoint.user_id, endpoint.ua_kind, endpoint.ua_hint
            )
            if match:
                endpoint.notify_service = match["notify_service"]
                adopted_name = match["name"]
                suggested_area = match["area_id"]

        # 2) browser_mod adoption — but IGNORE its auto-generated junk names
        #    (browser_mod_<hex>_<hex>); those are ids, not names.
        if endpoint.browser_mod_id:
            bm_device = dev_reg.async_get_device(
                identifiers={(BROWSER_MOD_DOMAIN, endpoint.browser_mod_id)}
            )
            if bm_device:
                if suggested_area is None:
                    suggested_area = bm_device.area_id
                bm_name = bm_device.name_by_user or bm_device.name
                if (
                    adopted_name is None
                    and bm_name
                    and not re.match(r"^browser_mod_[0-9a-f]{6,}", bm_name)
                ):
                    adopted_name = bm_name

        # 3) fallback: name by USER + browser/OS — the client_id lives in the
        #    device's serial_number field, never in the display name.
        kind_label = {
            "companion-ios": "iOS app",
            "companion-android": "Android app",
        }.get(endpoint.ua_kind) or endpoint.browser_hint or "browser"
        name = endpoint.name or adopted_name or (
            f"{endpoint.user_name}'s {kind_label}"
            if endpoint.user_name
            else f"Videocall {kind_label}"
        )

        # name collision with a DIFFERENT endpoint's device → short #suffix
        # (only then; hex stays out of names otherwise)
        taken = {
            (d.name_by_user or d.name)
            for d in dr.async_entries_for_config_entry(dev_reg, self.entry.entry_id)
            if (DOMAIN, endpoint.client_id) not in d.identifiers
        }
        if name in taken:
            name = f"{name} #{endpoint.client_id[:4]}"

        device = dev_reg.async_get_or_create(
            config_entry_id=self.entry.entry_id,
            identifiers={(DOMAIN, endpoint.client_id)},
            name=name,
            manufacturer="videocall",
            model=endpoint.ua_kind,
            serial_number=endpoint.client_id,
        )
        # migrate earlier auto-generated names (hex-in-name / browser_mod junk /
        # v0.6.0's undifferentiated "X's browser") — but never a user rename
        if (
            device.name_by_user is None
            and device.name != name
            and re.match(
                r"^(Videocall (browser|companion)|browser_mod_[0-9a-f]"
                r"|.+'s (browser|iOS app|Android app)$)",
                device.name or "",
            )
        ):
            dev_reg.async_update_device(device.id, name=name)
            device = dev_reg.async_get(device.id)
        # adopt the suggested area only if the user hasn't set one on OUR device
        if suggested_area and device.area_id is None:
            dev_reg.async_update_device(device.id, area_id=suggested_area)
            device = dev_reg.async_get(device.id)

        endpoint.device_id = device.id
        endpoint.name = device.name_by_user or device.name or name
        endpoint.area_id = device.area_id
        if device.area_id:
            from homeassistant.helpers import area_registry as ar

            area = ar.async_get(self.hass).async_get_area(device.area_id)
            endpoint.area_name = area.name if area else None
        else:
            endpoint.area_name = None

    # --- mobile decline hook --------------------------------------------------

    @callback
    def _mobile_decline(self, call_id: str) -> None:
        call = self.calls.get(call_id)
        if call is None:
            return
        if self.calls.decline(call, None):  # None = one mobile slot (SPEC §7.3)
            ws_api.async_end_call(self.hass, call, EndReason.DECLINED)


async def async_setup(hass: HomeAssistant, config) -> bool:
    return True


@callback
def async_prune_offline_endpoints(hass: HomeAssistant) -> int:
    """Remove every videocall DEVICE whose endpoint is not online right now.

    Must iterate the persistent device registry, NOT the in-memory endpoint
    map — that map is empty after each HA restart (endpoints exist there only
    once a browser re-registers), so an in-memory prune reports "0 removed"
    while a dozen stale devices remain. Shared by the
    videocall.prune_endpoints service and the options-flow menu action.
    Online endpoints are never touched.
    """
    data: VideocallData | None = hass.data.get(DOMAIN)
    if data is None:
        return 0
    dev_reg = dr.async_get(hass)
    online_ids = {ep.client_id for ep in data.endpoints.online()}
    pruned = 0
    for device in dr.async_entries_for_config_entry(dev_reg, data.entry.entry_id):
        client_ids = [ident[1] for ident in device.identifiers if ident[0] == DOMAIN]
        if not client_ids or client_ids[0] in online_ids:
            continue
        dev_reg.async_update_device(
            device.id, remove_config_entry_id=data.entry.entry_id
        )
        data.endpoints.remove(client_ids[0])
        # tell the entity platforms to forget this client_id — otherwise a
        # re-registering endpoint is "already known" and never gets its
        # online/call-state entities back after a prune
        async_dispatcher_send(hass, SIGNAL_ENDPOINT_REMOVED, client_ids[0])
        pruned += 1
    _LOGGER.info("videocall: pruned %d offline endpoint device(s)", pruned)
    return pruned


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = VideocallData(hass, entry)
    hass.data[DOMAIN] = data

    ws_api.async_register_commands(hass)
    await async_register_frontend(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # ---- services (SPEC §8) -------------------------------------------------

    async def svc_hangup(call: ServiceCall) -> None:
        call_id = call.data.get("call_id")
        targets = (
            [data.calls.get(call_id)] if call_id else list(data.calls.active())
        )
        for c in targets:
            if c:
                ws_api.async_end_call(hass, c, EndReason.HANGUP)

    async def svc_prune(call: ServiceCall) -> None:
        async_prune_offline_endpoints(hass)

    hass.services.async_register(
        DOMAIN, "hangup", svc_hangup,
        vol.Schema({vol.Optional("call_id"): str}),
    )
    hass.services.async_register(
        DOMAIN, "prune_endpoints", svc_prune,
        vol.Schema({vol.Optional("days", default=30): int}),
    )

    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    # options are read live (VideocallData properties) so there's nothing to
    # reload — BUT already-connected clients only learn of new config
    # (ice_servers/TURN, ring_timeout, …) via a roster push. Broadcast one now,
    # otherwise the change doesn't reach open dashboards until they happen to
    # get an unrelated roster event or the page is reloaded/re-registered.
    _LOGGER.debug("videocall options updated: %s", entry.options)
    if DOMAIN in hass.data:
        ws_api.async_push_roster(hass)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    data: VideocallData = hass.data.pop(DOMAIN, None)
    if data:
        for unsub in data.ring_timeouts.values():
            unsub()
        data.mobile.async_unload()
    # NOTE: websocket commands cannot be unregistered; handlers no-op once
    # hass.data[DOMAIN] is gone (guarded lookups raise unknown_call/not_registered).
    return ok
