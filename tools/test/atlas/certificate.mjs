// The provenance certificate, and whether any of it can be trusted.
//   node tools/test/atlas/certificate.mjs
//
// A certificate is worth exactly as much as its weakest field, so this suite is
// built around one idea: EVERY LEAF OF THE DOCUMENT MUST BE ACCOUNTED FOR. The
// registry below names every field the certificate can contain and says how that
// field is known to come from a real computation; the suite then walks the actual
// certificate and fails if it finds a leaf the registry does not cover. Adding a
// field without saying where it comes from breaks the build, which is the only
// way "nothing displayed is invented" survives contact with a growing document.
//
// Four kinds of account, and nothing else is allowed:
//
//   derived      recomputed here, independently, and compared. The strongest.
//   rederived    the verifier reads it back out of the exported GLB itself, so a
//                certificate that lies about it fails verification.
//   calibration  a measurement from tools/test/atlas/uncertainty.mjs, pinned in
//                CALIBRATION_REPORT, which that suite re-checks on every run.
//   declared     a fixed string or a structural constant, asserted literally.
//   unknown      not computable for this artifact, and listed with a reason.
import { reconstruct, topology } from '../../../src/atlas/atlas-core.js';
import { glbBytes } from '../../../src/atlas/exporters.js';
import { CALIBRATION_REPORT, SIGMA_CALIBRATED, NU, PREDICTIVE, intervalK } from '../../../src/atlas/uncertainty.js';
import { buildCertificate, signCertificate, verifyCertificate, signingKey,
         canonicalJSON, sha256Hex, readGLB, keyFingerprint,
         nbvFromGLB, CERT_FORMAT, SIG_ALG } from '../../../src/atlas/certificate.js';
import { GREEDY_SET_DOMINANCE, FLAT_RATIO } from '../../../src/atlas/nbv.js';
import { VIEWER_ONLY_EFFECTS } from '../../../src/atlas/render-state.js';
import { render, camera, FIGURE, reseed } from './multiview.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail}`);
};

const W = 200, H = 260;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A second, deliberately different subject: the "derived" account is proved by
// showing a field MOVES with the input rather than being a constant wearing a
// number's clothes.
const OTHER = [
  [ 0.00,  0.00,  0.00, 0.34, 0.40, 0.20],
  [ 0.00,  0.30,  0.05, 0.24, 0.22, 0.16],
];

async function make(parts, opts = {}) {
  reseed(97);
  const im = render(camera(0, 0, 3.2, 2.6), W, H, parts ? { parts } : {});
  const r = reconstruct(im.px, W, H, opts.mode || 'balanced', () => {});
  const geo = { positions: r.positions, normals: r.normals, uvs: r.uvs, indices: r.indices,
                colors: r.baseColor, sigma: r.sigma, sigmaMeta: r.sigStats };
  const pbr = opts.albedo ? { roughness: r.pbr.roughness || 0.5, normalPng: PNG } : null;
  const glb = glbBytes(geo, PNG, opts.id || 'test', opts.rigged === false ? null : r.rig, pbr);
  const cert0 = await buildCertificate({ result: r, glb, input: im.px,
                                         calibration: CALIBRATION_REPORT,
                                         viewerOnlyEffects: VIEWER_ONLY_EFFECTS,
                                         id: opts.id || 'test' });
  cert0.rig.exported = opts.rigged !== false;
  cert0.material.exportedAlbedo = !!opts.albedo;
  cert0.material.bakedColourFallback = !opts.albedo;
  const key = await signingKey(null);
  const cert = await signCertificate(cert0, key);
  return { r, glb, cert, key, im };
}

/* ------------------------------------------------------------------ task 1 */

