/**
 * The Blender kit's Python seed algebra against the repository kernel's own vectors.
 *
 * The JS side of this engine no longer has a seed algebra of its own: it imports the kernel's
 * (src/kernel/seed.js). The Python side still needs one, because Blender
 * runs Python — tools/blender/v2/core/grammar_core.py carries `hash_seed` and `mulberry32`, and
 * every generated house, tree, creature and village the kit models is drawn through them. A port
 * that disagreed with the kernel by one bit would model a different village from the one the
 * game lays out.
 *
 * So the port is held to the kernel's cross-language contract, tools/test/kernel/vectors/seed-vectors.json
 * (written by tools/kernel/seed-vectors.mjs from src/kernel/core/seedpath.js, and already checked against
 * the JS by tools/test/kernel/seed-vectors.test.js and against the Python port by tools/kernel/py/check_vectors.py). Its
 * legacy32 section is exactly the scheme this engine draws with — FNV-1a over UTF-16 code units,
 * channels joined with ":", mulberry32 — so for every entry:
 *
 *   hash_seed(root)                            == hashSeed
 *   hash_seed(root + ":" + channel)            == seedChannel[channel]   (terrain, erosion, props)
 *   hash_seed(root + ":" + ":".join(segments)) == legacy32Seed
 *   mulberry32(legacy32Seed), first 8 draws    == legacy32               (as uint32: draw × 2^32)
 *
 * The thirteen entries' channels include "café", "森" and "山:2", and "🌲:4294967296" (an
 * astral-plane character, two UTF-16 code units), and one root is the verbatim "unseeded", so the
 * port's UTF-16 handling is exercised and not only ASCII seeds.
 *
 * Spawns `python3 -B` (no __pycache__ left in the kit). Without a python3 on PATH it SKIPS, and
 * says so, rather than failing: the Blender kit is optional to everything else this suite runs.
 * The reason goes out on a `SUITE-SKIPPED:` line, which tools/test/run.mjs reads to report the
 * suite as skipped (and why) instead of as passed — a runner that shows output only on failure
 * would otherwise print "ok" for a check that never ran.
 *
 * Run:  node tools/test/test-kernel-parity.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GAMES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VECTORS = path.join(GAMES, 'tools/test/kernel/vectors/seed-vectors.json');
const CORE = path.join(GAMES, 'tools/blender/v2/core');

const probe = spawnSync('python3', ['-B', '-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.log(`SUITE-SKIPPED: no python3 on PATH (${probe.error?.code ?? `exit ${probe.status}`}), so the Blender kit's seed port is unchecked against ${path.relative(GAMES, VECTORS)}`);
  process.exit(0);
}
if (!fs.existsSync(VECTORS)) {
  console.error(`FAIL: the kernel's vectors are missing at ${VECTORS}`);
  process.exit(1);
}

const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from grammar_core import hash_seed, mulberry32
doc = json.load(open(sys.argv[2], encoding='utf-8'))
entries = doc['entries']
bad, checks = [], 0
def same(where, what, got, want):
    global checks
    checks += 1
    if got != want:
        bad.append('%s %s: python %r, kernel %r' % (where, what, got, want))
for e in entries:
    where, root, segments = e['path'], e['root'], e['input']['segments']
    same(where, 'hashSeed', hash_seed(root), e['hashSeed'])
    for ch, want in sorted(e['seedChannel'].items()):
        same(where, 'seedChannel.' + ch, hash_seed(root + ':' + ch), want)
    same(where, 'legacy32Seed', hash_seed(root + ':' + ':'.join(segments)), e['legacy32Seed'])
    nxt = mulberry32(e['legacy32Seed'])
    same(where, 'legacy32', [int(nxt() * 4294967296) for _ in e['legacy32']], e['legacy32'])
print(json.dumps({'entries': len(entries), 'checks': checks, 'bad': bad}))
`;
const r = spawnSync('python3', ['-B', '-c', script, CORE, VECTORS], { encoding: 'utf8' });
if (r.status !== 0) { console.error(`FAIL: the Python port did not run\n${r.stderr}`); process.exit(1); }
const result = JSON.parse(r.stdout.trim().split('\n').pop());
if (!result.entries) { console.error('FAIL: the vectors hold no entries'); process.exit(1); }
if (result.bad.length) {
  for (const b of result.bad) console.error('  ' + b);
  console.error(`FAIL: ${result.bad.length} of ${result.checks} checks disagree`);
  process.exit(1);
}
console.log(`  ok   Python ${probe.stdout.trim()}: grammar_core.py hash_seed and mulberry32 agree with the kernel's legacy32 vectors (${result.entries} entries, ${result.checks} checks)`);
