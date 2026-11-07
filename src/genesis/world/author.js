/* author.js — THE AUTHOR INTERFACE: a world asked for in statements, and told
 * back what it kept.
 *
 * ── what this replaces ──
 * js/make-brief.js reads a sentence through a phrase table. That was the
 * honest thing to build when the only author was a person typing into a box:
 * it picks a grammar, reads the dressing, and hashes the rest of the words
 * into a seed. What it cannot do is say "the summit is HERE and 260 m high",
 * because a phrase table has nothing to say it with — and an AI author, the
 * other kind there now is, never needed the table in the first place: it can
 * write the statements condition.js already solves. So the author interface
 * is a DOCUMENT of those statements (schema/intent.schema.json), and this
 * module is the one door both of its readers use — bin/genesis.mjs from a
 * terminal and bin/genesis-mcp.mjs over the Model Context Protocol:
 *
 *     intentDocumentErrors(doc, { seed })                 -> string[]
 *     paramsForIntent(doc, { seed })                      -> { params, seed, world, grammarRecords, statements }
 *     compileIntent(doc, { seed, res, key })              -> Promise<{ world, certificate, report }>
 *     explainWorld(worldDoc, { spawn, objective, res })   -> explanation
 *     formatCompileReport(report) / formatExplanation(e)  -> text for a terminal
 *
 * ── what a compile is ──
 * Nothing new: the pipeline every world already goes through, in the order
 * it already runs. makeParams(seed) — or a grammar's fullParams, when the
 * document names one — with the statements appended to the intent; the
 * sampler, whose conditioning IS the report (nats, the per-statement miss,
 * converged); groundBundle at the canonical grid, whose manifest becomes the
 * file's ground block; js/worldfile.js buildWorldFile; and js/certificate.js
 * buildCertificate over the result. A compiled world is an ordinary
 * .world.json the editor opens and bin/genesis-verify.mjs checks, and its
 * certificate is an ordinary certificate. The only thing this module adds is
 * the reading of the conditioning back out, statement by statement.
 *
 * ── the document is held to more than a file is ──
 * js/worldfile.js holds a file's intent to intentErrors (condition.js), which
 * leaves the v1 records as they always were — a flat's radius under 48 m is
 * clamped, a level's inset out of range is clamped, an unknown field is
 * ignored — so a file that loaded yesterday still loads. A document written
 * TODAY by an author has no such history, and a silent repair is a world
 * nobody asked for (the argument condition.js makes for its v2 records), so
 * here those are errors too: every field a statement may carry is named
 * (STATEMENT_FIELDS), and the two v1 clamps are bounds. tests/intent-schema
 * .test.js holds the schema, this module and condition.js to the same answer.
 *
 * ── the grammar records come first ──
 * A document that names a world ("farshore", "lonepalm") is that grammar's
 * params for the seed — its terrain, biome and water — and that includes the
 * intent the grammar's own bar asks of the seed (js/worlds.js conditionFor:
 * a level record when the seed misses Farshore's land bar, nothing for a
 * seed that clears it). The author's statements are appended after those, so
 * the world still clears its bar, and the report keeps the two apart: the
 * grammar's records are read back as `grammar` rows, the author's statements
 * as `statements` rows by their own index in the document — and a world is
 * MET only when both are, because a grammar record the ground misses is a
 * world off its own bar whoever wrote the record. explainWorld splits a world
 * file the same way when its origin names a grammar and its intent begins
 * with exactly the records that grammar asks of its seed (an intent edited
 * since is read as statements throughout), so compile and explain report the
 * same rows at the same indices. The grammar's landform (sculpt strokes, its places)
 * is NOT applied: that is a build, with an engine, and this is a compile.
 *
 * No DOM, no three.js, no storage. Not part of engine/core: it reaches
 * js/certificate.js, which needs WebCrypto, and js/worlds.js.
 */

