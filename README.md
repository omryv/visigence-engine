# Visigence Engine

One tool, one engine. **Every seed is a world**: the Genesis Kernel grows a world from a seed, the world engine
lets you shape it (towns, woods, sculpting, rivers, props, weather, walking and flying), and
the game engine plays missions on it, a level cut from the very ground you made. One repository, one kernel, one
renderer: three.js `WebGPURenderer` (WebGPU, with WebGL2 only where a browser has no WebGPU), and every shader is a
TSL node graph that compiles to WGSL and, for that fallback, to GLSL.

This repository replaces four: `omryv/Visigenesis` (the kernel and its world engine and editor), `omryv/3dgen`
(Visigames, the game engine), `omryv/3d` (atlas-core, the photograph reconstruction) and `omryv/2dgen` (the 2D
builder; its core is here, its mode is not yet: see below). Those are archived. Nothing here imports anything outside
this repository.

## The modes

| Mode | What it does | Where |
|---|---|---|
| **World** (`/world`) | The world engine's editor. It opens on one seed's own world (`DEFAULT_SEED`, `src/kernel/seed.js`; `?seed=` names another), with its sky, sea, weather and time of day, and nothing else: no sample worlds. On it you place towns and props, plant the woods the seed grows, sculpt, carve rivers, paint grass; orbit, walk and fly; save the world file, its certificate and the exports. **Play here** plays a mission on this world. | `world.html`, `editor/world/`, `src/genesis/` |
| **Play** (`/`) | A ready mission in one of five genres (shooter, exploration, action adventure, arena, collect-a-thon). It stands on a 640 m site of the world, played at 1:8: the seed's own world, or the world World handed over. | `index.html`, `editor/playerFront.js`, `src/game/`, [docs/GENRES.md](docs/GENRES.md) |
| **Remix** | The mission as a node graph: pools, steps, rules. | `editor/studio.js`, [docs/STUDIO.md](docs/STUDIO.md) |
| **Build** | The 3D level editor: games of several levels, live checks, playtests, export with portal hooks. | `editor/build/`, [docs/EDITOR.md](docs/EDITOR.md) |
| *See yourself* | A photograph becomes a figure on this device and a prop in a level (inside Play's prop importer, for now). | `src/atlas/`, below |

**Play here.** The world editor stores nothing on the visitor's machine (no local storage, no cookies), so it hands
its world to Play in the link's fragment (`/?mode=play#world=…`, `src/world/worldLink.js`): the seed and the world's
terrain and water params, about 700 characters for a world with a town on it. Play opens in a new tab so the world
being made stays open. The mission's ground is then cut from that world (`src/world/kernelGround.js`
`worldParamsFor`): its terrain settings, its own intent statements together with the mission's, and the author's
sculpt strokes. The level
carries the world it was cut from (`ground.world.params`), so the world drawn past its rim is the same world.

## What is not in yet

Said plainly, because this replaces four repositories and not everything has arrived:

- **2D** (`omryv/2dgen`): its core (`src/play2d/core/`: the grid, the catalog, the solver, the generator) is here,
  because the world engine's 2D overworld projection uses it; the 2D builder's editor, runtime, templates and iOS
  shell are not, so there is no 2D mode yet.
