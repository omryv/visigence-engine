/* controller-json.mjs — publish the player body as a file.
 *
 *   node tools/kernel/controller-json.mjs           (re)write tools/test/kernel/vectors/controller.json
 *   node tools/kernel/controller-json.mjs --check   exit 1 if the committed file differs
 *
 * src/kernel/core/controller.js is the one body every reach and par question in
 * this repository is asked about. A sibling repository — 3dgen's nav bake,
 * a Python pipeline, a level validator in another language — should not have
 * to import JavaScript to learn how steep a hillside that body climbs, so the
 * record is written out as JSON and committed beside the seed vectors, and
 * tools/test/kernel/controller.test.js fails when the file and the module disagree.
 *
 * Schema-stable by construction: the same fields as CONTROLLER plus
 * `kind: "visigenesis.controller"` (so a file picked up out of context says
 * what it is), every object's keys sorted, two-space indent, one trailing
 * newline, no clock. Running it twice writes the same bytes. A change to a
 * field's meaning is a change to CONTROLLER.version, not a silent edit.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLLER, controllerData } from "../../src/kernel/core/controller.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "tools/test/kernel/vectors/controller.json");

export const CONTROLLER_KIND = "visigenesis.controller";

export function buildController(c = CONTROLLER) {
  return controllerData({ ...c, kind: CONTROLLER_KIND });
}

export const render = (v) => JSON.stringify(v, null, 2) + "\n";

if (typeof process !== "undefined" && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(buildController());
  if (process.argv.includes("--check")) {
    let have = "";
    try { have = readFileSync(OUT, "utf8"); } catch { /* missing is stale */ }
    if (have !== text) {
      console.error("tools/test/kernel/vectors/controller.json is stale — run node tools/kernel/controller-json.mjs");
      process.exit(1);
    }
    console.log("tools/test/kernel/vectors/controller.json is current");
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
