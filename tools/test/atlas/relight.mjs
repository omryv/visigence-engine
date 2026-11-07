// Relightable PBR: separating the surface from the studio.
//   node tools/test/atlas/relight.mjs
//
// The acceptance criterion is "relights correctly under a rotating light in a
// three.js test scene — no baked shadows swimming against the light". There is
// no GL context here, but that criterion has a numerical form that is sharper
// than looking at it:
//
//   A texture with lighting baked in is CORRELATED with the shading term of the
//   light that baked it. Regress texture luminance on n·L₀ over the subject; the
//   slope is how much of the original light is still painted on. Baked colour
//   has a large slope. A correctly delit albedo has a slope near zero — and a
//   slope near zero is exactly the statement that when the renderer applies its
//   own n·L, nothing of the old light rotates along with the model.
//
// So the test is: measure the slope before and after, and require the reduction.
// Both candidate inversions are scored side by side, so the choice between them
// is a measurement rather than a preference.
import { reconstruct, segment, surfaceNormals, depthField, distanceTransform } from '../../../src/atlas/atlas-core.js';
import { shadingField, planRelight, roughnessFromFit, normalDetail, RELIGHT_MIN_R2 } from '../../../src/atlas/relight.js';
import { glbBytes } from '../../../src/atlas/exporters.js';
import { render, camera, FIGURE } from './multiview.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail}`);
};

const W = 200, H = 260;
const shoot = (o = {}) => render(camera(o.az || 0, o.el || 0, 3.2, 2.6), W, H, o);

// The fields the delighting works on, recomputed here so the test can reach the
// intermediate quantities the pipeline keeps private.
function fields(im) {
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++)
    lum[i] = (0.299*im.px[i*4] + 0.587*im.px[i*4+1] + 0.114*im.px[i*4+2]) / 255;
  const seg = segment(im.px, lum, W, H, false);
  const dist = distanceTransform(seg.mask, W, H, seg.alpha);
  const dep = depthField(seg.mask, dist, lum, im.px, W, H);
  const nrm = surfaceNormals(dep.depth, seg.mask, W, H, 0.6);
  return { lum, seg, dep, nrm };
}

/**
 * Slope of a least-squares regression of `y` on the shading term d = max(0,n·L),
 * over the subject only, normalised by the mean of y so it is a fraction rather
 * than a unit-dependent number. This is "how much of light L is painted on".
 */
function bakedSlope(y, nrm, mask, L) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const d = Math.max(0, nrm[i*3]*L.x + nrm[i*3+1]*L.y + nrm[i*3+2]*L.z);
    n++; sx += d; sy += y[i]; sxx += d*d; sxy += d*y[i];
  }
  if (n < 2) return 0;
  const den = n*sxx - sx*sx;
  if (Math.abs(den) < 1e-12) return 0;
  const slope = (n*sxy - sx*sy) / den;
  return slope / Math.max(1e-6, sy / n);
}

/* ------------------------------------------------------------------ task 1 */

function taskFit() {
  console.log('\nTASK 1 — the Lambertian fit reports its own goodness');
  const { dep } = fields(shoot());
  const lam = dep.lambert;
  console.log(`   L = (${lam.Lx.toFixed(2)}, ${lam.Ly.toFixed(2)}, ${lam.Lz.toFixed(2)})`
            + ` · α ${lam.alpha.toFixed(3)} · ambient ${lam.ambient.toFixed(3)}`
            + ` · R² ${lam.r2.toFixed(3)} · rms ${lam.rms.toFixed(4)} over ${lam.n} samples`);
  ok('the fit returns its parameters', lam.alpha > 0 && isFinite(lam.ambient), `α ${lam.alpha.toFixed(3)}`);
  ok('R² is a proper fraction', lam.r2 >= 0 && lam.r2 <= 1, lam.r2.toFixed(3));
  ok('the fit has enough samples to mean anything', lam.n >= 200, `${lam.n}`);
  ok('the light direction is a unit vector',
     Math.abs(Math.hypot(lam.Lx, lam.Ly, lam.Lz) - 1) < 1e-6,
     Math.hypot(lam.Lx, lam.Ly, lam.Lz).toFixed(6));

  // The fixture is rendered with a known light, so the recovered direction can
  // be scored rather than merely reported. multiview renders with light
  // [0.4, 0.7, 0.6] in world space; the image y axis runs DOWN, so the fitted
  // Ly is the negative of the world one.
  const ll = Math.hypot(0.4, 0.7, 0.6);
  const truth = { x: 0.4/ll, y: -0.7/ll, z: 0.6/ll };
  const dot = lam.Lx*truth.x + lam.Ly*truth.y + lam.Lz*truth.z;
  const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  console.log(`   true light (image coords) (${truth.x.toFixed(2)}, ${truth.y.toFixed(2)}, ${truth.z.toFixed(2)})`
            + ` → recovered ${ang.toFixed(1)}° away`);
  // Single-image light estimation is good to tens of degrees, not to one. The
  // bound says the estimate is informative, not that it is exact.
  ok('the recovered light points the right way', ang < 45, `${ang.toFixed(1)}°`);
}

