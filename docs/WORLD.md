# The village layout

Arcade's meadow is laid out by the engine, not by hand. Given a seed and the places the mission already claimed
(the spawn, the pads, the gates and the cover), `src/world/worldGrammar.js` returns a village: lanes and a square,
house lots along them, groves and single trees, rocks, fences, flowers, clearings for wildlife, pickups and
signposts. No AI and no network are involved: the rules in the theme's pack, three noise fields and a few PRNG
streams. The same seed always gives the same village, the Blender preview renders exactly what the game compiles,
and every place the mission claimed stays clear and reachable by construction.

It runs on the same core as the [creature](CREATURES.md) and [house](HOUSES.md) generators (`grammarCore.js`), and
it replaces the fixed dressing grid Arcade used to share with the other themes. The ground it stands on is not
flat: [TERRAIN.md](TERRAIN.md) describes the relief and the water (ponds, a brook to the square, footbridges) that
the layout grows as it goes, and that every placement below takes its height from. [LANDMARKS.md](LANDMARKS.md)
describes the landmarks the layout then places on them (a windmill, a watermill, the well and the market, a lookout,
an orchard and a farm) and the route graph that chains them.

## How a village is laid out

1. **Fields.** Three scalar fields over the meadow, each in 0–1, from seeded value noise on an integer lattice:
   - **village-ness**: a radial fall-off from the square, blended with noise, so the centre is built up and the
     corners are not;
   - **forest density**: noise, thinned where the village is and thickened toward the rim, so the map reads as a
     clearing in a wood;
   - **moisture**: noise. Wet ground grows flowers and bushes and darkens the lawn; dry ground gets rocks and pale
     grass.

   Every later choice reads them, so the houses, the groves and the flowers agree about where the village is.
2. **Paths.** A spine down the centre lane, cross lanes and a village square, each wobbled by noise. Every reserved
   place gets a straight spur to the nearest lane. Paths are corridors nothing may stand in, which is what keeps
   the level navigable: the spawn is on the spine, and every pad, gate and cover is on a lane or at the end of a
   spur.
3. **Lots.** House lots are walked along each lane, on both sides, and along the avenue's tree line (the spine's
   lots stand back behind the pads, where the old grid stood them). A lot is taken where village-ness passes a
   threshold; its family is drawn from `houses.mix`, bent by village-ness (`near`: townhouses by the square,
   farmhouses at the fringe); its size is the family's (`world.houses.lots`). A lot that would overlap a reserved
   place, another lot, a lane, a spur or the meadow's edge is refused. The survivors are thinned to the cap by
   village-ness, then each gets a plan from the house grammar, a fence along its front with a gap at the door, and
   a walk with stepping stones from the door to the lane.
4. **Clearings.** Wildlife zones, sampled where neither the village nor the forest is: `Wildlife` takes its homes
   from them.
5. **Scatter.** Poisson-disc sampling per class (Bridson's algorithm) over the whole meadow: rocks, stumps, the
   five tree species (broadleaf, willow, conifer, blossom, sapling), bushes, mushrooms, flowers and tufts, in that
   order, each with its own radius `r`. Within a class, points keep `r` apart; between classes they keep their
   footprints apart, so a bush may stand under an oak. A tree class grows each accepted point's own tree from the
   [tree grammar](TREES.md): the plan's trunk radius is the point's collider, and its crown radius (times
   `crownFoot`) the canopy footprint later trees and rocks keep clear of.
   A candidate the mask or the fields refuse still carries the sampling front as a ghost (it keeps the spacing but
   is never emitted), so sparse regions are still crossed. Each class is thinned to its cap by a roll drawn at
   emission, so the survivors stay spread out rather than clustered where the sampling began.
6. **Pickups and signposts** on the lane verges.

## In the game

- `compileShooterProject` calls the layout for Arcade after the mission's own placements and turns it into
  placements: houses with one collision box per block, fences, generated trees (the plan rides on the placement)
  with a **trunk** circle blocker of the plan's real trunk radius and height (a tree is walk-through except its
  trunk, tall enough to stop a shot), rocks, flora and pickups. Everything the village placed carries `village: true`.
- **Tiers see one world.** Everything that collides is placed the same for every device, because a replay must
  see one level. Only flora (visual, no collision) carries a `lod`: 0 everywhere, 1 dropped on phones, 2 dropped on
  phones and the performance tier.
