// The genre seam, end to end under bare node with vendored three: the registry and the
// project contract (including retired perspectives and genres), the genre-aware
// blueprint compiler, Game's systems bag and an exploration mission won by hands alone;
// then the three genres that show the hero: the follow and overhead inputs, the action
// adventure's strike, the collect-a-thon's stomp and honey, and the arena's survive clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GENRES, GENRE_IDS, genreOf, CAMERAS } from '../../src/genres/registry.js';
import { rulesFor } from '../../src/genres/rules.js';
import { OBJECTIVE_KINDS, compileBlueprint } from '../../src/world/blueprint.js';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { quickMission, worldMission, MISSION_WORLDS } from '../../src/world/missionCard.js';
import { parseProjectText, packageProject, PROJECT_FILE_VERSION } from '../../src/world/projectSchema.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { Game } from '../../src/game/Game.js';
import { State } from '../../src/sim/GameState.js';
import { FIXED_STEP, PLAYER } from '../../src/config/gameplay.js';
import { followInput, TURN_PER_TICK } from '../../src/genres/hero/thirdPerson.js';
import { arenaRules } from '../../src/genres/arena/rules.js';
import { yawToward, yawDelta, worldMoveToLocal, cameraRelative } from '../../src/genres/hero/view.js';
import { checkLevel } from '../../src/world/level/checks.js';
import { normalizeEdits } from '../../src/world/level/edits.js';

// --- registry ---
for (const id of GENRE_IDS) {
  const g = GENRES[id];
  assert.equal(g.id, id);
  assert.ok(g.cameras.every(c => CAMERAS.includes(c)), `${id} cameras are known perspectives`);
  assert.ok(g.objectives.every(o => OBJECTIVE_KINDS[o]), `${id} objectives are known kinds`);
  assert.ok(!g.weapons || g.requiredPools.includes('weapons'), `${id}: weapons need a weapon pool`);
  assert.equal(typeof rulesFor(id).createSystems, 'function');
  assert.equal(rulesFor(id).view(), g.cameras[0], `${id} plays from its own perspective`);
  if (g.cameras[0] !== 'first') assert.equal(typeof rulesFor(id).updateCamera, 'function', `${id} places its own camera`);
  const BUTTONS = ['weapon', 'grenade', 'reload', 'use', 'aim', 'jump', 'fire', 'aimPad'];
  assert.ok(g.controls.keys.length && g.controls.touch.length && g.controls.pad && g.controls.buttons.every(b => BUTTONS.includes(b)), `${id} says how it is played`);
  assert.ok(!g.controls.buttons.some(b => ['weapon', 'grenade', 'reload', 'aim', 'aimPad'].includes(b)) || g.weapons, `${id}: weapon buttons only where there are weapons`);
}
assert.deepEqual(CAMERAS, ['first', 'follow', 'overhead']);
assert.deepEqual(GENRE_IDS.map(id => rulesFor(id).view()), ['first', 'first', 'follow', 'overhead', 'follow']);
assert.deepEqual(['action', 'arena', 'collect'].map(id => rulesFor(id).pointerLock), [true, false, true], 'the arena aims with a free pointer');
assert.throws(() => rulesFor('platformer'), /No runtime rules/);

