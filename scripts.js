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
// (the same source family HazardHunterPH uses). Drawn through the MapServer "export"
// operation and queried through the layer "query" operation.
const HAZARD_SERVICES = {
  flood: {
    name: 'Flood susceptibility',
    source: 'DENR-MGB via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/MGBPublic/Flood/MapServer',
    layerId: 0,
    opacity: 0.6,
    // Used if the service does not return coded-value domains.
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
  response: { label: 'Police / fire station', color: '#3978d4', icon: '✚' }
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
      ? '<div class="empty-list">Zoom in (or search a city, barangay or landmark) to load hospitals, police, fire stations and assembly points.</div>'
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
    <p>Community-mapped on OpenStreetMap and not verified. Confirm status with your LGU / DRRMO or the facility.</p>
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
  if (tags.emergency === 'assembly_point') return { type: 'evacuation', kind: 'Assembly / evacuation point (OSM)' };
  return null;
}

function addElements(elements) {
  let added = 0;
  elements.forEach(el => {
    const tags = el.tags || {};
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
  return `[out:json][timeout:25];(nwr["amenity"="hospital"](${bb});nwr["amenity"="police"](${bb});nwr["amenity"="fire_station"](${bb});nwr["emergency"="assembly_point"](${bb}););out center tags 500;`;
}

// Facility loading must not overwrite the status line while a route is on screen.
function setFacilityStatus(text) { if (!routeLayer) $('#mapStatus').textContent = text; }

async function loadFacilities() {
  if (!map) return;
  if (map.getZoom() < FACILITY_MIN_ZOOM) {
    setFacilityStatus( 'Zoom in to load hospitals, police, fire stations and assembly points · hazard layers cover the whole Philippines');
    renderLocationList(); updateStats();
    return;
  }
  const view = map.getBounds();
  if (fetchedAreas.some(area => area.contains(view))) { renderLocationList(); updateStats(); return; }
  const area = view.pad(0.25);
  const fetchId = ++facilityFetchId;
  setFacilityStatus( 'Loading facilities from OpenStreetMap…');
  try {
    const data = await overpass(facilityQuery(area));
    const added = addElements(data.elements || []);
    fetchedAreas.push(area);
    pruneMarkers();
    setFacilityStatus( `${placesInView().length} mapped facilities in view (${added} new) · OpenStreetMap, unverified`);
  } catch {
    setFacilityStatus( 'Facility data is temporarily unavailable (OpenStreetMap Overpass). Pan or zoom to retry.');
    showToast('Could not load facilities right now. Try again in a moment.');
  }
  renderLocationList(); updateStats();
}

function scheduleFacilityLoad() {
  clearTimeout(facilityTimer);
  facilityTimer = setTimeout(loadFacilities, 700);
}

/* ---------- Hazard overlays (ArcGIS MapServer export) ---------- */

function createHazardLayer(key) {
  const service = HAZARD_SERVICES[key];
  const ExportLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      const [nw, se] = this._tileCoordsToNwSe(coords).map(ll => this._map.options.crs.project(ll));
      const size = this.getTileSize();
      const params = new URLSearchParams({
        f: 'image', format: 'png32', transparent: 'true',
        bbox: `${nw.x},${se.y},${se.x},${nw.y}`,
        bboxSR: '3857', imageSR: '3857',
        size: `${size.x},${size.y}`, dpi: '96',
        layers: `show:${service.layerId}`
      });
      return `${service.base}/export?${params.toString()}`;
    }
  });
  const layer = new ExportLayer('', { opacity: service.opacity, tileSize: 256, minZoom: 5, maxZoom: 20, attribution: `${service.name}: ${service.source}` });
  layer.on('tileerror', () => {
    if (hazardErrorShown[key]) return;
    hazardErrorShown[key] = true;
    showToast(`${service.name} could not be loaded from the GeoRisk server. It may be offline.`);
  });
  layer.on('tileload', () => { hazardErrorShown[key] = false; });
  return layer;
}

