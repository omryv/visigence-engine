import { mountPlayerFront, worldArt } from './playerFront.js';
import { MISSION_THEMES, MISSION_WORLDS, missionWorld, THEME_PALETTE, formatTime } from '../src/world/missionCard.js';
import { assetURL } from '../src/config/assetDelivery.js';
import { generationKey } from './draft.js';
import { BlueprintBoard,escapeHtml } from './BlueprintBoard.js';
import { CATALOG } from '../src/world/catalog.js';
import { NODE_KINDS,OBJECTIVE_KINDS,createEmptyBlueprint,compileBlueprint } from '../src/world/blueprint.js';
import { PROJECT_DEFAULTS, THEMES, NEW_PROJECT_GROUND, resolveProject, resolveGame } from '../src/world/shooterProject.js';
import { isGame } from '../src/world/level/game.js';
import { createRun, portalHooks } from './gameRun.js';
import { parseProjectText, packageProject } from '../src/world/projectSchema.js';
import { GENRES, genreOf } from '../src/genres/registry.js';
import { installModelCards } from './modelCards.js';
import { visionFromURL, arriveWithVision } from './visionArrival.js';
import { missionFromEditor } from '../src/world/editorProject.js';

const $ = selector => document.querySelector(selector);
const paths = {
  theme: '<path d="m12 2 9 10-9 10L3 12Z"/><path d="m12 7 5 5-5 5-5-5Z"/>',
  mountain: '<path d="m2 20 7-15 5 9 3-5 5 11Z"/><path d="m6 12 3 2 2-3"/>',
  enemy: '<path d="M5 16v-5a7 7 0 0 1 14 0v5l-4 2v3H9v-3Z"/><path d="M8 11h2m4 0h2m-6 5h4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5M3 7l9 5v10"/>',
  crosshair: '<circle cx="12" cy="12" r="6"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/>',
  settings: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M3 6h7l2 2h9v12H3Z"/><path d="M5 3h6l2 2h6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
  bolt: '<path d="m14 2-9 12h6l-1 8 9-12h-6Z"/>',
  arrow: '<path d="M3 12h18m-6-6 6 6-6 6"/>',
  expand: '<path d="M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6"/>',
  play: '<path d="m7 3 14 9-14 9Z"/>', pause: '<path d="M8 4v16m8-16v16"/>', close: '<path d="m5 5 14 14M5 19 19 5"/>',
};
function icons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[el.dataset.icon] ?? ''}</svg>`;
}
icons();
/* THE GAME INSIDE THE WORLD EDITOR. The editor (index.html, at /) plays its mission by opening this document over its
   viewport with the mission in the address (src/world/editorMission.js). Then it is a standalone game, as an exported
   one is: no launcher, no studio, the mission built and played at once; "Back to the world" hands control back to
   the editor. And it stores nothing, because the editor promises that: storage is this page's memory while it runs. */
const fromEditor = typeof location !== 'undefined' ? missionFromEditor(location) : null;
/* …and a workspace of the editor: the mission graph (Remix) or the level editor (Build), on the editor's mission.
   Every edit goes back to the editor, which keeps the mission; Generate & play asks the editor to play it there. */
const workspace = fromEditor?.workspace ?? null;
if (fromEditor) {
  if (workspace) document.body.dataset.workspace = workspace; else document.body.dataset.build = 'standalone';
  document.body.dataset.embed = 'world';
  const mem = new Map(), memory = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: k => { mem.delete(k); }, clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  Object.defineProperty(window, 'localStorage', { value: memory, configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: memory, configurable: true });
}
const embedded = !!fromEditor;
const toEditor = (message) => window.parent?.postMessage(message, location.origin);
// The editor keeps this view when another is shown, and says so: stop drawing while hidden, start again when shown.
if (fromEditor) window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.parent) return;
  if (e.data?.type === 'visigence:pause') session?.setRendering(false);
  if (e.data?.type === 'visigence:resume' && document.body.dataset.mode === 'build') session?.setRendering(true);
});
const leaveForWorld = () => toEditor({ type: workspace ? 'visigence:leave-workspace' : 'visigence:leave-game' });
const standalone = document.body.dataset.build === 'standalone';
const environmentName=p=>THEMES[p.theme];
const weaponOptions = () => CATALOG[project.theme].weapons.map(w=>[w.id,w.label]);
const STORAGE = 'visigames.shooter.project.v1';
let project = resolveProject({blueprint:createEmptyBlueprint(),ground:NEW_PROJECT_GROUND}), history = [], future = [], category = 'themes', node = 'theme';
let playerFront;
let session, building = false, buildChain = Promise.resolve(), buildVersion = 0, boot;
let previewTab = 'preview', capturePending = false, currentThumbnail = '', toastTimer, lastHud = 0;
let expanded = false, logs = [], lastOverlay = '', completedBuild = null;
/** A game of levels being played through (an exported game, or the level editor's Play the whole game). */
let run = null, runToken = 0, runFailed = null;
/**
 * Build mode (editor/build/): the level editor, loaded on first use. `buildEnd` is set while a Build playtest runs;
 * `graphLink` while the node graph edits a Build level (its edits and undo go to the level editor's store).
 */
let buildMode = null, buildFrom = 'remix', buildEnd = null, graphLink = null, linkedFrom = null;
if (fromEditor?.project) { project = fromEditor.project; if (!workspace && fromEditor.game) run = createRun(fromEditor.game, portalHooks()); }
else try { const saved = standalone ? $('#compiled-project').textContent : (localStorage.getItem(STORAGE) ?? localStorage.getItem('vsight.shooter.project.v1')); if (saved) { const doc = parseProjectText(saved).project; project = resolveProject(doc); if (standalone && isGame(doc)) run = createRun(resolveGame(doc), portalHooks()); } } catch { /* Invalid/old saved projects use supported defaults. */ }

function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4200); }
function log(message) { logs.push(message); logs = logs.slice(-8); updateDetails(); }
function save() {
  if (workspace === 'remix' && !graphLink) { toEditor({ type: 'visigence:mission', mission: project }); return; }
  if (standalone || graphLink) return;
  try { localStorage.setItem(STORAGE, JSON.stringify(project)); $('#save-status').innerHTML = '<i></i>Saved locally'; }
  catch { $('#save-status').textContent = 'Session only'; }
}
function change(patch) {
  if (graphLink) { graphLink.patch(patch, 'Edit mission graph'); project = graphLink.project(); render(); return; }
  const next = resolveProject({ ...project, ...patch });
  if (JSON.stringify(next) === JSON.stringify(project)) return;
  history.push({ ...project }); if (history.length > 50) history.shift(); future = [];
  project = next;
  save(); render();
}
function selectOption(key, values, label) {
  return `<label class="form-row"><span>${label}</span><select data-field="${key}" aria-label="${label}">${values.map(([value, text]) => `<option value="${value}" ${project[key] === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
}
const city = '<div class="city-art"><i></i><i></i><i></i><i></i></div>';
function themeArt(t) { const art = worldArt(t, renderLibrary); return art ? `style="background-image:url('${art}');background-size:cover;background-position:${t.focus ?? '50% 50%'}"` : art === null ? '' : `style="background-image:url('${assetURL(t.art)}');background-size:${t.artSize};background-position:center ${t.position}"`; }
function card(label, sub, { field, value, image, scene = false, disabled = false } = {}) {
  const selected = field ? project[field] === value : false;
  return `<button class="asset-card ${selected ? 'selected' : ''} ${disabled ? 'unavailable' : ''}" ${disabled ? 'disabled' : ''} ${field ? `data-pick="${field}" data-value="${value}"` : ''} aria-pressed="${selected}"><div class="asset-art ${image ? 'object' : ''}" ${field==='theme'?themeArt(MISSION_THEMES[value]):''}>${scene && currentThumbnail ? `<img src="${currentThumbnail}" alt="Compiled shooter scene">` : image && field!=='theme' ? `<img src="${assetURL(image)}" alt="${label}">` : field==='theme'?'':city}${disabled ? '<span class="soon">COMING SOON</span>' : ''}</div><span class="asset-label">${label}<small>${sub}</small></span></button>`;
}
const categoryKind={environments:'world',weapons:'weapons',enemies:'enemies',doors:'doors',props:'props'};
const board=new BlueprintBoard($('#graph-stage'),{getProject:()=>project,onChange:blueprint=>change({blueprint}),onSelect:id=>{node=id;const n=project.blueprint.nodes.find(n=>n.id===id);category=n?.kind==='objective'?'objectives':['generator','output'].includes(n?.kind)?'themes':Object.keys(categoryKind).find(k=>categoryKind[k]===n?.kind)??category;renderInspector();renderLibrary();},onError:toast});
function selectedPool(kind){return project.blueprint.nodes.find(n=>n.id===node&&n.kind===kind)??project.blueprint.nodes.find(n=>n.kind===kind);}
function updateNode(id,patch){change({blueprint:{...project.blueprint,nodes:project.blueprint.nodes.map(n=>n.id===id?{...n,...patch}:n)}});}
function addNode(kind,objective,items=[]) {
 const graph=project.blueprint;
 if (['generator','output'].includes(kind) && graph.nodes.some(n=>n.kind===kind)) { toast('This board already has that node.'); return; }
 let index=1;while(graph.nodes.some(n=>n.id===`${kind}-${index}`))index++;
 const id=`${kind}-${index}`,x=kind==='generator'?290:kind==='output'?825:kind==='objective'?560:25;
 const n={id,kind,x,y:Math.max(30,...graph.nodes.filter(n=>n.x===x).map(n=>n.y+150))};
 if(kind==='objective')Object.assign(n,{objective,count:objective==='waves'?3:1,duration:objective==='extract'?1.5:3});
 else if(NODE_KINDS[kind].output!=='game'&&kind!=='output')n.items=[...items];
 node=id;board.selected=id;
 change({blueprint:{...graph,nodes:[...graph.nodes,n]}});
}
function renderLibrary(){
 $('#library-title').textContent=category[0].toUpperCase()+category.slice(1);
 for(const el of document.querySelectorAll('[data-category]')){const on=el.dataset.category===category;el.classList.toggle('selected',on);if(on)el.setAttribute('aria-current','true');else el.removeAttribute('aria-current');}
 let cards=[];
 if(category==='themes')cards=Object.entries(THEMES).map(([value,label])=>card(label,MISSION_THEMES[value]?.description??'Compatible asset and world options',{field:'theme',value,image:MISSION_THEMES[value]?.art}));
 else if(category==='objectives')cards=Object.entries(OBJECTIVE_KINDS).filter(([id])=>genreOf(project).objectives.includes(id)).map(([id,def])=>`<button class="asset-card catalog-card" data-add-objective="${id}"><div class="asset-art"><span class="asset-symbol">${id==='waves'?'≋':id==='override'?'▥':id==='boss'?'♜':'◎'}</span></div><span class="asset-label">${def.label}<small>${def.description}</small></span></button>`);
 else{
  const kind=categoryKind[category],pool=selectedPool(kind);
  const assets=CATALOG[project.theme][kind]??[];
  cards=assets.map(a=>`<button class="asset-card catalog-card ${pool?.items.includes(a.id)?'selected':''}" data-asset="${a.id}" data-asset-kind="${kind}" aria-pressed="${!!pool?.items.includes(a.id)}"><div class="asset-art"><img loading="lazy" data-card-model="${a.model??''}" src="${assetURL(a.preview??`assets/catalog/${project.theme}-${kind}-${a.id}.png`)}" alt="${escapeHtml(a.label)}"></div><span class="asset-label">${escapeHtml(a.label)}<small>${kind==='enemies'?(a.boss?'Heavy encounter':'Combatant'):kind==='world'?'World generation options':a.family??a.role??'Animated hands & weapon'}</small></span></button>`);
  // Each environment's own version of a prop (the desert's sandstone, the snow village's snowy barrel): the same
  // prop in the pool, shown with that village's picture, so every world's art is in the library.
  if(kind==='props')for(const B of Object.values(CATALOG[project.theme].biomes??{}))for(const [id,v] of Object.entries(B.props)){
   const a=assets.find(x=>x.id===id);if(!a||!v.preview)continue;const on=!!pool?.items.includes(id);
   cards.push(`<button class="asset-card catalog-card ${on?'selected':''}" data-asset="${id}" data-asset-kind="${kind}" aria-pressed="${on}"><div class="asset-art"><img loading="lazy" src="${assetURL(v.preview)}" alt="${escapeHtml(v.label)}"></div><span class="asset-label">${escapeHtml(v.label)}<small>${escapeHtml(B.label)} · ${escapeHtml(a.label)}</small></span></button>`);
  }
 }
 $('#library-items').innerHTML=cards.join('');$('#asset-count').textContent=String(cards.length).padStart(2,'0');
}
function renderInspector(){
 const priorScroll=$('#inspector').scrollTop;
 const focused=document.activeElement;const focusField=focused?.dataset.field,focusPool=focused?.dataset.poolNode,focusValue=focused?.value;
 const selected=project.blueprint.nodes.find(n=>n.id===node),kind=selected?.kind;
 $('#selected-label').textContent=kind??'CATEGORY';
 let html='';
 if(node==='theme'||!selected){
  html=`<h3 class="inspector-heading">${THEMES[project.theme]} category</h3><p class="inspector-tip">Choose compatible pools, then connect them to your generator. World options assemble geometry and furnishings from your selected assets.</p>`;
  html+=selectOption('genre',Object.values(GENRES).map(g=>[g.id,g.label]),'Genre')+`<p class="inspector-tip">${genreOf(project).description}</p>`;
  html+=selectOption('lighting',[['dawn','Sunny day'],['night','Golden hour']],'Lighting');
  html+=selectOption('palette',[['cyan','Cyan'],['amber','Amber'],['violet','Violet']],'Color palette');
 }else if(selected.items){
  const assets=CATALOG[project.theme][kind];
  html=`<h3 class="inspector-heading">${NODE_KINDS[kind].label}</h3><p class="inspector-tip">Checked assets enter this pool. The generator uses it only while connected.</p><div class="pool-toolbar"><button data-pool-all="${selected.id}">Select all</button><button data-pool-clear="${selected.id}">Clear</button></div><div class="pool-options">${assets.map(a=>`<label class="pool-option"><input type="checkbox" data-pool-node="${selected.id}" value="${a.id}" ${selected.items.includes(a.id)?'checked':''}><img loading="lazy" data-card-model="${a.model??''}" width="46" height="46" src="${assetURL(a.preview??`assets/catalog/${project.theme}-${kind}-${a.id}.png`)}" alt=""><span>${escapeHtml(a.label)}<small>${a.boss?'Heavy encounter':a.family??a.role??''}</small></span></label>`).join('')}</div>`;
  if(kind==='world')html+=selectOption('cover',[['light','Light'],['balanced','Balanced'],['dense','Dense']],'Cover density');
 }else if(kind==='objective'){
  html=`<h3 class="inspector-heading">${OBJECTIVE_KINDS[selected.objective].label}</h3><p class="inspector-tip">${OBJECTIVE_KINDS[selected.objective].description} Mission connections determine when this step runs.</p>${['activate','override','barricade','waves'].includes(selected.objective)?`<label class="form-row"><span>${selected.objective==='waves'?'Waves':'Targets'}</span><input type="number" min="1" max="${selected.objective==='waves'?12:4}" data-node-setting="count" value="${selected.count}" aria-label="Objective count"></label>`:''}${['activate','override','barricade','extract'].includes(selected.objective)?`<label class="form-row"><span>Hold / unlock time</span><input type="number" min="0.5" max="120" step="0.5" data-node-setting="duration" value="${selected.duration}" aria-label="Objective duration"></label>`:''}`;
 }else if(kind==='generator'){
  html='<h3 class="inspector-heading">Generation rules</h3>'+selectOption('difficulty',[['easy','Recruit'],['normal','Operator'],['hard','Veteran']],'Difficulty')+selectOption('behavior',[['guard','Guard & respond'],['hunt','Hunt the player']],'Enemy behavior');
  html+=`<label class="form-row"><span>Encounter population</span><input data-field="enemyCount" type="number" min="1" max="12" value="${project.enemyCount}" aria-label="Enemy units"></label><label class="form-row"><span>World seed</span><input data-field="seed" maxlength="24" value="${escapeHtml(project.seed)}" aria-label="World seed"></label>`;
  if(genreOf(project).weapons)html+=selectOption('weapon',weaponOptions().filter(([id])=>project.blueprint.nodes.some(n=>n.kind==='weapons'&&n.items.includes(id))),'Starting weapon');
 }else if(kind==='output')html='<h3 class="inspector-heading">Playable output</h3><p class="inspector-tip">The connected graph is compiled into a self-contained game. Disconnected pools and mission steps are excluded.</p><button class="primary" id="export-game">Download playable game</button><button class="subtle" id="inspector-export">Download project JSON</button>';
 html+=selectOption('quality',[['performance','Performance'],['balanced','Balanced'],['quality','Quality']],'Graphics')+selectOption('frameRate',[[60,'60 FPS'],[30,'30 FPS · Battery saver']],'Frame rate');
 if(selected)html+=`<button class="node-remove" data-remove-node="${selected.id}">Remove node</button>`;
 $('#inspector').innerHTML=html;icons($('#inspector'));$('#inspector').scrollTop=priorScroll;
 if(focusField)$('#inspector').querySelector(`[data-field="${CSS.escape(focusField)}"]`)?.focus({preventScroll:true});
 if(focusPool)$('#inspector').querySelector(`[data-pool-node="${CSS.escape(focusPool)}"][value="${CSS.escape(focusValue)}"]`)?.focus({preventScroll:true});
}
function render(){
 $('#project-name').value=project.name;
 $('#undo').disabled=graphLink?!graphLink.store.canUndo():!history.length;$('#redo').disabled=graphLink?!graphLink.store.canRedo():!future.length;
 $('#back-to-build').hidden=!graphLink;
 renderLibrary();renderInspector();board.render();updateDraftState();playerFront?.render();
}
function validateGraph(){
 try{const c=compileBlueprint(project.blueprint,CATALOG[project.theme],{genre:genreOf(project)});$('#graph-status').textContent=`${c.mission.length} mission steps · ${project.blueprint.edges.length} connections`;$('#graph-status').classList.remove('graph-error');return c;}
 catch(error){$('#graph-status').textContent=error.message;$('#graph-status').classList.add('graph-error');return null;}
}
function isDraftDirty() { return generationKey(project) !== generationKey(completedBuild); }
function updateDraftState() {
  const valid = !!validateGraph(), dirty = isDraftDirty();
  for (const el of document.querySelectorAll('.compile')) el.disabled = building || !valid;
  $('#play-preview').disabled = building || dirty || !completedBuild;
  $('#expand-preview').disabled = building || dirty || !completedBuild;
  if (building) return;
  if (dirty && expanded && !standalone) closePlay();
  if (!expanded) session?.setRendering(false);
  const shown = completedBuild;
  $('#preview-sector').textContent = shown ? `${THEMES[shown.theme].toUpperCase()} · ${shown.lighting.toUpperCase()} / ${shown.seed}` : 'BLUEPRINT / NOT GENERATED';
  $('#preview-location').textContent = shown ? shown.name.toUpperCase() : 'YOUR NEXT MISSION';
  $('#preview-loading').hidden = !!shown; $('#preview-loading').classList.remove('is-error'); poster();
  $('#preview-loading .loader').hidden = true;
  $('#preview-loading strong').textContent = valid ? 'Your mission is ready to generate' : 'Blueprint needs a connection';
  $('#load-status').textContent = valid ? 'Choose assets and connect mission steps. Generate & play creates the game when you are ready.' : $('#graph-status').textContent;
  const status = !valid ? 'Blueprint needs a connection' : dirty ? (shown ? 'Changes pending · click Generate & play' : 'Blueprint ready · click Generate & play') : 'Generated game ready · Play';
  $('#engine-status').textContent = status;
  $('#build-caption').textContent = status;
  updateDetails();
}
// Before a build, the output panel shows the world it will generate rather than an empty box.
function poster() { const art = worldArt(MISSION_WORLDS[missionWorld(project)] ?? MISSION_THEMES.arcade, poster); $('#preview-loading').style.setProperty('--poster', art ? `url('${art}')` : 'none'); }
function fitGraph(){board.fit();}
new ResizeObserver(fitGraph).observe($('#graph-viewport'));
function updateDetails(stats) {
  if (previewTab === 'logs') $('#preview-details').textContent = logs.slice(-3).join(' · ') || 'Waiting for the first build.';
  else if (previewTab === 'performance' && !expanded) $('#preview-details').textContent = 'Rendering paused while you edit. Play the generated game to see live performance.';
  else if (previewTab === 'performance' && stats) $('#preview-details').textContent = `${stats.fps} FPS · ${stats.draws ?? '—'} draw calls · ${Number(stats.triangles ?? 0).toLocaleString()} triangles`;
  else if (previewTab === 'preview') $('#preview-details').textContent = expanded ? 'WASD move · Mouse aim · Click fire · E interact · R reload · Esc pause' : completedBuild ? (isDraftDirty() ? 'Last generated game · changes pending. Click Generate & play to apply them.' : 'Generated preview paused · click Play to run the game.') : 'Connect your blueprint, then click Generate & play.';
}
function frame(stats) {
  if (capturePending && !building) {
    capturePending = false;
    try {
      currentThumbnail = session.canvas.toDataURL('image/jpeg', 0.7);
      for (const img of document.querySelectorAll('.scene-thumbnail')) { img.src = currentThumbnail; img.hidden = false; }
      renderLibrary(); renderInspector();
    } catch { /* Preview remains live if the browser does not allow a thumbnail. */ }
  }
  // The reticle opens with the weapon's spread and recoil every frame, and gives way to the sights while aiming.
  const w = stats.weapon, cross = $('#crosshair');
  cross.style.setProperty('--spread', w ? ((w.spread ?? 0) + (w.recoil ?? 0) * .4).toFixed(3) : '0'); cross.style.opacity = w && !w.keepAimReticle ? String(1 - (w.adsBlend ?? 0)) : '1';
  // Hits draw an arc toward their source; the player controller already samples four fading bearings.
  const cues = expanded ? session?.game?.player?.damageIndicators?.() : null;
  damageArcs.forEach((arc, i) => { const cue = cues?.[i]; arc.style.opacity = cue ? cue.opacity.toFixed(3) : '0'; if (cue?.opacity > 0) arc.style.transform = `rotate(${cue.angle}rad)`; });
  if (performance.now() - lastHud < 130) return; lastHud = performance.now();
  updateDetails(stats);
  $('#health-value').textContent = Math.round(stats.health);
  $('#health-bar').style.width = Math.max(0, stats.health) + '%'; $('.health-hud').classList.toggle('low', stats.health > 0 && stats.health <= 30);
  $('.ammo-hud').dataset.level = !w ? '' : w.state === 'RELOADING' ? 'reload' : w.mag === 0 ? 'empty' : w.mag <= w.magSize * .25 ? 'low' : '';
  $('#ammo-value').innerHTML = stats.weapon ? `${stats.weapon.mag ?? 0} <small>/ ${stats.weapon.reserve ?? 0}</small>` : '';
  const lv = stats.level;
  $('#weapon-name').textContent = stats.weapon?.state === 'RELOADING' ? 'RELOADING…' : stats.weapon?.name ?? ({ exploration: 'HANDS FREE', action: 'TRAIL STAFF', collect: 'HONEY' }[stats.genre] ?? '');
  if (!stats.weapon && stats.genre === 'collect') $('#ammo-value').innerHTML = `${lv?.collected ?? 0} <small>/ ${lv?.total ?? 0}</small>`;
  $('#lives-value').hidden = !(lv?.maxLives > 1); if (lv?.maxLives > 1) $('#lives-value').textContent = `${lv.lives} ${lv.lives === 1 ? 'LIFE' : 'LIVES'}`;
  // The reticle is the first person's; the arena aims with the pointer itself.
  cross.hidden = stats.view !== 'first'; if (session?.canvas) session.canvas.style.cursor = stats.view === 'overhead' && stats.playing ? 'crosshair' : '';
  const o = stats.objectives;
  $('#mission-label').textContent=(o?.label??'EXPLORE')+(o?.encounterRemaining!=null?` · ${o.encounterRemaining} remaining`:'')+(o?.targetsTotal?` · ${o.targetsCompleted}/${o.targetsTotal}`:'')+(o?.targetDistance!=null?` · ${o.targetDirection} ${o.targetDistance}m`:'');
  $('#inventory-bar').hidden=!expanded;const coarse=matchMedia('(pointer:coarse)').matches;$('#inventory-bar').textContent=stats.weapon?(coarse?'':(stats.inventory??[]).join(' · ')+` · G grenade (${stats.grenades??0})`):stats.genre==='exploration'?(stats.exploration?`${coarse?'Journal':'E interact · J journal'} (${stats.exploration.notes})${stats.exploration.inventory.length?' · '+stats.exploration.inventory.join(', '):''}${stats.exploration.message?' · '+stats.exploration.message:''}`:(coarse?'':'E hold to interact · Shift sprint')):'';
  $('#mission-progress').textContent = `${run ? `LEVEL ${run.index + 1}/${run.total} · ` : ''}${o?.completed ?? 0} / ${o?.total ?? 0} · ${Math.floor((stats.time??0)/60)}:${String(Math.floor((stats.time??0)%60)).padStart(2,'0')}`;
  $('#interaction-prompt').textContent = stats.interaction ? `Hold ${matchMedia('(pointer:coarse)').matches ? 'USE' : 'E'} · ${stats.interaction.label}` : ''; $('#interaction-prompt').style.setProperty('--p', stats.interaction?.progress ?? 0);
  $('#game-hud').hidden = !expanded; $('#touch-controls').hidden = !expanded || !stats.playing || !matchMedia('(pointer:coarse)').matches; $('#game-pause').hidden = !expanded || !stats.playing;
  if(stats.exploration?.document){$('#play-overlay').hidden=true;lastOverlay='';return;}
  if (expanded && !stats.playing) {
    const key = stats.state;
    if (lastOverlay !== key && run) { lastOverlay = key; runCard(key, stats); }
    else if (lastOverlay !== key) {
      lastOverlay = key; $('#play-overlay').hidden = false; playerFront?.result(completedBuild??project,stats); session.canvas.tabIndex = -1;
      $('#play-eyebrow').textContent = key === 'VICTORY' ? 'MISSION COMPLETE' : key === 'PLAYER_DEAD' ? 'MISSION FAILED' : key === 'PAUSED' ? 'MISSION PAUSED' : 'YOUR MISSION IS READY';
      const played = genreOf(completedBuild??project);
      $('#play-title').textContent = key === 'VICTORY' ? 'Mission accomplished.' : key === 'PLAYER_DEAD' ? (played.id === 'shooter' ? 'Operator down.' : 'Out of lives.') : (completedBuild??project).name;
      const outcome = key === 'VICTORY' ? (played.weapons ? `${stats.kills} hostiles eliminated. Mission sequence complete.` : played.id === 'collect' ? `${stats.level?.collected ?? 0} honey drops gathered. Mission sequence complete.` : 'Mission sequence complete.')
        : key === 'PLAYER_DEAD' ? (played.weapons ? 'Your blueprint is ready for another run. Use cover and watch your ammunition.' : 'Your blueprint is ready for another run.') : null;
      if (outcome) $('#play-description').textContent = outcome;
      else $('#play-description').innerHTML = session?.level.blueprint.mission.map((n, i) => `<span class="brief-step"><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(OBJECTIVE_KINDS[n.objective].label)}</span>`).join('') || 'Complete the connected mission objectives.';
      $('#start-mission').innerHTML = `<span data-icon="play"></span>${key === 'PAUSED' ? 'Resume mission' : ['VICTORY', 'PLAYER_DEAD'].includes(key) ? 'Play again' : 'Start mission'}`; icons($('#start-mission'));
      if (!document.pointerLockElement) $('#start-mission').focus({ preventScroll: true });
    }
  } else if (stats.playing) { $('#play-overlay').hidden = true; lastOverlay = ''; session.canvas.tabIndex = 0; }
}
const damageArcs = [...document.querySelectorAll('.damage-ring i')];
let feedbackTimer;
function combatFeedback(kind) {
  const marker=$('#hit-marker');clearTimeout(feedbackTimer);marker.className='';void marker.offsetWidth;marker.className=kind;
  const label={hit:'',headshot:'HEADSHOT',kill:'HOSTILE DOWN',clear:'AREA CLEAR'}[kind]??'';
  $('#combat-feedback').textContent=label;
  feedbackTimer=setTimeout(()=>{$('#combat-feedback').textContent='';marker.className='';},kind==='clear'?1100:kind==='kill'?650:kind==='headshot'?400:180);
}
/**
 * The first few frames of an error's stack, as `function file:line`, in a form that survives a
 * screenshot. An engine failure on a browser that no test machine has (macOS Safari reported a
 * WeakMap key error at the first frame with nothing to say where) is only diagnosable from
 * the native stack, and the developer console is not where a player looks.
 */
function errorOrigin(error, frames = 4) {
  const stack = String(error?.stack ?? ''), message = String(error?.message ?? '');
  const lines = stack.split('\n').map(l => l.trim()).filter(l => l && !message.includes(l) && !l.startsWith(`${error?.name}:`));
  return lines.slice(0, frames).map(line => {
    // Chromium: "at fn (url:line:col)"; WebKit and Gecko: "fn@url:line:col".
    // The column is kept: a minified bundle is one line, so the column is the only locator.
    const m = line.match(/^(?:at\s+)?([^@(\s]*)?[@(]?\s*(?:.*?\/)?([^/\s()]+?):(\d+(?::\d+)?)\)?$/);
    return m ? `${m[1] || '(anonymous)'} ${m[2]}:${m[3]}` : line;
  }).join(' ← ');
}
function errorDisplay(error) {
  console.error(error); $('#preview-loading').hidden = false; $('#preview-loading').classList.add('is-error');
  $('#preview-loading strong').textContent = 'Could not build the mission';
  const origin = errorOrigin(error), detail = origin ? `${error.message}\n${origin}` : error.message;
  $('#load-status').textContent = detail; $('#preview-loading .loader').hidden = true;
  $('#engine-status').textContent = 'Build needs attention'; log(detail);
  // The launcher keeps the failure on screen; the studio and standalone games report it in a toast.
  if (document.body.dataset.mode === 'play' && !standalone && playerFront) playerFront.failed(detail); else toast(detail);
}
async function ensureSession() {
  if (boot) return boot;
  boot = (async () => {
    const { ShooterSession } = await import('../src/game/ShooterSession.js');
    session = new ShooterSession($('#game-canvas'), { onStatus: text => { $('#load-status').textContent = text; playerFront?.status(text); }, onFrame: frame, onError: errorDisplay, onFeedback: combatFeedback });
    session.lookSensitivity=Number($('#look-sensitivity').value)||1;
    await session.initialize();
    session.setRendering(false);
  })();
  try { await boot; } catch (error) { session?.dispose(); session = null; boot = null; throw error; }
}
// Only Generate & play (or opening an already packaged game) loads a world.
// One explicit build owns one snapshot; editing during it never queues another build.
function queueBuild(play = false) {
  if (building) return buildChain;
  if (!validateGraph()) { updateDraftState(); toast($('#graph-status').textContent); return Promise.resolve(); }
  const version = ++buildVersion, snapshot = structuredClone(project);
  if (expanded) closePlay();
  session?.stop(); session?.setRendering(false);
  building = true; completedBuild = null; playerFront?.building(true);
  $('#preview-loading').hidden = false; $('#preview-loading').classList.remove('is-error'); $('#preview-loading .loader').hidden = false;
  $('#preview-loading strong').textContent = 'Assembling your world';
  $('#load-status').textContent = 'Starting the game engine…';
  $('#engine-status').textContent = 'Compiling shooter mission…';
  updateDraftState();
  buildChain = (async () => {
    let failure;
    try {
      if(snapshot.importedProps?.length && !standalone){const {prepareImportedAssets}=await import('./assetImport.js');await prepareImportedAssets(snapshot);}
      if(snapshot.presentation?.artwork||snapshot.presentation?.logo){const {preparePresentation}=await import('./creatorTools.js');await preparePresentation(snapshot);}
      await ensureSession(); await session.build(snapshot,{isCurrent:()=>version===buildVersion});
      completedBuild = snapshot;
      log(`${environmentName(snapshot)} compiled: ${snapshot.enemyCount} enemies, ${session.level.blueprint.mission.length} mission steps`);
    } catch (error) { failure = error; }
    finally {
      building = false; playerFront?.building(false);
      updateDraftState();
    }
    if (failure) { errorDisplay(failure); return; }
    if (play && !isDraftDirty()) openPlay();
    else {
      // Render a single preview of the completed snapshot, then remain idle.
      session.resize(); session.frame(performance.now());
    }
  })();
  return buildChain;
}
function openPlay() {
  if (!session?.game || building || isDraftDirty()) return;
  document.body.classList.add('mission-playing');$('#player-front').inert=true;
  playControls(genreOf(project));
  expanded = true; lastOverlay = ''; session.stop(); session.setRendering(true);
  $('#preview-panel').style.setProperty('--cyan', MISSION_THEMES[project.theme].accent);
  $('#preview-panel h2').textContent=project.name; $('#overlay-exit').textContent = embedded ? 'Back to the world' : document.body.dataset.mode === 'remix' ? 'Back to studio' : 'Back to worlds';
  const identity=project.presentation??{};$('#mission-author').innerHTML=(identity.logo?`<img src="${assetURL(identity.logo.model)}" alt="Studio logo">`:'')+(identity.studioName?`BY ${escapeHtml(identity.studioName)}`:'');
  $('#play-overlay').style.setProperty('--mission-cover',identity.artwork?`url("${assetURL(identity.artwork.model)}")`:'none');
  $('#preview-panel').classList.add('expanded'); $('#play-overlay').hidden = false;
  $('#game-hud').hidden = false; session.resize(); updateDetails(); $('#start-mission').focus({ preventScroll: true });
}
/** The genre's own controls (genres/registry.js): the guide on the play card, and which touch buttons show. */
function playControls(g) {
  const c = g.controls, coarse = matchMedia('(pointer:coarse)').matches, pad = [...(globalThis.navigator?.getGamepads?.() ?? [])].some(p => p?.connected);
  $('.control-guide').innerHTML = [...(coarse ? c.touch : c.keys), ...(pad ? [c.pad] : [])].map(escapeHtml).join('<br>');
  const buttons = { weapon: '#touch-weapon', grenade: '#touch-grenade', reload: '#touch-reload', use: '#touch-use', aim: '#touch-aim', jump: '#touch-jump', fire: '#touch-fire', aimPad: '#aim-pad' };
  for (const [name, sel] of Object.entries(buttons)) $(sel).hidden = !c.buttons.includes(name);
  $('#touch-fire').textContent = c.fire ?? 'FIRE';
}
function closePlay() {
  if (buildEnd) { const end = buildEnd; buildEnd = null; expanded = false; session?.stop(); session?.setRendering(false);
    for (const id of ['#play-overlay', '#game-hud', '#touch-controls', '#game-pause']) $(id).hidden = true;
    $('#overlay-exit').textContent = 'Back to studio'; end(); return; }
  document.body.classList.remove('mission-playing');$('#player-front').inert=false;
  expanded = false; session?.stop(); $('#preview-panel').classList.remove('expanded');
  $('#play-overlay').hidden = true; $('#game-hud').hidden = true; $('#touch-controls').hidden = true; $('#game-pause').hidden = true;
  // Keyboard focus returns to the control that starts play, not to the top of the page.
  $(document.body.dataset.mode === 'remix' ? '#compile-top' : '.featured-mission .mission-play')?.focus({ preventScroll: true });
  session?.resize();
  if (session?.game) session.frame(performance.now());
  session?.setRendering(false); updateDetails();
}
function exportProject() {
  const blob = new Blob([JSON.stringify(packageProject(project), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url;
  a.download = (project.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'shooter') + '.visigames.json';
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Project exported. Reopen it in Visigames to rebuild the same mission.');
}
document.addEventListener('click', e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.id === 'new-project') { node='theme';board.selected=null;category='themes';change({...PROJECT_DEFAULTS,ground:NEW_PROJECT_GROUND,player:'player',blueprint:createEmptyBlueprint()});toast('Empty project ready. Add nodes and connect their ports.'); }
  if (button.dataset.category) {
    category=button.dataset.category;node=category==='themes'?'theme':category==='objectives'?(project.blueprint.nodes.find(n=>n.kind==='objective')?.id??'theme'):(selectedPool(categoryKind[category])?.id??'theme');board.selected=node;render();
  }
  if (button.dataset.node) { node = button.dataset.node; render(); }
  if (button.dataset.pick) {
    if (button.dataset.pick === 'theme' && button.dataset.value === project.theme) return;
    const patch = { [button.dataset.pick]: button.dataset.value };
    if (button.dataset.pick === 'theme') { patch.blueprint={...project.blueprint,nodes:project.blueprint.nodes.map(n=>n.items?{...n,items:[]}:n)};patch.weapon='assault';patch.player='player';node='theme';currentThumbnail = ''; patch.lighting = MISSION_THEMES[button.dataset.value].lighting; patch.palette = THEME_PALETTE[button.dataset.value] ?? 'cyan'; }
    change(patch);
  }
  if (button.dataset.palette) change({ palette: button.dataset.palette });
  if (button.dataset.tab) {
    previewTab = button.dataset.tab; $('#preview-panel').dataset.activeTab = previewTab;
    for (const tab of document.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String(tab === button));
    updateDetails();
  }
  if(button.dataset.asset){const kind=button.dataset.assetKind,pool=selectedPool(kind);if(!pool){addNode(kind,undefined,[button.dataset.asset]);toast('Asset pool added. Connect its port to the generator.');}else updateNode(pool.id,{items:pool.items.includes(button.dataset.asset)?pool.items.filter(id=>id!==button.dataset.asset):[...pool.items,button.dataset.asset]});}
  if(button.dataset.addObjective)addNode('objective',button.dataset.addObjective);
  if(button.dataset.poolAll||button.dataset.poolClear){const id=button.dataset.poolAll??button.dataset.poolClear,n=project.blueprint.nodes.find(n=>n.id===id);updateNode(id,{items:button.dataset.poolAll?CATALOG[project.theme][n.kind].map(a=>a.id):[]});}
  if(button.dataset.removeNode){const id=button.dataset.removeNode;node='generator';board.selected=node;change({blueprint:{...project.blueprint,nodes:project.blueprint.nodes.filter(n=>n.id!==id),edges:project.blueprint.edges.filter(e=>e.from!==id&&e.to!==id)}});}
  if (button.id === 'inspector-export') exportProject();
  if (button.id === 'export-game') downloadGame(button);
});
$('#inspector').addEventListener('change', e => {
  if(e.target.dataset.poolNode){const n=project.blueprint.nodes.find(n=>n.id===e.target.dataset.poolNode);updateNode(n.id,{items:e.target.checked?[...n.items,e.target.value]:n.items.filter(id=>id!==e.target.value)});return;}
  if(e.target.dataset.nodeSetting){updateNode(node,{[e.target.dataset.nodeSetting]:Number(e.target.value)});return;}
  if (!e.target.dataset.field) return;
  try { change({ [e.target.dataset.field]: e.target.value }); } catch (error) { toast(error.message); renderInspector(); }
});
$('#project-name').addEventListener('change', e => change({ name: e.target.value }));
$('#project-name').addEventListener('input', e => change({ name: e.target.value }));
for (const button of document.querySelectorAll('.compile')) button.addEventListener('click', () => workspace === 'remix' ? toEditor({ type: 'visigence:play', mission: project }) : queueBuild(true));
$('#play-preview').addEventListener('click', openPlay);
$('#expand-preview').addEventListener('click', openPlay); $('#close-preview').addEventListener('click', () => { if (expanded && session?.playing) { session.stop(); return; } closePlay(); });
let gameMuted = false;
$('#game-sound').addEventListener('click', () => {
  gameMuted = !gameMuted; session?.audio?.setMuted(gameMuted);
  $('#game-sound').setAttribute('aria-pressed', String(!gameMuted));
});
$('#start-mission').addEventListener('click', () => { if (run) { runPrimary(); return; } session.audio?.setMuted(gameMuted); session.start(); $('#play-overlay').hidden = true; lastOverlay = ''; session.canvas.focus(); });
$('#run-continue').addEventListener('click', runContinue);
$('#zoom').addEventListener('change', fitGraph); $('#reset-view').addEventListener('click', () => { $('#zoom').value = '1'; fitGraph(); });
$('#undo').addEventListener('click', () => { if (graphLink) { graphLink.store.undo(); project = graphLink.project(); render(); return; } if (!history.length) return; future.push(project); project = history.pop(); save(); render(); });
$('#redo').addEventListener('click', () => { if (graphLink) { graphLink.store.redo(); project = graphLink.project(); render(); return; } if (!future.length) return; history.push(project); project = future.pop(); save(); render(); });
$('#export-project').addEventListener('click', exportProject);
$('#import-project').addEventListener('click', () => $('#project-file').click());
$('#project-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (file.size > 100000) throw new Error('Choose a Visigames project JSON file under 100 KB.');
    const opened = parseProjectText(await file.text(), { requireEnvelope: true });
    const next = resolveProject(opened.project); history.push(project); future = []; project = next; save(); render();
    for (const w of opened.warnings) log(`Project file: ${w.path} ${w.message}`);
    toast(opened.migrated ? `Project opened and updated from format ${opened.from}. Connect the blueprint, then click Generate & play.` : 'Project opened. Connect the blueprint, then click Generate & play.');
  } catch (error) { toast(error.message); }
  e.target.value = '';
});
const pad = $('#move-pad');
function movePad(e) {
  if (!session || !pad.hasPointerCapture(e.pointerId)) return;
  const r = pad.getBoundingClientRect(), x = (e.clientX - r.left - r.width / 2) / 36, y = -(e.clientY - r.top - r.height / 2) / 36;
  const length = Math.max(1, Math.hypot(x, y)); session.touchMove = { x: x / length, y: y / length };
  pad.firstElementChild.style.transform = `translate(${x / length * 26}px,${-y / length * 26}px)`;
}
pad.addEventListener('pointerdown', e => { pad.setPointerCapture(e.pointerId); pad.classList.add('is-active'); movePad(e); });
pad.addEventListener('pointermove', movePad);
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(event, () => { if (session) session.touchMove = { x: 0, y: 0 }; pad.firstElementChild.style.transform = ''; pad.classList.remove('is-active'); });
// The arena's right-hand pad aims where it is pushed and fires while held (genres/arena/rules.js).
const aimPad = $('#aim-pad');
function moveAim(e) {
  if (!session || !aimPad.hasPointerCapture(e.pointerId)) return;
  const r = aimPad.getBoundingClientRect(), x = (e.clientX - r.left - r.width / 2) / 36, y = -(e.clientY - r.top - r.height / 2) / 36;
  const length = Math.max(1, Math.hypot(x, y)); session.touchAim = { x: x / length, y: y / length };
  aimPad.firstElementChild.style.transform = `translate(${x / length * 26}px,${-y / length * 26}px)`;
}
aimPad.addEventListener('pointerdown', e => { aimPad.setPointerCapture(e.pointerId); aimPad.classList.add('is-active'); moveAim(e); });
aimPad.addEventListener('pointermove', moveAim);
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) aimPad.addEventListener(event, () => { if (session) session.touchAim = null; aimPad.firstElementChild.style.transform = ''; aimPad.classList.remove('is-active'); });
for (const [id, field] of [['touch-fire', 'fire'], ['touch-use', 'interact'], ['touch-aim', 'ads'], ['touch-jump', 'touchJump']]) {
  const button = $('#' + id);
  button.addEventListener('pointerdown', e => { e.preventDefault(); button.setPointerCapture(e.pointerId); if (session) session[field] = true; });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, () => { if (session) session[field] = false; });
}
for (const button of document.querySelectorAll('.touch-actions button')) {
  button.addEventListener('pointerdown', () => button.classList.add('is-active'));
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, () => button.classList.remove('is-active'));
}
$('#graph-focus').addEventListener('click',()=>{const focused=$('.graph').classList.toggle('focused');$('#graph-focus').textContent=focused?'Close graph':'Focus graph';fitGraph();});
$('#add-node').addEventListener('click',()=>{const [kind,objective]=$('#add-node-type').value.split(':');addNode(kind,objective);});
$('#touch-weapon').addEventListener('click',()=>{if(session?.game?.weapons){const w=session.game.weapons;session.actions.weapon=w.order[(w.order.indexOf(w.current.id)+1)%w.order.length];}});
$('#touch-grenade').addEventListener('click',()=>{if(session)session.actions.grenade=true;});
$('#touch-reload').addEventListener('click', () => { if (session) session.actions.reload = true; });
$('#game-pause').addEventListener('click', () => { if (session?.playing) { session.stop(); session.audio?.playOneShot('uiEsc'); } });
$('#overlay-exit').addEventListener('click', () => embedded && !workspace ? leaveForWorld() : $('#close-preview').click());
if (embedded) $('#overlay-exit').textContent = 'Back to the world';
// In the editor's Level workspace the level editor's way back goes to the editor's world.
if (workspace === 'build') for (const b of document.querySelectorAll('.bld-back[data-bld="exit"]')) b.lastChild.textContent = 'World';
window.addEventListener('pagehide', () => session?.dispose(), { once: true });
try {$('#look-sensitivity').value=localStorage.getItem('visigames.lookSensitivity')??'1';}catch{}
$('#look-sensitivity-value').textContent=Number($('#look-sensitivity').value).toFixed(1)+'×';
$('#look-sensitivity').addEventListener('input',e=>{const n=Math.max(.5,Math.min(1.8,Number(e.target.value)||1));if(session)session.lookSensitivity=n;$('#look-sensitivity-value').textContent=n.toFixed(1)+'×';try{localStorage.setItem('visigames.lookSensitivity',String(n));}catch{}});
document.title = standalone ? project.name : 'Visigence Engine';
if (standalone) $('#preview-panel h2').textContent = `${THEMES[project.theme]} / Mission`;
installModelCards();
playerFront=mountPlayerFront({getProject:()=>project,change,play:()=>queueBuild(true),remix:()=>{render();requestAnimationFrame(fitGraph);},build:()=>enterBuild(),toast,download:downloadGame});
render(); if (!workspace) save();
if (fromEditor?.error) errorDisplay(new Error(`The world editor's mission cannot be read: ${fromEditor.error}`));
else if (standalone) queueBuild(true);
else if (workspace === 'remix') playerFront.mode('remix');
else if (workspace === 'build') enterBuild(fromEditor.game ?? resolveGame(project));
if (workspace) toEditor({ type: 'visigence:ready' });
// Arriving from the landing page with a vision: build it and open the canvas on it (docs/VISION.md).
const vision = standalone || workspace ? null : visionFromURL();
if (vision) arriveWithVision(vision, { change, toast, fitGraph, enterCanvas: () => {
  document.body.dataset.mode = 'remix'; $('#remix-return').hidden = false; window.scrollTo(0, 0);
  node = 'generator'; board.selected = null; category = 'themes';
} });
// Arriving from the landing hub on a tool: ?mode=build (with &template=, &game= or &new=<genre>) opens the level editor,
// ?mode=remix the mission graph; ?genre= and ?world= were read by the launcher (docs/STUDIO.md). The link is then taken
// off the address, so a reload does not, say, copy the template again.
if (!standalone && !workspace && typeof location !== 'undefined') {
  const link = new URLSearchParams(location.search), HUB = ['mode', 'template', 'game', 'new', 'genre', 'world'];
  const linked = link.get('mode');
  if (!vision && linked === 'build') enterBuild(null, { template: link.get('template'), game: link.get('game'), blank: link.get('new') });
  else if (!vision && linked === 'remix') playerFront.mode('remix');
  if (HUB.some(k => link.has(k))) {
    for (const k of HUB) link.delete(k);
    const rest = link.toString();
    window.history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash); // `history` here is the undo stack
  }
}