async function taskRoundTrip(A) {
  console.log('\nTASK 1 — the certificate verifies against the bytes it describes');
  const v = await verifyCertificate(A.cert, A.glb);
  for (const c of v.checks) if (!c.pass) console.log(`     FAILED CHECK: ${c.name} — ${c.detail}`);
  console.log(`   ${v.checks.length} checks re-derived from the GLB, ${v.checks.filter((c) => c.pass).length} pass`);
  ok('a freshly exported artifact verifies', v.ok, `${v.checks.length} checks`);
  ok('the verifier re-derives rather than restates',
     v.checks.some((c) => c.name === 'triangle count') && v.checks.some((c) => c.name === 'watertight')
     && v.checks.some((c) => c.name === 'σ median') && v.checks.some((c) => c.name === 'joint count'),
     'topology, σ and the skin all come back out of the file');

  const fp = await keyFingerprint(A.cert.signature.publicKey);
  console.log(`   signature ${A.cert.signature.alg} · key fingerprint ${fp}`
            + ` · ephemeral ${A.cert.signature.ephemeral}`);
  ok('the signature names its algorithm and its limits', A.cert.signature.alg === SIG_ALG
     && /INTEGRITY, not identity/.test(A.cert.signature.binds), SIG_ALG);
  ok('the key fingerprint is stable and short', !!fp && fp.length === 16
     && fp === await keyFingerprint(A.cert.signature.publicKey), fp);
}

/* ------------------------------------------------------------------ task 2 */
// Tampering. Each case edits ONE thing and the verifier must notice.

async function taskTamper(A) {
  console.log('\nTASK 2 — tampering, one edit at a time');
  const cases = [];

  // (a) the mesh bytes: flip a single bit deep in the vertex data
  {
    const glb2 = Uint8Array.from(A.glb);
    glb2[Math.floor(glb2.length * 0.55)] ^= 0x01;
    cases.push(['one bit flipped in the mesh', A.cert, glb2]);
  }
  // (b) the mesh hash: claim a different mesh
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.mesh.sha256 = c2.mesh.sha256.replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a'));
    cases.push(['the mesh hash edited', c2, A.glb]);
  }
  // (c) a claim about the mesh: say it is watertight when the file says otherwise
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.mesh.triangles = c2.mesh.triangles + 1;
    cases.push(['the triangle count inflated by one', c2, A.glb]);
  }
  // (d) THE ONE THAT MATTERS MOST: claim a calibration the mesh does not carry
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.sigma.calibrated = true;
    cases.push(['σ upgraded to "calibrated"', c2, A.glb]);
  }
  // (e) a σ summary that flatters the artifact
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.sigma.scalePx.median = +(c2.sigma.scalePx.median * 0.5).toFixed(4);
    cases.push(['the median σ halved', c2, A.glb]);
  }
  // (f) the material claim
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.material.exportedAlbedo = true; c2.material.bakedColourFallback = false;
    cases.push(['a baked asset relabelled relightable', c2, A.glb]);
  }
  // (g) an "unknown" quietly filled in
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.lens.mm35 = 50;
    cases.push(['an unknown lens given a focal length', c2, A.glb]);
  }
  // (h) the signature itself
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    const raw = atob(c2.signature.value).split('');
    raw[3] = String.fromCharCode(raw[3].charCodeAt(0) ^ 0x40);
    c2.signature.value = btoa(raw.join(''));
    cases.push(['one byte of the signature flipped', c2, A.glb]);
  }
  // (i) re-signed with a different key, which is what a forger would actually do
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.mesh.triangles = c2.mesh.triangles + 1;
    const forged = await signCertificate(c2, await signingKey(null));
    cases.push(['re-signed after editing, with a fresh key', forged, A.glb]);
  }
  // (j) the retake guidance pointed somewhere else, and RE-SIGNED — so the
  // signature cannot be what catches it. The recommendation has to be defended
  // by re-derivation like every other claim, or "shoot from here" is an opinion
  // wearing a certificate.
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.nextBestView.selectedAzimuthDeg = +((c2.nextBestView.selectedAzimuthDeg + 30) % 360).toFixed(2);
    cases.push(['the recommended direction moved 30°, re-signed',
                await signCertificate(c2, await signingKey(null)), A.glb]);
  }
  // (k) ...and the failed K-view claim upgraded to a passing one, re-signed.
  {
    const c2 = JSON.parse(JSON.stringify(A.cert));
    c2.nextBestView.sequenceValidated = true;
    cases.push(['the unvalidated view sequence marked validated, re-signed',
                await signCertificate(c2, await signingKey(null)), A.glb]);
  }

  let caught = 0;
  for (const [name, cert, glb] of cases) {
    const v = await verifyCertificate(cert, glb);
    const failed = v.checks.filter((c) => !c.pass).map((c) => c.name);
    if (!v.ok) caught++;
    console.log(`   ${name.padEnd(42)} ${v.ok ? 'NOT CAUGHT' : 'caught by ' + failed.join(', ')}`);
    ok(`tampering is caught: ${name}`, !v.ok, v.ok ? 'verification still passed' : failed[0]);
  }
  ok('every tampering case is caught', caught === cases.length, `${caught}/${cases.length}`);
}

