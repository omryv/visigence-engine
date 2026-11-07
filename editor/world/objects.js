/* objects.js — the Object Manager.
 *
 * The editor could always place a thing and never once say what was in the
 * world. Every question an author actually has after ten minutes of work —
 * how many did I place, where is the one I did first, which of these is the
 * one I keep selecting by accident — had the same answer, which was to orbit
 * around and look. This panel is that answer replaced with a list.
 *
 * WHAT IT IS FOR, in one line each:
 *
 *   THE COUNT      is in the header, always, unasked.
 *   THE SEARCH     finds by name, by type, by category, by uid.
 *   THE FILTERS    are chips, and they AND together.
 *   THE ROW        is thumbnail, name, type, coordinates, actions — the
 *                  coordinates matter, because they are what make two
 *                  identical oaks two different objects.
 *   THE NAVIGATION is a strip, not a menu: previous, next, focus, orbit,
 *                  frame all, jump to newest, back to where you were.
 *   THE BATCH BAR  appears only when more than one thing is selected, and
 *                  offers exactly what a set of objects can be told to do.
 *
 * Two things it does NOT do, deliberately. It does not own the selection —
 * the shell does, and this panel is one of several ways to change it, so
 * selecting in the world lights the row and selecting the row lights the
 * world. And it does not own the placements: it reads records and calls
 * back, so there is exactly one truth about what is in the world and it is
 * the engine's.
 *
 * SCALE. The list renders a WINDOW, not the world: a world with four
 * thousand placements paints eighty rows and grows the window as you scroll.
 * The filter and the sort still run over everything — the count in the
 * header is the truth — but the DOM only ever holds what a person can see.
 */

import { UI, blockIcon } from "./icons.js";
import { html, setHTML } from "../../src/genesis/trusted.js";
import {
  toRow, selectRows, summarise, formatXZ, cssColor, uidIndex,
} from "../../src/genesis/world/object-index.js";

