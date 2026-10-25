"""Pure-python domain model: endpoints, calls, and the 1:1 call state machine.

No Home Assistant imports on purpose (SPEC.md §6) — this file is unit-testable
with plain pytest. All mutation goes through EndpointRegistry / CallRegistry so
ws_api.py stays a thin transport layer.

State machine (SPEC.md §5.3):

    invite            accept              answer relayed
  ────────► RINGING ────────► CONNECTING ────────────► ACTIVE
               │ cancel/timeout/all-declined  │ hangup/disconnect
               ▼                              ▼
             ENDED(reason)                  ENDED(reason)
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Deque, Iterable


class CallState(str, Enum):
    RINGING = "ringing"
    CONNECTING = "connecting"
    ACTIVE = "active"
    ENDED = "ended"


class EndReason(str, Enum):
    HANGUP = "hangup"
    DECLINED = "declined"
    TIMEOUT = "timeout"                    # missed
    CALLER_CANCEL = "caller_cancel"
    PEER_DISCONNECTED = "peer_disconnected"
    SUPERSEDED = "superseded"
    ERROR = "error"


@dataclass
class Endpoint:
    """One registered browser (or companion webview) client."""

    client_id: str
    ua_kind: str = "browser"               # browser | companion-android | companion-ios
    ua_hint: str | None = None             # iphone | ipad | None (companion model hint)
    browser_hint: str | None = None        # "Chrome (Windows)" — plain-browser naming
    name: str = ""
    browser_mod_id: str | None = None
    # the mobile_app device this endpoint is the companion app of (SPEC §4.4);
    # kept as the videocall device's via device, so it survives restarts
    phone_device_id: str | None = None
    # DEVICE-OWNED drop-in consent (SPEC §5.4a): None = follow the global
    # default; [] = nobody; [user_id/name, …] = exclusively those callers
    drop_in_allow: list | None = None

    # resolved server-side (device/area registries) — see __init__.py resolver
    device_id: str | None = None
    area_id: str | None = None
    area_name: str | None = None

    # live connection state — (send_event, close) callables owned by ws_api
    user_id: str | None = None
    user_name: str | None = None
    send_event: Callable[[dict], None] | None = None
    # the websocket connection that registered it: client-asserted ids in
    # later commands must come from this connection (SPEC §5.1)
    connection: Any = None
    connected_at: float = 0.0
    # unique per REGISTRATION: lets a stale close callback (from a superseded
    # subscription) recognize that a newer registration owns the endpoint now
    reg_token: str = ""

    # call participation
    call_id: str | None = None             # the one call this endpoint is party to

    @property
    def online(self) -> bool:
        return self.send_event is not None

    @property
    def in_call(self) -> bool:
        return self.call_id is not None

    def info(self) -> dict[str, Any]:
        """EndpointInfo wire shape (SPEC.md §5.2)."""
        return {
            "endpoint_id": self.client_id,
            "client_id": self.client_id,
            "name": self.name,
            "area_id": self.area_id,
            "area_name": self.area_name,
            "ua_kind": self.ua_kind,
            "user_id": self.user_id,
            "user_name": self.user_name,
            "online": self.online,
            "in_call": self.in_call,
        }


class EndpointRegistry:
    """client_id → Endpoint. Bounded (MAX_ENDPOINTS enforced by caller)."""

    def __init__(self) -> None:
        self._endpoints: dict[str, Endpoint] = {}

    def get(self, client_id: str) -> Endpoint | None:
        return self._endpoints.get(client_id)

    def all(self) -> Iterable[Endpoint]:
        return self._endpoints.values()

    def online(self) -> list[Endpoint]:
        return [e for e in self._endpoints.values() if e.online]

    def upsert(self, endpoint: Endpoint) -> Endpoint:
        """Insert or refresh; caller handles superseding the old connection."""
        existing = self._endpoints.get(endpoint.client_id)
        if existing is None:
            self._endpoints[endpoint.client_id] = endpoint
            return endpoint
        # keep persisted identity (device/area) — refresh live-connection fields
        existing.ua_kind = endpoint.ua_kind
        existing.ua_hint = endpoint.ua_hint or existing.ua_hint
        existing.browser_hint = endpoint.browser_hint or existing.browser_hint
        existing.drop_in_allow = endpoint.drop_in_allow
        existing.name = endpoint.name or existing.name
        existing.browser_mod_id = endpoint.browser_mod_id or existing.browser_mod_id
        existing.user_id = endpoint.user_id
        existing.user_name = endpoint.user_name
        existing.send_event = endpoint.send_event
        existing.connection = endpoint.connection
        existing.connected_at = endpoint.connected_at
        existing.reg_token = endpoint.reg_token
        return existing

    def set_offline(self, client_id: str) -> Endpoint | None:
        ep = self._endpoints.get(client_id)
        if ep:
            ep.send_event = None
            ep.connection = None
        return ep

    def remove(self, client_id: str) -> None:
        self._endpoints.pop(client_id, None)

    def __len__(self) -> int:
        return len(self._endpoints)

    # --- targeting (SPEC.md §5.1 invite) -----------------------------------

    def resolve_targets(
        self, target_type: str, target_id: str | None, exclude: str,
        person_user_id: str | None = None, phone_device_id: str | None = None,
    ) -> list[Endpoint]:
        """Online, idle endpoints matching the target; caller excluded."""
        candidates = [
            e for e in self.online()
            if e.client_id != exclude and not e.in_call
        ]
        if target_type == "endpoint":
            return [e for e in candidates if e.client_id == target_id]
        if target_type == "mobile":
            # the phone's open companion app rings in-app; the push goes out too
            return [
                e for e in candidates
                if phone_device_id and e.phone_device_id == phone_device_id
            ]
        if target_type == "area":
            return [e for e in candidates if e.area_id == target_id]
        if target_type == "person":
            return [e for e in candidates if person_user_id and e.user_id == person_user_id]
        if target_type == "all":
            return candidates
        return []


@dataclass(frozen=True)
class Phone:
    """A phone (mobile_app device) a call pushed its ring to (SPEC §7.1)."""

    notify_service: str
    device_id: str | None = None           # links the phone's companion endpoint
    user_id: str | None = None


@dataclass
class Call:
    """One 1:1 call, from invite to end."""

    call_id: str
    caller_id: str                          # client_id
    media: str = "video"                    # video | audio
    drop_in: bool = False                   # auto-answer invite (SPEC §5.4a)
    # SPEC §14 — doorbell/go2rtc intercom. When set, the caller is NOT a
    # registered endpoint: caller_info holds its wire identity, and `doorbell`
    # is the go2rtc descriptor {id, name, webrtc_url, stream, …} the accepting
    # client uses to connect its media directly to go2rtc (no SDP relay).
    caller_info: dict | None = None
    doorbell: dict | None = None
    target_type: str = "endpoint"
    target_id: str | None = None
    state: CallState = CallState.RINGING

    ringing: set[str] = field(default_factory=set)   # client_ids currently rung
    declined: set[str] = field(default_factory=set)
    # every phone the ring was pushed to, by notify service, and those still
    # ringing: neither declined nor answered elsewhere (SPEC §7)
    phones: dict[str, Phone] = field(default_factory=dict)
    ringing_phones: set[str] = field(default_factory=set)

    callee_id: str | None = None            # set on accept
    created_at: float = field(default_factory=time.time)
    answered_at: float | None = None
    ended_at: float | None = None
    end_reason: EndReason | None = None

    @property
    def peer_of(self) -> Callable[[str], str | None]:
        def _peer(client_id: str) -> str | None:
            if client_id == self.caller_id:
                return self.callee_id
            if client_id == self.callee_id:
                return self.caller_id
            return None
        return _peer

    def phone_of(self, ep: Endpoint) -> str | None:
        """Notify service of the still-ringing phone whose app `ep` is."""
        if self.state is CallState.RINGING and ep.phone_device_id:
            for service in self.ringing_phones:
                if self.phones[service].device_id == ep.phone_device_id:
                    return service
        return None

    def invites(self, ep: Endpoint) -> bool:
        """May `ep` join although it was not rung (SPEC §7.2)? A linked app
        only while its own phone rings; an unlinked companion app while any
        phone of its user rings."""
        if ep.phone_device_id:
            return self.phone_of(ep) is not None
        return (
            self.state is CallState.RINGING
            and ep.ua_kind.startswith("companion")
            and ep.user_id is not None
            and any(self.phones[s].user_id == ep.user_id for s in self.ringing_phones)
        )

    def all_declined(self) -> bool:
        """Nobody is left to answer: no endpoint and no phone still rings."""
        return not self.ringing and not self.ringing_phones

    def log_entry(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "caller": self.caller_id,
            "callee": self.callee_id,
            "media": self.media,
            "drop_in": self.drop_in,
            "target_type": self.target_type,
            "target_id": self.target_id,
            "created_at": self.created_at,
            "answered_at": self.answered_at,
            "ended_at": self.ended_at,
            "reason": self.end_reason.value if self.end_reason else None,
        }


class CallRegistry:
    """call_id → Call, plus a bounded log of ended calls."""

    def __init__(self, log_size: int = 50) -> None:
        self._calls: dict[str, Call] = {}
        self.ended_log: Deque[dict] = deque(maxlen=log_size)

    def get(self, call_id: str) -> Call | None:
        return self._calls.get(call_id)

    def active(self) -> list[Call]:
        return list(self._calls.values())

    def create(self, call: Call) -> Call:
        self._calls[call.call_id] = call
        return call

    # --- transitions --------------------------------------------------------

    def accept(self, call: Call, callee: Endpoint) -> set[str]:
        """First accept wins. Returns the OTHER ringing endpoints to cancel.

        An endpoint NOT in the ring set may accept while the call invites it
        through a pushed phone: a cold-started companion app never received
        the ring event (it wasn't online at invite time) and joins late via
        the notification deep link (SPEC §7.2).
        """
        if call.state is not CallState.RINGING:
            raise InvalidTransition("too_late")
        if callee.client_id not in call.ringing and not call.invites(callee):
            raise InvalidTransition("not_invited")
        call.state = CallState.CONNECTING
        call.callee_id = callee.client_id
        others = set(call.ringing) - {callee.client_id}
        call.ringing.clear()
        call.ringing_phones.clear()
        return others

    def mark_active(self, call: Call) -> None:
        if call.state is CallState.CONNECTING:
            call.state = CallState.ACTIVE
            call.answered_at = time.time()

    def decline(self, call: Call, client_id: str) -> bool:
        """Register an endpoint's decline. True if nobody is left to answer."""
        if call.state is not CallState.RINGING:
            return False
        call.ringing.discard(client_id)
        call.declined.add(client_id)
        return call.all_declined()

    def decline_phone(
        self, call: Call, service: str, endpoints: Iterable[Endpoint]
    ) -> list[Endpoint] | None:
        """A phone declined, on its notification or in its app (SPEC §7.3):
        the phone stops ringing and so does its app's in-app ring. Returns the
        app endpoints taken out of the ring set; None if the phone wasn't
        ringing."""
        if call.state is not CallState.RINGING or service not in call.ringing_phones:
            return None
        call.ringing_phones.discard(service)
        device_id = call.phones[service].device_id
        apps = [
            e for e in endpoints
            if device_id and e.phone_device_id == device_id and e.client_id in call.ringing
        ]
        for e in apps:
            self.decline(call, e.client_id)
        return apps

    def endpoint_state(self, ep: Endpoint) -> str:
        """Call state of one endpoint (SPEC §8): idle | ringing | in_call."""
        call = self._calls.get(ep.call_id) if ep.call_id else None
        if call is not None:
            if call.state is not CallState.RINGING:
                return "in_call"
            return "ringing"
        if any(c.phone_of(ep) for c in self._calls.values()):
            return "ringing"
        return "idle"

    def end(self, call: Call, reason: EndReason) -> None:
        if call.state is CallState.ENDED:
            return
        call.state = CallState.ENDED
        call.ended_at = time.time()
        call.end_reason = reason
        self._calls.pop(call.call_id, None)
        self.ended_log.append(call.log_entry())


class InvalidTransition(Exception):
    """Raised on an illegal FSM transition; message is the ws error code."""
