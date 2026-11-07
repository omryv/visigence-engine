/* The water a river actually shows: a stepped ribbon above sea level.
 *
 * The sea is ONE plane at one height (Water.js) — deliberately, and that
 * deliberate limit is exactly what a river breaks: its surface stands above
 * the sea and descends. So each authored river (params.terrain.rivers,
 * written by the editor's River tool or the landform's river op) gets a
 * ribbon: a triangle strip along its stored centreline, y from the stepped
 * water heights the solver measured, width from the record, banks feathered
 * to nothing so the edge is a wet margin rather than a polygon.
 *
 * What this is NOT: a fluid, a flow map, or a second sea. It ends where the
 * course reaches the waterline — from there down, the one sea plane owns the
 * water — and a pooled reach simply rides at its spill height like any other
 * step, which is what the solver's cumulative-minimum heights already say.
 *
 * The reveal: a river that was just carved runs IN, head to mouth, at the
 * same pacing the sea's flood front uses (Water.js FLOOD_SPEED), driven by
 * one uniform over the ribbon's arc length. `reveal(0)` then tick() is the
 * whole protocol; a loaded world starts settled at 1.
 */

import * as THREE from "three";
import {
  Fn, If, Discard, attribute, uniform, vec2, vec3, vec4, float, positionLocal, positionWorld, modelWorldMatrix, cameraPosition,
  sin, abs, max, mix, clamp, dot, length, normalize, smoothstep, step,
} from "three/tsl";
import { atmApply } from "../render/atmosphere.js";
import { wgNoise } from "../render/nodes.js";

// Same pacing family as the sea's flood front (Water.js): metres per second,
// clamped so a brook is watchable and a long river does not take a minute.
const RUN_SPEED = 70;
const RUN_MIN_S = 0.45;
const RUN_MAX_S = 4.0;

// How far past the stated width the wet margin feathers, as a fraction.
const BANK_OVERSHOOT = 0.3;
// The ribbon rides this far above the carved bed's water heights — enough to
// clear the 8 m grid's bilinear error, not enough to read as levitation.
const SURFACE_LIFT = 0.22;

/* The ribbon as a node graph: term for term the GLSL it replaced, minus its
   tone map (the renderer applies one to the whole frame). */
function riverNodes(u) {
  const side = attribute("aSide", "float"), arc = attribute("aArc", "float");
  // The one motion a narrow water can afford: a few centimetres of ripple.
  const w = modelWorldMatrix.mul(vec4(positionLocal, 1));
  const positionNode = positionLocal.add(vec3(0, sin(w.x.mul(0.21).add(w.z.mul(0.17)).add(u.uTime.mul(1.7))).mul(0.045), 0));
  const fragment = Fn(() => {
    const W = positionWorld;
    // A river reads as its shallows with a darker thread down the middle.
    const centre = float(1).sub(abs(side));
    const col = mix(u.uShallow, u.uDeep, centre.mul(0.45)).toVar();
    // Downstream shimmer: noise advected ALONG the course.
    const run = wgNoise(vec2(arc.mul(90).sub(u.uTime.mul(0.9)), W.x.mul(0.05).add(W.z.mul(0.05))));
    col.addAssign(vec3(0.05, 0.06, 0.06).mul(run.sub(0.5)).mul(centre));
    // Sun glint, gated to face-on sun like the sea's.
    const V = normalize(cameraPosition.sub(W));
    const sunFace = max(dot(normalize(vec3(u.uSunDir.x, 0.35, u.uSunDir.z)), V), 0);
    col.addAssign(vec3(0.22).mul(step(0.994, wgNoise(W.xz.mul(1.4).add(u.uTime.mul(0.5))))).mul(max(u.uSunDir.y, 0)).mul(sunFace));
    // The banks feather to nothing, and the head of the course fades in.
    const alpha = smoothstep(0, 0.45, centre).mul(0.82).mul(smoothstep(0, 0.03, arc)).toVar();
    // The run-in: water exists up to uReveal of the course, with a white
    // leading edge like the sea's flood front.
    const ahead = arc.sub(u.uReveal);
    If(ahead.greaterThan(0), () => { Discard(); });
    const front = smoothstep(-0.05, 0, ahead);
    col.assign(mix(col, vec3(0.93, 0.96, 0.95), front.mul(0.7)));
    alpha.assign(max(alpha, front.mul(0.8)));
    const hazed = atmApply(u, col, W, cameraPosition);
    const hazeAmt = clamp(length(hazed.sub(col)).mul(2.5), 0, 1);
    return vec4(hazed, mix(alpha, 1, hazeAmt.mul(0.9)));
  })();
  return { positionNode, fragment };
}

