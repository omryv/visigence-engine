/**
 * What the level editor draws over the world (docs/EDITOR.md), in two layers the session composites
 * (game/ShooterSession.js setEditView):
 *
 *   world  depth-tested against the terrain: the snap grid draped over the ground, the painted regions, the reach
 *          shading, trigger zones, markers for what has no model in the editor (the start, sleeping critters, the
 *          place tool's footprint, the paint brush) and the last playtest's route and falls
 *   top    drawn over the world: the wires between what drives and what is driven, and the gizmo
 *
 * Everything is flat colour (unlit): the design system's peaking blue for selection, focus and wires, bone ink for
 * quiet structure, zebra for no-go ground, tally for falls. Region kinds differ by pattern as well as colour (spawn
 * dots, path solid, no-go stripes), so nothing is told by hue alone. Geometry that follows the ground is rebuilt only
 * when the ground changes (another level or seed); a hand edit never changes the terrain.
 */
import { Group, BufferGeometry, Float32BufferAttribute, LineSegments, LineBasicMaterial, Line, Mesh, MeshBasicMaterial,
  PlaneGeometry, CanvasTexture, SRGBColorSpace, NearestFilter, LinearFilter, CylinderGeometry, ConeGeometry, TorusGeometry, BoxGeometry,
  RingGeometry, CircleGeometry, DoubleSide, Vector3, QuadraticBezierCurve3, TubeGeometry, BufferAttribute } from 'three/webgpu';
import { excludeFromEnvironment } from '../../src/render/Environment.js';
import { REGION_N, REGION_HALF, REGION_CODES } from '../../src/world/level/regions.js';

export const COLORS = { peaking: 0x72d6ff, ink: 0xecebe6, muted: 0x9ea1a7, tally: 0xff6257, zebra: 0xf0d34a, success: 0x5ad8c4, surface: 0x0f1012 };
const LIFT = 0.05, UP = new Vector3(0, 1, 0), _dir = new Vector3();

/** For the world group, drawn in the world pass: out of the environment, and declared unlit to the pass's extra targets. */
function unlit(material) { excludeFromEnvironment(material); return material; }
/**
 * For the top group (wires, the rubber band, the gizmo), drawn in the view-model pass. That pass has no extra targets,
 * and three makes a material's MRT declaration its whole output where a pass has none (render/Environment.js), so a
 * top material only opts out of the environment, however late it is made.
 */
function topMat(color, opacity = 1) {
  const m = new MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false, depthWrite: false, side: DoubleSide });
  m.reflectivity = 0;
  return m;
}
function lineMat(color, opacity = 1, depthTest = true) {
  return unlit(new LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest, depthWrite: false }));
}
function basicMat(color, opacity = 1, depthTest = true, extra = {}) {
  return unlit(new MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest, depthWrite: false, side: DoubleSide, ...extra }));
}

export class Overlays {
  constructor() {
    this.world = new Group(); this.world.name = 'EditorWorld';
    this.top = new Group(); this.top.name = 'EditorTop';
    this.owned = new Set();
    const track = r => { this.owned.add(r); return r; };
    this.track = track;
    this.grid = null; this.regions = null; this.reach = null; this.groundKey = null;
    this.zones = new Group(); this.markers = new Group(); this.traceGroup = new Group(); this.wires = new Group();
    this.world.add(this.zones, this.markers, this.traceGroup); this.top.add(this.wires);
    // The place tool's footprint and the paint brush: one ring each, moved rather than rebuilt.
    // A footprint is a ring and a faint fill: it reads at any distance, and it says where the thing will stand.
    this.cursor = new Group(); this.cursor.visible = false; this.world.add(this.cursor);
    this.cursorRing = new Mesh(track(new RingGeometry(0.84, 1, 48)), track(basicMat(COLORS.peaking, 0.95)));
    this.cursorFill = new Mesh(track(new CircleGeometry(0.84, 48)), track(basicMat(COLORS.peaking, 0.16)));
    for (const m of [this.cursorRing, this.cursorFill]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 10; this.cursor.add(m); }
    this.facing = new Mesh(track(new ConeGeometry(0.22, 0.6, 3)), track(basicMat(COLORS.peaking, 0.95)));
    this.facing.visible = false; this.world.add(this.facing);
    this.gizmo = new Gizmo(track); this.top.add(this.gizmo.root);
  }

