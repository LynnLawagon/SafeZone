'use strict';

const DAVAO_CENTER = [7.0731, 125.6128];
const STORAGE_KEY = 'safezone_incidents_v2';
const $ = (selector) => document.querySelector(selector);

// DEMONSTRATION LOCATIONS ONLY. Verify every facility with official sources.
const places = [
  { id: 1, name: 'Davao City Hall area', type: 'evacuation', description: 'Sample map point for interface demonstration. This is not a confirmed evacuation center.', address: 'San Pedro Street, Poblacion District', position: [7.0644, 125.6095] },
  { id: 2, name: 'People’s Park area', type: 'evacuation', description: 'Sample community gathering point. Confirm official evacuation status before relying on it.', address: 'Legazpi Street, Poblacion District', position: [7.0677, 125.6092] },
  { id: 3, name: 'Ramon Magsaysay Park area', type: 'evacuation', description: 'Sample map pin only; not a confirmed evacuation center.', address: 'R. Magsaysay Avenue, Agdao area', position: [7.0796, 125.6247] },
  { id: 4, name: 'Southern Philippines Medical Center', type: 'hospital', description: 'Medical facility reference point. Verify current emergency services and access.', address: 'J.P. Laurel Avenue, Bajada', position: [7.0935, 125.6137] },
  { id: 5, name: 'Davao Doctors Hospital', type: 'hospital', description: 'Medical facility reference point. Verify current emergency services and access.', address: '118 E. Quirino Avenue', position: [7.0698, 125.6116] },
  { id: 6, name: 'Police station reference', type: 'response', description: 'Illustrative response-service marker. Confirm station details.', address: 'Poblacion District, Davao City', position: [7.0656, 125.6074] },
  { id: 7, name: 'Fire station reference', type: 'response', description: 'Illustrative response-service marker. Confirm station details.', address: 'Central Davao City', position: [7.0712, 125.6161] }
];

// Approximate illustrative circles, NOT official flood boundaries or live hazard data.
const hazardZones = [
  { name: 'Illustrative low-lying area A', center: [7.0804, 125.6252], radius: 850 },
  { name: 'Illustrative low-lying area B', center: [7.0585, 125.6040], radius: 650 }
];

const typeMeta = {
  evacuation: { label: 'Evacuation (demo)', color: '#15966b', icon: '⌂' },
  hospital: { label: 'Medical facility', color: '#e15b65', icon: '+' },
  response: { label: 'Police / fire reference', color: '#3978d4', icon: '✚' }
};

let map;
let markers = [];
let hazardLayers = [];
let activePlaceId = null;
let userMarker = null;
let routeLayer = null;
let userPosition = null;
let toastTimer;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function getIncidents() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function saveIncidents(items) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }
  catch { showToast('Could not save this report. Browser storage may be unavailable.'); }
}

function makeIcon(type) {
  const meta = typeMeta[type];
  return L.divIcon({
    className: 'safezone-marker-wrap',
    html: `<span class="safezone-marker" style="--marker-color:${meta.color}"><span>${meta.icon}</span></span>`,
    iconSize: [38, 44], iconAnchor: [19, 42], popupAnchor: [0, -38]
  });
}

function renderLocationList(filter = '') {
  const list = $('#locationList');
  const query = filter.toLowerCase();
  const visible = places.filter(place => `${place.name} ${place.address} ${place.type}`.toLowerCase().includes(query));
  list.innerHTML = visible.map(place => `
    <button class="location-item ${activePlaceId === place.id ? 'active' : ''}" data-place-id="${place.id}">
      <span class="mini-marker ${place.type}">${typeMeta[place.type].icon}</span>
      <span class="location-item-copy"><strong>${escapeHTML(place.name)}</strong><small>${escapeHTML(place.address)}</small></span>
      <span class="item-chevron">›</span>
    </button>`).join('') || '<div class="empty-list">No matching locations found.</div>';
  list.querySelectorAll('[data-place-id]').forEach(button => {
    button.addEventListener('click', () => selectPlace(Number(button.dataset.placeId), true));
  });
}

function popupContent(place) {
  const meta = typeMeta[place.type];
  return `<div class="info-window">
    <span class="info-type" style="color:${meta.color}">${escapeHTML(meta.label)}</span>
    <strong>${escapeHTML(place.name)}</strong>
    <p>${escapeHTML(place.description)}</p>
    <small>${escapeHTML(place.address)}</small>
    <a class="popup-route" href="https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${place.position[0]}%2C${place.position[1]}" target="_blank" rel="noopener">Open directions ↗</a>
  </div>`;
}

function selectPlace(id, panTo = false) {
  const place = places.find(item => item.id === id);
  if (!place) return;
  activePlaceId = id;
  const entry = markers.find(item => item.place.id === id);
  if (entry) {
    entry.marker.bindPopup(popupContent(place), { maxWidth: 260 }).openPopup();
    if (panTo) map.setView(place.position, 16, { animate: true });
  }
  renderLocationList($('#mapSearch').value);
  $('#mapStatus').textContent = `Selected: ${place.name} · Demonstration location`;
}

function setLayerVisibility() {
  document.querySelectorAll('[data-layer]').forEach(input => {
    const layer = input.dataset.layer;
    markers.forEach(({ place, marker }) => {
      const matches = (layer === 'evacuation' && place.type === 'evacuation') ||
        (layer === 'hospital' && place.type === 'hospital') ||
        (layer === 'response' && place.type === 'response');
      if (matches) input.checked ? marker.addTo(map) : map.removeLayer(marker);
    });
    if (layer === 'hazard') hazardLayers.forEach(circle => input.checked ? circle.addTo(map) : map.removeLayer(circle));
  });
}

