// Engine.js — the World engine's ONE public API. The shell (studio), VSight
// and the exporters drive this and never reach past it. The engine owns the
// viewport, the params object, lighting and performance; it renders
// on-demand (no draw when nothing changed) unless something is animating.

import * as THREE from "three";
import { DEFAULT_PARAMS, mergeParams, makeParams } from "../kernel/presets.js";
import { THEMES } from "./props/themes.js";
import { Doors } from "./props/doors.js";
import { Fittings } from "./props/fittings.js";
import { Blockers } from "./player/collide.js";
import { randomSeed, normalizeSeed, seedChannel } from "../kernel/seed.js";
import { createHeightSampler, createBakedSampler, bakeHeightField, elevNorm } from "../kernel/terrain/heightfield.js";
import { CANONICAL_RES, masksFor } from "../kernel/terrain/canonical.js";
import { firstGroundHit } from "./terrain/pick.js";
import { SKYVIS_RES } from "../kernel/terrain/skyvis.js";
import { canonicalTerrainFingerprint, terrainParameterHash } from "../kernel/terrain/fingerprint.js";
import { SculptLayer } from "../kernel/terrain/sculpt.js";
import { QuadtreeTerrain } from "./terrain/QuadtreeTerrain.js";
import { PALETTES } from "./style/palettes.js";
import { Sky } from "./sky/Sky.js";
import { Water } from "./water/Water.js";
import { RiverSurface } from "./water/RiverSurface.js";
import { Grass, GRASS_PATCH } from "./props/grass.js";
import { resolveDetail, DETAIL_PROTOTYPES, WIND_DEFAULTS } from "./props/detail-spec.js";
import { Props, disposeBuilt } from "./props/Props.js";
import { Scatter } from "./props/Scatter.js";
import { resolveQuality, probeDevice } from "./render/quality.js";
import { Atmosphere } from "./render/atmosphere.js";
import { SkyEnvironment } from "./render/envmap.js";
import { createEnvPacer, envCapture } from "./render/env-pacer.js";
import { WaterReflection, NO_REFLECT_LAYER } from "./water/reflection.js";
import { makeDetailSet, makeDetailSetAsync } from "./terrain/detail-textures.js";
import { FireFX, isPlantRef, PLANT_IGNITE_SCALE } from "./fx/fire.js";
import { Lamps } from "./fx/lamps.js";
import { ShelterField, shelterVolumes, shelterAt, aperturesOf, doorApertureOf } from "../kernel/core/shelter.js";
import { inVolume } from "../kernel/core/shelter.js";
import { roomProbe, roomAt, blendProbe, emptyProbe, apertureBelongsTo } from "../kernel/core/room-probe.js";
import { Ingress } from "./fx/ingress.js";
import { toWorld } from "../kernel/core/ports.js";
import { WeatherFX } from "./fx/weather.js";
import { SplashFX } from "./fx/splash.js";
import { Markers } from "./fx/markers.js";
import { Pins } from "./fx/pins.js";
import { OrbitEditor, WalkController, FlyController } from "./player/controllers.js";
import { TouchControls, isTouchDevice } from "./player/touch-controls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { scriptURL } from "./trusted.js";

// See _kickErosion: the quadtree depth ceiling while erosion is in flight.
const EROSION_DEPTH_CAP = 2;

/* The grid for PLACEHOLDER bakes only — the quick water depth field a fresh
   world shows while erosion is still running. Deliberately coarser than
   CANONICAL_RES: this one bake runs against the ANALYTIC sampler, thirteen
   times the per-sample cost of a baked field, and the canonical 513² ground
   replaces it seconds later. Every bake of a FINAL ground uses CANONICAL_RES. */
const QUICK_FIELD_RES = 257;

/* How far off the sun's own bearing the default framing stands — see
   frameWorld. 52° is the middle of the thirty-to-seventy band js/cinematic.js
   argues for: far enough off axis that the relief models, near enough that
   the light is still behind the lens rather than beside it. */
const SHOULDER_OFFSET = Math.PI * 0.29;

/* The longest step any animation is allowed to take in one frame.

   A hidden document gets no rendering opportunities, so requestAnimationFrame
   does not fire at all while a tab is in the background — which means the
   clock is not read for as long as the tab is away, and the FIRST VISIBLE
   frame reads the entire absence. Five minutes backgrounded is a dt of 300,
   and by the time that frame runs `document.hidden` is already false, so the
   guard in _frame cannot catch it. Same shape after a lost GPU context is
   restored, and after any long main-thread stall.

   0.25 s is the figure the day clock already picked for exactly this reason
   (js/studio.js, "a backgrounded tab must not lurch the day"), so the two
   halves of the product agree on what an implausible frame is. Well above any
   real one — a 4 fps frame is still passed through untouched — so nothing on
   a slow device is quietly slowed down by this. */
const MAX_FRAME_DT = 0.25;


export { DEFAULT_PARAMS, THEMES, PALETTES, makeParams, mergeParams, randomSeed, normalizeSeed, elevNorm, bakeHeightField, createHeightSampler, resolveDetail, DETAIL_PROTOTYPES, WIND_DEFAULTS };

export class Engine {
  constructor(canvas, params = null, opts = {}) {
    this.canvas = canvas;
    this.params = params || structuredClone(DEFAULT_PARAMS);
    this._listeners = new Map();

    /* ── the ground this engine was HANDED, if it was handed one ──
       An engine normally derives its terrain from its params. When another
       view of the same world already holds that terrain — the library shelf,
       which rendered it before the visitor clicked — the engine takes the
       field itself instead of re-deriving one, so the world does not change
       shape between the two renderers. Set before the first _buildWorld
       because the constructor ends in one. See adoptGround. */
    this._adoptedGround = null;
    if (opts.ground) this.adoptGround(opts.ground);

    const probe = probeDevice(opts.quality);
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: "high-performance",
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // The probed tier is reused rather than re-detected, so the tier the
    // antialias decision was made for is the tier that actually runs.
    this.quality = resolveQuality(this.renderer, opts.quality || probe.tier);
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    // PCFSoftShadowMap is deprecated in three 0.185 and silently falls back
    // to this anyway — naming it directly keeps the console clean and the
    // behaviour identical.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Driven explicitly (see _needsShadow): with autoUpdate the 2048² cascade
    // is re-rendered on every single draw, and ambient animation means every
    // frame — a full shadow pass over every terrain tile and every placed
    // block, 60 times a second, for a world that has not moved.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    console.info("[engine] quality preset:", this.quality.tier);

    this.scene = new THREE.Scene();
    /* Near 0.22, and the number is load-bearing: walk-mode collision holds
       every wall at least 0.42 m from the eye (collide.js), and at fov 60
       the near plane's corner sphere reaches ~0.34 m — so no surface the
       player can legally stand against ever crosses the near plane. At the
       old 0.5 the plane started BEYOND the collision radius, and pressing
       into any wall or wardrobe clipped it away and showed the inside. */
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.22, this.params.terrain.size * 10);
    // The main camera sees the NO_REFLECT layer (grass, weather, editor
    // chrome); the water's mirror camera does not — that is the layer's job.
    this.camera.layers.enable(NO_REFLECT_LAYER);
    // Aerial perspective carries the distance haze; three's fog stays as a
    // thin floor above water and takes over entirely when submerged.
    this.atmos = new Atmosphere(this.params);
    this.scene.fog = new THREE.FogExp2(0xffffff, this._fogDensity());

    /* ── the graphics-boost rigs (all tier-gated, all optional) ──
       post: HDR bloom + god rays + cinematic finish. When it constructs
       successfully it owns tone mapping for the whole frame (uWfPost).
       skyEnv: the procedural sky PMREM'd into scene.environment — IBL.
       waterRefl: the planar mirror pass the water shader samples. */
    this.skyEnv = this.quality.envMap ? new SkyEnvironment(this.renderer, this.atmos) : null;
    this.waterRefl = this.quality.reflectionRes ? new WaterReflection(this.quality.reflectionRes) : null;
    this._envDirty = true;
    this._envPacer = createEnvPacer();

    // FX systems: fire (+charring), weather (rain/snow/fireflies), splashes.
    this.fire = new FireFX({ quality: this.quality });
    this.scene.add(this.fire.group);
    /* Interior lamps. A candle that only GLOWS is convincing through a window
       and useless once you are standing next to it, so a small pool of real
       point lights follows the camera round the lamps nearest to it. */
    this.lamps = new Lamps(THREE, this.quality);
    this.scene.add(this.lamps.group);

    /* ── shelter ──
       What stands between a point and the sky. One window on the world that
       follows the viewer (js/shelter.js) and is read by three systems that
       could otherwise never agree: the rain shader decides which drops to
       draw, the material patch decides what gets wet and how much sky lights
       it, and the fire decides how hard the weather is falling ON IT.

       Without this a building is scenery: rain fell through every roof, a
       storm soaked the inside of every house as thoroughly as the street,
       snow settled on kitchen tables and a hearth burned in a downpour
       exactly as it burned on a still night. */
    this.shelter = new ShelterField();
    this._shelterTex = new THREE.DataTexture(
      this.shelter.data, this.shelter.res, this.shelter.res, THREE.RGBAFormat);
    this._shelterTex.magFilter = THREE.NearestFilter;   // a wall is an edge
    this._shelterTex.minFilter = THREE.NearestFilter;
    this._shelterTex.needsUpdate = true;
    this.fire.setShelterFn((x, y, z) => shelterAt(this.shelter.volumes, x, y, z));
    /* …and the other half of the same fact: a building is not sealed. Rain
       comes through the openings, and the floor inside them stays dark with
       it after the shower has passed. A bounded pool on the nearest few, the
       way the lamps work — a hundred windows cost what four do. */
    this.ingress = new Ingress(THREE, this.quality);
    this.ingress.group.traverse((o) => { if (NO_REFLECT_LAYER != null) o.layers.set(NO_REFLECT_LAYER); });
    this.scene.add(this.ingress.group);
    this.weather = new WeatherFX({ quality: this.quality, layer: NO_REFLECT_LAYER });
    this.weather.group.traverse((o) => o.layers.set(NO_REFLECT_LAYER));
    this.scene.add(this.weather.group);
    this.splash = new SplashFX();
    this.splash.group.traverse((o) => o.layers.set(NO_REFLECT_LAYER));
    this.scene.add(this.splash.group);
    this._wasSwimming = false;

    /* ── the discovery layer ──
       An object placed in a 2 km world is four pixels across, and four
       pixels is not a confirmation. `markers` is the loud, brief half — the
       ripple, the beacon and the object easing up to size — and the quiet,
       permanent half that says what is selected. `pins` is the other
       problem: not "where did THAT go" but "what is out there", answered by
       one point per placement that fades itself out the moment its object is
       big enough on screen to speak for itself. Both are editor chrome and
       neither reflects in the sea. */
    this.markers = new Markers({ layer: NO_REFLECT_LAYER });
    this.scene.add(this.markers.group);
    this.pins = new Pins({ layer: NO_REFLECT_LAYER });
    this.scene.add(this.pins.group);
    this._pinsDirty = true;
    this._pinColor = null;   // shell hook: category colour for a record
    this._viewStack = [];    // where the camera was before it was sent somewhere
    this._orbitAround = null;

    this._needsRender = true;
    // Ambient animation (wind, waves, drifting cloud) needs a redraw but NOT a
    // new shadow map — nothing that casts a shadow moved. Everything else goes
    // through invalidate(), so that is the honest signal for both.
    this._needsShadow = true;
    this.invalidate = () => { this._needsRender = true; this._needsShadow = true; };

    // Interactive doors + walk-mode collision. Both are derived from what is
    // placed, so they need no params and never enter the world contract.
    this.doors = new Doors();
    /* …and everything else a placement says it is for. A door swings; a chair
       is sat in, a lamp is lit and a book is picked up, and none of those is
       a hinge. Same rule as the doors: derived from what is placed, never
       part of the world contract. */
    this.fittings = new Fittings();
    this.blockers = new Blockers();

    // Controllers
    const ctlOpts = {
      camera: this.camera, canvas, params: this.params, invalidate: this.invalidate,
      sampler: (x, z) => this.sampleHeight(x, z),
      getParams: () => this.params, // live ref — applyParams swaps the object
      getFlood: () => this.water?.flood ?? null, // sea-connected mask, follows rebuilds
      blockers: this.blockers,
      isDoorOpen: (uid) => this.doors.isOpen(uid),
    };
    this.controllers = {
      orbit: new OrbitEditor(ctlOpts),
      walk: new WalkController(ctlOpts),
      fly: new FlyController(ctlOpts),
    };
    this.mode = "orbit";
    // A user grabbing the orbit controls cancels any camera automation —
    // a flight in progress and the automatic orbit alike. The hand wins.
    this.controllers.orbit.controls.addEventListener("start", () => {
      this._flight = null;
      this._orbitAround = null;
    });

    // Touch devices get on-screen stick + look pad for walk/fly (iOS Safari
    // has no Pointer Lock, so this is the only way in). Apps may add their
    // own buttons — VSight adds fire/aim/reload.
    this.touch = isTouchDevice() ? new TouchControls({
      buttons: [{ id: "jump", label: "Jump", onDown: () => { const c = this.controllers[this.mode]; if (c.jumpInput !== undefined) c.jumpInput = true; } }],
    }) : null;

    // Props live across world regenerations (their Y reseats).
    this.props = new Props({
      sampler: (x, z) => this.sampleHeight(x, z),
      // Anything that changes what is placed also changes what has to be
      // findable: the pin cloud is rebuilt on the next frame (once, however
      // many records moved), and the shell hears about it so the Object
      // Manager and the telemetry never describe a world that has moved on.
      onChange: (opts) => {
        this._shelterStale = true;
        this.invalidate();
        // A bulk add still repaints — the point of watching a world build
        // is watching it — but it does not rebuild the pin cloud or tell the
        // shell to re-read the world on every single placement. Both of those
        // walk EVERY prop, and doing that once per prop is quadratic.
        if (opts?.bulk) return;
        this._pinsDirty = true;
        this._emit("props", { count: this.props.items.size });
      },
      decorate: (m) => this.atmos.apply(m), // props recede into the same air
      doors: this.doors,
      blockers: this.blockers,
      fittings: this.fittings,
      lamps: this.lamps,
      // A block landing in sea-connected water announces itself: splash at
      // the waterline, sized by its footprint. The lasting wet look is the
      // material patch's job — this is just the moment of entry.
      onAdd: (record, object) => this._propLanded(record, object),
    });
    // Structure theme from params — an exported world is dressed identically.
    // `_themeName` is what _buildWorld compares against so a param change can
    // re-dress; seeding it here keeps the first build from paying for a
    // no-op restyle over an empty scene.
    this._themeName = this.params.structure?.theme || null;
    this.props.theme = THEMES[this._themeName] || null;
    this.scene.add(this.props.group);

    // Waves come from the shader's own layered noise (water/Water.js) — no
    // texture file, so the renderer needs nothing but the page itself.

    this._buildWorld();
    this.frameWorld();

    this._resize = () => {
      const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // The pin fade is measured in screen pixels, so it has to be told what
      // a screen pixel is — here and nowhere else, never per frame.
      this.pins.setViewport(h, this.camera.fov, this.quality.pixelRatio);
      this.invalidate();
    };
    addEventListener("resize", this._resize);
    this._resize();

    // E interacts with whatever is in front of you (doors, for now).
    this._onInteractKey = (e) => {
      if (e.code !== "KeyE" || e.repeat) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      this.interact();
    };
    addEventListener("keydown", this._onInteractKey);

