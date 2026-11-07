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
import { channelRng } from "../../kernel/seed.js";
import { Fn, If, Discard, uniform, attribute, uv, varying, vec2, vec3, vec4, float, fract, normalize, smoothstep, cameraPosition } from "three/tsl";

const MAX_POOL = 6;
// How far in from the opening the spray reaches, and the wet with it. Rain
// does not blow four metres into a room through a cottage window.
const REACH = 1.55;

/* The spray through an opening and the wet floor inside it, as nodes: term
   for term the GLSL programs. Spray: each drop falls on its own phase and
   drifts inward as it falls (what comes through an opening came through it
   sideways), faces the camera in XZ, fades in at the opening and out where it
   lands. Wet: a flat quad that darkens what it lies on, heaviest at the sill
   and ragged at its far edge. */
function sprayNodes(u) {
  const slot = attribute("aSlot", "vec3"), spec = attribute("aSpec", "vec4");
  const seed = attribute("aSeed", "vec2"), corner = attribute("aCorner", "vec2");
  const inward = vec2(spec.x, spec.z), along = vec2(inward.y.negate(), inward.x);
  const t = fract(seed.x.add(u.uTime.mul(float(1.1).add(fract(seed.y.mul(5.7)).mul(0.5)))));
  const base = slot
    .add(vec3(along.x, 0, along.y).mul(fract(seed.y.mul(13.1)).sub(0.5).mul(spec.y)))
    .add(vec3(inward.x, 0, inward.y).mul(t.mul(REACH)))
    .add(vec3(0, spec.w.mul(float(1).sub(t)).sub(spec.w.mul(0.5)), 0));
  const toCam = cameraPosition.sub(base);
  const right = normalize(vec3(toCam.z.negate(), 0, toCam.x).add(vec3(1e-5)));
  const p = base.add(right.mul(corner.x.mul(0.012))).add(vec3(0, corner.y.mul(0.34), 0));
  const alpha = varying(u.uRain.mul(smoothstep(0, 0.12, t)).mul(smoothstep(1, 0.72, t)));
  const fragment = Fn(() => {
    If(alpha.lessThan(0.01), () => { Discard(); });
    return vec4(vec3(0.78, 0.85, 0.94), alpha.mul(0.3));
  })();
  return { positionNode: p, fragment };
}
function wetNodes(u) {
  const slot = attribute("aSlot", "vec3"), spec = attribute("aSpec", "vec4"), st = uv();
  const inward = vec2(spec.x, spec.z), along = vec2(inward.y.negate(), inward.x);
  const p = slot
    .add(vec3(along.x, 0, along.y).mul(st.x.sub(0.5).mul(spec.y.add(0.5))))
    .add(vec3(inward.x, 0, inward.y).mul(st.y.mul(REACH)));
  const wet = varying(u.uWet.mul(spec.w));
  const fragment = Fn(() => {
    const e = smoothstep(1, 0.35, st.y).mul(smoothstep(0, 0.12, st.y));
    const sd = smoothstep(0, 0.16, st.x).mul(smoothstep(1, 0.84, st.x));
    const a = e.mul(sd).mul(wet);
    If(a.lessThan(0.01), () => { Discard(); });
    return vec4(0, 0, 0, a.mul(0.55));
  })();
  return { positionNode: p, fragment };
}

function sprayGeometry(slots, perSlot) {
  const n = slots * perSlot;
  const pos = new Float32Array(n * 4 * 3);
  const slot = new Float32Array(n * 4 * 3);
  const spec = new Float32Array(n * 4 * 4);
  const seed = new Float32Array(n * 4 * 2);
  const corner = new Float32Array(n * 4 * 2);
  const idx = [];
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const rng = channelRng("fx", "ingress:spray");   // a fixed stream: the same spray every time
  for (let i = 0; i < n; i++) {
    const sa = rng(), sb = rng();
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
    this._rainU = uniform(0);
    this._wetU = uniform(0);
    this._timeU = uniform(0);
    this._assigned = [];
    if (!this.slots) return;

    const spray = sprayNodes({ uTime: this._timeU, uRain: this._rainU });
    const sprayMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    sprayMat.positionNode = spray.positionNode; sprayMat.fragmentNode = spray.fragment;
    this._spray = new THREE.Mesh(sprayGeometry(this.slots, this.perSlot), sprayMat);
    this._spray.frustumCulled = false;
    this.group.add(this._spray);

    const wet = wetNodes({ uWet: this._wetU });
    this._wet = new THREE.Mesh(wetGeometry(this.slots), new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, fog: false,
      // Multiply-ish: darken the boards, never lighten them.
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this._wet.material.positionNode = wet.positionNode;
    this._wet.material.fragmentNode = wet.fragment;
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
