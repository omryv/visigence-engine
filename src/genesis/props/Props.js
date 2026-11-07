// Prop placement: streamed GLBs, cached by URL, cloned per placement.
// Each placement is a serializable record { uid, ref, url, label, position,
// rotationY, scale } — the uid is minted by the contract layer (fusion.js)
// and stays stable so a Unity reimport UPDATES an object instead of
// duplicating it. Raw GLB bytes are retained for embedding in exports.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { blockMaps } from "./textures.js";
import { valueNoise } from "../../kernel/terrain/noise.js";

export class Props {
  constructor({ sampler, onChange, decorate, doors = null, blockers = null, lamps = null,
                fittings = null, onAdd = null }) {
    this.sampler = sampler;
    this.onChange = onChange || (() => {});
    this.onAdd = onAdd; // engine hook: a placement just landed (splash checks)
    this.decorate = decorate || ((m) => m); // engine hook: shared atmosphere
    this.doors = doors;       // interactive-door registry (engine/props/doors.js)
    this.fittings = fittings; // everything else you can use (engine/props/fittings.js)
    this.blockers = blockers; // walk-mode collision (engine/player/collide.js)
    this.lamps = lamps;       // real-light pool for parts that declare one (fx/lamps.js)
    this.theme = null; // active structure theme (themes.js) — dresses proc builds
    this.group = new THREE.Group();
    this.group.name = "props";
    this.loader = new GLTFLoader();
    this._byteCache = new Map();   // url → Promise<ArrayBuffer>
    this._sceneCache = new Map();  // url → Promise<THREE.Object3D>
    this.items = new Map();        // uid → { record, object, bytesKey }
    this._importBytes = new Map(); // bytesKey → ArrayBuffer (drag-drop imports)
    /* ── authoring state ──
       Hidden and locked are the author's view of the world, not the world:
       a hidden block still exports, still plays and still walks like a wall,
       exactly as a door left open in the editor is still a door. So neither
       ever touches the record — records() would carry them into fusion, into
       the Unity package and into VSight, and a world would come back with
       holes in it. Kept per uid rather than on the item so an undone delete
       restores the block still hidden, still locked. Entries exist only
       while they say something: default state deletes itself. */
    this._state = new Map();       // uid → { hidden, locked }
    // Shared part resources — see sharedGeometry/sharedMaterial. Held per
    // Props instance, NOT module-level: decorate() closes over one engine's
    // Atmosphere uniforms, so a material cached by one engine must never be
    // handed to another.
    this._parts = { geo: new Map(), mat: new Map() };
    /* ── bulk mode ──
       A world build adds three thousand placements in one go, and every
       add used to announce itself: the shell rebuilt its whole object
       register per record, which is O(n²) over the build and was the single
       reason a world took three minutes instead of three seconds. Between
       beginBulk and endBulk the announcement carries a `bulk` flag, so the
       engine keeps rendering (you watch the city appear) and everything that
       reads the WHOLE world defers to one call at the end. */
    this._bulk = 0;
  }

  setSampler(sampler) {
    this.sampler = sampler;
    for (const [uid, { record, object }] of this.items) {
      // Point-seated placements (stacked blocks, bridge decks, hung walkways,
      // upper-floor furniture) hold their authored height — only terrain-seated
      // props follow the ground.
      if (record.seat === "point") continue;
      object.position.y = this._groundY(record.position[0], record.position[2], object);
      record.position[1] = object.position.y;
      this._registerPhysical(uid, object, record); // the ground moved under it
    }
    // Every placement's height just changed, which means every marker, every
    // pin and every coordinate in the editor's own register is stale. One
    // announcement for the whole re-seat, not one per placement.
    if (this.items.size) this._changed();
  }

  beginBulk() { this._bulk++; }
  endBulk() { if (this._bulk > 0 && --this._bulk === 0) this.onChange(); }
  _changed() { this.onChange(this._bulk > 0 ? { bulk: true } : undefined); }

  async _bytes(url) {
    if (!this._byteCache.has(url)) {
      this._byteCache.set(url, fetch(url).then((r) => {
        if (!r.ok) throw new Error(`GLB fetch failed: ${r.status} ${url}`);
        return r.arrayBuffer();
      }));
    }
    return this._byteCache.get(url);
  }

