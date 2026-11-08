/* play.js — PLAY ON THE WORLD, IN THE ONE EDITOR.
 *
 * The World view's Play: the mission played on the world on screen, by the world engine that is drawing it. Nothing
 * is loaded in a frame, no second renderer starts, the world is not rebuilt: the player stands on this world's own
 * ground, at its own scale, under its sky and weather, among the buildings placed on it, and the mission's critters,
 * pads, gates and pickups are brought here (src/world/worldPlay.js). When the game ends, or the author leaves it, the
 * editing view comes back exactly where it was.
 *
 *   the game      src/game/ShooterSession.js, HOSTED: the game's simulation, its critters, its weapon and hands, its
 *                 effects and sound, in a group of the world engine's scene at the level's origin;
 *   the eye       the engine's play mode (Engine.beginPlay): the game's controller runs first in each of the engine's
 *                 frames and leaves the engine's camera where the player looks from; the engine draws the world from
 *                 there, then the game's hands and weapon over it (overlayPass);
 *   the HUD       this module: health, the weapon, the mission's step, the crosshair, and one card for every pause
 *                 (ready, paused, won, lost, and why a world could not be played).
 *
 * Mission and Level keep their own Play: there the level is played as it was built, in the game runtime
 * (editor/world/game.js).
 */
import { Group } from "three";
import { State } from "../../src/sim/GameState.js";
import { worldLevel, engineWorld } from "../../src/world/worldPlay.js";
import { wetAt } from "../../src/kernel/water/flood.js";
import { genreOf } from "../../src/genres/registry.js";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** What a body manages, as the level's Terrain reads it: the pack's world traversal (packs/<theme>/pack.json). */
const traversalOf = (pack) => {
  const V = pack?.world?.terrain?.traversal ?? {};
  return { maxSlope: V.maxSlope ?? 0.7, stepUp: V.stepUp ?? 0.45, wadeDepth: V.wade ?? 0.55, slopeEps: V.slopeEps ?? 1 };
};

/**
 * @param {object} o
 * @param {object} o.engine      the world engine (src/genesis/Engine.js)
 * @param {(title: string, line: string) => void} o.announce
 * @param {() => void} o.onEnd   told when play has ended and the editing view is back
 */
