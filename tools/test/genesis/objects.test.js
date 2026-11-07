/* The Object Manager's model, and the words the history speaks.
 *
 * The panel itself is DOM and cannot run here. Everything it decides before
 * it draws anything — what a placement IS, which rows a query keeps, what
 * order they come back in, and what an undo says out loud — is pure, lives
 * in js/object-index.js, and is checked here.
 *
 * Two of these are load-bearing beyond tidiness:
 *
 *   ORDER. "Newest" is derived from the uid's own counter, not from the
 *   order records happen to arrive in. An undone delete re-adds its record
 *   at the END of the props map while plainly not being the newest thing
 *   placed, and "jump to my last placement" landing on a block from ten
 *   minutes ago is exactly the class of bug this whole feature exists to
 *   remove.
 *
 *   THE STREAM. varyTransform is handed its rng. A default of Math.random
 *   would make a batch operation unrepeatable, which makes it un-undoable in
 *   any meaningful sense, and the boundary test's rule about generators
 *   exists for the same reason.
 */
import { test, eq, ok, close, report } from "../kernel/harness.js";
import {
  toRow, scoreRow, selectRows, summarise, formatXZ, uidIndex,
  phrase, subjectOf, varyTransform, categoryColor, cssColor, CATEGORY_TINT, DEFAULT_TINT,
} from "../../../src/genesis/world/object-index.js";

const CATALOGUE = new Map([
  ["nature/oak", { label: "Oak Tree", category: "nature" }],
  ["nature/pine", { label: "Pine", category: "nature" }],
  ["builder/wall", { label: "Wall", category: "builder" }],
  ["structures/watchtower", { label: "Watchtower", category: "structures" }],
]);

const rec = (uid, ref, label, position = [0, 0, 0], extra = {}) =>
  ({ uid, ref, label, position, ...extra });

const rows = (list) => list.map((r) => toRow(r, { catalogue: CATALOGUE }));

/* ── what a placement is ── */

test("a record becomes a row that names its type, category and place", () => {
  const row = toRow(rec("pabc-5", "nature/oak", "Oak Tree", [-124.4, 12.2, 88.7]), { catalogue: CATALOGUE });
  eq(row.name, "Oak Tree");
  eq(row.category, "nature");
  eq(row.order, 5);
  eq(Math.round(row.x), -124);
  eq(row.color, CATEGORY_TINT.nature);
});

test("a dropped model has no catalogue entry and says so honestly", () => {
  const row = toRow(rec("pzz-1", null, "farmhouse", [0, 0, 0]), { catalogue: CATALOGUE });
  eq(row.category, "imported");
  eq(row.name, "farmhouse");
});

test("an unknown ref falls back to its pack rather than to nothing", () => {
  const row = toRow(rec("pzz-2", "street/lamp-post", "Lamp"), { catalogue: CATALOGUE });
  eq(row.category, "street");
  eq(row.color, CATEGORY_TINT.street);
});

test("an unknown category still gets a colour, never undefined", () => {
  eq(categoryColor("no-such-category"), DEFAULT_TINT);
  eq(cssColor(0x8fe8c9), "#8fe8c9");
  eq(cssColor(0x000102), "#000102");
});

test("authoring state rides on the row and never on the record", () => {
  const record = rec("pab-3", "builder/wall", "Wall");
  const row = toRow(record, { catalogue: CATALOGUE, favorite: true, hidden: true, locked: true });
  ok(row.favorite && row.hidden && row.locked);
  // The record handed in is untouched: hidden/locked/favourite are the
  // editor's view of the world, and the record is the world.
  eq(record.hidden, undefined);
  eq(record.locked, undefined);
  eq(record.favorite, undefined);
});

/* ── placement order ── */

test("newest is the uid's own counter, not the order records arrive in", () => {
  eq(uidIndex("p1abc-z"), 35);
  eq(uidIndex("pdead-0"), 0);
  /* Base 36 is letters, so a tail like "uid" parses as 39541 and would sort
     nonsense to the top of the one list whose job is to say what you placed
     LAST. Anything not shaped like a minted uid sorts oldest instead. */
  eq(uidIndex("not-a-uid"), 0);
  eq(uidIndex(""), 0);
  eq(uidIndex(undefined), 0);
  // The undo case: the FIRST oak is restored last, so it is last in the map
  // and must still not be "the newest thing placed".
  const list = rows([
    rec("pa-2", "nature/pine", "Pine"),
    rec("pa-0", "nature/oak", "Oak Tree"), // restored by an undo, arrives last
  ]);
  eq(selectRows(list, { sort: "newest" })[0].name, "Pine");
  eq(selectRows(list, { sort: "oldest" })[0].name, "Oak Tree");
});

/* ── the search ── */

