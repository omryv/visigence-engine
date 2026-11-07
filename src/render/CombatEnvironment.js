import { CanvasTexture, SRGBColorSpace, MeshStandardMaterial, MeshBasicMaterial, PlaneGeometry,
  CylinderGeometry, Group, PointLight, Vector3, Box3, RingGeometry, DoubleSide,
  RepeatWrapping, Color } from 'three/webgpu';
import { texture, uv, mix, attribute } from 'three/tsl';
import { channelRng } from '../kernel/seed.js';
import { worldFields } from '../world/worldGrammar.js';
import { createNatureBatch } from './PartsBatch.js';
import { buildGroundGeometry, buildWaterGeometry, buildSeaGeometry, WORLD_BEYOND } from './ArcadeGround.js';
import { worldAround } from '../world/kernelGround.js';
import { DIRS64 } from '../world/houseGrammar.js';

/**
 * Arcade's lawn: a seamless painted tile (soft tonal patches plus short light and dark blade
 * strokes), the runtime twin of the Blender kit's grass (tools/blender/v2/arcade/kit.py).
 * Every mark is drawn at all nine wrap offsets so the tile repeats without seams. A biome paints
 * its own ground from the world rules' `ground` (the desert: sand, its strokes lying flat as ripples).
 */
const MEADOW_GROUND={base:'#6fbe48',tones:['#5aa843','#86cc52','#9bd35a','#4f9c46'],light:'rgba(185,226,112,.55)',dark:'rgba(56,128,58,.5)',ripple:false};
function lawnTexture(seed,size,G=MEADOW_GROUND){
 const c=document.createElement('canvas');c.width=c.height=size;const x=c.getContext('2d'),rnd=channelRng(seed,'arcade-lawn');
 x.fillStyle=G.base;x.fillRect(0,0,size,size);
 const wrapped=draw=>{for(const dx of [-size,0,size])for(const dy of [-size,0,size])draw(dx,dy);};
 for(let i=0;i<48;i++){
  const cx=rnd()*size,cy=rnd()*size,r=size*(.06+rnd()*.14),tone=G.tones[i%G.tones.length];
  wrapped((dx,dy)=>{const g=x.createRadialGradient(cx+dx,cy+dy,0,cx+dx,cy+dy,r);g.addColorStop(0,tone+'66');g.addColorStop(1,tone+'00');x.fillStyle=g;x.fillRect(cx+dx-r,cy+dy-r,r*2,r*2);});
 }
 x.lineCap='round';
 // Grass stands up in short blades; sand lies in longer, flatter ripples.
 const n=G.ripple?size*1.2:size*3;
 for(let i=0;i<n;i++){
  const cx=rnd()*size,cy=rnd()*size,len=size*(G.ripple?.02+rnd()*.03:.008+rnd()*.014),a=G.ripple?(rnd()-.5)*.35:-Math.PI/2+(rnd()-.5)*.9,light=rnd()<.55;
  x.strokeStyle=light?G.light:G.dark;x.lineWidth=Math.max(1,size/256)*(G.ripple?1.4:1);
  wrapped((dx,dy)=>{x.beginPath();x.moveTo(cx+dx,cy+dy);x.lineTo(cx+dx+Math.cos(a)*len,cy+dy+Math.sin(a)*len);x.stroke();});
 }
 const t=new CanvasTexture(c);t.colorSpace=SRGBColorSpace;t.wrapS=t.wrapT=RepeatWrapping;return t;
}
/**
 * Arcade's ground overlay: one non-repeating canvas over the whole meadow, blended onto the lawn tile. It paints
 * what the village layout (world/worldGrammar.js) decided: the lanes, the square, the spurs and the doorstep
 * walks in packed sand with a worn grass edge, moist and dry tints from the moisture field, and a blush of
 * petals under every flower cluster. Canvas row 0 is the far edge (z = -size/2), because a CanvasTexture flips.
 */
