/* game.js — THE GAME, INSIDE THE ONE EDITOR.
 *
 * The editor (index.html, the page at /) is the one editor: the world is made here, and the game is made and played
 * here. This module is
 *
 *   the Game panel   genre, look, difficulty, enemies, and where on the world the mission stands;
 *   the workspaces   Mission (the mission graph) and Level (the level editor), opened over the viewport from the top
 *                    bar, on the editor's own mission;
 *   Play             from the World view, the mission on this world, played by the world engine that draws it, at
 *                    the world's own scale (editor/world/play.js); from Mission or Level, the level as built, in the
 *                    game runtime over the viewport.
 *
 * THE EDITOR KEEPS ONE MISSION. Until a workspace edits it, the mission is what the Game panel's settings make
 * (src/world/editorMission.js settingsMission). Once the graph or the level editor has changed it, every step comes
 * back here (a message from the workspace) and the edited mission is the one Play plays and the workspaces open, a
 * project or a game of levels. Changing the genre or the look makes a new mission from the settings (the panel says
 * so); difficulty and enemies change the edited mission in place.
 *
 * The workspaces, and Play from one of them, run the game runtime, game.html (the document an exported game is), inside
 * this page in a frame, handed the mission and the world in its address (editorMission.js). The world engine stands
 * still while one is open and its canvas is hidden, so one renderer draws at a time. Play from the World view needs no
 * frame: the world engine draws the game. Nothing is stored: the mission lives in this page's memory, like the world,
 * and the runtime inside keeps its own storage in memory too.
 */
import { GENRES } from "../../src/genres/registry.js";
import { MISSION_WORLDS } from "../../src/world/missionWorlds.js";
import { editorMissionURL, checkSettings, MISSION_DEFAULTS, DIFFICULTIES, MAX_ENEMIES } from "../../src/world/editorMission.js";
import { encodeWorldLink } from "../../src/world/worldLink.js";
import { mountWorldPlay } from "./play.js";

export const MESSAGES = Object.freeze({
  leaveGame: "visigence:leave-game",
  leaveWorkspace: "visigence:leave-workspace",
  mission: "visigence:mission",
  play: "visigence:play",
  workspace: "visigence:workspace",
});

/**
 * @param {object} o
 * @param {object} o.engine                 the world engine (src/genesis/Engine.js)
 * @param {HTMLElement} o.panel             the Game panel's body, to draw the settings into
 * @param {() => ({x: number, z: number} | null)} o.spawn  the authored spawn marker, if any
 * @param {() => void} o.placeSpawn         arm the editor's spawn tool (the mission site is the spawn)
 * @param {(title: string, line: string) => void} o.announce
 * @param {(view: string) => void} [o.onView]  told when the view changes: "world", "remix", "build" or "play"
 */
