# The build pipeline

This engine is being pointed at one product: a maker that **looks like a generative-AI
tool and deliberately is not one.** A player makes a sequence of choices, watches a game
take shape, and plays the result. There is no model in the request path — not when a
choice is made, not when the game is assembled, not when it is rendered.

```
choices  ->  BuildSpec  ->  bake  ->  static files  ->  playable
```

Everything downstream of the first arrow is arithmetic over a seed. The same spec
produces byte-identical output on any machine, which is what makes the second generation
of the same choices cost nothing to serve.

The number that states the thesis: `specs/default.build.json` is **674 bytes** and bakes
into a **363 KB** level. The spec is the artefact; the level is derived, and
`.gitignore` says so.

---

## What a spec is

`src/world/buildSpec.js`. One JSON object, one block per rung of the choice ladder, a
32-bit `specHash` over a canonical serialisation so two specs that differ only in key
order are one spec and cache as one.

```
resolveSpec({ world: { recipe: 'alpine', seed: 'K7QN-3F2A-9XBD' } })
```

`resolveSpec` is **total** (a user who chose nothing gets a complete, playable spec),
**idempotent** (typing the defaults explicitly builds the same world as typing nothing),
and **refuses rather than guesses** — an unknown recipe throws, and a spec from a newer
generator is rejected instead of being reinterpreted as something else. Those four
properties are what `tools/test/test-buildspec.mjs` exists to defend; each of them fails
silently in a way no screenshot would show.

A recipe is a complete tuned parameter set, not a preset that nudges a slider. That is
the UX claim: the player picks **a kind of place** and gets one.

---

## The ladder, and the honest state of it

| Rung | Where it lives | State |
|---|---|---|
| World | the kernel's `src/kernel/seed.js`, `buildSpec.js` | **Built** |
| Terrain | the kernel's `src/kernel/terrain/heightfield.js`, `tools/build/bake-level.mjs` | **Built** |
| Environment | `spec.environment.lightZones` (no consumer yet) | **Absent** — no light zones, weather or time of day |
| Gameplay | `src/config/gameplay.js`; traversal walked and gated by terrain | **Built** |
| Character | `src/viewmodel/` | **Built** |
| Role | — | **Absent** |
| Mechanics | `src/weapons/`, `src/sim/GrenadeSystem.js` | **Partial** — no traversal verbs |
| Encounters | `src/game/EnemySystem.js` | **Partial** — deterministic AI/spawns/combat; encounter specs pending |
| Objectives | `src/game/ObjectiveSystem.js` | **Partial** — activate stations and extract; campaign rules pending |
| Presentation | `src/config/quality.js`, `core/DeviceProfile.js` | **Built** |
| Playable Build | `tools/build/bake-level.mjs` | **Partial** — emits a level, not a folder |

The absent rungs are named in `buildSpec.js` too, as comments on blocks that do not exist
yet. When one arrives it gets a block in the spec and a stage in the baker, and nothing
else about the pipeline changes. **The back half is the real work**; everything else is
assembly.

---

## The one architectural change this made

The engine assumed a single floor plane at `y = 0`. `src/sim/PlayerController.js` said so
in a comment and resolved its vertical position against the literal zero. That is the
assumption that stops a generated world being walkable at all, so it is the one that had
to go.

It is now a seam, `src/sim/Terrain.js`, with the same shape as the engine's other two
(`sim/grid.js`, `core/progression.js`): **a working empty default.**
`FLAT_GROUND` answers height 0 and normal up everywhere, so an engine handed no terrain
behaves exactly as it did before — to the float. That is what let the change land without
re-testing every level that was already flat.

```js
new PlayerController(camera, collision)                  // the flat plane, as before
new PlayerController(camera, collision, terrain)         // walks a height field
```

`Terrain` imports no three. Normals are written into any `{x, y, z}` the caller owns, so
the baker can ask the same questions the runtime does without pulling in the renderer.

---

## Why the runtime reads a baked field, not the recipe

Two reasons, and the second is the one that matters.

The cheap reason: `createHeightSampler` is tens of noise octaves per query, and the player
asks for a height every fixed step. The baked sampler is four array reads and three lerps.

The real reason: **the baker decided which cells are walkable by sampling something.** If
the runtime samples something else — even by a floating-point hair — a player can stand
where collision says they cannot. So the baked field is the single source of truth for
both, and the analytic sampler is an offline input to it. `tools/test/test-terrain.mjs`
pins the agreement.

---

## What the baker actually decides

`tools/build/bake-level.mjs`, two products from one height field:

- `HEIGHT_PACKED` — the field, Float32 to base64. What the player stands on.
- `WALKABLE_PACKED` — one bit per grid cell. What `CollisionSystem` has always unpacked,
  in the layout it already read. Nothing in `CollisionSystem` changed.

