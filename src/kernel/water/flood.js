// Sea-connected flooding: WHICH parts of the water plane are actually water.
//
// The engine renders water as ONE plane at y = 0 whose shader reads depth
// from the baked heightfield, so historically any ground below sea level came
// out wet — including a pit dug in the middle of a mountain, which has no way
// to hold sea. This module is the topology check that makes that impossible:
// a breadth-first flood from the world's open edge, so a hollow is water only
// when there is a path to the sea.
//
// It also produces the REVEAL ORDER used to animate a new flood: how many BFS
// steps each newly-wet cell sits from water that was already there. The shader
// turns that into an advancing front driven by ONE uniform, so water visibly
// runs down a freshly dug trench instead of appearing all at once — no
// per-frame texture uploads, and no fluid simulation.
//
// What this is NOT: it cannot stand water at DIFFERENT heights in different
// basins. There is one waterline for the whole world. Damming a valley to a
// level of its own needs per-basin water heights, a different feature.
//
// Pure JS (no three.js) — runs under JavaScriptCore tests alongside the rest
// of the heightfield code.

export const FLOOD_VERSION = 1;

/* ── grid changes ──
   Every FINAL ground now bakes at one canonical grid, but the previous mask
   can still arrive on another one: the quick 257² placeholder a fresh world
   shows while erosion is running (Engine QUICK_FIELD_RES) leaves its mask
   behind, and the eroded 513² bake that replaces it must still know what was
   already water or the world's first flood never animates. These are 2ⁿ+1
   grids, so the mapping is an exact subsample in the common 513↔257 case and
   nearest-cell in general. Same grid twice — the ordinary case now — passes
   through untouched. */
function resampleMask(mask, srcRes, dstRes) {
  if (srcRes === dstRes) return mask;
  const out = new Uint8Array(dstRes * dstRes);
  const k = (srcRes - 1) / (dstRes - 1);
  for (let j = 0; j < dstRes; j++) {
    const sj = Math.min(srcRes - 1, Math.round(j * k)) * srcRes;
    for (let i = 0; i < dstRes; i++) {
      out[j * dstRes + i] = mask[sj + Math.min(srcRes - 1, Math.round(i * k))];
    }
  }
  return out;
}

/* ── the flood ──
   `field` is a baked heightfield { res, size, data }. `prev` is the previous
   RESULT of this function, used only to decide what is NEW (and therefore
   what the animation reveals); pass null on the first bake of a world.

   `level` is the waterline in world metres. It defaults to 0 because the
   heightfield normalizes around params.terrain.seaLevel, so 0 IS the natural
   coastline; raising it floods the existing land without re-baking terrain,
   which is what the flood slider does. Terrain is read, never written.

   Returns:
     wet      Uint8Array — 1 where the water plane should render
     steps    Int32Array — -1 dry · 0 already water · n BFS steps from the old
              water's edge. This is the reveal order, not a distance to the sea.
     maxSteps largest step count reached (0 when nothing is new)
     newCount cells that became wet since prevWet
     seeded   false when the world edge held no water at all (see below) */
