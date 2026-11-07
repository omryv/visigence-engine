// studio.js — the editor shell. The engine owns the viewport; this file is
// only labeled chrome wired to the engine's public API. Status stays quiet:
// the seed readout pulses on events, details go to the console.

import { Engine, THEMES, PALETTES, makeParams, bakeHeightField, createHeightSampler, resolveDetail } from "../../src/genesis/Engine.js";
import { Minimap } from "../../src/genesis/Minimap.js";
import { allItems, CATEGORIES } from "../../src/genesis/world/props-packs.js";
import { makeUid, nextUidIndex, scoreSettlements, deriveSpawn } from "../../src/genesis/world/fusion.js";
import { SITE_KINDS, makePlan } from "../../src/genesis/world/worldplan.js";
import { DEFAULT_SEED, normalizeSeed } from "../../src/kernel/seed.js";
import { composeSite } from "../../src/genesis/world/compose.js";
import { plantWorld } from "../../src/genesis/world/planting.js";
import { mountGame } from "./game.js";
import { groundBuildings } from "../../src/genesis/world/footing.js";
import { isPinnable, PIN_LEGIBLE_MAX } from "../../src/genesis/world/pinnable.js";
import { assertGlb } from "../../src/genesis/world/glb-compat.js";
import {
  buildWorldFile, serializeWorldFile, parseWorldFile, worldFileName,
  paramsFromWorldFile, propsFromWorldFile, omissionNote, generatorNote,
} from "../../src/genesis/world/worldfile.js";
import { buildExportBundle } from "../../src/genesis/world/export-world.js";
import { encodeZip } from "../../src/genesis/world/export/zip.js";
import { createDurableLink, isFileLinkSupported } from "../../src/genesis/world/durable.js";
import { CANONICAL_RES } from "../../src/kernel/terrain/canonical.js";
import { solveRiver } from "../../src/genesis/terrain/river.js";
import { floodFromSea } from "../../src/kernel/water/flood.js";
import { hexToCss } from "../../src/genesis/style/palettes.js";
import { UI, blockIcon } from "./icons.js";
import { html, trust, setHTML, EMPTY } from "../../src/genesis/trusted.js";
import {
  NOISE_TYPES, BLEND_MODES, MAX_LAYERS, makeLayer, getNoiseType,
} from "../../src/kernel/terrain/noise-stack.js";
import { createBiomeField } from "../../src/kernel/terrain/climate.js";
import { CommandPalette } from "./cmdk.js";
import { mountCursor } from "./cursor.js";
import { ObjectManager } from "./objects.js";
import { Cues } from "./cues.js";
import { UiSound } from "../../src/genesis/audio/ui-sound.js";
import { categoryColor, phrase, subjectOf, varyTransform, formatXZ } from "../../src/genesis/world/object-index.js";

// The catalog's part spec for a block id. Declared up here because the
// engine is handed it during construction, below.
const PROC_BY_ID = new Map(allItems().map((i) => [i.id, i.proc]));

const $ = (s) => document.querySelector(s);
let canvas = $("#viewport");

/* ── session preferences ──
   Memory only: what the editor learns about a session (sound off, advanced
   on, the coach seen) lives in this Map and dies with the tab. */
const prefs = new Map();
const pref = {
  get: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
  set: (k, v) => { prefs.set(k, v); },
};

// The drawn pointer — dot, wake, lens (js/cursor.js). Mounted before the gate
// so the entry film gets the same hand as the editor; it declines coarse
// pointers and reduced motion on its own.
mountCursor();

/* ── boot ──
   THE EDITOR OPENS ON ONE SEED'S OWN WORLD, and it is the same world every time: DEFAULT_SEED (src/kernel/seed.js),
   grown by the kernel from that seed and nothing else, or the seed named by ?seed=. There is no sample world, no
   authored landing document and no dice anywhere in it: every world this editor shows is a seed's own world, or a
   file somebody opened, or what somebody built on one of those.

   The editor writes nothing to the address bar. The one other thing the path decides is whether the entry film
   plays: see "the gate" at the foot of this file. */
const landingSeed = normalizeSeed(new URLSearchParams(location.search).get("seed") || "") || DEFAULT_SEED;
/* The document the world on screen came from, and therefore the one Reset puts it back to: null while it is still
   the seed's own world it opened on. Moves when, and only when, an Open replaces the world; see resetWorld. */
let baseDoc = null;
const params = makeParams({ seed: landingSeed });
console.info("[studio] landing world", params.seed, `· ${params.biome}`);
// ?gfx=low|medium|high|ultra forces a quality tier — a DEV knob (masked GPUs
// under-detect; QA needs determinism), not world state. The seed is the one
// world-shaped thing the URL may name (above).
const gfx = new URLSearchParams(location.search).get("gfx");
const engine = await Engine.create(canvas, params, gfx ? { quality: gfx } : {});
canvas = engine.canvas;   // the renderer may have needed a fresh canvas (core/Renderer.js)
window.engine = engine; // console access is the debug UI
// …and the editor's own commands, for the console and the browser checks (tools/test/e2e-world.mjs, check-wgsl.mjs).
window.studio = { plantWoods: () => plantWoods(), placeSite: (x, z, kind) => generateSite({ x, z }, kind ? { kind } : {}) };
// The scatter batcher builds its prototypes from the same catalog the
// dock places from, so a scattered oak IS a placed oak.
engine.setScatterCatalog((id) => PROC_BY_ID.get(id) || null);

let lastField = null;   // latest baked heightfield (post-erosion)
let spawnInfo = null;
let customSpawn = null; // authored spawn {x,z}, tagged to the world it was set in
let spawnTag = null;

let armedSpawn = false;
let armedGrass = false;  // grass brush: stays armed so the dev can keep painting
let armedSculpt = false; // terrain brush
let armedSite = false;   // generate: click the ground to place a whole site
let armedRiver = false;  // river: hover shows the solved course, click carves it
let riverCtx = null;     // { field, wet } cached while the tool is armed
const brush = { mode: "raise", radius: 70, strength: 8 };

// Put every tool back down: the one place that clears held blocks, brushes
// and the placement ghost, so no two tools can ever be live at once.
function disarmAll() {
  armed = null;
  armedSpawn = false;
  armedGrass = false;
  armedSculpt = false;
  armedSite = false;
  armedRiver = false;
  riverCtx = null;
  engine.clearGhost();
  engine.showSiteRing(null);
  engine.showPathGhost(null);
  renderCards();
  refreshTools();
}
const worldTag = () => engine.params.seed + "|" + engine.params.biome;

function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("two");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}
/* The two-line form. Undo does not say "Undo — place": it says what happened
   to the world, and the name of the thing it happened to.

     Undo
     Removed Oak Tree

   A history that names the button you pressed is telling you something you
   already know; a history that names the object is telling you whether you
   are about to lose the right one. */