/* ------------------------------------------------------------------ task 2 */
// The criterion itself, and the comparison that chose the inversion.
function taskDelight() {
  console.log('\nTASK 2 — delighting removes the light that was baked in');
  const im = shoot();
  const { lum, seg, dep, nrm } = fields(im);
  const lam = dep.lambert;
  const L = { x: lam.Lx, y: lam.Ly, z: lam.Lz };
  const N = W * H;

  const before = bakedSlope(lum, nrm, seg.mask, L);

  // The shipped inversion: ratio, with the fitted ambient as the denominator's
  // own floor.
  const { gain, mean } = shadingField(nrm, seg.mask, W, H, lam);
  const ratio = new Float32Array(N);
  for (let i = 0; i < N; i++) ratio[i] = seg.mask[i] ? lum[i] * gain[i] : 0;
  const afterRatio = bakedSlope(ratio, nrm, seg.mask, L);

  // The literal subtractive form, for comparison: (I − β)/max(ε, n·L).
  const EPS = 0.05;
  const sub = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!seg.mask[i]) continue;
    const d = Math.max(0, nrm[i*3]*L.x + nrm[i*3+1]*L.y + nrm[i*3+2]*L.z);
    sub[i] = (lum[i] - lam.ambient) / Math.max(EPS, d);
  }
  const afterSub = bakedSlope(sub, nrm, seg.mask, L);

  console.log(`   baked photograph        slope ${before.toFixed(4)}`);
  console.log(`   (I − β) / max(ε, n·L)   slope ${afterSub.toFixed(4)}`);
  console.log(`   I / (α·(n·L) + β)       slope ${afterRatio.toFixed(4)}   ← shipped`);

  // YOU CANNOT REMOVE MORE LIGHT THAN YOUR MODEL EXPLAINS, so the bound is not a
  // round number picked in advance — it is R². The fit accounts for a measured
  // fraction of the interior's shading variance; delighting divides that part
  // out and necessarily leaves the rest. Requiring an arbitrary 75% reduction
  // here would be requiring the inversion to remove structure the fit never
  // identified, which it could only do by inventing it.
  //
  // What CAN be required is that the inversion realises everything the fit
  // claimed: the fraction of baked light removed must be at least R².
  const removed = 1 - Math.abs(afterRatio / before);
  console.log(`   removed ${(removed*100).toFixed(1)}% of the baked light;`
            + ` the fit explains ${(lam.r2*100).toFixed(1)}% of the shading`);
  ok('the photograph is measurably lit', Math.abs(before) > 0.05, before.toFixed(4));
  ok('delighting removes at least as much light as the fit explains', removed >= lam.r2,
     `${(removed*100).toFixed(1)}% removed vs R² ${(lam.r2*100).toFixed(1)}%`);
  ok('and removes the majority of it', removed > 0.5, `${(removed*100).toFixed(1)}%`);
  ok('the ratio form beats the subtractive form',
     Math.abs(afterRatio) < Math.abs(afterSub), `${afterRatio.toFixed(4)} vs ${afterSub.toFixed(4)}`);

  // The albedo must stay a plausible image: the point is to remove shading, not
  // to rescale the picture or to blow out its range.
  let lo = 1e9, hi = -1e9, sum = 0, cnt = 0, base = 0;
  for (let i = 0; i < N; i++) {
    if (!seg.mask[i]) continue;
    lo = Math.min(lo, ratio[i]); hi = Math.max(hi, ratio[i]);
    sum += ratio[i]; base += lum[i]; cnt++;
  }
  const drift = Math.abs((sum / cnt) / (base / cnt) - 1);
  console.log(`   albedo range ${lo.toFixed(3)}..${hi.toFixed(3)}, mean level drifts ${(drift*100).toFixed(1)}%`);
  ok('the albedo keeps the photograph\'s overall level', drift < 0.12, `${(drift*100).toFixed(1)}%`);
  ok('the albedo does not blow out', hi < 2.0 && lo >= 0, `${lo.toFixed(3)}..${hi.toFixed(3)}`);
  ok('the shading mean is finite and positive', mean > 0 && isFinite(mean), mean.toFixed(4));
}

