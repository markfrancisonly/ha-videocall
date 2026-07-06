# videocall — HA-native WebRTC video calling

**Spec v1.0 — 2026-07-04.** Design + implementation contract for a Home Assistant
custom integration (`videocall`) and Lovelace card (`videocall-card`) that provide
1:1 video/audio calling between HA clients, using Home Assistant itself as the
signaling server. This document plus the skeleton in `custom_components/videocall/`
is intended to be sufficient to implement the solution completely, without
re-deciding anything.

---

## 1. Goals

1. **Call a room (area):** ring every open browser session resolved to an HA area
   (wall panels, kiosk tablets, desk browsers) **and** every companion-app phone
   whose HA device is assigned to that area. First accept wins.
2. **Call a person:** ring every browser where that HA user is logged in **and**
   push an actionable ring notification to their iOS/Android companion app(s);
   tapping *Answer* deep-links into a dashboard and joins the call. Push works
   with the app **closed** — FCM/APNs deliver independently of app state, so a
   person (or phone) is *always* callable, never gated on an open session.
3. **Drop in:** auto-connect to a target without it having to answer (Alexa
   Drop In style) — for kiosks/wall panels with persistent cam/mic permission.
   Globally switchable off (`allow_drop_in` option). Phones can't auto-answer a
   push, so a drop-in that reaches a phone degrades to a normal ring there.
4. **Zero-config:** config flow is a single confirm (no fields). Persons, mobile
   devices, and browser endpoints (with their rooms) are auto-discovered.
5. **Coexist** with the browser code already deployed on this HA instance
   (§10) — never fight it for names, storage, or the camera.

Non-goals for v1 (§13): group calls (>2 parties), screen share, TURN relay
deployment, SIP/PSTN, calls originating from automations with synthetic media.

## 2. Existing code inventory (conflict surface)

| Deployed code | Reserved names — do NOT reuse |
|---|---|
| `custom_components/webrtc` (AlexxIT fork, live — source of `webrtc.zip`) | domain `webrtc`; views `/api/webrtc/ws`, `/api/webrtc/stream`; static `/webrtc/webrtc-camera.js`, `/webrtc/embed`; services `webrtc.create_link`, `webrtc.dash_cast` |
| `www/webrtc-babycam.js` | elements `webrtc-babycam`, `webrtc-babycam-dock`; LS key `webrtc.background.v2`; class `WebRTCsession` (module-scoped) |
| `www/browser-whip-card.js` | element `browser-whip-card`(`-editor`); globals `window.BrowserWhipCore`, `window.__BWC_VENDOR__`; LS `bwc:settings`; **may hold the camera/mic at any time** (WHIP publish to go2rtc); yields it on `camera:claim`/`camera:release` (§9.4) |
| `custom_components/browser_mod` | WS commands `browser_mod/*`; LS `browser_mod-browser-id`; devices w/ areas per browser |

**Namespace for this project (everything prefixed, no exceptions):**

| Kind | Name |
|---|---|
| Integration domain / WS command prefix | `videocall`, `videocall/*` |
| Custom elements | `videocall-card`(`-editor`), `videocall-button`(`-editor`), `videocall-overlay` |
| Window globals | `window.VideoCallCore`, `window.__VCALL_VENDOR__` |
| localStorage | `vcall:client_id`, `vcall:disabled` (kill switch; all other state in-memory) |
| Static path | `/videocall/videocall-card.js` |
| HA bus events | `videocall_incoming`, `videocall_answered`, `videocall_ended` |
| Notification tag / action ids | `vcall-<call_id>`, `VCALL_DECLINE_<call_id>` |
| URL params (deep link) | `vcall_answer=<call_id>` |

## 3. Architecture

```
┌────────────┐  HA websocket (auth’d)  ┌──────────────────────────┐
│ browser A  │◄───────────────────────►│ HA: videocall integration │
│ (caller)   │   videocall/* cmds      │  - endpoint registry      │
└─────┬──────┘   + pushed events       │  - call registry (1:1 FSM)│
      │                                │  - SDP/ICE relay          │
      │      P2P WebRTC media          │  - mobile push ring       │
      │  (STUN; host cands on LAN)     └──────┬───────────┬───────┘
┌─────▼──────┐                                │           │
│ browser B  │◄───────────────────────────────┘     notify.mobile_app_*
│ (callee)   │        signaling relay                     │
└────────────┘                              ┌─────────────▼──────────┐
                                            │ companion app (push)    │
                                            │ Answer → deep link →    │
                                            │ webview loads dashboard │
                                            │ → becomes a browser     │
                                            │   endpoint → accept     │
                                            └─────────────────────────┘
```

- **Signaling = HA websocket API.** The integration registers `videocall/*`
  commands (`websocket_api.async_register_command`). Clients receive events as
  subscription pushes on their `videocall/register` message id. No extra
  server, no extra ports, HA auth for free, works through the same reverse
  proxy (traefik) the frontend already uses.
