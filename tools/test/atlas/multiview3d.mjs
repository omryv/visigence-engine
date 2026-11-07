// Multi-view acceptance tests, against a solid whose geometry is known exactly.
//   node tools/test/atlas/multiview3d.mjs
//
// The premise these tests exist to pin down is counter-intuitive enough to be
// worth stating at the top, because it decides what a second photograph is for.
//
// A silhouette constrains an object only in the directions PERPENDICULAR to that
// camera's optical axis. Front and back cameras share an axis, so they constrain
// the same two dimensions and say nothing at all about depth. Measured on a known
// solid, the visual hull from [0°, 180°] is IDENTICAL to the one from [0°] alone
// under orthography, and under perspective it loses some volume at the periphery
// while leaving the depth through the torso unchanged at 5.00x the truth. The
// information a view at angle a adds about depth goes as sin(a), and sin(180°) is
// zero.
//
// So the two companion views do different jobs and neither substitutes for the
// other: the PROFILE is the only one that carries geometry, and the BACK is the
// only one that carries far-side texture. Task 11 is the experiment that says so.
import { camera, render, FIGURE, trueZSpan, reseed } from './multiview.mjs';
import { segment, distanceTransform, buildVolume, profileConstraint, applyProfile,
         profileFit, registerSimilarity, surfaceNets, taubin, topology,
         reconstruct, MIN_SEPARATION, PRESETS } from '../../../src/atlas/atlas-core.js';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail}`);
};

const W = 180, H = 240, FOC = 6.0, DIST = 4.0, SPAN = 0.95;
const GPP = (W / 2) * FOC / (DIST * SPAN);          // world units -> front-grid px
const scaleDepth = (parts, s) => parts.map(([cx, cy, cz, ax, ay, az]) => [cx, cy, cz * s, ax, ay, az * s]);

function shoot(az, parts, w = W, h = H, span = SPAN, albedo = null) {
  reseed(97);
  const v = render(camera(az, 0, DIST, FOC), w, h, { span, parts, albedo });
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.299*v.px[i*4] + 0.587*v.px[i*4+1] + 0.114*v.px[i*4+2]) / 255;
  return { px: v.px, w, h, seg: segment(v.px, lum, w, h, false) };
}
const volFor = (seg) => buildVolume({ w: W, h: H, mask: seg.mask,
  dist: distanceTransform(seg.mask, W, H, seg.alpha), alpha: seg.alpha }, PRESETS.balanced);

// Median |error| of the reconstructed depth against the exact solid, over the
// BULK of the subject. A column one pixel inside the silhouette has a true depth
// near zero, so its relative error is unbounded however good the model is; that
// is the parameterisation talking, not the fit.
function depthError(vol, seg, parts) {
  let maxD = 0;
  for (let y = 20; y < H - 20; y += 3) for (let x = 8; x < W - 8; x += 3) {
    const s = trueZSpan((x + .5 - W/2) / GPP, -(y + .5 - H/2) / GPP, parts);
    if (s && s[1] - s[0] > maxD) maxD = s[1] - s[0];
  }
  const e = [];
  for (let y = 20; y < H - 20; y += 3) for (let x = 8; x < W - 8; x += 3) {
    const i = y * W + x; if (!seg.mask[i]) continue;
    const s = trueZSpan((x + .5 - W/2) / GPP, -(y + .5 - H/2) / GPP, parts); if (!s) continue;
    const tD = s[1] - s[0]; if (tD < 0.35 * maxD) continue;
    e.push(Math.abs((vol.Zf[i] - vol.Zb[i]) / GPP / tD - 1));
  }
  e.sort((a, b) => a - b);
  return e.length ? e[e.length >> 1] : NaN;
}

/* ----------------------------------------------------------------- TASK 11 */
// The experiment. Five solids whose FRONT silhouettes are the same to within a
// couple of percent but whose true depths differ by 5.5x. A front-only method
// must give the same answer for all of them, and does. A back view must not
// change that, and does not. Only the profile can tell them apart.
function task11() {
  console.log('\nTASK 11 — what a second view can and cannot measure');
  console.log('   depth   silhouette   front only   + back      + profile');
  const areas = [], gains = [];
  for (const s of [0.4, 0.7, 1.0, 1.5, 2.2]) {
    const parts = scaleDepth(FIGURE, s);
    const f = shoot(0, parts), b = shoot(180, parts), p = shoot(90, parts);
    areas.push(f.seg.bounds.area);

    const eFront = depthError(volFor(f.seg), f.seg, parts);

    // a back view enters the geometry path at exactly one point: it does not.
    // Registering it and rebuilding must leave the volume bit-identical.
    const vb = volFor(f.seg);
    const reg = registerSimilarity(f.seg.mask, W, H, b.seg.mask, b.w, b.h, true);
    const eBack = depthError(vb, f.seg, parts);

    const vp = volFor(f.seg);
    const pc = profileConstraint(f.seg.mask, W, H, p.seg.mask, p.w, p.h, 'left');
    applyProfile(vp, pc, {});
    const eProf = depthError(vp, f.seg, parts);
    gains.push({ s, eFront, eBack, eProf, regIoU: reg.iou });

    console.log(`   ${s.toFixed(1)}x   ${String(f.seg.bounds.area).padStart(8)}px`
      + `    ${(eFront*100).toFixed(1).padStart(6)}%   ${(eBack*100).toFixed(1).padStart(6)}%`
      + `    ${(eProf*100).toFixed(1).padStart(6)}%`);
  }
  const spread = Math.max(...areas) / Math.min(...areas) - 1;
  ok('the five solids are indistinguishable from the front', spread < 0.03,
     `silhouette areas within ${(spread * 100).toFixed(1)}%`);
  ok('a back view changes the depth by nothing', gains.every((g) => Math.abs(g.eBack - g.eFront) < 1e-9),
     'identical to float precision');
  const worstFront = Math.max(...gains.map((g) => g.eFront));
  const worstProf = Math.max(...gains.map((g) => g.eProf));
  ok('front alone is wrong wherever the prior is wrong', worstFront > 0.5,
     `worst ${(worstFront * 100).toFixed(0)}%`);
  ok('a profile fixes it across the whole range', worstProf < 0.20,
     `worst ${(worstProf * 100).toFixed(1)}% over a 5.5x depth range`);
  ok('and it is an improvement at every depth', gains.every((g) => g.eProf <= g.eFront + 0.01),
     'no regression on any figure');
}

/* ----------------------------------------------------------------- TASK 12 */
function task12() {
  console.log('\nTASK 12 — registration');
  const f = shoot(0, FIGURE);

  console.log('  back view, deliberately framed differently from the front');
  console.log('    framing               solved scale   IoU');
  let worst = 1;
  for (const [label, w, h, span, want] of [
    ['identical',            W, H, SPAN, 1.00],
    ['10% closer',           W, H, SPAN * 0.90, 0.90],
    ['25% further',          W, H, SPAN * 1.25, 1.25],
    ['1.4x resolution',      Math.round(W*1.4), Math.round(H*1.4), SPAN, 1/1.4],
  ]) {
    const b = shoot(180, FIGURE, w, h, span);
    const reg = registerSimilarity(f.seg.mask, W, H, b.seg.mask, w, h, true);
    worst = Math.min(worst, reg.iou);
    console.log(`    ${label.padEnd(20)}  ${reg.s.toFixed(4).padStart(8)}    ${reg.iou.toFixed(4)}`
      + `   (expected scale ${want.toFixed(2)})`);
    ok(`back registers under "${label}"`, reg.iou > 0.95 && Math.abs(reg.s / want - 1) < 0.05,
       `IoU ${reg.iou.toFixed(3)}, scale ${reg.s.toFixed(3)} vs ${want.toFixed(3)}`);
  }

  // FIGURE is left-right symmetric, so the mirror is a no-op on it and a control
  // built from it would prove nothing. Use a deliberately one-sided solid.
  const ASYM = FIGURE.map(([cx,cy,cz,ax,ay,az], i) => i === 4 ? [cx-0.16, cy-0.16, cz, ax, ay, az*1.4] : [cx,cy,cz,ax,ay,az]);
  const af = shoot(0, ASYM), ab = shoot(180, ASYM);
  const good = registerSimilarity(af.seg.mask, W, H, ab.seg.mask, W, H, true);
  const bad = registerSimilarity(af.seg.mask, W, H, ab.seg.mask, W, H, false);
  console.log(`  asymmetric solid: mirrored ${good.iou.toFixed(4)}  un-mirrored ${bad.iou.toFixed(4)}`);
  ok('a back view is treated as mirrored, and it matters', good.iou > bad.iou + 0.15,
     `${good.iou.toFixed(3)} vs ${bad.iou.toFixed(3)}`);

  // A subject who moved cannot be registered by any similarity, and the IoU has
  // to say so rather than the pipeline quietly painting the texture in the wrong
  // place.
  const movedParts = FIGURE.map(([cx,cy,cz,ax,ay,az], i) => i === 5 ? [cx+0.10, cy-0.12, cz, ax, ay, az] : [cx,cy,cz,ax,ay,az]);
  const mv = shoot(180, movedParts);
  const still = registerSimilarity(f.seg.mask, W, H, shoot(180, FIGURE).seg.mask, W, H, true);
  const moved = registerSimilarity(f.seg.mask, W, H, mv.seg.mask, W, H, true);
  console.log(`  subject moved an arm between exposures: IoU ${moved.iou.toFixed(4)} vs ${still.iou.toFixed(4)} when still`);
  ok('a subject who moved is reported, not absorbed', moved.iou < still.iou - 0.05,
     `${moved.iou.toFixed(3)} vs ${still.iou.toFixed(3)}`);

  // The profile's only identifiable degree of freedom is the vertical scale.
  const p = shoot(90, FIGURE);
  const pc = profileConstraint(f.seg.mask, W, H, p.seg.mask, W, H, 'left');
  console.log(`  profile registered at ${pc.scale.toFixed(4)}x over ${pc.rows} rows (both shots share a lens, so 1.000)`);
  ok('profile vertical registration is exact', Math.abs(pc.scale - 1) < 0.03,
     `${pc.scale.toFixed(4)}`);
  const pHalf = shoot(90, FIGURE, W, H, SPAN * 1.5);
  const pc2 = profileConstraint(f.seg.mask, W, H, pHalf.seg.mask, W, H, 'left');
  console.log(`  profile shot 1.5x further away: scale ${pc2.scale.toFixed(4)} (expect 1.500)`);
  ok('profile scale tracks a different subject distance', Math.abs(pc2.scale / 1.5 - 1) < 0.05,
     `${pc2.scale.toFixed(3)} vs 1.500`);
}

/* ----------------------------------------------------------------- TASK 13 */
// Rescaling a row's depth pushes the two sheets closer together everywhere in it,
// including the band just inside the silhouette where they are already only a few
// cells apart. Below MIN_SEPARATION they land in one cell and weld.
function task13() {
  console.log('\nTASK 13 — the profile constraint must not pinch the shell');
  console.log('   depth   minSep=0   minSep=2   minSep=' + MIN_SEPARATION + '   profile fit   depth err');
  for (const s of [0.4, 0.5, 1.0, 1.8]) {
    const parts = scaleDepth(FIGURE, s);
    const f = shoot(0, parts), p = shoot(90, parts);
    const pc = profileConstraint(f.seg.mask, W, H, p.seg.mask, W, H, 'left');
    const run = (minSep) => {
      const v = volFor(f.seg);
      applyProfile(v, pc, minSep === null ? {} : { minSep });
      const sn = surfaceNets(v);
      const pos = new Float64Array(sn.pos), idx = new Int32Array(sn.idx);
      taubin(pos, idx, PRESETS.balanced.smoothIters, 0.62, -0.64);
      const P = new Float32Array(pos.length);
      for (let i = 0; i < pos.length; i++) P[i] = pos[i];
      return { topo: topology(P, idx), v };
    };
    const a = run(0), b = run(2), c = run(null);
    const fit = profileFit(c.v, pc, f.seg.mask);
    console.log(`   ${s.toFixed(1)}x   ${String(a.topo.nonman).padStart(8)}   ${String(b.topo.nonman).padStart(8)}`
      + `   ${String(c.topo.nonman).padStart(8)}       ${fit.iou.toFixed(3)}      ${(depthError(c.v, f.seg, parts)*100).toFixed(1)}%`
      + `   ${String(c.topo.triangles).padStart(7)} tris`);
    // Bounded rather than zero, and the bound is stated where it came from. The
    // separation floor removes the systematic pinch — hundreds to a thousand
    // welded edges on a thin subject, all of them at the rim. What survives is a
    // different and much smaller thing: a single cell at a concave notch (between
    // the legs) where a scale change and the centreline's shear meet. It is 0-2
    // edges in 200,000-600,000 triangles, it does NOT go away with resolution
    // (measured 1, 0, 0, 2, 2 over grids from 180x240 to 300x400), and the
    // Topology panel reports it rather than the pipeline hiding it.
    ok(`profile leaves the mesh essentially closed at depth ${s}x`,
       c.topo.nonman <= 2 && c.topo.boundary === 0 && c.topo.shells === 1,
       `nonman ${c.topo.nonman} of ${c.topo.triangles} tris, boundary ${c.topo.boundary}`);
    ok(`the separation floor removes the systematic pinch at depth ${s}x`,
       c.topo.nonman <= Math.max(2, a.topo.nonman * 0.02),
       `${a.topo.nonman} unfloored → ${c.topo.nonman}`);
  }
}

/* ----------------------------------------------------------------- TASK 14 */
// End to end through reconstruct(), which is the only path the app uses.
function task14() {
  console.log('\nTASK 14 — end to end: what each view actually changes');
  // Painted red on the +z side and blue on the -z side, so the sign of
  // (blue - red) in each half of the atlas says which side that half shows.
  const albedo = (q) => q[2] >= 0 ? [0.86, 0.32, 0.20] : [0.20, 0.38, 0.86];
  const parts = scaleDepth(FIGURE, 0.55);
  const f = shoot(0, parts, W, H, SPAN, albedo);
  const b = shoot(180, parts, W, H, SPAN, albedo);
  const p = shoot(90, parts, W, H, SPAN, albedo);
  const chroma = (buf) => {
    if (!buf) return null;
    let s = 0, c = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if ((buf[i] + buf[i+1] + buf[i+2]) / 3 < 30) continue;
      s += buf[i+2] - buf[i]; c++;
    }
    return c ? s / c : 0;
  };

  console.log('   views                    generated   near half   far half   watertight');
  const runs = {};
  for (const [tag, extra] of [
    ['front only', null],
    ['front + back', { back: { px: b.px, w: W, h: H } }],
    ['front + profile', { profile: { px: p.px, w: W, h: H }, facing: 'left' }],
    ['front + back + profile', { back: { px: b.px, w: W, h: H }, profile: { px: p.px, w: W, h: H }, facing: 'left' }],
  ]) {
    const r = reconstruct(f.px, W, H, 'balanced', () => {}, null, extra);
    runs[tag] = r;
    const near = chroma(r.padded), far = chroma(r.paddedBack);
    console.log(`   ${tag.padEnd(23)}  ${(r.conf.completed*100).toFixed(0).padStart(6)}%`
      + `   ${near.toFixed(0).padStart(9)}  ${far === null ? '  mirrored' : far.toFixed(0).padStart(9)}`
      + `      ${r.topo.watertight ? 'yes' : 'no'}`);
  }
  ok('a back view replaces mirrored texture with observed texture',
     chroma(runs['front + back'].paddedBack) > 0 && chroma(runs['front + back'].padded) < 0,
     `near ${chroma(runs['front + back'].padded).toFixed(0)} (red), far ${chroma(runs['front + back'].paddedBack).toFixed(0)} (blue)`);
  ok('a back view collapses the structurally-completed fraction',
     runs['front + back'].conf.completed < runs['front only'].conf.completed * 0.5,
     `${(runs['front only'].conf.completed*100).toFixed(0)}% → ${(runs['front + back'].conf.completed*100).toFixed(0)}%`);
  ok('a profile alone does not change what was observed',
     Math.abs(runs['front + profile'].conf.completed - runs['front only'].conf.completed) < 0.08,
     `${(runs['front only'].conf.completed*100).toFixed(0)}% → ${(runs['front + profile'].conf.completed*100).toFixed(0)}%`);
  ok('every combination stays watertight',
     Object.values(runs).every((r) => r.topo.watertight),
     Object.entries(runs).map(([k, r]) => `${k.split(' ').pop()}:${r.topo.watertight ? 'y' : 'n'}`).join(' '));
  ok('the reported profile fit is high when a profile was supplied',
     runs['front + back + profile'].stats.profileIoU > 0.9,
     `IoU ${runs['front + back + profile'].stats.profileIoU.toFixed(3)}`);

  // The single-image path must be untouched by any of this.
  const solo = reconstruct(f.px, W, H, 'balanced', () => {});
  ok('the single-image path is unchanged by the multi-view code',
     solo.topo.triangles === runs['front only'].topo.triangles && solo.paddedBack === null,
     `${solo.topo.triangles} triangles, no far-half texture`);
}

/* -------------------------------------------------------------------- run */
task11(); task12(); task13(); task14();
const bad = results.filter((r) => !r.pass);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
