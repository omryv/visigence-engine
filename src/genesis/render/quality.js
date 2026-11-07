// GPU tier detection + quality presets. The engine self-manages performance:
// detect once, pick a preset, and let modules read caps from engine.quality.
//
// The graphics-boost flags, tier by tier:
//   post          HDR post pipeline (bloom + cinematic finish). Needs
//                 EXT_color_buffer_float; the pipeline falls back to the
//                 direct path when the extension is missing.
//   postSamples   MSAA samples on the HDR scene target. Load-bearing on any
//                 tier that runs post WITHOUT taa: once the frame is
//                 composited from an offscreen target the canvas is drawn by
//                 a fullscreen triangle, so the renderer's own `antialias:
//                 true` has no edges left to work on and this is the only
//                 antialiasing in the frame. Ignored where taa is on, which
//                 does the same job from the jitter instead.
//   postMips      bloom pyramid depth. Each level halves, starting at half
//                 res, so 5 puts the coarsest at 1/32 OF THE FRAME — a
//                 fraction, not a pixel count, and therefore the same share
//                 of the picture at every resolution. Fewer levels is a
//                 tighter halo for two fewer passes.
//   scatterDistance  how far scattered vegetation is drawn, in metres. The
//                 batches cannot use three's own frustum culling — a batch
//                 spans the world, so its bounding sphere is the world — so
//                 every plant used to be submitted every frame, including the
//                 ones behind you and over the horizon. This is the per-plant
//                 cull's cutoff (props/scatter-cull.js); it opens up with
//                 camera altitude so a framing orbit still sees the whole
//                 world, and the shadow volume is exempt from it so a tree
//                 behind the camera keeps casting into the shot.
//   godRays       RETIRED, and false on every tier. It was a radial blur from
//                 the sun's SCREEN position, which has a defect you can walk
//                 into: turn until the sun is behind you and every shaft in
//                 the world vanishes, though nothing casting them moved. Kept
//                 as a flag only because a tier may want the cheap effect
//                 back one day; nothing sets it, and volumetric replaces it.
//   volumetric    light in the AIR: a quarter-res world-space ray march that
//                 asks the sun's shadow map whether each step is lit, so a
//                 doorway throws a shaft whichever way the camera points, and
//                 lamps and fires light the air around them rather than only
//                 the surfaces they touch. Dithered per pixel and resolved by
//                 taa — the same trick that makes eight AO samples a frame
//                 look like two hundred — so it needs taa and the depth
//                 texture, and is the top two tiers only.
//   volumetricSteps  samples along each ray. The whole cost of the pass.
//   reflectionRes planar water reflection map size; 0 = analytic sky only.
//   envMap        procedural-sky PMREM as scene.environment (IBL).
//   terrainDetail triplanar detail textures on the ground.
//   rainCount / snowCount   weather particle budgets.
//   fireflies     night ambient motes; 0 disables them.
//   fireLights    flickering point lights the fire system may own at once.
//   ingressSlots  openings the rain-ingress pool may drive at once: the
//                 windows and doorways nearest the viewer that weather
//                 actually blows through (fx/ingress.js).
//   lampLights    real point lights the interior lamp pool may own at once.
//                 Emissive geometry is free and lights nothing; these are the
//                 few that actually light a room, spent on the nearest lamps.
//   taa           temporal accumulation. Replaces MSAA rather than joining
//                 it: while the camera moves each frame is one jittered
//                 sample (what you always had), and the moment it stops the
//                 frame averages toward a converged image no realtime
//                 renderer can match. Everything below rides on it.
//   taaFrames     how many samples a still frame converges over.
//   ssao          screen-space ambient occlusion from the depth buffer.
//                 Eight samples a frame is noise on its own — TAA is what
//                 turns it into a couple of hundred.
//   contactShadows  short depth-buffer ray toward the sun: the small sharp
//                 shadow where an object meets the ground, which a single
//                 shadow cascade stretched over hundreds of metres cannot
//                 resolve at any resolution.
//   grassShadows  vegetation casts and receives. Doubles the shadow pass's
//                 draw count, so it is the top two tiers only.
//
// NEITHER IS BLOOM, ANY MORE, AND FOR THE SAME REASON. `post` used to be
// false on the low tier, which meant every phone, every masked GPU under
// eight cores and every software rasteriser rendered a world where a lit
// window at midnight, a lamp in a doorway and an open fire were all exactly
// as bright as the wall behind them — the emissive materials were there, the
// HDR values were there, and nothing in the pipeline ever turned them into
// light. The low tier now runs a BLOOM-ONLY configuration: threshold, a
// three-level pyramid and the composite, with no temporal accumulation, no
// occlusion pass and no depth texture. It is the cheapest part of the
// pipeline and the part that carries the most of the look.
//
// The catch, which is the whole reason postSamples exists above: compositing
// costs the tier its free canvas MSAA, because the canvas ends up being drawn
// by one fullscreen triangle. So low buys 2× MSAA on the scene target to get
// back what it would otherwise have silently lost. Bloom for jaggies would
// have been a poor trade and it is not the one being made here.
//
// SHADOWS ARE NOT A TIER FLAG ANY MORE. They used to be `high` and above,
// which meant every Intel/Iris/UHD desktop, every masked GPU under eight
// cores and every phone got a world lit by a sun that cast nothing — the
// single most visible thing a renderer does, switched off for most of the
// people looking at it. What that flag was really protecting against is the
// COST of the pass, and the cost is resolution plus how much geometry is in
// it: one cascade, redrawn only when the world or the sun actually moves
// (Engine._needsShadow, shadowMap.autoUpdate = false), is one depth pass over
// terrain and props — affordable everywhere. So every tier casts now, and the
// tiers differ in shadowRes and in whether VEGETATION joins the pass, which
// is the part that doubles the draw count.