- **Media = direct P2P** `RTCPeerConnection` between the two endpoints. Default
  ICE: default `[{"urls":"stun:stun.l.google.com:19302"}]` (LAN calls typically
  connect on host candidates alone). Configure TURN via the simple TURN fields
  (composed server-side); "Use my TURN server for STUN too" derives `stun:` from
  the same host. The Advanced `ice_servers` JSON overrides the base list
  (blank = default STUN; `[]` = none) and merges with the TURN fields. TURN is a
  config option, not a deployment this project provides.

  **When P2P cannot connect** (symptom: call establishes, no media either way,
  drop at the 10 s ICE guard): phone↔phone with either side on cellular
  (carrier-grade NAT), or Wi-Fi with AP/client isolation, cannot punch through
  with STUN alone — a **TURN server is required** (options → ICE servers, e.g.
  `[{"urls":"stun:…"},{"urls":"turn:turn.example:3478","username":"u","credential":"p"}]`,
  self-hosted coturn or a hosted TURN). On failure the client logs a
  candidate-type census (`[videocall] media path failed … local=… remote=…`)
  to the browser console for triage: host-only candidates on both sides → LAN
  isolation; srflx-but-no-pair → NAT; no relay candidates → no TURN configured.
- **Mobile is push-then-join:** the phone is *not* a persistent endpoint. Ring
  = actionable push notification; answering opens the app on a dashboard whose
  loaded card resource turns the webview into a normal browser endpoint that
  then sends `videocall/accept`.

## 4. Identity, discovery, presence

### 4.1 Endpoint identity
- `client_id`: UUIDv4 minted by the frontend core on first boot, persisted at
  LS `vcall:client_id`. Stable per browser profile ⇒ stable HA device.
- On register the client also sends `browser_mod_id` (LS
  `browser_mod-browser-id`, if present) and `ua_kind` (`browser` |
  `companion-android` | `companion-ios`, sniffed from UA `Home Assistant/…`).

### 4.2 Device & area resolution (rooms auto-discovery)
Each registered `client_id` gets a **device registry entry**
(`identifiers={(DOMAIN, client_id)}`). Area resolution order:
1. Area manually assigned to *our* videocall device in the HA UI (always wins).
2. Area of the matching **browser_mod device** (identifier
   `(browser_mod, <browser_mod_id>)`) — copied as `suggested_area` at first
   registration, so existing browser_mod room assignments are inherited with
   zero user work.
3. None (endpoint listed under "No area" in rosters; still directly callable).

Device name: browser_mod device name if matched, else `"Videocall <ua summary> <client_id[:6]>"`.

### 4.3 Person auto-discovery
Roster persons = all `person.*` entities that have a `user_id` attribute.
Targeting person P resolves to:
- every **online** endpoint whose websocket `connection.user.id == P.user_id`, plus
- every **mobile push target** for P (§7.1): `mobile_app` config entries whose
  `data["user_id"] == P.user_id` → `notify.mobile_app_<slugified device name>`.
Manual override (options flow, JSON): `{"person.mark": ["notify.mobile_app_x"]}`.

### 4.4 Mobile (companion) auto-discovery — always reachable
Every `mobile_app` config entry whose `notify.mobile_app_*` service exists is a
**push-reachable roster device**, independent of whether the app is open —
FCM/APNs deliver to a closed app, and Answer cold-starts it into the deep link
(§7.2). Per phone: notify service, device-registry name, `user_id`, and the HA
device's **area** (so phones participate in area targeting). Wire shape:
`MobileInfo = {notify_service, name, user_id, area_id, area_name, device_id}`.
Phones therefore appear in the roster's Devices list (marked push-reachable)
and are individually callable via target type `mobile`.

**Companion↔endpoint unification (one row per phone).** A registering
companion endpoint is correlated to its `mobile_app` entry by `user_id` +
platform (`os_name`) + UA hint (`iphone`/`ipad` vs the registration `model`);
only a UNIQUE match links (`endpoint.notify_service` set). A same-platform tie
the coarse hint can't split (e.g. two iPads on one user) is broken toward the
device that's currently alive (its entities aren't `unavailable`); otherwise it
falls back to an unlinked endpoint, never a guess. A linked endpoint adopts the
mobile_app device's name and area, and the roster marks the mobile row
`online` + `endpoint_id` while hiding the raw endpoint row: calling the phone
rings in-app when the app is open (endpoint target) and pushes when closed
(mobile target). The online indicator thus lands on "Mark's iPhone", not on
an anonymous "Videocall browser".

**Device naming rules.** Opaque ids NEVER go in display names: `client_id`
lives in the device's `serial_number` field, `ua_kind` in `model`.
browser_mod names matching its auto-generated `browser_mod_<hex>_<hex>`
pattern are ignored (they are ids, not names — adopt the AREA only).
Name resolution order: unified mobile_app device name → browser_mod
user-assigned name → `"<User>'s browser|iOS app|Android app"` → generic.
Pre-existing auto-generated names are migrated on re-registration unless the
user renamed the device (`name_by_user` always wins).

