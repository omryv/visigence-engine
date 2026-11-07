/* The intent document is the shape schema/intent.schema.json says it is, and
 * the schema, js/author.js and engine/terrain/condition.js agree about it.
 *
 * Three readers of one vocabulary, and the failure this file exists to catch
 * is the quiet one: a statement the schema calls valid that the solver drops,
 * a field the solver needs that the schema calls optional, a bound the schema
 * states that the solver does not hold (or the other way round). So besides
 * good and bad documents it PROBES condition.js: for every statement type,
 * a minimal statement built from the schema's own required fields must be
 * one intentErrors accepts and normalizeIntent keeps; removing any one of
 * those fields must make condition.js object to it (an error or a dropped
 * record); removing any optional field must not. And each bound the schema
 * states is checked against condition.js on both sides of the edge.
 *
 * The validator is the smallest one that holds this schema, as in
 * tests/ground-schema.test.js, and like that one it refuses any keyword it
 * does not implement, so the schema cannot grow a constraint this file
 * silently skips. Needs node:fs, so tests/run.sh runs it under Node.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { readFileSync } from "node:fs";
import {
  INTENT_TYPES, INTENT_OPS, INTENT_VERSION, MAX_INTENT, MAX_POLYLINE, GRADIENT_STEP, intentErrors, normalizeIntent,
} from "../../../src/kernel/terrain/condition.js";
import {
  intentDocumentErrors, STATEMENT_FIELDS, INTENT_KIND, MIN_RADIUS, MIN_SHORE_OFFSET, MAX_RAY_SAMPLES, MAX_TITLE,
} from "../../../src/genesis/world/author.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../../schema/intent.schema.json", import.meta.url), "utf8"));
const EXAMPLE = JSON.parse(readFileSync(new URL("../../../schema/examples/K7QN.intent.json", import.meta.url), "utf8"));
const D = SCHEMA.$defs;

// ── the validator ───────────────────────────────────────────────────────────

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$comment", "$defs"]);
const TYPES = {
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolve(ref, root) {
  const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (!m || !root.$defs?.[m[1]]) throw new Error(`unsupported $ref ${ref}`);
  return root.$defs[m[1]];
}

function validate(schema, v, root = SCHEMA, path = "$") {
  const errs = [];
  for (const k of Object.keys(schema)) {
    if (ANNOTATIONS.has(k)) continue;
    const s = schema[k];
    switch (k) {
      case "$ref": errs.push(...validate(resolve(s, root), v, root, path)); break;
      case "type": {
        const ts = Array.isArray(s) ? s : [s];
        for (const t of ts) if (!TYPES[t]) throw new Error(`unknown type ${t}`);
        if (!ts.some((t) => TYPES[t](v))) errs.push(`${path}: not ${ts.join("|")}`);
        break;
      }
      case "const": if (!same(v, s)) errs.push(`${path}: not ${JSON.stringify(s)}`); break;
      case "enum": if (!s.some((e) => same(v, e))) errs.push(`${path}: not one of ${JSON.stringify(s)}`); break;
      case "minimum": if (typeof v === "number" && v < s) errs.push(`${path}: < ${s}`); break;
      case "maximum": if (typeof v === "number" && v > s) errs.push(`${path}: > ${s}`); break;
      case "minLength": if (typeof v === "string" && v.length < s) errs.push(`${path}: shorter than ${s}`); break;
      case "maxLength": if (typeof v === "string" && v.length > s) errs.push(`${path}: longer than ${s}`); break;
      case "pattern": if (typeof v === "string" && !new RegExp(s, "u").test(v)) errs.push(`${path}: does not match ${s}`); break;
      case "minItems": if (Array.isArray(v) && v.length < s) errs.push(`${path}: fewer than ${s} items`); break;
      case "maxItems": if (Array.isArray(v) && v.length > s) errs.push(`${path}: more than ${s} items`); break;
      case "required":
        if (TYPES.object(v)) for (const r of s) if (!(r in v)) errs.push(`${path}: missing ${r}`);
        break;
      case "dependentRequired":
        if (TYPES.object(v)) for (const [p, needs] of Object.entries(s)) if (p in v) for (const r of needs) if (!(r in v)) errs.push(`${path}: ${p} needs ${r}`);
        break;
      case "properties":
        if (TYPES.object(v)) for (const [p, ps] of Object.entries(s)) if (p in v) errs.push(...validate(ps, v[p], root, `${path}.${p}`));
        break;
      case "additionalProperties":
        if (TYPES.object(v)) {
          for (const p of Object.keys(v)) {
            if (schema.properties && p in schema.properties) continue;
            if (s === false) errs.push(`${path}: unexpected ${p}`);
            else errs.push(...validate(s, v[p], root, `${path}.${p}`));
          }
        }
        break;
      case "items":
        if (Array.isArray(v)) v.forEach((x, i) => errs.push(...validate(s, x, root, `${path}[${i}]`)));
        break;
      case "oneOf": {
        const n = s.filter((sub) => validate(sub, v, root, path).length === 0).length;
        if (n !== 1) errs.push(`${path}: matches ${n} of oneOf, not exactly one`);
        break;
      }
      default:
        throw new Error(`the test's validator does not implement "${k}" — teach it, or drop it from the schema`);
    }
  }
  return errs;
}
const valid = (doc) => validate(SCHEMA, doc).length === 0;

// ── the schema's statement types, read off the schema ───────────────────────

const typeDefs = D.statement.oneOf.map((r) => resolve(r.$ref, SCHEMA));
const byType = Object.fromEntries(typeDefs.map((d) => [d.properties.type.const, d]));

/* A minimal statement of each type: its schema-required fields with values a
   4096 m world can hold, and every optional field it can carry. */
