import { enemyTypesForProject, compileShooterProject } from '../world/shooterProject.js';
import { PerspectiveCamera } from 'three/webgpu';
import { FIXED_STEP, MAX_SUBSTEPS } from '../config/gameplay.js';
import { GameState, State } from '../sim/GameState.js';
import { PlayerController } from '../sim/PlayerController.js';
import { CollisionSystem } from '../sim/CollisionSystem.js';
import { registerPlacementBlockers } from '../sim/placementBlockers.js';
import { InteractionSystem } from '../interaction/InteractionSystem.js';
import { seedChannel } from '../kernel/seed.js';
import { compileLevel, levelFromBaked } from '../world/compileLevel.js';
import { EnemySystem } from './EnemySystem.js';
import { SupplySystem } from './SupplySystem.js';
import { BlueprintObjectives } from './BlueprintObjectives.js';
import { ObjectiveSystem } from './ObjectiveSystem.js';
import { LevelScript } from './LevelScript.js';

/** A playtest's trace: the player's route, a point every quarter second, and where they fell (docs/EDITOR.md). */
const TRACE_EVERY = 15, TRACE_LIMIT = 2400;

/**
 * Canonical simulation owner for browser, baked builds and headless replay.
 * No DOM, rendering loop, asset loading or storage side effects. Hosts supply those.
 * `step(input)` consumes one replay tick; `advance(seconds, inputAtTick)` serves a renderer.
 */
const GAME_SYSTEM_KEYS = ['weapons', 'grenades', 'rockets', 'objectives'];

export class Game {
  static fromSpec(spec, options = {}) {
    return new Game({ ...options, level: compileLevel(spec, { pack: options.pack }) });
  }

  static fromBaked(baked, options = {}) {
    return new Game({ ...options, level: levelFromBaked(baked) });
  }

  /**
   * A project played on its seed's Visigenesis world (world/kernelGround.js): compiled with `ground: 'world'` whatever
   * the project says, so the level stands on a site of the world the seed is everywhere else in the repository, bent
   * by the kernel to meet the mission. A world with no site the mission is met on compiles the village's own ground,
   * and `game.level.ground` says which it got and why. `options.pack` is the resolved pack, as for fromSpec.
   */
  static fromWorld(project, options = {}) {
    if (!options.pack) throw new Error('Load and resolve the project\'s pack before playing it on its world');
    return new Game({ ...options, enemyTypes: options.enemyTypes ?? enemyTypesForProject(project),
      level: compileShooterProject({ ...project, ground: 'world' }, options.pack) });
  }

