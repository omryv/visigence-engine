// The auto-rig: skeleton, skinning, and the glTF it is written into.
//   node tools/test/atlas/rig.mjs
//
// A caveat that belongs at the top rather than in a footnote. The acceptance
// criteria for this phase name three external checks — the Khronos
// `gltf-validator`, three.js, and Blender. None of the three can run here: this
// container has no network (npm returns 403 for every package), no Blender, and
// no glTF loader of any kind. So this file does not claim any of them passed.
//
// What it does instead is parse the GLB back out of its own bytes and check the
// parts of glTF 2.0 that a skinned mesh can get wrong, then compute linear-blend
// skinning by hand and verify the mesh actually moves the way a joint rotation
// says it should. That is a stronger functional check than "it loaded" and a
// weaker conformance check than the validator. Both halves of that sentence are
// true and neither substitutes for running the real thing.
import { reconstruct } from '../../../src/atlas/atlas-core.js';
import { glbBytes } from '../../../src/atlas/exporters.js';
import { render, camera, FIGURE } from './multiview.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail}`);
};
const f = (v, n = 3) => (v >= 0 ? ' ' : '') + v.toFixed(n);

const W = 200, H = 260;
const shoot = (opts = {}) => render(camera(opts.az || 0, opts.el || 0, 3.2, 2.6), W, H, opts);
const build = (im, mode = 'balanced') => reconstruct(im.px, W, H, mode, () => {});

/* ------------------------------------------------------------- GLB parsing */

function parseGLB(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a GLB');
  if (dv.getUint32(4, true) !== 2) throw new Error('not glTF 2');
  if (dv.getUint32(8, true) !== bytes.length) throw new Error('header length disagrees with the file');
  let p = 12, json = null, bin = null;
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004E4942) bin = body;
    p += 8 + len;
    if (len % 4 !== 0) throw new Error('chunk length is not 4-aligned');
  }
  return { json, bin, size: bytes.length };
}