export const QUALITY_PRESETS = {
  // grassCount is the detail budget on authored patches (grass is dev-placed,
  // not auto-scattered) — one textured card cluster per 3 counted "blades",
  // so the tiers keep their historic meaning. Even the low tier keeps a
  // budget so placements render.
  low:    { pixelRatio: 1,   terrainDepth: 4, tileRes: 33, shadows: true,  grassCount: 9000, scatterDistance: 260,   cloudsVolumetric: false, ambientAnimation: false, anisotropy: 1,
            post: true,  postSamples: 2, postMips: 3, godRays: false, volumetric: false, volumetricSteps: 0, reflectionRes: 0,    envMap: false, terrainDetail: false, rainCount: 1600, snowCount: 1000, fireflies: 0,   fireLights: 1, lampLights: 2, ingressSlots: 2,
            taa: false, taaFrames: 0,  ssao: false, contactShadows: false, grassShadows: false, shadowRes: 1024 },
  medium: { pixelRatio: 1.5, terrainDepth: 5, tileRes: 49, shadows: true,  grassCount: 30000, scatterDistance: 420,  cloudsVolumetric: false, ambientAnimation: true,  anisotropy: 2,
            post: true,  postSamples: 2, postMips: 5, godRays: false, volumetric: false, volumetricSteps: 0, reflectionRes: 0,    envMap: true,  terrainDetail: true,  rainCount: 4200, snowCount: 2400, fireflies: 90,  fireLights: 2, lampLights: 3, ingressSlots: 3,
            taa: true,  taaFrames: 16, ssao: true,  contactShadows: false, grassShadows: false, shadowRes: 2048 },
  high:   { pixelRatio: 2,   terrainDepth: 6, tileRes: 65, shadows: true,  grassCount: 90000, scatterDistance: 700,  cloudsVolumetric: true,  ambientAnimation: true,  anisotropy: 4,
            post: true,  postSamples: 4, postMips: 5, godRays: false, volumetric: true,  volumetricSteps: 24, reflectionRes: 512,  envMap: true,  terrainDetail: true,  rainCount: 7000, snowCount: 3800, fireflies: 150, fireLights: 3, lampLights: 4, ingressSlots: 4,
            taa: true,  taaFrames: 24, ssao: true,  contactShadows: true,  grassShadows: true,  shadowRes: 2048 },
  ultra:  { pixelRatio: 2,   terrainDepth: 7, tileRes: 65, shadows: true,  grassCount: 180000, scatterDistance: 1100, cloudsVolumetric: true,  ambientAnimation: true,  anisotropy: 8,
            post: true,  postSamples: 4, postMips: 5, godRays: false, volumetric: true,  volumetricSteps: 40, reflectionRes: 1024, envMap: true,  terrainDetail: true,  rainCount: 9500, snowCount: 5000, fireflies: 220, fireLights: 4, lampLights: 6, ingressSlots: 6,
            taa: true,  taaFrames: 32, ssao: true,  contactShadows: true,  grassShadows: true,  shadowRes: 4096 },
};

