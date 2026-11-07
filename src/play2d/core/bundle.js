/**
 * Turns the builder's ES modules into one classic script, so an exported game is a single
 * HTML file that runs from any static host, an itch.io upload, or a double-click on the file.
 *
 * It is a small bundler for a small, disciplined dialect, and the discipline is the contract:
 *
 *   import { a, b as c } from './x.js';          named imports only (multi-line is fine)
 *   import * as ns from './x.js';                namespaces
 *   export function f / async function / class / const / let / var   one name per statement
 *   export { a, b as c };                        local export lists
 *   export { a, b as c } from './x.js';          re-exports
 *
 * No default exports, no `export *`, no dynamic import(). `tools/test/test-builder-export.mjs`
 * bundles the real runtime and checks every module's exports against Node's own import of
 * it, so a module that strays from the dialect fails a test rather than an exported game.
 */

const IMPORT_RE = /^[ \t]*import\s*(\{[^{}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*)\s*from\s*['"]([^'"\n]+)['"];?[ \t]*$/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s*['"]([^'"\n]+)['"];?[ \t]*$/gm;
const REEXPORT_RE = /^[ \t]*export\s*\{([^{}]*)\}\s*from\s*['"]([^'"\n]+)['"];?[ \t]*$/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^{}]*)\};?[ \t]*$/gm;
const EXPORT_DECL_RE = /^([ \t]*)export\s+((?:async\s+)?function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const FORBIDDEN_RE = /^[ \t]*export\s+(default\b|\*)/m;

/** Resolve a relative specifier against the importing module's path ('/a/b/c.js'). */
export function resolvePath(from, spec) {
  if (!spec.startsWith('.')) throw new Error(`${from}: only relative imports can be bundled ("${spec}")`);
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

/** The specifiers a module source imports or re-exports from. */
export function dependenciesOf(source) {
  const out = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE, REEXPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) out.push(re === BARE_IMPORT_RE ? m[1] : m[2]);
  }
  return out;
}

/**
 * Fetch an entry module and everything it reaches. `readText(path)` returns a module's
 * source (a fetch in the browser, fs in a test). Returns Map(path -> source).
 */
export async function collectModules(entry, readText) {
  const sources = new Map();
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift();
    if (sources.has(path)) continue;
    const src = await readText(path);
    sources.set(path, src);
    for (const spec of dependenciesOf(src)) queue.push(resolvePath(path, spec));
  }
  return sources;
}

function parseSpecifiers(list) {
  return list.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
    if (!m) throw new Error(`Cannot bundle specifier "${s}"`);
    return { name: m[1], alias: m[2] || m[1] };
  });
}

/** Rewrite one module into a factory body that reads its imports from `__m`. */
export function transformModule(path, source) {
  if (FORBIDDEN_RE.test(source)) throw new Error(`${path}: default and star exports cannot be bundled`);
  const exported = [];     // [exportedName, expression]
  let code = source;
  code = code.replace(REEXPORT_RE, (_, list, spec) => {
    const from = JSON.stringify(resolvePath(path, spec));
    for (const s of parseSpecifiers(list)) exported.push([s.alias, `__m[${from}].${s.name}`]);
    return '';
  });
  code = code.replace(IMPORT_RE, (_, what, spec) => {
    const from = JSON.stringify(resolvePath(path, spec));
    if (what.startsWith('*')) return `const ${what.replace(/^\*\s*as\s+/, '').trim()} = __m[${from}];`;
    const specs = parseSpecifiers(what.slice(1, -1));
    return `const { ${specs.map(s => (s.name === s.alias ? s.name : `${s.name}: ${s.alias}`)).join(', ')} } = __m[${from}];`;
  });
  code = code.replace(BARE_IMPORT_RE, '');
  code = code.replace(EXPORT_LIST_RE, (_, list) => {
    for (const s of parseSpecifiers(list)) exported.push([s.alias, s.name]);
    return '';
  });
  code = code.replace(EXPORT_DECL_RE, (_, indent, kind, name) => {
    exported.push([name, name]);
    return `${indent}${kind} ${name}`;
  });
  const ret = exported.map(([k, v]) => (k === v ? k : `${k}: ${v}`)).join(', ');
  return `${code}\nreturn { ${ret} };`;
}

/** Order modules so each comes after everything it imports. */
export function orderModules(sources, entry) {
  const order = [], state = new Map();
  const visit = path => {
    if (state.get(path) === 2) return;
    if (state.get(path) === 1) throw new Error(`Import cycle through ${path}`);
    state.set(path, 1);
    const src = sources.get(path);
    if (src === undefined) throw new Error(`Missing module ${path}`);
    for (const spec of dependenciesOf(src)) visit(resolvePath(path, spec));
    state.set(path, 2);
    order.push(path);
  };
  visit(entry);
  return order;
}

/**
 * One classic script. When run it defines `globalName` (default `__visigame`) as the entry
 * module's exports, and `globalName + 'Modules'` as every module's, for tests.
 */
export function bundle(sources, entry, globalName = '__visigame') {
  const order = orderModules(sources, entry);
  const parts = ['(function () {', '"use strict";', 'const __m = Object.create(null);'];
  for (const path of order) {
    parts.push(`__m[${JSON.stringify(path)}] = (function () {\n${transformModule(path, sources.get(path))}\n})();`);
  }
  parts.push(`globalThis[${JSON.stringify(globalName)}] = __m[${JSON.stringify(entry)}];`);
  parts.push(`globalThis[${JSON.stringify(globalName + 'Modules')}] = __m;`);
  parts.push('})();');
  return parts.join('\n');
}

/** Make JavaScript source safe inside an inline <script> element. */
export function scriptSafe(text) { return String(text).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'); }
/** JSON for an inline <script type="application/json">: no "<" can close the element. */
export function jsonSafe(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16)); }
