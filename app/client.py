import asyncio
import datetime
import logging
import math
import re
import time
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo
import httpx

try:
    BERLIN_TZ = ZoneInfo("Europe/Berlin")
except Exception:
    import datetime
    BERLIN_TZ = datetime.timezone(datetime.timedelta(hours=2))

MOBIDATA_BASE_URL = "https://api.mobidata-bw.de/ocpdb/api/public/v1"
ENBW_BASE_URL = "https://api.emp.emob-enbw.com/emobility-public-api/api/v1"

ENBW_HEADERS = {
    "Ocp-Apim-Subscription-Key": "90a67b9900364009b588e100e4b1cc64",
    "Origin": "https://www.enbw.com",
    "Referer": "https://www.enbw.com/",
    "Accept": "application/json",
    "User-Agent": "HomeAssistant-EVChargeLive/1.1"
}


def calculate_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine formula to calculate distance between two coordinates in km."""
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return round(r * c, 2)


def calculate_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in meters."""
    return calculate_distance_km(lat1, lon1, lat2, lon2) * 1000.0


def normalize_address(text: Optional[str]) -> str:
    """Normalizes address string for fuzzy matching including German umlauts."""
    if not text:
        return ""
    t = text.lower()
    t = t.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    t = t.replace("straße", "str").replace("strasse", "str").replace(".", "")
    return re.sub(r"[^a-z0-9]", "", t)


def format_timestamp_duration(updated_at_ms: Optional[int]) -> Tuple[Optional[str], Optional[str], Optional[int]]:
    """Converts a millisecond epoch timestamp to Europe/Berlin time and relative duration string."""
    if not updated_at_ms:
        return None, None, None
    try:
        dt = datetime.datetime.fromtimestamp(updated_at_ms / 1000.0, tz=BERLIN_TZ)
        time_str = dt.strftime("%H:%M")
        now = datetime.datetime.now(tz=BERLIN_TZ)
        diff = now - dt
        total_mins = max(0, int(diff.total_seconds() / 60))
        hours = total_mins // 60
        mins = total_mins % 60
        if hours > 0:
            dur_str = f"vor {hours} Std. {mins} Min."
        else:
            dur_str = f"vor {mins} Min."
        return time_str, dur_str, total_mins
    except Exception:
        return None, None, None


