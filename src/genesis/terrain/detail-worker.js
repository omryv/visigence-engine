// The material stack, generated off the main thread.
//
// Same shape as masks-worker.js and skyvis-worker.js: a pure function of the
// seed goes in, transferable buffers come back, and the main thread never
// stalls on it.
//
// This one exists BECAUSE the stack grew. Three materials took about 125 ms
// to draw; ten take about 420, and 420 ms is a visible hitch in the middle of
// a world build — the one moment the person watching is looking hardest at
// the ground. It is only movable at all because terrain/detail-layers.js was
// made pure when it was made a stack: the old generator reached for
// ImageData and document.createElement, and neither exists here.
//
// A late stack is not a broken one. The terrain material compiles with its
// array samplers already bound and `uDetOn` gating them, so the world renders
// on the palette's vertex colours until this lands and then gains its
// materials — exactly how the control map and the sky-visibility bake behave.

import { makeLayerStack } from "./detail-layers.js";

self.onmessage = (ev) => {
  const { seed, only } = ev.data;
  const stack = makeLayerStack(seed, { only: only || null });
  self.postMessage(
    { albedo: stack.albedo.buffer, normal: stack.normal.buffer, norm: stack.norm.buffer,
      res: stack.res, count: stack.count },
    [stack.albedo.buffer, stack.normal.buffer, stack.norm.buffer]);
};
