// Closed triangle meshes with known geometry, for scoring a mesh operation
// against something exact rather than against the mesh it started from. A
// fixture, not a suite — nothing here is reconstructed.
//
//   icosphere(level)  — 20·4^level triangles on the unit sphere, valence 5–6
//   cube(n)           — six n×n grids on the faces of [−1, 1]³, sharp edges
//   torus(nu, nv)     — genus 1, so V − E + F = 0 and a suite can watch it stay so

export function icosphere(level, R = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]];
  let F = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
           [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  const norm = (p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0]/l*R, p[1]/l*R, p[2]/l*R]; };
  V = V.map(norm);
  for (let l = 0; l < level; l++) {
    const mid = new Map(), NF = [];
    const m = (a, b) => {
      const k = a < b ? a * 1e6 + b : b * 1e6 + a;
      let i = mid.get(k);
      if (i === undefined) {
        i = V.length;
        V.push(norm([(V[a][0]+V[b][0])/2, (V[a][1]+V[b][1])/2, (V[a][2]+V[b][2])/2]));
        mid.set(k, i);
      }
      return i;
    };
    for (const [a, b, c] of F) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); NF.push([a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]); }
    F = NF;
  }
  return { positions: new Float32Array(V.flat()), indices: new Uint32Array(F.flat()), R };
}

export function cube(n, a = 1) {
  const V = [], F = [], key = new Map();
  const vid = (x, y, z) => {
    const k = `${x.toFixed(6)}_${y.toFixed(6)}_${z.toFixed(6)}`;
    let i = key.get(k);
    if (i === undefined) { i = V.length / 3; V.push(x, y, z); key.set(k, i); }
    return i;
  };
  // six faces, each wound so the normal points out
  const faces = [
    (u, v) => [ a, u, v], (u, v) => [-a, v, u],
    (u, v) => [v,  a, u], (u, v) => [u, -a, v],
    (u, v) => [u, v,  a], (u, v) => [v, u, -a],
  ];
  for (const f of faces) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const u0 = -a + 2*a*i/n, u1 = -a + 2*a*(i+1)/n, v0 = -a + 2*a*j/n, v1 = -a + 2*a*(j+1)/n;
    const p00 = vid(...f(u0, v0)), p10 = vid(...f(u1, v0)), p11 = vid(...f(u1, v1)), p01 = vid(...f(u0, v1));
    F.push(p00, p10, p11, p00, p11, p01);
  }
  return { positions: new Float32Array(V), indices: new Uint32Array(F), a };
}

export function torus(nu, nv, R = 1, r = 0.35) {
  const V = [], F = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = 2*Math.PI*i/nu, v = 2*Math.PI*j/nv;
    V.push((R + r*Math.cos(v))*Math.cos(u), (R + r*Math.cos(v))*Math.sin(u), r*Math.sin(v));
  }
  const id = (i, j) => ((i + nu) % nu) * nv + ((j + nv) % nv);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++)
    F.push(id(i, j), id(i+1, j), id(i+1, j+1), id(i, j), id(i+1, j+1), id(i, j+1));
  return { positions: new Float32Array(V), indices: new Uint32Array(F), R, r };
}

/** Signed volume by the divergence theorem; positive for outward winding. */
export function signedVolume(P, F) {
  let v = 0;
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t]*3, b = F[t+1]*3, c = F[t+2]*3;
    v += P[a]*(P[b+1]*P[c+2] - P[b+2]*P[c+1]) - P[a+1]*(P[b]*P[c+2] - P[b+2]*P[c]) + P[a+2]*(P[b]*P[c+1] - P[b+1]*P[c]);
  }
  return v / 6;
}
