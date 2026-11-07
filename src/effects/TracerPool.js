/**
 * Pooled tracers: one InstancedMesh, `capacity` instances, one draw call.
 *
 * A tracer is a thin stretched box from the MUZZLE (visual origin) to the point the AIM
 * ray hit, so it always ends where the bullet landed. It lives for a few frames and
 * thins out as it dies. Dead instances are scaled to zero, never removed, so the buffer
 * layout never changes and firing never allocates.
 */

import {
  InstancedMesh, BoxGeometry, MeshBasicMaterial, Matrix4, Vector3, Quaternion, Color,
  AdditiveBlending, DynamicDrawUsage,
} from 'three/webgpu';
import { excludeFromEnvironment } from '../render/Environment.js';

const _m = new Matrix4();
const _p = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _dir = new Vector3();
const _z = new Vector3(0, 0, 1);
const _c = new Color();

export class TracerPool {
  constructor(scene, capacity = 24, life = 0.07) {
    this.capacity = capacity;
    this.lifeMax = life;
    this.enabled = true;

    const geo = new BoxGeometry(1, 1, 1);
    this.material = excludeFromEnvironment(new MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false,
      blending: AdditiveBlending, fog: false,
    }));
    this.mesh = new InstancedMesh(geo, this.material, capacity);
    this.mesh.name = 'Tracers';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.renderOrder = 30;

    this.life = new Float32Array(capacity);
    this.from = new Float32Array(capacity * 3);
    this.to = new Float32Array(capacity * 3);
    this.next = 0;
    this.live = 0;

    _s.set(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      _m.compose(_p.set(0, -1000, 0), _q.identity(), _s);
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.set(0xffffff));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** From the muzzle to the hit point, in world space. */
  spawn(fx, fy, fz, tx, ty, tz, color) {
    if (!this.enabled) return;
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const p = i * 3;
    this.from[p] = fx; this.from[p + 1] = fy; this.from[p + 2] = fz;
    this.to[p] = tx; this.to[p + 1] = ty; this.to[p + 2] = tz;
    this.life[i] = this.lifeMax;
    this.mesh.setColorAt(i, _c.set(color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this._place(i, 1);
  }

  _place(i, k) {
    const p = i * 3;
    _dir.set(this.to[p] - this.from[p], this.to[p + 1] - this.from[p + 1], this.to[p + 2] - this.from[p + 2]);
    const len = _dir.length();
    if (len < 1e-4) { _s.set(0, 0, 0); _m.compose(_p.set(0, -1000, 0), _q.identity(), _s); }
    else {
      _dir.multiplyScalar(1 / len);
      _q.setFromUnitVectors(_z, _dir);
      // The streak starts a little ahead of the muzzle and covers most of the flight.
      const start = Math.min(len * 0.2, 0.35);
      _p.set(
        this.from[p] + _dir.x * (start + (len - start) * 0.5),
        this.from[p + 1] + _dir.y * (start + (len - start) * 0.5),
        this.from[p + 2] + _dir.z * (start + (len - start) * 0.5)
      );
      const thick = 0.012 * k;
      _s.set(thick, thick, Math.max(0.05, len - start));
      _m.compose(_p, _q, _s);
    }
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        _s.set(0, 0, 0);
        _m.compose(_p.set(0, -1000, 0), _q.identity(), _s);
        this.mesh.setMatrixAt(i, _m);
        this.mesh.instanceMatrix.needsUpdate = true;
        continue;
      }
      live++;
      this._place(i, this.life[i] / this.lifeMax);
    }
    this.live = live;
    this.mesh.visible = live > 0;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) {
      this.life[i] = 0;
      _s.set(0, 0, 0);
      _m.compose(_p.set(0, -1000, 0), _q.identity(), _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose?.();
  }
}
