import { GENRE_LEVELS } from '../src/world/genreContent.js';
import { assetURL } from '../src/config/assetDelivery.js';
import { openPlacement, openIdentity, preparePresentation, presentationURL } from './creatorTools.js';
import { MISSION_WORLDS, missionWorld, worldMission, bestTime, formatTime, recordTime, challengeURL } from '../src/world/missionCard.js';
import { escapeHtml as esc } from './BlueprintBoard.js';
import { parseProjectText } from '../src/world/projectSchema.js';
import { GENRES, genreOf } from '../src/genres/registry.js';
import { worldFromLocation } from '../src/world/worldLink.js';
function missionLighting(p){return p.lighting==='dawn'?'Sunny day':'Golden hour';}
const ICONS={cube:'<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5M3 7l9 5v10"/>',pin:'<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',note:'<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M9 12h7m-7 4h5"/>',badge:'<path d="M4 5h16v14H4Z"/><circle cx="9" cy="11" r="2"/><path d="M6 17c.8-2 5.2-2 6 0m2-7h4m-4 3h3"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
// Text on a creator's accent stays readable: dark ink on light accents, white on dark ones.
const ink=hex=>{const n=parseInt(hex.slice(1),16),[r,g,b]=[n>>16,n>>8&255,n&255].map(v=>(v/=255)<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b>.18?'#17100a':'#ffffff';};
const tool=(attr,name,title,hint)=>`<button class="maker-tool" ${attr}>${icon(name)}<span><strong>${title}</strong><small>${hint}</small></span></button>`;
// A world sprite cell is cut out once, so every frame can use true cover instead of stretching the sheet to its box.
// Returns the art URL, null while the cell is being cut (onReady fires once it is), or false if it cannot be cut.
const crops=new Map(),waiting=new Map();
export function worldArt(t,onReady){if(t.artSize==='cover')return assetURL(t.art);const key=`${t.art}|${t.crop}`;
  if(!crops.has(key)){crops.set(key,null);waiting.set(key,new Set());const img=new Image();img.crossOrigin='anonymous';img.src=assetURL(t.art);
    img.decode().then(()=>{const [x,y,w,h]=t.crop,c=document.createElement('canvas');c.width=Math.round(w*img.naturalWidth);c.height=Math.round(h*img.naturalHeight);c.getContext('2d').drawImage(img,x*img.naturalWidth,y*img.naturalHeight,c.width,c.height,0,0,c.width,c.height);return new Promise(r=>c.toBlob(r,'image/jpeg',.92));})
      .then(blob=>{if(!blob)throw Error('crop');crops.set(key,URL.createObjectURL(blob));}).catch(()=>crops.set(key,false)).then(()=>{const ready=waiting.get(key);waiting.delete(key);ready.forEach(f=>f());});}
  if(crops.get(key)===null&&onReady)waiting.get(key)?.add(onReady);
  return crops.get(key);}
export function mountPlayerFront({ getProject, change, play, remix, build, toast, download, onMode = null }) {
  const root=document.querySelector('#player-front');if(!root)return null;
  let seed=getProject().seed,busy=false,currentTheme=missionWorld(getProject()),genre=genreOf(getProject()).id;
  // A world handed over by World mode ("Play here", src/world/worldLink.js): its seed and its params. Missions then
  // stand on that world (world/kernelGround.js worldParamsFor), not on the plain world of its seed.
  const linked=worldFromLocation(location);let carried=linked.world;if(carried)seed=carried.seed;
  if(linked.error)queueMicrotask(()=>toast(`The world in this link could not be used: ${linked.error}. Playing on the seed's own world.`));
  const params=new URLSearchParams(location.search);let challenge=getProject().blueprint.nodes.length?getProject():null;const targetTime=Number(params.get('beat'));const challengeTime=Number.isFinite(targetTime)&&targetTime>0?targetTime:null;
  if(document.body.dataset.build!=='standalone'&&params.has('mission'))try{challenge=parseProjectText(decodeURIComponent(escape(atob(params.get('mission'))))).project;if(challenge.importedProps?.length)throw Error('Custom props need the game download.');change(challenge);seed=getProject().seed;currentTheme=missionWorld(getProject());challenge=getProject();genre=genreOf(challenge).id;}catch{toast('This mission link is invalid. Choose a world to start a new run.');challenge=null;}
  // A link from the landing hub picks the genre and world the launcher opens on (?genre=arena&world=snow).
  if(!params.has('mission')){if(GENRES[params.get('genre')])genre=params.get('genre');if(MISSION_WORLDS[params.get('world')])currentTheme=params.get('world');}
  root.innerHTML=`<header class="front-nav"><a class="front-brand" href="/" aria-label="Visigence Engine home"><img src="${assetURL('/assets/studio/visigames-mark.svg')}" alt="" width="34" height="36"><span>VISIGENCE<small>ENGINE</small></span></a><nav aria-label="Studio mode"><button data-mode="world">World</button><button class="mode-active" data-mode="play" aria-current="page">Play</button><button data-mode="remix">Remix <small>ADVANCED</small></button><button data-mode="build">Build <small>LEVELS</small></button></nav><button class="front-import" data-import-prop aria-label="My assets"><img src="${assetURL('/assets/studio/asset-cube.svg')}" alt="" width="18" height="18"><span>My assets</span></button></header>
  <main class="front-main"><section class="launcher-heading"><h1>Mission select</h1><div class="genre-switch" id="mission-genre" role="radiogroup" aria-label="Genre"><span aria-hidden="true">GENRE</span>${Object.values(GENRES).map(g=>`<button role="radio" aria-checked="false" data-genre="${g.id}">${esc(g.label)}</button>`).join('')}</div></section>
  <div class="front-alert" role="alert" hidden><div><strong>This mission couldn't be prepared.</strong><p>A game file or engine step failed. Try again; if it keeps happening, share the details below.</p><pre id="front-alert-detail"></pre></div><button data-retry>Try again</button><button data-dismiss-alert>Dismiss</button></div>
  <section class="featured-mission" aria-label="Selected mission"></section>
  <section class="world-library" aria-label="World catalog"><div class="deck-heading"><h2>Worlds <span class="world-count"></span></h2><span>Choose where the mission takes place</span></div><div class="mission-deck" role="radiogroup" aria-label="World"></div></section>
  <section class="mission-settings" aria-label="Mission settings"><div class="seed-panel"><label for="mission-seed">MISSION SEED</label><div><input id="mission-seed" aria-label="Mission seed" maxlength="24" spellcheck="false" value="${esc(seed)}"></div></div><p>A seed recreates the same mission. Share it to challenge another player.</p><div class="carried-world" hidden><span>ON A WORLD FROM WORLD MODE</span><strong></strong><button data-drop-world aria-label="Play on the seed's own world instead">Use the seed's own world</button></div></section>
  <section class="maker-strip" aria-labelledby="maker-title"><div class="maker-heading"><div><h2 id="maker-title">Creator tools</h2><p>Add your own props and branding. They travel with your game download.</p></div></div><div class="maker-actions">${tool('data-import-prop','cube','Import prop','GLB · size and collision')}${tool('data-place-props','pin','Place props','<span id="place-hint">Import a prop first</span>')}${tool('data-identity','badge','Mission identity','<span id="identity-hint">Studio name, accent, artwork</span>')}</div><div id="imported-prop-list"></div></section>
  <footer class="front-footer"><span>VISIGENCE <i>/</i> ENGINE</span><span>World concept artwork <i>·</i> Playable layouts vary by seed</span></footer></main>
  <div class="front-build" hidden role="status" aria-live="polite"><div class="build-art"></div><div><span class="eyebrow">VISIGAMES</span><h2 tabindex="-1">Preparing mission</h2><p id="front-build-status">Loading environment…</p><span class="build-progress"></span></div></div>`;
  const $=s=>root.querySelector(s);
  // A ready-made mission is named by its genre, as the level editor's templates are; drafts saved under an older stock
  // name (a world's, an authored route's, the first releases') read the same. A mission someone named keeps its name.
  const STOCK=new Set(['Afterlight','First light','Dead signal','Untitled Shooter Project','Arcade','The Silent Survey','The Trail Warden','Honey Siege','Honey Harvest',...Object.values(MISSION_WORLDS).map(w=>w.title)]);
  const titleOf=p=>!p.name||STOCK.has(p.name)?genreOf(p).label:p.name;
  function mission(theme){const p={...(challenge&&missionWorld(challenge)===theme&&genreOf(challenge).id===genre?challenge:worldMission(theme,seed,genre)),importedProps:getProject().importedProps,presentation:getProject().presentation};p.name=titleOf(p);
    if(carried&&p.seed===carried.seed)p.worldParams=carried.worldParams;return p;}
  function visual(p){const t={...MISSION_WORLDS[missionWorld(p)]},art=presentationURL(p.presentation?.artwork);if(art)Object.assign(t,{art,artSize:'cover',position:'50%',crop:[0,0,1,1]});return t;}
  function artStyle(t){const art=worldArt(t,render);return `--mission-accent:${t.accent};${art?`--world-art:url('${art}');--art-size:cover;--art-position:${t.focus??'50% 50%'}`:art===null?'--world-art:none':`--world-art:url('${assetURL(t.art)}');--art-size:${t.artSize};--art-position:center ${t.position}`}`;}
  function card(p,{result=false,time}={}){const t=visual(p),best=bestTime(p),target=challenge&&missionWorld(challenge)===missionWorld(p)?challengeTime:null,light=missionLighting(p);
    const title = titleOf(p);
    const eyebrow=`<span${result?'':' id="launcher-genre-line"'}>${genreOf(p).platformLine}</span> <i>·</i> ${t.title.toUpperCase()} <i>·</i> ${light.toUpperCase()}`;
    const accent=/^#[0-9a-f]{6}$/i.test(p.presentation?.accent??'')?p.presentation.accent:'#ec9a52';
    return `<article class="mission-card ${result?'result-card':'featured-card'}" data-world="${missionWorld(p)}" style="${artStyle(t)};--creator-accent:${accent};--creator-ink:${ink(accent)}"><div class="mission-art" aria-hidden="true"></div><div class="mission-card-content">${p.presentation?.studioName||p.presentation?.logo?`<div class="mission-studio">${presentationURL(p.presentation?.logo)?`<img src="${presentationURL(p.presentation.logo)}" alt="Studio logo">`:""}<span>${esc(p.presentation?.studioName??"")}</span></div>`:""}<div class="mission-title"><p>${eyebrow}</p><h${result?'3':'2'}>${esc(title)}</h${result?'3':'2'}><span>${esc(GENRE_LEVELS[p.missionProfile]?.description??t.description)}</span></div><div class="mission-card-body"><div class="mission-meta"><div><span>SEED</span><strong>${esc(p.seed)}</strong></div><div><span>${time!==undefined?'THIS RUN':target!==null?'TIME TO BEAT':'PERSONAL BEST'}</span><strong>${formatTime(time??target??best)}</strong></div>${result?'':`<div><span>LENGTH</span><strong>~2 MIN</strong></div><div><span>DIFFICULTY</span><strong>${esc(p.difficulty.toUpperCase())}</strong></div>`}</div>${result?'':`<div class="mission-actions"><button class="mission-play" data-play-world="${missionWorld(p)}" ${busy?'disabled':''}><svg viewBox="0 0 18 20" width="16" height="18" aria-hidden="true"><path fill="currentColor" d="M2 1v18l15-9Z"/></svg>${busy?'Preparing…':best!==null||target!==null?'Beat this':'Play now'}</button><button class="mission-remix" data-mode="remix">Remix mission</button></div>`}</div></div></article>`;
  }
  function showCarried(){const el=$('.carried-world'),on=!!carried&&carried.seed===seed;el.hidden=!on;if(on)el.querySelector('strong').textContent=`${carried.name??'Your world'} · ${carried.seed}`;}
  function render(){
    showCarried();
    for(const g of root.querySelectorAll('[data-genre]')){g.setAttribute('aria-checked',String(g.dataset.genre===genre));g.tabIndex=g.dataset.genre===genre?0:-1;}
    const active=document.activeElement,refocus=root.contains(active)&&(active.dataset.selectWorld?`[data-select-world="${active.dataset.selectWorld}"]`:active.dataset.playWorld?'.featured-mission [data-play-world]':active.classList.contains('mission-remix')?'.featured-mission .mission-remix':null);
    $('.featured-mission').innerHTML=card(mission(currentTheme));
    $('.world-count').textContent=String(Object.keys(MISSION_WORLDS).length).padStart(2,'0');
    $('.mission-deck').innerHTML=Object.entries(MISSION_WORLDS).map(([id,t])=>`<button class="world-tile" role="radio" data-select-world="${id}" aria-checked="${currentTheme===id}" tabindex="${currentTheme===id?0:-1}" style="${artStyle(t)}"><span class="world-tile-art" aria-hidden="true"></span><span class="world-tile-label"><strong>${t.title}</strong><small>${t.time}</small></span><span class="world-selection" aria-hidden="true">${currentTheme===id?'SELECTED':''}</span></button>`).join('');
    if(refocus)root.querySelector(refocus)?.focus({preventScroll:true});
    if(busy)$('.build-art').style.cssText=artStyle(visual(mission(currentTheme)));
    const imports=getProject().importedProps??[],studio=getProject().presentation?.studioName;$('#place-hint').textContent=imports.length?`${imports.length} imported prop${imports.length>1?'s':''} ready`:'Import a prop first';$('#identity-hint').textContent=studio?`Studio · ${studio}`:'Studio name, accent, artwork';$('#imported-prop-list').innerHTML=imports.map(p=>`<span class="import-chip">${esc(p.name)} <small>${p.collision==='box'?'solid':'decorative'}</small><button data-remove-prop="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></span>`).join('');
  }
  // World and genre changes apply at once and the new hero eases in; input is never held for the animation.
  function swap(update){update();$('.featured-card')?.classList.add('swap-in');}
  // Build opens the level editor on the mission in hand (editor/build/); it owns its own view.
  function nav(value){for(const b of root.querySelectorAll('.front-nav [data-mode]')){const on=b.dataset.mode===value;b.classList.toggle('mode-active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}}
  /* World is the world engine's own page (world.html). Opened from World ("Play here"), this page returns to that tab,
     where the world is still being edited: the editor stores nothing, so a new page would not have it. Otherwise it
     opens World on this seed. */
  function openWorld(){if(carried&&window.opener&&!window.opener.closed){try{window.opener.focus();return;}catch{}}location.href=`/world.html?seed=${encodeURIComponent(seed)}`;}
  function mode(value){if(value==='world'){openWorld();return;}const prev=document.body.dataset.mode;
    if(value==='build'){if(prev==='world'){document.body.dataset.mode='play';nav('play');onMode?.('play','world');}change(mission(currentTheme));build();return;}
    document.body.dataset.mode=value;nav(value);document.querySelector('#remix-return').hidden=value==='play'||value==='world';if(value==='remix'){change(mission(currentTheme));remix();}if(prev!==value)onMode?.(value,prev);window.scrollTo(0,0);}
  root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.mode&&b.dataset.mode!==document.body.dataset.mode)mode(b.dataset.mode);
    if(b.dataset.genre&&b.dataset.genre!==genre){genre=b.dataset.genre;challenge=null;swap(render);}
    // Placing needs a prop: with none imported, import one first and continue straight into placement.
    if(b.hasAttribute('data-place-props')&&!getProject().importedProps?.length){if(!getProject().blueprint.nodes.length)change(worldMission(currentTheme,seed));try{const {openAssetImport}=await import('./assetImport.js');await openAssetImport({getProject,toast,notice:'Import a prop first. Placement opens as soon as it is added.',onChange:patch=>{change(patch);render();setTimeout(()=>{change(mission(currentTheme));openPlacement({getProject,onChange:p=>{change(p);challenge=getProject();render();},toast}).catch(err=>toast(err.message));});}});}catch(err){toast(err.message);}return;}
    if(b.hasAttribute('data-place-props')||b.hasAttribute('data-identity')){change(mission(currentTheme));try{await (b.hasAttribute('data-place-props')?openPlacement:openIdentity)({getProject,onChange:patch=>{change(patch);challenge=getProject();render();},toast});}catch(err){toast(err.message);}}
    if(b.dataset.selectWorld&&b.dataset.selectWorld!==currentTheme){currentTheme=b.dataset.selectWorld;swap(render);root.querySelector(`[data-select-world="${currentTheme}"]`).focus({preventScroll:true});}
    if(b.hasAttribute('data-import-prop')){if(!getProject().blueprint.nodes.length)change(worldMission(currentTheme,seed));try{const {openAssetImport}=await import('./assetImport.js');await openAssetImport({getProject,onChange:patch=>{change(patch);render();},toast});}catch(e){toast(e.message);}}
    if(b.hasAttribute('data-dismiss-alert')){$('.front-alert').hidden=true;$('.featured-mission .mission-play')?.focus({preventScroll:true});}
    if(b.hasAttribute('data-retry'))$('.featured-mission [data-play-world]')?.click();
    if(b.hasAttribute('data-drop-world')){carried=null;history.replaceState(null,'',location.pathname+location.search);challenge=null;render();}
    if(b.dataset.removeProp){change({importedProps:getProject().importedProps.filter(p=>p.id!==b.dataset.removeProp)});render();}
    if(b.dataset.playWorld&&!busy){currentTheme=b.dataset.playWorld;const p=mission(currentTheme);change({...p,importedProps:getProject().importedProps});await play();}
  });
  $('.mission-deck').addEventListener('keydown',e=>{const step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];if(!step)return;e.preventDefault();const ids=Object.keys(MISSION_WORLDS);currentTheme=ids[(ids.indexOf(currentTheme)+step+ids.length)%ids.length];swap(render);root.querySelector(`[data-select-world="${currentTheme}"]`).focus({preventScroll:true});});
  $('#mission-genre').addEventListener('keydown',e=>{const step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];if(!step)return;e.preventDefault();const ids=Object.keys(GENRES);genre=ids[(ids.indexOf(genre)+step+ids.length)%ids.length];challenge=null;render();root.querySelector(`[data-genre="${genre}"]`).focus();});
  $('#mission-seed').addEventListener('input',()=>{seed=worldMission(currentTheme,$('#mission-seed').value).seed;challenge=null;render();});
  $('#mission-seed').addEventListener('change',()=>{try{seed=worldMission(currentTheme,$('#mission-seed').value).seed;challenge=null;$('#mission-seed').value=seed;render();}catch(e){toast(e.message);}});
  document.querySelector('#remix-return').addEventListener('click',()=>{currentTheme=missionWorld(getProject());challenge=getProject();seed=getProject().seed;$('#mission-seed').value=seed;render();mode('play');});
  // Intent to play fetches the engine's code early; no renderer or art loads until Play is pressed.
  let warm=()=>{warm=null;import('../src/game/ShooterSession.js').catch(()=>{});};for(const type of ['pointerover','focusin'])root.addEventListener(type,e=>{if(warm&&e.target.closest?.('.mission-play'))warm();});
  document.querySelector('#result-home').hidden=document.body.dataset.build==='standalone';
  document.querySelector('#result-share').hidden=document.body.dataset.build==='standalone';
  document.querySelector('#result-home').addEventListener('click',()=>{document.querySelector('#close-preview').click();mode('play');render();});
  document.querySelector('#result-share').addEventListener('click',()=>share(getProject()));
  document.querySelector('#result-image').addEventListener('click',()=>saveCard(getProject()));
  document.querySelector('#front-export').addEventListener('click',e=>download(e.currentTarget));
  async function share(p){try{
    const url=challengeURL(p,location.href,bestTime(p));
    if(navigator.share)await navigator.share({title:`${MISSION_WORLDS[missionWorld(p)].title} · ${p.seed}`,text:`Beat my run: ${formatTime(bestTime(p))}`,url});
    else {await navigator.clipboard.writeText(url);toast('Mission link copied. Ready to share.');}
  }catch(e){if(e.name!=='AbortError')toast(e.message);}}
  async function saveCard(p){try{
    const t=visual(p),img=new Image(),mark=new Image();img.crossOrigin='anonymous';mark.crossOrigin='anonymous';img.src=assetURL(t.art);mark.src=presentationURL(p.presentation?.logo)||assetURL('/assets/studio/visigames-mark.svg');await Promise.all([img.decode(),mark.decode()]);
    const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=630;const c=canvas.getContext('2d');
    c.fillStyle='#101113';c.fillRect(0,0,1200,630);const [x,y,w,h]=t.crop;const sw=w*img.width,sh=h*img.height,ratio=1200/630,cw=Math.min(sw,sh*ratio),ch=Math.min(sh,sw/ratio);c.drawImage(img,x*img.width+(sw-cw)/2,y*img.height+(sh-ch)/2,cw,ch,0,0,1200,630);
    const shade=c.createLinearGradient(0,0,1200,0);shade.addColorStop(0,'#080b10f5');shade.addColorStop(.65,'#080b1080');shade.addColorStop(1,'#080b1020');c.fillStyle=shade;c.fillRect(0,0,1200,630);
    const mw=Math.min(p.presentation?.logo?112:32,36*mark.width/mark.height),mh=mw*mark.height/mark.width;c.drawImage(mark,48,38,mw,mh);c.fillStyle='#f2f2ef';c.font='900 24px Arial';c.fillText((p.presentation?.studioName||'VISIGAMES').slice(0,32).toUpperCase(),p.presentation?.logo?180:92,58);c.font='9px Arial';c.fillStyle='#b1b7bf';c.fillText(p.presentation?.studioName?'MADE WITH VISIGAMES':'BY VISIGENCE',p.presentation?.logo?181:93,75);
    c.fillStyle=t.accent;c.font='bold 13px Arial';c.fillText(`${t.title.toUpperCase()}  /  ${missionLighting(p).toUpperCase()}  /  SOLO`,50,235);
    const title=(p.name||t.title).toUpperCase();let size=76;c.font=`900 ${size}px Arial`;while(c.measureText(title).width>1070&&size>24)c.font=`900 ${--size}px Arial`;c.fillStyle='#f2f2ef';c.fillText(title,48,325);
    c.fillStyle='#a8b0ba';c.font='11px Arial';c.fillText('MISSION SEED',50,381);c.fillText('PERSONAL BEST',350,381);c.font='22px monospace';c.fillStyle='#fff';c.fillText(p.seed,50,414);c.fillText(formatTime(bestTime(p)),350,414);
    c.fillStyle=p.presentation?.accent??'#ec9a52';c.fillRect(50,458,205,54);c.fillStyle='#21170e';c.font='bold 16px Arial';c.fillText('BEAT THIS',104,491);
    c.fillStyle='#b4bbc4';c.font='10px Arial';c.fillText('WORLD CONCEPT ART  /  PLAYABLE LAYOUT GENERATED FROM SEED',50,593);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));if(!blob)throw Error('Mission card could not be saved.');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`visigames-${missionWorld(p)}-${p.seed}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Mission card saved.');
  }catch(e){toast(e.message);}}
  render();preparePresentation(getProject()).then(render).catch(e=>toast(e.message));document.body.dataset.mode='play';
  // Asset counts drive a real progress bar; other phases show an indeterminate sweep.
  function status(text){$('#front-build-status').textContent=text;const m=/(\d+)\s*\/\s*(\d+)/.exec(text),bar=$('.build-progress'),done=/^Ready/.test(text);bar.classList.toggle('indeterminate',!m&&!done);if(m||done)bar.style.setProperty('--progress',done?1:Math.min(.9,.9*(m[1]-1)/m[2]));}
  return {render,status,mode,
    building(value){busy=value;$('.front-build').hidden=!value;$('.front-main').inert=value;$('.front-nav').inert=value;if(value){$('.front-alert').hidden=true;$('.front-build .eyebrow').textContent=`Preparing mission · ${MISSION_WORLDS[currentTheme].title}`.toUpperCase();$('.front-build h2').textContent=mission(currentTheme).name;$('.build-art').style.cssText=artStyle(visual(mission(currentTheme)));status('Loading environment…');$('.front-build h2').focus({preventScroll:true});}render();},
    failed(detail){status(detail);$('#front-alert-detail').textContent=detail;$('.front-alert').hidden=false;$('.front-alert').scrollIntoView({block:'nearest'});$('[data-retry]').focus({preventScroll:true});},result(p,stats){const result=['VICTORY','PLAYER_DEAD'].includes(stats.state),won=stats.state==='VICTORY',overlay=document.querySelector('#play-overlay');document.querySelector('#mission-result').hidden=!result;document.querySelector('#result-actions').hidden=!result;if(overlay)overlay.dataset.outcome=result?(won?'victory':'failed'):'';if(!result)return;
      // A failed run has no time to show; a win that beats the stored best says so.
      const prev=bestTime(p);if(won)recordTime(p,stats.time);document.querySelector('#mission-result').innerHTML=(won&&(prev===null||stats.time<prev)?'<span class="result-record">NEW PERSONAL BEST</span>':'')+card(p,{result:true,time:won?stats.time:undefined});render();}};
}
