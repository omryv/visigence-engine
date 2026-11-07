/* The durability link, driven with an owned clock and a fake file.
 *
 * Every bug this module can have is a bug about a SEQUENCE — a change landing
 * while a write is open, a drag that never goes still, a write that fails and
 * must not go quiet — and none of them is visible in a single step. That is
 * the whole reason the module takes `write`, `serialize` and `now` as
 * arguments instead of reaching for the File System Access API: here they are
 * three lines each, and in a browser they are close to unreproducible.
 *
 * THE SCENARIOS RUN AT TOP LEVEL AND THE ASSERTIONS ARE SYNCHRONOUS, which is
 * the shape tests/vault.test.js already uses and is not a stylistic choice:
 * `test()` in the harness calls `fn()` and counts a pass the moment it
 * returns. Hand it an async body and it prints "ok" for a test that has not
 * run yet, and the rejection lands later as an unhandled one — thirteen green
 * lines that prove nothing. So each scenario below is played to completion
 * first and reduced to a plain object of what happened; the harness then gets
 * the synchronous facts it was built to check.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { createDurableLink, SAVE_QUIET_MS, SAVE_MAX_WAIT_MS, isFileLinkSupported } from "../../../src/genesis/world/durable.js";

/* A file that records what was written to it, and can be told to refuse.
   `gate` holds a write open so a scenario can act while the stream is in
   flight — the state most of the interesting bugs live in. */
function fakeFile() {
  const f = { writes: [], calls: 0, fail: null, gate: null, open: 0, mostOpenAtOnce: 0 };
  f.write = async (text) => {
    f.calls++;
    f.open++;
    f.mostOpenAtOnce = Math.max(f.mostOpenAtOnce, f.open);
    try {
      if (f.gate) await f.gate;
      if (f.fail) throw new Error(f.fail);
      f.writes.push(text);
    } finally {
      f.open--;
    }
  };
  return f;
}

function rig({ quiet = SAVE_QUIET_MS, maxWait = SAVE_MAX_WAIT_MS } = {}) {
  const file = fakeFile();
  const clock = { t: 1000 };
  let world = "world-0";
  const link = createDurableLink({
    write: file.write,
    serialize: () => world,
    now: () => clock.t,
    quiet, maxWait,
  });
  return {
    file, link,
    advance: (ms) => { clock.t += ms; },
    edit: (v) => { world = v; link.touch(); },
  };
}

/* ── the scenarios, played out ────────────────────────────────────────── */

const unlinked = await (async () => {
  const r = rig();
  r.edit("a");
  r.advance(10_000);
  await r.link.tick();
  return { calls: r.file.calls, state: r.link.state() };
})();

const debounced = await (async () => {
  const r = rig();
  r.link.attach("castle.world.json");
  r.edit("a");
  await r.link.tick();
  const during = { calls: r.file.calls, state: r.link.state() };
  r.advance(SAVE_QUIET_MS);
  await r.link.tick();
  return { during, after: { calls: r.file.calls, writes: r.file.writes, state: r.link.state() } };
})();

const drag = await (async () => {
  const r = rig();
  r.link.attach("f");
  for (let i = 0; i < 60; i++) { r.edit(`edit-${i}`); r.advance(16); await r.link.tick(); }
  const mid = r.file.calls;
  r.advance(SAVE_QUIET_MS);
  await r.link.tick();
  return { mid, calls: r.file.calls, writes: r.file.writes };
})();

const relentless = await (async () => {
  // The debounce alone would wait forever: an unbroken sculpt touches faster
  // than the quiet window every time, so nothing would ever be written.
  const r = rig();
  r.link.attach("f");
  let wrote = 0;
  for (let i = 0; i < 400; i++) {
    r.edit(`e${i}`);
    r.advance(50);                 // never still for a full quiet period
    if (await r.link.tick()) wrote++;
  }
  return { wrote, writes: r.file.writes };
})();

