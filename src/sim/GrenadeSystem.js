/**
 * Grenades: held preview, throw arc, swept collision, bounce, fuse, radial damage.
 *
 * Projectiles are pooled - GRENADE.poolSize instances of the GLB are cloned once and
 * recycled, so throwing never allocates. Collision is SWEPT (the step is subdivided so
 * no sub-step exceeds a fraction of a grid cell) which is what stops a 15 m/s grenade
 * tunnelling through a 0.18 m cell wall.
 */

import { Box3, Group, Vector3, MathUtils } from 'three/webgpu';
import { GRENADE } from '../config/gameplay.js';
import { GRENADE_RIG } from '../config/assets.js';
import { grenadeStartCount } from '../core/Economy.js';

const _v = new Vector3();

export const ThrowState = { IDLE: 'IDLE', WINDUP: 'WINDUP', RELEASE: 'RELEASE', RECOVER: 'RECOVER' };

export class GrenadeSystem {
  constructor({ camera, collision, vfx, player, audio, onExplode }) {
    this.camera = camera;
    this.collision = collision;
    this.vfx = vfx;
    this.player = player;
    this.audio = audio;
    this.onExplode = onExplode;

    this.count = grenadeStartCount();
    this.state = ThrowState.IDLE;
    this.stateTime = 0;
    this.queued = false;

    this.root = new Group();
    this.root.name = 'Grenades';

    /** The grenade held in the off hand during the throw animation. */
    this.heldRoot = new Group();
    this.heldRoot.name = 'HeldGrenade';
    this.heldRoot.visible = false;
    camera.add(this.heldRoot);

    /** @type {{obj: Group, pos: Vector3, vel: Vector3, fuse: number, live: boolean, spin: Vector3}[]} */
    this.pool = [];
  }

