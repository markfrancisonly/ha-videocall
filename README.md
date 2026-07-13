# Video Call for Home Assistant

HA-native WebRTC video/audio calling between your Home Assistant clients —
wall panels, kiosk browsers, desktops, and the iOS/Android companion apps.
Home Assistant itself is the signaling server (no cloud, no extra services);
media flows peer-to-peer, with optional TURN relay for calls across the
internet.


> **Note:** Home Assistant must be accessed over **HTTPS** so browsers
> can use the camera and microphone. TLS may be provided by Home Assistant
> itself or by a reverse proxy.

## Features

- **Call an area** — ring every open browser in a room (wall panels, kiosks)
  plus companion phones assigned to that area; first to answer wins
- **Call a person** — ring all their logged-in browsers AND push an
  actionable ring notification to their phones (works with the app closed;
  Answer opens straight into the call)
- **Call a device** — target one specific browser or phone
- **Drop-in** — auto-answer on kiosks/tablets, Alexa-style, with per-device
  consent (each device chooses who may drop in, right on its own card)
- **Zero config** — persons, phones, and browser endpoints (with their
  rooms, via [browser_mod](https://github.com/thomasloven/hass-browser_mod)
  areas when present) are discovered automatically
- **FaceTime-style UI** — floating full-screen call overlay on every device,
  minimize-to-tile, mute/video-off controls, mobile safe-areas
- Entities (`binary_sensor` online, `sensor` call state per endpoint, last
  call log), HA events for automations (`videocall_incoming`,
  `videocall_answered`, `videocall_ended`)


## Installation

### HACS (Recommended)

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=markfrancisonly&repository=ha-videocall&category=integration)

Or manually add the custom repository:

<details>
<summary>Step-by-step HACS installation</summary>

1. Open **HACS** in your Home Assistant dashboard
2. Click the **⋮** menu (top right) → **Custom repositories**
3. Add this URL and set the category to **Integration**, then click **Add**:
   ```
   https://github.com/markfrancisonly/ha-videocall
   ```
4. The repository now appears in the custom repositories list. Close the dialog.
5. Back in HACS, search for **Video Call** and open the result
6. Click **Download** (or **Install**) and confirm
7. **Restart Home Assistant**

</details>

### Manual Installation

1. Download the [latest release](https://github.com/markfrancisonly/ha-videocall/releases)
2. Copy the contents into `custom_components/ha-videocall/` inside your HA config directory
3. Restart Home Assistant

---
## Cards

**Roster card** — pick a Person / Area / Device and call (📹 video, 📞 audio,
⚡ drop-in). Also hosts this device's drop-in consent setting.

```yaml
type: custom:videocall-card
```

**Button card** — one-tap call to a fixed target, or a target picker:

```yaml
type: custom:videocall-button
area: kitchen          # or person: person.mark / device: <id> / mobile: mobile_app_x
name: Kitchen
drop_in: true
```

```yaml
type: custom:videocall-button   # no target = tap opens a picker
name: "Call…"
```

## Calls beyond your LAN (TURN)

Same-network calls work out of the box. Calls across the internet (LTE,
remote Wi-Fi) need a **TURN relay** — carrier NAT cannot be traversed with
STUN alone. Configure it in *Video Call → Configure → Settings*:

| Field | Example |
|---|---|
| TURN server | `turn.example.com` or `203.0.113.5:3478` |
| TURN username / credential | from your TURN server |
| TURN LAN address (optional) | `192.168.1.50` — on-network clients skip NAT hairpin |

A ready-to-run [coturn](https://github.com/coturn/coturn) example is in
[`examples/coturn/`](examples/coturn/) — one container plus two router
port-forwards. Advanced users can add raw `RTCIceServer` JSON as well; the
simple fields and the JSON are merged.

## Mobile companion notes

- Ring notifications work with the app **closed** (FCM/APNs); tapping Answer
  (or just opening the app while it's ringing) lands on the full-screen ring
- iOS answers with one tap on the in-app ring (a user gesture is required
  for camera access); Android can auto-answer drop-ins
- Phones appear once in the roster: online (rings in-app) when the app is
  open, push-reachable when closed

## Troubleshooting

- **Call connects then drops with "Connection failed"** → media path (NAT)
  problem: configure TURN, verify the port-forwards. The browser console
  logs a candidate census (`[videocall] media path failed …`) for triage.
- **Disable on one device** — open any dashboard URL with `?vcall_off=1`
  (that browser only; `?vcall_on=1` re-enables). Useful for A/B isolation.
- **Debug logging** — `logger:` → `custom_components.videocall: debug`
  (registrations, consent decisions, call warnings).

## Design

The full architecture/spec lives in [`SPEC.md`](SPEC.md) — signaling
protocol, call state machine, mobile push flows, coexistence rules, and the
field-tested timing constants.

## License

[MIT](LICENSE)
