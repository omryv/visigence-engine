/**
 * A GAME, PLAYED THROUGH: its levels in order, an ad break between them when the game asks for one, a rewarded
 * continue after the last life when it offers one, and the portal events a web portal counts. The studio's play card
 * (editor/studio.js) shows each moment; this module decides what comes next and tells the portal. No DOM, no three.
 *
 * Portal hooks (docs/EDITOR.md). An exported game calls
 * `window.VisigameHooks`, which does nothing unless a portal's SDK replaces it:
 *
 *   adBreak('between-levels' | 'rewarded') -> Promise<boolean>   resolves when the ad is over; for 'rewarded',
 *                                                                 true when the reward was earned
 *   event(name, data)   gameplayStart, gameplayStop, levelStart, levelComplete, gameOver, gameComplete
 *
 * A portal's failure never stops play: a throw, a rejection or an ad that never ends (AD_TIMEOUT) plays on.
 */
import { levelProject } from '../src/world/level/game.js';

export const PORTAL_EVENTS = ['gameplayStart', 'gameplayStop', 'levelStart', 'levelComplete', 'gameOver', 'gameComplete'];
/** Longest an ad break may hold the game, ms; a rewarded ad that runs out grants nothing. */
export const AD_TIMEOUT = 90000;

/**
 * The page's hooks, made safe to call.
 * @param {object} [source]  the hooks (window.VisigameHooks by default)
 * @param {{timeout?: number, setTimer?: Function}} [o]
 */
export function portalHooks(source = globalThis.VisigameHooks, { timeout = AD_TIMEOUT, setTimer = setTimeout } = {}) {
  const h = source ?? {};
  return {
    adBreak(kind) {
      let ad;
      try { ad = typeof h.adBreak === 'function' ? h.adBreak(kind) : false; } catch { return Promise.resolve(false); }
      return Promise.race([Promise.resolve(ad).then(v => !!v, () => false), new Promise(resolve => setTimer(() => resolve(false), timeout))]);
    },
    event(name, data = {}) { try { h.event?.(name, data); } catch { /* a portal's analytics never stop play */ } },
  };
}

/**
 * @param {object} game   a resolved game (world/shooterProject.js resolveGame)
 * @param {{adBreak: Function, event: Function}} hooks   portalHooks(), or the editor's stand-in
 */
export function createRun(game, hooks) {
  const levels = game.levels, total = levels.length;
  // `finished` and `lost` make each moment report once, however often the play card is drawn for it.
  let index = 0, continued = false, started = false, time = 0, finished = null, lost = false, paused = false;
  const level = () => ({ level: index, name: levels[index].name });
  return {
    game, hooks,
    get index() { return index; },
    get total() { return total; },
    get level() { return levels[index]; },
    get last() { return index === total - 1; },
    /** Has play begun (the title card is behind us)? */
    get started() { return started; },
    /** The flat project the session builds for the level in hand. */
    project: () => levelProject(game, index),
    /** Back to a level (0: from the top) before it is built. */
    go(i) { index = Math.max(0, Math.min(total - 1, i)); continued = false; finished = null; lost = false; if (i === 0) { started = false; time = 0; } },
    /** The player pressed Start (or Retry): the level runs, a fresh attempt with its continue to offer. */
    begin() { started = true; continued = false; finished = null; lost = false; hooks.event('levelStart', level()); hooks.event('gameplayStart', {}); },
    pause() { if (paused) return; paused = true; hooks.event('gameplayStop', {}); },
    resume() { if (!paused) return; paused = false; hooks.event('gameplayStart', {}); },
    /** The game's total play time so far, seconds. */
    get time() { return time; },
    /** The level is won. Returns what comes next: 'next' or 'end'. */
    complete(stats = {}) {
      if (finished) return finished;
      time += stats.time ?? 0;
      hooks.event('levelComplete', { ...level(), time: stats.time ?? 0, kills: stats.kills ?? 0 });
      hooks.event('gameplayStop', {});
      if (index < total - 1) return (finished = 'next');
      hooks.event('gameComplete', { levels: total, time });
      return (finished = 'end');
    },
    /** On to the next level, through an ad break when the game has them. */
    async next() {
      if (game.publish?.adBreaks) await hooks.adBreak('between-levels');
      index = Math.min(total - 1, index + 1); continued = false; finished = null; lost = false;
    },
    /** The last life is gone. */
    over() { if (lost) return; lost = true; hooks.event('gameOver', level()); hooks.event('gameplayStop', {}); },
    /** One rewarded continue per attempt at a level, when the game offers it. */
    get canContinue() { return !!game.publish?.rewardedContinue && !continued; },
    async rewarded() {
      continued = true;
      const earned = await hooks.adBreak('rewarded');
      if (earned) { lost = false; hooks.event('gameplayStart', {}); }
      return earned;
    },
  };
}
