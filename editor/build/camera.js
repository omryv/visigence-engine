/**
 * The level editor's camera: orbit round a point on the ground, pan across it, look straight down (top), or fly free.
 * It writes into the session's own world camera (game/ShooterSession.js setEditView), so the world, the post stack and
 * the overlays all see through one lens.
 *
 * Every mode resolves to an eye and a target, so a change of mode or a jump to an issue is a short ease between two
 * of them (420 ms on the studio's rack curve, instant under prefers-reduced-motion). The ground under the target comes
 * from the level's terrain, so an orbit never sinks into a hill.
 */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => 1 - (1 - t) ** 3;
export const CAMERA_MODES = ['orbit', 'top', 'fly'];

export class EditorCamera {
  constructor({ ground = () => 0, reducedMotion = () => false } = {}) {
    this.ground = ground; this.reducedMotion = reducedMotion;
    this.mode = 'orbit';
    this.target = { x: 0, z: 16 };
    this.yaw = 0.55; this.pitch = 0.78; this.distance = 30;
    this.fly = { x: 0, y: 12, z: 42, yaw: 0, pitch: -0.35 };
    this.fov = 50;
    this.tween = null;
    this._eye = { x: 0, y: 0, z: 0 }; this._look = { x: 0, y: 0, z: 0 };
  }

  get animating() { return !!this.tween; }

  /** Where the camera sits and looks for the current mode, before any ease. */
  pose() {
    if (this.mode === 'fly') {
      const f = this.fly, cp = Math.cos(f.pitch);
      return { eye: { x: f.x, y: f.y, z: f.z }, look: { x: f.x - Math.sin(f.yaw) * cp, y: f.y + Math.sin(f.pitch), z: f.z - Math.cos(f.yaw) * cp } };
    }
    const gy = this.ground(this.target.x, this.target.z), pitch = this.mode === 'top' ? 1.5533 : this.pitch, yaw = this.mode === 'top' ? 0 : this.yaw;
    const d = this.distance, h = Math.cos(pitch) * d;
    return { eye: { x: this.target.x + Math.sin(yaw) * h, y: gy + Math.sin(pitch) * d, z: this.target.z + Math.cos(yaw) * h }, look: { x: this.target.x, y: gy, z: this.target.z } };
  }

