// Deterministic 2D value noise + FBM + ridged + domain warp, and the feature
// fields a layer stack composes out of: billow, voronoi, craters, dunes and
// flow channels.
// Integer hashing only (imul), so results are identical in the browser,
// the erosion worker and JavaScriptCore tests.
//
// ── EVERY FIELD HERE RETURNS [-1, 1] ──
// Not a formatting preference: src/kernel/terrain/noise-stack.js blends these
// together with `max`, `min`, `multiply` and a mask chain, and a blend of two
// fields on different scales is a blend whose result depends on which one
// happened to be louder. `crater` is the one that has to be argued for rather
// than normalised — its natural output is a bowl of `depth` inside a rim of
// `rim` — and it is in range because both of those are themselves capped at 1.

export function hash2(ix, iz, seed) {
  let h = seed >>> 0;
  h = Math.imul(h ^ ix, 0x27d4eb2d);
  h = Math.imul(h ^ iz, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296; // [0,1)
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = quintic(fx), v = quintic(fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1; // [-1,1]
}

export function fbm(x, z, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + i * 1013);
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

// Ridged multifractal: sharp crests, good mountains.
export function ridged(x, z, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise(x * freq, z * freq, seed + i * 2027));
    n = n * n * weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += amp * n;
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return (sum / norm) * 2 - 1;
}

// Domain warp: offsets the sample point by low-frequency noise.
export function warp2(x, z, seed, strength) {
  if (!strength) return [x, z];
  const wx = fbm(x + 31.7, z + 11.3, seed ^ 0x9e3779b9, 3);
  const wz = fbm(x - 24.1, z - 47.9, seed ^ 0x517cc1b7, 3);
  return [x + wx * strength, z + wz * strength];
}

// Billow: the fold of value noise about zero, stacked. Rounded lobes rather
// than ridged's creases — dunes seen from above, soft hills, cloud shapes.
export function billow(x, z, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * Math.abs(valueNoise(x * freq, z * freq, seed + i * 3037));
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return (sum / norm) * 2 - 1;
}

/* Voronoi / cellular. `mode` picks which of the three useful readings comes
   out, because they are three different pictures from one search:
     0 CELL      the cell's own random value — flat plates, tectonic regions
     1 DISTANCE  how far this point is from its cell's site — pits and mounds
     2 EDGE      the gap between nearest and second-nearest site, which is the
                 one that draws the WALLS: near zero on a cell boundary and
                 large in the middle, i.e. cracked ground and mud flats.
   `jitter` at 0 puts every site at its cell corner and makes a square grid,
   which is occasionally what a world wants and mostly a diagnostic. */
export function voronoi(x, z, seed, jitter = 1, mode = 2) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  let f1 = 8, f2 = 8, cell = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cz = iz + dz;
      const ox = hash2(cx, cz, seed) * jitter;
      const oz = hash2(cx, cz, seed ^ 0x9e3779b9) * jitter;
      const rx = dx + ox - fx, rz = dz + oz - fz;
      const d = Math.sqrt(rx * rx + rz * rz);
      if (d < f1) { f2 = f1; f1 = d; cell = hash2(cx, cz, seed ^ 0x85ebca6b); }
      else if (d < f2) { f2 = d; }
    }
  }
  if (mode === 0) return cell * 2 - 1;
  if (mode === 1) return Math.min(f1, 1) * 2 - 1;
  return Math.min(f2 - f1, 1) * 2 - 1;
}

/* Impact craters: one candidate site per cell, kept when its own roll falls
   under `density`, drawn as a bowl inside a raised rim. Craters do not
   overlap here — a point takes the nearest site and no other — which is wrong
   for a real moon and right for a height field you have to walk on, because
   overlapping bowls make basins with no outflow. */
export function crater(x, z, seed, { density = 0.55, depth = 0.6, rim = 0.3, rimWidth = 0.35 } = {}) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  let best = 8, roll = 0, site = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cz = iz + dz;
      const ox = hash2(cx, cz, seed), oz = hash2(cx, cz, seed ^ 0x27d4eb2d);
      const rx = dx + ox - fx, rz = dz + oz - fz;
      const d = Math.sqrt(rx * rx + rz * rz);
      if (d < best) { best = d; roll = hash2(cx, cz, seed ^ 0x165667b1); site = hash2(cx, cz, seed ^ 0x2545f491); }
    }
  }
  if (roll > density) return 0;
  const radius = 0.18 + 0.28 * site;
  const t = best / Math.max(radius, 0.02);
  const bowl = -depth * (1 - smoothstep01(Math.min(t, 1)));
  const lip = rim * Math.exp(-(((t - 1) / Math.max(rimWidth, 0.02)) ** 2));
  return clamp11(bowl + lip);
}

/* Wind-shaped dunes: a wave train running ACROSS the wind, sharpened by a
   power curve so the crests are lines rather than sinusoids, with a second
   much finer ripple along the faces. `direction` is a bearing in radians on
   the ground plane, matching the convention the grass wind uses (0 = +X). */
export function dune(x, z, seed, { direction = 0.7, sharpness = 1.4, rippleScale = 4.0, rippleStrength = 0.12 } = {}) {
  const dx = Math.cos(direction), dz = Math.sin(direction);
  const across = x * -dz + z * dx;
  const along = x * dx + z * dz;
  // A slow wander so the crests are not perfectly parallel across the world.
  const wander = valueNoise(x * 0.5, z * 0.5, seed);
  let crest = 1 - Math.abs(Math.sin(across + wander));
  crest = Math.pow(Math.max(crest, 0), Math.max(sharpness, 0.1));
  const ripple = valueNoise(across * rippleScale, along * 0.3, seed ^ 0x68e31da4) * rippleStrength;
  return clamp11((crest + ripple) * 2 - 1);
}

/* A flow channel: a meandering trough running along `direction`. Positive at
   the channel's centre and falling to zero away from it, so the layer that
   uses it normally does so under the `carve` blend — the field says WHERE a
   valley is and the blend decides that a valley only ever cuts down. */
export function channel(x, z, seed, { direction = 1.2, width = 0.3, meander = 1.2, meanderScale = 0.6 } = {}) {
  const dx = Math.cos(direction), dz = Math.sin(direction);
  const along = x * dx + z * dz;
  let across = x * -dz + z * dx;
  across += valueNoise(along * meanderScale, 13.1, seed) * meander;
  return clamp11(Math.exp(-(((across / Math.max(width, 0.02)) ** 2))) * 2 - 1);
}

const clamp11 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
const smoothstep01 = (t) => t * t * (3 - 2 * t);
