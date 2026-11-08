/* The My-3D-Engine view's viewer: a reconstruction, drawn by the engine's one renderer (three's WebGPURenderer, set up by
 * src/core/Renderer.js; WebGL2 only where a browser has no WebGPU). It replaces atlas-core's own WebGL2 viewer and
 * keeps its contract word for word: the same API (setMesh, setAtlas, setMode, setSpin, clear, onSpinChange), the same
 * off-axis opening, and the same render, with exactly the two effects src/atlas/render-state.js DECLARES:
 *
 *   studioLightRig    1.3 key + 0.35 fill + 0.6 rim over 0.28 ambient
 *   acesToneMapping   ACES filmic (Narkowicz's fit) at exposure 1.0
 *
 * The rig's numbers are checked against that declaration at load, as the original checked them, so the sentence the
 * page shows and the numbers in the shader cannot drift apart.
 *
 * COLOUR IS LINEAR IN THE SHADER AND ENCODED ONCE. The atlas is a photograph, sRGB bytes, so its texture is declared
 * sRGB and the sampler decodes it; the rig multiplies linear light; ACES is applied here, in the node graph, and three's
 * output pass encodes to sRGB once on the way out (its own tone mapping is off, so nothing is applied twice).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, attribute, uniform, texture, uv, vec3, vec4, float, normalize, max, dot, pow, clamp, mix, step,
  positionWorld, cameraPosition, normalWorld, frontFacing, select,
} from 'three/tsl';
import { createRenderer } from '../../src/core/Renderer.js';
import { VIEWER_ONLY_EFFECTS } from '../../src/atlas/render-state.js';

const KEY = 1.3, FILL = 0.35, RIM = 0.6, AMBIENT = 0.28, EXPOSURE = 1.0;
const FOVY = 0.72;   // vertical field of view, radians: also what frames a new mesh

(function declarationAgrees() {
  const said = VIEWER_ONLY_EFFECTS.map((e) => e.what).join(' ');
  const written = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  const missing = [['key', KEY], ['fill', FILL], ['rim', RIM], ['ambient', AMBIENT], ['exposure', EXPOSURE]]
    .filter(([, v]) => !said.includes(written(v))).map(([n, v]) => `${n} ${written(v)}`);
  if (missing.length) throw new Error(`viewer.js renders with values VIEWER_ONLY_EFFECTS does not declare: ${missing.join(', ')}.`);
})();

const MODES = { textured: 0, confidence: 1, sigma: 2, wire: 3 };
// The wire colour the original wrote straight to the screen, as sRGB, here in linear light for the output pass.
const WIRE = new THREE.Color().setRGB(0.18, 0.66, 1.0, THREE.SRGBColorSpace);

/** ACES filmic, Narkowicz's fit. */
const aces = (x) => clamp(x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14)), 0.0, 1.0);
/** σ, cool where the surface is well determined and hot where it is not (the panel's legend carries the numbers). */
const ramp = (t0) => {
  const t = clamp(t0, 0.0, 1.0);
  const lo = vec3(0.06, 0.42, 0.85), mid = vec3(0.35, 0.80, 0.72), hi = vec3(0.95, 0.70, 0.22), top = vec3(0.90, 0.28, 0.20);
  const a = mix(lo, mid, t.div(0.34)), b = mix(mid, hi, t.sub(0.34).div(0.33)), c = mix(hi, top, t.sub(0.67).div(0.33));
  return mix(mix(a, b, step(0.34, t)), c, step(0.67, t));
};

