/*
 * Smart Heating Planer – Thermostat-Karte mit Wochenplan zum Antippen.
 *
 * Liest und schreibt den Wochenplan direkt im Thermostat über die
 * Zigbee2MQTT-Entities text.<name>_weekly_schedule_<tag>.
 * Format pro Tag: "00:00/18 07:00/21 13:00/20 …", erster Schaltpunkt immer
 * 00:00. Wie viele Schaltpunkte und welcher Temperaturbereich erlaubt sind,
 * hängt vom Thermostat-Modell ab (siehe PROFILES).
 *
 * Zwei Karten:
 *  - custom:smart-heating-planer-card          Thermostat + Wochenplan
 *  - custom:smart-heating-planer-compact-card  nur Thermostat, Tipp auf die Temperatur öffnet den Wochenplan
 * Beide zeigen unten rechts den Boost-Knopf (Rakete), sofern das Thermostat Boost kann.
 */

const VERSION = "1.2.0";

const DAYS = [
  { key: "monday", short: "Mo", long: "Montag" },
  { key: "tuesday", short: "Di", long: "Dienstag" },
  { key: "wednesday", short: "Mi", long: "Mittwoch" },
  { key: "thursday", short: "Do", long: "Donnerstag" },
  { key: "friday", short: "Fr", long: "Freitag" },
  { key: "saturday", short: "Sa", long: "Samstag" },
  { key: "sunday", short: "So", long: "Sonntag" },
];
// Index wie Date.getDay(): 0 = Sonntag
const JS_DAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WORKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
const WEEKEND = ["saturday", "sunday"];

const TEMP_STEP = 0.5;

// Grenzen je Modell, wie sie die Zigbee2MQTT-Konverter prüfen (model_id aus der Geräte-Registry).
// pad: Tages-String auf maxSlots mit dem letzten Schaltpunkt auffüllen, so meldet ihn das Gerät selbst.
const PROFILES = {
  "TRV-ZBT": { maxSlots: 12, min: 5, max: 30, pad: true },
  "TRV-ZBL": { maxSlots: 12, min: 5, max: 30, pad: true },
  "TP-WGZBA": { maxSlots: 12, min: 5, max: 30, pad: true },
  TRVZB: { maxSlots: 6, min: 4, max: 35, pad: false },
  "BTH-RA": { maxSlots: 10, min: 5, max: 30, pad: false },
};
// Unbekannte Modelle: vorsichtig, keine Wiederholungen (manche Konverter lehnen doppelte Uhrzeiten ab)
const DEFAULT_PROFILE = { maxSlots: 6, min: 5, max: 30, pad: false };
const SAVED_TIMEOUT_MS = 30000;
const TARGET_DEBOUNCE_MS = 900;
const PROGRAM_TIMEOUT_MS = 30000;
const BOOST_TIMEOUT_MS = 30000;
// Preset, auf das beim Beenden zurückgeschaltet wird, wenn der vorherige unbekannt ist
const PRESET_FALLBACKS = ["none", "comfort", "home", "eco"];

const HVAC_LABELS = { off: "Aus", auto: "Plan", heat: "Manuell" };
const HVAC_ICONS = { off: "mdi:power", auto: "mdi:calendar-clock", heat: "mdi:hand-back-right" };
const ACTION_LABELS = { heating: "Heizt", idle: "Leerlauf", off: "Aus", preheating: "Vorheizen" };

const pad = (n) => String(n).padStart(2, "0");
const toHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const toMinutes = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : null;
};
const clampTemp = (t, p) => Math.min(p.max, Math.max(p.min, Math.round(t / TEMP_STEP) * TEMP_STEP));
const fmtTemp = (t) =>
  t == null || isNaN(t) ? "–" : Number(t).toLocaleString("de-DE", { minimumFractionDigits: Number(t) % 1 ? 1 : 0, maximumFractionDigits: 1 });
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Farbe pro Temperatur: kalt blau → warm orange/rot
const tempColor = (t) => {
  const hue = Math.max(10, Math.min(215, 215 - ((t - 15) / 10) * 205));
  return `hsl(${hue}, 70%, 48%)`;
};

/** "00:00/18 07:00/21 22:00/19 22:00/19 …" → [{t, temp}] ohne Wiederholungen. */
function parseSchedule(str) {
  if (typeof str !== "string" || !str.trim()) return null;
  const byTime = new Map();
  for (const part of str.trim().split(/\s+/)) {
    const m = /^(\d{1,2}):(\d{2})\/(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) return null;
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (!byTime.has(t)) byTime.set(t, Number(m[3]));
  }
  const slots = [...byTime].map(([t, temp]) => ({ t, temp })).sort((a, b) => a.t - b.t);
  if (!slots.length) return null;
  // Manche Thermostate (z. B. Bosch) erlauben einen Tag ohne 00:00. Die Nacht läuft dann mit
  // der letzten Temperatur weiter, die Karte zeigt sie als festen 00:00-Schaltpunkt.
  if (slots[0].t !== 0) slots.unshift({ t: 0, temp: slots[slots.length - 1].temp });
  return slots;
}

/** [{t, temp}] → Tages-String, bei pad aufgefüllt auf maxSlots (wie das Thermostat ihn selbst meldet). */
function serializeSchedule(slots, profile) {
  const parts = [...slots].sort((a, b) => a.t - b.t).map((s) => `${toHHMM(s.t)}/${s.temp}`);
  if (profile.pad) while (parts.length < profile.maxSlots) parts.push(parts[parts.length - 1]);
  return parts.join(" ");
}

const cloneSlots = (slots) => slots.map((s) => ({ ...s }));

class SmartHeatingPlanerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._day = JS_DAY[new Date().getDay()];
    this._drafts = {}; // day → {slots, saved, savedAt}
    this._copyOpen = false;
    this._copyTargets = new Set();
    this._saving = false;
    this._message = null; // {text, error}
    this._pendingTarget = null; // {value, at}
    this._watchKey = null;
    this._deferredRender = false;
    this._pendingProgram = null; // {group, at}
    this._pendingBoost = null; // {value, at}
    this._presetBeforeBoost = null;
    this._compact = false;
    this._pointerDown = false;
    this._lastHtml = null;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    // Nicht neu zeichnen, solange ein Finger auf der Karte liegt – sonst wird der Knopf
    // zwischen Antippen und Loslassen ersetzt und der Tipp geht verloren
    this.shadowRoot.addEventListener("pointerdown", () => (this._pointerDown = true));
    const release = () => {
      this._pointerDown = false;
      if (this._deferredRender) setTimeout(() => this._render(), 50);
    };
    this.shadowRoot.addEventListener("pointerup", release);
    this.shadowRoot.addEventListener("pointercancel", release);
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("focusout", () => {
      if (this._deferredRender) setTimeout(() => this._render(), 0);
    });
  }

  static getConfigElement() {
    return document.createElement("smart-heating-planer-card-editor");
  }

  static getStubConfig(hass) {
    const climate = Object.keys(hass.states).find((id) => id.startsWith("climate."));
    return { entity: climate || "" };
  }

  setConfig(config) {
    if (!config || !config.entity || !String(config.entity).startsWith("climate.")) {
      throw new Error("Bitte ein Thermostat (climate.*) als entity angeben");
    }
    this._config = { ...config };
    this._watchKey = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._entities = this._findEntities();
    this._expireSavedDrafts();
    const key = this._computeWatchKey();
    if (key === this._watchKey) return;
    this._watchKey = key;
    this._render();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 9;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  // ---------- Entities ----------

  _findEntities() {
    const hass = this._hass;
    const climate = this._config.entity;
    const out = { climate, days: {}, activeGroup: null, editGroup: null };
    const registry = hass.entities || {};
    const deviceId = registry[climate]?.device_id;
    const model = (deviceId && hass.devices?.[deviceId]?.model_id) || null;
    const profile = { ...(PROFILES[model] || DEFAULT_PROFILE) };
    if (Number(this._config.max_slots) > 0) profile.maxSlots = Number(this._config.max_slots);
    out.model = model;
    out.profile = profile;
    if (deviceId) {
      for (const [id, entry] of Object.entries(registry)) {
        if (entry.device_id !== deviceId) continue;
        const day = /^text\..*weekly_schedule_([a-z]+)$/.exec(id);
        if (day && DAYS.some((d) => d.key === day[1])) out.days[day[1]] = id;
        else if (/^select\..*schedule_active_group$/.test(id)) out.activeGroup = id;
        else if (/^select\..*schedule_group_to_edit$/.test(id)) out.editGroup = id;
        else if (/^switch\..*boost/.test(id)) out.boostSwitch = id;
        else if (/^select\..*temporary_mode_mode$/.test(id)) out.boostSelect = id;
        else if (/^sensor\..*boost.*countdown$/.test(id)) out.boostCountdown = id;
      }
    }
    // Fallback über den Namen, falls die Entity-Registry nichts liefert
    const objectId = climate.split(".")[1];
    for (const d of DAYS) {
      const guess = `text.${objectId}_weekly_schedule_${d.key}`;
      if (!out.days[d.key] && hass.states[guess]) out.days[d.key] = guess;
    }
    if (!out.activeGroup && hass.states[`select.${objectId}_schedule_active_group`])
      out.activeGroup = `select.${objectId}_schedule_active_group`;
    if (!out.editGroup && hass.states[`select.${objectId}_schedule_group_to_edit`])
      out.editGroup = `select.${objectId}_schedule_group_to_edit`;
    if (!out.boostSwitch && hass.states[`switch.${objectId}_boost_heating`]) out.boostSwitch = `switch.${objectId}_boost_heating`;
    if (!out.boostSelect && hass.states[`select.${objectId}_temporary_mode_mode`])
      out.boostSelect = `select.${objectId}_temporary_mode_mode`;
    if (!out.boostCountdown && hass.states[`sensor.${objectId}_boost_heating_countdown`])
      out.boostCountdown = `sensor.${objectId}_boost_heating_countdown`;
    out.boost = this._resolveBoost(out);
    return out;
  }

  // Boost je nach Thermostat: Schalter (Moes, Bosch …), Auswahl "temporary mode" (Sonoff) oder Preset "boost"
  _resolveBoost(e) {
    const states = this._hass.states;
    const hasBoostOption = (id) => (states[id]?.attributes?.options || []).includes("boost");
    const forced = this._config.boost_entity;
    if (forced) {
      if (forced.startsWith("select.")) return hasBoostOption(forced) ? { kind: "select", id: forced } : null;
      if (/^(switch|input_boolean)\./.test(forced)) return { kind: "switch", id: forced };
      return null;
    }
    if (e.boostSwitch) return { kind: "switch", id: e.boostSwitch };
    if (e.boostSelect && hasBoostOption(e.boostSelect)) return { kind: "select", id: e.boostSelect };
    if ((states[e.climate]?.attributes?.preset_modes || []).includes("boost")) return { kind: "preset", id: e.climate };
    return null;
  }

  _computeWatchKey() {
    const e = this._entities;
    const ids = [e.climate, ...Object.values(e.days), e.activeGroup, e.editGroup, e.boost?.id, e.boostCountdown].filter(Boolean);
    return ids.map((id) => this._hass.states[id]?.last_updated ?? "-").join("|") + `|${new Date().getMinutes()}`;
  }

  _deviceSlots(day) {
    const id = this._entities.days[day];
    const state = id && this._hass.states[id];
    return state ? parseSchedule(state.state) : null;
  }

  _slots(day) {
    const draft = this._drafts[day];
    if (draft) return draft.slots;
    return this._deviceSlots(day);
  }

  _isDirty(day) {
    const draft = this._drafts[day];
    if (!draft || draft.saved) return false;
    const device = this._deviceSlots(day);
    return !device || serializeSchedule(draft.slots, this._entities.profile) !== serializeSchedule(device, this._entities.profile);
  }

  _dirtyDays() {
    return DAYS.map((d) => d.key).filter((k) => this._isDirty(k));
  }

  _editableSlots(day) {
    const draft = this._drafts[day];
    if (draft && !draft.saved) return draft.slots;
    const base = this._slots(day);
    if (!base) return null;
    this._drafts[day] = { slots: cloneSlots(base), saved: false };
    return this._drafts[day].slots;
  }

  _expireSavedDrafts() {
    for (const [day, draft] of Object.entries(this._drafts)) {
      const device = this._deviceSlots(day);
      if (draft.saved) {
        if (device && serializeSchedule(device, this._entities.profile) === serializeSchedule(draft.slots, this._entities.profile)) delete this._drafts[day];
        else if (Date.now() - draft.savedAt > SAVED_TIMEOUT_MS) {
          delete this._drafts[day];
          this._message = { text: "Das Thermostat hat den neuen Plan nicht bestätigt. Bitte nochmal speichern.", error: true };
        }
      } else if (!this._isDirty(day)) {
        delete this._drafts[day];
      }
    }
  }

  // ---------- Aktionen ----------

  _call(domain, service, data) {
    return this._hass.callService(domain, service, data);
  }

  _currentTarget() {
    const st = this._hass.states[this._config.entity];
    if (this._pendingTarget) {
      const real = st?.attributes?.temperature;
      if (real === this._pendingTarget.value || Date.now() - this._pendingTarget.at > 15000) this._pendingTarget = null;
      else return this._pendingTarget.value;
    }
    return st?.attributes?.temperature;
  }

  _changeTarget(delta) {
    const st = this._hass.states[this._config.entity];
    const step = st.attributes.target_temp_step || TEMP_STEP;
    const min = st.attributes.min_temp ?? this._entities.profile.min;
    const max = st.attributes.max_temp ?? this._entities.profile.max;
    const cur = Number(this._currentTarget() ?? 20);
    const next = Math.min(max, Math.max(min, Math.round((cur + delta * step) / step) * step));
    this._pendingTarget = { value: next, at: Date.now() };
    clearTimeout(this._targetTimer);
    // Mehrfaches Tippen sammeln, damit das batteriebetriebene Thermostat nur einen Befehl bekommt
    this._targetTimer = setTimeout(() => {
      this._call("climate", "set_temperature", { entity_id: this._config.entity, temperature: next }).catch((err) =>
        this._showError(err),
      );
    }, TARGET_DEBOUNCE_MS);
    this._render();
  }

  async _setHvacMode(mode) {
    try {
      await this._call("climate", "set_hvac_mode", { entity_id: this._config.entity, hvac_mode: mode });
    } catch (err) {
      this._showError(err);
    }
  }

  // Gewähltes Programm sofort anzeigen, bis das Thermostat beide Auswahlen bestätigt hat
  _displayedProgram() {
    const { activeGroup, editGroup } = this._entities;
    const active = this._hass.states[activeGroup]?.state;
    const edit = editGroup && this._hass.states[editGroup]?.state;
    const p = this._pendingProgram;
    if (p) {
      const confirmed = active === p.group && (!editGroup || edit === p.group);
      if (confirmed || Date.now() - p.at > PROGRAM_TIMEOUT_MS) {
        this._pendingProgram = null;
        if (!confirmed) this._message = { text: `Das Thermostat hat Programm ${p.group} nicht bestätigt. Bitte nochmal tippen.`, error: true };
        else this._message = null;
      } else {
        return { group: p.group, pending: true };
      }
    }
    return { group: active, pending: false };
  }

  async _selectProgram(group) {
    if (this._displayedProgram().group === group) return;
    if (this._dirtyDays().length && !confirm("Ungespeicherte Änderungen verwerfen und Programm wechseln?")) return;
    this._drafts = {};
    this._pendingProgram = { group, at: Date.now() };
    this._message = null;
    this._render();
    clearTimeout(this._programTimer);
    this._programTimer = setTimeout(() => this._render(), PROGRAM_TIMEOUT_MS + 100);
    const { activeGroup, editGroup } = this._entities;
    try {
      // Beide Befehle gleichzeitig, damit sie im selben Aufwach-Fenster des Thermostats ankommen
      await Promise.all(
        [activeGroup, editGroup].filter(Boolean).map((id) => this._call("select", "select_option", { entity_id: id, option: group })),
      );
    } catch (err) {
      this._pendingProgram = null;
      this._showError(err);
    }
  }

  async _editActiveProgram() {
    const { activeGroup, editGroup } = this._entities;
    const active = this._hass.states[activeGroup]?.state;
    if (!active || !editGroup) return;
    this._drafts = {};
    try {
      await this._call("select", "select_option", { entity_id: editGroup, option: active });
    } catch (err) {
      this._showError(err);
    }
  }

  _boostActive() {
    const b = this._entities.boost;
    const st = b && this._hass.states[b.id];
    if (!st) return false;
    if (b.kind === "switch") return st.state === "on";
    if (b.kind === "select") return st.state === "boost";
    return st.attributes?.preset_mode === "boost";
  }

  // Boost sofort umschalten, bis das (oft schlafende) Thermostat den Wechsel bestätigt
  _displayedBoost() {
    const real = this._boostActive();
    const p = this._pendingBoost;
    if (p) {
      const confirmed = real === p.value;
      if (confirmed || Date.now() - p.at > BOOST_TIMEOUT_MS) {
        this._pendingBoost = null;
        if (!confirmed) this._message = { text: "Das Thermostat hat den Boost nicht bestätigt. Bitte nochmal tippen.", error: true };
      } else {
        return { on: p.value, pending: true };
      }
    }
    return { on: real, pending: false };
  }

  async _toggleBoost() {
    const b = this._entities.boost;
    if (!b) return;
    const on = !this._displayedBoost().on;
    this._pendingBoost = { value: on, at: Date.now() };
    this._message = null;
    this._render();
    clearTimeout(this._boostTimer);
    this._boostTimer = setTimeout(() => this._render(), BOOST_TIMEOUT_MS + 100);
    try {
      if (b.kind === "switch") {
        await this._call(b.id.split(".")[0], on ? "turn_on" : "turn_off", { entity_id: b.id });
      } else if (b.kind === "select") {
        const options = this._hass.states[b.id]?.attributes?.options || [];
        const off = options.includes("disabled") ? "disabled" : options.find((o) => o !== "boost");
        await this._call("select", "select_option", { entity_id: b.id, option: on ? "boost" : off });
      } else {
        const a = this._hass.states[b.id]?.attributes || {};
        const presets = a.preset_modes || [];
        if (on && a.preset_mode && a.preset_mode !== "boost") this._presetBeforeBoost = a.preset_mode;
        const back = [this._presetBeforeBoost, ...PRESET_FALLBACKS].find((m) => m && presets.includes(m)) || presets.find((m) => m !== "boost");
        await this._call("climate", "set_preset_mode", { entity_id: b.id, preset_mode: on ? "boost" : back });
      }
    } catch (err) {
      this._pendingBoost = null;
      this._showError(err);
    }
  }

  _openPlanner() {}

  _addSlot() {
    const slots = this._editableSlots(this._day);
    if (!slots || slots.length >= this._entities.profile.maxSlots) return;
    // In die größte Lücke einfügen, auf 15 Minuten gerundet
    let best = null;
    slots.forEach((s, i) => {
      const end = i + 1 < slots.length ? slots[i + 1].t : 1440;
      if (!best || end - s.t > best.len) best = { start: s.t, len: end - s.t, temp: s.temp };
    });
    if (!best || best.len < 30) {
      this._message = { text: "Kein Platz für einen weiteren Zeitpunkt.", error: true };
      return this._render();
    }
    let t = best.start + Math.round(best.len / 2 / 15) * 15;
    if (t <= best.start) t = best.start + 15;
    slots.push({ t, temp: best.temp });
    slots.sort((a, b) => a.t - b.t);
    this._message = null;
    this._render();
  }

  _removeSlot(index) {
    const slots = this._editableSlots(this._day);
    if (!slots || index <= 0 || slots.length <= 1) return;
    slots.splice(index, 1);
    this._render();
  }

  _changeSlotTemp(index, delta) {
    const slots = this._editableSlots(this._day);
    if (!slots || !slots[index]) return;
    slots[index].temp = clampTemp(slots[index].temp + delta * TEMP_STEP, this._entities.profile);
    this._render();
  }

  _changeSlotTime(index, value) {
    const slots = this._editableSlots(this._day);
    const t = toMinutes(value);
    if (!slots || !slots[index] || index === 0) return;
    if (t == null || t === 0) {
      this._message = { text: "Der erste Zeitpunkt des Tages ist immer 00:00.", error: true };
    } else if (slots.some((s, i) => i !== index && s.t === t)) {
      this._message = { text: `Um ${toHHMM(t)} gibt es schon einen Zeitpunkt.`, error: true };
    } else {
      slots[index].t = t;
      slots.sort((a, b) => a.t - b.t);
      this._message = null;
    }
    this._render();
  }

  _applyCopy() {
    const source = this._slots(this._day);
    if (!source) return;
    for (const day of this._copyTargets) {
      if (day === this._day) continue;
      this._drafts[day] = { slots: cloneSlots(source), saved: false };
    }
    const n = this._copyTargets.size;
    this._copyOpen = false;
    this._copyTargets = new Set();
    this._message = n ? { text: `Auf ${n} ${n === 1 ? "Tag" : "Tage"} kopiert – jetzt speichern.` } : null;
    this._render();
  }

  _discard() {
    this._drafts = {};
    this._message = null;
    this._render();
  }

  async _save() {
    const days = this._dirtyDays();
    if (!days.length || this._saving) return;
    this._saving = true;
    this._message = null;
    this._render();
    try {
      for (const day of days) {
        const entity = this._entities.days[day];
        const draft = this._drafts[day];
        await this._call("text", "set_value", { entity_id: entity, value: serializeSchedule(draft.slots, this._entities.profile) });
        draft.saved = true;
        draft.savedAt = Date.now();
        // Kleine Pause, damit das Thermostat die Befehle nacheinander verarbeitet
        await new Promise((r) => setTimeout(r, 300));
      }
      this._message = { text: `Gespeichert (${days.length} ${days.length === 1 ? "Tag" : "Tage"}).` };
    } catch (err) {
      this._showError(err, false);
    }
    this._saving = false;
    this._render();
  }

  _showError(err, render = true) {
    this._message = { text: `Fehler: ${err?.message || err}`, error: true };
    if (render) this._render();
  }

  _moreInfo() {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", { detail: { entityId: this._config.entity }, bubbles: true, composed: true }),
    );
  }

  // ---------- Events ----------

  _onClick(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const { action, value } = el.dataset;
    const index = Number(el.dataset.index);
    switch (action) {
      case "target-down": return this._changeTarget(-1);
      case "target-up": return this._changeTarget(1);
      case "hvac": return this._setHvacMode(value);
      case "program": return this._selectProgram(value);
      case "edit-active": return this._editActiveProgram();
      case "day":
        this._day = value;
        this._copyOpen = false;
        return this._render();
      case "temp-down": return this._changeSlotTemp(index, -1);
      case "temp-up": return this._changeSlotTemp(index, 1);
      case "remove": return this._removeSlot(index);
      case "add": return this._addSlot();
      case "copy-toggle":
        this._copyOpen = !this._copyOpen;
        this._copyTargets = new Set();
        return this._render();
      case "copy-day":
        this._copyTargets.has(value) ? this._copyTargets.delete(value) : this._copyTargets.add(value);
        return this._render();
      case "copy-preset": {
        const set = value === "work" ? WORKDAYS : value === "weekend" ? WEEKEND : DAYS.map((d) => d.key);
        this._copyTargets = new Set(set.filter((d) => d !== this._day));
        return this._render();
      }
      case "copy-apply": return this._applyCopy();
      case "discard": return this._discard();
      case "save": return this._save();
      case "more-info": return this._moreInfo();
      case "boost": return this._toggleBoost();
      case "open-planner": return this._openPlanner();
      case "dismiss":
        this._message = null;
        return this._render();
    }
  }

  _onChange(ev) {
    const el = ev.target;
    if (el.dataset.action === "time") this._changeSlotTime(Number(el.dataset.index), el.value);
  }

  // ---------- Darstellung ----------

  _render() {
    if (!this._hass || !this._config) return;
    // Nicht neu zeichnen, während eine Uhrzeit eingegeben wird (sonst schließt sich der Picker)
    const active = this.shadowRoot.activeElement;
    if (active && active.tagName === "INPUT") {
      this._deferredRender = true;
      return;
    }
    if (this._pointerDown) {
      this._deferredRender = true;
      return;
    }
    this._deferredRender = false;

    const st = this._hass.states[this._config.entity];
    const html = st
      ? `${STYLE}<ha-card class="${this._compact ? "compact" : ""}">${this._renderThermostat(st)}${
          this._compact ? this._renderMessage() : this._renderPlanner()
        }</ha-card>`
      : `${STYLE}<ha-card><div class="warn">Entity ${esc(this._config.entity)} nicht gefunden.</div></ha-card>`;
    // Unveränderte Karte nicht neu aufbauen (Thermostat meldet sich oft mehrmals pro Sekunde)
    if (html === this._lastHtml) return;
    this._lastHtml = html;
    this.shadowRoot.innerHTML = html;
  }

  _renderThermostat(st) {
    const a = st.attributes;
    const name = this._config.name || a.friendly_name || this._config.entity;
    const action = a.hvac_action;
    const target = this._currentTarget();
    const modes = (a.hvac_modes || []).filter((m) => HVAC_LABELS[m]);
    const unavailable = st.state === "unavailable" || st.state === "unknown";
    const isOff = st.state === "off";
    const now = this._planNow();

    return `
      <div class="head">
        <button class="title" data-action="more-info" title="Details">
          <ha-icon icon="mdi:radiator"></ha-icon>
          <span>${esc(name)}</span>
        </button>
        <span class="badge ${esc(action || st.state)}">${esc(ACTION_LABELS[action] || (unavailable ? "Nicht erreichbar" : st.state))}</span>
      </div>
      <div class="thermo">
        <button class="round" data-action="target-down" ${isOff || unavailable ? "disabled" : ""} aria-label="Kälter">
          <ha-icon icon="mdi:minus"></ha-icon>
        </button>
        ${this._compact ? `<button class="target tap" data-action="open-planner" aria-label="Wochenplan öffnen">` : `<div class="target">`}
          <div class="big">${isOff ? "Aus" : `${fmtTemp(target)}<small>°C</small>`}</div>
          <div class="current">Ist ${fmtTemp(a.current_temperature)} °C${
            this._compact ? ` <ha-icon class="hint-icon" icon="mdi:calendar-week"></ha-icon>` : ""
          }</div>
        ${this._compact ? `</button>` : `</div>`}
        <button class="round" data-action="target-up" ${isOff || unavailable ? "disabled" : ""} aria-label="Wärmer">
          <ha-icon icon="mdi:plus"></ha-icon>
        </button>
      </div>
      <div class="modes">
        ${modes
          .map(
            (m) => `<button class="mode ${st.state === m ? "on" : ""}" data-action="hvac" data-value="${m}">
              <ha-icon icon="${HVAC_ICONS[m]}"></ha-icon>${HVAC_LABELS[m]}</button>`,
          )
          .join("")}
      </div>
      ${this._renderFoot(st, now)}
    `;
  }

  // Zeile unter den Modus-Knöpfen: nächste Planänderung, rechts daneben die Boost-Rakete
  _renderFoot(st, now) {
    const b = this._entities.boost;
    const plan = st.state === "auto" && now ? now : "";
    if (!b) return plan ? `<div class="plan-now">${plan}</div>` : "";
    // Nur sperren, wenn die Boost-Entity selbst weg ist – das Thermostat kann noch "unbekannt" melden
    const unavailable = this._hass.states[b.id]?.state === "unavailable";
    const shown = this._displayedBoost();
    const cd = shown.on && this._entities.boostCountdown && this._hass.states[this._entities.boostCountdown];
    const left = cd && Number(cd.state) > 0 ? `${cd.state} ${cd.attributes.unit_of_measurement || ""}`.trim() : "";
    return `
      <div class="foot">
        <span></span>
        <div class="plan-now">${plan}</div>
        <button class="boost ${shown.on ? "on" : ""} ${shown.pending ? "pending" : ""}" data-action="boost"
          aria-pressed="${shown.on}" title="${shown.on ? "Boost beenden" : "Boost starten"}" ${unavailable ? "disabled" : ""}>
          <ha-icon icon="mdi:rocket-launch"></ha-icon>${left ? `<span>${esc(left)}</span>` : ""}
        </button>
      </div>
    `;
  }

  _renderMessage() {
    return this._message
      ? `<div class="msg ${this._message.error ? "error" : ""}" data-action="dismiss">${esc(this._message.text)}</div>`
      : "";
  }

  _planNow() {
    const today = JS_DAY[new Date().getDay()];
    const slots = this._deviceSlots(today);
    if (!slots) return "";
    const d = new Date();
    const mins = d.getHours() * 60 + d.getMinutes();
    let i = slots.length - 1;
    while (i > 0 && slots[i].t > mins) i--;
    const next = slots[i + 1];
    if (next) return `Laut Plan ${fmtTemp(slots[i].temp)} °C bis ${toHHMM(next.t)}, danach ${fmtTemp(next.temp)} °C`;
    return `Laut Plan ${fmtTemp(slots[i].temp)} °C bis Mitternacht`;
  }

  _renderPlanner() {
    const e = this._entities;
    if (!Object.keys(e.days).length) {
      return `<div class="warn">Für dieses Thermostat wurden keine Wochenplan-Entities (text.*_weekly_schedule_*) gefunden.</div>${this._renderMessage()}`;
    }
    const today = JS_DAY[new Date().getDay()];
    const slots = this._slots(this._day);
    const dirty = this._dirtyDays();
    const dayLong = DAYS.find((d) => d.key === this._day).long;

    return `
      <div class="section-title">Wochenplan</div>
      ${this._renderPrograms()}
      <div class="days">
        ${DAYS.map(
          (d) => `<button class="day ${d.key === this._day ? "on" : ""} ${d.key === today ? "today" : ""}"
            data-action="day" data-value="${d.key}">${d.short}${this._isDirty(d.key) ? '<i class="dot"></i>' : ""}</button>`,
        ).join("")}
      </div>
      ${
        slots
          ? `${this._renderTimeline(slots)}
             <div class="slots">${slots.map((s, i) => this._renderSlot(s, i, slots)).join("")}</div>
             <div class="row-actions">
               <button class="ghost" data-action="add" ${slots.length >= e.profile.maxSlots ? "disabled" : ""}>
                 <ha-icon icon="mdi:plus-circle-outline"></ha-icon>Zeitpunkt</button>
               <button class="ghost ${this._copyOpen ? "on" : ""}" data-action="copy-toggle">
                 <ha-icon icon="mdi:content-copy"></ha-icon>${esc(dayLong)} kopieren</button>
             </div>
             ${this._copyOpen ? this._renderCopy() : ""}`
          : `<div class="warn">Plan für ${esc(dayLong)} ist (noch) nicht bekannt. Das Thermostat meldet ihn beim nächsten Aufwachen.</div>`
      }
      ${this._renderMessage()}
      ${
        dirty.length || this._saving
          ? `<div class="savebar">
               <button class="ghost" data-action="discard" ${this._saving ? "disabled" : ""}>Verwerfen</button>
               <button class="primary" data-action="save" ${this._saving ? "disabled" : ""}>
                 ${this._saving ? "Speichert …" : `Speichern (${dirty.map((k) => DAYS.find((d) => d.key === k).short).join(", ")})`}
               </button>
             </div>`
          : ""
      }
    `;
  }

  _renderPrograms() {
    const { activeGroup, editGroup } = this._entities;
    const active = activeGroup && this._hass.states[activeGroup];
    if (!active) return "";
    const options = active.attributes.options || [];
    const edit = editGroup && this._hass.states[editGroup]?.state;
    const shown = this._displayedProgram();
    const mismatch = !shown.pending && edit && edit !== active.state;
    return `
      <div class="programs">
        <span class="label">Programm</span>
        ${options
          .map(
            (o) =>
              `<button class="chip ${shown.group === o ? "on" : ""} ${shown.pending && shown.group === o ? "pending" : ""}" data-action="program" data-value="${esc(o)}">${esc(o)}</button>`,
          )
          .join("")}
        ${shown.pending ? `<span class="hint">wird übertragen …</span>` : ""}
      </div>
      ${
        mismatch
          ? `<div class="msg error">Angezeigt wird Programm ${esc(edit)}, aktiv ist aber Programm ${esc(active.state)}.
             <button class="link" data-action="edit-active">Aktives Programm anzeigen</button></div>`
          : ""
      }
    `;
  }

  _renderTimeline(slots) {
    const isToday = this._day === JS_DAY[new Date().getDay()];
    const d = new Date();
    const nowPct = ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
    const segs = slots
      .map((s, i) => {
        const end = i + 1 < slots.length ? slots[i + 1].t : 1440;
        const pct = ((end - s.t) / 1440) * 100;
        return `<div class="seg" style="width:${pct}%;background:${tempColor(s.temp)}">${pct > 7 ? fmtTemp(s.temp) + "°" : ""}</div>`;
      })
      .join("");
    return `
      <div class="timeline">
        ${segs}
        ${isToday ? `<div class="now" style="left:${nowPct}%"></div>` : ""}
      </div>
      <div class="ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
    `;
  }

  _renderSlot(s, i, slots) {
    const end = i + 1 < slots.length ? toHHMM(slots[i + 1].t) : "24:00";
    return `
      <div class="slot">
        <span class="swatch" style="background:${tempColor(s.temp)}"></span>
        <div class="time">
          ${
            i === 0
              ? `<span class="fixed">00:00</span>`
              : `<input type="time" step="900" value="${toHHMM(s.t)}" data-action="time" data-index="${i}" aria-label="Uhrzeit">`
          }
          <span class="until">bis ${end}</span>
        </div>
        <button class="small" data-action="temp-down" data-index="${i}" ${s.temp <= this._entities.profile.min ? "disabled" : ""} aria-label="Kälter">
          <ha-icon icon="mdi:minus"></ha-icon></button>
        <span class="temp">${fmtTemp(s.temp)}°</span>
        <button class="small" data-action="temp-up" data-index="${i}" ${s.temp >= this._entities.profile.max ? "disabled" : ""} aria-label="Wärmer">
          <ha-icon icon="mdi:plus"></ha-icon></button>
        <button class="small del" data-action="remove" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Löschen">
          <ha-icon icon="mdi:delete-outline"></ha-icon></button>
      </div>
    `;
  }

  _renderCopy() {
    return `
      <div class="copy">
        <div class="copy-presets">
          <button class="chip" data-action="copy-preset" data-value="work">Mo–Fr</button>
          <button class="chip" data-action="copy-preset" data-value="weekend">Sa–So</button>
          <button class="chip" data-action="copy-preset" data-value="all">Alle</button>
        </div>
        <div class="days">
          ${DAYS.map((d) =>
            d.key === this._day
              ? `<button class="day src" disabled>${d.short}</button>`
              : `<button class="day ${this._copyTargets.has(d.key) ? "on" : ""}" data-action="copy-day" data-value="${d.key}">${d.short}</button>`,
          ).join("")}
        </div>
        <button class="primary wide" data-action="copy-apply" ${this._copyTargets.size ? "" : "disabled"}>Übernehmen</button>
      </div>
    `;
  }
}

