// The world as a file. A `.world.json` is the only thing this tool makes that
// outlives the tab, so the thing worth proving is that what comes back is what
// went in — not approximately, not mostly, but the same bytes.
import { test, eq, ok, report } from "../kernel/harness.js";
import { makeParams } from "../../../src/kernel/presets.js";
import { bakeHeightField } from "../../../src/kernel/terrain/heightfield.js";
import { makeUid, FUSION_VERSION } from "../../../src/genesis/world/fusion.js";
import {
  buildWorldFile, validateWorldFile, serializeWorldFile, parseWorldFile,
  worldFileName, paramsFromWorldFile, propsFromWorldFile, omissionNote,
  generatorNote, generatorProvenance,
  WORLD_FILE_KIND, WORLD_FILE_VERSION,
} from "../../../src/genesis/world/worldfile.js";
import { GENERATOR_VERSION, hashString } from "../../../src/kernel/terrain/fingerprint.js";
import { groundBundle } from "../../../src/kernel/terrain/ground.js";
import { groundBlock, groundFromWorldFile, GROUND_BLOCK_FIELDS } from "../../../src/genesis/world/worldfile.js";
import { DEFAULT_WORLD } from "../../../src/genesis/world/default-world.js";

const SEED = "K7QN-3F2A-9XBD";

/* A world that has been WORKED IN, not a fresh one: sculpted ground, painted
   grass, scattered planting, a fire, weather and an hour. Every one of these
   is a thing a session produces and a thing a file is worthless without. */
function workedParams() {
  const p = makeParams({ seed: SEED, biome: "verdant" });
  p.terrain.sculpt = [
    { mode: "raise", x: 120.5, z: -64.25, r: 48, strength: 0.7 },
    { mode: "flatten", x: -300, z: 210, r: 90, strength: 1 },
  ];
  p.terrain.rivers = [{
    id: "river-1", x: 120.5, z: -64.25, width: 16, depth: 4, meander: 1,
    strokeStart: 0, strokeCount: 2, reachedSea: true,
    path: [[120.5, -64.25, 42.5], [140, -80, 41.1], [160, -95, 39.8]],
  }];
  p.props.grass.patches = [{ x: 10, z: 20, r: 30, n: 400 }];
  p.props.scatter = [
    { id: "pine", x: 4.5, z: -9.5, rotationY: 1.2, scale: 1.1 },
    { id: "pine", x: 40.5, z: -99.5, rotationY: 0.2, scale: 0.9 },
  ];
  p.fx.fires = [{ x: 5, z: 5, r: 1.4 }];
  p.sky.weather = "rain";
  p.sky.timeOfDay = 18.25;
  p.water.level = 12;
  return p;
}

/* Procedural placements — what a generated world is made of. `proc` is the
   geometry spec, so the block IS its own asset and nothing has to be fetched
   to put it back. */
const procProps = [
  {
    uid: makeUid(SEED, 0), ref: "castle/keep", url: null, label: "Keep",
    position: [10.25, 5.5, -20.75], rotationY: 0.5, scale: 2,
    proc: { kind: "block", shape: "tower", w: 6, h: 18, d: 6 },
    tint: [0.2, 0.4, 0.9], style: "fantasy",
  },
  {
    uid: makeUid(SEED, 1), ref: "interior/chair", url: null, label: "Chair",
    position: [-40.5, 8.25, 60.5], rotationY: 3.14, scale: 1,
    // A real part list, not a token: the point of the geometry table is that
    // a block's spec is hundreds of bytes and a furnished room holds forty of
    // the same one, so a test whose "geometry" is two short strings would
    // prove the table saves nothing.
    proc: {
      kind: "block", shape: "chair",
      parts: [
        { g: "box", pos: [0, 0.42, 0], size: [0.46, 0.06, 0.44], mat: "wood" },
        { g: "box", pos: [0, 0.72, -0.2], size: [0.46, 0.54, 0.06], mat: "wood" },
        { g: "cyl", pos: [-0.19, 0.21, -0.17], size: [0.04, 0.42, 0.04], mat: "wood" },
        { g: "cyl", pos: [0.19, 0.21, -0.17], size: [0.04, 0.42, 0.04], mat: "wood" },
        { g: "cyl", pos: [-0.19, 0.21, 0.17], size: [0.04, 0.42, 0.04], mat: "wood" },
        { g: "cyl", pos: [0.19, 0.21, 0.17], size: [0.04, 0.42, 0.04], mat: "wood" },
      ],
    },
    seat: "point", use: { kind: "chair", verb: "sit", reach: 0.9 },
  },
];

