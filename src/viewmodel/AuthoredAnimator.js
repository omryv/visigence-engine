/**
 * Runs an AUTHORED assembly's clips against the weapon state machine.
 *
 * Owned by PackViewmodel, which hands it the rig and the per-frame weapon state. The
 * division of authority is the one the animation READMEs ask for and the one the rest of
 * this view model already keeps: the WEAPON CONTROLLER owns every duration,
 * every ammo marker and every shot, and the clips are fitted to it - never the other way
 * round - so the magazine is seated on the frame `commitAmmo` fires and the equip is over
 * when EQUIPPING is.
 *
 *   IDLE LOOP     always playing. Its weight is what is left after the one-shot, scaled
 *                 down at full aim (AUTHORED_ANIM.idleAtAds) so a sight picture does not
 *                 breathe. A v2 rig's own aim pose replaces it outright (see AIM).
 *   ONE-SHOT      one at a time: equip, holster, fire, inspect, reload, reloadEmpty. A
 *                 state-bound one-shot (everything but fire) is cancelled the moment the
 *                 state machine leaves its state, which is how a reload interrupted by a
 *                 weapon switch, a death or a pause hands the hands back. `fire` is
 *                 restarted on every accepted shot: at 600 RPM that shows the first tenth
 *                 of the recoil clip per round and the whole recovery after the last one,
 *                 which is what the SMG README asks for instead of looping the recovery.
 *                 A v2 rig's aimed shots (`_AimShoot`, `_AimShoot_B`, ...) run beside the
 *                 hip shot with the same suffix, the pair split by the ADS blend.
 *   AIM           the AimIn clip, held on its LAST frame at a weight equal to the ADS
 *                 blend. The transition is then the same curve that moves the ADSRoot, the
 *                 world FOV and the sensitivity, so the hands cannot arrive before the
 *                 sights do. An authored assembly's AimIn lost its root track at load
 *                 (AuthoredRig) and only tightens the hands; a v2 rig's AimIn is the whole
 *                 aimed pose, arms and weapon, so at full aim the idle gives it all its
 *                 weight. A rig with no AimIn aims its idle's first frame, held still:
 *                 without a pose in the slot, three's mixer would fill the missing weight
 *                 with the bind pose and pull the arms off the weapon.
 *
 * WEIGHTS ARE WRITTEN, NOT FADED. three's fadeIn/fadeOut schedule interpolants that fight
 * a weight written from state, so every weight here is recomputed each frame from three
 * scalars (the one-shot's blend in, the previous one-shot's blend out, the aim blend) and a
 * zero-dt update reproduces the previous frame exactly, as every other layer promises.
 */

import { AUTHORED_ANIM } from '../config/viewmodel.js';
import { LOOPING_CLIPS } from './AuthoredRig.js';
import { clamp, damp } from '../utils/math.js';

/** The weapon state each one-shot belongs to. Leaving that state cancels the clip. */
const ONE_SHOT_STATE = {
  equip: 'EQUIPPING',
  holster: 'UNEQUIPPING',
  inspect: 'INSPECTING',
  reload: 'RELOADING',
  reloadEmpty: 'RELOADING',
};

export class AuthoredAnimator {
  constructor(cfg = AUTHORED_ANIM) {
    this.cfg = cfg;
    this.rig = null;
    this.def = null;
    /** The running one-shot: {name, action, aimAction, blend, state, done}. */
    this.active = null;
    /** The one-shot on its way out, held on its last pose while it fades. */
    this.outgoing = null;
    this.idle = null;
    this.aim = null;
    this.reloadParts = [];
  }

  /** Bind a rig. Every action is stopped, the idle restarted, the aim primed. */
  setRig(rig, def) {
    this.rig = rig;
    this.def = def;
    this.active = null;
    this.outgoing = null;
    this.drawn = false;
    const mixer = rig.mixer;
    mixer.stopAllAction();
    this.reloadParts = (rig.authored?.reloadResetNodes || []).map(name => {
      const node = rig.root.getObjectByName(name);
      if (!node) throw new Error(`Missing reload part: ${name}`);
      return { node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() };
    });
    this.idle = rig.actions.idle || null;
    if (this.idle) this.idle.reset().setEffectiveWeight(1).play();
    // Movement loops (v2 rigs): always running, weighted from speed and state in update().
    this.walk = rig.actions.walk || null; this.sprint = rig.actions.sprint || null;
    this.walkW = 0; this.sprintW = 0; this.lastFire = null;
    for (const loop of [this.walk, this.sprint]) if (loop) loop.reset().setEffectiveWeight(0).play();
    this.aim = rig.actions.ads || null;
    this.idleAtAds = rig.v2 && this.aim ? 0 : this.cfg.idleAtAds;
    if (!this.aim && this.idle) {
      // No AimIn: a copy of the idle, parked on its first frame, is the aim pose.
      rig.stillAim ??= mixer.clipAction(this.idle.getClip().clone());
      this.aim = rig.stillAim;
    }
    if (this.aim) {
      // Parked (an AimIn on its final pose, the still idle on its first); only its weight
      // moves, with the ADS blend.
      this.aim.reset().play();
      this.aim.time = this.aim === rig.actions.ads ? Math.max(0, rig.clipDurations.ads - 1e-4) : 0;
      this.aim.setEffectiveTimeScale(0).setEffectiveWeight(0);
    }
    mixer.update(0);
  }

