// Fire: procedural flames, embers, smoke, a flickering light — and
// combustion, because fire that doesn't BURN is a screensaver. Igniting a
// placed object chars its materials over ~9 seconds (dark, matte, done),
// while the flame itself is three cross-billboarded quads per fire running a
// noise-eroded flame shader, a GPU-animated ember fountain and a slow smoke
// column. Everything is one draw call per layer regardless of fire count.
//
// Ground fires persist in params.fx.fires ({x, z, r} each), so a burning
// world is still just params — VSight and a reload relight the same fires.
// Charring is session state by design: the record of WHAT burned lives with
// whoever ignited it, not in the world contract.
//
// GPU discipline: flames/embers/smoke are driven entirely by uTime — no
// per-frame attribute uploads. The only CPU work per frame is assigning the
// tier's few PointLights to the nearest fires and easing char colours.

import * as THREE from "three";
import {
  Fn, If, Discard, uniform, attribute, instancedBufferAttribute, uv, varying, vec2, vec3, vec4, float, fract, sin, cos, atan,
  abs, max, pow, mix, clamp, length, normalize, cross, smoothstep, cameraPosition, positionGeometry, positionView,
} from "three/tsl";
import { wgNoise } from "../render/nodes.js";
import { CHAR_SECONDS, CHAR_HEX, burnFieldFor, reseatFires } from "./burn-spec.js";

// Re-exported so callers reach the burn rules through the fire system they
// are already talking to (engine/fx/burn-spec.js is the definition).
export { isPlantRef, PLANT_IGNITE_SCALE, SCORCH_RADIUS_SCALE, CHAR_SECONDS } from "./burn-spec.js";

const MAX_FIRES = 48;
const QUADS_PER_FIRE = 3;
const EMBERS_PER_FIRE = 26;
const SMOKE_PER_FIRE = 5;
const CHAR_COLOR = new THREE.Color(CHAR_HEX);

/* The three layers as nodes: term for term the GLSL programs they replaced.
   Values above 1 are HDR on purpose; the renderer's tone map rolls the core
   off to white. */
const hash1 = (n) => fract(sin(n).mul(43758.5453));

/* Flames: three cross-billboarded quads per fire, yawing toward the camera's
   half-space, swaying, a teardrop eroded by upward-scrolling noise. Rain guts a
   fire it can reach and does nothing at all to a hearth. */
function flameNodes(u) {
  const F = attribute("aFire", "vec4"), Q = attribute("aQuad", "vec2"), roof = attribute("aRoof", "float");
  const seed = fract(F.x.mul(0.731).add(F.z.mul(0.377)));
  const wet = u.uRain.mul(float(1).sub(roof));
  const damp = varying(float(1).sub(wet.mul(0.72)));
  const r = F.w.mul(float(1).sub(wet.mul(0.45)));
  const toCam = normalize(cameraPosition.sub(F.xyz));
  const ang = Q.x.mul(2.0943951).add(atan(toCam.x, toCam.z).mul(0.35));
  const right = vec3(cos(ang), 0, sin(ang).negate());
  const sway = sin(u.uTime.mul(2.3).add(seed.mul(17)).add(Q.x)).mul(0.12).add(sin(u.uTime.mul(5.1).add(seed.mul(31))).mul(0.05));
  const P = positionGeometry;
  const base = F.xyz.add(right.mul(P.x.mul(r).mul(1.35))).add(vec3(0, P.y.add(0.5).mul(r).mul(2.6), 0));
  const lean = sway.mul(r).mul(P.y.add(0.5));
  const positionNode = base.add(vec3(lean, 0, lean));
  const vSeed = varying(seed);
  const fragment = Fn(() => {
    const st = uv();
    const t = u.uTime.mul(1.9).add(vSeed.mul(43));
    const n = wgNoise(vec2(st.x.mul(3).add(vSeed.mul(9)), st.y.mul(4).sub(t))).mul(0.65)
      .add(wgNoise(vec2(st.x.mul(7).sub(vSeed.mul(5)), st.y.mul(9).sub(t.mul(1.7)))).mul(0.35));
    const cx = abs(st.x.sub(0.5)).mul(2);
    const body = float(1).sub(cx.mul(cx)).mul(float(1).sub(st.y));
    const flame = body.mul(float(0.75).add(n.mul(0.5))).sub(st.y.mul(0.22)).sub(cx.mul(0.18));
    If(flame.lessThan(0.02), () => { Discard(); });
    // White-hot core → orange → deep red rim.
    const k = clamp(flame.mul(2.4), 0, 1);
    const col = mix(mix(vec3(3.2, 0.35, 0.05), vec3(4.5, 1.6, 0.25), k), vec3(5.5, 4.2, 2.6), pow(k, 3).mul(float(1).sub(st.y.mul(0.6))));
    return vec4(col.mul(damp), clamp(flame.mul(2.2), 0, 1).mul(0.9).mul(damp));
  })();
  return { positionNode, fragment };
}

