/**
 * A standard-mapping gamepad as game input (the W3C "standard" layout every modern pad reports): the left stick
 * moves, the right stick looks (first person, third person) or aims (the arena), and the face buttons, bumpers and
 * triggers are the actions. Read once a frame; null when no pad is connected. Nothing is remapped per genre here:
 * the genre's rules decide what a look or an aim means.
 */
const DEAD = 0.18;
const axis = v => Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD);
const pressed = (pad, i) => !!pad.buttons[i]?.pressed || (pad.buttons[i]?.value ?? 0) > 0.5;

/** Buttons in the standard mapping. */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export function readGamepad(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const pads = nav?.getGamepads?.() ?? [];
  const pad = [...pads].find(p => p?.connected && p.mapping === 'standard') ?? [...pads].find(p => p?.connected);
  if (!pad) return null;
  const a = pad.axes;
  return {
    move: { x: axis(a[0] ?? 0), y: -axis(a[1] ?? 0) },
    stick: { x: axis(a[2] ?? 0), y: -axis(a[3] ?? 0) },
    jump: pressed(pad, PAD.A), interact: pressed(pad, PAD.B) || pressed(pad, PAD.X),
    fire: pressed(pad, PAD.RT), ads: pressed(pad, PAD.LT), reload: pressed(pad, PAD.RB), grenade: pressed(pad, PAD.LB),
    next: pressed(pad, PAD.Y), sprint: pressed(pad, PAD.L3), pause: pressed(pad, PAD.START),
  };
}
