/**
 * The collect-a-thon: third person, no weapon. Run and jump for the honey drops the mission counts; land on a critter
 * to bop it (StompSystem). Same hero and camera as the action adventure.
 */
import { StompSystem } from './StompSystem.js';
import { createHeroPresentation } from '../hero/HeroPresentation.js';
import { followInput, placeFollow } from '../hero/thirdPerson.js';
import { State } from '../../sim/GameState.js';

export const collectRules = {
  id: 'collect',
  pointerLock: true,
  view: () => 'follow',
  /** High and further back, the hero in the middle: the ground ahead and a jump's landing both show. */
  followCamera: { distance: 6.6, height: 1.2, pitch: 0.46 },
  createSystems: (session, game) => ({
    stomp: new StompSystem({ player: game.player, enemies: game.enemies, onStomp: () => session.audio?.feedback?.('kill') }),
  }),
  input: (session, raw) => followInput(session, raw),
  createPlayerVisual(session) {
    const hero = createHeroPresentation(session);
    return {
      update: dt => hero.update(dt, { player: session.game.player, alpha: session.game.alpha,
        won: session.game.state.current === State.VICTORY, interacting: session.game.interactions.holding }),
      dispose: () => hero.dispose(),
    };
  },
  updateCamera: (session, dt) => placeFollow(session, dt),
};
