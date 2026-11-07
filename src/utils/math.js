/**
 * Small numeric helpers shared by the first-person systems.
 *
 * Nothing here allocates. The PRNG is deterministic on purpose: every procedural effect in
 * the game that wants "variation" draws from a seeded stream, so a replay of the same
 * inputs produces the same picture and a bug can be reproduced from a seed.
 */

/**
 * Deterministic 32-bit PRNG. Returns a function yielding [0, 1).
 *
 * The repository kernel's own (src/kernel/seed.js at the root), re-exported rather than kept as a
 * second copy: `channelRng`, every seeded stream the kernel's worlds draw, and this engine's
 * grammars, layouts and effects all step ONE implementation. (The copy this replaced kept its
 * accumulator unsigned with `>>> 0` where the kernel's is signed with `| 0`; Math.imul and `>>>`
 * coerce their operands the same way, so the two drew the same bits, and the generated-output
 * fixtures under tools/test/fixtures are unchanged by the swap.) Exported from here because every
 * caller in this engine already reaches for it here, next to clamp and lerp.
 */
export { mulberry32 } from '../kernel/seed.js';
import { randomSeed as kernelRandomSeed } from '../kernel/seed.js';

/**
 * A fresh seed from INJECTED entropy: the kernel's randomSeed, with the one thing this engine's
 * port insisted on and the kernel does not. The kernel's `randomSeed(rng = Math.random)` falls
 * back to Math.random when called bare; here a bare call throws, because a seed drawn from
 * ambient entropy in a code path that was meant to be reproducible is a bug nobody can replay.
 * Pass `Math.random` (or crypto) to mean "random", or a seeded stream to make the "random" seed
 * reproducible. The alphabet and the draw are the kernel's, so there is one algorithm. The
 * studio itself draws its fresh seeds from crypto.getRandomValues and does not call this.
 *
 * @param {() => number} rng  a source of [0, 1)
 */
export function randomSeed(rng) {
  if (typeof rng !== 'function') throw new TypeError('randomSeed(rng): pass the entropy source explicitly');
  return kernelRandomSeed(rng);
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Frame-rate independent exponential approach: moves `current` toward `target` so that
 * after one second the remaining gap is `exp(-rate)` of what it was, regardless of how
 * many frames that second contained. `current + (target - current) * dt * rate` is NOT
 * that - it overshoots on long frames and moves at a different speed at 144 Hz than at
 * 60 Hz.
 */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
export const easeInCubic = (x) => x * x * x;
export const smoothstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/**
 * A damped spring, x'' + damping*x' + stiffness*x = 0, integrated with semi-implicit Euler
 * at a step size derived from its own stiffness so it is stable at any frame delta.
 *
 * Semi-implicit Euler (velocity first, then position from the NEW velocity) is stable only
 * while h * sqrt(k) < 2. A stalled frame reaches the render step clamped to 250 ms, and at
 * k = 190 a single step of that size diverges to Infinity within a few frames and NaNs
 * whatever transform it feeds. Deriving h from k makes the frame rate irrelevant.
 */
export class Spring {
  constructor(stiffness, damping) {
    this.value = 0;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  kick(v) { this.velocity += v; }

  update(dt) {
    const h = 0.5 / Math.sqrt(this.stiffness);
    const steps = Math.max(1, Math.min(64, Math.ceil(dt / h)));
    const s = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel = -this.stiffness * this.value - this.damping * this.velocity;
      this.velocity += accel * s;
      this.value += this.velocity * s;
    }
    return this.value;
  }

  reset() { this.value = 0; this.velocity = 0; }
}
