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
import "../render/chunks.js";   // registers wg_noise
import { CHAR_SECONDS, CHAR_HEX, burnFieldFor, reseatFires } from "./burn-spec.js";

// Re-exported so callers reach the burn rules through the fire system they
// are already talking to (engine/fx/burn-spec.js is the definition).
export { isPlantRef, PLANT_IGNITE_SCALE, SCORCH_RADIUS_SCALE, CHAR_SECONDS } from "./burn-spec.js";

const MAX_FIRES = 48;
const QUADS_PER_FIRE = 3;
const EMBERS_PER_FIRE = 26;
const SMOKE_PER_FIRE = 5;
const CHAR_COLOR = new THREE.Color(CHAR_HEX);

const FLAME_VERT = /* glsl */`
  attribute vec4 aFire;    // xyz = fire origin, w = radius
  attribute vec2 aQuad;    // x = quad index within fire, y = corner phase
  attribute float aRoof;   // 1 = a roof stands between this fire and the sky
  varying vec2 vUv;
  varying float vSeed;
  varying float vDamp;
  uniform float uTime;
  uniform float uRain;     // how hard it is falling, 0..1
  void main() {
    vUv = uv;
    vSeed = fract(aFire.x * 0.731 + aFire.z * 0.377);
    /* Rain guts a fire it can reach and does nothing at all to a hearth.
       Before this, a fire burned identically in a downpour and under a roof,
       which is the same missing fact as rain falling through ceilings: the
       weather did not know what was between it and the thing it fell on. */
    float wet = uRain * (1.0 - aRoof);
    vDamp = 1.0 - wet * 0.72;
    float r = aFire.w * (1.0 - wet * 0.45);
    // Cross-billboard: each quad yaws around the fire axis toward the
    // camera half-space so the volume reads from every angle.
    float ang = aQuad.x * 2.0943951; // 120° apart
    vec3 toCam = normalize(cameraPosition - aFire.xyz);
    ang += atan(toCam.x, toCam.z) * 0.35;
    vec3 right = vec3(cos(ang), 0.0, -sin(ang));
    // Sway: the column leans and recovers, quads slightly out of phase.
    float sway = sin(uTime * 2.3 + vSeed * 17.0 + aQuad.x) * 0.12
               + sin(uTime * 5.1 + vSeed * 31.0) * 0.05;
    vec3 p = aFire.xyz
           + right * (position.x * r * 1.35)
           + vec3(0.0, (position.y + 0.5) * r * 2.6, 0.0);
    p.xz += sway * r * (position.y + 0.5);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const FLAME_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  varying float vSeed;
  varying float vDamp;
  uniform float uTime;
#include <wg_noise>
  void main() {
    vec2 uv = vUv;
    // Flame body: a teardrop mask eroded by upward-scrolling noise.
    float t = uTime * 1.9 + vSeed * 43.0;
    float n = wgNoise(vec2(uv.x * 3.0 + vSeed * 9.0, uv.y * 4.0 - t)) * 0.65
            + wgNoise(vec2(uv.x * 7.0 - vSeed * 5.0, uv.y * 9.0 - t * 1.7)) * 0.35;
    float cx = abs(uv.x - 0.5) * 2.0;
    float body = (1.0 - cx * cx) * (1.0 - uv.y);
    float flame = body * (0.75 + 0.5 * n) - uv.y * 0.22 - cx * 0.18;
    if (flame < 0.02) discard;
    // Colour ramp: white-hot core → orange → deep red rim. HDR values on
    // purpose — the bloom pass turns the core into glow.
    float k = clamp(flame * 2.4, 0.0, 1.0);
    vec3 col = mix(vec3(3.2, 0.35, 0.05), vec3(4.5, 1.6, 0.25), k);
    col = mix(col, vec3(5.5, 4.2, 2.6), pow(k, 3.0) * (1.0 - uv.y * 0.6));
    gl_FragColor = vec4(col * vDamp, clamp(flame * 2.2, 0.0, 1.0) * 0.9 * vDamp);
  }
`;

