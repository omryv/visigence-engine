// A mesh sized by the evidence.
//   node tools/test/atlas/smartmesh.mjs
//
// `smartMesh` replaces the surface-nets mesh with one whose triangle count is
// what σ supports: an edge collapse is refused when the new vertex would sit
// more than κ·σ from the planes it stands for. The claims that makes are
// measured here rather than asserted:
//
//   1. a planar solid loses nothing — a subdivided cube returns to 12 triangles
//      with zero deviation, its corners where they were;
//   2. on a sphere, against closed form: topology kept, volume kept, the quadric
//      never over budget, and the TRUE deviation (sampled, two-sided) quoted
//      against it — because the quadric measures distance to planes, not to
//      the triangles that were removed, and the two differ;
//   3. detail goes where the evidence is — two hemispheres carrying σ and 4σ
//      come out with a density ratio near 4, which is what √σ edge lengths
//      predict at equal curvature;
//   4. topology is preserved where it is not trivial: a torus keeps its hole,
//      and a sphere driven far past any sensible target stays a sphere;
//   5. the quads are quads — planar, convex, wound with the triangles, covering
//      every triangle once — and the OBJ writes them;
//   6. on the engine's own output: watertight in → watertight out, the silhouette
//      re-projection still sub-pixel, the density monotone in σ, the exported σ
//      inflated by no more than √(1+κ²), the UVs re-derived exactly, the skin
//      still normalised, the GLB still readable, and the same bytes twice;
//   7. a mesh that carries nothing — no σ, no frame — is still handled, and the
//      report says with what.
import { reconstruct, silhouetteIoU } from '../../../src/atlas/atlas-core.js';
import { smartMesh, simplify, pairQuads, meshDeviation, meshQuality, reprojectAtlas, SMART_MESH } from '../../../src/atlas/smartmesh.js';
import { topology } from '../../../src/atlas/topology.js';
import { glbBytes, makeOBJ } from '../../../src/atlas/exporters.js';
import { readGLB, readAccessor } from '../../../src/atlas/certificate.js';
import { icosphere, cube, torus, signedVolume } from './solids.mjs';
import { render, camera, reseed } from './multiview.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
};
const f3 = (x) => x.toFixed(3), e2 = (x) => x.toExponential(2), pc = (x) => (x * 100).toFixed(1) + '%';

/* ------------------------------------------------------------------ task 1 */

function taskCube() {
  console.log('\nTASK 1 — a planar solid loses nothing');
  const c = cube(20);
  const s = smartMesh(c, { maxError: 1e-4 });
  const R = s.report;
  console.log(`   ${R.in.triangles} → ${R.out.triangles} triangles · stopped by ${R.budget.stoppedBy}`
            + ` · deviation ${e2(R.deviation.hausdorff)} · ${R.quads.count} quads (${pc(R.quads.fraction)})`);
  ok('the cube returns to its 12 triangles', R.out.triangles === 12, `${R.out.triangles}`);
  ok('the deviation is zero', R.deviation.hausdorff < 1e-9, e2(R.deviation.hausdorff));
  ok('every corner is a corner of the cube',
     Array.from(s.positions).every((x) => Math.abs(Math.abs(x) - 1) < 1e-6), `${s.positions.length / 3} vertices`);
  ok('it is six quads', R.quads.count === 6 && R.quads.leftoverTriangles === 0, `${R.quads.count} quads, ${R.quads.leftoverTriangles} triangles left`);
  ok('watertight, one shell, χ = 2', R.out.watertight && R.out.shells === 1 && R.out.euler === 2,
     `χ ${R.out.euler} · shells ${R.out.shells}`);
  ok('the 12 creases were found, as 20 segments each', R.creases === 240, `${R.creases} crease edges`);
  const vol = signedVolume(s.positions, s.indices);
  ok('the volume is 8', Math.abs(vol - 8) < 1e-6, f3(vol));
}

/* ------------------------------------------------------------------ task 2 */

