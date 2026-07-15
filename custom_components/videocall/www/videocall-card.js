// videocall-card.js — HA-native WebRTC video calling frontend.
// Spec: SPEC.md (§9 frontend design). Serves three layers from one file:
//   1. window.VideoCallCore — headless singleton (endpoint registration, signaling,
//      one CallSession, deep-link answer). Boots at resource load so ANY open
//      dashboard is a callable endpoint, card visible or not.
//   2. <videocall-overlay> — full-screen ring + fallback in-call UI singleton.
//   3. <videocall-card> (+ editor) — Lovelace roster/call UI.
//
// COEXISTENCE (SPEC §10 — normative): this file must never collide with the
// deployed webrtc-babycam / webcam-publisher / browser_mod code. Only these
// names are ours: videocall-*, window.VideoCallCore, window.__VCALL_VENDOR__,
// localStorage "vcall:client_id". getUserMedia is NEVER called except on
// accept (callee gesture) / accepted (caller). Before acquiring the camera we
// broadcast `camera:claim` (and `camera:release` after) so any other camera
// user on the page (webcam-publisher, babycam, …) yields it — a generic,
// cooperative hand-off with no hard dependency on those cards.

(() => {
  // COEXISTENCE KILL SWITCH (SPEC §10): open any dashboard URL with
  // ?vcall_off=1 to disable the ENTIRE videocall frontend on this browser
  // (persists); ?vcall_on=1 re-enables. Lets any device A/B-test whether a
  // problem is caused by videocall or by something else (e.g. an HA update)
  // without touching the integration.
  try {
    const q = new URLSearchParams(location.search);
    if (q.has("vcall_on")) localStorage.removeItem("vcall:disabled");
    else if (q.has("vcall_off")) localStorage.setItem("vcall:disabled", "1");
    if (localStorage.getItem("vcall:disabled") === "1") {
      console.warn("[videocall] frontend DISABLED on this browser (?vcall_on=1 to re-enable)");
      return;
    }
  } catch {}

  if (window.__VCALL_VENDOR__) return; // idempotent under double resource load
  const VERSION = "0.14.5";
  window.__VCALL_VENDOR__ = { version: VERSION };

  const LS_CLIENT_ID = "vcall:client_id";
  const DEEP_LINK_PARAM = "vcall_answer";

  // Field-proven timeout constants (babycam / whip-card lineage — SPEC §9.2/§5.4)
  const GUM_TIMEOUT_MS = 12000;
  // Signaling guard must OUTLAST the peer's worst-case media acquisition
  // (WHIP pause 400ms + gUM 12s + busy-retry 900ms) — at 10s the callee gave
  // up while a slow caller was still opening its camera ("flaky first call").
  const SIGNALING_TIMEOUT_MS = 20000; // accept→offer, offer→answer
  const ICE_TIMEOUT_MS = 10000;       // answer→connected
  const STATS_INTERVAL_MS = 15000;    // in-call liveness watchdog
  const MEDIA_STALL_MS = 30000;

  const noop = () => {};

  // cross-origin-safe top window (pattern from webrtc-babycam)
  const topWindow = (() => {
    try { if (window.top && window.top.document) return window.top; } catch {}
    return window;
  })();

  const safeStorage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  };

  const uuid = () => {
    try {
      if (crypto?.randomUUID) return crypto.randomUUID();
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    } catch { return "vc" + String(Math.random()).slice(2, 12) + Date.now().toString(36); }
  };

  // "Mark (Kitchen Browser)" — user + endpoint identity for ring/call UI
  // (SPEC §9.3). Skip the prefix when the endpoint is already named after the
  // user ("Mark's iPhone") — "Mark (Mark's iPhone)" is noise.
  const epLabel = (info) => {
    if (!info) return "Unknown";
    const n = info.name || (info.client_id || "").slice(0, 6) || "unknown";
    if (!info.user_name || n.toLowerCase().startsWith(info.user_name.toLowerCase())) return n;
    return `${info.user_name} (${n})`;
  };

  // iPhone vs iPad — narrows companion↔mobile_app matching server-side
  const uaHint = () => {
    const ua = navigator.userAgent || "";
    if (/iPad/i.test(ua)) return "ipad";
    if (/iPhone/i.test(ua)) return "iphone";
    return undefined;
  };

  const uaKind = () => {
    const ua = navigator.userAgent || "";
    // Companion UA: "… Home Assistant/2025.x (io.robbie.HomeAssistant; …)".
    // NOTE the space in "Home Assistant/" — matching "HomeAssistant/<ver>"
    // never fires, which silently classified every phone as a plain browser.
    const companion = /Home ?Assistant\/[\d.]/i.test(ua) || /io\.robbie\.HomeAssistant/i.test(ua);
    if (!companion) return "browser";
    if (/Android/i.test(ua)) return "companion-android";
    if (/(iPhone|iPad|iOS)/i.test(ua)) return "companion-ios";
    return "browser"; // macOS/other companion — treat as a browser endpoint
  };

  // "Chrome (Windows)" — differentiates a user's multiple plain browsers in
  // device names without resorting to hex (SPEC §4.2 naming rules)
  const browserHint = () => {
    const ua = navigator.userAgent || "";
    let b = "browser";
    if (/Edg\//.test(ua)) b = "Edge";
    else if (/OPR\//.test(ua)) b = "Opera";
    else if (/Firefox\//.test(ua)) b = "Firefox";
    else if (/Chrome\//.test(ua)) b = "Chrome";
    else if (/Safari\//.test(ua)) b = "Safari";
    let os = "";
    if (/Windows/.test(ua)) os = "Windows";
    else if (/Android/.test(ua)) os = "Android";
    else if (/iPad/.test(ua)) os = "iPad";
    else if (/iPhone/.test(ua)) os = "iPhone";
    else if (/Mac OS X/.test(ua)) os = "Mac";
    else if (/Linux/.test(ua)) os = "Linux";
    return os ? `${b} (${os})` : b;
  };

  // ==========================================================================
  // Shared roster→options builder (main-card dropdowns + button picker).
  // options: [{key, label, plainLabel, online, target, callable, dropInOk}]
  // Ordering: online group first, each group alphabetical (SPEC §9.1).
  // ==========================================================================
  const rosterOptions = (core) => {
    const { persons = [], areas = [], endpoints = [], mobiles = [] } = core.rosterCache || {};
    const grouped = (opts) => opts.sort((a, b) =>
      (b.online ? 1 : 0) - (a.online ? 1 : 0) ||
      a.plainLabel.localeCompare(b.plainLabel));

    return {
      // persons are ALWAYS callable: phones are push-reachable even with the
      // app closed; the online flag only marks live browser presence.
      persons: grouped(persons.map((p) => ({
        key: `person:${p.entity_id}`,
        label: `${p.online ? "🟢" : "📱"} ${p.name}`,
        plainLabel: p.name,
        online: p.online,
        target: { type: "person", id: p.entity_id },
        callable: true,
        dropInOk: p.online, // drop-in auto-answers browsers only
      }))),
      areas: grouped(areas.map((a) => ({
        key: `area:${a.area_id}`,
        label: `${a.online_count > 0 ? "🟢 " : ""}${a.name}`,
        plainLabel: a.name,
        online: a.online_count > 0,
        target: { type: "area", id: a.area_id },
        callable: a.online_count > 0 || a.push_count > 0,
        dropInOk: a.online_count > 0,
      }))),
      // ONE row per phone (SPEC §4.4): a companion endpoint unified with its
      // mobile_app device is represented by the mobile row (online dot +
      // in-app ring when open; push when closed) — hide the raw endpoint.
      devices: grouped([
        ...endpoints
          .filter((e) => e.client_id !== core.clientId && !e.notify_service)
          .map((e) => ({
            key: `endpoint:${e.client_id}`,
            label: `${e.online ? "🟢" : "⚪"} ${e.name || e.client_id.slice(0, 8)}${e.area_name ? ` — ${e.area_name}` : ""}`,
            plainLabel: e.name || e.client_id.slice(0, 8),
            online: e.online,
            target: { type: "endpoint", id: e.client_id },
            callable: e.online,
            dropInOk: e.online,
          })),
        ...mobiles.map((m) => ({
          key: `mobile:${m.notify_service}`,
          label: `${m.online ? "🟢" : "📱"} ${m.name}${m.area_name ? ` — ${m.area_name}` : ""}`,
          plainLabel: m.name,
          online: !!m.online,
          // app open → ring in-app via its endpoint; closed → push
          target: m.online && m.endpoint_id
            ? { type: "endpoint", id: m.endpoint_id }
            : { type: "mobile", id: m.notify_service },
          callable: true,
          // an OPEN companion app is a live endpoint and CAN auto-answer —
          // wall-mounted tablets/kiosks are the primary drop-in use case.
          // Only closed-app push targets can't (a push needs a tap).
          dropInOk: !!m.online,
        })),
      ]),
    };
  };

  // ==========================================================================
  // Floating target-picker sheet — shared by videocall-button (pick & call)
  // and the main card's selector rows (pick → selection). Replaces native
  // <select>, which Android WebView renders badly (empty collapsed
  // placeholder, flashing on option rebuilds).
  // ==========================================================================
  const openTargetSheet = (core, sections, onPick) => {
    core.refreshRoster().catch(noop);
    const opts = rosterOptions(core);
    const titles = { persons: "Person", areas: "Area", devices: "Device" };

    const doc = topWindow.document;
    const sheet = doc.createElement("div");
    sheet.style.cssText =
      "position:fixed;inset:0;z-index:100001;background:rgba(10,12,16,.7);" +
      "display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif";
    const panel = doc.createElement("div");
    panel.style.cssText =
      "background:var(--card-background-color,#1f242b);color:var(--primary-text-color,#eee);" +
      "border-radius:16px;max-height:72vh;overflow:auto;min-width:280px;max-width:92vw;" +
      "padding:14px;box-shadow:0 10px 40px rgba(0,0,0,.5)";
    const close = () => sheet.remove();
    sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });

    for (const key of sections) {
      const list = opts[key] || [];
      if (!list.length) continue;
      if (sections.length > 1) {
        const h = doc.createElement("div");
        h.textContent = titles[key] || key;
        h.style.cssText = "font-size:11px;letter-spacing:.05em;text-transform:uppercase;opacity:.6;margin:10px 4px 4px";
        panel.appendChild(h);
      }
      for (const o of list) {
        const row = doc.createElement("button");
        row.textContent = o.label;
        row.disabled = !o.callable;
        row.style.cssText =
          "display:block;width:100%;text-align:left;min-height:48px;padding:10px 12px;" +
          "border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer" +
          (o.callable ? "" : ";opacity:.35;cursor:default");
        row.onclick = () => { close(); onPick(o); };
        panel.appendChild(row);
      }
    }
    if (!panel.childElementCount) {
      const d = doc.createElement("div");
      d.textContent = "No callable targets.";
      d.style.cssText = "padding:16px;opacity:.7";
      panel.appendChild(d);
    }
    sheet.appendChild(panel);
    doc.body.appendChild(sheet);
  };

  // ==========================================================================
  // CameraCoord — cooperative camera hand-off between cards on the page (SPEC §9.4)
  //
  // We reference no specific publisher. Before getUserMedia we broadcast
  // `camera:claim` with our id; any cooperating camera holder (webcam-publisher,
  // babycam, …) releases the device and sets detail.willRelease so we know to wait
  // out the device-release latency (Android is slow). When done we broadcast
  // `camera:release` with the SAME id so holders resume (they reference-count
  // claims by id). ONE coordinator, so a single claim covers back-to-back calls: a
  // new call CANCELS any pending release, keeping holders down until the line is
  // truly idle (avoids the old "second call NotReadableError" race). The
  // getUserMedia retry ladder is the backstop for slow / non-cooperating holders.
  // ==========================================================================
  const CameraCoord = {
    ID: "videocall", // claim/release identity; holders key their refcount on it
    _claimed: false,
    _timer: null,
    async claim() {
      clearTimeout(this._timer); this._timer = null; // a new call kills any pending release
      if (this._claimed) return;
      this._claimed = true;
      const ev = new CustomEvent("camera:claim", { detail: { id: this.ID, willRelease: false } });
      window.dispatchEvent(ev); // cooperating holders release synchronously + set willRelease
      if (ev.detail.willRelease) await new Promise((r) => setTimeout(r, 800)); // device release latency
    },
    scheduleRelease() {
      if (!this._claimed) return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { this._timer = null; this._release(); }, 1500);
    },
    _release() {
      if (!this._claimed) return;
      this._claimed = false;
      window.dispatchEvent(new CustomEvent("camera:release", { detail: { id: this.ID } }));
    },
  };

  // ==========================================================================
  // go2rtc WebRTC helpers (SPEC §14). go2rtc signals over a WebSocket
  // (/api/ws?src=NAME) with trickle ICE — the SAME transport its own web UI
  // uses, and the only one that carries the mic backchannel for two-way audio.
  // (The HTTP /api/webrtc endpoint is WHEP-style and receive-only.)
  // ==========================================================================

  // Derive the go2rtc WS URL from a configured base or /api/webrtc URL.
  const go2rtcWsUrl = (doorbell) => {
    let base = String(doorbell.webrtc_url || "").trim().replace(/\/+$/, "");
    base = base.replace(/\/api\/(webrtc|ws)$/i, "");   // tolerate base | /api/webrtc | /api/ws
    const q = "src=" + encodeURIComponent(doorbell.stream) +
      (doorbell.token ? "&access_token=" + encodeURIComponent(doorbell.token) : "");
    return base.replace(/^http/i, "ws") + "/api/ws?" + q;
  };

  // Drive an already-built RTCPeerConnection through go2rtc's WS offer/answer +
  // trickle-candidate exchange (message shapes copied from go2rtc's video-rtc.js:
  // send {type:'webrtc/offer',value:sdp} and {type:'webrtc/candidate',value:cand};
  // recv 'webrtc/answer' → setRemoteDescription, 'webrtc/candidate' → addIce with
  // sdpMid '0'). Returns a handle; .close() ends signaling.
  const go2rtcNegotiate = (pc, doorbell) => {
    const ws = new WebSocket(go2rtcWsUrl(doorbell));
    const handle = { ws, dead: false, close() { this.dead = true; try { ws.close(); } catch {} } };
    ws.addEventListener("open", async () => {
      if (handle.dead) return;
      pc.addEventListener("icecandidate", (e) => {
        if (handle.dead || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: "webrtc/candidate", value: e.candidate ? e.candidate.candidate : "" }));
      });
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "webrtc/offer", value: pc.localDescription.sdp }));
      } catch (err) { console.warn("[videocall] go2rtc offer failed", err); }
    });
    ws.addEventListener("message", (ev) => {
      if (handle.dead) return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "webrtc/answer") pc.setRemoteDescription({ type: "answer", sdp: msg.value }).catch(noop);
      else if (msg.type === "webrtc/candidate") pc.addIceCandidate({ candidate: msg.value, sdpMid: "0" }).catch(noop);
    });
    ws.addEventListener("error", () => console.warn("[videocall] go2rtc ws error", go2rtcWsUrl(doorbell)));
    return handle;
  };

  // Receive-only go2rtc view (no mic) — the doorbell card's inline live
  // preview. Independent of the call FSM / overlay, so it never occupies
  // core.session or blocks a real call. Tapping the preview escalates to the
  // full two-way intercom (core.callDoorbell) in the overlay.
  class Go2rtcView {
    constructor(doorbell, iceServers) {
      this.doorbell = doorbell;
      this.iceServers = iceServers || [];
      this.pc = null;
      this.g2r = null;
      this.stream = new MediaStream();
      this.onstream = null;
      this._dead = false;
    }
    connect() {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.pc = pc;
      pc.ontrack = (e) => { this.stream.addTrack(e.track); if (!this._dead) this.onstream?.(this.stream); };
      try { pc.addTransceiver("video", { direction: "recvonly" }); } catch {}
      try { pc.addTransceiver("audio", { direction: "recvonly" }); } catch {}
      this.g2r = go2rtcNegotiate(pc, this.doorbell);
    }
    close() {
      this._dead = true;
      try { this.g2r?.close(); } catch {}
      try { this.pc?.close(); } catch {}
      this.pc = null;
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    }
  }

  // ==========================================================================
  // CallSession — one WebRTC call, client-side FSM (SPEC §5.3/§5.4)
  // states: ringing_in | ringing_out | connecting | active | ended
  // ==========================================================================
  class CallSession {
    constructor(core, { callId, role, media, peer, doorbell }) {
      this.core = core;             // VideoCallCore (send/sig access)
      this.callId = callId;
      this.role = role;             // 'caller' | 'callee'
      this.media = media;           // 'video' | 'audio'
      this.peer = peer || null;     // EndpointInfo (may arrive later for caller)
      this.state = role === "caller" ? "ringing_out" : "ringing_in";
      this.endReason = null;

      // DOORBELL (SPEC §14): the media peer is a go2rtc stream, not a browser.
      // We send only our mic (talkback → camera backchannel) and receive the
      // door's video+audio; there is NO SDP relay through HA. The descriptor
      // ({webrtc_url, stream, …}) arrives with the ring / accept result.
      this.doorbell = doorbell || null;
      this.isDoorbell = !!doorbell || peer?.kind === "doorbell";
      // Half-duplex PUSH-TO-TALK is the doorbell default. A hands-free door
      // speaker+mic loops your voice back after go2rtc's delay, and browser AEC
      // cannot cancel that REMOTE acoustic loop (it only cancels your own
      // speaker→mic echo). PTT — send mic only while held, mute your speaker
      // while talking — sidesteps it. full_duplex opts into always-open audio
      // (only sane if the camera has solid onboard AEC).
      this.pushToTalk = this.isDoorbell && !(doorbell && doorbell.full_duplex);
      this.talking = false;

      this.pc = null;
      this.localStream = null;
      this.remoteStream = new MediaStream();
      this.startedAt = null;

      // PTT starts muted — mic transmits only while the talk button is held.
      this.micEnabled = !this.pushToTalk;
      // a doorbell intercom never sends outgoing video (mic-only) → no cam
      this.camEnabled = media === "video" && !this.isDoorbell;

      this._timers = new Set();
      this._watchdog = null;
      this._lastBytes = 0;
      this._lastBytesAt = 0;

      this.events = new EventTarget();
    }

    _emit(type, detail) { this.events.dispatchEvent(new CustomEvent(type, { detail })); }
    _setState(s) { this.state = s; this._emit("state", s); this.core._emit("session", this); }

    _after(ms, fn) {
      const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
      this._timers.add(t);
      return t;
    }
    _armGuard(ms, label) {
      // any pending guard is superseded by the next FSM step
      this._clearGuard();
      this._guard = this._after(ms, () => this.fail(`timeout: ${label}`));
    }
    _clearGuard() { if (this._guard) { clearTimeout(this._guard); this._timers.delete(this._guard); this._guard = null; } }

    // ---- media --------------------------------------------------------

    async _getMedia() {
      await CameraCoord.claim();
      const wantVideo = this.media === "video";
      const constraints = {
        audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true },
                 autoGainControl: { ideal: true }, channelCount: { ideal: 1 } },
        video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 },
                             frameRate: { ideal: 30 }, facingMode: { ideal: "user" } } : false,
      };
      const gum = (c) => {
        let timer, timedOut = false;
        const p = navigator.mediaDevices.getUserMedia(c);
        p.then((s) => { if (timedOut) s.getTracks().forEach((t) => t.stop()); }).catch(noop);
        return Promise.race([
          p,
          new Promise((_, rej) => { timer = setTimeout(() => { timedOut = true; rej(new Error("getUserMedia timeout")); }, GUM_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
      };
      // Device-busy retry: the camera/mic may still be held for a moment by a
      // publisher we just paused (WHIP) or by the PREVIOUS call's tracks
      // (Android/WebView release latency). Without this, back-to-back calls
      // fail instantly with NotReadableError on attempt 2 and only work on 3.
      const gumRetry = async (c) => {
        // retry LADDER: Android can take >1.3s to release a camera that was
        // held for hours (WHIP publisher) — a single 0.9s retry missed the
        // first call of the day; later calls find a recently-cycled camera.
        const busy = (e) => ["NotReadableError", "TrackStartError", "AbortError"].includes(e?.name);
        try { return await gum(c); }
        catch (e1) {
          if (!busy(e1)) throw e1;
          await new Promise((r) => setTimeout(r, 1000));
          try { return await gum(c); }
          catch (e2) {
            if (!busy(e2)) throw e2;
            await new Promise((r) => setTimeout(r, 2500));
            return await gum(c);
          }
        }
      };
      try {
        this.localStream = await gumRetry(constraints);
      } catch (e) {
        if (wantVideo) {
          // degrade to audio-only (webview w/o camera permission — SPEC §7.2)
          this.media = "audio"; this.camEnabled = false;
          this.localStream = await gumRetry({ ...constraints, video: false });
          this._emit("toast", "Camera unavailable — audio only");
        } else {
          throw e;
        }
      }
      this._emit("localstream", this.localStream);
    }

    /** Poor-man's flip camera: cycle the OUTGOING video to the next camera.
     *  Uses RTCRtpSender.replaceTrack (no SDP renegotiation) and rebuilds
     *  localStream as a NEW MediaStream so the self-view PiP refreshes. The
     *  current camera is freed first (phones can't hold two open at once), then
     *  a strategy ladder is tried — exact deviceId (desktop / modern iOS) →
     *  facingMode flip (iOS-reliable front/back) — restoring the original if
     *  every strategy fails. Returns the new label, else null (audio-only /
     *  single camera / failure). */
    async cycleCamera() {
      if (this._cyclingCam || this.media !== "video") return null;
      const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
      const current = this.localStream?.getVideoTracks()[0];
      if (!sender || !current) return null;
      this._cyclingCam = true;
      const st = current.getSettings();
      const curId = st.deviceId;
      const nextFacing = st.facingMode === "environment" ? "user" : "environment";
      const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
      const dead = () => this.state === "ended" || !this.pc || !this.localStream;
      // getUserMedia with a timeout — a hung capture must not wedge the ladder or
      // leave _cyclingCam stuck true (and the old camera already stopped) forever
      const getVideo = (video) => {
        let timer, timedOut = false;
        const p = navigator.mediaDevices.getUserMedia({ video, audio: false });
        p.then((s) => { if (timedOut || dead()) s.getTracks().forEach((t) => t.stop()); }).catch(noop);
        return Promise.race([
          p.then((s) => s.getVideoTracks()[0]),
          new Promise((_, rej) => { timer = setTimeout(() => { timedOut = true; rej(new Error("gUM timeout")); }, GUM_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
      };
      // release-settle retry for the RESTORE — Android/WebView frees a camera
      // slowly, so the second concurrent open can NotReadableError a few times
      const getVideoRetry = async (video) => {
        try { return await getVideo(video); }
        catch { await new Promise((r) => setTimeout(r, 1000));
          try { return await getVideo(video); }
          catch { await new Promise((r) => setTimeout(r, 2500)); return await getVideo(video); } }
      };
      // install a track — but NEVER into a call that ended during the gUM await
      const apply = async (track) => {
        if (dead()) { track.stop(); return false; }
        track.enabled = this.camEnabled;
        await sender.replaceTrack(track);
        this.localStream = new MediaStream([...this.localStream.getAudioTracks(), track]);
        this._emit("localstream", this.localStream);
        return true;
      };
      try {
        let cams = [];
        try {
          cams = (await navigator.mediaDevices.enumerateDevices())
            .filter((d) => d.kind === "videoinput");
        } catch { /* enumerateDevices can throw before permission */ }
        if (cams.length < 2 || dead()) return null;     // one camera, or call gone
        const i = cams.findIndex((d) => d.deviceId && d.deviceId === curId);
        const nextId = cams[((i < 0 ? 0 : i) + 1) % cams.length].deviceId;
        // free the current camera first — most phones NotReadableError on a
        // second concurrent open
        current.stop();
        try { this.localStream.removeTrack(current); } catch {}
        const ladder = [
          { ...base, deviceId: { exact: nextId } },
          { ...base, facingMode: { exact: nextFacing } },
          { ...base, facingMode: nextFacing },
        ];
        for (const video of ladder) {
          let t = null;
          try { t = await getVideo(video); } catch { continue; }
          if (!t) continue;
          try { if (await apply(t)) return t.label || "Camera switched"; }
          catch { /* replaceTrack failed */ }
          try { t.stop(); } catch {}                    // apply bailed/failed — free it
          return null;
        }
        // every strategy failed — restore the ORIGINAL camera so video flows
        try {
          const b = await getVideoRetry(curId ? { ...base, deviceId: { exact: curId } } : base);
          if (b) {
            let ok = false;
            try { ok = await apply(b); } catch {}
            if (ok) return null;                        // recovered — not frozen
            try { b.stop(); } catch {}
          }
        } catch {}
        // restore failed too — never leave a STOPPED track frozen on the sender
        try { await sender.replaceTrack(null); } catch {}
        this._emit("toast", "Camera switch failed");
        return null;
      } catch (e) {
        console.warn("[videocall] cycleCamera failed", e);
        return null;
      } finally {
        this._cyclingCam = false;
      }
    }

    // ---- peer connection ------------------------------------------------

    // ontrack + connection/ice state wiring shared by the P2P and doorbell
    // (go2rtc) media paths; only track setup + signaling differ between them.
    _wireCommon(pc) {
      pc.ontrack = (e) => {
        e.streams[0]?.getTracks().forEach(noop); // ensure stream referenced
        this.remoteStream.addTrack(e.track);
        this._emit("remotestream", this.remoteStream);
      };
      pc.oniceconnectionstatechange = () =>
        console.debug(`[videocall] ice: ${pc.iceConnectionState}`);
      pc.onconnectionstatechange = () => {
        const cs = pc.connectionState;
        console.debug(`[videocall] pc: ${cs}`);
        if (cs === "connected" && this.state === "connecting") {
          this._clearGuard();
          this.startedAt = Date.now();
          this._setState("active");
          this._startWatchdog();
        } else if (cs === "failed" || cs === "closed") {
          if (this.state !== "ended") this.fail("connection " + cs);
        }
        // NOTE: 'disconnected' is transient; the stats watchdog catches real death.
      };
    }

    _createPc() {
      const pc = new RTCPeerConnection({ iceServers: this.core.iceServers || [] });
      this.pc = pc;
      // trickle ICE to the peer via HA relay (browser↔browser only)
      pc.onicecandidate = (e) =>
        this.core._send("videocall/candidate", {
          call_id: this.callId, client_id: this.core.clientId,
          candidate: e.candidate ? e.candidate.toJSON() : null,
        }).catch(noop);
      this._wireCommon(pc);
      this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
      if (this.media === "audio") {
        try { pc.addTransceiver("video", { direction: "recvonly" }); } catch {}
      }
      return pc;
    }

    // ---- doorbell / go2rtc intercom (SPEC §14) --------------------------

    /** Acquire the mic for talkback (never a camera — we don't send video to a
     *  door). Mic denied → listen-only (recvonly audio), still a useful view. */
    async _getMicForDoorbell() {
      await CameraCoord.claim(); // a kiosk WHIP publisher may hold the mic
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true },
                   autoGainControl: { ideal: true }, channelCount: { ideal: 1 } },
          video: false,
        });
      } catch (e) {
        this.localStream = null;       // listen-only
        this.micEnabled = false;
        this._emit("toast", "Microphone unavailable — listen only");
      }
      this._emit("localstream", this.localStream || new MediaStream());
    }

    /** Build the media leg to go2rtc: mic up (backchannel) + door video/audio
     *  down. Entry point for both call directions (view-a-door / answer-a-ring). */
    async _connectDoorbell() {
      const d = this.doorbell;
      if (!d) return this.fail("no doorbell descriptor");
      try {
        await this._getMicForDoorbell();
        if (this.state === "ended") return;
        // Two-stream mode (SPEC §14): a separate `talk_stream` means the mic
        // rides its OWN go2rtc connection (sendonly → backchannel) while the
        // door's video+audio come down the receive `stream`. Otherwise the mic
        // goes up the single receive pc (backchannel on `stream`).
        const mic = this.localStream?.getAudioTracks()[0];
        const talkStream = mic && d.talk_stream && d.talk_stream !== d.stream ? d.talk_stream : null;

        // RECEIVE pc — door video + audio. This one drives the call FSM.
        const pc = new RTCPeerConnection({ iceServers: this.core.iceServers || [] });
        this.pc = pc;
        this._wireCommon(pc);
        // M-LINE SHAPE mirrors go2rtc's OWN client (video-rtc.js): recvonly
        // video + recvonly audio + the mic as its OWN sendonly m-line. Do NOT
        // fold the mic into one sendrecv audio line (0.14.3 tried that,
        // babycam-style): go2rtc pairs its outbound door audio with the
        // recvonly line, and the sendrecv shape left the browser without an
        // incoming audio track at all — the silent-tab bug.
        try { pc.addTransceiver("video", { direction: "recvonly" }); } catch {}
        try { pc.addTransceiver("audio", { direction: "recvonly" }); } catch {}
        if (mic && !talkStream) {
          mic.enabled = this.micEnabled;
          try { pc.addTransceiver(mic, { direction: "sendonly" }); }
          catch { try { pc.addTrack(mic, this.localStream); } catch {} }
        }
        this._g2r = go2rtcNegotiate(pc, d); // WS offer/answer + trickle
        this._audioProbe(); // console-logs the layer where audio dies, if it does

        // TALK pc — a second, best-effort sendonly-mic connection to the
        // backchannel stream. Not wired to the FSM: if talk fails, the call
        // (video + listen) still stands. The same track is shared, so the mic
        // toggle mutes both.
        if (talkStream) {
          const tpc = new RTCPeerConnection({ iceServers: this.core.iceServers || [] });
          this.talkPc = tpc;
          mic.enabled = this.micEnabled;
          try { tpc.addTransceiver(mic, { direction: "sendonly" }); }
          catch { try { tpc.addTrack(mic, this.localStream); } catch {} }
          this._talkG2r = go2rtcNegotiate(tpc, { ...d, stream: talkStream });
        }

        this._armGuard(SIGNALING_TIMEOUT_MS, "go2rtc connect");
      } catch (e) {
        this.fail("doorbell: " + String(e?.message || e));
      }
    }

    /** Doorbell-silence triage: periodically logs whether an incoming audio
     *  TRACK exists (negotiation), whether RTP flows on it (transport), and
     *  the decoded audioLevel (content) — so a "no sound" report pinpoints
     *  the failing layer from the browser console alone. */
    _audioProbe() {
      let n = 0;
      const iv = setInterval(async () => {
        if (!this.pc || this.state === "ended" || ++n > 4) { clearInterval(iv); return; }
        let rtp = "no inbound-rtp";
        try {
          const stats = await this.pc.getStats();
          stats.forEach((r) => {
            if (r.type === "inbound-rtp" && (r.kind || r.mediaType) === "audio")
              rtp = `packets=${r.packetsReceived} level=${r.audioLevel != null ? r.audioLevel.toFixed(3) : "?"}`;
          });
        } catch {}
        const t = this.remoteStream.getAudioTracks()[0];
        console.info(
          `[videocall] doorbell audio probe: track=${t ? `${t.readyState}${t.muted ? "/no-rtp" : "/flowing"}` : "NONE"}; ${rtp}`
        );
      }, 2500);
      this._timers.add(iv); // clearTimeout in teardown also clears intervals
    }

    _startWatchdog() {
      this._lastBytes = 0; this._lastBytesAt = Date.now();
      this._watchdog = setInterval(async () => {
        if (!this.pc || this.state !== "active") return;
        try {
          const stats = await this.pc.getStats();
          let bytes = 0;
          stats.forEach((r) => {
            if (r.type === "inbound-rtp") bytes += r.bytesReceived || 0;
            if (r.type === "outbound-rtp") bytes += r.bytesSent || 0;
          });
          const now = Date.now();
          if (bytes > this._lastBytes) { this._lastBytes = bytes; this._lastBytesAt = now; }
          else if (now - this._lastBytesAt >= MEDIA_STALL_MS) this.fail("media stalled");
        } catch {}
      }, STATS_INTERVAL_MS);
    }

    // ---- signaling handlers (driven by VideoCallCore) --------------------

    /** caller: server said an endpoint accepted → gUM, offer (SPEC §5.4 step 4) */
    async onAccepted(peerInfo) {
      if (this.state !== "ringing_out") return;
      this.peer = peerInfo;
      this._setState("connecting");
      try {
        await this._getMedia();
        const pc = this._createPc();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer); // trickle: send immediately, no gather wait
        await this.core._send("videocall/offer", {
          call_id: this.callId, client_id: this.core.clientId, sdp: pc.localDescription.sdp,
        });
        this._armGuard(SIGNALING_TIMEOUT_MS, "awaiting answer");
      } catch (e) { this.fail(String(e)); }
    }

    /** callee: user tapped Accept (the gesture) → accept + gUM, await offer.
     *  Also the cold-start join path: a session built from a notification
     *  deep link never saw the ring event — peer/media come from the result. */
    async accept() {
      if (this.state !== "ringing_in") return;
      this._setState("connecting");
      try {
        const res = await this.core._send("videocall/accept", {
          call_id: this.callId, client_id: this.core.clientId,
        });
        this.peer = res?.caller || this.peer;
        if (res?.media && res.media !== this.media) {
          this.media = res.media;
          this.camEnabled = this.media === "video";
        }
        // DOORBELL: no peer to exchange SDP with — connect straight to go2rtc.
        if (res?.doorbell || this.isDoorbell) {
          this.doorbell = res?.doorbell || this.doorbell;
          this.isDoorbell = true;
          this.camEnabled = false;
          await this._connectDoorbell();
          return;
        }
        await this._getMedia();
        // the caller's offer may have raced our (slow) media acquisition —
        // process it now instead of waiting for one that already arrived
        if (this._pendingOffer) {
          const sdp = this._pendingOffer;
          this._pendingOffer = null;
          await this.onOffer(sdp);
        } else {
          this._armGuard(SIGNALING_TIMEOUT_MS, "awaiting offer");
        }
      } catch (e) {
        // deep-link join on a dead/answered call is a normal outcome, not an error
        const code = e?.code;
        if (code === "unknown_call") this._teardown("call already ended");
        else if (code === "too_late") this._teardown("answered elsewhere");
        else this.fail(String(e?.message || code || e));
      }
    }

    async onOffer(sdp) {
      if (this.role !== "callee" || this.state !== "connecting") return;
      // OFFER/MEDIA RACE (the "android calls permanently broken" bug): on
      // WHIP-publishing tablets the camera-release settle + retry ladder
      // makes local media take seconds, while a fast caller sends its offer
      // almost immediately after auto-accept. Handling the offer before
      // localStream exists crashed _createPc on null → every call failed.
      // Buffer it; accept() processes it the moment media lands.
      if (!this.localStream) { this._pendingOffer = sdp; return; }
      try {
        this._clearGuard();
        const pc = this._createPc();
        await pc.setRemoteDescription({ type: "offer", sdp });
        await this._drainCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.core._send("videocall/answer", {
          call_id: this.callId, client_id: this.core.clientId, sdp: pc.localDescription.sdp,
        });
        this._armGuard(ICE_TIMEOUT_MS, "ice connect");
      } catch (e) { this.fail(String(e)); }
    }

    async onAnswer(sdp) {
      if (this.role !== "caller" || !this.pc || this.state !== "connecting") return;
      try {
        this._clearGuard();
        await this.pc.setRemoteDescription({ type: "answer", sdp });
        await this._drainCandidates();
        this._armGuard(ICE_TIMEOUT_MS, "ice connect");
      } catch (e) { this.fail(String(e)); }
    }

    // candidates can arrive before setRemoteDescription — queue them
    _pendingCandidates = [];
    // an offer can arrive before local media is acquired — buffered (see onOffer)
    _pendingOffer = null;
    async onCandidate(candidate) {
      if (!this.pc || !this.pc.remoteDescription) { this._pendingCandidates.push(candidate); return; }
      try { await this.pc.addIceCandidate(candidate ?? undefined); } catch {}
    }
    async _drainCandidates() {
      const q = this._pendingCandidates.splice(0);
      for (const c of q) { try { await this.pc.addIceCandidate(c ?? undefined); } catch {} }
    }

    // ---- user controls ----------------------------------------------------

    toggleMic() {
      this.micEnabled = !this.micEnabled;
      this.localStream?.getAudioTracks().forEach((t) => (t.enabled = this.micEnabled));
      this._emit("controls");
    }
    /** Push-to-talk (doorbell half-duplex): transmit mic only while held, and
     *  mute our own speaker while talking so the door's delayed echo of our
     *  own voice is never heard (browser AEC can't cancel that remote loop). */
    setTalk(on) {
      if (!this.pushToTalk) return;
      this.talking = !!on;
      this.micEnabled = !!on;
      this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !!on));
      this._emit("talk", !!on);
      this._emit("controls");
    }
    toggleCam() {
      this.camEnabled = !this.camEnabled;
      this.localStream?.getVideoTracks().forEach((t) => (t.enabled = this.camEnabled));
      this._emit("controls");
    }

    async decline() {
      if (this.state !== "ringing_in") return;
      this.core._send("videocall/decline", {
        call_id: this.callId, client_id: this.core.clientId,
      }).catch(noop);
      this._teardown("declined");
    }
    async cancel() {
      if (this.state !== "ringing_out") return;
      this.core._send("videocall/cancel", { call_id: this.callId }).catch(noop);
      this._teardown("caller_cancel");
    }
    async hangup() {
      this.core._send("videocall/hangup", { call_id: this.callId, reason: "hangup" }).catch(noop);
      this._teardown("hangup");
    }
    async fail(reason) {
      // ICE-failure triage: log what candidate types each side produced. No
      // relay candidates + srflx-only pairing failure = NAT needs a TURN
      // server (Video Call options → ICE servers). SPEC §12 troubleshooting.
      if (/ice|connection/.test(reason) && this.pc) {
        try {
          const stats = await this.pc.getStats();
          const counts = { local: {}, remote: {} };
          stats.forEach((r) => {
            if (r.type === "local-candidate")
              counts.local[r.candidateType] = (counts.local[r.candidateType] || 0) + 1;
            if (r.type === "remote-candidate")
              counts.remote[r.candidateType] = (counts.remote[r.candidateType] || 0) + 1;
          });
          console.warn(
            `[videocall] media path failed (${reason}); candidates local=%o remote=%o — ` +
            "no host pairing + no relay usually means NAT/AP-isolation: configure a TURN server",
            counts.local, counts.remote,
          );
        } catch {}
      }
      this.core._send("videocall/hangup", { call_id: this.callId, reason: "error" }).catch(noop);
      this._teardown("error: " + reason);
    }
    /** remote/server ended it (hangup/ring_cancel event) */
    onRemoteEnd(reason) { this._teardown(reason); }

    _teardown(reason) {
      if (this.state === "ended") return;
      this.endReason = reason;
      this._timers.forEach(clearTimeout); this._timers.clear();
      if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
      try { this._g2r?.close(); } catch {}   // doorbell go2rtc WS signaling
      this._g2r = null;
      try { this._talkG2r?.close(); } catch {}   // two-stream mic backchannel WS
      this._talkG2r = null;
      try { this.talkPc?.close(); } catch {}
      this.talkPc = null;
      try { this.pc?.close(); } catch {}
      this.pc = null;
      // NEVER hold the camera after the call (whip-card stop semantics)
      try { this.localStream?.getTracks().forEach((t) => t.stop()); } catch {}
      this.localStream = null;
      this._setState("ended");
      CameraCoord.scheduleRelease(); // debounced — a new call cancels it (SPEC §9.4)
      this.core._sessionEnded(this);
    }
  }

  // ==========================================================================
  // VideoCallCore — headless singleton (SPEC §9.1)
  // ==========================================================================
  class VideoCallCoreImpl {
    constructor() {
      this.clientId = safeStorage.get(LS_CLIENT_ID) ||
        (() => { const id = uuid(); safeStorage.set(LS_CLIENT_ID, id); return id; })();
      this.conn = null;
      this.registered = false;
      this.options = {};
      this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
      this.ringTimeout = 30;
      this.rosterCache = { endpoints: [], areas: [], persons: [] };
      this.session = null;             // the single CallSession (or null)
      this.events = new EventTarget();
      this._handledDeepLinks = new Set();
      // device-owned drop-in consent (SPEC §5.4a): null=follow default,
      // []=nobody, [user_id…]=only those callers may drop in HERE
      this.dropInAllow = (() => {
        try {
          const v = JSON.parse(safeStorage.get("vcall:dropin_allow") || "null");
          return Array.isArray(v) ? v : null;
        } catch { return null; }
      })();
      // The HA frontend is an SPA and the companion app RESUMES it — the deep
      // link must be re-checked on every navigation/foreground, not only at
      // resource load (an iOS Answer tap on a warm app changes the URL without
      // re-running this module).
      window.addEventListener("location-changed", () => this._maybeDeepLinkAnswer());
      window.addEventListener("popstate", () => this._maybeDeepLinkAnswer());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this._maybeDeepLinkAnswer();
      });
      this._boot();
    }

    on(type, cb) {
      const h = (e) => cb(e.detail);
      this.events.addEventListener(type, h);
      return () => this.events.removeEventListener(type, h);
    }
    _emit(type, detail) { this.events.dispatchEvent(new CustomEvent(type, { detail })); }

    async _boot() {
      try {
        // HA frontend exposes window.hassConnection = Promise<{conn, auth}>
        const hc = await (window.hassConnection || topWindow.hassConnection);
        if (!hc?.conn) throw new Error("no hassConnection");
        this.conn = hc.conn;
        this.conn.addEventListener("ready", () => this._register().catch(noop)); // reconnects
        this.conn.addEventListener("disconnected", () => {
          this.registered = false;
          this._emit("status", "reconnecting…");
        });
        // iOS suspends the app when idle; on resume the socket can come back
        // stale/zombie and the pushed-event subscription is silently dropped, so
        // a call sets up but the accept/offer/candidate events never arrive and
        // video never streams — only a full app restart cures it. Re-register on
        // return to foreground AFTER a real idle gap — but NEVER during a live
        // call: _register()'s unsubscribe fires the server on_close, which would
        // end the call and hang up the peer. A genuinely dead socket is still
        // recovered by the conn "disconnected"→"ready" listener above.
        let hiddenAt = Date.now();
        const vdoc = topWindow.document;
        vdoc.addEventListener("visibilitychange", () => {
          if (vdoc.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
          if (Date.now() - hiddenAt <= 4000) return;          // brief switch, skip
          if (this.session && this.session.state !== "ended") return; // don't disturb a live call
          this._register().catch(noop);
        });
        await this._register();
      } catch (e) {
        console.warn("[videocall] core boot failed (not an HA frontend?):", e);
      }
    }

    async _send(type, payload = {}) {
      if (!this.conn) throw new Error("not connected");
      return await this.conn.sendMessagePromise({ type, ...payload });
    }

    async _register() {
      // ONE live registration at a time: tear down the previous subscription
      // first, and let OUR 'ready' listener be the only re-register path
      // (resubscribe: false). Two concurrent registrations for the same
      // client_id race their server-side close callbacks — the stale one used
      // to mark a live tablet offline.
      try { await this._unsub?.(); } catch {}
      this._unsub = null;
      const browserModId = safeStorage.get("browser_mod-browser-id") || undefined;
      this._unsub = await this.conn.subscribeMessage(
        (evt) => this._onEvent(evt),
        {
          type: "videocall/register",
          client_id: this.clientId,
          ua_kind: uaKind(),
          ua_hint: uaHint(),
          browser_hint: browserHint(),
          browser_mod_id: browserModId,
          drop_in_allow: this.dropInAllow,
        },
        { resubscribe: false },
      );
      // TODO(M1): capture the register RESULT (ice_servers/ring_timeout/
      // allow_drop_in) instead of relying on defaults — split
      // register/subscribe or read the command result from the collection.
      this.registered = true;
      await this.refreshRoster().catch(noop);
      this._emit("status", "registered");
      this._maybeDeepLinkAnswer();
    }

    async refreshRoster() {
      this._applyRoster(await this._send("videocall/roster"));
      return this.rosterCache;
    }

    /** Set THIS device's drop-in consent: null=default, []=nobody, [ids…]=only. */
    async setDropInAllow(list) {
      this.dropInAllow = Array.isArray(list) ? list : null;
      try {
        if (this.dropInAllow === null) localStorage.removeItem("vcall:dropin_allow");
        else safeStorage.set("vcall:dropin_allow", JSON.stringify(this.dropInAllow));
      } catch {}
      await this._register().catch(noop); // declare the new consent to the server
    }

    _applyRoster(r) {
      this.rosterCache = r;
      // entry options ride along on every roster (SPEC §5.1) — this is how a
      // configured TURN server actually reaches clients
      const cfg = r?.config;
      if (cfg) {
        if (Array.isArray(cfg.ice_servers) && cfg.ice_servers.length) this.iceServers = cfg.ice_servers;
        if (cfg.ring_timeout) this.ringTimeout = cfg.ring_timeout;
        this.options = { ...this.options, allow_drop_in: cfg.allow_drop_in !== false };
      }
      this._emit("roster", r);
    }

    _onEvent(evt) {
      const t = evt.event_type;
      const s = this.session;
      switch (t) {
        case "roster":
          this._applyRoster(evt);
          break;
        case "ring": {
          if (s && s.state !== "ended") {
            // busy: server-side guard should prevent this; decline defensively
            this._send("videocall/decline", { call_id: evt.call_id, client_id: this.clientId }).catch(noop);
            break;
          }
          this.session = new CallSession(this, {
            callId: evt.call_id, role: "callee", media: evt.media, peer: evt.caller,
            doorbell: evt.doorbell,   // set → answering connects to go2rtc (§14)
          });
          this._emit("session", this.session);
          if (evt.drop_in && uaKind() !== "companion-ios") {
            // drop-in: skip ring UI, auto-answer (SPEC §5.4a). Server enforces
            // consent; kiosks/Android tablets have persistent gUM permission
            // so accept() proceeds without a gesture. iOS companions fall
            // through to a normal ring — WKWebView requires a user gesture
            // for getUserMedia, so gestureless auto-accept would gUM-fail.
            VideocallOverlay.instance().showDropIn(this.session);
            this.session.accept();
          } else {
            VideocallOverlay.instance().showRing(this.session);
          }
          break;
        }
        case "ring_cancel":
          if (s && s.callId === evt.call_id) s.onRemoteEnd(evt.reason || "ring_cancel");
          break;
        case "accepted":
          if (s && s.callId === evt.call_id) s.onAccepted(evt.peer);
          break;
        case "offer":
          if (s && s.callId === evt.call_id) s.onOffer(evt.sdp);
          break;
        case "answer":
          if (s && s.callId === evt.call_id) s.onAnswer(evt.sdp);
          break;
        case "candidate":
          if (s && s.callId === evt.call_id) s.onCandidate(evt.candidate);
          break;
        case "hangup":
          if (s && s.callId === evt.call_id) s.onRemoteEnd(evt.reason || "hangup");
          break;
        default:
          break;
      }
    }

    /** Place a call. target: {type:'endpoint'|'area'|'person'|'mobile'|'all', id}
     *  dropIn: auto-answer on the target (browsers only; phones still ring).
     *  label: human-readable target name for the outgoing-call UI. */
    async invite(target, media = "video", dropIn = false, label = "", _redial = false) {
      if (this.session && this.session.state !== "ended") throw new Error("already in a call");
      if (!_redial) this._redialUsed = false; // user-initiated call resets the budget
      this._lastInvite = { target, media, dropIn, label };
      const callId = uuid();
      this.session = new CallSession(this, { callId, role: "caller", media });
      this.session.targetLabel = label;
      this._emit("session", this.session);
      // call UI is ALWAYS the floating overlay, never constrained to a card
      VideocallOverlay.instance().showOutgoing(this.session);
      const payload = {
        call_id: callId, caller_client_id: this.clientId, target, media,
        drop_in: !!dropIn,
      };
      try {
        try {
          await this._send("videocall/invite", payload);
        } catch (e) {
          // SELF-HEAL: the server may have lost our registration (HA restart,
          // superseded connection) while we still think we're online —
          // re-register and retry once before surfacing a failure.
          if (e?.code !== "not_registered") throw e;
          await this._register();
          await this._send("videocall/invite", payload);
        }
      } catch (e) {
        this.session._teardown("invite failed: " + (e?.message || e?.code || e));
        throw e;
      }
      return this.session;
    }

    /** View + talk to a doorbell/intercom on demand (SPEC §14). No ring and no
     *  second party — the door "answers" immediately (it's a live go2rtc
     *  stream). doorbell: {id?, name, webrtc_url, stream, token?}. */
    async callDoorbell(doorbell, media = "video") {
      if (this.session && this.session.state !== "ended") throw new Error("already in a call");
      if (!doorbell?.webrtc_url || !doorbell?.stream) throw new Error("doorbell needs webrtc_url + stream");
      const callId = uuid();
      const peer = { name: doorbell.name || "Doorbell", kind: "doorbell" };
      const s = new CallSession(this, { callId, role: "caller", media, peer, doorbell });
      s.targetLabel = peer.name;
      this.session = s;
      this._emit("session", s);
      VideocallOverlay.instance().showDoorbell(s); // straight to call UI, no ring
      s._setState("connecting");
      s._connectDoorbell();
      return s;
    }

    _sessionEnded(session) {
      if (this.session === session) {
        this._emit("session", session); // ended state notification
        // keep the ended session referenced briefly for UI "call ended" display
        setTimeout(() => { if (this.session === session) { this.session = null; this._emit("session", null); } }, 2000);
      }
      // AUTO-REDIAL (once): Android endpoints waking from doze/Wi-Fi
      // power-save routinely fail the FIRST media path and succeed on the
      // next attempt — retry a failed caller-side call silently instead of
      // making the user tap again. Only for error endings (never for
      // declined / timeout / deliberate hangups).
      if (
        session.role === "caller" &&
        !session.isDoorbell &&        // doorbell sessions have no _lastInvite target
        /^error/.test(session.endReason || "") &&
        !/invite failed/.test(session.endReason || "") &&
        this._lastInvite && !this._redialUsed
      ) {
        this._redialUsed = true;
        const li = this._lastInvite;
        setTimeout(() => {
          if (this.session && this.session.state !== "ended") return;
          this._emit("status", "connection failed — retrying…");
          this.invite(li.target, li.media, li.dropIn, li.label, true).catch(noop);
        }, 800);
      }
    }

    _maybeDeepLinkAnswer() {
      // mobile Answer deep link: ?vcall_answer=<call_id> (SPEC §7.2)
      let callId = null;
      try { callId = new URLSearchParams(location.search).get(DEEP_LINK_PARAM); } catch {}
      if (!callId && topWindow !== window) {
        try { callId = new URLSearchParams(topWindow.location.search).get(DEEP_LINK_PARAM); } catch {}
      }
      if (!callId || this._handledDeepLinks.has(callId)) return;
      if (!this.registered) return; // _register() re-invokes us once subscribed
      this._handledDeepLinks.add(callId);

      // iOS WKWebView requires a USER GESTURE for getUserMedia — an
      // auto-accept would gUM-fail. On iOS the server's late ring delivery
      // (pushed right after our register, SPEC §7.2) shows the full-screen
      // ring UI and the Answer tap is the gesture. Android auto-accepts.
      const autoAccept = uaKind() !== "companion-ios";

      const handleRing = () => {
        const s = this.session;
        if (s && s.callId === callId && s.state === "ringing_in") {
          if (autoAccept) s.accept();
          // else: the ring overlay is already showing — Answer tap connects
          return true;
        }
        return false;
      };
      if (handleRing()) return;
      if (this.session && this.session.state !== "ended") return; // in another call

      // The (late) ring usually lands within moments of registering — wait
      // for it so we get caller identity + a gesture path on iOS.
      const unsub = this.on("session", () => { if (handleRing()) unsub(); });
      setTimeout(() => {
        unsub();
        // Last resort (no ring arrived — e.g. call rung browsers only):
        // direct cold-start join. Android only: iOS would gUM-fail without
        // a gesture, and its ring is guaranteed by late delivery anyway.
        const s = this.session;
        if (!autoAccept || (s && s.state !== "ended")) return;
        const session = new CallSession(this, { callId, role: "callee", media: "video" });
        this.session = session;
        this._emit("session", session);
        VideocallOverlay.instance().showJoining(session);
        session.accept();
      }, 2500);
    }
  }

  // ==========================================================================
  // <videocall-overlay> — ring + fallback call UI singleton (SPEC §9.3)
  // ==========================================================================
  class VideocallOverlay extends HTMLElement {
    static _instance = null;
    static instance() {
      let el = VideocallOverlay._instance;
      if (!el || !el.isConnected) {
        el = topWindow.document.createElement("videocall-overlay");
        topWindow.document.body.appendChild(el);
        VideocallOverlay._instance = el;
      }
      return el;
    }

    connectedCallback() {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: "open" });
      // Floating call UI: always on top of EVERYTHING (topWindow body,
      // z-index above HA dialogs), never constrained to a card.
      this.shadowRoot.innerHTML = `
<style>
:host{position:fixed;inset:0;z-index:100000;display:none;font:15px system-ui,sans-serif;color:#fff}
:host([open]){display:block}
.bg{position:absolute;inset:0;background:rgba(10,12,16,.92)}
.panel{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
.caller{font-size:28px;font-weight:650;text-align:center;padding:0 16px}
.sub{opacity:.7;font-size:17px}
.btns{display:flex;gap:34px;margin-top:16px}
button{border:0;border-radius:50%;cursor:pointer;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.accept,.decline{width:92px;height:92px;font-size:38px}
.accept{background:#1db954}.decline{background:#d33}
.ctrl{background:#3a3f47;width:72px;height:72px;font-size:28px}
.ctrl.off{background:#a33}
.ctrl .lbl{font-size:10px;opacity:.85;line-height:1}
.ctrl.hang{background:#d33}
video{background:#000;border-radius:12px}
#remote{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;border-radius:0}
#local{position:absolute;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(130px + env(safe-area-inset-bottom,0px));width:26vw;max-width:240px;height:auto;object-fit:cover;z-index:2;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,.5);cursor:grab;touch-action:none}
.callui{display:none;position:absolute;inset:0}
.callui .bar{position:absolute;bottom:calc(26px + env(safe-area-inset-bottom,0px));left:0;right:0;display:flex;justify-content:center;gap:22px;z-index:3;transition:opacity .3s,transform .3s}
.dur{position:absolute;top:calc(18px + env(safe-area-inset-top,0px));left:0;right:0;text-align:center;opacity:.85;z-index:3;font-size:17px;transition:opacity .3s}
/* FaceTime-style on phone-sized screens: remote video fills the ENTIRE
   screen (cover, no letterbox); controls auto-hide and reappear on tap. */
@media (max-width:800px){ #remote{object-fit:cover} }
.callui.chrome-hidden .bar{opacity:0;transform:translateY(12px);pointer-events:none}
.callui.chrome-hidden .dur{opacity:0}
/* Minimized: the call shrinks to a floating tile (remote video only); the
   page underneath is fully usable. Tap the tile to restore. Outgoing video
   is turned OFF while minimized (privacy + bandwidth) and restored after. */
:host(.mini){inset:auto;right:calc(14px + env(safe-area-inset-right,0px));bottom:calc(14px + env(safe-area-inset-bottom,0px));width:200px;height:140px;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.55);cursor:grab;touch-action:none}
:host(.mini) .bg{display:none}
:host(.mini) .bar,:host(.mini) .dur,:host(.mini) #local{display:none!important}
:host(.mini) #remote{object-fit:cover}
.hidden{display:none!important}
</style>
<div class="bg"></div>
<div class="panel" id="ring">
  <div class="caller" id="rcaller">…</div>
  <div class="sub" id="rsub">Incoming video call</div>
  <div class="btns">
    <button class="accept" id="raccept" title="Answer">✆</button>
    <button class="decline" id="rdecline" title="Decline">✕</button>
  </div>
</div>
<div class="panel hidden" id="out">
  <div class="caller" id="otarget">…</div>
  <div class="sub">Calling…</div>
  <div class="btns">
    <button class="decline" id="ocancel" title="Cancel">✕</button>
  </div>
</div>
<div class="panel hidden" id="toastp">
  <div class="sub" id="toastmsg"></div>
</div>
<div class="callui" id="callui">
  <video id="remote" autoplay playsinline></video>
  <video id="local" autoplay playsinline muted title="Tap to flip camera · drag to move"></video>
  <!-- dedicated remote-audio sink: a <video> element plays WebRTC audio
       unreliably (esp. iOS); the door's audio is routed here for doorbell
       calls while #remote stays muted (video only) to avoid double audio -->
  <audio id="rvoice" autoplay playsinline></audio>
  <div class="dur" id="dur"></div>
  <div class="bar">
    <button class="ctrl" id="minb" title="Minimize call"><span>⇲</span><span class="lbl">Minimize</span></button>
    <button class="ctrl" id="mic" title="Mute microphone"><span id="micico">🎙</span><span class="lbl" id="miclbl">Mute</span></button>
    <button class="ctrl" id="cam" title="Turn off camera"><span id="camico">🎥</span><span class="lbl" id="camlbl">Video off</span></button>
    <button class="ctrl hang" id="hang" title="Hang up">✕</button>
  </div>
</div>`;
      const $ = (id) => this.shadowRoot.getElementById(id);
      $("raccept").onclick = () => this._session?.accept();
      $("rdecline").onclick = () => this._session?.decline();
      $("ocancel").onclick = () => this._session?.cancel();
      $("hang").onclick = () => this._session?.hangup();
      // mic button: a plain mute TOGGLE normally; a push-to-talk HOLD for a
      // half-duplex doorbell (pointer capture keeps transmitting if the finger
      // slides off the button; release/cancel stops).
      const micBtn = $("mic");
      micBtn.onclick = () => { const s = this._session; if (s && !s.pushToTalk) s.toggleMic(); };
      const talkOn = (e) => {
        const s = this._session;
        if (!s?.pushToTalk) return;
        e.preventDefault();
        try { micBtn.setPointerCapture(e.pointerId); } catch {}
        s.setTalk(true);
      };
      const talkOff = (e) => {
        const s = this._session;
        if (!s?.pushToTalk) return;
        e.preventDefault();
        try { micBtn.releasePointerCapture(e.pointerId); } catch {}
        s.setTalk(false);
      };
      micBtn.addEventListener("pointerdown", talkOn);
      micBtn.addEventListener("pointerup", talkOff);
      micBtn.addEventListener("pointercancel", talkOff);
      $("cam").onclick = () => this._session?.toggleCam();
      // self-view PiP: a clean TAP flips the camera (poor-man's reverse cam);
      // a DRAG moves the window. Movement past a small slop = drag (suppress the
      // flip); pointer-capture keeps the drag smooth if the finger leaves the box.
      const lv = $("local");
      let dsx, dsy, dox, doy, dMoved = false, dActive = false;
      lv.addEventListener("pointerdown", (e) => {
        if (this.classList.contains("mini")) return;
        dActive = true; dMoved = false;
        dsx = e.clientX; dsy = e.clientY;
        const r = lv.getBoundingClientRect(); dox = r.left; doy = r.top;
        try { lv.setPointerCapture(e.pointerId); } catch {}
        e.stopPropagation();                     // don't toggle call chrome
      });
      lv.addEventListener("pointermove", (e) => {
        if (!dActive) return;
        const dx = e.clientX - dsx, dy = e.clientY - dsy;
        if (!dMoved && Math.hypot(dx, dy) < 6) return;   // still within tap slop
        dMoved = true;
        lv.style.cursor = "grabbing";
        const left = Math.min(Math.max(0, dox + dx), topWindow.innerWidth - lv.offsetWidth);
        const top = Math.min(Math.max(0, doy + dy), topWindow.innerHeight - lv.offsetHeight);
        lv.style.left = left + "px"; lv.style.top = top + "px";
        lv.style.right = "auto"; lv.style.bottom = "auto";
      });
      const dEnd = (e) => {
        if (!dActive) return;
        dActive = false;
        lv.style.cursor = "grab";
        try { lv.releasePointerCapture(e.pointerId); } catch {}
        if (!dMoved) this._session?.cycleCamera();       // clean tap = flip camera
      };
      lv.addEventListener("pointerup", dEnd);
      lv.addEventListener("pointercancel", dEnd);
      $("minb").onclick = (e) => { e.stopPropagation(); this._setMini(true); };
      // Minimized tile: a clean TAP restores the full-screen call; a DRAG moves
      // the tile out of the way. Inline left/top set here are cleared on restore
      // (in _setMini) so the restored full-screen UI keeps its inset:0.
      let msx, msy, mox, moy, mMoved = false, mActive = false;
      this.addEventListener("pointerdown", (e) => {
        if (!this.classList.contains("mini")) return;
        mActive = true; mMoved = false;
        msx = e.clientX; msy = e.clientY;
        const r = this.getBoundingClientRect(); mox = r.left; moy = r.top;
        try { this.setPointerCapture(e.pointerId); } catch {}
      });
      this.addEventListener("pointermove", (e) => {
        if (!mActive) return;
        const dx = e.clientX - msx, dy = e.clientY - msy;
        if (!mMoved && Math.hypot(dx, dy) < 6) return;   // still within tap slop
        mMoved = true; this.style.cursor = "grabbing";
        const left = Math.min(Math.max(0, mox + dx), topWindow.innerWidth - this.offsetWidth);
        const top = Math.min(Math.max(0, moy + dy), topWindow.innerHeight - this.offsetHeight);
        this.style.left = left + "px"; this.style.top = top + "px";
        this.style.right = "auto"; this.style.bottom = "auto";
      });
      const mEnd = (e) => {
        if (!mActive) return;
        mActive = false; this.style.cursor = "grab";
        try { this.releasePointerCapture(e.pointerId); } catch {}
        if (!mMoved) this._setMini(false);   // clean tap = restore the call
      };
      this.addEventListener("pointerup", mEnd);
      this.addEventListener("pointercancel", mEnd);

      // FaceTime-style chrome: controls fade after 4s in-call; tapping the
      // video brings them back (and taps on the bar itself re-arm the timer).
      const callui = $("callui");
      callui.addEventListener("pointerdown", (e) => {
        if (this.classList.contains("mini")) return;
        if (e.target === $("remote") && !callui.classList.contains("chrome-hidden")) {
          callui.classList.add("chrome-hidden");   // tap video → hide chrome
        } else {
          callui.classList.remove("chrome-hidden"); // any other tap → show
          this._armChromeTimer();
        }
      });
    }

    /** Minimize ↔ restore. Outgoing video is OFF while minimized; its prior
     *  state is restored on un-minimize. Mic is untouched. */
    _setMini(on) {
      const s = this._session;
      if (on) {
        if (!s || (s.state !== "active" && s.state !== "connecting")) return;
        this._videoWasOn = !!s.camEnabled;
        if (s.camEnabled) s.toggleCam();
        this.classList.add("mini");
      } else {
        this.classList.remove("mini");
        // drop any drag offset from the tile so full-screen reverts to inset:0
        this.style.left = this.style.top = this.style.right = this.style.bottom = this.style.cursor = "";
        if (this._videoWasOn && s && s.state !== "ended" && !s.camEnabled) s.toggleCam();
        this._videoWasOn = false;
        this._armChromeTimer();
      }
    }

    _armChromeTimer() {
      clearTimeout(this._chromeTimer);
      this._chromeTimer = setTimeout(() => {
        const callui = this.shadowRoot.getElementById("callui");
        if (this._session?.state === "active") callui.classList.add("chrome-hidden");
      }, 4000);
    }

    _showPanel(which) {
      const $ = (id) => this.shadowRoot.getElementById(id);
      for (const p of ["ring", "out", "toastp"]) $(p).classList.toggle("hidden", p !== which);
      $("callui").style.display = which === "callui" ? "block" : "none";
      if (which) this.setAttribute("open", ""); else this.removeAttribute("open");
    }

    _toast(msg, ms = 2500) {
      const $ = (id) => this.shadowRoot.getElementById(id);
      $("toastmsg").textContent = msg;
      this._showPanel("toastp");
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        // only close if nothing else took over the overlay meanwhile
        if (!$("toastp").classList.contains("hidden")) this._showPanel(null);
      }, ms);
    }

    // WebAudio ringtone — no asset files (SPEC §9.3). TODO(M3): nicer pattern,
    // per-browser mute toggle persisted in-memory only.
    _startTone() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this._toneCtx = ctx;
        const ring = () => {
          if (!this._toneCtx) return;
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = 880; g.gain.value = 0.08;
          o.connect(g).connect(ctx.destination);
          o.start(); o.stop(ctx.currentTime + 0.9);
          this._toneTimer = setTimeout(ring, 2500);
        };
        ring();
      } catch {}
    }
    _stopTone() {
      clearTimeout(this._toneTimer);
      try { this._toneCtx?.close(); } catch {}
      this._toneCtx = null;
    }

    showRing(session) {
      this._bind(session);
      const $ = (id) => this.shadowRoot.getElementById(id);
      // "Mark (browser fc9b61)" — who is calling, not just the endpoint
      $("rcaller").textContent = epLabel(session.peer);
      $("rsub").textContent = session.isDoorbell
        ? "🔔 At the door" : `Incoming ${session.media} call`;
      this._showPanel("ring");
      this._startTone();
    }

    /** Caller side: floating "Calling …" panel with cancel. */
    showOutgoing(session) {
      this._bind(session);
      const $ = (id) => this.shadowRoot.getElementById(id);
      $("otarget").textContent = session.targetLabel || "…";
      this._showPanel("out");
    }

    /** Drop-in: no ring screen/ringtone — single chime + straight to call UI. */
    showDropIn(session) {
      this._bind(session);
      const $ = (id) => this.shadowRoot.getElementById(id);
      $("dur").textContent = `${epLabel(session.peer)} dropped in`;
      this._showPanel("callui");
      this._chime();
    }

    /** Cold-start deep-link join: no ring UI — straight to the connecting call. */
    showJoining(session) {
      this._bind(session);
      const $ = (id) => this.shadowRoot.getElementById(id);
      $("dur").textContent = "Joining call…";
      this._showPanel("callui");
    }

    /** Doorbell view/answer (SPEC §14): no ring UI — straight to the intercom. */
    showDoorbell(session) {
      this._bind(session);
      const $ = (id) => this.shadowRoot.getElementById(id);
      $("dur").textContent = `Connecting to ${session.targetLabel || session.peer?.name || "door"}…`;
      this._showPanel("callui");
    }

    _chime() {
      // one short attention beep (not the repeating ringtone)
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 660; g.gain.value = 0.08;
        o.connect(g).connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.35);
        setTimeout(() => { try { ctx.close(); } catch {} }, 600);
      } catch {}
    }

    _bind(session) {
      this._unbind?.();
      this._session = session;
      // every call starts full-screen at inset:0 — clear any mini-drag offset
      // left on the host by a previous (dragged-then-ended) call
      this.style.left = this.style.top = this.style.right = this.style.bottom = this.style.cursor = "";
      const $ = (id) => this.shadowRoot.getElementById(id);
      $("dur").textContent = "";     // reset the call timer/label for the new call
      // a doorbell intercom sends no outgoing video — hide the camera toggle
      $("cam").style.display = session.isDoorbell ? "none" : "";
      // babycam lesson: open on an instant still (the browser shows the poster
      // until real frames decode, then auto-hides it) so the door isn't black
      // while go2rtc connects. Cleared for non-doorbell calls.
      $("remote").poster = session.doorbell?.poster || "";
      // doorbell audio plays via the dedicated #rvoice sink, so keep #remote
      // (video) muted for doorbell; normal calls play audio on #remote.
      $("remote").muted = !!session.isDoorbell;
      $("rvoice").srcObject = null;
      $("rvoice").muted = false;
      $("rvoice")._vcTrackId = null;
      // reset the self-view PiP to its default corner each call (its drag offset
      // otherwise persists across calls and its clamp goes stale on rotate)
      const _lv = $("local");
      _lv.style.left = _lv.style.top = _lv.style.right = _lv.style.bottom = _lv.style.cursor = "";
      const subs = [];

      // Local PiP: shown ONLY while outgoing video actually flows — camera off
      // or audio-only means NO box at all, just the remote video.
      const refreshLocalPip = () => {
        const hasVideo = !!session.localStream?.getVideoTracks().some((t) => t.readyState === "live");
        $("local").classList.toggle("hidden", !hasVideo || !session.camEnabled);
      };
      const onState = (e) => {
        const s = e.detail;
        if (s === "connecting" || s === "active") {
          this._stopTone();
          this._showPanel("callui"); // overlay ALWAYS hosts the call UI
          refreshLocalPip();
          if (s === "active") { this._startDurTimer(); this._armChromeTimer(); }
        } else if (s === "ended") {
          this._stopTone();
          this._stopDurTimer();
          clearTimeout(this._chromeTimer);
          this.classList.remove("mini");
          // a call that ended while the tile was dragged must not leave the host
          // offset — the ended-state toast / next call would render shifted
          this.style.left = this.style.top = this.style.right = this.style.bottom = this.style.cursor = "";
          this._videoWasOn = false;
          this.shadowRoot.getElementById("callui").classList.remove("chrome-hidden");
          // iOS media-session hygiene: fully release the (dead) MediaStreams —
          // video elements holding stale srcObjects keep WKWebView's media
          // pipeline engaged, which can starve OTHER players (babycam et al).
          $("remote").srcObject = null;
          $("local").srcObject = null;
          $("rvoice").srcObject = null;
          // Hangup closes IMMEDIATELY — no lingering status screen.
          // Exceptions that DO deserve a brief message: the caller's call was
          // declined, or the media path failed (a silent vanish after a black
          // "connected" screen is indistinguishable from a bug — say why).
          const reason = session.endReason || "";
          if (session.role === "caller" && /declined/.test(reason)) {
            this._toast("Call declined");
          } else if (/^error/.test(reason)) {
            // Simple, general failure — debug details go to the console/HA logs,
            // never to the user.
            this._toast("Couldn't connect the call.", 4000);
          } else {
            this._showPanel(null);
          }
          this._unbind?.();
        }
      };
      // explicit play() after srcObject: iOS WKWebView autoplay is unreliable
      // even with the attribute set (babycam-hardened lesson)
      const playSafe = (el) => { try { el.play?.().catch(noop); } catch {} };
      const onLocal = (e) => { $("local").srcObject = e.detail; playSafe($("local")); refreshLocalPip(); };
      const onRemote = (e) => {
        $("remote").srcObject = e.detail; playSafe($("remote"));
        // doorbell: play the door audio through the dedicated <audio> sink
        // (#remote stays muted, video only — no double audio). The sink gets an
        // AUDIO-ONLY stream, (re)attached only once the audio track actually
        // exists: attaching the mixed stream at first (video-only) ontrack left
        // the element wedged on a track it can't play — the silent-tab bug.
        // play() result is logged: NotAllowedError here = autoplay block.
        if (session.isDoorbell && e.detail) {
          const rv = $("rvoice");
          const at = e.detail.getAudioTracks();
          if (at.length && rv._vcTrackId !== at[0].id) {
            rv._vcTrackId = at[0].id;
            rv.srcObject = new MediaStream(at);
            rv.volume = 1;
            const p = rv.play?.();
            p?.then(() => console.info("[videocall] doorbell audio: playing"))
              .catch((err) => console.warn("[videocall] doorbell audio play FAILED:", err?.name || err));
          }
        }
      };
      const onControls = () => {
        if (session.pushToTalk) {
          // doorbell PTT: the mic button reads "Hold to talk" / "Talking…"
          $("mic").classList.toggle("off", session.talking); // red while transmitting
          $("micico").textContent = session.talking ? "🔴" : "🎤";
          $("miclbl").textContent = session.talking ? "Talking…" : "Hold to talk";
        } else {
          $("mic").classList.toggle("off", !session.micEnabled);
          $("micico").textContent = session.micEnabled ? "🎙" : "🔇";
          $("miclbl").textContent = session.micEnabled ? "Mute" : "Unmute";
        }
        $("cam").classList.toggle("off", !session.camEnabled);
        $("camico").textContent = session.camEnabled ? "🎥" : "🚫";
        $("camlbl").textContent = session.camEnabled ? "Video off" : "Video on";
        refreshLocalPip();
      };
      // half-duplex: mute our own speaker while transmitting so the door's
      // delayed echo of our voice isn't heard
      // half-duplex: silence our speaker (the door-audio sink) while transmitting
      const onTalk = (e) => { $("rvoice").muted = !!e.detail; };
      session.events.addEventListener("state", onState); subs.push(["state", onState]);
      session.events.addEventListener("localstream", onLocal); subs.push(["localstream", onLocal]);
      session.events.addEventListener("remotestream", onRemote); subs.push(["remotestream", onRemote]);
      session.events.addEventListener("controls", onControls); subs.push(["controls", onControls]);
      session.events.addEventListener("talk", onTalk); subs.push(["talk", onTalk]);
      onControls(); // initialize button faces for this session's media/controls
      this._unbind = () => { subs.forEach(([t, h]) => session.events.removeEventListener(t, h)); this._unbind = null; };
    }

    _startDurTimer() {
      const $ = (id) => this.shadowRoot.getElementById(id);
      this._durTimer = setInterval(() => {
        const s = this._session;
        if (!s?.startedAt) return;
        const d = Math.floor((Date.now() - s.startedAt) / 1000);
        $("dur").textContent = `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
      }, 1000);
    }
    _stopDurTimer() { clearInterval(this._durTimer); }
  }

  // ==========================================================================
  // <videocall-card> — Lovelace roster / call UI (SPEC §9.1 layer 4)
  // ==========================================================================
  class VideocallCard extends HTMLElement {
    // The card is a LAUNCHER only — the call itself always lives in the
    // floating <videocall-overlay> (on top of every element, never constrained
    // to the card).

    setConfig(config) { this._config = config || {}; }
    set hass(h) { this._hass = h; if (!this._booted) this._boot(); }
    getCardSize() { return 4; }
    static getConfigElement() { return document.createElement("videocall-card-editor"); }
    static getStubConfig() { return {}; }

    connectedCallback() {
      if (this._booted && !this._subs) this._subscribe();
    }
    disconnectedCallback() {
      this._subs?.forEach((u) => u()); this._subs = null;
    }

    _boot() {
      this._booted = true;
      this.attachShadow({ mode: "open" });
      // Touch targets: buttons ≥48px (wall-panel finger-friendly).
      this.shadowRoot.innerHTML = `
<style>
:host{display:block}
.wrap{padding:14px;font:14px system-ui,sans-serif;display:flex;flex-direction:column;gap:10px}
h3{margin:0;font-size:15px}
.grp{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
/* WIDTH FLOOR: min-width:0 let the select collapse to nothing next to the
   three call buttons on narrow (tablet) cards — the "empty dropdown on
   Android" bug. When space runs out, the BUTTON TRIO wraps below the
   dropdown as one unit (.btns3), never the buttons individually. */
.grp select{flex:1 1 160px;min-width:140px;min-height:48px;padding:8px 10px;border-radius:10px;border:1px solid var(--divider-color,#888);background:var(--card-background-color,#1e1e1e);color:var(--primary-text-color,#e1e1e1);color-scheme:dark light;font:inherit}
.grp .btns3{display:flex;gap:8px;flex:0 0 auto;margin-left:auto}
.callbtn{border:0;border-radius:12px;min-width:52px;min-height:48px;padding:8px 12px;cursor:pointer;background:var(--primary-color,#03a9f4);color:#fff;flex:0 0 auto;font-size:24px}
.callbtn.drop{background:#7b52ab}
.callbtn[disabled]{opacity:.3;cursor:default}
.status{font-size:12px;opacity:.75;min-height:14px}
.empty{opacity:.6;font-size:13px;padding:4px 10px}
.consent{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;opacity:.85;margin-top:8px;border-top:1px solid var(--divider-color,#8883);padding-top:10px}
.consent select{padding:6px 8px;border-radius:8px;border:1px solid var(--divider-color,#888);background:var(--card-background-color,#1e1e1e);color:var(--primary-text-color,#e1e1e1);color-scheme:dark light;font:inherit;font-size:12px}
/* Native <select> option popups don't inherit the control's colors — style
   them explicitly (with opaque fallbacks) so options stay legible on any
   theme; without this, a dark theme yields light text on the browser's
   default white popup = invisible. */
.grp select option,.consent select option{background:var(--card-background-color,#1e1e1e);color:var(--primary-text-color,#e1e1e1)}
.consent label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.hidden{display:none!important}
</style>
<ha-card>
  <div class="wrap">
    <h3>Video call</h3>
    <div class="status" id="status"></div>
    <div id="roster"></div>
    <div class="empty hidden" id="empty">No callable endpoints yet — open a dashboard on another device.</div>
    <div class="consent" id="consent">
      <span>⚡ Drop-in on this device:</span>
      <select id="cmode">
        <option value="default">Default</option>
        <option value="none">No one</option>
        <option value="custom">Only…</option>
      </select>
      <span id="cpeople" class="hidden"></span>
    </div>
  </div>
</ha-card>`;
      this._buildRoster();
      this._buildConsent();
      this._subscribe();
      window.VideoCallCore.refreshRoster().catch(noop);
      this._renderRoster();
      if (window.VideoCallCore.session) this._onSession(window.VideoCallCore.session);
    }

    // "Drop-in on this device" — device-owned consent (SPEC §5.4a). Stored in
    // THIS browser's localStorage and declared to the server at registration;
    // deliberately card-side, not integration config (household trust model).
    _buildConsent() {
      const core = window.VideoCallCore;
      const $ = (id) => this.shadowRoot.getElementById(id);
      const cmode = $("cmode"), cpeople = $("cpeople");
      const cur = core.dropInAllow;
      cmode.value = cur === null ? "default" : cur.length === 0 ? "none" : "custom";
      cpeople.classList.toggle("hidden", cmode.value !== "custom");

      const apply = () => {
        if (cmode.value === "default") core.setDropInAllow(null);
        else if (cmode.value === "none") core.setDropInAllow([]);
        else {
          const ids = [...cpeople.querySelectorAll("input:checked")].map((i) => i.value);
          core.setDropInAllow(ids);
        }
      };
      cmode.onchange = () => {
        cpeople.classList.toggle("hidden", cmode.value !== "custom");
        this._renderConsentPeople();
        apply();
      };
      this._applyConsent = apply;
      this._renderConsentPeople();
    }

    _renderConsentPeople() {
      const core = window.VideoCallCore;
      const cpeople = this.shadowRoot?.getElementById("cpeople");
      if (!cpeople) return;
      const persons = (core.rosterCache?.persons || []).filter((p) => p.user_id);
      const sig = persons.map((p) => p.user_id).join(",");
      if (sig === this._consentSig) return; // keep checkboxes stable mid-tap
      this._consentSig = sig;
      const checked = new Set(core.dropInAllow || []);
      cpeople.innerHTML = "";
      persons.forEach((p) => {
        const lab = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.value = p.user_id;
        cb.checked = checked.has(p.user_id);
        cb.onchange = () => this._applyConsent?.();
        lab.append(cb, document.createTextNode(p.name));
        cpeople.appendChild(lab);
      });
    }

    _subscribe() {
      const core = window.VideoCallCore;
      this._subs = [
        core.on("roster", () => this._renderRoster()),
        core.on("session", (s) => this._onSession(s)),
        core.on("status", (s) => { if (s !== "registered") this._status(String(s)); }),
      ];
    }

    _status(t) {
      const el = this.shadowRoot?.getElementById("status");
      if (el) el.textContent = t || "";
    }

    _onSession(session) {
      if (!session || session.state === "ended") {
        this._status(session?.endReason ? `Call ended (${session.endReason})` : "");
      } else {
        const who = session.peer ? epLabel(session.peer) : (session.targetLabel || "…");
        this._status(
          session.state === "ringing_out" ? `Calling ${who}…` :
          session.state === "ringing_in" ? `Incoming call from ${who}` :
          session.state === "connecting" ? `Connecting to ${who}…` :
          `In call with ${who}`);
      }
      Object.keys(this._groups || {}).forEach((k) => this._refreshGroup(k));
    }

    // Build the three dropdown groups ONCE with stable button elements.
    // Roster pushes then only update <option>s / disabled flags in place —
    // rebuilding the DOM on every roster event destroyed buttons between
    // touchstart and click (the "have to tap twice" bug).
    _buildRoster() {
      const host = this.shadowRoot.getElementById("roster");
      const hide = this._config?.hide_roster_sections || [];
      this._groups = {};
      // Native <select> dropdowns (the Android "empty dropdown" was a CSS
      // min-width collapse, not a WebView rendering bug). The group label is
      // the placeholder option — disabled+selected, NOT hidden (Android
      // renders the collapsed select empty when the selected option is
      // hidden).
      for (const [key, label] of [["persons", "Person"], ["areas", "Area"], ["devices", "Device"]]) {
        if (hide.includes(key)) continue;
        const grp = document.createElement("div"); grp.className = "grp hidden";
        const sel = document.createElement("select");
        const g = (this._groups[key] = { grp, sel, options: [], _sig: "", placeholder: label });
        sel.onchange = () => this._refreshGroup(key);
        const selected = () => {
          const v = sel.value;
          return v === "" ? null : g.options[Number(v)]; // "" = placeholder
        };
        const mk = (txt, title, cls, media, dropIn) => {
          const b = document.createElement("button");
          b.className = "callbtn" + (cls ? " " + cls : "");
          b.textContent = txt; b.title = title;
          b.onclick = () => {
            const o = selected();
            if (!o) return;
            window.VideoCallCore.invite(o.target, media, dropIn, o.plainLabel)
              .catch((e) => this._status("Call failed: " + (e?.message || e?.code || e)));
          };
          return b;
        };
        g.selected = selected;
        g.bVideo = mk("📹", "Video call", "", "video", false);
        g.bAudio = mk("📞", "Audio call", "", "audio", false);
        g.bDrop = mk("⚡", "Drop in (auto-answer)", "drop", "video", true);
        const btns = document.createElement("span");
        btns.className = "btns3";
        btns.append(g.bVideo, g.bAudio, g.bDrop);
        grp.append(sel, btns);
        host.appendChild(grp);
      }
    }

    _setGroupOptions(key, options) {
      const g = this._groups[key];
      if (!g) return;
      g.grp.classList.toggle("hidden", !options.length);
      const prevKey = g.sel.value === "" ? null : g.options[Number(g.sel.value)]?.key;
      g.options = options;
      const sig = options.map((o) => `${o.key}|${o.label}`).join("\n");
      if (sig !== g._sig) {
        g._sig = sig;
        g.sel.innerHTML = "";
        const ph = document.createElement("option");
        ph.value = ""; ph.textContent = g.placeholder;
        ph.disabled = true; ph.selected = true;
        g.sel.appendChild(ph);
        options.forEach((o, i) => {
          const opt = document.createElement("option");
          opt.value = String(i); opt.textContent = o.label;
          g.sel.appendChild(opt);
        });
        const idx = options.findIndex((o) => o.key === prevKey);
        if (idx >= 0) g.sel.value = String(idx); // keep the user's selection
      }
      this._refreshGroup(key);
    }

    _refreshGroup(key) {
      const g = this._groups?.[key];
      if (!g) return;
      const core = window.VideoCallCore;
      const busy = !!(core.session && core.session.state !== "ended");
      const o = g.selected?.(); // null while the placeholder is showing
      g.bVideo.disabled = g.bAudio.disabled = busy || !o?.callable;
      g.bDrop.disabled = busy || !o?.callable || !o?.dropInOk;
    }

    // Apply the shared roster options IN PLACE (SPEC §9.1 layer 4).
    _renderRoster() {
      if (!this._groups) return;
      const opts = rosterOptions(window.VideoCallCore);
      this._setGroupOptions("persons", opts.persons);
      this._setGroupOptions("areas", opts.areas);
      this._setGroupOptions("devices", opts.devices);

      const any = Object.values(this._groups).some((g) => g.options.length);
      this.shadowRoot.getElementById("empty").classList.toggle("hidden", any);
      this._renderConsentPeople(); // persons may arrive after boot
    }
  }

  // ==========================================================================
  // <videocall-button> — one-tap call button (SPEC §9.1)
  //
  //   type: custom:videocall-button
  //   person: person.mark        # optional FIXED target: one of
  //   area: kitchen              #   person/area/device/mobile
  //   device: <client_id>        # (endpoint = device serial number)
  //   mobile: mobile_app_marks_iphone
  //   # NO target configured → PICKER mode: tapping opens a target sheet
  //   sections: [persons, areas, devices]   # picker: which groups to offer
  //   name: "Call Mark"          # optional label
  //   media: video | audio       # default video
  //   drop_in: true              # auto-answer (browser targets only)
  //   height: 96                 # button height (bare number = px) — grow it
  //   icon_height: 40            # glyph size (bare number = px), like the core
  //                              #   button card's icon_height
  // ==========================================================================
  class VideocallButton extends HTMLElement {
    setConfig(config) {
      const c = config || {};
      const t =
        (c.person && { type: "person", id: c.person }) ||
        (c.area && { type: "area", id: c.area }) ||
        (c.device && { type: "endpoint", id: c.device }) ||
        (c.mobile && { type: "mobile", id: String(c.mobile).replace(/^notify\./, "") }) ||
        c.target || null;
      this._config = c;
      this._target = t;
      this._picker = !t; // no fixed target → tap opens the target picker
    }
    set hass(h) { if (!this._booted) this._boot(); }
    getCardSize() { return 1; }
    static getConfigElement() { return document.createElement("videocall-button-editor"); }
    static getStubConfig() { return { person: "", name: "Call" }; }

    connectedCallback() { if (this._booted && !this._sub) this._subscribe(); }
    disconnectedCallback() { this._sub?.(); this._sub = null; }

    _boot() {
      this._booted = true;
      this.attachShadow({ mode: "open" });
      const c = this._config;
      const icon = c.icon || (c.drop_in ? "⚡" : c.media === "audio" ? "📞" : "📹");
      const name = c.name || (this._picker ? "Call…" : this._target.id);
      // `height` grows the button; `icon_height` sizes the glyph (parity with
      // the core button card's icon_height). Bare number → px; any CSS length
      // string passes through. Read at boot — HA re-creates the card on edit.
      const cssLen = (v, d) => v == null
        ? d
        : (/^\s*\d+(\.\d+)?\s*$/.test(String(v)) ? `${String(v).trim()}px` : String(v));
      const icoSz = cssLen(c.icon_height, "24px");
      // `height` set → FIXED button height that does NOT grow to fill the card
      // slot (host/card go height:auto so the button sizes the card). Unset →
      // fill the slot (grid/sections layouts) with a 64px floor.
      const hasH = c.height != null && c.height !== "";
      const hEl = hasH ? "height:auto" : "height:100%";
      const btnH = hasH ? `height:${cssLen(c.height, "64px")}` : "height:100%;min-height:64px";
      this.shadowRoot.innerHTML = `
<style>
:host{display:block;${hEl}}
ha-card{${hEl}}
button{width:100%;${btnH};border:0;border-radius:var(--ha-card-border-radius,12px);cursor:pointer;background:${c.drop_in ? "#7b52ab" : "var(--primary-color,#03a9f4)"};color:#fff;font:600 16px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;gap:10px;padding:12px}
button[disabled]{opacity:.35;cursor:default}
.ico{font-size:${icoSz};line-height:1}
</style>
<ha-card><button id="btn"><span class="ico">${icon}</span><span>${name}</span></button></ha-card>`;
      this.shadowRoot.getElementById("btn").onclick = () => {
        if (this._picker) { this._openPicker(name); return; }
        window.VideoCallCore
          .invite(this._target, c.media || "video", !!c.drop_in, name)
          .catch((e) => console.warn("[videocall-button] call failed:", e?.message || e?.code || e));
      };
      this._subscribe();
      this._refresh();
    }

    // Picker mode: the shared floating target sheet — tap one to place the
    // call, tap outside to dismiss.
    _openPicker() {
      const c = this._config;
      openTargetSheet(
        window.VideoCallCore,
        c.sections || ["persons", "areas", "devices"],
        (o) => {
          window.VideoCallCore
            .invite(o.target, c.media || "video", !!c.drop_in && o.dropInOk, o.plainLabel)
            .catch((e) => console.warn("[videocall-button] call failed:", e?.message || e?.code || e));
        },
      );
    }
    _subscribe() {
      this._sub = window.VideoCallCore.on("session", () => this._refresh());
    }
    _refresh() {
      const btn = this.shadowRoot?.getElementById("btn");
      if (!btn) return;
      const s = window.VideoCallCore.session;
      btn.disabled = !!(s && s.state !== "ended"); // busy while any call is live
    }
  }

  class VideocallButtonEditor extends HTMLElement {
    setConfig(config) { this._config = { ...config }; this._render(); }
    set hass(h) {}
    _render() {
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `
<div style="padding:8px;font:13px system-ui">
  <p>One-tap call button. Fixed target (one of), or NO target = tap opens a picker:</p>
  <pre>person: person.mark      # or
area: kitchen            # area_id
device: &lt;client_id&gt;      # endpoint serial number
mobile: mobile_app_x     # notify service

sections: [persons, areas, devices]  # picker groups
name: "Call Mark"        # optional
media: video | audio
drop_in: true            # auto-answer (browsers only)
height: 96               # button height (px) — grow the button
icon_height: 40          # glyph size (px), like button card icon_height</pre>
</div>`;
    }
  }

  // ==========================================================================
  // <videocall-doorbell> — go2rtc doorbell intercom card (SPEC §14, layer 4)
  //
  //   type: custom:videocall-doorbell
  //   name: Front Door
  //   webrtc_url: https://go2rtc.example/api/webrtc   # go2rtc WebRTC HTTP API
  //   stream: camera.doorbell_talk                    # stream w/ mic backchannel
  //   mode: button | preview     # button (default) or inline live preview
  //   media: video | audio       # default video (the two-way intercom)
  //   entity: binary_sensor.doorbell_visitor  # optional: pulse while ringing
  //   token: <bearer>            # optional auth for a protected go2rtc endpoint
  //   height: 96 / icon_height: 40             # BUTTON-mode sizing
  //
  // button:  a tap opens the two-way intercom (view + talk) in the shared
  //          overlay — this is the "drop in with a button" path.
  // preview: an inline live view that connects (receive-only, muted) WHEN THE
  //          CARD SCROLLS INTO VIEW and disconnects when it leaves; tapping it
  //          escalates to the full two-way intercom in the overlay.
  //
  // Either way, the doorbell → phone RING is a separate path: an automation
  // calls the videocall.ring service on the button press, and the global
  // overlay answers it like any other call.
  // ==========================================================================
  class VideocallDoorbell extends HTMLElement {
    setConfig(config) {
      const c = config || {};
      this._config = c;
      this._mode = c.mode === "preview" ? "preview" : "button";
      const slug = (c.name || "doorbell").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      this._doorbell = {
        id: c.id || slug || "doorbell",
        name: c.name || "Doorbell",
        webrtc_url: c.webrtc_url,
        stream: c.stream,
        // optional separate mic backchannel stream (SPEC §14): when the door's
        // video+audio (playable) and the #backchannel=1 mic path can't live on
        // one go2rtc stream, receive on `stream` and send mic on `talk_stream`.
        talk_stream: c.talk_stream,
        token: c.token,
        // full_duplex: always-open audio (only if the camera has good AEC);
        // default is half-duplex push-to-talk.
        full_duplex: c.full_duplex === true,
      };
      // preview may use a lighter stream (e.g. the sub stream) for a faster
      // first live frame; the intercom always uses the main backchannel stream.
      this._previewDoorbell = { ...this._doorbell, stream: c.preview_stream || c.stream };
    }
    set hass(h) { this._hass = h; if (!this._booted) this._boot(); else { this._reflect(); this._updatePoster(); } }
    getCardSize() { return this._mode === "preview" ? 4 : 2; }
    static getConfigElement() { return document.createElement("videocall-doorbell-editor"); }
    static getStubConfig() {
      return { name: "Front Door", webrtc_url: "https://go2rtc.example/api/webrtc", stream: "camera.doorbell_talk" };
    }
    connectedCallback() {
      if (!this._booted) return;
      if (!this._sub) this._subscribe();
      if (this._mode === "preview") this._observe();
    }
    disconnectedCallback() {
      this._sub?.(); this._sub = null;
      this._io?.disconnect(); this._io = null;
      this._stopPreview();
    }
    _configured() { return !!(this._doorbell.webrtc_url && this._doorbell.stream); }

    _launch() {
      if (!this._configured()) { console.warn("[videocall-doorbell] configure webrtc_url + stream"); return; }
      window.VideoCallCore
        .callDoorbell({ ...this._doorbell, poster: this._posterUrl() }, this._config.media || "video")
        .catch((e) => console.warn("[videocall-doorbell] failed:", e?.message || e));
    }

    _boot() {
      this._booted = true;
      this.attachShadow({ mode: "open" });
      if (this._mode === "preview") this._bootPreview(); else this._bootButton();
      this._subscribe();
      this._refresh();
      this._reflect();
      this._updatePoster();
    }

    // babycam lesson: an instant still frame while WebRTC connects. The HA
    // camera entity's entity_picture is a signed same-origin snapshot URL;
    // image_url is a plain fallback. Used as the <video poster> (the browser
    // shows it until real frames decode, then auto-hides it) and passed to the
    // overlay so the two-way intercom also opens on a frame instead of black.
    _posterUrl() {
      const c = this._config;
      const cam = c.camera_entity || (String(c.entity || "").startsWith("camera.") ? c.entity : null);
      const st = cam && this._hass?.states?.[cam];
      return (st && st.attributes && st.attributes.entity_picture) || c.image_url || "";
    }
    _updatePoster() {
      if (this._mode !== "preview") return;
      const vid = this.shadowRoot?.getElementById("vid");
      const p = this._posterUrl();
      if (vid && p && vid.poster !== p) vid.poster = p;
    }

    _bootButton() {
      const c = this._config;
      const cssLen = (v, d) => v == null
        ? d : (/^\s*\d+(\.\d+)?\s*$/.test(String(v)) ? `${String(v).trim()}px` : String(v));
      const icoSz = cssLen(c.icon_height, "26px");
      const hasH = c.height != null && c.height !== "";
      const hEl = hasH ? "height:auto" : "height:100%";
      const btnH = hasH ? `height:${cssLen(c.height, "64px")}` : "height:100%;min-height:64px";
      this.shadowRoot.innerHTML = `
<style>
:host{display:block;${hEl}}
ha-card{${hEl}}
button{width:100%;${btnH};border:0;border-radius:var(--ha-card-border-radius,12px);cursor:pointer;background:var(--primary-color,#03a9f4);color:#fff;font:600 16px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;gap:10px;padding:12px}
button[disabled]{opacity:.35;cursor:default}
button.ringing{background:#d33;animation:vc-pulse 1s ease-in-out infinite}
@keyframes vc-pulse{50%{opacity:.55}}
.ico{font-size:${icoSz};line-height:1}
</style>
<ha-card><button id="btn"><span class="ico">🔔</span><span>${c.name || "Doorbell"}</span></button></ha-card>`;
      this.shadowRoot.getElementById("btn").onclick = () => this._launch();
    }

    _bootPreview() {
      const c = this._config;
      this.shadowRoot.innerHTML = `
<style>
:host{display:block}
ha-card{overflow:hidden}
.pv{position:relative;width:100%;aspect-ratio:16/9;background:#000;cursor:pointer;border-radius:var(--ha-card-border-radius,12px);overflow:hidden}
.pv.ringing{box-shadow:inset 0 0 0 3px #d33;animation:vc-pulse 1s ease-in-out infinite}
@keyframes vc-pulse{50%{opacity:.7}}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
.label{position:absolute;top:8px;left:10px;display:flex;align-items:center;gap:6px;font:600 14px system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.75);z-index:2}
.hint{position:absolute;bottom:8px;right:10px;font:600 12px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.5);padding:4px 8px;border-radius:8px;z-index:2}
.ico{font-size:16px}
</style>
<ha-card><div class="pv" id="pv">
  <video id="vid" autoplay playsinline muted></video>
  <div class="label"><span class="ico">🔔</span><span>${c.name || "Doorbell"}</span></div>
  <div class="hint">Tap to talk</div>
</div></ha-card>`;
      this.shadowRoot.getElementById("pv").onclick = () => this._launch();
      this._observe();
    }

    // Connect the inline preview only while the card is actually on screen —
    // no wasted go2rtc peer for a card scrolled off the dashboard.
    _observe() {
      if (this._mode !== "preview" || this._io || !this.isConnected) return;
      this._io = new IntersectionObserver((ents) => {
        this._inView = ents.some((e) => e.isIntersecting && e.intersectionRatio > 0.25);
        if (this._inView) this._startPreview(); else this._stopPreview();
      }, { threshold: [0, 0.25, 0.6] });
      this._io.observe(this);
    }

    async _startPreview() {
      if (this._mode !== "preview" || !this._configured() || this._view) return;
      // never grab the stream while a real overlay call is live (it owns the UI)
      const s = window.VideoCallCore.session;
      if (s && s.state !== "ended") return;
      const view = new Go2rtcView(this._previewDoorbell, window.VideoCallCore.iceServers);
      this._view = view;
      const vid = this.shadowRoot.getElementById("vid");
      view.onstream = (st) => { if (vid) { vid.srcObject = st; try { vid.play?.().catch(noop); } catch {} } };
      try { view.connect(); }
      catch (e) { console.warn("[videocall-doorbell] preview failed:", e?.message || e); this._stopPreview(); }
    }
    _stopPreview() {
      const vid = this.shadowRoot?.getElementById("vid");
      if (vid) vid.srcObject = null;
      this._view?.close(); this._view = null;
    }

    _subscribe() {
      this._sub = window.VideoCallCore.on("session", (s) => {
        this._refresh();
        if (this._mode !== "preview") return;
        // yield the inline preview to a real call; resume when it ends & in view
        if (s && s.state !== "ended") this._stopPreview();
        else if (this._inView) this._startPreview();
      });
    }
    _refresh() {
      const btn = this.shadowRoot?.getElementById("btn");
      if (!btn) return;                                  // preview mode has no button
      const s = window.VideoCallCore.session;
      btn.disabled = !!(s && s.state !== "ended");       // busy while any call is live
    }
    // Optional live badge: pulse red while the configured visitor entity is on.
    _reflect() {
      const el = this.shadowRoot?.getElementById("pv") || this.shadowRoot?.getElementById("btn");
      const ent = this._config?.entity;
      if (!el || !ent || !this._hass?.states) return;
      const st = this._hass.states[ent];
      const on = !!st && ["on", "ringing", "detected", "true"].includes(String(st.state));
      el.classList.toggle("ringing", on);
    }
  }

  class VideocallDoorbellEditor extends HTMLElement {
    setConfig(config) { this._config = { ...config }; this._render(); }
    set hass(h) {}
    _render() {
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `
<div style="padding:8px;font:13px system-ui">
  <p>go2rtc doorbell intercom — tap to view + two-way talk:</p>
  <pre>name: Front Door
webrtc_url: https://go2rtc.example/api/webrtc  # go2rtc base (or /api/webrtc) — HTTPS!
stream: camera.doorbell        # receive: door video + audio (needs OPUS)
talk_stream: camera.doorbell_talk  # optional: separate #backchannel=1 mic stream
mode: button | preview         # button (default) or inline live preview
media: video | audio           # default video
full_duplex: true              # always-open audio (default: push-to-talk)
camera_entity: camera.doorbell # poster still while connecting (instant frame)
image_url: /local/door.jpg     # poster fallback if no camera_entity
preview_stream: camera.doorbell_sub  # lighter stream for a faster preview frame
entity: binary_sensor.visitor  # optional: pulse while someone's at the door
token: &lt;bearer&gt;               # optional go2rtc auth
height: 96 / icon_height: 40   # button-mode sizing</pre>
  <p><b>preview</b> connects a muted live view when the card scrolls into view;
  tap it to talk. <b>button</b> is a launcher. Doorbell talk defaults to
  half-duplex push-to-talk (hold the 🎤 button) — a hands-free door echoes your
  voice back after go2rtc's delay, which browser echo-cancellation can't fix;
  set <code>full_duplex: true</code> only if your camera's own AEC is good.</p>
  <p>Doorbell → phone ringing is a separate automation that calls the
  <code>videocall.ring</code> service on the button press.</p>
</div>`;
    }
  }

  class VideocallCardEditor extends HTMLElement {
    setConfig(config) { this._config = { ...config }; this._render(); }
    set hass(h) {}
    _render() {
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `
<div style="padding:8px;font:13px system-ui">
  <p>No required options. Optional YAML:</p>
  <pre>hide_roster_sections: [persons, areas, devices]</pre>
</div>`;
    }
  }

  // ==========================================================================
  // registration + headless boot
  // ==========================================================================
  if (!customElements.get("videocall-overlay")) customElements.define("videocall-overlay", VideocallOverlay);
  if (!customElements.get("videocall-card")) customElements.define("videocall-card", VideocallCard);
  if (!customElements.get("videocall-card-editor")) customElements.define("videocall-card-editor", VideocallCardEditor);
  if (!customElements.get("videocall-button")) customElements.define("videocall-button", VideocallButton);
  if (!customElements.get("videocall-button-editor")) customElements.define("videocall-button-editor", VideocallButtonEditor);
  if (!customElements.get("videocall-doorbell")) customElements.define("videocall-doorbell", VideocallDoorbell);
  if (!customElements.get("videocall-doorbell-editor")) customElements.define("videocall-doorbell-editor", VideocallDoorbellEditor);
  (window.customCards = window.customCards || []).push(
    {
      type: "videocall-card",
      name: "Video Call",
      description: "HA-native WebRTC video calling: ring areas, people, and mobile apps.",
    },
    {
      type: "videocall-button",
      name: "Video Call Button",
      description: "One-tap call button for a fixed person, area, or device.",
    },
    {
      type: "videocall-doorbell",
      name: "Video Call Doorbell",
      description: "go2rtc doorbell intercom: view + two-way talk, and answer doorbell rings.",
    },
  );

  window.VideoCallCore = new VideoCallCoreImpl();
  console.info(
    `%c VIDEOCALL %c v${VERSION} `,
    "color:#fff;background:#03a9f4;font-weight:700", "color:#fff;background:#555",
  );
})();