// --- contract: format 3 and later carry the genre; older files migrate to the shooter ---
assert.ok(PROJECT_FILE_VERSION >= 3, 'the genre field arrived in format 3');
const v2 = parseProjectText(JSON.stringify({ kind: 'visigames.project', version: 2, theme: 'arcade' }), { requireEnvelope: true });
assert.equal(v2.project.genre, 'shooter'); assert.equal(v2.migrated, true);
assert.equal(resolveProject({}).genre, 'shooter');
assert.throws(() => resolveProject({ genre: 'platformer' }), /Unsupported genre: platformer/);
assert.equal(resolveProject({ genre: 'exploration', camera: 'third' }).camera, 'first', 'a retired perspective opens first person');
// Retired genres, perspectives and mission profiles open as what ships rather than failing.
for (const genre of ['adventure', 'tactical']) {
  const legacy = resolveProject({ genre, camera: genre === 'tactical' ? 'tactical' : 'third', missionProfile: genre === 'tactical' ? 'uplink-v1' : 'relic-v1' });
  assert.deepEqual([legacy.genre, legacy.camera, legacy.theme, legacy.missionProfile], ['shooter', 'first', 'arcade', null]);
}
assert.equal(resolveProject({ missionProfile: 'district-v1' }).missionProfile, null);
assert.equal(resolveProject({ genre: 'shooter', camera: 'overhead' }).camera, 'first', 'a genre plays from its own perspectives');
assert.equal(resolveProject({ genre: 'arena' }).camera, 'overhead');
assert.throws(() => resolveProject({ genre: 'shooter', camera: 'orbit' }), /Unsupported camera/);
assert.equal(packageProject(quickMission('arcade', 'SEED-0001-AAAA', 'exploration')).genre, 'exploration');

// --- compiler: pools and objectives per genre ---
const exploration = quickMission('arcade', 'K7QN-3F2A-9XBD', 'exploration');
assert.equal(exploration.blueprint.nodes.filter(n => n.kind === 'objective').map(n => n.objective).join(','), 'activate,reach,extract');
const noWeapons = { ...exploration.blueprint, nodes: exploration.blueprint.nodes.filter(n => n.kind !== 'weapons'), edges: exploration.blueprint.edges.filter(e => e.from !== 'weapons') };
assert.ok(compileBlueprint(noWeapons, CATALOG.arcade, { genre: GENRES.exploration }).mission.length === 3, 'exploration compiles with no weapon pool');
assert.throws(() => compileBlueprint(noWeapons, CATALOG.arcade), /Connect at least one weapon/, 'the shooter still requires one');
const withWaves = { ...exploration.blueprint, nodes: exploration.blueprint.nodes.map(n => n.id === 'checkpoint' ? { ...n, objective: 'waves', count: 2 } : n) };
assert.throws(() => compileBlueprint(withWaves, CATALOG.arcade, { genre: GENRES.exploration }), /Survive waves is not a Exploration step/);
assert.equal(resolveProject({ ...exploration, camera: 'tactical' }).camera, 'first', 'the retired overhead perspective opens first person');

// --- an exploration mission, won by hands alone ---
{
  const pack = resolvePack(JSON.parse(fs.readFileSync('packs/arcade/pack.json', 'utf8')), CATALOG.arcade.measurements);
  const level = compileShooterProject(exploration, pack);
  assert.equal(level.project.genre, 'exploration');
  const game = new Game({ level, createSystems: (g) => rulesFor('exploration').createSystems(null, g, {}) });
  assert.equal(game.weapons, null); assert.equal(game.grenades, null); assert.deepEqual(game.extraSystems, []);
  game.start();
  const station = level.placements.find(p => p.interaction === 'activate');
  game.player.position.set(station.x, 0, station.z + 1.2); game.player.prevPosition.copy(game.player.position);
  game.player.yaw = Math.atan2(-(station.x - game.player.position.x), -(station.z - game.player.position.z));
  for (let i = 0; i < 200 && game.objectives.hudState.completed === 0; i++) game.step({ interact: true, fire: true });
  assert.equal(game.objectives.hudState.completed, 1, 'the station is activated without a weapon');
  const checkpoint = level.placements.find(p => p.stepId === 'checkpoint');
  game.player.position.set(checkpoint.x, 0, checkpoint.z); game.step();
  assert.equal(game.objectives.hudState.completed, 2, 'the checkpoint is reached');
  game.player.position.set(level.spawn.position.x, 0, level.spawn.position.z);
  for (let i = 0; i < 200 && game.state.current !== State.VICTORY; i++) game.step();
  assert.equal(game.state.current, State.VICTORY);
  game.dispose();
}

