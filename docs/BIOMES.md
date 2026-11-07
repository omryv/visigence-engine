# Biomes: more than one village per theme

A theme can grow more than one kind of village. Arcade has three: its meadow (the theme's own world), the **desert
oasis** and the **snow village**. Each is an **environment**: a world option in the studio's **Environments** category
(`CATALOG.arcade.world`, written by `tools/build/build-catalog.mjs`), with its own card picture
(`arcade-lookdev-review.png`, `arcade-desert-review.png`, `arcade-snow-review.png`). The launcher's Mission select shows
each as its own world card (`MISSION_WORLDS` in `src/world/missionCard.js`), and the studio's Props library shows every
biome's own version of a prop next to the meadow's (`CATALOG.arcade.biomes`). The project's world pool decides: connect
the Desert oasis and the level is a desert;
connect both and the seed picks one per level, as it does for any world pool. A world option's `biome` names the
biome of the pack it grows from; new projects start with the meadow, so every saved project keeps the village it had.

A biome is not a palette swap. It brings its own houses, trees, flora, landmarks, ground, water and light, and it
runs on the same generators: the house grammar, the tree grammar, the village layout, the terrain and the landmark
grammar. No AI and no network are involved, and the same seed always gives the same village.

## How a biome is defined

`packs/<theme>/pack.json` → `biomes.<id>` is an **overlay** on the pack's own manifest (`applyBiome` in
`src/world/pack.js`, twinned in `house_grammar.py` for the Python ports):

- objects merge key by key, arrays and plain values replace, and `null` deletes a key (the desert deletes the
  windmill, the watermill, the orchard, the farm and the brook);
