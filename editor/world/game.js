/* game.js — THE GAME, INSIDE THE WORLD EDITOR.
 *
 * The world editor is the one editor: the world is made here, and the game is set up and played here. This module is
 * the Game panel (genre, look, difficulty, enemies, where the mission stands) and the game layer that Play opens over
 * the viewport.
 *
 * Play runs the game runtime, index.html, the same document an exported game is, inside this page (an iframe that
 * fills the viewport), handed the mission in its address (src/world/editorMission.js: the settings in the query, the
 * world in the fragment). The world engine stands still while the game runs and its canvas is hidden, so one renderer
 * draws at a time; leaving the game (its "Back to the world", or Esc from its pause screen) takes the layer down and
 * the world picks up where it was. Nothing is stored: the settings live in this page's memory, like the world.
 */
import { GENRES } from "../../src/genres/registry.js";
import { MISSION_WORLDS } from "../../src/world/missionCard.js";
import { editorMissionURL, checkSettings, MISSION_DEFAULTS, DIFFICULTIES, MAX_ENEMIES } from "../../src/world/editorMission.js";

export const LEAVE_GAME = "visigence:leave-game";

/**
 * @param {object} o
 * @param {object} o.engine                 the world engine (src/genesis/Engine.js)
 * @param {HTMLElement} o.panel             the Game panel's body, to draw the settings into
 * @param {() => ({x: number, z: number} | null)} o.spawn  the authored spawn marker, if any
 * @param {() => void} o.placeSpawn         arm the editor's spawn tool (the mission site is the spawn)
 * @param {(title: string, line: string) => void} o.announce
 */
export function mountGame({ engine, panel, spawn, placeSpawn, announce }) {
  let settings = { ...MISSION_DEFAULTS };
  let siteMode = "auto";   // "auto": the level ground picks the best site; "spawn": the mission stands at the spawn
  let layer = null;

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

  function render() {
    panel.replaceChildren();
    const g = GENRES[settings.genre];
    panel.append(
      row("Genre", select(Object.entries(GENRES).map(([id, x]) => [id, x.label]), settings.genre, (v) => { settings.genre = v; settings.enemies = null; render(); })),
      row("Look", select(Object.entries(MISSION_WORLDS).map(([id, w]) => [id, w.title]), settings.look, (v) => { settings.look = v; })),
      row("Difficulty", select(DIFFICULTIES.map((d) => [d, d[0].toUpperCase() + d.slice(1)]), settings.difficulty, (v) => { settings.difficulty = v; })),
    );
    const enemies = document.createElement("input");
    enemies.type = "number"; enemies.min = "1"; enemies.max = String(MAX_ENEMIES); enemies.className = "game-number";
    enemies.value = String(settings.enemies ?? g.preset.enemyCount);
    enemies.addEventListener("change", () => {
      const n = Math.max(1, Math.min(MAX_ENEMIES, Math.round(Number(enemies.value) || g.preset.enemyCount)));
      enemies.value = String(n);
      settings.enemies = n === g.preset.enemyCount ? null : n;
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
    hint.className = "opt-hint";
    const s = spawn();
    hint.textContent = siteMode === "auto"
      ? "The mission finds the best 640 m of this world to stand on."
      : s ? `The mission stands at the spawn marker (${Math.round(s.x)}, ${Math.round(s.z)}). Move it with the Spawn tool.`
        : "Click the ground to set the spawn marker; the mission stands there.";
    panel.append(site, hint);

    const go = document.createElement("button");
    go.type = "button"; go.className = "plate world-go game-play";
    go.textContent = `Play ${g.label.toLowerCase()} on this world`;
    go.addEventListener("click", () => play());
    panel.append(go);
  }

  function currentSettings() {
    const s = siteMode === "spawn" ? spawn() : null;
    return checkSettings({ ...settings, site: s ? { x: s.x, z: s.z } : null });
  }

  /** The runtime address for the current settings on the current world (also what the browser checks read). */
  function url() {
    return editorMissionURL({
      seed: engine.params.seed,
      worldParams: { terrain: engine.params.terrain, water: engine.params.water },
      settings: currentSettings(),
    });
  }

  function play() {
    if (layer) return;
    let src;
    try { src = url(); } catch (e) { announce("Play", `This world cannot be played: ${e.message}`); return; }
    // A debug session (?debug=1, the browser checks) debugs the game too.
    if (new URLSearchParams(location.search).get("debug") === "1") src = src.replace("?", "?debug=1&");
    layer = document.createElement("div");
    layer.id = "game-layer";
    const frame = document.createElement("iframe");
    frame.title = "The game, on this world";
    frame.allow = "fullscreen; gamepad; autoplay";
    frame.src = src;
    layer.append(frame);
    document.body.append(layer);
    document.body.classList.add("in-game");
    engine.setPaused(true);
    frame.addEventListener("load", () => frame.contentWindow?.focus(), { once: true });
  }

  function leave() {
    if (!layer) return;
    layer.remove();
    layer = null;
    document.body.classList.remove("in-game");
    engine.setPaused(false);
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.data?.type !== LEAVE_GAME || !layer) return;
    if (e.source !== layer.querySelector("iframe")?.contentWindow) return;
    leave();
  });

  render();
  return { render, play, leave, url, playing: () => !!layer, settings: () => currentSettings() };
}
