/**
 * Enemies that ship as ONE SOLID MESH: the rigid heavies and the generated critters.
 *
 * WHAT IS IN THE FILES. Each is a Tripo export with a single node, a single unskinned mesh, no
 * skeleton and no animation clip - measured, not assumed. None of the machinery for skinned
 * bodies applies: a skinned rig wants a bind pose to recover, a gait wants legs to swing, and
 * PackAnimator wants authored clips to play. A body with no joints gets none of that, and pretending otherwise - hanging a borrowed skeleton
 * off a mesh that was never weighted to it - would tear the mesh at the first step.
 *
 * WHAT IS DONE INSTEAD. The body is treated as exactly what it is: a rigid object, and the
 * animation is the motion of the object itself. That turns out to be the right register for
 * these three anyway. A hippo the width of a corridor does not need articulated knees to read
 * as walking; it needs the lumbering roll of something heavy shifting its weight from one side
 * to the other, the forward lean that says it is pushing itself along, the rear-back and the
 * lunge of a swing, the recoil of a hit, and a topple that pivots at the feet. Every one of
 * those is a transform of the whole body, and all of them are here.
 *
 * TWO PARTS:
 *
 *   prepareRigidBody   load-time, once per MODEL. Scales the mesh into metres, stands its
 *                      feet on y = 0, and moves its trunk onto the origin - the same
 *                      contract the rebuild gives a rig, so the collider, the hit capsule and
 *                      the silhouette are the same object here too. Measures what the level
 *                      needs to know (trunk radius) and reports it.
 *   RigidAnimator      per instance, per frame. Same interface as a skinned body's
 *                      PackAnimator - update, reset, restPose, kickStagger,
 *                      setDeathDirection - so the game does not know which kind of body it
 *                      is talking to. It owns the model node's local transform and nothing
 *                      else; the root's position and yaw stay EnemySystem's.
 *
 * As with the skinned enemies, the split is strict: this reads the simulation and never
 * writes to it, so nothing here can move a damage window.
 */

import { Vector3, Quaternion, Euler, Matrix4, Box3 } from 'three/webgpu';
import { ANIM } from '../config/enemyAnim.js';
import { EnemyState } from '../sim/EnemyState.js';
import { mulberry32 } from '../utils/math.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
/** Smooth 0..1 with zero velocity at both ends - the same easing the joint animator uses. */
const minJerk = (t) => { const x = clamp(t, 0, 1); return x * x * x * (10 + x * (-15 + 6 * x)); };
/** Frame-rate independent exponential approach. */
const damp = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

const _box = new Box3();
const _size = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _axis = new Vector3();

/**
 * One rigid model's load-time measurement. Everything here came off the mesh; nothing is
 * authored. The load report and the validator print it the same way for every body.
 */
export class RigidBodyReport {
  constructor(key) {
    this.key = key;
    /** Uniform factor applied to the geometry to put the model in metres. */
    this.scale = 1;
    /** Standing height in metres, from the mesh. */
    this.height = 0;
    /** Half-extents of the mesh in the horizontal plane after recentring, in metres. */
    this.halfWidth = 0;
    this.halfDepth = 0;
    /**
     * Half-width of the trunk band, two ways. `coreRadius` is the median horizontal distance
     * of the band's vertices from the trunk axis: the barrel of the body, what the collision
     * disc has to contain. `bodyRadius` is the 92nd percentile - and on these models it is the ARMS and the SHELL, which hang well
     * outside any disc the level can route (0.92 m; see ENEMY_TYPES). The gap between the two
     * is how far a limb may overhang a wall in the tightest corridor, and it is reported
     * rather than hidden.
     */
    this.coreRadius = 0;
    this.bodyRadius = 0;
    /** How far the model was moved horizontally to stand its trunk on its own origin. */
    this.recentre = new Vector3();
    /** Number of meshes the model carries; the heavies carry one. */
    this.meshes = 0;
    this.vertices = 0;
    this.notes = [];
  }

