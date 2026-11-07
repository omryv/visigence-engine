// The project file contract: envelope, format version, migration, size cap and
// field-named validation - and that the compiler reports shape errors by path.
import assert from 'node:assert/strict';
import {
  PROJECT_FILE_KIND, PROJECT_FILE_VERSION, MAX_PROJECT_BYTES, ProjectFormatError,
  validateProject, migrateProject, parseProjectText, packageProject,
} from '../../src/world/projectSchema.js';
import { resolveProject, resolveGame } from '../../src/world/shooterProject.js';
import { levelProject } from '../../src/world/level/game.js';
import { quickMission } from '../../src/world/missionCard.js';

const throwsAt = (fn, path, re) => {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught instanceof ProjectFormatError, `expected a ProjectFormatError${caught ? `, got ${caught.name}: ${caught.message}` : ', nothing thrown'}`);
  assert.equal(caught.path, path, `path of "${caught.message}"`);
  if (re) assert.match(caught.message, re);
};

// A real project round-trips through the envelope untouched.
const project = resolveProject(quickMission('arcade'));
const packaged = packageProject(project);
assert.equal(packaged.kind, PROJECT_FILE_KIND); assert.equal(packaged.version, PROJECT_FILE_VERSION);
const reopened = parseProjectText(JSON.stringify(packaged), { requireEnvelope: true });
assert.deepEqual(reopened.project, project); assert.equal(reopened.migrated, false); assert.deepEqual(reopened.warnings, []);
assert.deepEqual(resolveProject(reopened.project), project, 'resolving the reopened file changes nothing');

// A bare project (localStorage, a mission link) needs no envelope and is read as current.
assert.equal(parseProjectText(JSON.stringify(project)).from, null);
throwsAt(() => parseProjectText(JSON.stringify(project), { requireEnvelope: true }), 'kind', /not a Visigames project file/);

// The launch-era document migrates through every format, and says so: format 4 makes its mission a game's only level.
const legacy = parseProjectText(JSON.stringify({ kind: 'vsight.project', version: 1, ...project }), { requireEnvelope: true });
assert.equal(legacy.from, 1); assert.equal(legacy.migrated, true);
assert.equal(legacy.project.levels.length, 1); assert.equal(legacy.project.levels[0].seed, project.seed);
assert.deepEqual(resolveProject(levelProject(legacy.project, 0)), project, 'the migrated game\'s level compiles the same mission');
assert.equal(migrateProject({ kind: 'vsight.project', version: 1, theme: 'arcade' }).project.theme, 'arcade');
// A format-3 file (one mission, no levels) opens as a one-level game with its mission untouched.
const v3 = parseProjectText(JSON.stringify({ kind: PROJECT_FILE_KIND, version: 3, ...project }), { requireEnvelope: true });
assert.equal(v3.from, 3); assert.deepEqual(resolveGame(v3.project).levels[0].blueprint, project.blueprint);
assert.equal(resolveGame(v3.project).levels[0].id, 'l1');
assert.deepEqual(resolveGame(v3.project).publish, { adBreaks: false, rewardedContinue: false, showCredits: true });
// A game round-trips through its envelope.
const game = resolveGame({ ...project, levels: [{ id: 'l1', name: 'Meadow', ...Object.fromEntries(['seed', 'blueprint'].map(k => [k, project[k]])) }, { id: 'l2', name: 'Oasis', seed: 'OASI-S222-2222', blueprint: project.blueprint }] });
const regame = parseProjectText(JSON.stringify(packageProject(game)), { requireEnvelope: true });
assert.deepEqual(resolveGame(regame.project), game); assert.equal(game.levels[1].seed, 'OASI-S222-2222'); assert.equal(game.levels[1].name, 'Oasis');
// Level fields are shape-checked by path, and a level's meaning errors name the level.
assert.ok(validateProject({ levels: [{ id: 'l1', seed: {} }] }).errors.some(e => e.path === 'levels[0].seed'));
assert.ok(validateProject({ levels: [] }).errors.some(e => e.path === 'levels'));
assert.ok(validateProject({ edits: { entities: [{ id: 'e1', type: 'enemy', x: 'far' }] } }).errors.some(e => e.path === 'edits.entities[0].x'));
throwsAt(() => resolveGame({ ...project, levels: [{ id: 'l1', enemyCount: 99 }] }), 'levels[0]', /enemyCount must be/);