function announce(title, line, ms = 2200) {
  const el = $("#toast");
  setHTML(el, EMPTY);
  const b = document.createElement("b");
  b.textContent = title;
  const i = document.createElement("span");
  i.textContent = line;
  el.append(b, i);
  el.classList.add("two");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* ── seed chip ── */
const seedText = $("#seed-text");
function showSeed() {
  seedText.textContent = engine.params.seed;
  seedText.classList.remove("pulse");
  void seedText.offsetWidth;
  seedText.classList.add("pulse");
}
$("#seed-chip").addEventListener("click", () => {
  const input = prompt("Travel to seed:", engine.params.seed);
  if (input) engine.setSeed(input);
});

/* ── the game ──
   The Game panel sets the mission up and Play plays it, here, over the viewport, on this world as it stands
   (editor/world/game.js); the world stands still meanwhile. Its site is the best one the level ground finds, or the
   spawn marker. */
const game = mountGame({
  engine, panel: $("#game-rows"),
  spawn: () => (customSpawn && spawnTag === worldTag() ? customSpawn : null),
  placeSpawn: () => { if (!armedSpawn) $("#btn-spawn").click(); },
  announce,
});
window.studio.game = game;
$("#play-here").addEventListener("click", () => game.play());
for (const a of document.querySelectorAll("[data-mode-link]")) {
  a.addEventListener("click", () => {
    const u = new URL(a.getAttribute("href"), location.href);
    u.searchParams.set("seed", engine.params.seed);
    a.href = u.pathname + u.search;
  });
}

/* ── undo / redo ──
   A linear stack of {label, undo, redo} pairs. Authored content only —
   placements, transforms, grass, spawn, sculpt — because those are the
   things a person can lose by accident. World params are already visible
   and re-settable in the panel. */
/* A command is { kind, subject, undo, redo } — a VERB and a NOUN, never a
   label. object-index.js turns the pair into the sentence each direction
   deserves ("Placed Watchtower" / "Removed Oak Tree"), so the wording lives
   in one tested place instead of at forty call sites. */
// NOTE: this must NOT be called `history`. A module-scope `const history`
// shadows window.history for the whole module; when it did, the throw from
// the first caller to touch the real one took down every listener that ran
// after it (erosion never re-kicked, the panel never synced). The URL sync
// is gone now, but the shadowing hazard is not — keep the name.
const undoStack = {
  past: [], future: [], limit: 120, busy: false,
  push(cmd) {
    this.past.push(cmd);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
    this.sync();
  },
  /* THE GUARD COMES BEFORE THE POP, and that order is the whole of it.
     It read `const cmd = this.past.pop(); if (!cmd || this.busy) return;`,
     so a call that arrived while one was already running took an entry off
     the stack and then returned without running it and without pushing it to
     `future`. The entry was not deferred, it was DESTROYED — the edit it
     described could no longer be undone or redone by anything.

     Not a narrow race. Every undo body is async (a world undo awaits
     `props.restore` once per placement — hundreds of them for a town), so
     `busy` is true for seconds, and the ⌘Z handler below has no `e.repeat`
     filter: HOLDING the key feeds this at the OS repeat rate. Three presses
     during one in-flight undo left one of three edits reachable. And it was
     silent — the buttons re-sync only in the `finally`, so nothing on screen
     said the history had just been shortened. */
  async undo() {
    if (this.busy) return;
    const cmd = this.past.pop();
    if (!cmd) return;
    this.busy = true;
    try {
      await cmd.undo();
      this.future.push(cmd);
      announce("Undo", phrase(cmd.kind, cmd.subject, "undo"), 1900);
      sound.restore();
    } finally { this.busy = false; this.sync(); }
  },
  async redo() {
    if (this.busy) return;
    const cmd = this.future.pop();
    if (!cmd) return;
    this.busy = true;
    try {
      await cmd.redo();
      this.past.push(cmd);
      announce("Redo", phrase(cmd.kind, cmd.subject, "do"), 1900);
      sound.restore();
    } finally { this.busy = false; this.sync(); }
  },
  sync() {
    const u = $("#btn-undo"), r = $("#btn-redo");
    u.disabled = !this.past.length;
    r.disabled = !this.future.length;
    // The tooltip names what the key will actually do, so the sentence is
    // available BEFORE the keypress and not only in the toast after it.
    const top = this.past[this.past.length - 1], next = this.future[this.future.length - 1];
    u.title = top ? `Undo — ${phrase(top.kind, top.subject, "undo")} (⌘Z)` : "Undo (⌘Z)";
    r.title = next ? `Redo — ${phrase(next.kind, next.subject, "do")} (⌘⇧Z)` : "Redo (⌘⇧Z)";
    /* Reset rides the same signal. Every authored change goes through this
       stack — placements, transforms, grass, spawn, sculpt — so this is the
       one place that already runs after all of them, and hanging the button's
       enabled state here costs one comparison per user action rather than one
       per frame. The panel's own world events call it too (a terrain slider
       is not an undo entry, and still changes the world). */
    refreshReset();
  },
};

/* The editor's own voice. Synthesised, never streamed (engine/audio/ui-sound.js):
   a placement cue has to sound the instant the block lands, on a locked-down
   network, with nothing fetched. Off is remembered. */
const sound = new UiSound({ enabled: (() => {
  return pref.get("wf-sound", "on") !== "off";
})() });
$("#btn-undo").addEventListener("click", () => undoStack.undo());
$("#btn-redo").addEventListener("click", () => undoStack.redo());

// Snapshot the transform + style of a set of placements, for undo. Style
// (tint, stretch) rides along so painting and stretching undo like moves.
const snapTransforms = (uids) => uids.map((uid) => {
  const r = engine.props.get(uid)?.record;
  return r ? {
    uid, position: [...r.position], rotationY: r.rotationY || 0, scale: r.scale || 1,
    stretch: r.stretch ? [...r.stretch] : null, tint: r.tint ? [...r.tint] : null,
    style: r.style || null,
  } : null;
}).filter(Boolean);
function applyTransforms(list) {
  for (const t of list) {
    engine.props.update(t.uid, {
      position: [...t.position], rotationY: t.rotationY, scale: t.scale,
      stretch: t.stretch ? [...t.stretch] : null, tint: t.tint ? [...t.tint] : null,
      style: t.style || null,
    });
  }
  engine.markSelection(list.map((t) => t.uid).filter((uid) => engine.props.get(uid)));
  syncStylePop();
}
// Wrap a transform edit so it lands on the undo stack as one step, named
// after the objects it touched rather than after the control that did it.
function withTransformHistory(kind, uids, fn) {
  const before = snapTransforms(uids);
  const subject = subjectOf(uids.map((uid) => engine.props.get(uid)?.record.label));
  fn();
  const after = snapTransforms(uids);
  if (!before.length) return;
  undoStack.push({ kind, subject, undo: () => applyTransforms(before), redo: () => applyTransforms(after) });
}

/* ── the rail ──
   FOUR PANELS, ONE PLACE. Worlds, Blocks, World settings and the Object
   register are the same module at the same coordinates on the right-hand edge
   (see .rail in editor.css); what differs is what is inside them.

   ONE AT A TIME, at every width. They used to be able to stand together — the
   catalogue across the bottom of the screen and the world panel down the side
   — which between them covered most of the viewport of a tool whose first
   conviction is that the world is never boxed in. None of them answers a
   question another one asks, so there was never a reason to read two at once.

   `phone()` still exists because below 860px the rail becomes a bottom sheet
   and `open` rather than `collapsed` is what shows it. */
const phone = () => matchMedia("(max-width: 860px)").matches;
const RAILS = {
  blocks: $("#blocks-dock"),
  world: $("#world-panel"),
  game: $("#game-panel"),
  objects: $("#objects-panel"),
};
const railOpen = (name) => !RAILS[name].classList.contains("collapsed");
const anyRail = () => Object.keys(RAILS).some(railOpen);

function setRail(name, open) {
  for (const [key, el] of Object.entries(RAILS)) {
    el.classList.toggle("collapsed", key === name ? !open : true);
  }
  if (open && name === "objects") { objects.refresh(); objects.setSelection(selection); }
  if (open && name === "blocks") renderCards();
  if (open && name === "game") game.render();
  refreshTools();
}
const setPanel = (open) => setRail("world", open);
const setDock = (open) => setRail("blocks", open);
const setObjects = (open) => setRail("objects", open);
const panelOpen = () => railOpen("world");
const dockOpen = () => railOpen("blocks");
const objectsOpen = () => railOpen("objects");

/* ── simple and advanced ──
   ONE SWITCH, AND IT ONLY EVER ADDS. Simple is a world, a catalogue and a
   way to play — which is the whole product for somebody who wants a world
   rather than a workshop. Advanced puts the instruments back: the brushes,
   the terrain sliders, the register, GLB import, the command palette.

   Everything it governs is marked `.adv` in the markup and hidden by a single
   display rule, so there is no second code path and nothing is ever disabled —
   a greyed-out control is a promise the interface has to keep, and this way
   there is nothing to keep. */
function setAdvanced(on) {
  pref.set("wf-advanced", on ? "on" : "off");
  document.body.classList.toggle("simple", !on);
  $("#btn-advanced").setAttribute("aria-pressed", String(on));
  // A rail that has just been hidden must not stay open behind the switch.
  if (!on && (objectsOpen())) setRail(null, false);
  if (!on) disarmAll();
  refreshTools();
  requestAnimationFrame(() => { syncDeck(); syncModeMarker(); });
}
$("#btn-advanced").addEventListener("click", () => {
  const next = $("#btn-advanced").getAttribute("aria-pressed") !== "true";
  setAdvanced(next);
  toast(next ? "Advanced — brushes, terrain, the object register and GLB import"
             : "Simple — worlds, blocks and play", 2200);
});


// Reflect live editor state on the deck: `open` = a rail showing, `armed` =
// a tool waiting for a click in the world.
function refreshTools() {
  $("#gen-go").classList.toggle("armed", armedSite);
  if (!$("#gen-go").disabled) $("#gen-go").textContent = armedSite ? "Click to place…" : "Place this site";
  $("#tool-select").classList.toggle("active", !armed && !armedSpawn && !armedGrass && !armedSculpt && !armedSite && !armedRiver);
  $("#tool-blocks").classList.toggle("open", dockOpen());
  $("#tool-blocks").classList.toggle("armed", !!armed);
  $("#btn-grass").classList.toggle("armed", armedGrass);
  $("#btn-spawn").classList.toggle("armed", armedSpawn);
  $("#tool-sculpt").classList.toggle("armed", armedSculpt);
  $("#sculpt-opts").hidden = !armedSculpt;
  $("#tool-river").classList.toggle("armed", armedRiver);
  $("#river-opts").hidden = !armedRiver;
  $("#panel-toggle").classList.toggle("open", panelOpen());
  $("#panel-toggle").setAttribute("aria-pressed", String(panelOpen()));
  $("#game-toggle").classList.toggle("open", railOpen("game"));
  $("#game-toggle").setAttribute("aria-pressed", String(railOpen("game")));
  $("#tool-objects").classList.toggle("open", objectsOpen());
  $("#tool-objects").setAttribute("aria-pressed", String(objectsOpen()));
  // The coach stands down while a rail is up: guidance may never cover the
  // thing it just told you to open.
  document.body.classList.toggle("sheet-open", anyRail());
  syncDeck();
}

/* ── the deck ──
   Two jobs, both of which used to be done by lighting up six separate
   buttons: slide ONE marker under whichever tool is live (so the eye tracks a
   moving object rather than re-reading a row), and morph the middle section
   into whatever that tool needs. `armed` colours the marker amber, because
   "this panel is open" and "your next click lands in the world" must never be
   the same picture. */
function syncDeck() {
  const marker = $("#seg-marker");
  const live = $("#tool-seg .tool.armed") || $("#tool-seg .tool.active");
  if (marker) {
    if (live && live.offsetWidth) {
      marker.style.width = `${live.offsetWidth}px`;
      marker.style.transform = `translateX(${live.offsetLeft}px)`;
      marker.style.opacity = "1";
      marker.classList.toggle("armed", live.classList.contains("armed"));
    } else marker.style.opacity = "0";
  }
  // Contextual middle: at most one of these is ever showing.
  const ctx = { "#grass-opts": armedGrass, "#spawn-hint": armedSpawn, "#blocks-hint": !!armed };
  for (const [sel, on] of Object.entries(ctx)) { const el = $(sel); if (el) el.hidden = !on; }
  if (armed) {
    $("#held-name").textContent = armed.label;
    setHTML($("#blocks-hint .held-thumb"), blockIcon(armed.label));
  }
  const idle = $("#deck-idle");
  if (idle) idle.hidden = armedSculpt || armedGrass || armedSpawn || armedRiver || !!armed;
}

// The camera-mode marker rides the same idiom as the tool marker.
function syncModeMarker() {
  const marker = $("#pill-marker");
  const live = document.querySelector("#explore-pills .pill.active");
  if (!marker || !live) return;
  marker.style.width = `${live.offsetWidth}px`;
  marker.style.transform = `translateX(${live.offsetLeft}px)`;
}

$("#panel-toggle").addEventListener("click", () => setPanel(!panelOpen()));
$("#panel-close").addEventListener("click", () => setPanel(false));
$("#game-toggle").addEventListener("click", () => setRail("game", !railOpen("game")));
$("#game-close").addEventListener("click", () => setRail("game", false));
$("#tool-blocks").addEventListener("click", () => setDock(!dockOpen()));
$("#dock-close").addEventListener("click", () => setDock(false));
$("#tool-objects").addEventListener("click", () => setObjects(!objectsOpen()));
$("#obj-close").addEventListener("click", () => setObjects(false));
// Swapping what is in hand, without putting it down first.
$("#held-change").addEventListener("click", () => setDock(true));
$("#tool-select").addEventListener("click", () => {
  disarmAll();
  toast("Select — click a block, then drag its arrows to move it", 1800);
});
// Touching the world dismisses a phone sheet so it never eats the tap.
canvas.addEventListener("pointerdown", () => {
  if (phone() && anyRail()) setRail(null, false);
});
addEventListener("resize", () => { refreshTools(); syncModeMarker(); });

/* ── the stage ──
   Every piece of chrome stands down and the frame is nothing but the world.
   For a screenshot, for a client in the room, or simply for looking at what
   you built without a console in front of it. */
function setStage(on) {
  document.body.classList.toggle("stage", on);
  if (on) toast("Stage — press \\ to bring the interface back", 2400);
}
addEventListener("keydown", (e) => {
  if (e.code !== "Backslash" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return;
  e.preventDefault();
  setStage(!document.body.classList.contains("stage"));
});

/* ── generate ──
   Composes a whole site from a recipe (js/worldplan.js) and places it through
   the ordinary placement path, as ONE undo entry. Everything it emits is
   procedural and deterministic: same seed + same site → the same village. */
let genKind = "market-hamlet";  // the site the palette will place, when asked
let genPattern = null;
let genRun = 0; // bumped per generate, so repeat presses reroll

/* ── sites ──
   The panel offers the recipes themselves rather than four finished worlds.
   A finished world is a SCENE, and a scene is the one thing this tool should
   not be shipping: it made the editor a gallery you pick from instead of a
   world engine you build with, and the games are where a whole authored place
   belongs. A site is the other thing — a recipe you aim at ground you chose,
   which is a tool. */
const siteCards = $("#site-cards");
for (const [key, kind] of Object.entries(SITE_KINDS)) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = key === genKind ? "active" : "";
  card.dataset.site = key;
  card.title = kind.hint || "";
  setHTML(card, html`<div class="world-name">${kind.label || key}</div>
    <div class="world-meta">${kind.hint || ""}</div>`);
  card.addEventListener("click", () => {
    genKind = key;
    for (const c of siteCards.children) c.classList.toggle("active", c.dataset.site === key);
    $("#gen-hint").textContent = kind.hint || "";
  });
  siteCards.appendChild(card);
}
$("#gen-hint").textContent = SITE_KINDS[genKind].hint || "";

// The site the palette places is sized from its own recipe.
function siteRadius() {
  const rec = SITE_KINDS[genKind];
  return rec.radius(rec.counts.medium ?? 4);
}

/* ── woods ──
   The trees and shrubs the seed's own ground grows (src/genesis/world/planting.js): drawn from the seed, kept off the
   water and off everything already placed, written to params so they save, export and undo with the world. Pressing
   it again on the same world plants the same woods. */
function plantWoods() {
  const before = JSON.parse(JSON.stringify(engine.params.props.scatter || []));
  const keepClear = engine.props.records().map((r) => ({ x: r.position[0], z: r.position[2], r: 14 }));
  const scatter = plantWorld({ params: engine.params, sampler: (x, z) => engine.sampleHeight(x, z), keepClear });
  const apply = (list) => { engine.applyParams({ props: { scatter: list } }); engine.rebuildScatter(); refreshMinimap(); };
  apply(scatter);
  undoStack.push({
    kind: "world",
    subject: `${scatter.length} trees and shrubs`,
    undo: () => apply(before),
    redo: () => apply(scatter),
  });
  announce("Planted", `${scatter.length} trees and shrubs · ⌘Z takes them back`, 3200);
}

async function generateSite(center, opts = {}) {
  const btn = $("#gen-go");
  btn.disabled = true;
  try {
    const plan = makePlan({ kind: opts.kind || genKind, size: opts.size || "medium", pattern: genPattern });
    const sculptBefore = engine.sculptStrokes();
    const out = composeSite({
      plan, center, seed: engine.params.seed,
      sampler: (x, z) => engine.sampleHeight(x, z),
      uidStart: nextUidIndex(engine.props.records()),
      siteIndex: genRun++,
      waterLevel: engine.params.water.level || 0,
      // The world's own biome, which is what the interiors read as climate.
      biome: engine.params.biome,
    });
    if (!out.records.length) {
      toast(out.reason ? `Nothing placed — ${out.reason}` : "Nothing placed here");
      return;
    }
    // Level the ground first, so every placement seats on the finished pad.
    for (const p of out.pads) engine.sculptAt(p.x, p.z, { radius: p.r, amount: p.amount, mode: "flatten" });
    if (out.pads.length) {
      engine.commitSculpt();
      lastField = null;
      refreshMinimap();
    }
    /* Stand every building on the ground it actually covers. Seating samples
       ONE point — the centre — and a house is ten metres wide, so on any real
       slope the corners of the plot end up above the floor and you get the
       hillside indoors. groundBuildings re-seats on the high point and fills
       the gap under it with a footing. */
    const footed = groundBuildings({
      records: out.records, sampler: (x, z) => engine.sampleHeight(x, z),
      uidAt: (i) => makeUid(engine.params.seed, i),
      index: nextUidIndex(engine.props.records()) + out.records.length + 4,
    });
    /* ONE rebuild, not one per building. Every `props.add` announces itself,
       and both listeners on that announcement — the pin cloud and the object
       register — walk EVERY placement in the world. A site that stamps six
       hundred records without this bracket therefore does six hundred full
       walks of a world that is growing under them while they run, which is
       quadratic and is most of the freeze between the click and the town.
       `endBulk` is in a finally, so a placement that throws
       half way through does not leave the world muted. */
    engine.props.beginBulk();
    try {
      for (const rec of footed.records) await engine.props.add(rec);
      for (const rec of footed.footings) await engine.props.add(rec);
    } finally {
      engine.props.endBulk();   // one announcement: pins rebuild once, the register re-reads once
    }
    const placed = footed.records.map((r) => ({ ...engine.props.get(r.uid).record }))
      .concat(footed.footings.map((r) => ({ ...engine.props.get(r.uid).record })));
    const sculptAfter = engine.sculptStrokes();

    undoStack.push({
      kind: "site",
      subject: `${SITE_KINDS[genKind].label} · ${placed.length} blocks`,
      // Taking a site back off is the same size of operation as putting it
      // on, so it gets the same bracket — otherwise ⌘Z on a six-hundred-block
      // town is the slower half of the round trip.
      undo: () => {
        engine.props.beginBulk();
        try { for (const r of placed) engine.props.remove(r.uid); }
        finally { engine.props.endBulk(); }
        engine.sculptRestore(sculptBefore);
        lastField = null; refreshMinimap(); select(null);
      },
      redo: async () => {
        engine.sculptRestore(sculptAfter);
        lastField = null; refreshMinimap();
        engine.props.beginBulk();
        try { for (const r of placed) await engine.props.restore(r); }
        finally { engine.props.endBulk(); }
      },
    });

    select(null);
    // A site is a place, not an object: the ripple goes round the whole
    // footprint and the camera frames the area rather than one hut.
    engine.markers.confirm({
      x: out.center.x, y: engine.sampleHeight(out.center.x, out.center.z),
      z: out.center.z, radius: Math.max(out.radius * 0.5, 6),
    });
    engine.focusOnArea(out.center.x, out.center.z, out.radius);
    // The newest thing in the world is the last building of the site, so
    // "jump to the newest placement" lands somewhere meaningful.
    engine.setNewestProp(placed[placed.length - 1]?.uid || null);
    // A template is one press that fills a place. If what it filled it with
    // is more pins than anybody can read, the cloud stands down — the same
    // call a world build makes, for the same reason.
    pinsOffIfCrowded(`${SITE_KINDS[genKind].label} placed`);
    sound.place(0.9);
    announcePlacement(null);
    announce(SITE_KINDS[genKind].label, `${placed.length} blocks placed · ⌘Z removes the whole site`, 3200);
    console.info("[studio] generated", genKind, "at", out.center, `${placed.length} blocks`);
  } catch (err) {
    toast(`Generate failed: ${err.message}`);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}



// Generate arms placement rather than deciding for you: the ring follows the
// pointer and the site lands where you click.
function armSite(on) {
  if (on) {
    const wasArmed = armedSite;
    if (!wasArmed) disarmAll();
    armedSite = true;
    refreshTools();
    if (!wasArmed) {
      toast(`Click the ground to place the ${SITE_KINDS[genKind].label} — Esc or right-click cancels`);
    }
  } else {
    armedSite = false;
    engine.showSiteRing(null);
    refreshTools();
  }
}
$("#gen-go").addEventListener("click", () => armSite(!armedSite));

/* ── world panel ── */
// Structure themes: procedural re-dressing of every placed block. One click
// re-themes the whole build — no terrain rebuild, no network.
const structureCards = $("#structure-cards");
for (const [key, t] of Object.entries(THEMES)) {
  const card = document.createElement("button");
  card.className = "preset-card";
  card.dataset.theme = key;
  setHTML(card, html`<div class="swatch"></div><div class="name">${t.label}</div>`);
  /* The sample's own colours are DATA, and data does not go in a style
     attribute — the policy forbids inline styles outright. Set through the
     CSSOM it is the same pixel with none of the hole. */
  card.querySelector(".swatch").style.setProperty("--sample", `linear-gradient(118deg, ${t.swatch.join(",")})`);
  card.addEventListener("click", () => engine.setStructureTheme(key));
  structureCards.appendChild(card);
}
engine.on("structure", (name) => {
  syncPanel();
  engine.markSelection([...selection]); // rebuilt objects need fresh hitboxes
  toast(`Structure theme — ${THEMES[name]?.label ?? name}`, 1600);
  console.info("[studio] structure theme:", name);
});
const biomeRows = $("#biome-rows");
for (const [key, pal] of Object.entries(PALETTES)) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "biome-row";
  row.dataset.biome = key;
  setHTML(row, html`<div class="strip">${pal.stops.map(() => html`<i></i>`)}</div><div class="name">${pal.label}</div>`);
  row.querySelectorAll(".strip i").forEach((band, i) => {
    band.style.setProperty("--band", hexToCss(pal.stops[i][1]));
  });
  row.addEventListener("click", () => engine.setBiome(key));
  biomeRows.appendChild(row);
}
/* ── terrain sculpt controls ──
   Direct designer knobs over params.terrain. Rebuilding the world is heavy,
   so sliders commit on release ('change'), not on every tick; the readout
   tracks live. Panel resyncs from params on every world event, so seed
   travel and biome switches keep the sliders honest. */
const pct = (v) => Math.round(v * 100) + "%";
const TERRAIN_CONTROLS = [
  { key: "height", label: "Height", min: 80, max: 800, step: 10, fmt: (v) => v + "m" },
  { key: "seaLevel", label: "Sea level", min: 0, max: 0.7, step: 0.01, fmt: pct },
  { key: "ridged", label: "Ridges", min: 0, max: 1, step: 0.01, fmt: pct },
  { key: "warp", label: "Warp", min: 0, max: 1, step: 0.01, fmt: pct },
  { key: "plateau", label: "Terraces", min: 0, max: 0.8, step: 0.01, fmt: pct },
  { key: "island", label: "Island", min: 0, max: 1, step: 0.01, fmt: pct },
  { key: "frequency", label: "Detail", min: 0.6, max: 3.5, step: 0.05, fmt: (v) => v.toFixed(2) },
];
const terrainRows = $("#terrain-rows");
const terrainInputs = {};
for (const c of TERRAIN_CONTROLS) {
  const row = document.createElement("div");
  row.className = "t-row";
  setHTML(row, html`<label>${c.label}</label><input type="range" min="${c.min}" max="${c.max}" step="${c.step}"><span class="t-val mono"></span>`);
  const input = row.querySelector("input"), val = row.querySelector(".t-val");
  input.addEventListener("input", () => { val.textContent = c.fmt(parseFloat(input.value)); });
  input.addEventListener("change", () => engine.applyParams({ terrain: { [c.key]: parseFloat(input.value) } }));
  terrainInputs[c.key] = { input, val, fmt: c.fmt };
  terrainRows.appendChild(row);
}
const eroRow = document.createElement("div");
eroRow.className = "t-row";
setHTML(eroRow, trust(`<label>Erosion</label><input id="ero-on" type="checkbox" title="Simulate rainfall erosion"><input id="ero-drops" type="range" min="5000" max="100000" step="5000" title="Erosion strength (rain drops)"><span class="t-val mono" id="ero-val"></span>`));
terrainRows.appendChild(eroRow);
const eroCommit = () => engine.applyParams({ terrain: { erosion: {
  enabled: $("#ero-on").checked, drops: parseInt($("#ero-drops").value, 10),
} } });
$("#ero-on").addEventListener("change", eroCommit);
$("#ero-drops").addEventListener("input", () => { $("#ero-val").textContent = Math.round(parseInt($("#ero-drops").value, 10) / 1000) + "k"; });
$("#ero-drops").addEventListener("change", eroCommit);

/* ── scree and the angle of repose ──
   The droplet pass above moves what water CARRIES. It has nothing to say
   about a face that is simply too steep to stand up, because no droplet ever
   lingers on one — it accelerates away and leaves a knife edge with no debris
   under it. Thermal relaxation is the other half: every cell holding more
   than `talus` over a neighbour sheds it downhill until the pile reaches its
   angle of repose. engine/terrain/erosion.js has the argument, including why
   this is a terrain knob and not a post-hoc repair pass for the slopes
   tools/walk-world.mjs rejects.

   `rate` is deliberately absent. It is clamped to MAX_THERMAL_RATE and above
   roughly 0.65 the relaxation ripples the ground steeper before it settles —
   a stability constant, not a taste knob, and the failure is invisible in a
   still frame.

   TALUS IS SHOWN IN DEGREES because that is the number a person can picture.
   It is stored as rise over run — `over = h − neighbour − talus · cell · d`
   — so the angle is a plain arctangent, and the shipped default of 0.8 is
   the 39° the erosion module's own comment quotes. */
const DEFAULT_TALUS_UI = 0.8;
const talusDeg = (t) => Math.round((Math.atan(t) * 180) / Math.PI) + "°";

const screeRow = document.createElement("div");
screeRow.className = "t-row";
/* The slider starts at 4 rather than 0, mirroring `#ero-drops`, which starts
   at five thousand drops for the same reason: the CHECKBOX owns off. A range
   that can reach zero while the box beside it is ticked is a control saying
   two different things about the same fact. */
setHTML(screeRow, trust(`<label>Scree</label><input id="thm-on" type="checkbox" title="Let slopes past their angle of repose shed rock, and pile it up below"><input id="thm-iters" type="range" min="4" max="40" step="2" value="12" title="Relaxation passes — how far the slopes are allowed to settle"><span class="t-val mono" id="thm-val">12</span>`));
terrainRows.appendChild(screeRow);

const talusRow = document.createElement("div");
talusRow.className = "t-row";
setHTML(talusRow, trust(`<label>Talus</label><input id="thm-talus" type="range" min="0.3" max="1.5" step="0.05" value="0.8" title="The angle of repose — the steepest grade the ground is allowed to hold"><span class="t-val mono" id="thm-talus-val">39°</span>`));
terrainRows.appendChild(talusRow);

const thermalCommit = () => {
  const on = $("#thm-on").checked;
  const patch = { terrain: { erosion: { thermal: {
    iterations: on ? parseInt($("#thm-iters").value, 10) : 0,
    talus: parseFloat($("#thm-talus").value),
  } } } };
  /* SCREE IMPLIES THE PASS THAT CARRIES IT. thermal() is called from the end
     of erode() (engine/terrain/erosion.js), and bakeErodedField returns before
     erode() ever runs when `erosion.enabled` is false — so asking for scree on
     a world with no erosion pass is asking for a pass that does not happen.
     Rather than leave the tick silently inert, it turns the pass on with it;
     syncTerrainPanel then lights the Erosion box above, so the implication is
     something the panel SHOWS rather than something it does behind you. */
  if (on && !engine.params.terrain.erosion.enabled) patch.terrain.erosion.enabled = true;
  engine.applyParams(patch);
  syncTerrainPanel();
};
$("#thm-on").addEventListener("change", thermalCommit);
$("#thm-iters").addEventListener("input", () => { $("#thm-val").textContent = $("#thm-iters").value; });
$("#thm-iters").addEventListener("change", thermalCommit);
$("#thm-talus").addEventListener("input", () => { $("#thm-talus-val").textContent = talusDeg(parseFloat($("#thm-talus").value)); });
$("#thm-talus").addEventListener("change", thermalCommit);

/* ══ SHAPE — the noise stack, as an authoring surface ════════════════════════
   `params.terrain.stack` has been reachable only by writing JSON since it
   landed. This is the panel: add a layer, choose what it is and how it
   blends, move it in the order, open it for its own knobs.

   THE DEFAULT IS THE RECIPE, and starting a stack must not change the world.
   "Use layers" seeds the list with a single `legacy` layer, which IS the
   recipe the ten sliders above drive — so the first click is visually a
   no-op and everything after it is additive. The alternative (start empty,
   or start with a fractal) throws the author's world away to open a panel.

   Every commit goes through applyParams, like the terrain sliders, and like
   them it is not an undo entry: the undo stack is authored CONTENT (see the
   commands above), and params are the world's description rather than
   something placed in it. ⌘Z after a slider has never meant "put that number
   back", and a stack is a slider with more shape. */
const stackRows = $("#stack-rows");
const stackAdd = $("#stack-add");
const stackHint = $("#stack-hint");

const currentStack = () => engine.params.terrain?.stack || null;

/* Layers are held as plain data and written back whole. Read-modify-write of
   the live params object would mutate the world the engine is standing on
   before applyParams was told anything about it. */
function commitStack(layers) {
  const next = layers && layers.length ? { version: 1, layers } : null;
  engine.applyParams({ terrain: { stack: next } });
  buildStackPanel();
  toast(next ? `Shape · ${layers.length} layer${layers.length === 1 ? "" : "s"}` : "Shape · back to the terrain recipe", 1800);
}

function stackLayers() {
  const s = currentStack();
  return s ? s.layers.map((l) => JSON.parse(JSON.stringify(l))) : [];
}

function buildStackPanel() {
  const layers = stackLayers();
  setHTML(stackRows, EMPTY);
  setHTML(stackAdd, EMPTY);

  if (!layers.length) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "chz";
    setHTML(go, html`Use layers`);
    go.title = "Start from the terrain recipe as a single layer, then build on it";
    go.addEventListener("click", () => commitStack([makeLayer("legacy", { blend: "replace" })]));
    stackAdd.appendChild(go);
    stackHint.textContent = "The ground follows the Terrain sliders above. Layers let it be something the sliders cannot describe — craters, cracked flats, a canyon.";
    return;
  }

  layers.forEach((layer, i) => {
    const def = getNoiseType(layer.type);
    const row = document.createElement("div");
    row.className = "t-row stack-layer";
    /* Every label here is a repo literal, but it goes through `html` anyway:
       the rule this file follows is that markup is built from Markup values,
       and an exception "because this one is safe" is how the next one gets
       written unsafely. */
    setHTML(row, html`
      <input type="checkbox" class="st-on" title="Include this layer">
      <label class="st-name">${def ? def.label : layer.type}</label>
      <select class="st-blend" title="How this layer combines with the layers under it"></select>
      <input type="range" class="st-str" min="0" max="1.5" step="0.01" value="${layer.strength ?? 1}" title="Strength">
      <button type="button" class="icon-btn st-up" aria-label="Move up">↑</button>
      <button type="button" class="icon-btn st-del" aria-label="Remove layer">×</button>`);

    // Set as a PROPERTY rather than interpolated into the markup: `html`
    // escapes what it interpolates, which is right for text and wrong for an
    // attribute name — "checked" would be arriving as data pretending to be
    // syntax, which is the exact shape of the thing trusted.js exists to stop.
    row.querySelector(".st-on").checked = layer.enabled !== false;

    const blendSel = row.querySelector(".st-blend");
    for (const mode of BLEND_MODES) {
      const opt = document.createElement("option");
      opt.value = mode;
      opt.textContent = mode;
      if (mode === layer.blend) opt.selected = true;
      blendSel.appendChild(opt);
    }
    // A modifier changes what the layers after it see; it has nothing to
    // blend, so offering a blend mode for one would be a control wired to
    // nothing (see the registry's `kind`).
    if (def?.kind === "modifier") { blendSel.disabled = true; blendSel.title = "Modifiers change what the layers below them sample — they do not blend"; }

    row.querySelector(".st-on").addEventListener("change", (e) => {
      layers[i].enabled = e.target.checked;
      commitStack(layers);
    });
    blendSel.addEventListener("change", () => { layers[i].blend = blendSel.value; commitStack(layers); });
    const str = row.querySelector(".st-str");
    str.addEventListener("change", () => { layers[i].strength = parseFloat(str.value); commitStack(layers); });
    row.querySelector(".st-up").addEventListener("click", () => {
      if (i === 0) return;
      const next = layers.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      commitStack(next);
    });
    row.querySelector(".st-del").addEventListener("click", () => commitStack(layers.filter((_, k) => k !== i)));
    row.querySelector(".st-up").disabled = i === 0;
    stackRows.appendChild(row);

    // The type's own knobs, straight off the registry — so a type that gains
    // a parameter gains its control here with no edit to this file.
    for (const c of def?.controls || []) {
      const sub = document.createElement("div");
      sub.className = "t-row stack-param";
      const value = layer.params?.[c.key] ?? def.defaults[c.key];
      setHTML(sub, html`<label>${c.label}</label>
        <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${value}">
        <span class="t-val mono"></span>`);
      const input = sub.querySelector("input"), val = sub.querySelector(".t-val");
      const show = (v) => { val.textContent = c.choices ? c.choices[Math.round(v) - c.min] : String(Math.round(v * 100) / 100); };
      show(value);
      input.addEventListener("input", () => show(parseFloat(input.value)));
      input.addEventListener("change", () => {
        layers[i].params = { ...layers[i].params, [c.key]: parseFloat(input.value) };
        commitStack(layers);
      });
      stackRows.appendChild(sub);
    }
  });

  // Add-a-layer, and the way back to the recipe.
  const sel = document.createElement("select");
  sel.className = "st-addsel";
  sel.title = "Add a layer";
  const head = document.createElement("option");
  head.value = "";
  head.textContent = layers.length >= MAX_LAYERS ? `full (${MAX_LAYERS} layers)` : "add a layer…";
  sel.appendChild(head);
  for (const def of NOISE_TYPES) {
    const opt = document.createElement("option");
    opt.value = def.id;
    opt.textContent = def.label;
    opt.title = def.about;
    sel.appendChild(opt);
  }
  sel.disabled = layers.length >= MAX_LAYERS;
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    commitStack([...layers, makeLayer(sel.value, { seedOffset: layers.length })]);
  });
  stackAdd.appendChild(sel);

  const off = document.createElement("button");
  off.type = "button";
  off.className = "chz";
  setHTML(off, html`Recipe`);
  off.title = "Drop the layers and go back to the ground the Terrain sliders describe";
  off.addEventListener("click", () => commitStack([]));
  stackAdd.appendChild(off);

  const active = layers.filter((l) => l.enabled !== false).length;
  stackHint.textContent = `${active} of ${layers.length} layers active. Order is bottom-up: each blends into what the ones above it built. Sea level, the coastline falloff and the vertical scale still run underneath.`;
}

