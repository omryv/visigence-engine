// Aerial perspective: the single scattering model every surface shares, so
// terrain, grass, props and water all recede into the same air. Distance
// extinction is height-aware (the haze pools in valleys and thins with
// altitude) and the inscattered colour warms toward the sun, which is what
// makes a far ridge read as far rather than merely grey.
//
// Injected before tone mapping — this is scene radiance, not a post effect —
// so the values live in linear space alongside the lighting.
//
// This module is also the engine's MATERIAL CONDITION hub: the same patch
// that adds haze to every lit material adds the surface responses that make
// the world feel physical — wetness below and beside the waterline (dark,
// glossy), rain film on upward faces, settling snow, sun caustics on
// submerged ground, and window/lamp emissives that come alive at night.
// One patch, shared uniforms, zero per-material bookkeeping.
//
// Mobile note: no loops, no derivatives. A handful of multiplies, two pows
// and (only where a surface is actually submerged) two texture-free noise
// taps per pixel.

import * as THREE from "three";
import "./chunks.js";   // registers wg_noise
import { worldTexScale } from "../terrain/texmap.js";

// Shared GLSL. `ATM_APPLY(color, worldPos)` is the whole contract — custom
// shaders (water) call it exactly as the patched standard materials do.
export const ATMOS_GLSL = /* glsl */`
  uniform vec3 uAtmSun;
  uniform vec3 uAtmHaze;
  uniform vec3 uAtmSunTint;
  uniform float uAtmDensity;
  uniform float uAtmHeightK;
  uniform float uAtmStrength;

  vec3 atmApply(vec3 color, vec3 worldPos, vec3 camPos) {
    if (uAtmStrength <= 0.001) return color;
    vec3 toFrag = worldPos - camPos;
    float dist = length(toFrag);
    vec3 V = toFrag / max(dist, 0.0001);

    // Forward scattering: air near the sun glows, away from it stays cool.
    float sunAmt = max(dot(V, uAtmSun), 0.0);
    float mie = pow(sunAmt, 7.0) * 0.55 + pow(sunAmt, 2.0) * 0.16;
    vec3 haze = mix(uAtmHaze, uAtmSunTint, clamp(mie, 0.0, 1.0));

    // Air thins with height: sample midway up the view ray so a mountain
    // top hazes less than the valley floor in front of it.
    float h = max((worldPos.y + camPos.y) * 0.5, 0.0);
    float density = uAtmDensity * exp(-h * uAtmHeightK);
    float f = 1.0 - exp(-dist * density);
    return mix(color, haze, clamp(f * uAtmStrength, 0.0, 1.0));
  }
`;

/* The ACES + sRGB output transform now lives in chunks.js as `wg_aces` /
   `wg_output`, because it is shared by three surfaces (sky, water, the post
   composite) and a shared shader function is exactly what that file is for.
   It used to be defined here, which meant post.js imported its final-frame
   tone map from the aerial-perspective module.

   These re-exports are the compatibility shim. Prefer `#include <wg_aces>` /
   `#include <wg_output>` in new shaders — the guarded chunk cannot be pasted
   in twice, and a string concatenation can. */
export { WG_ACES as ACES_GLSL, WG_OUTPUT as OUTPUT_GLSL } from "./chunks.js";

