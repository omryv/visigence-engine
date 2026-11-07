# three.js in this repository

Vendored from the `three` npm package, revision **r185.1** (`package.json` declares `^0.185.1`;
`node tools/three/check.mjs` holds the two together and runs under `npm run check`).
The files under `build/` and `examples/jsm/` are byte-for-byte upstream. Nothing in this
directory is edited by hand: `node tools/three/vendor.mjs` is the only way it changes, and
`node tools/three/locate.mjs <line>:<column>` reads a position in a bundle.

## Deviations from upstream behaviour

Every place the engine works around, or switches off, something in this revision. Each is
applied at runtime from engine code, never by editing the bundle, so an upgrade is a diff
of this list against the new release notes rather than a re-application of patches.

| Where | What | Why | Remove when |
| --- | --- | --- | --- |
| `src/core/Renderer.js` `installWebGPUSwizzleShim` | Clears the string `swizzle` three sets on every `GPUTextureViewDescriptor`. | The spec types it as a dictionary; a browser implementing `texture-component-swizzle` (Chromium 141+) rejects the string and the first render throws. | three omits `swizzle` unless the feature is requested. |
| `src/core/Renderer.js` `createRenderer` | Passes only `antialias`, never `samples`. | `samples: N` collapses to 4 for any truthy value and `renderer.samples` has no setter. | three accepts a sample count. |
| `src/core/Renderer.js` `suppressDeadDeviceRejections` | Swallows `popErrorScope` rejections for a bounded window around a WebGPU device loss. | three calls `device.popErrorScope().then(...)` with no `.catch()`; a device lost during boot reports as an uncaught error even though the loss was handled by falling back. | three catches its own error-scope promises. |
| `src/core/Renderer.js` `webkitBootsOnWebGL` | WebKit browsers start on WebGL2 even when they offer WebGPU. | Safari's and iOS's WebGPU have not been driven through the game since the bloom fault was found; WebGL2 through ANGLE is the path seen working on a Mac. | WebGPU has been seen running the mission on Safari and on an iPhone. |
| `src/game/ShooterSession.js` `resize` / `src/core/Renderer.js` `viewportSize` | A collapsed (0x0) viewport is never drawn into; the session keeps its last real size. | `TRAANode` starts its history target at 1x1 as its "never sized" sentinel, so a first frame on a 1x1 canvas (the launcher builds while the studio preview is hidden) never initialises the history and the depth copy throws `backend.get(undefined)` ("WeakMap keys must be objects", first seen on macOS Safari, reproduced on Chromium through the launcher). | three initialises the history target on first use regardless of size. |
| `src/render/PostFX.js` | SSR is built only on the WebGPU backend. | `SSRNode` does not compile on the WebGL2 backend (`trunc(float).max(int(1))` has no GLSL overload) and its stochastic variant draws nothing there. | SSRNode compiles and draws on WebGL2. |
| `src/render/PostFX.js` | The world pass is not multisampled when TRAA is on. | WebGPU forbids copying MSAA depth into the single-sample depth texture the depth-reading passes need. | Not a bug; a design constraint. Listed so nobody re-enables both. |

## Upgrading

1. `npm pack three@<version>` somewhere outside the repository and extract it.
2. Bump `peerDependencies.three` in `package.json`.
3. `node tools/three/vendor.mjs --from <that package> --allow-version-change --readable`
4. `npm run check`, then `node tools/test/run.mjs`, then the render probes
   (`node tools/test/probe-render.mjs --set quality=quality sky fog street rig shadow post`,
   with and without `--webgpu`) and `node tools/test/shoot-studio.mjs` with the asset cache.
5. Re-read every row above against the release notes; delete the rows that no longer apply
   and their engine code with them.
6. Do not commit the readable builds; they are for local debugging and `.gitignore` refuses
   them.
