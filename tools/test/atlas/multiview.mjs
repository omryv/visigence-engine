// A known 3D solid, rendered from arbitrary viewpoints, so multi-view
// reconstruction can be scored against ground truth rather than against
// eyeballing. Exact geometry — the solid is a union of ellipsoids and every ray
// is intersected analytically, so the depth maps and silhouettes carry no
// discretisation beyond the pixel grid itself.
//
// The figure is deliberately NOT front/back symmetric: the chest bulges toward
// +z and a pack bulges toward −z. A pipeline that mirrors the front sheet onto
// the back cannot express that, so the asymmetry is the thing to measure.

// cx, cy, cz, ax, ay, az
export const FIGURE = [
  [ 0.00,  0.10,  0.00, 0.30, 0.34, 0.15],   // torso
  [ 0.00,  0.14,  0.11, 0.21, 0.25, 0.09],   // chest, forward
  [ 0.00,  0.02, -0.14, 0.19, 0.21, 0.07],   // pack, backward
  [ 0.00,  0.56,  0.02, 0.15, 0.17, 0.15],   // head
  [-0.40,  0.10,  0.00, 0.10, 0.30, 0.10],   // arm L
  [ 0.40,  0.10,  0.00, 0.10, 0.30, 0.10],   // arm R
  [-0.14, -0.45,  0.00, 0.11, 0.34, 0.11],   // leg L
  [ 0.14, -0.45,  0.00, 0.11, 0.34, 0.11],   // leg R
];

export const insideSolid = (p, x, y, z) => p.some(([cx, cy, cz, ax, ay, az]) =>
  ((x-cx)/ax)**2 + ((y-cy)/ay)**2 + ((z-cz)/az)**2 <= 1);

// Camera at azimuth az (deg, 0 = +z looking toward −z), elevation el, distance
// R, focal length f in image half-widths. The image x axis is the camera's right
// vector, so a back view (az = 180) comes out horizontally mirrored exactly as a
// real one does.
export function camera(azDeg, elDeg, R, f) {
  const a = azDeg * Math.PI / 180, e = elDeg * Math.PI / 180;
  const eye = [R * Math.sin(a) * Math.cos(e), R * Math.sin(e), R * Math.cos(a) * Math.cos(e)];
  const fwd = [-eye[0] / R, -eye[1] / R, -eye[2] / R];
  const rt  = [Math.cos(a), 0, -Math.sin(a)];
  // up = fwd x rt, right-handed with image y running DOWN
  const up = [fwd[1]*rt[2] - fwd[2]*rt[1], fwd[2]*rt[0] - fwd[0]*rt[2], fwd[0]*rt[1] - fwd[1]*rt[0]];
  return { eye, fwd, rt, up, R, f };
}

// Nearest surface of the UNION along a ray: merge the per-ellipsoid entry/exit
// intervals and take the start of the first merged span. Doing it by nearest
// root instead would return a point that is interior to a neighbouring lobe.
function hitUnion(parts, o, d) {
  const spans = [];
  for (let k = 0; k < parts.length; k++) {
    const [cx, cy, cz, ax, ay, az] = parts[k];
    const ox = (o[0]-cx)/ax, oy = (o[1]-cy)/ay, oz = (o[2]-cz)/az;
    const dx = d[0]/ax, dy = d[1]/ay, dz = d[2]/az;
    const A = dx*dx + dy*dy + dz*dz;
    const B = 2*(ox*dx + oy*dy + oz*dz);
    const C = ox*ox + oy*oy + oz*oz - 1;
    const disc = B*B - 4*A*C;
    if (disc <= 0) continue;
    const sq = Math.sqrt(disc);
    spans.push([(-B - sq) / (2*A), (-B + sq) / (2*A), k]);
  }
  if (!spans.length) return null;
  spans.sort((p, q) => p[0] - q[0]);
  let s = spans[0][0], e = spans[0][1], owner = spans[0][2];
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] > e) break;                       // gap: the first span is the hit
    if (spans[i][1] > e) e = spans[i][1];
  }
  if (e < 0) return null;
  if (s < 0) return null;                             // camera inside the solid
  const [cx, cy, cz, ax, ay, az] = parts[owner];
  const px = o[0] + s*d[0], py = o[1] + s*d[1], pz = o[2] + s*d[2];
  let nx = (px-cx)/(ax*ax), ny = (py-cy)/(ay*ay), nz = (pz-cz)/(az*az);
  const nl = Math.hypot(nx, ny, nz) || 1;
  return { t: s, p: [px, py, pz], n: [nx/nl, ny/nl, nz/nl] };
}

