/**
 * PICK THE PROFILE FROM WHAT THE DEVICE ACTUALLY IS.
 *
 * The old build asked the player to choose from five presets and then quietly stepped
 * between them while they played. Both halves were wrong: the player has no way to know
 * what their GPU can do, and stepping between presets rebuilt every shader in the scene.
 *
 * So the choice is made once, here, from signals that are actually available in a browser,
 * and it is never revisited. What CAN move afterwards is render scale, which costs a buffer
 * resize - see config/quality.js for that split.
 *
 * THE CHAIN IS: hardware signals -> a score -> a rung on the PLATFORM's ladder -> the fixed
 * profile. A desktop climbs minimal / lean / standard / full; a handheld climbs minimal /
 * lean / mobile, because a device with no fan is judged on what it can SUSTAIN for a round,
 * not on what it benchmarks. The player's saved preset (config/quality.js PRESET_PROFILES)
 * picks a rung on the same ladder by name instead of by score, and `?profile=` pins the
 * profile outright for testing.
 *
 * WHAT IS DELIBERATELY NOT DONE: no GPU model string matching. `WEBGL_debug_renderer_info`
 * is fingerprinting surface, is increasingly masked, and a name tells you far less than the
 * numbers below - a laptop and a desktop can report the same chip at a third of the power
 * budget. The scoring uses only things that are either declared by the platform or
 * measurable, and the frame-time controller corrects whatever it gets wrong.
 *
 * THE NATIVE SHELL KNOWS MORE. Safari reports neither deviceMemory nor the GPU family, so a
 * browser on an iPhone can only guess from its core count and its screen. The iOS shell
 * can read both exactly (ProcessInfo.physicalMemory, MTLDevice.supportsFamily) and hands
 * them over before the page runs, as `window.__mazeDevice = { memoryGB, gpuFamily }`. They
 * are read here as two more signals, never as a verdict: a phone that reports 8 GB and an
 * Apple GPU family 8 still lands on the handheld ladder, one rung higher than a phone that
 * reports nothing.
 *
 * THE SCORE IS A BUDGET, NOT A RANKING. Each signal moves it by roughly how much work that
 * device can be expected to do relative to a mid-range desktop, so two weak signals
 * compound the way real hardware does.
 */

import { PROFILES, PROFILE_ORDER, PRESET_PROFILES } from '../config/quality.js';

/**
 * The two ladders. A handheld never climbs past `mobile` by score: a current flagship
 * scores like a desktop - eight cores, 8 GB, WebGPU - and it will genuinely render
 * `standard` for about ninety seconds, which is roughly one round, and then thermally
 * throttle to half that for the rest of the session. Benchmark performance and sustained
 * performance are different quantities on a device with no fan, and the one that matters
 * here is the second. The player's QUALITY preset is the deliberate override for anyone
 * who wants to find out.
 */
const LADDERS = {
  desktop: [[72, 'full'], [46, 'standard'], [24, 'lean'], [-Infinity, 'minimal']],
  handheld: [[34, 'mobile'], [20, 'lean'], [-Infinity, 'minimal']],
};

/** `?profile=minimal|lean|mobile|standard|full` pins the choice, for testing and for a bad guess. */
function forcedProfile() {
  if (typeof location === 'undefined') return null;
  const p = new URLSearchParams(location.search).get('profile');
  return PROFILE_ORDER.includes(p) ? p : null;
}

/**
 * What the native shell declared about the hardware, if it is hosting the page.
 *
 * Two routes, so the shell can pick whichever fits its injection point: a global set by a
 * document-start user script, or a `<meta name="maze-device" content="memoryGB=6;gpuFamily=8">`
 * tag written into the entry document. Both are optional and both are parsed defensively -
 * a value that is not a finite number is simply absent.
 */
