/* make.js — the vending machine's thirty verbs, and nothing else.
 *
 * Everything heavy here is borrowed: the engine is the editor's engine, the
 * build is buildWorld (the same one press the editor's palette fires), the
 * download is the export bundle. This file is only the SHELL — one input,
 * one button, a few verbs — and its design rule is stated in make.html:
 * the page never grows a second control.
 *
 * Nothing here is stored: the page keeps everything in memory and the one
 * thing that leaves is the file a visitor downloads.
 */

import { Engine, bakeHeightField } from "../../src/genesis/Engine.js";
import { CANONICAL_RES } from "../../src/kernel/terrain/canonical.js";
import { buildWorld, WORLDS } from "../../src/genesis/world/worlds.js";
import { briefToPlan } from "../../src/genesis/world/make-brief.js";
import { DEFAULT_WORLD } from "../../src/genesis/world/default-world.js";
import { paramsFromWorldFile, buildWorldFile, serializeWorldFile, worldFileName } from "../../src/genesis/world/worldfile.js";
import { buildExportBundle } from "../../src/genesis/world/export-world.js";
import { encodeZip } from "../../src/genesis/world/export/zip.js";

const $ = (s) => document.querySelector(s);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* The backdrop: the default world, dimmed under the ask card, so the machine
   opens onto a real place instead of a void — and so the engine is warm by
   the time the first brief lands. */
const engine = new Engine($("#viewport"), paramsFromWorldFile(DEFAULT_WORLD));
window.engine = engine; // console access is the debug UI, as in the editor
/* Pins are a finding aid for AUTHORED objects, and nothing on this page is
   authored — the editor turns them off after a generate for the same reason
   (a marker cloud over a made town is a wall of plastic, not a map). */
engine.setPinsEnabled(false);

const askEl = $("#ask");
const statusEl = $("#status");
const verbsEl = $("#verbs");
const hintEl = $("#hint");
const briefEl = $("#brief");

let busy = false;
let made = null;    // { plan, built, doc } once a world has been made
let lastField = null;
const field = () => {
  if (!lastField) lastField = bakeHeightField(engine.params, CANONICAL_RES, (x, z) => engine.sampleHeight(x, z));
  return lastField;
};

function state(name) {
  document.body.className = name;
  askEl.hidden = name !== "asking";
  statusEl.hidden = name !== "building";
  verbsEl.hidden = name !== "made";
  hintEl.hidden = name !== "walking";
}

function say(line) {
  statusEl.textContent = line;
}

/* ── the one press ── */
async function make(roll) {
  if (busy) return;
  busy = true;
  lastField = null;
  const plan = briefToPlan(briefEl.value, { roll });
  state("building");
  say("reading the ground…");
  try {
    const built = await buildWorld({
      engine, id: plan.id, seed: plan.seed, dress: plan.dress,
      hooks: { stage: (stage, detail) => { if (stage) say(detail ? `${stage} — ${detail}` : stage); } },
    });
    made = { plan, built, doc: null };
    /* WHAT IT HEARD, UNDER WHAT WAS TYPED. Not decoration: the brief now moves
       four or five real controls, and a page that silently applies them is a
       page whose only feedback is "the light looks different, maybe". One line
       of the same hairline type, listing what was read and — the half that
       matters — what was asked for and is not wired yet, so a person who typed
       "a castle on a hill" is told there is no castle rather than left to
       wonder which part of the village was the castle. */
    $("#v-brief-text").textContent = plan.brief || plan.seed;
    const gaps = plan.unmet.map((u) => u.say);
    const readOut = [WORLDS[plan.id].label, ...plan.reading].join(" · ");
    $("#v-brief-read").textContent = gaps.length
      ? `${readOut} — not yet: ${gaps.join(", ")}`
      : readOut;
    say("");
    engine.frameWorld(!reduceMotion);
    state("made");
  } catch (err) {
    console.error(err);
    say(`That one would not build — ${err.message}. Try other words.`);
    setTimeout(() => state("asking"), 2600);
  } finally {
    busy = false;
  }
}

/* ── the three verbs ── */

function walkIn() {
  if (!made) return;
  const { x, z } = made.built.spawn;
  engine.setMode("walk", { x, y: engine.sampleHeight(x, z) + 1.7, z });
  state("walking");
}
function walkOut() {
  if (document.body.className !== "walking") return;
  engine.setMode("orbit");
  engine.frameWorld(true);
  state("made");
}

/* Take it: the export bundle the editor ships, with the world FILE riding
   along — results and instructions in one zip, so what leaves this page can
   be reopened here as well as opened in Unity. */
function takeIt() {
  if (!made || busy) return;
  let url = null;
  try {
    const doc = currentDoc();
    const delta = engine.erosionDelta();
    const f = field();
    const bundle = buildExportBundle({
      params: engine.params,
      field: f,
      delta: delta && delta.res === f.res ? delta.data : null,
      origin: made.plan.id,
      records: engine.props.records(),
      interiors: made.built.interiors || [],
      spawn: made.built.spawn,
      boundsFor: (uid) => {
        const it = engine.props.get(uid);
        return it?.size ? { size: it.size, above: it.hAbove ?? it.size, below: it.hBelow ?? 0 } : null;
      },
    });
    bundle.files.push({ name: worldFileName(doc), bytes: new TextEncoder().encode(serializeWorldFile(doc)) });
    const blob = new Blob([encodeZip(bundle.files)], { type: "application/zip" });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = bundle.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    console.warn("[make] take:", err);
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function currentDoc() {
  if (!made.doc) {
    made.doc = buildWorldFile({
      params: engine.params,
      propRecords: engine.props.records(),
      field: field(),
      world: made.plan.id,
      spawn: { x: made.built.spawn.x, z: made.built.spawn.z },
    });
  }
  return made.doc;
}

/* ── wiring ── */

$("#make").addEventListener("click", () => make(0));
briefEl.addEventListener("keydown", (ev) => {
  ev.stopPropagation();
  if (ev.key === "Enter") make(0);
});

$("#v-walk").addEventListener("click", walkIn);
$("#v-again").addEventListener("click", () => make((made?.plan.roll ?? 0) + 1));
$("#v-take").addEventListener("click", takeIt);
$("#v-brief").addEventListener("click", () => { state("asking"); briefEl.focus(); briefEl.select(); });

addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") walkOut();
});
document.addEventListener("pointerlockchange", () => {
  // Walk mode holds the pointer; the browser gives it back on Esc without
  // the keydown always reaching us. Losing the lock while walking IS the
  // exit gesture.
  if (!document.pointerLockElement) walkOut();
});

briefEl.focus();
