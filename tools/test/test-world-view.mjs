/**
 * WORLD MODE'S DRAWING: the mesh render/WorldView.js draws is the bake's own lattice, and a site's curtain stands on
 * that ground, around that site.
 *
 *   1. terrainGeometry: one vertex per sample, at the sample's plate position, its height × EXAGGERATION over the sea;
 *      two triangles a cell, wound up (+y normals on flat ground); unit normals; the bake's colours, not a copy;
 *   2. siteCurtain: a closed band around the site's square, its foot on the ground (bilinear on the same heights, never
 *      under the sea), its head `rise` above the foot.
 *
 * Run:  node --import ./tools/lib/_three-real-hook.mjs tools/test/test-world-view.mjs
 */
import assert from 'node:assert/strict';
import { terrainGeometry, siteCurtain, EXAGGERATION } from '../../src/render/WorldView.js';
import { bakeWorld } from '../../src/world/worldMap.js';

const ok = msg => console.log(`  ok   ${msg}`);
const bake = bakeWorld('AB12-CD34-EF56'), { res, size, heights, sea } = bake;

// ── 1. the terrain mesh ──────────────────────────────────────────────────────
{
  const g = terrainGeometry(bake), P = g.attributes.position.array, Nn = g.attributes.normal.array;
  assert.equal(g.attributes.position.count, res * res);
  assert.equal(g.index.count, (res - 1) * (res - 1) * 6);
  assert.equal(g.attributes.color.array, bake.colors, 'the bake\'s colours, not a copy');
  let worst = 0;
  for (const k of [0, res - 1, (res >> 1) * res + (res >> 1), res * res - 1, 12345]) {
    const i = k % res, j = (k / res) | 0;
    assert.equal(P[k * 3], (i / (res - 1) - 0.5) * size); assert.equal(P[k * 3 + 2], (j / (res - 1) - 0.5) * size);
    worst = Math.max(worst, Math.abs(P[k * 3 + 1] - (heights[k] - sea) * EXAGGERATION));
  }
  assert(worst < 1e-3, `heights drawn × ${EXAGGERATION} over the sea (worst ${worst})`);
  let len = 0, up = 0;
  for (let k = 0; k < res * res; k++) { const l = Math.hypot(Nn[k * 3], Nn[k * 3 + 1], Nn[k * 3 + 2]); len = Math.max(len, Math.abs(l - 1)); if (Nn[k * 3 + 1] > 0) up++; }
  assert(len < 1e-5 && up === res * res, 'unit normals, all facing up (a heightfield has no overhangs)');
  // The first cell's first triangle winds counter-clockwise seen from above: its geometric normal is +y.
  const [a, b, c] = [g.index.array[0], g.index.array[1], g.index.array[2]], v = n => [P[n * 3], P[n * 3 + 1], P[n * 3 + 2]];
  const [A, B, C] = [v(a), v(b), v(c)], e1 = B.map((x, i) => x - A[i]), e2 = C.map((x, i) => x - A[i]);
  assert(e1[2] * e2[0] - e1[0] * e2[2] > 0, 'triangles face up');
  ok(`the mesh is the bake's lattice: ${(res * res).toLocaleString()} vertices, ${(g.index.count / 3).toLocaleString()} triangles facing up, heights × ${EXAGGERATION}, the bake's colours`);
}

// ── 2. a site's curtain ──────────────────────────────────────────────────────
{
  const site = bake.sites[0], rise = 18, { geometry, top } = siteCurtain(bake, site, { rise });
  const P = geometry.attributes.position.array, n = P.length / 6, half = site.span / 2;
  assert(n > 4 * (site.span / 8) - 2, `a band all the way round (${n} posts)`);
  for (let s = 0; s < n; s++) {
    const [x, y0, z, x1, y1, z1] = P.slice(s * 6, s * 6 + 6);
    assert(x === x1 && z === z1 && Math.abs(y1 - y0 - rise) < 1e-4, 'each post stands `rise` tall');
    const onEdge = Math.abs(Math.abs(x - site.x) - half) < 1e-6 || Math.abs(Math.abs(z - site.z) - half) < 1e-6;
    assert(onEdge && Math.abs(x - site.x) <= half + 1e-6 && Math.abs(z - site.z) <= half + 1e-6, 'on the square\'s edge');
    assert(y0 >= 1.5 - 1e-6, 'never under the sea');
  }
  assert.deepEqual(P.slice(0, 3), P.slice((n - 1) * 6, (n - 1) * 6 + 3), 'closed');
  // The foot is the ground: at a lattice vertex the curtain's bilinear height is the sample's.
  const i = Math.round((site.x - half) / size * (res - 1) + (res - 1) / 2), j = Math.round((site.z - half) / size * (res - 1) + (res - 1) / 2);
  const cornerX = (i / (res - 1) - 0.5) * size, cornerZ = (j / (res - 1) - 0.5) * size;
  if (Math.abs(cornerX - (site.x - half)) < 1e-6 && Math.abs(cornerZ - (site.z - half)) < 1e-6)
    assert(Math.abs(P[1] - (Math.max(heights[j * res + i] - sea, 0) * EXAGGERATION + 1.5)) < 1e-3, 'the foot is the ground');
  assert(top.x === site.x && top.z === site.z && top.y > 0);
  ok(`a site's curtain: ${n} posts round its ${site.span} m square, on the ground, ${rise} m tall, closed`);
}
console.log('World view: OK');