const importedProp = {
  uid: makeUid(SEED, 2), ref: null, url: null, label: "rifle.glb",
  position: [0, 3, 0], rotationY: 0, scale: 1, bytesKey: "k2",
};

const params = workedParams();
const field = bakeHeightField(params, 129);
const build = (propRecords = procProps, world = "farshore") =>
  buildWorldFile({ params, propRecords, field, world });

test("a world file is a valid, versioned envelope", () => {
  const doc = build();
  eq(doc.kind, WORLD_FILE_KIND);
  eq(doc.fileVersion, WORLD_FILE_VERSION);
  eq(doc.world.version, FUSION_VERSION);
  eq(doc.origin, "farshore");
  eq(validateWorldFile(doc).length, 0, "validation errors:");
});

test("the file round-trips byte-identical", () => {
  // The whole promise, in one assertion: serialise, parse, serialise again,
  // and the two strings are the same string. Anything the format silently
  // drops or reorders fails here rather than three months later in somebody's
  // Downloads folder.
  const once = serializeWorldFile(build());
  const { doc, errors } = parseWorldFile(once);
  eq(errors.length, 0, "parse errors:");
  eq(serializeWorldFile(doc), once, "second serialisation differs");
});

test("saving the same world twice produces the same bytes", () => {
  // No clock in the file. `bakedAt` is threaded, not read from Date.now(),
  // so a second save overwrites the first instead of littering a folder with
  // near-duplicates that differ only in a timestamp nobody reads.
  eq(serializeWorldFile(build()), serializeWorldFile(build()));
});

test("the whole worked world survives — sculpt, grass, scatter, fire, weather, hour", () => {
  const { doc } = parseWorldFile(serializeWorldFile(build()));
  const p = paramsFromWorldFile(doc);
  eq(p.seed, SEED);
  eq(p.terrain.sculpt.length, 2, "sculpt strokes");
  eq(p.terrain.sculpt[0].x, 120.5);
  eq(p.terrain.sculpt[1].mode, "flatten");
  eq(p.props.grass.patches.length, 1, "grass patches");
  eq(p.props.grass.patches[0].n, 400);
  eq(p.props.scatter.length, 2, "scatter");
  eq(p.fx.fires.length, 1, "fires");
  eq(p.sky.weather, "rain");
  eq(p.sky.timeOfDay, 18.25);
  eq(p.water.level, 12, "the flood is where it was left");
});

test("placements come back where they were, as what they were", () => {
  const { doc } = parseWorldFile(serializeWorldFile(build()));
  const out = propsFromWorldFile(doc);
  eq(out.length, 2);
  eq(out[0].uid, procProps[0].uid, "uid is identity and must not be re-minted");
  eq(out[0].position[0], 10.25);
  eq(out[0].position[2], -20.75);
  eq(out[0].scale, 2);
  eq(out[0].style, "fantasy");
  ok(out[0].proc, "the geometry spec IS the asset — without it there is nothing to rebuild");
  // A chair that stops being a chair on the way through the file is an
  // interior that was only ever furnished for the tab that made it.
  eq(out[1].use.verb, "sit", "affordances travel");
  eq(out[1].seat, "point", "point seating travels");
  eq(out[1].position[1], 8.25, "authored height travels");
});

