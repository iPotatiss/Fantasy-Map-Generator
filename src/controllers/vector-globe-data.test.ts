import { describe, expect, it } from "vitest";
import type { PackedGraph } from "../types/PackedGraph";
import { buildVectorGlobeData, mapPointToVectorLngLat } from "./vector-globe-data";

describe("vector globe data", () => {
  it("maps the rectangular FMG extent into a pole-safe longitude and latitude range", () => {
    expect(mapPointToVectorLngLat([0, 0], 1000, 500)).toEqual([-180, 67.5]);
    expect(mapPointToVectorLngLat([500, 250], 1000, 500)).toEqual([0, 0]);
    expect(mapPointToVectorLngLat([1000, 500], 1000, 500)).toEqual([180, -67.5]);
  });

  it("keeps routes, rivers and settlements as semantic vector features", () => {
    const graph = {
      cells: {
        i: [],
        c: [],
        v: [],
        p: [],
        h: new Uint8Array(),
        state: new Uint8Array(),
        province: new Uint8Array(),
        biome: new Uint8Array()
      },
      vertices: {
        p: [
          [0, 0],
          [1000, 0],
          [1000, 500],
          [0, 500]
        ]
      },
      features: [null, { i: 1, type: "island", vertices: [0, 1, 2, 3] }],
      routes: [
        {
          i: 1,
          group: "roads",
          feature: 1,
          points: [
            [0, 0],
            [1000, 500]
          ]
        }
      ],
      rivers: [
        {
          i: 1,
          source: 0,
          mouth: 1,
          parent: 0,
          basin: 1,
          length: 1,
          discharge: 1,
          width: 2,
          widthFactor: 1,
          sourceWidth: 1,
          name: "Test River",
          type: "River",
          cells: [],
          points: [
            [250, 125],
            [750, 375]
          ]
        }
      ],
      burgs: [0, { i: 1, cell: 0, x: 500, y: 250, name: "Center", population: 10 }],
      markers: [],
      states: [],
      provinces: [],
      cultures: [],
      religions: [],
      zones: [],
      ice: [],
      goods: [],
      markets: [],
      deals: []
    } as unknown as PackedGraph;

    const data = buildVectorGlobeData(graph, 1000, 500, {
      stateColors: [],
      biomeColors: [],
      stateNames: [],
      useStateColors: true
    });

    expect(data.routes.features[0].geometry.coordinates).toEqual([
      [-180, 67.5],
      [180, -67.5]
    ]);
    expect(data.rivers.features[0].properties.name).toBe("Test River");
    expect(data.polarCaps.features).toHaveLength(72);
    expect(
      data.polarCaps.features.every(
        feature => feature.properties.kind === "north" || feature.properties.kind === "south"
      )
    ).toBe(true);
    expect(
      data.polarCaps.features.every(feature => {
        const ring = feature.geometry.coordinates[0];
        const signedArea = ring.slice(0, -1).reduce((area, point, index) => {
          const next = ring[index + 1];
          return area + point[0] * next[1] - next[0] * point[1];
        }, 0);
        return signedArea > 0;
      })
    ).toBe(true);
    expect(data.landmasses.features[0].geometry.coordinates[0]).toEqual([
      [-180, 67.5],
      [180, 67.5],
      [180, -67.5],
      [-180, -67.5],
      [-180, 67.5]
    ]);
    expect(data.burgs.features[0]).toMatchObject({
      properties: { burgId: 1, name: "Center" },
      geometry: { coordinates: [0, 0] }
    });
  });
});
