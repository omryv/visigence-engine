/**
 * Third-person input (the action adventure and the collect-a-thon): the look input orbits the camera, the move input
 * is read against the camera, and the hero turns toward where they run at a bounded rate. The simulation sees an
 * ordinary player input (a yaw delta, a forward push), so replays and every system built for the first-person player
 * (collision, interactions, supplies, the level script) work unchanged.
 */
import { Vector3 } from 'three/webgpu';
import { FollowCamera, cameraRelative, yawDelta } from './view.js';

const _feet = new Vector3();

/** The fastest the hero turns in one fixed step, radians: about half a turn in a fifth of a second. */
export const TURN_PER_TICK = 0.26;
/** The hero's aim pitch in third person: a little below level, so the interaction ray finds levers and doors. */
export const AIM_PITCH = -0.24;

/** The camera a genre's rules ask for (`rules.followCamera`), made once per session. */
const followCamera = session => session.follow ??= new FollowCamera(session.rules?.followCamera);

export function followInput(session, raw, { attack = false } = {}) {
  const cam = followCamera(session), p = session.game.player;
  cam.orbit(raw.look?.x ?? 0, (raw.look?.y ?? 0) * 0.8);
  const m = raw.move ?? { x: 0, y: 0 }, mag = Math.min(1, Math.hypot(m.x, m.y));
  let turn = 0, forward = 0;
  if (mag > 0.08 && p.alive) {
    const dir = cameraRelative(m, cam.yaw), d = yawDelta(p.yaw, Math.atan2(-dir.x, -dir.z));
    turn = Math.max(-TURN_PER_TICK, Math.min(TURN_PER_TICK, d));
    // Turning on the spot before a sharp change of direction reads better than a wide arc through a doorway.
    forward = mag * (Math.abs(d) < 1.3 ? 1 : 0.2);
  }
  return { ...raw, look: { x: -turn, y: p.pitch - AIM_PITCH }, move: { x: 0, y: forward },
    attack: attack && !!raw.fire, fire: false, ads: false, reload: false, grenade: false, weapon: null };
}

/** Place the follow camera on the hero's interpolated feet. */
export function placeFollow(session, dt) {
  const cam = followCamera(session), p = session.game.player, a = session.game.alpha;
  const t = p.prevPosition.distanceToSquared(p.position) > 0.25 ? p.position : _feet.copy(p.prevPosition).lerp(p.position, Math.max(0, Math.min(1, a)));
  if (!cam.at) cam.reset(p.yaw);
  cam.place(session.camera, t, session.game.collision, dt);
}