const STYLE = `<style>
  :host { --shp-radius: 14px; --shp-touch: 48px; }
  ha-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  button { font: inherit; color: inherit; cursor: pointer; border: none; background: none; -webkit-tap-highlight-color: transparent; }
  button:disabled { opacity: .35; cursor: default; }
  ha-icon { --mdc-icon-size: 22px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .title { display: flex; align-items: center; gap: 10px; font-size: 1.2rem; font-weight: 500; padding: 4px 0; text-align: left; }
  .title ha-icon { color: var(--state-climate-heat-color, #ff8100); }
  .badge { font-size: .85rem; padding: 4px 12px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space: nowrap; }
  .badge.heating, .badge.preheating { background: rgba(255,129,0,.18); color: var(--state-climate-heat-color, #ff8100); }
  .thermo { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }
  .round { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--secondary-background-color); flex: none; }
  .round ha-icon { --mdc-icon-size: 30px; }
  .round:active:not(:disabled) { transform: scale(.94); }
  .target { text-align: center; flex: 1; }
  .big { font-size: 3.4rem; font-weight: 400; line-height: 1; }
  .big small { font-size: 1.2rem; margin-left: 2px; vertical-align: top; color: var(--secondary-text-color); }
  .current { margin-top: 6px; color: var(--secondary-text-color); }
  .modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 8px; }
  .mode { min-height: var(--shp-touch); border-radius: var(--shp-radius); background: var(--secondary-background-color); display: flex; align-items: center; justify-content: center; gap: 6px; }
  .mode.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .plan-now { text-align: center; font-size: .9rem; color: var(--secondary-text-color); }
  .foot { display: grid; grid-template-columns: minmax(48px, auto) 1fr minmax(48px, auto); align-items: center; gap: 4px; margin: -4px 0 -6px; }
  .boost { justify-self: end; min-width: 48px; height: 48px; padding: 0 12px; border-radius: 999px; display: flex; align-items: center; justify-content: center; gap: 4px;
    color: var(--shp-boost-off-color, var(--primary-text-color)); font-size: .85rem; font-weight: 500; transition: color .2s, background .2s; }
  .boost ha-icon { --mdc-icon-size: 26px; }
  .boost.on { color: var(--shp-boost-on-color, #ff5a1f); background: rgba(255, 90, 31, .16); }
  .boost.on ha-icon { filter: drop-shadow(0 0 6px rgba(255, 90, 31, .7)); }
  .boost.pending { animation: shp-pulse 1s ease-in-out infinite; }
  .boost:active:not(:disabled) { transform: scale(.92); }
  .target.tap { border-radius: var(--shp-radius); padding: 6px 0; }
  .target.tap:active { background: var(--secondary-background-color); }
  .hint-icon { --mdc-icon-size: 16px; vertical-align: -2px; margin-left: 4px; opacity: .8; }
  .section-title { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--divider-color); font-weight: 500; font-size: 1.05rem; }
  .programs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .programs .label { color: var(--secondary-text-color); margin-right: 4px; }
  .chip { min-height: 40px; min-width: 48px; padding: 0 14px; border-radius: 999px; background: var(--secondary-background-color); }
  .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .chip.pending { animation: shp-pulse 1s ease-in-out infinite; }
  @keyframes shp-pulse { 50% { opacity: .55; } }
  .programs .hint { font-size: 13px; color: var(--secondary-text-color); }
  .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
  .day { position: relative; min-height: var(--shp-touch); border-radius: 12px; background: var(--secondary-background-color); font-weight: 500; }
  .day.today { box-shadow: inset 0 0 0 2px var(--primary-color); }
  .day.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .day.src { opacity: .35; }
  .day .dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--warning-color, #ffa600); }
  .timeline { position: relative; display: flex; height: 34px; border-radius: 10px; overflow: hidden; }
  .seg { display: flex; align-items: center; justify-content: center; color: #fff; font-size: .8rem; font-weight: 500; overflow: hidden; white-space: nowrap; border-right: 1px solid rgba(0,0,0,.25); }
  .seg:last-of-type { border-right: none; }
  .now { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1px; background: var(--primary-text-color); box-shadow: 0 0 0 1px var(--card-background-color, #000); }
  .ticks { display: flex; justify-content: space-between; font-size: .75rem; color: var(--secondary-text-color); margin-top: -6px; }
  .slots { display: flex; flex-direction: column; gap: 8px; }
  .slot { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--shp-radius); background: var(--secondary-background-color); }
  .swatch { width: 6px; align-self: stretch; border-radius: 3px; flex: none; }
  .time { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .time input, .time .fixed { font: inherit; font-size: 1.15rem; font-weight: 500; color: var(--primary-text-color); background: transparent; border: none; padding: 4px 0; min-height: 32px; width: 100%; max-width: 120px; }
  .time input { border-bottom: 1px dashed var(--secondary-text-color); color-scheme: light dark; }
  .until { font-size: .78rem; color: var(--secondary-text-color); }
  .small { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--card-background-color, var(--ha-card-background)); flex: none; }
  .small:active:not(:disabled) { transform: scale(.92); }
  .small.del { background: none; color: var(--secondary-text-color); }
  .temp { min-width: 52px; text-align: center; font-size: 1.2rem; font-weight: 500; }
  .row-actions { display: flex; gap: 8px; }
  .ghost { flex: 1; min-height: var(--shp-touch); border-radius: var(--shp-radius); border: 1px solid var(--divider-color); display: flex; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; }
  .ghost.on { border-color: var(--primary-color); color: var(--primary-color); }
  .copy { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: var(--shp-radius); border: 1px solid var(--primary-color); }
  .copy-presets { display: flex; gap: 8px; flex-wrap: wrap; }
  .primary { min-height: var(--shp-touch); border-radius: var(--shp-radius); background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 500; padding: 0 16px; flex: 2; }
  .wide { width: 100%; }
  .savebar { position: sticky; bottom: 0; display: flex; gap: 8px; padding-top: 4px; background: var(--ha-card-background, var(--card-background-color)); }
  .msg { padding: 10px 12px; border-radius: 10px; background: var(--secondary-background-color); font-size: .9rem; cursor: pointer; }
  .msg.error { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
  .link { text-decoration: underline; color: inherit; padding: 0 0 0 4px; }
  .warn { color: var(--secondary-text-color); font-size: .9rem; }
</style>`;

class SmartHeatingPlanerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.schema = [
        { name: "entity", required: true, selector: { entity: { domain: "climate" } } },
        { name: "name", selector: { text: {} } },
        { name: "max_slots", selector: { number: { min: 1, max: 12, mode: "box" } } },
        { name: "boost_entity", selector: { entity: { domain: ["switch", "select", "input_boolean"] } } },
      ];
      this._form.computeLabel = (s) =>
        ({
          entity: "Thermostat",
          name: "Name (optional)",
          max_slots: "Max. Schaltpunkte pro Tag (optional, sonst automatisch)",
          boost_entity: "Boost-Entity (optional, sonst automatisch)",
        })[s.name];
      this._form.addEventListener("value-changed", (ev) => {
        const config = { ...this._config, ...ev.detail.value };
        if (!config.name) delete config.name;
        if (!config.max_slots) delete config.max_slots;
        if (!config.boost_entity) delete config.boost_entity;
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = this._config;
  }
}

/** Nur der Thermostat-Teil. Tipp auf die Temperatur öffnet den Wochenplan als Dialog. */
class SmartHeatingPlanerCompactCard extends SmartHeatingPlanerCard {
  constructor() {
    super();
    this._compact = true;
    this._dialog = null;
  }

  set hass(hass) {
    if (this._dialog) this._dialog.hass = hass;
    super.hass = hass;
  }

