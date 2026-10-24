import json
import logging
import math
import os
import re
import tempfile
import threading
from typing import Any, Dict, List, Optional

_LOGGER = logging.getLogger("ev_charge_live.storage")

SAFE_ENTITY_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
SAFE_NOTIFY_RE = re.compile(r"^notify\.[a-z0-9_]+$")
SAFE_PREFIX_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]*$")

MAX_CONFIG_BYTES = 64 * 1024
MAX_STATION_BYTES = 32 * 1024
MAX_STATION_LIST = 100
MAX_TARGET_DEVICES = 20
MAX_TEMPLATE_LEN = 500

# Keys that only the client (APK/browser) needs; never persisted server-side
CLIENT_ONLY_SECRET_KEYS = ("ha_token",)

STATION_KEYS = (
    "id", "name", "operator", "address", "postal_code", "city", "latitude", "longitude",
    "distance_km", "total_slots", "free_slots", "occupied_slots", "out_of_order_slots",
    "status", "status_text", "connectors", "live_source", "last_updated", "enbw_station_id",
)

# Fields that change on (almost) every poll without a real status change ("vor 12 Min.",
# source timestamps, countdowns). They don't trigger a file rewrite (flash wear on SD/eMMC);
# their fresh values are kept in memory and persisted with the next real change.
VOLATILE_STATION_KEYS = ("last_updated",)
VOLATILE_CONNECTOR_KEYS = ("duration_str", "duration_minutes")
VOLATILE_SESSION_KEYS = ("remaining_minutes",)

# Options of former versions that no longer exist (dropped from UI overrides / old options.json)
REMOVED_HA_INTEGRATION_KEYS = ("mqtt_enabled", "mqtt_topic_prefix")
LOG_LEVELS = ("debug", "info", "warning", "error")


def _stable_station(station: Any) -> Any:
    """Station without volatile fields; used to decide whether a rewrite is necessary."""
    if not isinstance(station, dict):
        return station
    stable = {k: v for k, v in station.items() if k not in VOLATILE_STATION_KEYS}
    if isinstance(stable.get("connectors"), list):
        stable["connectors"] = [
            {k: v for k, v in c.items() if k not in VOLATILE_CONNECTOR_KEYS} if isinstance(c, dict) else c
            for c in stable["connectors"]
        ]
    return stable


def _stable_session(session: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in session.items() if k not in VOLATILE_SESSION_KEYS}


def _same_content(a: Any, b: Any) -> bool:
    """Equality as stored on disk (tuple vs. list and key order don't matter)."""
    return json.dumps(a, sort_keys=True, ensure_ascii=False, default=str) == \
        json.dumps(b, sort_keys=True, ensure_ascii=False, default=str)


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        num = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return default
    return max(lo, min(hi, num))


def _safe_float(value: Any, lo: float, hi: float) -> Optional[float]:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(num) or num < lo or num > hi:
        return None
    return num


def sanitize_station(station: Any) -> Dict[str, Any]:
    """Reduces an untrusted station payload to known keys and bounded size."""
    if not isinstance(station, dict) or station.get("id") in (None, ""):
        raise ValueError("Invalid station payload: missing 'id'")
    station_id = str(station.get("id")).strip()
    if not station_id or len(station_id) > 128:
        raise ValueError("Invalid station payload: bad 'id'")
    clean = {k: station[k] for k in STATION_KEYS if k in station}
    clean["id"] = station_id
    for key in ("name", "operator", "address", "postal_code", "city", "status", "status_text", "live_source"):
        if key in clean and clean[key] is not None:
            clean[key] = str(clean[key])[:200]
    if not isinstance(clean.get("connectors", []), list):
        clean["connectors"] = []
    elif "connectors" in clean:
        clean["connectors"] = [c for c in clean["connectors"][:50] if isinstance(c, dict)]
    if len(json.dumps(clean, ensure_ascii=False)) > MAX_STATION_BYTES:
        raise ValueError("Station payload too large")
    return clean