  /** The ground-following layers for a level's terrain: rebuilt when the ground itself changes. */
  setGround(terrain, key) {
    if (key === this.groundKey) return;
    this.groundKey = key;
    for (const layer of [this.grid, this.regions, this.reach]) if (layer) { layer.removeFromParent(); layer.geometry.dispose(); this.owned.delete(layer.geometry); }
    const h = (x, z) => terrain?.heightAt?.(x, z) ?? 0;
    // The snap grid: a line every metre, stronger every five, each segment a metre long so it follows the ground.
    const pos = [], col = [], minor = 0.07, major = 0.2;
    for (let i = -40; i <= 40; i++) for (let j = -40; j < 40; j++) {
      const a = i % 5 === 0 ? major : minor;
      pos.push(i, h(i, j) + LIFT, j, i, h(i, j + 1) + LIFT, j + 1, j, h(j, i) + LIFT, i, j + 1, h(j + 1, i) + LIFT, i);
      for (let k = 0; k < 4; k++) col.push(a, a, a);
    }
    const g = this.track(new BufferGeometry());
    g.setAttribute('position', new Float32BufferAttribute(pos, 3)); g.setAttribute('color', new Float32BufferAttribute(col, 3));
    this.grid = new LineSegments(g, this.gridMat ??= this.track(unlit(new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: 2 }))));
    this.grid.renderOrder = 1; this.world.add(this.grid);
    // Regions and reach share one draped sheet shape: a vertex a metre, lifted a little more than the grid.
    const sheet = lift => {
      const geo = this.track(new PlaneGeometry(80, 80, 80, 80)); geo.rotateX(-Math.PI / 2);
      const p = geo.attributes.position;
      for (let k = 0; k < p.count; k++) p.setY(k, h(p.getX(k), p.getZ(k)) + lift);
      p.needsUpdate = true; geo.computeBoundingSphere();
      return geo;
    };
    this.regionCanvas ??= Object.assign(document.createElement('canvas'), { width: 640, height: 640 });
    this.regionTexture ??= this.track(Object.assign(new CanvasTexture(this.regionCanvas), { colorSpace: SRGBColorSpace, magFilter: LinearFilter }));
    // Textured sheets are transparent: the canvas is empty where nothing is painted, and an opaque sheet would show that as black.
    this.regions = new Mesh(sheet(LIFT + 0.02), this.regionMat ??= this.track(basicMat(0xffffff, 1, true, { map: this.regionTexture, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })));
    this.regions.renderOrder = 2; this.world.add(this.regions);
    this.reachCanvas ??= Object.assign(document.createElement('canvas'), { width: 160, height: 160 });
    this.reachTexture ??= this.track(Object.assign(new CanvasTexture(this.reachCanvas), { colorSpace: SRGBColorSpace, magFilter: NearestFilter }));
    this.reach = new Mesh(sheet(LIFT + 0.01), this.reachMat ??= this.track(basicMat(0xffffff, 1, true, { map: this.reachTexture, transparent: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })));
    this.reach.renderOrder = 1; this.reach.visible = false; this.world.add(this.reach);
  }

  /** Paint the region sheet: spawn zones in tally dots, paths in sand, no-go ground in zebra stripes. */
  drawRegions(cells) {
    const c = this.regionCanvas.getContext('2d'), k = this.regionCanvas.width / REGION_N;
    c.clearRect(0, 0, this.regionCanvas.width, this.regionCanvas.height);
    for (let j = 0; j < REGION_N; j++) for (let i = 0; i < REGION_N; i++) {
      const code = cells[j * REGION_N + i];
      if (!code) continue;
      // Canvas row 0 is the far edge (z = -40), the same as the ground overlay (render/CombatEnvironment.js).
      const x = i * k, y = j * k;
      if (code === REGION_CODES.path) { c.fillStyle = 'rgba(240, 187, 132, 0.78)'; c.fillRect(x, y, k, k); }
      else if (code === REGION_CODES.spawn) {
        c.fillStyle = 'rgba(255, 98, 87, 0.28)'; c.fillRect(x, y, k, k);
        c.fillStyle = 'rgba(255, 98, 87, 0.95)'; c.beginPath(); c.arc(x + k / 2, y + k / 2, k * 0.18, 0, Math.PI * 2); c.fill();
      } else if (code === REGION_CODES.nogo) {
        c.fillStyle = 'rgba(15, 16, 18, 0.55)'; c.fillRect(x, y, k, k);
        c.strokeStyle = 'rgba(240, 211, 74, 0.95)'; c.lineWidth = k * 0.2; c.beginPath();
        for (let d = -k; d <= k; d += k / 2) { c.moveTo(x + d, y + k); c.lineTo(x + d + k, y); }
        c.save(); c.beginPath(); c.rect(x, y, k, k); c.clip(); c.stroke(); c.restore();
      }
    }
    this.regionTexture.needsUpdate = true;
    this.regions.visible = cells.some(Boolean);
  }

  /** Shade what the start cannot reach (world/level/checks.js reach): the reach overlay. */
  drawReach(reach, walkableOf, show) {
    this.reach.visible = !!(show && reach);
    if (!this.reach.visible) return;
    const c = this.reachCanvas.getContext('2d'), n = 160, img = c.createImageData(n, n);
    for (let k = 0; k < n * n; k++) {
      const o = k * 4, walk = walkableOf(k);
      if (reach[k]) continue;
      // Walkable but out of reach: tally, strong; not walkable at all: a faint veil.
      img.data[o] = walk ? 255 : 15; img.data[o + 1] = walk ? 98 : 16; img.data[o + 2] = walk ? 87 : 18; img.data[o + 3] = walk ? 110 : 60;
    }
    c.putImageData(img, 0, 0); this.reachTexture.needsUpdate = true;
  }

  setGridVisible(on) { if (this.grid) this.grid.visible = on; }

  _clearGroup(group) {
    for (const o of [...group.children]) {
      o.removeFromParent();
      o.traverse(x => { if (x.geometry && !this.shared?.has(x.geometry)) x.geometry.dispose(); });
    }
  }

  /**
   * Markers for what the editor shows but the game does not draw as a model: the start, trigger zones, sleeping
   * critters (a dashed ring: they wait for a wire), and the extraction when moved. `items` are the pickables.
   */
  drawMarkers({ start, zones, sleepers, selected }, ground) {
    this._clearGroup(this.markers); this._clearGroup(this.zones);
    const shared = this.sharedMarkers ??= {
      arrow: this.track((() => { const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute([0, 0, -1.1, 0.7, 0, 0.7, 0, 0, 0.25, 0, 0, 0.25, -0.7, 0, 0.7, 0, 0, -1.1], 3)); return g; })()),
      ring: this.track(new RingGeometry(0.72, 0.8, 32)),
      dash: this.track(new RingGeometry(0.72, 0.8, 32, 1, 0, Math.PI / 6)),
      box: this.track(new BoxGeometry(1, 1, 1)),
      edges: this.track((() => { const g = new BufferGeometry(); const v = []; const e = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let i = 0; i < 4; i++) { const [a, b] = [e[i], e[(i + 1) % 4]]; v.push(a[0] / 2, 0, a[1] / 2, b[0] / 2, 0, b[1] / 2, a[0] / 2, 1, a[1] / 2, b[0] / 2, 1, b[1] / 2, a[0] / 2, 0, a[1] / 2, a[0] / 2, 1, a[1] / 2); }
        g.setAttribute('position', new Float32BufferAttribute(v, 3)); return g; })()),
    };
    this.shared = new Set(Object.values(shared));
    const mats = this.markerMats ??= {
      arrow: this.track(basicMat(COLORS.peaking, 0.95)), zoneFill: this.track(basicMat(COLORS.peaking, 0.12)),
      zoneEdge: this.track(lineMat(COLORS.peaking, 0.9)), zoneEdgeSel: this.track(lineMat(COLORS.ink, 1)), sleeper: this.track(basicMat(COLORS.muted, 0.9)),
    };
    const arrow = new Mesh(shared.arrow, mats.arrow);
    arrow.position.set(start.x, ground(start.x, start.z) + LIFT + 0.03, start.z); arrow.rotation.y = start.yaw;
    arrow.scale.setScalar(1.2); this.markers.add(arrow);
    for (const z of zones) {
      const y = ground(z.x, z.z), fill = new Mesh(shared.box, mats.zoneFill), edge = new LineSegments(shared.edges, selected.has(z.id) ? mats.zoneEdgeSel : mats.zoneEdge);
      for (const o of [fill, edge]) { o.position.set(z.x, y + (o === fill ? 1.1 : 0), z.z); o.rotation.y = z.yaw; o.scale.set(z.props.w, 2.2, z.props.d); this.zones.add(o); }
    }
    for (const s of sleepers) {
      // A dashed ring: twelve short arcs round the spot where a wired group will appear.
      for (let i = 0; i < 12; i += 2) { const d = new Mesh(shared.dash, mats.sleeper); d.rotation.set(-Math.PI / 2, 0, i * Math.PI / 6); d.position.set(s.x, ground(s.x, s.z) + LIFT + 0.02, s.z); d.scale.setScalar(1.3); this.markers.add(d); }
    }
  }

  /** Wires as arcs from what drives to what is driven, with an arrowhead at the driven end; the selected ones brighter. */
  drawWires(wires, ground, selected) {
    this._clearGroup(this.wires);
    const mats = this.wireMats ??= { on: this.track(topMat(COLORS.peaking, 0.95)), quiet: this.track(topMat(COLORS.peaking, 0.6)) };
    const head = this.wireHead ??= this.track(new ConeGeometry(0.26, 0.62, 12));
    this.shared?.add(head);
    for (const w of wires) {
      const a = new Vector3(w.from.x, ground(w.from.x, w.from.z) + 1.2, w.from.z), b = new Vector3(w.to.x, ground(w.to.x, w.to.z) + 1.2, w.to.z);
      const mid = a.clone().add(b).multiplyScalar(0.5); mid.y += Math.max(1.2, a.distanceTo(b) * 0.25);
      const curve = new QuadraticBezierCurve3(a, mid, b), mat = selected.has(w.fromId) || selected.has(w.toId) ? mats.on : mats.quiet;
      const tube = new Mesh(new TubeGeometry(curve, 28, 0.09, 8, false), mat); tube.renderOrder = 20; this.wires.add(tube);
      const tip = new Mesh(head, mat), dir = curve.getTangent(0.97);
      tip.position.copy(curve.getPoint(0.94)); tip.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir); tip.renderOrder = 20; this.wires.add(tip);
    }
  }

  /** The wire being drawn with the wire tool, from its source to the pointer. */
  drawRubberBand(from, to, ground) {
    this.rubber?.removeFromParent(); this.rubber?.geometry.dispose();
    this.rubber = null;
    if (!from || !to) return;
    const a = new Vector3(from.x, ground(from.x, from.z) + 1.2, from.z), b = new Vector3(to.x, (to.y ?? ground(to.x, to.z)) + 0.3, to.z);
    const mid = a.clone().add(b).multiplyScalar(0.5); mid.y += 1.2;
    this.rubber = new Mesh(new TubeGeometry(new QuadraticBezierCurve3(a, mid, b), 20, 0.04, 6, false), this.rubberMat ??= this.track(topMat(COLORS.ink, 0.9)));
    this.rubber.renderOrder = 21; this.top.add(this.rubber);
  }

  /**
   * The last playtest: the route as a ribbon laid on the ground (a GPU line is one pixel wide at any distance) and a
   * tally cross where each fall happened.
   */
  drawTrace(trace, ground) {
    this._clearGroup(this.traceGroup);
    if (!trace || trace.points.length < 2) return;
    this.traceGroup.add(ribbon(trace.points.map(([x, z]) => [x, z]), 0.3, ground, this.traceMat ??= this.track(basicMat(COLORS.peaking, 0.9)), 3));
    for (const [x, z] of trace.deaths) for (const [dx, dz] of [[1, 1], [1, -1]])
      this.traceGroup.add(ribbon([[x - dx * 0.7, z - dz * 0.7], [x + dx * 0.7, z + dz * 0.7]], 0.22, ground, this.fallMat ??= this.track(basicMat(COLORS.tally, 1)), 4));
  }

  /** The place tool's footprint (radius, facing) or the paint brush (radius only) at a ground point; null hides it. */
  setCursor(at, radius, yaw = null, invalid = false) {
    this.cursor.visible = !!at; this.facing.visible = !!at && yaw !== null;
    if (!at) return;
    const color = invalid ? COLORS.tally : COLORS.peaking;
    for (const m of [this.cursorRing, this.cursorFill, this.facing]) m.material.color.setHex(color);
    this.cursor.position.set(at.x, at.y + LIFT + 0.04, at.z); this.cursor.scale.setScalar(Math.max(0.45, radius));
    if (yaw !== null) {
      // A model's front is +Z turned by its yaw: the arrow stands just outside the ring, pointing that way.
      const r = Math.max(0.3, radius) + 0.45, fx = Math.sin(yaw), fz = Math.cos(yaw);
      this.facing.position.set(at.x + fx * r, at.y + LIFT + 0.05, at.z + fz * r);
      this.facing.quaternion.setFromUnitVectors(UP, _dir.set(fx, 0, fz));
    }
  }

  dispose() {
    this.world.removeFromParent(); this.top.removeFromParent(); this.rubber?.geometry.dispose();
    for (const g of [this.markers, this.zones, this.wires, this.traceGroup]) this._clearGroup(g);
    for (const r of this.owned) r.dispose?.();
    this.owned.clear();
  }
}

