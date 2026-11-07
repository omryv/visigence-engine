/**
 * MISSION -> INTENT, end to end on the repository's kernel (src/world/missionIntent.js).
 *
 * The unit half: the list compileMissionIntent writes is one the kernel accepts (intentErrors,
 * with the plate's size), is the same list every time, places what a step does not place with
 * the documented seed paths, honours what a step does place, and keeps to MAX_INTENT and MAX_ROWS
 * by dropping sightlines before roads and roads before places to stand, saying so in `notes`.
 *
 * The integration half is the claim the module exists to make: hand the list to the kernel as
 * `params.terrain.intent` on a real world (src/kernel/presets.js makeParams) and createHeightSampler
 * makes it TRUE. For every genre's template mission (src/world/missionCard.js quickMission, the
 * authored routes in src/world/genreContent.js) on two seeds: the solve converged and dropped
 * nothing, every pad stands at its height at its centre and round its ring within 0.05 m, every
 * point within 0.05 m, every corridor holds its grade between neighbouring samples (to the
 * millimetre, as tools/test/kernel/intent-v2.test.js holds the kernel's own corridors), and every sightline's
 * ground within 0.05 m of its line (worst measured 5.6 mm over) — all in a scale-8 frame. At
 * scale 1 the measured worst cases are pinned instead, and the module's note saying so is
 * required. Measured, and printed, so a change that loosens any of it shows.
 *
 * Run:  node tools/test/test-mission-intent.mjs
 */
import assert from 'node:assert/strict';
import { compileMissionIntent, resolveFrame, PAD_RADIUS, ARENA_RADIUS, MAX_SITES, DEFAULT_ROOT, PLAYABLE_SCALE } from '../../src/world/missionIntent.js';
import { compileBlueprint } from '../../src/world/blueprint.js';
import { quickMission } from '../../src/world/missionCard.js';
import { GENRE_LEVELS, GENRE_PROFILES } from '../../src/world/genreContent.js';
import { CATALOG } from '../../src/world/catalog.js';
import { GENRES, GENRE_IDS } from '../../src/genres/registry.js';
import { TRAVERSAL_DEFAULTS } from '../../src/world/buildSpec.js';
import { makeParams } from '../../src/kernel/presets.js';
import { createHeightSampler, slopeAt } from '../../src/kernel/terrain/heightfield.js';
import { intentErrors, polylineSamples, CORRIDOR_STEP, CORRIDOR_SAMPLES, FLAT_RING, MAX_INTENT, MAX_ROWS, RAY_SAMPLES } from '../../src/kernel/terrain/condition.js';
import { seedPath } from '../../src/kernel/core/seedpath.js';

const SEEDS = ['K7QN-3F2A-9XBD', 'TMNR-2J2A-PG43'];
const SIZE = 4096;
const MET = 0.05, MM = 0.001;
const ORIGIN = { originX: 300, originZ: -200 };
const missionOf = (genre, seed) => {
  const p = quickMission('arcade', seed, genre);
  return compileBlueprint(p.blueprint, CATALOG[p.theme], { genre: GENRES[p.genre] });
};
const dist = (a, b) => Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
/** The notes about steps, without the one a frame below PLAYABLE_SCALE adds about itself. */
const stepNotes = out => out.notes.filter(n => !/^frame scale /.test(n));

// ── the frame ───────────────────────────────────────────────────────────────
{
  const f = resolveFrame({});
  assert.deepEqual([f.originX, f.originZ, f.rotation, f.scale, f.size], [0, 0, 0, 1, SIZE], 'the default frame: centre of the kernel\'s default plate, level metres = plate metres');
  assert.deepEqual(resolveFrame({ originX: 100, originZ: -50, scale: 8 }).toPlate(3, -2), [124, -66]);
  assert.deepEqual(resolveFrame({ rotation: Math.PI / 2, scale: 2 }).toPlate(10, 0), [0, 20], 'a quarter turn takes +x to +z, rounded to the centimetre');
  // The default frame (scale 1) is the identity, and says up front that it is below PLAYABLE_SCALE.
  const dflt = compileMissionIntent({ mission: [{ id: 'a', objective: 'activate', count: 1 }] });
  assert.match(dflt.notes[0], /^frame scale 1 < 8 \(PLAYABLE_SCALE\)/);
  assert.ok(!compileMissionIntent({ mission: [{ id: 'a', objective: 'activate', count: 1 }] }, { frame: { scale: PLAYABLE_SCALE } }).notes.some(n => /^frame scale /.test(n)));
  console.log('  ok   the frame maps level metres onto the plate, and a frame below PLAYABLE_SCALE says so in notes');
}

