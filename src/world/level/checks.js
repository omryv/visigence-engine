/**
 * LIVE CHECKS: what the editor knows about a compiled level, as the creator edits it (docs/EDITOR.md).
 *
 * Every check reads the same data the game plays: the compiled level's nav grid, its placements registered as
 * blockers exactly as the game registers them (sim/placementBlockers.js), the mission steps, the hand edits and
 * the budgets the runtime enforces. Nothing here is a second opinion about what is walkable.
 *
 *   start        the player start stands on walkable ground, clear of anything solid
 *   reach        a flood from the start over the cells a body fits, opening doors as the player could: a gate or a
 *                hold door once it is reached, a locked door once a key of its colour is, a wired door once a
 *                lever or a trigger zone wired to it is. Then every mission pad, the extraction, every key,
 *                lever, collectible, supply and checkpoint must be within reach.
 *   logic        locks without keys, keys without locks, wired doors with nothing wired, levers and zones that
 *                drive nothing
 *   budgets      critters awake at once against the runtime's caps (phones and desktops), props on screen
 *   edits        changes to generated things that no longer find them (orphans), placed things inside a house
 *
 * The checks are generous on purpose: a false "unreachable" on a fine level teaches people to ignore them.
 * Every issue has a place ({x, z}) the editor can jump to. Pure: no three, no DOM.
 */
import { CollisionSystem } from '../../sim/CollisionSystem.js';
import { registerPlacementBlockers } from '../../sim/placementBlockers.js';
import { ENEMY_LIMITS, PLAYER } from '../../config/gameplay.js';
import { OBJECTIVE_KINDS } from '../blueprint.js';
import { ENTITY_TYPES, EDIT_LIMITS, KEY_COLORS } from './entities.js';

/** Budgets for the level as a whole: the runtime's own caps, and props sized for phones. */
export const BUDGETS = {
  crittersDesktop: ENEMY_LIMITS.maxAliveByTier.high,
  crittersPhone: ENEMY_LIMITS.maxAliveByTier.mobile,
  propsPhone: 90,
  propsDesktop: 160,
  placed: EDIT_LIMITS.entities,
};

