/* chunks.js — the GLSL that more than one surface needs, written once.
 *
 * WHY THIS EXISTS. The same value-noise pair was implemented three times, in
 * three files, under three names: `tHash`/`tNoise` in the terrain shader,
 * `wfHash`/`wfNoise` in the atmosphere patch, and `hash`/`noise` in the water
 * shader. All three used the identical constants — `vec2(127.1, 311.7)` and
 * `43758.5453`, smoothstep-interpolated on a unit lattice — so they were not
 * three implementations of an idea, they were three copies of one function.
 * Consolidating them changes no rendered pixel; it was verified by comparing
 * the three sources term by term before any of them was touched.
 *
 * WHAT THIS IS NOT. Not a shader framework, not a material system, not a
 * variant/define engine. It is a place for a function that two surfaces
 * genuinely share, and nothing else belongs here. A helper used by exactly
 * one shader stays in that shader, where it can be read next to its caller.
 *
 * ── THE INCLUDE GUARDS ARE LOAD-BEARING ──
 * three.js expands `#include <name>` with a plain regex substitution
 * (WebGLProgram's parseIncludes). It does not track what it has already
 * expanded. The terrain material is patched TWICE — once by
 * QuadtreeTerrain's own onBeforeCompile and again by atmosphere.apply(),
 * which chains onto it — so a chunk both of them include would be pasted in
 * twice and the program would fail to link on a duplicate definition. Every
 * chunk below is therefore wrapped in a `#ifndef` guard, which the GLSL ES
 * 3.00 preprocessor honours, and double inclusion is a no-op rather than an
 * error. Remove a guard and the terrain stops compiling the moment two
 * patches want the same helper.
 */

import * as THREE from "three";

/* Value noise on a unit lattice. The authoritative copy — the one the terrain,
   the water and the air all now read from. Kept byte-for-byte equivalent to
   the three it replaces, deliberately: this commit is a consolidation and any
   change of output would hide inside it. */
export const WG_NOISE = /* glsl */`
#ifndef WG_NOISE_INCLUDED
#define WG_NOISE_INCLUDED
float wgHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wgNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wgHash(i), wgHash(i + vec2(1, 0)), f.x),
             mix(wgHash(i + vec2(0, 1)), wgHash(i + vec2(1, 1)), f.x), f.y);
}
#endif
`;

/* Triplanar projection weights from a world normal. The terrain already did
   this inline for rock; it is here because the layer stack needs the same
   three weights and a second inline copy is how the first divergence starts.

   ── THE WEIGHTS ARE SHARPENED, AND THAT IS THE WHOLE POINT OF THEM ──
   |n| normalised is the naive answer and it is a poor one: on a 45° face the
   two dominant axes come out at 0.5 each, so a cliff shows a fifty-fifty
   average of its strata read along the grain and across it — which is neither,
   and reads as the mush that makes triplanar mapping look like a compromise.
   Raising the weights to a power before normalising narrows that band without
   hardening it into a seam: at 4 the same 45° face is still a genuine blend,
   but the blend is over a few degrees rather than over the whole quadrant.
   Four is the low end of the usual 4–8, chosen because these layers have real
   relief and a harder cut would show the normal map's seam.

   wgTriSign, below, is the other half. The three planar projections are taken
   in world space, so the +X face and the −X face read the texture mirrored
   through each other and a stratum that runs uphill on one side of a ridge
   runs downhill on the other. Flipping one axis by the normal's sign is the
   standard fix and it costs a multiply. */
export const WG_TRIPLANAR = /* glsl */`
#ifndef WG_TRIPLANAR_INCLUDED
#define WG_TRIPLANAR_INCLUDED
vec3 wgTriWeights(vec3 n){
  vec3 w = abs(n);
  w *= w; w *= w;              // ⁴ — see the note above, not a magic number
  return w / (w.x + w.y + w.z + 1e-5);
}
vec3 wgTriSign(vec3 n){
  // +1/−1 per axis, and never 0: sign() returns 0 on a perfectly axis-aligned
  // component, which would collapse that projection's UV onto a single line.
  return vec3(n.x < 0.0 ? -1.0 : 1.0, n.y < 0.0 ? -1.0 : 1.0, n.z < 0.0 ? -1.0 : 1.0);
}
#endif
`;

/* ── height-aware blending ──
   A `mix()` between two materials is a dissolve: at weight 0.5 every pixel is
   half gravel and half grass, which is the muddy grey band you see along every
   linear terrain transition. Real boundaries interlock — gravel sits in the
   gaps between grass clumps, and which one you see at a given pixel is decided
   by which is physically HIGHER there, not by a global ratio.

   So each layer offers a height as well as a weight, and the two are added.
   The winner is taken per pixel, with a narrow band near the top where the
   losers still contribute — `contrast` is the width of that band in the same
   units as the heights. Small contrast gives a hard interlocking edge, large
   gives back the dissolve.

   This is the standard depth/height blend. It carries FIVE lanes because
   that is what the splat has: four vec4 slots plus the ALTITUDE slot — the
   material a biome wears above a line, which the other four could not
   express: ground is the default, steep is decided by the normal, low by
   the shore and wet by the drainage, and none of those is "and above 300 m
   it is snow".

   A fifth vec4 lane would have been free and is not what this is: the extra
   weight rides beside the vec4 rather than in a vec5 (GLSL has no such
   type), and with w5 = 0 the function returns exactly the four-lane answer,
   which is what lets a world with no altitude layer take this path and
   render as though it did not. (A separate four-lane wgHeightBlend4 used to
   sit beside this one; it ended up with zero callers — the terrain calls
   only this — and a shader function nobody calls is a maintenance hazard
   pretending to be an option, so it is gone.)
 */
