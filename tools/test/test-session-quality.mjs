import assert from 'node:assert/strict';
import {sessionQuality,qualityOverride,FramePacer,SessionAdaptation} from '../../src/core/SessionQuality.js';
import {studioProfile} from '../../src/config/looks.js';
import {PROFILES} from '../../src/config/quality.js';
const signals={handheld:true,software:false};
for(const quality of ['performance','balanced','quality']){
 const d=sessionQuality(quality,{signals:{handheld:false}});
 assert.deepEqual(d.profile,studioProfile(quality,PROFILES.standard),'desktop post/lighting settings must remain identical');
 const m=sessionQuality(quality,{signals});
 assert.equal(m.name,'Mobile-Low');assert.equal(m.maxPixelRatio,1);assert(m.shadowMapSize<=1024);
 for(const key of ['postFX','ao','dof','traa','bloom'])assert.equal(m.profile[key],false);
 assert.equal(m.maxTextureSize,1024);
 // MSAA is the only anti-aliasing a policy without a temporal resolve has; every tier asks for it explicitly.
 assert.equal(m.antialias,true,'mobile policies must request multisampling');assert.equal(d.antialias,true);
}
assert.equal(qualityOverride('?profile=Desktop'),null);
assert.equal(qualityOverride('?debug=1&profile=Mobile-High'),'Mobile-High');
for(const hz of [60,90,120])for(const cap of [30,60]){
 const p=new FramePacer(cap);let frames=0;
 for(let i=0;i<hz*10;i++)if(p.ready(i*1000/hz))frames++;
 assert(Math.abs(frames-cap*10)<=1,`${hz}Hz display should sustain ${cap}FPS, got ${frames/10}`);
}
const m=sessionQuality('quality',{signals});const a=new SessionAdaptation(m);
for(let i=0;i<180;i++)a.sample(1000/60); // shader warmup
for(let i=0;i<39;i++)a.sample(50);assert.equal(a.scale,.85,'hold slow frames for two seconds');
for(let i=0;i<10;i++)a.sample(50);assert.equal(a.scale,.8);
for(let i=0;i<300;i++)a.sample(50);assert.equal(a.scale,.7,'respect mobile floor');
for(let i=0;i<60*60;i++)a.sample(1000/60);
assert.equal(m.name,'Mobile-High','promotion requires sustained timing, no hardware model');assert(a.scale>.85&&a.scale<=1);
const battery=new SessionAdaptation(sessionQuality('quality',{signals}),30);
for(let i=0;i<30*20;i++)battery.sample(1000/30);assert.equal(battery.scale,.85,'battery pacing must not trigger false overload');
const desktop=new SessionAdaptation(sessionQuality('quality',{signals:{handheld:false}}));
for(let i=0;i<1000;i++)desktop.sample(50);assert.equal(desktop.scale,1,'desktop resolution unchanged');
console.log('Desktop invariants, mobile limits, pacing, overload, recovery and battery mode passed');