const PAGE = 80;         // rows painted per window step
const RECENT = 10;       // how many placements "Recent" means

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export class ObjectManager {
  /* `api` is the whole contract with the shell — every verb the panel can
     speak, and nothing about how any of them is done. */
  constructor({ root, api, categories = [] }) {
    this.root = root;
    this.api = api;
    this.categories = categories.filter((c) => c !== "all");
    this.query = "";
    this.category = "all";
    this.sort = "newest";
    this.flags = { favorites: false, hidden: false, locked: false, recent: false };
    this.window = PAGE;
    this.favorites = new Set();
    this.rows = [];       // the full normalised set, newest first
    this.visible = [];    // what survived the filter, in sort order
    this.selection = [];
    this._build();
  }

  /* ── favourites ──
     Editor state, not world state, so it never enters params — a starred oak
     is a note to self about a session. Memory only; stars go with the tab. */
  _saveFavorites() {
    this.favorites = new Set([...this.favorites].slice(-400));
  }

  /* ── chrome ── */
  _build() {
    const r = this.root;
    this.countEl = r.querySelector("#obj-count");
    this.searchEl = r.querySelector("#obj-search");
    this.catsEl = r.querySelector("#obj-cats");
    this.sortEl = r.querySelector("#obj-sort");
    this.listEl = r.querySelector("#obj-list");
    this.batchEl = r.querySelector("#obj-batch");
    this.batchLabel = r.querySelector("#obj-batch-label");
    this.navEl = r.querySelector("#obj-nav");
    this.flagsEl = r.querySelector("#obj-flags");

    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value;
      this.window = PAGE;
      this.render();
    });

    // Category chips: the same rail idiom as the block dock, so the two
    // catalogues of the same world read as one system.
    const mkChip = (label, value) => {
      const b = el("button", "cat-chip" + (value === "all" ? " active" : ""), label);
      b.type = "button";
      b.dataset.cat = value;
      b.addEventListener("click", () => {
        this.category = value;
        this.window = PAGE;
        for (const c of this.catsEl.children) c.classList.toggle("active", c.dataset.cat === value);
        this.render();
      });
      return b;
    };
    this.catsEl.appendChild(mkChip("All", "all"));
    for (const c of this.categories) this.catsEl.appendChild(mkChip(c, c));

    for (const b of this.flagsEl.querySelectorAll("[data-flag]")) {
      b.addEventListener("click", () => {
        const k = b.dataset.flag;
        this.flags[k] = !this.flags[k];
        b.classList.toggle("on", this.flags[k]);
        this.window = PAGE;
        this.render();
      });
    }

    this.sortEl.addEventListener("change", () => {
      this.sort = this.sortEl.value;
      this.window = PAGE;
      this.render();
    });

    this.navEl.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset?.nav;
      if (act) this.api.navigate(act);
    });

    this.batchEl.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset?.batch;
      if (act) this.api.batch(act, [...this.selection]);
    });

    /* One listener for the whole list. With a window of eighty rows and a
       world of four thousand, per-row listeners would be the most expensive
       thing in the panel. */
    this.listEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      const row = e.target.closest(".obj-row");
      if (!row) return;
      const uid = row.dataset.uid;
      if (btn) {
        e.stopPropagation();
        this._rowAction(btn.dataset.act, uid);
        return;
      }
      // Plain click selects; a modified click extends, exactly like the
      // world. Nothing about selection should behave differently depending
      // on which surface you did it on.
      this.api.select(uid, e.shiftKey || e.metaKey || e.ctrlKey);
    });
    this.listEl.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".obj-row");
      if (row) this.api.navigate("focus", row.dataset.uid);
    });
    // Keyboard: the list is a listbox, and ↑↓ walk it whether or not the
    // pointer is anywhere near.
    this.listEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const rows = [...this.listEl.querySelectorAll(".obj-row")];
      const at = rows.findIndex((n) => n.dataset.uid === this.selection[0]);
      const next = rows[Math.min(Math.max(at + (e.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1)];
      if (next) this.api.select(next.dataset.uid, false);
    });
    // Growing the window on approach, rather than on a button, is what keeps
    // a four-thousand-object world feeling like a list instead of a page.
    this.listEl.addEventListener("scroll", () => {
      if (this.window >= this.visible.length) return;
      const { scrollTop, clientHeight, scrollHeight } = this.listEl;
      if (scrollTop + clientHeight > scrollHeight - 260) {
        this.window += PAGE;
        this.render();
      }
    }, { passive: true });
  }

  _rowAction(act, uid) {
    if (act === "fav") {
      if (this.favorites.has(uid)) this.favorites.delete(uid);
      else this.favorites.add(uid);
      this._saveFavorites();
      this.refresh();
      return;
    }
    this.api.rowAction(act, uid);
  }

  isFavorite(uid) { return this.favorites.has(uid); }

  /* ── the data ──
     Rebuilt from records on every change. Normalising four thousand records
     is a few milliseconds and happens on placement, not per frame; the
     alternative is an index that can disagree with the world, which is the
     bug this whole panel exists to make impossible. */
  refresh() {
    const records = this.api.records();
    const cat = this.api.catalogue();
    this.rows = records.map((rec) => toRow(rec, {
      catalogue: cat,
      favorite: this.favorites.has(rec.uid),
      hidden: !this.api.isVisible(rec.uid),
      locked: this.api.isLocked(rec.uid),
    }));
    this.summary = summarise(this.rows);
    this.render();
  }

  render() {
    const recentUids = this.flags.recent
      ? [...this.rows].sort((a, b) => b.order - a.order).slice(0, RECENT).map((r) => r.uid)
      : null;
    this.visible = selectRows(this.rows, {
      query: this.query, category: this.category, sort: this.sort,
      favorites: this.flags.favorites, hidden: this.flags.hidden, locked: this.flags.locked,
      recentUids, viewer: this.api.viewer?.() || null,
    });

    const total = this.rows.length;
    const shown = this.visible.length;
    this.countEl.textContent = shown === total ? String(total) : `${shown}/${total}`;
    this.countEl.title = `${total} object${total === 1 ? "" : "s"} placed`;

    // Category chips carry their own counts — a chip that would show nothing
    // says so before it is pressed.
    for (const chip of this.catsEl.children) {
      const c = chip.dataset.cat;
      const n = c === "all" ? total : (this.summary.byCategory.get(c) || 0);
      chip.dataset.n = n;
      chip.classList.toggle("empty", n === 0);
    }

    if (this.api.isOpen && !this.api.isOpen()) { this._syncBatch(); return; }

    if (!total) {
      setHTML(this.listEl, html`<div class="obj-empty">
        <b>Nothing placed yet.</b>
        <span>Open <b>Blocks</b>, pick something and click the ground. Everything you
        place lands here, with a way back to it.</span></div>`);
      this._syncBatch();
      return;
    }
    if (!shown) {
      setHTML(this.listEl, html`<div class="obj-empty"><b>No match.</b>
        <span>${this.rows.length} object${this.rows.length === 1 ? "" : "s"} are placed —
        try another name, or clear the filters.</span></div>`);
      this._syncBatch();
      return;
    }

    /* The MODEL is always rebuilt — navigation walks `this.visible`, and a
       stale order is how "next object" lands on something that was deleted
       two minutes ago. The DOM is not: painting eighty rows into a panel
       nobody is looking at is the one part of this that can be skipped. */
    if (this.api.isOpen && !this.api.isOpen()) return;

    const page = this.visible.slice(0, this.window);
    const sel = new Set(this.selection);
    const newest = this.api.newest?.();
    /* Names come from a catalogue AND from dropped filenames, so every one of
       them below is an interpolation into html`` — escaped on the way in,
       inside attributes as well as inside text. The title attribute is called
       out because it is the one that got away: `title="${name}"` closed on the
       first quote in a filename and everything after it was markup. */
    const rows = page.map((r) => html`<div class="obj-row${sel.has(r.uid) ? " sel" : ""}${r.hidden ? " off" : ""}"
        role="option" aria-selected="${String(sel.has(r.uid))}" data-uid="${r.uid}"
        title="${r.name} · ${r.category} · ${formatXZ(r.x, r.y, r.z)}">
        <span class="or-thumb" data-tint="${cssColor(r.color)}">${blockIcon(r.name)}</span>
        <span class="or-main">
          <b>${r.name}${r.uid === newest ? html`<i class="or-new">newest</i>` : ""}</b>
          <i>${r.category}${r.placeholder ? " · loading" : ""}</i>
        </span>
        <span class="or-xyz mono">${formatXZ(r.x, r.y, r.z)}</span>
        <span class="or-acts">
          <button type="button" data-act="fav" class="${r.favorite ? "on" : ""}"
            title="${r.favorite ? "Remove from favourites" : "Favourite"}" aria-label="Favourite">${UI.star}</button>
          <button type="button" data-act="vis" class="${r.hidden ? "on" : ""}"
            title="${r.hidden ? "Show" : "Hide"}" aria-label="Toggle visibility">${r.hidden ? UI.eyeOff : UI.eye}</button>
          <button type="button" data-act="lock" class="${r.locked ? "on" : ""}"
            title="${r.locked ? "Unlock" : "Lock"}" aria-label="Toggle lock">${r.locked ? UI.lock : UI.unlock}</button>
          <button type="button" data-act="focus" title="Focus the camera on it" aria-label="Focus">${UI.focus}</button>
          <button type="button" data-act="del" class="danger" title="Delete" aria-label="Delete">${UI.trash}</button>
        </span>
      </div>`);
    const more = this.visible.length > page.length
      ? html`<div class="obj-more">${this.visible.length - page.length} more — keep scrolling</div>`
      : "";
    setHTML(this.listEl, html`${rows}${more}`);
    /* The category tint rides a data attribute and is applied through the
       CSSOM, not through a style attribute: the policy allows no inline
       styles at all, and a custom property set this way is the same pixel
       with none of the hole. */
    for (const thumb of this.listEl.querySelectorAll(".or-thumb[data-tint]")) {
      thumb.style.setProperty("--tint", thumb.dataset.tint);
    }
    this._syncBatch();
  }

  // The shell owns the selection; this keeps the list honest about it
  // without a full repaint, and brings the selected row into view because a
  // highlight you have to scroll to find is not a highlight.
  setSelection(uids) {
    this.selection = [...uids];
    const sel = new Set(uids);
    let first = null;
    for (const node of this.listEl.querySelectorAll(".obj-row")) {
      const on = sel.has(node.dataset.uid);
      node.classList.toggle("sel", on);
      node.setAttribute("aria-selected", String(on));
      if (on && !first) first = node;
    }
    // Selected in the world, out of the window here: paint the row in.
    if (!first && uids.length && this.visible.some((r) => sel.has(r.uid))) {
      const at = this.visible.findIndex((r) => sel.has(r.uid));
      if (at >= this.window) { this.window = Math.ceil((at + 1) / PAGE) * PAGE; this.render(); return; }
    }
    first?.scrollIntoView({ block: "nearest" });
    this._syncBatch();
  }

  _syncBatch() {
    const n = this.selection.length;
    this.batchEl.hidden = n < 2;
    if (n >= 2) this.batchLabel.textContent = `${n} selected`;
  }

  /* Every uid in the current filtered order — what "next object" means when
     a filter is on. Stepping through a search result is the whole reason the
     navigation lives in this panel rather than on the deck. */
  order() { return this.visible.map((r) => r.uid); }
  nextFrom(uid, step) {
    const list = this.order();
    if (!list.length) return null;
    const at = list.indexOf(uid);
    if (at < 0) return list[step > 0 ? 0 : list.length - 1];
    return list[(at + step + list.length) % list.length];
  }
  newestUid() {
    let best = null;
    for (const r of this.rows) if (!best || r.order > uidIndex(best)) best = r.uid;
    return best;
  }
}
