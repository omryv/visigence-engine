/**
 * WebGPU-compatible post-processing, built from TSL nodes.
 * The legacy EffectComposer is WebGL-only, so this uses three r185's node pipeline:
 * RenderPipeline(renderer)          - PostProcessing was renamed to RenderPipeline in r183
 *   pass(scene, camera)               - from 'three/tsl'
 *   bloom(node, strength, radius, th) - from 'three/addons/tsl/display/BloomNode.js'
 * TWO PASSES, ONE IMAGE. The world is rendered by one pass node and the first-person
 * view model by a second, into a target cleared to transparent black (the renderer's
 * clear alpha is 0 and the view-model scene has no background). The two are composited
 * here, BEFORE bloom and grading, with a premultiplied "over":
 *
 *     colour = world.rgb * (1 - clamp(vm.a, 0, 1)) + vm.rgb
 *
 * Opaque weapon pixels land with alpha 1 and replace the world; MSAA-resolved edges land
 * premultiplied and blend correctly; the muzzle flash uses a blend that adds colour while
 * leaving alpha at 0, so it brightens the world instead of darkening it. Because the
 * composite happens first, bloom, grade and vignette see one frame - the weapon belongs
 * to the picture rather than sitting on top of it. The two depth buffers never meet, which
 * is what stops a nearby wall from cutting through the gun.
 *
 * The pass nodes are created ONCE and reused across every graph rebuild (a tier change
 * toggles bloom); rebuilding them would abandon two full-resolution MSAA targets per flip.
 *
 * `outputColorTransform` stays at its default true, so RenderPipeline appends
 * renderOutput() itself and the renderer's toneMapping/outputColorSpace are honoured by
 * the node graph. There is no raw shader string anywhere in this project.
 */

