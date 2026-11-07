/* The world the editor opens on.
 *
 * js/default-world.js is authored by pasting a saved `.world.json` in, which
 * is the cheapest authoring loop there is and also the easiest one to get
 * silently wrong: a truncated paste, a file from an older engine, a world
 * that is nine tenths open water. None of those fail loudly in a browser —
 * the editor boots, the terrain comes up wrong or empty, and the first thing
 * every visitor sees is the mistake.
 *
 * So the pasted document is held to exactly what an OPENED file is held to,
 * plus the one thing an opened file is not: it has to be worth opening on.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { DEFAULT_WORLD } from "../../../src/genesis/world/default-world.js";
import {
  validateWorldFile, serializeWorldFile, parseWorldFile,
  paramsFromWorldFile, propsFromWorldFile, omissionNote,
  WORLD_FILE_KIND, WORLD_FILE_VERSION,
} from "../../../src/genesis/world/worldfile.js";
import { normalizeSeed, hashSeed } from "../../../src/kernel/seed.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { screenSeed } from "../../../src/kernel/core/survey.js";

test("the default world is a world file this tool would open", () => {
  const errors = validateWorldFile(DEFAULT_WORLD);
  eq(errors.length, 0, `the default world would be refused by the Open button: ${errors.join("; ")} —`);
  eq(DEFAULT_WORLD.kind, WORLD_FILE_KIND);
  eq(DEFAULT_WORLD.fileVersion, WORLD_FILE_VERSION);
});

test("it survives the round trip the save/open path puts a file through", () => {
  // Not decoration: this is the trip a re-authored default takes on its way
  // in — saved out of the editor, pasted here, read back on the next boot.
  const { doc, errors } = parseWorldFile(serializeWorldFile(DEFAULT_WORLD));
  eq(errors.length, 0, `errors: ${errors.join("; ")} —`);
  eq(JSON.stringify(doc), JSON.stringify(DEFAULT_WORLD), "the default world does not round-trip —");
});

test("its seed is a real seed and the file agrees with itself about it", () => {
  const seed = DEFAULT_WORLD.world.seed;
  ok(normalizeSeed(seed), `the default seed ${JSON.stringify(seed)} is not a seed`);
  eq(DEFAULT_WORLD.world.params.seed, seed, "the params name a different seed from the record —");
  eq(DEFAULT_WORLD.world.seedHash, hashSeed(seed) >>> 0, "the recorded seed hash is not this seed's —");
});

test("the params the editor boots are its own object", () => {
  // studio.js hands these straight to the Engine, which mutates them for the
  // rest of the session. Sharing structure with the module constant would
  // make every knob the visitor turns edit the default world itself.
  const a = paramsFromWorldFile(DEFAULT_WORLD);
  a.terrain.height = 1;
  a.sky.timeOfDay = 0;
  eq(DEFAULT_WORLD.world.params.terrain.height, 800, "boot params share structure with the file —");
  eq(DEFAULT_WORLD.world.params.sky.timeOfDay, 17.15, "boot params share structure with the file —");
});

test("everything it carries can be put back", () => {
  // A placement whose geometry is not in the table restores as nothing at
  // all. The landing carries no placements today; this is what tells the
  // next person that the boot path does seat them, and that a paste which
  // lost the geometry table would be caught here rather than on the page.
  const records = propsFromWorldFile(DEFAULT_WORLD);
  eq(records.length, DEFAULT_WORLD.world.props.length, "placements were lost on the way out of the file —");
  for (const r of records) {
    ok(r.uid, "a placement came back without a uid");
    ok(r.proc || r.ref || r.url, `placement ${r.uid} came back with nothing to build`);
  }
  eq(omissionNote(DEFAULT_WORLD), null, "the default world was pasted in with imported models missing from it —");
});

/* ── worth opening on ──
   The screener exists because the raw terrain distribution runs from an
   unbroken massif to an atoll with two rocks on it, and the landing is no
   longer screened — it is chosen. Choosing is only better than screening if
   the thing chosen would have passed a bar of its own, so it gets one: the
   same coarse pass, run on the seed the file names, against the params the
   file carries. */
test("the world it grows is land with relief in it", () => {
  const p = paramsFromWorldFile(DEFAULT_WORLD);
  const read = screenSeed({
    mint: () => p.seed,
    samplerFor: (seed) => {
      const q = { ...p, seed };
      return { height: createHeightSampler(q), size: q.terrain.size };
    },
    attempts: 1,
  });
  ok(read.land > 0.3, `the default world is ${Math.round(read.land * 100)}% land — the tool would open on open water`);
  ok(read.land < 0.98, `the default world is ${Math.round(read.land * 100)}% land — there is no coast on it`);
  ok(read.relief > 200, `the default world has ${Math.round(read.relief)}m of relief — it would open on a plain`);
});

report("default-world");
