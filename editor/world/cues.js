import { trust, setHTML } from "../../src/genesis/trusted.js";
/* cues.js — the two marks that live on the screen rather than in the world.
 *
 * Everything else in this redesign is drawn in three dimensions, because a
 * mark in the world is a mark you can orbit around. These two cannot be:
 *
 *   THE LABEL. "Oak Tree / Placed", floating over the thing that just
 *   landed, gone in three seconds. It has to be readable at any distance,
 *   which a world-space label is not — a text mesh 900 m away is a smear —
 *   and it has to be readable over a snow field and over a night sky, which
 *   is a job for a chip with a background, not for a glowing sprite.
 *
 *   THE EDGE POINTER. The object is real, it is placed, and it is behind
 *   you. There is no mark that can be drawn in the world for something that
 *   is not in the frame, so the frame itself has to point at it: a chevron
 *   riding the edge of the screen, angled at the thing, with its name and
 *   how far away it is. This is the last hole in "never lose an object" —
 *   pins answer "too small to see", this answers "not on screen at all".
 *
 * COST. Both are driven off the engine's own frame event and throttled to
 * 24 Hz, and both do nothing at all — not one projection — when there is
 * nothing to show, which is the normal state of the editor. The pointer set
 * is bounded by the caller (selection, newest, favourites), never by the
 * size of the world: a screen edge with forty chevrons on it is a fence.
 */

const EDGE = 34;        // how far in from the edge a chevron rides, in px
const MAX_POINTERS = 6; // past this the edge is decoration, not information
const HZ = 24;

export class Cues {
  constructor({ root, engine }) {
    this.engine = engine;
    this.root = root;
    this.labels = [];      // live floating labels
    this.tracked = [];     // what the edge is pointing at
    this.pointers = new Map(); // uid → element, reused across frames
    this._next = 0;
    this.enabled = true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.clear();
  }

  clear() {
    for (const l of this.labels) l.node.remove();
    this.labels.length = 0;
    for (const node of this.pointers.values()) node.remove();
    this.pointers.clear();
    this.tracked = [];
  }

  /* ── the placement label ──
     Two lines: what it is, and what just happened to it. The second line is
     the one that answers "did it place?", so it is never omitted and never
     abbreviated. */
  say({ x, y, z, title, note = "Placed", ms = 3000, tone = "" }) {
    if (!this.enabled) return null;
    const node = document.createElement("div");
    node.className = "cue-label" + (tone ? " " + tone : "");
    setHTML(node, trust(`<b></b><i></i>`));
    node.querySelector("b").textContent = title;
    node.querySelector("i").textContent = note;
    this.root.appendChild(node);
    const label = { node, x, y, z, until: performance.now() + ms, ms };
    this.labels.push(label);
    this._place(label, performance.now());
    return label;
  }

  /* What the edges point at. The caller decides the set — it is always a
     handful of things the author has said they care about, never the world. */
  track(list) {
    this.tracked = (list || []).slice(0, MAX_POINTERS);
    if (!this.tracked.length) {
      for (const node of this.pointers.values()) node.remove();
      this.pointers.clear();
    }
  }

  /* ── the frame ──
     One early return covers the whole idle case: no labels, no tracked
     objects, no work. */
  tick() {
    if (!this.enabled) return;
    if (!this.labels.length && !this.tracked.length) return;
    const now = performance.now();
    if (now < this._next) return;
    this._next = now + 1000 / HZ;

    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i];
      if (now > l.until) { l.node.remove(); this.labels.splice(i, 1); continue; }
      this._place(l, now);
    }
    this._edges();
  }

  _place(label, now) {
    const p = this.engine.screenPoint(label.x, label.y, label.z);
    // Behind the camera, or off the edge: the label stops being a label. The
    // edge pointer is what covers that case, and two marks for one object at
    // once is noise.
    const off = p.behind || p.x < -60 || p.y < -40 || p.x > p.w + 60 || p.y > p.h + 40;
    label.node.classList.toggle("gone", off);
    if (off) return;
    label.node.style.transform = `translate(-50%, -100%) translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    // The last 700 ms fade rather than cut, so the label leaves the way it
    // arrived.
    const left = label.until - now;
    label.node.style.opacity = left < 700 ? String(Math.max(left / 700, 0)) : "1";
  }

  _edges() {
    const seen = new Set();
    for (const t of this.tracked) {
      const p = this.engine.screenPoint(t.x, t.y, t.z);
      const inside = !p.behind && p.x > EDGE && p.y > EDGE && p.x < p.w - EDGE && p.y < p.h - EDGE;
      if (inside) continue; // it is on screen; the world's own marks have it
      seen.add(t.uid);
      let node = this.pointers.get(t.uid);
      if (!node) {
        node = document.createElement("div");
        node.className = "cue-edge";
        setHTML(node, trust(`<span class="ce-arrow"></span><span class="ce-name"></span>`));
        node.addEventListener("click", () => t.onClick?.());
        this.root.appendChild(node);
        this.pointers.set(t.uid, node);
      }
      const cx = p.w / 2, cy = p.h / 2;
      /* A point behind the camera projects MIRRORED — straight ahead of you
         on screen when it is directly at your back. Flipping the vector is
         what stops the chevron pointing at the exact wrong edge, and it is
         the one piece of arithmetic here that is not obvious. */
      let dx = p.x - cx, dy = p.y - cy;
      if (p.behind) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      // Cast the direction onto the inset rectangle: whichever axis leaves
      // the box first is the edge it rides.
      const halfW = cx - EDGE, halfH = cy - EDGE;
      const s = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
      /* Then pull the chevron back in by its own size. Riding the inset
         rectangle puts the CENTRE of the pill on the edge, which for a pill
         carrying a name and a distance means half the name is off the
         screen — a signpost with its writing outside the frame. */
      const bw = node.offsetWidth / 2 + 6, bh = node.offsetHeight / 2 + 6;
      const ex = Math.min(Math.max(cx + dx * s, bw), p.w - bw);
      const ey = Math.min(Math.max(cy + dy * s, bh), p.h - bh);
      node.style.transform = `translate(-50%, -50%) translate(${Math.round(ex)}px, ${Math.round(ey)}px)`;
      node.querySelector(".ce-arrow").style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
      const name = node.querySelector(".ce-name");
      const dist = t.distance != null ? ` · ${Math.round(t.distance)} m` : "";
      const text = (t.label || "Object") + dist;
      if (name.textContent !== text) name.textContent = text;
      node.classList.toggle("hot", !!t.hot);
    }
    for (const [uid, node] of this.pointers) {
      if (!seen.has(uid)) { node.remove(); this.pointers.delete(uid); }
    }
  }
}