// --- the shooter is untouched: same systems, same objectives ---
assert.equal(genreOf(resolveProject({})).weapons, true);
assert.equal(quickMission('arcade').missionProfile, null, 'the shooter preset is the plain objective graph');
assert.equal(quickMission('arcade', 'K7QN-3F2A-9XBD', 'exploration').missionProfile, 'survey-v1');
// Play's missions are named by their genre, as the level editor's templates are; the world is where they take place.
for (const id of GENRE_IDS) for (const world of Object.keys(MISSION_WORLDS)) assert.equal(worldMission(world, 'K7QN-3F2A-9XBD', id).name, GENRES[id].label, `${id} in ${world}`);

// --- the hero's genres: presets, missions and weapons ---
for (const [id, profile, steps] of [['action', 'trail-v1', 'activate,eliminate,extract'], ['arena', 'siege-v1', 'waves,survive,extract'], ['collect', 'harvest-v1', 'collect,reach,extract']]) {
  const p = quickMission('arcade', 'K7QN-3F2A-9XBD', id);
  assert.equal(p.missionProfile, profile); assert.equal(p.camera, GENRES[id].cameras[0]);
  assert.equal(p.blueprint.nodes.filter(n => n.kind === 'objective').map(n => n.objective).join(','), steps);
  assert.equal(p.blueprint.nodes.find(n => n.kind === 'weapons').items.length > 0, GENRES[id].weapons, `${id} carries weapons only if it fires them`);
}
assert.throws(() => compileBlueprint({ ...exploration.blueprint, nodes: exploration.blueprint.nodes.map(n => n.id === 'checkpoint' ? { ...n, objective: 'collect', count: 5 } : n) }, CATALOG.arcade, { genre: GENRES.exploration }), /Collect honey is not a Exploration step/);

// --- the follow input: the hero turns toward where the stick points on screen, at a bounded rate ---
{
  const hero = { yaw: Math.PI / 2, pitch: 0, alive: true };
  const session = { game: { player: hero } };
  const input = followInput(session, { move: { x: 0, y: 1 }, look: { x: 0, y: 0 }, fire: true }, { attack: true });
  assert.ok(Math.abs(input.look.x - TURN_PER_TICK) < 1e-9, 'a sharp turn is capped per tick');
  assert.ok(Math.abs(input.move.y - 0.2) < 1e-9 && input.move.x === 0, 'and the hero slows through it rather than arcing wide');
  assert.deepEqual([input.attack, input.fire, input.ads, input.weapon], [true, false, false, null], 'the fire button strikes; no gun is ever drawn');
  hero.yaw = 0;
  const ahead = followInput(session, { move: { x: 0, y: 1 }, look: { x: 0, y: 0 } });
  assert.equal(ahead.move.y, 1); assert.ok(Math.abs(ahead.look.x) < 1e-9, 'straight ahead needs no turn');
  const orbit = followInput(session, { move: { x: 0, y: 0 }, look: { x: 0.1, y: 0 } });
  assert.ok(Math.abs(session.follow.yaw + 0.1) < 1e-9 && Math.abs(orbit.look.x) < 1e-9, 'the look input orbits the camera instead of turning the hero');
  assert.equal(followInput(session, { move: { x: 0, y: 0 }, fire: true }).attack, false, 'the collect-a-thon has no strike');
  const d = cameraRelative({ x: 1, y: 0 }, 0); assert.deepEqual([Math.round(d.x) + 0, Math.round(d.z) + 0], [1, 0], 'right on the stick is right on screen');
}
// --- the overhead input: twin stick, the move read north-up, the aim toward the right stick or the pointer ---
{
  const hero = { yaw: 0, pitch: 0, eyeHeight: 1.6, position: { x: 0, y: 0, z: 0 } };
  const session = { game: { player: hero, terrain: { heightAt: () => 0 } }, camera: null, pointer: null };
  const input = arenaRules.input(session, { move: { x: 0, y: 1 }, aim: { x: 1, y: 0 }, aimFire: true, fire: false });
  assert.ok(Math.abs(input.look.x - Math.PI / 2) < 1e-9, 'the right stick east turns the hero east');
  assert.ok(Math.abs(yawDelta(hero.yaw - input.look.x, yawToward({ x: 0, z: 0 }, { x: 5, z: 0 }))) < 1e-9);
  assert.equal(input.fire, true, 'the aim pad fires while held');
  assert.deepEqual([Math.round(input.move.x) + 0, Math.round(input.move.y) + 0], [0, 1], 'north on the keys is north on screen');
  const turned = worldMoveToLocal({ x: 0, y: 1 }, -Math.PI / 2);
  assert.deepEqual([Math.round(turned.x) + 0, Math.round(turned.y) + 0], [-1, 0], 'facing east, north is to the left');
  assert.equal(arenaRules.input(session, { move: { x: 0, y: 0 }, aim: { x: 0.1, y: 0 }, aimFire: true }).fire, false, 'a resting stick neither aims nor fires');
}