const COMP = { 5120: [1, Int8Array], 5121: [1, Uint8Array], 5122: [2, Int16Array],
               5123: [2, Uint16Array], 5125: [4, Uint32Array], 5126: [4, Float32Array] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(g, bin, ai) {
  const acc = g.json.accessors[ai], bv = g.json.bufferViews[acc.bufferView];
  const [sz, Arr] = COMP[acc.componentType], n = NCOMP[acc.type];
  const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  return new Arr(bin.buffer, bin.byteOffset + off, acc.count * n);
}

/* --------------------------------------------------------- structural glTF */
// The subset of glTF 2.0 a hand-written skinned exporter actually gets wrong.
function validate(g) {
  const errs = [];
  const J = g.json, bin = g.bin;
  const E = (c, m) => { if (!c) errs.push(m); };

  E(J.asset && J.asset.version === '2.0', 'asset.version must be "2.0"');
  E(J.buffers.length === 1 && J.buffers[0].byteLength === bin.length,
    `buffer byteLength ${J.buffers[0] && J.buffers[0].byteLength} vs BIN chunk ${bin.length}`);

  J.bufferViews.forEach((bv, i) => {
    E((bv.byteOffset || 0) % 4 === 0, `bufferView ${i} byteOffset not 4-aligned`);
    E((bv.byteOffset || 0) + bv.byteLength <= bin.length, `bufferView ${i} runs past the buffer`);
    E(bv.target === undefined || bv.target === 34962 || bv.target === 34963,
      `bufferView ${i} has a bogus target`);
  });

  J.accessors.forEach((a, i) => {
    E(COMP[a.componentType] !== undefined, `accessor ${i} bad componentType`);
    E(NCOMP[a.type] !== undefined, `accessor ${i} bad type`);
    const [sz] = COMP[a.componentType] || [1];
    const bv = J.bufferViews[a.bufferView];
    E(bv !== undefined, `accessor ${i} points at no bufferView`);
    if (!bv) return;
    // glTF: accessor offsets must align to the component size.
    E(((bv.byteOffset || 0) + (a.byteOffset || 0)) % sz === 0, `accessor ${i} not component-aligned`);
    E((a.byteOffset || 0) + a.count * NCOMP[a.type] * sz <= bv.byteLength,
      `accessor ${i} runs past its bufferView`);
  });

  // POSITION must carry min/max, and they must actually bound the data.
  const prim = J.meshes[0].primitives[0];
  const pa = J.accessors[prim.attributes.POSITION];
  E(Array.isArray(pa.min) && Array.isArray(pa.max), 'POSITION accessor needs min and max');
  const pos = readAccessor(g, bin, prim.attributes.POSITION);
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < pa.count; v++) { const t = pos[v*3+k]; if (t < lo) lo = t; if (t > hi) hi = t; }
    E(lo >= pa.min[k] - 1e-5 && hi <= pa.max[k] + 1e-5, `POSITION min/max wrong on axis ${k}`);
  }

  // Indices must be in range.
  const idx = readAccessor(g, bin, prim.indices);
  let maxIdx = 0; for (let i = 0; i < idx.length; i++) if (idx[i] > maxIdx) maxIdx = idx[i];
  E(maxIdx < pa.count, `index ${maxIdx} out of range for ${pa.count} vertices`);

  // Every node index referenced anywhere must exist, and the scene must be sane.
  const nN = J.nodes.length;
  J.nodes.forEach((n, i) => (n.children || []).forEach((c) =>
    E(c >= 0 && c < nN && c !== i, `node ${i} has a bogus child ${c}`)));
  E(J.scenes[J.scene].nodes.every((n) => n >= 0 && n < nN), 'scene references a missing node');

  // Exactly one parent per node — a node reachable twice is not a tree.
  const seen = new Uint8Array(nN);
  J.nodes.forEach((n) => (n.children || []).forEach((c) => { seen[c]++; }));
  E(!seen.some((c) => c > 1), 'a node appears as a child more than once');

  if (J.skins) {
    const sk = J.skins[0];
    E(prim.attributes.JOINTS_0 !== undefined && prim.attributes.WEIGHTS_0 !== undefined,
      'a skinned primitive needs JOINTS_0 and WEIGHTS_0');
    const ja = J.accessors[prim.attributes.JOINTS_0], wa = J.accessors[prim.attributes.WEIGHTS_0];
    E(ja.type === 'VEC4' && wa.type === 'VEC4', 'JOINTS_0/WEIGHTS_0 must be VEC4');
    E(ja.componentType === 5121 || ja.componentType === 5123, 'JOINTS_0 must be ubyte or ushort');
    E(ja.count === pa.count && wa.count === pa.count, 'skin attributes must match the vertex count');
    const ibm = J.accessors[sk.inverseBindMatrices];
    E(ibm.type === 'MAT4' && ibm.count === sk.joints.length,
      `inverseBindMatrices count ${ibm.count} vs ${sk.joints.length} joints`);
    E(J.bufferViews[ibm.bufferView].target === undefined,
      'the inverseBindMatrices bufferView must not declare an ARRAY_BUFFER target');
    E(sk.joints.every((n) => n >= 0 && n < nN), 'skin.joints references a missing node');
    E(new Set(sk.joints).size === sk.joints.length, 'skin.joints has duplicates');
    E(sk.skeleton === undefined || sk.joints.includes(sk.skeleton) || sk.skeleton < nN,
      'skin.skeleton is not a node');
    const jd = readAccessor(g, bin, prim.attributes.JOINTS_0);
    let bad = 0; for (let i = 0; i < jd.length; i++) if (jd[i] >= sk.joints.length) bad++;
    E(bad === 0, `${bad} joint indices out of range`);
    E(J.nodes[0].skin === 0, 'the mesh node must reference the skin');
  }
  return errs;
}

/* ------------------------------------------------------------------ task 1 */

