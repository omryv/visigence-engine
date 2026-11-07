// Splash: the moment something meets the water — the player wading in, a
// block dropped into the bay — an expanding ripple ring and a short burst of
// droplets at the waterline. Small, pooled, CPU-animated (a splash lives
// under a second and there are at most a handful alive; per-frame math on
// eight rings costs nothing).
//
// The lasting half of the effect is not here: whatever went under is now
// below the waterline, and the shared material patch in render/atmosphere.js
// keeps it dark and glossy — the splash announces the wetting, the material
// stays wet.

import * as THREE from "three";
import { instancedBufferAttribute } from "three/tsl";

const POOL = 8;
const LIFE = 1.1;         // seconds
const DROPS_PER = 22;

export class SplashFX {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = "fx:splash";
    this._live = [];
    this._free = [];
    this._ringGeo = new THREE.RingGeometry(0.82, 1.0, 40).rotateX(-Math.PI / 2);
    for (let i = 0; i < POOL; i++) {
      const ring = new THREE.Mesh(this._ringGeo, new THREE.MeshBasicMaterial({
        color: 0xdff4f0, transparent: true, opacity: 0, depthWrite: false,
      }));
      ring.visible = false;
      // World-sized droplets: an instanced sprite per drop (WebGPU draws a
      // point one pixel wide), sized and attenuated exactly as PointsMaterial
      // sized a point.
      const dropPos = new THREE.InstancedBufferAttribute(new Float32Array(DROPS_PER * 3), 3);
      const dropMat = new THREE.PointsNodeMaterial({
        color: 0xeaf6f4, size: 0.16, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true,
      });
      dropMat.positionNode = instancedBufferAttribute(dropPos);
      const drops = new THREE.Sprite(dropMat);
      drops.count = DROPS_PER;
      drops.userData.position = dropPos;
      drops.visible = false;
      drops.frustumCulled = false;
      this.group.add(ring, drops);
      this._free.push({ ring, drops, vel: new Float32Array(DROPS_PER * 3), t: 0, r: 1 });
    }
  }

  // One splash at (x, waterY, z). strength ≈ 1 for a player, scaled up for
  // bigger things; it sizes the ring and throws the droplets harder.
  splashAt(x, waterY, z, strength = 1) {
    const s = this._free.pop() || this._live.shift(); // steal the oldest if the pool is dry
    if (!s) return;
    s.t = 0;
    s.r = 1.3 * strength;
    s.ring.position.set(x, waterY + 0.06, z);
    s.ring.scale.setScalar(0.3);
    s.ring.material.opacity = 0.85;
    s.ring.visible = true;
    const pos = s.drops.userData.position.array;
    for (let i = 0; i < DROPS_PER; i++) {
      const a = Math.random() * Math.PI * 2, r0 = Math.random() * 0.3 * strength;
      pos[i * 3] = x + Math.cos(a) * r0;
      pos[i * 3 + 1] = waterY + 0.05;
      pos[i * 3 + 2] = z + Math.sin(a) * r0;
      const up = (2.2 + Math.random() * 2.6) * strength;
      const out = (0.6 + Math.random() * 1.6) * strength;
      s.vel[i * 3] = Math.cos(a) * out;
      s.vel[i * 3 + 1] = up;
      s.vel[i * 3 + 2] = Math.sin(a) * out;
    }
    s.drops.userData.position.needsUpdate = true;
    s.drops.material.opacity = 0.9;
    s.drops.visible = true;
    this._live.push(s);
  }

  // Returns true while any splash is alive.
  tick(dt) {
    if (!this._live.length) return false;
    for (let n = this._live.length - 1; n >= 0; n--) {
      const s = this._live[n];
      s.t += dt;
      const k = s.t / LIFE;
      if (k >= 1) {
        s.ring.visible = s.drops.visible = false;
        this._live.splice(n, 1);
        this._free.push(s);
        continue;
      }
      s.ring.scale.setScalar(0.3 + k * 4.2 * s.r);
      s.ring.material.opacity = 0.85 * (1 - k) * (1 - k);
      const pos = s.drops.userData.position.array;
      for (let i = 0; i < DROPS_PER; i++) {
        pos[i * 3] += s.vel[i * 3] * dt;
        s.vel[i * 3 + 1] -= 9.8 * dt;
        pos[i * 3 + 1] += s.vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += s.vel[i * 3 + 2] * dt;
      }
      s.drops.userData.position.needsUpdate = true;
      s.drops.material.opacity = 0.9 * (1 - k);
    }
    return true;
  }

  dispose() {
    this._ringGeo.dispose();
    for (const s of [...this._live, ...this._free]) {
      s.ring.material.dispose();
      s.drops.material.dispose();   // the sprite's quad is three's, shared by every sprite
    }
  }
}