/* One ribbon from one river record. `record.path` is [[x, z, yWater] …];
   the strip stops at the first point at or below `level` — the sea owns the
   water from there. Returns null for a course too short to draw. */
function ribbonGeometry(record, level) {
  const path = (record.path || []).filter((p) => Array.isArray(p) && p.length >= 3);
  // Keep one point past the waterline so the ribbon overlaps the sea plane
  // instead of stopping a metre short of it.
  let end = path.findIndex((p) => p[2] <= level);
  const pts = end === -1 ? path : path.slice(0, Math.min(end + 2, path.length));
  if (pts.length < 2) return null;

  const half = ((record.width || 14) / 2) * (1 + BANK_OVERSHOOT);
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3);
  const side = new Float32Array(n * 2);
  const arc = new Float32Array(n * 2);
  const lens = new Float32Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    lens[i] = total;
  }
  if (total <= 0) return null;

  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    let tx = next[0] - prev[0], tz = next[1] - prev[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    // Perpendicular in the ground plane; y is the stepped water height.
    const px = -tz, pz = tx;
    const y = Math.max(pts[i][2], level) + SURFACE_LIFT;
    const a = lens[i] / total;
    for (const [k, s] of [[0, -1], [1, 1]]) {
      const v = i * 2 + k;
      pos[v * 3] = pts[i][0] + px * half * s;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = pts[i][1] + pz * half * s;
      side[v] = s;
      arc[v] = a;
    }
  }

  const index = [];
  for (let i = 0; i < n - 1; i++) {
    const a0 = i * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
    index.push(a0, b0, a1, b0, b1, a1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
  geo.setAttribute("aArc", new THREE.BufferAttribute(arc, 1));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  geo.userData.courseLength = total;
  return geo;
}

export class RiverSurface {
  /** `atmos` is the engine's shared Atmosphere (live uniform objects). */
  constructor({ palette, atmos }) {
    this.group = new THREE.Group();
    this.group.name = "rivers";
    this.uniforms = {
      ...atmos.uniforms,
      uTime: { value: 0 },
      uReveal: { value: 1 },
      uShallow: { value: new THREE.Color(palette.water.shallow) },
      uDeep: { value: new THREE.Color(palette.water.deep) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    for (const k of Object.keys(this.uniforms)) if (!this.uniforms[k].isNode) this.uniforms[k] = uniform(this.uniforms[k].value);
    const nodes = riverNodes(this.uniforms);
    this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.material.positionNode = nodes.positionNode;
    this.material.fragmentNode = nodes.fragment;
    this._revealSpeed = 0;
    this._longest = 0;
  }

  /** Rebuild every ribbon from the records. Idempotent; disposes what stood. */
  setRivers(records, level = 0) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.geometry.dispose();
    }
    this._longest = 0;
    for (const rec of records || []) {
      const geo = ribbonGeometry(rec, level);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = `river:${rec.id || "?"}`;
      this.group.add(mesh);
      this._longest = Math.max(this._longest, geo.userData.courseLength);
    }
  }

  get count() { return this.group.children.length; }

  setPalette(palette) {
    this.uniforms.uShallow.value.setHex(palette.water.shallow);
    this.uniforms.uDeep.value.setHex(palette.water.deep);
  }
  setSunDir(dir) { this.uniforms.uSunDir.value.copy(dir); }

  /** Run the water in from the head: reveal sweeps 0→1 at the flood front's
      pacing over the longest course. A world loaded settled never calls this. */
  runIn() {
    if (!this.count) return;
    const secs = Math.min(Math.max(this._longest / RUN_SPEED, RUN_MIN_S), RUN_MAX_S);
    this.uniforms.uReveal.value = 0;
    this._revealSpeed = 1 / secs;
  }

  /** Advance ripple + any running reveal; true while something is moving. */
  tick(dt) {
    this.uniforms.uTime.value += dt;
    if (this._revealSpeed > 0) {
      const v = Math.min(1, this.uniforms.uReveal.value + dt * this._revealSpeed);
      this.uniforms.uReveal.value = v;
      if (v >= 1) this._revealSpeed = 0;
      return true;
    }
    return false;
  }

  dispose() {
    this.setRivers([]);
    this.material.dispose();
  }
}