/* Embers: an instanced sprite per spark (WebGPU draws points one pixel wide),
   each on its own cycle, swirling up and out, sized by distance, glinting. */
function emberMaterial(fireAttr, seedAttr, u) {
  const F = instancedBufferAttribute(fireAttr), s = instancedBufferAttribute(seedAttr);
  const r = F.w;
  const cycle = float(2.2).add(hash1(s).mul(2.4));
  const t = fract(u.uTime.add(s.mul(7.31)).div(cycle));
  const swirl = s.mul(39.77).add(t.mul(float(2).add(hash1(s.add(2)).mul(3))));
  const rad = float(0.15).add(hash1(s.add(1)).mul(0.55)).mul(r).mul(float(1).sub(t.mul(0.4)));
  const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false });
  m.positionNode = F.xyz.add(vec3(cos(swirl).mul(rad), t.mul(t).mul(r).mul(float(2.8).add(hash1(s.add(3)).mul(2))).add(t.mul(r).mul(1.6)), sin(swirl).mul(rad)));
  m.sizeNode = float(30).mul(r).mul(float(1).sub(t.mul(0.7))).div(max(positionView.z.negate(), 1));
  const glow = varying(float(1).sub(t).mul(float(0.55).add(sin(u.uTime.mul(11).add(s.mul(91))).mul(0.45))));
  m.fragmentNode = Fn(() => {
    const d = length(uv().sub(0.5));
    If(d.greaterThan(0.5), () => { Discard(); });
    const a = smoothstep(0.5, 0.1, d).mul(glow);
    return vec4(vec3(3.4, 1.15, 0.18).mul(a), a);
  })();
  return m;
}

/* Smoke: camera-facing puffs climbing and spreading over their cycle. */
function smokeNodes(u) {
  const F = attribute("aFire", "vec4"), Q = attribute("aQuad", "vec2"), r = F.w;
  const seed = Q.x.mul(3.7).add(fract(F.x.mul(0.311).add(F.z.mul(0.677))).mul(19));
  const cycle = float(5).add(hash1(seed).mul(3));
  const t = fract(u.uTime.mul(0.55).add(seed.mul(1.7)).div(cycle));
  const grow = float(0.7).add(t.mul(2.4));
  const center = F.xyz.add(vec3(
    sin(t.mul(5).add(seed)).mul(r).mul(0.5).mul(t),
    r.mul(2.2).add(t.mul(r).mul(float(6.5).add(hash1(seed.add(1)).mul(3)))),
    cos(t.mul(4).add(seed.mul(2))).mul(r).mul(0.5).mul(t)));
  const look = normalize(cameraPosition.sub(center));
  const right = normalize(cross(vec3(0, 1, 0), look));
  const up2 = cross(look, right);
  const P = positionGeometry;
  const positionNode = center.add(right.mul(P.x).add(up2.mul(P.y)).mul(r).mul(grow));
  const fade = varying(float(1).sub(t).mul(smoothstep(0, 0.12, t)));
  const vSeed = varying(seed);
  const fragment = Fn(() => {
    const st = uv();
    const d = length(st.sub(0.5)).mul(2);
    const n = wgNoise(st.mul(5).add(vSeed).add(vec2(0, u.uTime.mul(-0.35))));
    const a = smoothstep(1, 0.25, d.add(n.mul(0.45))).mul(fade).mul(0.32);
    If(a.lessThan(0.01), () => { Discard(); });
    return vec4(vec3(0.16, 0.15, 0.145), a);
  })();
  return { positionNode, fragment };
}