  constructor({ level, camera = new PerspectiveCamera(75, 1, 0.1, 4000), tier = 'balanced',
    createEnemyVisual = null, createSystems = null, enemyTypes, onStateChange = null, onLevelEvent = null } = {}) {
    if (!level?.grid || !level.terrain || !level.spawn) throw new Error('Game requires a compiled level');
    this.level = level;
    this.camera = camera;
    this.terrain = level.terrain;
    this.collision = new CollisionSystem(level.grid);
    this.collision.terrain = this.terrain;
    this.player = new PlayerController(camera, this.collision, this.terrain);
    this.interactions = new InteractionSystem(this.collision);
    this.tick = 0;
    this.accumulator = 0;
    this.score = 0;
    this.kills = 0;
    this.disposed = false;
    this.state = new GameState((next, previous, payload) => {
      this.accumulator = 0;
      if (next !== State.PLAYING) {
        this.weapons?.cancelPending?.();
        this.weapons?.cancelTrigger?.();
        this.interactions.target?.cancel(this.player);
        this.interactions.reset();
      }
      onStateChange?.(next, previous, payload);
    });
    this.state.set(State.LOADING);
    this._registerPlacements();
    this.player.reset(level.spawn);
    this.enemies = new EnemySystem({ collision: this.collision, terrain: this.terrain,
      player: this.player, seed: seedChannel(level.spec?.world.seed ?? '1', 'enemies'),
      tier, types: enemyTypes??(level.project?enemyTypesForProject(level.project):undefined), createVisual: createEnemyVisual,
      onDeath: e => { this.score += e.type.scoreValue; this.kills++; } });
    // Factories receive the actual runtime dependencies. They can construct the existing
    // WeaponController/GrenadeSystem/RocketSystem after the host has loaded assets.
    const systems = createSystems?.(this) ?? {};
    for (const key of ['weapons', 'grenades', 'rockets', 'objectives']) this[key] = systems[key] ?? null;
    if (!Object.hasOwn(systems, 'objectives')) this.objectives = level.blueprint ? new BlueprintObjectives(this) : new ObjectiveSystem(this);
    /**
     * THE SYSTEMS BAG. A genre may hand the game systems this class has never heard of
     * (exploration's prop interactions) under any other key. They are stepped after the shooter's
     * fixed set, in the order the factory listed them, receive the raw input and the game,
     * and take part in restart, visuals, the HUD (under their own key) and disposal. This
     * is the whole seam a genre needs on the simulation side.
     */
    this.extraSystems = Object.entries(systems).filter(([key, value]) => value && !GAME_SYSTEM_KEYS.includes(key));
    if (this.weapons) {
      if (this.rockets && this.weapons.effects) this.weapons.effects.rockets = this.rockets;
      this.weapons.setEnemyProvider(() => this.enemies.enemies);
      this.weapons.onEnemyHit = (enemy, damage, head, impulse, direction, stagger) =>
        this.enemies.damage(enemy, damage, { direction, stagger });
      this.weapons.onWorldImpact = (x,y,z,surface,id,damage) => {this.objectives?.damage?.(id,damage);};
      this.player.setRecoilSource(this.weapons.viewmodel?.recoil ?? null);
    }
    for (const system of [this.grenades, this.rockets]) {
      if (system) system.onExplode = (position, radius, damage) => {this.enemies.explode(position,radius,damage);this.objectives?.explode?.(position,radius,damage);};
    }
    this.supplies=new SupplySystem(this);
    // The level's own rules (placed critters, keys, doors, levers, zones, drops, checkpoints, lives): every level has
    // one, so a generated mission plays exactly as before with nothing in it.
    this.script = new LevelScript(this, { onEvent: onLevelEvent });
    this.trace = { points: [], deaths: [] };
    this.systems = new Map([['player', this.player], ['interactions', this.interactions],
      ['weapons', this.weapons], ['enemies', this.enemies], ['grenades', this.grenades],
      ['rockets', this.rockets], ['objectives', this.objectives], ['supplies',this.supplies], ['script', this.script], ...this.extraSystems].filter(([, value]) => value));
    this.state.set(State.TITLE);
  }

  _registerPlacements() { registerPlacementBlockers(this.collision, this.level.placements, this.terrain); }

  get time() { return this.tick * FIXED_STEP; }
  get alpha() { return this.accumulator / FIXED_STEP; }
  get hudState() {
    const hud = { state: this.state.current, time: this.time, health: this.player.health,
      enemiesAlive: this.enemies.aliveCount, score: this.score, kills: this.kills,
      weapon: this.weapons?.hudState ?? null, grenades: this.grenades?.count ?? 0,
      interaction: this.interactions.prompt, objectives: this.objectives?.hudState ?? null, level: this.script.hudState };
    for (const [key, system] of this.extraSystems) if (system.hudState !== undefined) hud[key] = system.hudState;
    return hud;
  }

  start() { return !this.disposed && this.state.current === State.TITLE && this.state.set(State.PLAYING); }
  pause() { return !this.disposed && this.state.isPlaying && this.state.set(State.PAUSED); }
  resume() { return !this.disposed && this.state.current === State.PAUSED && this.state.set(State.PLAYING); }
  /**
   * A rewarded continue (a portal's ad, watched): after the last life is lost, the run carries on from the last
   * checkpoint with its lives back, everything else as it was.
   */
  continueRun() {
    if (this.disposed || this.state.current !== State.PLAYER_DEAD) return false;
    this.script.continueRun();
    return this.state.set(State.PLAYING);
  }

  /** @param {{spawn?: object}} [o]  a spawn of its own (a playtest from a chosen spot); the level's start otherwise */
  restart({ spawn = null } = {}) {
    if (this.disposed) return false;
    if (this.state.current !== State.TITLE) this.state.set(State.TITLE);
    this.enemies.reset();
    this.player.reset(spawn ?? this.level.spawn);
    this.interactions.reset();
    this.weapons?.resetAll?.();
    this.grenades?.reset?.();
    this.rockets?.reset?.();
    this.objectives?.reset?.();
    for (const [, system] of this.extraSystems) system.reset?.();
    this.supplies.reset();
    this.script.reset();
    this.trace = { points: [], deaths: [] };
    this.tick = this.score = this.kills = this.accumulator = 0;
    return this.start();
  }

