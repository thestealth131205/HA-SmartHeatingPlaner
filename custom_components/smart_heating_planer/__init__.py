"""Smart Heating Planer – Thermostat-Karte mit Wochenplan zum Antippen.

Die Integration liefert die Lovelace-Karte ``custom:smart-heating-planer-card``
aus und lädt sie automatisch im Frontend. Eine Ressource muss nicht von Hand
eingetragen werden. Der Plan selbst liegt im Thermostat (Zigbee2MQTT-Entities
``text.<name>_weekly_schedule_<tag>``), die Karte liest und schreibt ihn direkt.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import CARD_URL, CARD_URL_BASE, DOMAIN, VERSION

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

_FRONTEND_DIR = Path(__file__).parent / "frontend"
_STATIC_REGISTERED = f"{DOMAIN}_static_registered"


def _versioned_url() -> str:
    # Versions-Parameter, damit Browser nach einem Update die neue Karte laden
    return f"{CARD_URL}?v={VERSION}"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # Statische Pfade lassen sich nicht wieder abmelden, daher nur einmal pro Lauf
    if not hass.data.get(_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL_BASE, str(_FRONTEND_DIR), cache_headers=False)]
        )
        hass.data[_STATIC_REGISTERED] = True
    add_extra_js_url(hass, _versioned_url())
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    remove_extra_js_url(hass, _versioned_url())
    return True
