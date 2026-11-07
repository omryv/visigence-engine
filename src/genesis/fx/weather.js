// Weather: rain, snow and night fireflies — camera-local particle volumes
// that follow the viewer, wrap seamlessly, and are animated ENTIRELY on the
// GPU from uTime + a per-particle seed. The CPU cost per frame is two
// uniform writes; there are no attribute uploads, ever.
//
// Rain and snow are merged quad strips (one draw call each): rain stretches
// along its fall to read as streaks, snow tumbles and sways. Fireflies are
// points that drift near the ground and breathe light; the engine shows
// them only on clear nights. The wet/snow-cover MATERIAL response lives in
// render/atmosphere.js — this module is only the falling part; the engine
// eases the surface uniforms toward this module's targets so a storm soaks
// in over seconds instead of snapping.

import * as THREE from "three";
import { channelRng } from "../../kernel/seed.js";
import {
  Fn, If, Discard, uniform, texture, attribute, instancedBufferAttribute, uv, varying, vec2, vec3, vec4, float,
  fract, sin, cos, mod, abs, max, pow, length, normalize, smoothstep, step, cameraPosition, positionView,
} from "three/tsl";

// The volume that follows the camera. Tall enough that streaks never pop
// into existence inside the frame at walking eye height.
const BOX_R = 42;
const BOX_H = 34;

/* The precipitation volume, as nodes: term for term the GLSL vertex program
   (each column loops through the volume on its own phase and pace, sways,
   takes the lattice copy nearest the viewer, faces the camera in XZ, and is
   not drawn under a roof), and the two drop shapes. */
function precipNodes(u, rain) {
  const seed = attribute("aSeed", "vec3"), corner = attribute("aCorner", "vec2");
  const boxR = float(BOX_R), boxH = float(BOX_H);
  const y01 = fract(seed.y.sub(u.uTime.mul(u.uFall.div(boxH)).mul(float(0.8).add(fract(seed.x.mul(7.31)).mul(0.4)))));
  const swayT = u.uTime.mul(float(0.6).add(fract(seed.z.mul(3.7)))).add(seed.y.mul(40));
  const sway = vec2(sin(swayT), cos(swayT.mul(0.83))).mul(u.uSway);
  const seedXZ = vec2(seed.x, seed.z).mul(boxR.mul(2)).add(sway);
  const rel = mod(seedXZ.sub(u.uCenter.xz), boxR.mul(2)).sub(boxR);
  const base = vec3(u.uCenter.x.add(rel.x), u.uCenter.y.add(y01.sub(0.4).mul(boxH)), u.uCenter.z.add(rel.y));
  const toCam = cameraPosition.sub(base);
  const right = normalize(vec3(toCam.z.negate(), 0, toCam.x).add(vec3(1e-5)));
  const world = base.add(right.mul(corner.x.mul(u.uSize))).add(vec3(0, corner.y.mul(u.uLen), 0));
  // The roof stops a drop whatever is under it (no floor test).
  const suv = world.xz.sub(u.uShelterOrigin).mul(u.uShelterScale);
  const t = u.uShelter.sample(suv);
  const roofY = u.uShelterBase.add(t.r.add(t.g.div(255)).mul(u.uShelterRange));
  const inside = step(0, suv.x).mul(step(0, suv.y)).mul(step(suv.x, 1)).mul(step(suv.y, 1));
  const sheltered = u.uShelterOn.mul(inside).mul(step(0.5, t.a)).mul(step(world.y, roofY));
  // Fade near the volume's vertical ends so recycling is invisible.
  const alpha = varying(smoothstep(0, 0.08, y01).mul(smoothstep(1, 0.92, y01)).mul(float(1).sub(sheltered)));
  const vUv = varying(corner.add(0.5));
  const fragment = Fn(() => {
    if (rain) {
      If(alpha.lessThan(0.004), () => { Discard(); });   // sheltered, or recycling
      const core = float(1).sub(abs(vUv.x.sub(0.5)).mul(2));
      const tips = smoothstep(0, 0.15, vUv.y).mul(smoothstep(1, 0.85, vUv.y));
      return vec4(vec3(0.75, 0.82, 0.9), core.mul(tips).mul(alpha).mul(0.32));
    }
    const d = length(vUv.sub(0.5));
    const a = smoothstep(0.5, 0.18, d).mul(alpha);
    If(a.lessThan(0.01), () => { Discard(); });
    return vec4(vec3(0.95, 0.97, 1.0), a.mul(0.85));
  })();
  return { positionNode: world, fragment };
}