  describe() {
    const n = [`RigidBodyReport ${this.key}: ${this.meshes} mesh, ${this.vertices} vertices, ` +
      `no skeleton, scale ${this.scale.toFixed(4)} -> ${this.height.toFixed(3)} m, ` +
      `footprint ${(this.halfWidth * 2).toFixed(2)} x ${(this.halfDepth * 2).toFixed(2)} m, ` +
      `core radius ${this.coreRadius.toFixed(3)} m (limbs to ${this.bodyRadius.toFixed(3)} m), ` +
      `recentred by (${this.recentre.x.toFixed(3)}, ${this.recentre.z.toFixed(3)}) m`];
    for (const note of this.notes) n.push(`  ${note}`);
    return n.join('\n');
  }
}

/**
 * The band of the body that counts as its trunk, as fractions of its height. Below it are
 * legs (one of which may be mid-stride), above it a head that may lean well forward - the
 * giraffe's does - and neither is what a collision disc is meant to contain.
 */
const TRUNK_BAND = [0.30, 0.68];

/**
 * Put a rigid model in metres with its feet on the floor and its trunk on the origin, ONCE,
 * on the template every instance clones from, so that no transform anywhere downstream has to be undone, and the
 * hit capsule, the collider and the mesh all speak the same metres about the same origin.
 *
 * Every node's world transform is baked into its geometry and the nodes are reset to the
 * identity, so the model's own scene graph contributes nothing afterwards and the animator
 * can own the root node's local transform outright.
 *
 * @param {string} key
 * @param {import('three').Object3D} scene   the loaded GLB's scene; MODIFIED in place
 * @param {number} targetHeight              metres
 * @returns {RigidBodyReport}
 */
export function prepareRigidBody(key, scene, targetHeight) {
  const report = new RigidBodyReport(key);
  scene.updateMatrixWorld(true);

  const meshes = [];
  scene.traverse((o) => {
    if (o.isSkinnedMesh) {
      throw new Error(`RigidBody: "${key}" carries a skinned mesh; it plays authored clips (PackAnimator), not this`);
    }
    if (o.isMesh) meshes.push(o);
  });
  if (!meshes.length) throw new Error(`RigidBody: "${key}" contains no mesh`);

  // Pass 1: the model's own space. Bake each mesh's world matrix so all of them share one
  // frame, then measure that frame.
  for (const mesh of meshes) {
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
  }
  scene.traverse((o) => {
    o.position.set(0, 0, 0);
    o.quaternion.identity();
    o.scale.set(1, 1, 1);
  });
  scene.updateMatrixWorld(true);

  _box.makeEmpty();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    _box.union(mesh.geometry.boundingBox);
  }
  _box.getSize(_size);
  const rawHeight = _size.y;
  const scale = rawHeight > 1e-6 ? targetHeight / rawHeight : 1;
  report.scale = scale;

  // The trunk's own vertical axis: the centroid of the vertices in the trunk band. The
  // bounding-box centre would do for the hippo; for the tortoise, whose shell runs well
  // behind the body, it would put the disc on the shell and leave the head uncovered.
  const y0 = _box.min.y + rawHeight * TRUNK_BAND[0];
  const y1 = _box.min.y + rawHeight * TRUNK_BAND[1];
  let cx = 0, cz = 0, n = 0;
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const y = pos.getY(v);
      if (y < y0 || y > y1) continue;
      cx += pos.getX(v); cz += pos.getZ(v); n++;
    }
  }
  if (n) { cx /= n; cz /= n; } else { cx = (_box.min.x + _box.max.x) / 2; cz = (_box.min.z + _box.max.z) / 2; }

  // Pass 2: into metres, feet on the floor, trunk on the origin.
  _m.makeScale(scale, scale, scale).multiply(new Matrix4().makeTranslation(-cx, -_box.min.y, -cz));
  let vertices = 0;
  const xs = [], zs = [];
  for (const mesh of meshes) {
    mesh.geometry.applyMatrix4(_m);
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
    const pos = mesh.geometry.attributes.position;
    vertices += pos.count;
    for (let v = 0; v < pos.count; v++) {
      const y = pos.getY(v);
      if (y < targetHeight * TRUNK_BAND[0] || y > targetHeight * TRUNK_BAND[1]) continue;
      xs.push(pos.getX(v)); zs.push(pos.getZ(v));
    }
  }
  report.recentre.set(-cx * scale, 0, -cz * scale);
  report.meshes = meshes.length;
  report.vertices = vertices;

  _box.makeEmpty();
  for (const mesh of meshes) _box.union(mesh.geometry.boundingBox);
  _box.getSize(_size);
  report.height = _size.y;
  report.halfWidth = Math.max(-_box.min.x, _box.max.x);
  report.halfDepth = Math.max(-_box.min.z, _box.max.z);

  // The 92nd percentile horizontal distance from the trunk axis over the trunk's own vertices, so one stray
  // fingertip does not set the number.
  if (xs.length >= 8) {
    const r = xs.map((x, i) => Math.hypot(x, zs[i])).sort((a, b) => a - b);
    report.coreRadius = r[Math.floor(r.length * 0.50)];
    report.bodyRadius = r[Math.min(r.length - 1, Math.floor(r.length * 0.92))];
  }
  report.notes.push(`unskinned; animated as one solid body by RigidAnimator`);
  return report;
}