// ── what each step asks for ─────────────────────────────────────────────────
{
  const mission = [
    { id: 'stations', objective: 'activate', count: 6 }, { id: 'drops', objective: 'collect', count: 12 },
    { id: 'look', objective: 'reach', count: 1, at: [12, -20] }, { id: 'gates', objective: 'barricade', count: 2, sites: [[-5, 5], { x: 6, z: 7 }] },
    { id: 'fight', objective: 'waves', count: 3 }, { id: 'out', objective: 'extract', count: 1 },
  ];
  const out = compileMissionIntent({ mission }, { frame: { ...ORIGIN, scale: 8, h: 30 }, seed: SEEDS[0] });
  assert.deepEqual(intentErrors(out.intent, { size: SIZE }), [], 'the kernel accepts the list');
  const by = (step, role) => out.intent.filter((_, i) => out.sources[i].step === step && out.sources[i].role === role);
  assert.equal(out.sources[0].objective, 'spawn'); assert.equal(out.intent[0].type, 'pad');
  assert.deepEqual([out.intent[0].x, out.intent[0].z], [300, -200], 'spawn defaults to the level centre');
  assert.equal(by('stations', 'pad').length, MAX_SITES, 'stations: a pad each, at most four');
  assert.equal(by('stations', 'corridor').length, MAX_SITES, 'and a corridor from spawn to each');
  assert.ok(by('stations', 'corridor').every(r => r.points[0][0] === 300 && r.points[0][1] === -200 && r.points.length === 2));
  const arena = by('fight', 'arena');
  assert.equal(arena.length, 1); assert.ok(arena[0].r > by('stations', 'pad')[0].r && arena[0].r >= ARENA_RADIUS, 'the arena is the larger pad');
  const rays = by('fight', 'sightline');
  assert.equal(rays.length, 3, 'three sightlines in from cover');
  for (const r of rays) {
    assert.deepEqual(r.at, [arena[0].x, arena[0].z], 'to the arena\'s centre');
    const d = Math.sqrt((r.eye[0] - r.at[0]) ** 2 + (r.eye[2] - r.at[1]) ** 2);
    assert.ok(d > arena[0].r, `from cover outside the floor (${d.toFixed(1)} m > ${arena[0].r} m)`);
    assert.equal(r.eye[1], 31.6, 'a standing eye over the floor');
  }
  assert.equal(by('drops', 'point').length, MAX_SITES, 'collect: the lane\'s drops, at most four');
  const lane = by('drops', 'corridor');
  assert.equal(lane.length, 1); assert.equal(lane[0].points.length, MAX_SITES + 1, 'one lane from spawn through every drop');
  const look = by('look', 'point')[0];
  assert.deepEqual([look.x, look.z], [300 + 12 * 8, -200 - 20 * 8], 'a step that says where it is is placed there');
  assert.deepEqual(by('gates', 'point').map(r => [r.x, r.z]), [[260, -160], [348, -144]], 'sites as [x, z] or {x, z}');
  const back = by('out', 'corridor');
  assert.equal(back.length, 1); assert.deepEqual(back[0].points, [[arena[0].x, arena[0].z], [300, -200]], 'extract: from the last site back to spawn');
  // After a step that already has its road from spawn, the way back IS that road: said once, and noted.
  const twice = compileMissionIntent({ mission: [mission[3], mission[5]] }, { frame: ORIGIN });
  assert.equal(twice.intent.filter(r => r.type === 'corridor').length, 2);
  assert.match(stepNotes(twice)[0], /already stated/);
  assert.ok(out.intent.filter(r => r.type === 'pad').every(r => r.r >= PAD_RADIUS), 'every pad at least 48 m in radius');
  assert.ok(out.intent.filter(r => r.type === 'pad' || r.type === 'point').every(r => r.h === 30), 'one floor height');
  assert.ok(out.intent.filter(r => r.type === 'corridor').every(r => r.maxGrade === TRAVERSAL_DEFAULTS.maxSlope * 0.25), 'the grade is the body\'s');
  assert.equal(compileMissionIntent({ mission }, { frame: ORIGIN, traversal: { maxSlope: 0.4 } }).intent.find(r => r.type === 'corridor').maxGrade, 0.1);
  // Placement: the documented paths, inside the village, apart.
  const drawn = out.sites.filter(s => s.placed === 'seedpath');
  assert.equal(drawn.length, 4 + 1 + 4, 'stations, the arena and the drops were drawn; the lookout and the gates were given');
  for (const s of drawn) {
    assert.equal(s.path, seedPath(SEEDS[0], 'games3d', 'mission', s.step, `site:${s.k}`));
    assert.ok(Math.hypot(...s.level) <= 30, `${s.path} lies in the village`);
  }
  assert.equal(drawn[0].path, 'K7QN-3F2A-9XBD/games3d/mission/stations/site:0');
  let closest = Infinity;
  for (let i = 0; i < drawn.length; i++) for (let j = 0; j < i; j++) closest = Math.min(closest, Math.hypot(drawn[i].level[0] - drawn[j].level[0], drawn[i].level[1] - drawn[j].level[1]));
  assert.ok(closest >= 10, `drawn sites at least 10 m apart (closest ${closest.toFixed(2)} m)`);
  assert.ok(compileMissionIntent({ mission }, { frame: ORIGIN }).sites[0].path.startsWith(`${DEFAULT_ROOT}/games3d/`), 'no seed: the verbatim root');
  // Keyed by id: a step put in front does not move the steps behind it.
  const front = compileMissionIntent({ mission: [{ id: 'first', objective: 'reach' }, ...mission] }, { frame: { ...ORIGIN, scale: 8 }, seed: SEEDS[0] });
  assert.deepEqual(front.sites.find(s => s.step === 'fight').level, out.sites.find(s => s.step === 'fight').level, 'a site belongs to its step\'s id');
  assert.match(stepNotes(compileMissionIntent({ mission: [{ id: 'x', objective: 'dance' }] }))[0], /not an objective/);
  assert.match(stepNotes(compileMissionIntent({ mission: [{ id: 'x', objective: 'extract' }] }))[0], /nothing before it/);
  console.log(`  ok   every step kind asks for what it should (${out.intent.length} records, ${out.rows} rows)`);
}