export class Atmosphere {
  constructor(params) {
    this._baseDensity = (params.fog.density * 6) / params.terrain.size;
    this.altitudeFactor = 1;
    this.uniforms = {
      uAtmSun: { value: new THREE.Vector3(0, 1, 0) },
      uAtmHaze: { value: new THREE.Color(0x9fb6cc) },
      uAtmSunTint: { value: new THREE.Color(0xffd7a8) },
      // Tuned against world size: a 4km world hazes out around its far edge.
      uAtmDensity: { value: 2.1 / params.terrain.size },
      uAtmHeightK: { value: 1 / Math.max(params.terrain.height * 1.15, 60) },
      uAtmStrength: { value: 1 },
      // Mirrors renderer.toneMappingExposure for the hand-written shaders.
      uExposure: { value: 1.05 },
      // 1 = the HDR post pipeline owns tone mapping (see OUTPUT_GLSL).
      uWfPost: { value: 0 },
      /* ── surface conditions (see apply()) ── */
      // The live waterline in world y. -1e8 = water disabled: every surface
      // test against it fails without a branch.
      uWfWaterY: { value: -1e8 },
      uWfRain: { value: 0 },   // 0..1 rain film on upward faces
      uWfSnow: { value: 0 },   // 0..1 settled snow cover
      uWfNight: { value: 0 },  // sky rig's night factor — drives emissives
      uWfTime: { value: 0 },   // caustic clock (ambient-animation ticked)
      uWfCaustic: { value: new THREE.Color(0x9fe8d8) },
      /* ── indirect light (terrain/skyvis.js) ──
         RGB = the bent normal (the direction the visible sky lies in),
         A = the fraction of the dome this patch of ground can see. Sampled
         by world XZ, so it reaches EVERY surface the atmosphere patch
         touches — ground, grass, trees, placed blocks — from one texture.
         uSkyVisOn stays 0 until the bake lands, and the world is lit exactly
         as it was before until then. */
      uSkyVis: { value: null },
      uSkyVisOn: { value: 0 },
      uSkyVisScale: { value: 1 / 4096 },   // world metres → texture UV
      uSkyBounce: { value: new THREE.Color(0x2a2a1e) },
      /* ── shelter (js/shelter.js) ──
         A window on the world that follows the viewer, carrying the underside
         of the roof over each column. It is what makes a building part of the
         weather instead of a thing standing in it: rain wets what the rain
         can reach, snow settles where the sky is, and a room is lit by as
         much sky as it can actually see. Off until a world is built. */
      uShelter: { value: null },
      uShelterOn: { value: 0 },
      uShelterOrigin: { value: new THREE.Vector2() },
      uShelterScale: { value: 1 / 160 },
      uShelterBase: { value: 0 },
      uShelterRange: { value: 64 },
      /* ── the room you are standing in (core/room-probe.js) ──
         Interiors used to be lit by the sky, dimmed: the shelter factor
         scaled the ambient down and nothing else changed, so a room with one
         small window was lit exactly like a room with four, from every
         direction equally, in the colour of the dome. And because
         scene.environment IS the dome, anything glossy indoors reflected open
         sky through the ceiling — dimming that only makes it a darker sky.

         These carry the irradiance of the ONE room the camera is in, eased
         between rooms by the engine. One room rather than a field of them is
         a deliberate limit and the same shape lamps.js already uses: the
         room you are standing in is the one whose light you can judge, and a
         probe per fragment wants a volume texture this does not have. */
      uRoomOn: { value: 0 },
      uRoomAmbient: { value: new THREE.Color(0, 0, 0) },
      uRoomDir: { value: new THREE.Vector3(0, 1, 0) },
      uRoomOpen: { value: 0 },
    };
  }

  /* Hand over a finished sky-visibility bake. `texture` is the packed RGBA
     from packSkyVisibility, `size` the world edge it covers. The scale is the
     fence-post-corrected one (terrain/texmap.js): the bake samples the plate
     corner to corner while texels are centred, and a bare 1/size read the
     whole indirect-light field half a cell off the ground it describes. */
  setSkyVisibility(texture, size) {
    this.uniforms.uSkyVis.value = texture;
    this.uniforms.uSkyVisOn.value = texture ? 1 : 0;
    if (texture && size) {
      this.uniforms.uSkyVisScale.value = worldTexScale(texture.image?.width || 1, size);
    }
  }

