/* The grid numbers may not be respelled.
 *
 * 513 is CANONICAL_RES (terrain/canonical.js) and 257 is SKYVIS_RES or
 * QUICK_FIELD_RES depending on which placeholder is meant — and each has ONE
 * home. A bare literal beside a bakeHeightField call is how the water field
 * ended up at half resolution after the first sculpt stroke: the number was
 * respelled at five call sites and one of them drifted. Read as TEXT with
 * comments stripped, boundary.test.js-style, because this cannot be asked by
 * running anything.
 *
 * The allowlist is every file that legitimately SAYS a resolution: the two
 * definition sites, sculpt.js's own documented grid and the level spec's
 * named bake field. A decimal (0.513) is not a grid. The scan covers the
 * whole engine (src/, the kernel inside it, and editor/).
 */
import { test, ok, report } from "./harness.js";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const ALLOWED = new Set([
  "src/kernel/terrain/canonical.js",   // CANONICAL_RES = 513, the definition
  "src/kernel/terrain/skyvis.js",      // SKYVIS_RES = 257, the definition
  "src/kernel/terrain/sculpt.js",      // its own 257² offset grid, documented there
  "src/world/buildSpec.js",            // a game level's bake (heightRes), a named field of the level spec
]);

// The same stripper idea as boundary.test.js: comments go, strings stay.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const walk = (d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!/vendor/.test(p)) walk(p, out); }
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
};

test("no code respells 513 or 257 outside the files that define them", () => {
  const offenders = [];
  for (const dir of ["src", "editor"]) {
    for (const f of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, f);
      if (ALLOWED.has(rel)) continue;
      const codeOnly = strip(readFileSync(f, "utf8"));
      codeOnly.split("\n").forEach((line, i) => {
        if (/(?<![\d.])\b(513|257)\b(?!\.\d)/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  ok(offenders.length === 0,
    "grid resolutions respelled as literals — import CANONICAL_RES / SKYVIS_RES instead:\n  "
    + offenders.join("\n  "));
});

test("the allowlist names only files that exist", () => {
  for (const rel of ALLOWED) {
    ok(readFileSync(join(ROOT, rel), "utf8").length > 0, `${rel} is gone — prune the allowlist`);
  }
});

report("resolution");