/** A flat strip `width` metres wide along a polyline of [x, z] points, laid on the ground. */
function ribbon(points, width, ground, material, order) {
  const pos = [], idx = [], h = width / 2;
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i], [px, pz] = points[Math.max(0, i - 1)], [nx, nz] = points[Math.min(points.length - 1, i + 1)];
    let tx = nx - px, tz = nz - pz; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    for (const s of [-1, 1]) { const vx = x - tz * h * s, vz = z + tx * h * s; pos.push(vx, ground(vx, vz) + LIFT + 0.07, vz); }
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const m = new Mesh(g, material); m.renderOrder = order;
  return m;
}

/**
 * The gizmo: a ground ring to turn (yaw is the only turn a level uses), two arrows to slide along X or Z, a centre disc
 * to slide freely on the ground, and a corner handle to scale. Handles are bone ink with a dark rim so they read over
 * grass and sand; the one under the pointer or in hand turns peaking blue. Each carries its letter or role in
 * userData, and the status bar names it, so nothing depends on colour alone. Drawn over the world at a constant
 * size on screen.
 */
export class Gizmo {
  constructor(track) {
    this.root = new Group(); this.root.visible = false; this.root.name = 'Gizmo';
    // Opaque, so the render order decides what is on top (a transparent rim would be drawn after every opaque handle).
    const ink = () => track(topMat(COLORS.ink)), dark = () => track(topMat(COLORS.surface));
    this.handles = [];
    const add = (mesh, role, label) => { mesh.userData = { role, label }; mesh.renderOrder = 30; this.root.add(mesh); this.handles.push(mesh); return mesh; };
    // Ring (rotate)
    const ring = add(new Mesh(track(new TorusGeometry(2.1, 0.06, 6, 64)), ink()), 'rotate', 'Turn');
    ring.rotation.x = Math.PI / 2;
    const ringRim = new Mesh(track(new TorusGeometry(2.1, 0.1, 6, 64)), dark()); ringRim.rotation.x = Math.PI / 2; ringRim.renderOrder = 29; this.root.add(ringRim);
    // Axis arrows (move along X, Z)
    for (const [axis, rot] of [['x', [0, 0, -Math.PI / 2]], ['z', [Math.PI / 2, 0, 0]]]) {
      const g = new Group(), mat = ink();
      const shaft = new Mesh(track(new CylinderGeometry(0.05, 0.05, 1.3, 8)), mat); shaft.position.y = 0.95;
      const head = new Mesh(track(new ConeGeometry(0.16, 0.42, 12)), mat); head.position.y = 1.8;
      g.add(shaft, head); g.rotation.set(...rot);
      const hit = add(new Mesh(track(new CylinderGeometry(0.28, 0.28, 1.9, 6)), track(topMat(COLORS.ink, 0))), `move-${axis}`, axis.toUpperCase());
      hit.rotation.set(...rot); hit.position.set(axis === 'x' ? 1.2 : 0, 0, axis === 'z' ? 1.2 : 0); hit.userData.visual = mat;
      this.root.add(g);
    }
    // Centre disc (free move) and the scale handle
    add(new Mesh(track(new CircleGeometry(0.42, 24)), ink()), 'move', 'Move').rotation.x = -Math.PI / 2;
    const s = add(new Mesh(track(new BoxGeometry(0.34, 0.34, 0.34)), ink()), 'scale', 'Scale');
    s.position.set(1.5, 0, -1.5);
    this.scaleHandle = s;
  }
  /** Stand the gizmo at a point, sized to stay the same on screen, showing the handles the tool and the selection allow. */
  place(at, cameraPos, { move = true, rotate = true, scale = false } = {}) {
    this.root.visible = !!at;
    if (!at) return;
    this.root.position.set(at.x, at.y + 0.08, at.z);
    const d = Math.hypot(cameraPos.x - at.x, cameraPos.y - at.y, cameraPos.z - at.z);
    this.root.scale.setScalar(Math.max(0.2, d * 0.042));
    for (const h of this.handles) h.visible = h.userData.role === 'rotate' ? rotate : h.userData.role === 'scale' ? scale : move;
    this.root.children.forEach(c => { if (!c.userData.role && c.type === 'Group') c.visible = move; if (c.type === 'Mesh' && !c.userData.role) c.visible = rotate; });
  }
  highlight(role) {
    for (const h of this.handles) {
      const on = h.userData.role === role, m = h.userData.visual ?? h.material;
      if (m.opacity !== 0) m.color.setHex(on ? COLORS.peaking : COLORS.ink);
      if (h.userData.visual) h.userData.visual.color.setHex(on ? COLORS.peaking : COLORS.ink);
    }
  }
}
