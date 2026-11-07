/**
 * A FIXED NUMBER OF LIGHTS, FOREVER.
 *
 * This exists because of one property of three's renderer, in both backends: the shader a
 * material compiles to depends on HOW MANY LIGHTS OF EACH TYPE ARE IN THE SCENE, and a
 * light with `visible = false` is not in the scene at all - `_projectObject` returns early
 * on it and it is never pushed to the render list. So every time a light's `visible` flips,
 * the light count changes, the node graph's cache key changes, and EVERY MATERIAL IN THE
 * SCENE IS REBUILT.
 *
 * The level was doing that constantly:
 *
 *   - VFX.pulseLight set `visible = true` on a pooled light on EVERY SHOT, and cleared it
 *     when the flash decayed a third of a second later. That is the freeze on firing: the
 *     first shot rebuilt every pipeline in the game, and any new combination of live
 *     effect lights did it again.
 *   - Level.cullZoneLights toggled `visible` on the 18 authored zone lights every frame as
 *     the player walked, so the count churned during ordinary movement.
 *   - The blast doors, the barricade and the view-model muzzle light did the same.
 *
 * And when nothing was toggling, the resting state was still 36 point lights in the world
 * scene - 18 zones, 6 on props and doors, 8 pooled effects, 2 carried by the camera. Every
 * lit pixel in the game was evaluating two dozen point lights. That is why the level only
 * ran on the lowest preset: the cost was never in the resolution, it was in the light loop.
 *
 * THE FIX IS THE SAME FOR BOTH. This rig owns a small, FIXED pool of PointLights that are
 * added to the scene once, are visible from then until teardown, and are never added,
 * removed or hidden. Every other light in the level is demoted to an EMITTER: it keeps its
 * place in the scene graph, so its transform still follows the door it is bolted to and
 * every existing animation keeps driving its colour and intensity exactly as before, but
 * it is permanently invisible and therefore costs the renderer nothing.
 *
 * Each frame the rig scores the emitters by how much light they actually deliver to the
 * camera and copies the strongest few into its slots. Slots with nothing to show are set to
 * zero intensity rather than hidden, so the count never moves.
 *
 * Membership has hysteresis and fades to zero before a slot changes position. The light
 * count stays fixed; the full-strength faded copies also drive dust and volumetrics.
 */

import { pointIrradiance } from './irradiance.js';
import { PointLight } from 'three/webgpu';

export class LightRig {
  /**
   * @param {import('three/webgpu').Scene} scene
   * @param {number} slots how many point lights this scene will ever have. Fixed for the
   *   session: changing it is a full shader rebuild, which is the thing being avoided.
   */
  constructor(scene, slots) {
    this.scene = scene;
    this.count = Math.max(1, Math.round(slots));
    /** @type {PointLight[]} */
    this.slots = [];
    for (let i = 0; i < this.count; i++) {
      const l = new PointLight(0xffffff, 0, 1, 2);
      l.name = `RigLight${i}`;
      l.castShadow = false;
      // Never touched again. This is the whole point of the class.
      l.visible = true;
      scene.add(l);
      this.slots.push(l);
    }
    /** @type {PointLight[]} Lights demoted to data; see add(). */
    this.emitters = [];
    this._score = new Float64Array(64);
    this._order = new Int32Array(64);
    /** How many slots carried a light last frame, for the debug overlay. */
    this.live = 0;
    /** The emitter behind each live slot, strongest first, for anything else that wants the same pick. */
    this.chosen = this.slots.map(() => new PointLight());
    this._members = new Array(this.count).fill(null);
    this._weights = new Float32Array(this.count);
  }

