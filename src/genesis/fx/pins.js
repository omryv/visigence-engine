/* pins.js — what a world looks like when you cannot see what is in it.
 *
 * Pull the orbit camera back far enough to plan a village and every object
 * in that village is smaller than the cursor. The world does not stop having
 * things in it; it stops SHOWING that it has things in it, and the author
 * starts hunting. That is the whole problem this file solves.
 *
 * The rule is one line: A PIN APPEARS EXACTLY WHERE THE OBJECT STOPS BEING
 * LEGIBLE, AND DISAPPEARS THE MOMENT IT IS. The vertex shader works out how
 * many pixels tall the object actually is on screen — its world radius, the
 * viewport height and the projection are all it needs — and cross-fades the
 * pin against that number. Zoom in and the pins melt away one by one as
 * their objects grow into view; pull out and they come back. Nobody has to
 * toggle anything, and there is no zoom level at which the world looks empty
 * and no zoom level at which it looks like a pin board.
 *
 * COST. One sprite, one draw call, one INSTANCE per placement, rebuilt only
 * when the set of placements changes. Ten thousand pins are ten thousand
 * instances of one quad, and the per-frame cost is zero, because the fade
 * lives entirely in the shader. (It was a Points cloud under WebGLRenderer;
 * WebGPU draws points one pixel wide, so a sized point is an instanced quad,
 * which is what three's PointsNodeMaterial makes of a Sprite.)
 *
 * The pin is drawn procedurally in the fragment shader (a teardrop SDF), so
 * there is no texture, no atlas and nothing to fetch — the same zero-byte
 * discipline the props themselves are built under.
 */

import * as THREE from "three";
import {
  Fn, If, Discard, uniform, instancedBufferAttribute, uv, vec2, vec3, vec4, float, length, abs, clamp, mix, max, min,
  smoothstep, select, positionView, varying,
} from "three/tsl";
import { crowding, CROWD_FALLOFF, CROWD_FLOOR } from "./crowding.js";

// The screen-size window the cross-fade happens in, in CSS pixels of object
// height. Under FADE_MIN an object is a smudge and the pin is doing all the
// work; over FADE_MAX the object speaks for itself and the pin is clutter.
const FADE_MIN = 16;
const FADE_MAX = 52;
const CHUNK = 256; // capacity grows in blocks, so ten placements are not ten reallocations

/* A map pin, signed-distance: a disc for the head and a taper down to the
   point that touches the object. Drawn rather than sampled, so the mark is
   crisp at every size and costs no bytes. `p` is the sprite's own UV, centred. */
function pinSDF(p) {
  const head = length(p.sub(vec2(0, 0.28))).sub(0.245);
  const t = clamp(float(0.28).sub(p.y).div(0.74), 0, 1);
  const w = mix(0.245, 0, t.mul(t));
  const tail = max(abs(p.x).sub(w), max(p.y.sub(0.28), float(-0.46).sub(p.y)));
  return min(head, tail);
}

export class Pins {
  constructor({ layer = null } = {}) {
    this.enabled = true;
    this.count = 0;
    this._cap = 0;
    this.uPixels = uniform(600);     // viewportHeight / (2 tan(fov/2)) — px per world unit at 1 m
    this.uSize = uniform(26);        // pin height, CSS pixels (the renderer scales by the DPR)
    this.uOpacity = uniform(0.92);
    this.material = new THREE.PointsNodeMaterial({
      transparent: true, depthWrite: false, sizeAttenuation: false,
      // Pins ignore depth on purpose: an object behind a ridge is exactly the
      // object you cannot find by looking, and it is the one the pin is for.
      depthTest: false, fog: false,
    });
    this.points = new THREE.Sprite(this.material);
    this.points.count = 0;
    this._cap = 0;
    this._grow(CHUNK);
    this.points.name = "fx:pins";
    this.points.frustumCulled = false; // positions are authored, not derived — cull per-pin in the shader
    this.points.renderOrder = 6;
    if (layer != null) this.points.layers.set(layer);
    this.group = new THREE.Group();
    this.group.name = "fx:pins";
    this.group.add(this.points);
  }

