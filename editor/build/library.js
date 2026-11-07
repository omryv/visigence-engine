/**
 * The games saved in this browser, for the level editor's start screen: an index of what each one is (its name,
 * genre, level count and when it last changed) and one storage entry per game, holding the game document itself
 * (project format 4, the same text an exported file carries). The store (store.js) autosaves a game to its entry;
 * the app refreshes the index line when it does.
 *
 * Before there was a library the editor kept one game under `visigame.studio.game.v1`; `migrate` makes that game
 * the library's first entry, so nothing a creator made is lost.
 */
export const LIBRARY_KEY = 'visigame.studio.games.v1';
export const LEGACY_KEY = 'visigame.studio.game.v1';
const ID = /^g[a-z0-9]{6,16}$/;

/**
 * @param {Storage} storage  localStorage, or anything with getItem/setItem/removeItem
 * @param {{now?: () => number, random?: () => number}} [o]  clocks and dice, for tests
 */
export function createLibrary(storage, { now = () => Date.now(), random = Math.random } = {}) {
  const read = () => {
    try {
      const list = JSON.parse(storage.getItem(LIBRARY_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter(e => e && ID.test(e.id) && typeof e.name === 'string') : [];
    } catch { return []; }
  };
  const write = list => { try { storage.setItem(LIBRARY_KEY, JSON.stringify(list)); return true; } catch { return false; } };
  const lib = {
    /** Where a game's document lives. */
    key: id => `${LIBRARY_KEY}:${id}`,
    newId: () => 'g' + Array.from({ length: 10 }, () => Math.floor(random() * 36).toString(36)).join(''),
    /** Newest first. */
    list: () => read().sort((a, b) => b.updated - a.updated),
    has: id => read().some(e => e.id === id),
    /** The saved document text, or null. */
    text: id => { try { return storage.getItem(lib.key(id)); } catch { return null; } },
    /** Record (or refresh) a game's line in the index. */
    touch(id, game) {
      const entry = { id, name: String(game.name ?? 'Untitled game').slice(0, 64), genre: game.genre ?? 'shooter', levels: game.levels?.length ?? 1, updated: now() };
      return write([...read().filter(e => e.id !== id), entry]);
    },
    /** Save a document under a new id and list it; returns the id, or null when storage is full or refused. */
    add(game) {
      const id = lib.newId();
      try { storage.setItem(lib.key(id), JSON.stringify(game)); } catch { return null; }
      return lib.touch(id, game) ? id : (storage.removeItem(lib.key(id)), null);
    },
    remove(id) { try { storage.removeItem(lib.key(id)); } catch { /* already gone */ } write(read().filter(e => e.id !== id)); },
    /** The one game kept before the library, as its first entry. Returns its id, or null when there was none. */
    migrate() {
      let text = null;
      try { text = storage.getItem(LEGACY_KEY); } catch { return null; }
      if (text === null) return null;
      let doc; try { doc = JSON.parse(text); } catch { return null; }
      const id = lib.add(doc);
      if (id) storage.removeItem(LEGACY_KEY);
      return id;
    },
  };
  return lib;
}
