/** Build a real standalone QA artifact with prop transforms and branded PNG images. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {exportGame} from '../../editor/exportGame.js';
import {quickMission} from '../../src/world/missionCard.js';
import {inspectGLB} from '../../editor/assetImport.js';
import {inspectArtwork} from '../../editor/creatorTools.js';
import {resolveProject} from '../../src/world/shooterProject.js';
import '../build/game-manifest.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),ab=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const glb=fs.readFileSync('assets/studio/import-demo.glb'),png=fs.readFileSync('assets/v2/arcade/arcade-lookdev-review.png'),geometry=inspectGLB(ab(glb)),art=inspectArtwork(ab(png));
const prop={id:hash(glb),name:'QA supply case',size:[1.3,.95,.9],scale:.8,transform:{x:4,z:23,yaw:Math.PI/2},collision:'box',creator:'Visigence',license:'CC0-1.0',source:'Original Blender geometry',rightsConfirmed:true,triangles:geometry.triangles,bytes:glb.length};
const image={...art,id:hash(png),creator:'Visigence',license:'Project artwork',source:'Studio artwork',rightsConfirmed:true};
const project=resolveProject({...quickMission('arcade'),importedProps:[prop],presentation:{studioName:'Creator QA',accent:'#dcaa6b',artwork:image,logo:image}}),blobs=new Map([[prop.id,new Blob([glb])],[image.id,new Blob([png])]]);
const savedFetch=globalThis.fetch;
// The studio's files from this repository, as serve.py serves them.
const local=pathname=>'.'+pathname;
globalThis.fetch=async url=>new Response(fs.readFileSync(local(new URL(url,'http://localhost').pathname)));
globalThis.indexedDB={open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(){const tx={objectStore:()=>({get:id=>{const r={result:blobs.get(id)};queueMicrotask(()=>tx.oncomplete());return r;}})};return tx;}};request.onsuccess();});return request;}};
const out='/tmp/visigames-polish-export';fs.mkdirSync(out,{recursive:true});
try{const zip=await exportGame(project);fs.writeFileSync(out+'/game.zip',new Uint8Array(await zip.arrayBuffer()));const r=spawnSync('python3',['-c',`import zipfile,json,hashlib,sys\nz=zipfile.ZipFile(sys.argv[1]);names=z.namelist();assert len(names)==len(set(names));assert z.testzip() is None\np=json.loads(z.read('project.visigames.json'));assert p['presentation']['studioName']=='Creator QA'\nfor a in [*p['importedProps'],p['presentation']['artwork'],p['presentation']['logo']]:assert hashlib.sha256(z.read(a['model'])).hexdigest()==a['id']\nassert p['importedProps'][0]['transform']['yaw']>1.5\nassert 'assets/studio/mission-beacon.glb' in names\nassert 'CC0-1.0' in z.read('MISSION-ASSET-CREDITS.txt').decode()\nassert 'Studio artwork' in z.read('IMPORTED-ASSET-CREDITS.txt').decode()\nz.extractall(sys.argv[2])`,out+'/game.zip',out+'/game'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);console.log('Verified standalone fixture: '+out+'/game/index.html');}finally{globalThis.fetch=savedFetch;delete globalThis.indexedDB;}
