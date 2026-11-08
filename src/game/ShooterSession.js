import { applyEnemyReadability } from '../render/EnemyReadability.js';
import { WorldModelBatch } from '../render/WorldModelBatch.js';
import { sessionQuality, qualityOverride, FramePacer, SessionAdaptation } from '../core/SessionQuality.js';
import { detectProfile } from '../core/DeviceProfile.js';
import { PerformanceMonitor } from '../core/PerformanceMonitor.js';
import { CAMERA } from '../config/viewmodel.js';
import { CATALOG } from '../world/catalog.js';
import { resolveProject } from '../world/shooterProject.js';
import { prepareRigidBody, RigidAnimator } from '../anim/RigidBody.js';
import { Scene, PerspectiveCamera, Group, Color, Fog, Vector3, Box3, Mesh, MeshStandardMaterial,
  HemisphereLight, DirectionalLight, PointLight } from 'three/webgpu';
import { createRenderer, viewportSize } from '../core/Renderer.js';
import { AssetLoader, IMPORTED_PROP_TEXTURE_BYTES, IMPORTED_PROP_DEADLINE_MS } from '../core/AssetLoader.js';
import { grenadeModel, resolvePack } from '../world/pack.js';
import { compileShooterProject, enemyTypesForProject } from '../world/shooterProject.js';
import { hashSeed } from '../kernel/seed.js';
import { generateCreature } from '../world/creatureGrammar.js';
import { createCreatureAssembler } from '../render/CreatureAssembler.js';
import { createHouseAssembler } from '../render/HouseAssembler.js';
import { createTreeAssembler } from '../render/TreeAssembler.js';
import { buildHouse } from '../world/houseGrammar.js';
import { Wildlife } from './Wildlife.js';
import { createLandmarkAssembler } from '../render/LandmarkAssembler.js';
import { Game } from './Game.js';
import { genreOf } from '../genres/registry.js';
import { rulesFor } from '../genres/rules.js';
import { makePackWeapon } from '../viewmodel/PackViewmodel.js';
import { PackAnimator } from '../anim/PackAnimator.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { buildCombatEnvironment } from '../render/CombatEnvironment.js';
import { VFX } from '../render/VFX.js';
import { TracerPool } from '../effects/TracerPool.js';
import { PostFX } from '../render/PostFX.js';
import { setUnlitMrtEnabled, excludeFromEnvironment } from '../render/Environment.js';
import { createArcadeToon, TOON } from '../render/ArcadeToon.js';
import { GameAudio } from '../audio/GameAudio.js';
import { CombatAudio } from '../audio/CombatAudio.js';
import { State } from '../sim/GameState.js';
import { LightRig } from '../render/LightRig.js';
import { lookFor } from '../config/looks.js';
import { readGamepad } from '../core/Gamepad.js';
import { SkyEnvironment, createAtmosphereFog, createFogUniforms } from '../render/Sky.js';
import { fitSunShadow } from '../render/SunShadow.js';

const accentColors = { cyan: 0x25eff0, violet: 0x9d7cff, amber: 0xffb54a };
/** How far a lever's handle leans back before it is pulled, and forward after (radians about its hinge). */
const LEVER_THROW = 0.62;


/**
 * Browser host shared by the editor preview and playable output.
 *
 * HOSTED (`host`): the session plays inside another renderer's world instead of its own, which is how the editor's
 * World view plays a mission on the world it holds (editor/world/play.js). The host owns the renderer, the frame loop,
 * the sky, the sun, the ground and the post stack; the session brings the game and everything that is the game's: the
 * mission's things, the critters, the weapon and the hands, the effects and the sound. Its world things go in
 * `host.parent` (a group the host puts where the level's origin is on its world), the host calls `frame(now)` once a
 * frame before it draws, and draws the view model after its own frame with `renderOverlay(renderer)`.
 *
 *   host.renderer        the host's renderer (never resized, re-ratioed, looped or disposed here)
 *   host.parent          the Object3D the session's world things go into
 *   host.world           the host's scene, read for its environment (the view model is lit by it)
 *   host.lights          {hemi, sun} the host's lights, which the view model's lights copy
 *   host.sunDir(out)     writes the direction toward the sun into `out`
 *   host.level(level)    the compiled level, put on the host's world (src/world/worldPlay.js worldLevel)
 */