/* Detection from a RAW GL CONTEXT rather than from a renderer, because one of
   the renderer's own construction options now depends on the answer and there
   is no renderer yet to ask. See probeDevice below. */
export function detectGpuTierFromGL(gl) {
  try {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    const g = gpu.toLowerCase();
    // Safari removed WEBGL_debug_renderer_info and Chrome is restricting it,
    // so on the devices that most need protecting `g` is "" and every pattern
    // below misses. A touch-primary pointer is the signal that survives.
    const handheld = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const cores = globalThis.navigator?.hardwareConcurrency || 4;
    console.info("[engine] gpu:", gpu || "(masked)", handheld ? "· touch device" : "");

    if (/(swiftshader|llvmpipe|software|basic render)/.test(g)) return "low";
    if (/(mali|adreno|powervr)/.test(g)) return cores >= 8 ? "medium" : "low";
    // "Apple GPU" is what an iPhone reports — only the desktop M-series earns high.
    if (/apple m[1-9]/.test(g) && !handheld) return "high";
    if (/(rtx|radeon pro|rx [67]|arc)/.test(g)) return "high";
    if (/(intel|iris|uhd|apple)/.test(g)) return handheld ? "low" : "medium";
    // Masked GPU. MAX_TEXTURE_SIZE is a memory limit, not a speed rating: every
    // current phone reports 16384 too, so on its own it must never be the
    // reason to hand out the heaviest preset.
    if (handheld) return cores >= 8 ? "medium" : "low";
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < 16384) return "medium";
    return cores >= 8 ? "high" : "medium";
  } catch {
    return "medium";
  }
}

export function detectGpuTier(renderer) {
  return detectGpuTierFromGL(renderer.getContext());
}

/* ── what has to be known BEFORE `new WebGLRenderer` ──
 * `antialias: true` asks the browser for a MULTISAMPLED DEFAULT FRAMEBUFFER,
 * and it is a context-creation attribute: it cannot be changed afterwards, and
 * the renderer that would answer the question does not exist yet.
 *
 * It also stopped being free. Every tier composites now, and a composited
 * frame reaches the canvas as one fullscreen triangle with no interior edges
 * — so the multisampling has nothing to antialias and the frame's actual
 * antialiasing comes from TAA or from postSamples on the scene target. What
 * `antialias: true` buys in that configuration is a second, multisampled copy
 * of the whole drawing buffer that is never resolved into anything: about
 * 40 MB on a phone at devicePixelRatio 2, several times that on a large
 * desktop panel, allocated for nothing on the hardware least able to spare it.
 *
 * So the tier is probed on a 1×1 throwaway context first, and the real
 * renderer is built knowing whether it will composite. The probe also asks
 * about EXT_color_buffer_float, because a device without it falls back to the
 * direct path — and that path draws geometry straight to the canvas, where
 * the multisampling is real and worth having.
 *
 * The throwaway context is explicitly lost rather than left for the GC:
 * browsers cap live WebGL contexts (commonly around 16) and silently kill the
 * oldest, which would be the editor's own. */
export function probeDevice(override) {
  let gl = null;
  try {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    gl = probe.getContext("webgl2");
    if (!gl) return { tier: override || "medium", floatColor: false };
    return {
      tier: override || detectGpuTierFromGL(gl),
      floatColor: !!gl.getExtension("EXT_color_buffer_float"),
    };
  } catch {
    return { tier: override || "medium", floatColor: false };
  } finally {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/* True when the frame will reach the canvas through the post composite, and
   therefore when the canvas's own multisampling would be paid for and unused.
   Takes the probe rather than a live renderer, for the reasons above. */
export function willComposite({ tier, floatColor }) {
  return !!(QUALITY_PRESETS[tier]?.post && floatColor);
}

export function resolveQuality(renderer, override) {
  const tier = override || detectGpuTier(renderer);
  const preset = { tier, ...QUALITY_PRESETS[tier] };
  preset.pixelRatio = Math.min(preset.pixelRatio, globalThis.devicePixelRatio || 1);
  return preset;
}