const latest = await (async () => {
  const r = rig();
  r.link.attach("f");
  r.edit("first");
  r.advance(SAVE_QUIET_MS / 2);
  r.edit("second");               // still inside the window
  r.advance(SAVE_QUIET_MS);
  await r.link.tick();
  return { writes: r.file.writes };
})();

const midWrite = await (async () => {
  const r = rig();
  r.link.attach("f");
  r.edit("a");
  r.advance(SAVE_QUIET_MS);

  let release;
  r.file.gate = new Promise((res) => { release = res; });
  const first = r.link.tick();     // opens the stream and blocks inside it

  // The author keeps working while the stream is open. This state was not in
  // the text that was serialized, so it must survive as unsaved work.
  r.edit("b");
  const dirtyMidWrite = r.link.state().dirty;

  // A tick now must not open a second stream on the same file.
  await r.link.tick();
  const openStreams = r.file.open;

  release();
  await first;
  const owedAfter = r.link.state().dirty;

  r.file.gate = null;
  r.advance(SAVE_QUIET_MS);
  await r.link.tick();
  return {
    dirtyMidWrite, openStreams, owedAfter,
    writes: r.file.writes, mostOpenAtOnce: r.file.mostOpenAtOnce,
  };
})();

const refused = await (async () => {
  const r = rig();
  r.link.attach("f");
  r.edit("a");
  r.advance(SAVE_QUIET_MS);

  r.file.fail = "the file was moved";
  await r.link.tick();
  const failed = { state: r.link.state(), written: r.file.writes.length };

  // It backs off a quiet period rather than hot-looping on a dead handle.
  await r.link.tick();
  const insideBackoff = r.file.calls;

  r.advance(SAVE_QUIET_MS);
  r.file.fail = null;
  await r.link.tick();
  return { failed, insideBackoff, writes: r.file.writes, state: r.link.state() };
})();

const undescribable = await (async () => {
  const file = fakeFile();
  const clock = { t: 0 };
  let boom = true;
  const link = createDurableLink({
    write: file.write,
    serialize: () => { if (boom) throw new Error("half-built world"); return "ok"; },
    now: () => clock.t,
  });
  link.attach("f");
  link.touch();
  clock.t += SAVE_QUIET_MS;
  await link.tick();
  const broken = { calls: file.calls, state: link.state() };

  boom = false;
  clock.t += SAVE_QUIET_MS;
  await link.tick();
  return { broken, writes: file.writes };
})();

const flushed = await (async () => {
  const r = rig();
  r.link.attach("f");
  r.edit("a");
  await r.link.tick();
  const beforeFlush = r.file.calls;
  await r.link.flush();
  const dirtyWrites = [...r.file.writes];

  const clean = rig();
  clean.link.attach("f");
  await clean.link.flush();
  return { beforeFlush, dirtyWrites, cleanCalls: clean.file.calls };
})();

const detached = await (async () => {
  const r = rig();
  r.link.attach("f");
  r.edit("a");
  r.link.detach();
  r.advance(SAVE_QUIET_MS * 10);
  await r.link.tick();
  await r.link.flush();
  return { calls: r.file.calls, state: r.link.state() };
})();

const watched = await (async () => {
  const r = rig();
  const seen = [];
  const off = r.link.onChange((st) => seen.push(st));
  r.link.attach("castle.world.json");
  const onAttach = seen.length;

  r.edit("a");
  const sawDirty = seen.some((st) => st.dirty);
  const afterFirstEdit = seen.length;
  r.edit("b"); r.edit("c");
  const afterMoreEdits = seen.length;

  r.advance(SAVE_QUIET_MS);
  await r.link.tick();
  const last = seen[seen.length - 1];

  off();
  const beforeUnsub = seen.length;
  r.edit("d");
  return {
    onAttach, name: seen[0].name, sawDirty, afterFirstEdit, afterMoreEdits,
    last, beforeUnsub, afterUnsub: seen.length,
  };
})();

/* ── what all that proved ─────────────────────────────────────────────── */

test("outside a browser the capability probe is honest, and says no", () => {
  eq(isFileLinkSupported(), false,
    "node has no showSaveFilePicker — the editor must fall back rather than throw");
});

