/**
 * The voice layer: buses, one-shots, and CANCELLABLE ACTION VOICES.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ACTION VOICE
 * ---------------------------------------------------------------------------
 * Most game sounds are fire-and-forget, and `playOneShot` is that. The interesting ones are
 * not: a hold that can be released, a reload that can be interrupted, a trigger that can be
 * let go, a walk cycle that stops when the player does. Those need a NAME, so the code that
 * cancels them does not have to hold a reference to whatever node happens to be playing.
 *
 * So each cancellable sound has one logical ACTION ID - `player:steps`,
 * `player:weapon1-fire`, `interaction:computer:controlStation`, `enemy:7:vocal` - and this
 * class keeps at most ONE live source per id. Starting an action voice that already exists
 * is a no-op rather than a second overlapping source, which is what stops a held trigger
 * from stacking thirty copies of a gunshot, or a repeated reload key from doubling itself.
 *
 * Every voice also carries an OWNER, so a whole entity's audio can be dropped in one call
 * when it is despawned or pooled - `stopVoicesOwnedBy('enemy:7')` - without the caller
 * enumerating what that entity might have started.
 *
 * ---------------------------------------------------------------------------
 * STOPPING
 * ---------------------------------------------------------------------------
 * Nothing is ever stopped abruptly: a hard `stop()` on a source mid-waveform is a click.
 * Every stop ramps the voice's own gain to zero over 30-80 ms and stops the source at the
 * end of the ramp. A voice with `minAudible` set is held for at least that long first, so a
 * single click on an automatic weapon still produces a burst you can hear instead of a
 * sound that is cancelled before it starts.
 *
 * ---------------------------------------------------------------------------
 * SIGNAL PATH
 * ---------------------------------------------------------------------------
 *   source -> voice gain -> [panner, if spatial] -> bus gain -> destination
 *
 * `destination` is the three.js AudioListener's input, so the master volume and the mute
 * toggle already in the game apply to these voices exactly as they do to the synthesised
 * ones, and the limiter downstream of it catches everything.
 */

import { BUS, BUS_GAIN, SPATIAL } from '../config/audio.js';