// ── determinism, and no Math.random ────────────────────────────────────────
{
  const random = Math.random;
  Math.random = () => { throw new Error('Math.random was called'); };
  try {
    for (const genre of GENRE_IDS) {
      const a = compileMissionIntent(missionOf(genre, SEEDS[0]), { frame: { ...ORIGIN, scale: 8 }, seed: SEEDS[0] });
      const b = compileMissionIntent(missionOf(genre, SEEDS[0]), { frame: { ...ORIGIN, scale: 8 }, seed: SEEDS[0] });
      assert.deepEqual(a, b, `${genre}: the same mission states the same ground`);
      assert.deepEqual(JSON.parse(JSON.stringify(a.intent)), a.intent, `${genre}: and the list survives a file`);
      const other = compileMissionIntent(missionOf(genre, SEEDS[1]), { frame: { ...ORIGIN, scale: 8 }, seed: SEEDS[1] });
      assert.notDeepEqual(other.sites.map(s => s.level), a.sites.map(s => s.level), `${genre}: another seed, other sites`);
      const params = makeParams({ seed: SEEDS[0] });
      params.terrain.intent = a.intent;
      createHeightSampler(params)(0, 0); // the kernel's solve, too, under the trap
    }
  } finally { Math.random = random; }
  console.log('  ok   the same inputs give the same list, and nothing reached Math.random');
}

