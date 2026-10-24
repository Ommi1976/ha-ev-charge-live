import asyncio
import json
import logging
import os
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app import poller as poller_mod
from app.main import apply_log_level
from app.notifier import HANotifier
from app.poller import SyncWorker
from app.storage import DEFAULT_OPTIONS, StorageManager, sanitize_config

ROOT = os.path.join(os.path.dirname(__file__), "..")


def _station(free, total=2, status=None):
    return {
        "id": "s1",
        "name": "Pumpwerk",
        "address": "Schubertstr. 5",
        "free_slots": free,
        "total_slots": total,
        "status": status or ("AVAILABLE" if free == total else ("OCCUPIED" if free == 0 else "PARTIAL")),
        "connectors": [],
    }


class TestLogLevel(unittest.TestCase):
    LOGGERS = ("", "ev_charge_live", "httpx", "httpcore", "uvicorn", "uvicorn.error", "uvicorn.access")

    def setUp(self):
        self.saved = {name: logging.getLogger(name).level for name in self.LOGGERS}

    def tearDown(self):
        for name, level in self.saved.items():
            logging.getLogger(name).setLevel(level)

    def test_debug_applies_to_addon_only(self):
        self.assertEqual(apply_log_level({"logging": {"level": "debug"}}), logging.DEBUG)
        self.assertTrue(logging.getLogger("ev_charge_live.poller").isEnabledFor(logging.DEBUG))
        self.assertEqual(logging.getLogger().level, logging.INFO)
        self.assertEqual(logging.getLogger("httpx").level, logging.WARNING)
        self.assertEqual(logging.getLogger("httpcore").level, logging.WARNING)

    def test_info_silences_httpx_request_lines(self):
        apply_log_level({"logging": {"level": "info"}})
        self.assertFalse(logging.getLogger("httpx").isEnabledFor(logging.INFO))
        self.assertTrue(logging.getLogger("httpx").isEnabledFor(logging.WARNING))
        self.assertTrue(logging.getLogger("ev_charge_live.storage").isEnabledFor(logging.INFO))

    def test_warning_and_error(self):
        apply_log_level({"logging": {"level": "warning"}})
        self.assertFalse(logging.getLogger("ev_charge_live.main").isEnabledFor(logging.INFO))
        self.assertFalse(logging.getLogger("uvicorn.access").isEnabledFor(logging.INFO))
        apply_log_level({"logging": {"level": "error"}})
        self.assertFalse(logging.getLogger("httpx").isEnabledFor(logging.WARNING))

    def test_invalid_level_falls_back_to_info(self):
        self.assertEqual(apply_log_level({"logging": {"level": "verbose"}}), logging.INFO)
        self.assertEqual(apply_log_level({}), logging.INFO)

    def test_sanitize_config_drops_unknown_level(self):
        self.assertNotIn("level", sanitize_config({"logging": {"level": "TRACE"}})["logging"])
        self.assertEqual(sanitize_config({"logging": {"level": " Debug "}})["logging"]["level"], "debug")


class TestMqttRemoved(unittest.TestCase):

    def test_not_in_defaults_config_or_requirements(self):
        self.assertNotIn("mqtt_enabled", DEFAULT_OPTIONS["home_assistant_integration"])
        with open(os.path.join(ROOT, "config.yaml"), encoding="utf-8") as f:
            self.assertNotIn("mqtt", f.read())
        with open(os.path.join(ROOT, "requirements.txt"), encoding="utf-8") as f:
            self.assertNotIn("paho", f.read())

    def test_legacy_keys_dropped_from_overrides(self):
        cfg = sanitize_config({"home_assistant_integration": {
            "mqtt_enabled": True, "mqtt_topic_prefix": "x", "fire_ha_events": False
        }})
        self.assertEqual(cfg["home_assistant_integration"], {"fire_ha_events": False})


