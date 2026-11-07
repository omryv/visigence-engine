// The command palette. ⌘K / Ctrl-K, or the button in the action bar.
//
// It exists because the old shell had exactly one way to reach anything: find
// the right panel, scroll to the right section, click the right row. Every
// biome, every one of the 51 blocks, every site recipe, both exports and all
// three camera modes were somewhere in that tree. A palette flattens the tree
// — you type "volcanic", "tower", "rain", "walk" and it happens — and it is
// the single change that makes the tool feel like it was built for someone
// who uses it every day rather than someone seeing it for the first time.
//
// The shell owns every action; this module owns only the search, the ranking
// and the keyboard. It never touches the engine directly.

import { UI } from "./icons.js";
import { html, setHTML } from "../../src/genesis/trusted.js";

const norm = (s) => String(s).toLowerCase();

/* Subsequence match with a light score: a prefix hit outranks a word-start
   hit, which outranks a scattered one. Enough to put "vol" → Volcanic at the
   top without pulling in a fuzzy-search dependency the repo does not have. */
function score(query, text) {
  const q = norm(query), t = norm(text);
  if (!q) return 1;
  if (t.startsWith(q)) return 1000 - t.length;
  const at = t.indexOf(q);
  if (at === 0) return 900;
  if (at > 0) return (/\s|·|-/.test(t[at - 1]) ? 700 : 400) - at;
  // scattered subsequence
  let i = 0, gaps = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return 200 - Math.min(gaps, 90);
  }
  return -1;
}

export class CommandPalette {
  /* sources: () => [{ group, name, hint, icon, run, keywords }] — re-read on
     every open so the list always reflects the live world (current biome,
     what is placed, which mode you are in). */
  constructor({ root, input, list, sources }) {
    this.root = root;
    this.input = input;
    this.list = list;
    this.sources = sources;
    this.items = [];
    this.filtered = [];
    this.index = 0;
    this.open = false;

    input.addEventListener("input", () => this.refilter());
    input.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("pointerdown", (e) => { if (e.target === root) this.hide(); });
    list.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".cmd-item");
      if (!el) return;
      e.preventDefault();
      this.runAt(Number(el.dataset.i));
    });
    // Hover moves the selection so mouse and keyboard never disagree about
    // what ↵ will run.
    list.addEventListener("pointermove", (e) => {
      const el = e.target.closest(".cmd-item");
      if (!el) return;
      const i = Number(el.dataset.i);
      if (i !== this.index) { this.index = i; this.paint(); }
    });
  }

  show() {
    this.items = this.sources();
    this.root.hidden = false;
    this.open = true;
    this.input.value = "";
    this.refilter();
    // Focus after paint so the caret lands, and iOS actually raises the keyboard.
    requestAnimationFrame(() => this.input.focus());
  }

  hide() {
    if (!this.open) return;
    this.root.hidden = true;
    this.open = false;
    this.input.blur();
  }

  toggle() { this.open ? this.hide() : this.show(); }

  refilter() {
    const q = this.input.value.trim();
    if (!q) {
      // No query: the sources are already written in a sensible order, and
      // they arrive grouped. Re-sorting would only scramble them.
      this.filtered = this.items.slice(0, 60);
      this.index = 0;
      return this.paint();
    }
    const scored = [];
    for (const it of this.items) {
      const hay = it.name + " " + (it.keywords || "") + " " + (it.group || "");
      const s = Math.max(score(q, it.name) + 30, score(q, hay));
      if (s > 0) scored.push({ it, s });
    }
    scored.sort((a, b) => b.s - a.s || a.it.name.localeCompare(b.it.name));

    /* Cluster by group, ordering the groups by their own best hit. Ranking
       alone interleaves them — "volcan" put Biome, Place a block, Biome,
       Place a block down the list, so the same two headers repeated four
       times and the list read as broken. Best match still leads overall; it
       simply brings its section with it. */
    const order = [], byGroup = new Map();
    for (const { it } of scored) {
      const g = it.group || "";
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g).push(it);
    }
    this.filtered = order.flatMap((g) => byGroup.get(g)).slice(0, 60);
    this.index = 0;
    this.paint();
  }

  /* Rows carry catalogue names, and a catalogue name can be the filename of a
     dropped GLB — so every field below is an interpolation into html``, which
     escapes it. The icon is the one exception and it is a literal from
     icons.js, not data. */
  paint() {
    if (!this.filtered.length) {
      setHTML(this.list, html`<div class="cmd-empty">Nothing matches that.</div>`);
      return;
    }
    let group = null;
    const rows = this.filtered.map((it, i) => {
      const head = it.group !== group ? html`<div class="cmd-group">${it.group}</div>` : "";
      group = it.group;
      return html`${head}<button type="button" class="cmd-item" role="option" data-i="${i}"
                 aria-selected="${String(i === this.index)}">
                 <span class="ci-icon">${UI[it.icon] || UI.command}</span>
                 <span class="ci-name">${it.name}</span>
                 ${it.hint ? html`<span class="ci-hint">${it.hint}</span>` : ""}
               </button>`;
    });
    setHTML(this.list, html`${rows}`);
    this.scrollToSelected();
  }

  scrollToSelected() {
    const el = this.list.querySelector(`[data-i="${this.index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }

  onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); return this.hide(); }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      this.index = Math.min(this.index + 1, this.filtered.length - 1);
      return this.paintSelection();
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      this.index = Math.max(this.index - 1, 0);
      return this.paintSelection();
    }
    if (e.key === "Enter") { e.preventDefault(); return this.runAt(this.index); }
  }

  // Moving the selection must not re-render the whole list — that would drop
  // the caret and make holding ↓ feel like a slideshow.
  paintSelection() {
    for (const el of this.list.querySelectorAll(".cmd-item")) {
      el.setAttribute("aria-selected", String(Number(el.dataset.i) === this.index));
    }
    this.scrollToSelected();
  }

  runAt(i) {
    const it = this.filtered[i];
    if (!it) return;
    this.hide();
    try { it.run(); }
    catch (err) { console.warn("[cmdk] command failed:", err.message); }
  }
}
