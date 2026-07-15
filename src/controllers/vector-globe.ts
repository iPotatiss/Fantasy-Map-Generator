import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./vector-globe.css";
import {
  buildVectorGlobeData,
  mapPointToVectorLngLat,
  VECTOR_GLOBE_CONTENT_MAX_LATITUDE,
  VECTOR_GLOBE_POLAR_CAP_DEGREES,
  type VectorGlobeData
} from "./vector-globe-data";

const SETTLEMENT_ENTRY_ZOOM = 7.25;
const SETTLEMENT_PRELOAD_ZOOM = 8;
const SETTLEMENT_MAP_ZOOM = 9.5;
const VECTOR_GLOBE_MAX_ZOOM = 11.5;

let vectorMap: MapLibreMap | null = null;
let vectorContainer: HTMLElement | null = null;
let vectorData: VectorGlobeData | null = null;
let vectorReady = false;
let vectorRevision = 0;
let vectorUpdateTimer = 0;
let vectorSettlement: HTMLElement | null = null;
let vectorSettlementId = 0;
let vectorSettlementTimer = 0;
let vectorPreloadedSettlement: HTMLIFrameElement | null = null;
let vectorPreloadedSettlementId = 0;
let vectorSettlementExiting = false;
let vectorMotionDetailPaused = false;
let vectorStage = "World";
let vectorDataBuildMs = 0;
let vectorPerformanceProfile: "quality" | "low-power" = "quality";
let vectorPixelRatio = 1;

const SOURCE_IDS = {
  polarCaps: "fmg-polar-caps",
  landmasses: "fmg-landmasses",
  land: "fmg-land",
  lakes: "fmg-lakes",
  coastlines: "fmg-coastlines",
  borders: "fmg-borders",
  routes: "fmg-routes",
  rivers: "fmg-rivers",
  burgs: "fmg-burgs",
  markers: "fmg-markers",
  stateLabels: "fmg-state-labels"
} as const;

const INTERACTIVE_BURG_LAYERS = ["fmg-capital-hit-targets", "fmg-burg-hit-targets"] as const;

function getLayerColor(id: string, attribute: "fill" | "stroke", fallback: string) {
  const element = document.getElementById(id);
  return element?.getAttribute(attribute) || element?.parentElement?.getAttribute(attribute) || fallback;
}

function getPalette() {
  const useStateColors = typeof layerIsOn === "function" ? layerIsOn("toggleStates") : true;
  return {
    stateColors: (pack.states || []).map(state => state?.color),
    biomeColors: Array.from(biomesData?.color || []),
    stateNames: (pack.states || []).map(state => state?.fullName || state?.name),
    useStateColors
  };
}

function createEmptyStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "fmg-ocean",
        type: "background",
        paint: { "background-color": getLayerColor("oceanBase", "fill", "#6888b5") }
      }
    ]
  };
}

function addGeoJsonSource(id: string, data: GeoJSON.FeatureCollection) {
  // World geometry does not gain information at city scale. Reusing regional
  // tiles avoids tessellating the full globe again during every close zoom.
  const lowPower = vectorPerformanceProfile === "low-power";
  vectorMap?.addSource(id, { type: "geojson", data, tolerance: lowPower ? 0.5 : 0.25, maxzoom: lowPower ? 7 : 8 });
}

const MOTION_LABEL_LAYERS = ["fmg-state-labels", "fmg-burg-labels", "fmg-marker-labels", "fmg-marker-symbols"];
const LOW_POWER_MOTION_LAYERS = ["fmg-province-borders", "fmg-trails", "fmg-sea-routes"];

function setMotionDetailPaused(paused: boolean) {
  if (!vectorMap || paused === vectorMotionDetailPaused || vectorSettlement) return;
  vectorMotionDetailPaused = paused;
  const layers =
    vectorPerformanceProfile === "low-power"
      ? [...MOTION_LABEL_LAYERS, ...LOW_POWER_MOTION_LAYERS]
      : MOTION_LABEL_LAYERS;
  for (const layer of layers) {
    if (vectorMap.getLayer(layer)) vectorMap.setLayoutProperty(layer, "visibility", paused ? "none" : "visible");
  }
}

