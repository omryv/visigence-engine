import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportGame } from '../../editor/exportGame.js';
import { resolveProject, resolveGame } from '../../src/world/shooterProject.js';
import { templateGame } from '../../src/world/level/templates.js';
import { levelProject } from '../../src/world/level/game.js';
import { gameBundle } from '../../src/world/gameBundle.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import '../build/game-manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'visigames-export-'));
const originalFetch = globalThis.fetch;
let dropped=false;
globalThis.fetch = async url => {
  if(!dropped){dropped=true;throw new TypeError('Simulated interrupted asset connection');}
  // Served the way serve.py and dist/ serve it: the repository at the root.
  const pathname = new URL(url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + pathname);
  assert.ok(file.startsWith(root));
  try { return new Response(await readFile(file)); }
  catch { return new Response('Missing file', { status: 404 }); }
};
try {
  for (const theme of Object.keys(CATALOG)) {
    const project = resolveProject({ theme, name: '</script><script>unexpected()</script>' });
    const archive = await exportGame(project);
    const file = path.join(scratch, theme + '.zip');
    await writeFile(file, new Uint8Array(await archive.arrayBuffer()));
    const check = spawnSync('python3', ['-c', `
import json,re,sys,zipfile,posixpath
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None, 'CRC or ZIP records are corrupt'
 names=z.namelist();assert len([n for n in names if n.startswith('assets/audio/default/') and n.endswith('.mp3')])==21, 'Default sounds missing from export'
 assert len(names)==len(set(names)), 'Duplicate archive paths'
 project=json.loads(z.read('project.visigames.json'));theme=project['theme']
 html=z.read('index.html').decode();assert 'data-build="standalone"' in html
 embedded=re.search(r'id="compiled-project">(.*?)</script>',html).group(1)
 assert '</script>' not in embedded
 assert json.loads(embedded)['name']==project['name']
 pack=json.loads(z.read('packs/'+theme+'/pack.json'))
 for asset in list(pack['characters'].values())+list(pack['weapons'].values())+pack['props']:
  assert asset['model'] in names, asset['model']
 assert pack['grenade']['model'] in names, 'the thrown grenade ships with the game'
 assert 'vendor/three/examples/jsm/libs/basis/basis_transcoder.wasm' in names, 'KTX2 decoder missing'
 for name in names:
  if not name.endswith('.js'):continue
  code=z.read(name).decode()
  for match in re.findall(r'''(?:from\\s*|import\\s*\\()\s*['"](\\.[^'"]+)['"]''',code):
   # A URL, served from the root of an origin: every import lands on a file the game carries.
   target=posixpath.normpath(posixpath.join('/',posixpath.dirname(name),match)).lstrip('/')
   assert target in names, (name,target)
 assert json.loads(z.read('vercel.json'))['outputDirectory']=='.'
 print(theme+': independently verified ZIP, runtime imports, models and embedded project')
 if len(sys.argv)>2:z.extractall(sys.argv[2])
`, file, ...(process.argv.includes('--review') ? ['/private/tmp/visigames-export-review'] : [])], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    console.log(check.stdout.trim());
  }
  // A game of levels from the level editor: every level's world and the genre's gear ship, the game is embedded
  // whole, and the portal hooks stand before the game's modules.
  for (const id of ['trail-warden', 'honey-harvest']) {
    const game = { ...resolveGame(templateGame(id)), name: 'Cash $$ & </script>' };
    const worlds = [...new Set(game.levels.map((_, i) => resolveProject(levelProject(game, i)).blueprint.nodes.find(n => n.kind === 'world').items).flat())];
    const kits = worlds.map(w => CATALOG.arcade.world.find(k => k.id === w).model);
    const file = path.join(scratch, id + '.zip');
    await writeFile(file, new Uint8Array(await (await exportGame(game)).arrayBuffer()));
    const check = spawnSync('python3', ['-c', `
import json,re,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist();html=z.read('index.html').decode()
 embedded=json.loads(re.search(r'id="compiled-project">(.*?)</script>',html).group(1))
 assert embedded['name']=='Cash $$ & </script>', embedded['name']
 assert len(embedded['levels'])==3 and all('edits' in l for l in embedded['levels']), 'the whole game is embedded'
 assert json.loads(z.read('project.visigames.json'))['version']==4
 hooks=html.index('window.VisigameHooks = window.VisigameHooks ||');assert hooks<html.index('<script type="module"'), 'hooks before the modules'
 assert 'VisigameHooks' in z.read('README.txt').decode()
 for kit in json.loads(sys.argv[2]):assert kit in names, kit
 pack=json.loads(z.read('packs/arcade/pack.json'));ids=[p['id'] for p in pack['props']]
 for need in json.loads(sys.argv[3]):assert need in ids, need
 for p in pack['props']:assert p['model'] in names, p['model']
 assert 'editor/gameRun.js' in names, 'the game flow ships'
 if sys.argv[4]=='trail-warden':assert pack['weapons']=={}, 'a game that fires nothing ships no weapons'
 print(sys.argv[4]+': a whole game of '+str(len(embedded['levels']))+' levels, its worlds, gear and portal hooks')
`, file, JSON.stringify(kits), JSON.stringify(id === 'trail-warden' ? ['staff', 'fence', 'woodGate', 'keyAmber', 'lockAmber'] : ['honeyDrop', 'lever', 'keyRose', 'lockRose']), id], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    console.log(check.stdout.trim());
    // What shipped resolves in the session: a weaponless game's pack carries no weapons, and may.
    const shipped = gameBundle(game, JSON.parse(await readFile(path.join(root, 'packs/arcade/pack.json'), 'utf8'))).pack;
    if (id === 'trail-warden') {
      assert.throws(() => resolvePack(shipped, CATALOG.arcade.measurements), /has no weapons/);
      assert.equal(Object.keys(resolvePack(shipped, CATALOG.arcade.measurements, null, { weaponless: true }).weapons).length, 0);
    }
  }
  let attempts=0;
  globalThis.fetch=async()=>{attempts++;return new Response('Missing',{status:404});};
  await assert.rejects(exportGame(resolveProject()),/editor\/runtime-files.json \(HTTP 404\)/);
  assert.equal(attempts,1,'missing objects must fail immediately, not retry');
  attempts=0;globalThis.fetch=async()=>{attempts++;throw new TypeError('Offline');};
  await assert.rejects(exportGame(resolveProject()),/editor\/runtime-files.json.*connection/);
  assert.equal(attempts,3,'transport retries must be bounded');
} finally {
  globalThis.fetch = originalFetch;
  await rm(scratch, { recursive: true, force: true });
}