  /* The program, rebuilt when the instance buffers grow (a node reads the
     buffer it was built over). The fade is the GLSL's, per instance. */
  _program() {
    const P = instancedBufferAttribute(this._attr.position), radius = instancedBufferAttribute(this._attr.aRadius);
    const flag = instancedBufferAttribute(this._attr.aFlag), crowd = instancedBufferAttribute(this._attr.aCrowd);
    const color = instancedBufferAttribute(this._attr.aColor);
    const m = this.material;
    m.positionNode = P;
    // How tall the object is on screen right now; a selected or newest pin
    // holds on a little longer; crowded pins keep their place and lose weight.
    const dist = max(positionView.z.negate(), 0.001);
    const px = radius.mul(this.uPixels).div(dist);
    const flagged = flag.greaterThan(0.5);
    const fade = clamp(smoothstep(FADE_MAX, FADE_MIN, px).add(select(flagged, float(0.25), float(0))), 0, 1);
    const crowdFade = select(flagged, float(1), float(1).div(crowd.mul(CROWD_FALLOFF).add(1)));
    const alpha = varying(this.uOpacity.mul(fade).mul(max(crowdFade, CROWD_FLOOR)));
    // Hidden pins take no pixels at all (the GLSL moved them off-clip).
    m.sizeNode = select(alpha.greaterThan(0.004), this.uSize.mul(select(flagged, float(1.22), float(1))), float(0));
    const vColor = varying(color), vFlag = varying(flag);
    m.fragmentNode = Fn(() => {
      const q = uv().sub(0.5);
      const d = pinSDF(q);
      const body = smoothstep(0.028, -0.012, d);
      If(body.lessThanEqual(0.01), () => { Discard(); });
      // A dark rim (a pale pin over pale sand is not a pin), and the eye: a hole
      // in the head, where the newest pin puts its brightest value.
      const rim = smoothstep(-0.055, 0, d);
      const eye = smoothstep(0.085, 0.055, length(q.sub(vec2(0, 0.28))));
      const c = mix(vColor, vColor.mul(0.18), rim.mul(0.85));
      const eyeC = mix(vec3(0.05, 0.06, 0.07), vColor.mul(1.9), select(vFlag.greaterThan(1.5), float(1), float(0)));
      return vec4(mix(c, eyeC, eye), body.mul(alpha));
    })();
    m.needsUpdate = true;
  }

  _grow(cap) {
    if (cap <= this._cap) return;
    const next = Math.max(cap, this._cap + CHUNK);
    this._pos = new Float32Array(next * 3);
    this._col = new Float32Array(next * 3);
    this._rad = new Float32Array(next);
    this._flag = new Float32Array(next);
    this._crowd = new Float32Array(next);
    this._attr = {
      position: new THREE.InstancedBufferAttribute(this._pos, 3),
      aColor: new THREE.InstancedBufferAttribute(this._col, 3),
      aRadius: new THREE.InstancedBufferAttribute(this._rad, 1),
      aFlag: new THREE.InstancedBufferAttribute(this._flag, 1),
      aCrowd: new THREE.InstancedBufferAttribute(this._crowd, 1),
    };
    this._cap = next;
    this._program();
  }

  /* The viewport, as the one number the fade needs: pixels of screen height
     per world unit at one metre away. Re-read on resize and on any fov
     change, never per frame. */
  setViewport(heightPx, fovDeg, pixelRatio = 1) {
    const h = Math.max(heightPx, 1) * pixelRatio;
    this.uPixels.value = h / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.uSize.value = 26;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.points.visible = !!on && this.count > 0;
  }
  setOpacity(a) { this.uOpacity.value = a; }

  /* Rebuild from a flat list of { x, y, z, radius, color, flag }. Called on
     placement change, not per frame — the whole design of this file is that
     the frame does nothing. */
  sync(list) {
    const n = list.length;
    this._grow(n);
    const crowd = crowding(list);
    for (let i = 0; i < n; i++) {
      const p = list[i];
      this._pos[i * 3] = p.x;
      this._pos[i * 3 + 1] = p.y;
      this._pos[i * 3 + 2] = p.z;
      const c = p.color ?? 0xffffff;
      // sRGB hex in, linear-ish out: the renderer works in linear space and
      // a pin authored as #8fe8c9 has to still look like #8fe8c9.
      this._col[i * 3] = Math.pow(((c >> 16) & 255) / 255, 2.2);
      this._col[i * 3 + 1] = Math.pow(((c >> 8) & 255) / 255, 2.2);
      this._col[i * 3 + 2] = Math.pow((c & 255) / 255, 2.2);
      this._rad[i] = Math.max(p.radius || 1, 0.25);
      this._flag[i] = p.flag || 0;
      // Crowding rides in the sign of the radius — a spare channel, so a
      // fourth attribute is not paid for on every vertex in the cloud.
      this._crowd[i] = crowd[i];
    }
    this.count = n;
    this.points.count = n;
    for (const a of Object.values(this._attr)) a.needsUpdate = true;
    this.points.visible = this.enabled && n > 0;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
