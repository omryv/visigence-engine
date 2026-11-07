# The studio: Play, Remix and Build

The studio is the game engine's side of the one editor: its mission graph and level editor are the editor's
**Mission** and **Level** views, run inside the editor (`index.html`, at `/`) on the editor's own mission, and its game
runtime is what the editor's **Play** runs and what an exported game is (see the README, "The editor"). Its page is
`game.html`. It is a visual creation engine for 3D arcade games:
a first-person shooter, first-person exploration, a third-person action adventure, a top-down arena shooter and a 3D
collect-a-thon ([GENRES.md](GENRES.md)). The Arcade pack provides its asset pools (its enemies are generated critters
that fight in melee, and its models are drawn toon-shaded with outlines). A seed, connected pools and mission sequence
compile into a playable level using the same 60 Hz simulation as the engine tests. Generation and enemy behavior use
ordinary deterministic code; no AI service is called.

It has three modes, all organised by the same five genres: **Play** (the launcher: a ready mission per genre and
world, titled by its genre with the world beneath), **Remix** (the node graph below)
and **Build**, the 3D level editor ([EDITOR.md](EDITOR.md)): games of several levels, built by hand on top of the
seeded village, with live checks, instant playtests, a template game per genre, and an export with portal hooks for ad
breaks and a rewarded continue.

## Deep links

A link opens `game.html` on the thing it names, through these query parameters (the editor at `/` sends these old
addresses there). With none of them (and no shared `?mission=`), the page opens its launcher. Inside the editor the
page is opened with `?embed=world` instead (`src/world/editorMission.js`): `&workspace=remix|build` for the Mission and
Level views, none for Play. The studio reads them once on arrival and removes them from the address bar,
so a reload does not repeat them; anything else in the query (`?debug=1`) stays.

| Link | Opens |
| --- | --- |
| `?genre=shooter\|exploration\|action\|arena\|collect` | Play, with that genre chosen in the launcher |
| `?world=arcade\|desert\|snow` | Play, with that world chosen (combine with `&genre=`) |
| `?mode=remix` | Remix, the node graph |
| `?mode=build` | Build, on the level editor's start screen |
| `?mode=build&template=<id>` | Build, on a new copy of a genre's template: `hive-patrol` (shooter), `lantern-survey` (exploration), `trail-warden` (action), `honey-siege` (arena), `honey-harvest` (collect) |
| `?mode=build&game=<id>` | Build, on a game saved in this browser, without copying it |
| `?mode=build&new=<genre>` | Build, on a new blank game of that genre |
| `?vision=<text>` | The vision canvas ([VISION.md](VISION.md)); it wins over `mode` |
| `?mission=<code>` | A shared mission, as before; it wins over `genre` and `world` |

An unknown template, game or genre falls back to the plain mode, never to an error.

## Authoring a game

1. New projects start with an empty board. Choose a category, then add a World generator
   and Playable output from the Node type menu. Add pools and objectives one at a time.
   Nothing is connected automatically. Select world options, weapons, enemies, doors and
   props from the library. Check several assets to give the generator a pool of options.
2. Connect each pool's output to the matching World generator input. Multiple pools can
   feed an input; their selections are combined. Disconnected pools are excluded.
3. Add objectives and connect the generator's start port through their start/complete
   ports to the playable output's mission input. The generator's game output also
   connects to that output. Click a wire to disconnect it; drag headers to arrange nodes.
   Focus graph enlarges the board. Fit view brings all nodes into view.
4. Configure the generator's layout, density, enemy population, behavior, difficulty,
   starting weapon, player character, lighting and quality. Generate new variation
   changes the seed. Keeping the same graph and seed reproduces the same world.
5. Editing, connections, undo/redo and imports update the draft only. Click Generate /
   Compile when the graph is complete to load its assets and see the output. No renderer
   is initialized for a new draft. Closing play pauses rendering; pending changes require
   another explicit Generate. Title changes and moving nodes do not invalidate the game.
   Generate / Compile enters the game. Start mission enables input and audio.
6. Configure Playable game to download a playable ZIP or save project JSON. Serve the
   extracted ZIP over HTTP or deploy its root to static hosting. ES modules cannot run
   correctly from a file:// URL.
