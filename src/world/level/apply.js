/**
 * APPLYING A LEVEL'S HAND EDITS to what the generator made (world/shooterProject.js calls these in order).
 *
 *   1. keys        every generated placement gets a stable key (edits.js explains the scheme)
 *   2. overrides   moved and removed generated things, by key; collision records follow their owner
 *   3. paths       painted path cells are cleared of clutter
 *   4. placements  placed things become placements the renderer, collision and runtime already understand
 *   5. clearing    the village's clutter round every placed or moved thing is cleared
 *   6. no-go       painted no-go cells leave the nav grid
 *
 * ALL OF IT HAPPENS AFTER THE VILLAGE IS LAID OUT. The layout (world/worldGrammar.js) sees only the generator's own
 * inputs: the seed, the graph and the mission's pad sites. Its landmarks take their hills by a global search, so
 * a single levelled pad fed to it can move the windmill across the map and re-plan everything after it; kept out
 * of it, a hand edit changes only what it names, and the village edits of a level keep applying whatever else the
 * creator does by hand. Pure: no three, no DOM, no randomness, and nothing here reads or changes the terrain
 * maths, which keeps the runtime's ground and its Blender port's in parity (docs/TERRAIN.md).
 */
import { ENTITY_TYPES } from './entities.js';
import { REGION_CODES, REGION_N, REGION_HALF, regionAt } from './regions.js';
import { generateHouse } from '../houseGrammar.js';
import { generateTree } from '../treeGrammar.js';
import { NATURE_PARTS } from '../natureParts.js';

/** A generated thing's key: what it is and where the generator put it, to a decimetre. */
export const villageKey = (kind, x, z) => `${kind}@${x.toFixed(1)},${z.toFixed(1)}`;

/** Give duplicate keys a `~n` suffix, in placement order (two stepping stones in one decimetre, say). */
export function uniqueKeys(placements) {
  const seen = new Map();
  for (const p of placements) {
    if (!p.key || p.parent) continue;
    const n = seen.get(p.key) ?? 0;
    seen.set(p.key, n + 1);
    if (n) p.key = `${p.key}~${n}`;
  }
}

/** How far round a placed thing the village's clutter is cleared, metres (entities.js `clear`; a prop's own size). */
export function clearRadius(e, pack) {
  const clear = ENTITY_TYPES[e.type].clear;
  if (clear !== null) return clear;
  const id = e.props.prop, s = e.scale ?? 1;
  if (id === 'house') return 5.5 * s;
  if (id === 'tree') return 1.4 * s;
  if (id === 'nature') return 0;
  const asset = pack.props.find(p => p.id === id);
  return (asset ? Math.hypot(...(asset.size ? [asset.size[0], asset.size[2]] : [asset.footprint, asset.footprint])) / 2 : 1) * s + 0.3;
}

/**
 * Move or remove generated placements by key. `accept(key)` limits a pass to the keys it may apply (the mission's
 * pads move before the village is laid out, the village's own things after). A placement with a `parent` key (a
 * trunk, a house's blocks) follows its owner. Returns the keys it applied.
 */
export function applyOverrides(placements, overrides, accept = () => true) {
  const applied = new Set(), moved = new Map();
  for (const p of placements) {
    const o = p.key && !p.parent && accept(p.key) ? overrides[p.key] : null;
    if (!o) continue;
    applied.add(p.key);
    if (o.removed) { p.removed = true; continue; }
    moved.set(p.key, { dx: o.x - p.x, dz: o.z - p.z });
    p.x = o.x; p.z = o.z; p.overridden = true; delete p.route;
    if (o.yaw !== undefined) p.yaw = o.yaw;
  }
  for (const p of placements) {
    if (!p.parent || !applied.has(p.parent)) continue;
    if (overrides[p.parent].removed) { p.removed = true; continue; }
    const d = moved.get(p.parent); p.x += d.dx; p.z += d.dz;
  }
  for (let i = placements.length - 1; i >= 0; i--) if (placements[i].removed) placements.splice(i, 1);
  return applied;
}

/** Village clutter a painted path or a placed thing clears: trees, rocks, flowers, stumps, fences. Houses, landmarks
 * and the water's built pieces stay. */
export const isClutter = p => p.village && !p.parent && !p.house && !p.landmark && !p.landmarkOf && !p.pickup
  && (p.tree || (p.part && !/^(bridge|basin)@/.test(p.key ?? '')) || ['rocks', 'fence'].includes(p.id));