- **Me** (atlas-core's own page: the full reconstruction with its certificate, multi-view, the rig) is not a mode yet.
  The reconstruction itself is here (`src/atlas/`, all eleven of its suites), and *See yourself* uses it.
- **visigenesis.com's front page** (the production blueprint with the live hero) stayed in the archived repository.
- **Seeing a WebGPU frame in this repository's own checks.** Headless Chromium's WebGPU adapter (SwiftShader) loses
  its device as soon as anything presents to a canvas, so the checks here prove the WebGPU programs another way:
  `tools/test/check-wgsl.mjs` has three generate the WGSL for every material in a live world and compiles each one,
  and the pixels are checked on the renderer's WebGL2 backend (the same node graphs, compiled to GLSL). On a real GPU
  WebGPU runs the programs proved valid; nothing in this sandbox could show one running.
- **The old editor's WebGL renderer** is not here, on purpose: the world engine's GLSL (terrain, sea, sky, air,
  grass, scatter, fire, weather, pins and markers) was rewritten as TSL, term for term, and runs on the one renderer.

## Run it

```sh
python3 tools/test/serve.py 8099      # then open http://localhost:8099/ (Play) or /world.html (World)
node tools/build/build-preview.mjs    # the deployable site, in dist/
```

Serve the repository root with anything that serves files; there is no install and no build step to run it, because
three.js is vendored (`vendor/three/`) and every import is a relative file. The game's art is on R2
(`src/config/assetDelivery.js`); see [Assets and R2](#assets-and-r2). The world engine needs no art: everything it
draws is generated.

**Deploying.** Import this repository into Vercel with the repository root as the Root Directory. `vercel.json` skips
installation, builds with `node tools/build/build-preview.mjs` and serves `dist/`: Play at `/`, World at `/world`.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `world.html` | The tool's pages: the studio (Play, Remix, Build) and World |
| `src/kernel/` | The Genesis Kernel: seed, terrain, intent, erosion, flood, reach, claims. Pure: no three, no DOM, no clock, no randomness of its own, imports nothing outside itself |
| `src/genesis/` | The world engine: `Engine.js` (one public API, on-demand rendering), terrain LOD, sea, rivers, sky, the air (`render/atmosphere.js`), props, grass, scatter, fire, weather, controllers; `render/nodes.js` is the TSL its shaders share |
| `src/genesis/world/` | World composition: towns (site plans), woods, footings, interiors, the world file, its certificate, the exporters |
| `src/` (the rest) | The game engine: game, simulation, rendering (`render/`, the one `WebGPURenderer` set up in `core/Renderer.js`), levels and their ground (`world/`), genres |
| `src/atlas/` | The single-image reconstruction (from atlas-core), with its browser half in `src/atlas/web/` |
| `src/play2d/core/` | The 2D builder's core (from 2dgen) |
| `editor/`, `editor/world/` | The studio's page code; the world editor's page code and CSS |
| `bin/`, `schema/` | The `genesis` CLI, its MCP server and verifier; the JSON schemas a world, its ground and its intent are held to |
| `packs/`, `specs/`, `vendor/three/` | The Arcade content pack; level build specs; three.js r185, vendored, patches in `vendor/three/PATCHES.md` |
| `tools/` | Checks, tests (`tools/test/`, with `kernel/`, `genesis/` and `atlas/`), builds, the kernel's vector writers and Python port, the Blender kit |

## Checking it

There is no CI, on purpose. `sh check.sh` is the gate; run it before you push.

```sh
sh check.sh                              # = node tools/test/run.mjs: the import and three checks, then every offline suite
node tools/test/run.mjs genesis          # only the suites whose name contains "genesis"
node tools/test/check-wgsl.mjs --town    # every program a built-on world draws, compiled as WGSL
node tools/test/e2e-world.mjs            # World plants woods and places a town, Play here plays a mission on it
node tools/test/e2e-genres.mjs           # one mission per genre in headless Chromium
node tools/test/e2e-see-yourself.mjs     # the photograph to a figure, through the studio's own dialog
```

`tools/test/run.mjs` runs, in order: `tools/check-imports.mjs` (every import resolves inside the repository, as a file
and as a URL alike; only three.js is external; the kernel and the reconstruction import nothing outside themselves)
and the vendored-three check; the kernel's suites (`tools/test/kernel/`, its boundary included: no DOM, storage,
network, clock or `Math.random` inside it, and a manifest that is exactly its files); the world engine's suites
(`tools/test/genesis/`: composition, the world file, certificates, exporters, the CLI and MCP server); the game
engine's suites; and the reconstruction's eleven (`tools/test/atlas/`, about four minutes). Eight suites read the
game's art and skip, loudly, until the R2 cache exists (`npm run assets:fetch`; `--require-assets` makes a skip a
failure). The browser harnesses need Chromium and are not in the runner.

**Known failing:** `node tools/test/e2e-genres.mjs --only exploration` fails its scripted walk (7 checks) in headless
Chromium, the same way in the archived repository before any of this work; the same mission's walk passes in Node
(the walker reaches the station in 181 ticks), so the fault is in how the harness drives the browser session, not in
the game. It is the next thing to fix.

## Standing on the world

A project says what its levels stand on: `ground: "world"` or `ground: "village"`. Every seed is a world, the 4 km
plate `src/kernel/presets.js` `makeParams({ seed })` describes and World mode draws, and with `"world"` an Arcade
level is cut from it (`src/world/kernelGround.js`):

1. **A site.** A fixed scan of the plate picks a 640 m square of dry, rolling ground with its rim over its core, and
   the level plays it at 1:8. Eight is the kernel's canonical lattice step, so every metre of the level's grid is a
   vertex of the world's own canonical grid.
2. **The mission, solved.** The mission's stations, its fight in the square and its way out become kernel intent
   (`missionIntent.js`), and the kernel bends the site the least improbable way that meets them. A site where that
   costs more than 150 nats, or misses, is passed over for the next.
3. **The village, on top.** The site's heights replace the village's own hills (`worldTerrain.js` step 1); the lanes,
   lots, pads, ponds and brook are laid on them exactly as before, in both the JS and the Blender Python port, which
   read the same heights.

A seed whose world has no such site (one that is mostly sea), or none the mission is cheap on, keeps the village's
own hills, and the level says so: `level.ground` is `{ kind, site, frame, heightHash, conditioning, ... }` on a
world and `{ kind: "village", asked: "world", reason }` when it fell back. Measured: 41 of 60 seeds have a site, a
ground costs 42 ms at the median, and a finished level's heights spread about as much as the village's own hills do.

A project that says nothing builds `"village"`, so every project saved before this keeps the world it had. A new
project, the launcher's mission cards and `Game.fromWorld(project, { pack })` stand on the world; the five template
games keep the village's hills their things were placed on. In the level builder, *This level → Ground* switches it
and says where the level stands, what the mission cost the kernel, and the par.