function taskSphere() {
  console.log('\nTASK 2 — a sphere, against closed form');
  const S = icosphere(5);
  const V0 = signedVolume(S.positions, S.indices);
  const runs = [0.002, 0.01].map((maxError) => ({ maxError, s: smartMesh(S, { maxError }) }));
  for (const { maxError, s } of runs) {
    const R = s.report;
    console.log(`   budget ${maxError}: ${R.in.triangles} → ${R.out.triangles}`
              + ` · quadric max ${e2(R.quadric.max)} (${f3(R.budget.used.max)} of budget)`
              + ` · true deviation p95 ${e2(R.deviation.simplifiedToOriginal.p95)} max ${e2(R.deviation.hausdorff)}`
              + ` · min angle p5 ${R.quality.out.minAngle.p5.toFixed(1)}° · valence ${R.quality.out.valence.mean.toFixed(2)} ± ${R.quality.out.valence.sd.toFixed(2)}`);
  }
  const a = runs[0].s.report, b = runs[1].s.report;
  ok('watertight, χ = 2, one shell, at both budgets',
     [a, b].every((R) => R.out.watertight && R.out.euler === 2 && R.out.shells === 1),
     `χ ${a.out.euler}, ${b.out.euler}`);
  ok('the quadric never exceeds the budget', a.budget.used.max <= 1 && b.budget.used.max <= 1,
     `${f3(a.budget.used.max)}, ${f3(b.budget.used.max)} of budget`);
  // The quadric is a distance to planes. On a sphere the removed triangles
  // bulge away from those planes, so the true deviation is larger — measured
  // 1.35× at p95 and 2.5× at the maximum. The bound quoted is the measurement
  // with room, not a derivation.
  ok('the true deviation is within 1.6× the budget at p95',
     a.deviation.simplifiedToOriginal.p95 <= 1.6 * 0.002 && b.deviation.simplifiedToOriginal.p95 <= 1.6 * 0.01,
     `${f3(a.deviation.simplifiedToOriginal.p95 / 0.002)}×, ${f3(b.deviation.simplifiedToOriginal.p95 / 0.01)}×`);
  ok('...and within 3× at the maximum', a.deviation.hausdorff <= 3 * 0.002 && b.deviation.hausdorff <= 3 * 0.01,
     `${f3(a.deviation.hausdorff / 0.002)}×, ${f3(b.deviation.hausdorff / 0.01)}×`);
  const Va = signedVolume(runs[0].s.positions, runs[0].s.indices), Vb = signedVolume(runs[1].s.positions, runs[1].s.indices);
  ok('the volume is kept within 1% at the tight budget', Math.abs(Va / V0 - 1) < 0.01, `${pc(Va / V0 - 1)}`);
  ok('...and within 5% at the loose one', Math.abs(Vb / V0 - 1) < 0.05, `${pc(Vb / V0 - 1)}`);
  // Density ∝ 1∕(budget·curvature radius): five times the budget is a fifth of
  // the triangles, give or take the discreteness of a 260-triangle sphere.
  const ratio = a.out.triangles / b.out.triangles;
  ok('five times the budget is about a fifth of the triangles', ratio > 3.5 && ratio < 7, `${f3(ratio)}× for 5× budget`);
  ok('no sliver survives', a.quality.out.minAngle.min > 5 && b.quality.out.minAngle.min > 5,
     `smallest angles ${a.quality.out.minAngle.min.toFixed(1)}°, ${b.quality.out.minAngle.min.toFixed(1)}°`);
  ok('a target is honoured when the budget allows it',
     smartMesh(S, { maxError: 0.1, target: 500, measure: false }).report.out.triangles === 500, '500');
}

/* ------------------------------------------------------------------ task 3 */

