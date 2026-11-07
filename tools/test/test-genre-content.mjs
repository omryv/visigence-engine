import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GENRE_LEVELS } from '../../src/world/genreContent.js';
import { quickMission } from '../../src/world/missionCard.js';
import { compileShooterProject, enemyTypesForProject, resolveProject } from '../../src/world/shooterProject.js';
import { CATALOG } from '../../src/world/catalog.js';
import { resolvePack } from '../../src/world/pack.js';
import { gameBundle } from '../../src/world/gameBundle.js';
import { Game } from '../../src/game/Game.js';
import { State } from '../../src/sim/GameState.js';

let missions=0;
for(const theme of Object.keys(CATALOG)){
  const source=JSON.parse(fs.readFileSync(`packs/${theme}/pack.json`));
  const pack=resolvePack(source,CATALOG[theme].measurements);
  for(const [profile,description] of Object.entries(GENRE_LEVELS)){
    for(const seed of ['K7QN-3F2A-9XBD','TEST-1234-ABCD','AAAA-BBBB-CCCC']){
      const project=quickMission(theme,seed,description.genre),level=compileShooterProject(project,pack);
      assert.equal(project.missionProfile,profile);
      assert.deepEqual(level.blueprint.mission.map(s=>s.objective),description.steps.map(s=>s[1]));
      const assets=new Set(gameBundle(project,source).assets);
      for(const p of level.placements)if(p.model)assert.ok(assets.has(p.model),`exports contain ${p.model}`);
      const game=new Game({level});game.start();
      // Exercise real collision paths, interactions, wave transitions and extraction.
      // A survive step runs its whole clock (45 s in the siege), so the budget covers it.
      for(let tick=0;tick<6000&&game.state.current!==State.VICTORY;tick++){
        const step=game.objectives.current;
        // A collect step's next drop is the first one still lying there.
        const p=step?.objective==='collect'?game.script.drops.find(d=>!d.taken&&d.record.stepId===step.id)?.record:level.placements.find(p=>p.stepId===step?.id);
        if(p){
          const z=p.z+(p.interaction?(p.halfZ??0)+.9:0);
          assert.ok(game.collision.isFree(p.x,z,.35),`${profile}/${theme}/${seed}: objective approach clear`);
          assert.ok(game.collision.findPath(game.player.position.x,game.player.position.z,p.x,z,1),`${profile}/${theme}/${seed}/${step.id}: route from ${game.player.position.x},${game.player.position.z} to ${p.x},${z} exists`);
          game.player.position.set(p.x,0,z);game.player.prevPosition.copy(game.player.position);game.player.yaw=0;
          game.player.pitch=p.interaction?Math.atan2((p.y+p.height*.65)-game.player.eyePosition.y,z-p.z):0;
        }else if(step?.objective==='extract'){
          const s=level.spawn.position;
          assert.ok(game.collision.findPath(game.player.position.x,game.player.position.z,s.x,s.z,1),'return route exists');
          game.player.position.set(s.x,0,s.z);game.player.prevPosition.copy(game.player.position);
        }
        // Combat behavior is covered by test-genres; here defeat actual encounter spawns to verify graph completion.
        for(const enemy of game.enemies.enemies)if(enemy.alive)game.enemies.damage(enemy,10000,{});
        game.step({interact:true});
      }
      assert.equal(game.state.current,State.VICTORY,`${profile}/${theme}/${seed}: mission completes (step ${game.objectives.current?.id}, prompt ${game.interactions.prompt?.label})`);
      game.restart();assert.equal(game.objectives.index,0);game.dispose();missions++;
    }
  }
}
assert.equal(resolveProject({...quickMission('arcade',undefined,'exploration'),genre:'shooter'}).missionProfile,null,'switching genre clears an incompatible route');
// Arcade fields its critters like any hostile theme; a project saved while it had no roster takes the genre's preset.
assert.equal(resolveProject({theme:'arcade',genre:'shooter',enemyCount:0}).enemyCount,3,'an enemy-free Arcade project gets the shooter preset');
// Critters fight with their bodies: no rifles, no ranged conversion, their own collision discs, and the King slime is the boss.
const critters=enemyTypesForProject(resolveProject({theme:'arcade'}));
for(const id of ['slime','shroom','bee','king'])assert.ok(critters[id]&&critters[id].attackMode!=='ranged'&&critters[id].attackRange<4,`${id} is a melee critter`);
assert.equal(critters.king.radius,1.15);assert.ok(CATALOG.arcade.enemies.find(e=>e.id==='king').boss);
// A saved blueprint that still names the retired supply barrel gets the crystal shrine that replaced it.
const saved=resolveProject({theme:'arcade'}).blueprint,props=saved.nodes.find(n=>n.kind==='props');
props.items=props.items.map(id=>id==='crystalShrine'?'supplyBarrel':id);
assert.ok(resolveProject({theme:'arcade',blueprint:saved}).blueprint.nodes.find(n=>n.kind==='props').items.includes('crystalShrine'));
assert.equal(resolveProject({...quickMission('arcade',undefined,'exploration'),enemyCount:0,genre:'shooter'}).enemyCount,3,'an enemy-free route switched to the shooter gets its preset');
assert.throws(()=>resolveProject({theme:'arcade',enemyCount:-1}),/must be 1–12/);
console.log(`${missions} navigable mission variants completed and restarted; exports include every placed model.`);
