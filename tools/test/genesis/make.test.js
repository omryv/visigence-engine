/* The machine's claims, held still.
 *
 * The /make page's input is not parsed and not sent anywhere. It chooses a
 * grammar by phrase table, reads a handful of dimensions the engine already
 * controls off the same table, and seeds the generator with its own text. All
 * of it is deterministic, and this suite is what keeps the claims printed
 * under the input from quietly becoming false.
 *
 * Three of these are structural rather than behavioural, and they are the ones
 * that will earn their keep: a hand-maintained vocabulary of several hundred
 * phrases is exactly the kind of table that grows a duplicate, a value the
 * engine does not accept, or an apology for something that was never missing —
 * and none of those throws.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import {
  briefToPlan, worldForBrief, seedForBrief, readBrief, normalise,
  VOCABULARY, UNWIRED,
} from "../../../src/genesis/world/make-brief.js";
import { WORLD_IDS } from "../../../src/genesis/world/worlds.js";
import { SITE_KINDS } from "../../../src/genesis/world/worldplan.js";
import { THEMES } from "../../../src/genesis/props/themes.js";
import { normalizeSeed } from "../../../src/kernel/seed.js";

const worldEntries = VOCABULARY.filter((e) => e.dim === "world");

/* ── the table is well formed ── */

test("every world entry names a world that exists", () => {
  for (const e of worldEntries) {
    ok(WORLD_IDS.includes(e.set), `${e.set} is in the vocabulary and not in js/worlds.js`);
  }
  eq(worldEntries.length, WORLD_IDS.length, "a grammar has no words, or a word has no grammar:");
});

test("every value the vocabulary sets is one the engine accepts", () => {
  for (const e of VOCABULARY) {
    ok(e.say && e.words.length, `${e.dim}:${e.set} has no words or no name`);
    if (e.dim === "weather") ok(["clear", "rain", "snow"].includes(e.set), `weather ${e.set}`);
    if (e.dim === "theme") ok(THEMES[e.set], `theme ${e.set} is not in engine/props/themes.js`);
    if (e.dim === "size") ok(["small", "medium", "large"].includes(e.set), `size ${e.set}`);
    if (e.dim === "hour") ok(e.set >= 0 && e.set < 24, `hour ${e.set} is not an hour`);
    if (e.dim === "haze") ok(e.set >= 0 && e.set <= 1, `haze ${e.set} is not a density`);
  }
});

test("no phrase means two things in the same dimension", () => {
  /* A phrase in two entries of one dimension is an ambiguity the resolver
     settles by length or by order — silently, and differently depending on
     what else is in the sentence. ACROSS dimensions it is fine and often the
     point: "frozen" is both snow and a way of dressing a building. */
  const seen = new Map();
  for (const e of VOCABULARY) {
    for (const w of e.words) {
      const key = `${e.dim} ${normalise(w)}`;
      const prev = seen.get(key);
      ok(!prev, `"${w}" is in ${e.dim}:${prev} and ${e.dim}:${e.set}`);
      seen.set(key, e.set);
    }
  }
});

test("everything the vocabulary cannot serve names something real, or nothing at all", () => {
  /* UNWIRED is the backlog, in code. A `wanted` that names a recipe must name
     one that exists — otherwise the page is apologising for the absence of
     something that was never there. */
  for (const gap of UNWIRED) {
    ok(gap.words.length && gap.say, "an unwired entry with no words");
    if (gap.wanted !== null) {
      ok(SITE_KINDS[gap.wanted], `${gap.wanted} is claimed as unwired and is not a recipe`);
    }
  }
});

/* ── the read ── */

test("island words make the island, coastal and village words the coast", () => {
  eq(worldForBrief("a lonely palm island in a lagoon"), "lonepalm");
  eq(worldForBrief("a fishing village on a cold coast"), "farshore");
  eq(worldForBrief("a little village by the sea"), "farshore");
  eq(worldForBrief("a tiny island"), "lonepalm");
  // the rarer, more deliberate word wins when both appear — by TABLE ORDER,
  // because "village" is the longer string and the weaker claim on the sentence
  eq(worldForBrief("an island off the village coast"), "lonepalm");
  eq(worldForBrief("AN ISLAND"), "lonepalm", "case must not matter");
  eq(worldForBrief("  a   village,  by the sea!  "), "farshore", "punctuation must not matter");
});

test("words that name no world land somewhere, and always the same somewhere", () => {
  const a = worldForBrief("the ineffable");
  ok(WORLD_IDS.includes(a), "the hash pick is a real grammar");
  eq(worldForBrief("the ineffable"), a, "the undecided brief is stable");
});

test("a place on land does not land in the middle of the ocean", () => {
  /* None of these has a grammar, and a coin flip would put half of them two
     kilometres out to sea. A weak landward preference is the honest answer
     until the grammar exists. */
  for (const brief of ["a castle on a hill", "a fortress in the mountains",
                       "a green valley", "an old market town", "a city"]) {
    eq(worldForBrief(brief), "farshore", `${brief}:`);
  }
});

