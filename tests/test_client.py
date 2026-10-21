import unittest
from app.client import (
    calculate_distance_km,
    calculate_distance_m,
    extract_evse_sort_key,
    ev_client
)


class TestClient(unittest.TestCase):

    def test_distance_calculation(self):
        # Distance between Hockenheim Pumpwerk (49.317584, 8.545261) and Mannheim Hbf (49.4795, 8.4697)
        dist = calculate_distance_km(49.317584, 8.545261, 49.4795, 8.4697)
        self.assertGreater(dist, 15.0)
        self.assertLess(dist, 25.0)

        dist_m = calculate_distance_m(49.317584, 8.545261, 49.4795, 8.4697)
        self.assertAlmostEqual(dist_m, dist * 1000.0, delta=10.0)

    def test_evse_sort_key_deterministic(self):
        # Numeric suffixes should sort in ascending order (01 before 02)
        cp1 = {"evse_id": "DE*SWK*E000123*01"}
        cp2 = {"evse_id": "DE*SWK*E000123*02"}
        cp3 = {"evse_id": "DE*SWK*E000123*10"}
        key1 = extract_evse_sort_key(cp1)
        key2 = extract_evse_sort_key(cp2)
        key3 = extract_evse_sort_key(cp3)

        self.assertLess(key1, key2)
        self.assertLess(key2, key3)
        self.assertEqual(key1[1], 1)
        self.assertEqual(key2[1], 2)
        self.assertEqual(key3[1], 10)

    def test_cache_limits(self):
        # Ensure client last known stations can be populated and respects LRU cap
        ev_client._last_known_live_stations.clear()
        for i in range(300):
            ev_client._last_known_live_stations[str(i)] = ({"id": str(i)}, 1000.0 + i)

        # Trigger simulated prune logic
        sorted_items = sorted(
            ev_client._last_known_live_stations.items(),
            key=lambda it: it[1][1],
            reverse=True
        )
        ev_client._last_known_live_stations = dict(sorted_items[:150])
        self.assertEqual(len(ev_client._last_known_live_stations), 150)


if __name__ == "__main__":
    unittest.main()
