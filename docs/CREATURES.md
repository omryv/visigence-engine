# Generated creatures

Arcade's critters are generated, not hand-placed models. The engine assembles every enemy and every friendly
animal from a seed. It uses no AI and no network: only the rules in the theme's pack and one PRNG stream.
The same seed always gives the same creature, and the Blender preview renders exactly what the game spawns.

The design is a hierarchical stochastic grammar rather than independent random choices:

1. **Style DNA.** A seed becomes a small set of genes: size, roundness, ornament and tone.
   - The genes are correlated. Small creatures lean round, and smaller ones get relatively bigger eyes.
   - Every later choice reads them, so proportions, parts, colours and expression agree with each other.
2. **Body plan.** A family's plan fills slots in order: body, then cap, shell, ears, wings, horns and so on.
   Each slot is a weighted choice.
   - Weights are conditioned on the DNA. For example, `favor: {round: 0.8}` scales an option up to 1.8x toward rounder creatures.
   - Compatibility tags gate options. `needs` requires a tag already chosen; `clash` forbids one. For example, a ring of spots clashes with a cone cap.
   - Optional steps fire with a chance scaled by the ornament gene.
   - Rank and role pick the palette, any required parts (the King Slime's crown) and the mood the expression is drawn from.
3. **Assembly.** The blueprint becomes geometry from one parts library.
   - Every part sits on its parent's **socket**; paired sockets are mirrored.
   - Colour **slots** take the palette.
   - The face is **projected** onto the body with rays.
   - Surface patterns are scattered by **Poisson-disc** sampling on the sphere of directions.

## Files

| What | Where |
|---|---|
| Rules (data) | `packs/arcade/pack.json` → `creatures`: colours, expressions, moods, families, roster, wildlife |
| Grammar | `src/world/creatureGrammar.js`: `generateCreature(rules, {family, key, role, rank})` → blueprint, plus `validateCreatureRules`; its choice helpers live in `grammarCore.js`, shared with the [house generator](HOUSES.md) |
| Assembler | `src/render/CreatureAssembler.js`: blueprint + parts GLB → a merged, rigid-ready model |
| Wildlife | `src/game/Wildlife.js`: friendly wanderers (presentation only) |
| Parts library | `assets/v2/arcade/arcade-creature-parts.glb`, built by `tools/blender/v2/arcade/creature_parts.py` |
| Parts index | `src/world/creatureParts.js` (generated with the GLB); the rules are validated against it |
| Blender preview | `tools/blender/v2/arcade/creature_grammar.py` (a port of the grammar) and `creature_preview.py` (sheet and cards) |
| Tests | `test-creature-grammar` (parity, constraints, reachability), `test-creature-assembly`, `test-wildlife` |

## The parts contract

- **Nodes.** Each part is one top-level glTF node named by its id (`slime.body.drop`). GLTFLoader strips `.`
  and `:` from node names, so the engine reads the id from `userData.name`.
- **Sockets.** Sockets are child nodes with `extras.socket` (`top`, `arm`, `foot`, `wing`, `antenna`, `ear`,
  `horn`, `shell`, `neck`). A child part attaches with its origin on the socket and its axes on the socket's axes.
- **Paired sockets** exist on the right (+X) side only. The left side is a mirrored copy of the geometry with
  its triangles re-wound, so every transform stays positive.
- **Materials** are colour slots named `CRT_<Slot>`: Body, Accent, Trim, Leaf, Wood, Gold, Stone, Wing, Ink,
  White. Each is authored white × the `Col` vertex gradient, and the palette fills it.
- **Bodies** carry `extras.face = {c, el, az, r}`: the ray origin, the eye elevation and half-spacing in
  degrees, and the eye radius.
- **Caps and shells** carry `extras.pattern = {c, el: [lo, hi]}`, the zone that patterns scatter over.
- **Outlines.** `extras.arc_outline` is each part's outline width at library scale. The toon kit scales it
  with the creature.
- **Scale.** A body stands about 1 unit tall, faces +Z (Blender -Y) and sits on the floor. The session
  scales each creature to its roster height through `prepareRigidBody`.

## In the game

- **Enemies.** Each roster entry becomes a catalog enemy whose `model` is the parts library and whose
  `generator` names the family (and rank, for the boss).
  - Every spawn is assembled from `project seed | enemy id | spawn seed`, so no two critters in a mission
    look quite alike.
  - They fight with the archetype's melee lunge and animate with `RigidAnimator` (style per family in
    `config/enemyAnim.js`).
  - Fliers set `hover` on their family.
- **Wildlife.** In every genre, `wildlife.count` friendly creatures (`mobile` on phones) wander the meadow.
  - They are drawn from the `friendly` moods and are smaller by the size gene.
  - They are placed by blue-noise dart throwing, clear of the spawn, the objectives and the pickups.
  - They rest, wander around cover and flee when the player comes close.
  - They are presentation only: no collider, no damage, never part of the fixed-step simulation.
- **Draw calls.** A creature is merged into one mesh per material and outline width, typically 5–9 meshes
  plus its outline shells.

## Adding a family

1. **Author the parts** in `creature_parts.py`. Register each with `@part('<family>.<kind>.<name>')`, give it
   sockets and, for a body, `face_meta`. Then run `build_parts()` and `ship_parts()`. That writes the GLB and
   `src/world/creatureParts.js`.
2. **Add the family** to `creatures.families`: its palettes and a `plan` that starts with the body slot. Add
   a roster entry, and the family to `wildlife.families` if it should roam.
3. **Preview it** with `sheet_creatures()` and `review_creatures()`, then render the cards with
   `cards_creatures()`.
4. **Regenerate the fixtures** with `python3 tools/blender/v2/arcade/creature_grammar.py packs/arcade/pack.json
   tools/test/fixtures/creature-blueprints.json`, and rebuild the catalog with `node tools/build/build-catalog.mjs`.
5. **Run the tests.** `test-creature-grammar` fails if a rule names a missing part or socket, if a weighted
   option can never be reached, or if the Python port drifts from the engine.
