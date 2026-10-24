"""Receives APK/automation commands from the Home Assistant event bus (protocol: see bridge.py).

The add-on listens on the Supervisor WebSocket proxy, so no add-on port has to be opened and the
Ingress-only restriction stays in place. Firing COMMAND_EVENT via the REST API requires an HA
admin token; payloads are validated exactly like the Ingress endpoints.
"""
import asyncio
import datetime
import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

from .bridge import COMMAND_EVENT, command_ack, command_request_id, parse_command
from .notifier import notifier
from .poller import poller
from .storage import prepare_charge_session, storage

_LOGGER = logging.getLogger("ev_charge_live.ha_events")

WS_URL = "ws://supervisor/core/websocket"
SUBSCRIPTION_ID = 1
MAX_WS_MESSAGE_BYTES = 1024 * 1024
RETRY_MIN_SECONDS = 2
RETRY_MAX_SECONDS = 60


class _BackgroundSync:
    """Runs station sync + bridge publish in the background; bursts of commands coalesce into one run."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._again = False

    def request(self) -> None:
        loop = asyncio.get_running_loop()
        if self._task and not self._task.done() and self._task.get_loop() is loop:
            self._again = True
            return
        self._task = loop.create_task(self._run())

    async def _run(self) -> None:
        while True:
            self._again = False
            try:
                await poller.sync_favorites()
                await poller.publish_bridge_state()
            except Exception as err:
                _LOGGER.error("Background station sync failed: %s", err, exc_info=True)
            if not self._again:
                return


_background_sync = _BackgroundSync()


def request_station_sync() -> None:
    """Fetches live data for (new) favorites/watchlist stations and republishes the bridge sensor."""
    _background_sync.request()


async def refresh_session_and_bridge() -> None:
    """Recomputes the charge guardian (deadline, HA session sensor) and republishes the bridge sensor."""
    await poller.check_charge_session()
    await poller.publish_bridge_state()


async def _execute(cmd: Dict[str, Any]) -> Optional[str]:
    """Runs a validated command; returns an error text for soft failures."""
    action = cmd["action"]
    if action in ("watchlist_add", "watchlist_remove"):
        if storage.set_watchlist(cmd["station"], action == "watchlist_add"):
            request_station_sync()
    elif action in ("favorite_add", "favorite_remove"):
        if storage.set_favorite(cmd["station"], action == "favorite_add"):
            request_station_sync()
    elif action == "session_start":
        now_ms = int(datetime.datetime.now().timestamp() * 1000)
        storage.start_charge_session(prepare_charge_session(cmd["session"], now_ms))
        await poller.check_charge_session()
    elif action == "session_stop":
        storage.clear_charge_session()
        await poller.check_charge_session()
    elif action == "sync":
        # Inline, so the ack is only published once the bridge carries fresh live data
        await poller.sync_favorites()
    elif action == "test_notify":
        if not await notifier.send_test_notification(storage.load_config()):
            return "Benachrichtigung konnte nicht zugestellt werden"
    return None


async def handle_command(data: Any) -> Dict[str, Any]:
    """Executes one command and acknowledges it in the bridge sensor. Never raises."""
    request_id = command_request_id(data)
    action = str(data.get("action") or "")[:32] if isinstance(data, dict) else ""
    try:
        cmd = parse_command(data)
        action = cmd["action"]
        error = await _execute(cmd)
        ack = command_ack(request_id, action, error is None, error)
    except ValueError as verr:
        ack = command_ack(request_id, action, False, str(verr))
    except Exception as err:
        _LOGGER.error("Command %s failed: %s", action, err, exc_info=True)
        ack = command_ack(request_id, action, False, "Internal error")

    _LOGGER.info("APK command %s (%s): %s", action or "?", request_id or "-", "ok" if ack["ok"] else ack["error"])
    poller.record_command(ack)
    await poller.publish_bridge_state()
    return ack


def _messages(raw: Any) -> List[Dict[str, Any]]:
    """Decodes one WebSocket frame; HA may coalesce several messages into a JSON array."""
    data = json.loads(raw)
    items = data if isinstance(data, list) else [data]
    return [m for m in items if isinstance(m, dict)]


async def _recv_one(ws) -> Dict[str, Any]:
    messages = _messages(await ws.recv())
    if not messages:
        raise ConnectionError("Empty message from Home Assistant")
    return messages[0]


def _default_connect(url: str):
    import websockets  # bundled with uvicorn[standard]; imported lazily so tests run without it
    return websockets.connect(url, max_size=MAX_WS_MESSAGE_BYTES, open_timeout=15)


class HaEventListener:
    """Subscribes to COMMAND_EVENT via the Supervisor WebSocket proxy and reconnects with backoff."""

    def __init__(self, connect: Optional[Callable[[str], Any]] = None, url: str = WS_URL) -> None:
        self._connect = connect or _default_connect
        self._url = url
        self._token = os.getenv("SUPERVISOR_TOKEN", "")
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.subscribed = False

    def start(self) -> None:
        if self._running:
            return
        if not self._token:
            _LOGGER.info("No SUPERVISOR_TOKEN: APK command bridge disabled (not running as add-on).")
            return
        self._running = True
        self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run_forever(self) -> None:
        delay = RETRY_MIN_SECONDS
        while self._running:
            self.subscribed = False
            try:
                await self.run_session()
            except asyncio.CancelledError:
                return
            except Exception as err:
                _LOGGER.warning("HA event subscription lost: %s", err)
            if self.subscribed:
                delay = RETRY_MIN_SECONDS
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                return
            delay = min(RETRY_MAX_SECONDS, delay * 2)

    async def run_session(self) -> None:
        """One connection: authenticate, subscribe, then handle events until the connection drops."""
        async with self._connect(self._url) as ws:
            hello = await _recv_one(ws)
            if hello.get("type") != "auth_required":
                raise ConnectionError(f"Unexpected handshake: {hello.get('type')}")
            await ws.send(json.dumps({"type": "auth", "access_token": self._token}))
            auth = await _recv_one(ws)
            if auth.get("type") != "auth_ok":
                raise ConnectionError(f"Authentication failed: {auth.get('type')}")
            await ws.send(json.dumps({"id": SUBSCRIPTION_ID, "type": "subscribe_events", "event_type": COMMAND_EVENT}))
            result = await _recv_one(ws)
            if result.get("id") != SUBSCRIPTION_ID or not result.get("success"):
                raise ConnectionError("Event subscription rejected")
            self.subscribed = True
            _LOGGER.info("Listening for %s events (APK command bridge active).", COMMAND_EVENT)

            while True:
                for msg in _messages(await ws.recv()):
                    if msg.get("type") == "event" and msg.get("id") == SUBSCRIPTION_ID:
                        await handle_command((msg.get("event") or {}).get("data"))


event_listener = HaEventListener()
