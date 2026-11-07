// On-screen controls for phones and tablets: a floating movement stick on the
// left, a look pad on the right, and a configurable button cluster. Drives the
// SAME walk/fly controllers the keyboard does by writing their input fields,
// so nothing downstream knows or cares which device is playing.
//
// Pointer Lock does not exist on iOS Safari, which is exactly why this layer
// exists — the controllers' lock path stands down while this is attached.
//
// Everything is pointer events with per-pointer ids, so stick + look + button
// work simultaneously (you can strafe, aim and fire at once).
//
// The look of it is ONE CONSTRUCTED STYLESHEET, adopted per document. The
// origin's content policy forbids inline styles outright, which rules out the
// <style> element this used to append — see the note at the adoption site.

import { trust, element } from "../trusted.js";

// One adoption per document, not one per mount: two players on one page would
// otherwise stack the same rules twice.
const adopted = new WeakSet();

/* ── WHY THE ROOT CARRIES NO z-index, AND THE TWO HALVES CARRY THEIR OWN ──
   The root used to be `z-index: 30`, which made it a stacking context holding
   BOTH halves of this overlay at one depth — and 30 was above every piece of
   chrome an editor is likely to put on screen. The look pad is `inset: 0`
   below 12%, `pointer-events: auto`, so on a phone it lay over the whole
   bottom of the page and swallowed every tap meant for the shell underneath.
   Including the taps meant for the camera-mode buttons, which are the only
   way back to Orbit on a device with no keyboard: entering Walk on a phone
   was a one-way door.

   The two halves are not the same kind of thing and must not share a depth.
   The ZONES are a background input surface — they belong just above the
   viewport and below anything anyone has drawn on top of it. The BUTTONS are
   ordinary UI and belong above it. Splitting them costs one stacking context:
   with no z-index on the root, `position: fixed` alone does not create one,
   so these two values layer against the host page's own chrome rather than
   against each other. */
const CSS = `
.wf-touch { position: fixed; inset: 0; pointer-events: none;
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent; }
.wf-touch[hidden] { display: none; }
.wf-touch .zone { position: absolute; z-index: 2; bottom: 0; top: 12%; pointer-events: auto; touch-action: none; }
.wf-touch .zone.move { left: 0; width: 46%; }
.wf-touch .zone.look { right: 0; width: 54%; }
.wf-touch .stick {
  position: absolute; width: 132px; height: 132px; margin: -66px 0 0 -66px;
  border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.28);
  background: radial-gradient(circle at 50% 50%, rgba(255,255,255,0.10), rgba(255,255,255,0.03) 70%);
  opacity: 0; transition: opacity .16s ease; pointer-events: none;
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.wf-touch .stick.on { opacity: 1; }
.wf-touch .knob {
  position: absolute; left: 50%; top: 50%; width: 58px; height: 58px;
  margin: -29px 0 0 -29px; border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.5); background: rgba(255,255,255,0.16);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
}
.wf-touch .pad {
  position: absolute; z-index: 31;
  right: max(14px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
  display: grid; grid-auto-flow: row; gap: 10px; justify-items: end; pointer-events: none;
}
.wf-touch .row { display: flex; gap: 10px; align-items: center; pointer-events: none; }
.wf-touch button {
  pointer-events: auto; touch-action: none; -webkit-tap-highlight-color: transparent;
  min-width: 62px; min-height: 62px; padding: 0 14px; border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.34); background: rgba(12,16,22,0.42);
  color: #eef2f8; font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .1em; text-transform: uppercase;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
}
.wf-touch button.wide { border-radius: 34px; min-width: 88px; }
.wf-touch button.hot { border-color: rgba(255,141,125,0.7); color: #ffd7cf; }
.wf-touch button.on, .wf-touch button:active { background: rgba(255,255,255,0.3); color: #0b0e14; }
@media (min-width: 900px) and (pointer: fine) { .wf-touch { display: none; } }
`;

