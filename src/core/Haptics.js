/**
 * GAMEPLAY EVENTS, OUT TO THE NATIVE SHELL. One-way, fire-and-forget.
 *
 * The game runs identically in a plain browser, where the port simply does not exist: every
 * call is a no-op there, which is why call sites never guard. Inside the iOS shell the port
 * is a WKScriptMessageHandler (GameEventsBridge in GameViewController.swift) that turns
 * these into haptics and, once ever, a review prompt. Only these four words cross the
 * boundary - no payloads, no state, nothing the native side has to trust.
 */

const EVENTS = new Set(['fire', 'damage', 'death', 'victory']);
let broken = false;

export function gameEvent(type) {
  if (broken || !EVENTS.has(type)) return;
  try { window.webkit?.messageHandlers?.mazeFeverGameEvents?.postMessage(type); }
  catch { broken = true; /* a hostile or torn-down port never gets a second chance */ }
}
