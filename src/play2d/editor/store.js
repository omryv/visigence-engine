/**
 * The editor's single source of truth: the project being edited, what is selected, which
 * tool is in hand, and the undo history. Panels and the viewport read `store.state` and
 * `store.level`, call the mutation methods, and re-render on `store.on(kind, fn)`.
 *
 * Every mutation belongs to a transaction. Call a mutation on its own and it is its own
 * undo step; wrap a drag in `begin(label)` / `end()` and the whole stroke is one step.
 * History stores copies of only the levels a step touched, so a 20-level game undoes as
 * cheaply as a one-level game.
 *
 * Change kinds: 'project' (title, settings…), 'level' (tiles, entities, wires, level props),
 * 'levels' (the level list), 'selection', 'tool', 'layer', 'brush', 'view' (overlays and layer
 * visibility), 'history', 'trace', 'saved', 'notice' ({ text, tone }).
 */
import {
  entityDef, footprint, defaultProps, canLink, genreById, tileByCode, decorByCode,
} from '../core/catalog.js';
import {
  createLevel, cloneLevel, newId, normalizeProps, serializeProject, parseProject, clampInt,
} from '../core/format.js';
import { resizeCells, idx, inBounds, copyRegion } from '../core/grid.js';

const HISTORY_LIMIT = 200;
const STORAGE_PREFIX = 'visigame.builder.project.';
const RECENT_KEY = 'visigame.builder.recent';
const META_KEYS = ['title', 'studio', 'description', 'accent', 'settings', 'publish'];

export const LAYERS = ['terrain', 'decor', 'entities'];
export const TOOLS = ['select', 'brush', 'rect', 'fill', 'erase', 'pick', 'link', 'hand'];

