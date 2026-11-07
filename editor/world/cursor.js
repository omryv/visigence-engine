// The hand, drawn by the interface.
//
// A dot where the pointer is, a trail of smaller dots easing along the path it
// took, a glass lens that blooms over anything pressable, and a slow fluid
// morph while the button is held. Three states and two transitions, exactly
// mirroring what the pointer itself is doing: moving, considering, committing.
//
// Ground rules, in order of importance:
//
//  1 · NEVER between the author and the world. The whole layer is
//      pointer-events: none and purely cosmetic — every hit-test, drag and
//      click lands exactly where it always did.
//  2 · The lens only blooms over things that can be PRESSED. Over the world
//      canvas the pointer is an aiming instrument — sculpting, placing,
//      travelling — and a 54px ring over the aim point would be chrome
//      obscuring the one pixel that matters. Dot and trail only, out there.
//  3 · It stands down whenever it cannot be right: coarse pointers (no cursor
//      to replace), reduced motion (a trail is nothing but motion), pointer
//      lock (walk/fly own the pointer), text fields (the I-beam is better at
//      being an I-beam than we are), and the window edge.
//
// The trail is a lerp chain — each dot eases toward the one before it, the
// head eases toward the pointer — which is what gives the path its smooth
// pull instead of a stamped breadcrumb line. The "refraction" on the lens is
// backdrop-filter blur/saturate/brightness plus a rim of cast light: real
// displacement refraction is not available to backdrop-filter cross-browser,
// and a filter that only works in one engine is a bug wearing a costume.

const TRAIL = 10;        // dots behind the head
const EASE_HEAD = 0.38;  // how tightly the head hugs the real pointer
const EASE_TAIL = 0.34;  // how tightly each trail dot hugs its leader

export function mountCursor() {
  // Coarse pointer: there is no cursor to replace. Reduced motion: the entire
  // point of this object is motion, so the native cursor is the right cursor.
  if (!matchMedia("(pointer: fine)").matches) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const layer = document.createElement("div");
  layer.id = "cursor-layer";
  layer.setAttribute("aria-hidden", "true");

  // trail[0] is the dot nearest the head; the taper below assumes that order.
  const trail = [];
  for (let i = 0; i < TRAIL; i++) {
    const t = document.createElement("i");
    t.className = "cur-trail";
    // The tail thins and fades toward its end — the far dot is a quarter the
    // head's size at 6% opacity, which is what reads as a path rather than
    // as ten separate cursors.
    const k = 1 - (i + 1) / (TRAIL + 1);
    t.style.opacity = (0.75 * k * k + 0.06).toFixed(3);
    t.style.transform = "translate(-100px,-100px) scale(" + (0.28 + 0.6 * k).toFixed(3) + ")";
    layer.appendChild(t);
    trail.push({ el: t, x: -100, y: -100, s: (0.28 + 0.6 * k).toFixed(3) });
  }

  // The lens is a positioned holder with the glass as its child, so the JS
  // owns one transform (where it is) and the CSS owns the other (how big, how
  // round) — mixing both into one transform is how a morph animation ends up
  // teleporting the ring to 0,0.
  const ringHold = document.createElement("div");
  ringHold.className = "cur-ring-hold";
  const ring = document.createElement("i");
  ring.className = "cur-ring";
  ringHold.appendChild(ring);

  const dot = document.createElement("i");
  dot.className = "cur-dot";

  layer.append(ringHold, dot);
  document.body.appendChild(layer);
  document.body.classList.add("cur-live");

  // Real pointer, eased head, eased lens. The lens is deliberately lazier
  // than the dot (0.2 vs 0.38): the dot is the pointer, the lens is a piece
  // of glass being dragged along after it — but no lazier, or a press lands
  // while the glass is still visibly somewhere else.
  let px = innerWidth / 2, py = innerHeight / 2;
  let hx = px, hy = py, rx = px, ry = py;
  let live = false;   // any real movement yet?
  let parked = true;  // pointer off-window, locked, or touch — layer faded

  const park = (on) => { parked = on; layer.classList.toggle("parked", on); };

  addEventListener("pointermove", (e) => {
    // A hybrid laptop fires touch moves too; a finger has no cursor.
    if (e.pointerType && e.pointerType !== "mouse") { park(true); return; }
    px = e.clientX; py = e.clientY;
    if (!live) { live = true; hx = rx = px; hy = ry = py; for (const t of trail) { t.x = px; t.y = py; } }
    if (parked && !document.pointerLockElement) park(false);
  }, { passive: true });

  // The lens blooms over anything pressable; the layer stands down entirely
  // over a text field, where the native I-beam takes back over (the cursor:
  // none rules skip those fields — see the stylesheet).
  const PRESSABLE = 'a, button, [role="button"], select, input[type="range"], input[type="checkbox"], summary';
  const TEXTUAL = 'input:not([type="range"]):not([type="checkbox"]), textarea, [contenteditable="true"]';
  /* `held` is set by the pointer-down handler below and owns the lens while a
     press is running, so a caller driving the lens must not clear it
     mid-press. Everything here goes through this one function for that
     reason. */
  const lens = (on) => { if (!ring.classList.contains("held") || on) ring.classList.toggle("on", !!on); };
  let external = false;   // a caller is deciding, not the DOM
  addEventListener("pointerover", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const textual = t && t.closest(TEXTUAL);
    layer.classList.toggle("ibeam", !!textual);
    if (external) return;
    lens(!!(t && !textual && t.closest(PRESSABLE)));
  }, true);

  // Held = morphing. The morph belongs to the lens, so a press with no lens —
  // an orbit drag, a sculpt stroke — stays a dot, per ground rule 2.
  addEventListener("pointerdown", (e) => {
    if (e.button === 0 && ring.classList.contains("on")) ring.classList.add("held");
  }, true);
  const release = () => ring.classList.remove("held");
  addEventListener("pointerup", release, true);
  addEventListener("pointercancel", release, true);

  // Walk and fly take the pointer (pointer lock) and draw their own crosshair;
  // the edge of the window means the pointer is somebody else's problem.
  document.addEventListener("pointerlockchange", () => park(!!document.pointerLockElement));
  document.documentElement.addEventListener("pointerleave", () => park(true));
  addEventListener("blur", () => park(true));

  (function frame() {
    if (live && !parked) {
      hx += (px - hx) * EASE_HEAD; hy += (py - hy) * EASE_HEAD;
      rx += (px - rx) * 0.2;       ry += (py - ry) * 0.2;
      dot.style.transform = `translate(${hx}px, ${hy}px)`;
      ringHold.style.transform = `translate(${rx}px, ${ry}px)`;
      // The chain: trail[0] chases the head and each dot after chases the one
      // before it — so index order IS distance order, and the size/opacity
      // taper computed at build time lands on the right dots.
      let lx = hx, ly = hy;
      for (let i = 0; i < trail.length; i++) {
        const t = trail[i];
        t.x += (lx - t.x) * EASE_TAIL; t.y += (ly - t.y) * EASE_TAIL;
        t.el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
        lx = t.x; ly = t.y;
      }
    }
    requestAnimationFrame(frame);
  })();

  /* THE ONE THING A PAGE CAN TELL THE CURSOR. The rule above — bloom over
     anything pressable — is a DOM question, and it has no answer on a canvas:
     the landing page's five worlds are all the same element, and which one
     the pointer is over is something only that page's raycaster knows. So a
     caller may take the lens over. Once it does, the DOM rule stands down for
     good on that page rather than fighting it every pointerover. */
  return {
    lens(on) { external = true; lens(on); },
  };
}
