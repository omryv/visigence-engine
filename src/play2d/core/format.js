/**
 * The builder's document: a game (project) made of levels. One shape travels everywhere: the
 * editor holds it in memory, localStorage and `.visigame.json` files hold it serialised,
 * a share link holds it compressed, and an exported game carries it inline.
 *
 *   project = { kind, version, id, title, studio, accent, genre, template, settings, publish, levels[] }
 *   level   = { id, name, width, height, biome, time, rules, terrain, decor, entities[], links[], notes }
 *
 * In memory `terrain` and `decor` are Uint16Arrays of tile codes (row-major, y down). In a
 * file they are run-length strings (grid.rleEncode). Everything else is plain JSON.
 *
 * `normalizeProject` is the one door in: it accepts a parsed file or an in-memory project,
 * fills every default, drops what it cannot mean, and throws `FormatError` (with `path`) on
 * what it cannot read. Pure: no DOM at import; the share codec uses CompressionStream when
 * it is there (every current browser and Node 18+).
 */
import {
  GENRE_IDS, genreById, BIOME_IDS, TIME_IDS, KEY_COLOR_IDS, WIN_RULES, LIMITS,
  tileByCode, decorByCode, entityDef, propsFor, optionsFor, defaultProps, canLink, viewOf,
} from './catalog.js';
import { rleEncode, rleDecode } from './grid.js';

export const FORMAT_KIND = 'visigame.builder';
export const FORMAT_VERSION = 1;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class FormatError extends Error {
  constructor(message, path = '') { super(path ? `${path}: ${message}` : message); this.name = 'FormatError'; this.path = path; }
}

let idCounter = 0;
/** Short ids. Deterministic when a seed function is supplied (tests, templates). */
export function newId(prefix = 'e', rand = Math.random) {
  idCounter = (idCounter + 1) % 1296;
  const r = Math.floor(rand() * 2176782336).toString(36).padStart(6, '0');
  return prefix + r + idCounter.toString(36).padStart(2, '0');
}

export const DEFAULT_SETTINGS = Object.freeze({ lives: 3, hearts: 3, difficulty: 'normal', music: true, sound: true });
export const DEFAULT_PUBLISH = Object.freeze({ adBreaks: false, rewardedContinue: false, showCredits: true });

/** Default rules for a new level of a genre. */
export function defaultRules(genre) {
  const g = genreById(genre);
  return {
    win: g ? g.wins[0] : 'goal',
    timeLimit: 0,        // seconds; 0 means none
    survive: 60,         // seconds, for the "survive" win rule
    par: 0,              // seconds (moves in a puzzle) for the third star; 0 means the analyser's estimate
    dark: false,         // adventure at night: only a pool of light around the hero
    slingshot: genre === 'adventure' ? false : undefined, // adventure only: give the hero a slingshot
  };
}

/** A new, empty level for a genre: the frame of a playable space, never a blank grid. */
export function createLevel(genre, opts = {}) {
  const g = genreById(genre) || genreById('platformer');
  const width = clampInt(opts.width ?? g.size.width, g.minSize.width, g.maxSize.width);
  const height = clampInt(opts.height ?? g.size.height, g.minSize.height, g.maxSize.height);
  const terrain = new Uint16Array(width * height);
  const decor = new Uint16Array(width * height);
  const entities = [];
  if (!opts.empty) {
    if (g.view === 'side') {
      for (let y = height - 3; y < height; y++) for (let x = 0; x < width; x++) terrain[y * width + x] = 1;
      entities.push({ id: newId('e'), type: 'player', x: 2, y: height - 4, props: {} });
      if (genre === 'platformer') entities.push({ id: newId('e'), type: 'goal', x: width - 4, y: height - 4, props: {} });
    } else {
      for (let x = 0; x < width; x++) { terrain[x] = 20; terrain[(height - 1) * width + x] = 20; }
      for (let y = 0; y < height; y++) { terrain[y * width] = 20; terrain[y * width + width - 1] = 20; }
      entities.push({ id: newId('e'), type: 'player', x: 2, y: Math.floor(height / 2), props: {} });
      if (genre === 'adventure') entities.push({ id: newId('e'), type: 'goal', x: width - 3, y: Math.floor(height / 2), props: {} });
    }
  }
  return {
    id: opts.id || newId('l'),
    name: opts.name || 'Level 1',
    width, height,
    biome: BIOME_IDS.includes(opts.biome) ? opts.biome : 'meadow',
    time: TIME_IDS.includes(opts.time) ? opts.time : 'day',
    rules: { ...defaultRules(genre), ...(opts.rules || {}) },
    terrain, decor, entities, links: [], notes: '',
  };
}

