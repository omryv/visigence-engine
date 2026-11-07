/**
 * THE MODULE GRAPH, in one place for every tool that reads it (tools/check-imports.mjs, tools/build/game-manifest.mjs,
 * tools/build/build-preview.mjs).
 *
 * Everything the engine runs is inside this repository and is served from the root of an origin, exactly as it sits
 * on disk: src/ (the engine, its kernel at src/kernel/ and its reconstruction at src/atlas/), editor/ (the studio),
 * vendor/ (three.js). There is no other place an import may land, so one rule holds every specifier: resolved as a
 * path on disk and resolved as a URL from the file's served path, it is the same real file inside the repository.
 * The browser cannot climb above "/", and a specifier that climbs out of the repository and back in is a file on
 * disk and a 404 in a browser, so the check resolves both ways and holds them to agreeing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, which is the site's root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);
export const inRepo = file => inside(ROOT, file);
/** The kernel and the reconstruction: pure modules, which may import nothing outside themselves (check-imports). */
export const KERNEL = path.join(ROOT, 'src', 'kernel');
export const ATLAS = path.join(ROOT, 'src', 'atlas');
export const inKernel = file => inside(KERNEL, file);
export const inAtlas = file => inside(ATLAS, file);

/**
 * The source with comments removed and every template literal's text blanked (its ${…} expressions kept, since code
 * runs there), so that prose about importing is not an import. A small lexer, not a regex: template literals nest
 * (`a ${b ? `c` : ''}`), strings and regular expressions may hold quotes, slashes and backticks, and a regex pairing
 * backticks across a file silently swallows real imports.
 */
export function stripSource(src) {
  let out = '', i = 0, last = '';            // last: the previous significant character of code, to tell / apart
  const stack = [];                           // brace depth of each open ${ … } inside a template literal
  const n = src.length;
  const regexMayStart = () => last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.trimEnd());
  const template = () => {                    // at the char after an opening backtick, or after a closing }
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; out += '`'; last = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; out += '${'; stack.push(0); last = '{'; return; }
      i++;
    }
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; last = c; continue;
    }
    if (c === '`') { out += '`'; i++; template(); continue; }
    if (c === '/' && regexMayStart()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      out += '/re/'; i = j + 1; while (i < n && /[a-z]/i.test(src[i])) i++; last = '/'; continue;
    }
    if (stack.length) {
      if (c === '{') stack[stack.length - 1]++;
      else if (c === '}') {
        if (stack[stack.length - 1] === 0) { stack.pop(); out += '}'; i++; template(); continue; }
        stack[stack.length - 1]--;
      }
    }
    out += c; i++;
    if (!/\s/.test(c)) last = c;
  }
  return out;
}

/** Every module specifier in one source file: static imports and exports, and dynamic imports of a string. */
export function moduleSpecifiers(source) {
  const src = stripSource(source);
  return [
    ...src.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm),
    ...src.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g),
    ...src.matchAll(/^[ \t]*import\s*['"]([^'"\n]+)['"]/gm),
  ].map(m => m[1]);
}

/** Where a relative specifier in `file` lands on disk (".js" appended when it has none). */
export function resolveRelative(file, spec) {
  let target = path.resolve(path.dirname(file), spec);
  if (!path.extname(target)) target += '.js';
  return target;
}

/** Where a browser fetches `spec` from `file`, served at '/' + its repository path, mapped back onto disk. */
export function servedTarget(file, spec) {
  const served = '/' + path.relative(ROOT, file).split(path.sep).join('/');
  let url = decodeURIComponent(new URL(spec, 'http://engine.invalid' + served).pathname);
  if (!path.posix.extname(url)) url += '.js';
  return path.join(ROOT, ...url.slice(1).split('/'));
}

/** Every .js file under `dir` (absolute), sorted, skipping dot-entries. */
export function jsFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  })(dir);
  return out;
}

/** The files a browser runs: the engine and the studio. */
export function runtimeFiles() {
  return [...jsFiles(path.join(ROOT, 'src')), ...jsFiles(path.join(ROOT, 'editor'))];
}
