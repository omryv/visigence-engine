# Visigence Engine

One tool, one engine. **Every seed is a world**: the Genesis Kernel grows a 4 km world from a seed, and everything
here stands on that world. You see it whole, play a mission on a site of it, remix the mission, build your own
levels on it, and put yourself in it from a photograph. One page, one renderer (three.js `WebGPURenderer`, WebGPU
first and WebGL2 only where the browser has no WebGPU), one kernel, one repository.

This repository replaces four: `omryv/Visigenesis` (the kernel and its world engine), `omryv/3dgen` (Visigames, the
game engine this is built on), `omryv/3d` (atlas-core, the photograph reconstruction) and `omryv/2dgen` (the 2D
builder, **not yet brought**: see below). Those are archived. Nothing here imports anything outside this repository.

## The modes

| Mode | What it does | Where |
|---|---|---|
| **World** | The seed's whole world: the kernel's canonical ground (513², eroded by droplets, flooded from the sea, drained), drawn on the engine's renderer, with the sites a level can stand on marked. Change the seed and a new world grows. **Play here** opens a mission on it. The page opens here. | `editor/worldMode.js`, `src/world/worldMap.js`, `src/world/worldWorker.js`, `src/render/WorldView.js` |
| **Play** | A ready mission in one of five genres (shooter, exploration, action adventure, arena, collect-a-thon), standing on a 640 m site of the seed's world, played at 1:8. | `editor/playerFront.js`, `src/game/`, [docs/GENRES.md](docs/GENRES.md) |
| **Remix** | The mission as a node graph: pools, steps, rules. | `editor/studio.js`, [docs/STUDIO.md](docs/STUDIO.md) |
| **Build** | The 3D level editor: games of several levels, live checks, playtests, export with portal hooks. | `editor/build/`, [docs/EDITOR.md](docs/EDITOR.md) |
| *See yourself* | A photograph becomes a figure on this device and a prop in a level (inside Play's prop importer, for now). | `src/atlas/`, below |

The seed is one seed for the whole tool: the one World shows is the one Play's missions stand on. Only one GPU
context is held at a time: World makes its renderer when it is shown and disposes it when it is left, and Play's
session is let go (a mission still being prepared is cancelled) when World is entered.

## What is not in yet

Said plainly, because this is phase 1 of putting four repositories into one engine:

- **2D** (`omryv/2dgen`: platformers, adventures, arena shooters, mazes and block puzzles on a grid, its solver and
  generator, its iOS shell) is not here. It is the next mode to bring, onto this page and this seed.
- **Me** (atlas-core's own page: the full reconstruction with its certificate, multi-view, the rig) is not here as a
  mode. The reconstruction itself is (`src/atlas/`, with all eleven of its suites), and *See yourself* uses it.
- **The world document and its tools** from Visigenesis: the `.world.json` file, the signed certificate, the
  `genesis` CLI and its MCP server, the JSON schemas. The kernel's own records are here (`src/kernel/core/claims.js`,
  `ground.js`'s manifest); the file format and the tools around it are not.
- **Towns and roads.** Visigenesis composed named worlds (Farshore, Lonepalm) with settlements, roads and footings
  (`js/landform.js`, `compose.js`, `roadnet.js` there). World mode shows the ground, the sea and the drainage, not
  towns. Play's villages are the game's own, laid on the world's ground.
- **Editing the world.** The kernel can sculpt (`src/kernel/terrain/sculpt.js`) and meet statements about the ground
  (`condition.js`); World mode only shows.
- **Four kernel suites** (ground, condition, overworld, ports) test the kernel through the world document and the
  town builder above, so they wait for those. Their modules are here and covered by the other kernel suites.
- **The WebGL renderer** Visigenesis drew with is not brought, on purpose: one renderer.

## Run it

```sh
python3 tools/test/serve.py 8099      # then open http://localhost:8099/
node tools/build/build-preview.mjs    # the deployable site, in dist/
```

Serve the repository root with anything that serves files (`serve.py` adds no-store caching); there is no install
and no build step to run it, because three.js is vendored (`vendor/three/`) and every import is a relative file. The
game's art is on R2 (`src/config/assetDelivery.js`); see [Assets and R2](#assets-and-r2).

**Deploying.** Import this repository into Vercel with the repository root as the Root Directory. `vercel.json`
skips installation, builds with `node tools/build/build-preview.mjs` and serves `dist/`: the tool at `/`.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The tool: one page, every mode |
| `editor/` | The page's modes and dialogs: World (`worldMode.js`, `world.css`), the Play launcher, Remix, Build (`build/`), import, export |
| `src/` | The engine: game, simulation, rendering (`render/`, one `WebGPURenderer` set up in `core/Renderer.js`), worlds and levels (`world/`), genres |
| `src/kernel/` | The Genesis Kernel: seed, terrain, intent, erosion, flood, reach, claims. Pure: no three, no DOM, no clock, no randomness of its own, imports nothing outside itself |
| `src/atlas/` | The single-image reconstruction (from atlas-core), with its browser half in `src/atlas/web/`. Pure in the same sense; reached only by the import dialog |
| `packs/`, `specs/` | The Arcade content pack and level build specs |
| `vendor/three/` | three.js r185, vendored, with its patches listed in `vendor/three/PATCHES.md` |
| `tools/` | Checks, tests (`tools/test/`, with `kernel/` and `atlas/`), builds, the kernel's vector writers and Python port (`tools/kernel/`), the Blender kit |

## Checking it

There is no CI, on purpose. `sh check.sh` is the gate; run it before you push.

```sh
sh check.sh                        # = node tools/test/run.mjs: the import and three checks, then every offline suite
node tools/test/run.mjs kernel     # only the suites whose name contains "kernel"
node tools/test/e2e-world.mjs      # World in headless Chromium: the kernel's world, drawn, handed to Play and back
node tools/test/e2e-world.mjs --webgpu   # the same on WebGPU (see the harness for what this adapter cannot show)
node tools/test/e2e-world.mjs --dist     # against the deployable build
node tools/test/e2e-genres.mjs     # one mission per genre in headless Chromium
node tools/test/e2e-see-yourself.mjs     # the photograph to a figure, through the studio's own dialog
```

`tools/test/run.mjs` runs, in order: `tools/check-imports.mjs` (every import resolves inside the repository, as a
file and as a URL alike; only three.js is external; the kernel and the reconstruction import nothing outside
themselves) and the vendored-three check; the kernel's suites (`tools/test/kernel/`, including its boundary: no DOM,
storage, network, clock or `Math.random` inside it, and a manifest that is exactly its files); the engine's suites;
and the reconstruction's eleven suites (`tools/test/atlas/`, the slow part: about four minutes). Eight suites read the
game's art and skip, loudly, until the R2 cache exists (`npm run assets:fetch`; `--require-assets` makes a skip a
failure).

The browser harnesses need Chromium (pre-installed where this was written) and are not in the runner. In headless
Chromium the WebGPU adapter is SwiftShader's, which can neither show nor return a WebGPU frame, so
`e2e-world.mjs` checks pixels on the renderer's WebGL2 backend, the same TSL scene compiled to GLSL, and says so.

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