const MINIMAL = {
  point: { type: "point", x: 100, z: -200, h: 120 },
  summit: { type: "summit", x: 300, z: 300, h: 200 },
  flat: { type: "flat", x: -300, z: 100, r: 80 },
  level: { type: "level", h: 40 },
  shoreline: { type: "shoreline", points: [[-900, 600], [-500, 700]] },
  ray: { type: "ray", eye: [0, 150, 0], at: [600, 0] },
  corridor: { type: "corridor", points: [[0, 0], [400, 100]] },
  pad: { type: "pad", x: 500, z: -500, r: 64, h: 90 },
};
const OPTIONAL = {
  point: { op: ">=" }, summit: {}, flat: { h: 60 }, level: { op: "<=", inset: 0.5 },
  shoreline: { side: "left", offset: 30, level: 0 }, ray: { h: 140, contact: true, samples: 16 },
  corridor: { maxGrade: 0.1 }, pad: {},
};
const docOf = (statements, extra = {}) => ({ kind: "visigenesis.intent", version: 2, seed: "SCHEMA-TEST", statements, ...extra });
const condOk = (rec) => intentErrors([rec], { size: 4096 }).length === 0 && normalizeIntent([rec])?.length === 1;

// ── tests ───────────────────────────────────────────────────────────────────

