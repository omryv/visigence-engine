/**
 * THE PROJECT FILE CONTRACT.
 *
 * A project is the one document every surface exchanges: the studio saves it to
 * localStorage, `.visigames.json` downloads and game ZIPs carry it, a "Beat this" link
 * encodes it, and the runtime compiles it. Until now its shape was whatever
 * `resolveProject` happened to accept, and a bad file said "Unsupported blueprint" without
 * saying where. This module is the contract: a format version with a migration table, a
 * size cap, and validation that names the field it rejects (`blueprint.nodes[3].kind`).
 *
 * WHAT IS VERSIONED. The FILE ENVELOPE `{ kind, version, ...project }` is what a download
 * or a ZIP carries. `kind` names the document, `version` the format. A bare project (no
 * envelope) is what localStorage and mission links carry; it is read as the current
 * format. The blueprint keeps its own `version` field (world/blueprint.js) because it is
 * a nested document with its own history.
 *
 * WHAT VALIDATION DOES NOT DO. It checks shape and budgets, not meaning: whether a theme
 * exists, a weapon belongs to a catalogue or a prop overlaps a route is the compiler's
 * business (`resolveProject`, `normalizeBlueprint`, `placeImportedProps`). Those throw
 * their own messages, now with the field named, because the shape check ran first.
 */

import { liftToGame, LEVEL_KEYS, MAX_LEVELS } from './level/game.js';

/** The current document kind. `vsight.project` is the launch-era name, still opened. */
export const PROJECT_FILE_KIND = 'visigames.project';
export const LEGACY_PROJECT_FILE_KINDS = ['vsight.project'];
/** The current format version. Bump it with an entry in MIGRATIONS. */
export const PROJECT_FILE_VERSION = 4;
/**
 * Hard cap on a project document's UTF-8 size. A one-level mission at every limit (60 nodes,
 * 120 edges, 8 imported props, two artworks, a 300-character licence each) is under 40 KB, and
 * a level's hand edits at theirs (200 placed things, 400 overrides, 120 wires, painted ground)
 * add about 50 KB, so eight such levels stay under the cap; a real game is a small fraction of
 * it. A file open reads the whole document before parsing it, so the bound is well above real
 * use and well below what a parser should be handed by a stranger.
 */
export const MAX_PROJECT_BYTES = 512 * 1024;

const OBJECTIVE_IDS = ['activate', 'override', 'waves', 'eliminate', 'boss', 'barricade', 'reach', 'extract', 'collect', 'survive'];
const EDIT_KEYS = ['version', 'start', 'entities', 'overrides', 'regions', 'wires'];
const NODE_KIND_IDS = ['world', 'weapons', 'enemies', 'doors', 'props', 'generator', 'objective', 'output'];
const POOL_KINDS = ['world', 'weapons', 'enemies', 'doors', 'props'];

/**
 * Top-level fields. `number` accepts a numeric string because the studio's form inputs
 * have always been read through `Number()` downstream. `nullable` allows an explicit null.
 */
export const PROJECT_FIELDS = {
  name: { type: 'string', max: 64 },
  genre: { type: 'string' },
  theme: { type: 'string' },
  difficulty: { type: 'string' },
  behavior: { type: 'string' },
  cover: { type: 'string' },
  weapon: { type: 'string' },
  camera: { type: 'string' },
  lighting: { type: 'string' },
  palette: { type: 'string' },
  quality: { type: 'string' },
  ground: { type: 'string' },
  player: { type: 'string', max: 64 },
  seed: { type: 'seed' },
  worldParams: { type: 'object', nullable: true },
  worldSite: { type: 'object', nullable: true },
  enemyCount: { type: 'number' },
  objectives: { type: 'number' },
  frameRate: { type: 'number' },
  missionProfile: { type: 'string', nullable: true },
  blueprint: { type: 'blueprint' },
  importedProps: { type: 'importedProps' },
  presentation: { type: 'presentation' },
  settings: { type: 'object' },
  edits: { type: 'edits' },
  publish: { type: 'object' },
  levels: { type: 'levels' },
};
const ENVELOPE_FIELDS = ['kind', 'version'];