function addVectorSources(data: VectorGlobeData) {
  addGeoJsonSource(SOURCE_IDS.polarCaps, data.polarCaps);
  addGeoJsonSource(SOURCE_IDS.landmasses, data.landmasses);
  addGeoJsonSource(SOURCE_IDS.land, data.land);
  addGeoJsonSource(SOURCE_IDS.lakes, data.lakes);
  addGeoJsonSource(SOURCE_IDS.coastlines, data.coastlines);
  addGeoJsonSource(SOURCE_IDS.borders, data.borders);
  addGeoJsonSource(SOURCE_IDS.routes, data.routes);
  addGeoJsonSource(SOURCE_IDS.rivers, data.rivers);
  addGeoJsonSource(SOURCE_IDS.burgs, data.burgs);
  addGeoJsonSource(SOURCE_IDS.markers, data.markers);
  addGeoJsonSource(SOURCE_IDS.stateLabels, data.stateLabels);
}

function addVectorLayers() {
  if (!vectorMap) return;

  vectorMap.addLayer({
    id: "fmg-polar-ocean",
    type: "fill",
    source: SOURCE_IDS.polarCaps,
    paint: {
      "fill-color": getLayerColor("oceanBase", "fill", "#6888b5"),
      "fill-opacity": 1,
      "fill-antialias": false
    }
  });
  vectorMap.addLayer({
    id: "fmg-landmass-fill",
    type: "fill",
    source: SOURCE_IDS.landmasses,
    paint: { "fill-color": ["coalesce", ["get", "fill"], "#dce8c9"], "fill-opacity": 1 }
  });
  vectorMap.addLayer({
    id: "fmg-land-fill",
    type: "fill",
    source: SOURCE_IDS.land,
    paint: {
      "fill-color": ["coalesce", ["get", "fill"], "#d9e8c4"],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 1, 4.5, 0.94, 6.2, 0.55, 7.4, 0.16, 8.5, 0],
      "fill-antialias": false
    }
  });
  vectorMap.addLayer({
    id: "fmg-lake-fill",
    type: "fill",
    source: SOURCE_IDS.lakes,
    paint: { "fill-color": "#82a5c8", "fill-opacity": 1 }
  });

  vectorMap.addLayer({
    id: "fmg-province-borders",
    type: "line",
    source: SOURCE_IDS.borders,
    filter: ["==", ["get", "kind"], "province"],
    paint: {
      "line-color": getLayerColor("provinceBorders", "stroke", "#777b91"),
      "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.35, 5, 0.8, 9, 1.4],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.35, 5, 0.7, 7.3, 0.35, 8.5, 0],
      "line-dasharray": [2, 3]
    }
  });
  vectorMap.addLayer({
    id: "fmg-state-borders",
    type: "line",
    source: SOURCE_IDS.borders,
    filter: ["==", ["get", "kind"], "state"],
    paint: {
      "line-color": getLayerColor("stateBorders", "stroke", "#54566b"),
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.65, 5, 1.3, 9, 2.2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.92, 6, 0.88, 7.5, 0.35, 8.5, 0],
      "line-dasharray": [3, 2]
    }
  });

  vectorMap.addLayer({
    id: "fmg-sea-routes",
    type: "line",
    source: SOURCE_IDS.routes,
    filter: ["==", ["get", "kind"], "searoutes"],
    paint: {
      "line-color": getLayerColor("searoutes", "stroke", "#f4f0df"),
      "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.7, 8, 2],
      "line-opacity": 0.85,
      "line-dasharray": [2, 3]
    }
  });
  vectorMap.addLayer({
    id: "fmg-trails",
    type: "line",
    source: SOURCE_IDS.routes,
    filter: ["==", ["get", "kind"], "trails"],
    paint: {
      "line-color": getLayerColor("trails", "stroke", "#777489"),
      "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.55, 8, 2.2],
      "line-opacity": 0.85,
      "line-dasharray": [1, 2]
    }
  });
  vectorMap.addLayer({
    id: "fmg-roads",
    type: "line",
    source: SOURCE_IDS.routes,
    filter: ["==", ["get", "kind"], "roads"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": getLayerColor("roads", "stroke", "#d87532"),
      "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.7, 5, 1.4, 9, 3.2],
      "line-opacity": 0.95
    }
  });
  vectorMap.addLayer({
    id: "fmg-rivers",
    type: "line",
    source: SOURCE_IDS.rivers,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": getLayerColor("rivers", "fill", "#4c9fbe"),
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        1,
        0.45,
        7,
        ["interpolate", ["linear"], ["get", "width"], 1, 1.2, 20, 3.5],
        11,
        ["interpolate", ["linear"], ["get", "width"], 1, 2, 20, 7]
      ],
      "line-opacity": 0.9
    }
  });
  vectorMap.addLayer({
    id: "fmg-coastlines",
    type: "line",
    source: SOURCE_IDS.coastlines,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": getLayerColor("sea_island", "stroke", "#50596b"),
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.75, 6, 1.5, 10, 2.5],
      "line-opacity": 0.94
    }
  });

  vectorMap.addLayer({
    id: "fmg-state-labels",
    type: "symbol",
    source: SOURCE_IDS.stateLabels,
    maxzoom: 6.2,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 0, 9, 3, 15, 6, 20],
      "text-letter-spacing": 0.08,
      "text-max-width": 9,
      "text-transform": "uppercase",
      "text-padding": 8,
      "text-allow-overlap": false,
      "symbol-sort-key": ["-", 0, ["get", "area"]]
    },
    paint: {
      "text-color": "#343545",
      "text-halo-color": "rgba(250,248,238,0.82)",
      "text-halo-width": 1.5
    }
  });

  vectorMap.addLayer({
    id: "fmg-burg-halos",
    type: "circle",
    source: SOURCE_IDS.burgs,
    minzoom: 3.2,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 4.5, 5, 7.5, 9, 11],
      "circle-color": "rgba(255,255,255,0.72)",
      "circle-blur": 0.12
    }
  });
  vectorMap.addLayer({
    id: "fmg-burgs",
    type: "circle",
    source: SOURCE_IDS.burgs,
    minzoom: 3.2,
    filter: ["==", ["get", "capital"], false],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.8, 5, 5, 9, 7.5],
      "circle-color": "#fffdf6",
      "circle-stroke-color": "#252936",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 1, 1.2, 8, 2]
    }
  });
  vectorMap.addLayer({
    id: "fmg-capitals",
    type: "circle",
    source: SOURCE_IDS.burgs,
    minzoom: 0,
    filter: ["==", ["get", "capital"], true],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 4.5, 5, 7.5, 9, 11],
      "circle-color": "#f7c84b",
      "circle-stroke-color": "#252936",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 0, 1.4, 8, 2.5]
    }
  });
  vectorMap.addLayer({
    id: "fmg-capital-stars",
    type: "symbol",
    source: SOURCE_IDS.burgs,
    filter: ["==", ["get", "capital"], true],
    layout: {
      "text-field": "★",
      "text-font": ["Open Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 0, 8, 5, 12, 9, 17],
      "text-allow-overlap": true,
      "text-ignore-placement": true
    },
    paint: { "text-color": "#20232d" }
  });
  vectorMap.addLayer({
    id: "fmg-burg-labels",
    type: "symbol",
    source: SOURCE_IDS.burgs,
    minzoom: 3.1,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 14, 9, 17, 11, 20],
      "text-variable-anchor": ["top", "bottom", "left", "right"],
      "text-radial-offset": 0.72,
      "text-justify": "auto",
      "text-padding": 3,
      "text-allow-overlap": false,
      "symbol-sort-key": ["-", 0, ["get", "population"]]
    },
    paint: {
      "text-color": "#272a36",
      "text-halo-color": "rgba(255,253,246,0.96)",
      "text-halo-width": 1.6,
      "text-halo-blur": 0.15
    }
  });

  // Keep settlement interactions comfortable on touchscreens and on dense maps.
  // These transparent circles are deliberately larger than the visual symbols,
  // while capitals and ordinary burgs remain separate so one click fires once.
  vectorMap.addLayer({
    id: "fmg-capital-hit-targets",
    type: "circle",
    source: SOURCE_IDS.burgs,
    filter: ["==", ["get", "capital"], true],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 12, 6, 15, 11, 19],
      "circle-color": "#000000",
      "circle-opacity": 0.01
    }
  });
  vectorMap.addLayer({
    id: "fmg-burg-hit-targets",
    type: "circle",
    source: SOURCE_IDS.burgs,
    minzoom: 3.2,
    filter: ["==", ["get", "capital"], false],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3.2, 11, 7, 15, 11, 19],
      "circle-color": "#000000",
      "circle-opacity": 0.01
    }
  });

  vectorMap.addLayer({
    id: "fmg-markers",
    type: "circle",
    source: SOURCE_IDS.markers,
    minzoom: 2.5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2.5, 4, 8, 7],
      "circle-color": "#d6604d",
      "circle-stroke-color": "#fffaf0",
      "circle-stroke-width": 2
    }
  });
  vectorMap.addLayer({
    id: "fmg-marker-symbols",
    type: "symbol",
    source: SOURCE_IDS.markers,
    minzoom: 2.5,
    layout: {
      "text-field": ["coalesce", ["get", "icon"], "•"],
      "text-font": ["Open Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 2.5, 12, 7, 18, 10, 24],
      "text-allow-overlap": true,
      "text-ignore-placement": true
    },
    paint: {
      "text-color": "#272a36",
      "text-halo-color": "rgba(255,250,240,0.96)",
      "text-halo-width": 1.4
    }
  });
  vectorMap.addLayer({
    id: "fmg-marker-labels",
    type: "symbol",
    source: SOURCE_IDS.markers,
    minzoom: 5,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 10, 16],
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-padding": 3
    },
    paint: {
      "text-color": "#2d2f3b",
      "text-halo-color": "#fffaf0",
      "text-halo-width": 1.5
    }
  });
}

