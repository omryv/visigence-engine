/* The kernel's boundary, asserted.
 *
 * src/kernel/ is the Genesis Kernel: deterministic, renderer-free, and consumable by anything. tools/check-imports.mjs
 * holds its import graph (nothing bare, nothing outside src/kernel/). This holds the rest of that sentence, which no
 * import graph can see: no DOM, no storage, no canvas, no network, no ambient globals, no randomness of its own, and a
 * manifest (CORE_MODULES) that is the kernel, every file of it and nothing else.
 *
 * Ported from the retired repository's tools/test/kernel/boundary.test.js; its game-tree checks went with the tree they guarded.
 * Read as TEXT with comments stripped (tools/lib/modules.mjs stripSource, a lexer: strings stay, because an import
 * specifier is a string), since none of this can be asked by running anything.
 */
import { test, ok, report } from "./harness.js";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, KERNEL, jsFiles, moduleSpecifiers, resolveRelative, inKernel, stripSource } from "../../lib/modules.mjs";

// The manifest, READ rather than imported: a core module that gained a `three` import must fail this suite on the
// boundary, not on "cannot find package 'three'" before the boundary check ever runs.
const CORE_MODULES = (() => {
  const src = readFileSync(join(KERNEL, "core/index.js"), "utf8");
  const block = src.match(/export const CORE_MODULES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("src/kernel/core/index.js no longer declares CORE_MODULES");
  return [...stripSource(block[1]).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
})();

test("CORE_MODULES is the kernel: every file in src/kernel/, and nothing else", () => {
  const onDisk = jsFiles(KERNEL).map((f) => relative(ROOT, f)).filter((r) => r !== "src/kernel/core/index.js").sort();
  const listed = [...CORE_MODULES].sort();
  ok(JSON.stringify(onDisk) === JSON.stringify(listed),
    `the manifest and the directory disagree — on disk only: ${onDisk.filter((r) => !listed.includes(r)).join(", ") || "none"}; ` +
    `listed only: ${listed.filter((r) => !onDisk.includes(r)).join(", ") || "none"}`);
});

const SIGNALS = {
  "three.js":        /\bfrom\s*["']three|\bTHREE\./,
  "the DOM":         /\bdocument\.|\bwindow\.|matchMedia\(|navigator\.|addEventListener\(/,
  "storage":         /\b(localStorage|sessionStorage|indexedDB)\b/,
  "a canvas":        /getContext\(|createElement\(["']canvas/,
  "the network":     /\bfetch\(|XMLHttpRequest|new\s+Worker\(/,
  "ambient globals": /globalThis\./,
  "a clock":         /\bDate\.now\(|\bnew Date\(|performance\.now\(/,
};

test("the kernel needs no renderer, no browser, no network and no clock", () => {
  for (const f of jsFiles(KERNEL)) {
    const code = stripSource(readFileSync(f, "utf8"));
    for (const [what, re] of Object.entries(SIGNALS))
      ok(!re.test(code), `${relative(ROOT, f)} reaches for ${what} — it cannot be in the kernel`);
  }
});

test("the kernel reaches for no randomness of its own", () => {
  /* A generator is HANDED its stream. A default of Math.random is the worst kind of determinism bug: output is
     reproducible until somebody adds a call site that omits the argument, and then the same seed quietly produces a
     different world. randomSeed(rng = Math.random) in seed.js is the ONE legitimate case: minting a brand-new seed
     is where nondeterminism is supposed to enter. */
  for (const f of jsFiles(KERNEL)) {
    const lines = stripSource(readFileSync(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!/Math\.random/.test(line)) return;
      ok(relative(ROOT, f) === "src/kernel/seed.js" && /randomSeed/.test(line),
        `${relative(ROOT, f)}:${i + 1} reaches for Math.random — a kernel generator is handed its stream`);
    });
  }
});

test("the engine stands on the kernel: the game's world layer imports it", () => {
  // A layer nobody imports is a layer, not a boundary.
  const users = new Set();
  for (const f of jsFiles(join(ROOT, "src"))) {
    if (inKernel(f)) continue;
    for (const spec of moduleSpecifiers(readFileSync(f, "utf8")))
      if (spec.startsWith(".") && inKernel(resolveRelative(f, spec))) users.add(relative(ROOT, f));
  }
  ok(users.size > 0, "nothing in src/ outside the kernel imports it");
  ok([...users].some((u) => u.startsWith("src/world/")), `the world layer does not import the kernel (users: ${[...users].join(", ")})`);
});

test("no rng defaults to Math.random anywhere in the engine", () => {
  for (const dir of ["src", "editor"]) for (const f of jsFiles(join(ROOT, dir))) {
    const rel = relative(ROOT, f);
    if (rel === "src/kernel/seed.js") continue;
    ok(!/\brng\s*=\s*Math\.random/.test(stripSource(readFileSync(f, "utf8"))),
      `${rel} defaults an rng to Math.random — pass the seeded stream instead`);
  }
});

report("boundary");