test("nothing is written until a file has been chosen", () => {
  eq(unlinked.calls, 0, "an unlinked world writes nowhere");
  eq(unlinked.state.linked, false);
});

test("a change is not written the instant it happens", () => {
  eq(debounced.during.calls, 0, "still inside the quiet window");
  ok(debounced.during.state.dirty, "and the editor knows there is unsaved work");
  eq(debounced.after.calls, 1, "the world went still, so it was written");
  eq(debounced.after.writes[0], "a");
  eq(debounced.after.state.dirty, false, "and is clean again");
});

test("a burst of edits is one write, not one per edit", () => {
  eq(drag.mid, 0, "a drag in progress writes nothing");
  eq(drag.calls, 1, "one write for the whole drag");
  eq(drag.writes[0], "edit-59", "and it is the LAST state, not the first");
});

test("a world that never goes still is still checkpointed", () => {
  ok(relentless.wrote >= 2,
    `a 20-second unbroken drag checkpointed ${relentless.wrote} times, not never`);
  ok(relentless.writes.every((w) => w.startsWith("e")), "and wrote real states");
});

test("serialization happens at write time, so what lands is what is on screen", () => {
  eq(latest.writes[0], "second", "the write carries the newer state");
});

test("a change made DURING a write is not folded into it and not lost", () => {
  ok(midWrite.dirtyMidWrite, "the new change is dirty even mid-write");
  eq(midWrite.openStreams, 1, "a tick mid-write does not open a second stream");
  eq(midWrite.writes[0], "a");
  ok(midWrite.owedAfter, "b is still owed when the first write finishes");
  eq(midWrite.writes[1], "b", "and b lands in a write of its own");
  eq(midWrite.mostOpenAtOnce, 1, "the file never had two writers at once");
});

test("a failed write keeps the work, says so, and keeps trying", () => {
  ok(refused.failed.state.dirty, "nothing landed, so the work is still unsaved");
  ok(refused.failed.state.error && refused.failed.state.error.includes("moved"),
    "and the failure is reportable, not swallowed");
  eq(refused.failed.state.failures, 1);
  eq(refused.failed.written, 0);
  eq(refused.insideBackoff, 1, "no retry inside the backoff");
  eq(refused.writes[0], "a", "and when the file comes back, the work is written");
  eq(refused.state.dirty, false);
  eq(refused.state.error, null, "the error clears on success");
  eq(refused.state.failures, 0);
});

test("a serializer that throws is reported, and costs nothing else", () => {
  eq(undescribable.broken.calls, 0, "a world that cannot be described is not written");
  ok(undescribable.broken.state.error.includes("half-built"), "the reason is on the record");
  ok(undescribable.broken.state.dirty, "the work is still owed");
  eq(undescribable.writes[0], "ok", "and it goes out once it can be described");
});

test("flush writes immediately, however recently the world moved", () => {
  eq(flushed.beforeFlush, 0, "the heartbeat waits");
  eq(flushed.dirtyWrites[0], "a", "leaving does not");
  eq(flushed.cleanCalls, 0, "and a clean world has nothing to say");
});

test("detaching forgets the file, and nothing is written to it afterwards", () => {
  eq(detached.calls, 0, "a detached link writes nowhere — this is what stops Open");
  eq(detached.state.linked, false);
  eq(detached.state.dirty, false, "and it carries no unsaved work of its own");
});

test("the interface hears about the states it has to draw", () => {
  eq(watched.onAttach, 1, "linking is news");
  eq(watched.name, "castle.world.json");
  ok(watched.sawDirty, "so is the first unsaved change");
  eq(watched.afterMoreEdits, watched.afterFirstEdit,
    "…but a drag does not repaint the indicator per move");
  eq(watched.last.dirty, false);
  ok(watched.last.savedAt > 0, "and the moment it landed is available to show");
  eq(watched.afterUnsub, watched.beforeUnsub, "unsubscribing works");
});

report("durable");
