/**
 * Input for the game shell: keyboard, gamepad, mouse and touch folded into the one input shape
 * the simulations read (shared.emptyInput). Presses are latched between samples, so a tap
 * shorter than a frame is never lost and each press reaches exactly one fixed step.
 *
 * Keys, by genre (the menus and the HUD print the same list):
 *   every genre  arrows / WASD move · Esc or P pause
 *   platformer   Space, Z or K jump · E, X or J pull a lever (Up works too)
 *   adventure    E, Space or Enter act (talk, open, pull) · X, J or K shoot (with a slingshot)
 *   arena        mouse aims, click fires · or arrows aim-and-fire with WASD to move · Space fires
 *   maze         arrows / WASD steer
 *   puzzle       arrows / WASD push · Z, U or Backspace undo · R restart
 */
import { emptyInput } from './sims/shared.js';

const MOVE = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down' };

export function keyMap(genre) {
  const m = {};
  const add = (codes, name) => { for (const c of codes) m[c] = name; };
  if (genre === 'arena') {
    add(['KeyA'], 'left'); add(['KeyD'], 'right'); add(['KeyW'], 'up'); add(['KeyS'], 'down');
    add(['ArrowLeft'], 'aimLeft'); add(['ArrowRight'], 'aimRight'); add(['ArrowUp'], 'aimUp'); add(['ArrowDown'], 'aimDown');
    add(['Space', 'KeyJ', 'KeyK'], 'fire');
  } else {
    for (const [c, n] of Object.entries(MOVE)) m[c] = n;
  }
  if (genre === 'platformer') { add(['Space', 'KeyZ', 'KeyK'], 'jump'); add(['KeyE', 'KeyX', 'KeyJ'], 'action'); }
  if (genre === 'adventure') { add(['KeyE', 'Space', 'Enter'], 'action'); add(['KeyX', 'KeyJ', 'KeyK'], 'fire'); }
  if (genre === 'puzzle') { add(['KeyZ', 'KeyU', 'Backspace'], 'undo'); add(['KeyR'], 'restart'); }
  return m;
}

/** Plain-language control lines for a genre, for the title screen and pause menu. */
export function controlsText(genre, touch) {
  if (touch) {
    return {
      platformer: 'Left pad runs · A jumps · B pulls levers',
      adventure: 'Stick moves · A acts · B shoots when you carry a slingshot',
      arena: 'Left stick moves · right stick aims and fires',
      maze: 'Swipe or use the pad to steer',
      puzzle: 'Pad pushes · Undo takes a move back',
    }[genre];
  }
  return {
    platformer: 'Arrows or WASD run · Space jumps · E pulls levers · Esc pauses',
    adventure: 'Arrows or WASD move · E acts · X shoots with a slingshot · Esc pauses',
    arena: 'WASD moves · mouse aims, click fires (or arrows aim and fire) · Esc pauses',
    maze: 'Arrows or WASD steer · Esc pauses',
    puzzle: 'Arrows or WASD push · Z undoes · R restarts · Esc pauses',
  }[genre];
}

/**
 * `active()` says whether play has the keys. While it is false (a menu card is open) Enter, Space
 * and the arrows are left to the menu's buttons, and nothing is latched into the next step; only
 * Esc and P still reach `onPause`.
 */