/* ══ CLIMATE — which biomes this world's ground may be ═══════════════════════
   The primary biome (the Biome section at the top) still owns the water, the
   sky, the fog and the materials, and it is always the head of the list —
   which is also what the field is centred on, so the world reads as itself.
   These chips are the OTHERS it may drift toward. */
const climateChips = $("#climate-chips");
const climateHint = $("#climate-hint");

function commitClimate(others) {
  const next = others.length ? { biomes: [engine.params.biome, ...others], scale: 1 } : null;
  engine.applyParams({ climate: next });
  buildClimatePanel();
}

function buildClimatePanel() {
  const primary = engine.params.biome;
  const listed = (engine.params.climate?.biomes || []).filter((b) => b !== primary);
  setHTML(climateChips, EMPTY);

  for (const [name, pal] of Object.entries(PALETTES)) {
    if (name === primary) continue;
    const on = listed.includes(name);
    const b = document.createElement("button");
    b.type = "button";
    b.className = on ? "chz active" : "chz";
    setHTML(b, html`${pal.label}`);
    b.addEventListener("click", () => {
      commitClimate(on ? listed.filter((n) => n !== name) : [...listed, name]);
    });
    climateChips.appendChild(b);
  }

  if (!listed.length) {
    climateHint.textContent = `One biome everywhere: this world is ${PALETTES[primary]?.label || primary} from the waterline to the last hill. Pick another and the ground drifts toward it where the climate does.`;
    return;
  }
  /* What the engine actually accepted, not what was clicked. Two biomes
     closer than MIN_ANCHOR_SEPARATION in climate space cannot read as two
     places, so climate.js drops the later one — and a panel that showed the
     click rather than the outcome would be a panel that lies. */
  const field = createBiomeField(engine.params, (n) => PALETTES[n]?.climate);
  if (!field) {
    climateHint.textContent = "Too alike to be two places — every pick so far names the same climate as this world's own biome. Try one further from it.";
    return;
  }
  const kept = field.names.map((n) => PALETTES[n]?.label || n).join(" · ");
  const lost = field.dropped.map((d) => `${PALETTES[d.name]?.label || d.name} (${d.reason})`);
  climateHint.textContent = lost.length ? `${kept}. Not used: ${lost.join("; ")}.` : `${kept}. The border falls where the climate does — a different place on every seed.`;
}

/* ── flood level ──
   Deliberately NOT a terrain control. Every slider above rebuilds the world
   through applyParams; this one calls setFloodLevel, which moves the water
   over the land as it stands and leaves the heightfield alone. So a flood can
   be swept up to see what drowns and back down again, non-destructively —
   whereas terrain.seaLevel above regenerates different terrain entirely. */
const floodRow = document.createElement("div");
floodRow.className = "t-row";
setHTML(floodRow, trust(`<label>Flood</label><input id="flood-level" type="range" min="0" max="200" step="1" value="0" title="Raise the waterline over the terrain as it stands"><span class="t-val mono" id="flood-val">0m</span>`));
terrainRows.appendChild(floodRow);
// Commit on release, like the terrain sliders: each change re-runs the
// sea-connected flood over the whole grid, and the readout tracks live.
$("#flood-level").addEventListener("input", () => { $("#flood-val").textContent = $("#flood-level").value + "m"; });
$("#flood-level").addEventListener("change", () => engine.setFloodLevel(parseFloat($("#flood-level").value)));

/* ── vegetation ──
   Unity's Terrain Settings, surfaced 1:1: Tree & Detail Objects (draw
   distance, density scale) and Wind Settings for Grass (speed, ripple size,
   bending). None of these rebuild the world — wind and distance are live
   uniform updates, density re-places only the grass field — so every slider
   commits on 'input' and feels like dragging Unity's own inspector. */
const VEG_CONTROLS = [
  { key: "detailDistance", label: "Draw dist", min: 40, max: 1000, step: 10, fmt: (v) => v + "m" },
  { key: "detailDensityScale", label: "Density scale", min: 0.2, max: 1, step: 0.05, fmt: pct },
  { key: "speed", wind: true, label: "Wind speed", min: 0, max: 1, step: 0.01, fmt: pct },
  { key: "size", wind: true, label: "Ripples", min: 0, max: 1, step: 0.01, fmt: pct },
  { key: "bending", wind: true, label: "Bending", min: 0, max: 1, step: 0.01, fmt: pct },
];
const vegRows = $("#veg-rows");
const vegInputs = [];
for (const c of VEG_CONTROLS) {
  const row = document.createElement("div");
  row.className = "t-row";
  setHTML(row, html`<label>${c.label}</label><input type="range" min="${c.min}" max="${c.max}" step="${c.step}"><span class="t-val mono"></span>`);
  const input = row.querySelector("input"), val = row.querySelector(".t-val");
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    val.textContent = c.fmt(v);
    engine.setGrassSettings(c.wind ? { wind: { [c.key]: v } } : { [c.key]: v });
  });
  vegInputs.push({ c, input, val });
  vegRows.appendChild(row);
}

function syncVegPanel() {
  const g = resolveDetail(engine.params, engine.palette);
  for (const { c, input, val } of vegInputs) {
    const v = c.wind ? g.wind[c.key] : g[c.key];
    input.value = v;
    val.textContent = c.fmt(v);
  }
}


function syncTerrainPanel() {
  const t = engine.params.terrain;
  for (const [k, o] of Object.entries(terrainInputs)) { o.input.value = t[k]; o.val.textContent = o.fmt(t[k]); }
  $("#ero-on").checked = t.erosion.enabled;
  $("#ero-drops").value = t.erosion.drops;
  $("#ero-val").textContent = Math.round(t.erosion.drops / 1000) + "k";
  /* Zero iterations IS off, so the count is not written back when it is zero:
     the slider goes on holding the number the visitor last chose, ready for
     the tick to turn it back on. Same reason `#ero-drops` never shows a zero
     — there, `drops` is a separate field and cannot; here the off-switch and
     the amount are one number, and the panel has to keep them apart. */
  const th = t.erosion.thermal || {};
  const iters = Math.max(0, Math.floor(th.iterations || 0));
  $("#thm-on").checked = iters > 0;
  if (iters > 0) $("#thm-iters").value = iters;
  $("#thm-val").textContent = $("#thm-iters").value;
  $("#thm-talus").value = Number.isFinite(th.talus) ? th.talus : DEFAULT_TALUS_UI;
  $("#thm-talus-val").textContent = talusDeg(parseFloat($("#thm-talus").value));
  const lvl = engine.params.water.level || 0;
  $("#flood-level").value = lvl;
  $("#flood-val").textContent = lvl + "m";
}

function syncPanel() {
  const themeNow = engine.params.structure?.theme || "neutral";
  for (const c of structureCards.children) c.classList.toggle("active", c.dataset.theme === themeNow);
  for (const r of biomeRows.children) r.classList.toggle("active", r.dataset.biome === engine.params.biome);
  tod.value = engine.params.sky.timeOfDay;
  todReadout();
  haze.value = engine.params.fog.density;
  $("#haze-val").textContent = Math.round(engine.params.fog.density * 100) + "%";
  syncWeatherPills();
  syncTerrainPanel();
  syncVegPanel();
  // Both are rebuilt rather than updated in place: each is a handful of rows
  // whose SHAPE depends on the params (how many layers, of what type, which
  // biome is primary), so there is nothing an update could hold onto.
  buildStackPanel();
  buildClimatePanel();
}

