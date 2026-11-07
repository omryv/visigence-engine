/* The provenance certificate: a signed JSON record of what this artifact is, and
 * a verifier that re-derives every claim in it from the exported bytes.
 *
 * THE HARD RULE, and the reason the file is shaped the way it is: every number in
 * the certificate must trace to a real computation. Where a quantity cannot be
 * computed the certificate says `"unknown"` and lists why in `unknown[]`. A
 * certificate containing one fabricated value is worse than no certificate,
 * because it converts "we do not know" into "we checked" — which is exactly the
 * failure the whole project was built to stop. There is no default, no
 * placeholder and no zero-that-means-absent anywhere below.
 *
 * WHAT THE SIGNATURE DOES AND DOES NOT ESTABLISH
 *
 * ECDSA P-256 over SHA-256, through the platform's own WebCrypto — not a
 * hand-rolled implementation, because rolling crypto to avoid a dependency is a
 * bad trade and this project has no dependencies to avoid it for. The key pair is
 * generated in the browser and persisted in `localStorage`, and the public key
 * travels inside the certificate.
 *
 * So it binds the certificate to the mesh, and binds both to a key the person
 * exporting them holds. It does NOT establish identity: nobody has vouched for
 * that key, and anyone can generate another. Someone who wants a certificate to
 * mean "this came from me" has to publish their own fingerprint out of band. That
 * limit is written into the certificate itself rather than left for the reader to
 * work out, because a signature that looks like an authenticity guarantee and is
 * not one would be the same fabrication in a different currency.
 *
 * VERIFICATION IS RE-DERIVATION, not comparison against a stored copy. The
 * verifier parses the GLB, recomputes the topology, re-reads the σ attribute and
 * the skin, and checks each against what the certificate claims. A certificate
 * that lies about the mesh fails even with a perfect signature, because the
 * signature only proves the lie has not been edited since.
 */

import { topology } from './topology.js';
import { nextBestView, CANDIDATES, GREEDY_SET_DOMINANCE } from './nbv.js';

export const CERT_FORMAT = 'atlas-one/certificate@1';
export const SIG_ALG = 'ECDSA-P256-SHA256';
export const KEY_STORAGE = 'atlas-one/signing-key';

const UNKNOWN = 'unknown';
const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;

/* ------------------------------------------------------------------ bytes */

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(bytes) {
  const s = subtle();
  if (!s) return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // A Uint8Array view over a larger buffer must be copied, or digest() hashes
  // the whole buffer and the hash silently describes something else.
  const exact = (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength)
    ? view : view.slice();
  return hex(await s.digest('SHA-256', exact));
}

const b64 = (buf) => {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
};
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

/**
 * Canonical JSON: keys sorted at every depth, no insertion-order dependence.
 *
 * The signature is over BYTES, so two serialisations of the same certificate must
 * be the same bytes or a round trip through any JSON library breaks verification
 * for no reason. Sorting is the whole of it — numbers keep JavaScript's own
 * shortest round-trip form, which both ends already agree on.
 */
export function canonicalJSON(value) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/* -------------------------------------------------------------------- keys */

/**
 * The signing key: generated once and kept in `localStorage`, so a person's
 * certificates share one public key and can be recognised as a set. Nothing is
 * uploaded, and no key ever leaves the browser.
 *
 * Without storage — a test, a private window, a worker — an ephemeral pair is
 * generated instead and the certificate says `"ephemeral": true`, because a key
 * that will not exist tomorrow cannot link anything to anything and the reader is
 * entitled to know that before relying on it.
 */
