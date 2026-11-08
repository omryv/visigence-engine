/**
 * Level analysis off the main thread: the puzzle solver can explore hundreds of thousands of
 * positions, and painting should never wait for it. The editor posts one level at a time;
 * results come back tagged with the request id so stale answers are ignored.
 */
import { analyzeLevel } from '../core/analyze.js';

self.onmessage = e => {
  const { id, project, levelIndex, opts } = e.data;
  try {
    const result = analyzeLevel(project, levelIndex, opts);
    self.postMessage({ id, ok: true, result }, result.reach ? [result.reach.buffer] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