function getVectorStage(zoom: number) {
  if (zoom < 2.5) return "World";
  if (zoom < 4.8) return "Kingdoms";
  if (zoom < SETTLEMENT_ENTRY_ZOOM) return "Regions";
  return "Settlements";
}

function updateHud() {
  if (!vectorMap || !vectorContainer) return;
  vectorStage = getVectorStage(vectorMap.getZoom());
  const stage = vectorContainer.querySelector<HTMLElement>(".fmg-vector-globe__stage");
  if (stage) stage.textContent = vectorStage;
  const hint = vectorContainer.querySelector<HTMLElement>(".fmg-vector-globe__hint");
  if (hint) hint.dataset.visible = String(vectorMap.getZoom() >= SETTLEMENT_ENTRY_ZOOM - 0.4);
}

function createHud() {
  if (!vectorContainer || !vectorMap) return;
  const hud = document.createElement("div");
  hud.className = "fmg-vector-globe__hud";

  const builder = document.createElement("button");
  builder.type = "button";
  builder.textContent = "← Builder";
  builder.title = "Return to the editable flat map";
  builder.addEventListener("click", () => document.getElementById("viewStandard")?.click());

  const world = document.createElement("button");
  world.type = "button";
  world.textContent = "World";
  world.title = "Return to the full globe";
  world.addEventListener("click", () => vectorMap?.easeTo({ center: [0, 0], zoom: 1.75, duration: 650 }));

  const stage = document.createElement("span");
  stage.className = "fmg-vector-globe__stage";
  stage.textContent = vectorStage;
  hud.append(builder, world, stage);

  const hint = document.createElement("div");
  hint.className = "fmg-vector-globe__hint";
  hint.textContent = "Zoom closer over a settlement to enter its bird’s-eye map";
  hint.dataset.visible = "false";
  vectorContainer.append(hud, hint);
  updateHud();
}

