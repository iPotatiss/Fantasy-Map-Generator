import type { Feature, FeatureCollection, LineString, MultiLineString, Point, Polygon } from "geojson";
import type { PackedGraph } from "../types/PackedGraph";
import { getIsolines } from "../utils/pathUtils";

// FMG's flat canvas is treated as a Mercator source. Using its real aspect ratio
// preserves local proportions when it wraps around 360 degrees, while a small
// ocean cap keeps the source edge away from the degenerate geographic poles.
export const VECTOR_GLOBE_MIN_POLAR_CAP_DEGREES = 10;
const VECTOR_GLOBE_MAX_LATITUDE = 90 - VECTOR_GLOBE_MIN_POLAR_CAP_DEGREES;
const VECTOR_GLOBE_MAX_MERCATOR_Y = Math.asinh(Math.tan((VECTOR_GLOBE_MAX_LATITUDE * Math.PI) / 180));

type VectorProperties = Record<string, boolean | number | string | null>;

export type VectorGlobeData = {
  polarCaps: FeatureCollection<Polygon, VectorProperties>;
  landmasses: FeatureCollection<Polygon, VectorProperties>;
  land: FeatureCollection<Polygon, VectorProperties>;
  lakes: FeatureCollection<Polygon, VectorProperties>;
  coastlines: FeatureCollection<LineString, VectorProperties>;
  borders: FeatureCollection<MultiLineString, VectorProperties>;
  routes: FeatureCollection<LineString, VectorProperties>;
  rivers: FeatureCollection<LineString, VectorProperties>;
  burgs: FeatureCollection<Point, VectorProperties>;
  /** Non-capital settlements used for world-scale density clusters. */
  burgClusters: FeatureCollection<Point, VectorProperties>;
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

export function getVectorGlobeContentMaxLatitude(width: number, height: number) {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const mercatorHalfSpan = Math.min(Math.PI / (safeWidth / safeHeight), VECTOR_GLOBE_MAX_MERCATOR_Y);
  return (Math.atan(Math.sinh(mercatorHalfSpan)) * 180) / Math.PI;
}

function getPolarCaps(contentMaxLatitude: number) {
  const features: Array<Feature<Polygon, VectorProperties>> = [];
  const longitudeStep = 10;
  const poleLatitude = 89.999;
  for (const hemisphere of [1, -1]) {
    const innerLatitude = contentMaxLatitude * hemisphere;
    const outerLatitude = poleLatitude * hemisphere;
    for (let longitude = -180; longitude < 180; longitude += longitudeStep) {
      const ring: Array<[number, number]> =
        hemisphere > 0
          ? [
              [longitude, innerLatitude],
              [longitude + longitudeStep, innerLatitude],
              [longitude + longitudeStep, outerLatitude],
              [longitude, outerLatitude],
              [longitude, innerLatitude]
            ]
          : [
              [longitude, innerLatitude],
              [longitude, outerLatitude],
              [longitude + longitudeStep, outerLatitude],
              [longitude + longitudeStep, innerLatitude],
              [longitude, innerLatitude]
            ];
      features.push({
        type: "Feature",
        properties: { kind: hemisphere > 0 ? "north" : "south" },
        geometry: {
          type: "Polygon",
          coordinates: [ring]
        }
      });
    }
  }
  return collection(features);
}

export function mapPointToVectorLngLat(
  point: readonly [number, number],
  width: number,
  height: number
): [number, number] {
  const [x, y] = point;
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const longitude = (x / safeWidth) * 360 - 180;
  const aspect = safeWidth / safeHeight;
  const mercatorHalfSpan = Math.min(Math.PI / aspect, VECTOR_GLOBE_MAX_MERCATOR_Y);
  const mercatorY = (1 - (2 * y) / safeHeight) * mercatorHalfSpan;
  const latitude = (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI;
  return [longitude, latitude];
}

function getClosedRing(points: Array<[number, number]>) {
  if (points.length < 3) return null;
  const first = points[0];
  const last = points.at(-1)!;
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
  return points.length >= 4 ? points : null;
}

type NaturalCoastGeometry = {
  edges: Map<string, Array<[number, number]>>;
  vertices: Map<string, [number, number]>;
};

const pointKey = ([x, y]: [number, number]) => `${x.toFixed(4)},${y.toFixed(4)}`;
const edgeKey = (a: [number, number], b: [number, number]) => [pointKey(a), pointKey(b)].sort().join("|");

function buildNaturalCoastGeometry(pack: PackedGraph, width: number, height: number): NaturalCoastGeometry {
  const edges = new Map<string, Array<[number, number]>>();
  const vertices = new Map<string, [number, number]>();
  const features: Array<Array<[number, number]>> = [];
  for (const feature of pack.features.slice(1)) {
    if (!feature?.vertices?.length || (feature.type !== "island" && feature.type !== "lake")) continue;
    const points = feature.vertices.map(vertexId => pack.vertices.p[vertexId]).filter(Boolean) as Array<
      [number, number]
    >;
    features.push(points);
    for (let index = 0; index < points.length; index++) {
      const previous = points[(index - 1 + points.length) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const onMapEdge = current[0] === 0 || current[0] === width || current[1] === 0 || current[1] === height;
      vertices.set(
        pointKey(current),
        onMapEdge
          ? current
          : [current[0] * 0.7 + (previous[0] + next[0]) * 0.15, current[1] * 0.7 + (previous[1] + next[1]) * 0.15]
      );
    }
  }

  const interpolate = (
    start: [number, number],
    end: [number, number],
    startTangent: [number, number],
    endTangent: [number, number],
    t: number
  ): [number, number] => {
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return [
      h00 * start[0] + h10 * startTangent[0] + h01 * end[0] + h11 * endTangent[0],
      h00 * start[1] + h10 * startTangent[1] + h01 * end[1] + h11 * endTangent[1]
    ];
  };

  for (const points of features) {
    for (let index = 0; index < points.length; index++) {
      const rawStart = points[index];
      const rawEnd = points[(index + 1) % points.length];
      const startOnEdge = rawStart[0] === 0 || rawStart[0] === width || rawStart[1] === 0 || rawStart[1] === height;
      const endOnEdge = rawEnd[0] === 0 || rawEnd[0] === width || rawEnd[1] === 0 || rawEnd[1] === height;
      if (startOnEdge && endOnEdge) continue;

      const previous = vertices.get(pointKey(points[(index - 1 + points.length) % points.length]))!;
      const start = vertices.get(pointKey(rawStart))!;
      const end = vertices.get(pointKey(rawEnd))!;
      const next = vertices.get(pointKey(points[(index + 2) % points.length]))!;
      const startTangent: [number, number] = [(end[0] - previous[0]) * 0.28, (end[1] - previous[1]) * 0.28];
      const endTangent: [number, number] = [(next[0] - start[0]) * 0.28, (next[1] - start[1]) * 0.28];
      const curve = [
        start,
        interpolate(start, end, startTangent, endTangent, 1 / 3),
        interpolate(start, end, startTangent, endTangent, 2 / 3),
        end
      ];
      edges.set(edgeKey(rawStart, rawEnd), pointKey(rawStart) < pointKey(rawEnd) ? curve : curve.reverse());
    }
  }
  return { edges, vertices };
}

function naturalizeRing(points: Array<[number, number]>, coast: NaturalCoastGeometry) {
  const result: Array<[number, number]> = [];
  for (let index = 0; index < points.length; index++) {
    const rawStart = points[index];
    const rawEnd = points[(index + 1) % points.length];
    const start = coast.vertices.get(pointKey(rawStart)) || rawStart;
    const end = coast.vertices.get(pointKey(rawEnd)) || rawEnd;
    if (!result.length) result.push(start);
    const storedCurve = coast.edges.get(edgeKey(rawStart, rawEnd));
    if (storedCurve) {
      const curve = pointKey(rawStart) < pointKey(rawEnd) ? storedCurve : storedCurve.toReversed();
      result.push(...curve.slice(1, -1));
    }
    result.push(end);
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
    // Keep shared boundaries topologically exact. Smoothing each visual layer
    // independently creates gaps and overlaps where states meet the coast.
    lines.push(line);
  }
  return lines;
}

function getFeatureRing(
  pack: PackedGraph,
  vertexIds: number[],
  width: number,
  height: number,
  coast: NaturalCoastGeometry
) {
  const points = vertexIds
    .map(vertexId => pack.vertices.p[vertexId])
    .filter((point): point is [number, number] => Boolean(point));
  return getClosedRing(naturalizeRing(points, coast).map(point => mapPointToVectorLngLat(point, width, height)));
}

function getSharedEdge(
  pack: PackedGraph,
  fromCell: number,
  toCell: number,
  width: number,
  height: number,
  coast?: NaturalCoastGeometry
) {
  const toVertices = new Set(pack.cells.v[toCell]);
  const shared = pack.cells.v[fromCell].filter(vertexId => toVertices.has(vertexId));
  if (shared.length < 2) return null;
  return shared.slice(0, 2).map(vertexId => {
    const point = pack.vertices.p[vertexId];
    const alignedPoint = coast?.vertices.get(pointKey(point)) || point;
    return mapPointToVectorLngLat(alignedPoint, width, height);
  });
}

export function getRiverDisplayPoints(
  pack: PackedGraph,
  river: PackedGraph["rivers"][number]
): Array<[number, number]> {
  const cells = river.cells || [];
  if (!cells.length) return (river.points || []).map(point => [point[0], point[1]]);
  const landCells: number[] = [];
  let firstWaterCell: number | null = null;
  for (const cellId of cells) {
    if (pack.cells.h[cellId] < 20) {
      firstWaterCell = cellId;
      break;
    }
    landCells.push(cellId);
  }

  const customPointsMatchCells = river.points?.length === cells.length;
  const points: Array<[number, number]> = [];
  landCells.forEach((cellId, index) => {
    const customPoint = customPointsMatchCells ? river.points?.[index] : null;
    const point =
      customPoint && Number.isFinite(customPoint[0]) && Number.isFinite(customPoint[1])
        ? customPoint
        : pack.cells.p[cellId];
    if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
    points.push([point[0], point[1]]);
  });

  const mouthCell = landCells.at(-1);
  if (mouthCell !== undefined && firstWaterCell !== null) {
    const waterVertices = new Set(pack.cells.v[firstWaterCell]);
    const shorelineVertices = pack.cells.v[mouthCell].filter(vertexId => waterVertices.has(vertexId));
    if (shorelineVertices.length >= 2) {
      const [a, b] = shorelineVertices.slice(0, 2).map(vertexId => pack.vertices.p[vertexId]);
      points.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
  }
  return points;
}

export function buildVectorGlobeData(
  pack: PackedGraph,
  width: number,
  height: number,
  palette: VectorGlobePalette
): VectorGlobeData {
  const contentMaxLatitude = getVectorGlobeContentMaxLatitude(width, height);
  const landFeatures: Array<Feature<Polygon, VectorProperties>> = [];
  const landmassFeatures: Array<Feature<Polygon, VectorProperties>> = [];
  const lakeFeatures: Array<Feature<Polygon, VectorProperties>> = [];
  const coastlineFeatures: Array<Feature<LineString, VectorProperties>> = [];
  const stateBorderLines: Array<Array<[number, number]>> = [];
  const provinceBorderLines: Array<Array<[number, number]>> = [];
  const naturalCoast = buildNaturalCoastGeometry(pack, width, height);

  for (const cellId of pack.cells.i) {
    if (pack.cells.h[cellId] < 20) continue;

    const stateId = Number(pack.cells.state[cellId] || 0);
    for (const neighborId of pack.cells.c[cellId]) {
      if (neighborId <= cellId || pack.cells.h[neighborId] < 20) continue;
      const sharedEdge = getSharedEdge(pack, cellId, neighborId, width, height, naturalCoast);
      if (!sharedEdge) continue;

      const neighborState = Number(pack.cells.state[neighborId] || 0);
      const neighborProvince = Number(pack.cells.province[neighborId] || 0);
      if (stateId !== neighborState) stateBorderLines.push(sharedEdge);
      else if (Number(pack.cells.province[cellId] || 0) !== neighborProvince) provinceBorderLines.push(sharedEdge);
    }
  }

  // Render one vector polygon per political or biome region instead of
  // exposing individual Voronoi cells. Do not deform these rings: their outer
  // vertices must stay identical to the landmass and lake boundaries.
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
      const ring = getClosedRing(
        naturalizeRing(polygon as Array<[number, number]>, naturalCoast).map(point =>
          mapPointToVectorLngLat(point, width, height)
        )
      );
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
    const ring = getFeatureRing(pack, feature.vertices, width, height, naturalCoast);
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
      points: getRiverDisplayPoints(pack, river)
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
    polarCaps: getPolarCaps(contentMaxLatitude),
    landmasses: collection(landmassFeatures),
    land: collection(landFeatures),
    lakes: collection(lakeFeatures),
    coastlines: collection(coastlineFeatures),
    borders: collection(borders),
    routes: collection(routes),
    rivers: collection(rivers),
    burgs: collection(burgs),
    burgClusters: collection(burgs.filter(burg => !burg.properties.capital)),
    markers: collection(markerFeatures),
    stateLabels: collection(stateLabels)
  };
}
