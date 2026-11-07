// What fire does to the things around it, as data and pure functions.
//
// Split out of fx/fire.js for the same reason props/detail-spec.js is split
// out of the grass: fire.js imports three.js, so nothing in it can be tested
// or reused outside a GPU context — and these rules are exactly the part
// that has to agree between the flame, the grass shader and the engine's
// plant-ignition pass. One definition, three readers.
//
// Pure JS — no three.js, no DOM — so it runs under the test suite. The char
// colour travels as a hex and fire.js is the one that makes it a Color.

// How long a thing takes to go from lit to fully charred.
export const CHAR_SECONDS = 9;
export const CHAR_HEX = 0x18130f;

// How far past its own radius a fire scorches the plants around it. Well
// beyond the flame itself: heat kills a ring of grass long before anything
// in it is actually alight.
export const SCORCH_RADIUS_SCALE = 3.4;

// A ground fire sets light to the vegetation standing in it. Deliberately
// the SAME reach as the grass scorch: one rule — whatever is inside the
// visibly burnt ring is burnt — so a tree never stands lush and green in the
// middle of a circle of ash.
export const PLANT_IGNITE_SCALE = SCORCH_RADIUS_SCALE;

/* Which placed blocks count as "green", and so burn on contact with a fire.
   Anchored at a path segment on purpose: a "treehouse" is a building and a
   "pineapple-stand" is a stall, and neither should catch because a plant is
   spelled inside its name. */
const PLANT_REF = /(^|\/)(tree|tree-small|pine|birch|bush|hedge)$/;
export const isPlantRef = (ref) => PLANT_REF.test(String(ref ?? ""));

/* The heat field the vegetation shaders read: one vec4 per fire,
   (x, z, scorchRadius, char) — XZ only, because fires and plants are both
   seated on the same heightfield, so a planar distance IS the distance.

   `char` ramps 0→1 over CHAR_SECONDS so a fresh fire scorches outward
   instead of incinerating its clearing the instant it is lit. */
export function burnFieldFor(fires) {
  const out = [];
  for (const f of fires) {
    const age = Math.min(Math.max((f.t ?? 0) / CHAR_SECONDS, 0), 1);
    out.push(f.x, f.z, f.r * SCORCH_RADIUS_SCALE, age * age * (3 - 2 * age));
  }
  return out;
}

/* Re-seat every fire on the ground as it stands now, returning true when
   anything actually moved. Sculpting moves the ground out from under a fire,
   and a flame left at its old height hangs in the air over the new hollow. */
export function reseatFires(fires, heightAt) {
  let moved = false;
  for (const f of fires) {
    const y = heightAt(f.x, f.z);
    if (Math.abs(y - f.y) > 1e-4) { f.y = y; moved = true; }
  }
  return moved;
}
