'use strict';

const PH_BOUNDS = [[4.4, 116.0], [21.3, 127.0]];   // whole Philippines
const FACILITY_MIN_ZOOM = 13;                       // facilities load at neighbourhood level
const CELL = 0.1;                                   // loading grid (degrees, about 11 km)
const MAX_CELLS = 30;                               // never queue more than this many cells for one view
const CELL_LIMIT = 800;                             // max records requested per cell
const MAX_MARKERS = 4000;
const RETRY_AFTER_MS = 45000;                       // do not hammer a failing server
const OFFICIAL_JSON_URL = 'data/official-facilities.json';
const OFFICIAL_CSV_URL = 'data/official-facilities.csv';
const DEFAULT_LAYERS = { hospital: true, response: true, school: true, gym: true, flood: true, landslide: false, volcano: false, tsunami: false, liquefaction: false, activefault: false };
const HAZARDHUNTER_URL = 'https://hazardhunter.georisk.gov.ph/map';
const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
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
  },
  // PHIVOLCS services. Layer ids are not hard-coded: the service's default layers are drawn and
  // the point check uses the MapServer "identify" operation across all layers.
  volcano: {
    name: 'Volcano hazards (lahar)',
    source: 'PHIVOLCS',
    base: 'https://gisweb.phivolcs.dost.gov.ph/arcgis/rest/services/PHIVOLCSPublic/VolcanoLahar/MapServer',
    layerId: null, opacity: 0.6, valueLabels: {}, fallbackLegend: []
  },
  tsunami: {
    name: 'Tsunami hazard',
    source: 'PHIVOLCS via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/PHIVOLCSPublic/Tsunami/MapServer',
    layerId: null, opacity: 0.6, valueLabels: {}, fallbackLegend: []
  },
  liquefaction: {
    name: 'Liquefaction susceptibility',
    source: 'PHIVOLCS via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/PHIVOLCSPublic/Liquefaction/MapServer',
    layerId: null, opacity: 0.6, valueLabels: {}, fallbackLegend: []
  },
  activefault: {
    name: 'Active faults',
    source: 'PHIVOLCS via GeoRisk PH',
    base: 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/PHIVOLCSPublic/ActiveFault/MapServer',
    layerId: null, opacity: 0.9, valueLabels: {}, fallbackLegend: []
  }
};

const typeMeta = {
  hospital: { label: 'Hospital', color: '#e15b65', icon: '+' },
  response: { label: 'Police / fire station', color: '#3978d4', icon: '✚' },
  school: { label: 'School', color: '#d98a1f', icon: '✎' },
  gym: { label: 'Gym / sports hall', color: '#0f9aa8', icon: '◆' }
};

const DEFAULT_STATUS = 'Search any place in the Philippines, zoom in to load facilities, or click the map to check hazards';

let map;
const places = [];                 // facilities loaded from OpenStreetMap
const markerById = new Map();      // place id -> Leaflet marker
const loadedCells = new Set();     // grid cells already loaded
const failedCells = new Map();     // grid cell -> time before which we will not retry
let hazardOverlays = {};
let geoResults = [];               // place-name search results (Nominatim)
let facilityTimer = null;
let loadInFlight = false;
let loadAgain = false;
let lastErrorToast = 0;
let hintEl = null;
let hintError = null;            // set while the facility server is failing
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

function layerOn(type) {
  const toggle = document.querySelector(`[data-layer="${type}"]`);
  return !toggle || toggle.checked;
}
function qualityOnly() { return Boolean($('#qualityOnly')?.checked); }
// A place is shown when its layer is on and, if requested, it is an official or well-documented record.
function placeVisible(place) {
  return layerOn(place.type) && (!qualityOnly() || place.official || place.documented);
}
function syncMarker(place) {
  const marker = markerById.get(place.id);
  if (!marker || !map) return;
  const want = placeVisible(place);
  if (want && !map.hasLayer(marker)) marker.addTo(map);
  if (!want && map.hasLayer(marker)) map.removeLayer(marker);
}

