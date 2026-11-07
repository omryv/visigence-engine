// The player body is one record, and the file siblings read is that record.
//
// src/kernel/core/controller.js is cited line by line in its header. This holds
// those citations to account: the step, head and radius are the ones reach.js
// walks buildings with, and vectors/controller.json is byte for byte what
// tools/kernel/controller-json.mjs writes from the module today. Reads files,
// so Node only, like seed-vectors.test.js.
import { test, eq, ok, close, report } from "./harness.js";
import { readFileSync } from "node:fs";
import { CONTROLLER, CONTROLLER_VERSION, controllerData } from "../../../src/kernel/core/controller.js";
import { STEP_UP, HEAD, RADIUS } from "../../../src/kernel/core/reach.js";
import { CONTROLLER as FROM_INDEX } from "../../../src/kernel/core/index.js";
import { buildController, render, CONTROLLER_KIND } from "../../kernel/controller-json.mjs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the record is the numbers the task names", () => {
  eq(CONTROLLER.version, 1);
  eq(CONTROLLER_VERSION, 1);
  eq(CONTROLLER.walk, 6); eq(CONTROLLER.run, 14);
  eq(CONTROLLER.swim, 3.5); eq(CONTROLLER.swimRun, 7);
  eq(CONTROLLER.stepUp, 0.55); eq(CONTROLLER.head, 1.9); eq(CONTROLLER.radius, 0.42);
  eq(CONTROLLER.maxSlope, 0.85); eq(CONTROLLER.wadeDepth, 0.9);
  eq(CONTROLLER.climb.rule, "naismith");
  close(CONTROLLER.climb.flatPerClimb, 5000 / 600, 1e-12, "Naismith: 5 km/h and 600 m/h;");
  eq(CONTROLLER.climb.flatPerDescent, 0);
  eq(FROM_INDEX, CONTROLLER, "the core index re-exports the same record;");
});

test("the record is frozen, all the way down", () => {
  ok(Object.isFrozen(CONTROLLER), "CONTROLLER is mutable");
  ok(Object.isFrozen(CONTROLLER.climb), "CONTROLLER.climb is mutable");
});

test("step, head and radius are reach.js's, not a second copy", () => {
  eq(CONTROLLER.stepUp, STEP_UP); eq(CONTROLLER.head, HEAD); eq(CONTROLLER.radius, RADIUS);
});

/* The walk controller these numbers were read from (the retired WebGL engine's engine/player/) is not in this engine.
   Its body is the game's (src/config/gameplay.js PLAYER, src/sim/PlayerController.js): levelPar.js prices par with that
   body, not this record, until the two are one body. */

test("the slope limit, in degrees, is what the header says", () => {
  close(Math.atan(CONTROLLER.maxSlope) * 180 / Math.PI, 40.36, 0.01);
  // The Tobler argument: its peak (−5 % grade) is ~19 % faster than the flat.
  close(1 / Math.exp(-3.5 * 0.05), 1.19, 0.005);
});

test("the committed controller.json is exactly what the module writes", () => {
  const text = read("./vectors/controller.json");
  eq(render(buildController()), text, "tools/test/kernel/vectors/controller.json is stale — run node tools/kernel/controller-json.mjs;");
  const file = JSON.parse(text);
  eq(file.kind, CONTROLLER_KIND);
  const { kind, ...rest } = file;
  eq(JSON.stringify(rest), JSON.stringify(controllerData()), "the file's fields are not the module's;");
  // every field of the module is in the file, and nothing else is
  eq(Object.keys(rest).sort().join(), Object.keys(CONTROLLER).sort().join());
});

test("the file is schema-stable: sorted keys, two-space indent, one newline", () => {
  const text = read("./vectors/controller.json");
  ok(text.endsWith("}\n") && !text.endsWith("\n\n"), "trailing newline");
  const sorted = (v) => v === null || typeof v !== "object" || Object.keys(v).every((k, i, a) =>
    (i === 0 || a[i - 1] < k) && sorted(v[k]));
  ok(sorted(JSON.parse(text)), "keys are not sorted");
  eq(render(buildController()), render(buildController()), "two renders differ;");
});

report("controller");
