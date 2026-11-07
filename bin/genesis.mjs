#!/usr/bin/env node
/* genesis — the author interface, from a terminal.
 *
 * A world is asked for in statements (schema/intent.schema.json), compiled
 * by the pipeline every world already goes through, explained back statement
 * by statement, verified, and — the same ground, read top-down — projected
 * onto the 2D builder's adventure genre. Everything here is js/author.js and
 * js/overworld.js; this file is argument parsing and files.
 *
 *   genesis compile <intent.json> [--seed S] [--out world.json] [--cert certificate.json] [--res N] [--json]
 *   genesis explain <world.json> [--spawn x,z] [--objective x,z] [--res N] [--json]
 *   genesis verify <world.json> <certificate.json> [--tier 1|2]
 *   genesis overworld <world.json> [--size 48x32] --out level.json [--json]
 *   genesis schema
 *
 * compile writes the world file (default: its own name, js/worldfile.js
 * worldFileName, in the current directory) and the certificate (default: the
 * world file's name with .certificate.json), and prints what every statement
 * cost and missed. `--res` bakes the ground at another grid than the
 * canonical 513 — a different world's ground hashes, recorded as such in the
 * file and the certificate, and the quick way to try a document.
 *
 * explain re-solves a world file's statements and reads them back: met or
 * missed, the nats, the freedom map's summary (engine/terrain/sigma.js), and
 * with --spawn and/or --objective the reach and the par of the walk
 * (engine/core/terrain-reach.js; the file's own spawn stands in for a
 * missing --spawn).
 *
 * verify is bin/genesis-verify.mjs, run as it is: the same arguments, the
 * same output, the same exit status.
 *
 * overworld writes a visigame.builder v1 project (apps/builder2d) and then
 * holds it to the builder's own two doors before saying it is done: it must
 * load through normalizeProject with no warning, and analyzeLevel must find
 * the goal reachable from the start. A level that fails either is still
 * written, so it can be looked at, and the exit status says it failed.
 *
 * Exit status: 0 done (and, for compile and explain, every statement met;
 * for explain with an objective, the route found), 1 done but not that, 2
 * nothing could be done (unreadable input, a refused document, bad usage).
 */

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { compileIntent, explainWorld, formatCompileReport, formatExplanation } from "../src/genesis/world/author.js";
import { projectOverworld, serializeOverworld, OVERWORLD_SIZE } from "../src/genesis/world/overworld.js";
import { serializeWorldFile, worldFileName } from "../src/genesis/world/worldfile.js";
import { normalizeProject } from "../src/play2d/core/format.js";
import { analyzeLevel } from "../src/play2d/core/analyze.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, "..", "schema", "intent.schema.json");

const USAGE = `usage:
  genesis compile <intent.json> [--seed S] [--out world.json] [--cert certificate.json] [--res N] [--json]
  genesis explain <world.json> [--spawn x,z] [--objective x,z] [--res N] [--json]
  genesis verify <world.json> <certificate.json> [--tier 1|2]
  genesis overworld <world.json> [--size 48x32] --out level.json [--json]
  genesis schema`;

class Usage extends Error {}

/* --flag value, --flag=value and bare --switch, against a table of which
   flags take a value. Anything else is a usage error, not a guess. */
function parse(argv, valued, switches = []) {
  const files = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { files.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (switches.includes(k)) { opts[k] = true; continue; }
    if (!valued.includes(k)) throw new Usage(`unknown option --${k}`);
    const v = inline ?? argv[++i];
    if (v === undefined) throw new Usage(`--${k} needs a value`);
    opts[k] = v;
  }
  return { files, opts };
}

const pair = (s, what) => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(s));
  if (!m) throw new Usage(`--${what} must be x,z in metres, got ${JSON.stringify(s)}`);
  return [Number(m[1]), Number(m[2])];
};
const int = (s, what) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Usage(`--${what} must be a whole number, got ${JSON.stringify(s)}`);
  return n;
};

