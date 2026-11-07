/* shim.mjs — the six lines that let this suite run somewhere other than a Mac.
 *
 * The harness prints with JavaScriptCore's `print`, which is a jsc builtin and
 * not a web or Node one. That single global was the entire reason the suite ran
 * on a developer's laptop and nowhere else — not on Linux, and therefore not in
 * CI, which is the one place a test suite has to run. Two of the suites
 * (`about`, `boundary`) import `node:fs`, so they could never have run under
 * jsc at all: the layering check the architecture leans on was passing nowhere.
 *
 * Loaded with `node --import ./shim.mjs`, so it is evaluated before the test
 * module graph and `print` exists by the time harness.js is linked. It adds no
 * dependency, no package.json and no build step — Node ≥22.7 detects ES module
 * syntax in a bare .js file on its own, which is what keeps this a two-runtime
 * suite rather than a ported one.
 */
globalThis.print = (...args) => console.log(...args);
