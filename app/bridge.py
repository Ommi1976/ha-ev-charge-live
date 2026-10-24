"""APK <-> add-on bridge over the official Home Assistant REST API.

The add-on is Ingress-only, so the mobile APK can never reach it directly. Instead:
- the add-on mirrors favorites, watchlist and the charge session into BRIDGE_ENTITY_ID; the APK
  reads it with ``GET /api/states/<BRIDGE_ENTITY_ID>`` and the long-lived token from pairing,
- the APK sends commands with ``POST /api/events/<COMMAND_EVENT>``; the add-on subscribes to that
  event through the Supervisor WebSocket API (ha_events.py) and acknowledges every request_id in
  the bridge sensor, so the APK knows the command really reached the add-on.

This module is pure (no I/O) so payload limits and validation are easy to test.
"""
import datetime
import json
import re
from typing import Any, Dict, Iterable, List, Optional

from .storage import sanitize_station

BRIDGE_ENTITY_ID = "sensor.ev_charge_live_bridge"
COMMAND_EVENT = "ev_charge_live_command"
BRIDGE_PROTOCOL = 1
# HA's recorder drops (and warns about) state attributes larger than 16 KiB
BRIDGE_MAX_ATTR_BYTES = 14 * 1024
MAX_RECENT_COMMANDS = 5
MAX_COMMAND_BYTES = 64 * 1024

COMMAND_ACTIONS = (
    "watchlist_add", "watchlist_remove", "favorite_add", "favorite_remove",
    "session_start", "session_stop", "sync", "test_notify",
)
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")

BRIDGE_STATION_KEYS = (
    "id", "name", "operator", "address", "postal_code", "city", "latitude", "longitude",
    "total_slots", "free_slots", "occupied_slots", "status", "status_text", "live_source", "last_updated",
)
# duration_str/duration_minutes change on every poll (recorder churn); the APK derives them from updated_at
BRIDGE_CONNECTOR_KEYS = ("point_label", "standard", "power_kw", "power_type", "status", "since_time", "updated_at")
MAX_BRIDGE_CONNECTORS = 20
# remaining_minutes ticks every minute; the APK computes it from deadline_ms
BRIDGE_SESSION_KEYS = (
    "station_id", "station_name", "connector_label", "latitude", "longitude", "start_time_ms",
    "free_parking_minutes", "night_window_start", "night_window_end", "has_night_rule",
    "target_soc", "start_soc", "target_reached_ms", "target_soc_eta_str", "blocking_fee_per_min",
    "deadline_ms", "deadline_str", "state", "is_night_paused",
)


def _json_size(data: Any) -> int:
    return len(json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))


def compact_station(station: Dict[str, Any], with_connectors: bool = True) -> Dict[str, Any]:
    """Reduces a stored station to the fields the APK renders."""
    clean = {k: station[k] for k in BRIDGE_STATION_KEYS if station.get(k) is not None}
    clean["id"] = str(station.get("id"))
    if with_connectors:
        clean["connectors"] = [
            {k: c[k] for k in BRIDGE_CONNECTOR_KEYS if c.get(k) is not None}
            for c in (station.get("connectors") or [])[:MAX_BRIDGE_CONNECTORS]
            if isinstance(c, dict)
        ]
    return clean


def compact_session(session: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not session:
        return None
    return {k: session[k] for k in BRIDGE_SESSION_KEYS if session.get(k) is not None}


def _unique_ids(stations: Iterable[Dict[str, Any]]) -> List[str]:
    ids = (str(s.get("id") or "").strip() for s in stations if isinstance(s, dict))
    return list(dict.fromkeys(i for i in ids if i))


def build_bridge_attributes(
    favorites: List[Dict[str, Any]],
    watchlist: List[Dict[str, Any]],
    session: Optional[Dict[str, Any]],
    recent_commands: Iterable[Dict[str, Any]],
    max_bytes: int = BRIDGE_MAX_ATTR_BYTES,
) -> Dict[str, Any]:
    """Builds the bridge sensor attributes, shrinking them below max_bytes if necessary.

    Contains no timestamps of its own: unchanged content then only bumps HA's last_reported
    instead of writing a new recorder row every poll cycle.
    """
    # Watchlist first: if the list must be truncated, the stations that trigger pushes survive
    by_id: Dict[str, Dict[str, Any]] = {}
    for station in list(watchlist) + list(favorites):
        sid = str(station.get("id") or "").strip() if isinstance(station, dict) else ""
        if sid and sid not in by_id:
            by_id[sid] = station
    stations = list(by_id.values())

    base = {
        "protocol": BRIDGE_PROTOCOL,
        "command_event": COMMAND_EVENT,
        "favorite_ids": _unique_ids(favorites),
        "watch_ids": _unique_ids(watchlist),
        "session": compact_session(session),
        "recent_commands": list(recent_commands)[-MAX_RECENT_COMMANDS:],
        "truncated": False,
        "friendly_name": "EV Charge Live: APK-Bridge",
        "icon": "mdi:cellphone-link",
    }
    for with_connectors in (True, False):
        attrs = {**base, "stations": [compact_station(s, with_connectors) for s in stations]}
        if _json_size(attrs) <= max_bytes:
            return attrs

    compact = [compact_station(s, False) for s in stations]
    attrs = {**base, "stations": compact, "truncated": True}
    while compact and _json_size(attrs) > max_bytes:
        compact.pop()
    return attrs


def command_request_id(data: Any) -> Optional[str]:
    """request_id of an untrusted command, or None if missing/malformed."""
    raw = data.get("request_id") if isinstance(data, dict) else None
    return raw if isinstance(raw, str) and REQUEST_ID_RE.match(raw) else None


def parse_command(data: Any) -> Dict[str, Any]:
    """Validates an untrusted COMMAND_EVENT payload; raises ValueError for anything unusable."""
    if not isinstance(data, dict):
        raise ValueError("Command payload must be an object")
    if _json_size(data) > MAX_COMMAND_BYTES:
        raise ValueError("Command payload too large")
    action = str(data.get("action") or "").strip().lower()
    if action not in COMMAND_ACTIONS:
        raise ValueError("Unknown action")

    cmd: Dict[str, Any] = {"action": action, "request_id": command_request_id(data)}
    if action in ("watchlist_add", "favorite_add"):
        cmd["station"] = sanitize_station(data.get("station"))
    elif action in ("watchlist_remove", "favorite_remove"):
        station = data.get("station")
        if not isinstance(station, dict):
            station = {"id": data.get("station_id")}
        cmd["station"] = {"id": sanitize_station(station)["id"]}
    elif action == "session_start":
        if not isinstance(data.get("session"), dict):
            raise ValueError("session required")
        # Full validation happens in storage.prepare_charge_session when the command runs
        cmd["session"] = data["session"]
    return cmd


def command_ack(request_id: Optional[str], action: str, ok: bool, error: Optional[str] = None) -> Dict[str, Any]:
    return {
        "request_id": request_id,
        "action": action[:32],
        "ok": ok,
        "error": str(error)[:200] if error else None,
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }
