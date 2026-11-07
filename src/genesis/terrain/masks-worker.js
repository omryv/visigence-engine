// Terrain-mask bake, off the main thread.
//
// Same shape as skyvis-worker.js, and for the same reason: the world arrives
// as a baked heightfield, the answer leaves as a transferable buffer, and the
// whole thing is a pure function of the seed.
//
// The cost here is not the per-cell derivatives — it is that bakeTerrainMasks
// takes nine height samples per cell (the value, four for the gradient and
// Laplacian, four more at valley radius for AO), so a 257² grid is about
// 600k sampler calls, and the D8 flow pass then sorts every cell by height.
// Measured against this project's own sampler that is a few hundred
// milliseconds — a visible stall on the main thread, nothing in a worker.

import { createBakedSampler } from "../../kernel/terrain/heightfield.js";
import { bakeTerrainMasks, packTerrainMasks, packErosionMasks } from "../../kernel/terrain/masks.js";

self.onmessage = (ev) => {
  const { buffer, fieldRes, size, res, delta } = ev.data;
  const sampler = createBakedSampler({ res: fieldRes, size, data: new Float32Array(buffer) });
  /* The erosion pass's net height change, if this world ran one. It is on the
     EROSION grid, which the engine keeps at the same 513² this bake runs at
     and over the same corner-to-corner extent — so cell i is cell i and no
     resampling is needed. A mismatch is not an error worth failing the bake
     over, it just means the two masks stay neutral, so it is checked by
     length and dropped rather than thrown. */
  const deposition = delta ? new Float32Array(delta) : null;

  /* The grid spans the whole plate, corner to corner, so cell 0 is at -size/2
     and cell res-1 is at +size/2. The shader maps a world position back
     through exactly this relation, so the two must not drift: spacing is
     size/(res-1), NOT size/res, because the samples are on the fence posts
     rather than in the panels. Off by one panel and every mask reads shifted
     half a cell north-west of the ground it describes. */
  const half = size / 2;
  const spacing = size / (res - 1);

  const masks = bakeTerrainMasks({
    sampler,
    res,
    spacingMeters: spacing,
    sampleAt: (ix, iz) => [-half + ix * spacing, -half + iz * spacing],
    deposition: deposition && deposition.length === res * res ? deposition : null,
  });

  const rgba = packTerrainMasks(masks);
  const rg = packErosionMasks(masks);
  self.postMessage({ rgba: rgba.buffer, eros: rg.buffer, res }, [rgba.buffer, rg.buffer]);
};
