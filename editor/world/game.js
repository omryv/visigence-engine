/* game.js — THE GAME, INSIDE THE ONE EDITOR.
 *
 * The editor (index.html, the page at /) is the one editor: the world is made here, and the game is made and played
 * here. This module is
 *
 *   the Game panel   genre, look, difficulty, enemies, and where on the world the mission stands;
 *   the workspaces   Mission (the mission graph) and Level (the level editor), opened over the viewport from the top
 *                    bar, on the editor's own mission;
 *   Play             the mission on this world, over the viewport.
 *
 * THE EDITOR KEEPS ONE MISSION. Until a workspace edits it, the mission is what the Game panel's settings make
 * (src/world/editorMission.js settingsMission). Once the graph or the level editor has changed it, every step comes
 * back here (a message from the workspace) and the edited mission is the one Play plays and the workspaces open, a
 * project or a game of levels. Changing the genre or the look makes a new mission from the settings (the panel says
 * so); difficulty and enemies change the edited mission in place.
 *
 * Workspaces and Play run the game runtime, game.html (the document an exported game is), inside this page in a frame,
 * handed the mission and the world in its address (editorMission.js). The world engine stands still while either is
 * open and its canvas is hidden, so one renderer draws at a time. Nothing is stored: the mission lives in this page's
 * memory, like the world, and the runtime inside keeps its own storage in memory too.
 */
import { GENRES } from "../../src/genres/registry.js";
import { MISSION_WORLDS } from "../../src/world/missionCard.js";
import { editorMissionURL, checkSettings, MISSION_DEFAULTS, DIFFICULTIES, MAX_ENEMIES } from "../../src/world/editorMission.js";

export const MESSAGES = Object.freeze({
  leaveGame: "visigence:leave-game",
  leaveWorkspace: "visigence:leave-workspace",
  mission: "visigence:mission",
  play: "visigence:play",
  workspace: "visigence:workspace",
});
const WORKSPACE_NAMES = { remix: "Mission", build: "Level" };

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
      ? "The mission finds the best 640 m of this world to stand on."
      : s ? `The mission stands at the spawn marker (${Math.round(s.x)}, ${Math.round(s.z)}). Move it with the Spawn tool.`
        : "Click the ground to set the spawn marker; the mission stands there.";
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

  function open(next, workspace = null) {
    let src;
    try { src = url(workspace); } catch (e) { announce(workspace ? WORKSPACE_NAMES[workspace] : "Play", `This world cannot be opened: ${e.message}`); return; }
    // A debug session (?debug=1, the browser checks) debugs the game too.
    if (new URLSearchParams(location.search).get("debug") === "1") src = src.replace(".html?", ".html?debug=1&");
    close();
    layer = document.createElement("div");
    layer.id = workspace ? "workspace-layer" : "game-layer";
    const frame = document.createElement("iframe");
    frame.title = workspace ? `${WORKSPACE_NAMES[workspace]}: the mission's ${workspace === "remix" ? "graph" : "levels"}` : "The game, on this world";
    frame.allow = "fullscreen; gamepad; autoplay";
    frame.src = src;
    layer.append(frame);
    document.body.append(layer);
    document.body.classList.toggle("in-game", !workspace);
    document.body.classList.toggle("in-workspace", !!workspace);
    engine.setPaused(true);
    frame.addEventListener("load", () => frame.contentWindow?.focus(), { once: true });
    view = next;
    onView(view);
  }
  function close() {
    if (!layer) return;
    layer.remove();
    layer = null;
    document.body.classList.remove("in-game", "in-workspace");
  }

  /** Play the mission on this world, over the viewport. Leaving the game returns to the view it was played from. */
  function play() {
    back = view === "remix" || view === "build" ? view : null;
    open("play");
  }
  /** Open a workspace (remix: the mission graph; build: the level editor) on the editor's mission. */
  function openWorkspace(name) { if (view !== name) open(name, name); }
  /** Back to the world: whatever is open over it comes down and the world runs again. */
  function leave() {
    if (!layer) return;
    close();
    engine.setPaused(false);
    view = "world";
    onView(view);
    render();
  }

  window.addEventListener("message", (e) => {
    const frame = layer?.querySelector("iframe");
    if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow) return;
    const { type } = e.data ?? {};
    if (type === MESSAGES.mission && e.data.mission) { mission = e.data.mission; return; }
    if (type === MESSAGES.leaveGame && back) { const to = back; back = null; open(to, to); return; }
    if (type === MESSAGES.leaveGame || type === MESSAGES.leaveWorkspace) { leave(); return; }
    if (type === MESSAGES.play) { if (e.data.mission) mission = e.data.mission; play(); return; }
    if (type === MESSAGES.workspace && WORKSPACE_NAMES[e.data.to]) { if (e.data.mission) mission = e.data.mission; openWorkspace(e.data.to); }
  });

  render();
  return {
    render, play, leave, openWorkspace, url,
    playing: () => view === "play",
    view: () => view,
    settings: () => currentSettings(),
    mission: () => mission,
  };
}
