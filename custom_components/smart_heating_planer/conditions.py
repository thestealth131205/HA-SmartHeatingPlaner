"""Bedingungen: Entity-Zustand schaltet das Thermostat auf Manuell/Aus, optional mit Boost.

Eine Bedingung gehört zu genau einem Thermostat. Ist sie erfüllt, wird das
Thermostat auf den gewählten Modus (Manuell mit Temperatur oder Aus) gestellt
und auf Wunsch Boost gestartet. Mit ``revert`` stellt die Integration den
vorherigen Zustand (Modus, Preset, Solltemperatur, Boost) wieder her, sobald
die Bedingung nicht mehr erfüllt ist.

Gearbeitet wird zustandsbasiert: Für jede Regel ist gespeichert, ob sie gerade
aktiv ist. Nach einem Neustart wird nur nachgezogen, was sich wirklich geändert
hat. ``unavailable``/``unknown`` ändern nichts.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from typing import Any

from homeassistant.const import (
    EVENT_HOMEASSISTANT_STARTED,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
)
from homeassistant.core import CALLBACK_TYPE, CoreState, Event, HomeAssistant, State, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.conditions"

OPERATORS = ("eq", "ne", "gt", "lt")
MODES = ("manual", "off")
_INVALID = (STATE_UNAVAILABLE, STATE_UNKNOWN)
# Presets, die "läuft nach Plan" bedeuten – dann wird beim Zurücksetzen keine Temperatur gesetzt
_PLAN_PRESETS = ("programming", "schedule", "auto", "program")


def _to_float(value: Any) -> float | None:
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def condition_met(rule: dict[str, Any], state: State) -> bool:
    op = rule["operator"]
    expected = str(rule.get("value", "")).strip()
    current = state.state
    if op in ("gt", "lt"):
        cur, exp = _to_float(current), _to_float(expected)
        if cur is None or exp is None:
            return False
        return cur > exp if op == "gt" else cur < exp
    cur, exp = _to_float(current), _to_float(expected)
    equal = cur == exp if cur is not None and exp is not None else current.lower() == expected.lower()
    return equal if op == "eq" else not equal


def validate_rule(data: dict[str, Any]) -> dict[str, Any]:
    """Bereinigt eine Regel aus dem Frontend, wirft ValueError bei Unsinn."""
    climate = str(data.get("climate", ""))
    entity = str(data.get("entity", ""))
    if not climate.startswith("climate."):
        raise ValueError("Thermostat fehlt")
    if "." not in entity or entity == climate:
        raise ValueError("Entity für die Bedingung fehlt")
    operator = data.get("operator", "eq")
    if operator not in OPERATORS:
        raise ValueError("Unbekannter Vergleich")
    value = str(data.get("value", "")).strip()
    if not value:
        raise ValueError("Wert für die Bedingung fehlt")
    if operator in ("gt", "lt") and _to_float(value) is None:
        raise ValueError("Für größer/kleiner muss der Wert eine Zahl sein")
    mode = data.get("mode", "manual")
    if mode not in MODES:
        raise ValueError("Unbekannter Modus")
    temperature = _to_float(data.get("temperature"))
    if mode == "manual" and temperature is None:
        raise ValueError("Temperatur fehlt")
    return {
        "id": str(data.get("id") or uuid.uuid4().hex[:12]),
        "climate": climate,
        "entity": entity,
        "operator": operator,
        "value": value,
        "mode": mode,
        "temperature": temperature,
        "boost": bool(data.get("boost")) and mode == "manual",
        "revert": bool(data.get("revert", True)),
        "enabled": bool(data.get("enabled", True)),
    }


class ConditionManager:
    """Speichert die Bedingungen, beobachtet ihre Entities und schaltet die Thermostate."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.rules: list[dict[str, Any]] = []
        # Laufzeitzustand, wird mitgespeichert:
        #   active:    climate → [rule_id, …] in Aktivierungsreihenfolge
        #   snapshots: climate → Zustand vor der ersten aktiven Bedingung
        self._active: dict[str, list[str]] = {}
        self._snapshots: dict[str, dict[str, Any]] = {}
        self._unsub_track: CALLBACK_TYPE | None = None
        self._unsub_start: CALLBACK_TYPE | None = None
        self._listeners: set[Callable[[], None]] = set()

    # ---------- Lebenszyklus ----------

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.rules = data.get("rules", [])
        self._active = data.get("active", {})
        self._snapshots = data.get("snapshots", {})
        self._track()
        if self.hass.state is CoreState.running:
            await self._evaluate_all()
        else:
            async def _started(_: Event) -> None:
                self._unsub_start = None
                await self._evaluate_all()

            self._unsub_start = self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _started)

    def async_unload(self) -> None:
        if self._unsub_track:
            self._unsub_track()
            self._unsub_track = None
        if self._unsub_start:
            self._unsub_start()
            self._unsub_start = None

    @callback
    def _save(self) -> None:
        self._store.async_delay_save(
            lambda: {"rules": self.rules, "active": self._active, "snapshots": self._snapshots}, 1
        )
        for listener in list(self._listeners):
            listener()

    @callback
    def subscribe(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    def as_dict(self) -> dict[str, Any]:
        active = {rid for ids in self._active.values() for rid in ids}
        return {"rules": [{**r, "active": r["id"] in active} for r in self.rules]}

    def _track(self) -> None:
        if self._unsub_track:
            self._unsub_track()
            self._unsub_track = None
        entities = sorted({r["entity"] for r in self.rules if r.get("enabled", True)})
        if entities:
            self._unsub_track = async_track_state_change_event(self.hass, entities, self._on_state)

    # ---------- Änderungen aus dem Frontend ----------

    async def async_save_rule(self, data: dict[str, Any]) -> dict[str, Any]:
        rule = validate_rule(data)
        old = next((r for r in self.rules if r["id"] == rule["id"]), None)
        if old:
            self.rules[self.rules.index(old)] = rule
            # Thermostat gewechselt oder deaktiviert: alte Regel sauber beenden
            if self._is_active(old) and (old["climate"] != rule["climate"] or not rule["enabled"]):
                await self._deactivate(old)
        else:
            self.rules.append(rule)
        self._track()
        self._save()
        await self._evaluate(rule, reapply=True)
        return rule

    async def async_delete_rule(self, rule_id: str) -> None:
        rule = next((r for r in self.rules if r["id"] == rule_id), None)
        if not rule:
            return
        if self._is_active(rule):
            await self._deactivate(rule)
        self.rules.remove(rule)
        self._track()
        self._save()

    # ---------- Auswertung ----------

    def _is_active(self, rule: dict[str, Any]) -> bool:
        return rule["id"] in self._active.get(rule["climate"], [])

    async def _evaluate_all(self) -> None:
        # Regeln, deren Thermostat verschwunden ist oder die gelöscht wurden, aufräumen
        known = {r["id"] for r in self.rules}
        for climate, ids in list(self._active.items()):
            self._active[climate] = [i for i in ids if i in known]
            if not self._active[climate]:
                self._active.pop(climate)
                self._snapshots.pop(climate, None)
        for rule in list(self.rules):
            await self._evaluate(rule)

    @callback
    def _on_state(self, event: Event) -> None:
        entity_id = event.data["entity_id"]
        for rule in self.rules:
            if rule["entity"] == entity_id:
                self.hass.async_create_task(self._evaluate(rule))

    async def _evaluate(self, rule: dict[str, Any], reapply: bool = False) -> None:
        active = self._is_active(rule)
        if not rule.get("enabled", True):
            if active:
                await self._deactivate(rule)
            return
        state = self.hass.states.get(rule["entity"])
        if state is None or state.state in _INVALID:
            return
        met = condition_met(rule, state)
        if met and not active:
            await self._activate(rule)
        elif met and reapply:
            await self._apply(rule)
        elif not met and active:
            await self._deactivate(rule)

    async def _activate(self, rule: dict[str, Any]) -> None:
        climate = rule["climate"]
        if not self._active.get(climate):
            self._snapshots[climate] = self._snapshot(climate)
        self._active.setdefault(climate, []).append(rule["id"])
        self._save()
        _LOGGER.info("Bedingung %s erfüllt (%s) – schalte %s", rule["id"], rule["entity"], climate)
        await self._apply(rule)

    async def _deactivate(self, rule: dict[str, Any]) -> None:
        climate = rule["climate"]
        ids = self._active.get(climate, [])
        if rule["id"] in ids:
            ids.remove(rule["id"])
        remaining = [r for i in ids for r in self.rules if r["id"] == i]
        snapshot = self._snapshots.get(climate)
        if not ids:
            self._active.pop(climate, None)
            self._snapshots.pop(climate, None)
        self._save()
        if remaining:
            # Eine andere Bedingung für dasselbe Thermostat gilt noch – die übernimmt
            if rule.get("boost") and not remaining[-1].get("boost"):
                await self._set_boost(climate, False)
            await self._apply(remaining[-1])
        elif rule.get("revert") and snapshot:
            _LOGGER.info("Bedingung %s nicht mehr erfüllt – stelle %s wieder her", rule["id"], climate)
            await self._restore(climate, snapshot, boost_was_set=rule.get("boost", False))

    # ---------- Thermostat schalten ----------

    def _snapshot(self, climate: str) -> dict[str, Any]:
        st = self.hass.states.get(climate)
        if st is None:
            return {}
        boost = self._boost(climate)
        return {
            "state": st.state,
            "preset_mode": st.attributes.get("preset_mode"),
            "temperature": st.attributes.get("temperature"),
            "boost": self._boost_on(boost) if boost else False,
        }

    async def _call(self, domain: str, service: str, data: dict[str, Any]) -> None:
        try:
            await self.hass.services.async_call(domain, service, data, blocking=True)
        except (HomeAssistantError, ValueError) as err:
            _LOGGER.warning("%s.%s für %s fehlgeschlagen: %s", domain, service, data.get("entity_id"), err)

    async def _apply(self, rule: dict[str, Any]) -> None:
        climate = rule["climate"]
        st = self.hass.states.get(climate)
        if st is None:
            _LOGGER.warning("Thermostat %s nicht gefunden", climate)
            return
        hvac_modes = st.attributes.get("hvac_modes") or []
        presets = st.attributes.get("preset_modes") or []
        if rule["mode"] == "off":
            if "off" in hvac_modes:
                await self._call("climate", "set_hvac_mode", {"entity_id": climate, "hvac_mode": "off"})
            return
        # Manuell: Moes & Co. über Preset "manual", Sonoff & Co. über hvac_mode "heat"
        if "manual" in presets:
            if st.attributes.get("preset_mode") != "manual":
                await self._call("climate", "set_preset_mode", {"entity_id": climate, "preset_mode": "manual"})
        elif "heat" in hvac_modes and st.state != "heat":
            await self._call("climate", "set_hvac_mode", {"entity_id": climate, "hvac_mode": "heat"})
        if rule.get("temperature") is not None:
            await self._call("climate", "set_temperature", {"entity_id": climate, "temperature": rule["temperature"]})
        if rule.get("boost"):
            await self._set_boost(climate, True)

    async def _restore(self, climate: str, snap: dict[str, Any], boost_was_set: bool) -> None:
        st = self.hass.states.get(climate)
        if st is None or not snap:
            return
        if boost_was_set and not snap.get("boost"):
            await self._set_boost(climate, False)
        presets = st.attributes.get("preset_modes") or []
        hvac_modes = st.attributes.get("hvac_modes") or []
        preset = snap.get("preset_mode")
        if preset and preset in presets and preset != "boost" and preset != st.attributes.get("preset_mode"):
            await self._call("climate", "set_preset_mode", {"entity_id": climate, "preset_mode": preset})
        state = snap.get("state")
        if state in hvac_modes and state != st.state:
            await self._call("climate", "set_hvac_mode", {"entity_id": climate, "hvac_mode": state})
        # Nur bei manuellem Betrieb die alte Solltemperatur zurück – im Plan-Modus gibt der Plan sie vor
        manual = state not in ("auto", "off", None) and (preset or "") not in _PLAN_PRESETS
        if manual and snap.get("temperature") is not None:
            await self._call("climate", "set_temperature", {"entity_id": climate, "temperature": snap["temperature"]})

    # Boost wie in der Karte: Schalter (Moes …), Auswahl "temporary mode" (Sonoff) oder Preset "boost"
    def _boost(self, climate: str) -> dict[str, str] | None:
        states = self.hass.states
        registry = er.async_get(self.hass)
        entry = registry.async_get(climate)
        candidates: list[str] = []
        if entry and entry.device_id:
            candidates = [e.entity_id for e in er.async_entries_for_device(registry, entry.device_id)]
        object_id = climate.split(".", 1)[1]
        candidates += [f"switch.{object_id}_boost_heating", f"select.{object_id}_temporary_mode_mode"]
        for eid in candidates:
            if eid.startswith("switch.") and "boost" in eid and states.get(eid):
                return {"kind": "switch", "id": eid}
        for eid in candidates:
            st = states.get(eid)
            if eid.startswith("select.") and eid.endswith("temporary_mode_mode") and st and "boost" in (st.attributes.get("options") or []):
                return {"kind": "select", "id": eid}
        st = states.get(climate)
        if st and "boost" in (st.attributes.get("preset_modes") or []):
            return {"kind": "preset", "id": climate}
        return None

    def _boost_on(self, boost: dict[str, str]) -> bool:
        st = self.hass.states.get(boost["id"])
        if st is None:
            return False
        if boost["kind"] == "switch":
            return st.state == "on"
        if boost["kind"] == "select":
            return st.state == "boost"
        return st.attributes.get("preset_mode") == "boost"

    async def _set_boost(self, climate: str, on: bool) -> None:
        boost = self._boost(climate)
        if not boost or self._boost_on(boost) == on:
            return
        if boost["kind"] == "switch":
            await self._call("switch", "turn_on" if on else "turn_off", {"entity_id": boost["id"]})
        elif boost["kind"] == "select":
            options = self.hass.states.get(boost["id"]).attributes.get("options") or []
            off = "disabled" if "disabled" in options else next((o for o in options if o != "boost"), None)
            if on or off:
                await self._call("select", "select_option", {"entity_id": boost["id"], "option": "boost" if on else off})
        else:
            presets = self.hass.states.get(climate).attributes.get("preset_modes") or []
            back = next((p for p in ("none", "comfort", "home", "eco") if p in presets), None)
            if on or back:
                await self._call("climate", "set_preset_mode", {"entity_id": climate, "preset_mode": "boost" if on else back})