// ------------------------------------------------------------------ a game of levels, played through (editor/gameRun.js)
/** The play card for one moment of a game run: the title, a level about to start, a level won, the end, a loss. */
function runCard(key, stats) {
  const r = run, g = r.game, n = r.total, lv = r.level;
  $('#play-overlay').hidden = false; $('#mission-result').hidden = true; $('#result-actions').hidden = true; session.canvas.tabIndex = -1;
  let eyebrow, title, description, button, offer = false;
  if (key === 'VICTORY') {
    if (r.complete({ time: stats.time, kills: stats.kills }) === 'next') {
      eyebrow = `LEVEL ${r.index + 1} OF ${n} COMPLETE`; title = `${lv.name}: done.`; description = `Next: ${g.levels[r.index + 1].name}.`; button = 'Next level';
    } else {
      eyebrow = 'GAME COMPLETE'; title = `${g.name}, complete.`; button = 'Play again';
      description = `${n} level${n > 1 ? 's' : ''} in ${formatTime(r.time)}.${g.publish?.showCredits !== false ? ' Made with Visigame.' : ''}`;
    }
  } else if (key === 'PLAYER_DEAD') {
    r.over(); offer = r.canContinue;
    eyebrow = 'GAME OVER'; title = 'Out of lives.'; button = 'Retry level';
    description = offer ? 'Watch an ad to carry on from your last checkpoint with your lives back, or try the level again.' : 'Try the level again from its start.';
  } else if (key === 'PAUSED') {
    r.pause(); eyebrow = `PAUSED · LEVEL ${r.index + 1} OF ${n}`; title = lv.name; button = 'Resume';
  } else if (!r.started) {
    eyebrow = `A GAME IN ${n} LEVEL${n > 1 ? 'S' : ''}${g.publish?.showCredits !== false ? ' · MADE WITH VISIGAME' : ''}`; title = g.name; button = 'Start game';
    description = g.levels.map((l, i) => `<span class="brief-step"><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(l.name)}</span>`).join('');
  } else { eyebrow = `LEVEL ${r.index + 1} OF ${n}`; title = lv.name; button = 'Start level'; }
  description ??= session?.level.blueprint.mission.map((m, i) => `<span class="brief-step"><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(OBJECTIVE_KINDS[m.objective].label)}</span>`).join('') ?? '';
  playCard(eyebrow, title, description, button);
  $('#run-continue').hidden = !offer;
}
/** Fill the play card; `button` null hides the action (an ad break, a level loading). `description` may hold markup. */
function playCard(eyebrow, title, description, button) {
  $('#play-overlay').hidden = false;
  $('#play-eyebrow').textContent = eyebrow; $('#play-title').textContent = title; $('#play-description').innerHTML = description;
  $('#start-mission').hidden = !button; $('#run-continue').hidden = true;
  if (button) { $('#start-mission').innerHTML = `<span data-icon="play"></span>${escapeHtml(button)}`; icons($('#start-mission')); if (!document.pointerLockElement) $('#start-mission').focus({ preventScroll: true }); }
}
/** The card's action: start or retry the level, resume, go on to the next level (through its ad break), or again. */
async function runPrimary() {
  if (runFailed !== null) { const i = runFailed; runFailed = null; runLevel(i); return; }
  const key = session.game.state.current;
  if (key === 'VICTORY') {
    if (run.last) { runLevel(0); return; }
    if (run.game.publish?.adBreaks) playCard(`AD BREAK${run.hooks.simulated ? ' · SIMULATED' : ''}`, 'Back after the break.', run.hooks.simulated ? 'A web portal shows its ad here, between levels. Exported games call window.VisigameHooks; switch ad breaks off in Export.' : 'The next level loads when the ad is over.', null);
    const token = runToken;
    await run.next();
    if (token === runToken) runLevel(run.index);
    return;
  }
  if (key === 'PAUSED') run.resume(); else run.begin();
  session.audio?.setMuted(gameMuted); session.start(); $('#play-overlay').hidden = true; lastOverlay = ''; session.canvas.focus();
}
/** The rewarded continue: a portal's ad, then the level carries on from its checkpoint. */
async function runContinue() {
  if (!run?.canContinue) return;
  playCard(`AD BREAK${run.hooks.simulated ? ' · SIMULATED' : ''}`, 'Your continue is on its way.', run.hooks.simulated ? 'A web portal shows its rewarded ad here. This one is simulated and always rewards.' : 'The level carries on when the ad is over.', null);
  const token = runToken, earned = await run.rewarded();
  if (token !== runToken) return;
  if (earned && session.continueRun()) { $('#play-overlay').hidden = true; lastOverlay = ''; session.canvas.focus(); return; }
  lastOverlay = ''; session.frame(performance.now());
}
/** Build level i of the run and show its card. */
async function runLevel(i) {
  const token = ++runToken;
  run.go(i);
  const flat = resolveProject(run.project());
  session?.stop();
  playCard(`LOADING LEVEL ${i + 1} OF ${run.total}`, run.level.name, 'Growing the village and loading its art.', null);
  try { await ensureSession(); await session.build(flat, { isCurrent: () => token === runToken }); }
  catch (error) {
    if (token !== runToken) return;
    // The card says what failed and offers the same level again; the game never skips ahead past a level it could not load.
    console.error(error); log(`Level ${i + 1} could not load: ${error.message}`);
    runFailed = i; playCard(`LEVEL ${i + 1} OF ${run.total} COULD NOT LOAD`, run.level.name, escapeHtml(error.message), 'Try again');
    return;
  }
  if (token !== runToken) return;
  if (standalone) { project = flat; completedBuild = flat; }
  session.setEditView(null); session.setRendering(true); session.resize();
  lastOverlay = ''; session.frame(performance.now());
}
/** The editor's stand-in for a portal: ad breaks shown as a card for a moment (a rewarded one always pays), events to the log. */
function editorHooks() {
  return {
    simulated: true,
    adBreak: kind => new Promise(resolve => { log(`Portal: ad break (${kind}), simulated`); setTimeout(() => resolve(kind === 'rewarded'), 1600); }),
    event: (name, data) => log(`Portal event: ${name} ${JSON.stringify(data)}`),
  };
}
/** "Play the whole game" in the level editor: the run with the editor's stand-in hooks; `onEnd` when it is left. */
async function playGame(game, { onEnd }) {
  run = createRun(game, editorHooks()); runFailed = null;
  buildEnd = () => { run = null; runFailed = null; runToken++; $('#start-mission').hidden = false; $('#run-continue').hidden = true; onEnd(); };
  expanded = true; lastOverlay = '';
  $('#overlay-exit').textContent = 'Back to editor';
  for (const id of ['#result-home', '#result-share']) $(id).hidden = true;
  playControls(genreOf(game));
  $('#game-hud').hidden = false;
  session?.audio?.setMuted(gameMuted); session?.audio?.resume();
  await runLevel(0);
}

