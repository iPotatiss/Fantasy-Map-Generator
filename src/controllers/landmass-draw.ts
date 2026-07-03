import { generateLandmassInPolygon } from "../modules/landmass-recipe";
import { ensureEl } from "../utils";

interface HeightmapEditorContext {
  updateHistory: (noStat?: boolean) => void;
  mockHeightmap: () => void;
  mockHeightmapSelection: (selection: number[]) => void;
}

declare global {
  var heightmapEditorContext: HeightmapEditorContext | undefined;
  interface Window {
    LandmassDraw: { toggle: () => void };
  }
}

const BUTTON_ID = "drawLandmass";
const DIALOG_ID = "landmassDrawDialog";
const TRACE_ID = "landmassTrace";

interface SliderDef {
  id: string;
  label: string;
  tip: string;
  min: number;
  max: number;
  value: number;
}

const SLIDER_DEFS: SliderDef[] = [
  {
    id: "landmassPeakHeight",
    label: "Peak height",
    tip: "Height of the main peak. Map heights are 0-100, land starts at 20",
    min: 25,
    max: 80,
    value: 50
  },
  {
    id: "landmassCoastFalloff",
    label: "Coast width",
    tip: "Coastal falloff width as % of the shape radius. Wider = flatter, more gradual coast",
    min: 10,
    max: 60,
    value: 35
  }
];

let active = false;

function injectButton(): void {
  const tools = document.getElementById("customizeTools");
  if (!tools || document.getElementById(BUTTON_ID)) return;

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.dataset.tip = "Draw a closed shape on the map to generate a landmass inside it";
  button.textContent = "Draw Landmass";
  const anchor = document.getElementById("paintBrushes");
  if (anchor) anchor.insertAdjacentElement("afterend", button);
  else tools.appendChild(button);
  button.on("click", toggle);

  // deactivate the tool when a paint brush is selected (brushes rebind the same drag handler)
  document.getElementById("brushesButtons")?.on("click", () => {
    if (active) exit();
  });
}

function toggle(): void {
  if (active) exit();
  else enter();
}

function enter(): void {
  if (customization !== 1) {
    tip("Open the heightmap editor to draw a landmass", false, "error");
    return;
  }

  active = true;
  document.querySelector("#brushesButtons > button.pressed")?.classList.remove("pressed");
  removeCircle();
  ensureEl(BUTTON_ID).classList.add("pressed");
  openDialog();
  const d3 = (window as any).d3; // runtime d3 bundle (v5 API), loaded via script tag
  viewbox.style("cursor", "crosshair").call(d3.drag().on("start", onDrawStart));
  tip("Drag on the map to draw a closed shape, then release to generate a landmass inside it", true);
}

function exit(): void {
  if (!active) return;
  active = false;
  document.getElementById(BUTTON_ID)?.classList.remove("pressed");
  viewbox.style("cursor", "default").on(".drag", null);
  debug.select(`#${TRACE_ID}`).remove();
  clearMainTip();
  const dialog = $(`#${DIALOG_ID}`);
  if (dialog.length && dialog.dialog("isOpen")) dialog.dialog("close");
}

function openDialog(): void {
  if (!document.getElementById(DIALOG_ID)) {
    document.body.insertAdjacentHTML("beforeend", buildDialogHTML());
    for (const { id } of SLIDER_DEFS) {
      const slider = ensureEl<HTMLInputElement>(id);
      slider.on("input", () => {
        ensureEl(`${id}Out`).textContent = slider.value;
      });
    }
  }

  $(`#${DIALOG_ID}`).dialog({
    title: "Draw Landmass",
    resizable: false,
    width: "auto",
    position: { my: "right top", at: "right-10 top+30", of: "svg" },
    close: exit
  });
}

function buildDialogHTML(): string {
  const rows = SLIDER_DEFS.map(
    ({ id, label, tip, min, max, value }) => /* html */ `
      <tr data-tip="${tip}">
        <td style="padding:2px 0;white-space:nowrap">${label}</td>
        <td style="padding:2px 4px">
          <input id="${id}" type="range" min="${min}" max="${max}" step="1" value="${value}"
            style="width:150px;vertical-align:middle"/>
        </td>
        <td style="padding:2px 6px;min-width:2em;text-align:right">
          <span id="${id}Out" style="font-family:monospace;font-size:.85em">${value}</span>
        </td>
      </tr>`
  ).join("");

  return /* html */ `
    <div id="${DIALOG_ID}" class="dialog" style="display:none">
      <div style="max-width:240px;color:#666;font-size:.9em;margin-bottom:6px">
        Drag on the map to draw a closed shape. A landmass is generated inside it on release. Use Undo to revert.
      </div>
      <table style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>
    </div>`;
}

function onDrawStart(): void {
  const d3 = (window as any).d3; // runtime d3 bundle (v5 API: d3.event)
  const points: [number, number][] = [];
  debug.select(`#${TRACE_ID}`).remove();
  const trace = debug
    .append("path")
    .attr("id", TRACE_ID)
    .attr("fill", "rgba(80, 170, 90, 0.2)")
    .attr("stroke", "#3f8f4f")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "4 2");

  const addPoint = (x: number, y: number) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last[0] - x) < 0.5 && Math.abs(last[1] - y) < 0.5) return;
    points.push([rn(x, 2), rn(y, 2)]);
    trace.attr("d", `M${points.map(point => point.join(",")).join("L")}Z`);
  };

  addPoint(d3.event.x, d3.event.y);
  d3.event.on("drag", () => addPoint(d3.event.x, d3.event.y));
  d3.event.on("end", () => {
    debug.select(`#${TRACE_ID}`).remove();
    generateFromPoints(points);
  });
}

function generateFromPoints(rawPoints: [number, number][]): void {
  const tolerance = Math.max(0.5, grid.spacing / 4);
  const polygon = simplify(rawPoints, tolerance);
  if (polygon.length < 3) {
    tip("The shape is too small. Draw a larger closed shape", false, "warn");
    return;
  }

  const peakHeight = ensureEl<HTMLInputElement>("landmassPeakHeight").valueAsNumber;
  const coastFalloff = ensureEl<HTMLInputElement>("landmassCoastFalloff").valueAsNumber / 100;

  const result = generateLandmassInPolygon(polygon, { peakHeight, coastFalloff });
  if (!result) {
    tip("The shape covers too few cells. Draw a larger shape", false, "warn");
    return;
  }

  heightmapEditorContext?.mockHeightmapSelection(result.changed);
  heightmapEditorContext?.updateHistory();
  tip(`Landmass generated: ${result.landCells} new land cells`, false, "success", 4000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectButton);
else injectButton();

window.LandmassDraw = { toggle };