function openFeatureEditor(type: "burg" | "marker", id: number) {
  if (customization) {
    tip("Finish the current customization before opening a map feature", false, "warn", 3000);
    return;
  }
  const editors = window as typeof window & { editBurg?: (id: number) => void; editMarker?: (id: number) => void };
  const editor = type === "burg" ? editors.editBurg : editors.editMarker;
  if (editor) editor(id);
  else tip("This feature editor is not available yet", false, "warn", 3000);
}

export function closeVectorSettlement() {
  if (!vectorSettlement) return;
  vectorSettlement?.remove();
  vectorSettlement = null;
  vectorSettlementId = 0;
  vectorMap?.resize();
}

function clearPreloadedSettlement() {
  vectorPreloadedSettlement?.remove();
  vectorPreloadedSettlement = null;
  vectorPreloadedSettlementId = 0;
}

function createSettlementFrame(burgId: number, preview: string) {
  const burg = pack.burgs[burgId];
  const frame = document.createElement("iframe");
  frame.src = preview;
  frame.loading = "eager";
  frame.dataset.burgId = String(burgId);
  frame.dataset.ready = "false";
  frame.setAttribute("aria-label", `${burg.name || "Settlement"} bird's-eye map`);
  frame.addEventListener("load", () => {
    frame.dataset.ready = "true";
  });
  return frame;
}