test("a placement is written without its nulls and read back with them", () => {
  /* A furnished city is thousands of placements and most of them are a block
     on the ground with nine fields of `null`. They are not written — but what
     the engine is handed has to be the whole record all the same, because
     Props reads `seat`, `bytesKey` and `placeholder` by name. */
  const doc = build();
  const onDisk = doc.world.props[0];
  eq(onDisk.url, undefined, "a null is not written");
  eq(onDisk.bytesKey, undefined);
  eq(onDisk.placeholder, undefined);
  eq(onDisk.stretch, undefined);
  eq(onDisk.scale, 2, "a field that is not its default is written");

  const out = propsFromWorldFile(doc)[0];
  for (const k of ["uid", "ref", "url", "label", "position", "rotationY", "scale",
                   "placeholder", "bytesKey", "seat", "tint", "stretch", "style", "use"]) {
    ok(k in out, `the expanded record is missing ${k}`);
  }
  eq(out.url, null);
  eq(out.bytesKey, null);
  eq(out.placeholder, false);
  eq(out.seat, null);
  ok(out.proc, "geometry restored from the table");

  // A default that was written back is the default, not a hole.
  const chair = propsFromWorldFile(doc)[1];
  eq(chair.scale, 1);
  eq(doc.world.props[1].scale, undefined, "scale 1 is not worth writing");
  eq(chair.seat, "point", "and a field that IS set survives the compaction");
});

test("the derived spawn travels, so an authored landing is not re-guessed", () => {
  const doc = build();
  ok(doc.world.spawn, "spawn present");
  ok(doc.world.spawn.rings.length === 2, "double ring");
});

/* The test above proves a spawn is WRITTEN. It did not prove the right one
   was, and for a while the wrong one was: buildWorldFile took no override, so
   deriveSpawn fell through to `settlements[0]` — the top-scoring habitable
   cell — and the landing the spawn tool had been used to place was discarded
   at every save. The author saw their own ring on the minimap and had no way
   to know the file did not carry it. */
test("an authored landing is what the file carries, not the one the scorer likes", () => {
  // Both already at the one decimal deriveSpawn rounds a landing to, so this
  // asserts the value travelled rather than re-asserting the rounding.
  const authored = { x: -812.5, z: 640.4 };
  const doc = buildWorldFile({ params, propRecords: procProps, field, world: "farshore", spawn: authored });
  eq(doc.world.spawn.authored, true, "the file says the landing was chosen, not scored");
  eq(doc.world.spawn.x, -812.5);
  eq(doc.world.spawn.z, 640.4);

  const derived = build().world.spawn;
  ok(derived.x !== doc.world.spawn.x || derived.z !== doc.world.spawn.z,
    "and it is genuinely a different point from the derived one, or this proves nothing");

  // The round trip closes: the editor reads doc.world.spawn straight back
  // into its own customSpawn on open (js/studio.js, openWorldFile).
  const { doc: back } = parseWorldFile(serializeWorldFile(doc));
  ok(back, "an authored spawn does not make the file invalid");
  eq(back.world.spawn.x, authored.x);
  eq(back.world.spawn.z, authored.z);
});

/* ── the params a file can carry that the world cannot survive ──
   The envelope check asked whether a document was SHAPED like a world file.
   It did not ask whether the terrain numbers inside it could be built, and
   three of them cannot. Each was reachable from a hand-edited or truncated
   file, and each failed somewhere worse than here: octaves at zero divided
   the noise by a zero weight and produced a NaN plate that loaded
   "successfully" and drew nothing, and a non-list `sculpt` threw part way
   through the load — after the editor had already taken the previous world
   apart. Refused at the door, neither can happen. */