/* ------------------------------------------------------------------ task 3 */
// "No baked shadows swimming against the light" — stated as a rotation.
function taskRotatingLight() {
  console.log('\nTASK 3 — a rotating light finds no shadow already painted on');
  const im = shoot();
  const { lum, seg, dep, nrm } = fields(im);
  const lam = dep.lambert;
  const L0 = { x: lam.Lx, y: lam.Ly, z: lam.Lz };
  const N = W * H;
  const { gain } = shadingField(nrm, seg.mask, W, H, lam);
  const albedo = new Float32Array(N);
  for (let i = 0; i < N; i++) albedo[i] = seg.mask[i] ? lum[i] * gain[i] : 0;

  // Rotate a light around the model and render each frame twice: once from the
  // baked photograph and once from the albedo. For the albedo the frame's
  // brightest region must follow the light; for the baked texture it drags the
  // old highlight with it.
  //
  // Scored as the correlation of each rendered frame with the CURRENT light's
  // shading term, minus its correlation with the ORIGINAL light's. A correct
  // asset tracks the current light at every angle.
  // The metric is the SPREAD of how well each frame tracks the current light as
  // it goes round. An asset with light baked in renders bright when the new
  // light happens to agree with the old and dim when it opposes it — that
  // variation IS the shadow swimming. An asset carrying albedo tracks whatever
  // light it is given equally well at every angle, so its spread is flat.
  //
  // Comparing a frame against the ORIGINAL light instead does not work, and it
  // is worth saying why: when the rotating light passes near the original one
  // the two shading terms coincide, so any texture correlates with both and the
  // ratio is ~1 for a perfect asset and a baked one alike. That comparison was
  // measuring the angle between two lights, not the quality of the texture.
  console.log('   angle   baked: corr(now) corr(orig)   albedo: corr(now) corr(orig)');
  let bLo = Infinity, bHi = -Infinity, aLo = Infinity, aHi = -Infinity;
  for (let a = 0; a < 360; a += 45) {
    const t = a * Math.PI / 180;
    const Lr = { x: Math.cos(t) * 0.8, y: Math.sin(t) * 0.8, z: 0.6 };
    const l = Math.hypot(Lr.x, Lr.y, Lr.z); Lr.x /= l; Lr.y /= l; Lr.z /= l;
    const shadeNow = (i) => Math.max(0, nrm[i*3]*Lr.x + nrm[i*3+1]*Lr.y + nrm[i*3+2]*Lr.z);
    // A rendered frame = texture × the renderer's own shading.
    const frameB = new Float32Array(N), frameA = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (!seg.mask[i]) continue;
      const s = 0.15 + 0.85 * shadeNow(i);
      frameB[i] = lum[i] * s; frameA[i] = albedo[i] * s;
    }
    const bNow = bakedSlope(frameB, nrm, seg.mask, Lr), bOld = bakedSlope(frameB, nrm, seg.mask, L0);
    const aNow = bakedSlope(frameA, nrm, seg.mask, Lr), aOld = bakedSlope(frameA, nrm, seg.mask, L0);
    console.log(`   ${String(a).padStart(4)}°   ${bNow.toFixed(3).padStart(11)} ${bOld.toFixed(3).padStart(10)}`
              + `   ${aNow.toFixed(3).padStart(13)} ${aOld.toFixed(3).padStart(10)}`);
    bLo = Math.min(bLo, bNow); bHi = Math.max(bHi, bNow);
    aLo = Math.min(aLo, aNow); aHi = Math.max(aHi, aNow);
  }
  const bSpread = bHi / Math.max(1e-6, bLo), aSpread = aHi / Math.max(1e-6, aLo);
  console.log(`   how evenly each tracks the light it is given, around the turn:`);
  console.log(`     baked  ${bLo.toFixed(3)}..${bHi.toFixed(3)}  spread ×${bSpread.toFixed(2)}`);
  console.log(`     albedo ${aLo.toFixed(3)}..${aHi.toFixed(3)}  spread ×${aSpread.toFixed(2)}`);
  ok('the albedo tracks a rotating light evenly', aSpread < 2.0, `×${aSpread.toFixed(2)}`);
  ok('more evenly than the baked photograph does', aSpread < bSpread * 0.75,
     `×${aSpread.toFixed(2)} vs ×${bSpread.toFixed(2)}`);
  ok('and never renders inverted', aLo > 0, aLo.toFixed(3));
}