function preloadSettlement(burgId: number) {
  if (!vectorContainer || !burgId || burgId === vectorPreloadedSettlementId || burgId === vectorSettlementId) return;
  const burg = pack.burgs[burgId];
  const previewData = Burgs.getPreview(burg);
  const preview = previewData.preview || previewData.link;
  if (!preview) return;
  clearPreloadedSettlement();
  const frame = createSettlementFrame(burgId, preview);
  frame.className = "fmg-settlement-preload";
  vectorContainer.append(frame);
  vectorPreloadedSettlement = frame;
  vectorPreloadedSettlementId = burgId;
}

export function openVectorSettlement(burgId: number) {
  const burg = pack.burgs[burgId];
  if (!burg || burg.removed || !vectorContainer) return false;
  const previewData = Burgs.getPreview(burg);
  const preview = previewData.preview || previewData.link;
  if (!preview) {
    openFeatureEditor("burg", burgId);
    tip("This settlement does not have a bird’s-eye map yet", false, "info", 3000);
    return false;
  }

  closeVectorSettlement();
  const view = document.createElement("section");
  view.className = "fmg-settlement-view";
  view.dataset.burgId = String(burgId);

  const header = document.createElement("header");
  header.className = "fmg-settlement-view__header";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "← Return to globe";
  back.addEventListener("click", () => {
    vectorSettlementExiting = true;
    closeVectorSettlement();
    vectorMap?.easeTo({ zoom: SETTLEMENT_ENTRY_ZOOM + 0.5, duration: 450 });
  });
  const title = document.createElement("strong");
  title.className = "fmg-settlement-view__title";
  title.textContent = burg.name || "Settlement";
  const inspect = document.createElement("button");
  inspect.type = "button";
  inspect.textContent = "Settlement details";
  inspect.addEventListener("click", () => openFeatureEditor("burg", burgId));
  const external = document.createElement("a");
  external.textContent = "Open original ↗";
  external.href = previewData.link || preview;
  external.target = "_blank";
  external.rel = "noopener noreferrer";
  header.append(back, title, inspect, external);

  const content = document.createElement("div");
  content.className = "fmg-settlement-view__content";
  const frame =
    vectorPreloadedSettlementId === burgId && vectorPreloadedSettlement
      ? vectorPreloadedSettlement
      : createSettlementFrame(burgId, preview);
  frame.className = "fmg-settlement-view__frame";
  vectorPreloadedSettlement = null;
  vectorPreloadedSettlementId = 0;
  content.append(frame);

  const clouds = document.createElement("div");
  clouds.className = "fmg-settlement-view__clouds";
  clouds.innerHTML = `<span>Descending through the clouds</span>`;
  content.append(clouds);
  view.append(header, content);
  view.dataset.ready = "false";
  view.dataset.interactive = "true";
  view.classList.toggle("fmg-settlement-view--low-power", vectorPerformanceProfile === "low-power");
  const descentStarted = performance.now();
  let revealed = false;
  const revealTown = () => {
    if (revealed) return;
    revealed = true;
    const minimumDescent = vectorPerformanceProfile === "low-power" ? 420 : 650;
    window.setTimeout(
      () => {
        if (view.isConnected) view.dataset.ready = "true";
      },
      Math.max(0, minimumDescent - (performance.now() - descentStarted))
    );
  };
  if (frame.dataset.ready === "true") revealTown();
  else frame.addEventListener("load", revealTown, { once: true });
  window.setTimeout(revealTown, 2500);
  vectorContainer.append(view);
  vectorSettlement = view;
  vectorSettlementId = burgId;
  return true;
}

function getBurgNearestCenter(maxDistance = 260) {
  if (!vectorMap || !vectorData) return 0;
  const center = vectorMap.project(vectorMap.getCenter());
  let closestId = 0;
  let closestDistance = maxDistance * maxDistance;
  for (const feature of vectorData.burgs.features) {
    const projected = vectorMap.project(feature.geometry.coordinates as [number, number]);
    const distance = (projected.x - center.x) ** 2 + (projected.y - center.y) ** 2;
    if (distance >= closestDistance) continue;
    const burgId = Number(feature.properties.burgId || feature.id || 0);
    if (!burgId || !Burgs.getPreview(pack.burgs[burgId])?.preview) continue;
    closestId = burgId;
    closestDistance = distance;
  }
  return closestId;
}

