// Sky visibility: how much of the dome each patch of ground can actually see,
// and which way the unblocked half of the sky lies.
//
// This is the engine's indirect light. Without it the only ambient is a
// constant hemisphere fill plus the sky IBL, both of which arrive at every
// point in the world with equal strength — so a gorge floor is lit exactly as
// brightly as the ridge above it, and nothing looks like it is standing IN the
// terrain rather than on top of a photograph of it. Unity solves this with
// Lumen; a heightfield can solve most of it analytically and for free.
//
// The method is horizon mapping, the standard trick for terrain: from each
// cell, walk outward along a fixed set of compass directions and record the
// steepest skyline angle found. The unoccluded fraction of the hemisphere
// follows from those horizon angles, and the average of the unblocked
// directions gives a BENT NORMAL — the direction the light is actually
// arriving from, which is what makes a valley wall brighten toward the open
// side instead of just going uniformly dim.
//
// Pure JS, no three.js: it runs in a worker (the erosion pattern) and under
// the JavaScriptCore test suite. Being a pure function of the baked
// heightfield, the result is a pure function of the seed — same world, same
// light, in the editor, in VSight and in any export that wants it.

// Compass directions to march. 16 is where the banding stops being visible on
// a smooth hillside; 8 is visibly faceted, 32 costs double for no gain.
/* The bake grid. Deliberately COARSER than the canonical 513² ground: this
   is indirect light, a low-frequency field by nature, and 513 would quadruple
   a ~12-million-sample worker pass for a gradient no eye can resolve. Named
   here so the engine cannot respell it, and so the day 513 is ever warranted
   there is exactly one number to change. */
export const SKYVIS_RES = 257;

export const AZIMUTHS = 16;
// Samples along each ray, spaced geometrically: near ground dominates the
// horizon angle, so the steps grow and reach far without paying for it.
export const RAY_STEPS = 12;
// How far a ray looks, as a fraction of the world's edge. A ridge on the far
// side of the plate does not shade this one.
export const RAY_REACH = 0.08;

/* Bakes sky visibility over the whole world on a `res`² grid.

   Returns { vis, bentX, bentY, bentZ } as Float32Arrays, row-major with j
   indexing z, matching bakeHeightField's layout. `vis` is the unoccluded
   fraction of the hemisphere in [0,1]; bent* is a unit-ish vector pointing at
   the centre of mass of the visible sky.

   `sampler(x, z)` is any height sampler — analytic, baked or sculpted. */
export function bakeSkyVisibility({ sampler, size, res, reach = RAY_REACH }) {
  const vis = new Float32Array(res * res);
  const bentX = new Float32Array(res * res);
  const bentY = new Float32Array(res * res);
  const bentZ = new Float32Array(res * res);
  const step = size / (res - 1);
  const maxDist = size * reach;

  // Ray directions and their sample distances are the same for every cell, so
  // they are computed once rather than res² times.
  const dirs = [];
  for (let a = 0; a < AZIMUTHS; a++) {
    const ang = (a / AZIMUTHS) * Math.PI * 2;
    dirs.push([Math.cos(ang), Math.sin(ang)]);
  }
  const dists = [];
  for (let s = 1; s <= RAY_STEPS; s++) {
    // Geometric spacing: t² over the step count, scaled to the reach.
    const t = s / RAY_STEPS;
    dists.push(Math.max(step, t * t * maxDist));
  }

  for (let j = 0; j < res; j++) {
    const z = -size / 2 + j * step;
    for (let i = 0; i < res; i++) {
      const x = -size / 2 + i * step;
      const h = sampler(x, z);
      let open = 0, bx = 0, by = 0, bz = 0;

      for (const [dx, dz] of dirs) {
        // Steepest skyline angle along this direction, as a tangent.
        let maxTan = 0;
        for (const d of dists) {
          const dh = sampler(x + dx * d, z + dz * d) - h;
          if (dh <= 0) continue;
          const tan = dh / d;
          if (tan > maxTan) maxTan = tan;
        }
        // Fraction of this direction's vertical slice that is still sky.
        // horizonAngle = atan(maxTan); the visible slice runs from there to
        // the zenith, and cos-weighting it (the light a flat surface actually
        // receives) integrates to cos²(horizon) — hence the identity below,
        // which needs no trig call at all: cos²(atan(t)) = 1/(1+t²).
        const slice = 1 / (1 + maxTan * maxTan);
        open += slice;
        // The bent normal leans away from whatever is blocking: each
        // direction contributes its own openness, tilted up by how much sky
        // is left above its horizon.
        bx += dx * slice * maxTan;
        bz += dz * slice * maxTan;
        by += slice;
      }

      const k = j * res + i;
      vis[k] = open / AZIMUTHS;
      // Blocked directions pull the bent normal AWAY from themselves, so the
      // accumulated lean is negated; straight up is the unoccluded answer.
      const len = Math.hypot(-bx, by, -bz) || 1;
      bentX[k] = -bx / len;
      bentY[k] = by / len;
      bentZ[k] = -bz / len;
    }
  }
  return { vis, bentX, bentY, bentZ, res, size };
}

/* Packs the bake into the RGBA8 bytes a texture wants: RGB is the bent normal
   remapped from [-1,1] to [0,1], A is the visibility. One texture, one fetch,
   which is what the material patch (render/atmosphere.js) can afford to do
   per fragment. */
export function packSkyVisibility({ vis, bentX, bentY, bentZ }) {
  const n = vis.length;
  const out = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    out[k * 4] = Math.round((bentX[k] * 0.5 + 0.5) * 255);
    out[k * 4 + 1] = Math.round((bentY[k] * 0.5 + 0.5) * 255);
    out[k * 4 + 2] = Math.round((bentZ[k] * 0.5 + 0.5) * 255);
    out[k * 4 + 3] = Math.round(Math.min(Math.max(vis[k], 0), 1) * 255);
  }
  return out;
}