export async function signingKey(store = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const s = subtle();
  if (!s) return null;
  const params = { name: 'ECDSA', namedCurve: 'P-256' };
  if (store) {
    try {
      const saved = store.getItem(KEY_STORAGE);
      if (saved) {
        const { priv, pub } = JSON.parse(saved);
        return {
          privateKey: await s.importKey('jwk', priv, params, true, ['sign']),
          publicKey: await s.importKey('jwk', pub, params, true, ['verify']),
          ephemeral: false,
        };
      }
    } catch (_) { /* a corrupt entry is replaced below rather than thrown at the user */ }
  }
  const kp = await s.generateKey(params, true, ['sign', 'verify']);
  const priv = await s.exportKey('jwk', kp.privateKey);
  const pub = await s.exportKey('jwk', kp.publicKey);
  if (store) {
    try { store.setItem(KEY_STORAGE, JSON.stringify({ priv, pub })); } catch (_) {}
  }
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, ephemeral: !store };
}

/** A short, stable fingerprint of a public key, for showing a person their own. */
export async function keyFingerprint(publicJwk) {
  const h = await sha256Hex(new TextEncoder().encode(canonicalJSON(publicJwk)));
  return h ? h.slice(0, 16) : null;
}

/* ------------------------------------------------------------ the document */

const num = (v, digits) => (typeof v === 'number' && isFinite(v)
  ? (digits === undefined ? v : +v.toFixed(digits)) : UNKNOWN);

/**
 * The retake-guidance block, computed FROM THE EXPORTED BYTES rather than from
 * the reconstruction in memory.
 *
 * That choice is what makes the block re-derivable. The seam split duplicates
 * vertices on the way out, so a landscape computed on `r.positions` and one
 * computed on the GLB's mesh sample different surfaces and would not agree; a
 * verifier could then only be given a tolerance, and a tolerance is where a
 * fabricated number hides. Reading the file back means the verifier repeats this
 * function exactly and compares equal or fails.
 *
 * Returns null when the file carries no σ — the utility is σ-weighted, so
 * without it there is nothing to rank and the caller records that as unknown.
 */
export function nbvFromGLB(glb) {
  let g;
  try { g = readGLB(glb); } catch { return null; }
  const prim = g.json.meshes[0].primitives[0];
  if (prim.attributes._SIGMA === undefined || prim.attributes.NORMAL === undefined) return null;
  const positions = readAccessor(g, prim.attributes.POSITION);
  const normals = readAccessor(g, prim.attributes.NORMAL);
  const indices = readAccessor(g, prim.indices);
  const sigma = readAccessor(g, prim.attributes._SIGMA);
  if (!positions || !normals || !indices || !sigma) return null;
  return nextBestView({ positions, normals, indices, sigma }).report;
}

/**
 * Build the certificate for a finished reconstruction and the bytes it exported.
 *
 * @param {object} o
 * @param {object} o.result     what `reconstruct` returned
 * @param {Uint8Array} o.glb    the exported GLB, exactly as written
 * @param {Uint8Array} [o.input] the front photograph's own bytes, if the caller kept them
 * @param {object} o.calibration the CALIBRATION_REPORT from src/uncertainty.js
 * @param {string} o.id
 */