export class ShooterSession {
  constructor(canvas, { onStatus = () => {}, onFrame = () => {}, onError = () => {}, onFeedback = () => {}, onLevelEvent = () => {}, host = null } = {}) {
    Object.assign(this, { canvas, onStatus, onFrame, onError, onFeedback, onLevelEvent, host });
    this.keys = new Set(); this.actions = {}; this.look = { x: 0, y: 0 };
    this.touchMove = { x: 0, y: 0 }; this.playing = false; this.last = 0;
    this.abort = new AbortController(); this.owned = new Set();
    this._bindInput();
    if(new URLSearchParams(location.search).get('debug')==='1')this.performanceMonitor=new PerformanceMonitor(this);
  }
  async initialize() {
    this.performanceProfile=sessionQuality('quality',detectProfile(),qualityOverride(location.search));
    this.framePacer=new FramePacer();
    this.assets = new AssetLoader({ definitions: {}, maxTextureSize: 1024, anisotropy: 4 });
    if (this.host) {
      // The host's renderer, drawn by the host's loop: nothing here starts a loop or sizes the canvas.
      this.renderer = this.host.renderer;
      this.assets.enableCompressedTextures(this.renderer);
      if(this.performanceProfile.mobile)await WorldModelBatch.ready();
      this.renderingActive = true;
      return;
    }
    const boot = await createRenderer({ canvas: this.canvas, tier: {...this.performanceProfile,softShadows:false},
      onNeedFreshCanvas: () => {
        const next = this.canvas.cloneNode(); this.canvas.replaceWith(next); this.canvas = next; return next;
      }, onDeviceLost: () => this.onError(new Error('Graphics connection lost. Reload to reconnect.')) });
    this.renderer = (await boot.settle()).renderer;
    this.assets.enableCompressedTextures(this.renderer);
    if(this.performanceProfile.mobile)await WorldModelBatch.ready();
    this.renderer.shadowMap.enabled = this.performanceProfile.shadows;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.performanceProfile.maxPixelRatio));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.animate = now => {
      try { if(!document.hidden&&this.framePacer.ready(now))this.frame(now); } catch (error) { this.renderer.setAnimationLoop(null); this.onError(error); }
    };
    this.setRendering(true);
  }
  setRendering(active) {
    this.renderingActive = active;
    this.framePacer?.reset();this.adaptation?.reset();
    this.last = 0;
    if (!this.host) this.renderer?.setAnimationLoop(active ? this.animate : null);
  }
  async build(project, {isCurrent=()=>true}={}) {
    this.stop();
    const buildSerial=this.buildSerial=(this.buildSerial??0)+1;
    this.isBuildCurrent=()=>this.buildSerial===buildSerial&&isCurrent()&&!this.abort.signal.aborted;
    const loadStarted=performance.now();
    this.onStatus('Loading theme assets…');
    // Resolve first: a retired theme in a saved project maps to a shipped pack before it is fetched.
    project=resolveProject(project);
    const response = await fetch(`/packs/${project.theme}/pack.json`,{cache:'no-store'});
    if (!response.ok) throw new Error('Theme asset manifest could not be loaded');
    this.manifest = await response.json();
    // The level is built from the pack as its world option sees it: the desert oasis swaps in its own houses, trees,
    // flora, landmarks, ground and props (world/pack.js biomePack); the session loads and draws from that pack.
    // A game whose genre fires nothing is exported without weapons (world/gameBundle.js).
    let level=compileShooterProject(project,resolvePack(this.manifest,CATALOG[project.theme].measurements,null,{weaponless:!genreOf(project).weapons}));
    // Hosted, the level is put on the host's world (its ground, water and walls) before anything is built on it.
    if(this.host)level=this.host.level(level);
    project=level.project;
    const pack=level.pack;
    const {pools}=level.blueprint;
    /**
     * THE GENRE decides what this session builds on the engine: which systems the game
     * gets, how raw input is shaped, what the player's hands hold.
     * Everything below that is a weapon, a view model or an aim is behind `this.genre.weapons`
     * or a rules hook; the scene, the sky, the lights, the post stack and the enemies are
     * the platform and are built for every genre alike.
     */
    this.genre=genreOf(project);this.rules=rulesFor(project.genre);this.viewmodel=null;this.weaponRigs=null;this.weaponRig=null;
    this.performanceProfile=sessionQuality(project.quality,detectProfile({renderer:this.renderer,backend:this.renderer.backend?.isWebGPUBackend?'webgpu':'webgl2'}),qualityOverride(location.search));
    const policy=this.performanceProfile;
    this.assets.maxTextureSize=1024;this.assets.anisotropy=policy.mobile?2:4;
    const entries=[...(this.genre.gear??[]).map(id=>pack.props.find(p=>p.id===id)).filter(Boolean),pack.characters.player,...pools.enemies.map(id=>pack.characters[id]),...pools.weapons.map(id=>pack.weapons[id]),...pools.weapons.filter(id=>pack.weapons[id].viewmodel).map(id=>({model:pack.weapons[id].viewmodel})),...level.placements.filter(p=>p.model),...(level.worldKit.decorations??[]).map(model=>({model})),...(this.genre.weapons?[{model:grenadeModel(pack)}]:[]),...(pack.creatures?.wildlife?[{model:pack.creatures.library}]:[])];
    if(entries.some(e=>!e?.model))throw Error('The selected catalogue and asset pack are inconsistent. Reload the studio.');
    const used=[...new Set(entries.map(e=>e.model))];
    const retained=new Set(used);
    for(const model of retained){
      this.assets.definitions[model]={paths:['/'+model],mandatory:true,maxTextureSize:1024,sharedTextureNamespace:policy.mobile?'mobile-v1':null,revision:model.startsWith('imports/')?null:CATALOG[project.theme].measurements[model]?.revision??'finish-20260921',
        // A creator's file is untrusted whatever the import dialog checked: bound its load time and decoded pixels here too.
        ...(model.startsWith('imports/')?{deadlineMs:IMPORTED_PROP_DEADLINE_MS,maxDecodedTextureBytes:IMPORTED_PROP_TEXTURE_BYTES}:{})};
    }
    for(let i=0;i<used.length;i++){
      if(!isCurrent())return null;
      // A frame between loads keeps the page answering; an asset already in memory needs no wait (an editor rebuild).
      if(this.assets.has(used[i]))continue;
      this.onStatus(`Preparing selected assets ${i+1} / ${used.length}`);
      await new Promise(resolve=>requestAnimationFrame(resolve));
      await this.assets.loadOne(used[i]);
    }
    if(!isCurrent())return null;
    this._clear();this.assets.retain(retained);this.project=project;this.pack=pack;this.level=level;this.placementVisuals=new Map();this.spinners=[];this.rigidPrepared=new Map();
    /**
     * THE LOOK AND THE PROFILE, decided once per build. The look (config/looks.js) owns
     * every lighting number below; the profile (studioProfile) owns what the post stack
     * builds. Both are fixed for the session, like everything that participates in a
     * shader - see config/quality.js for why nothing here may move while the game runs.
     */
    const look = this.renderLook = lookFor(project, level.worldKit?.biome ?? null);
    const profile = this.profile = policy.profile;
    this.framePacer.cap=project.frameRate??60;this.framePacer.reset();
    this.renderScale=policy.renderScale;
    this.adaptation=new SessionAdaptation(policy,project.frameRate,scale=>{this.renderScale=scale;this._applyRenderScale();});
    if(!this.host){this.renderer.shadowMap.enabled=policy.shadows;this._applyRenderScale();}
    // A daylit pastel world wants a faint glow.
    profile.bloomStrength = .12;
    const webgpu = !!this.renderer.backend?.isWebGPUBackend;
    // Decided BEFORE any material exists: an unlit material's MRT declaration is compiled in.
    // Hosted, there is no post stack of the session's own, so no material declares the targets it would read.
    if(this.host)setUnlitMrtEnabled(false,false);else setUnlitMrtEnabled(profile.postFX && profile.ssr && webgpu, profile.postFX && profile.ao);
    // Arcade draws its GLBs toon-shaded with outline shells (render/ArcadeToon.js).
    // `?toon=off` shows the same files through the plain PBR path, for comparison and diagnosis.
    const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null, toonOff = query?.get('toon') === 'off';
    // `?wind=off` keeps the canopy, tufts and reeds still (no sway nodes are built at all).
    this.toon = !toonOff ? createArcadeToon(this.owned, { ...look.toon, ...(query?.get('wind') === 'off' ? { wind: false } : {}) }) : null;
    // Generated creatures (world/creatureGrammar.js) assemble from the pack's parts library, one material per colour slot.
    this.creatureRules = pack.creatures ?? null; this.creatureMaterials = new Map();
    this.creatures = this.creatureRules && this.assets.has(this.creatureRules.library)
      ? createCreatureAssembler({ library: this.assets.get(this.creatureRules.library).gltf.scene, material: (slot, hex) => this._creatureMaterial(slot, hex) }) : null;
    // Generated houses (world/houseGrammar.js): code-built walls and roofs plus parts from the pack's house library.
    this.houseRules = pack.houses ?? null; this.houseMaterials = new Map();
    this.houses = this.houseRules && this.assets.has(this.houseRules.library)
      ? createHouseAssembler({ library: this.assets.get(this.houseRules.library).gltf.scene, material: (slot, hex) => this._houseMaterial(slot, hex) }) : null;
    // Generated trees (world/treeGrammar.js): code-built trunks plus canopy parts from the pack's tree library, one batch per level.
    this.treeRules = pack.trees ?? null; this.treeMaterials = new Map();
    this.trees = this.treeRules && this.assets.has(this.treeRules.library)
      ? createTreeAssembler({ library: this.assets.get(this.treeRules.library).gltf.scene, material: (slot, hex) => this._treeMaterial(slot, hex) }) : null;
    // The village layout's flora (world/worldGrammar.js) comes from one nature parts library, batched per material.
    this.worldRules = pack.world ?? null;
    this.natureLibrary = this.worldRules && this.assets.has(this.worldRules.library) ? this.assets.get(this.worldRules.library).gltf.scene : null;
    // The village's landmarks (world/worldLandmarks.js): parts from the landmark library, their sails and wheels turning.
    this.landmarkRules = this.worldRules?.landmarks ?? null; this.landmarkMaterials = new Map();
    this.landmarks = this.landmarkRules && this.assets.has(this.landmarkRules.library)
      ? createLandmarkAssembler({ library: this.assets.get(this.landmarkRules.library).gltf.scene, material: (slot, hex) => this._landmarkMaterial(slot, hex) }) : null;
    if(this.host){
      // The host's world: the session's things go in a group of their own there, lit by the host's sky and sun.
      this.scene=new Group();this.scene.name='HostedGame';this.host.parent.add(this.scene);
      this.worldModels=policy.mobile?new WorldModelBatch(this.scene,this.owned):null;
    }else{
    this.renderer.toneMappingExposure = look.lighting.exposure ?? 1.18;
    this.scene = new Scene();this.worldModels=policy.mobile?new WorldModelBatch(this.scene,this.owned):null; this.scene.background = new Color(project.lighting === 'night' ? 0x101d2c : 0x71818f);
    this.scene.fog = new Fog(this.scene.background, 42, 150);
    }
    // Hosted, the eye stays in the level's own frame, out of the host's scene: a genre's camera aims in level
    // coordinates (lookAt reads world ones), and the host puts its own eye where this one is, plus the level's origin.
    this.camera = new PerspectiveCamera(58, 1, 0.06, 300); if (!this.host) this.scene.add(this.camera);
    this.vmScene = new Scene(); this.vmCamera = new PerspectiveCamera(CAMERA.viewmodelFov,1,CAMERA.viewmodelNear,CAMERA.viewmodelFar); this.vmScene.add(this.vmCamera);
    /**
     * The view model is lit by COPIES of the world's lights, refreshed every frame in
     * _mirrorViewLights: the hemisphere and the sun by colour and intensity, and the two
     * strongest rig slots by position in camera space. A fixed private rig is what made
     * the hands read as pasted over the street rather than standing in it.
     */
    this.vmHemi = new HemisphereLight(0xc3d9e4,0x454037,1.2); this.vmScene.add(this.vmHemi);
    this.vmKey = new DirectionalLight(0xffe2bf,1.2); this.vmKey.position.set(-1,3,2); this.vmScene.add(this.vmKey);
    this.vmLocal = [0, 1].map(() => { const l = new PointLight(0xffffff, 0, 1, 2); this.vmScene.add(l); return l; });
    /**
     * ONE FIXED POOL OF POINT LIGHTS for the whole world (render/LightRig.js). Every lamp,
     * fixture, sign and muzzle flash is an emitter the rig scores each frame; the scene's
     * light count never changes, so nothing here can trigger a shader rebuild mid-fight.
     * Before this the VFX pool's lights were emitters with no rig to show them - a muzzle
     * flash lit nothing in the studio.
     */
    // Hosted, the host's lights are the only lights in its world: a pool of the session's own would change the light
    // count of every material there (a shader rebuild of the whole world), so the effects light nothing.
    this.rig = this.host ? null : new LightRig(this.scene, profile.lights);
    this.accent = accentColors[project.palette];
    this.sun = null; this.sky = null; this.fogUniforms = null;
    /**
     * Outdoors: the sky is drawn, baked into the probe and breathed as fog by ONE
     * description (render/Sky.js), and the sun and hemisphere take their colours from
     * the same look, so the light on a wall, the sky behind it and its reflection in the
     * puddle in front of it agree.
     */
    const L = look.lighting;
    if(this.host){
      this.sky={sunDir:new Vector3(0,1,0),dispose(){}};this.host.sunDir?.(this.sky.sunDir);
      this.hemi=this.host.lights.hemi;this.sun=this.sunLight=this.host.lights.sun;
    }else{
    this.sky = new SkyEnvironment(this.renderer, look.sky, { accent: this.accent, probeSize: policy.probeSize });
    this.sky.applyTo(this.scene, { environmentIntensity: L.env });
    this.fogUniforms = createFogUniforms(look.fog, look.sky, this.sky.uniforms);
    this.scene.fog = null; this.scene.fogNode = createAtmosphereFog(this.fogUniforms);
    this.hemi = new HemisphereLight(L.hemiSky, L.hemiGround, L.hemi); this.scene.add(this.hemi);
    const sun = new DirectionalLight(L.sunColor, L.sun);
    sun.userData.sunDir = this.sky.sunDir.clone();
    sun.castShadow = policy.shadows; sun.shadow.mapSize.set(policy.shadowMapSize,policy.shadowMapSize);
    sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target); this.sun = this.sunLight = sun;
    fitSunShadow(sun, new Vector3(0, 0, 28), { halfExtent: 26 });
    }
    buildCombatEnvironment(this);
    const lit = this.host ? this.host.world : this.scene;
    this.vmScene.environment = lit.environment ?? null; this.vmScene.environmentIntensity = (lit.environmentIntensity ?? 1) * .8;
    this.vfx = new VFX(this.scene, { particleScale: profile.particleScale, maxLights: profile.liveEffectLights, lightCapacity: 6, decalCapacity: profile.maxDecals, maxDecals: profile.maxDecals, anisotropy: profile.anisotropy });
    this.rig?.addAll(this.vfx.lights);
    this.tracers = new TracerPool(this.scene, 32, 0.09);
    this.audio = new CombatAudio({sounds: pack.sounds});
    await this.audio.preload();
    this.game = new Game({ level: this.level, camera: this.camera, tier: 'high',
      enemyTypes: enemyTypesForProject(project), createEnemyVisual: e => this._enemyVisual(e),
      createSystems: game => this.rules.createSystems(this, game, { pools, project, pack }),
      onLevelEvent: (name, data) => this._levelEvent(name, data),
      onStateChange: state => { if ([State.VICTORY, State.PLAYER_DEAD].includes(state)) {
        this.playing = false; this.gameAudio?.pause();this.audio?.feedback(state===State.VICTORY?'victory':'defeat'); this._clearInput(); document.exitPointerLock?.();
      } } });
    if (this.game.weapons) {
      const enemyHit=this.game.weapons.onEnemyHit;
      this.game.weapons.onEnemyHit=(enemy,...args)=>{const alive=enemy.alive;enemyHit?.(enemy,...args);if(alive&&enemy.alive){const head=!!args[1];this.onFeedback(head?'headshot':'hit');this.audio?.feedback(head?'headshot':'hit');}};
    }
    const enemyDeath=this.game.enemies.onDeath;
    this.game.enemies.onDeath=enemy=>{enemyDeath?.(enemy);const final=this.game.objectives?.current?.id==='counterattack'&&this.game.enemies.aliveCount===0&&!this.game.objectives.pending;this.onFeedback(final?'clear':'kill');this.audio?.feedback(final?'clear':'kill');};
    this.gameAudio = new GameAudio(this.audio, this.game);
    // Friendly wildlife (game/Wildlife.js): presentation only, kept clear of the spawn, the objectives and the pickups.
    const W = this.creatureRules?.wildlife;
    if (W && this.creatures) {
      const heights = Object.fromEntries(this.creatureRules.roster.filter(r => !r.rank).map(r => [r.family, r.height]));
      const avoid = [this.level.spawn.position, ...this.level.placements.filter(p => p.stepId || p.pickup).map(p => ({ x: p.x, z: p.z }))];
      // Village life (world/routeGraph.js): a route node tagged with families is a home those families settle at
      // first; a node with a keeper gets a stallholder that stands its ground behind the counter (or beside the well).
      const route = this.level.world?.route, S = this.level.world?.square ?? { x: 0, z: 0 }, homes = [], keepers = [];
      for (const n of route?.nodes ?? []) {
        if (n.life?.length) homes.push({ x: n.x, z: n.z, r: 3.5, families: n.life });
        if (n.keeper) {
          const dx = S.x - n.x, dz = S.z - n.z, l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l;
          if (n.kind === 'well') keepers.push({ x: n.x + uz * 1.4, z: n.z - ux * 1.4, yaw: Math.atan2(-uz, ux), family: n.keeper });
          else keepers.push({ x: n.x - ux * 1.35, z: n.z - uz * 1.35, yaw: Math.atan2(ux, uz), family: n.keeper });
        }
      }
      this.wildlife = new Wildlife({ count: policy.mobile ? W.mobile : W.count, seed: project.seed, families: W.families, collision: this.game.collision, avoid, zones: this.level.world?.zones ?? [], terrain: this.level.terrain,
        homes, keepers: keepers.slice(0, policy.mobile ? (W.keepersMobile ?? 2) : (W.keepers ?? 4)),
        makeVisual: ({ family, key }) => this._wildVisual(family, key, heights[family] ?? 1.2, W.scale) });
    }
    // A genre's camera starts afresh with each level (and with the genre's own framing).
    this.follow = null; this.overhead = null;
    this.genrePlayerVisual = this.rules.createPlayerVisual?.(this) ?? null;
    this.firstPersonArms=null;this.armsAnimator=null;
    if (this.weaponRig) {
      this.firstPersonArms = this._arms();
      this.vmCamera.add(this.firstPersonArms);
    }
    this.scene.traverse(o => { for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) if (m.isMeshBasicMaterial) excludeFromEnvironment(m); });
    if (profile.postFX && !this.host) {
      this.post = new PostFX({ renderer: this.renderer, worldScene: this.scene, worldCamera: this.camera, viewmodelScene: this.vmScene, viewmodelCamera: this.vmCamera }, profile);
      this.post.setLook(look);
    }
    this._mirrorViewLights();
    this._spawnEnemies();
    if (this.editView) this._attachEditView();
    this.resize(); this.last = 0; this.performanceMonitor?.reset(performance.now()-loadStarted); this.onStatus('Ready to play');
    return this.game;
  }
  _worldWeapon(model,length){
    const weapon=makePackWeapon(model,length);weapon.mount.userData.worldWeapon=true;this.worldModels?.add(weapon.mount);return weapon;
  }
  _character(path, height) {
    const root = new Group(), model = cloneSkeleton(this.assets.get(path).gltf.scene);
    const box = new Box3().setFromObject(model), size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3()), scale = height / size.y;
    model.scale.multiplyScalar(scale);
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    root.add(model); return root;
  }
  /** Assemble a blueprint into a rigid, toon-shaded, outlined body `height` metres tall (geometry owned by the session). */
  _prepareCreature(bp,key,height){
    const model=this.creatures.build(bp);model.traverse(o=>{if(o.isMesh)this.owned.add(o.geometry);});
    const report=prepareRigidBody(key,model,height);this.toon?.apply(model,{outline:report.scale});
    return {model,report};
  }
  /** A colour-slot material for generated creatures, shared by every creature that uses the same colour. */
  _creatureMaterial(slot,hex){
    const key=`${slot}|${hex}`;let m=this.creatureMaterials.get(key);if(m)return m;
    if(slot==='Shine')m=new MeshStandardMaterial({color:0x000000,emissive:hex,emissiveIntensity:1.2,roughness:1});
    else if(this.toon)m=this.toon.material({color:hex,vertexColors:true},`ARC_${slot}`);
    else m=new MeshStandardMaterial({color:hex,vertexColors:true,roughness:.85,metalness:0});
    this.owned.add(m);this.creatureMaterials.set(key,m);return m;
  }
  /** A colour-slot material for generated houses; roofs, glass and leaves take the kit's shade, glows stay emissive. */
  _houseMaterial(slot,hex){
    const key=`${slot}|${hex}`;let m=this.houseMaterials.get(key);if(m)return m;
    const kit={Roof:'Roof',Glass:'Glass',Leaf:'Leaf'}[slot]??slot;
    if(slot==='Glow')m=new MeshStandardMaterial({color:0x000000,emissive:hex,emissiveIntensity:1.1,roughness:1});
    else if(this.toon)m=this.toon.material({color:hex,vertexColors:true},`ARC_${kit}`);
    else m=new MeshStandardMaterial({color:hex,vertexColors:true,roughness:.85,metalness:0});
    this.owned.add(m);this.houseMaterials.set(key,m);return m;
  }
  /**
   * A placement's generated house, toon-shaded and outlined (geometry owned by the session). Phones and the
   * performance tier build the lite version: no shutters, flower boxes, signs or yard props.
   */
  _houseVisual(p){
    if(!this.houses||!p.house)return null;
    const model=this.houses.build(p.house,buildHouse(this.houseRules,p.house),{lite:!!(this.performanceProfile.mobile||this.project.quality==='performance')});
    model.traverse(o=>{if(o.isMesh){this.owned.add(o.geometry);o.castShadow=true;o.receiveShadow=true;}});
    this.toon?.apply(model);
    return model;
  }
  /** A colour-slot material for generated trees; leaves and blossom take the kit's foliage and petal shade. */
  _treeMaterial(slot,hex){
    const key=`${slot}|${hex}`;let m=this.treeMaterials.get(key);if(m)return m;
    const kit={Leaf:'Leaf',Blossom:'Petal',Bark:'Bark'}[slot]??slot;
    if(this.toon)m=this.toon.material({color:hex,vertexColors:true},`ARC_${kit}`);
    else m=new MeshStandardMaterial({color:hex,vertexColors:true,roughness:.85,metalness:0});
    this.owned.add(m);this.treeMaterials.set(key,m);return m;
  }
  /**
   * The level's generated trees as one batch (world/treeGrammar.js plans on the placements), toon-shaded and
   * outlined. Phones and the performance tier build the lite version: six-sided limbs, no root flare, lite clumps.
   */
  _treeBatch(placements){
    if(!this.trees||!placements.length)return null;
    const lite=!!(this.performanceProfile.mobile||this.project.quality==='performance');
    const model=this.trees.build(placements.map(p=>({plan:p.tree,x:p.x,y:p.y,z:p.z,yaw:p.yaw,scale:p.scale,lean:p.lean})),{lite});
    model.traverse(o=>{if(o.isMesh){this.owned.add(o.geometry);o.castShadow=true;o.receiveShadow=true;}});
    this.toon?.apply(model);
    return model;
  }
  /** A colour-slot material for a landmark (a stall's awning); the library's own ARC_ materials pass through the toon swap. */
  _landmarkMaterial(slot,hex){
    const key=`${slot}|${hex}`;let m=this.landmarkMaterials.get(key);if(m)return m;
    if(this.toon)m=this.toon.material({color:hex,vertexColors:true},`ARC_${slot}`);
    else m=new MeshStandardMaterial({color:hex,vertexColors:true,roughness:.85,metalness:0});
    this.owned.add(m);this.landmarkMaterials.set(key,m);return m;
  }
  /**
   * A placement's landmark, toon-shaded and outlined (geometry owned by the session), its moving parts listed in
   * userData.spinners. Phones and the performance tier build the lite twin.
   */
  _landmarkVisual(p){
    if(!this.landmarks||!p.landmark)return null;
    const model=this.landmarks.build(p.landmark,{lite:!!(this.performanceProfile.mobile||this.project.quality==='performance')});
    model.traverse(o=>{if(o.isMesh){this.owned.add(o.geometry);o.castShadow=true;o.receiveShadow=true;}});
    this.toon?.apply(model);
    return model;
  }
  /** One friendly wanderer: a 'friendly' blueprint, smaller than its hostile kin by the size gene. */
  _wildVisual(family,key,baseHeight,[s0,s1]){
    const bp=generateCreature(this.creatureRules,{family,key,role:'friendly'}),k=s0+(s1-s0)*bp.dna.size,hover=(bp.hover??0)*k;
    const {model,report}=this._prepareCreature(bp,`wild:${family}`,baseHeight*k-hover);
    const root=new Group(),lift=new Group();lift.position.y=hover;lift.add(model);root.add(lift);this.scene.add(root);
    const animator=new RigidAnimator(report,model,{id:family,chaseSpeed:1.4,attackWindup:1,attackActive:1,attackRecovery:1},hashSeed(key));
    return {root,animator,radius:Math.max(.3,Math.min(.6,report.bodyRadius??.4)),dispose:()=>root.removeFromParent()};
  }
  _enemyVisual(e) {
    const entry=this.pack.characters[e.type.asset],source=this.assets.get(entry.model).gltf;
    const root=new Group();this.scene.add(root);let body,animator;
    if(entry.animation==='rigid'){
      // `hover` (a flying critter) lifts the body off the floor: the body is sized to the height left above the gap,
      // so the hit capsule still spans floor to crown, and it drops to the ground once dead.
      const hover=entry.hover??0;
      if(entry.generator){
        // A generated critter (world/creatureGrammar.js): this spawn's own individual, from the project seed and its own.
        if(!this.creatures)throw Error(`The creature library for "${e.type.asset}" did not load`);
        const bp=generateCreature(this.creatureRules,{family:entry.generator.family,rank:entry.generator.rank??'minion',role:'hostile',key:`${this.project.seed}|${e.type.asset}|${e.seed}`});
        const built=this._prepareCreature(bp,e.type.asset,e.type.height-hover);body=built.model;animator=new RigidAnimator(built.report,body,e.type,e.seed);
      }else{
        let prepared=this.rigidPrepared.get(entry.model);
        if(!prepared){const model=source.scene.clone(true);model.traverse(o=>{if(o.isMesh){o.geometry=o.geometry.clone();this.owned.add(o.geometry);}});const report=prepareRigidBody(e.type.asset,model,e.type.height-hover);this.toon?.apply(model,{outline:report.scale});prepared={model,report};this.rigidPrepared.set(entry.model,prepared);}
        body=prepared.model.clone(true);animator=new RigidAnimator(prepared.report,body,e.type,e.seed);
      }
      if(hover){
        const lift=new Group();lift.position.y=hover;lift.add(body);root.add(lift);const update=animator.update.bind(animator);
        animator.update=(dt,enemy,target)=>{update(dt,enemy,target);lift.position.y=enemy.state==='DEAD'?Math.max(0,lift.position.y-dt*hover*2.5):hover;};
      }else root.add(body);
    }else{body=this._character(entry.model,e.type.height);root.add(body);animator=new PackAnimator(body,source.animations);}
    // Only gunmen carry the pack's gun; creatures fight with their bodies.
    if(e.type.attackMode==='ranged'&&this.genre.weapons){
      // A v2 rig is the first-person arms assembly: enemies carry the pack's world model instead.
      const rifle=this._worldWeapon(this.weaponRig.authored&&!this.weaponRig.v2?this.weaponRig.model:this.assets.get(this.pack.weapons[this.project.weapon].model).gltf.scene,this.pack.weapons[this.project.weapon].metres);
      rifle.mount.position.set(-.10,1.38,.5);rifle.mount.rotation.y=Math.PI;body.add(rifle.mount);
    }
    const disposeReadability=applyEnemyReadability(body,this.project,this.enemyMaterialOptions);
    return {root,animator,updateReadability:()=>disposeReadability.update(e),dispose:()=>{disposeReadability();animator.dispose?.();root.traverse(o=>{if(o.userData.worldWeapon)this.worldModels?.remove(o);});root.removeFromParent();}};
  }
  _arms() {
    const model = cloneSkeleton(this.assets.get(this.pack.characters.player.model).gltf.scene);
    model.traverse(o => {
      if (!o.isSkinnedMesh) return;
      const g = o.geometry.clone(), skin = g.attributes.skinIndex, weights = g.attributes.skinWeight;
      const arms = new Set(o.skeleton.bones.flatMap((b,i) => /arm|hand/.test(b.name) ? [i] : []));
      const included = i => { let weight = 0; for (let j=0;j<4;j++) if (arms.has(skin.getComponent(i,j))) weight += weights.getComponent(i,j); return weight > .5; };
      const old = g.index.array, indices = [];
      for (let i=0;i<old.length;i+=3) if ([old[i],old[i+1],old[i+2]].every(included)) indices.push(old[i],old[i+1],old[i+2]);
      // Keep original material groups while removing body triangles.
      const filtered = []; let start = 0;
      for (const group of g.groups) { const begin = filtered.length;
        for(let i=group.start;i<group.start+group.count;i+=3) if([old[i],old[i+1],old[i+2]].every(included)) filtered.push(old[i],old[i+1],old[i+2]);
        group.start=begin;group.count=filtered.length-begin;
      }
      g.setIndex(g.groups.length ? filtered : indices);o.geometry=g;this.owned.add(g);o.frustumCulled=false;
    });
    model.position.set(.23,-1.55,-.08);model.rotation.y=Math.PI;
    this.armsAnimator = new PackAnimator(model, this.assets.get(this.pack.characters.player.model).gltf.animations);
    return model;
  }
  /** The generator's critters (game/LevelScript.js spawnGenerated): each on its own stream, edits honoured. */
  _spawnEnemies() { this.game.script.spawnGenerated(this.project); }
  _mesh(geometry, material, x, y, z, parent = this.scene) {
    this.owned.add(geometry); this.owned.add(material);
    const mesh = new Mesh(geometry, material); mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  /**
   * THE EDITOR'S VIEW (editor/build/): while set, the editor owns the camera and the scene carries its overlays,
   * `view.world` in the world (depth-tested: the grid on the ground, painted regions, trigger zones) and `view.top` in
   * the view-model pass, drawn over the world with its own depth (gizmos, wires). No weapon, no hands, no input.
   * @param {{world: import('three').Object3D, top: import('three').Object3D, camera: (camera: import('three').PerspectiveCamera) => void, focus: {x: number, z: number}}|null} view
   */
  setEditView(view) {
    if (this.editView === view) return;
    this._detachEditView();
    this.editView = view;
    if (view) { this.stop(); this._attachEditView(); }
    else if (this.vmCamera) {
      // The view-model camera lent its eye to the editor's overlays; the hands hang off it at the origin again.
      this.vmCamera.position.set(0, 0, 0); this.vmCamera.quaternion.identity();
      this.vmCamera.near = CAMERA.viewmodelNear; this.vmCamera.far = CAMERA.viewmodelFar; this.vmCamera.updateProjectionMatrix();
    }
    if (this.viewmodel) this.viewmodel.root.visible = !view;
  }
  _attachEditView() {
    const v = this.editView;
    if (!v || !this.scene) return;
    this.scene.add(v.world); this.vmScene.add(v.top);
    if (this.viewmodel) this.viewmodel.root.visible = false;
    if (this.firstPersonArms) this.firstPersonArms.visible = false;
  }
  _detachEditView() { this.editView?.world.removeFromParent(); this.editView?.top.removeFromParent(); }
  /** Back to the level as built, paused: every door shut, every critter where it started (after a playtest). */
  resetLevel() {
    if (!this.game) return;
    this.stop(); this.game.restart(); this._spawnEnemies(); this.game.pause();
  }
  /** Play from a chosen spot rather than the start (a playtest). */
  playFrom(spot) {
    if (!this.game) return;
    this.stop(); this.game.restart({ spawn: { position: { x: spot.x, z: spot.z }, yaw: spot.yaw ?? 0, pitch: 0 } }); this._spawnEnemies();
    this.playing = true; this._clearInput(); this.last = 0;
  }
  _levelEvent(name, data) {
    if (name === 'key' || name === 'collect') this.audio?.feedback('hit');
    if (name === 'door' || name === 'lever') this.audio?.playOneShot('uiClick');
    if (name === 'respawn') this.audio?.feedback('defeat');
    this.onLevelEvent(name, data);
  }
  start() {
    if (!this.game) return;
    if (this.game.state.isTerminal) { this.game.restart(); this._spawnEnemies(); }
    else if (this.game.state.current === State.TITLE) this.game.start();
    else this.game.resume();
    const audio=this.audio;audio?.resume().then(ready=>{if(ready&&this.playing&&this.audio===audio)audio.playOneShot('uiClick');});
    this.playing = true; this._clearInput(); this.last = 0;
  }
  /** Carry a lost run on (Game.continueRun): the level as it stands, lives restored, play resumed. */
  continueRun() {
    if (!this.game?.continueRun()) return false;
    this.playing = true; this._clearInput(); this.last = 0; this.audio?.resume();
    return true;
  }
  stop() {
    this.playing = false; this.game?.pause(); this.gameAudio?.pause(); this._clearInput();
    if (document.pointerLockElement) document.exitPointerLock?.();
  }
  _clearInput() { this.keys.clear(); this.actions = {}; this.fire = this.ads = this.interact = this.touchJump = false; this.touchLook = null; this.touchMove = { x: 0, y: 0 }; this.touchAim = null; this.look = { x: 0, y: 0 }; this.padWas = null; }
  /**
   * A gamepad, read once a frame and folded into the same input the keys and the mouse make: the left stick moves, the
   * right stick looks (or aims, for a genre that aims), the buttons act. Edges (reload, grenade, the next weapon,
   * pause) fire once per press.
   */
  _pollGamepad(dt) {
    const pad = readGamepad(); if (!pad) { this.pad = null; return; }
    const was = this.padWas ?? {}; this.padWas = pad; this.pad = pad;
    if (pad.pause && !was.pause) { this.stop(); this.audio?.playOneShot('uiEsc'); return; }
    if (pad.reload && !was.reload) this.actions.reload = true;
    if (pad.grenade && !was.grenade) this.actions.grenade = true;
    if (pad.next && !was.next && this.game?.weapons) { const w = this.game.weapons; this.actions.weapon = w.order[(w.order.indexOf(w.current.id) + 1) % w.order.length]; }
    if (this.rules.view(this) !== 'overhead') { const rate = 2.6 * dt * (this.lookSensitivity ?? 1); this.look.x += pad.stick.x * rate; this.look.y -= pad.stick.y * rate; }
  }
  _bindInput() {
    const options = { signal: this.abort.signal };
    window.addEventListener('keydown', e => {
      if (!this.playing || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (['Space', 'KeyE', 'KeyR'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code); if (e.code === 'KeyR' && !e.repeat) this.actions.reload = true;
      if (e.code === 'KeyG'&&!e.repeat)this.actions.grenade=true;
      if (e.code === 'KeyF'&&!e.repeat)this.actions.inspect=true;
      if (/^Digit[1-9]$/.test(e.code)&&this.game?.weapons)this.actions.weapon=this.game.weapons.order[Number(e.code.slice(-1))-1];
      if (e.code === 'Escape') { this.stop(); this.audio?.playOneShot('uiEsc'); }
    }, options);
    window.addEventListener('keyup', e => this.keys.delete(e.code), options);
    window.addEventListener('blur', () => this.stop(), options);
    document.addEventListener('visibilitychange', () => { if(document.hidden)this.stop();this.last=0;this.framePacer?.reset();this.adaptation?.reset();if(this.performanceMonitor)this.performanceMonitor.last=0; }, options);
    document.addEventListener('pointerlockchange', () => {
      if (this.hadPointerLock && !document.pointerLockElement) this.stop();
      this.hadPointerLock = document.pointerLockElement === this.canvas;
    }, options);
    const container = this.canvas.parentElement;
    container.addEventListener('pointerdown', e => {
      if (e.target !== this.canvas || !this.playing) return;
      if (e.pointerType === 'mouse') {
        this.canvas.focus();
        if (this.rules?.pointerLock !== false) this.canvas.requestPointerLock?.()?.catch?.(() => {});
        if (e.button === 0) { this.fire = true; this.actions.fire = true; }
        if (e.button === 2) this.ads = true;
      } else { this.touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY }; this.canvas.setPointerCapture(e.pointerId); }
    }, options);
    window.addEventListener('pointerup', e => {
      if (e.pointerType === 'mouse') { if (e.button === 0) this.fire = false; if (e.button === 2) this.ads = false; }
      if (this.touchLook?.id === e.pointerId) this.touchLook = null;
    }, options);
    this.canvas.addEventListener('pointercancel', e => { if (this.touchLook?.id === e.pointerId) this.touchLook = null; }, options);
    window.addEventListener('pointermove', e => {
      // Where the mouse is over the view: the arena aims at its point on the ground.
      if (e.pointerType === 'mouse') this.pointer = { x: e.clientX, y: e.clientY };
      if (!this.playing) return;
      if (document.pointerLockElement === this.canvas) {
        this.look.x += e.movementX * .002 * (this.lookSensitivity??1); this.look.y += e.movementY * .002 * (this.lookSensitivity??1);
      } else if (this.touchLook?.id === e.pointerId) {
        const gain=2.2/Math.max(320,this.canvas.clientWidth)*(this.lookSensitivity??1);
        this.look.x += (e.clientX - this.touchLook.x) * gain;
        this.look.y += (e.clientY - this.touchLook.y) * gain;
        this.touchLook.x = e.clientX; this.touchLook.y = e.clientY;
      }
    }, options);
    container.addEventListener('contextmenu', e => e.preventDefault(), options);
  }
  _applyRenderScale() {
    if(this.host)return;   // the host's renderer keeps its own pixel ratio
    const p=this.performanceProfile;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,p.maxPixelRatio)*(this.renderScale??1));
  }
  resize() {
    if (!this.renderer || !this.camera) return;
    if (this.host) {
      // The host sizes its canvas; the session's eye and the view model's only take its shape.
      const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      if (this.vmCamera) { this.vmCamera.aspect = this.camera.aspect; this.vmCamera.updateProjectionMatrix(); }
      return;
    }
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const size = viewportSize(rect.width, rect.height);
    // A collapsed viewport draws nothing and keeps its last real size; see core/Renderer.js viewportSize.
    this.collapsed = size === null;
    if (!size) return;
    const { width, height } = size;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height); this.camera.updateProjectionMatrix();
    if (this.vmCamera) { this.vmCamera.aspect = this.camera.aspect; this.vmCamera.updateProjectionMatrix(); }
    // A resized canvas loses its pixels; repaint once without restarting the loop.
    if (this.renderingActive === false && this.game) this.frame(performance.now());
  }
  frame(now) {
    if (!this.game || this.collapsed) return;
    const elapsed = this.last ? (now - this.last) / 1000 : 1 / 60;
    const dt = Math.min(0.05, elapsed); this.last = now;
    const game = this.game, p = game.player;
    if (this.playing) this._pollGamepad(dt);
    if (this.playing) game.advance(dt, () => {
      const pad = this.pad;
      const raw = { move: { x: Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA')) + this.touchMove.x + (pad?.move.x ?? 0),
        y: Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS')) + this.touchMove.y + (pad?.move.y ?? 0) },
        look: this.look, fire: this.fire || !!pad?.fire, ads: this.ads || !!pad?.ads, jump: this.keys.has('Space') || this.touchJump || !!pad?.jump,
        sprint: this.keys.has('ShiftLeft') || !!pad?.sprint, interact: this.keys.has('KeyE') || this.interact || !!pad?.interact,
        // A twin-stick aim: the right stick, or the right touch pad (which fires while held).
        aim: this.touchAim ?? pad?.stick ?? null, aimFire: !!this.touchAim || !!pad?.fire, ...this.actions };
      const input = this.rules.input(this, raw);
      this.look = { x: 0, y: 0 }; this.actions = {}; return input;
    });
    if (this.playing) this.gameAudio?.update({interact:this.keys.has('KeyE')||this.interact});
    game.updateVisuals(this.playing ? dt : 0, { speed: p.speedFraction });
    const edit = this.editView;
    this.wildlife?.update(this.playing ? dt : 0, p.position);
    this.genrePlayerVisual?.update(this.playing ? dt : 0);
    const view = this.rules.view(this);
    if (this.weaponRig) {
      this._syncWeaponVisual();
      this.armsAnimator.update(this.playing ? dt : 0, { reloading: game.weapons.hudState.state === 'RELOADING' });
      this.firstPersonArms.position.z = -.08 + this.viewmodel.recoilRoot.position.z;
    }
    // Hands and a weapon at the eye belong to first person only; a genre that shows the hero places its own camera.
    if (view !== 'first') { if (this.firstPersonArms) this.firstPersonArms.visible = false; if (this.viewmodel) this.viewmodel.root.visible = false; }
    this.camera.fov = 72 * (game.weapons?.fovScale ?? 1);
    if (view !== 'first' && !edit) this.rules.updateCamera?.(this, this.playing ? dt : 1 / 60);
    // The editor places its own camera, and the view-model pass draws its overlays from the same eye.
    if (edit) {
      edit.camera(this.camera);
      if (this.firstPersonArms) this.firstPersonArms.visible = false;
      this.vmCamera.position.copy(this.camera.position); this.vmCamera.quaternion.copy(this.camera.quaternion);
      this.vmCamera.fov = this.camera.fov; this.vmCamera.near = this.camera.near; this.vmCamera.far = this.camera.far;
    }
    this.camera.updateProjectionMatrix();
    for (const e of game.enemies.enemies) {
      if (e.type.attackMode === 'ranged' && e.state === 'ATTACK_ACTIVE' && e._drawnAttack !== game.tick - Math.round(e.stateTime * 60)) {
        e._drawnAttack = game.tick - Math.round(e.stateTime * 60);
        if (this.playing) this.audio?.playOneShot('pistolFire',{position:e.position,gain:.2});
        this.tracers.spawn(e.position.x, e.position.y + 1.4, e.position.z, p.position.x, p.position.y + 1.2, p.position.z, 0xff544b);
      }
    }
    for(const target of game.objectives?.targets??[]){const visual=this.placementVisuals.get(target.record);if(visual){
      // An opened gate with hinged Door_L/Door_R nodes swings them outward; any other opened door lifts clear.
      const doors=visual.userData.doors;
      if(target.record.interaction==='override'&&doors){const u=visual.userData;u.open=target.complete?Math.min(1,(u.open??0)+dt*1.2):0;const k=1-(1-u.open)**3;doors[0].rotation.y=-1.75*k;doors[1].rotation.y=1.75*k;}
      else if(target.record.interaction==='override')visual.position.y=target.record.y+(target.complete?target.record.height+1:0);
      if(target.record.interaction==='barricade')visual.visible=!target.complete;}}
    // Floating objective crystals turn slowly and bob; a landmark's moving part (windmill sails, a waterwheel) turns
    // about its own axis at its authored rate, the sails at the wind's strength (render/ArcadeToon.js TOON.windStrength).
    for(const s of this.spinners??[]){
      const spin=s.userData.spin;
      if(spin){s.rotation[spin.axis]+=(this.playing?dt:0)*spin.rate*(spin.wind&&this.toon?.windOn?Math.max(.25,TOON.windStrength.value/.06):1);continue;}
      s.rotation.y+=(this.playing?dt:0)*.9;s.position.y=s.userData.restY+Math.sin(now*.002+s.userData.restY)*.05;
    }
    // Arcade's wind (render/ArcadeToon.js swayOffset): one clock for every swaying canopy, tuft and reed.
    if(this.toon?.windOn)TOON.windTime.value=now*.001;
    for(const item of game.supplies.items){const visual=this.placementVisuals.get(item.record);if(visual)visual.visible=!item.taken;}
    this._syncLevelScript(game.script);
    this.vfx.update(this.playing ? dt : 0); this.tracers.update(this.playing ? dt : 0);
    if (!edit) this.vmCamera.fov = CAMERA.viewmodelFov * (game.weapons?.viewmodelFovScale ?? 1);
    this.vmCamera.updateProjectionMatrix();
    // The camera is final here: the rig scores from the eye, the shadow follows the feet.
    this.camera.updateMatrixWorld();
    this.audio?.updateListener(this.camera);
    this.rig?.update(this.camera.position, null, 0, dt);
    // Hosted, the host's sun keeps the host's shadow; its direction is all the view model needs of it.
    if (this.host) this.host.sunDir?.(this.sky.sunDir);
    else if (this.sun) fitSunShadow(this.sun, edit ? { x: edit.focus.x, y: 0, z: edit.focus.z } : p.position, { halfExtent: 26 });
    this._mirrorViewLights();
    if (this.post) {
      this.post.setAds(this.viewmodel?.ads?.blend ?? 0);
      this.post.setDamage(p.alive ? Math.max(0, 1 - p.lastHitAge / 0.7) * 0.32 : 0.45);
    }
    this.worldModels?.update();
    this.performanceMonitor?.beginFrame();
    // Hosted, the host draws its world (the session's things are in it) and then the view model (renderOverlay).
    if (this.host) { /* drawn by the host */ }
    else if (this.post) this.post.render();
    else {
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = false; this.renderer.clearDepth(); this.renderer.render(this.vmScene, this.vmCamera); this.renderer.autoClear = true;
    }
    if(this.renderingActive!==false)this.adaptation?.sample(elapsed*1000);
    this.performanceMonitor?.sample(now);
    this.onFrame({ ...game.hudState, playing: this.playing, genre: this.genre.id, view, fps: Math.round(1 / Math.max(0.001, elapsed)), inventory:(game.weapons?.order??[]).map((id,i)=>`${i+1} ${this.pack.weapons[id].id}`),
      draws: this.renderer.info.render.drawCalls ?? this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles });
  }
  /** Hosted: the view model, drawn over the host's frame (the host has cleared the depth and turned autoClear off). */
  renderOverlay(renderer = this.renderer) {
    if (!this.game || !this.vmScene) return;
    renderer.render(this.vmScene, this.vmCamera);
  }
  /** A hand-built level's moving parts follow its script: doors swing, padlocks go, levers throw, taken items vanish. */
  _syncLevelScript(script) {
    for (const d of script.doors) {
      const visual = this.placementVisuals.get(d.record), doors = visual?.userData.doors, k = 1 - (1 - d.open) ** 3;
      if (doors) { doors[0].rotation.y = -1.75 * k; doors[1].rotation.y = 1.75 * k; }
      const lock = d.lockRecord && this.placementVisuals.get(d.lockRecord);
      if (lock) lock.visible = !d.opened;
    }
    for (const l of script.levers) {
      const handle = this.placementVisuals.get(l.record)?.userData.handle;
      if (handle) handle.rotation.x = -LEVER_THROW + 2 * LEVER_THROW * (1 - (1 - l.pull) ** 2);
    }
    for (const item of [...script.keys, ...script.drops]) { const visual = this.placementVisuals.get(item.record); if (visual) visual.visible = !item.taken; }
  }
  _syncWeaponVisual() {
    // Weapon.rig is only its mount Group. Weapon.build retains authored hands/animation.
    const active = this.game.weapons.current;
    if (active?.build && active.build !== this.weaponRig) this.weaponRig = active.build;
    // An authored rig brings its own arms (Arcade's hero); a static weapon is held
    // by the fallback arms cut from the pack's player character.
    this.firstPersonArms.visible = !this.weaponRig.authored;
  }
  /**
   * Copy the world's lighting onto the view model: hemisphere and sun by value, and the
   * two strongest rig slots by their position in CAMERA space, which is the view-model
   * scene's frame (its camera sits at the origin, unrotated, and the hands hang off it).
   */
  _mirrorViewLights() {
    if (!this.vmHemi || !this.hemi) return;
    const L = this.renderLook?.lighting ?? {};
    this.vmHemi.color.copy(this.hemi.color); this.vmHemi.groundColor.copy(this.hemi.groundColor);
    const sun = this.sunLight;
    this.vmHemi.intensity = this.hemi.intensity * 1.6;
    this.vmKey.color.copy(sun.color); this.vmKey.intensity = sun.intensity * 0.85;
    this.vmKey.position.copy(this.sky.sunDir).transformDirection(this.camera.matrixWorldInverse).multiplyScalar(10);
    for (let i = 0; i < this.vmLocal.length; i++) {
      const src = this.rig?.slots[i], dst = this.vmLocal[i];
      if (!src || src.intensity <= 0) { dst.intensity = 0; continue; }
      dst.position.copy(src.position).applyMatrix4(this.camera.matrixWorldInverse);
      dst.color.copy(src.color); dst.intensity = src.intensity; dst.distance = src.distance; dst.decay = src.decay;
    }
  }
  _clear() {
    this.wildlife?.dispose(); this.wildlife = null; this.creatures?.dispose(); this.creatures = null; this.creatureMaterials?.clear();
    this.genrePlayerVisual?.dispose?.();this.genrePlayerVisual=null;
    this.post?.dispose(); this.post = null; this.sky?.dispose(); this.sky = null; this.rig?.dispose(); this.rig = null; this.armsAnimator?.dispose(); this.audio?.dispose(); this.game?.dispose(); this.vfx?.dispose(); this.tracers?.dispose();
    for (const resource of this.owned) resource.dispose(); this.owned.clear();
    if (this.host) this.scene?.removeFromParent();
    this.game = null; this.scene = null;
  }
  /** Hosted: take the game down (out of the host's world) and keep what loading cost: the assets, the renderer's. */
  unload() { this.stop(); this._clear(); }
  dispose() {
    this.stop(); this.abort.abort(); this.resizeObserver?.disconnect(); this.performanceMonitor?.dispose();
    if (this.host) { this._clear(); this.assets?.dispose(); return; }
    this.renderer?.setAnimationLoop(null); this._clear(); this.assets?.dispose(); this.renderer?.dispose();
  }
}
