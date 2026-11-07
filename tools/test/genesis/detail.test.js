// The Unity-standard detail spec: one module resolves params.props.grass for
// BOTH the browser renderer and the Unity exporter. These tests pin the
// contract between them — defaults, palette-derived colours, override
// merging — because a drift here renders one thing and exports another.

import { test, eq, ok, close, report } from "../kernel/harness.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { PALETTES } from "../../../src/genesis/style/palettes.js";
import {
  resolveDetail, DETAIL_PROTOTYPES, WIND_DEFAULTS, PLACEMENT_DEFAULTS,
  healthyColorFor, dryColorFor, mixHex, placementFit, windVector,
} from "../../../src/genesis/props/detail-spec.js";

const PLACE = PLACEMENT_DEFAULTS;
const proto = (key) => DETAIL_PROTOTYPES.find((p) => p.key === key);

test("defaults resolve to the Unity-shaped standard", () => {
  const r = resolveDetail(makeParams(), PALETTES.verdant);
  eq(r.detailDistance, 250);
  eq(r.detailDensityScale, 1);
  eq(r.wind.speed, WIND_DEFAULTS.speed);
  eq(r.wind.size, WIND_DEFAULTS.size);
  eq(r.wind.bending, WIND_DEFAULTS.bending);
  eq(r.prototypes.length, DETAIL_PROTOTYPES.length);
  for (const p of r.prototypes) {
    ok(p.minWidth > 0 && p.maxWidth >= p.minWidth, `${p.key} width range`);
    ok(p.minHeight > 0 && p.maxHeight >= p.minHeight, `${p.key} height range`);
    ok(p.noiseSpread > 0, `${p.key} noiseSpread`);
    ok(p.healthyColor != null && p.dryColor != null, `${p.key} colours resolved`);
    ok(["grassBillboard", "grass", "vertexLit"].includes(p.renderMode), `${p.key} renderMode`);
  }
  const share = r.prototypes.reduce((a, p) => a + p.share, 0);
  ok(Math.abs(share - 1) < 0.01, `prototype shares sum to 1, got ${share}`);
});

test("healthy/dry colours follow the biome palette", () => {
  const verdant = resolveDetail(makeParams(), PALETTES.verdant).prototypes[0];
  const tundra = resolveDetail(makeParams(), PALETTES.tundra).prototypes[0];
  ok(verdant.healthyColor !== tundra.healthyColor, "biomes keep their character");
  eq(verdant.healthyColor, healthyColorFor(PALETTES.verdant.grass));
  eq(verdant.dryColor, dryColorFor(PALETTES.verdant.grass));
  // Flowers author their own colours and must not be palette-overridden.
  const flowers = resolveDetail(makeParams(), PALETTES.verdant).prototypes.find((p) => p.key === "flowers");
  eq(flowers.healthyColor, 0xe9e2c9);
});

test("sparse params merge over prototype defaults", () => {
  const params = makeParams();
  params.props.grass.wind = { bending: 0.9 };
  params.props.grass.prototypes = [{ key: "grass", maxHeight: 2.0 }];
  const r = resolveDetail(params, PALETTES.verdant);
  eq(r.wind.bending, 0.9);
  eq(r.wind.speed, WIND_DEFAULTS.speed, "unset wind keys keep their defaults");
  eq(r.prototypes.length, 1);
  eq(r.prototypes[0].maxHeight, 2.0);
  eq(r.prototypes[0].minWidth, DETAIL_PROTOTYPES[0].minWidth, "unset prototype keys fill from the standard");
});

test("out-of-range values clamp instead of exporting an illegal manifest", () => {
  const params = makeParams();
  params.props.grass.detailDensityScale = 3;
  params.props.grass.wind = { speed: -1, size: 2, bending: 0.5 };
  const r = resolveDetail(params, PALETTES.verdant);
  eq(r.detailDensityScale, 1);
  eq(r.wind.speed, 0);
  eq(r.wind.size, 1);
});

test("mixHex interpolates channelwise", () => {
  eq(mixHex(0x000000, 0xffffff, 0.5), 0x808080);
  eq(mixHex(0xff0000, 0x00ff00, 1), 0x00ff00);
});

/* ── where a tuft may stand ──
   These rules used to be two literals inside the renderer — y < 0.15 and
   slope > 1.2 — which is why they had no test and why grass grew out of a
   raised sea. They are a pure function now, and every case below is one a
   person can check by looking at a world. */

test("nothing grows below the waterline, wherever the waterline is", () => {
  /* The bug this exists for: the clearance was measured from y = 0, so a
     world flooded to 40 m grew grass out of the sea for forty metres. */
  for (const waterY of [0, 40, -12]) {
    eq(placementFit(proto("grass"), PLACE, { y: waterY - 0.5, waterY }), 0,
      `grass grew under a waterline at ${waterY}`);
    eq(placementFit(proto("grass"), PLACE, { y: waterY + PLACE.waterClearance * 0.5, waterY }), 0,
      `grass grew inside the clearance at ${waterY}`);
    ok(placementFit(proto("grass"), PLACE, { y: waterY + 3, waterY }) > 0,
      `grass refused dry ground three metres above a waterline at ${waterY}`);
  }
});