const SEVERITY_ORDER = { error: 0, warning: 1, tip: 2 };
const KIND_LABEL = {
  tree: 'tree', broadleaf: 'tree', willow: 'tree', conifer: 'tree', blossom: 'tree', sapling: 'tree', orchard: 'tree',
  bush: 'bush', tuft: 'grass tuft', flowers: 'flower patch', mushrooms: 'mushroom patch', reeds: 'reeds', stump: 'stump',
  shore: 'shore plant', flora: 'plant', stone: 'stepping stone', sign: 'signpost', fence: 'fence', rocks: 'rocks',
  house: 'house', landmark: 'landmark', bridge: 'footbridge', basin: 'pool', healthSupply: 'honey jar', ammoSupply: 'pebble pouch',
  grenadeSupply: 'fizz-bomb', gate: 'gate', cover: 'cover', dress: 'prop', step: 'mission pad', enemy: 'critter',
};
function orphanLabel(key) {
  const kind = key.includes('@') ? key.split('@')[0] : key.split(':')[0];
  return KIND_LABEL[kind] ?? (key.includes('@') ? kind.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`) : 'generated thing');
}

/**
 * @param {object} level  what `compileShooterProject` returned
 * @param {{genre?: object}} [o]
 * @returns {{issues: object[], stats: object, reach: Uint8Array|null, grid: {n: number, cell: number, origin: {x: number, z: number}}}}
 */
export function checkLevel(level, { genre = null } = {}) {
  const issues = [];
  const add = (severity, code, message, at = null, ref = null) => issues.push({ id: `${code}:${ref ?? (at ? `${at.x},${at.z}` : '')}`, severity, code, message, at, ref });
  const collision = new CollisionSystem(level.grid);
  collision.terrain = level.terrain;
  registerPlacementBlockers(collision, level.placements, level.terrain);
  const n = collision.n, cell = collision.cell, radius = PLAYER.radius / cell;
  const entities = level.entities ?? [], byId = new Map(entities.map(e => [e.id, e]));
  const wires = level.wires ?? [], wiredTo = id => wires.filter(w => w.to === id), wiredFrom = id => wires.filter(w => w.from === id);
  const entityPlacement = id => level.placements.find(p => p.entity === id);
  const start = level.spawn.position, startAt = { x: start.x, z: start.z };

  // ---------------------------------------------------------------- logic: locks, keys, wires
  const keysOf = Object.fromEntries(KEY_COLORS.map(c => [c, entities.filter(e => e.type === 'key' && e.props.color === c)]));
  for (const e of entities) {
    const at = { x: e.x, z: e.z };
    if (e.type === 'door' && KEY_COLORS.includes(e.props.lock) && !keysOf[e.props.lock].length && !wiredTo(e.id).length) add('error', 'lock-no-key', `No ${e.props.lock} key opens this door. Place one, or change its lock.`, at, e.id);
    if (e.type === 'door' && e.props.lock === 'wired' && !wiredTo(e.id).length) add('error', 'door-unwired', 'Nothing opens this door. Wire a lever or a trigger zone to it.', at, e.id);
    if (e.type === 'key' && !entities.some(d => d.type === 'door' && d.props.lock === e.props.color)) add('warning', 'key-no-lock', `No door takes this ${e.props.color} key.`, at, e.id);
    if (ENTITY_TYPES[e.type].wireOut && !wiredFrom(e.id).length) add('warning', 'drives-nothing', `This ${ENTITY_TYPES[e.type].label.toLowerCase()} drives nothing. Wire it to a door or a critter.`, at, e.id);
  }

  // ---------------------------------------------------------------- the start
  const startFree = collision.isOpenAt(start.x, start.z) && collision.isFree(start.x, start.z, PLAYER.radius);
  if (!collision.isOpenAt(start.x, start.z)) add('error', 'start-off-ground', 'The player starts off the walkable ground (water, a cliff or a no-go area). Move the start.', startAt, 'start');
  else if (!startFree) add('error', 'start-blocked', 'The player starts inside something solid. Move the start or what it stands in.', startAt, 'start');

  // ---------------------------------------------------------------- reach: flood from the start, opening doors
  const doors = [];
  for (const [i, p] of level.placements.entries()) {
    if (p.collision === 'none' || p.collisionOnly) continue;
    const id = `prop:${i}:${p.id}`;
    if (p.entity && byId.get(p.entity)?.type === 'door') doors.push({ id, p, rule: byId.get(p.entity).props.lock, entity: byId.get(p.entity) });
    else if (p.interaction === 'override' || p.interaction === 'barricade') doors.push({ id, p, rule: 'hold', entity: null });
  }
  const reach = new Uint8Array(n * n), queue = new Int32Array(n * n);
  const fits = k => collision.walkable[k] && collision.clearance[k] >= radius && collision.dynamicClearance[k] >= radius;
  const flood = () => {
    reach.fill(0);
    if (!startFree) return 0;
    const s = collision.cellZ(start.z) * n + collision.cellX(start.x);
    let head = 0, tail = 0, count = 1;
    reach[s] = 1; queue[tail++] = s;
    while (head < tail) {
      const k = queue[head++], i = k % n, j = (k - i) / n;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const m = jj * n + ii;
        if (reach[m] || !fits(m)) continue;
        // A diagonal step needs both sides open: no squeezing between two corners.
        if (di && dj && !(fits(j * n + ii) && fits(jj * n + i))) continue;
        reach[m] = 1; queue[tail++] = m; count++;
      }
    }
    return count;
  };
  /** Is any reached cell within `r` metres of (x, z)? A solid thing is reached from beside it. */
  const reachedNear = (x, z, r) => {
    const i0 = Math.max(0, collision.cellX(x - r)), i1 = Math.min(n - 1, collision.cellX(x + r));
    const j0 = Math.max(0, collision.cellZ(z - r)), j1 = Math.min(n - 1, collision.cellZ(z + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (reach[j * n + i] && Math.hypot(collision.worldX(i) - x, collision.worldZ(j) - z) <= r) return true;
    return false;
  };
  const zoneReached = e => {
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw), hw = e.props.w / 2, hd = e.props.d / 2;
    const r = Math.hypot(hw, hd), i0 = Math.max(0, collision.cellX(e.x - r)), i1 = Math.min(n - 1, collision.cellX(e.x + r));
    const j0 = Math.max(0, collision.cellZ(e.z - r)), j1 = Math.min(n - 1, collision.cellZ(e.z + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!reach[j * n + i]) continue;
      const dx = collision.worldX(i) - e.x, dz = collision.worldZ(j) - e.z;
      if (Math.abs(dx * c - dz * s) <= hw && Math.abs(dx * s + dz * c) <= hd) return true;
    }
    return false;
  };
  const near = p => (p.halfX || p.radius || 0.5) + 1.6;
  const open = new Set();
  let reached = 0;
  for (let pass = 0; pass <= doors.length; pass++) {
    for (const d of doors) collision.setBlockerActive(d.id, !open.has(d.id));
    collision.rebuildDynamicMask();
    reached = flood();
    let opened = false;
    for (const d of doors) {
      if (open.has(d.id)) continue;
      const beside = reachedNear(d.p.x, d.p.z, near(d.p));
      const keyed = KEY_COLORS.includes(d.rule) && keysOf[d.rule].some(k => reachedNear(k.x, k.z, 1.4));
      const wired = d.entity && wiredTo(d.entity.id).some(w => { const src = byId.get(w.from); return src.type === 'trigger' ? zoneReached(src) : reachedNear(src.x, src.z, 2); });
      if ((d.rule === 'hold' && beside) || (beside && keyed) || wired) { open.add(d.id); opened = true; }
    }
    if (!opened) break;
  }

  if (startFree) {
    for (const p of level.placements) {
      if (!p.stepId) continue;
      const step = level.blueprint.mission.find(s => s.id === p.stepId);
      if (!reachedNear(p.x, p.z, near(p))) add('error', 'pad-unreachable', p.pickup === 'collectible' ? "Players can't reach this honey drop." : `Players can't reach this ${OBJECTIVE_KINDS[step.objective].label.toLowerCase()} pad.`, { x: p.x, z: p.z }, p.key);
    }
    const ex = level.extraction;
    if (level.blueprint.mission.some(s => s.objective === 'extract') && ex && !reachedNear(ex.x, ex.z, 2.6)) add('error', 'extract-unreachable', "Players can't reach the extraction.", { x: ex.x, z: ex.z }, ex.key);
    for (const e of entities) {
      const at = { x: e.x, z: e.z };
      if (e.type === 'trigger') { if (!zoneReached(e)) add('warning', 'zone-unreachable', 'The player never walks into this trigger zone.', at, e.id); continue; }
      if (e.type === 'enemy') {
        if (!collision.isOpenAt(e.x, e.z) || collision.hitsBlocker(e.x, e.z, 0.3)) add('warning', 'enemy-blocked', "This critter stands where it can't: it won't appear. Move it onto open ground.", at, e.id);
        continue;
      }
      const p = entityPlacement(e.id);
      if (!p || reachedNear(e.x, e.z, near(p))) continue;
      const blocking = e.type === 'key' || e.type === 'lever';
      add(blocking ? 'error' : 'warning', `${e.type}-unreachable`, `Players can't reach this ${ENTITY_TYPES[e.type].label.toLowerCase()}.`, at, e.id);
    }
  }

  // ---------------------------------------------------------------- placed things inside the village's buildings
  const structures = level.placements.filter(p => p.collisionOnly && (p.id === 'house-block' || p.id === 'landmark-block') && !p.parent?.startsWith('entity:'));
  for (const e of entities) {
    if (e.type === 'trigger' || (e.type === 'prop' && e.props.prop === 'nature')) continue;
    const inside = structures.find(s => s.collision === 'circle' ? Math.hypot(e.x - s.x, e.z - s.z) < s.radius + 0.2
      : Math.abs((e.x - s.x) * Math.cos(s.yaw ?? 0) - (e.z - s.z) * Math.sin(s.yaw ?? 0)) < s.halfX + 0.2 && Math.abs((e.x - s.x) * Math.sin(s.yaw ?? 0) + (e.z - s.z) * Math.cos(s.yaw ?? 0)) < s.halfZ + 0.2);
    if (inside) add('warning', 'inside-building', `This ${ENTITY_TYPES[e.type].label.toLowerCase()} stands inside a ${inside.id === 'house-block' ? 'house' : 'landmark'}.`, { x: e.x, z: e.z }, e.id);
  }

  // ---------------------------------------------------------------- budgets
  const removed = Object.values(level.enemyOverrides ?? {}).filter(o => o.removed).length;
  const awake = Math.max(0, (level.project?.enemyCount ?? 0) - removed) + entities.filter(e => e.type === 'enemy' && !wiredTo(e.id).length).reduce((s, e) => s + e.props.count, 0);
  const sleeping = entities.filter(e => e.type === 'enemy' && wiredTo(e.id).length).reduce((s, e) => s + e.props.count, 0);
  if (awake > BUDGETS.crittersDesktop) add('error', 'critters-over', `${awake} critters are awake at the start; only ${BUDGETS.crittersDesktop} can be at once, so ${awake - BUDGETS.crittersDesktop} won't appear. Wire some to a trigger zone to wake them later.`);
  else if (awake > BUDGETS.crittersPhone) add('warning', 'critters-phone', `${awake} critters are awake at the start; phones keep ${BUDGETS.crittersPhone} awake at once. Wire some to a trigger zone to wake them later.`);
  const props = level.placements.filter(p => p.model && !p.village && !p.collisionOnly && !p.part && !p.tree).length;
  if (props > BUDGETS.propsDesktop) add('error', 'props-over', `${props} props: past ${BUDGETS.propsDesktop}, the level will stutter on most machines.`);
  else if (props > BUDGETS.propsPhone) add('warning', 'props-phone', `${props} props: phones stay smooth up to about ${BUDGETS.propsPhone}.`);

  // ---------------------------------------------------------------- orphaned edits
  for (const key of level.orphans ?? []) add('warning', 'orphan', `A change to a generated ${orphanLabel(key)} no longer finds it: this part of the village was generated differently. Drop the change, or go back to the seed it was made on.`, null, key);

  // ---------------------------------------------------------------- genre
  if (genre && !genre.weapons) for (const e of entities) if (e.type === 'pickup' && e.props.kind !== 'health') add('tip', 'supply-unused', `${genre.label} has no weapons: this supply gives nothing.`, { x: e.x, z: e.z }, e.id);

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  let walkable = 0;
  for (let k = 0; k < n * n; k++) if (collision.walkable[k]) walkable++;
  return {
    issues,
    stats: { placed: entities.length, critters: awake, sleeping, props, reached, walkable, doorsOpened: open.size, doors: doors.length },
    reach: startFree ? reach : null,
    grid: { n, cell, origin: { x: collision.originX, z: collision.originZ } },
  };
}

/** Counts by severity, for the tally in the top bar. */
export function issueCounts(issues) {
  const c = { error: 0, warning: 0, tip: 0 };
  for (const i of issues) c[i.severity]++;
  return c;
}
