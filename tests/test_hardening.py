import asyncio
import datetime
import os
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import poller as poller_mod
from app.main import app
from app.poller import BERLIN_TZ, SyncWorker, calculate_blocking_deadline, is_night_hour
from app.storage import StorageManager, sanitize_charge_session


class TestBlockingDeadlineEdgeCases(unittest.TestCase):
    """Former implementation looped forever for these night windows and froze the add-on."""

    def test_night_window_within_day(self):
        start = datetime.datetime(2026, 10, 21, 10, 0, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 240, night_start_hour=1, night_end_hour=5)
        self.assertEqual((deadline.day, deadline.hour, deadline.minute), (21, 14, 0))

    def test_night_window_within_day_crossing_night(self):
        start = datetime.datetime(2026, 10, 21, 23, 0, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 240, night_start_hour=1, night_end_hour=5)
        # 23:00-01:00 = 120 min, night pause 01-05, remaining 120 min -> 07:00
        self.assertEqual((deadline.day, deadline.hour, deadline.minute), (22, 7, 0))

    def test_equal_start_end_means_no_night_rule(self):
        start = datetime.datetime(2026, 10, 21, 10, 0, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 90, night_start_hour=0, night_end_hour=0)
        self.assertEqual((deadline.hour, deadline.minute), (11, 30))

    def test_start_with_seconds_inside_day(self):
        start = datetime.datetime(2026, 10, 21, 20, 59, 30, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 1, night_start_hour=21, night_end_hour=9)
        # 30 s before night, 30 s remain after 09:00 next day
        self.assertEqual((deadline.day, deadline.hour, deadline.minute, deadline.second), (22, 9, 0, 30))

    def test_is_night_hour(self):
        self.assertTrue(is_night_hour(22, 21, 9))
        self.assertTrue(is_night_hour(3, 21, 9))
        self.assertFalse(is_night_hour(12, 21, 9))
        self.assertTrue(is_night_hour(2, 1, 5))
        self.assertFalse(is_night_hour(23, 1, 5))
        self.assertFalse(is_night_hour(0, 0, 0))


class TestChargeSessionSanitizing(unittest.TestCase):

    def test_unknown_keys_and_bad_types_dropped(self):
        clean = sanitize_charge_session({
            "station_id": "x" * 500,
            "station_name": "Pumpwerk",
            "evil": {"nested": "x" * 10_000},
            "night_window_start": "abc",
            "night_window_end": 30,
            "start_time_ms": "not-a-number",
            "blocking_fee_per_min": "0,10",
            "latitude": 999,
            "has_night_rule": 1,
        })
        self.assertNotIn("evil", clean)
        self.assertEqual(len(clean["station_id"]), 128)
        self.assertNotIn("night_window_start", clean)
        self.assertNotIn("night_window_end", clean)
        self.assertNotIn("start_time_ms", clean)
        self.assertNotIn("latitude", clean)
        self.assertEqual(clean["blocking_fee_per_min"], 0.10)
        self.assertIs(clean["has_night_rule"], True)


class TestChargeSessionLifecycle(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_ev_session_")
        self.patches = [
            patch("app.storage.SESSION_FILE", os.path.join(self.tmp, "charge_session.json")),
            patch("app.storage.CONFIG_OVERRIDE_FILE", os.path.join(self.tmp, "config_override.json")),
            patch("app.storage.OPTIONS_FILE", os.path.join(self.tmp, "options.json")),
        ]
        for p in self.patches:
            p.start()
        self.storage = StorageManager()
        self.storage_patch = patch.object(poller_mod, "storage", self.storage)
        self.storage_patch.start()

    def tearDown(self):
        self.storage_patch.stop()
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _session(self, **overrides):
        now_ms = int(datetime.datetime.now(tz=BERLIN_TZ).timestamp() * 1000)
        session = {
            "station_id": "s1",
            "station_name": "Pumpwerk",
            "start_time_ms": now_ms - 239 * 60_000,  # 1 min before the 240 min free time ends
            "free_parking_minutes": 240,
            "has_night_rule": False,
        }
        session.update(overrides)
        return session

    def test_stopped_session_is_not_resurrected_by_poller(self):
        self.storage.save_charge_session(self._session())
        worker = SyncWorker()

        async def notify_and_user_stops(*_args, **_kwargs):
            # User presses "stop" while the push notification is being delivered
            self.storage.clear_charge_session()
            return True

        with patch.object(poller_mod.notifier, "notify_charge_guardian", side_effect=notify_and_user_stops):
            asyncio.run(worker.check_charge_session())

        self.assertIsNone(self.storage.load_charge_session())

    def test_alert_sent_once(self):
        self.storage.save_charge_session(self._session())
        worker = SyncWorker()
        with patch.object(poller_mod.notifier, "notify_charge_guardian", new=AsyncMock(return_value=True)) as mock_notify:
            asyncio.run(worker.check_charge_session())
            asyncio.run(worker.check_charge_session())
        alert_types = [call.args[1] for call in mock_notify.call_args_list]
        self.assertEqual(alert_types, ["warning_5"])
        stored = self.storage.load_charge_session()
        self.assertTrue(stored["notified_5"])
        self.assertEqual(stored["remaining_minutes"], 1)

    def test_replaced_session_not_overwritten(self):
        old = self._session()
        self.storage.save_charge_session(old)
        new = self._session(station_id="s2", start_time_ms=old["start_time_ms"] + 1000)
        self.storage.save_charge_session(new)
        self.assertFalse(self.storage.save_charge_session(old, only_if_current=True))
        self.assertEqual(self.storage.load_charge_session()["station_id"], "s2")


class TestApiHardening(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)

    def test_pairing_qr_rejects_token_in_url(self):
        resp = self.client.get("/api/pairing-qr?token=secret")
        self.assertEqual(resp.status_code, 400)

    def test_pairing_qr_post_with_token(self):
        resp = self.client.post("/api/pairing-qr", json={"url": "http://192.168.178.50:8123", "token": "abc"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("image/svg+xml", resp.headers["content-type"])
        self.assertEqual(resp.headers.get("cache-control"), "no-store")

    def test_pairing_qr_post_validation(self):
        self.assertEqual(self.client.post("/api/pairing-qr", json={"url": "javascript:alert(1)"}).status_code, 400)
        self.assertEqual(self.client.post("/api/pairing-qr", json={"token": "t" * 3000}).status_code, 400)
        self.assertEqual(self.client.post("/api/pairing-qr", json={"url": ["x"]}).status_code, 400)

    def test_charge_session_start_requires_station_and_sets_start(self):
        with patch("app.main.storage.save_charge_session") as save, \
             patch("app.main.poller.check_charge_session", new=AsyncMock()):
            self.assertEqual(self.client.post("/api/charge-session/start", json={"target_soc": 80}).status_code, 400)
            resp = self.client.post("/api/charge-session/start", json={
                "station_id": "s1", "start_time_ms": "garbage", "evil": "x"
            })
        self.assertEqual(resp.status_code, 200)
        saved = save.call_args.args[0]
        self.assertNotIn("evil", saved)
        self.assertIsInstance(saved["start_time_ms"], int)


if __name__ == "__main__":
    unittest.main()
