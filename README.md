# Smart Heating Planer

Eine Home-Assistant-Integration mit einer Thermostat-Karte, in der man den Wochenplan seines Heizkörperthermostats direkt antippen und ändern kann. Ein Scheduler oder Automationen für den Zeitplan sind nicht nötig: Der Plan liegt im Thermostat selbst und läuft auch weiter, wenn Home Assistant einmal nicht erreichbar ist.

## Funktionen

- **Thermostat:** Ist- und Solltemperatur, große −/+-Knöpfe, Modus *Aus*, *Plan* (Auto) oder *Manuell*. Mehrfaches Tippen wird gesammelt und als ein Befehl gesendet, das schont die Batterie.
- **Wochenplan:** Tagesauswahl Mo–So, farbige Zeitleiste mit Markierung für „jetzt“, darunter die Schaltpunkte. Uhrzeit antippen zum Ändern, Temperatur mit −/+ in 0,5-°C-Schritten, Zeitpunkte hinzufügen oder löschen.
- **Kopieren:** Einen Tag mit einem Tipp auf Mo–Fr, Sa–So oder alle Tage übernehmen.
- **Programme:** Bei Thermostaten mit mehreren Programmen (z. B. Sonoff TRV-ZBT: 1–3) lässt sich das aktive Programm umschalten.
- Änderungen werden erst mit **Speichern** an das Thermostat geschickt. Bis dahin sind geänderte Tage mit einem Punkt markiert.

## Voraussetzungen

- Home Assistant ab 2025.1
- Ein Thermostat über **Zigbee2MQTT**, das seinen Wochenplan als Text-Entities `text.<name>_weekly_schedule_<tag>` bereitstellt (z. B. Sonoff TRVZB / TRV-ZBT). Format pro Tag: `00:00/18 07:00/21 13:00/20 18:00/21 22:00/19`, höchstens 12 Schaltpunkte, der erste immer um 00:00, Temperaturen 5–30 °C.

## Installation

**HACS:** HACS → Benutzerdefinierte Repositories → Repo-URL mit Typ „Integration“ hinzufügen → „Smart Heating Planer“ installieren → Home Assistant neu starten.

**Manuell:** Den Ordner `custom_components/smart_heating_planer` nach `config/custom_components/` kopieren und Home Assistant neu starten.

Danach: Einstellungen → Geräte & Dienste → Integration hinzufügen → **Smart Heating Planer**. Die Karte wird automatisch geladen, eine Dashboard-Ressource muss nicht eingetragen werden.

## Karte einbinden

Dashboard bearbeiten → Karte hinzufügen → „Smart Heating Planer“ suchen, oder per YAML:

```yaml
type: custom:smart-heating-planer-card
entity: climate.heizung
name: Wohnzimmer   # optional
```

Die Wochenplan-Entities werden automatisch über das Gerät des Thermostats gefunden.

## Automationen

Für Reaktionen auf Ereignisse (Fenster offen, niemand zu Hause …) einfach normale Automationen mit `climate.set_temperature` oder `climate.set_hvac_mode` verwenden. Im Modus *Plan* übernimmt das Thermostat danach wieder seinen Wochenplan.

## Lizenz

[GPL-3.0](LICENSE)
