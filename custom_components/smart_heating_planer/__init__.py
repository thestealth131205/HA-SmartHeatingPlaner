"""Smart Heating Planer – thermostat card with a tap-to-edit weekly schedule.

The integration serves the Lovelace card ``custom:smart-heating-planer-card``
and loads it automatically in the frontend. No resource needs to be added by
hand. The schedule itself lives in the thermostat (Zigbee2MQTT entities
``text.<name>_weekly_schedule_<day>``); the card reads and writes it directly.

The integration also manages conditions (see ``conditions.py``):
entity state → thermostat to manual/off, optional boost, optional reset.

And couplings (see ``couplings.py``): combine two thermostats "with group" into
a dedicated climate entity that can be used anywhere in Home Assistant.
The coupling "without group" (second thermostat only carried along in the card)
needs no integration logic; it lives entirely in the card.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from . import websocket
from .conditions import ConditionManager
from .const import CARD_URL, CARD_URL_BASE, DOMAIN, TRANSLATIONS_URL_BASE, VERSION
from .couplings import CouplingManager
from .websocket import DATA_COUPLINGS, DATA_MANAGER

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

PLATFORMS = ["climate"]

_FRONTEND_DIR = Path(__file__).parent / "frontend"
_TRANSLATIONS_DIR = Path(__file__).parent / "translations"
_STATIC_REGISTERED = f"{DOMAIN}_static_registered"
_WS_REGISTERED = f"{DOMAIN}_ws_registered"


def _versioned_url() -> str:
    # Version parameter so browsers load the new card after an update
    return f"{CARD_URL}?v={VERSION}"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # Static paths cannot be unregistered, so register them only once per run
    if not hass.data.get(_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(CARD_URL_BASE, str(_FRONTEND_DIR), cache_headers=False),
                StaticPathConfig(TRANSLATIONS_URL_BASE, str(_TRANSLATIONS_DIR), cache_headers=False),
            ]
        )
        hass.data[_STATIC_REGISTERED] = True
    if not hass.data.get(_WS_REGISTERED):
        websocket.async_register(hass)
        hass.data[_WS_REGISTERED] = True
    manager = ConditionManager(hass)
    await manager.async_load()
    hass.data[DATA_MANAGER] = manager
    # CouplingManager becomes usable only once the climate platform has registered its
    # async_add_entities function via manager.bind().
    hass.data[DATA_COUPLINGS] = CouplingManager(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    add_extra_js_url(hass, _versioned_url())
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    remove_extra_js_url(hass, _versioned_url())
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    manager = hass.data.pop(DATA_MANAGER, None)
    if manager:
        manager.async_unload()
    couplings = hass.data.pop(DATA_COUPLINGS, None)
    if couplings:
        couplings.async_unload()
    return unloaded
