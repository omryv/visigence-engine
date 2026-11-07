/* durable.js — keeping a world alive between the moment it is made and the
 * moment somebody remembers to save it.
 *
 * ── THE PROBLEM, STATED AS THE AUDIT FOUND IT ──
 * Every high-severity defect in the last pass was the same defect wearing a
 * different coat: opening a file destroyed the world on screen, a second ⌘Z
 * deleted a history entry, the authored spawn was dropped at every save, redo
 * handed back a different world, and the tab closed in silence over an hour of
 * arranging. Six seams, one absence — the engine is rigorous and the CUSTODY
 * of authored work was unowned. Patching the seams did not fix the absence:
 * close the tab and it is still gone, because session state is an in-memory
 * Map and this origin deliberately stores nothing.
 *
 * ── WHY THIS DOES NOT BEND THE PRODUCT'S CLAIM ──
 * The claim is that the TOOL writes nothing to your machine; a file exists
 * because somebody chose to save it through their own browser's dialog. A
 * File System Access handle is that same choice, made once instead of forty
 * times. The origin still stores nothing — no localStorage, no IndexedDB, no
 * network, and nothing on this origin touches a storage API
 * unchanged. What changes is that the file the user already chose stays
 * current instead of going stale the moment they carry on working.
 *
 * Nothing is persisted ACROSS sessions here, and that is deliberate rather
 * than unfinished: a handle survives a reload only by living in IndexedDB,
 * which is exactly what the sweep exists to destroy. Reconnecting on boot is
 * a separate decision with a different answer, and it is not taken here.
 *
 * ── WHY THIS FILE IS PURE ──
 * The same reason `engine/render/env-pacer.js` is: the whole of it is a
 * decision about a SEQUENCE, and every bug it can have is invisible in any
 * single step. A change arriving while a write is in flight, a drag that
 * never goes still, a write that fails and must not quietly stop retrying —
 * each is three lines of test here and nearly unreproducible in a browser.
 * So `write` and `serialize` and the clock are injected, this module never
 * touches the File System Access API or the DOM, and the browser half is
 * thirty lines in studio.js. The same split worldfile.js already makes.
 *
 * ── THE GUARANTEE ──
 * The last change always reaches the file, or the failure is on screen. There
 * is no third outcome. A durability layer that stops silently is worse than
 * none, because by then the work is trusted to it.
 */

/* How still the world must be before a write. Long enough that a sculpt drag
   is one write rather than sixty; short enough that an abrupt close loses
   about a second. That trade is the whole of this number — a writable stream
   cannot reliably be opened and closed during `pagehide`, so the debounce
   window IS the exposure, and it is deliberately small. */
export const SAVE_QUIET_MS = 1200;

/* …but a world that never goes still must still be written. Without this, an
   unbroken five-minute sculpt debounces forever and checkpoints never. */
export const SAVE_MAX_WAIT_MS = 8000;

/** Can this browser hand out a file to write to? Chrome and Edge can; Safari
    and Firefox cannot, and there the editor keeps exactly today's behaviour —
    the download in `saveWorld` — which is a fallback rather than a
    regression. Reading a global rather than importing one keeps this module
    loadable outside a browser, which is what lets the suite run it. */
export const isFileLinkSupported = () =>
  typeof globalThis.showSaveFilePicker === "function";

const message = (err) => (err && err.message) || String(err) || "unknown error";

/**
 * The link between a world and one file on disk.
 *
 *   write      (text) => Promise   performs the actual write; injected
 *   serialize  () => string        the document to write, read AT WRITE TIME
 *   now        () => number        milliseconds; injected so the suite owns time
 *
 * The caller drives it: `touch()` when the world changes, `tick()` on a
 * heartbeat, `flush()` when leaving. Nothing in here schedules itself, so
 * there is no timer to leak and no frame budget to spend.
 */
