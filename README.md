# SafeZone — OpenStreetMap + Leaflet

A front-end emergency and evacuation mapping prototype centered on Davao City. This version uses OpenStreetMap tiles and Leaflet instead of Google Maps, so **no Google Maps API key or Google Cloud billing account is required**.

## Features
- OpenStreetMap interactive map powered by Leaflet
- Demonstration markers for evacuation-point references, hospitals, and response services
- Toggleable map layers and illustrative hazard circles
- Search and select locations
- Browser geolocation (requires permission and a secure context; localhost is supported)
- Nearest listed evacuation-point finder
- Sample driving route using the public OSRM demo routing endpoint
- Incident form saved in this browser's localStorage
- Responsive dashboard layout

## Run with Laragon
1. Extract the project folder into `C:\laragon\www\`.
2. Start Laragon.
3. Open `http://localhost/safezone_leaflet/` (or the folder name you chose).
4. Internet access is needed to load Leaflet from its CDN and OpenStreetMap map tiles.
5. Allow location permission when using **My location** or **Nearest center**.

You can also use VS Code Live Server. Browser geolocation generally requires HTTPS or localhost.

## No API key
There is no `config.js` and no API key placeholder. Leaflet is loaded from unpkg's CDN. Map tiles are provided by OpenStreetMap's standard tile service.

## Important service limits
- OpenStreetMap data is open, but the standard `tile.openstreetmap.org` tile servers are a community service with a usage policy. Keep visible attribution, do not bulk-download tiles, and use a dedicated tile provider for high-traffic or production deployments. See https://operations.osmfoundation.org/policies/tiles/.
- The public OSRM demo server is provided for reasonable testing, not as a guaranteed production service. For a deployed/high-traffic app, use a routing provider or host your own OSRM service. See https://project-osrm.org/.
- Search in this prototype filters the sample locations only; it is not a global geocoder.
- Incident reports are stored only in the current browser using localStorage. They are not shared with administrators or emergency responders.

## Safety and data disclaimer
All sample facility markers and amber hazard circles are illustrative demonstration data. They are **not verified evacuation centers, official emergency facilities, official flood maps, or live hazard information**. Do not use them for real emergency decisions. Replace them with verified data from Davao City and relevant government agencies before any public or operational use. Contact official emergency services in an actual emergency.

## Main files
- `index.html` — dashboard structure and Leaflet CDN imports
- `styles.css` — responsive dashboard and Leaflet marker styling
- `scripts.js` — map, layers, markers, route lookup, geolocation, and incident storage

## Technology
HTML, CSS, JavaScript, Leaflet 1.9.4, OpenStreetMap tiles, OSRM demo routing API.
