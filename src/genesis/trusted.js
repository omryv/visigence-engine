/* trusted.js — the ONE place a string is allowed to become markup.
 *
 * THE PROBLEM THIS SOLVES, stated plainly. The editor takes untrusted text
 * from two places and puts both on screen: the filename of a dropped GLB
 * (which becomes a block's label, and travels into the register, the command
 * palette and the placement toast), and whatever is typed into a search
 * field. Both reached an `innerHTML =` through an ordinary template literal,
 * and a file named
 *
 *     <img src=x onerror=alert(origin)>.glb
 *
 * was therefore script running on this origin — with the same reach as the
 * editor itself, which is to say every world open in the session and the
 * one-shot handoff record Play writes on its way out. That is not a
 * theoretical finding: dropping a file is the one import path the product
 * advertises.
 *
 * ESCAPING EVERY CALL SITE IS NOT THE FIX. It is the same fix that has been
 * tried in every codebase that ever shipped an XSS: it works until the next
 * template literal, and there is no way to tell by reading a diff whether the
 * next one is safe. So markup is not built out of strings here. It is built
 * out of `Markup` values, and the ONLY way to make one from data is the
 * tagged template below, which escapes every interpolation as it goes. A
 * string that came from anywhere else cannot reach innerHTML at all:
 * `setHTML` rejects it before the DOM sees it, and — on browsers that
 * implement Trusted Types — the platform rejects it too, at every DOM XSS
 * sink in the page, including the ones this file has never heard of.
 *
 *     import { html, setHTML } from "…/trusted.js";
 *     setHTML(node, html`<b>${label}</b>`);   // label is escaped, always
 *
 * `trust()` is the deliberate hole, and it is the size of an audit: it takes
 * a literal this repository authored — an icon's SVG, a fixed layout — and
 * nothing else. Grep for it; every use should be a constant.
 *
 * WHY THIS LIVES IN engine/. It is the one module the shell, the games and
 * the renderer all need, and engine/ is the only layer all three already
 * import. A second copy would mean a second Trusted Types policy with the
 * same name, which the platform refuses outright — the policy is created
 * once, here, or the page throws at boot.
 *
 * (Not part of engine/core: the core is DOM-free by contract, and this is
 * nothing but a DOM contract.)
 */

const POLICY_NAME = "worldfoundry";

/* Same-origin only, and only paths this repository serves. The worker
   constructor is a script-execution sink — `new Worker(someUrl)` runs code —
   so it goes through the same door as markup does, and the door checks that
   the URL is one of ours before it opens. */
function checkScriptURL(url) {
  const here = typeof location === "object" ? location.href : "http://localhost/";
  const u = new URL(String(url), here);
  if (u.origin !== new URL(here).origin) {
    throw new TypeError(`refused a cross-origin script URL: ${u.origin}`);
  }
  if (!/\.js$/.test(u.pathname)) {
    throw new TypeError(`refused a script URL that is not a module: ${u.pathname}`);
  }
  return u.href;
}

/* The platform side. Created once, at module load, and deliberately without
   a fallback default policy: a default policy that waves everything through
   is a way of switching Trusted Types off while appearing to have it on. If
   a sink in this codebase is ever handed a bare string, it should throw in
   development rather than pass in production. */
const tt = typeof globalThis !== "undefined" ? globalThis.trustedTypes : undefined;
const policy = tt && typeof tt.createPolicy === "function"
  ? tt.createPolicy(POLICY_NAME, {
      // Reached only from setHTML, which has already proved the value is a
      // Markup built by the tagged template below.
      createHTML: (s) => s,
      createScriptURL: checkScriptURL,
    })
  : null;

export const TRUSTED_TYPES_ACTIVE = !!policy;

/* ── escaping ──
   Attribute-safe as well as text-safe: quotes are the half of this that gets
   forgotten, and `title="${name}"` was exactly how the register leaked. */
const ENTITY = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ENTITY[c]);

/* A value that has been through the door. Not a string, on purpose: an
   accidental `setHTML(node, someString)` is a type error rather than a
   vulnerability, and it fails at the call site instead of in a bug report. */
class Markup {
  constructor(s) { this._ = s; }
  toString() { return this._; }
}

/**
 * The tagged template. Static parts are this file's callers' own source;
 * interpolations are DATA and are escaped, unless they are themselves Markup
 * (so fragments compose without being double-escaped).
 *
 *     html`<b>${name}</b>${rows.map(r => html`<i>${r}</i>`)}`
 *
 * Arrays join with no separator, which is what building a list wants.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return new Markup(out);
}

function render(v) {
  if (v instanceof Markup) return v._;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v == null || v === false) return "";
  return esc(v);
}

/**
 * The audited hole: markup this repository AUTHORED, as a literal. Icons are
 * the whole reason it exists — they are hand-written SVG constants, and
 * escaping them would print their source. Never hand it anything that came
 * from a file, a field, a URL or a network response.
 */
export const trust = (literal) => new Markup(String(literal));

/** The empty document — for clearing a node without touching innerHTML. */
export const EMPTY = new Markup("");

/**
 * Replace a node's children. The only sanctioned write to innerHTML in this
 * codebase; everything else should be textContent or createElement.
 */
export function setHTML(node, markup) {
  if (!(markup instanceof Markup)) {
    throw new TypeError("setHTML expects html`` output — a bare string is never markup");
  }
  node.innerHTML = policy ? policy.createHTML(markup._) : markup._;
  return node;
}

/** Build a detached element from markup — the fragment form of setHTML. */
export function element(tag, className, markup) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (markup != null) setHTML(n, markup);
  return n;
}

/**
 * A module worker's URL, checked and (where the platform offers it) minted as
 * a TrustedScriptURL. `new Worker(scriptURL(new URL("./w.js", import.meta.url)))`.
 */
export function scriptURL(url) {
  return policy ? policy.createScriptURL(String(url)) : checkScriptURL(url);
}