### 4.5 Presence
An endpoint is **online** iff its `videocall/register` subscription is alive;
the close callback marks it offline, fails any call it is party to (reason
`peer_disconnected`), and pushes a `roster` update. The frontend core
re-registers on every HA connection `ready` event (reconnect-safe). Entities
(§8) mirror presence but the registry, not entity state, is authoritative.

**Registration tokens (normative — the kiosk-offline bug).** Every
registration mints a unique `reg_token` stored on the endpoint; a
subscription's close callback is a NO-OP unless its token still owns the
endpoint. Without this, a re-register race (websocket blip, HA reconnect)
lets the OLD subscription's close fire after the new registration is live —
marking a healthy tablet offline and failing its calls. Client side, the same
rule holds: exactly ONE live subscription (unsubscribe before re-register,
`resubscribe: false` — the core's `ready` listener is the only re-register
path), and `invite` self-heals on a `not_registered` error by re-registering
and retrying once (covers HA restarts that empty the registry while clients
still believe they are online).

## 5. Signaling protocol

All commands require an authenticated HA websocket connection (any user; no
admin). Schemas below are exact (voluptuous in `ws_api.py`). `call_id` is a
caller-minted UUIDv4.

### 5.1 Client → server commands

| Command | Payload | Result / effect |
|---|---|---|
| `videocall/register` | `client_id`, `ua_kind`, `name?`, `browser_mod_id?` | Registers endpoint + **subscribes** it to events (the long-lived message id). Result: `{endpoint_id, name, area_id, area_name, ice_servers, ring_timeout, allow_drop_in}`. Re-register with same `client_id` on a new connection supersedes the old one. |
| `videocall/roster` | — | Result: `{endpoints: [EndpointInfo], mobiles: [MobileInfo], areas: [{area_id, name, online_count, push_count}], persons: [{entity_id, name, user_id, online}], config: {ice_servers, ring_timeout, allow_drop_in}}`. `persons[].online` reflects browser presence only — persons and mobiles are ALWAYS callable via push (§4.4). `config` rides on every roster result AND push — it is how entry options (esp. a TURN server) reach clients, since the register result is consumed by the subscription helper. |
| `videocall/invite` | `call_id`, `target: {type: endpoint\|area\|person\|mobile\|all, id?}`, `media: video\|audio`, `drop_in?: bool` | Creates call in state `ringing`; pushes `ring` to resolved endpoints; pushes mobile notifications (person → their phones; mobile → that phone; area → phones in the area; all → every phone); arms ring timeout. `drop_in: true` → `ring` carries `drop_in` and receiving browser endpoints auto-accept (§5.5); rejected with `drop_in_disabled` if the option is off. Errors: `busy_here` (a target endpoint is in a call — still rings idle ones), `no_targets`, `caller_busy`. |
| `videocall/cancel` | `call_id` | Caller aborts ringing → `ring_cancel` to all ringing endpoints + mobile clear. |
| `videocall/accept` | `call_id`, `client_id` | First accept wins (`call.state=connecting`); others get `ring_cancel`; mobile notifications cleared; caller gets `accepted {peer: EndpointInfo}`. Result: `{caller: EndpointInfo, media}` — enough for a **late joiner** to build its session without ever having received `ring`. An endpoint NOT in the ring set may accept iff the call pushed to mobile (cold-start deep-link join, §7.2). Accept on an answered/ended call → `too_late`/`unknown_call`; endpoint busy in another call → `busy`. |
| `videocall/decline` | `call_id`, `reason?` | Marks that endpoint declined. When **all** rung targets have declined and no mobile push is pending → call ends, caller gets `hangup {reason: declined}`. |
| `videocall/offer` | `call_id`, `sdp` | Caller→callee relay (only in `connecting`). |
| `videocall/answer` | `call_id`, `sdp` | Callee→caller relay; server sets `call.state=active`, stamps `answered_at`, fires `videocall_answered` bus event. |
| `videocall/candidate` | `call_id`, `candidate` (JSON of RTCIceCandidateInit, or `null` = end-of-candidates) | Relayed to the other party. Valid in `connecting`/`active`. |
| `videocall/hangup` | `call_id`, `reason?` | Either party (or admin service). Ends call; other party gets `hangup`. |

### 5.2 Server → client events (pushed on the register subscription)

`{event_type, ...}` where `event_type` ∈:

- `ring {call_id, media, caller: EndpointInfo, target_type, drop_in}`
- `ring_cancel {call_id, reason: answered_elsewhere|caller_cancel|timeout}`
- `accepted {call_id, peer: EndpointInfo}` (to caller — begin gUM + offer)
- `offer {call_id, sdp}` / `answer {call_id, sdp}` / `candidate {call_id, candidate}`
- `hangup {call_id, reason: hangup|declined|timeout|peer_disconnected|superseded|error}`
- `roster {…same shape as videocall/roster result}` (debounced 1 s)

`EndpointInfo = {endpoint_id, client_id, name, area_id, area_name, ua_kind, user_id, user_name, online, in_call}`

