import { assetURL } from '../config/assetDelivery.js';
import { AudioVoices } from './AudioVoices.js';
import { LIMITER } from '../config/audio.js';
import { DEFAULT_SOUNDS, SOUND_ALIASES } from '../config/defaultSounds.js';

/** The sampled default bank, with the pack's own sounds laid over it slot by slot; no audio work on board edits. */
export class CombatAudio {
  constructor({ sounds = {}, contextFactory, fetcher = (...args) => globalThis.fetch(...args) } = {}) {
    this.sounds = { ...DEFAULT_SOUNDS };
    for (const [id, value] of Object.entries(sounds)) this.sounds[id] = {...this.sounds[id], ...value};
    this.contextFactory = contextFactory ?? (() => new (window.AudioContext || window.webkitAudioContext)());
    this.fetcher = fetcher; this.buffers = new Map(); this.encoded = new Map();
    this.failures = []; this.counts = {}; this.abort = new AbortController();
    this.disposed = false; this.muted = false; this.volume = .7;
  }
  preload() {
    return this.loading ??= (async () => {
      const files = [...new Set(Object.values(this.sounds).map(a => a.file))];
      // Bound network and decoding concurrency; never fetch from a per-frame caller.
      let cursor = 0;
      await Promise.all(Array.from({length: 4}, async () => {
        while (cursor < files.length && !this.disposed) {
          const file = files[cursor++];
          try {
            const response = await this.fetcher(assetURL(file), {signal: this.abort.signal});
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            if (!this.disposed) this.encoded.set(file, bytes);
          } catch (e) { if (!this.disposed) this.failures.push(`${file}: ${e.message}`); }
        }
      }));
    })();
  }
  resume() {
    if (this.disposed) return Promise.resolve(false);
    try {
      if (!this.context) {
        const c = this.context = this.contextFactory();
        this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : this.volume;
        this.limiter = c.createDynamicsCompressor();
        for (const key of ['threshold','knee','ratio','attack','release']) this.limiter[key].value = LIMITER[key];
        this.master.connect(this.limiter).connect(c.destination);
        this.voices = new AudioVoices(c, this.master);
      }
      // Must run synchronously in the Play gesture, before awaiting downloads.
      const resumed = this.context.resume();
      this.decoding ??= this.preload().then(async () => {
        for (const [file, bytes] of this.encoded) {
          if (this.disposed) break;
          try { const buffer = await this.context.decodeAudioData(bytes.slice(0)); if (!this.disposed) this.buffers.set(file, buffer); }
          catch (e) { if (!this.disposed) this.failures.push(`${file}: ${e.message}`); }
        }
        this.encoded.clear();
      });
      return Promise.all([resumed, this.decoding]).then(() => !this.disposed && this.context.state === 'running').catch(() => false);
    } catch (e) { this.failures.push(e.message); return Promise.resolve(false); }
  }
  _entry(name) {
    const id = SOUND_ALIASES[name] ?? name, asset = this.sounds[id];
    if (asset && this.buffers.has(asset.file)) return {id, asset, buffer: this.buffers.get(asset.file)};
    // A pack sound whose file is not delivered yet plays its declared stand-in instead of silence.
    return asset?.fallback && asset.fallback !== id ? this._entry(asset.fallback) : null;
  }
  _ready() { return !this.disposed && !this.muted && this.context?.state === 'running'; }
  playOneShot(name, opts = {}) {
    if (!this._ready()) return null;
    const e = this._entry(name);
    if (!e || this.voices.live.size >= 32) return null;
    this.counts[e.id] = (this.counts[e.id] ?? 0) + 1;
    // One-shot callers must never accidentally leave a looping fire/step source alive.
    return this.voices.playOneShot(e.buffer, {...e.asset, loop: false, spatial: !!opts.position || e.asset.spatial}, opts);
  }
  startActionVoice(id, name, opts = {}) {
    if (!this._ready()) return null;
    const e = this._entry(name); if (!e) return null;
    const existing = this.voices.getActionVoice(id); if (existing) return existing;
    if (this.voices.live.size >= 32) return null;
    this.counts[e.id] = (this.counts[e.id] ?? 0) + 1;
    return this.voices.startActionVoice(id, e.buffer, e.asset, opts);
  }
  stopActionVoice(id, fade) { return this.voices?.stopActionVoice(id, fade); }
  releaseActionVoice(id) { return this.voices?.releaseActionVoice(id); }
  setActionVoiceRate(id, rate) { this.voices?.setActionVoiceRate(id, rate); }
  play(name, position, gain = 1) {
    if (this._entry(name)) return this.playOneShot(name, {position, gain});
    // Small missing mechanical cues have a distinct click, never another gunshot.
    if (!this._ready() || !/^(dryFire|magOut|magIn|boltRack|shellDrop|playerHurt)$/.test(name)) return;
    const c = this.context, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(name === 'playerHurt' ? 100 : 650, t);
    o.frequency.exponentialRampToValueAtTime(50, t + .06);
    g.gain.setValueAtTime(.09 * gain, t); g.gain.exponentialRampToValueAtTime(.0001, t + .09);
    o.connect(g).connect(this.master); o.start(); o.stop(t + .1);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }
  /** Quiet confirmation tones use no external samples; never obscure weapon reports. */
  feedback(kind) {
    if(!this._ready())return;
    const c=this.context,t=c.currentTime;
    if(kind==='hit'&&t-(this.lastHitTone??-1)<.075)return;
    if(kind==='hit')this.lastHitTone=t;
    const notes={hit:[880],headshot:[1320],kill:[660,990],clear:[660,990,1320],checkpoint:[520,780],incoming:[260,220],victory:[660,880,1320],defeat:[220,165]}[kind];if(!notes)return;
    notes.forEach((frequency,i)=>{const o=c.createOscillator(),g=c.createGain(),at=t+i*.075,duration=kind==='hit'?.035:.10;o.type='sine';o.frequency.value=frequency;g.gain.setValueAtTime(0,at);g.gain.linearRampToValueAtTime(kind==='hit'?.022:.045,at+.004);g.gain.exponentialRampToValueAtTime(.0001,at+duration);o.connect(g);g.connect(this.master);o.start(at);o.stop(at+duration+.015);o.onended=()=>{o.disconnect();g.disconnect();};});
  }
  updateListener(camera) {
    const l = this.context?.listener; if (!l) return;
    const p = camera.position, m = camera.matrixWorld.elements, t = this.context.currentTime;
    const values = {positionX:p.x,positionY:p.y,positionZ:p.z,
      forwardX:-m[8],forwardY:-m[9],forwardZ:-m[10],upX:m[4],upY:m[5],upZ:m[6]};
    if (l.positionX) for (const [key,value] of Object.entries(values)) l[key].setValueAtTime(value,t);
    else { l.setPosition(p.x,p.y,p.z); l.setOrientation(-m[8],-m[9],-m[10],m[4],m[5],m[6]); }
  }
  setVolume(value) { this.volume = Math.min(1, Math.max(0, Number(value) || 0)); this.master?.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, .025); }
  setMuted(value) { this.muted = !!value; this.setVolume(this.volume); if (this.muted) this.pause(); }
  pause() { this.voices?.stopAll(40); }
  dispose() {
    this.disposed = true; this.abort.abort(); this.voices?.dispose();
    this.master?.disconnect(); this.limiter?.disconnect();
    this.buffers.clear(); this.encoded.clear(); this.context?.close().catch(() => {});
  }
}