export class FireFX {
  constructor({ quality }) {
    this.group = new THREE.Group();
    this.group.name = "fx:fire";
    this.fires = [];          // { x, y, z, r, uid|null }
    this._burns = new Map();  // uid → { object, mats: [{ mat, color, rough }], t }
    this._timeU = uniform(0);

    // How hard it is raining on the world, eased by the engine. Shared by
    // reference with all three flame materials.
    this._rainU = uniform(0);
    const u = { uTime: this._timeU, uRain: this._rainU };
    const quadMat = (nodes, blending) => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending, side: THREE.DoubleSide, fog: false });
      m.positionNode = nodes.positionNode; m.fragmentNode = nodes.fragment;
      return m;
    };
    this._flameMat = quadMat(flameNodes(u), THREE.AdditiveBlending);
    this._smokeMat = quadMat(smokeNodes(u), THREE.NormalBlending);
    // The embers' material reads the instance buffers it was built over, so it
    // is made with them (see the ember block in _buildMeshes).
    this._emberMat = null;
    this._flames = null; this._embers = null; this._smoke = null;

    // Flickering firelight: a small pool assigned to the nearest fires.
    this._lights = [];
    for (let i = 0; i < (quality.fireLights ?? 2); i++) {
      const l = new THREE.PointLight(0xff7a2a, 0, 60, 1.8);
      l.castShadow = false;
      this.group.add(l);
      this._lights.push(l);
    }
  }

  get count() { return this.fires.length; }

  /* ── weather reaches a fire, or it does not ──
     `shelterFn(x, y, z)` answers 1 under a roof and 0 under the sky
     (js/shelter.js). `rain` is how hard it is falling. Together they are the
     difference between a hearth that burns through a storm and a watch fire
     that gutters out in it. */
  setShelterFn(fn) { this._shelterFn = fn || null; this._rebuild(); }
  setRain(v) { if (this._rainU) this._rainU.value = Math.max(0, Math.min(1, v || 0)); }
  _shelterOf(f) {
    if (!this._shelterFn) return 0;
    try { return this._shelterFn(f.x, f.y + f.r * 0.8, f.z) ? 1 : 0; } catch { return 0; }
  }

  addFire(fire) {
    if (this.fires.length >= MAX_FIRES) return null;
    // `t` is the fire's age in seconds. It drives how far the scorch has
    // eaten into the vegetation around it, so a fire that was just lit has
    // not burnt anything yet.
    fire.t = fire.t ?? 0;
    this.fires.push(fire);
    this._rebuild();
    return fire;
  }

  /* Re-seat every flame on the ground as it stands NOW.

     Sculpting moves the ground out from under a fire, and a flame left at
     its old height hangs in the air over the new hollow (or is swallowed by
     a raised hill). The y lives in three merged vertex buffers, so this
     rewrites just those components in place — no reallocation, which is what
     makes it cheap enough to run at the end of every brush stroke.

     Returns true when something actually moved. */
  reseat(heightAt) {
    if (!reseatFires(this.fires, heightAt)) return false;
    // Each mesh lays its fires out contiguously; vertsPerFire is the stride.
    const spans = [
      [this._flames, QUADS_PER_FIRE * 4],
      [this._embers, EMBERS_PER_FIRE],
      [this._smoke, SMOKE_PER_FIRE * 4],
    ];
    for (const [mesh, vertsPerFire] of spans) {
      const attr = mesh?.userData.aFire ?? mesh?.geometry.getAttribute("aFire");
      if (!attr) continue;
      for (let v = 0; v < attr.count; v++) {
        const f = this.fires[Math.floor(v / vertsPerFire)];
        if (f) attr.setY(v, f.y);
      }
      attr.needsUpdate = true;
    }
    return true;
  }

  // The heat field the vegetation shaders burn from — see burn-spec.js.
  burnField() { return burnFieldFor(this.fires); }

  removeFire(pred) {
    const before = this.fires.length;
    this.fires = this.fires.filter((f) => !pred(f));
    if (this.fires.length !== before) this._rebuild();
    return before - this.fires.length;
  }

  // Drop every flame but KEEP char state: a world rebuild re-adds fires from
  // params while the burnt objects themselves persist. Orphaned burns are
  // collected by tick() when their object leaves the scene graph.
  clear() {
    this.fires = [];
    this._rebuild();
  }

  // Char a placed object's materials in place. Clones them first — proc
  // parts and GLB clones SHARE materials, and scorching one crate must not
  // scorch its siblings. Ownership flags are updated so disposeBuilt()
  // frees exactly the clones (the same contract the ghost fade uses).
  igniteObject(uid, object) {
    if (this._burns.has(uid)) return;
    const mats = [];
    object.traverse((o) => {
      if (!o.isMesh) return;
      const prev = o.material;
      if (!prev || !prev.color) return;
      const clone = prev.clone();
      o.material = clone;
      if (o.userData.ownMat) prev.dispose();
      o.userData.ownMat = true;
      mats.push({ mat: clone, color: clone.color.clone(), rough: clone.roughness ?? 0.85 });
    });
    this._burns.set(uid, { object, mats, t: 0 });
  }

  isBurning(uid) {
    return this._burns.has(uid) || this.fires.some((f) => f.uid === uid);
  }

  extinguish(uid) {
    this._burns.delete(uid); // burnt is burnt — the char stays
    this.removeFire((f) => f.uid === uid);
  }

  /* Rebuild the merged buffers. Fires change rarely (a click), never per
     frame — everything between rebuilds is uTime-driven on the GPU. */
  _rebuild() {
    this._dropMeshes();
    const n = this.fires.length;
    if (!n) return;

    { // flames: QUADS_PER_FIRE unit quads per fire
      const quads = n * QUADS_PER_FIRE;
      const pos = new Float32Array(quads * 4 * 3);
      const uv = new Float32Array(quads * 4 * 2);
      const fire = new Float32Array(quads * 4 * 4);
      const quad = new Float32Array(quads * 4 * 2);
      const roof = new Float32Array(quads * 4);
      const idx = [];
      let q = 0;
      for (const f of this.fires) {
        // What stands between this fire and the sky. Cached per fire rather
        // than sampled per frame: it changes when a building is placed or the
        // ground moves, both of which already rebuild or re-seat.
        const sh = this._shelterOf(f);
        for (let k = 0; k < QUADS_PER_FIRE; k++, q++) {
          const corners = [[-0.5, -0.5, 0, 0], [0.5, -0.5, 1, 0], [0.5, 0.5, 1, 1], [-0.5, 0.5, 0, 1]];
          for (let c = 0; c < 4; c++) {
            const v = q * 4 + c;
            pos[v * 3] = corners[c][0]; pos[v * 3 + 1] = corners[c][1]; pos[v * 3 + 2] = 0;
            uv[v * 2] = corners[c][2]; uv[v * 2 + 1] = corners[c][3];
            fire[v * 4] = f.x; fire[v * 4 + 1] = f.y; fire[v * 4 + 2] = f.z; fire[v * 4 + 3] = f.r;
            quad[v * 2] = k; quad[v * 2 + 1] = c;
            roof[v] = sh;
          }
          idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setAttribute("aFire", new THREE.BufferAttribute(fire, 4));
      geo.setAttribute("aRoof", new THREE.BufferAttribute(roof, 1));
      geo.setAttribute("aQuad", new THREE.BufferAttribute(quad, 2));
      geo.setIndex(idx);
      this._flames = new THREE.Mesh(geo, this._flameMat);
      this._flames.frustumCulled = false;
      this.group.add(this._flames);
    }

    { // embers: points
      const total = n * EMBERS_PER_FIRE;
      const fire = new Float32Array(total * 4);
      const seed = new Float32Array(total);
      let i = 0;
      for (const f of this.fires) {
        for (let k = 0; k < EMBERS_PER_FIRE; k++, i++) {
          fire[i * 4] = f.x; fire[i * 4 + 1] = f.y; fire[i * 4 + 2] = f.z; fire[i * 4 + 3] = f.r;
          seed[i] = i * 1.618 + 0.37;
        }
      }
      const fireAttr = new THREE.InstancedBufferAttribute(fire, 4);
      this._emberMat?.dispose();
      this._emberMat = emberMaterial(fireAttr, new THREE.InstancedBufferAttribute(seed, 1), { uTime: this._timeU });
      this._embers = new THREE.Sprite(this._emberMat);
      this._embers.count = total;
      this._embers.userData.aFire = fireAttr;   // reseat() moves the fires through this
      this._embers.frustumCulled = false;
      this.group.add(this._embers);
    }

    { // smoke: SMOKE_PER_FIRE billboards per fire
      const quads = n * SMOKE_PER_FIRE;
      const pos = new Float32Array(quads * 4 * 3);
      const uv = new Float32Array(quads * 4 * 2);
      const fire = new Float32Array(quads * 4 * 4);
      const quad = new Float32Array(quads * 4 * 2);
      const idx = [];
      let q = 0;
      for (const f of this.fires) {
        for (let k = 0; k < SMOKE_PER_FIRE; k++, q++) {
          const corners = [[-0.5, -0.5, 0, 0], [0.5, -0.5, 1, 0], [0.5, 0.5, 1, 1], [-0.5, 0.5, 0, 1]];
          for (let c = 0; c < 4; c++) {
            const v = q * 4 + c;
            pos[v * 3] = corners[c][0]; pos[v * 3 + 1] = corners[c][1]; pos[v * 3 + 2] = 0;
            uv[v * 2] = corners[c][2]; uv[v * 2 + 1] = corners[c][3];
            fire[v * 4] = f.x; fire[v * 4 + 1] = f.y; fire[v * 4 + 2] = f.z; fire[v * 4 + 3] = f.r;
            quad[v * 2] = k; quad[v * 2 + 1] = c;
          }
          idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setAttribute("aFire", new THREE.BufferAttribute(fire, 4));
      geo.setAttribute("aQuad", new THREE.BufferAttribute(quad, 2));
      geo.setIndex(idx);
      this._smoke = new THREE.Mesh(geo, this._smokeMat);
      this._smoke.frustumCulled = false;
      this.group.add(this._smoke);
    }
  }

  // Advance flames, embers, char and firelight. Returns true while anything
  // is alive — the engine keeps rendering for as long as fire exists.
  tick(dt, camera) {
    let alive = false;
    if (this.fires.length) {
      alive = true;
      this._timeU.value += dt;
      // Age every fire so its scorch ring keeps eating outward (burnField).
      for (const f of this.fires) f.t = (f.t ?? 0) + dt;
      // Assign the light pool to the nearest fires, flicker seeded per fire.
      const t = this._timeU.value;
      const byDist = this._lights.length >= this.fires.length ? this.fires
        : [...this.fires].sort((a, b) =>
            (Math.hypot(a.x - camera.position.x, a.z - camera.position.z))
          - (Math.hypot(b.x - camera.position.x, b.z - camera.position.z)));
      const rain = this._rainU?.value || 0;
      for (let i = 0; i < this._lights.length; i++) {
        const l = this._lights[i], f = byDist[i];
        if (!f) { l.intensity = 0; continue; }
        const s = f.x * 0.713 + f.z * 0.371;
        l.position.set(f.x, f.y + f.r * 1.6, f.z);
        l.distance = f.r * 26;
        /* Rain that reaches the fire takes the light out of it, and what is
           left is unsteady: a wet fire does not merely dim, it staggers. */
        const wet = rain * (1 - this._shelterOf(f));
        const gust = 1 + Math.sin(t * 3.1 + s * 5.3) * wet * 0.55;
        l.intensity = f.r * (26 + Math.sin(t * 9.0 + s) * 5 + Math.sin(t * 23.0 + s * 3.1) * 3)
          * (1 - wet * 0.72) * gust;
      }
    }
    // Charring eases each burnt object toward coal.
    for (const [uid, burn] of this._burns) {
      if (!burn.object.parent) { this._burns.delete(uid); continue; } // deleted while burning
      if (burn.t >= CHAR_SECONDS) continue;
      burn.t = Math.min(burn.t + dt, CHAR_SECONDS);
      const k = burn.t / CHAR_SECONDS;
      const ease = k * k * (3 - 2 * k) * 0.92; // never quite pure black
      for (const m of burn.mats) {
        m.mat.color.copy(m.color).lerp(CHAR_COLOR, ease);
        if (m.mat.roughness !== undefined) m.mat.roughness = m.rough + (1 - m.rough) * ease;
      }
      alive = true;
    }
    return alive;
  }

  _dropMeshes() {
    for (const m of [this._flames, this._embers, this._smoke]) {
      if (!m) continue;
      this.group.remove(m);
      if (!m.isSprite) m.geometry.dispose(); // materials are shared class-level and kept
    }
    this._flames = this._embers = this._smoke = null;
  }

  dispose() {
    this._dropMeshes();
    this._burns.clear();
    for (const m of [this._flameMat, this._emberMat, this._smokeMat]) m?.dispose();
  }
}