export async function buildCertificate(o) {
  const r = o.result, unknown = [];
  const miss = (field, why) => { unknown.push({ field, why }); return UNKNOWN; };

  const meshHash = await sha256Hex(o.glb);
  const inputHash = o.input ? await sha256Hex(o.input) : null;

  const st = r.stats, sg = r.sigStats, cal = o.calibration;
  const nb = nbvFromGLB(o.glb);

  const cert = {
    format: CERT_FORMAT,
    generator: 'ATLAS/ONE',
    id: o.id,
    mode: st.mode,

    input: {
      sha256: inputHash || miss('input.sha256',
        o.input ? 'the platform exposes no SHA-256' : 'the source bytes were not retained by the caller'),
      bytes: o.input ? o.input.length : miss('input.bytes', 'the source bytes were not retained by the caller'),
      workingGrid: { width: st.w, height: st.h },
      // The atlas is sampled from the full-resolution source, and saying so keeps
      // "texture detail" from being read off the geometry grid.
      textureSource: { width: st.texW, height: st.texH },
    },

    mesh: {
      sha256: meshHash || miss('mesh.sha256', 'the platform exposes no SHA-256'),
      bytes: o.glb.length,
      vertices: r.topo.vertices,
      triangles: r.topo.triangles,
      watertight: r.topo.watertight,
      boundaryEdges: r.topo.boundary,
      nonManifoldEdges: r.topo.nonman,
      shells: r.topo.shells,
    },

    // Does the exported solid still occupy the silhouette it was built from?
    registration: {
      silhouetteIoU: num(r.reproj.iou, 4),
      silhouetteOffsetPx: num(r.reproj.offsetPx, 4),
      perimeterPx: r.reproj.perimeter,
      supersample: r.reproj.ss,
      backViewIoU: st.backIoU != null ? num(st.backIoU, 4)
        : miss('registration.backViewIoU', 'no back view was supplied'),
      profileSelfConsistency: st.profileIoU != null ? num(st.profileIoU, 4)
        : miss('registration.profileSelfConsistency', 'no profile view was supplied'),
      profileRows: st.profileRows || 0,
      views: st.views,
    },

    provenance: {
      measured: num(r.prov.measured, 4),
      inflated: num(r.prov.inflated, 4),
      authored: num(r.prov.authored, 4),
      basis: 'fraction of surface AREA. measured: the silhouette pins the position.'
           + ' inflated: a camera saw it but its depth is the inflation and the anisotropy'
           + ' prior. authored: no camera saw it.',
    },

    sigma: {
      family: sg.family,
      nu: sg.nu,
      intervals: sg.intervals.map((iv) => ({ level: iv.level, k: +iv.k.toFixed(4) })),
      calibrated: sg.calibrated,
      heldOutCoverage: cal.levels.map((L, i) => ({ level: L, measured: cal.heldOutCoverage[i] })),
      nll: { sigma: cal.nll.sigma, constantSameFamily: cal.nll.constantSameFamily },
      validation: cal.validation,
      caveat: cal.caveat,
      scalePx: { median: num(sg.p50, 4), p90: num(sg.p90, 4),
                 min: num(sg.min, 4), max: num(sg.max, 4) },
      pxToModel: num(sg.pxToModel, 8),
      along: 'vertex normal',
    },

    lens: r.cam.known
      ? { known: true, source: r.cam.source, mm35: r.cam.mm35,
          fRel: num(r.cam.fRel, 6), cropChecked: !!r.cam.cropChecked, projection: 'perspective' }
      : { known: false,
          source: miss('lens.source', r.cam.reason),
          mm35: miss('lens.mm35', r.cam.reason),
          fRel: miss('lens.fRel', r.cam.reason),
          cropChecked: false, projection: 'orthographic' },

    // TWO DIFFERENT CLAIMS, and conflating them was the first thing the verifier
    // caught. `relightable` is a finding about the SUBJECT — the Lambertian fit
    // was strong enough to divide out. `exportedAlbedo` is a fact about THIS
    // FILE — whether the caller asked for the albedo and normal map or for the
    // photograph with its lighting baked in. A certificate that reports the
    // first as though it were the second describes an artifact that was never
    // written, and the re-derivation cannot check it against anything.
    material: {
      relightable: !!(r.pbr && r.pbr.ok),
      exportedAlbedo: null,          // filled by the caller
      bakedColourFallback: null,     // filled by the caller: !exportedAlbedo
      delightingR2: r.pbr && typeof r.pbr.r2 === 'number' ? num(r.pbr.r2, 4)
        : miss('material.delightingR2', 'no Lambertian fit was produced'),
      roughness: r.pbr && r.pbr.ok ? num(r.pbr.roughness, 4)
        : miss('material.roughness', 'the Lambertian fit was too weak to separate one'),
      declineReason: r.pbr && r.pbr.ok ? null : (r.pbr ? r.pbr.reason : UNKNOWN),
    },

    // WHAT THE RENDER SHOWED THAT THE BYTES DO NOT CARRY.
    //
    // The one claim in this document that is not about the file. It is here
    // because the reader saw a render before they saw the bytes, and a studio-lit
    // presentation that goes undeclared is the same fabrication as a printed
    // number nobody measured — in the currency of pixels. AN EMPTY LIST MEANS
    // PARITY: that what was on the canvas is what any conformant engine will
    // draw. This list is not empty.
    //
    // It is passed IN rather than imported, exactly as `calibration` is, so that
    // certificate.js gains no dependency and the verifier's transitive closure
    // stays the four small files it is asserted to be. A caller that supplies
    // nothing is declaring parity, and is on the hook for that claim.
    viewerOnlyEffects: (o.viewerOnlyEffects || []).map((e) => ({ id: e.id, what: e.what })),

    // WHAT THIS PHOTOGRAPH LEFT UNCONSTRAINED, and where a second one would help
    // most. Retake guidance and nothing else: this product reconstructs from one
    // photograph, no claim below implies otherwise, and `guidance` says so in the
    // document rather than only in the source.
    nextBestView: {
      guidance: 'retake guidance for a single-photograph reconstruction.'
              + ' no second view is fused, intersected or blended by this product.',
      candidateCount: nb ? nb.candidateCount : miss('nextBestView.candidateCount',
        'the exported mesh carries no _SIGMA, so there is no σ-weighted utility to rank'),
      sampleCount: nb ? nb.sampleCount : miss('nextBestView.sampleCount',
        'the exported mesh carries no _SIGMA, so there is no σ-weighted utility to rank'),
      // Flat is an ANSWER, not a missing value: on a subject where no direction
      // is much better than another, the honest output is that there is nothing
      // to point at. The azimuth is then genuinely unknown and is listed as such.
      flatLandscape: nb ? nb.flatLandscape : miss('nextBestView.flatLandscape',
        'the exported mesh carries no _SIGMA'),
      topOverMedianUtility: nb ? nb.topOverMedian : miss('nextBestView.topOverMedianUtility',
        'the exported mesh carries no _SIGMA'),
      selectedAzimuthDeg: nb && !nb.flatLandscape ? nb.selectedAzimuthDeg
        : miss('nextBestView.selectedAzimuthDeg', nb
          ? 'the utility landscape is flat: no direction is meaningfully better than typical'
          : 'the exported mesh carries no _SIGMA'),
      selectedElevationDeg: nb && !nb.flatLandscape ? nb.selectedElevationDeg
        : miss('nextBestView.selectedElevationDeg', nb
          ? 'the utility landscape is flat: no direction is meaningfully better than typical'
          : 'the exported mesh carries no _SIGMA'),
      // σ is uncalibrated, so a utility is an ORDER and never a percentage. This
      // flag is the standing prohibition, in the document.
      qualitative: true,
      // The single recommendation was checked against analytic ground truth; the
      // ranked order of K ≥ 2 was checked and FAILED. Both travel with the file.
      singleViewValidated: true,
      sequenceValidated: GREEDY_SET_DOMINANCE,
      validation: 'the ranking was checked against analytic fixtures in the test'
                + ' harness only, by a simulated view-update operator that exists'
                + ' nowhere in the product. no physical validation was performed.',
    },

    rig: {
      joints: r.rig.stats.joints,
      bones: r.rig.stats.bones,
      branches: r.rig.stats.branches,
      waists: r.rig.stats.waists,
      waistsRho: r.rig.stats.waistsRho,
      waistsA: r.rig.stats.waistsA,
      exported: null,      // filled by the caller: whether THIS glb carries the skin
    },

    unknown,
  };
  return cert;
}

