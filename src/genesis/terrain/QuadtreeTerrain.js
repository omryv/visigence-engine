// Quadtree terrain: LOD tiles selected by camera distance, geometry displaced
// by the height sampler, vertex-coloured from the biome palette, skirted to
// hide LOD cracks, frustum/distance culled. Tiles are cached and reused; a
// sampler or palette change invalidates the cache.

import * as THREE from "three";
import { elevNorm, slopeAt } from "../../kernel/terrain/heightfield.js";
import { epsFor, terrainShadeAt } from "../../kernel/terrain/shading.js";
import { canonicalStep } from "../../kernel/terrain/canonical.js";
import { gridTexMapping } from "./texmap.js";
import { PALETTES, paletteLut, shadeInto, shadeIntoBlend } from "../style/palettes.js";
import { LAYER_INDEX, LAYER_PARAMS, LAYER_NAMES } from "./detail-layers.js";
import { createBiomeField } from "../../kernel/terrain/climate.js";
import {
  Fn, uniform, texture, attribute, vec2, vec3, vec4, float, positionWorld, normalLocal, normalView, cameraPosition, cameraViewMatrix,
  dot, mix, max, min, clamp, exp, length, normalize, smoothstep, inverseSqrt, select,
} from "three/tsl";
import { wgNoise, wgTriWeights, wgTriSign, wgHeightBlend5 } from "../render/nodes.js";

/* The four splat slots, in the order the shader's weight vector uses them.
   Named here rather than spelled out at each use because the SAME order has
   to hold across five uniforms, the weight vector, the height blend and the
   roughness dot product — and a slot that is third in one of those and fourth
   in another is a bug that renders as "the ground looks a bit wrong". */
const SLOTS = ["ground", "steep", "low", "wet"];

// What a palette gets if it declares no materials: the turf/rock/sand the
// terrain wore before it could be made of anything else, plus silt for the
// channel beds, which had no material at all and was a tint.
const DEFAULT_LAYERS = { ground: "turf", steep: "rock", low: "sand", wet: "silt" };

/* ── the fifth slot: altitude ──
   The four above are decided by everything EXCEPT height. Ground is the
   default, steep is decided by the normal, low by the shore and wet by the
   drainage — and none of them can say "and above this line the ground is
   snow", which is the single most recognisable thing a mountain does.

   It is optional and it is off unless a palette names `layers.high`, because
   it costs two more albedo fetches. Those are paid only where the band
   actually reaches (see the shader's hiAmt gate), so a world with a snowline
   pays for it on its summits and nowhere else, and a world without one pays
   nothing at all.

   The band is stated as a FRACTION of params.terrain.height rather than in
   metres, because the two numbers a palette would have to guess — where this
   world's ground tops out, and what amplitude it was generated at — are the
   same number. A palette may still override it in metres with
   `layers.highBand: [from, to]` when it means a specific altitude.

   0.16–0.28 against the default 420 m amplitude is 67 m to 118 m. That is the
   top third of what these noise fields actually reach (they get to about a
   third of their stated amplitude — see style/palettes.js), so the line lands
   on the peaks rather than above everything or across the whole map. */
const HIGH_BAND_DEFAULT = [0.16, 0.28];

/* The coarse detail tap is the fine one at this multiple. One number rather
   than a per-layer choice because it is not a property of the material — it
   is how far apart the two taps have to be before their product stops
   repeating on the fine period, and that is a fact about vision. The three
   hand-tuned pairs it replaces were 17/2.75, 21/3.5 and 11/1.8: 6.2, 6.0 and
   6.1. They were the same number three times. */
const COARSE = 6.2;

/* ── LOD selection, and the band that keeps it from flapping ──
   ENTER is the threshold that has always been here: a node subdivides while
   the camera is within 2.4 of its half-extent. MARGIN is how much further the
   camera has to go before an already-subdivided node is allowed to merge back
   — proportional to the node, with an absolute floor so the smallest nodes
   still get a band no camera jitter can cross. See update() for why a single
   threshold is a knife edge and why the camera-key quantisation does not
   substitute for this. */
const LOD_ENTER = 2.4;
const LOD_MARGIN = 0.35;
const LOD_MARGIN_MIN = 8;

/* The border ring of a res x res grid, in the order the skirt duplicates it.
   Written once because _buildTile and _recolourTile both walk it and a skirt
   coloured in a different order than it was built is a ribbon of scrambled
   colour around every tile. */
function borderRing(res) {
  const border = [];
  for (let i = 0; i < res; i++) border.push(i);                        // top
  for (let j = 1; j < res; j++) border.push(j * res + res - 1);        // right
  for (let i = res - 2; i >= 0; i--) border.push((res - 1) * res + i); // bottom
  for (let j = res - 2; j >= 1; j--) border.push(j * res);             // left
  return border;
}

/* Stand-ins a texture node samples until the real map lands; the `…On`
   uniforms keep them from being read as data, and the neutral values match
   the GLSL's defaults (flat ground, open sky, nothing moved). */
const blankTex = (bytes) => { const t = new THREE.DataTexture(new Uint8Array(bytes), 1, 1); t.needsUpdate = true; return t; };
const BLANK_CTRL = blankTex([0, 128, 255, 0]);
const BLANK_EROS = blankTex([128, 0, 0, 255]);
const BLANK_ARRAY = (() => {
  const t = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
  t.needsUpdate = true; return t;
})();

/* THE GROUND, as a node graph: colour, roughness and normal. Term for term
   the GLSL this engine shipped (in this file's history at the commit that
   brought the engine in, where every term's reasoning is written out at
   length); the comments here say what each block is. Two differences, both
   forced and neither visible:
   - the vertex colour is read here rather than multiplied in by the material
     afterwards, because the shader replaces the colour wholesale;
   - the detail taps are taken unconditionally and gated by their weights.
     The GLSL skipped them past the detail range to save the fetches; WGSL
     forbids implicitly-derived texture reads under a branch that varies per
     pixel, and a level-of-detail sample would alias. */
