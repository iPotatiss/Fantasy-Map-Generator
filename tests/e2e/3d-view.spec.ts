import { test, expect } from "@playwright/test";

// software WebGL (SwiftShader) requires an explicit opt-in in recent Chromium
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
test.use({
  launchOptions: {
    args: ["--enable-unsafe-swiftshader"],
    ...(executablePath ? { executablePath } : {}),
  },
});

test.describe("3D view with eroded terrain", () => {
  // map generation + 3D view + software-WebGL bake can be slow under full-suite load
  test.setTimeout(180_000);

  test("bakes erosion detail and renders without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

    await page.goto("/");
    // mapId is set at the very end of map generation in showStatistics()
    await page.waitForFunction(() => (window as any).mapId !== undefined, {
      timeout: 120000,
    });

    const hasWebGL = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    });
    test.skip(!hasWebGL, "WebGL is not available in this environment");

    // enter the 3D mesh view through the same entry point the UI menu uses
    await page.evaluate(() => (window as any).enter3dView("viewMesh"));
    await page.waitForSelector("#canvas3d", { state: "attached", timeout: 60000 });
    await page.waitForFunction(() => (window as any).ThreeD?.options?.isOn === true, {
      timeout: 60000,
    });

    // enable eroded terrain via the settings checkbox (dialog opens with the view)
    await page.waitForSelector("#options3dErosion", { state: "attached" });
    await page.evaluate(() => (document.getElementById("options3dErosion") as HTMLInputElement).click());

    // the bake must complete and cache the dense height field
    await page.waitForFunction(() => (window as any).ThreeDErosion?.isCached?.(), {
      timeout: 60000,
    });

    // labels and icons sample the baked field: heights must be finite numbers
    const centerHeight = await page.evaluate(() => {
      const w = (window as any).graphWidth;
      const h = (window as any).graphHeight;
      return (window as any).ThreeDErosion.heightAt(w / 2, h / 2, 50);
    });
    expect(Number.isFinite(centerHeight)).toBe(true);

    // no page errors during view creation, bake, or re-render
    expect(errors).toEqual([]);
  });
});

