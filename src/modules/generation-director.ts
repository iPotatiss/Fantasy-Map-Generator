import { ensureEl, minmax } from "../utils";

export type SettlementDensity = "sparse" | "balanced" | "dense" | "bustling";
export type CapitalImportance = "natural" | "prominent" | "dominant";

type GenerationPreset = {
  name: string;
  template: string;
  water: number;
  settlementDensity: SettlementDensity;
  capitalImportance: CapitalImportance;
  states: number;
};

export const GENERATION_PRESETS: Record<string, GenerationPreset> = {
  earthLike: {
    name: "Earth-like",
    template: "continents",
    water: 71,
    settlementDensity: "balanced",
    capitalImportance: "prominent",
    states: 18
  },
  continental: {
    name: "Continental world",
    template: "continents",
    water: 60,
    settlementDensity: "balanced",
    capitalImportance: "prominent",
    states: 20
  },
  archipelago: {
    name: "Archipelago world",
    template: "archipelago",
    water: 78,
    settlementDensity: "dense",
    capitalImportance: "prominent",
    states: 14
  },
  islandWorld: {
    name: "Island world",
    template: "shattered",
    water: 84,
    settlementDensity: "sparse",
    capitalImportance: "prominent",
    states: 10
  },
  pangaea: {
    name: "Pangaea empires",
    template: "pangea",
    water: 55,
    settlementDensity: "dense",
    capitalImportance: "dominant",
    states: 22
  }
};

export function getSettlementDensityMultiplier(value: string): number {
  if (value === "sparse") return 0.6;
  if (value === "dense") return 1.5;
  if (value === "bustling") return 2.2;
  return 1;
}

export function getCapitalImportanceMultiplier(value: string): number {
  if (value === "natural") return 0;
  if (value === "dominant") return 1.5;
  return 1.15;
}

export function allocateByWeight(
  total: number,
  entries: { id: number; weight: number }[],
  minimum = 0
): Map<number, number> {
  const allocation = new Map(entries.map(({ id }) => [id, 0]));
  if (!entries.length || total <= 0) return allocation;

  const safeMinimum = Math.min(Math.max(0, Math.floor(minimum)), Math.floor(total / entries.length));
  const remaining = total - safeMinimum * entries.length;
  for (const { id } of entries) allocation.set(id, safeMinimum);

  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(entry.weight, 0), 0) || entries.length;
  const shares = entries.map(entry => {
    const exact = remaining * ((Math.max(entry.weight, 0) || (totalWeight === entries.length ? 1 : 0)) / totalWeight);
    const whole = Math.floor(exact);
    allocation.set(entry.id, (allocation.get(entry.id) || 0) + whole);
    return { id: entry.id, remainder: exact - whole };
  });

  const allocated = [...allocation.values()].reduce((sum, value) => sum + value, 0);
  const leftovers = total - allocated;
  shares.sort((a, b) => b.remainder - a.remainder || a.id - b.id);
  for (let i = 0; i < leftovers; i++) {
    const id = shares[i % shares.length].id;
    allocation.set(id, (allocation.get(id) || 0) + 1);
  }
  return allocation;
}

export function directWaterCoverage(source: Uint8Array, targetPercent: number): Uint8Array {
  const target = minmax(Number.isFinite(targetPercent) ? targetPercent : 70, 5, 95);
  const desiredWaterCells = Math.round((source.length * target) / 100);
  if (!source.length || desiredWaterCells <= 0 || desiredWaterCells >= source.length) return source.slice();

  const ranked = Array.from(source.keys()).sort((a, b) => source[a] - source[b] || a - b);
  const waterEdge = source[ranked[Math.max(0, desiredWaterCells - 1)]];
  const landEdge = source[ranked[Math.min(source.length - 1, desiredWaterCells)]];
  const threshold = (waterEdge + landEdge) / 2;
  const offset = 20 - threshold;
  const directed = new Uint8Array(source.length);

  for (let rank = 0; rank < ranked.length; rank++) {
    const index = ranked[rank];
    const shifted = minmax(Math.round(source[index] + offset), 0, 100);
    directed[index] = rank < desiredWaterCells ? Math.min(19, shifted) : Math.max(20, shifted);
  }
  return directed;
}

function setInputValue(id: string, value: string | number) {
  const input = ensureEl(id) as HTMLInputElement | HTMLSelectElement;
  input.value = String(value);
  const output = document.getElementById(id.replace(/Input$/, "Output")) as HTMLOutputElement | null;
  if (output) {
    output.value = String(value);
    output.textContent = String(value);
  }
}

function setHeightmapTemplate(value: string) {
  const names: Record<string, string> = {
    continents: "Continents",
    archipelago: "Archipelago",
    shattered: "Shattered",
    pangea: "Pangea"
  };
  const select = ensureEl("templateInput") as HTMLSelectElement;
  select.replaceChildren(new Option(names[value] || value, value, true, true));
}

function applyPreset(id: string) {
  const preset = GENERATION_PRESETS[id];
  if (!preset) return;

  setHeightmapTemplate(preset.template);
  setInputValue("waterCoverageInput", preset.water);
  setInputValue("settlementDensityInput", preset.settlementDensity);
  setInputValue("capitalImportanceInput", preset.capitalImportance);
  setInputValue("statesNumber", preset.states);
  updateWaterDescription(preset.water);

  for (const option of ["template", "waterCoverage", "settlementDensity", "capitalImportance", "statesNumber"]) {
    window.lock(option);
  }
  tip(`${preset.name} direction applied. Generate a new map to use it.`, false, "success", 3200);
}

function updateWaterDescription(value: number | string) {
  const target = Number(value);
  const description = ensureEl("waterCoverageDescription");
  description.textContent =
    target >= 82
      ? "Mostly ocean; scattered islands"
      : target >= 72
        ? "Ocean-rich; Earth-like balance"
        : target >= 58
          ? "Balanced seas and continents"
          : "Land-heavy; large connected realms";
}

function applyWaterCoverage(heights: Uint8Array, targetPercent: number) {
  const directed = directWaterCoverage(heights, targetPercent);
  const achieved = directed.length
    ? (directed.reduce((sum, height) => sum + Number(height < 20), 0) / directed.length) * 100
    : 0;
  const output = document.getElementById("waterCoverageAchieved");
  if (output) output.textContent = `Generated: ${achieved.toFixed(1)}% water`;
  return directed;
}

function updateSettlementSummary() {
  const settlements = pack.burgs.filter(burg => burg.i && !burg.removed);
  const activeStates = pack.states.filter(state => state.i && !state.removed);
  const inhabitedByState = activeStates.map(state => settlements.filter(burg => burg.state === state.i).length);
  const minimum = inhabitedByState.length ? Math.min(...inhabitedByState) : 0;
  const summary = document.getElementById("settlementGenerationSummary");
  if (summary) {
    summary.textContent = `${settlements.length} settlements across ${activeStates.length} realms - least-populated realm: ${minimum}`;
  }
}

window.GenerationDirector = {
  applyPreset,
  applyWaterCoverage,
  updateSettlementSummary,
  updateWaterDescription,
  getSettlementDensityMultiplier,
  getCapitalImportanceMultiplier
};
