/* One sun, and an hour that is actually lit.
 *
 * engine/sky/sun.js exists because the curve used to live inside
 * Sky.setTimeOfDay and nowhere else, so nothing could ask it anything — and
 * two things that badly needed to ask went ahead and guessed. A world was
 * authored at 18.4 against a sunset at 18.0 and shipped with its sun 8.4°
 * under the horizon; the shelf lit it at a flat 43.6° and could not show it;
 * and Engine.frameWorld pointed the opening shot at a sun it never asked
 * about. This suite holds the curve, the horizon, and the two rules that
 * follow from them.
 */
import { test, ok, eq, close, report } from "../kernel/harness.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sunDirection, sunElevationDeg, sunAltitudeSine, sunAzimuth, isSunUp,
  SUNRISE_H, SUNSET_H, MIN_WORKING_ELEVATION_DEG,
} from "../../../src/genesis/sky/sun.js";
import { SEED_WORLD } from "./seed-world.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const code = (p) => readFileSync(join(ROOT, p), "utf8");

test("the curve is the one Sky.js has always drawn", () => {
  // Transcribed from the line this module replaced, so the extraction is
  // provably a move rather than a rewrite:
  //   ang = ((tod - 6) / 12) * π ; dir = (cos(ang)*0.55, sin(ang), -0.45).normalize()
  for (const tod of [0, 6, 9, 12, 15, 17.1, 18, 18.4, 21, 24]) {
    const ang = ((tod - 6) / 12) * Math.PI;
    const x = Math.cos(ang) * 0.55, y = Math.sin(ang), z = -0.45;
    const n = Math.hypot(x, y, z);
    const d = sunDirection(tod);
    close(d.x, x / n, 1e-12, `x at ${tod}:`);
    close(d.y, y / n, 1e-12, `y at ${tod}:`);
    close(d.z, z / n, 1e-12, `z at ${tod}:`);
    close(sunAltitudeSine(tod), Math.sin(ang), 1e-12, `altitude sine at ${tod}:`);
  }
  eq(SUNRISE_H, 6);
  eq(SUNSET_H, 18);
});

test("elevation is NOT the altitude sine — the southing flattens it", () => {
  /* The distinction that hid the bug. The sine at 18.4 is −0.104, which reads
     as "a touch past the horizon"; the actual elevation is −8.4°, which is
     civil twilight and no direct light on anything. And at 17.1 the sine says
     0.233 while the sun really stands at 18.5°. Anything reasoning about
     whether a world is LIT has to use the second number. */
  close(sunElevationDeg(18.4), -8.4, 0.05);
  close(sunElevationDeg(17.1), 18.5, 0.05);
  close(sunElevationDeg(12), 65.8, 0.05);
  ok(Math.abs(sunElevationDeg(18.4)) !== Math.abs(sunAltitudeSine(18.4)));
});

test("the horizon is where the sun stops lighting things", () => {
  ok(isSunUp(12) && isSunUp(17.9), "daylight hours read as up");
  ok(!isSunUp(18.4), "24 minutes past sunset is not daylight");
  ok(!isSunUp(3) && !isSunUp(22), "the small hours are not daylight");
  /* The instant of sunset itself is a float knife-edge — sin(π) is 1.2e−16,
     not 0 — so what is asserted is the thing that matters either side of it
     rather than which way the last bit falls. */
  close(sunElevationDeg(SUNSET_H), 0, 1e-9, "sunset is the horizon:");
  ok(!isSunUp(SUNSET_H + 0.05), "a minute past sunset is not lit");
  ok(MIN_WORKING_ELEVATION_DEG > 0, "the working floor must be above the horizon");
});

test("the azimuth lives permanently in one half of the world — which is WHY framing must ask", () => {
  /* The sun's z is the constant −0.45 at every hour, so its bearing never
     leaves the −z half. A camera pose written from the world's axes toward
     the origin therefore faces it at every hour that it is low — which is
     exactly what the default framing did. */
  for (let tod = 6; tod <= 18; tod += 0.5) {
    ok(sunDirection(tod).z < 0, `the sun crossed into +z at ${tod}`);
    const a = sunAzimuth(tod) * 180 / Math.PI;
    ok(Math.abs(a) <= 90, `bearing ${a.toFixed(1)}° at ${tod} left the −z half`);
  }
});

test("every world this repository ships is authored in daylight", () => {
  /* The regression, as a test. alpine shipped at 18.4 — after sunset — and
     every check in the suite passed: the terrain hashed identically across
     the click, the params travelled whole, the card said "Dusk". What none
     of them asked was whether anything in the picture was lit. */
  const tod = SEED_WORLD.world.params.sky.timeOfDay;
  const elev = sunElevationDeg(tod);
  ok(isSunUp(tod), `the default world is authored at ${tod}, ${(-elev).toFixed(1)}° UNDER the horizon`);
  ok(elev >= MIN_WORKING_ELEVATION_DEG,
    `the default world's sun is only ${elev.toFixed(1)}° up — under the ${MIN_WORKING_ELEVATION_DEG}° working floor`);
});

test("the default framing asks the sun where to stand", () => {
  /* Source conformance, like tests/chunks.test.js: frameWorld cannot be run
     here (Engine.js imports three) but it can be read. Every other camera
     solver in the repository already obeys this rule — js/cinematic.js
     derives every shot from sunAzimuth and refuses backlit poses outright —
     and frameWorld was the one that picked its pose from three axis
     multipliers. tools/arrival-check.mjs measures the result in a browser. */
  const engine = code("src/genesis/Engine.js");
  const frame = engine.slice(engine.indexOf("frameWorld(animated"), engine.indexOf("cinematic camera flight"));
  ok(/this\.sunDirection\(\)/.test(frame), "frameWorld stopped consulting the sun");
  ok(/SHOULDER_OFFSET/.test(frame), "frameWorld stopped standing off the sun's bearing");
  ok(!/s \* 0\.5, s \* 0\.42, s \* 0\.85/.test(frame),
    "frameWorld went back to the fixed axis pose that faced the sun at every hour");
});

report("sun");