/** Sign a certificate in place, returning it with a `signature` block. */
export async function signCertificate(cert, key) {
  const s = subtle();
  if (!s || !key) {
    return { ...cert, signature: {
      alg: UNKNOWN, value: UNKNOWN, publicKey: UNKNOWN, ephemeral: UNKNOWN,
      binds: 'NOT SIGNED: this platform exposes no WebCrypto, so nothing binds this'
           + ' certificate to the mesh beyond the hash it quotes.',
    } };
  }
  const body = { ...cert };
  delete body.signature;
  const bytes = new TextEncoder().encode(canonicalJSON(body));
  const sig = await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, bytes);
  const pub = await s.exportKey('jwk', key.publicKey);
  return { ...body, signature: {
    alg: SIG_ALG,
    value: b64(sig),
    publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
    ephemeral: !!key.ephemeral,
    binds: 'This certificate to this mesh, under a key generated in the exporting'
         + ' browser. It establishes INTEGRITY, not identity: no authority has vouched'
         + ' for this key and anyone can generate another. To make it mean "this came'
         + ' from me", publish the key fingerprint separately.',
  } };
}

/* ---------------------------------------------------------------- the GLB */

/**
 * Enough of a glTF reader to re-derive the certificate's claims. Deliberately
 * not a loader: it does not build a scene, and it fails loudly rather than
 * repairing anything, because a verifier that tolerates a malformed file is a
 * verifier that passes one.
 */