function groundOverlay(seed,world,rules,size,px,regions=null){
 const c=document.createElement('canvas');c.width=c.height=px;const x=c.getContext('2d'),O=rules.overlay,k=px/size;
 const X=v=>(v+size/2)*k,Y=v=>(size/2-v)*k;
 x.clearRect(0,0,px,px);
 // 1. the fields, in 4 px blocks: moisture darkens, dryness pales.
 const F=worldFields(rules,seed),b=4;
 for(let j=0;j<px;j+=b)for(let i=0;i<px;i+=b){
  const m=F.moisture(i/k-size/2,size/2-j/k);
  if(m>.58){x.fillStyle=O.moist;x.globalAlpha=Math.min(.42,(m-.58)*1.2);x.fillRect(i,j,b,b);}
  else if(m<.4){x.fillStyle=O.dry;x.globalAlpha=Math.min(.38,(.4-m)*1.1);x.fillRect(i,j,b,b);}
 }
 x.globalAlpha=1;
 // 1b. relief (world/worldTerrain.js). Toon light barely moves on a gentle hill, so the lawn is painted to read
 // it: sunnier, drier grass up the rises, deeper green in the hollows, bare earth on the steep banks a lane cuts
 // and a pond's terrace makes.
 const T=world.terrain;
 if(T&&O.bank){
  const res=T.res,h=(i,j)=>T.heights[Math.min(res-1,Math.max(0,j))*res+Math.min(res-1,Math.max(0,i))],c=T.cell;
  const at=(vx,vz)=>{const fx=Math.min(res-1.001,Math.max(0,(vx+size/2)/c)),fz=Math.min(res-1.001,Math.max(0,(vz+size/2)/c)),i=Math.floor(fx),j=Math.floor(fz),tx=fx-i,tz=fz-j;
   return h(i,j)*(1-tx)*(1-tz)+h(i+1,j)*tx*(1-tz)+h(i,j+1)*(1-tx)*tz+h(i+1,j+1)*tx*tz;};
  for(let j=0;j<px;j+=b)for(let i=0;i<px;i+=b){
   const vx=(i+b/2)/k-size/2,vz=size/2-(j+b/2)/k,hh=at(vx,vz),s=Math.hypot(at(vx+c,vz)-at(vx-c,vz),at(vx,vz+c)-at(vx,vz-c))/(2*c);
   if(hh>.8){x.fillStyle=O.dry;x.globalAlpha=Math.min(.36,(hh-.8)*.09);x.fillRect(i,j,b,b);}
   else if(hh<-.2){x.fillStyle=O.moist;x.globalAlpha=Math.min(.3,(-.2-hh)*.6);x.fillRect(i,j,b,b);}
   if(s>.34){x.fillStyle=O.bank;x.globalAlpha=Math.min(.42,(s-.34)*1.1);x.fillRect(i,j,b,b);}
  }
  x.globalAlpha=1;
 }
 // 2. petals under the flower clusters.
 for(const f of world.flowers??[]){const g=x.createRadialGradient(X(f.x),Y(f.z),0,X(f.x),Y(f.z),f.r*k);g.addColorStop(0,O.flower+'a6');g.addColorStop(1,O.flower+'00');x.fillStyle=g;x.fillRect(X(f.x)-f.r*k,Y(f.z)-f.r*k,2*f.r*k,2*f.r*k);}
 // 2b. the water's painted shore: damp dark grass a little way out, then a band of wet sand at the waterline.
 const W=world.water;
 if(W&&O.shore){
  const ring=(p,off)=>{x.beginPath();for(let q=0;q<=64;q++){const d=DIRS64[q%64],r=p.radii[q%64]+off;q?x.lineTo(X(p.x+d[0]*r),Y(p.z+d[1]*r)):x.moveTo(X(p.x+d[0]*r),Y(p.z+d[1]*r));}x.closePath();};
  for(const p of W.ponds){
   for(const [off,a] of [[2.4,.22],[1.4,.3]]){ring(p,off);x.fillStyle=O.damp;x.globalAlpha=a;x.fill();}
   ring(p,.1);x.strokeStyle=O.shore;x.lineWidth=.9*k;x.globalAlpha=.9;x.stroke();x.globalAlpha=1;
  }
  const B=W.brook;
  if(B){
   const line=(w,color,alpha)=>{x.beginPath();x.moveTo(X(B.pts[0][0]),Y(B.pts[0][1]));for(const p of B.pts.slice(1))x.lineTo(X(p[0]),Y(p[1]));x.lineWidth=w*k;x.strokeStyle=color;x.globalAlpha=alpha;x.stroke();x.globalAlpha=1;};
   x.lineCap='round';x.lineJoin='round';
   line(B.w+3.2,O.damp,.3);line(B.w+.9,O.shore,.85);
   const bs=B.basin;x.beginPath();x.arc(X(bs.x),Y(bs.z),(bs.r+.55)*k,0,Math.PI*2);x.fillStyle=O.shore;x.globalAlpha=.8;x.fill();x.globalAlpha=1;
  }
 }
 // 3. paths: a worn edge first, then the packed sand. Smoothed through the midpoints of the wobbled polylines.
 const stroke=(pts,w,color,alpha)=>{if(pts.length<2)return;x.beginPath();x.moveTo(X(pts[0][0]),Y(pts[0][1]));
  for(let i=1;i<pts.length-1;i++){const a=pts[i],n=pts[i+1];x.quadraticCurveTo(X(a[0]),Y(a[1]),X((a[0]+n[0])/2),Y((a[1]+n[1])/2));}
  x.lineTo(X(pts.at(-1)[0]),Y(pts.at(-1)[1]));x.lineWidth=w*k;x.strokeStyle=color;x.globalAlpha=alpha;x.stroke();x.globalAlpha=1;};
 x.lineCap='round';x.lineJoin='round';
 for(const l of world.lanes??[])stroke(l.pts,l.w+2.2,O.worn,.5);
 for(const s of world.spurs??[])stroke(s.pts,s.w+1.4,O.worn,.35);
 for(const l of world.lanes??[])stroke(l.pts,l.w,O.path,.92);
 for(const s of world.spurs??[])stroke(s.pts,s.w*.7,O.path,.55);
 for(const w of world.walks??[])stroke(w.pts,w.w,O.path,.8);
 // 3b. flagstones (a biome's stone paths): staggered slabs along every lane, laid square to it, each a little
 // different in tone, with a darker joint round it. Deterministic: the slab's tone comes from its own index.
 if(O.flag)for(const [li,l] of (world.lanes??[]).entries()){
  const cols=Math.max(2,Math.round(l.w/0.95)),cw=l.w/cols;
  let along=0;
  for(let i=1;i<l.pts.length;i++){
   const a=l.pts[i-1],b=l.pts[i],seg=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!(seg>0))continue;
   const tx=(b[0]-a[0])/seg,tz=(b[1]-a[1])/seg,ang=Math.atan2(-tz,tx);
   for(let d=(0.5-along%0.9+0.9)%0.9;d<seg;d+=0.9){
    const row=Math.floor((along+d)/0.9);
    for(let q=0;q<cols;q++){
     const off=(q+0.5)*cw-l.w/2,shift=(q%2)*0.45,cx=a[0]+tx*(d+shift)-tz*off,cz=a[1]+tz*(d+shift)+tx*off;
     const h=Math.sin((li*977+row*131+q*37)*12.9898)*43758.5453,tone=h-Math.floor(h);
     x.save();x.translate(X(cx),Y(cz));x.rotate(ang);
     const sw=0.78*k,sh=(cw-0.14)*k;x.beginPath();x.roundRect(-sw/2,-sh/2,sw,sh,0.12*k);
     x.fillStyle=O.flag;x.globalAlpha=0.72+0.2*tone;x.fill();x.strokeStyle=O.flagEdge;x.lineWidth=0.07*k;x.globalAlpha=0.55;x.stroke();
     x.restore();
    }
   }
   along+=seg;
  }
  x.globalAlpha=1;
 }
 // 3c. ground the level editor painted (world/level/regions.js): paths in the lanes' packed sand with their worn edge,
 // laid as overlapping discs so a stroke reads as a path rather than squares; no-go ground as dark trampled earth with
 // a hatch, so a player sees where they cannot go.
 if(regions?.some(Boolean)){
  const cellAt=(i,j)=>i>=0&&j>=0&&i<80&&j<80?regions[j*80+i]:0;
  for(const [code,r,color,alpha] of [[2,1.05,O.worn,.5],[2,.72,O.path,.9]]){x.fillStyle=color;x.globalAlpha=alpha;
   for(let j=0;j<80;j++)for(let i=0;i<80;i++)if(cellAt(i,j)===code){x.beginPath();x.arc(X(i-40+.5),Y(j-40+.5),r*k,0,Math.PI*2);x.fill();}}
  x.globalAlpha=1;
  for(let j=0;j<80;j++)for(let i=0;i<80;i++){
   if(cellAt(i,j)!==3)continue;
   const cx=X(i-40),cy=Y(j-40+1);x.fillStyle=O.bank??O.dry;x.globalAlpha=.55;x.fillRect(cx,cy,k,k);
   x.save();x.beginPath();x.rect(cx,cy,k,k);x.clip();x.strokeStyle='#3a2a22';x.globalAlpha=.45;x.lineWidth=k*.12;x.beginPath();
   for(let d=-k;d<=k;d+=k/3){x.moveTo(cx+d,cy+k);x.lineTo(cx+d+k,cy);}x.stroke();x.restore();
  }
  x.globalAlpha=1;
 }
 if(world.square){const S=world.square;x.beginPath();x.arc(X(S.x),Y(S.z),(S.r+1.1)*k,0,Math.PI*2);x.fillStyle=O.worn;x.globalAlpha=.5;x.fill();
  x.beginPath();x.arc(X(S.x),Y(S.z),S.r*k,0,Math.PI*2);x.fillStyle=O.square;x.globalAlpha=.94;x.fill();
  x.beginPath();x.arc(X(S.x),Y(S.z),S.r*.55*k,0,Math.PI*2);x.strokeStyle=O.worn;x.lineWidth=.35*k;x.globalAlpha=.55;x.stroke();x.globalAlpha=1;}
 // A clear frame: the relief's skirt runs past the meadow onto clamped edge texels, which must show plain lawn.
 x.clearRect(0,0,px,2);x.clearRect(0,px-2,px,2);x.clearRect(0,0,2,px);x.clearRect(px-2,0,2,px);
 const t=new CanvasTexture(c);t.colorSpace=SRGBColorSpace;t.anisotropy=4;return t;
}
/**
 * Render-only scenery. Walkable geometry and cover remain owned by the level compiler.
 *
 * Lighting is NOT decided here: the sky, the sun, the hemisphere, the fog and the probe are
 * the session's (game/ShooterSession.js, from config/looks.js), so every material here is
 * lit by the same sky it reflects. What this file owns is the meadow's ground and the
 * placements' visuals - and every light it adds is an EMITTER handed to the session's
 * LightRig (`host.rig`), never a visible light, so the scene's light count is fixed and
 * a lamp coming into range never rebuilds a shader.
 */