export const WG_HEIGHTBLEND5 = /* glsl */`
#ifndef WG_HEIGHTBLEND5_INCLUDED
#define WG_HEIGHTBLEND5_INCLUDED
void wgHeightBlend5(vec4 weights, float w5, vec4 heights, float h5, float contrast,
                    out vec4 outW, out float outW5){
  vec4 h = heights + weights;
  h = mix(vec4(-1.0), h, step(1e-4, weights));
  float g = w5 > 1e-4 ? h5 + w5 : -1.0;
  float top = max(max(max(h.x, h.y), max(h.z, h.w)), g);
  vec4 k = max(h - (top - contrast), 0.0);
  float k5 = max(g - (top - contrast), 0.0);
  float sum = k.x + k.y + k.z + k.w + k5;
  if (sum > 1e-5) { outW = k / sum; outW5 = k5 / sum; }
  else { outW = vec4(1.0, 0.0, 0.0, 0.0); outW5 = 0.0; }
}
#endif
`;

/* ── the one output curve ──
 * ACES + sRGB, and it belongs here rather than beside the fog for one reason:
 * THREE surfaces apply it and they must not be able to drift apart. The sky
 * dome and the sea are hand-written shaders that three does not tone map for
 * itself, and the post pipeline's composite grades the whole frame when it is
 * active. A frame in which the sea is on a different curve from the land is
 * the exact failure this file exists to prevent, and until now the definition
 * lived in atmosphere.js — so `post.js` imported its final-frame transform
 * from the aerial-perspective module, which is nobody's mental model of where
 * a tone map lives.
 *
 * Constants verified term by term against the vendored three (r185)
 * ACESFilmicToneMapping chunk: both matrices, the RRT-and-ODT fit, the
 * exposure/0.6 prescale and the final saturate are identical, so a surface on
 * this curve and a surface on three's own curve agree exactly.
 */
export const WG_ACES = /* glsl */`
#ifndef WG_ACES_INCLUDED
#define WG_ACES_INCLUDED
vec3 wfAcesTone(vec3 color, float exposure) {
  const mat3 ACESIn = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOut = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color *= exposure / 0.6;
  color = ACESIn * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = ACESOut * (a / b);
  return clamp(color, 0.0, 1.0);
}

// Linear working space → sRGB display, matching three's output transform.
vec3 wfSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}
#endif
`;

/* The output transform for the two hand-written shaders (sky, water). Lit
   materials get ACES + sRGB from three automatically WHEN RENDERING TO THE
   CANVAS; these do not, so without this the sky and the sea would be the only
   surfaces in the frame on a different curve. When the HDR post pipeline is
   active (uWfPost = 1) the roles flip: three skips tone mapping for render
   targets, so these shaders must emit LINEAR RADIANCE and let the composite
   grade the whole frame at once — bloom thresholds only mean anything against
   un-crushed HDR values.

   The nested `#include <wg_aces>` is load-bearing and it works: three's
   resolveIncludes recurses (its handler returns parseIncludes(chunk)), so a
   chunk may include another. Because both carry guards, a shader that pulls
   in wg_aces directly AND wg_output gets exactly one copy of each. */
export const WG_OUTPUT = /* glsl */`
#ifndef WG_OUTPUT_INCLUDED
#define WG_OUTPUT_INCLUDED
#include <wg_aces>
uniform float uExposure;
uniform float uWfPost;
vec3 wfToneMap(vec3 color) { return wfAcesTone(color, uExposure); }

vec3 wfOutput(vec3 linear) {
  if (uWfPost > 0.5) return linear; // HDR pipeline grades the frame later
  return wfSrgb(wfAcesTone(linear, uExposure));
}
#endif
`;

/* Registered under `wg_` so nothing here can collide with a three.js chunk
   name, now or when three is updated. Registration happens on import, and
   every consumer imports this module, so a chunk is always present before the
   material that includes it is compiled. */
THREE.ShaderChunk.wg_noise = WG_NOISE;
THREE.ShaderChunk.wg_triplanar = WG_TRIPLANAR;
THREE.ShaderChunk.wg_heightblend5 = WG_HEIGHTBLEND5;
THREE.ShaderChunk.wg_aces = WG_ACES;
THREE.ShaderChunk.wg_output = WG_OUTPUT;

export const WG_CHUNKS = {
  wg_noise: WG_NOISE, wg_triplanar: WG_TRIPLANAR,
  wg_heightblend5: WG_HEIGHTBLEND5,
  wg_aces: WG_ACES, wg_output: WG_OUTPUT,
};
