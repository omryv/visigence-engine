/** Opt-in telemetry. Frame intervals are measured, GPU texture bytes are estimated. */
export class PerformanceMonitor {
  constructor(host) {
    this.host=host;this.observed=new WeakSet();this.samples=[];this.histogram=new Map();this.totalMs=0;this.sampleCount=0;this.frames=0;this.started=0;this.lastSample=0;
    this.metrics={fps:0,frameMs:0,onePercentLow:0,draws:0,triangles:0,geometryCount:0,textureMiB:0,renderScale:1,loadMs:0};
    this.element=document.createElement('pre');this.element.id='performance-debug';
    Object.assign(this.element.style,{position:'fixed',top:'8px',right:'8px',zIndex:10000,margin:0,padding:'9px',background:'#061018ed',color:'#cffff0',font:'11px/1.5 monospace',pointerEvents:'none',maxWidth:'calc(100vw - 32px)'});
    document.body.append(this.element);
  }
  reset(loadMs=0){this.samples=[];this.histogram=new Map();this.totalMs=0;this.sampleCount=0;this.frames=0;this.started=0;this.last=0;this.metrics.loadMs=loadMs;}
  beginFrame(){
    this.drawAudit={};this.triangleAudit={};
    const visit=o=>{if(!o.isMesh||this.observed.has(o))return;this.observed.add(o);
      const previous=o.onBeforeRender;
      o.onBeforeRender=(...args)=>{previous?.apply(o,args);let kind=o.name||'unnamed',parent=o;
        while(parent){if(parent.userData.lod!==undefined){kind=`Building LOD${parent.userData.lod}`;break;}if(parent.userData.interaction_key){kind='Doors';break;}parent=parent.parent;}
        this.drawAudit[kind]=(this.drawAudit[kind]??0)+1;const g=args[3],group=args[5],count=Math.min(g.drawRange.count,group?.count??g.index?.count??g.attributes.position.count);this.triangleAudit[kind]=(this.triangleAudit[kind]??0)+count/3*(o.isInstancedMesh?o.count:1);
      };
    };
    this.host.scene?.traverse(visit);this.host.vmScene?.traverse(visit);
  }
  sample(now) {
    if(document.hidden){this.last=0;return;}
    if(this.last){const ms=now-this.last;if(ms>0){this.samples.push(ms);this.totalMs+=ms;this.sampleCount++;const key=Math.floor(ms*10),bin=this.histogram.get(key)??{count:0,total:0};bin.count++;bin.total+=ms;this.histogram.set(key,bin);}}
    this.last=now;this.frames++;if(!this.started)this.started=now;
    // Retain up to 20 minutes at 120 Hz, with explicit count for long-device tests.
    if(this.samples.length>144000)this.samples.shift();
    if(now-this.lastSample<500)return;this.lastSample=now;
    const h=this.host,info=h.renderer.info,recent=this.samples.slice(-120),sum=a=>a.reduce((n,x)=>n+x,0);
    let remaining=Math.max(1,Math.ceil(this.sampleCount*.01)),slowCount=0,slowMs=0;
    for(const key of [...this.histogram.keys()].sort((a,b)=>b-a)){const bin=this.histogram.get(key),n=Math.min(remaining,bin.count);slowCount+=n;slowMs+=bin.total*n/bin.count;remaining-=n;if(!remaining)break;}
    const mean=recent.length?sum(recent)/recent.length:0;
    Object.assign(this.metrics,{fps:mean?1000/mean:0,frameMs:mean,averageFps:this.sampleCount?1000*this.sampleCount/this.totalMs:0,onePercentLow:slowCount?1000*slowCount/slowMs:0,draws:info.render.drawCalls??info.render.calls??0,triangles:info.render.triangles??0,geometryCount:info.memory?.geometries??0,textureMiB:estimateAssetTextureBytes(h)/1048576,drawAudit:this.drawAudit,triangleAudit:this.triangleAudit,targetFps:h.framePacer?.cap??null,renderScale:h.renderScale??1,pixelRatio:h.renderer.getPixelRatio(),profile:h.performanceProfile?.name??`Baseline-${h.project?.quality??'quality'}`,backend:h.renderer.backend?.isWebGPUBackend?'webgpu':'webgl2',frames:this.frames,elapsedSeconds:(now-this.started)/1000});
    const m=this.metrics;
    m.overBudget={draws:m.draws>=150,triangles:m.triangles>=500000,textures:m.textureMiB>=256};
    this.element.textContent=`${m.profile} / ${m.backend}\nFPS ${m.fps.toFixed(1)} | frame ${m.frameMs.toFixed(2)} ms\n1% low ${m.onePercentLow.toFixed(1)} | avg ${m.averageFps.toFixed(1)}\nDraws ${m.draws} | triangles ${m.triangles.toLocaleString()}\nTextures ~${m.textureMiB.toFixed(1)} MiB* | geometry ${m.geometryCount}\nScale ${m.renderScale.toFixed(2)} | pixel ratio ${m.pixelRatio.toFixed(2)}\nLoad ${(m.loadMs/1000).toFixed(2)} s | ${m.elapsedSeconds.toFixed(0)} s sampled\n*Asset texture estimate; excludes render targets/driver overhead`;
    this.element.dataset.metrics=JSON.stringify(m);
  }
  dispose(){this.element.remove();}
}

export function estimateAssetTextureBytes(host){
  const textures=new Set();
  const collect=root=>root?.traverse?.(o=>{for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])for(const value of Object.values(m))if(value?.isTexture)textures.add(value);});
  for(const asset of host.assets?.loaded?.values?.()??[])collect(asset.gltf.scene);
  collect(host.scene);collect(host.vmScene);for(const texture of host.assets?.surfaceTextures?.values?.()??[])textures.add(texture);
  let bytes=0;
  for(const t of textures){
    if(t.isCompressedTexture){bytes+=(t.mipmaps??[]).reduce((n,m)=>n+(m.data?.byteLength??0),0);continue;}
    const images=Array.isArray(t.image)?t.image:[t.image];
    for(const im of images){if(!im)continue;const w=im.width??im.videoWidth??0,h=im.height??im.videoHeight??0;const pixelBytes=t.type===1015?16:t.type===1016?8:4;bytes+=w*h*pixelBytes*(t.generateMipmaps?4/3:1);}
  }
  return bytes;
}