### 5.3 Call state machine (server-authoritative)

```
            invite                    accept                answer relayed
   (none) ─────────► ringing ────────────────► connecting ────────────► active
                        │ cancel/timeout/all-declined │ hangup/disconnect  │ hangup/disconnect
                        ▼                             ▼                    ▼
                      ended(missed|declined|cancel) ended(reason)      ended(hangup)
```

Rules:
- **One active/pending call per endpoint** (caller or callee). `invite` while
  busy → `caller_busy`; a rung endpoint that is busy is skipped.
- **Ring timeout** (default 30 s, options): server-side `async_call_later` →
  `ring_cancel(timeout)` to ringers, `hangup(timeout)` to caller, mobile clear,
  bus event `videocall_ended {reason: missed}`.
- **Glare:** roles are fixed (inviter = offerer) so classic WebRTC glare cannot
  occur. Two endpoints inviting each other simultaneously simply produce two
  ringing calls; accepting one makes the endpoint busy, and the server then
  auto-cancels the other with `superseded`.
- **Supersede:** re-`register` of the same `client_id` (page reload) fails any
  call the old registration was party to (`peer_disconnected`).
- All transitions logged at DEBUG; ended calls kept in a bounded deque (50) for
  the `sensor.videocall_last_call` attributes.

### 5.4a Drop-in (auto-answer) — SPEC §1 goal 3

Server-side, drop-in is just an invite whose `ring` event carries
`drop_in: true` — the FSM is unchanged (the auto-accept arrives as a normal
`videocall/accept`, first one wins, ring timeout still covers the
nobody-auto-accepted case, e.g. panel powered off). Client-side contract:

- A browser endpoint receiving `ring {drop_in: true}` **skips the ring UI and
  ringtone** and immediately calls `accept()`: brief chime + on-screen banner
  ("<caller> dropped in"), then straight to the in-call UI. gUM without a user
  gesture requires persistent cam/mic permission (kiosk browsers / Fully
  Kiosk have this); where permission prompts anyway, the prompt effectively
  becomes the answer gesture — acceptable degradation.
- Phones reached by the same invite get the normal §7.1 ring push (a push
  cannot auto-answer); if the browser auto-accept wins first, the push is
  cleared via `answered_elsewhere` as usual.
- **Open companion apps DO auto-answer** (wall-mounted Android tablets /
  kiosks are the primary drop-in use case) — `dropInOk` for a unified phone
  row is simply "app open". Exception: iOS companions receiving a `drop_in`
  ring show the normal ring UI instead (WKWebView requires a user gesture
  for getUserMedia; gestureless auto-accept would fail).
- **Consent is per-TARGET, DEVICE-OWNED, enforced server-side.** Each device
  declares its own allowed drop-in callers via the card's "Drop-in on this
  device" control (Default / No one / Only…people), persisted in that
  browser's localStorage (`vcall:dropin_allow`) and sent with every
  `videocall/register` (`drop_in_allow`: `null` = follow the global
  `allow_drop_in` DEFAULT; `[]` = nobody; `[user_id…]` = exclusively those
  users, global ignored). This is deliberately card-side rather than
  integration config — household trust model, not high-security; the device
  being configured is the device you're standing at. NOTE: translation
  strings must never contain literal `{}` (HA parses them as placeholders →
  MALFORMED_ARGUMENT). A blocked drop-in **degrades to a normal ring** on
  that device (the call always goes through; that target just has to
  answer) — the `ring` event's `drop_in` flag is computed per target. There
  is no `drop_in_disabled` error.
- **Caller auto-redial (once).** Android endpoints waking from doze/Wi-Fi
  power-save routinely fail the FIRST media path and succeed on the next
  attempt. When a caller-side session ends with an `error:` reason, the core
  silently re-invites the same target once (~800 ms later); declined /
  timeout / hangup endings never redial.

### 5.4 Media negotiation sequence (frontend contract)

1. Caller UI → `invite` (no gUM yet — privacy: never touch camera while ringing).
2. Callee(s) get `ring` → overlay UI (§9.3) with Accept / Decline.
3. Callee taps Accept → `accept` → **callee** runs `getUserMedia` *now* (so
   permission prompt happens on the user gesture) and waits for the offer.
4. Caller gets `accepted` → gUM → `createOffer` (transceivers `sendrecv` for
   video+audio; audio-only calls add video transceiver `recvonly` disabled) →
   `setLocalDescription` → send `offer` immediately (trickle ICE; do NOT wait
   for gathering — unlike WHIP, we have a candidate channel).
5. Callee: `setRemoteDescription` → add tracks → `createAnswer` →
   `setLocalDescription` → send `answer`. **Offer/media race (normative):**
   the callee MUST buffer an offer that arrives before its local media is
   acquired and process it when media lands. On WHIP-publishing tablets the
   camera-release settle + retry ladder makes acquisition take seconds while
   a fast caller offers immediately after auto-accept — handling the offer
   against a null localStream crashed the peer setup and broke every
   Android call.
