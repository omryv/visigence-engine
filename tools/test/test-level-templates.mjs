// The template games (world/level/templates.js): every one opens as a format-4 game, every level passes the live
// checks without an error or a warning, every locked pen really keeps the player out until its gate opens, and every
// level is won by playing it: keys taken, levers pulled, gates opened, then the mission step by step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TEMPLATES, templateGame, templateById, copyName } from '../../src/world/level/templates.js';
import { resolveGame, resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { levelProject } from '../../src/world/level/game.js';
import { packageProject, parseProjectText, MAX_PROJECT_BYTES } from '../../src/world/projectSchema.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { checkLevel } from '../../src/world/level/checks.js';
import { GENRES, GENRE_IDS } from '../../src/genres/registry.js';
import { Game } from '../../src/game/Game.js';
import { State } from '../../src/sim/GameState.js';
import { FIXED_STEP } from '../../src/config/gameplay.js';
import { gameBundle } from '../../src/world/gameBundle.js';

const source = JSON.parse(fs.readFileSync('packs/arcade/pack.json')), pack = resolvePack(source, CATALOG.arcade.measurements);
assert.deepEqual([...new Set(TEMPLATES.map(t => t.genre))].sort(), [...GENRE_IDS].sort(), 'a template for every genre');
// named by genre, the words Play uses (docs/EDITOR.md); a copy starts under a name of its own
for (const t of TEMPLATES) assert.equal(t.name, `${GENRES[t.genre].label} template`);
assert.equal(templateGame('honey-siege').name, 'Arena shooter template'); assert.equal(copyName('honey-siege'), 'My arena shooter game');
assert.equal(templateById('nope'), null);
assert.throws(() => templateGame('nope'), /Unknown template/);

const stand = (g, x, z, look = null) => g.player.reset({ position: { x, z }, yaw: look ? Math.atan2(-(look.x - x), -(look.z - z)) : 0, pitch: 0 });
/** Hold interact on whatever is ahead until `done`, trying a few pitches so the ray meets the use column. */
const hold = (g, done, seconds = 4) => {
  for (const pitch of [0, -0.25, -0.45, 0.2]) { g.player.pitch = pitch; g.step({ interact: true }); if (g.interactions.target) break; }
  for (let i = 0; i < seconds / FIXED_STEP && !done(); i++) g.step({ interact: true });
  return done();
};
const reachable = (g, from, to) => !!g.collision.findPath(from.x, from.z, to.x, to.z, 1);

let levels = 0;
for (const t of TEMPLATES) {
  const doc = templateGame(t.id), game = resolveGame(doc);
  assert.equal(game.levels.length, 3, `${t.id}: three levels`);
  assert.equal(game.genre, t.genre); assert.equal(game.name, t.name);
  const text = JSON.stringify(packageProject(game));
  assert.ok(text.length < MAX_PROJECT_BYTES / 8, `${t.id}: ${Math.round(text.length / 1024)} KB, well under the file limit`);
  assert.deepEqual(resolveGame(parseProjectText(text, { requireEnvelope: true }).project), game, `${t.id}: saves and opens unchanged`);
  const shipped = new Set(gameBundle(game, source).assets);
  for (let i = 0; i < game.levels.length; i++) {
    const name = `${t.id}/${game.levels[i].name}`;
    const project = resolveProject(levelProject(game, i)), level = compileShooterProject(project, pack);
    const issues = checkLevel(level, { genre: GENRES[project.genre] }).issues.filter(x => x.severity !== 'info');
    assert.deepEqual(issues.map(x => `${x.code}: ${x.message}`), [], `${name}: clean live checks`);
    // The export carries everything this level draws: every placed model (a biome's own included) and its part libraries.
    for (const m of new Set([...level.placements.map(p => p.model), level.pack.houses?.library, level.pack.trees?.library, level.pack.world?.library].filter(Boolean)))
      assert.ok(shipped.has(m), `${name}: the export carries ${m}`);

    const g = new Game({ level }); g.start();
    const start = level.spawn.position, S = g.script;
    // Every locked pen is shut until its gate opens.
    for (const d of S.doors) {
      const inside = { x: d.record.x, z: d.record.z - 4.9 };
      assert.equal(reachable(g, start, inside), false, `${name}: the ${d.lock} pen is closed`);
    }
    for (const k of S.keys) { stand(g, k.record.x, k.record.z); g.step(); assert.ok(k.taken, `${name}: the ${k.color} key is taken`); }
    for (const l of S.levers) { stand(g, l.record.x, l.record.z + 1.6, l.record); assert.ok(hold(g, () => l.pulled), `${name}: the lever pulls`); }
    for (const z of S.zones) { stand(g, z.entity.x, z.entity.z); g.step(); assert.ok(z.fired, `${name}: the zone fires`); }
    for (const d of S.doors.filter(d => d.lock !== 'wired')) { stand(g, d.record.x, d.record.z + 2.2, d.record); assert.ok(hold(g, () => d.opened), `${name}: the ${d.lock} gate opens with its key`); }
    for (const d of S.doors) {
      assert.ok(d.opened, `${name}: every gate is open`);
      assert.ok(reachable(g, start, { x: d.record.x, z: d.record.z - 4.9 }), `${name}: and its pen can be walked into`);
    }
    // The mission, step by step: pads held, honey gathered, places reached, critters cleared, home.
    for (let tick = 0; tick < 12000 && g.state.current !== State.VICTORY; tick++) {
      const step = g.objectives.current;
      if (step?.objective === 'collect') {
        const d = S.drops.find(d => !d.taken);
        assert.ok(d && reachable(g, start, d.record), `${name}: a drop can be reached`);
        stand(g, d.record.x, d.record.z);
      } else if (step?.objective === 'extract') {
        const ex = level.extraction; assert.ok(reachable(g, start, ex), `${name}: the extraction can be reached`);
        stand(g, ex.x, ex.z);
      } else {
        const p = level.placements.find(q => q.stepId === step?.id && !g.objectives.targets.find(t => t.record === q)?.complete);
        if (p) {
          const z = p.z + (p.interaction ? (p.halfZ ?? 0) + 0.9 : 0);
          assert.ok(reachable(g, start, { x: p.x, z }), `${name}/${step.id}: the pad can be reached`);
          stand(g, p.x, z); g.player.pitch = p.interaction ? Math.atan2((p.y + p.height * 0.65) - g.player.eyePosition.y, z - p.z) : 0;
        }
      }
      for (const e of g.enemies.enemies) if (e.alive) g.enemies.damage(e, 1e6, {});
      g.player.health = 100;
      g.step({ interact: true });
    }
    assert.equal(g.state.current, State.VICTORY, `${name}: won (stuck at ${g.objectives.current?.id})`);
    g.dispose(); levels++;
  }
}
assert.equal(levels, 15);
console.log(`${TEMPLATES.length} template games, ${levels} levels: clean checks, closed pens, open gates, every level won`);
