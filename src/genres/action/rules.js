/**
 * The action adventure: third person with the trail staff. The fire button strikes (MeleeSystem, the blow landing
 * with the hero's swing), jump and interact are the player's own, and the hero is drawn from outside
 * (genres/hero/HeroPresentation.js) under a camera that orbits them (genres/hero/view.js FollowCamera).
 */
import { MeleeSystem } from './MeleeSystem.js';
import { createHeroPresentation } from '../hero/HeroPresentation.js';
import { followInput, placeFollow } from '../hero/thirdPerson.js';
import { State } from '../../sim/GameState.js';

export const actionRules = {
  id: 'action',
  pointerLock: true,
  view: () => 'follow',
  /** Over the right shoulder: the hero stands left of centre and what they run at stays in view. */
  followCamera: { distance: 5, height: 1.55, pitch: 0.28, shoulder: 0.65 },
  createSystems: (session, game) => ({
    melee: new MeleeSystem({
      player: game.player, collision: game.collision, enemies: game.enemies,
      // A strike breaks what bullets break: a mission's barricade takes the blow.
      onWorldImpact: (x, y, z, surface, id, damage) => game.objectives?.damage?.(id, damage),
      onSwing: () => { session.audio?.playOneShot?.('uiClick', { gain: 0.15 }); game.enemies.hear(game.player.position, 6); },
    }),
  }),
  input: (session, raw) => followInput(session, raw, { attack: true }),
  createPlayerVisual(session) {
    const hero = createHeroPresentation(session, { held: 'staff' });
    const melee = () => session.game.extraSystems.find(([k]) => k === 'melee')?.[1];
    return {
      update: dt => hero.update(dt, { player: session.game.player, alpha: session.game.alpha, attacking: !!melee()?.attacking,
        won: session.game.state.current === State.VICTORY, interacting: session.game.interactions.holding }),
      dispose: () => hero.dispose(),
    };
  },
  updateCamera: (session, dt) => placeFollow(session, dt),
};