6. Both sides trickle `candidate` msgs as `onicecandidate` fires (null at end).
7. Connected when `connectionState=connected`. Failure timeouts, both sides:
   SIGNALING_TIMEOUT 10 s (accept→offer / offer→answer), ICE_TIMEOUT 10 s
   (answer→connected) → `hangup(error)` + user-visible toast. (Constants
   borrowed from webrtc-babycam’s field-proven values.)
8. In-call renegotiation (mute/unmute is `track.enabled`, no renegotiation;
   camera switch = `replaceTrack`, no renegotiation) — v1 never renegotiates.

## 6. Backend design (`custom_components/videocall/`)

```
manifest.json      domain videocall, deps [http, websocket_api, person, lovelace],
                   after_deps [browser_mod, mobile_app], iot_class local_push,
                   config_flow true, single instance
const.py           names, defaults, event names, schemas shared bits
models.py          Endpoint / Call dataclasses; EndpointRegistry; CallRegistry
                   (pure-python, no HA imports → unit-testable)
__init__.py        async_setup_entry: build registries into hass.data[DOMAIN],
                   register ws commands, frontend resource, platforms
                   [binary_sensor, sensor], services, mobile action listener
ws_api.py          the §5 commands + event push helpers + ring fan-out
mobile.py          person→notify.mobile_app_* resolution, ring/clear payloads,
                   mobile_app_notification_action listener (decline)
frontend.py        async_register_static_paths(/videocall/videocall-card.js)
                   + idempotent lovelace resource add (same trick as the
                   deployed webrtc integration’s utils.init_resource)
config_flow.py     user step = instant create (no fields); options flow is a
                   menu → Settings / Advanced / Prune. Settings: turn_host,
                   turn_username, turn_credential, turn_lan_host,
                   turn_stun(bool — also derive stun: from the TURN host),
                   ring_timeout(int s), allow_drop_in(bool),
                   answer_dashboard(str, default /lovelace). Advanced (raw JSON):
                   ice_servers, person_notify_map. Each step MERGEs into options.
binary_sensor.py   per-endpoint connectivity entity (online)
sensor.py          per-endpoint state (idle|ringing|in_call) +
                   one global sensor.videocall_last_call
services.yaml      videocall.hangup {call_id?} (blank = hang up all),
                   videocall.prune_endpoints (drop devices offline > N days)
strings.json / translations/en.json
www/videocall-card.js   the frontend (served by the integration itself —
                   survives HA www/ cleanups, versioned resource URL)
```

Key implementation notes:
- Event push: store `(connection, msg_id)` per endpoint at register;
  `connection.send_message(websocket_api.event_message(msg_id, payload))`.
  Guard every push with try/except (connection may be mid-close).
- `connection.subscriptions[msg["id"]] = close_cb` inside the register handler
  is what gives us the disconnect hook.
- Ring fan-out and person/mobile resolution live server-side so every client
  UI stays dumb.
- Bus events carry `{call_id, caller, callee/targets, media, reason?}` with
  EndpointInfo dicts — automation-friendly (flash lights on ring, etc).
- `webrtc`, `browser_mod` are *not* imports — browser_mod integration is via
  device-registry lookup only; missing browser_mod degrades gracefully.

## 7. Mobile companion flow

### 7.1 Ring push
Phones are resolved per target type (§5.1): person → that person's phones,
mobile → the one phone, area → phones whose device is in the area, all →
every phone. Delivery does **not** require the app to be open or the phone to
be a registered endpoint — FCM/APNs wake a closed app's notification channel,
and Answer cold-starts the app into the deep link. For each resolved
`notify.mobile_app_*` service:

```yaml
title: "📹 Incoming video call"                 # or 📞 audio
message: "{caller_user} ({caller_endpoint}) is calling"   # "Mark (browser fc9b61)"
data:
  tag: "vcall-{call_id}"
  channel: "Video Call"        # Android: user can pick ringtone for channel
  importance: high
  ttl: 0
  priority: high
  timeout: {ring_timeout}      # Android auto-dismiss
  persistent: true
  sticky: true
  actions:
    - action: "URI"
      title: "Answer"
      uri: "{answer_dashboard}?vcall_answer={call_id}"
      activationMode: foreground   # iOS: REQUIRED — default is background and
                                   # the app never opens (Android ignores it)
    - action: "VCALL_DECLINE_{call_id}"
      title: "Decline"
  # iOS specifics (harmless on Android):
  url: "{answer_dashboard}?vcall_answer={call_id}"
  push:
    sound:
      name: default
      critical: 0
      volume: 1.0
    interruption-level: time-sensitive
```

Clear (answered elsewhere / cancel / timeout): `message: clear_notification`,
`data: {tag: "vcall-{call_id}"}` to the same services.