function updateSettlementMap() {
  if (vectorSettlementExiting) return;
  if (!vectorMap || vectorMap.getZoom() < SETTLEMENT_MAP_ZOOM) {
    closeVectorSettlement();
    return;
  }
  const burgId = getBurgNearestCenter();
  if (!burgId || burgId === vectorSettlementId) return;
  openVectorSettlement(burgId);
}

function scheduleSettlementMap() {
  if (vectorSettlementTimer) window.clearTimeout(vectorSettlementTimer);
  vectorSettlementTimer = window.setTimeout(
    () => {
      vectorSettlementTimer = 0;
      if ((vectorMap?.getZoom() || 0) >= SETTLEMENT_PRELOAD_ZOOM && !vectorSettlement) {
        preloadSettlement(getBurgNearestCenter(220));
      }
      updateSettlementMap();
    },
    vectorPerformanceProfile === "low-power" ? 100 : 60
  );
}

function getBurgIdNearPoint(point: { x: number; y: number }) {
  if (!vectorMap || !vectorData) return 0;
  const includeTowns = vectorMap.getZoom() >= 3.2;
  const radius = vectorMap.getZoom() >= SETTLEMENT_ENTRY_ZOOM ? 22 : 17;
  let closestId = 0;
  let closestDistance = radius * radius;

  for (const feature of vectorData.burgs.features) {
    if (!includeTowns && !feature.properties.capital) continue;
    const projected = vectorMap.project(feature.geometry.coordinates as [number, number]);
    const distance = (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2;
    if (distance > closestDistance) continue;
    closestId = Number(feature.properties.burgId || feature.id || 0);
    closestDistance = distance;
  }

  return closestId;
}

function handleBurgClick(point: { x: number; y: number }, alwaysOpenSettlement = false) {
  const burgId = getBurgIdNearPoint(point);
  if (!burgId) return false;
  if (alwaysOpenSettlement || (vectorMap?.getZoom() || 0) >= SETTLEMENT_ENTRY_ZOOM) {
    const burg = pack.burgs[burgId];
    vectorMap?.easeTo({
      center: mapPointToVectorLngLat([burg.x, burg.y], graphWidth, graphHeight),
      zoom: SETTLEMENT_MAP_ZOOM,
      duration: vectorPerformanceProfile === "low-power" ? 350 : 600
    });
    return true;
  }
  openFeatureEditor("burg", burgId);
  return true;
}

function attachInteractions() {
  if (!vectorMap) return;
  for (const layer of INTERACTIVE_BURG_LAYERS) {
    vectorMap.on("mouseenter", layer, () => {
      if (vectorMap) vectorMap.getCanvas().style.cursor = "pointer";
    });
    vectorMap.on("mouseleave", layer, () => {
      if (vectorMap) vectorMap.getCanvas().style.cursor = "grab";
    });
  }
  // Resolve the nearest visible settlement geometrically instead of depending
  // on the user hitting the few painted pixels of its symbol. Listening on the
  // actual canvas also keeps this reliable while MapLibre is replacing tiles.
  const canvas = vectorMap.getCanvas();
  const getCanvasPoint = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  canvas.addEventListener("click", event => handleBurgClick(getCanvasPoint(event)));
  canvas.addEventListener("dblclick", event => {
    if (!handleBurgClick(getCanvasPoint(event), true)) return;
    event.preventDefault();
    event.stopPropagation();
  });

  vectorMap.on("mouseenter", "fmg-markers", () => {
    if (vectorMap) vectorMap.getCanvas().style.cursor = "pointer";
  });
  vectorMap.on("mouseleave", "fmg-markers", () => {
    if (vectorMap) vectorMap.getCanvas().style.cursor = "grab";
  });
  vectorMap.on("click", "fmg-markers", event => {
    const id = Number(event.features?.[0]?.properties?.markerId || event.features?.[0]?.id || 0);
    if (id) openFeatureEditor("marker", id);
  });
  vectorMap.on("zoom", () => {
    updateHud();
    if ((vectorMap?.getZoom() || 0) >= SETTLEMENT_MAP_ZOOM) scheduleSettlementMap();
  });
  vectorMap.on("movestart", () => setMotionDetailPaused(true));
  vectorMap.on("moveend", scheduleSettlementMap);
  vectorMap.on("moveend", () => setMotionDetailPaused(false));
  vectorMap.on("zoomend", () => {
    if ((vectorMap?.getZoom() || 0) < SETTLEMENT_MAP_ZOOM) vectorSettlementExiting = false;
    scheduleSettlementMap();
  });
}

function setSourceData(id: string, data: GeoJSON.FeatureCollection) {
  (vectorMap?.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

function applyVectorData(data: VectorGlobeData) {
  setSourceData(SOURCE_IDS.polarCaps, data.polarCaps);
  setSourceData(SOURCE_IDS.landmasses, data.landmasses);
  setSourceData(SOURCE_IDS.land, data.land);
  setSourceData(SOURCE_IDS.lakes, data.lakes);
  setSourceData(SOURCE_IDS.coastlines, data.coastlines);
  setSourceData(SOURCE_IDS.borders, data.borders);
  setSourceData(SOURCE_IDS.routes, data.routes);
  setSourceData(SOURCE_IDS.rivers, data.rivers);
  setSourceData(SOURCE_IDS.burgs, data.burgs);
  setSourceData(SOURCE_IDS.markers, data.markers);
  setSourceData(SOURCE_IDS.stateLabels, data.stateLabels);
}

function rebuildVectorData(revision: number) {
  if (!vectorMap || revision !== vectorRevision) return;
  const startedAt = performance.now();
  const next = buildVectorGlobeData(pack, graphWidth, graphHeight, getPalette());
  vectorDataBuildMs = performance.now() - startedAt;
  if (!vectorMap || revision !== vectorRevision) return;
  vectorData = next;
  applyVectorData(next);
}

export function updateVectorGlobe() {
  if (!vectorMap) return;
  const revision = ++vectorRevision;
  if (vectorUpdateTimer) window.clearTimeout(vectorUpdateTimer);
  vectorUpdateTimer = window.setTimeout(() => {
    vectorUpdateTimer = 0;
    rebuildVectorData(revision);
  }, 100);
}

export async function createVectorGlobe(container: HTMLElement) {
  stopVectorGlobe();
  vectorContainer = container;
  vectorContainer.classList.add("fmg-vector-globe");
  vectorContainer.replaceChildren();

  const loading = document.createElement("div");
  loading.className = "fmg-vector-globe__loading";
  loading.textContent = "Drawing the vector world…";
  loading.dataset.ready = "false";
  vectorContainer.append(loading);

  try {
    const startedAt = performance.now();
    vectorData = buildVectorGlobeData(pack, graphWidth, graphHeight, getPalette());
    vectorDataBuildMs = performance.now() - startedAt;
    const deviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0);
    const lowPowerDevice = (deviceMemory > 0 && deviceMemory <= 4) || (navigator.hardwareConcurrency || 0) <= 4;
    vectorPerformanceProfile = lowPowerDevice ? "low-power" : "quality";
    vectorPixelRatio = lowPowerDevice ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    vectorMap = new maplibregl.Map({
      container: vectorContainer,
      style: createEmptyStyle(),
      center: [0, 0],
      zoom: 1.75,
      minZoom: 0,
      maxZoom: VECTOR_GLOBE_MAX_ZOOM,
      maxPitch: 0,
      renderWorldCopies: true,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: vectorPixelRatio,
      reduceMotion: lowPowerDevice,
      validateStyle: false,
      canvasContextAttributes: {
        antialias: false,
        powerPreference: lowPowerDevice ? "low-power" : "high-performance"
      }
    });
    vectorMap.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), "top-right");
    vectorMap.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");

    return await new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timeout = window.setTimeout(() => finish(false), 20_000);

      vectorMap!.once("load", () => {
        window.clearTimeout(timeout);
        try {
          vectorMap!.setProjection({ type: "globe" });
          addVectorSources(vectorData!);
          addVectorLayers();
          attachInteractions();
          createHud();
          vectorReady = true;
          // `idle` may never fire on some software / low-power WebGL drivers.
          // The first styled frame is ready at this point, so never leave an
          // invisible loading shield blocking the map's interactions.
          loading.dataset.ready = "true";
          $("#burgEditor, #markerEditor").on("dialogclose.vectorGlobe", updateVectorGlobe);
          finish(true);
        } catch (error) {
          console.error("Cannot prepare the vector globe", error);
          finish(false);
        }
      });
      vectorMap!.on("error", event => {
        if (!vectorReady && event.error) console.warn("Vector globe resource warning", event.error);
      });
    });
  } catch (error) {
    console.error("Cannot start the vector globe", error);
    stopVectorGlobe();
    return false;
  }
}

