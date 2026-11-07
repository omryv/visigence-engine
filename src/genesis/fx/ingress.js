/* ingress.js — the rain that gets in.
 *
 * Shelter (js/shelter.js) says a roof stops the weather, and that is most of
 * the truth. The rest of it is that a building is not sealed: a doorway and
 * an unglazed window are holes in the envelope, and what a person notices
 * standing in a room during a storm is not that the room is dry — it is the
 * spray coming through the window and the strip of floorboard under it gone
 * dark with wet.
 *
 * That could not be done in the shelter raster. A doorway is 1.2 m wide and
 * the raster's job is a whole world; resolving an opening there would cost
 * more texels than the rest of the system put together. So openings are
 * handled the way lamps are (fx/lamps.js): a BOUNDED POOL assigned to the
 * ones nearest the viewer. A hundred windows in a village cost what four do,
 * and the four you are standing next to are the four that leak.
 *
 * Each live opening gets two things:
 *
 *   a fall of spray, angled inward, drawn only while it is raining;
 *   a patch of wet floor inside it, which is what remains for the minutes
 *   after and what tells you the window was open.
 *
 * Both are one merged mesh apiece, animated entirely from uTime — the same
 * discipline as the weather volume, for the same reason.
 */

import * as THREE from "three";

const MAX_POOL = 6;
// How far in from the opening the spray reaches, and the wet with it. Rain
// does not blow four metres into a room through a cottage window.
const REACH = 1.55;

const SPRAY_VERT = /* glsl */`
  attribute vec3 aSlot;    // xyz = opening origin (world, at the sill)
  attribute vec4 aSpec;    // x,z = inward, y = width, w = height
  attribute vec2 aSeed;    // per-drop column phase
  attribute vec2 aCorner;
  varying float vAlpha;
  uniform float uTime;
  uniform float uRain;
  void main() {
    vec2 inward = vec2(aSpec.x, aSpec.z);
    vec2 along = vec2(-inward.y, inward.x);
    // Fall on its own phase; drift inward as it falls, because what comes
    // through an opening came through it sideways.
    float y01 = fract(aSeed.x + uTime * (1.1 + fract(aSeed.y * 5.7) * 0.5));
    float t = y01;
    vec3 p = aSlot
      + vec3(along.x, 0.0, along.y) * ((fract(aSeed.y * 13.1) - 0.5) * aSpec.y)
      + vec3(inward.x, 0.0, inward.y) * (t * ${REACH.toFixed(2)})
      + vec3(0.0, aSpec.w * (1.0 - t) - aSpec.w * 0.5, 0.0);
    vec3 toCam = cameraPosition - p;
    vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x) + vec3(1e-5));
    p += right * (aCorner.x * 0.012);
    p.y += aCorner.y * 0.34;
    // Fades in at the opening and out where it lands.
    vAlpha = uRain * smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.72, t);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const SPRAY_FRAG = /* glsl */`
  precision highp float;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(vec3(0.78, 0.85, 0.94), vAlpha * 0.3);
  }
`;

// The wet floor. A flat quad, darkening what it lies on rather than painting
// over it, so it reads as a damp board and not as a grey sticker.
const WET_VERT = /* glsl */`
  attribute vec3 aSlot;
  attribute vec4 aSpec;
  varying vec2 vUv;
  varying float vWet;
  uniform float uWet;
  void main() {
    vUv = uv;
    vec2 inward = vec2(aSpec.x, aSpec.z);
    vec2 along = vec2(-inward.y, inward.x);
    vWet = uWet * aSpec.w;
    vec3 p = aSlot
      + vec3(along.x, 0.0, along.y) * ((uv.x - 0.5) * (aSpec.y + 0.5))
      + vec3(inward.x, 0.0, inward.y) * (uv.y * ${REACH.toFixed(2)});
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const WET_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  varying float vWet;
  void main() {
    // Heaviest at the sill, ragged at its far edge — a puddle has no straight
    // side away from where the water came in.
    float e = smoothstep(1.0, 0.35, vUv.y) * smoothstep(0.0, 0.12, vUv.y);
    float s = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);
    float a = e * s * vWet;
    if (a < 0.01) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a * 0.55);
  }