function placesInView() {
  if (!map) return [];
  const bounds = map.getBounds();
  return places.filter(place => bounds.contains(place.position) && placeVisible(place));
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
      ? '<div class="empty-list">Zoom in (or search a city, barangay or landmark) to load hospitals, police and fire stations, schools and gyms.</div>'
      : '<div class="empty-list">No matching facilities in view. They may still be loading, or none are mapped here.</div>';
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
  const trust = place.official
    ? `<p class="trust trust-official">✔ Official record${place.source ? ` · ${escapeHTML(place.source)}` : ''}</p>`
    : `<p class="trust">Community-mapped (OpenStreetMap) · record completeness: <b>${place.documented ? 'good' : 'basic'}</b> · not officially verified. Confirm with your LGU / DRRMO or the facility.</p>`;
  const shelter = place.type === 'school' || place.type === 'gym'
    ? '<p class="trust">Schools and gyms are often used as evacuation centers, but only your LGU / DRRMO can confirm which ones are active.</p>' : '';
  return `<div class="info-window">
    <span class="info-type" style="color:${meta.color}">${escapeHTML(place.kind)}</span>
    <strong>${escapeHTML(place.name)}</strong>
    ${rows}${trust}${shelter}
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
    if ($('#qualityOnly')) $('#qualityOnly').checked = false;
    setLayerVisibility();
  }
  if (panTo) map.setView(place.position, Math.max(map.getZoom(), 16), { animate: true });
  marker.openPopup();
  renderLocationList();
  $('#mapStatus').textContent = `Selected: ${place.name}`;
  $('#sidebar').classList.remove('sidebar-open');
}

/* ---------- Facilities: OpenStreetMap (Overpass) + optional official data ---------- */

const cellKey = (lat, lng) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

function classifyElement(tags) {
  const name = tags.name || tags['name:en'] || '';
  if (!name) return null;                       // unnamed features are too unreliable to show
  if (tags.amenity === 'hospital') return { type: 'hospital', kind: 'Hospital' };
  if (tags.amenity === 'police') return { type: 'response', kind: 'Police station' };
  if (tags.amenity === 'fire_station') return { type: 'response', kind: 'Fire station' };
  if (tags.amenity === 'school') return { type: 'school', kind: 'School' };
  if (tags.amenity === 'college') return { type: 'school', kind: 'College' };
  if (tags.amenity === 'university') return { type: 'school', kind: 'University' };
  if (tags.leisure === 'sports_hall') return { type: 'gym', kind: 'Gymnasium / sports hall' };
  if (tags.leisure === 'sports_centre') return { type: 'gym', kind: 'Sports centre' };
  if (tags.leisure === 'fitness_centre') return { type: 'gym', kind: 'Fitness gym' };
  if (tags.leisure === 'pitch' && /gymnasium|covered court/i.test(name)) return { type: 'gym', kind: 'Covered court / gymnasium' };
  return null;
}

// How complete is the OpenStreetMap record? Counts independent kinds of detail (not a guarantee of accuracy).
function recordScore(tags) {
  const has = (...keys) => keys.some(key => tags[key]);
  const hasPrefix = prefix => Object.keys(tags).some(key => key.startsWith(prefix));
  return [has('phone', 'contact:phone', 'email', 'contact:email'), has('website', 'contact:website'), has('opening_hours'),
    has('operator'), has('wikidata'), hasPrefix('addr:'), hasPrefix('ref')].filter(Boolean).length;
}

function registerPlace(place) {
  if (markerById.has(place.id)) return false;
  const marker = L.marker(place.position, { icon: makeIcon(place.type), title: place.name });
  marker.bindPopup(() => popupContent(place), { maxWidth: 270 });
  marker.on('click', () => { activePlaceId = place.id; renderLocationList(); $('#mapStatus').textContent = `Selected: ${place.name}`; });
  places.push(place);
  markerById.set(place.id, marker);
  syncMarker(place);
  return true;
}

function addElements(elements) {
  let added = 0;
  elements.forEach(el => {
    const tags = el.tags || {};
    const cls = classifyElement(tags);
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (!cls || lat === undefined || lng === undefined) return;
    const position = L.latLng(lat, lng);
    // Skip OSM duplicates of an official record of the same type within 75 m.
    if (places.some(p => p.official && p.type === cls.type && p.position.distanceTo(position) < 75)) return;
    const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'] || tags['addr:barangay'], tags['addr:city'] || tags['addr:municipality']].filter(Boolean).join(', ');
    const place = {
      id: `${el.type}/${el.id}`, type: cls.type, kind: cls.kind,
      name: tags.name || tags['name:en'],
      address: address || 'Address not mapped',
      phone: tags.phone || tags['contact:phone'] || '',
      documented: recordScore(tags) >= 3,
      official: false, position
    };
    if (registerPlace(place)) added += 1;
  });
  return added;
}

// Optional: official records (DepEd / DOH / PNP / BFP / LGU lists) supplied by you as
// data/official-facilities.json  or  data/official-facilities.csv
// columns / keys: name, type (hospital | response | school | gym), lat, lng, address, phone, source
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(name => name.trim().toLowerCase().replace(/^\ufeff/, ''));
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(head.map((name, i) => [name, (r[i] || '').trim()])));
}

async function readOfficialList() {
  try { const list = await fetchJSON(OFFICIAL_JSON_URL, 8000); if (Array.isArray(list)) return list; } catch { /* try CSV */ }
  try {
    const response = await fetch(OFFICIAL_CSV_URL);
    if (!response.ok) return [];
    return parseCSV(await response.text());
  } catch { return []; }
}

async function loadOfficialFacilities() {
  const list = await readOfficialList();
  let count = 0;
  list.forEach((item, index) => {
    const lat = Number(item.lat ?? item.latitude), lng = Number(item.lng ?? item.lon ?? item.longitude);
    const type = String(item.type || '').toLowerCase();
    if (!typeMeta[type] || !Number.isFinite(lat) || !Number.isFinite(lng) || !item.name) return;
    if (registerPlace({
      id: `official/${index}`, type, kind: item.kind || typeMeta[type].label,
      name: String(item.name), address: item.address || '', phone: item.phone || '',
      source: item.source || '', documented: true, official: true, position: L.latLng(lat, lng)
    })) count += 1;
  });
  if (count) { showToast(`${count} official records loaded.`); renderLocationList(); updateStats(); }
}

/* ---------- On-map hint (zoom prompt / server problem) ---------- */

function renderHint() {
  if (!hintEl || !map) return;
  if (hintError) {
    hintEl.innerHTML = `<span>Facilities could not load (${escapeHTML(hintError)}).</span><button type="button" data-hint="retry">Retry now</button>`;
    hintEl.hidden = false;
  } else if (map.getZoom() < FACILITY_MIN_ZOOM) {
    hintEl.innerHTML = '<span>Zoom in to load hospitals, police &amp; fire stations, schools and gyms.</span><button type="button" data-hint="zoom">Zoom in here</button>';
    hintEl.hidden = false;
  } else {
    hintEl.hidden = true;
  }
}

function pruneMarkers() {
  if (places.length <= MAX_MARKERS) return;
  const keep = map.getBounds().pad(1.5);
  for (let i = places.length - 1; i >= 0; i -= 1) {
    const place = places[i];
    if (place.official || keep.contains(place.position)) continue;
    const marker = markerById.get(place.id);
    if (marker) map.removeLayer(marker);
    markerById.delete(place.id);
    places.splice(i, 1);
    loadedCells.delete(cellKey(place.position.lat, place.position.lng));   // so it can be reloaded later
  }
}

async function overpass(query) {
  const reasons = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return await fetchJSON(endpoint, 30000, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`
      });
    } catch (error) {
      const why = error.name === 'AbortError' ? 'timed out' : error.message;
      reasons.push(`${new URL(endpoint).hostname}: ${why}`);
    }
  }
  throw new Error(reasons.join('; '));
}

