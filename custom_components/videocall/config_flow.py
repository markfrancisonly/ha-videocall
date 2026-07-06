"""Config flow — zero-question create; everything tunable lives in options."""

from __future__ import annotations

import json

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import (
    OPT_TURN_CREDENTIAL,
    OPT_TURN_HOST,
    OPT_TURN_LAN_HOST,
    OPT_TURN_STUN,
    OPT_TURN_USERNAME,
    DEFAULT_ALLOW_DROP_IN,
    DEFAULT_ANSWER_DASHBOARD,
    DEFAULT_RING_TIMEOUT,
    DEFAULT_TURN_STUN,
    DOMAIN,
    OPT_ALLOW_DROP_IN,
    OPT_ANSWER_DASHBOARD,
    OPT_ICE_SERVERS,
    OPT_PERSON_NOTIFY_MAP,
    OPT_RING_TIMEOUT,
)


class VideocallConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        # single_config_entry in manifest guards duplicates; no fields to ask.
        return self.async_create_entry(title="Video Call", data={})

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return VideocallOptionsFlow()


def _prefill(key, source, default=""):
    """Pre-fill an editable text field via suggested_value — NOT default.

    A default= re-applies the previous value when the box is emptied, so the
    field could never be CLEARED (e.g. you could never remove a configured TURN
    server); suggested_value lets a blank submission persist as blank.
    """
    return vol.Optional(key, description={"suggested_value": source.get(key, default)})


class VideocallOptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        # menu = the closest thing to buttons a config flow offers. Common config
        # lives in Settings; the error-prone raw-JSON overrides live in Advanced
        # (a typo there silently breaks calls, so keep it out of the way).
        return self.async_show_menu(
            step_id="init", menu_options=["settings", "advanced", "prune"]
        )

    async def async_step_prune(self, user_input=None):
        from . import async_prune_offline_endpoints

        count = async_prune_offline_endpoints(self.hass)
        return self.async_abort(
            reason="pruned", description_placeholders={"count": str(count)}
        )

    def _save(self, user_input: dict):
        # options is ONE dict shared across steps — MERGE so saving Settings
        # never wipes the Advanced JSON (and vice-versa).
        return self.async_create_entry(
            title="", data={**self.config_entry.options, **user_input}
        )

    async def async_step_settings(self, user_input=None):
        if user_input is not None:
            return self._save(user_input)

        opts = self.config_entry.options
        schema = vol.Schema(
            {
                # simple TURN config (preferred) — composed into ICE server-side.
                # Text fields pre-fill via suggested_value so they can be CLEARED
                # (emptying turn_host disables TURN; default= would re-save it).
                _prefill(OPT_TURN_HOST, opts): str,
                _prefill(OPT_TURN_USERNAME, opts): str,
                _prefill(OPT_TURN_CREDENTIAL, opts): str,
                _prefill(OPT_TURN_LAN_HOST, opts): str,
                # coturn (and most self-hosted TURN) answers STUN on the same
                # port — one checkbox instead of hand-writing stun: JSON.
                vol.Optional(
                    OPT_TURN_STUN,
                    default=opts.get(OPT_TURN_STUN, DEFAULT_TURN_STUN),
                ): bool,
                vol.Optional(
                    OPT_RING_TIMEOUT,
                    default=opts.get(OPT_RING_TIMEOUT, DEFAULT_RING_TIMEOUT),
                ): vol.All(int, vol.Range(min=5, max=300)),
                vol.Optional(
                    OPT_ALLOW_DROP_IN,
                    default=opts.get(OPT_ALLOW_DROP_IN, DEFAULT_ALLOW_DROP_IN),
                ): bool,
                _prefill(OPT_ANSWER_DASHBOARD, opts, DEFAULT_ANSWER_DASHBOARD): str,
            }
        )
        return self.async_show_form(step_id="settings", data_schema=schema)

    async def async_step_advanced(self, user_input=None):
        # Raw-JSON overrides / troubleshooting only — most people never touch
        # these (the TURN fields + "Use TURN for STUN" cover normal setups).
        errors = {}
        if user_input is not None:
            # Require valid JSON AND the right container type — a valid-JSON
            # scalar like null/5 would otherwise save and later crash the
            # consumer (ice_servers wants a list, person_notify_map a dict).
            for key, empty, expected in (
                (OPT_ICE_SERVERS, "[]", list),
                (OPT_PERSON_NOTIFY_MAP, "{}", dict),
            ):
                try:
                    parsed = json.loads(user_input.get(key) or empty)
                except ValueError:
                    errors[key] = "invalid_json"
                else:
                    if not isinstance(parsed, expected):
                        errors[key] = "invalid_json"
            if not errors:
                return self._save(user_input)

        # on an error re-render, keep the just-typed (invalid) values so the typo
        # is fixable in place; on first render pre-fill from saved options.
        src = user_input if user_input is not None else self.config_entry.options
        schema = vol.Schema(
            {
                # raw RTCIceServer[] override. Blank → default STUN (or the
                # "Use TURN for STUN" checkbox) + your TURN; [] → no defaults.
                _prefill(OPT_ICE_SERVERS, src): str,
                _prefill(OPT_PERSON_NOTIFY_MAP, src, "{}"): str,
            }
        )
        return self.async_show_form(
            step_id="advanced", data_schema=schema, errors=errors
        )