/* ------------------------------------------------------------------ task 3 */
// Every leaf accounted for. The registry is the contract.

async function taskTraceability(A, B) {
  console.log('\nTASK 3 — every field accounts for where it came from');
  const a = A.cert, b = B.cert;
  const gA = readGLB(A.glb);
  const topoA = topology(A.r.positions, A.r.indices);

  // moved(x) — this field is not a constant: it differs between two subjects.
  const moved = (path) => get(a, path) !== get(b, path);
  const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

  const R = {};
  const derive = (path, why, pass) => { R[path] = { kind: 'derived', why, pass }; };
  const rederived = (path, why) => { R[path] = { kind: 'rederived', why, pass: true }; };
  const declared = (path, value) => {
    R[path] = { kind: 'declared', why: `fixed: ${String(value).slice(0, 40)}`,
                pass: get(a, path) === value };
  };
  const calib = (path, value) => {
    R[path] = { kind: 'calibration', why: 'pinned in CALIBRATION_REPORT',
                pass: JSON.stringify(get(a, path)) === JSON.stringify(value) };
  };

  declared('format', CERT_FORMAT);
  declared('generator', 'ATLAS/ONE');
  declared('id', 'test');
  declared('mode', 'balanced');

  derive('input.sha256', 'SHA-256 of the source pixels', get(a, 'input.sha256') === await sha256Hex(A.im.px));
  derive('input.bytes', 'length of the source pixels', get(a, 'input.bytes') === A.im.px.length);
  derive('input.workingGrid.width', 'the grid reconstruct ran on', get(a, 'input.workingGrid.width') === W);
  derive('input.workingGrid.height', 'the grid reconstruct ran on', get(a, 'input.workingGrid.height') === H);
  derive('input.textureSource.width', 'the atlas source width', get(a, 'input.textureSource.width') === A.r.stats.texW);
  derive('input.textureSource.height', 'the atlas source height', get(a, 'input.textureSource.height') === A.r.stats.texH);

  derive('mesh.sha256', 'SHA-256 of the exported GLB', get(a, 'mesh.sha256') === await sha256Hex(A.glb));
  derive('mesh.bytes', 'length of the exported GLB', get(a, 'mesh.bytes') === A.glb.length);
  rederived('mesh.vertices', 'counted from the POSITION accessor');
  rederived('mesh.triangles', 'counted from the index accessor');
  rederived('mesh.watertight', 'topology() recomputed on the parsed mesh');
  rederived('mesh.boundaryEdges', 'topology() recomputed on the parsed mesh');
  rederived('mesh.nonManifoldEdges', 'topology() recomputed on the parsed mesh');
  rederived('mesh.shells', 'topology() recomputed on the parsed mesh');

  derive('registration.silhouetteIoU', 'the solid re-rendered at the input camera',
         Math.abs(get(a, 'registration.silhouetteIoU') - A.r.reproj.iou) < 5e-5 && moved('registration.silhouetteIoU'));
  derive('registration.silhouetteOffsetPx', 'symmetric difference over perimeter',
         Math.abs(get(a, 'registration.silhouetteOffsetPx') - A.r.reproj.offsetPx) < 5e-5);
  derive('registration.perimeterPx', 'boundary pixels of the input matte',
         get(a, 'registration.perimeterPx') === A.r.reproj.perimeter && moved('registration.perimeterPx'));
  declared('registration.supersample', 3);
  R['registration.backViewIoU'] = { kind: 'unknown', why: 'no back view', pass: true };
  R['registration.profileSelfConsistency'] = { kind: 'unknown', why: 'no profile view', pass: true };
  derive('registration.profileRows', 'rows the profile constrained', get(a, 'registration.profileRows') === 0);
  derive('registration.views', 'how many photographs entered', get(a, 'registration.views') === 1);

  for (const k of ['measured', 'inflated', 'authored']) {
    derive(`provenance.${k}`, 'area-weighted over triangles from agen and the shared fraction',
           Math.abs(get(a, `provenance.${k}`) - A.r.prov[k]) < 5e-5 && moved(`provenance.${k}`));
  }
  declared('provenance.basis', a.provenance.basis);

  declared('sigma.family', PREDICTIVE);
  declared('sigma.nu', NU);
  derive('sigma.intervals.0.level', 'the levels the calibration is scored at', a.sigma.intervals[0].level === 0.68);
  derive('sigma.intervals.0.k', 't-quantile at ν', Math.abs(a.sigma.intervals[0].k - intervalK(0.68)) < 5e-5);
  derive('sigma.intervals.1.level', 'the levels the calibration is scored at', a.sigma.intervals[1].level === 0.95);
  derive('sigma.intervals.1.k', 't-quantile at ν', Math.abs(a.sigma.intervals[1].k - intervalK(0.95)) < 5e-5);
  declared('sigma.calibrated', SIGMA_CALIBRATED);
  // Leaf by leaf, not object by object: the walk below descends, and registering
  // a container would leave its contents unaccounted for. That is not pedantry —
  // it is the difference between "the coverage block is fine" and "each number in
  // it is the one the calibration suite measured".
  CALIBRATION_REPORT.levels.forEach((L, i) => {
    calib(`sigma.heldOutCoverage.${i}.level`, L);
    calib(`sigma.heldOutCoverage.${i}.measured`, CALIBRATION_REPORT.heldOutCoverage[i]);
  });
  calib('sigma.nll.sigma', CALIBRATION_REPORT.nll.sigma);
  calib('sigma.nll.constantSameFamily', CALIBRATION_REPORT.nll.constantSameFamily);
  calib('sigma.validation', CALIBRATION_REPORT.validation);
  calib('sigma.caveat', CALIBRATION_REPORT.caveat);
  rederived('sigma.scalePx.median', 'quantile of the _SIGMA accessor');
  rederived('sigma.scalePx.p90', 'quantile of the _SIGMA accessor');
  rederived('sigma.scalePx.min', 'extremum of the _SIGMA accessor');
  rederived('sigma.scalePx.max', 'extremum of the _SIGMA accessor');
  derive('sigma.pxToModel', 'S ∕ max(w, h) from the framing',
         Math.abs(a.sigma.pxToModel - A.r.sigStats.pxToModel) < 1e-9);
  declared('sigma.along', 'vertex normal');

  derive('lens.known', 'whether EXIF carried a focal length', a.lens.known === A.r.cam.known);
  R['lens.source'] = { kind: 'unknown', why: 'no EXIF in a rendered fixture', pass: true };
  R['lens.mm35'] = { kind: 'unknown', why: 'no EXIF in a rendered fixture', pass: true };
  R['lens.fRel'] = { kind: 'unknown', why: 'no EXIF in a rendered fixture', pass: true };
  derive('lens.cropChecked', 'whether the aspect could be checked', a.lens.cropChecked === false);
  derive('lens.projection', 'orthographic when no lens is known', a.lens.projection === 'orthographic');

  derive('material.relightable', 'the Lambertian fit was strong enough to divide out',
         a.material.relightable === !!(A.r.pbr && A.r.pbr.ok));
  rederived('material.exportedAlbedo', 'the normal map is present in the file or it is not');
  rederived('material.bakedColourFallback', 'the complement of exportedAlbedo, checked against the file');
  derive('material.delightingR2', 'R² of the single-light Lambertian fit',
         Math.abs(a.material.delightingR2 - A.r.pbr.r2) < 5e-5 && moved('material.delightingR2'));
  derive('material.roughness', 'from the fit residual', Math.abs(a.material.roughness - A.r.pbr.roughness) < 5e-5);
  derive('material.declineReason', 'null when the fit held', a.material.declineReason === null);

  // THE RETAKE GUIDANCE. Every one of these is `rederived`, which is the strong
  // account: the utility landscape is a function of the POSITION, NORMAL and
  // _SIGMA accessors in the exported file, so the verifier recomputes it from
  // the bytes and compares exactly. Note what is NOT here — no leaf claims a
  // second view is used, fused or reconstructed from, because the product does
  // not do that and the registry is where that stays true.
  declared('nextBestView.guidance', a.nextBestView.guidance);
  rederived('nextBestView.candidateCount', 'the lattice recomputed from the file');
  rederived('nextBestView.sampleCount', 'the decimation recomputed from the file');
  rederived('nextBestView.flatLandscape', 'max∕median of the recomputed utility, against FLAT_RATIO');
  rederived('nextBestView.topOverMedianUtility', 'the recomputed utility quantiles');
  // A flat subject has no direction to point at, and that is an answer. Here the
  // fixture is NOT flat, so the direction is a real re-derived number; the flat
  // case is exercised separately, below.
  rederived('nextBestView.selectedAzimuthDeg', 'argmax of the recomputed utility');
  rederived('nextBestView.selectedElevationDeg', 'argmax of the recomputed utility');
  declared('nextBestView.qualitative', true);
  declared('nextBestView.singleViewValidated', true);
  declared('nextBestView.sequenceValidated', GREEDY_SET_DOMINANCE);
  declared('nextBestView.validation', a.nextBestView.validation);

  rederived('rig.joints', 'counted from skins[0].joints');
  derive('rig.bones', 'from the skeleton the medial axis produced', a.rig.bones === A.r.rig.stats.bones);
  derive('rig.branches', 'traced branches that survived pruning', a.rig.branches === A.r.rig.stats.branches);
  derive('rig.waists', 'waist candidates that became joints', a.rig.waists === A.r.rig.stats.waists);
  derive('rig.waistsRho', 'the ρ criterion\'s own count', a.rig.waistsRho === A.r.rig.stats.waistsRho);
  derive('rig.waistsA', 'the A criterion\'s own count', a.rig.waistsA === A.r.rig.stats.waistsA);
  rederived('rig.exported', 'whether this file carries a skin');

  // WHAT THE RENDER ADDED THAT THE BYTES DO NOT CARRY. Leaf by leaf, like the
  // coverage block: registering the array would leave its contents unaccounted
  // for, and the contents are the whole disclosure. `declared` is the right
  // account — these are not derivable from the file, which is precisely why they
  // have to be written down. That the list matches what any particular renderer
  // does is not checkable from a certificate and is not claimed here: the
  // disclosure is that these effects exist and are not in the bytes.
  VIEWER_ONLY_EFFECTS.forEach((e, i) => {
    declared(`viewerOnlyEffects.${i}.id`, e.id);
    declared(`viewerOnlyEffects.${i}.what`, e.what);
  });

  declared('signature.alg', SIG_ALG);
  R['signature.value'] = { kind: 'derived', why: 'ECDSA over the canonical body', pass: true };
  R['signature.publicKey.kty'] = { kind: 'derived', why: 'exported from the signing key', pass: true };
  R['signature.publicKey.crv'] = { kind: 'derived', why: 'exported from the signing key', pass: true };
  R['signature.publicKey.x'] = { kind: 'derived', why: 'exported from the signing key', pass: true };
  R['signature.publicKey.y'] = { kind: 'derived', why: 'exported from the signing key', pass: true };
  R['signature.ephemeral'] = { kind: 'derived', why: 'whether the key was persisted', pass: true };
  declared('signature.binds', a.signature.binds);

  // walk the real document and demand an account for every leaf
  const leaves = [];
  const walk = (v, p) => {
    if (v === null || typeof v !== 'object') { leaves.push(p); return; }
    if (Array.isArray(v)) { v.forEach((e, i) => walk(e, `${p}.${i}`)); return; }
    for (const k of Object.keys(v)) walk(v[k], p ? `${p}.${k}` : k);
  };
  walk(a, '');
  // `unknown[]` is the explanation list itself, not a set of claims
  const claims = leaves.filter((p) => !p.startsWith('unknown.'));

  const uncovered = claims.filter((p) => !R[p]);
  const failed = claims.filter((p) => R[p] && !R[p].pass);
  const byKind = {};
  for (const p of claims) if (R[p]) byKind[R[p].kind] = (byKind[R[p].kind] || 0) + 1;
  console.log(`   ${claims.length} leaf claims · `
    + Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · '));
  if (uncovered.length) console.log(`   UNACCOUNTED: ${uncovered.join(', ')}`);
  if (failed.length) for (const p of failed) console.log(`   WRONG: ${p} (${R[p].why})`);

  ok('every leaf of the certificate has an account', uncovered.length === 0,
     uncovered.length ? uncovered.join(', ') : `${claims.length} fields`);
  ok('every account holds', failed.length === 0,
     failed.length ? failed.join(', ') : `${claims.length} checked`);
  ok('nothing is accounted for as "declared" that should move with the subject',
     ['registration.silhouetteIoU', 'provenance.measured', 'material.delightingR2',
      'mesh.sha256', 'input.sha256'].every((p) => R[p].kind === 'derived' && moved(p)),
     'the derived fields differ between two subjects');

  // and the unknowns are explained, not merely absent
  const listed = new Set(a.unknown.map((u) => u.field));
  const unknownFields = Object.entries(R).filter(([, v]) => v.kind === 'unknown').map(([k]) => k);
  console.log(`   ${a.unknown.length} unknown fields, each with a reason:`);
  for (const u of a.unknown) console.log(`     ${u.field.padEnd(38)} ${u.why}`);
  ok('every unknown field is listed with a reason',
     unknownFields.every((f) => listed.has(f)) && a.unknown.every((u) => u.why && u.why.length > 4),
     `${a.unknown.length} listed`);
}

/* ------------------------------------------------------------------ task 4 */
// The flags a reader most needs, and whether they survive the trip.

async function taskFlags() {
  console.log('\nTASK 4 — the flags a reader has to be able to see');

  const baked = await make(null, { id: 'baked', albedo: false });
  const albedo = await make(null, { id: 'albedo', albedo: true });
  console.log(`   baked   : exportedAlbedo ${baked.cert.material.exportedAlbedo}`
    + ` · bakedColourFallback ${baked.cert.material.bakedColourFallback}`
    + ` · R² ${baked.cert.material.delightingR2}`);
  console.log(`   albedo  : exportedAlbedo ${albedo.cert.material.exportedAlbedo}`
    + ` · bakedColourFallback ${albedo.cert.material.bakedColourFallback}`);
  ok('a baked-colour export says so', baked.cert.material.bakedColourFallback === true
     && baked.cert.material.exportedAlbedo === false, 'bakedColourFallback true');
  ok('an albedo export says so', albedo.cert.material.exportedAlbedo === true
     && albedo.cert.material.bakedColourFallback === false, 'exportedAlbedo true');
  ok('both verify against their own bytes',
     (await verifyCertificate(baked.cert, baked.glb)).ok
     && (await verifyCertificate(albedo.cert, albedo.glb)).ok, 'two artifacts, two certificates');
  // ...and neither verifies against the other's, which is what makes the flag mean something
  ok('a certificate does not verify against the other artifact',
     !(await verifyCertificate(baked.cert, albedo.glb)).ok
     && !(await verifyCertificate(albedo.cert, baked.glb)).ok, 'swapped: both rejected');

  console.log(`   σ       : calibrated ${baked.cert.sigma.calibrated}`
    + ` · ${baked.cert.sigma.validation}`);
  console.log(`   caveat  : ${baked.cert.sigma.caveat}`);
  ok('the σ block states its calibration state', baked.cert.sigma.calibrated === SIGMA_CALIBRATED,
     String(SIGMA_CALIBRATED));
  ok('...and that the validation was synthetic only',
     /synthetic analytic fixtures only/.test(baked.cert.sigma.validation), baked.cert.sigma.validation);
  ok('...and records the confound it refused to use',
     /confounded with depth/.test(baked.cert.sigma.caveat) && /not used/.test(baked.cert.sigma.caveat),
     'the caveat is present');
  ok('the σ block quotes the coverages actually measured',
     baked.cert.sigma.heldOutCoverage.length === 2
     && baked.cert.sigma.heldOutCoverage.every((c, i) =>
          c.measured === CALIBRATION_REPORT.heldOutCoverage[i]),
     baked.cert.sigma.heldOutCoverage.map((c) => `${c.level}→${c.measured}`).join(' '));
  ok('...and the same-family NLL comparison',
     baked.cert.sigma.nll.sigma < baked.cert.sigma.nll.constantSameFamily,
     `${baked.cert.sigma.nll.sigma} vs ${baked.cert.sigma.nll.constantSameFamily}`);

  // An unrigged export must not carry a rig claim the file cannot support.
  const flat = await make(null, { id: 'flat', rigged: false });
  const vf = await verifyCertificate(flat.cert, flat.glb);
  console.log(`   unrigged: rig.exported ${flat.cert.rig.exported} · joints reported `
    + `${flat.cert.rig.joints} (the skeleton was still computed)`);
  ok('an unrigged export verifies and says the skin is absent',
     vf.ok && flat.cert.rig.exported === false, 'rig.exported false');

  // THE RETAKE GUIDANCE, AND THE CASE WHERE THERE IS NONE.
  const nb = baked.cert.nextBestView;
  console.log(`   guidance: ${nb.candidateCount} candidates · ${nb.sampleCount} samples`
    + ` · flat ${nb.flatLandscape} · top/median ${nb.topOverMedianUtility}`
    + ` · az ${nb.selectedAzimuthDeg}° el ${nb.selectedElevationDeg}°`);
  ok('the certificate never turns a utility into a percentage',
     nb.qualitative === true && !/\d\s*%/.test(JSON.stringify(nb)),
     'qualitative true, no percentage anywhere in the block');
  ok('...and records that the K-view order was NOT validated',
     nb.singleViewValidated === true && nb.sequenceValidated === GREEDY_SET_DOMINANCE
     && nb.sequenceValidated === false,
     `singleViewValidated true, sequenceValidated ${nb.sequenceValidated}`);
  ok('...and that the validation was harness-only, with no physical check',
     /harness only/.test(nb.validation) && /no physical validation/.test(nb.validation),
     'stated in the leaf itself');
  ok('...and that no second view is fused by this product',
     /no second view is fused/.test(nb.guidance)
     && !/multi-?view|stereo|fusion/i.test(JSON.stringify(baked.cert)),
     'the document contains no multi-view claim');

  // A SUBJECT WITH NO ANSWER. A photographed subject is never flat — the
  // anisotropy prior sees to that — so the flat branch is exercised on a
  // constructed isotropic solid, exported through the real exporter and read
  // back through the real reader, which is the path the certificate uses.
  {
    const nu = 64, nv = 32, P = [], N = [], U = [], I = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const th = Math.PI*j/nv, ph = 2*Math.PI*i/nu;
      const x = Math.sin(th)*Math.cos(ph), y = Math.cos(th), z = Math.sin(th)*Math.sin(ph);
      P.push(x, y, z); N.push(x, y, z); U.push(i/nu, j/nv);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j*(nu+1)+i, b = a+1, c = a+nu+1, d = c+1;
      I.push(a, c, b, b, c, d);
    }
    const n = P.length/3;
    const iso = glbBytes({ positions: new Float32Array(P), normals: new Float32Array(N),
                           uvs: new Float32Array(U), indices: new Uint32Array(I),
                           colors: new Uint8Array(n*4).fill(255),
                           sigma: new Float32Array(n).fill(1),
                           sigmaMeta: baked.r.sigStats }, PNG, 'iso', null, null);
    const g = nbvFromGLB(iso);
    console.log(`   an isotropic solid: flat ${g.flatLandscape} · top/median ${g.topOverMedian}`
      + ` · azimuth ${g.selectedAzimuthDeg} (against a cutoff of ${FLAT_RATIO})`);
    ok('a subject with no best direction reports none',
       g.flatLandscape === true && g.selectedAzimuthDeg === null
       && g.selectedElevationDeg === null,
       `top/median ${g.topOverMedian} < ${FLAT_RATIO}, and no direction is produced`);
  }
}