**Open-app suppression:** if a user's companion app is OPEN — i.e. an online
endpoint with `ua_kind: companion-*` and that `user_id` is in the invite's
ring set — the push to that user's phones is skipped: the in-app ring (overlay
+ ringtone) IS the notification. Push remains the closed-app path. Correlation
is by user, not by physical phone (one-phone-per-user assumption; documented
limitation for multi-phone users, whose other phones simply don't ring while
one app is open).

### 7.2 Answer path
App opens `{answer_dashboard}?vcall_answer=<call_id>` in its webview → core
sees the param → `register` (if needed), then `accept(call_id)`; if the call
is gone, show "Call ended" toast. Webview gUM works on both platforms
(Android WebView; iOS WKWebView ≥14.3) — degrade to audio-only if
`getUserMedia` throws for video.

**Deep-link detection is NOT boot-only.** The HA frontend is an SPA and the
companion app *resumes* it — an Answer tap on a warm app changes the URL
without re-executing the card resource. The core therefore re-checks
`?vcall_answer` on `location-changed`, `popstate`, and
`visibilitychange→visible`, deduplicating handled call_ids in-memory.

**Cold-start join (the critical mobile path).** A closed app was NOT an online
endpoint at invite time, so the `ring` event was never delivered to it. Two
mechanisms cooperate, in order of authority:

1. **Server-side late ring delivery** — the reliable path, independent of URL
   handling. On `videocall/register`, if the endpoint's `user_id` is in a
   still-ringing call's `mobile_user_ids` (i.e. that user's phone was pushed),
   the server adds the endpoint to the ring set and pushes it a `ring` event
   immediately. Opening the app ANY way — notification body, Answer action, or
   plain launch — lands on the full-screen in-app ring with caller identity.
   On iOS this is also the gUM story: **WKWebView requires a user gesture for
   getUserMedia**, so auto-accept would fail — the Answer tap on the late ring
   IS the gesture.
2. **Deep-link auto-accept** (`?vcall_answer` — Android companion only, where
   gestureless gUM works): accept the (late-)rung session directly; if no ring
   arrived within ~2.5 s (e.g. browsers-only ring set), build a callee session
   from `videocall/accept` alone — the server permits the un-rung accept for
   mobile-pushed calls and returns `{caller, media}`. A dead call comes back
   `unknown_call`/`too_late` → quiet "call ended"/"answered elsewhere"
   teardown, not an error.

### 7.3 Decline path
Companion fires HA event `mobile_app_notification_action` with
`action == "VCALL_DECLINE_<call_id>"`; `mobile.py` listener maps it to a
decline (counts toward the all-declined check with one virtual "mobile" slot
per person).

## 8. Entities & services

- Per endpoint device: `binary_sensor.<name>_online` (device_class
  connectivity, entity_category diagnostic) and `sensor.<name>_call_state`
  (`idle|ringing|in_call`). Dynamic add via `async_dispatcher_send` on first
  registration; entities go unavailable when offline > 0 s (presence is live).
- `sensor.videocall_last_call`: state = last call result
  (`answered|missed|declined|cancelled|error`), attributes = last-50 call log.
- Services: `videocall.hangup` (optional `call_id`), `videocall.prune_endpoints`
  (`days: 30`). Calls *originate* only from endpoints in v1 (no ring service —
  see §13 futures).

## 9. Frontend design (`www/videocall-card.js`)

Single file, no build step, idempotent vendor guard (`window.__VCALL_VENDOR__`)
— all patterns proven by the two deployed cards.

### 9.1 Layers
1. **`window.VideoCallCore`** — headless singleton, boots at resource load
   (dashboard open ⇒ endpoint online, even with no card on the visible view):
   - `await window.hassConnection` → `conn`; `register()`; re-register on
     `ready` (reconnect) events; parse `vcall_answer` deep link.
   - Holds the one `CallSession`, the roster cache, and an `EventTarget` for
     UI subscriptions (`roster`, `session`, `status`).
   - Public API (for cards & consoles): `roster()`, `invite(target, media)`,
     `accept()`, `decline()`, `hangup()`, `session` getter, `on(type, cb)`.
2. **`CallSession`** — one per call, states mirroring §5.3 client-side:
   `ringing_in|ringing_out|connecting|active|ended`. Owns gUM + pc + timers
   (signaling 10 s, ice 10 s, stats watchdog 15 s / stall 30 s — babycam
   constants), fixed roles (inviter offers), trickle ICE, clean teardown
   (stop all tracks the moment the session ends — never hold the camera idle;
   learned from browser-whip-card’s stop semantics).
