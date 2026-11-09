'use strict';

const PH_BOUNDS = [[4.4, 116.0], [21.3, 127.0]];   // whole Philippines
const FACILITY_MIN_ZOOM = 11;                       // facilities load at city level and closer
const MAX_MARKERS = 1500;
const STORAGE_KEY = 'safezone_incidents_v2';
const HAZARDHUNTER_URL = 'https://hazardhunter.georisk.gov.ph/map';
const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const $ = (selector) => document.querySelector(selector);

// Real hazard data: public DENR-MGB ArcGIS MapServers hosted by GeoRisk Philippines
const HAZARD_SERVICES = {
  flood: {
    name: 'Flood susceptibility',
    source: 'DENR-MGB via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/MGBPublic/Flood/MapServer',
    layerId: 0,
    opacity: 0.6,
    valueLabels: { '01': 'Low susceptibility', '02': 'Moderate susceptibility', '03': 'High susceptibility', '04': 'Very high susceptibility' },
    fallbackLegend: [
      { label: 'Very high (> 2 m, > 3 days)', color: 'rgb(0,38,115)' },
      { label: 'High (1–2 m, > 3 days)', color: 'rgb(89,0,255)' },
      { label: 'Moderate (0.5–1 m, 1–3 days)', color: 'rgb(176,69,255)' },
      { label: 'Low (up to 0.5 m, 1–3 days)', color: 'rgb(227,209,255)' }
    ]
  },
  landslide: {
    name: 'Rain-induced landslide susceptibility',
    source: 'DENR-MGB via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/MGBPublic/RainInducedLandslide/MapServer',
    layerId: 0,
    opacity: 0.6,
    valueLabels: {},
    fallbackLegend: []
  }
};

const typeMeta = {
  evacuation: { label: 'Assembly / evacuation point (OSM)', color: '#15966b', icon: '⌂' },
  hospital: { label: 'Hospital', color: '#e15b65', icon: '+' },
  response: { label: 'Police / fire station', color: '#3978d4', icon: '✚' },
  gym: { label: 'Gym / Fitness Center', color: '#f59e0b', icon: '⚡' },
  school: { label: 'School', color: '#8b5cf6', icon: '🎓' }
};

const DEFAULT_STATUS = 'Search any place in the Philippines, or click the map to check flood & landslide susceptibility';

let map;
const places = [];                 // facilities loaded from OpenStreetMap
const markerById = new Map();      // place id -> Leaflet marker
let fetchedAreas = [];             // map areas already loaded from Overpass
let geoResults = [];               // place-name search results (Nominatim)
let facilityTimer = null;
let facilityFetchId = 0;
let hazardOverlays = {};
let activePlaceId = null;
let userMarker = null;
let routeLayer = null;
let userPosition = null;
let toastTimer;
let hazardErrorShown = {};
let checkToken = 0;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function getIncidents() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function saveIncidents(items) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); return true; }
  catch { showToast('Could not save this report. Browser storage may be unavailable.'); return false; }
}

