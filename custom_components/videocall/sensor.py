"""Per-endpoint call-state sensor + global last-call sensor (SPEC.md §8)."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    DOMAIN,
    SIGNAL_CALL_LOG,
    SIGNAL_ENDPOINT_REMOVED,
    SIGNAL_ENDPOINT_UPDATE,
    SIGNAL_NEW_ENDPOINT,
)
from .models import CallState, Endpoint


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    data = hass.data[DOMAIN]
    known: set[str] = set()

    @callback
    def _add(endpoint: Endpoint) -> None:
        if endpoint.client_id in known:
            return
        known.add(endpoint.client_id)
        async_add_entities([EndpointCallStateSensor(hass, endpoint)])

    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_NEW_ENDPOINT, _add))
    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_ENDPOINT_REMOVED, known.discard)
    )
    for ep in data.endpoints.all():
        _add(ep)

    async_add_entities([LastCallSensor(hass, entry)])


class EndpointCallStateSensor(SensorEntity):
    _attr_should_poll = False
    _attr_has_entity_name = True
    _attr_name = "Call state"
    _attr_options = ["idle", "ringing", "in_call"]
    _attr_device_class = "enum"

    def __init__(self, hass: HomeAssistant, endpoint: Endpoint) -> None:
        self.hass = hass
        self._client_id = endpoint.client_id
        self._attr_unique_id = f"{endpoint.client_id}-call-state"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, endpoint.client_id)})

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_ENDPOINT_UPDATE, self._maybe_update)
        )

    @callback
    def _maybe_update(self, client_id: str) -> None:
        if client_id == self._client_id:
            self.async_write_ha_state()

    @property
    def native_value(self) -> str:
        data = self.hass.data[DOMAIN]
        ep = data.endpoints.get(self._client_id)
        if not ep or not ep.call_id:
            return "idle"
        call = data.calls.get(ep.call_id)
        if call and call.state is CallState.RINGING:
            return "ringing"
        return "in_call"


class LastCallSensor(SensorEntity):
    _attr_should_poll = False
    _attr_name = "Videocall last call"
    _attr_icon = "mdi:video"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self._attr_unique_id = f"{entry.entry_id}-last-call"

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_CALL_LOG, self._on_log)
        )

    @callback
    def _on_log(self, _entry: dict) -> None:
        self.async_write_ha_state()

    @property
    def native_value(self) -> str | None:
        log = self.hass.data[DOMAIN].calls.ended_log
        if not log:
            return None
        last = log[-1]
        reason = last.get("reason")
        if last.get("answered_at"):
            return "answered"
        return {"timeout": "missed", "caller_cancel": "cancelled",
                "declined": "declined"}.get(reason, reason or "unknown")

    @property
    def extra_state_attributes(self) -> dict:
        log = self.hass.data[DOMAIN].calls.ended_log
        return {"history": list(log)}