  /* Hand over the live shelter window. `field` is a js/shelter.js
     ShelterField and `texture` the DataTexture over its bytes; the caller
     flags the texture dirty after each redraw. */
  setShelter(texture, field) {
    this.uniforms.uShelter.value = texture;
    this.uniforms.uShelterOn.value = texture && field ? 1 : 0;
    if (!field) return;
    const u = field.uniforms();
    this.uniforms.uShelterOrigin.value.set(u.origin[0], u.origin[1]);
    this.uniforms.uShelterScale.value = u.scale;
    this.uniforms.uShelterBase.value = u.baseY;
    this.uniforms.uShelterRange.value = u.range;
  }

  // The colour the ground throws back up. Derived from the biome so a desert
  // bounces warm sand and a tundra bounces cold stone.
  setBounceColor(hex) { this.uniforms.uSkyBounce.value.setHex(hex); }

  /* The room the viewer is in, from core/room-probe.js. `null` steps back
     outdoors, which is not the same as a dark room — outdoors the sky path
     below takes over completely. */
  setRoomProbe(probe) {
    const u = this.uniforms;
    if (!probe) { u.uRoomOn.value = 0; return; }
    u.uRoomOn.value = 1;
    u.uRoomAmbient.value.setRGB(probe.ambient[0], probe.ambient[1], probe.ambient[2]);
    u.uRoomDir.value.set(probe.dir[0], probe.dir[1], probe.dir[2]);
    u.uRoomOpen.value = probe.openness;
  }

  // params.fog.density is the author's dial: 0 = crystal clear, 0.35 the
  // default, 1 = soup. Scaled by world size so the same number means the
  // same look whether the map is 2km or 8km across.
  setWorld(params) {
    this._baseDensity = (params.fog.density * 6) / params.terrain.size;
    this.uniforms.uAtmDensity.value = this._baseDensity * this.altitudeFactor;
    this.uniforms.uAtmHeightK.value = 1 / Math.max(params.terrain.height * 1.15, 60);
  }

  // Standing on the ground you look through kilometres of dense low air, so
  // haze sells distance. From an orbit view the same haze just bleaches the
  // whole world (it is ALL distant), so thin it out as the camera climbs.
  // Returns true when the value actually moved, so the engine can skip work.
  setAltitude(alt) {
    const t = Math.min(Math.max((alt - 300) / 2200, 0), 1);
    const f = 1 - t * t * (3 - 2 * t) * 0.72;   // 1.0 on foot → 0.28 from orbit
    if (Math.abs(f - this.altitudeFactor) < 0.005) return false;
    this.altitudeFactor = f;
    this.uniforms.uAtmDensity.value = (this._baseDensity || this.uniforms.uAtmDensity.value) * f;
    return true;
  }

  // Fed from the Sky rig: haze takes the fog colour (already time-of-day
  // graded), the tint takes the sun's own colour so dusk turns the air amber.
  // Both arrive in three's working (linear) space — which is the space this
  // injection runs in, ahead of tone mapping — so they are copied as-is.
  setSun(dir, color) {
    this.uniforms.uAtmSun.value.copy(dir);
    this.uniforms.uAtmSunTint.value.copy(color).multiplyScalar(1.2);
  }
  setHaze(color) {
    this.uniforms.uAtmHaze.value.copy(color);
  }
  // Under the surface the water's own murk takes over completely.
  setUnderwater(on) { this.uniforms.uAtmStrength.value = on ? 0 : 1; }

  /* ── surface conditions ── */
  // The waterline every material wets against. Pass enabled=false and every
  // submersion test fails, branch-free.
  setWaterline(y, enabled = true) {
    this.uniforms.uWfWaterY.value = enabled ? y : -1e8;
  }
  // Caustic light colour follows the biome's shallow-water tint.
  setCausticColor(hex) { this.uniforms.uWfCaustic.value.setHex(hex); }
  setNight(n) { this.uniforms.uWfNight.value = n; }
  // Weather ramps — the engine eases these toward the active weather's
  // targets so rain soaks in and snow settles rather than snapping.
  setRainWet(f) { this.uniforms.uWfRain.value = f; }
  setSnowCover(f) { this.uniforms.uWfSnow.value = f; }
  // Caustics keep their own clock so they can pause with ambient animation.
  tick(dt) { this.uniforms.uWfTime.value += dt; }