export class Viewer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.mesh = null;
    this.yaw = -0.62; this.pitch = 0.16; this.dist = 3.0;   // off-axis, deliberately: see atlas-core's viewer note
    this.spin = true;
    this.paused = false;
    this.radius = 1;
    this.centre = new THREE.Vector3();
    this.uMode = uniform(0);
    this.uSigmaScale = uniform(1);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08090b);
    this.camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOVY), 1, 0.01, 100);
    this.atlas = new THREE.Texture();
    this.ready = this.#boot();
    this.#controls();
  }

  async #boot() {
    const boot = await createRenderer({
      canvas: this.canvas, tier: { antialias: true, maxPixelRatio: 2 },
      onNeedFreshCanvas: () => { const next = this.canvas.cloneNode(); this.canvas.replaceWith(next); this.canvas = next; this.#controls(); return next; },
    });
    this.renderer = (await boot.settle()).renderer;
    this.renderer.toneMapping = THREE.NoToneMapping;          // ACES is the graph's, declared, applied once
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;      // the one encode
    this.backend = this.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
    let last = performance.now();
    this.renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (this.paused || document.hidden) return;
      if (this.spin && this.mesh) this.yaw += dt * 0.35;
      this.#frame();
    });
  }

  #material() {
    const atlas = texture(this.atlas, uv());
    const col = attribute('aCol', 'vec3'), sig = attribute('aSigma', 'float');
    const uMode = this.uMode, uSigmaScale = this.uSigmaScale;
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    m.colorNode = Fn(() => {
      const N0 = normalize(normalWorld);
      const N = select(frontFacing, N0, N0.negate());
      const V = normalize(cameraPosition.sub(positionWorld));
      const albedo = vec3(0).toVar();
      If(uMode.equal(0), () => { albedo.assign(atlas.rgb.mul(col)); })
        .ElseIf(uMode.equal(1), () => { albedo.assign(col); })
        .Else(() => { albedo.assign(ramp(sig.mul(uSigmaScale))); });
      // The declared three-point rig, in world space: the object turns under it.
      const kL = normalize(vec3(-0.45, 0.75, 0.62)), fL = normalize(vec3(0.80, 0.10, 0.45)), rL = normalize(vec3(0.10, -0.25, -0.95));
      const key = max(dot(N, kL), 0.0).mul(KEY);
      const fill = max(dot(N, fL), 0.0).mul(FILL);
      const rim = pow(float(1.0).sub(max(dot(N, V), 0.0)), 2.2).mul(max(dot(N, rL), 0.0)).mul(RIM);
      const lit = albedo.mul(float(AMBIENT).add(key).add(fill)).add(vec3(0.42, 0.66, 1.0).mul(rim));
      return vec4(aces(lit.mul(EXPOSURE)), 1.0);
    })();
    return m;
  }

  #controls() {
    const c = this.canvas;
    let down = false, lx = 0, ly = 0;
    c.addEventListener('pointerdown', (e) => { down = true; lx = e.clientX; ly = e.clientY; c.setPointerCapture(e.pointerId); this.spin = false; this.onSpinChange?.(false); });
    c.addEventListener('pointerup', (e) => { down = false; c.releasePointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!down) return;
      this.yaw += (e.clientX - lx) * 0.008;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - ly) * 0.008));
      lx = e.clientX; ly = e.clientY;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(this.radius * 1.15, Math.min(this.radius * 12, this.dist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });
  }

  /** Show a mesh. Every array is optional except positions and indices; what is missing is filled with something inert. */
  setMesh(m, atlas) {
    const n = m.positions.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals || new Float32Array(n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uvs || new Float32Array(n * 2), 2));
    g.setAttribute('aCol', new THREE.BufferAttribute(m.colors || new Float32Array(n * 3).fill(0.72), 3));
    g.setAttribute('aSigma', new THREE.BufferAttribute(m.sigma || new Float32Array(n), 1));
    g.setIndex(new THREE.BufferAttribute(m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices), 1));
    // σ is in working-grid pixels; the ramp wants [0, 1], so scale by a high quantile rather than the maximum.
    let sMax = 1;
    if (m.sigma && m.sigma.length) { const s = Float32Array.from(m.sigma).sort(); sMax = s[Math.floor(0.97 * (s.length - 1))] || 1; }
    this.uSigmaScale.value = 1 / sMax;
    this.sigmaP97 = sMax;
    g.computeBoundingBox();
    const box = g.boundingBox;
    box.getCenter(this.centre);
    this.radius = Math.max(1e-3, 0.5 * box.getSize(new THREE.Vector3()).length());
    this.dist = this.radius / Math.tan(FOVY / 2) * 1.12;   // framed from the vertical field of view, with a little air

    this.clear();
    const solid = new THREE.Mesh(g, this.#material());
    const wire = new THREE.Mesh(g, new THREE.MeshBasicNodeMaterial({ color: WIRE, wireframe: true }));
    wire.visible = false;
    this.mesh = { solid, wire, geometry: g };
    this.scene.add(solid, wire);
    if (atlas) this.setAtlas(atlas);
    this.#applyMode();
  }

  setAtlas(source) {
    // A canvas with flipY matches the in-memory UV convention (bottom origin), as the original's upload did.
    this.atlas.image = source;
    this.atlas.flipY = true;
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = true;
    this.atlas.minFilter = THREE.LinearMipmapLinearFilter;
    this.atlas.wrapS = this.atlas.wrapT = THREE.ClampToEdgeWrapping;
    this.atlas.needsUpdate = true;
  }

  setMode(name) { this.uMode.value = MODES[name] ?? 0; this.#applyMode(); }
  #applyMode() {
    if (!this.mesh) return;
    const wire = this.uMode.value === MODES.wire;
    this.mesh.solid.visible = !wire;
    this.mesh.wire.visible = wire;
  }
  setSpin(on) { this.spin = on; }
  /** Stop drawing while the My-3D-Engine view is not the one on screen (the editor says so); start again when it is. */
  setPaused(on) { this.paused = on; }
  clear() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh.solid, this.mesh.wire);
    this.mesh.geometry.dispose();
    this.mesh.solid.material.dispose();
    this.mesh.wire.material.dispose();
    this.mesh = null;
  }

  #frame() {
    const c = this.canvas, r = this.renderer;
    const w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) { r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.setSize(w, h, false); }
    this.camera.aspect = w / h;
    this.camera.near = Math.max(1e-3, this.dist - this.radius * 4);
    this.camera.far = this.dist + this.radius * 4;
    this.camera.updateProjectionMatrix();
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.centre.x + this.dist * cp * Math.sin(this.yaw),
      this.centre.y + this.dist * Math.sin(this.pitch),
      this.centre.z + this.dist * cp * Math.cos(this.yaw));
    this.camera.lookAt(this.centre);
    r.render(this.scene, this.camera);
  }
}
