/* What a room is lit by, asserted against rooms whose answer is obvious.
 *
 * The probe is pure so this suite can reach it, and that matters more here
 * than usual: a lighting change is the hardest kind to eyeball. "Is that room
 * too dark" has no answer you can hold still, and every check in this file —
 * a window on one wall lights the wall opposite, four windows beat one, a
 * cellar is not black, a shut pane is not a window — is a sentence anybody
 * would agree with before seeing a frame.
 *
 * The rooms below are 6 × 4 metres with the openings written out, so every
 * expectation can be checked by reading the coordinates.
 */
import { test, eq, ok, close, report } from "./harness.js";
import {
  roomProbe, roomAt, blendProbe, emptyProbe, apertureBelongsTo,
} from "../../../src/kernel/core/room-probe.js";
import { inVolume } from "../../../src/kernel/core/shelter.js";

const SKY = [0.4, 0.5, 0.7];      // a cool daylit dome
const BOUNCE = [0.1, 0.09, 0.07]; // warm ground
const SUN = [1.0, 0.9, 0.7];

const room = (over = {}) => ({ uid: "b1", x: 0, z: 0, rot: 0, w: 6, d: 4, floorY: 0, roofY: 3, ...over });

/* An opening in the −z wall, looking out that way: its inward normal points
   at +z, so the light arrives FROM −z. */
const window0 = (over = {}) => ({
  uid: "b1", x: 0, y: 1.2, z: -2, w: 1.2, h: 1.1, nx: 0, nz: 1,
  floorY: 0, blocked: false, hinged: false, kind: "window", ...over,
});

const lit = (p) => (p.ambient[0] + p.ambient[1] + p.ambient[2]) / 3;

test("a room with no opening is dim, and is not black", () => {
  /* A pitch-black room is a different lie from a flat one: light gets into a
     cellar off every surface between it and the door. */
  const p = roomProbe(room(), [], { sky: SKY, bounce: BOUNCE });
  eq(p.openness, 0, "no aperture area");
  ok(lit(p) > 0, "a windowless room still has some light in it");
  ok(lit(p) < lit(roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE })),
    "…and less of it than the same room with a window");
});

test("a window lights the room from the side it is on", () => {
  const p = roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE });
  // Light arrives FROM the opening, so the direction points at it: −z.
  ok(p.dir[2] < -0.5, `dir points at the window (got ${p.dir.map((v) => v.toFixed(2))})`);
  ok(p.dir[1] > 0, "with a little of it from above, the sky being brighter than the ground");
  close(Math.hypot(...p.dir), 1, 1e-6, "the direction is a unit vector");
});

test("openings on opposite walls cancel to an overhead light", () => {
  /* Two windows facing each other have no side to be lit from, and a probe
     that insisted on one would light the room from a wall at random. */
  const p = roomProbe(room(), [window0(), window0({ z: 2, nz: -1 })], { sky: SKY, bounce: BOUNCE });
  ok(Math.abs(p.dir[2]) < 0.2, `no horizontal bias (got z ${p.dir[2].toFixed(3)})`);
  ok(p.dir[1] > 0.9, "so what is left is the upward term");
});

test("more glass is more light, with diminishing returns", () => {
  const one = roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE });
  const four = roomProbe(room(), [window0(), window0({ x: -2 }), window0({ x: 2 }), window0({ x: 1 })],
    { sky: SKY, bounce: BOUNCE });
  ok(lit(four) > lit(one), "four windows beat one");
  /* And not by four times. A real room with a small window is nowhere near a
     twentieth as bright as outdoors, because everything in it bounces — the
     curve that models that has to flatten. */
  ok(lit(four) < lit(one) * 4, "but not by the ratio of the glass");
});

test("a pane or a shut leaf is not an opening", () => {
  /* The same `blocked` flag the rain reads. One answer about what an opening
     is, shared by the weather and the light — a glazed window that let light
     in but kept spray out would be two different ideas of the same wall. */
  const open = roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE });
  const shut = roomProbe(room(), [window0({ blocked: true })], { sky: SKY, bounce: BOUNCE });
  eq(shut.openness, 0, "a blocked opening contributes no area");
  ok(lit(shut) < lit(open), "and less light");
});

test("a window facing the sun is worth more than one facing away", () => {
  const sunDir = [0, 0.5, -0.87];             // sun off to −z, half up
  const toward = roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE, sun: SUN, sunDir });
  const away = roomProbe(room(), [window0({ z: 2, nz: -1 })], { sky: SKY, bounce: BOUNCE, sun: SUN, sunDir });
  ok(lit(toward) > lit(away), "the sunny side of a building is a different room from the shaded side");
});

test("night takes the daylight out and leaves the bounce", () => {
  const day = roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE, night: 0 });
  const night = roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE, night: 1 });
  ok(lit(night) < lit(day) * 0.5, "a room at midnight is not a room at noon");
  ok(lit(night) > 0, "but the lamps have something to sit against");
});

test("openness is aperture against floor, and is capped", () => {
  const p = roomProbe(room(), [window0()], { sky: SKY, bounce: BOUNCE });
  close(p.floorArea, 24, 1e-9, "6 × 4");
  close(p.apertureArea, 1.32, 1e-9, "1.2 × 1.1");
  close(p.openness, 1.32 / 24, 1e-9);

  // A room that is more hole than wall cannot be more than fully open.
  const huge = Array.from({ length: 40 }, () => window0({ w: 3, h: 3 }));
  ok(roomProbe(room(), huge, { sky: SKY, bounce: BOUNCE }).openness <= 1, "openness is a fraction");
});

test("an opening belongs to the room a step inward from it lands in", () => {
  /* Otherwise a hall's glazed front lights the cellar behind it. The test is
     the same one aperturesOf uses to decide which floor the rain falls on. */
  const hall = room();
  const cellar = room({ x: 20 });
  ok(apertureBelongsTo(hall, window0(), inVolume), "the window is in the hall's wall");
  ok(!apertureBelongsTo(cellar, window0(), inVolume), "and not in the room twenty metres away");
  ok(!apertureBelongsTo({ ...hall, uid: "other" }, window0(), inVolume),
    "nor in a different building that happens to overlap");
});

test("roomAt finds the room a point is in, and says so when there is none", () => {
  const vols = [room(), room({ x: 20 })];
  eq(roomAt(vols, 0, 1, 0, inVolume), 0);
  eq(roomAt(vols, 20, 1, 0, inVolume), 1);
  eq(roomAt(vols, 60, 1, 0, inVolume), -1, "outdoors is -1, not room zero");
  eq(roomAt(vols, 0, 40, 0, inVolume), -1, "and so is standing on the roof");
  eq(roomAt([], 0, 1, 0, inVolume), -1, "a world with no interiors");
});

test("the blend eases and never leaves the direction unnormalised", () => {
  /* Walking through a doorway swaps rooms on one frame. Swapping the ambient
     with it is a visible flash, which is the artefact this whole change is
     most likely to ship. */
  const a = emptyProbe();
  const b = { ambient: [1, 1, 1], dir: [1, 0, 0], openness: 0.5 };
  blendProbe(a, b, 0.5);
  close(a.ambient[0], 0.5, 1e-9, "halfway there");
  close(Math.hypot(...a.dir), 1, 1e-9, "and still a unit direction");
  for (let i = 0; i < 60; i++) blendProbe(a, b, 0.5);
  close(a.ambient[0], 1, 1e-6, "and it arrives");

  const c = emptyProbe();
  blendProbe(c, b, 1);
  close(c.ambient[0], 1, 1e-9, "k of 1 is a snap, which is what entering from outdoors wants");
});

report("room-probe");
