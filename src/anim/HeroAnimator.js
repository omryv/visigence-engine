import { AnimationMixer, LoopOnce, LoopRepeat } from 'three/webgpu';

/**
 * The hero seen from outside (third person, top-down): the pack's player character and its clips
 * (tools/blender/v2/arcade/hero.py): Idle, Walk, Run, Jump, Interact, Attack, AimIdle, AimRun, Hit, Death, Cheer.
 *
 * Presentation only: it reads what the simulation did (speed, ground, a swing in flight, a hit, the end of the run)
 * and never feeds back. Locomotion plays at the ground speed (the clips are in place: Walk covers ~0.85 m/s, Run
 * ~2.4 m/s), so the feet do not skate; one-shots (a swing, a flinch) cross-fade in and hand back when done; Death
 * and Cheer hold their last frame. A clip the file does not carry (an older hero on the asset host) falls back to
 * the nearest one it does.
 */
const LOOPS = new Set(['Idle', 'Walk', 'Run', 'AimIdle', 'AimRun']);
const HOLD = new Set(['Death', 'Cheer', 'Jump']);
const FALLBACK = { AimIdle: 'Idle', AimRun: 'Run', Attack: 'Interact', Hit: 'Idle', Death: 'Idle', Cheer: 'Jump' };
const CLIP_SPEED = { Walk: 0.85, Run: 2.4, AimRun: 2.4 };

export class HeroAnimator {
  constructor(root, clips) {
    this.root = root; this.mixer = new AnimationMixer(root); this.actions = {};
    for (const clip of clips) {
      const name = clip.name.split('_').at(-1).split('.')[0], action = this.mixer.clipAction(clip);
      if (LOOPS.has(name)) action.setLoop(LoopRepeat, Infinity);
      else { action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; }
      this.actions[name] = action;
    }
    this.oneShot = null; this.current = null; this.hitSeen = 999;
    this.set('Idle');
  }
  has(name) { return !!this.actions[name]; }
  resolve(name) { let n = name; while (!this.actions[n] && FALLBACK[n]) n = FALLBACK[n]; return this.actions[n] ? n : 'Idle'; }
  set(name, fade = 0.16) {
    const n = this.resolve(name);
    if (this.current === n) return this.actions[n];
    const next = this.actions[n], prev = this.actions[this.current];
    // A figure without the clip (an imported one with no animations, or none at all) holds its pose.
    if (!next) return null;
    next.reset(); next.timeScale = 1; next.play();
    if (prev) next.crossFadeFrom(prev, fade, true);
    this.current = n;
    return next;
  }
  /** Play a one-shot over locomotion (a swing, a flinch); it hands back when it ends. */
  play(name) {
    const n = this.resolve(name);
    if (!this.actions[n] || HOLD.has(n) && n !== 'Jump') return;
    this.oneShot = n; this.set(n, 0.08);
  }
  /**
   * @param {number} dt
   * @param {{speed: number, grounded: boolean, attacking?: boolean, hitAge?: number, dead?: boolean, won?: boolean, interacting?: boolean, aim?: boolean}} s
   */
  update(dt, s) {
    if (s.dead) { this.oneShot = null; this.set('Death', 0.1); }
    else if (s.won) { this.oneShot = null; this.set('Cheer', 0.2); }
    else {
      if (s.hitAge !== undefined && s.hitAge < this.hitSeen && s.hitAge < 0.1 && this.oneShot !== 'Attack') this.play('Hit');
      this.hitSeen = s.hitAge ?? 999;
      if (s.attacking && this.oneShot !== 'Attack') this.play('Attack');
      const shot = this.oneShot && this.actions[this.oneShot];
      if (shot && (!shot.isRunning() || shot.time >= shot.getClip().duration - 0.02)) this.oneShot = null;
      if (!this.oneShot) {
        const speed = s.speed ?? 0, aim = !!s.aim;
        let name = !s.grounded ? 'Jump' : s.interacting ? 'Interact' : speed > 3.1 ? (aim ? 'AimRun' : 'Run') : speed > 0.25 ? (aim ? 'AimRun' : 'Walk') : (aim ? 'AimIdle' : 'Idle');
        const action = this.set(name);
        const base = CLIP_SPEED[this.current];
        // Ground speed over the clip's own stride: 4.2 m/s runs the run at 1.75x; a sprint is clamped at 2x.
        if (action) action.timeScale = base ? Math.max(0.6, Math.min(this.current === 'Walk' ? 2.2 : 2, speed / base)) : 1;
      }
    }
    this.mixer.update(Math.max(0, dt));
  }
  reset() { this.mixer.stopAllAction(); this.current = null; this.oneShot = null; this.set('Idle'); }
  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root); }
}
