/* lamps.js — the light a lamp actually throws.
 *
 * Emissive geometry is a lie that works outdoors. A window slab that glows at
 * dusk reads as a lit room because nobody is standing in it; the moment you
 * walk inside, the candle on the table is a bright dot in a black room and the
 * fiction collapses. An interior needs real lights.
 *
 * Real lights are not free. Every PointLight a scene owns is a term in every
 * lit fragment, and a town with a candle per table has hundreds. So this is a
 * POOL — the same shape as the firelight pool in fx/fire.js — sized by the
 * quality tier and assigned each frame to the lamps nearest the camera. A
 * hundred lamps in a village cost exactly what four do, and the four you can
 * see are the four that are lit.
 *
 * The pool is built once and never resized. three.js recompiles every shader
 * program when the light COUNT changes, so growing the pool on demand would
 * stall the frame that a player walks through a door — which is precisely the
 * frame that must not stall.
 */

const MAX_POOL = 8;

export class Lamps {
  /** @param quality  the render tier; `lampLights` is the pool size. */
  constructor(THREE, quality = {}) {
    this.THREE = THREE;
    this.group = new THREE.Group();
    this.group.name = "lamps";
    /* Lit by default, because a world whose clock never runs is a world that
       has always looked like this and should keep looking like it. */
    this.lit = true;
    // uid → [{x, y, z, r, color}] in world space, one per declared light.
    this.sources = new Map();
    this._flat = [];
    this._dirty = true;

    this._lights = [];
    const n = Math.max(0, Math.min(MAX_POOL, quality.lampLights ?? 0));
    for (let i = 0; i < n; i++) {
      // Decay 1.4, deliberately sub-physical. At decay 2 the near field is a
      // spike: the floor a metre under a lamp carried more bloom than the
      // lamp itself, then the light died within a stride. The softer curve
      // holds the same reach at distance while the close pool drops out of
      // the bloom threshold — a halo around the source, not a burn under it.
      // Distance is still set per assignment, so a candle does not reach as
      // far as a hearth.
      const l = new THREE.PointLight(0xffd9a8, 0, 6, 1.4);
      l.castShadow = false;
      this.group.add(l);
      this._lights.push(l);
    }
    this._v = new THREE.Vector3();
  }

  get count() { return this._flat.length; }
  get pool() { return this._lights.length; }

  /* Take the lights out of a placement that has just been built. World space,
     because the pool has to sort them against a camera and the objects they
     hang off may be rotated, scaled and seated on a slope. */
  register(uid, object) {
    if (!this._lights.length) return;
    const found = [];
    object.updateMatrixWorld(true);
    object.traverse((o) => {
      const spec = o.userData?.light;
      if (!spec) return;
      o.getWorldPosition(this._v);
      found.push({ x: this._v.x, y: this._v.y, z: this._v.z, r: spec.r, color: spec.color });
    });
    if (found.length) { this.sources.set(uid, found); this._dirty = true; }
    else if (this.sources.delete(uid)) this._dirty = true;
  }

  forget(uid) {
    if (this.sources.delete(uid)) this._dirty = true;
  }

  clear() {
    this.sources.clear();
    this._dirty = true;
    for (const l of this._lights) l.intensity = 0;
  }

  /* Assign the pool to the nearest lamps. Returns true when something moved,
     so a paused editor still redraws when the camera does. */
  /* ── lit, or out ──
     A lamp is a thing somebody reaches for at dusk, and until the clock ran
     there was no dusk to reach for it at: every candle in this world burned
     at noon. The pool is untouched — no shader recompiles, no lights added or
     removed — the whole switch is whether `tick` gives them any intensity.
     the editor decides when. */
  setLit(on) {
    const v = !!on;
    if (v === this.lit) return false;
    this.lit = v;
    return true;
  }

  tick(camera) {
    if (!this._lights.length) return false;
    if (!this.lit) {
      let changed = false;
      for (const l of this._lights) if (l.intensity !== 0) { l.intensity = 0; changed = true; }
      return changed;
    }
    if (this._dirty) {
      this._flat = [];
      for (const list of this.sources.values()) this._flat.push(...list);
      this._dirty = false;
    }
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    let near = this._flat;
    if (near.length > this._lights.length) {
      // Ranked by distance to the lamp's own REACH, not to the lamp: a hearth
      // that lights the room you are in outranks a candle two metres closer
      // in the room behind you.
      near = this._flat
        .map((s) => ({ s, d: Math.hypot(s.x - cx, s.y - cy, s.z - cz) - s.r }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this._lights.length)
        .map((e) => e.s);
    }
    let changed = false;
    for (let i = 0; i < this._lights.length; i++) {
      const l = this._lights[i], s = near[i];
      if (!s) {
        if (l.intensity !== 0) { l.intensity = 0; changed = true; }
        continue;
      }
      // Out of reach by a wide margin: keep it dark rather than spend the slot
      // on something nobody can see lit.
      const far = Math.hypot(s.x - cx, s.y - cy, s.z - cz) > s.r + 26;
      // 0.16 with decay 1.4 matches the old 0.42/decay-2 illumination from
      // ~4 m out; what changes is the first two metres, which used to blow
      // past the bloom threshold and read as a white pool.
      const want = far ? 0 : s.r * s.r * 0.16;
      if (l.position.x !== s.x || l.position.y !== s.y || l.position.z !== s.z
        || l.intensity !== want) changed = true;
      l.position.set(s.x, s.y, s.z);
      l.distance = s.r * 1.35;
      l.color.setHex(s.color);
      l.intensity = want;
    }
    return changed;
  }

  dispose() {
    for (const l of this._lights) this.group.remove(l);
    this._lights.length = 0;
    this.sources.clear();
  }
}
