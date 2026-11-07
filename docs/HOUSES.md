# Generated houses

Arcade's village is generated. It has no hand-placed buildings: every house in a level is built from a seed by a
shape grammar, using the rules in the theme's pack, a few PRNG streams and one small parts library. No AI and no
network are involved. The same seed always gives the same house, and the Blender preview renders exactly what the
game builds.

It runs on the same core as the [creature generator](CREATURES.md) (`src/world/grammarCore.js`): a seeded style DNA,
weighted choices conditioned on that DNA, and compatibility tags. Each stage then refines the one before, the way a
builder thinks.

1. **Style DNA.** A seed becomes five genes: size, tall, whimsy, ornament and tone.
   - Small houses lean whimsical, so steep roofs and crooked chimneys come with them.
   - Ornament drives trims such as shutters, flower boxes, canopies and toppers, and also narrows the bays.
   - Tone shifts the palette, so neighbours differ while each family stays recognisable.
2. **Style.** The family's `plan` fills slots with weighted, tagged choices: ridge, walls, roof, covering, door,
   windows, annex, chimney, dormers and trims.
   - `favor` bends an option toward a gene.
   - `needs` and `clash` gate options on tags already chosen. For example, dormers need a roof whose eaves face the
     front.
3. **Footprint.** A main block, then at most one annex on one of its faces:
   - a **wing**: an extension on a gable end, or a cross gable whose roof runs into the main roof;
   - a **lean-to**: a shed roof on a gable wall, up a taller house, or tucked under a low eave;
   - a **corner turret**: round with a cone roof, or square with a pyramid roof.

   The main block gives up the room its annex needs. An annex that would overflow the lot, overtop the main roof or
   leave the front without a door is refused.
4. **Facades.** Each wall is split in turn:
   - into the stretches no other block covers;
   - then into storeys;
   - then into bays.

   Bays become:
   - exactly one door, on the front;
   - windows mirrored about the facade centre;
   - blank timber-braced panels;
   - a bay window or a balcony on the townhouse's upper floor.

   A wide door or bay window makes a crowded neighbouring window give way. Gables get attic windows, and round towers
   get windows on a ring.
5. **Details.** The chimney (stacked on the ridge, or an outside stack up a gable wall), dormers, a roof topper and a
   yard prop.

## Four families

| Family | Shape |
|---|---|
| `cottage` | 1 storey plus attic; timber-framed plaster (sometimes stone); gable roof with pillow tiles or thatch |
| `townhouse` | 2–3 storeys, narrow, steep gable; timber, or a stone ground floor under timber; dormers, bay window, balcony, sign |
| `farmhouse` | Long and low; stone, timber or planks; hip or gable roof, thatch or tiles; lean-to, woodpile, barn doors |
| `tower` | Round (cone roof) or square (pyramid roof), 2–3 storeys; a lean-to or a small wing; weathervane |

## Flat-roofed families (the desert oasis)

A family with `"form": "flat"` is built from flat-roofed blocks instead (see [BIOMES.md](BIOMES.md)); the desert's
four families use it. The same stages, streams and parts contract apply, with these shapes:

- **Walls:** rounded plaster (`adobe`), sandstone (`stone`) or a sandstone ground floor under plaster (`mixed`), on a
  sandstone plinth band.
- **Parapet:** round every roof, `plain`, `stepped` (raised corners and a raised middle over the door) or `crenel`
  (merlons, the tower's), with beam ends (vigas) under it on plaster walls.
- **Annex:** a lower `wing`; a `terrace` (a wing with an outside stair up to its roof, the parapet open where the
  stair arrives); or a walled `court` in front with a gateway on the door's line (the lot's walk starts at the gate).
- **Crown:** a `loft` (a roof room set back on the roof, with its own door), a `dome` on a drum with a finial, or the
  `lookout` shelter scaled to the tower's deck.
