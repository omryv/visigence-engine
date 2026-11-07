/* Which raycast hit is GROUND, when a terrain tile carries more than ground.
 *
 * Every tile's geometry ends in a skirt — the border ring duplicated and
 * dropped, up to 2% of the world height, to mask LOD cracks. The skirt is
 * part of the same BufferGeometry, so a grazing ray can strike a nearer
 * tile's skirt wall and report a point metres below (and beside) the ground
 * the pointer is over — and that point used to be fed straight to the sculpt
 * brush, the site ring, the block ghost and the spawn marker.
 *
 * The tile records where its surface triangles end (userData.groundIndexCount,
 * written by QuadtreeTerrain._buildTile before the skirt is appended), and
 * this helper walks the distance-sorted hit list to the first hit that lies
 * in the surface range. Pure JS — the hit list is plain data — so the rule is
 * testable without a renderer.
 */

/** The first hit whose triangle belongs to the ground surface, or null.
    A hit on geometry that never recorded a boundary counts as ground: only
    terrain tiles carry skirts, and refusing everything else would make the
    helper wrong for any future pickable that is all surface. */
export function firstGroundHit(hits) {
  for (const hit of hits) {
    const count = hit?.object?.geometry?.userData?.groundIndexCount;
    if (count == null || hit.faceIndex * 3 < count) return hit;
  }
  return null;
}
