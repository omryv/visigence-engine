/* nodes.js — the shader functions more than one surface needs, as TSL.
 *
 * The node-material counterpart of render/chunks.js, which held them as GLSL
 * for the WebGLRenderer this engine used to run on (in the history at the
 * commit that brought the engine in, with the reasoning behind each). Same functions, same constants,
 * term for term, so a surface ported from GLSL computes what it computed
 * before: the value noise every surface shares, the triplanar weights and
 * signs, and the five-lane height blend. The ACES/sRGB output transform is
 * gone rather than ported: under WebGPURenderer every node material, the
 * hand-written sky and sea included, is tone mapped and encoded by the
 * renderer itself, so the frame is on one curve by construction.
 *
 * Same rule as chunks.js: a function goes here only when two surfaces
 * genuinely share it. A helper one shader uses stays in that shader.
 */
import { Fn, vec2, vec3, vec4, float, fract, sin, dot, floor, mix, abs, max, step, select } from "three/tsl";

/* Value noise on a unit lattice (chunks.js wgHash / wgNoise). */
export const wgHash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

export const wgNoise = Fn(([p]) => {
  const i = floor(p).toVar(), f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2))).toVar();
  return mix(
    mix(wgHash(i), wgHash(i.add(vec2(1, 0))), f.x),
    mix(wgHash(i.add(vec2(0, 1))), wgHash(i.add(vec2(1, 1))), f.x),
    f.y,
  );
});

/* Triplanar weights from a world normal, sharpened to the fourth power
   (chunks.js wgTriWeights: see the reasoning there). */
export const wgTriWeights = Fn(([n]) => {
  const w = abs(n).toVar();
  w.assign(w.mul(w)); w.assign(w.mul(w));
  return w.div(w.x.add(w.y).add(w.z).add(1e-5));
});

/* +1/−1 per axis and never 0 (chunks.js wgTriSign). */
export const wgTriSign = Fn(([n]) => vec3(
  select(n.x.lessThan(0), float(-1), float(1)),
  select(n.y.lessThan(0), float(-1), float(1)),
  select(n.z.lessThan(0), float(-1), float(1)),
));

/**
 * The five-lane height blend (chunks.js wgHeightBlend5). Built inline rather
 * than as an Fn because it has two outputs; returns `{ w, w5 }` nodes.
 * With w5 = 0 it is exactly the four-lane answer.
 */
export function wgHeightBlend5(weights, w5, heights, h5, contrast) {
  const h = mix(vec4(-1), heights.add(weights), step(1e-4, weights)).toVar();
  const g = select(w5.greaterThan(1e-4), h5.add(w5), float(-1)).toVar();
  const top = max(max(max(h.x, h.y), max(h.z, h.w)), g).toVar();
  const k = max(h.sub(top.sub(contrast)), 0).toVar();
  const k5 = max(g.sub(top.sub(contrast)), 0).toVar();
  const sum = k.x.add(k.y).add(k.z).add(k.w).add(k5).toVar();
  const ok = sum.greaterThan(1e-5);
  return {
    w: select(ok, k.div(sum), vec4(1, 0, 0, 0)),
    w5: select(ok, k5.div(sum), float(0)),
  };
}

/* A plain object of `{ value }` uniforms, as the engine's code reads and
   writes them, turned into TSL uniform nodes that keep the same `.value`
   (and the same object identity for vectors and colours), so every caller
   that does `u.uSunDir.value.copy(...)` or `u.uTime.value += dt` keeps
   working while a node graph reads the result. */
import { uniform } from "three/tsl";
export function uniformsOf(spec) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) out[k] = v && v.isNode ? v : uniform(v?.value ?? v);
  return out;
}

/* ── instanced vegetation ──
   Grass and the scatter displace each plant in its OWN space (wind, lean, the
   billboard turn, the distance collapse) and only then place it in the world,
   which is the order the GLSL patches ran in: at begin_vertex, before
   three applied instanceMatrix. Under node materials three applies the
   instance matrix BEFORE a material's positionNode, so a positionNode that
   wants the plant's own space reads the geometry's raw position and applies
   the instance matrix itself; the one three applied is then overwritten,
   never applied twice.

   The matrix is read from the mesh's own array through a second, interleaved
   view of it (the view three builds for itself is private to it). Whoever
   writes the matrices calls syncInstances(mesh) beside the
   `instanceMatrix.needsUpdate = true` it already sets. */
import { InstancedInterleavedBuffer, DynamicDrawUsage, Vector4 } from "three";
import { instancedDynamicBufferAttribute, mat4, uniformArray, positionGeometry, smoothstep, distance } from "three/tsl";
export function instanceMatrixNode(mesh) {
  const ib = new InstancedInterleavedBuffer(mesh.instanceMatrix.array, 16, 1);
  ib.setUsage(DynamicDrawUsage);
  mesh.userData.instanceView = ib;
  return mat4(...[0, 4, 8, 12].map((o) => instancedDynamicBufferAttribute(ib, "vec4", 16, o)));
}
export function syncInstances(mesh) {
  const ib = mesh.userData.instanceView;
  if (ib) ib.needsUpdate = true;
}
/** The raw (pre-instance) vertex position, for a positionNode that works in the instance's own space. */
export const ownPosition = positionGeometry;

/* ── the heat field ──
   (x, z, scorch radius, char) per fire, from FireFX.burnField(); the grass
   and the scatter both burn from it. A fixed array of MAX_BURN vec4s and a
   count, unrolled: the strongest fire wins rather than summing, so
   overlapping fires do not burn twice as black as physics allows. */
export const MAX_BURN = 12;
export function heatField() {
  const fires = Array.from({ length: MAX_BURN }, () => new Vector4());
  const node = uniformArray(fires, "vec4");
  const count = uniform(0);
  return {
    node, count,
    /** Copy a burn field in; true when it changed. */
    set(field) {
      const n = Math.min(((field?.length ?? 0) / 4) | 0, MAX_BURN);
      let changed = n !== count.value;
      for (let i = 0; i < n; i++) {
        const f = fires[i], o = i * 4;
        if (f.x !== field[o] || f.y !== field[o + 1] || f.z !== field[o + 2] || f.w !== field[o + 3]) {
          f.set(field[o], field[o + 1], field[o + 2], field[o + 3]); changed = true;
        }
      }
      count.value = n;
      return changed;
    },
    /** 0..1: how burnt a plant rooted at `xz` is. */
    at(xz) {
      let burn = float(0);
      for (let i = 0; i < MAX_BURN; i++) {
        const b = node.element(i);
        // max(): an unused slot is all zeros, and smoothstep(0, 0, d) is 0/0,
        // which the count's mask cannot cancel (NaN × 0 is NaN).
        const k = float(1).sub(smoothstep(0, max(b.z, 1e-3), distance(xz, b.xy))).mul(b.w).mul(step(i + 0.5, count));
        burn = max(burn, k);
      }
      return burn;
    },
  };
}