export function createDurableLink({
  write,
  serialize,
  now = () => Date.now(),
  quiet = SAVE_QUIET_MS,
  maxWait = SAVE_MAX_WAIT_MS,
} = {}) {
  const s = {
    linked: false, name: null,
    /* A FLAG, NOT A TIMESTAMP, and the distinction cost a test to find. This
       was `dirtySince: 0` doing double duty, with 0 meaning clean — which is
       fine for `Date.now()` and silently wrong for any clock that starts at
       zero, `performance.now()` being the obvious one a caller would reach
       for. The first change made at t=0 set dirtySince=0, read back as clean,
       and was never written. A durability layer must not have a moment when
       losing work is correct behaviour. */
    dirty: false,
    dirtySince: 0,   // when it first differed from the file; only read when dirty
    lastTouch: 0,    // when it last changed, for the stillness test
    writing: false,
    savedAt: 0,
    error: null,
    failures: 0,     // consecutive; the UI says "still trying" rather than lying
  };

  const watchers = new Set();
  const snapshot = () => ({
    linked: s.linked, name: s.name,
    dirty: s.dirty,
    writing: s.writing,
    savedAt: s.savedAt,
    error: s.error,
    failures: s.failures,
  });
  const notify = () => { for (const cb of [...watchers]) cb(snapshot()); };

  /** A file has been chosen. Nothing is written until something changes. */
  function attach(name) {
    s.linked = true;
    s.name = name == null ? "" : String(name);
    s.dirty = false; s.dirtySince = 0; s.lastTouch = 0;
    s.savedAt = 0; s.error = null; s.failures = 0;
    notify();
    return snapshot();
  }

  /* Forget the file. Called when the document being edited is REPLACED rather
     than changed — Open and Build-a-world both do that — because writing an
     unrelated world into a file the user named after this one would be the
     data loss this module exists to prevent, arriving by a shorter route. */
  function detach() {
    if (!s.linked) return snapshot();
    s.linked = false; s.name = null;
    s.dirty = false; s.dirtySince = 0; s.lastTouch = 0;
    s.savedAt = 0; s.error = null; s.failures = 0;
    notify();
    return snapshot();
  }

  /** The world changed. Cheap: no serialization happens here. */
  function touch() {
    if (!s.linked) return;
    const t = now();
    const wasClean = !s.dirty;
    if (wasClean) { s.dirty = true; s.dirtySince = t; }
    s.lastTouch = t;
    // Only the clean→dirty edge is worth waking the interface for; a drag
    // touches on every move and the indicator already says "unsaved".
    if (wasClean) notify();
  }

  function due(t) {
    if (!s.linked || s.writing || !s.dirty) return false;
    return (t - s.lastTouch) >= quiet || (t - s.dirtySince) >= maxWait;
  }

  async function run(force) {
    if (!s.linked || !s.dirty) return false;
    /* A write is already in flight. The change stays dirty and the next tick
       writes it — which is the entire reason the dirty marks below are cleared
       before the await rather than after it. */
    if (s.writing) return false;
    if (!force && !due(now())) return false;

    s.writing = true;
    notify();
    const at = now();

    let text;
    try {
      // AT WRITE TIME, not at touch time. Serializing when the change arrived
      // and then coalescing would write the state of the first touch in a
      // burst and call the last one saved.
      text = serialize();
    } catch (err) {
      s.writing = false;
      s.error = `could not prepare the world: ${message(err)}`;
      s.failures++;
      s.lastTouch = at;   // wait a full quiet period before trying again
      notify();
      return false;
    }

    /* Cleared BEFORE the await. A change that lands while the stream is open
       is not in `text`, so it must re-dirty and earn its own write; clearing
       afterwards would mark it saved and lose it. */
    s.dirty = false;
    s.dirtySince = 0;
    s.lastTouch = 0;

    try {
      await write(text);
      s.savedAt = now();
      s.error = null;
      s.failures = 0;
      return true;
    } catch (err) {
      s.error = message(err);
      s.failures++;
      /* Nothing landed, so the work is dirty again — but not if a touch
         during the write already said so, because that mark is the newer and
         more accurate one. Backing `lastTouch` off to now spaces the retries
         a quiet period apart instead of hot-looping on a revoked permission. */
      if (!s.dirty) { s.dirty = true; s.dirtySince = at; }
      s.lastTouch = now();
      return false;
    } finally {
      s.writing = false;
      notify();
    }
  }

  return {
    attach,
    detach,
    touch,
    /** Heartbeat. Writes only if the world has settled or waited long enough. */
    tick: () => run(false),
    /** Write now if there is anything to write — an explicit Save, or leaving. */
    flush: () => run(true),
    state: snapshot,
    /** Subscribe to state changes; returns the unsubscribe, as engine.on does. */
    onChange(cb) { watchers.add(cb); return () => watchers.delete(cb); },
  };
}