    /* ── GPU context loss ──
       The WebGL equivalent of a lost device, and it is not exotic: phones drop
       the context under memory pressure and desktops drop it on a driver
       update. Without preventDefault() the browser will not even try to give
       it back, so the canvas stays black for the rest of the session while the
       loop keeps issuing draws into a dead context. */
    this._onContextLost = (e) => {
      e.preventDefault(); // REQUIRED — without it there is no restore event
      this._running = false;
      console.warn("[engine] WebGL context lost — pausing");
      this._emit("context-lost", null);
    };
    this._onContextRestored = () => {
      console.info("[engine] WebGL context restored — rebuilding GPU state");
      this.renderer.resetState();
      // Everything is still described in JS; three re-uploads on next use.
      // What must be forced is what the engine caches itself.
      if (this.terrain) this.terrain.rebuild();
      if (this.grass) this.grass.rebuild();
      // Render targets don't survive a lost context: rebuild the water
      // mirror and recapture the sky IBL.
      if (this.waterRefl) {
        this.waterRefl.dispose();
        this.waterRefl = new WaterReflection(this.quality.reflectionRes);
      }
      this._envDirty = true;
      this._running = true;
      this.invalidate();
      this._schedule();   // no-op if the frame from before the loss is still queued
      this._emit("context-restored", null);
    };
    canvas.addEventListener("webglcontextlost", this._onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);