SESSION_STR_KEYS = (
    "station_id", "station_name", "connector_label", "target_soc_eta_str",
    "deadline_str", "deadline_iso", "state",
)
SESSION_ALERT_FLAGS = ("notified_soc", "notified_20", "notified_5", "notified_fee")
SESSION_BOOL_KEYS = ("has_night_rule", "is_night_paused") + SESSION_ALERT_FLAGS
# Epoch milliseconds between 2001 and 2096
SESSION_MS_KEYS = ("start_time_ms", "target_reached_ms", "deadline_ms")
SESSION_MS_RANGE = (1_000_000_000_000, 4_000_000_000_000)


def _safe_int(value: Any, lo: int, hi: int) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        num = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return None
    return num if lo <= num <= hi else None


def charge_session_key(session: Optional[Dict[str, Any]]) -> Optional[tuple]:
    """Identity of a charge session; used to avoid overwriting a newer/stopped session."""
    if not session:
        return None
    return (str(session.get("station_id") or ""), session.get("start_time_ms"))


def sanitize_charge_session(session: Dict[str, Any]) -> Dict[str, Any]:
    """Reduces an untrusted charge session to known keys with valid types and ranges."""
    if not isinstance(session, dict):
        return {}
    clean: Dict[str, Any] = {}

    for key in SESSION_STR_KEYS:
        if session.get(key) is not None:
            clean[key] = str(session[key])[:128 if key == "station_id" else 200]

    for key in SESSION_BOOL_KEYS:
        if key in session:
            clean[key] = bool(session[key])

    for key in SESSION_MS_KEYS:
        if key in session:
            val = _safe_int(session[key], *SESSION_MS_RANGE)
            if val is not None:
                clean[key] = val

    if "target_soc" in session:
        clean["target_soc"] = _clamp_int(session["target_soc"], 10, 100, 80)
    if "start_soc" in session:
        clean["start_soc"] = _clamp_int(session["start_soc"], 0, 100, 50)
    if "free_parking_minutes" in session:
        clean["free_parking_minutes"] = _clamp_int(session["free_parking_minutes"], 0, 720, 240)
    if "needed_minutes" in session:
        clean["needed_minutes"] = _clamp_int(session["needed_minutes"], 1, 1440, 60)
    if "remaining_minutes" in session:
        clean["remaining_minutes"] = _clamp_int(session["remaining_minutes"], 0, 100_000, 0)
    for key in ("night_window_start", "night_window_end"):
        if key in session:
            val = _safe_int(session[key], 0, 23)
            if val is not None:
                clean[key] = val
    for key in ("fee_per_minute", "blocking_fee_per_min"):
        if key in session:
            val = _safe_float(session[key], 0.0, 10.0)
            clean[key] = val if val is not None else 0.10
    for key, lo, hi in (("latitude", -90.0, 90.0), ("longitude", -180.0, 180.0)):
        if key in session:
            val = _safe_float(session[key], lo, hi)
            if val is not None:
                clean[key] = val
    return clean


def prepare_charge_session(session: Any, now_ms: int) -> Dict[str, Any]:
    """Validates a new charge session (Ingress POST or APK event); raises ValueError if unusable."""
    clean = sanitize_charge_session(session)
    if not clean.get("station_id") and not clean.get("station_name"):
        raise ValueError("station_id or station_name required")
    # Missing/invalid start time would push the deadline forward on every poll -> never alert
    clean.setdefault("start_time_ms", now_ms)
    return clean