export class AudioVoices {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination  the listener input every bus feeds
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    /** @type {Map<string, GainNode>} */
    this.buses = new Map();
    for (const id of Object.values(BUS)) {
      const g = ctx.createGain();
      g.gain.value = BUS_GAIN[id] ?? 1;
      g.connect(destination);
      this.buses.set(id, g);
    }
    /** Every live voice, action or one-shot. */
    this.live = new Set();
    /** actionId -> voice. At most one. */
    this.actions = new Map();
    this.muted = false;
  }

  get now() { return this.ctx.currentTime; }

  /**
   * Build and start one voice.
   * @param {AudioBuffer} buffer
   * @param {object} a       the asset entry from AUDIO_ASSETS
   * @param {object} [opts]  { position, gain, rate, owner, actionId, fadeInMs }
   */
  _start(buffer, a, opts = {}) {
    const ctx = this.ctx;
    const t0 = this.now;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (opts.rate) src.playbackRate.value = opts.rate;

    if (a.loop) {
      src.loop = true;
      // Guard the window: a loopEnd past the buffer silently disables looping in some
      // implementations, and a zero-length window locks the source on one sample.
      const end = Math.min(a.loopEnd ?? buffer.duration, buffer.duration);
      const start = Math.max(0, Math.min(a.loopStart ?? 0, end - 0.01));
      src.loopStart = start;
      src.loopEnd = end;
    }

    const gain = ctx.createGain();
    const target = (a.gain ?? 1) * (opts.gain ?? 1);
    const fadeIn = Math.max(0, (opts.fadeInMs ?? 6) / 1000);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(target, t0 + fadeIn);

    let panner = null;
    if (a.spatial && opts.position) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = SPATIAL.distanceModel;
      panner.refDistance = SPATIAL.refDistance;
      panner.rolloffFactor = SPATIAL.rolloffFactor;
      panner.maxDistance = SPATIAL.maxDistance;
      setPannerPosition(panner, opts.position, t0);
      gain.connect(panner);
      panner.connect(this.buses.get(a.bus) ?? this.buses.get(BUS.WORLD));
    } else {
      gain.connect(this.buses.get(a.bus) ?? this.buses.get(BUS.PLAYER));
    }
    src.connect(gain);

    const offset = a.offset ?? 0;
    // `duration` trims a silent tail. A looping voice ignores it: it ends when stopped.
    if (!a.loop && a.duration) src.start(0, offset, a.duration);
    else src.start(0, offset);

    const voice = {
      id: opts.actionId ?? null,
      asset: a,
      owner: opts.owner ?? null,
      src,
      gain,
      panner,
      target,
      startedAt: t0,
      minAudible: a.minAudible ?? 0,
      stopping: false,
    };
    this.live.add(voice);
    src.onended = () => {
      this.live.delete(voice);
      if (voice.id && this.actions.get(voice.id) === voice) this.actions.delete(voice.id);
      try { src.disconnect(); gain.disconnect(); panner?.disconnect(); } catch { /* already gone */ }
    };
    return voice;
  }

  /**
   * Fire and forget. Returns the voice so a caller can reposition it, but nothing has to
   * hold on to it: a one-shot cleans itself up when its source ends.
   */
  playOneShot(buffer, asset, opts = {}) {
    if (!buffer || this.muted) return null;
    return this._start(buffer, asset, opts);
  }

  /**
   * Start a named, cancellable voice. If one with this id is already live and not stopping,
   * nothing is started and the existing voice is returned - this is the rule that keeps a
   * held trigger, a repeated reload key or a per-frame movement check from stacking sources.
   */
  startActionVoice(actionId, buffer, asset, opts = {}) {
    if (!buffer || this.muted) return null;
    const existing = this.actions.get(actionId);
    if (existing && !existing.stopping) return existing;
    const voice = this._start(buffer, asset, { ...opts, actionId });
    this.actions.set(actionId, voice);
    return voice;
  }

  isActionVoicePlaying(actionId) {
    const v = this.actions.get(actionId);
    return !!v && !v.stopping;
  }

  getActionVoice(actionId) {
    const v = this.actions.get(actionId);
    return v && !v.stopping ? v : null;
  }

  /** Ramp a named voice out and forget it. Safe to call when nothing is playing. */
  stopActionVoice(actionId, fadeMs = 60) {
    const v = this.actions.get(actionId);
    if (!v) return false;
    this.actions.delete(actionId);
    this._fadeOut(v, fadeMs);
    return true;
  }

  /**
   * Let an action's voice PLAY OUT while the action id becomes free again: the action has
   * finished (a reload that completed), but its sound is longer than its mechanism and
   * has a tail still to give. The voice stays in `live` until its source ends on its own
   * (`onended` cleans it up, and only deletes an action mapping that is still its own), so
   * the next start of the same action gets a fresh voice instead of this one.
   */
  releaseActionVoice(actionId) {
    const v = this.actions.get(actionId);
    if (!v) return false;
    this.actions.delete(actionId);
    return true;
  }

  /** Every voice this owner started, action or one-shot. Used when an entity goes away. */
  stopVoicesOwnedBy(ownerId, fadeMs = 60) {
    let n = 0;
    for (const v of this.live) {
      if (v.owner !== ownerId || v.stopping) continue;
      if (v.id) this.actions.delete(v.id);
      this._fadeOut(v, fadeMs);
      n++;
    }
    return n;
  }

  /** Reposition a live spatial voice - a vocal on a walking enemy. */
  setVoicePosition(voice, position) {
    if (!voice?.panner || !position) return;
    setPannerPosition(voice.panner, position, this.now);
  }

  setActionVoiceRate(actionId, rate) {
    const v = this.getActionVoice(actionId);
    if (!v) return;
    v.src.playbackRate.setTargetAtTime(rate, this.now, 0.05);
  }

  countByOwnerPrefix(prefix) {
    let n = 0;
    for (const v of this.live) if (!v.stopping && v.owner?.startsWith(prefix)) n++;
    return n;
  }

  _fadeOut(v, fadeMs) {
    if (v.stopping) return;
    v.stopping = true;
    // Entity death/recycling needs silence before a new voice can own this slot.
    if (fadeMs === 0) {
      v.gain.gain.cancelScheduledValues(this.now);
      v.gain.gain.setValueAtTime(0, this.now);
      try { v.src.stop(this.now); } catch { /* already ended */ }
      return;
    }
    const fade = Math.max(0.01, fadeMs / 1000);
    // A voice cancelled in its first instants still gets its minimum audible burst, so a
    // tap on an automatic weapon is heard rather than swallowed.
    const earliest = v.startedAt + v.minAudible;
    const begin = Math.max(this.now, earliest);
    const end = begin + fade;
    try {
      v.gain.gain.cancelScheduledValues(this.now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, this.now);
      if (begin > this.now) v.gain.gain.setValueAtTime(v.target, begin);
      v.gain.gain.linearRampToValueAtTime(0.0001, end);
      v.src.stop(end);
    } catch {
      // A source that already ended throws on stop(); its onended has cleaned it up.
      this.live.delete(v);
    }
  }

  /**
   * Stop everything. `keepOneShots` lets a teardown cut the continuous voices while an
   * explosion that already committed is allowed to ring out.
   */
  stopAll(fadeMs = 40, { keepOneShots = false } = {}) {
    for (const v of [...this.live]) {
      if (keepOneShots && !v.id) continue;
      if (v.id) this.actions.delete(v.id);
      this._fadeOut(v, fadeMs);
    }
  }

  /** Every live action id, for tests and the debug panel. */
  describe() {
    return [...this.actions.entries()]
      .filter(([, v]) => !v.stopping)
      .map(([id, v]) => `${id}=${v.asset.file}`);
  }

  dispose() {
    this.stopAll(10);
    for (const g of this.buses.values()) { try { g.disconnect(); } catch { /* ignore */ } }
    this.buses.clear();
  }
}

/**
 * Position a panner across implementations: the modern AudioParams where they exist, the
 * deprecated setPosition() where they do not (older Safari).
 */
function setPannerPosition(panner, p, t) {
  if (panner.positionX) {
    panner.positionX.setValueAtTime(p.x, t);
    panner.positionY.setValueAtTime(p.y ?? 0, t);
    panner.positionZ.setValueAtTime(p.z, t);
  } else {
    panner.setPosition(p.x, p.y ?? 0, p.z);
  }
}