test("terrain numbers a world cannot be built from are refused by name", () => {
  const bad = (mutate) => {
    const doc = JSON.parse(serializeWorldFile(build()));
    mutate(doc.world.params.terrain);
    return validateWorldFile(doc);
  };

  ok(bad((t) => { t.octaves = 0; }).some((e) => /octaves/.test(e)),
    "zero octaves is named — it is a NaN world, not a flat one");
  ok(bad((t) => { t.octaves = -3; }).some((e) => /octaves/.test(e)), "negative octaves too");
  ok(bad((t) => { t.sculpt = "raise"; }).some((e) => /sculpt/.test(e)),
    "a sculpt that is not a list is named here, not thrown mid-load");
  ok(bad((t) => { t.size = 0; }).some((e) => /size/.test(e)), "a world of no extent");
  // Erosion numbers that are not numbers are named at the door too. erode()
  // now falls back to its defaults rather than NaN'ing the field, but a file
  // carrying "drops": "many" was written by something that is not this module.
  ok(bad((t) => { t.erosion = { enabled: true, drops: "many" }; }).some((e) => /erosion\.drops/.test(e)),
    "a stringly droplet count is named");
  ok(bad((t) => { t.erosion = { enabled: true, evaporate: NaN }; }).some((e) => /evaporate/.test(e)),
    "NaN evaporation is named");
  ok(bad((t) => { t.erosion = { thermal: { talus: "steep" } }; }).some((e) => /thermal\.talus/.test(e)),
    "a stringly talus is named");
  ok(bad((t) => { t.erosion = "on"; }).some((e) => /erosion/.test(e)),
    "an erosion block that is not an object is named");
  // Rivers are records over sculpt-stroke slices; the strokes replay through
  // the sculpt path, but the description must be numbers and lists.
  ok(bad((t) => { t.rivers = "wet"; }).some((e) => /rivers/.test(e)), "a rivers value that is not a list");
  ok(bad((t) => { t.rivers = [{ id: "r1", x: 0, z: 0, width: "wide", depth: 2 }]; })
    .some((e) => /rivers\[0\]\.width/.test(e)), "a stringly river width is named");
  ok(bad((t) => { t.rivers = [{ id: "r1", x: 0, z: 0, width: 12, depth: 2, path: 7 }]; })
    .some((e) => /rivers\[0\]\.path/.test(e)), "a path that is not a list is named");

  // …and a parse refuses the document outright rather than handing back a
  // doc the caller has to remember to re-check.
  const doc = JSON.parse(serializeWorldFile(build()));
  doc.world.params.terrain.octaves = 0;
  const { doc: parsed, errors } = parseWorldFile(JSON.stringify(doc));
  eq(parsed, null, "parseWorldFile refuses it");
  ok(errors.some((e) => /octaves/.test(e)), "and says which number was wrong");
});

test("intent travels in the file, and intent nothing could have written is refused by name", () => {
  /* A conditioned world's ground is its seed AND its intent
     (engine/terrain/condition.js) — a file that dropped the intent would
     reopen the raw seed under settlements composed on the conditioned one. */
  const doc = JSON.parse(serializeWorldFile(build()));
  doc.world.params.terrain.intent = [{ type: "level", h: 31.25 }, { type: "summit", x: 578.69, z: -778.24, h: 212.5 }];
  eq(validateWorldFile(doc).length, 0, "a conditioned world validates");
  const { doc: back, errors } = parseWorldFile(JSON.stringify(doc));
  eq(errors.length, 0, "parse errors:");
  eq(JSON.stringify(paramsFromWorldFile(back).terrain.intent), JSON.stringify(doc.world.params.terrain.intent),
    "and its intent comes back exactly");

  const bad = (intent) => {
    const d = JSON.parse(serializeWorldFile(build()));
    d.world.params.terrain.intent = intent;
    return validateWorldFile(d);
  };
  ok(bad("level").some((e) => /intent is not a list/.test(e)), "an intent that is not a list");
  ok(bad([{ type: "level", h: "high" }]).some((e) => /intent\[0\]\.h/.test(e)), "a stringly height is named");
  ok(bad([{ type: "volcano", x: 0 }]).some((e) => /intent\[0\]\.type/.test(e)), "an unknown statement is named");
});

test("the terrain check does not refuse the files this repository writes", () => {
  // The whole risk of adding validation is rejecting something valid, which
  // for a world file is data loss of its own.
  eq(validateWorldFile(build()).length, 0, "a worked, sculpted world still validates");
  const fresh = buildWorldFile({ params: makeParams({ seed: SEED }), propRecords: [], field, world: null });
  eq(validateWorldFile(fresh).length, 0, "and so does a bare generated one");
  // `octaves` absent entirely is an older file that predates the field, and
  // mergeParams fills it — so absence must stay legal.
  const older = JSON.parse(serializeWorldFile(build()));
  delete older.world.params.terrain.octaves;
  eq(validateWorldFile(older).length, 0, "an absent octaves is a defaulted one, not a broken one");
});