// Named features only. Every filter is on an indexed key (amenity / leisure) and limited to one small box.
function facilityFilters(area, kinds = ['hospital', 'response', 'school', 'gym']) {
  const f = [];
  if (kinds.includes('hospital')) f.push(`nwr["amenity"="hospital"]["name"]${area};`);
  if (kinds.includes('response')) f.push(`nwr["amenity"~"^(police|fire_station)$"]["name"]${area};`);
  if (kinds.includes('school')) f.push(`nwr["amenity"~"^(school|college|university)$"]["name"]${area};`);
  if (kinds.includes('gym')) f.push(`nwr["leisure"~"^(sports_hall|sports_centre|fitness_centre)$"]["name"]${area};`, `nwr["leisure"="pitch"]["name"~"gymnasium|covered court",i]${area};`);
  return f.join('');
}
const facilityQuery = (area, kinds, limit = CELL_LIMIT) => `[out:json][timeout:25];(${facilityFilters(area, kinds)});out center tags ${limit};`;

function setBusy(busy, text) {
  const label = $('#serviceStatus');
  if (label) label.textContent = busy ? (text || 'Loading facilities…') : 'Map services ready';
  $('.status-dot')?.classList.toggle('busy', busy);
}

async function loadFacilities() {
  if (!map) return;
  if (map.getZoom() < FACILITY_MIN_ZOOM) {
    setFacilityStatus(`Zoom in a little (level ${FACILITY_MIN_ZOOM}+) to load hospitals, police, fire stations, schools and gyms · hazard layers already cover the whole Philippines`);
    renderHint(); renderLocationList(); updateStats();
    return;
  }
  if (loadInFlight) { loadAgain = true; return; }        // one request at a time; re-check when it finishes

  const b = map.getBounds().pad(0.15);                  // small margin, so tiny pans stay inside loaded blocks
  const r0 = Math.floor(b.getSouth() / CELL), r1 = Math.floor(b.getNorth() / CELL);
  const c0 = Math.floor(b.getWest() / CELL), c1 = Math.floor(b.getEast() / CELL);
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_CELLS) { setFacilityStatus('Zoom in a little more to load facilities for this area.'); return; }
  const now = Date.now(), center = map.getCenter();
  const missing = [];
  for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) {
    const key = `${r}:${c}`;
    if (!loadedCells.has(key) && !(failedCells.get(key) > now)) missing.push([r, c]);
  }
  if (!missing.length) { renderLocationList(); updateStats(); return; }   // everything here is cached: no request, no spinner
  // Nearest to the middle of the screen first, so the area you are looking at fills in first.
  missing.sort((a, z) => Math.hypot((a[0] + .5) * CELL - center.lat, (a[1] + .5) * CELL - center.lng) - Math.hypot((z[0] + .5) * CELL - center.lat, (z[1] + .5) * CELL - center.lng));

  loadInFlight = true;
  setBusy(true);
  let done = 0, dense = false;
  try {
    for (const [r, c] of missing) {
      const cell = L.latLngBounds([r * CELL, c * CELL], [(r + 1) * CELL, (c + 1) * CELL]);
      if (!map.getBounds().pad(0.15).intersects(cell)) continue;           // scrolled away while loading: skip, do not mark as loaded
      setBusy(true, `Loading facilities… ${done + 1}/${missing.length}`);
      const data = await overpass(facilityQuery(`(${cell.getSouth()},${cell.getWest()},${cell.getNorth()},${cell.getEast()})`));
      const elements = data.elements || [];
      addElements(elements);
      if (elements.length >= CELL_LIMIT) dense = true;
      loadedCells.add(`${r}:${c}`); failedCells.delete(`${r}:${c}`);
      hintError = null; done += 1;
      renderHint(); renderLocationList(); updateStats();          // show results as each block arrives
    }
    pruneMarkers();
    setFacilityStatus(dense
      ? 'Dense area: some facilities may be missing. Zoom in closer to see all of them.'
      : `${placesInView().length} facilities in view · OpenStreetMap (named records), not officially verified`);
  } catch (error) {
    // Only the block that failed is put on cooldown; blocks already loaded stay.
    const failedKeys = missing.map(([r, c]) => `${r}:${c}`).filter(key => !loadedCells.has(key));
    failedKeys.forEach(key => failedCells.set(key, Date.now() + RETRY_AFTER_MS));
    hintError = (error.message || 'unknown error').slice(0, 140);
    setFacilityStatus(`Facility server is busy or unreachable (${hintError}). Will retry shortly; hazard layers are unaffected.`);
    if (Date.now() - lastErrorToast > 30000) { lastErrorToast = Date.now(); showToast('Could not load facilities right now. Retrying shortly.'); }
    setTimeout(scheduleFacilityLoad, RETRY_AFTER_MS + 500);
  } finally {
    loadInFlight = false;
    setBusy(false);
    renderHint(); renderLocationList(); updateStats();
    if (loadAgain) { loadAgain = false; scheduleFacilityLoad(); }
  }
}