/**
 * Per-instance motion of a rigid body. Drives the model node's position and rotation only.
 *
 * Every amplitude is a fraction of the body's height (so the same numbers make a 2.4 m
 * tortoise and a 3.2 m giraffe move in proportion) and is scaled by the type's style block:
 * `weight` slows the settle and deepens the lean, `energy` widens every excursion.
 */
export class RigidAnimator {
  /**
   * @param {RigidBodyReport} body
   * @param {import('three').Object3D} model   the clone's root; its local transform is owned here
   * @param {object} type    the ENEMY_TYPES entry, read-only
   * @param {number} seed
   */
  constructor(body, model, type, seed) {
    this.body = body;
    this.model = model;
    this.type = type;
    this.style = ANIM.style[type.id] || ANIM.defaultStyle;
    this.R = ANIM.rigid;

    this.phase = 0;
    this.breathPhase = 0;
    /** Stagger spring: displacement and velocity. */
    this._stagX = 0;
    this._stagV = 0;
    /** Smoothed lean, so a speed change is anticipated rather than snapped to. */
    this._lean = 0;
    this._prevYaw = 0;
    this._prevSpeed = 0;
    this._yawRate = 0;
    this._accel = 0;
    /** Footfall settle: a decaying dip triggered at each step. */
    this._settle = 0;
    this._lastStep = 0;
    this._deathTilt = 0;
    /** Per-individual: which side leads, and how uneven the roll is. */
    this._rollBias = 1;
    this._cadenceScale = 1;
    /** Diagnostics for the validator and the debug panel. Never read by gameplay. */
    this.debug = { cadence: 0, stride: 1, groundSpeed: 0, planted: 0, clamped: 0 };

    this.reset(seed);
  }

  /** Spawn-time reset. A pooled instance that comes back is a different individual. */
  reset(seed) {
    const rnd = mulberry32((seed >>> 0) ^ 0x5BF03635);
    this.phase = rnd();
    this.breathPhase = rnd();
    this._stagX = 0;
    this._stagV = 0;
    this._lean = 0;
    this._prevYaw = 0;
    this._prevSpeed = 0;
    this._yawRate = 0;
    this._accel = 0;
    this._settle = 0;
    this._lastStep = Math.floor(this.phase * 2);
    this._deathTilt = 0;
    const a = this.style.asymmetry;
    this._rollBias = 1 + (rnd() - 0.5) * a * 0.6;
    this._cadenceScale = 1 + (rnd() - 0.5) * a * 0.3;
  }

  /** Restore the rest transform. Used when an instance is recycled. */
  restPose() {
    this.model.position.set(0, 0, 0);
    this.model.quaternion.identity();
  }

