// The one door a string may walk through to become markup (engine/trusted.js).
//
// WHY THIS SUITE EXISTS AT ALL. The module is the single security keystone of
// the product — one `innerHTML` in the whole codebase lives inside it — and it
// had no tests. Its docstring names the exact attack it was written against: a
// dropped file called `<img src=x onerror=alert(origin)>.glb`, whose name
// becomes a block label and travels into the register, the palette and a toast.
// That claim is now a test rather than a comment.
//
// The interesting property is not "it escapes". It is that escaping is not the
// mechanism: markup is a TYPE (`Markup`), the tagged template is the only way to
// mint one from data, and `setHTML` refuses anything else. So the tests below
// check the type discipline as hard as they check the entities — a future
// `setHTML(node, `<b>${name}</b>`)` must fail loudly at the call site, because
// that is the failure mode escaping-per-call-site has in every codebase that
// ever shipped an XSS.
//
// Runs headless: the module imports nothing, `trustedTypes` is absent outside a
// browser (so the platform half is inert and `TRUSTED_TYPES_ACTIVE` is false),
// and `setHTML` only ever assigns to `.innerHTML` — which a plain object models
// perfectly well.
import { test, eq, ok, report } from "../kernel/harness.js";
import { esc, html, trust, setHTML, EMPTY, scriptURL, TRUSTED_TYPES_ACTIVE } from "../../../src/genesis/trusted.js";

// A node, for the purposes of this module, is a thing with an innerHTML.
const node = () => ({ innerHTML: null });

/* ── escaping ── */

test("every character that can end an attribute or open a tag is escaped", () => {
  eq(esc("&"), "&amp;");
  eq(esc("<"), "&lt;");
  eq(esc(">"), "&gt;");
  eq(esc('"'), "&quot;");
  eq(esc("'"), "&#39;");
});

test("ampersands are escaped first, so an entity is never double-built", () => {
  // Escaping < before & would turn "<" into "&lt;" and then "&amp;lt;".
  eq(esc("<&>"), "&lt;&amp;&gt;");
  eq(esc("&amp;"), "&amp;amp;");
});

test("nullish is the empty string, not the word null", () => {
  eq(esc(null), "");
  eq(esc(undefined), "");
  eq(esc(0), "0");
  eq(esc(false), "false");
});

/* ── the tagged template ── */

test("static parts are kept and interpolations are escaped", () => {
  eq(String(html`<b>${"<i>hi</i>"}</b>`), "<b>&lt;i&gt;hi&lt;/i&gt;</b>");
});

test("Markup composes without being escaped twice", () => {
  const inner = html`<i>${"a<b"}</i>`;
  eq(String(html`<p>${inner}</p>`), "<p><i>a&lt;b</i></p>");
});

test("an array of Markup joins with no separator", () => {
  const rows = ["a", "b<"].map((r) => html`<li>${r}</li>`);
  eq(String(html`<ul>${rows}</ul>`), "<ul><li>a</li><li>b&lt;</li></ul>");
});

test("nullish and false interpolate as nothing, but zero interpolates as zero", () => {
  eq(String(html`[${null}${undefined}${false}]`), "[]");
  eq(String(html`[${0}]`), "[0]");
});

test("the filename from the module's own docstring is inert", () => {
  // The attack the module was written against, verbatim.
  const dropped = "<img src=x onerror=alert(origin)>.glb";
  const out = String(html`<b>${dropped}</b>`);
  eq(out, "<b>&lt;img src=x onerror=alert(origin)&gt;.glb</b>");
  // The words `onerror=alert(origin)` are still in there, and that is fine:
  // they are text. What makes them text is that no angle bracket from the
  // interpolation survived, so the parser never opens a tag to hang them on.
  // Asserting on the scary substring instead would be a test that passes for
  // the wrong reason — and fails when somebody escapes one bracket too few.
  const interpolated = out.slice("<b>".length, -"</b>".length);
  ok(!interpolated.includes("<"), "a raw < survived interpolation");
  ok(!interpolated.includes(">"), "a raw > survived interpolation");
});

