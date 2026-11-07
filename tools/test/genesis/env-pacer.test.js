/* When the sky IBL re-captures, and how big.
 *
 * This is the suite standing in for a browser that cannot answer the
 * question. Every capture allocates and frees a mip-chained PMREM target —
 * 6.3 MB at a 256 cube edge, 1.6 MB at 128 — so a drag of the hour, which
 * re-dirties the capture continuously, is worth taking cheaply. The rule that
 * decides is four lines long and has been wrong twice, and both times the bug
 * was invisible in any single frame: it was a PATTERN, a one-off change
 * paying for two captures or a live drag alternating cheap and expensive ones
 * so that the whole thing cost more than never having optimised it.
 *
 * That pattern cannot be produced in the browser tools this repository has.
 * On the software rasteriser they drive, one frame takes between 0.7 and 2.6
 * seconds — measured, not guessed — so synthetic input arrives faster than
 * frames do and a drag is not reproducible at any speed. Driven directly with
 * a list of (dt, dirty) pairs, every sequence below is three lines.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import {
  createEnvPacer, envCapture,
  ENV_COOLDOWN, ENV_SETTLE, ENV_SIZE_FULL, ENV_SIZE_DRAG,
} from "../../../src/genesis/render/env-pacer.js";

/* Run a scripted sequence of frames and return every capture it produced.
   `frames` is [dt, dirty] pairs; dirty stays raised until a capture consumes
   it, exactly as the engine's own flag does. */
function run(frames) {
  const s = createEnvPacer();
  const caps = [];
  let dirty = false;
  for (const [dt, raise] of frames) {
    if (raise) dirty = true;
    const size = envCapture(s, dt, dirty);
    if (size) { caps.push(size); if (dirty) dirty = false; }
  }
  return caps;
}

// A drag: the light is dirtied on every frame for `secs`, then nothing.
const drag = (dt, secs, tail = 3) => [
  ...Array.from({ length: Math.round(secs / dt) }, () => [dt, true]),
  ...Array.from({ length: Math.round(tail / dt) }, () => [dt, false]),
];

test("a one-off change captures once, at full quality", () => {
  /* The common case by a distance — a world rebuilt, a palette swapped, a
     biome changed — and the case the first attempt at this regressed: it
     captured cheap unconditionally and then owed a full one, so the single
     most frequent operation in the editor started costing two captures
     where it had always cost one. */
  const caps = run([[0.016, true], ...Array.from({ length: 200 }, () => [0.016, false])]);
  eq(caps.length, 1, `a single change produced ${caps.length} captures (${caps.join(",")})`);
  eq(caps[0], ENV_SIZE_FULL, "a one-off change must be captured at full quality");
});

test("a drag captures cheaply after the first, and lands full when it stops", () => {
  const caps = run(drag(0.016, 3));
  eq(caps[0], ENV_SIZE_FULL, "the first capture cannot know it is a drag, so it must be full");
  const middle = caps.slice(1, -1);
  ok(middle.length > 0, "a three-second drag produced no intermediate captures");
  ok(middle.every((s) => s === ENV_SIZE_DRAG),
    `intermediate captures were ${middle.join(",")}, expected all ${ENV_SIZE_DRAG}`);
  eq(caps[caps.length - 1], ENV_SIZE_FULL, "the capture left on screen must be the full-quality one");
});

test("no full-quality capture lands in the MIDDLE of a drag", () => {
  /* The worst outcome an optimisation can have: costing more than not doing
     it. Both broken versions produced exactly that — a drag that alternated
     cheap and full captures, or one made entirely of full ones.

     THE SLOW FRAME TIMES IN THIS LIST ARE THE POINT, and they are measured
     rather than invented: 0.7 and 0.9 bracket what one frame actually takes
     on the software rasteriser the repository's browser tools run against.
     A version that decides "is this a drag" from how recently the last
     CAPTURE landed passes every fast frame time here and fails from 0.7
     upward, because capture spacing is bounded by frame time — so without
     these entries the test would be green against the very bug it is named
     for. Checked: the list catches it, [0.008 … 0.25] alone does not. */
  for (const dt of [0.008, 0.016, 0.033, 0.1, 0.25, 0.7, 0.9]) {
    const caps = run(drag(dt, 6));
    const middle = caps.slice(1, -1);
    ok(!middle.includes(ENV_SIZE_FULL),
      `at dt ${dt}s the drag captured full quality mid-drag (${caps.join(",")}) — this costs more than not optimising`);
  }
});

test("the saving survives a slow machine, which is the machine that needs it", () => {
  /* The second bug: deciding "is this a drag" from how recently the last
     CAPTURE landed. Capture spacing is bounded by frame time, so on a slow
     machine every capture looks like an isolated nudge and the optimisation
     silently switches itself off — on exactly the hardware it was written
     for. Whether new changes keep arriving is a property of the input, so at
     any frame rate a drag must still come out mostly cheap. */
  for (const dt of [0.016, 0.2, 0.5, 0.9]) {
    const caps = run(drag(dt, 6));
    const cheap = caps.filter((s) => s === ENV_SIZE_DRAG).length;
    ok(caps.length >= 3, `at dt ${dt}s a six-second drag produced only ${caps.length} captures`);
    ok(cheap >= caps.length - 2,
      `at dt ${dt}s only ${cheap} of ${caps.length} captures were cheap — the saving has switched itself off`);
  }
});

test("the debounce holds however fast the light is dirtied", () => {
  // 60 dirty ticks a second must not become 60 PMREM captures a second.
  const dt = 1 / 60, secs = 4;
  const caps = run(drag(dt, secs, 0));
  const ceiling = Math.ceil(secs / ENV_COOLDOWN) + 1;
  ok(caps.length <= ceiling,
    `${caps.length} captures in ${secs}s of dragging, over the ${ceiling} the ${ENV_COOLDOWN}s debounce allows`);
});

test("a light that stops is captured full exactly once, then left alone", () => {
  // The settle must not re-arm itself — an earlier version decremented past
  // zero and re-fired on every subsequent frame.
  const caps = run(drag(0.016, 2, 20));
  const tail = caps.slice(1);
  eq(tail.filter((s) => s === ENV_SIZE_FULL).length, 1,
    `the settle fired ${tail.filter((s) => s === ENV_SIZE_FULL).length} times; it must fire once`);
});

test("changes further apart than the settle are nudges, not a drag", () => {
  /* If the light only moves every couple of seconds, every capture is one
     somebody looks at, and none of them should be the cheap size. */
  const frames = [];
  for (let i = 0; i < 6; i++) {
    frames.push([0.016, true]);
    for (let k = 0; k < Math.round((ENV_SETTLE * 2) / 0.016); k++) frames.push([0.016, false]);
  }
  const caps = run(frames);
  ok(caps.every((s) => s === ENV_SIZE_FULL),
    `well-separated changes were captured ${caps.join(",")} — each is on screen for seconds and must be full`);
  eq(caps.length, 6, `six separated changes produced ${caps.length} captures`);
});

test("nothing happening captures nothing", () => {
  eq(run(Array.from({ length: 500 }, () => [0.016, false])).length, 0,
    "a still world re-captured its environment with nothing to re-capture");
});

report("env-pacer");
