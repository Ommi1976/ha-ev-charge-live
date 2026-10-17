# ⚡ EV Charge Live Monitor (HAOS Add-on)

Ein modernes, leichtgewichtiges Home Assistant OS Add-on zur **Echtzeit-Überwachung von E-Auto-Ladestationen** mit interaktiver Ingress-Karte, 1-Klick-Favoriten und Push-Benachrichtigungen aufs Smartphone, sobald ein Ladeplatz frei wird.

Speziell vorkonfiguriert für alle Ladestationen der **Stadtwerke Hockenheim** sowie aller Anbieter in Baden-Württemberg und ganz Deutschland (über den offiziellen, kostenlosen Open-Data-Standard AFIR / OCPI von MobiData BW).

---

## 🌟 Features

* **100 % Kostenlos & Schlüssellos:** Keine Registrierung, kein kostenpflichtiger API-Key, kein Verfallsdatum.
* **Hybrid Real-Time Engine (MobiData BW + EnBW Roaming API):** Sekundengenaue Belegung, reale Ladeleistung in kW (AC/DC), minutengenaue Belegungsdauer (`seit 07:30 Uhr (vor 1 Std. 12 Min.)`) für alle Stationen (inkl. Stadtwerke Hockenheim).
* **1-Klick-Navigation:**
  * 🧭 **Google Maps:** Öffnet sofort Route & Android Auto Navigation im Auto.
  * 🚗 **An Cupra Born:** Sendet Navigationsziel per Home Assistant Event `ev_charge_send_to_cupra` & Push-Meldung ans Auto.
* **📍 Smartphone-GPS (Xiaomi):** 1-Klick Standortermittlung über den Home Assistant `device_tracker` deines Smartphones.
* **📱 Responsive Touch-UI:** Menüleiste für Smartphones optimiert (Icon-Modus, Wisch-Schnellauswahl, Puls-Status, 44px Touch-Ziele).
* **Interaktive Ingress-Karte:** Nahtlos in der Home Assistant Seitenleiste integriert (Leaflet mit SVG-Live-Pins für 🟢 Frei, 🟡 Teilweise belegt, 🔴 Vollständig belegt, ⚪ Außer Betrieb).
* **1-Klick-Favoriten:** Einfach eine Ladesäule auf der Karte anklicken und als Favorit markieren – das Add-on legt sofort einen nativen Home Assistant Sensor dafür an (`sensor.ev_charge_*`).
* **Smarte Push-Benachrichtigungen:**
  * Erkennt Zustandswechsel (wenn eine belegte Säule wieder freie Slots hat).
  * Sendet Push-Nachrichten an die Home Assistant Companion App (`notify.notify` oder spezifisches Smartphone).
  * Integrierter Spamschutz (**Cooldown** in Minuten).
  * Anpassbare Nachrichtenvorlagen mit Platzhaltern `{station_name}`, `{address}`, `{free_slots}`, `{total_slots}`, `{max_power_kw}`.
* **Home Assistant Eventbus:** Feuert bei freigewordenem Platz das Event `ev_charge_slot_freed` für eigene Automationen (z. B. Sprachausgabe über Alexa oder smarte Beleuchtung).

---

## 📥 Installation in Home Assistant OS

### Option 1: Lokales Add-on (Empfohlen)

1. Kopiere den Ordner `ha-ev-charge-live` auf deinen Home Assistant Server in das Verzeichnis `/addons/` (z. B. über das offizielle **Samba Share Add-on** oder per SSH):
   ```text
   /addons/ha-ev-charge-live/
     ├── config.yaml
     ├── Dockerfile
     ├── build.yaml
     ├── run.sh
     ├── requirements.txt
     └── app/
   ```
2. Öffne Home Assistant und navigiere zu **Einstellungen → Add-ons → Add-on Store**.
3. Klicke oben rechts auf das Drei-Punkte-Menü `⋮` und wähle **Nach Repositories suchen** (Repositories neu laden).
4. Das Add-on **EV Charge Live Monitor** erscheint nun unter der Rubrik **Lokale Add-ons**.
5. Klicke auf **Installieren**.
6. Aktiviere nach der Installation den Schalter **In der Seitenleiste anzeigen** und starte das Add-on.

---

## ⚙️ Konfigurations-Optionen (`config.yaml` / Options-Tab)

| Parameter | Standard | Beschreibung |
| :--- | :--- | :--- |
| `polling.interval_seconds` | `60` | Abruf-Intervall der Favoriten in Sekunden (15 bis 600 s). |
| `location_defaults.city` | `Hockenheim` | Standard-Stadt für die Suche. |
| `location_defaults.postal_code` | `68766` | Standard-Postleitzahl. |
| `location_defaults.latitude` | `49.317584` | Karten-Mittelpunkt (Breitengrad). |
| `location_defaults.longitude` | `8.545261` | Karten-Mittelpunkt (Längengrad). |
| `location_defaults.search_radius_meters` | `5000` | Suchradius um den Mittelpunkt in Metern. |
| `notifications.enabled` | `true` | Push-Benachrichtigungen bei freiem Slot aktivieren. |
| `notifications.service` | `notify.notify` | Zielservice (z. B. `notify.mobile_app_stephan`). |
| `notifications.cooldown_minutes` | `10` | Mindestzeit zwischen zwei Meldungen pro Station. |
| `notifications.title_template` | `⚡ Ladestation frei: {station_name}` | Titel der Push-Nachricht. |
| `notifications.message_template` | `An {station_name} ({address}) sind jetzt {free_slots} von {total_slots} Plätzen frei!` | Text der Push-Nachricht. |
| `home_assistant_integration.entity_prefix` | `sensor.ev_charge_` | Präfix für generierte Sensoren. |
| `home_assistant_integration.create_device_tracker`| `true` | Zeigt Säulen als Device Tracker auf der HA-Karte. |
| `home_assistant_integration.fire_ha_events` | `true` | Feuert `ev_charge_slot_freed` im Eventbus. |

---

## 💡 Home Assistant Automations-Beispiele

### 1. Benachrichtigung über Event-Trigger
```yaml
alias: "E-Auto: Stammsäule Schubertstraße frei"
trigger:
  - platform: event
    event_type: ev_charge_slot_freed
    event_data:
      address: "Schubertstr. 5"
action:
  - service: notify.notify
    data:
      title: "⚡ Stadtwerke Ladesäule frei!"
      message: "{{ trigger.event.data.name }} hat jetzt freie Plätze."
```

### 2. Sprachansage über Alexa / Google Home
```yaml
alias: "Alexa Ansage wenn Säule frei"
trigger:
  - platform: state
    entity_id: sensor.ev_charge_stadtwerke_hockenheim_schubertstr_5
    from: "Belegt"
    to: "Frei"
action:
  - service: tts.speak
    target:
      entity_id: media_player.echo_dot_wohnzimmer
    data:
      message: "Achtung: Die Ladestation in der Schubertstraße ist jetzt frei geworden."
```
