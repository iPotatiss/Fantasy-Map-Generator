import { generateLandmassInPolygon, type LandmassOptions, pointsInsidePolygon } from "../modules/landmass-recipe";
import { ensureEl } from "../utils";

interface HeightmapEditorContext {
  updateHistory: (noStat?: boolean) => void;
  mockHeightmapSelection: (selection: number[]) => void;
}

export interface RegionDraftOptions extends LandmassOptions {
  nations?: number;
  nationShares?: number[];
}

interface RegionDraftSummary {
  id: string;
  pointCount: number;
  cellCount: number;
  existingLandPercent: number;
}

declare global {
  var editHeightmap: (options?: { mode?: string; tool?: string }) => void;
  var heightmapEditorContext: HeightmapEditorContext | undefined;
  interface Window {
    LandmassDraw: {
      toggle: () => void;
      applyDraft: (options: RegionDraftOptions) => { changed: number; landCells: number };
      cancelDraft: () => void;
    };
    VTT_REGION_STATE_SHARES?: number[];
  }
}

const BUTTON_ID = "drawLandmass";
const TRACE_ID = "landmassTrace";
let active = false;
let draftPolygon: [number, number][] | null = null;
let draftId = "";

function embedded(): boolean {
  return document.documentElement.classList.contains("vtt-embedded");
}

function injectButton(): void {
  const tools = document.getElementById("customizeTools");
  if (!tools || document.getElementById(BUTTON_ID)) return;
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.dataset.tip = "Draw a freeform region, then choose what it becomes";
  button.textContent = "Freeform Region";
  const anchor = document.getElementById("paintBrushes");
  if (anchor) anchor.insertAdjacentElement("afterend", button);
  else tools.appendChild(button);
  button.on("click", toggle);
  document.getElementById("brushesButtons")?.on("click", () => {
    if (active) exit(false);
  });
}

function toggle(): void {
  if (active) exit(false);
  else enter();
}

function enter(): void {
  if (customization !== 0 && customization !== 1) {
    tip("Finish the current map tool before drawing a freeform region", false, "error");
    return;
  }
  active = true;
  document.querySelector("#brushesButtons > button.pressed")?.classList.remove("pressed");
  removeCircle();
  ensureEl(BUTTON_ID).classList.add("pressed");
  const d3 = (window as any).d3;
  viewbox.style("cursor", "crosshair").call(d3.drag().on("start", onDrawStart));
  tip("Draw freely around a region. Release to configure it before anything is generated", true);
}

function exit(removeDraft = true): void {
  active = false;
  document.getElementById(BUTTON_ID)?.classList.remove("pressed");
  viewbox.style("cursor", "default").on(".drag", null);
  if (removeDraft) clearDraft();
  clearMainTip();
}

function clearDraft(): void {
  draftPolygon = null;
  draftId = "";
  debug.select(`#${TRACE_ID}`).remove();
}

function drawTrace(points: [number, number][]): void {
  debug.select(`#${TRACE_ID}`).remove();
  debug
    .append("path")
    .attr("id", TRACE_ID)
    .attr("d", `M${points.map(point => point.join(",")).join("L")}Z`)
    .attr("fill", "rgba(36, 133, 219, 0.2)")
    .attr("stroke", "#1473c9")
    .attr("stroke-width", 2)
    .attr("stroke-dasharray", "6 3")
    .attr("pointer-events", "none");
}

function onDrawStart(): void {
  const d3 = (window as any).d3;
  const points: [number, number][] = [];
  const addPoint = (x: number, y: number) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last[0] - x) < 0.5 && Math.abs(last[1] - y) < 0.5) return;
    points.push([rn(x, 2), rn(y, 2)]);
    drawTrace(points);
  };
  addPoint(d3.event.x, d3.event.y);
  d3.event.on("drag", () => addPoint(d3.event.x, d3.event.y));
  d3.event.on("end", () => prepareDraft(points));
}

