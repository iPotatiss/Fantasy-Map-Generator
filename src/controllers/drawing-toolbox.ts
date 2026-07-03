import { ensureEl } from "../utils";

/**
 * Drawing toolbox — a persistent left-side panel that is the single home for
 * "draw a new feature" tools. Each button launches an existing drawing engine:
 *   • Draw Road     → createRoute()  (routes-creator.js) — lay a path that becomes a real route
 *   • Draw River    → createRiver()  (rivers-creator.js)
 *   • Draw Landmass → editHeightmap({mode:"risk", tool:"landmass"}) → LandmassDraw (M1)
 *
 * Anything drawn is editable afterwards with the normal node-drag editors
 * (click the road/river/coast → control points → drag). New tools drop in by
 * adding a TOOLS entry.
 */

declare global {
  var createRoute: (defaultGroup?: string) => void;
  var createRiver: () => void;
  var editHeightmap: (options?: { mode?: string; tool?: string }) => void;
  interface Window {
    DrawingToolbox: { toggle: () => void };
  }
}

const PANEL_ID = "drawingToolbox";
const COLLAPSE_KEY = "drawingToolboxCollapsed";

interface ToolDef {
  id: string;
  icon: string;
  label: string;
  tip: string;
  run: () => void;
}

const TOOLS: ToolDef[] = [
  {
    id: "drawRoadTool",
    icon: "🛣️",
    label: "Road",
    tip: "Draw a road: click to lay points along a path, then complete it to add a real route. Edit later by clicking the road.",
    run: () => createRoute("roads")
  },
  {
    id: "drawRiverTool",
    icon: "🌊",
    label: "River",
    tip: "Draw a river: click to lay its course from source to mouth. Edit later by clicking the river.",
    run: () => createRiver()
  },
  {
    id: "drawLandmassTool",
    icon: "🏝️",
    label: "Landmass",
    tip: "Draw a landmass: opens the heightmap editor (Risk mode keeps your world) and starts the shape tool. Draw a closed shape to grow land inside it.",
    run: () => editHeightmap({ mode: "risk", tool: "landmass" })
  }
];

function build(): void {
  if (document.getElementById(PANEL_ID)) return;

  const collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
  const buttons = TOOLS.map(
    t => /* html */ `
      <button id="${t.id}" data-tip="${t.tip}" title="${t.tip}"
        style="display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;background:none;
               cursor:pointer;font-size:13px;color:#222;text-align:left;border-radius:4px">
        <span style="font-size:18px;line-height:1;width:20px;text-align:center">${t.icon}</span>
        <span>${t.label}</span>
      </button>`
  ).join("");

  const html = /* html */ `
    <div id="${PANEL_ID}" style="position:fixed;left:8px;top:50%;transform:translateY(-50%);z-index:40;
        width:150px;background:rgba(255,255,255,0.94);border:1px solid #b9b9b9;border-radius:7px;
        box-shadow:0 2px 10px rgba(0,0,0,0.22);font-family:inherit;user-select:none;backdrop-filter:blur(2px)">
      <div id="${PANEL_ID}Header" style="display:flex;align-items:center;justify-content:space-between;
          padding:6px 8px;cursor:pointer;border-bottom:1px solid #e0e0e0;font-weight:600;font-size:12px;
          color:#444;letter-spacing:.03em">
        <span>✏️ DRAW</span>
        <span id="${PANEL_ID}Chevron" style="font-size:11px;color:#888">${collapsed ? "▸" : "▾"}</span>
      </div>
      <div id="${PANEL_ID}Body" style="padding:4px;display:${collapsed ? "none" : "flex"};flex-direction:column;gap:2px">
        ${buttons}
      </div>
    </div>`;

  document.body.insertAdjacentHTML("beforeend", html);

  const body = ensureEl(`${PANEL_ID}Body`);
  const chevron = ensureEl(`${PANEL_ID}Chevron`);
  ensureEl(`${PANEL_ID}Header`).on("click", () => {
    const isCollapsed = body.style.display === "none";
    body.style.display = isCollapsed ? "flex" : "none";
    chevron.textContent = isCollapsed ? "▾" : "▸";
    localStorage.setItem(COLLAPSE_KEY, isCollapsed ? "0" : "1");
  });

  for (const tool of TOOLS) {
    const btn = ensureEl<HTMLButtonElement>(tool.id);
    btn.on("mouseenter", () => (btn.style.background = "#e8eef5"));
    btn.on("mouseleave", () => (btn.style.background = "none"));
    btn.on("click", () => {
      try {
        tool.run();
      } catch (e) {
        console.error(`Drawing tool "${tool.label}" failed`, e);
      }
    });
  }
}

function toggle(): void {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.style.display = panel.style.display === "none" ? "" : "none";
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
else build();

window.DrawingToolbox = { toggle };