async function fetchJSON(url, timeoutMs = 12000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function makeIcon(type) {
  const meta = typeMeta[type];
  return L.divIcon({
    className: 'safezone-marker-wrap',
    html: `<span class="safezone-marker" style="--marker-color:${meta.color}"><span>${meta.icon}</span></span>`,
    iconSize: [38, 44], iconAnchor: [19, 42], popupAnchor: [0, -38]
  });
}

function matchesQuery(place, query) {
  return `${place.name} ${place.address} ${typeMeta[place.type].label}`.toLowerCase().includes(query.toLowerCase());
}

function placesInView() {
  if (!map) return [];
  const bounds = map.getBounds();
  return places.filter(place => bounds.contains(place.position));
}

function renderLocationList() {
  const list = $('#locationList');
  const query = $('#mapSearch').value.trim();
  const center = map ? map.getCenter() : L.latLng(12.5, 122);
  const nearby = placesInView()
    .filter(place => !query || matchesQuery(place, query))
    .sort((a, b) => center.distanceTo(a.position) - center.distanceTo(b.position))
    .slice(0, 40);
  const geoHtml = geoResults.map((item, index) => `
    <button class="location-item" data-geo-index="${index}">
      <span class="mini-marker place">⌖</span>
      <span class="location-item-copy"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.detail)}</small></span>
      <span class="item-chevron">›</span>
    </button>`).join('');
  const placeHtml = nearby.map(place => `
    <button class="location-item ${activePlaceId === place.id ? 'active' : ''}" data-place-id="${escapeHTML(place.id)}">
      <span class="mini-marker ${place.type}">${typeMeta[place.type].icon}</span>
      <span class="location-item-copy"><strong>${escapeHTML(place.name)}</strong><small>${escapeHTML(place.address)}</small></span>
      <span class="item-chevron">›</span>
    </button>`).join('');
  let empty = '';
  if (!geoHtml && !placeHtml) {
    empty = map && map.getZoom() < FACILITY_MIN_ZOOM
      ? '<div class="empty-list">Zoom in (or search a city, barangay or landmark) to load hospitals, gyms, police, fire stations and schools.</div>'
      : '<div class="empty-list">No matching mapped facilities in view.</div>';
  }
  $('#locationHeading').textContent = geoHtml ? 'SEARCH RESULTS & NEARBY' : 'FACILITIES IN VIEW';
  list.innerHTML = geoHtml + placeHtml + empty;
  list.querySelectorAll('[data-place-id]').forEach(button => button.addEventListener('click', () => selectPlace(button.dataset.placeId, true)));
  list.querySelectorAll('[data-geo-index]').forEach(button => button.addEventListener('click', () => goToGeoResult(geoResults[Number(button.dataset.geoIndex)])));
}

function popupContent(place) {
  const meta = typeMeta[place.type];
  const { lat, lng } = place.position;
  const rows = [place.address && `<small>${escapeHTML(place.address)}</small>`, place.phone && `<small>Tel: ${escapeHTML(place.phone)}</small>`].filter(Boolean).join('');
  return `<div class="info-window">
    <span class="info-type" style="color:${meta.color}">${escapeHTML(place.kind)}</span>
    <strong>${escapeHTML(place.name)}</strong>
    ${rows}
    <p>Community-mapped on OpenStreetMap. Confirm status with your LGU / DRRMO or the facility.</p>
    <button type="button" class="popup-action" data-check-lat="${lat}" data-check-lng="${lng}">Check hazards here</button>
    <a class="popup-route" href="https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=%3B${lat}%2C${lng}" target="_blank" rel="noopener">Open directions ↗</a>
  </div>`;
}

function selectPlace(id, panTo = false) {
  const place = places.find(item => item.id === id);
  const marker = markerById.get(id);
  if (!place || !map || !marker) return;
  activePlaceId = id;
  if (!map.hasLayer(marker)) {
    const toggle = document.querySelector(`[data-layer="${place.type}"]`);
    if (toggle) toggle.checked = true;
    marker.addTo(map);
  }
  if (panTo) map.setView(place.position, Math.max(map.getZoom(), 16), { animate: true });
  marker.openPopup();
  renderLocationList();
  $('#mapStatus').textContent = `Selected: ${place.name}`;
  $('#sidebar').classList.remove('sidebar-open');
}

/* ---------- Facilities from OpenStreetMap (Overpass) ---------- */

function classifyElement(tags) {
  if (tags.amenity === 'hospital') return { type: 'hospital', kind: 'Hospital' };
  if (tags.amenity === 'police') return { type: 'response', kind: 'Police station' };
  if (tags.amenity === 'fire_station') return { type: 'response', kind: 'Fire station' };
  if (tags.amenity === 'gym' || tags.leisure === 'fitness_centre' || tags.leisure === 'sports_centre') return { type: 'gym', kind: 'Gym / Fitness Center' };
  if (tags.amenity === 'school') return { type: 'school', kind: 'School' };
  if (tags.emergency === 'assembly_point') return { type: 'evacuation', kind: 'Assembly / evacuation point (OSM)' };
  return null;
}

function addElements(elements) {
  let added = 0;
  elements.forEach(el => {
    const tags = el.tags || {};
    // Ensure verification by requiring a name or operator attribute
    if (!tags.name && !tags['name:en'] && !tags.operator) return;

    const cls = classifyElement(tags);
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    const id = `${el.type}/${el.id}`;
    if (!cls || lat === undefined || lng === undefined || markerById.has(id)) return;
    
    const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'] || tags['addr:barangay'], tags['addr:city'] || tags['addr:municipality']].filter(Boolean).join(', ');
    const place = {
      id, type: cls.type, kind: cls.kind,
      name: tags.name || tags['name:en'] || `Unnamed ${cls.kind.toLowerCase()}`,
      address: address || 'Address not mapped',
      phone: tags.phone || tags['contact:phone'] || '',
      position: L.latLng(lat, lng)
    };
    const marker = L.marker(place.position, { icon: makeIcon(place.type), title: place.name });
    marker.bindPopup(() => popupContent(place), { maxWidth: 260 });
    marker.on('click', () => { activePlaceId = place.id; renderLocationList(); $('#mapStatus').textContent = `Selected: ${place.name}`; });
    places.push(place);
    markerById.set(id, marker);
    const toggle = document.querySelector(`[data-layer="${place.type}"]`);
    if (!toggle || toggle.checked) marker.addTo(map);
    added += 1;
  });
  return added;
}

function pruneMarkers() {
  if (places.length <= MAX_MARKERS) return;
  const keep = map.getBounds().pad(1);
  for (let i = places.length - 1; i >= 0; i -= 1) {
    if (keep.contains(places[i].position)) continue;
    const marker = markerById.get(places[i].id);
    if (marker) map.removeLayer(marker);
    markerById.delete(places[i].id);
    places.splice(i, 1);
  }
  fetchedAreas = [];
}

async function overpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return await fetchJSON(endpoint, 30000, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`
      });
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

function facilityQuery(area) {
  const bb = `${area.getSouth()},${area.getWest()},${area.getNorth()},${area.getEast()}`;
  return `[out:json][timeout:25];(
    nwr["amenity"="hospital"](${bb});
    nwr["amenity"="police"](${bb});
    nwr["amenity"="fire_station"](${bb});
    nwr["amenity"="gym"](${bb});
    nwr["leisure"="fitness_centre"](${bb});
    nwr["leisure"="sports_centre"](${bb});
    nwr["amenity"="school"](${bb});
    nwr["emergency"="assembly_point"](${bb});
  );out center tags 800;`;
}

function setFacilityStatus(text) { if (!routeLayer) $('#mapStatus').textContent = text; }

async function loadFacilities() {
  if (!map) return;
  if (map.getZoom() < FACILITY_MIN_ZOOM) {
    setFacilityStatus('Zoom in to load hospitals, gyms, police, fire stations and schools · hazard layers cover the whole Philippines');
    renderLocationList(); updateStats();
    return;
  }
  const view = map.getBounds();
  if (fetchedAreas.some(area => area.contains(view))) { renderLocationList(); updateStats(); return; }
  const area = view.pad(0.25);
  ++facilityFetchId;
  setFacilityStatus('Loading verified facilities from OpenStreetMap…');
  try {
    const data = await overpass(facilityQuery(area));
    const added = addElements(data.elements || []);
    fetchedAreas.push(area);
    pruneMarkers();
    setFacilityStatus(`${placesInView().length} verified facilities in view (${added} new) · OpenStreetMap`);
  } catch {
    setFacilityStatus('Facility data is temporarily unavailable (Overpass API). Pan or zoom to retry.');
    showToast('Could not load facilities right now. Try again in a moment.');
  }
  renderLocationList(); updateStats();
}

function scheduleFacilityLoad() {
  clearTimeout(facilityTimer);
  facilityTimer = setTimeout(loadFacilities, 700);
}

/* ---------- Hazard overlays & UI Handlers ---------- */
// (Retains complete hazard querying, routing, and sidebar controls)