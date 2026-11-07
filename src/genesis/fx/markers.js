/* markers.js — the answer to "did it place, and where did it go".
 *
 * A world is 2 km across and an oak is 6 m tall. At the framing the editor
 * opens on, a placed tree is four pixels. Everything in this file exists
 * because of that ratio: the object itself cannot be the confirmation, so
 * something the size of the WORLD has to say where the object is.
 *
 * Three marks, and they are deliberately different in kind:
 *
 *   THE RIPPLE   a ground ring expanding out of the footprint. Sized from
 *                the object, so it says how big the thing is — the one mark
 *                here that carries scale information.
 *   THE PILLAR   a glow shaft standing on the spot. Sized from the CAMERA
 *                (see _shaft), so it holds a constant angular width no
 *                matter how far out you are: a metre-wide beam is invisible
 *                from two kilometres, and a two-kilometre-wide beam is a
 *                wall when you are standing next to it. The rule is that
 *                the mark is always roughly the same size ON SCREEN, which
 *                is the only definition of "visible from any zoom level"
 *                that survives an orbit camera.
 *   THE ARRIVAL  the object's own scale, eased in from nothing. A block
 *                that pops into existence reads as a glitch; a block that
 *                grows out of the ground reads as an event, and the eye
 *                tracks motion it could never track in a static four-pixel
 *                change.
 *
 * Selection uses the same two marks at lower intensity and no time limit,
 * so "what is selected" and "what just landed" are the same visual language
 * — one is loud and brief, the other quiet and persistent.
 *
 * Everything is pooled and CPU-animated. A confirmation lives under three
 * seconds and there are at most a handful alive; the per-frame arithmetic on
 * eight rings is not measurable next to one terrain tile.
 */

import * as THREE from "three";

const RIPPLES = 8;       // concurrent ground rings
const SHAFTS = 6;        // concurrent placement pillars
const SEL_MAX = 24;      // selection marks drawn before the set is summarised
const RIPPLE_LIFE = 1.25;
const SHAFT_LIFE = 2.4;

// Mint, the same signal the wire box and the spawn rings already use, so the
// editor speaks with one colour about "this one".
const CONFIRM = 0x8fe8c9;
const SELECT = 0x7fd4ff;

const SHAFT_VERT = /* glsl */`
  varying vec3 vN;
  varying vec3 vV;
  varying float vH;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    vH = uv.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/* The shaft is drawn as a tube seen from outside, so the silhouette is where
   the normal turns away from the eye. Brightening the FACING side rather
   than the silhouette is what makes it read as a column of light instead of
   a wireframe cylinder. */
const SHAFT_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vV;
  varying float vH;
  void main() {
    float f = abs(dot(normalize(vN), normalize(vV)));
    float body = mix(0.16, 1.0, f);
    float top = pow(1.0 - vH, 1.7);          // dissolves into the air
    float foot = smoothstep(0.0, 0.05, vH);  // and softens where it meets the ground
    float a = uOpacity * body * top * foot;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor * (0.65 + 0.75 * f), a);
  }
`;

const easeOut = (k) => 1 - Math.pow(1 - k, 3);
// Gentler than the textbook easeOutBack (c1 = 1.70158): a placed block should
// settle, not bounce like a notification.
const easeOutBack = (k) => { const c = 1.1, d = c + 1; return 1 + d * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };

export class Markers {
  constructor({ layer = null, motion = true } = {}) {
    this.group = new THREE.Group();
    this.group.name = "fx:markers";
    this.motion = motion !== false;
    this._layer = layer;

    // One geometry each, shared by every mark of that kind. The materials
    // cannot be shared — each mark animates its own opacity.
    this._ringGeo = new THREE.RingGeometry(0.76, 1.0, 64).rotateX(-Math.PI / 2);
    this._discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this._tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 22, 1, true).translate(0, 0.5, 0);

    this._ripples = [];
    this._shafts = [];
    for (let i = 0; i < RIPPLES; i++) this._ripples.push(this._makeRipple());
    for (let i = 0; i < SHAFTS; i++) this._shafts.push(this._makeShaft(CONFIRM));

