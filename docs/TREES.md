# Generated trees

Every tree in an Arcade village is grown, not placed from a file. The village layout (`src/world/worldGrammar.js`)
scatters tree points by species, and each point grows its own tree from a **constrained L-system**
(`src/world/treeGrammar.js`) seeded by the point's key: no two trees in a level are the same, the same seed
always grows the same forest, and the Blender preview renders exactly what the game builds. No AI and no network
are involved: the rules in the theme's pack, a few PRNG streams and a small library of canopy clumps.

It runs on the same core as the [creature](CREATURES.md), [house](HOUSES.md) and [village](WORLD.md) generators
(`grammarCore.js`: seeded style DNA, weighted choices bent by the DNA, compatibility tags), and it replaced the
three fixed tree GLBs (oak, pine, sapling) the layout used to scatter.

## Species

| Species | Silhouette | Where the layout favours it |
|---|---|---|
| `broadleaf` | a stout trunk into four limbs, a big central clump and clumps at every tip; forms: round, spread, leaning | the forest, away from the village |
| `conifer` | a straight trunk with drooping tiers hung along it and a spire on top; forms: dense, sparse | the forest, dry ground |
| `sapling` | a short trunk, two or three small clumps | the village green, wet ground |
| `blossom` | a low umbrella of pink or white puffs on a dark slim trunk; forms: umbrella, upright | the village and the square |
| `willow` | a wide trunk, spreading limbs with fronds hanging from every tip and a flat crown | wet ground |

## How a tree grows

1. **DNA and style.** The key draws `size`, `age`, `bushy`, `gnarl` and `tone`, then a palette (toned by the tone
   gene) and the species' `plan` slots: weighted, tagged options. An option's `set` overrides species numbers for
   this tree (a leaning oak raises its lean limit), its `tags` gate the productions below.
2. **Rewrite.** The species' `axiom` is rewritten `depth` times (more with age). Every non-terminal draws one roll
   and takes a weighted successor (`w`, bent by `favor: {gene: f}`, gated by `needs` / `clash`). Whatever is left
   after the last pass becomes the species' `tip` (a socket), so every branch ends in foliage.
