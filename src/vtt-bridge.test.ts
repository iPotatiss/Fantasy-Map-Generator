import { describe, expect, it, vi } from "vitest";
import bridgeSource from "../public/modules/vtt-bridge.js?raw";

type PostedMessage = { message: Record<string, unknown>; origin: string };

function createClassList(initial: string[] = []) {
  const values = new Set(initial);
  return {
    add: (value: string) => values.add(value),
    contains: (value: string) => values.has(value),
    remove: (value: string) => values.delete(value)
  };
}

function loadBridge({ initialized = true }: { initialized?: boolean } = {}) {
  const posted: PostedMessage[] = [];
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
  const parent = {
    postMessage: vi.fn((message: Record<string, unknown>, origin: string) => posted.push({ message, origin }))
  };
  const standard = { classList: createClassList(["pressed"]), click: () => undefined };
  const globe = { classList: createClassList(), click: () => undefined };
  const createSelect = (value: string, optionValues: string[]) => {
    const options = optionValues.map(optionValue => ({ value: optionValue, dataset: { max: "32" } }));
    const select = { value, options, selectedOptions: options.filter(option => option.value === value) };
    Object.defineProperty(select, "textContent", {
      set: () => {
        select.options.length = 0;
        select.selectedOptions.length = 0;
      }
    });
    return select;
  };
  const culturesSet = createSelect("world", ["world", "european", "highFantasy"]);
  const heightUnit = createSelect("m", ["m", "ft", "f"]);
  const temperatureScale = createSelect("°C", ["°C", "°F", "K"]);
  const elements = new Map<string, unknown>([
    ["viewStandard", standard],
    ["viewGlobe", globe],
    ["culturesSet", culturesSet],
    ["heightUnit", heightUnit],
    ["temperatureScale", temperatureScale]
  ]);

  standard.click = () => {
    standard.classList.add("pressed");
    globe.classList.remove("pressed");
    elements.delete("canvas3d");
  };
  globe.click = () => {
    globe.classList.add("pressed");
    standard.classList.remove("pressed");
    elements.set("canvas3d", { dataset: { type: "viewGlobe" }, style: { display: "block" } });
  };
  const emblems = { classList: createClassList(["buttonoff"]), click: () => undefined };
  emblems.click = () => {
    if (emblems.classList.contains("buttonoff")) emblems.classList.remove("buttonoff");
    else emblems.classList.add("buttonoff");
  };
  elements.set("toggleEmblems", emblems);

  const document = {
    readyState: "complete",
    documentElement: { classList: createClassList() },
    addEventListener: vi.fn(),
    createElement: vi.fn(),
    getElementById: (id: string) => elements.get(id) ?? null
  };
  const setGlobeProjection = vi.fn();
  const isGlobeReady = vi.fn(() => true);
  const regenerateMap = vi.fn();
  const applyLayersPreset = vi.fn();
  const renderLayersPreset = vi.fn();
  const uploadMap = vi.fn();
  const lock = vi.fn();
  const unlock = vi.fn();
  const options = {};
  const changeCellsDensity = vi.fn();
  const applyRegionDraft = vi.fn(() => ({ changed: 120, landCells: 90 }));
  const cancelRegionDraft = vi.fn();
  const window = {
    parent,
    FMG_INITIALIZED: initialized,
    ThreeD: { setGlobeProjection, isGlobeReady },
    LandmassDraw: { applyDraft: applyRegionDraft, cancelDraft: cancelRegionDraft },
    addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      listeners[type] = listener;
    }),
    removeEventListener: vi.fn()
  } as Record<string, unknown>;
  const cells = {
    i: [] as number[],
    v: [[]],
    h: [1],
    biome: [0],
    state: [0],
    province: [0],
    culture: [0],
    religion: [0],
    pop: [0]
  };
  const pack = {
    cells,
    vertices: { p: [] },
    rivers: [],
    routes: [],
    burgs: [],
    markers: [],
    states: [],
    provinces: [],
    cultures: [],
    religions: []
  };

  const run = new Function(
    "window",
    "document",
    "fetch",
    "FileReader",
    "Image",
    "pack",
    "graphWidth",
    "graphHeight",
    "mapCoordinates",
    "biomesData",
    "regenerateMap",
    "applyLayersPreset",
    "renderLayersPreset",
    "uploadMap",
    "lock",
    "unlock",
    "options",
    "changeCellsDensity",
    bridgeSource
  );
  run(
    window,
    document,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    pack,
    1000,
    500,
    null,
    null,
    regenerateMap,
    applyLayersPreset,
    renderLayersPreset,
    uploadMap,
    lock,
    unlock,
    options,
    changeCellsDensity
  );

  return {
    pack,
    parent,
    posted,
    isGlobeReady,
    setGlobeProjection,
    regenerateMap,
    applyLayersPreset,
    renderLayersPreset,
    uploadMap,
    culturesSet,
    heightUnit,
    temperatureScale,
    applyRegionDraft,
    cancelRegionDraft,
    markInitialized: () => {
      window.FMG_INITIALIZED = true;
      listeners["fmg:initialized"]?.({});
    },
    send: (data: Record<string, unknown>, origin = "https://app.example", source: unknown = parent) =>
      listeners.message({ data, origin, source }),
    emit: (type: string, event: Record<string, unknown> = {}) => listeners[type]?.(event),
    vttBridge: window.VttBridge as { clampRasterScale: (value: unknown, width: number, height: number) => number }
  };
}

