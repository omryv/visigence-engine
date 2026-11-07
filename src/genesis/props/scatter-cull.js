/* scatter-cull.js — which plants are worth submitting this frame.
 *
 * WHY IT IS PURE AND SEPARATE. Scatter.js imports three, so no test in this
 * suite can load it, and the suite is three-free by design. What is below is
 * arithmetic over positions and planes: exactly the part that has to be right,
 * and exactly the part a browser cannot usefully be asked about — "did the
 * forest look correct" is not a question a headless software rasteriser
 * answers. Same split as burn-spec.js and bloom-plan.js.
 *
 * ── WHAT WAS WRONG ──
 * Every InstancedMesh the scatter builds sets `frustumCulled = false`, and it
 * has to: the batch spans the whole world, so its bounding sphere is the
 * world and three's own test would either keep everything or drop everything.
 * The consequence was that every plant in the world was submitted every
 * frame — the wood behind you, the wood over the horizon, the wood inside the
 * hill. The vertex stage paid for all of it and the only thing that saved the
 * frame was that there were never very many plants, which is the same as
 * saying the draw distance was set by the object budget rather than by design.
 *
 * ── AND WHY A SHADOW APPEARS IN A VISIBILITY TEST ──
 * A plant behind the camera casts a shadow the camera can see. Cull it on the
 * view frustum alone and its shadow vanishes, which is a worse artefact than
 * the cost it saves — shadows popping in as you turn around.
 *
 * The first version of this kept anything inside the SHADOW VOLUME, and that
 * was wrong in a way worth recording, because it looked obviously right. The
 * volume is not a couple of hundred metres: Sky.updateShadow grows it with
 * altitude and with how far the framing subject is from the camera, up to
 * three quarters of the world. Measured on a built world it was 3072 m — so
 * the exemption kept every plant inside the draw distance, the frustum test
 * became dead code, and turning ninety degrees changed the drawn count by
 * nothing at all. A test that cannot fail is not insurance.
 *
 * What actually matters is not whether a caster is inside the volume but
 * whether its SHADOW reaches the frustum, and a shadow does not travel far: a
 * plant of height h with the sun at elevation e throws it about h/sin(e).
 * So the caster is swept along the shadow direction by that much and the
 * whole swept capsule is tested at once, bounded by a single sphere at the
 * sweep's midpoint. One test, conservative — it can only ever keep too much,
 * never too little — and it stays strict at any shadow-volume size.
 */

/* Signed distance from a plane to a point, for planes stored as
   [a,b,c,d] × 6 in one array — the layout three's Frustum uses once its
   planes are flattened, and the layout that lets this loop stay branch-free
   over a typed array. */
function outsideFrustum(planes, x, y, z, r) {
  for (let p = 0; p < 24; p += 4) {
    if (planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] < -r) return true;
  }
  return false;
}

/* Fill `out` with the indices of the plants that must be drawn, and return
   how many. `origins`/`radii` describe every plant of one species; the same
   answer is applied to every PART of that species by the caller, because a
   canopy culled without its trunk is a worse frame than no culling at all.
 *
 * `throwX/Y/Z` is the shadow throw: how far, and which way, this species'
 * shadow travels at the sun's current elevation. Zero when nothing casts.
 *
 * Two outcomes per plant, cheapest decision first:
 *   · beyond the draw distance → gone, whatever else is true;
 *   · otherwise → kept if the plant OR the shadow it throws is in frustum. */
export function cullSpecies(out, origins, radii, count, planes, camX, camY, camZ, drawDist, throwX, throwY, throwZ) {
  let vis = 0;
  // The swept capsule's bounding sphere sits at the sweep's midpoint and is
  // half the sweep longer than the plant. Computed once, not per plant.
  const hx = throwX * 0.5, hy = throwY * 0.5, hz = throwZ * 0.5;
  const grow = Math.sqrt(hx * hx + hy * hy + hz * hz);
  for (let i = 0; i < count; i++) {
    const j = i * 3;
    const x = origins[j], y = origins[j + 1], z = origins[j + 2];
    const r = radii[i];

    // Distance is measured to the plant's SURFACE, not its origin, so a big
    // tree does not vanish a moment before a small one at the same range.
    const dx = x - camX, dy = y - camY, dz = z - camZ;
    const far = drawDist + r;
    if (dx * dx + dy * dy + dz * dz > far * far) continue;

    if (outsideFrustum(planes, x + hx, y + hy, z + hz, r + grow)) continue;
    out[vis++] = i;
  }
  return vis;
}

/* How far a plant of this size throws its shadow, and which way, given the
   direction to the sun. Returns a vector to sweep the caster along.
 *
 * The sun sits at elevation sunY (the y of a unit vector pointing at it), so
 * dropping a plant's height h to the ground means travelling h/sunY AWAY from
 * the sun. The elevation is floored: at sunrise the true throw is effectively
 * infinite, and a cull that keeps the entire world at dawn is not a cull.
 * Clamped again by `cap`, which the caller sets to the shadow volume — past
 * its edge there is no shadow map to land in. */
export function shadowThrow(out, height, sunX, sunY, sunZ, cap) {
  const len = Math.min(height / Math.max(sunY, 0.15), cap);
  if (!(len > 0) || sunY <= 0) { out[0] = out[1] = out[2] = 0; return out; }
  out[0] = -sunX * len; out[1] = -sunY * len; out[2] = -sunZ * len;
  return out;
}

/* A plant's bounding radius about its own origin, given the parts it is built
   from. Each part carries its own offset inside the plant, so the radius is
   how far the furthest part reaches — not the largest part's own radius,
   which would leave a canopy sitting outside the sphere that is supposed to
   contain it and pop as you turn. */
export function speciesRadius(parts) {
  let r = 0;
  for (const p of parts) {
    r = Math.max(r, p.offset + p.radius);
  }
  return r;
}