test("imported models are named and dropped, never silently lost", () => {
  const doc = build([...procProps, importedProp]);
  eq(doc.world.props.length, 2, "only the procedural placements are carried");
  eq(doc.omitted.length, 1);
  eq(doc.omitted[0].uid, importedProp.uid);
  eq(doc.omitted[0].label, "rifle.glb");
  ok(omissionNote(doc).includes("One imported model"), "the importer says so out loud");
  eq(validateWorldFile(doc).length, 0, "a file with omissions is still a valid file");
});

test("shared geometry is written once, not once per placement", () => {
  /* The defect this table exists for: Crownway's first file measured 5.6 MB
     for 1,292 placements, and nearly all of it was the same few hundred bytes
     of part list copied twelve hundred times. A composed town is a thousand
     pieces built out of a few dozen shapes. */
  const chairs = [];
  for (let i = 0; i < 40; i++) {
    chairs.push({ ...procProps[1], uid: makeUid(SEED, 100 + i), position: [i, 0, 0] });
  }
  const doc = build([...procProps, ...chairs]);
  eq(doc.procs.length, 2, "two distinct shapes among 42 placements");
  eq(doc.world.props.length, 42);
  for (const p of doc.world.props) eq(p.proc, undefined, "the spec does not ride on the placement");
  // Every chair points at the same entry, and it is the chair's entry.
  const refs = new Set(doc.world.props.slice(2).map((p) => p.procRef));
  eq(refs.size, 1, "forty identical chairs, one shape");
  eq(doc.procs[[...refs][0]].shape, "chair");

  // And the saving is real, not theoretical: the table plus the indices
  // against the same placements carrying their own copies.
  const table = JSON.stringify([doc.procs, doc.world.props], null, 2).length;
  const copies = JSON.stringify(
    doc.world.props.map(({ procRef, ...p }) => ({ ...p, proc: doc.procs[procRef] })), null, 2).length;
  ok(table < copies * 0.6,
    `forty copies of one shape should collapse, got ${table} vs ${copies} bytes`);
});

test("geometry comes back out of the table exactly as it went in", () => {
  const { doc } = parseWorldFile(serializeWorldFile(build()));
  const out = propsFromWorldFile(doc);
  eq(out[0].proc.shape, "tower");
  eq(out[0].proc.h, 18);
  eq(out[1].proc.shape, "chair");
  eq(out[0].procRef, undefined, "the index is an artefact of the file, not of a record");
  // Two placements sharing a table entry must not share an OBJECT — moving a
  // wall would otherwise move every wall in the world.
  const many = propsFromWorldFile(build([procProps[1], { ...procProps[1], uid: makeUid(SEED, 200) }]));
  many[0].proc.shape = "MUTATED";
  eq(many[1].proc.shape, "chair", "each placement gets its own geometry object");
});

test("a placement pointing at geometry the file does not carry is named", () => {
  const good = build();
  ok(validateWorldFile({ ...good, procs: [] }).length > 0, "empty table");
  ok(validateWorldFile({ ...good, procs: undefined }).length > 0, "no table at all");
});

/* ── which generator made this ──────────────────────────────────────────────
   A world file carries INSTRUCTIONS, not ground: `world.field` is {res, size},
   so the heightfield is re-derived on every open, while the settlements and
   the spawn scored against that field travel as data. Those two halves age at
   different rates. These tests are the check that the file says which
   generator scored them, and that saying so does not break the files that
   never did. */

test("a world file names the generator that scored it", () => {
  const doc = build();
  eq(doc.generatorVersion, GENERATOR_VERSION);
  eq(generatorProvenance(doc).status, "current");
  eq(generatorNote(doc), null, "this build's own generator needs no sentence");
});

test("the generator version is its own number, not one of the schema versions", () => {
  /* Four version numbers live in one file and three of them answer "can this
     be parsed". If the fourth is ever read off one of the others, the day a
     schema moves is the day every world file claims a terrain change that did
     not happen — and worse, the reverse. */
  const doc = build();
  eq(doc.fileVersion, WORLD_FILE_VERSION, "envelope shape");
  eq(doc.world.version, FUSION_VERSION, "record shape");
  eq(doc.world.params.version, 1, "params shape");
  eq(doc.generatorVersion, GENERATOR_VERSION, "the terrain pipeline");
  ok(Number.isInteger(GENERATOR_VERSION) && GENERATOR_VERSION > 0,
    "a generator version is a positive integer");
});