test("the schema is a 2020-12 schema this validator can read in full", () => {
  eq(SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  eq(SCHEMA.properties.kind.const, INTENT_KIND);
  ok(valid(EXAMPLE), validate(SCHEMA, EXAMPLE).join("; ")); // throws on any unknown keyword
});

test("the version is condition.js's vocabulary version, and the types are its types", () => {
  eq(SCHEMA.properties.version.const, INTENT_VERSION);
  eq(JSON.stringify(Object.keys(byType).sort()), JSON.stringify([...INTENT_TYPES].sort()));
  eq(JSON.stringify(D.op.enum), JSON.stringify(INTENT_OPS));
});

test("every statement type's fields are the fields js/author.js allows", () => {
  for (const t of INTENT_TYPES) {
    const fields = Object.keys(byType[t].properties).filter((k) => k !== "type").sort();
    eq(JSON.stringify(fields), JSON.stringify([...STATEMENT_FIELDS[t]].sort()), `${t}:`);
    eq(byType[t].additionalProperties, false, `${t} additionalProperties`);
    ok(byType[t].required.includes("type"), `${t} requires type`);
  }
});

test("a minimal statement of each type is valid to the schema, to author.js and to condition.js", () => {
  for (const t of INTENT_TYPES) {
    const m = MINIMAL[t], full = { ...m, ...OPTIONAL[t] };
    for (const rec of [m, full]) {
      ok(valid(docOf([rec])), `${t}: schema refused ${JSON.stringify(rec)}: ${validate(SCHEMA, docOf([rec])).join("; ")}`);
      eq(intentDocumentErrors(docOf([rec])).length, 0, `${t}: author.js refused ${JSON.stringify(rec)}: ${intentDocumentErrors(docOf([rec])).join("; ")}`);
      ok(condOk(rec), `${t}: condition.js refused ${JSON.stringify(rec)}`);
    }
  }
});

test("a field the schema requires is one condition.js cannot do without; an optional one it can", () => {
  for (const t of INTENT_TYPES) {
    const full = { ...MINIMAL[t], ...OPTIONAL[t] };
    for (const k of byType[t].required.filter((k) => k !== "type")) {
      const { [k]: _, ...less } = full;
      ok(!valid(docOf([less])), `${t} without ${k}: the schema accepted it`);
      ok(!condOk(less), `${t} without ${k}: condition.js accepted it, so the schema should not require it`);
      ok(intentDocumentErrors(docOf([less])).length > 0, `${t} without ${k}: author.js accepted it`);
    }
    for (const k of Object.keys(OPTIONAL[t])) {
      // A field that needs this one (dependentRequired: a shoreline's offset
      // needs its side) goes with it.
      const deps = Object.entries(byType[t].dependentRequired || {}).filter(([, needs]) => needs.includes(k)).map(([p]) => p);
      const less = Object.fromEntries(Object.entries(full).filter(([f]) => f !== k && !deps.includes(f)));
      ok(valid(docOf([less])), `${t} without optional ${k}: the schema refused it`);
      ok(condOk(less), `${t} without optional ${k}: condition.js refused it, so the schema should require it`);
    }
  }
});

test("the schema's bounds are condition.js's, on both sides of each edge", () => {
  eq(SCHEMA.properties.statements.maxItems, MAX_INTENT);
  eq(D.polyline.maxItems, MAX_POLYLINE);
  eq(D.pad.properties.r.minimum, 2 * GRADIENT_STEP);
  eq(D.flat.properties.r.minimum, MIN_RADIUS);
  eq(D.shoreline.properties.offset.minimum, MIN_SHORE_OFFSET);
  eq(D.ray.properties.samples.maximum, MAX_RAY_SAMPLES);
  eq(SCHEMA.properties.title.maxLength, MAX_TITLE);
  // Each edge as condition.js holds it: the bound passes, one step past it fails.
  const at = (rec) => intentErrors([rec], { size: 4096 }).length === 0;
  ok(at({ ...MINIMAL.pad, r: 48 }) && !at({ ...MINIMAL.pad, r: 47.9 }), "pad r");
  ok(at({ ...MINIMAL.shoreline, side: "left", offset: 12 }) && !at({ ...MINIMAL.shoreline, side: "left", offset: 11.9 }), "shoreline offset");
  ok(at({ ...MINIMAL.ray, samples: 64 }) && !at({ ...MINIMAL.ray, samples: 65 }) && at({ ...MINIMAL.ray, samples: 2 }) && !at({ ...MINIMAL.ray, samples: 1 }), "ray samples");
  ok(at({ ...MINIMAL.corridor, maxGrade: 0 }) && !at({ ...MINIMAL.corridor, maxGrade: -0.01 }), "corridor maxGrade");
  const line = (n) => Array.from({ length: n }, (_, i) => [i * 10, 0]);
  ok(at({ type: "corridor", points: line(64) }) && !at({ type: "corridor", points: line(65) }), "polyline length");
  ok(!at({ type: "shoreline", points: [[0, 0], [10, 0]], offset: 30 }), "offset without a side");
  /* The two v1 clamps condition.js applies silently (a flat's radius, a
     level's inset) are refused by author.js, at the same edges the schema
     states. */
  const doc = (rec) => intentDocumentErrors(docOf([rec])).length === 0;
  ok(doc({ ...MINIMAL.flat, r: 48 }) && !doc({ ...MINIMAL.flat, r: 47.9 }), "flat r");
  eq(D.level.properties.inset.minimum, 0.05); eq(D.level.properties.inset.maximum, 1);
  ok(doc({ type: "level", h: 0, inset: 0.05 }) && doc({ type: "level", h: 0, inset: 1 }) && !doc({ type: "level", h: 0, inset: 1.01 }) && !doc({ type: "level", h: 0, inset: 0.04 }), "level inset");
});

test("a document names no world: the schema has no such field and author.js refuses one", () => {
  eq(SCHEMA.properties.world, undefined);
  const d = docOf([MINIMAL.point], { world: "farshore" });
  ok(!valid(d), "the schema accepted a named world");
  ok(intentDocumentErrors(d).some((e) => e.startsWith("world is not a field")), "author.js accepted a named world");
});

test("good documents: the schema and author.js both accept them", () => {
  const all = INTENT_TYPES.map((t) => ({ ...MINIMAL[t], ...OPTIONAL[t] }));
  for (const d of [
    EXAMPLE,
    docOf([]),
    docOf(all),
    docOf([MINIMAL.point], { title: "a harbour" }),
    docOf([MINIMAL.level], { $schema: "https://example.invalid/intent.schema.json" }),
    { kind: "visigenesis.intent", version: 2, statements: [MINIMAL.point], seed: "k7qn" },
  ]) {
    ok(valid(d), `schema: ${validate(SCHEMA, d).join("; ")}`);
    eq(intentDocumentErrors(d).length, 0, `author.js: ${intentDocumentErrors(d).join("; ")}`);
  }
});

test("bad documents: the schema and author.js both refuse them", () => {
  const p = MINIMAL.point;
  for (const [what, d] of [
    ["another kind", { ...docOf([p]), kind: "visigenesis.world" }],
    ["version 1", { ...docOf([p]), version: 1 }],
    ["no statements", { kind: "visigenesis.intent", version: 2, seed: "A" }],
    ["statements not a list", docOf({ 0: p })],
    ["an unknown top-level field", docOf([p], { brief: "a town by the sea" })],
    ["an unknown world", docOf([p], { world: "crownway" })],
    ["a seed with no letter or digit", docOf([p], { seed: "---" })],
    ["an empty seed", docOf([p], { seed: "" })],
    ["a title too long", docOf([p], { title: "x".repeat(49) })],
    ["an unknown statement type", docOf([{ type: "volcano", x: 0, z: 0, h: 900 }])],
    ["a typo in a field", docOf([{ type: "summit", x: 0, z: 0, hieght: 200 }])],
    ["an extra field on a statement", docOf([{ ...p, note: "here" }])],
    ["a string height", docOf([{ ...p, h: "120" }])],
    ["an unknown op", docOf([{ ...p, op: ">" }])],
    ["a pad under 48 m", docOf([{ ...MINIMAL.pad, r: 30 }])],
    ["a flat under 48 m", docOf([{ ...MINIMAL.flat, r: 30 }])],
    ["a level inset past 1", docOf([{ type: "level", h: 10, inset: 1.5 }])],
    ["a one-point shoreline", docOf([{ type: "shoreline", points: [[0, 0]] }])],
    ["a shoreline vertex of three numbers", docOf([{ type: "shoreline", points: [[0, 0], [1, 2, 3]] }])],
    ["a side that is not left or right", docOf([{ ...MINIMAL.shoreline, side: "up" }])],
    ["an offset with no side", docOf([{ ...MINIMAL.shoreline, offset: 30 }])],
    ["an offset under 12 m", docOf([{ ...MINIMAL.shoreline, side: "right", offset: 5 }])],
    ["a ray with a two-number eye", docOf([{ ...MINIMAL.ray, eye: [0, 100] }])],
    ["a ray of 65 samples", docOf([{ ...MINIMAL.ray, samples: 65 }])],
    ["a ray of 2.5 samples", docOf([{ ...MINIMAL.ray, samples: 2.5 }])],
    ["contact as a string", docOf([{ ...MINIMAL.ray, h: 10, contact: "yes" }])],
    ["a negative grade", docOf([{ ...MINIMAL.corridor, maxGrade: -0.1 }])],
    ["49 statements", docOf(Array.from({ length: 49 }, (_, i) => ({ type: "point", x: i * 10, z: 0, h: 50 })))],
  ]) {
    ok(!valid(d), `the schema accepted ${what}`);
    ok(intentDocumentErrors(d).length > 0, `author.js accepted ${what}`);
  }
});

test("what the schema cannot state, author.js still refuses — and names in the document's own terms", () => {
  for (const [what, d, says] of [
    ["a point off a 4096 m plate", docOf([{ type: "shoreline", points: [[0, 0], [2100, 0]] }]), "statements[0].points[1]"],
    ["a pad whose ring leaves the 4096 m plate", docOf([{ type: "pad", x: 1950, z: 0, r: 200, h: 5 }]), "statements[0]"],
    ["a shoreline that turns straight back", docOf([{ type: "shoreline", points: [[0, 0], [400, 0], [100, 0]], side: "left" }]), "turns straight back"],
    ["no seed anywhere", { kind: "visigenesis.intent", version: 2, statements: [] }, "no seed"],
  ]) {
    ok(valid(d), `${what}: the schema refused it, so this row is in the wrong table`);
    const errs = intentDocumentErrors(d);
    ok(errs.some((e) => e.includes(says)), `${what}: expected an error naming "${says}", got ${JSON.stringify(errs)}`);
    ok(errs.every((e) => !e.includes("terrain.intent[")), `${what}: an error spoke in a file's terms: ${JSON.stringify(errs)}`);
  }
  // …and the seed can come from the caller instead.
  eq(intentDocumentErrors({ kind: "visigenesis.intent", version: 2, statements: [] }, { seed: "K7QN" }).length, 0);
});

report("intent-schema");
