/**
 * The game shell: `createGame(container, project, options)` turns a project into a running
 * game — the same code in the editor's playtest, the gallery previews and an exported HTML file.
 *
 *   mode 'standalone'  title screen, levels in order, lives, stars, saved progress, ending
 *   mode 'playtest'    straight into one level (optionally from a cell), infinite lives, a slim
 *                      bar with Restart and Stop; `onExit(result)` hands the trace to the editor
 *   mode 'preview'     no input, no sound, no HUD: critters roam while the camera drifts
 *
 * The loop is a fixed 60 Hz step with an accumulator (at most five steps a frame) and a render
 * every animation frame at the device's pixel ratio (capped at 2). The scene draws in device
 * pixels; the HUD draws in CSS pixels on top.
 *
 * Monetisation hooks (`options.hooks`, in an exported game `window.VisigameHooks`):
 *   adBreak('between-levels' | 'rewarded') -> Promise<boolean>   awaited before the next level
 *                                                              (when project.publish.adBreaks) and to
 *                                                              grant a continue (publish.rewardedContinue)
 *   event(name, data)   gameplayStart, gameplayStop, levelStart, levelComplete, gameOver, gameComplete
 */
import { createSim, STEP, starsFor } from './sims/index.js';
import { drawScene, fitCamera, followCamera } from './render.js';
import { createArt } from '../art/index.js';
import { createInput, withoutPresses, controlsText } from './input.js';
import { createAudio } from './audio.js';
import { createFx } from './fx.js';
import { drawHud } from './hud.js';
import { createUI, buildTouch, svg, esc } from './ui.js';
import { genreById } from '../core/catalog.js';
import { objectiveText } from '../core/format.js';

const MAX_STEPS = 5;