export function stopVectorGlobe() {
  if (vectorUpdateTimer) window.clearTimeout(vectorUpdateTimer);
  vectorUpdateTimer = 0;
  if (vectorSettlementTimer) window.clearTimeout(vectorSettlementTimer);
  vectorSettlementTimer = 0;
  clearPreloadedSettlement();
  vectorRevision++;
  closeVectorSettlement();
  $("#burgEditor, #markerEditor").off(".vectorGlobe");
  vectorMap?.remove();
  vectorMap = null;
  vectorData = null;
  vectorDataBuildMs = 0;
  vectorPerformanceProfile = "quality";
  vectorPixelRatio = 1;
  vectorSettlementExiting = false;
  vectorMotionDetailPaused = false;
  vectorReady = false;
  vectorStage = "World";
  vectorContainer?.classList.remove("fmg-vector-globe");
  vectorContainer = null;
}

export const isVectorGlobeActive = () => Boolean(vectorMap);
export const isVectorGlobeReady = () => vectorReady;

export function resizeVectorGlobe() {
  vectorMap?.resize();
}

export function setVectorGlobeProjection(projection: "world" | "geographic") {
  vectorMap?.setProjection({ type: projection === "geographic" ? "mercator" : "globe" });
}

export function projectVectorMapPointToScreen(x: number, y: number) {
  if (!vectorMap || !vectorContainer) return null;
  const point = vectorMap.project(mapPointToVectorLngLat([x, y], graphWidth, graphHeight));
  const rect = vectorContainer.getBoundingClientRect();
  return { x: rect.left + point.x, y: rect.top + point.y };
}

