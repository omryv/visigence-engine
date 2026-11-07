/**
 * WORLD MODE'S VIEW: a seed's whole 4 km plate, on the engine's own renderer (core/Renderer.js createRenderer:
 * WebGPU first, WebGL2 only where the browser has no WebGPU), under the engine's own sky (render/Sky.js).
 *
 * It draws what it is handed and derives nothing: the ground, its colours and the level sites come from
 * world/worldMap.js bakeWorld, which a worker runs (world/worldWorker.js). The quick look (129², uneroded) is drawn
 * first and the canonical ground (513², eroded) replaces it when it arrives; the mesh is the bake's own lattice, one
 * vertex per sample, so the ground on screen is the ground the kernel's heightHash names.
 *
 * Heights are drawn at EXAGGERATION times their size, and the page says so: a plate 4 km wide with ±250 m of relief
 * reads flat from the air at 1:1. Only the drawing is scaled; nothing measured is.
 *
 * The camera is an orbit around the plate's centre: drag to turn, right-drag or two fingers to pan, wheel or pinch to
 * come closer. It turns slowly by itself until it is first touched. A frame is drawn only when something changed (the
 * turn, a bake, the size), so a world left standing costs nothing.
 */
import {
  Scene, PerspectiveCamera, BufferGeometry, BufferAttribute, Mesh, MeshStandardNodeMaterial, MeshBasicNodeMaterial,
  HemisphereLight, DirectionalLight, PlaneGeometry, Vector3, DoubleSide, ACESFilmicToneMapping, RenderTarget,
} from 'three/webgpu';
import { createRenderer } from '../core/Renderer.js';
import { SkyEnvironment, createAtmosphereFog, createFogUniforms } from './Sky.js';
import { LOOKS } from '../config/looks.js';

/** The drawing's vertical scale (see the header). */
export const EXAGGERATION = 1.6;
/** The sky and light of World mode: the Arcade "Sunny day" look, with a fog sized for kilometres, not streets. */
const LOOK = LOOKS.arcade.dawn;
const FOG = { density: 0.00011, falloff: 0.0016, inscatter: 0.45 };
const SITE_COLORS = [0xffb347, 0xf2f2ef, 0xbfc6cf];

