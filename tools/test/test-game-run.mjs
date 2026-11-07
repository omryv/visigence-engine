// A game of levels played through (editor/gameRun.js): the order of the portal events, ad breaks between levels only
// when the game has them, one rewarded continue per attempt, each moment reported once, and portal hooks that
// throw, reject or never finish never stop play.
import assert from 'node:assert/strict';
import { createRun, portalHooks, PORTAL_EVENTS } from '../../editor/gameRun.js';
import { resolveGame } from '../../src/world/shooterProject.js';
import { templateGame } from '../../src/world/level/templates.js';

const recorder = ({ reward = true } = {}) => {
  const log = [];
  return { log, adBreak: kind => { log.push(['ad', kind]); return Promise.resolve(kind === 'rewarded' ? reward : false); }, event: (name, data) => log.push([name, data]) };
};
const names = log => log.map(([n, d]) => n === 'ad' ? `ad:${d}` : n);
const base = resolveGame(templateGame('trail-warden'));

{
  // No ad breaks: three levels, then the game is complete.
  const hooks = recorder(), run = createRun({ ...base, publish: { adBreaks: false, rewardedContinue: false, showCredits: true } }, hooks);
  assert.equal(run.total, 3); assert.equal(run.started, false); assert.equal(run.project().seed, base.levels[0].seed);
  run.begin(); assert.equal(run.started, true);
  run.pause(); run.pause(); run.resume(); run.resume();
  assert.equal(run.complete({ time: 40, kills: 3 }), 'next');
  assert.equal(run.complete({ time: 40 }), 'next', 'a repeated card reports once');
  await run.next(); assert.equal(run.index, 1); assert.equal(run.project().seed, base.levels[1].seed);
  run.begin(); run.complete({ time: 50 }); await run.next();
  run.begin(); assert.equal(run.last, true); assert.equal(run.complete({ time: 60 }), 'end');
  assert.equal(run.time, 150);
  assert.deepEqual(names(hooks.log), [
    'levelStart', 'gameplayStart', 'gameplayStop', 'gameplayStart', 'levelComplete', 'gameplayStop',
    'levelStart', 'gameplayStart', 'levelComplete', 'gameplayStop',
    'levelStart', 'gameplayStart', 'levelComplete', 'gameplayStop', 'gameComplete']);
  assert.deepEqual(hooks.log.find(([n]) => n === 'levelComplete')[1], { level: 0, name: base.levels[0].name, time: 40, kills: 3 });
  assert.deepEqual(hooks.log.at(-1)[1], { levels: 3, time: 150 });
  assert.ok(hooks.log.every(([n]) => n === 'ad' || PORTAL_EVENTS.includes(n)), 'only the documented events');
  run.go(0); assert.equal(run.started, false, 'play again starts at the title'); assert.equal(run.time, 0);
}
{
  // Ad breaks between levels (never after the last), a rewarded continue once per attempt.
  const hooks = recorder(), run = createRun({ ...base, publish: { adBreaks: true, rewardedContinue: true, showCredits: false } }, hooks);
  run.begin();
  run.over(); run.over();
  assert.equal(run.canContinue, true);
  assert.equal(await run.rewarded(), true); assert.equal(run.canContinue, false, 'one continue per attempt');
  run.over(); assert.equal(names(hooks.log).filter(n => n === 'gameOver').length, 2, 'a second loss after a continue reports again');
  run.begin(); assert.equal(run.canContinue, true, 'a retry is a fresh attempt');
  run.complete(); await run.next();
  run.begin(); run.complete(); await run.next();
  run.begin(); run.complete();
  assert.deepEqual(names(hooks.log).filter(n => n.startsWith('ad:')), ['ad:rewarded', 'ad:between-levels', 'ad:between-levels']);
  const refused = createRun({ ...base, publish: { rewardedContinue: true } }, recorder({ reward: false }));
  refused.begin(); refused.over(); assert.equal(await refused.rewarded(), false);
  assert.equal(createRun({ ...base, publish: { rewardedContinue: false } }, recorder()).canContinue, false, 'no continue unless the game offers one');
}
{
  // The page's hooks, made safe: missing, throwing, rejecting, hanging, truthy values.
  const none = portalHooks(undefined);
  assert.equal(await none.adBreak('between-levels'), false); none.event('levelStart', {});
  const thrower = portalHooks({ adBreak() { throw Error('sdk'); }, event() { throw Error('sdk'); } });
  assert.equal(await thrower.adBreak('rewarded'), false); thrower.event('gameOver', {});
  assert.equal(await portalHooks({ adBreak: () => Promise.reject(Error('no fill')) }).adBreak('rewarded'), false);
  assert.equal(await portalHooks({ adBreak: () => Promise.resolve('yes') }).adBreak('rewarded'), true);
  const timers = [];
  const hang = portalHooks({ adBreak: () => new Promise(() => {}) }, { timeout: 5, setTimer: (fn, ms) => timers.push([fn, ms]) });
  const pending = hang.adBreak('between-levels');
  assert.equal(timers[0][1], 5); timers[0][0]();
  assert.equal(await pending, false, 'an ad that never ends lets the game go on');
  const seen = [];
  portalHooks({ event: (n, d) => seen.push([n, d]) }).event('levelStart', { level: 2 });
  assert.deepEqual(seen, [['levelStart', { level: 2 }]]);
}
console.log('Game run: portal events in order and once, ad breaks between levels only when on, one rewarded continue per attempt, safe hooks');
