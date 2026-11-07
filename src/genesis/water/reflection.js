// Real planar reflections for the water plane: the scene is rendered a
// second time from a camera mirrored about the waterline into a small HDR
// target, and the water shader samples it projectively, perturbed by the
// wave normal. This is what puts the ACTUAL mountains, buildings and fires
// in the water instead of an analytic sky — the single biggest "real
// renderer" tell there is.
//
// The mirror math and the oblique near-plane clip are the standard Reflector
// recipe (Lengyel's modified projection): everything below the waterline is
// clipped by the projection itself, no renderer clipping planes, no extra
// cost. The engine renders this only on frames it would draw anyway, only
// when the camera is above the water, and at a tier-gated resolution —
// low/medium tiers keep the analytic sky model and never allocate a target.
//
// Layer contract: objects on layer NO_REFLECT_LAYER (grass, weather
// particles, editor helpers) are skipped here; the main camera enables that
// layer explicitly.

import * as THREE from "three";

export const NO_REFLECT_LAYER = 2;

export class WaterReflection {
  constructor(res) {
    this.target = new THREE.RenderTarget(res, res, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.camera = new THREE.PerspectiveCamera();
    this.camera.layers.enable(0);
    this.textureMatrix = new THREE.Matrix4();
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._q = new THREE.Vector4();
    this._rot = new THREE.Matrix4();
    this._lookAt = new THREE.Vector3();
  }

  /* Mirror `camera` about the plane y = waterY and render `scene` into the
     target. `hidden` objects (the water itself, anything one-frame-odd) are
     blanked for the pass. Returns false when the camera is at or below the
     waterline — the caller falls back to the analytic sky. */
  render(renderer, scene, camera, waterY, hidden = [], sun = null) {
    const camPos = camera.getWorldPosition(this._view.set(0, 0, 0));
    if (camPos.y <= waterY + 0.05) return false;

    const v = this.camera;
    // Virtual camera: position mirrored in y, orientation reflected.
    v.position.set(camPos.x, 2 * waterY - camPos.y, camPos.z);
    this._rot.extractRotation(camera.matrixWorld);
    this._lookAt.set(0, 0, -1).applyMatrix4(this._rot).add(camPos);
    this._target.set(this._lookAt.x, 2 * waterY - this._lookAt.y, this._lookAt.z);
    v.up.set(0, 1, 0).applyMatrix4(this._rot);
    v.up.y = -v.up.y;
    v.lookAt(this._target);
    v.coordinateSystem = camera.coordinateSystem;
    v.near = camera.near;
    v.far = camera.far;
    v.updateMatrixWorld();
    v.projectionMatrix.copy(camera.projectionMatrix);

    // Projective texture matrix for the water shader (NDC → [0,1]).
    this.textureMatrix.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1
    );
    this.textureMatrix.multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);

    // Oblique near-plane clip: fold the waterline into the projection so
    // geometry below it never reaches the mirrored image. The third row's
    // form depends on the depth range the backend clips to (WebGPU 0..1,
    // WebGL −1..1): the rule three's own ReflectorNode applies.
    this._plane.setComponents(0, 1, 0, -waterY).applyMatrix4(v.matrixWorldInverse);
    const clip = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const proj = v.projectionMatrix;
    const q = this._q;
    q.x = (Math.sign(clip.x) + proj.elements[8]) / proj.elements[0];
    q.y = (Math.sign(clip.y) + proj.elements[9]) / proj.elements[5];
    q.z = -1.0;
    q.w = (1.0 + proj.elements[10]) / proj.elements[14];
    clip.multiplyScalar(1.0 / clip.dot(q));
    const zeroToOne = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem;
    proj.elements[2] = clip.x;
    proj.elements[6] = clip.y;
    proj.elements[10] = (zeroToOne ? clip.z : clip.z + 1.0) - 0.003; // small bias hides clip shimmer
    proj.elements[14] = clip.w;

    const wasVisible = hidden.map((o) => o && o.visible);
    for (const o of hidden) { if (o) o.visible = false; }
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    // The shadow map is the main view's: reuse it rather than redraw it from
    // the mirrored eye (the sun's own switch, under the node renderer).
    const prevShadow = sun ? sun.shadow.needsUpdate : false;
    if (sun) sun.shadow.needsUpdate = false;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.target);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, v);
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr;
    if (sun) sun.shadow.needsUpdate = prevShadow;
    for (let i = 0; i < hidden.length; i++) { if (hidden[i]) hidden[i].visible = wasVisible[i]; }
    return true;
  }

  dispose() { this.target.dispose(); }
}