class _PollerCase(unittest.TestCase):
    """Runs debounced poll cycles for one favorite against an isolated storage."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_ev_options_")
        self.patches = [
            patch("app.storage.OPTIONS_FILE", os.path.join(self.tmp, "options.json")),
            patch("app.storage.CONFIG_OVERRIDE_FILE", os.path.join(self.tmp, "config_override.json")),
            patch("app.storage.FAVORITES_FILE", os.path.join(self.tmp, "favorites.json")),
            patch("app.storage.WATCHLIST_FILE", os.path.join(self.tmp, "watchlist.json")),
            patch("app.storage.SESSION_FILE", os.path.join(self.tmp, "charge_session.json")),
        ]
        for p in self.patches:
            p.start()
        self.storage = StorageManager()
        self.storage.save_favorites([_station(0)])

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def configure(self, watched=True, **notifications):
        with open(os.path.join(self.tmp, "config_override.json"), "w", encoding="utf-8") as f:
            json.dump({"notifications": notifications}, f)
        self.storage.save_watchlist([_station(0)] if watched else [])

    def run_cycles(self, responses):
        worker = SyncWorker()
        worker._token = ""
        freed = AsyncMock(return_value=True)
        busy = AsyncMock(return_value=True)

        async def cycles():
            for _ in responses:
                await worker.sync_favorites()

        with patch.object(poller_mod, "storage", self.storage), \
             patch.object(poller_mod.ev_client, "get_station_by_id", new=AsyncMock(side_effect=responses)), \
             patch.object(poller_mod.notifier, "notify_slot_freed", new=freed), \
             patch.object(poller_mod.notifier, "notify_all_busy", new=busy):
            asyncio.run(cycles())
        return freed, busy


class TestMinFreeSlotsToTrigger(_PollerCase):

    def test_default_one_free_slot_triggers(self):
        self.configure()
        freed, _ = self.run_cycles([_station(0), _station(1), _station(1)])
        self.assertEqual(freed.call_count, 1)

    def test_threshold_two_waits_for_second_slot(self):
        self.configure(min_free_slots_to_trigger=2)
        freed, _ = self.run_cycles([_station(0), _station(1), _station(1), _station(2), _station(2)])
        self.assertEqual(freed.call_count, 1)
        self.assertEqual(freed.call_args.args[0]["free_slots"], 2)

    def test_threshold_above_total_never_triggers(self):
        self.configure(min_free_slots_to_trigger=3)
        freed, _ = self.run_cycles([_station(0), _station(2), _station(2)])
        freed.assert_not_called()

    def test_jitter_is_still_debounced(self):
        self.configure()
        freed, _ = self.run_cycles([_station(0), _station(1), _station(0), _station(1)])
        freed.assert_not_called()


class TestNotifyOnAllBusy(_PollerCase):

    def test_push_when_watched_station_becomes_full(self):
        self.configure(notify_on_all_busy=True)
        _, busy = self.run_cycles([_station(1), _station(0), _station(0)])
        self.assertEqual(busy.call_count, 1)

    def test_option_off_sends_nothing(self):
        self.configure(notify_on_all_busy=False)
        _, busy = self.run_cycles([_station(1), _station(0), _station(0)])
        busy.assert_not_called()

    def test_favorite_without_watchlist_sends_nothing(self):
        self.configure(watched=False, notify_on_all_busy=True)
        _, busy = self.run_cycles([_station(1), _station(0), _station(0)])
        busy.assert_not_called()

    def test_out_of_order_is_not_busy(self):
        self.configure(notify_on_all_busy=True)
        broken = _station(0, status="OUTOFORDER")
        _, busy = self.run_cycles([_station(1), broken, dict(broken)])
        busy.assert_not_called()


class TestNotifierAllBusy(unittest.TestCase):

    def setUp(self):
        self.notifier = HANotifier()
        self.call_service = AsyncMock(return_value=True)
        self.notifier._call_service = self.call_service
        self.notifier._fire_event = AsyncMock(return_value=True)
        self.config = {"notifications": {
            "enabled": True, "notify_on_all_busy": True, "cooldown_minutes": 10,
            "target_devices": ["notify.mobile_app_phone", "script.evil", "light.turn_on"],
        }}

    def test_sends_to_notify_targets_only(self):
        self.assertTrue(asyncio.run(self.notifier.notify_all_busy(_station(0), self.config)))
        self.assertEqual([c.args[:2] for c in self.call_service.call_args_list], [("notify", "mobile_app_phone")])
        payload = self.call_service.call_args.args[2]
        self.assertIn("belegt", payload["title"])
        self.assertEqual(payload["data"]["tag"], "ev_charge_s1")

    def test_disabled_option_or_notifications(self):
        self.config["notifications"]["notify_on_all_busy"] = False
        self.assertFalse(asyncio.run(self.notifier.notify_all_busy(_station(0), self.config)))
        self.config["notifications"].update(notify_on_all_busy=True, enabled=False)
        self.assertFalse(asyncio.run(self.notifier.notify_all_busy(_station(0), self.config)))
        self.call_service.assert_not_called()

    def test_cooldown_does_not_block_slot_freed(self):
        async def scenario():
            first = await self.notifier.notify_all_busy(_station(0), self.config)
            second = await self.notifier.notify_all_busy(_station(0), self.config)
            freed = await self.notifier.notify_slot_freed(_station(1), self.config)
            return first, second, freed

        self.assertEqual(asyncio.run(scenario()), (True, False, True))


if __name__ == "__main__":
    unittest.main()
