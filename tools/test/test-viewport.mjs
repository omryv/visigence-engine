// A collapsed viewport must never be drawn into: the launcher builds a mission while the
// studio's preview is hidden, and a 1x1 canvas is the size three's TRAANode uses as its
// "never sized" sentinel, so the first frame there leaves the temporal history
// uninitialised and the depth copy that follows throws inside the backend.
import assert from 'node:assert/strict';
import { viewportSize } from '../../src/core/Renderer.js';

assert.equal(viewportSize(0, 0), null, 'a hidden container');
assert.equal(viewportSize(1, 1), null, 'the sentinel size itself');
assert.equal(viewportSize(1273.5, 0), null, 'a collapsed height');
assert.equal(viewportSize(NaN, 500), null);
assert.deepEqual(viewportSize(2, 2), { width: 2, height: 2 }, 'the smallest drawable viewport');
assert.deepEqual(viewportSize(1273.5, 716.25), { width: 1273.5, height: 716.25 }, 'fractional CSS sizes pass through; the renderer floors them');
console.log('Collapsed viewports are refused, drawable ones pass through');