7. **Build level** (in Remix's toolbar) opens this mission in the level editor as a new game: place, move and wire
   things in the 3D view, add levels, and export the whole game. From a level in the editor, **Edit the mission
   graph** opens Remix on that level and **Back to level editor** returns.

Connections have types. Cycles, incompatible assets, incomplete mission chains and
missing required pools produce visible validation messages. Compilation does not
silently substitute an earlier game. Loading reports progress, yields between models
and permits one explicit build at a time. Edits during a build remain pending. Browser-local
saves, undo/redo and versioned JSON import/export preserve the graph. Older project JSON receives a compatible default graph.

## Objectives and controls

Mission steps support activate controls, override doors, survive waves, eliminate
hostiles, defeat a heavy enemy, clear barricades, reach checkpoint, collect honey (the
collect-a-thon and the action adventure), survive for a time (the arena) and extract. They
execute in connection order. Extraction must be last. Controls need a control prop;
door overrides need doors; barricades need barricade props; combat needs an enemy pool;
a heavy encounter needs a heavy/heavy in that pool. Interaction objectives are limited
to twelve placed targets. Door completion changes collision; barricades respond to
weapon damage and interaction. Supplies restore health, ammunition and grenades once
per run. Restart restores the complete mission, supplies and blockers.

WASD move, mouse aim, click fire, right click aim, R reload, E hold to interact, Shift
sprint, 1–9 select weapons, G grenade, Esc pause. Each genre has its own controls, touch
layout and gamepad mapping ([GENRES.md](GENRES.md#controls)); the play card shows them.
Touch screens receive a move pad and the genre's buttons (fire, aim, use, reload,
weapon-cycle and grenade for the shooter; jump and strike for the third-person genres; a
right-hand aim pad for the arena). Each selected weapon keeps its own
ammunition and reload state. The exported game starts from its embedded project and
never loads the author's browser-local studio save. A game of levels plays through: a title
card, each level in turn, the ending ([EDITOR.md](EDITOR.md#publishing)).

## Content and rendering

| Category | World pools | Weapons | Enemies | Doors | Props |
| --- | ---: | ---: | ---: | ---: | ---: |
| Arcade | 1 | 5 | 10 | 1 | 12 |

The world option is the meadow: a seeded village of generated houses, trees, landmarks, paths and
water laid out around the mission's pads ([WORLD.md](WORLD.md), [HOUSES.md](HOUSES.md),
[TREES.md](TREES.md), [LANDMARKS.md](LANDMARKS.md), [TERRAIN.md](TERRAIN.md)). Exports include
connected selections and their companions, rather than every model in the pack.

The five weapons, the hero and its first-person arms ([FP_ARMS.md](FP_ARMS.md)), the pickups
and the props are authored in Blender by the kit under `tools/blender/v2/arcade/`. Enemies are
generated critters ([CREATURES.md](CREATURES.md)) animated as rigid bodies. Idle, locomotion,
attacks, recoil, reload and death presentation follow simulation state. Each time of day has
an authored look (sky, sun, fog, grade) in `src/config/looks.js`, and every light is an emitter
shown through a fixed light pool. Texture resolution and postprocessing follow the quality
setting; unused model resources are released between builds.

## Provenance and rebuilding art

Every Arcade asset is original Blender geometry from `tools/blender/v2/arcade/`; see
[R2-ARCADE-UPLOAD.md](../R2-ARCADE-UPLOAD.md) for the upload inventory. Rebuild the catalogue
after changing GLBs (`node tools/build/build-catalog.mjs`): content hashes invalidate the
browser asset cache.

## Validation and release

`node tools/test/run.mjs` runs every offline suite, including all eight mission objectives, inventory switching, restart, connected export filtering, deterministic
assembly, navigation across world/layout/seed combinations, and Blender rig/texture
contracts. ZIPs are independently checked with Python's ZIP reader. Import verification:
`node tools/check-imports.mjs`. Deployable build: `node tools/build/build-preview.mjs`.
`vercel.json` serves that build's studio root; deployment is left to the repository owner.

`node tools/test/shoot-studio.mjs` draws the reference shots of every theme in headless
Chromium and fails on a page error or a blank frame; `tools/test/probe-render.mjs`
bisects the render modules without assets. Browser interaction checks supplement simulation tests. Physical iPhone/iPad
GPU, memory and touch QA remain necessary before a mobile release. This repository
produces web games; native iOS packaging, signing and App Store submission are separate.
Multiplayer, campaign progression, physics ragdolls and destructible buildings are not
implemented. A commercial release also requires representative hardware profiling and
art review; a passing simulation suite is not evidence of AAA visual quality.
