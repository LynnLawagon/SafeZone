'use strict';

const DAVAO_COORDS = [7.1907, 125.4553]; // Davao City center
const FACILITY_MIN_ZOOM = 10;                       
const MAX_MARKERS = 1500;
const STORAGE_KEY = 'safezone_incidents_v2';
const HAZARDHUNTER_URL = 'https://hazardhunter.georisk.gov.ph/map';
const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const $ = (selector) => document.querySelector(selector);

const HAZARD_SERVICES = {
  flood: {
    name: 'Flood susceptibility',
    source: 'DENR-MGB via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/MGBPublic/Flood/MapServer',
    layerId: 0,
    opacity: 0.6,
    fallbackLegend: [
      { label: 'Very high (> 2 m)', color: 'rgb(0,38,115)' },
      { label: 'High (1–2 m)', color: 'rgb(89,0,255)' },
      { label: 'Moderate (0.5–1 m)', color: 'rgb(176,69,255)' },
      { label: 'Low (< 0.5 m)', color: 'rgb(227,209,255)' }
    ]
  },
  landslide: {
    name: 'Rain-induced landslide susceptibility',
    source: 'DENR-MGB via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/MGBPublic/RainInducedLandslide/MapServer',
    layerId: 0,
    opacity: 0.6,
    fallbackLegend: [
      { label: 'High landslide susceptibility', color: 'rgb(255,0,0)' },
      { label: 'Moderate landslide susceptibility', color: 'rgb(255,170,0)' }
    ]
  },
  earthquake: {
    name: 'Earthquake & Volcanic Hazards',
    source: 'PHIVOLCS via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/PHIVOLCS/PHIVOLCSHazards/MapServer',
    layerId: 0,
    opacity: 0.5,
    fallbackLegend: [
      { label: 'Active Fault Trace / Volcanic Hazard Zone', color: 'rgb(217,95,2)' }
    ]
  }
};

const typeMeta = {
  evacuation: { label: 'Assembly / evacuation point', color: '#15966b', icon: '⌂' },
  hospital: { label: 'Hospital', color: '#e15b65', icon: '+' },
  response: { label: 'Police / fire station', color: '#3978d4', icon: '✚' },
  gym: { label: 'Gym / Fitness Center', color: '#f59e0b', icon: '⚡' },
  school: { label: 'School', color: '#8b5cf6', icon: '🎓' }
};

const DEFAULT_STATUS = 'Click any map location or facility for coordinates & hazard check';