// Legend: fetched live from the service, with a static fallback for flood.
async function loadLegend(key) {
  const service = HAZARD_SERVICES[key];
  try {
    const data = await fetchJSON(`${service.base}/legend?f=json`);
    const layer = (data.layers || []).find(item => item.layerId === service.layerId) || (data.layers || [])[0];
    const entries = (layer?.legend || []).filter(item => item.imageData).map(item => ({
      label: item.label || '', image: `data:${item.contentType || 'image/png'};base64,${item.imageData}`
    }));
    if (entries.length) return entries;
  } catch { /* fall through to fallback */ }
  return service.fallbackLegend;
}

async function renderHazardLegend() {
  const box = $('#hazardLegend');
  if (!box) return;
  const active = Object.keys(HAZARD_SERVICES).filter(key => document.querySelector(`[data-layer="${key}"]`)?.checked);
  if (!active.length) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  const sections = await Promise.all(active.map(async key => {
    HAZARD_SERVICES[key]._legend = HAZARD_SERVICES[key]._legend || await loadLegend(key);
    const rows = HAZARD_SERVICES[key]._legend.map(item => {
      const swatch = item.image ? `<img src="${item.image}" alt="" width="14" height="14">` : `<i style="background:${escapeHTML(item.color)}"></i>`;
      return `<li>${swatch}<span>${escapeHTML(item.label)}</span></li>`;
    }).join('');
    return `<div class="hz-legend-group"><b>${escapeHTML(HAZARD_SERVICES[key].name)}</b><ul>${rows || '<li><span>See HazardHunterPH for the legend.</span></li>'}</ul></div>`;
  }));
  box.innerHTML = sections.join('');
}

function setLayerVisibility() {
  if (!map) return;
  document.querySelectorAll('[data-layer]').forEach(input => {
    const key = input.dataset.layer;
    const targets = key in HAZARD_SERVICES
      ? [hazardOverlays[key]].filter(Boolean)
      : places.filter(place => place.type === key).map(place => markerById.get(place.id)).filter(Boolean);
    targets.forEach(layer => {
      if (input.checked && !map.hasLayer(layer)) layer.addTo(map);
      if (!input.checked && map.hasLayer(layer)) map.removeLayer(layer);
    });
  });
  renderHazardLegend();
}

/* ---------- Hazard check at a point ---------- */

function describeFeature(service, data, feature) {
  const system = /^(objectid|globalid|created_|last_edited_|shape|st_|orig_fid|gthcode)/i;
  const rows = [];
  (data.fields || []).forEach(field => {
    if (system.test(field.name)) return;
    let value = feature.attributes?.[field.name];
    if (value === null || value === undefined || value === '') return;
    const coded = field.domain?.codedValues?.find(item => String(item.code) === String(value));
    if (coded) value = coded.name;
    else if (service.valueLabels[String(value)]) value = service.valueLabels[String(value)];
    rows.push(String(value));
  });
  return rows;
}

async function queryHazard(key, lat, lng) {
  const service = HAZARD_SERVICES[key];
  const params = new URLSearchParams({
    f: 'json', where: '1=1', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false'
  });
  const data = await fetchJSON(`${service.base}/${service.layerId}/query?${params.toString()}`);
  if (data.error) throw new Error(data.error.message || 'Service error');
  const found = new Set();
  (data.features || []).forEach(feature => describeFeature(service, data, feature).forEach(row => found.add(row)));
  return { count: (data.features || []).length, rows: [...found] };
}

function hazardResultHTML(key, outcome) {
  const name = escapeHTML(HAZARD_SERVICES[key].name);
  if (outcome.status === 'rejected') {
    return `<div class="hz-row hz-unknown"><span>${name}</span><b>Could not check</b></div>`;
  }
  const { count, rows } = outcome.value;
  if (!count) return `<div class="hz-row hz-none"><span>${name}</span><b>No mapped zone here</b></div>`;
  const text = rows.length ? rows.map(escapeHTML).join(', ') : 'Inside a mapped susceptibility zone';
  return `<div class="hz-row hz-hit"><span>${name}</span><b>${text}</b></div>`;
}

