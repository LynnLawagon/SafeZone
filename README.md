# SafeZone — OpenStreetMap + Leaflet

A front-end emergency and evacuation mapping prototype covering the whole Philippines. This version uses OpenStreetMap tiles (with an Esri satellite option) and Leaflet instead of Google Maps, so **no API key or billing account is required**.

## Features
- Opens on the whole Philippines; search any city, barangay or landmark (press Enter)
- **Official hazard overlays**, nationwide, with a live legend (the data behind [HazardHunterPH](https://hazardhunter.georisk.gov.ph/map)): flood and rain-induced landslide susceptibility (DENR-MGB), volcano hazards (lahar), tsunami, liquefaction and active faults (PHIVOLCS)
- **Click anywhere on the map** to check every hazard layer at that point. Hits are listed first, then one line for "nothing mapped" and one for any service that could not be checked.
- **Facilities**, loaded for the area you are viewing (zoom 13+): hospitals, police and fire stations, schools and gyms / sports halls
- "Nearest shelter" finds the nearest school or gym with a sample driving route (OSRM). Schools and gyms are often used as evacuation centers, but only your LGU / DRRMO can confirm which ones are active.
- Street / satellite basemap switch, browser geolocation, responsive layout

## About the facility data (please read)
Facilities come live from OpenStreetMap (Overpass API). **They cannot be officially verified**: OpenStreetMap is community-mapped. To keep results trustworthy the app:
- shows **named records only** (unnamed features are dropped, kindergartens are excluded);
- offers **"Well-documented records only"**, which keeps facilities that have at least 3 kinds of detail mapped (contact, website, hours, operator, wikidata, address, reference IDs). This is a completeness signal, not proof of accuracy;
- labels every popup as community-mapped, or as an official record when one comes from your own file (below).

### Adding official, verified data
I checked for official, live, queryable sources and found none that a browser app can use today:
- **DepEd schools:** the humanitarian dataset on HDX is from 2008 and marked "never updated"; DepEd's data inside OpenStreetMap covers only about 30% of public schools.
- **DOH hospitals:** the DOH Health Facility Development Bureau publishes facility lists, but without coordinates or a map service.
- **PNP / BFP stations and LGU evacuation centers:** no public geodata service found.
- The Philippine Geoportal (NAMRIA) may offer layers, but I could not confirm them.

So official records are supplied by you as a file, in either format (see the `example` files in `data/`):
- `data/official-facilities.csv` (easy from Excel; columns `name,type,lat,lng,address,phone,source`), or
- `data/official-facilities.json` (`[{ "name", "type", "lat", "lng", "address", "phone", "source" }]`).

`type` is one of `hospital`, `response` (police / fire), `school` or `gym`. Official records show a green "Official record" badge, always appear even when the quality filter is on, and replace any OpenStreetMap duplicate within 75 m. If neither file exists the app uses OpenStreetMap only.

### If facilities don't appear
- Facilities load from zoom level 13. Below that the map shows a "Zoom in here" button.
- If the facility server (Overpass) is busy, the map shows the real reason, for example `HTTP 429` or `timed out`, with a **Retry now** button. Three public Overpass servers are tried in turn.
- The hazard layers use a different server (GeoRisk) and are not affected.

### Hazard services used
| Layer | Server |
|---|---|
| Flood, Rain-induced landslide | `ulap-hazards.georisk.gov.ph/.../MGBPublic/Flood` and `.../RainInducedLandslide` |
| Tsunami, Liquefaction, Active faults | `ulap-hazards.georisk.gov.ph/.../PHIVOLCSPublic/Tsunami`, `Liquefaction`, `ActiveFault` |
| Volcano (lahar) | `gisweb.phivolcs.dost.gov.ph/.../PHIVOLCSPublic/VolcanoLahar` |

The PHIVOLCS layers are drawn with the service defaults and checked with the ArcGIS `identify` operation, so no layer numbers are hard-coded. Ashfall and pyroclastic-flow maps are not in a public service I could find; use HazardHunterPH for those.

### How loading works
The map is split into ~11 km blocks. Each block is one small request, loaded one at a time starting from the middle of the screen so the area you are looking at fills in first. Loaded blocks are cached, a 15% margin is prefetched so small pans cost nothing, and a failed block is not retried for 45 seconds. Very dense areas are capped, so zoom in closer if the app says some facilities may be missing.

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
- Place search uses OpenStreetMap Nominatim (Enter key only, per its usage policy). Facilities use the public Overpass API. Both are shared community services: for production, host your own or use a commercial provider.

## Safety and data disclaimer
Facility markers are community-mapped OpenStreetMap data and are not verified. The hazard overlays come from government services but are susceptibility maps only, not live alerts. The facility markers are **not verified evacuation centers or official emergency facilities**. Do not use them for real emergency decisions. Replace them with verified data from the relevant LGUs and government agencies before any public or operational use. Contact official emergency services in an actual emergency.

## Main files
- `index.html` — dashboard structure and Leaflet CDN imports
- `styles.css` — responsive dashboard and Leaflet marker styling
- `scripts.js` — map, nationwide facility loading, place search, hazard overlays and point check, route lookup, and geolocation

## Technology
HTML, CSS, JavaScript, Leaflet 1.9.4, OpenStreetMap and Esri tiles, OSRM demo routing API, Overpass and Nominatim (OpenStreetMap), DENR-MGB ArcGIS MapServices (GeoRisk PH).


## Deploy to Vercel

This is a static front-end project. Push the contents of this folder to a GitHub repository, then import that repository in Vercel. Select **Other** as the framework preset and leave Build Command and Output Directory empty/default. Ensure `index.html`, `styles.css`, and `scripts.js` are in the repository root.

Do not open `index.html` by double-clicking it for normal testing. Use VS Code Live Server, Laragon at `http://localhost/...`, or the deployed HTTPS Vercel URL.