/** One terrain mesh for a bake: positions on the bake's lattice, smooth normals from the heights, the bake's colours. */
export function terrainGeometry(bake, exaggeration = EXAGGERATION) {
  const { res, size, heights, colors, sea } = bake, N = res * res, step = size / (res - 1);
  const pos = new Float32Array(N * 3), nor = new Float32Array(N * 3);
  const y = k => (heights[k] - sea) * exaggeration;
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const k = j * res + i;
    pos[k * 3] = (i / (res - 1) - 0.5) * size; pos[k * 3 + 1] = y(k); pos[k * 3 + 2] = (j / (res - 1) - 0.5) * size;
    const l = y(j * res + Math.max(0, i - 1)), r = y(j * res + Math.min(res - 1, i + 1));
    const d = y(Math.max(0, j - 1) * res + i), u = y(Math.min(res - 1, j + 1) * res + i);
    const sx = (i > 0 && i < res - 1 ? 2 : 1) * step, sz = (j > 0 && j < res - 1 ? 2 : 1) * step;
    const nx = -(r - l) / sx, nz = -(u - d) / sz, inv = 1 / Math.hypot(nx, 1, nz);
    nor[k * 3] = nx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = nz * inv;
  }
  const idx = new Uint32Array((res - 1) * (res - 1) * 6);
  let o = 0;
  for (let j = 0; j < res - 1; j++) for (let i = 0; i < res - 1; i++) {
    const a = j * res + i, b = a + 1, c = a + res, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('color', new BufferAttribute(colors, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** A level site as a curtain on the ground: a band standing `rise` metres over the site's square edge. */
export function siteCurtain(bake, site, { rise = 18, exaggeration = EXAGGERATION, step = 8 } = {}) {
  const { res, size, heights, sea } = bake, half = site.span / 2;
  const ground = (x, z) => {
    const fi = Math.min(res - 1, Math.max(0, (x / size + 0.5) * (res - 1))), fj = Math.min(res - 1, Math.max(0, (z / size + 0.5) * (res - 1)));
    const i = Math.min(res - 2, Math.floor(fi)), j = Math.min(res - 2, Math.floor(fj)), u = fi - i, v = fj - j, at = (a, b) => heights[b * res + a];
    const h = at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v;
    return Math.max(h - sea, 0) * exaggeration;
  };
  const corners = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]], ring = [];
  for (let c = 0; c < 4; c++) {
    const [ax, az] = corners[c], [bx, bz] = corners[c + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / step);
    for (let s = 0; s < n; s++) ring.push([site.x + ax + (bx - ax) * s / n, site.z + az + (bz - az) * s / n]);
  }
  ring.push(ring[0]);
  const pos = new Float32Array(ring.length * 6), alpha = new Float32Array(ring.length * 2), idx = [];
  ring.forEach(([x, z], s) => {
    const h = ground(x, z) + 1.5;
    pos.set([x, h, z, x, h + rise, z], s * 6); alpha.set([1, 0], s * 2);
    if (s) { const a = (s - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('fade', new BufferAttribute(alpha, 1));
  g.setIndex(idx);
  return { geometry: g, top: new Vector3(site.x, ground(site.x, site.z) + rise * 3, site.z) };
}

export class WorldView {
  /** @param {HTMLCanvasElement} canvas  inside a sized container; the view follows the container's size */
  constructor(canvas) {
    this.canvas = canvas;
    this.bake = null; this.terrain = null; this.sites = [];
    this.orbit = { azimuth: 0.9, polar: 0.95, distance: 5200, target: new Vector3(0, 0, 0), spinning: true };
    this.onFrame = null;
    this.dirty = true;
  }

  async init() {
    const boot = await createRenderer({ canvas: this.canvas,
      tier: { antialias: true, shadows: false, shadowMapSize: 0, softShadows: false, maxPixelRatio: 2 },
      onNeedFreshCanvas: () => { const next = this.canvas.cloneNode(); this.canvas.replaceWith(next); this.canvas = next; this._bindInput(); return next; } });
    const { renderer, backend } = await boot.settle();
    this.renderer = renderer; this.backend = backend;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = LOOK.lighting.exposure;
    const scene = this.scene = new Scene();
    this.sky = new SkyEnvironment(renderer, LOOK.sky, { probeSize: 128 });
    this.sky.applyTo(scene, { environmentIntensity: LOOK.lighting.env * 0.6 });
    scene.fogNode = createAtmosphereFog(createFogUniforms(FOG, LOOK.sky, this.sky.uniforms));
    scene.add(new HemisphereLight(LOOK.lighting.hemiSky, LOOK.lighting.hemiGround, LOOK.lighting.hemi * 0.8));
    const sun = new DirectionalLight(LOOK.lighting.sunColor, LOOK.lighting.sun);
    sun.position.copy(this.sky.sunDir).multiplyScalar(4000); scene.add(sun);
    this.camera = new PerspectiveCamera(45, 1, 5, 120000);
    this.groundMaterial = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    // The open sea: one plane to the horizon at the sea level, over the plate's own drowned margin.
    const sea = new Mesh(new PlaneGeometry(240000, 240000), new MeshStandardNodeMaterial({ color: 0x0b3a52, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.84 }));
    sea.rotation.x = -Math.PI / 2; sea.renderOrder = 2; scene.add(sea);
    this._bindInput();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.resize();
    renderer.setAnimationLoop(now => this._frame(now));
    return { backend };
  }

  /** Draw a bake (the quick look or the canonical ground); the previous one is disposed. */
  show(bake) {
    this.bake = bake; this.dirty = true;
    if (this.terrain) { this.scene.remove(this.terrain); this.terrain.geometry.dispose(); }
    this.terrain = new Mesh(terrainGeometry(bake), this.groundMaterial);
    this.scene.add(this.terrain);
    for (const s of this.sites) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    this.sites = bake.sites.map((site, n) => {
      const { geometry, top } = siteCurtain(bake, site);
      const material = new MeshBasicNodeMaterial({ color: SITE_COLORS[n] ?? SITE_COLORS.at(-1), transparent: true, opacity: n ? 0.45 : 0.8, side: DoubleSide, depthWrite: false, fog: false });
      const mesh = new Mesh(geometry, material); mesh.renderOrder = 3; this.scene.add(mesh);
      return { site, mesh, top };
    });
  }

  /** Where a site's label goes on screen, in CSS pixels, or null when it is behind the camera. */
  project(n) {
    const s = this.sites[n]; if (!s || !this.camera) return null;
    const p = s.top.clone().project(this.camera);
    if (p.z > 1) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }

  resize() {
    const host = this.canvas.parentElement; if (!host || !this.renderer) return;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  _frame(now) {
    const o = this.orbit, dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 0; this._last = now;
    if (o.spinning) { o.azimuth += dt * 0.05; this.dirty = true; }
    if (!this.dirty) return;
    this.dirty = false;
    this._place();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }

  _place() {
    const o = this.orbit, sp = Math.sin(o.polar);
    this.camera.position.set(o.target.x + o.distance * sp * Math.sin(o.azimuth), o.target.y + o.distance * Math.cos(o.polar), o.target.z + o.distance * sp * Math.cos(o.azimuth));
    this.camera.lookAt(o.target);
  }

  /**
   * The frame as the GPU drew it, read back: what a test can hold the view to where a screenshot cannot see the
   * canvas (a headless WebGPU adapter does not composite). Renders the current view into a target of its own.
   * @returns {Promise<{colours: number, mean: number, width: number, height: number}>}
   */
  async capture(width = 320, height = 200) {
    const target = new RenderTarget(width, height), camera = this.camera.clone();
    this._place(); camera.copy(this.camera); camera.aspect = width / height; camera.updateProjectionMatrix();
    this.renderer.setRenderTarget(target); this.renderer.render(this.scene, camera); this.renderer.setRenderTarget(null);
    const px = await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    target.dispose();
    const seen = new Set();
    let lum = 0;
    for (let i = 0; i < width * height; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      seen.add((r >> 3) << 10 | (g >> 3) << 5 | b >> 3); lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    this.dirty = true;
    return { colours: seen.size, mean: lum / (width * height), width, height };
  }

  _bindInput() {
    const c = this.canvas, o = this.orbit, pointers = new Map();
    let pinch = 0;
    c.style.touchAction = 'none';
    c.oncontextmenu = e => e.preventDefault();
    c.onpointerdown = e => { o.spinning = false; this.dirty = true; c.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey }); };
    c.onpointerup = c.onpointercancel = e => { pointers.delete(e.pointerId); pinch = 0; };
    c.onpointermove = e => {
      const p = pointers.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; this.dirty = true;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.zoom(pinch / d);
        pinch = d; this.pan(dx / 2, dy / 2);
      } else if (p.button === 2 || p.shift) this.pan(dx, dy);
      else { o.azimuth -= dx * 0.005; o.polar = Math.min(1.45, Math.max(0.12, o.polar - dy * 0.004)); }
    };
    c.onwheel = e => { e.preventDefault(); o.spinning = false; this.zoom(Math.exp(e.deltaY * 0.0012)); };
  }

  zoom(k) { this.orbit.distance = Math.min(14000, Math.max(250, this.orbit.distance * k)); this.dirty = true; }

  pan(dx, dy) {
    const o = this.orbit, s = o.distance * 0.0011, ca = Math.cos(o.azimuth), sa = Math.sin(o.azimuth), half = (this.bake?.size ?? 4096) / 2;
    o.target.x = Math.min(half, Math.max(-half, o.target.x - (dx * ca - dy * sa) * s));
    o.target.z = Math.min(half, Math.max(-half, o.target.z - (-dx * sa - dy * ca) * s));
    this.dirty = true;
  }

  /** Turn to face a site and come close enough to read it. */
  focus(n) {
    const s = this.sites[n]; if (!s) return;
    Object.assign(this.orbit, { spinning: false, distance: Math.max(900, s.site.span * 2.2) });
    this.orbit.target.set(s.site.x, s.top.y / 3, s.site.z);
    this.dirty = true;
  }

  /** Stop the turn (a touch does the same). */
  still() { this.orbit.spinning = false; this.dirty = true; }

  dispose() {
    this.renderer?.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    for (const s of this.sites) { s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    this.terrain?.geometry.dispose(); this.groundMaterial?.dispose();
    this.sky?.dispose(); this.renderer?.dispose();
    this.renderer = null;
  }
}
