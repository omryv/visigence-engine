/**
 * SEE YOURSELF, CLICKED: the studio's own page, its own buttons. "My assets" opens the prop importer; "See yourself:
 * make one from a photo" takes tools/test/fixtures/photo-front.png; the figure is reconstructed on the page (in
 * atlas-core's worker), previewed, sized to 1.75 m, credited, the rights box ticked, and added to the mission, which
 * then carries it as an imported prop.
 *
 *   node tools/test/stand-in-assets.mjs     # once, where the R2 origin is unreachable
 *   node tools/test/e2e-see-yourself.mjs
 *
 * Headless Chromium through Playwright (pre-installed in the sandbox this was written in; not a dependency of this
 * package, so this is not wired into tools/test/run.mjs, like the other browser harnesses).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT, serveRepo } from '../lib/_headless.mjs';
import { STAND_IN_ROOT } from './stand-in-assets.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PORT = 8151, PHOTO = path.resolve(ROOT, 'tools/test/fixtures/photo-front.png');
const server = await serveRepo(PORT, { fallbackRoot: STAND_IN_ROOT });
const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failures++; };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/WebGPU|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?mode=play&debug=1`);
  await page.waitForFunction(() => window.__studio, null, { timeout: 60000 });
  await page.click('.front-import');
  await page.waitForSelector('dialog.prop-dialog .photo-prop', { timeout: 30000 });
  const t0 = Date.now();
  await page.setInputFiles('dialog.prop-dialog .photo-input', PHOTO);
  await page.waitForFunction(() => /A figure from your photograph/.test(document.querySelector('dialog.prop-dialog .prop-metrics')?.textContent ?? '')
    || document.querySelector('dialog.prop-dialog .import-error')?.textContent, null, { timeout: 300000 });
  const metrics = await page.$eval('dialog.prop-dialog .prop-metrics', e => e.textContent), error = await page.$eval('dialog.prop-dialog .import-error', e => e.textContent);
  check('the photograph became a figure on the page', /A figure from your photograph/.test(metrics) && !error, `${metrics} ${error} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('the importer previews it', await page.$eval('dialog.prop-dialog .prop-preview', e => !e.hidden));
  const height = await page.$eval('dialog.prop-dialog input[name=height]', e => e.value);
  check('sized as a person', height === '1.75', height);
  await page.fill('dialog.prop-dialog input[name=creator]', 'Me');
  await page.check('dialog.prop-dialog input[name=rights]');
  await page.screenshot({ path: path.join(ROOT, 'tools/test/.stand-ins/see-yourself-dialog.png') });
  await page.click('dialog.prop-dialog .prop-settings button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('dialog.prop-dialog'), null, { timeout: 30000 });
  const props = await page.evaluate(() => window.__studio.project.importedProps);
  check('the mission carries the figure as an imported prop', props?.length === 1 && Math.abs(props[0].size[1] * props[0].scale - 1.75) < 1e-6 && props[0].triangles <= 50000,
    JSON.stringify(props?.map(p => ({ name: p.name, triangles: p.triangles, bytes: p.bytes, height: +(p.size[1] * p.scale).toFixed(3) }))));
  check('no errors reached the page', !errors.length, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close(); server.close();
}
console.log(failures ? `FAILED: ${failures}` : 'See yourself, clicked: OK');
process.exit(failures ? 1 : 0);