// The future is refused rather than guessed at; other documents are named as such.
throwsAt(() => migrateProject({ kind: PROJECT_FILE_KIND, version: PROJECT_FILE_VERSION + 1 }), 'version', /newer than this build/);
throwsAt(() => migrateProject({ kind: PROJECT_FILE_KIND, version: 'two' }), 'version', /format version/);
throwsAt(() => migrateProject({ kind: 'visigames.pack', version: 2 }), 'kind', /not a Visigames project/);

// Size cap and bad JSON, before any parsing of content.
throwsAt(() => parseProjectText(' '.repeat(MAX_PROJECT_BYTES + 1)), '', /the limit is 512 KB/);
throwsAt(() => parseProjectText('{"theme": '), '', /not valid JSON/);
throwsAt(() => parseProjectText('[1,2]'), '', /expected a project object, got array/);

// Every shape error is reported at once, by path.
const bad = {
  ...project, name: 42, enemyCount: 'many', missionProfile: null, extraneous: true,
  blueprint: { version: 1, nodes: [{ id: 'world', kind: 'world', items: ['a'] }, { id: 'bad id!', kind: 'nowhere' }, { id: 'world', kind: 'objective', objective: 'dance' }], edges: [{ from: 'world', out: 'world', to: 'generator' }] },
  importedProps: [{ id: 'nope', size: [1, 2], scale: 'x', collision: 'sphere', triangles: 1.5, bytes: 100, creator: '', license: 'CC0', rightsConfirmed: false }],
  presentation: { accent: 'red', artwork: { id: 'x', mime: 'image/gif', bytes: 1, width: 1, height: 1, rightsConfirmed: true } },
};
const { errors, warnings } = validateProject(bad);
const paths = errors.map(e => e.path);
for (const p of ['name', 'enemyCount', 'blueprint.nodes[1].id', 'blueprint.nodes[1].kind', 'blueprint.nodes[2].id', 'blueprint.nodes[2].objective',
  'blueprint.edges[0].input', 'importedProps[0].id', 'importedProps[0].size', 'importedProps[0].scale', 'importedProps[0].collision',
  'importedProps[0].triangles', 'importedProps[0].creator', 'importedProps[0].rightsConfirmed', 'presentation.accent', 'presentation.artwork.id', 'presentation.artwork.mime']) {
  assert.ok(paths.includes(p), `expected an error at ${p}; got ${paths.join(', ')}`);
}
assert.ok(!paths.includes('missionProfile'), 'an explicit null missionProfile is allowed');
assert.deepEqual(warnings, [{ path: 'extraneous', message: 'unknown field, ignored' }]);
assert.equal(errors.find(e => e.path === 'blueprint.nodes[2].id').message, 'duplicate node id "world"');

// The compiler refuses by path, and its own semantic checks still follow the shape check.
throwsAt(() => resolveProject({ theme: 'arcade', blueprint: { version: 2, nodes: [], edges: [] } }), 'blueprint.version', /this build reads 1/);
throwsAt(() => resolveProject({ enemyCount: { n: 3 } }), 'enemyCount', /expected a number, got object/);
assert.throws(() => resolveProject({ theme: 'western' }), /Unsupported theme: western/);
assert.equal(resolveProject({ enemyCount: '4' }).enemyCount, 4, 'form inputs may still arrive as numeric strings');
assert.equal(resolveProject({ frameRate: '30' }).frameRate, 30);

// Envelope keys on the way in are not treated as project fields.
assert.equal(resolveProject(packageProject(project)).theme, project.theme);

console.log('Project envelope, migration from formats 1 and 3 to a game of levels, refusal of newer formats, size cap, path-named shape errors and compiler integration passed');
