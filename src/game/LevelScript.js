import { Interactable } from '../interaction/Interactable.js';
import { INTERACTION } from '../config/gameplay.js';
import { channelRng } from '../kernel/seed.js';

/**
 * A HAND-BUILT LEVEL'S OWN RULES (world/level/entities.js, docs/EDITOR.md): the critters the editor placed, doors that
 * open by key, by lever or by zone, levers, trigger zones, keys, honey drops, checkpoints, and the run's lives.
 *
 * One system in the game's fixed step, after the player, the weapons, the enemies and the supplies: it reads where the
 * player is and what they hold, and changes only simulation state (blockers, spawns, counters). The session draws from
 * its fields (`doors[i].open`, `levers[i].pull`, `keys[i].taken`), never the other way round, so a replay plays the same.
 *
 * Wires fire once: a lever when pulled, a zone when first walked into. A wired door opens; a wired critter, which waited
 * unseen, appears. A colour door opens with a hold once the player carries a key of its colour.
 */

const ZONE_SPREAD = 1.3;            // metres between the critters of one placed group
const PICK_RADIUS = 1.25;           // how close the player's body gets to take a key or a honey drop
const CHECKPOINT_RADIUS = 1.9;

class LeverTarget extends Interactable {
  constructor(script, lever, index) {
    const p = lever.record;
    super({ id: `lever:${index}`, anchor: { x: p.x, y: p.y ?? 0, z: p.z }, height: 1.1, radius: 0.7, maxDistance: 3.2, blockerId: lever.blockerId });
    this.script = script; this.lever = lever; this.progress = 0;
  }
  canInteract(player) { return player.alive && !this.lever.pulled; }
  getPrompt() { return { key: 'E', label: 'Pull lever', progress: this.progress }; }
  interact(player, dt) {
    if (!this.canInteract(player)) return false;
    this.progress = Math.min(1, this.progress + dt / 0.5);
    if (this.progress >= 1) { this.script.pull(this.lever); return true; }
    return false;
  }
  idle(dt) { if (!this.lever.pulled) this.progress = Math.max(0, this.progress - INTERACTION.cancelDecay * dt); }
}

class LockTarget extends Interactable {
  constructor(script, door, index) {
    const p = door.record;
    super({ id: `lock:${index}`, anchor: { x: p.x, y: p.y ?? 0, z: p.z }, height: p.height ?? 2.5, radius: Math.max(0.9, p.halfX ?? 1), maxDistance: 3.6, blockerId: door.blockerId });
    this.script = script; this.door = door; this.progress = 0;
  }
  canInteract(player) { return player.alive && !this.door.opened; }
  getPrompt() {
    return this.script.held.has(this.door.lock)
      ? { key: 'E', label: `Unlock with the ${this.door.lock} key`, progress: this.progress }
      : { key: '', label: `Locked · find the ${this.door.lock} key`, progress: 0 };
  }
  interact(player, dt) {
    if (!this.canInteract(player) || !this.script.held.has(this.door.lock)) return false;
    this.progress = Math.min(1, this.progress + dt / 0.6);
    if (this.progress >= 1) { this.script.openDoor(this.door, 'key'); return true; }
    return false;
  }
  idle(dt) { if (!this.door.opened) this.progress = Math.max(0, this.progress - INTERACTION.cancelDecay * dt); }
}