function removeWithChildren(placements, gone) {
  for (let i = placements.length - 1; i >= 0; i--) {
    const p = placements[i];
    if (gone.has(p.key) || (p.parent && gone.has(p.parent))) placements.splice(i, 1);
  }
  return gone.size;
}
export function clearPaths(placements, cells) {
  const path = REGION_CODES.path, gone = new Set();
  for (const p of placements) if (isClutter(p) && regionAt(cells, p.x, p.z) === path) gone.add(p.key);
  return removeWithChildren(placements, gone);
}
/** Clear clutter within each spot's radius: `spots` are { x, z, r } (placed things, moved pads, a moved start). */
export function clearAround(placements, spots) {
  const gone = new Set();
  for (const s of spots) if (s.r > 0) for (const p of placements) if (isClutter(p) && Math.hypot(p.x - s.x, p.z - s.z) < s.r) gone.add(p.key);
  return removeWithChildren(placements, gone);
}

/** Nav cells (the 0.5 m grid) under a painted no-go cell (the 1 m grid) are refused to every body. */
export function applyNoGo(walkable, gridN, size, cells) {
  const nogo = REGION_CODES.nogo, cell = size / gridN;
  let refused = 0;
  for (let j = 0; j < gridN; j++) for (let i = 0; i < gridN; i++) {
    const x = -size / 2 + (i + 0.5) * cell, z = -size / 2 + (j + 0.5) * cell;
    if (walkable[j * gridN + i] && regionAt(cells, x, z) === nogo) { walkable[j * gridN + i] = 0; refused++; }
  }
  return refused;
}

/** The centres of the painted spawn-zone cells, row by row. */
export function spawnZonePoints(cells) {
  const out = [];
  for (let k = 0; k < cells.length; k++) if (cells[k] === REGION_CODES.spawn) out.push({ x: (k % REGION_N) - REGION_HALF + 0.5, z: Math.floor(k / REGION_N) - REGION_HALF + 0.5 });
  return out;
}

/** A generated house's collision: one box per block of its plan, turned with the house (keyed to follow it). */
export function houseBlocks(plan, x, z, yaw, y, parent) {
  const c = Math.cos(yaw), s = Math.sin(yaw), out = [];
  for (const b of plan.colliders) {
    const lx = (b.x0 + b.x1) / 2, lz = -(b.y0 + b.y1) / 2;
    out.push({ id: 'house-block', model: null, role: 'structureCollision', collisionOnly: true, collision: 'box', x: x + lx * c + lz * s, y, z: z - lx * s + lz * c, yaw,
      halfX: (b.x1 - b.x0) / 2, halfZ: (b.y1 - b.y0) / 2, height: b.h, radius: Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2, parent });
  }
  return out;
}

const PICKUP_PROPS = { health: 'healthSupply', ammo: 'ammoSupply', grenade: 'grenadeSupply' };
const cap = s => s[0].toUpperCase() + s.slice(1);
/** A padlock hangs on a locked gate's front, this far out from its centre line and this high. */
const LOCK_OUT = 0.58, LOCK_LIFT = 1.45;

/** The pack props a level's placed things are built from: what an exported game must carry for them. */
export function entityPropIds(edits) {
  const ids = new Set();
  for (const e of edits?.entities ?? []) {
    if (e.type === 'door') { ids.add(ENTITY_TYPES.door.model); if (!['hold', 'wired'].includes(e.props.lock)) ids.add(`lock${cap(e.props.lock)}`); }
    else if (e.type === 'lever') ids.add(ENTITY_TYPES.lever.model);
    else if (e.type === 'pickup') ids.add(PICKUP_PROPS[e.props.kind]);
    else if (e.type === 'key') ids.add(`key${cap(e.props.color)}`);
    else if (e.type === 'collectible') ids.add(ENTITY_TYPES.collectible.model);
    else if (e.type === 'prop') ids.add(e.props.prop);
  }
  return ids;
}

/**
 * Placed things as placements: the same records the generator emits, so the renderer, the collision system, the
 * supplies and the mission targets need nothing new to draw, block, give or open them. Each carries `key`
 * (`entity:<id>`) and `entity` (its id) so the editor and the level script can find it. Enemies and trigger zones
 * are not placements: the level script spawns and watches them.
 *
 * @param {object} ctx  { pack, seed, add(assetId, x, z, yaw) → the pushed placement, placements }
 */
