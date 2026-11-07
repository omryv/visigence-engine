/* ui-sound.js — the editor's own small voice.
 *
 * There used to be a second audio module beside this one — a game sound bank
 * that streamed mp3s from an object-storage bucket — and it is worth naming
 * because this file is what outlived it. An editor cue has to be instant, has
 * to work on a locked-down network, and has to weigh nothing, so every cue
 * here is SYNTHESISED: a couple of oscillators and an envelope, the same
 * zero-byte-asset discipline the props are built under. When the runtimes that
 * wanted the bucket were deleted, this module needed no change at all, which
 * is the argument for having written it this way.
 *
 * A placement cue is a soft wooden knock, not a notification chime: it is
 * confirming that something arrived in a place, and the ear reads a short
 * low body with a fast attack as contact. Everything is under 300 ms and
 * around −20 dB of headroom, because a sound that plays on every single
 * click has to be the kind of sound you stop hearing.
 *
 * Nothing is constructed until the first cue plays. Browsers refuse audio
 * before a gesture, and importing this module must never be the reason a
 * page holds an AudioContext it was not asked for.
 */

export class UiSound {
  constructor({ enabled = true } = {}) {
    this.enabled = !!enabled && typeof window !== "undefined" &&
      !!(window.AudioContext || window.webkitAudioContext);
    this.ctx = null;
    this.master = null;
    this._noise = null;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on && this.master) this.master.gain.value = 0;
    else if (on && this.master) this.master.gain.value = 0.34;
  }

  _wake() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new AC(); } catch { this.enabled = false; return null; }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.34;
      this.master.connect(this.ctx.destination);
    }
    // Autoplay policy: the context can be born suspended even inside a
    // gesture on some browsers, and stays suspended after a tab switch.
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // One short noise burst, band-limited — the "material" half of a knock.
  _burst(t0, { gain = 0.12, freq = 1400, q = 0.9, decay = 0.09 } = {}) {
    const ctx = this.ctx;
    if (!this._noise) {
      const len = Math.floor(ctx.sampleRate * 0.25);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      // Deterministic pseudo-noise: a fixed buffer means every knock has the
      // same grain, which is what makes repeated placements sound like one
      // instrument rather than a shuffle.
      let s = 1;
      for (let i = 0; i < len; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = (s / 2147483648) - 1; }
      this._noise = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + decay + 0.02);
  }

  _tone(t0, { freq, gain = 0.16, decay = 0.2, type = "sine", bend = 0 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (bend) o.frequency.exponentialRampToValueAtTime(Math.max(freq + bend, 30), t0 + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008); // fast, but not a click
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + decay + 0.02);
  }

  /* ── the cues ──
     `weight` 0..1 lets a watchtower land heavier than a fence post: the
     bigger the thing, the lower and longer its knock. */
  place(weight = 0.5) {
    if (!this._wake()) return;
    const t = this.ctx.currentTime + 0.001;
    const w = Math.min(Math.max(weight, 0), 1);
    const f = 208 - w * 86;                      // 208 Hz light · 122 Hz heavy
    this._tone(t, { freq: f, gain: 0.2, decay: 0.16 + w * 0.12, bend: -f * 0.28 });
    this._tone(t + 0.004, { freq: f * 2.02, gain: 0.07, decay: 0.09 });
    this._burst(t, { gain: 0.09, freq: 1500 - w * 550, decay: 0.06 + w * 0.03 });
  }
  // Selecting is lighter than placing — nothing entered the world.
  pick() {
    if (!this._wake()) return;
    const t = this.ctx.currentTime + 0.001;
    this._tone(t, { freq: 620, gain: 0.055, decay: 0.07 });
    this._burst(t, { gain: 0.03, freq: 3000, q: 1.4, decay: 0.03 });
  }
  // Removal falls; restoring rises. The pair is the whole grammar of undo.
  remove() {
    if (!this._wake()) return;
    const t = this.ctx.currentTime + 0.001;
    this._tone(t, { freq: 300, gain: 0.11, decay: 0.2, bend: -150 });
  }
  restore() {
    if (!this._wake()) return;
    const t = this.ctx.currentTime + 0.001;
    this._tone(t, { freq: 300, gain: 0.1, decay: 0.18, bend: 210 });
  }
  // A camera arriving somewhere: barely there, just enough to say it moved.
  travel() {
    if (!this._wake()) return;
    const t = this.ctx.currentTime + 0.001;
    this._tone(t, { freq: 880, gain: 0.035, decay: 0.11, type: "triangle", bend: 180 });
  }
}
