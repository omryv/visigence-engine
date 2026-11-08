/**
 * Level generation off the main thread. Checking candidates (and solving every block puzzle)
 * can take seconds, and the editor should stay responsive while it does; the dialog shows the
 * progress this posts and cancels by terminating the worker.
 *
 *   in:  { genre, opts }                     (opts as for core/generate.js, without onProgress)
 *   out: { type: 'progress', done, total, kept, rejected, attempts }
 *        { type: 'done', result }            the levels' tile layers are transferred, not copied
 *        { type: 'error', message }
 */
import { generateLevels } from '../core/generate.js';

self.onmessage = e => {
  const { genre, opts } = e.data;
  try {
    const result = generateLevels(genre, { ...opts, onProgress: p => self.postMessage({ type: 'progress', ...p }) });
    const transfer = [];
    for (const r of result.levels) transfer.push(r.level.terrain.buffer, r.level.decor.buffer);
    self.postMessage({ type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