class EVChargeClient:
    def __init__(self, timeout: float = 15.0) -> None:
        self.timeout = timeout
        self._headers = {
            "User-Agent": "HomeAssistant-EVChargeLive/1.0",
            "Accept": "application/json"
        }
        self._enbw_cache: Dict[str, Any] = {}
        self._enbw_cache_time: float = 0.0
        self._enbw_detail_cache: Dict[int, Any] = {}
        self._enbw_detail_time: Dict[int, float] = {}

    async def get_stations(
        self,
        city: Optional[str] = None,
        postal_code: Optional[str] = None,
        lat: Optional[float] = None,
        lon: Optional[float] = None,
        radius_meters: Optional[int] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Queries charging stations matching postal_code, city or geo radius with EnBW real-time overlay."""
        params: Dict[str, Any] = {"limit": limit}

        if postal_code:
            params["postal_code"] = postal_code
        elif city:
            params["city"] = city

        if lat is not None and lon is not None and radius_meters is not None:
            params["lat"] = lat
            params["lon"] = lon
            params["radius"] = radius_meters

        url = f"{MOBIDATA_BASE_URL}/locations"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http_client:
                resp = await http_client.get(url, params=params, headers=self._headers)
                resp.raise_for_status()
                data = resp.json()
                raw_items = data.get("items", data.get("data", []))

                stations = []
                for item in raw_items:
                    parsed = self._parse_station(item, ref_lat=lat, ref_lon=lon)
                    if parsed:
                        stations.append(parsed)

                # Fetch EnBW real-time overlay for the visible stations
                if stations:
                    await self._apply_enbw_overlay_batch(stations, http_client, ref_lat=lat, ref_lon=lon)

                # Sort by distance if reference coords provided
                if lat is not None and lon is not None:
                    stations.sort(key=lambda x: (x.get("distance_km") is None, float(x.get("distance_km") or 999999.0)))
                else:
                    stations.sort(key=lambda x: (x.get("operator", ""), x.get("address", "")))

                return stations

        except Exception as err:
            _LOGGER.error("Failed to fetch stations from MobiData BW: %s", err)
            return []

    async def get_station_by_id(self, station_id: str) -> Optional[Dict[str, Any]]:
        """Fetches detailed real-time information for a specific station with EnBW live overlay."""
        if str(station_id).startswith("enbw_"):
            sid = str(station_id).replace("enbw_", "")
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as http_client:
                    det_url = f"{ENBW_BASE_URL}/chargestations/{sid}"
                    resp = await http_client.get(det_url, headers=ENBW_HEADERS, timeout=6.0)
                    if resp.status_code != 200:
                        return None
                    det = resp.json()
                    return self._build_standalone_enbw_station(det)
            except Exception as err:
                _LOGGER.error("Failed to fetch standalone EnBW station %s: %s", station_id, err)
                return None

        url = f"{MOBIDATA_BASE_URL}/locations/{station_id}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http_client:
                resp = await http_client.get(url, headers=self._headers)
                if resp.status_code == 404:
                    return None
                resp.raise_for_status()
                item = resp.json()
                station = self._parse_station(item)
                if station:
                    await self._apply_enbw_overlay_single(station, http_client)
                return station
        except Exception as err:
            _LOGGER.error("Failed to fetch station %s: %s", station_id, err)
            return None

    def _build_standalone_enbw_station(
        self,
        det: Dict[str, Any],
        marker_fallback: Optional[Dict[str, Any]] = None,
        ref_lat: Optional[float] = None,
        ref_lon: Optional[float] = None
    ) -> Optional[Dict[str, Any]]:
        """Builds a normalized station dictionary from an EnBW chargestation detail object."""
        m = marker_fallback or {}
        sid = det.get("stationId") or m.get("stationId")
        lat = det.get("lat") or m.get("lat")
        lon = det.get("lon") or m.get("lon")
        if not sid or lat is None or lon is None:
            return None

        raw_addr = det.get("shortAddress") or m.get("shortAddress") or ""
        parts = [p.strip() for p in raw_addr.split(",")]
        street = parts[0] if parts else raw_addr
        zip_city = parts[1] if len(parts) > 1 else ""
        zc_parts = zip_city.split(" ", 1)
        p_code = zc_parts[0] if zc_parts else ""
        c_name = zc_parts[1] if len(zc_parts) > 1 else ""

        op_name = det.get("operator") or "Unbekannter Betreiber"
        if "STADTWERKE HOCKENHEIM" in op_name.upper():
            op_name = "Stadtwerke Hockenheim"

        total = det.get("numberOfChargePoints") or m.get("numberOfChargePoints") or 1
        free = det.get("availableChargePoints")
        if free is None:
            free = m.get("availableChargePoints", 0)
        occupied = max(0, total - free)

        connectors = self._parse_enbw_charge_points(det.get("chargePoints", []))
        if not connectors:
            max_kw = round(det.get("maxPowerInKw") or m.get("maxPowerInKw") or 22.0, 1)
            connectors = [
                {
                    "standard": "Typ 2",
                    "power_kw": max_kw,
                    "power_type": "AC" if max_kw <= 43 else "DC",
                    "status": "OCCUPIED" if i < occupied else "AVAILABLE"
                }
                for i in range(total)
            ]

        if free == total:
            status = "AVAILABLE"
            status_text = "Frei"
        elif free == 0:
            status = "OCCUPIED"
            status_text = "Vollständig belegt"
        else:
            status = "PARTIAL"
            status_text = f"Teilweise belegt ({free}/{total} frei)"

        distance_km = None
        if ref_lat is not None and ref_lon is not None and lat is not None and lon is not None:
            distance_km = round(calculate_distance_m(ref_lat, ref_lon, lat, lon) / 1000.0, 2)

        return {
            "id": f"enbw_{sid}",
            "name": f"{op_name} {street}".strip(),
            "operator": op_name,
            "address": street,
            "postal_code": p_code,
            "city": c_name,
            "latitude": lat,
            "longitude": lon,
            "distance_km": distance_km,
            "total_slots": total,
            "free_slots": free,
            "occupied_slots": occupied,
            "out_of_order_slots": 0,
            "status": status,
            "status_text": status_text,
            "connectors": connectors,
            "live_source": "EnBW Echtzeit",
            "last_updated": None,
            "enbw_station_id": sid
        }

    def _parse_station(
        self,
        item: Dict[str, Any],
        ref_lat: Optional[float] = None,
        ref_lon: Optional[float] = None
    ) -> Optional[Dict[str, Any]]:
        coords = item.get("coordinates") or {}
        lat = coords.get("lat") or coords.get("latitude")
        lon = coords.get("lon") or coords.get("longitude")
        if lat is None or lon is None:
            return None

        station_id = str(item.get("id"))
        operator_info = item.get("operator") or {}
        operator_name = operator_info.get("name") or "Unbekannter Betreiber"
        address = item.get("address") or ""
        postal_code = item.get("postal_code") or ""
        city = item.get("city") or ""
        name = item.get("name") or f"{operator_name} {address}".strip()

        # Parse EVSEs and connectors
        evses = []
        charging_pools = item.get("charging_pool") or []
        for pool in charging_pools:
            evses.extend(pool.get("evses", []))
        if not evses and item.get("evses"):
            evses = item.get("evses", [])

        total_slots = len(evses)
        free_slots = 0
        occupied_slots = 0
        out_of_order_slots = 0
        connectors_info = []

        for evse in evses:
            status = (evse.get("status") or "UNKNOWN").upper()
            if status in ("AVAILABLE", "FREE"):
                free_slots += 1
            elif status in ("OCCUPIED", "CHARGING", "RESERVED"):
                occupied_slots += 1
            elif status in ("OUTOFORDER", "INOPERATIVE", "OUT_OF_SERVICE"):
                out_of_order_slots += 1
            else:
                free_slots += 1

            for conn in evse.get("connectors", []):
                standard = conn.get("standard", "Typ 2")
                if "T2_COMBO" in standard or "CCS" in standard:
                    standard_clean = "CCS"
                elif "T2" in standard:
                    standard_clean = "Typ 2"
                elif "CHADEMO" in standard:
                    standard_clean = "CHAdeMO"
                elif "SCHUKO" in standard or "DOMESTIC" in standard:
                    standard_clean = "Schuko"
                else:
                    standard_clean = standard

                power_w = conn.get("max_electric_power") or 0
                power_kw = round(power_w / 1000.0, 1) if power_w > 0 else 22.0
                connectors_info.append({
                    "standard": standard_clean,
                    "power_kw": power_kw,
                    "power_type": conn.get("power_type", "AC"),
                    "status": "AVAILABLE" if status not in ("OCCUPIED", "CHARGING") else "OCCUPIED"
                })

        # Summary status defaults
        if total_slots == 0:
            total_slots = 2
            free_slots = 2
            connectors_info.append({"standard": "Typ 2", "power_kw": 22.0, "power_type": "AC", "status": "AVAILABLE"})

        if free_slots > 0 and free_slots == total_slots:
            overall_status = "AVAILABLE"
            status_text = "Frei"
        elif free_slots > 0:
            overall_status = "PARTIAL"
            status_text = f"Teilweise belegt ({free_slots}/{total_slots} frei)"
        elif out_of_order_slots == total_slots:
            overall_status = "OUTOFORDER"
            status_text = "Außer Betrieb"
        else:
            overall_status = "OCCUPIED"
            status_text = "Vollständig belegt"

        distance_km = None
        if ref_lat is not None and ref_lon is not None:
            distance_km = calculate_distance_km(ref_lat, ref_lon, lat, lon)

        return {
            "id": station_id,
            "name": name,
            "operator": operator_name,
            "address": address,
            "postal_code": postal_code,
            "city": city,
            "latitude": lat,
            "longitude": lon,
            "distance_km": distance_km,
            "total_slots": total_slots,
            "free_slots": free_slots,
            "occupied_slots": occupied_slots,
            "out_of_order_slots": out_of_order_slots,
            "status": overall_status,
            "status_text": status_text,
            "connectors": connectors_info,
            "live_source": "MobiData BW",
            "last_updated": item.get("last_updated") or item.get("status_last_updated")
        }

    # --- EnBW Real-Time Overlay Engine ---

    async def _fetch_enbw_area(
        self,
        from_lat: float,
        to_lat: float,
        from_lon: float,
        to_lon: float,
        http_client: httpx.AsyncClient,
        depth: int = 0
    ) -> List[Dict[str, Any]]:
        """Queries EnBW public API for bounding box with recursive cluster ungrouping."""
        url = (
            f"{ENBW_BASE_URL}/chargestations?grouping=false"
            f"&fromLat={from_lat}&toLat={to_lat}&fromLon={from_lon}&toLon={to_lon}"
        )
        try:
            resp = await http_client.get(url, headers=ENBW_HEADERS, timeout=8.0)
            if resp.status_code != 200:
                return []
            markers = resp.json()
            if not isinstance(markers, list):
                return []

            results = []
            sub_tasks = []
            for m in markers:
                if m.get("grouped") and depth < 4:
                    vp = m.get("viewPort")
                    if vp:
                        ll_lat, ur_lat = vp["lowerLeftLat"], vp["upperRightLat"]
                        ll_lon, ur_lon = vp["lowerLeftLon"], vp["upperRightLon"]
                        # If viewport did not shrink enough, split into 4 quadrants
                        if depth >= 1 or (ur_lat - ll_lat > (to_lat - from_lat) * 0.85):
                            mid_lat = (ll_lat + ur_lat) / 2.0
                            mid_lon = (ll_lon + ur_lon) / 2.0
                            pad = 0.0002
                            sub_tasks.append(self._fetch_enbw_area(ll_lat - pad, mid_lat + pad, ll_lon - pad, mid_lon + pad, http_client, depth + 1))
                            sub_tasks.append(self._fetch_enbw_area(ll_lat - pad, mid_lat + pad, mid_lon - pad, ur_lon + pad, http_client, depth + 1))
                            sub_tasks.append(self._fetch_enbw_area(mid_lat - pad, ur_lat + pad, ll_lon - pad, mid_lon + pad, http_client, depth + 1))
                            sub_tasks.append(self._fetch_enbw_area(mid_lat - pad, ur_lat + pad, mid_lon - pad, ur_lon + pad, http_client, depth + 1))
                        else:
                            sub_tasks.append(
                                self._fetch_enbw_area(
                                    ll_lat, ur_lat, ll_lon, ur_lon, http_client, depth + 1
                                )
                            )
                elif not m.get("grouped"):
                    results.append(m)

            if sub_tasks:
                sub_lists = await asyncio.gather(*sub_tasks)
                seen_sids = {r.get("stationId") for r in results if r.get("stationId")}
                for sl in sub_lists:
                    for item in sl:
                        sid = item.get("stationId")
                        if sid and sid not in seen_sids:
                            seen_sids.add(sid)
                            results.append(item)
            return results
        except Exception as err:
            _LOGGER.debug("EnBW area query failed: %s", err)
            return []

    async def _apply_enbw_overlay_batch(
        self,
        stations: List[Dict[str, Any]],
        http_client: httpx.AsyncClient,
        ref_lat: Optional[float] = None,
        ref_lon: Optional[float] = None
    ) -> None:
        """Applies EnBW real-time occupancy to a batch of stations and adds standalone EnBW stations."""
        lats = [s["latitude"] for s in stations if s.get("latitude")]
        lons = [s["longitude"] for s in stations if s.get("longitude")]
        if not lats or not lons:
            return

        min_lat, max_lat = min(lats) - 0.006, max(lats) + 0.006
        min_lon, max_lon = min(lons) - 0.006, max(lons) + 0.006

        cache_key = f"{round(min_lat, 3)}_{round(max_lat, 3)}_{round(min_lon, 3)}_{round(max_lon, 3)}"
        now = time.time()

        if len(self._enbw_cache) > 100:
            self._enbw_cache.clear()
        if len(self._enbw_detail_cache) > 250:
            self._enbw_detail_cache.clear()
            self._enbw_detail_time.clear()

        if cache_key in self._enbw_cache and (now - self._enbw_cache_time) < 25.0:
            enbw_markers = self._enbw_cache[cache_key]
        else:
            enbw_markers = await self._fetch_enbw_area(min_lat, max_lat, min_lon, max_lon, http_client)
            self._enbw_cache[cache_key] = enbw_markers
            self._enbw_cache_time = now

        if not enbw_markers:
            return

        sem = asyncio.Semaphore(8)
        matched_sids = set()

        async def _fetch_enbw_detail(sid: Any) -> Optional[Dict[str, Any]]:
            if sid in self._enbw_detail_cache and (now - self._enbw_detail_time.get(sid, 0)) < 30.0:
                return self._enbw_detail_cache[sid]
            async with sem:
                det_url = f"{ENBW_BASE_URL}/chargestations/{sid}"
                resp = await http_client.get(det_url, headers=ENBW_HEADERS, timeout=4.5)
                if resp.status_code == 200:
                    det = resp.json()
                    self._enbw_detail_cache[sid] = det
                    self._enbw_detail_time[sid] = now
                    return det
            return None

        async def _enrich_station(st: Dict[str, Any]) -> None:
            matched = self._overlay_single_marker(st, enbw_markers)
            if matched and matched.get("stationId"):
                sid = matched["stationId"]
                matched_sids.add(sid)
                try:
                    det = await _fetch_enbw_detail(sid)
                    if det:
                        charge_points = det.get("chargePoints", [])
                        connectors = self._parse_enbw_charge_points(charge_points)
                        if connectors:
                            st["connectors"] = connectors
                except Exception as err:
                    _LOGGER.debug("Detail enrich failed for %s: %s", sid, err)

        await asyncio.gather(*(_enrich_station(st) for st in stations))

        # Discover standalone EnBW stations (e.g. Obere Hauptstr. 7, Parkplatz Messplatz, Gleisstr. 1/2)
        target_zips = {s.get("postal_code") for s in stations if s.get("postal_code")}
        unmatched_markers = []
        for m in enbw_markers:
            sid = m.get("stationId")
            if not sid or sid in matched_sids:
                continue
            m_lat, m_lon = m.get("lat"), m.get("lon")
            if not m_lat or not m_lon:
                continue
            m_addr_norm = normalize_address(m.get("shortAddress", ""))
            already_covered = False
            for st in stations:
                dist = calculate_distance_m(st["latitude"], st["longitude"], m_lat, m_lon)
                st_addr_norm = normalize_address(st.get("address", ""))
                if dist < 45.0 and (not m_addr_norm or m_addr_norm == st_addr_norm):
                    already_covered = True
                    break
            if not already_covered:
                unmatched_markers.append(m)

        async def _build_unmatched(m: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            sid = m.get("stationId")
            try:
                det = await _fetch_enbw_detail(sid)
                if not det:
                    return None
                st_obj = self._build_standalone_enbw_station(det, m, ref_lat=ref_lat, ref_lon=ref_lon)
                if st_obj and (not target_zips or st_obj.get("postal_code") in target_zips):
                    return st_obj
            except Exception as err:
                _LOGGER.debug("Standalone EnBW enrich failed for %s: %s", sid, err)
            return None

        if unmatched_markers:
            extra_stations = await asyncio.gather(*(_build_unmatched(m) for m in unmatched_markers))
            for ext in extra_stations:
                if ext:
                    stations.append(ext)

    def _parse_enbw_charge_points(self, charge_points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Parses charge points with exact kW, EVSE ID, status, since_time, and duration_str."""
        connectors = []
        for cp in charge_points:
            cp_status = cp.get("status", "AVAILABLE").upper()
            evse_id = cp.get("evseId")
            updated_at = cp.get("state", {}).get("updatedAt")
            since_time, duration_str, duration_mins = format_timestamp_duration(updated_at)

            for conn in cp.get("connectors", []):
                plug = conn.get("plugTypeName") or conn.get("chargePlugTypeGroup") or "Typ 2"
                if "type_2" in plug.lower() or "typ 2" in plug.lower():
                    plug = "Typ 2"
                elif "ccs" in plug.lower():
                    plug = "CCS"
                elif "chademo" in plug.lower():
                    plug = "CHAdeMO"
                elif "schuko" in plug.lower():
                    plug = "Schuko"
                power = round(conn.get("maxPowerInKw") or 22.0, 1)
                connectors.append({
                    "standard": plug,
                    "power_kw": power,
                    "power_type": "AC" if power <= 43 else "DC",
                    "status": cp_status,
                    "evse_id": evse_id,
                    "updated_at": updated_at,
                    "since_time": since_time,
                    "duration_str": duration_str,
                    "duration_minutes": duration_mins
                })
        return connectors

    async def _apply_enbw_overlay_single(
        self,
        station: Dict[str, Any],
        http_client: httpx.AsyncClient
    ) -> None:
        """Applies detailed real-time availability from EnBW for a single station."""
        lat = station.get("latitude")
        lon = station.get("longitude")
        if not lat or not lon:
            return

        # Check tight bounding box
        delta = 0.004
        markers = await self._fetch_enbw_area(lat - delta, lat + delta, lon - delta, lon + delta, http_client)
        matched_enbw = self._overlay_single_marker(station, markers)

        # If matched and stationId available, get individual connector statuses
        if matched_enbw and matched_enbw.get("stationId"):
            try:
                sid = matched_enbw["stationId"]
                det_url = f"{ENBW_BASE_URL}/chargestations/{sid}"
                resp = await http_client.get(det_url, headers=ENBW_HEADERS, timeout=6.0)
                if resp.status_code == 200:
                    det = resp.json()
                    charge_points = det.get("chargePoints", [])
                    connectors = self._parse_enbw_charge_points(charge_points)
                    if connectors:
                        station["connectors"] = connectors
            except Exception as err:
                _LOGGER.debug("Could not fetch EnBW detail for station %s: %s", matched_enbw.get("stationId"), err)

    def _overlay_single_marker(
        self,
        station: Dict[str, Any],
        enbw_markers: List[Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        st_lat = station["latitude"]
        st_lon = station["longitude"]
        st_addr_norm = normalize_address(station.get("address", ""))

        best_addr_match = None
        min_addr_dist = 999999.0
        best_dist_match = None
        min_dist = 999999.0

        for m in enbw_markers:
            m_lat = m.get("lat")
            m_lon = m.get("lon")
            if not m_lat or not m_lon:
                continue

            dist = calculate_distance_m(st_lat, st_lon, m_lat, m_lon)
            if dist >= 250.0:
                continue

            m_addr_norm = normalize_address(m.get("shortAddress", ""))
            is_addr_match = bool(
                st_addr_norm and m_addr_norm and (st_addr_norm in m_addr_norm or m_addr_norm in st_addr_norm)
            )

            if is_addr_match and dist < min_addr_dist:
                min_addr_dist = dist
                best_addr_match = m
            elif dist < 120.0 and dist < min_dist:
                min_dist = dist
                best_dist_match = m

        best_match = best_addr_match or best_dist_match

        if best_match:
            total = best_match.get("numberOfChargePoints") or station.get("total_slots", 2)
            free = best_match.get("availableChargePoints")
            if free is not None:
                occupied = max(0, total - free)
                station["total_slots"] = total
                station["free_slots"] = free
                station["occupied_slots"] = occupied
                station["live_source"] = "EnBW Echtzeit"
                station["enbw_station_id"] = best_match.get("stationId")

                # Synchronize individual connectors list so no contradiction exists
                conns = station.get("connectors") or []
                if not conns:
                    conns = [{"standard": "Typ 2", "power_kw": 22.0, "power_type": "AC"} for _ in range(total)]
                while len(conns) < total:
                    conns.append({"standard": "Typ 2", "power_kw": 22.0, "power_type": "AC"})

                # Mark first occupied slots as OCCUPIED, remaining as AVAILABLE
                for i, c in enumerate(conns):
                    if i < occupied:
                        c["status"] = "OCCUPIED"
                    else:
                        c["status"] = "AVAILABLE"
                station["connectors"] = conns

                if free == total:
                    station["status"] = "AVAILABLE"
                    station["status_text"] = "Frei"
                elif free == 0:
                    station["status"] = "OCCUPIED"
                    station["status_text"] = "Vollständig belegt"
                else:
                    station["status"] = "PARTIAL"
                    station["status_text"] = f"Teilweise belegt ({free}/{total} frei)"

                return best_match
        return None


ev_client = EVChargeClient()
