/** Portable project metadata. Bytes live in IndexedDB in the studio and imports/ in a build. */
export function normalizeImportedProps(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw Error('A mission supports up to 8 imported props.');
  const seen=new Set(); let triangles=0,bytes=0;
  return value.map(a=>{
    if(!a || !/^[a-f0-9]{64}$/.test(a.id) || seen.has(a.id))throw Error('Invalid or duplicate imported prop.'); seen.add(a.id);
    const size=a.size;
    if(!Array.isArray(size)||size.length!==3||size.some(n=>!Number.isFinite(n)||n<=0||n>10000))throw Error('Imported prop has invalid dimensions.');
    const scale=Number(a.scale);if(!Number.isFinite(scale)||scale<=0||Math.max(...size)*scale>4.001||size[1]*scale<.1)throw Error('Imported props must be 0.1–4 m tall and at most 4 m wide/deep.');
    if(!['box','none'].includes(a.collision))throw Error('Choose box or decorative collision.');
    if(a.rightsConfirmed!==true||!String(a.creator??'').trim()||!String(a.license??'').trim())throw Error('Imported props need a creator, licence and rights declaration.');
    if(!Number.isInteger(a.triangles)||a.triangles<1||a.triangles>50000||!Number.isInteger(a.bytes)||a.bytes<20||a.bytes>8*1024*1024)throw Error('Imported prop exceeds the 50k triangle or 8 MB budget.');
    triangles+=a.triangles;bytes+=a.bytes;if(triangles>100000||bytes>32*1024*1024)throw Error('Mission imports exceed 100k triangles or 32 MB.');
    let transform;
    if(a.transform!=null){const {x,z,yaw=0}=a.transform;if(![x,z,yaw].every(Number.isFinite)||Math.abs(x)>54||Math.abs(z)>54||Math.abs(yaw)>Math.PI*100)throw Error('Prop position or rotation is outside the supported range.');transform={x:Math.round(x*100)/100,z:Math.round(z*100)/100,yaw:Math.atan2(Math.sin(yaw),Math.cos(yaw))};}
    return {...(transform?{transform}:{}),id:a.id,model:`imports/${a.id}.glb`,name:String(a.name||'Imported prop').slice(0,64),size:[...size],scale,collision:a.collision,triangles:a.triangles,bytes:a.bytes,creator:String(a.creator).trim().slice(0,160),source:String(a.source??'').slice(0,300),license:String(a.license).trim().slice(0,300),rightsConfirmed:true};
  });
}
export function footprint(p) {
  const c=Math.abs(Math.cos(p.yaw??p.transform?.yaw??0)),s=Math.abs(Math.sin(p.yaw??p.transform?.yaw??0));
  const x=p.halfX??p.radius??1,z=p.halfZ??p.radius??1;
  return {x:x*c+z*s,z:x*s+z*c};
}
export function placeImportedProps(imports, placements, {size=80,spawn={x:0,z:28}}={}) {
  for(const [i,a] of imports.entries()){
    const [w,h,d]=a.size.map(n=>n*a.scale),yaw=a.transform?.yaw??0;
    const half=footprint({halfX:w/2,halfZ:d/2,yaw});let point;
    const safe=({x,z})=>Math.abs(x)+half.x<size/2-2&&Math.abs(z)+half.z<size/2-2
      &&Math.hypot(x-spawn.x,z-spawn.z)>Math.hypot(half.x,half.z)+3
      &&placements.every(p=>{
        if((p.y??0)>h+.2||(p.projectileOnly&&!p.bodyCollision))return true;
        const f=footprint(p),margin=p.stepId?2.8:1.2;
        return Math.abs(p.x-x)>f.x+half.x+margin||Math.abs(p.z-z)>f.z+half.z+margin;
      });
    if(a.transform){point={x:a.transform.x,z:a.transform.z};if(!safe(point))throw Error(`${a.name} overlaps the world, another prop, or a reserved mission route. Move it to an open area.`);}
    else for(const z of [23,16,8,0,-8,-16,-24]){for(const x of [4,-4,8,-8])if(safe({x,z})){point={x,z};break;}if(point)break;}
    if(!point)throw Error(`No safe space for ${a.name}. Reduce its size or remove another prop.`);
    placements.push({...a,...point,id:`import-${i}`,y:0,yaw,role:'dressing',halfX:w/2,halfZ:d/2,height:h,radius:Math.hypot(w,d)/2,footprint:Math.max(w,d)});
  }
}
