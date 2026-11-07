// Every suite of the reconstruction (src/atlas/), in one command.
//   node tools/test/atlas/run.mjs            all of them
//   node tools/test/atlas/run.mjs nbv rig    just those
//
// Each suite is a standalone `node` script that prints its own measurements and
// exits non-zero on a failure; this runs them as separate processes so one
// suite's globals, module cache or crash cannot affect another's result. The
// per-suite check counts are read from each suite's own summary line rather than
// kept in a table here, because a table here would be a second place to forget.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// `multiview.mjs`, `shapes.mjs` and `solids.mjs` are fixtures, not suites.
const SUITES = [
  ['acceptance',   'fields and mesh topology'],
  ['geometry3d',   'the SOLID, against closed form'],
  ['lens',         'EXIF in, or no lens at all'],
  ['rig',          'skeleton, skinning, and the GLB'],
  ['relight',      'albedo vs the studio light'],
  ['uncertainty',  'is σ a real predictive scale?'],
  ['certificate',  'can the certificate be trusted?'],
  ['nbv',          'where to stand for a better photo'],
  ['multiview3d',  'what a second view can measure'],
  ['smartmesh',    'a mesh sized by the evidence'],
  ['register',     'a reconstruction against independent truth'],
];

const only = process.argv.slice(2);
const chosen = only.length ? SUITES.filter(([n]) => only.includes(n)) : SUITES;
if (only.length && chosen.length !== only.length) {
  const known = SUITES.map(([n]) => n);
  console.error(`unknown suite: ${only.filter((o) => !known.includes(o)).join(', ')}`);
  console.error(`known: ${known.join(' ')}`);
  process.exit(2);
}

const run = (name) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(HERE, `${name}.mjs`)], { maxBuffer: 1 << 26 },
    (err, stdout, stderr) => {
      const m = /(\d+)\/(\d+) passed/.exec(stdout || '');
      resolve({
        name,
        code: err ? (err.code ?? 1) : 0,
        passed: m ? +m[1] : 0,
        total: m ? +m[2] : 0,
        // A suite that dies before printing a summary is a failure with no count,
        // and is reported as that rather than as zero checks quietly passing.
        summarised: !!m,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
});

let passed = 0, total = 0, failures = [], measured = [];
for (const [name, blurb] of chosen) {
  const r = await run(name);
  passed += r.passed; total += r.total;
  measured.push(r);
  const bad = r.code !== 0 || !r.summarised;
  if (bad) failures.push(r);
  console.log(`${bad ? 'FAIL' : 'ok  '}  ${name.padEnd(14)} ${String(r.summarised ? `${r.passed}/${r.total}` : 'no summary').padStart(9)}   ${blurb}`);
}

console.log(`\n${passed}/${total} checks across ${chosen.length} suites`);

if (failures.length) {
  for (const f of failures) {
    console.log(`\n──── ${f.name} ────`);
    // Only the failing lines and whatever went to stderr; a full replay of a
    // passing suite's output would bury them.
    const lines = f.stdout.split('\n').filter((l) => /^\s*(FAIL|NOT MET)/.test(l));
    for (const l of lines) console.log(l);
    if (f.stderr.trim()) console.log(f.stderr.trim().split('\n').slice(-20).join('\n'));
  }
  console.log(`\n${failures.length} suite(s) failed: ${failures.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