test("a quote cannot break out of an attribute", () => {
  // The register leaked exactly here: title="${name}" with a quote in name.
  const name = '" onmouseover="alert(1)';
  const out = String(html`<b title="${name}">x</b>`);
  eq(out, "<b title=\"&quot; onmouseover=&quot;alert(1)\">x</b>");
  // One opening quote, one closing quote, and nothing between them that the
  // parser could read as a second attribute.
  eq(out.split('"').length - 1, 2, "quote count says the attribute was broken out of:");
});

/* ── the type discipline ── */

test("Markup is not a string, so it cannot be spliced into one by accident", () => {
  const m = html`<b>x</b>`;
  ok(typeof m !== "string", "Markup is a string, which defeats the whole design");
  ok(!(m instanceof String), "Markup is a String object");
  eq(`${m}`, "<b>x</b>", "but it still stringifies for composition");
});

test("setHTML refuses a bare string, however well escaped", () => {
  const n = node();
  let threw = null;
  try { setHTML(n, "<b>already escaped, honest</b>"); } catch (e) { threw = e; }
  ok(threw instanceof TypeError, "a bare string was accepted");
  eq(n.innerHTML, null, "the node was written to anyway");
});

test("setHTML refuses the things that are nearly Markup", () => {
  for (const value of [null, undefined, 0, { _: "<b>x</b>" }, ["<b>x</b>"]]) {
    let threw = null;
    try { setHTML(node(), value); } catch (e) { threw = e; }
    ok(threw instanceof TypeError, `setHTML accepted ${JSON.stringify(value)}`);
  }
});

test("setHTML writes Markup, and returns the node so it can be chained", () => {
  const n = node();
  eq(setHTML(n, html`<b>${"x"}</b>`), n);
  eq(n.innerHTML, "<b>x</b>");
});

test("EMPTY clears a node without going near a string", () => {
  const n = node();
  setHTML(n, EMPTY);
  eq(n.innerHTML, "");
});

test("trust() passes a literal through unescaped — the audited hole", () => {
  const svg = '<path d="M12 5v14"/>';
  eq(String(trust(svg)), svg);
  const n = node();
  setHTML(n, trust(svg));
  eq(n.innerHTML, svg);
});

test("a trusted fragment nests inside a template without being escaped", () => {
  eq(String(html`<span>${trust("<i>icon</i>")}</span>`), "<span><i>icon</i></span>");
});

/* ── the script-URL door ──
   `new Worker(url)` executes code, so it goes through the same policy. Outside
   a browser there is no `location`, and the module falls back to localhost —
   which is what makes these cases checkable at all from a test runner. */

test("a same-origin module URL is allowed through", () => {
  eq(scriptURL("http://localhost/engine/terrain/erosion-worker.js"),
    "http://localhost/engine/terrain/erosion-worker.js");
  // Relative resolves against the fallback origin rather than being refused.
  eq(scriptURL("./w.js"), "http://localhost/w.js");
});

test("a cross-origin script URL is refused", () => {
  let threw = null;
  try { scriptURL("https://cdn.example.com/three.module.js"); } catch (e) { threw = e; }
  ok(threw instanceof TypeError, "a cross-origin worker URL was minted");
  ok(/cross-origin/.test(threw.message), `message does not name the reason: ${threw?.message}`);
});

test("a same-origin URL that is not a module is refused", () => {
  // The extension check is what stops a worker being pointed at an upload
  // endpoint or a path that happens to serve script.
  for (const bad of ["http://localhost/w.txt", "http://localhost/", "http://localhost/w.js.map"]) {
    let threw = null;
    try { scriptURL(bad); } catch (e) { threw = e; }
    ok(threw instanceof TypeError, `${bad} was accepted as a module URL`);
  }
});

test("outside a browser the platform half is inert, and says so", () => {
  // Not a detail: the module deliberately creates NO default policy, so a sink
  // handed a bare string throws in development instead of passing in
  // production. Under the test runner there is no trustedTypes at all.
  eq(TRUSTED_TYPES_ACTIVE, false);
});

report("trusted");