function taskSkeleton() {
  console.log('\nTASK 1 — the skeleton of a known figure');
  const r = build(shoot());
  const rg = r.rig, st = rg.stats;
  console.log(`   ${st.joints} joints · ${st.bones} bones · ${st.branches} branches`
            + ` · ${st.waists} waists (ρ ${st.waistsRho}, A ${st.waistsA})`
            + ` · medial ${st.medialPx}px · ρ floor ${st.rhoFloor.toFixed(3)}`);

  ok('the skeleton is not empty', st.joints >= 2 && st.bones >= 1, `${st.joints}/${st.bones}`);
  ok('bones = joints − 1, so it is a tree', st.bones === st.joints - 1, `${st.bones} vs ${st.joints - 1}`);

  // Exactly one root, and every other joint reachable from it.
  const roots = rg.joints.filter((j) => j.parent < 0);
  ok('exactly one root joint', roots.length === 1, `${roots.length}`);
  let reach = 0;
  for (const j of rg.joints) {
    let p = j, guard = 0;
    while (p.parent >= 0 && guard++ < rg.joints.length) p = rg.joints[p.parent];
    if (p.parent < 0) reach++;
  }
  ok('every joint reaches the root', reach === rg.joints.length, `${reach}/${rg.joints.length}`);

  // The figure is a torso with a head, two arms and two legs. The skeleton is
  // not asked to name them, only to reach them: every limb tip in the fixture
  // should have a joint somewhere near it.
  const limbs = [['head', 0.00, 0.56 + 0.17], ['arm L', -0.40, 0.10 - 0.30],
                 ['arm R', 0.40, 0.10 - 0.30], ['leg L', -0.14, -0.45 - 0.34],
                 ['leg R', 0.14, -0.45 - 0.34]];
  // world → model units: the reconstruction is scaled to S/md, and the fixture
  // spans `span` in world, so compare in normalised units instead.
  let ext = 0;
  for (const j of rg.joints) ext = Math.max(ext, Math.hypot(j.x, j.y));
  let covered = 0;
  for (const [name, lx, ly] of limbs) {
    // Nearest joint direction-wise: a limb is reached if some joint lies in its
    // quadrant at a comparable radius.
    const ang = Math.atan2(ly, lx);
    let best = Infinity;
    for (const j of rg.joints) {
      const ja = Math.atan2(j.y, j.x);
      let d = Math.abs(ja - ang); if (d > Math.PI) d = 2*Math.PI - d;
      const rad = Math.hypot(j.x, j.y) / (ext || 1);
      if (rad > 0.45) best = Math.min(best, d);
    }
    const got = best < 0.55;
    if (got) covered++;
    console.log(`   ${name.padEnd(6)} nearest outer joint ${(best * 180 / Math.PI).toFixed(0)}° away  ${got ? 'reached' : 'MISSED'}`);
  }
  ok('the skeleton reaches every limb of the figure', covered === limbs.length, `${covered}/${limbs.length}`);
}

/* ------------------------------------------------------------------ task 2 */
// The acceptance criterion: same joint count across small input perturbations.
function taskStability() {
  console.log('\nTASK 2 — skeleton topology is stable under small perturbations');
  const base = build(shoot());
  const n0 = base.rig.joints.length, b0 = base.rig.bones.length;
  console.log(`   reference: ${n0} joints, ${b0} bones`);

  // Each perturbation is something that must not change the SUBJECT: a nudge of
  // the camera, a different noise draw, a change of exposure. None of them alter
  // what is being photographed, so none may alter the rig's topology.
  const cases = [
    ['azimuth +1.5°',   () => shoot({ az: 1.5 })],
    ['azimuth −1.5°',   () => shoot({ az: -1.5 })],
    ['elevation +1.5°', () => shoot({ el: 1.5 })],
    ['fresh noise',     () => shoot()],
    ['noise ×2',        () => shoot({ noise: 4.0 })],
    ['darker ground',   () => shoot({ bg: 210 })],
    ['tighter framing', () => shoot({ span: 0.88 })],
  ];
  let same = 0;
  for (const [name, mk] of cases) {
    const r = build(mk());
    const n = r.rig.joints.length, b = r.rig.bones.length;
    const eq = n === n0 && b === b0;
    if (eq) same++;
    console.log(`   ${name.padEnd(18)} ${String(n).padStart(3)} joints ${String(b).padStart(3)} bones  ${eq ? 'same' : 'DIFFERS'}`);
    ok(`${name} leaves the topology unchanged`, eq, `${n}/${b} vs ${n0}/${b0}`);
  }
  ok('topology is stable across every perturbation', same === cases.length, `${same}/${cases.length}`);

  // Resolution is a harder ask and is scored separately: the joint spacing is a
  // fraction of the subject's own scale, so it SHOULD be resolution-independent,
  // but the medial axis of a 190px silhouette is not the medial axis of a 360px
  // one and the count is allowed to drift by one.
  const draft = build(shoot(), 'draft'), arch = build(shoot(), 'archival');
  const spread = Math.max(n0, draft.rig.joints.length, arch.rig.joints.length)
               - Math.min(n0, draft.rig.joints.length, arch.rig.joints.length);
  console.log(`   across modes: draft ${draft.rig.joints.length}, balanced ${n0}, archival ${arch.rig.joints.length}`);
  ok('joint count barely moves across reconstruction modes', spread <= 2, `spread ${spread}`);
}

/* ------------------------------------------------------------------ task 3 */