import { makeParams, mergeParams } from "../../kernel/presets.js";
import { normalizeSeed } from "../../kernel/seed.js";
import { createHeightSampler } from "../../kernel/terrain/heightfield.js";
import { groundBundle } from "../../kernel/terrain/ground.js";
import { CANONICAL_RES } from "../../kernel/terrain/canonical.js";
import { terrainParameterHash, hex } from "../../kernel/terrain/fingerprint.js";
import { posteriorSigma } from "../../kernel/terrain/sigma.js";
import { intentErrors, INTENT_VERSION, INTENT_TYPES, MAX_INTENT, GRADIENT_STEP } from "../../kernel/terrain/condition.js";
import { reachTerrain, parRoute } from "../../kernel/core/terrain-reach.js";
import { WORLDS, fullParams } from "./worlds.js";
import { buildWorldFile, validateWorldFile, paramsFromWorldFile, generatorProvenance } from "./worldfile.js";
import { buildCertificate, MAX_VERIFY_RES } from "./certificate.js";

export const INTENT_KIND = "visigenesis.intent";
/* The document's version is the vocabulary's: a version-2 document may carry
   every record condition.js INTENT_VERSION 2 solves, and nothing else. */
export const INTENT_DOC_VERSION = INTENT_VERSION;
/* The two grammars an author may name. The machine page offers these two
   (js/make-brief.js worldForBrief), and they are the two whose identity is
   in their terrain rather than in a landform the compile does not run. */
export const AUTHOR_WORLDS = Object.freeze(["farshore", "lonepalm"]);
export const MAX_TITLE = 48;

/* A statement is MET when the ground misses it by no more than this, metres.
   The solve's own miss is "zero to the millimetre for anything the ground
   can express" and v1 records are solved once, with a ridge that leaves a
   little standing: on K7QN-3F2A-9XBD a pad beside a summit, a level and a
   point was measured missing by 2.0 cm (tests/author.test.js). Five
   centimetres is above that and still far under anything a player could
   stand on and notice; a miss over it is a statement the ground could not
   keep, and the report says so with the number. */
export const MET_TOLERANCE = 0.05;

/* The radius a flat or a pad needs (condition.js MIN_FLAT_R: under it the
   ring rows are the slope rows again), and the nearest a shoreline's side may
   stand (MIN_SHORE_OFFSET). Not exported there; tests/intent-schema.test.js
   probes intentErrors at both edges so the two cannot drift apart. */
export const MIN_RADIUS = 2 * GRADIENT_STEP;
export const MIN_SHORE_OFFSET = 12;
export const MAX_RAY_SAMPLES = 64;

/* Every field a statement of each type may carry. `type` is on all of them.
   The schema's per-type `properties` are exactly these (the test holds it). */
export const STATEMENT_FIELDS = Object.freeze({
  point: ["x", "z", "h", "op"],
  summit: ["x", "z", "h"],
  flat: ["x", "z", "r", "h"],
  level: ["h", "op", "inset"],
  shoreline: ["points", "side", "offset", "level"],
  ray: ["eye", "at", "h", "contact", "samples"],
  corridor: ["points", "maxGrade"],
  pad: ["x", "z", "r", "h"],
});
const DOC_FIELDS = ["$schema", "kind", "version", "seed", "world", "title", "statements"];

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v) => JSON.stringify(v ?? null);

/* ── the document ── */

/**
 * What is wrong with an intent document, as sentences; empty when it
 * compiles. `seed` is the caller's override (a --seed flag), which stands in
 * for a document that names none. Never throws.
 *
 * The statements go through condition.js intentErrors — the same check a
 * world file's intent is held to, with the plate size of the world they will
 * land on — and then through the author's stricter checks above. Paths are
 * the document's own (`statements[2].r`), not a file's (`terrain.intent[2]`).
 */
export function intentDocumentErrors(doc, { seed = null } = {}) {
  try {
    return documentChecks(doc, seed);
  } catch (e) {
    return [`not a readable intent document (${e?.message ?? e})`];
  }
}

