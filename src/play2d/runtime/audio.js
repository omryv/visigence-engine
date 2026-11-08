/**
 * Sound for the game shell, synthesised with WebAudio: no audio files, so an exported game is
 * one small HTML file and still sounds finished. Short enveloped oscillators and filtered noise
 * for every event the simulations emit, and a gentle procedural loop per biome.
 *
 * The context is created on the first user gesture (browsers require it). Rapid events (pollen,
 * footsteps, shots) are throttled so a burst never turns into a buzz.
 */

import { mulberry32 } from '../../kernel/seed.js';

const NOTE = n => 440 * Math.pow(2, (n - 69) / 12);
// Where in the noise buffer each hiss starts: a fixed stream, so the same play sounds the same (nothing is random).
const noiseAt = mulberry32(0x5eed);

export function createAudio(opts = {}) {
  let ctx = null, master = null, sfx = null, musicBus = null, noiseBuf = null;
  let muted = !!opts.muted, musicOn = opts.music !== false, soundOn = opts.sound !== false;
  const last = new Map();
  let biome = opts.biome || 'meadow';
  let musicTimer = 0, nextNote = 0, step = 0, musicPlaying = false;

  function ensure() {
    if (ctx) return ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.8; master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.connect(master);
    sfx = ctx.createGain(); sfx.gain.value = soundOn ? 0.9 : 0; sfx.connect(comp);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.32; musicBus.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647) * 2 - 1; }
    return ctx;
  }

  function tone(freq, dur, { type = 'square', gain = 0.12, to = null, at = 0, attack = 0.005, curve = 'exp', vibrato = 0, bus = null } = {}) {
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) { if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur); else o.frequency.linearRampToValueAtTime(to, t0 + dur); }
    if (vibrato) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 18; lg.gain.value = vibrato;
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(bus || sfx);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dur, { gain = 0.15, freq = 1200, q = 0.8, type = 'bandpass', at = 0, to = null } = {}) {
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(sfx);
    src.start(t0, noiseAt() * 0.2); src.stop(t0 + dur + 0.02);
  }
  const arp = (notes, gap, o) => notes.forEach((n, i) => tone(NOTE(n), o.dur || 0.12, { ...o, at: (o.at || 0) + i * gap }));
  function throttle(key, ms) {
    const now = ctx ? ctx.currentTime * 1000 : 0;
    if (now - (last.get(key) || -1e9) < ms) return true;
    last.set(key, now);
    return false;
  }

  let dotFlip = false;
  const RECIPES = {
    jump: e => tone(e.big ? 160 : 320, e.big ? 0.25 : 0.14, { to: e.big ? 90 : 640, gain: e.big ? 0.14 : 0.09 }),
    doubleJump: () => tone(480, 0.16, { type: 'triangle', to: 980, gain: 0.1 }),
    land: e => noise(0.07, { freq: 380, gain: Math.min(0.2, 0.05 + (e.speed || 10) * 0.006), type: 'lowpass' }),
    step: () => { if (!throttle('step', 180)) noise(0.03, { freq: 2200, gain: 0.025, type: 'highpass' }); },
    coin: () => { if (!throttle('coin', 40)) { tone(NOTE(83), 0.07, { gain: 0.07 }); tone(NOTE(88), 0.14, { gain: 0.07, at: 0.06 }); } },
    gem: () => arp([76, 79, 84, 88], 0.06, { type: 'triangle', gain: 0.1, dur: 0.18 }),
    heart: () => arp([72, 76, 79], 0.07, { type: 'sine', gain: 0.12, dur: 0.2 }),
    key: () => { tone(NOTE(81), 0.4, { type: 'sine', gain: 0.1 }); tone(NOTE(93), 0.5, { type: 'sine', gain: 0.05, at: 0.05 }); },
    power: () => arp([60, 64, 67, 72, 76], 0.05, { type: 'square', gain: 0.07, dur: 0.1 }),
    powerup: () => arp([67, 71, 74, 79, 83], 0.045, { type: 'triangle', gain: 0.1, dur: 0.12 }),
    powerEnd: () => arp([79, 74, 67], 0.06, { type: 'triangle', gain: 0.07, dur: 0.1 }),
    door: () => { noise(0.18, { freq: 500, gain: 0.12, type: 'lowpass' }); tone(110, 0.2, { gain: 0.08, to: 70 }); },
    doorClose: () => { noise(0.12, { freq: 300, gain: 0.12, type: 'lowpass' }); tone(90, 0.15, { gain: 0.08 }); },
    lever: e => { noise(0.03, { freq: 3000, gain: 0.08 }); tone(e.on === false ? 300 : 500, 0.06, { gain: 0.06, at: 0.03 }); },
    plate: e => tone(e.on ? 220 : 180, 0.08, { type: 'triangle', gain: 0.1 }),
    toggle: () => { tone(NOTE(72), 0.08, { gain: 0.08 }); tone(NOTE(67), 0.1, { gain: 0.08, at: 0.07 }); },
    spring: () => tone(180, 0.35, { type: 'sine', to: 760, gain: 0.16, vibrato: 30 }),
    stomp: () => { tone(260, 0.12, { to: 90, gain: 0.12 }); noise(0.08, { freq: 800, gain: 0.08 }); },
    hurt: () => tone(320, 0.3, { type: 'sawtooth', to: 110, gain: 0.1 }),
    die: () => arp([67, 63, 60, 55], 0.12, { type: 'square', gain: 0.1, dur: 0.18 }),
    respawn: () => arp([60, 67, 72], 0.06, { type: 'triangle', gain: 0.08, dur: 0.12 }),
    checkpoint: () => { tone(NOTE(84), 0.6, { type: 'sine', gain: 0.1 }); tone(NOTE(91), 0.7, { type: 'sine', gain: 0.05, at: 0.08 }); },
    shoot: e => { if (e.owner === 'enemy') { if (!throttle('eshot', 60)) tone(200, 0.08, { to: 120, gain: 0.07 }); } else if (!throttle('pshot', 55)) { noise(0.03, { freq: 2600, gain: 0.04, type: 'highpass' }); tone(900, 0.05, { type: 'square', to: 500, gain: 0.035 }); } },
    hit: e => { if (!throttle('hit', 45)) noise(0.05, { freq: e.owner === 'player' ? 1800 : 900, gain: 0.07 }); },
    kill: () => { tone(600, 0.12, { type: 'square', to: 1200, gain: 0.06 }); noise(0.1, { freq: 1500, gain: 0.08 }); },
    break: () => noise(0.25, { freq: 700, gain: 0.16, type: 'lowpass', to: 200 }),
    crumble: e => { if (e.start) noise(0.3, { freq: 300, gain: 0.05, type: 'lowpass' }); else noise(0.25, { freq: 500, gain: 0.12, type: 'lowpass', to: 120 }); },
    teleport: () => tone(300, 0.4, { type: 'sine', to: 1400, gain: 0.1, vibrato: 60 }),
    push: () => { if (!throttle('push', 70)) noise(0.08, { freq: 240, gain: 0.12, type: 'lowpass' }); },
    fill: () => { noise(0.3, { freq: 600, gain: 0.14, type: 'lowpass', to: 150 }); tone(160, 0.3, { type: 'sine', to: 60, gain: 0.1 }); },
    splash: () => { if (!throttle('splash', 150)) noise(0.22, { freq: 1400, gain: 0.08, to: 400 }); },
    chest: () => arp([72, 76, 79, 84, 88], 0.05, { type: 'triangle', gain: 0.09, dur: 0.16 }),
    talk: () => { tone(NOTE(76), 0.05, { type: 'square', gain: 0.05 }); tone(NOTE(79), 0.05, { type: 'square', gain: 0.05, at: 0.07 }); },
    dot: () => { if (!throttle('dot', 70)) { dotFlip = !dotFlip; tone(dotFlip ? 520 : 390, 0.06, { type: 'triangle', to: dotFlip ? 390 : 520, gain: 0.06 }); } },
    beeEaten: () => tone(200, 0.3, { type: 'square', to: 1600, gain: 0.07 }),
    caught: () => arp([72, 68, 64, 60, 56], 0.07, { type: 'square', gain: 0.08, dur: 0.12 }),
    wave: () => { tone(NOTE(55), 0.3, { type: 'sawtooth', gain: 0.06 }); tone(NOTE(62), 0.45, { type: 'sawtooth', gain: 0.06, at: 0.2 }); },
    spawn: () => { if (!throttle('spawn', 120)) noise(0.12, { freq: 400, gain: 0.05, type: 'lowpass' }); },
    cleared: () => arp([67, 72, 76], 0.08, { type: 'triangle', gain: 0.08, dur: 0.14 }),
    bossHit: () => { tone(140, 0.2, { to: 70, gain: 0.16 }); noise(0.15, { freq: 500, gain: 0.1 }); },
    slam: () => { noise(0.4, { freq: 160, gain: 0.25, type: 'lowpass', to: 60 }); tone(70, 0.35, { type: 'sine', to: 40, gain: 0.2 }); },
    win: () => arp([72, 76, 79, 84, 79, 84], 0.09, { type: 'square', gain: 0.07, dur: 0.16 }),
    timeout: () => arp([67, 62, 58], 0.14, { type: 'square', gain: 0.08, dur: 0.2 }),
    shieldBreak: () => arp([96, 91, 88], 0.03, { type: 'sine', gain: 0.08, dur: 0.1 }),
    bump: () => { if (!throttle('bump', 120)) tone(120, 0.06, { type: 'triangle', gain: 0.07 }); },
    slide: () => { if (!throttle('slide', 200)) noise(0.2, { freq: 3000, gain: 0.03, type: 'highpass' }); },
    undo: () => tone(700, 0.08, { type: 'triangle', to: 420, gain: 0.06 }),
    restart: () => tone(500, 0.15, { type: 'triangle', to: 250, gain: 0.06 }),
    fall: () => tone(600, 0.35, { type: 'sine', to: 120, gain: 0.1 }),
    ui: () => tone(NOTE(79), 0.05, { type: 'triangle', gain: 0.05 }),
    uiBack: () => tone(NOTE(72), 0.05, { type: 'triangle', gain: 0.05 }),
    star: e => tone(NOTE(79 + (e.n || 0) * 5), 0.25, { type: 'triangle', gain: 0.09 }),
  };

  // ------------------------------------------------------------------ music
  // A pentatonic loop: bass on the beat, a seeded melody above it, a soft hat. Each biome
  // gets its own key and feel. Scheduled 0.12 s ahead on a timer, so it never stutters.
  const STYLES = {
    meadow: { root: 60, bpm: 104, scale: [0, 2, 4, 7, 9], lead: 'triangle' },
    desert: { root: 57, bpm: 96, scale: [0, 1, 4, 5, 7, 8], lead: 'square' },
    snow: { root: 64, bpm: 88, scale: [0, 2, 3, 7, 10], lead: 'sine' },
  };
  function scheduleMusic() {
    if (!ctx || !musicPlaying) return;
    const st = STYLES[biome] || STYLES.meadow;
    const beat = 60 / st.bpm / 2;
    while (nextNote < ctx.currentTime + 0.14) {
      const bar = Math.floor(step / 16) % 4, pos = step % 16;
      const chord = [0, 3, 4, 3][bar];
      const at = nextNote - ctx.currentTime;
      if (pos % 4 === 0) tone(NOTE(st.root - 24 + st.scale[chord % st.scale.length]), beat * 1.8, { type: 'triangle', gain: 0.1, at: Math.max(0, at), bus: musicBus });
      const h = ((step * 2654435761) >>> 0) % 7;
      if (h < 4 && pos % 2 === 0) {
        const deg = st.scale[(chord + h + (pos >> 2)) % st.scale.length];
        tone(NOTE(st.root + deg + (h === 3 ? 12 : 0)), beat * 0.9, { type: st.lead, gain: 0.035, at: Math.max(0, at), bus: musicBus });
      }
      if (pos % 4 === 2) {
        const src = ctx.createBufferSource(); src.buffer = noiseBuf;
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
        const g = ctx.createGain(); const t0 = ctx.currentTime + Math.max(0, at);
        g.gain.setValueAtTime(0.02, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
        src.connect(f); f.connect(g); g.connect(musicBus); src.start(t0); src.stop(t0 + 0.06);
      }
      nextNote += beat; step++;
    }
  }

  return {
    /** Call from a user gesture: creates or resumes the context. */
    unlock() { if (!ensure()) return; if (ctx.state === 'suspended') ctx.resume(); if (musicOn && !musicPlaying) this.startMusic(); },
    play(type, data = {}) { if (!ctx || muted || !soundOn || ctx.state !== 'running') return; const r = RECIPES[type]; if (r) r(data); },
    setBiome(b) { biome = b; },
    startMusic() {
      if (!ctx || !musicOn || musicPlaying) return;
      musicPlaying = true; nextNote = ctx.currentTime + 0.1; step = 0;
      musicTimer = setInterval(scheduleMusic, 30);
    },
    stopMusic() { musicPlaying = false; clearInterval(musicTimer); },
    setMuted(m) { muted = m; if (master) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.02); },
    get muted() { return muted; },
    setMusic(on) { musicOn = on; if (!on) this.stopMusic(); else if (ctx) this.startMusic(); },
    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); },
    destroy() { this.stopMusic(); if (ctx) ctx.close().catch(() => {}); ctx = null; },
  };
}
