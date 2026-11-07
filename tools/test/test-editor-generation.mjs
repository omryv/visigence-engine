import { assetURL } from '../../src/config/assetDelivery.js';
/** Exercise real editor event routing with a fake DOM and a counted runtime boundary. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { MISSION_THEMES, MISSION_WORLDS, missionWorld, THEME_PALETTE } from '../../src/world/missionCard.js';
import { generationKey } from '../../editor/draft.js';
import { CATALOG } from '../../src/world/catalog.js';
import * as blueprint from '../../src/world/blueprint.js';
import * as projectAPI from '../../src/world/shooterProject.js';
import * as projectSchema from '../../src/world/projectSchema.js';
import * as genres from '../../src/genres/registry.js';
const source=(await readFile(new URL('../../editor/studio.js',import.meta.url),'utf8'))
 .replace(/^import .*;\n/gm,'')
 .replace("await import('../src/game/ShooterSession.js')",'await loadSession()');
function harness(standalone=false) {
 const elements=new Map(), counters={initialized:0,builds:0,frames:0,imports:0};let finishBuild;
 const element=selector=>{
  if(!elements.has(selector))elements.set(selector,{
   value:'1',dataset:{},style:{setProperty(){}},handlers:{},classList:{add(){},remove(){},toggle(){}},
   addEventListener(event,fn){this.handlers[event]=fn;},querySelectorAll(){return [];},querySelector(){return null;},
   focus(){},click(){return this.handlers.click?.({target:this});},setAttribute(){},
  });return elements.get(selector);
 };
 const compiled=projectAPI.resolveProject({theme:'arcade'});
 element('#compiled-project').textContent=JSON.stringify(compiled);
 class Session {
  constructor(canvas){this.canvas=canvas;}
  async initialize(){counters.initialized++;}
  async build(project){counters.builds++;if(counters.defer)await new Promise(r=>finishBuild=r);this.project=structuredClone(project);this.game={};this.level={worldKit:{label:'Generated '+project.theme},blueprint:blueprint.compileBlueprint(project.blueprint,CATALOG[project.theme])};}
  stop(){} setRendering(active){counters.rendering=active;} resize(){} frame(){counters.frames++;} dispose(){} start(){}
 }
 const context=vm.createContext({
  ...blueprint,...projectAPI,...projectSchema,...genres,CATALOG,generationKey,assetURL,structuredClone,console,performance,MISSION_THEMES,MISSION_WORLDS,missionWorld,THEME_PALETTE,visionFromURL:()=>null,arriveWithVision:()=>{},missionFromEditor:()=>null,mountPlayerFront:()=>null,worldArt:()=>null,installModelCards:()=>{},
  escapeHtml:String,BlueprintBoard:class{render(){}fit(){}},
  document:{body:{classList:{add(){},remove(){}},dataset:{build:standalone?'standalone':''}},querySelector:element,querySelectorAll:s=>s==='.compile'?[element('#compile-top'),element('#compile-bottom')]:[],addEventListener(){}},
  window:{addEventListener(){}},ResizeObserver:class{observe(){}},localStorage:{getItem(){return null;},setItem(){}},
  setTimeout(){return 1;},clearTimeout(){},matchMedia:()=>({matches:false}),
  loadSession:async()=>{counters.imports++;return {ShooterSession:Session};},
 });
 vm.runInContext(source,context);
 return {element,counters,run:code=>vm.runInContext(code,context),finish:()=>finishBuild()};
}
const h=harness();
assert.equal(h.counters.imports,0,'opening the editor must not even import the renderer');
assert.equal(h.run('project.blueprint.nodes.length'),0);
assert.equal(h.run('project.blueprint.edges.length'),0);
h.run("addNode('generator');addNode('world');addNode('objective','reach');addNode('output')");
assert.equal(h.run('project.blueprint.edges.length'),0,'new nodes never auto-connect');
h.run("change({lighting:'dawn'});change({palette:'amber'});change({quality:'balanced'});addNode('objective','waves')");
h.element('#undo').click();h.element('#redo').click();
const imported={kind:'visigames.project',version:2,...projectAPI.resolveProject({theme:'arcade'})};
await h.element('#project-file').handlers.change({target:{files:[{size:100,text:async()=>JSON.stringify(imported)}]}});
assert.equal(h.counters.builds,0,'options, graph edits, undo/redo and importing only change the draft');
assert.equal(h.counters.imports,0);
// Explicit generation snapshots the current draft; repeated clicks and edits do not enqueue.
h.counters.defer=true;
const build=h.element('#compile-top').click();
await new Promise(resolve=>setImmediate(resolve));
assert.equal(h.counters.builds,1);
h.element('#compile-bottom').click();h.run("change({palette:'violet'})");
h.finish();await build;h.counters.defer=false;
assert.equal(h.counters.builds,1);
assert.equal(h.counters.rendering,false,'a now-stale build stays paused');
assert.equal(h.element('#play-preview').disabled,true);
assert.match(h.element('#engine-status').textContent,/Changes pending/);
h.element('#play-preview').click();assert.equal(h.counters.builds,1,'Play never silently regenerates');
await h.element('#compile-top').click();assert.equal(h.counters.builds,2);
assert.equal(h.counters.rendering,true,'explicit Generate opens the completed game');
h.element('#close-preview').click();assert.equal(h.counters.rendering,false,'closing play stops rendering');
h.run("change({name:'Renamed'});change({blueprint:{...project.blueprint,nodes:project.blueprint.nodes.map(n=>({...n,x:n.x+20}))}})");
assert.equal(h.element('#play-preview').disabled,false,'title and board layout do not invalidate the game');
h.element('#play-preview').click();assert.equal(h.counters.builds,2);
// A broken connection is allowed as a draft, but cannot trigger resource allocation.
h.run("change({blueprint:{...project.blueprint,edges:[]}})");
await h.element('#compile-top').click();assert.equal(h.counters.builds,2);
assert.equal(h.element('#compile-top').disabled,true);
assert.equal(h.counters.rendering,false);
// Standalone exports still boot their packaged mission.
const standalone=harness(true);await standalone.run('buildChain');
assert.equal(standalone.counters.builds,1);assert.equal(standalone.counters.rendering,true);
console.log('Draft editing is lazy; explicit builds are serialized; stale previews pause; standalone exports boot their mission');
