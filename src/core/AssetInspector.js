/**
 * `resolveClips()` is how semantic animation names ("fire", "reload", ...) are bound to real
 * clip names: by pattern, against the clips that exist, never by assumption. A name that
 * resolves to null is a name the runtime has to cover procedurally, and the animator treats it
 * exactly that way.
 */

/**
 * Bind semantic animation names to the clips that actually exist.
 *
 * @param {import('three').AnimationClip[]} clips
 * @param {Record<string, RegExp[]>} patterns   semantic name -> patterns tried in order
 * @returns {Record<string, import('three').AnimationClip|null>} every semantic name, null
 *   where nothing matched. Each clip is bound to at most one name (first pattern wins).
 */
export function resolveClips(clips, patterns) {
  const out = {};
  const taken = new Set();
  for (const [semantic, pats] of Object.entries(patterns)) {
    out[semantic] = null;
    for (const re of pats) {
      const clip = (clips || []).find((c) => !taken.has(c) && re.test(c.name));
      if (clip) { out[semantic] = clip; taken.add(clip); break; }
    }
  }
  return out;
}