function terrainNodes(u) {
  const P = positionWorld, Wn = normalLocal;   // tiles are world space: identity model matrix
  const layer = (s, idx, uv) => s.sample(uv).depth(idx).rgb;
  const layerTri = (s, idx, tri, w, sg, p, scale) => {
    const flat = layer(s, idx, p.xz.div(scale));
    const three = layer(s, idx, vec2(p.z.mul(sg.x), p.y).div(scale)).mul(w.x)
      .add(layer(s, idx, vec2(p.x, p.z.mul(sg.y)).div(scale)).mul(w.y))
      .add(layer(s, idx, vec2(p.x.mul(sg.z.negate()), p.y).div(scale)).mul(w.z));
    return mix(flat, three, tri);
  };
  const third = vec3(0.3333);

  {
    // Detail gate: every procedural term fades out with distance.
    const tDist = length(cameraPosition.sub(P));
    const tDet = exp(tDist.negate().mul(0.0016));
    const grain = wgNoise(P.xz.mul(0.35)).mul(0.6).add(wgNoise(P.xz.mul(2.7)).mul(0.4));

    // The macro map: value drift, a warm/cool drift, weight jitter, and a
    // domain warp on the coarse detail tap.
    const macro = wgNoise(P.xz.mul(0.0035));
    const macroC = wgNoise(P.xz.mul(0.0021).add(31.7));
    const macroW = wgNoise(P.xz.mul(0.0090).add(11.3));
    const macroWarp = vec2(wgNoise(P.xz.mul(0.0042).add(57.3)), wgNoise(P.xz.mul(0.0042).sub(19.1))).sub(0.5);

    // The control map (slope, curvature, AO, flow) and the erosion map
    // (deposition, wetness), neutral until the bake lands.
    const tUv = P.xz.div(u.uWorldSize).add(0.5).mul(u.uCtrlK).add(u.uCtrlB);
    const tCtrl = mix(vec4(0, 0.5, 1, 0), u.uCtrl.sample(tUv), u.uCtrlOn);
    const mSlope = tCtrl.r, mCurv = tCtrl.g.mul(2).sub(1), mAO = tCtrl.b, mFlow = tCtrl.a;
    const tEros = mix(vec2(0.5, 0), u.uEros.sample(tUv).rg, u.uErosOn);
    const mDep = tEros.r.mul(2).sub(1), mWetM = tEros.g;
    const tScour = smoothstep(0.08, 0.55, mDep.negate());
    const tSilt = smoothstep(0.08, 0.55, mDep);

    // Layer weights: steepness (the interpolated normal OR the bake's grade,
    // in the same 1 − cos θ units), altitude, drainage; thresholds jittered.
    const steepGeo = float(1).sub(clamp(Wn.y, 0, 1));
    const steepBake = float(1).sub(inverseSqrt(float(1).add(mSlope.mul(mSlope))));
    const steep = max(steepGeo, steepBake);
    const wJit = macroW.sub(0.5).mul(0.10);
    const rockAmt = max(smoothstep(wJit.add(0.26), wJit.add(0.62), steep), tScour.mul(smoothstep(0.10, 0.34, steep)));
    const sandAmt = max(
      float(1).sub(smoothstep(0.6, wJit.mul(22).add(4.5), P.y)).mul(float(1).sub(rockAmt)).mul(smoothstep(0, 0.4, Wn.y)),
      tSilt.mul(float(1).sub(rockAmt)).mul(smoothstep(0.15, 0.5, Wn.y)).mul(0.75));
    const wetAmt = max(smoothstep(0.50, 0.86, mFlow), smoothstep(0.30, 0.78, mWetM)).mul(float(1).sub(rockAmt)).mul(smoothstep(0.12, 0.45, Wn.y));
    const hiW = u.uHigh2.w.sub(u.uHigh2.z).mul(0.8);
    const highAmt = u.uHighOn.mul(smoothstep(u.uHigh2.z.add(macro.sub(0.5).mul(hiW)), u.uHigh2.w.add(macro.sub(0.5).mul(hiW)), P.y))
      .mul(smoothstep(0.12, 0.5, Wn.y)).mul(float(1).sub(rockAmt));

    // Detail, from the layer stack, at two scales (the coarse tap warped).
    const tDetF = exp(tDist.negate().mul(0.0011)).mul(u.uDetOn);
    const bw = wgTriWeights(Wn), sg = wgTriSign(Wn);
    const pC = P.add(vec3(macroWarp.x, 0, macroWarp.y).mul(46));
    const C = COARSE;
    const dGround = layerTri(u.uLayerAlb, u.uLayerIdx.x, u.uLayerTri.x, bw, sg, P, u.uLayerTile.x)
      .mul(layerTri(u.uLayerAlb, u.uLayerIdx.x, u.uLayerTri.x, bw, sg, pC, u.uLayerTile.x.mul(C))).mul(u.uLayerNorm.x.mul(u.uLayerNorm.x));
    const dSteep = layerTri(u.uLayerAlb, u.uLayerIdx.y, u.uLayerTri.y, bw, sg, P, u.uLayerTile.y)
      .mul(layerTri(u.uLayerAlb, u.uLayerIdx.y, u.uLayerTri.y, bw, sg, pC, u.uLayerTile.y.mul(C))).mul(u.uLayerNorm.y.mul(u.uLayerNorm.y));
    const dLow = layerTri(u.uLayerAlb, u.uLayerIdx.z, u.uLayerTri.z, bw, sg, P, u.uLayerTile.z)
      .mul(layerTri(u.uLayerAlb, u.uLayerIdx.z, u.uLayerTri.z, bw, sg, pC, u.uLayerTile.z.mul(C))).mul(u.uLayerNorm.z.mul(u.uLayerNorm.z));
    const dWet = layerTri(u.uLayerAlb, u.uLayerIdx.w, u.uLayerTri.w, bw, sg, P, u.uLayerTile.w).mul(u.uLayerNorm.w);
    const dHighRaw = layerTri(u.uLayerAlb, u.uHigh1.x, u.uHigh2.x, bw, sg, P, u.uHigh1.y)
      .mul(layerTri(u.uLayerAlb, u.uHigh1.x, u.uHigh2.x, bw, sg, pC, u.uHigh1.y.mul(C))).mul(u.uHigh2.y.mul(u.uHigh2.y));
    // Outside the detail range (and with no stack) every tap is the neutral 0.5.
    const on = select(tDetF.greaterThan(0.01), float(1), float(0));
    const dG = mix(vec3(0.5), dGround, on), dS = mix(vec3(0.5), dSteep, on), dL = mix(vec3(0.5), dLow, on), dW = mix(vec3(0.5), dWet, on);
    const dH = mix(vec3(0.5), dHighRaw, on.mul(select(highAmt.greaterThan(0.002), float(1), float(0))));

    // Normals: ground and low blended, the steep layer fully triplanar with
    // its tangents sign-corrected, strength modulated by the coarse albedo.
    const nrm = (idx, uv) => layer(u.uLayerNrm, idx, uv).mul(2).sub(1);
    const nG = nrm(u.uLayerIdx.x, P.xz.div(u.uLayerTile.x)), nL = nrm(u.uLayerIdx.z, P.xz.div(u.uLayerTile.z));
    const nTop = mix(nG, nL, sandAmt);
    const nX = nrm(u.uLayerIdx.y, vec2(P.z.mul(sg.x), P.y).div(u.uLayerTile.y));
    const nY = nrm(u.uLayerIdx.y, vec2(P.x, P.z.mul(sg.y)).div(u.uLayerTile.y));
    const nZ = nrm(u.uLayerIdx.y, vec2(P.x.mul(sg.z.negate()), P.y).div(u.uLayerTile.y));
    const steepN = vec3(0, nX.y, nX.x.mul(sg.x)).mul(bw.x)
      .add(vec3(nY.x, 0, nY.y.mul(sg.y)).mul(bw.y))
      .add(vec3(nZ.x.mul(sg.z.negate()), nZ.y, 0).mul(bw.z));
    const nAmp = float(0.65).add(clamp(dot(dG, third), 0, 1.4).mul(0.7));
    const tDetN = mix(vec3(nTop.x, 0, nTop.y), steepN, rockAmt).mul(tDetF).mul(nAmp).mul(on);

    // Height-aware blending, faded in as far as the detail that justifies it.
    const hL = vec4(dot(dG, third), dot(dS, third), dot(dL, third), dot(dW, third)).add(u.uLayerH);
    const hH = dot(dH, third).add(u.uHigh1.w);
    const wRaw0 = vec4(max(float(1).sub(rockAmt).sub(sandAmt).sub(wetAmt).sub(highAmt), 0), rockAmt, sandAmt, wetAmt);
    const wTot = max(wRaw0.x.add(wRaw0.y).add(wRaw0.z).add(wRaw0.w).add(highAmt), 1e-4);
    const wRaw = wRaw0.div(wTot), w5Raw = highAmt.div(wTot);
    const hb = wgHeightBlend5(wRaw, w5Raw, hL, hH, float(0.22));
    const hbAmt = clamp(tDetF.mul(2), 0, 1);
    const wH = mix(wRaw, hb.w, hbAmt);
    const wH5 = mix(w5Raw, hb.w5, hbAmt);

    // Colour: turf (the ramp), rock with its strata, sand, the wet bed, and
    // the altitude slot (the ramp's own peak stop, grain-nudged).
    const ramp = attribute("color", "vec3");
    const strata = wgNoise(P.xz.mul(0.06).add(P.y.mul(0.12))).mul(0.5).add(wgNoise(P.xz.mul(0.24).add(P.y.mul(0.5))).mul(0.5));
    const cTurf = ramp.mul(float(1).sub(float(0.12).sub(grain.mul(0.20)).mul(tDet)));
    const cRock = u.uRock.mul(float(0.80).add(mix(0.5, strata, tDet).mul(0.40)));
    const cSand = u.uSand.mul(float(0.9).add(grain.mul(0.2).mul(tDet)));
    const cWet = mix(ramp, mix(u.uRock, u.uSand, 0.4), 0.62).mul(0.72);
    const cHigh = ramp.mul(float(1).add(grain.sub(0.5).mul(0.10).mul(tDet)));
    const det = dG.mul(wH.x).add(dS.mul(wH.y)).add(dL.mul(wH.z)).add(dW.mul(wH.w)).add(dH.mul(wH5));
    const tCol = cTurf.mul(wH.x).add(cRock.mul(wH.y)).add(cSand.mul(wH.z)).add(cWet.mul(wH.w)).add(cHigh.mul(wH5))
      .mul(mix(vec3(1), det, tDetF.mul(0.82).mul(float(0.78).add(macroW.mul(0.44)))))
      .mul(mix(1.0, 0.86, mWetM.mul(smoothstep(0.12, 0.5, Wn.y))))           // ground water still sits in
      .mul(float(1).sub(mCurv.mul(0.16)))                                      // curvature
      .mul(mix(1.0, mAO, 0.3))                                                 // valley-scale AO
      .mul(float(1).add(macro.sub(0.5).mul(0.13)))                            // macro value
      .mul(mix(vec3(0.972, 0.994, 1.030), vec3(1.034, 1.006, 0.966), macroC)) // macro warm/cool
      .mul(mix(0.66, 1.0, smoothstep(u.uWaterY, u.uWaterY.add(1.6), P.y)));  // the tide line

    // Roughness: each layer's own, pulled down by rain on upward faces, by a
    // drainage bed, and by ground the bake says holds water; never mirror-flat.
    const tRough = dot(wH, u.uLayerRough).add(wH5.mul(u.uHigh1.z));
    const tWetK = max(max(u.uWet.mul(smoothstep(0.25, 0.85, clamp(Wn.y, 0, 1))), wH.w), mWetM.mul(0.8));
    const rough = clamp(mix(tRough, 0.24, tWetK.mul(0.88)), 0.08, 1.0);

    // The lighting normal, bent by the detail relief (world, then view space).
    const bent = normalize(cameraViewMatrix.mul(vec4(normalize(Wn.add(tDetN.mul(0.85))), 0)).xyz);
    const useBent = u.uDetOn.greaterThan(0.5).and(dot(tDetN, tDetN).greaterThan(1e-6));
    // One graph, three outputs: the colour, roughness and normal agree on
    // every weight, and the builder computes each shared term once.
    return { color: vec4(tCol, 1), roughness: rough, normal: select(useBent, bent, normalView) };
  }
}

