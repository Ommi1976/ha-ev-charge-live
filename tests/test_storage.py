import unittest
import tempfile
import shutil
import os
from unittest.mock import patch
from app.storage import (
    sanitize_station,
    sanitize_config,
    sanitize_charge_session,
    _clamp_int,
    _safe_float,
    StorageManager
)


class TestStorage(unittest.TestCase):

    def test_clamp_int(self):
        self.assertEqual(_clamp_int(50, 10, 100, 80), 50)
        self.assertEqual(_clamp_int(5, 10, 100, 80), 10)
        self.assertEqual(_clamp_int(150, 10, 100, 80), 100)
        self.assertEqual(_clamp_int("invalid", 10, 100, 80), 80)
        self.assertEqual(_clamp_int(None, 10, 100, 80), 80)

    def test_safe_float(self):
        self.assertEqual(_safe_float(49.3, -90.0, 90.0), 49.3)
        self.assertIsNone(_safe_float(-95.0, -90.0, 90.0))
        self.assertIsNone(_safe_float("bad", -90.0, 90.0))
        self.assertIsNone(_safe_float(float("nan"), -90.0, 90.0))

    def test_sanitize_station_valid(self):
        raw = {
            "id": "stat_123",
            "name": "Hockenheim Pumpwerk",
            "operator": "Stadtwerke Hockenheim",
            "free_slots": 2,
            "total_slots": 2,
            "unknown_extra": "should_be_stripped"
        }
        clean = sanitize_station(raw)
        self.assertEqual(clean["id"], "stat_123")
        self.assertEqual(clean["name"], "Hockenheim Pumpwerk")
        self.assertNotIn("unknown_extra", clean)

    def test_sanitize_station_invalid(self):
        with self.assertRaises(ValueError):
            sanitize_station({})
        with self.assertRaises(ValueError):
            sanitize_station({"id": ""})

    def test_sanitize_charge_session(self):
        raw = {
            "target_soc": 150,  # too high
            "free_parking_minutes": -20,  # too low
            "needed_minutes": 2000,  # too high
            "fee_per_minute": 0.15
        }
        clean = sanitize_charge_session(raw)
        self.assertEqual(clean["target_soc"], 100)
        self.assertEqual(clean["free_parking_minutes"], 0)
        self.assertEqual(clean["needed_minutes"], 1440)
        self.assertEqual(clean["fee_per_minute"], 0.15)

    def test_sanitize_config(self):
        raw = {
            "ha_token": "secret_token_must_be_popped",
            "polling": {
                "interval_seconds": 3  # min 15
            },
            "location_defaults": {
                "search_radius_meters": 100000  # max 50000
            }
        }
        clean = sanitize_config(raw)
        self.assertNotIn("ha_token", clean)
        self.assertEqual(clean["polling"]["interval_seconds"], 15)
        self.assertEqual(clean["location_defaults"]["search_radius_meters"], 50000)

    def test_storage_manager_isolated(self):
        test_dir = tempfile.mkdtemp(prefix="test_ev_storage_")
        try:
            with patch("app.storage.DATA_DIR", test_dir), \
                 patch("app.storage.OPTIONS_FILE", os.path.join(test_dir, "options.json")), \
                 patch("app.storage.FAVORITES_FILE", os.path.join(test_dir, "favorites.json")), \
                 patch("app.storage.WATCHLIST_FILE", os.path.join(test_dir, "watchlist.json")), \
                 patch("app.storage.SESSION_FILE", os.path.join(test_dir, "charge_session.json")):
                sm = StorageManager()

                # 1. Config
                cfg = sm.load_config()
                self.assertIsInstance(cfg, dict)

                # 2. Favorites & Watchlist
                st = {"id": "stat_1", "name": "Pumpwerk"}
                added = sm.toggle_favorite(st)
                self.assertTrue(added)
                self.assertTrue(sm.is_favorite("stat_1"))
                self.assertFalse(sm.is_favorite("stat_2"))

                wl_added = sm.toggle_watchlist(st)
                self.assertTrue(wl_added)
                self.assertTrue(sm.is_on_watchlist("stat_1"))

                # 3. Charge Session
                session = {"station_name": "Pumpwerk", "target_soc": 80}
                sm.save_charge_session(session)
                loaded = sm.load_charge_session()
                self.assertIsNotNone(loaded)
                self.assertEqual(loaded["station_name"], "Pumpwerk")

                sm.clear_charge_session()
                self.assertIsNone(sm.load_charge_session())
        finally:
            shutil.rmtree(test_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
