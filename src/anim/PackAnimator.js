import { AnimationMixer, LoopOnce, LoopRepeat } from 'three/webgpu';
/** Exported Blender skeleton + named clips. Presentation never changes simulation state. */
export class PackAnimator {
  constructor(root, clips) {
    this.root = root; this.mixer = new AnimationMixer(root); this.actions = {};
    for (const clip of clips) {
      const name = clip.name.split('_').at(-1).split('.')[0];
      const action = this.mixer.clipAction(clip); this.actions[name] = action;
      if (name === 'Death' || name === 'Attack') { action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; }
      else action.setLoop(LoopRepeat, Infinity);
    }
    this.set('Idle');
  }
  set(name) {
    if (this.current === name || !this.actions[name]) return;
    const previous = this.actions[this.current], next = this.actions[name];
    next.reset().play(); if (previous) next.crossFadeFrom(previous, .18, true);
    this.current = name;
  }
  update(dt, state = {}) {
    const speed = state.speed ?? state.velocity?.length() ?? 0;
    const name = state.dead || state.state === 'DEAD' || state.state === 'DYING' ? 'Death'
      : state.state?.startsWith('ATTACK') && this.actions.Attack ? 'Attack' : state.reloading ? 'Reload' : speed > 3.2 ? 'Run' : speed > .15 ? 'Walk' : 'Idle';
    this.set(name); this.mixer.update(Math.max(0, dt));
  }
  restPose() { this.set('Idle'); this.mixer.update(0); }
  reset() { this.mixer.stopAllAction(); this.current = ''; this.set('Idle'); }
  kickStagger() {}
  setDeathDirection() {}
  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root); }
}
