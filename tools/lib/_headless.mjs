/**
 * Headless Chromium over the DevTools protocol, for the GPU gates.
 *
 * One static server over the repository, one browser, one page per shot: `openPage` waits
 * on the page's own readiness signal (`window.__capture.status()`, a plain object with
 * `ready`, `status`, `errors`) instead of a fixed virtual-time budget, then screenshots.
 * Node 22's global WebSocket is the whole client; there is no dependency.
 *
 * SwiftShader is the default rasteriser, so anything captured through this proves a
 * node graph compiles and draws on WebGL2 - not what a real GPU's frame costs.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The repository to serve; SHOOT_ROOT points a capture at another checkout (a baseline). */
export const ROOT = process.env.SHOOT_ROOT ? path.resolve(process.env.SHOOT_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  return null;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.glb': 'model/gltf-binary',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml',
};

/**
 * Serve the repository on loopback, from its root, as the site is served. Never a path outside it.
 *
 * `fallbackRoot` answers a request the repository cannot: the browser smoke harness points
 * it at the stand-in art (tools/test/stand-in-assets.mjs) so a mission loads real GLB bytes
 * where the R2 origin is unreachable.
 */
export async function serveRepo(port, { fallbackRoot = null, root = ROOT } = {}) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    let file = path.resolve(root, rel);
    if (fallbackRoot && (!fs.existsSync(file) || fs.statSync(file).isDirectory())) {
      const alt = path.resolve(fallbackRoot, rel);
      if (alt.startsWith(path.resolve(fallbackRoot)) && fs.existsSync(alt) && !fs.statSync(alt).isDirectory()) file = alt;
    }
    if (!(file.startsWith(root) || (fallbackRoot && file.startsWith(path.resolve(fallbackRoot)))) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return server;
}

/**
 * Launch the browser and connect.
 * @returns {Promise<{send, on, close, chrome}>}
 */
export async function launchBrowser({ width = 1280, height = 720, webgpu = false } = {}) {
  const CHROME = findChrome();
  if (!CHROME) throw new Error('No Chromium found. Set CHROME_PATH, or install one.');
  const args = [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage', '--mute-audio',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--window-size=${width},${height}`, '--remote-debugging-port=0', 'about:blank',
  ];
  if (webgpu) args.splice(3, 0, '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan,WebGPU');
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  /** Everything the browser said on stderr, for a context loss that only it explains. */
  const log = { text: '' };
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    chrome.stderr.on('data', d => { buf += d; log.text += d; if (log.text.length > 200000) log.text = log.text.slice(-100000); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
    chrome.on('exit', code => reject(new Error(`chromium exited (${code}) before DevTools came up:\n${buf}`)));
    setTimeout(() => reject(new Error('DevTools did not start in 30 s')), 30000).unref?.();
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  const close = () => { try { ws.close(); } catch { /* gone */ } chrome.kill('SIGKILL'); };
  return { send, on, close, chrome, path: CHROME, width, height, log };
}

/**
 * Open `url` in a fresh page, wait for its readiness signal, screenshot it, close it.
 *
 * @returns {Promise<{state: object|null, consoleErrors: string[], elapsed: number, png: Buffer}>}
 */
export async function openPage(browser, url, { timeoutMs = 600000, onStatus = () => {}, ignore = [/WebGPU is not available, running under WebGL2/] } = {}) {
  const { send, on, width, height } = browser;
  const t0 = Date.now();
  // The size comes from the metrics override below: newer Chromium refuses a size for a tab in an existing window.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const consoleErrors = [];
  const keep = text => !ignore.some(re => re.test(text));
  on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) { const t = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text; if (keep(t)) consoleErrors.push(t); } });
  on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid !== sessionId || (p.type !== 'error' && p.type !== 'warning')) return;
    const text = p.args.map(a => a.value ?? a.description).join(' ');
    if (keep(text)) consoleErrors.push(text);
  });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  let state = null, lastStatus = '';
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 1000));
    const { result } = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__capture ? window.__capture.status() : null)', returnByValue: true }, sessionId);
    state = result.value ? JSON.parse(result.value) : null;
    if (state && state.status !== lastStatus) { lastStatus = state.status; onStatus(lastStatus); }
    if (state?.ready || state?.status === 'failed') break;
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await send('Target.closeTarget', { targetId });
  return { state, consoleErrors, elapsed: (Date.now() - t0) / 1000, png: Buffer.from(data, 'base64') };
}
