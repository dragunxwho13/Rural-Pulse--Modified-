"""
OpenStreetMap proxy: Overpass (health facilities near a point), Nominatim
(village / town / PIN code -> coordinates) and OSRM (driving routes).

The server only fetches and caches. Ranking, doctor matching and the
"main-road" route choice happen in frontend/assets/js/geo.js, so the
website behaves identically whether it talks to this server or (on a
static host) straight to the public OSM services.

Public OSM services have fair-use limits: results are cached, a proper
User-Agent is sent, and every endpoint URL can be pointed at your own
instance with RP_OVERPASS_URL / RP_NOMINATIM_URL / RP_OSRM_URL.
"""
import time
from typing import Dict, Optional, Tuple

import httpx

from . import config

_CACHE: Dict[str, Tuple[float, Dict]] = {}
TTL = 6 * 3600


def _cached(key: str) -> Optional[Dict]:
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < TTL:
        return hit[1]
    return None


def _store(key: str, val: Dict) -> Dict:
    if len(_CACHE) > 2000:
        _CACHE.clear()
    _CACHE[key] = (time.time(), val)
    return val


def overpass_query(lat: float, lon: float, radius_m: int, dental: bool = False) -> str:
    r = int(max(1000, min(radius_m, 50000)))
    a = f"(around:{r},{lat:.5f},{lon:.5f})"
    dent = f'nwr["amenity"="dentist"]{a};' if dental else ""
    return (f'[out:json][timeout:25];('
            f'nwr["amenity"~"^(hospital|clinic|doctors)$"]{a};'
            f'nwr["healthcare"~"^(hospital|clinic|doctor|centre|primary_care|birthing_centre)$"]{a};'
            f'nwr["amenity"="pharmacy"]{a};{dent});out center tags 300;')


async def nearby(lat: float, lon: float, radius_m: int = 15000, dental: bool = False) -> Dict:
    key = f"near:{lat:.3f}:{lon:.3f}:{radius_m}:{dental}"
    if (c := _cached(key)) is not None:
        return {**c, "cached": True}
    q = overpass_query(lat, lon, radius_m, dental)
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": config.HTTP_USER_AGENT}) as cl:
        resp = await cl.post(config.OVERPASS_URL, data={"data": q})
        resp.raise_for_status()
        data = resp.json()
    return _store(key, {"elements": data.get("elements", []), "source": "OpenStreetMap (Overpass API)",
                        "attribution": "© OpenStreetMap contributors (ODbL)", "fetched_at": int(time.time())})


async def geocode(q: str) -> Dict:
    q = q.strip()
    key = "geo:" + q.lower()
    if (c := _cached(key)) is not None:
        return c
    params = {"format": "jsonv2", "countrycodes": "in", "limit": 5, "addressdetails": 1}
    if q.isdigit() and len(q) == 6:
        params["postalcode"] = q
    else:
        params["q"] = q
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": config.HTTP_USER_AGENT}) as cl:
        resp = await cl.get(config.NOMINATIM_URL + "/search", params=params)
        resp.raise_for_status()
        rows = resp.json()
    out = [{"name": r.get("display_name"), "lat": float(r["lat"]), "lon": float(r["lon"]), "type": r.get("type")} for r in rows]
    return _store(key, {"results": out, "source": "OpenStreetMap Nominatim"})


async def reverse(lat: float, lon: float) -> Dict:
    key = f"rev:{lat:.4f}:{lon:.4f}"
    if (c := _cached(key)) is not None:
        return c
    params = {"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 14, "addressdetails": 1}
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": config.HTTP_USER_AGENT}) as cl:
        resp = await cl.get(config.NOMINATIM_URL + "/reverse", params=params)
        resp.raise_for_status()
        r = resp.json()
    a = r.get("address", {})
    return _store(key, {"name": r.get("display_name"), "postcode": a.get("postcode"),
                        "place": a.get("village") or a.get("town") or a.get("city") or a.get("county"), "state": a.get("state")})


async def route(lat1: float, lon1: float, lat2: float, lon2: float) -> Dict:
    key = f"rt:{lat1:.4f}:{lon1:.4f}:{lat2:.4f}:{lon2:.4f}"
    if (c := _cached(key)) is not None:
        return c
    url = f"{config.OSRM_URL}/route/v1/driving/{lon1:.6f},{lat1:.6f};{lon2:.6f},{lat2:.6f}"
    params = {"overview": "full", "geometries": "geojson", "alternatives": "3", "steps": "true"}
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": config.HTTP_USER_AGENT}) as cl:
        resp = await cl.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
    return _store(key, data)