test("a world from an older generator still loads, and says so", () => {
  /* THE CASE THIS EXISTS FOR. The pipeline changed shape, so the ground this
     seed makes today is not the ground its settlements were scored on. The
     file is still complete and still opens — refusing it would strand every
     world already saved — but a person looking at it is told, because a
     difference nobody is shown is a bug report nobody can act on. */
  const old = { ...build(), generatorVersion: GENERATOR_VERSION - 1 };
  eq(validateWorldFile(old).length, 0, "an older generator is not an invalid file");
  const p = generatorProvenance(old);
  eq(p.status, "older");
  eq(p.version, GENERATOR_VERSION - 1);
  eq(p.current, GENERATOR_VERSION);
  const note = generatorNote(old);
  ok(note && note.includes(String(GENERATOR_VERSION - 1)), "the note names the generator that minted it");
  ok(note.includes(String(GENERATOR_VERSION)), "and the one deriving it now");
});

test("a world from a newer generator is named as newer, not as older", () => {
  const ahead = { ...build(), generatorVersion: GENERATOR_VERSION + 1 };
  eq(validateWorldFile(ahead).length, 0, "a file from a newer build still opens");
  eq(generatorProvenance(ahead).status, "newer");
  ok(generatorNote(ahead).includes("ahead of"), "the direction is stated");
});

test("a file minted before the stamp is unknown, not version zero", () => {
  /* Absent and zero are different facts. Every world file written before this
     stamp existed has no `generatorVersion`, and reading that as "generator 0"
     would report all of them as a mismatch — which is how a version number
     stops being read at all. */
  const legacy = { ...build() };
  delete legacy.generatorVersion;
  eq(validateWorldFile(legacy).length, 0, "an unstamped file is still a valid file");
  const p = generatorProvenance(legacy);
  eq(p.stamped, false);
  eq(p.version, null, "absent is not zero");
  eq(p.status, "unstamped");
  ok(generatorNote(legacy).includes("names no generator"), "unknown provenance is stated as unknown");
});

test("a stamp that is not a version number is refused", () => {
  /* A mismatch is provenance; a stamp that is not a version at all means the
     file was written by something that is not this module — the same standard
     the placement checks apply. */
  const good = build();
  for (const bad of ["2", 0, -1, 2.5, true, {}, NaN]) {
    const doc = { ...good, generatorVersion: bad };
    eq(generatorProvenance(doc).status, "malformed", `${JSON.stringify(bad)} is not a version`);
    ok(validateWorldFile(doc).length > 0, `${JSON.stringify(bad)} is refused`);
  }
});

test("the stamp survives the round trip", () => {
  const once = serializeWorldFile(build());
  const { doc, errors } = parseWorldFile(once);
  eq(errors.length, 0, "parse errors:");
  eq(doc.generatorVersion, GENERATOR_VERSION);
  eq(serializeWorldFile(doc), once, "the stamp is written back where it was read");
});

test("a generated world has nothing to omit", () => {
  const doc = build();
  eq(doc.omitted.length, 0);
  eq(omissionNote(doc), null);
});

test("the file carries no ArrayBuffer map — JSON cannot hold one", () => {
  const doc = build([...procProps, importedProp]);
  eq(doc.world.assets, undefined, "assets must not survive into a JSON file");
});

test("validate names every way a file can be wrong", () => {
  const good = build();
  const bent = (patch) => validateWorldFile({ ...good, ...patch });
  ok(bent({ kind: "something-else" }).length > 0, "wrong kind");
  ok(bent({ fileVersion: 99 }).length > 0, "wrong envelope version");
  ok(bent({ world: null }).length > 0, "no world");
  ok(bent({ omitted: "nope" }).length > 0, "omitted must be a list");
  ok(validateWorldFile(null).length > 0, "null");
  ok(validateWorldFile("a string").length > 0, "a string");
  ok(validateWorldFile({ ...good, world: { ...good.world, version: 1 } }).length > 0, "old world version");
  ok(validateWorldFile({ ...good, world: { ...good.world, props: [...good.world.props, good.world.props[0]] } }).length > 0,
    "duplicate uids");
  // A placement with no geometry of its own — no spec, no index into the
  // table — that names bytes instead. Nothing this module writes looks like
  // this, so a file that does was written by something else.
  ok(validateWorldFile({ ...good, world: { ...good.world,
      props: [{ uid: "p0", label: "rifle", position: [0, 0, 0], url: "/x.glb" }] } }).length > 0,
    "a file naming bytes it cannot carry was not written by this module");
});