export class ProjectFormatError extends Error {
  /**
   * @param {string|null} path  the offending field, dotted, with array indices (`blueprint.edges[4].to`)
   * @param {string} message    what is wrong with it
   */
  constructor(path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ProjectFormatError';
    this.path = path;
    this.detail = message;
  }
}

/**
 * Format migrations, keyed by the version they read. Each returns the document one version
 * up. The table is walked from the file's version to PROJECT_FILE_VERSION, so a version-1
 * file passes through every step.
 *
 * 1 -> 2: the launch-era `vsight.project` document. Its fields are the same set; the only
 * change was the document kind. Kept as a real step so the walk is exercised and so the
 * next format change has a shape to copy.
 */
export const MIGRATIONS = {
  1: (doc) => ({ ...doc, kind: PROJECT_FILE_KIND, version: 2 }),
  /**
   * 2 -> 3: the `genre` field. Every earlier document is a shooter, which is what the
   * field says when absent, so the step only makes the implicit explicit.
   */
  2: (doc) => ({ ...doc, genre: doc.genre ?? 'shooter', version: 3 }),
  /**
   * 3 -> 4: a game of levels (world/level/game.js). A format-3 document is one mission; it
   * becomes a game with that mission as its only level, its per-level fields moved into it.
   */
  3: (doc) => ({ ...liftToGame(doc), version: 4 }),
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNumeric = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const typeName = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/**
 * Check a document's SHAPE. Returns every problem found rather than the first, so a file
 * with three mistakes is fixed in one round; `warnings` lists unknown fields, which are
 * carried but ignored (a newer studio's field in an older one, or a hand edit).
 *
 * @param {unknown} raw  a project or a project file, parsed
 * @returns {{errors: {path: string, message: string}[], warnings: {path: string, message: string}[]}}
 */
export function validateProject(raw) {
  const errors = [], warnings = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!isPlainObject(raw)) return { errors: [{ path: '', message: `expected a project object, got ${typeName(raw)}` }], warnings };

  for (const [key, value] of Object.entries(raw)) {
    if (ENVELOPE_FIELDS.includes(key)) continue;
    const spec = PROJECT_FIELDS[key];
    if (!spec) { warnings.push({ path: key, message: 'unknown field, ignored' }); continue; }
    if (value === undefined) continue;
    if (value === null) { if (!spec.nullable) fail(key, 'must not be null'); continue; }
    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') fail(key, `expected a string, got ${typeName(value)}`);
        else if (spec.max && value.length > spec.max) fail(key, `longer than ${spec.max} characters`);
        break;
      case 'number':
        if (!isNumeric(value)) fail(key, `expected a number, got ${typeName(value)}`);
        break;
      case 'seed':
        if (typeof value !== 'string' && typeof value !== 'number') fail(key, `expected a seed string, got ${typeName(value)}`);
        else if (String(value).length > 64) fail(key, 'longer than 64 characters');
        break;
      case 'blueprint': validateBlueprintShape(value, key, fail); break;
      case 'importedProps': validateImportedPropsShape(value, key, fail); break;
      case 'presentation': validatePresentationShape(value, key, fail); break;
      case 'object': if (!isPlainObject(value)) fail(key, `expected an object, got ${typeName(value)}`); break;
      case 'edits': validateEditsShape(value, key, fail); break;
      case 'levels': validateLevelsShape(value, key, fail, warnings); break;
    }
  }
  return { errors, warnings };
}