def sanitize_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Validates/clamps known config fields in-place so bad UI/options values can't break the add-on."""
    for key in CLIENT_ONLY_SECRET_KEYS:
        cfg.pop(key, None)

    polling = cfg.get("polling")
    if isinstance(polling, dict):
        if "interval_seconds" in polling:
            polling["interval_seconds"] = _clamp_int(polling["interval_seconds"], 15, 600, 60)
        if "request_timeout" in polling:
            polling["request_timeout"] = _clamp_int(polling["request_timeout"], 5, 60, 15)

    loc = cfg.get("location_defaults")
    if isinstance(loc, dict):
        for key, lo, hi in (("latitude", -90.0, 90.0), ("longitude", -180.0, 180.0)):
            if key in loc and _safe_float(loc[key], lo, hi) is None:
                loc.pop(key)
        if "search_radius_meters" in loc:
            loc["search_radius_meters"] = _clamp_int(loc["search_radius_meters"], 500, 50000, 5000)
        if "device_tracker_entity" in loc:
            tracker = str(loc.get("device_tracker_entity") or "").strip().lower()
            if tracker and not SAFE_ENTITY_RE.match(tracker):
                loc.pop("device_tracker_entity")
            else:
                loc["device_tracker_entity"] = tracker

    notify = cfg.get("notifications")
    if isinstance(notify, dict):
        if "target_devices" in notify:
            devices = notify.get("target_devices")
            if isinstance(devices, list):
                cleaned = []
                for dev in devices[:MAX_TARGET_DEVICES]:
                    dev_str = str(dev).strip().lower()
                    if SAFE_NOTIFY_RE.match(dev_str) and dev_str not in cleaned:
                        cleaned.append(dev_str)
                notify["target_devices"] = cleaned
            else:
                notify.pop("target_devices")
        if "service" in notify:
            svc = str(notify.get("service") or "").strip().lower()
            if SAFE_NOTIFY_RE.match(svc):
                notify["service"] = svc
            else:
                notify.pop("service")
        if "cooldown_minutes" in notify:
            notify["cooldown_minutes"] = _clamp_int(notify["cooldown_minutes"], 1, 120, 10)
        if "min_free_slots_to_trigger" in notify:
            notify["min_free_slots_to_trigger"] = _clamp_int(notify["min_free_slots_to_trigger"], 1, 10, 1)
        for key in ("title_template", "message_template"):
            if key in notify:
                if isinstance(notify[key], str) and notify[key].strip():
                    notify[key] = notify[key][:MAX_TEMPLATE_LEN]
                else:
                    notify.pop(key)

    ha_cfg = cfg.get("home_assistant_integration")
    if isinstance(ha_cfg, dict):
        for key in REMOVED_HA_INTEGRATION_KEYS:
            ha_cfg.pop(key, None)
        if "entity_prefix" in ha_cfg:
            prefix = str(ha_cfg.get("entity_prefix") or "").strip().lower()
            if SAFE_PREFIX_RE.match(prefix) and len(prefix) <= 64:
                ha_cfg["entity_prefix"] = prefix
            else:
                ha_cfg.pop("entity_prefix")

    log_cfg = cfg.get("logging")
    if isinstance(log_cfg, dict) and "level" in log_cfg:
        level = str(log_cfg.get("level") or "").strip().lower()
        if level in LOG_LEVELS:
            log_cfg["level"] = level
        else:
            log_cfg.pop("level")

    return cfg

DEFAULT_OPTIONS: Dict[str, Any] = {
    "polling": {
        "interval_seconds": 60,
        "request_timeout": 15
    },
    "location_defaults": {
        "city": "Hockenheim",
        "postal_code": "68766",
        "latitude": 49.317584,
        "longitude": 8.545261,
        "search_radius_meters": 5000,
        "device_tracker_entity": "device_tracker.2407fpn8eg"
    },
    "notifications": {
        "enabled": True,
        "service": "notify.mobile_app_2407fpn8eg",
        "target_devices": ["notify.mobile_app_2407fpn8eg"],
        "cooldown_minutes": 10,
        "min_free_slots_to_trigger": 1,
        "notify_on_all_busy": False,
        "title_template": "⚡ Ladestation frei: {station_name}",
        "message_template": "An {station_name} ({address}) sind jetzt {free_slots} von {total_slots} Plätzen frei!"
    },
    "home_assistant_integration": {
        "entity_prefix": "sensor.ev_charge_",
        "create_device_tracker": True,
        "fire_ha_events": True,
        # Creates script.ev_charge_live_command for APK commands with non-admin tokens
        "command_script": True
    },
    "logging": {
        "level": "info"
    }
}

def _resolve_data_dir() -> str:
    env_dir = os.getenv("DATA_DIR")
    if env_dir:
        return env_dir
    # In Home Assistant Add-ons, /data exists and is writable.
    # On non-root Linux / local dev environments, fall back to temporary directory.
    if os.path.exists("/data"):
        try:
            if os.access("/data", os.W_OK):
                return "/data"
        except OSError:
            pass
    return os.path.join(tempfile.gettempdir(), "ev-charge-live-data")


