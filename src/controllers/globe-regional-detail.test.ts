import { describe, expect, it } from "vitest";
import { getRegionalDetailXSegments, unwrapRegionalDetailX } from "./globe-regional-detail";

describe("globe regional detail longitude handling", () => {
  it("keeps geographic projection edges linear", () => {
    expect(unwrapRegionalDetailX(995, 5, 1000, false)).toBe(995);
    expect(getRegionalDetailXSegments(-20, 80, 1000, false)).toEqual([
      { unwrappedStart: 0, unwrappedEnd: 60, sourceX: 0 }
    ]);
  });

  it("unwraps and splits a world crop across the longitude seam", () => {
    expect(unwrapRegionalDetailX(995, 5, 1000, true)).toBe(-5);
    expect(getRegionalDetailXSegments(960, 100, 1000, true)).toEqual([
      { unwrappedStart: 960, unwrappedEnd: 1000, sourceX: 960 },
      { unwrappedStart: 1000, unwrappedEnd: 1060, sourceX: 0 }
    ]);
  });
});
