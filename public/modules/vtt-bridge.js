/* VTT bridge — connects FMG to a parent "World Map Maker" frame.
 *
 * Protocol 2 binds the exact parent window, origin and random session before it accepts
 * Builder / Globe view commands. Map geometry and image data are never sent to the parent.
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

  function handleConnect(ev, data) {
    if (!fromParent(ev) || data.protocol !== PROTOCOL_VERSION || !validSessionId(data.sessionId)) return;

    // A reload of the host application may create a fresh session while retaining the
    // same iframe. Only the already-bound parent at the same exact origin may rebind it.
    if (client && (client.source !== ev.source || client.origin !== ev.origin)) return;
    if (!client || client.sessionId !== data.sessionId) {
      viewQueue = [];
    }
    client = { source: ev.source, origin: ev.origin, sessionId: data.sessionId };
    protocolReply("FMG_CONNECTED", data, {
      view: currentView(),
      capabilities: ["view.switch"]
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
  }

  window.addEventListener("message", onRequest, false);

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
          capabilities: ["view.switch"]
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