const pack = resolvePack(JSON.parse(fs.readFileSync('packs/arcade/pack.json', 'utf8')), CATALOG.arcade.measurements);
const put = (g, x, z, yaw = 0) => g.player.reset({ position: { x, z }, yaw, pitch: 0 });
// --- the action adventure: the staff lands its blow on the swing, in front, within reach ---
{
  const level = compileShooterProject(quickMission('arcade', 'K7QN-3F2A-9XBD', 'action'), pack);
  const game = new Game({ level, createSystems: g => rulesFor('action').createSystems({}, g, {}) });
  assert.equal(game.weapons, null); game.start();
  const melee = game.extraSystems.find(([k]) => k === 'melee')[1];
  const at = level.spawn.position;
  const critter = game.enemies.spawn(level.blueprint.pools.enemies[0], { position: { x: at.x, z: at.z - 12 }, yaw: 0, authored: true });
  assert.ok(critter, 'a critter stands up the lane');
  critter.health = 1000;
  // The hero a stride from it, facing it (yaw 0 faces -Z).
  put(game, critter.position.x, critter.position.z + 1.6, 0);
  game.step({ attack: true });
  assert.equal(melee.attacking, true, 'a press starts one swing');
  for (let i = 0; i < 0.3 / FIXED_STEP; i++) game.step({ attack: true });
  assert.equal(critter.health, 1000 - 40, 'the blow lands once, on the swing');
  assert.equal(melee.strikes, 1, 'held down, it is still one swing until the cooldown');
  put(game, critter.position.x, critter.position.z + 1.6, Math.PI);
  for (let i = 0; i < 0.8 / FIXED_STEP; i++) game.step({ attack: i === 30 });
  assert.equal(melee.strikes, 2); assert.equal(critter.health, 1000 - 40, 'nothing behind the hero is struck');
  game.dispose();
}
// --- the collect-a-thon: honey laid along the lanes, a stomp, and the drops counted to a win ---
{
  const project = quickMission('arcade', 'K7QN-3F2A-9XBD', 'collect'), level = compileShooterProject(project, pack);
  const drops = level.placements.filter(p => p.stepId === 'harvest');
  assert.equal(drops.length, 12, 'the step lays its twelve drops');
  assert.deepEqual(drops.map(p => p.key), drops.map((_, i) => `step:harvest:${i}`), 'keyed per step, like a pad');
  assert.ok(drops.every(p => p.pickup === 'collectible' && p.model === pack.props.find(q => q.id === 'honeyDrop').model && level.terrain.depthAt(p.x, p.z) < 0.05), 'honey, on dry ground');
  assert.deepEqual(compileShooterProject(project, pack).placements.filter(p => p.stepId === 'harvest').map(p => [p.x, p.z]), drops.map(p => [p.x, p.z]), 'the same drops every compile');
  const moved = compileShooterProject({ ...project, edits: normalizeEdits({ overrides: { 'step:harvest:3': { x: 2, z: 20 } } }) }, pack).placements.filter(p => p.stepId === 'harvest');
  assert.deepEqual([moved[3].x, moved[3].z], [2, 20], 'a drop moves by its key');
  assert.deepEqual(moved.filter((_, i) => i !== 3).map(p => [p.x, p.z]), drops.filter((_, i) => i !== 3).map(p => [p.x, p.z]), 'and the rest stay put');
  assert.equal(checkLevel(level, { genre: 'collect' }).issues.filter(i => i.code === 'pad-unreachable').length, 0, 'every drop can be reached');

  const game = new Game({ level, createSystems: g => rulesFor('collect').createSystems({}, g, {}) });
  game.start();
  const stomp = game.extraSystems.find(([k]) => k === 'stomp')[1];
  const at = level.spawn.position, critter = game.enemies.spawn(level.blueprint.pools.enemies[0], { position: { x: at.x, z: at.z - 12 }, yaw: 0, authored: true });
  put(game, critter.position.x, critter.position.z);
  game.player.position.y = critter.position.y + (critter.type.height ?? 1.2) + 0.1; game.player.prevPosition.copy(game.player.position);
  game.player.grounded = false; game.player.velocity.set(0, -3, 0);
  game.step();
  assert.equal(critter.alive, false, 'landing on a critter bops it');
  assert.ok(game.player.velocity.y > PLAYER.jumpSpeed * 0.5 && stomp.stomps === 1, 'and the hero bounces off');
  assert.equal(game.objectives.hudState.targetsTotal, 12);
  for (const [i, d] of game.script.drops.entries()) {
    put(game, d.record.x, d.record.z); game.step();
    assert.equal(game.script.collected, i + 1, `drop ${i + 1} is picked up`);
  }
  assert.equal(game.objectives.hudState.completed, 1, 'the twelfth drop completes the step');
  const lookout = level.placements.find(p => p.stepId === 'lookout');
  put(game, lookout.x, lookout.z); game.step();
  put(game, level.spawn.position.x, level.spawn.position.z);
  for (let i = 0; i < 300 && game.state.current !== State.VICTORY; i++) game.step();
  assert.equal(game.state.current, State.VICTORY, 'honey, the lookout, home: won');
  game.dispose();
}
// --- the arena: a survive step keeps the critters coming until its clock runs out ---
{
  const project = quickMission('arcade', 'K7QN-3F2A-9XBD', 'arena');
  project.blueprint.nodes = project.blueprint.nodes.map(n => n.id === 'hold' ? { ...n, duration: 4 } : n);
  const level = compileShooterProject({ ...project, blueprint: { ...project.blueprint, nodes: project.blueprint.nodes.filter(n => n.id !== 'waves'), edges: project.blueprint.edges.filter(e => e.to !== 'waves' && e.from !== 'waves').concat([{ from: 'generator', out: 'start', to: 'hold', input: 'start' }]) } }, pack);
  assert.deepEqual(level.blueprint.mission.map(s => s.objective), ['survive', 'extract']);
  const game = new Game({ level }); game.start();
  put(game, level.spawn.position.x, level.spawn.position.z);
  game.step();
  const O = game.objectives;
  assert.equal(O.wave, 1); assert.ok(O.activeIds.length > 0 || O.pending > 0, 'the first wave comes at once');
  assert.match(O.hudState.label, /^SURVIVE · 4 S$/); assert.equal(O.hudState.timeLeft, 4);
  for (const e of game.enemies.enemies) if (e.alive) game.enemies.damage(e, 1e6, {});
  for (let i = 0; i < 10; i++) game.step();
  assert.equal(O.wave, 2, 'a cleared wave is followed by the next while the clock runs');
  assert.equal(O.hudState.completed, 0, 'clearing it does not end the step');
  for (let i = 0; i < 4 / FIXED_STEP && O.hudState.completed === 0; i++) { game.player.health = 100; game.step(); }
  assert.equal(O.hudState.completed, 1, 'the clock ends it');
  game.dispose();
}

console.log('Genre registry, perspectives and controls, retired choices, genre-aware compiler, systems bag, hands-only exploration, the follow and twin-stick inputs, strike, stomp, honey and survive passed');