function documentChecks(doc, seedOverride) {
  if (!isObject(doc)) return ["an intent document is a JSON object"];
  const errors = [];
  for (const k of Object.keys(doc)) if (!DOC_FIELDS.includes(k)) errors.push(`${k} is not a field of an intent document (${DOC_FIELDS.join(", ")})`);
  if (doc.kind !== INTENT_KIND) errors.push(`kind ${show(doc.kind)} is not "${INTENT_KIND}"`);
  if (doc.version !== INTENT_DOC_VERSION) errors.push(`version ${show(doc.version)} is not ${INTENT_DOC_VERSION}`);
  if (doc.$schema !== undefined && typeof doc.$schema !== "string") errors.push(`$schema ${show(doc.$schema)} is not a string`);
  if (doc.title !== undefined && !(typeof doc.title === "string" && doc.title.length <= MAX_TITLE)) errors.push(`title is not a string of at most ${MAX_TITLE} characters`);
  if (doc.seed !== undefined && !seedText(doc.seed)) errors.push(`seed ${show(doc.seed)} is not a seed: a string of 1–64 characters with a letter or digit in it`);
  if (seedOverride != null && !seedText(seedOverride)) errors.push(`the seed given ${show(seedOverride)} is not a seed`);
  if (doc.seed === undefined && seedOverride == null) errors.push("no seed: put one in the document (\"seed\": \"K7QN-3F2A-9XBD\") or pass one (--seed)");
  if (doc.world !== undefined && doc.world !== null && !AUTHOR_WORLDS.includes(doc.world)) {
    errors.push(`world ${show(doc.world)} is not one of ${AUTHOR_WORLDS.join(", ")} (or null)`);
  }
  const st = doc.statements;
  if (!Array.isArray(st)) { errors.push("statements is not a list"); return errors; }
  if (st.length > MAX_INTENT) errors.push(`statements holds ${st.length}; the most a world reads is ${MAX_INTENT}`);
  st.forEach((s, i) => errors.push(...statementChecks(s, `statements[${i}]`)));
  if (errors.length) return errors;

  /* The size of the plate the statements land on, and the records a grammar
     brings with it, decide whether the list as a whole fits: condition.js
     checks every coordinate against the plate and the rows against MAX_ROWS. */
  const { params, grammarRecords } = paramsForIntent(doc, { seed: seedOverride });
  const all = params.terrain.intent;
  if (all.length > MAX_INTENT) errors.push(`the ${grammarRecords} record${grammarRecords === 1 ? "" : "s"} ${doc.world} brings and ${st.length} statements are ${all.length}; the most a world reads is ${MAX_INTENT}`);
  for (const e of intentErrors(all, { size: params.terrain.size })) {
    errors.push(e.replace(/^terrain\.intent\[(\d+)\]/, (_, i) => {
      const k = Number(i) - grammarRecords;
      return k >= 0 ? `statements[${k}]` : `${doc.world}'s own record ${i}`;
    }).replace(/^terrain\.intent /, "the statements "));
  }
  return errors;
}

const seedText = (s) => typeof s === "string" && s.length >= 1 && s.length <= 64 && /[A-Za-z0-9]/.test(s);

/* The author's own checks on one statement: known type, known fields, and the
   bounds the file format clamps. Coordinates, rows and the v2 records' shape
   are condition.js's to judge, above. */
function statementChecks(s, at) {
  if (!isObject(s)) return [`${at} is not an object`];
  if (!INTENT_TYPES.includes(s.type)) return [`${at}.type ${show(s.type)} is not one of ${INTENT_TYPES.join(", ")}`];
  const errors = [];
  const allowed = STATEMENT_FIELDS[s.type];
  for (const k of Object.keys(s)) {
    if (k !== "type" && !allowed.includes(k)) errors.push(`${at}.${k} is not a field of a ${s.type} (${["type", ...allowed].join(", ")})`);
  }
  // A pad's radius is condition.js's to name (intentErrors); a flat's it clamps.
  if (s.type === "flat" && finite(s.r) && s.r < MIN_RADIUS) {
    errors.push(`${at}.r ${s.r} is under ${MIN_RADIUS} m, where a flat's ring would be its own slope rows`);
  }
  if (s.type === "flat" && s.h !== undefined && !finite(s.h)) errors.push(`${at}.h ${show(s.h)} is not a number`);
  if (s.type === "level" && s.inset !== undefined && !(finite(s.inset) && s.inset >= 0.05 && s.inset <= 1)) {
    errors.push(`${at}.inset ${show(s.inset)} is not a number from 0.05 to 1 (a share of the world's width)`);
  }
  return errors;
}