async function checkHazards(latlng) {
  if (!map) return;
  const token = ++checkToken;
  const lat = latlng.lat, lng = latlng.lng;
  const head = `<strong>Hazard check</strong><small>${lat.toFixed(5)}, ${lng.toFixed(5)}</small>`;
  const popup = L.popup({ maxWidth: 290, className: 'hazard-popup' }).setLatLng(latlng)
    .setContent(`<div class="info-window">${head}<p>Checking GeoRisk hazard layers…</p></div>`).openOn(map);
  const keys = Object.keys(HAZARD_SERVICES);
  const outcomes = await Promise.allSettled(keys.map(key => queryHazard(key, lat, lng)));
  if (token !== checkToken || !popup.isOpen()) return;
  const failed = outcomes.every(item => item.status === 'rejected');
  const body = failed
    ? '<p>The hazard service could not be reached from this browser. Open HazardHunterPH for the official assessment.</p>'
    : keys.map((key, index) => hazardResultHTML(key, outcomes[index])).join('');
  popup.setContent(`<div class="info-window">${head}<div class="hz-results">${body}</div>
    <p class="hz-note">Regional-scale MGB susceptibility (about 1:50,000). “No mapped zone” does not mean safe. Not for site-specific decisions.</p>
    <a class="popup-route" href="${HAZARDHUNTER_URL}" target="_blank" rel="noopener">Full assessment on HazardHunterPH ↗</a></div>`);
}

/* ---------- Stats and map setup ---------- */

function updateStats() {
  const inView = placesInView();
  const count = type => String(inView.filter(p => p.type === type).length).padStart(2, '0');
  $('#evacCount').textContent = count('evacuation');
  $('#hospitalCount').textContent = count('hospital');
  $('#responseCount').textContent = count('response');
  $('#incidentCount').textContent = String(getIncidents().length).padStart(2, '0');
}

function initMap() {
  const loading = document.querySelector('.map-loading');
  if (!window.L) {
    loading.innerHTML = '<div class="map-error-icon">!</div><strong>Map library could not load</strong><span>Check your internet connection and reload the page.</span>';
    return;
  }

  map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).fitBounds(PH_BOUNDS);
  // Keyless basemaps. CARTO's public raster tiles now require an API key, so we use the
  // OpenStreetMap standard tiles (light, attributed use only) and Esri imagery as an option.
  // For production or high traffic, switch to a dedicated tile provider.
  const baseTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · Hazard data: <a href="https://hazardhunter.georisk.gov.ph/map" target="_blank" rel="noopener">DENR-MGB / GeoRisk PH</a>'
  }).addTo(map);
  const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics · Hazard data: DENR-MGB / GeoRisk PH'
  });
  L.control.layers({ 'Street map': baseTiles, 'Satellite': satelliteTiles }, null, { position: 'topright' }).addTo(map);

  let tileErrorShown = false;
  baseTiles.on('tileerror', () => {
    if (tileErrorShown) return;
    tileErrorShown = true;
    $('#mapStatus').textContent = 'Map tiles could not load. Check your internet connection or tile provider access.';
    showToast('The map background could not load. Please check your internet connection.');
  });
  baseTiles.once('load', () => {
    tileErrorShown = false;
    $('#mapStatus').textContent = DEFAULT_STATUS;
  });

  // Hazard overlays sit above the basemap but below markers.
  Object.keys(HAZARD_SERVICES).forEach(key => { hazardOverlays[key] = createHazardLayer(key); });

  map.on('click', event => checkHazards(event.latlng));
  // Popup buttons are created dynamically, so listen for them as they open.
  map.on('popupopen', event => {
    const button = event.popup.getElement()?.querySelector('[data-check-lat]');
    if (button) button.addEventListener('click', () => checkHazards(L.latLng(Number(button.dataset.checkLat), Number(button.dataset.checkLng))));
  });

  map.on('moveend', scheduleFacilityLoad);
  loading.remove();
  setLayerVisibility();
  renderLocationList();
  updateStats();
  setTimeout(() => map.invalidateSize(), 100);
}

