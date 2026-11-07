// node tools/test/test-reload-audio.mjs
// AudioVoices.releaseActionVoice: a finished action lets its voice play out, and the action id
// is free for a fresh voice immediately, with the old voice's own end never touching the new
// mapping. The Web Audio graph is a minimal double: only what AudioVoices calls.
import assert from 'node:assert/strict';
import { AudioVoices } from '../../src/audio/AudioVoices.js';

let now = 0;
const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
const node = () => ({ connect() {}, disconnect() {} });
const sources = [];
const ctx = {
  get currentTime() { return now; },
  createGain: () => ({ ...node(), gain: param() }),
  createBufferSource() {
    const src = { ...node(), playbackRate: param(), started: null, stoppedAt: null, start(when, offset, duration) { src.started = { offset, duration }; }, stop(at) { src.stoppedAt = at; } };
    sources.push(src); return src;
  },
};
const voices = new AudioVoices(ctx, node());
const asset = { file: 'shotgun-reload.mp3', bus: 'player', gain: .4 };
const buffer = { duration: 4.4 };

// A reload starts its voice; while it runs, asking again is the no-op the layer promises.
const first = voices.startActionVoice('player:shotgun-reload', buffer, asset);
assert.equal(voices.startActionVoice('player:shotgun-reload', buffer, asset), first);
assert.equal(voices.live.size, 1); assert.equal(sources.length, 1);

// The reload completes at 3.2 s: release, not stop. The source keeps playing.
now = 3.2;
assert.equal(voices.releaseActionVoice('player:shotgun-reload'), true);
assert.equal(voices.releaseActionVoice('player:shotgun-reload'), false, 'nothing left to release');
assert.equal(first.src.stoppedAt, null, 'a released voice is never stopped');
assert.equal(first.stopping, false);
assert.equal(voices.isActionVoicePlaying('player:shotgun-reload'), false, 'the action id is free');
assert.equal(voices.live.size, 1, 'the tail is still live');

// A new reload right away gets its own voice, overlapping the tail rather than being swallowed by it.
now = 3.5;
const second = voices.startActionVoice('player:shotgun-reload', buffer, asset);
assert.notEqual(second, first); assert.equal(voices.live.size, 2); assert.equal(sources.length, 2);
assert.equal(voices.getActionVoice('player:shotgun-reload'), second);

// The tail ends on its own: it leaves `live` and does not disturb the new voice's mapping.
now = 4.4; first.src.onended();
assert.equal(voices.live.size, 1);
assert.equal(voices.getActionVoice('player:shotgun-reload'), second, 'the old voice\'s end never deletes the new mapping');

// Cancelling the second one still cuts it (a weapon switch mid-reload).
assert.equal(voices.stopActionVoice('player:shotgun-reload', 60), true);
assert.equal(second.stopping, true); assert.ok(second.src.stoppedAt > now, 'cancel schedules a stop after the fade');
assert.equal(voices.isActionVoicePlaying('player:shotgun-reload'), false);

// stopAll still reaches a released tail (a run reset silences everything).
const third = voices.startActionVoice('player:pistol-reload', { duration: 2 }, { ...asset, file: 'pistol-reload.mp3' });
voices.releaseActionVoice('player:pistol-reload');
voices.stopAll(40);
assert.equal(third.stopping, true, 'a released tail is not exempt from stopAll');
console.log('PASS release lets a finished action\'s voice play out, frees the action id, and cancel/stopAll still cut');