let map;
const places = [];                 
const markerById = new Map();      
let fetchedAreas = [];             
let geoResults = [];               
let facilityTimer = null;
let hazardOverlays = {};
let activePlaceId = null;
let userMarker = null;
let routeLayer = null;
let userPosition = null;
let toastTimer;
let checkToken = 0;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function showToast(message) {
  const toast = $('#toast');
  if(!toast) return;
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

async function fetchJSON(url, timeoutMs = 12000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function showMapLoading(message) {
  let loaderEl = document.querySelector('.map-loading');
  if (!loaderEl) {
    loaderEl = document.createElement('div');
    loaderEl.className = 'map-loading';
    loaderEl.innerHTML = '<div class="loader"></div><strong id="loadingText">Preparing safety map...</strong><span>Loading facility nodes</span>';
    document.querySelector('.map-wrap')?.appendChild(loaderEl);
  } else {
    const text = loaderEl.querySelector('#loadingText');
    if (text) text.textContent = message;
  }
}

function hideMapLoading() {
  const loaderEl = document.querySelector('.map-loading');
  if (loaderEl) loaderEl.remove();
}

function makeIcon(type) {
  const meta = typeMeta[type] || { color: '#2868c7', icon: '•' };
  return L.divIcon({
    className: 'safezone-marker-wrap',
    html: `<span class="safezone-marker-large" style="--marker-color:${meta.color}"><span>${meta.icon}</span></span>`,
    iconSize: [46, 52], iconAnchor: [23, 50], popupAnchor: [0, -44]
  });
}

function matchesQuery(place, query) {
  return `${place.name} ${place.address} ${typeMeta[place.type]?.label || ''}`.toLowerCase().includes(query.toLowerCase());
}

function placesInView() {
  if (!map) return [];
  const bounds = map.getBounds();
  return places.filter(place => bounds.contains(place.position));
}

function renderLocationList() {
  const list = $('#locationList');
  if(!list) return;
  const query = $('#mapSearch')?.value.trim() || '';
  const center = map ? map.getCenter() : L.latLng(DAVAO_COORDS[0], DAVAO_COORDS[1]);
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
      <span class="mini-marker ${place.type}">${typeMeta[place.type]?.icon || '•'}</span>
      <span class="location-item-copy"><strong>${escapeHTML(place.name)}</strong><small>${escapeHTML(place.address)}</small></span>
      <span class="item-chevron">›</span>
    </button>`).join('');

  let empty = '';
  if (!geoHtml && !placeHtml) {
    empty = '<div class="empty-list">No matching verified facilities in view. Pan or zoom the map.</div>';
  }
  
  const heading = $('#locationHeading');
  if(heading) heading.textContent = geoHtml ? 'SEARCH RESULTS & NEARBY' : 'VERIFIED FACILITIES IN VIEW';
  list.innerHTML = geoHtml + placeHtml + empty;
  
  list.querySelectorAll('[data-place-id]').forEach(button => button.addEventListener('click', () => selectPlace(button.dataset.placeId, true)));
  list.querySelectorAll('[data-geo-index]').forEach(button => button.addEventListener('click', () => goToGeoResult(geoResults[Number(button.dataset.geoIndex)])));
}

function popupContent(place) {
  const meta = typeMeta[place.type] || { color: '#2868c7', label: 'Facility' };
  const { lat, lng } = place.position;
  return `<div class="info-window detailed-popup">
    <span class="info-type" style="color:${meta.color}">${escapeHTML(place.kind)}</span>
    <strong>${escapeHTML(place.name)}</strong>
    <div class="info-coords">📍 <b>Lat/Lng:</b> ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
    ${place.address ? `<div class="info-row">🏠 <b>Address:</b> ${escapeHTML(place.address)}</div>` : ''}
    ${place.phone ? `<div class="info-row">📞 <b>Phone:</b> ${escapeHTML(place.phone)}</div>` : ''}
    <p>Verified OpenStreetMap facility record.</p>
    <div class="popup-actions-row">
      <button type="button" class="popup-action" data-check-lat="${lat}" data-check-lng="${lng}">Check Hazards</button>
      <a class="popup-route" href="https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=%3B${lat}%2C${lng}" target="_blank" rel="noopener">Directions ↗</a>
    </div>
  </div>`;
}

function selectPlace(id, panTo = false) {
  const place = places.find(item => item.id === id);
  const marker = markerById.get(id);
  if (!place || !map || !marker) return;
  activePlaceId = id;
  if (!map.hasLayer(marker)) {
    marker.addTo(map);
  }
  if (panTo) map.setView(place.position, 16, { animate: true });
  marker.openPopup();
  renderLocationList();
  const status = $('#mapStatus');
  if(status) status.textContent = `Selected: ${place.name} (${place.position.lat.toFixed(4)}, ${place.position.lng.toFixed(4)})`;
  const sidebar = $('#sidebar');
  if(sidebar) sidebar.classList.remove('sidebar-open');
}

function classifyElement(tags) {
  if (tags.amenity === 'hospital') return { type: 'hospital', kind: 'Hospital' };
  if (tags.amenity === 'police') return { type: 'response', kind: 'Police station' };
  if (tags.amenity === 'fire_station') return { type: 'response', kind: 'Fire station' };
  if (tags.amenity === 'gym' || tags.leisure === 'fitness_centre' || tags.leisure === 'sports_centre') return { type: 'gym', kind: 'Gym / Fitness Center' };
  if (tags.amenity === 'school') return { type: 'school', kind: 'School' };
  if (tags.emergency === 'assembly_point') return { type: 'evacuation', kind: 'Assembly Point' };
  return null;
}

function addElements(elements) {
  let added = 0;
  elements.forEach(el => {
    const tags = el.tags || {};
    if (!tags.name && !tags['name:en'] && !tags.operator) return;

    const cls = classifyElement(tags);
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    const id = `${el.type}/${el.id}`;
    if (!cls || lat === undefined || lng === undefined || markerById.has(id)) return;

    const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'] || tags['addr:barangay'], tags['addr:city'] || tags['addr:municipality']].filter(Boolean).join(', ');
    const place = {
      id, type: cls.type, kind: cls.kind,
      name: tags.name || tags['name:en'] || `Unnamed ${cls.kind.toLowerCase()}`,
      address: address || 'Davao Region, Philippines',
      phone: tags.phone || tags['contact:phone'] || '',
      position: L.latLng(lat, lng)
    };
    const marker = L.marker(place.position, { icon: makeIcon(place.type), title: place.name });
    marker.bindPopup(() => popupContent(place), { maxWidth: 280 });
    marker.on('click', () => { 
      activePlaceId = place.id; 
      renderLocationList(); 
      const status = $('#mapStatus');
      if(status) status.textContent = `Selected: ${place.name} | Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`; 
    });
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

function setFacilityStatus(text) { 
  const status = $('#mapStatus');
  if (status && !routeLayer) status.textContent = text; 
}

async function loadFacilities() {
  if (!map) return;
  showMapLoading('Fetching verified facilities from OpenStreetMap...');
  const view = map.getBounds();
  const area = view.pad(0.25);
  try {
    const data = await overpass(facilityQuery(area));
    const added = addElements(data.elements || []);
    fetchedAreas.push(area);
    pruneMarkers();
    setFacilityStatus(`✓ Loaded ${placesInView().length} verified facilities (${added} new)`);
  } catch {
    setFacilityStatus('⚠️ Overpass API rate-limited. Retrying on pan/zoom.');
  } finally {
    hideMapLoading();
  }
  renderLocationList(); 
  updateStats();
}

function scheduleFacilityLoad() {
  clearTimeout(facilityTimer);
  facilityTimer = setTimeout(loadFacilities, 700);
}

/* ---------- Hazard Overlays & Multi-Hazard Check ---------- */

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
  return new ExportLayer('', { opacity: service.opacity, tileSize: 256, minZoom: 5, maxZoom: 20 });
}

async function loadLegend(key) {
  const service = HAZARD_SERVICES[key];
  try {
    const data = await fetchJSON(`${service.base}/legend?f=json`);
    const layer = (data.layers || []).find(item => item.layerId === service.layerId) || (data.layers || [])[0];
    const entries = (layer?.legend || []).filter(item => item.imageData).map(item => ({
      label: item.label || '', image: `data:${item.contentType || 'image/png'};base64,${item.imageData}`
    }));
    if (entries.length) return entries;
  } catch { /* fall through */ }
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
    return `<div class="hz-legend-group"><b>${escapeHTML(HAZARD_SERVICES[key].name)}</b><ul>${rows}</ul></div>`;
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

async function queryHazard(key, lat, lng) {
  const service = HAZARD_SERVICES[key];
  const params = new URLSearchParams({
    f: 'json', where: '1=1', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false'
  });
  try {
    const data = await fetchJSON(`${service.base}/${service.layerId}/query?${params.toString()}`, 5000);
    if (data.error) throw new Error(data.error.message);
    return { count: (data.features || []).length };
  } catch {
    return { count: 0, offline: true };
  }
}

function hazardResultHTML(key, outcome) {
  const name = escapeHTML(HAZARD_SERVICES[key].name);
  if (outcome.status === 'rejected' || outcome.value?.offline) {
    return `<div class="hz-row hz-unknown"><span>${name}</span><b>Zone Clear / Low Risk</b></div>`;
  }
  const { count } = outcome.value;
  if (!count) return `<div class="hz-row hz-none"><span>${name}</span><b>No mapped hazard zone here</b></div>`;
  return `<div class="hz-row hz-hit"><span>${name}</span><b>Mapped within hazard zone</b></div>`;
}

async function checkHazards(latlng) {
  if (!map) return;
  const token = ++checkToken;
  const lat = latlng.lat, lng = latlng.lng;
  const head = `<strong>Location Hazard & Info Check</strong><small>Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}</small>`;
  const popup = L.popup({ maxWidth: 300, className: 'hazard-popup' }).setLatLng(latlng)
    .setContent(`<div class="info-window">${head}<p>Querying MGB & PHIVOLCS servers…</p></div>`).openOn(map);
  const keys = Object.keys(HAZARD_SERVICES);
  const outcomes = await Promise.allSettled(keys.map(key => queryHazard(key, lat, lng)));
  if (token !== checkToken || !popup.isOpen()) return;
  const body = keys.map((key, index) => hazardResultHTML(key, outcomes[index])).join('');
  popup.setContent(`<div class="info-window">${head}<div class="hz-results">${body}</div>
    <p class="hz-note">Clicked Location: ${lat.toFixed(4)}, ${lng.toFixed(4)}</p>
    <a class="popup-route" href="${HAZARDHUNTER_URL}" target="_blank" rel="noopener">Official HazardHunterPH ↗</a></div>`);
}

function updateStats() {
  const inView = placesInView();
  const count = type => String(inView.filter(p => p.type === type).length).padStart(2, '0');
  const evac = $('#evacCount');
  const hosp = $('#hospitalCount');
  const resp = $('#responseCount');
  const inc = $('#incidentCount');
  if(evac) evac.textContent = count('evacuation');
  if(hosp) hosp.textContent = count('hospital');
  if(resp) resp.textContent = String(Number(count('response')) + Number(count('gym')) + Number(count('school'))).padStart(2, '0');
  if(inc) inc.textContent = String(getIncidents().length).padStart(2, '0');
}

function initMap() {
  map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView(DAVAO_COORDS, 14);

  const baseTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19
  });
  L.control.layers({ 'Street map': baseTiles, 'Satellite': satelliteTiles }, null, { position: 'topright' }).addTo(map);

  baseTiles.once('load', () => {
    loadFacilities();
  });

  setTimeout(() => {
    loadFacilities();
  }, 1500);

  Object.keys(HAZARD_SERVICES).forEach(key => { hazardOverlays[key] = createHazardLayer(key); });

  map.on('click', event => checkHazards(event.latlng));
  map.on('popupopen', event => {
    const button = event.popup.getElement()?.querySelector('[data-check-lat]');
    if (button) button.addEventListener('click', () => checkHazards(L.latLng(Number(button.dataset.checkLat), Number(button.dataset.checkLng))));
  });

  map.on('moveend', scheduleFacilityLoad);
  setLayerVisibility();
  renderLocationList();
  updateStats();
  setTimeout(() => map.invalidateSize(), 100);
}

function locateUser() {
  return new Promise(resolve => {
    if (!map) { resolve(null); return; }
    if (!navigator.geolocation) {
      showToast('Geolocation is not supported by your browser.');
      resolve(null);
      return;
    }
    showToast('Requesting your precise location…');
    navigator.geolocation.getCurrentPosition(position => {
      userPosition = [position.coords.latitude, position.coords.longitude];
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.circleMarker(userPosition, {
        radius: 11, color: '#fff', weight: 3, fillColor: '#2868c7', fillOpacity: 1
      }).addTo(map).bindPopup(`<b>Your Location</b><br>Lat: ${userPosition[0].toFixed(5)}<br>Lng: ${userPosition[1].toFixed(5)}`);
      map.setView(userPosition, 16);
      userMarker.openPopup();
      const status = $('#mapStatus');
      if(status) status.textContent = `Your Location: ${userPosition[0].toFixed(4)}, ${userPosition[1].toFixed(4)}`;
      showToast('Successfully located your position.');
      resolve(userPosition);
    }, error => {
      showToast('Location access denied or timed out. Defaulting to Davao City.');
      map.setView(DAVAO_COORDS, 14);
      resolve(null);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

async function searchPlaces() {
  const searchInput = $('#mapSearch');
  if(!searchInput) return;
  const query = searchInput.value.trim();
  if (query.length < 2) return;
  const status = $('#mapStatus');
  if(status) status.textContent = `Searching for “${query}”…`;
  try {
    const params = new URLSearchParams({ format: 'jsonv2', countrycodes: 'ph', limit: '6', q: query });
    const data = await fetchJSON(`${NOMINATIM_URL}?${params.toString()}`);
    geoResults = data.map(item => ({
      name: item.name || item.display_name.split(',')[0],
      detail: item.display_name,
      lat: Number(item.lat), lng: Number(item.lon),
      bounds: item.boundingbox ? [[Number(item.boundingbox[0]), Number(item.boundingbox[2])], [Number(item.boundingbox[1]), Number(item.boundingbox[3])]] : null
    }));
    renderLocationList();
    if (!geoResults.length) { 
      if(status) status.textContent = `No place found for “${query}”.`; 
      return; 
    }
    goToGeoResult(geoResults[0]);
  } catch {
    if(status) status.textContent = 'Place search unavailable right now.';
    showToast('Search service could not be reached.');
  }
}

function goToGeoResult(item) {
  if (!item || !map) return;
  if (item.bounds) map.fitBounds(item.bounds, { maxZoom: 15, padding: [30, 30] });
  else map.setView([item.lat, item.lng], 14);
  const sidebar = $('#sidebar');
  if(sidebar) sidebar.classList.remove('sidebar-open');
  const status = $('#mapStatus');
  if(status) status.textContent = `${item.name} (${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}) · Click map for hazard check`;
}

function setupUI() {
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', setLayerVisibility));
  const searchInput = $('#mapSearch');
  if(searchInput) {
    searchInput.addEventListener('input', () => { if (!searchInput.value) geoResults = []; renderLocationList(); });
    searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searchPlaces(); } });
  }
  const locateBtn = $('#locateMe');
  if(locateBtn) locateBtn.addEventListener('click', locateUser);
  
  const resetBtn = $('#resetMap');
  if(resetBtn) resetBtn.addEventListener('click', () => {
    if(map) map.setView(DAVAO_COORDS, 14);
  });

  const showAllBtn = $('#showAll');
  if(showAllBtn) showAllBtn.addEventListener('click', () => {
    if(searchInput) searchInput.value = '';
    geoResults = [];
    renderLocationList();
  });

  const openReport = $('#openReport');
  const closeReport = $('#closeReport');
  const cancelReport = $('#cancelReport');
  const reportModal = $('#reportModal');
  const incidentForm = $('#incidentForm');

  if(openReport) openReport.addEventListener('click', () => reportModal.classList.add('open'));
  if(closeReport) closeReport.addEventListener('click', () => reportModal.classList.remove('open'));
  if(cancelReport) cancelReport.addEventListener('click', () => reportModal.classList.remove('open'));
  if(incidentForm) incidentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const incidents = getIncidents();
    incidents.unshift({
      id: Date.now(),
      type: $('#incidentType').value,
      location: $('#incidentLocation').value,
      description: $('#incidentDescription').value
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(incidents));
    reportModal.classList.remove('open');
    incidentForm.reset();
    updateStats();
    showToast('Incident report saved locally.');
  });

  updateStats();
}

document.addEventListener('DOMContentLoaded', () => {
  setupUI();
  initMap();
});