async function readJSON(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch (e) { throw new Usage(`could not read ${path}: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Usage(`${path} is not JSON: ${e.message}`); }
}

async function compile(argv) {
  const { files, opts } = parse(argv, ["seed", "out", "cert", "res"], ["json"]);
  if (files.length !== 1) throw new Usage("compile takes one intent document");
  const doc = await readJSON(files[0]);
  let made;
  try {
    made = await compileIntent(doc, { seed: opts.seed ?? null, res: opts.res === undefined ? undefined : int(opts.res, "res") });
  } catch (e) {
    if (e instanceof TypeError || e instanceof RangeError) {
      console.error(`${files[0]}: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const out = opts.out || worldFileName(made.world);
  const cert = opts.cert || join(dirname(out), basename(out).replace(/\.world\.json$|\.json$/, "") + ".certificate.json");
  await writeFile(out, serializeWorldFile(made.world));
  await writeFile(cert, JSON.stringify(made.certificate, null, 2) + "\n");
  if (opts.json) console.log(JSON.stringify({ ...made.report, files: { world: out, certificate: cert } }, null, 2));
  else console.log(`${formatCompileReport(made.report)}\nwrote ${out} and ${cert}`);
  return made.report.met ? 0 : 1;
}

async function explain(argv) {
  const { files, opts } = parse(argv, ["spawn", "objective", "res"], ["json"]);
  if (files.length !== 1) throw new Usage("explain takes one world file");
  const doc = await readJSON(files[0]);
  let e;
  try {
    e = explainWorld(doc, {
      spawn: opts.spawn ? pair(opts.spawn, "spawn") : null,
      objective: opts.objective ? pair(opts.objective, "objective") : null,
      res: opts.res === undefined ? null : int(opts.res, "res"),
    });
  } catch (err) {
    if (err instanceof TypeError || err instanceof RangeError) { console.error(`${files[0]}: ${err.message}`); return 2; }
    throw err;
  }
  console.log(opts.json ? JSON.stringify(e, null, 2) : formatExplanation(e));
  return e.met && (!e.route || e.route.verdict !== "error") ? 0 : 1;
}

/* The same program, run as itself: its arguments, its output, its status. */
function verify(argv) {
  const r = spawnSync(process.execPath, [join(HERE, "genesis-verify.mjs"), ...argv], { stdio: "inherit" });
  return r.status ?? 2;
}

/**
 * The builder's own verdict on a projected level: the warnings
 * normalizeProject collected and whether analyzeLevel found the goal. The
 * CLI's gate and the tests' (tests/genesis-cli.test.js,
 * apps/builder2d/tools/test/test-builder-overworld.mjs) are this function
 * or the same two calls.
 */
export function builderVerdict(projectDoc) {
  const warnings = [];
  const project = normalizeProject(JSON.parse(JSON.stringify(projectDoc)), warnings);
  const a = analyzeLevel(project, 0);
  const goalReachable = !a.issues.some((x) => x.id === "goal-unreachable" || x.id === "no-goal" || x.id === "no-player");
  return { warnings, goalReachable, errors: a.issues.filter((x) => x.severity === "error").map((x) => x.id), route: a.stats.route };
}

async function overworld(argv) {
  const { files, opts } = parse(argv, ["size", "out", "res"], ["json"]);
  if (files.length !== 1) throw new Usage("overworld takes one world file");
  if (!opts.out) throw new Usage("overworld needs --out level.json");
  let width = OVERWORLD_SIZE.width, height = OVERWORLD_SIZE.height;
  if (opts.size) {
    const m = /^(\d+)x(\d+)$/.exec(opts.size);
    if (!m) throw new Usage(`--size must be WIDTHxHEIGHT in tiles, got ${JSON.stringify(opts.size)}`);
    width = Number(m[1]); height = Number(m[2]);
  }
  const doc = await readJSON(files[0]);
  let made;
  try {
    made = projectOverworld(doc, { width, height, res: opts.res === undefined ? null : int(opts.res, "res") });
  } catch (e) {
    console.error(`${files[0]}: ${e.message}`);
    return 2;
  }
  await writeFile(opts.out, serializeOverworld(made.project));
  const v = builderVerdict(made.project);
  const ok = !v.warnings.length && v.goalReachable && !v.errors.length;
  if (opts.json) console.log(JSON.stringify({ ...made.report, builder: v, file: opts.out }, null, 2));
  else {
    const r = made.report;
    console.log(`overworld ${r.width}×${r.height} of world ${r.seed}, ${r.tileMetres.toFixed(1)} m a tile: ` +
      `${r.counts.path} path, ${r.counts.tallgrass} tall grass, ${r.counts.pond} pond, ${r.counts.wall} wall`);
    console.log(`start (${r.start.x}, ${r.start.y}) and goal (${r.goal.x}, ${r.goal.y}) on the largest region ` +
      `(${(r.region.share * 100).toFixed(1)}% of the walkable ground), ${r.steps2d} steps apart on the level; ` +
      `the 3D route is ${r.route.distance.toFixed(0)} m, par ${r.route.parSeconds.toFixed(1)} s`);
    console.log(ok
      ? `the builder loads it with no warning and finds the goal reachable — wrote ${opts.out}`
      : `the builder does NOT accept it: ${[...v.warnings, ...v.errors, v.goalReachable ? null : "goal unreachable"].filter(Boolean).join("; ")} — wrote ${opts.out} anyway`);
  }
  return ok ? 0 : 1;
}

async function schema() {
  process.stdout.write(await readFile(SCHEMA_PATH, "utf8"));
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const commands = { compile, explain, verify, overworld, schema };
  if (!commands[cmd]) { console.error(cmd ? `unknown command ${cmd}\n${USAGE}` : USAGE); return 2; }
  try {
    return await commands[cmd](rest);
  } catch (e) {
    if (e instanceof Usage) { console.error(`${e.message}\n${USAGE}`); return 2; }
    console.error(`genesis ${cmd}: ${e?.stack ?? e}`);
    return 2;
  }
}

/* Run only as a program: tests import builderVerdict from here. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