  /** Write the lens into a three camera. Returns true while an ease is running (render another frame). */
  apply(camera, now = performance.now()) {
    let { eye, look } = this.pose();
    if (this.tween) {
      const t = clamp((now - this.tween.start) / this.tween.ms, 0, 1), k = ease(t), a = this.tween.from;
      const mix = (p, q) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, z: p.z + (q.z - p.z) * k });
      eye = mix(a.eye, eye); look = mix(a.look, look);
      if (t >= 1) this.tween = null;
    }
    camera.position.set(eye.x, eye.y, eye.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(look.x, look.y, look.z);
    camera.fov = this.mode === 'top' ? 34 : this.fov;
    // A level on its world draws its sea out to the horizon (render/CombatEnvironment.js), so the far plane stays far.
    // The near plane follows how far the eye is from what it looks at: a fixed 0.1 against a 6600 m far plane left the
    // depth buffer no precision past a few hundred metres, so the sea and the distant ground z-fought into streaks, and
    // the temporal AA and the ambient occlusion (both read depth) smeared them across the view.
    camera.near = this.nearPlane(eye);
    camera.far = 6600;
    this._eye = eye; this._look = look;
    return !!this.tween;
  }

  /** The nearest the lens draws: a few percent of the orbit distance; in fly, a share of the height over the ground. */
  nearPlane(eye) {
    if (this.mode === 'fly') return clamp((eye.y - this.ground(eye.x, eye.z)) * 0.25, 0.1, 1);
    return clamp(this.distance * 0.04, 0.2, 3);
  }

  /** Start an ease from wherever the camera is now to the pose the next change makes. */
  _ease(change) {
    const from = { eye: { ...this._eye }, look: { ...this._look } };
    change();
    this.tween = this.reducedMotion() ? null : { from, start: performance.now(), ms: 420 };
  }

  setMode(mode) {
    if (!CAMERA_MODES.includes(mode) || mode === this.mode) return;
    this._ease(() => {
      if (mode === 'fly') {
        // Fly starts where the orbit was looking from, pointing the same way.
        const { eye, look } = this.pose(), dx = look.x - eye.x, dy = look.y - eye.y, dz = look.z - eye.z, h = Math.hypot(dx, dz);
        this.fly = { x: eye.x, y: eye.y, z: eye.z, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, h) };
      } else if (this.mode === 'fly') {
        // Leaving fly: orbit the ground point the camera was looking at.
        const f = this.fly, down = Math.max(0.2, -Math.sin(f.pitch)), reach = clamp((f.y - this.ground(f.x, f.z)) / down, 6, 80);
        this.target = { x: clamp(f.x - Math.sin(f.yaw) * Math.cos(f.pitch) * reach, -44, 44), z: clamp(f.z - Math.cos(f.yaw) * Math.cos(f.pitch) * reach, -44, 44) };
        this.distance = clamp(reach, 6, 90);
      }
      if (mode === 'top') this.distance = Math.max(this.distance, 40);
      this.mode = mode;
    });
  }

  /** Orbit by a pointer drag in pixels (top view pans instead: the map stays north-up). */
  orbitBy(dx, dy, height) {
    if (this.mode === 'top') return this.panBy(dx, dy, height);
    if (this.mode === 'fly') return this.lookBy(dx, dy);
    this.tween = null;
    this.yaw = (this.yaw - dx * 0.006) % TAU;
    this.pitch = clamp(this.pitch + dy * 0.005, 0.17, 1.52);
  }

  /** Drag the ground under the pointer: a pixel is as many metres as the view is deep at the target. */
  panBy(dx, dy, height) {
    this.tween = null;
    if (this.mode === 'fly') {
      const f = this.fly, s = 0.03;
      f.x -= Math.cos(f.yaw) * dx * s; f.z += Math.sin(f.yaw) * dx * s; f.y += dy * s;
      return;
    }
    const perPixel = 2 * this.distance * Math.tan((this.mode === 'top' ? 34 : this.fov) * Math.PI / 360) / Math.max(1, height);
    const yaw = this.mode === 'top' ? 0 : this.yaw, c = Math.cos(yaw), s = Math.sin(yaw);
    const rx = -dx * perPixel, rz = -dy * perPixel / Math.max(0.35, Math.sin(this.mode === 'top' ? 1.55 : this.pitch));
    this.target = { x: clamp(this.target.x + rx * c + rz * s, -44, 44), z: clamp(this.target.z - rx * s + rz * c, -44, 44) };
  }

  /** Zoom by a factor (<1 in, >1 out); in fly, move along the view. */
  zoomBy(factor) {
    this.tween = null;
    if (this.mode === 'fly') {
      const f = this.fly, step = (1 - factor) * 12, cp = Math.cos(f.pitch);
      f.x -= Math.sin(f.yaw) * cp * step; f.z -= Math.cos(f.yaw) * cp * step; f.y = Math.max(this.ground(f.x, f.z) + 1, f.y + Math.sin(f.pitch) * step);
      return;
    }
    this.distance = clamp(this.distance * factor, 4, 110);
  }

  lookBy(dx, dy) {
    this.tween = null;
    const f = this.fly;
    f.yaw = (f.yaw - dx * 0.004) % TAU; f.pitch = clamp(f.pitch - dy * 0.004, -1.45, 1.45);
  }

  /** Fly with held keys: forward/back, strafe, up/down, in metres a second. */
  flyBy(move, dt, fast = false) {
    if (this.mode !== 'fly' || (!move.x && !move.y && !move.z)) return false;
    this.tween = null;
    const f = this.fly, v = (fast ? 26 : 11) * dt, s = Math.sin(f.yaw), c = Math.cos(f.yaw);
    f.x += (-s * move.y + c * move.x) * v; f.z += (-c * move.y - s * move.x) * v;
    f.y = Math.max(this.ground(f.x, f.z) + 0.8, f.y + move.z * v);
    f.x = clamp(f.x, -70, 70); f.z = clamp(f.z, -70, 70); f.y = Math.min(f.y, 120);
    return true;
  }

  /** Frame a spot (an issue, a selection): orbit and top ease there; fly turns to face it from where it is. */
  focus(x, z, radius = 4) {
    this._ease(() => {
      if (this.mode === 'fly') {
        const f = this.fly, gy = this.ground(x, z), back = Math.max(8, radius * 3.5);
        const dx = x - f.x, dz = z - f.z, h = Math.hypot(dx, dz) || 1;
        f.x = x - dx / h * back; f.z = z - dz / h * back; f.y = gy + back * 0.6;
        f.yaw = Math.atan2(-dx, -dz); f.pitch = -Math.atan2(back * 0.6, back);
        return;
      }
      this.target = { x: clamp(x, -44, 44), z: clamp(z, -44, 44) };
      this.distance = clamp(radius * 4.5, 10, 70);
    });
  }

  /** The whole meadow in view. */
  frameAll() { this._ease(() => { if (this.mode === 'fly') this.mode = 'orbit'; this.target = { x: 0, z: 0 }; this.distance = 88; this.pitch = Math.max(this.pitch, 0.9); }); }

  snapshot() { return { mode: this.mode, target: { ...this.target }, yaw: this.yaw, pitch: this.pitch, distance: this.distance, fly: { ...this.fly } }; }
  restore(s) { if (!s || !CAMERA_MODES.includes(s.mode)) return; Object.assign(this, { mode: s.mode, target: { ...s.target }, yaw: s.yaw, pitch: s.pitch, distance: s.distance, fly: { ...s.fly } }); this.tween = null; }
}