export function createProject(genre = 'platformer', opts = {}) {
  const g = genreById(genre) ? genre : 'platformer';
  return {
    kind: FORMAT_KIND, version: FORMAT_VERSION,
    id: opts.id || newId('g'),
    title: opts.title || `Untitled ${genreById(g).name.toLowerCase()}`,
    studio: opts.studio || '',
    description: opts.description || '',
    accent: opts.accent || '#ff9f45',
    genre: g,
    template: opts.template || null,
    settings: { ...DEFAULT_SETTINGS, ...(opts.settings || {}) },
    publish: { ...DEFAULT_PUBLISH, ...(opts.publish || {}) },
    levels: opts.levels || [createLevel(g, { name: 'Level 1', biome: opts.biome })],
  };
}

/** Deep copy of a level (typed arrays included). */
export function cloneLevel(level) {
  return {
    ...level,
    rules: { ...level.rules },
    terrain: new Uint16Array(level.terrain),
    decor: new Uint16Array(level.decor),
    entities: level.entities.map(e => ({ ...e, props: { ...e.props } })),
    links: level.links.map(l => ({ ...l })),
  };
}
export function cloneProject(p) {
  return { ...p, settings: { ...p.settings }, publish: { ...p.publish }, levels: p.levels.map(cloneLevel) };
}

// ---------------------------------------------------------------------------------------
// Serialisation

/** A plain-JSON document (typed arrays as run-length strings), ready for JSON.stringify. */
export function toDocument(project) {
  return {
    kind: FORMAT_KIND, version: FORMAT_VERSION,
    id: project.id, title: project.title, studio: project.studio, description: project.description,
    accent: project.accent, genre: project.genre, template: project.template,
    settings: { ...project.settings }, publish: { ...project.publish },
    levels: project.levels.map(l => ({
      id: l.id, name: l.name, width: l.width, height: l.height, biome: l.biome, time: l.time,
      rules: stripUndefined({ ...l.rules }),
      terrain: rleEncode(l.terrain), decor: rleEncode(l.decor),
      entities: l.entities.map(e => ({ id: e.id, type: e.type, x: e.x, y: e.y, props: { ...e.props } })),
      links: l.links.map(k => ({ from: k.from, to: k.to })),
      notes: l.notes || '',
    })),
  };
}
export function serializeProject(project, space = 0) { return JSON.stringify(toDocument(project), null, space || undefined); }

/** Parse file text into a normalised in-memory project. Throws FormatError. */
export function parseProject(text) {
  if (typeof text !== 'string') throw new FormatError('Expected text');
  if (text.length > MAX_FILE_BYTES) throw new FormatError(`File is larger than ${MAX_FILE_BYTES / 1048576} MB`);
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new FormatError('Not a JSON file'); }
  return normalizeProject(doc);
}

/**
 * Accept a document (from a file, a link, storage or a template) and return an in-memory
 * project with every default filled. `warnings` (optional array) collects what was dropped.
 */
