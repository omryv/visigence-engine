/* room-probe.js — what a room is lit by, as arithmetic.
 *
 * THE PROBLEM. Interiors are the most reasoned-about thing in this repository
 * — an eight-stage pipeline and the largest suite — and they were lit by the
 * SKY, dimmed. atmosphere.js scales `reflectedLight.indirectDiffuse` and
 * `indirectSpecular` by the shelter factor, so standing in a room you get 18%
 * of the outdoor ambient, arriving from every direction equally, tinted by
 * whatever the dome happens to be. Two things follow, and both read as "this
 * is a box with furniture in it" rather than as a room:
 *
 *   · the light does not come from the WINDOW. A room with one small opening
 *     on one wall is lit exactly like a room with four, because the only
 *     input is how much roof is overhead.
 *
 *   · `scene.environment` is the sky PMREM and nothing else, so a glazed
 *     cabinet, a polished floor or a rifle barrel indoors reflects open sky
 *     — through the ceiling. Dimming it makes it a darker sky. It is still
 *     the sky.
 *
 * ── WHY THIS IS DERIVED RATHER THAN CAPTURED ──
 * The obvious fix is a probe per room: render a small cubemap at composition
 * time, PMREM it, select by which room the camera is in. It is also the wrong
 * fix HERE, for a reason particular to this engine: the sun moves. timeOfDay
 * drives everything, the arrival film sweeps hours, and a captured probe is a
 * photograph of one instant that goes wrong the moment the clock does. It
 * would also cost a GPU capture per room at build time and a few hundred
 * kilobytes each to keep.
 *
 * What is below is a FUNCTION OF THE HOUR instead. It reads the openings the
 * shelter system already finds (core/shelter.js aperturesOf: position, size,
 * inward normal, and whether a pane or a leaf is stopping the light) and the
 * sky colours the rig already computes, and returns the irradiance a room
 * receives and the direction it arrives from. Nine floats per room, recomputed
 * in microseconds when the light changes, correct at every hour rather than at
 * one — and pure, so the suite can check it without a GL context.
 *
 * ── WHAT IT DELIBERATELY IS NOT ──
 * Not a radiance probe. There is no cubemap here and a mirror will not show
 * you the chair behind you. It answers the two questions that actually make a
 * room read as a room — how much light, and from WHERE — and it replaces the
 * sky's colour in the specular term with the room's own so that reflections
 * stop being a window in the ceiling. Anything more wants screen-space
 * reflections, which is a different piece of work.
 */

/* An opening only lets light in if nothing is filling it. `blocked` is the
   shelter system's word for a pane or a shut leaf — the same flag the rain
   uses to decide whether the weather gets in, which is the point: one answer
   about what an opening is, shared by the water and the light. */
function openArea(a) {
  return a.blocked ? 0 : Math.max(0, a.w) * Math.max(0, a.h);
}

/* Is this opening in this room's wall? Apertures carry the uid of the record
   they were cut from and a point just inside them, so the test is whether a
   step INWARD from the opening lands in this volume — the same step
   aperturesOf itself takes to decide which floor an opening looks onto. */
export function apertureBelongsTo(v, a, inVolume) {
  if (a.uid !== v.uid) return false;
  return inVolume(v, a.x + a.nx * 1.0, a.y, a.z + a.nz * 1.0)
      || inVolume(v, a.x + a.nx * 1.0, v.floorY + 0.3, a.z + a.nz * 1.0);
}

/* The light in one room.
 *
 * `sky` and `bounce` are linear RGB triples the rig already owns — the dome's
 * own colour and what the ground throws back up. `sun` is the direction TO the
 * sun with its colour; a window facing it does more than a window facing away,
 * which is most of why a room changes character over a morning.
 *
 * Returns:
 *   ambient   linear RGB the room is filled with
 *   dir       unit direction the light chiefly arrives FROM, in world space
 *             (pointing at the openings, so a surface facing a window is lit)
 *   openness  0..1, this room's aperture area against its floor — the number
 *             that separates a hall with a glazed front from a cellar
 */
