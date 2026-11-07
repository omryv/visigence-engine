import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectGlb } from './inspect-pack.mjs';
const title=id=>id.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,s=>s.toUpperCase());
const catalogs={};
// Arcade has no street architecture: its world is an open meadow. Its critters are generated from the pack's
// creature rules (unrigged, animated as one solid body), and its pickups, weapons and props are its own v2 art.
for(const theme of ['arcade']){
 const file=`packs/${theme}/pack.json`,pack=JSON.parse(fs.readFileSync(file));
 const enemy=[];
 if(pack.creatures){
  // Generated critters (src/world/creatureGrammar.js): each spawn is its own individual, assembled from the parts
  // library by the pack's creature rules. `hover` lifts a flier off the floor; `radius` is its collision disc.
  for(const id of Object.keys(pack.characters))if(id!=='player'&&!pack.creatures.roster.some(x=>x.id===id))delete pack.characters[id];
  for(const r of pack.creatures.roster){
   const hover=pack.creatures.families[r.family].hover??0;
   const c={model:pack.creatures.library,metres:r.height,height:r.height,archetype:r.archetype,animation:'rigid',label:r.label,preview:pack.creatures.library.replace(/[^/]+$/,`catalog/${r.id}.png`),generator:{family:r.family,...(r.rank?{rank:r.rank}:{})},radius:r.radius,...(hover?{hover}:{})};
   pack.characters[r.id]=c;enemy.push({id:r.id,...c,boss:r.rank==='boss'});
  }
 }
 // Each world option is a village the layout grows; one with a `biome` grows it from that biome of the pack
 // (packs/arcade/pack.json biomes.<id>): the desert oasis, the snow village.
 const world=[
  {id:'meadow',label:'Meadow village',description:'Open pastel meadow: painted grass, trees and a generated village',surface:'meadow',preview:'assets/v2/arcade/arcade-lookdev-review.png'},
  {id:'desert',label:'Desert oasis',description:'Sun-baked oasis town: plaster houses and domes, palms round the water, a striped market',surface:'desert',biome:'desert',preview:'assets/v2/arcade/arcade-desert-review.png'},
  {id:'snow',label:'Snow village',description:'Cozy alpine village: log cabins and timber lodges under thick snow, a bell tower over the square, a frozen pond',surface:'snow',biome:'snow',preview:'assets/v2/arcade/arcade-snow-review.png'},
 ].map(w=>({...w,interior:false,decorations:[],model:'assets/v2/arcade/arcade-ground.glb'}));
 const doors=pack.props.filter(p=>p.role==='door'&&p.opensTo||p.role==='gate').map(p=>({...p,label:p.label??title(p.id)}));
 // Gear (keys, locks, the lever, the honey drop, the staff) is placed by hand only: measured below, never a pool option.
 const props=pack.props.filter(p=>!['door','gate','gear'].includes(p.role)).map(p=>({...p,label:p.label??title(p.id)}));
 const gear=pack.props.filter(p=>p.role==='gear').map(p=>({...p,label:p.label??title(p.id)}));
 const weapons=Object.entries(pack.weapons).map(([id,w])=>({id,...w,label:w.label??title(id)}));
 // A biome swaps in its own libraries and props (world/pack.js applyBiome): every GLB it names is measured too.
 const biomeModels=[...JSON.stringify(pack.biomes??{}).matchAll(/"(assets\/[^"]+\.glb)"/g)].map(m=>({model:m[1]}));
 const models=[...Object.values(pack.characters),...weapons,...pack.props,...world,...world.flatMap(w=>w.decorations.map(model=>({model}))),...biomeModels];
 const measurements=Object.fromEntries([...new Set(models.map(a=>a.model))].map(model=>{const m=inspectGlb(model);return [model,{longest:m.longest,size:m.size,revision:createHash('sha256').update(fs.readFileSync(model)).digest('hex').slice(0,12)}];}));
 // Each biome's own take on a prop (its label and card picture), so the studio can show every village's art.
 const biomes=Object.fromEntries(Object.entries(pack.biomes??{}).map(([id,B])=>[id,{label:B.label,props:Object.fromEntries(Object.entries(B.props??{})
  .filter(([pid,p])=>p&&props.some(q=>q.id===pid)).map(([pid,p])=>[pid,{label:p.label??props.find(q=>q.id===pid).label,preview:p.preview}]))}]));
 catalogs[theme]={world,weapons,enemies:enemy,doors,props,gear,biomes,measurements};
 // Only when the catalogue changed the pack: its Python-written number formatting (1.0) is left alone otherwise.
 if(JSON.stringify(pack)!==JSON.stringify(JSON.parse(fs.readFileSync(file))))fs.writeFileSync(file,JSON.stringify(pack,null,2)+'\n');
}
fs.writeFileSync('src/world/catalog.js',"// Asset catalogue generated from the shipped pack by tools/build/build-catalog.mjs.\nexport const CATALOG = "+JSON.stringify(catalogs,null,2)+';\n');
console.log(Object.fromEntries(Object.entries(catalogs).map(([t,c])=>[t,Object.fromEntries(Object.entries(c).map(([k,v])=>[k,Array.isArray(v)?v.length:Object.keys(v).length]))])));
