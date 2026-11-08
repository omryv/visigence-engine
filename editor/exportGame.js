import { presentationFiles } from '../src/world/presentation.js';
import { assetURL } from '../src/config/assetDelivery.js';
import { gameBundle } from '../src/world/gameBundle.js';
import { resolveProject, resolveGame } from '../src/world/shooterProject.js';
import { isGame, levelProject } from '../src/world/level/game.js';
import { MISSION_THEMES, MISSION_WORLDS } from '../src/world/missionCard.js';
import { packageProject } from '../src/world/projectSchema.js';
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
const crc32 = data => { let c = 0xffffffff; for (const b of data) c = table[(c ^ b) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; };
/** ZIP store records, UTF-8 names, no dependency or server-side build service. */
export async function zipFiles(files) {
  const body = [], directory = []; let offset = 0, directorySize = 0;
  for (const [path, value] of files) {
    if(typeof requestAnimationFrame==='function')await new Promise(resolve=>requestAnimationFrame(resolve));
    const name = encoder.encode(path), data = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
    const crc = crc32(data), header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);
    h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,name.length,true);header.set(name,30);
    const record=new Uint8Array(46+name.length),r=new DataView(record.buffer);
    r.setUint32(0,0x02014b50,true);r.setUint16(4,20,true);r.setUint16(6,20,true);r.setUint16(8,0x800,true);r.setUint16(14,33,true);
    r.setUint32(16,crc,true);r.setUint32(20,data.length,true);r.setUint32(24,data.length,true);r.setUint16(28,name.length,true);r.setUint32(42,offset,true);record.set(name,46);
    body.push(header,data);directory.push(record);offset+=header.length+data.length;directorySize+=record.length;
  }
  const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,directorySize,true);e.setUint32(16,offset,true);
  return new Blob([...body,...directory,end],{type:'application/zip'});
}
/**
 * The game runtime's own page, which becomes the game's index.html: `game.html` (the root is the world editor), in a
 * checkout and the deployed build alike, or whatever page path the runtime was opened at.
 */
function studioPage() {
  if (typeof location === 'undefined') return 'game.html';
  const page = location.pathname.replace(/^\/+|\/+$/g, '');
  if (!page || page === 'index.html') return 'game.html';
  return page.endsWith('.html') ? page : `${page}.html`;
}
/**
 * Where a web portal's SDK plugs in (editor/gameRun.js): written into the exported page before the game's modules, so
 * a portal can replace it, or set window.VisigameHooks first.
 */
export const HOOKS_SCRIPT = `<script>
/*
 * Portal hooks. This game calls window.VisigameHooks at these moments; by default nothing happens and play goes on.
 * To connect a web portal's SDK, set window.VisigameHooks before this script, or edit it here.
 *
 *   adBreak(kind)  kind is 'between-levels' (before the next level, when the game has ad breaks) or 'rewarded' (a
 *                  continue after the last life, when the game offers one). Return a Promise that resolves when the
 *                  ad is over; for 'rewarded', resolve true when the player earned the reward.
 *   event(name, data)  'gameplayStart', 'gameplayStop', 'levelStart', 'levelComplete', 'gameOver', 'gameComplete'.
 */
window.VisigameHooks = window.VisigameHooks || {
  adBreak: function (kind) { return Promise.resolve(false); },
  event: function (name, data) {}
};
</script>`;
/**
 * The playable game as a ZIP: the runtime, the art its levels use and the game itself. `doc` is a game of levels
 * (format 4, from the level editor) or one flat mission (from Remix).
 */
export async function exportGame(doc, progress = () => {}) {
  const get = async path => {
    for(let attempt=0;attempt<3;attempt++){
      let r;
      try { r = await fetch(assetURL('/'+path), {cache:attempt?'reload':'default'}); }
      catch (cause) {
        if(attempt===2)throw new Error(`Export could not load ${path}. Check the connection and asset access.`, {cause});
      }
      if(r?.ok)return r;
      if(r&&(r.status<500||attempt===2))throw new Error(`Export could not load ${path} (HTTP ${r.status})`);
      await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));
    }
  };
  const game=isGame(doc)?resolveGame(doc):null, project=game?resolveProject(levelProject(game,0)):resolveProject(doc), shipped=game??project;
  const manifest = await (await get('editor/runtime-files.json')).json();
  const pack = await (await get(`packs/${project.theme}/pack.json`)).json();
  const bundle=gameBundle(shipped,pack);
  const paths=[...new Set([...manifest,...bundle.assets,...new Set([...Object.values(MISSION_THEMES),...Object.values(MISSION_WORLDS)].map(t=>t.art.replace(/^\//,''))),...['visigames-mark','asset-cube','shuffle','play'].map(n=>`assets/studio/${n}.svg`)])];
  const files=[];
  // Limit concurrent memory pressure and verify every response before producing an archive.
  for(let i=0;i<paths.length;i+=4){
    files.push(...await Promise.all(paths.slice(i,i+4).map(async path=>[path,await (await get(path)).arrayBuffer()])));
    progress(Math.min(i+4,paths.length),paths.length);
  }
  const customFiles=[...new Map([...project.importedProps,...presentationFiles(project)].map(a=>[a.model,a])).values()];
  if(customFiles.length){
    const {fileBytes}=await import('./localFiles.js');
    for(const asset of customFiles)files.push([asset.model,await(await fileBytes(asset)).arrayBuffer()]);
    files.push(['IMPORTED-ASSET-CREDITS.txt',customFiles.map(p=>`${p.name||'Mission identity image'}\nCreator: ${p.creator}\nSource: ${p.source||'Not supplied'}\nLicence: ${p.license}\nSHA-256: ${p.id}\nRedistribution permission declared by importer.\n`).join('\n')]);
  }
  files.push([`packs/${project.theme}/pack.json`,JSON.stringify(bundle.pack)]);
  // On the site the page loads its bundle (tools/build/bundle-pages.mjs); a downloaded game packs the unbundled
  // runtime, so it starts from the unbundled page the build keeps beside it. A checkout has only the one page.
  const html=await(await get('game.source.html').catch(()=>get(studioPage()))).text();
  // Replacer functions, so a "$" in a game's name is never read as a replacement pattern. The portal hooks stand
  // before the import map, ahead of every module a portal's SDK might need to precede.
  const embedded=`<script type="application/json" id="compiled-project">${JSON.stringify(shipped).replace(/</g,'\\u003c')}</script></head>`;
  files.push(['index.html',html.replace('<body',()=>'<body data-build="standalone"').replace('</head>',()=>embedded).replace('<script type="importmap">',()=>`${HOOKS_SCRIPT}\n  <script type="importmap">`)]);
  files.push(['project.visigames.json',JSON.stringify(packageProject(shipped),null,2)]);
  files.push(['vercel.json',JSON.stringify({framework:null,installCommand:'',buildCommand:'',outputDirectory:'.'})]);
  files.push(['README.txt','Visigames playable build\n\nServe this folder using a static HTTP server, or deploy its root on Vercel.\nLocal: python3 -m http.server 8099\nThen open http://localhost:8099\n\nControls: WASD move, E hold to interact, Shift sprint, Esc pause. Exploration: interact and reach waypoints. Shooter: click fire, right click aim, R reload, 1-9 select weapon, G grenade. Touch controls are included.\nThis build contains its runtime, models and project. It requires no generation service.\n\nWeb portals: index.html calls window.VisigameHooks for ad breaks (between levels, and a rewarded continue after the last life, when the game has them switched on) and for gameplay events. The comment above it in index.html explains how to connect a portal\'s SDK.\n']);
  return zipFiles(files);
}
