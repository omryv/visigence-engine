// Water: one animated plane at sea level. The material is depth-aware — it
// samples the world's own heightfield (as a texture) so shallows are CLEAR
// (you see the bottom through them), depth builds toward the body colour,
// and the shoreline gets an animated foam band. The same texture carries the
// SEA-CONNECTED MASK (water/flood.js): a hollow the sea cannot reach is
// discarded outright, so digging a pit in a mountain gives you a pit, not a
// pond, and digging a channel to the shore lets the water run in along an
// animated front driven by a single uniform. Reflection is an analytic
// model of the same procedural sky the dome renders, capped so grazing
// angles never collapse into a solid mirror. Wave detail comes from a
// tiling normal map (three.js ocean's waternormals.jpg) with a procedural
// fallback, faded to flat with distance so it can never alias into static.
// The plane is double-sided: from below it renders as the underwater
// ceiling (dim body colour + a Snell-window glow toward the sun).

import * as THREE from "three";
import "../render/chunks.js";   // registers wg_noise
import { ATMOS_GLSL, Atmosphere } from "../render/atmosphere.js";
import { floodFromSea, wetAt } from "../../kernel/water/flood.js";
import { gridTexMapping } from "../terrain/texmap.js";
import { lerpHex } from "../style/palettes.js";
import { WATER_PRESETS } from "./presets.js";

// Re-exported: this was the presets' home before the export contract layer
// needed them without three.js attached (see water/presets.js).
export { WATER_PRESETS };

// How fast a new flood front travels, in metres of reveal distance per
// second, and the bounds that stop a one-cell notch from filling in a blink
// or a channel across the map from dragging. The front itself is normalized
// 0..1, so this becomes 1/duration at bake time.
const FLOOD_SPEED = 70;
const FLOOD_MIN_S = 0.45;
const FLOOD_MAX_S = 2.2;

/* The colour the sea is where it meets the land, when the palette does not
   say. A palette states `water.shallow` and `water.deep`, and shallow is what
   the open shelf looks like — not what the last metre against a beach looks
   like, which carries the beach: the bottom is close enough to read through
   and the water is a glaze over it rather than a colour of its own.

   Derived rather than required so every existing palette, and any a buyer
   writes, gets a shoreline without editing anything: the shallow colour
   carried toward the biome's OWN sand, which is the material the low splat
   slot is floored with. `water.shore` overrides it for a palette that means
   something specific — a black-sand volcanic beach is a real thing and no
   derivation will guess it. */
const SHORE_TOWARD_SAND = 0.42;
const shoreColorFor = (palette) =>
  palette.water.shore ?? lerpHex(palette.water.shallow, palette.sand ?? 0xcabf9c, SHORE_TOWARD_SAND);