export function entityPlacements(edits, { pack, seed, add, placements }) {
  const tag = (p, e) => Object.assign(p, { key: `entity:${e.id}`, entity: e.id });
  for (const e of edits.entities) {
    const scale = e.scale ?? 1;
    switch (e.type) {
      case 'door': {
        const p = tag(add(ENTITY_TYPES.door.model, e.x, e.z, e.yaw), e);
        if (e.props.lock === 'hold') { Object.assign(p, { interaction: 'override', stepId: null, holdTime: 2.2 }); break; }
        p.lock = e.props.lock;
        // A colour lock shows its colour: the padlock hangs on the gate's front (+Z in the model is its front).
        if (e.props.lock !== 'wired') {
          const lock = add(`lock${cap(e.props.lock)}`, e.x + Math.sin(e.yaw) * LOCK_OUT, e.z + Math.cos(e.yaw) * LOCK_OUT, e.yaw);
          Object.assign(lock, { key: `lock:${e.id}`, lockOf: e.id, lift: LOCK_LIFT });
        }
        break;
      }
      case 'lever': tag(add(ENTITY_TYPES.lever.model, e.x, e.z, e.yaw), e).lever = true; break;
      case 'pickup': tag(add(PICKUP_PROPS[e.props.kind], e.x, e.z, e.yaw), e); break;
      case 'key': Object.assign(tag(add(`key${cap(e.props.color)}`, e.x, e.z, e.yaw), e), { pickup: 'key', color: e.props.color }); break;
      case 'collectible': Object.assign(tag(add(ENTITY_TYPES.collectible.model, e.x, e.z, e.yaw), e), { pickup: 'collectible' }); break;
      case 'checkpoint': placements.push(tag({ id: 'respawn', model: null, role: 'respawn', collision: 'none', x: e.x, y: 0, z: e.z, yaw: e.yaw, radius: 1.6, halfX: 0, halfZ: 0, height: 0 }, e)); break;
      case 'prop': {
        const id = e.props.prop, variant = e.props.variant;
        if (id === 'house') {
          const families = Object.keys(pack.houses?.families ?? {});
          if (!families.length) throw Error('This world has no houses to place');
          const family = families.includes(variant) ? variant : families[0];
          const plan = generateHouse(pack.houses, { family, key: `${seed}|edit|${e.id}` });
          const [x0, x1, y0, y1, top] = plan.bounds, p = tag(add('house', e.x, e.z, e.yaw), e);
          Object.assign(p, { house: plan, collision: 'none', halfX: (x1 - x0) / 2, halfZ: (y1 - y0) / 2, radius: Math.hypot(x1 - x0, y1 - y0) / 2, height: top });
          placements.push(...houseBlocks(plan, e.x, e.z, e.yaw, 0, p.key));
        } else if (id === 'tree') {
          const species = Object.keys(pack.trees?.species ?? {});
          if (!species.length) throw Error('This world has no trees to place');
          const plan = generateTree(pack.trees, { species: species.includes(variant) ? variant : species[0], key: `${seed}|edit|${e.id}` });
          const p = tag(add('tree', e.x, e.z, e.yaw), e);
          Object.assign(p, { tree: plan, scale, crown: plan.crown * scale, lod: 0, collision: 'none', radius: 0, halfX: 0, halfZ: 0 });
          placements.push({ id: 'tree-trunk', model: null, role: 'structureCollision', collisionOnly: true, collision: 'circle', x: e.x, y: 0, z: e.z, yaw: 0,
            radius: Math.round(plan.trunk * scale * 1e4) / 1e4, halfX: plan.trunk * scale, halfZ: plan.trunk * scale, height: plan.clear * scale, parent: p.key });
        } else if (id === 'nature') {
          const parts = Object.keys(NATURE_PARTS);
          const p = tag(add('nature', e.x, e.z, e.yaw), e);
          Object.assign(p, { part: parts.includes(variant) ? variant : parts[0], scale, lod: 0, collision: 'none', radius: 0, halfX: 0, halfZ: 0 });
        } else {
          const p = tag(add(id, e.x, e.z, e.yaw), e);
          // A placed hay bale is cover, not a mission barricade: nothing asks the player to clear it.
          if (p.role === 'barricade' || p.role === 'gate') p.role = 'cover';
          Object.assign(p, { scale: (p.scale ?? 1) * scale, halfX: p.halfX * scale, halfZ: p.halfZ * scale, radius: p.radius * scale, height: (p.height ?? 1) * scale });
        }
        break;
      }
    }
  }
}
