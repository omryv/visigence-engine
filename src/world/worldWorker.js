/**
 * World mode's bake, off the main thread: a seed in, its world out (world/worldMap.js bakeWorld), the quick look first
 * and the canonical ground after it, both transferred rather than copied.
 *
 *   in   { id, seed }
 *   out  { id, type: 'quick' | 'world', bake }   or   { id, type: 'error', message }
 *
 * A newer request makes an older one stale; the page drops an answer whose id is not its latest.
 */
import { bakeWorld, transferables } from './worldMap.js';

self.onmessage = ({ data: { id, seed } }) => {
  try {
    const quick = bakeWorld(seed, { quick: true });
    self.postMessage({ id, type: 'quick', bake: quick }, transferables(quick));
    const world = bakeWorld(seed, { now: () => performance.now() });
    self.postMessage({ id, type: 'world', bake: world }, transferables(world));
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
};
