// Water body presets, split out of Water.js so the export contract layer can
// read them without importing three.js (the JavaScriptCore test suite and the
// pure-JS exporters cannot). Water.js re-exports WATER_PRESETS, so nothing
// upstream had to change.
//
// waveAmp/waveFreq/speed multiply params.water.waveHeight/waveSpeed; clarity is
// how far light reaches before the body colour takes over.
//
// AND TWO OPTICAL TERMS, which is what a water body is actually recognised by.
// Every optical number in the shader used to be a literal shared by all three
// presets — the reflection cap, the specular lobe and the sparkle — so an open
// sea and a still inland lake reflected the world with exactly the same
// strength, and the difference between "a mirror with a horizon in it" and
// "a surface with light crawling on it" could not be stated at all.
//
//   mirror  how far the fresnel reflection is allowed to climb at grazing
//           angles. High is a lake with the far bank upside down in it; low is
//           open water, which scatters and never quite mirrors.
//   glint   how hard the sun's own reflection and the surface sparkle read.
//           This is the shimmer half: a sea trades the mirror for it.
//
// AND THE TWO THAT DECIDE WHAT COLOUR THE DEPTH IS.
// The body colour used to be `mix(shallow, deep, smoothstep(1, 26, depth))`:
// a straight ramp between two authored colours that reached `deep` at 26 m
// and stayed there. Two things are wrong with that and both are visible. It
// saturates — a 26 m shelf and a 200 m trench are the same colour, so a sea
// has no depth beyond the shelf. And it moves all three channels together,
// which is precisely what water does not do: red is absorbed in the first few
// metres and blue survives tens of them, and that divergence IS the reason
// deep water looks the way it does. A single ramp can only ever produce a
// tint, never that.
//
//   absorb      extinction per metre. Applied per channel against a fixed
//               red:green:blue ratio of 1 : 0.62 : 0.45, so the warm end of
//               whatever colour the palette chose dies first and the body
//               approaches `deep` asymptotically instead of clamping to it.
//               Silt-laden open sea takes the most, glacial melt the least —
//               which is the same fact `clarity` states for the alpha, kept
//               as its own number because one is about transparency and the
//               other about hue and they do not move together.
//   shoreBlend  metres of GROUND, measured from the waterline, over which the
//               shore colour gives way to the shallow one. Ground rather than
//               depth on purpose: over a gently shelving bay one metre of
//               depth can be four hundred metres of shallows, and a shoreline
//               band keyed to depth paints the entire bay.
export const WATER_PRESETS = {
  // Open sea: shimmer rather than mirror. Both plates with an ocean in them
  // ask for exactly that trade in the same words.
  ocean:   { waveAmp: 1.0, waveFreq: 1.0, speed: 1.0, clarity: 0.55, mirror: 0.5, glint: 1.5,
             absorb: 0.11, shoreBlend: 18 },
  // Sheltered water: still enough to hold a reflection, which is what makes a
  // moat read as a moat from two kilometres up.
  lake:    { waveAmp: 0.35, waveFreq: 1.6, speed: 0.6, clarity: 0.75, mirror: 0.78, glint: 0.85,
             absorb: 0.085, shoreBlend: 10 },
  glacial: { waveAmp: 0.5, waveFreq: 1.3, speed: 0.5, clarity: 0.9, mirror: 0.72, glint: 1.0,
             absorb: 0.055, shoreBlend: 12 },
};

export function waterPreset(name) {
  return WATER_PRESETS[name] || WATER_PRESETS.ocean;
}
