/**
 * Playtest: the game over the editor, from the level you are on (or from the cell you chose),
 * with infinite lives and a Restart / Stop bar. When it closes, the path you took and where
 * you fell come back to the editor as the trace overlay.
 *
 * `mode: 'standalone'` plays the whole game as a player would see it, title screen included,
 * with a close button in the corner.
 */
import { createGame } from '../runtime/game.js';
import { icon } from './icons.js';

export function openPlaytest({ host, editor, store, art, levelIndex = 0, spawn = null, mode = 'playtest', onClose }) {
  host.hidden = false;
  host.innerHTML = '';
  editor.inert = true;
  const frame = document.createElement('div');
  frame.style.cssText = 'position:absolute;inset:0';
  host.appendChild(frame);
  let closeBtn = null;
  let done = false;
  const close = result => {
    if (done) return;
    done = true;
    game.destroy();
    host.innerHTML = '';
    host.hidden = true;
    editor.inert = false;
    onClose?.(result || null);
  };
  const game = createGame(frame, store.project, {
    mode, levelIndex, spawn, art,
    onExit: result => close(result),
  });
  if (mode === 'standalone') {
    closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn--secondary';
    closeBtn.style.cssText = 'position:absolute;left:12px;bottom:12px;z-index:20';
    closeBtn.innerHTML = `${icon('chevronLeft')}Back to the editor`;
    closeBtn.addEventListener('click', () => close(null));
    host.appendChild(closeBtn);
  }
  requestAnimationFrame(() => game.focus());
  return { close: () => (mode === 'playtest' ? game.stop() : close(null)), game };
}
