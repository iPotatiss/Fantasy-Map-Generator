import type { Feature, FeatureCollection, LineString, MultiLineString, Point, Polygon } from "geojson";
import { fractalizeCoastline } from "../renderers/coastline-fractal";
import type { PackedGraph } from "../types/PackedGraph";
import { getIsolines } from "../utils/pathUtils";

export const VECTOR_GLOBE_MAX_LATITUDE = 85;

type VectorProperties = Record<string, boolean | number | string | null>;

export type VectorGlobeData = {
  landmasses: FeatureCollection<Polygon, VectorProperties>;
  land: FeatureCollection<Polygon, VectorProperties>;
  lakes: FeatureCollection<Polygon, VectorProperties>;
  coastlines: FeatureCollection<LineString, VectorProperties>;
  borders: FeatureCollection<MultiLineString, VectorProperties>;
  routes: FeatureCollection<LineString, VectorProperties>;
  rivers: FeatureCollection<LineString, VectorProperties>;
  burgs: FeatureCollection<Point, VectorProperties>;
  markers: FeatureCollection<Point, VectorProperties>;
  stateLabels: FeatureCollection<Point, VectorProperties>;
};

type VectorGlobePalette = {
  stateColors: Array<string | undefined>;
  biomeColors: Array<string | undefined>;
  stateNames: Array<string | undefined>;
  useStateColors: boolean;
};

const collection = <TGeometry extends GeoJSON.Geometry>(
  features: Array<Feature<TGeometry, VectorProperties>>
): FeatureCollection<TGeometry, VectorProperties> => ({ type: "FeatureCollection", features });

export function mapPointToVectorLngLat(
  point: readonly [number, number],
  width: number,
  height: number
): [number, number] {
  const [x, y] = point;
  const longitude = (x / width) * 360 - 180;
  const latitude = VECTOR_GLOBE_MAX_LATITUDE - (y / height) * VECTOR_GLOBE_MAX_LATITUDE * 2;
  return [longitude, latitude];
}

function getClosedRing(points: Array<[number, number]>) {
  if (points.length < 3) return null;
  const first = points[0];
  const last = points.at(-1)!;
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
  return points.length >= 4 ? points : null;
}

function smoothPoints(points: Array<[number, number]>, closed: boolean, iterations = 2) {
  let result = points.slice();
  if (closed && result.length > 1) {
    const first = result[0];
    const last = result.at(-1)!;
    if (first[0] === last[0] && first[1] === last[1]) result.pop();
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    if (result.length < 3) break;
    const next: Array<[number, number]> = [];
    if (!closed) next.push(result[0]);
    const end = closed ? result.length : result.length - 1;
    for (let index = 0; index < end; index++) {
      const from = result[index];
      const to = result[(index + 1) % result.length];
      next.push([from[0] * 0.75 + to[0] * 0.25, from[1] * 0.75 + to[1] * 0.25]);
      next.push([from[0] * 0.25 + to[0] * 0.75, from[1] * 0.25 + to[1] * 0.75]);
    }
    if (!closed) next.push(result.at(-1)!);
    result = next;
  }
  return result;
}

function chainSegments(segments: Array<Array<[number, number]>>) {
  const endpointKey = ([x, y]: [number, number]) => `${x.toFixed(7)},${y.toFixed(7)}`;
  const byEndpoint = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const point of [segment[0], segment.at(-1)!]) {
      const key = endpointKey(point);
      const indices = byEndpoint.get(key) || [];
      indices.push(index);
      byEndpoint.set(key, indices);
    }
  });

  const unused = new Set(segments.map((_, index) => index));
  const lines: Array<Array<[number, number]>> = [];
  const takeConnected = (point: [number, number]) =>
    (byEndpoint.get(endpointKey(point)) || []).find(index => unused.has(index));

  while (unused.size) {
    const firstIndex = unused.values().next().value as number;
    unused.delete(firstIndex);
    const line = segments[firstIndex].slice();

    while (true) {
      const segmentIndex = takeConnected(line.at(-1)!);
      if (segmentIndex === undefined) break;
      unused.delete(segmentIndex);
      const segment = segments[segmentIndex];
      const tailKey = endpointKey(line.at(-1)!);
      const nextPoint = endpointKey(segment[0]) === tailKey ? segment.at(-1)! : segment[0];
      line.push(nextPoint);
    }
    while (true) {
      const segmentIndex = takeConnected(line[0]);
      if (segmentIndex === undefined) break;
      unused.delete(segmentIndex);
      const segment = segments[segmentIndex];
      const headKey = endpointKey(line[0]);
      const nextPoint = endpointKey(segment[0]) === headKey ? segment.at(-1)! : segment[0];
      line.unshift(nextPoint);
    }
    lines.push(line.length > 3 ? smoothPoints(line, false, 1) : line);
  }
  return lines;
}

