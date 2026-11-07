// Acceptance tests for the radius-propagation and segmentation rework.
//   node tools/test/atlas/acceptance.mjs
//
// No dependencies, no framework: the repo has neither and does not need either.
//
// Targets are EXACT GEOMETRY evaluated at the probe pixel's own centre, not the
// continuous half-width of the shape. A 12px-wide bar on an integer grid has no
// pixel centre on its axis, so its greatest achievable half-thickness is 5.5;
// scoring it against 6 would charge the algorithm for the sampling grid.
import { distanceTransform, subpixelSignedDistance, buildVolume, segment,
         surfaceNets, taubin, topology, backgroundModel, MAD_K,
         PRESETS } from '../../../src/atlas/atlas-core.js';
import * as S from './shapes.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${detail}`);
};

function volume(mask, w = S.W, h = S.H) {
  const dist = distanceTransform(mask, w, h, null);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < mask.length; i++) alpha[i] = mask[i];
  return buildVolume({ w, h, mask, dist, alpha }, PRESETS.balanced);
}
const pct = (got, want) => (got / want - 1) * 100;
const f = (v, n = 2) => v.toFixed(n).padStart(7);

// exact clearance of the RASTERISED region: distance from p to the nearest
// background pixel, treating pixels as unit squares
function rasterClearance(mask, px, py, w = S.W, h = S.H) {
  let best = Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x]) continue;
    const d = Math.hypot(Math.max(0, Math.abs(px - x - 0.5) - 0.5),
                         Math.max(0, Math.abs(py - y - 0.5) - 0.5));
    if (d < best) best = d;
  }
  return best;
}

/* ------------------------------------------------------------------ TASK 1 */
// rho = sqrt(u)/D is unbounded on nonconvex domains — for a two-disk union it
// grows like (R/delta)^(1/4) and first passes sqrt2 at a neck ~0.84 of the lobe
// radius. Clamping it to [1,sqrt2] over-thickened every waist. The radius is now
// the exact EDT on the medial axis, carried in geodesically.
function task1() {
  console.log('\nTASK 1 — waist half-thickness, two-disk unions');
  console.log('  R/delta   ideal   raster       A    vs raster   vs ideal');
  for (const ratio of [2, 4, 8, 30]) {
    const R = 60, delta = R / ratio, g = S.twoDisk(R, delta);
    const [px, py] = S.probeCentre(...g.waist);
    const ideal = S.twoDiskExactDist(R, delta, px, py);
    const raster = rasterClearance(g.mask, px, py);
    const A = S.at(volume(g.mask).A, ...g.waist);
    console.log(`  ${String(ratio).padStart(7)}  ${f(ideal)} ${f(raster)} ${f(A)}  ${f(pct(A, raster), 1)}%  ${f(pct(A, ideal), 1)}%`);
    // the algorithm must recover the clearance of the input it was handed
    ok(`waist R/delta=${ratio}: recovers raster clearance`, Math.abs(pct(A, raster)) < 3,
       `${pct(A, raster).toFixed(2)}%`);
  }
  // ...and must converge to the ideal continuous shape as the raster resolves it
  console.log('  convergence to the ideal shape as the neck is resolved (R/delta=30)');
  const errs = [];
  for (const s of [1, 2, 4]) {
    const W = 280 * s, H = 280 * s, R = 60 * s, dl = R / 30, c = R - dl, cx = W / 2, cy = H / 2;
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x + .5 - cx, dy = y + .5 - cy;
      m[y * W + x] = ((dx + c) ** 2 + dy ** 2 < R * R) || ((dx - c) ** 2 + dy ** 2 < R * R) ? 1 : 0;
    }
    const px = Math.round(cx - .5) + .5, py = Math.round(cy - .5) + .5;
    const ideal = S.twoDiskExactDist(R, dl, px, py, cx, cy);
    const A = volume(m, W, H).A[Math.round(cy - .5) * W + Math.round(cx - .5)];
    errs.push(Math.abs(pct(A, ideal)));
    console.log(`    neck ${String(dl).padStart(2)}px  err ${pct(A, ideal).toFixed(1)}%`);
  }
  ok('tight waist converges with resolution', errs[2] < errs[1] && errs[1] < errs[0] && errs[2] < 3,
     `${errs.map(e => e.toFixed(1) + '%').join(' -> ')}`);

  console.log('  convex regression (target = exact distance at the probe centre)');
  for (const [name, g, isSq] of [['disk R=60', S.disk(60), false], ['square a=60', S.square(60), true]]) {
    const [px, py] = S.probeCentre(...g.centre);
    const target = isSq ? S.rectExactDist(60, 60, 140, 140, px, py) : 60 - Math.hypot(px - 140, py - 140);
    const A = S.at(volume(g.mask).A, ...g.centre);
    console.log(`    ${name.padEnd(12)} A=${A.toFixed(2)}  target=${target.toFixed(2)}`);
    ok(`${name} within 1% of exact`, Math.abs(pct(A, target)) < 1, `${pct(A, target).toFixed(2)}%`);
  }
}

