/** Typed, serializable authoring graph. Only connected sources enter the game build. */
export const OBJECTIVE_KINDS = {
  activate: { label: 'Activate controls', description: 'Hold to activate the selected control stations.' },
  override: { label: 'Override doors', description: 'Unlock physical doors to open a route.' },
  waves: { label: 'Survive waves', description: 'Clear successive encounters from your connected enemy pool.' },
  eliminate: { label: 'Eliminate hostiles', description: 'Clear the remaining encounter.' },
  boss: { label: 'Boss encounter', description: 'Defeat a heavy enemy from the selected roster.' },
  barricade: { label: 'Clear barricades', description: 'Destroy or force open blocking cover.' },
  reach: { label: 'Reach checkpoint', description: 'Move into the marked area.' },
  extract: { label: 'Extract', description: 'Return to the extraction zone to finish the mission.' },
  collect: { label: 'Collect honey', description: 'Gather the honey drops: the placed ones, or as many as the step lays along the lanes.' },
  survive: { label: 'Survive', description: 'Stay alive while the critters keep coming, for the step\u2019s time.' },
};
export const NODE_KINDS = {
  world: { label:'World options', output:'world', color:'#42d69c' },
  weapons: { label:'Weapon pool', output:'weapons', color:'#d8b782' },
  enemies: { label:'Enemy pool', output:'enemies', color:'#f57857' },
  doors: { label:'Door pool', output:'doors', color:'#af9aff' },
  props: { label:'Prop pool', output:'props', color:'#829fac' },
  generator: { label:'World generator', output:'game', color:'#ec9a52' },
  objective: { label:'Mission step', output:'flow', color:'#f3ce74' },
  output: { label:'Playable game', color:'#ec9a52' },
};
export function createEmptyBlueprint() { return {version:1,nodes:[],edges:[]}; }
export function createBlueprint(pools={}) {
  const kinds=['world','weapons','enemies','doors','props'];
  const nodes=kinds.map((kind,i)=>({id:kind,kind,x:25,y:25+i*133,items:[...(pools[kind]??[])]}));
  nodes.push({id:'generator',kind:'generator',x:290,y:170},{id:'output',kind:'output',x:825,y:190},
    {id:'activate',kind:'objective',objective:'activate',count:3,duration:3.4,x:560,y:70},
    {id:'extract',kind:'objective',objective:'extract',count:1,duration:1.5,x:560,y:265});
  const edges=kinds.map(kind=>({from:kind,out:kind,to:'generator',input:kind}));
  edges.push({from:'generator',out:'game',to:'output',input:'game'},
    {from:'generator',out:'start',to:'activate',input:'start'},
    {from:'activate',out:'complete',to:'extract',input:'start'},
    {from:'extract',out:'complete',to:'output',input:'mission'});
  return {version:1,nodes,edges};
}
function outputType(node,port){
  if(node.kind==='generator')return port==='start'?'flow':port==='game'?'game':null;
  if(node.kind==='objective')return port==='complete'?'flow':null;
  return NODE_KINDS[node.kind]?.output===port?port:null;
}
function inputType(node,port){
  if(node.kind==='generator')return ['world','weapons','enemies','doors','props'].includes(port)?port:null;
  if(node.kind==='objective')return port==='start'?'flow':null;
  if(node.kind==='output')return port==='mission'?'flow':port==='game'?'game':null;
  return null;
}
export function normalizeBlueprint(value) {
  if(!value||value.version!==1||!Array.isArray(value.nodes)||!Array.isArray(value.edges))throw Error('Unsupported blueprint');
  if(value.nodes.length>60||value.edges.length>120)throw Error('Blueprint exceeds 60 nodes or 120 connections');
  const ids=new Set();
  const nodes=value.nodes.map(n=>{
    if(!n||!NODE_KINDS[n.kind]||!/^[-a-zA-Z0-9_]{1,48}$/.test(n.id)||ids.has(n.id))throw Error('Invalid or duplicate blueprint node');
    ids.add(n.id);
    const result={id:n.id,kind:n.kind,x:Math.max(0,Math.min(4000,Number(n.x)||0)),y:Math.max(0,Math.min(4000,Number(n.y)||0))};
    if(['world','weapons','enemies','doors','props'].includes(n.kind)){
      if(!Array.isArray(n.items)||n.items.length>200||n.items.some(i=>typeof i!=='string'||i.length>80))throw Error('Invalid asset pool');
      result.items=[...new Set(n.items)];
    }
    if(n.kind==='objective'){
      if(!OBJECTIVE_KINDS[n.objective])throw Error('Unknown objective type');
      const maxCount=n.objective==='collect'?60:12,maxTime=n.objective==='survive'?300:120;
      Object.assign(result,{objective:n.objective,count:Math.max(1,Math.min(maxCount,Math.round(Number(n.count)||1))),duration:Math.max(.5,Math.min(maxTime,Number(n.duration)||3))});
    }
    return result;
  });
  const edges=value.edges.map(e=>({from:String(e.from),out:String(e.out),to:String(e.to),input:String(e.input)}));
  return {version:1,nodes,edges};
}
export function validateConnection(graph,edge){
  const from=graph.nodes.find(n=>n.id===edge.from),to=graph.nodes.find(n=>n.id===edge.to);
  if(!from||!to||from===to)return 'Choose two different nodes';
  const a=outputType(from,edge.out),b=inputType(to,edge.input);
  if(!a||a!==b)return 'These ports accept different kinds of data';
  if(graph.edges.some(e=>e.from===edge.from&&e.out===edge.out&&e.to===edge.to&&e.input===edge.input))return 'These ports are already connected';
  if((b==='flow'||b==='game')&&graph.edges.some(e=>e.to===edge.to&&e.input===edge.input))return 'Disconnect the existing input first';
  if(b==='flow'&&graph.edges.some(e=>e.from===edge.from&&e.out===edge.out))return 'A mission step has one next step; disconnect it first';
  const visit=(id,seen=new Set())=>id===edge.from||!seen.has(id)&&(seen.add(id),graph.edges.filter(e=>e.from===id).some(e=>visit(e.to,seen)));
  return visit(edge.to)?'This connection would create a cycle':null;
}
export function connectBlueprint(graph,edge){const error=validateConnection(graph,edge);if(error)throw Error(error);return {...graph,edges:[...graph.edges,edge]};}
/**
 * @param {object} value    the blueprint document
 * @param {object} catalog  the theme's catalogue
 * @param {{genre?: import('../genres/registry.js').Genre}} [o]  the project's genre decides which
 *   pools are required and which objectives its steps may use; absent means the shooter's rules
 */