export function readNativeHint() {
  const out = { memoryGB: null, gpuFamily: null, source: null };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const g = typeof window !== 'undefined' ? window.__mazeDevice : null;
  if (g && typeof g === 'object') {
    out.memoryGB = num(g.memoryGB);
    out.gpuFamily = num(g.gpuFamily);
    out.source = 'shell';
  }
  if (out.memoryGB === null && out.gpuFamily === null && typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="maze-device"]')?.content;
    if (meta) {
      for (const part of meta.split(';')) {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k === 'memoryGB') out.memoryGB = num(v);
        if (k === 'gpuFamily') out.gpuFamily = num(v);
      }
      out.source = 'meta';
    }
  }
  return out;
}

/**
 * Read every signal the platform will give us. All of these are optional - a browser that
 * reports none of them lands on the neutral score, which is `standard` on a desktop and
 * `mobile` on a handheld.
 *
 * @param {object} o
 * @param {'webgpu'|'webgl2'} o.backend
 * @param {object} [o.renderer] the three renderer, for backend-level facts
 * @param {boolean} [o.webgpuDeclined] WebGL2 was chosen while WebGPU was on offer
 * @returns {object} raw signals, kept for the readout so a wrong guess is explainable
 */
export function readDeviceSignals({ backend, renderer, webgpuDeclined } = {}) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const win = typeof window !== 'undefined' ? window : {};

  const coarse = win.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const touchPoints = nav.maxTouchPoints ?? 0;
  const dpr = Math.min(win.devicePixelRatio || 1, 4);
  const w = win.screen?.width ?? win.innerWidth ?? 1280;
  const h = win.screen?.height ?? win.innerHeight ?? 720;
  /**
   * The native shell's platform pin (the `maze-platform` meta tag). An iPad web
   * view answers `(pointer: coarse)` with false, so the pin is the only reliable statement
   * that this is a handheld at all.
   */
  const declared = typeof document !== 'undefined'
    ? document.querySelector('meta[name="maze-platform"]')?.content : null;

  /**
   * Is this a software rasteriser? The single most decisive signal there is - a fallback
   * adapter or SwiftShader is one to two orders of magnitude slower than any real GPU, and
   * it is also what the automated play-tests run on, so getting it right keeps those honest.
   */
  const backendInfo = renderer?.backend;
  const info = backendInfo?.device?.adapterInfo;
  let description = info?.description || '';
  const gl = backendInfo?.gl;
  if (gl) {
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    if (extension) description = gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) || description;
  }
  // Use the string only for explicit software backends, never to rank hardware models.
  const software = info?.isFallbackAdapter === true || /swiftshader|llvmpipe|software rasterizer/i.test(description);

  const native = readNativeHint();
  const touch = coarse && touchPoints > 0;

  return {
    backend: backend ?? 'webgl2',
    software,
    /**
     * Did we take WebGL2 while the browser was offering WebGPU? Then the backend says
     * nothing about the hardware, and must not be scored as if it did. See scoreSignals.
     */
    webgpuDeclined: webgpuDeclined === true,
    /**
     * GB of RAM. The browser's own figure where it gives one (Chromium, quantised to
     * 0.25/0.5/1/2/4/8); the native shell's exact figure otherwise; null when neither
     * exists (Safari in a browser tab). The memory-awareness signal.
     */
    memoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : native.memoryGB,
    /** Apple GPU family from the shell (7 = A14/M1, 8 = A15/M2, 9 = A17/M3), or null. */
    gpuFamily: native.gpuFamily,
    nativeHint: native.source,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    touch,
    /** Which ladder this device climbs. The platform pin wins; a coarse pointer follows. */
    handheld: declared === 'mobile' || (declared !== 'desktop' && touch),
    dpr,
    /** Pixels a full-resolution frame would have to fill. Big screens cost the same as slow GPUs. */
    screenPixels: Math.round(w * h * dpr * dpr),
  };
}

/**
 * Score the signals and pick a profile.
 *
 * @param {object} o
 * @param {'webgpu'|'webgl2'} o.backend
 * @param {object} [o.renderer]
 * @param {boolean} [o.webgpuDeclined]
 * @param {string} [o.preset] the player's saved preset (config/quality.js GRAPHICS_PRESETS);
 *   'auto' or absent scores the device, anything else names a rung on its ladder.
 * @returns {{name: string, profile: object, signals: object, reasons: string[], score: number,
 *   detected: string, preset: string}}
 *   `detected` is what the score alone would have chosen, so the graphics panel can say
 *   what AUTO means on this device even while a preset overrides it.
 */
