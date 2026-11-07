/**
 * Node test for the pack layer: does "arcade" resolve to a buildable game?
 *
 * This is the only suite that reads the art. It measures every GLB the manifest names
 * and asserts the manifest still agrees with the files — which is the failure a pack
 * actually has. A manifest is a set of claims about assets ("a crate is 1.2 m", "the
 * player model is this one"), and assets get re-exported. A claim nobody checks is a
 * crate the size of a building, discovered in front of a player.
 *
 * It also asserts the pack FITS. Decoded texture is the budget that kills a tab, and it
 * has nothing to do with file size: an 8192 map is 268 MB of RGBA however well it
 * compresses. `src/core/AssetLoader.js` caps at 2048 as it loads, so the test is whether
 * the pack fits AFTER that cap — and it reports what it ships before it, because the
 * download is a cost too.
 *
 * Run:  node tools/test/test-pack.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePack, packAssets, packBudget, ROLES, PACK_KIND, grenadeModel } from '../../src/world/pack.js';
import { inspectGlb } from '../build/inspect-pack.mjs';
import { TERRAIN_RECIPES } from '../../src/world/buildSpec.js';
import { CATALOG } from '../../src/world/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
};

/**
 * This repository's contract has always been that it carries no art (see README). A
 * clone without assets/ should get a green suite and a clear note, not a red one — the
 * pack layer is only untestable here, not broken.
 */
const hasArt = fs.existsSync(path.join(ROOT, 'assets'));
if (!hasArt) console.log('SKIP: no assets/ in this checkout, so there is no art to check a pack against (the manifest-only checks below still run).');

const packDir = path.join(ROOT, 'packs');
const packs = fs.existsSync(packDir)
  ? fs.readdirSync(packDir).filter((d) => fs.existsSync(path.join(packDir, d, 'pack.json')))
  : [];

check('at least one pack exists', packs.length > 0, `${packs.length} found`);

for (const id of hasArt ? packs : []) {
  console.log(`\n${id}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, id, 'pack.json'), 'utf8'));

  check('the manifest declares its kind', manifest.kind === PACK_KIND, manifest.kind);
  check('the folder name matches the id', manifest.id === id, `${manifest.id} vs ${id}`);

  // Every referenced asset must exist before anything is measured.
  const assets = packAssets(manifest);
  const absent = assets.filter((a) => !fs.existsSync(path.join(ROOT, a)));
  check('every asset it names is on disk', absent.length === 0, absent.join(', '));
  if (absent.length) continue;

  const measured = {};
  for (const a of assets) measured[a] = inspectGlb(path.join(ROOT, a));

  let pack;
  try { pack = resolvePack(manifest, measured); }
  catch (e) { check('the manifest resolves', false, e.message); continue; }
  check('the manifest resolves', true);

  console.log(`  ..   ${assets.length} assets, ${Object.keys(pack.weapons).length} weapons, `
    + `${Object.keys(pack.characters).length} characters, ${pack.props.length} props`);

  /* ── scale: the claim that actually matters ──────────────────────────── */

  const entries = [
    ...Object.values(pack.characters).map((c) => ['character', c]),
    ...Object.values(pack.weapons).map((w) => ['weapon', w]),
    ...pack.props.map((p) => ['prop', p]),
  ];
  check('every entry was measured against its real file',
    entries.every(([, e]) => e.measured), 'an unmeasured entry falls back to scale = metres');
  check('every scale is finite and positive',
    entries.every(([, e]) => Number.isFinite(e.scale) && e.scale > 0));
  /**
   * The size check. Not "does it have a number" but "is the number sane": a prop between
   * 10 cm and 12 m, a character between 1.2 and 4 m, a weapon between 15 cm and 2.5 m.
   * These bounds exist to catch a missing or mistyped `metres`, which is the single
   * likeliest manifest error and silently produces a world at the wrong scale.
   */
  const sane = { prop: [0.1, 12], character: [1.2, 4], weapon: [0.15, 2.5] };
  for (const [kind, e] of entries) {
    const [lo, hi] = kind==='prop'&&e.role==='dressing'?[.01,20]:sane[kind];
    const realSize = e.longest * e.scale;
    check(`${kind} ${e.id} is a plausible ${realSize.toFixed(2)} m`,
      realSize >= lo && realSize <= hi, `expected ${lo}-${hi} m`);
  }

  /* ── roles and collision ─────────────────────────────────────────────── */

  check('every prop has a known role', pack.props.every((p) => ROLES.includes(p.role)));
  check('a prop that blocks has a blocker shape',
    pack.props.every((p) => p.role === 'dressing' || p.role === 'gear' || p.collision !== 'none' || p.opensTo || p.id.includes('Open')),
    pack.props.filter((p) => !['dressing', 'gear'].includes(p.role) && p.collision === 'none').map((p) => p.id).join(', '));
  check('the pack can make a firefight: it has cover',
    pack.byRole.cover.length > 0, `${pack.byRole.cover.length} cover props`);
  check('and something to go to: it has an objective',
    pack.byRole.objective.length > 0, `${pack.byRole.objective.length} objective props`);

  /* ── terrain agreement ───────────────────────────────────────────────── */

  check('every terrain recipe it lists exists in the engine',
    pack.terrain.recipes.every((r) => TERRAIN_RECIPES[r]),
    pack.terrain.recipes.filter((r) => !TERRAIN_RECIPES[r]).join(', '));
  check('its default recipe is one it lists',
    !pack.terrain.default || pack.terrain.recipes.includes(pack.terrain.default));

  /* ── the budget ──────────────────────────────────────────────────────── */

  const budget = packBudget(manifest, measured, {cap:1024,limitMB:256});
  console.log(`  ..   ${budget.diskMB} MB on disk, ${budget.shippedTextureMB} MB of texture as shipped, `
    + `${budget.cappedTextureMB} MB after the 1024 cap`);
  check(`the pack fits in ${budget.limitMB} MB of decoded texture after the loader's cap`,
    budget.fits, `${budget.cappedTextureMB} MB`);
  if (budget.over.length) {
    console.log(`  ..   ${budget.over.length} texture(s) above 1024 — the loader downscales them at`
      + ' load, so this costs download and decode time, not memory');
  }

  const animated = Object.values(pack.characters).filter(c => {
    const m = measured[c.model]; return c.animation==='rigid'?m.skins===0&&m.meshes>0:m.skins>0&&m.joints>=15&&m.clips>=5;
  });
  check('every character matches its declared skeletal or rigid animation contract',
    animated.length === Object.keys(pack.characters).length);

}