/** A level list: 1 to MAX_LEVELS levels, each with an id, a name and the per-level fields of a flat project. */
function validateLevelsShape(levels, path, fail, warnings) {
  if (!Array.isArray(levels)) return fail(path, `expected an array, got ${typeName(levels)}`);
  if (!levels.length || levels.length > MAX_LEVELS) fail(path, `${levels.length} levels, a game holds 1 to ${MAX_LEVELS}`);
  levels.forEach((level, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(level)) return fail(p, `expected a level object, got ${typeName(level)}`);
    for (const f of ['id', 'name']) if (level[f] !== undefined && typeof level[f] !== 'string') fail(`${p}.${f}`, `expected a string, got ${typeName(level[f])}`);
    const { id, name, ...fields } = level;
    for (const key of Object.keys(fields)) if (!LEVEL_KEYS.includes(key)) warnings.push({ path: `${p}.${key}`, message: 'unknown level field, ignored' });
    const nested = validateProject(Object.fromEntries(Object.entries(fields).filter(([k]) => LEVEL_KEYS.includes(k))));
    for (const e of nested.errors) fail(`${p}.${e.path}`, e.message);
  });
}

/** A level's hand edits: the shape here, the meaning (ranges, types, wires) in world/level/edits.js. */
function validateEditsShape(e, path, fail) {
  if (!isPlainObject(e)) return fail(path, `expected an object, got ${typeName(e)}`);
  for (const key of Object.keys(e)) if (!EDIT_KEYS.includes(key)) fail(`${path}.${key}`, 'unknown edits field');
  if (e.start != null && (!isPlainObject(e.start) || !isNumeric(e.start.x) || !isNumeric(e.start.z))) fail(`${path}.start`, 'expected { x, z, yaw } or null');
  if (e.entities !== undefined) {
    if (!Array.isArray(e.entities)) fail(`${path}.entities`, `expected an array, got ${typeName(e.entities)}`);
    else e.entities.forEach((x, i) => {
      const p = `${path}.entities[${i}]`;
      if (!isPlainObject(x)) return fail(p, `expected an object, got ${typeName(x)}`);
      for (const f of ['id', 'type']) if (typeof x[f] !== 'string') fail(`${p}.${f}`, `expected a string, got ${typeName(x[f])}`);
      for (const f of ['x', 'z']) if (!isNumeric(x[f])) fail(`${p}.${f}`, `expected a number, got ${typeName(x[f])}`);
      if (x.props !== undefined && !isPlainObject(x.props)) fail(`${p}.props`, `expected an object, got ${typeName(x.props)}`);
    });
  }
  if (e.overrides !== undefined && !isPlainObject(e.overrides)) fail(`${path}.overrides`, `expected an object, got ${typeName(e.overrides)}`);
  if (e.regions !== undefined && typeof e.regions !== 'string') fail(`${path}.regions`, `expected a string, got ${typeName(e.regions)}`);
  if (e.wires !== undefined) {
    if (!Array.isArray(e.wires)) fail(`${path}.wires`, `expected an array, got ${typeName(e.wires)}`);
    else e.wires.forEach((w, i) => { if (!isPlainObject(w) || typeof w.from !== 'string' || typeof w.to !== 'string') fail(`${path}.wires[${i}]`, 'expected { from, to }'); });
  }
}