3. **`videocall-overlay`** — full-screen singleton appended to
   `topWindow.document.body` (cross-origin-safe resolution copied from
   babycam). The overlay is the ONLY host of live-call UI — a floating layer
   on top of every element (z-index above HA dialogs), never constrained to a
   card. Its panels:
   - **Incoming ring**: caller identity as `user (endpoint)` — e.g.
     "Mark (browser fc9b61)" — Accept/Decline (≥92 px targets), ringtone via
     WebAudio oscillator (no asset files).
   - **Outgoing**: "Calling <target>…" + Cancel (caller side is floating too).
   - **In-call**: remote video full-bleed; local PiP shown ONLY while outgoing
     video flows — camera off / audio-only renders NO box, remote video only;
     labeled mute-mic and video-off toggle buttons (🎙/🔇, 🎥/🚫, red off
     state) + hangup; duration header.
   - **FaceTime mode (phones)**: on ≤800 px screens the remote video is
     cover-fit (fills the entire screen, no letterbox); controls are
     safe-area-inset aware and auto-hide after 4 s in-call — tap the video to
     hide, tap anywhere to bring them back.
   - **Minimize**: a bar button shrinks the call to a small floating tile
     (remote video only, bottom-right, page underneath fully usable). While
     minimized, **outgoing video is turned off** (privacy + bandwidth) and its
     prior state is restored on un-minimize; mic is untouched. Tap the tile to
     restore.
   - **Ended UX**: hangup (and every non-decline end) closes the overlay
     IMMEDIATELY — no lingering status screen. The single exception: the
     **caller** sees a brief "Call declined" toast when the callee declined.
4. **`videocall-card`** — Lovelace card with **three dropdowns** — *People*,
   *Rooms*, *Devices* — each paired with action buttons **📹 video / 📞 audio /
   ⚡ drop-in**. People = persons (always enabled — phones are push-reachable);
   Rooms = areas with online browser count + push-phone count; Devices = browser
   endpoints (online badge, disabled when offline) **plus** companion phones
   (`📱` prefix, always enabled, drop-in button disabled — a push can't
   auto-answer). Selections are per-dropdown; buttons act on that dropdown's
   current selection and disable while a session is active. Native
   `<select>` dropdowns; the group label is the placeholder option —
   `disabled+selected` but NEVER `hidden` (Android renders the collapsed
   select empty when the selected option is hidden). **Width floor rule:**
   the select must keep `min-width:~130px` and the row must `flex-wrap` —
   `min-width:0` lets flexbox crush the select to zero next to the call
   buttons on narrow cards, which reads as "empty/broken dropdown on
   Android" (it was a CSS collapse, not a WebView bug). Options are ordered
   **online group first, then offline, each alphabetical**; Area labels are
   the bare area name (🟢 prefix when browsers are online — no device
   counts). The card is a
   **launcher only** — the call itself always lives in the floating overlay —
   and shows a one-line status ("Calling Mark…", "In call with …", "Call
   ended (reason)"). **DOM stability rule:** the dropdown groups are built
   once; roster pushes only update `<option>`s and disabled flags in place.
   Rebuilding buttons on each (1 s-debounced) roster event destroys the
   element between touchstart and click — the tap-twice bug. Buttons are
   ≥48 px touch targets. Plus `videocall-card-editor` stub config (no required
   options; optional `hide_roster_sections`).
5. **`videocall-button`** — one-tap call button. With a fixed target (one of
   `person:` entity_id / `area:` area_id / `device:` endpoint client_id /
   `mobile:` notify service) it calls immediately; with NO target it is a
   **picker**: tapping opens a floating sheet of callable targets (shared
   `rosterOptions` data/ordering, optional `sections:` filter) — tap one to
   call, tap outside to dismiss. Optional `name`, `media: video|audio`,
   `drop_in: true` (applied only where the target's `dropInOk`), `icon`.
   Disabled while any call is live; the call UI is the shared overlay.
   Registered in `window.customCards` as "Video Call Button".

### 9.2 gUM policy
- Never at boot, never while ringing. Acquire on Accept (callee gesture) /
  on `accepted` (caller — the invite tap was the gesture).
- Constraints: reuse browser-whip-card’s capability-aware builder (ideal
  1280×720@30, front-facing `user` default for calls, EC/NS/AGC on, 48 kHz mono).
- 12 s gUM timeout (Android WebView hang guard — proven constant); on video
  failure retry audio-only before failing the call.
- **Device-busy retry** (ladder): `NotReadableError`/`TrackStartError`/
  `AbortError` → retry after ~1 s, then ~2.5 s. The camera/mic may still be held
  by a publisher that just yielded on `camera:claim` (§9.4) or by the previous
  call's tracks (WebView release latency — Android can take >1.3 s to free a
  camera held for hours); without this, back-to-back calls fail instantly on the
  second attempt. The ladder is also the backstop for holders that don't
  cooperate with the `camera:claim`/`camera:release` protocol.

### 9.3 Ring UX
- Overlay z-index above HA dialogs; auto-dismiss on `ring_cancel`/timeout.
- Incoming ring MUST identify the calling user, not just the endpoint:
  `epLabel(info)` = `user_name (endpoint name)` → "Mark (browser fc9b61)".
- While ringing out: floating "Calling <target>…" panel with Cancel.
- Drop-in arrival: single chime + "<caller> dropped in" banner, no ringtone.

### 9.4 Coexistence at runtime (§10 mechanics)
Camera hand-off is a **generic, cooperative event protocol** — no reference to
any specific publisher. `CameraCoord` is a **singleton, not per-session**
(claim/release must serialize ACROSS calls). On media acquire it broadcasts the
`window` event `camera:claim` (`detail: {by:"videocall", willRelease:false}`);
any cooperating camera user (browser-whip-card, webrtc-babycam, …) stops
publishing SYNCHRONOUSLY and sets `detail.willRelease = true`, so we settle
~800 ms (device release latency — Android is slow) ONLY when something actually
released — zero cost otherwise. On session end we **schedule** a `camera:release`
broadcast (~1.5 s debounce); a new call arriving first cancels it and a fresh
claim is idempotent, so the publisher stays down until the line is truly idle.
A per-session fire-and-forget release loses the race with a back-to-back second
call: the new call sees nothing paused, then the deferred restart steals the
camera mid-gUM (the "second call required to connect" bug). Publishers resume
THEMSELVES on `camera:release` (browser-whip-card restarts from its own
`bwc:settings`). We never touch `window.BrowserWhipCore` or any `bwc:*` /
`webrtc.*` storage — the getUserMedia retry ladder (§9.2) is the backstop for
slow or non-cooperating holders. The client signaling guard (accept→offer) is
20 s — it must outlast the peer's worst-case acquisition chain (release settle +
12 s gUM + retry ladder).

