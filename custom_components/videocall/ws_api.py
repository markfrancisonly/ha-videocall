"""videocall websocket signaling API — SPEC.md §5.

Transport-only layer: schema validation, connection lifecycle, event push and
relay. All call/endpoint state lives in models.py; mobile push in mobile.py.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_call_later

from .const import (
    BUS_EVT_ANSWERED,
    BUS_EVT_ENDED,
    BUS_EVT_INCOMING,
    DOMAIN,
    EVT_ACCEPTED,
    EVT_ANSWER,
    EVT_CANDIDATE,
    EVT_HANGUP,
    EVT_OFFER,
    EVT_RING,
    EVT_RING_CANCEL,
    EVT_ROSTER,
    MAX_ENDPOINTS,
    MAX_SDP_BYTES,
    SIGNAL_CALL_LOG,
    SIGNAL_ENDPOINT_UPDATE,
    SIGNAL_NEW_ENDPOINT,
    WS_ACCEPT,
    WS_ANSWER,
    WS_CANCEL,
    WS_CANDIDATE,
    WS_DECLINE,
    WS_HANGUP,
    WS_INVITE,
    WS_OFFER,
    WS_REGISTER,
    WS_ROSTER,
)
from .models import Call, CallState, EndReason, Endpoint, InvalidTransition

_LOGGER = logging.getLogger(__name__)

TARGET_SCHEMA = vol.Schema(
    {
        vol.Required("type"): vol.In(["endpoint", "area", "person", "mobile", "all"]),
        vol.Optional("id"): vol.Any(str, None),
    }
)


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    for cmd in (
        ws_register, ws_roster, ws_invite, ws_cancel, ws_accept,
        ws_decline, ws_offer, ws_answer, ws_candidate, ws_hangup,
    ):
        websocket_api.async_register_command(hass, cmd)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _data(hass: HomeAssistant):
    """hass.data[DOMAIN] — VideocallData set up in __init__.py."""
    return hass.data[DOMAIN]


def _push(endpoint: Endpoint, event_type: str, payload: dict) -> None:
    """Push an event to one endpoint; connection may be mid-close — never raise."""
    if endpoint.send_event is None:
        return
    try:
        endpoint.send_event({"event_type": event_type, **payload})
    except Exception:  # noqa: BLE001 — push is best-effort by design
        _LOGGER.debug("push %s to %s failed", event_type, endpoint.client_id)


def _roster_payload(hass: HomeAssistant) -> dict[str, Any]:
    """Shared by videocall/roster result and pushed roster events (SPEC §5.1)."""
    data = _data(hass)
    endpoints = [e.info() for e in data.endpoints.all()]
    mobiles = data.mobile.list_mobile_devices()  # push-reachable even when app closed

    # UNIFY (SPEC §4.4): one roster row per phone. A mobile whose companion
    # app is online carries that endpoint's id (in-app ring, online dot);
    # the raw companion endpoint is then hidden by the card.
    svc_online = {
        e.notify_service: e.client_id
        for e in data.endpoints.online()
        if e.notify_service
    }
    for m in mobiles:
        m["online"] = m["notify_service"] in svc_online
        m["endpoint_id"] = svc_online.get(m["notify_service"])

    areas: dict[str, dict] = {}
    area_reg = ar.async_get(hass)

    def _area_entry(area_id: str, name: str | None) -> dict:
        return areas.setdefault(
            area_id,
            {"area_id": area_id,
             "name": name or getattr(area_reg.async_get_area(area_id), "name", area_id),
             "online_count": 0, "push_count": 0},
        )

    for ep in data.endpoints.online():
        if ep.area_id:
            _area_entry(ep.area_id, ep.area_name)["online_count"] += 1
    for m in mobiles:
        if m["area_id"]:
            _area_entry(m["area_id"], m["area_name"])["push_count"] += 1

    persons = []
    online_user_ids = {e.user_id for e in data.endpoints.online() if e.user_id}
    for state in hass.states.async_all("person"):
        user_id = state.attributes.get("user_id")
        if not user_id:
            continue
        persons.append(
            {
                "entity_id": state.entity_id,
                "name": state.name,
                "user_id": user_id,
                "online": user_id in online_user_ids,
            }
        )

    return {
        "endpoints": endpoints,
        "mobiles": mobiles,
        "areas": list(areas.values()),
        "persons": persons,
        # entry options piggyback on every roster (result AND push) — the
        # register result is dropped by the client's subscribeMessage, so this
        # is how ice_servers/TURN etc. actually reach clients
        "config": {
            "ice_servers": data.ice_servers,
            "ring_timeout": data.ring_timeout,
            "allow_drop_in": data.allow_drop_in,
        },
    }


@callback
def async_push_roster(hass: HomeAssistant) -> None:
    """Debounced roster broadcast to every online endpoint (SPEC §5.2)."""
    data = _data(hass)
    if data.roster_unsub is not None:
        return  # already scheduled inside the debounce window

    @callback
    def _fire(_now) -> None:
        data.roster_unsub = None
        payload = _roster_payload(hass)
        for ep in data.endpoints.online():
            _push(ep, EVT_ROSTER, payload)

    data.roster_unsub = async_call_later(hass, 1.0, _fire)


def _person_user_id(hass: HomeAssistant, person_entity_id: str) -> str | None:
    state = hass.states.get(person_entity_id)
    return state.attributes.get("user_id") if state else None


def async_end_call(hass: HomeAssistant, call: Call, reason: EndReason) -> None:
    """Single exit point: notify parties/ringers, clear mobile, log, bus event."""
    data = _data(hass)
    if call.state is CallState.ENDED:
        return

    was_ringing = call.state is CallState.RINGING
    ringers = set(call.ringing)
    data.calls.end(call, reason)

    # cancel the ring timeout
    unsub = data.ring_timeouts.pop(call.call_id, None)
    if unsub:
        unsub()

    for cid in ringers:
        ep = data.endpoints.get(cid)
        if ep:
            if ep.call_id == call.call_id:
                ep.call_id = None
            _push(ep, EVT_RING_CANCEL, {"call_id": call.call_id, "reason": reason.value})

    for cid in (call.caller_id, call.callee_id):
        if not cid:
            continue
        ep = data.endpoints.get(cid)
        if ep and ep.call_id == call.call_id:
            ep.call_id = None
            _push(ep, EVT_HANGUP, {"call_id": call.call_id, "reason": reason.value})
        if ep:
            async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, cid)

    if call.mobile_notify_services and (was_ringing or reason is EndReason.CALLER_CANCEL):
        hass.async_create_task(
            data.mobile.async_clear_ring(call.call_id, call.mobile_notify_services)
        )

    hass.bus.async_fire(
        BUS_EVT_ENDED,
        {"call_id": call.call_id, "reason": reason.value, **call.log_entry()},
    )
    async_dispatcher_send(hass, SIGNAL_CALL_LOG, call.log_entry())
    async_push_roster(hass)


def async_fail_endpoint_calls(hass: HomeAssistant, client_id: str, reason: EndReason) -> None:
    """End every call the endpoint is party to / ringing on (disconnect, supersede)."""
    data = _data(hass)
    for call in list(data.calls.active()):
        if client_id in (call.caller_id, call.callee_id):
            async_end_call(hass, call, reason)
        elif client_id in call.ringing:
            call.ringing.discard(client_id)
            if call.all_declined():
                async_end_call(hass, call, EndReason.DECLINED)


# --------------------------------------------------------------------------
# register / roster
# --------------------------------------------------------------------------

@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_REGISTER,
        vol.Required("client_id"): vol.All(str, vol.Length(min=8, max=64)),
        vol.Optional("ua_kind", default="browser"): vol.In(
            ["browser", "companion-android", "companion-ios"]
        ),
        vol.Optional("ua_hint"): vol.Any(vol.In(["iphone", "ipad"]), None),
        vol.Optional("browser_hint"): vol.All(str, vol.Length(max=48)),
        # device-owned drop-in consent: None=default, []=nobody, [users…]=only
        vol.Optional("drop_in_allow"): vol.Any(None, [vol.All(str, vol.Length(max=64))]),
        vol.Optional("name"): vol.All(str, vol.Length(max=120)),
        vol.Optional("browser_mod_id"): vol.All(str, vol.Length(max=64)),
    }
)
@websocket_api.async_response
async def ws_register(hass: HomeAssistant, connection, msg: dict) -> None:
    data = _data(hass)
    client_id = msg["client_id"]

    if data.endpoints.get(client_id) is None and len(data.endpoints) >= MAX_ENDPOINTS:
        connection.send_error(msg["id"], "endpoint_limit", "Too many endpoints")
        return

    # a reload/reconnect supersedes the previous registration (SPEC §5.3)
    prior = data.endpoints.get(client_id)
    if prior and prior.online:
        async_fail_endpoint_calls(hass, client_id, EndReason.SUPERSEDED)

    msg_id = msg["id"]
    reg_token = uuid.uuid4().hex  # identifies THIS registration (SPEC §4.5)

    def send_event(payload: dict) -> None:
        connection.send_message(websocket_api.event_message(msg_id, payload))

    endpoint = data.endpoints.upsert(
        Endpoint(
            client_id=client_id,
            ua_kind=msg["ua_kind"],
            ua_hint=msg.get("ua_hint"),
            browser_hint=msg.get("browser_hint"),
            drop_in_allow=msg.get("drop_in_allow"),
            name=msg.get("name", ""),
            browser_mod_id=msg.get("browser_mod_id"),
            user_id=connection.user.id if connection.user else None,
            user_name=connection.user.name if connection.user else None,
            send_event=send_event,
            connected_at=hass.loop.time(),
            reg_token=reg_token,
        )
    )

    # device registry entry + browser_mod area adoption (SPEC §4.2)
    await data.async_resolve_endpoint_device(endpoint)

    @callback
    def on_close() -> None:
        ep = data.endpoints.get(client_id)
        # STALE-CLOSE GUARD: if a newer registration owns this endpoint, the
        # close of an old subscription must be a no-op. Without this, a
        # re-register race marks a LIVE tablet offline and fails its calls
        # ("endpoint offline / can't place calls" bug).
        if ep is None or ep.reg_token != reg_token:
            return
        _LOGGER.info("offline: %s name=%r", client_id[:8], ep.name)
        data.endpoints.set_offline(client_id)
        async_fail_endpoint_calls(hass, client_id, EndReason.PEER_DISCONNECTED)
        async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, client_id)
        async_push_roster(hass)

    connection.subscriptions[msg_id] = on_close

    _LOGGER.info(
        "register: %s kind=%s hint=%s user=%s name=%r",
        client_id[:8], endpoint.ua_kind, endpoint.ua_hint,
        endpoint.user_name, endpoint.name,
    )

    async_dispatcher_send(hass, SIGNAL_NEW_ENDPOINT, endpoint)
    async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, client_id)
    async_push_roster(hass)

    connection.send_result(
        msg_id,
        {
            "endpoint_id": endpoint.client_id,
            "name": endpoint.name,
            "area_id": endpoint.area_id,
            "area_name": endpoint.area_name,
            "ice_servers": data.ice_servers,
            "ring_timeout": data.ring_timeout,
            "allow_drop_in": data.allow_drop_in,
        },
    )

    # LATE RING DELIVERY (SPEC §7.2): a companion app cold-started from a ring
    # push was offline at invite time and never received the ring event. If
    # this endpoint's user has a phone that was pushed for a still-ringing
    # call, ring the new endpoint NOW — the in-app full-screen ring appears no
    # matter how the app was opened, and the Answer tap supplies the user
    # gesture iOS requires for getUserMedia.
    if endpoint.user_id and not endpoint.in_call:
        for ringing_call in data.calls.active():
            if ringing_call.state is not CallState.RINGING:
                continue
            if endpoint.user_id not in ringing_call.mobile_user_ids:
                continue
            if endpoint.client_id == ringing_call.caller_id:
                continue
            ringing_call.ringing.add(endpoint.client_id)
            endpoint.call_id = ringing_call.call_id
            caller_ep = data.endpoints.get(ringing_call.caller_id)
            _push(endpoint, EVT_RING, {
                "call_id": ringing_call.call_id,
                "media": ringing_call.media,
                "caller": caller_ep.info() if caller_ep else {},
                "target_type": ringing_call.target_type,
                "drop_in": False,
            })
            async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, endpoint.client_id)
            break


@websocket_api.websocket_command({vol.Required("type"): WS_ROSTER})
@callback
def ws_roster(hass: HomeAssistant, connection, msg: dict) -> None:
    connection.send_result(msg["id"], _roster_payload(hass))


# --------------------------------------------------------------------------
# invite / cancel / accept / decline
# --------------------------------------------------------------------------

@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_INVITE,
        vol.Required("call_id"): vol.All(str, vol.Length(min=8, max=64)),
        vol.Required("caller_client_id"): str,
        vol.Required("target"): TARGET_SCHEMA,
        vol.Optional("media", default="video"): vol.In(["video", "audio"]),
        vol.Optional("drop_in", default=False): bool,
    }
)
@websocket_api.async_response
async def ws_invite(hass: HomeAssistant, connection, msg: dict) -> None:
    data = _data(hass)
    caller = data.endpoints.get(msg["caller_client_id"])
    if caller is None or not caller.online:
        connection.send_error(msg["id"], "not_registered", "Register first")
        return
    if caller.in_call:
        connection.send_error(msg["id"], "caller_busy", "Caller already in a call")
        return

    # drop-in consent is per-TARGET (SPEC §5.4a): blocked targets ring
    # normally instead of auto-answering — the call always goes through.
    drop_in = msg["drop_in"]

    target = msg["target"]
    target_type = target["type"]
    target_id = target.get("id")
    person_user_id = None
    if target_type == "person":
        person_user_id = _person_user_id(hass, target_id or "")

    targets = data.endpoints.resolve_targets(
        target_type, target_id, exclude=caller.client_id,
        person_user_id=person_user_id,
    )

    # mobile push per target type (SPEC §7.1). Phones are reachable with the
    # app CLOSED — push is never gated on a registered endpoint.
    notify_services: list[str] = []
    if target_type == "person" and target_id:
        notify_services = data.mobile.resolve_notify_services(target_id)
    elif target_type == "mobile" and target_id:
        notify_services = data.mobile.validate_services([target_id])
    elif target_type == "area" and target_id:
        notify_services = data.mobile.services_for_area(target_id)
    elif target_type == "all":
        notify_services = [m["notify_service"] for m in data.mobile.list_mobile_devices()]

    # If a user's companion app is OPEN (registered as an online endpoint that
    # this invite already rings in-app), skip the push to that user's phones —
    # in-app ring is the notification (SPEC §7.1). Push remains the path for
    # closed apps.
    mobile_user_ids: set[str] = set()
    if notify_services:
        svc_user = {
            m["notify_service"]: m["user_id"]
            for m in data.mobile.list_mobile_devices()
        }
        companion_user_ids = {
            t.user_id for t in targets
            if t.user_id and t.ua_kind.startswith("companion")
        }
        if companion_user_ids:
            notify_services = [
                s for s in notify_services
                if svc_user.get(s) not in companion_user_ids
            ]
        # users whose phones we push — used for late ring delivery when the
        # cold-started app registers mid-ring (SPEC §7.2)
        mobile_user_ids = {
            svc_user[s] for s in notify_services if svc_user.get(s)
        }

    if not targets and not notify_services:
        if target_type == "person":
            # Most common cause: the person entity is linked to a stale/deleted
            # user_id, so neither browser sessions nor mobile_app registrations
            # (which carry the CURRENT user's id) can ever match.
            _LOGGER.warning(
                "videocall: person %s resolves to no endpoints and no phones "
                "(person user_id=%s). Check Settings→People→%s: the linked "
                "user account must be the one this person logs in with / "
                "registered their companion apps under.",
                target_id, person_user_id, target_id,
            )
        connection.send_error(msg["id"], "no_targets", "No reachable targets")
        return

    call = data.calls.create(
        Call(
            call_id=msg["call_id"],
            caller_id=caller.client_id,
            media=msg["media"],
            drop_in=drop_in,
            target_type=target_type,
            target_id=target_id,
            ringing={t.client_id for t in targets},
            mobile_pending=len(notify_services),
            mobile_notify_services=notify_services,
            mobile_user_ids=mobile_user_ids,
        )
    )
    caller.call_id = call.call_id

    for t in targets:
        t.call_id = call.call_id  # rung endpoints are busy-guarded while ringing
        _push(t, EVT_RING, {
            "call_id": call.call_id,
            "media": call.media,
            "caller": caller.info(),
            "target_type": target_type,
            # per-endpoint consent: unlisted devices follow the global default
            "drop_in": drop_in and data.drop_in_allowed(t, caller),
        })
        async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, t.client_id)

    if notify_services:
        await data.mobile.async_send_ring(call, caller.info(), notify_services)

    # server-side ring timeout (SPEC §5.3). MUST be @callback: async_call_later
    # runs a bare function in the executor thread, and async_end_call touches
    # loop-only APIs (async_dispatcher_send / async_create_task) — that mismatch
    # was the "async_dispatcher_send from a thread other than the event loop"
    # crash on every unanswered ring.
    @callback
    def _timeout(_now) -> None:
        data.ring_timeouts.pop(call.call_id, None)
        if call.state is CallState.RINGING:
            async_end_call(hass, call, EndReason.TIMEOUT)

    data.ring_timeouts[call.call_id] = async_call_later(hass, data.ring_timeout, _timeout)

    hass.bus.async_fire(
        BUS_EVT_INCOMING,
        {
            "call_id": call.call_id,
            "media": call.media,
            "drop_in": drop_in,
            "caller": caller.info(),
            "target_type": target_type,
            "target_id": target_id,
            "ringing": sorted(call.ringing),
            "mobile_notified": notify_services,
        },
    )
    async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, caller.client_id)
    connection.send_result(
        msg["id"], {"ringing": sorted(call.ringing), "mobile_notified": notify_services}
    )


def _get_call_or_error(hass, connection, msg) -> Call | None:
    call = _data(hass).calls.get(msg["call_id"])
    if call is None:
        connection.send_error(msg["id"], "unknown_call", "No such call")
        return None
    return call


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_CANCEL,
        vol.Required("call_id"): str,
    }
)
@callback
def ws_cancel(hass: HomeAssistant, connection, msg: dict) -> None:
    call = _get_call_or_error(hass, connection, msg)
    if call is None:
        return
    async_end_call(hass, call, EndReason.CALLER_CANCEL)
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_ACCEPT,
        vol.Required("call_id"): str,
        vol.Required("client_id"): str,
    }
)
@callback
def ws_accept(hass: HomeAssistant, connection, msg: dict) -> None:
    data = _data(hass)
    call = _get_call_or_error(hass, connection, msg)
    if call is None:
        return
    callee = data.endpoints.get(msg["client_id"])
    if callee is None or not callee.online:
        connection.send_error(msg["id"], "not_registered", "Register first")
        return
    if callee.in_call and callee.call_id != call.call_id:
        connection.send_error(msg["id"], "busy", "Endpoint busy in another call")
        return
    try:
        others = data.calls.accept(call, callee.client_id)
    except InvalidTransition as err:
        connection.send_error(msg["id"], str(err), "Call already answered or ended")
        return

    callee.call_id = call.call_id
    # accepting kills any OTHER ring the callee had pending (glare, SPEC §5.3)
    for other_call in list(data.calls.active()):
        if other_call is not call and callee.client_id in other_call.ringing:
            other_call.ringing.discard(callee.client_id)
            _push(callee, EVT_RING_CANCEL,
                  {"call_id": other_call.call_id, "reason": EndReason.SUPERSEDED.value})
            if other_call.all_declined():
                async_end_call(hass, other_call, EndReason.DECLINED)

    unsub = data.ring_timeouts.pop(call.call_id, None)
    if unsub:
        unsub()

    for cid in others:
        ep = data.endpoints.get(cid)
        if ep:
            if ep.call_id == call.call_id:
                ep.call_id = None
            _push(ep, EVT_RING_CANCEL,
                  {"call_id": call.call_id, "reason": "answered_elsewhere"})
            async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, cid)

    if call.mobile_notify_services:
        hass.async_create_task(
            data.mobile.async_clear_ring(call.call_id, call.mobile_notify_services)
        )

    caller = data.endpoints.get(call.caller_id)
    if caller:
        _push(caller, EVT_ACCEPTED, {"call_id": call.call_id, "peer": callee.info()})

    async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, callee.client_id)
    # media/caller in the result let a late-joining endpoint (deep link, no
    # ring event ever received) build its session from the accept alone.
    connection.send_result(
        msg["id"],
        {"caller": caller.info() if caller else None, "media": call.media},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_DECLINE,
        vol.Required("call_id"): str,
        vol.Required("client_id"): str,
        vol.Optional("reason"): str,
    }
)
@callback
def ws_decline(hass: HomeAssistant, connection, msg: dict) -> None:
    data = _data(hass)
    call = _get_call_or_error(hass, connection, msg)
    if call is None:
        return
    ep = data.endpoints.get(msg["client_id"])
    if ep and ep.call_id == call.call_id:
        ep.call_id = None
        async_dispatcher_send(hass, SIGNAL_ENDPOINT_UPDATE, ep.client_id)
    if data.calls.decline(call, msg["client_id"]):
        async_end_call(hass, call, EndReason.DECLINED)
    connection.send_result(msg["id"])


# --------------------------------------------------------------------------
# SDP / ICE relay
# --------------------------------------------------------------------------

def _relay(hass, connection, msg, event_type: str, key: str) -> None:
    """Shared relay for offer/answer/candidate: sender must be a party."""
    data = _data(hass)
    call = _get_call_or_error(hass, connection, msg)
    if call is None:
        return
    if call.state not in (CallState.CONNECTING, CallState.ACTIVE):
        connection.send_error(msg["id"], "bad_state", f"Call is {call.state.value}")
        return
    sender = msg["client_id"]
    peer_id = call.peer_of(sender)
    if peer_id is None:
        connection.send_error(msg["id"], "not_party", "Not a party to this call")
        return
    peer = data.endpoints.get(peer_id)
    if peer is None or not peer.online:
        async_end_call(hass, call, EndReason.PEER_DISCONNECTED)
        connection.send_error(msg["id"], "peer_gone", "Peer disconnected")
        return
    _push(peer, event_type, {"call_id": call.call_id, key: msg[key]})

    if event_type == EVT_ANSWER:
        data.calls.mark_active(call)
        hass.bus.async_fire(
            BUS_EVT_ANSWERED,
            {"call_id": call.call_id, "caller": call.caller_id, "callee": call.callee_id},
        )
    connection.send_result(msg["id"])


_SDP = vol.All(str, vol.Length(max=MAX_SDP_BYTES))

@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_OFFER,
        vol.Required("call_id"): str,
        vol.Required("client_id"): str,
        vol.Required("sdp"): _SDP,
    }
)
@callback
def ws_offer(hass: HomeAssistant, connection, msg: dict) -> None:
    _relay(hass, connection, msg, EVT_OFFER, "sdp")


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_ANSWER,
        vol.Required("call_id"): str,
        vol.Required("client_id"): str,
        vol.Required("sdp"): _SDP,
    }
)
@callback
def ws_answer(hass: HomeAssistant, connection, msg: dict) -> None:
    _relay(hass, connection, msg, EVT_ANSWER, "sdp")


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_CANDIDATE,
        vol.Required("call_id"): str,
        vol.Required("client_id"): str,
        # RTCIceCandidateInit dict or null (end-of-candidates)
        vol.Required("candidate"): vol.Any(dict, None),
    }
)
@callback
def ws_candidate(hass: HomeAssistant, connection, msg: dict) -> None:
    _relay(hass, connection, msg, EVT_CANDIDATE, "candidate")


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_HANGUP,
        vol.Required("call_id"): str,
        vol.Optional("reason", default="hangup"): str,
    }
)
@callback
def ws_hangup(hass: HomeAssistant, connection, msg: dict) -> None:
    call = _get_call_or_error(hass, connection, msg)
    if call is None:
        return
    async_end_call(hass, call, EndReason.HANGUP)
    connection.send_result(msg["id"])