**The world around the level.** Past the meadow the rest of the world is still there, and the studio draws it:
`worldAround(level.ground)` (`kernelGround.js`) is the same conditioned sampler through the same map, and
`render/ArcadeGround.js` runs the ground's grid on out to 320 m past the rim on the world's heights (steps from 2 m
widening to 32 m) where the village's own hills end in a skirt. The rim's vertices are the level's own, so the seam
cannot open. Past it the ground takes the world's colours (the biome's lawn, darker on high ground, a beach at the
sea, bare rock where it is steep, snow on the highest peaks of a green world), and the world's sea lies at its own
level, out to the horizon, where the height fog takes it. A plate is a square whose rim sinks into the sea, so from
a village near its edge the coast runs straight. On K7QN-3F2A-9XBD the sea lies 19.8 m below the village floor, and
the far ground and sea cost 14k and 4k triangles (7k and 3k on phones and the performance tier).

`src/world/levelPar.js` times a compiled level's mission with the kernel's own walker (`src/kernel/core/terrain-reach.js`)
and this game's body: the walk speed, slope and wading depth the level was baked with. It sees the ground, not what
stands on it, so par is the walk over open ground. `tools/test/test-kernel-ground.mjs` holds the rest: the ground is
the conditioned world height for height, the pads stand at the floor and the corridors keep their grade, both walkers
reach every place a template mission stands at, and the real `PlayerController`, walked at the fixed step along the
nav grid's path, reaches its first objective inside its par band.

## See yourself (the first piece of Me)

The prop importer (*Import prop* in the launcher) has a second way in: **See yourself: make one from a photo**. A
photograph of one person, or one thing, becomes a figure on this device and walks through the same importer as any
GLB: preview, size (a person's 1.75 m to start), collision, credits, and the rights box the creator ticks. Nothing is
uploaded.

The figure is made by `src/atlas/`, the engine's single-image reconstruction, through its browser half
`src/atlas/web/figure.js` `photoToFigure`: the subject cropped from the frame, the textured mesh reconstructed in a
worker, cut by SmartMesh to what the evidence supports and at most 24,000 triangles, its atlas held to 2048 px, written
as a GLB with no skin. Only the import dialog reaches `src/atlas/`, and only when the button is pressed; the game's
runtime never imports it, and a downloaded game carries the figure as the GLB it became (the export leaves
`src/atlas/` out).

Measured on the test photograph (`tools/test/fixtures/photo-front.png`): 24,000 triangles and 3.5 MB, in 3.2 s in
Node and 13.5 s in headless Chromium on a CPU rasteriser. `tools/test/test-see-yourself.mjs` holds the boundary (only
the import dialog reaches the reconstruction) and the worker's protocol to what `figure.js` needs, and puts that figure
through the importer;
`node tools/test/shoot-studio.mjs --stand-ins --only arcade-world-figure` makes it in the browser and stands it in a
level on its world, and `node tools/test/e2e-see-yourself.mjs` clicks the whole way through the studio's own dialog:
*My assets*, *See yourself*, the photograph, the preview at 1.75 m, the rights box, *Add to mission*.

## The game engine's own provenance, and a warning about the upstream

The game engine (Visigames, from `omryv/3dgen`) was extracted from `omryv/maze-fever-appstore`, whose `Web/` is a
hash-locked staged copy of `omryv/maze`.

**The two upstreams have diverged, and for the files this engine carries, the staged copy is
the newer one.** The graphics overhaul — the `mobile` quality tier, the handheld ladder, the
native-shell device signals read from `window.__mazeDevice` — was done in the appstore repo's
payload and never back-ported. Four files here are ahead of `omryv/maze`:

`config/quality.js` · `core/DeviceProfile.js` · `render/SurfaceTextures.js` · `config/assets.js`

So do not refresh this engine from `omryv/maze` file-by-file; it would regress them. Upstream
was ahead on exactly two things, both reviewed: `render/PostFX.js`'s finding that WebGL2 ran
4x MSAA *and* the temporal resolve over it (ported here — it quadrupled the world pass's
bandwidth for edge quality TRAA then replaced), and a `core/Renderer.js` exposure change that
was **not** ported, because it is half of a two-number pair whose other half lives in the
maze renderer's `Lighting.js`, which this engine does not carry.

## Assets and R2

See [the asset directory guide](docs/ASSETS.md) for runtime files, editable sources, review media and R2 upload preparation. Run `node tools/build/prepare-r2.mjs` to stage only the files needed by the engine.

Runtime art is hosted on R2 and excluded from Git. Static builds need no asset download. Offline tests and Blender tools need the verified local cache (`npm run assets:fetch`). Source artwork and review media are preserved locally and in Git history; the entire `assets/` directory is ignored. Required metadata is tracked under `tools/assets/`, and reports under `docs/reports/`. See [R2 verification](docs/R2_DELIVERY.md).
