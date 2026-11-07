// Contract layer: fusion records, uid stability, spawn derivation.
import { test, eq, close, ok, report } from "../kernel/harness.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { bakeHeightField, createBakedSampler } from "../../../src/kernel/terrain/heightfield.js";
import { makeUid, nextUidIndex, scoreSettlements, deriveSpawn, buildFusionRecord, validateFusionRecord, alignedPalette, FUSION_VERSION } from "../../../src/genesis/world/fusion.js";

const params = makeParams({ seed: "K7QN-3F2A-9XBD", preset: "highlands" });
const field = bakeHeightField(params, 129);
const props = [
  { uid: makeUid(params.seed, 0), ref: "field-kit/barrel", url: "/objects/barrel.glb", label: "Barrel", position: [10, 5, -20], rotationY: 0.5, scale: 2, bytesKey: "k0" },
  { uid: makeUid(params.seed, 1), ref: null, url: null, label: "Imported", position: [-40, 8, 60], rotationY: 0, scale: 1, bytesKey: "k1" },
];

test("makeUid: stable per (seed, index), unique across indices", () => {
  eq(makeUid("K7QN-3F2A-9XBD", 0), makeUid("K7QN-3F2A-9XBD", 0));
  ok(makeUid("K7QN-3F2A-9XBD", 0) !== makeUid("K7QN-3F2A-9XBD", 1));
  ok(makeUid("AAAA-AAAA-AAAA", 0) !== makeUid("BBBB-BBBB-BBBB", 0));
});

test("nextUidIndex resumes past the highest minted uid", () => {
  eq(nextUidIndex([]), 0);
  eq(nextUidIndex(props), 2);
  eq(nextUidIndex([{ uid: makeUid("S", 40) }]), 41);
});

test("settlements land on dry, plausible ground", () => {
  const s = scoreSettlements(field, params);
  ok(s.length > 0, "no settlements found");
  for (const site of s) {
    ok(Math.abs(site.x) <= params.terrain.size / 2, "x in world");
    ok(Math.abs(site.z) <= params.terrain.size / 2, "z in world");
    ok(site.score > 0);
  }
});

test("spawn derives a double ring", () => {
  const spawn = deriveSpawn(scoreSettlements(field, params), params);
  eq(spawn.rings.length, 2, "double-ring = spawn:");
  ok(spawn.rings[1].r > spawn.rings[0].r);
  ok(spawn.yaw >= 0 && spawn.yaw < Math.PI * 2);
});

test("authored spawn override wins", () => {
  const spawn = deriveSpawn(scoreSettlements(field, params), params, { field, override: { x: 123.44, z: -456.78 } });
  eq(spawn.x, 123.4);
  eq(spawn.z, -456.8);
  ok(spawn.authored, "authored flag");
  eq(spawn.rings.length, 2);
});

test("no settlements → spawn falls back to land, never deep sea", () => {
  const spawn = deriveSpawn([], params, { field });
  ok(createBakedSampler(field)(spawn.x, spawn.z) >= 3, "fallback spawn must be on land");
});

test("fusion record: versioned, valid, uid-complete", () => {
  const rec = buildFusionRecord({ params, propRecords: props, field });
  eq(rec.version, FUSION_VERSION);
  eq(rec.seed, "K7QN-3F2A-9XBD");
  eq(validateFusionRecord(rec).length, 0, "validation errors:");
  eq(rec.props.length, 2);
  eq(rec.props[0].uid, props[0].uid);
  ok(rec.palette.stops.length >= 5, "palette values ride along");
});

test("validateFusionRecord catches drift", () => {
  const rec = buildFusionRecord({ params, propRecords: props, field });
  ok(validateFusionRecord({ ...rec, version: 999 }).length > 0, "bad version");
  ok(validateFusionRecord({ ...rec, props: [...rec.props, rec.props[0]] }).length > 0, "duplicate uids");
  ok(validateFusionRecord(null).length > 0, "null record");
});

test("point seating survives the record round trip", () => {
  // A bridge deck / stacked block is held ABOVE the terrain; if the flag is
  // dropped here, VSight re-seats it onto the riverbed it was built to span.
  const deck = { ...props[0], uid: makeUid(params.seed, 7), seat: "point", position: [0, 22, 0] };
  const rec = buildFusionRecord({ params, propRecords: [...props, deck], field });
  eq(rec.props[2].seat, "point", "point seat must travel");
  eq(rec.props[0].seat, null, "terrain seat stays null");
  eq(rec.props[2].position[1], 22, "authored height must travel");
});

test("settlements and spawn respect a raised flood level", () => {
  // Level 60 drowns the two lowest level-0 sites on this field (51.9 m and
  // 53.5 m), so scoring that ignores the flood fails this test.
  const flooded = { ...params, water: { ...params.water, level: 60 } };
  const sampler = createBakedSampler(field);
  const sites = scoreSettlements(field, flooded);
  ok(sites.length > 0, "flooded highlands still have habitable ground");
  for (const site of sites) {
    ok(sampler(site.x, site.z) > 61, `settlement under the flood at h=${sampler(site.x, site.z)}`);
  }
  const spawn = deriveSpawn([], flooded, { field });
  ok(sampler(spawn.x, spawn.z) >= 63, "fallback spawn must be on land above the flood");
});





report("contract");
