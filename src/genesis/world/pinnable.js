/* pinnable.js — which placements are worth a pin, and which are the ground.
 *
 * engine/fx/pins.js states the rule the cloud exists for: A PIN APPEARS
 * EXACTLY WHERE THE OBJECT STOPS BEING LEGIBLE. It says something else too,
 * further down, that the engine had no way to act on — that the cloud is "a
 * finding aid for AUTHORED objects", and that a wall of them is "a wall of
 * plastic between the author and the thing they just made".
 *
 * Nothing enforced the second half. `_syncPins` walked every record in the
 * world, and a generated town is mostly records nobody would ever go looking
 * for. Crownway is the plain version of the arithmetic:
 *
 *     1817 placements  →  1817 pins
 *        960 of them road tiles — lane, setts, avenue, junction
 *        200 of them footings and steps — ground fill under buildings
 *        300 of them furniture, sealed inside rooms with the doors shut
 *
 * Two thirds of that cloud marks things that are not objects in the world:
 * they ARE the world. You do not hunt for the seventeenth metre of a lane,
 * and the pin over a chest you cannot see through a wall is pointing at
 * nothing. Stamp a site template and every one of them arrives at once,
 * which is the version of this a person actually meets: one click, a
 * thousand pins, and the town underneath them invisible.
 *
 * So there are two rules here, and each is a different KIND of statement.
 *
 *   DERIVED PLACEMENTS are a catalogue fact. Three families of record are
 *   emitted by the composer to make a world stand up rather than because
 *   anybody asked for them: the furniture inside a building, the masonry
 *   footing and doorstep that stand it on a slope, and the walkway that
 *   reaches it. Each already tags itself with a ref prefix — interiors.js
 *   says why the tag is there ("`ref` is one of the fields buildFusionRecord
 *   carries through to VSight and the exporters, so tagging the kind here
 *   costs no contract change") — so the tag is READ rather than invented.
 *   A footing is placed BY the building standing on it; the building is what
 *   the author put there and the building is what carries the pin.
 *
 *   SURFACES are a geometric fact, and deliberately not a list of refs. A
 *   road is not "a thing named lane" — it is a slab you walk on, wider than
 *   it is tall by more than an order of magnitude. Written as geometry it
 *   covers the setts, the avenue, the junction and the plaza without naming
 *   any of them, and it will cover the next paving piece somebody adds
 *   without this file being touched.
 *
 * What survives: buildings, towers, walls, fences, lamps, wells, bridges,
 * trees, and every block placed by hand. Fences and lamps come in runs, and
 * runs are what `crowding()` was written for — that layer fades a hedge of
 * forty posts to one signpost, which is the right answer for them and the
 * wrong answer for a lane, because a lane should not be a signpost at all.
 */

import { INTERIOR_REF } from "./interiors.js";

/* The ref prefixes of everything the composer derives rather than places.
 *
 *   interior/    furniture, partitions, ceilings — js/interiors.js
 *   site/        footings and doorsteps under a building — js/footing.js
 *   generated/   walkway decks linking a site together — js/compose.js
 *
 * None of these is a thing an author could have put in the world on its own;
 * each exists because something else is already there. Pinning them points
 * at the consequence instead of the cause — and in the case of furniture,
 * points through a wall at something you cannot see.
 */
export const DERIVED_REFS = [INTERIOR_REF, "site/", "generated/"];
const isDerived = (ref) => !!ref && DERIVED_REFS.some((p) => ref.startsWith(p));

/* A surface is low AND broad, and both halves are load-bearing:
 *
 *   height alone would swallow a doormat, a kerbstone, a fallen log — small
 *   things an author placed one at a time and will want to find again;
 *   breadth alone would swallow every building in the catalogue.
 *
 * 0.6 m clears the tallest paving the composer emits — a footing course and
 * a doorstep tread are both 0.42 — and sits under anything you would call an
 * object: a crate is a metre, a fence is 1.25, a wall is more. 1.8 m of span
 * is narrower than the smallest road tile the net lays (4.2) and the
 * shallowest doorstep flight (2.0), and wider than every hand-placed prop
 * that is also flat.
 *
 * Everything on the far side of either threshold keeps its pin, which is the
 * conservative direction: the failure this can have is a pin somebody did
 * not need, not a placement they cannot find.
 */
export const SURFACE_MAX_H = 0.6;
export const SURFACE_MIN_SPAN = 1.8;

/* `box` is what Props measured off the built mesh — { height, size } — so
   this never walks geometry itself. Called with no box (a record that has
   not been built yet, or a test asking the catalogue question alone) it
   answers on the ref rule only. */
export function isPinnable(record, box = null) {
  if (!record) return false;
  if (isDerived(record.ref)) return false;
  if (!box) return true;
  const h = box.height, span = box.size;
  // Unmeasured: pin it. Being wrong in the direction of a spare pin beats
  // silently hiding a placement because a bounding box came back empty.
  if (!(h > 0) || !(span > 0)) return true;
  return h > SURFACE_MAX_H || span < SURFACE_MIN_SPAN;
}

/* The number of pins above which the cloud has stopped being a finding aid.
   Not a rendering limit — ten thousand pins cost the frame nothing, which is
   the whole point of the Points cloud — a READING limit. Past this the
   author is looking at pins instead of at the world, and js/studio.js turns
   the layer off and says so rather than leaving them to find the switch. */
export const PIN_LEGIBLE_MAX = 120;