function taskAllocation() {
  console.log('\nTASK 3 — detail goes where the evidence is');
  const S = icosphere(5);
  const n = S.positions.length / 3, sigma = new Float32Array(n);
  for (let i = 0; i < n; i++) sigma[i] = S.positions[i*3+2] >= 0 ? 1 : 4;
  const kappa = 0.25;
  const s = smartMesh({ ...S, sigma }, { kappa, sigmaScale: 0.008 });
  const R = s.report;
  const tight = R.allocation.bySigma[0], loose = R.allocation.bySigma[R.allocation.bySigma.length - 1];
  const ratio = tight.densityAfter / loose.densityAfter;
  console.log(`   σ = 1 hemisphere: ${tight.densityAfter.toFixed(1)} tri/unit² · σ = 4: ${loose.densityAfter.toFixed(1)}`
            + ` · ratio ${f3(ratio)} (√σ edge lengths predict 4) · ${R.out.triangles} triangles`);
  console.log(`   σ inflation p50 ${R.sigma.inflation.p50.toFixed(4)} max ${R.sigma.inflation.max.toFixed(4)}`
            + ` · bound √(1+κ²) = ${Math.sqrt(1 + kappa*kappa).toFixed(4)}`);
  ok('the σ hemisphere is 2.5–6× as dense as the 4σ one', ratio > 2.5 && ratio < 6, `${f3(ratio)}×`);
  ok('the budget source is σ', R.budget.source === 'sigma' && R.budget.kappa === kappa, R.budget.source);
  ok('the exported σ is inflated by at most √(1+κ²)', R.sigma.inflation.max <= Math.sqrt(1 + kappa*kappa) + 1e-6,
     `max ${R.sigma.inflation.max.toFixed(4)}`);
  ok('...and by more than nothing', R.sigma.inflation.p50 > 1, `p50 ${R.sigma.inflation.p50.toFixed(4)}`);
  ok('the two hemispheres still make one closed sphere', R.out.watertight && R.out.euler === 2, `χ ${R.out.euler}`);
  // κ is the dial: twice κ is about half the triangles
  const s2 = smartMesh({ ...S, sigma }, { kappa: 2 * kappa, sigmaScale: 0.008, measure: false });
  const kr = R.out.triangles / s2.report.out.triangles;
  ok('doubling κ roughly halves the triangles', kr > 1.4 && kr < 2.8, `${f3(kr)}×`);
}

/* ------------------------------------------------------------------ task 4 */

function taskTopology() {
  console.log('\nTASK 4 — topology is preserved where it is not trivial');
  const T = torus(96, 48);
  const t = smartMesh(T, { maxError: 0.003 });
  console.log(`   torus ${t.report.in.triangles} → ${t.report.out.triangles} · χ ${t.report.in.euler} → ${t.report.out.euler}`
            + ` · deviation max ${e2(t.report.deviation.hausdorff)}`);
  ok('the torus keeps its hole (χ = 0)', t.report.out.euler === 0 && t.report.out.watertight, `χ ${t.report.out.euler}`);
  ok('the torus keeps its volume within 2%',
     Math.abs(signedVolume(t.positions, t.indices) / signedVolume(T.positions, T.indices) - 1) < 0.02,
     pc(signedVolume(t.positions, t.indices) / signedVolume(T.positions, T.indices) - 1));
  // Driven with an unlimited budget toward four triangles — the smallest closed
  // manifold — the link condition and the flip test are all that stand between
  // the sphere and a pinched or inverted mess.
  const S = icosphere(4);
  const x = smartMesh(S, { maxError: 10, target: 4, measure: false });
  console.log(`   sphere driven to target 4: ${x.report.out.triangles} triangles · χ ${x.report.out.euler}`
            + ` · stopped by ${x.report.budget.stoppedBy} · refused ${JSON.stringify(x.report.budget.refused)}`);
  ok('a sphere driven far past sense is still a closed sphere',
     x.report.out.watertight && x.report.out.euler === 2 && x.report.out.shells === 1, `χ ${x.report.out.euler}`);
  ok('...with a positive volume', signedVolume(x.positions, x.indices) > 0, f3(signedVolume(x.positions, x.indices)));
  ok('...and no more than 40 triangles', x.report.out.triangles <= 40, `${x.report.out.triangles}`);
}

