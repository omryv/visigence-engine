import { detectProfile } from './DeviceProfile.js';
import { PROFILES } from '../config/quality.js';
import { studioProfile } from '../config/looks.js';
import { parseFxOverrides } from '../config/visualFx.js';

/** The studio's desktop look is an invariant. Mobile starts conservatively on any GPU. */
export function sessionQuality(quality='quality', detected=detectProfile(), override=null) {
  const mobile = override?.startsWith('Mobile-') || (override!=='Desktop' && detected.signals.handheld);
  const high = mobile && override==='Mobile-High';
  const desktop=studioProfile(quality,PROFILES.standard);
  return {
    name: mobile ? high?'Mobile-High':'Mobile-Low' : 'Desktop', mobile,
    detected, pinned:!!override, maxPixelRatio:mobile?1:{performance:1,balanced:1.25,quality:1.5}[quality],
    /**
     * Multisampling on every tier. The mobile policies have no post stack and no temporal
     * resolve, so the renderer's MSAA is the only anti-aliasing they can have; before this
     * they got none, because core/Renderer.js inferred it from the pixel-ratio cap (1 here).
     * Measured with tools/test/probe-sampling.mjs: two grey levels per edge without it, five with.
     * `?fx=-msaa` turns it off for an A/B on a device (config/visualFx.js); it is deliberately
     * NOT part of `?fx=off`, which must keep meaning "the profile as it was before the effects".
     */
    antialias:typeof location==='undefined'||!parseFxOverrides(location.search).off.has('msaa'),
    renderScale:mobile?(high?1:.85):1, minRenderScale:mobile?.7:1,
    maxTextureSize:mobile?1024:quality==='quality'?2048:1024,
    shadowMapSize:mobile?1024:{performance:512,balanced:1024,quality:2048}[quality],
    // Both mobile profiles share shaders. Promotion changes only resolution, avoiding a shader hitch.
    shadows:!mobile, probeSize:mobile||quality==='performance'?64:128,
    profile:mobile?{...desktop,postFX:false,ao:false,dof:false,traa:false,bloom:false,film:false,lensflare:false,ssr:false,lights:2,shadows:false,shadowMapSize:1024,anisotropy:2,particleScale:.5,maxDecals:24}:desktop,
  };
}

export function qualityOverride(search='') {
  const q=new URLSearchParams(search),p=q.get('profile');
  // Test-only: explicit profile forcing must not turn a phone into a desktop accidentally.
  return q.get('debug')==='1'&&['Mobile-Low','Mobile-High','Desktop'].includes(p)?p:null;
}

/** Deadline pacing retains the requested average on 60/90/120 Hz displays. */
export class FramePacer {
  constructor(cap=60){this.cap=cap;this.deadline=0;}
  reset(){this.deadline=0;}
  ready(now){
    const step=1000/this.cap;
    if(this.deadline && now+.5<this.deadline)return false;
    this.deadline=this.deadline?this.deadline+step:now+step;
    if(this.deadline<now-step)this.deadline=now+step;
    return true;
  }
}

/** One-second interval windows reject vsync jitter; decisions only resize the buffer. */
export class SessionAdaptation {
  constructor(policy,cap=60,onChange=()=>{}){
    this.policy=policy;this.cap=cap;this.onChange=onChange;this.scale=policy.renderScale;
    this.ceiling=this.scale;this.reset();this.changes=[];
  }
  reset(){this.elapsed=0;this.count=0;this.over=0;this.stable=0;this.recovery=0;this.warmup=3;this.worst=0;}
  sample(ms){
    if(!this.policy.mobile||!Number.isFinite(ms)||ms<=0)return;
    if(this.warmup>0){this.warmup-=ms/1000;return;}
    this.elapsed+=ms;this.count++;this.worst=Math.max(this.worst,ms);
    if(this.elapsed<1000)return;
    const seconds=this.elapsed/1000,mean=this.elapsed/this.count,budget=1000/this.cap;
    // 1 ms dead band accommodates browser timestamp/vsync jitter around 16.67 ms (33.33 in battery mode).
    const stable=mean<=budget+1&&this.worst<=budget*2+1;
    if(mean>budget+1){this.over+=seconds;this.stable=this.recovery=0;}
    else if(stable){this.stable+=seconds;this.recovery+=seconds;this.over=0;}
    else{this.over=this.stable=this.recovery=0;}
    this.elapsed=this.count=this.worst=0;
    if(this.over>=2){this.setScale(Math.max(.7,this.scale-.05),'sustained slow frames');this.over=0;}
    if(this.cap===60&&this.stable>=30&&!this.policy.pinned&&this.policy.name==='Mobile-Low'&&!this.policy.detected.signals.software){
      this.policy.name='Mobile-High';this.ceiling=1;this.stable=0;
    }
    if(this.recovery>=6){this.setScale(Math.min(this.ceiling,this.scale+.025),'sustained stable frames');this.recovery=0;}
  }
  setScale(scale,reason){
    scale=+scale.toFixed(3);if(scale===this.scale)return;
    this.scale=scale;this.changes.push({scale,reason});this.onChange(scale);
  }
}
