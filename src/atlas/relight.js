/* Atlas — separating what the surface IS from how it was lit.
 *
 * The exported atlas is a photograph. It carries the studio's light baked into
 * it, so the model arrives in a scene already lit by somewhere else: put it
 * under a lamp on the left and the highlight stays on the right, and turning it
 * turns the shading with it. That is the single thing that stops the output
 * being usable as an asset.
 *
 * depthField already fits a Lambertian model to the interior — contour-tangency
 * azimuth by 3×3 normal equations, then a 25-point slant sweep with an
 * albedo/ambient regression minimising SSE. It is the one estimate in the
 * pipeline that was already rigorous, so this file divides by it rather than
 * replacing it.
 *
 * WHY THIS IS BETTER POSED HERE THAN IT USUALLY IS
 *
 * Intrinsic decomposition on a flat image is famously ill-posed: a dark pixel
 * may be dark paint or a dark corner and nothing in the image says which. Here
 * the geometry has already been reconstructed, so n is KNOWN at every texel, and
 * the shading term is not a free field to be guessed — it is evaluated. What is
 * left ill-posed is only the split of detail finer than the geometry grid, and
 * that is stated rather than resolved (see `normalDetail`).
 *
 * WHY THE INVERSION IS A RATIO AND NOT A SUBTRACTION — a deviation, stated.
 *
 * The obvious inversion of I = α·max(0, n·L) + β is
 *
 *     albedo = (I − β) ∕ max(ε, n·L)
 *
 * and it divides by a quantity that goes to zero. n·L → 0 all along the
 * terminator, and this reconstruction has an unusually large band where it does:
 * the shell closes at the silhouette, so a wide rim of every model is exactly
 * the surface facing away from the light. There ε — an arbitrary floor — decides
 * the albedo of the whole rim, and the result is a bright halo wherever the
 * subject curves away.
 *
 * The physical model has a floor already in it. Ambient light illuminates the
 * surface, so it multiplies albedo rather than adding beside it:
 *
 *     I = ρ · (α·max(0, n·L) + β)      →      ρ = I ∕ max(floor, α·max(0,n·L) + β)
 *
 * Same two fitted parameters, same fit; β is now the denominator's own floor and
 * ε is not needed. Measured on the test figure, the subtractive form leaves the
 * delit atlas correlated with the original light at slope 0.29 and the ratio
 * form at 0.02 — both in `tools/test/atlas/relight.mjs`, which scores them side by side so
 * the choice is a measurement rather than a preference.
 */

// Below this R² the single-light Lambertian model is not explaining the
// subject, and dividing by it would carve its own errors into the albedo. The
// export falls back to baked colour and says so.
//
// Set where the two failure modes cross rather than by taste: a subject the
// model explains well scores 0.7–0.95, and the delighting is a clear
// improvement; below about 0.35 the residual is comparable to the signal and
// what comes out is the model's mistakes with the photograph's texture on top.
export const RELIGHT_MIN_R2 = 0.35;

// Denominator floor, as a fraction of the fitted ambient. Ambient is the light
// that reaches a surface facing away, so it is the physical floor; this only
// guards a fit that returned an ambient of nearly zero.
const SHADE_FLOOR_FRAC = 0.35;
const SHADE_FLOOR_ABS = 0.04;

// How far the albedo is allowed to move from the photograph. Delighting is a
// division, and a division by a small number is a large multiplication: this
// bounds what one bad normal at one texel can do to the exported colour.
const GAIN_MIN = 0.35;
const GAIN_MAX = 2.8;

/**
 * The shading the fitted model predicts, per pixel of the working grid.
 *
 * @param {Float32Array} nrm  3 per pixel, the reconstructed surface normals
 * @param {Uint8Array} mask
 * @param {object} lambert    from depthField: {Lx, Ly, Lz, alpha, ambient}
 * @returns {Float32Array} shade, and the gain 1/shade that delighting applies
 */
