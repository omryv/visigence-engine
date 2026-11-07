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
import "../render/chunks.js";   // registers wg_noise / wg_triplanar / wg_heightblend5

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
    // (identity model matrix), so `transformed` IS the world position.
    this.material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this._u);
      // Tiles are built in world space with an identity model matrix, so the
      // position and normal attributes ARE world-space.
      sh.vertexShader = "varying vec3 vWp;\nvarying vec3 vWn;\n" + sh.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n vWp = transformed;\n vWn = normal;"
      );
      sh.fragmentShader = ("varying vec3 vWp;\nvarying vec3 vWn;\n" +
        "uniform vec3 uRock;\nuniform vec3 uSand;\n" +
        "uniform float uDetOn;\n" +
        "uniform sampler2DArray uLayerAlb;\nuniform sampler2DArray uLayerNrm;\n" +
        "uniform vec4 uLayerIdx;\nuniform vec4 uLayerTile;\nuniform vec4 uLayerRough;\n" +
        "uniform vec4 uLayerH;\nuniform vec4 uLayerTri;\nuniform vec4 uLayerNorm;\n" +
        "uniform sampler2D uCtrl;\nuniform float uCtrlOn;\n" +
        "uniform sampler2D uEros;\nuniform float uErosOn;\n" +
        "uniform vec4 uHigh1;\nuniform vec4 uHigh2;\nuniform float uHighOn;\n" +
        "uniform float uWorldSize;\nuniform float uCtrlK;\nuniform float uCtrlB;\n" +
        "uniform float uWet;\nuniform float uWaterY;\n" +
        "#include <wg_noise>\n#include <wg_triplanar>\n#include <wg_heightblend5>\n" +
        /* One layer of the stack, sampled at one scale.
           `texture2D` on a sampler2DArray is not a mistake: three compiles
           this material as `#version 300 es` and prepends
           `#define texture2D texture`, so this is GLSL3's overloaded
           texture(sampler2DArray, vec3). Spelling it the same way as every
           other fetch in this shader is deliberate — see detail-textures.js. */
        "vec3 wgLayer(sampler2DArray s, float idx, vec2 uv){ return texture2D(s, vec3(uv, idx)).rgb; }\n" +
        /* A layer projected on whichever axes it asked for. Flat ground pays
           for one tap; rock and cliff pay for three, because a stratum that
           slides down a vertical face is the single most obvious thing a
           terrain shader can get wrong. `tri` is 0 or 1 and comes from a
           uniform, so the branch is uniform control flow and the implicit
           derivative rule is satisfied.

           `sg` is the per-axis sign of the world normal (chunks.js
           wgTriSign), and it is what stops a cliff from being MIRRORED
           through its own ridge. The three projections are taken in world
           space, so without it the +X face reads the texture back to front
           against the −X face: a stratum running uphill on one side of a
           spur runs downhill on the other, and the seam along the crest is
           the giveaway that the rock is a projection rather than a rock. */
        "vec3 wgLayerTri(sampler2DArray s, float idx, float tri, vec3 w, vec3 sg, vec3 p, float scale){\n" +
        "  if (tri < 0.5) return wgLayer(s, idx, p.xz / scale);\n" +
        "  return wgLayer(s, idx, vec2(p.z * sg.x, p.y) / scale) * w.x\n" +
        "       + wgLayer(s, idx, vec2(p.x, p.z * sg.y) / scale) * w.y\n" +
        "       + wgLayer(s, idx, vec2(p.x * -sg.z, p.y) / scale) * w.z;\n" +
        "}\n" +
        sh.fragmentShader).replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         // Detail gate — the same rule the water shader lives by: every
         // procedural noise term fades out with distance or it aliases into
         // per-pixel static across the far field.
         float tDist = length(cameraPosition - vWp);
         float tDet = exp(-tDist * 0.0016);
         float grain = wgNoise(vWp.xz * 0.35) * 0.6 + wgNoise(vWp.xz * 2.7) * 0.4;

         /* ── the macro map, taken FIRST because it drives more than colour ──
            These four samples used to be two, taken at the very bottom of the
            block, and they only ever scaled the finished colour. That is the
            weakest thing a macro variation can do: the terms it competes with
            (curvature ±16%, ambient occlusion up to −30%) own the same
            channel at twice the amplitude, so the one term whose job is to
            break up the ground was the quietest voice in the conversation.

            Hoisted here, the same field also decides WHERE the materials
            change and WHAT the detail taps repeat, which is where a macro map
            earns its name:
              macro   value drift, hundreds of metres across
              macroC  a warm/cool drift at a different wavelength
              macroW  weight jitter — it moves the sand line and the rock
                      line off the exact contour they otherwise trace
              warp    a domain warp on the COARSE detail tap, so the pattern
                      the fine tap repeats is itself displaced over hundreds
                      of metres. This is the one that actually kills the
                      lattice at distance: the fine period is unchanged, but
                      what fills it stops being the same square. */
         float macro  = wgNoise(vWp.xz * 0.0035);
         float macroC = wgNoise(vWp.xz * 0.0021 + 31.7);
         float macroW = wgNoise(vWp.xz * 0.0090 + 11.3);
         vec2  macroWarp = vec2(wgNoise(vWp.xz * 0.0042 + 57.3),
                                wgNoise(vWp.xz * 0.0042 - 19.1)) - 0.5;

         /* ── the control map ──
            Four things the fragment cannot work out for itself. Slope it
            could — and does, from the interpolated normal — but the bake sees
            an EIGHT METRE footprint where the normal sees one fragment, and
            those answer different questions: the normal says "this pixel
            faces steeply", the bake says "this is the side of a hill". A
            boulder on a meadow is the first and not the second; a smooth LOD
            tile on a mountainside is the second and not the first. Both are
            reasons to show rock, so both are read and the stronger wins.
            The other three need to look further than one fragment anyway:
            curvature is a Laplacian, AO is a valley-radius probe, and flow
            accumulation needs every cell in the world sorted by height.
            Neutral defaults so a world whose bake has not landed yet
            renders exactly as it did before this existed. */
         vec2 tUv = (vWp.xz / uWorldSize + 0.5) * uCtrlK + uCtrlB;
         vec4 tCtrl = vec4(0.0, 0.5, 1.0, 0.0);
         if (uCtrlOn > 0.5) tCtrl = texture2D(uCtrl, tUv);
         float mSlope = tCtrl.r;              // grade, in units of 45°
         float mCurv = tCtrl.g * 2.0 - 1.0;   // -1 convex ridge · +1 concave hollow
         float mAO   = tCtrl.b;               // 1 = open sky (see aoFromConcavity's cap)
         float mFlow = tCtrl.a;               // log-normalised drainage

         /* ── and what the water DID, which is a different question ──
            Same texel, same bake, second texture. Deposition is signed about
            0.5; wetness is where water lingers rather than where it runs.
            (0.5, 0.0) is the neutral pair, so a world with erosion switched
            off takes every line below and changes nothing. */
         vec2 tEros = vec2(0.5, 0.0);
         if (uErosOn > 0.5) tEros = texture2D(uEros, tUv).rg;
         float mDep  = tEros.r * 2.0 - 1.0;   // -1 scoured … +1 buried
         float mWetM = tEros.g;
         float tScour = smoothstep(0.08, 0.55, -mDep);   // stripped to bedrock
         float tSilt  = smoothstep(0.08, 0.55,  mDep);   // sediment laid down

         /* ── layer weights ──
            Steepness decides rock, altitude decides sand and the high slot,
            drainage decides wet. Every one of those thresholds is jittered by
            the macro field, because a threshold on a smooth quantity draws a
            CONTOUR: without it the sand line is a perfect level curve around
            every island and the rock line a perfect isocline around every
            hill, which is the tell that the ground was computed rather than
            weathered. */
         float steepGeo = 1.0 - clamp(vWn.y, 0.0, 1.0);
         /* The bake's grade, converted into the same "1 − cos θ" units the
            interpolated normal is in, so the two are the SAME MEASUREMENT of
            the same thing rather than two numbers that both happen to be
            large on a slope. That conversion is what lets them be combined
            with a plain max() and no tuning constant: on ground where both
            are right they agree exactly and the max changes nothing, and each
            wins only where the other is blind — the normal on a boulder finer
            than the bake's 8 m step, the bake on a coarse LOD tile whose
            vertex normals have smoothed the hillside flat. That second case
            is why distant mountainsides used to lose their rock as they
            dropped a LOD level while the near ones kept it. */
         float steepBake = 1.0 - inversesqrt(1.0 + mSlope * mSlope);
         float steep = max(steepGeo, steepBake);
         float wJit = (macroW - 0.5) * 0.10;
         float rockAmt = smoothstep(0.26 + wJit, 0.62 + wJit, steep);
         // Ground the water stripped shows its bedrock at a gentler grade than
         // ground that was never touched — that is what scour IS.
         rockAmt = max(rockAmt, tScour * smoothstep(0.10, 0.34, steep));
         float sandAmt = (1.0 - smoothstep(0.6, 4.5 + wJit * 22.0, vWp.y)) * (1.0 - rockAmt);
         sandAmt *= smoothstep(0.0, 0.4, vWn.y);
         // And sediment is the low slot's material wherever the pass laid it,
         // shore or no shore: an alluvial fan is sand a long way inland.
         sandAmt = max(sandAmt, tSilt * (1.0 - rockAmt) * smoothstep(0.15, 0.5, vWn.y) * 0.75);
         // Channels cut through turf and sand but not through a cliff face,
         // and only where the ground is flat enough for water to have stayed.
         // Flow says where water RAN; the wetness mask says where it stayed,
         // and a bed is either.
         float wetAmt = max(smoothstep(0.50, 0.86, mFlow), smoothstep(0.30, 0.78, mWetM))
                      * (1.0 - rockAmt) * smoothstep(0.12, 0.45, vWn.y);
         /* ── altitude ──
            The band undulates with the macro field by most of its own width,
            so a snowline follows the weather rather than a spirit level. It
            is a mantle, so it wants an upward face, and it loses to a cliff
            outright rather than trying to lie on one. */
         float hiW = (uHigh2.w - uHigh2.z) * 0.8;
         float highAmt = uHighOn * smoothstep(uHigh2.z + (macro - 0.5) * hiW,
                                              uHigh2.w + (macro - 0.5) * hiW, vWp.y)
                       * smoothstep(0.12, 0.5, vWn.y) * (1.0 - rockAmt);

         /* ── detail, from the layer stack, at two scales ──
            One tiling scale is a visible grid the moment you look along the
            ground: the same square, edge to edge, to the horizon. Multiplying
            a fine tap by a coarse one costs a second fetch and breaks the
            period — the pattern still repeats at the fine scale, but WHAT it
            repeats is modulated over six times that distance, so the eye
            stops finding the lattice. Both are world-space, so they are
            stable across tile boundaries and across every LOD.

            The four taps are now four DIFFERENT materials out of a ten-layer
            array rather than three fixed ones, and which four is a uniform.
            Nothing here knows what turf is. */
         vec3 dGround = vec3(0.5), dSteep = vec3(0.5), dLow = vec3(0.5), dWet = vec3(0.5);
         vec3 dHigh = vec3(0.5);
         vec3 tDetN = vec3(0.0);
         float tDetF = exp(-tDist * 0.0011) * uDetOn;
         if (tDetF > 0.01) {
           vec3 bw = wgTriWeights(vWn);
           vec3 sg = wgTriSign(vWn);
           /* The coarse tap reads a WARPED position (see the macro block).
              Dual-scale breaks the period of the fine tap by modulating it
              with something six times longer; warping the modulator breaks
              the modulator's own period as well, which is what was still
              showing at distance — the far field had a visible six-times grid
              in place of the one-times grid it was built to hide. The warp is
              tens of metres, so nothing moves under a walking camera. */
           vec3 pC = vWp + vec3(macroWarp.x, 0.0, macroWarp.y) * 46.0;
           /* Each tap is scaled by its layer's own measured reciprocal, so it
              has mean 1.0 and the product of two does as well. That is the
              identity for a multiplier — see the uLayerNorm declaration for
              the quarter-brightness bug the old hardcoded ×2 was causing. */
           dGround = wgLayerTri(uLayerAlb, uLayerIdx.x, uLayerTri.x, bw, sg, vWp, uLayerTile.x)
                   * wgLayerTri(uLayerAlb, uLayerIdx.x, uLayerTri.x, bw, sg, pC, uLayerTile.x * ${COARSE})
                   * (uLayerNorm.x * uLayerNorm.x);
           dSteep  = wgLayerTri(uLayerAlb, uLayerIdx.y, uLayerTri.y, bw, sg, vWp, uLayerTile.y)
                   * wgLayerTri(uLayerAlb, uLayerIdx.y, uLayerTri.y, bw, sg, pC, uLayerTile.y * ${COARSE})
                   * (uLayerNorm.y * uLayerNorm.y);
           dLow    = wgLayerTri(uLayerAlb, uLayerIdx.z, uLayerTri.z, bw, sg, vWp, uLayerTile.z)
                   * wgLayerTri(uLayerAlb, uLayerIdx.z, uLayerTri.z, bw, sg, pC, uLayerTile.z * ${COARSE})
                   * (uLayerNorm.z * uLayerNorm.z);
           /* The wet slot takes ONE tap. Its materials are the fine sediments
              — silt, gravel — which carry the least structure in the stack,
              so they are the least able to show a lattice and the cheapest
              place to stop paying for one. One tap, so one reciprocal. */
           dWet    = wgLayerTri(uLayerAlb, uLayerIdx.w, uLayerTri.w, bw, sg, vWp, uLayerTile.w) * uLayerNorm.w;
           /* The altitude slot, gated on the BAND and not only on the uniform.
              A palette that names a high layer would otherwise pay two fetches
              on every fragment of its coastline for a material that cannot
              reach it; gated, the cost lands on the summits where the layer
              is actually visible. */
           if (highAmt > 0.002) {
             dHigh = wgLayerTri(uLayerAlb, uHigh1.x, uHigh2.x, bw, sg, vWp, uHigh1.y)
                   * wgLayerTri(uLayerAlb, uHigh1.x, uHigh2.x, bw, sg, pC, uHigh1.y * ${COARSE})
                   * (uHigh2.y * uHigh2.y);
           }

           /* Normals. Three taps, not four: the ground and low layers each
              get their own, blended by the weight that decides between them,
              and the steep layer keeps the full triplanar treatment because
              that is the one standing on a wall. The wet slot borrows the low
              slot's normal — silt and sand are both fine sediment, and a
              fourth fetch to say so would be paying for a difference nobody
              can see under water. The high slot borrows the ground's for the
              same reason it borrows its colour: the altitude layer's value is
              WHERE it is, and its own relief arrives through the height blend
              and the roughness. */
           vec3 nG = wgLayer(uLayerNrm, uLayerIdx.x, vWp.xz / uLayerTile.x) * 2.0 - 1.0;
           vec3 nL = wgLayer(uLayerNrm, uLayerIdx.z, vWp.xz / uLayerTile.z) * 2.0 - 1.0;
           vec3 nTop = mix(nG, nL, sandAmt);
           /* The steep normal's three projections carry the same sign
              correction the albedo does, and their TANGENT directions carry
              it too — flipping the UV without flipping the perturbation it
              drives lights the far side of a spur as though the sun had moved.
              (chunks.js wgTriSign for why the UV is flipped at all.) */
           vec3 nX = wgLayer(uLayerNrm, uLayerIdx.y, vec2(vWp.z * sg.x, vWp.y) / uLayerTile.y) * 2.0 - 1.0;
           vec3 nY = wgLayer(uLayerNrm, uLayerIdx.y, vec2(vWp.x, vWp.z * sg.y) / uLayerTile.y) * 2.0 - 1.0;
           vec3 nZ = wgLayer(uLayerNrm, uLayerIdx.y, vec2(vWp.x * -sg.z, vWp.y) / uLayerTile.y) * 2.0 - 1.0;
           vec3 steepN = vec3(0.0, nX.y, nX.x * sg.x) * bw.x
                       + vec3(nY.x, 0.0, nY.y * sg.y) * bw.y
                       + vec3(nZ.x * -sg.z, nZ.y, 0.0) * bw.z;
           /* ── and the repetition break has to reach the NORMALS ──
              Dual-scale was applied to albedo only, and albedo is the weaker
              cue by a long way: these maps are near-neutral by design, while
              the relief they drive is lit by a directional sun. Under that
              sun the micro-shadowing is what the eye reads as pattern, so a
              perfectly de-latticed albedo over a normal map repeating every
              2.75 m still reads as a grid.

              Three more fetches would fix it properly and cost a third of the
              stack's bandwidth. This modulates the normal's STRENGTH by the
              coarse albedo tap already in hand — the relief still repeats,
              but how deep it bites varies over six times the distance, which
              is enough to stop the run of identical highlights that gives the
              lattice away. Free, and it uses a value that would otherwise
              have been fetched and half-forgotten. */
           float nAmp = 0.65 + 0.7 * clamp(dot(dGround, vec3(0.3333)), 0.0, 1.4);
           tDetN = mix(vec3(nTop.x, 0.0, nTop.y), steepN, rockAmt) * tDetF * nAmp;
         }

         /* ── height-aware blending ──
            The detail maps are generated from a height field, so their
            luminance IS the material's relief. Feeding that to the blend is
            what turns a crossfade into an interlock: gravel comes up through
            the gaps between grass clumps rather than the two averaging into
            a band of neither. Silt is given a low flat height on purpose —
            it is the thing that fills in around the others. */
         /* Each layer's relief, plus the bias it declares. The bias is what
            lets a palette say "gravel comes up THROUGH turf" and "silt fills
            in around everything" without either material's map being redrawn:
            gravel carries +0.10 and silt −0.10, so at equal weight the gravel
            wins the high pixels and the silt takes the low ones. */
         vec4 hL = vec4(dot(dGround, vec3(0.3333)), dot(dSteep, vec3(0.3333)),
                        dot(dLow, vec3(0.3333)), dot(dWet, vec3(0.3333))) + uLayerH;
         float hH = dot(dHigh, vec3(0.3333)) + uHigh1.w;
         vec4 wRaw = vec4(max(1.0 - rockAmt - sandAmt - wetAmt - highAmt, 0.0), rockAmt, sandAmt, wetAmt);
         float w5Raw = highAmt;
         float wTot = max(wRaw.x + wRaw.y + wRaw.z + wRaw.w + w5Raw, 1e-4);
         wRaw /= wTot; w5Raw /= wTot;
         /* Height blending needs heights to blend BY. Where the detail set is
            absent — the low tier ships none, and every tier fades it out with
            distance — the four heights are the same constant, and blending on
            a constant is not a blend: it sharpens on weight alone and puts a
            hard edge where there used to be a gradient. So the interlock is
            faded in exactly as far as the information that justifies it,
            which leaves the low tier and the far field rendering the ordinary
            weighted mix they rendered before.

            Five lanes, and with no altitude layer the fifth weight is
            zero — at which point wgHeightBlend5 collapses to the four-lane
            answer, so this is the same picture on every world that does
            not use it. */
         vec4 wHB; float wHB5;
         wgHeightBlend5(wRaw, w5Raw, hL, hH, 0.22, wHB, wHB5);
         float hbAmt = clamp(tDetF * 2.0, 0.0, 1.0);
         vec4 wH = mix(wRaw, wHB, hbAmt);
         float wH5 = mix(w5Raw, wHB5, hbAmt);

         // Rock keeps its coarse banding; it is what reads as strata.
         float strata = wgNoise(vec2(vWp.xz * 0.06) + vWp.y * 0.12) * 0.5
                      + wgNoise(vec2(vWp.xz * 0.24) + vWp.y * 0.5) * 0.5;
         vec3 cTurf = diffuseColor.rgb * (1.0 - (0.12 - 0.20 * grain) * tDet);
         vec3 cRock = uRock * (0.80 + 0.40 * mix(0.5, strata, tDet));
         vec3 cSand = uSand * (0.9 + 0.2 * grain * tDet);
         // Wet channel bed: darker and desaturated toward silt, which is what
         // a drainage line looks like from above even in dry weather.
         vec3 cWet = mix(diffuseColor.rgb, mix(uRock, uSand, 0.4), 0.62) * 0.72;
         /* The altitude slot takes the ramp's own colour and no new uniform.
            The vertex ramp is ALREADY an elevation ramp — by the time this
            weight is non-zero, diffuseColor is the palette's own peak stop —
            so a "high colour" would be a second answer to a question already
            answered, and the two would drift. What the slot contributes is
            the MATERIAL: snow's crust normal, its roughness, its relief in
            the interlock. Only the grain is nudged, so a drift reads as
            wind-packed rather than as flat paint. */
         vec3 cHigh = diffuseColor.rgb * (1.0 + 0.10 * (grain - 0.5) * tDet);

         vec3 tCol = cTurf * wH.x + cRock * wH.y + cSand * wH.z + cWet * wH.w + cHigh * wH5;
         // The wet slot contributes its OWN material now. It used to borrow
         // the ground layer's detail, because a channel bed had no material
         // of its own to show — it was a tint over grass.
         vec3 det = dGround * wH.x + dSteep * wH.y + dLow * wH.z + dWet * wH.w + dHigh * wH5;
         /* And how hard the detail bites is itself macro-varied. A constant
            0.82 gives every square metre of the world the same amount of
            texture, which is the other half of why a biome read as one
            painted surface: the pattern was broken up but its STRENGTH was
            not, so the eye still found a uniform field. */
         tCol *= mix(vec3(1.0), det, tDetF * 0.82 * (0.78 + 0.44 * macroW));
         // Ground the water is still sitting in reads darker whatever it is
         // made of — before any of the colour terms below, because this is
         // the material being wet rather than the light doing something.
         tCol *= mix(1.0, 0.86, mWetM * smoothstep(0.12, 0.5, vWn.y));

         /* ── curvature ──
            The term that makes ground read as carved rather than lumpy.
            Convex ridges catch light, concave hollows lose it — which is
            true of real ground for reasons (rain, scree, shadow) the
            renderer is not modelling, so it is applied directly. */
         tCol *= 1.0 - mCurv * 0.16;

         /* ── ambient occlusion, per fragment ──
            The vertex colours already carry AO, and this is the SECOND term,
            so what it adds has to be something the first cannot see.

            It is: the two probes are deliberately different sizes. The vertex
            bake's radius follows the tile's own spacing and clamps to 8 m on
            every tier a person walks around in (shading.js aoRadiusFor), so
            it reads gullies. The mask bake runs at 8 m spacing over the whole
            plate and probes at 48 m, so it reads VALLEYS — occlusion from
            ground far enough away that no tile-local probe reaches it. A
            hollow that is both a gully and in a valley is darker than either,
            which is correct.

            What was not correct was the strength. Both terms floor at 0.5
            (AO_CAP), so at 0.55 the pair bottomed out at 0.36 — a 64%
            darkening from ambient occlusion alone, before the curvature term
            below and the sky-visibility term in atmosphere.js take their own
            bites out of the same hollow. At 0.3 the pair floors at 0.43,
            which leaves the other two something to say.

            It still cannot double-darken OPEN ground: aoFromConcavity returns
            1.0 there and 1.0 is the identity here. */
         tCol *= mix(1.0, mAO, 0.3);

         /* ── macro colour ──
            One wavelength, hundreds of metres across, at low amplitude. Its
            job is to stop a biome reading as one flat painted surface from
            the air without reading as noise from the ground, which is why it
            is a single octave and why the amplitude is this small. Sampled at
            the top of the block now, with the rest of the macro field.

            ── and it has to be COLOUR, not only value ──
            The first line is a scalar multiply: it varies brightness and
            leaves hue and chroma exactly where they were, so it competes
            directly with curvature (±16%) and ambient occlusion (up to −30%)
            in the one channel those two already own, at a fifth of their
            amplitude.

            A second octave at a different wavelength, drifting warm against
            cool, says something none of the other terms is saying. Warm and
            cool rather than a named hue so it stays inside whatever the
            palette already is: a green biome goes olive and sage, a red one
            goes rust and clay. Biome identity survives because this scales
            the colour the palette chose, never replaces it. */
         tCol *= 1.0 + (macro - 0.5) * 0.13;
         tCol *= mix(vec3(0.972, 0.994, 1.030), vec3(1.034, 1.006, 0.966), macroC);

         // Wet strip right at the tide line, under everything else — and at
         // the tide line the world actually has, not at y=0.
         tCol *= mix(0.66, 1.0, smoothstep(uWaterY, uWaterY + 1.6, vWp.y));
         diffuseColor.rgb = tCol;`
      ).replace(
        /* ── A3: roughness is a property of the material, not of the mesh ──
           The whole terrain shipped at roughness 0.94, so wet river gravel,
           dry sand and bare rock all returned the same specular lobe and the
           ground read as one substance that had been painted different
           colours. The weights that just decided the COLOUR decide this too,
           which is what keeps the two from disagreeing.

           `roughnessmap_fragment` runs after `color_fragment` in the standard
           shader (map → color → alpha → roughness → metalness → normal), so
           wH is already in scope here. That ordering is three's, not ours —
           the include list is in vendor/three; if it ever changes, this
           breaks loudly at compile rather than quietly at runtime. */
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
         /* The roughness of whatever this pixel is actually made of. These
            four figures used to be constants on this line — turf .95, rock
            .72, sand .92, wet .28 — which put the numbers here while the
            MATERIALS lived somewhere else, so a biome floored with gravel and
            silt still returned turf's specular lobe.

            Now each layer brings its own and it arrives in the same uniform
            block the colour did, so the two cannot disagree. Note what became
            of the wet figure: .28 was doing two jobs, standing in for the
            channel-bed material AND for the water lying on it. Those have
            separated — the slot now carries silt's dry .55 or gravel's .88,
            and the WETNESS term below is what pulls it down. A drainage line
            in a dry season reads as the sediment it is, which is what the
            flow mask was baked for in the first place. */
         float tRough = dot(wH, uLayerRough) + wH5 * uHigh1.z;
         /* Rain wets what faces the sky; a drainage channel is wet whichever
            way it faces, because that is where the water actually went; and
            ground the erosion pass says HOLDS water is wet in a dry season
            too, which is the whole difference between a channel and a marsh.
            All three are combined with max() rather than added: ground
            already soaked by a river does not get wetter because it is also
            raining. */
         float tWetK = max(max(uWet * smoothstep(0.25, 0.85, clamp(vWn.y, 0.0, 1.0)), wH.w),
                           mWetM * 0.8);
         tRough = mix(tRough, 0.24, tWetK * 0.88);
         /* ── and do not throw away what the atmosphere already said ──
            engine/render/atmosphere.js patches this same material and anchors
            on this same include, chaining AFTER this patch — so in the final
            shader its two lines run first and this block runs last. It writes
            the waterline gloss (the band within 1.2 m above the real water
            level, which is the shoreline term this shader has no other way to
            know) and the snow crust. A plain assignment here overwrote both:
            on the terrain material, and only on the terrain material, wet
            shores and snowfields have been returning dry ground's roughness.

            Carried forward as a DELTA off the material's base roughness
            rather than by naming the atmosphere's variables, because this
            material must still compile if it is never atmosphere-patched —
            the same reason uWet is declared here rather than borrowed. When
            there is no atmosphere the delta is zero and this is exactly the
            assignment it replaces. */
         float tAtmos = roughnessFactor - roughness;
         // Never fully smooth: a mirror-flat ground plane fireflies under the
         // sun's specular and the bloom pass then smears it across the frame.
         roughnessFactor = clamp(tRough + tAtmos, 0.08, 1.0);`
      ).replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
         // Bend the lighting normal by the detail relief (world space, then
         // back to view space — three lights in view space).
         if (uDetOn > 0.5 && dot(tDetN, tDetN) > 1e-6) {
           vec3 tWn = normalize(vWn + tDetN * 0.85);
           normal = normalize((viewMatrix * vec4(tWn, 0.0)).xyz);
         }`
      );
    };
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
    u.uLayerAlb.value = set?.albedo ?? null;
    u.uLayerNrm.value = set?.normal ?? null;
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
    u.uCtrl.value = tex;
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
    this._u.uEros.value = tex || null;
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
     field is what every tile is built from, permanently — `lonepalm` sets
     `erosion: { enabled: false }` (js/worlds.js:306) because there is nothing
     above water to erode, and its sampler is still `analytic` after a
     complete build. Profiled, that world costs 27-35 ms per tile at every
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
