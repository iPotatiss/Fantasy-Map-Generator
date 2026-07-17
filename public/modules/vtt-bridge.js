/* VTT bridge — connects FMG to a parent "World Map Maker" frame.
 *
 * Protocol 2 binds the exact parent window, origin and random session before it accepts
 * Builder / Globe commands. Editable map snapshots are shared only after the exact
 * parent window, origin and random session have been bound by the handshake.
 *
 * Plain ES5, no imports. Same-page export helpers are retained for FMG's own tooling,
 * but the message handler never invokes them or returns their data across origins.
 */
(function () {
  "use strict";

  var PROTOCOL_VERSION = 2;
  var SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
  var REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  var client = null;
  var viewQueue = [];
  var viewBusy = false;
  var generationRequest = null;
  var generationTimer = null;
  var suppressDirtyUntil = 0;
  var dirtyTimer = null;

  // Array.from-style copy; covers TypedArrays and plain arrays, guards non-array-likes.
  function toArr(a) {
    if (a == null) return [];
    if (Array.isArray(a)) return a;
    if (typeof a.length === "number") {
      try {
        return Array.prototype.slice.call(a);
      } catch (e) {
        return [];
      }
    }
    return [];
  }
  function n(v) {
    var x = +v;
    return isFinite(x) ? x : 0;
  }

  // Convert a same-origin blob: URL to a persistent data: URL (cross-origin safe).
  function blobUrlToDataUrl(blobUrl) {
    return fetch(blobUrl)
      .then(function (r) {
        return r.blob();
      })
      .then(function (b) {
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onloadend = function () {
            res(fr.result);
          };
          fr.onerror = rej;
          fr.readAsDataURL(b);
        });
      });
  }

  // Produce FMG's finished styled render as a data URL: crisp self-contained SVG
  // (Flat) or a rasterized PNG (Globe texture). getMapURL("svg",{fullMap:true})
  // renders the whole graphWidth x graphHeight extent with fonts/patterns/filters
  // inlined, so it is safe to load cross-origin. Never emits a blob: URL.
  function buildImage(format, scale, cb) {
    if (typeof getMapURL !== "function") {
      cb(null, "no getMapURL");
      return;
    }
    var W = (typeof graphWidth !== "undefined" ? +graphWidth : 0) || 0;
    var H = (typeof graphHeight !== "undefined" ? +graphHeight : 0) || 0;
    var done = false;
    var timeout = setTimeout(function () {
      fail("image export timed out");
    }, 45000);
    function fail(msg) {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        cb(null, msg, W, H);
      }
    }
    function ok(dataUrl) {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        cb(dataUrl, null, W, H);
      }
    }
    var p;
    try {
      p = getMapURL("svg", { fullMap: true });
    } catch (e) {
      fail("getMapURL threw: " + (e && e.message));
      return;
    }
    if (!p || typeof p.then !== "function") {
      fail("getMapURL did not return a promise");
      return;
    }
    p.then(function (blobUrl) {
      if (format === "png") {
        // Rasterize the self-contained SVG to a PNG data URL. The PNG is sized to the
        // map's pixel extent (W x H, scaled) so it aligns 1:1 with bundle.width/height.
        var img = new Image();
        img.onload = function () {
          try {
            var s = clampRasterScale(scale, W, H);
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(W * s));
            c.height = Math.max(1, Math.round(H * s));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            ok(c.toDataURL("image/png")); // same-origin (base64 images) → no taint
          } catch (e) {
            fail("rasterize failed: " + (e && e.message));
          }
        };
        img.onerror = function () {
          fail("svg image load failed");
        };
        blobUrlToDataUrl(blobUrl)
          .then(function (svgDataUrl) {
            img.src = svgDataUrl;
          })
          .catch(function () {
            img.src = blobUrl; // same-origin blob loads into an Image fine
          });
      } else {
        blobUrlToDataUrl(blobUrl)
          .then(ok)
          .catch(function (e) {
            fail("svg dataurl failed: " + (e && e.message));
          });
      }
    }).catch(function (e) {
      fail("getMapURL failed: " + (e && e.message));
    });
  }

  // Keep browser canvas allocations bounded even if an untrusted embed asks for an
  // extreme scale or FMG is running an unusually large custom map.
  function clampRasterScale(value, width, height) {
    var scale = +value;
    if (!isFinite(scale)) scale = 1;
    scale = Math.max(0.25, Math.min(4, scale));

    var maxDimension = 8192;
    var maxPixels = 33554432;
    var w = Math.max(1, +width || 1);
    var h = Math.max(1, +height || 1);
    scale = Math.min(scale, maxDimension / w, maxDimension / h, Math.sqrt(maxPixels / (w * h)));
    return Math.max(0.01, scale);
  }

  function buildPayload() {
    if (typeof pack === "undefined" || !pack || !pack.cells || !pack.cells.v) return null;
    var c = pack.cells;
    var v = pack.vertices;

    // cells: struct-of-arrays; only the sub-fields fromFmgJson reads. cells.v is
    // number[][] (already plain, keep nested); the rest are TypedArrays -> plain.
    var cells = {
      v: toArr(c.v),
      h: toArr(c.h),
      biome: toArr(c.biome),
      state: toArr(c.state),
      province: toArr(c.province),
      culture: toArr(c.culture),
      religion: toArr(c.religion),
      pop: toArr(c.pop)
    };

    // vertices: only .p (array of [x,y] pixel tuples) is read. Already plain, keep nested.
    var vertices = { p: toArr(v && v.p) };

    // rivers -> keep points/width/name only (points are [[x,y],...] pixel pairs).
    var rivers = [];
    var rSrc = toArr(pack.rivers);
    for (var i = 0; i < rSrc.length; i++) {
      var r = rSrc[i];
      if (!r || !r.points) continue;
      rivers.push({ points: r.points, width: n(r.width) || n(r.widthFactor) || 1, name: r.name });
    }

    // routes -> keep points/group only (points are [x,y,cellId] triples; reader drops the 3rd).
    var routes = [];
    var rtSrc = toArr(pack.routes);
    for (var j = 0; j < rtSrc.length; j++) {
      var rt = rtSrc[j];
      if (!rt || !rt.points) continue;
      routes.push({ points: rt.points, group: rt.group || "roads" });
    }

    // burgs -> drop the index-0 placeholder {} and unplaced burgs; pass the read fields.
    var burgs = [];
    var bSrc = toArr(pack.burgs);
    for (var k = 0; k < bSrc.length; k++) {
      var b = bSrc[k];
      if (!b || (!b.x && !b.y)) continue;
      burgs.push({
        i: n(b.i) || k,
        x: n(b.x),
        y: n(b.y),
        name: b.name,
        population: n(b.population),
        capital: b.capital ? 1 : 0,
        port: b.port ? 1 : 0,
        state: n(b.state),
        culture: n(b.culture)
      });
    }

    // markers -> need pixel x/y.
    var markers = [];
    var mSrc = toArr(pack.markers);
    for (var m = 0; m < mSrc.length; m++) {
      var mk = mSrc[m];
      if (!mk || (!mk.x && !mk.y)) continue;
      markers.push({ x: n(mk.x), y: n(mk.y), icon: mk.icon || "📍", name: mk.name, type: mk.type });
    }

    // palettes -> the reader keeps only {i,name,fullName,color,capital,removed}; trim to
    // those so we never serialize heavy/nested state data (military, diplomacy, campaigns).
    function palette(list) {
      var out = [];
      var src = toArr(list);
      for (var p = 0; p < src.length; p++) {
        var e = src[p];
        if (!e || typeof e !== "object") {
          out.push(e);
          continue;
        }
        out.push({ i: e.i, name: e.name, fullName: e.fullName, color: e.color, capital: e.capital, removed: e.removed });
      }
      return out;
    }

    // biomes -> only name/color are read; never send biomesMatrix (array of Uint8Array).
    var bd = typeof biomesData !== "undefined" && biomesData ? biomesData : null;
    var biomesOut = bd ? { name: toArr(bd.name), color: toArr(bd.color) } : undefined;

    // mapCoordinates -> read at ROOT for geoFromCoordinates (kills "no geo data").
    var mc = typeof mapCoordinates !== "undefined" && mapCoordinates ? mapCoordinates : null;

    var W = typeof graphWidth !== "undefined" && graphWidth ? n(graphWidth) : 0;
    var H = typeof graphHeight !== "undefined" && graphHeight ? n(graphHeight) : 0;

    return {
      settings: { width: W, height: H },
      mapCoordinates: mc || undefined,
      biomesData: biomesOut,
      pack: {
        cells: cells,
        vertices: vertices,
        rivers: rivers,
        routes: routes,
        burgs: burgs,
        markers: markers,
        states: palette(pack.states),
        provinces: palette(pack.provinces),
        cultures: palette(pack.cultures),
        religions: palette(pack.religions)
      }
    };
  }

  function reply(target, origin, msg) {
    if (!target || !origin || origin === "null" || origin === "*") return false;
    try {
      target.postMessage(msg, origin);
      return true;
    } catch (e) {
      return false;
    }
  }

  function validOrigin(origin) {
    return typeof origin === "string" && origin !== "" && origin !== "null";
  }

  function validSessionId(value) {
    return typeof value === "string" && SESSION_ID_RE.test(value);
  }

  function validRequestId(value) {
    return typeof value === "string" && REQUEST_ID_RE.test(value);
  }

  function fromParent(ev) {
    return !!ev && window.parent && window.parent !== window && ev.source === window.parent && validOrigin(ev.origin);
  }

  function isBoundRequest(ev, data) {
    return (
      !!client &&
      ev.source === client.source &&
      ev.origin === client.origin &&
      data.protocol === PROTOCOL_VERSION &&
      data.sessionId === client.sessionId
    );
  }

  function currentView() {
    var globe = document.getElementById("viewGlobe");
    return globe && globe.classList.contains("pressed") ? "globe" : "builder";
  }

  function protocolReply(type, request, extra) {
    if (!client) return;
    if (request && request.sessionId && request.sessionId !== client.sessionId) return;
    var message = {
      type: type,
      protocol: PROTOCOL_VERSION,
      sessionId: client.sessionId
    };
    if (request && validRequestId(request.requestId)) message.requestId = request.requestId;
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) message[key] = extra[key];
      }
    }
    reply(client.source, client.origin, message);
  }

  function protocolError(request, code, message) {
    protocolReply("FMG_ERROR", request, { code: code, message: message });
  }

  function clampInteger(value, min, max, fallback) {
    var parsed = Math.round(+value);
    return isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  }

  function setControlValue(id, value) {
    var control = document.getElementById(id);
    if (!control || value == null) return false;
    try {
      control.value = String(value);
      if (/Input$/.test(id)) {
        var output = document.getElementById(id.replace(/Input$/, "Output"));
        if (output && output !== control) {
          output.value = String(value);
          output.textContent = String(value);
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function setTemplateValue(value) {
    var control = document.getElementById("templateInput");
    if (!control || !value) return false;
    var matchingOption = Array.prototype.some.call(control.options || [], function (option) { return option.value === value; });
    if (!matchingOption && typeof Option === "function") {
      control.replaceChildren(new Option(value.replace(/([A-Z])/g, " $1").replace(/^./, function (letter) { return letter.toUpperCase(); }), value, true, true));
    }
    control.value = value;
    return control.value === value;
  }

  function applyGenerationSettings(settings, name) {
    settings = settings && typeof settings === "object" ? settings : {};
    var preset = typeof settings.preset === "string" ? settings.preset : "custom";
    if (preset !== "custom" && window.GenerationDirector && typeof window.GenerationDirector.applyPreset === "function") {
      window.GenerationDirector.applyPreset(preset);
    }

    setControlValue("waterCoverageInput", clampInteger(settings.waterCoverage, 5, 95, 71));
    setControlValue("settlementDensityInput", settings.settlementDensity || "balanced");
    setControlValue("capitalImportanceInput", settings.capitalImportance || "prominent");
    setControlValue("statesNumber", clampInteger(settings.states, 0, 100, 18));
    setControlValue("provincesRatio", clampInteger(settings.provincesRatio, 0, 100, 20));
    setControlValue("sizeVariety", Math.max(0, Math.min(10, +settings.sizeVariety || 4)));
    setControlValue("growthRate", Math.max(0.1, Math.min(2, +settings.growthRate || 1.5)));
    setControlValue("culturesInput", clampInteger(settings.cultures, 1, 50, 12));
    setControlValue("religionsNumber", clampInteger(settings.religions, 0, 50, 6));
    var settlementCount = clampInteger(settings.settlementCount, 0, 1000, 1000);
    setControlValue("manorsInput", settlementCount);
    setControlValue("manorsOutput", settlementCount === 1000 ? "auto" : settlementCount);
    setControlValue("culturesSet", settings.cultureSet || "world");
    setControlValue("stateLabelsModeInput", settings.stateLabelsMode || "auto");
    setControlValue("mapName", typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : "Untitled World");

    if (settings.template && settings.template !== "random") {
      setTemplateValue(settings.template);
      if (typeof lock === "function") lock("template");
    } else if (typeof unlock === "function") unlock("template");

    var automaticPosition = settings.automaticWorldPosition !== false;
    if (automaticPosition && typeof unlock === "function") {
      ["mapSize", "latitude", "longitude"].forEach(unlock);
    } else {
      setControlValue("mapSizeInput", clampInteger(settings.mapSize, 1, 100, 50));
      setControlValue("latitudeInput", clampInteger(settings.latitude, 0, 100, 50));
      setControlValue("longitudeInput", clampInteger(settings.longitude, 0, 100, 50));
    }

    var equator = clampInteger(settings.temperatureEquator, -50, 50, 25);
    var northPole = clampInteger(settings.temperatureNorthPole, -50, 50, -25);
    var southPole = clampInteger(settings.temperatureSouthPole, -50, 50, -15);
    setControlValue("temperatureEquatorInput", equator);
    setControlValue("temperatureNorthPoleInput", northPole);
    setControlValue("temperatureSouthPoleInput", southPole);
    setControlValue("precInput", clampInteger(settings.precipitation, 0, 500, 100));
    if (typeof options !== "undefined" && options) {
      options.temperatureEquator = equator;
      options.temperatureNorthPole = northPole;
      options.temperatureSouthPole = southPole;
      options.stateLabelsMode = settings.stateLabelsMode || "auto";
    }

    setControlValue("distanceUnitInput", settings.distanceUnit || "km");
    setControlValue("distanceScaleInput", Math.max(0.01, Math.min(20, +settings.distanceScale || 3)));
    setControlValue("heightUnit", settings.heightUnit || "m");
    setControlValue("heightExponentInput", Math.max(1.5, Math.min(2.2, +settings.heightExponent || 2)));
    setControlValue("temperatureScale", settings.temperatureScale || "°C");
    setControlValue("populationRateInput", clampInteger(settings.populationRate, 10, 10000, 1000));
    setControlValue("urbanizationInput", Math.max(0.01, Math.min(5, +settings.urbanization || 1)));
    setControlValue("urbanDensityInput", clampInteger(settings.urbanDensity, 1, 200, 10));
    if (typeof distanceScale !== "undefined") distanceScale = +settings.distanceScale || 3;
    if (typeof populationRate !== "undefined") populationRate = clampInteger(settings.populationRate, 10, 10000, 1000);
    if (typeof urbanization !== "undefined") urbanization = Math.max(0.01, Math.min(5, +settings.urbanization || 1));
    if (typeof urbanDensity !== "undefined") urbanDensity = clampInteger(settings.urbanDensity, 1, 200, 10);

    var points = clampInteger(settings.points, 1, 13, 4);
    if (typeof changeCellsDensity === "function") changeCellsDensity(points);
    else setControlValue("pointsInput", points);

    if (typeof lock === "function") {
      var lockedOptions = ["waterCoverage", "settlementDensity", "capitalImportance", "statesNumber", "provincesRatio", "sizeVariety", "growthRate", "cultures", "religionsNumber", "manors", "culturesSet", "stateLabelsMode", "temperatureEquator", "temperatureNorthPole", "temperatureSouthPole", "prec", "distanceScale", "heightExponent", "populationRate", "urbanization", "urbanDensity", "points", "mapName"];
      if (!automaticPosition) lockedOptions.push("mapSize", "latitude", "longitude");
      lockedOptions.forEach(function (option) {
        try { lock(option); } catch (e) {}
      });
    }
  }

  function handleCreateMap(ev, data) {
    if (!isBoundRequest(ev, data) || !validRequestId(data.requestId)) return;
    if (typeof regenerateMap !== "function") {
      protocolError(data, "GENERATION_UNAVAILABLE", "Map generation is not available yet");
      return;
    }

    if (generationRequest) {
      protocolError(data, "GENERATION_BUSY", "A world is already being generated");
      return;
    }
    try {
      applyGenerationSettings(data.settings, data.name);
      generationRequest = data;
      suppressDirtyUntil = Date.now() + 1000;
      clearTimeout(generationTimer);
      generationTimer = setTimeout(function () {
        if (!generationRequest) return;
        var timedOutRequest = generationRequest;
        generationRequest = null;
        generationTimer = null;
        protocolError(timedOutRequest, "GENERATION_TIMEOUT", "World generation took too long to finish");
      }, 300000);
      regenerateMap({ seed: data.settings && data.settings.seed ? String(data.settings.seed) : undefined });
    } catch (error) {
      generationRequest = null;
      clearTimeout(generationTimer);
      generationTimer = null;
      protocolError(data, "GENERATION_FAILED", error && error.message ? error.message : "World generation failed");
    }
  }

  function handleGetSnapshot(ev, data) {
    if (!isBoundRequest(ev, data) || !validRequestId(data.requestId)) return;
    if (!mapIsReady("world") || typeof prepareMapData !== "function") {
      protocolError(data, "MAP_NOT_READY", "The map is not ready to save");
      return;
    }

    var snapshot;
    try {
      snapshot = prepareMapData();
    } catch (error) {
      protocolError(data, "SAVE_FAILED", error && error.message ? error.message : "Could not prepare the map");
      return;
    }

    if (!data.includePreview) {
      protocolReply("FMG_SNAPSHOT", data, { snapshot: snapshot });
      return;
    }

    buildImage("png", 0.35, function (previewDataUrl) {
      protocolReply("FMG_SNAPSHOT", data, { snapshot: snapshot, previewDataUrl: previewDataUrl || null });
    });
  }

  function handleLoadSnapshot(ev, data) {
    if (!isBoundRequest(ev, data) || !validRequestId(data.requestId)) return;
    if (typeof data.snapshot !== "string" || !data.snapshot.length || typeof uploadMap !== "function") {
      protocolError(data, "INVALID_SNAPSHOT", "The saved map could not be restored");
      return;
    }

    suppressDirtyUntil = Date.now() + 30000;
    var finished = false;
    var timeout = setTimeout(function () {
      if (finished) return;
      finished = true;
      window.removeEventListener("map:generated", loaded);
      protocolError(data, "LOAD_TIMEOUT", "The saved map took too long to restore");
    }, 30000);
    function loaded() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      suppressDirtyUntil = Date.now() + 1000;
      window.removeEventListener("map:generated", loaded);
      protocolReply("FMG_MAP_LOADED", data, {});
    }
    window.addEventListener("map:generated", loaded);
    try {
      uploadMap(new Blob([data.snapshot], { type: "text/plain" }));
    } catch (error) {
      finished = true;
      clearTimeout(timeout);
      window.removeEventListener("map:generated", loaded);
      protocolError(data, "LOAD_FAILED", error && error.message ? error.message : "The saved map could not be restored");
    }
  }

  function handleSetTitle(ev, data) {
    if (!isBoundRequest(ev, data) || !validRequestId(data.requestId)) return;
    var name = typeof data.name === "string" ? data.name.trim().slice(0, 120) : "";
    if (!name || !setControlValue("mapName", name)) {
      protocolError(data, "INVALID_TITLE", "The world needs a valid title");
      return;
    }
    protocolReply("FMG_TITLE_CHANGED", data, { name: name });
  }

  function handleOpenTool(ev, data) {
    if (!isBoundRequest(ev, data) || !validRequestId(data.requestId)) return;
    var toolIds = { landmass: "drawLandmassTool", road: "drawRoadTool", river: "drawRiverTool" };
    var button = document.getElementById(toolIds[data.tool]);
    if (!button || typeof button.click !== "function") {
      protocolError(data, "TOOL_UNAVAILABLE", "That drawing tool is not available");
      return;
    }
    button.click();
    protocolReply("FMG_TOOL_OPENED", data, { tool: data.tool });
  }

  function announceDirty() {
    if (!client || Date.now() < suppressDirtyUntil || dirtyTimer) return;
    dirtyTimer = setTimeout(function () {
      dirtyTimer = null;
      protocolReply("FMG_MAP_DIRTY", null, {});
    }, 400);
  }

  function onMapGenerated() {
    if (generationRequest) {
      var request = generationRequest;
      generationRequest = null;
      clearTimeout(generationTimer);
      generationTimer = null;
      suppressDirtyUntil = Date.now() + 1000;
      protocolReply("FMG_MAP_CREATED", request, {});
      return;
    }
    announceDirty();
  }

  function onMapGenerationError(event) {
    if (!generationRequest) return;
    var request = generationRequest;
    generationRequest = null;
    clearTimeout(generationTimer);
    generationTimer = null;
    var detail = event && event.detail;
    var message = detail && typeof detail.message === "string" ? detail.message : "World generation failed";
    protocolError(request, "GENERATION_FAILED", message);
  }

  function handleConnect(ev, data) {
    if (!fromParent(ev) || data.protocol !== PROTOCOL_VERSION || !validSessionId(data.sessionId)) return;

    // A reload of the host application may create a fresh session while retaining the
    // same iframe. Only the already-bound parent at the same exact origin may rebind it.
    if (client && (client.source !== ev.source || client.origin !== ev.origin)) return;
    if (!client || client.sessionId !== data.sessionId) {
      viewQueue = [];
    }
    client = { source: ev.source, origin: ev.origin, sessionId: data.sessionId };
    document.documentElement.classList.add("vtt-embedded");
    protocolReply("FMG_CONNECTED", data, {
      view: currentView(),
      capabilities: ["view.switch", "map.generate", "map.snapshot", "map.restore", "map.title", "tools.open"]
    });
  }

  function viewIsReady(view) {
    if (view === "builder") {
      var standard = document.getElementById("viewStandard");
      return !!standard && standard.classList.contains("pressed");
    }

    var globe = document.getElementById("viewGlobe");
    var canvas = document.getElementById("canvas3d");
    var canvasReady =
      !!globe &&
      globe.classList.contains("pressed") &&
      !!canvas &&
      canvas.dataset &&
      canvas.dataset.type === "viewGlobe" &&
      canvas.style.display !== "none";
    if (!canvasReady) return false;
    if (!window.ThreeD || typeof window.ThreeD.isGlobeReady !== "function") return true;
    try {
      return !!window.ThreeD.isGlobeReady();
    } catch (e) {
      return false;
    }
  }

  function mapIsReady(projection) {
    if (typeof pack === "undefined" || !pack || !pack.cells) return false;
    var cells = pack.cells;
    var cellCount = cells.v && typeof cells.v.length === "number" ? cells.v.length : 0;
    if (!cellCount) return false;

    var width = typeof graphWidth !== "undefined" ? +graphWidth : 0;
    var height = typeof graphHeight !== "undefined" ? +graphHeight : 0;
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return false;

    // The VTT's world projection deliberately treats the full canvas as equirectangular,
    // so geographic bounds are not needed. FMG's standalone projection still needs them.
    if (projection === "world") return true;
    if (typeof mapCoordinates === "undefined" || !mapCoordinates) return false;
    var coordinateKeys = ["latT", "latN", "lonT", "lonW"];
    for (var i = 0; i < coordinateKeys.length; i++) {
      var coordinate = mapCoordinates[coordinateKeys[i]];
      if (coordinate == null || !isFinite(+coordinate)) return false;
    }
    return +mapCoordinates.latT > 0 && +mapCoordinates.lonT > 0;
  }

  function processViewQueue() {
    if (viewBusy || !viewQueue.length) return;
    viewBusy = true;
    var job = viewQueue.shift();
    var button = document.getElementById(job.view === "globe" ? "viewGlobe" : "viewStandard");
    if (!button || typeof button.click !== "function") {
      protocolError(job.request, "VIEW_UNAVAILABLE", "The requested view control is not available");
      viewBusy = false;
      processViewQueue();
      return;
    }

    var started = Date.now();
    var enteredView = false;
    function waitForView() {
      if (Date.now() - started > 30000) {
        protocolError(job.request, "VIEW_TIMEOUT", "The requested view did not finish loading");
        viewBusy = false;
        processViewQueue();
        return;
      }

      // FMG announces the bridge at DOM ready, while its async initial generation can
      // still be filling pack. Entering ThreeD before that point creates a blank or
      // failed globe, so consume the same view timeout while we wait for real map data.
      if (job.view === "globe" && !mapIsReady(job.projection)) {
        setTimeout(waitForView, 50);
        return;
      }

      if (!enteredView) {
        if (job.view === "globe" && window.ThreeD && typeof window.ThreeD.setGlobeProjection === "function") {
          window.ThreeD.setGlobeProjection(job.projection);
        }

        // The 3D controller marks Globe pressed before its async canvas is ready. Clicking
        // that pressed control a second time would cancel the load and return to Standard.
        if (!button.classList.contains("pressed")) button.click();
        enteredView = true;
      }

      if (viewIsReady(job.view)) {
        protocolReply("FMG_VIEW_CHANGED", job.request, { view: job.view, projection: job.projection });
        viewBusy = false;
        processViewQueue();
        return;
      }
      setTimeout(waitForView, 50);
    }
    waitForView();
  }

  function handleSetView(ev, data) {
    if (!isBoundRequest(ev, data)) return;
    if (!validRequestId(data.requestId)) {
      protocolError(data, "INVALID_REQUEST", "A valid requestId is required");
      return;
    }
    if (data.view !== "builder" && data.view !== "globe") {
      protocolError(data, "INVALID_VIEW", "View must be either builder or globe");
      return;
    }
    var projection = data.projection == null ? "geographic" : data.projection;
    if (projection !== "world" && projection !== "geographic") {
      protocolError(data, "INVALID_PROJECTION", "Projection must be either world or geographic");
      return;
    }

    // Keep the in-flight transition intact, but only retain the latest pending intent.
    // The host also tracks just its latest requestId, so replying with errors for commands
    // it has already superseded would be misleading and could surface a stale failure.
    viewQueue.length = 0;
    viewQueue.push({ request: data, view: data.view, projection: projection });
    processViewQueue();
  }

  function onRequest(ev) {
    var d = ev && ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "FMG_CONNECT") {
      handleConnect(ev, d);
      return;
    }
    if (d.type === "FMG_SET_VIEW") {
      handleSetView(ev, d);
      return;
    }
    if (d.type === "FMG_CREATE_MAP") return handleCreateMap(ev, d);
    if (d.type === "FMG_GET_SNAPSHOT") return handleGetSnapshot(ev, d);
    if (d.type === "FMG_LOAD_SNAPSHOT") return handleLoadSnapshot(ev, d);
    if (d.type === "FMG_SET_TITLE") return handleSetTitle(ev, d);
    if (d.type === "FMG_OPEN_TOOL") return handleOpenTool(ev, d);
  }

  window.addEventListener("message", onRequest, false);
  window.addEventListener("map:generated", onMapGenerated, false);
  window.addEventListener("map:generation-error", onMapGenerationError, false);
  document.addEventListener("change", announceDirty, true);
  document.addEventListener("pointerup", function (event) {
    if (event.target && document.getElementById("map") && document.getElementById("map").contains(event.target)) announceDirty();
  }, true);

  // Announce readiness so a parent frame knows the bridge is live.
  function announce() {
    if (!window.parent || window.parent === window) return;
    // This pre-connection announcement contains no map or user data. The exact origin
    // becomes known only when the parent answers with FMG_CONNECT.
    try {
      window.parent.postMessage(
        {
          type: "FMG_READY",
          protocol: PROTOCOL_VERSION,
          capabilities: ["view.switch", "map.generate", "map.snapshot", "map.restore", "map.title", "tools.open"]
        },
        "*"
      );
    } catch (e) {}
  }
  if (document.readyState === "complete" || document.readyState === "interactive") announce();
  else window.addEventListener("DOMContentLoaded", announce, false);
  window.addEventListener("load", announce, false); // a second announce is harmless

  // Expose for in-page testing / a future toolbar action.
  window.VttBridge = {
    protocol: PROTOCOL_VERSION,
    buildPayload: buildPayload,
    buildImage: buildImage,
    clampRasterScale: clampRasterScale
  };
})();