  /** Explicit ordered tick, independent of render cadence. Look deltas are per tick. */
  step(input = {}) {
    if (this.disposed || !this.state.isPlaying) return false;
    const dt = FIXED_STEP, p = this.player, w = this.weapons;
    const aimScale=w?.sensitivityScale??1;
    p.addLook((input.look?.x ?? 0)*aimScale, (input.look?.y ?? 0)*aimScale);
    p.wantSprint = !!input.sprint;
    p.wantCrouch = !!input.crouch;
    w?.setAds?.(!!input.ads);
    if (input.fire) { if (!w?.triggerHeld) w?.pressTrigger?.(); }
    else w?.releaseTrigger?.();
    if (input.weapon) w?.equip?.(input.weapon);
    if (input.reload) w?.reload?.();
    if (input.inspect) w?.inspect?.();
    if (input.grenade) this.grenades?.throwGrenade();
    p.sprintBlocked = !!w?.blocksSprint || !!input.interact;
    p.fixedUpdate(dt, input.move ?? { x: 0, y: 0 }, !!input.jump);
    const eye = p.eyePosition, dir = p.aimDirection();
    this.interactions.fixedUpdate(dt, { eyeX: eye.x, eyeY: eye.y, eyeZ: eye.z,
      dirX: dir.x, dirY: dir.y, dirZ: dir.z, held: !!input.interact, player: p });
    w?.setInteracting?.(this.interactions.holding);
    w?.setContext?.({ speedFraction: p.speedFraction, grounded: p.grounded,
      crouchBlend: p.crouchBlend, sprinting: p.sprinting });
    const shots = w?.shotsFired;
    w?.fixedUpdate(dt);
    if (w && w.shotsFired > shots) this.enemies.hear(p.position);
    this.enemies.fixedUpdate(dt);
    this.grenades?.fixedUpdate(dt);
    this.rockets?.fixedUpdate(dt, this.enemies.enemies);
    for (const [, system] of this.extraSystems) system.fixedUpdate?.(dt, input, this);
    this.supplies.fixedUpdate();
    this.script.fixedUpdate(dt);
    this.tick++;
    if (this.tick % TRACE_EVERY === 0 && this.trace.points.length < TRACE_LIMIT) this.trace.points.push([+p.position.x.toFixed(2), +p.position.z.toFixed(2), this.tick]);
    this.state.update(dt);
    if (!p.alive) {
      // A fall is marked where it happened, whether a life carries the run on or it ends here.
      this.trace.deaths.push([+p.position.x.toFixed(2), +p.position.z.toFixed(2), this.tick]);
      if (!this.script.respawn()) this.state.set(State.PLAYER_DEAD);
    } else {
      this.objectives?.fixedUpdate?.(dt, this);
      if (this.objectives?.complete) this.state.set(State.VICTORY);
    }
    return true;
  }

  advance(seconds, input = {}) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Invalid frame delta');
    if (this.disposed || !this.state.isPlaying) return 0;
    // Drop excess wall time before stepping; replay uses step() and drops no ticks.
    this.accumulator = Math.min(this.accumulator + seconds, FIXED_STEP * MAX_SUBSTEPS);
    let steps = 0;
    while (this.accumulator + 1e-12 >= FIXED_STEP && steps < MAX_SUBSTEPS && this.state.isPlaying) {
      this.accumulator = Math.max(0, this.accumulator - FIXED_STEP);
      this.step(typeof input === 'function' ? input(this.tick) : input);
      steps++;
    }
    return steps;
  }

  updateVisuals(seconds, intent = {}) {
    if (this.disposed) return;
    const dt = this.state.isPlaying ? seconds : 0;
    this.player.updateCamera(dt, this.state.isPlaying ? this.alpha : 1);
    this.enemies.updateVisuals(dt, this.state.isPlaying ? this.alpha : 1);
    this.grenades?.updateVisuals?.(dt);
    if (this.grenades) this.weapons?.setThrowPose?.(this.grenades.throwPose);
    this.weapons?.updateVisuals?.(dt, intent);
    for (const [, system] of this.extraSystems) system.updateVisuals?.(dt, this.state.isPlaying ? this.alpha : 1);
  }

  dispose() {
    if (this.disposed) return;
    this.pause();
    for (const system of [...this.systems.values()].reverse()) system.dispose?.();
    this.interactions.items.clear();
    this.disposed = true;
  }
}
