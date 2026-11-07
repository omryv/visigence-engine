/**
 * THE LEVEL EDITOR'S STATE: the game being built, the level in view, what is selected, which tool is in hand, and the
 * undo history. The viewport and the panels read `store.state` and call the mutations; they re-render on
 * `store.on(kind, fn)`. No DOM, no three: the node suite drives it directly (tools/test/test-level-store.mjs).
 *
 * THE GAME IS NEVER MUTATED. Every change builds a new game document (world/level/game.js), sharing every level it did
 * not touch, so one undo step is two references, before and after, and a 200-step history of an eight-level game costs
 * about what the levels it changed cost. Every mutation is its own named step ("Move barrel", "Paint path"), unless it
 * runs inside `begin(label)` / `end()`: a drag or a brush stroke is one step however many frames it took.
 *
 * SELECTION is a list of refs: a placed thing's id (`e12`), a generated thing's key (`tree@12.3,-8.1`, `step:activate:0`,
 * `gate:1`, `enemy:0`), or `start`. Keys always hold ':' or '@' and ids never do, so a ref says what it names.
 *
 * Change kinds: 'game' (anything in the document), 'level' (the level in view changed, or another one was chosen),
 * 'selection', 'tool', 'history', 'saved', 'notice'.
 */
import { patchGame, addLevel, removeLevel, moveLevel, duplicateLevel, LEVEL_NAME_MAX, MAX_LEVELS } from '../../src/world/level/game.js';
import { normalizeEntity, nextEntityId, normYaw, FIXED_KEY, DEFAULT_START } from '../../src/world/level/edits.js';
import { ENTITY_TYPES, EDIT_LIMITS, WORLD_HALF, canWire, defaultProps } from '../../src/world/level/entities.js';
import { decodeRegions, encodeRegions } from '../../src/world/level/regions.js';

export const HISTORY_LIMIT = 200;
export const TOOLS = ['select', 'move', 'rotate', 'scale', 'place', 'paint', 'wire', 'erase'];
export const isKeyRef = ref => ref.includes(':') || ref.includes('@');