test("a name match outranks a type match, which outranks a category match", () => {
  const oak = toRow(rec("pa-1", "nature/oak", "Oak Tree"), { catalogue: CATALOGUE });
  const wall = toRow(rec("pa-2", "builder/wall", "Wall"), { catalogue: CATALOGUE });
  ok(scoreRow(oak, "oak") > scoreRow(oak, "nature"));
  ok(scoreRow(oak, "oak") > 0 && scoreRow(oak, "zzz") < 0);
  ok(scoreRow(wall, "build") > 0, "the category is searchable");
});

test("a prefix beats a hit in the middle of the word", () => {
  const oak = toRow(rec("pa-1", "nature/oak", "Oak Tree"), { catalogue: CATALOGUE });
  const cloak = toRow(rec("pa-2", "objects/cloak", "Cloak Stand"), { catalogue: CATALOGUE });
  ok(scoreRow(oak, "oak") > scoreRow(cloak, "oak"));
  eq(selectRows([cloak, oak], { query: "oak" })[0].name, "Oak Tree");
});

test("the uid is searchable, because the console prints uids", () => {
  const oak = toRow(rec("pw9x-4", "nature/oak", "Oak Tree"), { catalogue: CATALOGUE });
  ok(scoreRow(oak, "pw9x") > 0);
});

test("an empty query keeps everything and leaves the chosen sort alone", () => {
  const list = rows([
    rec("pa-1", "nature/oak", "Oak Tree"),
    rec("pa-2", "builder/wall", "Wall"),
  ]);
  eq(selectRows(list, { query: "   " }).length, 2);
  eq(selectRows(list, { query: "", sort: "oldest" })[0].name, "Oak Tree");
});

/* ── the filters ── */

test("filters AND together", () => {
  const list = [
    toRow(rec("pa-1", "nature/oak", "Oak Tree"), { catalogue: CATALOGUE, favorite: true }),
    toRow(rec("pa-2", "nature/pine", "Pine"), { catalogue: CATALOGUE }),
    toRow(rec("pa-3", "builder/wall", "Wall"), { catalogue: CATALOGUE, favorite: true }),
  ];
  eq(selectRows(list, { category: "nature" }).length, 2);
  eq(selectRows(list, { favorites: true }).length, 2);
  eq(selectRows(list, { category: "nature", favorites: true }).length, 1);
  eq(selectRows(list, { category: "nature", favorites: true })[0].name, "Oak Tree");
});

test("hidden and locked are filters, so a hidden object can still be found", () => {
  const list = [
    toRow(rec("pa-1", "nature/oak", "Oak Tree"), { catalogue: CATALOGUE, hidden: true }),
    toRow(rec("pa-2", "nature/pine", "Pine"), { catalogue: CATALOGUE, locked: true }),
  ];
  eq(selectRows(list, { hidden: true }).length, 1);
  eq(selectRows(list, { locked: true })[0].name, "Pine");
  // and with no filter on, neither is excluded — losing an object because
  // you hid it is the exact failure this panel exists to prevent
  eq(selectRows(list, {}).length, 2);
});

test("the recent set is an explicit list, not a guess at a timestamp", () => {
  const list = rows([
    rec("pa-1", "nature/oak", "Oak Tree"),
    rec("pa-2", "nature/pine", "Pine"),
  ]);
  eq(selectRows(list, { recentUids: ["pa-2"] }).length, 1);
  eq(selectRows(list, { recentUids: [] }).length, 0);
});

/* ── the sorts ── */

test("every sort is total and stable enough to walk with the arrow keys", () => {
  const list = rows([
    rec("pa-3", "structures/watchtower", "Watchtower", [300, 0, 0]),
    rec("pa-1", "nature/oak", "Oak Tree", [10, 0, 0]),
    rec("pa-2", "builder/wall", "Wall", [-40, 0, 0]),
  ]);
  eq(selectRows(list, { sort: "name" }).map((r) => r.name).join(","), "Oak Tree,Wall,Watchtower");
  eq(selectRows(list, { sort: "type" })[0].category, "builder");
  eq(selectRows(list, { sort: "distance", viewer: { x: 0, z: 0 } })[0].name, "Oak Tree");
  eq(selectRows(list, { sort: "distance", viewer: { x: 320, z: 0 } })[0].name, "Watchtower");
  // No viewer (the panel opened before the first frame) must not throw or
  // silently drop rows.
  eq(selectRows(list, { sort: "distance" }).length, 3);
});

test("a query overrides the sort — the answer to what you typed leads", () => {
  const list = rows([
    rec("pa-9", "nature/pine", "Pine"),
    rec("pa-1", "structures/watchtower", "Watchtower"),
  ]);
  // "newest" would put Pine first; the query is a stronger statement of intent
  eq(selectRows(list, { sort: "newest", query: "watch" })[0].name, "Watchtower");
});

/* ── the count ── */