// Facility loading must not overwrite the status line while a route is on screen.
function setFacilityStatus(text) { if (!routeLayer) $('#mapStatus').textContent = text; }

function scheduleFacilityLoad() {
  clearTimeout(facilityTimer);
  facilityTimer = setTimeout(loadFacilities, 900);
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
        size: `${size.x},${size.y}`, dpi: '96'
      });
      if (service.layerId !== null) params.set('layers', `show:${service.layerId}`);
      return `${service.base}/export?${params.toString()}`;
    }
  });
  const layer = new ExportLayer('', { opacity: service.opacity, tileSize: 512, updateWhenZooming: false, updateWhenIdle: true, keepBuffer: 4, minZoom: 5, maxZoom: 20, attribution: `${service.name}: ${service.source}` });
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
    const layers = service.layerId === null
      ? (data.layers || [])
      : [(data.layers || []).find(item => item.layerId === service.layerId) || (data.layers || [])[0]].filter(Boolean);
    const seen = new Set();
    const entries = layers.flatMap(layer => (layer.legend || []).map(item => ({ ...item, layerName: layer.layerName })))
      .filter(item => item.imageData)
      .map(item => ({ label: service.layerId === null && item.layerName ? `${item.layerName}: ${item.label || ''}`.replace(/:\s*$/, '') : item.label || '', image: `data:${item.contentType || 'image/png'};base64,${item.imageData}` }))
      .filter(item => !seen.has(item.label) && seen.add(item.label))
      .slice(0, 14);
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
  Object.keys(HAZARD_SERVICES).forEach(key => {
    const layer = hazardOverlays[key];
    if (!layer) return;
    const on = document.querySelector(`[data-layer="${key}"]`)?.checked;
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  });
  places.forEach(syncMarker);
  renderHazardLegend();
  renderLocationList();
  updateStats();
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