3. **Interpret.** A turtle walks the string. The alphabet is small on purpose:

   | Symbol | Meaning |
   |---|---|
   | `F` | grow a tapered segment (`length[depth]`, jittered; radius times `taper`) |
   | `[` `]` | push / pop: a branch one order deeper, `branch` times thinner |
   | `+` `-` | pitch the heading up or down by `pitch` (64ths of a turn; the trunk uses `leanStep`) |
   | `/` `\` | roll about the heading by `roll` (64ths, jittered by `rollJitter`) |
   | `L` | a canopy socket: a part from `leaf.parts`, scaled by `leaf.scale`, shrinking with depth (`byDepth`) or with count (`shrink`, conifer tiers) |
   | `P` | a tip socket: a part from `leaf.tips` (the central clump, a spire, a willow crown) |

   Any other capital letter is a non-terminal for the productions. Turns are multiples of 1/64 turn from the
   house grammar's `DIRS64` table, so the Python port is bit-identical.

### The constraints

Enforced while the turtle walks, whatever the productions say:

- **segment cap** (`segments`, and `limits.segments`): further `F` are ignored; the sweep test asserts the rules
  are sized so this almost never happens;
- **lean cone**: a trunk pitch that would take the heading more than `lean`/64 turn from vertical is refused;
  branches get `spread`/64;
- **tropism**: after every segment the heading bends toward the sky (`tropism` > 0) or droops (willow);
- **crown cap** (`crown`, by size): a segment that would leave the cylinder stops at it, so no branch or clump
  reaches beyond the plan's crown radius;
- **floor** (`limits.floor`): no branch and no clump may dip under it; a frond that would is shrunk to fit or dropped;
- **socket cap** (`sockets`): met by keeping every k-th tip, so the clumps stay spread over the crown rather than
  bunched on the first branch. Tips (`P`) always stay.

### What a plan carries

`generateTree(rules, {species, key})` returns plain data: `segments` (`a`, `b`, `r0`, `r1`, depth `d`, parent
`i`), `sockets` (`part`, `p`, spin `k`, scale `s`), the palette and style, and the numbers the layout reads back:

- `trunk`: the collider radius (the first segment's base times a wall factor);
- `clear`: the trunk's height (the blocker's height);
- `crown`: the crown radius, the largest reach of any clump or branch tip;
- `top`: the highest point.

## In the village

- `world.classes` name a `tree` species instead of a prop. When a Poisson point is accepted the layout grows its
  tree (`key = seed|class|n`), stamps a `tree-trunk` circle blocker of the plan's real trunk (scaled by the size
  roll), and records the crown. `crown x world.crownFoot` is the point's **canopy footprint**: later trees and
  rocks (`canopy: true`) keep clear of it, while flora keeps only the ground footprint, so a bush still stands
  under an oak.
- `compileShooterProject` puts the plan on the placement (`tree`); `tools/test/test-world-placement.mjs` checks
  the blocker is the plan's trunk and reports the worst level's tree triangles for both builds.
- The three retired props (`oak`, `pine`, `sapling`) map to `tree` in `RETIRED_ITEMS`.

## In the game

`render/TreeAssembler.js` meshes every plan of the level into **one batch**: a tapered tube per segment (8 sides,
6 in lite), a fan on every tip, lobed roots at the trunk foot, the bark ramp baked as vertex colour, and the
canopy parts from `arcade-tree-parts.glb` at their sockets. Everything merges per (colour slot, colour, outline
width), so a village of seventy trees is under a dozen draw calls. The session's `_treeMaterial` gives each slot
its toon material (leaves the kit's foliage shade, blossom the petal shade); `_treeBatch` builds the batch; the
`lite` build (phones and the performance tier) takes the `.lite` twin of every part. The toon pass hulls the batch
by the plan's `outline`.

The parts' vertex colours are **multiplier ramps** (the kit's tone ramp divided by its sunlit stop): the plan's
palette colour is the sunlit tone, and the ramp only ever darkens toward the creases and the underside. That is
what lets one clump mesh serve pale saplings, deep oaks and pink blossom.

## Budgets

Clumps are about 200 triangles (80 lite), tiers 144 (80), fronds 142 (62). `test-tree-grammar` reports the worst
tree per species and `test-world-placement` the worst compiled level (68 trees): about 86k triangles full and
40k lite before outline shells, against 86k for the three fixed trees it replaced, with every tree unique.

## Files

| What | Where |
|---|---|
| Rules (data) | `packs/arcade/pack.json` → `trees`: colours, limits, part extents, species (palettes, plan, axiom, rules, tip, numbers, leaf) |
| Grammar | `src/world/treeGrammar.js`: `generateTree`, `treeSlotColor`, `treeDigest`, `validateTreeRules` |
| Assembler | `src/render/TreeAssembler.js`; hooks in `game/ShooterSession.js` and `render/CombatEnvironment.js` |
| Parts library | `assets/v2/arcade/arcade-tree-parts.glb`, built by `tools/blender/v2/arcade/tree_parts.py` |
| Parts index | `src/world/treeParts.js`, generated with the GLB (`r`, `top`, `bot`, `tris` per part). The rules and the pack's `parts` extents are validated against it |
| Blender preview | `tree_grammar.py` (the port), `tree_preview.py` (`assemble_tree`, the species sheet, the catalog card); `world_preview.py` grows the village's trees from their plans |
| Tests | `test-tree-grammar` (parity, sweep, reachability, budget), `test-tree-assembly` (meshing, lite), `test-world-placement` |

### Parity

`tools/test/fixtures/tree-plans.json` holds 105 plans (21 per species), written by
`python3 tools/blender/v2/arcade/tree_grammar.py packs/arcade/pack.json tools/test/fixtures/tree-plans.json`.
The world fixtures carry each scatter tree's digest hash, so a rule change regenerates both.

## Adding a species or a part

1. **A part**: author it in `tree_parts.py` with `@tpart('<id>')` and `@tpart('<id>.lite')`, its socket on the
   origin, a `TRE_` slot material and a multiplier ramp in `Col`. Run `build_tree_parts()`, `review_tree_parts()`
   and `ship_tree_parts()`; copy the measured `r`/`top`/`bot` into the pack's `trees.parts`.
2. **A species**: add it to `trees.species` (palettes, plan, axiom, rules, tip, numbers, leaf) and a class to
   `world.classes` with `tree: '<species>'`. Run the sweep: it tells you if a rule overruns the caps or a
   successor is unreachable.
3. Preview with `sheet_trees()` and `review_trees()`, regenerate the fixtures, run the three tests.