  /**
   * @param {number} dt         render delta, seconds
   * @param {object} e          the Enemy (position, velocity, yaw, state, alive, ...)
   * @param {import('three').Vector3} playerPos
   */
  update(dt, e, playerPos) {
    const R = this.R;
    const S = this.style;
    const H = this.body.height;
    const speed = Math.hypot(e.velocity.x, e.velocity.z);

    if (dt > 1e-5) {
      let dy = e.yaw - this._prevYaw;
      while (dy > Math.PI) dy -= TAU;
      while (dy < -Math.PI) dy += TAU;
      this._yawRate = damp(this._yawRate, dy / dt, 12, dt);
      this._accel = damp(this._accel, (speed - this._prevSpeed) / dt, 10, dt);
    }
    this._prevYaw = e.yaw;
    this._prevSpeed = speed;

    const model = this.model;
    model.position.set(0, 0, 0);
    model.quaternion.identity();

    if (!e.alive) {
      this._death(e);
      return;
    }

    // --- locomotion: phase from distance, so the body never skates -----------------
    // One cycle is two steps. The stride is a fraction of the height, longer for a body with
    // more `energy` and shorter for a heavier one, and the cadence is whatever makes the
    // product exactly the ground speed - the same rule the skinned enemies live by.
    const stride = H * R.strideFraction * (0.85 + 0.3 * S.energy) / Math.sqrt(S.weight) * this._cadenceScale;
    const cycle = stride * 2;
    let cadence;
    if (speed > R.idleSpeed) {
      cadence = speed / cycle;
    } else {
      // Standing still: a slow shift of weight rather than a freeze.
      cadence = R.idleCadence / S.weight;
    }
    this.phase = (this.phase + cadence * dt) % 1;
    this.debug.cadence = cadence;
    this.debug.stride = stride;
    this.debug.groundSpeed = speed;

    // A footfall every half cycle. Each one kicks the settle, which is what gives a walking
    // heavy its stomp: the body drops a little as the weight lands and eases back up.
    const step = Math.floor(this.phase * 2);
    if (step !== this._lastStep) {
      this._lastStep = step;
      if (speed > R.idleSpeed) this._settle = 1;
      this.debug.planted++;
    }
    this._settle *= Math.exp(-R.settleRate * dt / S.weight);

    const moving = clamp(speed / Math.max(0.1, this.type.chaseSpeed), 0, 1);
    const ph = this.phase * TAU;
    // Roll: side to side, once per cycle - the weight shifting between the two feet.
    const roll = Math.sin(ph) * R.roll * S.energy * this._rollBias * lerp(0.35, 1, moving);
    // Bob: up on each mid-swing, down on each footfall - twice per cycle.
    const bob = (0.5 - 0.5 * Math.cos(2 * ph)) * R.bob * H * lerp(0.25, 1, moving)
      - this._settle * R.settleDrop * H;
    // Yaw wag: the front end swings a little against the roll, a quarter cycle behind.
    const wag = Math.sin(ph - Math.PI / 2) * R.wag * S.energy * moving;
    // Lean: forward with speed and with acceleration, back when braking; heavier bodies
    // commit harder and answer later.
    const leanTarget = (moving * R.lean + clamp(this._accel * R.leanAccel, -R.lean, R.lean))
      * (0.6 + 0.4 * S.weight);
    this._lean = damp(this._lean, leanTarget, 6 / S.weight, dt);
    // Bank into a turn.
    const bank = clamp(-this._yawRate * R.bank * moving, -R.bank, R.bank);

    // --- breathing ---------------------------------------------------------------
    this.breathPhase = (this.breathPhase + dt * R.breathRate * S.breath) % 1;
    const breath = Math.sin(this.breathPhase * TAU) * R.breath * H;

    // --- stagger: a damped spring kicked by hits, leaning the body back -------------
    const C = ANIM.stagger;
    const k = C.stiffness * R.staggerStiffness, c = C.damping;
    const a = -k * this._stagX - c * this._stagV;
    this._stagV += a * dt;
    this._stagX += this._stagV * dt;
    const stag = this._stagX;

    // --- attack: rear back over the windup, lunge through the active window ---------
    let pitchAtk = 0, lungeZ = 0, riseY = 0;
    const T = this.type;
    if (e.state === EnemyState.ATTACK_WINDUP) {
      const t = minJerk(e.stateTime / Math.max(1e-3, T.attackWindup));
      pitchAtk = -R.attack.rear * t;
      riseY = R.attack.rise * H * t;
      lungeZ = -R.attack.rearShift * H * t;
    } else if (e.state === EnemyState.ATTACK_ACTIVE) {
      const t = minJerk(e.stateTime / Math.max(1e-3, T.attackActive));
      pitchAtk = lerp(-R.attack.rear, R.attack.lunge, t);
      riseY = R.attack.rise * H * (1 - t);
      lungeZ = lerp(-R.attack.rearShift, R.attack.reach, t) * H;
    } else if (e.state === EnemyState.ATTACK_RECOVER) {
      const t = minJerk(e.stateTime / Math.max(1e-3, T.attackRecovery));
      pitchAtk = R.attack.lunge * (1 - t);
      lungeZ = R.attack.reach * H * (1 - t);
    }

    // --- compose -------------------------------------------------------------------
    // Rotation order ZXY: bank/roll about the forward axis, then pitch, then the wag, so
    // the pitch is always the body's own nod regardless of how far it has rolled.
    _e.set(
      this._lean + pitchAtk + stag * R.staggerLean,
      wag,
      roll + bank,
      'ZXY');
    model.quaternion.setFromEuler(_e);
    model.position.set(0, bob + breath + riseY, lungeZ + stag * R.staggerShove * H);

    // The pivot of every rotation is the model origin, which sits between the feet on the
    // floor. A pitch about the feet lifts the far edge of the body rather than sinking the
    // near one, so nothing here can push the mesh through the floor.
  }