function taskWeights() {
  console.log('\nTASK 3 — skin weights');
  const r = build(shoot());
  const nV = r.positions.length / 3, J = r.rig.joints.length;
  const { skinJoints, skinWeights } = r.rig;

  let worst = 0, neg = 0, oob = 0, empty = 0;
  for (let i = 0; i < nV; i++) {
    let s = 0, nz = 0;
    for (let k = 0; k < 4; k++) {
      const wv = skinWeights[i*4+k];
      s += wv; if (wv < 0) neg++; if (wv > 0) nz++;
      if (skinJoints[i*4+k] >= J) oob++;
    }
    if (nz === 0) empty++;
    worst = Math.max(worst, Math.abs(s - 1));
  }
  console.log(`   ${nV} vertices · ${J} joints · worst |Σw − 1| = ${worst.toExponential(2)}`);
  // glTF validators check the stored float32 sum; anything past ~2e-7 is flagged.
  ok('every vertex has weights summing to 1', worst < 2e-7, worst.toExponential(2));
  ok('no negative weights', neg === 0, `${neg}`);
  ok('no joint index out of range', oob === 0, `${oob}`);
  ok('no vertex is left unweighted', empty === 0, `${empty}`);

  // A seam duplicate is the same surface point in the other atlas chart. If the
  // two copies disagreed about their bones the mesh would tear along the
  // silhouette on the first frame of any pose.
  const byPos = new Map();
  let pairs = 0, mismatched = 0;
  for (let i = 0; i < nV; i++) {
    const k = `${r.positions[i*3].toFixed(5)},${r.positions[i*3+1].toFixed(5)},${r.positions[i*3+2].toFixed(5)}`;
    const prev = byPos.get(k);
    if (prev === undefined) { byPos.set(k, i); continue; }
    pairs++;
    for (let c = 0; c < 4; c++) {
      if (skinJoints[i*4+c] !== skinJoints[prev*4+c] ||
          Math.abs(skinWeights[i*4+c] - skinWeights[prev*4+c]) > 1e-6) { mismatched++; break; }
    }
  }
  console.log(`   ${pairs} coincident vertex pairs (atlas seam), ${mismatched} disagreeing`);
  ok('seam duplicates carry identical weights', mismatched === 0, `${mismatched}/${pairs}`);

  // Weight should fall off with distance from the bone, so a vertex out at a
  // limb tip must not be dominated by the root joint at the torso centre.
  let rootHeavy = 0, far = 0;
  for (let i = 0; i < nV; i++) {
    const d = Math.hypot(r.positions[i*3], r.positions[i*3+1]);
    if (d < 0.55) continue;
    far++;
    for (let k = 0; k < 4; k++) if (skinJoints[i*4+k] === 0 && skinWeights[i*4+k] > 0.5) rootHeavy++;
  }
  console.log(`   ${far} vertices in the outer half, ${rootHeavy} of them dominated by the root joint`);
  ok('outer vertices are not bound to the root', rootHeavy / Math.max(1, far) < 0.02,
     `${(rootHeavy / Math.max(1, far) * 100).toFixed(2)}%`);
}

/* ------------------------------------------------------------------ task 4 */