test("the summary counts the world, category by category", () => {
  const list = [
    toRow(rec("pa-1", "nature/oak", "Oak Tree"), { catalogue: CATALOGUE, hidden: true }),
    toRow(rec("pa-2", "nature/pine", "Pine"), { catalogue: CATALOGUE, favorite: true }),
    toRow(rec("pa-3", "builder/wall", "Wall"), { catalogue: CATALOGUE, locked: true }),
  ];
  const s = summarise(list);
  eq(s.total, 3);
  eq(s.byCategory.get("nature"), 2);
  eq(s.byCategory.get("builder"), 1);
  eq(s.hidden, 1); eq(s.locked, 1); eq(s.favorites, 1);
});

/* ── coordinates ── */

test("coordinates read as a position, with a real minus sign", () => {
  eq(formatXZ(-124.4, 12.2, 88.7), "−124, 12, 89");
  eq(formatXZ(0, 0, 0), "0, 0, 0");
  eq(formatXZ(-0.2, 0, 0), "0, 0, 0"); // −0 is not a place
});

/* ── the history, in words ── */

test("undo and redo say what happened to the world, not which button was pressed", () => {
  eq(phrase("place", "Oak Tree", "undo"), "Removed Oak Tree");
  eq(phrase("place", "Watchtower", "do"), "Placed Watchtower");
  eq(phrase("delete", "Oak Tree", "undo"), "Restored Oak Tree");
  eq(phrase("delete", "Oak Tree", "do"), "Removed Oak Tree");
  eq(phrase("move", "Wall", "undo"), "Moved back Wall");
});

test("an unknown kind still produces a sentence rather than 'undefined'", () => {
  eq(phrase("flumox", "Wall", "do"), "flumox Wall");
  ok(phrase("flumox", "Wall", "undo").includes("Wall"));
});

test("a subject with no name is a verb on its own, never a dangling space", () => {
  eq(phrase("spawn", "", "do"), "Moved spawn");
  eq(phrase("spawn", "", "undo"), "Moved spawn back");
});

test("one object is named, several are counted", () => {
  eq(subjectOf(["Oak Tree"]), "Oak Tree");
  eq(subjectOf(["Oak Tree", "Oak Tree", "Oak Tree"]), "3 × Oak Tree");
  eq(subjectOf(["Oak Tree", "Wall"]), "2 objects");
  eq(subjectOf([]), "");
  eq(subjectOf([undefined, "Wall"]), "Wall"); // a placement that vanished mid-batch
});

/* ── randomised variation ── */

test("variation is a pure function of the stream it is handed", () => {
  const seq = (seed) => { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; };
  const record = { scale: 1, rotationY: 0 };
  const a = varyTransform(record, seq(7));
  const b = varyTransform(record, seq(7));
  eq(JSON.stringify(a), JSON.stringify(b), "same stream, same answer:");
  const c = varyTransform(record, seq(8));
  ok(JSON.stringify(a) !== JSON.stringify(c), "a different stream is a different answer");
});

test("variation stays inside the range a block can actually be built at", () => {
  const record = { scale: 1, rotationY: 0 };
  const hi = () => 1, lo = () => 0; // the two extremes of any stream
  for (const rng of [hi, lo]) {
    const p = varyTransform(record, rng);
    ok(p.scale >= 0.25 && p.scale <= 8, `scale escaped: ${p.scale}`);
    ok(p.rotationY >= 0 && p.rotationY < Math.PI * 2, `rotation escaped: ${p.rotationY}`);
    for (const s of p.stretch) ok(s >= 0.2 && s <= 6, `stretch escaped: ${s}`);
  }
});

test("variation is a nudge, not a rebuild — amount 0 changes nothing but the turn", () => {
  const record = { scale: 2, rotationY: 0, stretch: [1, 1, 1] };
  const p = varyTransform(record, () => 1, { amount: 0 });
  close(p.scale, 2, 1e-6);
  for (const s of p.stretch) close(s, 1, 1e-6);
});

test("something with a front can be varied without being spun round", () => {
  const p = varyTransform({ scale: 1, rotationY: 0.5 }, () => 0.5, { turn: false });
  eq(p.rotationY, undefined);
  ok(p.scale > 0);
});

test("a clamped extreme still stays clamped when applied twice", () => {
  // Repeated variation must not walk a block out of the world one pass at a
  // time — the clamp is on the RESULT, not on the delta.
  let record = { scale: 8, rotationY: 0, stretch: [6, 6, 6] };
  for (let i = 0; i < 8; i++) record = { ...record, ...varyTransform(record, () => 1) };
  ok(record.scale <= 8, `scale drifted to ${record.scale}`);
  for (const s of record.stretch) ok(s <= 6, `stretch drifted to ${s}`);
  // ...and the angle stays inside one revolution instead of accumulating
  // into the record and travelling to Unity as thirty-eight radians.
  ok(record.rotationY >= 0 && record.rotationY < Math.PI * 2, `rotation drifted to ${record.rotationY}`);
});

report("objects");