DATA_DIR = _resolve_data_dir()
OPTIONS_FILE = os.path.join(DATA_DIR, "options.json")
CONFIG_OVERRIDE_FILE = os.path.join(DATA_DIR, "config_override.json")
FAVORITES_FILE = os.path.join(DATA_DIR, "favorites.json")
WATCHLIST_FILE = os.path.join(DATA_DIR, "watchlist.json")
SESSION_FILE = os.path.join(DATA_DIR, "charge_session.json")


class StorageManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        # Latest live data per station id incl. volatile fields that were not written to disk
        self._live_stations: Dict[str, Dict[str, Any]] = {}
        # (session key, volatile fields) of the stored charge session, kept in memory only
        self._session_volatile: Optional[tuple] = None
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
        except (PermissionError, OSError) as err:
            _LOGGER.warning("Could not create DATA_DIR %s (%s), continuing with memory fallback", DATA_DIR, err)

    def load_config(self) -> Dict[str, Any]:
        """Loads configuration merging defaults, options.json from HA and user overrides."""
        with self._lock:
            config = json.loads(json.dumps(DEFAULT_OPTIONS))

            # Merge HA options.json if present
            if os.path.exists(OPTIONS_FILE):
                try:
                    with open(OPTIONS_FILE, "r", encoding="utf-8") as f:
                        ha_opts = json.load(f)
                        if isinstance(ha_opts, dict):
                            self._deep_merge(config, ha_opts)
                except Exception as err:
                    _LOGGER.warning("Could not read %s: %s", OPTIONS_FILE, err)

            # Merge UI config override if present
            if os.path.exists(CONFIG_OVERRIDE_FILE):
                try:
                    with open(CONFIG_OVERRIDE_FILE, "r", encoding="utf-8") as f:
                        ui_opts = json.load(f)
                        if isinstance(ui_opts, dict):
                            self._deep_merge(config, ui_opts)
                except Exception as err:
                    _LOGGER.warning("Could not read %s: %s", CONFIG_OVERRIDE_FILE, err)

            # Clamp/drop invalid values, then refill dropped keys from defaults
            sanitize_config(config)
            defaults = json.loads(json.dumps(DEFAULT_OPTIONS))
            self._fill_missing(config, defaults)
            return config

    def _atomic_write_json(self, path: str, data: Any) -> None:
        """Atomically writes JSON to disk via thread-locked temporary file and os.replace."""
        with self._lock:
            tmp_path = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                os.replace(tmp_path, path)
            finally:
                if os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass

    def save_config_override(self, new_config: Dict[str, Any]) -> None:
        """Saves configuration overrides from the Web UI atomically."""
        if not isinstance(new_config, dict):
            raise ValueError("Configuration payload must be a JSON object")
        if len(json.dumps(new_config, ensure_ascii=False)) > MAX_CONFIG_BYTES:
            raise ValueError("Configuration payload too large")
        new_config = sanitize_config(json.loads(json.dumps(new_config)))
        try:
            self._atomic_write_json(CONFIG_OVERRIDE_FILE, new_config)
            _LOGGER.info("Config override saved successfully.")
        except Exception as err:
            _LOGGER.error("Failed to save config override: %s", err)
            raise

    def _read_station_list(self, path: str, label: str) -> List[Dict[str, Any]]:
        """Reads a station list exactly as stored on disk."""
        with self._lock:
            if not os.path.exists(path):
                return []
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data if isinstance(data, list) else []
            except Exception as err:
                _LOGGER.warning("Failed to load %s: %s", label, err)
                return []

    def _with_live(self, stations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Overlays the latest in-memory live data; the stored list decides which stations exist."""
        return [
            dict(self._live_stations[str(s.get("id"))]) if str(s.get("id")) in self._live_stations else s
            for s in stations
        ]

    def _update_list_live(self, path: str, label: str, live_map: Dict[str, Dict[str, Any]], save) -> bool:
        """Merges live data into a stored station list; rewrites the file only on real content changes."""
        if not live_map:
            return False
        with self._lock:
            # The poller always passes all monitored stations, so this also forgets removed ones
            self._live_stations = dict(live_map)
            current = self._read_station_list(path, label)
            if not current:
                return False
            merged = [live_map.get(str(item.get("id")), item) for item in current]
            if _same_content([_stable_station(s) for s in merged], [_stable_station(s) for s in current]):
                _LOGGER.debug("%s unchanged, skipping write.", label.capitalize())
                return False
            save(merged)
            return True

    def load_favorites(self) -> List[Dict[str, Any]]:
        """Loads list of monitored favorite charging stations (with latest live data)."""
        with self._lock:
            return self._with_live(self._read_station_list(FAVORITES_FILE, "favorites"))

    def save_favorites(self, favorites: List[Dict[str, Any]]) -> None:
        """Saves list of monitored favorite charging stations atomically."""
        try:
            self._atomic_write_json(FAVORITES_FILE, favorites)
            _LOGGER.info("Saved %d favorites to %s", len(favorites), FAVORITES_FILE)
        except Exception as err:
            _LOGGER.error("Failed to save favorites: %s", err)
            raise

    def update_favorites_live(self, live_map: Dict[str, Dict[str, Any]]) -> bool:
        """Updates existing favorites with fresh live data without overwriting concurrent toggle actions.

        Returns True when favorites.json was rewritten.
        """
        return self._update_list_live(FAVORITES_FILE, "favorites", live_map, self.save_favorites)

    def is_favorite(self, station_id: str) -> bool:
        favs = self.load_favorites()
        return any(str(f.get("id")) == str(station_id) for f in favs)

    def _set_membership(self, load, save, station_data: Dict[str, Any], enabled: bool, limit_error: str) -> bool:
        """Idempotently adds/removes a station from a list. Returns True if the list changed."""
        station_data = sanitize_station(station_data)
        with self._lock:
            items = load()
            station_id = station_data["id"]
            present = any(str(item.get("id")) == station_id for item in items)
            if present == enabled:
                return False
            if enabled:
                if len(items) >= MAX_STATION_LIST:
                    raise ValueError(limit_error)
                items.append(station_data)
            else:
                items = [item for item in items if str(item.get("id")) != station_id]
            save(items)
            return True

    def set_favorite(self, station_data: Dict[str, Any], enabled: bool) -> bool:
        """Adds (enabled=True) or removes a favorite; safe to repeat. Returns True if changed."""
        return self._set_membership(
            self.load_favorites, self.save_favorites, station_data, enabled,
            f"Maximal {MAX_STATION_LIST} Favoriten erlaubt"
        )

    def toggle_favorite(self, station_data: Dict[str, Any]) -> bool:
        """Toggles favorite status. Returns True if added, False if removed."""
        station_data = sanitize_station(station_data)
        with self._lock:
            enabled = not self.is_favorite(station_data["id"])
            self.set_favorite(station_data, enabled)
            return enabled

    def load_watchlist(self) -> List[Dict[str, Any]]:
        """Loads list of stations explicitly placed on the push notification watchlist (with latest live data)."""
        with self._lock:
            return self._with_live(self._read_station_list(WATCHLIST_FILE, "watchlist"))

    def save_watchlist(self, watchlist: List[Dict[str, Any]]) -> None:
        """Saves list of watchlist stations atomically."""
        try:
            self._atomic_write_json(WATCHLIST_FILE, watchlist)
            _LOGGER.info("Saved %d stations to watchlist (%s)", len(watchlist), WATCHLIST_FILE)
        except Exception as err:
            _LOGGER.error("Failed to save watchlist: %s", err)
            raise

    def is_on_watchlist(self, station_id: str) -> bool:
        """Checks if a station is on the push notification watchlist."""
        wl = self.load_watchlist()
        return any(str(item.get("id")) == str(station_id) for item in wl)

    def set_watchlist(self, station_data: Dict[str, Any], enabled: bool) -> bool:
        """Adds (enabled=True) or removes a watchlist station; safe to repeat. Returns True if changed."""
        return self._set_membership(
            self.load_watchlist, self.save_watchlist, station_data, enabled,
            f"Maximal {MAX_STATION_LIST} Stationen auf der Watchlist erlaubt"
        )

    def toggle_watchlist(self, station_data: Dict[str, Any]) -> bool:
        """Toggles watchlist status. Returns True if added, False if removed."""
        station_data = sanitize_station(station_data)
        with self._lock:
            enabled = not self.is_on_watchlist(station_data["id"])
            self.set_watchlist(station_data, enabled)
            return enabled

    def update_watchlist_live(self, live_map: Dict[str, Dict[str, Any]]) -> bool:
        """Updates watchlist items with fresh live data. Returns True when watchlist.json was rewritten."""
        return self._update_list_live(WATCHLIST_FILE, "watchlist", live_map, self.save_watchlist)

    def _read_charge_session(self) -> Optional[Dict[str, Any]]:
        """Reads the charge session exactly as stored on disk."""
        with self._lock:
            if not os.path.exists(SESSION_FILE):
                return None
            try:
                with open(SESSION_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data if isinstance(data, dict) else None
            except Exception as err:
                _LOGGER.warning("Failed to load charge session: %s", err)
                return None

    def load_charge_session(self) -> Optional[Dict[str, Any]]:
        """Loads active charging session (Lade-Wächter) incl. in-memory countdown values."""
        with self._lock:
            data = self._read_charge_session()
            if data is not None and self._session_volatile and self._session_volatile[0] == charge_session_key(data):
                data.update(self._session_volatile[1])
            return data

    def save_charge_session(self, session: Optional[Dict[str, Any]], only_if_current: bool = False) -> bool:
        """Atomically saves the active charging session.

        With only_if_current=True the write is skipped when the stored session was stopped or
        replaced meanwhile (background poller must never resurrect a stopped session).
        If only volatile fields (countdown) changed, they are kept in memory and the file is
        left untouched. Returns True when the session is stored (on disk or unchanged).
        """
        with self._lock:
            if session is None:
                self.clear_charge_session()
                return False
            stored = self._read_charge_session()
            if only_if_current and charge_session_key(stored) != charge_session_key(session):
                _LOGGER.debug("Charge session changed meanwhile; skipping stale write.")
                return False
            try:
                clean_session = sanitize_charge_session(session)
                volatile = {k: clean_session[k] for k in VOLATILE_SESSION_KEYS if k in clean_session}
                if (
                    stored is not None
                    and charge_session_key(stored) == charge_session_key(clean_session)
                    and _same_content(_stable_session(stored), _stable_session(clean_session))
                ):
                    self._session_volatile = (charge_session_key(clean_session), volatile)
                    return True
                self._atomic_write_json(SESSION_FILE, clean_session)
                self._session_volatile = None
                _LOGGER.debug("Saved charge session for station %s", clean_session.get("station_name"))
                return True
            except Exception as err:
                _LOGGER.error("Failed to save charge session: %s", err)
                return False

    def start_charge_session(self, session: Dict[str, Any]) -> None:
        """Saves a newly started session. A re-sent copy of the active session (e.g. the APK
        missed the add-on's ack) keeps its alert flags, so no push notification repeats."""
        with self._lock:
            current = self.load_charge_session()
            if current and charge_session_key(current) == charge_session_key(session):
                session = {**session, **{flag: True for flag in SESSION_ALERT_FLAGS if current.get(flag)}}
            self.save_charge_session(session)

    def clear_charge_session(self) -> None:
        """Removes the active charging session file."""
        with self._lock:
            self._session_volatile = None
            try:
                if os.path.exists(SESSION_FILE):
                    os.remove(SESSION_FILE)
                    _LOGGER.info("Cleared active charge session.")
            except Exception as err:
                _LOGGER.warning("Failed to remove charge session file: %s", err)

    def _fill_missing(self, base: Dict[str, Any], defaults: Dict[str, Any]) -> None:
        for k, v in defaults.items():
            if k not in base:
                base[k] = v
            elif isinstance(v, dict) and isinstance(base[k], dict):
                self._fill_missing(base[k], v)
            elif isinstance(v, dict):
                base[k] = v

    def _deep_merge(self, base: Dict[str, Any], update: Dict[str, Any]) -> None:
        for k, v in update.items():
            if isinstance(v, dict) and k in base and isinstance(base[k], dict):
                self._deep_merge(base[k], v)
            else:
                base[k] = v


storage = StorageManager()
