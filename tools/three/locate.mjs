/**
 * Read a position in a minified three bundle.
 *
 * The vendored bundles are one line each, so a stack frame like
 * `three.webgpu.min.js:6:501772` names a column and nothing else. This prints the code
 * around that column with the enclosing class (`static get type(){return"X"}` for node
 * classes, `class X extends Y` otherwise) and the method it sits in, which is what turned
 * the macOS Safari WeakMap report into "TRAANode's depth copy" in one step.
 *
 *   node tools/three/locate.mjs 6:501772                  # webgpu bundle, default
 *   node tools/three/locate.mjs three.core.min.js:6:1234  # any vendored bundle
 *   node tools/three/locate.mjs --width 300 6:501772      # more context either side
 *   node tools/three/locate.mjs "set@[native code] ← get three.webgpu.min.js:6:471664 ← ..."
 *
 * The last form takes a whole stack string (a panel's error origin, a console line) and
 * decodes every `<bundle>:<line>:<column>` in it, in order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = path.join(ROOT, 'vendor/three/build');
const argv = process.argv.slice(2);
const widthAt = argv.indexOf('--width');
const width = widthAt >= 0 ? Number(argv[widthAt + 1]) : 160;
const inputs = argv.filter((a, i) => a !== '--width' && i !== widthAt + 1);
if (!inputs.length) { console.error('usage: node tools/three/locate.mjs [--width N] <line:column | bundle:line:column | stack text>'); process.exit(2); }

const frames = [];
for (const input of inputs) {
  const re = /(?:([A-Za-z0-9_.-]+\.min\.js):)?(\d+):(\d+)/g;
  let m;
  while ((m = re.exec(input))) frames.push({ file: m[1] || 'three.webgpu.min.js', line: Number(m[2]), column: Number(m[3]) });
}
if (!frames.length) { console.error('no <line>:<column> found in the input'); process.exit(2); }

const sources = new Map();
const lines = (file) => {
  if (!sources.has(file)) {
    const p = path.join(BUILD, file);
    if (!fs.existsSync(p)) { console.error(`no such bundle: ${p}`); process.exit(2); }
    sources.set(file, fs.readFileSync(p, 'utf8').split('\n'));
  }
  return sources.get(file);
};

/** The closest enclosing names before `index`: a three node class, a plain class, a method. */
export function enclosing(text, index) {
  const before = text.slice(Math.max(0, index - 200000), index);
  const last = (re) => { let m, hit = null; while ((m = re.exec(before))) hit = m; return hit; };
  const node = last(/static get type\(\)\{return"([A-Za-z0-9_]+)"\}/g);
  const cls = last(/class ([A-Za-z_$][\w$]*)(?: extends ([A-Za-z_$][\w$.]*))?\{/g);
  // A method definition, not a control statement: `name(args){` where name is not a keyword.
  const method = last(/(?:^|[;{}])(?:async )?(?!(?:if|for|while|switch|catch|function|return|with)\b)([A-Za-z_$][\w$]*)\(([^()]{0,120})\)\{/g);
  const pick = node && cls && node.index > cls.index ? `${node[1]} (node class)` : cls ? `class ${cls[1]}${cls[2] ? ` extends ${cls[2]}` : ''}` : null;
  return { className: pick, method: method ? `${method[1]}(${method[2]})` : null };
}

for (const { file, line, column } of frames) {
  const text = lines(file)[line - 1];
  if (text === undefined) { console.log(`${file}:${line}:${column}  (line ${line} does not exist; the bundle has ${lines(file).length} lines)\n`); continue; }
  const index = column - 1;
  const { className, method } = enclosing(text, index);
  console.log(`${file}:${line}:${column}`);
  console.log(`  in ${className ?? '?'}${method ? `  ·  ${method}` : ''}`);
  const from = Math.max(0, index - width), to = Math.min(text.length, index + width);
  console.log(`  ${text.slice(from, index)}▶${text.slice(index, to)}\n`);
}
