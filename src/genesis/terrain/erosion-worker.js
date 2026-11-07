// The erosion simulation, behind a message boundary.
//
// The droplet loop itself lives in engine/terrain/erosion.js so that it can be
// called directly — by a test, or by a page that wants the editor's exact
// ground without spinning up a worker (the landing page's hero does). What is
// left here is the part that is genuinely about being a worker: taking the
// buffer, running the pass, and transferring the result back.
//
// Deterministic: seeded from the world seed, so the same world always erodes
// the same way — in the editor, in VSight, and in the Unity export.

import { erodeWithDelta } from "../../kernel/terrain/erosion.js";

/* The simulation is the only thing in the engine that knows which ground was
   STRIPPED and which was BURIED, and it used to throw that away: it returned
   the reshaped heights and nothing else, so the renderer downstream had only
   the final surface to look at — and a flat shelf of laid silt and a flat
   shelf of scoured bedrock look identical from there.

   The net delta is the answer, and it costs one copy of the field (2 MB at
   513²) and one subtraction pass. engine/terrain/masks.js turns it into the
   deposition and wetness masks the terrain shader weights its layers by. */
self.onmessage = (e) => {
  const { buffer, res, size, erosion, seed } = e.data;
  const src = new Float32Array(buffer);
  const { data, delta } = erodeWithDelta(src, res, size / (res - 1), erosion, seed);
  self.postMessage({ buffer: data.buffer, delta: delta.buffer, res, size },
    [data.buffer, delta.buffer]);
};
