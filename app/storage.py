import json
import logging
import os
from typing import Any, Dict, List

_LOGGER = logging.getLogger("ev_charge_live.storage")

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
        "service": "notify.notify",
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
        "mqtt_enabled": False,
        "mqtt_topic_prefix": "homeassistant/sensor/ev_charge"
    },
    "logging": {
        "level": "info"
    }
}

DATA_DIR = os.getenv("DATA_DIR", "/data")
OPTIONS_FILE = os.path.join(DATA_DIR, "options.json")
CONFIG_OVERRIDE_FILE = os.path.join(DATA_DIR, "config_override.json")
FAVORITES_FILE = os.path.join(DATA_DIR, "favorites.json")


class StorageManager:
    def __init__(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)

    def load_config(self) -> Dict[str, Any]:
        """Loads configuration merging defaults, options.json from HA and user overrides."""
        config = json.loads(json.dumps(DEFAULT_OPTIONS))

        # Merge HA options.json if present
        if os.path.exists(OPTIONS_FILE):
            try:
                with open(OPTIONS_FILE, "r", encoding="utf-8") as f:
                    ha_opts = json.load(f)
                    self._deep_merge(config, ha_opts)
            except Exception as err:
                _LOGGER.warning("Could not read %s: %s", OPTIONS_FILE, err)

        # Merge UI config override if present
        if os.path.exists(CONFIG_OVERRIDE_FILE):
            try:
                with open(CONFIG_OVERRIDE_FILE, "r", encoding="utf-8") as f:
                    ui_opts = json.load(f)
                    self._deep_merge(config, ui_opts)
            except Exception as err:
                _LOGGER.warning("Could not read %s: %s", CONFIG_OVERRIDE_FILE, err)

        return config

    def _atomic_write_json(self, path: str, data: Any) -> None:
        """Atomically writes JSON to disk via temporary file and os.replace."""
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)

    def save_config_override(self, new_config: Dict[str, Any]) -> None:
        """Saves configuration overrides from the Web UI atomically."""
        try:
            self._atomic_write_json(CONFIG_OVERRIDE_FILE, new_config)
            _LOGGER.info("Config override saved successfully.")
        except Exception as err:
            _LOGGER.error("Failed to save config override: %s", err)
            raise

    def load_favorites(self) -> List[Dict[str, Any]]:
        """Loads list of monitored favorite charging stations."""
        if not os.path.exists(FAVORITES_FILE):
            return []
        try:
            with open(FAVORITES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
        except Exception as err:
            _LOGGER.warning("Failed to load favorites: %s", err)
            return []

    def save_favorites(self, favorites: List[Dict[str, Any]]) -> None:
        """Saves list of monitored favorite charging stations atomically."""
        try:
            self._atomic_write_json(FAVORITES_FILE, favorites)
            _LOGGER.info("Saved %d favorites to %s", len(favorites), FAVORITES_FILE)
        except Exception as err:
            _LOGGER.error("Failed to save favorites: %s", err)
            raise

    def update_favorites_live(self, live_map: Dict[str, Dict[str, Any]]) -> None:
        """Updates existing favorites with fresh live data without overwriting concurrent toggle actions."""
        if not live_map:
            return
        current_favs = self.load_favorites()
        if not current_favs:
            return
        merged = [live_map.get(str(f.get("id")), f) for f in current_favs]
        self.save_favorites(merged)

    def is_favorite(self, station_id: str) -> bool:
        favs = self.load_favorites()
        return any(str(f.get("id")) == str(station_id) for f in favs)

    def toggle_favorite(self, station_data: Dict[str, Any]) -> bool:
        """Toggles favorite status. Returns True if added, False if removed."""
        favs = self.load_favorites()
        station_id = str(station_data.get("id"))
        existing = next((f for f in favs if str(f.get("id")) == station_id), None)
        if existing:
            favs = [f for f in favs if str(f.get("id")) != station_id]
            self.save_favorites(favs)
            return False
        else:
            favs.append(station_data)
            self.save_favorites(favs)
            return True

    def _deep_merge(self, base: Dict[str, Any], update: Dict[str, Any]) -> None:
        for k, v in update.items():
            if isinstance(v, dict) and k in base and isinstance(base[k], dict):
                self._deep_merge(base[k], v)
            else:
                base[k] = v


storage = StorageManager()