export class QuadtreeTerrain {
  constructor({ sampler, params, palette, quality, onChange }) {
    this.sampler = sampler;
    this.params = params;
    this.palette = palette;
    this.maxDepth = quality.terrainDepth;
    this.tileRes = quality.tileRes;
    /* A ceiling on how deep the quadtree may go, independent of quality.
       Zero means "no cap". See setDepthCap for the 4.17 seconds this exists
       to stop the engine spending on tiles it is about to throw away. */
    this.depthCap = 0;
    /* Spatial climate, resolved once per instance. Safe to fix at
       construction because every params change goes through applyParams,
       which builds a new QuadtreeTerrain — there is no path on which
       params.climate changes under a live one. Null on every world that does
       not ask (params.climate null), which is every world before this
       existed, and the colour loops below then take exactly the path they
       always took. The anchors come off each palette's own `climate` field;
       the luts are built here beside them so the two lists index together. */
    this._biomes = createBiomeField(params, (name) => PALETTES[name]?.climate);
    this._biomeLuts = this._biomes ? this._biomes.names.map((n) => paletteLut(PALETTES[n])) : null;
    this.onChange = onChange || (() => {});
    this.group = new THREE.Group();
    this.group.name = "terrain";
    this.tiles = new Map(); // key → mesh
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.94, metalness: 0.0,
    });
    // Live uniforms for the surface blend — updated on palette change without
    // recompiling the program. The detail samplers always exist so the
    // program never recompiles when a detail set arrives or is swapped;
    // uDetOn simply gates them (uniform branch = uniform control flow, so
    // the implicit-derivative rule is satisfied).
    this._u = {
      uRock: { value: new THREE.Color(palette.rock ?? 0x6f6d64) },
      uSand: { value: new THREE.Color(palette.sand ?? 0xcabf9c) },
      uDetOn: { value: 0 },
      /* ── the material stack (terrain/detail-layers.js) ──
         Two array samplers where there used to be six plain ones, and ten
         materials where there used to be three. The four vec4s below are the
         SELECTION: which layer of the stack fills each splat slot for this
         biome, and the constants that layer brings with it. Changing biome is
         four uniform writes — no recompile, no texture upload, no rebuilt
         tile — which is what makes a palette able to name materials at all. */
      uLayerAlb: { value: null }, uLayerNrm: { value: null },
      uLayerIdx: { value: new THREE.Vector4() },     // layer index per slot
      uLayerTile: { value: new THREE.Vector4() },    // metres per fine repeat
      uLayerRough: { value: new THREE.Vector4() },   // A3 roughness per slot
      uLayerH: { value: new THREE.Vector4() },       // height-blend bias per slot
      uLayerTri: { value: new THREE.Vector4() },     // 1 = project on three axes
      /* The reciprocal of each selected layer's measured LINEAR mean. A tap
         multiplied by this has mean 1.0, which is the identity for something
         the palette colour is multiplied by. See detail-layers.js: the `* 2.0`
         this replaces was written against the maps' BYTE mean, and the sampler
         hands the shader linear values — so the ground within ~600 m of the
         camera was rendering at about a quarter of its palette brightness. */
      uLayerNorm: { value: new THREE.Vector4(1, 1, 1, 1) },
      /* ── the control map (engine/terrain/masks.js, baked in a worker) ──
         R slope · G curvature (0.5 = flat) · B ao · A flow accumulation.
         uCtrlK/uCtrlB map a world position onto the texture: the bake samples
         the plate corner to corner on fence posts, so cell i sits at
         -size/2 + i·size/(res-1) and its texel CENTRE is at (i+0.5)/res.
         Folding both into a scale and a bias keeps that arithmetic on the JS
         side, where it can be read, instead of as three magic numbers in a
         shader string. */
      uCtrl: { value: null },
      uCtrlOn: { value: 0 },
      uWorldSize: { value: params.terrain.size },
      uCtrlK: { value: 1 },
      uCtrlB: { value: 0 },
      /* ── the erosion map (engine/terrain/masks.js, same bake) ──
         R deposition (0.5 = nothing moved) · G wetness. Two facts about what
         the WATER DID that the finished surface cannot be asked: a flat shelf
         of laid silt and a flat shelf of scoured bedrock have the same slope,
         the same curvature and nearly the same flow, and they are not the
         same ground. Same texel mapping as uCtrl — both are baked at 513²
         over the same extent in the same worker — so uCtrlK/uCtrlB serve
         both and there is no second pair to keep in step.
         Neutral defaults (0.5, 0) render exactly as this did before the map
         existed, which is also what a world with erosion disabled gets. */
      uEros: { value: null },
      uErosOn: { value: 0 },
      /* ── the altitude slot ──
         Packed rather than spelled out because five more scalar uniforms for
         one optional layer is five more things to forget to set.
           uHigh1 = (layer index, metres per fine repeat, roughness, height bias)
           uHigh2 = (triplanar, neutralising reciprocal, band from, band to)
         uHighOn is 0 unless the palette named one, and the shader's taps are
         gated on the BAND as well, so the cost lands on summits only. */
      uHigh1: { value: new THREE.Vector4(0, 3.2, 0.6, 0.04) },
      /* The off-band is 1e6 rather than something grander on purpose. A
         highp float has 0.0625 of resolution around a million and 64 around a
         billion — so a band stated at 1e9 collapses to edge0 == edge1, and
         GLSL's smoothstep divides by that difference. The result at exactly
         the edge is 0/0. A world is never a million metres tall, and at 1e6
         the two edges are a thousand apart and unambiguously distinct. */
      uHigh2: { value: new THREE.Vector4(0, 1, 1e6, 1e6 + 1000) },
      uHighOn: { value: 0 },
      /* Wetness. The same 0..1 the atmosphere's uWfRain carries — Engine
         feeds both from one ramp — but declared here rather than borrowed,
         so this material compiles whether or not the atmosphere has patched
         it. Borrowing a uniform another patch declares is a dependency on
         patch ORDER, which is the kind of thing that works until someone
         reorders two lines in Engine.js. */
      uWet: { value: 0 },
      /* The real waterline, in world metres. The tide band below used to be
         `smoothstep(0.0, 1.6, vWp.y)` — a hardcoded y=0 — so on any world
         whose water sits anywhere but zero (flood raises it at runtime,
         Engine.setWaterLevel) the darkened strip painted itself at sea level
         while the sea was somewhere else. Fed rather than borrowed from the
         atmosphere, for the same reason uWet is. -1e8 means "no water", which
         makes every smoothstep against it resolve to dry. */
      uWaterY: { value: -1e8 },
    };
    // Per-pixel ground detail: the vertex palette gives the broad strokes,
    // but up close it reads as smooth plastic. Two octaves of world-space
    // grain plus a wet band at the waterline give it material texture at
    // zero geometry cost — and, tier permitting, seeded detail TEXTURES
    // (terrain/detail-textures.js) sampled triplanar with their normal maps,
    // which is what makes the ground read as turf/strata/ripples instead of
    // tinted clay when you stand on it. Tile positions are world-space
    // (identity model matrix), so the position IS the world position. The
    // graph and the reasoning behind every term: terrainNodes, below.
    for (const k of Object.keys(this._u)) {
      const v = this._u[k].value;
      this._u[k] = k === "uLayerAlb" || k === "uLayerNrm" ? texture(BLANK_ARRAY)
        : k === "uCtrl" ? texture(BLANK_CTRL) : k === "uEros" ? texture(BLANK_EROS) : uniform(v);
    }
    const nodes = terrainNodes(this._u);
    // The vertex colour is read INSIDE the colour node (the shader replaces
    // the colour wholesale: rock and sand are not tinted by the ramp), so the
    // material must not multiply it in again afterwards.
    this.material.vertexColors = false;
    this.material.colorNode = nodes.color;
    this.material.roughnessNode = nodes.roughness;
    this.material.normalNode = nodes.normal;
    this._syncLayers();   // the vec4s must hold real values before first compile
    this._lastCamKey = "";
    // Which quadtree nodes were split last time — the memory the hysteresis
    // band needs. Keyed the same way tiles are, so the two never disagree.
    this._subdivided = new Set();
  }

  /* The material stack (terrain/detail-textures.js) or null. Uniform swap
     only — the program was compiled with the array samplers in place, so
     neither arrival nor removal recompiles anything. The ENGINE owns the
     set's lifetime (it survives palette changes and is disposed on
     replacement), because the stack is keyed by SEED while the selection
     into it is keyed by palette. */
  setDetail(set) {
    const u = this._u;
    u.uDetOn.value = set ? 1 : 0;
    u.uLayerAlb.value = set?.albedo ?? BLANK_ARRAY;
    u.uLayerNrm.value = set?.normal ?? BLANK_ARRAY;
    // The neutral-multiplier reciprocals are a property of the generated
    // PIXELS, so they arrive with the stack; which four of them are in play is
    // a property of the palette. _syncLayers is where the two meet.
    this._detailNorm = set?.norm ?? null;
    this._syncLayers();
  }

  /* Which layer of the stack fills each of the four splat slots, and the
     constants that layer brings with it.

     Split out from setPalette because the two have different triggers and
     one of them is free: a palette change is five vector writes and no
     rebuild, whereas setPalette also has to re-colour every vertex in the
     world. Keeping them apart is what lets a future style swap move the
     ground's MATERIALS without touching its geometry. */
  _syncLayers() {
    const u = this._u;
    const sel = this.palette?.layers || DEFAULT_LAYERS;
    const idx = [], tile = [], rough = [], hgt = [], tri = [], norm = [];
    for (const slot of SLOTS) {
      const want = sel[slot] ?? DEFAULT_LAYERS[slot];
      if (!LAYER_PARAMS[want]) {
        // A palette naming a layer that does not exist is an authoring
        // mistake, and it must not render as a black world: fall back to the
        // slot's default and say which palette did it.
        console.warn(`[terrain] palette names unknown layer "${want}" for slot "${slot}"`);
      }
      const name = LAYER_PARAMS[want] ? want : DEFAULT_LAYERS[slot];
      const q = LAYER_PARAMS[name], i = LAYER_INDEX[name] ?? 0;
      idx.push(i);
      tile.push(q.tiling); rough.push(q.roughness); hgt.push(q.height); tri.push(q.triplanar);
      // 1 until a stack has landed — the detail block is gated off by uDetOn
      // until then, so the value is never read before it is real.
      norm.push(this._detailNorm?.[i] || 1);
    }
    u.uLayerIdx.value.set(...idx);
    u.uLayerTile.value.set(...tile);
    u.uLayerRough.value.set(...rough);
    u.uLayerH.value.set(...hgt);
    u.uLayerTri.value.set(...tri);
    u.uLayerNorm.value.set(...norm);

    /* ── the optional fifth: the altitude slot ──
       Off unless the palette names it. A palette naming a layer that does not
       exist gets the same treatment the four slots get — a warning and a
       fallback — except that the fallback here is to switch the slot OFF,
       because there is no sensible default material for "above the line" the
       way there is for "the ground". */
    const highName = sel.high;
    const q = highName ? LAYER_PARAMS[highName] : null;
    if (highName && !q) {
      console.warn(`[terrain] palette names unknown layer "${highName}" for the altitude slot`);
    }
    u.uHighOn.value = q ? 1 : 0;
    if (q) {
      const li = LAYER_INDEX[highName] ?? 0;
      const amp = this.params.terrain.height || 1;
      // Metres if the palette states them, otherwise a fraction of the
      // world's own amplitude — see HIGH_BAND_DEFAULT for why that is the
      // honest default.
      const band = Array.isArray(sel.highBand) && sel.highBand.length === 2
        ? sel.highBand
        : [HIGH_BAND_DEFAULT[0] * amp, HIGH_BAND_DEFAULT[1] * amp];
      // Ordered, and never zero-width: the shader smoothsteps between these
      // two and a palette stating one number twice would divide by zero.
      const from = Math.min(band[0], band[1]);
      const to = Math.max(from + 1, Math.max(band[0], band[1]));
      u.uHigh1.value.set(li, q.tiling, q.roughness, q.height);
      u.uHigh2.value.set(q.triplanar, this._detailNorm?.[li] || 1, from, to);
    }
  }

  // The stack's layer names, in index order — what a palette may name.
  static get layerNames() { return LAYER_NAMES.slice(); }

  /* The baked control map (engine/terrain/masks.js → Engine._kickTerrainMasks).
     A uniform swap only: the samplers were compiled in, so a map arriving,
     or being replaced after a sculpt never recompiles the program and never
     rebuilds a tile. `null` restores exactly the
     pre-control-map appearance, because the shader's defaults are the neutral
     values for all four channels.

     The scale/bias put a world position on the right TEXEL — the fence-post
     correction from terrain/texmap.js, which the sky-visibility and water
     shaders now share. Worked out there, in one place, rather than in the
     shader string. */
  setControlMap(tex, worldSize) {
    const u = this._u;
    u.uCtrl.value = tex || BLANK_CTRL;
    u.uCtrlOn.value = tex ? 1 : 0;
    if (!tex) return;
    const { k, b } = gridTexMapping(tex.image?.width || 1);
    u.uWorldSize.value = worldSize || this.params.terrain.size;
    u.uCtrlK.value = k;
    u.uCtrlB.value = b;
  }

  /* The erosion map: deposition and wetness, baked in the same pass as the
     control map and sharing its texel mapping exactly (both 513² over the
     same extent, from the same worker), which is why this takes no world size
     and writes no scale or bias — setControlMap already did.

     A uniform swap, like the control map: the sampler was compiled in, so a
     map arriving after erosion lands, being replaced after a sculpt, or never
     coming at all never recompiles the program and never rebuilds a tile.
     `null` restores exactly the pre-erosion-map appearance, because the
     shader's defaults are the neutral values for both channels. */
  setErosionMap(tex) {
    this._u.uEros.value = tex || BLANK_EROS;
    this._u.uErosOn.value = tex ? 1 : 0;
  }

  /* 0..1, the same figure the atmosphere's rain film runs on. Fed rather than
     shared so this material does not depend on having been atmosphere-patched
     (see the uniform block). */
  setWetness(f) { this._u.uWet.value = f; }

  /* The world's waterline in metres, or null for a world with no water. The
     shore is the one piece of "where is the water" the ground needs and
     cannot derive: flow says where water RAN, this says where it still is. */
  setWaterline(y, enabled = true) { this._u.uWaterY.value = enabled ? y : -1e8; }

  setPalette(palette) {
    this.palette = palette;
    this._lutCache = null;   // the ramp changed; the table that caches it has not

    this._u.uRock.value.setHex(palette.rock ?? 0x6f6d64);
    this._u.uSand.value.setHex(palette.sand ?? 0xcabf9c);
    this._syncLayers();   // a biome is its materials as well as its colours
    /* Recolour in place. A palette changes colour and nothing else, so the
       nine sampler calls per vertex that a rebuild would repeat are already
       on the tile — see _recolourTile. Falls back to a rebuild for any tile
       built before this existed, so the two can never disagree. */
    let all = true;
    for (const mesh of this.tiles.values()) if (!this._recolourTile(mesh)) all = false;
    if (!all) { this.rebuild(); return; }
    this.onChange();
  }

  // Drop only the tiles overlapping a world-space circle, so a sculpt brush
  // rebuilds what it touched instead of the whole world.
  invalidateArea(x, z, r) {
    let changed = false;
    for (const [key, mesh] of this.tiles) {
      const t = mesh.userData.tile;
      if (!t) continue;
      const dx = Math.max(0, Math.abs(x - t.cx) - t.half);
      const dz = Math.max(0, Math.abs(z - t.cz) - t.half);
      if (Math.hypot(dx, dz) > r) continue;
      this.group.remove(mesh); mesh.geometry.dispose();
      this.tiles.delete(key); changed = true;
    }
    if (changed) { this._lastCamKey = ""; this.onChange(); }
    return changed;
  }
  /* ── do not sharpen ground that is about to be re-cut ──
     The height sampler has two lives. Before erosion settles it is the
     ANALYTIC noise field — warp, fbm, ridged, continent, every octave
     evaluated per call — and after it, a bilinear read of a baked
     Float32Array. Measured on this engine's own default world, one 65²
     tile costs 26.1 ms against the analytic sampler and 2.0 ms against the
     baked one: thirteen times.

     That matters because of the ORDER the build runs in. _buildWorld
     constructs the terrain and the frame loop immediately selects the whole
     tile set, all of it against the analytic sampler; erosion then lands and
     rebuild() throws every one of those tiles away. At the high tier that is
     160 tiles x 26.1 ms = 4.17 SECONDS of main thread spent on geometry
     whose only destiny is to be discarded.

     Capping the depth while erosion is in flight keeps the world visible —
     it appears immediately, just coarse — while cutting the throwaway work
     by the tile count. A depth-2 set is 16 tiles rather than 160. The full
     set is then built once, against the cheap sampler, in the rebuild that
     was already going to happen.

     ── AND THE ANALYTIC SAMPLER IS NOT ALWAYS A WINDOW ──
     On a world that runs erosion it is: the baked field replaces it and this
     cap lifts. On a world that does NOT, there is no bake and the analytic
     field is what every tile is built from, permanently: a world whose params
     set `erosion: { enabled: false }` (an atoll with nothing above water to
     erode was the measured case) keeps an `analytic` sampler after a complete
     build. Profiled, that world costs 27-35 ms per tile at every
     depth: ~3.3 s for a full high-tier set and a p90 stall of 220 ms for
     every 8 m walked, which is the one genuinely interactive cost of it.

     This cap does not help there and must not be made to: capping depth
     permanently, or baking a field for erosion-disabled worlds, would both
     change how that world LOOKS — a baked field is 8 m between samples and a
     max-depth tile reads it every 1 m. That is a fidelity decision about a
     shipped world, not an optimisation, so it is written down here rather
     than taken. The behaviour-preserving route, if it is wanted, is to stop
     re-sampling: at high tier `eps` equals the grid step, so the four
     gradient taps land exactly on neighbouring vertices and a shared
     (res+2)² halo grid would serve nine calls per vertex from one. */
  setDepthCap(depth) {
    const d = depth || 0;
    if (d === this.depthCap) return;
    this.depthCap = d;
    this.rebuild();
  }

  setQuality(quality) { this.maxDepth = quality.terrainDepth; this.tileRes = quality.tileRes; this.rebuild(); }

  rebuild() {
    for (const mesh of this.tiles.values()) { this.group.remove(mesh); mesh.geometry.dispose(); }
    this.tiles.clear();
    this._subdivided.clear();
    this._lastCamKey = "";
    this.onChange();
  }

  /* Select the tile set for this camera position; build/dispose the delta.
   *
   * ── LOD SELECTION HAS HYSTERESIS, AND IT IS NOT OPTIONAL ──
   * The rule was a single threshold: subdivide while `dist < half * 2.4`.
   * A single threshold is a knife edge — a camera sitting anywhere near one
   * flips the node across it on every re-selection, and a flip is not cheap
   * here because tiles are DISPOSED rather than cached: going down costs four
   * fresh tiles, coming back up costs one, and at tileRes 65 each of those is
   * about 38 000 height-sampler calls. An orbit that grazes a boundary pays
   * that on every frame it crosses.
   *
   * The 8 m camera-key quantisation above does NOT prevent this, which is the
   * thing worth being clear about: `Math.round(x / 8)` changes the moment x
   * crosses a multiple of 8, so two consecutive re-selections can be a
   * centimetre apart in world space. It bounds how OFTEN we re-select, never
   * how far the camera moved between two of them.
   *
   * So the band has to be geometric. A node that is already subdivided stays
   * subdivided until the camera is a real margin PAST the threshold that
   * created it, and the margin scales with the node (with an absolute floor,
   * so the smallest nodes still get a band wider than any quantisation step).
   * Enter at 2.4·half, leave at 2.4·half + max(0.35·half, 8 m): the camera
   * must travel the full margin to undo a decision it just made, so no amount
   * of jitter around one position can oscillate it.
   *
   * This changes only which REPRESENTATION of the ground is drawn. Every tile
   * is still built from the same sampler at the same world coordinates, so
   * the surface itself is untouched — LOD never moves the terrain.
   */
  update(camPos) {
    const size = this.params.terrain.size;
    // Re-select only when the camera moved meaningfully (on-demand rendering).
    const camKey = `${Math.round(camPos.x / 8)}:${Math.round(camPos.y / 8)}:${Math.round(camPos.z / 8)}`;
    if (camKey === this._lastCamKey && this.tiles.size) return false;
    this._lastCamKey = camKey;

    const wanted = new Map();
    const wasSubdivided = this._subdivided;
    const nowSubdivided = new Set();
    const select = (cx, cz, half, depth) => {
      const dx = Math.max(0, Math.abs(camPos.x - cx) - half);
      const dz = Math.max(0, Math.abs(camPos.z - cz) - half);
      const dy = Math.max(0, camPos.y - this.params.terrain.height);
      const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
      const node = `${depth}:${cx.toFixed(1)}:${cz.toFixed(1)}`;
      // Already split? Then hold the split until the camera is a margin past
      // the line that split it. Otherwise the plain threshold applies.
      const maxDepth = this.depthCap ? Math.min(this.maxDepth, this.depthCap) : this.maxDepth;
      const limit = half * LOD_ENTER
        + (wasSubdivided.has(node) ? Math.max(half * LOD_MARGIN, LOD_MARGIN_MIN) : 0);
      if (depth < maxDepth && dist < limit) {
        nowSubdivided.add(node);
        const h = half / 2;
        select(cx - h, cz - h, h, depth + 1); select(cx + h, cz - h, h, depth + 1);
        select(cx - h, cz + h, h, depth + 1); select(cx + h, cz + h, h, depth + 1);
      } else {
        wanted.set(node, { cx, cz, half, depth });
      }
    };
    select(0, 0, size / 2, 0);
    this._subdivided = nowSubdivided;

    let changed = false;
    for (const [key, mesh] of this.tiles) {
      if (!wanted.has(key)) {
        this.group.remove(mesh); mesh.geometry.dispose();
        this.tiles.delete(key); changed = true;
      }
    }
    for (const [key, t] of wanted) {
      if (!this.tiles.has(key)) {
        const mesh = this._buildTile(t);
        this.tiles.set(key, mesh); this.group.add(mesh); changed = true;
      }
    }
    if (changed) this.onChange();
    return changed;
  }

  /* Re-paint the vertex colours for a new palette WITHOUT re-sampling the
     ground. A palette decides colour and nothing else — not a position, not a
     normal, not the slope-and-AO shade — yet setPalette used to call
     rebuild(), which discards every tile and re-derives all of it. Measured on
     this project's own sampler that is about 900 ms at the high tier (160
     tiles x 5.6 ms), and it is the single largest stall in the renderer: it
     fires on every style change in the editor.

     Everything expensive is already held. The elevation is the y the tile is
     standing at, and the shade is the float kept alongside it, so a recolour
     is one palette lookup and one multiply per vertex.

     The skirt is copied from its source ring rather than looked up on its own
     y: a skirt vertex sits `drop` metres BELOW the edge it hides, and drop is
     several metres at coarse depths, so colouring it by its own elevation
     would paint a visible fringe of the wrong band around every tile. */
  /* The ramp table, built once per palette rather than once per tile.
     paletteLut walks the stop list 2048 times; measured, that is ~0.25 ms,
     and _buildTile was paying it for EVERY tile — about 36 ms of a 145-tile
     high-tier build spent rebuilding a table that is identical across all of
     them. Invalidated by setPalette, which is the only thing that can change
     the answer. */
  _lut() {
    if (!this._lutCache) this._lutCache = paletteLut(this.palette);
    return this._lutCache;
  }

  _recolourTile(mesh) {
    const { shades, res } = mesh.userData;
    if (!shades || !res) return false;
    const height = this.params.terrain.height;
    const posAttr = mesh.geometry.getAttribute("position");
    const colAttr = mesh.geometry.getAttribute("color");
    const pos = posAttr.array, col = colAttr.array;
    const n = res * res;
    const lut = this._lut();
    const biomes = this._biomes, bluts = this._biomeLuts;
    for (let p = 0; p < n; p++) {
      if (biomes) {
        const cb = biomes.blendAt(pos[p * 3], pos[p * 3 + 2]);
        shadeIntoBlend(col, p, bluts[cb.a], bluts[cb.b], cb.mix, elevNorm(pos[p * 3 + 1], height), shades[p]);
      } else {
        shadeInto(col, p, lut, elevNorm(pos[p * 3 + 1], height), shades[p]);
      }
    }
    const border = borderRing(res);
    for (let k = 0; k < border.length; k++) {
      const src = border[k], dst = n + k;
      col[dst * 3] = col[src * 3]; col[dst * 3 + 1] = col[src * 3 + 1]; col[dst * 3 + 2] = col[src * 3 + 2];
    }
    colAttr.needsUpdate = true;
    return true;
  }

  _buildTile({ cx, cz, half, depth }) {
    const res = this.tileRes;
    const h = this.sampler, height = this.params.terrain.height;
    const n = res * res, skirt = res * 4 - 4;
    const pos = new Float32Array((n + skirt) * 3);
    const col = new Float32Array((n + skirt) * 3);
    const nrm = new Float32Array((n + skirt) * 3);
    /* The slope-and-AO product, per vertex, kept off the GPU.
       It is the expensive half of a vertex — nine sampler calls go into it —
       and it does not depend on the palette at all. Holding it turns a style
       change from a full re-sample of the world into an elevation lookup per
       vertex. One float per vertex: 17 KB on a 65² tile, against the ~900 ms
       that _recolourTile now avoids. */
    const shades = new Float32Array(n + skirt);
    const step = (half * 2) / (res - 1);
    const eps = epsFor(step);
    const lut = this._lut();

    /* The shade — slope darkening × baked AO — is measured at ONE fixed step:
       the canonical grid's cell size, whatever this tile's own spacing is.
       It used to follow the tile step, which made eps and the AO probe radius
       functions of LOD depth — so the same point CHANGED COLOUR when its tile
       split or merged, a visible pop at every transition, and the shelf and
       the export (which shade at their own mesh spacing) disagreed with the
       editor about the same ground. The normals below still follow the tile
       step: they are geometry, and must match the tessellation they light. */
    const shadeStep = canonicalStep(this.params.terrain.size);

    let p = 0;
    for (let j = 0; j < res; j++) {
      const z = cz - half + j * step;
      for (let i = 0; i < res; i++, p++) {
        const x = cx - half + i * step;
        const y = h(x, z);
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
        // Analytic normal from central differences — seam-free across tiles.
        const hE = h(x + eps, z), hW = h(x - eps, z);
        const hS = h(x, z + eps), hN = h(x, z - eps);
        const dx = hE - hW, dz = hS - hN;
        const inv = 1 / Math.hypot(dx, 2 * eps, dz);
        nrm[p * 3] = -dx * inv; nrm[p * 3 + 1] = 2 * eps * inv; nrm[p * 3 + 2] = -dz * inv;

        // Palette colour by elevation, darkened on steep slopes and in
        // hollows (terrain/shading.js — the ONE implementation the shelf and
        // the exporters shade with too, at this same step, so all four
        // pictures of a world agree).
        const shade = terrainShadeAt(h, x, z, shadeStep);
        shades[p] = shade;   // kept, so a palette change need not re-derive it
        /* Spatial climate colours by WHERE as well as how high: two field
           reads against the nine sampler calls the shade above already paid,
           so the per-vertex cost is noise on this loop. Off (the default),
           this is the identical single-lut line it has always been. */
        if (this._biomes) {
          const cb = this._biomes.blendAt(x, z);
          shadeIntoBlend(col, p, this._biomeLuts[cb.a], this._biomeLuts[cb.b], cb.mix, elevNorm(y, height), shade);
        } else {
          shadeInto(col, p, lut, elevNorm(y, height), shade);
        }
      }
    }

    const index = [];
    for (let j = 0; j < res - 1; j++) {
      for (let i = 0; i < res - 1; i++) {
        const a = j * res + i, b = a + 1, d = a + res, e = d + 1;
        index.push(a, d, b, b, d, e);
      }
    }
    // Where the SURFACE ends and the skirt begins, recorded before the skirt
    // exists so it cannot be wrong about it. Engine.raycastGround reads this
    // (via terrain/pick.js) to refuse hits on the skirt walls below — which
    // used to hand the sculpt brush and the placement ghost a point up to
    // 2% of the world height under the ground the pointer was over.
    const groundIndexCount = index.length;

    // Skirt: duplicate the border ring, dropped down, to mask LOD cracks.
    const drop = Math.max(half * 0.08, height * 0.02);
    const border = borderRing(res);
    for (let k = 0; k < border.length; k++) {
      const src = border[k], dst = n + k;
      pos[dst * 3] = pos[src * 3]; pos[dst * 3 + 1] = pos[src * 3 + 1] - drop; pos[dst * 3 + 2] = pos[src * 3 + 2];
      col[dst * 3] = col[src * 3]; col[dst * 3 + 1] = col[src * 3 + 1]; col[dst * 3 + 2] = col[src * 3 + 2];
      shades[dst] = shades[src];
      nrm[dst * 3] = nrm[src * 3]; nrm[dst * 3 + 1] = nrm[src * 3 + 1]; nrm[dst * 3 + 2] = nrm[src * 3 + 2];
      const srcNext = border[(k + 1) % border.length], dstNext = n + ((k + 1) % border.length);
      index.push(src, dst, srcNext, srcNext, dst, dstNext);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(index);
    geo.userData.groundIndexCount = groundIndexCount;
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `tile:${depth}`;
    mesh.userData.terrain = true;
    mesh.userData.tile = { cx, cz, half };
    mesh.userData.shades = shades;   // see _recolourTile
    mesh.userData.res = res;
    mesh.receiveShadow = true;
    // Terrain casts too: without this a mountain never shades its own valley,
    // which is what made the land read as smooth clay.
    mesh.castShadow = true;
    return mesh;
  }

  dispose() {
    this.rebuild();
    this.material.dispose();
  }
}

export { slopeAt };