/* Fireflies: a slow Lissajous wander around each seeded anchor, breathing on
   its own clock, gated by night. Sized sprites (WebGPU draws points one pixel
   wide), one instance per firefly. */
function fireflyNodes(material, anchors, seeds, u) {
  const P = instancedBufferAttribute(anchors), s = instancedBufferAttribute(seeds);
  const fhash = (n) => fract(sin(n).mul(43758.5453));
  const t = u.uTime.mul(float(0.24).add(fhash(s).mul(0.2))).add(s.mul(13));
  material.positionNode = P.add(vec3(
    sin(t).mul(2.6).add(sin(t.mul(2.7)).mul(0.8)),
    sin(t.mul(1.31).add(s)).mul(0.9),
    cos(t.mul(0.87)).mul(2.6).add(cos(t.mul(2.3)).mul(0.7))));
  const glow = varying(u.uNight.mul(float(0.25).add(pow(sin(u.uTime.mul(float(1.4).add(fhash(s.add(1)))).add(s.mul(51))).mul(0.5).add(0.5), 3).mul(0.75))));
  material.sizeNode = float(130).div(max(positionView.z.negate(), 1));
  material.fragmentNode = Fn(() => {
    const d = length(uv().sub(0.5));
    If(d.greaterThan(0.5).or(glow.lessThan(0.02)), () => { Discard(); });
    const a = smoothstep(0.5, 0.05, d).mul(glow);
    return vec4(vec3(1.9, 2.4, 0.7).mul(a), a);
  })();
}

function precipGeometry(count) {
  // Each quad's phase in the fall: a fixed stream, so the rain is the same rain every time (no Math.random).
  const rng = channelRng("fx", "weather:precip");
  const pos = new Float32Array(count * 4 * 3); // unused, three wants it
  const seed = new Float32Array(count * 4 * 3);
  const corner = new Float32Array(count * 4 * 2);
  const idx = [];
  for (let i = 0; i < count; i++) {
    const sx = rng(), sy = rng(), sz = rng();
    const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      seed[v * 3] = sx; seed[v * 3 + 1] = sy; seed[v * 3 + 2] = sz;
      corner[v * 2] = corners[c][0]; corner[v * 2 + 1] = corners[c][1];
    }
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
  geo.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
  geo.setIndex(idx);
  return geo;
}

/* What the shelter node samples before a world exists (uShelterOn keeps it unread). */
const NO_SHELTER = (() => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; return t; })();