test("the slope cutoff thins rather than cuts", () => {
  /* A hard cutoff draws a contour line across a hillside — the same tell the
     terrain's own material thresholds have. Between slopeFade and maxSlope
     the fit has to fall through the middle rather than step. */
  const full = placementFit(proto("grass"), PLACE, { y: 20, grade: 0 });
  const mid = placementFit(proto("grass"), PLACE, {
    y: 20, grade: (PLACE.slopeFade + PLACE.maxSlope) / 2,
  });
  const over = placementFit(proto("grass"), PLACE, { y: 20, grade: PLACE.maxSlope + 0.1 });
  eq(full, 1, "level ground is not full density");
  ok(mid > 0 && mid < full, `halfway up the fade read ${mid}, expected strictly between`);
  eq(over, 0, "past the cutoff something still grew");
});

test("a species with its own slope limit keeps it", () => {
  // The tuft holds a bank that clover slides off — that difference is the
  // only thing making them two species rather than two sprites.
  const grade = 1.3;
  ok(placementFit(proto("tuft"), PLACE, { y: 20, grade }) > 0, "the wild tuft lost its bank");
  eq(placementFit(proto("clover"), PLACE, { y: 20, grade }), 0, "clover held a 1.3 grade");
});

test("the altitude band sorts a shoreline patch into species", () => {
  /* One patch painted across a shore has to come out reeds at the bottom and
     heather at the top, with neither in the other's place — that is the
     whole claim "multiple species" makes beyond having more sprites. */
  const low = { y: 2, waterY: 0 }, high = { y: 60, waterY: 0 };
  ok(placementFit(proto("reed"), PLACE, low) > 0, "no reeds at the water");
  eq(placementFit(proto("reed"), PLACE, high), 0, "reeds grew sixty metres above the sea");
  ok(placementFit(proto("heather"), PLACE, high) > 0, "no heather on the height");
  eq(placementFit(proto("heather"), PLACE, low), 0, "heather grew at the tideline");
});

test("moisture preference is a weighting, not a second band", () => {
  // Ferns want damp and heather wants dry, and both still grow in between —
  // a preference that excluded would be a band, and there is already a band.
  const near = { y: 3, waterY: 0 }, far = { y: 90, waterY: 0 };
  const fernNear = placementFit(proto("fern"), PLACE, near);
  const fernMid = placementFit(proto("fern"), PLACE, { y: 30, waterY: 0 });
  ok(fernNear > fernMid && fernMid > 0, `fern ${fernNear} → ${fernMid} is not a preference`);
  const heatherHigh = placementFit(proto("heather"), PLACE, far);
  const heatherMid = placementFit(proto("heather"), PLACE, { y: 30, waterY: 0 });
  ok(heatherHigh > heatherMid && heatherMid > 0,
    `heather ${heatherHigh} → ${heatherMid} is not a preference`);
});

test("every fit is a probability — never negative, never above one", () => {
  // It is used as a pick weight, and a negative weight would silently steal
  // from the species after it in the walk.
  for (const p of DETAIL_PROTOTYPES) {
    for (const y of [-50, 0, 0.1, 1, 5, 25, 60, 200, 5000]) {
      for (const grade of [0, 0.3, 0.7, 1.2, 3]) {
        const f = placementFit(p, PLACE, { y, waterY: 0, grade });
        ok(f >= 0 && f <= 1 && Number.isFinite(f), `${p.key} at y=${y} grade=${grade} → ${f}`);
      }
    }
  }
});

/* ── the wind, which now has a direction ── */

test("a wind bearing is a unit vector, and 0 is +X", () => {
  const [x0, z0] = windVector(0);
  close(x0, 1, 1e-9); close(z0, 0, 1e-9);
  const [x9, z9] = windVector(90);
  close(x9, 0, 1e-9); close(z9, 1, 1e-9);
  for (const deg of [0, 37, 90, 180, 271, 359]) {
    const [x, z] = windVector(deg);
    close(Math.hypot(x, z), 1, 1e-9, `bearing ${deg} is not a unit vector`);
  }
});

test("the wind default is Unity's fixed diagonal, unchanged", () => {
  /* 0 has to be the default and it has to be +X, because the shader runs the
     four wave frequencies in a wind-aligned frame whose first axis is the
     wind — so direction 0 IS world XZ and every existing world's field waves
     exactly as it did. Change this default and every world's grass moves. */
  eq(WIND_DEFAULTS.direction, 0);
  const [x, z] = windVector(WIND_DEFAULTS.direction);
  close(x, 1, 1e-12); close(z, 0, 1e-12);
});

test("a bearing wraps rather than clamps — it is a compass", () => {
  const r = (d) => resolveDetail(withWind({ direction: d }), PALETTES.verdant).wind.direction;
  eq(r(450), 90, "a bearing past a full turn should wrap");
  eq(r(-90), 270, "a negative bearing should wrap");
  eq(r("nonsense"), 0, "a bearing that is not a number should fall back, not NaN");
});

function withWind(wind) {
  const params = makeParams();
  params.props.grass.wind = { ...params.props.grass.wind, ...wind };
  return params;
}

report("detail");