/**
 * The params an intent document compiles to. Assumes a document
 * intentDocumentErrors accepts (it is called from there, before the plate
 * checks, so it must not depend on them).
 *
 * Returns { params, seed, world, grammarRecords, statements } — `seed` the
 * normalised seed (normalizeSeed: "k7qn" is "K7QN-2222-2222"), `world` the
 * grammar id or null, `grammarRecords` how many intent records the grammar
 * brought ahead of the statements.
 */
export function paramsForIntent(doc, { seed = null } = {}) {
  const raw = seed ?? doc.seed;
  const s = normalizeSeed(raw);
  if (!s) throw new TypeError(`paramsForIntent: ${show(raw)} is not a seed`);
  const world = doc.world ?? null;
  /* fullParams is the editor's own door to a grammar's params (js/worlds.js),
     its bar's intent included. */
  if (world && !WORLDS[world]) throw new TypeError(`paramsForIntent: no world grammar ${show(world)}`);
  const base = world ? fullParams(WORLDS[world], s) : makeParams({ seed: s });
  const grammar = Array.isArray(base.terrain.intent) ? base.terrain.intent : [];
  const statements = (doc.statements || []).map((r) => JSON.parse(JSON.stringify(r)));
  const params = mergeParams(base, { terrain: { intent: [...grammar, ...statements] } });
  return { params, seed: s, world, grammarRecords: grammar.length, statements };
}

/* ── reading the conditioning back, statement by statement ── */

/* A short name for a record, for a terminal line. */
export function describeStatement(r) {
  const n = (v) => (finite(v) ? String(Math.round(v * 10) / 10) : "?");
  switch (r?.type) {
    case "point": return `point (${n(r.x)}, ${n(r.z)}) ${r.op && r.op !== "=" ? r.op + " " : ""}${n(r.h)} m`;
    case "summit": return `summit (${n(r.x)}, ${n(r.z)}) at ${n(r.h)} m`;
    case "flat": return `flat (${n(r.x)}, ${n(r.z)}) r ${n(r.r)} m${finite(r.h) ? ` at ${n(r.h)} m` : ""}`;
    case "pad": return `pad (${n(r.x)}, ${n(r.z)}) r ${n(r.r)} m at ${n(r.h)} m`;
    case "level": return `level ${r.op && r.op !== "=" ? r.op + " " : ""}${n(r.h)} m over ${n((r.inset ?? 0.76) * 100)}% of the width`;
    case "shoreline": return `shoreline of ${r.points?.length ?? 0} points${r.side ? `, land ${r.side}` : ""}`;
    case "corridor": return `corridor of ${r.points?.length ?? 0} points, grade ≤ ${finite(r.maxGrade) ? r.maxGrade : 0.12}`;
    case "ray": return `ray from (${n(r.eye?.[0])}, ${n(r.eye?.[1])}, ${n(r.eye?.[2])}) to (${n(r.at?.[0])}, ${n(r.at?.[1])})${finite(r.h) ? ` at ${n(r.h)} m` : ""}`;
    default: return String(r?.type ?? "record");
  }
}

/* One row per intent record a sampler solved: its index among the records,
   its type, its miss in metres (null when it stated no row: dropped by
   MAX_ROWS, or every row off the plate) and whether that is within
   MET_TOLERANCE. `records` is the list the world carries, which — for a list
   intentErrors accepts — is the list condition.js normalised, in order. */
function statementRows(records, sampler, from = 0) {
  const misses = sampler.conditioning?.system?.misses || [];
  return records.slice(from).map((r, k) => {
    const miss = misses[from + k] ?? null;
    return {
      index: k, type: r.type, what: describeStatement(r),
      stated: miss !== null, miss, met: miss !== null && miss <= MET_TOLERANCE,
    };
  });
}

/* How many of a world file's records are its grammar's own: the length of
   the grammar's records for the seed when the file's intent begins with
   exactly those (JSON-equal, record by record), else 0. */
function grammarPrefix(origin, seed, records) {
  if (!AUTHOR_WORLDS.includes(origin) || !WORLDS[origin]) return 0;
  const own = fullParams(WORLDS[origin], seed).terrain.intent;
  if (!Array.isArray(own) || own.length > records.length) return 0;
  return own.every((r, k) => JSON.stringify(r) === JSON.stringify(records[k])) ? own.length : 0;
}

