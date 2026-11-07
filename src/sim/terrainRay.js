/**
 * First intersection with the same bilinear height field used by player movement.
 * Walk height-field cells (not nav cells). Within one cell, height along a ray is
 * quadratic, so solve that segment exactly instead of sampling past narrow ridges.
 * Returns distance along a unit ray, or null. No renderer or second collision grid.
 */
export function terrainRay(terrain, origin, direction, range) {
  const field = terrain.field;
  if (!field || !(range >= 0)) return null;
  const half = field.size / 2, cell = field.size / (field.res - 1);
  let entry = 0, exit = range;
  for (const axis of ['x', 'z']) {
    const o = origin[axis], d = direction[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < -half || o > half) return null;
    } else {
      const a = (-half - o) / d, b = (half - o) / d;
      entry = Math.max(entry, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
    }
  }
  if (entry > exit) return null;
  const clearance = t => origin.y + direction.y * t
    - terrain.heightAt(origin.x + direction.x * t, origin.z + direction.z * t);
  const nextBoundary = (axis, t) => {
    const d = direction[axis];
    if (Math.abs(d) < 1e-12) return Infinity;
    const coordinate = origin[axis] + d * (t + 1e-8);
    const index = Math.floor((coordinate + half) / cell);
    const boundary = -half + (index + (d > 0 ? 1 : 0)) * cell;
    return (boundary - origin[axis]) / d;
  };
  for (let t = entry, guard = 0; t <= exit && guard < field.res * 2 + 4; guard++) {
    const end = Math.min(exit, nextBoundary('x', t), nextBoundary('z', t));
    const c = clearance(t);
    if (c <= 1e-9) return t;
    if (end <= t) break;
    const mid = clearance((t + end) / 2), last = clearance(end);
    const a = 2 * (last + c - 2 * mid), b = last - c - a;
    let roots = [];
    if (Math.abs(a) < 1e-10) {
      if (Math.abs(b) > 1e-12) roots = [-c / b];
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(disc));
        roots = q === 0 ? [-b / (2 * a)] : [q / a, c / q];
        roots.sort((x, y) => x - y);
      }
    }
    for (const u of roots) if (u >= 0 && u <= 1) return t + u * (end - t);
    if (end === exit) break;
    t = end;
  }
  return null;
}