/**
 * THE WORLD PAST THE RIM, COLOURED (a level on its seed's world, world/kernelGround.js): the biome's own lawn for the
 * open ground and a darker tone of it for the high ground, a beach where the land comes down to the sea, bare rock
 * where it is too steep to hold the lawn, and snow on the highest peaks of a green world. Linear colours, as the
 * ground material's colour node mixes them (render/ArcadeGround.js `far`); heights are level metres.
 */
/** How far the world's sea runs, metres: past the far plane of any view a player has, so its edge is never seen. */
const WORLD_HORIZON = 6000;
const WORLD_TINTS = {
  meadow: { beach: '#ead9a4', rock: '#a9a294', peak: '#f3f6fa' },
  desert: { beach: '#f3d9ab', rock: '#b9997a', peak: null },
  snow: { beach: '#c9d3df', rock: '#97a4b6', peak: null },
};
function worldTint(sea, ground, biome) {
  const T = WORLD_TINTS[biome] ?? WORLD_TINTS.meadow, lin = hex => new Color(hex);
  const base = lin(ground.base), high = lin(ground.tones[3] ?? ground.base), beach = lin(T.beach), rock = lin(T.rock), peak = T.peak ? lin(T.peak) : null;
  const c = new Color(), clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  return (y, slope) => {
    const up = y - sea;
    c.copy(base).lerp(high, clamp01((up - 4) / 22));
    if (peak) c.lerp(peak, clamp01((up - 40) / 6));
    c.lerp(beach, clamp01((1.6 - up) / 1.2));
    c.lerp(rock, clamp01((slope - 0.55) / 0.25));
    return [c.r, c.g, c.b];
  };
}