/* ------------------------------------------------------------------ TASK 2 */
// The radius field used unmasked box filters, so a thin part within ~20px of a
// thick one inherited the thick one's radius: +72/+48/+22/-1% at gaps 4/8/12/20.
// Geodesic propagation cannot make that mistake — the shortest in-mask path
// between two separate parts does not exist at all.
function task2() {
  console.log('\nTASK 2 — 6px limb beside a 34px torso  (was +72/+48/+22/-1%)');
  console.log('  gap    A_limb  target     err    A_torso     err');
  for (const gap of [4, 8, 12, 20]) {
    const g = S.torsoLimb(6, gap), vol = volume(g.mask);
    const [lx] = S.probeCentre(g.ax, 140), [tx] = S.probeCentre(90, 140);
    const aL = S.meanOver(vol.A, g.mask, (x, y) => Math.abs(x - lx) < 0.6 && y > 90 && y < 190);
    const aT = S.at(vol.A, 90, 140);
    const tL = 6 - Math.abs(lx - g.ax), tT = 34 - Math.abs(tx - 90);
    console.log(`  ${String(gap).padStart(3)}   ${f(aL)} ${f(tL)} ${f(pct(aL, tL), 1)}%  ${f(aT)} ${f(pct(aT, tT), 1)}%`);
    ok(`limb at gap ${gap}px within 5%`, Math.abs(pct(aL, tL)) < 5, `${pct(aL, tL).toFixed(2)}%`);
    ok(`torso at gap ${gap}px within 5%`, Math.abs(pct(aT, tT)) < 5, `${pct(aT, tT).toFixed(2)}%`);
  }
  console.log('  isolated limb sweep');
  let worst = 0;
  for (const a of [3, 4, 5, 6, 8, 10, 14, 20]) {
    const g = S.bar(a), [bx] = S.probeCentre(140, 140);
    const A = S.meanOver(volume(g.mask).A, g.mask, (x, y) => Math.abs(x - bx) < 0.6 && y > 90 && y < 190);
    const t = a - Math.abs(bx - 140);
    worst = Math.max(worst, Math.abs(pct(A, t)));
    console.log(`    a=${String(a).padStart(2)}  A=${A.toFixed(2)}  target=${t.toFixed(2)}  ${pct(A, t).toFixed(1)}%`);
  }
  ok('isolated-limb sweep 3–20px within 3%', worst < 3, `worst ${worst.toFixed(2)}%`);
}

/* ------------------------------------------------------------------ TASK 3 */
// Chebyshev erfc (Numerical Recipes erfcc), fractional error < 1.2e-7. The
// survival function has to be written with erfc rather than 1 − erf: at 5.5
// sigma the answer is ~1e-6, and 1 − erf cancels away every digit of it.
function erfc(x) {
  const z = Math.abs(x), t = 2 / (2 + z);
  const ans = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? ans : 2 - ans;
}
const chi3sf = (t) => erfc(t / Math.SQRT2) + t * Math.sqrt(2 / Math.PI) * Math.exp(-t * t / 2);