A cell is walkable when the ground is not too steep, not under more water than you can
wade — and then, crucially, when it is **reachable**. Slope and depth are local tests and
they will happily certify a flat shelf halfway up a cliff, because nothing about that
shelf is steep. It is just somewhere no player can get to.

So the last pass is a flood fill from the spawn over cells a player can actually *step*
between, rejecting any rise greater than `traversal.stepUp`. Everything the flood does not
reach is cleared.

The flood is not bookkeeping — it is where terrain becomes gameplay, and the numbers show
it doing real work:

```
recipe      reachable   stranded   what that means
basin          75,541      1,107   broad and gentle: most floor area, fewest sight breaks
highlands      65,023      3,872   rolling, with a few commanding rises
atoll          25,656        234   one landmass; the sea is the level boundary, so
                                   almost nothing is stranded
badlands       10,500     38,329   terraced mesas: 78% of the flat ground is flat ground
                                   you cannot reach from the flat ground you are on
alpine          8,447     19,282   sharp relief, deep draws
```

`badlands` stranding 38,329 locally-flat cells is the design working. Mesa tops **are**
unreachable from each other. That is the choice of terrain determining traversal,
encounter layout and mission structure, which is exactly what the product requires of it
— and it is also a live design question: alpine and badlands leave the player 8–10% of the
map, which wants either traversal mechanics (ladders, ziplines) or accepting vertical
isolation as the point.

The baker **exits non-zero** when it bakes something unplayable — no reachable ground, or
less than 2,000 cells / 2% of the map. A baker that silently emits an unplayable level
moves the failure in front of a player instead of in front of a build.

---

## The kernel: imported, not ported

This engine stands on the repository's kernel. It used to carry ports of three of its
modules from when the two were separate repositories, and those ports are gone: the
runtime, the baker and the tests import the kernel's own files from the repository root.

| Was here | Now imported from | Notes |
|---|---|---|
| `src/world/seed.js` | `src/kernel/seed.js` | `src/utils/math.js` re-exports the kernel's `mulberry32` (the two were already bit-identical). The kernel's `normalizeSeed` reads a falsy input as no seed; `resolveSpec` and `resolveProject` pass `String(seed ?? '')`, so `seed: 0` keeps the world it had. `randomSeed(rng)` is re-implemented in `src/utils/math.js` on the kernel's: the same draw, but a call with no entropy source throws instead of falling back to `Math.random`. |
| `src/world/terrain/noise.js` | `src/kernel/terrain/noise.js` | All of it now, the five fields the port left behind included. |
| `src/world/terrain/heightfield.js` | `src/kernel/terrain/heightfield.js` | With the layer stack and terrain intent the port dropped: a world without `terrain.stack` or `terrain.intent` takes the very recipe the port carried. `normalAt`, which only this engine uses, moved to `src/sim/Terrain.js`. |

Nothing moved. Measured before and after the swap, over every recipe on four seeds at
129² and 257², the analytic and baked samplers, `slopeAt`, `elevNorm`, the seed functions
and `mulberry32` on edge inputs: 1,673,650 values, identical to the bit; the generated-
output fixtures under `tools/test/fixtures` all still match, and so does every suite.

**The float32 bound fix went upstream.** `bakeHeightField` used to track min/max from the
sampler's double *before* the store narrowed it to float32, so the reported range did not
contain its own data — measured at 1.8e-6 m outside on the highlands recipe. This engine
found it and fixed it in its port; the kernel now carries the same fix at the source, so
importing it lost nothing. Those two numbers become `WALL_HEIGHT` and `WORLD_SCALE_Y` in the
baked level, and a bound that is not a bound is a bound nothing downstream can rely on.

**How the imports reach it.** The kernel is inside this engine, at `src/kernel/`, so a kernel
import is an ordinary relative specifier (`'../kernel/seed.js'` from `src/world/`), the same
file under Node and in a browser, and the static build, the downloaded game and
`tools/test/serve.py` all serve the repository as it sits on disk. `tools/check-imports.mjs`
holds every specifier to resolving to the same file by path and by URL, and the kernel to
importing nothing outside itself; `tools/lib/modules.mjs` is the one module graph the check,
the build and the game manifest share. The Python ports the Blender kit needs
(`tools/blender/v2/core/grammar_core.py`) stay, and are checked against the kernel's
cross-language vectors by `tools/test/test-kernel-parity.mjs`.

### Deliberately not imported