export function buildCombatEnvironment(host) {
 const {scene,project,level,assets,owned,renderLook:look}=host,night=project.lighting==='night';
 const track=r=>{owned.add(r);return r;};
 const anisotropy=host.performanceProfile?.mobile?2:project.quality==='performance'?4:8;
 const size=host.performanceProfile?.mobile||project.quality==='performance'?256:512;
 /**
  * Emissive rings and beacons. MeshStandard with a black base and an HDR emissive rather
  * than MeshBasic: the value leaves the pass above the bloom threshold, so a pad's ring and a
  * beacon glow the way a fixture does instead of reading as painted.
  */
 const emissive=(color,intensity)=>track(new MeshStandardMaterial({color:0x000000,emissive:color,emissiveIntensity:intensity,roughness:1,metalness:0}));
 let safe=null;
 const accent=emissive(host.accent,night?2.6:1.2),warm=emissive(look?.lighting?.lampColor??0xffcc8e,night?3.2:.6);
 const materialCache=new Map();
 // The ground: a painted tile, toon-shaded like the props on it (the kit's grass: blue-grey shade, no rim); a biome
 // paints its own (the desert's sand) from the world rules' `ground`.
 const lawn=track(lawnTexture(project.seed,size,host.worldRules?.ground??MEADOW_GROUND));lawn.repeat.set(20,20);lawn.anisotropy=anisotropy;
 const groundMaterial=host.toon?host.toon.material({color:0xffffff,map:lawn},'ARC_Grass'):track(new MeshStandardMaterial({color:0xffffff,map:lawn,roughness:.95,metalness:0}));
 // The village's ground overlay (paths, square, tints) blends over the tile inside the toon material.
 let overlay=null;
 if(level.world&&host.worldRules?.overlay){
  overlay=track(groundOverlay(project.seed,level.world,host.worldRules,80,size*2,level.regions));
  if(host.toon){const o=texture(overlay,uv());groundMaterial.colorNode=mix(texture(lawn,uv().mul(20)),o.rgb,o.a);}
 }
 // The relief (world/worldTerrain.js): the ground is the layout's own height grid, the one the player and the
 // nav grid stand on, every metre (every second metre on phones and the performance tier) plus a skirt of low hills
 // past the rim; its water is one toon mesh. A level without a village keeps the flat floor.
 const relief=level.world?.terrain&&host.worldRules?.terrain;
 const lite=!!(host.performanceProfile?.mobile||project.quality==='performance');
 // A level on its seed's world (world/kernelGround.js) draws that world past the rim, out to WORLD_BEYOND.reach, and
 // its sea to the horizon: the ground the level was cut from, at the level's own 1:8, where the village's own hills
 // end in a skirt of low hills instead.
 const onWorld=relief&&level.ground?.kind==='world'?worldAround(level.ground):null;
 if(relief){
  const beyond=onWorld?{height:onWorld.height,tint:worldTint(onWorld.sea,host.worldRules?.ground??MEADOW_GROUND,level.worldKit?.biome??'meadow')}:null;
  const geometry=buildGroundGeometry(level.world.terrain,host.worldRules.terrain.skirt,{lite,beyond});
  if(beyond){
   // The lawn (or the lawn under the paths' overlay) in the meadow, the world's own colour past the rim.
   const base=groundMaterial.colorNode??texture(lawn,uv().mul(20)),far=attribute('far','vec4');
   groundMaterial.colorNode=mix(base,far.rgb,far.a);
  }
  const floor=host._mesh(geometry,groundMaterial,0,0,0);floor.castShadow=false;floor.name='ArcadeGround';
  host.groundTris=geometry.userData.tris;
  if(onWorld){
   // The sea runs on to the horizon (WORLD_HORIZON) so it meets the sky there under the fog, with no band of the
   // sky dome's lower half showing past its edge.
   const sea=buildSeaGeometry(geometry.userData.axis,level.world.terrain.size/2,onWorld.sea,onWorld.height,{horizon:WORLD_HORIZON});
   const colours=host.worldRules.terrain.water;
   const sm=host.toon?host.toon.water(colours):track(new MeshStandardMaterial({color:colours.deep,roughness:.3,metalness:0}));
   const mesh=host._mesh(sea,sm,0,0,0);mesh.castShadow=false;mesh.receiveShadow=false;mesh.name='WorldSea';
   host.seaTris=sea.userData.tris;
   // Far enough to see the coast and the sea run on into the haze (render/Sky.js's height fog takes it from there).
   if(host.camera){host.camera.far=Math.max(host.camera.far,WORLD_HORIZON*1.1);host.camera.updateProjectionMatrix();}
  }
  if(overlay&&!host.toon){const sheet=host._mesh(geometry,track(new MeshBasicMaterial({map:overlay,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-2})),0,0,0);sheet.castShadow=false;}
  const water=level.world.water;
  if(water&&(water.ponds.length||water.brook)){
   const colours=host.worldRules.terrain.water,wg=buildWaterGeometry(water,DIRS64);
   const wm=host.toon?host.toon.water(colours):track(new MeshStandardMaterial({color:colours.shallow,roughness:.35,metalness:0}));
   const mesh=host._mesh(wg,wm,0,0,0);mesh.castShadow=false;mesh.name='ArcadeWater';
   host.waterTris=wg.userData.tris;
  }
 }else{
  const floor=host._mesh(new PlaneGeometry(80,80),groundMaterial,0,-.025,0);floor.rotation.x=-Math.PI/2;
  if(overlay&&!host.toon){const sheet=host._mesh(new PlaneGeometry(80,80),track(new MeshBasicMaterial({map:overlay,transparent:true,depthWrite:false})),0,-.015,0);sheet.rotation.x=-Math.PI/2;}
 }
 const groundY=(x,z)=>level.terrain?.heightAt?.(x,z)??0;
 const flora=[],trees=[];
 for(const p of level.placements) {
  if(p.collisionOnly)continue;
  // Generated flora and trees (world/worldGrammar.js) are batched below, once the loop has gathered them all.
  if(p.part){flora.push(p);continue;}
  if(p.tree){trees.push(p);continue;}
  // A generated house (world/houseGrammar.js), assembled for this placement; its lot's front faces the yaw.
  if(p.house){
   const model=host._houseVisual?.(p);if(!model)continue;
   const pivot=new Group();pivot.add(model);pivot.position.set(p.x,p.y,p.z);pivot.rotation.y=p.yaw;scene.add(pivot);host.placementVisuals.set(p,pivot);
   host.worldModels?.add(pivot,{simplify:false});
   continue;
  }
  // A village landmark (world/worldLandmarks.js) from the landmark library; its moving parts (sails, a wheel) are
  // registered with the session's spinners, one transform each per frame.
  if(p.landmark&&!p.collisionOnly){
   const model=host._landmarkVisual?.(p);if(!model)continue;
   const pivot=new Group();pivot.add(model);pivot.position.set(p.x,p.y,p.z);pivot.rotation.y=p.yaw;scene.add(pivot);host.placementVisuals.set(p,pivot);
   for(const s of model.userData.spinners??[])host.spinners?.push(s);
   host.worldModels?.add(pivot,{simplify:false});
   continue;
  }
  if(p.role==='checkpoint'){const marker=host._mesh(new RingGeometry(1.8,1.9,32),accent,p.x,(p.y??0)+.02,p.z);marker.rotation.x=-Math.PI/2;continue;}
  // A placed checkpoint (world/level/apply.js): a ring on the ground in the colour of a safe place, where a lost life
  // comes back.
  if(p.role==='respawn'){const marker=host._mesh(new RingGeometry(1.35,1.5,32),safe??=emissive(0x5ad8c4,night?2.2:1),p.x,(p.y??0)+.03,p.z);marker.rotation.x=-Math.PI/2;continue;}
  // Records that carry no model of their own (a marker the level script reads, nothing to draw) stop here.
  if(!p.model)continue;
  {
   // A gear prop names one node of a shared file (a key's or a padlock's colour); it stands at the file's origin.
   const source=assets.get(p.model).gltf.scene,node=p.node?source.getObjectByName(p.node):null;
   const model=(node??source).clone(true);if(node)model.position.set(0,0,0);
   const b=new Box3().setFromObject(model),center=b.getCenter(new Vector3());
   const pivot=new Group();model.scale.multiplyScalar(p.scale);model.position.set(-center.x*p.scale,-b.min.y*p.scale,-center.z*p.scale);
   pivot.add(model);pivot.position.set(p.x,p.y+(p.lift??0),p.z);pivot.rotation.y=p.yaw;scene.add(pivot);host.placementVisuals.set(p,pivot);
   // Authored moving parts: a gate's hinged doors (swung open by the session) and a floating crystal (spun).
   const doors=['Door_L','Door_R'].map(n=>model.getObjectByName(n));if(doors.every(Boolean))pivot.userData.doors=doors;
   const crystal=model.getObjectByName('Crystal');if(crystal){crystal.userData.restY=crystal.position.y;host.spinners?.push(crystal);}
   // A lever's handle turns about its hinge (the node's origin); the session throws it from back to forward.
   const handle=p.lever?model.getObjectByName('Handle'):null;if(handle){handle.rotation.x=-.62;pivot.userData.handle=handle;}
   // A pickup's node with `extras.arc_bob` (Arcade's pouch, honey jar, fizz-bomb) hovers that far up and spins the same way.
   model.traverse(o=>{if(o!==crystal&&typeof o.userData.arc_bob==='number'){o.userData.restY=o.position.y+o.userData.arc_bob;host.spinners?.push(o);}});
   model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;
    // v2 props (Arcade's included) ship colours calibrated for the engine, so they skip the legacy tint.
    if(!p.model.startsWith('imports/')&&!p.model.startsWith('assets/v2/')){o.material=Array.isArray(o.material)?o.material.map(tint):tint(o.material);}}});
   // Arcade: toon materials and outline shells on this clone, before the mobile batch hides its parts.
   host.toon?.apply(model);
   // Arcade's low-poly silhouettes are already game-ready: mobile decimation would only chip them.
   host.worldModels?.add(pivot,{simplify:!p.model.startsWith('assets/v2/arcade/')});
   if(p.objectiveIndex!==undefined) {
    const py=p.y??0;
    const ring=host._mesh(new RingGeometry(1.3,1.35,40),track(new MeshStandardMaterial({color:0,emissive:0xffce75,emissiveIntensity:2,side:DoubleSide})),p.x,py+.012,p.z);ring.rotation.x=-Math.PI/2;
    const beacon=host._mesh(new CylinderGeometry(.028,.028,2.8,6),warm,p.x,py+1.4,p.z);beacon.userData.objective=p.objectiveIndex;
    host.rig?.add(track(new PointLight(0xffce75,night?7:2.5,5,2))).position.set(p.x,py+1.6,p.z);
   }
  }
 }
 if(trees.length){
  const batch=host._treeBatch?.(trees);
  if(batch){scene.add(batch);host.worldModels?.add(batch,{simplify:false});}
 }
 if(flora.length&&host.natureLibrary){
  // lod 0 everywhere, 1 dropped on phones, 2 dropped on phones and the performance tier.
  const tier=host.performanceProfile?.mobile?0:project.quality==='performance'?1:2;
  const batch=createNatureBatch(host.natureLibrary).build(flora.filter(p=>(p.lod??0)<=tier),{sway:host.worldRules?.sway??[]});
  batch.traverse(o=>{if(o.isMesh){track(o.geometry);o.castShadow=true;o.receiveShadow=true;}});
  host.toon?.apply(batch);scene.add(batch);host.worldModels?.add(batch,{simplify:false});
 }
 function tint(source){if(materialCache.has(source))return materialCache.get(source);const m=track(source.clone());materialCache.set(source,m);m.color.multiplyScalar(.65);m.roughness=.8;m.metalness=.2;return m;}
 const ex=level.extraction??level.spawn.position;
 host.extractionRing=host._mesh(new RingGeometry(2.4,2.47,48),accent,ex.x,groundY(ex.x,ex.z)+.014,ex.z);host.extractionRing.rotation.x=-Math.PI/2;
}
