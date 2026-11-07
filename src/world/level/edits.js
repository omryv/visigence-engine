/**
 * A LEVEL'S HAND EDITS: everything the 3D editor changed on top of what the seed and the graph generate.
 *
 *   start      the player start { x, z, yaw }, or null for the generator's (0, 28), facing north
 *   entities   placed things (world/level/entities.js): { id, type, x, z, yaw, scale?, props }
 *   overrides  changes to GENERATED things, keyed by the key the compiler gives each one
 *              (`step:<stepId>:<i>` for a mission pad, `gate:1`, `cover:2:-1`, `tree@12.3,-8.1` in the village,
 *              `enemy:0` for a generated critter): { x, z, yaw } to move it, { removed: true } to take it out
 *   regions    painted ground (world/level/regions.js), one run-length string
 *   wires      { from, to } between entity ids, from a lever or a trigger zone to a door or an enemy
 *
 * Why this survives regeneration: nothing here is a copy of generated output. A placed thing is an absolute
 * record the generator is told to make room for (a reserved place); an override names the generated thing by a
 * key that only changes when that thing itself is regenerated; a region is a mask. Change the seed or add a
 * mission step and the edits still apply to what they name; one whose target is gone is reported by the checks as
 * an orphaned edit rather than dropped.
 *
 * `normalizeEdits` is the meaning check the project schema's shape check leaves to it: numbers clamped into range,
 * unknown enum values back to their default, wires between things that can be wired and still exist.
 */
import { ENTITY_TYPES, EDIT_LIMITS, SCALE_RANGE, WORLD_HALF, KEY_COLORS, PLACEABLE_PROPS, canWire, defaultProps } from './entities.js';
import { decodeRegions, encodeRegions } from './regions.js';

export const EDITS_VERSION = 1;
export const DEFAULT_START = Object.freeze({ x: 0, z: 28, yaw: 0 });

export function createEdits() { return { version: EDITS_VERSION, start: null, entities: [], overrides: {}, regions: '', wires: [] }; }

export function isEmptyEdits(e) {
  return !e || (!e.start && !e.entities?.length && !Object.keys(e.overrides ?? {}).length && !e.regions && !e.wires?.length);
}

const round2 = v => Math.round(v * 100) / 100;
const clampPos = v => round2(Math.max(-WORLD_HALF, Math.min(WORLD_HALF, Number(v) || 0)));
/** A yaw folded into (-π, π], four decimals: what every consumer of a placement's yaw expects. */
export const normYaw = v => { const y = Number(v) || 0; return Math.round(Math.atan2(Math.sin(y), Math.cos(y)) * 1e4) / 1e4; };
const KEY_PATTERN = /^(step:[-a-zA-Z0-9_]{1,48}:\d{1,2}|gate:\d{1,2}|cover:\d{1,2}:-?1|enemy:\d{1,2}|dress:\d{1,2}|import:\d|[a-z][a-zA-Z.-]{0,30}@-?\d{1,2}\.\d,-?\d{1,2}\.\d(~\d{1,2})?)$/;
/** Generated things that stand on ground levelled for them: they can be taken out, not moved. */
export const FIXED_KEY = /^(house|landmark|bridge|basin)@/;

function normalizeProp(type, key, value) {
  const f = ENTITY_TYPES[type].props[key];
  switch (f.type) {
    case 'int': { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.max(f.min, Math.min(f.max, n)) : f.default; }
    case 'num': { const n = Number(value); return Number.isFinite(n) ? Math.round(Math.max(f.min, Math.min(f.max, n)) * 100) / 100 : f.default; }
    case 'enum': return f.values.includes(value) ? value : f.default;
    case 'prop': return PLACEABLE_PROPS.includes(value) ? value : f.default;
    case 'enemy': case 'variant': return typeof value === 'string' && /^[-a-zA-Z0-9_.]{0,40}$/.test(value) ? value : f.default;
  }
  return f.default;
}

export function normalizeEntity(e) {
  const def = ENTITY_TYPES[e?.type];
  if (!def) throw Error(`Unknown entity type ${JSON.stringify(e?.type)}`);
  if (typeof e.id !== 'string' || !/^[a-z0-9]{1,12}$/.test(e.id)) throw Error('Entity ids are 1-12 lowercase letters and digits');
  const props = defaultProps(e.type);
  for (const key of Object.keys(props)) if (e.props && Object.hasOwn(e.props, key)) props[key] = normalizeProp(e.type, key, e.props[key]);
  const out = { id: e.id, type: e.type, x: clampPos(e.x), z: clampPos(e.z), yaw: normYaw(e.yaw), props };
  if (def.scalable) { const s = Number(e.scale); out.scale = Number.isFinite(s) ? round2(Math.max(SCALE_RANGE[0], Math.min(SCALE_RANGE[1], s))) : 1; }
  return out;
}