export function mountGame({ engine, panel, spawn, placeSpawn, announce, onView = () => {} }) {
  let settings = { ...MISSION_DEFAULTS };
  let siteMode = "auto";   // "auto": the level ground picks the best site; "spawn": the mission stands at the spawn
  let mission = null;      // the mission as a workspace last edited it; null while the settings make it
  let layer = null, view = "world";
  let back = null;         // the workspace Play was pressed in, which leaving the game returns to

  const row = (label, control) => {
    const r = document.createElement("div");
    r.className = "t-row game-row";
    const l = document.createElement("label");
    l.textContent = label;
    r.append(l, control);
    return r;
  };
  const select = (options, value, onChange) => {
    const s = document.createElement("select");
    s.className = "game-select";
    for (const [id, label] of options) {
      const o = document.createElement("option");
      o.value = id; o.textContent = label; o.selected = id === value;
      s.append(o);
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };
  const levels = (m) => (Array.isArray(m?.levels) ? m.levels.length : 1);

  /* A setting that makes the mission (genre, look) starts it again from the settings; one the mission carries
     (difficulty, enemies) changes the edited mission in place. */
  function remake(why) {
    if (!mission) return;
    mission = null;
    announce("Game", `${why}: a new mission from the settings replaces the edited one`);
  }
  function patchMission(patch, levelPatch) {
    if (!mission) return;
    mission = Array.isArray(mission.levels)
      ? { ...mission, ...patch, levels: mission.levels.map((l) => ({ ...l, ...levelPatch })) }
      : { ...mission, ...patch, ...levelPatch };
  }

  function render() {
    panel.replaceChildren();
    const g = GENRES[settings.genre];
    panel.append(
      row("Genre", select(Object.entries(GENRES).map(([id, x]) => [id, x.label]), settings.genre, (v) => { settings.genre = v; settings.enemies = null; remake("Genre changed"); render(); })),
      row("Look", select(Object.entries(MISSION_WORLDS).map(([id, w]) => [id, w.title]), settings.look, (v) => { settings.look = v; remake("Look changed"); render(); })),
      row("Difficulty", select(DIFFICULTIES.map((d) => [d, d[0].toUpperCase() + d.slice(1)]), settings.difficulty, (v) => { settings.difficulty = v; patchMission({ difficulty: v }, {}); })),
    );
    const enemies = document.createElement("input");
    enemies.type = "number"; enemies.min = "1"; enemies.max = String(MAX_ENEMIES); enemies.className = "game-number";
    enemies.value = String(settings.enemies ?? g.preset.enemyCount);
    enemies.addEventListener("change", () => {
      const n = Math.max(1, Math.min(MAX_ENEMIES, Math.round(Number(enemies.value) || g.preset.enemyCount)));
      enemies.value = String(n);
      settings.enemies = n === g.preset.enemyCount ? null : n;
      patchMission({}, { enemyCount: n });
    });
    panel.append(row("Enemies", enemies));

    const site = document.createElement("div");
    site.className = "opt-row game-site";
    site.setAttribute("role", "group");
    site.setAttribute("aria-label", "Where the mission stands");
    for (const [mode, label] of [["auto", "Best site"], ["spawn", "At the spawn"]]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chz" + (siteMode === mode ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        siteMode = mode;
        if (mode === "spawn" && !spawn()) placeSpawn();
        render();
      });
      site.append(b);
    }
    const hint = document.createElement("p");
    hint.className = "opt-hint game-site-hint";
    const s = spawn();
    hint.textContent = siteMode === "auto"
      ? "You start where this world is best to stand on: dry, gentle ground the level ground finds."
      : s ? `You start at the spawn marker (${Math.round(s.x)}, ${Math.round(s.z)}). Move it with the Spawn tool.`
        : "Click the ground to set the spawn marker; you start there.";
    panel.append(site, hint);

    // What Play will play: the settings' mission, or the one the workspaces edited.
    const state = document.createElement("p");
    state.className = "opt-hint game-mission-state";
    state.textContent = mission
      ? `Edited in Mission or Level: ${mission.name ?? "the mission"}, ${levels(mission)} level${levels(mission) === 1 ? "" : "s"}.`
      : "Made from these settings. Open Mission or Level in the top bar to edit it.";
    panel.append(state);
    if (mission) {
      const reset = document.createElement("button");
      reset.type = "button"; reset.className = "chz game-reset";
      reset.textContent = "Back to the settings' mission";
      reset.addEventListener("click", () => { mission = null; render(); });
      panel.append(reset);
    }

    const go = document.createElement("button");
    go.type = "button"; go.className = "plate world-go game-play";
    go.textContent = mission ? "Play the mission on this world" : `Play ${g.label.toLowerCase()} on this world`;
    go.addEventListener("click", () => play());
    panel.append(go);
  }

  function currentSettings() {
    const s = siteMode === "spawn" ? spawn() : null;
    return checkSettings({ ...settings, site: s ? { x: s.x, z: s.z } : null });
  }

  /** The runtime address for the mission on the current world: played, or opened in a workspace. */
  function url(workspace = null) {
    return editorMissionURL({
      seed: engine.params.seed,
      worldParams: { terrain: engine.params.terrain, water: engine.params.water },
      settings: currentSettings(),
      mission, workspace,
    });
  }

  /* ── the views ──
     Each view (Mission, Level, 2D, My-3D-Engine) runs in its own frame, made the first time it is opened and KEPT: switching
     away hides it and tells it to stop drawing, switching back shows it again at once, as it was. A frame is made
     again only when what it was opened on has changed under it (Mission and Level are opened on the world and the
     Game panel's settings; their edits already came back here, so nothing is lost). 2D keeps its own game and is told
     the new world instead; My-3D-Engine depends on nothing here. Play is not kept: a game is built for the world as it stands,
     and it is taken down when it ends. */
  const worldKey = () => JSON.stringify([engine.params.seed, engine.params.terrain, engine.params.water]);
  const VIEWS = {
    remix: { src: () => url("remix"), key: () => worldKey() + JSON.stringify(currentSettings()), title: "Mission: the mission's graph" },
    build: { src: () => url("build"), key: () => worldKey() + JSON.stringify(currentSettings()), title: "Level: the mission's levels" },
    "2d": { src: () => `/2d.html#world=${worldLinkValue()}`, key: () => "2d", title: "2D: games on a grid" },
    my3d: { src: () => "/my-3d-engine.html", key: () => "my3d", title: "My-3D-Engine: a figure from a photograph" },
  };
  const frames = new Map();   // view -> { layer, frame, key, ready, queue }
  const worldLinkValue = () => encodeWorldLink({ seed: engine.params.seed, worldParams: { terrain: engine.params.terrain, water: engine.params.water } });
  const debug = new URLSearchParams(location.search).get("debug") === "1";
  const withDebug = (src) => (debug ? src.replace(/\.html(\?|#)/, (_, c) => `.html?debug=1${c === "?" ? "&" : "#"}`) : src);
  const tell = (frame, message) => { try { frame?.contentWindow?.postMessage(message, location.origin); } catch { /* not loaded yet */ } };
  /** A message for a view that may still be loading: sent when it says it is ready (visigence:ready), or now. */
  const tellWhenReady = (name, message) => {
    const f = frames.get(name);
    if (!f) return;
    if (f.ready) tell(f.frame, message); else f.queue.push(message);
  };

  function hideViews(except = null) {
    for (const [name, f] of frames) {
      if (name === except || f.layer.hidden) continue;
      f.layer.hidden = true;
      tell(f.frame, { type: "visigence:pause" });
    }
  }
  function makeFrame(id, src, title) {
    const layer = document.createElement("div");
    layer.id = id;
    const frame = document.createElement("iframe");
    frame.title = title;
    frame.allow = "fullscreen; gamepad; autoplay";
    frame.src = withDebug(src);
    layer.append(frame);
    document.body.append(layer);
    frame.addEventListener("load", () => frame.contentWindow?.focus(), { once: true });
    return { layer, frame };
  }
  function showView(name) {
    const v = VIEWS[name];
    let f = frames.get(name), key;
    try { key = v.key(); } catch (e) { announce(name, e.message); return; }
    if (f && f.key !== key) { f.layer.remove(); frames.delete(name); f = null; }
    if (!f) {
      let src;
      try { src = v.src(); } catch (e) { announce("View", `This world cannot be opened: ${e.message}`); return; }
      f = { ...makeFrame(`view-${name}`, src, v.title), key, ready: false, queue: [] };
      f.layer.className = "view-layer";
      frames.set(name, f);
    } else {
      f.layer.hidden = false;
      tell(f.frame, { type: "visigence:resume" });
      if (name === "2d") tell(f.frame, { type: "visigence:world", link: worldLinkValue() });
      f.frame.contentWindow?.focus();
    }
    hideViews(name);
    closeGame();
    if (worldPlay.playing()) worldPlay.leave();
    document.body.classList.add("in-workspace");
    engine.setPaused(true);
    view = name;
    onView(view);
  }
  function closeGame() {
    if (!layer) return;
    layer.remove();
    layer = null;
    document.body.classList.remove("in-game");
  }

  /* Play on the world: the World view's Play, drawn by the world engine itself. */
  const worldPlay = mountWorldPlay({
    engine, announce,
    onEnd: () => { if (view === "play") { view = "world"; onView(view); render(); } },
  });
  async function playOnWorld() {
    let s;
    try { s = currentSettings(); } catch (e) { announce("Play", `This world cannot be played: ${e.message}`); return; }
    view = "play";
    onView(view);
    // The mission is made into a project here, with the game: both arrive on the first Play (src/world/editorProject.js).
    worldPlay.start({
      site: s.site,
      make: async (index = 0) => (await import("../../src/world/editorProject.js")).editorProject({
        seed: engine.params.seed, worldParams: { terrain: engine.params.terrain, water: engine.params.water }, settings: s, mission, index,
      }),
    });
  }

  /**
   * Play the mission. From the World view, on this world (playOnWorld); from Mission or Level, the level as built, over
   * the whole screen, and leaving the game returns to the view it was played from.
   */
  function play() {
    if (view === "world") { playOnWorld(); return; }
    if (view === "play" && worldPlay.playing()) return;
    let src;
    try { src = url(); } catch (e) { announce("Play", `This world cannot be played: ${e.message}`); return; }
    back = view !== "world" && view !== "play" ? view : null;
    closeGame();
    hideViews();
    ({ layer } = makeFrame("game-layer", src, "The game, on this world"));
    document.body.classList.add("in-game");
    document.body.classList.remove("in-workspace");
    engine.setPaused(true);
    view = "play";
    onView(view);
  }
  /** Open a view (remix: the mission graph; build: the level editor; 2d; me). */
  function openWorkspace(name) { if (VIEWS[name] && view !== name) showView(name); }
  /** Back to the world: whatever is over it steps aside (the views kept, paused) and the world runs again. */
  function leave() {
    if (view === "world") return;
    if (worldPlay.playing()) { worldPlay.leave(); return; }
    closeGame();
    hideViews();
    document.body.classList.remove("in-workspace");
    engine.setPaused(false);
    view = "world";
    onView(view);
    render();
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    const fromGame = layer && e.source === layer.querySelector("iframe")?.contentWindow;
    const fromView = [...frames.values()].some((f) => e.source === f.frame.contentWindow);
    if (!fromGame && !fromView) return;
    const { type } = e.data ?? {};
    if (type === "visigence:ready") {
      for (const f of frames.values()) if (e.source === f.frame.contentWindow) { f.ready = true; for (const m of f.queue.splice(0)) tell(f.frame, m); }
      return;
    }
    // A figure from My-3D-Engine, for the mission: the Mission view opens with its prop importer on it.
    if (type === "visigence:figure" && e.data.figure?.bytes) {
      showView("remix");
      tellWhenReady("remix", { type: "visigence:import-figure", figure: e.data.figure });
      return;
    }
    if (type === MESSAGES.mission && e.data.mission) { mission = e.data.mission; return; }
    if (type === MESSAGES.leaveGame && fromGame && back) { const to = back; back = null; showView(to); return; }
    if (type === MESSAGES.leaveGame || type === MESSAGES.leaveWorkspace) { leave(); return; }
    if (type === MESSAGES.play) { if (e.data.mission) mission = e.data.mission; play(); return; }
    if (type === MESSAGES.workspace && VIEWS[e.data.to]) { if (e.data.mission) mission = e.data.mission; openWorkspace(e.data.to); }
  });

  render();
  return {
    render, play, leave, openWorkspace, url,
    playing: () => view === "play",
    /** Play on the world, while it runs: the hosted game and what the world made of the mission (tests, tools). */
    worldPlay,
    view: () => view,
    settings: () => currentSettings(),
    mission: () => mission,
  };
}
