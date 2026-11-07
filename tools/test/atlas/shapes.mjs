// Synthetic silhouettes with analytically known ground truth, shared by the
// acceptance tests. Everything here is exact geometry — no reconstruction.

export const W = 280, H = 280;

export function raster(f, w = W, h = H) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = f(x + 0.5, y + 0.5) ? 1 : 0;
  return m;
}

// Union of two disks of radius R centred at (cx ± (R−δ), cy).
//
// The waist point is (cx, cy) and its clearance is NOT δ: the nearest point of
// either circle, (±δ, 0) from the waist, lies INSIDE the other disk and is
// therefore interior, not boundary. The nearest boundary is the corner where the
// two circles cross, at (0, ±sqrt(2Rδ − δ²)).
export function twoDisk(R, delta, cx = W / 2, cy = H / 2) {
  const c = R - delta;
  return {
    mask: raster((x, y) => (x - cx + c) ** 2 + (y - cy) ** 2 < R * R
                        || (x - cx - c) ** 2 + (y - cy) ** 2 < R * R),
    waist: [cx, cy],
    lobe: [cx - c, cy],
    Dwaist: Math.sqrt(2 * R * delta - delta * delta),
    Dlobe: R,
    R, delta,
  };
}

export function disk(R, cx = W / 2, cy = H / 2) {
  return { mask: raster((x, y) => (x - cx) ** 2 + (y - cy) ** 2 < R * R),
           centre: [cx, cy], D: R };
}

export function square(a, cx = W / 2, cy = H / 2) {
  return { mask: raster((x, y) => Math.abs(x - cx) < a && Math.abs(y - cy) < a),
           centre: [cx, cy], D: a };
}

// vertical bar of half-width a
export function bar(a, cx = W / 2, y0 = 50, y1 = 230) {
  return { mask: raster((x, y) => Math.abs(x - cx) < a && y > y0 && y < y1),
           centre: [cx, (y0 + y1) / 2], D: a };
}

// 34px-half-width torso with a 6px-half-width limb at a given gap
export function torsoLimb(limbA, gap, torsoA = 34) {
  const tx = 90, ax = tx + torsoA + gap + limbA;
  return {
    mask: raster((x, y) => (Math.abs(x - tx) < torsoA && y > 50 && y < 230)
                        || (Math.abs(x - ax) < limbA && y > 50 && y < 230)),
    torso: [tx, 140], limb: [ax, 140], Dtorso: torsoA, Dlimb: limbA, ax,
  };
}

export const at = (field, x, y, w = W) => field[Math.round(y - 0.5) * w + Math.round(x - 0.5)];

// The pixel centre a probe actually lands on. A 12px-wide bar on an integer grid
// has no pixel centre on its axis, so its greatest achievable half-thickness is
// 5.5 and not 6 — the target has to be evaluated where the sample really is.
export const probeCentre = (x, y) => [Math.round(x - 0.5) + 0.5, Math.round(y - 0.5) + 0.5];

// exact distance from p to the boundary of a union of two disks, by dense
// sampling of the two arcs (the analytic nearest point is either a foot on an
// arc or one of the two crossing corners; sampling covers both without cases)
export function twoDiskExactDist(R, delta, px, py, cx = W / 2, cy = H / 2) {
  const c = R - delta, N = 400000;
  let best = Infinity;
  for (const s of [-1, 1]) {
    const ox = cx + s * c;
    for (let k = 0; k < N; k++) {
      const t = 2 * Math.PI * k / N, bx = ox + R * Math.cos(t), by = cy + R * Math.sin(t);
      if ((bx - cx + s * c) ** 2 + (by - cy) ** 2 < R * R - 1e-9) continue;   // inside the other disk
      const d = Math.hypot(bx - px, by - py);
      if (d < best) best = d;
    }
  }
  return best;
}

export const rectExactDist = (ax, ay, cx, cy, px, py) =>
  Math.min(ax - Math.abs(px - cx), ay - Math.abs(py - cy));

// mean of `field` over the limb's interior column, excluding the tapered ends
export function meanOver(field, mask, pred, w = W, h = H) {
  let s = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] && pred(x + 0.5, y + 0.5)) { s += field[i]; n++; }
  }
  return n ? s / n : NaN;
}
