import asyncio
from contextlib import asynccontextmanager
import datetime
import json
import logging
import math
import os
import re
import time
from typing import Any, Dict, List, Optional
import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from .client import ev_client
from .notifier import notifier
from .poller import poller
from .storage import sanitize_charge_session, storage

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
_LOGGER = logging.getLogger("ev_charge_live.main")

SAFE_HA_ENTITY_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
SAFE_NOTIFY_RE = re.compile(r"^notify\.[a-z0-9_]+$")
SAFE_HOST_RE = re.compile(r"^[a-zA-Z0-9.\-_]+(?::\d{1,5})?$")

# Home Assistant Ingress proxy address; when running as add-on only it (and loopback) may talk to us
INGRESS_ALLOWED_HOSTS = {"172.30.32.2", "127.0.0.1", "::1"}
RESTRICT_TO_INGRESS = bool(os.getenv("SUPERVISOR_TOKEN")) and os.getenv("EV_ALLOW_DIRECT_ACCESS", "") != "1"
MAX_BODY_BYTES = 128 * 1024

_background_tasks: set = set()


def _spawn_background(coro) -> None:
    """Keeps a strong reference to fire-and-forget tasks so they are not garbage collected mid-run."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_on_background_done)


def _on_background_done(task: "asyncio.Task") -> None:
    _background_tasks.discard(task)
    if not task.cancelled() and task.exception() is not None:
        _LOGGER.error("Background task failed: %s", task.exception())


@asynccontextmanager
async def lifespan(app: FastAPI):
    _LOGGER.info("Starting up EV Charge Live application...")
    poller.start()
    yield
    _LOGGER.info("Shutting down EV Charge Live application...")
    await poller.stop()


app = FastAPI(title="EV Charge Live Monitor", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Ingress is same-origin; only the Capacitor APK WebView origins need CORS
    allow_origins=["https://localhost", "http://localhost", "capacitor://localhost"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.middleware("http")
async def guard_requests(request: Request, call_next):
    if RESTRICT_TO_INGRESS:
        client_host = request.client.host if request.client else ""
        if client_host not in INGRESS_ALLOWED_HOSTS:
            _LOGGER.warning("Rejected non-ingress request from %s to %s", client_host, request.url.path)
            return PlainTextResponse("Forbidden", status_code=403)
    if request.method in ("POST", "PUT", "PATCH"):
        try:
            length = int(request.headers.get("content-length") or 0)
        except ValueError:
            return PlainTextResponse("Bad Request", status_code=400)
        if length > MAX_BODY_BYTES:
            return PlainTextResponse("Payload too large", status_code=413)
    return await call_next(request)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(self), geolocation=(self), bluetooth=(self)"
    response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
    return response


STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
async def serve_index(request: Request):
    """Serves the Ingress single page dashboard."""
    index_path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="Frontend index.html not found")
    with open(index_path, "r", encoding="utf-8") as f:
        content = f.read()
    return HTMLResponse(content)


@app.get("/api/config")
async def get_config() -> Dict[str, Any]:
    """Returns the effective active configuration."""
    return storage.load_config()


@app.post("/api/config")
async def update_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Saves updated user configuration."""
    try:
        storage.save_config_override(payload)
        return {"status": "success", "config": storage.load_config()}
    except ValueError as verr:
        raise HTTPException(status_code=400, detail=str(verr))
    except Exception as err:
        _LOGGER.error("Request failed: %s", err, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal error")


@app.get("/api/pairing-info")
async def get_pairing_info(request: Request) -> Dict[str, Any]:
    """Returns detected Home Assistant connection info and JSON pairing payload for mobile APK."""
    config = storage.load_config()
    cfg_url = str(config.get("ha_server_url") or "").strip()
    cfg_token = str(config.get("ha_token") or "").strip()

    # Auto-detect base HA URL from Ingress request headers if not explicitly configured
    proto = request.headers.get("x-forwarded-proto", "http").split(",")[0].strip().lower()
    if proto not in ("http", "https"):
        proto = "http"
    raw_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    if not raw_host:
        raw_host = request.headers.get("host", "").split(",")[0].strip()

    # Sanitize host to prevent HTTP Host Header Injection
    host = raw_host if SAFE_HOST_RE.match(raw_host) else ""
    detected_url = f"{proto}://{host}" if host else ""
    effective_url = cfg_url or detected_url or "http://homeassistant.local:8123"

    pairing_data = {
        "type": "ha_pairing",
        "version": 1,
        "ha_url": effective_url,
        "ha_token": cfg_token,
        "created_at": int(time.time())
    }

    return {
        "status": "success",
        "ha_url": effective_url,
        "has_token": bool(cfg_token),
        "detected_url": detected_url,
        "pairing_data": pairing_data,
        "pairing_string": json.dumps(pairing_data, separators=(",", ":"))
    }


def _detect_ha_url(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", "http").split(",")[0].strip().lower()
    if proto not in ("http", "https"):
        proto = "http"
    raw_host = (request.headers.get("x-forwarded-host", "") or request.headers.get("host", "")).split(",")[0].strip()
    host = raw_host if SAFE_HOST_RE.match(raw_host) else ""
    return f"{proto}://{host}" if host else "http://homeassistant.local:8123"


def _render_pairing_qr(request: Request, url: Optional[str], token: Optional[str]) -> Response:
    if url is not None and not isinstance(url, str):
        raise HTTPException(status_code=400, detail="Invalid URL")
    if token is not None and not isinstance(token, str):
        raise HTTPException(status_code=400, detail="Invalid token")
    url_clean = (url or "").strip()
    if url_clean and not (url_clean.startswith("http://") or url_clean.startswith("https://")):
        raise HTTPException(status_code=400, detail="Invalid URL scheme. Must start with http:// or https://")
    if len(url_clean) > 512:
        raise HTTPException(status_code=400, detail="URL exceeds maximum length of 512 characters")
    if token is not None and len(token) > 2048:
        raise HTTPException(status_code=400, detail="Token exceeds maximum length of 2048 characters")

    try:
        import qrcode
        import qrcode.image.svg

        config = storage.load_config()
        effective_url = url_clean or str(config.get("ha_server_url") or "").strip() or _detect_ha_url(request)
        payload = {
            "type": "ha_pairing",
            "version": 1,
            "ha_url": effective_url,
            "ha_token": (token or "").strip()
        }
        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=2,
            image_factory=qrcode.image.svg.SvgPathImage
        )
        qr.add_data(json.dumps(payload, separators=(",", ":")))
        qr.make(fit=True)
        img = qr.make_image(attrib={"class": "pairing-qr-svg"})
        # QR contains a long-lived token: never cache it anywhere
        return Response(content=img.to_string(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})
    except HTTPException:
        raise
    except Exception as err:
        _LOGGER.error("Failed to generate pairing QR: %s", err, exc_info=True)
        raise HTTPException(status_code=500, detail="QR generation failed")


@app.get("/api/pairing-qr")
async def get_pairing_qr(
    request: Request,
    url: Optional[str] = Query(None, max_length=512),
) -> Response:
    """SVG pairing QR without token (tokens must be sent via POST, see below)."""
    if "token" in request.query_params:
        raise HTTPException(status_code=400, detail="Token must be sent via POST body, not in the URL")
    return _render_pairing_qr(request, url, None)


@app.post("/api/pairing-qr")
async def post_pairing_qr(request: Request, payload: Dict[str, Any]) -> Response:
    """Generates an SVG QR code for 1-click mobile APK pairing (token in body, never in the URL/log)."""
    return _render_pairing_qr(request, payload.get("url"), payload.get("token"))


@app.get("/api/device-location")
async def get_device_location() -> Dict[str, Any]:
    """Fetches real-time GPS coordinates of user's Xiaomi phone from Home Assistant."""
    try:
        token = os.getenv("SUPERVISOR_TOKEN", "")
        config = storage.load_config()
        loc_cfg = config.get("location_defaults", {})
        raw_tracker = str(loc_cfg.get("device_tracker_entity", "device_tracker.2407fpn8eg")).strip().lower()
        tracker_entity = raw_tracker if SAFE_HA_ENTITY_RE.match(raw_tracker) else "device_tracker.2407fpn8eg"

        candidates = [
            tracker_entity,
            "device_tracker.2407fpn8eg",
            "person.stephan_biehl",
            "person.stephan"
        ]

        if token:
            headers = {"Authorization": f"Bearer {token}"}
            async with httpx.AsyncClient(timeout=8.0) as client:
                for entity in dict.fromkeys(candidates):
                    if not SAFE_HA_ENTITY_RE.match(entity):
                        continue
                    try:
                        resp = await client.get(f"http://supervisor/core/api/states/{entity}", headers=headers)
                        if resp.status_code == 200:
                            data = resp.json()
                            attrs = data.get("attributes", {})
                            lat = attrs.get("latitude")
                            lon = attrs.get("longitude")
                            if lat is not None and lon is not None:
                                return {
                                    "status": "success",
                                    "entity_id": entity,
                                    "name": attrs.get("friendly_name", "XIAOMI 14T Pro"),
                                    "latitude": float(lat),
                                    "longitude": float(lon),
                                    "accuracy": attrs.get("gps_accuracy", 10),
                                    "state": data.get("state", "home")
                                }
                    except Exception as err:
                        _LOGGER.warning("Could not read location from entity %s: %s", entity, err)

        # Fallback to configured defaults
        return {
            "status": "fallback",
            "entity_id": "fallback",
            "name": "Hockenheim (Standard)",
            "latitude": loc_cfg.get("latitude", 49.317584),
            "longitude": loc_cfg.get("longitude", 8.545261),
            "accuracy": 50,
            "state": "default"
        }
    except Exception as err:
        _LOGGER.error("Unexpected error in get_device_location: %s", err, exc_info=True)
        return {
            "status": "fallback",
            "entity_id": "fallback",
            "name": "Hockenheim (Standard)",
            "latitude": 49.317584,
            "longitude": 8.545261,
            "accuracy": 50,
            "state": "default"
        }


@app.get("/api/stations")
async def search_stations(
    city: Optional[str] = Query(None, max_length=100),
    postal_code: Optional[str] = Query(None, max_length=20),
    lat: Optional[float] = Query(None, ge=-90.0, le=90.0),
    lon: Optional[float] = Query(None, ge=-180.0, le=180.0),
    radius: Optional[int] = Query(None, ge=100, le=100000),
    limit: int = Query(100, ge=1, le=250)
) -> List[Dict[str, Any]]:
    """Searches for charging stations by address or geo-radius."""
    config = storage.load_config()
    loc_cfg = config.get("location_defaults", {})

    # Fallback to configured defaults if not provided
    if not city and not postal_code and lat is None:
        postal_code = loc_cfg.get("postal_code", "68766")
        city = loc_cfg.get("city", "Hockenheim")
        lat = loc_cfg.get("latitude", 49.317584)
        lon = loc_cfg.get("longitude", 8.545261)
        radius = loc_cfg.get("search_radius_meters", 5000)
    elif lat is not None and lon is not None and not city and not postal_code:
        radius = radius or loc_cfg.get("search_radius_meters", 5000)

    stations = await ev_client.get_stations(
        city=city,
        postal_code=postal_code,
        lat=lat,
        lon=lon,
        radius_meters=radius,
        limit=limit
    )

    # Attach is_favorite and is_watched flags
    favorites = storage.load_favorites()
    fav_ids = {str(f.get("id")) for f in favorites}
    watchlist = storage.load_watchlist()
    watch_ids = {str(w.get("id")) for w in watchlist}
    for s in stations:
        sid = str(s.get("id"))
        s["is_favorite"] = sid in fav_ids
        s["is_watched"] = sid in watch_ids

    return stations


@app.get("/api/favorites")
async def get_favorites() -> List[Dict[str, Any]]:
    """Returns the list of monitored favorite stations."""
    return storage.load_favorites()


@app.post("/api/favorites/toggle")
async def toggle_favorite(station: Dict[str, Any]) -> Dict[str, Any]:
    """Toggles favorite status for a station and triggers immediate HA state push."""
    try:
        is_fav = storage.toggle_favorite(station)
        # Run poller sync in background to update HA entity immediately
        _spawn_background(poller.sync_favorites())
        return {"status": "success", "is_favorite": is_fav}
    except ValueError as verr:
        raise HTTPException(status_code=400, detail=str(verr))
    except Exception as err:
        _LOGGER.error("Request failed: %s", err, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal error")


@app.get("/api/watchlist")
async def get_watchlist() -> List[Dict[str, Any]]:
    """Returns the list of stations actively on the push notification watchlist."""
    return storage.load_watchlist()


@app.post("/api/watchlist/toggle")
async def toggle_watchlist(station: Dict[str, Any]) -> Dict[str, Any]:
    """Toggles watchlist status for a station."""
    try:
        is_watched = storage.toggle_watchlist(station)
        return {"status": "success", "is_watched": is_watched}
    except ValueError as verr:
        raise HTTPException(status_code=400, detail=str(verr))
    except Exception as err:
        _LOGGER.error("Request failed: %s", err, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal error")


@app.get("/api/notify-devices")
async def get_notify_devices() -> List[Dict[str, Any]]:
    """Discovers available mobile notification services from Home Assistant."""
    token = os.getenv("SUPERVISOR_TOKEN", "")
    devices: List[Dict[str, Any]] = []

    known_labels = {
        "notify.mobile_app_2407fpn8eg": "📱 Stephan (Xiaomi 14T Pro)",
        "notify.mobile_app_sm_s928b": "📱 Galaxy S24 Ultra",
        "notify.mobile_app_2405crpfdg": "📱 Xiaomi Handy",
        "notify.mobile_app_sm_x115": "📟 Galaxy Tab A9",
        "notify.notify": "📢 Alle Geräte (Broadcast Gruppe)"
    }

    if token:
        try:
            headers = {"Authorization": f"Bearer {token}"}
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get("http://supervisor/core/api/services", headers=headers)
                if resp.status_code == 200:
                    domains = resp.json()
                    for d in domains:
                        if d.get("domain") == "notify":
                            svcs = d.get("services", {})
                            for svc_key in svcs.keys():
                                full_id = f"notify.{svc_key}"
                                if svc_key.startswith("mobile_app_") or svc_key == "notify":
                                    label = known_labels.get(
                                        full_id,
                                        f"📱 {svc_key.replace('mobile_app_', '').replace('_', ' ').upper()}"
                                    )
                                    devices.append({"id": full_id, "name": label})
        except Exception as err:
            _LOGGER.warning("Could not query HA notify services: %s", err)

    if not devices:
        devices = [{"id": k, "name": v} for k, v in known_labels.items()]

    return devices


@app.post("/api/test-notify")
async def test_notification() -> Dict[str, Any]:
    """Sends a test push notification to Home Assistant."""
    config = storage.load_config()
    success = await notifier.send_test_notification(config)
    return {"status": "success" if success else "failed", "delivered": success}


@app.post("/api/sync")
async def trigger_sync() -> Dict[str, Any]:
    """Manually forces a live polling cycle for all favorites."""
    await poller.sync_favorites()
    return {"status": "success", "count": len(storage.load_favorites())}


@app.get("/api/charge-session")
async def get_charge_session() -> Dict[str, Any]:
    """Returns the current active charging session (Lade-Wächter)."""
    session = storage.load_charge_session()
    return {"status": "success", "session": session}


@app.post("/api/charge-session/start")
async def start_charge_session(session_data: Dict[str, Any]) -> Dict[str, Any]:
    """Starts or updates the active charging session with blocking fee and target SoC monitoring."""
    try:
        now_ms = int(datetime.datetime.now().timestamp() * 1000)
        clean = sanitize_charge_session(session_data)
        if not clean.get("station_id") and not clean.get("station_name"):
            raise HTTPException(status_code=400, detail="station_id or station_name required")
        # Missing/invalid start time would push the deadline forward on every poll -> never alert
        clean.setdefault("start_time_ms", now_ms)
        storage.save_charge_session(clean)
        _spawn_background(poller.check_charge_session())
        return {"status": "success", "session": clean}
    except HTTPException:
        raise
    except Exception as err:
        _LOGGER.error("Failed to start charge session: %s", err, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal error")


@app.post("/api/charge-session/stop")
async def stop_charge_session() -> Dict[str, Any]:
    """Stops and clears the active charging session."""
    try:
        storage.clear_charge_session()
        _spawn_background(poller.check_charge_session())
        return {"status": "success"}
    except Exception as err:
        _LOGGER.error("Failed to stop charge session: %s", err, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal error")


@app.post("/api/send-to-cupra")
async def send_to_cupra_endpoint(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Emits navigation destination event on Home Assistant eventbus and sends notification to car/phone."""
    token = os.getenv("SUPERVISOR_TOKEN", "")
    station_name = str(payload.get("name") or payload.get("address") or "Ladestation")[:150]
    raw_lat = payload.get("latitude")
    raw_lon = payload.get("longitude")
    address = str(payload.get("address", ""))[:200]
    operator = str(payload.get("operator", ""))[:120]

    try:
        lat = float(raw_lat)
        lon = float(raw_lon)
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            raise ValueError("Coordinates out of range")
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid or missing latitude/longitude")

    gmaps_url = f"https://www.google.com/maps/dir/?api=1&destination={lat},{lon}"

    if token:
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        event_payload = {
            "name": station_name,
            "address": address,
            "operator": operator,
            "latitude": lat,
            "longitude": lon,
            "google_maps_url": gmaps_url
        }
        async with httpx.AsyncClient(timeout=8.0) as client:
            try:
                await client.post(
                    "http://supervisor/core/api/events/ev_charge_send_to_cupra",
                    json=event_payload,
                    headers=headers
                )
            except Exception as err:
                _LOGGER.warning("Could not fire ev_charge_send_to_cupra event: %s", err)

            try:
                config = storage.load_config()
                notify_cfg = config.get("notifications", {})
                target_devices = notify_cfg.get("target_devices")
                if not target_devices or not isinstance(target_devices, list):
                    single_svc = notify_cfg.get("service", "notify.mobile_app_2407fpn8eg")
                    target_devices = [single_svc] if single_svc else ["notify.mobile_app_2407fpn8eg"]
                for dev_str in dict.fromkeys(str(d).strip().lower() for d in target_devices):
                    if not SAFE_NOTIFY_RE.match(dev_str):
                        continue
                    service = dev_str.split(".", 1)[1]
                    await client.post(
                        f"http://supervisor/core/api/services/notify/{service}",
                        json={
                            "title": "🚗 Route an Cupra Born gesendet",
                            "message": f"Ziel: {station_name} ({address})",
                            "data": {
                                "url": gmaps_url,
                                "clickAction": gmaps_url
                            }
                        },
                        headers=headers
                    )
            except Exception as err:
                _LOGGER.warning("Could not send Cupra notification: %s", err)

    return {
        "status": "success",
        "message": f"Ziel {station_name} an Cupra Born gesendet!",
        "google_maps_url": gmaps_url
    }


@app.get("/api/geocode")
async def geocode_location(q: str = Query(..., min_length=2, max_length=150)) -> List[Dict[str, Any]]:
    """Geocodes an address or city query via OpenStreetMap Nominatim."""
    url = "https://nominatim.openstreetmap.org/search"
    headers = {"User-Agent": "EVChargeLiveApp/1.0 (HomeAssistant; CupraBorn)"}
    params = {"q": q.strip(), "format": "json", "addressdetails": 1, "limit": 5, "countrycodes": "de,at,ch,fr,nl"}
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                results = resp.json()
                return [
                    {
                        "display_name": item.get("display_name"),
                        "latitude": float(item.get("lat")),
                        "longitude": float(item.get("lon")),
                        "type": item.get("type")
                    }
                    for item in results
                    if item.get("lat") is not None and item.get("lon") is not None
                ]
        except Exception as err:
            _LOGGER.warning("Geocoding failed for '%s': %s", q, err)
    return []


@app.get("/api/route")
async def calculate_route(
    start_lat: float = Query(..., ge=-90.0, le=90.0),
    start_lon: float = Query(..., ge=-180.0, le=180.0),
    end_lat: float = Query(..., ge=-90.0, le=90.0),
    end_lon: float = Query(..., ge=-180.0, le=180.0)
) -> Dict[str, Any]:
    """Calculates driving route geometry and distance via public OSRM."""
    url = f"https://router.project-osrm.org/route/v1/driving/{start_lon},{start_lat};{end_lon},{end_lat}"
    params = {"overview": "full", "geometries": "geojson", "steps": "false"}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                data = resp.json()
                routes = data.get("routes", [])
                if routes:
                    primary = routes[0]
                    dist_km = primary.get("distance", 0) / 1000.0
                    duration_min = primary.get("duration", 0) / 60.0
                    coords = primary.get("geometry", {}).get("coordinates", [])
                    lat_lngs = [[c[1], c[0]] for c in coords if len(c) >= 2]
                    return {
                        "status": "success",
                        "distance_km": round(dist_km, 1),
                        "duration_minutes": round(duration_min),
                        "coordinates": lat_lngs
                    }
        except Exception as err:
            _LOGGER.warning("Route calculation failed: %s", err)

    # Fallback to direct calculation if OSRM is unreachable
    dlat = math.radians(end_lat - start_lat)
    dlon = math.radians(end_lon - start_lon)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(start_lat)) * math.cos(math.radians(end_lat)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    direct_km = 6371.0 * c * 1.25  # 25% road factor
    return {
        "status": "fallback",
        "distance_km": round(direct_km, 1),
        "duration_minutes": round(direct_km / 90.0 * 60),
        "coordinates": [[start_lat, start_lon], [end_lat, end_lon]]
    }