// ── the budget ──────────────────────────────────────────────────────────────
{
  // Twelve stations of four and six fights: 1 + 48 + 6 anchors, 48 corridors, 18 sightlines.
  const mission = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, objective: 'activate', count: 4 })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, objective: 'boss', count: 1 })),
  ];
  const out = compileMissionIntent({ mission }, { frame: { ...ORIGIN, scale: 8 }, seed: SEEDS[0] });
  assert.equal(out.intent.length, MAX_INTENT, 'filled to MAX_INTENT and no further');
  assert.ok(out.rows <= MAX_ROWS);
  assert.deepEqual(intentErrors(out.intent, { size: SIZE }), [], 'a list the kernel accepts whole');
  assert.ok(out.intent.every(r => r.type === 'pad'), 'the places to stand are what is kept');
  const dropped = 1 + 48 + 6 + 48 + 18 - MAX_INTENT;
  assert.equal(out.notes.filter(n => /MAX_INTENT/.test(n)).length, dropped, `every one of the ${dropped} left out is named`);
  assert.ok(out.notes.some(n => /sightline left out/.test(n)) && out.notes.some(n => /corridor left out/.test(n)));
  // Rows: few records, many rows — fourteen checkpoints on a village scaled to 2.4 km, each road
  // from spawn a kilometre of 32 m samples. The roads that do not fit are the ones left out.
  const rowsHeavy = compileMissionIntent({ mission: Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, objective: 'reach' })) },
    { frame: { scale: 40 }, seed: SEEDS[0] });
  assert.ok(rowsHeavy.intent.length < MAX_INTENT && rowsHeavy.rows <= MAX_ROWS, `rows held to ${MAX_ROWS} (${rowsHeavy.rows} in ${rowsHeavy.intent.length} records)`);
  assert.ok(stepNotes(rowsHeavy).length && stepNotes(rowsHeavy).every(n => /corridor left out .*MAX_ROWS/.test(n)), rowsHeavy.notes.join('; '));
  assert.equal(rowsHeavy.intent.filter(r => r.type === 'point').length, 14, 'every checkpoint kept; only roads dropped');
  assert.deepEqual(intentErrors(rowsHeavy.intent, { size: SIZE }), []);
  // Off the plate: named, never stated.
  const edge = compileMissionIntent({ mission: [{ id: 'far', objective: 'reach', at: [30, 0] }] }, { frame: { originX: 1990, originZ: 0, scale: 4 } });
  assert.deepEqual(intentErrors(edge.intent, { size: SIZE }), []);
  assert.ok(edge.notes.some(n => /off the plate/.test(n)), edge.notes.join('; '));
  console.log(`  ok   MAX_INTENT and MAX_ROWS hold, sightlines before roads before places, every drop named (${out.notes.length} notes)`);
}

// ── the kernel makes it true ────────────────────────────────────────────────
/*
 * Scale 8: the 80 m village becomes 640 m of plate, a few cells of the kernel's finest lattice
 * octave (about 72 m on the default world), which is the resolution its corrections are drawn in.
 * At scale 1 the whole village is inside about one cell and the statements crowd: measured on
 * these missions and seeds, every solve still converged and every list was accepted, but a pad
 * missed by up to 9.9 cm (TMNR, the action mission) and an arena's ground stood 5.6 cm over a
 * sightline (TMNR) — so the 0.05 m bar is held at scale 8, where the worst measured was 3.9 cm
 * (TMNR's arena; every other mission under 1.5 mm), and scale 1 is held to the kernel's
 * acceptance and convergence only. The table below prints both.
 */