export function createStore(game, { storage = null, key = null, delay = 400, schedule = (fn, ms) => setTimeout(fn, ms), cancel = t => clearTimeout(t) } = {}) {
  const listeners = new Map(), undo = [], redo = [];
  let tx = null, depth = 0, timer = null;
  const state = {
    game, levelIndex: 0,
    selection: [],
    tool: 'select',
    placing: { type: 'prop', props: defaultProps('prop') },
    brush: { region: 'path', size: 2 },
    snap: true,
    trace: null,
    saved: true,
  };
  const emit = (kind, payload) => {
    for (const fn of listeners.get(kind) ?? []) fn(payload);
    for (const fn of listeners.get('*') ?? []) fn(kind, payload);
  };
  const edits = () => state.game.levels[state.levelIndex].edits;
  /** Replace the game with `next` inside the current step (opening one named `label` if none is open). */
  const commit = (label, next, kinds = ['game', 'level']) => {
    if (next === state.game) return false;
    const own = depth === 0;
    if (own) store.begin(label);
    for (const k of kinds) tx.kinds.add(k);
    state.game = next;
    if (own) store.end();
    return true;
  };
  const withEdits = (label, fn) => {
    const before = edits(), after = fn(before);
    if (after === before) return false;
    return commit(label, patchGame(state.game, state.levelIndex, { edits: after }));
  };
  const save = () => {
    timer = null;
    if (!storage || !key) return;
    try { storage.setItem(key, JSON.stringify(state.game)); state.saved = true; emit('saved', true); }
    catch { state.saved = false; emit('saved', false); }
  };

  const store = {
    state,
    get game() { return state.game; },
    get level() { return state.game.levels[state.levelIndex]; },
    get edits() { return edits(); },

    on(kind, fn) {
      if (!listeners.has(kind)) listeners.set(kind, new Set());
      listeners.get(kind).add(fn);
      return () => listeners.get(kind)?.delete(fn);
    },
    notice(text, tone = 'info') { emit('notice', { text, tone }); },

    /** Open another game: a fresh history, its first level in view; `key` is where it saves from now on. */
    open(next, { key: nextKey = key } = {}) {
      if (timer !== null) { cancel(timer); save(); }
      key = nextKey;
      undo.length = 0; redo.length = 0; tx = null; depth = 0;
      Object.assign(state, { game: next, levelIndex: 0, selection: [], trace: null, saved: true });
      emit('game'); emit('level'); emit('selection'); emit('history');
    },

    // ---------------------------------------------------------------- steps
    begin(label = 'Edit') {
      if (depth++ === 0) tx = { label, before: state.game, levelBefore: state.levelIndex, kinds: new Set() };
    },
    end() {
      if (depth === 0 || --depth > 0) return;
      const t = tx; tx = null;
      if (t.before === state.game) return;
      undo.push({ label: t.label, before: t.before, after: state.game, levelBefore: t.levelBefore, levelAfter: state.levelIndex });
      if (undo.length > HISTORY_LIMIT) undo.shift();
      redo.length = 0;
      state.saved = false;
      for (const k of t.kinds) emit(k);
      emit('history');
      if (timer !== null) cancel(timer);
      timer = schedule(save, delay);
    },
    /** Run `fn` as one step. */
    transact(label, fn) { store.begin(label); try { return fn(); } finally { store.end(); } },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    undoLabel: () => undo.at(-1)?.label ?? '',
    redoLabel: () => redo.at(-1)?.label ?? '',
    undo() { const s = undo.pop(); if (!s) return; redo.push(s); restore(s.before, s.levelBefore); },
    redo() { const s = redo.pop(); if (!s) return; undo.push(s); restore(s.after, s.levelAfter); },
    /** Write the game now (a page closing, an export). */
    flush() { if (timer !== null) { cancel(timer); save(); } },
    /** Write it now even with nothing pending: a game just made from a template or a file is saved at once. */
    persist() { if (timer !== null) cancel(timer); save(); },

    // ---------------------------------------------------------------- game and level fields
    /** A flat patch, as the forms and the node graph make them: level fields go to this level, the rest to the game. */
    patch(patch, label = 'Change settings') { return commit(label, patchGame(state.game, state.levelIndex, patch)); },
    setPublish(patch) {
      // A switch set to what it already is makes no step.
      if (Object.entries(patch).every(([k, v]) => state.game.publish?.[k] === v)) return false;
      return commit('Change publishing', { ...state.game, publish: { ...state.game.publish, ...patch } });
    },

    // ---------------------------------------------------------------- levels
    selectLevel(i) {
      if (i === state.levelIndex || !state.game.levels[i]) return;
      state.levelIndex = i; state.selection = [];
      emit('level'); emit('selection');
    },
    addLevel(seed) { const i = state.levelIndex; if (commit('Add level', addLevel(state.game, i, seed))) store.selectLevel(i + 1); },
    duplicateLevel(i = state.levelIndex) { if (commit('Duplicate level', duplicateLevel(state.game, i))) store.selectLevel(i + 1); },
    removeLevel(i = state.levelIndex) {
      if (state.game.levels.length <= 1) { store.notice('A game keeps at least one level.', 'warn'); return; }
      store.begin('Delete level');
      commit('Delete level', removeLevel(state.game, i));
      state.levelIndex = Math.min(state.levelIndex, state.game.levels.length - 1); state.selection = [];
      store.end(); emit('selection');
    },
    moveLevel(from, to) {
      if (to < 0 || to >= state.game.levels.length || from === to) return;
      store.begin('Reorder levels');
      commit('Reorder levels', moveLevel(state.game, from, to));
      if (state.levelIndex === from) state.levelIndex = to;
      store.end();
    },
    renameLevel(i, name) {
      const clean = String(name).trim().slice(0, LEVEL_NAME_MAX);
      if (!clean || clean === state.game.levels[i].name) return;
      commit('Rename level', { ...state.game, levels: state.game.levels.map((l, k) => k === i ? { ...l, name: clean } : l) });
    },
    get canAddLevel() { return state.game.levels.length < MAX_LEVELS; },

    // ---------------------------------------------------------------- placed things
    entity(id) { return edits().entities.find(e => e.id === id) ?? null; },
    /** Place a thing; returns its id, or null when its type is at its cap. */
    addEntity(type, x, z, { yaw = 0, props = null, scale = 1 } = {}) {
      const def = ENTITY_TYPES[type], list = edits().entities;
      if (list.length >= EDIT_LIMITS.entities) { store.notice(`A level holds ${EDIT_LIMITS.entities} placed things.`, 'warn'); return null; }
      if (list.filter(e => e.type === type).length >= def.limit) { store.notice(`A level holds ${def.limit} ${def.label.toLowerCase()} entries.`, 'warn'); return null; }
      const id = nextEntityId(edits());
      const e = normalizeEntity({ id, type, x, z, yaw, scale, props: { ...defaultProps(type), ...props } });
      withEdits(`Place ${label(e)}`, ed => ({ ...ed, entities: [...ed.entities, e] }));
      return id;
    },
    /** Set a placed thing's transform or props (normalized); `patch.props` merges. */
    updateEntity(id, patch, stepLabel = null) {
      return withEdits(stepLabel ?? `Edit ${label(store.entity(id))}`, ed => {
        let changed = false;
        const entities = ed.entities.map(e => {
          if (e.id !== id) return e;
          const next = normalizeEntity({ ...e, ...patch, props: { ...e.props, ...(patch.props ?? {}) } });
          if (JSON.stringify(next) === JSON.stringify(e)) return e;
          changed = true; return next;
        });
        return changed ? { ...ed, entities } : ed;
      });
    },
    /**
     * Move refs by (dx, dz): placed things, generated things (an override) and the start. `origins` holds the compiled
     * spot of each generated ref that has no override yet (the viewport knows them).
     */
    translate(refs, dx, dz, stepLabel = 'Move', origins = {}) {
      store.begin(stepLabel);
      for (const ref of refs) {
        const at = store.transformOf(ref, origins[ref] ?? null);
        if (at && !(isKeyRef(ref) && (FIXED_KEY.test(ref) || ref.startsWith('lock:')))) store.setTransform(ref, { x: at.x + dx, z: at.z + dz }, origins[ref] ?? null);
      }
      store.end();
    },
    /**
     * Where a ref stands now: a placed thing's record, the start, or a generated thing's override. A generated thing
     * without one has no transform here; the viewport supplies its compiled spot (`origin`).
     */
    transformOf(ref, origin = null) {
      if (ref === 'start') return edits().start ?? DEFAULT_START;
      if (!isKeyRef(ref)) { const e = store.entity(ref); return e ? { x: e.x, z: e.z, yaw: e.yaw, scale: e.scale ?? 1 } : null; }
      const o = edits().overrides[ref];
      return o && !o.removed ? { yaw: origin?.yaw ?? 0, ...o } : origin;
    },
    /** Set the transform of one ref. A generated thing becomes an override; fixed ones (houses) refuse to move. */
    setTransform(ref, t, origin = null) {
      if (ref === 'start') return withEdits('Move start', ed => {
        const s = ed.start ?? DEFAULT_START, next = { x: clamp(t.x ?? s.x), z: clamp(t.z ?? s.z), yaw: normYaw(t.yaw ?? s.yaw) };
        return same(next, s) ? ed : { ...ed, start: next };
      });
      if (!isKeyRef(ref)) return store.updateEntity(ref, t);
      if (FIXED_KEY.test(ref) || ref.startsWith('lock:')) { store.notice('That stands on its own levelled ground: it can be removed, not moved.', 'warn'); return false; }
      return withEdits('Move', ed => {
        const was = ed.overrides[ref] ?? origin ?? {};
        const next = { x: clamp(t.x ?? was.x), z: clamp(t.z ?? was.z) };
        const yaw = t.yaw ?? was.yaw;
        if (yaw !== undefined) next.yaw = normYaw(yaw);
        return same(next, ed.overrides[ref]) ? ed : { ...ed, overrides: { ...ed.overrides, [ref]: next } };
      });
    },
    /** Delete refs: placed things (and their wires) go, generated things get a removed override. Pads and the start stay. */
    remove(refs, stepLabel = null) {
      const keep = refs.filter(r => r === 'start' || r.startsWith('step:') || r.startsWith('lock:'));
      if (keep.length) store.notice(keep.includes('start') ? 'The player start can be moved, not deleted.' : 'A mission pad leaves with its step: change the step in the mission graph.', 'warn');
      const ids = new Set(refs.filter(r => !isKeyRef(r) && r !== 'start')), keys = refs.filter(r => isKeyRef(r) && !keep.includes(r));
      if (!ids.size && !keys.length) return false;
      const done = withEdits(stepLabel ?? (refs.length === 1 && ids.size ? `Delete ${label(store.entity([...ids][0]))}` : 'Delete'), ed => ({
        ...ed,
        entities: ed.entities.filter(e => !ids.has(e.id)),
        wires: ed.wires.filter(w => !ids.has(w.from) && !ids.has(w.to)),
        overrides: keys.length ? { ...ed.overrides, ...Object.fromEntries(keys.map(k => [k, { removed: true }])) } : ed.overrides,
      }));
      if (done) store.select(state.selection.filter(r => !refs.includes(r) || keep.includes(r)));
      return done;
    },
    /** Put back a generated thing that was removed or moved: drop its override. */
    restore(key) {
      return withEdits('Restore generated', ed => {
        if (!(key in ed.overrides)) return ed;
        const { [key]: _, ...rest } = ed.overrides;
        return { ...ed, overrides: rest };
      });
    },
    /** Copies of the placed things among `refs`, offset by (dx, dz); wires between two copied things are copied too. */
    duplicate(refs, dx = 1, dz = 1) {
      const src = refs.filter(r => !isKeyRef(r) && r !== 'start').map(store.entity).filter(Boolean);
      if (!src.length) return [];
      const made = [], map = new Map();
      withEdits(src.length === 1 ? `Duplicate ${label(src[0])}` : 'Duplicate', ed => {
        const entities = [...ed.entities];
        for (const e of src) {
          if (entities.length >= EDIT_LIMITS.entities || entities.filter(x => x.type === e.type).length >= ENTITY_TYPES[e.type].limit) break;
          const id = nextEntityId({ entities });
          entities.push(normalizeEntity({ ...structuredClone(e), id, x: e.x + dx, z: e.z + dz }));
          map.set(e.id, id); made.push(id);
        }
        const wires = [...ed.wires, ...ed.wires.filter(w => map.has(w.from) && map.has(w.to)).map(w => ({ from: map.get(w.from), to: map.get(w.to) }))];
        return made.length ? { ...ed, entities, wires } : ed;
      });
      if (made.length < src.length) store.notice('Some copies would pass the level\'s limits and were not made.', 'warn');
      if (made.length) store.select(made);
      return made;
    },

    // ---------------------------------------------------------------- wires, regions, overrides
    wire(from, to) {
      const a = store.entity(from), b = store.entity(to);
      if (!a || !b || !canWire(a.type, b.type)) { store.notice('Wires run from a lever or a trigger zone to a door or a critter.', 'warn'); return false; }
      if (edits().wires.some(w => w.from === from && w.to === to)) return false;
      if (edits().wires.length >= EDIT_LIMITS.wires) { store.notice(`A level holds ${EDIT_LIMITS.wires} wires.`, 'warn'); return false; }
      return withEdits(`Wire ${label(a)} to ${label(b)}`, ed => ({ ...ed, wires: [...ed.wires, { from, to }] }));
    },
    unwire(from, to) {
      return withEdits('Cut wire', ed => {
        const wires = ed.wires.filter(w => !(w.from === from && w.to === to));
        return wires.length === ed.wires.length ? ed : { ...ed, wires };
      });
    },
    /** Paint region cells (indices of the 80 x 80 grid) with a region code, 0 to clear. */
    paint(indices, code, stepLabel = 'Paint') {
      return withEdits(stepLabel, ed => {
        const cells = decodeRegions(ed.regions);
        let changed = false;
        for (const k of indices) if (cells[k] !== code) { cells[k] = code; changed = true; }
        return changed ? { ...ed, regions: encodeRegions(cells) } : ed;
      });
    },
    /** Drop edits by key (orphans the checks reported). */
    dropOverrides(keys) {
      return withEdits(keys.length === 1 ? 'Drop orphaned change' : 'Drop orphaned changes', ed => {
        const overrides = { ...ed.overrides };
        let n = 0;
        for (const k of keys) if (k in overrides) { delete overrides[k]; n++; }
        return n ? { ...ed, overrides } : ed;
      });
    },

    // ---------------------------------------------------------------- selection and tools
    select(refs) {
      const next = [...new Set(refs)];
      if (next.length === state.selection.length && next.every((r, i) => r === state.selection[i])) return;
      state.selection = next; emit('selection');
    },
    toggleSelect(ref) { store.select(state.selection.includes(ref) ? state.selection.filter(r => r !== ref) : [...state.selection, ref]); },
    setTool(tool) { if (!TOOLS.includes(tool) || tool === state.tool) return; state.tool = tool; emit('tool'); },
    setPlacing(type, props = null) { state.placing = { type, props: { ...defaultProps(type), ...(props ?? {}) } }; state.tool = 'place'; emit('tool'); },
    setBrush(patch) { state.brush = { ...state.brush, ...patch }; emit('tool'); },
    setSnap(on) { state.snap = !!on; emit('tool'); },
    setTrace(trace) { state.trace = trace; emit('level'); },
  };

  function restore(game, levelIndex) {
    state.game = game; state.levelIndex = Math.min(levelIndex, game.levels.length - 1);
    const refs = new Set([...edits().entities.map(e => e.id)]);
    state.selection = state.selection.filter(r => isKeyRef(r) || r === 'start' || refs.has(r));
    state.saved = false;
    emit('game'); emit('level'); emit('selection'); emit('history');
    if (timer !== null) cancel(timer);
    timer = schedule(save, delay);
  }
  return store;
}

const clamp = v => Math.round(Math.max(-WORLD_HALF, Math.min(WORLD_HALF, Number(v) || 0)) * 100) / 100;
const same = (a, b) => !!a && !!b && a.x === b.x && a.z === b.z && (a.yaw ?? 0) === (b.yaw ?? 0);

/** How a step names a placed thing: its type, or its prop (a barrel, a house). */
export function label(e) {
  if (!e) return 'thing';
  if (e.type === 'prop') return { hayBarricade: 'hay bale', nature: 'plant' }[e.props.prop] ?? e.props.prop;
  if (e.type === 'pickup') return { health: 'honey jar', ammo: 'pebble pouch', grenade: 'fizz-bomb' }[e.props.kind];
  if (e.type === 'key') return `${e.props.color} key`;
  return ENTITY_TYPES[e.type].label.toLowerCase();
}
