/**
 * WebGPU-first renderer setup.
 *
 * three r185.1 facts this file depends on (verified against node_modules/three/src):
 *  - WebGPURenderer is exported ONLY from 'three/webgpu'. 'three/webgpu' re-exports the
 *    whole core from three.core.js, the same module 'three' uses, so addons that import
 *    'three' share one copy of Object3D/Texture/etc.
 *  - `render()` THROWS before init; there is no auto-init. The sanctioned pattern is
 *    `await renderer.init()` once, then plain `render()`. `renderAsync()` is deprecated.
 *  - The WebGL2 fallback is AUTOMATIC and lives in the constructor: unless
 *    `forceWebGL: true`, the constructor installs `getFallback`, and `init()` catches a
 *    backend throw, swaps in WebGLBackend and retries. With `forceWebGL: true` there is
 *    no fallback wired at all.
 *  - `samples: N` is broken by an operator-precedence bug (any truthy value collapses to
 *    4) and `renderer.samples` has no setter, so only `antialias` is used here.
 *  - `renderer.shadowMap.type` must be set BEFORE the first render.
 */

import {
  WebGPURenderer, PCFSoftShadowMap, PCFShadowMap, BasicShadowMap, VSMShadowMap,
  SRGBColorSpace, ACESFilmicToneMapping, NoToneMapping,
  Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshBasicMaterial,
} from 'three/webgpu';
import { fxEnabled } from '../config/visualFx.js';

/**
 * Cheap WebGPU probe. Deliberately does NOT import
 * three/addons/capabilities/WebGPU.js: that module uses top-level await and fires a real
 * requestAdapter() at module-evaluation time, which would make every importer async and
 * cost an adapter request even when we already know we want WebGL.
 */
export function webgpuLikelyAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Browsers that boot on WebGL2 even though they offer WebGPU: every WebKit one.
 *
 * WHAT THIS IS NOT. It was introduced as a colour quarantine: macOS Safari on WebGPU drew
 * the level dark, crushed and saturated red, while `?renderer=webgl` on the same machine
 * looked right, and the difference was pinned on WebKit's WebGPU backend. That reading was
 * wrong. The two runs were not the same build in two backends, they were two PROFILES: the
 * WebGPU run scored `standard` and got bloom, the forced-WebGL2 run scored `lean` and did
 * not, and the bloom composite in render/PostFX.js promoted the whole grade to vec4 and
 * poisoned the luminance with the bloom's alpha. It reproduces on Chromium, on either
 * backend, in any profile with post-processing on. That is fixed where it lives.
 *
 * WHY THIS STAYS. WebGL2 through ANGLE is the mature path on WebKit and is the one the
 * level has actually been seen rendering correctly on a Mac; Safari's and iOS's WebGPU
 * have not been driven through the game since the real fault was found, and a phone is
 * the worst place to find out. So WebKit keeps starting on WebGL2 for now, at its full
 * quality tier (DeviceProfile does not dock it for a backend it chose), with
 * `?renderer=webgpu` as the door for anyone re-testing. Once WebGPU has been seen to run
 * the mission on Safari and on an iPhone, delete this function and its use below.
 *
 * DETECTED BY ENGINE, NOT BY VERSION. `navigator.vendor` is 'Apple Computer, Inc.' on
 * every WebKit browser and on nothing else - Chromium reports 'Google Inc.', Gecko reports
 * an empty string - so this covers Safari and every iOS browser, which are all WebKit.
 */
export function webkitBootsOnWebGL() {
  return typeof navigator !== 'undefined' && navigator.vendor === 'Apple Computer, Inc.';
}

/**
 * Whether this browser should BOOT on WebGPU, honouring `?renderer=` first.
 *
 * The provisional profile in Game.boot() has to make the same call as createRenderer does,
 * or it guesses a backend the renderer never uses; sharing this function is what keeps the
 * two from drifting apart.
 */
export function webgpuPreferred() {
  const forced = requestedBackend();
  if (forced) return forced === 'webgpu';
  return webgpuLikelyAvailable() && !webkitBootsOnWebGL();
}