- **Flora is batched.** `render/NatureBatch.js` merges every plant from `arcade-nature-parts.glb` into one mesh per
  material and outline width: a meadow of 300 plants is five or six draw calls. Trees are batched the same way by
  `render/TreeAssembler.js`, one batch for the whole level.
- **The ground overlay.** `CombatEnvironment` paints one non-repeating canvas over the meadow (512 px on phones,
  1024 elsewhere) and blends it onto the lawn tile inside the toon material: the lanes, the square, the spurs and
  the walks in packed sand with a worn grass edge, moisture tints, and a blush of petals under each flower cluster.
  The level carries what it needs as `level.world`.
- **Wildlife** starts in the clearings.
- A creator who disconnects the flora, the fence, a tree or the house from the prop pool gets a village without
  them, never an error.

## Budgets

Caps are in the rules and sized for phones: at most 10 houses, 70 trees (18 broadleaf, 6 willow, 22 conifer, 8
blossom, 16 sapling), 22 rocks and 70 fence pieces collide; the test reports the worst level it compiled, with its
trees' triangles for the full and the lite build. Flora caps (40 bushes, 60 flower clusters, 160 tufts and so on)
are for the full tier; the lods thin them below.

## Files

| What | Where |
|---|---|
| Rules (data) | `packs/arcade/pack.json` → `world`: fields, paths, clearances, lots, fences, `crownFoot`, classes, wildlife, pickups, signs, overlay colours, `terrain` and `sway` ([TERRAIN.md](TERRAIN.md)), `landmarks` ([LANDMARKS.md](LANDMARKS.md)) |
| Grammar | `src/world/worldGrammar.js`: `layoutWorld`, `worldFields`, `worldDigest`, `validateWorldRules`, `unreachable`; the relief and water in `src/world/worldTerrain.js` |
| Compiler | `src/world/shooterProject.js` (`placeVillage`) |
| Flora batch | `src/render/NatureBatch.js`; the ground overlay is in `src/render/CombatEnvironment.js` |
| Parts library | `assets/v2/arcade/arcade-nature-parts.glb`, built by `tools/blender/v2/arcade/nature_parts.py` |
| Parts index | `src/world/natureParts.js`, generated with the GLB. The rules are validated against it |
| Blender preview | `tools/blender/v2/arcade/world_grammar.py` (the port) and `world_preview.py` (a compiled level in the ARC_Village scene with its houses and trees grown from their plans, top-down and street renders) |
| Tests | `test-world-placement` (parity, clearance, reachability, overlaps, caps, tiers, disconnected pools) |

### Parity

- No trigonometry: directions come from `DIRS64` and yaws leave as unit `front` vectors or a 64th-turn index `k`.
- Numbers leave through `r4` (floor(x + 0.5)); loops count integers; each stage draws from its own stream in a
  fixed order whatever branch is taken (every Poisson candidate draws four numbers, refused or not).
- `tools/test/fixtures/world-layouts.json` holds 19 layouts (digests, not plans: the house fixtures hold those),
  written by `python3 tools/blender/v2/arcade/world_grammar.py packs/arcade/pack.json tools/test/fixtures/world-layouts.json`.

## Adding a class or a part

1. **Author the part** in `nature_parts.py` with `@npart('<id>')`, standing on its origin at game scale, with the
   kit's ARC_ materials and an `nfinish` outline width. Run `build_nature_parts()`, `review_nature()` and
   `ship_nature_parts()`; that writes the GLB and `src/world/natureParts.js`.
2. **Add the class** to `world.classes`: `r` (its Poisson radius), `foot` (its footprint radius against other
   classes), `max`, `base` (its base chance), `favor` (which fields bend it), `lod`, and one of `prop` (a catalogue
   prop; `trunk` and `height` add a trunk blocker), `parts` (library part ids) or `tree` (a species of the tree
   rules: the plan's trunk and crown feed back). `canopy: true` makes a class keep clear of crowns. Order matters:
   earlier classes claim ground first.
3. **Preview it** in Blender: dump a compiled level (any test can print one), `build_village(path)`, then
   `render_village_top()` and `render_village_street()`.
4. **Regenerate the fixtures** and run `test-world-placement`.
