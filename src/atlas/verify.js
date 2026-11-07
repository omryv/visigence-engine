/* atlas-core/verify — check an artifact without installing the thing that made it.
 *
 * WHY THIS IS A SEPARATE ENTRY. A certificate is only worth something if the
 * person on the receiving end can check it, and that person has no reason to own
 * a reconstruction engine. Importing `atlas-core` to verify a GLB someone emailed
 * you would pull 156KB of Poisson inflation and isosurface extraction to count
 * edges and re-read an accessor. So the verifier's dependencies were made small
 * enough to be honest about: `topology` was lifted out of `atlas-core.js` into
 * its own module for exactly this, and what remains is the certificate, the
 * topology counter, and the view-ranking that one certificate block re-derives.
 *
 * `tests/package.mjs` walks this file's transitive imports and FAILS if
 * `atlas-core.js`, `exporters.js`, `rig.js` or `relight.js` appears among them —
 * anything whose job is to MAKE an artifact rather than to read one. The claim is
 * enforced, not asserted in a comment.
 *
 * WHAT VERIFICATION IS. Re-derivation, not comparison. `verifyCertificate` parses
 * the GLB, recomputes the topology, re-reads the σ attribute, recomputes the
 * whole retake-guidance landscape from the file's own vertices, and checks each
 * against what the document claims — then checks the signature over the
 * canonical bytes. A certificate that lies about the mesh fails even with a
 * perfect signature. A certificate that is honest but was edited in transit fails
 * on the signature. Both, and it fails twice.
 *
 * NODE AND BROWSER ALIKE. Nothing here touches a DOM. WebCrypto does the hashing
 * and the signature check, and where it is absent those two checks report that
 * rather than passing quietly.
 */

export {
  verifyCertificate,
  readGLB,
  readAccessor,
  canonicalJSON,
  sha256Hex,
  keyFingerprint,
  nbvFromGLB,
  CERT_FORMAT,
  SIG_ALG,
} from './certificate.js';

export { topology } from './topology.js';

/**
 * Verify a GLB against its certificate and reduce the result to one line.
 *
 * A convenience over `verifyCertificate` for callers who want a yes or a no —
 * a CI step, a shell script — without walking the check list themselves. The
 * full list is still returned, because "the certificate does not match" is not
 * useful and "the triangle count is 52,020 and the certificate says 51,004" is.
 *
 * @param {object} cert  the parsed certificate JSON
 * @param {Uint8Array} glbBytes  the artifact's exact bytes
 * @returns {Promise<{ok: boolean, passed: number, total: number, failed: string[], checks: object[]}>}
 */
export async function verifyArtifact(cert, glbBytes) {
  const { verifyCertificate } = await import('./certificate.js');
  const v = await verifyCertificate(cert, glbBytes);
  const failed = v.checks.filter((c) => !c.pass);
  return {
    ok: v.ok,
    passed: v.checks.length - failed.length,
    total: v.checks.length,
    failed: failed.map((c) => `${c.name}: ${c.detail}`),
    checks: v.checks,
  };
}
