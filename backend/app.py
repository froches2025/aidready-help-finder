import math
import os

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

app = Flask(__name__)

OPENCAGE_URL = "https://api.opencagedata.com/geocode/v1/json"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

NEARBY_SEARCH_RADIUS_M = 5000
VALID_FACILITY_TYPES = {"hospital", "clinic", "pharmacy", "fire_station", "police"}

EARTH_RADIUS_KM = 6371


def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance in km between two lat/lng points.

    Straight-line (Euclidean) distance on lat/lng degrees is wrong because
    degrees of longitude shrink toward the poles while degrees of latitude
    stay constant — the haversine formula accounts for the sphere's
    curvature instead of treating lat/lng as a flat grid. We use it (rather
    than the more precise Vincenty ellipsoid formula) because at the ~5km
    search radius here, the earth's oblateness error is negligible and
    haversine is simpler and cheaper to compute.
    """
    lat1_rad, lng1_rad, lat2_rad, lng2_rad = (
        math.radians(lat1),
        math.radians(lng1),
        math.radians(lat2),
        math.radians(lng2),
    )
    delta_lat = lat2_rad - lat1_rad
    delta_lng = lng2_rad - lng1_rad

    # a = the square of half the chord length between the two points,
    # derived from the spherical law of cosines expanded in half-angle form.
    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lng / 2) ** 2
    )
    # c = the angular distance in radians, via atan2 for numerical stability
    # near a == 1 (antipodal points) where asin would lose precision.
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


@app.route("/")
def index():
    return "AidReady Help Finder API is running"


@app.route("/api/geocode")
def geocode():
    """Geocode a free-text address via OpenCage.

    Query params:
        address (str): free-text address to geocode.

    Returns JSON with lat, lng, and formatted address on success.
    """
    address = request.args.get("address", "").strip()
    if not address:
        return jsonify({"error": "address query param is required"}), 400

    # Read the key per-request rather than at import time so a missing/added
    # key is picked up without restarting the process.
    api_key = os.environ.get("OPENCAGE_API_KEY")
    if not api_key:
        return jsonify({"error": "server misconfigured: OPENCAGE_API_KEY is not set"}), 500

    try:
        # OpenCage has no SLA on response time; without a timeout a slow
        # upstream would hang the request thread indefinitely.
        response = requests.get(
            OPENCAGE_URL,
            params={"q": address, "key": api_key},
            timeout=5,
        )
        response.raise_for_status()
    except requests.RequestException:
        # Covers both connection-level failures and non-2xx responses raised
        # by raise_for_status() (e.g. bad key, rate limit) — the caller can't
        # do anything about an upstream problem, so surface it as a gateway error.
        return jsonify({"error": "geocoding service unavailable"}), 502

    data = response.json()
    results = data.get("results", [])
    if not results:
        # OpenCage returns 200 with an empty results array on no match, so
        # this isn't caught by the HTTP status check above.
        return jsonify({"error": "no results found for the given address"}), 404

    top_result = results[0]
    geometry = top_result["geometry"]
    return jsonify(
        {
            "lat": geometry["lat"],
            "lng": geometry["lng"],
            "formatted": top_result["formatted"],
        }
    )


@app.route("/api/nearby")
def nearby():
    """Find OSM facilities of a given type within 5km of a point.

    Query params:
        lat (float): latitude of the search origin.
        lng (float): longitude of the search origin.
        facility_type (str): one of hospital, clinic, pharmacy, fire_station, police
            (matches the OSM `amenity` tag).

    Returns JSON list of {name, lat, lng, address, distance_km}, nearest first.
    An empty list is a valid, successful result (no facilities in range).
    """
    facility_type = request.args.get("facility_type", "")
    if facility_type not in VALID_FACILITY_TYPES:
        return jsonify(
            {"error": f"facility_type must be one of: {', '.join(sorted(VALID_FACILITY_TYPES))}"}
        ), 400

    try:
        lat = float(request.args.get("lat", ""))
        lng = float(request.args.get("lng", ""))
    except ValueError:
        return jsonify({"error": "lat and lng must be numbers"}), 400

    # Overpass QL: nodes tagged with the requested amenity within
    # NEARBY_SEARCH_RADIUS_M meters of the given point.
    query = (
        f"[out:json][timeout:10];"
        f'node["amenity"="{facility_type}"](around:{NEARBY_SEARCH_RADIUS_M},{lat},{lng});'
        f"out body;"
    )

    try:
        # Overpass is a shared public instance that can be slow under load;
        # 10s (matching the query's own [timeout:10]) avoids hanging the
        # request thread waiting on a stalled upstream.
        response = requests.post(OVERPASS_URL, data={"data": query}, timeout=10)
        response.raise_for_status()
    except requests.RequestException:
        return jsonify({"error": "nearby facility service unavailable"}), 502

    elements = response.json().get("elements", [])

    facilities = []
    for element in elements:
        tags = element.get("tags", {})
        node_lat = element["lat"]
        node_lng = element["lon"]

        # Not every node carries a full postal address in OSM, so build
        # what's available rather than requiring all address parts.
        address_parts = [
            tags.get("addr:housenumber"),
            tags.get("addr:street"),
            tags.get("addr:city"),
        ]
        address = " ".join(part for part in address_parts if part) or None

        facilities.append(
            {
                "name": tags.get("name", "Unnamed"),
                "lat": node_lat,
                "lng": node_lng,
                "address": address,
                "distance_km": round(haversine_km(lat, lng, node_lat, node_lng), 3),
            }
        )

    facilities.sort(key=lambda f: f["distance_km"])
    return jsonify(facilities)


if __name__ == "__main__":
    app.run(debug=True)
