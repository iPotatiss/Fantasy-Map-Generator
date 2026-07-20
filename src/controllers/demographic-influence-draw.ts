declare global {
  interface Window {
    DemographicInfluenceDraw: {
      start: () => void;
      cancel: () => void;
      setRegions: (regions: InfluenceDisplayRegion[]) => void;
    };
  }
}

interface InfluenceDisplayRegion {
  id: string;
  name?: string;
  field?: string;
  points: [number, number][];
}

const TRACE_ID = "demographicInfluenceTrace";
let active = false;

function drawTrace(points: [number, number][]): void {
  debug.select(`#${TRACE_ID}`).remove();
  debug
    .append("path")
    .attr("id", TRACE_ID)
    .attr("d", `M${points.map(point => point.join(",")).join("L")}Z`)
    .attr("fill", "rgba(168, 85, 247, 0.18)")
    .attr("stroke", "#a855f7")
    .attr("stroke-width", 2)
    .attr("stroke-dasharray", "7 4")
    .attr("pointer-events", "none");
}

function start(): void {
  if (customization !== 0) {
    tip("Finish the current map tool before drawing an influence region", false, "warn");
    return;
  }
  active = true;
  const d3 = (window as any).d3;
  viewbox.style("cursor", "crosshair").on(".drag", null).call(d3.drag().on("start", onDrawStart));
  tip("Draw a freehand cultural region. Release to describe what is common there", true);
}

function onDrawStart(): void {
  if (!active) return;
  const d3 = (window as any).d3;
  const points: [number, number][] = [];
  const addPoint = (x: number, y: number) => {
    const last = points[points.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y) < 2) return;
    points.push([rn(x, 2), rn(y, 2)]);
    drawTrace(points);
  };
  addPoint(d3.event.x, d3.event.y);
  d3.event.on("drag", () => addPoint(d3.event.x, d3.event.y));
  d3.event.on("end", () => finish(points));
}

function finish(rawPoints: [number, number][]): void {
  const points = simplify(rawPoints, Math.max(1, grid.spacing / 3)) as [number, number][];
  if (points.length < 3) {
    tip("Draw a larger influence region", false, "warn");
    return;
  }
  drawTrace(points);
  active = false;
  viewbox.style("cursor", "default").on(".drag", null);
  restoreDefaultEvents();
  window.dispatchEvent(
    new CustomEvent("map:influence-draft", {
      detail: { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, points }
    })
  );
  tip("Influence region outlined. Set its mix in the World Building panel", true);
}

function cancel(): void {
  active = false;
  debug.select(`#${TRACE_ID}`).remove();
  viewbox.style("cursor", "default").on(".drag", null);
  restoreDefaultEvents();
  clearMainTip();
}

function setRegions(regions: InfluenceDisplayRegion[]): void {
  debug.select("#demographicInfluences").remove();
  if (!regions.length) return;
  const group = debug.insert("g", ":first-child").attr("id", "demographicInfluences").attr("pointer-events", "none");
  for (const region of regions) {
    if (!Array.isArray(region.points) || region.points.length < 3) continue;
    group
      .append("path")
      .attr("d", `M${region.points.map(point => point.join(",")).join("L")}Z`)
      .attr("fill", region.field === "species" ? "rgba(16, 185, 129, 0.09)" : "rgba(168, 85, 247, 0.09)")
      .attr("stroke", region.field === "species" ? "#10b981" : "#a855f7")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "7 5")
      .append("title")
      .text(region.name || "Influence region");
  }
}

window.DemographicInfluenceDraw = { start, cancel, setRegions };

export {};
