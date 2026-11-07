/** Presentation observes committed simulation state; it never changes gameplay timing. */
export class GameAudio {
  constructor(audio, game) {
    Object.assign(this, {audio, game});
    this.completed = new Set(); this.taken = new Set();
    this.lastStep=0;this.lastTick = game.tick; this.lastHealth = game.player.health;
    this.lastPosition = game.player.position.clone(); this.hold = null;
    game.player.onJump = () => audio.playOneShot('jump');
    game.player.onLand = () => audio.playOneShot('land', {gain:.5});
  }
  update({interact=false}={}) {
    const {game:g,audio:a} = this;
    if (g.tick === this.lastTick) return;
    if (g.tick < this.lastTick) { this.completed.clear(); this.taken.clear(); this.lastHealth = g.player.health;this.lastStep=0; }
    this.lastTick = g.tick;
    if(g.objectives?.index!==this.lastStep){this.lastStep=g.objectives?.index;if(!g.objectives?.complete)a.feedback?.(g.objectives?.current?.id==='counterattack'?'incoming':'checkpoint');}
    if(interact&&!this.interactHeld&&!g.interactions.target){
      const locked=(g.objectives?.targets??[]).find(t=>!t.complete&&!t.canInteract(g.player)&&Math.hypot(t.anchor.x-g.player.position.x,t.anchor.z-g.player.position.z)<3);
      if(locked)a.playOneShot('doorUnavailable',{position:locked.anchor});
    }
    this.interactHeld=interact;
    const p = g.player, moving = Math.hypot(p.position.x-this.lastPosition.x,p.position.z-this.lastPosition.z) > .001;
    this.lastPosition.copy(p.position);
    if (moving && p.grounded && p.alive) {
      a.startActionVoice('player:steps','steps'); a.setActionVoiceRate('player:steps',p.sprinting ? 1.4 : 1);
    } else a.stopActionVoice('player:steps',80);
    if (p.health < this.lastHealth) a.play('playerHurt'); this.lastHealth = p.health;
    const target = g.interactions.holding ? g.interactions.target : null;
    const hold = target ? `interaction:${target.id}` : null;
    if (this.hold && this.hold !== hold) a.stopActionVoice(this.hold,60);
    if (hold) a.startActionVoice(hold,'computerLoading',{position:target.anchor});
    this.hold = hold;
    for (const t of g.objectives?.targets ?? []) if (t.complete && !this.completed.has(t)) {
      this.completed.add(t); a.stopActionVoice(`interaction:${t.id}`,40);
      a.playOneShot(t.record.interaction === 'activate' ? 'computerActivated' : 'doorOpened',{position:t.anchor});
    }
    for (const item of g.supplies.items) if (item.taken && !this.taken.has(item)) {
      this.taken.add(item); a.playOneShot('uiClick');
    }
  }
  pause() { this.audio.pause(); this.hold=null; this.interactHeld=false; this.lastPosition.copy(this.game.player.position); }
}
