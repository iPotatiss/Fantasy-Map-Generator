/* VTT bridge — feeds the live FMG map to a parent "World Map Maker" frame on demand.
 *
 * The VTT app embeds this generator in a cross-origin iframe and cannot read the map
 * out of it. This script answers a `{type:"FMG_REQUEST_EXPORT"}` postMessage from the
 * parent with `{type:"FMG_EXPORT", json}` — a JSON payload shaped exactly for the VTT's
 * `fmg-geometry.ts` struct-of-arrays reader (`fromFmgJson`), so the parent's flat/globe
 * renderer shows the current map without a file upload.
 *
 * Plain ES5, no imports. Reads FMG globals (pack, mapCoordinates, biomesData,
 * graphWidth/graphHeight). Only the sub-fields the VTT reader consumes are sent, and
 * every TypedArray is converted to a plain array (JSON.stringify turns a TypedArray into
 * an object with numeric keys, which fails the reader's Array.isArray guards). Harmless
 * no-op unless a parent frame requests an export.
 */
(function () {
  "use strict";

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
    try {
      target.postMessage(msg, origin || "*");
    } catch (e) {
      try {
        target.postMessage(msg, "*");
      } catch (e2) {}
    }
  }

  function onRequest(ev) {
    var d = ev && ev.data;
    if (!d || d.type !== "FMG_REQUEST_EXPORT") return;
    var target = ev.source || window.parent;
    var origin = ev.origin && ev.origin !== "null" ? ev.origin : "*";
    var payload;
    try {
      payload = buildPayload();
    } catch (e) {
      reply(target, origin, { type: "FMG_EXPORT", json: null, error: "serialize failed: " + (e && e.message) });
      return;
    }
    if (!payload) {
      reply(target, origin, { type: "FMG_EXPORT", json: null, error: "no map" });
      return;
    }
    var json;
    try {
      json = JSON.stringify(payload);
    } catch (e) {
      reply(target, origin, { type: "FMG_EXPORT", json: null, error: "stringify failed: " + (e && e.message) });
      return;
    }
    reply(target, origin, { type: "FMG_EXPORT", json: json });
  }

  window.addEventListener("message", onRequest, false);

  // Announce readiness so a parent frame knows the bridge is live.
  function announce() {
    if (window.parent && window.parent !== window) reply(window.parent, "*", { type: "FMG_READY" });
  }
  if (document.readyState === "complete" || document.readyState === "interactive") announce();
  else window.addEventListener("DOMContentLoaded", announce, false);
  window.addEventListener("load", announce, false); // a second announce is harmless

  // Expose for in-page testing / a future toolbar action.
  window.VttBridge = { buildPayload: buildPayload };
})();
