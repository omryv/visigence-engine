/* object-index.js — the Object Manager's model, with the DOM removed.
 *
 * Everything the manager panel does to a list of placements before it draws
 * one — normalising, searching, filtering, sorting, counting — and everything
 * the history says out loud, lives here as plain functions over plain data.
 * No DOM, no three, no engine. That is not tidiness for its own sake: it is
 * the only way any of this gets a test, and the ranking of a search result
 * and the wording of an undo are exactly the kind of thing that rots quietly
 * when nothing is watching. See tests/objects.test.js.
 *
 * Game-shared contract module in spirit: it describes placements, and a
 * placement record is the same object everywhere in this codebase.
 */

/* ── the palette ──
   A pin's colour says what KIND of thing it marks, so a glance at a world
   from above reads as a plan rather than as confetti: green is what grows,
   blue is what was built, amber is what was put down. Deliberately few
   hues — six categories, five colours, because a legend nobody can hold in
   their head is decoration. */
export const CATEGORY_TINT = {
  builder: 0x7fb4f2,
  structures: 0x9d8cf0,
  street: 0xc9a86a,
  nature: 0x76c98a,
  objects: 0xe0a75f,
  creatures: 0xef7f7f,
  imported: 0x8fe8c9,
};
export const DEFAULT_TINT = 0x9fb2c4;

export const categoryColor = (cat) => CATEGORY_TINT[cat] ?? DEFAULT_TINT;
export const cssColor = (hex) => "#" + (hex >>> 0).toString(16).padStart(6, "0");

/* The placement order of a uid. Uids are minted `p<hash>-<n base36>` by
   fusion.js and n counts up over the session, so it survives the one thing
   Map insertion order does not: an undone delete, which re-adds the record
   at the END of the map while it plainly is not the newest thing placed.

   The shape is MATCHED rather than the tail simply parsed, because base 36
   is letters: "not-a-uid" ends in "uid", which parses perfectly happily as
   39541 and would sort a piece of nonsense to the top of a list whose whole
   job is to say what you placed most recently. Anything unrecognisable
   sorts oldest, which is the harmless end. */
const UID_SHAPE = /^p[0-9a-z]+-([0-9a-z]+)$/;
export function uidIndex(uid) {
  const m = UID_SHAPE.exec(String(uid));
  if (!m) return 0;
  const n = parseInt(m[1], 36);
  return Number.isFinite(n) ? n : 0;
}

/* A record plus the editor's own view of it, flattened into the one shape
   every row, filter and sort below reads. `catalogue` maps a record's ref to
   its catalogue entry ({ category, label }); a drag-dropped GLB has no ref
   and is "imported", which is a true statement about where it came from. */
export function toRow(record, { catalogue = null, favorite = false, hidden = false, locked = false } = {}) {
  const item = catalogue && record.ref ? catalogue.get(record.ref) : null;
  const category = item?.category || (record.ref ? record.ref.split("/")[0] : "imported");
  const [x, y, z] = record.position || [0, 0, 0];
  return {
    uid: record.uid,
    name: record.label || item?.label || "Block",
    category,
    type: item?.label || record.label || "Block",
    ref: record.ref || null,
    x, y, z,
    order: uidIndex(record.uid),
    favorite: !!favorite,
    hidden: !!hidden,
    locked: !!locked,
    placeholder: !!record.placeholder,
    color: categoryColor(category),
  };
}

// Coordinates as a reading, not as a float dump: whole metres, the axis
// order the engine uses, a minus sign that is actually a minus sign.
export function formatXZ(x, y, z) {
  const n = (v) => (Math.round(v) === 0 ? "0" : String(Math.round(v)).replace("-", "−"));
  return `${n(x)}, ${n(y)}, ${n(z)}`;
}

/* Search over name, type and category, in that order of authority. Returns
   a score so a query can rank rather than merely include: "oak" should put
   Oak Tree above Cloak Stand, and a category match should not outrank a name
   match. −1 means no match at all. */
export function scoreRow(row, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 1;
  const name = row.name.toLowerCase();
  if (name === q) return 1000;
  if (name.startsWith(q)) return 900 - name.length;
  const at = name.indexOf(q);
  if (at > 0) return (/\s|-|·/.test(name[at - 1]) ? 700 : 500) - at;
  const type = row.type.toLowerCase();
  if (type.includes(q)) return 300;
  if (row.category.toLowerCase().includes(q)) return 200;
  if (String(row.uid).toLowerCase().includes(q)) return 100; // the console's own handle
  return -1;
}

/* One pass: filter, then order. `flags` are the toggle chips along the top
   of the manager, and they AND together — "favourites, nature, hidden" is a
   sensible question to ask and there is no reason to make it three trips. */
