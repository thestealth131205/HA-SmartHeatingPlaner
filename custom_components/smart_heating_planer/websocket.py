"""Websocket-API für die Karte: Bedingungen abonnieren, speichern, löschen."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN

DATA_MANAGER = f"{DOMAIN}_conditions"


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_save)
    websocket_api.async_register_command(hass, ws_delete)


def _manager(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg_id: int):
    manager = hass.data.get(DATA_MANAGER)
    if manager is None:
        connection.send_error(msg_id, "not_loaded", "Smart Heating Planer ist nicht eingerichtet")
    return manager


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/conditions/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    manager = _manager(hass, connection, msg["id"])
    if manager is None:
        return

    @callback
    def _send() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], manager.as_dict()))

    connection.subscriptions[msg["id"]] = manager.subscribe(_send)
    connection.send_result(msg["id"])
    _send()


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/conditions/save", vol.Required("rule"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    manager = _manager(hass, connection, msg["id"])
    if manager is None:
        return
    try:
        rule = await manager.async_save_rule(msg["rule"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"rule": rule})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/conditions/delete", vol.Required("rule_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    manager = _manager(hass, connection, msg["id"])
    if manager is None:
        return
    await manager.async_delete_rule(msg["rule_id"])
    connection.send_result(msg["id"])