export function normalizeProject(doc, warnings = []) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new FormatError('Expected a project object');
  if (doc.kind !== undefined && doc.kind !== FORMAT_KIND) throw new FormatError(`This is a "${String(doc.kind).slice(0, 40)}" file, not a level builder game`, 'kind');
  const version = doc.version ?? FORMAT_VERSION;
  if (typeof version !== 'number' || version < 1) throw new FormatError('Unknown format version', 'version');
  if (version > FORMAT_VERSION) throw new FormatError(`Made by a newer builder (format ${version}); this one reads up to ${FORMAT_VERSION}`, 'version');
  const genre = GENRE_IDS.includes(doc.genre) ? doc.genre : null;
  if (!genre) throw new FormatError(`Unknown genre "${String(doc.genre).slice(0, 24)}"`, 'genre');
  if (!Array.isArray(doc.levels) || !doc.levels.length) throw new FormatError('A game needs at least one level', 'levels');
  if (doc.levels.length > LIMITS.levels) throw new FormatError(`At most ${LIMITS.levels} levels`, 'levels');
  const settings = { ...DEFAULT_SETTINGS };
  const s = doc.settings || {};
  settings.lives = clampInt(s.lives ?? settings.lives, 0, 9);
  settings.hearts = clampInt(s.hearts ?? settings.hearts, 1, 6);
  settings.difficulty = ['easy', 'normal', 'hard'].includes(s.difficulty) ? s.difficulty : 'normal';
  settings.music = s.music !== false;
  settings.sound = s.sound !== false;
  const pub = doc.publish || {};
  const project = {
    kind: FORMAT_KIND, version: FORMAT_VERSION,
    id: typeof doc.id === 'string' && /^[\w-]{1,40}$/.test(doc.id) ? doc.id : newId('g'),
    title: text(doc.title, LIMITS.titleLength) || 'Untitled game',
    studio: text(doc.studio, 40),
    description: text(doc.description, 200),
    accent: /^#[0-9a-f]{6}$/i.test(doc.accent || '') ? doc.accent : '#ff9f45',
    genre,
    template: typeof doc.template === 'string' ? doc.template.slice(0, 40) : null,
    settings,
    publish: { adBreaks: pub.adBreaks === true, rewardedContinue: pub.rewardedContinue === true, showCredits: pub.showCredits !== false },
    levels: doc.levels.map((l, i) => normalizeLevel(l, genre, `levels[${i}]`, warnings)),
  };
  const ids = new Set();
  for (const l of project.levels) { if (ids.has(l.id)) l.id = newId('l'); ids.add(l.id); }
  return project;
}

export function normalizeLevel(l, genre, path = 'level', warnings = []) {
  if (!l || typeof l !== 'object') throw new FormatError('Expected a level object', path);
  const g = genreById(genre);
  const width = +l.width, height = +l.height;
  if (!Number.isInteger(width) || width < g.minSize.width || width > g.maxSize.width) throw new FormatError(`Width must be ${g.minSize.width}–${g.maxSize.width}`, path + '.width');
  if (!Number.isInteger(height) || height < g.minSize.height || height > g.maxSize.height) throw new FormatError(`Height must be ${g.minSize.height}–${g.maxSize.height}`, path + '.height');
  const n = width * height;
  const terrain = readCells(l.terrain, n, path + '.terrain');
  const decor = readCells(l.decor, n, path + '.decor');
  const view = viewOf(genre);
  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    if (t && !(tileByCode(t)?.genres.includes(genre))) { terrain[i] = 0; warnings.push(`${path}: dropped a tile (${t}) this genre does not use`); }
    const d = decor[i];
    if (d && !(decorByCode(d)?.views.includes(view))) { decor[i] = 0; warnings.push(`${path}: dropped decor (${d}) this view does not draw`); }
  }
  const rules = { ...defaultRules(genre), ...(l.rules && typeof l.rules === 'object' ? l.rules : {}) };
  if (!g.wins.includes(rules.win)) rules.win = g.wins[0];
  rules.timeLimit = clampInt(rules.timeLimit, 0, 3600);
  rules.survive = clampInt(rules.survive, 5, 3600);
  rules.par = clampInt(rules.par, 0, 99999);
  rules.dark = rules.dark === true;
  if (genre === 'adventure') rules.slingshot = rules.slingshot === true; else delete rules.slingshot;
  const entities = [];
  const seen = new Set();
  for (const [j, e] of (Array.isArray(l.entities) ? l.entities : []).entries()) {
    const ep = `${path}.entities[${j}]`;
    const def = entityDef(e?.type);
    if (!def || !def.genres.includes(genre)) { warnings.push(`${ep}: dropped "${String(e?.type).slice(0, 20)}", not part of this genre`); continue; }
    const x = +e.x, y = +e.y;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) { warnings.push(`${ep}: dropped, outside the level`); continue; }
    let id = typeof e.id === 'string' && /^[\w-]{1,40}$/.test(e.id) ? e.id : newId('e');
    if (seen.has(id)) id = newId('e');
    seen.add(id);
    entities.push({ id, type: def.type, x, y, props: normalizeProps(def.type, genre, e.props) });
  }
  const byId = new Map(entities.map(e => [e.id, e]));
  const links = [];
  const linkKeys = new Set();
  for (const k of Array.isArray(l.links) ? l.links : []) {
    const a = byId.get(k?.from), b = byId.get(k?.to);
    if (!a || !b || !canLink(a, b)) { warnings.push(`${path}: dropped a wire that no longer connects two parts`); continue; }
    const key = a.id + '>' + b.id;
    if (linkKeys.has(key)) continue;
    linkKeys.add(key);
    links.push({ from: a.id, to: b.id });
  }
  return {
    id: typeof l.id === 'string' && /^[\w-]{1,40}$/.test(l.id) ? l.id : newId('l'),
    name: text(l.name, 40) || 'Untitled level',
    width, height,
    biome: BIOME_IDS.includes(l.biome) ? l.biome : 'meadow',
    time: TIME_IDS.includes(l.time) ? l.time : 'day',
    rules, terrain, decor, entities, links,
    notes: text(l.notes, 1000),
  };
}