const VERT = /* glsl */`
  uniform float uTime; uniform float uAmp; uniform float uFreq;
  varying vec3 vWorld;
  void main() {
    vec3 p = position;
    vec4 w = modelMatrix * vec4(p, 1.0);
    float ph = w.x * 0.012 * uFreq + w.z * 0.017 * uFreq;
    w.y += (sin(ph + uTime * 0.9) + sin(ph * 2.31 - uTime * 1.3) * 0.4) * uAmp;
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
` + ATMOS_GLSL + /* glsl */`
#include <wg_output>
  uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uShore; uniform vec3 uSunDir;
  uniform vec3 uSkyColor; uniform vec3 uZenith;
  uniform float uTime; uniform float uClarity; uniform float uFreq; uniform float uCloudCover;
  uniform float uMirror; uniform float uGlint;
  uniform float uAbsorb; uniform float uShoreBlend;
  uniform sampler2D uNormalMap; uniform float uHasNormal;
  uniform sampler2D uTerrainTex; uniform float uHasTerrain; uniform float uWorldSize;
  uniform float uFieldK;  // (res-1)/res — fence-post grid → texel centres (terrain/texmap.js)
  uniform float uFloodFront;  // 0..1 sweep of the reveal order; 1 = settled
  uniform sampler2D uReflMap; uniform float uHasRefl; uniform mat4 uReflMatrix;
  varying vec3 vWorld;

  // Width of the soft band that trails AHEAD of the flood front, in reveal
  // order. Wide enough to hide the 16 m grid the mask is baked at.
  const float FLOOD_FEATHER = 0.12;

  #include <wg_noise>
  float fbm(vec2 p){
    return wgNoise(p) * 0.6 + wgNoise(p * 2.13 + 7.7) * 0.28 + wgNoise(p * 4.41 - 3.1) * 0.12;
  }

  // Three scrolling taps of the tiling normal map (the three.js ocean
  // recipe), or procedural noise when the texture hasn't streamed yet.
  vec3 waveNormal(vec2 xz, float wpx) {
    if (uHasNormal > 0.5) {
      vec2 uv0 = xz * 0.0105 + vec2(uTime * 0.0210, uTime * 0.0161);
      vec2 uv1 = xz * 0.0301 - vec2(uTime * 0.0292, uTime * 0.0244);
      vec2 uv2 = xz * 0.0862 + vec2(uTime * 0.0442, -uTime * 0.0341);
      vec3 n = (texture2D(uNormalMap, uv0).rgb * 2.0 - 1.0) * 0.55
             + (texture2D(uNormalMap, uv1).rgb * 2.0 - 1.0) * 0.30
             + (texture2D(uNormalMap, uv2).rgb * 2.0 - 1.0) * 0.15;
      /* Those three tile at roughly 95, 33 and 12 metres — a swell, read from
         a framing orbit. Stand a camera on the surface and the nearest thing
         it can show you is a twelve-metre undulation, which is why close
         water came out as a slow glossy sheet rather than as a sea: there is
         nothing in it at the scale a person standing in it would see.

         So a fourth tap at about three and a half metres, faded in on the
         PIXEL FOOTPRINT rather than on distance — it exists only where there
         are pixels to carry it, and is gone before it could become the
         sub-pixel noise the rest of this shader works to avoid. */
      float close = 1.0 - smoothstep(0.05, 0.28, wpx);
      if (close > 0.002) {
        vec2 uv3 = xz * 0.285 + vec2(-uTime * 0.0614, uTime * 0.0487);
        n += (texture2D(uNormalMap, uv3).rgb * 2.0 - 1.0) * 0.24 * close;
      }
      return normalize(vec3(n.x, 2.4, n.y)); // map is tangent-space; y-up remap
    }
    vec2 uv = xz * 0.05 * uFreq;
    float n1 = wgNoise(uv * 1.6 + vec2(uTime * 0.30, uTime * 0.22));
    float n2 = wgNoise(uv * 4.3 + vec2(-uTime * 0.43, uTime * 0.31));
    float n3 = wgNoise(uv * 9.1 + vec2(uTime * 0.60, -uTime * 0.52));
    return normalize(vec3(
      (n1 - 0.5) * 0.42 + (n2 - 0.5) * 0.26 + (n3 - 0.5) * 0.12, 1.0,
      (n2 - 0.5) * 0.42 + (n3 - 0.5) * 0.26 + (n1 - 0.5) * 0.12));
  }

  // Analytic reflection of the SAME sky the dome renders.
  // RULE (the fix for the recurring "white static" bug): every noise term
  // on water must be gated by distance or ray angle. The cloud projection
  // divides by R.y, so grazing rays sample it at near-infinite frequency —
  // exactly the per-pixel white speckle. Steep rays only.
  vec3 skyReflection(vec3 R) {
    vec3 sky = mix(uSkyColor, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.55));
    float sd = max(dot(R, uSunDir), 0.0);
    sky += vec3(1.0, 0.92, 0.78) * (pow(sd, 320.0) * 3.0 + pow(sd, 32.0) * 0.35) * max(uSunDir.y, 0.05);
    float cloudGate = smoothstep(0.22, 0.45, R.y);
    if (cloudGate > 0.0 && uCloudCover > 0.01) {
      vec2 cp = R.xz / (R.y + 0.22) * 1.7 + vec2(uTime * 0.008, uTime * 0.003);
      float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.32, fbm(cp));
      sky = mix(sky, vec3(0.98, 0.97, 0.95), cov * 0.5 * cloudGate);
    }
    return sky;
  }

  /* ── one pixel, in metres of world ──────────────────────────────────
     Every procedural term on this surface has a feature size. Once a pixel
     covers more than about half of one, the term has stopped being detail
     and become flicker: which side of a threshold a pixel lands on then
     changes with the wave clock and with any camera nudge, and the eye reads
     that as sparkle crawling over the sea.

     The file already carried the rule — "every noise term on water must be
     gated by distance or ray angle" — but distance is a proxy for the thing
     that actually matters, and a bad one: it has to be re-tuned for every
     field of view, resolution and zoom, and it was tuned for a framing orbit.
     Pulled back to see the whole plate it let a 4.5 m foam noise run at four
     metres per pixel, which is how a thin shoreline ribbon became a white
     wash over every shallow bay, flickering as it went.

     fwidth is the real measure: how much world one pixel spans, here, now.
     Each term fades on its OWN feature size against it, so the gate is
     correct at any zoom without a constant to re-tune. */
  float nyquist(float featureMetres, float worldPerPixel) {
    return 1.0 - smoothstep(featureMetres * 0.30, featureMetres * 0.85, worldPerPixel);
  }

  void main() {
    float dist = length(cameraPosition - vWorld);
    float wpx = max(fwidth(vWorld.x), fwidth(vWorld.z));
    float detail = exp(-dist * 0.0016);
    vec3 V = normalize(cameraPosition - vWorld);

    // Depth AND reachability come from one RG8 sample of the world's own
    // heightfield, already measured down from wherever this plane sits, so a
    // raised flood level needs no change here. Outside the world bounds there
    // is no grid, so it reads as open deep water.
    //   R  depth: byte/255 * 50m
    //   G  0 = the sea cannot reach here (water/flood.js), so this is ground
    //      however far below sea level it lies. 1..255 = the reveal order
    //      uFloodFront sweeps to animate a new flood.
    float depth = 40.0;
    float edge = 1.0;   // 0 just ahead of the front, 1 in settled water
    if (uHasTerrain > 0.5) {
      vec2 tuv = vWorld.xz / uWorldSize * uFieldK + 0.5;
      if (all(greaterThanEqual(tuv, vec2(0.0))) && all(lessThanEqual(tuv, vec2(1.0)))) {
        vec2 fld = texture2D(uTerrainTex, tuv).rg;
        depth = fld.r * 50.0;
        // discard, not a fade: a landlocked hollow must stay out of the depth
        // buffer too, or its dry ground would read through a film of water.
        if (fld.g < 0.5 / 255.0) discard;
        float order = (fld.g * 255.0 - 1.0) / 254.0;
        // Asymmetric on purpose. A cell AT the front is already fully wet and
        // the feather trails ahead of it, so water that was already there
        // cannot flicker on the frame a new front starts at 0.
        edge = 1.0 - smoothstep(uFloodFront, uFloodFront + FLOOD_FEATHER, order);
        if (edge < 0.004) discard;   // the front has not arrived yet
      }
    }

    /* Waves are ~3 m features at the scale that reads. Below Nyquist the
       normal map stops describing a surface and starts sampling noise, so it
       is folded back to flat — and the specular exponent falls with it,
       because a 240-power highlight over a normal that is no longer resolved
       is precisely the glint that crawls. */
    float waveLod = nyquist(3.0, wpx);
    /* Derivatives are only defined in UNIFORM control flow — a quad whose
       four pixels took different branches has no meaningful gradient — so the
       shore gradient is taken here, at the top level, and not down inside the
       foam test where it is used. */
    float depthPerMetre = length(vec2(dFdx(depth), dFdy(depth))) / max(wpx, 1e-4);
    /* ── how far the shore is, in metres of GROUND ──
       Hoisted to the top because three separate things want it and only the
       foam used to compute it. Over a steep shore it is nearly the depth;
       over a shelving bay a metre of depth can be four hundred metres of
       shallows, and everything keyed to depth alone paints the whole bay.
       Clamped because a perfectly flat bottom divides by ~0 and open water
       past the plate has no gradient at all — either way "very far" is the
       right answer and 4 km is past the far corner of any plate here. */
    float toShore = min(depth / max(depthPerMetre, 1e-3), 4000.0);
    float shoreT = smoothstep(0.0, uShoreBlend, toShore);

    vec3 N = normalize(mix(vec3(0.0, 1.0, 0.0), waveNormal(vWorld.xz, wpx), detail * waveLod));

    /* ── underside: the underwater ceiling ── */
    if (!gl_FrontFacing) {
      vec3 col = mix(uDeep * 0.55, uShallow * 0.9,
                     pow(max(dot(V, uSunDir), 0.0), 6.0) * max(uSunDir.y, 0.0));
      // shimmering caustic-ish light through the surface, gated by distance
      // so it can never alias into static across the far plate
      col += uShallow * wgNoise(vWorld.xz * 0.24 + uTime * 0.35) * 0.18 * max(uSunDir.y, 0.0)
           * detail * nyquist(4.2, wpx);
      gl_FragColor = vec4(wfOutput(col), 0.82 * edge);
      return;
    }

    float fresnel = pow(1.0 - max(dot(V, N), 0.0), 3.0);
    fresnel = 0.04 + 0.96 * fresnel;

    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    // Reflection: the real mirrored scene when the tier affords the second
    // render, the analytic sky model otherwise — and the analytic model
    // still fills any distorted lookup the mirror pass clipped away.
    vec3 refl;
    if (uHasRefl > 0.5) {
      // Perturb the WORLD point along the wave normal, then project: the
      // mirrored mountains wobble with the same waves the glints ride.
      vec4 rp = uReflMatrix * vec4(vWorld + vec3(N.x, 0.0, N.z) * 2.4, 1.0);
      vec2 ruv = rp.xy / rp.w;
      if (rp.w > 0.0 && all(greaterThanEqual(ruv, vec2(0.0))) && all(lessThanEqual(ruv, vec2(1.0)))) {
        refl = texture2D(uReflMap, ruv).rgb;
      } else {
        refl = skyReflection(R);
      }
    } else {
      refl = skyReflection(R);
    }

    /* ── body colour: extinction, not a ramp ──
       Depth is real (it comes out of the world's own heightfield), so the
       colour it drives may as well be. Transmission falls exponentially with
       depth and it falls at a DIFFERENT RATE PER CHANNEL — 1 : 0.62 : 0.45,
       warm end first — so the body approaches the deep colour asymptotically
       instead of clamping to it at 26 m, and it approaches it through the
       same sequence real water does: the reds go, then the greens, and the
       last thing standing is the blue. A single smoothstep between two
       colours can produce a tint of that; it cannot produce the divergence,
       which is the whole reason deep water reads as deep rather than as dark.

       The near end is not one colour either. Right at the waterline the body
       is uShore — the shallow colour carried toward the land's own sand, so
       the sea meets the beach through the beach's colour rather than as a
       band of turquoise butted against it — giving way to uShallow over
       uShoreBlend metres of ground.
       (No backticks anywhere in here: this is inside a template literal, and
       one of them took the whole page down once already.) */
    vec3 near = mix(uShore, uShallow, shoreT);
    vec3 trans = exp(-max(depth, 0.0) * uAbsorb * vec3(1.0, 0.62, 0.45));
    vec3 body = mix(uDeep, near, trans);
    /* Reflection capped by the BODY'S OWN mirror term, so grazing angles keep
       water reading as water — visible body colour — rather than as a solid
       mirror. It was a flat 0.72 for every body of water in the engine, which
       is why an open sea and a sheltered moat reflected the world with
       exactly the same strength. A sea trades that reflection for uGlint:
       shimmer on the surface instead of the far shore upside down in it.
       (No backticks in here: this is inside a template literal.) */
    vec3 col = mix(body, refl, min(fresnel, uMirror));

    // Sun glints on the near field
    vec3 H = normalize(V + uSunDir);
    /* A specular lobe needs a surface to sit on. Once the waves are no longer
       resolved, N folds to straight up EVERYWHERE — and then the half-vector
       lines up with it across the whole sea at once, so even a 240-power lobe
       reads 1.0 from horizon to horizon and the water goes white. That is the
       "light from above" on a pulled-back view, and it is why the sea washed
       out around the plate: it is one enormous highlight, not foam.

       Widening the lobe to compensate makes it worse, not better — a softer
       exponent covers more of the plane, not less. The term has to go out
       with the waves that justify it: no resolved waves, no glint, and the
       sea falls back to body colour under a fresnel sheen, which is what
       water seen from four kilometres up actually looks like. */
    col += vec3(1.0, 0.95, 0.8) * pow(max(dot(N, H), 0.0), 240.0) * 2.2 * uGlint
         * max(uSunDir.y, 0.0) * waveLod;
    float sunFace = max(dot(V, uSunDir), 0.0) * 0.6 + 0.4;
    // A hard step() on sub-metre noise: the single worst offender on this
    // surface, because a threshold cannot fade gracefully — it can only pop.
    col += vec3(0.25) * uGlint * step(0.997, wgNoise(vWorld.xz * 1.2 + uTime * 0.4)) * max(uSunDir.y, 0.0)
         * detail * detail * sunFace * nyquist(0.9, wpx);

    // Shoreline foam: a THIN animated band (≤1.4m of depth) that fades with
    // distance on a longer scale than wave detail — visible from a framing
    // orbit, but it can never carpet a whole shallow bay in white speckle.
    float foam = 0.0;
    float foamFade = exp(-dist * 0.0005) * nyquist(4.5, wpx);
    if (uHasTerrain > 0.5 && depth < 1.4 && foamFade > 0.02) {
      /* Foam sits a fixed distance from the WATERLINE, not under a fixed
         depth — see toShore above, which is the same measure the body colour
         and the shore feather are keyed to, taken once. */
      float band = smoothstep(1.4, 0.0, depth) * (1.0 - smoothstep(9.0, 26.0, toShore));
      float fn = fbm(vWorld.xz * 0.22 + vec2(uTime * 0.22, -uTime * 0.17));
      foam = smoothstep(0.55, 0.8, fn * band * 1.4 + band * 0.18) * foamFade;
      col = mix(col, vec3(0.93, 0.96, 0.95), foam * 0.85);
    }

    // The advancing front carries its own white line, peaking mid-feather.
    // Purely analytic — no noise term — so unlike the shoreline band above it
    // needs no distance gate to stay off the far plate.
    float front = clamp((1.0 - edge) * edge * 4.0, 0.0, 1.0);
    col = mix(col, vec3(0.93, 0.96, 0.95), front * 0.6);

    // Clarity: shallows are genuinely transparent (the terrain beneath is
    // real geometry — low alpha simply lets you see it), deep water opaque.
    float alpha = mix(0.30, 0.94, smoothstep(0.4, 16.0, depth));
    /* And the last metre or two of GROUND before the waterline is feathered,
       not cut. The alpha ramp above is keyed to depth alone, which on a beach
       reaches its floor within centimetres of the edge — so the sea ended at
       a hard line drawn across the sand.

       The feather needs BOTH conditions, and the second is what keeps it
       honest: close to the waterline AND genuinely shallow. Distance alone
       would feather the deep water hugging a cliff, which is a metre from the
       shore and ten metres deep — the one place the edge really is sharp. */
    float lip = (1.0 - smoothstep(0.0, 1.8, toShore)) * (1.0 - smoothstep(0.6, 2.5, depth));
    alpha *= 1.0 - 0.5 * lip;
    alpha = max(alpha, fresnel * 0.9);              // grazing sheen stays visible
    alpha = max(alpha, foam * 0.95);                // foam is opaque
    alpha = max(alpha, front * 0.85);               // and so is the flood front
    alpha *= mix(1.0, 0.86, uClarity * (1.0 - fresnel));

    // Same air as the land: distant water recedes into haze instead of
    // staying vividly blue out to the world edge. Distance-driven, so it
    // needs no noise gate of its own — and it hides the far seam entirely,
    // which is why alpha closes up with it.
    vec3 hazed = atmApply(col, vWorld, cameraPosition);
    float hazeAmt = clamp(length(hazed - col) * 2.5, 0.0, 1.0);
    // Same ACES + sRGB transform the lit materials get from three, so the
    // sea sits on the land's curve instead of its own. The flood edge is
    // applied AFTER the haze: whether water is here at all is a fact about
    // the world, and distance must not close the leading edge back up.
    gl_FragColor = vec4(wfOutput(hazed), mix(alpha, 1.0, hazeAmt * 0.9) * edge);
  }
`;

