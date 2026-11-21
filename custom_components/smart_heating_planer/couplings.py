"""Couplings: combine two thermostats into one group climate entity.

"With group" from the card's point of view: a coupling consists of exactly two
climate entities. The integration creates a dedicated climate entity for it
(``climate.<name>``) that forwards commands through the normal HA services to both
entity IDs at once – Home Assistant core has no climate groups like it has for
lights/switches, so we add that here. The state is combined from both members
(equal: adopt it, different: value of the first member). The new entity can
therefore be used anywhere in Home Assistant, not just in this card.

It is managed entirely through the card (see
``smart_heating_planer/couplings/*`` in websocket.py), no options flow
needed – entities are added/removed at runtime.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from typing import Any

from homeassistant.components.climate import (
    ATTR_HVAC_MODE,
    ClimateEntity,
    ClimateEntityFeature,
)
from homeassistant.components.climate.const import DEFAULT_MAX_TEMP, DEFAULT_MIN_TEMP, HVACAction, HVACMode
from homeassistant.const import ATTR_TEMPERATURE, STATE_UNAVAILABLE, STATE_UNKNOWN, UnitOfTemperature
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.couplings"
_INVALID = (STATE_UNAVAILABLE, STATE_UNKNOWN)
# Order in which the common mode is chosen when the modes differ
_MODE_PRIORITY = (HVACMode.HEAT, HVACMode.AUTO, HVACMode.COOL)
_ACTION_PRIORITY = (HVACAction.HEATING, HVACAction.PREHEATING, HVACAction.COOLING, HVACAction.IDLE)


def validate_coupling(data: dict[str, Any], existing: list[dict[str, Any]]) -> dict[str, Any]:
    members = [str(m) for m in (data.get("members") or [])]
    if len(members) != 2 or members[0] == members[1]:
        raise ValueError("srv_select_two")
    for member in members:
        if not member.startswith("climate."):
            raise ValueError("srv_members_not_climate")
    coupling_id = str(data.get("id") or uuid.uuid4().hex[:12])
    for other in existing:
        if other["id"] != coupling_id and set(other["members"]) == set(members):
            raise ValueError("srv_group_exists")
    name = str(data.get("name") or "").strip() or "Thermostat-Gruppe"
    return {"id": coupling_id, "name": name, "members": members}


class CouplingManager:
    """Stores couplings and creates/removes the climate group entities for them."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.couplings: list[dict[str, Any]] = []
        self._entities: dict[str, CoupledGroupClimate] = {}
        self._add_entities: AddEntitiesCallback | None = None
        self._listeners: set[Callable[[], None]] = set()

    def bind(self, async_add_entities: AddEntitiesCallback) -> None:
        self._add_entities = async_add_entities

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.couplings = data.get("couplings", [])
        if self._add_entities and self.couplings:
            entities = [CoupledGroupClimate(c) for c in self.couplings]
            for entity in entities:
                self._entities[entity.coupling_id] = entity
            self._add_entities(entities)

    def async_unload(self) -> None:
        self._listeners.clear()

    @callback
    def _save(self) -> None:
        self._store.async_delay_save(lambda: {"couplings": self.couplings}, 1)
        for listener in list(self._listeners):
            listener()

    @callback
    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    def as_dict(self) -> dict[str, Any]:
        out = []
        for c in self.couplings:
            entity = self._entities.get(c["id"])
            out.append({**c, "entity_id": entity.entity_id if entity else None})
        return {"couplings": out}

    async def async_save_coupling(self, data: dict[str, Any]) -> dict[str, Any]:
        coupling = validate_coupling(data, self.couplings)
        for member in coupling["members"]:
            state = self.hass.states.get(member)
            if state and state.attributes.get("smart_heating_planer_group"):
                raise ValueError("srv_no_nested_group")
        old = next((c for c in self.couplings if c["id"] == coupling["id"]), None)
        if old:
            self.couplings[self.couplings.index(old)] = coupling
            entity = self._entities.get(coupling["id"])
            if entity:
                entity.update_coupling(coupling)
        else:
            self.couplings.append(coupling)
            if self._add_entities:
                entity = CoupledGroupClimate(coupling)
                self._entities[coupling["id"]] = entity
                self._add_entities([entity])
            else:
                _LOGGER.warning("Gruppe %s konnte nicht angelegt werden (Plattform noch nicht bereit)", coupling["id"])
        self._save()
        return coupling

    async def async_delete_coupling(self, coupling_id: str) -> None:
        self.couplings = [c for c in self.couplings if c["id"] != coupling_id]
        entity = self._entities.pop(coupling_id, None)
        if entity:
            registry = er.async_get(self.hass)
            if entity.entity_id and registry.async_get(entity.entity_id):
                registry.async_remove(entity.entity_id)
            await entity.async_remove(force_remove=True)
        self._save()


