import asyncio
from contextlib import asynccontextmanager
import logging
import os
from typing import Any, Dict, List, Optional
import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .client import ev_client
from .notifier import notifier
from .poller import poller
from .storage import storage

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
_LOGGER = logging.getLogger("ev_charge_live.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _LOGGER.info("Starting up EV Charge Live application...")
    poller.start()
    yield
    _LOGGER.info("Shutting down EV Charge Live application...")
    poller.stop()


app = FastAPI(title="EV Charge Live Monitor", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    except Exception as err:
        raise HTTPException(status_code=500, detail=str(err))


@app.get("/api/device-location")
async def get_device_location() -> Dict[str, Any]:
    """Fetches real-time GPS coordinates of user's Xiaomi phone from Home Assistant."""
    try:
        token = os.getenv("SUPERVISOR_TOKEN", "")
        config = storage.load_config()
        loc_cfg = config.get("location_defaults", {})
        tracker_entity = loc_cfg.get("device_tracker_entity", "device_tracker.2407fpn8eg")

        candidates = [
            tracker_entity,
            "device_tracker.2407fpn8eg",
            "person.stephan_biehl",
            "person.stephan"
        ]

        if token:
            headers = {"Authorization": f"Bearer {token}"}
            async with httpx.AsyncClient(timeout=8.0) as client:
                for entity in candidates:
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
    city: Optional[str] = Query(None),
    postal_code: Optional[str] = Query(None),
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
    radius: Optional[int] = Query(None),
    limit: int = Query(100)
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

    # Attach is_favorite flag
    favorites = storage.load_favorites()
    fav_ids = {str(f.get("id")) for f in favorites}
    for s in stations:
        s["is_favorite"] = str(s.get("id")) in fav_ids

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
        asyncio.create_task(poller.sync_favorites())
        return {"status": "success", "is_favorite": is_fav}
    except Exception as err:
        raise HTTPException(status_code=500, detail=str(err))


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


@app.post("/api/send-to-cupra")
async def send_to_cupra_endpoint(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Emits navigation destination event on Home Assistant eventbus and sends notification to car/phone."""
    token = os.getenv("SUPERVISOR_TOKEN", "")
    station_name = payload.get("name") or payload.get("address") or "Ladestation"
    lat = payload.get("latitude")
    lon = payload.get("longitude")
    address = payload.get("address", "")
    operator = payload.get("operator", "")

    if not lat or not lon:
        raise HTTPException(status_code=400, detail="Missing latitude or longitude")

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
                service_str = notify_cfg.get("service", "notify.notify")
                parts = service_str.split(".", 1)
                domain = parts[0] if len(parts) > 1 else "notify"
                service = parts[1] if len(parts) > 1 else "notify"
                await client.post(
                    f"http://supervisor/core/api/services/{domain}/{service}",
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