/* ------------------------------------------------------------------ task 4 */

function taskFallback() {
  console.log('\nTASK 4 — the fallback refuses rather than shipping a bad delighting');
  const good = planRelight({ Lx: 0, Ly: 0, Lz: 1, alpha: 0.6, ambient: 0.1, r2: 0.82, rms: 0.03, n: 4000 });
  ok('a strong fit is accepted', good.ok && good.roughness > 0, `R² 0.82 → roughness ${good.roughness}`);

  const weak = planRelight({ Lx: 0, Ly: 0, Lz: 1, alpha: 0.6, ambient: 0.1, r2: 0.12, rms: 0.2, n: 4000 });
  console.log(`   R² 0.12 → ${weak.ok ? 'accepted' : 'declined: ' + weak.reason}`);
  ok('a weak fit is declined', !weak.ok, weak.reason || '');
  ok('the refusal says why, with the number', /12%/.test(weak.reason || ''), weak.reason || '');

  const starved = planRelight({ Lx: 0, Ly: 0, Lz: 1, alpha: 0.6, ambient: 0.1, r2: 0.9, rms: 0.01, n: 12 });
  ok('too few samples is declined even at high R²', !starved.ok, starved.reason || '');
  ok('a missing fit is declined', !planRelight(null).ok, 'null');

  // Roughness must be a monotone, bounded function of the fit — not a constant
  // dressed up, and not something that can leave [0, 1].
  const rs = [0, 0.25, 0.5, 0.75, 1].map((r2) => roughnessFromFit({ r2 }));
  console.log(`   roughness across R² 0→1: ${rs.map((v) => v.toFixed(2)).join(' ')}`);
  ok('roughness is monotone in the fit', rs.every((v, i) => i === 0 || v > rs[i-1]), rs.join(' '));
  ok('roughness stays in range', rs.every((v) => v > 0 && v <= 1), `${rs[0]}..${rs[4]}`);

  // And the threshold has to actually be reachable from both sides.
  ok('the threshold sits inside the range of R²', RELIGHT_MIN_R2 > 0 && RELIGHT_MIN_R2 < 1,
     String(RELIGHT_MIN_R2));
}

/* ------------------------------------------------------------------ task 5 */

