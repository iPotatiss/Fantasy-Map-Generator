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

    await page.evaluate(() => (window as any).enter3dView("viewGlobe"));
    await page.waitForSelector("#canvas3d", { state: "visible", timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.getGlobeMeshCount())).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).ThreeD.isGlobeReady())).toBe(true);

    await page.setViewportSize({ width: 1040, height: 760 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.getElementById("canvas3d") as HTMLCanvasElement;
          const rect = canvas.getBoundingClientRect();
          const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
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

    // Resizing exercises both renderer and camera aspect updates. The manual
    // projection below only lands on the real burg if both stay in sync.
    await page.setViewportSize({ width: 1100, height: 760 });
    await expect
      .poll(() => page.locator("#canvas3d").evaluate(canvas => Math.round(canvas.getBoundingClientRect().width)))
      .toBe(1100);

    const burgPoint = await page.evaluate(() => {
      const app = window as any;

      const canvas = document.getElementById("canvas3d") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const aspect = canvas.width / canvas.height;
      const perspectiveScale = 1 / Math.tan((45 * Math.PI) / 360);
      let best: { id: number; name: string; x: number; y: number; z: number } | null = null;

      for (const burg of app.pack.burgs) {
        if (!burg?.i || burg.removed || !document.getElementById(`burg${burg.i}`)) continue;

        const theta = (burg.y / app.graphHeight) * Math.PI;
        const phi = (burg.x / app.graphWidth) * Math.PI * 2;
        const sinTheta = Math.sin(theta);
        const worldX = -Math.cos(phi) * sinTheta;
        const worldY = Math.cos(theta);
        const worldZ = Math.sin(phi) * sinTheta;
        if (worldZ <= 0.25) continue;

        const cameraDepth = 5 - worldZ;
        const ndcX = (worldX * perspectiveScale) / (aspect * cameraDepth);
        const ndcY = (worldY * perspectiveScale) / cameraDepth;
        if (Math.abs(ndcX) > 0.75 || Math.abs(ndcY) > 0.75) continue;

        const x = rect.left + ((ndcX + 1) / 2) * rect.width;
        const y = rect.top + ((1 - ndcY) / 2) * rect.height;
        if (!best || worldZ > best.z) best = { id: burg.i, name: burg.name, x, y, z: worldZ };
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
