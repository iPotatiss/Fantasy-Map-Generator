import { describe, expect, it } from "vitest";
import { capGeneratedHeight, distanceToPolygonEdge, pointsInsidePolygon, smoothstep01 } from "./landmass-recipe";

type Point = [number, number];

const square: Point[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10]
];

// concave "C" shape: a 10x10 square with a 6x6 notch cut from the right side
const concave: Point[] = [
  [0, 0],
  [10, 0],
  [10, 2],
  [4, 2],
  [4, 8],
  [10, 8],
  [10, 10],
  [0, 10]
];

describe("pointsInsidePolygon", () => {
  it("returns indices of points inside a square", () => {
    const points: Point[] = [
      [5, 5], // inside
      [1, 1], // inside
      [15, 5], // outside bbox
      [-1, 5], // outside bbox
      [5, 15] // outside bbox
    ];
    expect(pointsInsidePolygon(points, square)).toEqual([0, 1]);
  });

  it("excludes points inside the bbox but outside a concave polygon", () => {
    const points: Point[] = [
      [7, 5], // in the notch: inside bbox, outside polygon
      [2, 5], // in the spine: inside
      [7, 1] // in the top arm: inside
    ];
    expect(pointsInsidePolygon(points, concave)).toEqual([1, 2]);
  });
});

describe("distanceToPolygonEdge", () => {
  it("measures distance to the closest edge of a square", () => {
    expect(distanceToPolygonEdge([5, 5], square)).toBeCloseTo(5);
    expect(distanceToPolygonEdge([1, 5], square)).toBeCloseTo(1);
    expect(distanceToPolygonEdge([5, 9], square)).toBeCloseTo(1);
  });

  it("measures distance to a vertex when the closest point is a corner", () => {
    expect(distanceToPolygonEdge([13, 14], square)).toBeCloseTo(5); // 3-4-5 from corner [10, 10]
  });

  it("uses the notch edges of a concave polygon", () => {
    expect(distanceToPolygonEdge([3, 5], concave)).toBeCloseTo(1); // closest is the notch wall at x=4
  });
});

describe("smoothstep01", () => {
  it("clamps and interpolates", () => {
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(0)).toBe(0);
    expect(smoothstep01(0.5)).toBeCloseTo(0.5);
    expect(smoothstep01(1)).toBe(1);
    expect(smoothstep01(2)).toBe(1);
  });

  it("eases at the ends", () => {
    expect(smoothstep01(0.1)).toBeLessThan(0.1);
    expect(smoothstep01(0.9)).toBeGreaterThan(0.9);
  });
});

describe("capGeneratedHeight", () => {
  it("stops overlapping procedural hills exceeding the selected terrain ceiling", () => {
    expect(capGeneratedHeight(0, 87, 48)).toBe(48);
  });

  it("does not lower pre-existing mountains when extending a landmass", () => {
    expect(capGeneratedHeight(72, 45, 48)).toBe(72);
  });
});
