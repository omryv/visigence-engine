/* atlas-core — the public surface of the engine, for people who are not this app.
 *
 * WHAT THIS ENTRY IS. Anything living in this tree imports the modules below
 * directly, one by one, because it lives beside them. Anyone installing the npm
 * package imports them through here. Those two must never be able to diverge, so
 * this file RE-EXPORTS rather than reimplements:
 * `(await import('atlas-core')).reconstruct` and
 * `(await import('./src/atlas-core.js')).reconstruct` are the same function
 * object, and `tests/package.mjs` asserts that identity rather than trusting it.
 * Byte-identical output across the two paths is then structural, not a
 * coincidence that could rot.
 *
 * WHAT IS DELIBERATELY NOT HERE. Nothing that needs a DOM, a canvas, a worker or
 * WebGL. This entry is the reconstruction, its uncertainty, its exporters and
 * its certificate — all of which run in Node with no shims, so importing the
 * engine on a server never drags a browser API in behind it.
 *
 * THE ONE PLATFORM DEPENDENCY is WebCrypto, and only for signing and hashing.
 * `sha256Hex` returns null and `signingKey` returns null where it is absent, and
 * the certificate records the hash as `"unknown"` with that reason rather than
 * inventing one. Node 18+ and every current browser have it.
 *
 * DETERMINISM. Same input bytes → same output bytes, in this package and in the
 * app alike. Two things are NOT deterministic and neither is exported: the
 * reconstruction's `stats.ms` is wall-clock time, and an ECDSA signature carries
 * a fresh random nonce every time it is made. The GLB and the certificate BODY
 * are byte-stable; `tests/package.mjs` measures both claims.
 */

/* ------------------------------------------------------------ the engine */

export {
  reconstruct,
  topology,
  silhouetteIoU,
  provenanceReport,
  PRESETS,
} from './atlas-core.js';

/* --------------------------------------------------- what it knows about */

export { readLens } from './exif.js';

export {
  PREDICTIVE, NU, LEVELS, SIGMA_CALIBRATED, CALIBRATION_REPORT,
  FITTED_OPTIMUM, INTERVAL_K,
  intervalK, tQuantile, tCdf, tEntropy,
  boundarySigma, sigmaGrid, sigmaSummary, offsetShell,
} from './uncertainty.js';

export {
  nextBestView, viewCandidates, viewGain, utility, visibleFrom,
  surfaceSamples, greedyViews, landscapeShape, contourBand,
  CANDIDATES, SAMPLES, FLAT_RATIO, FLAT_REPORT,
  GREEDY_SET_DOMINANCE, GREEDY_REPORT,
} from './nbv.js';

export { buildRig, normalizeWeightsF32 } from './rig.js';

export { planRelight, shadingField, delightChart, normalDetail } from './relight.js';

export {
  smartMesh, simplify, pairQuads, meshDeviation, meshQuality, weldMesh, reprojectAtlas,
  SMART_MESH,
} from './smartmesh.js';

// Registering a reconstruction against independent truth, and the residual and
// gate that measurement needs. Nothing here calibrates anything — see
// `docs/registration-algorithm.md` §8 for what it does and does not claim.
export {
  registerSimilarity7, coarseAlign, similarityFromPairs, surfaceMoments,
  bandResidual, residualField, truthBandGate, registrationFloor,
  applyTransform, vertexNormals, bvhBuild, bvhClosest, bvhRay,
  jacobiEigenSym, rotationFromQuaternion, identitySimilarity,
  mulberry32, uniformRotation,
  REGISTER,
} from './register.js';

/* ----------------------------------------------------------- what it emits */

export { glbBytes, makeGLB, makeOBJ, makeZip } from './exporters.js';

/* ------------------------------------------------------ and what proves it */
// Re-exported here for convenience. `atlas-core/verify` is the entry to use when
// checking a file is all you want to do — it costs a fraction of this one.

export {
  buildCertificate, signCertificate, verifyCertificate, signingKey,
  keyFingerprint, canonicalJSON, sha256Hex, readGLB, readAccessor, nbvFromGLB,
  CERT_FORMAT, SIG_ALG,
} from './certificate.js';

/** The version this package publishes under, for a caller that wants to log it. */
export const VERSION = '1.0.0';
