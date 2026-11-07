# Relief and water

Arcade's meadow is not flat. The village layout ([WORLD.md](WORLD.md)) grows a height grid from the same seeded
fields it lays the village out with: a flat village core, rolling hills toward the rim that the lanes cut through
at an easy grade, ponds where the ground is wettest, and a stone-edged brook that runs from a spring in the hills
to a pool at the square. Everything stands on it: the ground mesh and its painted overlay, every house, tree, rock,
flower and pickup, the collision and the nav grid, the reachability proof and the wildlife. No AI and no network
are involved: the rules in the pack (`world.terrain`), the village's noise fields, one more for the hills, and one
least-cost path.

It runs on the same core as the rest of the village: seeded fields, rules as data, a Python port in the Blender
preview held to identical output by fixture tests.

## How the ground is shaped

One grid of heights, a vertex every metre over the 80 m meadow (81 x 81), is shaped in the order a builder would.

1. **Relief.** Hills from their own two-octave fbm, ramped up toward the rim (`relief.edge`, measured on the larger
   of |x| and |z|) and flattened where village-ness is high (`relief.core`), plus a low swell everywhere. The core
   stays flat; the rim rolls up to about 5 m.
2. **Lanes.** Every lane gets its own height profile: sampled along the lane, smoothed, anchored at the square (the
   spine) or where it crosses the spine (a cross lane), then limited to `lanes.grade` (7%) in both directions from
   the anchor. The ground within the lane, its verge and a shoulder takes the profile; a bank blends back to the
   hill. Where a lane climbs through a rise, it cuts a grassy bank.
3. **Spurs.** A straight ramp from each mission place's pad to its lane.
4. **Lots.** The village chooses its lots as before, but a lot whose ground spans more than `lots.range` is refused.
   Each kept lot is levelled to its mean height with a skirt; its doorstep walk ramps down or up to the lane.
5. **Water, planned after the lots** (so the houses keep theirs):
   - **Ponds** (up to three) at the moisture peaks away from the village core, the lanes, the mission places and
     the lots. Each is a 64-gon shoreline wobbled by noise sampled on a circle (so it closes).
   - **The brook**: a spring on a ring round the square (high, wet ground, a little seeded luck), the pool on the
     first of the square's diagonals where it fits, and the least-cost path between them over the grid
     (Dijkstra, eight neighbours). It is refused near the pads, the square, the ponds and the lots; it pays to
     climb, to cross a spur and (much more) to cross a lane; and it meanders on a noise field. Its polyline is
     smoothed, and every lane crossing is squared up at right angles: a **footbridge** stands there.
6. **Pads.** The spawn, every site and every place with a spur level the inner half of their clearance
   (`pads.flat`); pads that would overlap share their cluster's mean height, so neighbours never fight over the
   ground between them. The square and the pool are pads too. They are applied last, so they win.
7. **The carve.** Each pond sits on a terrace at its rim's mean height, with a lip, a shallow shelf you can wade and
   a deep centre you cannot. The brook's water surface only ever descends from the spring to the pool (a running
   minimum of the ground less a freeboard); its channel is cut below that surface with sloped banks, except under
   a footbridge, where the lane keeps its ground. The pool is a bowl inside its stone kerb.

The landmarks ([LANDMARKS.md](LANDMARKS.md)) claim their pads and spurs on this ground before it is finished: the
windmill and the lookout on rim hills, the watermill on the brook's bank (the carve leaves its house's rectangle
alone), the farm plot on a slab of its own.

Then the water is dressed: bank stones along both sides of the brook (not under a bridge, not at a ford, not in the
pool), a ring of stones at the spring, three stepping stones wherever a spur or a doorstep walk fords the brook, lily
pads and blooms on each pond, and reeds as a Poisson class that only grows at the water's edge. Willows favour the
shore and lean toward the water they stand by.

## In the game