/* ------------------------------------------------------------------ task 5 */

function taskQuads() {
  console.log('\nTASK 5 — the quads are quads');
  const S = icosphere(5);
  const s = smartMesh(S, { maxError: 0.002, measure: false });
  const q = s.quads, P = s.positions, nq = q.length / 4;
  console.log(`   ${nq} quads + ${s.tris.length / 3} triangles from ${s.indices.length / 3}`
            + ` · paired ${pc(s.report.quads.fraction)} · planarity max ${s.report.quads.planarity.max.toFixed(1)}° p95 ${s.report.quads.planarity.p95.toFixed(1)}°`);
  ok('every triangle is in exactly one quad or left alone', 2 * nq + s.tris.length / 3 === s.indices.length / 3,
     `${2 * nq} + ${s.tris.length / 3} = ${s.indices.length / 3}`);
  ok('at least three quarters of the sphere pairs', s.report.quads.fraction >= 0.75, pc(s.report.quads.fraction));
  let planarMax = 0, concave = 0, wound = 0;
  const cross = (o, p, r) => {
    const ux = P[p*3]-P[o*3], uy = P[p*3+1]-P[o*3+1], uz = P[p*3+2]-P[o*3+2];
    const vx = P[r*3]-P[o*3], vy = P[r*3+1]-P[o*3+1], vz = P[r*3+2]-P[o*3+2];
    return [uy*vz - uz*vy, uz*vx - ux*vz, ux*vy - uy*vx];
  };
  for (let i = 0; i < nq; i++) {
    const [a, b, c, d] = [q[i*4], q[i*4+1], q[i*4+2], q[i*4+3]];
    const n1 = cross(a, b, c), n2 = cross(a, c, d);
    const l1 = Math.hypot(...n1), l2 = Math.hypot(...n2);
    const ang = Math.acos(Math.max(-1, Math.min(1, (n1[0]*n2[0] + n1[1]*n2[1] + n1[2]*n2[2]) / (l1 * l2)))) * 180 / Math.PI;
    if (ang > planarMax) planarMax = ang;
    // convex: each corner's turn has the same sign against the quad's normal
    const nx = n1[0] + n2[0], ny = n1[1] + n2[1], nz = n1[2] + n2[2];
    const corners = [[d, a, b], [a, b, c], [b, c, d], [c, d, a]];
    for (const [p, o, r] of corners) { const cr = cross(o, r, p); if (cr[0]*nx + cr[1]*ny + cr[2]*nz <= 0) { concave++; break; } }
    // wound like the sphere: outward
    const cx = (P[a*3]+P[b*3]+P[c*3]+P[d*3]) / 4, cy = (P[a*3+1]+P[b*3+1]+P[c*3+1]+P[d*3+1]) / 4, cz = (P[a*3+2]+P[b*3+2]+P[c*3+2]+P[d*3+2]) / 4;
    if (nx*cx + ny*cy + nz*cz <= 0) wound++;
  }
  ok('every quad is planar within 20°', planarMax < 20, `worst ${planarMax.toFixed(1)}°`);
  ok('every quad is convex', concave === 0, `${concave} concave`);
  ok('every quad faces outward with the triangles', wound === 0, `${wound} inverted`);
  // the OBJ writes them
  const obj = makeOBJ({ positions: s.positions, normals: s.normals, uvs: new Float32Array(P.length / 3 * 2), indices: s.indices, quads: s.quads, tris: s.tris }, 'q');
  const lines = new TextDecoder().decode(obj[0].data).split('\n');
  const quadLines = lines.filter((l) => l.startsWith('f ') && l.split(' ').length === 5).length;
  const triLines = lines.filter((l) => l.startsWith('f ') && l.split(' ').length === 4).length;
  ok('the OBJ carries the quads as quads', quadLines === nq && triLines === s.tris.length / 3, `${quadLines} quads, ${triLines} triangles`);
  // pairing is a function of the mesh alone
  const again = pairQuads(s.positions, s.indices);
  ok('the pairing is deterministic', again.quads.length === q.length && again.quads.every((x, i) => x === q[i]), `${again.count} quads`);
}