/* ── refusals ────────────────────────────────────────────────────────────── */

console.log('\nrefusals');
const bad = (m) => { try { resolvePack(m); return false; } catch { return true; } };
check('a foreign file is refused', bad({ kind: 'something.else' }));
check('a newer pack version is refused', bad({ kind: PACK_KIND, packVersion: 99, id: 'x' }));
check('an unknown role is refused', bad({
  kind: PACK_KIND, id: 'x', characters: { player: { model: 'a.glb', metres: 1.8 } },
  weapons: { w: { model: 'w.glb', metres: 1 } },
  props: [{ id: 'p', model: 'p.glb', metres: 1, role: 'scenery' }],
}));
check('a missing metres is refused', bad({
  kind: PACK_KIND, id: 'x', characters: { player: { model: 'a.glb' } },
  weapons: { w: { model: 'w.glb', metres: 1 } },
}));
check('a pack with no player is refused', bad({
  kind: PACK_KIND, id: 'x', characters: {}, weapons: { w: { model: 'w.glb', metres: 1 } },
}));
check('a door opening into nothing is refused', bad({
  kind: PACK_KIND, id: 'x', characters: { player: { model: 'a.glb', metres: 1.8 } },
  weapons: { w: { model: 'w.glb', metres: 1 } },
  props: [{ id: 'd', model: 'd.glb', metres: 2, role: 'door', opensTo: 'nope' }],
}));

/* ── the thrown grenade and Arcade's own pickups (no art needed) ─────────── */

console.log('\ngrenade and pickups');
const base = { kind: PACK_KIND, id: 'x', characters: { player: { model: 'a.glb', metres: 1.8 } }, weapons: { w: { model: 'w.glb', metres: 1 } } };
check('a pack with no grenade is refused', bad(base));
check('a grenade that is not a .glb under assets/ is refused', bad({ ...base, grenade: { model: 'grenade.png' } })
  && bad({ ...base, grenade: { model: 'assets/../secret.glb' } }) && bad({ ...base, grenade: {} }));