export class LevelScript {
  /**
   * @param {import('./Game.js').Game} game
   * @param {{onEvent?: (name: string, data: object) => void}} [o]  what happened, for sound, feedback and portal hooks
   */
  constructor(game, { onEvent = null } = {}) {
    this.game = game; this.onEvent = onEvent;
    const level = game.level, byId = new Map((level.entities ?? []).map(e => [e.id, e]));
    this.wires = level.wires ?? [];
    this.doors = []; this.levers = []; this.keys = []; this.drops = []; this.checkpoints = [];
    for (const [i, p] of (level.placements ?? []).entries()) {
      const e = p.entity ? byId.get(p.entity) : null;
      // A collect step's drops are generated (keyed to their step, no entity) and count like placed ones.
      if (!e) { if (p.pickup === 'collectible') this.drops.push({ entity: null, record: p, taken: false }); continue; }
      const blockerId = `prop:${i}:${p.id}`;
      if (e.type === 'door' && p.lock) this.doors.push({ entity: e, record: p, blockerId, lock: p.lock, open: 0, opened: false, lockRecord: level.placements.find(q => q.lockOf === e.id) ?? null });
      else if (e.type === 'lever') this.levers.push({ entity: e, record: p, blockerId, pull: 0, pulled: false });
      else if (p.pickup === 'key') this.keys.push({ entity: e, record: p, color: p.color, taken: false });
      else if (p.pickup === 'collectible') this.drops.push({ entity: e, record: p, taken: false });
      else if (e.type === 'checkpoint') this.checkpoints.push({ entity: e, record: p, reached: false });
    }
    this.zones = (level.entities ?? []).filter(e => e.type === 'trigger').map(e => ({ entity: e, fired: false }));
    this.groups = (level.entities ?? []).filter(e => e.type === 'enemy').map(e => ({ entity: e, sleeping: this.wires.some(w => w.to === e.id), spawned: [] }));
    const interactions = game.interactions;
    this.targets = [...this.levers.map((l, i) => interactions.register(new LeverTarget(this, l, i))),
      ...this.doors.filter(d => d.lock !== 'wired').map((d, i) => interactions.register(new LockTarget(this, d, i)))];
    this.maxLives = Math.max(1, level.project?.settings?.lives ?? 1);
    this.reset();
  }

  /** Back to the level as built: every door shut, every key and drop in place, the awake critters out, full lives. */
  reset() {
    this.held = new Set(); this.collected = 0; this.checkpoint = null; this.lives = this.maxLives; this.respawns = 0;
    for (const d of this.doors) { d.open = 0; d.opened = false; this.game.collision.setBlockerActive(d.blockerId, true); }
    for (const l of this.levers) { l.pull = 0; l.pulled = false; }
    for (const t of this.targets) t.progress = 0;
    for (const k of this.keys) k.taken = false;
    for (const d of this.drops) d.taken = false;
    for (const c of this.checkpoints) c.reached = false;
    for (const z of this.zones) z.fired = false;
    for (const g of this.groups) { g.spawned = []; if (!g.sleeping) this.wake(g); }
  }

  get total() { return this.drops.length; }