  /**
   * Demote a light to an emitter.
   *
   * It stays exactly where it is in the scene graph - parented to whatever prop or door
   * owns it - so `matrixWorld` keeps tracking that parent and none of the code animating
   * it has to change. It simply stops being a light the renderer knows about.
   */
  add(light) {
    if (!light || this.emitters.includes(light)) return light;
    light.visible = false;
    light.castShadow = false;
    this.emitters.push(light);
    if (this._score.length < this.emitters.length) {
      this._score = new Float64Array(this.emitters.length * 2);
      this._order = new Int32Array(this.emitters.length * 2);
    }
    return light;
  }

  /** Demote a whole array at once. */
  addAll(lights) {
    for (const l of lights) this.add(l);
    return lights;
  }

  /**
   * Rebind the slots to the emitters that matter most from `eye`.
   *
   * Allocation-free: the score and order buffers are owned, and the selection is a partial
   * sort that stops after `count` - this runs every frame, so it may not produce garbage.
   *
   * @param {import('three/webgpu').Vector3} eye camera position in world space
   * @param {PointLight|null} [shadowed] the emitter the fixture shadow light (Lighting) is
   *   currently standing in for, if any
   * @param {number} [share] how much of that emitter's light the shadow light carries,
   *   0..1; the slot that mirrors it gets the remainder, so the two never add up to more
   *   than the fixture itself
   */
  update(eye, shadowed = null, share = 0, dt = 1 / 60) {
    const em = this.emitters, score = this._score, order = this._order;
    let live = 0;
    for (let i = 0; i < em.length; i++) {
      const e = em[i]; e.updateWorldMatrix(true, false);
      const m = e.matrixWorld.elements;
      const d2 = (m[12] - eye.x) ** 2 + (m[13] - eye.y) ** 2 + (m[14] - eye.z) ** 2;
      score[i] = pointIrradiance(e.intensity, d2, e.distance, e.decay);
      // An incumbent needs a 30% stronger challenger before it starts retiring.
      if (this._members.includes(e)) score[i] *= 1.3;
      if (score[i] > 0) order[live++] = i;
    }
    const keep = Math.min(this.count, live);
    for (let i = 0; i < keep; i++) {
      let best = i;
      for (let j = i + 1; j < live; j++) if (score[order[j]] > score[order[best]]) best = j;
      const temp = order[i]; order[i] = order[best]; order[best] = temp;
    }
    const wanted = e => { for (let j = 0; j < keep; j++) if (em[order[j]] === e) return true; return false; };
    const step = Math.max(0, Math.min(dt, .1)) / .12;
    this.live = 0;
    for (let i = 0; i < this.count; i++) {
      let src = this._members[i];
      if (src && !wanted(src)) {
        this._weights[i] = Math.max(0, this._weights[i] - step);
        if (this._weights[i] === 0) this._members[i] = src = null;
      }
      if (!src) for (let j = 0; j < keep; j++) {
        const candidate = em[order[j]];
        if (!this._members.includes(candidate)) { this._members[i] = src = candidate; break; }
      }
      if (src && wanted(src)) this._weights[i] = Math.min(1, this._weights[i] + step);
      const dst = this.slots[i], air = this.chosen[i];
      if (!src) { dst.intensity = air.intensity = 0; continue; }
      const m = src.matrixWorld.elements;
      for (const light of [dst, air]) {
        light.position.set(m[12], m[13], m[14]); light.color.copy(src.color);
        light.distance = src.distance; light.decay = src.decay;
        light.userData = src.userData; light.updateMatrixWorld();
      }
      air.intensity = src.intensity * this._weights[i];
      dst.intensity = air.intensity * (src === shadowed ? 1 - share : 1);
      if (air.intensity > 0) this.live++;
    }
  }

  /** Every slot dark, for a restart. The count is unchanged, as always. */
  clear() {
    for (const l of [...this.slots, ...this.chosen]) l.intensity = 0;
    this._members.fill(null); this._weights.fill(0); this.live = 0;
  }

  dispose() {
    for (const l of this.slots) {
      l.parent?.remove(l);
      l.dispose?.();
    }
    this.slots.length = 0;
    this.emitters.length = 0;
  }
}