function validateBlueprintShape(b, path, fail) {
  if (!isPlainObject(b)) return fail(path, `expected an object, got ${typeName(b)}`);
  if (b.version !== 1) fail(`${path}.version`, `unsupported blueprint version ${JSON.stringify(b.version)} (this build reads 1)`);
  if (!Array.isArray(b.nodes)) fail(`${path}.nodes`, `expected an array, got ${typeName(b.nodes)}`);
  else {
    if (b.nodes.length > 60) fail(`${path}.nodes`, `${b.nodes.length} nodes, the limit is 60`);
    const ids = new Set();
    b.nodes.forEach((n, i) => {
      const p = `${path}.nodes[${i}]`;
      if (!isPlainObject(n)) return fail(p, `expected a node object, got ${typeName(n)}`);
      if (typeof n.id !== 'string' || !/^[-a-zA-Z0-9_]{1,48}$/.test(n.id)) fail(`${p}.id`, 'expected 1-48 letters, digits, - or _');
      else if (ids.has(n.id)) fail(`${p}.id`, `duplicate node id "${n.id}"`);
      else ids.add(n.id);
      if (!NODE_KIND_IDS.includes(n.kind)) fail(`${p}.kind`, `unknown node kind ${JSON.stringify(n.kind)}`);
      for (const axis of ['x', 'y']) if (n[axis] !== undefined && !isNumeric(n[axis])) fail(`${p}.${axis}`, `expected a number, got ${typeName(n[axis])}`);
      if (POOL_KINDS.includes(n.kind)) {
        if (!Array.isArray(n.items)) fail(`${p}.items`, `expected an array of ids, got ${typeName(n.items)}`);
        else if (n.items.length > 200) fail(`${p}.items`, `${n.items.length} items, the limit is 200`);
        else n.items.forEach((item, j) => { if (typeof item !== 'string' || item.length > 80) fail(`${p}.items[${j}]`, 'expected an id string of at most 80 characters'); });
      }
      if (n.kind === 'objective') {
        if (!OBJECTIVE_IDS.includes(n.objective)) fail(`${p}.objective`, `unknown objective ${JSON.stringify(n.objective)}`);
        for (const f of ['count', 'duration']) if (n[f] !== undefined && !isNumeric(n[f])) fail(`${p}.${f}`, `expected a number, got ${typeName(n[f])}`);
      }
    });
  }
  if (!Array.isArray(b.edges)) fail(`${path}.edges`, `expected an array, got ${typeName(b.edges)}`);
  else {
    if (b.edges.length > 120) fail(`${path}.edges`, `${b.edges.length} connections, the limit is 120`);
    b.edges.forEach((e, i) => {
      const p = `${path}.edges[${i}]`;
      if (!isPlainObject(e)) return fail(p, `expected a connection object, got ${typeName(e)}`);
      for (const f of ['from', 'out', 'to', 'input']) if (typeof e[f] !== 'string' || !e[f]) fail(`${p}.${f}`, `expected a non-empty string, got ${typeName(e[f])}`);
    });
  }
}

function validateImportedPropsShape(list, path, fail) {
  if (!Array.isArray(list)) return fail(path, `expected an array, got ${typeName(list)}`);
  if (list.length > 8) fail(path, `${list.length} props, the limit is 8`);
  list.forEach((a, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(a)) return fail(p, `expected a prop object, got ${typeName(a)}`);
    if (typeof a.id !== 'string' || !/^[a-f0-9]{64}$/.test(a.id)) fail(`${p}.id`, 'expected a 64-character SHA-256 hex id');
    if (!Array.isArray(a.size) || a.size.length !== 3 || !a.size.every(isNumeric)) fail(`${p}.size`, 'expected three numbers [width, height, depth]');
    if (!isNumeric(a.scale)) fail(`${p}.scale`, `expected a number, got ${typeName(a.scale)}`);
    if (!['box', 'none'].includes(a.collision)) fail(`${p}.collision`, `expected "box" or "none", got ${JSON.stringify(a.collision)}`);
    for (const f of ['triangles', 'bytes']) if (!Number.isInteger(a[f])) fail(`${p}.${f}`, `expected an integer, got ${typeName(a[f])}`);
    for (const f of ['creator', 'license']) if (typeof a[f] !== 'string' || !a[f].trim()) fail(`${p}.${f}`, 'expected a non-empty string');
    if (a.rightsConfirmed !== true) fail(`${p}.rightsConfirmed`, 'must be true: imported props need a redistribution declaration');
    if (a.transform != null) {
      if (!isPlainObject(a.transform)) fail(`${p}.transform`, `expected an object, got ${typeName(a.transform)}`);
      else for (const f of ['x', 'z']) if (!isNumeric(a.transform[f])) fail(`${p}.transform.${f}`, `expected a number, got ${typeName(a.transform[f])}`);
    }
  });
}