  // Patch a lit material (standard/lambert/phong). Chains onto any
  // onBeforeCompile the material already has instead of replacing it.
  // Deliberately keeps NO registry of what it has patched: every prop part
  // goes through here, so a Set would be a strong reference to every material
  // the session ever built and nothing could ever be collected. The uniform
  // objects are shared by reference, so updating them reaches every material
  // without holding one.
  apply(material) {
    if (!material || material.userData.atmos) return material;
    material.userData.atmos = true;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (sh, renderer) => {
      if (prev) prev.call(material, sh, renderer);
      Object.assign(sh.uniforms, this.uniforms);
      // Unlit materials (KHR_materials_unlit GLBs land as MeshBasic) have no
      // objectNormal in their vertex program — treat them as facing up.
      const nrmExpr = material.isMeshBasicMaterial ? "vec3(0.0, 1.0, 0.0)" : "objectNormal";
      // World position AND world normal ride to the fragment stage. The
      // instance transform matters: without it every blade of instanced
      // grass hazed and wetted as if it stood at the mesh origin.
      sh.vertexShader = "varying vec3 vAtmWorld;\nvarying vec3 vAtmNrm;\n" + sh.vertexShader.replace(
        "#include <project_vertex>",
        `vec4 wfP = vec4(transformed, 1.0);
         vec3 wfN = ${nrmExpr};
         #ifdef USE_INSTANCING
           wfP = instanceMatrix * wfP;
           wfN = mat3(instanceMatrix) * wfN;
         #endif
         vAtmWorld = (modelMatrix * wfP).xyz;
         vAtmNrm = normalize(mat3(modelMatrix) * wfN);
         #include <project_vertex>`
      );
      sh.fragmentShader = ("varying vec3 vAtmWorld;\nvarying vec3 vAtmNrm;\n" + ATMOS_GLSL + /* glsl */`
        uniform float uWfWaterY;
        uniform float uWfRain;
        uniform float uWfSnow;
        uniform float uWfNight;
        uniform float uWfTime;
        uniform vec3 uWfCaustic;
        uniform sampler2D uSkyVis;
        uniform float uSkyVisOn;
        uniform float uSkyVisScale;
        uniform vec3 uSkyBounce;
        uniform sampler2D uShelter;
        uniform float uShelterOn;
        uniform vec2 uShelterOrigin;
        uniform float uShelterScale;
        uniform float uShelterBase;
        uniform float uShelterRange;
        uniform float uRoomOn;
        uniform vec3 uRoomAmbient;
        uniform vec3 uRoomDir;
        uniform float uRoomOpen;
        /* 1 where a roof stands between this point and the sky. The texel
           carries the roof underside and the floor under it, so a fragment
           knows which side of the ceiling it is on — the roof of a house is
           shelter for the parlour and open sky for the chimney. */
        float wfShelter(vec3 p) {
          if (uShelterOn < 0.5) return 0.0;
          vec2 uv = (p.xz - uShelterOrigin) * uShelterScale;
          if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
          vec4 t = texture2D(uShelter, uv);
          if (t.a < 0.5) return 0.0;
          float roofY  = uShelterBase + (t.r + t.g / 255.0) * uShelterRange;
          float floorY = uShelterBase + t.b * uShelterRange;
          return (p.y <= roofY && p.y >= floorY - 2.5) ? 1.0 : 0.0;
        }
        #include <wg_noise>
      ` + "\n" + sh.fragmentShader)
        .replace(
          "#include <color_fragment>",
          /* glsl */`#include <color_fragment>
          // ── surface conditions ──
          float wfUp = clamp(vAtmNrm.y, 0.0, 1.0);
          // Wet: fully below the waterline, in the splash band just above
          // it, or filmed by rain (rain favours upward faces but a storm
          // leaves nothing dry).
          float wfBelow = 1.0 - smoothstep(uWfWaterY - 0.12, uWfWaterY + 0.22, vAtmWorld.y);
          float wfBand = 1.0 - smoothstep(uWfWaterY + 0.1, uWfWaterY + 1.2, vAtmWorld.y);
          /* Rain wets what the rain can reach. This used to be one global
             number multiplied into every material in the scene, so a storm
             soaked the inside of every house as thoroughly as the street —
             the single clearest sign that a building was decoration rather
             than part of the world. Standing water still darkens what is
             under it: a flooded cellar is wet whatever is over it. */
          float wfIn = wfShelter(vAtmWorld);
          float wfOpen = 1.0 - wfIn;
          float wfWet = max(max(wfBelow, wfBand * 0.75),
                            uWfRain * wfOpen * (0.42 + 0.58 * smoothstep(0.25, 0.85, wfUp)));
          diffuseColor.rgb *= 1.0 - 0.42 * wfWet;
          // Snow settles on faces that look up, broken up by world-space
          // noise so it reads as cover rather than white paint. Never below
          // the waterline.
          float wfSnowK = uWfSnow * wfOpen * smoothstep(0.52, 0.86, wfUp)
                        * (0.68 + 0.32 * wgNoise(vAtmWorld.xz * 0.85)) * (1.0 - wfBelow);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.87, 0.91, 0.97), wfSnowK * 0.85);
          // Caustics: refracted sun ripples on anything submerged and
          // shallow. Two ridged noise taps, multiplied — the classic cheap
          // caustic — faded out by depth and sun elevation.
          float wfDepth = uWfWaterY - vAtmWorld.y;
          if (wfBelow > 0.0 && wfDepth < 14.0 && uAtmSun.y > 0.03) {
            vec2 wfCuv = vAtmWorld.xz * 0.42;
            float wfCa = 1.0 - abs(2.0 * wgNoise(wfCuv + vec2(uWfTime * 0.14, uWfTime * 0.09)) - 1.0);
            float wfCb = 1.0 - abs(2.0 * wgNoise(wfCuv * 1.37 - vec2(uWfTime * 0.11, uWfTime * 0.16)) - 1.0);
            float wfCz = wfCa * wfCb;
            diffuseColor.rgb += uWfCaustic * (wfCz * wfCz * wfCz)
                              * (1.0 - wfDepth / 14.0) * wfBelow * clamp(uAtmSun.y * 1.6, 0.0, 1.0) * 1.5;
          }`
        )
        .replace(
          "#include <roughnessmap_fragment>",
          /* glsl */`#include <roughnessmap_fragment>
          // Water glosses a surface; snow flattens it back out.
          roughnessFactor = mix(roughnessFactor, 0.14, clamp(wfWet, 0.0, 1.0) * 0.85);
          roughnessFactor = mix(roughnessFactor, 0.92, wfSnowK);`
        )
        .replace(
          /* ── indirect light ──
             aomap_fragment is where three has finished gathering ambient and
             has not yet added it to the direct term, which makes it the one
             place indirect light can be scaled without touching the sun.

             The bake (terrain/skyvis.js) says how much of the dome each patch
             of ground can see and which way the open sky lies. A surface is
             then lit by the sky in proportion to how much its own normal
             agrees with that direction — so a gorge wall brightens toward the
             opening instead of dimming uniformly, which is the difference
             between occlusion and indirect light. */
          "#include <aomap_fragment>",
          /* glsl */`#include <aomap_fragment>
          if (uSkyVisOn > 0.5) {
            vec4 wfSv = texture2D(uSkyVis, vAtmWorld.xz * uSkyVisScale + 0.5);
            vec3 wfBent = normalize(wfSv.xyz * 2.0 - 1.0);
            float wfVis = wfSv.a;
            float wfFacing = clamp(dot(vAtmNrm, wfBent) * 0.5 + 0.5, 0.0, 1.0);
            // Even a surface facing away from the opening catches some sky,
            // so the floor is a fraction of visibility rather than zero.
            /* …and a roof is the most complete occluder there is. The bake
               rays against the TERRAIN only, so before this an interior was
               lit by as much open sky as the field outside it, which is
               exactly why rooms read flat and why the lamps looked painted
               on. A little is left rather than none: light comes in at the
               windows, and a pitch-black room is a different lie. */
            float wfSky = mix(wfVis * 0.55, wfVis, wfFacing) * (1.0 - wfIn * 0.82);
            reflectedLight.indirectDiffuse *= wfSky;
            reflectedLight.indirectSpecular *= wfSky;
            /* The bounce. What the sky loses to the terrain does not vanish —
               it arrives as light thrown back off the ground, warm or cold
               with the biome, and strongest on the downward-facing surfaces
               that see the least sky. Without it an occluded valley reads as
               a hole cut in the lighting rather than a shaded place. */
            reflectedLight.indirectDiffuse +=
              uSkyBounce * diffuseColor.rgb * (1.0 - wfVis) * (1.0 - clamp(vAtmNrm.y, 0.0, 1.0) * 0.65);
          }

          /* ── the room, where there is one ──
             Everything above is the SKY's account of this fragment, and
             indoors it is the wrong account however carefully it is dimmed:
             it has no idea where the window is. This adds the room's own
             light back, and it does it in proportion to how far inside the
             fragment actually is — wfIn is 1 under a roof and 0 in the open,
             so a doorway crossfades rather than switching.

             The diffuse term is directional. A wall facing the openings is
             lit and the one behind you is not, which is the whole difference
             between a room and a box: uRoomDir points at the openings, so
             the dot is what a surface sees of them. (No backticks in here —
             this comment lives inside a template literal and quoting a
             uniform the way prose wants to is how a shader stops being a
             string. Twice now.) The floor of the range is
             not zero because light bounces off everything in a room and the
             back wall of a hall is dim, not black. */
          if (uRoomOn > 0.5 && wfIn > 0.01) {
            float wfFace = clamp(dot(vAtmNrm, uRoomDir) * 0.5 + 0.5, 0.0, 1.0);
            vec3 wfRoom = uRoomAmbient * mix(0.45, 1.0, wfFace);
            reflectedLight.indirectDiffuse += wfRoom * diffuseColor.rgb * wfIn;

            /* AND THE SPECULAR IS REPLACED RATHER THAN ADDED TO. scene.environment
               is the sky dome — it is the only probe this engine has — so a
               glazed cabinet or a polished floor indoors was reflecting open
               sky through the ceiling, and scaling that down only ever made
               it a darker sky. Indoors the reflection becomes the room's own
               ambient, which is not a mirror of the room (there is no cubemap
               here) but is at least the right colour arriving from the right
               side, and it stops the ceiling being a window. */
            reflectedLight.indirectSpecular =
              mix(reflectedLight.indirectSpecular, wfRoom * (0.6 + 0.4 * uRoomOpen), wfIn);
          }`
        )
        .replace(
          "#include <emissivemap_fragment>",
          /* glsl */`#include <emissivemap_fragment>
          // Windows and lamps live by the clock: banked down in daylight,
          // glowing after dark (the HDR bloom pass picks the excess up).
          // The night ceiling is 2.3, not higher: with the bloom knee at
          // 0.7 an ordinary lamp lands INSIDE the soft shoulder — a halo
          // hanging in the dark — where a bigger jump pushed every window
          // past the threshold into flame-grade glow.
          totalEmissiveRadiance *= mix(0.55, 2.3, uWfNight);`
        )
        .replace(
          "#include <tonemapping_fragment>",
          "gl_FragColor.rgb = atmApply(gl_FragColor.rgb, vAtmWorld, cameraPosition);\n#include <tonemapping_fragment>"
        );
    };
    material.needsUpdate = true;
    return material;
  }
}
