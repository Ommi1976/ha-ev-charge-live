import asyncio
from collections import deque
import datetime
import logging
import math
import os
import re
from typing import Any, Deque, Dict, Optional
from zoneinfo import ZoneInfo
import httpx

from .bridge import BRIDGE_ENTITY_ID, MAX_RECENT_COMMANDS, build_bridge_attributes
from .client import ev_client
from .notifier import notifier
from .storage import storage

_LOGGER = logging.getLogger("ev_charge_live.poller")
try:
    BERLIN_TZ = ZoneInfo("Europe/Berlin")
except Exception:
    BERLIN_TZ = datetime.timezone(datetime.timedelta(hours=1), name="CET")


SUPERVISOR_URL = "http://supervisor/core/api"
SAFE_PREFIX_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]*$")


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def is_night_hour(hour: int, night_start_hour: int, night_end_hour: int) -> bool:
    """True if `hour` lies in the fee-free night window; handles windows across midnight (21-9) and within a day (1-5)."""
    if night_start_hour == night_end_hour:
        return False
    if night_start_hour > night_end_hour:
        return hour >= night_start_hour or hour < night_end_hour
    return night_start_hour <= hour < night_end_hour


def _next_at_hour(curr: datetime.datetime, hour: int) -> datetime.datetime:
    """Next point in time strictly after `curr` with wall-clock time hour:00."""
    candidate = curr.replace(hour=hour, minute=0, second=0, microsecond=0)
    if candidate <= curr:
        candidate += datetime.timedelta(days=1)
    return candidate


def calculate_blocking_deadline(
    start_dt: datetime.datetime,
    free_minutes: int,
    night_start_hour: int = 21,
    night_end_hour: int = 9
) -> datetime.datetime:
    """Calculates the exact deadline when blocking fees start, taking night exemption into account."""
    remaining_mins = float(max(0, free_minutes))
    night_start_hour = int(night_start_hour) % 24
    night_end_hour = int(night_end_hour) % 24
    if remaining_mins <= 0 or night_start_hour == night_end_hour:
        return start_dt + datetime.timedelta(minutes=remaining_mins)

    curr = start_dt
    # Every iteration either skips a whole night or consumes a whole day segment, so this
    # terminates quickly; the bound only guards against unforeseen edge cases (e.g. DST).
    for _ in range(64):
        if is_night_hour(curr.hour, night_start_hour, night_end_hour):
            curr = _next_at_hour(curr, night_end_hour)
            continue
        night_begin = _next_at_hour(curr, night_start_hour)
        mins_until_night = (night_begin - curr).total_seconds() / 60.0
        if remaining_mins <= mins_until_night:
            return curr + datetime.timedelta(minutes=remaining_mins)
        remaining_mins -= mins_until_night
        curr = night_begin

    return curr + datetime.timedelta(minutes=remaining_mins)


def slugify(text: str) -> str:
    """Transforms a string into a safe entity_id component."""
    text = text.lower()
    text = re.sub(r"[äÄ]", "ae", text)
    text = re.sub(r"[öÖ]", "oe", text)
    text = re.sub(r"[üÜ]", "ue", text)
    text = re.sub(r"[ß]", "ss", text)
    text = re.sub(r"[^a-z0-9_]+", "_", text)
    return text.strip("_")