- a key listed in the overlay's `replace` is taken whole (the desert's `houses` and `trees` are complete rule sets);
- `props` patches prop entries by id (the desert's cover rocks, low wall and barricade have their own models, at the
  same size as the meadow's, so every placement and collision stays as it was).

`resolvePack(manifest, measured, biome)` resolves the pack for a biome, and `biomePack(pack, biome)` re-resolves a
resolved pack for another biome. `compileShooterProject` resolves it for the world option it picked and returns it as
`level.pack`, which the session loads and draws from, so a test, the studio and the game always see the same rules.
Each rules block is validated against the parts index of its own library (`PARTS_INDEX` in `pack.js`).

The look follows the biome too: `BIOME_LOOKS` in `src/config/looks.js` (`lookFor(project, biome)`) changes the sky,
the bounce light, the haze and the toon's sun and shade tints per lighting preset. The toon shading, the outlines and
the terminator stay the theme's.

## The desert oasis

| Part | What it is |
|---|---|
| Houses | Four flat-roofed families (see [HOUSES.md](HOUSES.md)): the **courtyard home**, the **merchant house** (a dome, a shop awning, a latticed bay or a balcony), the **workshop / inn** (a chimney stack, the inn's sign, a wide awning) and the **lookout tower** (crenellations, a banner, a rooftop shelter). Same storey, plinth, door and window sizes as the meadow's houses |
| Trees | Two tree-grammar species: the **palm** (a curving, ringed trunk and a frond crown; `bark: "rings"`) and the **saguaro** (arms that reach out and turn up, flowering caps; `bark: "ribs"`) |
| Flora | Barrel cactus, prickly pear, a young column cactus, agave, dry shrubs, dry tufts, oasis reeds and small sandstone stones |
| Landmarks | The **oasis well** with its teal canopy, **market stalls** with striped awnings round the square, the sandstone **lookout** on a rim hill |
| Ground | Sand with wind ripples (`world.ground`), flagstone lanes painted into the ground overlay (`world.overlay.flag`), gentler dunes, one **oasis pond** with reeds and palms, no brook |
| Props | Sandstone cover rocks, a low plaster wall for the fence, a crate-sack-jar barricade |

Everything the desert adds is in one library, `assets/v2/arcade/arcade-desert-parts.glb` (its index is
`src/world/desertParts.js`, written by the Blender ship), plus the three prop models
`arcade-desert-{rocks,wall,barricade}.glb` and the catalog cards `catalog/desert-*.png`.

## The snow village

A cozy alpine settlement: timber and stone under thick, rounded snow that visibly rests on what holds it, doors and
windows kept clear and lit warm.

| Part | What it is |
|---|---|
| Houses | Four pitched families on the meadow's grammar (see [HOUSES.md](HOUSES.md)), every roof under the **snow covering**: the **log cabin** (round log courses whose ends interlock at the corners, a steep front gable, a porch canopy), the **lodge** (a stone ground floor under a timber-framed upper storey, a balcony or bay, dormers), the **workshop** (plank or stone walls, barn doors, an open woodshed lean-to, the hammer-and-saw sign) and the **watchtower** (a stone shaft, an open **belfry** storey with a railing and a bell, a banner) |
| Trees | Two tree-grammar species: the **snowy conifer** (the meadow conifer's tiers, each carrying its own snow shell with drooping tongues) and the **bare tree** (a gnarled, branching crown whose twig ends hold small cushions of snow) |
| Flora | Low snowbanks, snowy slate rocks and stones, a half-buried evergreen bush, grass through snow, fallen logs and stumps, firewood stacks under little roofs, sleds, barrels, lantern posts, frozen cattails at the pond |
| Landmarks | The **bell tower** with its clock and banners on the lot nearest the square (its house gives way), the roofed **well** and **winter stalls** round the square |
| Ground | Cool blue-white snow with soft wind-swept strokes, grey stepping stones along the lanes, a higher relief, one **frozen pond** walked on as ground (`terrain.ponds.frozen`: level ground just under the ice, no water depth), no brook |
| Props | Snow-capped cover rocks, a split-rail fence under snow, a sled-firewood-crate barricade, a barrel with a snow lid |

Snow is its own colour slot (`HSE_Snow`, `TRE_Snow`, `ARC_Snow`), cool-shaded by the toon (`TOON_MATERIALS.Snow`). The
grammar additions are generic: the `snow` covering (a blanket per slope held back from the verges so the roof's
edge still shows, a cushioned eave lip in a few lengths, snow bolsters on ridges and hips, a cap on the chimney and on
cone roofs), `log` walls and `belfry` walls (see HOUSES.md), and the `belltower` landmark kind.

Everything the snow village adds is in one library, `assets/v2/arcade/arcade-snow-parts.glb` (index
`src/world/snowParts.js`), plus `arcade-snow-{rocks,fence,barricade,barrel}.glb`, the cards `catalog/snow-*.png` and the
Environments picture `arcade-snow-review.png`.

## Files

| What | Where |
|---|---|
| Overlay and resolution | `packs/arcade/pack.json` → `biomes.desert`, `biomes.snow`; `src/world/pack.js` (`applyBiome`, `biomePack`) |
| Environment | `CATALOG.arcade.world` (`src/world/catalog.js`, from `tools/build/build-catalog.mjs`): the world option and its `biome`; `compileShooterProject` returns `level.pack` |
| Look | `src/config/looks.js` (`BIOME_LOOKS`) |
| Ground | `src/render/CombatEnvironment.js` (`lawnTexture`'s biome palette, the overlay's flagstones) |
| Blender | `tools/blender/v2/arcade/desert_parts.py` (every desert part, the props, the ship) and `desert_preview.py` (streets of generated houses, eye-level renders at the game's camera, the catalog cards); `snow_parts.py` and `snow_preview.py` the same for the snow village (plus `snow_vignette`, the Environments picture) |
| Studio and launcher | `editor/studio.js` (the Props library's biome cards from `CATALOG.arcade.biomes`), `src/world/missionCard.js` (`MISSION_WORLDS`, `missionWorld`, `worldMission`) and `editor/playerFront.js` (one world card per environment) |
| Fixtures | `tools/test/fixtures/{house-plans,tree-plans,world-layouts}-{desert,snow}.json`, written by the Python ports with a third argument: `python3 tools/blender/v2/arcade/house_grammar.py packs/arcade/pack.json tools/test/fixtures/house-plans-desert.json desert` |
| Tests | the desert and snow sections of `test-house-grammar`, `test-tree-grammar` and `test-world-placement` |

## Adding a biome

1. Author its parts in Blender (a `*_parts.py` with its own library GLB and index), and register the index in
   `PARTS_INDEX` (`src/world/pack.js`).
2. Write `biomes.<id>` in the pack: the rules blocks it replaces or patches, its props, its lots and classes.
3. Add a world option with its `biome` and card picture in `tools/build/build-catalog.mjs` (and `catalog.js`), its
   launcher card in `MISSION_WORLDS` and, if it needs its own light, an entry in `BIOME_LOOKS`.
4. Write its fixtures with the Python ports and add its checks to the tests.