/* ------------------------------------------------------------------ task 6 */

const W = 200, H = 260;

function taskEngine() {
  console.log('\nTASK 6 — on the engine\'s own output');
  reseed(97);
  const im = render(camera(0, 0, 3.2, 2.6), W, H, {});
  const r = reconstruct(im.px, W, H, 'balanced', () => {});
  const kappa = SMART_MESH.kappa;
  const s = smartMesh(r, { kappa });
  const R = s.report;
  console.log(`   ${R.in.triangles} → ${R.out.triangles} triangles (${pc(R.ratio)}) in ${R.ms}ms · stopped by ${R.budget.stoppedBy}`
            + ` · κ ${kappa} on σ median ${r.sigStats.p50.toFixed(2)}px`);
  console.log(`   deviation: p95 ${e2(R.deviation.simplifiedToOriginal.p95)} max ${e2(R.deviation.hausdorff)}`
            + ` model units = ${pc(R.deviation.relative)} of the diagonal`
            + ` · quadric max ${e2(R.quadric.max)} (${f3(R.budget.used.max)} of budget)`);
  console.log(`   density by σ quartile, triangles per unit area after: `
            + R.allocation.bySigma.map((b) => `σ ≤ ${b.sigmaMax.toFixed(2)}px → ${b.densityAfter.toFixed(0)}`).join(' · '));
  console.log(`   observed ${R.allocation.observed.densityAfter.toFixed(0)} · completed ${R.allocation.completed.densityAfter.toFixed(0)}`
            + ` (with one photograph the far side carries the near side's σ, so these are expected to be alike)`);
  console.log(`   quads ${pc(R.quads.fraction)} · seam duplicates ${R.out.seamDup} · σ inflation p50 ${R.sigma.inflation.p50.toFixed(4)} max ${R.sigma.inflation.max.toFixed(4)}`);

  ok('the reconstruction was watertight, and still is', R.in.watertight && R.out.watertight,
     `boundary ${R.out.boundary} · non-manifold ${R.out.nonman}`);
  ok('one shell, χ = 2, before and after', R.in.shells === 1 && R.out.shells === 1 && R.in.euler === 2 && R.out.euler === 2,
     `χ ${R.in.euler} → ${R.out.euler}`);
  ok('the evidence supports under 5% of the surface-nets triangles', R.ratio < 0.05, pc(R.ratio));
  ok('the run stopped at the budget, not at a target', R.budget.stoppedBy === 'budget', R.budget.stoppedBy);
  ok('the quadric never exceeds the budget', R.budget.used.max <= 1, f3(R.budget.used.max));
  ok('the true deviation is under 2% of the bounding diagonal', R.deviation.relative < 0.02, pc(R.deviation.relative));
  const dens = R.allocation.bySigma.map((b) => b.densityAfter);
  ok('triangle density falls monotonically with σ', dens.every((d, i) => i === 0 || d < dens[i - 1]),
     dens.map((d) => d.toFixed(0)).join(' > '));
  ok('the tightest σ quartile is at least 3× as dense as the loosest', dens[0] / dens[dens.length - 1] > 3,
     `${f3(dens[0] / dens[dens.length - 1])}×`);
  ok('σ is inflated by at most √(1+κ²)', R.sigma.inflation.max <= Math.sqrt(1 + kappa*kappa) + 1e-6,
     `max ${R.sigma.inflation.max.toFixed(4)} ≤ ${Math.sqrt(1 + kappa*kappa).toFixed(4)}`);

  // The silhouette: the simplified solid re-rendered at the input camera.
  const rp = silhouetteIoU(s.positions, s.indices, r.frame, im.mask, null, W, H);
  console.log(`   re-projection: IoU ${rp.iou.toFixed(4)} · boundary off by ${rp.offsetPx.toFixed(3)}px`
            + ` (full mesh ${r.reproj.iou.toFixed(4)}, ${r.reproj.offsetPx.toFixed(3)}px)`);
  ok('the simplified mesh still re-projects sub-pixel', rp.offsetPx < 1, `${rp.offsetPx.toFixed(3)}px`);
  ok('...within 0.05px of the full mesh', rp.offsetPx - r.reproj.offsetPx < 0.05,
     `+${(rp.offsetPx - r.reproj.offsetPx).toFixed(3)}px`);

  // UVs are re-derived from the frame, not interpolated. Almost no output
  // vertex is unmoved — nearly every survivor absorbed something and went to
  // its quadric optimum — so the inverse is checked on the FULL mesh: run back
  // through the frame, every one of the engine's own vertices must land on the
  // UV the engine gave it, in one chart or the other.
  ok('UVs were re-projected from the frame', R.uv === 'reprojected', R.uv);
  const rp0 = reprojectAtlas(r.positions, r.normals, r.indices, r.frame, W, H);
  let uvMax = 0;
  for (let i = 0; i < r.positions.length / 3; i++) {
    const near = Math.hypot(rp0.u0[i] * 0.5 - r.uvs[i*2], rp0.v0[i] - r.uvs[i*2+1]);
    const far = Math.hypot(0.5 + rp0.u0[i] * 0.5 - r.uvs[i*2], rp0.v0[i] - r.uvs[i*2+1]);
    const d = Math.min(near, far);
    if (d > uvMax) uvMax = d;
  }
  console.log(`   the frame's inverse puts every one of the ${r.positions.length / 3} full-mesh vertices back on its UV to within ${e2(uvMax)}`);
  ok('the frame inverts: every vertex gets its own UV back', uvMax < 1e-4, `max ${e2(uvMax)} over ${r.positions.length / 3}`);
  let uvBad = 0;
  for (let j = 0; j < s.uvs.length; j += 2) if (s.uvs[j] < 0 || s.uvs[j] > 1 || s.uvs[j+1] < 0 || s.uvs[j+1] > 1) uvBad++;
  ok('every UV is inside the atlas', uvBad === 0, `${uvBad} outside`);
  let chartBad = 0;
  for (let j = 0; j < s.positions.length / 3; j++) {
    const back = s.normals[j*3+2] < 0, u = s.uvs[j*2];
    // a seam duplicate carries the other chart's UV on purpose; only count a
    // vertex that is in the wrong half AND has no duplicate in the right one
    if ((back && u < 0.5) || (!back && u > 0.5)) chartBad++;
  }
  ok('most vertices sit in the chart their normal says', chartBad <= R.out.seamDup, `${chartBad} on the other chart, ${R.out.seamDup} seam duplicates`);

  // the skin
  let notOne = 0, badJoint = 0;
  for (let j = 0; j < s.skinWeights.length; j += 4) {
    const sum = s.skinWeights[j] + s.skinWeights[j+1] + s.skinWeights[j+2] + s.skinWeights[j+3];
    if (Math.abs(sum - 1) > 1e-4) notOne++;
    for (let k = 0; k < 4; k++) if (s.skinJoints[j+k] >= r.rig.joints.length) badJoint++;
  }
  ok('every vertex still carries four weights summing to one', notOne === 0 && badJoint === 0, `${notOne} off, ${badJoint} bad joints`);

  // the export
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const geo = { positions: s.positions, normals: s.normals, uvs: s.uvs, indices: s.indices,
                colors: s.baseColor, sigma: s.sigma, sigmaMeta: r.sigStats };
  const rig = { joints: r.rig.joints, bones: r.rig.bones, skinJoints: s.skinJoints, skinWeights: s.skinWeights };
  const glb = glbBytes(geo, PNG, 'smart', rig, null);
  const g = readGLB(glb);
  const prim = g.json.meshes[0].primitives[0];
  const back = readAccessor(g, prim.attributes.POSITION), sig = readAccessor(g, prim.attributes._SIGMA);
  const full = glbBytes({ positions: r.positions, normals: r.normals, uvs: r.uvs, indices: r.indices, colors: r.baseColor, sigma: r.sigma, sigmaMeta: r.sigStats }, PNG, 'full', r.rig, null);
  console.log(`   GLB ${glb.length} bytes against ${full.length} for the full mesh (${pc(glb.length / full.length)})`);
  ok('the GLB round-trips with σ and the skin', back.length === s.positions.length && sig.length === s.sigma.length
     && prim.attributes.JOINTS_0 !== undefined, `${back.length / 3} vertices`);
  ok('the GLB is under a tenth the size of the full mesh', glb.length < full.length / 10, pc(glb.length / full.length));
  const topoGLB = topology(back, readAccessor(g, prim.indices));
  ok('the file\'s own topology agrees with the report', topoGLB.triangles === R.out.triangles && topoGLB.watertight === R.out.watertight,
     `${topoGLB.triangles} triangles, watertight ${topoGLB.watertight}`);

  // determinism
  const s2 = smartMesh(r, { kappa, measure: false });
  const same = s2.positions.length === s.positions.length && s2.positions.every((x, i) => x === s.positions[i])
    && s2.indices.every((x, i) => x === s.indices[i]) && s2.sigma.every((x, i) => x === s.sigma[i])
    && s2.quads.every((x, i) => x === s.quads[i]);
  ok('the same reconstruction simplifies to the same bytes, twice', same, `${s.positions.length / 3} vertices`);

  // a target below the budget stops at the budget and says so
  const st = smartMesh(r, { kappa, target: 200, measure: false });
  ok('a target the budget cannot reach stops at the budget, and says so',
     st.report.budget.stoppedBy === 'budget' && st.report.out.triangles > 200 && st.report.out.triangles === R.out.triangles,
     `${st.report.out.triangles} > 200`);
  const st2 = smartMesh(r, { kappa: 4, target: 3000, measure: false });
  ok('...and a reachable one is met exactly', st2.report.budget.stoppedBy === 'target' && st2.report.out.triangles === 3000,
     `${st2.report.out.triangles}`);
}