const report = [];
const worst = { 8: { stand: 0, sight: -Infinity }, 1: { stand: 0, sight: -Infinity } };
for (const scale of [8, 1]) {
  for (const genre of GENRE_IDS) {
    for (const seed of SEEDS) {
      const compiled = missionOf(genre, seed);
      const params = makeParams({ seed });
      const raw = createHeightSampler(params);
      // The seed's own ground under the origin, kept above the waterline: the least bending.
      const h = Math.max(4, Math.round(raw(ORIGIN.originX, ORIGIN.originZ) * 100) / 100);
      const out = compileMissionIntent(compiled, { frame: { ...ORIGIN, scale, h }, traversal: TRAVERSAL_DEFAULTS, seed });
      assert.deepEqual(intentErrors(out.intent, { size: params.terrain.size }), [], `${genre} ${seed}: accepted`);
      assert.ok(!out.notes.some(n => /left out/.test(n)), `${genre} ${seed}: nothing left out (${out.notes.join('; ')})`);
      params.terrain.intent = out.intent;
      const s = createHeightSampler(params);
      const c = s.conditioning;
      assert.ok(c.converged, `${genre} ${seed} x${scale}: converged`);
      assert.equal(c.dropped, 0, `${genre} ${seed} x${scale}: the kernel dropped nothing`);
      let stand = 0, grade = -Infinity, sight = -Infinity, steep = 0;
      for (const r of out.intent) {
        if (r.type === 'pad') {
          stand = Math.max(stand, Math.abs(s(r.x, r.z) - r.h));
          for (const [u, v] of FLAT_RING) stand = Math.max(stand, Math.abs(s(r.x + r.r * u, r.z + r.r * v) - r.h));
        } else if (r.type === 'point') stand = Math.max(stand, Math.abs(s(r.x, r.z) - r.h));
        else if (r.type === 'corridor') {
          const q = polylineSamples(r.points, CORRIDOR_STEP, CORRIDOR_SAMPLES);
          for (let i = 1; i < q.length; i++) grade = Math.max(grade, Math.abs(s(q[i].x, q[i].z) - s(q[i - 1].x, q[i - 1].z)) - r.maxGrade * dist(q[i - 1], q[i]));
          // What a body meets between the samples, every eighth of a step: reported, not bounded.
          for (let i = 1; i < q.length; i++) for (let k = 0; k < 8; k++) steep = Math.max(steep, slopeAt(s, q[i - 1].x + (q[i].x - q[i - 1].x) * k / 8, q[i - 1].z + (q[i].z - q[i - 1].z) * k / 8));
        } else if (r.type === 'ray') {
          for (let k = 0; k < RAY_SAMPLES; k++) {
            const t = k / RAY_SAMPLES;
            sight = Math.max(sight, s(r.eye[0] + (r.at[0] - r.eye[0]) * t, r.eye[2] + (r.at[1] - r.eye[2]) * t) - (r.eye[1] + (r.h - r.eye[1]) * t));
          }
        }
      }
      const scaleNote = out.notes.some(n => n.startsWith(`frame scale ${scale} < ${PLAYABLE_SCALE}`));
      assert.equal(scaleNote, scale < PLAYABLE_SCALE, `${genre} ${seed} x${scale}: the frame-scale note is there exactly when the frame is below PLAYABLE_SCALE`);
      worst[scale].stand = Math.max(worst[scale].stand, stand); worst[scale].sight = Math.max(worst[scale].sight, sight);
      if (scale === 8) {
        assert.ok(stand <= MET, `${genre} ${seed}: every pad and point within ${MET} m (worst ${stand.toExponential(2)} m)`);
        assert.ok(grade <= MM, `${genre} ${seed}: every corridor holds its grade (worst excess ${grade.toExponential(2)} m)`);
        assert.ok(sight <= MET, `${genre} ${seed}: every sightline's ground under its line (worst ${sight.toExponential(2)} m over)`);
      }
      report.push(`x${scale} ${genre.padEnd(11)} ${seed}  ${String(out.intent.length).padStart(2)} records ${String(out.rows).padStart(3)} rows  ` +
        `stand ${stand.toExponential(1)} m  grade ${grade === -Infinity ? '   -   ' : (grade <= 0 ? 'held   ' : grade.toExponential(1))}  ` +
        `sight ${sight === -Infinity ? '   -   ' : (sight <= 0 ? 'held   ' : sight.toExponential(1))}  steepest ${steep.toFixed(3)}  ${c.nats.toFixed(1)} nats`);
    }
  }
}
for (const line of report) console.log('       ' + line);
/* Scale 1 is not held to the 0.05 m bar (above), but its measured worst cases are pinned, a little
   over what was measured (9.9 cm standing, 5.6 cm over a sightline), so the default frame cannot
   quietly get worse than the note compileMissionIntent writes for it says. */
const SCALE1_STAND = 0.105, SCALE1_SIGHT = 0.06;
console.log(`       worst: x8 stand ${worst[8].stand.toExponential(2)} m, sight ${worst[8].sight.toExponential(2)} m; x1 stand ${worst[1].stand.toExponential(2)} m, sight ${worst[1].sight.toExponential(2)} m`);
assert.ok(worst[1].stand <= SCALE1_STAND, `scale 1: worst pad or point miss ${worst[1].stand} m, pinned at ${SCALE1_STAND} m`);
assert.ok(worst[1].sight <= SCALE1_SIGHT, `scale 1: worst sightline excess ${worst[1].sight} m, pinned at ${SCALE1_SIGHT} m`);
console.log(`  ok   ${GENRE_IDS.length} genres' template missions on ${SEEDS.length} seeds: the kernel met every statement at scale 8, and accepted, converged and stayed inside its pinned worst case at scale 1`);

// The authored routes' own sites, given rather than drawn, hold as well.
{
  const seed = SEEDS[1], genre = 'arena', level = GENRE_LEVELS[GENRE_PROFILES[genre]];
  const compiled = missionOf(genre, seed);
  compiled.mission.forEach((step, i) => { if (level.sites[i]) step.at = level.sites[i]; });
  const out = compileMissionIntent(compiled, { frame: { ...ORIGIN, scale: 8, h: 20 }, seed });
  assert.ok(out.sites.filter(s => s.placed === 'given').length >= 2);
  const params = makeParams({ seed });
  params.terrain.intent = out.intent;
  const s = createHeightSampler(params);
  assert.ok(s.conditioning.converged);
  for (const r of out.intent.filter(r => r.type === 'pad')) assert.ok(Math.abs(s(r.x, r.z) - r.h) <= MET);
  console.log('  ok   a mission placed at the authored sites holds too');
}
console.log('\nAll mission-intent checks passed.');