  /** Spawn a placed group round its spot. The enemy system refuses a spot that is blocked, unreachable or taken. */
  wake(group) {
    const e = group.entity, n = e.props.count;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + e.yaw, r = n > 1 ? ZONE_SPREAD : 0;
      const position = { x: e.x + Math.sin(a) * r, z: e.z + Math.cos(a) * r };
      const enemy = this.game.enemies.spawn(e.props.kind, { position, yaw: e.yaw, authored: true, alerted: e.props.behavior === 'hunt' || group.sleeping })
        ?? this.game.enemies.spawn(e.props.kind, { position: { x: e.x, z: e.z }, yaw: e.yaw, authored: true, alerted: e.props.behavior === 'hunt' || group.sleeping });
      if (enemy) group.spawned.push(enemy.id);
    }
  }

  /**
   * The generator's own critters (`enemyCount` of the connected roster), each from a stream of its own so that moving or
   * removing one in the editor (`enemy:<i>` overrides) never shifts another; painted spawn zones, when there are any,
   * are where they stand. The host calls this after a build and after a restart, as it always spawned them.
   */
  spawnGenerated(project) {
    const level = this.game.level, roster = level.blueprint?.pools.enemies ?? [], out = [];
    if (!roster.length) return out;
    const overrides = level.enemyOverrides ?? {}, zones = level.spawnZones ?? [], alerted = project.behavior === 'hunt';
    for (let i = 0; i < project.enemyCount; i++) {
      const type = roster[i % roster.length], o = overrides[`enemy:${i}`];
      if (o?.removed) { out.push(null); continue; }
      let enemy = o ? this.game.enemies.spawn(type, { position: { x: o.x, z: o.z }, yaw: o.yaw ?? 0, authored: true, alerted }) : null;
      const rng = channelRng(project.seed, `encounters:${i}`);
      for (let attempt = 0; attempt < 24 && !enemy; attempt++) {
        const position = zones.length ? zones[Math.floor(rng() * zones.length)]
          : { x: i === 0 && !attempt ? 4 : (rng() - 0.5) * 28, z: i === 0 && !attempt ? 14 : -22 + rng() * 32 };
        enemy = this.game.enemies.spawn(type, { position, yaw: 0, alerted });
      }
      enemy ??= this.game.enemies.spawn(type, { alerted });
      if (!enemy) throw new Error('Could not place all requested enemies. Change the seed or reduce cover.');
      enemy.generated = i; out.push(enemy);
    }
    return out;
  }

  /** Everything wired from `sourceId` fires: doors open, sleeping critters appear. */
  fire(sourceId) {
    for (const w of this.wires) {
      if (w.from !== sourceId) continue;
      const door = this.doors.find(d => d.entity.id === w.to);
      if (door) this.openDoor(door, 'wire');
      const group = this.groups.find(g => g.entity.id === w.to);
      if (group && group.sleeping && !group.spawned.length) { this.wake(group); this.emit('wave', { id: group.entity.id, count: group.spawned.length }); }
    }
  }

  pull(lever) {
    if (lever.pulled) return;
    lever.pulled = true; this.emit('lever', { id: lever.entity.id }); this.fire(lever.entity.id);
  }

  openDoor(door, by) {
    if (door.opened) return;
    door.opened = true; this.game.collision.setBlockerActive(door.blockerId, false);
    if (by === 'key') this.held.delete(door.lock);
    this.emit('door', { id: door.entity.id, by });
  }

  fixedUpdate(dt) {
    const p = this.game.player, pos = p.position;
    if (!p.alive) return;
    for (const k of this.keys) {
      if (k.taken || Math.hypot(pos.x - k.record.x, pos.z - k.record.z) > PICK_RADIUS) continue;
      k.taken = true; this.held.add(k.color); this.emit('key', { color: k.color });
    }
    for (const d of this.drops) {
      if (d.taken || Math.hypot(pos.x - d.record.x, pos.z - d.record.z) > PICK_RADIUS) continue;
      d.taken = true; this.collected++; this.emit('collect', { collected: this.collected, total: this.total });
    }
    for (const c of this.checkpoints) {
      if (this.checkpoint === c || Math.hypot(pos.x - c.record.x, pos.z - c.record.z) > CHECKPOINT_RADIUS) continue;
      this.checkpoint = c; c.reached = true; this.emit('checkpoint', { id: c.entity.id });
    }
    for (const z of this.zones) {
      if (z.fired) continue;
      const e = z.entity, dx = pos.x - e.x, dz = pos.z - e.z, c = Math.cos(e.yaw), s = Math.sin(e.yaw);
      if (Math.abs(dx * c - dz * s) <= e.props.w / 2 && Math.abs(dx * s + dz * c) <= e.props.d / 2) { z.fired = true; this.emit('zone', { id: e.id }); this.fire(e.id); }
    }
    // Presentation state advanced on the fixed step, so a replay swings the same doors.
    for (const d of this.doors) d.open = d.opened ? Math.min(1, d.open + dt * 1.2) : 0;
    for (const l of this.levers) l.pull = l.pulled ? Math.min(1, l.pull + dt * 4) : 0;
  }

  /**
   * The player fell: with a life to spare, stand them up at the last checkpoint (or the start) and carry on. Returns
   * false when the run is over.
   */
  respawn() {
    if (this.lives <= 1) { this.lives = 0; return false; }
    this.lives--; this.respawns++;
    const at = this.checkpoint?.record, spawn = this.game.level.spawn;
    this.game.player.reset(at ? { position: { x: at.x, z: at.z }, yaw: at.yaw ?? spawn.yaw, pitch: 0 } : spawn);
    this.emit('respawn', { lives: this.lives });
    return true;
  }

  /** A rewarded continue: the lives back, at the last checkpoint (portals call it after a rewarded ad). */
  continueRun() { this.lives = this.maxLives + 1; return this.respawn(); }

  get hudState() {
    return { keys: [...this.held], collected: this.collected, total: this.total, lives: this.lives, maxLives: this.maxLives,
      checkpoint: this.checkpoint?.entity.id ?? null, doorsOpen: this.doors.filter(d => d.opened).length };
  }

  emit(name, data) { this.onEvent?.(name, data); }

  dispose() { for (const t of this.targets) this.game.interactions.unregister(t.id); }
}
