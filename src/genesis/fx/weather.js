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

// The volume that follows the camera. Tall enough that streaks never pop
// into existence inside the frame at walking eye height.
const BOX_R = 42;
const BOX_H = 34;

const PRECIP_VERT = /* glsl */`
  attribute vec3 aSeed;    // x, z in [0,1) column position, y = phase
  attribute vec2 aCorner;  // quad corner in [-0.5, 0.5]
  varying vec2 vUv;
  varying float vAlpha;
  uniform float uTime;
  uniform vec3 uCenter;
  uniform float uFall;     // metres per second, downward
  uniform float uSway;     // horizontal drift amplitude
  uniform float uSize;     // particle width
  uniform float uLen;      // particle height (streak length)
  /* Shelter: the same window on the world the materials read (js/shelter.js).
     A drop under a roof is not drawn. This is the visible half of a building
     being part of the weather — before it, rain fell through every roof in
     the world and stood in the middle of the room with you. */
  uniform sampler2D uShelter;
  uniform float uShelterOn;
  uniform vec2 uShelterOrigin;
  uniform float uShelterScale;
  uniform float uShelterBase;
  uniform float uShelterRange;
  float sheltered(vec3 p) {
    if (uShelterOn < 0.5) return 0.0;
    vec2 uv = (p.xz - uShelterOrigin) * uShelterScale;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
    vec4 t = texture2D(uShelter, uv);
    if (t.a < 0.5) return 0.0;
    float roofY = uShelterBase + (t.r + t.g / 255.0) * uShelterRange;
    // No floor test: a drop is stopped by the roof whatever is under it, and
    // one that has already fallen past the ceiling was never drawn.
    return p.y <= roofY ? 1.0 : 0.0;
  }
  void main() {
    vUv = aCorner + 0.5;
    float boxR = ${BOX_R.toFixed(1)};
    float boxH = ${BOX_H.toFixed(1)};
    // Fall: each column loops through the volume on its own phase and pace.
    float y01 = fract(aSeed.y - uTime * (uFall / boxH) * (0.8 + 0.4 * fract(aSeed.x * 7.31)));
    // Sway: snow meanders, rain barely moves off vertical.
    float swayT = uTime * (0.6 + fract(aSeed.z * 3.7)) + aSeed.y * 40.0;
    vec2 sway = vec2(sin(swayT), cos(swayT * 0.83)) * uSway;
    // Particles are WORLD-anchored on a repeating lattice; each takes the
    // lattice copy nearest the viewer, so walking never outruns the weather
    // and nothing slides along with the camera.
    vec2 seedXZ = vec2(aSeed.x, aSeed.z) * boxR * 2.0 + sway;
    vec2 rel = mod(seedXZ - uCenter.xz, boxR * 2.0) - boxR;
    vec3 world = vec3(uCenter.x + rel.x, uCenter.y + (y01 - 0.4) * boxH, uCenter.z + rel.y);
    // Face the camera in the XZ plane; keep the streak vertical.
    vec3 toCam = cameraPosition - world;
    vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x) + vec3(1e-5));
    world += right * (aCorner.x * uSize);
    world.y += aCorner.y * uLen;
    // Fade near the volume's vertical ends so recycling is invisible.
    vAlpha = smoothstep(0.0, 0.08, y01) * smoothstep(1.0, 0.92, y01)
           * (1.0 - sheltered(world));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const RAIN_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.004) discard;   // sheltered, or recycling
    float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
    float tips = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
    gl_FragColor = vec4(vec3(0.75, 0.82, 0.9), core * tips * vAlpha * 0.32);
  }
`;

const SNOW_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float d = length(vUv - 0.5);
    float a = smoothstep(0.5, 0.18, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), a * 0.85);
  }
`;

const FIREFLY_VERT = /* glsl */`
  attribute float aSeed;
  varying float vGlow;
  uniform float uTime;
  uniform float uNight;
  float fhash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    // Slow Lissajous wander around the seeded anchor (the position attr).
    float t = uTime * (0.24 + fhash(aSeed) * 0.2) + aSeed * 13.0;
    vec3 p = position + vec3(
      sin(t) * 2.6 + sin(t * 2.7) * 0.8,
      sin(t * 1.31 + aSeed) * 0.9,
      cos(t * 0.87) * 2.6 + cos(t * 2.3) * 0.7);
    // Breathe: each firefly pulses on its own clock, gated by night.
    vGlow = uNight * (0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (1.4 + fhash(aSeed + 1.0)) + aSeed * 51.0), 3.0));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_PointSize = 130.0 / max(-mv.z, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FIREFLY_FRAG = /* glsl */`
  precision highp float;
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5 || vGlow < 0.02) discard;
    float a = smoothstep(0.5, 0.05, d) * vGlow;
    gl_FragColor = vec4(vec3(1.9, 2.4, 0.7) * a, a);
  }
`;

function precipGeometry(count) {
  const pos = new Float32Array(count * 4 * 3); // unused, three wants it
  const seed = new Float32Array(count * 4 * 3);
  const corner = new Float32Array(count * 4 * 2);
  const idx = [];
  for (let i = 0; i < count; i++) {
    const sx = Math.random(), sy = Math.random(), sz = Math.random();
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

export class WeatherFX {
  constructor({ quality, layer = null }) {
    this.group = new THREE.Group();
    this.group.name = "fx:weather";
    this.quality = quality;
    this.layer = layer; // meshes built later (setMode) must land on it too
    this.mode = "clear";
    this._timeU = { value: 0 };
    this._centerU = { value: new THREE.Vector3() };
    this._nightU = { value: 0 };
    this._precip = null;
    /* The shelter window, shared by reference with the atmosphere patch so
       the drops and the surfaces they wet can never disagree about where the
       roofs are. Handed over by the engine once a world exists. */
    this._shelterU = {
      uShelter: { value: null },
      uShelterOn: { value: 0 },
      uShelterOrigin: { value: new THREE.Vector2() },
      uShelterScale: { value: 1 / 160 },
      uShelterBase: { value: 0 },
      uShelterRange: { value: 64 },
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
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
      this._fireflies = new THREE.Points(geo, new THREE.ShaderMaterial({
        vertexShader: FIREFLY_VERT, fragmentShader: FIREFLY_FRAG,
        uniforms: { uTime: this._timeU, uNight: this._nightU },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
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
    for (let i = 0; i < pos.length / 3; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 8 + Math.sqrt(Math.random()) * 52;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      pos[i * 3] = x;
      pos[i * 3 + 1] = sampler(x, z) + 0.5 + Math.random() * 2.2;
      pos[i * 3 + 2] = z;
    }
    this._fireflies.geometry.attributes.position.needsUpdate = true;
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
      this._precip = new THREE.Mesh(precipGeometry(count), new THREE.ShaderMaterial({
        vertexShader: PRECIP_VERT,
        fragmentShader: rain ? RAIN_FRAG : SNOW_FRAG,
        uniforms: {
          uTime: this._timeU,
          uCenter: this._centerU,
          uFall: { value: rain ? 34 : 2.6 },
          uSway: { value: rain ? 0.25 : 2.2 },
          uSize: { value: rain ? 0.018 : 0.062 },
          uLen: { value: rain ? 0.62 : 0.062 },
          ...this._shelterU,
        },
        transparent: true, depthWrite: false,
      }));
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
    u.uShelter.value = texture;
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