  /** Called by EnemySystem when damage lands. Kicks the stagger spring. */
  kickStagger(strength = 1) {
    this._stagV -= ANIM.stagger.impulse * strength / this.style.weight;
  }

  /** Records which way the killing shot came from, so the topple falls away from it. */
  setDeathDirection(angle) { this._deathTilt = angle; }

  /**
   * Death: a topple, pivoting at the feet, in the direction the killing shot travelled. The
   * skinned enemies collapse at the knees; a body with no knees falls like a felled tree and
   * that is the honest read for something this size. A small settle at the end, then the
   * same sink the enemies do, unless the dissolve is burning the body where it lies.
   */
  _death(e) {
    const D = ANIM.death;
    const R = this.R.death;
    const H = this.body.height;
    const k = clamp(e.deathTime / R.fallTime, 0, 1);
    // A felled body accelerates: ease in slowly, arrive hard.
    const fall = k * k * (3 - 2 * k) * (0.6 + 0.4 * k);
    const angle = fall * R.topple;
    // Bounce: a short rebound after the impact, decaying.
    const after = Math.max(0, e.deathTime - R.fallTime);
    const bounce = after > 0 ? Math.sin(after * TAU * R.bounceRate) * Math.exp(-after * 6) * R.bounce : 0;

    // Fall direction in the body's own frame (the root carries the yaw).
    const a = this._deathTilt - e.yaw;
    _axis.set(Math.cos(a), 0, -Math.sin(a));
    _q.setFromAxisAngle(_axis, angle + bounce);
    this.model.quaternion.copy(_q);
    // Pivoting at the origin between the feet keeps the base on the floor; the small
    // downward drift is the body settling into the ground as the fall completes.
    this.model.position.set(0, -fall * R.sink * H, 0);

    const sinkStart = this.type.corpseLinger - D.sinkTime;
    if (!e.dissolve && e.deathTime > sinkStart) {
      const s = clamp((e.deathTime - sinkStart) / D.sinkTime, 0, 1);
      // Lying down, the body's thickness is its depth, not its height: sink by that.
      this.model.position.y -= s * Math.max(this.body.halfDepth * 2, H * 0.5) * D.sinkFraction;
    }
  }
}
