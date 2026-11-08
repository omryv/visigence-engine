/**
 * Publishing: the single-file HTML game, share links, and project files.
 *
 * The exported game is one self-contained HTML file: the runtime, the art and the project are
 * inlined (the runtime's ES modules bundled by core/bundle.js into one classic script), so it
 * runs from any static host, an itch.io upload, a portal, or a double-click. The only external
 * request is the Google Fonts stylesheet, and the game falls back to system fonts without it.
 *
 * `window.VisigameHooks` is where a web portal's SDK plugs in: `adBreak(kind)` is awaited
 * between levels and for a rewarded continue (when enabled in the Game settings), and
 * `event(name, data)` reports gameplay start and stop, level starts and completions, game over
 * and game complete.
 */
import { collectModules, bundle, scriptSafe, jsonSafe } from '../core/bundle.js';
import { toDocument, serializeProject, parseProject, encodeShare, FormatError } from '../core/format.js';
import { genreById } from '../core/catalog.js';
import { dialog, esc, toast } from './dialogs.js';
import { icon } from './icons.js';

const ENTRY = '/src/play2d/runtime/game.js';
let bundleCache = null;

export async function runtimeBundle() {
  if (bundleCache) return bundleCache;
  const sources = await collectModules(ENTRY, async path => {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Could not load ${path} (${r.status})`);
    return r.text();
  });
  bundleCache = bundle(sources, ENTRY);
  return bundleCache;
}

export function slug(title) {
  return (String(title || 'game').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48)) || 'game';
}

export async function buildStandaloneHtml(project) {
  const code = await runtimeBundle();
  const title = esc(project.title || 'Untitled game');
  const desc = esc(project.description || `${genreById(project.genre)?.name || 'Arcade'} game made with Visigame.`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0e33">
<meta name="description" content="${desc}">
<meta name="generator" content="Visigame Level Builder">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600..700&family=Nunito:wght@500..900&display=swap">
<style>html, body { margin: 0; height: 100%; background: #0c0e33; overflow: hidden; } #game { position: fixed; inset: 0; }</style>
</head>
<body>
<div id="game"></div>
<script>
/*
 * Monetisation and analytics hooks. The game calls these; by default they do nothing and the
 * game simply carries on. To connect a web portal's SDK, replace the two functions:
 *
 *   adBreak(kind)  kind is 'between-levels' or 'rewarded'. Return a Promise that resolves when
 *                  the ad is over; for 'rewarded', resolve true if the player earned the reward
 *                  (they get their lives back) or false if not.
 *   event(name, data)  'gameplayStart', 'gameplayStop', 'levelStart', 'levelComplete',
 *                  'gameOver', 'gameComplete'. Forward to the portal's analytics if it wants them.
 *
 * Ad breaks between levels and the rewarded continue are switched on in the builder's Game
 * settings (Publishing). Set window.VisigameHooks before this script, or edit it here.
 */
window.VisigameHooks = window.VisigameHooks || {
  adBreak: function (kind) { return Promise.resolve(false); },
  event: function (name, data) {}
};
</script>
<script type="application/json" id="visigame-game">${jsonSafe(toDocument(project))}</script>
<script>${scriptSafe(code)}</script>
<script>
(function () {
  var modules = window.__visigameModules;
  var doc = JSON.parse(document.getElementById('visigame-game').textContent);
  var project = modules['/src/play2d/core/format.js'].normalizeProject(doc);
  window.__visigame.createGame(document.getElementById('game'), project, { mode: 'standalone', hooks: window.VisigameHooks });
})();
</script>
</body>
</html>
`;
}

export function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadProject(project) {
  download(`${slug(project.title)}.visigame.json`, serializeProject(project, 2), 'application/json');
}

/** Read a chosen project file. Throws FormatError with a readable message. */
export async function readProjectFile(file) {
  if (!file) throw new FormatError('No file chosen');
  if (file.size > 2 * 1024 * 1024) throw new FormatError('That file is larger than 2 MB');
  const text = await file.text();
  return parseProject(text);
}

export function pickFile(accept = '.json,application/json') {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true }); // closed without a file
    input.click();
  });
}

export async function shareUrl(project) {
  const code = await encodeShare(project);
  // inside the iOS app the page's own address is the app's private one, so it names the public builder
  const base = globalThis.visigameHost?.shareBase || `${location.origin}${location.pathname}`;
  return `${base}#play=${code}`;
}