export const isTouchDevice = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export class TouchControls {
  // buttons: [{ id, label, wide, hot, hold, onDown, onUp }]
  constructor({ container = document.body, buttons = [], lookScale = 0.0032 } = {}) {
    this.controller = null;
    this.lookScale = lookScale;
    this.onTap = null;         // quick tap on the look pad (VSight: fire)
    this._movePointer = null;
    this._lookPointer = null;
    this._origin = { x: 0, y: 0 };
    this._tap = null;

    /* A CONSTRUCTED sheet, not a <style> element. The content policy allows
       no inline styles anywhere on this origin, and a <style> node built at
       runtime is an inline style however it was assembled — it would be
       dropped in production and the sticks would render as three grey
       rectangles. A constructable stylesheet is CSSOM rather than markup, so
       it is not subject to style-src at all, and it is adopted once per
       document rather than appended per mount. */
    if (!adopted.has(document)) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        adopted.add(document);
      } catch (err) {
        console.warn("[touch] could not adopt the control sheet:", err.message);
      }
    }

    this.root = element("div", "wf-touch", trust(`
      <div class="zone move"><div class="stick"><div class="knob"></div></div></div>
      <div class="zone look"></div>
      <div class="pad"></div>`));
    this.root.hidden = true;
    this.moveZone = this.root.querySelector(".zone.move");
    this.lookZone = this.root.querySelector(".zone.look");
    this.stick = this.root.querySelector(".stick");
    this.knob = this.root.querySelector(".knob");
    this.pad = this.root.querySelector(".pad");

    for (const b of buttons) this.addButton(b);

    this.moveZone.addEventListener("pointerdown", this._moveDown = (e) => {
      if (this._movePointer !== null) return;
      this._movePointer = e.pointerId;
      this.moveZone.setPointerCapture(e.pointerId);
      const r = this.root.getBoundingClientRect();
      this._origin = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.stick.style.left = `${this._origin.x}px`;
      this.stick.style.top = `${this._origin.y}px`;
      this.stick.classList.add("on");
      e.preventDefault();
    });
    this.moveZone.addEventListener("pointermove", this._moveMove = (e) => {
      if (e.pointerId !== this._movePointer || !this.controller) return;
      const r = this.root.getBoundingClientRect();
      let dx = e.clientX - r.left - this._origin.x;
      let dy = e.clientY - r.top - this._origin.y;
      const max = 58, len = Math.hypot(dx, dy);
      if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.controller.moveInput.x = dx / max;
      this.controller.moveInput.y = -dy / max;   // screen-up = forward
      this.controller.runInput = len > max * 0.82;
      e.preventDefault();
    });
    const endMove = (e) => {
      if (e.pointerId !== this._movePointer) return;
      this._movePointer = null;
      this.stick.classList.remove("on");
      this.knob.style.transform = "";
      if (this.controller) {
        this.controller.moveInput.x = this.controller.moveInput.y = 0;
        this.controller.runInput = false;
      }
    };
    this.moveZone.addEventListener("pointerup", this._moveUp = endMove);
    this.moveZone.addEventListener("pointercancel", this._moveCancel = endMove);

    this.lookZone.addEventListener("pointerdown", this._lookDown = (e) => {
      if (this._lookPointer !== null) return;
      this._lookPointer = e.pointerId;
      this.lookZone.setPointerCapture(e.pointerId);
      this._tap = { x: e.clientX, y: e.clientY, t: performance.now() };
      this._lookLast = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    });
    // Tracked deltas rather than movementX/Y: pointer-event movement deltas
    // are unreliable for touch across WebKit versions, client coords are not.
    this.lookZone.addEventListener("pointermove", this._lookMove = (e) => {
      if (e.pointerId !== this._lookPointer || !this.controller) return;
      const last = this._lookLast || { x: e.clientX, y: e.clientY };
      this.controller.lookInput.x += (e.clientX - last.x) * this.lookScale;
      this.controller.lookInput.y += (e.clientY - last.y) * this.lookScale;
      this._lookLast = { x: e.clientX, y: e.clientY };
      if (this._tap && Math.hypot(e.clientX - this._tap.x, e.clientY - this._tap.y) > 12) this._tap = null;
      e.preventDefault();
    });
    const endLook = (e) => {
      if (e.pointerId !== this._lookPointer) return;
      this._lookPointer = null;
      this._lookLast = null;
      if (this._tap && performance.now() - this._tap.t < 260 && this.onTap) this.onTap();
      this._tap = null;
    };
    this.lookZone.addEventListener("pointerup", this._lookUp = endLook);
    this.lookZone.addEventListener("pointercancel", this._lookCancel = endLook);

    container.appendChild(this.root);
  }

  addButton({ id, label, wide, hot, hold = true, onDown, onUp, row = 0 }) {
    let rowEl = this.pad.querySelector(`.row[data-row="${row}"]`);
    if (!rowEl) {
      rowEl = document.createElement("div");
      rowEl.className = "row";
      rowEl.dataset.row = String(row);
      this.pad.appendChild(rowEl);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.id = id;
    b.textContent = label;
    if (wide) b.classList.add("wide");
    if (hot) b.classList.add("hot");
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      b.classList.add("on");
      if (onDown) onDown();
    });
    const up = (e) => {
      e.preventDefault();
      b.classList.remove("on");
      if (hold && onUp) onUp();
    };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    rowEl.appendChild(b);
    return b;
  }

  // Attach to a walk/fly controller and show the overlay.
  attach(controller) {
    this.detach();
    this.controller = controller;
    controller.touchActive = true;
    this.root.hidden = false;
  }
  detach() {
    if (this.controller) {
      this.controller.touchActive = false;
      this.controller.moveInput.x = this.controller.moveInput.y = 0;
      this.controller.runInput = false;
      this.controller = null;
    }
    this.root.hidden = true;
  }
  dispose() {
    this.detach();
    this.root.remove();
  }
}