function taskGLB() {
  console.log('\nTASK 4 — the GLB, parsed back out of its own bytes');
  const r = build(shoot());
  const geo = { positions: r.positions, normals: r.normals, uvs: r.uvs,
                indices: r.indices, colors: r.baseColor };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);  // header only; not decoded here

  const stat = glbBytes(geo, png, 'test', null);
  const rig = glbBytes(geo, png, 'test', r.rig);
  console.log(`   static ${(stat.length/1024).toFixed(0)}KB · rigged ${(rig.length/1024).toFixed(0)}KB`
            + ` · skin adds ${((rig.length - stat.length)/1024).toFixed(0)}KB`);

  const gs = parseGLB(stat), gr = parseGLB(rig);
  ok('the static GLB parses', !!gs.json && !!gs.bin, `${gs.size} bytes`);
  ok('the rigged GLB parses', !!gr.json && !!gr.bin, `${gr.size} bytes`);
  ok('the static export has no skin', !gs.json.skins && gs.json.nodes.length === 1, 'unchanged');
  ok('the rigged export has a skin', !!gr.json.skins, `${gr.json.skins[0].joints.length} joints`);

  const es = validate(gs), er = validate(gr);
  es.forEach((e) => console.log(`     static: ${e}`));
  er.forEach((e) => console.log(`     rigged: ${e}`));
  ok('the static GLB is structurally valid', es.length === 0, `${es.length} problems`);
  ok('the rigged GLB is structurally valid', er.length === 0, `${er.length} problems`);

  // Local joint translations must compose back to the world positions the rig
  // reported, or the bind pose does not sit inside the mesh.
  const J = gr.json, sk = J.skins[0];
  const world = (nodeIdx) => {
    const t = [0, 0, 0];
    let cur = nodeIdx, guard = 0;
    while (cur !== undefined && guard++ < J.nodes.length + 2) {
      const n = J.nodes[cur], tr = n.translation || [0, 0, 0];
      t[0] += tr[0]; t[1] += tr[1]; t[2] += tr[2];
      cur = J.nodes.findIndex((m) => (m.children || []).includes(cur));
      if (cur < 0) break;
    }
    return t;
  };
  let worstJ = 0;
  sk.joints.forEach((nodeIdx, j) => {
    const t = world(nodeIdx), p = r.rig.joints[j];
    worstJ = Math.max(worstJ, Math.hypot(t[0] - p.x, t[1] - p.y, t[2] - p.z));
  });
  ok('joint node chain composes to the reported world positions', worstJ < 1e-5, worstJ.toExponential(2));

  // σ has to survive the SKINNED export, which is the one that reorders nothing
  // but adds three bufferViews in the middle. An attribute appended after them
  // and read back by name is the check that it did not land on someone else's
  // bytes: the value is compared against the source array, not merely present.
  {
    const geoS = { ...geo, sigma: r.sigma, sigmaMeta: r.sigStats };
    const gsig = parseGLB(glbBytes(geoS, png, 'test', null));
    const grig = parseGLB(glbBytes(geoS, png, 'test', r.rig));
    const gpbr = parseGLB(glbBytes(geoS, png, 'test', r.rig,
      { roughness: 0.5, normalPng: png }));
    const sizes = [gsig, grig, gpbr].map((g) => g.json.meshes[0].primitives[0].attributes._SIGMA);
    console.log(`   _SIGMA accessor: static ${sizes[0]}, rigged ${sizes[1]}, rigged+PBR ${sizes[2]}`);
    ok('σ survives the static, skinned and PBR exports alike',
       sizes.every((v) => v !== undefined), sizes.join(' / '));

    let worstSig = 0, nSig = 0;
    for (const g of [gsig, grig, gpbr]) {
      const a = g.json.accessors[g.json.meshes[0].primitives[0].attributes._SIGMA];
      const got = readAccessor(g, g.bin, g.json.meshes[0].primitives[0].attributes._SIGMA);
      nSig = a.count;
      for (let i = 0; i < a.count; i++) worstSig = Math.max(worstSig, Math.abs(got[i] - r.sigma[i]));
    }
    ok('the σ read back is the σ that went in', worstSig === 0 && nSig === r.sigma.length,
       `${nSig} values, worst delta ${worstSig}`);

    const ex = gsig.json.meshes[0].primitives[0].extras.ATLAS_sigma;
    console.log(`   extras: ${ex.units}, ×${ex.pxToModel.toFixed(5)} for model units,`
              + ` calibrated ${ex.calibrated}`);
    ok('σ carries its units and its calibration state',
       ex.units === 'working-grid pixels' && ex.pxToModel > 0
       && ex.calibrated === !!r.sigStats.calibrated
       && (ex.calibrated || /UNCALIBRATED/.test(ex.note)),
       `${ex.units} · calibrated ${ex.calibrated}`);

    // ...and an export that was given no σ must be the file it always was.
    const plain = glbBytes(geo, png, 'test', null);
    ok('an export without σ is byte-identical to before it existed',
       plain.length === stat.length && plain.every((b, i) => b === stat[i]),
       `${plain.length} bytes`);
  }

  // ...and the inverse bind matrices must invert exactly that.
  const ibm = readAccessor(gr, gr.bin, sk.inverseBindMatrices);
  let worstI = 0;
  sk.joints.forEach((nodeIdx, j) => {
    const p = r.rig.joints[j], o = j * 16;
    worstI = Math.max(worstI, Math.hypot(ibm[o+12] + p.x, ibm[o+13] + p.y, ibm[o+14] + p.z));
    worstI = Math.max(worstI, Math.abs(ibm[o] - 1), Math.abs(ibm[o+5] - 1),
                      Math.abs(ibm[o+10] - 1), Math.abs(ibm[o+15] - 1));
  });
  ok('inverse bind matrices invert the bind pose', worstI < 1e-5, worstI.toExponential(2));
}

