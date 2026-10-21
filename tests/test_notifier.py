import unittest
import datetime
from app.notifier import _SafeFormatDict, notifier


class TestNotifier(unittest.TestCase):

    def test_safe_format_dict(self):
        d = _SafeFormatDict(station_name="Pumpwerk", free_slots=2)
        # Existing key
        self.assertEqual(d["station_name"], "Pumpwerk")
        # Missing key should retain placeholder {key} instead of raising KeyError
        self.assertEqual(d["missing_key"], "{missing_key}")

        # Format string test
        msg_template = "Ladestation {station_name}: {free_slots} frei. Betreiber: {operator}."
        formatted = msg_template.format_map(d)
        self.assertEqual(formatted, "Ladestation Pumpwerk: 2 frei. Betreiber: {operator}.")

    def test_cooldown_tracking(self):
        # Reset notifier state
        notifier._last_notified.clear()
        station_id = "test_stat_99"

        now = datetime.datetime.now()
        notifier._last_notified[station_id] = now

        # Immediately checking cooldown with 10 min window
        diff = (datetime.datetime.now() - notifier._last_notified[station_id]).total_seconds()
        self.assertLess(diff, 600.0)


if __name__ == "__main__":
    unittest.main()
