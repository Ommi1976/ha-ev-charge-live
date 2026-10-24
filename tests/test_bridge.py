"""APK <-> add-on bridge: HA REST/event contract, command handling and the WebSocket listener."""
import asyncio
import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import ha_events
from app import poller as poller_mod
from app.bridge import (
    BRIDGE_ENTITY_ID,
    BRIDGE_MAX_ATTR_BYTES,
    COMMAND_EVENT,
    COMMAND_SCRIPT_ID,
    build_bridge_attributes,
    command_script_config,
    parse_command,
)
from app.ha_events import HaEventListener, ensure_command_script, handle_command
from app.main import app
from app.poller import SyncWorker
from app.storage import StorageManager

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "bridge_contract.json")
with open(FIXTURE_PATH, "r", encoding="utf-8") as _f:
    CONTRACT = json.load(_f)


def _json_bytes(data):
    return len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class TempStorageMixin:
    """Points storage files to a temp dir and swaps in a poller whose HA calls are mocked."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_ev_bridge_")
        self.patches = [
            patch(f"app.storage.{name}", os.path.join(self.tmp, filename))
            for name, filename in (
                ("FAVORITES_FILE", "favorites.json"),
                ("WATCHLIST_FILE", "watchlist.json"),
                ("SESSION_FILE", "charge_session.json"),
                ("CONFIG_OVERRIDE_FILE", "config_override.json"),
                ("OPTIONS_FILE", "options.json"),
            )
        ]
        for p in self.patches:
            p.start()
        self.storage = StorageManager()
        self.worker = SyncWorker()
        self.worker.sync_favorites = AsyncMock()
        self.worker.check_charge_session = AsyncMock()
        self.worker.publish_bridge_state = AsyncMock()
        self.module_patches = [
            patch.object(ha_events, "storage", self.storage),
            patch.object(ha_events, "poller", self.worker),
            patch.object(poller_mod, "storage", self.storage),
        ]
        for p in self.module_patches:
            p.start()

    def tearDown(self):
        for p in self.module_patches + self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestBridgeAttributes(unittest.TestCase):

    def test_golden_contract(self):
        # Same JSON is parsed by the APK in tests/test_frontend.js
        expected = CONTRACT["bridge_state"]["attributes"]
        self.assertEqual(build_bridge_attributes(**CONTRACT["bridge_inputs"]), expected)

    def test_no_per_poll_churn(self):
        attrs = build_bridge_attributes(**CONTRACT["bridge_inputs"])
        dumped = json.dumps(attrs)
        # Values that change every minute would write a new recorder row every poll
        for volatile in ("duration_str", "duration_minutes", "remaining_minutes", "last_synced", "notified_"):
            self.assertNotIn(volatile, dumped)
        self.assertEqual(attrs, build_bridge_attributes(**CONTRACT["bridge_inputs"]))

    def test_stays_below_recorder_limit_and_keeps_watchlist(self):
        big_conn = [{"point_label": f"Ladepunkt {i}", "standard": "CCS", "power_kw": 150, "status": "AVAILABLE",
                     "since_time": "12:00", "updated_at": 1792857600000} for i in range(20)]
        favorites = [{"id": f"fav{i}", "name": "F" * 150, "address": "A" * 150, "connectors": big_conn} for i in range(100)]
        watchlist = [{"id": "watched", "name": "Beobachtet", "connectors": big_conn}]
        attrs = build_bridge_attributes(favorites, watchlist, None, [])
        self.assertLessEqual(_json_bytes(attrs), BRIDGE_MAX_ATTR_BYTES)
        self.assertTrue(attrs["truncated"])
        self.assertEqual(attrs["stations"][0]["id"], "watched")
        self.assertEqual(len(attrs["favorite_ids"]), 100)

    def test_drops_connectors_before_stations(self):
        conn = [{"point_label": "LP", "standard": "CCS", "power_kw": 150, "status": "AVAILABLE", "since_time": "x" * 200}] * 20
        favorites = [{"id": f"s{i}", "name": "N", "connectors": conn} for i in range(10)]
        attrs = build_bridge_attributes(favorites, [], None, [])
        self.assertFalse(attrs["truncated"])
        self.assertEqual(len(attrs["stations"]), 10)
        self.assertNotIn("connectors", attrs["stations"][0])


class TestParseCommand(unittest.TestCase):

    def test_apk_command_from_contract(self):
        cmd = parse_command(CONTRACT["apk_command"])
        self.assertEqual(cmd["action"], "watchlist_add")
        self.assertEqual(cmd["request_id"], "apk_test_1")
        self.assertEqual(cmd["station"]["id"], "DE*SWH*E1001")

    def test_remove_accepts_plain_station_id(self):
        cmd = parse_command({"action": "watchlist_remove", "station_id": "abc"})
        self.assertEqual(cmd["station"], {"id": "abc"})

    def test_rejects_invalid_payloads(self):
        for bad in (
            None,
            "watchlist_add",
            {"action": "drop_tables"},
            {"action": "watchlist_add"},
            {"action": "watchlist_add", "station": {"name": "no id"}},
            {"action": "session_start", "session": "x"},
            {"action": "watchlist_add", "station": {"id": "a", "name": "x" * 70000}},
        ):
            with self.assertRaises(ValueError, msg=repr(bad)[:60]):
                parse_command(bad)

    def test_malformed_request_id_is_dropped(self):
        cmd = parse_command({"action": "sync", "request_id": "<script>"})
        self.assertIsNone(cmd["request_id"])

    def test_station_payload_is_sanitized(self):
        cmd = parse_command({"action": "favorite_add", "station": {"id": " s1 ", "evil": "x", "name": "y" * 500}})
        self.assertNotIn("evil", cmd["station"])
        self.assertEqual(cmd["station"]["id"], "s1")
        self.assertEqual(len(cmd["station"]["name"]), 200)


class TestHandleCommand(TempStorageMixin, unittest.TestCase):

    def test_apk_watchlist_add_reaches_addon(self):
        ack = asyncio.run(handle_command(CONTRACT["apk_command"]))
        self.assertTrue(ack["ok"])
        self.assertEqual(ack["request_id"], "apk_test_1")
        self.assertTrue(self.storage.is_on_watchlist("DE*SWH*E1001"))
        stored = self.storage.load_watchlist()[0]
        self.assertNotIn("is_favorite", stored)
        # Ack is published so the APK can confirm; a sync fetches live data for the new station
        self.assertEqual(list(self.worker._recent_commands)[-1]["request_id"], "apk_test_1")
        self.worker.publish_bridge_state.assert_awaited()

    def test_add_remove_is_idempotent(self):
        station = {"id": "s1", "name": "Station 1"}
        for _ in range(2):
            self.assertTrue(asyncio.run(handle_command({"action": "favorite_add", "station": station}))["ok"])
        self.assertEqual(len(self.storage.load_favorites()), 1)
        for _ in range(2):
            self.assertTrue(asyncio.run(handle_command({"action": "favorite_remove", "station_id": "s1"}))["ok"])
        self.assertEqual(self.storage.load_favorites(), [])

    def test_invalid_command_is_acknowledged_as_failed(self):
        ack = asyncio.run(handle_command({"action": "watchlist_add", "request_id": "r1", "station": {}}))
        self.assertFalse(ack["ok"])
        self.assertEqual(ack["request_id"], "r1")
        self.assertTrue(ack["error"])
        self.assertEqual(self.storage.load_watchlist(), [])
        self.worker.publish_bridge_state.assert_awaited()

    def test_watchlist_limit_reported_in_ack(self):
        self.storage.save_watchlist([{"id": f"s{i}"} for i in range(100)])
        ack = asyncio.run(handle_command({"action": "watchlist_add", "station": {"id": "one_more"}}))
        self.assertFalse(ack["ok"])
        self.assertIn("Maximal", ack["error"])

    def test_session_start_and_stop(self):
        session = {"station_id": "s1", "station_name": "Pumpwerk", "free_parking_minutes": 240, "evil": "x"}
        ack = asyncio.run(handle_command({"action": "session_start", "session": session}))
        self.assertTrue(ack["ok"])
        stored = self.storage.load_charge_session()
        self.assertEqual(stored["station_id"], "s1")
        self.assertIsInstance(stored["start_time_ms"], int)
        self.assertNotIn("evil", stored)
        self.worker.check_charge_session.assert_awaited()

        self.assertTrue(asyncio.run(handle_command({"action": "session_stop"}))["ok"])
        self.assertIsNone(self.storage.load_charge_session())

    def test_session_without_station_rejected(self):
        ack = asyncio.run(handle_command({"action": "session_start", "session": {"target_soc": 80}}))
        self.assertFalse(ack["ok"])
        self.assertIsNone(self.storage.load_charge_session())

    def test_resent_session_keeps_alert_flags(self):
        # APK missed the ack and re-sends the same session: no push may repeat
        session = {"station_id": "s1", "start_time_ms": 1792850400000}
        self.storage.save_charge_session({**session, "notified_20": True})
        asyncio.run(handle_command({"action": "session_start", "session": session}))
        self.assertTrue(self.storage.load_charge_session()["notified_20"])
        # A genuinely new session starts clean
        asyncio.run(handle_command({"action": "session_start", "session": {**session, "start_time_ms": 1792850500000}}))
        self.assertNotIn("notified_20", self.storage.load_charge_session())

    def test_sync_runs_before_ack(self):
        ack = asyncio.run(handle_command({"action": "sync"}))
        self.assertTrue(ack["ok"])
        self.worker.sync_favorites.assert_awaited_once()

    def test_test_notify_reports_delivery(self):
        with patch.object(ha_events.notifier, "send_test_notification", new=AsyncMock(return_value=False)):
            ack = asyncio.run(handle_command({"action": "test_notify"}))
        self.assertFalse(ack["ok"])
        with patch.object(ha_events.notifier, "send_test_notification", new=AsyncMock(return_value=True)):
            self.assertTrue(asyncio.run(handle_command({"action": "test_notify"}))["ok"])

    def test_never_raises(self):
        self.worker.check_charge_session.side_effect = RuntimeError("boom")
        ack = asyncio.run(handle_command({"action": "session_stop"}))
        self.assertFalse(ack["ok"])
        self.assertEqual(ack["error"], "Internal error")


class _FakeResponse:
    status_code = 200


class _FakeAsyncClient:
    posts = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        _FakeAsyncClient.posts.append({"url": url, "json": json, "headers": headers})
        return _FakeResponse()


class TestPublishBridgeState(TempStorageMixin, unittest.TestCase):

    def setUp(self):
        super().setUp()
        _FakeAsyncClient.posts = []
        self.client_patch = patch.object(poller_mod.httpx, "AsyncClient", _FakeAsyncClient)
        self.client_patch.start()

    def tearDown(self):
        self.client_patch.stop()
        super().tearDown()

    def test_publishes_bridge_sensor(self):
        inputs = CONTRACT["bridge_inputs"]
        self.storage.save_favorites(inputs["favorites"])
        self.storage.save_watchlist(inputs["watchlist"])
        worker = SyncWorker()
        worker._token = "supervisor-token"
        worker.record_command(inputs["recent_commands"][0])
        asyncio.run(worker.publish_bridge_state())

        self.assertEqual(len(_FakeAsyncClient.posts), 1)
        post = _FakeAsyncClient.posts[0]
        self.assertEqual(post["url"], f"http://supervisor/core/api/states/{BRIDGE_ENTITY_ID}")
        self.assertEqual(post["headers"]["Authorization"], "Bearer supervisor-token")
        self.assertEqual(post["json"]["state"], "2")
        attrs = post["json"]["attributes"]
        self.assertEqual(attrs["watch_ids"], ["DE*SWH*E1001", "DE*EBW*E2002"])
        self.assertEqual(attrs["recent_commands"][0]["request_id"], "apk_test_1")

    def test_without_token_nothing_is_sent(self):
        worker = SyncWorker()
        worker._token = ""
        asyncio.run(worker.publish_bridge_state())
        self.assertEqual(_FakeAsyncClient.posts, [])


class _FakeWebSocket:
    """Scripted HA WebSocket: returns queued frames, then drops the connection."""

    def __init__(self, frames):
        self.frames = [json.dumps(f) for f in frames]
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        if not self.frames:
            raise ConnectionError("connection closed")
        return self.frames.pop(0)


class TestHaEventListener(unittest.TestCase):

    def _listener(self, ws, ensure_script=None):
        self.ensure_script = ensure_script or AsyncMock(return_value="exists")
        listener = HaEventListener(connect=lambda url: ws, url="ws://test/core/websocket", ensure_script=self.ensure_script)
        listener._token = "supervisor-token"
        return listener

    def test_command_script_provided_once_after_subscription(self):
        frames = [{"type": "auth_required"}, {"type": "auth_ok"}, {"id": 1, "type": "result", "success": True}]
        listener = self._listener(_FakeWebSocket(list(frames)), AsyncMock(return_value="failed"))
        with self.assertRaises(ConnectionError):
            asyncio.run(listener.run_session())
        # Failed attempt is retried on the next connection, success only once
        self.ensure_script.return_value = "created"
        for _ in range(2):
            listener._connect = lambda url: _FakeWebSocket(list(frames))
            with self.assertRaises(ConnectionError):
                asyncio.run(listener.run_session())
        self.assertEqual(self.ensure_script.await_count, 2)
        self.ensure_script.assert_awaited_with("supervisor-token")

    def test_subscribes_and_dispatches_events(self):
        command = CONTRACT["apk_command"]
        ws = _FakeWebSocket([
            {"type": "auth_required"},
            {"type": "auth_ok"},
            {"id": 1, "type": "result", "success": True, "result": None},
            {"id": 1, "type": "event", "event": {"event_type": COMMAND_EVENT, "data": command, "origin": "REMOTE"}},
            # HA may coalesce frames into an array
            [{"id": 1, "type": "event", "event": {"data": {"action": "sync"}}}, {"id": 99, "type": "pong"}],
        ])
        listener = self._listener(ws)
        with patch.object(ha_events, "handle_command", new=AsyncMock()) as handled:
            with self.assertRaises(ConnectionError):
                asyncio.run(listener.run_session())
        self.assertTrue(listener.subscribed)
        self.assertEqual(ws.sent[0], {"type": "auth", "access_token": "supervisor-token"})
        self.assertEqual(ws.sent[1], {"id": 1, "type": "subscribe_events", "event_type": COMMAND_EVENT})
        self.assertEqual([c.args[0] for c in handled.await_args_list], [command, {"action": "sync"}])

    def test_auth_failure_does_not_subscribe(self):
        ws = _FakeWebSocket([{"type": "auth_required"}, {"type": "auth_invalid", "message": "bad"}])
        listener = self._listener(ws)
        with self.assertRaises(ConnectionError):
            asyncio.run(listener.run_session())
        self.assertFalse(listener.subscribed)
        self.assertEqual(len(ws.sent), 1)

    def test_rejected_subscription(self):
        ws = _FakeWebSocket([
            {"type": "auth_required"}, {"type": "auth_ok"},
            {"id": 1, "type": "result", "success": False, "error": {"code": "unauthorized"}},
        ])
        with self.assertRaises(ConnectionError):
            asyncio.run(self._listener(ws).run_session())

    def test_reconnects_after_connection_loss(self):
        connects = []

        def connect(url):
            connects.append(url)
            return _FakeWebSocket([])

        async def scenario():
            listener = HaEventListener(connect=connect, url="ws://test")
            listener._token = "t"
            with patch.object(ha_events, "RETRY_MIN_SECONDS", 0.01):
                listener.start()
                await asyncio.sleep(0.2)
                await listener.stop()

        asyncio.run(scenario())
        self.assertGreaterEqual(len(connects), 2)

    def test_disabled_without_supervisor_token(self):
        async def scenario():
            listener = HaEventListener(connect=lambda url: _FakeWebSocket([]))
            listener._token = ""
            listener.start()
            return listener._task

        self.assertIsNone(asyncio.run(scenario()))


def _render_like_ha(template, variables):
    """Renders a script template the way HA does (Jinja2 + native types via literal_eval)."""
    import ast
    import jinja2

    rendered = jinja2.Environment().from_string(template).render(**variables)
    try:
        return ast.literal_eval(rendered)
    except (ValueError, SyntaxError):
        return rendered


class TestCommandScript(unittest.TestCase):
    """Non-admin tokens: APK calls script.ev_charge_live_command, which re-fires the command event."""

    def test_script_fires_command_event_queued(self):
        config = command_script_config()
        self.assertEqual(config["mode"], "queued")
        self.assertEqual(config["sequence"][0]["event"], COMMAND_EVENT)

    def test_script_passes_apk_command_through_unchanged(self):
        event_data = command_script_config()["sequence"][0]["event_data"]
        for command in (
            CONTRACT["apk_command"],
            {"protocol": 1, "action": "session_start", "request_id": "apk_s",
             "session": {"station_id": "123", "station_name": "S", "start_time_ms": 1792850400000}},
            {"protocol": 1, "action": "watchlist_remove", "request_id": "apk_r", "station_id": "4711"},
            {"protocol": 1, "action": "sync", "request_id": "apk_y"},
        ):
            fired = {key: _render_like_ha(tpl, command) for key, tpl in event_data.items()}
            self.assertEqual(parse_command(fired), parse_command(command), command["action"])

    def _run_ensure(self, responses, enabled=True):
        calls = []

        class Client(_FakeAsyncClient):
            async def get(self, url, headers=None):
                calls.append(("GET", url, None))
                return type("R", (), {"status_code": responses["GET"], "text": ""})()

            async def post(self, url, json=None, headers=None):
                calls.append(("POST", url, json))
                return type("R", (), {"status_code": responses.get("POST", 200), "text": "err"})()

        config = {"home_assistant_integration": {"command_script": enabled}}
        with patch.object(ha_events.httpx, "AsyncClient", Client), \
             patch.object(ha_events.storage, "load_config", return_value=config):
            result = asyncio.run(ensure_command_script("sup"))
        return result, calls

    def test_creates_missing_script(self):
        result, calls = self._run_ensure({"GET": 404, "POST": 200})
        self.assertEqual(result, "created")
        self.assertEqual(calls[1][0], "POST")
        self.assertTrue(calls[1][1].endswith(f"/config/script/config/{COMMAND_SCRIPT_ID}"))
        self.assertEqual(calls[1][2], command_script_config())

    def test_existing_script_is_never_overwritten(self):
        result, calls = self._run_ensure({"GET": 200})
        self.assertEqual(result, "exists")
        self.assertEqual([c[0] for c in calls], ["GET"])

    def test_option_disables_provisioning(self):
        result, calls = self._run_ensure({"GET": 404}, enabled=False)
        self.assertEqual(result, "disabled")
        self.assertEqual(calls, [])

    def test_failure_reported(self):
        self.assertEqual(self._run_ensure({"GET": 500})[0], "failed")
        self.assertEqual(self._run_ensure({"GET": 404, "POST": 400})[0], "failed")


class TestIngressStaysClosed(unittest.TestCase):
    """The APK path must not weaken the Ingress-only restriction or add an HTTP command endpoint."""

    def test_no_http_route_for_commands(self):
        paths = {getattr(r, "path", "") for r in app.routes}
        self.assertFalse(any("command" in p or p.startswith("/api/events") for p in paths))

    def test_non_ingress_client_still_rejected(self):
        with patch("app.main.RESTRICT_TO_INGRESS", True):
            client = TestClient(app, client=("203.0.113.7", 50000))
            self.assertEqual(client.get("/api/watchlist").status_code, 403)


class TestIngressTogglesRefreshBridge(TempStorageMixin, unittest.TestCase):

    def test_watchlist_toggle_triggers_sync_and_publish(self):
        with patch("app.main.storage", self.storage), \
             patch("app.main.request_station_sync") as sync:
            resp = TestClient(app).post("/api/watchlist/toggle", json={"id": "s1", "name": "S1"})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["is_watched"])
        sync.assert_called_once()


if __name__ == "__main__":
    unittest.main()