- **Details:** a chimney `stack`, awnings (a door awning or a shop's broad awning on poles), lamps, banners, the inn's
  sign, sill pots, latticed bays, balconies and yard props.

Blocks carry `z0`, so a roof room stands on its house, and a wall is covered by a neighbour only where the neighbour
stands at that height (a wing covers the ground floor of the wall it meets, not the floor above). The plan adds
`form`, `court`, `stair` and `dome`; the colliders are one box per ground block (the main block's as tall as the
house), the stair, and the courtyard walls either side of the gateway. The rules add a `flat` kit (parapet heights,
corner radius, wall thickness, courtyard, stair and dome sizes, the roof room's door). The meadow's own parts
(ridge caps, spire, bay window) are required only when a pitched family can reach them.

## Snow roofs, log walls and belfries (the snow village)

The snow village's four families are pitched houses on the same grammar (see [BIOMES.md](BIOMES.md)). Three generic
additions carry them, and any family may use them:

- **`covering: "snow"`**: no tiles or thatch. Each roof slope keeps its slab, and a soft snow blanket lies on it, held
  back 14 cm from a gable's verges so the roof colour still shows as a band. A cushioned lip in a few lengths of
  different thickness runs along the eave and hangs a little past it. Ridges and hips take the `roof.ridge.snow`
  bolster, a cone roof a snow cap, and the chimney crown a snow cushion with the flue opening on top. Snow is its own
  colour slot, `Snow` (`colors.snow`).
- **`walls: "log"`**: round log courses (a hexagonal section, the `Log` slot) over a dark chinked wall, split round the
  openings. Every other course runs past an open corner, the long walls' on the even courses and the gable walls' on
  the odd ones, so the log ends interlock. The openings stand 14 cm proud of the wall so they sit on the courses.
- **`walls: "belfry"`**: masonry up to the top storey, which is left open. A plank deck stands proud of the masonry,
  and above it are corner posts, a waist-high rail over crossed braces, and a `bell.hang` part under the roof. No
  openings are cut into the open storey; an `upper` banner part (`banner.*`) hangs on the front of the top walled storey.

## Geometry: code-built massing, Blender detail parts

- **Code-built massing.** The walls, plinth stones, timber frame, gables, roof slabs, tiles or thatch rolls, ridge
  line and chimney are built by the grammar as **bevelled convex prisms** and **lathes**. That is the cottage's own
  recipe (`hero_corner.py`), so any proportion keeps crisp bevels and no seams show under the outlines.
- **Blender detail parts.** Everything detailed is one of the 28 **socketed parts** in
  `assets/v2/arcade/arcade-house-parts.glb`: doors, windows, shutters, flower boxes, lanterns, canopies, signs,
  ridge caps, spires, toppers, chimney pots, dormers, the bay window, the balcony and yard props.
- **The plan.** `generateHouse(rules, {family, key, lot})` returns the plan: DNA, palette, style, blocks, facades
  (cells per bay), rings, attics, details, colliders and bounds.
- **The expansion.** `buildHouse(rules, plan)` expands the plan into `pieces` (prisms and lathes in Blender axes,
  each with its colour slot, outline width, bevel and gradient range) and `parts`. A part is either placed with its
  frame or hung on a placed part's socket.
- **Engine meshing.** `render/HouseAssembler.js` meshes the pieces, places the parts and merges each house into one
  mesh per material and outline width, typically 8 to 14 meshes.
  - The `lite` build (phones and the performance tier) drops shutters, flower boxes, signs and yard props, and
    skips the chamfers on thin pieces.

### Parity

- The grammar uses no trigonometry. Tower directions come from `DIRS64`, built with square roots and sums.
- Numbers leave through `floor(x + 0.5)` rounding, and each stage draws from its own stream in a fixed order.
- `tools/blender/v2/arcade/house_grammar.py` is a line-for-line Python port.
- `tools/test/fixtures/house-plans.json` holds 100 houses: full plans, plus a digest of every expanded piece and part.

## Files

| What | Where |
|---|---|
| Rules (data) | `packs/arcade/pack.json` → `houses`: kit sizes, lot, family mix, facade odds, part sizes, colours, families |
| Grammar | `src/world/houseGrammar.js`: `generateHouse`, `buildHouse`, `houseDigest`, `houseSlotColor`, `validateHouseRules` |
| Shared core | `src/world/grammarCore.js` (also used by `creatureGrammar.js`) |
| Assembler | `src/render/HouseAssembler.js`: pieces and parts → merged, toon-ready meshes |
| Parts library | `assets/v2/arcade/arcade-house-parts.glb`, built by `tools/blender/v2/arcade/house_parts.py` |
| Parts index | `src/world/houseParts.js`, generated with the GLB. The rules are validated against it |
| Blender preview | `tools/blender/v2/arcade/house_grammar.py` (the port) and `house_preview.py` (mesher, review sheet, cards) |
| Tests | `test-house-grammar` (parity, sweep, reachability) and `test-house-assembly` (meshing, sockets, mirroring, villages) |

## The parts contract

- **Nodes.** Each part is one top-level glTF node named by its id (`win.arched`). The engine reads the id from
  `userData.name`, because GLTFLoader strips the `.` from node names.
- **Origins.**
  - A wall part stands on the bottom centre of its opening, on the wall plane, and faces out of the wall (Blender
    -Y, glTF +Z).
  - Roof parts stand on their origin.
  - Ridge caps run along X and are 1.32 long; the grammar stretches them to fit a ridge or hip.
- **Sockets.** Sockets are child nodes with `extras.socket`:
  - `lamp`, `canopy` and `sign` on doors;
  - `shutter` (paired) and `sill` on windows.

  The paired socket exists on the right only. The left side is a mirrored, re-wound copy across the window's X axis.
- **Materials.** Materials are colour slots named `HSE_<Slot>`: Wall, Roof, Accent, Timber, TimberDark, Stone,
  StoneDark, Iron, Glass, Glow, Leaf, Petal and Gold. Each is authored white times the `Col` gradient, and the plan's
  palette fills it. A thatched house's `Roof` takes the straw colour.
- **Outlines.** `extras.arc_outline` is each part's outline width in metres. Houses are built at game scale.

## In the game

- The Arcade `house` prop (`generator: "house"`) is a dressing entry. The [village layout](WORLD.md) walks house
  lots along its lanes and the avenue's tree line and gives each one a plan:
  - the lot is the family's own size (`world.houses.lots`), so a farmhouse gets 14 × 13 m and a tower 10 × 10;
  - the key is the project seed and the lot's index, so the rest of the layout never shifts a house;
  - the front faces the lane, with a fence along it, a gap at the door and a stepping-stone walk to the lane.
- The house itself is visual (`collision: "none"`). Each block adds its own `collisionOnly` box, so an L-shaped house
  leaves its open corner walkable.
- A saved project that still names the retired `cottage` gets a generated house instead.
- Other themes' compilers still use the fixed dressing grid, where the default lot is 7.6 × 10 m.

## Adding a family or a part

1. **Author parts** in `house_parts.py` with `@hpart('<id>')`, their sockets and an `hfinish` outline width. Run
   `build_house_parts()` and `ship_house_parts()`; that writes the GLB and `src/world/houseParts.js`. Give an opening
   part its `w` and `h` in `houses.parts`.
2. **Add the family** to `houses.families`:
   - palettes;
   - `mass` ranges: span, length, storeys, pitch, bay and tile scale;
   - a `plan` whose built-in slots (`shape`, `ridge`, `walls`, `roof`, `covering`, `annex`, `chimney`) name
     built-in choices, and whose other slots name parts.

   Then add the family to `houses.mix`.
3. **Preview it.** In Blender, after the creature scripts, load `house_grammar.py`, `house_parts.py` and
   `house_preview.py` (same globals). Then run `sheet_houses()`, `review_houses()` and `cards_houses()`.
4. **Regenerate the fixtures** with
   `python3 tools/blender/v2/arcade/house_grammar.py packs/arcade/pack.json tools/test/fixtures/house-plans.json`.
5. **Run the tests.**
   - `test-house-grammar` fails if a rule names a missing part or socket, if an option is never chosen, if an annex
     is never built, if a house breaks a constraint, or if the Python port drifts.
   - `test-house-assembly` checks the meshing and the placement in a real village.