// mulberry32 + Box-Muller. The obvious LCG-plus-sum-of-12-uniforms shortcut is
// not good enough here: it yields chi_3 samples with median 1.5272 and MAD
// 0.4313 against true values of 1.5382 and 0.4602, which understates the
// threshold by 5% and makes a correctly calibrated estimator look miscalibrated.
let seed = 0x9E3779B9;
const rnd = () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const gauss = (sd) => sd * Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());

// chi_3 constants, exact to 4dp: median, and MAD about that median
const CHI3_MED = 1.5382, CHI3_MAD = 0.4602;

function task3() {
  console.log(`\nTASK 3 — border-frame threshold (median + ${MAD_K}·MAD)`);
  // The calibration constant is deterministic and is checked as such; the Monte
  // Carlo run below can only confirm the implementation realises it, to within
  // sampling noise. Testing a finite-sample threshold against an exact tail
  // probability would just be a flaky test.
  const nominal = CHI3_MED + MAD_K * CHI3_MAD;
  console.log(`  calibration: ${CHI3_MED} + ${MAD_K}x${CHI3_MAD} = ${nominal.toFixed(4)} sigma`);
  ok('MAD_K calibrates to a 1e-6 false-subject rate', chi3sf(nominal) <= 1.05e-6,
     `${chi3sf(nominal).toExponential(3)} per pixel`);

  for (const sigma of [4, 8]) {
    const row = [];
    for (const c of [0, 0.05, 0.10, 0.20, 0.30, 0.40]) {
      let acc = 0; const REP = 40;
      for (let k = 0; k < REP; k++) {
        const smp = [];
        for (let i = 0; i < 1116; i++) {
          const b = i < c * 1116 ? 90 : 0;
          smp.push([128 + b + gauss(sigma), 128 + gauss(sigma), 128 + gauss(sigma)]);
        }
        acc += backgroundModel(smp).thr;
      }
      row.push({ c, thr: acc / REP });
    }
    console.log(`  sigma=${sigma}/255  ` + row.map((r) => `${(r.c * 100).toFixed(0)}%:${r.thr.toFixed(4)}`).join('  '));
    let jump = 1;
    for (let i = 1; i < row.length; i++) jump = Math.max(jump, row[i].thr / row[i - 1].thr);
    ok(`sigma=${sigma}: smooth to 40% contamination`, jump < 1.6, `max step x${jump.toFixed(2)}`);
    ok(`sigma=${sigma}: estimator never saturates its ceiling`, row.every((r) => r.thr < 0.549),
       `max ${Math.max(...row.map((r) => r.thr)).toFixed(4)}`);
    const inSigma = row[0].thr * 255 / sigma;
    ok(`sigma=${sigma}: clean frame realises the calibration`, Math.abs(inSigma / nominal - 1) < 0.02,
       `${inSigma.toFixed(3)}sigma vs ${nominal.toFixed(3)} (${((inSigma / nominal - 1) * 100).toFixed(1)}%)`);
  }
  // End to end: a subject running off the bottom edge puts 12.3% of the border
  // frame inside the subject — over twice the old rule's 5% breakdown point.
  //
  // The contrast matters, and a high-contrast subject does NOT exercise this:
  // distance is the 3-channel norm, so a grey subject 90/255 from the background
  // sits at sqrt(3)*90/255 = 0.61, clear of even the old saturated 0.42 cap, and
  // both rules pass. At subject grey 115 the distance is 0.238 — above the robust
  // threshold (0.138) but below the saturated one, which is where the old rule
  // marked EVERY pixel in the frame as candidate background. The flood fill then
  // consumed the whole image, the mask collapsed, and the interior-hole fill
  // handed back a solid block covering the entire frame: 2.512x the true area.
  console.log('  end-to-end: low-contrast subject crossing the frame edge');
  const w = 160, h = 160, px = new Uint8ClampedArray(w * h * 4), lum = new Float32Array(w * h);
  let truth = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, subj = x > 40 && x < 120 && y > 30;
    if (subj) truth++;
    const v = (subj ? 115 : 150) + gauss(4);
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
    lum[i] = v / 255;
  }
  const seg = segment(px, lum, w, h, false);
  const ratio = seg.bounds.area / truth;
  console.log(`    recovered ${seg.bounds.area} px of ${truth} (thr=${seg.thr.toFixed(4)})`);
  ok('subject crossing the frame edge is retained', ratio > 0.9 && ratio < 1.15, `area ratio ${ratio.toFixed(3)}`);
}

