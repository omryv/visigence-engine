/* controller.js — the one player body, as data.
 *
 * Every question this project asks about whether a place can be reached is a
 * question about a BODY: how fast it walks, how high a step it takes without
 * jumping, how steep a hillside it can stand on, how deep a shallows it wades
 * before it has to swim. Those numbers were true in four places and written
 * down in none of them as a set — in the walk controller's update loop, in the
 * collision module, in reach.js, and in a sibling repository's level spec — so
 * a reach check here and a nav bake there could each be right by their own
 * numbers and disagree about the same hillside.
 *
 * This is the set, frozen, with where each number comes from:
 *
 *   walk 6, run 14       engine/player/controllers.js:225
 *                        `const speed = run ? 14 : 6;` (the walk branch)
 *   swim 3.5, swimRun 7  engine/player/controllers.js:191
 *                        `const speed = run ? 7 : 3.5;` (the swim branch)
 *   stepUp 0.55          engine/player/collide.js:27, src/kernel/core/reach.js:44
 *   head 1.9             engine/player/collide.js:28, src/kernel/core/reach.js:45
 *   radius 0.42          engine/player/controllers.js:242 and :267 (the radius
 *                        handed to Blockers.resolve / surfaceAt), and
 *                        src/kernel/core/reach.js:46
 *   maxSlope 0.85        3dgen src/world/buildSpec.js:119, TRAVERSAL_DEFAULTS —
 *                        rise over run, metres per metre (about 40.4°)
 *   wadeDepth 0.9        3dgen src/world/buildSpec.js:128, TRAVERSAL_DEFAULTS
 *
 * stepUp, head and radius are READ from reach.js rather than retyped, so the
 * walking-a-building check and this record cannot drift apart; the speeds
 * cannot be imported (controllers.js is renderer code and the core may not
 * import it), so tools/test/kernel/controller.test.js reads that file's source and fails
 * if the two literals there stop being these.
 *
 * ── the two numbers that came from outside, and one disagreement kept honest
 *
 * maxSlope and wadeDepth are not anywhere in this repository. The engine's
 * walk controller has no slope limit at all — it will carry a player up a
 * cliff face at walking pace, because the floor is simply wherever the
 * sampler says it is — so there was no local number to cite. 3dgen's
 * TRAVERSAL_DEFAULTS is the one place a limit was ever decided, and it is the
 * limit 3dgen's nav bake (src/world/navgrid.js) already holds its levels to,
 * so it is the one adopted here: two repositories, one limit. Not one
 * MEASUREMENT, though. 3dgen takes slope over ±2 m on its bilinear sampler
 * (slopeAt, eps 2) and also refuses a terrain step that rises more than
 * stepUp (navgrid.js:104); terrain-reach.js differences across two lattice
 * cells and leaves stepUp to placements (its header says why). The same
 * numbers can therefore still give two answers about one hillside, and
 * aligning the rule as well as the numbers is a separate decision.
 *
 * wadeDepth 0.9 is NOT what the engine's controller does. It starts swimming
 * where the ground is more than 0.8 m under the waterline
 * (controllers.js:189, `terrain < level - 0.8`). So there is a 0.1 m band of
 * shallows this record calls wadeable that the shipping controller swims.
 * The shared number is kept because it is the shared number — the task of
 * this record is one body across repositories — and the band is written here
 * rather than silently "fixed" in either direction, because changing the
 * player's behaviour is not this module's business (engine/player/* is
 * untouched). A route through that band is still a route a player completes:
 * they swim three metres instead of wading them.
 *
 * ── the climb rule
 *
 * Par needs a cost for going uphill. Naismith's rule is used, in its plain
 * form: one hour per 5 km on the flat plus one hour per 600 m of ascent, so a
 * metre climbed costs as much time as 5000 / 600 = 25/3 ≈ 8.33 m walked.
 * Chosen over Tobler's hiking function for two reasons that are both about
 * what par is FOR:
 *
 *   - it never makes a leg cheaper than walking it flat. Tobler peaks at a
 *     gentle descent (−5 %), where it is about 19 % faster than on the flat,
 *     so a Tobler par on a downhill course comes out under distance / walk —
 *     a par a player walking at full speed could not beat, which is a par
 *     that tells them they were slow when they were not. Here descent is free
 *     and climb is charged, so par ≥ horizontal distance / walk always.
 *   - it is a multiply and an add. Tobler needs Math.exp, and the core is held
 *     to the same answer under Node and JavaScriptCore; exp is not required
 *     by the spec to round identically in two engines, and multiplication is.
 *
 * Descent is free rather than discounted (Langmuir's refinement) for the same
 * first reason. The rule is data, so a sibling that prefers another can read
 * the name and refuse it rather than quietly computing a different par.
 *
 * Pure data. No three.js, no DOM, no randomness.
 */

import { STEP_UP, HEAD, RADIUS } from "./reach.js";

export const CONTROLLER_VERSION = 1;

export const CONTROLLER = Object.freeze({
  version: CONTROLLER_VERSION,
  // m/s on the flat
  walk: 6,
  run: 14,
  swim: 3.5,
  swimRun: 7,
  // metres
  stepUp: STEP_UP,
  head: HEAD,
  radius: RADIUS,
  wadeDepth: 0.9,
  // rise over run, m/m
  maxSlope: 0.85,
  climb: Object.freeze({
    rule: "naismith",
    // metres of flat walking one metre of ascent costs (5000 m/h ÷ 600 m/h)
    flatPerClimb: 25 / 3,
    // metres of flat walking one metre of descent costs
    flatPerDescent: 0,
  }),
});

/* The record as plain JSON-ready data, keys sorted at every level, so the
   file tools/kernel/controller-json.mjs writes is the same bytes however this
   object's literal happens to be ordered. */
export function controllerData(c = CONTROLLER) {
  const sort = (v) => {
    if (v === null || typeof v !== "object") return v;
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return sort(c);
}
