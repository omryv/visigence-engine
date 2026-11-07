// Unity-standard terrain detail renderer (grass, tufts, flowers, weeds).
// NOTHING is scattered automatically — detail exists only where a dev painted
// a patch in the editor. Patches live in params.props.grass.patches
// ({x, z, r, n} each), so the same placements render in the editor, in
// VSight, and in any export that reads the params.
//
// What "Unity-standard" means here, mirrored from Unity's own terrain
// system (engine/props/detail-spec.js holds the shared data):
//   · per-prototype minWidth/maxWidth/minHeight/maxHeight size ranges
//   · one Perlin field per prototype (noiseSeed, noiseSpread) drives BOTH the
//     size lerp and the dryColor→healthyColor per-instance tint, so healthy
//     clumps read taller and greener — exactly Unity's rule
//   · renderMode "grassBillboard" (card turns to the camera in the vertex
//     shader) or "grass" (static crossed cards)
//   · Wind Settings for Grass: speed/size/bending/tint feed Unity's
//     WavingGrass math — four superimposed sin⁴ waves, roots pinned, and the
//     gust crests tinted toward the wind tint (the historic ×2 DOUBLE combine,
//     neutral in still air)
//   · detailDistance: past it a card collapses to its root point, with
//     Unity's saturate(2·(D²−d²)/D²) falloff — the orbit camera bypasses the
//     fade so authoring always shows every painted patch
//   · detailDensityScale thins every patch like Unity's density slider
//
// ── AND FOUR THINGS UNITY'S FIELD DOES NOT DO ──
//   · the wind has a DIRECTION. Unity's four waves run on fixed world-XZ
//     frequencies and its bend is symmetric, so every field on every world
//     ripples along the same diagonal and none of them is ever blown over.
//     The waves here run in a wind-aligned frame and the field bows downwind
//     (detail-spec.js: wind.direction, wind.lean) — with direction 0 the
//     frame IS world XZ, so Unity's exact motion is the default.
//   · a tuft is planted by RULE, not by two literals. Altitude band,
//     clearance above the world's real waterline, and a slope cutoff that
//     thins rather than cuts (detail-spec.js: placementFit).
//   · eight species, each with its own band, slope limit and moisture
//     preference, so a patch painted across a shoreline sorts itself into
//     reeds at the water and heather on the height.
//   · a blade is tinted by the GROUND it stands on as well as by its own
//     health, so grass on sand reads as growing out of sand.
//
// ── THE INSTANCE MATRIX CARRIES NO ROTATION, AND THAT IS LOAD-BEARING ──
// The card's turn — the camera azimuth for a billboard, the authored yaw for
// a crossed pair — happens in the VERTEX SHADER for both modes now. It used
// to be baked into the instance quaternion for crossed cards, and that is why
// a wind direction was impossible: three applies instanceMatrix AFTER the
// program runs, so a displacement written into `transformed` was rotated by
// each card's own random yaw on its way to the world. Every tuft bent a
// different way and the field had no wind, only agitation.
// With the instance rotation left as identity, local XZ and world XZ differ
// by a scale that is uniform in the ground plane (the matrix is composed
// (w, h, w)), so a displacement written in world terms arrives in the world
// unturned — and the crossed cards render exactly as before, because the
// shader's rotation uses the same convention the quaternion did.

import * as THREE from "three";
import { channelRng, seedChannel } from "../../kernel/seed.js";
import { slopeAt, elevNorm } from "../../kernel/terrain/heightfield.js";
import { valueNoise } from "../../kernel/terrain/noise.js";
import { paletteLut, shadeInto } from "../style/palettes.js";
import { resolveDetail, placementFit, windVector } from "./detail-spec.js";
import { makeDetailAtlas, atlasCellUv } from "./grass-textures.js";

// Budget bookkeeping: quality.grassCount is a legacy blade cap; one textured
// card cluster stands in for a 3-blade tuft, so capacity divides by 3 and the
// tiers keep their meaning.
const CARDS_PER_TUFT = 3;

