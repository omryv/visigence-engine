// Scatter: the vegetation renderer that makes density affordable.
//
// A placed prop costs one draw call per part, per placement. That is the
// right trade for a building you select, drag and re-theme — and it is the
// wrong one for a forest. At six meshes a tree, a wood of two thousand trees
// is twelve thousand draw calls and the frame is gone, which is why the
// worlds looked empty: the object budget, not the design, was setting the
// density.
//
// Here the cost is per SPECIES instead of per plant. Every oak in the world
// shares one geometry and one material, so a thousand of them is six draw
// calls — the same six whether there are ten or ten thousand. That is the
// whole point: it moves the ceiling from hundreds of plants to tens of
// thousands, and everything the templates do downstream depends on it.
//
// What the instances still get individually, because a forest of identical
// clones is its own kind of tell:
//   · position, yaw and scale, from the record;
//   · a per-instance colour, so no two plants are quite the same green;
//   · WIND — foliage leans on the same clock the grass does, trunks do not;
//   · HEAT — the burn field from engine/fx/fire.js chars them where a fire
//     has been, exactly as it chars the grass.
//
// Records live in params.props.scatter, so a scattered world is still just
// params: it reloads identically, rides into VSight, and exports.

import * as THREE from "three";
import { channelRng } from "../../kernel/seed.js";
import { cullSpecies, speciesRadius, shadowThrow } from "./scatter-cull.js";

// Matches the grass system's cap, and for the same reason: the shader loops
// this many times per vertex whether or not anything is alight.
const MAX_BURN = 12;

/* Which parts of a plant move in the wind. The trunk is rigid, the canopy is
   not, and the difference is most of what sells it — a tree swaying as one
   rigid lollipop looks worse than a tree not swaying at all. Keyed off the
   part's own texture role, which already carries the semantics. */
function swayOf(part) {
  if (part.tex === "foliage") return 1;
  if (part.tex === "wood" || part.tex === "board") return 0.12; // a trunk gives a little
  return 0.35;
}

export class Scatter {
  constructor({ params, sampler, quality, atmos, procOf }) {
    this.params = params;
    this.sampler = sampler;
    this.atmos = atmos;
    this.procOf = procOf;
    this.group = new THREE.Group();
    this.group.name = "scatter";
    this.materials = [];
    this._batches = [];      // { mesh, sway, species, src, srcColor }
    this._protos = new Map(); // id → [{ geometry, material, matrix, sway }]
    this._shadows = !!quality.shadows;
    /* Per SPECIES, not per batch: one visibility answer shared by every part
       of a plant. Deciding it per batch would let a canopy survive a frame its
       trunk did not. */
    this._species = new Map(); // id → { origins, radii, count, order, visible }
    this._drawDist = quality.scatterDistance ?? 600;
    this._cullPos = new THREE.Vector3(Infinity, 0, 0);
    this._cullFrustum = new THREE.Frustum();
    this._cullMatrix = new THREE.Matrix4();
    this._planes = new Float32Array(24);
    this._visibleTotal = 0;

    this.windU = { value: 0 };
    this.swayU = { value: 1 };
    this.burnU = { value: new Float32Array(MAX_BURN * 4) };
    this.burnCountU = { value: 0 };
  }

  /* The parts of one species, resolved once. Built through the ordinary
     prop builder so a scattered oak is the SAME geometry and material as one
     placed by hand from the dock — there is no second tree implementation to
     drift from the first. */
  _prototype(id, buildProc) {
    if (this._protos.has(id)) return this._protos.get(id);
    const proc = this.procOf(id);
    if (!proc?.parts) { this._protos.set(id, null); return null; }
    const object = buildProc(proc, id);
    const parts = [];
    let i = 0;
    object.traverse((o) => {
      if (!o.isMesh) return;
      o.updateMatrix();
      /* How far this part reaches from the PLANT's origin, which is what the
         cull needs — the part's own bounding sphere plus how far its offset
         carries it. Measured once per species here rather than per instance,
         since every instance is the same plant at a different scale. */
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere;
      const centre = bs ? bs.center.clone().applyMatrix4(o.matrix) : new THREE.Vector3();
      const partScale = new THREE.Vector3().setFromMatrixScale(o.matrix);
      const spread = Math.max(partScale.x, partScale.y, partScale.z);
      parts.push({
        geometry: o.geometry,
        // Cloned: this material gets a wind and heat program injected, and
        // the hand-placed props share the cached original.
        material: o.material.clone(),
        matrix: o.matrix.clone(),
        sway: swayOf(proc.parts[i] || {}),
        offset: centre.length(),
        radius: (bs?.radius ?? 0) * spread,
      });
      i++;
    });
    this._protos.set(id, parts);
    return parts;
  }

