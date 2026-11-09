/**
 * WHAT THE EDITOR COSTS TO OPEN: requests, JS modules, bytes and time, for the editor and then each of its views,
 * with the browser cache off (every byte counted). On a checkout the pages load their modules one file at a time; on
 * the built site (--dist, after `node tools/build/build-preview.mjs`) they load one bundle each
 * (tools/build/bundle-pages.mjs). Local server: no network latency, so a real connection pays more per request.
 *
 *   node tools/test/measure-load.mjs            # the checkout, unbundled
 *   node tools/test/measure-load.mjs --dist     # the built site, bundled
 */
import path from 'node:path';
import { ROOT, serveRepo, launchBrowser } from '../lib/_headless.mjs';
import { STAND_IN_ROOT } from './stand-in-assets.mjs';
const PORT = 8190, root = process.argv.includes('--dist') ? path.join(ROOT, 'dist') : ROOT;
const server = await serveRepo(PORT, { fallbackRoot: STAND_IN_ROOT, root });
const browser = await launchBrowser({ width: 1280, height: 800, webgpu: false });
const { send, on } = browser;
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const reqs = new Map(); let bytes = 0;
on('Network.requestWillBeSent', (p, s) => { if (s === sessionId) reqs.set(p.requestId, p.request.url); });
on('Network.loadingFinished', (p, s) => { if (s === sessionId) bytes += p.encodedDataLength; });
await send('Network.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId); return r.result?.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (e, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(e).catch(() => false)) return Date.now() - t0; await sleep(100); } return -1; };
const snap = (label, t) => { const urls = [...reqs.values()]; const local = urls.filter(u => u.includes('127.0.0.1')); const three = local.filter(u => /three\.(webgpu|tsl)/.test(u)).length; console.log(`${label}: ${t} ms · ${local.length} requests (${local.filter(u => /\.js/.test(u)).length} JS modules, three loaded ${three}×) · ${(bytes / 1048576).toFixed(1)} MB`); };
const t0 = Date.now();
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?renderer=webgl&gfx=low` }, sessionId);
await until('!!(window.engine && engine.terrain && engine.terrain.tiles.size > 0)', 180000);
snap('editor ready', Date.now() - t0);
for (const v of ['remix', 'build', '2d']) {
  const t = Date.now();
  await js(`document.querySelector('#modes [data-view="${v}"]').click()`);
  const sel = { remix: `!!document.querySelector('#view-remix iframe')?.contentWindow?.document?.querySelector('.graph-stage')?.children.length`, build: `document.querySelector('#view-build iframe')?.contentWindow?.document?.body?.dataset.mode === 'build' && !!document.querySelector('#view-build iframe').contentWindow.document.querySelector('.bld:not([hidden]) canvas')`, '2d': `!!document.querySelector('#view-2d iframe')?.contentWindow?.document?.querySelector('[data-g="world"]')` }[v];
  await until(sel, 120000);
  snap(`+ ${v} view`, Date.now() - t);
}
const mem = await send('Runtime.getHeapUsage', {}, sessionId).catch(() => null);
console.log('main-document JS heap', mem ? (mem.usedSize / 1048576).toFixed(0) + ' MB' : 'n/a');
browser.close(); server.close(); process.exit(0);