/* ------------------------------------------------------------------ task 5 */
// Skinning is only real if the mesh moves. Compute linear blend skinning by
// hand, exactly as a runtime would: for joint j with global transform G_j,
//   v' = Σ w_i · G_{j(i)} · IBM_{j(i)} · v
// In the bind pose every G_j is its own bind transform, so G·IBM is the identity
// and v' must equal v. Rotate one joint and only the surface bound to it moves.
function taskSkinningMoves() {
  console.log('\nTASK 5 — the skin actually deforms, and only where it should');
  const r = build(shoot());
  const g = parseGLB(glbBytes({ positions: r.positions, normals: r.normals, uvs: r.uvs,
                                indices: r.indices, colors: r.baseColor },
                              new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                              'test', r.rig));
  const J = g.json, sk = J.skins[0], nJ = sk.joints.length;
  const pos = readAccessor(g, g.bin, J.meshes[0].primitives[0].attributes.POSITION);
  const ji = readAccessor(g, g.bin, J.meshes[0].primitives[0].attributes.JOINTS_0);
  const jw = readAccessor(g, g.bin, J.meshes[0].primitives[0].attributes.WEIGHTS_0);
  const ibm = readAccessor(g, g.bin, sk.inverseBindMatrices);
  const nV = pos.length / 3;

  // Bind-pose global transforms are pure translations, so keep them as such.
  const bind = r.rig.joints.map((p) => [p.x, p.y, p.z]);

  // Apply skinning where joint `rot` (and its descendants) is rotated by `ang`
  // about z, about its own bind position.
  const skinAll = (rot, ang) => {
    const desc = new Uint8Array(nJ);
    if (rot >= 0) {
      desc[rot] = 1;
      // joints are emitted parent-before-child, so one forward pass suffices
      for (let j = 0; j < nJ; j++) { const p = r.rig.joints[j].parent; if (p >= 0 && desc[p]) desc[j] = 1; }
    }
    const c = Math.cos(ang), s = Math.sin(ang);
    const piv = rot >= 0 ? bind[rot] : [0, 0, 0];
    // Global transform of each joint: bind translation, then the rotation about
    // the pivot for the rotated subtree.
    const G = bind.map((b, j) => {
      if (!desc[j]) return { m: [1,0,0, 0,1,0, 0,0,1], t: [b[0], b[1], b[2]] };
      const dx = b[0] - piv[0], dy = b[1] - piv[1];
      return { m: [c,-s,0, s,c,0, 0,0,1],
               t: [piv[0] + c*dx - s*dy, piv[1] + s*dx + c*dy, b[2]] };
    });
    const out = new Float32Array(nV * 3);
    for (let i = 0; i < nV; i++) {
      let ox = 0, oy = 0, oz = 0;
      for (let k = 0; k < 4; k++) {
        const wv = jw[i*4+k]; if (wv <= 0) continue;
        const j = ji[i*4+k], o = j * 16;
        // IBM is a pure translation: v_local = v + ibm.t
        const lx = pos[i*3] + ibm[o+12], ly = pos[i*3+1] + ibm[o+13], lz = pos[i*3+2] + ibm[o+14];
        const M = G[j].m, T = G[j].t;
        ox += wv * (M[0]*lx + M[1]*ly + M[2]*lz + T[0]);
        oy += wv * (M[3]*lx + M[4]*ly + M[5]*lz + T[1]);
        oz += wv * (M[6]*lx + M[7]*ly + M[8]*lz + T[2]);
      }
      out[i*3] = ox; out[i*3+1] = oy; out[i*3+2] = oz;
    }
    return out;
  };

  const rest = skinAll(-1, 0);
  let worstRest = 0;
  for (let i = 0; i < nV * 3; i++) worstRest = Math.max(worstRest, Math.abs(rest[i] - pos[i]));
  console.log(`   bind pose reproduces the mesh to ${worstRest.toExponential(2)}`);
  ok('the bind pose is the identity', worstRest < 2e-5, worstRest.toExponential(2));

  // Rotate the joint that carries the most surface — the limb a rigger would
  // actually swing. Picking a leaf instead measures the least informative bone
  // in the skeleton: on this figure that was the tip of the head, whose whole
  // influence is 3.6% of the mesh moving by 0.009 model units, so an absolute
  // displacement threshold there is testing the fixture's proportions rather
  // than the skinning.
  const carried = new Float64Array(nJ);
  for (let i = 0; i < nV; i++) for (let k = 0; k < 4; k++) carried[ji[i*4+k]] += jw[i*4+k];
  let pick = -1, best = -1;
  for (let j = 1; j < nJ; j++) if (carried[j] > best) { best = carried[j]; pick = j; }
  ok('the skeleton has a joint carrying surface to swing', pick > 0,
     `joint ${pick}, ${best.toFixed(0)} vertex-weights`);

  // Model extent, so displacement can be judged in units of the subject.
  let ext = 0;
  for (let i = 0; i < nV; i++) ext = Math.max(ext, Math.hypot(pos[i*3], pos[i*3+1], pos[i*3+2]));

  const posed = skinAll(pick, 0.6);
  let moved = 0, still = 0, maxMove = 0;
  for (let i = 0; i < nV; i++) {
    const d = Math.hypot(posed[i*3] - rest[i*3], posed[i*3+1] - rest[i*3+1], posed[i*3+2] - rest[i*3+2]);
    if (d > 1e-4) moved++; else still++;
    maxMove = Math.max(maxMove, d);
  }
  console.log(`   rotating joint ${pick} by 34°: ${moved} vertices move`
            + ` (max ${f(maxMove, 4)} = ${(maxMove / ext * 100).toFixed(1)}% of the model), ${still} stay`);
  ok('rotating a joint moves part of the mesh', moved > nV * 0.01 && maxMove > 0.05 * ext,
     `${(moved/nV*100).toFixed(1)}% moved, max ${(maxMove/ext*100).toFixed(1)}% of extent`);
  ok('rotating one joint does not move the whole mesh', moved < nV * 0.9,
     `${(moved / nV * 100).toFixed(1)}% moved`);

  // The mesh must not come apart: linear blend skinning of a watertight mesh
  // with weights summing to 1 keeps coincident vertices coincident.
  const byPos = new Map();
  let torn = 0;
  for (let i = 0; i < nV; i++) {
    const k = `${pos[i*3].toFixed(5)},${pos[i*3+1].toFixed(5)},${pos[i*3+2].toFixed(5)}`;
    const prev = byPos.get(k);
    if (prev === undefined) { byPos.set(k, i); continue; }
    const d = Math.hypot(posed[i*3] - posed[prev*3], posed[i*3+1] - posed[prev*3+1],
                         posed[i*3+2] - posed[prev*3+2]);
    if (d > 1e-5) torn++;
  }
  ok('the posed mesh does not tear at the atlas seam', torn === 0, `${torn} split pairs`);
}