export class Water {
  constructor({ params, palette, atmos = null }) {
    this.params = params;
    const preset = WATER_PRESETS[params.water.preset] || WATER_PRESETS.ocean;
    // Shared aerial-perspective uniforms (live objects — the engine updates
    // them in place as the sun moves). Standalone use gets its own instance
    // so the shader always has them.
    this.atmos = atmos || new Atmosphere(params);
    this.uniforms = {
      ...this.atmos.uniforms,
      uTime: { value: 0 },
      uAmp: { value: preset.waveAmp * params.water.waveHeight },
      uFreq: { value: preset.waveFreq },
      uClarity: { value: preset.clarity },
      uMirror: { value: preset.mirror ?? 0.72 },
      uGlint: { value: preset.glint ?? 1.0 },
      uAbsorb: { value: preset.absorb ?? 0.11 },
      uShoreBlend: { value: preset.shoreBlend ?? 18 },
      uShallow: { value: new THREE.Color(palette.water.shallow) },
      uDeep: { value: new THREE.Color(palette.water.deep) },
      uShore: { value: new THREE.Color(shoreColorFor(palette)) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSkyColor: { value: new THREE.Color(palette.sky.horizon) },
      uZenith: { value: new THREE.Color(palette.sky.zenith) },
      uCloudCover: { value: params.sky.cloudCover },
      uNormalMap: { value: null },
      uHasNormal: { value: 0 },
      uReflMap: { value: null },
      uHasRefl: { value: 0 },
      uReflMatrix: { value: new THREE.Matrix4() },
      uTerrainTex: { value: null },
      uHasTerrain: { value: 0 },
      uWorldSize: { value: params.terrain.size },
      uFieldK: { value: 1 },
      uFloodFront: { value: 1 },
    };
    // The water is a plate matching the world bounds exactly — the world
    // presents as a floating diorama, and its underside is closed by the
    // engine's pedestal. (An ocean extending past the plate was tried and
    // reverted: a 24km transparent plane with this fragment shader is pure
    // fill cost, and it let the player walk out over open water.)
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(params.terrain.size, params.terrain.size, 32, 32).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
        transparent: true, side: THREE.DoubleSide,
        // The Nyquist gates in the fragment shader are built on fwidth/dFdx.
        // Core in WebGL2; harmless to ask for where it is an extension.
        extensions: { derivatives: true },
      })
    );
    this.mesh.name = "water";
    // The natural coastline is y=0 by heightfield construction; params.water
    // .level raises the whole plane above it to flood the land as it stands.
    this._level = params.water.level || 0;
    this.mesh.position.y = this._level;
    this.mesh.visible = !!params.water.enabled;
    this._depthTex = null;
    this._field = null;     // latest baked heightfield, so the level can move
                            // without asking the engine to bake again
    // Latest flood result: read by the minimap, and fed back into the next
    // bake as the "before" that decides what is new enough to animate.
    this._flood = null;
    this._floodFront = 1;   // 0..1 sweep of the reveal order; 1 = settled
    this._floodSpeed = 0;   // front units per second while a flood is running
  }

  // Latest sea-connected mask (water/flood.js), or null before the first
  // terrain field lands. The minimap reads this so its water agrees with the
  // viewport's rather than re-deciding from raw height.
  get flood() { return this._flood; }

  setPalette(palette) {
    this.uniforms.uShallow.value.setHex(palette.water.shallow);
    this.uniforms.uDeep.value.setHex(palette.water.deep);
    // Derived from the same palette, in the same call, so the shoreline can
    // never be left describing the biome before this one.
    this.uniforms.uShore.value.setHex(shoreColorFor(palette));
    this.uniforms.uSkyColor.value.setHex(palette.sky.horizon);
    this.uniforms.uZenith.value.setHex(palette.sky.zenith);
  }

  setPreset(name) {
    const p = WATER_PRESETS[name] || WATER_PRESETS.ocean;
    this.params.water.preset = name;
    this.uniforms.uAmp.value = p.waveAmp * this.params.water.waveHeight;
    this.uniforms.uFreq.value = p.waveFreq;
    this.uniforms.uClarity.value = p.clarity;
    this.uniforms.uMirror.value = p.mirror ?? 0.72;
    this.uniforms.uGlint.value = p.glint ?? 1.0;
    this.uniforms.uAbsorb.value = p.absorb ?? 0.11;
    this.uniforms.uShoreBlend.value = p.shoreBlend ?? 18;
  }

  // Tiling wave normal map (shared texture owned by the engine).
  setNormalMap(tex) {
    this.uniforms.uNormalMap.value = tex;
    this.uniforms.uHasNormal.value = tex ? 1 : 0;
  }

  // Planar reflection feed (engine-owned WaterReflection). Pass null when
  // the mirror pass didn't run this frame — the shader falls back to the
  // analytic sky and nothing samples a stale image.
  setReflection(texture, matrix) {
    this.uniforms.uReflMap.value = texture || null;
    this.uniforms.uHasRefl.value = texture ? 1 : 0;
    if (matrix) this.uniforms.uReflMatrix.value.copy(matrix);
  }

  // Feed the live heightfield so the shader knows real water depth AND which
  // of it the sea can actually reach. Encoded as plain RG8 bytes — R is
  // depth/50m, G is 0 for unreachable ground and otherwise the reveal order
  // — which are filterable everywhere, and with unpackAlignment=1 immune to
  // row-alignment garbage at odd resolutions like 513 (2ⁿ+1 grids are the
  // norm here).
  //
  // Linear filtering across the G channel is safe despite 0 being a sentinel:
  // the flood is 4-connected, so a wet cell is never edge-adjacent to a dry
  // cell that lies below sea level. Every dry neighbour it can blend with is
  // ground standing above the plane, which occludes the blend band anyway.
  //
  // `animate` belongs to the one caller that means it — the end of a sculpt
  // stroke. A world build, an undo or an erosion pass all want the settled
  // state on the next frame.
  setTerrainField(field, { animate = false } = {}) {
    this._field = field;
    this._encode(field, animate);
  }

  /* ── flood level ──
     Raise or lower the waterline over the terrain AS IT STANDS. Nothing is
     re-baked: the heightfield is read, never written, so the land keeps its
     exact shape and only the water moves. The sea-connected mask is redone at
     the new threshold, so raising the level floods inland along real valleys
     and still refuses to fill a hollow with no path to the sea.

     Not to be confused with params.terrain.seaLevel, which is a GENERATION
     input — it shifts the height field before the sea-floor curve is applied,
     so changing it rebuilds the world into different terrain. That one is the
     wrong knob for "what floods"; this is the right one.

     The caller owns params.water.level. Writing it here would be wrong:
     applyParams() returns a FRESH params object, so this.params is the one
     handed to the constructor and goes stale after the first panel change. */
  setLevel(y) {
    if (y === this._level) return;
    this._level = y;
    this.mesh.position.y = y;
    if (this._field) this._encode(this._field, true);
  }

  get level() { return this._level; }

  _encode(field, animate) {
    const { res, data } = field;
    const flood = floodFromSea(field, this._flood, this._level);
    const bytes = new Uint8Array(res * res * 2);
    const span = flood.maxSteps;
    for (let i = 0; i < data.length; i++) {
      const d = (this._level - data[i]) / 50; // depth below the waterline, /50m
      bytes[i * 2] = d <= 0 ? 0 : d >= 1 ? 255 : Math.round(d * 255);
      // 0 is reserved for "no path to the sea", so the order starts at 1.
      bytes[i * 2 + 1] = flood.wet[i] ? 1 + (span > 0 ? Math.round((flood.steps[i] / span) * 254) : 0) : 0;
    }
    const tex = new THREE.DataTexture(bytes, res, res, THREE.RGFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    if (this._depthTex) this._depthTex.dispose();
    this._depthTex = tex;
    this.uniforms.uTerrainTex.value = tex;
    this.uniforms.uHasTerrain.value = 1;
    this.uniforms.uWorldSize.value = field.size;
    this.uniforms.uFieldK.value = gridTexMapping(res).k;
    this._flood = flood;

    // Only a flood that actually GAINED ground is worth animating: raising
    // land to drain a bay, or any bake that reveals nothing new, just snaps.
    // span > 1 rather than > 0 on purpose — water one cell deep sits against
    // the old shoreline with nothing to reveal, and the one remaining grid
    // change (the quick 257² placeholder giving way to the canonical 513²)
    // leaves exactly that much resample fringe.
    if (animate && flood.newCount > 0 && span > 1) {
      const metres = span * (field.size / (res - 1));
      const secs = Math.min(Math.max(metres / FLOOD_SPEED, FLOOD_MIN_S), FLOOD_MAX_S);
      this._floodFront = 0;
      this._floodSpeed = 1 / secs;
    } else {
      this._floodFront = 1;
      this._floodSpeed = 0;
    }
    this.uniforms.uFloodFront.value = this._floodFront;
  }

  setSunDir(dir) { this.uniforms.uSunDir.value.copy(dir); }
  tick(dt) { this.uniforms.uTime.value += dt * (WATER_PRESETS[this.params.water.preset]?.speed ?? 1); }

  // Advance a running flood front; true while it is still moving. Kept off
  // the ambient-animation tick on purpose — that one is disabled entirely on
  // the low quality tier, and a flood must still be watchable there.
  tickFlood(dt) {
    if (this._floodFront >= 1) return false;
    this._floodFront = Math.min(1, this._floodFront + this._floodSpeed * dt);
    this.uniforms.uFloodFront.value = this._floodFront;
    return true;
  }

  // Underwater pass: returns true if the camera is below the surface AND in
  // water the sea can actually reach — the murk must not close in inside a
  // dry landlocked hollow the shader renders as ground (no mask yet = wet).
  underwater(pos) {
    return this.mesh.visible && pos.y < this.mesh.position.y
      && wetAt(this._flood, pos.x, pos.z) !== false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this._depthTex) this._depthTex.dispose();
  }
}
