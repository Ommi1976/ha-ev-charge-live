import datetime
import logging
import os
import re
from typing import Any, Dict, Optional
import httpx

_LOGGER = logging.getLogger("ev_charge_live.notifier")

SUPERVISOR_URL = "http://supervisor/core/api"
SAFE_NOTIFY_RE = re.compile(r"^notify\.[a-z0-9_]+$")


class _SafeFormatDict(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


class HANotifier:
    def __init__(self) -> None:
        self._last_notified: Dict[str, datetime.datetime] = {}
        self._token = os.getenv("SUPERVISOR_TOKEN", "")

    def _get_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    async def notify_slot_freed(
        self,
        station: Dict[str, Any],
        config: Dict[str, Any],
        force: bool = False
    ) -> bool:
        """Sends a push notification to Home Assistant if cooldown has elapsed."""
        notify_cfg = config.get("notifications", {})
        if not notify_cfg.get("enabled", True) and not force:
            return False

        station_id = str(station.get("id"))
        try:
            cooldown_min = float(notify_cfg.get("cooldown_minutes", 10))
        except (TypeError, ValueError):
            cooldown_min = 10.0
        now = datetime.datetime.now()

        # Cooldown check
        if not force and station_id in self._last_notified:
            diff = (now - self._last_notified[station_id]).total_seconds()
            if diff < (cooldown_min * 60):
                _LOGGER.debug(
                    "Skipping notification for station %s (cooldown active: %.0fs remaining)",
                    station_id, (cooldown_min * 60) - diff
                )
                return False

        # Format message and title safely
        station_name = station.get("name") or station.get("address") or "Ladestation"
        address = station.get("address") or ""
        free_slots = station.get("free_slots", 1)
        total_slots = station.get("total_slots", 2)
        operator = station.get("operator", "")
        power_values = []
        for c in station.get("connectors") or []:
            try:
                power_values.append(float(c.get("power_kw", 0)))
            except (AttributeError, TypeError, ValueError):
                continue
        max_power_kw = max(power_values or [22.0])

        title_tpl = str(notify_cfg.get("title_template") or "⚡ Ladestation frei: {station_name}")
        msg_tpl = str(notify_cfg.get(
            "message_template",
            "An {station_name} ({address}) sind jetzt {free_slots} von {total_slots} Plätzen ({max_power_kw} kW) frei!"
        ))

        tpl_vars = _SafeFormatDict(
            station_name=station_name,
            address=address,
            free_slots=free_slots,
            total_slots=total_slots,
            operator=operator,
            max_power_kw=max_power_kw
        )
        try:
            title = title_tpl.format_map(tpl_vars)
        except Exception:
            title = f"⚡ Ladestation frei: {station_name}"

        try:
            message = msg_tpl.format_map(tpl_vars)
        except Exception:
            message = f"An {station_name} ({address}) sind jetzt {free_slots} von {total_slots} Plätzen frei!"

        lat = station.get("latitude")
        lon = station.get("longitude")
        gmaps_url = f"https://www.google.com/maps/dir/?api=1&destination={lat},{lon}" if lat and lon else "/ev_charge_live"

        actions = [
            {
                "action": "URI",
                "title": "🧭 Google Maps",
                "uri": gmaps_url
            },
            {
                "action": "SEND_TO_CUPRA",
                "title": "🚗 An Cupra senden"
            }
        ]

        target_devices = notify_cfg.get("target_devices")
        if not target_devices or not isinstance(target_devices, list):
            single_svc = notify_cfg.get("service", "notify.mobile_app_2407fpn8eg")
            target_devices = [single_svc] if single_svc else ["notify.mobile_app_2407fpn8eg"]

        notify_payload = {
            "title": title,
            "message": message,
            "data": {
                "tag": f"ev_charge_{station_id}",
                "url": gmaps_url,
                "clickAction": gmaps_url,
                "actions": actions
            }
        }

        # 1. Call Notify Service for each configured target device
        success = False
        for dev_str in dict.fromkeys(str(d).strip().lower() for d in target_devices):
            # Only notify.* services may be called from (UI-editable) config
            if not SAFE_NOTIFY_RE.match(dev_str):
                _LOGGER.warning("Ignoring invalid notify target: %r", dev_str)
                continue
            service = dev_str.split(".", 1)[1]
            ok = await self._call_service("notify", service, notify_payload)
            if ok:
                success = True

        # 2. Fire HA Event for custom automations
        ha_cfg = config.get("home_assistant_integration", {})
        if ha_cfg.get("fire_ha_events", True):
            await self._fire_event("ev_charge_slot_freed", {
                "station_id": station_id,
                "name": station_name,
                "address": address,
                "operator": operator,
                "free_slots": free_slots,
                "total_slots": total_slots,
                "latitude": station.get("latitude"),
                "longitude": station.get("longitude")
            })

        if success or force:
            self._last_notified[station_id] = now
            _LOGGER.info("Sent push notification for station %s: %s", station_id, title)
            return True

        return False

    async def notify_charge_guardian(
        self,
        session: Dict[str, Any],
        alert_type: str,
        config: Dict[str, Any]
    ) -> bool:
        """Sends a push notification to Home Assistant for active charging session alerts (20m, 5m, fee, SoC)."""
        station_name = session.get("station_name") or "Ladestation"
        connector_label = session.get("connector_label") or "Anschluss"
        target_soc = session.get("target_soc", 80)
        fee_per_min = session.get("blocking_fee_per_min", 0.10)

        if alert_type == "warning_20":
            title = f"⚠️ Noch 20 Min. Freiparkzeit ({station_name})"
            message = f"An {station_name} ({connector_label}) endet in 20 Minuten die kostenfreie Ladezeit. Bitte plane das Umparken ein."
        elif alert_type == "warning_5":
            title = f"🚨 DRINGEND: Blockiergebühr in 5 Min.! ({station_name})"
            message = f"Nur noch 5 Minuten Freiparkzeit an {station_name}! Anschließend fallen {fee_per_min:.2f} €/Min. Standgebühr an."
        elif alert_type == "fee_active":
            title = f"⛔ Blockiergebühr jetzt aktiv! ({station_name})"
            message = f"Die Freiparkzeit an {station_name} ist abgelaufen. Dein Cupra Born steht ab jetzt in der kostenpflichtigen Blockierphase ({fee_per_min:.2f} €/Min.)!"
        elif alert_type == "target_soc":
            title = f"🎯 Ziel-Akkustand erreicht ({target_soc}%)"
            message = f"Dein Cupra Born hat an {station_name} ({connector_label}) den gewünschten Ziel-SoC von {target_soc}% erreicht!"
        else:
            title = f"⚡ Lade-Wächter Info ({station_name})"
            message = f"Lade-Wächter Status-Update für {station_name}."

        lat = session.get("latitude")
        lon = session.get("longitude")
        gmaps_url = f"https://www.google.com/maps/dir/?api=1&destination={lat},{lon}" if lat and lon else "/ev_charge_live"

        actions = [
            {
                "action": "URI",
                "title": "🧭 Zu Google Maps",
                "uri": gmaps_url
            }
        ]

        notify_cfg = config.get("notifications", {})
        target_devices = notify_cfg.get("target_devices")
        if not target_devices or not isinstance(target_devices, list):
            single_svc = notify_cfg.get("service", "notify.mobile_app_2407fpn8eg")
            target_devices = [single_svc] if single_svc else ["notify.mobile_app_2407fpn8eg"]

        notify_payload = {
            "title": title,
            "message": message,
            "data": {
                "tag": f"ev_charge_guardian_{session.get('station_id')}_{alert_type}",
                "url": gmaps_url,
                "clickAction": gmaps_url,
                "actions": actions
            }
        }

        success = False
        for dev_str in dict.fromkeys(str(d).strip().lower() for d in target_devices):
            if not SAFE_NOTIFY_RE.match(dev_str):
                continue
            service = dev_str.split(".", 1)[1]
            ok = await self._call_service("notify", service, notify_payload)
            if ok:
                success = True

        ha_cfg = config.get("home_assistant_integration", {})
        if ha_cfg.get("fire_ha_events", True):
            await self._fire_event("ev_charge_guardian_alert", {
                "alert_type": alert_type,
                "station_id": session.get("station_id"),
                "station_name": station_name,
                "connector_label": connector_label,
                "target_soc": target_soc,
                "latitude": lat,
                "longitude": lon
            })

        _LOGGER.info("Sent charge guardian alert '%s' for station %s: %s", alert_type, station_name, title)
        return success

    async def send_test_notification(self, config: Dict[str, Any]) -> bool:
        """Sends an immediate test notification to verify HA companion app setup."""
        dummy_station = {
            "id": "test_999",
            "name": "Stadtwerke Hockenheim (Test)",
            "address": "Schubertstr. 5, 68766 Hockenheim",
            "operator": "Stadtwerke Hockenheim",
            "free_slots": 2,
            "total_slots": 2,
            "latitude": 49.317584,
            "longitude": 8.545261
        }
        return await self.notify_slot_freed(dummy_station, config, force=True)

    async def _call_service(self, domain: str, service: str, data: Dict[str, Any]) -> bool:
        """Calls a Home Assistant Core service via the Supervisor API."""
        if not self._token:
            _LOGGER.warning("SUPERVISOR_TOKEN not set. Simulating service call: %s.%s", domain, service)
            return False

        url = f"{SUPERVISOR_URL}/services/{domain}/{service}"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, json=data, headers=self._get_headers())
                if resp.status_code in (200, 201):
                    return True
                _LOGGER.error("HA Service call failed: HTTP %s - %s", resp.status_code, resp.text)
                return False
        except Exception as err:
            _LOGGER.error("Error communicating with Home Assistant Core: %s", err)
            return False

    async def _fire_event(self, event_type: str, event_data: Dict[str, Any]) -> bool:
        """Fires an event on the Home Assistant event bus."""
        if not self._token:
            return False

        url = f"{SUPERVISOR_URL}/events/{event_type}"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, json=event_data, headers=self._get_headers())
                return resp.status_code in (200, 201)
        except Exception as err:
            _LOGGER.error("Failed to fire HA event %s: %s", event_type, err)
            return False


notifier = HANotifier()