describe("VTT bridge protocol", () => {
  it("does not announce readiness until asynchronous FMG startup is complete", () => {
    const bridge = loadBridge({ initialized: false });

    expect(bridge.posted).toEqual([]);
    bridge.markInitialized();
    expect(bridge.posted.at(-1)?.message).toMatchObject({ type: "FMG_READY", protocol: 2 });
  });

  it("announces protocol 2 without map data", () => {
    const { posted } = loadBridge();

    expect(posted).toEqual([
      {
        message: {
          type: "FMG_READY",
          protocol: 2,
          capabilities: [
            "view.switch",
            "map.generate",
            "map.snapshot",
            "map.restore",
            "map.title",
            "tools.open",
            "region.compose",
            "layers.visibility"
          ]
        },
        origin: "*"
      }
    ]);
  });

  it("binds the parent session and changes views with exact-origin replies", () => {
    const bridge = loadBridge();
    const sessionId = "session-1234567890abcdef";

    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId, requestId: "connect-1" });
    bridge.send({
      type: "FMG_SET_VIEW",
      protocol: 2,
      sessionId,
      requestId: "view-1",
      view: "globe",
      projection: "world"
    });

    expect(bridge.posted.slice(1)).toEqual([
      {
        message: {
          type: "FMG_CONNECTED",
          protocol: 2,
          sessionId,
          requestId: "connect-1",
          view: "builder",
          layers: expect.objectContaining({ emblems: false }),
          capabilities: [
            "view.switch",
            "map.generate",
            "map.snapshot",
            "map.restore",
            "map.title",
            "tools.open",
            "region.compose",
            "layers.visibility"
          ]
        },
        origin: "https://app.example"
      },
      {
        message: {
          type: "FMG_VIEW_CHANGED",
          protocol: 2,
          sessionId,
          requestId: "view-1",
          view: "globe",
          projection: "world"
        },
        origin: "https://app.example"
      }
    ]);
    expect(bridge.setGlobeProjection).toHaveBeenCalledWith("world");
  });

  it("forwards freeform drafts and applies their configured recipe", () => {
    const bridge = loadBridge();
    const sessionId = "session-1234567890abcdef";
    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });
    bridge.emit("map:region-draft", {
      detail: { id: "draft-1", pointCount: 20, cellCount: 350, existingLandPercent: 15 }
    });
    expect(bridge.posted.at(-1)?.message).toMatchObject({
      type: "FMG_REGION_DRAFT",
      draftId: "draft-1",
      cellCount: 350,
      existingLandPercent: 15
    });

    bridge.send({
      type: "FMG_APPLY_REGION",
      protocol: 2,
      sessionId,
      requestId: "region-1",
      operation: "landmass",
      peakHeight: 68,
      coastFalloff: 0.35,
      nations: 3,
      nationShares: [20, 30, 50]
    });
    expect(bridge.applyRegionDraft).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "landmass", nations: 3, nationShares: [20, 30, 50] })
    );
    expect(bridge.renderLayersPreset).toHaveBeenCalledWith("political");
    expect(bridge.posted.at(-1)?.message).toMatchObject({
      type: "FMG_REGION_APPLIED",
      requestId: "region-1",
      changed: 120,
      landCells: 90
    });

    bridge.pack.cells.i = [0];
    bridge.renderLayersPreset.mockClear();
    bridge.send({
      type: "FMG_APPLY_REGION",
      protocol: 2,
      sessionId,
      requestId: "region-2",
      operation: "mountains"
    });
    expect(bridge.renderLayersPreset).not.toHaveBeenCalled();
  });

  it("toggles noisy symbol layers independently", () => {
    const bridge = loadBridge();
    const sessionId = "session-1234567890abcdef";
    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });
    bridge.send({
      type: "FMG_SET_LAYER",
      protocol: 2,
      sessionId,
      requestId: "layer-1",
      layer: "emblems",
      visible: true
    });

    expect(bridge.posted.at(-1)?.message).toMatchObject({
      type: "FMG_LAYERS_CHANGED",
      requestId: "layer-1",
      layers: { emblems: true }
    });

    bridge.renderLayersPreset.mockClear();
    bridge.send({
      type: "FMG_SET_LAYER_PRESET",
      protocol: 2,
      sessionId,
      requestId: "preset-1",
      preset: "political"
    });
    expect(bridge.renderLayersPreset).toHaveBeenCalledWith("political");
  });

  it("waits for generated map data before entering Globe", () => {
    vi.useFakeTimers();
    try {
      const bridge = loadBridge();
      const sessionId = "session-1234567890abcdef";
      bridge.pack.cells.v = [];
      bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });

      bridge.send({
        type: "FMG_SET_VIEW",
        protocol: 2,
        sessionId,
        requestId: "delayed-view",
        view: "globe",
        projection: "world"
      });

      expect(bridge.setGlobeProjection).not.toHaveBeenCalled();
      expect(bridge.posted.some(post => post.message.type === "FMG_VIEW_CHANGED")).toBe(false);

      bridge.pack.cells.v = [[]];
      vi.advanceTimersByTime(50);

      expect(bridge.setGlobeProjection).toHaveBeenCalledWith("world");
      expect(bridge.posted.at(-1)?.message).toMatchObject({
        type: "FMG_VIEW_CHANGED",
        requestId: "delayed-view",
        view: "globe"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the native sphere texture before acknowledging Globe", () => {
    vi.useFakeTimers();
    try {
      const bridge = loadBridge();
      const sessionId = "session-1234567890abcdef";
      bridge.isGlobeReady.mockReturnValue(false);
      bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });
      bridge.send({
        type: "FMG_SET_VIEW",
        protocol: 2,
        sessionId,
        requestId: "texture-view",
        view: "globe",
        projection: "world"
      });

      expect(bridge.setGlobeProjection).toHaveBeenCalledWith("world");
      expect(bridge.posted.some(post => post.message.type === "FMG_VIEW_CHANGED")).toBe(false);

      bridge.isGlobeReady.mockReturnValue(true);
      vi.advanceTimersByTime(50);

      expect(bridge.posted.at(-1)?.message).toMatchObject({
        type: "FMG_VIEW_CHANGED",
        requestId: "texture-view",
        view: "globe"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces pending view changes to the latest request while Globe is loading", () => {
    vi.useFakeTimers();
    try {
      const bridge = loadBridge();
      const sessionId = "session-1234567890abcdef";
      bridge.isGlobeReady.mockReturnValue(false);
      bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });

      bridge.send({
        type: "FMG_SET_VIEW",
        protocol: 2,
        sessionId,
        requestId: "first-globe",
        view: "globe",
        projection: "world"
      });
      bridge.send({
        type: "FMG_SET_VIEW",
        protocol: 2,
        sessionId,
        requestId: "stale-builder",
        view: "builder"
      });
      bridge.send({
        type: "FMG_SET_VIEW",
        protocol: 2,
        sessionId,
        requestId: "latest-globe",
        view: "globe",
        projection: "world"
      });

      bridge.isGlobeReady.mockReturnValue(true);
      vi.advanceTimersByTime(50);

      const viewReplies = bridge.posted
        .map(post => post.message)
        .filter(message => message.type === "FMG_VIEW_CHANGED");
      expect(viewReplies).toEqual([
        expect.objectContaining({ requestId: "first-globe", view: "globe", projection: "world" }),
        expect.objectContaining({ requestId: "latest-globe", view: "globe", projection: "world" })
      ]);
      expect(bridge.posted.some(post => post.message.requestId === "stale-builder")).toBe(false);
      expect(bridge.setGlobeProjection).toHaveBeenNthCalledWith(1, "world");
      expect(bridge.setGlobeProjection).toHaveBeenNthCalledWith(2, "world");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores messages from other windows or origins after binding", () => {
    const bridge = loadBridge();
    const sessionId = "session-1234567890abcdef";
    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });
    const count = bridge.posted.length;

    bridge.send(
      { type: "FMG_SET_VIEW", protocol: 2, sessionId, requestId: "wrong-window", view: "globe" },
      "https://app.example",
      { postMessage: vi.fn() }
    );
    bridge.send(
      { type: "FMG_SET_VIEW", protocol: 2, sessionId, requestId: "wrong-origin", view: "globe" },
      "https://evil.example"
    );

    expect(bridge.posted).toHaveLength(count);
  });

  it("rejects unsupported globe projections", () => {
    const bridge = loadBridge();
    const sessionId = "session-1234567890abcdef";
    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });

    bridge.send({
      type: "FMG_SET_VIEW",
      protocol: 2,
      sessionId,
      requestId: "bad-projection",
      view: "globe",
      projection: "mercator"
    });

    expect(bridge.posted.at(-1)?.message).toMatchObject({
      type: "FMG_ERROR",
      code: "INVALID_PROJECTION",
      sessionId,
      requestId: "bad-projection"
    });
    expect(bridge.setGlobeProjection).not.toHaveBeenCalled();
  });

  it("ignores legacy requests so map data cannot cross the frame boundary", () => {
    const bridge = loadBridge();
    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId: "session-1234567890abcdef" });
    const count = bridge.posted.length;

    bridge.send({ type: "FMG_REQUEST_EXPORT", requestId: "legacy-1" });
    bridge.send({ type: "FMG_REQUEST_IMAGE", requestId: "legacy-2", format: "png" });

    expect(bridge.posted).toHaveLength(count);
  });

  it("applies generation settings without erasing select options", () => {
    const bridge = loadBridge();
    const sessionId = "session-1234567890abcdef";
    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });

    bridge.send({
      type: "FMG_CREATE_MAP",
      protocol: 2,
      sessionId,
      requestId: "generate-1",
      name: "Test World",
      settings: {
        preset: "custom",
        template: "random",
        cultureSet: "highFantasy",
        heightUnit: "ft",
        temperatureScale: "°F",
        points: 4
      }
    });

    expect(bridge.regenerateMap).toHaveBeenCalledTimes(1);
    expect(bridge.applyLayersPreset).toHaveBeenCalledWith("political");
    expect(bridge.applyLayersPreset.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.regenerateMap.mock.invocationCallOrder[0]
    );
    expect(bridge.culturesSet.options).toHaveLength(3);
    expect(bridge.heightUnit.options).toHaveLength(3);
    expect(bridge.temperatureScale.options).toHaveLength(3);
    expect(bridge.culturesSet.value).toBe("highFantasy");
    expect(bridge.heightUnit.value).toBe("ft");
    expect(bridge.temperatureScale.value).toBe("°F");
    bridge.emit("map:generated");
  });

  it("preserves the layer choices stored in loaded project snapshots", () => {
    const bridge = loadBridge();
    const sessionId = "session-1234567890abcdef";
    bridge.send({ type: "FMG_CONNECT", protocol: 2, sessionId });

    bridge.send({
      type: "FMG_LOAD_SNAPSHOT",
      protocol: 2,
      sessionId,
      requestId: "load-1",
      snapshot: "saved map data"
    });

    expect(bridge.uploadMap).toHaveBeenCalledTimes(1);
    expect(bridge.applyLayersPreset).not.toHaveBeenCalled();
    bridge.emit("map:generated");
    expect(bridge.posted.at(-1)?.message).toMatchObject({ type: "FMG_MAP_LOADED", requestId: "load-1" });
  });

  it("bounds requested raster resolution", () => {
    const { vttBridge } = loadBridge();

    expect(vttBridge.clampRasterScale(100, 1000, 500)).toBe(4);
    expect(vttBridge.clampRasterScale(4, 10000, 10000)).toBeLessThan(1);
    expect(vttBridge.clampRasterScale(Number.NaN, 1000, 500)).toBe(1);
  });
});
