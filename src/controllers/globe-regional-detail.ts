export type RegionalDetailXSegment = {
  unwrappedStart: number;
  unwrappedEnd: number;
  sourceX: number;
};

export function unwrapRegionalDetailX(x: number, anchor: number, mapWidth: number, wraps: boolean) {
  if (!wraps) return x;
  const delta = ((((x - anchor + mapWidth / 2) % mapWidth) + mapWidth) % mapWidth) - mapWidth / 2;
  return anchor + delta;
}

export function getRegionalDetailXSegments(
  x: number,
  width: number,
  mapWidth: number,
  wraps: boolean
): RegionalDetailXSegment[] {
  const end = x + width;
  if (!wraps) {
    const unwrappedStart = Math.max(0, x);
    const unwrappedEnd = Math.min(mapWidth, end);
    return unwrappedEnd > unwrappedStart ? [{ unwrappedStart, unwrappedEnd, sourceX: unwrappedStart }] : [];
  }

  const segments: RegionalDetailXSegment[] = [];
  const firstWorld = Math.floor(x / mapWidth);
  const lastWorld = Math.floor((end - Math.max(Number.EPSILON, Math.abs(end) * Number.EPSILON)) / mapWidth);
  for (let world = firstWorld; world <= lastWorld; world++) {
    const unwrappedStart = Math.max(x, world * mapWidth);
    const unwrappedEnd = Math.min(end, (world + 1) * mapWidth);
    if (unwrappedEnd <= unwrappedStart) continue;
    segments.push({ unwrappedStart, unwrappedEnd, sourceX: unwrappedStart - world * mapWidth });
  }
  return segments;
}
