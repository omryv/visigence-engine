/* One mapping from a fence-post grid to the texture that carries it.
 *
 * Every baked field in this engine samples the plate corner to corner: cell i
 * sits at -size/2 + i·size/(res-1), so the first and last cells are ON the
 * edges. A texture's cell i is centred at (i+0.5)/res — half a texel in from
 * the edge. Conflating the two shifts everything the texture describes half a
 * cell off the ground it was measured from: ~8 m of sky light, or a coastline
 * discarding the wrong column of water, on a 257² grid over 4 km.
 *
 * The correction is the same two numbers everywhere:
 *
 *     uv = (w/size + 0.5) · k + b        k = (res-1)/res    b = 0.5/res
 *
 * and because 0.5·k + b = 0.5 exactly, it folds to uv = w·(k/size) + 0.5 for
 * any shader already written in that shape — only the scale changes.
 *
 * QuadtreeTerrain worked this out first (setControlMap); the sky-visibility
 * and water shaders used to skip it. Now all three take their numbers from
 * here, so they cannot disagree again.
 */

/** The scale/bias pair that puts world position w on the texel that holds
    grid cell i. `k` multiplies the normalized position, `b` is the bias that
    replaces a bare `+ 0.5` edge term. */
export function gridTexMapping(res) {
  return { k: (res - 1) / res, b: 0.5 / res };
}

/** The one number a `w * scale + 0.5` shader needs: k/size. */
export function worldTexScale(res, size) {
  return gridTexMapping(res).k / size;
}
