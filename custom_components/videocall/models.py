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
    # set when this endpoint IS a companion app unified with a mobile_app
    # device (SPEC §4.4) — links the roster's phone row to this endpoint
    notify_service: str | None = None
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
            "notify_service": self.notify_service,
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
        existing.connected_at = endpoint.connected_at
        existing.reg_token = endpoint.reg_token
        return existing

    def set_offline(self, client_id: str) -> Endpoint | None:
        ep = self._endpoints.get(client_id)
        if ep:
            ep.send_event = None
        return ep

    def remove(self, client_id: str) -> None:
        self._endpoints.pop(client_id, None)

    def __len__(self) -> int:
        return len(self._endpoints)

    # --- targeting (SPEC.md §5.1 invite) -----------------------------------

    def resolve_targets(
        self, target_type: str, target_id: str | None, exclude: str,
        person_user_id: str | None = None,
    ) -> list[Endpoint]:
        """Online, idle endpoints matching the target; caller excluded."""
        candidates = [
            e for e in self.online()
            if e.client_id != exclude and not e.in_call
        ]
        if target_type == "endpoint":
            return [e for e in candidates if e.client_id == target_id]
        if target_type == "area":
            return [e for e in candidates if e.area_id == target_id]
        if target_type == "person":
            return [e for e in candidates if person_user_id and e.user_id == person_user_id]
        if target_type == "all":
            return candidates
        return []


@dataclass
class Call:
    """One 1:1 call, from invite to end."""

    call_id: str
    caller_id: str                          # client_id
    media: str = "video"                    # video | audio
    drop_in: bool = False                   # auto-answer invite (SPEC §5.4a)
    target_type: str = "endpoint"
    target_id: str | None = None
    state: CallState = CallState.RINGING

    ringing: set[str] = field(default_factory=set)   # client_ids currently rung
    declined: set[str] = field(default_factory=set)
    mobile_pending: int = 0                 # virtual decline slots for pushed phones
    mobile_notify_services: list[str] = field(default_factory=list)  # for clear
    mobile_user_ids: set[str] = field(default_factory=set)  # late ring delivery

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

    def all_declined(self) -> bool:
        """Every rung endpoint declined and no mobile push can still answer."""
        return not self.ringing and self.mobile_pending <= 0

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

    def accept(self, call: Call, callee_id: str) -> set[str]:
        """First accept wins. Returns the OTHER ringing endpoints to cancel.

        An endpoint NOT in the ring set may accept when the call pushed to
        mobile: a cold-started companion app never received the ring event
        (it wasn't online at invite time) and joins late via the notification
        deep link (SPEC §7.2).
        """
        if call.state is not CallState.RINGING:
            raise InvalidTransition("too_late")
        if callee_id not in call.ringing and not call.mobile_notify_services:
            raise InvalidTransition("too_late")
        call.state = CallState.CONNECTING
        call.callee_id = callee_id
        others = set(call.ringing) - {callee_id}
        call.ringing.clear()
        call.mobile_pending = 0
        return others

    def mark_active(self, call: Call) -> None:
        if call.state is CallState.CONNECTING:
            call.state = CallState.ACTIVE
            call.answered_at = time.time()

    def decline(self, call: Call, client_id: str | None) -> bool:
        """Register a decline (client_id None = one mobile slot). True if that
        exhausted all possible answerers."""
        if call.state is not CallState.RINGING:
            return False
        if client_id is None:
            call.mobile_pending = max(0, call.mobile_pending - 1)
        else:
            call.ringing.discard(client_id)
            call.declined.add(client_id)
        return call.all_declined()

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
