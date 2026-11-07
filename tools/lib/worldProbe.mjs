/** In-page helpers for the browser checks that drive the world editor (world.html). Each is stringified and run in
 *  the page, so it may use only its argument. */

/* Dry, fairly level ground nearest the middle of the world: where a town can stand. */
export function landPoint(engine) {
  const w = engine.params.water.level || 0, h = (x, z) => engine.sampleHeight(x, z);
  for (let r = 0; r < 1600; r += 48) for (let a = 0; a < 6.283; a += 0.3) {
    const x = Math.round(r * Math.cos(a)), z = Math.round(r * Math.sin(a)), y = h(x, z);
    if (y > w + 8 && Math.abs(h(x + 24, z) - y) < 3 && Math.abs(h(x, z + 24) - y) < 3) return { x, z };
  }
  return { x: 0, z: 0 };
}