- **The ground is the grid.** `compileShooterProject` hands the engine's `Terrain` (sim/Terrain.js) the layout's
  heights and a water-depth grid. The player, the enemies, bullets (`terrainRay`), grenades and rockets already
  read it. The nav grid is baked by `bakeNavGrid`, which refuses ground steeper than `traversal.maxSlope`, water
  deeper than `traversal.wade` (a pond's deep centre) and steps higher than `traversal.stepUp`. The brook is waded
  everywhere, so it never cuts the map; a pond's shore is where the ground stops being walkable.
- **Everything has its height.** Village placements carry the height the layout gave them: a tree or a rock the
  lowest ground under its footprint, a house its lot's pad, a lily the pond's surface. The mission's own
  placements take theirs from the terrain.
- **Reachability** (`unreachable()` with `terrain`) floods the nav grid over the relief: a place counts as reached
  only by a walk that never steps onto water too deep, a bank too steep or a rise too high.
- **The ground mesh** (`render/ArcadeGround.js`) is one grid, the meadow plus a skirt of low hills past the rim that
  keeps rising, so the level sits in a bowl rather than ending at an edge. Rows and columns are shared, so the seam
  never cracks. The **lite** tier (phones and the performance tier) is a 2 m grid, refined back to 1 m only in the
  cells that hold water or would stray more than 12 cm from the ground the player stands on (a lane's cut bank, a
  pad's edge). Where a refined cell meets a coarse one, the midpoint of their shared edge lies on the coarse edge.
- **The overlay** paints what the lighting cannot show on gentle hills: sunnier grass up the rises, deeper green in
  the hollows, bare earth on the steep banks, damp grass and a band of wet sand round every pond, the brook's
  banks and the pool.
- **The water** is one toon mesh with one material: flat colour running from the open-water tone to the shallow
  tone at the shore, the sun's two tones and the shadows that fall on it, a soft rim, and no reflections.
- **Wildlife** walks on the ground; its clearings are placed only on dry, gentle ground.

## Wind

One wind for the whole scene (`TOON.windDir`, `windStrength`, `windSpeed`, `windGust`; set from the look's
`toon.wind` in config/looks.js). Canopy clumps (render/TreeAssembler.js), and grass tufts and reeds
(render/NatureBatch.js, the parts listed in `world.sway`) carry a `sway` attribute baked by their batch: a weight
from the anchored base (0) to the free tip (1) and a phase per plant. The toon material's swaying twin and its
outline hull add the same vertex offset (two sines along the wind and a slow gust travelling across the meadow),
so the ink line never slides off the leaf and shadows move with it. It costs a few multiplies and three sines per
swaying vertex, on every tier. `?wind=off` builds no sway at all.

## Budgets

| | Full | Lite |
|---|---|---|
| Ground (meadow) | 12,800 tris (1 m grid) | 3,200 tris (2 m grid) plus ~2,300 where refined (389 cells on the showcase seed) |
| Ground (skirt) | 4,872 tris | 1,032 tris |
| Ground total | 17,672 tris | 6,566 tris (showcase seed) |
| Water | ~300 tris, one draw call | the same |
| Lite ground vs the physics ground | exact | within 12 cm |

The physics grid is the same on every tier (a replay must see one world): 81 x 81 heights and depths, 52 KB as
Float32 arrays.

## Files

| What | Where |
|---|---|
| Rules (data) | `packs/arcade/pack.json` → `world.terrain` (relief, lanes, spurs, lots, walks, pads, ponds, brook, basin, bridge, lean, shore, traversal, skirt, water colours), `world.sway`, the `reeds` class, willows' `shore`/`lean` |
| Grammar | `src/world/worldTerrain.js` (the grid, relief, lanes, pads, ponds, brook, carve, shore dressing), called by `layoutWorld` in `src/world/worldGrammar.js` |
| Compiler | `src/world/shooterProject.js` (`placeVillage`: the Terrain, heights, bridges, pool; the nav bake) |
| Engine ground | `src/sim/Terrain.js` (a water-depth grid beside the heights) |
| Meshes | `src/render/ArcadeGround.js`; the overlay and the water material in `src/render/CombatEnvironment.js` and `src/render/ArcadeToon.js` |
| Parts | `assets/v2/arcade/arcade-nature-parts.glb` (bank stones, reeds, lily pads and blooms, the footbridge, the pool), built by `tools/blender/v2/arcade/nature_parts.py` |
| Blender preview | `tools/blender/v2/arcade/world_terrain.py` (the port), `world_preview.py` (the ground mesh, the water, the terrain sheet) |
| Tests | `test-world-placement` (parity, heights, pads, grades, water, reachability over the relief, tiers and budgets), `test-tree-assembly` (sway, lean), `test-render-contracts` (wind, water) |

### Parity

As the village: no trigonometry in the grammar (directions from `DIRS64`), numbers out through `r4`, integer loops,
ties on the lower index. The brook's Dijkstra pops `(cost, index)` pairs in lexicographic order on both sides (a
small binary heap in JS, `heapq` in Python), so equal costs resolve the same way. The digest carries a hash of the
height and depth grids (millimetre integers), the ponds, the brook's points and surface, its bridges and pool, and
every placement's height. Regenerate the fixtures with
`python3 tools/blender/v2/arcade/world_grammar.py packs/arcade/pack.json tools/test/fixtures/world-layouts.json`.

### Blender

Load `world_terrain.py` before `world_grammar.py`. `build_village(level, dressing=False)` builds the ground, the
water and the paths with the water's own parts only; `render_terrain_top()` renders the map under a low sun (from
straight above, a noon sun would flatten the hills); `render_village_street(at=..., look=...)` stands at eye height
on the ground; `render_terrain_sheet(level)` puts both side by side (`assets/v2/arcade/arcade-terrain-sheet.png`).
`review_water_parts()` renders the new parts.