  /* Rebuild every batch from the record list. Records are grouped by species
     first, so each species ends up as one InstancedMesh per part. */
  setRecords(records, buildProc) {
    this._drop();
    if (!records?.length) return 0;

    const byId = new Map();
    for (const r of records) {
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id).push(r);
    }

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3(), scl = new THREE.Vector3(), tint = new THREE.Color();
    const part = new THREE.Matrix4();
    let placed = 0;

    for (const [id, list] of byId) {
      const parts = this._prototype(id, buildProc);
      if (!parts) continue;
      const rng = channelRng(this.params.seed, "scatter:" + id);
      /* The cull's view of this species: where every plant stands and how far
         it reaches. Kept beside the batches rather than read back off the GPU
         buffers, because those buffers get COMPACTED — after the first cull
         they no longer hold instance k at slot k, and there would be nothing
         left to cull from a second time. */
      const n = list.length;
      const protoR = speciesRadius(parts);
      const species = {
        origins: new Float32Array(n * 3),
        radii: new Float32Array(n),
        count: n,
        order: new Int32Array(n),
        visible: n,
        maxRadius: 0,
      };
      for (let k = 0; k < n; k++) {
        const r = list[k];
        species.origins[k * 3] = r.x;
        species.origins[k * 3 + 1] = r.y ?? this.sampler(r.x, r.z);
        species.origins[k * 3 + 2] = r.z;
        const rad = protoR * (r.scale || 1);
        species.radii[k] = rad;
        if (rad > species.maxRadius) species.maxRadius = rad;
        species.order[k] = k;
      }
      this._species.set(id, species);

      for (const p of parts) {
        const mesh = new THREE.InstancedMesh(p.geometry, this._material(p), list.length);
        mesh.name = "scatter:" + id;
        mesh.castShadow = this._shadows;
        mesh.receiveShadow = this._shadows;
        // The field spans the world and the instances are spread across it,
        // so the bounding sphere of the batch is meaningless for culling.
        mesh.frustumCulled = false;
        for (let k = 0; k < list.length; k++) {
          const r = list[k];
          const y = r.y ?? this.sampler(r.x, r.z);
          q.setFromAxisAngle(up, r.rotationY || 0);
          const s = r.scale || 1;
          m.compose(pos.set(r.x, y, r.z), q, scl.set(s, s, s));
          // The placement transform, then the part's own offset inside the
          // plant — composed here so the batch needs no scene-graph parent.
          mesh.setMatrixAt(k, part.copy(m).multiply(p.matrix));
        }
        // The uncompacted truth. mesh.instanceMatrix is the working copy the
        // cull writes a subset into; this is what it reads from.
        const src = new Float32Array(mesh.instanceMatrix.array);
        this._batches.push({ mesh, sway: p.sway, species: id, src, srcColor: null });
        this.materials.push(mesh.material);
        this.group.add(mesh);
      }
      // One colour per PLANT, shared by its parts, so a tree's canopy and
      // trunk are lit as the same individual.
      const tints = list.map(() => {
        const l = 0.86 + rng() * 0.3;
        return tint.setRGB(l * (0.96 + rng() * 0.08), l, l * (0.94 + rng() * 0.1)).clone();
      });
      for (const b of this._batches) {
        if (b.mesh.name !== "scatter:" + id) continue;
        for (let k = 0; k < tints.length; k++) b.mesh.setColorAt(k, tints[k]);
        if (b.mesh.instanceColor) {
          b.mesh.instanceColor.needsUpdate = true;
          // Colours are per plant and get compacted alongside the matrices,
          // or a culled frame would hand a tree its neighbour's green.
          b.srcColor = new Float32Array(b.mesh.instanceColor.array);
        }
      }
      placed += list.length;
    }
    for (const b of this._batches) b.mesh.instanceMatrix.needsUpdate = true;
    this._total = placed;
    this._visibleTotal = placed;
    return placed;
  }

  /* ── the cull ──
     Rebuild each batch's instance buffer from the plants that are actually
     worth drawing. Returns true when the visible set changed, so the engine
     can invalidate; returns false — having done nothing — when the camera has
     not moved enough to change the answer, which is most frames in an editor.

     `shadowCentre`/`shadowRadius` describe the shadow volume: everything
     inside it is kept regardless of the frustum, because it can cast into
     view from behind the camera. See scatter-cull.js. */
  cull(camera, { sunDir = null, shadowRadius = 0, force = false } = {}) {
    if (!this._batches.length) return false;
    // A metre of camera travel cannot change what is visible at 600 m, and
    // this runs on the same frames the terrain and the props already walk.
    if (!force && this._cullPos.distanceToSquared(camera.position) < 1) return false;
    this._cullPos.copy(camera.position);

    camera.updateMatrixWorld();
    this._cullMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._cullFrustum.setFromProjectionMatrix(this._cullMatrix);
    for (let i = 0; i < 6; i++) {
      const pl = this._cullFrustum.planes[i];
      this._planes[i * 4] = pl.normal.x;
      this._planes[i * 4 + 1] = pl.normal.y;
      this._planes[i * 4 + 2] = pl.normal.z;
      this._planes[i * 4 + 3] = pl.constant;
    }

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const sunX = sunDir?.x ?? 0, sunY = sunDir?.y ?? 0, sunZ = sunDir?.z ?? 0;
    const cap = this._shadows ? shadowRadius : 0;

    /* The draw distance opens up with altitude, for the same reason the
       shadow volume does: from a framing orbit the whole world is the
       subject, and a fixed ground-level distance would cull the far half of
       it out of the shot. On foot — which is where the frame budget actually
       matters — the tier's own number stands. */
    const groundY = this.sampler ? this.sampler(cx, cz) : 0;
    const drawDist = Math.max(this._drawDist, Math.max(0, cy - groundY) * 2.2);

    let changed = false, total = 0;
    const thr = this._throw || (this._throw = new Float64Array(3));
    for (const [id, s] of this._species) {
      // Per species, because a fern and an oak do not throw the same shadow
      // and sweeping every plant by the tallest one's reach would keep half
      // the world for the sake of the ferns.
      shadowThrow(thr, s.maxRadius * 2, sunX, sunY, sunZ, cap);
      const vis = cullSpecies(s.order, s.origins, s.radii, s.count, this._planes,
        cx, cy, cz, drawDist, thr[0], thr[1], thr[2]);
      total += vis;
      if (vis !== s.visible) changed = true;
      s.visible = vis;
      for (const b of this._batches) {
        if (b.species !== id) continue;
        const dst = b.mesh.instanceMatrix.array, src = b.src;
        for (let j = 0; j < vis; j++) {
          const from = s.order[j] * 16, to = j * 16;
          for (let e = 0; e < 16; e++) dst[to + e] = src[from + e];
        }
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.srcColor && b.mesh.instanceColor) {
          const cd = b.mesh.instanceColor.array, cs = b.srcColor;
          for (let j = 0; j < vis; j++) {
            const from = s.order[j] * 3, to = j * 3;
            cd[to] = cs[from]; cd[to + 1] = cs[from + 1]; cd[to + 2] = cs[from + 2];
          }
          b.mesh.instanceColor.needsUpdate = true;
        }
        b.mesh.count = vis;
      }
    }
    this._visibleTotal = total;
    return changed;
  }

  /* Wind and heat, injected into the species material. The wind is the same
     traveling-gust model the grass runs, at a much lower frequency and
     amplitude — a canopy answers a gust slowly and a blade answers it at
     once, and matching the two rates is what makes them look like the same
     weather. */
  _material(part) {
    const mat = part.material;
    mat.vertexColors = false; // the batch tints per instance, not per vertex
    const swayU = { value: part.sway };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uScTime = this.windU;
      sh.uniforms.uScSway = swayU;
      sh.uniforms.uScStrength = this.swayU;
      sh.uniforms.uScBurn = this.burnU;
      sh.uniforms.uScBurnCount = this.burnCountU;
      sh.vertexShader = ("uniform float uScTime; uniform float uScSway; uniform float uScStrength;\n" +
        `uniform vec4 uScBurn[${MAX_BURN}]; uniform int uScBurnCount; varying float vScBurn;\n` +
        sh.vertexShader).replace(
        "#include <begin_vertex>",
        /* glsl */`#include <begin_vertex>
        vec3 scOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        // Gusts travel across the world rather than everything breathing in
        // unison — the phase runs on world position, so a wood ripples.
        float scPh = scOrigin.x * 0.021 + scOrigin.z * 0.017;
        float scGust = sin(uScTime * 0.55 + scPh) * 0.62
                     + sin(uScTime * 1.13 + scPh * 2.3 + 1.1) * 0.27
                     + sin(uScTime * 2.7 + scPh * 0.7) * 0.11;
        // Higher parts move more: the lean is taken about the plant's base,
        // which is where transformed.y already measures from.
        float scLean = uScSway * uScStrength * 0.055 * max(transformed.y, 0.0);
        transformed.x += scGust * scLean;
        transformed.z += scGust * scLean * 0.7;
        // Heat, on the same field the grass burns from (engine/fx/fire.js).
        vScBurn = 0.0;
        for (int i = 0; i < ${MAX_BURN}; i++) {
          if (i >= uScBurnCount) break;
          vec4 b = uScBurn[i];
          vScBurn = max(vScBurn, (1.0 - smoothstep(0.0, b.z, distance(scOrigin.xz, b.xy))) * b.w);
        }`
      );
      sh.fragmentShader = ("varying float vScBurn;\n" + sh.fragmentShader).replace(
        "#include <color_fragment>",
        /* glsl */`#include <color_fragment>
        // Scorched, then charred — the same two-stage ramp the grass uses,
        // so a burnt wood and the burnt ground under it agree.
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.09, 0.03), smoothstep(0.0, 0.5, vScBurn));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.026, 0.023), smoothstep(0.4, 1.0, vScBurn));`
      );
    };
    mat.needsUpdate = true;
    return mat;
  }

  // The fires currently scorching the world (FireFX.burnField()).
  setBurnField(field) {
    if (!this._batches.length) return false;
    const count = Math.min(((field?.length ?? 0) / 4) | 0, MAX_BURN);
    const buf = this.burnU.value;
    let changed = count !== this.burnCountU.value;
    for (let i = 0; i < count * 4; i++) {
      if (buf[i] !== field[i]) { buf[i] = field[i]; changed = true; }
    }
    this.burnCountU.value = count;
    return changed;
  }

  /* The plants in the world, which is NOT the plants being drawn — reading
     the first batch's live count would have started reporting the culled
     figure the moment culling landed, and `count` is what the editor's
     readouts and the world's own bookkeeping mean by "how much is planted". */
  get count() { return this._total || 0; }
  get visible() { return this._visibleTotal; }
  get drawCalls() { return this._batches.length; }
  get drawDistance() { return this._drawDist; }

  tick(dt) { if (this._batches.length) this.windU.value += dt; }
  setSampler(sampler) { this.sampler = sampler; }

  _drop() {
    for (const b of this._batches) {
      this.group.remove(b.mesh);
      b.mesh.dispose();          // the per-instance buffers; geometry is the prototype's
    }
    this._batches = [];
    this.materials = [];
    this._species.clear();
    this._total = 0;
    this._visibleTotal = 0;
    this._cullPos.set(Infinity, 0, 0);   // the next cull must actually run
  }

  dispose() {
    this._drop();
    for (const parts of this._protos.values()) {
      for (const p of parts || []) p.material.dispose();
    }
    this._protos.clear();
  }
}