/* ------------------------------------------------------------------ task 7 */

function taskBare() {
  console.log('\nTASK 7 — a mesh that carries nothing');
  const S = icosphere(4);
  const s = smartMesh({ positions: S.positions, indices: S.indices }, { measure: false });
  const R = s.report;
  console.log(`   no σ, no frame: budget ${R.budget.source} = ${e2(R.budget.maxError)} · ${R.in.triangles} → ${R.out.triangles} · uv ${R.uv}`);
  // the unit sphere's bounding box is [−1, 1]³, whose diagonal is 2√3
  ok('without σ the budget is a fraction of the diagonal, and says so',
     R.budget.source === 'diagonal' && Math.abs(R.budget.maxError - SMART_MESH.absoluteFraction * 2 * Math.sqrt(3)) < 1e-5,
     `${R.budget.source} · ${e2(R.budget.maxError)}`);
  ok('without a frame there are no UVs, and it says so', R.uv === 'none' && s.uvs === null, R.uv);
  ok('nothing is inflated that was not there', R.sigma === null && s.sigma === undefined, 'no σ');
  const uv = new Float32Array(S.positions.length / 3 * 2).fill(0.25);
  const s2 = smartMesh({ positions: S.positions, indices: S.indices, uvs: uv }, { maxError: 0.01, measure: false });
  ok('a carried UV is interpolated, and says so', s2.report.uv === 'interpolated' && s2.uvs.every((x) => Math.abs(x - 0.25) < 1e-6),
     s2.report.uv);
  ok('the low-level pieces are exported for a caller with its own mesh',
     typeof simplify === 'function' && typeof meshDeviation === 'function' && typeof meshQuality === 'function', '');
}

/* ------------------------------------------------------------------- run */

taskCube();
taskSphere();
taskAllocation();
taskTopology();
taskQuads();
taskEngine();
taskBare();

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