/* ------------------------------------------------------------------ task 6 */
// What the ρ criterion does and does not catch, measured rather than asserted.
function taskWaists() {
  console.log('\nTASK 6 — waists, from ρ and from A');
  const r = build(shoot());
  console.log(`   figure: ${r.rig.stats.waists} waist(s), ρ floor ${r.rig.stats.rhoFloor.toFixed(3)},`
            + ` prominence ${r.rig.stats.rhoProm.toFixed(3)}`);
  ok('the waist test runs and reports', Number.isFinite(r.rig.stats.rhoFloor)
     && Number.isFinite(r.rig.stats.rhoProm), `floor ${r.rig.stats.rhoFloor.toFixed(2)}`);

  // A subject whose waist is unambiguously mid-branch: a long bar pinched in the
  // middle. This is the case the criterion is FOR, and it localises it.
  const w = 280, h = 200;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const halfW = 26 - 17 * Math.exp(0 - ((x + 0.5 - 140) / 22) ** 2);
    const s = x + 0.5 > 30 && x + 0.5 < 250 && Math.abs(y + 0.5 - 100) < halfW;
    const v = s ? 96 : 236;
    px[i*4] = v; px[i*4+1] = v * (s ? 0.92 : 1); px[i*4+2] = v * (s ? 0.86 : 1); px[i*4+3] = 255;
  }
  const pr = reconstruct(px, w, h, 'balanced', () => {});
  const gx = pr.rig.joints.map((j) => j.gx);
  const nearest = gx.reduce((b, v) => (Math.abs(v - 140) < Math.abs(b - 140) ? v : b), 1e9);
  console.log(`   pinched bar: ${pr.rig.stats.waists} waist(s); joints at x = ${gx.map((v) => v.toFixed(0)).join(', ')}`);
  console.log(`   the pinch is at x = 140; nearest joint is at x = ${nearest.toFixed(0)}`);
  ok('a mid-branch pinch is found', pr.rig.stats.waists >= 1, `${pr.rig.stats.waists}`);
  ok('and the joint lands on it', Math.abs(nearest - 140) <= 4, `${Math.abs(nearest - 140).toFixed(1)}px away`);
}

