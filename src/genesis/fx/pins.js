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
 * COST. One BufferGeometry, one draw call, one point per placement, rebuilt
 * only when the set of placements changes. Ten thousand pins are ten
 * thousand vertices — less than a single terrain tile — and the per-frame
 * cost is zero, because the fade lives entirely in the shader. That is why
 * it is a Points cloud rather than a sprite per object: sprites would be ten
 * thousand objects for the scene graph to walk, sort and cull every frame.
 *
 * The pin is drawn procedurally in the fragment shader (a teardrop SDF), so
 * there is no texture, no atlas and nothing to fetch — the same zero-byte
 * discipline the props themselves are built under.
 */

import * as THREE from "three";
import { crowding, CROWD_FALLOFF, CROWD_FLOOR } from "./crowding.js";

// The screen-size window the cross-fade happens in, in CSS pixels of object
// height. Under FADE_MIN an object is a smudge and the pin is doing all the
// work; over FADE_MAX the object speaks for itself and the pin is clutter.
const FADE_MIN = 16;
const FADE_MAX = 52;
const CHUNK = 256; // capacity grows in blocks, so ten placements are not ten reallocations

const VERT = /* glsl */`
  attribute float aRadius;   // the object's own world radius
  attribute vec3 aColor;
  attribute float aFlag;     // 0 ordinary · 1 selected · 2 newest
  attribute float aCrowd;    // how many other placements share this pin's patch of ground
  uniform float uPixels;     // viewportHeight / (2 tan(fov/2)) — px per world unit at 1 m
  uniform float uSize;       // pin height in device pixels
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFlag;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 0.001);
    // How tall the object is on screen right now.
    float px = aRadius * uPixels / dist;
    float fade = smoothstep(${FADE_MAX.toFixed(1)}, ${FADE_MIN.toFixed(1)}, px);
    // A selected or newest pin holds on a little longer — those are the two
    // the author is most likely to be looking for.
    fade = clamp(fade + (aFlag > 0.5 ? 0.25 : 0.0), 0.0, 1.0);
    /* A hedge of forty fence posts does not need forty hard markers — that is
       an inventory, not a signpost, and it is the one way this layer can end
       up worse than no layer. Crowded pins keep their position and lose their
       weight, so a dense run reads as one soft mass while an isolated object
       an author might genuinely lose stays a crisp pin. Anything selected,
       newest or starred is exempt: those are the ones being looked for. */
    float crowdFade = aFlag > 0.5 ? 1.0 : 1.0 / (1.0 + aCrowd * ${CROWD_FALLOFF});
    vAlpha = uOpacity * fade * max(crowdFade, ${CROWD_FLOOR});
    vColor = aColor;
    vFlag = aFlag;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (aFlag > 0.5 ? 1.22 : 1.0);
    if (vAlpha <= 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-clip, never rasterised
  }
`;

/* A map pin, signed-distance: a disc for the head and a taper down to the
   point that touches the object. Drawn rather than sampled, so the mark is
   crisp at every size and costs no bytes. */
const FRAG = /* glsl */`
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFlag;
  float pin(vec2 p) {
    float head = length(p - vec2(0.0, 0.28)) - 0.245;
    float t = clamp((0.28 - p.y) / 0.74, 0.0, 1.0);
    float w = mix(0.245, 0.0, t * t);
    float tail = max(abs(p.x) - w, max(p.y - 0.28, -0.46 - p.y));
    return min(head, tail);
  }
  void main() {
    vec2 p = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
    float d = pin(p);
    float body = smoothstep(0.028, -0.012, d);
    if (body <= 0.01) discard;
    // A dark rim, because a pale pin over pale sand is not a pin.
    float rim = smoothstep(-0.055, 0.0, d);
    // The eye of the pin: a hole in the head so it reads as a marker rather
    // than a blob, and the one place the newest pin puts its brightest value.
    float eye = smoothstep(0.085, 0.055, length(p - vec2(0.0, 0.28)));
    vec3 c = mix(vColor, vColor * 0.18, rim * 0.85);
    c = mix(c, mix(vec3(0.05, 0.06, 0.07), vColor * 1.9, vFlag > 1.5 ? 1.0 : 0.0), eye);
    gl_FragColor = vec4(c, body * vAlpha);
  }
`;

export class Pins {
  constructor({ layer = null } = {}) {
    this.enabled = true;
    this.count = 0;
    this._cap = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixels: { value: 600 },
        uSize: { value: 26 },
        uOpacity: { value: 0.92 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      // Pins ignore depth on purpose: an object behind a ridge is exactly the
      // object you cannot find by looking, and it is the one the pin is for.
      depthTest: false,
    });
    this.geometry = new THREE.BufferGeometry();
    this._grow(CHUNK);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = "fx:pins";
    this.points.frustumCulled = false; // positions are authored, not derived — cull per-point in the shader
    this.points.renderOrder = 6;
    if (layer != null) this.points.layers.set(layer);
    this.group = new THREE.Group();
    this.group.name = "fx:pins";
    this.group.add(this.points);
  }

  _grow(cap) {
    if (cap <= this._cap) return;
    const next = Math.max(cap, this._cap + CHUNK);
    this._pos = new Float32Array(next * 3);
    this._col = new Float32Array(next * 3);
    this._rad = new Float32Array(next);
    this._flag = new Float32Array(next);
    this._crowd = new Float32Array(next);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this._pos, 3));
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(this._col, 3));
    this.geometry.setAttribute("aRadius", new THREE.BufferAttribute(this._rad, 1));
    this.geometry.setAttribute("aFlag", new THREE.BufferAttribute(this._flag, 1));
    this.geometry.setAttribute("aCrowd", new THREE.BufferAttribute(this._crowd, 1));
    this._cap = next;
  }

  /* The viewport, as the one number the fade needs: pixels of screen height
     per world unit at one metre away. Re-read on resize and on any fov
     change, never per frame. */
  setViewport(heightPx, fovDeg, pixelRatio = 1) {
    const h = Math.max(heightPx, 1) * pixelRatio;
    this.material.uniforms.uPixels.value = h / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.material.uniforms.uSize.value = 26 * pixelRatio;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.points.visible = !!on && this.count > 0;
  }
  setOpacity(a) { this.material.uniforms.uOpacity.value = a; }

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
    this.geometry.setDrawRange(0, n);
    for (const name of ["position", "aColor", "aRadius", "aFlag", "aCrowd"]) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
    this.points.visible = this.enabled && n > 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
