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

function loadBridge() {
  const posted: PostedMessage[] = [];
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
  const parent = {
    postMessage: vi.fn((message: Record<string, unknown>, origin: string) => posted.push({ message, origin }))
  };
  const standard = { classList: createClassList(["pressed"]), click: () => undefined };
  const globe = { classList: createClassList(), click: () => undefined };
  const elements = new Map<string, unknown>([
    ["viewStandard", standard],
    ["viewGlobe", globe]
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

  const document = {
    readyState: "complete",
    addEventListener: vi.fn(),
    createElement: vi.fn(),
    getElementById: (id: string) => elements.get(id) ?? null
  };
  const setGlobeProjection = vi.fn();
  const isGlobeReady = vi.fn(() => true);
  const window = {
    parent,
    ThreeD: { setGlobeProjection, isGlobeReady },
    addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      listeners[type] = listener;
    })
  } as Record<string, unknown>;
  const cells = { v: [[]], h: [1], biome: [0], state: [0], province: [0], culture: [0], religion: [0], pop: [0] };
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
    bridgeSource
  );
  run(window, document, vi.fn(), vi.fn(), vi.fn(), pack, 1000, 500, null, null);

  return {
    pack,
    parent,
    posted,
    isGlobeReady,
    setGlobeProjection,
    send: (data: Record<string, unknown>, origin = "https://app.example", source: unknown = parent) =>
      listeners.message({ data, origin, source }),
    vttBridge: window.VttBridge as { clampRasterScale: (value: unknown, width: number, height: number) => number }
  };
}

describe("VTT bridge protocol", () => {
  it("announces protocol 2 without map data", () => {
    const { posted } = loadBridge();

    expect(posted).toEqual([
      {
        message: {
          type: "FMG_READY",
          protocol: 2,
          capabilities: ["view.switch"]
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
          capabilities: ["view.switch"]
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

  it("bounds requested raster resolution", () => {
    const { vttBridge } = loadBridge();

    expect(vttBridge.clampRasterScale(100, 1000, 500)).toBe(4);
    expect(vttBridge.clampRasterScale(4, 10000, 10000)).toBeLessThan(1);
    expect(vttBridge.clampRasterScale(Number.NaN, 1000, 500)).toBe(1);
  });
});
