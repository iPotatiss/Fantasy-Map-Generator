import { polygonArea, polygonContains } from "d3";
import polylabel from "polylabel";
import { findGridCell, lim, minmax, rand, rn } from "../utils";

type Point = [number, number];

export interface LandmassOptions {
  peakHeight: number; // height of the main peak, [25, 90] on the 0-100 scale
  coastFalloff: number; // coastal falloff width as a fraction of the shape's effective radius, [0.1, 0.8]
}

export interface LandmassResult {
  changed: number[]; // grid cell ids whose height changed
  landCells: number; // cells that were water and became land (h >= 20)
}

const MIN_CELLS = 6;
const SHELF_HEIGHT = 15; // shallow water right at the drawn outline
const BASE_HEIGHT = 21; // guaranteed land fill under the procedural detail

/** Indices of points strictly inside the polygon (bbox-prefiltered). */
export function pointsInsidePolygon(points: Point[], polygon: Point[]): number[] {
  const [minX, minY, maxX, maxY] = getBbox(polygon);
  const inside: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (polygonContains(polygon, points[i])) inside.push(i);
  }
  return inside;
}

/** Distance from a point to the closest edge of the polygon. */
export function distanceToPolygonEdge([px, py]: Point, polygon: Point[]): number {
  let min = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const abx = bx - ax;
    const aby = by - ay;
    const lengthSquared = abx * abx + aby * aby;
    const t = lengthSquared ? minmax(((px - ax) * abx + (py - ay) * aby) / lengthSquared, 0, 1) : 0;
    const dx = px - (ax + abx * t);
    const dy = py - (ay + aby * t);
    const distSquared = dx * dx + dy * dy;
    if (distSquared < min) min = distSquared;
  }
  return Math.sqrt(min);
}

export function smoothstep01(t: number): number {
  const x = minmax(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function getBbox(polygon: Point[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function nearestCell([x, y]: Point, pool: number[]): number {
  let best = pool[0];
  let min = Infinity;
  for (const i of pool) {
    const [px, py] = grid.points[i];
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < min) {
      min = d;
      best = i;
    }
  }
  return best;
}

/** For elongated shapes returns [start, end] cells for a ridge along the long axis, else null. */
function getRidgeCells(polygon: Point[], pool: number[]): [number, number] | null {
  const [minX, minY, maxX, maxY] = getBbox(polygon);
  const width = maxX - minX;
  const height = maxY - minY;
  if (Math.max(width, height) < Math.min(width, height) * 1.8) return null;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const horizontal = width > height;
  const a: Point = horizontal ? [minX + width * 0.25, cy] : [cx, minY + height * 0.25];
  const b: Point = horizontal ? [minX + width * 0.75, cy] : [cx, minY + height * 0.75];
  const start = nearestCell(a, pool);
  const end = nearestCell(b, pool);
  return start === end ? null : [start, end];
}

/**
 * Generate a landmass inside a user-drawn closed polygon (map coordinates), mutating grid.cells.h only.
 * Runs the standard heightmap tools constrained to the cells inside the polygon, then shapes the result
 * to the outline: full height in the interior, tapering to a shallow shelf at the drawn edge.
 * Never lowers pre-existing terrain. Returns null if the polygon covers too few cells.
 */
export function generateLandmassInPolygon(polygon: Point[], options: LandmassOptions): LandmassResult | null {
  const inside = pointsInsidePolygon(grid.points, polygon);
  if (inside.length < MIN_CELLS) return null;

  const heights = grid.cells.h as Uint8Array;
  const original = Uint8Array.from(heights);
  const allowed = new Set(inside);

  const area = Math.abs(polygonArea(polygon));
  const radius = Math.sqrt(area / Math.PI);
  const falloff = Math.max(grid.spacing * 1.5, options.coastFalloff * radius);
  const distances = new Map<number, number>();
  for (const i of inside) distances.set(i, distanceToPolygonEdge(grid.points[i], polygon));

  // base fill guarantees a contiguous landmass under the procedural detail
  for (const i of inside) heights[i] = Math.max(heights[i], BASE_HEIGHT);

  HeightmapGenerator.setGraph(grid);
  HeightmapGenerator.setAllowedCells(allowed);

  const peak = minmax(options.peakHeight, 25, 90);

  // main peak at the pole of inaccessibility (most interior point, robust for concave shapes)
  const pole = polylabel([polygon], grid.spacing / 2) as unknown as Point;
  let poleCell = findGridCell(pole[0], pole[1], grid);
  if (!allowed.has(poleCell)) poleCell = nearestCell(pole, inside);
  HeightmapGenerator.addHill("1", String(peak), "", "", poleCell);

  // secondary hills seeded on interior cells
  const interior = inside.filter(i => distances.get(i)! > falloff * 0.4);
  const seedPool = interior.length ? interior : inside;
  const hillCount = minmax(Math.round(inside.length / 100), 1, 12);
  const hillHeight = `${Math.round(peak * 0.3)}-${Math.round(peak * 0.6)}`;
  for (let n = 0; n < hillCount; n++) {
    HeightmapGenerator.addHill("1", hillHeight, "", "", seedPool[rand(0, seedPool.length - 1)]);
  }

  // ridge along the long axis for elongated shapes
  const ridge = getRidgeCells(polygon, seedPool);
  if (ridge) HeightmapGenerator.addRange("1", String(Math.round(peak * 0.7)), "", "", ridge[0], ridge[1]);

  HeightmapGenerator.smooth(2);

  const generated = HeightmapGenerator.getHeights();
  HeightmapGenerator.setAllowedCells(null);
  if (!generated) return null;

  // shape to the drawn outline; never lower pre-existing terrain
  const changed: number[] = [];
  let landCells = 0;
  for (const i of inside) {
    const s = smoothstep01(distances.get(i)! / falloff);
    let shaped = SHELF_HEIGHT + (generated[i] - SHELF_HEIGHT) * s;
    if (s > 0.5) shaped = Math.max(shaped, BASE_HEIGHT);
    const value = lim(Math.max(original[i], rn(shaped)));
    heights[i] = value;
    if (value !== original[i]) {
      changed.push(i);
      if (value >= 20 && original[i] < 20) landCells++;
    }
  }

  return { changed, landCells };
}