test.describe("3D globe lifecycle", () => {
  test.setTimeout(180_000);

  test("prioritizes visible detail when zooming before the world upgrade", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      window.requestIdleCallback = callback =>
        window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 750);
      window.cancelIdleCallback = id => window.clearTimeout(id);
    });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).mapId !== undefined, { timeout: 120_000 });

    const hasWebGL = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    });
    test.skip(!hasWebGL, "WebGL is not available in this environment");

    await page.evaluate(() => {
      const app = window as any;
      app.ThreeD.options.rotateGlobe = 0;
      app.ThreeD.setGlobeProjection("world");
      return app.enter3dView("viewGlobe");
    });
    await page.waitForSelector("#canvas3d", { state: "visible", timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);

    const globeCanvas = page.locator("#canvas3d");
    const globeBox = await globeCanvas.boundingBox();
    if (!globeBox) throw new Error("The globe canvas has no visible bounds");
    await page.mouse.move(globeBox.x + globeBox.width / 2, globeBox.y + globeBox.height / 2);
    for (let index = 0; index < 40; index++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(18);
    }

    await expect
      .poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeRegionalDetailReady()), { timeout: 60_000 })
      .toBe(true);
    const rendering = await page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics());
    expect(rendering.regionalDetail.preemptedBaseUpgrade).toBe(true);
    expect(rendering.regionalDetail.active).toBe(true);
    expect(rendering.textureWidth).toBeLessThan(rendering.targetTextureWidth);
    expect(rendering.upgradePending).toBe(true);
    expect(errors).toEqual([]);
  });

  test("keeps exactly one sphere through redraw and texture races", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

    await page.goto("/");
    await page.waitForFunction(() => (window as any).mapId !== undefined, {
      timeout: 120000,
    });

    const hasWebGL = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    });
    test.skip(!hasWebGL, "WebGL is not available in this environment");

    await page.evaluate(() => {
      const app = window as any;
      if (!app.layerIsOn("toggleLabels")) document.getElementById("toggleLabels")?.click();
      if (!app.layerIsOn("toggleBurgIcons")) document.getElementById("toggleBurgIcons")?.click();
      app.ThreeD.setGlobeProjection("world");
      return app.enter3dView("viewGlobe");
    });
    await page.waitForSelector("#canvas3d", { state: "visible", timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.getGlobeMeshCount())).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);

    const globeRendering = await page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics());
    expect(globeRendering).toMatchObject({
      bakedLabels: false,
      bakedPointSymbols: false,
      bakedIce: false,
      polarCapDegrees: 12,
      polarBlendDegrees: 6,
      zoomSpeed: 0.55
    });
    expect(globeRendering.committedQuality).toBeGreaterThanOrEqual(1);
    expect(globeRendering.textureWidth).toBeLessThanOrEqual(globeRendering.targetTextureWidth);
    expect(globeRendering.overlayCounts["state-label"]).toBeGreaterThan(0);
    expect(globeRendering.overlayCounts["burg-icon"]).toBeGreaterThan(0);
    expect(globeRendering.overlayCounts["state-label"]).toBeLessThanOrEqual(globeRendering.overlayLimits.states);
    expect(globeRendering.overlayCounts["burg-icon"]).toBeLessThanOrEqual(globeRendering.overlayLimits.burgIcons);
    expect(globeRendering.overlaySizing.burgLabelGlyphCssPixels).toBeGreaterThanOrEqual(16);
    expect(globeRendering.overlaySizing.burgIconBoxCssPixels).toBeGreaterThanOrEqual(28);
    expect(globeRendering.overlaySizing.capitalIconBoxCssPixels).toBeGreaterThanOrEqual(34);
    expect(globeRendering.overlaySizing.markerIconBoxCssPixels).toBeGreaterThanOrEqual(40);
    expect(globeRendering.overlayTextureCount).toBeLessThanOrEqual(
      Math.max(globeRendering.overlayCacheLimit, globeRendering.activeOverlayTextureCount)
    );

    await expect
      .poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeSettled()), { timeout: 60_000 })
      .toBe(true);
    const settledRendering = await page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics());
    expect(settledRendering.textureWidth).toBe(settledRendering.targetTextureWidth);
    expect(settledRendering.textureHeight).toBe(settledRendering.textureWidth / 2);
    expect(settledRendering.polarCapPixels).toBe(Math.round((12 / 180) * settledRendering.textureHeight));
    expect(settledRendering.mapHeight).toBe(settledRendering.textureHeight - settledRendering.polarCapPixels * 2);
    expect(settledRendering.rasterSourceWidth).toBe(settledRendering.mapWidth);
    expect(settledRendering.rasterSourceHeight).toBe(settledRendering.mapHeight);

    await page.setViewportSize({ width: 1040, height: 760 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.getElementById("canvas3d") as HTMLCanvasElement;
          const rect = canvas.getBoundingClientRect();
          const pixelRatio = (window as any).ThreeD.getGlobeRenderDiagnostics().pixelRatio;
          return {
            fillsViewport:
              Math.abs(rect.width - document.documentElement.clientWidth) <= 1 &&
              Math.abs(rect.height - document.documentElement.clientHeight) <= 1,
            usesCappedPixelRatio:
              Math.abs(canvas.width - Math.floor(rect.width * pixelRatio)) <= 1 &&
              Math.abs(canvas.height - Math.floor(rect.height * pixelRatio)) <= 1,
            ready: (window as any).ThreeD.isGlobeReady()
          };
        })
      )
      .toEqual({ fillsViewport: true, usesCappedPixelRatio: true, ready: true });

    // At close zoom the whole-world texture no longer has enough source
    // texels for each screen pixel. A bounded regional crop should replace
    // it after movement stops, without adding another canonical globe mesh.
    const globeCanvas = page.locator("#canvas3d");
    const globeBox = await globeCanvas.boundingBox();
    if (!globeBox) throw new Error("The globe canvas has no visible bounds");
    await page.mouse.move(globeBox.x + globeBox.width / 2, globeBox.y + globeBox.height / 2);
    for (let index = 0; index < 40; index++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(18);
    }

    await expect
      .poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeRegionalDetailReady()), { timeout: 60_000 })
      .toBe(true);
    const closeRendering = await page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics());
    const regionalPixelBudget =
      closeRendering.qualityTier === "low" ? 2_000_000 : closeRendering.qualityTier === "balanced" ? 4_000_000 : 7_000_000;
    expect(closeRendering.regionalDetail).toMatchObject({ active: true, visible: true });
    expect(closeRendering.regionalDetail.baseScreenPixelsPerTexel).toBeGreaterThan(1.25);
    expect(closeRendering.regionalDetail.sourceTexelsPerScreenPixel).toBeGreaterThanOrEqual(
      closeRendering.qualityTier === "low" ? 1.1 : 1.2
    );
    expect(closeRendering.regionalDetail.rasterPixels).toBeLessThanOrEqual(regionalPixelBudget);
    expect(closeRendering.regionalDetail.crop.width).toBeLessThan((await page.evaluate(() => (window as any).graphWidth)) * 0.72);
    expect(closeRendering.overlayTextureCount).toBeLessThanOrEqual(
      Math.max(closeRendering.overlayCacheLimit, closeRendering.activeOverlayTextureCount)
    );
    expect(await page.evaluate(() => (window as any).ThreeD.getGlobeMeshCount())).toBe(1);

    await page.mouse.down();
    await page.mouse.move(globeBox.x + globeBox.width / 2 + 30, globeBox.y + globeBox.height / 2 + 14, { steps: 3 });
    await expect
      .poll(() => page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics().regionalDetail.visible))
      .toBe(false);
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeRegionalDetailReady()), { timeout: 60_000 })
      .toBe(true);

    // Return to a wide view so the following redraw race does not spend time
    // preparing close-up detail that the test does not need.
    for (let index = 0; index < 40; index++) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(12);
    }

    const refreshingState = await page.evaluate(() => {
      const threeD = (window as any).ThreeD;
      threeD.setResolutionScale(512);
      threeD.setGlobeProjection("world");
      threeD.redraw();
      threeD.setGlobeProjection("geographic");
      threeD.setGlobeProjection("world");
      threeD.update();
      return { meshCount: threeD.getGlobeMeshCount(), ready: threeD.isGlobeReady() };
    });

    expect(refreshingState).toEqual({ meshCount: 1, ready: false });
    await expect
      .poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeReady()), { timeout: 60_000 })
      .toBe(true);
    await page.waitForTimeout(1_000);
    expect(await page.evaluate(() => (window as any).ThreeD.getGlobeMeshCount())).toBe(1);
    expect(await page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);
    expect(errors).toEqual([]);
  });

  test("opens a visible burg editor on click but not on drag", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

    await page.goto("/");
    await page.waitForFunction(() => (window as any).mapId !== undefined, {
      timeout: 120000,
    });

    const hasWebGL = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    });
    test.skip(!hasWebGL, "WebGL is not available in this environment");

    await page.evaluate(() => {
      const app = window as any;
      if (!app.layerIsOn("toggleBurgIcons")) document.getElementById("toggleBurgIcons")?.click();
      app.ThreeD.options.rotateGlobe = 0;
      app.ThreeD.setGlobeProjection("world");
      return app.enter3dView("viewGlobe");
    });
    await page.waitForSelector("#canvas3d", { state: "visible", timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);

    // Resizing exercises renderer, camera and map-to-globe alignment. The
    // projected point only opens the matching burg if the polar-cap offset is
    // applied consistently in rendering, overlays and inverse picking.
    await page.setViewportSize({ width: 1100, height: 760 });
    await expect
      .poll(() => page.locator("#canvas3d").evaluate(canvas => Math.round(canvas.getBoundingClientRect().width)))
      .toBe(1100);

    const burgPoint = await page.evaluate(() => {
      const app = window as any;
      const canvas = document.getElementById("canvas3d") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      let best: { id: number; name: string; x: number; y: number; distance: number } | null = null;

      for (const burg of app.pack.burgs) {
        if (!burg?.i || !burg.capital || burg.removed || !document.getElementById(`burg${burg.i}`)) continue;
        if (burg.y < app.graphHeight * 0.06 || burg.y > app.graphHeight * 0.94) continue;

        const point = app.ThreeD.projectGlobeMapPointToScreen(burg.x, burg.y);
        if (!point) continue;
        if (point.x < rect.left + 80 || point.x > rect.right - 80) continue;
        if (point.y < rect.top + 80 || point.y > rect.bottom - 80) continue;

        const distance = Math.hypot(point.x - (rect.left + rect.width / 2), point.y - (rect.top + rect.height / 2));
        if (!best || distance < best.distance) {
          best = { id: burg.i, name: burg.name, x: point.x, y: point.y, distance };
        }
      }

      if (!best) throw new Error("No front-facing burg was available for globe picking");
      return best;
    });

    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, burgPoint)).toBe("canvas3d");

    await page.mouse.click(burgPoint.x, burgPoint.y);
    await expect(page.locator("#burgEditor")).toBeVisible();
    await expect(page.locator("#burgName")).toHaveValue(burgPoint.name);

    await page.evaluate(() => (window as any).$("#burgEditor").dialog("close"));
    await expect(page.locator("#burgEditor")).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);

    await page.mouse.move(burgPoint.x, burgPoint.y);
    await page.mouse.down();
    await page.mouse.move(burgPoint.x + 24, burgPoint.y + 12, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(page.locator("#burgEditor")).toBeHidden();
    expect(errors).toEqual([]);
  });
});
