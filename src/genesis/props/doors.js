// Interactive doors. A proc block that declares `proc.door` gets a pivot
// group (Props.js) holding its leaf; this registry knows where every such
// pivot is in the world, picks the one you are looking at, and swings it.
//
// Doors are presentation + play state, never world state: which doors happen
// to be open is not part of the params contract, so a world still reloads
// identically. Every door starts closed.

import * as THREE from "three";

const OPEN_SPEED = 3.2;   // radians-ish per second of eased travel
const REACH = 3.6;        // metres you can reach a door from
const FACING = 0.25;      // how much it must be in front of you (dot product)

export class Doors {
  constructor() {
    this.items = new Map(); // uid → { hinge, swing, open, t }
    this._v = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  // Walk a freshly built placement for a door pivot.
  register(uid, object) {
    const d = object.userData?.door;
    if (!d?.hinge) return;
    this.items.set(uid, { hinge: d.hinge, swing: d.swing, open: false, t: 0 });
  }

  unregister(uid) { this.items.delete(uid); }
  clear() { this.items.clear(); }
  get count() { return this.items.size; }

  // The door you are looking at from `camera`, or null. Nearest wins among
  // those in reach and roughly in front.
  pick(camera) {
    camera.getWorldDirection(this._fwd);
    let best = null, bestD = Infinity;
    for (const [uid, door] of this.items) {
      door.hinge.getWorldPosition(this._v);
      const dx = this._v.x - camera.position.x;
      const dy = this._v.y - camera.position.y;
      const dz = this._v.z - camera.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > REACH || dist > bestD) continue;
      const dot = (dx * this._fwd.x + dy * this._fwd.y + dz * this._fwd.z) / (dist || 1);
      if (dot < FACING) continue;
      best = { uid, door }; bestD = dist;
    }
    return best;
  }

  // Toggle the door in front of the camera. → the uid toggled, or null.
  interact(camera) {
    const hit = this.pick(camera);
    if (!hit) return null;
    hit.door.open = !hit.door.open;
    return hit.uid;
  }

  setOpen(uid, open) {
    const d = this.items.get(uid);
    if (d) d.open = !!open;
  }
  isOpen(uid) { return !!this.items.get(uid)?.open; }

  // Ease every door toward its target. → true while anything is still moving,
  // so the on-demand renderer keeps drawing.
  update(dt) {
    let moving = false;
    for (const d of this.items.values()) {
      const target = d.open ? 1 : 0;
      if (Math.abs(d.t - target) < 0.001) {
        if (d.t !== target) { d.t = target; d.hinge.rotation.y = target * d.swing; moving = true; }
        continue;
      }
      d.t += (target - d.t) * Math.min(1, dt * OPEN_SPEED * 2);
      d.hinge.rotation.y = d.t * d.swing;
      moving = true;
    }
    return moving;
  }
}
