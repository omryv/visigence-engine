/* bin/genesis.mjs, run as a program: the files it writes, what it prints with
 * --json, and its exit status — the three things a script calling it relies
 * on. The arithmetic behind each command is held in tests/author.test.js and
 * tests/overworld.test.js; this is the terminal's half.
 *
 * The compile here is at 129² to keep the file quick (the canonical 513² one
 * is tests/overworld.test.js's). Node only: it spawns node.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validateWorldFile } from "../../../src/genesis/world/worldfile.js";
import { builderVerdict } from "../../../bin/genesis.mjs";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(ROOT, "bin", "genesis.mjs");
const EXAMPLE = join(ROOT, "schema", "examples", "K7QN.intent.json");
const dir = mkdtempSync(join(tmpdir(), "genesis-cli-"));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

try {
  const world = join(dir, "k7qn.world.json"), cert = join(dir, "k7qn.certificate.json"), level = join(dir, "level.json");
  const compiled = run("compile", EXAMPLE, "--res", "129", "--out", world, "--cert", cert, "--json");
  const verified = run("verify", world, cert, "--tier", "2");
  const explained = run("explain", world, "--spawn", "-600,-400", "--objective", "400,-200", "--json");
  const projected = run("overworld", world, "--size", "40x30", "--out", level);
  const bad = join(dir, "bad.intent.json");
  writeFileSync(bad, JSON.stringify({ kind: "visigenesis.intent", version: 2, seed: "A", statements: [{ type: "volcano" }] }));
  const refused = run("compile", bad);
  const defaults = run("compile", EXAMPLE, "--res", "65", "--seed", "QQQQ");
  const schema = run("schema");
  const usage = run("explain");

  test("compile writes a valid world and its certificate, and reports every statement met", () => {
    eq(compiled.status, 0, compiled.stderr);
    const r = JSON.parse(compiled.stdout);
    eq(r.statements.length, 4);
    ok(r.met && r.statements.every((s) => s.met));
    eq(r.files.world, world);
    eq(validateWorldFile(JSON.parse(readFileSync(world, "utf8"))).length, 0);
    eq(JSON.parse(readFileSync(cert, "utf8")).subject.sha256, r.certificate.sha256);
  });

  test("verify is genesis-verify: the compiled world verifies at tier 2", () => {
    eq(verified.status, 0, verified.stdout + verified.stderr);
    ok(verified.stdout.includes("VERIFIED"));
    ok(verified.stdout.includes("ground re-baked at 129²"));
  });

  test("explain --json: the statements met, the walk found", () => {
    eq(explained.status, 0, explained.stderr);
    const e = JSON.parse(explained.stdout);
    ok(e.met);
    ok(e.route && e.route.verdict !== "error" && e.route.parSeconds > 0);
    eq(e.ground.matchesFile, true);
  });

  test("overworld writes a level the builder accepts, at the size asked", () => {
    eq(projected.status, 0, projected.stdout + projected.stderr);
    const p = JSON.parse(readFileSync(level, "utf8"));
    eq(p.levels[0].width, 40); eq(p.levels[0].height, 30);
    const v = builderVerdict(p);
    eq(v.warnings.length, 0); ok(v.goalReachable);
  });

  test("a refused document exits 2 and names the statement; defaults name the files after the world", () => {
    eq(refused.status, 2);
    ok(refused.stderr.includes("statements[0].type"), refused.stderr);
    eq(defaults.status, 0, defaults.stderr);
    const named = defaults.stdout.match(/wrote (\S+\.world\.json) and (\S+\.certificate\.json)/);
    ok(named, defaults.stdout);
    ok(existsSync(join(dir, named[1])) && existsSync(join(dir, named[2])));
  });

  test("schema prints the schema; bad usage exits 2 with the usage", () => {
    eq(schema.status, 0);
    eq(schema.stdout, readFileSync(join(ROOT, "schema", "intent.schema.json"), "utf8"));
    eq(usage.status, 2);
    ok(usage.stderr.includes("usage:"));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

report("genesis-cli");
