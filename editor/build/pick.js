/**
 * What the pointer is over, in the level editor: the ground (a ray marched over the level's height field) and the
 * things standing on it, each a simple shape (an upright cylinder, a turned box for a zone) keyed by the ref the store
 * edits (editor/build/store.js). No meshes are ray-cast: a few hundred shapes cost less than one model would.
 *
 * `pickables(level, store, game)` lists them from the compiled level: placed things by their entity id, generated ones
 * by their key (houses and landmarks included: they can be removed), the start, the extraction marker, and the critters
 * (placed groups by id, generated ones as `enemy:<i>`). Collision-only records (a house's blocks, a trunk) are not
 * picked: their owner is.
 */
import { ENTITY_TYPES } from '../../src/world/level/entities.js';
import { DEFAULT_START } from '../../src/world/level/edits.js';

/** Labels for generated things, by the kind their key starts with. */
const KIND = {
  house: 'House', landmark: 'Landmark', fence: 'Fence', rocks: 'Rocks', stone: 'Stepping stone', sign: 'Signpost',
  bridge: 'Footbridge', basin: 'Pool', shore: 'Shore plant', orchard: 'Orchard tree', healthSupply: 'Honey jar',
  ammoSupply: 'Pebble pouch', grenadeSupply: 'Fizz-bomb', broadleaf: 'Broadleaf tree', willow: 'Willow', conifer: 'Conifer',
  blossom: 'Blossom tree', sapling: 'Sapling', bush: 'Bush', tuft: 'Grass tuft', flowers: 'Flowers', mushrooms: 'Mushrooms',
  reeds: 'Reeds', stump: 'Stump', flora: 'Plant',
};
export function generatedLabel(key, record = null) {
  if (key.startsWith('step:')) return record?.pickup === 'collectible' ? 'Honey drop' : 'Mission pad';
  if (key.startsWith('gate:')) return 'Village gate';
  const named = record?.label ?? (record?.id ? record.id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()) : null);
  if (key.startsWith('cover:')) return named ?? 'Cover';
  if (key.startsWith('dress:')) return named ?? 'Prop';
  if (key.startsWith('enemy:')) return `Critter ${Number(key.slice(6)) + 1}`;
  const kind = key.split('@')[0];
  return KIND[kind] ?? kind.replace(/[A-Z]/g, c => ` ${c.toLowerCase()}`).replace(/^./, c => c.toUpperCase());
}

/**
 * @returns {{ref: string, x: number, z: number, y: number, r: number, h: number, box?: {hw: number, hd: number, yaw: number}, label: string, kind: string, group: string, record?: object}[]}
 */
export function pickables(level, edits, game = null) {
  const out = [], ground = (x, z) => level.terrain?.heightAt?.(x, z) ?? 0;
  const byId = new Map(edits.entities.map(e => [e.id, e]));
  for (const p of level.placements) {
    if (p.collisionOnly || !p.key || p.parent || p.lockOf) continue;
    const entity = p.entity ? byId.get(p.entity) : null;
    const r = Math.max(0.45, p.house || p.landmark ? Math.max(p.halfX ?? 2, p.halfZ ?? 2) * 0.8 : p.tree ? Math.min(1.4, (p.crown ?? 2) * 0.5) : Math.max(p.halfX ?? 0, p.halfZ ?? 0, p.radius ?? 0) || 0.5);
    const h = p.house || p.landmark ? p.height ?? 6 : p.tree ? 4 : Math.max(0.5, (p.height ?? 1) + (p.lift ?? 0));
    const ref = entity ? entity.id : p.key;
    out.push({ ref, x: p.x, z: p.z, y: p.y ?? ground(p.x, p.z), r, h, label: entity ? entityLabel(entity) : generatedLabel(p.key, p), kind: entity ? entity.type : 'generated', group: entity ? ENTITY_TYPES[entity.type].group : p.village ? 'village' : 'mission', record: p });
  }
  for (const e of edits.entities) {
    if (e.type === 'trigger') out.push({ ref: e.id, x: e.x, z: e.z, y: ground(e.x, e.z), r: Math.hypot(e.props.w, e.props.d) / 2, h: 2.2, box: { hw: e.props.w / 2, hd: e.props.d / 2, yaw: e.yaw }, label: entityLabel(e), kind: 'trigger', group: 'logic' });
    if (e.type === 'enemy') out.push({ ref: e.id, x: e.x, z: e.z, y: ground(e.x, e.z), r: 0.9, h: 1.6, label: entityLabel(e), kind: 'enemy', group: 'enemies' });
  }
  for (const enemy of game?.enemies.enemies ?? []) {
    if (!Number.isInteger(enemy.generated)) continue;
    out.push({ ref: `enemy:${enemy.generated}`, x: enemy.position.x, z: enemy.position.z, y: enemy.position.y, r: Math.max(0.6, enemy.type.radius * 1.4), h: enemy.type.height ?? 1.4, label: generatedLabel(`enemy:${enemy.generated}`), kind: 'generated', group: 'enemies' });
  }
  const s = edits.start ?? DEFAULT_START;
  out.push({ ref: 'start', x: s.x, z: s.z, y: ground(s.x, s.z), r: 1, h: 2, label: 'Player start', kind: 'start', group: 'player' });
  const ex = level.extraction;
  if (ex?.key && level.blueprint.mission.some(m => m.objective === 'extract')) out.push({ ref: ex.key, x: ex.x, z: ex.z, y: ex.y ?? ground(ex.x, ex.z), r: 2.4, h: 0.6, label: 'Extraction', kind: 'generated', group: 'mission' });
  return out;
}