export function detectProfile({ backend, renderer, webgpuDeclined, preset = 'auto' } = {}) {
  const forced = forcedProfile();
  const signals = readDeviceSignals({ backend, renderer, webgpuDeclined });
  const scored = scoreSignals(signals);
  if (forced) {
    return {
      ...scored, name: forced, profile: PROFILES[forced], score: -1, detected: scored.name,
      preset: 'pinned', reasons: [`pinned to "${forced}" by ?profile=`],
    };
  }
  const chosen = applyPreset(scored, preset);
  return { ...chosen, detected: scored.name, preset: chosen.name === scored.name ? preset : preset };
}

/**
 * The player's preset, applied to a scored result. A software rasteriser is never
 * promoted - there is no GPU for a preset to spend - and the preset only ever names a rung
 * on the device's OWN ladder, so QUALITY on a phone is `standard`, not `full`.
 */
export function applyPreset(scored, preset) {
  if (!preset || preset === 'auto' || scored.signals.software) return scored;
  const ladder = PRESET_PROFILES[scored.signals.handheld ? 'handheld' : 'desktop'];
  const name = ladder[preset];
  if (!name || !PROFILES[name]) return scored;
  if (name === scored.name) return { ...scored, reasons: [...scored.reasons, `preset ${preset.toUpperCase()} agrees with the detection`] };
  return {
    ...scored, name, profile: PROFILES[name],
    reasons: [...scored.reasons, `preset ${preset.toUpperCase()} -> ${name} (detected ${scored.name})`],
  };
}

/**
 * The scoring itself, as a pure function of the signals.
 *
 * Split out from the reading so it can be exercised against representative devices under
 * bare node. A profile that silently sends every phone to `full` would be invisible here
 * and obvious on a phone, which is the wrong order to find it out in.
 *
 * @param {ReturnType<typeof readDeviceSignals>} signals
 */
