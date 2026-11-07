import { escapeHtml as esc } from './BlueprintBoard.js';
import { compileShooterProject } from '../src/world/shooterProject.js';
import { resolvePack } from '../src/world/pack.js';
import { CATALOG } from '../src/world/catalog.js';
import { footprint } from '../src/world/importedProps.js';
import { normalizePresentation, presentationFiles } from '../src/world/presentation.js';
import { localFile, fileBytes } from './localFiles.js';
import { localAssetURL, registerLocalAsset } from '../src/config/localAssets.js';
import { isPackagedGame } from '../src/config/assetDelivery.js';

export function presentationURL(asset){if(!asset)return null;return isPackagedGame()?'/'+asset.model:localAssetURL(asset.model)??null;}
export async function preparePresentation(project){if(isPackagedGame())return;for(const a of presentationFiles(project))if(!localAssetURL(a.model))registerLocalAsset(a.model,await fileBytes(a));}
function modal(title,content){const d=document.createElement('dialog');d.className='prop-dialog creator-dialog';d.setAttribute('aria-label',title);d.innerHTML=`<form method="dialog" class="import-heading"><div><span class="eyebrow">CREATOR TOOLS</span><h2>${title}</h2></div><button class="dialog-close" aria-label="Close creator tools">×</button></form>${content}`;document.body.append(d);d.showModal();d.addEventListener('close',()=>d.remove(),{once:true});return d;}
export async function openPlacement({getProject,onChange,toast}){
 const project=structuredClone(getProject());if(!project.importedProps.length){toast('Import a prop before placing it.');return;}
 const response=await fetch(`/packs/${project.theme}/pack.json`);if(!response.ok)throw Error('World layout could not be loaded.');
 const pack=resolvePack(await response.json(),CATALOG[project.theme].measurements);
 const d=modal('Place props',`<p class="import-intro">Drag a prop on the map, or enter its position. Props stay grounded. Reserved routes and occupied areas must remain clear.</p><div class="placement-grid"><div><svg class="placement-map" viewBox="0 0 80 80" role="img" aria-label="Mission placement map"></svg><p class="map-legend">Gray: world geometry · Cyan: objectives · Orange: selected prop</p></div><form class="prop-settings"><label>Prop<select name="prop">${project.importedProps.map((p,i)=>`<option value="${i}">${esc(p.name)}</option>`).join('')}</select></label><div class="prop-two"><label>X (metres)<input name="x" type="number" step="0.25" required></label><label>Z (metres)<input name="z" type="number" step="0.25" required></label></div><label>Rotation (degrees)<input name="yaw" type="number" min="-180" max="180" step="5" required></label><label>Height (metres)<input name="height" type="number" min="0.1" max="4" step="0.05" required></label><label>Collision<select name="collision"><option value="box">Solid box</option><option value="none">Decorative</option></select></label><button class="secondary-button" type="button" data-auto>Reset to automatic placement</button><p class="placement-status" role="status"></p><button class="front-primary" type="submit">Save placement</button></form></div>`);
 const svg=d.querySelector('svg'),form=d.querySelector('.prop-settings'),status=d.querySelector('.placement-status');let selected=0,level,drag=null,valid=true;
 const props=project.importedProps;
 const base=compileShooterProject({...project,importedProps:[]},pack),size=base.terrain.size??80,half=size/2;svg.setAttribute('viewBox',`0 0 ${size} ${size}`);
 function placement(i){return level?.placements.find(p=>p.id===`import-${i}`)??{...props[i].transform,x:props[i].transform?.x??4,z:props[i].transform?.z??23,yaw:props[i].transform?.yaw??0};}
 function draw(sync=false){
  valid=true;try{level=compileShooterProject({...project,importedProps:props},pack);status.textContent='Placement is clear.';}catch(e){valid=false;status.textContent=e.message;}
  form.querySelector('[type=submit]').disabled=!valid;status.classList.toggle('invalid',!valid);
  const rectangles=base.placements.filter(p=>p.collision!=='none'&&(p.y??0)<2).map(p=>{const f=footprint(p);return `<rect x="${p.x-f.x+half}" y="${p.z-f.z+half}" width="${f.x*2}" height="${f.z*2}" fill="#343d47"/>`;}).join('');
  const objectives=base.placements.filter(p=>p.stepId).map(p=>`<circle cx="${p.x+half}" cy="${p.z+half}" r="3" fill="#68cfdb22" stroke="#68cfdb" stroke-width=".25"/>`).join('');
  svg.innerHTML=`<rect width="${size}" height="${size}" fill="#10151b"/><path d="M${half} 0V${size}M0 ${half}H${size}" stroke="#3d4855" stroke-width=".2"/>${rectangles}${objectives}<circle cx="${base.spawn.position.x+half}" cy="${base.spawn.position.z+half}" r="2.6" fill="#68cfdb44" stroke="#68cfdb" stroke-width=".3"/><text x="${half+4}" y="${base.spawn.position.z+half+1}" fill="#a0bdc7" font-size="2">START</text>`+props.map((p,i)=>{const pos=p.transform??placement(i),w=p.size[0]*p.scale,h=p.size[2]*p.scale;return `<g data-prop="${i}" transform="translate(${pos.x+half} ${pos.z+half}) rotate(${-((pos.yaw??0)*180/Math.PI)})"><rect x="${-Math.max(w,3)/2}" y="${-Math.max(h,3)/2}" width="${Math.max(w,3)}" height="${Math.max(h,3)}" fill="transparent"/><rect x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" fill="${i===selected?valid?'#ec9a52':'#ef756c':'#9caec2'}" stroke="#fff" stroke-width="${i===selected?.22:.08}"/><path d="M0 0V${-h/2-1}" stroke="#fff" stroke-width=".2"/></g>`;}).join('');
  if(sync){const p=props[selected],pos=p.transform??placement(selected);form.elements.x.value=pos.x.toFixed(2);form.elements.z.value=pos.z.toFixed(2);form.elements.yaw.value=((pos.yaw??0)*180/Math.PI).toFixed(0);form.elements.height.value=(p.size[1]*p.scale).toFixed(2);form.elements.collision.value=p.collision;}
 }
 form.elements.prop.addEventListener('change',()=>{selected=Number(form.elements.prop.value);draw(true);});
 form.addEventListener('input',e=>{if(e.target.name==='prop')return;const p=props[selected];p.transform={x:Number(form.elements.x.value),z:Number(form.elements.z.value),yaw:Number(form.elements.yaw.value)*Math.PI/180};p.scale=Number(form.elements.height.value)/p.size[1];p.collision=form.elements.collision.value;draw();});
 svg.addEventListener('pointerdown',e=>{const node=e.target.closest('[data-prop]');if(!node)return;selected=Number(node.dataset.prop);form.elements.prop.value=selected;drag=e.pointerId;svg.setPointerCapture(e.pointerId);draw(true);});
 svg.addEventListener('pointermove',e=>{if(drag!==e.pointerId)return;const rect=svg.getBoundingClientRect(),p=props[selected];p.transform={x:Math.round(((e.clientX-rect.left)/rect.width*size-half)*4)/4,z:Math.round(((e.clientY-rect.top)/rect.height*size-half)*4)/4,yaw:p.transform?.yaw??0};draw(true);});
 for(const event of ['pointerup','pointercancel','lostpointercapture'])svg.addEventListener(event,()=>drag=null);
 d.querySelector('[data-auto]').onclick=()=>{delete props[selected].transform;draw(true);};
 form.onsubmit=e=>{e.preventDefault();try{compileShooterProject({...project,importedProps:props},pack);onChange({importedProps:props});d.close();toast('Prop placement saved. Generate the mission to play your layout.');}catch(err){status.textContent=err.message;}};
 draw(true);
}