// How many fires can scorch the field at once. The shader loops this many
// times per vertex, so it is a fixed cost paid whether or not anything is
// burning — the engine hands over the nearest fires and the rest are simply
// too far away to have scorched anything visible.
const MAX_BURN = 12;

// Brush defaults for one painted patch: radius (m) and tuft count.
export const GRASS_PATCH = { r: 9, n: 110 };

// Per-instance randomness, packed into one attribute rather than four:
//   x  yaw          the card's own turn (ignored by billboards, which turn
//                   toward the camera instead)
//   y  phase        wind-clock offset in radians — a field whose blades all
//                   crest on the same frame is a flag, not grass — and,
//                   reused, the compass the tuft leans off vertical along
//   z  bend         how far this blade gives, as a multiple of the slider
//   w  tilt         how far off vertical it stands, in radians
const JITTER_ITEMS = 4;

/* One detail card: a unit-width, unit-height quad with 3 height segments so
   the wind bend curves instead of hinging, UV-mapped into its atlas cell.
   "grass" mode gets a second quad crossed at 90° — the standard detail-mesh
   shape — because a single static card vanishes edge-on; "grassBillboard"
   keeps one quad and turns it in the shader. Normals face straight up: detail
   is lit like the ground it stands on, exactly as Unity's grass is. */