const EMBER_VERT = /* glsl */`
  attribute vec4 aFire;   // xyz origin, w radius
  attribute float aSeed;
  varying float vGlow;
  uniform float uTime;
  float ehash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    float r = aFire.w;
    float cycle = 2.2 + ehash(aSeed) * 2.4;
    float t = fract((uTime + aSeed * 7.31) / cycle);
    float ang = aSeed * 39.77;
    float swirl = ang + t * (2.0 + ehash(aSeed + 2.0) * 3.0);
    float rad = (0.15 + ehash(aSeed + 1.0) * 0.55) * r * (1.0 - t * 0.4);
    vec3 p = aFire.xyz + vec3(
      cos(swirl) * rad,
      t * t * r * (2.8 + ehash(aSeed + 3.0) * 2.0) + t * r * 1.6,
      sin(swirl) * rad);
    vGlow = (1.0 - t) * (0.55 + 0.45 * sin(uTime * 11.0 + aSeed * 91.0));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_PointSize = (30.0 * r * (1.0 - t * 0.7)) / max(-mv.z, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const EMBER_FRAG = /* glsl */`
  precision highp float;
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.1, d) * vGlow;
    gl_FragColor = vec4(vec3(3.4, 1.15, 0.18) * a, a);
  }
`;

const SMOKE_VERT = /* glsl */`
  attribute vec4 aFire;
  attribute vec2 aQuad;   // x = puff index, y unused
  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;
  uniform float uTime;
  float shash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vUv = uv;
    float r = aFire.w;
    float seed = aQuad.x * 3.7 + fract(aFire.x * 0.311 + aFire.z * 0.677) * 19.0;
    vSeed = seed;
    float cycle = 5.0 + shash(seed) * 3.0;
    float t = fract((uTime * 0.55 + seed * 1.7) / cycle);
    float grow = 0.7 + t * 2.4;
    vec3 center = aFire.xyz + vec3(
      sin(t * 5.0 + seed) * r * 0.5 * t,
      r * 2.2 + t * r * (6.5 + shash(seed + 1.0) * 3.0),
      cos(t * 4.0 + seed * 2.0) * r * 0.5 * t);
    // Camera-facing billboard.
    vec3 look = normalize(cameraPosition - center);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), look));
    vec3 up2 = cross(look, right);
    vec3 p = center + (right * position.x + up2 * position.y) * r * grow;
    vFade = (1.0 - t) * smoothstep(0.0, 0.12, t);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const SMOKE_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;
  uniform float uTime;
#include <wg_noise>
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float n = wgNoise(vUv * 5.0 + vSeed + vec2(0.0, -uTime * 0.35));
    float a = smoothstep(1.0, 0.25, d + n * 0.45) * vFade * 0.32;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.16, 0.15, 0.145), a);
  }
`;

export class FireFX {
  constructor({ quality }) {
    this.group = new THREE.Group();
    this.group.name = "fx:fire";
    this.fires = [];          // { x, y, z, r, uid|null }
    this._burns = new Map();  // uid → { object, mats: [{ mat, color, rough }], t }
    this._timeU = { value: 0 };

    // How hard it is raining on the world, eased by the engine. Shared by
    // reference with all three flame materials.
    this._rainU = { value: 0 };
    const shader = (vert, frag, blending, depthWrite = false) => new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag,
      uniforms: { uTime: this._timeU, uRain: this._rainU },
      transparent: true, depthWrite, blending, side: THREE.DoubleSide,
    });
    this._flameMat = shader(FLAME_VERT, FLAME_FRAG, THREE.AdditiveBlending);
    this._emberMat = shader(EMBER_VERT, EMBER_FRAG, THREE.AdditiveBlending);
    this._smokeMat = shader(SMOKE_VERT, SMOKE_FRAG, THREE.NormalBlending);
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
      const attr = mesh?.geometry.getAttribute("aFire");
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
      const pos = new Float32Array(total * 3); // unused but required
      const fire = new Float32Array(total * 4);
      const seed = new Float32Array(total);
      let i = 0;
      for (const f of this.fires) {
        for (let k = 0; k < EMBERS_PER_FIRE; k++, i++) {
          fire[i * 4] = f.x; fire[i * 4 + 1] = f.y; fire[i * 4 + 2] = f.z; fire[i * 4 + 3] = f.r;
          seed[i] = i * 1.618 + 0.37;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aFire", new THREE.BufferAttribute(fire, 4));
      geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
      this._embers = new THREE.Points(geo, this._emberMat);
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
      m.geometry.dispose(); // materials are shared class-level and kept
    }
    this._flames = this._embers = this._smoke = null;
  }

  dispose() {
    this._dropMeshes();
    this._burns.clear();
    for (const m of [this._flameMat, this._emberMat, this._smokeMat]) m.dispose();
  }
}