export function readGLB(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 20) throw new Error('too short to be a GLB');
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a GLB (bad magic)');
  if (dv.getUint32(4, true) !== 2) throw new Error('not glTF 2.0');
  if (dv.getUint32(8, true) !== b.length) throw new Error('header length disagrees with the file');
  let p = 12, json = null, bin = null;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    p += 8;
    if (p + len > b.length) throw new Error('a chunk runs past the end of the file');
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(b.subarray(p, p + len)));
    else if (type === 0x004E4942) bin = b.subarray(p, p + len);
    p += len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

const COMP = { 5120: [1, Int8Array], 5121: [1, Uint8Array], 5122: [2, Int16Array],
               5123: [2, Uint16Array], 5125: [4, Uint32Array], 5126: [4, Float32Array] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readAccessor(g, index) {
  if (index === undefined || index === null) return null;
  const a = g.json.accessors[index];
  if (!a) return null;
  const bv = g.json.bufferViews[a.bufferView];
  const [size, Ctor] = COMP[a.componentType];
  const n = a.count * NCOMP[a.type];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  // Copy rather than view: the BIN chunk is not guaranteed to be aligned to the
  // component size within the file, and a misaligned typed-array view throws.
  return new Ctor(g.bin.buffer.slice(g.bin.byteOffset + off, g.bin.byteOffset + off + n * size));
}

/* ------------------------------------------------------------- the verifier */

/**
 * Re-derive every claim the certificate makes, from the mesh bytes.
 *
 * Returns one row per check rather than a single boolean, because "the
 * certificate does not match" is not useful and "the triangle count is 52,020
 * and the certificate says 51,004" is. `ok` is the conjunction.
 */
export async function verifyCertificate(cert, glbBytes) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  if (!cert || cert.format !== CERT_FORMAT) {
    add('certificate format', false, `expected ${CERT_FORMAT}, got ${cert && cert.format}`);
    return { ok: false, checks };
  }
  add('certificate format', true, cert.format);

  // 1. the bytes are the bytes
  const h = await sha256Hex(glbBytes);
  add('mesh SHA-256', h !== null && h === cert.mesh.sha256,
      h === null ? 'no WebCrypto available to hash with' : `${String(cert.mesh.sha256).slice(0, 16)}…`);
  add('mesh byte length', glbBytes.length === cert.mesh.bytes,
      `${glbBytes.length} vs ${cert.mesh.bytes}`);

  // 2. the signature covers this exact document
  const s = subtle();
  const sig = cert.signature;
  if (!s || !sig || sig.alg !== SIG_ALG) {
    add('signature', false, !s ? 'no WebCrypto available'
      : `unsigned or unknown algorithm (${sig && sig.alg})`);
  } else {
    let ok = false, why = '';
    try {
      const body = { ...cert }; delete body.signature;
      const key = await s.importKey('jwk', { ...sig.publicKey, ext: true },
                                    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      ok = await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64(sig.value),
                          new TextEncoder().encode(canonicalJSON(body)));
    } catch (e) { why = e.message; }
    add('signature', ok, ok ? `${SIG_ALG}${sig.ephemeral ? ' (ephemeral key)' : ''}`
                            : `did not verify${why ? ': ' + why : ''}`);
  }

  // 3. every structural claim, RE-DERIVED from the file
  let g = null;
  try { g = readGLB(glbBytes); } catch (e) { add('GLB parses', false, e.message); }
  if (g) {
    add('GLB parses', true, `${g.json.meshes.length} mesh, ${g.json.accessors.length} accessors`);
    const prim = g.json.meshes[0].primitives[0];
    const pos = readAccessor(g, prim.attributes.POSITION);
    const idx = readAccessor(g, prim.indices);
    const nV = pos.length / 3, nT = idx.length / 3;
    add('vertex count', nV === cert.mesh.vertices, `${nV} vs ${cert.mesh.vertices}`);
    add('triangle count', nT === cert.mesh.triangles, `${nT} vs ${cert.mesh.triangles}`);

    const topo = topology(pos, idx);
    add('watertight', topo.watertight === cert.mesh.watertight,
        `${topo.watertight} vs ${cert.mesh.watertight}`);
    add('boundary edges', topo.boundary === cert.mesh.boundaryEdges,
        `${topo.boundary} vs ${cert.mesh.boundaryEdges}`);
    add('non-manifold edges', topo.nonman === cert.mesh.nonManifoldEdges,
        `${topo.nonman} vs ${cert.mesh.nonManifoldEdges}`);
    add('shells', topo.shells === cert.mesh.shells, `${topo.shells} vs ${cert.mesh.shells}`);

    // σ: present, the same scale, and above all the same CALIBRATION STATE. An
    // asset whose uncertainty is uncalibrated must not be able to travel with a
    // certificate that says otherwise, in either direction.
    const sigAcc = prim.attributes._SIGMA;
    const ex = (prim.extras || {}).ATLAS_sigma;
    if (sigAcc === undefined) {
      add('σ attribute', cert.sigma == null, 'the mesh carries no _SIGMA');
    } else {
      const sv = readAccessor(g, sigAcc);
      const sorted = Array.from(sv).sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      add('σ vertex count', sv.length === nV, `${sv.length} vs ${nV}`);
      add('σ median', Math.abs(q(0.5) - cert.sigma.scalePx.median) < 5e-4,
          `${q(0.5).toFixed(4)} vs ${cert.sigma.scalePx.median}`);
      add('σ p90', Math.abs(q(0.9) - cert.sigma.scalePx.p90) < 5e-4,
          `${q(0.9).toFixed(4)} vs ${cert.sigma.scalePx.p90}`);
      add('σ range', Math.abs(sorted[0] - cert.sigma.scalePx.min) < 5e-4
          && Math.abs(sorted[sorted.length-1] - cert.sigma.scalePx.max) < 5e-4,
          `${sorted[0].toFixed(3)}–${sorted[sorted.length-1].toFixed(3)}`);
      add('σ calibration state', !!(ex && ex.calibrated) === !!cert.sigma.calibrated,
          `mesh says ${ex && ex.calibrated}, certificate says ${cert.sigma.calibrated}`);
      add('σ predictive family', !!ex && ex.family === cert.sigma.family
          && Math.abs((ex.nu || 0) - cert.sigma.nu) < 1e-9,
          `${ex && ex.family} ν ${ex && ex.nu}`);
    }

    // THE RETAKE GUIDANCE, RE-DERIVED. The utility landscape is a function of the
    // positions, normals and σ in this file and of nothing else, so the verifier
    // recomputes it outright and compares. Not a tolerance: the same inputs
    // through the same code, or the claim is false.
    const nb = cert.nextBestView;
    if (nb) {
      const re = nbvFromGLB(glbBytes);
      if (!re) {
        add('retake guidance', nb.candidateCount === UNKNOWN,
            'the file carries no σ, and the certificate says so');
      } else {
        add('candidate directions', re.candidateCount === nb.candidateCount
            && re.candidateCount === CANDIDATES, `${re.candidateCount} vs ${nb.candidateCount}`);
        add('utility samples', re.sampleCount === nb.sampleCount,
            `${re.sampleCount} vs ${nb.sampleCount}`);
        add('flat-landscape verdict', re.flatLandscape === nb.flatLandscape,
            `recomputed ${re.flatLandscape}, certificate says ${nb.flatLandscape}`);
        add('top-over-median utility', re.topOverMedian === nb.topOverMedianUtility,
            `${re.topOverMedian} vs ${nb.topOverMedianUtility}`);
        // A flat landscape has no selected direction, and the certificate must
        // carry the absence rather than a direction nobody computed.
        add('the recommended direction', re.flatLandscape
            ? nb.selectedAzimuthDeg === UNKNOWN && nb.selectedElevationDeg === UNKNOWN
            : (re.selectedAzimuthDeg === nb.selectedAzimuthDeg
               && re.selectedElevationDeg === nb.selectedElevationDeg),
            re.flatLandscape ? 'flat, and no direction is claimed'
              : `az ${re.selectedAzimuthDeg}° el ${re.selectedElevationDeg}°`);
        // The two validation claims are structural constants of the build, and
        // neither may drift toward the flattering value.
        add('guidance is qualitative and the K-view order is not claimed validated',
            nb.qualitative === true && nb.singleViewValidated === true
            && nb.sequenceValidated === GREEDY_SET_DOMINANCE,
            `qualitative ${nb.qualitative}, sequenceValidated ${nb.sequenceValidated}`);
      }
    }

    // the rig, and whether THIS file carries it
    const skinned = !!g.json.skins;
    add('rig export flag', skinned === !!cert.rig.exported,
        `mesh ${skinned ? 'is' : 'is not'} skinned, certificate says ${cert.rig.exported}`);
    if (skinned) {
      const J = g.json.skins[0].joints.length;
      add('joint count', J === cert.rig.joints, `${J} vs ${cert.rig.joints}`);
    }

    // the material claim: a relightable asset carries a normal map, a baked one
    // does not, and the flag has to agree with the file
    const hasNormal = !!(g.json.materials[0] || {}).normalTexture;
    add('exported albedo flag', hasNormal === !!cert.material.exportedAlbedo,
        `normal map ${hasNormal ? 'present' : 'absent'}, certificate says exportedAlbedo`
        + ` ${cert.material.exportedAlbedo}`);
    add('baked-colour fallback is the complement',
        !!cert.material.bakedColourFallback === !cert.material.exportedAlbedo,
        `baked ${cert.material.bakedColourFallback}, albedo ${cert.material.exportedAlbedo}`);
  }

  // 4. nothing claims to be known that the certificate also lists as unknown
  const listed = new Set((cert.unknown || []).map((u) => u.field));
  const bare = [];
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const p = path ? `${path}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      else if (v === UNKNOWN && !listed.has(p)) bare.push(p);
    }
  };
  walk({ input: cert.input, registration: cert.registration, lens: cert.lens,
         material: cert.material, mesh: cert.mesh, sigma: cert.sigma, rig: cert.rig,
         nextBestView: cert.nextBestView }, '');
  add('every "unknown" is explained', bare.length === 0,
      bare.length ? `unlisted: ${bare.join(', ')}` : `${listed.size} listed and explained`);
  // ...and nothing is listed as unknown that the certificate then states anyway,
  // which would be the same dishonesty pointing the other way.
  const value = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), cert);
  const overclaimed = [...listed].filter((f) => value(f) !== UNKNOWN);
  add('nothing listed as unknown is stated anyway', overclaimed.length === 0,
      overclaimed.length ? `stated: ${overclaimed.join(', ')}` : 'consistent');

  return { ok: checks.every((c) => c.pass), checks };
}
