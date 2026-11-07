/** Material identity for mobile batches. Texture identity includes sampler/UV state. */
export function materialKey(m){
 const key={type:m.type,name:m.name};
 for(const [name,value]of Object.entries(m)){
  if(['uuid','id','version','_listeners','userData'].includes(name)||typeof value==='function')continue;
  if(value?.isTexture)key[name]=value.uuid;
  else if(value?.isColor||value?.isVector2||value?.isVector3||value?.isVector4)key[name]=value.toArray();
  else if(value===null||['number','string','boolean'].includes(typeof value))key[name]=value;
 }
 return JSON.stringify(key);
}
