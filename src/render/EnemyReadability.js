import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float, normalView, positionViewDirection, materialEmissive, uniform } from 'three/tsl';
import { ENEMY_SIGNATURES } from '../config/looks.js';
/** View-dependent edge light survives the lean/mobile path without another light or post pass. */
// Safari's reported first-frame regression is still awaiting a native stack trace.
// Keep its original PBR material path while retaining a restrained visibility cue.
export function classicEnemyMaterials() {
  return typeof navigator !== 'undefined' && navigator.vendor === 'Apple Computer, Inc.';
}
export function applyEnemyReadability(root, project, {classic=classicEnemyMaterials()}={}) {
  const signature=ENEMY_SIGNATURES[project.theme],cache=new Map(),threat=uniform(0);
  root.traverse(o=>{if(!o.isMesh)return;
    const tint=source=>{if(!source?.isMeshStandardMaterial)return source;if(cache.has(source))return cache.get(source);
      // A toon material (Arcade) clones as itself, so the critter keeps its toon lighting under the rim.
      const m=classic||source.isArcadeToon?source.clone():new MeshStandardNodeMaterial().copy(source);
      if(classic){
        // Preserve textures, alpha and physical properties. Never mutate the shared
        // source material used by the player or by a later generated mission.
        m.emissive.add(m.color.clone().setHex(signature.rim).multiplyScalar(project.lighting==='night'?.07:.035));
        m.emissiveIntensity=Math.max(1,m.emissiveIntensity);
      }else{
        const rim=float(1).sub(normalView.dot(positionViewDirection).abs()).pow(3);
        m.emissiveNode=materialEmissive.add(color(signature.rim).mul(rim).mul(float(project.lighting==='night'?signature.night:signature.dawn).add(threat)));
      }
      // Eyes/visors keep one identity across every asset in a theme, when authored separately.
      if(/eye|visor|lens/i.test(source.name)){m.emissive.setHex(signature.eye);m.emissiveIntensity=Math.max(.7,m.emissiveIntensity);}
      cache.set(source,m);return m;
    };o.material=Array.isArray(o.material)?o.material.map(tint):tint(o.material);
  });
  const dispose=()=>{for(const m of cache.values())m.dispose();};
  dispose.update=e=>{threat.value=e.alive&&e.state==='ATTACK_WINDUP'?.2+.6*Math.min(1,e.stateTime/e.type.attackWindup):0;};
  return dispose;
}
