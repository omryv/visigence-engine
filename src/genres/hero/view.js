/**
 * The views that show the hero (docs/GENRES.md): `follow`, a camera that orbits the hero from over the shoulder and
 * pulls in rather than cut through a wall; and `overhead`, a camera above and behind them, north up, that the pointer
 * aims from. Plus the pure maths both need: a pointer to a point on the ground, a yaw toward a point, the shortest
 * turn between two yaws, and a move read on screen turned into the player's own frame.
 *
 * The player controller's forward is (-sin yaw, 0, -cos yaw); its `addLook(x, y)` does yaw -= x and pitch -= y.
 */
import { Vector3 } from 'three/webgpu';

const _v = new Vector3(), _o = new Vector3(), _eye = new Vector3(), _dir = new Vector3(), _look = new Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** The yaw that faces from one point to another. */
export function yawToward(from, to) { return Math.atan2(-(to.x - from.x), -(to.z - from.z)); }
/** The shortest signed turn from one yaw to another. */
export function yawDelta(current, desired) { return Math.atan2(Math.sin(desired - current), Math.cos(desired - current)); }

/** Normalized device coordinates of a client point over a canvas rectangle. */
export function pointerToNdc(clientX, clientY, rect) {
  return { x: ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, y: 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2 };
}
/** Where the ray through a pointer (NDC) meets the plane y = planeY; null when it never does. */
export function groundPointFromPointer(ndc, camera, planeY = 0) {
  camera.updateMatrixWorld();
  _o.setFromMatrixPosition(camera.matrixWorld);
  _v.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(_o).normalize();
  if (Math.abs(_v.y) < 1e-6) return null;
  const t = (planeY - _o.y) / _v.y;
  return t > 0 ? { x: _o.x + _v.x * t, z: _o.z + _v.z * t } : null;
}
/** A move read on screen (x east, y north, as keys read on a north-up view) in the player's frame (x strafe, y forward). */
export function worldMoveToLocal(move, yaw) {
  const vx = move.x, vz = -move.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = -fz, rz = fx;
  return { x: vx * rx + vz * rz, y: vx * fx + vz * fz };
}
/** A move read against a camera's yaw (forward is where the camera looks), as a direction on the ground. */
export function cameraRelative(move, cameraYaw) {
  const fx = -Math.sin(cameraYaw), fz = -Math.cos(cameraYaw), rx = Math.cos(cameraYaw), rz = -Math.sin(cameraYaw);
  return { x: rx * move.x + fx * move.y, z: rz * move.x + fz * move.y };
}

/**
 * Behind the hero. The mouse (or the right stick, or a drag on a touch screen) orbits the camera; the hero turns to
 * where they run. The camera eases after the hero, keeps its height over hills, and slides in along its own sight
 * line when a house or a tree trunk would come between. A camera straight behind the hero hides what lies straight
 * ahead of them, so a genre frames it one of two ways: over the shoulder (`shoulder`, metres to the right; the
 * action adventure), or higher and further back (`pitch`, `distance`; the collect-a-thon, where a jump is judged).
 */
export class FollowCamera {
  constructor({ distance = 5.4, height = 1.55, pitch = 0.3, shoulder = 0 } = {}) {
    Object.assign(this, { distance, height, pitch, shoulder, rest: pitch, yaw: 0, pull: distance });
    this.at = null;
  }
  reset(yaw) { this.yaw = yaw; this.pitch = this.rest; this.at = null; this.pull = this.distance; }
  orbit(dx, dy) { this.yaw -= dx; this.pitch = clamp(this.pitch + dy, -0.35, 1.1); }
  /** @param {{x:number,y:number,z:number}} target  the hero's feet, already interpolated */
  place(camera, target, collision, dt) {
    const k = this.at ? 1 - Math.exp(-dt * 14) : 1;
    this.at = this.at ? { x: this.at.x + (target.x - this.at.x) * k, y: this.at.y + (target.y - this.at.y) * Math.min(1, k * 0.8), z: this.at.z + (target.z - this.at.z) * k } : { ...target };
    _look.set(this.at.x + Math.cos(this.yaw) * this.shoulder, this.at.y + this.height, this.at.z - Math.sin(this.yaw) * this.shoulder);
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    // Slide in along the sight line when something solid (a house, a trunk, cover) would stand between the camera and
    // the hero. Water and steep banks do not count: the nav grid refuses them, but the camera may pass over them.
    const blocked = collision ? solidAlong(collision, _look, _dir, this.distance) : Infinity;
    const want = blocked < this.distance ? Math.max(1.2, blocked - 0.35) : this.distance;
    this.pull = want < this.pull ? want : this.pull + (want - this.pull) * (1 - Math.exp(-dt * 4));
    _eye.copy(_look).addScaledVector(_dir, this.pull);
    camera.position.copy(_eye);
    camera.up.set(0, 1, 0);
    // Aim above the hero, so they stand low in the frame and the ground they run toward shows over their head.
    camera.lookAt(_look.x, _look.y + 0.9, _look.z);
    camera.fov = 58;
  }
}

/** The nearest solid box (a prop's projectile box: houses, trunks, cover) along a ray, within range; Infinity if none. */
function solidAlong(collision, origin, dir, range) {
  let best = Infinity;
  for (const p of collision.projectileBoxes) {
    if (p.active === false) continue;
    let near = 0, far = range, miss = false;
    for (const axis of ['x', 'y', 'z']) {
      const d = dir[axis], o = origin[axis], lo = p.box.min[axis], hi = p.box.max[axis];
      if (Math.abs(d) < 1e-10) { if (o < lo || o > hi) { miss = true; break; } continue; }
      const a = (lo - o) / d, b = (hi - o) / d;
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      if (near > far) { miss = true; break; }
    }
    if (!miss && near < best) best = near;
  }
  return best;
}

/** Above and behind, north up: the camera trails the hero and the pointer's point on the ground is what they aim at. */
export class OverheadCamera {
  constructor({ height = 15, back = 8.5, fov = 46 } = {}) { Object.assign(this, { height, back, fov }); this.at = null; }
  reset() { this.at = null; }
  place(camera, target, dt) {
    const k = this.at ? 1 - Math.exp(-dt * 8) : 1;
    this.at = this.at ? { x: this.at.x + (target.x - this.at.x) * k, y: this.at.y + (target.y - this.at.y) * k, z: this.at.z + (target.z - this.at.z) * k } : { ...target };
    // A tall (portrait) screen sees little across, so the camera stands further off to show the same arena width.
    const far = Math.min(1.7, Math.max(1, 1 / (camera.aspect || 1)));
    camera.position.set(this.at.x, this.at.y + this.height * far, this.at.z + this.back * far);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.at.x, this.at.y + 1, this.at.z);
    camera.fov = this.fov;
  }
}
