"""Climate platform: creates the group entities from couplings.py."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .websocket import DATA_COUPLINGS


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager = hass.data[DATA_COUPLINGS]
    manager.bind(async_add_entities)
    await manager.async_load()