function updateStats() {
  $('#evacCount').textContent = String(places.filter(p => p.type === 'evacuation').length).padStart(2, '0');
  $('#hospitalCount').textContent = String(places.filter(p => p.type === 'hospital').length).padStart(2, '0');
  $('#responseCount').textContent = String(places.filter(p => p.type === 'response').length).padStart(2, '0');
  $('#incidentCount').textContent = String(getIncidents().length).padStart(2, '0');
}

function initMap() {
  const loading = document.querySelector('.map-loading');
  if (!window.L) {
    loading.innerHTML = '<div class="map-error-icon">!</div><strong>Map library could not load</strong><span>Check your internet connection and reload the page.</span>';
    return;
  }

  map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView(DAVAO_CENTER, 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(map);

  markers = places.map(place => {
    const marker = L.marker(place.position, { icon: makeIcon(place.type), title: place.name }).addTo(map);
    marker.bindPopup(popupContent(place), { maxWidth: 260 });
    marker.on('click', () => {
      activePlaceId = place.id;
      renderLocationList($('#mapSearch').value);
      $('#mapStatus').textContent = `Selected: ${place.name} · Demonstration location`;
    });
    return { place, marker };
  });

  hazardLayers = hazardZones.map(zone => L.circle(zone.center, {
    radius: zone.radius, color: '#d99a35', weight: 1.5,
    opacity: 0.85, fillColor: '#e8b95f', fillOpacity: 0.22,
    interactive: false
  }).addTo(map));

  loading.remove();
  setLayerVisibility();
  renderLocationList();
  updateStats();
  setTimeout(() => map.invalidateSize(), 100);
}

function locateUser() {
  if (!navigator.geolocation) { showToast('Location services are not supported by this browser.'); return; }
  showToast('Requesting your location…');
  navigator.geolocation.getCurrentPosition(position => {
    userPosition = [position.coords.latitude, position.coords.longitude];
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.circleMarker(userPosition, {
      radius: 9, color: '#fff', weight: 3, fillColor: '#2868c7', fillOpacity: 1
    }).addTo(map).bindPopup('Your current location');
    map.setView(userPosition, 16);
    userMarker.openPopup();
    $('#mapStatus').textContent = 'Showing your current location';
    showToast('Your location is now shown on the map.');
  }, error => {
    const messages = { 1: 'Location permission was denied.', 2: 'Your location is currently unavailable.', 3: 'Location request timed out.' };
    showToast(messages[error.code] || 'Unable to get your location.');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

function haversineKm(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function findNearestCenter() {
  if (!userPosition) {
    showToast('First select My location so SafeZone can find the nearest center.');
    locateUser();
    return;
  }
  const centers = places.filter(place => place.type === 'evacuation');
  const nearest = centers.map(place => ({ place, distance: haversineKm(userPosition, place.position) }))
    .sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) { showToast('No demonstration evacuation points are available.'); return; }

  const destination = nearest.place.position;
  const url = `https://router.project-osrm.org/route/v1/driving/${userPosition[1]},${userPosition[0]};${destination[1]},${destination[0]}?overview=full&geometries=geojson`;
  $('#mapStatus').textContent = `Nearest listed point: ${nearest.place.name} · ${nearest.distance.toFixed(1)} km straight-line`;
  showToast(`Finding a sample route to ${nearest.place.name}…`);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Routing service unavailable');
    const data = await response.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route returned');
    if (routeLayer) map.removeLayer(routeLayer);
    const coordinates = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeLayer = L.polyline(coordinates, { color: '#2868c7', weight: 5, opacity: 0.88 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [55, 55] });
    selectPlace(nearest.place.id, false);
    const km = (data.routes[0].distance / 1000).toFixed(1);
    const mins = Math.round(data.routes[0].duration / 60);
    $('#mapStatus').textContent = `Sample route: ${km} km · about ${mins} min to ${nearest.place.name}`;
    showToast(`Route displayed: ${km} km, approximately ${mins} minutes.`);
  } catch (error) {
    showToast('Could not load a route. Try again or open directions from the location popup.');
  }
}

function searchLocations() {
  const query = $('#mapSearch').value.trim().toLowerCase();
  renderLocationList(query);
  const match = places.find(place => `${place.name} ${place.address} ${place.type}`.toLowerCase().includes(query));
  if (query && match) selectPlace(match.id, true);
  else if (query) $('#mapStatus').textContent = 'No matching demonstration location. Try another keyword.';
  else $('#mapStatus').textContent = 'Showing demonstration locations in Davao City';
}

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
  saveIncidents(incidents);
  updateStats();
  $('#incidentForm').reset();
  closeReportModal();
  showToast('Incident report saved on this device only.');
}

function resetMap() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  map.setView(DAVAO_CENTER, 14);
  map.closePopup();
  activePlaceId = null;
  renderLocationList($('#mapSearch').value);
  $('#mapStatus').textContent = 'Showing demonstration locations in Davao City';
}

function setupUI() {
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', setLayerVisibility));
  $('#mapSearch').addEventListener('input', searchLocations);
  $('#locateMe').addEventListener('click', locateUser);
  $('#findNearest').addEventListener('click', findNearestCenter);
  $('#resetMap').addEventListener('click', resetMap);
  $('#showAll').addEventListener('click', () => {
    $('#mapSearch').value = '';
    renderLocationList();
    if (map) map.fitBounds(L.latLngBounds(places.map(place => place.position)), { padding: [45, 45] });
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
    if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      event.preventDefault(); $('#mapSearch').focus();
    }
  });
  updateStats();
}

document.addEventListener('DOMContentLoaded', () => {
  setupUI();
  initMap();
});