const conditioningSummary = (c) => (c
  ? { nats: c.nats, miss: c.miss, rows: c.rows, active: c.active, converged: c.converged, dropped: c.dropped, records: c.records }
  : null);

/* ── compile ── */

/**
 * Compile an intent document into a world file and its certificate.
 *
 * @param {object} doc               an intent document (schema/intent.schema.json)
 * @param {object} [opts]
 * @param {string|null} [opts.seed]  overrides the document's seed
 * @param {number} [opts.res]        the ground grid (default CANONICAL_RES; the
 *                                   world file's ground block and the
 *                                   certificate are both at it)
 * @param {object|null} [opts.key]   a signing key (js/certificate.js); null
 *                                   mints an ephemeral one and says so
 * @returns {Promise<{ world: object, certificate: object, report: object }>}
 *          Throws a TypeError listing intentDocumentErrors for a document
 *          that does not compile.
 */
export async function compileIntent(doc, { seed = null, res = CANONICAL_RES, key = null } = {}) {
  const errors = intentDocumentErrors(doc, { seed });
  if (errors.length) throw new TypeError(`not a compilable intent document — ${errors.join("; ")}`);
  if (!Number.isInteger(res) || res < 2 || res > MAX_VERIFY_RES) throw new RangeError(`compileIntent: res ${res} is not a grid of 2–${MAX_VERIFY_RES}`);
  const { params, seed: s, world, grammarRecords } = paramsForIntent(doc, { seed });
  /* An empty list is a world with no intent: the sampler is the seed's own
     ground, bit for bit (heightfield.js), and the report says so. */
  const sampler = createHeightSampler(params);
  const bundle = groundBundle(params, { res });
  const file = buildWorldFile({ params, propRecords: [], field: bundle.field, world, ground: bundle.manifest });
  const certificate = await buildCertificate(file, { res, key });
  const all = params.terrain.intent;
  const rows = statementRows(all, sampler, grammarRecords);
  const grammar = statementRows(all, sampler).slice(0, grammarRecords);
  const c = sampler.conditioning;
  const report = {
    seed: s, world, title: doc.title ?? null,
    parameterHash: terrainParameterHash(params),
    grammarRecords,
    grammar,
    statements: rows,
    conditioning: conditioningSummary(c),
    met: [...grammar, ...rows].every((r) => r.met) && (!c || c.converged),
    ground: {
      res: bundle.manifest.res, size: bundle.manifest.size, min: bundle.manifest.min, max: bundle.manifest.max,
      waterLevel: bundle.manifest.waterLevel, heightHash: bundle.manifest.heightHash,
      landMaskHash: bundle.manifest.landMaskHash, flowMaskHash: bundle.manifest.flowMaskHash,
    },
    spawn: file.world.spawn ? { x: file.world.spawn.x, z: file.world.spawn.z } : null,
    certificate: { fingerprint: certificate.signer.fingerprint, ephemeral: certificate.signer.ephemeral, sha256: certificate.subject.sha256 },
  };
  return { world: file, certificate, report };
}

/** The compile report as a few lines for a terminal. */
export function formatCompileReport(r) {
  const out = [];
  out.push(`world ${r.seed}${r.world ? ` (${r.world})` : ""}${r.title ? ` — ${r.title}` : ""}, parameter hash ${hex(r.parameterHash)}`);
  out.push(...grammarLines(r.world, r.grammar));
  out.push(...statementLines(r.statements));
  out.push(conditioningLine(r.conditioning));
  out.push(`ground ${r.ground.res}², ${r.ground.min.toFixed(1)}…${r.ground.max.toFixed(1)} m, height hash ${hex(r.ground.heightHash)}`);
  out.push(`certificate signed by ${r.certificate.fingerprint}${r.certificate.ephemeral ? " (ephemeral key)" : ""}`);
  out.push(r.met ? "every statement met" : "NOT every statement met — see the misses above");
  return out.join("\n");
}

/* The grammar's own records, before the statements, under their own label so
   the statements' indices stay the document's. */
