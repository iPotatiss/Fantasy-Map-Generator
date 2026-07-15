import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clipPoly, getGridPolygon, getIsolines } from "../utils";

vi.mock("../utils", () => ({
  clipPoly: vi.fn(points => points),
  getGridPolygon: vi.fn(() => [
    [0, 0],
    [2, 0],
    [1, 2]
  ]),
  getIsolines: vi.fn(() => ({})),
  lerp: vi.fn((a: number, b: number, t: number) => a + (b - a) * t),
  ra: vi.fn(() => 0),
  rn: vi.fn((value: number) => value)
}));

describe("Ice generation", () => {
  let Ice: { generate: () => void; addIceberg: (cellId: number, size: number) => void };

  beforeAll(async () => {
    globalThis.window = globalThis as unknown as Window & typeof globalThis;
    await import("./ice");
    Ice = globalThis.Ice;
  });

  beforeEach(() => {
    globalThis.graphWidth = 100;
    globalThis.graphHeight = 50;
    globalThis.pack = { ice: [{ i: 99, points: [], type: "iceberg" }] } as any;
    globalThis.grid = {
      cells: {
        i: Uint16Array.from([0, 1, 2, 3]),
        h: Uint8Array.from([0, 0, 0, 0]),
        temp: Int8Array.from([-20, -18, -16, -14])
      },
      points: [
        [1, 1],
        [3, 1],
        [5, 1],
        [7, 1]
      ]
    } as any;
    globalThis.redrawIceberg = vi.fn();

    vi.mocked(getIsolines).mockReturnValue({});
    vi.mocked(clipPoly).mockImplementation(points => points);
    vi.mocked(getGridPolygon).mockReturnValue([
      [0, 0],
      [2, 0],
      [1, 2]
    ]);
  });

  it("does not scatter icebergs across cold ocean cells", () => {
    Ice.generate();

    expect(pack.ice).toEqual([]);
  });

  it("keeps contiguous land glaciers", () => {
    const glacierPoints: [number, number][] = [
      [10, 2],
      [20, 2],
      [20, 8],
      [10, 8]
    ];
    vi.mocked(getIsolines).mockReturnValue({ iceShield: { polygons: [glacierPoints] } });

    Ice.generate();

    expect(pack.ice).toEqual([{ i: 0, points: glacierPoints, type: "glacier" }]);
  });

  it("still allows an iceberg to be placed intentionally", () => {
    pack.ice = [];

    Ice.addIceberg(0, 0.5);

    expect(pack.ice).toEqual([
      {
        i: 0,
        points: [
          [0.5, 0.5],
          [1.5, 0.5],
          [1, 1.5]
        ],
        type: "iceberg",
        cellId: 0,
        size: 0.5
      }
    ]);
    expect(redrawIceberg).toHaveBeenCalledWith(0);
  });
});
