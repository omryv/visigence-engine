/* Where the sun is at a given hour — the one answer, for everybody who asks.
 *
 * This curve lived inside Sky.setTimeOfDay and nowhere else, which meant that
 * anything else wanting to know where the light comes from had to either
 * transcribe it or guess. Two things did:
 *
 *   the shelf   lit every world from a fixed 43.6° key whatever the hour, so
 *               a world authored 24 minutes AFTER this curve's sunset was
 *               presented under afternoon modelling — and the visitor who
 *               clicked it arrived in a world with no direct light at all;
 *   the framing Engine.frameWorld picked a pose from the terrain alone, and
 *               because the sun's azimuth is pinned to the −z half, the
 *               default shot looked straight into every evening sun.
 *
 * Neither is a bug in the curve. Both are what happens when the curve has no
 * name to import. So it has one now, and the guard that matters — is the sun
 * actually UP at this hour — is a function call rather than a thing to know.
 *
 * Pure JS, no three.js: the suite asserts these numbers, tools/arrival-check
 * measures against them, and the shelf grades its lamp by them.
 *
 * The model is deliberately simple and always has been: a half-circle from
 * sunrise to sunset with a fixed azimuth sweep and a constant southward
 * component. It is not astronomy — there is no latitude and no season — and
 * it does not need to be. What it has to be is ONE model.
 */

/** The sun crosses the horizon at these hours. Not configurable — the ramp
    below is written around them, and every authored hour is judged by them. */
export const SUNRISE_H = 6;
export const SUNSET_H = 18;

/* The sun's own tilt out of the camera's usual half of the world. Every
   direction below carries it, which is WHY the framing has to know about the
   sun: a pose facing −z faces the sun at every hour it is low. */
const SOUTHING = -0.45;
const SWEEP = 0.55;

/** The raw altitude sine: +1 at noon, 0 at the horizon, negative at night.
    This is the term the sky's own night and dusk ramps are written on, so it
    is exported rather than re-derived from the direction below. */
export function sunAltitudeSine(tod) {
  return Math.sin(((tod - SUNRISE_H) / (SUNSET_H - SUNRISE_H)) * Math.PI);
}

/** The unit direction TO the sun, in world space. A plain object, so this
    module stays three-free and the shelf, the tools and the suite can all
    read it. */
export function sunDirection(tod) {
  const ang = ((tod - SUNRISE_H) / (SUNSET_H - SUNRISE_H)) * Math.PI;
  const x = Math.cos(ang) * SWEEP, y = Math.sin(ang), z = SOUTHING;
  const n = Math.hypot(x, y, z);
  return { x: x / n, y: y / n, z: z / n };
}

/** How high the sun actually stands, in degrees. NOT asin(sunAltitudeSine):
    the southing shortens the vertical component, so an hour whose sine says
    0.23 puts the sun at 18.5°, and an hour whose sine says −0.10 puts it
    8.4° UNDER the horizon. This is the number an authored hour is judged by
    and the one the shelf's lamp is graded from. */
export function sunElevationDeg(tod) {
  return Math.asin(sunDirection(tod).y) * 180 / Math.PI;
}

/** The sun's compass bearing, in radians, matching the convention the orbit
    camera uses (atan2(x, −z)) so a framing can be solved against it. */
export function sunAzimuth(tod) {
  const d = sunDirection(tod);
  return Math.atan2(d.x, -d.z);
}

/** Is there any direct light at all? Below the horizon the directional light
    still burns, from underneath, lighting nothing the camera can see — which
    is exactly how a world authored past sunset reads as flat and colourless
    while every number about it looks healthy. */
export function isSunUp(tod) {
  return sunElevationDeg(tod) > 0;
}

/* The band an authored hour should sit in for the world to be photographable:
   high enough that ground facing the camera takes real light, low enough to
   still read as the hour it claims. Worlds are checked against this by
   tools/arrival-check.mjs rather than by anybody's eye. */
export const MIN_WORKING_ELEVATION_DEG = 8;
