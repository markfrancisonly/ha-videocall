"""Constants for the videocall integration. See SPEC.md §2 for the namespace table."""

DOMAIN = "videocall"

# --- frontend serving -------------------------------------------------------
CARD_URL_PATH = "/videocall/videocall-card.js"  # never under /webrtc/*
CARD_FILENAME = "www/videocall-card.js"

# --- options (config entry options, all with zero-config defaults) ----------
# Simple TURN fields (preferred): composed into the ICE list server-side.
OPT_TURN_HOST = "turn_host"              # host or host:port; empty = no TURN
OPT_TURN_USERNAME = "turn_username"
OPT_TURN_CREDENTIAL = "turn_credential"
OPT_TURN_LAN_HOST = "turn_lan_host"      # optional LAN address for on-network clients
OPT_TURN_STUN = "turn_stun"              # also derive stun: entries from the TURN host(s)
# Advanced: raw RTCIceServer[] JSON (merged with the TURN fields above).
OPT_ICE_SERVERS = "ice_servers"          # JSON string, RTCIceServer[]
OPT_RING_TIMEOUT = "ring_timeout"        # seconds
OPT_ALLOW_DROP_IN = "allow_drop_in"      # DEFAULT drop-in policy (devices w/o consent list)
# NOTE: per-device drop-in consent is DEVICE-OWNED (declared at register from
# the card's "Drop-in here" control) — deliberately NOT an integration option.
OPT_ANSWER_DASHBOARD = "answer_dashboard"  # deep-link base path for mobile answer
OPT_PERSON_NOTIFY_MAP = "person_notify_map"  # JSON: {"person.x": ["notify.mobile_app_y"]}

DEFAULT_ICE_SERVERS = '[{"urls":"stun:stun.l.google.com:19302"}]'
DEFAULT_TURN_STUN = False
DEFAULT_RING_TIMEOUT = 30
DEFAULT_ALLOW_DROP_IN = True
DEFAULT_ANSWER_DASHBOARD = "/lovelace"

# --- websocket API (SPEC.md §5) ----------------------------------------------
WS_REGISTER = "videocall/register"
WS_ROSTER = "videocall/roster"
WS_INVITE = "videocall/invite"
WS_CANCEL = "videocall/cancel"
WS_ACCEPT = "videocall/accept"
WS_DECLINE = "videocall/decline"
WS_OFFER = "videocall/offer"
WS_ANSWER = "videocall/answer"
WS_CANDIDATE = "videocall/candidate"
WS_HANGUP = "videocall/hangup"

# server → client event_type values
EVT_RING = "ring"
EVT_RING_CANCEL = "ring_cancel"
EVT_ACCEPTED = "accepted"
EVT_OFFER = "offer"
EVT_ANSWER = "answer"
EVT_CANDIDATE = "candidate"
EVT_HANGUP = "hangup"
EVT_ROSTER = "roster"

# --- HA bus events (automation surface) --------------------------------------
BUS_EVT_INCOMING = "videocall_incoming"
BUS_EVT_ANSWERED = "videocall_answered"
BUS_EVT_ENDED = "videocall_ended"

# --- mobile push --------------------------------------------------------------
NOTIF_TAG_PREFIX = "vcall-"                  # tag = vcall-<call_id>
DECLINE_ACTION_PREFIX = "VCALL_DECLINE_"     # action = VCALL_DECLINE_<call_id>
NOTIF_CHANNEL = "Video Call"
DEEP_LINK_PARAM = "vcall_answer"

# --- limits (SPEC.md §11) -----------------------------------------------------
MAX_ENDPOINTS = 256
MAX_SDP_BYTES = 65536
ENDED_CALL_LOG_SIZE = 50
ROSTER_DEBOUNCE_S = 1.0

# --- dispatcher signals -------------------------------------------------------
SIGNAL_NEW_ENDPOINT = f"{DOMAIN}_new_endpoint"     # payload: Endpoint
SIGNAL_ENDPOINT_REMOVED = f"{DOMAIN}_endpoint_removed"  # payload: client_id (prune)
SIGNAL_ENDPOINT_UPDATE = f"{DOMAIN}_endpoint_update"  # payload: client_id
SIGNAL_CALL_LOG = f"{DOMAIN}_call_log"             # payload: ended-call dict
