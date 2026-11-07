import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { quickMission, missionKey, formatTime, challengeURL } from '../../src/world/missionCard.js';
import { normalizeImportedProps } from '../../src/world/importedProps.js';
import { inspectGLB } from '../../editor/assetImport.js';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { Game } from '../../src/game/Game.js';
const bytes=fs.readFileSync('assets/studio/import-demo.glb');const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const checked=inspectGLB(buffer);assert.equal(checked.triangles,1316);
const prop={id:createHash('sha256').update(bytes).digest('hex'),name:'Sample <case>',size:[1.3,.95,.9],scale:1,collision:'box',creator:'Visigames',source:'Original Blender geometry',license:'CC0-1.0',rightsConfirmed:true,triangles:checked.triangles,bytes:bytes.length};
for(const theme of ['arcade']){
 const p=resolveProject({...quickMission(theme),importedProps:[prop]});const pack=resolvePack(JSON.parse(fs.readFileSync(`packs/${theme}/pack.json`)),CATALOG[theme].measurements);
 const level=compileShooterProject(p,pack),again=compileShooterProject(p,pack);const placed=level.placements.find(p=>p.id==='import-0');assert.ok(placed);assert.equal(placed.model,`imports/${prop.id}.glb`);assert.deepEqual(placed,again.placements.find(p=>p.id==='import-0'));
 assert.equal(level.blueprint.mission[0].count,1);assert.equal(level.blueprint.mission.length,2);
 const game=new Game({level});assert.equal(game.collision.isFree(placed.x,placed.z,.3),false);game.dispose();
 const decorative=compileShooterProject({...p,importedProps:[{...prop,collision:'none'}]},pack);const dg=new Game({level:decorative});assert.equal(dg.collision.isFree(placed.x,placed.z,.3),true);dg.dispose();
 assert.equal(missionKey(p),missionKey({...p,quality:'performance'}));assert.notEqual(missionKey(p),missionKey({...p,difficulty:'hard'}));
}
assert.throws(()=>normalizeImportedProps([{...prop,id:'../../evil'}]));assert.throws(()=>normalizeImportedProps([{...prop,rightsConfirmed:false}]));assert.throws(()=>normalizeImportedProps([{...prop,scale:10}]));assert.throws(()=>normalizeImportedProps([{...prop,triangles:50001}]));assert.throws(()=>normalizeImportedProps([prop,prop]));assert.throws(()=>inspectGLB(new ArrayBuffer(50)));
function glb(json){const s=new TextEncoder().encode(JSON.stringify(json));const padded=Math.ceil(s.length/4)*4,b=new ArrayBuffer(20+padded),v=new DataView(b);v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,b.byteLength,true);v.setUint32(12,padded,true);v.setUint32(16,0x4e4f534a,true);new Uint8Array(b,20).fill(32);new Uint8Array(b,20,s.length).set(s);return b;}
assert.throws(()=>inspectGLB(glb({...checked.json,animations:[{}]})),/static props/);assert.throws(()=>inspectGLB(glb({...checked.json,buffers:[{uri:'https://example.com/secret'}]})),/Embed/);assert.throws(()=>inspectGLB(glb({...checked.json,extensionsUsed:['KHR_draco_mesh_compression']})),/uncompressed/);
const challenge=new URL(challengeURL(quickMission('arcade'),'https://example.com/?debug=1',83.4));assert.equal(challenge.searchParams.get('beat'),'83.400');assert.equal(challenge.searchParams.has('debug'),false);assert.deepEqual(JSON.parse(decodeURIComponent(escape(atob(challenge.searchParams.get('mission'))))),quickMission('arcade'));assert.throws(()=>challengeURL({...quickMission(),importedProps:[prop]},'https://example.com/'),/game ZIP/);
assert.equal(formatTime(59.999),'1:00.0');assert.equal(formatTime(92.3),'1:32.3');assert.equal(formatTime(null),'—');
console.log('Quick missions, deterministic imported placements, solid/decorative collision, record identity, budgets, rights and GLB rejection paths passed');
// An imported asset must be portable, with exact original bytes and creator credits.
const {exportGame}=await import('../../editor/exportGame.js');
const {mkdtempSync,writeFileSync,rmSync}=fs;const {tmpdir}=await import('node:os');const {spawnSync}=await import('node:child_process');const path=await import('node:path');
const scratch=mkdtempSync(path.join(tmpdir(),'visigames-import-export-'));
globalThis.indexedDB={open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(){const tx={objectStore:()=>({get:()=>{const r={result:new Blob([bytes])};queueMicrotask(()=>tx.oncomplete());return r;}})};return tx;}};request.onsuccess();});return request;}};
// The studio's files from this repository, as serve.py serves them.
const originalFetch=globalThis.fetch;globalThis.fetch=async url=>{const p=new URL(url,'http://localhost').pathname,file='.'+p;return new Response(fs.readFileSync(file));};
try{const p=resolveProject({...quickMission('arcade'),importedProps:[prop]});const zip=await exportGame(p);const file=path.join(scratch,'game.zip');writeFileSync(file,new Uint8Array(await zip.arrayBuffer()));const result=spawnSync('python3',['-c',`import zipfile,sys,json,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n p=json.loads(z.read('project.visigames.json'))['importedProps'][0]\n assert hashlib.sha256(z.read(p['model'])).hexdigest()==p['id']\n assert 'CC0-1.0' in z.read('IMPORTED-ASSET-CREDITS.txt').decode()\n assert 'Visigames' in z.read('IMPORTED-ASSET-CREDITS.txt').decode()\n assert 'assets/v2/arcade/arcade-lookdev-review.png' in z.namelist()\n assert z.testzip() is None`,file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);console.log('Imported asset ZIP preserves bytes, checksum, project metadata, theme artwork and credits');}finally{globalThis.fetch=originalFetch;delete globalThis.indexedDB;rmSync(scratch,{recursive:true,force:true});}