/* ------------------------------------------------------------------ TASK 4 */
// Mesh topology, through the FULL pipeline. The suite had no topology coverage
// at all, which is how an unpruned medial axis shipping 544 non-manifold edges
// got onto main without a single test going red.
function figure(shoulder) {
  const w = 280, h = 380;
  const px = new Uint8ClampedArray(w * h * 4), lum = new Float32Array(w * h);
  const sh = {
    // three sharp wedges: a circle intersected with an annulus cut, which tapers
    // to a point where the two constraints meet
    knife:  (x, y) => Math.hypot(x - 140, y - 115) < 60 && Math.abs(x - 140) > 45 && y < 190,
    knife2: (x, y) => Math.hypot(x - 140, y - 112) < 62 && Math.abs(x - 140) > 48 && y < 190,
    knife3: (x, y) => Math.hypot(x - 140, y - 120) < 58 && Math.abs(x - 140) > 43 && y < 190,
    round:  (x, y) => Math.hypot(x - 140, y - 118) < 56 && y < 190,
  }[shoulder];
  const ins = (x, y) => Math.hypot(x - 140, y - 70) < 38
    || (Math.abs(x - 140) < 52 && y > 100 && y < 250)
    || (Math.abs(x - 140) < 18 && y >= 250 && y < 340) || sh(x, y)
    || (Math.abs(x - 200) < 13 && y > 120 && y < 240)
    || (Math.abs(x - 80) < 13 && y > 120 && y < 240);
  let truth = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, s = ins(x + 0.5, y + 0.5);
    if (s) truth++;
    const v = s ? 120 + 90 * Math.cos((x - 140) / 60) + gauss(3) : 232 + gauss(3);
    px[i * 4] = v; px[i * 4 + 1] = v * (s ? 0.93 : 1); px[i * 4 + 2] = v * (s ? 0.88 : 1);
    px[i * 4 + 3] = 255; lum[i] = v / 255;
  }
  return { px, lum, w, h, truth };
}

function task4() {
  console.log('\nTASK 4 — mesh topology through the full pipeline');
  console.log('  shoulder   preset      tris  nonman  shells  silhouette kept');
  for (const shoulder of ['knife', 'knife2', 'knife3', 'round']) {
    for (const preset of ['draft', 'balanced', 'archival']) {
      seed = 0x9E3779B9;
      const f = figure(shoulder);
      const r = reconstruct(f.px, f.lum, f.w, f.h, preset);
      console.log(`  ${shoulder.padEnd(10)} ${preset.padEnd(10)} ${String(r.topo.triangles).padStart(7)}` +
        ` ${String(r.topo.nonman).padStart(6)} ${String(r.topo.shells).padStart(6)}   ${(r.area / f.truth * 100).toFixed(2)}%`);
      ok(`${shoulder}/${preset} is watertight`, r.topo.watertight,
         `nonman ${r.topo.nonman}, boundary ${r.topo.boundary}`);
      ok(`${shoulder}/${preset} keeps >99% of the silhouette`, r.area / f.truth > 0.99,
         `${(r.area / f.truth * 100).toFixed(2)}%`);
    }
  }
}
function reconstruct(px, lum, w, h, preset) {
  const seg = segment(px, lum, w, h, false);
  const vol = buildVolume({ w, h, mask: seg.mask, dist: distanceTransform(seg.mask, w, h, seg.alpha),
                            alpha: seg.alpha }, PRESETS[preset]);
  const sn = surfaceNets(vol);
  const pos = new Float64Array(sn.pos), idx = new Int32Array(sn.idx);
  taubin(pos, idx, PRESETS[preset].smoothIters, 0.62, -0.64);
  const P = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) P[i] = pos[i];
  return { topo: topology(P, idx), area: seg.bounds.area };
}

/* -------------------------------------------------------------------- run */
task1(); task2(); task3(); task4();
const bad = results.filter((r) => !r.pass);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
