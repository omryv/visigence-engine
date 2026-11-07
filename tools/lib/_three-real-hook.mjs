// Use the vendored Three.js implementation for CPU scene/reload verification.
// No renderer or browser is instantiated.
import { register } from 'node:module';
const three=new URL('../../vendor/three/build/three.webgpu.min.js',import.meta.url).href;
const addons=new URL('../../vendor/three/examples/jsm/',import.meta.url).href;
const tsl=new URL('../../vendor/three/build/three.tsl.min.js',import.meta.url).href;
register('data:text/javascript,'+encodeURIComponent(`
  export function resolve(s,c,next){
    if(s==='three'||s==='three/webgpu')return {url:${JSON.stringify(three)},shortCircuit:true};
    if(s.startsWith('three/addons/'))return {url:${JSON.stringify(addons)}+s.slice('three/addons/'.length),shortCircuit:true};
    if(s==='three/tsl')return {url:${JSON.stringify(tsl)},shortCircuit:true};
    return next(s,c);
  }
`),import.meta.url);