/** Read dimensions before decoding; reject oversized or disguised images. */
export function inspectArtwork(buffer){
 if(buffer.byteLength<24||buffer.byteLength>4*1024*1024)throw Error('Use a PNG or JPEG under 4 MB.');
 const v=new DataView(buffer);let width=0,height=0,mime;
 if(v.getUint32(0)===0x89504e47&&v.getUint32(4)===0x0d0a1a0a){width=v.getUint32(16);height=v.getUint32(20);mime='image/png';}
 else if(v.getUint16(0)===0xffd8){mime='image/jpeg';let i=2;while(i+4<buffer.byteLength){if(v.getUint8(i++)!==255)continue;let marker=v.getUint8(i++);while(marker===255&&i<buffer.byteLength)marker=v.getUint8(i++);if(marker===0xd9||marker===0xda)break;if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;const n=v.getUint16(i);if(n<2||i+n>buffer.byteLength)break;if([0xc0,0xc1,0xc2].includes(marker)&&n>=7){height=v.getUint16(i+3);width=v.getUint16(i+5);break;}i+=n;}}
 if(!width||!height||width>4096||height>4096)throw Error('Use a PNG/JPEG image up to 4096 × 4096.');
 return {width,height,mime,bytes:buffer.byteLength};
}
export async function openIdentity({getProject,onChange,toast}){
 const current=getProject().presentation??{},draft=structuredClone(current),pending={},selection={artwork:0,logo:0};
 const d=modal('Mission identity',`<p class="import-intro">Custom artwork and branding appear on the mission card, results and exported game. PNG or JPEG, up to 4 MB / 4096 pixels. A wide image works best.</p><form class="prop-settings identity-form"><div class="prop-two"><label>Studio name<input name="studio" maxlength="64" value="${esc(current.studioName??'')}" placeholder="Your studio"></label><label>Accent color<input name="accent" type="color" value="${current.accent??'#ec9a52'}"></label></div><div class="identity-preview"><span>MISSION ARTWORK</span></div><div class="prop-two"><label>Mission artwork<input type="file" name="artwork" accept="image/png,image/jpeg"></label><label>Studio logo<input type="file" name="logo" accept="image/png,image/jpeg"></label></div><div class="identity-removals"><button type="button" data-clear="artwork" hidden>Remove artwork</button><button type="button" data-clear="logo" hidden>Remove logo</button></div><div class="prop-two"><label>Image creator<input name="creator" maxlength="160" placeholder="Your name or studio"></label><label>Licence / permission<input name="license" maxlength="300" placeholder="Original artwork or licence"></label></div><label>Image source<input name="source" maxlength="300" placeholder="Original work or source URL"></label><label class="rights-check"><input name="rights" type="checkbox"><span>I own the selected images or have permission to redistribute them with the game.</span></label><p class="import-error" role="alert"></p><button type="submit" class="front-primary">Save identity</button><small>Images are stored on this device and included with credits in game ZIPs. Project JSON references the original files.</small></form>`);
 const form=d.querySelector('.identity-form'),preview=d.querySelector('.identity-preview'),error=d.querySelector('.import-error'),urls=[];let loading=0,closed=false;
 function render(){const url=pending.artwork?.url??presentationURL(draft.artwork),logo=pending.logo?.url??presentationURL(draft.logo);preview.style.backgroundImage=url?`linear-gradient(0deg,#060a10cf,transparent),url('${url}')`:'';preview.innerHTML=`${logo?`<img src="${logo}" alt="Studio logo preview">`:''}<strong>${esc(form.elements.studio.value||getProject().name)}</strong><span>${url?'CUSTOM ARTWORK':'DEFAULT WORLD ARTWORK'}</span>`;preview.style.borderColor=form.elements.accent.value;d.querySelector('[data-clear=artwork]').hidden=!url;d.querySelector('[data-clear=logo]').hidden=!logo;}
 form.addEventListener('input',e=>{if(e.target.type!=='file')render();});
 d.addEventListener('close',()=>{closed=true;urls.forEach(URL.revokeObjectURL);});
 for(const kind of ['artwork','logo'])form.elements[kind].addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;const token=++selection[kind];loading++;form.querySelector('[type=submit]').disabled=true;error.textContent='';try{
  const buffer=await f.arrayBuffer(),info=inspectArtwork(buffer),blob=new Blob([buffer],{type:info.mime}),bitmap=await createImageBitmap(blob);bitmap.close();
  const id=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(closed||token!==selection[kind])return;const url=URL.createObjectURL(blob);urls.push(url);pending[kind]={...info,id,blob,url};e.target.closest('label').dataset.file=f.name;render();
 }catch(err){error.textContent=err.message;}finally{loading--;if(!closed)form.querySelector('[type=submit]').disabled=loading>0;e.target.value='';}});
 for(const b of d.querySelectorAll('[data-clear]'))b.onclick=()=>{selection[b.dataset.clear]++;delete draft[b.dataset.clear];delete pending[b.dataset.clear];delete form.elements[b.dataset.clear].closest('label').dataset.file;render();form.elements[b.dataset.clear].focus();};
 form.onsubmit=async e=>{e.preventDefault();if(loading)return;const button=form.querySelector('[type=submit]');button.disabled=true;try{
  const value={...draft,studioName:form.elements.studio.value,accent:form.elements.accent.value};
  for(const [kind,file]of Object.entries(pending))value[kind]={...file,creator:form.elements.creator.value,license:form.elements.license.value,source:form.elements.source.value,rightsConfirmed:form.elements.rights.checked};
  const presentation=normalizePresentation(value);
  for(const [kind,file]of Object.entries(pending)){await localFile(file.id,file.blob);registerLocalAsset(presentation[kind].model,file.blob);}
  if(closed)return;onChange({presentation});d.close();toast('Mission identity saved.');
 }catch(err){error.textContent=err.message;button.disabled=false;}};
 try{await preparePresentation(getProject());}catch(err){error.textContent=err.message;}if(!closed)render();
}