function makeCardGeometry(cellIndex, crossed) {
  const { u0, v0, u1, v1 } = atlasCellUv(cellIndex);
  const rows = 4;
  const pos = [], uv = [], nrm = [], idx = [];
  const quads = crossed ? [0, Math.PI / 2] : [0];
  for (const ang of quads) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const base = pos.length / 3;
    for (let ry = 0; ry < rows; ry++) {
      const t = ry / (rows - 1);
      for (const sx of [-0.5, 0.5]) {
        pos.push(sx * ca, t, sx * sa);
        uv.push(sx > 0 ? u1 : u0, v0 + (v1 - v0) * t);
        nrm.push(0, 1, 0);
      }
    }
    for (let ry = 0; ry < rows - 1; ry++) {
      const a = base + ry * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

export class Grass {
  constructor({ params, sampler, palette, quality }) {
    this.params = params;
    this.sampler = sampler;
    this.palette = palette;
    this.capacity = Math.floor(quality.grassCount / CARDS_PER_TUFT);
    this.full = false;
    this.group = null;
    this.materials = [];      // lit materials — the engine applies atmosphere to these
    this._depthMaterials = []; // shadow casters, ours alone to dispose
    this._meshes = [];
    this._orbitView = true;
    /* The waterline every placement rule that says "above the water" is
       measured from, rather than y = 0. The two are the same number only on a
       world whose sea has never been raised, and Engine.setFloodLevel raises
       it at runtime.

       Set BEFORE the capacity bail below: the engine calls setWaterline
       whether or not this tier renders any grass, and that must not compare
       against undefined and go on to rebuild a field that does not exist. */
    this._waterY = this._paramWaterline();
    if (!this.capacity) return;

    this.settings = resolveDetail(params, palette);

    // Shared wind + fade uniforms — one set drives every prototype material.
    this.windU = { value: 0 };
    this.sizeU = { value: this.settings.wind.size };
    this.bendU = { value: this.settings.wind.bending * this.settings.windStrength };
    this.tintU = { value: new THREE.Color(this.settings.wind.tint) };
    this.distU = { value: this._effectiveDistance() };
    // Which way the wind blows, as a unit vector on the ground plane, and how
    // far the field bows along it on top of the ripple.
    this.dirU = { value: new THREE.Vector2(...windVector(this.settings.wind.direction)) };
    this.leanU = { value: this.settings.wind.lean };
    // The heat field: (x, z, scorchRadius, char) per fire, filled by
    // setBurnField from FireFX.burnField(). Zeroed = nothing is burning.
    this.burnU = { value: new Float32Array(MAX_BURN * 4) };
    this.burnCountU = { value: 0 };
    // The MAIN camera, fed by the engine. Used instead of the built-in
    // cameraPosition so the shadow pass measures distance from the viewer
    // rather than from the sun (see _vertexProgram).
    this.viewPosU = { value: new THREE.Vector3() };

    const atlas = makeDetailAtlas({ anisotropy: quality.anisotropy });
    this.group = new THREE.Group();
    this.group.name = "grass";

    for (const proto of this.settings.prototypes) {
      const cap = Math.max(1, Math.round(this.capacity * proto.share));
      const billboard = proto.renderMode === "grassBillboard";
      const mat = this._makeMaterial(atlas.texture, billboard);
      const geo = makeCardGeometry(proto.atlasCell ?? 0, !billboard);
      // One instanced attribute, allocated with the mesh, written by rebuild.
      // It has to exist before first compile: a program declaring an
      // attribute the geometry does not have reads it as zero, which is a
      // field with no yaw, no phase offset and no bend at all.
      const jitter = new THREE.InstancedBufferAttribute(new Float32Array(cap * JITTER_ITEMS), JITTER_ITEMS);
      jitter.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aJitter", jitter);
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.name = "detail:" + proto.key;
      // The whole field spans the world; per-card culling is the shader's
      // distance collapse, not the frustum.
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Grass that neither casts nor receives reads as stickers laid on the
      // ground however good the blade is. Top tiers only: it doubles the
      // vegetation's draw work, once for the frame and once for the sun.
      if (quality.grassShadows && quality.shadows) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Deliberately NOT in `materials`: that list is what the engine hands
        // to Atmosphere.apply(), and aerial perspective on a depth material
        // is meaningless work at best.
        mesh.customDepthMaterial = this._makeDepthMaterial(atlas.texture, billboard);
        this._depthMaterials.push(mesh.customDepthMaterial);
      }
      // `jitter` is held here as well as on the geometry so the placement
      // loop writes straight into it — a getAttribute() per card is a map
      // lookup ninety thousand times a rebuild for an answer that cannot
      // change.
      this._meshes.push({ mesh, proto, cap, cursor: 0, jitter });
      this.materials.push(mat);
      this.group.add(mesh);
    }
    this.rebuild();
  }

  /* Unity's WavingGrass vertex program, carried over wave for wave
     (TerrainEngine.cginc): four sin⁴ waves whose phase runs on world XZ and
     the wind clock, roots pinned by the quadratic height ramp, gust crests
     lit toward the wind tint through the ×2 DOUBLE combine — a card in still
     air renders exactly its instance colour.

     The SHADOW pass has to run the identical program (see _makeDepthMaterial)
     or the shadows are cast by cards standing somewhere the visible ones are
     not — so the displacement lives here once and both materials inject it.

     It reads uViewPos rather than the built-in cameraPosition on purpose: in
     the shadow pass cameraPosition is the SUN's, and the distance collapse
     would then measure every card against the sun and shrink the entire
     field to nothing — grass that casts no shadow at all. */
  _vertexProgram(billboard) {
    return /* glsl */`
        vec4 wgOrigin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        /* ── the card's turn, for BOTH modes ──
           The crossed cards' yaw used to live in the instance quaternion. It
           lives here now so the instance matrix carries no rotation at all,
           which is what lets a world-space wind survive to the world (see the
           file header). Same convention the quaternion used — a Y rotation is
           (x·c + z·s, −x·s + z·c) — so a crossed pair lands exactly where it
           always did. */
        float wgAz = aJitter.x;
        ${billboard ? /* glsl */`
        // Cylindrical billboard: turn the card's local X to face the camera.
        // atan(0,0) is UNDEFINED in GLSL, and the camera sits exactly on a
        // card's vertical axis every time you look straight down at one — a
        // NaN there propagates through transformed and drops the whole card.
        vec2 wgLook = uViewPos.xz - wgOrigin.xz;
        wgAz = dot(wgLook, wgLook) > 1e-8 ? atan(wgLook.x, wgLook.y) : 0.0;` : ""}
        float wgC = cos(wgAz), wgS = sin(wgAz);
        transformed.xz = vec2(transformed.x * wgC + transformed.z * wgS,
                              -transformed.x * wgS + transformed.z * wgC);
        /* Stand it slightly off vertical. A field of perfectly upright cards
           reads as a printed pattern however well each card is drawn, and no
           amount of size jitter fixes it because every silhouette still has
           the same axis. The lean is linear in height so the root stays put,
           and its compass is the tuft's own phase — decorrelated from the
           yaw, and free, because the phase is already in the attribute. */
        transformed.xz += vec2(cos(aJitter.y), sin(aJitter.y)) * (aJitter.w * position.y);
        /* ── waving grass, in a wind-aligned frame ──
           Unity's four waves run on fixed world-X and world-Z frequencies, so
           the ripple always crosses the field along the same diagonal. Here
           the same frequencies run along the WIND and across it: uWindDir is
           a unit vector, uWindDir⊥ is its perpendicular, and the phase is
           taken in that frame. At direction 0 the frame is world XZ and every
           number below is Unity's, unchanged.

           aJitter.y offsets the clock per tuft. It is deliberately a small
           fraction of a cycle: enough that neighbours stop cresting on the
           same frame, not so much that the travelling gust dissolves into
           per-blade noise — the wave IS the effect. */
        vec2 wgWd = uWindDir;
        vec2 wgWp = vec2(-wgWd.y, wgWd.x);
        vec2 wgUV = vec2(dot(wgOrigin.xz, wgWd), dot(wgOrigin.xz, wgWp));
        float wgFreq = 2.0 + uWaveSize * 20.0;
        vec4 wgPhase = wgUV.x * vec4(0.012, 0.02, 0.06, 0.024) * wgFreq
                     + wgUV.y * vec4(0.006, 0.02, 0.02, 0.05) * wgFreq
                     + uWaveTime * vec4(1.2, 2.0, 1.6, 4.8)
                     + aJitter.y;
        vec4 wgS4 = sin(wgPhase); wgS4 *= wgS4; wgS4 *= wgS4;
        float wgH = position.y * position.y * uBending * aJitter.z; // roots stay planted
        /* The steady bow. Unity's displacement is symmetric about the blade's
           own axis — sin⁴ pushes and pulls and the mean is nearly zero — so a
           Unity field in a gale is agitated and never actually blown over.
           uWindLean adds a constant along the wind, inside the same wgH ramp,
           so it is proportional to the bending slider: still air (bending 0)
           still stands straight up. */
        float wgDu = dot(wgS4, vec4(0.024, 0.04, -0.12, 0.096)) + uWindLean;
        float wgDv = dot(wgS4, vec4(0.006, 0.02, -0.02, 0.1));
        transformed.xz -= (wgWd * wgDu + wgWp * wgDv) * wgH;
        float wgGust = clamp(dot(wgS4, normalize(vec4(1.0, 1.0, 0.4, 0.2))) * 0.7, 0.0, 1.0);
        // The healthy/dry instance colour is NOT multiplied here — three's own
        // USE_INSTANCING_COLOR path already folds instanceColor into vColor,
        // and doing it twice squares the linear colour into near-black.
        vDetailTint = 2.0 * mix(vec3(0.5), uWindTint, wgGust);
        // Unity's detail-distance falloff, saturate(2(D² − d²)/D²), spent on
        // scale instead of alpha: the card sinks into its root point, so the
        // cutout never has to sort.
        // max() guards the 0/0: detailDistance 0 is a legal authored value
        // (and a legal manifest one), and it would otherwise NaN every card.
        float wgD2 = max(uDetailDist * uDetailDist, 1e-4);
        vec2 wgDelta = wgOrigin.xz - uViewPos.xz;
        transformed *= clamp(2.0 * (wgD2 - dot(wgDelta, wgDelta)) / wgD2, 0.0, 1.0);
        /* ── heat ──
           Fire and plants stand on the same heightfield, so a planar
           distance IS the distance. Each fire contributes a scorch that is
           total at its centre and gone by its scorch radius; the strongest
           one wins rather than summing, so overlapping fires do not burn
           twice as black as physics allows. */
        vBurn = 0.0;
        for (int i = 0; i < ${MAX_BURN}; i++) {
          if (i >= uBurnCount) break;
          vec4 wgB = uBurn[i];
          vBurn = max(vBurn, (1.0 - smoothstep(0.0, wgB.z, distance(wgOrigin.xz, wgB.xy))) * wgB.w);
        }
        // Consumed: at the heart of the fire the blade is gone, not merely
        // black — it collapses into the ground rather than standing as ash.
        transformed *= 1.0 - smoothstep(0.62, 1.0, vBurn);`;
  }

  // The uniform block both materials need. vDetailTint/vBurn are declared as
  // varyings by the lit material and as plain locals by the depth one, which
  // has no fragment stage that wants them.
  _vertexUniforms(varying) {
    return "uniform float uWaveTime; uniform float uWaveSize; uniform float uBending;\n" +
      "uniform vec3 uWindTint; uniform float uDetailDist; uniform vec3 uViewPos;\n" +
      "uniform vec2 uWindDir; uniform float uWindLean;\n" +
      // Declared for both materials: the shadow pass runs the identical
      // program, and a card that turned in one pass and not the other casts
      // a shadow belonging to a plant standing somewhere else.
      "attribute vec4 aJitter;\n" +
      `uniform vec4 uBurn[${MAX_BURN}]; uniform int uBurnCount;\n` +
      (varying ? "varying vec3 vDetailTint; varying float vBurn;\n" : "vec3 vDetailTint; float vBurn;\n");
  }

  _bindUniforms(sh) {
    sh.uniforms.uWaveTime = this.windU;
    sh.uniforms.uWaveSize = this.sizeU;
    sh.uniforms.uBending = this.bendU;
    sh.uniforms.uWindTint = this.tintU;
    sh.uniforms.uDetailDist = this.distU;
    sh.uniforms.uViewPos = this.viewPosU;
    sh.uniforms.uWindDir = this.dirU;
    sh.uniforms.uWindLean = this.leanU;
    sh.uniforms.uBurn = this.burnU;
    sh.uniforms.uBurnCount = this.burnCountU;
  }

  _makeMaterial(map, billboard) {
    // alphaToCoverage: on the MSAA path the cutout edge dissolves over the
    // sample mask instead of cutting at one hard threshold — softer blade
    // silhouettes for free. A no-op when MSAA is off (the TAA path), where
    // the accumulated jitter does the same job.
    const mat = new THREE.MeshLambertMaterial({
      map, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: true,
    });
    mat.onBeforeCompile = (sh) => {
      this._bindUniforms(sh);
      sh.vertexShader = (this._vertexUniforms(true) + sh.vertexShader).replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n" + this._vertexProgram(billboard)
      );
      sh.fragmentShader = ("varying vec3 vDetailTint;\nvarying float vBurn;\n" + sh.fragmentShader).replace(
        "#include <color_fragment>",
        /* glsl */`#include <color_fragment>
        diffuseColor.rgb *= vDetailTint;
        // Heat kills before it chars: the ring around a fire goes drought-
        // brown first, and only the part that actually caught turns to ash.
        // Linear-space colours — this is inside the lighting pipeline.
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.11, 0.035), smoothstep(0.0, 0.55, vBurn));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.022, 0.019, 0.017), smoothstep(0.42, 1.0, vBurn));`
      ).replace(
        // Double-sided Lambert flips the normal on back faces, which would
        // unlight half the cards (normal (0,-1,0) sees no sun). Grass is lit
        // like the ground it stands on from BOTH sides — undo the flip.
        "#include <normal_fragment_begin>",
        "#include <normal_fragment_begin>\n        normal = normalize( vNormal );"
      );
    };
    return mat;
  }

  /* The shadow caster. Without it three renders the shadow pass with its own
     stock depth material, which knows nothing about the wind, the billboard
     turn or the distance collapse — so the field would cast shadows from
     cards standing bolt upright wherever the untouched instance matrices put
     them, including for grass that has visibly collapsed to nothing.

     RGBADepthPacking is what the shadow map reads; the atlas and alphaTest
     come along so the shadow is blade-shaped rather than a solid card. */
  _makeDepthMaterial(map, billboard) {
    const mat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5, side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (sh) => {
      this._bindUniforms(sh);
      sh.vertexShader = (this._vertexUniforms(false) + sh.vertexShader).replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n" + this._vertexProgram(billboard)
      );
    };
    return mat;
  }

  // In orbit the author must see every painted patch from any height, so the
  // fade is pushed past the far corner of the plate; on foot the authored
  // detailDistance applies — the Unity behaviour the export ships.
  _effectiveDistance() {
    return this._orbitView ? this.params.terrain.size * 2 : this.settings.detailDistance;
  }

  /* The waterline as the params state it, for the first build. A world with
     no water keeps y = 0, which is where the natural coastline sits by
     heightfield construction, so the bands and clearances still describe
     something real. Engine overrides this with setWaterline whenever the
     flood level moves. */
  _paramWaterline() {
    const w = this.params.water || {};
    return w.enabled ? (w.level || 0) : 0;
  }

  /* Move the waterline the placement rules are measured from, and re-seat the
     field against it. Cheap to call with no change — a flood slider is
     dragged, and re-scattering ninety thousand cards per frame is not free.
     `enabled` false means "there is no sea", which is the y = 0 coastline
     rather than "no rules": grass still must not grow in the basin a sea
     would have filled. */
  setWaterline(y, enabled = true) {
    const next = enabled ? (y || 0) : 0;
    if (next === this._waterY) return false;
    this._waterY = next;
    this.rebuild();
    return true;
  }

  get waterline() { return this._waterY; }

  /* Re-place every authored patch onto the current ground. Deterministic per
     patch (seed + patch coords), so the editor, VSight and a reload all grow
     the identical field. Returns the number of cards placed.

     ── WHAT THE BRUSH DECIDES AND WHAT THE GROUND DECIDES ──
     The dev aims the patch; the ground decides what grows inside it, and
     which of the eight species does. Every candidate point is scored against
     each prototype's own band, slope limit and moisture preference
     (detail-spec.js placementFit), and the pick is weighted by that score —
     so a patch straddling a shore fills with reeds at the bottom and heather
     at the top, and one painted up a cliff simply thins out as the grade
     rises rather than stopping along a contour.

     A point where every species scores zero is refused outright, which is
     what "altitude and water-depth exclusion" means here: there is no
     species that will grow in the sea. */
  rebuild() {
    if (!this.group) return 0;
    const s = this.settings;
    const place = s.placement;
    const patches = s.patches || [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const tint = new THREE.Color(), healthy = new THREE.Color(), dry = new THREE.Color();
    const ground = new THREE.Color();
    const h = this.sampler;
    const noiseSeed = seedChannel(this.params.seed, "detail");
    // The samplers are infinite noise, but the WORLD is a finite plate —
    // grass outside the bounds would float in the void beside it.
    const lim = this.params.terrain.size / 2 - 4;
    const waterY = this._waterY;
    /* The ground's own colour, for the tint below. The same ramp the terrain
       is vertex-coloured from, sampled at the blade's elevation — so a tuft
       standing on the sand shelf is sand-tinted and one on the moor is moor-
       tinted, out of the palette rather than out of a table. */
    const lut = paletteLut(this.palette);
    const terrainH = this.params.terrain.height;
    const rgb = new Float32Array(3);

    for (const entry of this._meshes) entry.cursor = 0;
    // Pick weights: the prototype share × its Unity density slider (0–5),
    // × how well this SPOT suits the species. The first two are constant for
    // the field; the third is why the array is refilled per candidate.
    const base = this._meshes.map((e) => e.proto.share * Math.max(e.proto.density, 0));
    const fit = new Float64Array(this._meshes.length);

    let placed = 0, wanted = 0;
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i];
      const r0 = p.r ?? GRASS_PATCH.r;
      // detailDensityScale thins the patch the way Unity's slider thins the
      // whole terrain's details.
      const n = Math.round((p.n ?? GRASS_PATCH.n) * s.detailDensityScale);
      const rng = channelRng(this.params.seed, "grass:" + i + ":" + Math.round(p.x) + ":" + Math.round(p.z));
      let tries = 0;
      for (let k = 0; k < n && tries < n * 4; k++) {
        tries++;
        wanted++;
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * r0;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (Math.abs(x) > lim || Math.abs(z) > lim) { k--; continue; }
        const y = h(x, z);
        const grade = slopeAt(h, x, z);

        // Score every species here, then pick among the ones that will grow.
        let wSum = 0;
        for (let e = 0; e < this._meshes.length; e++) {
          fit[e] = base[e] * placementFit(this._meshes[e].proto, place, { y, waterY, grade });
          wSum += fit[e];
        }
        // Nothing grows in the sea, on the cliff, or above the tree line.
        if (wSum <= 0) { k--; continue; }

        // Weighted prototype pick; a full prototype falls through to the
        // next with room so the budget is spent, not stranded.
        let pick = rng() * wSum, entry = null;
        for (let e = 0; e < this._meshes.length; e++) {
          pick -= fit[e];
          if (pick <= 0 && fit[e] > 0) { entry = this._meshes[e]; break; }
        }
        if (!entry) entry = this._meshes[this._meshes.length - 1];
        if (entry.cursor >= entry.cap) {
          // Fall through to a species that both has room AND grows here; only
          // if there is none does the budget spill to whatever has room, and
          // if nothing has room the field is full.
          entry = this._meshes.find((e, ei) => e.cursor < e.cap && fit[ei] > 0)
               || this._meshes.find((e) => e.cursor < e.cap);
          if (!entry) break;
        }
        const proto = entry.proto;

        // Unity's rule: ONE noise field per prototype (noiseSeed, noiseSpread)
        // drives both the size lerp and the dry→healthy tint — clumps read
        // taller and greener together. sizeJitter is the share of the range
        // the individual tuft owns against the clump it belongs to; width and
        // height draw separately, so a tuft is not a scaled copy of the one
        // beside it.
        const nz = valueNoise(x * proto.noiseSpread, z * proto.noiseSpread,
          (noiseSeed ^ (proto.noiseSeed | 0)) >>> 0) * 0.5 + 0.5;
        const sj = place.sizeJitter, clump = 1 - sj;
        const w = proto.minWidth + (proto.maxWidth - proto.minWidth) * (nz * clump + rng() * sj);
        const hgt = proto.minHeight + (proto.maxHeight - proto.minHeight) * (nz * clump + rng() * sj);
        /* NO ROTATION IN THE MATRIX, for either mode — the yaw rides in the
           jitter attribute and the shader applies it (see the file header).
           Scale is uniform in XZ so the shader's world-space wind survives
           the matrix unturned. */
        q.identity();
        m.compose(pos.set(x, y, z), q, scl.set(w, hgt, w));
        entry.mesh.setMatrixAt(entry.cursor, m);

        const jit = entry.jitter.array;
        const jo = entry.cursor * JITTER_ITEMS;
        jit[jo] = rng() * Math.PI * 2;                                   // yaw
        jit[jo + 1] = rng() * Math.PI * 2 * place.phaseJitter;            // wind phase / lean compass
        jit[jo + 2] = 1 + (rng() - 0.5) * 2 * place.bendJitter;           // give
        // Tilt scales with the tuft's own health: a lush blade stands up, a
        // starved one lies over. Signed by the draw, so a stand leans both
        // ways rather than all one way — the wind's lean is what does that.
        jit[jo + 3] = (rng() - 0.5) * 2 * place.tiltJitter * (1.25 - nz * 0.5);

        healthy.setHex(proto.healthyColor);
        dry.setHex(proto.dryColor);
        const shimmer = 0.94 + rng() * 0.12; // breaks the carpet look
        tint.copy(dry).lerp(healthy, nz).multiplyScalar(shimmer);
        /* ── and pull it toward the ground it stands in ──
           Health alone gives one green for the whole world: the same tuft
           reads as pasted onto a dune, a moor and a riverbank, because
           nothing about it knows what it is standing in. The palette ramp
           already answers that at this elevation, so the blade is lerped
           toward it. sRGB → linear on the way in: the LUT holds the ramp as
           bytes over 255 and this colour is bound for the lighting pipeline,
           where an undecoded ramp reads as a washed-out tuft. */
        if (place.groundTint > 0) {
          shadeInto(rgb, 0, lut, elevNorm(y, terrainH), 1);
          ground.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
          tint.lerp(ground, place.groundTint);
        }
        entry.mesh.setColorAt(entry.cursor, tint);
        entry.cursor++;
        placed++;
      }
    }

    for (const entry of this._meshes) {
      entry.mesh.count = entry.cursor;
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.jitter.needsUpdate = true;
      if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true;
    }
    this.full = placed >= this.capacity || (wanted > placed && !this._meshes.some((e) => e.cursor < e.cap));
    return placed;
  }

  // Re-read params.props.grass (wind, distances, density scale) into the live
  // uniforms. Cheap — no rebuild; the caller rebuilds when placement changed.
  applySettings() {
    if (!this.group) return;
    this.settings = resolveDetail(this.params, this.palette);
    this.sizeU.value = this.settings.wind.size;
    this.bendU.value = this.settings.wind.bending * this.settings.windStrength;
    this.tintU.value.setHex(this.settings.wind.tint);
    this.distU.value = this._effectiveDistance();
    this.dirU.value.set(...windVector(this.settings.wind.direction));
    this.leanU.value = this.settings.wind.lean;
  }

  /* Hand over the fires currently scorching the field (FireFX.burnField()).
     Only the MAX_BURN nearest to the world's fires matter visually, so a
     longer list is trimmed rather than refused. Returns true when the field
     changed, so the engine can skip a redraw when nothing moved. */
  setBurnField(field) {
    if (!this.group) return false;
    const count = Math.min((field?.length ?? 0) / 4 | 0, MAX_BURN);
    const buf = this.burnU.value;
    let changed = count !== this.burnCountU.value;
    for (let i = 0; i < count * 4; i++) {
      if (buf[i] !== field[i]) { buf[i] = field[i]; changed = true; }
    }
    this.burnCountU.value = count;
    return changed;
  }

  /* The viewer position the cards turn toward and fade against. Kept as a
     uniform rather than read from the built-in cameraPosition so the shadow
     pass — whose camera is the sun — measures the same distances the visible
     pass does. */
  setViewPosition(p) { if (this.group) this.viewPosU.value.copy(p); }

  // Orbit shows everything (authoring); walk/fly honour detailDistance.
  setViewMode(orbit) {
    this._orbitView = !!orbit;
    if (this.group) this.distU.value = this._effectiveDistance();
  }

  setSampler(sampler) { this.sampler = sampler; this.rebuild(); }
  setPalette(palette) {
    this.palette = palette;
    if (!this.group) return;
    this.settings = resolveDetail(this.params, palette);
    this.rebuild(); // healthy/dry tints are baked per instance
  }
  tick(dt) {
    if (this.group) this.windU.value += dt * (0.15 + this.settings.wind.speed * 1.7);
  }
  dispose() {
    for (const entry of this._meshes) {
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
    }
    for (const m of this._depthMaterials) m.dispose();
    this._meshes = [];
    this.materials = [];
    this._depthMaterials = [];
  }
}
