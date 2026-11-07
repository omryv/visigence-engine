/* crowding.js — "is this one of a crowd?", per placement.
 *
 * Split out of pins.js for one reason: it is pure arithmetic over plain
 * numbers, and pins.js imports three, so nothing in that file can ever be
 * run by the headless suite. This can. See tests/crowding.test.js.
 *
 * The marker layer needs this because a hedge of forty fence posts does not
 * need forty hard markers — that is an inventory, not a signpost, and it is
 * the one way a discovery layer ends up worse than no discovery layer. Pins
 * in a crowd keep their position and lose their weight; an isolated object,
 * which is the one an author can genuinely lose, keeps a crisp pin.
 *
 * A coarse hash grid, one pass. It runs when the set of placements changes,
 * which is a click, not a frame.
 */

// Metres. Deliberately generous: the question is not "do these two overlap"
// but "is this one of a run", and a run is a fence, a terrace, a stall row.
export const CROWD_CELL = 9;

export function crowding(list, cell = CROWD_CELL) {
  const out = new Float32Array(list.length);
  if (!list.length) return out;
  const bins = new Map();
  const keys = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    // Two independent large odd multipliers, so neighbouring cells in x and
    // in z cannot collide into the same bucket the way (x * k + z) does.
    const k = `${Math.floor(list[i].x / cell)},${Math.floor(list[i].z / cell)}`;
    keys[i] = k;
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  for (let i = 0; i < list.length; i++) out[i] = bins.get(keys[i]) - 1;
  return out;
}

// What the shader does with it, as a pure function so the curve is testable
// rather than only visible. 0 crowding → full weight; a dense run → a floor.
export const CROWD_FALLOFF = 0.55;
export const CROWD_FLOOR = 0.16;

export function crowdFade(crowd, { falloff = CROWD_FALLOFF, floor = CROWD_FLOOR } = {}) {
  return Math.max(1 / (1 + Math.max(crowd, 0) * falloff), floor);
}