/* ── weather ── */
function syncWeatherPills() {
  const now = engine.params.sky.weather || "clear";
  for (const b of document.querySelectorAll("#weather-pills button")) {
    b.classList.toggle("active", b.dataset.weather === now);
  }
}
for (const b of document.querySelectorAll("#weather-pills button")) {
  b.addEventListener("click", () => engine.setWeather(b.dataset.weather));
}
engine.on("weather", syncWeatherPills);
const tod = $("#tod-slider");
function todReadout() {
  const t = parseFloat(tod.value);
  const h = Math.floor(t), m = Math.floor((t - h) * 60);
  $("#tod-readout").textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
tod.addEventListener("input", () => {
  engine.setTimeOfDay(parseFloat(tod.value));
  todReadout();
});

/* ── haze ──
   Live, unlike the terrain sliders: changing the air costs a uniform update,
   not a world rebuild, so it can track the drag. */
const haze = $("#haze-slider");
haze.addEventListener("input", () => {
  const v = parseFloat(haze.value);
  engine.setFog(v);
  $("#haze-val").textContent = Math.round(v * 100) + "%";
});

/* ── explore pills ── */
for (const pill of document.querySelectorAll("#explore-pills .pill")) {
  pill.addEventListener("click", () => engine.setMode(pill.dataset.mode));
}
engine.on("mode", (mode) => {
  for (const pill of document.querySelectorAll("#explore-pills .pill")) {
    pill.classList.toggle("active", pill.dataset.mode === mode);
  }
  // The body class drives the chrome: walking or flying clears the editing
  // furniture so the world is unobstructed (and the touch pads have room).
  document.body.classList.remove("mode-orbit", "mode-walk", "mode-fly");
  document.body.classList.add(`mode-${mode}`);
  // The deck reflows when the tool segment hides, so both markers re-measure.
  requestAnimationFrame(() => { syncModeMarker(); syncDeck(); });
  if (mode !== "orbit") { disarmAll(); select(null); }
});

/* ── minimap ── */
const minimap = new Minimap($("#minimap"), { onTravel: (x, z) => engine.travelTo(x, z) });
engine.on("frame", () => {
  const v = engine.getViewer();
  minimap.setMarker(v.x, v.z, v.yaw);
});
function refreshMinimap() {
  minimap.redraw({
    sampler: (x, z) => engine.sampleHeight(x, z),
    params: engine.params, palette: engine.palette,
    flood: engine.water.flood, // so a landlocked hollow reads dry on the map too
  });
}

/* ── world change plumbing ── */
engine.on("world", () => {
  lastField = null; spawnInfo = null;
  // An authored spawn belongs to one seed+biome; travelling voids it.
  if (spawnTag && spawnTag !== worldTag()) {
    customSpawn = null; spawnTag = null;
    engine.markSpawn(null);
  }
  minimap.setRings(null);
  showSeed(); syncPanel(); refreshMinimap();
  // A terrain slider or a rolled seed is a change to the world with no undo
  // entry behind it, so Reset has to hear about it here as well as from the
  // stack's own sync.
  refreshReset();
  // Placements survive a new world but their ground does not — Props.setSampler
  // re-seats every one of them and announces it, so the register, the pins and
  // the markers all follow without this having to know they exist.
  console.info("[studio] world:", engine.params.seed, engine.params.biome, "theme:", engine.params.structure?.theme);
});

/* …and the ground itself, on the engine's own signal rather than on the undo
   stack's. The brush pushes a history entry, so the stack would have caught
   the ordinary case — but the site composer flattens its building pads
   through the same API, and anything driving the engine directly changes the
   world with no entry behind it. This is the one event every sculpt reaches,
   whatever moved it. */
engine.on("sculpt", refreshReset);
engine.on("seed", () => showSeed());
// The map paints its own water from params.water.level, so it has to redraw
// when the flood moves — the viewport's plane and the map must not disagree.
engine.on("flood", ({ level }) => {
  refreshMinimap();
  toast(level > 0 ? `Flood — ${level}m above the coastline` : "Flood — back to the natural coastline", 1600);
});
engine.on("erosion", ({ field }) => {
  // The eroded field is the BASE surface; if the world has been sculpted it
  // is not what Play and Export must bake from, so force a fresh bake.
  lastField = engine.sculptStrokes().length ? null : field;
  refreshMinimap();
  const settlements = scoreSettlements(field, engine.params);
  spawnInfo = deriveSpawn(settlements, engine.params, { field, override: customSpawn });
  minimap.setRings(spawnInfo.rings.map((r) => ({ x: spawnInfo.x, z: spawnInfo.z, r: r.r })));
});

function ensureField() {
  if (!lastField) lastField = bakeHeightField(engine.params, CANONICAL_RES, (x, z) => engine.sampleHeight(x, z));
  return lastField;
}

/* ── the block console ── */
let armed = null;    // registry item armed for placement
let selection = [];  // uids of selected placements (Shift-click adds)
const cardsEl = $("#dock-cards");
let activeCat = "all";

const catsEl = $("#dock-cats");
for (const cat of CATEGORIES) {
  const b = document.createElement("button");
  b.className = "cat-chip" + (cat === "all" ? " active" : "");
  b.textContent = cat;
  b.addEventListener("click", () => {
    activeCat = cat;
    for (const c of catsEl.children) c.classList.toggle("active", c.textContent === cat);
    renderCards();
  });
  catsEl.appendChild(b);
}
$("#dock-search").addEventListener("input", renderCards);

function makeCard(item) {
  const card = document.createElement("button");
  card.className = "block-card" + (armed?.id === item.id ? " armed" : "");
  card.title = item.label;
  // Drawn glyphs, not emoji: one hand, one grid, currentColor (icons.js).
  // The LABEL is not ours — an imported GLB brings its own filename — so it
  // goes through the markup gate like every other piece of outside text.
  setHTML(card, html`<div class="thumb">${blockIcon(item.label)}</div><div class="label">${item.label}</div>`);
  card.addEventListener("click", () => {
    const next = armed?.id === item.id ? null : item;
    disarmAll();
    armed = next;
    renderCards();
    // The catalogue has done its job the moment a block is in hand, and
    // what you need next is the GROUND. Holding one closes the sheet; the
    // deck says what you are carrying and Change brings the sheet back.
    if (armed) setDock(false);
    refreshTools();
    if (armed) {
      toast(`Holding ${item.label} — click the ground to place it, Esc cancels`);
      // The held ghost follows the pointer; if the GLB is still streaming,
      // placement works anyway (add() has its own fallback).
      engine.showGhost({
        ref: `${item.pack}/${item.id}`, url: item.url || null, proc: item.proc || null,
        fit: item.size || null,
        label: item.label, rotationY: 0, scale: 1, autoFit: !item.proc, position: [0, 0, 0],
      }).catch((err) => console.warn("[studio] ghost unavailable:", err.message));
    }
  });
  return card;
}

function renderCards() {
  const q = $("#dock-search").value.trim().toLowerCase();
  setHTML(cardsEl, EMPTY);
  const match = (item) =>
    (activeCat === "all" || item.category === activeCat) &&
    (!q || item.label.toLowerCase().includes(q) || item.category.includes(q));

  // The whole set, unfiltered, is grouped by family with a header per group
  // — fifty-one parts in one undifferentiated grid is a drawer, not a
  // console. A search or a chosen tab is already a grouping, so those views
  // stay flat rather than repeating themselves.
  if (activeCat === "all" && !q) {
    for (const cat of CATEGORIES) {
      if (cat === "all") continue;
      const items = allItems().filter((i) => i.category === cat);
      if (!items.length) continue;
      const head = document.createElement("div");
      head.className = "dock-group";
      setHTML(head, html`<span>${cat}</span><span class="n">${items.length}</span>`);
      cardsEl.appendChild(head);
      for (const item of items) cardsEl.appendChild(makeCard(item));
    }
  } else {
    for (const item of allItems()) if (match(item)) cardsEl.appendChild(makeCard(item));
  }
  if (!cardsEl.children.length) {
    setHTML(cardsEl, html`<div class="empty">Nothing matches — try another name, or clear the search.</div>`);
  }
  // The console's own count, in its head. A catalogue that says how much of
  // itself you are looking at is a console; one that does not is a drawer.
  const shown = cardsEl.querySelectorAll(".block-card").length;
  const total = allItems().length;
  $("#dock-count").textContent = shown === total ? `${total} parts` : `${shown} / ${total}`;
}
renderCards();

/* ── placement + selection on the viewport ── */
let downAt = null;
let dragTravel = 0;      // pixels the pointer has covered since it went down
let lastMove = [0, 0];
let paintStroke = null;  // grass brush stroke in progress
let sculptStroke = null; // terrain brush stroke in progress

// Grass brush: paints a patch wherever the stroke has travelled far enough
// from the last one (so density comes from the dev's hand, not a timer);
// with Shift held the stroke erases patches instead.
function grassBrush(e) {
  const p = engine.raycastGround((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (!p) return;
  if (paintStroke.erase) {
    const gone = engine.removeGrassPatchNear(p.x, p.z);
    if (gone) {
      paintStroke.removed.push(gone);
      toast(`Grass erased — ${engine.grassPatchCount()} patches left`, 1000);
    }
    return;
  }
  const brushR = parseFloat($("#grass-radius").value) || 9;
  if (paintStroke.last && Math.hypot(p.x - paintStroke.last.x, p.z - paintStroke.last.z) < brushR * 0.8) return;
  paintStroke.last = { x: p.x, z: p.z };
  paintStroke.added.push(engine.addGrassPatch(p.x, p.z, {
    r: brushR, n: parseInt($("#grass-density").value, 10) || 110,
  }));
  if (engine.grassFull()) {
    if (!paintStroke.warned) { paintStroke.warned = true; toast("Grass budget reached — erase some (Shift-drag) before painting more"); }
  } else toast(`Grass: ${engine.grassPatchCount()} patches`, 900);
}

// Everything below is LEFT button only: placement, painting and selection
// never fire from a right or middle click, and never while the pointer is on
// the move gizmo (the gizmo owns its own drags).
// Terrain brush: dabs along the drag, then one rebuild + one history entry
// when the stroke ends. Alt inverts raise/lower, matching every other
// sculpting tool people have used.
function sculptBrush(e) {
  const p = engine.raycastGround((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (!p) return;
  if (sculptStroke.last && Math.hypot(p.x - sculptStroke.last.x, p.z - sculptStroke.last.z) < brush.radius * 0.22) return;
  sculptStroke.last = { x: p.x, z: p.z };
  let mode = brush.mode;
  if (sculptStroke.invert) mode = mode === "raise" ? "lower" : mode === "lower" ? "raise" : mode;
  engine.sculptAt(p.x, p.z, { radius: brush.radius, amount: brush.strength, mode });
  sculptStroke.dabs++;
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || engine.gizmoBusy()) return;
  downAt = [e.clientX, e.clientY, performance.now()];
  // Re-anchor the travel base here, or the first move after the press counts
  // the distance from wherever the pointer last was before it.
  dragTravel = 0;
  lastMove = [e.clientX, e.clientY];
  if (engine.mode !== "orbit") return;
  /* AIMING AT A MOVING PICTURE IS NOT AIMING. The camera eases in after a
     placement, and the second post of a fence would otherwise be aimed at
     ground that is still sliding. A click with a tool in hand stops the
     camera dead — the same rule that already lets a drag on the controls
     cancel a flight, applied to the other hand. */
  if (armed || armedSite || armedSpawn || armedGrass || armedSculpt || armedRiver) engine.cancelFlight();
  if (armedGrass) {
    paintStroke = { erase: e.shiftKey, last: null, warned: false, added: [], removed: [] };
    engine.controllers.orbit.controls.enabled = false; // camera holds still while painting
    canvas.setPointerCapture(e.pointerId);
    grassBrush(e);
  } else if (armedSculpt) {
    sculptStroke = { last: null, dabs: 0, invert: e.altKey, before: engine.sculptStrokes() };
    engine.controllers.orbit.controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
    sculptBrush(e);
  }
});
canvas.addEventListener("pointermove", (e) => {
  /* How far the pointer has actually TRAVELLED since it went down — measured
     rather than inferred from a stopwatch. See the drag test in pointerup. */
  if (downAt) {
    dragTravel += Math.hypot(e.clientX - lastMove[0], e.clientY - lastMove[1]);
  }
  lastMove = [e.clientX, e.clientY];
  if (paintStroke) { grassBrush(e); return; }
  if (sculptStroke) { sculptBrush(e); return; }
  // The solved course rides the pointer: where THIS water would go.
  if (armedRiver && engine.mode === "orbit" && !downAt) {
    riverHover(e);
    return;
  }
  // The site footprint rides the pointer, so you can see what you'll cover.
  if (armedSite && engine.mode === "orbit") {
    const p = engine.raycastGround((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (p) engine.showSiteRing(p.x, p.z, siteRadius());
    return;
  }
  // The held block rides the pointer, snapped and stacked exactly as it
  // will land — including on top of blocks already placed.
  if (armed && engine.mode === "orbit") {
    const hit = engine.raycastPlacement((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (hit) engine.moveGhost(hit.point);
  }
});
// Right-click while holding a block puts it back.
canvas.addEventListener("contextmenu", (e) => {
  if (!armed && !armedSite && !armedRiver) return;
  e.preventDefault();
  disarmAll();
  toast("Placement cancelled");
});
/* A CANCELLED GESTURE IS NOT A FINISHED ONE, and until now only the finished
   one let go. The browser cancels a pointer whenever it takes the gesture for
   itself — a system edge swipe, a context menu, a lost capture, a second
   finger arriving — and no `pointercancel` handler existed on the canvas. What
   was left behind was the latch: `paintStroke` still open so the next move
   kept painting, and orbit's controls still disabled, so the camera stayed
   frozen with nothing on screen to say why. The only way out was to press and
   release once more, which is a thing a person has to guess.

   It releases the latches and deliberately does NOT commit: a stroke the
   browser took away was not finished, so it earns no undo entry. */
canvas.addEventListener("pointercancel", () => {
  paintStroke = null;
  downAt = null;
  dragTravel = 0;
  engine.controllers.orbit.controls.enabled = true;
});

canvas.addEventListener("pointerup", async (e) => {
  if (paintStroke) {
    const { added, removed } = paintStroke;
    paintStroke = null;
    engine.controllers.orbit.controls.enabled = true;
    downAt = null; dragTravel = 0;
    if (added.length || removed.length) {
      undoStack.push({
        kind: added.length ? "grass" : "ungrass",
        subject: `${added.length || removed.length} grass patch${(added.length || removed.length) === 1 ? "" : "es"}`,
        undo: () => { for (const p of added) engine.removeGrassPatchNear(p.x, p.z, 0.6); for (const p of removed) engine.addGrassPatch(p.x, p.z, p); },
        redo: () => { for (const p of removed) engine.removeGrassPatchNear(p.x, p.z, 0.6); for (const p of added) engine.addGrassPatch(p.x, p.z, p); },
      });
    }
    return;
  }
  if (sculptStroke) {
    const { dabs, before } = sculptStroke;
    sculptStroke = null;
    engine.controllers.orbit.controls.enabled = true;
    downAt = null; dragTravel = 0;
    if (dabs) {
      // One commit for the whole stroke: water depth, grass and spawn all
      // re-seat once, not per dab.
      engine.commitSculpt();
      lastField = null; // the export/play bake must be redone from the new ground
      refreshMinimap();
      const after = engine.sculptStrokes();
      undoStack.push({
        kind: "sculpt", subject: `the ground (${brush.mode})`,
        undo: () => { engine.sculptRestore(before); lastField = null; refreshMinimap(); },
        redo: () => { engine.sculptRestore(after); lastField = null; refreshMinimap(); },
      });
    }
    return;
  }
  if (e.button !== 0 || engine.gizmoBusy()) return;
  if (!downAt || engine.mode !== "orbit") return;
  const [x0, y0, t0] = downAt; downAt = null;
  /* WAS IT A DRAG? Measured in pixels, not in milliseconds.
     This used to also reject any press held longer than 400 ms, and that
     clock is the wrong instrument: on a software renderer or an old laptop —
     a school Chromebook is a target for this tool — one frame can take a
     third of a second, so an ordinary click arrives "late" and the placement
     is thrown away in silence. Nothing on screen changes and the block is
     still in hand, which is the exact "did it place?" this redesign exists to
     abolish, arriving from the one direction no amount of feedback can fix.
     Travel answers the real question: a press that went nowhere is a click,
     however long it took, and a press that went somewhere and came back is
     still a drag even though its endpoints agree. The generous time cap that
     remains is only there so a pointer held down for a minute and released is
     not read as a placement. */
  if (Math.hypot(e.clientX - x0, e.clientY - y0) > 6 || dragTravel > 14 ||
      performance.now() - t0 > 4000) return;
  const ndcX = (e.clientX / innerWidth) * 2 - 1, ndcY = -(e.clientY / innerHeight) * 2 + 1;

  if (armedRiver) {
    const point = engine.raycastGround(ndcX, ndcY);
    if (!point) return toast("Nothing to carve — aim the river at the ground", 2000);
    await carveRiver(point);
    // The tool stays armed, like the brushes: rivers come in systems.
    return;
  }
  if (armedSite) {
    const point = engine.raycastGround(ndcX, ndcY);
    if (!point) return toast("Nothing to build on — aim the site at the ground", 2000);
    armSite(false);
    await generateSite({ x: point.x, z: point.z });
    return;
  }
  if (armedSpawn) {
    const point = engine.raycastGround(ndcX, ndcY);
    if (!point) return toast("Aim at the ground to set the spawn point", 2000);
    const prev = customSpawn ? { ...customSpawn } : null;
    const next = { x: point.x, z: point.z };
    const applySpawn = (s) => {
      customSpawn = s;
      spawnTag = s ? worldTag() : null;
      engine.markSpawn(s ? s.x : null, s ? s.z : undefined);
      minimap.setRings(s ? deriveSpawn([], engine.params, { override: s }).rings.map((r) => ({ x: s.x, z: s.z, r: r.r })) : null);
    };
    undoStack.push({ kind: "spawn", subject: "", undo: () => applySpawn(prev), redo: () => applySpawn(next) });
    customSpawn = next;
    spawnTag = worldTag();
    engine.markSpawn(point.x, point.z);
    const rings = deriveSpawn([], engine.params, { override: customSpawn }).rings;
    minimap.setRings(rings.map((r) => ({ x: point.x, z: point.z, r: r.r })));
    armedSpawn = false;
    game.render();   // the Game panel names where the mission stands
    refreshTools();
    const wet = engine.sampleHeight(point.x, point.z) < 0;
    toast(wet ? "Spawn set — in water, you'll swim" : "Spawn set — Play drops you here");
    console.info("[studio] spawn authored at", point.x.toFixed(1), point.z.toFixed(1));
    return;
  }
  if (armed) {
    const hit = engine.raycastPlacement(ndcX, ndcY);
    /* A click past the horizon used to do nothing AT ALL — no block, no
       word, and a held tool that looked identical either way. "Did it
       place?" has exactly one honest answer here and it is "no, and here is
       why", because silence is the failure this redesign is about. */
    if (!hit) return toast(`Nothing to place ${armed.label} on — aim at the ground`, 2000);
    const point = hit.point;
    const item = armed;
    /* THE HAND STAYS LOADED. It used to empty on every click, and the block
       sheet used to stay open behind it, so placing ten fence posts was ten
       trips back to the catalogue — bearable only because the catalogue was
       already covering the world you were building in. Now that the sheet
       closes on arming, one-block-per-click would be three actions per
       block, so placement repeats: click, click, click, and Esc puts it
       down. Nothing is selected or framed on the way, because a camera that
       flies to each post is a camera you have to fly back. */
    const uid = makeUid(engine.params.seed, nextUidIndex(engine.props.records()));
    const record = {
      uid, ref: `${item.pack}/${item.id}`, url: item.url || null, label: item.label,
      proc: item.proc || null, fit: item.size || null,
      // Builder blocks are authored at real-world size — never auto-fit them.
      position: [point.x, point.y, point.z], rotationY: 0, scale: 1, autoFit: !item.proc,
      // Stacking on another block seats on that surface, not on the ground.
      seat: hit.onProp ? "point" : undefined,
    };
    await engine.props.add(record);
    const placed = { ...engine.props.get(uid).record };
    undoStack.push({
      kind: "place", subject: item.label,
      undo: () => { engine.props.remove(uid); select(null); announcePlacement(); },
      redo: async () => { await engine.props.restore(placed); select(uid); announcePlacement(uid, item.label, "Restored"); },
    });
    announcePlacement(uid, item.label);
    console.info("[studio] placed", item.label, uid);
    return;
  }
  const hit = engine.raycastProps(ndcX, ndcY);
  if (!hit && e.shiftKey) return; // a missed Shift-click keeps the current set
  select(hit ? hit.uid : null, !!hit && e.shiftKey);
});

const chip = $("#selection-chip");
// select(uid) replaces the selection; select(uid, true) toggles uid in it
// (Shift-click). select(null) clears. All selected props get hitboxes; the
// gizmo moves the whole group.
function select(uid, additive = false, { quiet = false } = {}) {
  const before = selection.join(",");
  if (!uid) selection = [];
  else if (additive) {
    selection = selection.includes(uid) ? selection.filter((u) => u !== uid) : [...selection, uid];
  } else selection = [uid];
  chip.hidden = !selection.length;
  stylePop.hidden = true; // a changed selection closes the style popover
  engine.markSelection(selection);
  /* WHAT IS SELECTED IS SAID FOUR WAYS AT ONCE — the wire box and the world
     marks (engine.markSelection), the chip, the manager's row, and the edge
     pointer if it is off screen. None of them is a gizmo, because a gizmo is
     forty pixels of arrows on a mountain range. */
  if (selection.length === 1) {
    const it = engine.props.get(selection[0]);
    const r = it?.record;
    $("#sel-label").textContent = r?.label ?? "Block";
    $("#sel-meta").textContent = r ? formatXZ(r.position[0], r.position[1], r.position[2]) : "";
    chip.classList.toggle("locked", engine.props.isLocked(selection[0]));
  } else if (selection.length) {
    $("#sel-label").textContent = `${selection.length} blocks`;
    $("#sel-meta").textContent = "";
    chip.classList.remove("locked");
  }
  objects.setSelection(selection);
  syncEdgeCues();
  // The cue is for a CHANGED selection, not for a bigger one: clicking from
  // one oak to the next is a change, and it should sound like one.
  if (!quiet && selection.length && selection.join(",") !== before) sound.pick();
}

/* ── the moment a placement lands ──
   Everything that has to happen so that nobody ever asks "did it place?":
   the ripple and the beacon in the world, the object easing up to size, the
   knock, the floating label, the camera leaning in only as far as it must,
   and the register updating. One function, because every one of these is
   part of the same single answer — and because a placement path that
   confirms in five places is a placement path where one of them rots. */
function announcePlacement(uid, label, note = "Placed") {
  refreshRegister();
  if (!uid || !engine.props.get(uid)) { syncEdgeCues(); return; }
  const a = engine.confirmPlacement(uid);
  engine.setNewestProp(uid);
  if (!a) { syncEdgeCues(); return; }
  // Bigger things land heavier — the ear reads mass long before the eye
  // finds a six-metre object in a two-kilometre world.
  sound.place(Math.min(Math.max((a.size - 1) / 14, 0), 1));
  cues.say({
    x: a.x, y: a.top + Math.max(a.size * 0.22, 0.6), z: a.z,
    title: label || a.label, note,
  });
  engine.revealProp(uid);
  syncEdgeCues();
}

// The count is chrome that never has to be asked for: it rides the deck's
// Objects key and the telemetry strip at once.
function syncObjectCount() {
  const n = engine.props.items.size;
  const badge = $("#obj-badge");
  if (badge) badge.textContent = String(n);
  $("#tool-objects").classList.toggle("has", n > 0);
}

// Apply an action to every selected placement.
function eachSelected(fn) {
  for (const uid of [...selection]) {
    const it = engine.props.get(uid);
    if (it) fn(uid, it.record);
  }
}

async function duplicateSelected() {
  if (!selection.length) return;
  const source = [...selection];
  const made = [];
  for (const uid of source) {
    const newUid = makeUid(engine.params.seed, nextUidIndex(engine.props.records()));
    const obj = await engine.props.duplicate(uid, newUid);
    if (obj) made.push(newUid);
  }
  if (!made.length) return;
  const copies = made.map((uid) => ({ ...engine.props.get(uid).record }));
  const subject = subjectOf(copies.map((r) => r.label));
  undoStack.push({
    kind: "duplicate", subject,
    undo: () => { for (const uid of made) engine.props.remove(uid); select(null); refreshRegister(); },
    redo: async () => { for (const r of copies) await engine.props.restore(r); select(made[made.length - 1]); refreshRegister(); },
  });
  // The copies become the selection, and the last one gets the full arrival
  // treatment — a duplicate that lands invisibly beside the original is the
  // same "where did it go" as a placement that lands invisibly anywhere.
  selection = made;
  chip.hidden = false;
  select(made[made.length - 1], false, { quiet: true });
  for (const uid of made) if (uid !== made[made.length - 1]) select(uid, true, { quiet: true });
  announcePlacement(made[made.length - 1], subject, made.length === 1 ? "Duplicated" : `Duplicated ×${made.length}`);
  console.info("[studio] duplicated", source, "→", made);
}
chip.addEventListener("click", (e) => {
  if (e.target.closest("#style-pop")) return; // the popover owns its clicks
  const act = e.target.closest("button")?.dataset?.act;
  if (!act || !selection.length) return;
  if (act === "focus") return navigate("focus");
  if (act === "dup") return void duplicateSelected();
  if (act === "delete") return deleteSelected();
  if (act === "style") {
    stylePop.hidden = !stylePop.hidden;
    if (!stylePop.hidden) syncStylePop();
    return;
  }
  if (act === "ignite") {
    // Toggle per placement: burning blocks are doused (the char stays —
    // burnt is burnt), unburnt ones catch fire.
    let lit = 0, doused = 0;
    eachSelected((uid) => {
      if (engine.isBurning(uid)) { engine.extinguishProp(uid); doused++; }
      else if (engine.igniteProp(uid)) lit++;
    });
    if (lit) toast(lit === 1 ? "Alight — it will char as it burns" : `${lit} blocks alight`);
    else if (doused) toast(doused === 1 ? "Fire out — the scorch stays" : `${doused} fires out`);
    return;
  }
  const kinds = { snap: "ground", rotate: "rotate", grow: "scale", shrink: "scale" };
  withTransformHistory(kinds[act] || act, [...selection], () => {
    eachSelected((uid, r) => {
      if (act === "snap") engine.props.update(uid, { snap: true });
      if (act === "rotate") engine.props.update(uid, { rotationY: (r.rotationY || 0) + ROT_STEP });
      if (act === "grow") engine.props.update(uid, { scale: (r.scale || 1) * 1.2 });
      if (act === "shrink") engine.props.update(uid, { scale: (r.scale || 1) / 1.2 });
    });
  });
});

// Rotation lands on 15° steps, matching the gizmo's rotation snap.
const ROT_STEP = Math.PI / 12;

/* ── style popover: per-placement paint tint + per-axis stretch ──
   Tint is a per-channel multiplier stored on the record (a mid-tone part
   lands on the swatch color; light/dark variation survives). Stretch scales
   one axis of the whole placement. Both travel in the fusion record, so
   VSight renders the styled block identically. */
const stylePop = $("#style-pop");

// Texture genre skins: the SAME door re-textured for a different game —
// null (Auto) follows the structure theme; a pick overrides per placement.
const TEX_STYLES = [
  ["Auto", null], ["Real", "real"], ["Toon", "toon"], ["Horror", "grim"], ["Fantasy", "fantasy"],
];
const stylesEl = $("#sp-styles");
for (const [name, key] of TEX_STYLES) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = name;
  b.dataset.style = key ?? "";
  b.addEventListener("click", () => applyStyle({ style: key }));
  stylesEl.appendChild(b);
}

const PAINTS = [
  ["Whitewash", "#e9e6dd"], ["Cream", "#e3d5b8"], ["Sand", "#d8b98a"], ["Terracotta", "#c17a58"],
  ["Brick", "#a85448"], ["Moss", "#7d9468"], ["Teal", "#5f8f8c"], ["Slate", "#67788c"],
  ["Charcoal", "#4a4d52"], ["Iron", "#7d848c"],
];
// swatch → multiplier triple: what turns a mid-gray part into the swatch.
function tintFromHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(Math.min(2, Math.max(0.15, c / 255 / 0.64)) * 1000) / 1000;
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
const swatchesEl = $("#sp-swatches");
for (const [name, hex] of PAINTS) {
  const b = document.createElement("button");
  b.style.background = hex;
  b.title = name;
  b.dataset.tint = JSON.stringify(tintFromHex(hex));
  b.addEventListener("click", () => applyStyle({ tint: tintFromHex(hex) }));
  swatchesEl.appendChild(b);
}
const clearBtn = document.createElement("button");
clearBtn.className = "clear";
clearBtn.textContent = "✕";
clearBtn.title = "Clear paint";
clearBtn.addEventListener("click", () => applyStyle({ tint: null }));
swatchesEl.appendChild(clearBtn);

// Every style edit is one kind of history entry — "Restyled Oak Tree" — with
// the specific change named in the toast at the time, not in the stack: an
// undo needs to say what it will take back, not which swatch you clicked.
function applyStyle(patch) {
  if (!selection.length) return;
  withTransformHistory("style", [...selection], () => {
    eachSelected((uid) => engine.props.update(uid, patch));
  });
  syncStylePop();
}
for (const row of document.querySelectorAll(".sp-axis")) {
  const axis = parseInt(row.dataset.axis, 10);
  for (const b of row.querySelectorAll("button")) {
    b.addEventListener("click", () => {
      if (!selection.length) return;
      const dir = parseInt(b.dataset.d, 10);
      withTransformHistory("scale", [...selection], () => {
        eachSelected((uid, r) => {
          const st = [...(r.stretch || [1, 1, 1])];
          st[axis] = Math.round(Math.min(6, Math.max(0.2, st[axis] * (dir > 0 ? 1.15 : 1 / 1.15))) * 1000) / 1000;
          engine.props.update(uid, { stretch: st });
        });
      });
      syncStylePop();
    });
  }
}
$("#sp-reset").addEventListener("click", () => applyStyle({ tint: null, stretch: null, style: null }));

// Reflect the first selected placement's style in the popover.
function syncStylePop() {
  if (stylePop.hidden || !selection.length) return;
  const r = engine.props.get(selection[0])?.record;
  if (!r) return;
  for (const b of stylesEl.children) {
    b.classList.toggle("active", (b.dataset.style || "") === (r.style || ""));
  }
  const cur = JSON.stringify(r.tint || null);
  for (const b of swatchesEl.children) {
    b.classList.toggle("active", !!b.dataset.tint && b.dataset.tint === cur);
  }
  const st = r.stretch || [1, 1, 1];
  document.querySelectorAll(".sp-axis").forEach((row, i) => {
    row.querySelector(".sp-val").textContent = "×" + st[i].toFixed(2);
  });
}

function deleteSelected() {
  const records = selection.map((uid) => ({ ...engine.props.get(uid)?.record })).filter((r) => r.uid);
  if (!records.length) return;
  for (const r of records) engine.props.remove(r.uid);
  select(null);
  sound.remove();
  const subject = subjectOf(records.map((r) => r.label));
  undoStack.push({
    kind: "delete", subject,
    undo: async () => {
      for (const r of records) await engine.props.restore(r);
      select(records[records.length - 1].uid);
      refreshRegister();
    },
    redo: () => { for (const r of records) engine.props.remove(r.uid); select(null); refreshRegister(); },
  });
  announce("Deleted", subject, 1900);
  refreshRegister();
}

/* ══════════════════════════════════════════════════════════════════
   THE REGISTER, THE CUES AND THE NAVIGATION

   Three surfaces, one idea: an object that has been placed can never
   afterwards be lost. The Object Manager is the list of everything, the cue
   layer is what the screen says about things you cannot see, and the
   navigation is the set of moves that get you to any of them without a
   single manual orbit.
   ══════════════════════════════════════════════════════════════════ */

const cues = new Cues({ root: $("#cue-layer"), engine });

/* A pin's colour is a question about the CATALOGUE, and the catalogue is the
   shell's to know — the engine asks rather than learning what "nature"
   means. Same map answers the manager's category column, so a pin and a row
   can never disagree about what a thing is. */
const CAT_BY_REF = new Map(allItems().map((i) => [`${i.pack}/${i.id}`, i]));
const categoryOfRef = (ref) => CAT_BY_REF.get(ref)?.category || (ref ? String(ref).split("/")[0] : "imported");
engine.setPinPalette((record) => categoryColor(categoryOfRef(record.ref)));
/* And which placements get one at all. The engine holds the measurements and
   the rule is the shell's — js/pinnable.js says why the ground you walk on
   and the furniture behind a shut door are not things to be found. */
engine.setPinFilter(isPinnable);

const objects = new ObjectManager({
  root: $("#objects-panel"),
  categories: CATEGORIES,
  api: {
    records: () => engine.props.records(),
    catalogue: () => CAT_BY_REF,
    isVisible: (uid) => engine.props.isVisible(uid),
    isLocked: (uid) => engine.props.isLocked(uid),
    isOpen: () => objectsOpen(),
    newest: () => engine.newestProp,
    viewer: () => engine.getViewer(),
    // Selecting a row is one interaction, so it has to finish the job: the
    // object is selected AND made visible. `revealProp` moves the camera
    // only as far as it must, so walking a list does not become a fairground
    // ride.
    select: (uid, additive) => {
      select(uid, additive);
      if (!additive) engine.revealProp(uid, { want: 46, maxPull: 0.55 });
    },
    navigate: (act, uid) => navigate(act, uid),
    rowAction: (act, uid) => rowAction(act, uid),
    batch: (act, uids) => batch(act, uids),
  },
});

/* ── navigation ──
   Every one of these is also a key and also a palette entry. The point is
   not the panel: the point is that "where is it" has an answer that is one
   press long, from wherever the author happens to be. */
function navigate(act, uid = null) {
  const cur = uid || selection[0] || engine.newestProp;
  if (act === "prev" || act === "next") {
    if (!engine.props.items.size) return toast("Nothing placed yet — open Blocks and put something down");
    // Stepping walks the manager's CURRENT order, so a search or a filter is
    // also a way to walk a subset. Falling back to placement order keeps the
    // keys working with the panel shut.
    // Whatever the order, it is filtered against the world one more time:
    // a uid that was deleted since the last paint is not somewhere to go.
    const list = (objects.order().length ? objects.order() : [...engine.props.items.keys()])
      .filter((u) => engine.props.get(u));
    if (!list.length) return toast("Nothing to step through here — clear the filters, or place something");
    const at = list.indexOf(cur);
    const next = at < 0 ? list[act === "next" ? 0 : list.length - 1]
      : list[(at + (act === "next" ? 1 : -1) + list.length) % list.length];
    if (!next) return;
    select(next, false, { quiet: true });
    engine.focusOnProp(next);
    sound.travel();
    const r = engine.props.get(next)?.record;
    announce(act === "next" ? "Next object" : "Previous object",
      `${r?.label || "Block"} · ${list.indexOf(next) + 1} of ${list.length}`, 1500);
    return;
  }
  if (act === "focus") {
    if (!cur) return toast("Nothing selected — click a block, or pick one from Objects");
    if (selection.length > 1) engine.frameProps(selection);
    else engine.focusOnProp(cur);
    sound.travel();
    return;
  }
  if (act === "orbit") {
    if (!cur) return toast("Nothing selected to orbit around");
    const on = engine.orbiting !== cur;
    engine.orbitAround(on ? cur : null);
    toast(on ? "Orbiting — drag, or press O again, to stop" : "Orbit stopped", 1600);
    return;
  }
  if (act === "all") {
    const n = engine.frameAllProps();
    sound.travel();
    announce("Frame all", n ? `${n} object${n === 1 ? "" : "s"} in shot` : "Nothing placed — the whole world", 1800);
    return;
  }
  if (act === "newest") {
    const target = engine.newestProp && engine.props.get(engine.newestProp)
      ? engine.newestProp : objects.newestUid();
    if (!target) return toast("Nothing placed yet");
    select(target, false, { quiet: true });
    engine.focusOnProp(target);
    sound.travel();
    announce("Last placement", engine.props.get(target)?.record.label || "Block", 1700);
    return;
  }
  if (act === "back") {
    if (!engine.returnToPreviousView()) return toast("No previous view to go back to", 1600);
    sound.travel();
    announce("Back", "Previous view", 1400);
  }
}

/* ── a row's own verbs ──
   Visibility and lock are authoring state and never enter the record, but
   they are still things a person can do by accident, so they are undoable
   like everything else. */
function rowAction(act, uid) {
  const rec = engine.props.get(uid)?.record;
  if (!rec) return;
  if (act === "focus") { select(uid, false, { quiet: true }); engine.focusOnProp(uid); sound.travel(); return; }
  if (act === "del") {
    const snapshot = { ...rec };
    engine.props.remove(uid);
    if (selection.includes(uid)) select(null);
    undoStack.push({
      kind: "delete", subject: snapshot.label,
      undo: async () => { await engine.props.restore(snapshot); refreshRegister(); },
      redo: () => { engine.props.remove(uid); refreshRegister(); },
    });
    sound.remove();
    refreshRegister();
    return;
  }
  if (act === "vis") {
    const next = !engine.props.isVisible(uid);
    setVisibility([uid], next);
    return;
  }
  if (act === "lock") {
    const next = !engine.props.isLocked(uid);
    setLocked([uid], next);
  }
}

function setVisibility(uids, visible) {
  const subject = subjectOf(uids.map((u) => engine.props.get(u)?.record.label));
  const apply = (on) => { for (const u of uids) engine.props.setVisible(u, on); refreshRegister(); };
  apply(visible);
  undoStack.push({
    kind: visible ? "show" : "hide", subject,
    undo: () => apply(!visible), redo: () => apply(visible),
  });
}
function setLocked(uids, locked) {
  const subject = subjectOf(uids.map((u) => engine.props.get(u)?.record.label));
  const apply = (on) => {
    for (const u of uids) engine.props.setLocked(u, on);
    // A locked block keeps its selection but loses its arrows — markSelection
    // is what re-decides that.
    engine.markSelection(selection);
    refreshRegister();
  };
  apply(locked);
  undoStack.push({
    kind: locked ? "lock" : "unlock", subject,
    undo: () => apply(!locked), redo: () => apply(locked),
  });
}

/* ── batch operations ──
   Everything a SET of objects can be told to do. Each one is a single undo
   step naming the set, because undoing a batch one object at a time is not
   an undo, it is a chore. */
function batch(act, uids) {
  const list = uids.filter((u) => engine.props.get(u));
  if (!list.length) return;
  if (act === "focus") { engine.frameProps(list); sound.travel(); return; }
  if (act === "dup") return void duplicateSelected();
  if (act === "del") return deleteSelected();
  // One key for both directions: anything still showing gets hidden, and a
  // set that is entirely hidden comes back.
  if (act === "hide") return setVisibility(list, !list.some((u) => engine.props.isVisible(u)));
  if (act === "lock") return setLocked(list, !list.every((u) => engine.props.isLocked(u)));
  if (act === "vary") return varySelection(list);
}

/* Randomised variation: the operation that turns a row of identical fence
   posts into a fence, and twelve identical pines into a wood. The stream is
   derived from the world's seed and the uids it is applied to, never from
   Math.random — the same set varied twice in the same session gives the same
   answer, which is what makes it undoable and re-doable rather than a slot
   machine. */
function varySelection(uids) {
  let s = 0;
  for (const uid of uids) for (const ch of uid) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  for (const ch of engine.params.seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  s = (s + engine.props.items.size * 2654435761) >>> 0;
  const rng = () => { // mulberry32, the same generator the rest of the engine uses
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  withTransformHistory("vary", uids, () => {
    for (const uid of uids) {
      const rec = engine.props.get(uid)?.record;
      if (rec) engine.props.update(uid, varyTransform(rec, rng));
    }
  });
  refreshRegister();
  announce("Varied", subjectOf(uids.map((u) => engine.props.get(u)?.record.label)), 1800);
}

/* ── keeping the three surfaces in step ──
   props.onChange fires on every frame of a gizmo drag, so the register is
   refreshed on a trailing timer rather than per event: the count is cheap
   and updates immediately, the list is not and updates a quarter of a second
   later, which is well under the threshold at which anybody notices. */
let registerPending = false;
function refreshRegister() {
  syncObjectCount();
  if (registerPending) return;
  registerPending = true;
  setTimeout(() => {
    registerPending = false;
    objects.refresh(); // the model always; the rows only when anybody can see them
    if (objectsOpen()) objects.setSelection(selection);
    if (selection.length === 1) {
      const r = engine.props.get(selection[0])?.record;
      if (r) $("#sel-meta").textContent = formatXZ(r.position[0], r.position[1], r.position[2]);
    }
  }, 240);
}
engine.on("props", refreshRegister);
/* Placements move without the undo stack hearing about it until the gesture
   ends — a gizmo drag is one entry pushed at gizmo-end, and refreshReset with
   it. This is the signal that fires while the piece is actually moving, so
   the file follows a drag rather than only its conclusion. */
engine.on("props", () => durable.touch());

/* ── the edge of the screen ──
   The last hole in "never lose an object": something that is placed, real
   and simply not in the frame. The tracked set is deliberately tiny — what
   is selected, what was placed last, what has been starred — because an edge
   with forty chevrons on it is a fence rather than a signpost. */
function syncEdgeCues() {
  const list = [];
  const c = engine.camera.position;
  const add = (uid, hot) => {
    if (!uid || list.length >= 6 || list.some((t) => t.uid === uid)) return;
    if (!engine.props.isVisible(uid)) return;
    const a = engine.props.anchor(uid);
    if (!a) return;
    list.push({
      uid, x: a.x, y: (a.y + a.top) / 2, z: a.z, label: a.label, hot,
      distance: Math.hypot(a.x - c.x, a.z - c.z),
      onClick: () => { select(uid); engine.focusOnProp(uid); },
    });
  };
  for (const uid of selection.slice(0, 3)) add(uid, true);
  add(engine.newestProp, false);
  for (const uid of objects.favorites) add(uid, false);
  cues.track(engine.mode === "orbit" ? list : []);
}
engine.on("frame", () => cues.tick());

/* ── the two switches in the manager's header ── */
function setPins(on) {
  engine.setPinsEnabled(on);
  $("#obj-pins").setAttribute("aria-pressed", String(on));
  $("#obj-pins").classList.toggle("off", !on);
}
$("#obj-pins").addEventListener("click", () => {
  const on = !engine.pinsEnabled;
  setPins(on);
  toast(on ? "Marker pins on — they fade out as you zoom in" : "Marker pins off", 1800);
});

/* One press that fills the world is the case the pin cloud cannot serve. The
   filter in js/pinnable.js has already dropped the ground and the furniture
   by the time this is asked, so what is counted here is real objects — and
   past a few hundred of those the layer has stopped being a finding aid and
   become the thing between the author and what they just made. Turn it off
   and SAY SO: the switch is in the manager's header, and somebody who wanted
   the pins should not have to work out where they went.

   `after` is a frame late on purpose — the cloud is rebuilt on the next
   frame from the dirty flag, so asking for its count in the same turn as the
   placement counts the world as it was before. */
function pinsOffIfCrowded(what) {
  requestAnimationFrame(() => {
    if (!engine.pinsEnabled || engine.pinCount <= PIN_LEGIBLE_MAX) return;
    const n = engine.pinCount;
    setPins(false);
    toast(`${what} — marker pins off (${n} would be a wall of them). The pin switch in Objects turns them back on.`, 4200);
  });
}
$("#obj-sound").addEventListener("click", () => {
  const on = !sound.enabled;
  sound.setEnabled(on);
  $("#obj-sound").setAttribute("aria-pressed", String(on));
  $("#obj-sound").classList.toggle("off", !on);
  setHTML($("#obj-sound span[data-icon]"), on ? UI.sound : UI.soundOff);
  pref.set("wf-sound", on ? "on" : "off");
  if (on) sound.pick();
});

/* ── gizmo drags land on the undo stack as one move ── */
let gizmoBefore = null;
engine.on("gizmo-start", ({ uids }) => { gizmoBefore = snapTransforms(uids); });
engine.on("gizmo-end", ({ uids }) => {
  if (!gizmoBefore || !gizmoBefore.length) return;
  const before = gizmoBefore; gizmoBefore = null;
  const after = snapTransforms(uids);
  const moved = after.some((a, i) => before[i] && a.position.some((v, k) => Math.abs(v - before[i].position[k]) > 1e-4));
  if (!moved) return;
  undoStack.push({
    kind: "move",
    subject: subjectOf(uids.map((uid) => engine.props.get(uid)?.record.label)),
    undo: () => applyTransforms(before),
    redo: () => applyTransforms(after),
  });
  refreshRegister(); // the coordinates on the chip and in the list have moved
});
window.addEventListener("keydown", (e) => {
  // Typing is typing. The Object Manager's list is focusable and walks
  // itself with the arrow keys, so a keystroke aimed at the LIST must never
  // also nudge the block the list is pointing at.
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.target.closest?.("#objects-panel") && e.code.startsWith("Arrow")) return;
  // Undo/redo: ⌘Z and ⌘⇧Z on a Mac, Ctrl+Z / Ctrl+Y elsewhere.
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
    e.preventDefault();
    return void (e.shiftKey ? undoStack.redo() : undoStack.undo());
  }
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyY") { e.preventDefault(); return void undoStack.redo(); }
  // Alt suspends snapping for as long as it's held.
  if (e.code === "AltLeft" || e.code === "AltRight") engine.setSnap(false);
  if (e.code === "Escape") {
    if (armedSpawn || armedGrass || armedSculpt || armed || armedSite || armedRiver) disarmAll();
    else if (engine.orbiting) engine.orbitAround(null);
    else select(null);
  }

  /* ── the camera keys ──
     These come BEFORE the selection guard on purpose: "frame everything",
     "take me to the last thing I placed" and "put the view back" are exactly
     the moves somebody makes when they have lost track and therefore have
     nothing selected. A navigation key that only works once you have already
     found something is a navigation key for people who are not lost. */
  if (engine.mode === "orbit" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.code === "BracketLeft") { e.preventDefault(); return void navigate("prev"); }
    if (e.code === "BracketRight") { e.preventDefault(); return void navigate("next"); }
    if (e.code === "KeyG") { e.preventDefault(); return void navigate("newest"); }
    if (e.code === "KeyV") { e.preventDefault(); return void navigate("back"); }
    if (e.code === "KeyA" && e.shiftKey) { e.preventDefault(); return void navigate("all"); }
    if (e.code === "KeyM") { e.preventDefault(); return void setObjects(!objectsOpen()); }
    if (e.code === "KeyO" && selection.length) { e.preventDefault(); return void navigate("orbit"); }
    if (e.code === "KeyF") { e.preventDefault(); return void navigate("focus"); }
  }

  if (!selection.length || engine.mode !== "orbit") return;
  const sel = [...selection];
  if (e.code === "KeyR") withTransformHistory("rotate", sel, () => eachSelected((uid, r) => engine.props.update(uid, { rotationY: (r.rotationY || 0) + ROT_STEP })));
  if (e.code === "KeyD") duplicateSelected();
  if (e.code === "KeyQ") withTransformHistory("ground", sel, () => eachSelected((uid) => engine.props.update(uid, { snap: true })));
  if (e.code === "KeyH") setVisibility(sel, !sel.some((uid) => engine.props.isVisible(uid)));
  if (e.code === "KeyL") setLocked(sel, !sel.every((uid) => engine.props.isLocked(uid)));
  if (e.code === "KeyJ") varySelection(sel);
  if (e.code === "Equal" || e.code === "NumpadAdd") withTransformHistory("scale", sel, () => eachSelected((uid, r) => engine.props.update(uid, { scale: (r.scale || 1) * 1.2 })));
  if (e.code === "Minus" || e.code === "NumpadSubtract") withTransformHistory("scale", sel, () => eachSelected((uid, r) => engine.props.update(uid, { scale: (r.scale || 1) / 1.2 })));
  if (e.code === "Delete" || e.code === "Backspace") deleteSelected();
  // Arrow keys nudge camera-relative: Up always pushes the prop away from
  // the viewer, so the keys match what's on screen at any orbit angle.
  if (e.code.startsWith("Arrow")) {
    e.preventDefault();
    const step = e.shiftKey ? 2 : 0.5;
    const yaw = engine.getViewer().yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // camera forward on the ground
    const rx = -fz, rz = fx;                         // screen-right on the ground
    let dx = 0, dz = 0;
    if (e.code === "ArrowUp") { dx = fx; dz = fz; }
    if (e.code === "ArrowDown") { dx = -fx; dz = -fz; }
    if (e.code === "ArrowRight") { dx = rx; dz = rz; }
    if (e.code === "ArrowLeft") { dx = -rx; dz = -rz; }
    withTransformHistory("move", [...selection], () => {
      eachSelected((uid, r) => engine.props.update(uid, {
        position: [r.position[0] + dx * step, r.position[1], r.position[2] + dz * step],
      }));
    });
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "AltLeft" || e.code === "AltRight") engine.setSnap(true);
});
window.addEventListener("blur", () => engine.setSnap(true)); // never stay unsnapped

/* ── terrain brush ── */
$("#tool-sculpt").addEventListener("click", () => {
  if (engine.mode !== "orbit") engine.setMode("orbit");
  const next = !armedSculpt;
  disarmAll();
  armedSculpt = next;
  refreshTools();
  if (armedSculpt) toast("Sculpt: drag on the terrain — Alt inverts raise/lower, Esc to finish");
});
for (const b of document.querySelectorAll("#sculpt-modes button")) {
  b.addEventListener("click", () => {
    brush.mode = b.dataset.mode;
    for (const o of document.querySelectorAll("#sculpt-modes button")) o.classList.toggle("active", o === b);
  });
}
const brushRadius = $("#brush-radius"), brushStrength = $("#brush-strength");
function syncBrush() {
  brush.radius = parseFloat(brushRadius.value);
  brush.strength = parseFloat(brushStrength.value);
  $("#brush-radius-val").textContent = Math.round(brush.radius) + "m";
  $("#brush-strength-val").textContent = brush.strength.toFixed(1) + "m";
}
brushRadius.addEventListener("input", syncBrush);
brushStrength.addEventListener("input", syncBrush);
syncBrush();

/* ── the river tool ──
   Hover shows the ANSWER — the course this water would take, solved live on
   the canonical ground, with the mouth ringed — and the click carves it as
   ordinary sculpt strokes (engine/terrain/river.js). Because the strokes are
   ordinary, ⌘Z, save, handoff and export need nothing new; because the water
   field re-bakes on commit, the existing flood front then visibly runs the
   sea up the channel that was just cut. */
$("#tool-river").addEventListener("click", () => {
  if (engine.mode !== "orbit") engine.setMode("orbit");
  const next = !armedRiver;
  disarmAll();
  armedRiver = next;
  refreshTools();
  if (armedRiver) toast("River: aim at high ground — the course finds the sea — click to carve, Esc to finish");
});

// Hover throttle state — declared before the dials, whose sync writes to it.
const riverPreview = { at: 0, last: null };

const riverDials = { width: $("#river-width"), depth: $("#river-depth"), meander: $("#river-meander") };
function riverSpec() {
  return {
    width: parseFloat(riverDials.width.value) || 16,
    depth: parseFloat(riverDials.depth.value) || 4,
    meander: parseFloat(riverDials.meander.value) || 0,
  };
}
function syncRiverDials() {
  $("#river-width-val").textContent = Math.round(parseFloat(riverDials.width.value)) + "m";
  $("#river-depth-val").textContent = parseFloat(riverDials.depth.value).toFixed(1) + "m";
  $("#river-meander-val").textContent = parseFloat(riverDials.meander.value).toFixed(1);
  riverPreview.last = null; // a changed knob re-solves the hover
}
for (const d of Object.values(riverDials)) d.addEventListener("input", syncRiverDials);
syncRiverDials();

/* The solve context: the canonical field and its sea mask, derived once per
   arming (the ground is static while you hover) and dropped by disarmAll and
   by every carve — both change the ground under it. */
function riverContext() {
  if (!riverCtx) {
    const field = ensureField();
    riverCtx = { field, wet: floodFromSea(field, null, engine.params.water.level || 0).wet };
  }
  return riverCtx;
}

const nextRiverId = () => `river-${(engine.params.terrain.rivers || []).length + 1}`;

// Hover: throttled to ~11 Hz — a solve is a few milliseconds, a pointermove
// stream is hundreds a second, and the course does not change faster than
// the hand moves.
function riverHover(e) {
  const now = performance.now();
  if (now - riverPreview.at < 90) return;
  riverPreview.at = now;
  const p = engine.raycastGround((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const verdict = $("#river-verdict");
  if (!p) { engine.showPathGhost(null); verdict.textContent = "Aim at the ground"; return; }
  const { field, wet } = riverContext();
  const out = solveRiver({
    field, wet, head: { x: p.x, z: p.z }, ...riverSpec(),
    level: engine.params.water.level || 0, seed: engine.params.seed + ":" + nextRiverId(),
  });
  riverPreview.last = out;
  engine.showPathGhost(out.path);
  const km = out.path.length > 1
    ? out.path.reduce((s, q, k) => (k ? s + Math.hypot(q[0] - out.path[k - 1][0], q[1] - out.path[k - 1][1]) : 0), 0) / 1000
    : 0;
  verdict.textContent = out.reachedSea
    ? `Flows to the sea · ${km.toFixed(1)} km${out.pools.length ? ` · through ${out.pools.length} pool${out.pools.length === 1 ? "" : "s"}` : ""} · click to carve`
    : `Ends in a lake · ${km.toFixed(1)} km · click to carve`;
}

async function carveRiver(point) {
  const spec = riverSpec();
  const { field, wet } = riverContext();
  const id = nextRiverId();
  const out = solveRiver({
    field, wet, head: { x: point.x, z: point.z }, ...spec,
    level: engine.params.water.level || 0, seed: engine.params.seed + ":" + id,
  });
  if (out.path.length < 2 || !out.strokes.length) {
    toast("No course from here — this ground is already at the water");
    return;
  }
  const before = engine.sculptStrokes();
  const riversBefore = [...(engine.params.terrain.rivers || [])];
  for (const s of out.strokes) engine.sculptAt(s.x, s.z, { radius: s.r, amount: s.amount, mode: s.mode });
  // One commit for the whole carve: the water field re-bakes with the flood
  // ANIMATED, so the sea visibly runs up the new channel — the same moment
  // the sculpt brush earns, at river length.
  engine.commitSculpt();
  lastField = null;
  riverCtx = null;
  refreshMinimap();
  const after = engine.sculptStrokes();
  const record = {
    id, x: Math.round(point.x * 100) / 100, z: Math.round(point.z * 100) / 100,
    ...spec,
    strokeStart: before.length, strokeCount: after.length - before.length,
    reachedSea: out.reachedSea,
    path: out.path,
  };
  engine.params.terrain.rivers = [...riversBefore, record];
  const riversAfter = [...engine.params.terrain.rivers];
  // The above-sea water surface, run in from the head — the sea's flood
  // front (already animating from commitSculpt) meets it at the mouth.
  engine.refreshRivers({ runIn: true });

  const applyRivers = (list) => { engine.params.terrain.rivers = [...list]; };
  undoStack.push({
    kind: "river",
    subject: out.reachedSea ? "a river to the sea" : "a river into a lake",
    undo: () => {
      engine.sculptRestore(before); applyRivers(riversBefore);
      engine.refreshRivers();
      lastField = null; riverCtx = null; refreshMinimap();
    },
    redo: () => {
      engine.sculptRestore(after); applyRivers(riversAfter);
      engine.refreshRivers();
      lastField = null; riverCtx = null; refreshMinimap();
    },
  });
  engine.showPathGhost(null);
  sound.place(0.9);
  announce("River",
    out.reachedSea
      ? `carved — watch the sea come up the channel · ⌘Z takes it back`
      : `carved — it pools into a lake · ⌘Z takes it back`, 3400);
  console.info("[studio] river", id, out.reachedSea ? "reaches the sea" : "ends landlocked",
    `· ${out.strokes.length} strokes · ${out.pools.length} pools`);
}

/* Grass brush dials mirror the sculpt idiom: live readouts, values read at
   paint time (grassBrush), so there is no state to fall out of sync.

   SIZE rides the deck next to the tool, like the sculpt brush's; patch
   density lives in the World panel's Vegetation section instead — both dials
   together overflow the deck's contextual strip, and density belongs beside
   the other vegetation settings anyway. */
const grassRadius = $("#grass-radius"), grassDensity = $("#grass-density");
function syncGrassBrush() {
  $("#grass-radius-val").textContent = Math.round(parseFloat(grassRadius.value)) + "m";
  $("#grass-density-val").textContent = grassDensity.value;
}
grassRadius.addEventListener("input", syncGrassBrush);
grassDensity.addEventListener("input", syncGrassBrush);
syncGrassBrush();

/* ── GLB import: button + drag-drop ── */
$("#dock-import").addEventListener("click", () => $("#dock-file").click());
$("#dock-file").addEventListener("change", (e) => { if (e.target.files[0]) importGlb(e.target.files[0]); e.target.value = ""; });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  // A world file first: dropping one is the same act as opening it, and a
  // world is the bigger thing to be holding.
  const w = files.find((f) => /\.world\.json$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name));
  if (w) return void openWorldFile(w);
  const f = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (f) importGlb(f);
});
async function importGlb(file) {
  try {
    const bytes = await file.arrayBuffer();
    assertGlb(bytes, file.name);
    const v = engine.getViewer();
    const uid = makeUid(engine.params.seed, nextUidIndex(engine.props.records()));
    await engine.props.add({
      uid, ref: null, url: null, label: file.name.replace(/\.(glb|gltf)$/i, ""),
      position: [v.x, 0, v.z], rotationY: 0, scale: 1, autoFit: true,
    }, bytes);
    const it = engine.props.get(uid);
    engine.focusOn(it.object.position.clone(), 30); // seated, fitted, framed
    select(uid, false, { quiet: true });
    const imported = { ...it.record };
    undoStack.push({
      kind: "import", subject: imported.label,
      undo: () => { engine.props.remove(uid); select(null); refreshRegister(); },
      redo: async () => { await engine.props.restore(imported); select(uid); refreshRegister(); },
    });
    announcePlacement(uid, imported.label, "Imported");
  } catch (err) {
    toast(`Import failed: ${err.message}`);
    console.warn("[studio] import:", err);
  }
}

/* ══════════════════════════════════════════════════════════════════
   THE WORLD AS A FILE
   The only thing this tool makes that outlives the tab. js/worldfile.js is
   the whole format and all of the rules; this is the browser half — a Blob
   handed to the browser's own save dialog, and a file the user picked handed
   back. NO STORAGE API IS TOUCHED: the world lives in memory and in the file
   the user chose, nowhere else.

   Loading is one history entry, so ⌘Z takes an opened world back off exactly
   the way it takes a generated one off — the README's promise about undo does
   not get an exception carved into it for this.
   ══════════════════════════════════════════════════════════════════ */

/* Put a whole world on screen: params, sculpt, placements, scatter. The one
   path both Open and its undo go through, so that undoing an open cannot
   restore something subtly different from what was replaced. */
async function loadWorldState(state) {
  disarmAll();
  for (const r of engine.props.records()) engine.props.remove(r.uid);
  /* A ground offered BEFORE the params it belongs to. Engine.adoptGround
     keeps the ground's own parameter hash and the build claims it only if the
     params in play still match, so this is safe to offer speculatively: if
     `state` describes another world the engine drops it and derives its own.
     What it buys is the erosion pass — about a second — on the one path where
     the field is already in hand and provably identical to what re-deriving
     would produce. */
  if (state.ground) engine.adoptGround(state.ground);
  engine.applyParams(state.params);
  engine.sculptRestore(state.sculpt !== undefined ? state.sculpt : (state.params.terrain?.sculpt || []));
  // One announcement for the whole load: pins rebuild once and the register
  // re-reads once, rather than once per piece of a furnished town.
  engine.props.beginBulk();
  try {
    for (const r of state.records) await engine.props.restore(r);
  } finally { engine.props.endBulk(); }
  engine.rebuildScatter();
  lastField = null;
  refreshMinimap();
  select(null);
  refreshRegister();
  syncPanel();
  syncWeatherPills();
  showSeed();
}

/* The world as a document, from one place. Save writes it through a Blob and
   the durable link writes it through a file handle, and the two must not be
   able to drift into describing different worlds — the authored spawn went
   missing for exactly that kind of reason. */
function currentWorldDoc() {
  return buildWorldFile({
    params: engine.params,
    propRecords: engine.props.records(),
    field: ensureField(),
    // The landing this session is actually showing. Voided by the "world"
    // handler above when the seed or biome moves out from under it, so by
    // the time it reaches here it is either this world's or null.
    spawn: customSpawn,
  });
}

function saveWorld() {
  let url = null;
  let name = "world";
  try {
    const doc = currentWorldDoc();
    name = worldFileName(doc);
    const blob = new Blob([serializeWorldFile(doc)], { type: "application/json" });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    const kb = Math.max(1, Math.round(blob.size / 1024));
    const note = omissionNote(doc);
    toast(note ? `Saved ${name} — ${kb} KB. ${note}` : `Saved ${name} — ${kb} KB`, note ? 5600 : 2800);
    console.info("[studio] saved", name, blob.size, "bytes,", doc.world.props.length, "placements");
  } catch (err) {
    toast(`Save failed: ${err.message}`);
    console.warn("[studio] save:", err);
  } finally {
    // Revoked late rather than immediately: revoking in the same turn as the
    // click races the download in more than one browser.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

/* The world as RESULTS rather than instructions: a GLB of the ground, the
   16-bit heightmap, and the masks the terrain bake has always derived and
   never shipped — in one zip, so one click is one download. Everything
   deterministic lives in js/export-world.js and js/export/*, where the suite
   reaches it; this is the same thirty browser lines Save is.

   Built from ensureField(), so the export is the session's ACTUAL ground —
   post-erosion, post-sculpt — and the deposition masks are included exactly
   when the engine still holds this world's own delta on the same grid. */
function exportWorld() {
  let url = null;
  try {
    const t0 = performance.now();
    const field = ensureField();
    const delta = engine.erosionDelta();
    const bundle = buildExportBundle({
      params: engine.params,
      field,
      delta: delta && delta.res === field.res ? delta.data : null,
      /* The other half of the export: the scene. Records straight off the
         engine, the interior reports the build filed (one per building — the
         same map the I panel reads), the authored spawn, and the coarse
         extent Props measured when each object was built — which is what
         gives the Unity importer's placeholders their mass. */
      records: engine.props.records(),
      spawn: customSpawn,
      boundsFor: (uid) => {
        const it = engine.props.get(uid);
        return it?.size ? { size: it.size, above: it.hAbove ?? it.size, below: it.hBelow ?? 0 } : null;
      },
    });
    const zip = encodeZip(bundle.files);
    const blob = new Blob([zip], { type: "application/zip" });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = bundle.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    const mb = (blob.size / 1048576).toFixed(1);
    toast(`Exported ${bundle.name} — ${mb} MB, ${bundle.files.length} files`, 3600);
    console.info("[studio] exported", bundle.name, blob.size, "bytes in",
      Math.round(performance.now() - t0), "ms");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
    console.warn("[studio] export:", err);
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

/* ══ KEEPING THE FILE CURRENT ═══════════════════════════════════════════════
   The browser half of js/durable.js — the picker and the writable stream, and
   nothing else. Every decision about WHEN to write lives in that module,
   where it can be tested against a clock this file does not own.

   WHAT THIS DOES NOT DO. It stores nothing on this origin. There is no
   localStorage, no IndexedDB, no handle kept across a reload. The file
   is one the user picked through their own browser's dialog, which is the
   same sentence the product has always made about Save; the difference is
   that it now stays current instead of going stale the moment they carry on.

   WHERE IT STOPS. Safari and Firefox have no showSaveFilePicker, so the
   control is simply absent there and Save is exactly what it always was.
   ══════════════════════════════════════════════════════════════════════════ */
let fileHandle = null;

const durable = createDurableLink({
  serialize: () => serializeWorldFile(currentWorldDoc()),
  write: async (text) => {
    if (!fileHandle) throw new Error("no file is linked");
    /* createWritable() writes to a swap file and only replaces the real one
       on close(), so a write that fails part way leaves the last good world
       on disk rather than a truncated one. abort() is what makes that true —
       without it a thrown write can leave the swap holding the file. */
    const stream = await fileHandle.createWritable();
    try {
      await stream.write(text);
      await stream.close();
    } catch (err) {
      try { await stream.abort(); } catch { /* already gone; the file is intact */ }
      throw err;
    }
  },
});

function renderKeepButton(st) {
  const btn = $("#btn-keep");
  if (!btn) return;
  btn.classList.toggle("on", st.linked);
  btn.classList.toggle("warn", !!st.error);
  btn.setAttribute("aria-pressed", String(st.linked));
  const label = btn.querySelector("b");
  if (label) label.textContent = st.linked ? (st.error ? "Retrying" : "Keeping") : "Keep";
  btn.title = !st.linked
    ? "Keep this world in a file — pick one once, and every change is written to it"
    : st.error
      ? `Could not write to ${st.name} — ${st.error}. Still trying; use Save for a copy.`
      : st.dirty || st.writing
        ? `Writing to ${st.name}…`
        : `Saved to ${st.name}. Click to stop keeping it.`;
}

durable.onChange(renderKeepButton);

async function keepInFile() {
  if (durable.state().linked) {
    durable.detach();
    fileHandle = null;
    toast("Stopped keeping this world in a file — Save still works", 3000);
    return;
  }
  try {
    // Needs the user gesture this click is, so it cannot be moved off the
    // handler into anything that awaits first.
    fileHandle = await globalThis.showSaveFilePicker({
      suggestedName: worldFileName(currentWorldDoc()),
      types: [{ description: "Worldgence world", accept: { "application/json": [".world.json", ".json"] } }],
    });
  } catch (err) {
    // A cancelled picker is not a failure and gets no sentence.
    if (err && err.name === "AbortError") return;
    toast(`Could not open that file: ${err.message}`, 4600);
    console.warn("[studio] keep:", err);
    return;
  }
  durable.attach(fileHandle.name);
  // The file the user just named is empty until something is written to it,
  // and an empty file where a world should be is the wrong first impression.
  durable.touch();
  await durable.flush();
  const st = durable.state();
  toast(st.error
    ? `Linked to ${fileHandle.name}, but the first write failed — ${st.error}`
    : `Keeping this world in ${fileHandle.name} — every change is written to it`, 4200);
}

/* Replacing the DOCUMENT is not the same as changing it. Open and Build a
   world both put a different world on screen, and writing that into a file
   the author named after this one would be the data loss this exists to
   prevent, arriving by a shorter road. So both let go, and say so. */
function releaseFile(why) {
  if (!durable.state().linked) return;
  const name = durable.state().name;
  durable.detach();
  fileHandle = null;
  toast(`${why} — ${name} is no longer being kept up to date. Press Keep to link this world.`, 5200);
}

if (isFileLinkSupported()) {
  $("#btn-keep")?.addEventListener("click", keepInFile);
  /* A heartbeat rather than a timer per change: the module decides whether
     anything is due, and one comparison every 400 ms is not a frame budget.
     Deliberately NOT driven off engine "frame" — a world that has stopped
     redrawing is exactly a world somebody has stopped touching, and that is
     the moment its last change should be going to disk. */
  setInterval(() => { durable.tick(); }, 400);
  /* The last chance to write. A writable stream cannot be relied on to open
     and close inside pagehide, which is why SAVE_QUIET_MS is short — this is
     a best effort on top of a small exposure, not the guarantee itself. */
  addEventListener("pagehide", () => { durable.flush(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) durable.flush();
  });
  renderKeepButton(durable.state());
} else {
  $("#btn-keep")?.remove();
}

async function openWorldFile(file) {
  releaseFile("Opened a different world");
  const before = {
    params: JSON.parse(JSON.stringify(engine.params)),
    records: engine.props.records().map((r) => ({ ...r })),
    sculpt: engine.sculptStrokes(),
  };
  /* Flipped the instant the world on screen stops being the one `before`
     describes. Everything above that point — reading the file, parsing it,
     validating it — leaves the session untouched, so a failure there is a
     file that was not opened. Everything below it has already begun taking
     the previous world apart. The two need different sentences and only one
     of them needs a rescue. */
  let dismantling = false;
  try {
    const { doc, errors } = parseWorldFile(await file.text());
    if (!doc) {
      // A file the user picked and this tool will not open is an ordinary
      // event, and it gets a sentence rather than a stack trace. The first
      // named failure is the useful one; the rest go to the console.
      toast(`${file.name} was not opened — ${errors[0]}`, 4600);
      console.warn("[studio] world file refused:", errors);
      return;
    }
    const after = {
      params: paramsFromWorldFile(doc),
      records: propsFromWorldFile(doc),
      sculpt: paramsFromWorldFile(doc).terrain?.sculpt || [],
    };
    dismantling = true;
    await loadWorldState(after);
    if (doc.world.spawn) {
      customSpawn = { x: doc.world.spawn.x, z: doc.world.spawn.z };
      spawnTag = worldTag();
      minimap.setRings(deriveSpawn([], engine.params, { override: customSpawn }).rings
        .map((r) => ({ x: customSpawn.x, z: customSpawn.z, r: r.r })));
    }
    // An opened world is the world now, so it is what Reset goes back to.
    baseDoc = doc;
    markPristine();
    undoStack.push({
      kind: "world",
      subject: `${file.name} · ${after.records.length} pieces`,
      undo: () => loadWorldState(before),
      redo: () => loadWorldState(after),
    });
    document.body.classList.add("stage");
    announce("Opened", `${file.name} · ${after.records.length} pieces`, 3400);
    /* Provenance first, then omissions. An omission changes what is IN the
       world; a generator mismatch changes the GROUND under all of it, and a
       person deciding whether what they are looking at is what they saved
       needs that one before they need the other. */
    const notes = [generatorNote(doc), omissionNote(doc)].filter(Boolean);
    if (notes.length) toast(notes.join(" "), 5600);
    console.info("[studio] opened", file.name, after.records.length, "placements");
  } catch (err) {
    if (!dismantling) {
      // Nothing was touched: the file never got as far as the world.
      toast(`${file.name} was not opened — ${err.message}`, 4600);
      console.warn("[studio] open:", err);
      return;
    }
    /* THE LOAD BROKE HALF WAY, AND THE WORLD ON SCREEN WAS ALREADY GONE.
       loadWorldState removes every placement before it applies the incoming
       params, so a file that satisfies the validator and then throws deeper
       in (an unmodelled param shape, a placement the engine will not seat)
       used to leave the session holding neither world: the old placements
       removed, the new params half-applied, no undo entry pushed — because
       the push is below this line — and a toast reading "was not opened",
       which was the one thing that was definitely untrue. An hour of
       authoring, destroyed by picking the wrong file.

       `before` was already being captured for the undo entry. It is a
       complete description of the session, so it is also the way back. */
    console.warn("[studio] open failed mid-load, restoring the previous world:", err);
    try {
      await loadWorldState(before);
      toast(`${file.name} could not be loaded — ${err.message}. Your world is as it was.`, 6400);
    } catch (rescue) {
      /* Both the file and the way back failed. Say so plainly rather than
         leaving a half-built world claiming to be something: there is real
         work on screen and the person needs to know not to trust it. */
      console.error("[studio] could not restore the previous world:", rescue);
      toast(`${file.name} could not be loaded (${err.message}), and putting your world back also failed (${rescue.message}). Save nothing from this session.`, 12000);
    }
  }
}

/* ══ RESET ═════════════════════════════════════════════════════════════════
   An hour of edits and a change of mind. Reset puts the world back the way it
   opened — the params, the ground, the placements, the strokes — without
   asking anybody to press ⌘Z forty times and hope they counted.

   WHAT "THE WAY IT OPENED" IS, exactly: the seed's own world it opened on
   (makeParams of that seed, nothing placed), or `baseDoc`, the last world
   Opened. The document is never mutated (paramsFromWorldFile and
   propsFromWorldFile both deep-clone on the way out), so the state is rebuilt
   at click time rather than snapshotted at boot, and cannot have drifted in
   between.

   That includes the params, so a travelled-to seed and a dragged terrain slider go
   back too. This is deliberate: "back to how it opened" is one promise a
   person can hold in their head, where "back to how it opened unless you
   touched the sliders" is three.

   THE TERRAIN IS RE-DERIVED, and that is safe rather than sloppy. The ground
   the visitor arrived on was adopted from the handoff, and adoption is
   one-shot; but the field is a pure function of the params and the seed
   through engine/terrain/canonical.js, so rebuilding gives back the same
   Float32Array bit for bit — tests/handoff.test.js is the assertion. It costs
   the erosion pass, about a second, which is the ordinary price of any world
   change and the honest price of this one.

   ON THE UNDO STACK, like Open. Reset is the largest single thing a person
   can do to a world, so it is the last thing that should be irreversible. */
function initialWorldState() {
  if (!baseDoc) return { params: makeParams({ seed: landingSeed }), records: [], sculpt: [], ground: null };
  const params = paramsFromWorldFile(baseDoc);
  return {
    params,
    records: propsFromWorldFile(baseDoc),
    sculpt: params.terrain?.sculpt || [],
    ground: null,
  };
}

/* ── the baseline ──
   Snapshotted from the ENGINE once the session has finished booting, not
   re-parsed from the document. The two are not the same object: _buildWorld
   normalises params in place — it seats `terrain.sculpt` on the sculpt
   layer's own array, fills in `fx.fires`, defaults the weather — so a fresh
   parse of the same file never string-compares equal to the world built from
   it, and a check written that way would report "touched" on a world nobody
   had touched. Retaken after a reset and after an Open, which are the two
   ways the baseline legitimately moves. */
/* ── what "the same placements" means ──
   COUNTING THEM IS NOT ENOUGH, and that was the hole. The baseline held
   `records.length`, so every edit that changes a placement without changing
   how many there are — moving one, turning it, scaling it, painting a tint,
   stretching it, restyling it, seating it on a point — left the world
   reporting itself untouched. An afternoon of arranging a town is almost
   entirely such edits. The consequences were both the ones the count was
   standing guard over: `beforeunload` let the tab close in silence over
   unsaved work, which is the exact failure its own comment says it exists to
   prevent, and Reset stayed greyed out over a world that had been completely
   rearranged.

   HEIGHT IS DERIVED, EXCEPT WHERE IT IS NOT, and that is why this is a
   projection rather than a JSON.stringify of the records. Props.setSampler
   writes `record.position[1]` back from the ground every time the surface
   moves — and the surface moves on its own, seconds after any world opens,
   when the erosion pass lands. Comparing raw records would therefore have
   reported "touched" on every session before the author had done anything.
   A point-seated piece holds its authored height instead (the same rule
   Props.setSampler itself branches on), so that one contributes its Y.

   Sorted by uid so that undo and redo re-inserting in a different order is
   not mistaken for an edit. */
function placementShape() {
  const n = (v) => Math.round((v || 0) * 100) / 100;
  return JSON.stringify(engine.props.records()
    .map((r) => [
      r.uid, r.ref || null, r.label || null,
      n(r.position[0]), n(r.position[2]),
      r.seat === "point" ? n(r.position[1]) : null,
      n(r.rotationY), n(r.scale ?? 1),
      r.tint || null, r.stretch || null, r.style || null,
      r.seat || null, r.use || null, !!r.placeholder,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

let pristine = null;
function markPristine() {
  pristine = {
    params: JSON.stringify(engine.params),
    records: placementShape(),
    sculpt: JSON.stringify(engine.sculptStrokes()),
  };
  refreshReset();
}

/** Whether this world still stands as it was handed over. */
function worldIsUntouched() {
  if (!pristine) return true;
  return placementShape() === pristine.records
    && JSON.stringify(engine.sculptStrokes()) === pristine.sculpt
    && JSON.stringify(engine.params) === pristine.params;
}

/* How long Reset stays armed after the first press. Long enough to read the
   sentence it just put on screen, short enough that an armed button is never
   still armed when somebody comes back to the tab. */
const RESET_ARM_MS = 5000;
let resetArmedUntil = 0;
function disarmReset() {
  resetArmedUntil = 0;
  $("#btn-reset")?.classList.remove("armed");
}

function refreshReset() {
  const btn = $("#btn-reset");
  if (btn) btn.disabled = worldIsUntouched();
  /* The codebase's own note above says this is "the one place that already
     runs after all of them", which makes it the right place to tell the file
     the world has moved. Cheap by construction: touch() serializes nothing. */
  durable.touch();
  // A world that changed under an armed button is a different question from
  // the one that was asked, so the arming does not survive it.
  if (resetArmedUntil) disarmReset();
}

async function resetWorld() {
  const before = {
    params: JSON.parse(JSON.stringify(engine.params)),
    records: engine.props.records().map((r) => ({ ...r })),
    sculpt: engine.sculptStrokes(),
    spawn: customSpawn ? { ...customSpawn } : null,
  };
  if (worldIsUntouched()) { toast("Nothing to reset — this world is as it opened", 2200); return; }

  /* Named rather than counted: "reset the world?" is a question about a verb,
     and what a person needs to weigh is the noun — the thing they are about
     to lose. */
  const parts = [];
  if (before.records.length) parts.push(`${before.records.length} placed ${before.records.length === 1 ? "piece" : "pieces"}`);
  if (before.sculpt.length) parts.push(`${before.sculpt.length} sculpt ${before.sculpt.length === 1 ? "stroke" : "strokes"}`);
  const lost = parts.join(" and ") || "the changes to this world";

  /* ── ask on the button, not in a dialog ──
     This was `confirm()`. A native dialog is the wrong instrument for a
     reversible action in a tool that already has a voice: it cannot be
     styled, it stops the world rendering behind it, it says "127.0.0.1
     says", and it costs a modal's worth of focus management for a question
     that undo already answers.
     So the button asks itself. The first press arms it and names what is at
     stake; the second, within five seconds, does it. A mis-press disarms on
     its own and costs nothing — and if somebody presses through both, ⌘Z is
     still behind them. */
  const now = performance.now();
  if (now > resetArmedUntil) {
    resetArmedUntil = now + RESET_ARM_MS;
    $("#btn-reset")?.classList.add("armed");
    announce("Reset?", `${lost} — press Reset again to put this world back`, RESET_ARM_MS);
    clearTimeout(resetWorld._disarm);
    resetWorld._disarm = setTimeout(disarmReset, RESET_ARM_MS);
    return;
  }
  disarmReset();

  const after = initialWorldState();
  const restore = async (state) => {
    await loadWorldState(state);
    customSpawn = state.spawn ? { ...state.spawn } : null;
    spawnTag = state.spawn ? worldTag() : null;
    refreshReset();
  };
  await restore({ ...after, spawn: null });
  markPristine();   // this IS the baseline again, so the button switches off

  undoStack.push({
    kind: "world",
    subject: `${engine.params.seed} · back to how it opened`,
    undo: () => restore(before),
    redo: () => restore({ ...after, spawn: null }),
  });
  announce("Reset", `${engine.params.seed} · ${lost} cleared`, 3200);
  console.info("[studio] reset to the landing world:", engine.params.seed, engine.params.biome);
}

/* ── the one thing between a reload and an hour of work ──
   NOTHING SURVIVES THIS TAB, on purpose: the world lives in memory and in
   whatever file the user saved. The cost is that a stray ⌘R, a closed tab or
   a followed link takes everything with it.
   This does not save anything, and it must not: it asks. The browser's own
   dialog is the right instrument here where it was the wrong one for Reset,
   because this is the one action in the product that genuinely cannot be
   undone, and it is the browser — not the page — that is about to do it.
   Only when there is something to lose, so the ordinary visit closes
   without ceremony. */
addEventListener("beforeunload", (ev) => {
  if (worldIsUntouched()) return;
  /* …unless the work is already on disk. A world kept in a file has nothing
     to lose to a closed tab, and a dialog that fires anyway is the kind that
     teaches people to dismiss the one that matters. `dirty` here is only the
     debounce window — a second or so — and that is worth asking about.

     Note this is a DIFFERENT question from worldIsUntouched(), which asks
     whether the world still matches the document it opened from. That one
     drives Reset and must keep meaning what it means. */
  const st = durable.state();
  if (st.linked && !st.dirty && !st.writing && !st.error) return;
  ev.preventDefault();
  ev.returnValue = "";   // some browsers still require the assignment
});

$("#btn-reset").addEventListener("click", resetWorld);
$("#btn-save").addEventListener("click", saveWorld);
$("#btn-open").addEventListener("click", () => $("#world-file").click());
$("#world-file").addEventListener("change", (e) => {
  if (e.target.files[0]) openWorldFile(e.target.files[0]);
  e.target.value = "";
});


/* ── pick spawn ── */
$("#btn-spawn").addEventListener("click", () => {
  if (engine.mode !== "orbit") engine.setMode("orbit");
  const next = !armedSpawn;
  disarmAll();
  armedSpawn = next;
  refreshTools();
  if (armedSpawn) toast("Tap the terrain to set the spawn point — Esc to cancel");
});

/* ── grass brush ──
   Grass is never generated for the dev: they paint every patch. Each click
   plants one patch; Shift-click removes the nearest; the tool stays armed
   until Esc or a second press. Patches live in params, so Play and export
   carry them automatically. */
$("#btn-grass").addEventListener("click", () => {
  if (engine.mode !== "orbit") engine.setMode("orbit");
  const next = !armedGrass;
  disarmAll();
  armedGrass = next;
  refreshTools();
  if (armedGrass) toast("Paint grass: drag across the terrain — hold Shift to erase, Esc to finish");
});

/* ══════════════════════════════════════════════════════════════════
   ICONS
   Every glyph in the chrome is drawn on one grid in icons.js and injected
   here. Markup carries the NAME of the icon, never the drawing, so the set
   can be redrawn in one file without touching the shell.
   ══════════════════════════════════════════════════════════════════ */
{
  // The slot is always an explicit [data-icon] when the host has any markup of
  // its own; falling back to the HOST for such an element would replace its
  // children with the glyph. That is how the gate's painted button lost its
  // image the first time the art went in — worth a guard rather than a comment.
  const put = (sel, name) => {
    const host = document.querySelector(sel);
    if (!host) return;
    const slot = host.querySelector("[data-icon]") || (host.firstElementChild ? null : host);
    if (slot) setHTML(slot, UI[name] || EMPTY);
  };
  const MAP = {
    "#btn-undo": "undo", "#btn-redo": "redo", "#btn-reset": "back",
    "#btn-cmd": "command",
    "#btn-save": "export", "#btn-open": "open", "#btn-keep": "keep",
    "#dock-close": "close",
    "#tool-select": "select", "#tool-blocks": "blocks", "#tool-sculpt": "sculpt",
    "#tool-river": "river",
    "#btn-grass": "grass", "#btn-spawn": "spawn", "#panel-toggle": "world", "#game-toggle": "play",
    "#tool-objects": "objects",
    // the object manager: its header switches, its navigation strip and the
    // verbs on a selected set
    "#obj-close": "close", "#obj-pins": "pin", "#obj-sound": "sound",
    "#obj-tools .ds-icon": "search",
    '#obj-nav [data-nav="prev"]': "prev", '#obj-nav [data-nav="next"]': "next",
    '#obj-nav [data-nav="focus"]': "focus", '#obj-nav [data-nav="orbit"]': "orbit",
    '#obj-nav [data-nav="all"]': "frameAll", '#obj-nav [data-nav="newest"]': "newest",
    '#obj-nav [data-nav="back"]': "back",
    '[data-batch="focus"]': "focus", '[data-batch="dup"]': "copy", '[data-batch="vary"]': "vary",
    '[data-batch="hide"]': "eyeOff", '[data-batch="lock"]': "lock", '[data-batch="del"]': "trash",
    '#explore-pills [data-mode="orbit"]': "orbit",
    '#explore-pills [data-mode="walk"]': "walk",
    '#explore-pills [data-mode="fly"]': "fly",
    '#sculpt-modes [data-mode="raise"]': "raise",
    '#sculpt-modes [data-mode="lower"]': "lower",
    '#sculpt-modes [data-mode="smooth"]': "smooth",
    '#sculpt-modes [data-mode="flatten"]': "flatten",
    '#weather-pills [data-weather="clear"]': "clear",
    '#weather-pills [data-weather="rain"]': "rain",
    '#weather-pills [data-weather="snow"]': "snow",
    '[data-act="focus"]': "focus", '[data-act="rotate"]': "rotate", '[data-act="dup"]': "copy",
    '[data-act="snap"]': "ground", '[data-act="shrink"]': "smaller", '[data-act="grow"]': "bigger",
    '[data-act="style"]': "style", '[data-act="ignite"]': "fire", '[data-act="delete"]': "trash",
    "#panel-close": "close", "#game-close": "close", "#dock-import": "plus",
    ".dock-search-wrap .ds-icon": "search", "#cmdk-field": "search",
  };
  for (const [sel, name] of Object.entries(MAP)) put(sel, name);
}

/* ══════════════════════════════════════════════════════════════════
   TELEMETRY
   The readout is the one piece of chrome that earns its space by being
   USEFUL rather than by being a label: what the ground is doing under the
   pointer, how high the camera is, how much you have built. Throttled to
   the engine's own frame event and written only when a value changed —
   the shell must never be the reason a frame is drawn.
   ══════════════════════════════════════════════════════════════════ */
{
  const elev = $("#tl-elev"), alt = $("#tl-alt"), blocks = $("#tl-blocks");
  let hoverY = null, hoverPx = null, last = { e: "", a: "", b: "" }, next = 0;
  /* THE MOVE HANDLER RECORDS A POINT; IT DOES NOT CAST A RAY. It used to do a
     full terrain raycast — plus a getBoundingClientRect, which is a layout
     read — on every single pointermove, to feed one number that is throttled
     to 8 Hz below and that `#telemetry` hides outright in simple mode, which
     is the shipping default. So the common case was hundreds of raycasts a
     second against the quadtree for a readout nobody could see.

     Now the cast happens where the number is actually used: at most 8 Hz, and
     not at all while the readout is hidden. `offsetParent` is null for an
     element that is display:none anywhere up its ancestry, which covers both
     the simple-mode rule and the two media queries. */
  canvas.addEventListener("pointermove", (e) => {
    if (engine.mode !== "orbit") return;
    hoverPx = [e.clientX, e.clientY];
  });
  canvas.addEventListener("pointerleave", () => { hoverPx = null; hoverY = null; });
  engine.on("frame", () => {
    const now = performance.now();
    if (now < next) return;
    next = now + 120; // 8 Hz is past the point anyone reads a changing number
    if (hoverPx && elev.offsetParent !== null) {
      const r = canvas.getBoundingClientRect();
      const p = engine.raycastGround(((hoverPx[0] - r.left) / r.width) * 2 - 1,
                                     -((hoverPx[1] - r.top) / r.height) * 2 + 1);
      hoverY = p ? p.y : null;
    } else if (!hoverPx) hoverY = null;
    const e = hoverY == null ? "—" : `${Math.round(hoverY)} m`;
    const a = `${Math.round(Math.max(engine.camera.position.y, 0))} m`;
    const b = String(engine.props.items.size);
    if (e !== last.e) { elev.textContent = last.e = e; }
    if (a !== last.a) { alt.textContent = last.a = a; }
    if (b !== last.b) { blocks.textContent = last.b = b; }
    // The edge chevrons ride the same throttle: their world positions are
    // fixed but their DISTANCES are not, and an object deleted while it was
    // being pointed at must stop being pointed at.
    syncEdgeCues();
  });
  // The block count is the answer to "how many have I placed" — so it is
  // also the door to the list of them.
  const tlBlocks = blocks.closest(".tl");
  if (tlBlocks) {
    tlBlocks.classList.add("clickable");
    tlBlocks.title = "Everything you have placed (M)";
    tlBlocks.addEventListener("click", () => setObjects(!objectsOpen()));
  }
}

/* ── the chart frame ──
   Ticks along each edge, longer at the quarters. Drawn once: it is the
   instrument frame the square map sits inside, and the reason a minimap in
   the corner reads as a survey chart rather than a thumbnail. */
{
  const g = document.querySelector("#chart-ring .ticks");
  if (g) {
    const IN = 12.5, OUT = 8.5, STEPS = 12; // inner edge, outer edge, ticks/side
    let svg = "";
    const tick = (x1, y1, x2, y2, major) =>
      `<line class="${major ? "major" : ""}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
    for (let i = 1; i < STEPS; i++) {
      const t = IN + (i / STEPS) * (100 - IN * 2);
      const major = i === STEPS / 2;
      const len = major ? 4 : 2.2;
      svg += tick(t, OUT, t, OUT + len, major);                 // top
      svg += tick(t, 100 - OUT, t, 100 - OUT - len, major);     // bottom
      svg += tick(OUT, t, OUT + len, t, major);                 // left
      svg += tick(100 - OUT, t, 100 - OUT - len, t, major);     // right
    }
    setHTML(g, trust(svg));
  }
}

/* ══════════════════════════════════════════════════════════════════
   COMMAND PALETTE
   Every biome, theme, block, site, mode, weather and action reachable by
   typing its name. Sources are rebuilt on each open so the list always
   describes the world as it stands.
   ══════════════════════════════════════════════════════════════════ */
const palette = new CommandPalette({
  root: $("#cmdk"), input: $("#cmdk-input"), list: $("#cmdk-list"),
  sources: () => {
    const out = [];
    const add = (group, name, icon, run, hint = "", keywords = "") =>
      out.push({ group, name, icon, run, hint, keywords });

    add("World", "Plant woods", "grass", plantWoods, "world", "trees forest plant vegetation scatter woods");
    add("World", "Travel to a seed…", "search", () => {
      const input = prompt("Travel to seed:", engine.params.seed);
      if (input) engine.setSeed(input);
    }, "", "goto jump");
    add("World", "Reset this world", "back", () => resetWorld(), "undoable",
      "revert restore start over clear original opened");
    add("World", "Frame the whole world", "focus", () => engine.frameWorld(true), "", "fit zoom out");
    add("World", "Save this world to a file", "export", () => saveWorld(), "⌘S",
      "save download export keep file world json");
    add("World", "Export world — Unity bundle, GLB, heightmap, site plan", "export", () => exportWorld(), "",
      "export glb gltf mesh heightmap masks slope flow ao unity blender zip download");
    add("World", "Open a world file…", "open", () => $("#world-file").click(), "⌘O",
      "open load import file world json restore");

    /* ── finding what you placed ──
       Every navigation move is here by name as well as on a key and in the
       panel, because the one thing somebody who has lost an object reliably
       remembers is ⌘K. */
    const placed = engine.props.items.size;
    add("Find", "Objects — everything placed", "objects", () => setObjects(true),
      `${placed}`, "manager list register inventory search find");
    add("Find", "Jump to the last placement", "newest", () => navigate("newest"), "G",
      "newest recent last where did it go");
    add("Find", "Frame every object", "frameAll", () => navigate("all"), "⇧A",
      "fit all show everything overview");
    add("Find", "Next object", "next", () => navigate("next"), "]", "cycle step through");
    add("Find", "Previous object", "prev", () => navigate("prev"), "[", "cycle step through");
    add("Find", "Back to the previous view", "back", () => navigate("back"), "V",
      "return undo camera where was i");
    add("Find", engine.pinsEnabled ? "Hide the marker pins" : "Show the marker pins", "pin",
      () => $("#obj-pins").click(), "", "markers cues clutter labels");

    for (const [key, p] of Object.entries(PALETTES)) {
      add("Biome", p.label, "world", () => engine.setBiome(key),
        engine.params.biome === key ? "current" : "", "palette terrain colour");
    }
    for (const [key, t] of Object.entries(THEMES)) {
      add("Structure theme", t.label, "blocks", () => engine.setStructureTheme(key),
        (engine.params.structure?.theme === key) ? "current" : "", "dress restyle buildings");
    }
    for (const [key, kind] of Object.entries(SITE_KINDS)) {
      add("Place a site", kind.label || key, "world", () => {
        setPanel(true);
        // Drive the card the panel already owns, so the selection and the
        // hint stay in one code path.
        [...siteCards.children].find((c) => c.dataset.site === key)?.click();
        armSite(true);
      }, "then click the ground", "settlement compose generate " + (kind.hint || ""));
    }
    for (const item of allItems()) {
      add("Place a block", item.label, "blocks", () => {
        setDock(true);
        const card = [...cardsEl.children].find((c) => c.querySelector(".label")?.textContent === item.label);
        card ? card.click() : null;
      }, item.category, "prop object build " + item.category);
    }
    for (const [m, label] of [["orbit", "Orbit"], ["walk", "Walk"], ["fly", "Fly"]]) {
      add("Camera", label, m, () => engine.setMode(m), engine.mode === m ? "current" : "", "mode view");
    }
    for (const w of ["clear", "rain", "snow"]) {
      add("Weather", w[0].toUpperCase() + w.slice(1), w, () => engine.setWeather(w),
        (engine.params.sky.weather || "clear") === w ? "current" : "", "sky rain snow storm");
    }
    for (const [label, hour] of [["Dawn", 6.2], ["Morning", 9], ["Noon", 12.5], ["Golden hour", 17.6], ["Dusk", 19.2], ["Night", 23]]) {
      add("Time of day", label, "clear", () => { engine.setTimeOfDay(hour); syncPanel(); },
        `${String(Math.floor(hour)).padStart(2, "0")}:${String(Math.round((hour % 1) * 60)).padStart(2, "0")}`, "sun light hour");
    }
    for (const [name, icon, run, keys] of [
      ["Select tool", "select", () => disarmAll(), "escape"],
      ["Sculpt terrain", "sculpt", () => $("#tool-sculpt").click(), "brush raise lower"],
      ["Carve a river", "river", () => $("#tool-river").click(), "water course channel stream lake"],
      ["Paint grass", "grass", () => $("#btn-grass").click(), "vegetation"],
      ["Set the spawn point", "spawn", () => $("#btn-spawn").click(), "player start"],
      ["Block library", "blocks", () => setDock(true), "dock catalog"],
      ["Object manager", "objects", () => setObjects(true), "list register placed inventory"],
      ["World settings", "world", () => setPanel(true), "panel inspector"],
    ]) add("Tools", name, icon, run, "", keys);

    add("Actions", "Undo", "undo", () => undoStack.undo(), "⌘Z", "revert");
    add("Actions", "Redo", "redo", () => undoStack.redo(), "⌘⇧Z", "");
    add("Tools", "Stage — hide the interface", "focus", () => setStage(!document.body.classList.contains("stage")),
      "\\", "clean screenshot present hide chrome");
    add("Tools", document.body.classList.contains("simple") ? "Advanced mode" : "Simple mode",
      "style", () => $("#btn-advanced").click(), "", "instruments sculpt terrain register import");
    add("Actions", "How Visigenesis works", "about", () => window.open("about.html", "_blank", "noopener"), "", "docs help showcase");
    if (selection.length) {
      const n = selection.length;
      add("Selection", "Focus the selection", "focus", () => navigate("focus"), "F", "frame zoom");
      add("Selection", "Orbit around it", "orbit", () => navigate("orbit"), "O", "turn spin around");
      add("Selection", "Delete selected", "trash", () => deleteSelected(), `${n}`, "remove");
      add("Selection", "Duplicate selected", "copy", () => duplicateSelected(), "D", "copy");
      add("Selection", "Randomize variation", "vary", () => varySelection([...selection]), "J",
        "vary jitter scatter rotate random natural");
      add("Selection", selection.every((u) => !engine.props.isVisible(u)) ? "Show selected" : "Hide selected",
        "eyeOff", () => setVisibility([...selection], !selection.some((u) => engine.props.isVisible(u))), "H", "visibility");
      add("Selection", selection.every((u) => engine.props.isLocked(u)) ? "Unlock selected" : "Lock selected",
        "lock", () => setLocked([...selection], !selection.every((u) => engine.props.isLocked(u))), "L", "freeze protect");
      add("Selection", "Set alight", "fire", () => {
        eachSelected((uid) => engine.igniteProp(uid));
        toast("Alight — it will char as it burns");
      }, "", "burn fire ignite");
    }
    return out;
  },
});
$("#btn-cmd").addEventListener("click", () => palette.show());
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") { e.preventDefault(); palette.toggle(); }
  // ⌘S and ⌘O mean what they mean everywhere else. Both are taken off the
  // browser: ⌘S would otherwise offer to save the DOM, and ⌘O would open a
  // file into the tab and navigate away from the world it is holding.
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyS" && !e.shiftKey && !e.altKey) { e.preventDefault(); saveWorld(); }
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyO" && !e.shiftKey && !e.altKey) { e.preventDefault(); $("#world-file").click(); }
}, true);

/* ── marker geometry ──
   Both deck markers are measured from the live DOM, so they survive font
   loading, a language change and every breakpoint without a hard-coded table
   of widths. */
addEventListener("resize", () => { syncDeck(); syncModeMarker(); });
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => { syncDeck(); syncModeMarker(); }).observe($("#deck"));
}

// The seed readout pulses when the world underneath it changes — the one
// place in the interface where motion announces state rather than answering
// an input.
engine.on("seed", () => {
  const el = $("#seed-text");
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
});

showSeed(); syncPanel(); refreshMinimap(); refreshTools();
undoStack.sync();
// The mode the session was left in — memory only, so a fresh tab opens simple.
setAdvanced(pref.get("wf-advanced") === "on");
// The register starts truthful about an empty world, and the sound switch
// starts showing the state it was left in.
syncObjectCount(); objects.refresh();
$("#obj-sound").setAttribute("aria-pressed", String(sound.enabled));
$("#obj-sound").classList.toggle("off", !sound.enabled);
setHTML($("#obj-sound span[data-icon]"), sound.enabled ? UI.sound : UI.soundOff);
/* Reduced motion is a request, not a preference to be weighed: the marks
   still appear, they simply stop travelling. The pins and the labels are
   static anyway, so what remains is a world that still says exactly what
   happened, without moving to say it. */
if (matchMedia("(prefers-reduced-motion: reduce)").matches) engine.markers.setMotion(false);
requestAnimationFrame(() => { syncDeck(); syncModeMarker(); });

/* ── coach ──
   First run only: three lines, one at a time, that teach through use. Each
   line waits for its move — look, shape, enter — and leaves the moment the
   move is made (or a few seconds pass). Never a tutorial wall: the coach
   cannot take a pointer event, cannot open a panel and never comes back
   once the session has seen all three.

   It starts when the SESSION starts, which is the moment the gate is struck
   — coaching a world nobody has been handed yet is coaching an empty room. */
const COACH_KEY = "wf-coach-v1";
const COACH_STEPS = [
  // Three lines and no fourth. The first names the one move that makes the
  // product make sense, and it is the button rather than the brush: a person
  // who has never used a world editor should see a whole world before they are
  // asked to sculpt one.
  { html: trust("This ground is yours — <b>drag</b> to look around it"), hold: 7000 },
  { html: trust("<b>Worlds</b> builds a whole place in one click — cities, roads, furnished rooms") },
  { html: trust("Then <b>Blocks</b> to keep building, or <b>walk in</b> and stand in it"), cls: "coach-play" },
];
const coach = { step: -1, timer: 0 };
function coachSeen() {
  // Storage denied (private mode) counts as seen: better never to coach
  // than to coach on every single visit.
  return pref.get(COACH_KEY) === "1";
}
function coachShow(i) {
  clearTimeout(coach.timer);
  const el = $("#coach");
  if (i >= COACH_STEPS.length) {
    coach.step = COACH_STEPS.length;
    el.hidden = true;
    pref.set(COACH_KEY, "1");
    return;
  }
  const step = COACH_STEPS[i];
  coach.step = i;
  el.className = "mod " + (step.cls || "");
  el.hidden = true; void el.offsetWidth; // restart the entrance animation
  setHTML($("#coach-text"), step.html);
  el.hidden = false;
  coach.timer = setTimeout(() => coachShow(i + 1), step.hold || (i === 1 ? 9000 : 12000));
}
const coachAdvance = (from) => { if (coach.step === from) coachShow(from + 1); };
function coachStart() {
  if (coachSeen() || coach.step >= 0) return;
  coachShow(0);
  canvas.addEventListener("pointerdown", () => coachAdvance(0), { once: true, capture: true });
  $("#tool-seg").addEventListener("click", () => coachAdvance(1), { capture: true });
}

/* The world as it opened IS the baseline: the seed's own world, nothing placed on it. */
markPristine();

/* ── begin ──
   No entry film and no gate: the page opens as the editor, on the default
   world, every time. */
function beginSession() {
  setTimeout(coachStart, 900);
  // Phones: name the two gestures that nothing on screen can advertise.
  if (phone()) toast("Drag to orbit · pinch to zoom · tap Blocks to build", 4200);
}
document.body.classList.remove("gate");
$("#gate")?.remove();
beginSession();