  get hass() {
    return super.hass;
  }

  getCardSize() {
    return 4;
  }

  disconnectedCallback() {
    this._dialog?.close(true);
  }

  _openPlanner() {
    if (this._dialog || !this._hass) return;
    const dialog = document.createElement("smart-heating-planer-dialog");
    dialog.setup(this._config, this._hass, this);
    dialog.addEventListener("shp-closed", () => (this._dialog = null));
    this._dialog = dialog;
    // Am body, damit der Dialog nicht von Dashboard-Spalten abgeschnitten wird
    document.body.appendChild(dialog);
  }
}

/** Vollbild-Dialog mit der vollständigen Karte. Schließen per ✕, Tipp daneben, Esc oder Zurück-Taste. */
class SmartHeatingPlanerDialog extends HTMLElement {
  setup(config, hass, origin) {
    this._config = config;
    this._hass = hass;
    this._origin = origin;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._card) this._card.hass = hass;
  }

  connectedCallback() {
    if (this._card) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `${DIALOG_STYLE}
      <div class="backdrop"></div>
      <div class="panel" role="dialog" aria-modal="true" aria-label="Wochenplan">
        <div class="bar"><span>Wochenplan</span>
          <button class="close" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
      </div>`;
    this._card = document.createElement("smart-heating-planer-card");
    this._card.setConfig(this._config);
    this._card.hass = this._hass;
    root.querySelector(".panel").appendChild(this._card);
    root.querySelector(".backdrop").addEventListener("click", () => this.close());
    root.querySelector(".close").addEventListener("click", () => this.close());
    // Details-Dialog von HA kann aus dem body heraus nicht geöffnet werden – über die Ursprungskarte weiterreichen
    this.addEventListener("hass-more-info", (ev) => {
      ev.stopPropagation();
      const origin = this._origin;
      const fire = () => origin?.dispatchEvent(new CustomEvent("hass-more-info", { detail: ev.detail, bubbles: true, composed: true }));
      const viaBack = history.state?.shpPlaner;
      if (!this.close()) return;
      if (!viaBack) return fire();
      // Erst nach dem Zurück-Schritt öffnen, sonst schließt HA seinen Dialog gleich wieder
      const once = () => {
        clearTimeout(timer);
        fire();
      };
      const timer = setTimeout(() => {
        window.removeEventListener("popstate", once);
        fire();
      }, 500);
      window.addEventListener("popstate", once, { once: true });
    });
    this._onKey = (ev) => ev.key === "Escape" && this.close();
    document.addEventListener("keydown", this._onKey);
    // Zurück-Taste (Android) schließt den Dialog statt das Dashboard zu verlassen
    history.pushState({ ...(history.state || {}), shpPlaner: true }, "");
    this._onPop = () => this.close(false, true);
    window.addEventListener("popstate", this._onPop);
  }

  close(force = false, fromPop = false) {
    if (this._closed) return true;
    if (!force && this._card?._dirtyDays().length && !confirm("Ungespeicherte Änderungen am Wochenplan verwerfen?")) {
      if (fromPop) history.pushState({ ...(history.state || {}), shpPlaner: true }, "");
      return false;
    }
    this._closed = true;
    document.removeEventListener("keydown", this._onKey);
    window.removeEventListener("popstate", this._onPop);
    if (!fromPop && history.state?.shpPlaner) history.back();
    this.remove();
    this.dispatchEvent(new CustomEvent("shp-closed"));
    return true;
  }
}

