"""Serve the card from the integration and self-register the Lovelace resource.

Same approach as the deployed `webrtc` integration (utils.init_resource), but
with modern async_register_static_paths and namespaced under /videocall/*.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import CARD_FILENAME, CARD_URL_PATH, DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_register_frontend(hass: HomeAssistant) -> None:
    card_path = Path(__file__).parent / CARD_FILENAME

    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL_PATH, str(card_path), cache_headers=False)]
    )

    version = getattr(hass.data["integrations"][DOMAIN], "version", "0")
    await _init_resource(hass, CARD_URL_PATH, str(version))


async def _init_resource(hass: HomeAssistant, url: str, version: str) -> bool:
    """Idempotently add/refresh `{url}?v={version}` in Lovelace resources.

    Storage-mode: update via the resources ResourceStorageCollection.
    YAML-mode: log a hint (user manages resources by hand).
    """
    resources = hass.data.get("lovelace")
    resources = getattr(resources, "resources", None) or (
        resources.get("resources") if isinstance(resources, dict) else None
    )
    if resources is None:
        _LOGGER.warning("Lovelace resources unavailable; add %s manually", url)
        return False

    # wait for storage collection load
    if hasattr(resources, "loaded") and not resources.loaded:
        await resources.async_load()
        resources.loaded = True

    url_v = f"{url}?v={version}"
    for item in resources.async_items():
        if not item.get("url", "").startswith(url):
            continue
        if item["url"].endswith(version):
            return False  # already current
        if hasattr(resources, "async_update_item"):
            await resources.async_update_item(item["id"], {"url": url_v})
            _LOGGER.debug("Updated lovelace resource to %s", url_v)
        else:
            _LOGGER.warning("YAML lovelace mode: update resource to %s manually", url_v)
        return True

    if hasattr(resources, "async_create_item"):
        await resources.async_create_item({"res_type": "module", "url": url_v})
        _LOGGER.debug("Created lovelace resource %s", url_v)
        return True

    _LOGGER.warning("YAML lovelace mode: add resource %s manually", url_v)
    return False