- **The old renderer.** The archived Visigenesis drew its worlds with `WebGLRenderer` and ~230
  lines of raw GLSL (`engine/Engine.js` there). This engine has one renderer, `WebGPURenderer`
  with TSL node materials (WebGL2 only as the browser's fallback), and World mode draws the
  kernel's ground with it (`src/render/WorldView.js`); the WebGL renderer was not brought.
- **`src/kernel/core/reach.js`.** The right *idea* — flood the ground over the walk
  controller's own rules, because a graph can certify a building you cannot enter — and
  the wrong code for this engine, since it is coupled to the kernel's prop records and
  shelter volumes. The baker makes the same argument against this engine's grid.
- **Erosion** (`src/kernel/terrain/erosion.js`, 215 lines + workers). A real upgrade to the
  ground's believability and not needed to prove the pipeline. It is an import away when
  wanted.

---

## Running it

```sh
node tools/check-imports.mjs                       # every src/ import resolves, the kernel's included
node tools/test/run.mjs                            # every offline suite, no network
node --import ./tools/lib/_three-real-hook.mjs \
  tools/test/walk-world.mjs --recipe alpine        # walk one world in detail
node tools/build/bake-level.mjs specs/default.build.json
node tools/build/bake-level.mjs --recipe alpine --seed K7QN-3F2A-9XBD
```

The world layer is in the test runner's **pure** group and belongs there: `src/world/*`
and `src/sim/Terrain.js` import no three, and that is a property to defend rather than a
coincidence. A generator that could reach the renderer would eventually depend on it and
stop being bakeable.

---

## Walking it

`tools/test/walk-world.mjs` drives the **real** `PlayerController` on the **real**
`CollisionSystem` over the **real** baked `Terrain` at the real fixed step, with synthetic
input. No mock stands in for anything, because every fault worth finding lives in the seam
between two of those and a mock is where a seam goes missing.

The idea is borrowed from the repository root's `tools/walk-world.mjs` (the kernel's walker) — a graph can certify
that every room has a door and the building can still be one you cannot enter, so the only
honest test is to walk it. Here the pieces are swapped: the baker's flood fill certifies
that a cell is reachable *cell to cell* at `stepUp`, and the player does not move cell to
cell. It moves 7 cm per tick through continuous space under acceleration, sliding along
blocked cells. Whether *that* body can cross *that* ground is a different question.

**It found a real bug on its first run**, and the giveaway was a statistic no screenshot
would show: worst per-tick descent, 0.0 mm. The player never went downhill. The vertical
resolve only tested `y <= groundY`, which can fire only while the ground is *rising* to
meet you; walking downhill the ground drops away, the test stays false, and because
gravity is gated on `!grounded`, nothing pulled the player down either. The body floated
off every descent still reporting `grounded` — 48% of all ticks.

The fix is a step-down branch whose threshold is the **same `stepUp`** the baker used: a
rise you could have stepped up is a drop you can step down without leaving the ground, and
anything deeper is an edge you walked off. One number, two consumers, no drift.

Current state, all five recipes, 16 headings × 12 s at 60 Hz each — **57,600 fixed steps,
no faults**:

```
recipe      mean net   worst rise   worst drop   notes
highlands     48.1 m      63.5 mm     -48.6 mm
alpine        37.5 m      47.5 mm     -25.2 mm   1/16 headings blocked within 2 m
badlands      43.2 m      37.2 mm     -24.2 mm
atoll         50.0 m      36.4 mm     -49.8 mm
basin         50.1 m      42.7 mm     -52.3 mm
```

That alpine heading is **not** a fault, and distinguishing the two took a second pass at
the assertion. "Every heading travelled more than 2 m" sounds like an engine property and
is not one: alpine has 8,447 reachable cells of 102,400, so several headings out of the
spawn face a cliff within a metre, and a body that refuses to walk into a cliff is the
engine working. Probing the mask ahead of every stalled heading showed the correlation is
exact — every heading that ran the full distance had open ground ahead, every heading that
stopped had closed cells at 0.5, 1 and 2 m. So the assertion is now *stopped with
somewhere to go*, which is an engine property.

Determinism holds all the way down: the same heading from the same spawn walks a
bit-identical path twice and lands on exactly the same float.

## What is next, in order

1. **Encounter specifications.** AI can spawn and fight, but designer-selected enemy
   compositions, wave schedules, ranged behavior and difficulty still need compiler data.
   The first objective rule is activate placed stations and return to spawn to extract.
2. **Role and progression.** Persistent loadouts and saved economy are not runtime globals.
3. **The build output.** The baker emits a level module; the product needs a folder of
   static files. That is a packaging stage, not an architectural one.

### Known limits of the ground, stated

- **No erosion.** The recipe is analytic noise plus the plate. The repository's kernel has a
  hydraulic pass (`src/kernel/terrain/erosion.js`) that would earn its cost in believability;
  it is an import away when wanted, not a port.
- **`alpine` and `badlands` leave the player 8–10% of the map.** The flood is being
  honest — mesa tops genuinely are not reachable from each other; badlands
  reads as vertical cliff faces. That wants either traversal mechanics or a
  decision that vertical isolation is the point. It is a design question, not a bug.