// ------------------------------------------------------------------ Build mode (editor/build/)
/**
 * Open the level editor. With a game it opens that one (a new entry among the games saved in this browser); without,
 * the game already open comes back, or the editor's start screen (templates, saved games, blank starts) shows.
 */
async function enterBuild(game = null, route = null) {
  if (standalone) return;
  if (expanded) closePlay();
  if (graphLink) leaveGraph();
  buildFrom = document.body.dataset.mode === 'play' ? 'play' : 'remix';
  document.body.dataset.mode = 'build';
  if (!buildMode) {
    const { mountBuild } = await import('./build/app.js');
    buildMode = mountBuild($('#build'), {
      session: () => session, ensureSession: async () => { await ensureSession(); return session; },
      viewport: $('#preview-viewport'), storage: localStorage, toast,
      playtest: buildPlaytest, stopPlaytest: () => closePlay(), openGraph, exit: exitBuild, playGame,
      exportFile: downloadBuildGame, exportZip: downloadBuildZip,
    });
  }
  completedBuild = null; session?.stop();
  if (route && buildMode.route(route)) return;
  await buildMode.show(game);
  // In the editor's Level workspace every step of the level editor goes back to the editor, which keeps the mission.
  const st = buildMode.store;
  if (workspace === 'build' && st && !st.toEditor) {
    let t = null;
    st.toEditor = true;
    st.on('*', (kind) => { if (kind === 'history' || kind === 'game' || kind === 'level') { clearTimeout(t); t = setTimeout(() => toEditor({ type: 'visigence:mission', mission: st.game }), 120); } });
  }
}
function exitBuild() {
  if (workspace === 'build') { const st = buildMode?.store; if (st) toEditor({ type: 'visigence:mission', mission: st.game }); leaveForWorld(); return; }
  buildMode?.hide();
  $('#preview-panel').insertBefore($('#preview-viewport'), $('#preview-panel .preview-tabs'));
  document.body.dataset.mode = buildFrom;
  session?.setRendering(false); session?.resize();
  render(); requestAnimationFrame(fitGraph);
}
/** A Build playtest in the studio's own game viewport, HUD and pause card; its end hands the view back to the editor. */
function buildPlaytest({ from, onEnd }) {
  if (!session?.game) return;
  buildEnd = onEnd; expanded = true; lastOverlay = '';
  session.setEditView(null);
  if (from) session.playFrom(from); else { session.resetLevel(); session.start(); }
  $('#overlay-exit').textContent = 'Back to editor';
  playControls(session.genre);
  for (const id of ['#result-home', '#result-share']) $(id).hidden = true;
  $('#game-hud').hidden = false; $('#play-overlay').hidden = true;
  session.audio?.setMuted(gameMuted); session.audio?.resume();
  session.setRendering(true); session.resize(); session.canvas.focus();
}
/** The node graph on a Build level: Remix edits the level through the level editor's store, and comes back. */
function openGraph() {
  const store = buildMode.store;
  exitBuild(); document.body.dataset.mode = 'remix';
  linkedFrom = project;
  graphLink = { store, patch: (patch, label) => store.patch(patch, label), project: () => resolveProject(levelProjectOf(store)) };
  project = graphLink.project(); node = 'generator'; board.selected = null;
  render(); requestAnimationFrame(fitGraph);
  toast(`Editing the mission graph of ${store.level.name}. Back to level editor returns to it.`);
}
function levelProjectOf(store) { const { levels, ...shared } = store.game; return { ...shared, ...levels[store.state.levelIndex] }; }
function leaveGraph() { graphLink = null; project = linkedFrom ?? project; linkedFrom = null; render(); }
$('#back-to-build').addEventListener('click', () => { leaveGraph(); enterBuild(); });
// Remix's mission, as a new game in the level editor.
$('#open-build').addEventListener('click', async () => {
  if (workspace === 'remix') { toEditor({ type: 'visigence:workspace', to: 'build', mission: project }); return; }
  const { resolveGame } = await import('../src/world/shooterProject.js');
  const game = resolveGame(project), label = genreOf(game).label;
  // a ready-made mission is named by its genre; kept as a game it is someone's own, as a template's copy is
  enterBuild(game.name === label ? { ...game, name: `My ${label.toLowerCase()} game` } : game);
});
/** The whole game, playable: its levels, art and runtime in one ZIP, with the portal hooks (editor/exportGame.js). */
async function downloadBuildZip(game, progress = () => {}) {
  const { exportGame } = await import('./exportGame.js');
  const blob = await exportGame(game, progress);
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url;
  a.download = (game.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'game') + '.zip';
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Playable game downloaded. Unzip it and serve the folder, or upload it to a web portal.');
}
/** The game as its editable file, to open in the studio again. */
function downloadBuildGame(game) {
  const blob = new Blob([JSON.stringify(packageProject(game), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url;
  a.download = (game.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'game') + '.visigames.json';
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Game file saved. Open it in the studio to keep building.');
}

async function downloadGame(button) {
  const snapshot = { ...project };button.disabled = true;
  try {
    if(!validateGraph())throw Error('Connect a valid blueprint before exporting.');
    const { exportGame } = await import('./exportGame.js');
    const blob = await exportGame(snapshot, (done,total) => button.textContent = `Packaging ${done} / ${total}…`);
    const url = URL.createObjectURL(blob), a = document.createElement('a');a.href = url;a.download = `${snapshot.theme}-shooter.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Playable build downloaded. Extract it and serve or deploy the folder.');
  } catch(error) { toast(error.message); }
  finally { button.disabled = false;button.textContent = 'Download playable game'; }
}

/**
 * Automation handle, debug builds only: the browser smoke harness (tools/test/e2e-genres.mjs)
 * drives the real launcher and reads the live session through it. Nothing in the studio
 * reads this; a production page never defines it.
 */
if (typeof location !== 'undefined' && typeof window !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1') {
  window.__studio = { get session() { return session; }, get project() { return project; }, get building() { return building; }, get completedBuild() { return completedBuild; }, get build() { return buildMode; }, change, queueBuild, openPlay, closePlay, enterBuild, exitBuild };
}
