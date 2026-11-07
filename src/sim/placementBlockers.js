/**
 * A level's placements as collision: the one registration the game (game/Game.js) and the editor's live checks
 * (world/level/checks.js) share, so a check can only call a spot reachable if the game would let a body stand there.
 *
 * Each placement with collision becomes a dynamic blocker named `prop:<index>:<id>` (the id mission targets and the
 * level script use to open doors); one with a height also gets a finite projectile box, so shots pass above low
 * cover. Three-free: CollisionSystem is plain arithmetic over the nav grid.
 */
export function registerPlacementBlockers(collision, placements, terrain) {
  for (const [index, p] of (placements ?? []).entries()) {
    const id = `prop:${index}:${p.id}`;
    if (p.collision === 'none') continue;
    if (p.projectileOnly) {
      collision.projectileBoxes.push({ id, active: true, surface: 'concrete', box: { min: { x: p.x - p.halfX, y: p.y, z: p.z - p.halfZ }, max: { x: p.x + p.halfX, y: p.y + p.height, z: p.z + p.halfZ } } });
      continue;
    }
    let blocker;
    if (p.collision === 'box') {
      // Baked rotations are quarter turns, rounded to four decimals. Compute a safe
      // world AABB so non-square cover keeps the same footprint after rotation.
      const cos = Math.abs(Math.cos(p.yaw ?? 0)), sin = Math.abs(Math.sin(p.yaw ?? 0));
      blocker = collision.addBoxBlocker(id, p.x, p.z, p.halfX * cos + p.halfZ * sin, p.halfX * sin + p.halfZ * cos);
    } else blocker = collision.addCircleBlocker(id, p.x, p.z, p.radius);
    blocker.surface = 'metal';
    // The navigation footprint is 2D; bullets/grenades use the existing finite
    // projectile-box API so low cover does not become an infinitely tall wall.
    if (p.height > 0) {
      const hx = blocker.hx ?? blocker.r, hz = blocker.hz ?? blocker.r;
      const y = p.y ?? terrain.heightAt(p.x, p.z);
      blocker.projectileProxy = true;
      blocker.box = { min: { x: p.x - hx, y, z: p.z - hz }, max: { x: p.x + hx, y: y + p.height, z: p.z + hz } };
      collision.projectileBoxes.push(blocker);
    }
  }
}

/** The blocker id a placement at `index` registers under. */
export const blockerIdOf = (index, placement) => `prop:${index}:${placement.id}`;
