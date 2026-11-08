/**
 * The level builder's templates and blank starts: every one builds, survives a save and a
 * share link unchanged, passes its own checks with no errors or warnings, and plays for
 * twenty seconds in its genre's simulation without throwing, the same way twice.
 *   node tools/test/test-builder-templates.mjs
 */
import assert from 'node:assert/strict';
import { TEMPLATES, templateById, blankProject } from '../../../src/play2d/templates/index.js';
import { serializeProject, parseProject, encodeShare, decodeShare } from '../../../src/play2d/core/format.js';
import { analyzeProject } from '../../../src/play2d/core/analyze.js';
import { GENRE_IDS, LIMITS, genreById } from '../../../src/play2d/core/catalog.js';
import { createSim, emptyInput, STEP } from '../../../src/play2d/runtime/sims/index.js';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };

/** A scripted, genre-agnostic player: wander, jump, fire and push in a fixed pattern. */
function drive(sim, seconds) {
  const frames = Math.round(seconds / STEP);
  let prev = emptyInput();
  const trail = [];
  for (let i = 0; i < frames && sim.status === 'play'; i++) {
    const input = emptyInput();
    const phase = Math.floor(i / 50) % 6;
    input.right = phase < 3; input.left = phase === 4; input.up = phase === 2 || phase === 5; input.down = phase === 3;
    input.jump = i % 40 < 10; input.fire = i % 20 < 4; input.action = i % 90 === 0;
    input.aim = { x: Math.cos(i / 30), y: Math.sin(i / 30) };
    for (const k of ['up', 'down', 'left', 'right', 'jump', 'fire', 'action']) input.pressed[k] = !!input[k] && !prev[k];
    sim.step(input);
    prev = input;
    if (i % 60 === 0) trail.push(`${sim.player.x.toFixed(3)},${sim.player.y.toFixed(3)},${sim.score}`);
  }
  return trail.join(' ');
}

await test('five templates, one per genre, three levels each', () => {
  assert.equal(TEMPLATES.length, 5);
  assert.deepEqual([...new Set(TEMPLATES.map(t => t.genre))].sort(), [...GENRE_IDS].sort());
  for (const t of TEMPLATES) {
    const p = t.build();
    assert.equal(p.genre, t.genre);
    assert.equal(p.levels.length, 3, t.id);
    assert.ok(p.title && p.description, t.id);
    assert.equal(templateById(t.id), t);
  }
});

await test('templates are named by genre, and a copy starts under its own name', () => {
  for (const t of TEMPLATES) {
    const genre = genreById(t.genre).name;
    assert.equal(t.name, `${genre} template`, 'the same words as the genre, as in the 3D studio');
    assert.equal(t.build().title, t.name, 'played as the template');
    assert.equal(t.build({ copy: true }).title, `My ${genre.toLowerCase()} game`, 'kept as someone\'s own game');
  }
});

await test('each build is a fresh copy with its own id', () => {
  const t = TEMPLATES[0];
  const a = t.build(), b = t.build();
  assert.notEqual(a.id, b.id);
  a.levels[0].terrain[0] = 99;
  assert.notEqual(b.levels[0].terrain[0], 99);
  assert.equal(t.build({ id: 'fixed' }).id, 'fixed');
});

for (const t of TEMPLATES) {
  await test(`${t.id}: save and share round trips`, async () => {
    const p = t.build({ id: 'rt-' + t.id });
    const text = serializeProject(p);
    assert.equal(serializeProject(parseProject(text)), text);
    const code = await encodeShare(p);
    assert.ok(code.length < 12000, `${t.id} share code is ${code.length} chars`);
    assert.equal(serializeProject(await decodeShare(code)), text);
  });

  await test(`${t.id}: every level passes its checks`, () => {
    const p = t.build({ id: 'an-' + t.id });
    const r = analyzeProject(p, { maxNodes: 400000 });
    const bad = r.levels.flatMap((l, i) => l.issues.filter(x => x.severity !== 'tip').map(x => `level ${i + 1}: ${x.severity} ${x.id}: ${x.message}`));
    assert.deepEqual(bad, []);
    for (const l of r.levels) {
      assert.ok(l.stats.entities <= LIMITS.entities && l.stats.enemies <= LIMITS.enemies);
      if (t.genre === 'puzzle') assert.equal(l.solver.solvable, true, 'every puzzle is proven solvable');
    }
  });

  await test(`${t.id}: every level plays deterministically`, () => {
    const p = t.build({ id: 'sim-' + t.id });
    for (let i = 0; i < p.levels.length; i++) {
      const a = drive(createSim(p, i, { seed: 11 }), 20);
      const b = drive(createSim(p, i, { seed: 11 }), 20);
      assert.equal(a, b, `level ${i + 1} diverged`);
    }
  });
}

await test('a share link that inflates past the cap is refused before it is inflated', async () => {
  // 64 MB of zeros deflates to a link of about 85 KB
  const zeros = new Uint8Array(64 * 1024 * 1024);
  const deflated = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const code = '1.' + Buffer.from(deflated).toString('base64url');
  // count what the decoder pulls out of the decompressor
  const Real = globalThis.DecompressionStream;
  let inflated = 0;
  globalThis.DecompressionStream = class {
    constructor(format) {
      const d = new Real(format);
      this.writable = d.writable;
      this.readable = d.readable.pipeThrough(new TransformStream({ transform(chunk, out) { inflated += chunk.length; out.enqueue(chunk); } }));
    }
  };
  try { await assert.rejects(decodeShare(code), /holds too much/); } finally { globalThis.DecompressionStream = Real; }
  assert.ok(inflated < 16 * 1024 * 1024, `inflated ${inflated} bytes of the 64 MB`);
});

for (const g of GENRE_IDS) {
  await test(`blank ${g}: a playable frame with no errors`, () => {
    const p = blankProject(g);
    assert.equal(p.genre, g);
    const r = analyzeProject(p);
    assert.equal(r.errors, 0, JSON.stringify(r.levels[0].issues));
    drive(createSim(p, 0, {}), 5);
  });
}

console.log(`ok ${passed} builder template tests`);