/* ---------- Location, routing, search ---------- */

function locateUser() {
  return new Promise(resolve => {
    if (!map) { resolve(null); return; }
    if (!navigator.geolocation) { showToast('Location services are not supported by this browser.'); resolve(null); return; }
    showToast('Requesting your location…');
    navigator.geolocation.getCurrentPosition(position => {
      userPosition = [position.coords.latitude, position.coords.longitude];
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.circleMarker(userPosition, {
        radius: 9, color: '#fff', weight: 3, fillColor: '#2868c7', fillOpacity: 1, bubblingMouseEvents: false
      }).addTo(map).bindPopup('Your current location');
      map.setView(userPosition, 16);
      userMarker.openPopup();
      $('#mapStatus').textContent = 'Showing your current location';
      showToast('Your location is now shown on the map.');
      resolve(userPosition);
    }, error => {
      const messages = { 1: 'Location permission was denied.', 2: 'Your location is currently unavailable.', 3: 'Location request timed out.' };
      showToast(messages[error.code] || 'Unable to get your location.');
      resolve(null);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}

function haversineKm(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function findNearestCenter() {
  const origin = userPosition || await locateUser();
  if (!origin) return;
  $('#mapStatus').textContent = 'Looking for mapped assembly / evacuation points near you…';
  let nearest;
  try {
    const data = await overpass(`[out:json][timeout:25];nwr["emergency"="assembly_point"](around:15000,${origin[0]},${origin[1]});out center tags 100;`);
    addElements(data.elements || []);
    nearest = places.filter(place => place.type === 'evacuation')
      .map(place => ({ place, distance: haversineKm(origin, [place.position.lat, place.position.lng]) }))
      .sort((a, b) => a.distance - b.distance)[0];
  } catch {
    showToast('Could not search for evacuation points right now. Try again in a moment.');
    return;
  }
  if (!nearest || nearest.distance > 15) {
    $('#mapStatus').textContent = 'No assembly points are mapped within 15 km in OpenStreetMap.';
    showToast('None mapped within 15 km. Ask your barangay or city DRRMO for the official evacuation centers.');
    return;
  }

  const destination = [nearest.place.position.lat, nearest.place.position.lng];
  const url = `https://router.project-osrm.org/route/v1/driving/${origin[1]},${origin[0]};${destination[1]},${destination[0]}?overview=full&geometries=geojson`;
  $('#mapStatus').textContent = `Nearest mapped point: ${nearest.place.name} · ${nearest.distance.toFixed(1)} km straight-line`;
  showToast(`Finding a sample route to ${nearest.place.name}…`);
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }

  try {
    const data = await fetchJSON(url);
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route returned');
    const coordinates = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeLayer = L.polyline(coordinates, { color: '#2868c7', weight: 5, opacity: 0.88, interactive: false }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [55, 55] });
    selectPlace(nearest.place.id, false);
    const km = (data.routes[0].distance / 1000).toFixed(1);
    const mins = Math.round(data.routes[0].duration / 60);
    $('#mapStatus').textContent = `Sample route: ${km} km · about ${mins} min to ${nearest.place.name}`;
    showToast(`Route displayed: ${km} km, approximately ${mins} minutes.`);
  } catch {
    routeLayer = L.polyline([origin, destination], { color: '#2868c7', weight: 3, opacity: 0.8, dashArray: '8 8', interactive: false }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [55, 55] });
    selectPlace(nearest.place.id, false);
    $('#mapStatus').textContent = `Route service unavailable · straight-line guide to ${nearest.place.name} (${nearest.distance.toFixed(1)} km)`;
    showToast('Road routing is unavailable right now. Showing a straight-line guide instead.');
  }
}

// Place-name search across the Philippines (OpenStreetMap Nominatim, on Enter only per its usage policy).
async function searchPlaces() {
  const query = $('#mapSearch').value.trim();
  if (query.length < 2) return;
  $('#mapStatus').textContent = `Searching the Philippines for “${query}”…`;
  try {
    const params = new URLSearchParams({ format: 'jsonv2', countrycodes: 'ph', limit: '6', addressdetails: '0', q: query });
    const data = await fetchJSON(`${NOMINATIM_URL}?${params.toString()}`);
    geoResults = data.map(item => ({
      name: item.name || item.display_name.split(',')[0],
      detail: item.display_name,
      lat: Number(item.lat), lng: Number(item.lon),
      bounds: item.boundingbox ? [[Number(item.boundingbox[0]), Number(item.boundingbox[2])], [Number(item.boundingbox[1]), Number(item.boundingbox[3])]] : null
    }));
    renderLocationList();
    if (!geoResults.length) { $('#mapStatus').textContent = `No place found for “${query}” in the Philippines.`; return; }
    $('#mapStatus').textContent = `${geoResults.length} result(s) · opening the best match`;
    goToGeoResult(geoResults[0]);
  } catch {
    $('#mapStatus').textContent = 'Place search is unavailable right now. Try again in a moment.';
    showToast('Place search could not be reached.');
  }
}

function goToGeoResult(item) {
  if (!item || !map) return;
  if (item.bounds) map.fitBounds(item.bounds, { maxZoom: 15, padding: [30, 30] });
  else map.setView([item.lat, item.lng], 14);
  $('#sidebar').classList.remove('sidebar-open');
  $('#mapStatus').textContent = `${item.name} · click the map to check hazards at any point`;
}

/* ---------- Incident reports ---------- */

function openReportModal() {
  $('#reportModal').classList.add('open');
  $('#reportModal').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#incidentType').focus(), 80);
}
function closeReportModal() {
  $('#reportModal').classList.remove('open');
  $('#reportModal').setAttribute('aria-hidden', 'true');
}

function submitIncident(event) {
  event.preventDefault();
  const incident = {
    id: Date.now(), type: $('#incidentType').value,
    location: $('#incidentLocation').value.trim(),
    description: $('#incidentDescription').value.trim(),
    createdAt: new Date().toISOString()
  };
  const incidents = getIncidents();
  incidents.unshift(incident);
  if (!saveIncidents(incidents)) return;
  updateStats();
  $('#incidentForm').reset();
  closeReportModal();
  showToast('Incident report saved on this device only.');
}

function resetMap() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  map.fitBounds(PH_BOUNDS);
  map.closePopup();
  activePlaceId = null;
  geoResults = [];
  $('#mapSearch').value = '';
  renderLocationList();
  $('#mapStatus').textContent = DEFAULT_STATUS;
}

function setupUI() {
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', setLayerVisibility));
  $('#mapSearch').addEventListener('input', () => { if (!$('#mapSearch').value) geoResults = []; renderLocationList(); });
  $('#mapSearch').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searchPlaces(); } });
  $('#locateMe').addEventListener('click', locateUser);
  $('#findNearest').addEventListener('click', findNearestCenter);
  $('#resetMap').addEventListener('click', () => map && resetMap());
  $('#showAll').addEventListener('click', () => {
    $('#mapSearch').value = '';
    geoResults = [];
    renderLocationList();
  });
  $('#openReport').addEventListener('click', openReportModal);
  $('#closeReport').addEventListener('click', closeReportModal);
  $('#cancelReport').addEventListener('click', closeReportModal);
  $('#incidentForm').addEventListener('submit', submitIncident);
  $('#reportModal').addEventListener('click', event => { if (event.target === $('#reportModal')) closeReportModal(); });
  $('#openSidebar').addEventListener('click', () => $('#sidebar').classList.add('sidebar-open'));
  $('#closeSidebar').addEventListener('click', () => $('#sidebar').classList.remove('sidebar-open'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeReportModal();
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      event.preventDefault(); $('#mapSearch').focus();
    }
  });
  updateStats();
}

document.addEventListener('DOMContentLoaded', () => {
  setupUI();
  initMap();
});