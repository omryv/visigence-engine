// Sky-visibility bake, off the main thread.
//
// The bake is res² × AZIMUTHS × RAY_STEPS height samples — at 257² that is
// about twelve million, which is a visible hitch on the main thread and
// nothing at all in a worker. Same pattern as the erosion worker: the world
// is handed over as a baked heightfield, the answer comes back as a
// transferable buffer, and the whole thing is a pure function of the seed.

import { createBakedSampler } from "../../kernel/terrain/heightfield.js";
import { bakeSkyVisibility, packSkyVisibility } from "../../kernel/terrain/skyvis.js";

self.onmessage = (ev) => {
  const { buffer, fieldRes, size, res } = ev.data;
  const sampler = createBakedSampler({ res: fieldRes, size, data: new Float32Array(buffer) });
  const baked = bakeSkyVisibility({ sampler, size, res });
  const rgba = packSkyVisibility(baked);
  self.postMessage({ rgba: rgba.buffer, res }, [rgba.buffer]);
};
