import os
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app, INGRESS_ALLOWED_HOSTS
import app.main as app_main


class TestSecurity(unittest.TestCase):

    def setUp(self):
        self.client = TestClient(app)

    def test_security_headers_present(self):
        """Verifies that mandatory security headers are injected into HTTP responses."""
        resp = self.client.get("/api/config")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(resp.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
        self.assertIn("frame-ancestors 'self'", resp.headers.get("Content-Security-Policy", ""))
        self.assertIn("bluetooth=(self)", resp.headers.get("Permissions-Policy", ""))

    def test_oversized_payload_rejected(self):
        """Verifies that POST requests exceeding MAX_BODY_BYTES (128 KB) receive HTTP 413."""
        oversized_data = "x" * (130 * 1024)
        headers = {"Content-Length": str(len(oversized_data)), "Content-Type": "application/json"}
        resp = self.client.post("/api/config", content=oversized_data, headers=headers)
        self.assertEqual(resp.status_code, 413)

    def test_ingress_host_filtering_when_restricted(self):
        """Verifies that non-ingress client hosts receive 403 when RESTRICT_TO_INGRESS is active."""
        with patch.object(app_main, "RESTRICT_TO_INGRESS", True):
            # Client from external LAN IP -> Forbidden (403)
            ext_client = TestClient(app, client=("192.168.1.100", 54321))
            resp_ext = ext_client.get("/api/config")
            self.assertEqual(resp_ext.status_code, 403)

            # Client from Ingress proxy IP -> Allowed (200)
            ingress_client = TestClient(app, client=("172.30.32.2", 54321))
            resp_ing = ingress_client.get("/api/config")
            self.assertEqual(resp_ing.status_code, 200)

            # Client from local loopback -> Allowed (200)
            local_client = TestClient(app, client=("127.0.0.1", 54321))
            resp_loc = local_client.get("/api/config")
            self.assertEqual(resp_loc.status_code, 200)

    def test_safe_ha_entity_regex_filtering(self):
        """Verifies that unsafe HA entity IDs cannot cause path traversal or code injection."""
        from app.main import SAFE_HA_ENTITY_RE

        # Valid entity IDs
        self.assertTrue(SAFE_HA_ENTITY_RE.match("device_tracker.2407fpn8eg"))
        self.assertTrue(SAFE_HA_ENTITY_RE.match("person.stephan"))
        self.assertTrue(SAFE_HA_ENTITY_RE.match("sensor.ev_charge_live"))

        # Invalid/dangerous injection attempts
        self.assertIsNone(SAFE_HA_ENTITY_RE.match("../../etc/passwd"))
        self.assertIsNone(SAFE_HA_ENTITY_RE.match("person.stephan; drop table"))
        self.assertIsNone(SAFE_HA_ENTITY_RE.match("sensor.<script>"))
        self.assertIsNone(SAFE_HA_ENTITY_RE.match("device_tracker.space in name"))
        self.assertIsNone(SAFE_HA_ENTITY_RE.match(""))

    def test_safe_notify_regex_filtering(self):
        """Verifies that only valid notify.* services are accepted."""
        from app.main import SAFE_NOTIFY_RE

        self.assertTrue(SAFE_NOTIFY_RE.match("notify.mobile_app_xiaomi"))
        self.assertTrue(SAFE_NOTIFY_RE.match("notify.persistent_notification"))

        self.assertIsNone(SAFE_NOTIFY_RE.match("light.turn_on"))
        self.assertIsNone(SAFE_NOTIFY_RE.match("homeassistant.restart"))
        self.assertIsNone(SAFE_NOTIFY_RE.match("notify."))
        self.assertIsNone(SAFE_NOTIFY_RE.match("notify.bad;service"))


if __name__ == "__main__":
    unittest.main()