export function shadingField(nrm, mask, w, h, lambert) {
  const N = w * h;
  const shade = new Float32Array(N), gain = new Float32Array(N);
  const floor = Math.max(SHADE_FLOOR_ABS, SHADE_FLOOR_FRAC * lambert.ambient);
  // Mean shading over the subject, so the delit atlas keeps the photograph's
  // overall level instead of being divided down to a fraction of it. Without
  // this the albedo comes out uniformly darker or brighter than the source by
  // whatever the mean of the shading happened to be, which is a change nobody
  // asked for and which shows up immediately against an unlit reference.
  let sum = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) { shade[i] = 1; gain[i] = 1; continue; }
    const d = Math.max(0, nrm[i*3] * lambert.Lx + nrm[i*3+1] * lambert.Ly + nrm[i*3+2] * lambert.Lz);
    const s = Math.max(floor, lambert.alpha * d + lambert.ambient);
    shade[i] = s; sum += s; cnt++;
  }
  const mean = cnt ? sum / cnt : 1;
  for (let i = 0; i < N; i++) {
    gain[i] = mask[i] ? Math.max(GAIN_MIN, Math.min(GAIN_MAX, mean / shade[i])) : 1;
  }
  return { shade, gain, mean, floor };
}

/**
 * Divide an atlas chart by the shading, in place on a copy.
 *
 * The gain is sampled from the working grid and the colour from the full-
 * resolution chart, which is the whole point: shading is low frequency and the
 * geometry grid resolves it, while the albedo detail worth keeping is finer than
 * that grid and lives only in the source.
 *
 * @param {Uint8ClampedArray} px  RGBA chart at atlas resolution
 * @param {Float32Array} gain     working-grid gain from shadingField
 * @param {function} map          (u, v) → [gx, gy] in working-grid coordinates
 */
export function delightChart(px, aw, ah, gain, gw, gh, map) {
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    const o = (y * aw + x) * 4;
    const [gx, gy] = map((x + 0.5) / aw, (y + 0.5) / ah);
    const g = bilinear(gain, gw, gh, gx - 0.5, gy - 0.5);
    out[o]   = px[o]   * g;
    out[o+1] = px[o+1] * g;
    out[o+2] = px[o+2] * g;
    out[o+3] = px[o+3];
  }
  return out;
}

function bilinear(f, w, h, x, y) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const a = f[y0*w+x0] * (1-fx) + f[y0*w+x1] * fx;
  const b = f[y1*w+x0] * (1-fx) + f[y1*w+x1] * fx;
  return a * (1-fy) + b * fy;
}

/**
 * A tangent-space normal map carrying ONLY the detail the mesh could not.
 *
 * This needs saying plainly, because a normal map is the easiest place in a PBR
 * export to ship something invented. The relief step already displaces the
 * surface by band-limited shading detail measured on the WORKING GRID — 280px at
 * balanced — and that detail is in the geometry and in the vertex normals. Re-
 * encoding it here would apply it twice.
 *
 * What is genuinely missing is the band between the working grid and the atlas:
 * the source is sampled at 1280px, so there is real shading structure four to
 * five times finer than anything the mesh can represent. That band, and only
 * that band, is what this encodes.
 *
 * It is still a choice, not a measurement. Detail at that scale is ambiguous
 * between albedo and relief — a dark line may be a groove or a drawn line, and
 * one image cannot separate them. This assigns it to relief in the normal map
 * while leaving it in the albedo, which double-counts it; the alternative
 * assigns it to neither. The amplitude is therefore kept small (`AMP`) so the
 * map reads as surface tooth rather than as geometry, and the export says the
 * map is derived, not observed.
 *
 * @param {Uint8ClampedArray} px  the delit chart, RGBA at atlas resolution
 * @param {number} scale  atlas pixels per working-grid pixel; the band starts here
 */
export function normalDetail(px, aw, ah, scale) {
  const N = aw * ah;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = (0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2]) / 255;
  // Low-pass at the working grid's own scale; the residual is the band the mesh
  // never saw. Radius is in atlas pixels and is half the working-grid pitch,
  // which is that grid's Nyquist.
  const rad = Math.max(1, Math.round(scale * 0.5));
  const lo = boxBlur2(lum, aw, ah, rad, 2);
  const hi = new Float32Array(N);
  for (let i = 0; i < N; i++) hi[i] = lum[i] - lo[i];

  // Slope from the residual, then the standard tangent-space encoding
  // n = normalize(−∂h/∂u, −∂h/∂v, 1). Height is AMP × the residual, so AMP is
  // in the same units as luminance and the slope stays bounded.
  const AMP = 2.2;
  const out = new Uint8ClampedArray(N * 4);
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    const i = y * aw + x;
    const xl = x > 0 ? i - 1 : i, xr = x < aw - 1 ? i + 1 : i;
    const yu = y > 0 ? i - aw : i, yd = y < ah - 1 ? i + aw : i;
    let nx = -AMP * (hi[xr] - hi[xl]) * 0.5;
    let ny = -AMP * (hi[yd] - hi[yu]) * 0.5;
    // Image rows run downward and the tangent-space green channel runs upward
    // (glTF uses OpenGL convention), so v is flipped here rather than in the
    // exporter, where it would be invisible.
    ny = -ny;
    const l = Math.hypot(nx, ny, 1);
    out[i*4]   = Math.round((nx / l * 0.5 + 0.5) * 255);
    out[i*4+1] = Math.round((ny / l * 0.5 + 0.5) * 255);
    out[i*4+2] = Math.round((1  / l * 0.5 + 0.5) * 255);
    out[i*4+3] = 255;
  }
  return out;
}

function boxBlur2(f, w, h, rad, passes) {
  let a = Float32Array.from(f);
  const t = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -rad; x <= rad; x++) acc += a[row + Math.max(0, Math.min(w-1, x))];
      for (let x = 0; x < w; x++) {
        t[row + x] = acc / (2*rad + 1);
        acc -= a[row + Math.max(0, Math.min(w-1, x - rad))];
        acc += a[row + Math.max(0, Math.min(w-1, x + rad + 1))];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -rad; y <= rad; y++) acc += t[Math.max(0, Math.min(h-1, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y*w + x] = acc / (2*rad + 1);
        acc -= t[Math.max(0, Math.min(h-1, y - rad)) * w + x];
        acc += t[Math.max(0, Math.min(h-1, y + rad + 1)) * w + x];
      }
    }
  }
  return a;
}

/**
 * Roughness, as one number and honestly so.
 *
 * A per-texel roughness map would need the specular lobe separated from the
 * diffuse one, and one photograph under one unknown light does not carry that.
 * What the fit does say is how far the subject departs from ideal Lambertian:
 * R² near 1 is a matte surface the model explains, and a lower R² means energy
 * the diffuse term could not account for — which on a real subject is usually
 * specular. So the residual maps to a roughness FACTOR, monotonically, and no
 * map is written.
 */
export function roughnessFromFit(lambert) {
  const r2 = Math.max(0, Math.min(1, lambert.r2));
  // 0.86 is the pipeline's long-standing matte default and stays the answer for
  // a well-explained subject; a poorly explained one reads shinier.
  return +(0.50 + 0.36 * r2).toFixed(3);
}

/**
 * Everything the PBR export needs, or an explicit refusal.
 *
 * Returns `{ ok: false, reason }` when the fit is too weak to divide by. The
 * caller then ships baked colour, and the panel says the asset is not
 * relightable and why — which is the point: an asset that claims to be
 * relightable and is not costs more than one that says it is baked.
 */
export function planRelight(lambert) {
  if (!lambert || !isFinite(lambert.r2) || lambert.n < 200) {
    return { ok: false, r2: 0, reason: 'too few interior samples to fit a light' };
  }
  if (lambert.r2 < RELIGHT_MIN_R2) {
    return { ok: false, r2: lambert.r2,
             reason: `one distant light explains only ${Math.round(lambert.r2*100)}% of the`
                   + ` subject's shading (needs ${Math.round(RELIGHT_MIN_R2*100)}%)` };
  }
  return { ok: true, r2: lambert.r2, roughness: roughnessFromFit(lambert), reason: null };
}
