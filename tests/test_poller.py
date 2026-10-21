import unittest
import datetime
from app.poller import (
    calculate_blocking_deadline,
    slugify,
    BERLIN_TZ
)


class TestPoller(unittest.TestCase):

    def test_slugify(self):
        self.assertEqual(slugify("Hockenheim Pumpwerk #1"), "hockenheim_pumpwerk_1")
        self.assertEqual(slugify("  EnBW HyperNetz DC!  "), "enbw_hypernetz_dc")

    def test_blocking_deadline_daytime(self):
        # Starts 10:00 with 120 minutes free parking -> 12:00
        start = datetime.datetime(2026, 10, 21, 10, 0, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 120, night_start_hour=21, night_end_hour=9)
        self.assertEqual(deadline.hour, 12)
        self.assertEqual(deadline.minute, 0)
        self.assertEqual(deadline.day, 21)

    def test_blocking_deadline_night_exemption(self):
        # Starts 20:00 with 240 minutes (4h) free parking.
        # 20:00 to 21:00 = 60 mins used (180 mins remaining).
        # Night pause: 21:00 to 09:00 next day.
        # 09:00 + remaining 180 mins (3h) = 12:00 next day!
        start = datetime.datetime(2026, 10, 21, 20, 0, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 240, night_start_hour=21, night_end_hour=9)
        self.assertEqual(deadline.day, 22)
        self.assertEqual(deadline.hour, 12)
        self.assertEqual(deadline.minute, 0)

    def test_blocking_deadline_during_night(self):
        # Starts 23:00 (during night pause) with 120 minutes free parking.
        # Night pause lasts until 09:00 next day.
        # Deadline should be 09:00 + 120 mins = 11:00 next day!
        start = datetime.datetime(2026, 10, 21, 23, 0, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 120, night_start_hour=21, night_end_hour=9)
        self.assertEqual(deadline.day, 22)
        self.assertEqual(deadline.hour, 11)
        self.assertEqual(deadline.minute, 0)

    def test_blocking_deadline_zero_minutes(self):
        start = datetime.datetime(2026, 10, 21, 14, 0, tzinfo=BERLIN_TZ)
        deadline = calculate_blocking_deadline(start, 0)
        self.assertEqual(deadline, start)


if __name__ == "__main__":
    unittest.main()