class SyncWorker:
    def __init__(self) -> None:
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._previous_states: Dict[str, Dict[str, Any]] = {}
        self._candidate_keys: Dict[str, Any] = {}
        self._candidate_counts: Dict[str, int] = {}
        self._token = os.getenv("SUPERVISOR_TOKEN", "")
        self._lock = asyncio.Lock()
        self._session_lock = asyncio.Lock()
        self._bridge_lock = asyncio.Lock()
        self._recent_commands: Deque[Dict[str, Any]] = deque(maxlen=MAX_RECENT_COMMANDS)

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        _LOGGER.info("EV Charge Live background poller started.")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        _LOGGER.info("EV Charge Live background poller stopped.")

    async def _run_loop(self) -> None:
        while self._running:
            # Independent steps: a failing station sync must not silence the charge guardian
            for step in (self.sync_favorites, self.check_charge_session, self.publish_bridge_state):
                try:
                    await step()
                except asyncio.CancelledError:
                    return
                except Exception as err:
                    _LOGGER.error("Error in %s: %s", step.__name__, err, exc_info=True)

            try:
                config = storage.load_config()
                interval = int(config.get("polling", {}).get("interval_seconds", 60))
            except Exception:
                interval = 60
            try:
                await asyncio.sleep(max(15, interval))
            except asyncio.CancelledError:
                break

    async def sync_favorites(self) -> None:
        """Fetches live status for all favorited and watched stations and updates Home Assistant with debounce hysteresis."""
        async with self._lock:
            favorites = storage.load_favorites()
            watchlist = storage.load_watchlist()

            # Merge favorites and watchlist to ensure all monitored stations are polled
            stations_to_sync: Dict[str, Dict[str, Any]] = {}
            for f in favorites:
                fid = str(f.get("id") or "").strip()
                if fid:
                    stations_to_sync[fid] = f
            for w in watchlist:
                wid = str(w.get("id") or "").strip()
                if wid and wid not in stations_to_sync:
                    stations_to_sync[wid] = w

            if not stations_to_sync:
                _LOGGER.debug("No favorites or watchlist stations configured to sync.")
                return

            config = storage.load_config()
            live_map: Dict[str, Dict[str, Any]] = {}
            watch_ids = {str(w.get("id") or "").strip() for w in watchlist if w.get("id")}
            all_ids = set(stations_to_sync.keys())

            # Drop debounce state of stations that are neither favorites nor on watchlist (bounded memory)
            for cache in (self._previous_states, self._candidate_keys, self._candidate_counts):
                for stale in [k for k in cache if k not in all_ids]:
                    cache.pop(stale, None)

            for station_id, station_stub in stations_to_sync.items():
                try:
                    live_station = await ev_client.get_station_by_id(station_id)
                    if not live_station:
                        _LOGGER.warning("Could not fetch station %s, keeping previous state", station_id)
                        live_map[station_id] = self._previous_states.get(station_id, station_stub)
                        continue

                    # Check state transition for push notifications and debouncing
                    prev = self._previous_states.get(station_id)
                    if prev is None:
                        # First initial reading: commit immediately
                        self._previous_states[station_id] = live_station
                        live_map[station_id] = live_station
                        await self._push_to_home_assistant(live_station, config)
                        continue

                    prev_key = (prev.get("free_slots"), prev.get("status"))
                    curr_key = (live_station.get("free_slots"), live_station.get("status"))

                    if prev_key == curr_key:
                        # State is identical / stable: reset candidate counter and update attributes (timestamps)
                        self._candidate_counts.pop(station_id, None)
                        self._candidate_keys.pop(station_id, None)
                        self._previous_states[station_id] = live_station
                        live_map[station_id] = live_station
                        await self._push_to_home_assistant(live_station, config)
                    else:
                        # Potential state change detected: apply debounce hysteresis
                        cand_key = self._candidate_keys.get(station_id)
                        if cand_key == curr_key:
                            self._candidate_counts[station_id] = self._candidate_counts.get(station_id, 0) + 1
                        else:
                            self._candidate_keys[station_id] = curr_key
                            self._candidate_counts[station_id] = 1

                        # Require 2 consecutive cycles to confirm state change (eliminates 1-cycle flapping)
                        if self._candidate_counts[station_id] >= 2:
                            _LOGGER.info(
                                "⚡ State transition confirmed for %s after debounce: free %s -> %s (status %s -> %s)",
                                live_station.get("name"), prev.get("free_slots"), live_station.get("free_slots"),
                                prev.get("status"), live_station.get("status")
                            )
                            prev_free = _as_int(prev.get("free_slots"))
                            curr_free = _as_int(live_station.get("free_slots"))

                            if curr_free > 0 and (prev_free == 0 or curr_free > prev_free):
                                _LOGGER.info(
                                    "⚡ Free slot confirmed at %s! (Previous: %d, Now: %d)",
                                    live_station.get("name"), prev_free, curr_free
                                )
                                if station_id in watch_ids:
                                    _LOGGER.info("🔔 Station %s is on watchlist -> Sending push notification!", live_station.get("name"))
                                    await notifier.notify_slot_freed(live_station, config)
                                else:
                                    _LOGGER.info("ℹ️ Station %s is favorite but NOT on watchlist -> Push suppressed.", live_station.get("name"))

                            notify_cfg = config.get("notifications", {})
                            if notify_cfg.get("notify_on_all_busy", False) and prev_free > 0 and curr_free == 0:
                                _LOGGER.info("Station %s confirmed fully occupied.", live_station.get("name"))

                            self._previous_states[station_id] = live_station
                            self._candidate_counts.pop(station_id, None)
                            self._candidate_keys.pop(station_id, None)
                            live_map[station_id] = live_station
                            await self._push_to_home_assistant(live_station, config)
                        else:
                            _LOGGER.debug(
                                "Debouncing state jitter for %s (candidate: %s free, %s; cycle 1/2). Suppressing sensor flip.",
                                live_station.get("name"), live_station.get("free_slots"), live_station.get("status")
                            )
                            # Retain previous confirmed state so sensors & UI don't flicker
                            live_map[station_id] = prev

                except Exception as err:
                    _LOGGER.error("Failed to sync station %s: %s", station_id, err)
                    live_map[station_id] = self._previous_states.get(station_id, station_stub)

            storage.update_favorites_live(live_map)
            storage.update_watchlist_live(live_map)

    async def _push_to_home_assistant(self, station: Dict[str, Any], config: Dict[str, Any]) -> None:
        """Pushes state and rich attributes to Home Assistant REST states endpoint."""
        if not self._token:
            _LOGGER.debug("No SUPERVISOR_TOKEN available, skipping HA sensor update.")
            return

        ha_cfg = config.get("home_assistant_integration", {})
        prefix = str(ha_cfg.get("entity_prefix") or "sensor.ev_charge_")
        if not SAFE_PREFIX_RE.match(prefix):
            prefix = "sensor.ev_charge_"

        # Clean slug for entity_id
        safe_name = slugify(f"{station.get('operator', '')}_{station.get('address', '')}")
        if not safe_name:
            safe_name = slugify(f"station_{station.get('id')}") or "station_unknown"
        safe_name = safe_name[:150]
        entity_id = f"{prefix}{safe_name}"

        # State text
        free_slots = _as_int(station.get("free_slots"))
        total_slots = _as_int(station.get("total_slots"))
        status = station.get("status", "AVAILABLE")

        if status == "OUTOFORDER":
            state = "Außer Betrieb"
        elif free_slots == 0:
            state = "Belegt"
        elif free_slots == total_slots:
            state = "Frei"
        else:
            state = "Teilweise belegt"

        connectors_summary = [
            f"{c.get('point_label') or f'LP {idx + 1}'}: {c.get('standard')} {c.get('power_kw')} kW ({'Frei' if c.get('status') in ('AVAILABLE', 'FREE') else 'Belegt'})"
            for idx, c in enumerate(station.get("connectors") or []) if isinstance(c, dict)
        ]

        attributes = {
            "friendly_name": station.get("name") or station.get("address"),
            "station_id": station.get("id"),
            "operator": station.get("operator"),
            "address": station.get("address"),
            "postal_code": station.get("postal_code"),
            "city": station.get("city"),
            "free_slots": free_slots,
            "total_slots": total_slots,
            "occupied_slots": station.get("occupied_slots", 0),
            "status_code": status,
            "connectors": connectors_summary,
            "connector_details": station.get("connectors", []),
            "max_power_kw": max([_as_float(c.get("power_kw")) for c in station.get("connectors") or [] if isinstance(c, dict)] or [22.0]),
            "google_maps_url": f"https://www.google.com/maps/dir/?api=1&destination={station.get('latitude')},{station.get('longitude')}",
            "live_source": station.get("live_source", "MobiData BW"),
            "latitude": station.get("latitude"),
            "longitude": station.get("longitude"),
            "icon": "mdi:ev-station",
            "last_synced": datetime.datetime.now(tz=BERLIN_TZ).isoformat()
        }

        url = f"{SUPERVISOR_URL}/states/{entity_id}"
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json"
        }
        payload = {
            "state": state,
            "attributes": attributes
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, json=payload, headers=headers)
                if resp.status_code in (200, 201):
                    _LOGGER.debug("Pushed state for %s -> %s", entity_id, state)
                else:
                    _LOGGER.error("Failed to push state for %s: %s", entity_id, resp.text)
        except Exception as err:
            _LOGGER.error("Error pushing state to HA: %s", err)

        # Optional Device Tracker
        if ha_cfg.get("create_device_tracker", True) and station.get("latitude") and station.get("longitude"):
            tracker_id = f"device_tracker.ev_charge_{safe_name}"
            tracker_payload = {
                "state": "home" if free_slots > 0 else "not_home",
                "attributes": {
                    "friendly_name": f"Standort {station.get('name')}",
                    "latitude": station.get("latitude"),
                    "longitude": station.get("longitude"),
                    "source_type": "gps",
                    "icon": "mdi:ev-station",
                    "free_slots": free_slots
                }
            }
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(f"{SUPERVISOR_URL}/states/{tracker_id}", json=tracker_payload, headers=headers)
            except Exception as err:
                _LOGGER.debug("Could not update device tracker: %s", err)

    async def check_charge_session(self) -> None:
        """Evaluates active smart charge session, sends warnings (20m, 5m, fee, SoC) and updates HA sensor."""
        async with self._session_lock:
            session = storage.load_charge_session()
            config = storage.load_config()

            if not session:
                if getattr(self, "_last_session_active", False):
                    self._last_session_active = False
                    await self._push_session_to_home_assistant(None, config)
                return

            self._last_session_active = True
            now = datetime.datetime.now(tz=BERLIN_TZ)
            now_ms = int(now.timestamp() * 1000)

            start_ms = session.get("start_time_ms") or now_ms
            try:
                start_dt = datetime.datetime.fromtimestamp(start_ms / 1000.0, tz=BERLIN_TZ)
            except Exception:
                start_dt = now

            free_mins = _as_int(session.get("free_parking_minutes"), 240)
            night_start = _as_int(session.get("night_window_start"), 21) % 24
            night_end = _as_int(session.get("night_window_end"), 9) % 24
            has_night = bool(session.get("has_night_rule", True))

            if has_night:
                deadline = calculate_blocking_deadline(start_dt, free_mins, night_start, night_end)
            else:
                deadline = start_dt + datetime.timedelta(minutes=free_mins)

            diff_sec = (deadline - now).total_seconds()
            # Round up: with 30 s left the fee is not active yet
            rem_mins = math.ceil(diff_sec / 60)

            is_night = has_night and is_night_hour(now.hour, night_start, night_end)

            if rem_mins <= 0:
                state = "Blockiergebühr aktiv"
            elif is_night:
                state = "Nachtpause (Frei)"
            elif rem_mins <= 5:
                state = "Dringend (5 Min)"
            elif rem_mins <= 20:
                state = "Warnung (20 Min)"
            else:
                state = "Frei laden"

            # Flags are persisted *before* sending (no duplicate pushes) and only if the session
            # was not stopped/replaced meanwhile (a stopped session must stay stopped).
            async def _alert(alert_type: str, *flags: str) -> None:
                for flag in flags:
                    session[flag] = True
                if storage.save_charge_session(session, only_if_current=True):
                    await notifier.notify_charge_guardian(session, alert_type, config)

            # 1. Target SoC notification
            target_reached_ms = session.get("target_reached_ms")
            if target_reached_ms and now_ms >= target_reached_ms and not session.get("notified_soc"):
                await _alert("target_soc", "notified_soc")

            # 2. Blocking fee pre-warnings
            if not is_night:
                if 5 < rem_mins <= 20 and not session.get("notified_20"):
                    await _alert("warning_20", "notified_20")
                elif 0 < rem_mins <= 5 and not session.get("notified_5"):
                    await _alert("warning_5", "notified_20", "notified_5")
                elif rem_mins <= 0 and not session.get("notified_fee"):
                    await _alert("fee_active", "notified_20", "notified_5", "notified_fee")

            session["remaining_minutes"] = max(0, rem_mins)
            session["deadline_iso"] = deadline.isoformat()
            session["deadline_str"] = deadline.strftime("%H:%M")
            session["deadline_ms"] = int(deadline.timestamp() * 1000)
            session["is_night_paused"] = is_night
            session["state"] = state
            if storage.save_charge_session(session, only_if_current=True):
                await self._push_session_to_home_assistant(session, config)

    async def _push_session_to_home_assistant(
        self,
        session: Optional[Dict[str, Any]],
        config: Dict[str, Any]
    ) -> None:
        """Pushes active charging session to sensor.ev_charge_session in Home Assistant."""
        if not self._token:
            return

        ha_cfg = config.get("home_assistant_integration", {})
        prefix = str(ha_cfg.get("entity_prefix") or "sensor.ev_charge_")
        if not SAFE_PREFIX_RE.match(prefix):
            prefix = "sensor.ev_charge_"
        entity_id = f"{prefix}session"

        if not session:
            payload = {
                "state": "Inaktiv",
                "attributes": {
                    "friendly_name": "EV Charge Live: Lade-Wächter",
                    "icon": "mdi:ev-station",
                    "station_name": None,
                    "remaining_minutes": 0,
                    "is_active": False,
                    "last_synced": datetime.datetime.now(tz=BERLIN_TZ).isoformat()
                }
            }
        else:
            state = session.get("state", "Frei laden")
            rem_mins = session.get("remaining_minutes", 0)
            is_night = session.get("is_night_paused", False)
            if rem_mins <= 0:
                icon = "mdi:alert-octagon"
            elif rem_mins <= 20:
                icon = "mdi:timer-alert"
            elif is_night:
                icon = "mdi:weather-night"
            else:
                icon = "mdi:battery-charging"

            payload = {
                "state": state,
                "attributes": {
                    "friendly_name": f"Lade-Wächter: {session.get('station_name')}",
                    "icon": icon,
                    "station_name": session.get("station_name"),
                    "station_id": session.get("station_id"),
                    "connector_label": session.get("connector_label"),
                    "remaining_minutes": rem_mins,
                    "deadline": session.get("deadline_str"),
                    "deadline_iso": session.get("deadline_iso"),
                    "is_night_paused": is_night,
                    "target_soc": session.get("target_soc"),
                    "target_soc_eta_str": session.get("target_soc_eta_str"),
                    "blocking_fee_per_min": session.get("blocking_fee_per_min", 0.10),
                    "is_active": True,
                    "last_synced": datetime.datetime.now(tz=BERLIN_TZ).isoformat()
                }
            }

        url = f"{SUPERVISOR_URL}/states/{entity_id}"
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json"
        }
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(url, json=payload, headers=headers)
        except Exception as err:
            _LOGGER.debug("Failed to push session sensor to Home Assistant: %s", err)

    def record_command(self, ack: Dict[str, Any]) -> None:
        """Remembers a command acknowledgement for the next bridge publish."""
        self._recent_commands.append(ack)

    async def publish_bridge_state(self) -> None:
        """Mirrors favorites, watchlist, charge session and command acks into the APK bridge sensor."""
        if not self._token:
            return
        # Serialized and read inside the lock, so an older snapshot can never overwrite a newer one
        async with self._bridge_lock:
            attributes = build_bridge_attributes(
                storage.load_favorites(),
                storage.load_watchlist(),
                storage.load_charge_session(),
                list(self._recent_commands),
            )
            monitored = set(attributes["favorite_ids"]) | set(attributes["watch_ids"])
            payload = {"state": str(len(monitored)), "attributes": attributes}
            headers = {
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json"
            }
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    resp = await client.post(f"{SUPERVISOR_URL}/states/{BRIDGE_ENTITY_ID}", json=payload, headers=headers)
                    if resp.status_code not in (200, 201):
                        _LOGGER.warning("Failed to publish %s: HTTP %s", BRIDGE_ENTITY_ID, resp.status_code)
            except Exception as err:
                _LOGGER.warning("Error publishing %s: %s", BRIDGE_ENTITY_ID, err)


poller = SyncWorker()