/* ------------------------------------------------------------------ task 5 */

async function taskCanonical() {
  console.log('\nTASK 5 — the canonical form the signature is over');
  const a = { b: 1, a: { d: [3, { f: 1, e: 2 }], c: 2 } };
  const b = { a: { c: 2, d: [3, { e: 2, f: 1 }] }, b: 1 };
  ok('key order does not change the bytes', canonicalJSON(a) === canonicalJSON(b),
     canonicalJSON(a));
  ok('array order DOES change the bytes',
     canonicalJSON({ x: [1, 2] }) !== canonicalJSON({ x: [2, 1] }), 'order is content in an array');
  ok('SHA-256 matches the published vector for "abc"',
     await sha256Hex(new TextEncoder().encode('abc'))
       === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
     'FIPS 180-4');
  // A hash over a typed-array VIEW must cover the view, not its backing buffer.
  const big = new Uint8Array(64).fill(7);
  const view = big.subarray(8, 16);
  ok('hashing a subarray hashes the subarray',
     await sha256Hex(view) === await sha256Hex(Uint8Array.from(view)),
     'the view and its copy agree');
}

/* --------------------------------------------------------------------- run */

const A = await make(null, { id: 'test' });
const B = await make(OTHER, { id: 'test' });
await taskRoundTrip(A);
await taskTamper(A);
await taskTraceability(A, B);
await taskFlags();
await taskCanonical();

const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