export function entityLabel(e) {
  switch (e.type) {
    case 'prop': return { barrel: 'Barrel', rocks: 'Rocks', fence: 'Fence', hayBarricade: 'Hay bale', house: 'House', tree: 'Tree', nature: 'Plant' }[e.props.prop] ?? 'Prop';
    case 'pickup': return { health: 'Honey jar', ammo: 'Pebble pouch', grenade: 'Fizz-bomb' }[e.props.kind];
    case 'key': return `${e.props.color[0].toUpperCase()}${e.props.color.slice(1)} key`;
    case 'enemy': return e.props.count > 1 ? `${e.props.count} × ${e.props.kind}` : e.props.kind[0].toUpperCase() + e.props.kind.slice(1);
    case 'door': return e.props.lock === 'hold' ? 'Door' : e.props.lock === 'wired' ? 'Wired door' : `${e.props.lock[0].toUpperCase()}${e.props.lock.slice(1)} door`;
    default: return ENTITY_TYPES[e.type].label;
  }
}

/** Nearest thing hit by a ray (origin o, unit direction d): an upright cylinder or a turned box per pickable. */
export function pickRay(items, o, d, filter = null) {
  let best = null, bestT = Infinity;
  for (const it of items) {
    if (filter && !filter(it)) continue;
    const t = it.box ? rayBox(o, d, it) : rayCylinder(o, d, it);
    if (t !== null && t < bestT) { bestT = t; best = it; }
  }
  return best ? { item: best, t: bestT } : null;
}

function rayCylinder(o, d, c) {
  const ox = o.x - c.x, oz = o.z - c.z, a = d.x * d.x + d.z * d.z, b = 2 * (ox * d.x + oz * d.z), k = ox * ox + oz * oz - c.r * c.r;
  let t = null;
  if (a > 1e-9) {
    const disc = b * b - 4 * a * k;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const cand of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
        const y = o.y + d.y * cand;
        if (cand > 0 && y >= c.y - 0.2 && y <= c.y + c.h) { t = cand; break; }
      }
    }
  }
  // The cap: a look straight down at a low thing hits its top.
  if (Math.abs(d.y) > 1e-6) {
    const tc = (c.y + c.h - o.y) / d.y;
    if (tc > 0 && (t === null || tc < t) && (o.x + d.x * tc - c.x) ** 2 + (o.z + d.z * tc - c.z) ** 2 <= c.r * c.r) t = tc;
  }
  return t;
}

function rayBox(o, d, it) {
  // Into the box's own frame (turned by yaw about Y), then a slab test on an axis-aligned box.
  const c = Math.cos(it.box.yaw), s = Math.sin(it.box.yaw);
  const lo = { x: (o.x - it.x) * c - (o.z - it.z) * s, y: o.y - it.y, z: (o.x - it.x) * s + (o.z - it.z) * c };
  const ld = { x: d.x * c - d.z * s, y: d.y, z: d.x * s + d.z * c };
  let t0 = 0, t1 = Infinity;
  for (const [p, v, min, max] of [[lo.x, ld.x, -it.box.hw, it.box.hw], [lo.y, ld.y, -0.2, it.h], [lo.z, ld.z, -it.box.hd, it.box.hd]]) {
    if (Math.abs(v) < 1e-9) { if (p < min || p > max) return null; continue; }
    let a = (min - p) / v, b = (max - p) / v;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0 > 0 ? t0 : null;
}

/** Where a ray meets the ground: marched in half-metre steps over the height field, then bisected. */
export function pickGround(o, d, heightAt, maxT = 400) {
  if (d.y >= -1e-4 && o.y > heightAt(o.x, o.z)) {
    // Looking level or up: only the far flat meadow could be hit; aim at the plane under the eye instead.
    return null;
  }
  let prev = 0;
  const above = t => o.y + d.y * t - heightAt(o.x + d.x * t, o.z + d.z * t);
  if (above(0) < 0) return { x: o.x, z: o.z, y: heightAt(o.x, o.z) };
  for (let t = 0.5; t <= maxT; t += Math.max(0.5, t * 0.02)) {
    if (above(t) < 0) {
      let a = prev, b = t;
      for (let i = 0; i < 20; i++) { const m = (a + b) / 2; if (above(m) < 0) b = m; else a = m; }
      const x = o.x + d.x * b, z = o.z + d.z * b;
      return { x, z, y: heightAt(x, z) };
    }
    prev = t;
  }
  return null;
}