function validatePresentationShape(pr, path, fail) {
  if (!isPlainObject(pr)) return fail(path, `expected an object, got ${typeName(pr)}`);
  if (pr.studioName !== undefined && typeof pr.studioName !== 'string') fail(`${path}.studioName`, `expected a string, got ${typeName(pr.studioName)}`);
  if (pr.accent !== undefined && (typeof pr.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(pr.accent))) fail(`${path}.accent`, 'expected a #rrggbb colour');
  for (const kind of ['artwork', 'logo']) {
    const a = pr[kind]; if (a == null) continue;
    const p = `${path}.${kind}`;
    if (!isPlainObject(a)) { fail(p, `expected an image object, got ${typeName(a)}`); continue; }
    if (typeof a.id !== 'string' || !/^[a-f0-9]{64}$/.test(a.id)) fail(`${p}.id`, 'expected a 64-character SHA-256 hex id');
    if (!['image/png', 'image/jpeg'].includes(a.mime)) fail(`${p}.mime`, `expected image/png or image/jpeg, got ${JSON.stringify(a.mime)}`);
    for (const f of ['bytes', 'width', 'height']) if (!Number.isInteger(a[f])) fail(`${p}.${f}`, `expected an integer, got ${typeName(a[f])}`);
    if (a.rightsConfirmed !== true) fail(`${p}.rightsConfirmed`, 'must be true: artwork needs a redistribution declaration');
  }
}

/** Throw the first shape error as a ProjectFormatError; the compiler's own checks follow. */
export function assertProjectShape(raw) {
  const { errors } = validateProject(raw);
  if (errors.length) throw new ProjectFormatError(errors[0].path, errors[0].message);
}

/**
 * Bring a document to the current format. A bare project (no `kind`) is already current.
 * A file from a NEWER studio is refused rather than guessed at: its fields may mean
 * something this build does not know, and "opens but plays differently" is the worst
 * outcome for a shared mission.
 *
 * @returns {{project: object, from: number|null, migrated: boolean}} the project with the
 *   envelope removed, and which version it came from (null for a bare project)
 */
export function migrateProject(raw) {
  if (!isPlainObject(raw)) throw new ProjectFormatError('', `expected a project object, got ${typeName(raw)}`);
  if (raw.kind === undefined && raw.version === undefined) return { project: { ...raw }, from: null, migrated: false };
  if (raw.kind !== PROJECT_FILE_KIND && !LEGACY_PROJECT_FILE_KINDS.includes(raw.kind)) {
    throw new ProjectFormatError('kind', `not a Visigames project document (got ${JSON.stringify(raw.kind)})`);
  }
  let doc = { ...raw };
  const from = doc.version;
  if (!Number.isInteger(from) || from < 1) throw new ProjectFormatError('version', `expected a format version number, got ${JSON.stringify(from)}`);
  if (from > PROJECT_FILE_VERSION) throw new ProjectFormatError('version', `format ${from} is newer than this build reads (${PROJECT_FILE_VERSION}); update Visigames to open it`);
  for (let v = from; v < PROJECT_FILE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new ProjectFormatError('version', `no migration from format ${v}`);
    doc = step(doc);
  }
  const { kind, version, ...project } = doc;
  return { project, from, migrated: from !== PROJECT_FILE_VERSION };
}

/**
 * Parse project text from an untrusted source: a file, a pasted link, a ZIP.
 *
 * @param {string} text
 * @param {{requireEnvelope?: boolean}} [o]  a file must carry the envelope; a link need not
 * @returns {{project: object, from: number|null, migrated: boolean, warnings: {path: string, message: string}[]}}
 */
export function parseProjectText(text, { requireEnvelope = false } = {}) {
  if (typeof text !== 'string') throw new ProjectFormatError('', 'expected project text');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_PROJECT_BYTES) throw new ProjectFormatError('', `project is ${Math.round(bytes / 1024)} KB, the limit is ${MAX_PROJECT_BYTES / 1024} KB`);
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new ProjectFormatError('', `not valid JSON (${e.message})`); }
  if (requireEnvelope && (!isPlainObject(raw) || raw.kind === undefined)) throw new ProjectFormatError('kind', 'not a Visigames project file');
  const migrated = migrateProject(raw);
  const { errors, warnings } = validateProject(migrated.project);
  if (errors.length) throw new ProjectFormatError(errors[0].path, errors[0].message);
  return { ...migrated, warnings };
}

/** The envelope a download or a ZIP carries. */
export function packageProject(project) {
  return { kind: PROJECT_FILE_KIND, version: PROJECT_FILE_VERSION, ...project };
}
