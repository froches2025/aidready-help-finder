// AidReady Help Finder - frontend logic.
// Talks to the Flask API for geocoding + nearby search, plots results on a
// Leaflet map, and offers a client-side sort/filter over already-loaded results.

const API_BASE = ''; // same-origin; see CLAUDE.md TODO re: serving frontend + API together

const FACILITY_LABELS = {
  hospital: 'hospital',
  clinic: 'clinic',
  pharmacy: 'pharmacy',
  fire_station: 'fire station',
  police: 'police station',
};

// --- DOM elements ---
const form = document.getElementById('search-form');
const addressInput = document.getElementById('address-input');
const locateBtn = document.getElementById('locate-btn');
const facilityTypeSelect = document.getElementById('facility-type-select');
const searchBtn = document.getElementById('search-btn');
const searchStatus = document.getElementById('search-status');
const searchError = document.getElementById('search-error');

const resultsControls = document.getElementById('results-controls');
const resultsList = document.getElementById('results-list');
const emptyState = document.getElementById('empty-state');
const filterInput = document.getElementById('filter-input');
const sortButtons = document.querySelectorAll('.sort-btn');

// --- state ---
let allResults = []; // last loaded /api/nearby results, unfiltered
let currentSort = 'distance'; // 'distance' or 'name'
let currentFilter = '';
let origin = null; // { lat, lng, label }

// --- map setup ---
const map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

let originMarker = null;
let resultMarkers = [];

function clearResultMarkers() {
  resultMarkers.forEach((marker) => map.removeLayer(marker));
  resultMarkers = [];
}

function plotOrigin(lat, lng, label) {
  if (originMarker) map.removeLayer(originMarker);
  originMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: 'origin-marker', html: '📍', iconSize: [24, 24] }),
  })
    .addTo(map)
    .bindPopup(label);
}

function plotResults(results) {
  clearResultMarkers();
  results.forEach((facility) => {
    const marker = L.marker([facility.lat, facility.lng])
      .addTo(map)
      .bindPopup(`${facility.name}<br>${facility.distance_km} km`);
    resultMarkers.push(marker);
  });

  // fit the map to show the origin plus every result, so nothing is off-screen
  const points = [[origin.lat, origin.lng], ...results.map((f) => [f.lat, f.lng])];
  if (points.length > 1) {
    map.fitBounds(points, { padding: [30, 30] });
  } else {
    map.setView(points[0], 14);
  }
}

// --- status / error messaging ---
function setStatus(message) {
  searchStatus.textContent = message;
  searchError.textContent = '';
}

function setError(message) {
  searchError.textContent = message;
  searchStatus.textContent = '';
}

function clearMessages() {
  searchStatus.textContent = '';
  searchError.textContent = '';
}

function setLoading(isLoading) {
  searchBtn.disabled = isLoading;
  locateBtn.disabled = isLoading;
  if (isLoading) setStatus('Searching…');
}

// --- API calls ---

