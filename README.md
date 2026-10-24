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
| `notifications.min_free_slots_to_trigger` | `1` | Push „Platz frei“ erst, wenn mindestens so viele Plätze frei sind (1–10). Gemeldet wird, sobald die Zahl freier Plätze steigt und die Schwelle erreicht oder überschreitet; bei `2` löst also `0 → 1` nichts aus, `1 → 2` schon. |
| `notifications.notify_on_all_busy` | `false` | Zusätzlicher Push „🔴 Ladestation belegt“, wenn eine Station der Watchlist vollständig belegt wird (nicht bei „Außer Betrieb“). Ersetzt auf dem Handy die ältere „frei“-Meldung derselben Station; eigener Cooldown, blockiert also nie die nächste „frei“-Meldung. |
| `notifications.title_template` | `⚡ Ladestation frei: {station_name}` | Titel der Push-Nachricht. |
| `notifications.message_template` | `An {station_name} ({address}) sind jetzt {free_slots} von {total_slots} Plätzen frei!` | Text der Push-Nachricht. |
| `home_assistant_integration.entity_prefix` | `sensor.ev_charge_` | Präfix für generierte Sensoren. |
| `home_assistant_integration.create_device_tracker`| `true` | Zeigt Säulen als Device Tracker auf der HA-Karte. |
| `home_assistant_integration.fire_ha_events` | `true` | Feuert `ev_charge_slot_freed` im Eventbus. |
| `logging.level` | `info` | Log-Level des Add-ons (`debug`, `info`, `warning`, `error`). `debug` gilt nur für die Add-on-eigenen Logger; `httpx`/`httpcore` loggen höchstens Warnungen (keine Zeile pro HTTP-Anfrage mehr), `warning`/`error` gelten auch für Uvicorn inkl. Zugriffslog. |

Push-Meldungen (frei/belegt) gehen nur an Stationen auf der **Watchlist**; reine Favoriten aktualisieren lediglich ihren Sensor.

> **Entfernt in 1.3.19:** `home_assistant_integration.mqtt_enabled` und `mqtt_topic_prefix` waren nie implementiert (Sensoren laufen ausschließlich über die HA-REST-API). Alte Werte in den Optionen werden ignoriert und beim Laden verworfen; `paho-mqtt` ist keine Abhängigkeit mehr.

### 💾 Schreiblast (SD-Karte / eMMC)

Der Poller schreibt `favorites.json`, `watchlist.json` und `charge_session.json` nur noch, wenn sich der Inhalt wirklich ändert (Belegung, Status, Anschlüsse, Warn-Flags des Lade-Wächters). Minütlich wechselnde Werte – die relative Belegungsdauer der Anschlüsse („vor 12 Min.“), der Quell-Zeitstempel `last_updated` und der Countdown `remaining_minutes` – hält das Add-on nur im Speicher; die API liefert sie trotzdem aktuell aus. Nach einem Neustart sind sie nach dem ersten Abruf wieder frisch.

---

## 📱 Android-APK unterwegs mit Home Assistant verbinden

Das Add-on ist nur per Ingress erreichbar (kein offener Port). Die APK spricht deshalb ausschließlich mit der **offiziellen Home-Assistant-REST-API**:

| Richtung | Aufruf | Zweck |
|---|---|---|
| Add-on → APK | `GET /api/states/sensor.ev_charge_live_bridge` | Favoriten, Beobachtungsliste und Lade-Wächter inkl. Live-Belegung (vom Add-on alle Poll-Zyklen aktualisiert) |
| APK → Add-on | `POST /api/events/ev_charge_live_command` | Watchlist/Favoriten ändern, Lade-Wächter starten/stoppen, Sync, Test-Push |

Das Add-on abonniert das Event über die Supervisor-WebSocket-API und bestätigt jeden Befehl (`request_id`) im Attribut `recent_commands` des Bridge-Sensors – so zeigt die APK an, ob eine Änderung wirklich im Add-on angekommen ist.

**Einrichtung:** In der Add-on-Oberfläche unter *Einstellungen → 1-Klick Smartphone-Kopplung* den QR-Code mit der APK scannen (oder URL + Token in der APK eintragen und *Verbindung testen*).
* Für unterwegs die **externe URL** eintragen (z. B. Nabu Casa `https://….ui.nabu.casa`), nicht `homeassistant.local`.
* Der Long-Lived-Token muss zu einem **Admin-Benutzer** gehören (HA erlaubt Events über die REST-API nur Admins).
* Optional: `sensor.ev_charge_live_bridge` im Recorder ausschließen, wenn du keinen Verlauf davon brauchst.

Befehle lassen sich auch aus eigenen Automationen senden:
```yaml
action:
  - event: ev_charge_live_command
    event_data:
      action: watchlist_add          # watchlist_remove, favorite_add, favorite_remove, session_stop, sync, test_notify
      station:
        id: "DE*SWH*E1001"
```

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

---

## 🛠️ Build & Deploy

Das Frontend wird nur in `app/static/` bearbeitet. `www/` (Web-Assets der Android-App) ist eine Kopie davon und wird per Skript erzeugt.

| Befehl | Was passiert |
| :--- | :--- |
| `npm run bump 1.3.19` | Setzt die Version in `config.yaml`, `package.json`, `package-lock.json`, `android/app/build.gradle` (`versionName`, `versionCode` + 1), in den `badge-app-version`-Badges und im Cache-Busting `?v=` von `index.html`. Danach läuft `build:www`. |
| `npm run build:www` | Prüft, dass alle Versionsangaben übereinstimmen, und kopiert `app/static/` nach `www/`. |
| `npm run check:versions` | Prüft nur und meldet, wenn `www/` veraltet ist. Läuft auch in der CI. |
| `npm run apk` | `build:www` → `npx cap sync android` → Gradle `assembleDebug` → `dist/ev-charge-live-v<version>.apk`. Braucht JDK 17 und `ANDROID_HOME`. |
| `scripts/deploy-ha.sh --dry-run` | Zeigt (in Git Bash), welche Add-on-Dateien übertragen würden, ohne Home Assistant zu kontaktieren. |
| `scripts/deploy-ha.sh` | Sichert `/addons/ha-ev-charge-live` lokal nach `../ha-ev-charge-live-backups/` und überträgt dann `config.yaml`, `Dockerfile`, `build.yaml`, `run.sh`, `requirements.txt`, `README.md` und `app/` per SSH. |

Nach dem Deploy in Home Assistant den Add-on-Store neu laden und das Add-on `local_ev_charge_live` aktualisieren.
Ziel, SSH-Key und Backup-Ordner lassen sich über `HA_SSH_TARGET`, `HA_SSH_KEY`, `HA_ADDON_DIR` und `BACKUP_DIR` ändern.

Tests: `pytest tests` und `node tests/test_frontend.js`. Beide laufen bei jedem Push in GitHub Actions (`.github/workflows/tests.yml`).
APKs sollen künftig als GitHub-Release-Assets statt im Repo liegen, siehe [docs/apk-releases.md](docs/apk-releases.md).