export function createInput(target, { genre, onPause, active = null }) {
  const map = keyMap(genre);
  const held = new Set();
  const latched = new Set();
  const virtual = new Map();       // touch buttons: name -> bool
  const sticks = { move: null, aim: null };
  const mouse = { x: 0, y: 0, down: false, inside: false, used: false };
  let lastPad = {};
  let enabled = true;

  function down(name) { if (!held.has(name)) latched.add(name); held.add(name); }
  function up(name) { held.delete(name); }

  const onKeyDown = e => {
    if (!enabled) return;
    if (e.code === 'Escape' || e.code === 'KeyP') { if (!e.repeat) onPause?.(); e.preventDefault(); return; }
    // a key still held from play repeats onto the menu's focused button: don't let it press one
    if (active && !active()) { if (e.repeat && map[e.code]) e.preventDefault(); return; }
    const name = map[e.code];
    if (!name) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (!e.repeat) down(name);
  };
  const onKeyUp = e => { const name = map[e.code]; if (name) up(name); };
  const onBlur = () => { held.clear(); virtual.clear(); mouse.down = false; };
  const onMouseMove = e => { const r = target.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.inside = true; mouse.used = true; };
  const onMouseDown = e => { if (e.button === 0 && genre === 'arena') { mouse.down = true; mouse.used = true; latched.add('fire'); } };
  const onMouseUp = e => { if (e.button === 0) mouse.down = false; };
  const onContext = e => { if (genre === 'arena') e.preventDefault(); };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  target.addEventListener('contextmenu', onContext);

  /** Gamepad (standard mapping), read once per frame. */
  function pollPad() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...(pads || [])].find(Boolean);
    const now = {};
    if (!pad) { lastPad = now; return null; }
    const b = i => !!pad.buttons[i]?.pressed;
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    now.left = ax < -0.4 || b(14); now.right = ax > 0.4 || b(15); now.up = ay < -0.4 || b(12); now.down = ay > 0.4 || b(13);
    if (genre === 'platformer') { now.jump = b(0) || b(1); now.action = b(2) || b(3); }
    else if (genre === 'adventure') { now.action = b(0) || b(3); now.fire = b(2) || b(1) || b(7); }
    else if (genre === 'arena') { now.fire = b(7) || b(0) || b(5); }
    else if (genre === 'puzzle') { now.undo = b(2) || b(1); now.restart = b(3); }
    now.pause = b(9);
    const rx = pad.axes[2] || 0, ry = pad.axes[3] || 0;
    now.aim = Math.hypot(rx, ry) > 0.35 ? { x: rx, y: ry } : null;
    for (const k of Object.keys(now)) if (k !== 'aim' && now[k] && !lastPad[k]) { if (k === 'pause') onPause?.(); else latched.add(k); }
    lastPad = now;
    return now;
  }

  const api = {
    /**
     * The input for the next fixed step. `playerScreen` ({x, y} in CSS px) turns the mouse into
     * an aim direction for the arena.
     */
    sample(playerScreen) {
      const pad = pollPad() || {};
      const v = n => held.has(n) || !!virtual.get(n) || !!pad[n];
      const inp = emptyInput();
      for (const n of ['left', 'right', 'up', 'down', 'jump', 'action', 'fire']) inp[n] = v(n);
      if (sticks.move) {
        const { x, y } = sticks.move;
        if (x < -0.35) inp.left = true; if (x > 0.35) inp.right = true;
        if (y < -0.35) inp.up = true; if (y > 0.35) inp.down = true;
      }
      if (genre === 'arena') {
        const kx = (v('aimRight') ? 1 : 0) - (v('aimLeft') ? 1 : 0), ky = (v('aimDown') ? 1 : 0) - (v('aimUp') ? 1 : 0);
        if (kx || ky) { inp.aim = { x: kx, y: ky }; inp.fire = true; }
        else if (sticks.aim) { inp.aim = { ...sticks.aim }; inp.fire = true; }
        else if (pad.aim) { inp.aim = pad.aim; inp.fire = inp.fire || Math.hypot(pad.aim.x, pad.aim.y) > 0.6; }
        else if (mouse.used && playerScreen) {
          inp.aim = { x: mouse.x - playerScreen.x, y: mouse.y - playerScreen.y };
          if (mouse.down) inp.fire = true;
        }
      }
      for (const n of latched) if (n in inp.pressed) inp.pressed[n] = true;
      if (inp.pressed.aimLeft || inp.pressed.aimRight) inp.pressed.fire = true;
      latched.clear();
      return inp;
    },
    /** Touch buttons and sticks from the on-screen controls. */
    setVirtual(name, on) { if (on && !virtual.get(name)) latched.add(name); virtual.set(name, on); },
    setStick(name, vec) { sticks[name] = vec; },
    tap(name) { latched.add(name); },
    enable(on) { enabled = on; if (!on) onBlur(); },
    clear() { held.clear(); latched.clear(); virtual.clear(); sticks.move = sticks.aim = null; mouse.down = false; },
    get mouse() { return mouse; },
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('contextmenu', onContext);
    },
  };
  return api;
}

/** The same input with its presses removed: for the second and later steps of one frame. */
export function withoutPresses(inp) {
  const out = { ...inp, pressed: { ...inp.pressed } };
  for (const k of Object.keys(out.pressed)) out.pressed[k] = false;
  return out;
}