/** Coerce an entity's props to what its type means in this genre, with defaults. */
export function normalizeProps(type, genre, props) {
  const out = defaultProps(type, genre);
  const src = props && typeof props === 'object' ? props : {};
  for (const p of propsFor(type, genre)) {
    if (!(p.key in src)) continue;
    const v = src[p.key];
    if (p.type === 'int') out[p.key] = clampInt(v, p.min, p.max);
    else if (p.type === 'float') { const f = clampNum(v, p.min, p.max); out[p.key] = p.step ? Math.round(f / p.step) * p.step : f; }
    else if (p.type === 'bool') out[p.key] = v === true;
    else if (p.type === 'text') out[p.key] = text(v, p.max || LIMITS.textLength);
    else if (p.type === 'enum') { const opts = optionsFor(p, genre); if (opts.includes(v)) out[p.key] = v; }
  }
  if (type === 'key' && !KEY_COLOR_IDS.includes(out.color)) out.color = 'amber';
  return out;
}

function readCells(v, n, path) {
  if (v instanceof Uint16Array) { if (v.length !== n) throw new FormatError(`Expected ${n} cells`, path); return new Uint16Array(v); }
  if (Array.isArray(v)) { if (v.length !== n) throw new FormatError(`Expected ${n} cells`, path); return Uint16Array.from(v, c => clampInt(c, 0, 65535)); }
  if (v === undefined || v === null || v === '') return new Uint16Array(n);
  if (typeof v !== 'string') throw new FormatError('Expected run-length text', path);
  try { return rleDecode(v, n); } catch (e) { throw new FormatError(e.message, path); }
}

// ---------------------------------------------------------------------------------------
// Share links: the whole game, deflated, in a URL fragment

const b64url = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = str => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
/** Bytes through a (de)compression stream. Past `limit` output bytes it stops reading and returns null. */
async function pipeBytes(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    // a few KB of link can inflate to gigabytes: stop before holding them
    if (size > limit) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Encode a project for a link fragment. "1." marks deflate-raw, "0." plain (no CompressionStream). */
export async function encodeShare(project) {
  const bytes = new TextEncoder().encode(serializeProject(project));
  if (typeof CompressionStream === 'function') return '1.' + b64url(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
  return '0.' + b64url(bytes);
}
export async function decodeShare(code) {
  const m = /^([01])\.([\w-]+)$/.exec(String(code || '').trim());
  if (!m) throw new FormatError('This link does not hold a game');
  let bytes;
  try { bytes = unb64url(m[2]); } catch { throw new FormatError('This link is damaged'); }
  if (m[1] === '1') {
    if (typeof DecompressionStream !== 'function') throw new FormatError('This browser cannot open compressed links');
    try { bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'), MAX_FILE_BYTES); } catch { throw new FormatError('This link is damaged'); }
  }
  if (!bytes || bytes.length > MAX_FILE_BYTES) throw new FormatError('This link holds too much');
  return parseProject(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------------------

export function clampInt(v, lo, hi) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
export function clampNum(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
function text(v, max) { return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : ''; }
function stripUndefined(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }

/** The win-rule line for a level, for HUDs and cards. */
export function objectiveText(level) { return WIN_RULES[level.rules.win]?.hud || 'Finish the level'; }
