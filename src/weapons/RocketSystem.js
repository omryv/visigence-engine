/** Impact rockets. One bounded pool, advanced only by Game's fixed simulation step. */
import { Group, Mesh, SphereGeometry, TorusGeometry, MeshBasicMaterial, Vector3, AdditiveBlending } from 'three/webgpu';
import { WEAPONS } from '../config/gameplay.js';
import { traceShot, makeHit, HIT_KIND } from './WeaponRaycaster.js';

const def = WEAPONS.rpg;
const Z = new Vector3(0, 0, 1);
const radial = new Vector3();

export class RocketSystem {
  constructor({ scene, collision, vfx, audio, onExplode }) {
    Object.assign(this, { collision, vfx, audio, onExplode });
    this.root = new Group();
    this.root.name = 'Rockets';
    this.geometry = new SphereGeometry(1, 12, 8);
    this.waveGeometry = new TorusGeometry(1, .045, 6, 48);
    this.material = new MeshBasicMaterial({ color: 0xc3efff, transparent: true, opacity: .85,
      blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.waveMaterial = new MeshBasicMaterial({ color: 0x269fff, transparent: true, opacity: .65,
      blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.hit = makeHit();
    this.pool = Array.from({ length: def.projectile.poolSize }, () => {
      const obj = new Group();
      const core = new Mesh(this.geometry, this.material);
      core.scale.set(.09, .09, .65); obj.add(core);
      const wave = new Mesh(this.waveGeometry, this.waveMaterial); obj.add(wave);
      const wake = new Mesh(this.waveGeometry, this.waveMaterial); wake.position.z = -.5; obj.add(wake);
      obj.visible = false;
      this.root.add(obj);
      return { obj, wave, wake, age: 0, pos: new Vector3(), dir: new Vector3(), left: 0, live: false, smoke: 0 };
    });
    // Independent bounded slots allow a close impact and muzzle wave in the same frame.
    this.blasts = Array.from({ length: 12 }, () => {
      const material = this.waveMaterial.clone();
      const root = new Group(); root.visible = false; this.root.add(root);
      const rings = Array.from({ length: 3 }, () => {
        const mesh = new Mesh(this.waveGeometry, material); root.add(mesh); return mesh;
      });
      const core = new Mesh(this.geometry, material); root.add(core);
      return { root, rings, core, material, age: 0, duration: 0, size: 0 };
    });
    scene.add(this.root);
    this.disposed = false;
  }

  get canLaunch() { return !this.disposed && this.pool.some(r => !r.live); }

  launch(origin, direction) {
    if (this.disposed) return false;
    const r = this.pool.find(r => !r.live);
    if (!r) return false;
    r.pos.copy(origin);
    r.dir.copy(direction).normalize();
    r.left = def.range;
    r.smoke = 0;
    r.age = 0;
    r.wave.scale.setScalar(.1); r.wake.scale.setScalar(.072);
    r.live = true;
    r.obj.position.copy(r.pos);
    r.obj.quaternion.setFromUnitVectors(Z, r.dir);
    r.obj.visible = true;
    return true;
  }

  fixedUpdate(dt, enemies) {
    for (const b of this.blasts) {
      if (!b.root.visible) continue;
      b.age += dt;
      const k = Math.min(1, b.age / b.duration);
      b.root.visible = k < 1;
      b.material.opacity = .75 * (1 - k) ** 2;
      b.rings.forEach((ring, i) => {
        const radius = .08 + b.size * Math.max(0, k - i * .075) ** .65;
        ring.scale.setScalar(radius); ring.position.z = (i - 1) * k * .35;
      });
      b.core.scale.set(b.size * (.08 + k * .5), b.size * (.08 + k * .5), .06 + k * .16);
    }
    for (const r of this.pool) {
      if (!r.live) continue;
      r.age += dt;
      const size = Math.min(.65, .10 + r.age * 2.8);
      r.wave.scale.setScalar(size);
      r.wake.scale.setScalar(size * .72);
      const distance = Math.min(r.left, def.projectile.speed * dt);
      traceShot(this.collision, enemies, r.pos, r.dir, distance, this.hit, 0);
      if (this.hit.kind !== HIT_KIND.NONE) {
        // Keep the blast just outside the surface for the shared line-of-sight test.
        r.pos.set(this.hit.x, this.hit.y, this.hit.z).addScaledVector(r.dir, -0.025);
        r.pos.y = Math.max((this.collision.terrain?.heightAt(r.pos.x, r.pos.z) ?? 0) + 0.025, r.pos.y);
        r.live = false;
        r.obj.visible = false;
        this.energyBlast(r.pos, r.dir, true);
        this.audio?.playOneShot('rpgImpact', { position: r.pos });
        this.onExplode?.(r.pos, def.projectile.radius, def.damage);
        continue;
      }
      r.pos.addScaledVector(r.dir, distance);
      r.left -= distance;
      r.obj.position.copy(r.pos);
      if (r.left <= 0) { r.live = false; r.obj.visible = false; continue; }
      r.smoke += dt;
      if (r.smoke >= 0.05) {
        r.smoke %= 0.05;
        this.vfx.smoke.spawn(r.pos.x, r.pos.y, r.pos.z, 0, 0.15, 0,
          0.55, 0.18, 0.22, 0.43, 0.65);
      }
    }
  }

  energyBlast(position, direction, impact) {
    if (this.disposed) return;
    const b = this.blasts.find(b => !b.root.visible) || this.blasts.reduce((a, b) => a.age > b.age ? a : b);
    b.age = 0; b.duration = impact ? .7 : .32; b.size = impact ? 2.8 : .7;
    b.root.position.copy(position); b.root.quaternion.setFromUnitVectors(Z, direction);
    b.root.visible = true; b.material.opacity = .75;
    for (const ring of b.rings) { ring.scale.setScalar(.08); ring.position.z = 0; }
    b.core.scale.setScalar(.08);
    this.vfx.pulseLight(position.x, position.y, position.z, 0x369fff, impact ? 7 : 3, .18, impact ? 8 : 3);
    const count = impact ? 24 : 9;
    for (let i = 0; i < count; i++) {
      const a = i * 2.39996;
      const speed = impact ? 1.5 : .6;
      radial.set(Math.cos(a), Math.sin(a), impact ? -.25 : .6).applyQuaternion(b.root.quaternion);
      this.vfx.smoke.spawn(position.x, position.y, position.z,
        radial.x * speed, radial.y * speed + .4, radial.z * speed,
        impact ? 1.1 : .6, impact ? .32 : .10, .22, .40, .59);
    }
  }

  reset() {
    for (const r of this.pool) { r.live = false; r.obj.visible = false; r.left = 0; r.smoke = 0; }
    for (const b of this.blasts) b.root.visible = false;
  }

  dispose() {
    if (this.disposed) return;
    this.reset();
    this.root.removeFromParent();
    // These are owned by this pool; GLB materials/textures remain owned by AssetLoader.
    this.geometry.dispose();
    this.material.dispose();
    this.waveGeometry.dispose(); this.waveMaterial.dispose();
    for (const b of this.blasts) b.material.dispose();
    this.disposed = true;
  }
}