class CoupledGroupClimate(ClimateEntity):
    """Combines two thermostats into one climate entity.

    Commands go to the real thermostats via a service call with both entity
    IDs – Home Assistant already performs the fan-out itself, just like
    for any other service call with multiple entities.
    """

    _attr_should_poll = False
    _attr_native_temperature_unit = UnitOfTemperature.CELSIUS

    def __init__(self, coupling: dict[str, Any]) -> None:
        self.coupling_id = coupling["id"]
        self._attr_unique_id = f"{DOMAIN}_group_{self.coupling_id}"
        self._attr_name = coupling["name"]
        self._members: list[str] = list(coupling["members"])
        self._unsub: Callable[[], None] | None = None

    def update_coupling(self, coupling: dict[str, Any]) -> None:
        self._attr_name = coupling["name"]
        self._members = list(coupling["members"])
        if self.hass and self._unsub:
            self._unsub()
            self._track()
        self.async_write_ha_state()

    async def async_added_to_hass(self) -> None:
        self._track()

    def _track(self) -> None:
        self._unsub = async_track_state_change_event(self.hass, self._members, self._on_member_change)

    @callback
    def _on_member_change(self, event: Event[EventStateChangedData]) -> None:
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    def _member_states(self) -> list[State]:
        states = [self.hass.states.get(m) for m in self._members]
        return [s for s in states if s is not None]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"entity_id": list(self._members), "smart_heating_planer_group": True}

    @property
    def available(self) -> bool:
        states = self._member_states()
        return len(states) == len(self._members) and all(s.state not in _INVALID for s in states)

    @property
    def hvac_modes(self) -> list[HVACMode]:
        sets = [set(s.attributes.get("hvac_modes") or []) for s in self._member_states()]
        if not sets:
            return [HVACMode.OFF]
        common = set.intersection(*sets)
        order = [m.value for m in HVACMode]
        modes = [HVACMode(m) for m in order if m in common]
        return modes or [HVACMode.OFF]

    @property
    def hvac_mode(self) -> HVACMode | None:
        states = [s.state for s in self._member_states() if s.state not in _INVALID]
        if len(states) != len(self._members):
            return None
        if len(set(states)) == 1:
            try:
                return HVACMode(states[0])
            except ValueError:
                return None
        for preferred in _MODE_PRIORITY:
            if preferred.value in states:
                return preferred
        try:
            return HVACMode(states[0])
        except ValueError:
            return None

    @property
    def hvac_action(self) -> HVACAction | None:
        actions = [s.attributes.get("hvac_action") for s in self._member_states()]
        actions = [a for a in actions if a]
        for preferred in _ACTION_PRIORITY:
            if preferred.value in actions:
                return preferred
        try:
            return HVACAction(actions[0]) if actions else None
        except ValueError:
            return None

    @property
    def native_current_temperature(self) -> float | None:
        values = [s.attributes.get("current_temperature") for s in self._member_states()]
        values = [float(v) for v in values if isinstance(v, (int, float))]
        return round(sum(values) / len(values), 1) if values else None

    @property
    def native_target_temperature(self) -> float | None:
        values = [s.attributes.get("temperature") for s in self._member_states()]
        values = [v for v in values if isinstance(v, (int, float))]
        return values[0] if values else None

    @property
    def target_temperature_step(self) -> float | None:
        steps = [s.attributes.get("target_temp_step") for s in self._member_states()]
        steps = [v for v in steps if isinstance(v, (int, float)) and v > 0]
        return max(steps) if steps else None

    @property
    def min_temp(self) -> float:
        values = [s.attributes.get("min_temp") for s in self._member_states()]
        values = [v for v in values if isinstance(v, (int, float))]
        return max(values) if values else DEFAULT_MIN_TEMP

    @property
    def max_temp(self) -> float:
        values = [s.attributes.get("max_temp") for s in self._member_states()]
        values = [v for v in values if isinstance(v, (int, float))]
        return min(values) if values else DEFAULT_MAX_TEMP

    @property
    def preset_modes(self) -> list[str] | None:
        sets = [set(s.attributes.get("preset_modes") or []) for s in self._member_states()]
        if not sets:
            return None
        common = sorted(set.intersection(*sets))
        return common or None

    @property
    def preset_mode(self) -> str | None:
        values = [s.attributes.get("preset_mode") for s in self._member_states()]
        values = [v for v in values if v]
        if len(values) == len(self._members) and len(set(values)) == 1:
            return values[0]
        return None

    @property
    def supported_features(self) -> ClimateEntityFeature:
        flags = [s.attributes.get("supported_features", 0) for s in self._member_states()]
        if not flags:
            return ClimateEntityFeature(0)
        result = flags[0]
        for f in flags[1:]:
            result &= f
        return ClimateEntityFeature(result)

    async def async_set_temperature(self, **kwargs: Any) -> None:
        temperature = kwargs.get(ATTR_TEMPERATURE)
        if temperature is None:
            return
        await self.hass.services.async_call(
            "climate", "set_temperature", {"entity_id": self._members, ATTR_TEMPERATURE: temperature}, blocking=True
        )

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        await self.hass.services.async_call(
            "climate", "set_hvac_mode", {"entity_id": self._members, ATTR_HVAC_MODE: hvac_mode}, blocking=True
        )

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        await self.hass.services.async_call(
            "climate", "set_preset_mode", {"entity_id": self._members, "preset_mode": preset_mode}, blocking=True
        )
