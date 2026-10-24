import asyncio
import datetime
import os
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app import poller as poller_mod
from app.poller import BERLIN_TZ, SyncWorker
from app.storage import StorageManager


def _station(free=1, total=2, duration_str="vor 3 Min.", duration_minutes=3, last_updated="2026-10-23T10:00:00Z"):
    return {
        "id": "s1",
        "name": "Pumpwerk",
        "operator": "Stadtwerke Hockenheim",
        "address": "Schubertstr. 5",
        "free_slots": free,
        "total_slots": total,
        "occupied_slots": total - free,
        "status": "AVAILABLE" if free == total else ("OCCUPIED" if free == 0 else "PARTIAL"),
        "connectors": [
            {"point_label": "Ladepunkt 1", "status": "OCCUPIED", "updated_at": 1_790_000_000_000,
             "since_time": "09:57", "duration_str": duration_str, "duration_minutes": duration_minutes},
            {"point_label": "Ladepunkt 2", "status": "AVAILABLE"},
        ],
        "live_source": "EnBW Echtzeit",
        "last_updated": last_updated,
    }


class _TempStorageCase(unittest.TestCase):
    """Isolated StorageManager in a temp dir that records every disk write."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_ev_writes_")
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
        self.write_mock = MagicMock(wraps=self.storage._atomic_write_json)
        self.storage._atomic_write_json = self.write_mock

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def writes(self, filename):
        return sum(1 for c in self.write_mock.call_args_list if os.path.basename(c.args[0]) == filename)


class TestStationListWrites(_TempStorageCase):

    def test_identical_live_data_is_not_rewritten(self):
        self.storage.save_favorites([_station()])
        self.assertFalse(self.storage.update_favorites_live({"s1": _station()}))
        self.assertEqual(self.writes("favorites.json"), 1)

    def test_volatile_fields_stay_in_memory(self):
        self.storage.save_favorites([_station()])
        fresh = _station(duration_str="vor 17 Min.", duration_minutes=17, last_updated="2026-10-23T10:14:00Z")
        self.assertFalse(self.storage.update_favorites_live({"s1": fresh}))
        self.assertEqual(self.writes("favorites.json"), 1)
        # API still sees the fresh relative duration ...
        loaded = self.storage.load_favorites()[0]
        self.assertEqual(loaded["connectors"][0]["duration_str"], "vor 17 Min.")
        self.assertEqual(loaded["last_updated"], "2026-10-23T10:14:00Z")
        # ... while the file keeps the last persisted content
        on_disk = self.storage._read_station_list(os.path.join(self.tmp, "favorites.json"), "favorites")[0]
        self.assertEqual(on_disk["connectors"][0]["duration_str"], "vor 3 Min.")

    def test_real_change_is_written(self):
        self.storage.save_favorites([_station(free=1)])
        self.assertTrue(self.storage.update_favorites_live({"s1": _station(free=0)}))
        self.assertEqual(self.writes("favorites.json"), 2)
        self.assertEqual(self.storage.load_favorites()[0]["free_slots"], 0)

    def test_watchlist_only_written_on_change(self):
        self.storage.save_watchlist([_station()])
        self.assertFalse(self.storage.update_watchlist_live({"s1": _station(duration_str="vor 9 Min.")}))
        self.assertTrue(self.storage.update_watchlist_live({"s1": _station(free=2)}))
        self.assertEqual(self.writes("watchlist.json"), 2)

    def test_removed_favorite_not_resurrected_by_live_cache(self):
        self.storage.toggle_favorite(_station())
        self.storage.update_favorites_live({"s1": _station(duration_str="vor 5 Min.")})
        self.assertFalse(self.storage.toggle_favorite(_station()))
        self.assertEqual(self.storage.load_favorites(), [])


class TestPollerFavoritesWrites(_TempStorageCase):

    def test_stable_station_written_once(self):
        self.storage.toggle_favorite(_station())
        writes_after_toggle = self.writes("favorites.json")
        worker = SyncWorker()
        worker._token = ""
        responses = [_station(duration_str=f"vor {m} Min.", duration_minutes=m) for m in (3, 4, 5, 6)]

        async def cycles():
            for _ in responses:
                await worker.sync_favorites()

        with patch.object(poller_mod, "storage", self.storage), \
             patch.object(poller_mod.ev_client, "get_station_by_id", new=AsyncMock(side_effect=responses)):
            asyncio.run(cycles())

        # Four polls with only the relative duration ticking: no rewrite at all ("Saved 1 favorites" every minute)
        self.assertEqual(self.writes("favorites.json"), writes_after_toggle)
        self.assertEqual(self.storage.load_favorites()[0]["connectors"][0]["duration_str"], "vor 6 Min.")


class TestChargeSessionWrites(_TempStorageCase):

    def _session(self, **overrides):
        now_ms = int(datetime.datetime.now(tz=BERLIN_TZ).timestamp() * 1000)
        session = {
            "station_id": "s1",
            "station_name": "Pumpwerk",
            "start_time_ms": now_ms - 60 * 60_000,
            "free_parking_minutes": 240,
            "has_night_rule": False,
        }
        session.update(overrides)
        return session

    def test_countdown_only_change_not_written(self):
        session = self._session(remaining_minutes=120, state="Frei laden")
        self.assertTrue(self.storage.save_charge_session(session, only_if_current=False))
        self.assertTrue(self.storage.save_charge_session(dict(session, remaining_minutes=119), only_if_current=True))
        self.assertEqual(self.writes("charge_session.json"), 1)
        self.assertEqual(self.storage.load_charge_session()["remaining_minutes"], 119)

    def test_flag_change_is_written(self):
        session = self._session(remaining_minutes=21)
        self.storage.save_charge_session(session)
        self.assertTrue(self.storage.save_charge_session(dict(session, remaining_minutes=20, notified_20=True), only_if_current=True))
        self.assertEqual(self.writes("charge_session.json"), 2)
        stored = self.storage.load_charge_session()
        self.assertTrue(stored["notified_20"])
        self.assertEqual(stored["remaining_minutes"], 20)

    def test_in_memory_countdown_does_not_leak_into_new_session(self):
        old = self._session(remaining_minutes=50)
        self.storage.save_charge_session(old)
        self.storage.save_charge_session(dict(old, remaining_minutes=7), only_if_current=True)
        new = self._session(station_id="s2", remaining_minutes=200)
        self.storage.save_charge_session(new)
        self.assertEqual(self.storage.load_charge_session()["remaining_minutes"], 200)
        self.storage.clear_charge_session()
        self.assertIsNone(self.storage.load_charge_session())

    def test_stopped_session_still_not_resurrected(self):
        session = self._session(remaining_minutes=50)
        self.storage.save_charge_session(session)
        self.storage.clear_charge_session()
        self.assertFalse(self.storage.save_charge_session(dict(session, remaining_minutes=49), only_if_current=True))
        self.assertIsNone(self.storage.load_charge_session())

    def test_poller_writes_session_once_while_stable(self):
        self.storage.save_charge_session(self._session())
        worker = SyncWorker()
        worker._token = ""

        async def cycles():
            for _ in range(3):
                await worker.check_charge_session()

        with patch.object(poller_mod, "storage", self.storage), \
             patch.object(poller_mod.notifier, "notify_charge_guardian", new=AsyncMock(return_value=True)) as notify:
            asyncio.run(cycles())

        notify.assert_not_called()
        # Initial save + first cycle adds deadline/state; later cycles only touch the countdown
        self.assertEqual(self.writes("charge_session.json"), 2)
        self.assertEqual(self.storage.load_charge_session()["state"], "Frei laden")


if __name__ == "__main__":
    unittest.main()
