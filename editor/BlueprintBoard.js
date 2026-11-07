import { CATALOG } from '../src/world/catalog.js';
import { assetURL } from '../src/config/assetDelivery.js';
import { NODE_KINDS,OBJECTIVE_KINDS,connectBlueprint,validateConnection } from '../src/world/blueprint.js';
export const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inputs=n=>n.kind==='generator'?['world','weapons','enemies','doors','props']:n.kind==='objective'?['start']:n.kind==='output'?['game','mission']:[];
const outputs=n=>n.kind==='generator'?['game','start']:n.kind==='objective'?['complete']:NODE_KINDS[n.kind].output?[NODE_KINDS[n.kind].output]:[];
const height=n=>n.kind==='generator'?225:128;
// Wires take their port's meaning: the playable game is the amber spine, mission flow is one yellow.
const WIRE={game:'#ec9a52',start:'#f3ce74',complete:'#f3ce74'};
// A missing card image is redrawn from `data-card-model` (editor/modelCards.js).
const thumb=(a,theme,n)=>`<img class="bp-thumb" data-card-model="${a?.model??''}" src="${assetURL(a?.preview??`assets/catalog/${theme}-${n.kind}-${n.items[0]}.png`)}" alt="Selected asset">`;
export class BlueprintBoard{
 constructor(element,{getProject,onChange,onSelect,onError}){
  Object.assign(this,{element,getProject,onChange,onSelect,onError});this.scale=.7;this.selected=null;this.pending=null;
  element.addEventListener('click',e=>{
   const port=e.target.closest('[data-port]');
   if(port){const p={id:port.dataset.id,port:port.dataset.port,dir:port.dataset.direction};
    if(!this.pending){this.pending=p;this.render();this.focusPort(p);return;}
    if(this.pending.id===p.id&&this.pending.port===p.port){this.pending=null;this.render();return;}
    const a=p.dir==='out'?p:this.pending,b=p.dir==='in'?p:this.pending;
    try{if(a.dir!=='out'||b.dir!=='in')throw Error('Choose an output port and a matching input port');this.onChange(connectBlueprint(this.getProject().blueprint,{from:a.id,out:a.port,to:b.id,input:b.port}));this.pending=null;}
    catch(error){this.onError(error.message);}this.render();return;
   }
   const edge=e.target.closest('[data-edge]');if(edge){this.disconnect(Number(edge.dataset.edge));return;}
   const node=e.target.closest('[data-bp-node]');if(node){this.selected=node.dataset.bpNode;this.onSelect(this.selected);this.render();}
  });
  // A port click re-renders the board, so Escape is heard on the document while a connection is pending.
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&this.pending){const p=this.pending;this.pending=null;this.render();this.focusPort(p);}});
  element.addEventListener('keydown',e=>{if(e.target.matches('[data-edge]')&&['Enter',' '].includes(e.key)){e.preventDefault();this.disconnect(Number(e.target.dataset.edge));}});
  element.addEventListener('pointerdown',e=>{
   const handle=e.target.closest('.bp-handle');if(!handle||e.target.closest('button')||e.button!==0)return;
   const node=handle.closest('[data-bp-node]'),id=node.dataset.bpNode,n=this.getProject().blueprint.nodes.find(n=>n.id===id);
   this.drag={id,x:e.clientX,y:e.clientY,ox:n.x,oy:n.y,px:n.x,py:n.y};handle.setPointerCapture(e.pointerId);
  });
  element.addEventListener('pointermove',e=>{if(!this.drag)return;const d=this.drag;d.px=Math.max(0,d.ox+(e.clientX-d.x)/this.scale);d.py=Math.max(0,d.oy+(e.clientY-d.y)/this.scale);const n=element.querySelector(`[data-bp-node="${d.id}"]`);n.style.left=d.px+'px';n.style.top=d.py+'px';});
  const finish=()=>{if(!this.drag)return;const d=this.drag;this.drag=null;if(Math.hypot(d.px-d.ox,d.py-d.oy)>3)this.onChange({...this.getProject().blueprint,nodes:this.getProject().blueprint.nodes.map(n=>n.id===d.id?{...n,x:d.px,y:d.py}:n)},false);else this.render();};
  element.addEventListener('pointerup',finish);element.addEventListener('pointercancel',finish);
 }
 focusPort(p){this.element.querySelector(`[data-id="${p.id}"][data-port="${p.port}"][data-direction="${p.dir}"]`)?.focus({preventScroll:true});}
 disconnect(i){this.onChange({...this.getProject().blueprint,edges:this.getProject().blueprint.edges.filter((_,index)=>index!==i)});}
 render(){
  const graph=this.getProject().blueprint;
  this.width=Math.max(1060,...graph.nodes.map(n=>n.x+230));this.height=Math.max(720,...graph.nodes.map(n=>n.y+height(n)+30));
  const point=(n,port,out)=>{const list=out?outputs(n):inputs(n);return {x:n.x+(out?196:0),y:n.y+55+list.indexOf(port)*28};};
  const edges=graph.edges.map((e,i)=>{
   const a=graph.nodes.find(n=>n.id===e.from),b=graph.nodes.find(n=>n.id===e.to);if(!a||!b)return '';
   const p=point(a,e.out,true),q=point(b,e.input,false),d=`M${p.x} ${p.y} C${p.x+65} ${p.y} ${q.x-65} ${q.y} ${q.x} ${q.y}`;
   return `<g role="button" tabindex="0" aria-label="Disconnect ${escapeHtml(a.id)} ${e.out} from ${escapeHtml(b.id)} ${e.input}" data-edge="${i}"><path class="bp-wire-hit" d="${d}"/><path class="bp-wire" stroke="${WIRE[e.out]??NODE_KINDS[a.kind].color}" d="${d}"/></g>`;
  }).join('');
  const nodes=graph.nodes.map(n=>{
   const def=NODE_KINDS[n.kind],label=n.kind==='objective'?OBJECTIVE_KINDS[n.objective].label:def.label;
   const valid=(p,out)=>{const q=this.pending;if(!q||q.dir===(out?'out':'in'))return false;const edge=out?{from:n.id,out:p,to:q.id,input:q.port}:{from:q.id,out:q.port,to:n.id,input:p};try{return !validateConnection(graph,edge);}catch{return false;}};
   const port=(p,out,i)=>`<button class="bp-port ${out?'out':'in'} ${this.pending?.id===n.id&&this.pending?.port===p?'pending':''} ${valid(p,out)?'valid':''}" data-id="${n.id}" data-direction="${out?'out':'in'}" data-port="${p}" style="top:${45+i*28}px" aria-label="${escapeHtml(label)} ${out?'output':'input'} ${p}"><i></i><span>${p==='start'?'start mission':p}</span></button>`;
   return `<article class="bp-node ${this.selected===n.id?'selected':''}" data-bp-node="${n.id}" style="--node-color:${def.color};left:${n.x}px;top:${n.y}px;height:${height(n)}px"><div class="bp-handle"><i></i><button class="bp-select" aria-label="Configure ${escapeHtml(label)}">${escapeHtml(label)}</button><span>⠿</span></div>${inputs(n).map((p,i)=>port(p,false,i)).join('')}${outputs(n).map((p,i)=>port(p,true,i)).join('')}${n.items?.length?thumb(CATALOG[this.getProject().theme][n.kind]?.find(a=>a.id===n.items[0]),this.getProject().theme,n):''}<div class="bp-summary">${n.items?`${n.items.length} selected assets`:n.kind==='objective'?`${n.count} ${n.objective==='waves'?'waves':'targets'} · ${n.duration}s`:n.kind==='generator'?'Seeded assembly · collision · encounters':'Compile connected game'}</div></article>`;
  }).join('');
  this.element.innerHTML=`${graph.nodes.length?'':'<div class="bp-empty"><h2>Build your game from zero</h2><p>Add a world generator, asset pools, mission steps and a playable output.</p><p>Connect their ports, then click Generate / Compile.</p></div>'}<svg class="bp-wires" width="${this.width}" height="${this.height}" aria-label="Blueprint connections">${edges}</svg>${nodes}`;
  this.element.style.width=this.width+'px';this.element.style.height=this.height+'px';
  document.querySelector('#graph-help').textContent=this.pending?'Select a matching port. Esc cancels.':'Connect ports · click a wire to disconnect · drag node headers';
  this.element.classList.toggle('connecting',!!this.pending);this.element.dataset.want=this.pending?.dir==='out'?'in':'out';
  this.fit();
 }
 // A fitted board sits centred in its viewport; narrow screens keep a legible floor and pan by scrolling instead.
 fit(){const area=this.element.parentElement;const zoom=Number(document.querySelector('#zoom').value);this.scale=Math.max(area.clientWidth<600?.5:.32,Math.min(area.clientWidth/this.width,area.clientHeight/this.height))*zoom;this.element.style.transform=`scale(${this.scale})`;this.element.style.transformOrigin='top left';this.element.style.left=Math.max(0,(area.clientWidth-this.width*this.scale)/2)+'px';this.element.style.top=Math.max(0,(area.clientHeight-this.height*this.scale)/2)+'px';area.classList.toggle('pans',this.width*this.scale>area.clientWidth+1);}
}