function getFeatureRing(
  pack: PackedGraph,
  vertexIds: number[],
  featureId: number,
  featureType: "island" | "lake" | "ocean",
  width: number,
  height: number
) {
  const points = vertexIds
    .map(vertexId => pack.vertices.p[vertexId])
    .filter((point): point is [number, number] => Boolean(point));
  const fractalized = fractalizeCoastline(points, featureId, featureType).points;
  const smoothed = smoothPoints(fractalized, true, fractalized.length < 220 ? 2 : 1);
  return getClosedRing(smoothed.map(point => mapPointToVectorLngLat(point, width, height)));
}

function getSharedEdge(pack: PackedGraph, fromCell: number, toCell: number, width: number, height: number) {
  const toVertices = new Set(pack.cells.v[toCell]);
  const shared = pack.cells.v[fromCell].filter(vertexId => toVertices.has(vertexId));
  if (shared.length < 2) return null;
  return shared.slice(0, 2).map(vertexId => mapPointToVectorLngLat(pack.vertices.p[vertexId], width, height));
}

export function buildVectorGlobeData(
  pack: PackedGraph,
  width: number,
  height: number,
  palette: VectorGlobePalette
): VectorGlobeData {
  const landFeatures: Array<Feature<Polygon, VectorProperties>> = [];
  const landmassFeatures: Array<Feature<Polygon, VectorProperties>> = [];
  const lakeFeatures: Array<Feature<Polygon, VectorProperties>> = [];
  const coastlineFeatures: Array<Feature<LineString, VectorProperties>> = [];
  const stateBorderLines: Array<Array<[number, number]>> = [];
  const provinceBorderLines: Array<Array<[number, number]>> = [];

  for (const cellId of pack.cells.i) {
    if (pack.cells.h[cellId] < 20) continue;

    const stateId = Number(pack.cells.state[cellId] || 0);
    for (const neighborId of pack.cells.c[cellId]) {
      if (neighborId <= cellId || pack.cells.h[neighborId] < 20) continue;
      const sharedEdge = getSharedEdge(pack, cellId, neighborId, width, height);
      if (!sharedEdge) continue;

      const neighborState = Number(pack.cells.state[neighborId] || 0);
      const neighborProvince = Number(pack.cells.province[neighborId] || 0);
      if (stateId !== neighborState) stateBorderLines.push(sharedEdge);
      else if (Number(pack.cells.province[cellId] || 0) !== neighborProvince) provinceBorderLines.push(sharedEdge);
    }
  }

  // Render one smooth vector polygon per political or biome region instead of
  // exposing the individual Voronoi generation cells at close zoom.
  const areas = getIsolines(
    pack,
    cellId => {
      if (pack.cells.h[cellId] < 20) return null;
      const type = palette.useStateColors
        ? Number(pack.cells.state[cellId] || 0)
        : Number(pack.cells.biome[cellId] || 0);
      return type || null;
    },
    { polygons: true }
  );
  for (const [type, isoline] of Object.entries(areas)) {
    const typeId = Number(type);
    const fill = palette.useStateColors
      ? palette.stateColors[typeId] || palette.biomeColors[0] || "#d9e8c4"
      : palette.biomeColors[typeId] || palette.stateColors[0] || "#d9e8c4";
    for (const polygon of isoline.polygons || []) {
      const smoothed = smoothPoints(polygon as Array<[number, number]>, true, polygon.length < 220 ? 2 : 1);
      const ring = getClosedRing(smoothed.map(point => mapPointToVectorLngLat(point, width, height)));
      if (!ring) continue;
      landFeatures.push({
        type: "Feature",
        properties: {
          stateId: palette.useStateColors ? typeId : 0,
          biomeId: palette.useStateColors ? 0 : typeId,
          fill
        },
        geometry: { type: "Polygon", coordinates: [ring] }
      });
    }
  }

  for (const feature of pack.features.slice(1)) {
    if (!feature?.vertices?.length) continue;
    const ring = getFeatureRing(pack, feature.vertices, feature.i, feature.type, width, height);
    if (!ring) continue;

    if (feature.type === "island") {
      landmassFeatures.push({
        type: "Feature",
        id: feature.i,
        properties: { featureId: feature.i, fill: "#dce8c9" },
        geometry: { type: "Polygon", coordinates: [ring] }
      });
      coastlineFeatures.push({
        type: "Feature",
        id: feature.i,
        properties: { featureId: feature.i, kind: "coast" },
        geometry: { type: "LineString", coordinates: ring }
      });
    } else if (feature.type === "lake") {
      lakeFeatures.push({
        type: "Feature",
        id: feature.i,
        properties: { featureId: feature.i, kind: feature.group || "freshwater" },
        geometry: { type: "Polygon", coordinates: [ring] }
      });
      coastlineFeatures.push({
        type: "Feature",
        properties: { featureId: feature.i, kind: "lake" },
        geometry: { type: "LineString", coordinates: ring }
      });
    }
  }

  const borders: Array<Feature<MultiLineString, VectorProperties>> = [];
  if (provinceBorderLines.length) {
    borders.push({
      type: "Feature",
      properties: { kind: "province" },
      geometry: { type: "MultiLineString", coordinates: chainSegments(provinceBorderLines) }
    });
  }
  if (stateBorderLines.length) {
    borders.push({
      type: "Feature",
      properties: { kind: "state" },
      geometry: { type: "MultiLineString", coordinates: chainSegments(stateBorderLines) }
    });
  }

  const routes = pack.routes
    .filter(route => route?.points?.length > 1)
    .map<Feature<LineString, VectorProperties>>(route => ({
      type: "Feature",
      id: route.i,
      properties: { routeId: route.i, kind: route.group },
      geometry: {
        type: "LineString",
        coordinates: route.points.map(point => mapPointToVectorLngLat([point[0], point[1]], width, height))
      }
    }));

  const rivers = pack.rivers
    .map(river => ({
      river,
      points: river.points?.length ? river.points : river.cells.map(cellId => pack.cells.p[cellId]).filter(Boolean)
    }))
    .filter(({ points }) => points.length > 1)
    .map<Feature<LineString, VectorProperties>>(({ river, points }) => ({
      type: "Feature",
      id: river.i,
      properties: {
        riverId: river.i,
        name: river.name || "",
        width: Math.max(1, Number(river.width || river.widthFactor || 1))
      },
      geometry: {
        type: "LineString",
        coordinates: points.map(point => mapPointToVectorLngLat(point, width, height))
      }
    }));

  const burgs = pack.burgs
    .filter(burg => burg?.i && !burg.removed && Number.isFinite(burg.x) && Number.isFinite(burg.y))
    .map<Feature<Point, VectorProperties>>(burg => ({
      type: "Feature",
      id: burg.i,
      properties: {
        burgId: burg.i,
        name: burg.name || "Unnamed settlement",
        capital: Boolean(burg.capital),
        population: Number(burg.population || 0),
        group: burg.group || "town",
        stateId: Number(burg.state || 0)
      },
      geometry: { type: "Point", coordinates: mapPointToVectorLngLat([burg.x, burg.y], width, height) }
    }));

  const markerFeatures = (pack.markers || [])
    .filter(marker => !marker.hidden && Number.isFinite(marker.x) && Number.isFinite(marker.y))
    .map<Feature<Point, VectorProperties>>(marker => ({
      type: "Feature",
      id: marker.i,
      properties: {
        markerId: Number(marker.i || 0),
        name: marker.name || marker.type || "Map marker",
        icon: marker.icon || "•"
      },
      geometry: { type: "Point", coordinates: mapPointToVectorLngLat([marker.x, marker.y], width, height) }
    }));

  const stateLabels = pack.states
    .slice(1)
    .filter(state => !state?.removed && state.pole && Number.isFinite(state.pole[0]) && Number.isFinite(state.pole[1]))
    .map<Feature<Point, VectorProperties>>(state => ({
      type: "Feature",
      id: state.i,
      properties: {
        stateId: state.i,
        name: state.fullName || state.name || palette.stateNames[state.i] || "Unnamed state",
        area: Number(state.area || state.cells || 0)
      },
      geometry: { type: "Point", coordinates: mapPointToVectorLngLat(state.pole!, width, height) }
    }));

  return {
    landmasses: collection(landmassFeatures),
    land: collection(landFeatures),
    lakes: collection(lakeFeatures),
    coastlines: collection(coastlineFeatures),
    borders: collection(borders),
    routes: collection(routes),
    rivers: collection(rivers),
    burgs: collection(burgs),
    markers: collection(markerFeatures),
    stateLabels: collection(stateLabels)
  };
}
