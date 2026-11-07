import { Interactable } from '../interaction/Interactable.js';
import { ExtractionGuidance } from '../sim/ExtractionGuidance.js';
import { PLAYER, INTERACTION } from '../config/gameplay.js';
import { OBJECTIVE_KINDS } from '../world/blueprint.js';
import { CATALOG } from '../world/catalog.js';

class MissionTarget extends Interactable {
  constructor(owner,record,index){
    super({id:`mission:${index}`,anchor:{x:record.x,y:record.y??0,z:record.z},height:record.height,radius:record.radius,maxDistance:3,blockerId:`prop:${index}:${record.id}`});
    this.owner=owner;this.record=record;this.reset();
  }
  reset(){this.progress=0;this.complete=false;this.health=180;}
  canInteract(player){return player.alive&&!this.complete&&(this.record.stepId===null||this.owner.current?.id===this.record.stepId);}
  getPrompt(){return {key:'E',label:{activate:'Activate controls',override:'Override door',barricade:'Force barricade'}[this.record.interaction],progress:this.progress};}
  interact(player,dt){if(!this.canInteract(player))return false;this.progress=Math.min(1,this.progress+dt/this.record.holdTime);if(this.progress>=1-1e-9)this.finish();return this.complete;}
  finish(){this.progress=1;this.complete=true;if(this.record.interaction!=='activate')this.owner.collision.setBlockerActive(this.blockerId,false);}
  idle(dt){if(!this.complete)this.progress=Math.max(0,this.progress-INTERACTION.cancelDecay*dt);}
}
/** Executes the graph's connected mission sequence; rendering cannot advance a step. */
export class BlueprintObjectives {
  constructor(game){
    this.game=game;this.collision=game.collision;this.interactions=game.interactions;
    this.steps=game.level.blueprint.mission;this.pools=game.level.blueprint.pools;
    this.targets=game.level.placements.flatMap((p,i)=>p.interaction?[this.interactions.register(new MissionTarget(this,p,i))]:[]);
    this.stations=this.targets.filter(t=>t.record.interaction==='activate');
    this.extraction=game.level.extraction?{x:game.level.extraction.x,y:game.level.extraction.y,z:game.level.extraction.z}:{...game.level.spawn.position};this.guidance=new ExtractionGuidance(this.collision,PLAYER.radius);this.reset();
  }
  get current(){return this.steps[this.index];}
  reset(){
    this.index=0;this.complete=false;this.entered=false;this.elapsed=0;this.wave=0;this.pending=0;this.activeIds=[];this.route=null;
    this.guidance.reset();
    for(const t of this.targets){t.reset();this.collision.setBlockerActive(t.blockerId,true);}
  }
  damage(blockerId,amount){const target=this.targets.find(t=>t.blockerId===blockerId&&t.record.interaction==='barricade');if(target&&target.record.stepId===this.current?.id&&!target.complete){target.health-=Math.max(0,amount);if(target.health<=0)target.finish();}}
  explode(position,radius,damage){for(const t of this.targets)if(Math.hypot(t.anchor.x-position.x,t.anchor.z-position.z)<radius&&this.collision.hasLineOfSight(position.x,position.z,t.anchor.x,t.anchor.z,false,t.blockerId))this.damage(t.blockerId,damage);}
  enter(){
    this.entered=true;this.elapsed=0;this.wave=0;this.activeIds=[];this.pending=0;
    if(['waves','boss','survive'].includes(this.current.objective))this.spawnWave();
  }
  spawnWave(){
    this.wave++;this.pending=this.current.objective==='boss'?1:this.game.level.project.enemyCount;
    this.activeIds=[];this.fillWave();
  }
  fillWave(){
    const catalog=CATALOG[this.game.level.project.theme].enemies;
    let roster=this.pools.enemies;
    if(this.current.objective==='boss')roster=roster.filter(id=>catalog.find(e=>e.id===id)?.boss);
    if(!roster.length)throw Error('The connected enemy pool cannot supply this encounter');
    while(this.pending>0){
      const type=roster[(this.pending+this.wave-1)%roster.length];
      const enemy=this.game.enemies.spawn(type,{authored:true,alerted:true});
      if(!enemy)break;
      this.activeIds.push(enemy.id);this.pending--;
    }
  }
  advance(){this.index++;this.entered=false;this.guidance.reset();this.route=null;if(this.index>=this.steps.length)this.complete=true;}
  fixedUpdate(dt){
    if(this.complete)return;if(!this.entered)this.enter();this.elapsed+=dt;
    const step=this.current,targets=this.targets.filter(t=>t.record.stepId===step.id),player=this.game.player;
    if(['activate','override','barricade'].includes(step.objective)){
      if(targets.length&&targets.every(t=>t.complete))this.advance();
    }else if(step.objective==='eliminate'){
      if(this.game.enemies.aliveCount===0)this.advance();
    }else if(['waves','boss'].includes(step.objective)){
      if(this.pending)this.fillWave();
      if(!this.pending&&!this.game.enemies.enemies.some(e=>e.alive&&this.activeIds.includes(e.id))){
        if(step.objective==='waves'&&this.wave<step.count)this.spawnWave();else this.advance();
      }
    }else if(step.objective==='survive'){
      // Hold out for the step's time: a cleared wave is followed by the next until the clock runs out.
      if(this.pending)this.fillWave();
      if(this.elapsed>=step.duration)this.advance();
      else if(!this.pending&&!this.game.enemies.enemies.some(e=>e.alive&&this.activeIds.includes(e.id)))this.spawnWave();
    }else if(step.objective==='collect'){
      // The level script counts the honey drops taken (the placed ones and the ones this step laid out).
      if(this.game.script.collected>=Math.min(step.count,Math.max(1,this.game.script.total)))this.advance();
    }else{
      const target=step.objective==='reach'?this.game.level.placements.find(p=>p.stepId===step.id):this.extraction;
      this.route=this.guidance.update(dt,player,target);
      const near=Math.hypot(player.position.x-target.x,player.position.z-target.z)<2.6;
      if(near&&(step.objective!=='extract'||this.elapsed>=step.duration))this.advance();
    }
  }
  get hudState(){
    const step=this.current;
    const targets=this.targets.filter(t=>t.record.stepId===step?.id),script=this.game.script;
    // A collect step points at the nearest drop still lying there.
    const drop=step?.objective==='collect'?script.drops.filter(d=>!d.taken).map(d=>d.record).sort((a,b)=>Math.hypot(a.x-this.game.player.position.x,a.z-this.game.player.position.z)-Math.hypot(b.x-this.game.player.position.x,b.z-this.game.player.position.z))[0]:null;
    const target=drop??targets.find(t=>!t.complete)?.anchor??(step?.objective==='reach'?this.game.level.placements.find(p=>p.stepId===step.id):step?.objective==='extract'?this.extraction:null);
    const player=this.game.player,dx=target?target.x-player.position.x:0,dz=target?target.z-player.position.z:0;
    const angle=Math.atan2(-dx,-dz)-player.yaw,bearing=Math.atan2(Math.sin(angle),Math.cos(angle));
    return {phase:this.complete?'COMPLETE':step?.objective?.toUpperCase(),completed:this.index,total:this.steps.length,extraction:this.extraction,route:this.route,
      targetsCompleted:step?.objective==='collect'?script.collected:targets.filter(t=>t.complete).length,targetsTotal:step?.objective==='collect'?Math.min(step.count,script.total):targets.length,
      timeLeft:step?.objective==='survive'?Math.max(0,Math.ceil(step.duration-this.elapsed)):null,
      targetDistance:target?Math.round(Math.hypot(dx,dz)):null,targetDirection:Math.abs(bearing)>2.35?'↓':Math.abs(bearing)<.78?'↑':bearing>0?'←':'→',
      encounterRemaining:['waves','boss'].includes(step?.objective)?this.pending+this.game.enemies.enemies.filter(e=>e.alive&&this.activeIds.includes(e.id)).length:step?.objective==='eliminate'?this.game.enemies.aliveCount:null,
      label:this.complete?'MISSION COMPLETE':`${OBJECTIVE_KINDS[step.objective].label.toUpperCase()}${step.objective==='waves'?` · WAVE ${Math.max(1,this.wave)}/${step.count}`:step.objective==='survive'?` · ${Math.max(0,Math.ceil(step.duration-this.elapsed))} S`:''}`,
      target};
  }
  dispose(){for(const t of this.targets)this.interactions.unregister(t.id);}
}
