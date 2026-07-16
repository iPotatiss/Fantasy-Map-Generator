import { describe, expect, it } from "vitest";
import {
  allocateByWeight,
  directWaterCoverage,
  getCapitalImportanceMultiplier,
  getSettlementDensityMultiplier
} from "./generation-director";

describe("generation director", () => {
  it("converges on the requested water percentage deterministically", () => {
    const heights = Uint8Array.from({ length: 100 }, (_, index) => index);
    const first = directWaterCoverage(heights, 71);
    const second = directWaterCoverage(heights, 71);

    expect(Array.from(first)).toEqual(Array.from(second));
    expect(Array.from(first).filter(height => height < 20)).toHaveLength(71);
  });

  it("preserves relative elevation order while moving the shoreline", () => {
    const result = directWaterCoverage(Uint8Array.from([5, 20, 40, 60, 90]), 40);
    expect(Array.from(result)).toEqual([...result].sort((a, b) => a - b));
    expect(Array.from(result).filter(height => height < 20)).toHaveLength(2);
  });

  it("maps plain-language density and capital direction to stable multipliers", () => {
    expect(getSettlementDensityMultiplier("sparse")).toBeLessThan(1);
    expect(getSettlementDensityMultiplier("dense")).toBeGreaterThan(1);
    expect(getCapitalImportanceMultiplier("natural")).toBe(0);
    expect(getCapitalImportanceMultiplier("dominant")).toBeGreaterThan(getCapitalImportanceMultiplier("prominent"));
  });

  it("allocates settlements proportionally while preserving a realm minimum", () => {
    const allocation = allocateByWeight(
      12,
      [
        { id: 1, weight: 10 },
        { id: 2, weight: 30 },
        { id: 3, weight: 60 }
      ],
      1
    );

    expect([...allocation.values()].reduce((sum, count) => sum + count, 0)).toBe(12);
    expect(allocation.get(1)).toBeGreaterThanOrEqual(1);
    expect(allocation.get(3)).toBeGreaterThan(allocation.get(2)!);
  });
});