/**
 * Compatibility shim for a three r185.1 bug that kills WebGPU on current Chromium.
 *
 * three's private GPUTextureViewDescriptor sets `swizzle = 'rgba'` in both its constructor
 * and reset(), and hands that object to every `GPUTexture.createView()` call. But the
 * WebGPU spec types `swizzle` as a GPUTextureComponentSwizzle DICTIONARY ({r,g,b,a}), not
 * a string. A browser that has not implemented `texture-component-swizzle` ignores the
 * unknown member and three works by luck; a browser that HAS implemented it validates the
 * member and throws:
 *
 *   Failed to read the 'swizzle' property from 'GPUTextureViewDescriptor':
 *   The provided value is not of type 'GPUTextureComponentSwizzle'.
 *
 * createView() is on the path of the very first render, so the throw takes the whole
 * backend down. Measured on Chromium 141 (`adapter.features.has('texture-component-swizzle')`
 * is true): the string form throws, while omitting it, passing `undefined`, or passing the
 * dictionary all succeed. Chromium 141 is current shipping Chrome/Edge - so without this
 * shim WebGPU is dead for most desktop players, not just in the test harness.
 *
 * 'rgba' is the identity swizzle, so dropping it is semantically a no-op. The descriptor
 * is mutated in place rather than copied: three reuses a handful of module-level
 * descriptor singletons and re-sets the field on every reset(), so writing `undefined`
 * costs no allocation on a path that runs per render pass per frame. Anything passing a
 * real dictionary is left untouched.
 *
 * Remove this once three ships the fix (the field should be omitted unless the
 * 'texture-component-swizzle' feature is actually requested).
 *
 * @returns {boolean} whether the shim was installed by this call
 */
export function installWebGPUSwizzleShim() {
  if (typeof GPUTexture === 'undefined') return false;
  const proto = GPUTexture.prototype;
  const original = proto?.createView;
  if (typeof original !== 'function' || original.__mazeFeverSwizzleShim) return false;

  const patched = function createView(descriptor) {
    if (descriptor !== undefined && descriptor !== null && typeof descriptor.swizzle === 'string') {
      descriptor.swizzle = undefined;
    }
    return original.call(this, descriptor);
  };
  patched.__mazeFeverSwizzleShim = true;
  proto.createView = patched;
  return true;
}

/**
 * The drawable size of a viewport, or null when it is collapsed.
 *
 * A hidden or zero-height container (the studio's preview while the launcher is up, a
 * panel mid-transition) reports a 0x0 rectangle. Drawing into it is not harmless: the
 * canvas becomes 1x1, and three's TRAANode starts its history target at 1x1 as the "never
 * sized" sentinel, so a first frame at that size never initialises the history and the
 * depth copy that follows throws inside the backend (the "WeakMap keys must be objects"
 * report from macOS Safari, reproduced on Chromium with the launcher's hidden preview).
 * A session therefore keeps its last real size and draws nothing until the viewport shows.
 */
export function viewportSize(width, height, min = 2) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < min || height < min) return null;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** Reads `?renderer=webgpu|webgl` for backend verification. */
export function requestedBackend() {
  const p = new URLSearchParams(location.search).get('renderer');
  return p === 'webgl' || p === 'webgpu' ? p : null;
}

/**
 * Draws one throwaway frame to prove the backend can actually render.
 *
 * three's own fallback only covers a throw from `backend.init()`. A backend can init
 * cleanly and still fail on the first real render, and this probe converts that from a
 * black screen into an automatic WebGL2 fallback.
 *
 * The known instance of this was the `swizzle` descriptor bug - see
 * installWebGPUSwizzleShim(), which now fixes the cause rather than falling back around
 * it. The probe stays as the general safety net for any other backend that inits but
 * cannot draw.
 *
 * @returns {string|null} the error message if the probe failed
 */
