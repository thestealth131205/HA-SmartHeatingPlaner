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
 *
 * Bedingungen (ab 1.3.0): "Wenn Entity X = Wert, dann Manuell/Aus, optional Boost,
 * optional zurücksetzen". Ausgewertet werden sie in der Integration (conditions.py),
 * die Karte bearbeitet sie nur über die Websocket-API smart_heating_planer/conditions/*.
 */

const VERSION = "1.3.0";

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

// Bedingungen
const COND_DOMAINS = {
  binary_sensor: "Binärsensoren",
  sensor: "Sensoren",
  switch: "Schalter",
  light: "Lichter",
  input_boolean: "Helfer (Schalter)",
  input_number: "Helfer (Zahl)",
  input_select: "Helfer (Auswahl)",
  select: "Auswahl",
  person: "Personen",
  device_tracker: "Geräte-Tracker",
  media_player: "Medien",
  sun: "Sonne",
};
const ON_OFF_DOMAINS = ["binary_sensor", "switch", "light", "input_boolean", "fan"];
const ON_OFF_LABELS = {
  presence: ["erkannt", "nicht erkannt"],
  occupancy: ["erkannt", "nicht erkannt"],
  motion: ["erkannt", "nicht erkannt"],
  door: ["offen", "geschlossen"],
  window: ["offen", "geschlossen"],
  opening: ["offen", "geschlossen"],
  garage_door: ["offen", "geschlossen"],
  moisture: ["nass", "trocken"],
  connectivity: ["verbunden", "getrennt"],
};
const OPERATOR_LABELS = { eq: "=", ne: "≠", gt: ">", lt: "<" };

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
    this._rules = null; // null = Integration liefert (noch) keine Bedingungen
    this._ruleDraft = null;
    this._condMessage = null;
    this._condBusy = false;
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

  connectedCallback() {
    this._subscribeConditions();
  }

  disconnectedCallback() {
    this._unsubscribeConditions();
  }

  set hass(hass) {
    this._hass = hass;
    this._subscribeConditions();
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

  // ---------- Bedingungen ----------

  _subscribeConditions() {
    if (this._condSub || !this._hass?.connection || !this.isConnected) return;
    this._condSub = this._hass.connection
      .subscribeMessage(
        (msg) => {
          this._rules = msg.rules || [];
          this._render();
        },
        { type: "smart_heating_planer/conditions/subscribe" },
      )
      .catch(() => {
        // Ältere Integration ohne Bedingungen: Abschnitt einfach weglassen
        this._condSub = null;
        this._rules = null;
        return null;
      });
  }

  _unsubscribeConditions() {
    const sub = this._condSub;
    this._condSub = null;
    sub?.then((unsub) => unsub && unsub()).catch(() => {});
  }

  _myRules() {
    return (this._rules || []).filter((r) => r.climate === this._config.entity);
  }

  _ruleTempRange() {
    const a = this._hass.states[this._config.entity]?.attributes || {};
    const p = this._entities.profile;
    return {
      step: a.target_temp_step || TEMP_STEP,
      min: Math.max(p.min, a.min_temp ?? p.min),
      max: Math.min(p.max, a.max_temp ?? p.max),
    };
  }

  // Art der Bedingung je nach Entity: an/aus, Zahl oder Text/Auswahl
  _condKind(entityId) {
    const st = entityId && this._hass.states[entityId];
    const domain = (entityId || "").split(".")[0];
    if (ON_OFF_DOMAINS.includes(domain)) return "onoff";
    if (domain === "input_number" || domain === "number") return "number";
    if (domain === "sensor" && st && (st.attributes.unit_of_measurement || !isNaN(parseFloat(st.state)))) return "number";
    return "text";
  }

  _condOptions(entityId) {
    const st = entityId && this._hass.states[entityId];
    const domain = (entityId || "").split(".")[0];
    if (st?.attributes?.options?.length) return st.attributes.options;
    if (domain === "person" || domain === "device_tracker") return ["home", "not_home"];
    if (domain === "sun") return ["above_horizon", "below_horizon"];
    if (domain === "media_player") return ["on", "off", "playing", "paused", "idle"];
    return null;
  }

  _stateLabel(entityId, value) {
    const st = this._hass.states[entityId];
    if (this._condKind(entityId) === "onoff") {
      const labels = ON_OFF_LABELS[st?.attributes?.device_class] || ["an", "aus"];
      if (value === "on") return labels[0];
      if (value === "off") return labels[1];
    }
    const named = { home: "zu Hause", not_home: "abwesend", above_horizon: "über dem Horizont", below_horizon: "unter dem Horizont", playing: "spielt", paused: "pausiert", idle: "inaktiv" };
    return named[value] || value;
  }

  _entityName(entityId) {
    return this._hass.states[entityId]?.attributes?.friendly_name || entityId;
  }

  _hasOffMode() {
    return (this._hass.states[this._config.entity]?.attributes?.hvac_modes || []).includes("off");
  }

  _newRuleDraft() {
    const states = this._hass.states;
    const presence = Object.keys(states).find(
      (id) => id.startsWith("binary_sensor.") && ["presence", "occupancy", "motion"].includes(states[id].attributes.device_class),
    );
    const r = this._ruleTempRange();
    const raw = states[this._config.entity]?.attributes?.temperature;
    const cur = raw == null || isNaN(Number(raw)) ? 21 : Number(raw);
    return {
      climate: this._config.entity,
      entity: presence || "",
      operator: "eq",
      value: "on",
      mode: "manual",
      temperature: Math.min(r.max, Math.max(r.min, Math.round(cur / r.step) * r.step)),
      boost: false,
      revert: true,
      enabled: true,
    };
  }

  _setDraftEntity(entityId) {
    const d = this._ruleDraft;
    d.entity = entityId;
    const kind = this._condKind(entityId);
    const st = this._hass.states[entityId];
    if (kind === "onoff") {
      d.operator = "eq";
      d.value = "on";
    } else if (kind === "number") {
      d.operator = "gt";
      d.value = st && !isNaN(parseFloat(st.state)) ? String(Math.round(parseFloat(st.state))) : "0";
    } else {
      d.operator = "eq";
      d.value = this._condOptions(entityId)?.[0] || (st && !["unknown", "unavailable"].includes(st.state) ? st.state : "");
    }
  }

  _ruleSummary(rule) {
    const name = this._entityName(rule.entity);
    const cond =
      this._condKind(rule.entity) === "onoff" && rule.operator === "eq"
        ? this._stateLabel(rule.entity, rule.value)
        : `${OPERATOR_LABELS[rule.operator]} ${this._stateLabel(rule.entity, rule.value)}`;
    const action = rule.mode === "off" ? "Aus" : `Manuell ${fmtTemp(rule.temperature)} °C${rule.boost ? " + Boost" : ""}`;
    return { when: `${name} ${cond}`, then: action, revert: rule.revert };
  }

  async _saveRule(rule) {
    this._condBusy = true;
    this._condMessage = null;
    this._render();
    try {
      await this._hass.callWS({ type: "smart_heating_planer/conditions/save", rule });
      this._ruleDraft = null;
    } catch (err) {
      this._condMessage = { text: `Fehler: ${err?.message || err}`, error: true };
    }
    this._condBusy = false;
    this._render();
  }

  async _deleteRule(id) {
    if (!confirm("Diese Bedingung löschen?")) return;
    this._condBusy = true;
    this._render();
    try {
      await this._hass.callWS({ type: "smart_heating_planer/conditions/delete", rule_id: id });
      this._ruleDraft = null;
    } catch (err) {
      this._condMessage = { text: `Fehler: ${err?.message || err}`, error: true };
    }
    this._condBusy = false;
    this._render();
  }

  _onCondClick(action, value) {
    const d = this._ruleDraft;
    switch (action) {
      case "c-add":
        this._ruleDraft = this._newRuleDraft();
        this._condMessage = null;
        break;
      case "c-edit": {
        const rule = this._myRules().find((r) => r.id === value);
        if (rule) this._ruleDraft = { ...rule };
        this._condMessage = null;
        break;
      }
      case "c-toggle": {
        const rule = this._myRules().find((r) => r.id === value);
        if (rule) return this._saveRule({ ...rule, enabled: !rule.enabled });
        break;
      }
      case "c-cancel":
        this._ruleDraft = null;
        this._condMessage = null;
        break;
      case "c-delete":
        return d?.id && this._deleteRule(d.id);
      case "c-save":
        if (!d.entity) {
          this._condMessage = { text: "Bitte zuerst eine Entity wählen.", error: true };
          break;
        }
        if (!String(d.value).trim()) {
          this._condMessage = { text: "Bitte einen Wert für die Bedingung angeben.", error: true };
          break;
        }
        return this._saveRule(d);
      case "c-value":
        d.value = value;
        break;
      case "c-op":
        d.operator = value;
        break;
      case "c-mode":
        d.mode = value;
        if (value === "off") d.boost = false;
        break;
      case "c-temp": {
        const r = this._ruleTempRange();
        const next = Number(d.temperature) + Number(value) * r.step;
        d.temperature = Math.min(r.max, Math.max(r.min, Math.round(next / r.step) * r.step));
        break;
      }
      case "c-boost":
        d.boost = !d.boost;
        break;
      case "c-revert":
        d.revert = !d.revert;
        break;
      default:
        return;
    }
    this._render();
  }

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
    if (action.startsWith("c-")) return this._onCondClick(action, value);
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
    else if (el.dataset.action === "c-entity" && this._ruleDraft) {
      this._setDraftEntity(el.value);
      this._render();
    } else if (el.dataset.action === "c-input" && this._ruleDraft) {
      this._ruleDraft.value = el.value.trim();
      this._render();
    }
  }

  // ---------- Darstellung ----------

  _render() {
    if (!this._hass || !this._config) return;
    // Nicht neu zeichnen, während eine Uhrzeit eingegeben wird (sonst schließt sich der Picker)
    const active = this.shadowRoot.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "SELECT")) {
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
          this._compact ? this._renderMessage() : this._renderPlanner() + this._renderConditions()
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
    const activeRule = this._myRules().find((r) => r.active);
    const indicator = activeRule
      ? `<span class="cond-active" title="${esc(`Bedingung aktiv: ${this._ruleSummary(activeRule).when}`)}"><ha-icon icon="mdi:auto-mode"></ha-icon></span>`
      : "<span></span>";
    if (!b && !activeRule) return plan ? `<div class="plan-now">${plan}</div>` : "";
    if (!b) return `<div class="foot">${indicator}<div class="plan-now">${plan}</div><span></span></div>`;
    // Nur sperren, wenn die Boost-Entity selbst weg ist – das Thermostat kann noch "unbekannt" melden
    const unavailable = this._hass.states[b.id]?.state === "unavailable";
    const shown = this._displayedBoost();
    const cd = shown.on && this._entities.boostCountdown && this._hass.states[this._entities.boostCountdown];
    const left = cd && Number(cd.state) > 0 ? `${cd.state} ${cd.attributes.unit_of_measurement || ""}`.trim() : "";
    return `
      <div class="foot">
        ${indicator}
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

  _renderConditions() {
    if (this._rules === null) return "";
    const rules = this._myRules();
    const d = this._ruleDraft;
    const msg = this._condMessage
      ? `<div class="msg ${this._condMessage.error ? "error" : ""}">${esc(this._condMessage.text)}</div>`
      : "";
    return `
      <div class="section-title">Bedingungen</div>
      ${
        rules.length
          ? `<div class="rules">${rules.map((r) => this._renderRule(r)).join("")}</div>`
          : d
            ? ""
            : `<div class="warn">Zum Beispiel: Wenn Präsenz erkannt, dann Manuell 22 °C mit Boost – und zurück zum Plan, sobald niemand mehr da ist.</div>`
      }
      ${d ? this._renderRuleEditor(d) : `<button class="ghost" data-action="c-add"><ha-icon icon="mdi:plus-circle-outline"></ha-icon>Bedingung</button>`}
      ${msg}
    `;
  }

  _renderRule(r) {
    const s = this._ruleSummary(r);
    const editing = this._ruleDraft?.id === r.id;
    return `
      <div class="rule ${r.enabled ? "" : "disabled"} ${r.active ? "active" : ""} ${editing ? "editing" : ""}">
        <button class="rule-main" data-action="c-edit" data-value="${esc(r.id)}" aria-label="Bearbeiten">
          <span class="rule-when"><ha-icon icon="${r.active ? "mdi:auto-mode" : "mdi:help-rhombus-outline"}"></ha-icon>Wenn ${esc(s.when)}</span>
          <span class="rule-then">→ ${esc(s.then)}${s.revert ? " · danach zurück" : ""}${r.active ? " · <b>aktiv</b>" : ""}</span>
        </button>
        <button class="toggle ${r.enabled ? "on" : ""}" data-action="c-toggle" data-value="${esc(r.id)}" ${this._condBusy ? "disabled" : ""}
          role="switch" aria-checked="${r.enabled}" aria-label="${r.enabled ? "Deaktivieren" : "Aktivieren"}"><i></i></button>
      </div>
    `;
  }

  _renderRuleEditor(d) {
    const states = this._hass.states;
    const groups = {};
    for (const [id, st] of Object.entries(states)) {
      const domain = id.split(".")[0];
      if (!COND_DOMAINS[domain] || id === this._config.entity) continue;
      (groups[domain] = groups[domain] || []).push({ id, name: st.attributes.friendly_name || id });
    }
    const entityOptions = Object.keys(COND_DOMAINS)
      .filter((dom) => groups[dom])
      .map(
        (dom) =>
          `<optgroup label="${esc(COND_DOMAINS[dom])}">${groups[dom]
            .sort((a, b) => a.name.localeCompare(b.name, "de"))
            .map((e) => `<option value="${esc(e.id)}" ${e.id === d.entity ? "selected" : ""}>${esc(e.name)}</option>`)
            .join("")}</optgroup>`,
      )
      .join("");
    const kind = this._condKind(d.entity);
    const cur = d.entity && states[d.entity];
    const options = this._condOptions(d.entity);
    let condHtml = "";
    if (!d.entity) {
      condHtml = "";
    } else if (kind === "onoff") {
      condHtml = `<div class="chips">${["on", "off"]
        .map((v) => `<button class="chip ${d.value === v ? "on" : ""}" data-action="c-value" data-value="${v}">${esc(this._stateLabel(d.entity, v))}</button>`)
        .join("")}</div>`;
    } else {
      const ops = kind === "number" ? ["gt", "lt", "eq", "ne"] : ["eq", "ne"];
      const opChips = ops
        .map((o) => `<button class="chip op ${d.operator === o ? "on" : ""}" data-action="c-op" data-value="${o}">${OPERATOR_LABELS[o]}</button>`)
        .join("");
      const input = options
        ? `<select class="field" data-action="c-input">${(options.includes(d.value) ? options : [d.value, ...options])
            .filter((o) => o !== "")
            .map((o) => `<option value="${esc(o)}" ${o === d.value ? "selected" : ""}>${esc(this._stateLabel(d.entity, o))}</option>`)
            .join("")}</select>`
        : `<input class="field" data-action="c-input" ${kind === "number" ? 'type="text" inputmode="decimal"' : 'type="text"'} value="${esc(d.value)}" aria-label="Wert">${
            kind === "number" && cur?.attributes?.unit_of_measurement ? `<span class="unit">${esc(cur.attributes.unit_of_measurement)}</span>` : ""
          }`;
      condHtml = `<div class="chips">${opChips}</div><div class="value-row">${input}</div>`;
    }
    const now = cur ? `<div class="hint">Aktuell: ${esc(this._stateLabel(d.entity, cur.state))}${cur.attributes.unit_of_measurement ? " " + esc(cur.attributes.unit_of_measurement) : ""}</div>` : "";
    const r = this._ruleTempRange();
    const offOk = this._hasOffMode();
    const boostOk = !!this._entities.boost;
    return `
      <div class="editor">
        <div class="ed-label">Wenn</div>
        <select class="field" data-action="c-entity" aria-label="Entity">
          ${d.entity ? "" : `<option value="" selected disabled>Entity wählen …</option>`}
          ${entityOptions}
        </select>
        ${condHtml}
        ${now}
        <div class="ed-label">Dann</div>
        <div class="chips">
          <button class="chip ${d.mode === "manual" ? "on" : ""}" data-action="c-mode" data-value="manual"><ha-icon icon="mdi:hand-back-right"></ha-icon>Manuell</button>
          ${offOk || d.mode === "off" ? `<button class="chip ${d.mode === "off" ? "on" : ""}" data-action="c-mode" data-value="off"><ha-icon icon="mdi:power"></ha-icon>Aus</button>` : ""}
        </div>
        ${
          d.mode === "manual"
            ? `<div class="ed-temp">
                 <button class="small" data-action="c-temp" data-value="-1" ${d.temperature <= r.min ? "disabled" : ""} aria-label="Kälter"><ha-icon icon="mdi:minus"></ha-icon></button>
                 <span class="temp big-temp">${fmtTemp(d.temperature)} °C</span>
                 <button class="small" data-action="c-temp" data-value="1" ${d.temperature >= r.max ? "disabled" : ""} aria-label="Wärmer"><ha-icon icon="mdi:plus"></ha-icon></button>
               </div>
               ${
                 boostOk
                   ? `<button class="opt" data-action="c-boost" role="switch" aria-checked="${d.boost}">
                        <ha-icon icon="mdi:rocket-launch" class="${d.boost ? "boost-on" : ""}"></ha-icon><span>Boost starten</span>
                        <span class="toggle ${d.boost ? "on" : ""}"><i></i></span></button>`
                   : ""
               }`
            : ""
        }
        <button class="opt" data-action="c-revert" role="switch" aria-checked="${d.revert}">
          <ha-icon icon="mdi:backup-restore"></ha-icon><span>Zurücksetzen, wenn die Bedingung nicht mehr erfüllt ist</span>
          <span class="toggle ${d.revert ? "on" : ""}"><i></i></span></button>
        <div class="savebar static">
          ${d.id ? `<button class="ghost del-btn" data-action="c-delete" ${this._condBusy ? "disabled" : ""} aria-label="Löschen"><ha-icon icon="mdi:delete-outline"></ha-icon></button>` : ""}
          <button class="ghost" data-action="c-cancel" ${this._condBusy ? "disabled" : ""}>Abbrechen</button>
          <button class="primary" data-action="c-save" ${this._condBusy ? "disabled" : ""}>${this._condBusy ? "Speichert …" : "Speichern"}</button>
        </div>
      </div>
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
  .cond-active { justify-self: start; width: 48px; height: 48px; display: grid; place-items: center; color: var(--primary-color); }
  .rules { display: flex; flex-direction: column; gap: 8px; }
  .rule { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 4px; border-radius: var(--shp-radius); background: var(--secondary-background-color); }
  .rule.active { box-shadow: inset 0 0 0 2px var(--primary-color); }
  .rule.editing { box-shadow: inset 0 0 0 2px var(--warning-color, #ffa600); }
  .rule.disabled .rule-main { opacity: .45; }
  .rule-main { flex: 1; min-width: 0; min-height: var(--shp-touch); display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; padding: 4px 8px; text-align: left; }
  .rule-when { display: flex; align-items: center; gap: 6px; font-weight: 500; }
  .rule-when ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex: none; }
  .rule.active .rule-when ha-icon { color: var(--primary-color); }
  .rule-then { font-size: .85rem; color: var(--secondary-text-color); padding-left: 24px; }
  .toggle { position: relative; width: 52px; height: 32px; flex: none; border-radius: 999px; background: var(--disabled-color, #8a8a8a); transition: background .2s; display: inline-block; }
  .toggle i { position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; border-radius: 50%; background: #fff; transition: transform .2s; }
  .toggle.on { background: var(--primary-color); }
  .toggle.on i { transform: translateX(20px); }
  button.toggle { padding: 0; margin: 8px 0; }
  .editor { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: var(--shp-radius); border: 1px solid var(--primary-color); }
  .ed-label { font-weight: 500; color: var(--secondary-text-color); font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
  .field { font: inherit; font-size: 1rem; min-height: var(--shp-touch); width: 100%; box-sizing: border-box; padding: 0 12px; border-radius: 12px;
    border: 1px solid var(--divider-color); background: var(--card-background-color, var(--ha-card-background)); color: var(--primary-text-color); color-scheme: light dark; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chips .chip { min-height: var(--shp-touch); display: inline-flex; align-items: center; gap: 6px; padding: 0 18px; }
  .chips .chip.op { min-width: 56px; justify-content: center; font-size: 1.2rem; padding: 0 12px; }
  .value-row { display: flex; align-items: center; gap: 8px; }
  .unit { color: var(--secondary-text-color); white-space: nowrap; }
  .hint { font-size: .8rem; color: var(--secondary-text-color); margin-top: -4px; }
  .ed-temp { display: flex; align-items: center; justify-content: center; gap: 16px; }
  .ed-temp .small { background: var(--secondary-background-color); width: 52px; height: 52px; }
  .big-temp { font-size: 1.6rem; min-width: 96px; }
  .opt { display: flex; align-items: center; gap: 10px; min-height: var(--shp-touch); padding: 4px 4px 4px 8px; border-radius: 12px; text-align: left; }
  .opt:active { background: var(--secondary-background-color); }
  .opt span:not(.toggle) { flex: 1; }
  .opt ha-icon { color: var(--secondary-text-color); }
  .opt ha-icon.boost-on { color: var(--shp-boost-on-color, #ff5a1f); }
  .savebar.static { position: static; background: none; }
  .del-btn { flex: 0 0 var(--shp-touch); color: var(--error-color, #db4437); padding: 0; }
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
    super.disconnectedCallback();
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