test("the seven phrases this vocabulary was written against", () => {
  const read = (t) => {
    const p = briefToPlan(t);
    return JSON.stringify({ id: p.id, ...p.dress });
  };
  eq(read("a little village by the sea"),
     JSON.stringify({ id: "farshore", size: "small" }));
  eq(read("an old town in the rain"),
     JSON.stringify({ id: "farshore", weather: "rain", theme: "weathered" }));
  eq(read("a lonely island at sunset"),
     JSON.stringify({ id: "lonepalm", hour: 18.3 }));
  eq(read("a snowy fortress at night"),
     JSON.stringify({ id: "farshore", hour: 22.2, weather: "snow" }));
  eq(read("an abandoned village"),
     JSON.stringify({ id: "farshore", theme: "weathered" }));
  eq(read("a cold rocky coast"), JSON.stringify({ id: "farshore" }));
  eq(read("a castle on a hill"), JSON.stringify({ id: "farshore" }));
});

test("a castle, a city and a ruin are admitted to rather than swallowed", () => {
  const missing = (t) => briefToPlan(t).unmet.map((u) => u.wanted);
  ok(missing("a castle on a hill").includes("castle-court"), "the castle went unreported");
  ok(missing("a big city").includes("city"), "the city went unreported");
  ok(missing("a ruined village").includes("ruined-hamlet"), "the ruins went unreported");
  eq(briefToPlan("a little village by the sea").unmet.length, 0,
     "a brief this engine can serve must not apologise:");
});

test("the longest phrase wins, which is the only reason phrases are worth having", () => {
  const hour = (t) => briefToPlan(t).dress.hour;
  ok(hour("a village at night") !== hour("a village late at night"),
     "late at night is the same as at night");
  eq(hour("a village at night"), 22.2);
  eq(hour("a village late at night"), 0.7);
  eq(hour("a village at sunset"), 18.3);
  eq(hour("a village at dawn"), 6.3);
  const haze = (t) => briefToPlan(t).dress.haze;
  ok(haze("a village in thick fog") > haze("a village in fog"),
     "thick fog is no thicker than fog");
});

test("a word inside a word is not a word", () => {
  /* The one that would have shipped: "terrain" contains "rain", and a
     substring match rains on every brief that mentions the ground. */
  eq(briefToPlan("a terrain of rolling hills").dress.weather, undefined,
     "terrain read as rain:");
  eq(briefToPlan("in the rain").dress.weather, "rain", "…but rain is still rain");
  eq(briefToPlan("it's raining").dress.weather, "rain", "…and an apostrophe is not a wall");
});

test("a dimension the words never named stays the grammar's own", () => {
  /* The whole reason `dress` carries only what was said: an absent key falls
     through to the world's own value in paramsFor. A dress that defaulted its
     dimensions would reset every world to a clear noon. */
  const bare = briefToPlan("a fishing village on a cold coast").dress;
  eq(Object.keys(bare).length, 0, "a plain brief dressed the world anyway:");
  eq(Object.keys(briefToPlan("a fishing village in the rain").dress).join(","), "weather");
});

test("what it read is what it says it read", () => {
  const p = briefToPlan("a little old village by the sea at dusk in the snow");
  eq(p.reading.join(" · "), "dusk · snow · small · old");
  eq(p.dress.hour, 18.7);
  eq(p.dress.weather, "snow");
  eq(p.dress.size, "small");
  eq(p.dress.theme, "weathered");
});

/* ── the seed ── */

test("same words, same place — the brief IS the seed", () => {
  const p1 = briefToPlan("a fishing village on a cold coast");
  const p2 = briefToPlan("a fishing village on a cold coast");
  eq(p1.id, p2.id);
  eq(p1.seed, p2.seed);
  eq(p1.seed, normalizeSeed("a fishing village on a cold coast"),
    "roll 0 is the words themselves, through the engine's own normalizer");
});

test("the words the vocabulary read are still part of the seed", () => {
  /* Deliberate: if the dressing words were stripped before seeding, the ground
     under "a village" and "a village at night" would be identical, and which
     words counted would depend on what this table happened to know that
     month. */
  ok(briefToPlan("a village").seed !== briefToPlan("a village at night").seed,
    "two different briefs came out as one place");
});

test("another one is another one, and reproducibly so", () => {
  const rolls = [0, 1, 2, 3].map((r) => seedForBrief("a fishing village", r));
  eq(new Set(rolls).size, 4, "four rolls, four seeds");
  eq(seedForBrief("a fishing village", 2), rolls[2], "roll n is the same seed every time");
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(rolls[3]), "a rolled seed is a well-formed seed");
});

test("an empty brief still makes a place", () => {
  const p = briefToPlan("");
  ok(WORLD_IDS.includes(p.id));
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(p.seed), "no words is a draw, not a crash");
  eq(Object.keys(p.dress).length, 0);
  eq(readBrief("").unmet.length, 0);
});

report("make");
