import { assetURL, isPackagedGame } from '../src/config/assetDelivery.js';
import { localFile as stored, fileBytes as importedBytes } from './localFiles.js';
import { normalizeImportedProps } from '../src/world/importedProps.js';
import { registerLocalAsset } from '../src/config/localAssets.js';
const LIMIT=8*1024*1024;
export function inspectGLB(buffer) {
  if(buffer.byteLength>LIMIT||buffer.byteLength<20)throw Error('Choose a self-contained GLB under 8 MB.');
  const view=new DataView(buffer);
  if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength||view.getUint32(16,true)!==0x4e4f534a)throw Error('This is not a valid GLB 2.0 file.');
  const length=view.getUint32(12,true);if(length>buffer.byteLength-20)throw Error('The GLB header is incomplete.');
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)).trim());
  if(json.animations?.length||json.skins?.length||json.meshes?.some(m=>m.primitives?.some(p=>p.targets?.length)))throw Error('This import supports static props. Animated characters and weapons are a later stage.');
  if((json.buffers??[]).some(b=>b.uri)||(json.images??[]).some(i=>i.uri||!['image/png','image/jpeg'].includes(i.mimeType)))throw Error('Embed all buffers and PNG/JPEG textures inside the GLB.');
  const allowed=['KHR_materials_unlit','KHR_materials_emissive_strength','KHR_texture_transform'];
  if((json.extensionsUsed??[]).some(e=>!allowed.includes(e)))throw Error('Export a standard, uncompressed GLB with PNG/JPEG textures for this first importer.');
  if((json.materials?.length??0)>16||(json.images?.length??0)>12||(json.nodes?.length??0)>256)throw Error('Use at most 16 materials, 12 textures and 256 nodes.');
  if(!json.meshes?.length)throw Error('This GLB has no mesh.');
  let triangles=0;
  for(const node of json.nodes??[])if(node.mesh!==undefined){const mesh=json.meshes[node.mesh];if(!mesh)throw Error('GLB references a missing mesh.');for(const p of mesh.primitives){if(p.mode!==undefined&&p.mode!==4)throw Error('Triangulate the prop before importing.');const n=json.accessors?.[p.indices??p.attributes?.POSITION]?.count;if(!Number.isInteger(n)||n<3)throw Error('Invalid GLB geometry.');triangles+=n/3;}}
  if(triangles<1||triangles>50000)throw Error('Use between 1 and 50,000 triangles per prop.');
  // Read PNG/JPEG dimensions before handing compressed images to the browser decoder.
  let textureBytes=0;
  for(const img of json.images??[]){
    const b=json.bufferViews?.[img.bufferView],bin=20+length;
    if(!b||b.buffer!==0||bin+8>buffer.byteLength||view.getUint32(bin+4,true)!==0x004e4942)throw Error('Invalid embedded image.');
    const start=bin+8+(b.byteOffset??0),end=start+b.byteLength;
    if(!Number.isInteger(start)||!Number.isInteger(end)||end>buffer.byteLength||start<bin+8)throw Error('Invalid embedded image range.');
    let width=0,height=0;
    if(img.mimeType==='image/png'){
      if(end-start<24||view.getUint32(start)!==0x89504e47)throw Error('Invalid PNG texture.');
      width=view.getUint32(start+16);height=view.getUint32(start+20);
    }else{
      if(end-start<4||view.getUint16(start)!==0xffd8)throw Error('Invalid JPEG texture.');
      let cursor=start+2;
      while(cursor+4<end){if(view.getUint8(cursor++)!==255)continue;let marker=view.getUint8(cursor++);while(marker===255&&cursor<end)marker=view.getUint8(cursor++);
        if(marker===0xd9||marker===0xda)break;
        if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
        if(cursor+2>end)break;const n=view.getUint16(cursor);if(n<2||cursor+n>end)break;
        if([0xc0,0xc1,0xc2].includes(marker)&&n>=7){height=view.getUint16(cursor+3);width=view.getUint16(cursor+5);break;}cursor+=n;
      }
    }
    if(!width||!height||width>2048||height>2048)throw Error('Use PNG/JPEG textures no larger than 2048 × 2048.');
    textureBytes+=width*height*4;if(textureBytes>64*1024*1024)throw Error('Reduce texture sizes: decoded textures must fit within 64 MB per prop.');
  }
  return {json,triangles:Math.ceil(triangles)};
}
export { fileBytes as importedBytes } from './localFiles.js';
export async function prepareImportedAssets(project) {if(isPackagedGame())return;for(const p of project.importedProps??[])registerLocalAsset(p.model,await importedBytes(p));}
function disposeModel(scene) {const textures=new Set(),materials=new Set(),geometry=new Set();scene?.traverse(o=>{if(o.geometry)geometry.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());geometry.forEach(g=>g.dispose());}
export async function openAssetImport({getProject,onChange,toast,notice}) {
  const dialog=document.createElement('dialog');dialog.className='prop-dialog';dialog.setAttribute('aria-label','Import static prop');
  dialog.innerHTML=`<form method="dialog"><div class="import-heading"><div><span class="eyebrow">ASSET LIBRARY</span><h2>Import static prop</h2></div><button aria-label="Close import" value="close" class="dialog-close">×</button></div></form>
  ${notice?`<p class="import-notice" role="status">${notice}</p>`:''}<p class="import-intro">Bring a static object into your mission. Preview it, set its size, and choose how it behaves.</p>
  <div class="import-grid"><div><label class="drop-zone" tabindex="0" role="button"><span>＋</span><strong>Drop a .glb here or browse</strong><small>Self-contained · up to 8 MB · 50k triangles</small><input type="file" accept=".glb,model/gltf-binary" hidden></label><button type="button" class="sample-prop">Load sample prop</button><button type="button" class="photo-prop">See yourself: make one from a photo</button><input class="photo-input" type="file" accept="image/*" hidden><canvas class="prop-preview" hidden aria-label="Drag to rotate imported prop preview"></canvas><p class="prop-metrics" role="status">Static props first. Characters and weapons come later.</p></div>
  <form class="prop-settings"><label>Name<input name="name" maxlength="64" required placeholder="Field supply case"></label><div class="prop-two"><label>Height (metres)<input name="height" type="number" min="0.1" max="4" step="0.01" value="1" required></label><label>Collision<select name="collision"><option value="box">Solid box</option><option value="none">Decorative / walk through</option></select></label></div><label>Creator<input name="creator" required maxlength="160" placeholder="Your name or studio"></label><label>Source<input name="source" maxlength="300" placeholder="Original work or source URL"></label><label>Licence / permission<input name="license" required maxlength="300" placeholder="Original work, CC0, or licence name"></label><label class="rights-check"><input name="rights" type="checkbox" required><span>I own this asset or have permission to include and redistribute it in this game.</span></label><p class="import-error" role="alert"></p><button class="front-primary" type="submit" disabled>Add to mission</button><small>Saved on this device. Included with credits in your game ZIP. JSON projects reference the file; keep the original GLB.</small></form></div>`;
  document.body.append(dialog);dialog.showModal();
  const $=s=>dialog.querySelector(s),form=$('.prop-settings');let loaded,renderer,scene,camera,controls,frame,THREE,disposed=false,loadToken=0,loading=false;
  function cleanup(){disposed=true;loadToken++;cancelAnimationFrame(frame);controls?.dispose();disposeModel(scene);renderer?.dispose();dialog.remove();}
  dialog.addEventListener('close',cleanup,{once:true});
  $('.drop-zone').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();$('input[type=file]').click();}});
  async function load(file,sample=false){if(loading)return;loading=true;$('input[type=file]').disabled=true;$('.sample-prop').disabled=true;$('.prop-preview').hidden=true;const token=++loadToken;loaded=null;form.querySelector('button').disabled=true;$('.import-error').textContent='';$('.prop-metrics').textContent='Checking geometry and textures…';
    try{
      const buffer=await file.arrayBuffer(),report=inspectGLB(buffer);
      THREE=await import('three/webgpu');const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
      const manager=new THREE.LoadingManager();let textureFailed=false;manager.onError=()=>{textureFailed=true;};const gltf=await new GLTFLoader(manager).parseAsync(buffer,'');
      if(textureFailed){disposeModel(gltf.scene);throw Error('An embedded texture could not be decoded. Re-export the GLB with PNG/JPEG textures.');}
      if(disposed||token!==loadToken){disposeModel(gltf.scene);return;}
      let textureError=false;gltf.scene.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])for(const v of Object.values(m))if(v?.isTexture&&(v.image?.width>2048||v.image?.height>2048))textureError=true;});
      if(textureError){disposeModel(gltf.scene);throw Error('Resize textures to 2048 × 2048 or smaller.');}
      const box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()).toArray();
      if(size.some(n=>!Number.isFinite(n)||n<=0||n>10000)){disposeModel(gltf.scene);throw Error('The prop needs finite, non-zero dimensions.');}
      const id=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(n=>n.toString(16).padStart(2,'0')).join('');
      if(disposed||token!==loadToken){disposeModel(gltf.scene);return;}
      loaded={id,size,triangles:report.triangles,bytes:buffer.byteLength,blob:new Blob([buffer],{type:'model/gltf-binary'})};
      form.elements.name.value=file.name.replace(/\.glb$/i,'');form.elements.height.value=Math.max(.1,Math.min(1,4*size[1]/Math.max(...size))).toFixed(2);
      if(sample){form.elements.creator.value='Visigence';form.elements.source.value='Original geometry authored with Blender';form.elements.license.value='CC0-1.0';}
      if(!renderer){renderer=new THREE.WebGPURenderer({canvas:$('.prop-preview'),forceWebGL:true,antialias:true});await renderer.init();if(disposed){renderer.dispose();disposeModel(gltf.scene);return;}renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(400,300,false);camera=new THREE.PerspectiveCamera(38,4/3,.01,100);let pointer=null;const canvas=$('.prop-preview');canvas.addEventListener('pointerdown',e=>{pointer={id:e.pointerId,x:e.clientX};canvas.setPointerCapture(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(pointer?.id===e.pointerId&&scene?.userData.model){scene.userData.model.rotation.y+=(e.clientX-pointer.x)*.012;pointer.x=e.clientX;}});for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,()=>pointer=null);}
      cancelAnimationFrame(frame);disposeModel(scene);scene=new THREE.Scene();scene.background=new THREE.Color('#17191d');scene.add(new THREE.HemisphereLight(0xe6f8f1,0x34413c,3));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(3,5,4);scene.add(light);
      const center=box.getCenter(new THREE.Vector3()),s=1.5/Math.max(...size);gltf.scene.scale.multiplyScalar(s);gltf.scene.position.sub(center.multiplyScalar(s));scene.add(gltf.scene);scene.userData.model=gltf.scene;camera.position.set(2,1.5,2.7);camera.lookAt(0,0,0);
      $('.prop-preview').hidden=false;$('.prop-metrics').textContent=`${report.triangles.toLocaleString()} triangles · ${(buffer.byteLength/1024).toFixed(0)} KB · ${size.map(n=>n.toFixed(2)).join(' × ')} source units. Drag to rotate.`;
      const draw=()=>{if(disposed)return;renderer.render(scene,camera);frame=requestAnimationFrame(draw);};draw();form.querySelector('button').disabled=false;
    }catch(e){if(token===loadToken&&!disposed){loaded=null;$('.import-error').textContent=e.message;$('.prop-metrics').textContent='File needs attention before import.';}}finally{loading=false;if(!disposed){$('input[type=file]').disabled=false;$('.sample-prop').disabled=false;}}
  }
  $('input[type=file]').addEventListener('change',e=>{const f=e.target.files[0];if(f)load(f);e.target.value='';});
  const zone=$('.drop-zone');zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('is-over');});for(const type of ['dragleave','drop'])zone.addEventListener(type,()=>zone.classList.remove('is-over'));zone.addEventListener('drop',e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)load(f);});
  /**
   * SEE YOURSELF: a photograph of one person (or one thing) becomes a figure, on this device. src/atlas/
   * reconstructs it in a worker (src/atlas/web/figure.js photoToFigure: the subject cropped, a textured mesh, cut by SmartMesh to
   * what the evidence supports and at most 24k triangles, no skin), and the GLB it writes goes through this very
   * importer: preview, size (a person's 1.75 m to start), collision, credits, and the rights box the creator ticks.
   * Nothing is uploaded; the photograph never leaves the page.
   */
  $('.photo-prop').addEventListener('click',()=>$('.photo-input').click());
  $('.photo-input').addEventListener('change',async e=>{const f=e.target.files[0];e.target.value='';if(f)await fromPhoto(f);});
  async function fromPhoto(file){
    if(loading)return;const metrics=$('.prop-metrics'),button=$('.photo-prop');
    $('.import-error').textContent='';button.disabled=true;metrics.textContent='Reconstructing a figure from the photograph, on this device…';
    try{
      const {photoToFigure}=await import('../src/atlas/web/figure.js');
      const fig=await photoToFigure(file,{onProgress:p=>{if(!disposed)metrics.textContent=`Reconstructing a figure from the photograph · ${Math.round(p.progress)}%`;}});
      if(disposed)return;
      const name=(file.name.replace(/\.[a-z0-9]+$/i,'')||'Me').slice(0,58);
      await load(new File([fig.bytes],`${name}.glb`,{type:'model/gltf-binary'}));
      if(!loaded||disposed)return;
      form.elements.height.value='1.75';
      form.elements.source.value='A photograph, reconstructed on this device';
      if(!form.elements.license.value)form.elements.license.value='My own photograph';
      metrics.textContent=`A figure from your photograph: ${Math.round(fig.triangles).toLocaleString()} triangles, ${(fig.bytes.length/1024).toFixed(0)} KB, made in ${(fig.ms/1000).toFixed(1)} s. Drag to rotate.`;
    }catch(err){if(!disposed){$('.import-error').textContent=`The photograph could not be made into a figure: ${err.message}`;metrics.textContent='Try a photograph of one person or object against a plain background.';}}
    finally{if(!disposed)button.disabled=false;}
  }
  $('.sample-prop').addEventListener('click',async()=>{try{const r=await fetch(assetURL('/assets/studio/import-demo.glb'));if(!r.ok)throw Error('Sample could not be loaded.');await load(new File([await r.blob()],'Field supply case.glb'),true);}catch(e){$('.import-error').textContent=e.message;}});
  form.addEventListener('submit',async e=>{e.preventDefault();if(!loaded)return;const button=form.querySelector('button');button.disabled=true;
    try{const p={...loaded,name:form.elements.name.value,scale:Number(form.elements.height.value)/loaded.size[1],collision:form.elements.collision.value,creator:form.elements.creator.value,source:form.elements.source.value,license:form.elements.license.value,rightsConfirmed:form.elements.rights.checked};delete p.blob;
      const next=normalizeImportedProps([...(getProject().importedProps??[]).filter(a=>a.id!==p.id),p]);await stored(p.id,loaded.blob);registerLocalAsset(`imports/${p.id}.glb`,loaded.blob);onChange({importedProps:next});dialog.close();toast('Prop added. Play this mission to see it near your starting route.');
    }catch(e){$('.import-error').textContent=e.message;button.disabled=false;}
  });
}
