/* env-pacer.js — when to re-capture the sky IBL, and how big.
 *
 * WHY THIS IS PURE, AND ITS OWN FILE. The decision is four lines of state
 * machine and it was wrong twice, in ways that only show up as a pattern
 * ACROSS frames — a one-off change paying for two captures, or a live drag
 * alternating cheap and expensive ones. A single frame always looks fine.
 * That is exactly the kind of bug a unit test catches trivially and a browser
 * catches never: on the software rasteriser this repository's tools drive, a
 * frame takes between 0.7 and 2.6 seconds, so a "drag" of synthetic input
 * arrives faster than frames do and the sequence under test cannot be
 * produced at all. Driven directly with a list of (dt, dirty) pairs, every
 * one of those sequences is three lines of test.
 *
 * ── WHAT IT IS DECIDING ──
 * Each capture allocates and frees a whole mip-chained PMREM target: three.js
 * gives no way to reuse one, since fromScene always allocates and only
 * fromEquirectangular/fromCubemap accept a target. At a 256 cube edge that is
 * 6.3 MB churned per capture; at 128 it is 1.6 MB. Dragging the hour re-dirties
 * the capture continuously, so the cheap size is worth having — but only for
 * the captures nobody looks at.
 *
 * ── AND HOW ──
 * A one-off change dirties once and goes quiet. A drag keeps dirtying. The
 * two are indistinguishable at the FIRST capture, so the first is always full
 * and only its successors are cheap; when the light finally settles, one
 * full-quality capture replaces the last cheap one. `run` is the bit that
 * says "a capture landed and the light has not settled since", and it is
 * cleared by quiet alone.
 *
 * The measurement is of DIRTY TICKS, never of capture spacing, and that is
 * the whole correctness of it. Deciding "is this a drag" from how recently
 * the last capture landed reads as a drag on a fast machine and as a string
 * of unrelated nudges on a slow one, because capture spacing is bounded by
 * frame time — the optimisation would disable itself on exactly the hardware
 * that needs it. Whether new changes keep arriving is a property of the
 * input, so that is what gets asked.
 */

// At most this often, however fast the hour is dragged.
export const ENV_COOLDOWN = 0.25;
/* How long the light must be still before a run of captures counts as over.
   Ends the cheap-capture run AND triggers the full-quality capture owed. */
export const ENV_SETTLE = 0.6;
// PMREM cube edge: 6.3 MB per capture at 256, 1.6 MB at 128.
export const ENV_SIZE_FULL = 256;
export const ENV_SIZE_DRAG = 128;

export function createEnvPacer() {
  return {
    cooldown: 0,   // counts down to the next capture the debounce will allow
    quiet: 0,      // seconds since the light last changed
    run: false,    // a capture landed and the light has not settled since
    pending: false, // the last capture was cheap, so a full one is owed
  };
}

/* Advance one frame. Returns the cube edge to capture at, or 0 for "not this
   frame". `dirty` is whether anything has changed the sky since the last
   capture; the caller clears its own flag when this returns non-zero. */
export function envCapture(s, dt, dirty) {
  s.cooldown -= dt;
  if (dirty) s.quiet = 0; else s.quiet += dt;

  const settled = s.quiet >= ENV_SETTLE;
  if (settled) s.run = false;

  if (dirty && s.cooldown <= 0) {
    const size = s.run ? ENV_SIZE_DRAG : ENV_SIZE_FULL;
    s.cooldown = ENV_COOLDOWN;
    s.run = true;
    s.pending = size !== ENV_SIZE_FULL;
    return size;
  }
  // The light stopped and the last thing captured was a cheap one. This is
  // the frame anybody actually looks at, so it gets the resolution.
  if (s.pending && settled) {
    s.pending = false;
    return ENV_SIZE_FULL;
  }
  return 0;
}