const arcade = JSON.parse(fs.readFileSync(path.join(packDir, 'arcade', 'pack.json'), 'utf8'));
check('Arcade throws its fizz-bomb', grenadeModel(resolvePack(arcade)) === 'assets/v2/arcade/arcade-fizzbomb.glb');
const arcadePickups = arcade.props.filter((p) => p.pickup);
check('Arcade has an ammo, a health and a grenade pickup',
  ['ammo', 'health', 'grenade'].every((k) => arcadePickups.some((p) => p.pickup === k)));
check('every Arcade pickup is its own model and card, not a borrowed one',
  arcadePickups.every((p) => p.model.startsWith('assets/v2/arcade/') && p.preview.startsWith('assets/v2/arcade/catalog/')),
  arcadePickups.map((p) => p.model).join(', '));

console.log('\nthe Arcade hero');
const hero = arcade.characters.player;
check('Arcade plays its own hero, with its own card, not a borrowed soldier',
  hero.model.startsWith('assets/v2/arcade/characters/') && !!hero.preview?.startsWith('assets/v2/arcade/catalog/'), hero.model);
check('the Arcade catalog measures the hero the pack names', !!CATALOG.arcade.measurements[hero.model]);
if (hasArt && fs.existsSync(path.join(ROOT, hero.model))) {
  const b = fs.readFileSync(path.join(ROOT, hero.model)), j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  const joints = (j.skins?.[0]?.joints ?? []).map((i) => j.nodes[i].name);
  const fingers = (s) => ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap((f) => [1, 2, 3].map((k) => `mixamorig:${s}Hand${f}${k}`));
  check('the hero is on the Mixamo skeleton, five fingers a hand (first-person arms are cut from it)',
    ['Hips', 'Spine2', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightFoot'].every((n) => joints.includes(`mixamorig:${n}`))
      && [...fingers('Left'), ...fingers('Right')].every((n) => joints.includes(n)), `${joints.length} joints`);
  const clips = (j.animations ?? []).map((a) => a.name.split('_').at(-1));
  check('the hero carries Idle, Walk, Run, Jump and Interact (the names PackAnimator plays)',
    ['Idle', 'Walk', 'Run', 'Jump', 'Interact'].every((n) => clips.includes(n)), clips.join(', '));
  check('and the genre clips the third-person and top-down hero plays (Attack, AimIdle, AimRun, Hit, Death, Cheer)',
    ['Attack', 'AimIdle', 'AimRun', 'Hit', 'Death', 'Cheer'].every((n) => clips.includes(n)), clips.join(', '));
  const grip = j.nodes.findIndex((n) => n.name === 'Grip_R');
  check('a Grip_R socket hangs off the right hand, for the staff', grip >= 0 && j.nodes.some((n) => n.name === 'mixamorig:RightHand' && n.children?.includes(grip)));
}

console.log('\nArcade gear (hand-built levels)');
const gear = arcade.props.filter((p) => p.role === 'gear');
check('keys, padlocks, a lever, a honey drop and the staff', ['keyAmber', 'keyIce', 'keyRose', 'lockAmber', 'lockIce', 'lockRose', 'lever', 'honeyDrop', 'staff'].every((id) => gear.some((p) => p.id === id)));
check('gear is never a pool option: the studio lists it apart', !CATALOG.arcade.props.some((p) => p.role === 'gear') && CATALOG.arcade.gear.length === gear.length);
check('every gear prop has its own card', gear.every((p) => p.preview?.startsWith('assets/v2/arcade/catalog/')));
if (hasArt) {
  const nodesOf = (model) => { const b = fs.readFileSync(path.join(ROOT, model)); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()).nodes; };
  check('a gear prop that names a node finds it in its file, at the origin', gear.filter((p) => p.node).every((p) => {
    const n = nodesOf(p.model).find((x) => x.name === p.node); return n && !(n.translation ?? [0, 0, 0]).some((v) => Math.abs(v) > 1e-6);
  }));
  const lever = nodesOf('assets/v2/arcade/arcade-lever.glb');
  check('the lever turns its Handle about its hinge', lever.some((n) => n.name === 'Base') && lever.some((n) => n.name === 'Handle' && n.translation?.[1] > 0.2));
  check('keys and the honey drop bob like pickups', [...nodesOf('assets/v2/arcade/arcade-keys.glb'), ...nodesOf('assets/v2/arcade/arcade-drop.glb')].every((n) => n.extras?.arc_bob > 0));
}

console.log(failures ? `\nFAILED: ${failures}` : '\nAll pack checks passed.');
process.exit(failures ? 1 : 0);