import { RenderPipeline, RedFormat, UnsignedByteType, HalfFloatType, Vector3 } from 'three/webgpu';
import {
  pass, uniform, vec2, vec3, vec4, float, int, screenUV, mix, smoothstep, clamp,
  mrt, output, normalView, roughness, metalness, velocity, convertToTexture,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { fxEnabled } from '../config/visualFx.js';

/**
 * The value the contrast curve pivots about, in the linear HDR the grade runs in.
 *
 * Everything below this is pushed down and everything above it is pushed up, so the pivot
 * decides WHICH tone stays put. 0.18 is the classic mid-grey anchor and it lands where
 * this level's lit terracotta actually sits, which means the corridors hold their exposure
 * while the dark between fixtures deepens and the amber pools brighten - the separation
 * the lighting rig is built around, made slightly firmer.
 */
const CONTRAST_PIVOT = 0.18;

/**
 * The split-tone: shadows toward the fill light's cold blue, highlights toward the key's amber.
 *
 * This is the level's OWN two-colour scheme (0x86B6C4 fill against 0xFFD3A6 key) restated
 * as a grade, which is what makes it read as one photograph rather than as a filter. Both
 * are multipliers around 1 rather than colours added on top: an additive tint lifts black
 * to a coloured haze, and the one thing this image cannot afford is a milky black, because
 * dark corridors between lit pools are the whole composition.
 */
const SHADOW_TINT = [0.94, 1.00, 1.05];
const HIGHLIGHT_TINT = [1.05, 1.00, 0.94];

export class PostFX {
   /**
   * @param {object} deps
   * @param {import('three/webgpu').WebGPURenderer} deps.renderer
   * @param {import('three').Scene} deps.worldScene
   * @param {import('three').Camera} deps.worldCamera
   * @param {import('three').Scene} deps.viewmodelScene
   * @param {import('three').Camera} deps.viewmodelCamera
   * @param {object} profile the session's fixed device profile
   */
  constructor({ renderer, worldScene, worldCamera, viewmodelScene, viewmodelCamera }, profile) {
    this.renderer = renderer;
    this.worldScene = worldScene;
    this.worldCamera = worldCamera;
    this.viewmodelScene = viewmodelScene;
    this.viewmodelCamera = viewmodelCamera;
    this.enabled = !!profile.postFX;

    // Live uniforms so the game can drive the grade without rebuilding the graph.
    this.uBloom = uniform(profile.bloomStrength);
    this.uVignette = uniform(0.36);
    this.uAspect = uniform(worldCamera.aspect);
    this.uDamage = uniform(0.0);
    /**
     * 1.10 -> 1.04. The grade used to be pushing saturation because the level had almost
     * none to push: a warm albedo under a warm key produced one hue, and the extra
     * saturation was making that hue louder rather than making the image more colourful.
     * Colour is now carried by the LIGHTS - a cold research panel and an amber warning lamp
     * falling on a near-neutral wall - so the grade's job is to leave them alone. At 1.10
     * the specimen hall's cyan clipped into a flat green wash.
     */
    this.uSaturation = uniform(1.04);
    this.uLift = uniform(0);
    /**
     * Gentle. ACES already supplies the shoulder; this only firms up the mid-range.
     *
     * Up a notch with the exposure rebalance, because the composition now depends on the
     * gap between a lit pool and the dark between pools being read as a gap. A contrast
     * curve about a mid pivot is the cheapest way to widen that gap without lifting black
     * or clipping the lamps.
     */
    this.uContrast = uniform(1.07);
    /** How much of the split tone to apply, 0..1. */
    this.uSplit = uniform(0);
    /**
     * The split tone's two colours, live. The level's pair (SHADOW_TINT / HIGHLIGHT_TINT)
     * is the authored default; a look (config/looks.js) may put a district's cyan in the
     * shadows and its neon in the highlights instead, without touching the graph.
     */
    this.uShadowTint = uniform(new Vector3(...SHADOW_TINT));
    this.uHighlightTint = uniform(new Vector3(...HIGHLIGHT_TINT));
    /**
     * Output dither amplitude, as a fraction of each pixel's own value.
     *
     * The canvas is 8 bits and this image is mostly smooth dark gradients - fog, vignette,
     * the falloff of a point light down a corridor wall - which is exactly the content
     * that quantises into visible contour rings. A sub-LSB noise breaks the rounding up so
     * those rings become grain, which the eye discards. Kept relative to the pixel value
     * (plus a small floor so true black still gets some) because the output transform is
     * roughly a power curve: a constant amplitude here would be invisible in the highlights
     * and coarse in the shadows.
     */
    this.uDither = uniform(0.022);
    this.worldPass = pass(worldScene, worldCamera);
    /**
     * THE WORLD PASS IS NOT MULTISAMPLED WHEN THE TEMPORAL PASS IS ON, on either backend.
     *
     * Depth-reading effects copy this target to a single-sample depth texture, and WebGPU
     * forbids copying MSAA depth into it (black frame / GPUValidationError) - which is why
     * it was already off there. On WebGL2 the blit resolve works, so the pass was running
     * 4x MSAA AND the temporal resolve over it: two anti-aliasing solutions for one image,
     * the first of which quadruples the world pass's colour and depth bandwidth for an edge
     * quality the second then replaces. TRAA owns anti-aliasing where it runs; MSAA stays
     * for the profiles without it (it is the only AA they have) and for the view-model pass,
     * which is composited after the temporal resolve and is never smeared by the history.
     */
    const temporalAA = !!profile.postFX && fxEnabled('traa', profile);
    if (renderer.backend?.isWebGPUBackend || temporalAA) this.worldPass.options.samples = 0;
    this.vmPass = pass(viewmodelScene, viewmodelCamera);
    this.bloomNode = null;

    /**
     * AMBIENT OCCLUSION (option 1). Decided once, like everything else in the profile.
     *
     * A GTAO node reads the world pass's depth (and the normals it implies - see below)
     * to estimate how much of the hemisphere
     * over each pixel is blocked by nearby geometry. Where a wall meets the floor, under a
     * crate, inside the plinth step, behind a conduit bracket: that is the contact
     * darkening the level had none of, and its absence is most of what made the corners
     * read as a blockout. Denoised against the same depth and normal, then applied to the
     * world before the view model is composited over it - the weapon is drawn in its own
     * pass and has no world geometry to be occluded by.
     *
     * Only the world is occluded, and it is multiplied in before bloom: the emissives and
     * flashes bloom from what the eye sees. Half resolution (`aoScale`) on standard.
     */
    this.aoEnabled = !!profile.postFX && fxEnabled('ao', profile);
    this.uAo = uniform(1.0);
    this.aoNode = null;
    if (this.aoEnabled) {
      /**
       * Normals come FROM DEPTH, not from an MRT. The first version wrote view-space
       * normals to a second target, and every additive light shaft and haze cone - which
       * write no depth - wrote its own normal over the wall behind it. The occluder then
       * had the wall's depth and the cone's normal, and each cone became a black wedge.
       * Reconstructing the normal from the depth buffer means the two always describe the
       * same surface, and anything that does not write depth cannot touch the occlusion.
       */
      this.aoNode = ao(this.worldPass.getTextureNode('depth'), null, worldCamera);
      this.aoNode.resolutionScale = profile.aoScale ?? 0.5;
      /**
       * The corridors are 3 m wide and the props are a metre tall, so a 0.6 m radius is
       * where the contact darkening lives; the distance fall-off keeps a far wall from
       * occluding the near one across the corridor. `scale` is the strength.
       */
      this.aoNode.radius.value = 0.75;
      this.aoNode.distanceExponent.value = 1.4;
      this.aoNode.distanceFallOff.value = 0.8;
      this.aoNode.thickness.value = 0.8;
      /**
       * 1.5 -> 1.15. The screen-space pass is no longer the only occlusion in the level:
       * the maze renderer baked a contact term into its wall vertices and the floor's into
       * its wear map's alpha, both correct at grazing angles and off screen where this pass
       * is blind. Two full-
       * strength occlusion terms multiplied together is exactly the black outline the brief
       * rules out, so this one steps back and handles what only it can see: the small
       * contacts, under a crate, behind a bracket, inside the plinth step.
       */
      this.aoNode.scale.value = 1.15;
      // Compiled into the pass: the handheld tier takes 8 where the desktop tiers take 12.
      this.aoNode.samples.value = profile.aoSamples ?? 12;
    }

    /**
     * SCREEN-SPACE REFLECTIONS (option 4). `full` only, and `?fx=ssr` elsewhere.
     *
     * The world pass writes two more targets - the view-space normal and a
     * (roughness, metalness) pair - and the reflection pass marches the depth buffer from
     * every pixel whose roughness is low enough to be worth it. In this level that is the
     * wet floor (puddles at 0.06, the walked line at 0.45), the painted-steel doors and
     * the conduit, and the blood; the terracotta at 0.8+ contributes nothing and costs
     * nothing. Every UNLIT material declares roughness 1 to these targets (see
     * render/Environment.js markUnlit), which is what keeps a light shaft from becoming a
     * mirror. Half resolution, blurred by roughness, added to the world before the view
     * model is composited.
     */
    /**
     * WEBGPU ONLY. three r185's SSRNode does not compile on the WebGL2 backend: its
     * ray-step count is `trunc(float).max(int(1))`, which GLSL rejects (no max(float, int)
     * overload), and its stochastic variant compiles there but produced no reflection at
     * all in this project's headless WebGL2 runs, with or without material inputs. Neither
     * could be traced further without a GPU, so the pass is built only where three ships
     * and demonstrates it. `?fx=ssr` on WebGL2 is therefore a no-op, and the report says
     * so; the wet floor's probe reflections do not depend on this.
     */
    const backendOk = !!renderer.backend?.isWebGPUBackend;
    this.ssrEnabled = !!profile.postFX && fxEnabled('ssr', profile) && backendOk;
    this.ssrSkipped = !!profile.postFX && fxEnabled('ssr', profile) && !backendOk;
    this.uSsr = uniform(1.0);
    this.ssrNode = null;

    /**
     * THE POST STACK (option 5). Temporal anti-aliasing and motion blur both read a
     * per-pixel velocity written by the world pass, so the pass's MRT is assembled once
     * here from everything that wants a target: colour always, normal + roughness/metalness
     * for the reflections, velocity for the two temporal effects.
     */
    this.traaEnabled = !!profile.postFX && fxEnabled('traa', profile);
    this.motionBlurEnabled = !!profile.postFX && fxEnabled('motionBlur', profile);
    this.dofEnabled = !!profile.postFX && fxEnabled('dof', profile);
    this.lensflareEnabled = !!profile.postFX && fxEnabled('lensflare', profile);
    this.filmEnabled = !!profile.postFX && fxEnabled('film', profile);
    this.motionBlurSamples = profile.motionBlurSamples ?? 8;
    /** 1 blurs along the velocities, 0 draws without the blur (live: no rebuild). See setMotionBlur. */
    this.uMotionBlur = uniform(1.0);
    const targets = { output };
    if (this.ssrEnabled) { targets.normal = normalView; targets.rm = vec4(roughness, metalness, 1, 1); }
    if (this.aoEnabled && !this.ssrEnabled) targets.aoMask = float(1);
    if (this.traaEnabled || this.motionBlurEnabled) targets.velocity = velocity;
    if (Object.keys(targets).length > 1) this.worldPass.setMRT(mrt(targets));

    if (this.aoEnabled && !this.ssrEnabled) {
      const mask = this.worldPass.getTexture('aoMask'); mask.format = RedFormat; mask.type = UnsignedByteType;
    }

    /** Depth of field: focus distance and how quickly things leave it, driven from ADS. */
    this.uDof = uniform(0.0);
    this.uFocus = uniform(9.0);
    this.uFocalLength = uniform(9.0);
    this.uBokeh = uniform(1.1);
    /** Lens flare and grain strengths, live. */
    this.uFlare = uniform(0.55);
    this.uGrain = uniform(0.35);
    /** How much of the view model reaches the composite. See the composite below. */
    this.uViewmodel = uniform(1.0);

    if (this.ssrEnabled) {
      const rm = this.worldPass.getTextureNode('rm');
      /**
       * The roughness the reflection pass sees is the material's, sharpened: everything
       * above 0.6 is treated as 1 (no reflection), so the march is only paid for on the
       * surfaces that can show one. Below that it is the real value, and the pass blurs
       * the result by it.
       */
      const rough = smoothstep(0.25, 0.62, rm.r).mul(0.75).add(rm.r.mul(0.25)).clamp(0, 1);
      this.ssrNode = ssr(this.worldPass.getTextureNode(), this.worldPass.getTextureNode('depth'),
        this.worldPass.getTextureNode('normal'), {
          roughnessNode: rough, metalnessNode: rm.g, reflectNonMetals: true, camera: worldCamera,
        });
      this.ssrNode.resolutionScale = profile.ssrScale ?? 0.5;
      this.ssrNode.maxDistance.value = 7;
      this.ssrNode.thickness.value = 0.18;
      this.ssrNode.quality.value = 0.45;
    }

    this.pipeline = new RenderPipeline(renderer);
    this._build();
  }

  _build() {
    let world = this.worldPass.getTextureNode();
    const vm = this.vmPass.getTextureNode();
    /**
     * Temporal anti-aliasing first, on the world as rendered: it jitters the world camera
     * by a fraction of a pixel each frame (a view offset the camera keeps through its own
     * updateProjectionMatrix) and resolves against the previous frame through the velocity
     * target. The view model has its own camera and MSAA and is composited after, so the
     * weapon is never smeared by the history.
     */
    if (this.traaEnabled) {
      this.traaNode?.dispose?.();
      this.traaNode = traa(world, this.worldPass.getTextureNode('depth'), this.worldPass.getTextureNode('velocity'), this.worldCamera);
      world = this.traaNode;
    }
    // Per-object motion blur from the same velocities: a charging enemy streaks, a still
    // one does not, and a camera turn blurs the world by exactly as far as it moved.
    if (this.motionBlurEnabled) {
      // The blur samples its input along the velocity, so the input has to be a texture.
      // Scaled by a live uniform so a view that jumps the camera between frames (the level editor) can turn it off.
      world = motionBlur(convertToTexture(world), this.worldPass.getTextureNode('velocity').mul(this.uMotionBlur), int(this.motionBlurSamples));
    }
    /**
     * Depth of field, only while aiming. The focus sits where the sights are looking and
     * uDof follows the ADS blend, so the world softens at the edges of the sight picture
     * as the weapon comes up and clears as it drops. Off the sights the world is sharp.
     */
    if (this.dofEnabled) {
      this.dofNode?.dispose?.();
      this.dofNode = dof(world, this.worldPass.getViewZNode(), this.uFocus, this.uFocalLength, this.uBokeh);
      const renderDof = this.dofNode.updateBefore.bind(this.dofNode);
      let primed = false;
      this.dofNode.updateBefore = frame => {
        // Prime once so the shader never samples an uninitialized target. Thereafter,
        // idle ADS skips all seven passes without rebuilding the node graph.
        if (!primed || this.uDof.value > 0) { renderDof(frame); primed = true; }
      };
      world = mix(vec4(world), vec4(this.dofNode), this.uDof);
    }
    if (this.aoNode) {
      const aoTex = denoise(this.aoNode.getTextureNode(), this.worldPass.getTextureNode('depth'),
        null, this.worldCamera);
      const mask = this.ssrEnabled ? this.worldPass.getTextureNode('rm').b : this.worldPass.getTextureNode('aoMask').r;
      const occlusion = mix(float(1), aoTex.r, this.uAo.mul(mask));
      world = vec4(world.rgb.mul(occlusion), world.a);
    }
    if (this.ssrNode) {
      // The pass returns the reflection already weighted by the surface's response.
      world = vec4(world.rgb.add(this.ssrNode.rgb.mul(this.uSsr)), world.a);
    }
// --- composite: view model over world, premultiplied ---
    /**
     * `uViewmodel` dissolves the whole view model without touching a single material.
     *
     * The scoped sight needs the weapon, the hands and the optic housing to be gone by the
     * time the player's eye is in the sight - a sniper's view has no receiver in it - and it
     * has to leave smoothly, because a hard cut at any blend shows the inside of the model
     * for a frame as the near plane crosses it. Both layers of the premultiplied composite
     * are scaled by the same factor, which is exactly a cross-fade of the view-model layer:
     * at 1 this is the expression it has always been, at 0 the world is untouched.
     *
     * It is a RENDER fade and nothing else. The view model still updates, so the wall
     * pushback, the muzzle socket the flash and tracers come from, and the shot's own
     * geometry all carry on unchanged behind it - an invisible weapon is still a weapon.
     */
    const a = clamp(vm.a, 0, 1).mul(this.uViewmodel);
    const composed = world.rgb.mul(float(1).sub(a)).add(vm.rgb.mul(this.uViewmodel));
    this.compositeNode?.dispose?.();
    this.compositeNode = this.enabled ? convertToTexture(vec4(composed, 1)) : null;
    const composite = this.compositeNode ? this.compositeNode.rgb : composed;
    let out = composite;
    if (this.bloomNode) { this.bloomNode.dispose?.(); this.bloomNode = null; }
    if (this.enabled) {
      // Threshold is high enough that only the emissive props, muzzle flashes and
      // explosion cores bloom - the brief explicitly rules out a bloom-soaked image.
      this.bloomNode = bloom(composite, this.uBloom, 0.45, 0.82);
      /**
       * Lens flare, from the bloom's own bright sources: the muzzle flash, the emissive
       * fixtures, the emissive glow. Ghosts across the centre rather than a starburst,
       * kept faint - a flare that reads as a flare is a flare the eye tracks instead of the
       * enemy behind it.
       */
      if (this.lensflareEnabled) {
        this.flareNode?.dispose?.();
        this.flareNode = lensflare(this.bloomNode, {
          threshold: 0.62, ghostSamples: 3, ghostSpacing: 0.30, ghostAttenuationFactor: 24,
          ghostTint: vec3(0.86, 1.0, 0.94),
        });
        this.flareNode._renderTarget.texture.type = HalfFloatType;
      }
      /**
       * `.rgb`, NOT the bare node. The bloom texture is a vec4, and vec3 + vec4 promotes
       * the whole chain below to vec4 - which is not a harmless extra channel. TSL widens
       * every vec3 constant it meets to match, so `contrasted.dot(vec3(luma))` became
       * dot(vec4, vec4(luma, 1)) and the luminance had the bloom's alpha (1.0) added to
       * it. Every step keyed off `lum` then misread the image as blown out: saturation
       * subtracted a tenth from every channel, the split-tone put the warm highlight tint
       * on everything, and the lift went negative - the level rendered dark, crushed and
       * saturated red, with only the emissives keeping any green. The final vec4(x, 1)
       * then had five inputs, dropped the 1, and wrote that same garbage as the canvas
       * alpha (three logs "Length of parameters exceeds maximum length of function
       * 'vec4()'" for it). It was invisible in every profile without bloom, which is what
       * the automated runs use, and wrong in every profile with it, which is what a
       * desktop gets.
       */
      out = composite.add(this.bloomNode.rgb);
      if (this.flareNode) out = out.add(this.flareNode.rgb.mul(this.uFlare));
    }

    /**
     * --- the grade ---
     *
     * Everything from here runs in LINEAR HDR, before tone mapping: `outputColorTransform`
     * is left at its default, so RenderPipeline appends renderOutput() - ACES plus the sRGB
     * transfer - after this node. That ordering is why the steps below are all gentle and
     * all multiplicative. ACES is about to compress the highlights anyway, so anything
     * heavy-handed here is spent twice; and a multiplier cannot lift black off zero, which
     * an image composed of lit pools separated by darkness cannot afford.
     *
     * Order is the conventional one - contrast, saturation, tone, lift - because each step
     * reads the luminance the previous one left, and doing them out of order makes the
     * numbers stop meaning what they say.
     */

    // Contrast about a mid pivot. `max(0)` guards the pow: the composite is non-negative
    // by construction, and this keeps it that way if a future pass ever is not.
    const base = out.max(0);
    // Apply contrast to luminance, preserving hue through the curve.
    const baseLum = base.dot(vec3(0.2126, 0.7152, 0.0722));
    const contrastLum = baseLum.div(CONTRAST_PIVOT).pow(this.uContrast).mul(CONTRAST_PIVOT);
    const contrasted = base.mul(contrastLum.div(baseLum.max(0.000001)));

    const lum = contrasted.dot(vec3(0.2126, 0.7152, 0.0722));
    const sat = mix(vec3(lum), contrasted, this.uSaturation);

    // Split tone. The two masks deliberately overlap around the mid-tones, where their
    // opposite tints partly cancel: that is what keeps the transition smooth instead of
    // banding at a threshold, and leaves the mids where they were.
    const shadowMask = float(1).sub(smoothstep(0, 0.30, lum)).mul(this.uSplit);
    const highMask = smoothstep(0.26, 1.05, lum).mul(this.uSplit);
    const tint = vec3(1)
      .add(this.uShadowTint.sub(1).mul(shadowMask))
      .add(this.uHighlightTint.sub(1).mul(highMask));
    const toned = sat.mul(tint);

    const lifted = toned.add(vec3(this.uLift).mul(float(1).sub(lum)));

    // --- vignette, driven from screen UV ---
    const d = screenUV.sub(0.5).mul(vec2(this.uAspect, 1)).length();
    const vig = float(1).sub(smoothstep(0.35, 0.86, d).mul(this.uVignette));

    // --- damage flash: a red wash pushed in from the edges ---
    const dmgEdge = smoothstep(0.15, 0.78, d).mul(this.uDamage);
    const graded = lifted.mul(vig);
    const withDamage = mix(graded, vec3(0.72, 0.10, 0.06), clamp(dmgEdge, 0, 0.82));

    /**
     * --- output dither, the last thing before the display transform ---
     *
     * A per-pixel hash rather than an ordered matrix: an ordered pattern is stable in
     * screen space, so on a slow pan it reads as a fixed texture laid over the world,
     * which is worse than the banding it removes. This is derived from screenUV alone -
     * scaled up first, because at 0..1 across the screen the sine's argument barely moves
     * between neighbouring pixels and the "noise" would come out as a smooth moire.
     *
     * Amplitude rides the pixel's own value plus a small floor, so it is proportionate
     * after the display transform rather than crushing the shadows. See uDither.
     */
    let dithered;
    if (this.filmEnabled) {
      /**
       * Sharpen, then grain, in place of the hash dither. Temporal AA and the half-res
       * passes all take a little edge off the image; the sharpen puts it back on the
       * graded frame, and the grain - a time-varying noise rather than a fixed screen
       * hash - is what breaks the 8-bit banding the dither used to, while reading as
       * film rather than as a pattern.
       */
      const sharp = sharpen(withDamage, 0.5, true);
      dithered = film(sharp, this.uGrain.mul(0.22)).rgb.max(0);
    } else {
      const hash = screenUV.mul(1024).dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract();
      const grain = hash.sub(0.5).mul(this.uDither);
      dithered = withDamage.add(withDamage.add(0.03).mul(grain)).max(0);
    }

    // Alpha pinned to 1: the WebGL2 fallback context is created with alpha, and a pass
    // alpha above 1 (additive particles in a float target) or below it would bleed the page.
    // `.rgb` guarantees the join is three components plus the constant, whatever width the
    // chain above happens to have - see the bloom composite for what happens otherwise.
    this.pipeline.outputNode = vec4(dithered.rgb, 1);
    /**
     * `?debug=ssr|normal|rm|ao` shows one intermediate target instead of the frame, for
     * bisecting the reflection and occlusion passes in a headless capture. Dev-only in
     * spirit; harmless if left on since it reads like a broken frame and nothing else.
     */
    const dbg = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('debug') : null;
    if (dbg === 'ssr' && this.ssrNode) this.pipeline.outputNode = vec4(this.ssrNode.rgb, 1);
    if (dbg === 'normal' && this.ssrNode) this.pipeline.outputNode = vec4(this.worldPass.getTextureNode('normal').rgb.mul(0.5).add(0.5), 1);
    if (dbg === 'rm' && this.ssrNode) this.pipeline.outputNode = vec4(this.worldPass.getTextureNode('rm').rgb, 1);
    if (dbg === 'ao' && this.aoNode) this.pipeline.outputNode = vec4(vec3(this.aoNode.getTextureNode().r), 1);
    this.pipeline.needsUpdate = true;
  }

  /**
   * There is deliberately no runtime tier switch here any more.
   *
   * Toggling post-processing rebuilt the whole node graph and every pipeline behind it,
   * which is a visible hang; the old adaptive controller did it while the player was
   * moving. Whether the post chain runs is now decided once from the device profile and
   * fixed for the session - see config/quality.js. Bloom strength is a live uniform, so if
   * anything ever needs to fade it, set `uBloom.value` and no rebuild happens.
   */

  /**
   * Apply a look's grade (config/looks.js) over the authored one. Every field is a live
   * uniform, so this is free on any frame; `null` restores the authored values captured
   * at construction.
   */
  setLook(look) {
    const b = this._authoredGrade ||= {
      saturation: this.uSaturation.value, contrast: this.uContrast.value, lift: this.uLift.value,
      vignette: this.uVignette.value, split: this.uSplit.value, grain: this.uGrain.value,
      bloom: this.uBloom.value, shadowTint: SHADOW_TINT, highlightTint: HIGHLIGHT_TINT,
    };
    const p = look?.post ?? null;
    this.uSaturation.value = p?.saturation ?? b.saturation;
    this.uContrast.value = p?.contrast ?? b.contrast;
    this.uLift.value = p?.lift ?? b.lift;
    this.uVignette.value = p?.vignette ?? b.vignette;
    this.uSplit.value = p?.split ?? b.split;
    this.uGrain.value = p?.grain ?? b.grain;
    this.uBloom.value = b.bloom * (p?.bloomScale ?? 1);
    const st = p?.shadowTint ?? b.shadowTint, ht = p?.highlightTint ?? b.highlightTint;
    this.uShadowTint.value.set(st[0], st[1], st[2]);
    this.uHighlightTint.value.set(ht[0], ht[1], ht[2]);
    // setGrain() captures the authored grain the first time it runs; a look changes what
    // "authored" means, so the capture follows the look.
    if (this._authoredGrain) this._authoredGrain.grain = this.uGrain.value;
  }

  /** 0..1 red damage wash. Driven from the player's recent damage. */
  setDamage(v) { this.uDamage.value = v; }
  /** 0..1 aim-down-sights blend: drives the depth of field. */
  setAds(blend) { this.uDof.value = blend; }
  /**
   * Motion blur on or off. The level editor draws on demand and its orbit, pan and zoom jump the camera between
   * frames, so the velocities are whole screen-widths and the blur smeared the world into streaks.
   */
  setMotionBlur(on) { this.uMotionBlur.value = on ? 1 : 0; }
  render() { this.uAspect.value = this.worldCamera.aspect; this.pipeline.render(); }
   dispose() {
    this.traaNode?.dispose?.();
    this.dofNode?.dispose?.();
    this.flareNode?.dispose?.();
    this.ssrNode?.dispose?.();
    this.aoNode?.dispose?.();
    this.bloomNode?.dispose?.();
    this.worldPass.dispose?.();
    this.vmPass.dispose?.();
    this.compositeNode?.dispose?.();
    this.pipeline.dispose?.();
  }
}