async function identifyHazard(service, lat, lng) {
  const d = 0.01;
  const params = new URLSearchParams({
    f: 'json', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326', layers: 'all', tolerance: '2',
    mapExtent: `${lng - d},${lat - d},${lng + d},${lat + d}`, imageDisplay: '400,400,96', returnGeometry: 'false'
  });
  const data = await fetchJSON(`${service.base}/identify?${params.toString()}`);
  if (data.error) throw new Error(data.error.message || 'Service error');
  const results = data.results || [];
  const rows = new Set(results.map(item => {
    const value = item.value && item.value !== 'Null' && item.value !== '<Null>' ? `: ${item.value}` : '';
    return `${item.layerName || 'Mapped zone'}${value}`;
  }));
  return { count: results.length, rows: [...rows].slice(0, 6) };
}

async function queryHazard(key, lat, lng) {
  const service = HAZARD_SERVICES[key];
  if (service.layerId === null) return identifyHazard(service, lat, lng);
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

// Hits are listed in full; "nothing mapped" and "could not check" are collapsed into one line each.
function hazardSummaryHTML(keys, outcomes) {
  const hits = [], none = [], unknown = [];
  keys.forEach((key, index) => {
    const outcome = outcomes[index], name = HAZARD_SERVICES[key].name;
    if (outcome.status === 'rejected') unknown.push(name);
    else if (!outcome.value.count) none.push(name);
    else hits.push({ name, text: outcome.value.rows.length ? outcome.value.rows.join(', ') : 'Inside a mapped zone' });
  });
  const rows = hits.map(hit => `<div class="hz-row hz-hit"><span>${escapeHTML(hit.name)}</span><b>${escapeHTML(hit.text)}</b></div>`);
  if (!hits.length) rows.push('<div class="hz-row hz-none"><span>Result</span><b>No mapped hazard zone at this point</b></div>');
  if (none.length && hits.length) rows.push(`<div class="hz-row hz-none"><span>No mapped zone</span><b>${none.map(escapeHTML).join(', ')}</b></div>`);
  if (unknown.length) rows.push(`<div class="hz-row hz-unknown"><span>Could not check</span><b>${unknown.map(escapeHTML).join(', ')}</b></div>`);
  return rows.join('');
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
    : hazardSummaryHTML(keys, outcomes);
  popup.setContent(`<div class="info-window">${head}<div class="hz-results">${body}</div>
    <p class="hz-note">Regional-scale hazard maps from MGB and PHIVOLCS (about 1:50,000). “No mapped zone” does not mean safe. Not for site-specific decisions.</p>
    <a class="popup-route" href="${HAZARDHUNTER_URL}" target="_blank" rel="noopener">Full assessment on HazardHunterPH ↗</a></div>`);
}

/* ---------- Stats and map setup ---------- */

function updateStats() {
  const inView = placesInView();
  const count = type => String(inView.filter(p => p.type === type).length).padStart(2, '0');
  [['hospitalCount', 'hospital'], ['responseCount', 'response'], ['schoolCount', 'school'], ['gymCount', 'gym']]
    .forEach(([id, type]) => { const el = $(`#${id}`); if (el) el.textContent = count(type); });
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

  hintEl = document.createElement('div');
  hintEl.className = 'map-hint';
  hintEl.hidden = true;
  map.getContainer().appendChild(hintEl);
  L.DomEvent.disableClickPropagation(hintEl);
  hintEl.addEventListener('click', event => {
    const action = event.target.closest('[data-hint]')?.dataset.hint;
    if (action === 'zoom') map.setZoom(FACILITY_MIN_ZOOM);
    if (action === 'retry') { failedCells.clear(); hintError = null; renderHint(); loadFacilities(); }
  });
  map.on('zoomend', renderHint);
  map.on('moveend', scheduleFacilityLoad);
  loadOfficialFacilities();
  loading.remove();
  setLayerVisibility();
  renderHint();
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
  $('#mapStatus').textContent = 'Looking for schools and gyms near you (possible shelters)…';
  let nearest;
  try {
    const data = await overpass(facilityQuery(`(around:8000,${origin[0]},${origin[1]})`, ['school', 'gym'], 200));
    addElements(data.elements || []);
    nearest = places.filter(place => (place.type === 'school' || place.type === 'gym') && (place.official || place.documented || !qualityOnly()))
      .map(place => ({ place, distance: haversineKm(origin, [place.position.lat, place.position.lng]) }))
      .sort((a, b) => a.distance - b.distance)[0];
  } catch {
    showToast('Could not search for nearby shelters right now. Try again in a moment.');
    return;
  }
  if (!nearest || nearest.distance > 15) {
    $('#mapStatus').textContent = 'No schools or gyms are mapped within 15 km.';
    showToast('None mapped nearby. Ask your barangay or city DRRMO for the official evacuation centers.');
    return;
  }

  const destination = [nearest.place.position.lat, nearest.place.position.lng];
  const url = `https://router.project-osrm.org/route/v1/driving/${origin[1]},${origin[0]};${destination[1]},${destination[0]}?overview=full&geometries=geojson`;
  $('#mapStatus').textContent = `Nearest possible shelter: ${nearest.place.name} · ${nearest.distance.toFixed(1)} km straight-line`;
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

function applyDefaultLayers() {
  document.querySelectorAll('[data-layer]').forEach(input => { input.checked = Boolean(DEFAULT_LAYERS[input.dataset.layer]); });
}

function setupUI() {
  applyDefaultLayers();
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', setLayerVisibility));
  $('#qualityOnly').addEventListener('change', setLayerVisibility);
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
  $('#openSidebar').addEventListener('click', () => $('#sidebar').classList.add('sidebar-open'));
  $('#closeSidebar').addEventListener('click', () => $('#sidebar').classList.remove('sidebar-open'));
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      event.preventDefault(); $('#mapSearch').focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupUI();
  initMap();
});
// Back/forward cache can restore stale switches; put them back to the defaults.
window.addEventListener('pageshow', event => { if (event.persisted && map) { applyDefaultLayers(); setLayerVisibility(); } });
