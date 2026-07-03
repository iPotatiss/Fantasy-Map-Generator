import { polygonContains } from "d3";
import type { PackedGraphFeature } from "../modules/features";
import { unique } from "../utils";

/**
 * Coastline reshape — commit step (Feature 1, Phase 1).
 *
 * The legacy coastline editor (public/modules/ui/coastline-editor.js) lets the user
 * click a landmass outline and drag its vertices, previewing the reshaped coast live.
 * That edit is purely cosmetic — it moves pack.vertices.p and is lost on save/load,
 * because pack geometry is rebuilt from grid heights by reGraph() on load.
 *
 * This turns the drag into a real edit: it reclassifies the underlying grid cells
 * across the sea-level threshold (h = 20) to match the dragged outline, reusing the
 * point-in-polygon rasterizer, then runs the heightmap editor's Risk-mode restore
 * (window.commitCoastlineReshape) so rivers, biomes and states rebuild consistently.
 * Because it writes grid.cells.h — which the .map format serializes — the edit persists.
 */

declare global {
  // legacy globals (assigned in public/modules/ui/*.js)
  var elSelected: { attr: (name: string) => string } | null;
  var unselect: () => void;
  var commitCoastlineReshape: () => void;

  interface Window {
    CoastlineTerrain: { apply: () => void };
  }
}

const SHELF_HEIGHT = 15; // shallow water for cells dropped below sea level
const LAND_HEIGHT = 21; // thin land for cells raised above sea level

/** Grid cells belonging to a pack feature, via the pack→grid parent link. */
function featureGridCells(featureId: number): number[] {
  const { cells } = pack;
  const gridCells: number[] = [];
  for (const i of cells.i) {
    if (cells.f[i] === featureId) gridCells.push(cells.g[i]);
  }
  return unique(gridCells);
}

function apply(): void {
  if (customization) return; // reshape runs on the live map, not inside the heightmap editor
  if (!elSelected) {
    tip("Select a coastline first", false, "error");
    return;
  }

  const featureId = +elSelected.attr("data-f");
  const feature = pack.features[featureId] as PackedGraphFeature | undefined;
  if (!feature || feature.type !== "island") {
    tip("Select a landmass coastline to reshape", false, "error");
    return;
  }

  // reshaped outline in map coordinates (vertices were moved live by the drag handler)
  const outline = feature.vertices.map(v => pack.vertices.p[v]) as [number, number][];
  if (outline.length < 3) {
    tip("This coastline is too small to reshape", false, "warn");
    return;
  }

  const heights = grid.cells.h as Uint8Array;

  // candidate cells = the feature's own grid cells plus one ring of neighbours; the
  // per-vertex drag clamp keeps edits within ~1 cell, so the flipped band lies here
  const featureCells = featureGridCells(featureId);
  const featureSet = new Set(featureCells);
  const candidates = new Set<number>(featureCells);
  for (const c of featureCells) {
    for (const n of grid.cells.c[c]) candidates.add(n);
  }

  const changed: number[] = [];
  let becameLand = 0;
  let becameWater = 0;
  for (const c of candidates) {
    const inside = polygonContains(outline, grid.points[c]);
    if (inside && heights[c] < 20) {
      heights[c] = LAND_HEIGHT; // water pulled inside the new coast → land
      changed.push(c);
      becameLand++;
    } else if (!inside && heights[c] >= 20 && featureSet.has(c)) {
      heights[c] = SHELF_HEIGHT; // land pushed outside the new coast → water
      changed.push(c);
      becameWater++;
    }
  }

  if (!changed.length) {
    tip("No cells crossed the coastline — drag a control point further, then apply", false, "warn");
    return;
  }

  commitCoastlineReshape();

  // the pack (and this feature's DOM) was rebuilt; drop the stale vertex overlay
  const dialog = $("#coastlineEditor");
  if (dialog.length && dialog.dialog("instance") && dialog.dialog("isOpen")) dialog.dialog("close");
  else unselect();

  tip(`Coastline reshaped: +${becameLand} land, −${becameWater} water cells`, false, "success", 4000);
}

window.CoastlineTerrain = { apply };
