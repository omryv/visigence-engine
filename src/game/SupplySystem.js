/** Seeded supplies replenish actual runtime resources once per run. Keys and honey drops are the level script's. */
const SUPPLIES=['health','ammo','grenade'];
export class SupplySystem{
 constructor(game){this.game=game;this.items=(game.level.placements??[]).filter(p=>SUPPLIES.includes(p.pickup)).map(record=>({record,taken:false}));}
 reset(){for(const item of this.items)item.taken=false;}
 fixedUpdate(){
  const g=this.game;
  for(const item of this.items){if(item.taken||Math.hypot(g.player.position.x-item.record.x,g.player.position.z-item.record.z)>1.4)continue;
   let given=0;
   if(item.record.pickup==='health'){const before=g.player.health;g.player.heal(40);given=g.player.health-before;}
   if(item.record.pickup==='ammo')given=g.weapons?.addLoadoutAmmo(60)??0;
   if(item.record.pickup==='grenade')given=g.grenades?.addGrenades(1)??0;
   if(given>0)item.taken=true;
  }
 }
}
