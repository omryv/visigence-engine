// Player controllers: Orbit (editor), Walk (first-person on the terrain),
// Fly (arcade plane). One is active at a time; all share the engine camera
// and the height sampler, and call invalidate() so the on-demand renderer
// knows to draw.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { wetAt } from "../../kernel/water/flood.js";

export class OrbitEditor {
  constructor({ camera, canvas, params, invalidate }) {
    this.controls = new OrbitControls(camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 20;
    this.controls.maxDistance = params.terrain.size * 1.6;
    this.controls.addEventListener("change", invalidate);
    this.animating = false;
  }
  set enabled(v) { this.controls.enabled = v; }
  get enabled() { return this.controls.enabled; }
  update() { return this.controls.update(); }
  frame(point, camera, distance = 40) {
    this.controls.target.copy(point);
    camera.position.copy(point).add(new THREE.Vector3(distance * 0.7, distance * 0.6, distance * 0.7));
    this.controls.update();
  }
  dispose() { this.controls.dispose(); }
}

class PointerLookBase {
  constructor(opts) {
    const { camera, canvas, invalidate } = opts;
    this.camera = camera;
    this.canvas = canvas;
    this.invalidate = invalidate;
    this.enabled = false;
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this.animating = true; // continuous while active
    this.onAction = null;  // hook: VSight attaches weapon events here

    /* ── external input (touch overlay) ──
       Mouse+keyboard is not the only way in: touch-controls.js writes these
       and the update loops merge them with the keyboard, so a phone drives
       exactly the same controller with no pointer lock involved. */
    this.moveInput = { x: 0, y: 0 };   // −1..1, y forward
    this.lookInput = { x: 0, y: 0 };   // radians, consumed each frame
    this.runInput = false;
    this.jumpInput = false;            // one-shot latch
    this.touchActive = false;          // suppresses the pointer-lock path
    this.getParams = opts.getParams || (() => opts.params);

    this._onKey = (e) => {
      if (!this.enabled) return;
      if (e.type === "keydown") this.keys.add(e.code); else this.keys.delete(e.code);
    };
    this._onMouse = (e) => {
      if (!this.enabled || document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
      this.invalidate();
    };
    this._onClick = (e) => {
      if (!this.enabled) return;
      if (this.touchActive) return; // the overlay owns input; no lock to take
      if (document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock();
      else if (this.onAction) this.onAction({ type: "fire", button: e.button });
    };
    this._onKeyAction = (e) => {
      if (this.enabled && this.onAction && e.code === "KeyR") this.onAction({ type: "reload" });
    };
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("keyup", this._onKey);
    window.addEventListener("keydown", this._onKeyAction);
    document.addEventListener("mousemove", this._onMouse);
    canvas.addEventListener("mousedown", this._onClick);
  }

  activate(spawn) {
    this.enabled = true;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = e.y; this.pitch = e.x;
    if (spawn) this.camera.position.copy(spawn);
  }
  deactivate() {
    this.enabled = false;
    this.keys.clear();
    this.moveInput.x = this.moveInput.y = 0;
    this.lookInput.x = this.lookInput.y = 0;
    this.runInput = this.jumpInput = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
  // The world is a finite floating plate: past its rim there is nothing but
  // the void beside it, so the player is fenced inside. Keep the fence a few
  // metres in from the edge so you stand on the plate, not on its lip.
  clampToWorld(p, margin = 6) {
    const half = (this.getParams()?.terrain?.size ?? 4096) / 2 - margin;
    if (p.x > half) p.x = half; else if (p.x < -half) p.x = -half;
    if (p.z > half) p.z = half; else if (p.z < -half) p.z = -half;
  }

  // Fold one frame of touch look into the camera angles.
  _consumeLook() {
    if (!this.lookInput.x && !this.lookInput.y) return;
    this.yaw -= this.lookInput.x;
    this.pitch = THREE.MathUtils.clamp(this.pitch - this.lookInput.y, -1.45, 1.45);
    this.lookInput.x = this.lookInput.y = 0;
  }
  applyLook() {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }
  dispose() {
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("keyup", this._onKey);
    window.removeEventListener("keydown", this._onKeyAction);
    document.removeEventListener("mousemove", this._onMouse);
    this.canvas.removeEventListener("mousedown", this._onClick);
  }
}

export class WalkController extends PointerLookBase {
  constructor(opts) {
    super(opts);
    this.sampler = opts.sampler;
    this.blockers = opts.blockers || null;   // engine/player/collide.js
    this.getFlood = opts.getFlood || null;   // latest sea-connected mask (water/flood.js)
    this.isDoorOpen = opts.isDoorOpen || null; // an open leaf stops blocking
    this.eyeHeight = 1.7;
    this.velY = 0;
    this.grounded = true;
    this._swimT = 0;
    // Locomotion state, published for anything that reacts to it (the game's
    // footstep/water audio reads these every frame).
    this.moving = false;
    this.swimming = false;
    this.submerged = false;
    this.running = false;
    /* ── sitting ──
       A chair you can sit in is a chair somebody has to STOP walking in, and
       the controller is the only thing that owns where the player is. So a
       pose parked here suspends locomotion — not input: you can still look
       around, which is most of why anybody sits down in a room somebody
       spent this much trouble furnishing. Nothing else changes, and standing
       up hands the position straight back to gravity. */
    this.seat = null;
  }
  setSampler(s) { this.sampler = s; }
  get seated() { return !!this.seat; }
  // {x, y, z, yaw} in world space — engine/props/fittings.js works it out
  // from the seat's own placement.
  sit(pose) {
    if (!pose) return false;
    this.seat = pose;
    this.velY = 0;
    this.grounded = true;
    this.yaw = pose.yaw ?? this.yaw;
    return true;
  }
  stand() {
    if (!this.seat) return false;
    this.seat = null;
    return true;
  }
  update(dt) {
    if (!this.enabled) return false;
    dt = Math.min(dt, 0.05);
    this._consumeLook();
    if (this.seat) {
      this.camera.position.set(this.seat.x, this.seat.y, this.seat.z);
      this.moving = this.running = this.swimming = this.submerged = false;
      this.applyLook();
      return true;
    }
    const run = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.runInput;
    const p = this.camera.position;
    const terrain = this.sampler(p.x, p.z);
    const params = this.getParams();
    const waterOn = params?.water?.enabled !== false;
    // The waterline is wherever the flood slider put it — not 0 — and a
    // hollow the sea cannot reach is dry ground however far below the line
    // it lies (water/flood.js). No mask yet reads as wet,
    // which is the old behaviour.
    const level = waterOn ? params?.water?.level || 0 : 0;
    const wet = waterOn && wetAt(this.getFlood ? this.getFlood() : null, p.x, p.z) !== false;

    // ── swim: water deeper than knee height ──
    if (wet && terrain < level - 0.8) {
      this._swimT += dt;
      const speed = run ? 7 : 3.5;
      // Stroke along the full look direction — aim down and press W to dive.
      const f3 = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const r = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      const move = new THREE.Vector3();
      if (this.keys.has("KeyW")) move.add(f3);
      if (this.keys.has("KeyS")) move.sub(f3);
      if (this.keys.has("KeyD")) move.sub(r);
      if (this.keys.has("KeyA")) move.add(r);
      move.addScaledVector(f3, this.moveInput.y).addScaledVector(r, -this.moveInput.x);
      if (this.keys.has("Space") || this.jumpInput) move.y += 0.8; // kick upward
      this.jumpInput = false;
      if (move.lengthSq()) move.normalize().multiplyScalar(speed * dt);
      p.add(move);
      this.clampToWorld(p);

      // Buoyancy: a soft spring toward the surface (eyes just above it,
      // with a gentle bob) that a deliberate dive can overpower.
      const surface = level + 0.9 + Math.sin(this._swimT * 1.7) * 0.07;
      const diving = this.pitch < -0.35 && this.keys.has("KeyW");
      this.velY += (((diving ? 0.4 : 2.2) * (surface - p.y)) - this.velY * 2.4) * dt;
      p.y += this.velY * dt;
      p.y = Math.max(p.y, terrain + 0.6);            // never through the bottom
      if (p.y > surface + 0.1) p.y = surface + 0.1;  // no launching out of the sea
      this.grounded = false;
      this.moving = move.lengthSq() > 0;
      this.running = run;
      this.swimming = true;
      this.submerged = p.y < level + 0.45; // eyes below the waterline
      this.applyLook();
      return true;
    }

    // ── walk ──
    const speed = run ? 14 : 6;
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(f.z, 0, -f.x);
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(f);
    if (this.keys.has("KeyS")) move.sub(f);
    if (this.keys.has("KeyD")) move.sub(r);
    if (this.keys.has("KeyA")) move.add(r);
    // Touch stick: analogue, so a small lean walks and a full push runs.
    move.addScaledVector(f, this.moveInput.y).addScaledVector(r, -this.moveInput.x);
    if (move.lengthSq()) move.normalize().multiplyScalar(speed * dt * Math.min(1, Math.max(
      this.keys.size ? 1 : 0, Math.hypot(this.moveInput.x, this.moveInput.y))));
    const fromX = p.x, fromZ = p.z;
    p.x += move.x; p.z += move.z;
    this.clampToWorld(p);
    // Placed blocks are solid: slide along them rather than through them.
    if (this.blockers) {
      const solved = this.blockers.resolve(fromX, fromZ, p.x, p.z, p.y - this.eyeHeight, 0.42, this.isDoorOpen);
      p.x = solved.x; p.z = solved.z;
    }

    /* The floor is whatever is under you — the land, or the thing built on
       it. Standing on placed geometry was out of scope until now, which is
       why a house floor, a footing, a bridge deck and a flight of stairs
       were all things you walked through rather than on. */
    const feet = p.y - this.eyeHeight;
    /* …EXCEPT INSIDE A DECLARED INTERIOR, where the land is not a floor.
       The terrain was an unconditional lower bound, so a player could never
       be below it — and a cellar is below it by definition. Every basement
       in the project was therefore a room you could see down into and never
       stand in: geometry, lighting, contents and a staircase, all correct,
       all unreachable, because the ground held your feet up at the top of
       the steps. This is not a game-mode rule. It is what "indoors" means,
       and it applies to a cellar, a bunker, a metro or a cave mouth alike.

       The fallback matters as much as the rule: with nothing built under you
       the land comes back, so a gap in an interior floor drops you to the
       ground rather than out of the world. */
    const inside = this.indoors ? this.indoors(p.x, feet, p.z) : false;
    const land = Math.max(this.sampler(p.x, p.z), wet ? level - 0.5 : -Infinity);
    let floor = inside ? -Infinity : land;
    if (this.blockers) {
      const onBlock = this.blockers.surfaceAt(p.x, p.z, feet, 0.42, this.isDoorOpen);
      if (onBlock > floor) floor = onBlock;
    }
    if (!Number.isFinite(floor)) floor = land;
    const ground = floor + this.eyeHeight; // wade until it's swimming depth
    if (this.grounded && (this.keys.has("Space") || this.jumpInput)) { this.velY = 8.5; this.grounded = false; }
    this.jumpInput = false;
    this.velY -= 24 * dt;
    p.y += this.velY * dt;
    if (p.y <= ground) { p.y = ground; this.velY = 0; this.grounded = true; }

    this.swimming = false;
    this.submerged = false;
    this.running = run;
    this.moving = this.grounded && Math.hypot(move.x, move.z) > 1e-4;

    this.applyLook();
    return true;
  }
}

export class FlyController extends PointerLookBase {
  constructor(opts) {
    super(opts);
    this.sampler = opts.sampler;
    this.throttle = 60;
  }
  setSampler(s) { this.sampler = s; }
  activate(spawn) {
    super.activate(spawn);
    if (!spawn) this.camera.position.y = Math.max(this.camera.position.y, this.sampler(this.camera.position.x, this.camera.position.z) + 120);
  }
  update(dt) {
    if (!this.enabled) return false;
    dt = Math.min(dt, 0.05);
    this._consumeLook();
    if (this.keys.has("KeyW")) this.throttle = Math.min(this.throttle + 60 * dt, 220);
    if (this.keys.has("KeyS")) this.throttle = Math.max(this.throttle - 80 * dt, 18);
    if (this.keys.has("KeyA")) this.yaw += 0.9 * dt;
    if (this.keys.has("KeyD")) this.yaw -= 0.9 * dt;
    // Touch stick: forward = throttle, sideways = bank.
    if (this.moveInput.y) this.throttle = THREE.MathUtils.clamp(this.throttle + this.moveInput.y * 70 * dt, 18, 220);
    if (this.moveInput.x) this.yaw -= this.moveInput.x * 0.9 * dt;
    this.applyLook();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.addScaledVector(dir, this.throttle * dt);
    // Terrain-follow floor: never fly through a mountain, and never off the
    // plate — banking into the void beside it is nobody's intent.
    const p = this.camera.position;
    this.clampToWorld(p, 0);
    const floor = this.sampler(p.x, p.z) + 6;
    if (p.y < floor) p.y = floor;
    return true;
  }
}
