import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CombatAudio } from '../../src/audio/CombatAudio.js';
import { DEFAULT_SOUNDS } from '../../src/config/defaultSounds.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
const param=()=>({value:0,setValueAtTime(v){this.value=v;},linearRampToValueAtTime(v){this.value=v;},exponentialRampToValueAtTime(v){this.value=v;},setTargetAtTime(v){this.value=v;},cancelScheduledValues(){}});
const node=()=>({connect(n){return n;},disconnect(){},gain:param()});
let contexts=0,decodes=0,fetches=0,closed=0;
const sources=[];
const ctx={state:'running',currentTime:0,destination:node(),resume:async()=>{},close:async()=>{closed++;},createGain:node,
 createDynamicsCompressor(){return {...node(),...Object.fromEntries(['threshold','knee','ratio','attack','release'].map(k=>[k,param()]))};},
 createBufferSource(){const n={...node(),playbackRate:param(),start(){},stop(){queueMicrotask(()=>n.onended?.());}};sources.push(n);return n;},
 decodeAudioData:async()=>{decodes++;return {duration:3};},
 createPanner:()=>({...node(),positionX:param(),positionY:param(),positionZ:param()})};
const a=new CombatAudio({contextFactory:()=>{contexts++;return ctx;},fetcher:async url=>{fetches++;assert(fs.existsSync('.'+new URL(url).pathname));return {ok:true,arrayBuffer:async()=>new ArrayBuffer(4)};}});
await a.preload();assert.equal(contexts,0,'generation fetches files without starting an audio device');
await Promise.all([a.resume(),a.resume()]);assert.equal(contexts,1);assert.equal(decodes,21);assert.equal(fetches,21);
a.startActionVoice('reload','pistolReload');a.startActionVoice('reload','pistolReload');assert.equal(a.voices.live.size,1);
assert.equal(a.voices.actions.get('reload').asset.file,DEFAULT_SOUNDS.pistolReload.file);
a.releaseActionVoice('reload');assert.equal(a.voices.actions.size,0);assert.equal(a.voices.live.size,1,'completed reload tail can finish');
a.startActionVoice('fire','weapon1Fire');a.startActionVoice('steps','steps');assert.equal(a.voices.actions.size,2);
a.pause();await Promise.resolve();assert.equal(a.voices.actions.size,0);assert.equal(a.voices.live.size,0);
a.playOneShot('weapon1Fire');assert.equal(sources.at(-1).loop,undefined,'a one-shot of loopable sound cannot loop forever');
a.setMuted(true);assert.equal(a.playOneShot('pistolFire'),null);a.setMuted(false);
for(let i=0;i<100;i++)a.playOneShot('pistolFire');assert(a.voices.live.size<=32,'overlap is bounded');
a.dispose();await Promise.resolve();assert.equal(closed,1);assert.equal(a.buffers.size,0);assert.equal(await a.resume(),false);
const b=new CombatAudio({contextFactory:()=>ctx,fetcher:async()=>({ok:false,status:404})});await b.preload();assert.equal(b.failures.length,21);await b.resume();assert.equal(b.playOneShot('pistolFire'),null);b.dispose();
console.log('21 shared files, one decode per file, gesture unlock, bounded voices, reload cancellation, pause/mute/dispose passed');

const {GameAudio}=await import('../../src/audio/GameAudio.js');
class V {constructor(x=0,z=0){this.x=x;this.z=z;} clone(){return new V(this.x,this.z);} copy(p){Object.assign(this,p);return this;}distanceTo(p){return Math.hypot(this.x-p.x,this.z-p.z);}}
const calls=[],sound={playOneShot:(...a)=>calls.push(a),startActionVoice:(...a)=>calls.push(a),stopActionVoice(){},setActionVoiceRate(){},play(){},pause(){}};
const g={tick:0,time:0,player:{position:new V(),health:100,grounded:true,alive:true},interactions:{holding:false},objectives:{targets:[]},supplies:{items:[]},enemies:{enemies:[{id:1,type:{asset:'slime'},alive:true,position:new V(2)}]}};
const bridge=new GameAudio(sound,g);g.tick=1;g.time=1;bridge.update();g.tick++;g.time=5;bridge.update();
const before=calls.length;bridge.update();assert.equal(calls.length,before,'no duplicate work between simulation ticks');
assert.equal(calls.length,0,'no creature voice bank exists');
// The Arcade pack overrides the default bank one sound at a time (packs/arcade/pack.json `sounds`): every
// override names a delivered R2 path, keeps its slot's bus, gain and spatial flag, and the untouched slots stay default.
{
  const source=JSON.parse(fs.readFileSync('packs/arcade/pack.json')),pack=resolvePack(source,CATALOG.arcade.measurements);
  assert.equal(Object.keys(pack.sounds).length,10,'ten Arcade sounds are replaced');
  const r=new CombatAudio({sounds:pack.sounds});
  for(const [id,over] of Object.entries(pack.sounds)){
    assert(DEFAULT_SOUNDS[id],`${id} is a default slot`);assert(over.file.startsWith('assets/v2/arcade-sounds/')&&over.file.endsWith('.mp3'),`${id} points at the Arcade sounds`);
    assert.equal(r.sounds[id].bus,DEFAULT_SOUNDS[id].bus);assert.equal(r.sounds[id].file,over.file);
  }
  for(const id of Object.keys(DEFAULT_SOUNDS))if(!pack.sounds[id])assert.equal(r.sounds[id].file,DEFAULT_SOUNDS[id].file,`${id} stays default`);
  r.dispose();
}
console.log('Game audio bridge and the Arcade sound overrides passed');