test("a file the user picked that is not a world file is refused, not thrown", () => {
  // A wrong file is an ordinary event. Every one of these must come back as a
  // named failure with doc === null, and none of them may throw.
  for (const junk of ["", "not json at all", "{", "[]", "null", '{"kind":"other"}', '{"kind":"worldgence.world"}']) {
    const { doc, errors } = parseWorldFile(junk);
    eq(doc, null, `should refuse: ${junk.slice(0, 20)}`);
    ok(errors.length > 0, `should name a failure: ${junk.slice(0, 20)}`);
    ok(typeof errors[0] === "string" && errors[0].length > 0, "the first failure is the useful one");
  }
});

test("the filename is derived from the world, never from the clock", () => {
  const doc = build();
  const name = worldFileName(doc);
  eq(name, worldFileName(doc), "stable");
  ok(name.startsWith("farshore-"), `named for its world, got ${name}`);
  ok(name.endsWith(".world.json"), `compound extension, got ${name}`);
  ok(!/\s/.test(name), "no spaces in a filename");
  // A world with no grammar behind it still gets a name.
  const loose = buildWorldFile({ params, propRecords: procProps, field, world: null });
  ok(worldFileName(loose).startsWith("verdant-"), "falls back to the biome");
  // Two different seeds are two different files.
  const other = buildWorldFile({ params: { ...params, seed: "AAAA-BBBB-CCCC" }, propRecords: procProps, field, world: "farshore" });
  ok(worldFileName(other) !== name, "a different seed is a different file");
});

test("reading a file does not let the caller mutate it", () => {
  const doc = build();
  const p = paramsFromWorldFile(doc);
  p.terrain.sculpt.push({ mode: "raise" });
  p.seed = "MUTATED";
  eq(doc.world.params.terrain.sculpt.length, 2, "params are cloned out");
  eq(doc.world.params.seed, SEED);
  const out = propsFromWorldFile(doc);
  out[0].position[0] = 999;
  eq(doc.world.props[0].position[0], 10.25, "positions are cloned out");
});

/* ══════════════════ the ground block ══════════════════
   A file MAY carry the receipt groundBundle wrote — and the promise that pays
   for adding it is that a file which does not is the file it always was. */

test("a file saved without a ground block is the same bytes it was before the block existed", () => {
  /* Pinned against the code as it stood BEFORE the ground block: this exact
     world was serialised by the HEAD worldfile.js (git archive HEAD, the same
     probe run against both trees) and measured 2,197 bytes with FNV-1a
     1070186123; the default world's serialisation measured 3427497588. If
     either moves, a file nobody asked to change has changed. WORLD_FILE_VERSION
     did not move either (see worldfile.js's header for why it need not), so
     this is the whole of the migration: there is nothing to migrate. */
  const SEED0 = "K7QN-3F2A-9XBD";
  const p = makeParams({ seed: SEED0, biome: "verdant" });
  p.terrain.sculpt = [{ mode: "raise", x: 120.5, z: -64.25, r: 48, strength: 0.7 }];
  p.water.level = 12;
  const props = [{ uid: makeUid(SEED0, 0), ref: "castle/keep", url: null, label: "Keep", position: [10.25, 5.5, -20.75], rotationY: 0.5, scale: 2, proc: { kind: "block", shape: "tower", w: 6, h: 18, d: 6 } }];
  const s = serializeWorldFile(buildWorldFile({ params: p, propRecords: props, field: bakeHeightField(p, 65), world: "farshore" }));
  eq(s.length, 2197, "bytes");
  eq(hashString(s) >>> 0, 1070186123, "FNV-1a of the file");
  eq(hashString(serializeWorldFile(DEFAULT_WORLD)) >>> 0, 3427497588, "FNV-1a of the default world");
  eq(WORLD_FILE_VERSION, 1, "the envelope version did not move");
  ok(!("ground" in build()), "no block unless one is handed in");
});