export function mountWorldPlay({ engine, announce, onEnd = () => {} }) {
  const canvas = engine.renderer.domElement;
  const root = el("div"); root.id = "world-play"; root.hidden = true;
  const cross = el("div", "wp-cross"); cross.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 4; i++) cross.append(el("i"));
  const hit = el("div", "wp-hit", "×"); hit.setAttribute("aria-hidden", "true");
  const hurt = el("div", "wp-hurt"); hurt.setAttribute("aria-hidden", "true");
  const top = el("div", "wp-top");
  const mission = el("span", "wp-mission"), progress = el("span", "wp-progress mono");
  top.append(mission, progress);
  const bottom = el("div", "wp-bottom");
  const health = el("div", "wp-health"), healthValue = el("b", "mono", "100"), healthBar = el("span"), healthFill = el("i");
  healthBar.append(healthFill); health.append(healthValue, healthBar);
  const prompt = el("div", "wp-prompt");
  const weapon = el("div", "wp-weapon"), weaponName = el("span", "wp-wname"), ammo = el("b", "mono wp-ammo");
  weapon.append(weaponName, ammo);
  bottom.append(health, prompt, weapon);
  const touch = el("div", "wp-touch");
  const fireKey = el("button", "wp-tkey", "Fire"), reloadKey = el("button", "wp-tkey", "Reload");
  fireKey.type = reloadKey.type = "button";
  touch.append(reloadKey, fireKey);
  const card = el("div", "wp-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "false");
  const eyebrow = el("p", "wp-eyebrow"), title = el("h2", "wp-title"), line = el("p", "wp-line");
  const keys = el("div", "wp-keys"), go = el("button", "wp-go plate"), back = el("button", "wp-back chz", "Back to editing");
  go.type = back.type = "button";
  keys.append(go, back);
  const help = el("p", "wp-help", "WASD move · mouse look · click fire · right-click aim · R reload · E use · Space jump · Esc pause");
  card.append(eyebrow, title, line, keys, help);
  root.append(hurt, cross, hit, top, bottom, touch, card);
  document.body.append(root);

  let session = null, building = false, active = false, current = null, onGo = null, lastHud = 0, lastCard = "";
  const coarse = () => matchMedia("(pointer: coarse)").matches;

  /* ── the host: what the hosted session is handed of the world engine ── */
  const parent = new Group();
  parent.name = "WorldPlay";
  const host = {
    renderer: engine.renderer,
    parent,
    world: engine.scene,
    // Read when a game is built: a world rebuilt since (a new seed) has its own sky.
    get lights() { return { hemi: engine.sky.hemi, sun: engine.sky.sun }; },
    sunDir: (out) => { const d = engine.sunDirection?.(); if (d) out.copy(d); else out.set(0, 1, 0); },
    level: (compiled) => {
      // Where the player starts on the world: the spawn marker when the mission stands there, else the site the
      // level ground chose as the best of this world, else where the editor's camera is looking.
      const site = current.site ?? (compiled.ground?.kind === "world" ? compiled.ground.site : null) ?? engine.getViewer();
      const level = worldLevel(compiled, engineWorld(engine, wetAt), { x: site.x, z: site.z }, traversalOf(compiled.pack));
      parent.position.set(level.playArea.origin.x, 0, level.playArea.origin.z);
      parent.updateMatrixWorld(true);
      current.area = level.playArea;
      return level;
    },
  };

  /* ── the controller the engine runs in play mode ── */
  const eye = engine.camera;
  /* The world's shadow map is drawn only when something in it moves (Engine _needsShadow). In play the critters
     move all the time, so it is redrawn every SHADOW_EVERY frames: a moving body's shadow follows it at a
     fraction of the cost of a shadow pass every frame. */
  const SHADOW_EVERY = 3;
  let frames = 0;
  const controller = {
    moveInput: { x: 0, y: 0 }, lookInput: { x: 0, y: 0 }, runInput: false, jumpInput: false, touchActive: false,
    swimming: false,
    update() {
      if (!session?.game) return false;
      if (controller.touchActive && session.playing) {
        session.touchMove = { x: controller.moveInput.x, y: controller.moveInput.y };
        session.look.x += controller.lookInput.x; session.look.y += controller.lookInput.y;
        controller.lookInput.x = controller.lookInput.y = 0;
        session.touchJump = controller.jumpInput; controller.jumpInput = false;
      }
      session.frame(performance.now());
      // The game's eye is in the level's frame; the level's origin stands at the group's place on the world.
      eye.position.copy(session.camera.position).add(parent.position);
      eye.quaternion.copy(session.camera.quaternion);
      if (eye.fov !== session.camera.fov) { eye.fov = session.camera.fov; eye.updateProjectionMatrix(); }
      if (++frames % SHADOW_EVERY === 0) engine.invalidate();
      return true;
    },
  };

  function showCard(kind, { eyebrowText, titleText, lineText, goText = null, action = null }) {
    lastCard = kind;
    card.hidden = false;
    root.classList.add("carded");
    document.body.classList.remove("play-live");
    eyebrow.textContent = eyebrowText; title.textContent = titleText; line.textContent = lineText ?? "";
    go.hidden = !goText; go.textContent = goText ?? ""; onGo = action;
    help.hidden = !goText || coarse();
    (goText ? go : back).focus({ preventScroll: true });
  }
  function hideCard() { card.hidden = true; root.classList.remove("carded"); lastCard = ""; if (active) document.body.classList.add("play-live"); }

  function begin() {
    if (!session?.game) return;
    hideCard();
    session.start();
    if (!coarse()) canvas.requestPointerLock?.()?.catch?.(() => {});
  }

  function frame(stats) {
    // Every frame: the reticle's spread, the hurt flash.
    const w = stats.weapon;
    cross.style.setProperty("--spread", w ? ((w.spread ?? 0) + (w.recoil ?? 0) * 0.4).toFixed(3) : "0");
    cross.style.opacity = w && !w.keepAimReticle ? String(1 - (w.adsBlend ?? 0)) : "1";
    cross.hidden = stats.view !== "first";
    const p = session?.game?.player;
    hurt.style.opacity = p ? (p.alive ? Math.max(0, 1 - p.lastHitAge / 0.7) * 0.55 : 0.6).toFixed(3) : "0";
    if (!stats.playing) {
      const key = stats.state;
      if (key !== lastCard && [State.PAUSED, State.VICTORY, State.PLAYER_DEAD].includes(key)) endCard(key);
    }
    const now = performance.now();
    if (now - lastHud < 120) return;
    lastHud = now;
    healthValue.textContent = String(Math.max(0, Math.round(stats.health)));
    healthFill.style.width = Math.max(0, Math.min(100, stats.health)) + "%";
    health.classList.toggle("low", stats.health > 0 && stats.health <= 30);
    weapon.hidden = !w;
    if (w) {
      weaponName.textContent = w.state === "RELOADING" ? "Reloading" : (w.name ?? "");
      ammo.textContent = `${w.mag ?? 0} / ${w.reserve ?? 0}`;
      weapon.dataset.level = w.state === "RELOADING" ? "reload" : w.mag === 0 ? "empty" : w.mag <= (w.magSize ?? 1) * 0.25 ? "low" : "";
    }
    const o = stats.objectives;
    mission.textContent = (o?.label ?? "Explore")
      + (o?.encounterRemaining != null ? ` · ${o.encounterRemaining} left` : "")
      + (o?.targetsTotal ? ` · ${o.targetsCompleted}/${o.targetsTotal}` : "")
      + (o?.targetDistance != null ? ` · ${o.targetDirection} ${o.targetDistance} m` : "");
    const t = stats.time ?? 0;
    progress.textContent = `${current?.levels > 1 ? `Level ${current.index + 1}/${current.levels} · ` : ""}${o?.completed ?? 0}/${o?.total ?? 0} · ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    prompt.textContent = stats.interaction ? `Hold ${coarse() ? "Use" : "E"} · ${stats.interaction.label}` : "";
    prompt.style.setProperty("--p", stats.interaction?.progress ?? 0);
    touch.hidden = !coarse() || !stats.playing;
  }

  function endCard(state) {
    if (state === State.PAUSED) {
      showCard(State.PAUSED, { eyebrowText: "Paused", titleText: "The mission waits", lineText: "The world stands still until you go on.", goText: "Resume", action: begin });
    } else if (state === State.VICTORY) {
      const next = current.index + 1 < current.levels;
      showCard(State.VICTORY, {
        eyebrowText: "Mission complete", titleText: next ? `Level ${current.index + 1} of ${current.levels} done` : "You did it, on your world",
        lineText: `${session.game.kills} down · ${Math.floor(session.game.time / 60)}:${String(Math.floor(session.game.time % 60)).padStart(2, "0")}`,
        goText: next ? "Next level" : "Play again",
        action: next ? () => start({ ...current.request, index: current.index + 1 }) : begin,
      });
    } else {
      showCard(State.PLAYER_DEAD, {
        eyebrowText: "Mission failed", titleText: "Fallen on your world", lineText: "The mission starts again where it began.",
        goText: "Try again", action: begin,
      });
    }
  }

  async function ensureSession() {
    if (session) return session;
    // The game's code arrives with the first Play: an editor that never plays never loads it.
    const { ShooterSession } = await import("../../src/game/ShooterSession.js");
    const s = new ShooterSession(canvas, {
      host,
      onStatus: (text) => { if (building) line.textContent = text; },
      onFrame: (stats) => { if (active) frame(stats); },
      onError: (error) => fail(error),
      onFeedback: (kind) => { hit.classList.remove("on"); void hit.offsetWidth; hit.classList.add("on"); hit.dataset.kind = kind; },
    });
    await s.initialize();
    session = s;
    return s;
  }

  function fail(error) {
    building = false;
    console.error(error);
    showCard("error", { eyebrowText: "Play", titleText: "This world cannot be played here", lineText: error?.message ?? String(error) });
  }

  /**
   * Play the editor's mission on the world.
   * @param {{make: (index: number) => Promise<{project: object, levels: number}>, index?: number, site: {x: number, z: number}|null}} request
   *   `make` makes level `index` of the mission into a project (src/world/editorProject.js); `site` is where the player
   *   starts, or null for where the level ground finds this world best to stand on
   */
  async function start(request) {
    if (building) return;
    const { index = 0, site = null } = request;
    current = { request, project: null, levels: 1, index, site, area: null };
    active = true;
    root.hidden = false;
    document.body.classList.add("in-play");
    showCard("loading", { eyebrowText: "On this world", titleText: "Bringing the mission here", lineText: "Loading…" });
    building = true;
    try {
      const made = await request.make(index);
      const project = current.project = made.project;
      current.levels = made.levels;
      const s = await ensureSession();
      if (!active) { building = false; return; }
      if (!parent.parent) engine.scene.add(parent);
      s.unload();
      if (!(await s.build(project, { isCurrent: () => active }))) { building = false; return; }
      building = false;
      if (!active) { s.unload(); return; }
      engine.beginPlay(controller, (renderer) => s.renderOverlay(renderer));
      s.resize();
      const a = current.area, g = genreOf(project);
      const notes = [];
      if (a?.moved.length) notes.push(`${a.moved.length} of the mission's things moved onto open ground`);
      if (a?.dropped.length) notes.push(`${a.dropped.length} piece${a.dropped.length === 1 ? "" : "s"} of cover left out where the world had no room`);
      const where = site ? "at the spawn marker" : "where this world is best to stand on";
      showCard("ready", {
        eyebrowText: `${g.label} · on this world`,
        titleText: project.name ?? "Your mission is ready",
        lineText: `You start ${where}, on the world as you built it.${notes.length ? ` ${notes.join("; ")}.` : ""}`,
        goText: "Play", action: begin,
      });
      announce("Play", `On this world: ${a ? `${a.size} m round the start` : "ready"}`);
    } catch (e) {
      fail(e);
    }
  }

  /** Back to editing: the game is taken out of the world and the editing view comes back as it was. */
  function leave() {
    if (!active) return;
    active = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    session?.unload();
    engine.endPlay();
    parent.removeFromParent();
    root.hidden = true;
    hideCard();
    document.body.classList.remove("in-play", "play-live");
    onEnd();
  }

  go.addEventListener("click", () => onGo?.());
  back.addEventListener("click", () => leave());
  const press = (on) => (e) => { e.preventDefault(); if (!session?.playing) return; session.fire = on; if (on) session.actions.fire = true; };
  fireKey.addEventListener("pointerdown", press(true));
  fireKey.addEventListener("pointerup", press(false));
  fireKey.addEventListener("pointercancel", press(false));
  reloadKey.addEventListener("pointerdown", (e) => { e.preventDefault(); if (session?.playing) session.actions.reload = true; });
  addEventListener("resize", () => { if (active) session?.resize(); });

  return {
    start, leave,
    playing: () => active,
    /** The hosted game, for tests and tools: its session and what the world made of the mission. */
    get session() { return session; },
    get area() { return current?.area ?? null; },
  };
}