// Wraps fetch + the backend's { error: "..." } JSON body into a thrown Error
// carrying the real HTTP status and the backend's own message, so the UI can
// show exactly what the API said rather than a generic "something went wrong".
async function apiGet(path, params) {
  const url = new URL(API_BASE + path, window.location.href);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  let response;
  try {
    response = await fetch(url);
  } catch (networkError) {
    const err = new Error('Could not reach the AidReady server. Check your connection and try again.');
    err.status = 0;
    throw err;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (parseError) {
    // non-JSON body (e.g. a proxy error page) - fall through to status-based message below
  }

  if (!response.ok) {
    const err = new Error((body && body.error) || `Request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }

  return body;
}

function geocode(address) {
  return apiGet('/api/geocode', { address });
}

function nearby(lat, lng, facilityType) {
  return apiGet('/api/nearby', { lat, lng, facility_type: facilityType });
}

// --- geolocation ---

// Wraps the callback-based Geolocation API in a promise and turns its error
// codes into messages a non-technical user can act on, instead of surfacing
// raw GeolocationPositionError objects.
function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Your browser does not support location access. Please enter an address instead.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({ lat: position.coords.latitude, lng: position.coords.longitude });
      },
      (geoError) => {
        const messages = {
          1: 'Location access was denied. Please enter an address instead.',
          2: 'Your location could not be determined. Please enter an address instead.',
          3: 'Location request timed out. Please enter an address instead.',
        };
        reject(new Error(messages[geoError.code] || 'Could not get your location. Please enter an address instead.'));
      },
      { timeout: 10000 }
    );
  });
}

// --- results rendering ---

function matchesFilter(facility, filterText) {
  if (!filterText) return true;
  const haystack = `${facility.name} ${facility.address || ''}`.toLowerCase();
  return haystack.includes(filterText.toLowerCase());
}

function sortFacilities(facilities, sortBy) {
  const sorted = [...facilities];
  if (sortBy === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    sorted.sort((a, b) => a.distance_km - b.distance_km);
  }
  return sorted;
}

// Re-derives what's on screen from allResults + currentSort/currentFilter.
// No API call here - the point of filter/sort is that they're instant.
function renderResults() {
  const filtered = allResults.filter((f) => matchesFilter(f, currentFilter));
  const sorted = sortFacilities(filtered, currentSort);

  resultsList.innerHTML = '';

  if (allResults.length === 0) {
    emptyState.hidden = false;
    emptyState.querySelector('p').textContent =
      `No ${FACILITY_LABELS[facilityTypeSelect.value]} found within 5km.`;
    resultsControls.hidden = true;
    return;
  }

  resultsControls.hidden = false;
  emptyState.hidden = sorted.length > 0;
  if (sorted.length === 0) {
    emptyState.querySelector('p').textContent = 'No results match your filter.';
  }

  sorted.forEach((facility) => {
    const li = document.createElement('li');
    li.className = 'result-card';
    li.innerHTML = `
      <div class="result-card-name">${facility.name}</div>
      ${facility.address ? `<div class="result-card-address">${facility.address}</div>` : ''}
      <span class="result-card-distance">${facility.distance_km} km</span>
    `;
    resultsList.appendChild(li);
  });

  plotResults(sorted);
}

// --- search flow ---

async function runSearch(originPoint, originLabel) {
  clearMessages();
  setLoading(true);

  try {
    origin = { lat: originPoint.lat, lng: originPoint.lng, label: originLabel };
    plotOrigin(origin.lat, origin.lng, origin.label);

    const facilityType = facilityTypeSelect.value;
    const results = await nearby(origin.lat, origin.lng, facilityType);

    allResults = results;
    setStatus(
      results.length > 0
        ? `Found ${results.length} ${FACILITY_LABELS[facilityType]}${results.length === 1 ? '' : 's'} near ${originLabel}.`
        : ''
    );
    renderResults();
  } catch (err) {
    allResults = [];
    renderResults();
    setError(err.message);
  } finally {
    setLoading(false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const address = addressInput.value.trim();
  if (!address) {
    setError('Please enter an address.');
    return;
  }

  clearMessages();
  setLoading(true);
  try {
    const geocoded = await geocode(address);
    await runSearch({ lat: geocoded.lat, lng: geocoded.lng }, geocoded.formatted);
  } catch (err) {
    setError(err.message);
    setLoading(false);
  }
});

locateBtn.addEventListener('click', async () => {
  clearMessages();
  setLoading(true);
  try {
    const position = await getCurrentLocation();
    await runSearch(position, 'your location');
  } catch (err) {
    setError(err.message);
    setLoading(false);
  }
});

filterInput.addEventListener('input', (event) => {
  currentFilter = event.target.value;
  renderResults();
});

sortButtons.forEach((button) => {
  button.addEventListener('click', () => {
    currentSort = button.id === 'sort-name' ? 'name' : 'distance';
    sortButtons.forEach((b) => b.classList.toggle('active', b === button));
    renderResults();
  });
});