const GROUND = groundBundle(params, { res: 65 }).manifest;

test("a ground block is written when a manifest is handed in, and survives the round trip", () => {
  const doc = buildWorldFile({ params, propRecords: procProps, field, world: "farshore", ground: GROUND });
  eq(Object.keys(doc.ground).join(","), GROUND_BLOCK_FIELDS.join(","), "the eight lines, in order");
  for (const k of GROUND_BLOCK_FIELDS) eq(doc.ground[k], GROUND[k], `ground.${k}`);
  eq(validateWorldFile(doc).length, 0, "validation errors:");
  const once = serializeWorldFile(doc);
  const back = parseWorldFile(once);
  eq(back.errors.length, 0, "parse errors:");
  eq(serializeWorldFile(back.doc), once, "second serialisation differs");
  eq(JSON.stringify(groundFromWorldFile(back.doc)), JSON.stringify(groundBlock(GROUND)));
  eq(groundFromWorldFile(build()), null, "a file without one reads back null");
  // Everything else in the file is untouched by the block's presence.
  const without = JSON.parse(serializeWorldFile(build()));
  const withIt = JSON.parse(once);
  delete withIt.ground;
  eq(JSON.stringify(withIt), JSON.stringify(without), "the block is the only difference");
});

test("a ground block is held to its shape and to the params it sits beside", () => {
  const good = buildWorldFile({ params, propRecords: procProps, field, world: "farshore", ground: GROUND });
  const bent = (patch) => validateWorldFile({ ...good, ground: { ...good.ground, ...patch } });
  const cases = [
    ["another world's parameterHash", { parameterHash: (GROUND.parameterHash ^ 1) >>> 0 }, "parameterHash"],
    ["another size", { size: GROUND.size * 2 }, "ground.size"],
    ["another waterline", { waterLevel: GROUND.waterLevel + 1 }, "ground.waterLevel"],
    ["a hash that is not 32 bits", { heightHash: 2 ** 32 }, "ground.heightHash"],
    ["a hash as a string", { landMaskHash: "abc" }, "ground.landMaskHash"],
    ["a grid of one", { res: 1 }, "ground.res"],
    ["a generator that is not a version", { generatorVersion: "2" }, "ground.generatorVersion"],
    ["a line the format does not carry", { min: -3 }, "ground.min"],
  ];
  for (const [name, patch, names] of cases) {
    const errs = bent(patch);
    ok(errs.some((e) => e.includes(names)), `${name}: refused naming ${names} (got ${JSON.stringify(errs)})`);
  }
  const missing = { ...good, ground: { ...good.ground } };
  delete missing.ground.flowMaskHash;
  ok(validateWorldFile(missing).some((e) => e.includes("ground.flowMaskHash")), "a missing line is named");
  ok(validateWorldFile({ ...good, ground: [1, 2] }).some((e) => e.includes("ground is not an object")), "a list is not a block");
  ok(validateWorldFile({ ...good, ground: null }).length > 0, "null is not a block (absent is the key not being there)");
  // A generator mismatch is provenance, not invalidity — the same rule the
  // envelope's own stamp follows.
  eq(bent({ generatorVersion: GENERATOR_VERSION + 1 }).length, 0, "an older or newer generator still opens");
});

test("buildWorldFile refuses a manifest baked from other params", () => {
  const other = groundBundle(makeParams({ seed: "OTHER-SEED-0001" }), { res: 17, erode: false }).manifest;
  let threw = null;
  try { buildWorldFile({ params, propRecords: procProps, field, ground: other }); } catch (e) { threw = e; }
  ok(threw && /parameterHash/.test(threw.message), `refused naming the hash (${threw && threw.message})`);
  let hole = null;
  try { groundBlock({ ...GROUND, heightHash: undefined }); } catch (e) { hole = e; }
  ok(hole && /heightHash/.test(hole.message), "a manifest with a hole in it is refused");
});

report("worldfile");