`;

function sprayGeometry(slots, perSlot) {
  const n = slots * perSlot;
  const pos = new Float32Array(n * 4 * 3);
  const slot = new Float32Array(n * 4 * 3);
  const spec = new Float32Array(n * 4 * 4);
  const seed = new Float32Array(n * 4 * 2);
  const corner = new Float32Array(n * 4 * 2);
  const idx = [];
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  for (let i = 0; i < n; i++) {
    const sa = Math.random(), sb = Math.random();
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      seed[v * 2] = sa; seed[v * 2 + 1] = sb;
      corner[v * 2] = corners[c][0]; corner[v * 2 + 1] = corners[c][1];
    }
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSlot", new THREE.BufferAttribute(slot, 3));
  geo.setAttribute("aSpec", new THREE.BufferAttribute(spec, 4));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 2));
  geo.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
  geo.setIndex(idx);
  return geo;
}

function wetGeometry(slots) {
  const pos = new Float32Array(slots * 4 * 3);
  const uv = new Float32Array(slots * 4 * 2);
  const slot = new Float32Array(slots * 4 * 3);
  const spec = new Float32Array(slots * 4 * 4);
  const idx = [];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let i = 0; i < slots; i++) {
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      uv[v * 2] = uvs[c][0]; uv[v * 2 + 1] = uvs[c][1];
    }
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("aSlot", new THREE.BufferAttribute(slot, 3));
  geo.setAttribute("aSpec", new THREE.BufferAttribute(spec, 4));
  geo.setIndex(idx);
  return geo;
}

export class Ingress {
  constructor(THREE_, quality = {}) {
    this.group = new THREE.Group();
    this.group.name = "fx:ingress";
    this.slots = Math.max(0, Math.min(MAX_POOL, quality.ingressSlots ?? 0));
    this.perSlot = 26;
    this.apertures = [];
    this._rainU = { value: 0 };
    this._wetU = { value: 0 };
    this._timeU = { value: 0 };
    this._assigned = [];
    if (!this.slots) return;

    this._spray = new THREE.Mesh(sprayGeometry(this.slots, this.perSlot), new THREE.ShaderMaterial({
      vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG,
      uniforms: { uTime: this._timeU, uRain: this._rainU },
      transparent: true, depthWrite: false,
    }));
    this._spray.frustumCulled = false;
    this.group.add(this._spray);

    this._wet = new THREE.Mesh(wetGeometry(this.slots), new THREE.ShaderMaterial({
      vertexShader: WET_VERT, fragmentShader: WET_FRAG,
      uniforms: { uWet: this._wetU },
      transparent: true, depthWrite: false,
      // Multiply-ish: darken the boards, never lighten them.
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this._wet.frustumCulled = false;
    this.group.add(this._wet);
  }

  /* Every opening in the world (js/shelter.js), plus a way to ask whether a
     hinged one is currently open. Weather comes through what is actually
     open: an unfilled gap always, a door only while somebody has left it so. */
  setApertures(list, isOpen = null) {
    this.apertures = list || [];
    this._isOpen = isOpen;
    this._assigned = [];
    return this;
  }
  _leaks(a) { return !a.blocked || (a.hinged && this._isOpen?.(a.uid)); }

  setRain(v) {
    this._rainU.value = Math.max(0, Math.min(1, v || 0));
    // The wet outlasts the rain: it is what tells you the window was open.
    this._wetU.value = Math.max(this._wetU.value * 0.999, this._rainU.value);
  }

  /* Assign the pool to the openings nearest the viewer and write their
     geometry. Rewrites the attribute buffers only when the assignment
     actually changes, which walking rarely does. */
  tick(dt, camera) {
    if (!this.slots) return false;
    this._timeU.value += dt;
    const dry = this._rainU.value < 0.01 && this._wetU.value < 0.01;
    this.group.visible = !dry;
    if (dry) return false;
    if (this._wetU.value > this._rainU.value) this._wetU.value -= dt * 0.02;

    const c = camera.position;
    const near = this.apertures
      .filter((a) => this._leaks(a))
      .map((a) => ({ a, d: Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z) }))
      .filter((e) => e.d < 46)
      .sort((p, q) => p.d - q.d)
      .slice(0, this.slots)
      .map((e) => e.a);

    const same = near.length === this._assigned.length
      && near.every((a, i) => a === this._assigned[i]);
    if (same) return true;
    this._assigned = near;

    const write = (mesh, per) => {
      const slot = mesh.geometry.getAttribute("aSlot");
      const spec = mesh.geometry.getAttribute("aSpec");
      for (let s = 0; s < this.slots; s++) {
        const a = near[s];
        for (let k = 0; k < per; k++) {
          for (let c2 = 0; c2 < 4; c2++) {
            const v = (s * per + k) * 4 + c2;
            if (!a) { spec.setW(v, 0); continue; }
            slot.setXYZ(v, a.x, a.y, a.z);
            spec.setXYZW(v, a.nx, a.w, a.nz, a.h);
          }
        }
      }
      slot.needsUpdate = true; spec.needsUpdate = true;
    };
    write(this._spray, this.perSlot);
    // The wet patch lies on the floor, not at the sill: one quad per opening,
    // dropped to the floor the opening looks into.
    const slot = this._wet.geometry.getAttribute("aSlot");
    const spec = this._wet.geometry.getAttribute("aSpec");
    for (let s = 0; s < this.slots; s++) {
      const a = near[s];
      for (let c2 = 0; c2 < 4; c2++) {
        const v = s * 4 + c2;
        if (!a) { spec.setW(v, 0); continue; }
        slot.setXYZ(v, a.x, (a.floorY ?? a.y - a.h / 2) + 0.03, a.z);
        // w carries how much water this opening lets through: a doorway more
        // than a high window.
        spec.setXYZW(v, a.nx, a.w, a.nz, a.kind === "door" ? 1 : 0.7);
      }
    }
    slot.needsUpdate = true; spec.needsUpdate = true;
    return true;
  }

  dispose() {
    for (const m of [this._spray, this._wet]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