  /**
   * @param {import('../core/AssetLoader.js').AssetLoader} assets
   * The pack's grenade model is sized from its own bounds (standing on its origin) to GRENADE_RIG.targetHeight.
   */
  build(assets, scene, viewmodelCamera = this.camera) {
    viewmodelCamera.add(this.heldRoot);
    const src = assets.get('grenade').gltf.scene;
    const height = new Box3().setFromObject(src).getSize(new Vector3()).y;
    const scale = GRENADE_RIG.targetHeight / (height > 0 ? height : 1);

    // Held preview: a clone parented to the camera, posed in the off hand.
    const held = src.clone(true);
    held.scale.setScalar(scale * 1.05);
    held.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; o.renderOrder = 10; } });
    this.heldRoot.add(held);
    this.held = held;

    // Projectile pool.
    for (let i = 0; i < GRENADE.poolSize; i++) {
      const g = new Group();
      const m = src.clone(true);
      m.scale.setScalar(scale);
      m.position.y = -GRENADE_RIG.targetHeight * 0.5;   // centre the model on the origin
      m.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      g.add(m);
      g.visible = false;
      this.root.add(g);
      this.pool.push({
        obj: g, pos: new Vector3(), vel: new Vector3(),
        fuse: 0, live: false, spin: new Vector3(), rest: 0,
      });
    }
    scene.add(this.root);
  }

  /** Queue a throw. Ignored while one is already in flight through the animation. */
  throwGrenade() {
    if (this.count <= 0) return false;
    if (this.state !== ThrowState.IDLE) { this.queued = true; return false; }
    this.state = ThrowState.WINDUP;
    this.stateTime = 0;
    this.heldRoot.visible = true;
    this.audio?.play('grenadeThrow', null, 0.5);
    return true;
  }

  addGrenades(n) {
    const before = this.count;
    this.count = Math.min(GRENADE.maxCount, this.count + n);
    return this.count - before;
  }

  reset() {
    this.count = grenadeStartCount();
    this.state = ThrowState.IDLE;
    this.stateTime = 0;
    this.queued = false;
    this.heldRoot.visible = false;
    this.throwPose = null;
    for (const g of this.pool) { g.live = false; g.obj.visible = false; }
  }

  get liveCount() {
    let n = 0;
    for (const g of this.pool) if (g.live) n++;
    return n;
  }

  fixedUpdate(dt) {
    this._updateThrowState(dt);
    this._updateProjectiles(dt);
  }

  _updateThrowState(dt) {
    if (this.state === ThrowState.IDLE) {
      if (this.queued && this.count > 0) { this.queued = false; this.throwGrenade(); }
      return;
    }
    this.stateTime += dt;
    if (this.state === ThrowState.WINDUP && this.stateTime >= GRENADE.throwWindup) {
      this._release();
      this.state = ThrowState.RECOVER;
      this.stateTime = 0;
    } else if (this.state === ThrowState.RECOVER && this.stateTime >= GRENADE.throwRecovery) {
      this.state = ThrowState.IDLE;
      this.stateTime = 0;
      this.heldRoot.visible = false;
    }
  }

  _release() {
    if (this.count <= 0) return;
    const slot = this.pool.find((g) => !g.live);
    if (!slot) return;               // pool exhausted; the throw is simply not spent
    this.count--;

    const eye = this.player.eyePosition;
    const aim = this.player.aimDirection(_v.clone());
    // Start slightly ahead of the eye so it never spawns inside the player's own capsule.
    slot.pos.set(
      eye.x + aim.x * 0.45,
      eye.y + aim.y * 0.45 - 0.12,
      eye.z + aim.z * 0.45
    );
    slot.vel.copy(aim).multiplyScalar(GRENADE.throwSpeed);
    slot.vel.y += GRENADE.throwLift * GRENADE.throwSpeed;
    // Inherit the player's motion so throwing while sprinting feels right.
    slot.vel.x += this.player.velocity.x * 0.55;
    slot.vel.z += this.player.velocity.z * 0.55;
    slot.fuse = GRENADE.fuse;
    slot.live = true;
    slot.rest = 0;
    slot.spin.set(9.2, 5.4, 7.1);
    slot.obj.visible = true;
    slot.obj.position.copy(slot.pos);
  }

  _updateProjectiles(dt) {
    for (const g of this.pool) {
      if (!g.live) continue;
      g.fuse -= dt;
      if (g.fuse <= 0) { this._explode(g); continue; }

      g.vel.y += GRENADE.gravity * dt;

      // --- swept integration ---
      const speed = g.vel.length();
      const steps = Math.max(1, Math.ceil((speed * dt) / (this.collision.cell * 0.45)));
      const h = dt / steps;
      for (let s = 0; s < steps; s++) {
        const nx = g.pos.x + g.vel.x * h;
        let ny = g.pos.y + g.vel.y * h;
        const nz = g.pos.z + g.vel.z * h;

        if(this.collision.isProjectileFree && !this.collision.isProjectileFree(g.pos.x,ny,g.pos.z,GRENADE.radius)){
          ny=g.pos.y;g.vel.y=-g.vel.y*GRENADE.restitution;
          if(Math.abs(g.vel.y)>.5)this.audio?.play('grenadeBounce',g.pos,.25);
        }

        // Ground follows the same baked height field as the player, including below sea level.
        const floorY = (this.collision.terrain?.heightAt(nx, nz) ?? 0) + GRENADE.radius;
        if (ny <= floorY) {
          g.pos.y = floorY;
          if (Math.abs(g.vel.y) > 0.8) {
            g.vel.y = -g.vel.y * GRENADE.restitution;
            this.audio?.play('grenadeBounce', g.pos, 0.35);
          } else {
            g.vel.y = 0;
            g.rest += h;
          }
          g.vel.x *= GRENADE.friction;
          g.vel.z *= GRENADE.friction;
        } else {
          g.pos.y = ny;
        }

        // walls: test each axis so a corner hit reflects sensibly
        const rr = GRENADE.radius;
        const freeX = this.collision.isProjectileFree ? this.collision.isProjectileFree(nx,g.pos.y,g.pos.z,rr) : this.collision.isFree(nx,g.pos.z,rr);
        const freeZ = this.collision.isProjectileFree ? this.collision.isProjectileFree(g.pos.x,g.pos.y,nz,rr) : this.collision.isFree(g.pos.x,nz,rr);
        if (freeX) g.pos.x = nx;
        else if (Math.abs(g.vel.x) > 0.5) {
          g.vel.x = -g.vel.x * GRENADE.restitution;
          g.vel.z *= 0.9;
          this.audio?.play('grenadeBounce', g.pos, 0.3);
        } else g.vel.x = 0;

        if (freeZ) g.pos.z = nz;
        else if (Math.abs(g.vel.z) > 0.5) {
          g.vel.z = -g.vel.z * GRENADE.restitution;
          g.vel.x *= 0.9;
          this.audio?.play('grenadeBounce', g.pos, 0.3);
        } else g.vel.z = 0;

        // If it somehow ended up inside geometry, push it out rather than let it stick.
        if (!(this.collision.isProjectileFree ? this.collision.isProjectileFree(g.pos.x,g.pos.y,g.pos.z,rr) : this.collision.isFree(g.pos.x,g.pos.z,rr))) {
          const safe = this.collision.findNearestFree(g.pos.x, g.pos.z, rr, 6);
          if (safe) { g.pos.x = safe.x; g.pos.z = safe.z; g.vel.multiplyScalar(0.3); }
        }
      }

      g.obj.position.copy(g.pos);
      // Spin slows as it comes to rest, so a settled grenade does not keep tumbling.
      const spinScale = MathUtils.clamp(g.vel.length() / 6, 0, 1);
      g.obj.rotation.x += g.spin.x * dt * spinScale;
      g.obj.rotation.y += g.spin.y * dt * spinScale;
      g.obj.rotation.z += g.spin.z * dt * spinScale;

      // Warning: the fuse light pulses faster as it runs out.
      if (g.fuse < 1.4) {
        const rate = 3 + (1.4 - g.fuse) * 14;
        if (Math.floor(g.fuse * rate) !== Math.floor((g.fuse + dt) * rate)) {
          this.vfx.pulseLight(g.pos.x, g.pos.y + 0.1, g.pos.z, 0xFF4422, 3.2, 0.09, 4.5);
          this.audio?.play('grenadeBeep', g.pos, 0.3);
        }
      }
    }
  }

  /**
   * THE EXPLOSION, and the only place its sound is played.
   *
   * One committed event: `live` is cleared on the first line, so a grenade cannot explode
   * twice, and the sound is here rather than in the damage loop or the VFX - one grenade
   * that catches ten enemies is one explosion and one sound, not ten. It is positional at
   * the blast, and it is a one-shot rather than an action voice precisely because it
   * cannot be cancelled: once it has gone off it is allowed to ring out (the only thing
   * that cuts it is a full teardown).
   */
  _explode(g) {
    g.live = false;
    g.obj.visible = false;
    this.vfx.explosion(g.pos.x, g.pos.y, g.pos.z, GRENADE.damageRadius);
    this.audio?.playOneShot('grenadeExploded', { position: g.pos });
    this.onExplode?.(g.pos, GRENADE.damageRadius, GRENADE.maxDamage);
  }

  /**
   * Radial damage with distance falloff, applied through a line-of-sight test so a
   * grenade round a corner does not damage through the wall.
   */
  static radialDamage(pos, radius, maxDamage, collision, targets, apply) {
    if (!(radius > 0) || !Number.isFinite(radius)) return;
    for (const t of targets) {
      if (!t.alive) continue;
      const cx = t.position.x, cy = t.position.y + (t.type?.height ?? 1.7) * 0.5, cz = t.position.z;
      const d = Math.hypot(cx - pos.x, cy - pos.y, cz - pos.z);
      if (d > radius) continue;
      if (!collision.hasLineOfSight(pos.x, pos.z, cx, cz)) continue;
      const k = Math.pow(1 - d / radius, GRENADE.falloffPower);
      apply(t, maxDamage * k, k);
    }
  }

  /**
   * Throw-animation pose for the held grenade. Composed like the weapon rig.
   *
   * The pose is also published as `throwPose` (camera space) so the weapon system can
   * take the support hand off the gun and send it with the grenade - which is what turns
   * a floating grenade into a thrown one.
   */
  updateVisuals(dt) {
    if (this.state === ThrowState.IDLE) {
      this.heldRoot.visible = false;
      this.throwPose = null;
      return;
    }
    this.heldRoot.visible = true;
    /**
     * Pushed out from z = -0.36 to -0.46 (and the wind-up's pull-back halved) for the
     * hands pass. The support hand goes wherever the grenade goes, and its forearm runs
     * BACK toward the eye - at 0.27 m the whole arm fell behind the near plane and all
     * that reached the frame was a knuckle at the bottom edge. Held further out, the
     * hand and most of the forearm are in shot, which is the point of attaching one.
     */
    let px = -0.24, py = -0.19, pz = -0.46;
    let rx = 0, ry = 0, rz = 0;

    if (this.state === ThrowState.WINDUP) {
      const k = MathUtils.clamp(this.stateTime / GRENADE.throwWindup, 0, 1);
      const e = easeInCubic(k);
      // Pull back and up over the shoulder.
      px += -0.08 * e;
      py += 0.24 * e;
      pz += 0.12 * e;
      rx += -1.5 * e;
      rz += 0.9 * e;
    } else {
      const k = MathUtils.clamp(this.stateTime / GRENADE.throwRecovery, 0, 1);
      const e = 1 - easeOutCubic(k);
      // Snap forward and fade out of frame.
      px += 0.18 * e;
      py += -0.30 * e;
      pz += -0.34 * e;
      rx += 2.2 * e;
      this.heldRoot.visible = k < 0.55;
    }
    this.heldRoot.position.set(px, py, pz);
    this.heldRoot.rotation.set(rx, ry, rz);
    this.held.rotation.y += dt * 2.2;

    /**
     * The support hand is released the moment the grenade LEAVES it, not when the throw
     * animation ends. The recovery hides the grenade at 55% and then spends the rest of
     * its 0.42 s carrying the arm back down - and the hand was following the pose for all
     * of it, so for a quarter of a second an empty open hand hung on its own in the
     * bottom-left of the frame with no grenade and no weapon anywhere near it. Cutting
     * the pose here hands the arm back to the weapon rig, which is where it belongs the
     * instant it is empty.
     */
    if (!this.heldRoot.visible) { this.throwPose = null; return; }

    // Published for the support hand. Reused object: this runs every render frame.
    this.throwPose = this._pose || (this._pose = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 });
    this._pose.px = px; this._pose.py = py; this._pose.pz = pz;
    this._pose.rx = rx; this._pose.ry = ry; this._pose.rz = rz;
  }

  dispose() {
    this.reset();
    this.heldRoot.removeFromParent();
    this.root.removeFromParent();
  }
}

function easeInCubic(x) { return x * x * x; }
function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