async function probeRender(renderer) {
  const scene = new Scene();
  const cam = new PerspectiveCamera(50, 1, 0.1, 10);
  cam.position.z = 3;
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0x808080 }));
  scene.add(mesh);
  try {
    renderer.render(scene, cam);
    return null;
  } catch (err) {
    return err?.message || String(err);
  } finally {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

/** Dispose a renderer at most once; a dead device can throw on teardown. */
function disposeOnce(renderer) {
  if (!renderer || renderer.__disposed) return;
  renderer.__disposed = true;
  try { renderer.dispose(); } catch { /* already gone */ }
}

/** Rejections that are an expected consequence of tearing down a dead WebGPU device. */
const DEAD_DEVICE_REJECTION =
  /Instance dropped|Instance reference no longer exists|device (was )?lost|device is destroyed/i;

/** How long a WebGPU boot attempt may emit dead-device rejections. */
const BOOT_SUPPRESS_MS = 30000;
/** Grace after committing a backend, for stragglers from a torn-down device. */
const COMMIT_SUPPRESS_TAIL_MS = 3000;
/**
 * How many times, and how patiently, to ask a canvas for a WebGL2 context before
 * concluding the browser has none to give. Delays grow linearly, ~1.5 s in total.
 */
const WEBGL2_ACQUIRE_ATTEMPTS = 4;
const WEBGL2_ACQUIRE_DELAY_MS = 150;

/**
 * Swallow the stray async rejections that disposing a lost WebGPU device produces.
 *
 * three fires `device.popErrorScope().then(...)` with no `.catch()` (three.webgpu.js
 * r185.1, in the pipeline and compute paths). If the device dies with one of those scopes
 * still pending, the promise rejects with nobody listening, and the browser reports
 * "Instance dropped in popErrorScope" as an uncaught page error - even though the loss is
 * a condition we deliberately handled by falling back to WebGL2.
 *
 * Deliberately narrow: it only matches dead-device wording, and only for the moment
 * around the teardown, so a genuine unhandled rejection is still reported.
 *
 * @returns {() => void} stop suppressing
 */
function suppressDeadDeviceRejections(ms) {
  if (typeof window === 'undefined') return () => {};
  const onRejection = (event) => {
    const reason = event.reason;
    const message = String(reason?.message ?? reason ?? '');
    if (DEAD_DEVICE_REJECTION.test(message)) event.preventDefault();
  };
  window.addEventListener('unhandledrejection', onRejection);
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    window.removeEventListener('unhandledrejection', onRejection);
  };
  setTimeout(stop, ms);
  return stop;
}

/**
 * @returns {Promise<{renderer: import('three/webgpu').WebGPURenderer, backend: 'webgpu'|'webgl2',
 *   fellBack: boolean, webgpuDeclined: boolean, webgpuQuarantined: boolean, notes: string[]}>}
 */
