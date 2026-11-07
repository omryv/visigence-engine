/**
 * All combat feedback, fully pooled.
 *
 * Everything here is allocated once at construction and recycled: particle sprites,
 * impact decals, muzzle flashes, explosion lights. Nothing new is created while firing,
 * which is what keeps sustained combat free of allocation spikes.
 *
 * Particles are drawn as one instanced quad cloud per category with a shared material, so
 * an explosion costs one draw call rather than one per spark.
 */

import {
  Group,
  Mesh, PlaneGeometry, SphereGeometry, MeshBasicMaterial, MeshStandardMaterial,
  AdditiveBlending, NormalBlending, DoubleSide, PointLight, Color, Vector3, Sprite, SpriteMaterial,
  CanvasTexture, SRGBColorSpace, CustomBlending, AddEquation, SrcAlphaFactor, OneFactor, ZeroFactor,
} from 'three/webgpu';
import { particleSprites } from './ParticleSprites.js';
import { SURFACE_RESPONSE } from './EnvironmentProps.js';
import { excludeFromEnvironment } from './Environment.js';

/** Soft round sprite used by every particle system, generated once. */
function makeSoftDot(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/**
 * The muzzle flare sprite.
 *
 * A muzzle flash photographs as three things at once: a blown core, a short unburnt-powder
 * corona around it, and spikes thrown by the compensator ports. The first pass drew the
 * core and a two-line cross, which gives a symmetric four-point star - and a symmetric
 * star is the one shape that reads as a lens artefact rather than as burning gas.
 *
 * So the spikes are now EIGHT, at uneven angles and uneven lengths, tapered from the core
 * outwards; the core is tighter and hotter; and a faint corona ring sits between them,
 * which is what stops the spikes from looking like they are floating unattached.
 * Everything is drawn white - SpriteMaterial.color carries the per-weapon tint, so the
 * texture must stay neutral or the two multiply into mud.
 */
function makeFlare(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const mid = size / 2;

  // Core: blown white centre falling off fast, then a long dim tail so the sprite has no
  // visible edge when it is scaled up over its lifetime.
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.10, 'rgba(255,255,255,0.96)');
  grad.addColorStop(0.24, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.52, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(mid, mid, mid, 0, Math.PI * 2); g.fill();

  g.globalCompositeOperation = 'lighter';

  // The corona: unburnt powder, a soft annulus just outside the core.
  const ring = g.createRadialGradient(mid, mid, size * 0.16, mid, mid, size * 0.34);
  ring.addColorStop(0, 'rgba(255,255,255,0)');
  ring.addColorStop(0.45, 'rgba(255,255,255,0.16)');
  ring.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = ring;
  g.beginPath(); g.arc(mid, mid, size * 0.34, 0, Math.PI * 2); g.fill();

  // Port spikes. Uneven on purpose - the angles are not a multiple of anything, and the
  // lengths repeat on a 3-cycle, so no two adjacent spikes match.
  const SPIKES = [0.06, 0.72, 1.28, 2.05, 2.71, 3.42, 4.55, 5.31];
  for (let i = 0; i < SPIKES.length; i++) {
    const a = SPIKES[i];
    const len = mid * (i % 3 === 0 ? 0.94 : i % 3 === 1 ? 0.62 : 0.44);
    const streak = g.createLinearGradient(mid, mid, mid + Math.cos(a) * len, mid + Math.sin(a) * len);
    streak.addColorStop(0, 'rgba(255,255,255,0.62)');
    streak.addColorStop(0.35, 'rgba(255,255,255,0.22)');
    streak.addColorStop(1, 'rgba(255,255,255,0)');
    g.strokeStyle = streak;
    // Tapered by drawing thin: a spike is a highlight, not a bar.
    g.lineWidth = size * (i % 3 === 0 ? 0.028 : 0.018);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(mid, mid);
    g.lineTo(mid + Math.cos(a) * len, mid + Math.sin(a) * len);
    g.stroke();
  }

  const t = new CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/**
 * The bullet impact mark.
 *
 * Decals were drawn with the same soft dot the particles use, tinted almost black: at any
 * range that is a fuzzy grey smudge, and against a dark corridor wall it is nothing at
 * all. A real impact on concrete has three concentric parts, and all three are what make
 * it read as damage rather than as dirt:
 *
 *   - a small, nearly black PUNCTURE, hard-edged, well under half the mark's width;
 *   - a CHAR ring around it, softer;
 *   - a pale DUST halo of pulverised material, which is the part that carries the mark on
 *     a dark surface - it is brighter than the wall rather than darker.
 *
 * Value is baked into the texture's RGB and coverage into its alpha, so the material's
 * colour is the dust colour and the puncture is that colour multiplied down to black. That
 * is what buys a mark that stays legible in an unlit corridor AND in a lit pool, from one
 * texture and one draw.
 */
function makeImpactMark(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const mid = size / 2;

  // Dust halo first, widest and faintest; near-white RGB so the material colour survives.
  const dust = g.createRadialGradient(mid, mid, size * 0.16, mid, mid, mid);
  dust.addColorStop(0, 'rgba(236,228,214,0.34)');
  dust.addColorStop(0.42, 'rgba(226,214,196,0.22)');
  dust.addColorStop(0.78, 'rgba(214,200,182,0.06)');
  dust.addColorStop(1, 'rgba(214,200,182,0)');
  g.fillStyle = dust;
  g.beginPath(); g.arc(mid, mid, mid, 0, Math.PI * 2); g.fill();

  // Spall: short streaks of dust thrown radially, so the halo is not a perfect circle.
  // Deterministic angles and lengths - a decal must look the same on a replayed shot.
  const SPALL = [0.31, 0.95, 1.61, 2.44, 3.02, 3.88, 4.51, 5.24, 5.86];
  for (let i = 0; i < SPALL.length; i++) {
    const a = SPALL[i];
    const inner = size * 0.17;
    const outer = size * (0.30 + (i % 4) * 0.055);
    g.strokeStyle = `rgba(232,222,206,${0.16 - (i % 3) * 0.035})`;
    g.lineWidth = size * (0.020 + (i % 2) * 0.012);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(mid + Math.cos(a) * inner, mid + Math.sin(a) * inner);
    g.lineTo(mid + Math.cos(a) * outer, mid + Math.sin(a) * outer);
    g.stroke();
  }

  // Char ring: the burnt zone between puncture and dust.
  const char = g.createRadialGradient(mid, mid, size * 0.05, mid, mid, size * 0.24);
  char.addColorStop(0, 'rgba(46,34,26,0.92)');
  char.addColorStop(0.55, 'rgba(58,44,33,0.66)');
  char.addColorStop(1, 'rgba(70,54,41,0)');
  g.fillStyle = char;
  g.beginPath(); g.arc(mid, mid, size * 0.24, 0, Math.PI * 2); g.fill();

  // Puncture: the hole itself. Small, dark, and the only hard edge in the mark.
  const hole = g.createRadialGradient(mid, mid, 0, mid, mid, size * 0.105);
  hole.addColorStop(0, 'rgba(12,9,7,0.98)');
  hole.addColorStop(0.62, 'rgba(16,12,9,0.94)');
  hole.addColorStop(1, 'rgba(30,22,17,0.30)');
  g.fillStyle = hole;
  g.beginPath(); g.arc(mid, mid, size * 0.105, 0, Math.PI * 2); g.fill();

  const t = new CanvasTexture(c);
  /**
   * Tagged sRGB, unlike the two white sprites above. Those are pure white with the shape
   * carried entirely by alpha, so how their RGB is decoded cannot change what they look
   * like; this one has real colour in it - a near-black puncture, a brown char, a pale
   * dust - and if the canvas's sRGB bytes were read as linear the dark parts would come
   * out roughly seven times too bright and the mark would wash out to a flat smudge,
   * which is exactly what it is replacing.
   */
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * The blood mark: what an enemy hit leaves on the wall behind it and the floor under it.
 *
 * The particles the hit already throws are gone in half a second; this is the part of the
 * hit that stays, and it is the single strongest "this room has been fought in" signal a
 * corridor can carry. Painted as ichor rather than blood - the enemies bleed the teal the
 * particle system already uses (0.18, 0.62, 0.55) - so it reads as theirs.
 *
 * Three parts, like the impact mark: a dense irregular core, a scatter of droplets thrown
 * outward (denser on one side, so a roll picks a spray direction), and a few runs that
 * drip down from the core. The value is in RGB and the coverage in alpha, so the
 * material's colour can darken the whole mark as it dries.
 */
function makeBloodMark(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const mid = size / 2;
  // Deterministic scatter: the mark must be the same on every machine.
  let seed = 977;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  // Core: an irregular pool, darkest in the middle.
  g.beginPath();
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    const r = mid * (0.30 + Math.sin(a * 3 + 0.4) * 0.05 + Math.sin(a * 7 + 1.9) * 0.035 + Math.sin(a * 11) * 0.02);
    const x = mid + Math.cos(a) * r, y = mid + Math.sin(a) * r;
    if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  const core = g.createRadialGradient(mid, mid, 0, mid, mid, mid * 0.36);
  // Dark: it is lit by the corridor like everything else, and a wet pool is mostly the
  // reflection of the fixture above it, not its own colour. A bright teal here read as
  // luminous paint under the amber lights.
  core.addColorStop(0, 'rgba(8,34,30,0.97)');
  core.addColorStop(0.55, 'rgba(11,44,38,0.92)');
  core.addColorStop(1, 'rgba(18,62,52,0.55)');
  g.fillStyle = core;
  g.fill();

  // Droplets: thrown mostly toward +x (the spray direction the roll will aim).
  for (let i = 0; i < 90; i++) {
    const bias = rnd() < 0.7 ? 1 : -1;
    const a = (rnd() - 0.5) * (bias > 0 ? 1.6 : 3.0) + (bias > 0 ? 0 : Math.PI);
    const d = mid * (0.32 + rnd() * rnd() * 0.62);
    const x = mid + Math.cos(a) * d, y = mid + Math.sin(a) * d;
    const r = 1.2 + rnd() * rnd() * 7;
    g.fillStyle = `rgba(${10 + (rnd() * 10) | 0},${40 + (rnd() * 24) | 0},${34 + (rnd() * 18) | 0},${0.55 + rnd() * 0.4})`;
    g.beginPath();
    // Elongated away from the centre: a droplet that travelled.
    g.ellipse(x, y, r * (1 + rnd() * 1.6), r, a, 0, Math.PI * 2);
    g.fill();
  }

  // Runs: a few drips down from the core (canvas -y is "up" once flipped; drips go +y).
  for (let i = 0; i < 4; i++) {
    const x = mid + (rnd() - 0.5) * mid * 0.5;
    const len = mid * (0.3 + rnd() * 0.5);
    const w = 2 + rnd() * 4;
    const run = g.createLinearGradient(0, mid, 0, mid + len);
    run.addColorStop(0, 'rgba(11,44,38,0.85)');
    run.addColorStop(1, 'rgba(16,56,46,0)');
    g.fillStyle = run;
    g.fillRect(x - w / 2, mid, w, len);
    g.beginPath(); g.arc(x, mid + len * 0.92, w * 0.9, 0, Math.PI * 2); g.fill();
  }

  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * One pooled particle cloud: fixed capacity, dead particles are parked far off-screen
 * with zero size rather than removed, so the buffer layout never changes.
 */
class ParticlePool {
  constructor(capacity, { size, color, blending, gravity, drag, fadePower = 1 }) {
    this.capacity = capacity;
    this.gravity = gravity;
    this.drag = drag;
    this.fadePower = fadePower;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.sizeArr = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.colorArr = new Float32Array(capacity * 3);
    this.next = 0;
    this.alive = 0;

    this.points = particleSprites({ positions: this.pos, sizes: this.sizeArr, colors: this.colorArr,
      map: VFX.dotTexture, color: color ?? 0xffffff, blending, opacity: 1 });
    this.material = this.points.material;
    this.geo = this.points.geometry;
    // Park everything below the world so nothing shows before first use.
    for (let i = 0; i < capacity; i++) this.pos[i * 3 + 1] = -1000;
  }

  spawn(x, y, z, vx, vy, vz, life, size, r, g, b) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const p = i * 3;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.vel[p] = vx; this.vel[p + 1] = vy; this.vel[p + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.baseSize[i] = size; this.sizeArr[i] = size;
    this.colorArr[p] = r; this.colorArr[p + 1] = g; this.colorArr[p + 2] = b;
  }

  update(dt) {
    let alive = 0;
    const { pos, vel, life, maxLife, sizeArr, baseSize } = this;
    const damp = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.capacity; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const p = i * 3;
      if (life[i] <= 0) { sizeArr[i] = 0; pos[p + 1] = -1000; continue; }
      alive++;
      vel[p + 1] += this.gravity * dt;
      vel[p] *= damp; vel[p + 1] *= damp; vel[p + 2] *= damp;
      pos[p] += vel[p] * dt;
      pos[p + 1] += vel[p + 1] * dt;
      pos[p + 2] += vel[p + 2] * dt;
      const k = life[i] / maxLife[i];
      sizeArr[i] = baseSize[i] * Math.pow(k, this.fadePower);
    }
    this.alive = alive;
    this.geo.attributes.particlePosition.needsUpdate = true;
    this.geo.attributes.particleSize.needsUpdate = true;
    this.geo.attributes.particleColor.needsUpdate = true;
    this.points.visible = alive > 0;
  }

  clear() {
    this.life.fill(0);
    this.sizeArr.fill(0);
    for (let i = 0; i < this.capacity; i++) this.pos[i * 3 + 1] = -1000;
    this.alive = 0;
    this.geo.attributes.particlePosition.needsUpdate = true;
    this.geo.attributes.particleSize.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

/**
 * Spark colour per hit surface. Keyed by WeaponRaycaster's SURFACE classes, and deliberately
 * kept here rather than at the call site: this is the palette, and the weapon should not have
 * to know it. Anything unclassified falls back to concrete.
 */
const SURFACE_TINT = {
  concrete: 0xFFC98A,
  floor: 0xF3B173,
  wood: 0xE2A15C,
  metal: 0xFFE3B0,
  glass: 0xBFE9FF,
  enemy: 0x6BE3B8,
};

/** PlaneGeometry lies in XY with its front face along +Z, so this is a decal's own normal. */
const _PLANE_FORWARD = new Vector3(0, 0, 1);
const _decalNormal = new Vector3();

/**
 * How far a decal stands off the surface it is stamped on, in metres.
 *
 * Small on purpose, and it was 12 mm. A standoff is a lie that only holds up head-on: seen
 * from an angle the mark is displaced across the wall by `offset * tan(angle)`, which at 85
 * degrees turns 12 mm into 14 cm of apparent slide away from the hole the player shot. The
 * mark's transform never moved - the parallax of a plane floating in front of the wall did
 * it - which is exactly the kind of camera-dependent wrongness that looks like a decal
 * sliding around at grazing angles. At 2 mm the same 85 degrees is 2 cm.
 *
 * Depth fighting is handled by the material's polygonOffset rather than by distance, which
 * is what makes a standoff this small safe.
 */
const DECAL_OFFSET = 0.002;

export class VFX {
  static dotTexture = null;
  static flareTexture = null;
  static impactTexture = null;
  static bloodTexture = null;

  /**
   * @param {import('three/webgpu').Scene} scene
   * @param {object} [opts]
   * @param {number} [opts.particleScale]  Multiplier on every emitter's particle count.
   * @param {number} [opts.maxLights]      Live pooled-light budget for the current tier.
   * @param {number} [opts.lightCapacity]  Lights actually allocated; the budget can never
   *   exceed it, so it must cover the richest tier or an upgrade would be capped.
   * @param {number} [opts.decalCapacity]  Decals actually allocated (EFFECTS.maxBulletDecals).
   * @param {number} [opts.maxDecals]      Live decal budget for the current tier.
   * @param {number} [opts.decalLife]      Seconds a decal stays before it fades out.
   * @param {number} [opts.anisotropy]     Filtering for the impact mark, which is the one
   *   texture here that lies on a surface and is therefore sampled at grazing angles. The
   *   device's real ceiling, resolved by Game against the profile.
   * @param {import('../sim/CollisionSystem.js').CollisionSystem} [opts.collision]  For the
   *   blood marks, which have to find the wall behind a hit. Without it no marks are placed.
   * @param {number} [opts.bloodCapacity]  Blood marks in the pool; 0 disables them (the
   *   profiles below `standard`, and `?fx=-blood`).
   * @param {number} [opts.bloodLife]      Seconds a mark stays before it fades.
   */
  constructor(scene, {
    particleScale = 1, maxLights = 6, lightCapacity = 8,
    decalCapacity = 64, maxDecals = decalCapacity, decalLife = 9, anisotropy = 1,
    collision = null, bloodCapacity = 0, bloodLife = 75,
  } = {}) {
    VFX.dotTexture ||= makeSoftDot();
    VFX.flareTexture ||= makeFlare();
    VFX.impactTexture ||= makeImpactMark();
    /**
     * ANISOTROPY, AND WHY ONLY THIS TEXTURE GETS IT.
     *
     * The impact mark is the only texture in this file drawn on a quad that sits in the
     * world; the soft dot and the flare are on Points and Sprites, which always face the
     * camera and so are never sampled at a grazing angle. A decal on a wall is sampled at
     * every angle there is.
     *
     * With anisotropy 1 the mip level is chosen from the MOST compressed screen axis. Look
     * along a wall and the mark's horizontal axis is squeezed to nothing while its vertical
     * axis is not, so the whole texture is blurred by the horizontal amount - and that blur
     * is only compressed back to nothing in the horizontal. What is left is a mark smeared
     * up and down the wall: a round hole rendered as a long vertical streak that reappears
     * and disappears as the camera turns, with no transform behind it at all. Measured at
     * 85 degrees before this line existed; SurfaceTextures.js already sets anisotropy on the
     * wall and floor maps for the same reason.
     *
     * Taken as the maximum ever asked for, because the texture is a static shared by every
     * VFX instance, and re-uploaded because it may already be on the GPU.
     */
    if (anisotropy > VFX.impactTexture.anisotropy) {
      VFX.impactTexture.anisotropy = anisotropy;
      VFX.impactTexture.needsUpdate = true;
    }

    this.scene = scene;
    this.particleScale = particleScale;
    this.root = new Group();
    this.root.name = 'VFX';
    scene.add(this.root);

    const n = (base) => Math.max(4, Math.round(base * particleScale));
    this.caps = {
      sparks: n(420), smoke: n(260), debris: n(220), blood: n(320), embers: n(180),
    };

    this.sparks = new ParticlePool(this.caps.sparks, {
      size: 0.075, blending: AdditiveBlending, gravity: -9.5, drag: 1.6, fadePower: 0.7,
    });
    this.smoke = new ParticlePool(this.caps.smoke, {
      size: 0.55, blending: NormalBlending, gravity: 0.9, drag: 1.5, fadePower: 0.35,
    });
    this.smoke.material.opacity = 0.42;
    this.debris = new ParticlePool(this.caps.debris, {
      size: 0.10, blending: NormalBlending, gravity: -16, drag: 0.5, fadePower: 0.5,
    });
    this.blood = new ParticlePool(this.caps.blood, {
      size: 0.10, blending: NormalBlending, gravity: -13, drag: 0.9, fadePower: 0.6,
    });
    this.embers = new ParticlePool(this.caps.embers, {
      size: 0.10, blending: AdditiveBlending, gravity: 1.6, drag: 1.1, fadePower: 0.8,
    });
    this.pools = [this.sparks, this.smoke, this.debris, this.blood, this.embers];
    for (const p of this.pools) this.root.add(p.points);

    // --- pooled dynamic lights (muzzle flashes, explosions) ---
    // Allocated for the richest tier and budgeted down: an adaptive upgrade must never
    // need lights that were never built.
    this.lightCapacity = Math.max(1, Math.round(Math.max(lightCapacity, maxLights)));
    this.maxLights = Math.max(1, Math.min(this.lightCapacity, Math.round(maxLights)));
    this.lights = [];
    for (let i = 0; i < this.lightCapacity; i++) {
      const l = new PointLight(0xffffff, 0, 12, 2);
      /**
       * Invisible for the whole session, and that is not a bug.
       *
       * These are EMITTERS, read by render/LightRig.js and copied into its fixed pool.
       * The old code flipped `visible` here on every shot, which changed the scene's
       * point-light count, which rebuilt every shader in the game - the freeze on firing.
       * Nothing in this file may touch `visible` again; intensity is the only control.
       */
      l.visible = false;
      l.userData.life = 0;
      l.userData.peak = 0;
      l.userData.maxLife = 0;
      this.root.add(l);
      this.lights.push(l);
    }
    this._lightCursor = 0;

    // --- pooled muzzle-flash sprites (parented to the weapon rig by the caller) ---
    this.flashes = [];
    for (let i = 0; i < 4; i++) {
      const mat = new SpriteMaterial({
        map: VFX.flareTexture, color: 0xffffff, transparent: true,
        depthWrite: false, depthTest: false, blending: CustomBlending, opacity: 0,
        blendEquation: AddEquation, blendSrc: SrcAlphaFactor, blendDst: OneFactor,
        blendEquationAlpha: AddEquation, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor,
        rotation: 0,
      });
      const s = new Sprite(mat);
      s.visible = false;
      s.renderOrder = 40;
      this.flashes.push({ sprite: s, mat, life: 0, maxLife: 0.055, peak: 1 });
    }
    this._flashCursor = 0;

    // --- pooled bullet-impact decals ---
    this.decalGeo = new PlaneGeometry(1, 1);
    /**
     * The colour is now the DUST, not the hole: makeImpactMark bakes the puncture and the
     * char in as dark RGB and leaves the halo near-white, so this tint reaches the halo
     * at nearly full value and the centre at almost none. Tinted to the level's own
     * concrete rather than to neutral grey, so a mark belongs to the wall it is on.
     */
    this.decalMat = excludeFromEnvironment(new MeshBasicMaterial({
      map: VFX.impactTexture, color: 0x9C8A74, transparent: true,
      opacity: 0.85, depthWrite: false, side: DoubleSide,
      /**
       * Depth bias towards the camera, so the mark wins against the wall it lies on without
       * needing to be held away from it. This is what pays for DECAL_OFFSET being 2 mm
       * instead of 12 mm, and 2 mm is what stops the mark appearing to slide across the
       * wall at a grazing angle. Honoured by both backends in r185 - WebGL maps it to
       * gl.polygonOffset, WebGPU to depthBias/depthBiasSlopeScale.
       */
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }));
    this.decalCapacity = Math.max(1, Math.round(decalCapacity));
    this.decalLife = decalLife;
    this.decals = [];
    for (let i = 0; i < this.decalCapacity; i++) {
      const m = new Mesh(this.decalGeo, this.decalMat.clone());
      m.visible = false;
      m.renderOrder = 2;
      this.root.add(m);
      this.decals.push({ mesh: m, life: 0, maxLife: decalLife });
    }
    this._decalCursor = 0;
    this.decalBudget = this.decalCapacity;
    this.setDecalBudget(maxDecals);

    // --- pooled blood marks (option 2: the hit that stays) ---
    this.collision = collision;
    this.bloodCapacity = Math.max(0, Math.round(bloodCapacity));
    this.bloodLife = bloodLife;
    this.bloods = [];
    this._bloodCursor = 0;
    this._bloodCount = 0;
    if (this.bloodCapacity > 0) {
      VFX.bloodTexture ||= makeBloodMark();
      if (anisotropy > VFX.bloodTexture.anisotropy) {
        VFX.bloodTexture.anisotropy = anisotropy;
        VFX.bloodTexture.needsUpdate = true;
      }
      /**
       * LIT, unlike the impact mark. A bullet hole is a dark dot and reads the same lit or
       * not; a wet ichor splash a metre across on a wall has to take the corridor's light
       * or it floats in front of the wall as a flat teal sticker. Low roughness because it
       * is wet, no metalness, and the environment probe gives it the sheen.
       */
      this.bloodMat = new MeshStandardMaterial({
        map: VFX.bloodTexture, color: 0xFFFFFF, transparent: true, opacity: 1,
        roughness: 0.32, metalness: 0.0, depthWrite: false, side: DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
      for (let i = 0; i < this.bloodCapacity; i++) {
        const m = new Mesh(this.decalGeo, this.bloodMat.clone());
        m.visible = false;
        m.renderOrder = 2;
        m.receiveShadow = true;
        this.root.add(m);
        this.bloods.push({ mesh: m, life: 0, maxLife: bloodLife });
      }
    }
    /** Scratch for the wall search behind a hit; allocated once. */
    this._ray = { hit: false, x: 0, z: 0, dist: 0, normalX: 0, normalZ: 0, blocker: null };

    // --- explosion shell (a single expanding additive sphere, reused) ---
    this.blastMat = excludeFromEnvironment(new MeshBasicMaterial({
      color: 0xFFC98A, transparent: true, opacity: 0, blending: AdditiveBlending,
      depthWrite: false, side: DoubleSide,
    }));
    this.blast = new Mesh(new SphereGeometry(1, 16, 12), this.blastMat);
    this.blast.visible = false;
    this.root.add(this.blast);
    this._blastLife = 0;
    this._blastMax = 0.42;

    this._c = new Color();
  }

  /**
   * Live bullet-decal budget for the current quality tier. The pool itself is fixed at
   * construction; this only narrows how much of it is in play, and retires anything already
   * standing outside the new budget so a downgrade is visible immediately rather than after
   * the old decals time out.
   */
  setDecalBudget(n) {
    const budget = Math.max(0, Math.min(this.decalCapacity, Math.round(n)));
    for (let i = budget; i < this.decals.length; i++) {
      const d = this.decals[i];
      d.life = 0;
      d.mesh.visible = false;
    }
    this.decalBudget = budget;
    this._decalCursor = budget > 0 ? this._decalCursor % budget : 0;
  }

  // ------------------------------------------------------------------
  // Emitters
  // ------------------------------------------------------------------

  /** Short-lived point light. Returns the light so a caller can position it further. */
  pulseLight(x, y, z, color, intensity, life, distance = 12) {
    let l = null;
    for (let k = 0; k < this.maxLights; k++) {
      const cand = this.lights[(this._lightCursor + k) % this.maxLights];
      if (cand.userData.life <= 0) { l = cand; break; }
    }
    // All busy: steal the dimmest so the newest event is always visible.
    if (!l) {
      l = this.lights[0];
      for (let k = 1; k < this.maxLights; k++) if (this.lights[k].intensity < l.intensity) l = this.lights[k];
    }
    this._lightCursor = (this._lightCursor + 1) % this.maxLights;
    l.position.set(x, y, z);
    l.color.set(color);
    l.distance = distance;
    l.userData.peak = intensity;
    l.userData.life = life;
    l.userData.maxLife = life;
    l.intensity = intensity;
    return l;
  }

  /**
   * Muzzle flash sprite. `parent` is the weapon rig so the flash tracks recoil exactly;
   * `local` is the muzzle offset within it.
   */
  muzzleFlash(parent, local, scale, color, seed) {
    const f = this.flashes[this._flashCursor];
    this._flashCursor = (this._flashCursor + 1) % this.flashes.length;
    if (f.sprite.parent !== parent) parent.add(f.sprite);
    f.sprite.position.copy(local);
    f.sprite.scale.setScalar(scale);
    f.mat.color.set(color);
    // Deterministic per-shot rotation - no RNG, so a replayed shot looks identical.
    f.mat.rotation = (seed % 8) * (Math.PI / 4);
    f.mat.opacity = 1;
    f.sprite.visible = true;
    f.life = f.maxLife;
    return f;
  }

  /**
   * The same impact, chosen by what was hit. This is the entry point the weapon uses -
   * WeaponRaycaster classifies every hit into a SURFACE and the spark colour follows from it,
   * so concrete throws pale dust and metal throws a hot spark without the caller knowing the
   * palette.
   */
  impact(surface, x, y, z, nx, ny, nz) {
    const profile=SURFACE_RESPONSE[surface];
    this.bulletImpact(x,y,z,nx,ny,nz,profile?.tint??SURFACE_TINT[surface]??SURFACE_TINT.concrete,profile);
  }

  /** Sparks + dust + a scorch decal where a bullet met a wall. */
  bulletImpact(x, y, z, nx, ny, nz, tint = 0xFFC98A, profile = null) {
    this._c.set(tint);
    const count = Math.max(0, Math.round((profile?.sparks??9) * this.particleScale));
    for (let i = 0; i < count; i++) {
      // Deterministic cone around the surface normal using a golden-angle spiral.
      const a = i * 2.39996;
      const r = 0.55 + (i / count) * 0.75;
      const tx = -nz, tz = nx;                    // a tangent to the normal
      const sx = nx * 2.2 + Math.cos(a) * r * (tx + 0.2);
      const sy = ny * 2.2 + Math.sin(a) * r + 0.9;
      const sz = nz * 2.2 + Math.cos(a + 1.1) * r * (tz + 0.2);
      const sp = 2.4 + (i % 4) * 0.9;
      this.sparks.spawn(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02,
        sx * sp, sy * sp, sz * sp, 0.16 + (i % 3) * 0.06, 0.05 + (i % 3) * 0.02,
        this._c.r, this._c.g, this._c.b);
    }
    const dust = Math.max(0, Math.round((profile?.dust??3) * this.particleScale));
    for (let i = 0; i < dust; i++) {
      this.smoke.spawn(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05,
        nx * 0.7 + (i - 1) * 0.25, 0.55 + i * 0.12, nz * 0.7 + (i - 1) * 0.25,
        0.55 + i * 0.12, 0.20 + i * 0.06, 0.42, 0.32, 0.24);
    }
    this._placeDecal(x,y,z,nx,ny,nz,(profile?.dust===0 ? .13 : .22)+(this._decalCursor%3)*.05,profile?.tint);
  }

  /**
   * Stamp one mark onto a surface, in world space, once.
   *
   * The surface normal IS the transform: the decal's own +Z is turned onto it, and nothing
   * afterwards may touch the result - `update()` only fades opacity, so a mark's world
   * position, orientation and size are fixed from here until its slot is reused. That is
   * what keeps it welded to the wall while the camera moves.
   *
   * @param {number} nx unit surface normal at the hit, pointing OUT of the surface. It must
   *   be the geometry's normal; a direction derived from the shot instead orients the mark
   *   towards wherever the shooter stood, which is a billboard baked in at spawn time.
   */
  _placeDecal(x, y, z, nx, ny, nz, size, tint=0x9c8a74) {
    if (this.decalBudget <= 0) return;
    /**
     * A zero-length normal carries no orientation, so there is no correct mark to place and
     * one is not invented. The old lookAt() path silently produced a decal facing +Z here.
     */
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-6)) return;
    const ux = nx / len, uy = ny / len, uz = nz / len;

    const slot = this._decalCursor;
    const d = this.decals[slot];
    this._decalCursor = (this._decalCursor + 1) % this.decalBudget;
    d.mesh.position.set(x + ux * DECAL_OFFSET, y + uy * DECAL_OFFSET, z + uz * DECAL_OFFSET);
    /**
     * The basis is built from the normal alone - the minimal rotation carrying the plane's
     * +Z onto it - rather than with lookAt().
     *
     * lookAt() cannot express this orientation on its own: it needs a second reference to
     * resolve the roll and takes `Object3D.up`, which is world +Y. When the normal IS world
     * +Y - a hit on the floor, or on the underside of anything - the two are parallel,
     * there is no basis to build, and three falls back to nudging the axis by 1e-4 and
     * improvising. Measured: the floor's mark came out tilted off the floor, with a roll
     * that depended on which way the nudge happened to fall. setFromUnitVectors has no
     * second reference, so every normal including that one is exact.
     *
     * The VFX root is an untransformed Group, so this local quaternion is the world one.
     */
    d.mesh.quaternion.setFromUnitVectors(_PLANE_FORWARD, _decalNormal.set(ux, uy, uz));
    /**
     * Roll about the surface normal. The basis above fixes only the facing, so without this
     * every mark on a given wall lands at the same rotation - invisible while the decal was
     * a radially symmetric dot, and a repeating stamp now that it has spall streaks and an
     * off-centre halo. Derived from the pool slot rather than from a random number: the
     * project's effects are deterministic by rule, so a replayed shot must reproduce the
     * mark exactly. The golden angle steps the pool through the full circle without ever
     * repeating an orientation on adjacent slots. Rotating about the mesh's own Z keeps the
     * normal exactly where it was put.
     */
    d.mesh.rotateZ(slot * 2.39996);
    d.mesh.scale.setScalar(size);
    d.mesh.material.opacity = 0.85;
    d.mesh.material.color.set(tint);
    d.mesh.visible = true;
    d.life = d.maxLife;
  }

  /** Blood/ichor burst when an enemy is hit. Teal, matching the enemy flesh. */
  enemyHit(x, y, z, dirX, dirY, dirZ, heavy = false) {
    const count = Math.max(4, Math.round((heavy ? 20 : 9) * this.particleScale));
    for (let i = 0; i < count; i++) {
      const a = i * 2.39996;
      const r = 0.4 + (i / count) * 1.1;
      const sp = (heavy ? 3.6 : 2.3) + (i % 5) * 0.55;
      this.blood.spawn(x, y, z,
        (dirX * 1.3 + Math.cos(a) * r) * sp,
        (dirY * 0.7 + Math.sin(a) * r + 1.1) * sp,
        (dirZ * 1.3 + Math.sin(a + 2.1) * r) * sp,
        0.42 + (i % 4) * 0.12, 0.07 + (i % 3) * 0.03,
        0.18, 0.62, 0.55);
    }
    this.bloodSpray(x, y, z, dirX, dirY, dirZ, heavy);
  }

  /**
   * The mark the hit leaves: on the wall behind the enemy, along the shot, and on the
   * floor under it. Both are deterministic in everything but the shot itself.
   *
   * The wall search is the collision grid's own ray, cast from the hit point along the
   * shot direction for a few metres. A blocker hit (a crate, a door) is a surface too and
   * takes the mark on its face; the tank is glass and takes nothing, so its id is skipped.
   */
  bloodSpray(x, y, z, dirX, dirY, dirZ, heavy) {
    if (this.bloodCapacity <= 0 || !this.collision) return;
    this._bloodCount++;
    const horiz = Math.hypot(dirX, dirZ);
    if (horiz > 1e-4) {
      const ray = this.collision.raycastXZ(x, z, dirX / horiz, dirZ / horiz, heavy ? 4.5 : 3.2, this._ray);
      if (ray.hit) {
        // Height where the spray meets the wall: the shot's own slope, kept on the wall.
        const wy = Math.max(0.25, Math.min(4.6, y + (dirY / horiz) * ray.dist));
        // The fainter the further it travelled.
        const size = (heavy ? 1.1 : 0.7) * Math.max(0.45, 1 - ray.dist * 0.12) * (0.85 + (this._bloodCount % 3) * 0.12);
        // Roll so the droplet bias in the texture (+u) points the way the spray travelled
        // across the wall - which is up for a shot from below, sideways for a flanking hit.
        const tx = -ray.normalZ, tz = ray.normalX;   // the wall's +u for a viewer facing it
        const along = (dirX / horiz) * tx + (dirZ / horiz) * tz;
        const roll = Math.atan2(dirY / horiz, along);
        this._placeBlood(ray.x, wy, ray.z, ray.normalX, 0, ray.normalZ, size, roll);
      }
    }
    // Floor drops: every heavy hit, otherwise every third.
    if (heavy || this._bloodCount % 3 === 0) {
      const fx = x + dirX * 0.45, fz = z + dirZ * 0.45;
      if (this.collision.isOpenAt(fx, fz)) {
        this._placeBlood(fx, 0, fz, 0, 1, 0, (heavy ? 0.9 : 0.55) * (0.85 + (this._bloodCount % 4) * 0.1),
          this._bloodCount * 2.39996);
      }
    }
  }

  /** The pool a body leaves: called once on a kill, at the enemy's feet. */
  enemyDeath(x, z, dirX = 0, dirZ = 0) {
    if (this.bloodCapacity <= 0 || !this.collision) return;
    this._bloodCount++;
    // The corpse falls away from the shot, so the pool is offset that way.
    const px = x + dirX * 0.5, pz = z + dirZ * 0.5;
    if (!this.collision.isOpenAt(px, pz)) return;
    this._placeBlood(px, 0, pz, 0, 1, 0, 1.35 + (this._bloodCount % 3) * 0.2, this._bloodCount * 2.39996);
  }

  _placeBlood(x, y, z, nx, ny, nz, size, roll) {
    const slot = this._bloodCursor;
    const d = this.bloods[slot];
    this._bloodCursor = (this._bloodCursor + 1) % this.bloodCapacity;
    d.mesh.position.set(x + nx * DECAL_OFFSET, y + ny * DECAL_OFFSET, z + nz * DECAL_OFFSET);
    d.mesh.quaternion.setFromUnitVectors(_PLANE_FORWARD, _decalNormal.set(nx, ny, nz));
    d.mesh.rotateZ(roll);
    d.mesh.scale.setScalar(size);
    d.mesh.material.opacity = 1;
    // Fresh: full colour. It dries darker over the first seconds (see update).
    d.mesh.material.color.setScalar(1);
    d.mesh.visible = true;
    d.life = d.maxLife;
  }

  /** The grenade explosion: flash, shell, sparks, smoke column, embers, light. */
  explosion(x, y, z, radius) {
    this.blast.position.set(x, y, z);
    this.blast.scale.setScalar(0.4);
    this.blastMat.opacity = 0.9;
    this.blast.visible = true;
    this._blastLife = this._blastMax;
    this._blastRadius = radius;

    const sparkN = Math.max(10, Math.round(70 * this.particleScale));
    for (let i = 0; i < sparkN; i++) {
      const a = i * 2.39996;
      const phi = Math.acos(1 - 2 * ((i + 0.5) / sparkN));   // even sphere distribution
      const sx = Math.sin(phi) * Math.cos(a);
      const sy = Math.cos(phi) * 0.7 + 0.5;
      const sz = Math.sin(phi) * Math.sin(a);
      const sp = 7 + (i % 7) * 2.2;
      this.sparks.spawn(x, y, z, sx * sp, sy * sp, sz * sp,
        0.35 + (i % 5) * 0.11, 0.07 + (i % 4) * 0.025, 1.0, 0.78, 0.34);
    }
    const smokeN = Math.max(6, Math.round(26 * this.particleScale));
    for (let i = 0; i < smokeN; i++) {
      const a = i * 2.39996;
      const r = 0.6 + (i / smokeN) * 1.6;
      this.smoke.spawn(x + Math.cos(a) * r * 0.3, y + 0.2, z + Math.sin(a) * r * 0.3,
        Math.cos(a) * r * 1.5, 1.5 + (i % 4) * 0.6, Math.sin(a) * r * 1.5,
        1.1 + (i % 5) * 0.28, 0.7 + (i % 4) * 0.22, 0.30, 0.24, 0.20);
    }
    const emberN = Math.max(4, Math.round(22 * this.particleScale));
    for (let i = 0; i < emberN; i++) {
      const a = i * 2.39996;
      this.embers.spawn(x, y + 0.15, z,
        Math.cos(a) * (1.5 + i % 3), 2.4 + (i % 5) * 0.8, Math.sin(a) * (1.5 + i % 3),
        0.9 + (i % 4) * 0.3, 0.06, 1.0, 0.68, 0.28);
    }
    const debrisN = Math.max(4, Math.round(18 * this.particleScale));
    for (let i = 0; i < debrisN; i++) {
      const a = i * 2.39996;
      this.debris.spawn(x, y + 0.1, z,
        Math.cos(a) * (3 + i % 4) * 1.5, 4 + (i % 5) * 1.4, Math.sin(a) * (3 + i % 4) * 1.5,
        1.2, 0.09, 0.32, 0.22, 0.16);
    }
    this.pulseLight(x, y + 0.4, z, 0xFFC98A, 90, 0.38, radius * 3.2);
  }

  /** Sparks and smoke off the barricade when it takes a hit. */
  barricadeHit(x, y, z) {
    const n = Math.max(3, Math.round(11 * this.particleScale));
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996;
      this.sparks.spawn(x, y, z,
        Math.cos(a) * 3.2, 1.6 + (i % 4) * 0.9, Math.sin(a) * 3.2,
        0.24, 0.05, 1.0, 0.72, 0.35);
    }
  }

  // ------------------------------------------------------------------

  update(dt) {
    for (const p of this.pools) p.update(dt);

    for (const l of this.lights) {
      const u = l.userData;
      if (u.life <= 0) continue;
      u.life -= dt;
      if (u.life <= 0) { l.intensity = 0; continue; }
      const k = u.life / u.maxLife;
      l.intensity = u.peak * k * k;
    }

    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.sprite.visible = false; f.mat.opacity = 0; continue; }
      const k = f.life / f.maxLife;
      f.mat.opacity = k;
      f.sprite.scale.multiplyScalar(1 + dt * 3.5);
    }

    for (const d of this.decals) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) { d.mesh.visible = false; continue; }
      // Hold full opacity, then fade over the last second.
      d.mesh.material.opacity = 0.85 * Math.min(1, d.life);
    }

    for (const d of this.bloods) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) { d.mesh.visible = false; continue; }
      const age = d.maxLife - d.life;
      // Dries: the wet sheen and the colour both settle over the first eight seconds.
      const dry = Math.min(1, age / 8);
      d.mesh.material.color.setScalar(1 - dry * 0.35);
      d.mesh.material.roughness = 0.32 + dry * 0.5;
      // Then holds, and fades over the last three seconds so a slot reuse never pops.
      d.mesh.material.opacity = Math.min(1, d.life / 3);
    }

    if (this._blastLife > 0) {
      this._blastLife -= dt;
      if (this._blastLife <= 0) { this.blast.visible = false; this.blastMat.opacity = 0; }
      else {
        const k = 1 - this._blastLife / this._blastMax;
        this.blast.scale.setScalar(0.4 + k * this._blastRadius * 1.15);
        this.blastMat.opacity = 0.9 * (1 - k) * (1 - k);
      }
    }
  }

  /** Wipe every live effect - used on restart so nothing survives into a new run. */
  clear() {
    for (const p of this.pools) p.clear();
    for (const l of this.lights) { l.userData.life = 0; l.intensity = 0; }
    for (const f of this.flashes) { f.life = 0; f.sprite.visible = false; f.mat.opacity = 0; }
    for (const d of this.decals) { d.life = 0; d.mesh.visible = false; }
    for (const d of this.bloods) { d.life = 0; d.mesh.visible = false; }
    this._blastLife = 0; this.blast.visible = false; this.blastMat.opacity = 0;
  }

  dispose() {
    for (const p of this.pools) p.dispose();
    this.decalGeo.dispose();
    for (const d of this.decals) d.mesh.material.dispose();
    for (const d of this.bloods) d.mesh.material.dispose();
    this.bloodMat?.dispose();
    this.blast.geometry.dispose();
    this.blastMat.dispose();
    for (const f of this.flashes) f.mat.dispose();
  }
}