export function selectRows(rows, {
  query = "", category = "all", favorites = false, hidden = false, locked = false,
  sort = "newest", recentUids = null, viewer = null,
} = {}) {
  const recent = recentUids ? new Set(recentUids) : null;
  const out = [];
  for (const row of rows) {
    if (category !== "all" && row.category !== category) continue;
    if (favorites && !row.favorite) continue;
    if (hidden && !row.hidden) continue;
    if (locked && !row.locked) continue;
    if (recent && !recent.has(row.uid)) continue;
    const s = scoreRow(row, query);
    if (s < 0) continue;
    out.push({ row, score: s });
  }
  const byName = (a, b) => a.row.name.localeCompare(b.row.name) || a.row.order - b.row.order;
  const cmp = {
    // A query is itself an ordering — respecting it beats any sort the user
    // set earlier and has not touched since.
    relevance: (a, b) => b.score - a.score || b.row.order - a.row.order,
    newest: (a, b) => b.row.order - a.row.order,
    oldest: (a, b) => a.row.order - b.row.order,
    name: byName,
    type: (a, b) => a.row.category.localeCompare(b.row.category) || byName(a, b),
    distance: (a, b) => distanceTo(a.row, viewer) - distanceTo(b.row, viewer) || byName(a, b),
  };
  out.sort(query ? cmp.relevance : (cmp[sort] || cmp.newest));
  return out.map((e) => e.row);
}

export function distanceTo(row, viewer) {
  if (!viewer) return 0;
  const dx = row.x - viewer.x, dz = row.z - viewer.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Counts for the manager's head: the total, and the total per category, so
// "how many have I placed" is answered before it is asked.
export function summarise(rows) {
  const byCategory = new Map();
  let hidden = 0, locked = 0, favorites = 0;
  for (const r of rows) {
    byCategory.set(r.category, (byCategory.get(r.category) || 0) + 1);
    if (r.hidden) hidden++;
    if (r.locked) locked++;
    if (r.favorite) favorites++;
  }
  return { total: rows.length, byCategory, hidden, locked, favorites };
}

/* ══ the history, in words ══
   An undo that says "Undo — place" is telling you which BUTTON you pressed.
   What anybody actually needs to know is what just happened to the world, so
   every command carries a kind and a subject and the stack renders the
   sentence: "Removed Oak Tree", "Placed Watchtower". */
export const ACTIONS = {
  place:     { do: "Placed",      undo: "Removed" },
  site:      { do: "Generated",   undo: "Removed" },
  import:    { do: "Imported",    undo: "Removed" },
  duplicate: { do: "Duplicated",  undo: "Removed" },
  delete:    { do: "Removed",     undo: "Restored" },
  move:      { do: "Moved",       undo: "Moved back" },
  rotate:    { do: "Rotated",     undo: "Un-rotated" },
  scale:     { do: "Resized",     undo: "Resized back" },
  ground:    { do: "Dropped",     undo: "Lifted back" },
  style:     { do: "Restyled",    undo: "Un-styled" },
  vary:      { do: "Varied",      undo: "Reset" },
  hide:      { do: "Hid",         undo: "Showed" },
  show:      { do: "Showed",      undo: "Hid" },
  lock:      { do: "Locked",      undo: "Unlocked" },
  unlock:    { do: "Unlocked",    undo: "Locked" },
  sculpt:    { do: "Sculpted",    undo: "Un-sculpted" },
  river:     { do: "Carved",      undo: "Dried up" },
  grass:     { do: "Painted",     undo: "Cleared" },
  ungrass:   { do: "Cleared",     undo: "Painted" },
  spawn:     { do: "Moved spawn", undo: "Moved spawn back" },
};

// The name of what an action happened TO. One thing is named; several are
// counted, because "Removed Oak Tree, Oak Tree, Fence Post…" is not a
// sentence anybody reads.
export function subjectOf(names) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const same = list.every((n) => n === list[0]);
  return same ? `${list.length} × ${list[0]}` : `${list.length} objects`;
}

// `phrase("place", "Oak Tree", "undo")` → "Removed Oak Tree".
export function phrase(kind, subject, direction = "do") {
  const a = ACTIONS[kind] || { do: kind, undo: `Undid ${kind}` };
  const verb = direction === "undo" ? a.undo : a.do;
  return subject ? `${verb} ${subject}` : verb;
}

/* ══ randomised variation ══
   The batch operation that turns a row of identical fence posts into a fence.
   Pure, and HANDED its stream — every generator in this repo is, so that a
   world stays a function of its seed rather than of when somebody clicked.
   `amount` 0..1 scales all three: a light pass keeps a terrace tidy, a heavy
   one is for scattering rocks. */
export function varyTransform(record, rng, { amount = 1, turn = true } = {}) {
  const a = Math.min(Math.max(amount, 0), 1);
  const jitter = (spread) => 1 + (rng() * 2 - 1) * spread * a;
  const patch = { scale: +Math.min(Math.max((record.scale || 1) * jitter(0.16), 0.25), 8).toFixed(4) };
  if (turn) {
    // A full turn for anything that has no front. Quarter turns would just
    // produce four copies of the same photograph. Wrapped into one
    // revolution: varying the same set six times must not leave a record
    // carrying thirty-eight radians into the Unity package.
    const TAU = Math.PI * 2;
    patch.rotationY = +((((record.rotationY || 0) + rng() * TAU) % TAU + TAU) % TAU).toFixed(4);
  }
  const st = record.stretch || [1, 1, 1];
  patch.stretch = [
    +Math.min(Math.max(st[0] * jitter(0.07), 0.2), 6).toFixed(4),
    +Math.min(Math.max(st[1] * jitter(0.1), 0.2), 6).toFixed(4),
    +Math.min(Math.max(st[2] * jitter(0.07), 0.2), 6).toFixed(4),
  ];
  return patch;
}
