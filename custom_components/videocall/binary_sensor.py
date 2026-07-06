"""Per-endpoint connectivity binary_sensor (SPEC.md §8)."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import DeviceInfo, EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    DOMAIN,
    SIGNAL_ENDPOINT_REMOVED,
    SIGNAL_ENDPOINT_UPDATE,
    SIGNAL_NEW_ENDPOINT,
)
from .models import Endpoint


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
        async_add_entities([EndpointOnlineSensor(hass, endpoint)])

    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_NEW_ENDPOINT, _add)
    )
    # prune removed the device+entities — forget the id so a re-registration
    # recreates them instead of being silently "already known"
    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_ENDPOINT_REMOVED, known.discard)
    )
    for ep in data.endpoints.all():
        _add(ep)


class EndpointOnlineSensor(BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_should_poll = False
    _attr_has_entity_name = True
    _attr_name = "Online"

    def __init__(self, hass: HomeAssistant, endpoint: Endpoint) -> None:
        self.hass = hass
        self._client_id = endpoint.client_id
        self._attr_unique_id = f"{endpoint.client_id}-online"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, endpoint.client_id)})

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_ENDPOINT_UPDATE, self._maybe_update
            )
        )

    @callback
    def _maybe_update(self, client_id: str) -> None:
        if client_id == self._client_id:
            self.async_write_ha_state()

    @property
    def is_on(self) -> bool:
        ep = self.hass.data[DOMAIN].endpoints.get(self._client_id)
        return bool(ep and ep.online)
