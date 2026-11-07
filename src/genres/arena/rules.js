/**
 * The arena shooter: from above, twin stick. Move with WASD, the left stick or the left touch pad, read on the
 * north-up screen; aim at the pointer's point on the ground, the right stick or the right touch pad; fire holds.
 * The weapon stack is the shooter's (hitscan, rockets, grenades), carried at the hero's chest: the shots leave from
 * its muzzle and the first-person view model is never drawn.
 */
import { createWeaponSystems } from '../shooter/rules.js';
import { createHeroPresentation } from '../hero/HeroPresentation.js';
import { OverheadCamera, groundPointFromPointer, pointerToNdc, worldMoveToLocal, yawDelta, yawToward } from '../hero/view.js';
import { State } from '../../sim/GameState.js';

/** Where a shot aims above the ground point: a critter's middle. */
const AIM_HEIGHT = 0.7;

export const arenaRules = {
  id: 'arena',
  pointerLock: false,
  view: () => 'overhead',
  createSystems: (session, game, ctx) => createWeaponSystems(session, game, ctx),
  input(session, raw) {
    const p = session.game.player, cam = session.camera;
    let want = null, aimY = p.position.y + AIM_HEIGHT, dist = 6;
    const pad = raw.aim, padOn = pad && Math.hypot(pad.x, pad.y) > 0.3;
    if (padOn) want = Math.atan2(-pad.x, pad.y);
    else if (session.pointer && session.canvas) {
      const pt = groundPointFromPointer(pointerToNdc(session.pointer.x, session.pointer.y, session.canvas.getBoundingClientRect()), cam, p.position.y);
      if (pt) { want = yawToward(p.position, pt); aimY = session.game.terrain.heightAt(pt.x, pt.z) + AIM_HEIGHT; dist = Math.max(1, Math.hypot(pt.x - p.position.x, pt.z - p.position.z)); }
    }
    const turn = want === null ? 0 : yawDelta(p.yaw, want);
    const pitch = Math.max(-0.6, Math.min(0.3, Math.atan2(aimY - (p.position.y + p.eyeHeight), dist)));
    return { ...raw, look: { x: -turn, y: p.pitch - pitch }, move: worldMoveToLocal(raw.move ?? { x: 0, y: 0 }, p.yaw),
      fire: !!raw.fire || (padOn && !!raw.aimFire), ads: false };
  },
  createPlayerVisual(session) {
    const hero = createHeroPresentation(session, { held: 'weapon', weaponId: session.project.weapon });
    // Shots, tracers and the muzzle flash leave from the hero's weapon, not a first-person one.
    if (session.viewmodel) { session.viewmodel.externalMuzzle = hero.muzzle; session.viewmodel.root.visible = false; }
    return {
      update: dt => hero.update(dt, { player: session.game.player, alpha: session.game.alpha, aim: true,
        won: session.game.state.current === State.VICTORY }),
      dispose: () => hero.dispose(),
    };
  },
  updateCamera(session, dt) {
    const cam = session.overhead ??= new OverheadCamera(), p = session.game.player;
    cam.place(session.camera, p.position, dt);
  },
};