export function floodFromSea(field, prev = null, level = 0) {
  const { res, size, data } = field;
  const N = res * res;
  const wet = new Uint8Array(N);
  const steps = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let head = 0, tail = 0;

  /* ── pass 1: connectivity ──
     Seed every border cell that is below sea level. The terrain's edge
     falloff (heightfield.js, EDGE_START) sinks the world's outer margin
     precisely so the finite plate ends in open water, so on any ordinary
     world these exist in quantity. */
  for (let k = 0; k < res; k++) {
    const top = k, bottom = (res - 1) * res + k, left = k * res, right = k * res + (res - 1);
    if (!wet[top] && data[top] < level) { wet[top] = 1; queue[tail++] = top; }
    if (!wet[bottom] && data[bottom] < level) { wet[bottom] = 1; queue[tail++] = bottom; }
    if (!wet[left] && data[left] < level) { wet[left] = 1; queue[tail++] = left; }
    if (!wet[right] && data[right] < level) { wet[right] = 1; queue[tail++] = right; }
  }
  const seeded = tail > 0;

  while (head < tail) {
    const p = queue[head++];
    const i = p % res, j = (p / res) | 0;
    let q;
    if (i > 0)       { q = p - 1;   if (!wet[q] && data[q] < level) { wet[q] = 1; queue[tail++] = q; } }
    if (i < res - 1) { q = p + 1;   if (!wet[q] && data[q] < level) { wet[q] = 1; queue[tail++] = q; } }
    if (j > 0)       { q = p - res; if (!wet[q] && data[q] < level) { wet[q] = 1; queue[tail++] = q; } }
    if (j < res - 1) { q = p + res; if (!wet[q] && data[q] < level) { wet[q] = 1; queue[tail++] = q; } }
  }

  // Degenerate world (every border cell above sea level): fall back to the
  // old rule rather than making the sea vanish. Losing water outright is a
  // far worse failure than showing a landlocked pond.
  if (!seeded) {
    for (let p = 0; p < N; p++) if (data[p] < level) wet[p] = 1;
  }

  /* ── pass 2: reveal order ──
     Sources are cells that were ALREADY water, so the existing sea stays put
     and only the new flood advances. */
  const usable = prev?.wet && prev.wet.length === prev.res * prev.res
    ? resampleMask(prev.wet, prev.res, res)
    : null;
  head = tail = 0;
  let wetCount = 0, newCount = 0;
  for (let p = 0; p < N; p++) {
    if (!wet[p]) continue;
    wetCount++;
    if (!usable || usable[p]) { steps[p] = 0; queue[tail++] = p; }
    else newCount++;
  }
  // Nothing to grow from — a fresh world, or water with no cell in common
  // with the old mask. Everything is "already there": no animation.
  if (tail === 0) {
    for (let p = 0; p < N; p++) if (wet[p]) { steps[p] = 0; queue[tail++] = p; }
    newCount = 0;
  }

  let maxSteps = 0;
  while (head < tail) {
    const p = queue[head++];
    const d = steps[p] + 1;
    const i = p % res, j = (p / res) | 0;
    let q;
    if (i > 0)       { q = p - 1;   if (wet[q] && steps[q] < 0) { steps[q] = d; queue[tail++] = q; if (d > maxSteps) maxSteps = d; } }
    if (i < res - 1) { q = p + 1;   if (wet[q] && steps[q] < 0) { steps[q] = d; queue[tail++] = q; if (d > maxSteps) maxSteps = d; } }
    if (j > 0)       { q = p - res; if (wet[q] && steps[q] < 0) { steps[q] = d; queue[tail++] = q; if (d > maxSteps) maxSteps = d; } }
    if (j < res - 1) { q = p + res; if (wet[q] && steps[q] < 0) { steps[q] = d; queue[tail++] = q; if (d > maxSteps) maxSteps = d; } }
  }

  // INVARIANT: wet ⇒ steps ≥ 0. The guard above only catches the case where
  // NOTHING had a source; a single wet component that shares no cell with the
  // old mask keeps its own -1s, and the byte encoder would turn those into a
  // large order (the arithmetic goes negative and wraps), hiding that water
  // until the very end of a sweep. Unknown timing means reveal it now.
  for (let p = 0; p < N; p++) if (wet[p] && steps[p] < 0) steps[p] = 0;

  return { version: FLOOD_VERSION, res, size, wet, steps, maxSteps, wetCount, newCount, seeded };
}

// Nearest-cell lookup in world coordinates — what the minimap needs so its
// water agrees with the viewport's.
export function wetAt(flood, x, z) {
  if (!flood) return null;
  const { res, size, wet } = flood;
  const i = Math.round((x / size + 0.5) * (res - 1));
  const j = Math.round((z / size + 0.5) * (res - 1));
  if (i < 0 || j < 0 || i >= res || j >= res) return false;
  return wet[j * res + i] === 1;
}
