// Tiny test harness for JavaScriptCore (jsc -m). No Node, no npm.
let passed = 0;
const failures = [];

export function test(name, fn) {
  try {
    fn();
    passed++;
    print(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    print(`FAIL  ${name}: ${err.message || err}`);
  }
}

export function eq(actual, expected, msg = "") {
  if (actual !== expected) throw new Error(`${msg} expected ${expected}, got ${actual}`);
}
export function close(actual, expected, eps = 1e-9, msg = "") {
  if (!(Math.abs(actual - expected) <= eps)) throw new Error(`${msg} expected ≈${expected}, got ${actual}`);
}
export function ok(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

export function report(suite) {
  print(`${suite}: ${passed} passed, ${failures.length} failed`);
  if (failures.length) throw new Error(`${suite}: ${failures.join(", ")}`);
}
