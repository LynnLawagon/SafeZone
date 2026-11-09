# SafeZone — OpenStreetMap + Leaflet

A front-end emergency and evacuation mapping prototype centered on Davao City. This version uses OpenStreetMap tiles (with an Esri satellite option) and Leaflet instead of Google Maps, so **no API key or billing account is required**.

## Features
- OpenStreetMap interactive map powered by Leaflet
- Demonstration markers for evacuation-point references, hospitals, and response services
- **Real hazard overlays** from DENR-MGB via GeoRisk Philippines (the data family behind [HazardHunterPH](https://hazardhunter.georisk.gov.ph/map)): flood susceptibility and rain-induced landslide susceptibility, with a live legend
- **Click anywhere on the map** (or use "Check hazards here" in a marker popup) to query both hazard layers at that point
- Toggleable layers for facilities and hazards
- Search locations (type to filter, press Enter to open the first match)
- Browser geolocation (requires permission and a secure context; localhost is supported)
- Nearest listed evacuation-point finder
- Sample driving route using the public OSRM demo routing endpoint, with a straight-line fallback if routing is down
- Incident form saved in this browser's localStorage
- Responsive dashboard layout

## Run with Laragon
1. Extract the project folder into `C:\laragon\www\`.
2. Start Laragon.
3. Open `http://localhost/safezone_leaflet/` (or the folder name you chose).
4. Internet access is needed to load Leaflet from its CDN, the map tiles and the GeoRisk hazard layers.
5. Allow location permission when using **My location** or **Nearest center**.

You can also use VS Code Live Server. Browser geolocation generally requires HTTPS or localhost.

## No API key
There is no `config.js` and no API key placeholder. Leaflet is loaded from unpkg's CDN. Street tiles come from OpenStreetMap and satellite tiles from Esri (switch with the layer control at the top right of the map). CARTO's free raster endpoint was removed because it now requires an API key.

## Hazard data (GeoRisk PH / DENR-MGB)
Configured in `HAZARD_SERVICES` at the top of `scripts.js`:
- Flood: `https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/MGBPublic/Flood/MapServer` (layer 0, field `fscode`: 01 Low … 04 Very high)
- Rain-induced landslide: `.../MGBPublic/RainInducedLandslide/MapServer` (layer 0 assumed; if the service layout differs, change `layerId`)

Overlays are drawn with the ArcGIS MapServer `export` operation and points are checked with the layer `query` operation. To add another ArcGIS layer (e.g. storm surge), add an entry to `HAZARD_SERVICES` and a matching `data-layer` checkbox in `index.html`. If the GeoRisk server is offline or blocks the request, the app shows a message and links to HazardHunterPH instead of failing.

These are regional-scale (about 1:50,000) susceptibility maps. "No mapped zone" does **not** mean an area is safe, and they are not for site-specific decisions. Use HazardHunterPH or the relevant agency for official assessments.

## Important service limits
- OpenStreetMap data is open, but the standard `tile.openstreetmap.org` tile servers are a community service with a usage policy. Keep visible attribution, do not bulk-download tiles, and use a dedicated tile provider for high-traffic or production deployments. See https://operations.osmfoundation.org/policies/tiles/.
- The public OSRM demo server is provided for reasonable testing, not as a guaranteed production service. For a deployed/high-traffic app, use a routing provider or host your own OSRM service. See https://project-osrm.org/.
- Search in this prototype filters the sample locations only; it is not a global geocoder.
- Incident reports are stored only in the current browser using localStorage. They are not shared with administrators or emergency responders.

## Safety and data disclaimer
The sample facility markers (evacuation points, hospitals, police/fire) are illustrative demonstration data. The hazard overlays come from government services but are susceptibility maps only, not live alerts. The facility markers are **not verified evacuation centers or official emergency facilities**. Do not use them for real emergency decisions. Replace the facility markers with verified data from Davao City and relevant government agencies before any public or operational use. Contact official emergency services in an actual emergency.

## Main files
- `index.html` — dashboard structure and Leaflet CDN imports
- `styles.css` — responsive dashboard and Leaflet marker styling
- `scripts.js` — map, facility markers, hazard overlays and point check, route lookup, geolocation, and incident storage

## Technology
HTML, CSS, JavaScript, Leaflet 1.9.4, OpenStreetMap and Esri tiles, OSRM demo routing API, DENR-MGB ArcGIS MapServices (GeoRisk PH).


## Deploy to Vercel

This is a static front-end project. Push the contents of this folder to a GitHub repository, then import that repository in Vercel. Select **Other** as the framework preset and leave Build Command and Output Directory empty/default. Ensure `index.html`, `styles.css`, and `scripts.js` are in the repository root.

Do not open `index.html` by double-clicking it for normal testing. Use VS Code Live Server, Laragon at `http://localhost/...`, or the deployed HTTPS Vercel URL.