export function createStore(project) {
  const listeners = new Map();
  const undoStack = [], redoStack = [];
  let tx = null, depth = 0, saveTimer = 0, clipboard = null;

  const state = {
    project,
    levelIndex: 0,
    layer: 'terrain',
    tool: 'brush',
    brush: defaultBrush(project.genre),
    brushSize: 1,
    selection: { ids: [], region: null },
    overlays: { grid: true, links: true, reach: false, trace: true, issues: true },
    visible: { terrain: true, decor: true, entities: true },
    locked: { terrain: false, decor: false, entities: false },
    trace: null,           // { levelId, points: [[x, y, t]], deaths: [{x, y, t}], status, time }
    saved: true,
    savedAt: 0,
  };

  const store = {
    state,
    get project() { return state.project; },
    get level() { return state.project.levels[state.levelIndex]; },
    get genre() { return state.project.genre; },
    get view() { return genreById(state.project.genre)?.view || 'top'; },

    on(kind, fn) {
      if (!listeners.has(kind)) listeners.set(kind, new Set());
      listeners.get(kind).add(fn);
      return () => listeners.get(kind)?.delete(fn);
    },
    emit(kind, payload) {
      for (const fn of listeners.get(kind) || []) fn(payload);
      for (const fn of listeners.get('*') || []) fn(kind, payload);
    },
    notice(text, tone = 'info') { store.emit('notice', { text, tone }); },

    // ---------------------------------------------------------------- transactions
    begin(label = 'Edit') {
      if (depth++ === 0) tx = { label, levelsBefore: new Map(), metaBefore: null, orderBefore: null, indexBefore: state.levelIndex, kinds: new Set() };
    },
    end() {
      if (depth === 0) return;
      if (--depth > 0) return;
      const t = tx; tx = null;
      if (!t.levelsBefore.size && !t.metaBefore && !t.orderBefore) return;
      t.levelsAfter = new Map();
      for (const id of t.levelsBefore.keys()) { const l = findLevel(id); if (l) t.levelsAfter.set(id, cloneLevel(l)); }
      for (const id of t.added || []) { const l = findLevel(id); if (l) t.levelsAfter.set(id, cloneLevel(l)); }
      if (t.metaBefore) t.metaAfter = snapshotMeta();
      if (t.orderBefore) t.orderAfter = state.project.levels.map(l => l.id);
      t.indexAfter = state.levelIndex;
      undoStack.push(t);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack.length = 0;
      markDirty();
      for (const k of t.kinds) store.emit(k);
      store.emit('history');
    },
    /** Run `fn` as one undo step. */
    transact(label, fn) { store.begin(label); try { return fn(); } finally { store.end(); } },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoLabel: () => undoStack.at(-1)?.label || '',
    redoLabel: () => redoStack.at(-1)?.label || '',
    undo() { const t = undoStack.pop(); if (!t) return; apply(t, 'before'); redoStack.push(t); afterHistory(t); },
    redo() { const t = redoStack.pop(); if (!t) return; apply(t, 'after'); undoStack.push(t); afterHistory(t); },

    // ---------------------------------------------------------------- tiles
    /** Paint one cell of a tile layer. Returns true if it changed. */
    setCell(layer, x, y, code) {
      const l = store.level;
      if (layer === 'entities' || !inBounds(l.width, l.height, x, y)) return false;
      const cells = l[layer], i = idx(l.width, x, y);
      if (cells[i] === code) return false;
      withTx('Paint', () => { touchLevel(l); cells[i] = code; });
      return true;
    },
    /** Paint many cells (indices) with one code, as one step. */
    setCells(layer, indices, code, label = 'Paint') {
      const l = store.level, cells = l[layer];
      if (!cells || !indices.length) return 0;
      let n = 0;
      withTx(label, () => {
        for (const i of indices) if (cells[i] !== code) { if (!n) touchLevel(l); cells[i] = code; n++; }
      });
      return n;
    },
    cellAt(layer, x, y) { const l = store.level; return inBounds(l.width, l.height, x, y) ? l[layer][idx(l.width, x, y)] : -1; },

    // ---------------------------------------------------------------- entities
    entity(id) { return store.level.entities.find(e => e.id === id) || null; },
    /** The topmost entity whose footprint covers a cell. */
    entityAt(x, y) {
      const list = store.level.entities;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i], fp = footprint(e);
        if (x >= e.x && x < e.x + fp.w && y >= e.y && y < e.y + fp.h) return e;
      }
      return null;
    },
    entitiesIn(rect) {
      return store.level.entities.filter(e => { const fp = footprint(e); return e.x < rect.x + rect.w && e.x + fp.w > rect.x && e.y < rect.y + rect.h && e.y + fp.h > rect.y; });
    },
    /**
     * Place an entity. A one-per-level type (the player start) moves instead of multiplying;
     * a type at its cap is refused with a notice; whatever already sits on the cell is replaced.
     */
    placeEntity(type, x, y, props = null) {
      const l = store.level, def = entityDef(type), genre = store.genre;
      if (!def || !def.genres.includes(genre) || !inBounds(l.width, l.height, x, y)) return null;
      const same = l.entities.filter(e => e.type === type);
      if (def.max === 1 && same.length) {
        const e = same[0];
        if (e.x === x && e.y === y) return e;
        withTx(`Move ${def.name.toLowerCase()}`, () => { touchLevel(l); removeAt(l, x, y, e.id); e.x = x; e.y = y; clampToLevel(l, e); });
        return e;
      }
      const under = store.entityAt(x, y);
      if (under && under.type === type && under.x === x && under.y === y) return under;
      if (same.length >= def.max) { store.notice(`A level holds at most ${def.max} ${def.name.toLowerCase()}${def.max === 1 ? '' : 's'}.`, 'warn'); return null; }
      const e = { id: newId('e'), type, x, y, props: props ? normalizeProps(type, genre, props) : defaultProps(type, genre) };
      withTx(`Place ${def.name.toLowerCase()}`, () => { touchLevel(l); removeAt(l, x, y, null, footprint(e)); l.entities.push(e); clampToLevel(l, e); });
      return e;
    },
    moveEntities(ids, dx, dy, label = 'Move') {
      const l = store.level;
      if (!ids.length || (!dx && !dy)) return false;
      const list = l.entities.filter(e => ids.includes(e.id));
      for (const e of list) { const fp = footprint(e); if (e.x + dx < 0 || e.y + dy < 0 || e.x + dx + fp.w > l.width || e.y + dy + fp.h > l.height) return false; }
      withTx(label, () => {
        touchLevel(l);
        for (const e of list) { e.x += dx; e.y += dy; }
        const moved = new Set(ids);
        // Whatever the moved parts landed on is replaced, as when placing.
        for (const e of list) l.entities = l.entities.filter(o => moved.has(o.id) || !(o.x === e.x && o.y === e.y));
        pruneLinks(l);
      });
      return true;
    },
    setEntityProps(id, patch, label = 'Edit properties') {
      const l = store.level, e = l.entities.find(o => o.id === id);
      if (!e) return;
      const next = normalizeProps(e.type, store.genre, { ...e.props, ...patch });
      if (JSON.stringify(next) === JSON.stringify(e.props)) return;
      withTx(label, () => { touchLevel(l); e.props = next; if (e.type === 'platform') clampToLevel(l, e); });
    },
    removeEntities(ids, label = 'Delete') {
      const l = store.level, set = new Set(ids);
      if (!l.entities.some(e => set.has(e.id))) return;
      withTx(label, () => { touchLevel(l); l.entities = l.entities.filter(e => !set.has(e.id)); pruneLinks(l); });
      store.select(state.selection.ids.filter(id => !set.has(id)));
    },

    // ---------------------------------------------------------------- wires
    linksOf(id) { return store.level.links.filter(k => k.from === id || k.to === id); },
    addLink(from, to) {
      const l = store.level, a = store.entity(from), b = store.entity(to);
      if (!a || !b) return false;
      if (!canLink(a, b)) { store.notice(`A ${entityDef(a.type).name.toLowerCase()} cannot drive a ${entityDef(b.type).name.toLowerCase()}.`, 'warn'); return false; }
      if (l.links.some(k => k.from === from && k.to === to)) return false;
      if (l.links.length >= 120) { store.notice('A level holds at most 120 wires.', 'warn'); return false; }
      withTx('Wire', () => { touchLevel(l); l.links.push({ from, to }); });
      return true;
    },
    removeLink(from, to) {
      const l = store.level;
      if (!l.links.some(k => k.from === from && k.to === to)) return;
      withTx('Cut wire', () => { touchLevel(l); l.links = l.links.filter(k => !(k.from === from && k.to === to)); });
    },

    // ---------------------------------------------------------------- level
    setLevel(patch, label = 'Level settings') {
      const l = store.level;
      withTx(label, () => {
        touchLevel(l);
        for (const k of ['name', 'biome', 'time', 'notes']) if (k in patch) l[k] = patch[k];
        if (patch.rules) l.rules = { ...l.rules, ...patch.rules };
      });
    },
    /** Resize the level, anchoring old content (ax, ay in {0, 0.5, 1}). Parts pushed out are dropped. */
    resizeLevel(width, height, ax = 0, ay = 1) {
      const l = store.level, g = genreById(store.genre);
      width = clampInt(width, g.minSize.width, g.maxSize.width);
      height = clampInt(height, g.minSize.height, g.maxSize.height);
      if (width === l.width && height === l.height) return;
      withTx('Resize level', () => {
        touchLevel(l);
        const t = resizeCells(l.terrain, l.width, l.height, width, height, ax, ay);
        const d = resizeCells(l.decor, l.width, l.height, width, height, ax, ay);
        l.terrain = t.cells; l.decor = d.cells;
        const before = l.entities.length;
        for (const e of l.entities) { e.x += t.dx; e.y += t.dy; }
        l.entities = l.entities.filter(e => { const fp = footprint(e); return e.x >= 0 && e.y >= 0 && e.x + fp.w <= width && e.y + fp.h <= height; });
        l.width = width; l.height = height;
        pruneLinks(l);
        if (l.entities.length < before) store.notice(`${before - l.entities.length} part${before - l.entities.length === 1 ? '' : 's'} fell outside the new size and were removed.`, 'warn');
      });
    },

    // ---------------------------------------------------------------- level list
    selectLevel(i) {
      i = clampInt(i, 0, state.project.levels.length - 1);
      if (i === state.levelIndex) return;
      state.levelIndex = i;
      state.selection = { ids: [], region: null };
      store.emit('levels'); store.emit('level'); store.emit('selection');
    },
    addLevel(opts = {}) {
      const p = state.project;
      if (p.levels.length >= 24) { store.notice('A game holds at most 24 levels.', 'warn'); return null; }
      const prev = store.level;
      const l = createLevel(p.genre, { name: `Level ${p.levels.length + 1}`, biome: prev?.biome, time: prev?.time, ...opts });
      withTx('Add level', () => { touchOrder(); tx.added = [...(tx.added || []), l.id]; p.levels.push(l); state.levelIndex = p.levels.length - 1; });
      store.emit('level'); store.emit('selection');
      return l;
    },
    duplicateLevel(i = state.levelIndex) {
      const p = state.project, src = p.levels[i];
      if (!src || p.levels.length >= 24) return null;
      const l = cloneLevel(src);
      l.id = newId('l'); l.name = (src.name + ' copy').slice(0, 40);
      const map = new Map();
      for (const e of l.entities) { const id = newId('e'); map.set(e.id, id); e.id = id; }
      l.links = l.links.map(k => ({ from: map.get(k.from), to: map.get(k.to) }));
      withTx('Duplicate level', () => { touchOrder(); tx.added = [...(tx.added || []), l.id]; p.levels.splice(i + 1, 0, l); state.levelIndex = i + 1; });
      store.emit('level');
      return l;
    },
    removeLevel(i = state.levelIndex) {
      const p = state.project;
      if (p.levels.length <= 1) { store.notice('A game needs at least one level.', 'warn'); return; }
      withTx('Delete level', () => { touchOrder(); touchLevel(p.levels[i]); p.levels.splice(i, 1); state.levelIndex = Math.min(state.levelIndex, p.levels.length - 1); });
      state.selection = { ids: [], region: null };
      store.emit('level'); store.emit('selection');
    },
    /**
     * Put ready-made levels (from the generator, say) into the game as one undo step: after the
     * current level, or in place of every level with `replace`. Levels get fresh ids so a batch
     * added twice never collides. Returns how many went in (a game holds at most 24).
     */
    insertLevels(levels, { replace = false, label = 'Add generated levels' } = {}) {
      const p = state.project;
      const room = replace ? 24 : 24 - p.levels.length;
      const take = levels.slice(0, Math.max(0, room)).map(src => {
        const l = cloneLevel(src);
        l.id = newId('l');
        const map = new Map();
        for (const e of l.entities) { const id = newId('e'); map.set(e.id, id); e.id = id; }
        l.links = l.links.filter(k => map.has(k.from) && map.has(k.to)).map(k => ({ from: map.get(k.from), to: map.get(k.to) }));
        return l;
      });
      if (!take.length) { store.notice('A game holds at most 24 levels.', 'warn'); return 0; }
      withTx(label, () => {
        touchOrder();
        tx.added = [...(tx.added || []), ...take.map(l => l.id)];
        if (replace) {
          for (const l of p.levels) touchLevel(l);
          p.levels.splice(0, p.levels.length, ...take);
          state.levelIndex = 0;
        } else {
          p.levels.splice(state.levelIndex + 1, 0, ...take);
          state.levelIndex += 1;
        }
      });
      state.selection = { ids: [], region: null };
      store.emit('level'); store.emit('selection');
      if (take.length < levels.length) store.notice(`Added ${take.length} of ${levels.length}: a game holds at most 24 levels.`, 'warn');
      return take.length;
    },
    moveLevel(from, to) {
      const p = state.project;
      if (to < 0 || to >= p.levels.length || from === to) return;
      withTx('Reorder levels', () => { touchOrder(); const [l] = p.levels.splice(from, 1); p.levels.splice(to, 0, l); if (state.levelIndex === from) state.levelIndex = to; });
    },

    // ---------------------------------------------------------------- project
    setProject(patch, label = 'Game settings') {
      const p = state.project;
      withTx(label, () => {
        touchMeta();
        for (const k of ['title', 'studio', 'description', 'accent']) if (k in patch) p[k] = patch[k];
        if (patch.settings) p.settings = { ...p.settings, ...patch.settings };
        if (patch.publish) p.publish = { ...p.publish, ...patch.publish };
      });
    },
    /** Swap in a whole project (new, opened, template). Clears history. */
    replaceProject(project) {
      state.project = project;
      state.levelIndex = 0;
      state.selection = { ids: [], region: null };
      state.brush = defaultBrush(project.genre);
      state.layer = 'terrain';
      state.trace = null;
      undoStack.length = 0; redoStack.length = 0;
      state.saved = false;
      for (const k of ['project', 'levels', 'level', 'selection', 'brush', 'layer', 'history', 'trace']) store.emit(k);
      store.save();
    },

    // ---------------------------------------------------------------- UI state
    setTool(tool) { if (!TOOLS.includes(tool) || state.tool === tool) return; state.tool = tool; store.emit('tool'); },
    setLayer(layer) {
      if (!LAYERS.includes(layer) || state.layer === layer) return;
      state.layer = layer;
      if (layer !== 'entities' && state.tool === 'link') state.tool = 'brush';
      store.emit('layer'); store.emit('tool');
    },
    setBrush(layer, id) { state.brush = { ...state.brush, [layer]: id }; if (state.layer !== layer) store.setLayer(layer); if (!['brush', 'rect', 'fill'].includes(state.tool)) store.setTool('brush'); store.emit('brush'); },
    setBrushSize(n) { state.brushSize = clampInt(n, 1, 5); store.emit('brush'); },
    select(ids) { state.selection = { ids: [...new Set(ids)], region: null }; store.emit('selection'); },
    setRegion(rect) { state.selection = { ids: rect ? store.entitiesIn(rect).map(e => e.id) : [], region: rect }; store.emit('selection'); },
    toggleOverlay(name, on) { state.overlays[name] = on ?? !state.overlays[name]; store.emit('view'); },
    setVisible(layer, on) { state.visible[layer] = on; store.emit('view'); },
    setLocked(layer, on) { state.locked[layer] = on; store.emit('view'); },
    setTrace(trace) { state.trace = trace; store.emit('trace'); },

    // ---------------------------------------------------------------- clipboard
    /** Copy the selected region (all layers, entities inside and the wires between them). */
    copy() {
      const l = store.level, r = state.selection.region;
      const ents = r ? store.entitiesIn(r) : l.entities.filter(e => state.selection.ids.includes(e.id));
      if (!r && !ents.length) return false;
      const box = r || boundsOf(ents);
      const ids = new Set(ents.map(e => e.id));
      clipboard = {
        w: box.w, h: box.h,
        terrain: r ? copyRegion(l.terrain, l.width, r) : null,
        decor: r ? copyRegion(l.decor, l.width, r) : null,
        entities: ents.map(e => ({ ...e, props: { ...e.props }, x: e.x - box.x, y: e.y - box.y })),
        links: l.links.filter(k => ids.has(k.from) && ids.has(k.to)).map(k => ({ ...k })),
      };
      store.notice(`Copied ${r ? `${r.w}×${r.h} cells` : `${ents.length} part${ents.length === 1 ? '' : 's'}`}.`);
      return true;
    },
    hasClipboard: () => !!clipboard,
    clipboardSize: () => (clipboard ? { w: clipboard.w, h: clipboard.h } : null),
    /** Paste the clipboard with its top-left at (x, y). */
    paste(x, y) {
      if (!clipboard) return false;
      const l = store.level, c = clipboard, genre = store.genre;
      const added = [];
      withTx('Paste', () => {
        touchLevel(l);
        for (let cy = 0; cy < c.h; cy++) for (let cx = 0; cx < c.w; cx++) {
          const tx_ = x + cx, ty = y + cy;
          if (!inBounds(l.width, l.height, tx_, ty)) continue;
          const i = idx(l.width, tx_, ty), j = cy * c.w + cx;
          if (c.terrain) { const code = c.terrain[j]; if (!code || tileByCode(code)?.genres.includes(genre)) l.terrain[i] = code; }
          if (c.decor) l.decor[i] = c.decor[j];
        }
        const map = new Map();
        for (const src of c.entities) {
          const def = entityDef(src.type);
          if (!def?.genres.includes(genre)) continue;
          const ex = x + src.x, ey = y + src.y, fp = footprint(src);
          if (ex < 0 || ey < 0 || ex + fp.w > l.width || ey + fp.h > l.height) continue;
          if (def.max === 1) { const old = l.entities.find(e => e.type === src.type); if (old) { old.x = ex; old.y = ey; map.set(src.id, old.id); continue; } }
          if (l.entities.filter(e => e.type === src.type).length >= def.max) continue;
          removeAt(l, ex, ey, null, fp);
          const e = { id: newId('e'), type: src.type, x: ex, y: ey, props: normalizeProps(src.type, genre, src.props) };
          map.set(src.id, e.id);
          l.entities.push(e); added.push(e.id);
        }
        for (const k of c.links) if (map.has(k.from) && map.has(k.to)) l.links.push({ from: map.get(k.from), to: map.get(k.to) });
        pruneLinks(l);
      });
      state.selection = { ids: added, region: { x, y, w: c.w, h: c.h } };
      store.emit('selection');
      return true;
    },
    /** Clear a region on the active tile layer (or all layers with `all`). */
    clearRegion(rect, all = false) {
      const l = store.level;
      withTx('Clear', () => {
        touchLevel(l);
        for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
          const i = idx(l.width, x, y);
          if (all || state.layer === 'terrain') l.terrain[i] = 0;
          if (all || state.layer === 'decor') l.decor[i] = 0;
        }
        if (all || state.layer === 'entities') { const gone = new Set(store.entitiesIn(rect).map(e => e.id)); l.entities = l.entities.filter(e => !gone.has(e.id)); pruneLinks(l); }
      });
    },
    /** Mirror the selected region left-right in place (tiles and entities). */
    flipRegion(rect) {
      const l = store.level;
      withTx('Flip', () => {
        touchLevel(l);
        for (const layer of ['terrain', 'decor']) {
          const cells = l[layer];
          for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = 0; x < Math.floor(rect.w / 2); x++) {
            const a = idx(l.width, rect.x + x, y), b = idx(l.width, rect.x + rect.w - 1 - x, y);
            const t = cells[a]; cells[a] = cells[b]; cells[b] = t;
          }
        }
        for (const e of store.entitiesIn(rect)) {
          const fp = footprint(e);
          e.x = rect.x + (rect.x + rect.w - (e.x + fp.w));
          if (e.props.dir === 'left') e.props.dir = 'right'; else if (e.props.dir === 'right') e.props.dir = 'left';
        }
      });
    },

    // ---------------------------------------------------------------- persistence
    /** Autosave soon (debounced); `now` saves immediately. */
    save(now = false) {
      clearTimeout(saveTimer);
      const run = () => {
        try {
          const text = serializeProject(state.project);
          localStorage.setItem(STORAGE_PREFIX + state.project.id, text);
          const recent = readRecent().filter(r => r.id !== state.project.id);
          recent.unshift({ id: state.project.id, title: state.project.title, genre: state.project.genre, levels: state.project.levels.length, at: Date.now() });
          localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 12)));
          for (const r of recent.slice(12)) localStorage.removeItem(STORAGE_PREFIX + r.id);
          state.saved = true; state.savedAt = Date.now();
          store.emit('saved', { ok: true });
        } catch (e) {
          state.saved = false;
          store.emit('saved', { ok: false, error: e });
        }
      };
      if (now) run(); else saveTimer = setTimeout(run, 600);
    },
  };

  // ------------------------------------------------------------------ internals
  function withTx(label, fn) {
    const own = depth === 0;
    if (own) store.begin(label);
    try { fn(); } finally { if (own) store.end(); }
  }
  function touchLevel(l) {
    if (!tx) throw new Error('Mutation outside a transaction');
    if (!tx.levelsBefore.has(l.id) && !(tx.added || []).includes(l.id)) tx.levelsBefore.set(l.id, cloneLevel(l));
    tx.kinds.add('level');
  }
  function touchMeta() { if (!tx.metaBefore) tx.metaBefore = snapshotMeta(); tx.kinds.add('project'); }
  function touchOrder() { if (!tx.orderBefore) tx.orderBefore = state.project.levels.map(l => l.id); tx.kinds.add('levels'); tx.kinds.add('level'); }
  function snapshotMeta() { const p = state.project, o = {}; for (const k of META_KEYS) o[k] = typeof p[k] === 'object' ? { ...p[k] } : p[k]; return o; }
  function findLevel(id) { return state.project.levels.find(l => l.id === id); }
  function apply(t, side) {
    const p = state.project;
    const levels = side === 'before' ? t.levelsBefore : t.levelsAfter;
    const order = side === 'before' ? t.orderBefore : t.orderAfter;
    const meta = side === 'before' ? t.metaBefore : t.metaAfter;
    if (meta) for (const k of META_KEYS) p[k] = typeof meta[k] === 'object' ? { ...meta[k] } : meta[k];
    if (order) {
      const current = new Map(p.levels.map(l => [l.id, l]));
      p.levels = order.map(id => (levels.has(id) ? cloneLevel(levels.get(id)) : current.get(id))).filter(Boolean);
    } else {
      for (const [id, snap] of levels) { const i = p.levels.findIndex(l => l.id === id); if (i >= 0) p.levels[i] = cloneLevel(snap); }
    }
    state.levelIndex = Math.max(0, Math.min(p.levels.length - 1, side === 'before' ? t.indexBefore : t.indexAfter));
  }
  function afterHistory(t) {
    const l = store.level, ids = new Set(l.entities.map(e => e.id));
    state.selection = { ids: state.selection.ids.filter(id => ids.has(id)), region: null };
    markDirty();
    for (const k of t.kinds) store.emit(k);
    store.emit('level'); store.emit('selection'); store.emit('history');
    store.notice(`${t.label}`, 'history');
  }
  function markDirty() { state.saved = false; store.emit('saved', { ok: true, pending: true }); store.save(); }
  function removeAt(l, x, y, keepId, fp = { w: 1, h: 1 }) {
    const gone = new Set();
    for (const e of l.entities) {
      if (e.id === keepId) continue;
      const efp = footprint(e);
      if (e.x < x + fp.w && e.x + efp.w > x && e.y < y + fp.h && e.y + efp.h > y) gone.add(e.id);
    }
    if (gone.size) { l.entities = l.entities.filter(e => !gone.has(e.id)); pruneLinks(l); }
  }
  function pruneLinks(l) { const ids = new Set(l.entities.map(e => e.id)); l.links = l.links.filter(k => ids.has(k.from) && ids.has(k.to)); }
  function clampToLevel(l, e) { const fp = footprint(e); e.x = Math.max(0, Math.min(l.width - fp.w, e.x)); e.y = Math.max(0, Math.min(l.height - fp.h, e.y)); }

  return store;
}

function boundsOf(ents) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of ents) { const fp = footprint(e); x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x + fp.w); y1 = Math.max(y1, e.y + fp.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function defaultBrush(genre) {
  const side = genreById(genre)?.view === 'side';
  return { terrain: side ? 1 : 20, decor: side ? 51 : 50, entities: genre === 'maze' ? 'bee' : 'coin' };
}

/** Saved projects in this browser, newest first: [{ id, title, genre, levels, at }]. */
export function readRecent() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(r => r && typeof r.id === 'string') : []; }
  catch { return []; }
}
/** Open a project saved in this browser; null when it is gone or unreadable. */
export function loadSaved(id) {
  try { const text = localStorage.getItem(STORAGE_PREFIX + id); return text ? parseProject(text) : null; }
  catch { return null; }
}
export function forgetSaved(id) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(readRecent().filter(r => r.id !== id)));
  } catch { /* storage unavailable */ }
}