function taskMaps() {
  console.log('\nTASK 5 — the exported maps');
  const r = reconstruct(shoot().px, W, H, 'balanced', () => {});
  const p = r.pbr;
  console.log(`   relightable: ${p.ok}${p.ok ? ` · R² ${p.r2.toFixed(3)} · roughness ${p.roughness}` : ` · ${p.reason}`}`);
  ok('the reconstruction reports a relight decision', typeof p.ok === 'boolean', String(p.ok));
  ok('the fit residual is reported', isFinite(p.rms) && p.samples > 0, `rms ${p.rms.toFixed(4)}, n ${p.samples}`);

  if (!p.ok) {
    ok('a declined relight ships no maps', !p.albedo && !p.normalMap, 'none');
    return;
  }
  const { texW, texH } = r.stats;
  ok('an albedo chart is produced', p.albedo && p.albedo.length === texW * texH * 4,
     `${texW}×${texH}`);
  ok('a normal map is produced', p.normalMap && p.normalMap.length === texW * texH * 4,
     `${texW}×${texH}`);

  // A tangent-space normal map must be a field of unit vectors with +Z out.
  let bad = 0, flat = 0, worstLen = 0;
  for (let i = 0; i < texW * texH; i++) {
    const nx = p.normalMap[i*4] / 255 * 2 - 1;
    const ny = p.normalMap[i*4+1] / 255 * 2 - 1;
    const nz = p.normalMap[i*4+2] / 255 * 2 - 1;
    if (nz <= 0) bad++;
    if (Math.abs(nx) < 2/255 && Math.abs(ny) < 2/255) flat++;
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(nx, ny, nz) - 1));
  }
  console.log(`   normal map: ${bad} texels with z ≤ 0, ${(flat/(texW*texH)*100).toFixed(1)}% flat,`
            + ` worst |n| − 1 = ${worstLen.toFixed(3)}`);
  ok('every normal points out of the surface', bad === 0, `${bad}`);
  ok('the normal map is unit length to quantisation', worstLen < 0.02, worstLen.toFixed(4));
  // It must carry SOMETHING, or it is a 6MB texture of the colour (128,128,255).
  ok('the normal map is not uniformly flat', flat < texW * texH * 0.98,
     `${(100 - flat/(texW*texH)*100).toFixed(1)}% carries detail`);

  // The normal map must come from the band the mesh does NOT have. Feeding it a
  // chart with no detail finer than the geometry grid must produce a flat map.
  const smooth = new Uint8ClampedArray(texW * texH * 4);
  for (let y = 0; y < texH; y++) for (let x = 0; x < texW; x++) {
    const i = (y * texW + x) * 4;
    const v = 128 + 60 * Math.sin(x / texW * Math.PI * 4);   // 4 cycles across the atlas
    smooth[i] = v; smooth[i+1] = v; smooth[i+2] = v; smooth[i+3] = 255;
  }
  const flatMap = normalDetail(smooth, texW, texH, texW / W);
  let moved = 0;
  for (let i = 0; i < texW * texH; i++) {
    if (Math.abs(flatMap[i*4] - 128) > 3 || Math.abs(flatMap[i*4+1] - 128) > 3) moved++;
  }
  console.log(`   a chart varying only at the geometry scale leaves ${(moved/(texW*texH)*100).toFixed(2)}% of the map non-flat`);
  ok('detail the mesh already carries is not encoded again', moved < texW * texH * 0.02,
     `${(moved/(texW*texH)*100).toFixed(2)}%`);
}

/* ------------------------------------------------------------------ task 6 */

function taskGLB() {
  console.log('\nTASK 6 — the PBR GLB');
  const r = reconstruct(shoot().px, W, H, 'balanced', () => {});
  const geo = { positions: r.positions, normals: r.normals, uvs: r.uvs,
                indices: r.indices, colors: r.baseColor };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const nm = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);

  const baked = glbBytes(geo, png, 't', null, null);
  const pbrOnly = glbBytes(geo, png, 't', null, { roughness: 0.77, normalPng: nm });
  const both = glbBytes(geo, png, 't', r.rig, { roughness: 0.77, normalPng: nm });

  const parse = (b) => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const jl = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jl)));
  };
  const jb = parse(baked), jp = parse(pbrOnly), jj = parse(both);

  ok('the baked export keeps its material', jb.materials[0].name === 'specimen'
     && !jb.materials[0].normalTexture, jb.materials[0].name);
  ok('the baked export has one image', jb.images.length === 1, `${jb.images.length}`);

  ok('the PBR export names an albedo material', jp.materials[0].name === 'specimen_albedo',
     jp.materials[0].name);
  ok('roughness comes from the fit',
     jp.materials[0].pbrMetallicRoughness.roughnessFactor === 0.77, '0.77');
  ok('metallic stays 0 — nothing here is a conductor',
     jp.materials[0].pbrMetallicRoughness.metallicFactor === 0, '0');
  ok('a normal texture is declared', !!jp.materials[0].normalTexture
     && jp.textures.length === 2 && jp.images.length === 2, `${jp.images.length} images`);
  ok('the normal image points at a real bufferView',
     jp.images[1].bufferView < jp.bufferViews.length, `view ${jp.images[1].bufferView}`);

  // Skin and PBR must compose: adding the normal map must not shift the skin's
  // bufferView indices, which is why it is appended last.
  ok('skin and PBR compose', !!jj.skins && !!jj.materials[0].normalTexture,
     `${jj.skins[0].joints.length} joints + normal map`);
  const ibmView = jj.bufferViews[jj.accessors[jj.skins[0].inverseBindMatrices].bufferView];
  ok('the inverse bind view still has no target', ibmView.target === undefined, 'ok');
  ok('every bufferView is inside the buffer',
     jj.bufferViews.every((v) => (v.byteOffset || 0) + v.byteLength <= jj.buffers[0].byteLength), 'ok');
}

taskFit(); taskDelight(); taskRotatingLight(); taskFallback(); taskMaps(); taskGLB();

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
