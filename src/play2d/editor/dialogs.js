/**
 * Small UI primitives for the builder: modal dialogs (focus-trapped, Esc to close, the page
 * behind goes out of focus rather than dark), confirm, toasts, context menus and tooltips.
 */
import { icon } from './icons.js';

let dialogSeq = 0;   // each dialog's heading id: counted, not drawn

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

let openCount = 0;
export const dialogOpen = () => openCount > 0;

/**
 * Open a dialog. `body` is trusted markup built by the caller (user text must go through esc).
 * `actions` are [{ label, kind: 'primary'|'secondary'|'ghost'|'danger', value, icon }]. Resolves
 * with the pressed action's value, or null when dismissed.
 */
export function dialog({ title, meta = '', body = '', actions = [], wide = false, onMount = null, label = null }) {
  return new Promise(resolve => {
    const host = document.getElementById('dialogs');
    const prev = document.activeElement;
    const back = document.createElement('div');
    back.className = 'dialog-backdrop';
    const id = 'dlg-' + (++dialogSeq).toString(36);
    back.innerHTML = `<div class="dialog ${wide ? 'dialog--wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}">
      <div class="dialog__head"><div>${meta ? `<p class="meta" style="color:var(--tungsten-ink)">${esc(meta)}</p>` : ''}<h2 class="dialog__title" id="${id}">${esc(title)}</h2></div>
      <button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
      <div class="dialog__body">${body}</div>
      ${actions.length ? `<div class="dialog__actions">${actions.map((a, i) => `<button type="button" class="btn btn--${a.kind || 'secondary'}" data-i="${i}" ${a.autofocus ? 'data-autofocus' : ''}>${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    host.appendChild(back);
    openCount++;
    document.getElementById('app')?.setAttribute('data-dialog', 'open');
    const dlg = back.firstElementChild;
    const close = value => {
      if (!back.isConnected) return;
      back.remove();
      openCount--;
      if (!openCount) document.getElementById('app')?.removeAttribute('data-dialog');
      document.removeEventListener('keydown', onKey, true);
      if (prev && prev.focus) prev.focus({ preventScroll: true });
      resolve(value);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
      if (e.key === 'Tab') {
        const f = [...dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', e => { if (e.target === back) close(null); });
    dlg.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) return close(null);
      const b = e.target.closest('[data-i]');
      if (b && b.parentElement.classList.contains('dialog__actions')) close(actions[+b.dataset.i].value ?? actions[+b.dataset.i].label);
    });
    if (onMount) onMount(dlg, close);
    const f = dlg.querySelector('[data-autofocus]') || dlg.querySelector('.dialog__body input, .dialog__body button, .dialog__actions .btn--primary') || dlg.querySelector('[data-close]');
    setTimeout(() => f?.focus({ preventScroll: true }), 20);
    void label;
  });
}

export async function confirmDialog(message, { title = 'Are you sure?', confirm = 'Delete', kind = 'danger' } = {}) {
  const v = await dialog({ title, body: `<p>${esc(message)}</p>`, actions: [{ label: 'Cancel', kind: 'ghost', value: false }, { label: confirm, kind, value: true, autofocus: true }] });
  return v === true;
}

export function toast(text, tone = 'info', opts = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast--${tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : tone === 'error' ? 'error' : 'info'}`;
  el.innerHTML = `<span>${esc(text)}</span>${opts.action ? `<button type="button" class="btn btn--secondary">${esc(opts.action.label)}</button>` : ''}`;
  if (opts.action) el.querySelector('button').addEventListener('click', () => { opts.action.run(); remove(); });
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  const remove = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 320); };
  setTimeout(remove, opts.ms || (tone === 'warn' || tone === 'error' ? 4200 : 2600));
}

/** A context or dropdown menu at (x, y). items: [{ label, kbd, run, danger, sep, icon }]. */
export function menu(x, y, items, { anchor = null } = {}) {
  closeMenus();
  const host = document.getElementById('menus');
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => it.sep ? '<hr>' : `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'is-danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`).join('');
  host.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x)) + 'px';
  m.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y)) + 'px';
  const prev = document.activeElement;
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true); anchor?.setAttribute('aria-expanded', 'false'); };
  const outside = e => { if (!m.contains(e.target) && e.target !== anchor && !anchor?.contains(e.target)) close(); };
  // focus goes back where the menu came from, before the chosen item runs (it may open a dialog)
  const restore = () => { if (prev?.isConnected) prev.focus({ preventScroll: true }); };
  const onKey = e => {
    const btns = [...m.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); restore(); }
    else if (e.key === 'Tab') { close(); restore(); } // and Tab carries on from there
    else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); btns[e.key === 'Home' ? 0 : btns.length - 1].focus(); }
  };
  m.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; close(); restore(); items[+b.dataset.i].run?.(); });
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); m.querySelector('button')?.focus(); }, 0);
  anchor?.setAttribute('aria-expanded', 'true');
  closeMenus.current = close;
  return close;
}
export function closeMenus() { closeMenus.current?.(); closeMenus.current = null; }

/** Hover and focus tooltips for elements with data-tip (and optional data-kbd). */
export function installTooltips(root) {
  let tip = null, timer = 0;
  const show = el => {
    hide();
    if (!el.isConnected) return; // re-rendered while the delay ran
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.innerHTML = `${esc(el.dataset.tip)}${el.dataset.kbd ? `<kbd>${esc(el.dataset.kbd)}</kbd>` : ''}`;
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const right = r.right + 8 + t.width < window.innerWidth && el.closest('.toolrail');
    tip.style.left = (right ? r.right + 8 : Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2))) + 'px';
    tip.style.top = (right ? r.top + r.height / 2 - t.height / 2 : r.bottom + 8 + t.height > window.innerHeight ? r.top - t.height - 8 : r.bottom + 8) + 'px';
  };
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; };
  root.addEventListener('pointerover', e => { const el = e.target.closest('[data-tip]'); if (!el || e.pointerType === 'touch') return; clearTimeout(timer); timer = setTimeout(() => show(el), 380); });
  root.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]')) hide(); });
  root.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) show(el); });
  root.addEventListener('focusout', hide);
  root.addEventListener('pointerdown', hide);
}