const DIALOG_STYLE = `<style>
  :host { position: fixed; inset: 0; z-index: 9; display: flex; align-items: center; justify-content: center; }
  .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, .55); animation: shp-fade .15s ease-out; }
  .panel { position: relative; width: min(560px, 100%); max-height: 100%; max-height: 100dvh; overflow-y: auto; overscroll-behavior: contain;
    background: var(--ha-card-background, var(--card-background-color, #1c1c1c)); color: var(--primary-text-color);
    border-radius: 16px; box-shadow: 0 8px 32px rgba(0, 0, 0, .5); animation: shp-up .18s ease-out; }
  .bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: 6px 6px 0 16px;
    background: inherit; font-weight: 500; font-size: 1.05rem; }
  .close { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; border: none; background: none; color: inherit; cursor: pointer; }
  .close ha-icon { --mdc-icon-size: 26px; }
  @media (max-width: 600px) { .panel { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
  @keyframes shp-fade { from { opacity: 0; } }
  @keyframes shp-up { from { transform: translateY(24px); opacity: 0; } }
</style>`;

if (!customElements.get("smart-heating-planer-card")) {
  customElements.define("smart-heating-planer-card", SmartHeatingPlanerCard);
  customElements.define("smart-heating-planer-compact-card", SmartHeatingPlanerCompactCard);
  customElements.define("smart-heating-planer-dialog", SmartHeatingPlanerDialog);
  customElements.define("smart-heating-planer-card-editor", SmartHeatingPlanerCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "smart-heating-planer-card",
    name: "Smart Heating Planer",
    description: "Thermostat mit Wochenplan zum Antippen (Zigbee2MQTT)",
    preview: true,
    documentationURL: "https://github.com/thestealth131205/HA-SmartHeatingPlaner",
  });
  window.customCards.push({
    type: "smart-heating-planer-compact-card",
    name: "Smart Heating Planer (kompakt)",
    description: "Nur Thermostat, Tipp auf die Temperatur öffnet den Wochenplan",
    preview: true,
    documentationURL: "https://github.com/thestealth131205/HA-SmartHeatingPlaner",
  });
  console.info(`%c SMART-HEATING-PLANER %c ${VERSION} `, "background:#ff8100;color:#fff", "background:#333;color:#fff");
}