function prepareDraft(rawPoints: [number, number][]): void {
  const tolerance = Math.max(0.5, grid.spacing / 4);
  const polygon = simplify(rawPoints, tolerance) as [number, number][];
  if (polygon.length < 3) {
    clearDraft();
    tip("The shape is too small. Draw a larger region", false, "warn");
    return;
  }
  const cells = pointsInsidePolygon(grid.points, polygon);
  if (cells.length < 6) {
    clearDraft();
    tip("The shape covers too little of the map. Draw a larger region", false, "warn");
    return;
  }
  draftPolygon = polygon;
  draftId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  drawTrace(polygon);
  const landCells = cells.filter(i => grid.cells.h[i] >= 20).length;
  const summary: RegionDraftSummary = {
    id: draftId,
    pointCount: polygon.length,
    cellCount: cells.length,
    existingLandPercent: Math.round((landCells / cells.length) * 100)
  };
  if (embedded()) {
    window.dispatchEvent(new CustomEvent("map:region-draft", { detail: summary }));
    tip("Region outlined. Choose its recipe in the World Map Maker panel", true);
  } else {
    applyDraft({ operation: "landmass", peakHeight: 50, coastFalloff: 0.35 });
  }
}

function setGenerationTargets(options: RegionDraftOptions): void {
  if (typeof options.nations === "number") {
    const states = document.getElementById("statesNumber") as HTMLInputElement | null;
    if (states) states.value = String(Math.max(0, Math.min(30, Math.round(options.nations))));
  }
  const shares = options.nationShares?.filter(value => Number.isFinite(value) && value > 0);
  window.VTT_REGION_STATE_SHARES = shares?.length ? shares : undefined;
  if (shares?.length) {
    const range = Math.max(...shares) - Math.min(...shares);
    const variety = document.getElementById("sizeVariety") as HTMLInputElement | null;
    if (variety) variety.value = String(Math.max(1, Math.min(10, 1 + range / 5)));
  }
}

function applyDraft(options: RegionDraftOptions): { changed: number; landCells: number } {
  if (!draftPolygon) throw new Error("Draw a freeform region first");
  if (customization !== 1) {
    const mode = pack?.cells?.i?.length ? "risk" : "erase";
    editHeightmap({ mode, tool: "landmassApply" });
  }
  if (customization !== 1 || !heightmapEditorContext)
    throw new Error("The terrain editor could not prepare this region");
  setGenerationTargets(options);
  const result = generateLandmassInPolygon(draftPolygon, options);
  if (!result)
    throw new Error(options.operation === "lake" ? "Draw over a larger area of land" : "Draw a larger region");
  heightmapEditorContext?.mockHeightmapSelection(result.changed);
  heightmapEditorContext?.updateHistory();
  clearDraft();
  exit(false);

  const finalize = document.getElementById("finalizeHeightmap") as HTMLButtonElement | null;
  if (!finalize) throw new Error("The terrain editor could not be finalized");
  finalize.click();
  const detail = { changed: result.changed.length, landCells: result.landCells };
  window.dispatchEvent(new CustomEvent("map:region-applied", { detail }));
  tip("Region generated. Draw another area whenever you want to refine it", false, "success", 4000);
  return detail;
}

function cancelDraft(): void {
  clearDraft();
  exit(false);
  window.dispatchEvent(new CustomEvent("map:region-cancelled"));
  if (customization !== 1) {
    restoreDefaultEvents();
    return;
  }
  const hasGeneratedMap = Boolean(pack?.cells?.i?.length);
  if (hasGeneratedMap) {
    (document.getElementById("finalizeHeightmap") as HTMLButtonElement | null)?.click();
  } else {
    // A blank project has no packed map to restore. Reloading only rebuilds its
    // empty ocean grid and cleanly leaves heightmap customization without data loss.
    window.setTimeout(() => window.location.reload(), 0);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectButton);
else injectButton();

window.LandmassDraw = { toggle, applyDraft, cancelDraft };