export function scoreSignals(signals) {
  const reasons = [];

  // A software rasteriser cannot be argued with: nothing else about the machine matters.
  if (signals.software) {
    return {
      name: 'minimal',
      profile: PROFILES.minimal,
      signals,
      score: 0,
      reasons: ['software rasteriser (fallback adapter) - no GPU to spend on'],
    };
  }

  let score = 50;

  if (signals.backend === 'webgpu') {
    score += 12;
    reasons.push('WebGPU backend (+12)');
  } else if (signals.webgpuDeclined) {
    /**
     * WebGL2 BY CHOICE. The -6 below is an inference about the machine - a browser with no
     * WebGPU is usually an older or thinner graphics stack - and that inference is simply
     * void when the browser was offering WebGPU and we turned it down (see
     * Renderer.webkitBootsOnWebGL, and `?renderer=webgl`). Docking the score anyway is
     * how a backend choice quietly becomes a quality regression.
     */
    reasons.push('WebGL2 chosen deliberately, not for want of WebGPU - not scored');
  } else if (signals.handheld) {
    /**
     * Every phone browser is WebGL2 today - WebKit by rule, most Android Chrome builds by
     * flag - so on a handheld the backend says nothing about the hardware either.
     */
    reasons.push('WebGL2 on a handheld - the platform norm, not scored');
  } else {
    score -= 6;
    reasons.push('WebGL2 fallback (-6)');
  }

  /**
   * MEMORY AWARENESS. deviceMemory is the only RAM figure a browser exposes, it is coarse
   * (Chromium clamps it to 0.25/0.5/1/2/4/8) and Safari and Firefox do not ship it at all -
   * so it is treated as evidence when present (the native shell supplies it on iOS) and
   * simply skipped when absent, rather than being guessed at. It matters most at the
   * bottom: 2 GB or less is a device where the texture budget, not the shader cost, is
   * what will kill the tab - and that case is a CAP below, not just a penalty.
   */
  if (signals.memoryGB === null) {
    reasons.push('deviceMemory not reported - not scored');
  } else if (signals.memoryGB >= 8) {
    score += 16; reasons.push(`${signals.memoryGB} GB RAM (+16)`);
  } else if (signals.memoryGB >= 4) {
    score += 8; reasons.push(`${signals.memoryGB} GB RAM (+8)`);
  } else if (signals.memoryGB >= 2) {
    score -= 10; reasons.push(`${signals.memoryGB} GB RAM (-10)`);
  } else {
    score -= 26; reasons.push(`${signals.memoryGB} GB RAM (-26)`);
  }

  if (signals.cores === null) {
    reasons.push('hardwareConcurrency not reported - not scored');
  } else if (signals.cores >= 8) {
    score += 10; reasons.push(`${signals.cores} cores (+10)`);
  } else if (signals.cores >= 4) {
    score += 3; reasons.push(`${signals.cores} cores (+3)`);
  } else {
    score -= 14; reasons.push(`${signals.cores} cores (-14)`);
  }

  /**
   * THE GPU GENERATION, when the shell can name it. Apple GPU family 7 (A14 / M1) is the
   * first that runs the full mobile tier at native scale with headroom; family 9 (A17 Pro,
   * M3) is a generation past what this scene needs. Below 7 is the two-lights-and-no-
   * shadows class of device, and says so.
   */
  if (signals.gpuFamily !== null) {
    if (signals.gpuFamily >= 9) { score += 12; reasons.push(`Apple GPU family ${signals.gpuFamily} (+12)`); }
    else if (signals.gpuFamily >= 7) { score += 6; reasons.push(`Apple GPU family ${signals.gpuFamily} (+6)`); }
    else { score -= 20; reasons.push(`Apple GPU family ${signals.gpuFamily} (-20)`); }
  }

  /**
   * A touch device is a thermally limited one. Lighter than it was (-12), because the
   * handheld ladder now carries the thermal judgement in its rungs; this is what separates
   * a tablet from a phone of the same silicon.
   */
  if (signals.touch) {
    score -= 8;
    reasons.push('touch device, thermally limited (-8)');
  }

  /**
   * A 4K or high-DPR panel costs the same as a slower GPU, because the work is per pixel.
   * Render scale will claw some of this back at runtime, but starting a phone at native
   * 3x DPR just to immediately scale it down wastes the first seconds of the round. On a
   * handheld the pixel ratio cap already answers most of this, so the penalty is halved.
   */
  const mpx = signals.screenPixels / 1e6;
  if (signals.screenPixels > 5_000_000) {
    const k = signals.handheld ? 6 : 12; score -= k; reasons.push(`${mpx.toFixed(1)} Mpx at native (-${k})`);
  } else if (signals.screenPixels > 2_800_000) {
    const k = signals.handheld ? 2 : 5; score -= k; reasons.push(`${mpx.toFixed(1)} Mpx at native (-${k})`);
  }

  const ladder = LADDERS[signals.handheld ? 'handheld' : 'desktop'];
  let name = ladder.find(([threshold]) => score >= threshold)[1];
  if (signals.handheld) reasons.push('handheld ladder: minimal / lean / mobile');

  /**
   * THE MEMORY CAPS. Texture memory is the one budget the render-scale controller cannot
   * recover: a page that exceeds it is reloaded by the OS, not slowed. So a device that
   * reports 2 GB or less never gets the 1024 px prop textures and the dressing atlas
   * whatever else it scores, and one at 1 GB or less gets the smallest set there is.
   */
  if (signals.memoryGB !== null && signals.memoryGB <= 1 && PROFILE_ORDER.indexOf(name) > 0) {
    reasons.push('capped at minimal: 1 GB or less of RAM'); name = 'minimal';
  } else if (signals.memoryGB !== null && signals.memoryGB <= 2 && PROFILE_ORDER.indexOf(name) > 1) {
    reasons.push('capped at lean: 2 GB or less of RAM'); name = 'lean';
  }

  return { name, profile: PROFILES[name], signals, score, reasons };
}