  hasClip(name) { return !!this.rig?.actions[name]; }

  /**
   * How long the state this clip plays under lasts, in seconds, or 0 for "not fitted".
   * Read from the weapon definition, which is the state machine's own source.
   */
  _stateDuration(name) {
    const d = this.def;
    if (!d) return 0;
    switch (name) {
      case 'equip': return d.equipTime;
      case 'holster': return d.unequipTime;
      case 'inspect': return d.inspectTime;
      case 'reload': return d.reload.timeline.complete;
      case 'reloadEmpty': return d.reload.emptyTimeline.complete;
      default: return 0;
    }
  }

  /**
   * Start a one-shot by semantic name. Returns false when the rig has no such clip, so the
   * caller can fall back to its procedural motion for that name.
   *
   * A clip fitted to a state runs at clipDuration / stateDuration, so its last frame lands
   * on the state's last step; inside `fitTolerance` it keeps its authored speed instead.
   */
  play(name) {
    const action = name === 'fire' ? this._fireClip() : this.rig?.actions[name];
    if (!action || LOOPING_CLIPS.has(name)) return false;
    // The aimed version of this shot, if the rig has one; update() splits the weight.
    const aimAction = name === 'fire' ? this.rig.aimFire?.get(action) ?? null : null;
    if (name === 'fire' && this.active?.name === 'fire' && this.active.action !== action) {
      // Another shot variant mid-burst: hand the running weight straight to it, no fade gap.
      this._each(this.active, (x) => x.stop());
      if (this.outgoing?.action === action) this.outgoing = null;
      action.reset().setEffectiveTimeScale(1).setEffectiveWeight(this.active.blend).play();
      aimAction?.reset().setEffectiveTimeScale(1).play();
      this.active.action = action; this.active.aimAction = aimAction; this.active.done = false;
      return true;
    }
    const authored = this.rig.clipDurations[name];
    const wanted = this._stateDuration(name);
    let timeScale = 1;
    if (wanted > 0 && authored > 0 && Math.abs(authored / wanted - 1) > this.cfg.fitTolerance) {
      timeScale = authored / wanted;
    }
    if (this.active?.action === action) {
      // The same clip again (a burst): restart in place, weight untouched.
      action.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(this.active.blend).play();
      aimAction?.reset().setEffectiveTimeScale(timeScale).play();
      this._each(this.active, (x) => { x.paused = false; });
      this.active.done = false;
      return true;
    }
    // An equip on a rig nothing has drawn yet (it was bound this step) starts on its own
    // first frame: fading in from the idle would show the weapon up for a frame, then drop it.
    const cut = name === 'equip' && !this.drawn;
    if (this.active) this._retire(this.active);
    // The clip may still be fading out from its last run; it is taken back whole.
    if (this.outgoing?.action === action) this.outgoing = null;
    action.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(cut ? 1 : 0).play();
    aimAction?.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(0).play();
    this.active = { name, action, aimAction, blend: cut ? 1 : 0, state: ONE_SHOT_STATE[name] ?? null, done: false };
    return true;
  }

  /** Apply fn to a one-shot slot's action and to its aimed partner, if it has one. */
  _each(slot, fn) {
    fn(slot.action);
    if (slot.aimAction) fn(slot.aimAction);
  }

  /** A one-shot's weight, split between the hip clip and its aimed partner by the ADS blend. */
  _weigh(slot, w, ads) {
    if (!slot.aimAction) { slot.action.setEffectiveWeight(w); return; }
    slot.action.setEffectiveWeight(w * (1 - ads));
    slot.aimAction.setEffectiveWeight(w * ads);
  }

  /** The shot clip for this round: the next variant in turn when the rig has several, so no two rounds in a row use
   *  the same one (in order, not drawn: nothing in the engine is random). */
  _fireClip() {
    const v = this.rig?.fireVariants;
    if (!v || v.length < 2) return this.rig?.actions.fire;
    const i = v.indexOf(this.lastFire);
    return (this.lastFire = v[(i + 1) % v.length]);
  }

  /** Stop a named one-shot if it is the running one (the controller's `stop`). */
  stop(name) {
    if (this.active?.name === name) { this._retire(this.active); this.active = null; }
  }

  /** Hold a one-shot on its current pose and start fading it out. */
  _retire(slot) {
    if (this.outgoing && this.outgoing.action !== slot.action) {
      this._each(this.outgoing, (x) => { x.setEffectiveWeight(0); x.stop(); });
    }
    this._each(slot, (x) => { x.paused = true; });
    this.outgoing = slot;
  }

