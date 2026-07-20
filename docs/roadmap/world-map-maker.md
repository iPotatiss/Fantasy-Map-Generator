# World Map Maker roadmap

## Generation direction controls

New worlds must expose creative direction before generation instead of immediately producing an unexplained random map.

- Water coverage as an explicit percentage, with a live plain-language description of the likely result.
- Landmass count, scale and distribution.
- Continental, archipelago, island-world and Earth-like presets.
- Climate, poles, elevation, rivers, cultures, kingdoms and settlement-density controls.
- A simple primary panel with optional advanced controls.
- Deterministic regeneration: the same seed and settings must reproduce the same editable world.

Water percentage is a creative target rather than a promise that every generated cell will match exactly. Generation should converge toward the requested ratio and show the achieved percentage afterward.

## Creative drawing and painting editor

Procedural generation is one starting point, not the only workflow. The World Map Maker must also support an Inkarnate-style creative editor using our own assets and interaction design.

- Paint and erase land, water, terrain, biomes, climates and political ownership directly on the world.
- Brush, mask, stamp, path, shape and text tools with adjustable size, softness, falloff and scatter.
- A searchable stamp and texture library for mountains, forests, settlements, landmarks and decorative elements.
- Layers with visibility, locking, opacity, ordering and non-destructive editing.
- Square, hex and isometric grids where relevant, plus notes and map labels.
- Import a background or custom user assets, and export PNG / WebP while preserving the full editable project.
- Drawing tools and procedural tools must work together: generate a world, paint over it, regenerate a selected region, or begin entirely by hand.
- Battle, regional, city and world-map workspaces should share the same understandable creative language without forcing identical tools at every scale.

### Freeform region recipe — shipped first slice (2026-07-20)

- Blank embedded projects initialize an empty editable terrain grid.
- Freeform Region retains the user's outline and waits for an explicit recipe;
  pointer release no longer generates immediately.
- The VTT recipe bridge supports land, hills, mountains, lakes, terrain/coast
  character, state count, and target state-area shares.
- Re-drawing over generated terrain performs a regional terrain operation while
  risk-mode restoration keeps unrelated geography and data intact.
- Target state shares bias organic state expansion and are deliberately
  approximate rather than cutting visibly artificial percentage wedges.
- Still planned: biome/climate/hydrology recipes, named states before generation,
  editable retained recipe layers, and localized settlement controls.