export function roomProbe(v, apertures, { sky, bounce, sun, sunDir, night = 0 } = {}) {
  const floor = Math.max(1, v.w * v.d);
  let area = 0, dx = 0, dy = 0, dz = 0, facing = 0;

  for (const a of apertures) {
    const s = openArea(a);
    if (s <= 0) continue;
    area += s;
    /* Weighted by area: a glazed front is not four windows. The direction is
       OUTWARD (−n), because that is where the light is coming from, and it is
       what a surface normal has to agree with to be lit by it. */
    dx -= a.nx * s; dz -= a.nz * s;
    // Openings are in walls, so the light arrives close to level. The small
    // upward bias is the sky being brighter than the ground outside.
    dy += s * 0.25;
    if (sunDir) {
      // How squarely this opening faces the sun, ignoring elevation: a window
      // on the sunny side is a different light from one on the shaded side.
      const align = Math.max(0, -a.nx * sunDir[0] + -a.nz * sunDir[2]);
      facing += s * align;
    }
  }

  const openness = Math.min(1, area / floor);
  const len = Math.hypot(dx, dy, dz);
  /* A room with no opening at all still has to face somewhere, or the shader
     divides by zero and a windowless cellar renders black-on-NaN. Straight up
     is the honest default: whatever reaches it came through the structure. */
  const dir = len > 1e-4 ? [dx / len, dy / len, dz / len] : [0, 1, 0];

  /* HOW MUCH. Aperture area over floor area is the physical ratio, and it is
     far too dark used raw — a real room with a 5% window is not at 5% of
     outdoor brightness, because every surface in it bounces. The curve is a
     square root, which is the cheap stand-in for that: it lifts a small
     opening a long way and a large one hardly at all, so the difference
     between one window and none stays enormous and the difference between
     three and four stays small. */
  const reach = Math.sqrt(Math.min(1, openness * 6));
  const sunLift = area > 0 ? 1 + 0.6 * (facing / area) : 1;
  const day = 1 - night;

  const amb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    /* Two terms, and the second is what keeps a dark room from going black:
       light through the openings, plus the room's own bounce, which is there
       even at the back of a hall with one door. */
    amb[i] = (sky?.[i] ?? 0) * reach * sunLift * day
           + (bounce?.[i] ?? 0) * (0.25 + 0.35 * reach);
    if (sun && sunDir && sunDir[1] > 0) amb[i] += (sun[i] ?? 0) * reach * 0.18 * day;
  }

  return { ambient: amb, dir, openness, apertureArea: area, floorArea: floor };
}

/* Which room a point is in, as an index into `volumes`, or -1 outdoors. The
   caller passes inVolume so this module never has to import the shelter
   system it is describing — the same reason burn-spec.js takes its field. */
export function roomAt(volumes, x, y, z, inVolume) {
  for (let i = 0; i < volumes.length; i++) {
    if (inVolume(volumes[i], x, y, z)) return i;
  }
  return -1;
}

/* Ease one probe toward another. Walking through a doorway swaps which room
   you are in ON ONE FRAME, and swapping the ambient with it is a visible
   flash — the one artefact a lighting change like this is most likely to
   ship. `k` is the fraction of the way to move this frame. */
export function blendProbe(into, target, k) {
  const t = Math.max(0, Math.min(1, k));
  for (let i = 0; i < 3; i++) {
    into.ambient[i] += (target.ambient[i] - into.ambient[i]) * t;
    into.dir[i] += (target.dir[i] - into.dir[i]) * t;
  }
  into.openness += (target.openness - into.openness) * t;
  const len = Math.hypot(into.dir[0], into.dir[1], into.dir[2]);
  if (len > 1e-4) { into.dir[0] /= len; into.dir[1] /= len; into.dir[2] /= len; }
  return into;
}

export function emptyProbe() {
  return { ambient: [0, 0, 0], dir: [0, 1, 0], openness: 0, apertureArea: 0, floorArea: 1 };
}