  async _template(url, bytes) {
    const key = url || `import:${hashBytes(bytes)}`;
    if (!this._sceneCache.has(key)) {
      this._sceneCache.set(key, (async () => {
        const buf = bytes || (await this._bytes(url));
        const gltf = await new Promise((res, rej) => this.loader.parse(buf, "", res, rej));
        const scene = gltf.scene || gltf.scenes[0];
        scene.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true; o.receiveShadow = true;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.decorate(m);
        });
        return scene;
      })());
    }
    return { key, template: await this._sceneCache.get(key) };
  }

  // Construct (but do not register) the object for a record: proc parts are
  // assembled locally, GLBs stream from cache/CDN. Shared by add() and the
  // engine's held-block ghost. Note GLB clones SHARE the template's materials.
  async build(record, bytes = null) {
    if (record.proc?.parts) {
      // Parts come from the shared cache; buildProcObject stamps per-mesh
      // ownership so disposeBuilt() knows what is actually ours.
      return buildProcObject(record.proc, this.decorate, record.uid || record.ref || "",
                             this.theme, record.tint, record.style, this._parts);
    }
    const { key, template } = await this._template(record.url, bytes);
    if (bytes) this._importBytes.set(key, bytes);
    record.bytesKey = key;
    const obj = template.clone(true);
    // GLB clones borrow the template's geometry AND materials; a per-placement
    // tint clones the materials, and tintObject flags those as ours.
    if (record.tint) tintObject(obj, record.tint);
    return obj;
  }

  /* One built copy of a block, for something that is going to render it
     itself — the scatter batcher takes the geometry and materials out of
     this and instances them. Built through the SAME path a placement takes,
     so a scattered oak and a hand-placed one are the same object; a second
     builder would be a second tree that drifts from the first.

     `key` stands in for the uid: it picks the luminance bucket, so passing
     the species id gives every batch of that species one stable dressing. */
  buildProcPrototype(proc, key = "") {
    return buildProcObject(proc, this.decorate, key, this.theme, null, null, this._parts);
  }

  // The active structure theme re-dresses every proc placement in place.
  // GLBs keep their authored materials (per-placement tint still applies).
  setTheme(theme) {
    this.theme = theme || null;
    for (const uid of [...this.items.keys()]) {
      if (this.items.get(uid)?.record.proc) this.restyle(uid);
    }
  }

  // Rebuild a placement's object with current theme + record tint, keeping
  // its exact transform (no re-seating). Sync for proc, async for GLBs.
  async restyle(uid) {
    const it = this.items.get(uid);
    if (!it) return;
    let fresh;
    try {
      fresh = await this.build(it.record, it.record.proc ? null : this._importBytes.get(it.record.bytesKey) || null);
    } catch (err) {
      console.warn("[props] restyle failed:", err.message);
      return;
    }
    if (this.items.get(uid) !== it) return; // deleted mid-flight
    fresh.userData.uid = uid;
    fresh.traverse((o) => { o.userData.uid = uid; });
    fresh.position.copy(it.object.position);
    fresh.rotation.copy(it.object.rotation);
    fresh.scale.copy(it.object.scale);
    this.group.remove(it.object);
    disposeBuilt(it.object); // the old dressing is replaced, not reused
    this.group.add(fresh);
    it.object = fresh;
    this._measure(it);
    this._applyState(uid);
    this._registerPhysical(uid, fresh, it.record);
    this._changed();
  }

  // Add a placement. `bytes` only for drag-drop imports (no URL).
  // Falls back to a placeholder primitive if the GLB can't stream, so the
  // dock keeps working offline.
  async add(record, bytes = null) {
    let object;
    try {
      object = await this.build(record, bytes);
    } catch (err) {
      console.warn("[props] stream failed, placeholder used:", err.message);
      object = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        this.decorate(new THREE.MeshStandardMaterial({ color: 0xb8a6f5, roughness: 0.6 }))
      );
      object.userData.ownGeo = object.userData.ownMat = true; // its own fallback primitive
      record.placeholder = true;
    }
    object.userData.uid = record.uid;
    object.traverse((o) => { o.userData.uid = record.uid; });
    this._applyTransform(object, record);
    // A declared real-world size (record.fit, metres) fits strictly, so a
    // catalog prop lands at believable first-person scale; imports without
    // one only get rescued from absurd extremes.
    if (record.autoFit) this.autoFit(object, record, record.fit || 6, !!record.fit);
    // seat:"point" = the caller already picked the surface (stacking on a
    // block, a composed deck); anything else seats on the terrain. The flag
    // STAYS on the record — it must survive serialization, or every re-seat
    // (sculpt commit, erosion, VSight boot) collapses the piece onto the
    // terrain it was deliberately held above.
    const baseY = record.seat === "point" ? record.position[1] : null;
    if (record.seat !== "point") delete record.seat;
    object.position.y = record.position[1] = this._groundY(record.position[0], record.position[2], object, baseY);
    this.group.add(object);
    const it = { record, object };
    this.items.set(record.uid, it);
    this._measure(it);
    this._applyState(record.uid);
    this._registerPhysical(record.uid, object, record);
    this.onAdd?.(record, object);
    this._changed();
    return object;
  }

  /* ── the size of a placement, held rather than re-derived ──
     Every discovery cue in the editor needs to know how big a thing is: the
     pin fade compares it against the screen, the ripple is scaled from it,
     the camera frames on it. Box3.setFromObject walks every mesh under the
     object, so asking per frame — for thousands of placements — is not
     affordable. It is asked once, when the object's SHAPE changes (built,
     rescaled, restyled), and both figures are stored relative to the
     object's own origin so that moving or re-seating it changes nothing. */
  _measure(it) {
    const box = new THREE.Box3().setFromObject(it.object);
    if (!isFinite(box.min.y) || !isFinite(box.max.y)) { it.size = 2; it.hAbove = 2; it.hBelow = 0; return; }
    const s = box.getSize(new THREE.Vector3());
    it.size = Math.max(s.x, s.y, s.z, 0.25);
    it.hAbove = box.max.y - it.object.position.y;
    it.hBelow = it.object.position.y - box.min.y;
  }
  // Size + anchors in world space: where the mark goes, and how big it is.
  anchor(uid) {
    const it = this.items.get(uid);
    if (!it) return null;
    const p = it.object.position;
    return {
      uid, x: p.x, z: p.z,
      y: p.y - (it.hBelow || 0),        // where it meets the ground
      top: p.y + (it.hAbove || 2),      // where it stops
      size: it.size || 2, label: it.record.label || "Block",
    };
  }

  /* ── hidden / locked ──
     Hidden takes the object out of the picture and out of every pick;
     locked leaves it visible but refuses selection and refuses the gizmo, so
     a finished terrace can be built against without being nudged. */
  setVisible(uid, on) {
    if (!this.items.has(uid)) return false;
    this._setState(uid, { hidden: !on });
    this._applyState(uid);
    this._changed();
    return true;
  }
  setLocked(uid, on) {
    if (!this.items.has(uid)) return false;
    this._setState(uid, { locked: !!on });
    return true;
  }
  isVisible(uid) { return !this._state.get(uid)?.hidden; }
  isLocked(uid) { return !!this._state.get(uid)?.locked; }
  _setState(uid, patch) {
    const next = { hidden: false, locked: false, ...(this._state.get(uid) || {}), ...patch };
    if (!next.hidden && !next.locked) this._state.delete(uid);
    else this._state.set(uid, next);
  }
  _applyState(uid) {
    const it = this.items.get(uid);
    if (it) it.object.visible = !this._state.get(uid)?.hidden;
  }

  /* What a ray is allowed to hit. Hidden placements are not in the world as
     far as the pointer is concerned; locked ones still stop a ray when
     something is being STACKED on them (you build against a locked wall) but
     never when something is being selected. */
  pickTargets({ includeLocked = false } = {}) {
    const out = [];
    for (const [uid, it] of this.items) {
      const st = this._state.get(uid);
      if (st?.hidden) continue;
      if (st?.locked && !includeLocked) continue;
      out.push(it.object);
    }
    return out;
  }

  /* ── physical presence ──
     Doors and collision are derived from the built object, never authored on
     the record: a placement stays pure data. Only procedural blocks get
     collision boxes — a streamed GLB can hold thousands of meshes, and one
     coarse box around a building would wall off its own interior. */
  _registerPhysical(uid, object, record) {
    this.doors?.register(uid, object);
    /* …and whatever else the placement says you can do with it. The record
       carries the verb (js/affordance.js writes it, js/interiors.js hangs it
       on), so this layer never learns that a chair is a chair. */
    this.fittings?.register(uid, object, record);
    // Lights are re-read here rather than at add() alone, so a lamp that is
    // dragged to the other side of the room lights the other side of the room.
    this.lamps?.register(uid, object);
    if (!this.blockers) return;
    if (!record.proc) { this.blockers.remove(uid); return; }
    /* THE BOXES ARE TAKEN IN THE PLACEMENT'S OWN FRAME, not the world's.
       They used to be world-axis-aligned, which for anything turned off the
       compass is not a description of the object but a description of the
       rectangle it fits inside: a six-metre wall at seventeen degrees became
       a 6.2 × 2.2 m slab of solid air, and a building standing at an angle
       was wrapped in an invisible shell a metre and a half thick on every
       side. You could see its front door and never reach it. Every angled
       building in this project was impassable and nothing said so, because
       the geometry was right and only the collision was wrong.

       So the group is briefly straightened, the boxes are read in its own
       axes, and the rotation goes to the blocker to undo per query. Exact
       for the axis-aligned parts everything here is made of, and no more
       expensive than before at rest — this runs on placement, not on frame. */
    const rot = object.rotation.y;
    const px = object.position.x, pz = object.position.z;
    object.rotation.y = 0;
    object.position.set(0, object.position.y, 0);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const boxes = [];
    object.traverse((o) => {
      if (!o.isMesh || o.userData.noCollide) return;
      box.setFromObject(o);
      if (!isFinite(box.min.x)) return;
      boxes.push({
        minX: box.min.x, maxX: box.max.x,
        minZ: box.min.z, maxZ: box.max.z,
        minY: box.min.y, maxY: box.max.y,
        door: !!o.userData.doorLeaf,
      });
    });
    object.rotation.y = rot;
    object.position.set(px, object.position.y, pz);
    object.updateMatrixWorld(true);
    this.blockers.set(uid, boxes, { x: px, z: pz, rot });
  }

  _forgetPhysical(uid) {
    this.doors?.unregister(uid);
    this.fittings?.unregister(uid);
    this.lamps?.forget(uid);
    this.blockers?.remove(uid);
  }

  _applyTransform(object, record) {
    object.position.set(...record.position);
    object.rotation.set(0, record.rotationY || 0, 0);
    const s = record.scale || 1, st = record.stretch;
    if (st) object.scale.set(s * st[0], s * st[1], s * st[2]);
    else object.scale.setScalar(s);
  }

  // Seat: the base of the (scaled) bounding box rests on `baseY`, or on the
  // terrain when no explicit surface is given. `baseY` is how a block stacks
  // flush on top of another block instead of sinking to the ground.
  _groundY(x, z, object, baseY = null) {
    const box = new THREE.Box3().setFromObject(object);
    const lift = object.position.y - box.min.y;
    return (baseY == null ? this.sampler(x, z) : baseY) + (isFinite(lift) ? lift : 0);
  }

  // strict: always scale to exactly `target` metres (bounding diagonal).
  // Loose (default): only rescue models that are absurdly off-scale.
  autoFit(object, record, target = 6, strict = false) {
    const box = new THREE.Box3().setFromObject(object);
    const dim = box.getSize(new THREE.Vector3()).length();
    if (dim > 1e-6 && (strict || dim > target * 4 || dim < target * 0.1)) {
      record.scale = (target / dim) * (record.scale || 1);
      this._applyTransform(object, record); // keeps any stretch intact
    }
    delete record.autoFit;
  }

  // Pull the record's position from the live object — the write-back half of
  // gizmo (TransformControls) moves, where three mutates the object directly.
  syncFromObject(uid) {
    const it = this.items.get(uid);
    if (!it) return;
    const p = it.object.position;
    it.record.position = [p.x, p.y, p.z];
    this._registerPhysical(uid, it.object, it.record); // moved → new footprint
    this._changed();
  }

  update(uid, patch) {
    const it = this.items.get(uid);
    if (!it) return;
    /* A changed tint or texture style means new materials — rebuild in place.
       So does a changed `proc`, and that one was missing: the new spec was
       copied onto the record by the Object.assign below and then nothing ever
       built from it, so the record and the object on screen disagreed for the
       rest of the session. The visible cost was the households — a figure's
       pose IS its part list, so changing pose changed `proc` and moved
       nothing. They slid around their rooms in one posture all day.
       restyle() already rebuilds from `it.record`, proc included, so naming
       the field here is the whole fix. */
    const rebuild =
      ("tint" in patch && JSON.stringify(patch.tint || null) !== JSON.stringify(it.record.tint || null)) ||
      ("style" in patch && (patch.style || null) !== (it.record.style || null)) ||
      ("proc" in patch && JSON.stringify(patch.proc || null) !== JSON.stringify(it.record.proc || null));
    Object.assign(it.record, patch);
    if ("tint" in patch && !patch.tint) delete it.record.tint;
    if ("style" in patch && !patch.style) delete it.record.style;
    if ("stretch" in patch && (!patch.stretch || patch.stretch.every((v) => Math.abs(v - 1) < 1e-6))) {
      delete it.record.stretch;
    }
    this._applyTransform(it.object, it.record);
    // Only an explicit snap re-seats on the ground — a position patch keeps
    // its Y so gizmo lifts and nudges aren't yanked back down.
    if (patch.snap) {
      delete it.record.seat; // dropping to ground is an explicit return to terrain seating
      it.object.position.y = it.record.position[1] = this._groundY(it.record.position[0], it.record.position[2], it.object);
    }
    if (rebuild) this.restyle(uid);
    else { this._measure(it); this._registerPhysical(uid, it.object, it.record); }
    this._changed();
  }

  // Re-add a placement from its serialized record — the undo path for a
  // delete. Imported GLBs keep working because their bytes are still in the
  // import cache under the same key.
  restore(record) {
    const r = { ...record, position: [...record.position] };
    const bytes = r.url || r.proc ? null : this._importBytes.get(r.bytesKey) || null;
    const y = r.position[1];
    return this.add(r, bytes).then((obj) => {
      obj.position.y = r.position[1] = y; // exactly where it was, not re-seated
      this._registerPhysical(r.uid, obj, r); // collision must follow the restored height
      this._changed();
      return obj;
    });
  }

  // Clone a placement under a fresh uid, seated beside the original (offset
  // by its own footprint so the copy never lands inside it). Reuses the
  // cached template/bytes — no refetch.
  async duplicate(uid, newUid) {
    const it = this.items.get(uid);
    if (!it) return null;
    const r = { ...it.record, uid: newUid, position: [...it.record.position] };
    delete r.placeholder;
    const box = new THREE.Box3().setFromObject(it.object);
    r.position[0] += Math.max(box.max.x - box.min.x, 2) + 0.6;
    const y = it.record.position[1];
    const bytes = r.url || r.proc ? null : this._importBytes.get(r.bytesKey) || null;
    const obj = await this.add(r, bytes);
    // Keep the original's height: duplicating a lifted block must not slam
    // the copy to the ground (stacked builds depend on it).
    obj.position.y = r.position[1] = y;
    this._registerPhysical(newUid, obj, r); // collision must follow the kept height
    this._changed();
    return obj;
  }

  remove(uid) {
    const it = this.items.get(uid);
    if (!it) return;
    this.group.remove(it.object);
    disposeBuilt(it.object);
    this.items.delete(uid);
    this._forgetPhysical(uid);
    this._changed();
  }

  get(uid) { return this.items.get(uid); }

  // Serializable records — what fusion.js versions and Unity imports.
  records() { return [...this.items.values()].map(({ record }) => ({ ...record })); }

  // Raw GLB bytes per distinct asset actually placed (for embedding in exports).
  async assetBytes() {
    const out = new Map();
    for (const { record } of this.items.values()) {
      if (record.placeholder || record.proc || out.has(record.bytesKey)) continue;
      const buf = record.url ? await this._bytes(record.url) : this._importBytes.get(record.bytesKey);
      if (buf) out.set(record.bytesKey, buf);
    }
    return out;
  }

  clear() {
    for (const uid of [...this.items.keys()]) this.remove(uid);
    this._state.clear(); // a world with no placements has nothing hidden in it
  }

  /* ── near-field culling ──
     A building's interior is drawn even though its own walls hide it: three
     frustum-culls, it does not occlusion-cull, so a district's worth of
     furniture is a district's worth of draw calls nobody can see. Pieces
     whose ref carries `prefix` are hidden until the camera is close enough to
     be in the room with them.

     HIDING, NOT REMOVING. The record stays, the object stays in the scene
     graph, the blocker stays registered — so an interior piece is still
     selectable, movable and undoable exactly like any other placement, which
     is the whole point of building interiors out of records. Removing them
     would be cheaper and would break editing. */
  cullNear(camera, { prefix = "interior/", range = 30 } = {}) {
    if (!this._cullPos) this._cullPos = new THREE.Vector3(Infinity, 0, 0);
    // Re-deciding every frame is wasted work; the answer only changes when
    // the camera has actually gone somewhere.
    if (this._cullPos.distanceToSquared(camera.position) < 4) return false;
    this._cullPos.copy(camera.position);
    const r2 = range * range;
    let changed = false;
    for (const [uid, it] of this.items) {
      if (!it.record.ref?.startsWith(prefix)) continue;
      // An author who hid a piece outranks the range check — culling must
      // never be the thing that brings a hidden block back.
      const vis = !this._state.get(uid)?.hidden &&
        it.object.position.distanceToSquared(camera.position) < r2;
      if (it.object.visible !== vis) { it.object.visible = vis; changed = true; }
    }
    return changed;
  }
}

