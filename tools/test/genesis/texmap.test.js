/* The fence-post correction, asserted as arithmetic and as a contract.
 *
 * Every baked field samples the plate corner to corner (cell i at
 * -size/2 + i·size/(res-1)); a texture's cell i is centred at (i+0.5)/res.
 * terrain/texmap.js owns the two numbers that reconcile them. This suite
 * asks the two questions that matter:
 *
 *   1. does the mapping put every grid node EXACTLY on its texel centre —
 *      for both grids this engine bakes at, and at the edges, where a bare
 *      `w/size + 0.5` was wrong by half a cell;
 *   2. does every shader that samples a fence-post grid actually use it —
 *      read as TEXT, like chunks.test.js, because a fourth uncorrected
 *      mapping is exactly the kind of thing that rots silently.
 */
import { test, ok, eq, close, report } from "../kernel/harness.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gridTexMapping, worldTexScale } from "../../../src/genesis/terrain/texmap.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const code = (p) => readFileSync(join(ROOT, p), "utf8");

test("every grid node lands exactly on its texel centre", () => {
  for (const res of [257, 513]) {
    const size = 4096;
    const { k, b } = gridTexMapping(res);
    for (const i of [0, 1, (res - 1) / 2, res - 2, res - 1]) {
      const w = -size / 2 + (i * size) / (res - 1);
      const uv = (w / size + 0.5) * k + b;
      close(uv, (i + 0.5) / res, 1e-12, `res ${res}, node ${i}:`);
    }
  }
});

test("the folded form is the same mapping — 0.5·k + b is exactly 0.5", () => {
  // Shaders written as `w * scale + 0.5` need only the scale corrected;
  // that identity is what makes the one-uniform fix in atmosphere.js and
  // Water.js the SAME correction setControlMap applies with two.
  for (const res of [257, 513]) {
    const { k, b } = gridTexMapping(res);
    close(0.5 * k + b, 0.5, 1e-12, `res ${res}:`);
    const size = 4096;
    for (const i of [0, 200, res - 1]) {
      const w = -size / 2 + (i * size) / (res - 1);
      close(w * worldTexScale(res, size) + 0.5, (i + 0.5) / res, 1e-12,
        `res ${res}, node ${i} through worldTexScale:`);
    }
  }
});

test("an uncorrected mapping is off by half a cell at the edge — the bug this repairs", () => {
  const res = 257, size = 4096;
  const w = -size / 2;                       // the first grid node
  const naive = w / size + 0.5;              // 0 — the texture's outer EDGE
  const right = (w / size + 0.5) * gridTexMapping(res).k + gridTexMapping(res).b;
  close(right - naive, 0.5 / res, 1e-12, "the correction at the plate edge:");
  // Half a texel over 4096 m on a 257² grid is ~8 m of misregistration.
  close((right - naive) * size, size / (2 * res), 1e-9);
  ok((right - naive) * size > 7.9, "the shift this guards against is metres, not noise");
});

test("every consumer of a fence-post grid takes its numbers from texmap.js", () => {
  // The three shaders that sample world-XZ-mapped bakes. Each must import
  // the helper and must not have grown back a bare, uncorrected mapping.
  for (const [file, marker] of [
    ["src/genesis/terrain/QuadtreeTerrain.js", "gridTexMapping"],
    ["src/genesis/render/atmosphere.js", "worldTexScale"],
    ["src/genesis/water/Water.js", "gridTexMapping"],
  ]) {
    const src = code(file);
    ok(src.includes(`from "${file.includes("/terrain/") ? "./" : "../terrain/"}texmap.js"`),
      `${file} no longer imports terrain/texmap.js`);
    ok(src.includes(marker), `${file} stopped using the shared mapping`);
  }
  // The uncorrected forms, by name. A new `uv = w/size + 0.5` in any of the
  // three would reintroduce the half-texel shift under a fresh variable name.
  ok(!/vWorld\.xz\s*\/\s*uWorldSize\s*\+\s*0\.5/.test(code("src/genesis/water/Water.js")),
    "Water.js sampled the depth field with the uncorrected mapping again");
  ok(!/uSkyVisScale\.value\s*=\s*1\s*\/\s*size/.test(code("src/genesis/render/atmosphere.js")),
    "atmosphere.js set the sky-vis scale without the fence-post correction again");
});

report("texmap");