  /**
   * @param {number} dt
   * @param {object} s   the animator's per-frame state: state, adsBlend
   */
  update(dt, s) {
    const rig = this.rig;
    if (!rig) return;
    const c = this.cfg;
    const st = s.state;

    // A state-bound one-shot outlives its state only as a fade.
    const a = this.active;
    if (a) {
      // Each clip against its own length: a shot variant need not be as long as the base shot.
      const finished = (x) => !x.isRunning() && x.time >= x.getClip().duration - 1e-6;
      if (a.state && st !== a.state) a.done = true;
      else if (!a.done && finished(a.action) && (!a.aimAction || finished(a.aimAction))) a.done = true;
      if (a.done && a.state) { this._retire(a); this.active = null; }
      else if (a.done) {
        // An untethered one-shot (fire) that has finished: hand the pose back to the idle.
        this._retire(a); this.active = null;
      }
    }

    if (this.active) this.active.blend = Math.min(1, this.active.blend + dt / c.fade);
    if (this.outgoing) {
      this.outgoing.blend = Math.max(0, this.outgoing.blend - dt / (this.outgoing.state ? c.idleFade : c.fade));
      if (this.outgoing.blend <= 0) {
        this._each(this.outgoing, (x) => { x.setEffectiveWeight(0); x.stop(); });
        this.outgoing = null;
      }
    }

    const inW = this.active?.blend ?? 0;
    const outW = this.outgoing?.blend ?? 0;
    const ads = clamp(s.adsBlend ?? 0, 0, 1);
    const rest = clamp(1 - inW - outW, 0, 1);

    if (this.active) this._weigh(this.active, inW, ads);
    if (this.outgoing) this._weigh(this.outgoing, outW, ads);
    /**
     * The aim pose sits under the one-shots at the aim blend. On an authored assembly the
     * idle keeps `idleAtAds` of its weight at full aim: the aim clip carries no root track,
     * so the idle's weight IS the breathe on the assembly root, and the two hand poses
     * average in the ratio 1:0.4. A v2 rig's aim pose carries the weapon onto the sight line
     * itself, so any idle left under it would pull the sight off (this.idleAtAds is 0).
     */
    // Movement loops share the idle's slot: sprint follows the SPRINTING state, walk the player's
    // speed (not while aiming). Eased so walk → run → stop never pops, at any frame rate.
    const sprintT = this.sprint && st === 'SPRINTING' ? 1 : 0;
    const walkT = this.walk ? clamp(s.speed ?? 0, 0, 1) * (1 - ads) * (1 - sprintT) : 0;
    this.sprintW = damp(this.sprintW, sprintT, 9, dt);
    this.walkW = damp(this.walkW, walkT, 7, dt);
    if (this.walk) this.walk.setEffectiveTimeScale(0.75 + 0.35 * clamp(s.speed ?? 0, 0, 1));
    const moveW = this.sprintW + this.walkW * (1 - this.sprintW);
    if (this.sprint) this.sprint.setEffectiveWeight(rest * this.sprintW);
    if (this.walk) this.walk.setEffectiveWeight(rest * this.walkW * (1 - this.sprintW));
    if (this.aim) this.aim.setEffectiveWeight(rest * ads);
    if (this.idle) this.idle.setEffectiveWeight(rest * (1 - moveW) * (1 - ads * (1 - this.idleAtAds)));

    rig.mixer.update(dt);
    this.drawn = true;
    // The two magazine instances exchange roles inside the reload clip. Blending their
    // end transforms back to idle sends both through the receiver. Restore the seated
    // instance immediately on completion/cancellation while the hands still ease home.
    if (st !== 'RELOADING') {
      for (const part of this.reloadParts) {
        part.node.position.copy(part.position);
        part.node.quaternion.copy(part.quaternion);
        part.node.scale.copy(part.scale);
      }
    }
    this._writeRound(s);
  }

  /**
   * THE LOADED ROUND (WEAPON_RIGS[*].authored.round - the RPG's rocket). The fire clip sends
   * it down the tube and the reload clip brings the next one in, but the projectile the
   * player sees fly is RocketSystem's, spawned on the shot; so the mesh is shown only while
   * the magazine holds a round or a reload is running, and hidden the moment a shot spends
   * it. Written after the mixer, from the same `mag` the HUD reads, so the launcher can
   * never idle with a rocket seated in an empty tube.
   */
  _writeRound(s) {
    const node = this.rig?.roundNode;
    if (!node) return;
    const loaded = (s.mag ?? 1) > 0 || s.state === 'RELOADING';
    if (node.visible !== loaded) node.visible = loaded;
  }

  /** True while the named one-shot is the running one. For tests and the dev panel. */
  isPlaying(name) { return this.active?.name === name && !this.active.done; }

  /** What is running, for the dev panel. */
  describe() {
    const a = this.active, o = this.outgoing;
    return `authored: ${a ? `${a.name}@${a.action.time.toFixed(2)}s w${a.blend.toFixed(2)}` : 'idle'}`
      + (o ? ` (out ${o.name} w${o.blend.toFixed(2)})` : '');
  }
}