    this._sel = [];        // live selection marks
    this._selFree = [];    // parked ones, reused as the selection changes
    this._arrivals = [];   // objects easing up to their real size
    this._pulse = 0;
  }

  /* ── pooled parts ── */
  _mount(o) {
    o.visible = false;
    o.renderOrder = 4;
    if (this._layer != null) o.layers.set(this._layer); // editor chrome never reflects in the sea
    this.group.add(o);
    return o;
  }
  _makeRipple() {
    /* depthTest OFF, like the site ring this borrows its idiom from. A ring
       lying on a hillside is cut in half by the hillside, and a mark that
       reads as a broken arc on sloping ground is worse than no mark: the one
       thing it must never be ambiguous about is that something arrived. */
    const mat = new THREE.MeshBasicMaterial({
      color: CONFIRM, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    return { mesh: this._mount(new THREE.Mesh(this._ringGeo, mat)), t: 0, life: 0, r0: 1, r1: 4 };
  }
  _makeShaft(color) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 } },
      vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    return {
      mesh: this._mount(new THREE.Mesh(this._tubeGeo, mat)),
      t: 0, life: 0, peak: 0.85, x: 0, y: 0, z: 0,
      width: 1, minR: 0.22, minH: 9,
    };
  }
  _makeDisc() {
    const mat = new THREE.MeshBasicMaterial({
      color: CONFIRM, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    return { mesh: this._mount(new THREE.Mesh(this._discGeo, mat)), t: 0, life: 0, r0: 1, r1: 2 };
  }

  setMotion(on) { this.motion = !!on; }

  /* ── the placement confirmation ──
     Two rings out of the footprint, a flash on the ground under it, and the
     pillar. `radius` is the object's own footprint: the marks are sized from
     the thing that landed, so a fence post and a watchtower do not get the
     same announcement. */
  confirm({ x, y, z, radius = 2, color = CONFIRM } = {}) {
    const r = Math.max(1.4, radius);
    /* Reduced motion is a request not to be MOVED, not a request not to be
       told. The ring still appears and still fades — it simply arrives at
       full size instead of travelling there, and the object does not scale
       in. What is removed is the motion; what is confirmed is unchanged. */
    if (!this.motion) this._ripple(x, y, z, r * 3.2, r * 3.2, 0, color);
    else {
      this._ripple(x, y, z, r * 1.05, r * 4.6, 0, color);
      this._ripple(x, y, z, r * 0.8, r * 3.0, 0.16, color);
    }
    this._flash(x, y, z, r, color);
    /* The beacon's floor is taken from the OBJECT, not from a constant: a
       fence post gets a slim shaft and a watchtower gets a broad one, so
       close up the mark still reads as belonging to the thing it marks
       rather than as the same pin on everything. */
    this._pillar({ x, y, z, life: SHAFT_LIFE, peak: 0.9, color, width: 1, minR: Math.max(0.26, r * 0.13), minH: Math.max(9, r * 4.5) });
  }

  _ripple(x, y, z, r0, r1, delay, color) {
    const s = this._ripples.find((p) => p.life <= 0) || this._ripples[0];
    s.t = -delay; s.life = RIPPLE_LIFE; s.r0 = r0; s.r1 = r1;
    s.mesh.material.color.set(color);
    s.mesh.position.set(x, y + 0.14, z);
    s.mesh.scale.setScalar(r0);
    s.mesh.material.opacity = 0;
    s.mesh.visible = true;
  }
  _flash(x, y, z, r, color) {
    this._disc ||= this._makeDisc();
    const d = this._disc;
    d.t = 0; d.life = 0.5; d.r0 = r * 0.5; d.r1 = r * 1.7;
    d.mesh.material.color.set(color);
    d.mesh.position.set(x, y + 0.1, z);
    d.mesh.visible = true;
  }
  _pillar({ x, y, z, life, peak, color, width, minR = 0.22, minH = 9 }) {
    const s = this._shafts.find((p) => p.life <= 0) || this._shafts[0];
    s.t = 0; s.life = life; s.peak = peak; s.x = x; s.y = y; s.z = z;
    s.width = width; s.minR = minR; s.minH = minH;
    s.mesh.material.uniforms.uColor.value.set(color);
    s.mesh.material.uniforms.uOpacity.value = 0;
    s.mesh.visible = true;
  }

  /* ── the selection marks ──
     `list` is [{ x, y, z, radius }] — one entry per selected placement. The
     ring and the beacon persist for as long as the selection does and pulse
     together, which is what makes a selected object findable after you have
     orbited away from it. Beyond SEL_MAX the marks would be noise rather
     than information, so the tail is dropped (the box helpers and the Object
     Manager still account for every one). */
  setSelection(list) {
    const want = (list || []).slice(0, SEL_MAX);
    while (this._sel.length > want.length) {
      const m = this._sel.pop();
      m.ring.visible = false;
      m.shaft.mesh.visible = false;
      this._selFree.push(m);
    }
    while (this._sel.length < want.length) {
      const m = this._selFree.pop() || {
        ring: this._mount(new THREE.Mesh(this._ringGeo, new THREE.MeshBasicMaterial({
          color: SELECT, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }))),
        shaft: this._makeShaft(SELECT),
      };
      m.ring.visible = true;
      m.shaft.mesh.visible = true;
      m.shaft.life = -1; // driven by the selection, not by a countdown
      this._sel.push(m);
    }
    for (let i = 0; i < want.length; i++) {
      const w = want[i], m = this._sel[i];
      m.x = w.x; m.y = w.y; m.z = w.z;
      m.r = Math.max(1.3, w.radius || 2);
      m.ring.position.set(w.x, w.y + 0.16, w.z);
      m.shaft.x = w.x; m.shaft.y = w.y; m.shaft.z = w.z;
      m.shaft.width = 0.85;
      m.shaft.minR = Math.max(0.2, m.r * 0.1);
      m.shaft.minH = Math.max(7, m.r * 4);
    }
    return want.length;
  }
  clearSelection() { this.setSelection([]); }

  /* ── the arrival ──
     Eased up from nothing to the size the record already says it is, with
     the BOTTOM held still: growing about the object's own origin would sink
     a centre-origin GLB halfway into the ground on the way up. */
  arrive(object, duration = 0.44) {
    if (!object) return;
    const target = object.scale.clone();
    if (!this.motion) return;
    const box = new THREE.Box3().setFromObject(object);
    const lift = isFinite(box.min.y) ? object.position.y - box.min.y : 0;
    this._arrivals.push({
      object, target, lift, floor: object.position.y - lift, t: 0, duration,
    });
    object.scale.set(target.x * 0.02, target.y * 0.02, target.z * 0.02);
    object.position.y = object.position.y - lift * 0.98;
  }
  // Drop an object's tween without finishing it — for a placement deleted or
  // undone mid-arrival, whose object is about to be disposed.
  cancelArrival(object) {
    const i = this._arrivals.findIndex((a) => a.object === object);
    if (i >= 0) {
      const a = this._arrivals.splice(i, 1)[0];
      a.object.scale.copy(a.target);
      a.object.position.y = a.floor + a.lift;
    }
  }
  get arriving() { return this._arrivals.length > 0; }

  /* ── the frame ──
     Returns true when something moved, so the engine's on-demand renderer
     knows to draw. A world with no marks alive costs one length check. */
  tick(dt, camera) {
    let live = false;
    this._pulse += dt;

    for (const s of this._ripples) {
      if (s.life <= 0) continue;
      live = true;
      s.t += dt;
      if (s.t < 0) continue;             // still in its stagger delay
      const k = Math.min(s.t / s.life, 1);
      const e = easeOut(k);
      s.mesh.scale.setScalar(s.r0 + (s.r1 - s.r0) * e);
      s.mesh.material.opacity = 0.9 * (1 - k) * (1 - k);
      if (k >= 1) { s.life = 0; s.mesh.visible = false; s.mesh.material.opacity = 0; }
    }

    const d = this._disc;
    if (d && d.life > 0) {
      live = true;
      d.t += dt;
      const k = Math.min(d.t / d.life, 1);
      d.mesh.scale.setScalar(d.r0 + (d.r1 - d.r0) * easeOut(k));
      d.mesh.material.opacity = 0.5 * (1 - k);
      if (k >= 1) { d.life = 0; d.mesh.visible = false; }
    }

    for (const s of this._shafts) {
      if (s.life <= 0) continue;
      live = true;
      s.t += dt;
      const k = Math.min(s.t / s.life, 1);
      // Up fast, hold, then out: the shape of a mark that is announcing
      // rather than decorating.
      const env = k < 0.12 ? k / 0.12 : 1 - Math.pow((k - 0.12) / 0.88, 2);
      s.mesh.material.uniforms.uOpacity.value = Math.max(0, s.peak * env);
      this._shaft(s, camera);
      if (k >= 1) { s.life = 0; s.mesh.visible = false; }
    }

    if (this._sel.length) {
      live = true;
      // One breath, shared by every mark in the set, so a multi-selection
      // pulses as one thing rather than as twelve unrelated lights.
      const p = this.motion ? 0.5 + 0.5 * Math.sin(this._pulse * 2.6) : 1;
      for (const m of this._sel) {
        m.ring.scale.setScalar(m.r * (1.9 + 0.16 * p));
        m.ring.material.opacity = 0.34 + 0.3 * p;
        m.shaft.mesh.material.uniforms.uOpacity.value = 0.28 + 0.2 * p;
        this._shaft(m.shaft, camera);
      }
    }

    for (let i = this._arrivals.length - 1; i >= 0; i--) {
      const a = this._arrivals[i];
      live = true;
      // An object deleted (or restyled) mid-arrival is no longer ours.
      if (!a.object.parent) { this._arrivals.splice(i, 1); continue; }
      a.t += dt;
      const k = Math.min(a.t / a.duration, 1);
      const s = Math.max(0.02, easeOutBack(k));
      a.object.scale.set(a.target.x * s, a.target.y * s, a.target.z * s);
      a.object.position.y = a.floor + a.lift * Math.min(s, 1);
      if (k >= 1) {
        a.object.scale.copy(a.target);
        a.object.position.y = a.floor + a.lift;
        this._arrivals.splice(i, 1);
      }
    }
    return live;
  }

  /* Hold a shaft at a constant angular size. Without this the pillar is a
     hairline at world framing and a fog bank at working distance — the one
     piece of arithmetic that makes "visible from any zoom" true rather than
     claimed. */
  _shaft(s, camera) {
    const dx = camera.position.x - s.x, dy = camera.position.y - s.y, dz = camera.position.z - s.z;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1);
    const r = Math.min(Math.max(dist * 0.0045 * s.width, s.minR * s.width), 26 * s.width);
    s.mesh.position.set(s.x, s.y, s.z);
    s.mesh.scale.set(r, Math.min(Math.max(dist * 0.085, s.minH), 420), r);
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) o.material?.dispose(); });
    this._ringGeo.dispose();
    this._discGeo.dispose();
    this._tubeGeo.dispose();
    this._ripples.length = this._shafts.length = this._sel.length = this._selFree.length = 0;
    this._arrivals.length = 0;
  }
}