export function createGame(container, project, options = {}) {
  const mode = options.mode || 'standalone';
  const preview = mode === 'preview', playtest = mode === 'playtest';
  const genre = project.genre;
  const G = genreById(genre);
  const mm = q => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
  const reduced = options.reducedMotion ?? mm('(prefers-reduced-motion: reduce)');
  const touch = !preview && (options.touch ?? mm('(pointer: coarse)'));
  const hooks = { adBreak: () => Promise.resolve(false), event: () => {}, ...(options.hooks || {}) };
  const art = options.art || createArt();
  const ui = createUI(container, { accent: project.accent });
  const canvas = ui.canvas;
  const ctx = canvas.getContext('2d');
  const audio = preview ? null : createAudio({ muted: !!(options.muted ?? globalThis.visigameHost?.muted), music: project.settings.music, sound: project.settings.sound, biome: project.levels[0].biome });
  const fx = createFx({ reduced });
  const input = preview ? null : createInput(canvas, { genre, onPause: () => (playtest ? stop('quit') : togglePause()), active: () => !ui.menuOpen });
  let destroyTouch = null;

  let W = 1, H = 1, dpr = 1;
  let levelIndex = Math.max(0, Math.min(project.levels.length - 1, options.levelIndex ?? 0));
  let sim = null;
  let cam = { x: 0, y: 0, size: 32 };
  let phase = 'idle';
  let lives = project.settings.lives || 0;          // 0 = infinite
  let totalScore = 0;
  let acc = 0, last = 0, raf = 0, destroyed = false, hidden = false, onscreen = true;
  let timer = 0, attempt = 0, drift = 0;
  let lastResult = null;
  const progress = loadProgress();

  // ------------------------------------------------------------------ sizing
  function resize() {
    const r = container.getBoundingClientRect();
    dpr = preview ? 1 : Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    W = w; H = h;
    if (sim) camera(0, true);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  const io = preview && typeof IntersectionObserver === 'function' ? new IntersectionObserver(es => { onscreen = es.some(e => e.isIntersecting); }) : null;
  io?.observe(container);
  const onVis = () => { hidden = document.hidden; if (hidden) { if (phase === 'play' && !preview && !playtest) togglePause(true); audio?.suspend(); } else audio?.resume(); };
  document.addEventListener('visibilitychange', onVis);
  const unlock = () => { audio?.unlock(); };
  if (!preview) { container.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock); }

  // ------------------------------------------------------------------ camera
  function followSize() {
    const d = dpr;
    const css = sim.view === 'side' ? Math.min(H / d / 14.5, W / d / 12) : Math.min(H / d / 12.5, W / d / 11);
    return Math.round(Math.max(22, Math.min(72, css)) * d);
  }
  function camera(dt, snap = false) {
    if (preview) {
      const size = Math.max(10, Math.round(Math.min(H / Math.min(sim.H, sim.view === 'side' ? 16 : 14), W / 12)));
      const vw = W / size, vh = H / size;
      drift += dt * 0.05;
      const span = Math.max(0, sim.W - vw), spanY = Math.max(0, sim.H - vh);
      const k = (1 - Math.cos(drift * Math.PI)) / 2;
      cam = { x: span > 0 ? span * k : sim.W / 2 - vw / 2, y: sim.view === 'side' ? Math.max(0, sim.H - vh) - (spanY > 0 ? spanY * 0.25 * (1 - k) : 0) : (spanY > 0 ? spanY * (0.5 - 0.5 * Math.cos(drift * Math.PI * 0.7)) : sim.H / 2 - vh / 2), size };
      return;
    }
    if (sim.cameraHint === 'fit') {
      const c = fitCamera(sim, W, H, { margin: 0.6, max: Math.round(80 * dpr), min: 4 });
      if (!(genre === 'arena' && c.size < 24 * dpr)) { cam = c; if (touch && W < H) cam.y += (H * 0.1) / c.size; return; }
    }
    cam.size = followSize();
    const p = sim.player;
    followCamera(cam, sim, W, H, dt, { snap, lookX: sim.view === 'side' ? (p.facing || 1) * 1.6 : 0, lookY: touch && sim.view === 'top' ? 1.2 : 0 });
  }

  // ------------------------------------------------------------------ levels
  function startLevel(i, opts = {}) {
    levelIndex = i;
    attempt = opts.keepAttempt ? attempt : 0;
    sim = createSim(project, i, { spawn: opts.spawn || null, attempt });
    fx.clear();
    audio?.setBiome(sim.level.biome);
    acc = 0;
    camera(0, true);
    if (preview) { phase = 'preview'; return; }
    phase = 'play';
    ui.hide();
    ui.corner(!playtest);
    ui.intro(sim.level.name, `Level ${i + 1} · ${objectiveText(sim.level)}`);
    ui.announce(`Level ${i + 1}, ${sim.level.name}. ${objectiveText(sim.level)}.`);
    if (playtest) ui.bar(barHtml());
    hooks.event('levelStart', { level: i, name: sim.level.name });
    hooks.event('gameplayStart', {});
    canvas.focus({ preventScroll: true });
  }
  function barHtml() {
    return `<span class="vgg-meta"><span class="vgg-tally">Playtest</span><i></i><span>Level ${levelIndex + 1}</span><i></i><span>${esc(sim.level.name)}</span></span>
      <button class="vgg-btn" type="button" data-act="mute" aria-label="Mute sound">${svg(audio?.muted ? 'mute' : 'sound')}</button>
      <button class="vgg-btn" type="button" data-act="restart">${svg('restart')}Restart</button>
      <button class="vgg-btn" type="button" data-act="stop">${svg('stop')}Stop <span class="vgg-muted" style="font:800 10px/1 Nunito,ui-rounded,sans-serif;letter-spacing:.06em">ESC</span></button>`;
  }

  function onEvents() {
    const events = sim.drainEvents();
    for (const e of events) {
      audio?.play(e.type, e);
      fx.handle(e);
      if (e.type === 'checkpoint') ui.announce('Lantern lit.');
      else if (e.type === 'key') ui.announce(`${e.color || 'A'} key.`);
      else if (e.type === 'wave') ui.announce(`Wave ${e.wave}.`);
    }
  }

  function stepFrame(dt) {
    if (phase === 'play' || phase === 'dying' || phase === 'winning' || phase === 'preview' || phase === 'title') {
      acc += dt;
      let n = 0;
      const p = sim.player;
      const playerScreen = { x: ((p.x + p.w / 2 - cam.x) * cam.size) / dpr, y: ((p.y + p.h / 2 - cam.y) * cam.size) / dpr };
      const live = phase === 'play' && input;
      const inp = live ? input.sample(playerScreen) : null;
      while (acc >= STEP && n < MAX_STEPS) {
        sim.step(live ? (n === 0 ? inp : withoutPresses(inp)) : EMPTY);
        acc -= STEP; n++;
      }
      if (acc > STEP * MAX_STEPS) acc = 0;
      if (phase === 'title' || phase === 'preview') sim.drainEvents(); else onEvents();
    }
    if (phase === 'play') {
      if (sim.status === 'won') { phase = 'winning'; timer = 1.1; ui.announce('Level clear.'); }
      else if (sim.status === 'dead' || sim.status === 'timeout') { phase = 'dying'; timer = sim.status === 'timeout' ? 1.4 : 1.0; ui.announce(sim.status === 'timeout' ? 'Out of time.' : 'Ouch.'); }
    } else if (phase === 'winning') {
      timer -= dt;
      if (timer <= 0) levelWon();
    } else if (phase === 'dying') {
      timer -= dt;
      if (timer <= 0) died();
    }
  }

  function died() {
    const timeout = sim.status === 'timeout';
    if (playtest || lives === 0) return retry(timeout);
    lives--;
    if (lives > 0) return retry(timeout);
    gameOver();
  }
  function retry(fresh) {
    if (fresh) { attempt++; startLevel(levelIndex, { keepAttempt: true }); return; }
    sim.respawn();
    phase = 'play';
    camera(0, true);
  }

  function levelWon() {
    const level = sim.level;
    const stars = starsFor(sim, level.rules.par || 0);
    const time = sim.time;
    const score = sim.score;
    totalScore += score;
    lastResult = { status: 'won', levelIndex, time, score, stars, trace: sim.trace, deaths: sim.deaths, moves: sim.moves };
    if (!playtest) {
      const rec = progress.levels[level.id] || {};
      progress.levels[level.id] = { stars: Math.max(rec.stars || 0, stars), time: rec.time ? Math.min(rec.time, time) : time, score: Math.max(rec.score || 0, score) };
      progress.unlocked = Math.max(progress.unlocked || 1, levelIndex + 2);
      saveProgress();
    }
    hooks.event('levelComplete', { level: levelIndex, stars, time, score });
    hooks.event('gameplayStop', {});
    phase = 'complete';
    const last = levelIndex >= project.levels.length - 1;
    const honey = sim.coinsTotal + sim.gemsTotal;
    const best = !playtest ? progress.levels[level.id] : null;
    const starRow = [0, 1, 2].map(i => svg('star', `class="${i < stars ? 'is-on' : ''}" style="animation-delay:${0.15 + i * 0.18}s"`)).join('');
    const measure = genre === 'puzzle' ? `<dt>Moves</dt><dd>${sim.moves}${level.rules.par ? ` / par ${level.rules.par}` : ''}</dd>` : `<dt>Time</dt><dd>${clock(time)}${level.rules.par ? ` / par ${clock(level.rules.par)}` : ''}</dd>`;
    ui.show(`
      <p class="vgg-meta vgg-meta--accent"><span>Level ${levelIndex + 1} of ${project.levels.length}</span><i></i><span>Clear</span></p>
      <h2 class="vgg-h2">${esc(level.name)}</h2>
      <div class="vgg-stars" role="img" aria-label="${stars} of 3 stars">${starRow}</div>
      <dl class="vgg-stats">${measure}${honey ? `<dt>Honey</dt><dd>${sim.coins + sim.gems} / ${honey}</dd>` : ''}<dt>Score</dt><dd>${String(score).padStart(5, '0')}</dd>${best && best.score > score ? `<dt>Best</dt><dd>${String(best.score).padStart(5, '0')}</dd>` : ''}</dl>
      <div class="vgg-actions">
        ${playtest ? `<button class="vgg-btn vgg-btn--primary" type="button" data-act="stop" data-autofocus>Back to the editor</button>` : last ? `<button class="vgg-btn vgg-btn--primary" type="button" data-act="finish" data-autofocus>Finish</button>` : `<button class="vgg-btn vgg-btn--primary" type="button" data-act="next" data-autofocus>${svg('play')}Next level</button>`}
        <button class="vgg-btn" type="button" data-act="replay">${svg('restart')}Play again</button>
        ${playtest && !last ? `<button class="vgg-btn vgg-btn--ghost" type="button" data-act="next">Play the next level</button>` : ''}
        ${!playtest ? `<button class="vgg-btn vgg-btn--ghost" type="button" data-act="title">Title screen</button>` : ''}
      </div>`, { label: 'Level clear' });
    stars && [0, 1, 2].slice(0, stars).forEach(i => setTimeout(() => audio?.play('star', { n: i }), 150 + i * 180));
  }

  function gameOver() {
    phase = 'over';
    hooks.event('gameOver', { level: levelIndex, score: totalScore + sim.score });
    hooks.event('gameplayStop', {});
    const rewarded = project.publish?.rewardedContinue;
    ui.show(`
      <p class="vgg-meta vgg-meta--accent"><span>Level ${levelIndex + 1}</span><i></i><span>${esc(sim.level.name)}</span></p>
      <h2 class="vgg-h2">Out of lives</h2>
      <p class="vgg-p">The level keeps what you collected. Try again from the start of it.</p>
      <div class="vgg-actions">
        ${rewarded ? `<button class="vgg-btn vgg-btn--primary" type="button" data-act="continue" data-autofocus>${svg('play')}Continue</button>` : ''}
        <button class="vgg-btn ${rewarded ? '' : 'vgg-btn--primary'}" type="button" data-act="retry" ${rewarded ? '' : 'data-autofocus'}>${svg('restart')}Retry the level</button>
        <button class="vgg-btn vgg-btn--ghost" type="button" data-act="title">Title screen</button>
      </div>`, { label: 'Game over' });
    ui.announce('Out of lives.');
  }

  function ending() {
    phase = 'ending';
    const total = project.levels.reduce((s, l) => s + (progress.levels[l.id]?.stars || 0), 0);
    hooks.event('gameComplete', { score: totalScore, stars: total });
    ui.show(`
      <p class="vgg-meta vgg-meta--accent"><span>${esc(project.title)}</span><i></i><span>Complete</span></p>
      <h2 class="vgg-h2">You finished the game</h2>
      <dl class="vgg-stats"><dt>Score</dt><dd>${String(totalScore).padStart(6, '0')}</dd><dt>Stars</dt><dd>${total} / ${project.levels.length * 3}</dd></dl>
      <div class="vgg-actions">
        <button class="vgg-btn vgg-btn--primary" type="button" data-act="levels" data-autofocus>Chase more stars</button>
        <button class="vgg-btn" type="button" data-act="newgame">${svg('restart')}Play again</button>
        <button class="vgg-btn vgg-btn--ghost" type="button" data-act="title">Title screen</button>
      </div>
      ${project.publish?.showCredits !== false ? '<p class="vgg-credit">Made with Visigame</p>' : ''}`, { label: 'Game complete' });
  }

  function showTitle() {
    phase = 'title';
    lives = project.settings.lives || 0;
    ui.corner(false);
    if (!sim || sim.levelIndex !== 0) { sim = createSim(project, 0, {}); camera(0, true); }
    const unlocked = Math.min(project.levels.length, progress.unlocked || 1);
    const cont = unlocked > 1;
    const meta = [G?.name, `${project.levels.length} level${project.levels.length === 1 ? '' : 's'}`, project.studio].filter(Boolean).map(s => `<span>${esc(s)}</span>`).join('<i></i>');
    ui.show(`
      <p class="vgg-meta vgg-meta--accent">${meta}</p>
      <h1 class="vgg-h1">${esc(project.title)}</h1>
      ${project.description ? `<p class="vgg-p">${esc(project.description)}</p>` : ''}
      <div class="vgg-actions">
        <button class="vgg-btn vgg-btn--primary" type="button" data-act="${cont ? 'continue-game' : 'newgame'}" data-autofocus>${svg('play')}${cont ? `Continue · level ${unlocked}` : 'Play'}</button>
        ${cont ? `<button class="vgg-btn" type="button" data-act="newgame">Start from level 1</button>` : ''}
        ${project.levels.length > 1 ? `<button class="vgg-btn" type="button" data-act="levels">Levels</button>` : ''}
        <button class="vgg-btn vgg-btn--ghost" type="button" data-act="mute">${audio?.muted ? 'Sound off' : 'Sound on'}</button>
      </div>
      <p class="vgg-hint">${esc(controlsText(genre, touch))}</p>
      ${project.publish?.showCredits !== false ? '<p class="vgg-credit">Made with Visigame</p>' : ''}`, { label: project.title });
  }

  function showLevels() {
    phase = 'menu';
    const unlocked = Math.min(project.levels.length, progress.unlocked || 1);
    const cells = project.levels.map((l, i) => {
      const rec = progress.levels[l.id];
      const stars = rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : '☆☆☆';
      return `<button class="vgg-level" type="button" data-act="pick" data-arg="${i}" ${i >= unlocked ? 'disabled' : ''}><small>Level ${i + 1}</small>${esc(l.name)}<span class="vgg-mini" aria-label="${rec?.stars || 0} stars">${stars}</span></button>`;
    }).join('');
    ui.show(`
      <p class="vgg-meta vgg-meta--accent"><span>${esc(project.title)}</span><i></i><span>Levels</span></p>
      <div class="vgg-levels">${cells}</div>
      <div class="vgg-row"><button class="vgg-btn vgg-btn--ghost" type="button" data-act="title">Back</button></div>`, { wide: true, label: 'Levels' });
  }

  function togglePause(force) {
    if (phase === 'play' || force === true && phase === 'play') {
      phase = 'paused';
      hooks.event('gameplayStop', {});
      audio?.play('uiBack');
      ui.show(`
        <p class="vgg-meta vgg-meta--accent"><span>Paused</span><i></i><span>Level ${levelIndex + 1}</span></p>
        <h2 class="vgg-h2">${esc(sim.level.name)}</h2>
        <p class="vgg-hint">${esc(controlsText(genre, touch))}</p>
        <div class="vgg-actions">
          <button class="vgg-btn vgg-btn--primary" type="button" data-act="resume" data-autofocus>${svg('play')}Resume</button>
          <button class="vgg-btn" type="button" data-act="restart">${svg('restart')}Restart the level</button>
          <button class="vgg-btn" type="button" data-act="mute">${audio?.muted ? 'Sound off' : 'Sound on'}</button>
          <button class="vgg-btn vgg-btn--ghost" type="button" data-act="title">Title screen</button>
        </div>`, { label: 'Paused' });
    } else if (phase === 'paused') resume();
  }
  function resume() { if (phase !== 'paused') return; ui.hide(); phase = 'play'; last = 0; hooks.event('gameplayStart', {}); canvas.focus({ preventScroll: true }); }

  function stop(status = 'quit') {
    if (!playtest) return;
    const r = lastResult && status !== 'quit' ? lastResult : { status: sim?.status === 'play' ? 'quit' : (sim?.status || 'quit'), levelIndex, time: sim?.time || 0, score: sim?.score || 0, stars: 0, trace: sim?.trace || [], deaths: sim?.deaths || [], moves: sim?.moves };
    if (status === 'quit' && lastResult) Object.assign(r, lastResult);
    options.onExit?.(r);
  }

  ui.on({
    play: () => startLevel(0),
    newgame: () => { totalScore = 0; lives = project.settings.lives || 0; startLevel(0); },
    'continue-game': () => { lives = project.settings.lives || 0; startLevel(Math.min(project.levels.length, progress.unlocked || 1) - 1); },
    levels: () => showLevels(),
    pick: arg => { lives = project.settings.lives || 0; startLevel(+arg); },
    title: () => { ui.hide(); showTitle(); },
    resume: () => resume(),
    pause: () => togglePause(),
    restart: () => { lastResult = null; attempt++; startLevel(levelIndex, { keepAttempt: true, spawn: playtest ? options.spawn : null }); },
    replay: () => { lastResult = null; startLevel(levelIndex, { spawn: playtest ? options.spawn : null }); },
    retry: () => { lives = project.settings.lives || 0; attempt++; startLevel(levelIndex, { keepAttempt: true }); },
    next: async () => {
      if (levelIndex >= project.levels.length - 1) return ending();
      if (!playtest && project.publish?.adBreaks) { ui.hide(); phase = 'ad'; audio?.suspend(); try { await hooks.adBreak('between-levels'); } catch { /* the ad failed; play on */ } audio?.resume(); }
      lastResult = null;
      startLevel(levelIndex + 1);
    },
    finish: () => ending(),
    continue: async () => {
      ui.hide(); phase = 'ad'; audio?.suspend();
      let granted = false;
      try { granted = await hooks.adBreak('rewarded'); } catch { granted = false; }
      audio?.resume();
      if (granted) { lives = project.settings.lives || 3; sim.respawn(); phase = 'play'; } else gameOver();
    },
    stop: () => stop(lastResult ? 'won' : 'quit'),
    mute: () => { const m = !audio?.muted; audio?.setMuted(m); ui.setMuteIcon(m); if (phase === 'paused') { phase = 'play'; togglePause(); } else if (phase === 'title') showTitle(); else if (playtest) ui.bar(barHtml()); },
  });

  // ------------------------------------------------------------------ the loop
  function frame(now) {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (hidden || (preview && !onscreen)) { last = now; return; }
    if (preview && last && now - last < 30) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : STEP;
    last = now;
    if (!sim) return;
    if (ui.menuOpen) pollMenuPad();
    stepFrame(dt);
    fx.update(dt);
    camera(dt);
    render();
  }
  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const shake = fx.shakeOffset(sim.time);
    const c = { x: cam.x + shake.x, y: cam.y + shake.y, size: cam.size };
    ctx.fillStyle = '#0c0e33';
    ctx.fillRect(0, 0, W, H);
    const dark = sim.level.time === 'night' && sim.level.rules.dark && !!sim.lights;
    drawScene(ctx, sim, c, art, { width: W, height: H, t: sim.time, fx: fx.draw, darkness: dark });
    if (!preview && phase !== 'title') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawHud(ctx, W / dpr, H / dpr, sim, { dpr, lives: playtest ? 0 : lives, score: totalScore, touch, rightInset: playtest ? 0 : 100, topInset: playtest ? 46 : 0 });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
  let padPrev = {};
  function pollMenuPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...(pads || [])].find(Boolean);
    if (!pad) return;
    const now = { up: pad.buttons[12]?.pressed || pad.axes[1] < -0.5, down: pad.buttons[13]?.pressed || pad.axes[1] > 0.5, a: pad.buttons[0]?.pressed, start: pad.buttons[9]?.pressed };
    if (now.up && !padPrev.up) ui.moveMenuFocus(-1);
    if (now.down && !padPrev.down) ui.moveMenuFocus(1);
    if (now.a && !padPrev.a) ui.focusedMenuButton()?.click();
    if (now.start && !padPrev.start && phase === 'paused') resume();
    padPrev = now;
  }

  // ------------------------------------------------------------------ progress
  function loadProgress() {
    const empty = { levels: {}, unlocked: 1 };
    if (playtest || preview) return empty;
    try { const v = JSON.parse(localStorage.getItem('visigame.play.' + project.id) || 'null'); return v && typeof v === 'object' && v.levels ? v : empty; } catch { return empty; }
  }
  function saveProgress() { try { localStorage.setItem('visigame.play.' + project.id, JSON.stringify(progress)); } catch { /* private mode: progress lasts the session */ } }

  // ------------------------------------------------------------------ start
  resize();
  if (touch && input) destroyTouch = buildTouch(ui.touch, genre, input);
  if (preview) startLevel(levelIndex);
  else if (playtest) startLevel(levelIndex, { spawn: options.spawn || null });
  else showTitle();
  raf = requestAnimationFrame(frame);

  const game = {
    get sim() { return sim; },
    get phase() { return phase; },
    get paused() { return phase === 'paused'; },
    pause() { if (phase === 'play') togglePause(); },
    resume,
    restart() { startLevel(levelIndex, { spawn: playtest ? options.spawn : null }); },
    setMuted(m) { audio?.setMuted(m); ui.setMuteIcon(m); },
    focus() { canvas.focus({ preventScroll: true }); },
    stop: () => stop('quit'),
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect(); io?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      container.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock);
      input?.destroy(); destroyTouch?.(); audio?.destroy(); ui.destroy();
    },
  };
  return game;
}

const EMPTY = {
  left: false, right: false, up: false, down: false, jump: false, action: false, fire: false, aim: null,
  pressed: { left: false, right: false, up: false, down: false, jump: false, action: false, fire: false, undo: false, restart: false },
};
function clock(s) { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
