import { expect, type Page, test } from "@playwright/test";

// software WebGL (SwiftShader) requires an explicit opt-in in recent Chromium
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
test.use({
  launchOptions: {
    args: ["--enable-unsafe-swiftshader"],
    ...(executablePath ? { executablePath } : {})
  }
});

async function enterVectorGlobe(page: Page) {
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
  await page.waitForSelector("#canvas3d .maplibregl-canvas", { state: "visible", timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);
}

test.describe("3D view with eroded terrain", () => {
  test.setTimeout(180_000);

  test("bakes erosion detail and renders without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));

    await page.goto("/");
    await page.waitForFunction(() => (window as any).mapId !== undefined, { timeout: 120_000 });

    const hasWebGL = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    });
    test.skip(!hasWebGL, "WebGL is not available in this environment");

    await page.evaluate(() => (window as any).enter3dView("viewMesh"));
    await page.waitForSelector("#canvas3d", { state: "attached", timeout: 60_000 });
    await page.waitForFunction(() => (window as any).ThreeD?.options?.isOn === true, { timeout: 60_000 });

    await page.waitForSelector("#options3dErosion", { state: "attached" });
    await page.evaluate(() => (document.getElementById("options3dErosion") as HTMLInputElement).click());
    await page.waitForFunction(() => (window as any).ThreeDErosion?.isCached?.(), { timeout: 60_000 });

    const centerHeight = await page.evaluate(() => {
      const app = window as any;
      return app.ThreeDErosion.heightAt(app.graphWidth / 2, app.graphHeight / 2, 50);
    });
    expect(Number.isFinite(centerHeight)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe("vector globe and settlement maps", () => {
  test.setTimeout(180_000);

  test("renders real vector layers and supports settlement-scale zoom", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    await enterVectorGlobe(page);

    const rendering = await page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics());
    const cellCount = await page.evaluate(() => (window as any).pack.cells.i.length);
    expect(rendering).toMatchObject({
      renderer: "maplibre-vector",
      ready: true,
      stage: "World",
      projection: "globe"
    });
    expect(rendering.maxZoom).toBeGreaterThanOrEqual(11);
    expect(rendering.contentMaxLatitude).toBeLessThanOrEqual(70);
    expect(rendering.polarCapDegrees).toBeGreaterThanOrEqual(20);
    expect(rendering.layers).toBeGreaterThanOrEqual(15);
    expect(rendering.sources).toBeGreaterThanOrEqual(9);
    expect(rendering.features.landmasses).toBeGreaterThan(0);
    expect(rendering.features.polarCaps).toBeGreaterThan(0);
    expect(rendering.features.land).toBeGreaterThan(0);
    expect(rendering.features.land).toBeLessThan(cellCount / 2);
    expect(rendering.features.burgs).toBeGreaterThan(0);

    const burgId = await page.evaluate(() => {
      const app = window as any;
      return app.pack.burgs.find((burg: any) => burg?.i && !burg.removed)?.i;
    });
    expect(burgId).toBeTruthy();
    expect(await page.evaluate(id => (window as any).VectorGlobe.focusBurg(id, 8), burgId)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics().stage))
      .toBe("Settlements");
    const closeRendering = await page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics());
    expect(closeRendering.zoom).toBeGreaterThanOrEqual(closeRendering.settlementEntryZoom);
    await expect(page.locator(".fmg-vector-globe__hint")).toHaveAttribute("data-visible", "true");

    const canvasBounds = await page.locator("#canvas3d .maplibregl-canvas").evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    expect(canvasBounds).toEqual({ width: 1280, height: 720 });
    expect(errors).toEqual([]);
  });

  test("automatically uses the lightweight profile on modest computers", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "deviceMemory", { configurable: true, get: () => 2 });
      Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, get: () => 2 });
    });
    await enterVectorGlobe(page);

    const rendering = await page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics());
    expect(rendering).toMatchObject({
      renderer: "maplibre-vector",
      ready: true,
      performanceProfile: "low-power",
      pixelRatio: 1
    });
    expect(rendering.dataBuildMs).toBeLessThan(1000);
    expect(rendering.features.burgs).toBeGreaterThan(0);
  });

  test("keeps settlement information clickable and enters the bird's-eye map through zoom", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    await enterVectorGlobe(page);

    const target = await page.evaluate(() => {
      const app = window as any;
      const burg = app.pack.burgs.find((candidate: any) => {
        if (!candidate?.i || candidate.removed) return false;
        return Boolean(app.Burgs.getPreview(candidate).preview);
      });
      return burg ? { id: burg.i, name: burg.name } : null;
    });
    expect(target).toBeTruthy();

    expect(await page.evaluate(id => (window as any).VectorGlobe.focusBurg(id, 5.5), target!.id)).toBe(true);
    await page.waitForTimeout(250);
    const regionalPoint = await page.evaluate(id => {
      const app = window as any;
      const burg = app.pack.burgs[id];
      return app.ThreeD.projectGlobeMapPointToScreen(burg.x, burg.y);
    }, target!.id);
    await page.mouse.click(regionalPoint.x, regionalPoint.y);
    await expect(page.locator("#burgEditor")).toBeVisible();
    await expect(page.locator("#burgName")).toHaveValue(target!.name);
    await page.evaluate(() => (window as any).$("#burgEditor").dialog("close"));

    expect(await page.evaluate(id => (window as any).VectorGlobe.focusBurg(id, 10.2), target!.id)).toBe(true);
    await expect(page.locator(".fmg-settlement-view")).toBeVisible();
    await expect(page.locator(".fmg-settlement-view__title")).toHaveText(target!.name);
    await expect(page.locator(".fmg-settlement-view iframe")).toHaveAttribute("src", /preview=1/);
    await expect(page.locator(".fmg-settlement-view")).toHaveAttribute("data-interactive", "false");

    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 600);
    await expect(page.locator(".fmg-settlement-view")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.getGlobeRenderDiagnostics().zoom)).toBeLessThan(9);
    expect(errors).toEqual([]);
  });

  test("updates, resizes and disposes one vector map cleanly", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    await enterVectorGlobe(page);
    await expect(page.locator("#canvas3d .maplibregl-canvas")).toHaveCount(1);

    await page.evaluate(() => {
      const app = window as any;
      app.ThreeD.update();
      app.ThreeD.redraw();
    });
    await page.waitForTimeout(500);
    await expect(page.locator("#canvas3d .maplibregl-canvas")).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);

    await page.setViewportSize({ width: 1040, height: 760 });
    await expect
      .poll(() => page.locator("#canvas3d .maplibregl-canvas").evaluate(canvas => Math.round(canvas.getBoundingClientRect().width)))
      .toBe(1040);

    await page.locator(".fmg-vector-globe__hud button").first().click();
    await expect(page.locator("#canvas3d")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).ThreeD.options.isOn)).toBe(false);
    expect(errors).toEqual([]);
  });
});