export function focusVectorGlobeOnBurg(burgId: number, zoom = SETTLEMENT_ENTRY_ZOOM + 0.4) {
  const burg = pack.burgs[burgId];
  if (!vectorMap || !burg || burg.removed) return false;
  vectorMap.jumpTo({ center: mapPointToVectorLngLat([burg.x, burg.y], graphWidth, graphHeight), zoom });
  return true;
}

export function getVectorGlobeDiagnostics() {
  return {
    renderer: "maplibre-vector",
    ready: vectorReady,
    stage: vectorStage,
    zoom: vectorMap?.getZoom() || 0,
    maxZoom: VECTOR_GLOBE_MAX_ZOOM,
    contentMaxLatitude: VECTOR_GLOBE_CONTENT_MAX_LATITUDE,
    polarCapDegrees: VECTOR_GLOBE_POLAR_CAP_DEGREES,
    dataBuildMs: vectorDataBuildMs,
    performanceProfile: vectorPerformanceProfile,
    pixelRatio: vectorPixelRatio,
    settlementEntryZoom: SETTLEMENT_ENTRY_ZOOM,
    settlementPreloadZoom: SETTLEMENT_PRELOAD_ZOOM,
    settlementMapZoom: SETTLEMENT_MAP_ZOOM,
    settlementOpen: Boolean(vectorSettlement),
    motionDetailPaused: vectorMotionDetailPaused,
    projection: vectorMap?.getProjection()?.type || "globe",
    sources: vectorMap?.getStyle()?.sources ? Object.keys(vectorMap.getStyle().sources).length : 0,
    layers: vectorMap?.getStyle()?.layers?.length || 0,
    features: vectorData
      ? {
          land: vectorData.land.features.length,
          polarCaps: vectorData.polarCaps.features.length,
          landmasses: vectorData.landmasses.features.length,
          lakes: vectorData.lakes.features.length,
          coastlines: vectorData.coastlines.features.length,
          borders: vectorData.borders.features.length,
          routes: vectorData.routes.features.length,
          rivers: vectorData.rivers.features.length,
          burgs: vectorData.burgs.features.length,
          markers: vectorData.markers.features.length
        }
      : null
  };
}

const vectorGlobe = {
  closeSettlement: closeVectorSettlement,
  create: createVectorGlobe,
  diagnostics: getVectorGlobeDiagnostics,
  focusBurg: focusVectorGlobeOnBurg,
  isActive: isVectorGlobeActive,
  isReady: isVectorGlobeReady,
  openSettlement: openVectorSettlement,
  projectMapPointToScreen: projectVectorMapPointToScreen,
  resize: resizeVectorGlobe,
  setProjection: setVectorGlobeProjection,
  stop: stopVectorGlobe,
  update: updateVectorGlobe
};

declare global {
  var VectorGlobe: typeof vectorGlobe;
}

window.VectorGlobe = vectorGlobe;