export async function createRenderer({ canvas, tier, onDeviceLost, onNeedFreshCanvas }) {
  const notes = [];
  /**
   * A canvas is permanently bound to the first context type it hands out, so once a
   * WebGPU renderer has actually configured this one, `getContext('webgl2')` on it
   * returns null and the fallback dies with "Cannot read properties of null (reading
   * 'getSupportedExtensions')". Every teardown-and-rebuild therefore asks the owner for a
   * clean canvas.
   */
  let surface = canvas;
  const freshSurface = () => { surface = onNeedFreshCanvas?.() || surface; };
  /**
   * One decision, used both for the pre-flight context request and the renderer.
   *
   * This is the ONLY anti-aliasing a profile without a temporal resolve has. With tone
   * mapping on, three draws every direct render into an internal frame-buffer target whose
   * sample count is `renderer.samples` (4 when `antialias` is true, 0 otherwise) and resolves
   * it to the canvas, so the canvas's own `antialias` attribute is not what decides the
   * sampling - this flag is. A policy may say so outright (`tier.antialias`, which the studio
   * session sets for every tier); the pixel-ratio rule below is the maze-era fallback, where
   * only the software-rasteriser tier sat at a ratio of 1.
   */
  const antialias = tier.antialias ?? tier.maxPixelRatio > 1.35;
  const forced = requestedBackend();
  let forceWebGL = !webgpuPreferred();
  /**
   * WebGL2 taken while the browser was OFFERING WebGPU - so it is a decision (the WebKit
   * rule above, or `?renderer=webgl`), not a limit of the machine. The profile scorer
   * must not read it as "this device is weaker" and dock the shadows and the bloom off a
   * Mac that can run either backend; see DeviceProfile.scoreSignals.
   */
  const webgpuDeclined = forceWebGL && webgpuLikelyAvailable();
  /**
   * The narrower fact: WebGPU was offered and held back BY THE WEBKIT RULE specifically -
   * not by `?renderer=webgl`. Kept apart from webgpuDeclined because the two answer
   * different questions: that one is for the scorer, this one is the only case where the
   * readout should tell the player there is a WebGPU here they could go and try.
   */
  const webgpuQuarantined = webgpuDeclined && !forced;

  // Until a backend is committed, a device loss is a reason to try the OTHER backend
  // rather than to fail the boot. Only losses after this point reach the application.
  let committed = false;
  let bootLoss = null;

  // Must run before the first render: without it three cannot create a texture view at
  // all on a browser that implements 'texture-component-swizzle'.
  if (!forceWebGL && installWebGPUSwizzleShim()) {
    notes.push('applied the three r185.1 GPUTextureViewDescriptor.swizzle compatibility shim');
  }

  if (forced) notes.push(`backend forced to "${forced}" by ?renderer=`);
  if (!forced && !webgpuLikelyAvailable()) notes.push('navigator.gpu absent - starting on WebGL2');
  if (webgpuQuarantined) {
    notes.push('WebKit browser - starting on WebGL2, the path verified on Safari (?renderer=webgpu overrides)');
  }

  // These rejections fire the moment the device dies, which is well before settle() gets
  // to dispose it - so the window has to cover the whole WebGPU attempt, not just the
  // teardown. It is closed shortly after a backend is committed, so a device lost during
  // actual play still reports normally.
  const stopSuppressing = forceWebGL ? () => {} : suppressDeadDeviceRejections(BOOT_SUPPRESS_MS);

  let attempt = await build();
  // If WebGPU initialised but cannot draw, tear it down and take WebGL2.
  if (!forceWebGL && detectBackend(attempt.renderer) === 'webgpu') {
    const probeErr = await probeRender(attempt.renderer);
    if (probeErr) {
      notes.push(`WebGPU initialised but failed its first render (${probeErr.slice(0, 140)}) - falling back to WebGL2`);
      disposeOnce(attempt.renderer);
      forceWebGL = true;
      freshSurface();
      attempt = await build();
      attempt.fellBack = true;
    }
  }

  /**
   * Commit to a backend, swapping to WebGL2 if the device died in the meantime.
   *
   * Device loss is delivered through a promise, so a WebGPU device can pass its first
   * render and die a moment later - measured here at ~700 ms after init, i.e. while the
   * GLBs are still loading. Before this existed that loss arrived after boot had already
   * committed, where it is fatal, and the player got an error screen on a machine where
   * WebGL2 would have run the game perfectly well.
   *
   * The caller must invoke this AFTER its slow boot work but BEFORE it builds anything on
   * the renderer. That ordering is what makes the swap free: nothing yet holds a
   * reference to the old renderer and no GPU resources have been created for the scene,
   * so there is no teardown to do and no listener to double-bind.
   *
   * @returns {Promise<object>} the committed result - re-read `renderer` and `backend`
   *   from it, they may have changed.
   */
  attempt.settle = async () => {
    if (!committed && !forceWebGL && bootLoss && detectBackend(attempt.renderer) === 'webgpu') {
      notes.push(`WebGPU lost its device during boot (${String(bootLoss).slice(0, 140)}) - falling back to WebGL2`);
      disposeOnce(attempt.renderer);
      forceWebGL = true;
      bootLoss = null;
      freshSurface();
      const next = await build();
      Object.assign(attempt, next, { fellBack: true, settle: attempt.settle });
    }
    committed = true;
    // Let the last stragglers from a torn-down device land, then stop suppressing.
    setTimeout(stopSuppressing, COMMIT_SUPPRESS_TAIL_MS);
    // A loss on a backend we are keeping still has to reach the application: after this
    // point nothing else will report it.
    if (bootLoss) onDeviceLost?.(bootLoss);
    return attempt;
  };

  return attempt;

  /**
   * Make sure `surface` can actually hand out a WebGL2 context before three asks for one.
   *
   * WebGLBackend.init() does `canvas.getContext('webgl2', attrs)` and dereferences the
   * result unchecked, so a null context surfaces as "null is not an object (evaluating
   * 'this.gl.getSupportedExtensions')" - seen on an iPhone at boot, on the WebKit path
   * that never touches WebGPU. A null has two causes that need different answers. WebKit
   * can refuse the FIRST context request after a navigation while its GPU process is
   * (re)starting, which a fresh canvas and a short wait recovers from. And WebGL can be
   * unavailable outright - Lockdown Mode, or WebGL switched off in Safari's feature
   * flags - which no retry fixes and which deserves a message that says so, rather than
   * a null dereference inside three.
   *
   * The attributes are exactly the ones three will pass, so the context taken here is the
   * one three gets back: a canvas returns its existing context to every later request
   * for the same type, whatever attributes that request carries.
   */
  async function ensureWebGL2Surface() {
    const attrs = { antialias, alpha: true, depth: true, stencil: false };
    for (let i = 0; i < WEBGL2_ACQUIRE_ATTEMPTS; i++) {
      if (surface.getContext('webgl2', attrs)) {
        if (i > 0) notes.push(`WebGL2 context refused ${i}x before it was granted - retried on a fresh canvas`);
        return;
      }
      freshSurface();
      await new Promise((resolve) => setTimeout(resolve, WEBGL2_ACQUIRE_DELAY_MS * (i + 1)));
    }
    throw new Error(
      'WebGL2 is unavailable in this browser. On iPhone and iPad this happens in Lockdown ' +
      'Mode, or when WebGL is switched off under Settings > Apps > Safari > Advanced > ' +
      'Feature Flags. On a desktop browser, check that hardware acceleration is enabled.');
  }

  async function build() {
  if (forceWebGL) await ensureWebGL2Surface();
  const renderer = new WebGPURenderer({
    canvas: surface,
    antialias,
    alpha: false,
    forceWebGL,
    powerPreference: 'high-performance',
  });

  // Shadow configuration must be in place before the first frame is built.
  renderer.shadowMap.enabled = tier.shadows;
  /**
   * VSM for the skylight profiles that can afford it: the overhead key's shadow is meant
   * to read as the soft penumbra of a large source above the walls, and VSM is the one
   * filter here whose `shadow.radius` is a real blur rather than a fixed 3x3 tap. It costs
   * two blur passes over the map every frame and a float map, so `softShadows` is a
   * separate profile field from `skylight`: the handheld tier keeps the overhead direction
   * and takes PCF's fixed penumbra. Decided with the same switch Lighting reads, so
   * `?fx=-skylight` puts the old filter back along with the old light.
   */
  renderer.shadowMap.type = fxEnabled('skylight', tier) && tier.softShadows ? VSMShadowMap
    : tier.shadowMapSize >= 1024 ? PCFSoftShadowMap
      : tier.shadowMapSize >= 768 ? PCFShadowMap : BasicShadowMap;

  renderer.outputColorSpace = SRGBColorSpace;
  // With RenderPipeline the tone map is applied by the node graph, but this property is
  // what RenderPipeline snapshots, so it is still the right place to set it.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
/**
   * Clear to TRANSPARENT black. The world scene has a Color background, which forces its
   * pass to clear opaque; the view-model scene has none, so its pass clears to this, and
   * the alpha it leaves behind is what PostFX composites the weapon over the world with.
   * three defaults clear alpha to 1 when the canvas is opaque, so this must be set on
   * EVERY renderer this function builds - the fallback instances included.
   */
  renderer.setClearColor(0x000000, 0);
  /**
   * The default onDeviceLost sets the private `_isDeviceLost` flag that guards
   * _renderScene; replacing it without setting that flag leaves the renderer trying to
   * draw into a dead device. Set it explicitly, then let the app decide what to show.
   */
  renderer.onDeviceLost = (info) => {
    renderer._isDeviceLost = true;
    // Before a backend is committed this is a fallback signal, not a failure: record it
    // and let createRenderer decide. Afterwards it is a real, fatal device loss.
    if (!committed) {
      bootLoss = info?.message || info?.reason || 'device lost during boot';
      // The device is unusable and the fallback is now certain, so release it here rather
      // than holding a dead one for the rest of the asset load. Nothing renders between
      // boot's phases, so there is no live user of it to invalidate.
      disposeOnce(renderer);
      return;
    }
    onDeviceLost?.(info);
  };

  let fellBack = false;
  try {
    await renderer.init();
  } catch (err) {
    // Both backends failed. There is nothing left to try.
    throw new Error(`Renderer init failed on both WebGPU and WebGL2: ${err?.message || err}`);
  }

  const backend = detectBackend(renderer);
  if (!forceWebGL && backend === 'webgl2') {
    fellBack = true;
    notes.push('WebGPU backend init failed - three fell back to WebGL2 automatically');
  }
  if (renderer.backend?.compatibilityMode) {
    notes.push('WebGPU compatibility mode: MSAA disabled by the device');
  }

  return { renderer, backend, fellBack, webgpuDeclined, webgpuQuarantined, notes };
  }
}

/** Which backend three actually chose, read off the backend instance's own flags. */
export function detectBackend(renderer) {
  const b = renderer.backend;
  if (!b) return 'unknown';
  if (b.isWebGPUBackend) return 'webgpu';
  if (b.isWebGLBackend) return 'webgl2';
  // Fall back to the constructor name if the flags ever move.
  return /webgpu/i.test(b.constructor?.name || '') ? 'webgpu' : 'webgl2';
}

export { NoToneMapping };