export function compileBlueprint(value,catalog,{genre=null}={}) {
  const graph=normalizeBlueprint(value), errors=[], accepted={...graph,edges:[]};
  const requiredPools=genre?.requiredPools??['world','weapons'],allowedObjectives=genre?.objectives??Object.keys(OBJECTIVE_KINDS);
  for(const e of graph.edges){const error=validateConnection(accepted,e);if(error)errors.push(error);else accepted.edges.push(e);}
  const outputs=graph.nodes.filter(n=>n.kind==='output');
  if(outputs.length!==1)errors.push('Use exactly one playable output');
  const output=outputs[0],gameEdge=graph.edges.find(e=>e.to===output?.id&&e.input==='game');
  const generator=graph.nodes.find(n=>n.id===gameEdge?.from&&n.kind==='generator');
  if(!generator)errors.push('Connect a world generator to the playable output');
  const pools={};
  for(const kind of ['world','weapons','enemies','doors','props']){
    const sources=graph.edges.filter(e=>e.to===generator?.id&&e.input===kind).map(e=>graph.nodes.find(n=>n.id===e.from));
    pools[kind]=[...new Set(sources.flatMap(n=>n?.kind===kind?n.items:[]))];
    for(const id of pools[kind])if(!catalog[kind]?.some(a=>a.id===id))errors.push(`${id} is not in this category's ${kind} catalogue`);
  }
  if(requiredPools.includes('world')&&!pools.world.length)errors.push('Connect at least one world option');
  if(requiredPools.includes('weapons')&&!pools.weapons.length)errors.push('Connect at least one weapon');
  const mission=[],visited=new Set();let id=generator?.id,port='start';
  while(id&&!visited.has(id)){
    visited.add(id);const edge=graph.edges.find(e=>e.from===id&&e.out===port);
    if(!edge){errors.push('Connect the mission sequence through to the output');break;}
    const next=graph.nodes.find(n=>n.id===edge.to);
    if(next?.id===output?.id){if(edge.input!=='mission')errors.push('Mission must reach the output mission port');break;}
    if(next?.kind!=='objective'){errors.push('Mission flow must connect objective steps');break;}
    mission.push({...next});id=next.id;port='complete';
  }
  if(!mission.length)errors.push('Connect at least one objective');
  for(const n of mission)if(!allowedObjectives.includes(n.objective))errors.push(`${OBJECTIVE_KINDS[n.objective].label} is not a ${genre.label} step; this genre plays ${allowedObjectives.map(o=>OBJECTIVE_KINDS[o].label.toLowerCase()).join(', ')}`);
  if(mission.some(n=>['waves','boss','eliminate','survive'].includes(n.objective))&&!pools.enemies.length)errors.push('Combat objectives need a connected enemy pool');
  if(mission.some(n=>n.objective==='override')&&!pools.doors.length)errors.push('Door objectives need a connected door pool');
  if(mission.some(n=>n.objective==='barricade')&&!pools.props.some(id=>catalog.props.find(a=>a.id===id)?.role==='barricade'))errors.push('Barricade objectives need a barricade in the connected prop pool');
  if(mission.filter(n=>n.objective==='extract').length>1||mission.some((n,i)=>n.objective==='extract'&&i!==mission.length-1))errors.push('Extraction must be the final mission step');
  if(mission.some(n=>n.objective==='activate')&&!pools.props.some(id=>catalog.props.find(p=>p.id===id)?.role==='objective'))errors.push('Connect a control station in the prop pool for activation objectives');
  if(mission.some(n=>n.objective==='boss')&&!pools.enemies.some(id=>catalog.enemies.find(e=>e.id===id)?.boss))errors.push('Connect a heavy enemy for the boss encounter');
  if(mission.filter(n=>['activate','override','barricade','reach'].includes(n.objective)).reduce((s,n)=>s+(n.objective==='reach'?1:Math.min(n.count,4)),0)>12)errors.push('Use at most 12 interaction locations');
  if(errors.length)throw Error([...new Set(errors)].join('. '));
  return {pools,mission,graph};
}