function grammarLines(world, rows) {
  if (!rows?.length) return [];
  return [`  ${world} brings ${rows.length} intent record${rows.length === 1 ? "" : "s"} of its own, solved with the statements:`,
    ...rows.map((s) => `  [${world} ${s.index}] ${s.what}: ${rowVerdict(s)}`)];
}
const rowVerdict = (s) => (!s.stated ? "NOT STATED (dropped, or off the plate)" : `${s.met ? "met" : "MISSED"}, miss ${fmtMetres(s.miss)}`);

function statementLines(rows) {
  if (!rows.length) return ["  no statements: the seed's own ground"];
  return rows.map((s) => `  [${s.index}] ${s.what}: ${rowVerdict(s)}`);
}
const fmtMetres = (m) => (m < 0.01 ? `${(m * 1000).toFixed(1)} mm` : m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`);
function conditioningLine(c) {
  if (!c) return "conditioning: none — the world carries no intent";
  return `conditioning: ${c.nats.toFixed(1)} nats, worst miss ${fmtMetres(c.miss)}, ${c.rows} rows (${c.active} held), ${c.converged ? "converged" : "DID NOT CONVERGE"}${c.dropped ? `, ${c.dropped} dropped` : ""}`;
}

/* ── explain ── */

/**
 * What a world file's statements did to its ground, and — given a spawn and
 * an objective — what it is like to walk.
 *
 * @param {object} doc                 a world file (js/worldfile.js)
 * @param {object} [opts]
 * @param {[number, number]|null} [opts.spawn]      world metres; defaults to
 *                                     the file's own spawn when only an
 *                                     objective is given
 * @param {[number, number]|null} [opts.objective]  world metres
 * @param {number|null} [opts.res]     the grid to bake at for the reach
 *                                     (default the file's ground block's,
 *                                     else CANONICAL_RES)
 * @param {number} [opts.sigmaGrid]    the freedom map's grid (default 65)
 * @returns {object} { seed, origin, generator, parameterHash, grammar,
 *          statements, conditioning, met, sigma, ground, reach, route }
 *          Throws a TypeError for a file that does not validate and a
 *          RangeError, when it bakes (a spawn or an objective is given),
 *          for a grid outside 2–MAX_VERIFY_RES: the grid
 *          comes from the file (its ground block) when not given, and a file
 *          is the caller's — over MCP an untrusted one — so it is held to the
 *          cap a certificate's re-bake is, before anything is allocated.
 */
export function explainWorld(doc, { spawn = null, objective = null, res = null, sigmaGrid = 65 } = {}) {
  const errors = validateWorldFile(doc);
  if (errors.length) throw new TypeError(`not a valid world file — ${errors.join("; ")}`);
  const params = paramsFromWorldFile(doc);
  const sampler = createHeightSampler(params);
  const records = Array.isArray(params.terrain.intent) ? params.terrain.intent : [];
  const own = grammarPrefix(doc.origin, params.seed, records);
  const grammar = statementRows(records, sampler).slice(0, own);
  const rows = statementRows(records, sampler, own);
  const c = sampler.conditioning;
  const sg = posteriorSigma(params, { n: sigmaGrid, sampler }).stats;
  const out = {
    seed: params.seed, origin: doc.origin ?? null,
    generator: generatorProvenance(doc).status,
    parameterHash: terrainParameterHash(params),
    grammar,
    statements: rows,
    conditioning: conditioningSummary(c),
    met: [...grammar, ...rows].every((r) => r.met) && (!c || c.converged),
    sigma: { grid: sigmaGrid, priorMedian: sg.priorMedian, postMedian: sg.postMedian, atStatements: sg.atStatements, interiorHalved: sg.interiorHalved, rows: sg.rows },
    ground: null, reach: null, route: null,
  };
  const fileSpawn = doc.world?.spawn && finite(doc.world.spawn.x) && finite(doc.world.spawn.z) ? [doc.world.spawn.x, doc.world.spawn.z] : null;
  const from = spawn || (objective ? fileSpawn : null);
  if (!from) return out;

  const grid = bakeGrid(doc, res, "explainWorld");
  const b = groundBundle(params, { res: grid });
  const level = b.manifest.waterLevel;
  out.ground = {
    res: grid, heightHash: b.manifest.heightHash,
    // The file's own receipt, checked against the bake this explanation stands on.
    matchesFile: doc.ground ? doc.ground.res === grid && doc.ground.heightHash === b.manifest.heightHash : null,
  };
  const reach = reachTerrain(b.field, { spawn: from, level, wet: b.wet });
  out.reach = {
    spawn: from, spawnFrom: spawn ? "given" : "file",
    walkable: reach.spawnCell >= 0, snapped: reach.snapped, snapMetres: reach.snapMetres,
    reachedCount: reach.reachedCount, reachedFraction: reach.reachedFraction, walkableFraction: reach.walkableFraction,
  };
  if (objective) {
    const r = parRoute(b.field, from, objective, { level, wet: b.wet, reach });
    out.route = {
      objective, verdict: r.verdict, parSeconds: r.parSeconds, distance: r.distance, climb: r.climb,
      descent: r.descent, maxGrade: r.maxGrade, cells: r.cells,
      issues: r.issues.map((x) => ({ id: x.id, severity: x.severity, message: x.message })),
    };
  }
  return out;
}

/**
 * The grid a world file is baked at for a reading of it: `res` when given,
 * else the file's ground block's, else CANONICAL_RES — refused with a
 * RangeError outside 2–MAX_VERIFY_RES (js/certificate.js's cap on a re-bake).
 * validateWorldFile holds ground.res only to an integer of at least 2, so
 * without this a file could name any grid; a bake's cost grows about 4x per
 * doubling (2049² was measured at 6.9 s and 315 MB through genesis_explain).
 * js/overworld.js reads its grid through here too.
 */
export function bakeGrid(doc, res = null, who = "bake") {
  const grid = res ?? doc?.ground?.res ?? CANONICAL_RES;
  if (!Number.isInteger(grid) || grid < 2 || grid > MAX_VERIFY_RES) throw new RangeError(`${who}: grid ${grid} is not a grid of 2–${MAX_VERIFY_RES}`);
  return grid;
}

/** An explanation as lines for a terminal. */
export function formatExplanation(e) {
  const out = [];
  out.push(`world ${e.seed}${e.origin ? ` (${e.origin})` : ""}, parameter hash ${hex(e.parameterHash)}, generator ${e.generator}`);
  out.push(...grammarLines(e.origin, e.grammar));
  out.push(...statementLines(e.statements));
  out.push(conditioningLine(e.conditioning));
  const s = e.sigma;
  out.push(`freedom (${s.grid}² sigma): median ${s.priorMedian.toFixed(1)} m before the statements, ${s.postMedian.toFixed(1)} m after; ` +
    `${(s.interiorHalved * 100).toFixed(1)}% of the interior at least halved` +
    (s.atStatements === null ? "" : `; at the statements ${fmtMetres(s.atStatements)}`));
  if (e.ground) out.push(`ground re-baked at ${e.ground.res}²${e.ground.matchesFile === null ? "" : e.ground.matchesFile ? ", the file's ground block matches" : ", and the file's ground block does NOT match it"}`);
  if (e.reach) {
    const r = e.reach;
    out.push(!r.walkable
      ? `reach: no walkable ground near the ${r.spawnFrom === "file" ? "file's " : ""}spawn (${r.spawn.join(", ")})`
      : `reach: from (${r.spawn.join(", ")}) a walker gets to ${r.reachedCount} cells, ${(r.reachedFraction * 100).toFixed(1)}% of the walkable ground` +
        (r.snapped ? ` (the spawn was moved ${r.snapMetres.toFixed(1)} m onto walkable ground)` : ""));
  }
  if (e.route) {
    const r = e.route;
    out.push(r.parSeconds === null
      ? `route to (${r.objective.join(", ")}): ${r.verdict}`
      : `route to (${r.objective.join(", ")}): par ${r.parSeconds.toFixed(1)} s over ${r.distance.toFixed(0)} m, ${r.climb.toFixed(0)} m of climb, steepest ${r.maxGrade.toFixed(2)} — ${r.verdict}`);
    for (const x of r.issues) out.push(`  ${x.severity}: ${x.message}`);
  }
  out.push(e.met ? "every statement met" : "NOT every statement met");
  return out.join("\n");
}
