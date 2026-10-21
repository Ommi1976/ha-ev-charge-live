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

    def test_pairing_info_endpoint(self):
        resp = self.client.get("/api/pairing-info")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "success")
        self.assertIn("ha_url", data)
        self.assertIn("pairing_data", data)
        self.assertEqual(data["pairing_data"].get("type"), "ha_pairing")
        self.assertIn("pairing_string", data)

    def test_pairing_qr_svg_generation(self):
        # Default pairing QR
        resp = self.client.get("/api/pairing-qr")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("image/svg+xml", resp.headers.get("content-type", ""))
        self.assertTrue(resp.content.startswith(b"<svg"))
        self.assertTrue(resp.content.rstrip().endswith(b"</svg>"))

        # Custom parameters pairing QR
        custom_resp = self.client.get("/api/pairing-qr?url=http://192.168.178.50:8123&token=test_bearer_token")
        self.assertEqual(custom_resp.status_code, 200)
        self.assertIn("image/svg+xml", custom_resp.headers.get("content-type", ""))
        self.assertGreater(len(custom_resp.content), 500)

    def test_pairing_qr_validation_invalid_scheme(self):
        resp = self.client.get("/api/pairing-qr?url=javascript:alert(1)")
        self.assertEqual(resp.status_code, 400)

    def test_pairing_qr_validation_excessive_url_length(self):
        long_url = "http://example.com/" + "a" * 600
        resp = self.client.get(f"/api/pairing-qr?url={long_url}")
        self.assertIn(resp.status_code, (400, 422))

    def test_pairing_qr_validation_excessive_token_length(self):
        long_token = "token_" + "x" * 2500
        resp = self.client.get(f"/api/pairing-qr?token={long_token}")
        self.assertIn(resp.status_code, (400, 422))

    def test_pairing_info_host_sanitization(self):
        # Malicious Host header with CRLF injection
        headers = {"X-Forwarded-Host": "malicious.com\r\nInjected: true"}
        resp = self.client.get("/api/pairing-info", headers=headers)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertNotIn("Injected", data.get("ha_url", ""))
        self.assertNotIn("\r", data.get("ha_url", ""))
        self.assertNotIn("\n", data.get("ha_url", ""))


if __name__ == "__main__":
    unittest.main()
