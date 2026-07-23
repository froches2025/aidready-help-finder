import os

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

app = Flask(__name__)

OPENCAGE_URL = "https://api.opencagedata.com/geocode/v1/json"


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


if __name__ == "__main__":
    app.run(debug=True)