    this._clock = new THREE.Clock();
    this._running = true;
    /* ── exactly one loop, and the flag that makes it structural ──
       `_running` alone could not enforce it, because it does not distinguish
       "no loop is alive" from "a loop is alive and its next callback is
       already queued". Both read false the moment something pauses, and the
       gap between them is where a second chain got in:

         context lost      → _running = false, but the frame requested on the
                             previous tick is STILL QUEUED
         context restored  → _running = true and a fresh rAF is requested
         the queued frame  → fires, sees _running true, requests another

       …and from then on the engine drew twice per frame, forever, with a
       shadow pass and a post stack each time. Compounding, because every
       later context loss could do it again — and a phone dropping its
       context under memory pressure is the ordinary case, not the exotic one.

       `_scheduled` tracks the thing that actually matters: whether a callback
       is outstanding. Every start goes through _schedule(), so a request made
       while one is already in flight is dropped rather than doubled, in
       either interleaving. setPaused's own `if (this._running) return` was
       the same intent written where it could only catch half of it. */
    this._scheduled = false;
    this._loop = () => {
      this._scheduled = false;
      if (!this._running) return;
      this._schedule();
      this._frame();
    };
    this._schedule();
  }

  /** Ask for the next frame, unless one is already on its way. */
  _schedule() {
    if (this._scheduled || !this._running) return;
    this._scheduled = true;
    requestAnimationFrame(this._loop);
  }

  /* ── events ── */
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this._listeners.get(event).delete(cb);
  }
  _emit(event, data) { for (const cb of this._listeners.get(event) || []) cb(data); }

  /* ── world lifecycle ── */
  get palette() { return PALETTES[this.params.biome] || PALETTES.verdant; }

  sampleHeight(x, z) { return this.sampler ? this.sampler(x, z) : 0; }

  _fogDensity() {
    // Halved since aerial perspective (render/atmosphere.js) now carries the
    // distance falloff — this is only the residual ground haze.
    return (this.params.fog.density * 0.55) / this.params.terrain.size;
  }

  /* ── sculpting ──
     Strokes live in params.terrain.sculpt, so a sculpted world travels as
     the same small params object into VSight and the exporters, and the
     brush stays a pure edit of the height sampler — everything downstream
     (grass, props, water depth, spawn scoring, export) reads it for free. */
  _refreshSampler() {
    const base = this._baseSampler;
    if (this.sculpt && !this.sculpt.empty) {
      const sc = this.sculpt;
      this.sampler = (x, z) => base(x, z) + sc.offsetAt(x, z);
      this.sampler.kind = (base.kind || "analytic") + "+sculpt";
    } else {
      this.sampler = base;
    }
  }

  // One brush dab. `commit` is the end of a stroke: that is when the heavy
  // followers (water depth, grass, listeners) catch up.
  sculptAt(x, z, { radius = 60, amount = 6, mode = "raise", commit = false } = {}) {
    const stroke = this.sculpt.apply({ x, z, r: radius, amount, mode }, this._baseSampler);
    this._refreshSampler();
    this._afterSculpt(x, z, radius, commit);
    return stroke;
  }

  // Replace the whole stroke list (undo/redo). Overlapping brushes are not
  // individually invertible, so the layer replays from scratch — which is
  // why history stores stroke-list snapshots rather than deltas.
  sculptRestore(strokes) {
    this.sculpt.replay(strokes ? [...strokes] : [], this._baseSampler);
    this.params.terrain.sculpt = this.sculpt.strokes;
    this._refreshSampler();
    if (this.terrain) this.terrain.rebuild();
    if (this.grass) this.grass.rebuild();
    this.props.setSampler((p, q) => this.sampleHeight(p, q));
    this.fire.reseat((p, q) => this.sampleHeight(p, q)); // undo moves the ground too
    this._kickGroundBakes();                           // …and so does the light
    if (this._spawnCoords) this.markSpawn(this._spawnCoords.x, this._spawnCoords.z, { visible: this._spawnVisible !== false });
    this.water.setTerrainField(bakeHeightField(this.params, CANONICAL_RES, this.sampler));
    this._emit("sculpt", { strokes: this.sculpt.strokes.length });
    this.invalidate();
  }
  sculptStrokes() { return [...(this.sculpt?.strokes || [])]; }

  /* What the erosion pass moved on THIS world, or null — the same
     generation-gated read _kickGroundBakes makes for the shader's deposition
     mask, exposed for the export, whose deposition PNG must be a picture of
     the same event. A stale delta answered here would hand a new world the
     previous world's sediment, which is precisely the bug the gen stamp was
     added to close (see _applyCanonicalGround). */
  erosionDelta() {
    const d = this._erosionDelta;
    return d && d.gen === this._generation ? { res: d.res, data: d.data } : null;
  }

  // End of a brush stroke: let the heavy followers catch up once.
  commitSculpt() { this._afterSculpt(0, 0, 0, true); }

  /* Rebuild the river ribbons from params.terrain.rivers — the call the
     editor makes after carving, un-carving or re-carving one. `runIn: true`
     sweeps the water down the course from the head, at the flood front's
     pacing: the carve's own moment. */
  refreshRivers({ runIn = false } = {}) {
    if (!this.rivers) return;
    this.rivers.setRivers(this.params.terrain.rivers, this.params.water.level || 0);
    if (runIn) this.rivers.runIn();
    this.invalidate();
  }

  _afterSculpt(x, z, radius, commit) {
    // radius 0 is commitSculpt's "followers only" call — every dab already
    // invalidated its own area on the way in, and invalidateArea(0,0,0)
    // still matches the tile CONTAINING the origin, so the guard is what
    // keeps the end of every stroke from disposing and re-sampling the
    // centre of the world.
    if (radius > 0 && this.terrain) this.terrain.invalidateArea(x, z, radius * 1.8);
    if (commit) {
      if (this.grass) this.grass.rebuild();
      if (this.props) this.props.setSampler((p, q) => this.sampleHeight(p, q));
      // Flames re-seat on the sculpted ground like everything else standing
      // on it — without this a fire hangs at its old height over the hollow
      // that was just dug out from under it.
      this.fire.reseat((p, q) => this.sampleHeight(p, q));
      // Carving a valley changes what its floor can see of the sky, so the
      // indirect light is re-derived like every other follower. It is a
      // worker and generation-guarded, so a fast series of strokes simply
      // supersedes itself.
      this._kickGroundBakes();
      if (this._spawnCoords) this.markSpawn(this._spawnCoords.x, this._spawnCoords.z, { visible: this._spawnVisible !== false });
      // The one place a flood is ANIMATED: the end of a brush stroke is the
      // only moment the author cut a new channel and should watch it fill.
      // At CANONICAL_RES like every other final ground: the water's depth and
      // reachability used to drop to 257² on the first stroke and never come
      // back, which moved the drawn shoreline the moment the brush touched a
      // world.
      this.water.setTerrainField(bakeHeightField(this.params, CANONICAL_RES, this.sampler), { animate: true });
      this._emit("sculpt", { strokes: this.sculpt.strokes.length });
    }
    this.invalidate();
  }

  // Push the sky rig's live sun + fog grade into the shared air.
  _syncAtmosphere() {
    this.atmos.setSun(this.sky.uniforms.uSunDir.value, this.sky.sun.color);
    this.atmos.setHaze(this.sky.fogColor);
    this.atmos.setNight(this.sky.night);
    this._envDirty = true; // the sky changed → the IBL capture is stale
  }

  _buildWorld() {
    this._generation = (this._generation || 0) + 1;
    // Ground truth is base noise + the hand-sculpted offset layer. Erosion
    // later swaps the BASE only, so sculpting is never baked in twice.
    this._baseSampler = createHeightSampler(this.params);
    if (!this.params.terrain.sculpt) this.params.terrain.sculpt = [];
    if (!this.params.fx) this.params.fx = { fires: [] };       // pre-fx records
    if (!this.params.sky.weather) this.params.sky.weather = "clear";
    /* ── the dressing follows params, not just the switch ──
       `params.structure.theme` was read ONCE, when Props was constructed, and
       `setStructureTheme` was the only thing that ever changed it afterwards.
       So a theme arriving through `applyParams` — which is how every generated
       world states what it is made of, and how a loaded world states it — was
       silently ignored: a storybook kingdom came out in the neutral grey the
       blocks happen to be authored in, and the whole re-dressing system was
       reachable only from the panel. Guarded on the name, because setTheme
       rebuilds every placed object and a world rebuild that did not change
       the dressing must not pay for one. */
    const wantTheme = this.params.structure?.theme || null;
    if (this.props && wantTheme !== this._themeName) {
      this._themeName = wantTheme;
      this.props.setTheme(THEMES[wantTheme] || null);
    }
    this.sculpt = new SculptLayer({ size: this.params.terrain.size });
    this.sculpt.replay(this.params.terrain.sculpt, this._baseSampler);
    this.params.terrain.sculpt = this.sculpt.strokes; // one array, both readers
    this._refreshSampler();
    this.atmos.setWorld(this.params);

    if (this.terrain) { this.scene.remove(this.terrain.group); this.terrain.dispose(); }
    {
      this.terrain = new QuadtreeTerrain({
        // Indirection on purpose: erosion and sculpting swap what the engine
        // samples, and the terrain follows without being handed a new closure.
        sampler: (x, z) => this.sampleHeight(x, z),
        params: this.params, palette: this.palette,
        quality: this.quality, onChange: this.invalidate,
      });
      this.atmos.apply(this.terrain.material);
      /* Seeded ground materials: every world wears its own turf, strata and
         ripples, drawn from a ten-layer stack the palette selects four of
         (terrain/detail-layers.js). The engine owns the set's lifetime — it
         is keyed by SEED, so it survives the palette swaps and quality
         changes that rebuild the terrain around it.

         Baked in a worker because ten layers is about 420 ms of pure
         arithmetic, and that lands in the middle of a world build. The set
         arriving late is not a fault: the material compiles with its array
         samplers bound and gated by uDetOn, so the ground renders on the
         palette's vertex colours until the stack lands. */
      if (this.quality.terrainDetail) {
        if (this._detailSeed !== this.params.seed) {
          this._detail?.dispose();
          this._detail = null;
          this._detailSeed = this.params.seed;
          this._kickDetailStack();
        } else if (this._detail) {
          this.terrain.setDetail(this._detail);
        }
      }
      /* A control map already baked for THIS world outlives a terrain rebuild
         — a quality change or a palette swap makes a new QuadtreeTerrain, and
         re-running a 600k-sample bake to hand it the identical texture would
         be the same picture two seconds later.

         GENERATION-GATED, and that guard is the whole correctness of it. This
         line used to read `if (this._masksTex)`, and nothing anywhere cleared
         `_masksTex` on a world change: it is disposed inside the NEXT bake's
         onmessage and in dispose(), and nowhere else. So every setSeed and
         every applyParams handed the brand-new world the PREVIOUS world's
         drainage, ambient occlusion and curvature — and because the masks
         bake waits for erosion (which is on by default, 35000 drops), that
         window was seconds rather than frames. The comment above claimed "a
         world change disposes the texture and rebakes"; nothing did.

         _buildWorld always ends in _kickErosion, which always reaches
         _kickGroundBakes, so a rebake is already guaranteed on this path.
         Refusing the stale one costs nothing but the neutral defaults the
         shader was written to render without it. */
      if (this._masksTex && this._masksGen === this._generation) {
        this.terrain.setControlMap(this._masksTex, this.params.terrain.size);
        // Baked in the same pass, gated by the same generation, and handed
        // over together — a terrain wearing one map and not the other would
        // weight its layers off a drainage the deposition disagrees with.
        this.terrain.setErosionMap(this._erosTex || null);
      }
      this.scene.add(this.terrain.group);
    }

    // Surface conditions follow the world: the waterline everything wets
    // against, the biome's caustic light, the authored weather.
    // Both surfaces need the waterline: the air wets and glosses what is near
    // it, and the ground darkens its tide band against it.
    this.terrain?.setWaterline(this.params.water.level || 0, !!this.params.water.enabled);
    this.atmos.setWaterline(this.params.water.level || 0, !!this.params.water.enabled);
    this.atmos.setCausticColor(this.palette.water.shallow);
    // What the ground throws back into what it shades: a desert bounces warm
    // sand, a tundra cold stone. Second-order, so the colour is kept dark.
    this.atmos.setBounceColor(this.palette.rock);
    this.weather.setMode(this.params.sky.weather);
    // A loaded storm arrives already soaked/settled — ramps are for LIVE
    // weather changes, not for reopening a rainy world dry.
    this.atmos.setRainWet(this.weather.wetTarget);
    this.atmos.setSnowCover(this.weather.snowTarget);
    this.terrain?.setWetness(this.weather.wetTarget);
    this.fire.setRain(this.weather.wetTarget);

    if (!this.sky) {
      this.sky = new Sky({ params: this.params, palette: this.palette, quality: this.quality, atmos: this.atmos });
      // With sky IBL carrying ambient + specular, the hemisphere light drops
      // to a fill so the two don't double-count.
      if (this.skyEnv) this.sky.hemiScale = 0.55;
      this.sky.addTo(this.scene);
    }
    else {
      this.sky.setPalette(this.palette);
      this.sky.setClouds(this.params.sky.cloudCover !== undefined
        ? { cover: this.params.sky.cloudCover, scale: this.params.sky.cloudScale } : {});
      this.sky.setTimeOfDay(this.params.sky.timeOfDay);
      /* AND THE HAZE, which this branch has never pushed. The dome read
         `fog.density` once, in its constructor, and after that only the fog
         SETTER ever told it about a change — so every route that swaps the
         whole world at once (a preset, a world build, a params load) left the
         sky wearing the previous world's air. Press a kingdom after an atoll
         and the horizon was still the atoll's. It also feeds the IBL, since
         envmap.js captures this same dome. */
      this.sky.setHazeAmount(this.params.fog.density, this.params.sky.turbidity);
    }
    this.sky.setWeatherDim(this.params.sky.weather === "clear" ? 1 : 0.55);

    if (this.water) { this.scene.remove(this.water.mesh); this.water.dispose(); }
    this.water = new Water({ params: this.params, palette: this.palette, atmos: this.atmos });
    this.scene.add(this.water.mesh);
    this.water.setSunDir(this.sky.uniforms.uSunDir.value);

    /* The rivers this world carries (params.terrain.rivers): stepped ribbons
       above the one sea plane. A loaded world arrives settled — no run-in. */
    if (this.rivers) { this.scene.remove(this.rivers.group); this.rivers.dispose(); }
    this.rivers = new RiverSurface({ palette: this.palette, atmos: this.atmos });
    this.rivers.setRivers(this.params.terrain.rivers, this.params.water.level || 0);
    this.rivers.setSunDir(this.sky.uniforms.uSunDir.value);
    this.scene.add(this.rivers.group);
    // Quick analytic depth field now; the eroded 513² replaces it when ready.
    // QUICK_FIELD_RES on purpose: this bake runs against the ANALYTIC sampler
    // (thirteen times the cost per sample of a baked one) and is a placeholder
    // the canonical ground replaces seconds later.
    this.water.setTerrainField(bakeHeightField(this.params, QUICK_FIELD_RES, this.sampler));

    /* ── scattered vegetation ──
       Rebuilt with the world, like the grass, and for the same reason: it is
       seated on the heightfield and the heightfield just changed. */
    if (this.scatter) { this.scene.remove(this.scatter.group); this.scatter.dispose(); }
    this.scatter = new Scatter({
      params: this.params, sampler: (x, z) => this.sampleHeight(x, z),
      quality: this.quality, atmos: this.atmos,
      procOf: (id) => this._scatterProc?.(id) || null,
    });
    this.scene.add(this.scatter.group);
    this.rebuildScatter();

    if (this.grass) { this.scene.remove(this.grass.group); this.grass.dispose(); }
    this.grass = new Grass({
      // Indirection, like terrain and props: _refreshSampler REPLACES
      // this.sampler on every sculpt, so a captured snapshot would re-seat
      // tufts on the pre-sculpt ground forever (buried in raised hills,
      // floating over dug hollows).
      params: this.params, sampler: (x, z) => this.sampleHeight(x, z),
      palette: this.palette, quality: this.quality,
    });
    if (this.grass.group) {
      for (const m of this.grass.materials) this.atmos.apply(m);
      // Grass stays out of the water mirror: ninety thousand wind-blown
      // cards are pure fill cost at reflection resolution.
      this.grass.group.traverse((o) => o.layers.set(NO_REFLECT_LAYER));
      this.grass.setViewMode(this.mode === "orbit");
      this.scene.add(this.grass.group);
    }

    // Relight the world's fires from params (y re-seats like props do).
    this._syncFires();

    this._buildPedestal();

    this.props.setSampler((x, z) => this.sampleHeight(x, z));
    this.controllers.walk.setSampler((x, z) => this.sampleHeight(x, z));
    this.controllers.fly.setSampler((x, z) => this.sampleHeight(x, z));

    this.scene.fog.color.copy(this.sky.fogColor);
    this.scene.fog.density = this._fogDensity() * this.atmos.altitudeFactor;
    this._syncAtmosphere();

    this.invalidate();
    this._emit("world", { params: this.params });
    this._kickErosion();
  }

  // Pedestal: closes the world's underside so the finite square presents as
  // a diorama plate instead of a floating crust. Not a box: the side walls
  // rise to the terrain's actual edge heights (tucked under the tiles' own
  // skirts), so no gap ever shows between crust and base. No top face either
  // — the old near-coplanar lid z-fought the water plane at grazing angles.
  _buildPedestal() {
    if (this.pedestal) {
      this.scene.remove(this.pedestal);
      this.pedestal.geometry.dispose(); this.pedestal.material.dispose();
      this.pedestal = null;
    }
    const size = this.params.terrain.size, height = this.params.terrain.height;
    // The rim has to follow the WATERLINE, not the natural coastline. Where a
    // flood is standing, the wall must rise with it or the sea becomes a slab
    // hanging in mid-air over the plate's edge — at a 165 m flood that was a
    // 165 m void all the way round the world.
    const wl = this.params.water.level || 0;
    const s = size / 2, bottom = -0.8 - height * 1.2;
    const SEG = 192; // rim samples per side
    const ring = [];
    for (let k = 0; k < SEG; k++) ring.push([-s + (k / SEG) * size, -s]);
    for (let k = 0; k < SEG; k++) ring.push([s, -s + (k / SEG) * size]);
    for (let k = 0; k < SEG; k++) ring.push([s - (k / SEG) * size, s]);
    for (let k = 0; k < SEG; k++) ring.push([-s, s - (k / SEG) * size]);
    const pos = [], idx = [];
    for (const [x, z] of ring) {
      // Wall top: just under the ground edge; where the edge is underwater,
      // just under the water plane wherever that currently sits.
      pos.push(x, Math.max(this.sampleHeight(x, z) - 2, wl - 0.8), z, x, bottom, z);
    }
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      const a = k * 2, b = a + 1, c = ((k + 1) % n) * 2, d = c + 1;
      idx.push(a, b, c, c, b, d);
    }
    const base = pos.length / 3; // bottom cap
    pos.push(-s, bottom, -s, s, bottom, -s, s, bottom, s, -s, bottom, s);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.pedestal = new THREE.Mesh(
      geo,
      this.atmos.apply(new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.96, side: THREE.DoubleSide }))
    );
    this.pedestal.name = "pedestal";
    this.scene.add(this.pedestal);
  }

  /* ── indirect light ──
     Bakes how much sky each patch of ground can see (terrain/skyvis.js) in a
     worker, then hands the packed texture to the shared atmosphere patch, so
     terrain, grass, trees and placed blocks all receive it from one fetch.

     Kicked after erosion rather than beside it: erosion is what finally
     decides the shape of the land, and sky visibility baked against the
     pre-erosion surface would light gorges that moved. */
  /* Everything that has to be re-derived once the land's shape is settled.

     Sky visibility and the terrain masks answer the same question at the same
     moment — "the ground is final, what follows from it" — and every trigger
     for one is a trigger for the other: a sculpt stroke, an undo, erosion
     finishing, or erosion being switched off so there is nothing to wait for.
     They were going to be called from the same four places forever, so they
     are called from one place instead; a fifth derived bake goes here rather
     than into a fourth site somebody has to remember. */
  _kickGroundBakes() {
    this._kickSkyVisibility();
    this._kickTerrainMasks();
  }

  /* ── the control map ──
     slope, curvature, ambient occlusion and flow accumulation, baked over the
     whole plate and handed to the terrain shader as one RGBA texture.

     None of this is new arithmetic. engine/terrain/masks.js has computed all
     four since it was written for an exporter that no longer exists, which
     left it correct, pure, and called by nothing. What the renderer could
     derive for itself — slope — it already did per-fragment from the normal;
     what it could NOT are the three that need to look further than one
     fragment: curvature needs a Laplacian, AO needs a valley-radius probe,
     and flow accumulation needs every cell in the world sorted by height. A
     fragment shader cannot ask any of those questions. That is the whole
     argument for baking it. */
  _kickTerrainMasks() {
    if (this._masksWorker) { this._masksWorker.terminate(); this._masksWorker = null; }
    const gen = this._generation;
    /* 513, MATCHING THE EROSION GRID, and both halves of that matter.

       Resolution: at 257 over a 4096 m plate this map was 16 m per texel,
       while a max-depth tile at the high tier bakes its vertex AO every 1 m.
       So the "fragment resolution" ambient occlusion layered on top of the
       vertex bake was in fact sixteen times COARSER than it — the opposite of
       what it was added to do — and the curvature was band-limited to
       features of 32 m and up, which shades whole hillsides rather than
       reading as carved. At 8 m per texel both terms describe ground a person
       standing on it can actually see.

       Alignment: erosion runs at 513² over this same extent (_kickErosion),
       and bakeHeightField samples fence-post to fence-post. At 257 every
       sample landed on an EVEN node of the eroded grid and the odd ones were
       dropped with no pre-filter — decimation, not downsampling, and the
       cells it dropped were disproportionately the channel floors that D8
       routing depends on. At 513 the two grids coincide exactly, so flow is
       computed on the surface erosion actually carved.

       Cost: 309 ms of worker (from 90) and 1 MB of texture (from 0.25), plus
       16 ms of main thread for the larger field bake. The bake already waits
       on erosion, which is far longer than either. */
    const res = CANONICAL_RES;
    const field = bakeHeightField(this.params, res, this.sampler);
    // What the erosion pass moved, if it ran for THIS world and on this grid.
    // Same 513², same extent, so cell i is cell i — see the masks worker.
    const delta = this._erosionDelta?.gen === gen && this._erosionDelta.res === res
      ? this._erosionDelta.data : null;
    const worker = new Worker(scriptURL(new URL("./terrain/masks-worker.js", import.meta.url)), { type: "module" });
    this._masksWorker = worker;
    worker.onmessage = (ev) => {
      worker.terminate();
      if (this._masksWorker === worker) this._masksWorker = null;
      if (gen !== this._generation) return;   // world changed while baking
      this._masksTex?.dispose();
      this._erosTex?.dispose();
      const tex = new THREE.DataTexture(new Uint8Array(ev.data.rgba), ev.data.res, ev.data.res, THREE.RGBAFormat);
      // Linear so the canonical grid reads as a smooth field rather than as
      // its own cells; clamped because the plate is finite. NoColorSpace
      // above all: these are measurements, and gamma-decoding a slope would
      // be nonsense that happens to look plausible.
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this._masksTex = tex;
      /* And the second map: deposition and wetness, which are facts about the
         SIMULATION rather than about the surface (masks.js). RG8 because that
         is all two channels need, and unpackAlignment 1 because 513 rows of
         two bytes are not four-byte aligned — the same trap the water's depth
         texture documents, and the same fix. */
      const eros = new THREE.DataTexture(new Uint8Array(ev.data.eros), ev.data.res, ev.data.res,
        THREE.RGFormat, THREE.UnsignedByteType);
      eros.minFilter = eros.magFilter = THREE.LinearFilter;
      eros.wrapS = eros.wrapT = THREE.ClampToEdgeWrapping;
      eros.colorSpace = THREE.NoColorSpace;
      eros.unpackAlignment = 1;
      eros.needsUpdate = true;
      this._erosTex = eros;
      this._masksGen = gen;   // which world this map describes
      this.terrain?.setControlMap(tex, this.params.terrain.size);
      this.terrain?.setErosionMap(eros);
      this.invalidate();
      console.info("[engine] terrain masks baked:", ev.data.res + "²",
        delta ? "(with erosion deposition)" : "(no erosion pass)");
    };
    worker.onerror = (err) => {
      // A world without the control map is the world as it rendered before
      // this existed, so the failure is a downgrade rather than a break.
      console.warn("[engine] terrain-mask bake failed:", err.message);
      worker.terminate();
      if (this._masksWorker === worker) this._masksWorker = null;
    };
    worker.postMessage(
      /* The height field is TRANSFERRED and the delta is not, and the
         asymmetry is deliberate: the field was baked for this message and
         nothing else will read it, while the delta belongs to the world for
         as long as the world lives — a sculpt stroke and an undo each re-kick
         this bake. Leaving it out of the transfer list structured-clones it,
         which is one 1 MB copy per bake against a second stroke finding a
         neutered array and rendering with no deposition at all. */
      { buffer: field.data.buffer, fieldRes: field.res, size: field.size, res,
        delta: delta ? delta.buffer : null },
      [field.data.buffer]);
  }

  /* ── the material stack ──
     Ten seeded albedo+normal layers, generated in a worker and uploaded as
     two DataArrayTextures. Guarded by `_generation` exactly like the two
     bakes above: a stack that finishes after the world it was seeded for has
     been replaced is dropped rather than shown over someone else's ground.

     Falls back to the synchronous generator if the worker cannot start. That
     is a real 420 ms stall, but it happens only where Workers are
     unavailable, and a world with untextured ground would be the more
     visible failure. */
  _kickDetailStack() {
    const gen = this._generation;
    const seed = this.params.seed;
    makeDetailSetAsync(seed, this.quality, () =>
      new Worker(scriptURL(new URL("./terrain/detail-worker.js", import.meta.url)), { type: "module" })
    ).then((set) => {
      /* THE SEED IS THE SET'S IDENTITY, and it is the whole of it — this
         module says so ("The set is keyed by SEED", detail-textures.js) and
         so does the ownership note at the call site in _buildWorld. So the
         generation half of this guard, `gen !== this._generation`, was
         testing the wrong thing, and it threw away sets that were correct.

         What made it more than pedantic: _generation bumps on EVERY
         _buildWorld, which means on every applyParams — and a world build
         issues several of them while this 420 ms bake is in flight. The set
         arrived, was found to belong to an older generation of the same
         seed, and was disposed. Nothing re-kicked, because _buildWorld only
         kicks when the SEED changes and the seed had not: `_detail` stayed
         null and `_detailSeed` stayed set, so the condition that would have
         asked for another bake could never become true again. Every world
         you built then wore flat palette vertex colours for the rest of the
         session — no turf, no strata, no ripples — with nothing logged.

         A set for the current seed is a set for the current world, whatever
         has been rebuilt around it. That is exactly the property the design
         was written to have. */
      if (this._detailSeed !== seed) { set?.dispose(); return; }
      this._detail = set || makeDetailSet(seed, this.quality);
      if (this.quality.terrainDetail) this.terrain?.setDetail(this._detail);
      this.invalidate();
      console.info("[engine] terrain materials baked:", this._detail.count, "layers");
    });
  }

  _kickSkyVisibility() {
    if (this._skyVisWorker) { this._skyVisWorker.terminate(); this._skyVisWorker = null; }
    const gen = this._generation;
    const field = bakeHeightField(this.params, SKYVIS_RES, this.sampler);
    // Through the trusted-types gate: `new Worker(url)` executes code, so it
    // is a script sink like innerHTML is, and it goes through the same door
    // (engine/trusted.js) — which also refuses anything off this origin.
    const worker = new Worker(scriptURL(new URL("./terrain/skyvis-worker.js", import.meta.url)), { type: "module" });
    this._skyVisWorker = worker;
    worker.onmessage = (ev) => {
      worker.terminate();
      if (this._skyVisWorker === worker) this._skyVisWorker = null;
      if (gen !== this._generation) return; // world changed while baking
      const res = ev.data.res;
      this._skyVisTex?.dispose();
      const tex = new THREE.DataTexture(new Uint8Array(ev.data.rgba), res, res, THREE.RGBAFormat);
      // Linear so the gradient is smooth between cells; clamped because the
      // world is a finite plate and there is nothing beyond its edge.
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      // Data, not colour: it must not be gamma-decoded on the way in.
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this._skyVisTex = tex;
      this.atmos.setSkyVisibility(tex, this.params.terrain.size);
      this.invalidate();
      console.info("[engine] sky visibility baked:", res + "²");
    };
    worker.onerror = (err) => {
      console.warn("[engine] sky-visibility bake failed:", err.message);
      worker.terminate();
      if (this._skyVisWorker === worker) this._skyVisWorker = null;
    };
    worker.postMessage(
      { buffer: field.data.buffer, fieldRes: field.res, size: field.size, res: SKYVIS_RES },
      [field.data.buffer]);
  }

  /* What the shadow volume should be centred on.

     Orbiting, that is the orbit target: the camera is outside the world
     looking in, and centring on the lens puts the box behind the subject
     (see Sky.updateShadow). On foot or in flight the camera IS in the scene,
     so the box wants to lead slightly rather than sit on your feet — enough
     that what you walk toward is already shadowed when you get there. */
  _shadowFocus() {
    if (this.mode === "orbit") {
      const t = this.controllers?.orbit?.controls?.target;
      if (t) return t;
    }
    const f = this._focusVec || (this._focusVec = new THREE.Vector3());
    f.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);   // looking straight down
    f.normalize().multiplyScalar(70).add(this.camera.position);
    f.y = this.sampleHeight(f.x, f.z);
    return f;
  }

  /* ══ ADOPTING A GROUND SOMEBODY ELSE ALREADY HAS ══════════════════════════
     The engine's normal life is: params in, terrain derived. That is right
     when the engine is the first thing to render a world, and wrong when it
     is the SECOND — when a world selector has already baked, eroded and drawn
     the very field the visitor just clicked on. Re-deriving there is not a
     refinement; at best it burns a second reproducing a Float32Array that was
     already in the tab, and at worst — if anything about the params reaching
     this engine differs by so much as a frequency — it silently draws a
     different world under the same seed.

     So a caller may hand the engine the ground instead:

         new Engine(canvas, params, { ground })     // at construction
         engine.adoptGround(ground)                 // before the next build

     `ground` is what engine/terrain/canonical.js produces:
     { field, delta, parameterHash? }. It is checked against the params this
     engine actually holds and DROPPED if it describes another world — an
     adopted field that does not match its params would be the same class of
     bug in the other direction. It is also one-shot: consumed by the build it
     arrives for, so a later setSeed derives its own world honestly.

     What this does NOT do is change how the world is drawn. The quadtree
     still tessellates to whatever the camera asks for, the detail stack is
     still baked, the light is still re-derived. Those are render refinements
     over one immutable field, which is the whole distinction. */
  adoptGround(ground) {
    const field = ground?.field;
    if (!field?.data || !field.res) {
      console.warn("[engine] a ground was offered without a field — ignored");
      return false;
    }
    /* THE GROUND'S OWN HASH WINS, when it brought one. That is what lets a
       ground be offered for params the engine does not hold YET — the caller
       about to run applyParams(theseParams) can hand over the field first and
       let the build claim it. `_takeAdoptedGround` re-checks against whatever
       params are actually in play at build time, which is the check that
       matters and the only one that can be right; validating here as well
       just forced every caller to change the params before offering the
       ground, which is an ordering nobody can satisfy through applyParams.

       Without a hash of its own, a ground is taken to describe the params
       standing now — the handoff's case, where the engine was constructed
       around it. */
    const stamp = ground.parameterHash ?? terrainParameterHash(this.params);
    if (field.res !== CANONICAL_RES) {
      console.warn("[engine] the offered ground is", field.res, "² , not", CANONICAL_RES,
        "² — droplet erosion is resolution-dependent, so regenerating instead");
      return false;
    }
    this._adoptedGround = {
      field: { res: field.res, size: field.size, data: field.data, min: field.min, max: field.max },
      delta: ground.delta || null,
      parameterHash: stamp,
    };
    return true;
  }

  /** The adopted ground, if one is still valid for the params in play. Taken
      rather than read: a ground is spent by the build it arrives for. */
  _takeAdoptedGround() {
    const g = this._adoptedGround;
    if (!g) return null;
    this._adoptedGround = null;
    if (g.parameterHash !== terrainParameterHash(this.params)) {
      console.info("[engine] the handed-over ground is not this world's any more — regenerating");
      return null;
    }
    /* The extent, checked HERE rather than at adoption, because this is where
       `this.params` is the params the field will actually be sampled against.
       The hash covers terrain.size, so this only fires if a field arrived
       carrying an extent its own params disagree with — which is a caller
       bug, and worth saying so rather than rendering a stretched world. */
    if (g.field.size !== this.params.terrain.size) {
      console.warn("[engine] the handed-over ground spans", g.field.size, "m but the world is",
        this.params.terrain.size, "m — regenerating instead");
      return null;
    }
    return g;
  }

  /* Whether the land already has its final shape. False for exactly as long
     as an erosion pass is still in flight — after which the base sampler is
     reading the baked field rather than the analytic one. A world with no
     erosion, and a world whose ground was handed over already carved, are
     settled from their first frame, so a caller that waits for the "erosion"
     event without asking this first waits forever on both. */
  get groundSettled() {
    if (!this.params.terrain.erosion?.enabled) return true;
    return this._baseSampler?.kind === "baked";
  }

  /* What THIS engine's terrain is, as numbers — the [EDITOR] half of the
     comparison hero/library.js prints as [PICKER]. Derived from the field the
     engine is actually sampling, never from the params it was asked for, so a
     divergence between the two shows up here rather than in a screenshot. */
  terrainFingerprint(extra = {}) {
    const field = this._baseSampler?.field
      || bakeHeightField(this.params, CANONICAL_RES, this._baseSampler || this.sampler);
    const { wet, flow } = masksFor(field, this.params.water?.level || 0);
    return canonicalTerrainFingerprint({
      params: this.params, field, wet, flow, view: "editor",
      meshRes: this.terrain ? this.terrain.tileRes : null,
      lodLevel: this.terrain
        ? (this.terrain.depthCap ? Math.min(this.terrain.maxDepth, this.terrain.depthCap) : this.terrain.maxDepth)
        : null,
      ...extra,
    });
  }

  /* ── the land has its final shape ──
     ONE landing for the eroded ground, whether it came back from the worker
     or arrived in the visitor's pocket from the page they clicked through
     from. Both paths swap the base sampler, replay the author's strokes over
     the new base, re-cut the terrain to full detail and re-seat everything
     standing on it — and they must do all of that identically, or "the same
     world" would depend on which door it came through. */
  _applyCanonicalGround(field, delta, gen) {
    if (gen !== this._generation) return; // world changed while this was in flight
    /* What the water MOVED, kept for the mask bake that follows. It cannot be
       re-derived from the final surface — a scoured shelf and a buried one
       look the same once the water has gone — and the bake is the only
       consumer, so it is held exactly as long as the world it describes:
       stamped with the generation like _masksTex is, and cleared at the top of
       _kickErosion, which is the one call every world build ends in. */
    this._erosionDelta = delta ? { res: field.res, data: delta, gen } : null;
    this._baseSampler = createBakedSampler(field);
    // Re-replay the strokes against the base that just changed under them:
    // flatten/smooth offsets are computed FROM the base surface, so leaving
    // the analytic-base rasterization in place would make this session's
    // ground differ from a reboot's (VSight, or reopening the same params)
    // by the local erosion delta. Replaying here makes both paths converge
    // on offsets-vs-eroded-base — the determinism the seed promises.
    if (!this.sculpt.empty) {
      this.sculpt.replay(this.params.terrain.sculpt, this._baseSampler);
      this.params.terrain.sculpt = this.sculpt.strokes; // one array, both readers
    }
    this._refreshSampler();
    // Full detail now, and only now: the sampler this rebuild reads is the
    // baked field, which is thirteen times cheaper than the analytic one
    // every pre-erosion tile was built against.
    this.terrain?.setDepthCap(0);
    if (this.terrain) this.terrain.rebuild();       // sampler is an indirection
    if (this.grass) this.grass.setSampler((x, z) => this.sampleHeight(x, z));
    this._buildPedestal(); // rim walls re-seat on the eroded edge heights
    // Water depth must see the sculpt too, or hand-dug bays render as land —
    // and at the same resolution either way, so touching the brush cannot
    // move the shoreline.
    this.water.setTerrainField(this.sculpt.empty ? field : bakeHeightField(this.params, CANONICAL_RES, this.sampler));
    if (this._spawnCoords) this.markSpawn(this._spawnCoords.x, this._spawnCoords.z, { visible: this._spawnVisible !== false }); // re-seat on the eroded ground
    this.props.setSampler((x, z) => this.sampleHeight(x, z));
    this._syncFires(); // flames follow the eroded ground like props do
    this.invalidate();
    this._emit("erosion", { field });
    // The land has its final shape now — light it.
    this._kickGroundBakes();
  }

  /* How deep the quadtree may go while erosion is still running. 2 is 16
     tiles against the expensive analytic sampler instead of 160 — the world
     appears at once, coarse, and is cut to full detail by the rebuild that
     erosion was always going to trigger. See QuadtreeTerrain.setDepthCap. */
  _kickErosion() {
    if (this._erosionWorker) { this._erosionWorker.terminate(); this._erosionWorker = null; }
    /* Whatever the last pass moved described the last world. Cleared HERE and
       only here: a sculpt stroke and an undo both re-bake the masks without
       re-eroding, and they must keep the deposition the world was carved
       with — dropping it there would flatten every channel bed back to bare
       ground the moment somebody touched the brush. */
    this._erosionDelta = null;
    const e = this.params.terrain.erosion;
    const gen = this._generation;

    /* ── the ground somebody already has ──
       BEFORE the analytic bake and before the worker. A caller that handed
       this engine the world's canonical field has handed it the END of this
       method's work, and running the simulation over it again is the one
       thing that would guarantee a different world: erosion is not
       idempotent, and the same droplets over already-carved ground carve
       again. So the handoff lands straight on the shared path and nothing is
       re-derived. See adoptGround. */
    const adopted = this._takeAdoptedGround();
    if (adopted) {
      this.terrain?.setDepthCap(0);      // the land is already at its final shape
      this._applyCanonicalGround(adopted.field, adopted.delta, gen);
      console.info("[engine] ground adopted from the handoff — no terrain was regenerated");
      return;
    }

    // No erosion pass means nothing will reshape the land later, so the
    // indirect-light bake can start against the surface as it stands.
    if (!e.enabled) {
      this.terrain?.setDepthCap(0);      // nothing will re-cut the land
      this._kickGroundBakes();
      return;
    }
    // Erosion IS coming, so every tile built now is about to be discarded.
    this.terrain?.setDepthCap(EROSION_DEPTH_CAP);
    const res = CANONICAL_RES;
    // Erode the BASE surface: sculpt strokes are the author's intent and are
    // re-added on top afterwards, never dissolved by simulated rain.
    const field = bakeHeightField(this.params, res, this._baseSampler);
    const worker = new Worker(scriptURL(new URL("./terrain/erosion-worker.js", import.meta.url)), { type: "module" });
    this._erosionWorker = worker;
    worker.onmessage = (ev) => {
      worker.terminate();
      if (this._erosionWorker === worker) this._erosionWorker = null;
      if (gen !== this._generation) return; // world changed while eroding
      this._applyCanonicalGround(
        { res: ev.data.res, size: ev.data.size, data: new Float32Array(ev.data.buffer) },
        ev.data.delta ? new Float32Array(ev.data.delta) : null,
        gen);
      console.info("[engine] erosion applied:", e.drops, "drops");
    };
    /* A FAILED EROSION PASS MUST STILL RELEASE THE WORLD, and this used to
       warn and stop. Everything the successful path does on the way out was
       therefore skipped for the rest of the session: the quadtree stayed
       pinned at EROSION_DEPTH_CAP — two levels, a couple of hundred metres a
       tile over a four-kilometre plate, visibly blocky and never re-cut — and
       _kickGroundBakes never ran, so there was no sky-visibility bake, no
       control map and no erosion map either. One console.warn, and a world
       that looked broken with nothing on screen saying why (I4).

       The surface itself stays analytic, which is the honest fallback: this
       is the world without its erosion pass, not a wrong one. What it must
       not also be is stuck at two levels of detail with no lighting bakes. */
    worker.onerror = (err) => {
      console.warn("[engine] erosion worker failed — the world keeps its analytic surface:", err.message);
      worker.terminate();
      if (this._erosionWorker === worker) this._erosionWorker = null;
      if (gen !== this._generation) return;   // a newer world already owns the terrain
      this.terrain?.setDepthCap(0);   // same release the no-erosion path makes
      this._kickGroundBakes();
      this.invalidate();
    };
    worker.postMessage(
      { buffer: field.data.buffer, res, size: field.size, erosion: e, seed: seedChannel(this.params.seed, "erosion") },
      [field.data.buffer]
    );
  }

  /* ── public param surface ── */
  applyParams(patch) {
    this.params = mergeParams(this.params, patch);
    this._buildWorld();
  }
  setSeed(seed) {
    const s = normalizeSeed(seed) || randomSeed();
    this.params.seed = s;
    this._buildWorld();
    if (this.mode === "orbit") this.frameWorld();
    this._emit("seed", s);
    return s;
  }
  rollSeed() { return this.setSeed(randomSeed()); }
  // Structure theme: re-dresses every placed builder block procedurally.
  // Cheap (no world rebuild) — the terrain never changes under it.
  setStructureTheme(name) {
    if (!THEMES[name]) return;
    this.params.structure = { ...(this.params.structure || {}), theme: name };
    this._themeName = name;
    this.props.setTheme(THEMES[name]);
    this._emit("structure", name);
    this.invalidate();
  }

  // Flood level: move the waterline over the terrain as it stands. Cheap and
  // non-destructive — no bake and no world rebuild, just a fresh sea-connected
  // mask at the new threshold and one plane moved in y. The land is untouched,
  // so the level can be swept up and back down and the world is unchanged.
  setFloodLevel(y) {
    /* One kind of statement reads the waterline: a shoreline with no `level`
       of its own stands its ground at params.water.level (terrain/
       condition.js). Flooding moves the sea, not the land, so before the
       level moves, the level that ground was solved at is written into each
       such record. The sampler then solves the same rows to the bit, and
       terrainParameterHash hashes a level-less shoreline as the record with
       its level set, so the hash stays put too — the land shown is still
       createHeightSampler(this.params), and a save reopens as the same land.
       A world with no such record is not touched. */
    const intent = this.params.terrain?.intent;
    const was = Number.isFinite(this.params.water.level) ? this.params.water.level : 0;
    if (Array.isArray(intent) && intent.some((r) => r && r.type === "shoreline" && !Number.isFinite(r.level))) {
      this.params.terrain.intent = intent.map((r) => (r && r.type === "shoreline" && !Number.isFinite(r.level) ? { ...r, level: was } : r));
    }
    this.params.water.level = y; // engine.params is authoritative (see setLevel)
    this.water.setLevel(y);
    // The plate's rim is built against the waterline, so it has to move too —
    // otherwise the sea floats over a void at the world's edge. Cheap: 768 rim
    // samples, no terrain rebuild, no re-bake.
    this._buildPedestal();
    this._emit("flood", { level: this.water.level });
    // Everything below the new line wets; everything above dries.
    this.atmos.setWaterline(this.water.level, !!this.params.water.enabled);
    this.terrain?.setWaterline(this.water.level, !!this.params.water.enabled);
    // And the grass: its altitude band and its clearance are measured from
    // the waterline, so raising the sea has to drown the tufts it covers and
    // move the reeds up to the new edge. One re-scatter, on release.
    this.grass?.setWaterline(this.water.level, !!this.params.water.enabled);
    this.invalidate();
  }

  /* ── the lamps, lit or out ──
     Driven by the editor's clock (js/dayclock.js), which is the only thing
     that knows what hour it is. The engine is told, not asked: nothing under
     engine/ has to learn what dusk means. */
  setLampsLit(on) {
    if (this.lamps?.setLit(on)) this.invalidate();
  }

  /* ── weather ──
     "clear" | "rain" | "snow". Travels in params.sky.weather. Rain soaks
     every material in over a few seconds and snow settles over tens of
     seconds — the ramps live in _frame; this just sets the targets. */
  setWeather(mode) {
    if (!["clear", "rain", "snow"].includes(mode)) return;
    this.params.sky.weather = mode;
    this.weather.setMode(mode);
    this.sky.setWeatherDim(mode === "clear" ? 1 : 0.55);
    this._syncAtmosphere();
    this.scene.fog.color.copy(this.sky.fogColor);
    this.invalidate();
    this._emit("weather", mode);
  }

  /* ── fire ──
     Ground fires persist in params.fx.fires and re-seat on the live ground
     like props. igniteProp() also chars the object's own materials — fire
     that burns, not a sticker. */
  _syncFires() {
    this.fire.clear();
    for (const f of this.params.fx.fires) {
      this.fire.addFire({ x: f.x, z: f.z, r: f.r ?? 1.2, uid: f.uid ?? null, y: this.sampleHeight(f.x, f.z) });
      // A world that reloads with fires in it reloads with the ground around
      // them already burnt — the fire did not just start.
      this._igniteNearbyPlants(f.x, f.z, f.r ?? 1.2);
    }
  }

  addFireAt(x, z, { r = 1.2, uid = null } = {}) {
    const rec = { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, r: Math.round(r * 100) / 100 };
    if (uid) rec.uid = uid;
    this.params.fx.fires.push(rec);
    this.fire.addFire({ ...rec, uid: rec.uid ?? null, y: this.sampleHeight(rec.x, rec.z) });
    // Anything green standing in the flames catches: grass burns in the
    // shader (setBurnField), and placed plants char like any other object.
    this._igniteNearbyPlants(rec.x, rec.z, rec.r);
    this.invalidate();
    this._emit("fire", { fires: this.params.fx.fires.length });
    return rec;
  }

  // A ground fire sets light to the vegetation it is standing in. Trees,
  // bushes and hedges only — a fire lit beside a concrete wall does not
  // char the wall, it chars the hedge next to it.
  _igniteNearbyPlants(x, z, r) {
    const reach = r * PLANT_IGNITE_SCALE;
    for (const record of this.props.records()) {
      if (!isPlantRef(record.ref)) continue;
      if (this.fire.isBurning(record.uid)) continue;
      const d = Math.hypot(record.position[0] - x, record.position[2] - z);
      if (d > reach) continue;
      const it = this.props.get(record.uid);
      if (it) this.fire.igniteObject(record.uid, it.object);
    }
  }

  removeFireNear(x, z, maxDist = 6) {
    const list = this.params.fx.fires;
    let best = -1, bd = maxDist;
    for (let i = 0; i < list.length; i++) {
      const d = Math.hypot(list[i].x - x, list[i].z - z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    const [removed] = list.splice(best, 1);
    this._syncFires();
    this.invalidate();
    this._emit("fire", { fires: list.length });
    return removed;
  }

  // Set a placed object alight: a fire sized to its footprint plus
  // progressive charring of its (cloned) materials. The fire record persists
  // in params; the char is session state and stays even after extinguish —
  // burnt is burnt.
  igniteProp(uid) {
    const it = this.props.get(uid);
    if (!it || this.fire.isBurning(uid)) return false;
    const box = new THREE.Box3().setFromObject(it.object);
    const size = box.getSize(new THREE.Vector3());
    const r = Math.min(Math.max(Math.max(size.x, size.z) * 0.32, 0.5), 2.6);
    this.addFireAt(it.object.position.x, it.object.position.z, { r, uid });
    this.fire.igniteObject(uid, it.object);
    this.invalidate();
    return true;
  }

  extinguishProp(uid) {
    this.fire.extinguish(uid);
    this.params.fx.fires = this.params.fx.fires.filter((f) => f.uid !== uid);
    this.invalidate();
    this._emit("fire", { fires: this.params.fx.fires.length });
  }

  isBurning(uid) { return this.fire.isBurning(uid); }

  /* Run every fire forward by `seconds` at once.

     Charring eases in over nine seconds and the scorch ring eats outward on
     the same clock, which is right when you light something and watch it —
     and wrong when a world is supposed to ARRIVE already burnt. This hands
     the fire system the time that is meant to have passed before you got
     here. */
  ageFires(seconds) {
    if (!this.fire.count && !this.fire._burns.size) return;
    this.fire.tick(seconds, this.camera);
    if (this.grass) this.grass.setBurnField(this.fire.burnField());
    this.invalidate();
  }

  // A placement just landed — if its base sits in reachable water, splash.
  /* Re-derive which volumes buildings enclose. Cheap and rare — a world
     build, a placement, a delete — so it hangs off the prop change hook
     rather than off the frame. */
  refreshShelter() {
    const vols = [];
    for (const { record } of this.props.items.values()) {
      if (record.proc?.rooms?.length) vols.push(...shelterVolumes(record, toWorld));
    }
    this.shelter.setVolumes(vols);
    this.fire.setShelterFn((x, y, z) => shelterAt(vols, x, y, z));
    /* The walker needs the same answer the fire does: inside a declared
       interior the terrain stops being a floor, which is the only way a
       player can ever be below ground. See WalkController. */
    if (this.controllers?.walk) {
      this.controllers.walk.indoors = (x, y, z) => shelterAt(vols, x, y, z) === 1;
    }
    const holes = [];
    for (const { record } of this.props.items.values()) {
      if (!record.proc?.rooms?.length) continue;
      holes.push(...aperturesOf(record, toWorld));
      const door = doorApertureOf(record, toWorld);
      if (door) holes.push(door);
    }
    // A shut door and a glazed window keep the weather out; an open one does
    // not, and which is which changes while you are standing there.
    this.ingress.setApertures(holes, (uid) => this.doors.isOpen(uid));
    /* The room probe reads the same two lists — the volumes a building
       encloses and the openings cut in it — so it is fed here rather than
       gathering them a second time. One answer about what a room is and where
       its windows are, shared by the weather and the light. */
    this._roomVols = vols;
    this._roomHoles = holes;
    this._roomIndex = -1;
    this._shelterStale = false;
    const c = this.camera.position;
    this.shelter.update(c.x, c.z, true);
    this._shelterTex.needsUpdate = true;
    const on = vols.length ? this._shelterTex : null;
    this.atmos.setShelter(on, this.shelter);
    this.weather.setShelter(on, this.shelter);
  }

  // Follow the viewer. Redraws only when the camera leaves the cell the
  // window was drawn for, which at 160 m across is every twenty-odd metres.
  _syncShelter(force = false) {
    if (this._shelterStale) { this._shelterStale = false; return this.refreshShelter(), true; }
    const c = this.camera.position;
    if (!this.shelter.update(c.x, c.z, force)) return false;
    this._shelterTex.needsUpdate = true;
    const on = this.shelter.volumes.length ? this._shelterTex : null;
    this.atmos.setShelter(on, this.shelter);
    this.weather.setShelter(on, this.shelter);
    return true;
  }

  /* ── the room you are standing in ──
     Which room, and what it is lit by. The arithmetic is in
     core/room-probe.js and is a function of the HOUR rather than a capture,
     so this can run whenever the light or the camera moves and always be
     right — a cubemap baked at build time would be a photograph of one
     instant in an engine whose sun crosses the sky.

     Returns true when the frame needs redrawing, which is only when the
     probe actually moved: standing still in one room costs a point-in-volume
     test per room and nothing else. */
  _syncRoom(dt) {
    const vols = this._roomVols;
    if (!vols?.length) {
      if (this._roomIndex === -1) return false;
      this._roomIndex = -1;
      this.atmos.setRoomProbe(null);
      return true;
    }
    const c = this.camera.position;
    const idx = roomAt(vols, c.x, c.y, c.z, inVolume);
    if (idx < 0) {
      if (this._roomIndex === -1) return false;
      this._roomIndex = -1;
      this.atmos.setRoomProbe(null);
      return true;
    }

    const v = vols[idx];
    /* Only this room's own openings. An aperture belongs to the volume a step
       inward from it lands in — the same test aperturesOf uses to decide
       which floor the weather falls on — so a hall's windows do not light the
       cellar behind it. */
    const mine = (this._roomHoles || []).filter((a) => apertureBelongsTo(v, a, inVolume));
    const sky = this.sky.fogColor, bounce = this.atmos.uniforms.uSkyBounce.value;
    const sunC = this.sky.sun.color, sunD = this.atmos.uniforms.uAtmSun.value;
    const target = roomProbe(v, mine, {
      sky: [sky.r, sky.g, sky.b],
      bounce: [bounce.r, bounce.g, bounce.b],
      sun: [sunC.r, sunC.g, sunC.b],
      sunDir: [sunD.x, sunD.y, sunD.z],
      night: this.sky.night,
    });

    /* Eased, and the easing is the point. Walking through a doorway changes
       which room you are in on ONE frame, and swapping the ambient with it is
       a flash — the single artefact a change to indirect light is most likely
       to ship. Entering from outdoors starts from the target rather than from
       black, or every threshold would fade up like a loading screen. */
    if (!this._roomProbe || this._roomIndex !== idx) {
      if (!this._roomProbe) this._roomProbe = emptyProbe();
      if (this._roomIndex === -1) blendProbe(this._roomProbe, target, 1);
      this._roomIndex = idx;
    }
    blendProbe(this._roomProbe, target, Math.min(1, (dt || 0.016) * 6));
    this.atmos.setRoomProbe(this._roomProbe);
    return true;
  }

  _propLanded(record, object) {
    if (!this.water || !this.water.mesh.visible) return;
    const level = this.water.level;
    const box = new THREE.Box3().setFromObject(object);
    if (!isFinite(box.min.y) || box.min.y > level - 0.05) return;
    const x = record.position[0], z = record.position[2];
    if (!this.water.underwater(new THREE.Vector3(x, level - 0.01, z))) return;
    const girth = Math.min(Math.max((box.max.x - box.min.x + box.max.z - box.min.z) * 0.2, 0.7), 3);
    this.splash.splashAt(x, level, z, girth);
    this.invalidate();
  }

  // Selection: a mint wire box for click feedback, plus an XYZ translate
  // gizmo (TransformControls) attached to the picked prop — moving a block
  // is done with the axis arrows, Unity-style. Pass null to clear both.
  _ensureGizmo() {
    if (this._gizmo) return this._gizmo;
    const g = new TransformControls(this.camera, this.renderer.domElement);
    g.setMode("translate");
    // Snapping is what turns nudging boxes into assembling a building.
    // Alt suspends it for the odd freehand placement.
    g.translationSnap = 0.5;
    g.rotationSnap = Math.PI / 12; // 15°
    this._snapEnabled = true;
    // The gizmo owns the pointer while an axis is grabbed — the orbit camera
    // must not fight it for the drag.
    g.addEventListener("dragging-changed", (e) => {
      this.controllers.orbit.controls.enabled = !e.value;
      // Re-anchor the delta base at each grab: chip actions (snap, etc.) may
      // have moved the attached object since the last drag.
      if (e.value && g.object) {
        // Grabbing a block that is still easing up out of the ground finishes
        // the arrival on the spot — otherwise the tween keeps writing a
        // position the drag is simultaneously writing, and syncFromObject
        // records whichever won that frame.
        this.markers.cancelArrival(g.object);
        this._gizmoPrev.copy(g.object.position);
      }
      this._emit(e.value ? "gizmo-start" : "gizmo-end", { uids: [...this._selUids] });
    });
    g.addEventListener("change", () => this.invalidate());
    // Group move: the gizmo drags ONE object; every other selected object
    // follows by the same delta, and all records sync.
    g.addEventListener("objectChange", () => {
      const obj = g.object;
      if (!obj) return;
      const delta = obj.position.clone().sub(this._gizmoPrev);
      this._gizmoPrev.copy(obj.position);
      for (const uid of this._selUids) {
        const it = this.props.get(uid);
        if (!it) continue;
        if (it.object !== obj) it.object.position.add(delta);
        this.props.syncFromObject(uid);
      }
    });
    this.scene.add(g.getHelper());
    this._gizmo = g;
    this._gizmoPrev = new THREE.Vector3();
    return g;
  }
  // True while the pointer is over or dragging the gizmo — the shell must
  // ignore its own click/selection handling then.
  gizmoBusy() { return !!this._gizmo && (this._gizmo.dragging || !!this._gizmo.axis); }
  gizmoDragging() { return !!this._gizmo && this._gizmo.dragging; }

  // Alt-held = free placement; otherwise everything lands on the grid.
  setSnap(on) {
    this._snapEnabled = on;
    if (this._gizmo) {
      this._gizmo.translationSnap = on ? 0.5 : null;
      this._gizmo.rotationSnap = on ? Math.PI / 12 : null;
    }
  }
  get snapEnabled() { return this._snapEnabled !== false; }

  /* ── placement target ──
     Where a held block would land: the nearest of the ground and any prop
     under the pointer. Hitting a prop returns the TOP of that prop, so a
     wall stacks flush on a floor instead of sinking into it. XZ lands on a
     half-metre grid unless snapping is suspended. */
  raycastPlacement(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const groundTargets = this.terrain ? this.terrain.group.children : [];
    const g = ray.intersectObjects(groundTargets, false)[0] || null;
    // Stacking may land on a LOCKED block — building against a finished wall
    // is exactly what locking it is for — but never on a hidden one.
    const p = ray.intersectObjects(this.props.pickTargets({ includeLocked: true }), true)[0] || null;

    let point, onProp = false;
    if (p && (!g || p.distance < g.distance)) {
      // Land on the surface of whatever was hit: its box top for an upward
      // face, otherwise the hit point itself (walls, ramps).
      const root = this.props.get(p.object.userData.uid)?.object;
      const up = p.face ? p.face.normal.y > 0.5 : false;
      const box = root ? new THREE.Box3().setFromObject(root) : null;
      point = p.point.clone();
      if (up && box) point.y = box.max.y;
      onProp = true;
    } else if (g) {
      point = g.point.clone();
    } else return null;

    if (this.snapEnabled) {
      point.x = Math.round(point.x * 2) / 2;
      point.z = Math.round(point.z * 2) / 2;
      if (onProp) point.y = Math.round(point.y * 4) / 4;
      else point.y = this.sampleHeight(point.x, point.z); // re-seat after the snap
    } else if (!onProp) {
      point.y = this.sampleHeight(point.x, point.z);
    }
    return { point, onProp };
  }

  /* Accepts one uid, an array of uids, or null.
     Four marks, deliberately redundant, because a gizmo is 40 px of arrows
     and everything else on screen is a mountain range:
       the wire box   — what exactly is selected, at working distance;
       the ground ring — where it stands, readable from above;
       the beacon     — that it exists at all, from anywhere in the world;
       the pin flag   — which of the pins out there is this one.
     The gizmo rides the last UNLOCKED one and moves the whole group. */
  markSelection(uids) {
    for (const h of this._selHelpers || []) {
      this.scene.remove(h);
      h.geometry.dispose();
      h.material.dispose();
    }
    this._selHelpers = [];
    this._selUids = [];
    const marks = [];
    let anchor = null;
    for (const uid of Array.isArray(uids) ? uids : uids ? [uids] : []) {
      const it = this.props.get(uid);
      if (!it) continue;
      this._selUids.push(uid);
      const h = new THREE.BoxHelper(it.object, 0x8fe8c9);
      h.material.transparent = true;
      h.material.opacity = 0.85;
      h.layers.set(NO_REFLECT_LAYER); // editor chrome never reflects in the sea
      this.scene.add(h);
      this._selHelpers.push(h);
      const a = this.props.anchor(uid);
      if (a) marks.push({ x: a.x, y: a.y, z: a.z, radius: a.size * 0.45 });
      // A locked block may be selected — that is how it gets unlocked — but
      // the arrows must not appear on something that refuses to be dragged.
      if (!this.props.isLocked(uid)) anchor = it.object;
    }
    this.markers.setSelection(marks);
    this._pinsDirty = true;
    if (anchor) {
      const g = this._ensureGizmo();
      g.attach(anchor);
      this._gizmoPrev.copy(anchor.position);
    } else if (this._gizmo) {
      this._gizmo.detach();
    }
    this.invalidate();
  }

  /* ── the placement confirmation ──
     Called by the shell the instant a placement lands. Ripple sized from the
     object, beacon standing on it, and the object itself easing up out of
     the ground instead of appearing. Returns the anchor so the shell can put
     its floating label on the same spot. */
  confirmPlacement(uid, { animateIn = true } = {}) {
    const a = this.props.anchor(uid);
    if (!a) return null;
    if (animateIn) this.markers.arrive(this.props.get(uid).object);
    this.markers.confirm({ x: a.x, y: a.y, z: a.z, radius: a.size * 0.5 });
    this._pinsDirty = true;
    this.invalidate();
    this._emit("placed", a);
    return a;
  }

  /* ── the lean ──
     What the camera does the instant something is placed, and it is
     deliberately NOT a focus. Placing ten fence posts with a camera that
     flies to each one is ten flights back; placing one watchtower two
     kilometres out with a camera that does not move at all is the bug this
     whole redesign exists to kill.

     So: work out how many pixels tall the object actually is on screen. If
     it already reads, do nothing — moving a view that was already showing
     the answer is theft. If it does not, close the distance by the LEAST
     amount that makes it read, capped at half of what is left, holding the
     camera's own angle throughout. The author's framing survives, the
     object becomes visible, and the view does not go anywhere they have to
     come back from. Returns the apparent size in pixels before the lean. */
  revealProp(uid, { want = 52 } = {}) {
    const a = this.props.anchor(uid);
    if (!a || this.mode !== "orbit") return 0;
    const centre = new THREE.Vector3(a.x, (a.y + a.top) / 2, a.z);
    const h = this.canvas.clientHeight || innerHeight;
    const perUnit = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const dist = Math.max(this.camera.position.distanceTo(centre), 0.001);
    const px = (a.size * perUnit) / dist;
    /* THE NO-OP IS THE COMMON CASE, and it is the reason repeat placement
       still works. Once the first placement has brought the view to a
       working distance, every subsequent one is already legible and this
       returns without touching the camera — so a fence of ten posts is ten
       clicks and one camera move, not ten. */
    if (px >= want) return px;
    // Only as close as it must be, never closer, and never inside the thing.
    const next = Math.max((a.size * perUnit) / want, a.size * 1.2);
    const dir = this.camera.position.clone().sub(this.controllers.orbit.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.7, 0.6, 0.7);
    dir.normalize();
    if (dir.y < 0.2) { dir.y = 0.2; dir.normalize(); }
    const pos = centre.clone().addScaledVector(dir, next);
    const floor = this.sampleHeight(pos.x, pos.z) + 2;
    if (pos.y < floor) pos.y = floor;
    const ratio = dist / next;
    /* A real journey leaves a way back; a nudge does not. Pushing every
       lean would fill the camera history with a hundred near-identical
       poses and make "back" mean nothing, so only a move that actually
       took the author somewhere is recorded. */
    if (ratio > 1.35) this.pushView();
    this._orbitAround = null;
    // Longer flights get longer, so a dive from world framing reads as
    // travel rather than as a cut with easing on it.
    this.flyTo(pos, centre, Math.round(Math.min(620 + Math.log2(Math.max(ratio, 1)) * 260, 1500)));
    return px;
  }

  // The author's hand outranks any automation: a click that is about to
  // land in the world stops the camera where it is, so what they are aiming
  // at is what they hit.
  cancelFlight() { this._flight = null; this._orbitAround = null; }

  // Frame the camera on a placed prop, close enough that its actual size
  // reads — the "zoom to what I just placed" move.
  focusOnProp(uid, opts = {}) {
    const a = this.props.anchor(uid);
    if (!a) return false;
    this.focusOn(new THREE.Vector3(a.x, (a.y + a.top) / 2, a.z), Math.max(12, a.size * 2.4), opts);
    return true;
  }

  /* ── framing a set ──
     The bounding sphere of every uid handed in, framed at the camera's
     current angle. `frameAllProps` is the same move over everything placed —
     the answer to "I know it's here somewhere", which should never have to
     be a search. Returns how many placements were framed; 0 means there was
     nothing to frame and the world was framed instead. */
  frameProps(uids, opts = {}) {
    const box = new THREE.Box3();
    let n = 0;
    for (const uid of uids || []) {
      const it = this.props.get(uid);
      if (!it) continue;
      box.expandByObject(it.object);
      n++;
    }
    if (!n) { this.frameWorld(true); return 0; }
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 3);
    // Fit the sphere in the vertical fov with a margin, so nothing sits on
    // the edge of frame where the deck and the panels overlap the world.
    const d = (r / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.55;
    this.focusOn(c, Math.max(d, 14), opts);
    return n;
  }
  frameAllProps(opts = {}) {
    return this.frameProps([...this.props.items.keys()].filter((uid) => this.props.isVisible(uid)), opts);
  }

  /* ── orbit around one thing ──
     A slow automatic turn about the focused object: the move that shows an
     object's other three sides without the author having to drag for them.
     Any touch of the controls cancels it, like every other camera automation
     in this engine — the author's hand always wins. */
  orbitAround(uid, { speed = 0.34 } = {}) {
    if (!uid) { this._orbitAround = null; this.invalidate(); return false; }
    const a = this.props.anchor(uid);
    if (!a) return false;
    if (this.mode !== "orbit") this.setMode("orbit");
    this._orbitAround = { uid, speed };
    this.invalidate();
    return true;
  }
  get orbiting() { return this._orbitAround?.uid || null; }

  /* ── where the camera was ──
     Every jump this engine makes on the author's behalf stacks the pose it
     left, so "take me back" is one key rather than an orbit by hand. Bounded:
     a camera history is a convenience, not a document. */
  pushView() {
    if (this.mode !== "orbit") return;
    const t = this.controllers.orbit.controls.target;
    this._viewStack.push({ p: this.camera.position.clone(), t: t.clone() });
    if (this._viewStack.length > 24) this._viewStack.shift();
  }
  returnToPreviousView() {
    const v = this._viewStack.pop();
    if (!v) return false;
    if (this.mode !== "orbit") this.setMode("orbit");
    this._orbitAround = null;
    this.flyTo(v.p, v.t, 900);
    return true;
  }
  get hasPreviousView() { return this._viewStack.length > 0; }

  /* ── the pin cloud ──
     `fn(record)` returns the colour a placement's pin should be — the shell
     owns the catalogue, so the engine asks rather than knowing. */
  setPinPalette(fn) { this._pinColor = fn; this._pinsDirty = true; }
  /* WHICH placements are worth a pin at all. Same shape of question as the
     palette and the same answer: the shell owns the catalogue, so it decides
     and the engine asks. `fn(record, { height, size })` returns false for a
     placement that should carry no pin; the measurements are handed over
     because Props already holds them and a filter that re-derived a bounding
     box per record would walk the whole world on every rebuild.

     The engine keeps ONE rule of its own here, and it is not a catalogue
     question: the selected placement and the newest one always keep their
     pin. Those two are the finding aid actually doing its job, and a filter
     that hid the thing you just selected would be answering a question
     nobody asked. */
  setPinFilter(fn) { this._pinFilter = fn; this._pinsDirty = true; this.invalidate(); }
  setPinsEnabled(on) { this.pins.setEnabled(on); this.invalidate(); }
  get pinsEnabled() { return this.pins.enabled; }
  // How many pins the world would show right now — what the shell asks before
  // deciding that a build has pushed the cloud past being readable.
  get pinCount() { return this.pins.count || 0; }
  _syncPins() {
    this._pinsDirty = false;
    const sel = new Set(this._selUids || []);
    const newest = this._newestUid;
    const filter = this._pinFilter;
    const list = [];
    for (const [uid, it] of this.props.items) {
      if (!this.props.isVisible(uid)) continue;
      const flag = sel.has(uid) ? 1 : uid === newest ? 2 : 0;
      if (!flag && filter && !filter(it.record, {
        height: (it.hAbove || 0) + (it.hBelow || 0),
        size: it.size || 2,
      })) continue;
      list.push({
        x: it.object.position.x,
        y: it.object.position.y + (it.hAbove || 2) + (it.size || 2) * 0.18,
        z: it.object.position.z,
        radius: (it.size || 2) * 0.5,
        color: (this._pinColor ? this._pinColor(it.record) : null) ?? 0x9fb2c4,
        flag,
      });
    }
    this.pins.sync(list);
  }
  // The one placement the "jump to the newest" move goes to; its pin is lit.
  setNewestProp(uid) { this._newestUid = uid || null; this._pinsDirty = true; this.invalidate(); }
  get newestProp() { return this._newestUid || null; }

  /* Project a world point to CSS pixels for the shell's own overlays —
     floating labels, edge-of-screen pointers. `behind` is what stops a label
     for something at your back from being drawn mirrored in front of you. */
  screenPoint(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, behind: v.z > 1, w, h };
  }

  /* ── held block (placement ghost) ──
     Arming a block puts a translucent copy in the world that follows the
     pointer along the ground — "holding" it — until the shell commits the
     placement or cancels. */
  async showGhost(record) {
    this.clearGhost();
    // build() awaits a network fetch for Field Kit blocks, so the user can
    // cancel (Esc) or arm a different block long before it lands. Without a
    // generation token the stale build still runs its tail: it adds itself to
    // the scene AFTER the cancel, and a superseded one is orphaned at
    // y = -1e5 where clearGhost() can never see it again.
    const token = (this._ghostToken = (this._ghostToken || 0) + 1);
    const rec = { ...record }; // build/autoFit mutate their record — keep the caller's clean
    const object = await this.props.build(rec, null);
    if (token !== this._ghostToken) { // cancelled or superseded while streaming
      disposeBuilt(object); // only what this build actually owns — parts are shared
      return;
    }
    object.rotation.set(0, rec.rotationY || 0, 0);
    object.scale.setScalar(rec.scale || 1);
    if (rec.autoFit) this.props.autoFit(object, rec, rec.fit || 6, !!rec.fit); // ghost previews the placed size
    // Both GLB clones and proc parts hand back SHARED materials — fading them
    // in place would fade every placed copy too, so clone first.
    const cloned = [];
    object.traverse((o) => {
      if (o.isMesh) {
        const prev = o.material;
        o.material = prev.clone();
        o.material.transparent = true;
        o.material.opacity = 0.55;
        o.material.depthWrite = false;
        cloned.push(o.material);
        // If this part was past the cache cap it owned `prev`, and nothing
        // else references it now that the clone has taken its place.
        if (o.userData.ownMat) { prev.dispose(); o.userData.ownMat = false; }
      }
    });
    object.position.set(0, -1e5, 0); // parked until the pointer supplies a spot
    object.traverse((o) => o.layers.set(NO_REFLECT_LAYER)); // a held ghost has no mirror image
    const box = new THREE.Box3().setFromObject(object);
    this._ghost = { object, lift: object.position.y - box.min.y, materials: cloned, proc: !!rec.proc };
    this.scene.add(object);
    this.invalidate();
  }
  // Park the held block on a placement target, so the preview stands exactly
  // where — and at the height — it will land.
  moveGhost(point) {
    if (!this._ghost || !point) return;
    this._ghost.object.position.set(point.x, point.y + this._ghost.lift, point.z);
    this.invalidate();
  }
  clearGhost() {
    // Bump first: this cancels any build still in flight, whether or not a
    // ghost is currently mounted.
    this._ghostToken = (this._ghostToken || 0) + 1;
    if (!this._ghost) return;
    this.scene.remove(this._ghost.object);
    for (const m of this._ghost.materials) m.dispose(); // the fade clones are ours
    disposeBuilt(this._ghost.object); // anything else it owns; shared parts are left alone
    this._ghost = null;
    this.invalidate();
  }

  /* ── authored grass ──
     Grass is placed by the dev, never auto-scattered. Patches live in
     params.props.grass.patches so they ride the params object into VSight
     and exports. XZ persists across regenerations; Y re-seats like props. */
  addGrassPatch(x, z, opts = {}) {
    const patch = {
      x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10,
      r: opts.r ?? GRASS_PATCH.r, n: opts.n ?? GRASS_PATCH.n,
    };
    const g = this.params.props.grass;
    if (!g.patches) g.patches = []; // params from a pre-patches record
    g.patches.push(patch);
    if (this.grass) this.grass.rebuild();
    this.invalidate();
    return patch;
  }
  removeGrassPatchNear(x, z, maxDist = GRASS_PATCH.r * 2) {
    const list = this.params.props.grass.patches || [];
    let best = -1, bd = maxDist;
    for (let i = 0; i < list.length; i++) {
      const d = Math.hypot(list[i].x - x, list[i].z - z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    const [removed] = list.splice(best, 1);
    if (this.grass) this.grass.rebuild();
    this.invalidate();
    return removed;
  }
  /* ── scattered vegetation ──
     The catalog lives in the shell (js/props-packs.js), so the engine is
     handed a lookup rather than importing it — the same arrangement the
     props system uses for the blocks it builds. */
  setScatterCatalog(procOf) {
    this._scatterProc = procOf;
    this.rebuildScatter();
  }

  // Re-instance every plant from params.props.scatter. Cheap enough to call
  // on a sculpt commit: it is a few matrix composes per plant, no geometry.
  rebuildScatter() {
    if (!this.scatter || !this._scatterProc) return 0;
    const n = this.scatter.setRecords(
      this.params.props.scatter || [],
      (proc, id) => this.props.buildProcPrototype(proc, id));
    for (const m of this.scatter.materials) this.atmos.apply(m);
    this.invalidate();
    return n;
  }

  scatterCount() { return (this.params.props.scatter || []).length; }

  grassPatchCount() { return (this.params.props.grass.patches || []).length; }
  grassFull() { return !!this.grass?.full; }

  // Unity-standard vegetation settings (detailDistance, detailDensityScale,
  // wind {speed,size,bending,tint}, prototypes). Wind and distances are live
  // uniform updates; density and prototype changes re-place the field — never
  // a world rebuild either way.
  setGrassSettings(patch) {
    this.params.props.grass = mergeParams(this.params.props.grass, patch);
    if (this.grass) {
      this.grass.applySettings();
      // Wind and draw distance are live uniforms; anything that changes WHERE
      // a tuft goes — the density, the species set, the placement rules — has
      // to re-scatter the field.
      if ("detailDensityScale" in patch || "prototypes" in patch || "placement" in patch) this.grass.rebuild();
    }
    this.invalidate();
    this._emit("grass", this.params.props.grass);
  }

  /* Authored spawn marker: the double ring, drawn on the live ground. Pass
     null to clear. Coords persist so erosion and rebuilds re-seat the rings.

     `visible: false` sets the spawn WITHOUT drawing it. A world build already
     answers "where does Play start" by ending its arrival shot over the
     square, and a mint ring at two-thirds opacity is the brightest object on
     screen in a world set at three in the morning. The Spawn tool, where the
     ring is the entire point, still draws it. */
  markSpawn(x, z, { visible = true } = {}) {
    if (this._spawnMark) {
      this.scene.remove(this._spawnMark);
      this._spawnMark.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      this._spawnMark = null;
    }
    this._spawnCoords = x == null ? null : { x, z };
    this._spawnVisible = visible;
    if (x == null || !visible) { this.invalidate(); return; }
    const size = this.params.terrain.size;
    const g = new THREE.Group();
    for (const [r, alpha] of [[size * 0.006, 0.46], [size * 0.011, 0.3]]) {
      g.add(new THREE.Mesh(
        new THREE.RingGeometry(r - Math.max(r * 0.06, 0.28), r, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x8fe8c9, transparent: true, opacity: alpha, depthWrite: false })
      ));
    }
    g.position.set(x, Math.max(this.sampleHeight(x, z), 0) + 0.3, z);
    g.traverse((o) => o.layers.set(NO_REFLECT_LAYER));
    this.scene.add(g);
    this._spawnMark = g;
    this.invalidate();
  }

  // Footprint preview for a site about to be generated: a ring on the ground
  // that follows the pointer. Pass null to clear it.
  showSiteRing(x, z, radius = 20) {
    if (x == null) {
      if (this._siteRing) {
        this.scene.remove(this._siteRing);
        this._siteRing.geometry.dispose();
        this._siteRing.material.dispose();
        this._siteRing = null;
        this.invalidate();
      }
      return;
    }
    if (!this._siteRing || this._siteRing.userData.r !== radius) {
      if (this._siteRing) {
        this.scene.remove(this._siteRing);
        this._siteRing.geometry.dispose();
        this._siteRing.material.dispose();
      }
      this._siteRing = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(0.5, radius - 0.5), radius, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x7fe3c4, transparent: true, opacity: 0.75, depthWrite: false, depthTest: false })
      );
      this._siteRing.renderOrder = 3;
      this._siteRing.userData.r = radius;
      this._siteRing.layers.set(NO_REFLECT_LAYER);
      this.scene.add(this._siteRing);
    }
    this._siteRing.position.set(x, Math.max(this.sampleHeight(x, z), 0) + 0.4, z);
    this.invalidate();
  }

  /* A solved course, drawn as a ghost — the river tool's preview, and the
     sibling of showSiteRing above: the site ring says "this circle of ground",
     this says "this line of water". `points` is [[x, z] …] (a third element is
     ignored — the ghost drapes on the GROUND, because what it previews is
     where the channel will be carved, not where the water will stand). A
     pulse ring marks the far end: the mouth, which is the answer the preview
     exists to show. `null` clears. */
  showPathGhost(points) {
    if (!points || points.length < 2) {
      if (this._pathGhost) {
        this.scene.remove(this._pathGhost);
        for (const c of this._pathGhost.children) { c.geometry.dispose(); c.material.dispose(); }
        this._pathGhost = null;
        this.invalidate();
      }
      return;
    }
    if (this._pathGhost) {
      this.scene.remove(this._pathGhost);
      for (const c of this._pathGhost.children) { c.geometry.dispose(); c.material.dispose(); }
    }
    const group = new THREE.Group();
    const pos = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      const [x, z] = points[i];
      pos[i * 3] = x;
      pos[i * 3 + 1] = Math.max(this.sampleHeight(x, z), this.water?.level ?? 0) + 0.6;
      pos[i * 3 + 2] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x7fd4e8, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false,
    }));
    line.renderOrder = 3;
    line.layers.set(NO_REFLECT_LAYER);
    group.add(line);
    const [mx, mz] = points[points.length - 1];
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.5, 6, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x7fd4e8, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false })
    );
    ring.position.set(mx, Math.max(this.sampleHeight(mx, mz), this.water?.level ?? 0) + 0.6, mz);
    ring.renderOrder = 3;
    ring.layers.set(NO_REFLECT_LAYER);
    group.add(ring);
    this._pathGhost = group;
    this.scene.add(group);
    this.invalidate();
  }

  // The default orbit view: the whole world framed as a diorama plate —
  // three-quarter angle, ~22° elevation, the full square in shot.
  // `animated` flies there smoothly instead of cutting.
  frameWorld(animated = false) {
    const s = this.params.terrain.size;
    /* THE SAME DISTANCE AND ELEVATION AS EVER — a diorama plate seen from a
       three-quarter angle, the full square in shot — but SWUNG so the light
       comes over the camera's shoulder.

       This used to be three axis multipliers, (0.5, 0.42, 0.85)·size, and it
       was the one camera decision in the codebase that did not consult the
       sun. js/cinematic.js states the rule its every shot is solved against
       ("thirty to seventy degrees off axis… into the sun is worse: a backlit
       town renders as a black mass") and js/gate.js composes the entry film
       the same way; sunDirection() exists to serve exactly this. Meanwhile
       the sun's azimuth is pinned to the −z half at every hour (sky/sun.js),
       and this pose stood at +x +z looking back through the origin — so the
       default shot faced the sun on every world, and on an evening world it
       framed the disc, its horizon halo and the lens ghosts dead centre over
       ground that was taking no direct light at all. That is what a visitor
       arriving from the library was landing in.

       So: keep the radius and the height, take the bearing from the sun. The
       camera STANDS on the sun's side of the world — that is what puts the
       light behind the lens — offset far enough round that it rakes across
       the relief instead of flattening it. At noon, where the sun is
       overhead and its bearing means little, the offset simply picks a
       corner and the shot is the diorama it always was. */
    const r = Math.hypot(0.5, 0.85), sun = this.sunDirection();
    const a = Math.atan2(sun.x, -sun.z) + SHOULDER_OFFSET;
    const pos = new THREE.Vector3(Math.sin(a) * r * s, s * 0.42, -Math.cos(a) * r * s);
    const tgt = new THREE.Vector3(0, 0, 0);
    this._orbitAround = null;
    if (animated) { this.pushView(); return this.flyTo(pos, tgt); }
    this._flight = null;
    this.camera.position.copy(pos);
    this.controllers.orbit.controls.target.copy(tgt);
    this.controllers.orbit.controls.update();
    this.invalidate();
  }

  /* ── cinematic camera flight (orbit mode) ──
     Cancelled the moment the user grabs the controls — their input always
     wins. Accepts Vector3s or plain [x, y, z] arrays, so the shell can
     describe a camera pose without importing three.

     TWO THINGS A STRAIGHT LERP CANNOT DO, and both of them are the difference
     between a camera move and a slide.

     `curve: "orbit"` interpolates the camera's position in CYLINDRICAL
     coordinates about the (also interpolating) target rather than in a
     straight line through the world. Two poses on opposite sides of a castle
     are two points on a circle, and the chord between them passes through the
     castle: a linear tween cuts the corner, loses the subject behind the
     geometry halfway, and arrives having read as a teleport with easing on
     it. Interpolating the ANGLE instead gives the arc a crane on a track
     would draw, and the parallax that arc produces is most of what makes a
     shot look expensive.

     `ease` decides where the velocity goes. The default eases in AND out,
     which is right for a move that stands alone and wrong for every move in
     a sequence: a shot that decelerates to a dead stop before the cut reads
     as the camera running out of film. A leg that continues the motion asks
     for "in", one that lands asks for "out".                               */
  flyTo(position, target, duration = 1600, { ease = "inOut", curve = "line" } = {}) {
    const v = (p) => (Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : p.clone());
    const c = this.controllers.orbit.controls;
    const fromP = this.camera.position.clone(), fromT = c.target.clone();
    const toP = v(position), toT = v(target);
    const f = { fromP, fromT, toP, toT, t: 0, duration, ease, curve };
    if (curve === "orbit") {
      // Polar decomposition, each end about ITS OWN target, so a move that
      // also travels across the map still arcs about the thing it is watching.
      const a = polarOf(fromP, fromT), b = polarOf(toP, toT);
      // The short way round. Sweeping 350° to save 10° is the one bug this
      // whole coordinate change exists to avoid.
      let d = b.a - a.a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      f.polar = { a0: a.a, da: d, r0: a.r, r1: b.r, y0: a.y, y1: b.y };
    }
    this._flight = f;
    this.invalidate();
  }
  setBiome(name) {
    if (!PALETTES[name]) return;
    this.params.biome = name;
    if (this.terrain) this.terrain.setPalette(this.palette);
    // Same contract as the plate's: re-run the ramp over held elevations and
    // shades rather than re-sampling the field for a colour change.
    this.sky.setPalette(this.palette);
    this.water.setPalette(this.palette);
    this.rivers?.setPalette(this.palette);
    if (this.grass) this.grass.setPalette(this.palette);
    this.atmos.setCausticColor(this.palette.water.shallow);
    this.atmos.setBounceColor(this.palette.rock); // the bounce follows the biome
    this.scene.fog.color.copy(this.sky.fogColor);
    this._syncAtmosphere();
    this.invalidate();
    this._emit("world", { params: this.params });
  }
  // Haze dial: 0 = clear to the horizon, 1 = heavy. Drives the aerial
  // perspective, the residual ground fog and the sky's horizon band as one
  // value, and needs no world rebuild — safe to run live off a slider.
  setFog(density) {
    this.params.fog.density = Math.max(0, density);
    this.atmos.setWorld(this.params);
    this.scene.fog.density = this._fogDensity() * this.atmos.altitudeFactor;
    this.sky.setHazeAmount(this.params.fog.density, this.params.sky.turbidity);
    this._envDirty = true; // the horizon band lives in the IBL capture too
    this.invalidate();
    this._emit("fog", this.params.fog.density);
  }

  setTimeOfDay(tod) {
    /* WRITTEN TO PARAMS FIRST, because params is what gets saved and what a
       rebuild re-reads — and this used to write neither. Sky keeps its own
       reference to a params object, and `applyParams` replaces the engine's
       with a merged copy, so after any param change Sky was holding an
       orphan: the hour moved on screen, `engine.params.sky.timeOfDay` stayed
       where it was, and the file written from it carried an hour the world
       had not been at for some time. */
    this.params.sky.timeOfDay = tod;
    this.sky.setTimeOfDay(tod);
    this.water.setSunDir(this.sky.uniforms.uSunDir.value);
    this.rivers?.setSunDir(this.sky.uniforms.uSunDir.value);
    this.scene.fog.color.copy(this.sky.fogColor);
    this._syncAtmosphere();
    this.invalidate();
    this._emit("timeofday", tod);
  }

  setMode(mode, spawn = null) {
    if (!this.controllers[mode]) return;
    const prev = this.controllers[this.mode];
    if (prev.deactivate) prev.deactivate(); else prev.enabled = false;
    this.mode = mode;
    const next = this.controllers[mode];
    if (next.activate) next.activate(spawn); else next.enabled = true;
    // Orbit shows every painted patch (authoring view); on foot the authored
    // detailDistance fades grass out, the same behaviour the export ships.
    if (this.grass) this.grass.setViewMode(mode === "orbit");
    if (this.touch) {
      if (mode === "orbit") this.touch.detach();
      else this.touch.attach(next);
    }
    this.invalidate();
    this._emit("mode", mode);
  }

  /* ── queries the shell uses ── */
  raycastGround(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const targets = this.terrain ? this.terrain.group.children : [];
    // Not [0]: a tile's geometry ends in a skirt wall, and a grazing ray can
    // strike a nearer tile's skirt before the ground the pointer is actually
    // over — handing the brush, the site ring, the ghost and the spawn marker
    // a point metres below and beside the real surface. terrain/pick.js walks
    // the distance-sorted hits to the first one on a SURFACE triangle.
    const hit = firstGroundHit(ray.intersectObjects(targets, false));
    return hit ? hit.point : null;
  }
  raycastProps(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    // Hidden placements are not in the world as far as the pointer is
    // concerned, and locked ones refuse to be picked — that is what the lock
    // is for. Three's raycaster does not consult `visible`, so the filtering
    // has to happen here rather than being assumed.
    const hit = ray.intersectObjects(this.props.pickTargets(), true)[0];
    return hit ? { uid: hit.object.userData.uid, point: hit.point } : null;
  }

  /* ── going somewhere, without losing where you were ──
     The camera KEEPS ITS ANGLE and changes only what it is looking at and
     how far away it is. A focus that also swings you round to a canonical
     three-quarter view is the move that makes people lose the world: the
     ground they were reading rotates under them and they have to rebuild the
     picture. Same angle, new subject — that is the difference between being
     taken somewhere and being teleported.

     It flies rather than cuts, for the same reason. Cutting is free and
     costs the author the connection between where they were and where they
     are; 900 ms of eased travel keeps it. */
  focusOn(point, distance = 40, { animated = true, duration = 900 } = {}) {
    if (this.mode !== "orbit") this.setMode("orbit");
    this._orbitAround = null;
    this.pushView(); // every jump leaves a way back
    const target = point.isVector3 ? point.clone() : new THREE.Vector3(point[0], point[1], point[2]);
    const dir = this.camera.position.clone().sub(this.controllers.orbit.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.7, 0.6, 0.7);
    dir.normalize();
    // Never end the move underground or looking up from below the sea.
    if (dir.y < 0.22) { dir.y = 0.22; dir.normalize(); }
    const pos = target.clone().addScaledVector(dir, distance);
    const floor = this.sampleHeight(pos.x, pos.z) + 2;
    if (pos.y < floor) pos.y = floor;
    if (!animated) {
      this._flight = null;
      this.camera.position.copy(pos);
      this.controllers.orbit.controls.target.copy(target);
      this.controllers.orbit.controls.update();
      this.invalidate();
      return;
    }
    this.flyTo(pos, target, duration);
  }
  // Frame a patch of ground rather than a single object — how a generated
  // site is presented once it lands.
  focusOnArea(x, z, radius = 20) {
    this.focusOn(new THREE.Vector3(x, this.sampleHeight(x, z), z), Math.max(24, radius * 2.8));
  }
  travelTo(x, z) {
    const y = this.sampleHeight(x, z);
    this.focusOn(new THREE.Vector3(x, Math.max(y, 0), z), this.params.terrain.height * 1.2);
  }
  getViewer() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    const t = this.mode === "orbit" ? this.controllers.orbit.controls.target : this.camera.position;
    return { x: t.x, z: t.z, yaw: e.y };
  }
  /* Where the sun is, as a unit vector — the one number a shell needs to
     place a camera with respect to the light instead of the world's axes
     (js/gate.js composes every entry shot against it). Read from the sky's
     own uniform rather than re-derived from the hour, so there is exactly
     one sun model in the codebase. */
  sunDirection() {
    const d = this.sky.uniforms.uSunDir.value;
    return { x: d.x, y: d.y, z: d.z };
  }

  /* ── E ──
     One key, three registries, in the order a person would expect: stand up
     if you are sitting, else swing the door you are looking at, else use
     whatever the placement in front of you says it is for.

     Doors first among the two registries because a leaf is the biggest thing
     in any doorway and losing a door to a candle beside it would be
     maddening; standing up first of all because a player who has sat down and
     pressed E again has asked exactly one thing.

     None of it is world state. Which doors are open, which chairs are sat in
     and which candles are burning never enter params, so a world still
     reloads identically and an export still carries a room. */
  interact() {
    if (this.mode === "orbit") return null;
    const walk = this.controllers.walk;
    if (walk?.seated) {
      walk.stand();
      this.invalidate();
      this._emit("use", { kind: "stand" });
      return null;
    }
    const uid = this.doors.interact(this.camera);
    if (uid) {
      this.invalidate();
      this._emit("door", { uid, open: this.doors.isOpen(uid) });
      return uid;
    }
    const act = this.fittings.use(this.camera);
    if (!act) return null;
    if ((act.kind === "sit" || act.kind === "rest") && !walk?.sit(act.pose)) return null;
    this.invalidate();
    if (act.kind === "light") this._needsShadow = true;   // a flame going out moves shadows
    this._emit("use", act);
    return act.uid;
  }

  // What the crosshair is on, as a line to show: {verb, label} or null. The
  // engine draws no HUD, so this is the whole of its side of the contract.
  usesPrompt() {
    if (this.mode === "orbit") return null;
    if (this.controllers.walk?.seated) return { verb: "Stand", label: "" };
    return this.fittings.promptFor(this.fittings.pick(this.camera));
  }

  /* ── frame ── */
  _frame() {
    /* Clamped at the one place every animation in the engine draws its step
       from, because the gap between two frames is not bounded by anything the
       engine controls — see MAX_FRAME_DT. Unclamped, the first frame back
       from a backgrounded tab aged every fire by the whole absence, spun the
       auto-orbit through however many turns five minutes buys, and jumped
       each wave, wind and caustic phase to an unrelated point in its cycle.
       The two controllers and the day clock had each already clamped their
       own copy; everything else downstream of here had not. */
    const dt = Math.min(this._clock.getDelta(), MAX_FRAME_DT);
    /* A backgrounded tab must not keep driving the GPU. Belt and braces
       rather than the whole defence: a hidden document normally gets no
       rendering opportunities and so never reaches this line at all. It earns
       its place where one is granted anyway — a window merely occluded, or a
       browser configured to keep animating hidden documents. */
    if (typeof document !== "undefined" && document.hidden) return;
    const ctl = this.controllers[this.mode];
    if (ctl.update && ctl.update(dt)) this._needsRender = true;
    if (this.doors.update(dt)) { this._needsRender = true; this._needsShadow = true; } // a swinging leaf
    if (this._flight && this.mode === "orbit") {
      const f = this._flight;
      f.t += dt * 1000;
      const k = Math.min(f.t / f.duration, 1);
      const e = EASES[f.ease] ? EASES[f.ease](k) : EASES.inOut(k);
      const tgt = this.controllers.orbit.controls.target;
      tgt.lerpVectors(f.fromT, f.toT, e);
      if (f.polar) {
        const p = f.polar;
        const a = p.a0 + p.da * e;
        const r = p.r0 + (p.r1 - p.r0) * e;
        this.camera.position.set(tgt.x + Math.cos(a) * r, p.y0 + (p.y1 - p.y0) * e, tgt.z + Math.sin(a) * r);
      } else {
        this.camera.position.lerpVectors(f.fromP, f.toP, e);
      }
      if (k >= 1) this._flight = null;
      this._needsRender = true;
    }
    /* The automatic orbit. It runs only when nothing else is driving the
       camera: a flight in progress owns the pose, and the author's own drag
       has already cleared this on the controls' "start" event. The target is
       re-read from the object every frame, so orbiting something that is
       being nudged with the arrow keys follows it. */
    if (this._orbitAround && this.mode === "orbit" && !this._flight) {
      const a = this.props.anchor(this._orbitAround.uid);
      if (!a) this._orbitAround = null;
      else {
        const c = this.controllers.orbit.controls;
        const centre = new THREE.Vector3(a.x, (a.y + a.top) / 2, a.z);
        const off = this.camera.position.clone().sub(c.target);
        const ang = this._orbitAround.speed * dt;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const nx = off.x * cos - off.z * sin, nz = off.x * sin + off.z * cos;
        c.target.lerp(centre, Math.min(dt * 4, 1)); // eases onto the subject, never snaps
        this.camera.position.set(c.target.x + nx, c.target.y + off.y, c.target.z + nz);
        this._needsRender = true;
      }
    }
    if (this.mode === "orbit") {
      this.controllers.orbit.update();
      // Keep the orbit camera above the GROUND (diving below the water
      // surface is allowed — that's the underwater view; clipping through
      // terrain shows backfaces and skirts and is never intentional).
      const p = this.camera.position;
      const floor = this.sampleHeight(p.x, p.z) + 1.5;
      if (p.y < floor) { p.y = floor; this._needsRender = true; }
    }

    // camera moved far enough that the level of detail under it changed.
    if (this.terrain && this.terrain.update(this.camera.position)) { this._needsRender = true; this._needsShadow = true; }

    // Air thins with altitude, and the shadow box follows the viewer.
    const groundY = this.sampleHeight(this.camera.position.x, this.camera.position.z);
    const altitude = Math.max(this.camera.position.y - groundY, 0);
    if (this.atmos.setAltitude(altitude)) {
      this.scene.fog.density = this._fogDensity() * this.atmos.altitudeFactor;
      this._needsRender = true;
    }
    // The shadow box re-centred on the SUBJECT — the map has to be redrawn.
    if (this.sky.updateShadow(this.camera.position, groundY, this._shadowFocus())) {
      this._needsRender = true; this._needsShadow = true;
    }

    const animating = this.quality.ambientAnimation || this.mode !== "orbit";
    if (animating) {
      this.sky.tick(dt);
      this.water.tick(dt);
      this.atmos.tick(dt); // caustic clock rides ambient animation
      if (this.grass) this.grass.tick(dt);
      if (this.scatter) this.scatter.tick(dt);
      this._needsRender = true;
    }
    // Cards turn toward the viewer and fade against it in BOTH passes, so
    // the position has to reach the shader explicitly (grass/_vertexProgram).
    if (this.grass) this.grass.setViewPosition(this.camera.position);
    // A flood front keeps its own clock. Ambient animation is off entirely on
    // the low tier and in orbit mode, and watching the water arrive is the
    // whole point of the feature — it must not depend on wind being enabled.
    if (this.water.tickFlood(dt)) this._needsRender = true;
    // The rivers' run-in rides the same clock and the same rule.
    if (this.rivers?.tick(dt)) this._needsRender = true;

    /* ── FX clocks — like the flood front, these run on every tier: a fire
       the author lit must burn even where ambient wind is disabled. ── */
    if (this._syncShelter()) this._needsRender = true;
    // …and which room that shelter is, for the light inside it.
    if (this._syncRoom(dt)) this._needsRender = true;
    if (this.fire.tick(dt, this.camera)) this._needsRender = true;
    if (this.lamps.tick(this.camera)) this._needsRender = true;
    // The heat field the grass shader burns from. Cheap to recompute (a few
    // floats per fire) and it only forces a redraw when it actually changed,
    // so a world with no fires costs nothing.
    const burn = this.fire.burnField();
    if (this.grass && this.grass.setBurnField(burn)) this._needsRender = true;
    if (this.scatter && this.scatter.setBurnField(burn)) this._needsRender = true;
    if (this.weather.tick(dt, this.camera, this.sky.night, !!this._wasUnder)) this._needsRender = true;
    if (this.weather.needsReseed(this.camera)) {
      this.weather.reseedFireflies(this.camera, (x, z) => this.sampleHeight(x, z));
    }
    if (this.splash.tick(dt)) this._needsRender = true;
    /* The discovery layer. The marks animate; the pins do not — they are
       rebuilt only when the set of placements changed, and their fade lives
       in the shader, which is what lets the cloud scale to thousands
       without costing a frame. An arriving object changes its own silhouette,
       so that one does move the shadow map. */
    if (this._pinsDirty) { this._syncPins(); this._needsRender = true; }
    if (this.markers.tick(dt, this.camera)) {
      this._needsRender = true;
      if (this.markers.arriving) this._needsShadow = true;
    }

        // Rain soaks in over ~4s; snow settles over ~18s and melts as slowly.
    const uR = this.atmos.uniforms.uWfRain, uS = this.atmos.uniforms.uWfSnow;
    const stepTo = (u, target, rate) => {
      if (Math.abs(u.value - target) < 0.002) { u.value = target; return false; }
      u.value += Math.sign(target - u.value) * Math.min(dt * rate, Math.abs(target - u.value));
      return true;
    };
    if (stepTo(uR, this.weather.wetTarget, 1 / 4)) this._needsRender = true;
    if (stepTo(uS, this.weather.snowTarget, 1 / 18)) this._needsRender = true;
    this.fire.setRain(uR.value);   // a fire feels the storm arrive, not the forecast
    // …and so does the ground: wet terrain is a roughness change, not a tint,
    // so it rides the same ramp rather than a second one that could disagree.
    this.terrain?.setWetness(uR.value);
    this.ingress.setRain(uR.value);
    if (this.ingress.tick(dt, this.camera)) this._needsRender = true;
    // The player breaking the surface splashes — the audible half already
    // lives in the sound bank; this is the visible half.
    const ctlSwim = !!this.controllers[this.mode].swimming;
    if (ctlSwim && !this._wasSwimming) {
      this.splash.splashAt(this.camera.position.x, this.water.level, this.camera.position.z, 1);
      this._needsRender = true;
    }
    this._wasSwimming = ctlSwim;

    /* Sky IBL refresh: debounced so a time-of-day drag re-captures a few
       times a second, not per input event — and captured SMALL while the
       light is still moving, because every capture allocates and frees a
       whole mip-chained PMREM target that three offers no way to reuse.

       The pacing lives in render/env-pacer.js, pure and unit-driven, because
       it is a decision about a SEQUENCE of frames rather than about any one
       of them: the two ways it has already been got wrong each produced a
       perfectly reasonable single frame and a pathological pattern across
       several. That file carries the reasoning; the suite drives it with
       synthetic frames, which is the only place it can be tested at all — on
       the software rasteriser this repository's browser tools run against, a
       single frame takes between 0.7 and 2.6 seconds, so a drag arrives
       faster than frames do and cannot be reproduced there. */
    if (this.skyEnv) {
      const envSize = envCapture(this._envPacer, dt, this._envDirty);
      if (envSize) {
        this.skyEnv.update(this.scene, this.sky, { size: envSize });
        this._envDirty = false;
        this._needsRender = true;
      }
    }

    // Interiors are hidden until you are near enough to be in the room. Cheap
    // (it early-outs unless the camera actually moved) and it only toggles
    // visibility, so every piece stays selectable and editable.
    if (this.props?.cullNear(this.camera)) this._needsRender = true;

    /* Vegetation visibility. The batches span the world, so three's own
       frustum test cannot help them and every plant used to be submitted
       every frame — the wood behind you and the wood over the horizon
       included. This compacts each batch down to the plants worth drawing.

       It runs BEFORE the early-out, and before the shadow pass below, because
       the shadow map and the colour pass read the same `mesh.count`: culling
       after the shadow map was drawn would light the frame with shadows from
       plants it is no longer drawing. The sun is handed in so that a
       caster standing behind the camera survives when its SHADOW reaches the
       shot — losing those is a far worse artefact than the cost of keeping
       them, and the shadow radius bounds how far that courtesy extends. */
    if (this.scatter?.cull(this.camera, {
      sunDir: this.atmos?.uniforms.uAtmSun.value,
      shadowRadius: this.sky?.shadowRadius ?? 0,
    })) this._needsRender = true;

    if (!this._needsRender) return; // on-demand: skip the draw entirely
    this._needsRender = false;
    // Redraw the shadow map only when a caster (or the shadow box) actually
    // moved — not for wind, waves or drifting cloud.
    if (this._needsShadow) {
      this.renderer.shadowMap.needsUpdate = true;
      this._needsShadow = false;
      /* A stale history is worse than no history: quadtree tiles swapping
         LOD, a rebuilt grass field or a newly placed block all change what
         is UNDER the pixel, and averaging the before and after leaves blocks
         of the old world smeared across the new one.

         _needsShadow is exactly the right signal and already carries exactly
         the right meaning — "a caster or the geometry moved". */
    }
    for (const h of this._selHelpers || []) h.update(); // re-fit to the (possibly transformed) props

    // Underwater pass: swap fog + exposure while the camera is submerged.
    const under = this.water.underwater(this.camera.position);
    if (under !== this._wasUnder) {
      this._wasUnder = under;
      this.atmos.setUnderwater(under);
      this.scene.fog.color.copy(under ? new THREE.Color(this.palette.water.deep) : this.sky.fogColor);
      // Dense enough that the murk closes in within ~60m — unmistakably
      // submerged, with the water's underside as a lit ceiling overhead.
      this.scene.fog.density = under ? Math.max(this._fogDensity() * 70, 0.018) : this._fogDensity();
      this.renderer.toneMappingExposure = under ? 0.62 : 1.05;
      this.atmos.uniforms.uExposure.value = this.renderer.toneMappingExposure; // sky + water follow
    }

    // Planar water mirror, rendered first so the sea reflects THIS frame's
    // world. Only on frames that draw anyway, only from above the surface.
    if (this.waterRefl && this.water.mesh.visible && !under) {
      const hidden = [this.water.mesh, this._ghost?.object];
      const ok = this.waterRefl.render(this.renderer, this.scene, this.camera, this.water.level, hidden);
      this.water.setReflection(ok ? this.waterRefl.target.texture : null, this.waterRefl.textureMatrix);
    } else if (this.waterRefl) {
      this.water.setReflection(null);
    }

    this.renderer.render(this.scene, this.camera);
    // Overlay pass (e.g. an FPS viewmodel with its own near plane): drawn
    // after the world with a cleared depth buffer so it never clips.
    // autoClear MUST be off for the overlay render — three clears the color
    // buffer on every render() by default, which would erase the world and
    // leave the overlay floating on black.
    if (this.overlayPass) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.overlayPass(this.renderer, dt);
      this.renderer.autoClear = true;
    }
    this._emit("frame", null);
  }

  requestRender() { this.invalidate(); }

  /* Stop drawing entirely while something bulk-loads.

     A world build adds several hundred objects in a row. Every one of them
     invalidates, and with temporal accumulation running the loop answers by
     redrawing continuously — so the frame budget is spent rendering states
     nobody will ever see, and the build competes with itself for the GPU.
     Pausing turns that into one draw at the end, of the finished world. */
  setPaused(on) {
    if (on) { this._running = false; return; }
    if (this._running) return;
    this._running = true;
    this._clock.getDelta(); // drop the paused span so nothing lurches on resume
    this.invalidate();
    this._schedule();
  }
  get paused() { return !this._running; }

  dispose() {
    this._running = false;
    removeEventListener("resize", this._resize);
    removeEventListener("keydown", this._onInteractKey);
    this.canvas.removeEventListener("webglcontextlost", this._onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this._onContextRestored);
    this.clearGhost();
    if (this._gizmo) this._gizmo.dispose();
    if (this.touch) this.touch.dispose();
    if (this._erosionWorker) this._erosionWorker.terminate();
    if (this._skyVisWorker) this._skyVisWorker.terminate();
    this._skyVisTex?.dispose();
    if (this._masksWorker) this._masksWorker.terminate();
    this._masksTex?.dispose();
    this._erosTex?.dispose();
    for (const c of Object.values(this.controllers)) c.dispose();
    if (this.terrain) this.terrain.dispose();
    this.sky.dispose(); this.water.dispose();
    if (this.grass) this.grass.dispose();
    if (this.scatter) this.scatter.dispose();
    this.skyEnv?.dispose();
    this.waterRefl?.dispose();
    this.fire.dispose();
    this.weather.dispose();
    this.splash.dispose();
    this.markers.dispose();
    this.pins.dispose();
    this._detail?.dispose();
    this.renderer.dispose();
  }
}

/* ── easing ──
   Four curves, named for what a shot needs rather than for their formula.
   `inOut` is the standalone move; `in` accelerates away from a cut and hands
   its speed to whatever comes next; `out` catches a moving camera and sets it
   down; `linear` is for a leg that is one continuous sweep with its own
   deceleration built into the geometry. */
const EASES = {
  linear: (k) => k,
  in: (k) => k * k * k,
  out: (k) => 1 - Math.pow(1 - k, 3),
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
};

// A camera pose about its target, in the coordinates an arc is natural in.
function polarOf(p, t) {
  const dx = p.x - t.x, dz = p.z - t.z;
  return { a: Math.atan2(dz, dx), r: Math.hypot(dx, dz), y: p.y };
}
