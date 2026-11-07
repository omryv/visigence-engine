# Landmarks and village life

Arcade's village has places worth walking to. After the relief and the water ([TERRAIN.md](TERRAIN.md)) are
planned, a seeded graph grammar reads them and places the village's landmarks: a windmill on a rim hill, a
watermill on the brook, a well and market stalls on the square, a lookout tower across the village, and an
orchard and a farm plot at the fringe. Each claims its own level pad and a spur to a lane, collides, sits in the
nav grid and is proved reachable like everything else, and the set is chained into a route: an ordered list of
points of interest with typed hooks that the mission compiler and the wildlife read. No AI and no network are
involved: the rules in the pack (`world.landmarks`), the height grid, the brook's polyline, the lots and a little
seeded luck.

It runs on the same core as the rest of the village: seeded fields and streams, rules as data, a Python port in
the Blender preview held to identical output by fixture tests.

## Where each landmark goes

The kinds are tried in a fixed order, each claiming ground the next must respect.

| Kind | Site rule | Claim |
|---|---|---|
| **Windmill** | The highest point of a 2 m lattice in the rim band (`rim`) that is clear of lanes, pads, lots and water, whose straight spur to the nearest lane keeps under `grade`. A little seeded luck breaks near-ties. Its sails face into the toon wind (`face`, the look's `toon.wind.dir` reversed). | A 3 m pad, a spur, a circle blocker. |
| **Watermill** | A brook point with the best drop over its neighbours, away from the bridges (`keepOff`), the fords, the pool and the spring. The house stands on whichever bank is free and level, its wall `set` past the channel's edge, its right side toward the water; the pad is set `bank` above the water surface the carve will give (a running minimum of the ground along the brook), and refused when the bank would need more than `fill` of cut or fill. The carve leaves the house's rectangle alone, and the brook keeps flowing under the wheel. Its spur never fords its own brook. | A 3 m pad, a spur on its bank, a box blocker. |
| **Well** | The square, on the diagonal opposite the pool, slid outward until it clears the lanes. | A circle blocker; a keeper. |
| **Market** | Two to four stalls (`min`..`max` by the seed): the square's free diagonals first, then the lane verges just off the square, facing the centre. Each stall draws its part and its awning colour (`awnings`) from the seed. | Box blockers; a keeper each. |
| **Lookout** | The next rim hill across the village from the windmill (never the same quadrant, at least `apart` away), same grade rule. | A 2.6 m pad, a spur, a box blocker. |
| **Orchard** | Beside a fringe lot (farmhouses first, then the lots with the least village-ness), on its right, left or back at `gap`: a `grid` of blossom trees from the [tree grammar](TREES.md) at `spacing`, scaled `scale`, where every spot is clear and gentle. | Trunk blockers; a hook a metre off the edge that faces the lane, with a spur. |
| **Farm** | The same search with a `size` plot, levelled to its mean after the lots (its slab reaches past the hook, so the spur meets the plot's level). | The plot part at the centre; a hook and a spur. |

A hill or mill pad keeps `pad + pads.blend + 1.2` m from every lot: the pad's blend and the metre the bilinear
ground reads past a vertex would otherwise tilt a levelled lot. A fringe plot's hook claims no pad; it stands on the
meadow, on the edge that faces its lane, and its spur avoids the plot and the lot outlines.

## The route

`src/world/routeGraph.js` is theme-neutral. Given points of interest with hooks, it walks a greedy nearest-neighbour
chain from the spawn: at every step the closest ready node comes next, ties on the input index, so the order is
deterministic and needs no trigonometry. Hook types:

- **visit**: being there is enough (the lookout);
- **interact**: a thing to use that may `give` an item (the windmill gives flour, the watermill planks, the well
  water, the orchard apples);
- **deliver**: a place that `takes` items (the stalls take flour, apples or planks; the farm takes water). A deliver
  node is ready once one of its items has been given; it resolves to that item and the index of its giver, two
  stalls preferring different goods. With nothing to receive it degrades to a visit (`visitLabel`).

The level carries `world.route` (`start`, `nodes` with `index`, `kind`, `x`, `z`, `hook`, optional `life`,
`keeper`, `lane`, `pad`; `edges` with the metres between consecutive nodes and the lane they arrive by) and
`world.landmarks`. Every theme may ignore it. Arcade uses it twice:

- **The mission compiler** moves a `reach` step's checkpoint to the next route node a visit is enough for and that
  stands on a level pad, in route order (the lookout, or a stall with nothing to trade).
- **Village life** (`game/Wildlife.js`): a route node tagged with families (`life`) is a home those families settle
  at first (bees at the orchard, sprouts at the farm, slimes at the watermill, spirits at the lookout); a node with
  a `keeper` gets a stallholder that stands its ground behind the counter, or a water-carrier beside the well
  (`creatures.wildlife.keepers`, fewer on phones). Keepers never wander or flee.

## In the game

- `compileShooterProject` turns each landmark into a placement of the `landmark` prop with the record riding on
  it (`kind`, `part`, `colors`, `wheel`, `hook`), no collision of its own, plus a `landmark-block` (a circle for the
  windmill and the well, a box turned with the part for the rest). The orchard's trees are `tree` placements with
  trunk blockers, tagged `landmarkOf`.
- `render/LandmarkAssembler.js` builds a landmark from `arcade-landmark-parts.glb`: the still meshes merged per
  material, and every **moving node** (`Sails`, `Wheel`) as its own mesh at the node's authored transform, carrying
  `userData.spin` {axis, rate, wind}. The session's spinner loop turns each about its own axis every frame, the
  sails at the wind's strength (`TOON.windStrength`), the waterwheel at its rate: one transform each, on every
  tier. The waterwheel's axle is set to `wheel.y`, the height the grammar put it at over the water.
- The stalls' awnings are a colour slot (`LMK_Awning`) filled from the landmark's `colors`; the farm's soil and
  crops keep their authored slot colours.
- Phones and the performance tier build the `.lite` twin of every part.

## Budgets

| Part | Full | Lite |
|---|---|---|
| windmill | 1,166 | 386 |
| watermill | 676 | 336 |
| well | 466 | 152 |
| stall.a / stall.b | 552 / 484 | 84 / 84 |
| lookout | 496 | 272 |
| farm.plot | 828 | 238 |

A level with everything (a windmill, a watermill, the well, four stalls, the lookout and the farm) stays under
5,300 triangles on the full tier and 1,900 on lite; the test reports the worst level it compiled. The orchard's
trees count with the trees.

## Files

| What | Where |
|---|---|
| Rules (data) | `packs/arcade/pack.json` → `world.landmarks`: `grade`, `rim`, `apart`, `luck`, `keepers`, and `kinds` (site parameters, `pad`, `clear`, `body`, `part`/`parts`, `collision`, `hook`, `life`) |
| Grammar | `src/world/worldLandmarks.js` (`planLandmarks`, `levelLandmarks`, `finishLandmarks`, `landmarkPois`, `landmarkKeeps`, `validateLandmarkRules`), called by `layoutWorld` in `src/world/worldGrammar.js` |
| Route | `src/world/routeGraph.js` (`chainRoute`, `routeNodes`) |
| Compiler | `src/world/shooterProject.js` (`placeVillage`, the checkpoint snap) |
| Renderer | `src/render/LandmarkAssembler.js`; the spinner loop and `_landmarkVisual` in `src/game/ShooterSession.js` |
| Village life | `src/game/Wildlife.js` (`homes`, `keepers`) |
| Parts | `assets/v2/arcade/arcade-landmark-parts.glb`, built by `tools/blender/v2/arcade/landmark_parts.py`; the index `src/world/landmarkParts.js` |
| Blender preview | `tools/blender/v2/arcade/world_landmarks.py` (the port), `landmark_preview.py` (a placed landmark, the top and street views), `world_preview.py` |
| Tests | `test-world-landmarks` (rules, the route on its own, every kind's site on the parity layouts, compiled levels: blockers, pads, reachability, checkpoints, budgets, the assembler on a stand-in library), `test-world-placement` (parity), `test-wildlife` (homes and keepers) |

### Parity

As the village: no trigonometry (fronts are unit vectors, spins DIRS64 indices from `kNear`, crossings by
orientation tests), numbers out through `r4`, integer loops, ties on the lower index. The digest carries every
landmark (its kind, hook point, front, pad, height, spur, part, colours, keeper, wheel, rectangle, slab level and
the orchard's tree hashes) and the whole route. Regenerate the fixtures with
`python3 tools/blender/v2/arcade/world_grammar.py packs/arcade/pack.json tools/test/fixtures/world-layouts.json`.

### Blender

Load `world_landmarks.py` after `world_terrain.py` and before `world_grammar.py`; `landmark_parts.py` and
`landmark_preview.py` after `world_preview.py`. `build_landmark_parts()` builds the `LMK_Parts` collection,
`review_landmarks()` renders the sheet (`assets/v2/arcade/arcade-landmarks-sheet.png`), `ship_landmark_parts()`
writes the GLB and the index, `cards_landmarks()` the catalog card, and `render_landmark_views(level)` a seed's
top and street views with the landmarks in the village (`arcade-landmarks-{top,street}.png`).