// Assemble a builder block from its declarative parts spec (props-packs.js).
// Shapes: box [w,h,d] (+bevel) · wedge [w,h,d] (rises toward +z) ·
// cylinder [r,h] (+rTop taper) · cone [r,h,segments] · sphere [r] ·
// lathe {profile:[[r,y]…]} · extrude {outline:[[x,y]…], holes, depth}.
// Per part: tex (procedural map, "none" for plain), color tint, roughness,
// metalness, emissive(+emissiveIntensity). Proc-level: grime (metres of
// ground-up weathering, vertex-colored), and a per-placement luminance
// jitter seeded from the uid so repeats don't look photocopied.
// Multiply a color by a per-channel tint triple, clamped to displayable.
function tintColor(color, t) {
  color.setRGB(Math.min(1, color.r * t[0]), Math.min(1, color.g * t[1]), Math.min(1, color.b * t[2]));
}

// Per-placement tint on a GLB clone: materials are cloned so siblings from
// the same template keep their own look.
function tintObject(root, tint) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
      const c = m.clone();
      if (c.color) tintColor(c.color, tint);
      return c;
    });
    o.material = Array.isArray(o.material) ? mats : mats[0];
    o.userData.ownMat = true; // these clones are this placement's, not the template's
  });
}

function partMaterial(p, theme, tint, style) {
  const emissivePart = p.emissive != null;
  // The tex kind doubles as the part's semantic role for theming.
  const role = p.tex === "none" ? "paint" : p.tex || "plaster";
  const remap = (!emissivePart && theme?.map?.[role]) || null;
  const texKind = p.tex === "none" ? "none" : remap?.tex || p.tex || "plaster";
  const color = new THREE.Color(p.color ?? 0x9aa0a8);
  /* `tint: false` — a part declining the theme's colour, the same way
     `grime: false` declines its weathering. It keeps the theme's TEXTURE
     swap, because the grain of a surface belongs to the genre; what it keeps
     out is the multiplier.

     This exists because the role tints are exterior numbers. A plaster wall
     is judged at four hundred metres in sunlight, so `storybook` multiplies
     it by 1.85 — and applied to a surface a metre from your face that is not
     a re-dressing, it is a clip: ivory 0xeae4d6 and cream 0xf2e8d2 both come
     out pure white, which is exactly the difference between the two castle
     halls this engine builds. So a surface whose colour was AUTHORED rather
     than inherited says so and arrives as authored, which is what the
     interior dress has always claimed to do. */
  if (remap?.tint && p.tint !== false) tintColor(color, remap.tint);
  if (tint && !emissivePart) tintColor(color, tint);
  const base = {
    color,
    roughness: p.roughness ?? 0.85,
    metalness: p.metalness ?? 0,
  };
  if (emissivePart) {
    base.emissive = p.emissive;
    base.emissiveIntensity = (p.emissiveIntensity ?? 1) * (theme?.emissive ?? 1);
  }
  if (texKind === "none") return new THREE.MeshStandardMaterial(base);
  const { map, normal, rough } = blockMaps(texKind, style);
  // World-units-per-tile ≈ 3m. Box/cylinder-family UVs are 0..1 per face so
  // they scale by part dims; extrude/wedge UVs are already in metres.
  let ru = 1, rv = 1;
  if (p.shape === "cylinder" || p.shape === "cone") {
    ru = (2 * Math.PI * p.dims[0]) / 3; rv = p.dims[1] / 3;
  } else if (p.shape === "sphere" || p.shape === "blob") {
    ru = (2 * Math.PI * p.dims[0]) / 3; rv = (Math.PI * p.dims[0]) / 3;
  } else if (p.shape === "lathe") {
    let rMax = 0, yMin = Infinity, yMax = -Infinity;
    for (const [r, y] of p.profile) { rMax = Math.max(rMax, r); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
    ru = (2 * Math.PI * rMax) / 3; rv = Math.max(yMax - yMin, 0.001) / 3;
  } else if (p.shape === "wedge" || p.shape === "extrude") {
    ru = rv = 1 / 3;
  } else if (p.dims) {
    ru = Math.max(p.dims[0], p.dims[2]) / 3;
    rv = (p.dims[1] < 1 ? Math.min(p.dims[0], p.dims[2]) : p.dims[1]) / 3;
  }
  const m = map.clone(); m.repeat.set(ru, rv); m.needsUpdate = true;
  const n = normal.clone(); n.repeat.set(ru, rv); n.needsUpdate = true;
  const r = rough.clone(); r.repeat.set(ru, rv); r.needsUpdate = true;
  return new THREE.MeshStandardMaterial({
    ...base, map: m, normalMap: n, normalScale: new THREE.Vector2(0.8, 0.8),
    // Texel multiplies base.roughness — spatial variation, never gloss.
    roughnessMap: r,
  });
}

function partGeometry(p, grimed) {
  // Grimed boxes/cylinders get height segments so the vertex-color gradient
  // actually bends near the ground instead of spanning the whole part.
  const segY = grimed ? Math.min(6, Math.max(1, Math.round((p.dims?.[1] || 1) / 0.6))) : 1;
  switch (p.shape) {
    case "cylinder":
      return new THREE.CylinderGeometry(p.rTop ?? p.dims[0], p.dims[0], p.dims[1], p.seg || 24, segY);
    case "cone":
      return new THREE.ConeGeometry(p.dims[0], p.dims[1], p.dims[2] || 24, segY);
    case "sphere":
      return new THREE.SphereGeometry(p.dims[0], 24, 16);
    case "lathe":
      return new THREE.LatheGeometry(p.profile.map(([r, y]) => new THREE.Vector2(r, y)), p.seg || 24);
    case "blob": {
      // Organic foliage lobe: an icosphere with seeded radial displacement,
      // so a canopy reads as massed leaves instead of a perfect ball. The
      // displacement is a pure function of the spec (seed, wob, freq) — the
      // same spec always bakes the same geometry, in the editor, in VSight
      // and in the Unity export (which reads the live built mesh).
      const geo = new THREE.IcosahedronGeometry(p.dims[0], p.detail ?? 2);
      const posA = geo.attributes.position, v = new THREE.Vector3();
      const freq = p.freq ?? 1.9, wob = p.wob ?? 0.24, seed = (p.seed ?? 1) | 0;
      const squash = p.squash ?? 0.86; // canopies sit wider than tall
      for (let i = 0; i < posA.count; i++) {
        v.fromBufferAttribute(posA, i).normalize();
        const n = valueNoise(v.x * freq + v.z * 2.7, v.y * freq - v.z * 1.9, seed)
          + 0.5 * valueNoise(v.y * freq * 2.3 + 4.2, v.z * freq * 2.3 + 8.7, (seed ^ 0x51c7) >>> 0);
        const rr = p.dims[0] * (1 + wob * n * 0.66);
        posA.setXYZ(i, v.x * rr, v.y * rr * squash, v.z * rr);
      }
      geo.computeVertexNormals();
      return geo;
    }
    case "wedge": {
      const [w, h, d] = p.dims;
      const s = new THREE.Shape();
      s.moveTo(-d / 2, 0); s.lineTo(d / 2, 0); s.lineTo(-d / 2, h); s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
      geo.rotateY(Math.PI / 2);          // extrusion axis → x, slope along z
      geo.translate(-w / 2, 0, 0);       // center the width; tall face at +z
      return geo;
    }
    case "extrude": {
      const s = new THREE.Shape(p.outline.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const hole of p.holes || []) {
        s.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
      }
      const bev = p.bevel || 0;
      const geo = new THREE.ExtrudeGeometry(s, {
        depth: p.depth, bevelEnabled: bev > 0,
        bevelThickness: bev, bevelSize: bev, bevelSegments: 2,
      });
      geo.translate(0, 0, -p.depth / 2); // symmetric about its z axis
      return geo;
    }
    default: {
      const bev = p.bevel || 0;
      if (bev > 0) return new RoundedBoxGeometry(p.dims[0], p.dims[1], p.dims[2], 3, bev);
      return new THREE.BoxGeometry(p.dims[0], p.dims[1], p.dims[2], 1, segY, 1);
    }
  }
}

// Ground-up weathering: darken vertices below `grimeH` (object space), with
// a slightly earthy cast. Multiplies the map via vertexColors — zero cost.
//
// Takes the part's pose rather than a Mesh, so the result is a pure function
// of (geometry, pose, grimeH) and the grimed geometry can therefore be shared
// by every placement of the same block. The matrix is composed exactly as
// Object3D.updateMatrix() would from position/rotation with unit scale, so the
// baked gradient is bit-identical to the per-mesh version this replaced.
const _grimeM = new THREE.Matrix4();
const _grimeQ = new THREE.Quaternion();
const _grimeE = new THREE.Euler();
const _grimeP = new THREE.Vector3();
const _grimeS = new THREE.Vector3(1, 1, 1);
const _grimeV = new THREE.Vector3();
function bakeGrime(geo, p, grimeH) {
  _grimeP.set(...(p.pos || [0, 0, 0]));
  _grimeE.set(p.rotX || 0, p.rotY || 0, p.rotZ || 0);
  _grimeM.compose(_grimeP, _grimeQ.setFromEuler(_grimeE), _grimeS);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _grimeV.fromBufferAttribute(pos, i).applyMatrix4(_grimeM);
    const t = Math.min(Math.max(_grimeV.y / grimeH, 0), 1);
    const s = 0.58 + 0.42 * t * t * (3 - 2 * t);
    col[i * 3] = s; col[i * 3 + 1] = s * 0.985; col[i * 3 + 2] = s * 0.955;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

/* ── shared part resources ──
   Both the geometry and the material of a part are pure functions of the part
   spec plus the dressing (theme, texture style, per-placement tint, luminance
   bucket), so they are cached by content and shared across placements. Before
   this, 144 identical maze walls meant 784 unique geometries, 784 unique
   materials and 1440 Texture objects — and ExtrudeGeometry/RoundedBoxGeometry
   were re-tessellated for every single one.

   The caches are bounded by the number of DISTINCT combinations rather than by
   the number of placements. Past CACHE_CAP they stop growing and callers get
   their own owned copy instead, so this can never turn into the unbounded
   registry it exists to replace. */
const CACHE_CAP = 4096;

// Per-placement luminance jitter, quantised so it stops making every placement
// its own material. 17 buckets across the ±5% range is a 0.6% step — below
// what anyone can see, and repeats still don't look photocopied.
const LUM_BUCKETS = 8;

function sharedGeometry(cache, p, grimed, grimeH) {
  const key = JSON.stringify([
    p.shape, p.dims, p.rTop, p.seg, p.bevel, p.profile, p.outline, p.holes, p.depth,
    // A grimed geometry carries a gradient that depends on where the part sits
    // inside the block, so it is only shareable with the same pose.
    grimed ? [grimeH, p.pos, p.rotX, p.rotY, p.rotZ] : 0,
  ]);
  const hit = cache.get(key);
  if (hit) return { geometry: hit, owned: false };
  const geo = partGeometry(p, grimed);
  if (grimed) bakeGrime(geo, p, grimeH);
  if (cache.size >= CACHE_CAP) return { geometry: geo, owned: true };
  cache.set(key, geo);
  return { geometry: geo, owned: false };
}

function sharedMaterial(cache, p, theme, tint, style, lumB, grimed, decorate) {
  const key = JSON.stringify([
    p.tex, p.color, p.roughness, p.metalness, p.emissive, p.emissiveIntensity,
    // `tint: false` changes the colour that comes out of partMaterial, so two
    // parts differing only in it must not share a material.
    p.tint === false,
    // these three decide the texture repeat inside partMaterial()
    p.shape, p.dims, p.profile,
    theme?.label ?? null, tint ?? null, style, lumB, grimed,
  ]);
  const hit = cache.get(key);
  if (hit) return { material: hit, owned: false };
  const mat = partMaterial(p, theme, tint, style);
  mat.color.multiplyScalar(1 + (lumB / LUM_BUCKETS) * 0.05);
  mat.vertexColors = grimed; // set here, not mutated afterwards by the grime pass
  decorate(mat);
  if (cache.size >= CACHE_CAP) return { material: mat, owned: true };
  cache.set(key, mat);
  return { material: mat, owned: false };
}

// fnv-1a → [-1, 1): deterministic per-placement variation (same uid on the
// editor and in VSight ⇒ the identical block).
function jitterOf(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

function buildProcObject(proc, decorate = (m) => m, uid = "", theme = null, tint = null, style = null, parts = null) {
  const g = new THREE.Group();
  const cache = parts || { geo: new Map(), mat: new Map() };
  // Quantised, but still derived from the uid, so the editor and VSight land
  // on the identical bucket for the identical placement.
  const lumB = Math.round(jitterOf(uid) * LUM_BUCKETS);
  const grimeH = (proc.grime || 0) * (theme?.grime ?? 1);
  // Texture style: per-placement override wins over the theme's genre skin.
  const texStyle = style || theme?.style || "real";
  // A block may declare ONE hinged door: parts flagged door:true hang off a
  // pivot group at proc.door.hinge, so rotating that group swings the leaf.
  let hinge = null;
  if (proc.door) {
    hinge = new THREE.Group();
    hinge.position.set(...proc.door.hinge);
    hinge.userData.swing = proc.door.swing ?? 1.9;
    g.add(hinge);
    g.userData.door = { hinge, swing: hinge.userData.swing, open: false, t: 0 };
  }
  for (const p of proc.parts) {
    const grimed = grimeH > 0 && p.grime !== false && p.emissive == null;
    const geo = sharedGeometry(cache.geo, p, grimed, grimeH);
    const mat = sharedMaterial(cache.mat, p, theme, tint, texStyle, lumB, grimed, decorate);
    const mesh = new THREE.Mesh(geo.geometry, mat.material);
    // Ownership is per MESH, because a part can be cached while a later one
    // (past CACHE_CAP) is not. disposeBuilt() reads exactly these flags.
    mesh.userData.ownGeo = geo.owned;
    mesh.userData.ownMat = mat.owned;
    mesh.position.set(...(p.pos || [0, 0, 0]));
    mesh.rotation.set(p.rotX || 0, p.rotY || 0, p.rotZ || 0);
    mesh.castShadow = mesh.receiveShadow = true;
    /* Non-colliding parts. `noCollide` is a DECLARATION on the part and was
       being ignored — only emissive geometry was excused — so every blood
       decal, water pool, cobweb, ceiling panel and handrail in the project
       was a solid box you walked into. Twenty-four parts declared it across
       the two game modes and none of them got it. Emissive stays automatic
       (a flame is never something you bump into); the flag is now read. */
    if (p.noCollide || p.emissive != null) mesh.userData.noCollide = true;
    /* `light` is a part declaring that it does not merely GLOW but lights the
       room around it, and how far. Emissive geometry is free and casts
       nothing; a real light is neither, so this is a deliberate, countable
       opt-in that the lamp pool (engine/fx/lamps.js) spends its budget on.
       Everything else that glows stays a glow. */
    if (p.light > 0) mesh.userData.light = { r: p.light, color: p.emissive ?? 0xffd9a8 };
    if (p.door && hinge) {
      mesh.userData.doorLeaf = true;
      mesh.position.sub(hinge.position); // re-hang relative to the pivot
      hinge.add(mesh);
    } else {
      g.add(mesh);
    }
  }
  return g;
}

// Release the GPU-side resources a placement owns. three frees a VBO or a
// program ONLY on dispose() — dropping the object out of the scene graph frees
// nothing, and GPU memory is invisible to the JS collector, so without this a
// delete/undo cycle grows renderer.info.memory.geometries forever.
//
// Ownership is stamped per mesh at build time (ownGeo/ownMat) rather than
// re-derived from the record, for two reasons: update() mutates the record
// before calling restyle(), so a record-derived answer would dispose a shared
// GLB template's materials out from under every other placement; and a proc
// block can mix cached parts with owned ones once CACHE_CAP is reached.
//
// Borrowed and therefore never touched here: cached part geometries/materials
// (this._parts), GLB template geometries/materials, and every texture — those
// live in the textures.js cache, and material.dispose() correctly leaves
// material.map alone.
export function disposeBuilt(object) {
  object?.traverse?.((o) => {
    if (!o.isMesh) return;
    if (o.userData.ownGeo) o.geometry?.dispose();
    if (!o.userData.ownMat) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
  });
}

function hashBytes(buf) {
  const v = new Uint8Array(buf);
  let h = 0x811c9dc5;
  const step = Math.max(1, v.length >> 12);
  for (let i = 0; i < v.length; i += step) { h ^= v[i]; h = Math.imul(h, 0x01000193); }
  return ((h >>> 0).toString(36) + "-" + v.length.toString(36));
}