// Deterministic noise so a rendered fixture is reproducible across runs.
let _seed = 0x2545F491;
export const reseed = (v) => { _seed = v >>> 0; };
const rnd = () => {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;  _seed >>>= 0;
  return _seed / 4294967296;
};

// Renders the solid to an RGBA buffer the pipeline can consume directly, plus
// the exact depth and mask for scoring. SPAN is the half-width of the image
// plane in world units at the object's own depth.
export function render(cam, w, h, opts = {}) {
  const { parts = FIGURE, span = 0.95, light = [0.4, 0.7, 0.6],
          bg = 232, noise = 2.0, albedo = null } = opts;
  const px = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);
  const depth = new Float32Array(w * h);          // world z of the hit, NaN if none
  const ll = Math.hypot(...light);
  const L = [light[0]/ll, light[1]/ll, light[2]/ll];
  const aspect = h / w;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    // image plane coordinates, span across x and span*aspect across y
    const sx = ((i + 0.5) / w * 2 - 1) * span;
    const sy = ((j + 0.5) / h * 2 - 1) * span * aspect;
    // perspective ray through the pinhole
    const k = span / cam.f;
    const d = [cam.fwd[0] + (sx*cam.rt[0] + sy*cam.up[0]) * (1/cam.f),
               cam.fwd[1] + (sx*cam.rt[1] + sy*cam.up[1]) * (1/cam.f),
               cam.fwd[2] + (sx*cam.rt[2] + sy*cam.up[2]) * (1/cam.f)];
    const dl = Math.hypot(...d); d[0]/=dl; d[1]/=dl; d[2]/=dl;
    const hit = hitUnion(parts, cam.eye, d);
    const o = (j * w + i) * 4;
    if (!hit) {
      const v = bg + (rnd() - 0.5) * 2 * noise;
      px[o] = v; px[o+1] = v; px[o+2] = v; px[o+3] = 255;
      depth[j*w+i] = NaN;
      continue;
    }
    mask[j*w+i] = 1;
    depth[j*w+i] = hit.p[2];
    const lam = Math.max(0, hit.n[0]*L[0] + hit.n[1]*L[1] + hit.n[2]*L[2]);
    const shade = 0.18 + 0.82 * lam;
    const a = albedo ? albedo(hit.p) : [0.62, 0.50, 0.42];
    px[o]   = 255 * a[0] * shade + (rnd() - 0.5) * 2 * noise;
    px[o+1] = 255 * a[1] * shade + (rnd() - 0.5) * 2 * noise;
    px[o+2] = 255 * a[2] * shade + (rnd() - 0.5) * 2 * noise;
    px[o+3] = 255;
  }
  return { px, w, h, mask, depth, cam, span };
}

// Ground-truth z extent of the solid along the ray through world (x, y), by
// dense sampling — used to score the reconstructed depth per column.
export function trueZSpan(x, y, parts = FIGURE, n = 512) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) {
    const z = -1 + 2 * (k + 0.5) / n;
    if (insideSolid(parts, x, y, z)) { if (z < lo) lo = z; if (z > hi) hi = z; }
  }
  return hi >= lo ? [lo, hi] : null;
}
