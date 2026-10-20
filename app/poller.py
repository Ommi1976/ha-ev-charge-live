import asyncio
import datetime
import logging
import os
import re
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo
import httpx

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
            try:
                await self.sync_favorites()
            except asyncio.CancelledError:
                break
            except Exception as err:
                _LOGGER.error("Error in sync loop: %s", err, exc_info=True)

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
        """Fetches live status for all favorited stations and updates Home Assistant with debounce hysteresis."""
        async with self._lock:
            favorites = storage.load_favorites()
            if not favorites:
                _LOGGER.debug("No favorites configured to sync.")
                return

            config = storage.load_config()
            live_map: Dict[str, Dict[str, Any]] = {}

            # Drop debounce state of stations that are no longer favorites (bounded memory)
            fav_ids = {str(f.get("id")) for f in favorites}
            for cache in (self._previous_states, self._candidate_keys, self._candidate_counts):
                for stale in [k for k in cache if k not in fav_ids]:
                    cache.pop(stale, None)

            for fav in favorites:
                station_id = str(fav.get("id"))
                try:
                    live_station = await ev_client.get_station_by_id(station_id)
                    if not live_station:
                        _LOGGER.warning("Could not fetch station %s, keeping previous state", station_id)
                        live_map[station_id] = self._previous_states.get(station_id, fav)
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
                                if storage.is_on_watchlist(station_id):
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
                    live_map[station_id] = self._previous_states.get(station_id, fav)

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


poller = SyncWorker()
