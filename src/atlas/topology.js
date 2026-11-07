/* Mesh topology, on its own so that verifying an artifact does not require the
 * engine that made it.
 *
 * This function used to live in `atlas-core.js`, and it has no business being
 * there: it reads a position and index buffer and nothing else. Leaving it there
 * meant `certificate.js` — and therefore the verifier, and therefore anyone who
 * only wants to check a file someone sent them — had to import 156KB of
 * reconstruction to count edges. It is re-exported from `atlas-core.js`, so
 * every existing import still resolves to this exact function.
 */

/**
 * Vertex, triangle, boundary-edge, non-manifold-edge and shell counts.
 *
 * VERTICES ARE WELDED FIRST, at 1/16384 of a model unit. The exported mesh is
 * split along its UV seams, so the same physical edge appears twice with
 * different texture coordinates; counting edges on the split mesh reports every
 * seam as a boundary and calls a closed surface open. The weld is a quantised
 * position key rather than a distance search because it has to be exact and
 * order-independent: a tolerance-based weld gives a different answer depending
 * on which vertex it meets first, and this number ends up in a signed
 * certificate that a verifier has to reproduce from the file alone.
 */
export function topology(positions, indices) {
  const nV = positions.length / 3, nT = indices.length / 3;
  const wmap = new Map(), weld = new Int32Array(nV);
  for (let i = 0; i < nV; i++) {
    const k = Math.round(positions[i*3]*16384) + '_' + Math.round(positions[i*3+1]*16384) + '_' + Math.round(positions[i*3+2]*16384);
    let r = wmap.get(k); if (r === undefined) { r = i; wmap.set(k, i); }
    weld[i] = r;
  }
  const em = new Map(), key = (a, b) => a < b ? a + '_' + b : b + '_' + a;
  for (let t = 0; t < nT; t++) {
    const a = weld[indices[t*3]], b = weld[indices[t*3+1]], c = weld[indices[t*3+2]];
    if (a === b || b === c || a === c) continue;
    for (const [i, j] of [[a,b],[b,c],[c,a]]) { const k = key(i, j); em.set(k, (em.get(k) || 0) + 1); }
  }
  let boundary = 0, nonman = 0;
  em.forEach(v => { if (v === 1) boundary++; if (v > 2) nonman++; });
  const uf = new Int32Array(nV); for (let i = 0; i < nV; i++) uf[i] = i;
  const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
  for (let t = 0; t < nT; t++) {
    const a = find(weld[indices[t*3]]), b = find(weld[indices[t*3+1]]), c = find(weld[indices[t*3+2]]);
    uf[b] = a; uf[c] = a;
  }
  const roots = new Set(); for (let t = 0; t < nT; t++) roots.add(find(weld[indices[t*3]]));
  return { vertices: nV, triangles: nT, boundary, nonman, shells: roots.size,
           watertight: boundary === 0 && nonman === 0, texsets: 1 };
}