function normalizeOverride(key, o) {
  if (!o || typeof o !== 'object') throw Error(`overrides.${key}: expected an object`);
  // A mission pad belongs to its step: it leaves with the step (or a lower count) in the graph, never by override.
  if (o.removed === true && key.startsWith('step:')) throw Error(`overrides.${key}: a mission pad is removed from its step in the mission graph`);
  if (o.removed === true) return { removed: true };
  if (FIXED_KEY.test(key)) throw Error(`overrides.${key}: this generated thing stands on its own levelled ground; it can be removed, not moved`);
  const out = { x: clampPos(o.x), z: clampPos(o.z) };
  if (o.yaw !== undefined) out.yaw = normYaw(o.yaw);
  return out;
}

/**
 * @param {unknown} value  a level's `edits`, from a file, a link, storage or the editor
 * @returns a fresh, clamped copy; throws with the offending field for anything it cannot repair
 */
export function normalizeEdits(value) {
  if (value == null) return createEdits();
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('edits: expected an object');
  if (value.version !== undefined && value.version !== EDITS_VERSION) throw Error(`edits.version: this build reads ${EDITS_VERSION}`);
  const edits = createEdits();
  if (value.start) edits.start = { x: clampPos(value.start.x), z: clampPos(value.start.z), yaw: normYaw(value.start.yaw) };
  const list = value.entities ?? [];
  if (!Array.isArray(list) || list.length > EDIT_LIMITS.entities) throw Error(`edits.entities: at most ${EDIT_LIMITS.entities} placed things a level`);
  const ids = new Set(), perType = {};
  for (const [i, e] of list.entries()) {
    let n;
    try { n = normalizeEntity(e); } catch (error) { throw Error(`edits.entities[${i}]: ${error.message}`); }
    if (ids.has(n.id)) throw Error(`edits.entities[${i}].id: duplicate "${n.id}"`);
    perType[n.type] = (perType[n.type] ?? 0) + 1;
    if (perType[n.type] > ENTITY_TYPES[n.type].limit) throw Error(`edits.entities: at most ${ENTITY_TYPES[n.type].limit} ${ENTITY_TYPES[n.type].label.toLowerCase()} entries a level`);
    ids.add(n.id); edits.entities.push(n);
  }
  const overrides = value.overrides ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw Error('edits.overrides: expected an object');
  const keys = Object.keys(overrides);
  if (keys.length > EDIT_LIMITS.overrides) throw Error(`edits.overrides: at most ${EDIT_LIMITS.overrides} changes to generated things`);
  for (const key of keys.sort()) {
    if (!KEY_PATTERN.test(key)) throw Error(`edits.overrides: unknown key "${key.slice(0, 40)}"`);
    edits.overrides[key] = normalizeOverride(key, overrides[key]);
  }
  try { edits.regions = encodeRegions(decodeRegions(value.regions ?? '')); } catch (error) { throw Error(`edits.${error.message}`); }
  const wires = value.wires ?? [];
  if (!Array.isArray(wires) || wires.length > EDIT_LIMITS.wires) throw Error(`edits.wires: at most ${EDIT_LIMITS.wires} wires a level`);
  const byId = new Map(edits.entities.map(e => [e.id, e])), seen = new Set();
  for (const w of wires) {
    const from = byId.get(w?.from), to = byId.get(w?.to), k = `${w?.from}>${w?.to}`;
    // A wire whose end was deleted, or one that could never be made, is dropped: it carries no meaning.
    if (!from || !to || !canWire(from.type, to.type) || seen.has(k)) continue;
    seen.add(k); edits.wires.push({ from: from.id, to: to.id });
  }
  return edits;
}

/** The next free entity id in a level: `e1`, `e2`, … (short, so a 200-entity level stays small on disk). */
export function nextEntityId(edits, taken = new Set()) {
  let n = 1;
  const used = new Set([...edits.entities.map(e => e.id), ...taken]);
  while (used.has(`e${n}`)) n++;
  return `e${n}`;
}

/** Where the player starts: the edit's, else the generator's. */
export function startOf(edits) { return edits?.start ?? DEFAULT_START; }

/** Doors locked with a colour, and the keys of each colour, for the checks and the runtime. */
export function locksAndKeys(edits) {
  const locks = Object.fromEntries(KEY_COLORS.map(c => [c, []])), keys = Object.fromEntries(KEY_COLORS.map(c => [c, []]));
  for (const e of edits.entities) {
    if (e.type === 'door' && KEY_COLORS.includes(e.props.lock)) locks[e.props.lock].push(e);
    if (e.type === 'key') keys[e.props.color].push(e);
  }
  return { locks, keys };
}
