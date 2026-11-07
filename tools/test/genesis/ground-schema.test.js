/* The ground manifest is the shape schema/ground.schema.json says it is.
 *
 * Split from tests/ground.test.js only because the schema is a file and
 * reading it needs node:fs; ground.test.js holds every claim that does not,
 * and runs under JavaScriptCore too. tests/run.sh runs this one under Node.
 *
 * The validator is the smallest one that can hold this schema, written here
 * rather than imported because the suite takes no dependencies. It refuses
 * any keyword it does not implement, so the schema cannot grow a constraint
 * this file silently skips. The schema was also checked against the Python
 * `jsonschema` package's Draft202012Validator while it was written (a
 * meta-schema check, one valid manifest and four invalid ones); that check is
 * not part of the suite because the package is not something the suite may
 * assume.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { readFileSync } from "node:fs";
import { groundBundle, GROUND_KIND, GROUND_MANIFEST_VERSION } from "../../../src/kernel/core/index.js";
import { makeParams, mergeParams } from "../../../src/kernel/presets.js";
import { DEFAULT_WORLD } from "../../../src/genesis/world/default-world.js";
import { paramsFromWorldFile } from "../../../src/genesis/world/worldfile.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../../schema/ground.schema.json", import.meta.url), "utf8"));
const SMALL = 129;

const clock = typeof performance !== "undefined" && performance.now
  ? () => performance.now()
  : () => Date.now();

/* The default world, the manifest a consumer is most likely to be handed,
   baked once without a clock and once with one. */
const PLAIN = groundBundle(paramsFromWorldFile(DEFAULT_WORLD));
const TIMED = groundBundle(paramsFromWorldFile(DEFAULT_WORLD), { now: clock });

// ── the schema ──────────────────────────────────────────────────────────────

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

/* JSON Schema 2020-12, the subset ground.schema.json uses — and an error for
   anything outside that subset, so a keyword added to the schema is a
   keyword this validator must learn before the suite goes green again. */
function validate(schema, v, root = schema, path = "$") {
  const errs = [];
  for (const k of Object.keys(schema)) {
    if (ANNOTATIONS.has(k)) continue;
    const s = schema[k];
    switch (k) {
      case "$ref": {
        const m = /^#\/\$defs\/([^/]+)$/.exec(s);
        if (!m || !root.$defs?.[m[1]]) throw new Error(`unsupported $ref ${s}`);
        errs.push(...validate(root.$defs[m[1]], v, root, path));
        break;
      }
      case "type": {
        const ts = Array.isArray(s) ? s : [s];
        for (const t of ts) if (!TYPES[t]) throw new Error(`unknown type ${t}`);
        if (!ts.some((t) => TYPES[t](v))) errs.push(`${path}: not ${ts.join("|")}`);
        break;
      }
      case "const": if (JSON.stringify(v) !== JSON.stringify(s)) errs.push(`${path}: not ${JSON.stringify(s)}`); break;
      case "minimum": if (typeof v === "number" && v < s) errs.push(`${path}: < ${s}`); break;
      case "maximum": if (typeof v === "number" && v > s) errs.push(`${path}: > ${s}`); break;
      case "exclusiveMinimum": if (typeof v === "number" && v <= s) errs.push(`${path}: <= ${s}`); break;
      case "minLength": if (typeof v === "string" && v.length < s) errs.push(`${path}: shorter than ${s}`); break;
      case "minItems": if (Array.isArray(v) && v.length < s) errs.push(`${path}: fewer than ${s} items`); break;
      case "required":
        if (TYPES.object(v)) for (const r of s) if (!(r in v)) errs.push(`${path}: missing ${r}`);
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
      case "anyOf":
        if (!s.some((sub) => validate(sub, v, root, path).length === 0)) errs.push(`${path}: matches none of anyOf`);
        break;
      default:
        throw new Error(`the test's validator does not implement "${k}" — teach it, or drop it from the schema`);
    }
  }
  return errs;
}

test("the schema is a 2020-12 schema this validator can read in full", () => {
  eq(SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  eq(SCHEMA.properties.kind.const, GROUND_KIND);
  eq(SCHEMA.properties.version.const, GROUND_MANIFEST_VERSION);
  eq(validate(SCHEMA, PLAIN.manifest).length, 0); // throws on any unknown keyword
});

test("every manifest this file baked validates against schema/ground.schema.json", () => {
  const p = makeParams({ seed: "SCHEMA" });
  for (const m of [
    PLAIN.manifest, TIMED.manifest,
    groundBundle(p, { res: SMALL, erode: false }).manifest,
    // A world with its sea above zero, eroded off the canonical grid.
    groundBundle(mergeParams(p, { water: { level: 3.5 }, terrain: { erosion: { drops: 300 } } }), { res: 65 }).manifest,
    // Clocks that go backwards, return NaN, or fail once: the manifest must
    // still be one its own schema accepts.
    (() => { let t = 1e6; return groundBundle(p, { res: 33, now: () => (t -= 3) }).manifest; })(),
    groundBundle(p, { res: 33, now: () => NaN }).manifest,
    (() => { const ticks = [0, 4, NaN, 9, 2, 11]; let n = 0; return groundBundle(p, { res: 33, now: () => ticks[n++] }).manifest; })(),
    // The manifest as a consumer receives it: through JSON.
    JSON.parse(JSON.stringify(TIMED.manifest)),
  ]) {
    const errs = validate(SCHEMA, m);
    eq(errs.length, 0, errs.join("; "));
  }
});

test("…and the schema refuses the manifests it should", () => {
  const good = PLAIN.manifest;
  const { heightHash, ...missing } = good;
  for (const [what, bad] of [
    ["a missing hash", missing],
    ["an extra field", { ...good, eroded: true }],
    ["another kind", { ...good, kind: "visigenesis.world" }],
    ["version 2", { ...good, version: 2 }],
    ["a negative hash", { ...good, heightHash: -1 }],
    ["a hash past 32 bits", { ...good, landMaskHash: 2 ** 32 }],
    ["a fractional res", { ...good, res: 512.5 }],
    ["a zero size", { ...good, size: 0 }],
    ["a string deltaHash", { ...good, deltaHash: "abc" }],
    ["a timing as a string", { ...good, stages: [{ name: "bake", ms: "12" }] }],
    ["a negative timing", { ...good, stages: [{ name: "bake", ms: -1 }] }],
    ["an unnamed stage", { ...good, stages: [{ ms: 1 }] }],
    ["no stages", { ...good, stages: [] }],
  ]) {
    ok(validate(SCHEMA, bad).length > 0, `the schema accepted ${what}`);
  }
});


report("ground-schema");
