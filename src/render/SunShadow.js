/**
 * ONE SHADOW MAP, SPENT WHERE THE PLAYER IS.
 *
 * The studio's sun used to sit at a fixed position with a fixed 84 x 84 m orthographic
 * frustum over the whole street: 2048 texels across 84 m is a 4 cm texel, and it covered
 * the skyline boxes that never receive a visible shadow as generously as the crate the
 * player is crouched behind. This keeps the same single map and the same light direction
 * and does the two things a cascaded setup does for its first cascade:
 *
 *   FOLLOW   the frustum is centred on the player every frame, at a half-extent that
 *            covers what is on screen at combat range rather than the whole level - so
 *            each texel covers less ground.
 *   SNAP     the centre is rounded to the shadow map's texel grid in light space, so the
 *            map's sampling pattern does not slide across static geometry as the player
 *            walks: without this every shadow edge shimmers with each step.
 *
 * The light direction is fixed by the look (the sun does not follow the player, only the
 * frustum does), which is why it is read from `light.userData.sunDir` rather than from the
 * position: the position is a derived quantity here.
 */

import { Vector3, Matrix4 } from 'three/webgpu';

const _v = new Vector3();
const _snap = new Vector3();
const _rot = new Matrix4();

/**
 * @param {import('three/webgpu').DirectionalLight} light  with `userData.sunDir`, a unit
 *   vector toward the sun
 * @param {import('three/webgpu').Vector3} focus  world point to centre on (the player)
 * @param {{halfExtent?: number, distance?: number, near?: number, far?: number}} [o]
 */
export function fitSunShadow(light, focus, { halfExtent = 26, distance = 70, near = 1, far = 160 } = {}) {
  const dir = light.userData.sunDir;
  if (!dir) return;
  const cam = light.shadow.camera;
  if (cam.right !== halfExtent || cam.far !== far || cam.near !== near) {
    cam.left = -halfExtent; cam.right = halfExtent; cam.top = halfExtent; cam.bottom = -halfExtent;
    cam.near = near; cam.far = far;
    cam.updateProjectionMatrix();
  }
  light.target.position.copy(focus);
  light.position.copy(focus).addScaledVector(dir, distance);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
  light.shadow.updateMatrices(light);

  // Round the world origin to the texel grid in the shadow camera's own frame, then move both
  // ends of the light by that offset in world space so the direction is untouched.
  const texel = (2 * halfExtent) / Math.max(1, light.shadow.mapSize.x);
  // Use the fixed world origin. The focus is always near (0,0) in the camera
  // we just aimed at it, so quantizing that point cannot stabilize the map.
  _v.set(0,0,0).applyMatrix4(cam.matrixWorldInverse);
  const dx = Math.round(_v.x / texel) * texel - _v.x;
  const dy = Math.round(_v.y / texel) * texel - _v.y;
  _rot.extractRotation(cam.matrixWorld);
  _snap.set(-dx, -dy, 0).applyMatrix4(_rot);
  light.position.add(_snap);
  light.target.position.add(_snap);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
  light.shadow.updateMatrices(light);
}
