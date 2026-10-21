import unittest
from fastapi.testclient import TestClient
from app.main import app


class TestApi(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)

    def test_get_config(self):
        resp = self.client.get("/api/config")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIsInstance(data, dict)
        self.assertIn("polling", data)

    def test_charge_session_cycle(self):
        # 1. Stop any existing session
        resp_stop = self.client.post("/api/charge-session/stop")
        self.assertEqual(resp_stop.status_code, 200)

        # 2. Start a new session
        session_payload = {
            "station_id": "test_pumpwerk_1",
            "station_name": "Hockenheim Pumpwerk",
            "target_soc": 80,
            "free_parking_minutes": 240,
            "connector_label": "Typ 2"
        }
        resp_start = self.client.post("/api/charge-session/start", json=session_payload)
        self.assertEqual(resp_start.status_code, 200)
        start_data = resp_start.json()
        self.assertEqual(start_data["status"], "success")

        # 3. Retrieve active session
        resp_get = self.client.get("/api/charge-session")
        self.assertEqual(resp_get.status_code, 200)
        get_data = resp_get.json()
        self.assertIsNotNone(get_data.get("session"))
        self.assertEqual(get_data["session"]["station_name"], "Hockenheim Pumpwerk")

        # 4. Clean up
        self.client.post("/api/charge-session/stop")

    def test_calculate_route_direct_fallback(self):
        # Test routing endpoint with start and destination
        resp = self.client.get("/api/route?start_lat=49.317&start_lon=8.545&end_lat=49.48&end_lon=8.47")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("distance_km", data)
        self.assertIn("coordinates", data)
        self.assertGreater(data["distance_km"], 10.0)


if __name__ == "__main__":
    unittest.main()