export async function openShare(store) {
  let url = '';
  try { url = await shareUrl(store.project); } catch (e) { toast(`Could not make a link: ${e.message}`, 'error'); return; }
  const long = url.length > 60000;
  await dialog({
    meta: 'Share', title: 'A link that plays your game',
    body: `<p>Anyone with this link plays <strong>${esc(store.project.title)}</strong> in their browser, and can remix it in the builder. The whole game travels inside the link; nothing is uploaded.</p>
      <div class="copyrow"><label class="sr-only" for="share-url">Game link</label><input id="share-url" type="text" readonly value="${esc(url)}"><button type="button" class="btn btn--primary" data-copy data-autofocus>${icon('copy')}Copy</button></div>
      <p class="meta">${(url.length / 1024).toFixed(1)} KB link${long ? ' · long: some apps may cut it, so download the game instead' : ''}</p>`,
    actions: [{ label: 'Done', kind: 'ghost', value: 'done' }],
    onMount: dlg => {
      const input = dlg.querySelector('#share-url');
      dlg.querySelector('[data-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); toast('Link copied.', 'ok'); }
        catch { input.select(); document.execCommand?.('copy'); toast('Link selected: copy it with Ctrl or ⌘ C.'); }
      });
      input.addEventListener('focus', () => input.select());
    },
  });
}

/**
 * The export dialog: a project-wide check first (errors block the game download, with each one
 * a link to where it is), the publishing options, then the downloads.
 */
export async function openExport({ store, analyzeProject, onJump }) {
  const p = store.project;
  const summary = analyzeProject();
  const errors = [];
  summary.levels.forEach((r, i) => r.issues.filter(x => x.severity === 'error').forEach(x => errors.push({ ...x, level: i })));
  const warnings = summary.warnings;
  const pub = p.publish;
  const body = `
    <div class="export-summary">
      ${errors.length ? `<span class="tally tally--live">${errors.length} error${errors.length === 1 ? '' : 's'}</span>` : '<span class="tally tally--ready">Ready to publish</span>'}
      <span class="meta">${p.levels.length} level${p.levels.length === 1 ? '' : 's'} · ${esc(genreById(p.genre).name)}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}</span>
    </div>
    ${errors.length ? `<p>Fix these before downloading the game; the project file still downloads.</p>
      <ul class="issues">${errors.map((x, n) => `<li><button type="button" class="issue issue--error" data-err="${n}"><span class="issue__sev meta">Level ${x.level + 1}</span><span class="issue__msg">${esc(x.message)}</span>${x.at ? `<span class="issue__at meta">X ${x.at.x} · Y ${x.at.y}</span>` : ''}</button></li>`).join('')}</ul>` : ''}
    <div class="export-grid">
      <div class="export-card">${icon('download')}<div><strong>Game (.html)</strong><span>One file with the runtime, the art and every level. Upload it to itch.io or any static host, or double-click to play.</span></div>
        <button type="button" class="btn btn--primary" data-dl="html" ${errors.length ? 'disabled' : ''}>Download game</button></div>
      <div class="export-card">${icon('save')}<div><strong>Project (.visigame.json)</strong><span>The editable source. Open it here later, or on another device.</span></div>
        <button type="button" class="btn btn--secondary" data-dl="json">Download project</button></div>
    </div>
    <div class="publish-box">
      <p class="field__label meta">Monetisation hooks</p>
      <label class="switch" for="ex-ads"><input id="ex-ads" type="checkbox" ${pub.adBreaks ? 'checked' : ''} data-pub="adBreaks"><span class="switch__track" aria-hidden="true"><i></i></span><span class="switch__label">Ad break between levels</span></label>
      <label class="switch" for="ex-rew"><input id="ex-rew" type="checkbox" ${pub.rewardedContinue ? 'checked' : ''} data-pub="rewardedContinue"><span class="switch__track" aria-hidden="true"><i></i></span><span class="switch__label">Rewarded continue after game over</span></label>
      <label class="switch" for="ex-cr"><input id="ex-cr" type="checkbox" ${pub.showCredits ? 'checked' : ''} data-pub="showCredits"><span class="switch__track" aria-hidden="true"><i></i></span><span class="switch__label">Show “Made with Visigame”</span></label>
      <p class="field__help">The game calls <code>window.VisigameHooks.adBreak()</code> at these moments; the file explains how to connect a portal's SDK. Without one, play just continues.</p>
    </div>`;
  await dialog({
    meta: 'Export', title: `Publish ${p.title}`, body, wide: true,
    actions: [{ label: 'Close', kind: 'ghost', value: 'close' }],
    onMount: (dlg, close) => {
      dlg.addEventListener('change', e => { const k = e.target.dataset.pub; if (k) store.setProject({ publish: { [k]: e.target.checked } }, 'Publishing options'); });
      dlg.addEventListener('click', async e => {
        const err = e.target.closest('[data-err]');
        if (err) { close('jump'); onJump(errors[+err.dataset.err]); return; }
        const b = e.target.closest('[data-dl]');
        if (!b) return;
        if (b.dataset.dl === 'json') { downloadProject(store.project); toast('Project downloaded.', 'ok'); return; }
        b.disabled = true;
        const label = b.textContent;
        b.textContent = 'Building…';
        try {
          const html = await buildStandaloneHtml(store.project);
          download(`${slug(store.project.title)}.html`, html, 'text/html');
          toast(`Game downloaded: ${slug(store.project.title)}.html (${Math.round(html.length / 1024)} KB).`, 'ok');
        } catch (ex) {
          toast(`The game could not be built: ${ex.message}`, 'error');
        } finally { b.disabled = false; b.textContent = label; }
      });
    },
  });
}