export class WeatherFX {
  constructor({ quality, layer = null }) {
    this.group = new THREE.Group();
    this.group.name = "fx:weather";
    this.quality = quality;
    this.layer = layer; // meshes built later (setMode) must land on it too
    this.mode = "clear";
    this._timeU = uniform(0);
    this._centerU = uniform(new THREE.Vector3());
    this._nightU = uniform(0);
    this._precip = null;
    /* The shelter window, shared by reference with the atmosphere patch so
       the drops and the surfaces they wet can never disagree about where the
       roofs are. Handed over by the engine once a world exists. */
    this._shelterU = {
      uShelter: texture(NO_SHELTER),
      uShelterOn: uniform(0),
      uShelterOrigin: uniform(new THREE.Vector2()),
      uShelterScale: uniform(1 / 160),
      uShelterBase: uniform(0),
      uShelterRange: uniform(64),
    };

    // Fireflies exist from the start (they cost one draw call and vanish by
    // day via uNight); precip meshes are built per mode.
    this._fireflies = null;
    if (quality.fireflies > 0) {
      const n = quality.fireflies;
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n);
      this._flyPos = pos;
      for (let i = 0; i < n; i++) seed[i] = i * 1.618 + 0.5;
      this._flyAttr = new THREE.InstancedBufferAttribute(pos, 3);
      const mat = new THREE.PointsNodeMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false,
      });
      fireflyNodes(mat, this._flyAttr, new THREE.InstancedBufferAttribute(seed, 1), { uTime: this._timeU, uNight: this._nightU });
      this._fireflies = new THREE.Sprite(mat);
      this._fireflies.count = n;
      this._fireflies.frustumCulled = false;
      this._fireflies.visible = false;
      this.group.add(this._fireflies);
      this._flyAnchor = null; // reseeded near the camera as it travels
    }
  }

  // Anchor fireflies to the ground around the viewer. Called by the engine
  // when the camera has moved far enough that the swarm fell behind.
  reseedFireflies(camera, sampler) {
    if (!this._fireflies) return;
    const pos = this._flyPos;
    const cx = camera.position.x, cz = camera.position.z;
    // The swarm a place has: drawn from where the viewer stands (to the metre), so the same spot shows the same swarm.
    const rng = channelRng("fx", `fireflies:${Math.round(cx)},${Math.round(cz)}`);
    for (let i = 0; i < pos.length / 3; i++) {
      const a = rng() * Math.PI * 2;
      const r = 8 + Math.sqrt(rng()) * 52;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      pos[i * 3] = x;
      pos[i * 3 + 1] = sampler(x, z) + 0.5 + rng() * 2.2;
      pos[i * 3 + 2] = z;
    }
    this._flyAttr.needsUpdate = true;
    this._flyAnchor = { x: cx, z: cz };
  }

  needsReseed(camera) {
    if (!this._fireflies) return false;
    if (!this._flyAnchor) return true;
    return Math.hypot(camera.position.x - this._flyAnchor.x, camera.position.z - this._flyAnchor.z) > 38;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this._precip) {
      this.group.remove(this._precip);
      this._precip.geometry.dispose();
      this._precip.material.dispose();
      this._precip = null;
    }
    if (mode === "rain" || mode === "snow") {
      const rain = mode === "rain";
      const count = rain ? this.quality.rainCount : this.quality.snowCount;
      const u = {
        uTime: this._timeU, uCenter: this._centerU,
        uFall: uniform(rain ? 34 : 2.6), uSway: uniform(rain ? 0.25 : 2.2),
        uSize: uniform(rain ? 0.018 : 0.062), uLen: uniform(rain ? 0.62 : 0.062),
        ...this._shelterU,
      };
      const nodes = precipNodes(u, rain);
      const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
      material.positionNode = nodes.positionNode;
      material.fragmentNode = nodes.fragment;
      this._precip = new THREE.Mesh(precipGeometry(count), material);
      this._precip.frustumCulled = false;
      if (this.layer !== null) this._precip.layers.set(this.layer);
      this.group.add(this._precip);
    }
  }

  /* Point the precipitation at the same shelter window the materials read.
     Called once per world build; the uniform objects are shared by reference
     so later redraws need no second call. */
  setShelter(texture, field) {
    const u = this._shelterU;
    u.uShelter.value = texture || NO_SHELTER;
    u.uShelterOn.value = texture && field ? 1 : 0;
    if (!field) return;
    const f = field.uniforms();
    u.uShelterOrigin.value.set(f.origin[0], f.origin[1]);
    u.uShelterScale.value = f.scale;
    u.uShelterBase.value = f.baseY;
    u.uShelterRange.value = f.range;
  }

  // Surface-condition targets the engine eases the shared uniforms toward.
  get wetTarget() { return this.mode === "rain" ? 1 : 0; }
  get snowTarget() { return this.mode === "snow" ? 1 : 0; }

  // Returns true while anything here is animating (precip, or visible
  // fireflies breathing).
  tick(dt, camera, night, underwater) {
    this._timeU.value += dt;
    this._centerU.value.copy(camera.position);
    this._nightU.value = night;
    let active = !!this._precip;
    if (this._fireflies) {
      const show = night > 0.35 && this.mode === "clear" && !underwater;
      this._fireflies.visible = show;
      active = active || show;
    }
    return active;
  }

  dispose() {
    if (this._precip) { this._precip.geometry.dispose(); this._precip.material.dispose(); }
    if (this._fireflies) { this._fireflies.geometry.dispose(); this._fireflies.material.dispose(); }
  }
}