/* ------------------------------------------------------------------ task 7 */
// The A criterion, and the case ρ alone could not do.
//
// A dumbbell — two lobes joined by a parallel-sided neck — is the shape ρ is
// worst on, and it is worst on it structurally rather than by tuning. ρ arrives
// through a masked blur of radius 6 run four times on a coarse grid, so across a
// neck it is a PLATEAU and not a peak, and a plateau scores zero prominence
// against its own level flank. The neck also lands at the FOOT of the first
// branch, because the root claims its whole lobe, so before the stem context the
// near flank was not on the branch at all and neither criterion could see it.
//
// Swept across the neck width so the result is a range and not a single lucky
// point: the neck is 6 to 20px of half-width against 46px lobes.
function taskDumbbell() {
  console.log('\nTASK 7 — the dumbbell, which ρ alone could not split');
  const w = 280, h = 180, R = 46, sepc = 62, cx = w / 2;
  const shape = (neckHalf) => {
    const px = new Uint8ClampedArray(w * h * 4);
    const cy = h / 2, c1 = cx - sepc, c2 = cx + sepc;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, X = x + 0.5, Y = y + 0.5;
      const s = (X-c1)**2 + (Y-cy)**2 <= R*R || (X-c2)**2 + (Y-cy)**2 <= R*R
             || (X > c1 && X < c2 && Math.abs(Y - cy) <= neckHalf);
      const v = s ? 96 : 236;
      px[i*4] = v; px[i*4+1] = v*(s?0.92:1); px[i*4+2] = v*(s?0.86:1); px[i*4+3] = 255;
    }
    return px;
  };

  console.log('   neck   joints   waists (ρ, A)   nearest joint to the neck');
  let split = 0, byA = 0;
  const necks = [6, 8, 10, 12, 14, 16, 18, 20];
  for (const nh of necks) {
    const d = reconstruct(shape(nh), w, h, 'balanced', () => {});
    const st = d.rig.stats;
    // The neck spans the gap between the two lobes; a joint counts as splitting
    // it if it lands inside that span rather than on either lobe.
    const half = sepc - Math.sqrt(Math.max(0, R*R - nh*nh));      // half the neck's length
    const inNeck = d.rig.joints.filter((j) => Math.abs(j.gx - cx) <= half + 2).length;
    const near = d.rig.joints.reduce((b, j) => Math.abs(j.gx - cx) < Math.abs(b - cx) ? j.gx : b, 1e9);
    if (inNeck >= 1) split++;
    if (st.waistsA >= 1) byA++;
    console.log(`   ${String(nh).padStart(3)}px  ${String(st.joints).padStart(6)}`
      + `   ${String(st.waists).padStart(6)} (${st.waistsRho}, ${st.waistsA})`
      + `        ${Math.abs(near - cx).toFixed(0).padStart(3)}px off centre`
      + `   ${inNeck ? 'SPLITS' : 'misses'}`);
  }
  ok('the dumbbell neck splits at every neck width', split === necks.length, `${split}/${necks.length}`);
  ok('and the A criterion fires on every one of them', byA === necks.length, `${byA}/${necks.length}`);

  // The second half of the acceptance criterion, and the one that constrains
  // rather than enables: a second detector must not manufacture joints on a
  // subject the first one already handled. Measured over the whole perturbation
  // suite, not just the reference shot, because "unchanged" has to mean
  // unchanged under the things that do not change the subject either.
  console.log('\n   the limbed figure, which ρ already handled:');
  const cases = [['reference', {}], ['azimuth +1.5°', { az: 1.5 }], ['azimuth −1.5°', { az: -1.5 }],
                 ['elevation +1.5°', { el: 1.5 }], ['noise ×2', { noise: 4.0 }],
                 ['darker ground', { bg: 210 }], ['tighter framing', { span: 0.88 }]];
  let quiet = 0;
  for (const [name, o] of cases) {
    const f = build(shoot(o)).rig.stats;
    if (f.waistsA === 0) quiet++;
    console.log(`   ${name.padEnd(18)} ${String(f.joints).padStart(2)} joints`
      + `   ρ-waists ${f.waistsRho}   A-waists ${f.waistsA}`);
  }
  ok('A adds no waist to the figure ρ already explains', quiet === cases.length, `${quiet}/${cases.length}`);

  // The thresholds are the subject's own quantiles, so they have to move with
  // the subject rather than being constants wearing a quantile's name.
  const fig = build(shoot()).rig.stats, dum = reconstruct(shape(9), w, h, 'balanced', () => {}).rig.stats;
  console.log(`   A ceiling: figure ${fig.aCeil.toFixed(2)}px (amax ${fig.amax.toFixed(1)})`
            + ` · dumbbell ${dum.aCeil.toFixed(2)}px (amax ${dum.amax.toFixed(1)})`);
  ok('the A thresholds are read off the subject, not fixed',
     dum.aCeil > 2 * fig.aCeil && dum.aProm !== fig.aProm,
     `${fig.aCeil.toFixed(2)} vs ${dum.aCeil.toFixed(2)}`);
}

taskSkeleton(); taskStability(); taskWeights(); taskGLB(); taskSkinningMoves(); taskWaists();
taskDumbbell();

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