## 10. Coexistence rules (normative)

1. No name collisions: only namespace tokens from §2 table.
2. Never call getUserMedia except per §9.2 (kiosks stream via WHIP 24/7 —
   most browsers allow shared camera access, but Fully-Kiosk/WebView devices
   often don’t; hence the cooperative `camera:claim`/`camera:release` hand-off
   §9.4).
3. Do not register any HTTP view under `/api/webrtc/*` or static under
   `/webrtc/*`; ours live under `/videocall/*` only.
4. webrtc-babycam sessions are left untouched (they’re receive-mostly); the
   only interaction allowed is muting our own ringtone if
   `WebRTCsession.globalMute` — NOT in v1, documented future nicety.
5. browser_mod: read-only device-registry adoption; never send/hook
   `browser_mod/*` WS commands.
6. **Kill switch (coexistence A/B):** opening any dashboard URL with
   `?vcall_off=1` persistently disables the entire videocall frontend on that
   browser (`vcall:disabled` LS key; `?vcall_on=1` re-enables). First line of
   the IIFE — nothing else runs. Exists so any "videocall broke X" report can
   be bisected on the affected device in seconds, without touching the
   integration or other devices.
7. **Media-session hygiene (iOS):** when a call ends, the overlay MUST null
   both video elements' `srcObject` — WKWebView keeps its media pipeline
   engaged for elements holding stale streams, which can starve other
   players' (babycam) decode/audio sessions.

## 11. Security

- Signaling requires HA auth (long-lived kiosk users included). No
  unauthenticated views at all (contrast: deployed webrtc’s `/api/webrtc/ws`
  is `requires_auth=False` + signed-path — we need none of that since the card
  always has a live authed connection).
- Any user may call any endpoint/person (household trust model). Admin-only:
  services and options flow (HA default).
- SDP/ICE payload size capped (vol.Length(max=65536)); call/registry maps are
  bounded (endpoints ≤ 256, ended-call log ≤ 50) — no unbounded growth from a
  misbehaving client.
- Media is P2P SRTP (DTLS) — never transits HA.

## 12. Implementation plan

| Milestone | Content | Done when |
|---|---|---|
| **M0 scaffold** | skeleton in this repo, manifest, config flow, empty registries; installable | integration adds via UI, no log errors |
| **M1 signaling** | models.py, ws_api.py complete; roster; presence | two `wscat` sessions can complete a scripted call FSM |
| **M2 frontend core+card** | Core, CallSession, card roster UI; browser↔browser calls on LAN | video call kitchen-panel ↔ desktop Chrome |
| **M3 ring UX** | overlay, ringtone, area targeting, busy/timeout paths | ring "Kitchen" rings only kitchen panel; timeout → missed |
| **M4 mobile** | mobile.py push/clear/decline, deep-link answer | ring "Mark" → phone rings → Answer joins video from iOS + Android |
| **M5 polish** | entities, last-call sensor, bus events, camera-coexistence events, prune service, README/HACS | watchman clean; docs match behavior |

Testing: models.py gets pure pytest (FSM edge cases: double-accept, decline-all,
timeout-vs-accept race, supersede). Signaling tested with
`pytest-homeassistant-custom-component` harness. Manual matrix in README:
Chrome/Fully-Kiosk/companion-Android/companion-iOS × caller/callee.

## 13. Future (explicitly out of v1)

- Group calls (SFU — would ride go2rtc), screen share (`getDisplayMedia`),
  doorbell mode (one-way go2rtc stream + talkback into a call UI), ring
  automation service (`videocall.ring` with a media source), TURN autodeploy,
  babycam global-mute handshake, native CallKit/Telecom
  incoming-call UI if the companion apps ever expose it (today's actionable
  push is the supported mechanism).
