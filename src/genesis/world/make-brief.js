/* make-brief.js — what a person typed, and which place that is.
 *
 * The machine page's input is a BRIEF, and the honest thing to say about it is
 * what it is not: it is not parsed, not sent anywhere (nothing on this origin
 * is), and not understood by anything cleverer than a phrase table. What it
 * does is deterministic, and there are now four parts to it:
 *
 *   1. CHOOSE THE GRAMMAR. Island words make the island, coastal and village
 *      words make the coast. A brief that names neither is assigned by its own
 *      hash — stable, so the same undecided words always land in the same
 *      world.
 *
 *   2. READ THE DRESSING. Time of day, weather, fog, the size of the
 *      settlement and the age of its buildings are all things the engine
 *      already controls, and all things a person names in passing while
 *      describing a place. "an old town in the rain" is four separate
 *      instructions to this engine and used to be one seed.
 *
 *   3. SEED THE GENERATOR. The whole text — every word of it, including the
 *      ones read above — goes through the engine's own normalizer, so
 *      "a fishing village on a cold coast" is a seed exactly the way
 *      "K7QN-3F2A-9XBD" is. SAME WORDS, SAME PLACE, and that is the truthful
 *      version of "it understood me".
 *
 *   4. SAY WHAT IS NOT THERE. Some nouns a person will certainly type name
 *      things this repository HAS — a castle court, a ruined hamlet, a city —
 *      and has not wired into a world grammar. Those are recorded rather than
 *      silently swallowed, so the page can admit it and the backlog lives in
 *      code instead of in somebody's head. See UNWIRED.
 *
 * ── WHY A PHRASE TABLE AND NOT A KEYWORD LIST ────────────────────────────
 * People do not type labels. They type "a little village by the sea at
 * sunset", and every dimension in that sentence is carried by a phrase rather
 * than a word: "by the sea", "a little", "at sunset". A keyword list gets
 * three of those wrong. So entries are PHRASES, matched whole, and the longest
 * match in a dimension wins — which is the only reason "late at night" can
 * mean something different from "at night".
 *
 * ── AND WHY MATCHING IS ON WORD BOUNDARIES ───────────────────────────────
 * Because `"terrain".includes("rain")` is true, and a substring match would
 * make every brief that says "terrain" rain. Everything here is normalised to
 * a space-padded string and matched with its own padding — " rain " is not in
 * " terrain " — which costs one concatenation and removes the entire class.
 *
 * Pure JS, no DOM. tests/make.test.js holds all of it still, including the
 * seven phrases this vocabulary was written against.
 *
 * ── SUPERSEDED, AND KEPT ─────────────────────────────────────────────────
 * The author interface (js/author.js, schema/intent.schema.json, and its two
 * doors bin/genesis.mjs and bin/genesis-mcp.mjs) is how a world is asked for
 * now: statements about the ground — a summit HERE, a road no steeper than
 * THIS — that the solver makes true, each reported back with what it missed
 * by. A phrase table can only pick among things it already has. This file
 * stays because make.html's typed brief still runs through it; new ways of
 * asking for a world belong in the intent vocabulary, not in VOCABULARY.
 */

import { normalizeSeed, randomSeed, seedChannel, mulberry32, hashSeed } from "../../kernel/seed.js";

/* Lowercase, punctuation to spaces, runs collapsed, and PADDED — the padding
   is what makes `includes` a word-boundary match without a regexp per phrase.
   Applied to the brief and to every phrase in the table below, so a phrase can
   be written the way a person would write it ("it's raining") and still match
   after the apostrophe has become a space. */
export function normalise(text) {
  return ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/* ══ THE VOCABULARY ═══════════════════════════════════════════════════════
   One flat table so that resolution is one pass and one rule. Each entry is:

     dim    which control it sets — every one of these already existed
     set    the value it sets it to
     say    what to call it when the page reports what it read
     words  every natural way someone might say it

   THE TEST FOR ADMITTING A PHRASE, stated so the next person applies the same
   one: would somebody type this while imagining a world, and does it map
   cleanly onto something this engine already does? If yes, it belongs here,
   and the cost of adding it is one line. Generosity is cheap; a phrase that
   maps onto nothing is not generosity, it is a promise (see UNWIRED).

   RESOLUTION, and it is deliberately boring: within a dimension the LONGEST
   matching phrase wins, ties break to the earliest position in the brief, and
   remaining ties to the order below. Longest-first is what makes "late at
   night" beat "at night" and "thick fog" beat "fog" without an ordering
   anybody has to maintain by hand. Contradictory briefs ("a sunny day in the
   rain") resolve by the same rule rather than by a preference: they are rare,
   and a deterministic answer beats a clever one. */
export const VOCABULARY = [
  /* ── the grammar ─────────────────────────────────────────────────────
     Island words first, and the reason is unchanged: the rarer, more
     deliberate word beats the commoner one, so "an island off the village
     coast" is the island. Both lists are far longer than the two words that
     used to be here, because "by the sea" is how people say coast. */
  { dim: "world", set: "lonepalm", say: "Lonepalm", words: [
    "island", "islands", "islet", "isle", "small island", "tiny island",
    "little island", "lonely island", "lone island", "desert island",
    "deserted island", "uninhabited island", "empty island", "sand island",
    "atoll", "lagoon", "reef", "coral", "coral reef",
    "palm", "palms", "palm tree", "palm trees",
    "castaway", "marooned", "shipwrecked", "sandbar", "sand spit", "sandbank",
    "tropical", "the tropics", "paradise",
    "out at sea", "middle of the ocean", "middle of the sea",
    "alone in the ocean", "alone in the sea", "surrounded by water",
    "nothing but ocean", "nothing but sea", "in the middle of nowhere",
  ] },
  { dim: "world", set: "farshore", say: "Farshore", words: [
    "coast", "the coast", "coastal", "coastline", "cold coast", "rocky coast",
    "by the sea", "by the ocean", "on the sea", "beside the sea",
    "next to the sea", "on the water", "seaside", "sea", "ocean",
    "shore", "on the shore", "shoreline", "beach", "on the beach",
    "bay", "cove", "inlet", "estuary", "fjord",
    "harbour", "harbor", "port", "dock", "docks", "quay", "jetty", "pier",
    "fishing", "fishing village", "fisherman", "fishermen", "trawler", "boats",
    "village", "little village", "small village", "old village",
    "town", "small town", "little town", "old town", "hamlet", "settlement",
    "houses", "cottages", "cottage", "homestead", "homes",
    "farm", "farms", "farming", "farmland", "fields", "crops",
    "north", "northern", "up north", "nordic", "scandinavian",
    "study", "research", "research station", "field station",
  ] },

  /* ── the hour ────────────────────────────────────────────────────────
     `sky.timeOfDay`, which is a slider in the editor and was fixed per
     grammar here. Every value is a real hour rather than a mood name, so the
     sun is genuinely where the words say it is.

     THE EVENING VALUES ARE MEASURED, NOT PICKED, and the first draft of this
     table had all four of them wrong in the same way. engine/sky/Sky.js puts
     the sun at `el = sin(π(t−6)/12)` and saturates its night term at
     el ≤ −0.22, which is t ≥ 18.85 — so 19.5, 20.4, 21.2 and 22.2 are not
     four times of night, they are the SAME fully dark sky four times over.
     Photographed side by side they were indistinguishable. What actually
     separates an evening from a sunset from a dusk is the last forty minutes
     before that cutoff:

        t     sun intensity   warmth      reads as
        17.8      2.74          0.83      evening, golden, fully lit
        18.3      1.57          0.75      sunset, half lit, strongly warm
        18.7      0.45          0.42      dusk, nearly dark, warm rim
        19.0+     0.04          0.00      night, and no darker at 22 or at 3

     Night keeps 22.2 because the value is also a NUMBER a person may see, and
     "night" reading 19.0 in the editor's clock would be wrong about the world
     even though it is right about the pixels. */
  { dim: "hour", set: 0.7, say: "the small hours", words: [
    "late at night", "late night", "very late", "dead of night",
    "middle of the night", "midnight", "at midnight", "past midnight",
    "small hours", "the witching hour", "3am", "2am", "1am",
  ] },
  { dim: "hour", set: 4.6, say: "before dawn", words: [
    "before dawn", "just before dawn", "predawn", "pre dawn",
    "early hours", "small light", "before sunrise", "before the sun",
  ] },
  { dim: "hour", set: 6.3, say: "dawn", words: [
    "dawn", "at dawn", "sunrise", "at sunrise", "first light", "daybreak",
    "break of day", "as the sun rises", "sun coming up", "crack of dawn",
  ] },
  { dim: "hour", set: 7.6, say: "early morning", words: [
    "early morning", "in the early morning", "early in the morning",
    "just after dawn", "first thing", "first thing in the morning",
  ] },
  { dim: "hour", set: 9.6, say: "morning", words: [
    "morning", "in the morning", "mid morning", "midmorning", "late morning",
    "a morning", "one morning",
  ] },
  { dim: "hour", set: 12.4, say: "midday", words: [
    "midday", "noon", "at noon", "high noon", "middle of the day", "at midday",
    "lunchtime", "the middle of the day",
  ] },
  { dim: "hour", set: 14.6, say: "afternoon", words: [
    "afternoon", "in the afternoon", "early afternoon", "one afternoon",
  ] },
  { dim: "hour", set: 16.6, say: "late afternoon", words: [
    "late afternoon", "late in the afternoon", "end of the afternoon",
  ] },
  { dim: "hour", set: 17.8, say: "evening", words: [
    "evening", "in the evening", "early evening", "one evening",
    "end of the day",
  ] },
  { dim: "hour", set: 18.3, say: "sunset", words: [
    "sunset", "at sunset", "sundown", "at sundown", "setting sun",
    "as the sun sets", "golden hour", "the golden hour", "sunset light",
    "red sky",
  ] },
  { dim: "hour", set: 18.7, say: "dusk", words: [
    "dusk", "at dusk", "twilight", "at twilight", "nightfall", "at nightfall",
    "last light", "as night falls", "as it gets dark", "getting dark",
  ] },
  { dim: "hour", set: 22.2, say: "night", words: [
    "night", "at night", "by night", "night time", "nighttime", "a night",
    "after dark", "in the dark", "in the darkness", "dark",
    "under the moon", "under the moonlight", "in the moonlight", "moonlight",
    "moonlit", "by moonlight", "under the stars", "starlit", "starry",
    "starry night", "nocturnal", "at night time",
  ] },

  /* ── the weather ─────────────────────────────────────────────────────
     "clear" | "rain" | "snow", which is exactly what engine.setWeather takes
     and exactly what the editor's three pills set. Rain wets every material
     and snow settles on upward faces, so these are surface changes and not
     just particles. */
  { dim: "weather", set: "rain", say: "rain", words: [
    "rain", "raining", "it s raining", "rainy", "rainy day", "in the rain",
    "under the rain", "pouring", "pouring rain", "downpour", "drizzle",
    "drizzling", "wet", "soaking wet", "rain soaked", "soaked",
    "storm", "stormy", "thunderstorm", "rainstorm", "showers", "wet weather",
    "grey and wet", "miserable weather", "bad weather", "in a storm",
  ] },
  { dim: "weather", set: "snow", say: "snow", words: [
    "snow", "snowy", "snowing", "it s snowing", "in the snow",
    "covered in snow", "snow covered", "under snow", "under the snow",
    "deep snow", "blizzard", "snowfall", "white with snow", "snowbound",
    "winter", "in winter", "wintry", "midwinter", "frozen", "icy", "ice",
    "arctic", "freezing",
  ] },
  { dim: "weather", set: "clear", say: "clear", words: [
    "clear sky", "clear skies", "clear", "sunny", "sunny day", "sunshine",
    "in the sun", "bright", "bright day", "cloudless", "blue sky",
    "blue skies", "fine day", "lovely day", "beautiful day", "dry",
    "good weather", "not a cloud",
  ] },

  /* ── the air ─────────────────────────────────────────────────────────
     `fog.density`, which every grammar sets low (0.08–0.09) because both of
     them are having a clear day. It is a separate dimension from weather on
     purpose: fog is not rain, and "a foggy morning" is a thing people say
     about a day with no weather in it at all. */
  { dim: "haze", set: 0.40, say: "thick fog", words: [
    "thick fog", "heavy fog", "dense fog", "thick mist", "deep fog",
    "blanket of fog", "pea soup", "lost in fog", "cannot see",
  ] },
  { dim: "haze", set: 0.26, say: "fog", words: [
    "fog", "foggy", "in the fog", "fogbound", "mist", "misty", "in the mist",
    "hazy", "haze", "murky", "shrouded", "smoky", "low cloud", "gloomy",
    "overcast",
  ] },
  { dim: "haze", set: 0.045, say: "clear air", words: [
    "clear air", "crisp", "crisp air", "sharp air", "thin air",
    "crystal clear", "you can see for miles", "see for miles",
  ] },

  /* ── the size ────────────────────────────────────────────────────────
     A site recipe's `size`, which is a count of houses: shore-village is 3 /
     5 / 8 for small / medium / large. This is the one dimension where the
     words people use are already the engine's own vocabulary — "a little
     village" is small, and it always was; nothing was listening. */
  { dim: "size", set: "small", say: "small", words: [
    "little", "a little", "small", "tiny", "wee", "one house", "a few houses",
    "handful", "handful of houses", "a handful", "just a few", "quiet",
    "sleepy", "modest", "hamlet", "couple of houses", "barely a village",
  ] },
  { dim: "size", set: "large", say: "large", words: [
    "big", "large", "great", "sprawling", "busy", "bustling", "crowded",
    "sizeable", "proper town", "big town", "large town", "growing",
    "lots of houses", "many houses", "full of people",
  ] },

  /* ── the age and dress ───────────────────────────────────────────────
     `structure.theme`, which re-dresses every builder block's materials —
     15 of these exist and each grammar names one. Only the three that a
     person actually reaches for in a sentence about a place are wired: an
     OLD village is a real request and `weathered` is a real answer to it.
     The other twelve are the editor's, and adding one here means finding the
     words somebody would type for it, which for "parade" or "mmorpg" is not
     an obvious sentence. */
  { dim: "theme", set: "weathered", say: "old", words: [
    "old", "an old", "ancient", "abandoned", "long abandoned", "derelict",
    "ruined", "half ruined", "ruins", "in ruins", "crumbling", "forgotten",
    "overgrown", "worn", "faded", "neglected", "run down", "rundown",
    "weathered", "decaying", "falling apart", "past its best", "tumbledown",
  ] },
  { dim: "theme", set: "frost", say: "frozen", words: [
    "frozen", "icy", "arctic", "frosty", "frostbitten", "snowbound",
    "deep winter", "midwinter", "frozen over",
  ] },
  { dim: "theme", set: "storybook", say: "storybook", words: [
    "storybook", "fairytale", "fairy tale", "like a fairy tale", "whimsical",
    "cosy", "cozy", "picture book", "toy town", "make believe", "charming",
  ] },
];

/* ══ WHAT THIS ENGINE HAS AND HAS NOT WIRED ═══════════════════════════════
   Every noun below is one somebody will type on their first try, and every
   one of them names something that EXISTS in this repository and is not
   reachable from a brief, because no world grammar places it. A castle court,
   a citadel, a ruined hamlet, a city and a maze are all complete site recipes
   in js/worldplan.js; what is missing is the twenty lines of grammar in
   js/worlds.js that would stand one on a mount and run a road to it.

   RECORDED RATHER THAN IGNORED, and that is the whole point of this table:
   the brief still builds something (the words fall through to a grammar and a
   seed, and the dressing above still applies, so "an abandoned village" is at
   least an old-looking village), but the page can say what it could not do
   instead of quietly handing over a fishing village and hoping.

   `wanted` names the site recipe that would serve it, or null where the gap
   is terrain rather than a settlement — a valley or a desert needs a grammar
   with different terrain sliders, not a recipe. tests/make.test.js checks
   that every non-null `wanted` is a recipe that really exists, so this table
   cannot rot into a list of things that were never true. */
export const UNWIRED = [
  { wanted: "castle-court", say: "a castle", words: [
    "castle", "a castle", "fortress", "keep", "citadel", "stronghold",
    "fort", "palace", "castle on a hill", "castle by the sea", "battlements",
    "walled town",
  ] },
  { wanted: "city", say: "a city", words: [
    "city", "a city", "big city", "metropolis", "capital", "skyline",
  ] },
  { wanted: "ruined-hamlet", say: "ruins", words: [
    "ruins", "in ruins", "ruined village", "ruined town", "abandoned town",
    "abandoned village", "ghost town", "nothing left", "what is left of",
  ] },
  { wanted: "market-hamlet", say: "a market", words: [
    "market", "market town", "market square", "marketplace", "trading",
  ] },
  { wanted: "trading-outpost", say: "an outpost", words: [
    "outpost", "trading post", "waystation", "way station", "staging post",
  ] },
  { wanted: "maze", say: "a maze", words: ["maze", "labyrinth"] },
  { wanted: "old-town", say: "a proper old town", words: [
    "old town", "old quarter", "the old city",
  ] },
  /* Terrain rather than settlement: these need a grammar of their own, with
     its own sliders and its own landform ops. There is no recipe to point at,
     and saying so is more use than pointing at the nearest one. */
  { wanted: null, say: "that landscape", words: [
    "valley", "green valley", "mountains", "mountain", "in the mountains",
    "desert", "dunes", "forest", "woods", "in the woods", "jungle",
    "swamp", "marsh", "lake", "by a lake", "river", "by a river",
    "canyon", "cliffs", "moor", "moors", "tundra", "steppe", "plains",
    "volcano", "volcanic",
  ] },
];

/* Words that do not name a world this engine has, but do say the place is on
   LAND. They decide the grammar only when nothing above did, and they exist
   for one reason: "a castle on a hill" has no grammar, and a coin-flip that
   lands it in two kilometres of open ocean half the time is a worse answer
   than a coast. A weak preference, stated once, rather than a special case
   buried in the resolver. */
const LANDWARD = [
  "hill", "on a hill", "hilltop", "hillside", "hills", "high ground",
  "cliff", "cliffs", "ridge", "valley", "green valley", "meadow", "grass",
  "grassland", "countryside", "in the country", "inland", "forest", "woods",
  "trees", "mountains", "mountain", "moor", "moors", "field", "fields",
  "castle", "fortress", "keep", "citadel", "city", "town", "market", "ruins",
];

/* TWO RULES, AND THEY DIFFER ON PURPOSE.

   THE DRESSING resolves by LONGEST MATCH: more words is more specific, which
   is what makes "late at night" mean something other than "at night" and
   "thick fog" something other than "fog". Function below.

   THE GRAMMAR resolves by TABLE ORDER: the rarer, more deliberate noun wins,
   so "an island off the village coast" is the island. Length is exactly the
   wrong measure there — "village" is a longer string than "island" and a
   weaker claim on the sentence — and this rule predates the vocabulary; see
   worldFromTable. */

/* Returns the winning entry per dimension, or nothing for a dimension the
   brief never named — an unnamed dimension must fall through to the grammar's
   own value rather than to a default, or every brief would quietly reset the
   world's own weather to clear. */
function readDimensions(padded, table) {
  const best = new Map();
  for (const entry of table) {
    for (const word of entry.words) {
      const needle = normalise(word);
      const at = padded.indexOf(needle);
      if (at < 0) continue;
      const found = { entry, length: needle.length, at, word };
      const prev = best.get(entry.dim);
      if (!prev || found.length > prev.length
        || (found.length === prev.length && found.at < prev.at)) {
        best.set(entry.dim, found);
      }
    }
  }
  return best;
}

/* The first world entry with any match at all, in table order. */
function worldFromTable(padded) {
  for (const entry of VOCABULARY) {
    if (entry.dim !== "world") continue;
    if (entry.words.some((w) => padded.includes(normalise(w)))) return entry.set;
  }
  return null;
}

/** Everything the words say, before any of it is turned into params.
 *
 *  Returns `{ world, dress, reading, unmet }`:
 *    world    the grammar id the words name, or null if they name none
 *    dress    ONLY the dimensions the brief actually named
 *    reading  short labels for what was understood, for the page to show
 *    unmet    entries from UNWIRED the brief asked for and cannot have
 */
export function readBrief(text) {
  const padded = normalise(text);
  const hits = readDimensions(padded, VOCABULARY.filter((e) => e.dim !== "world"));

  const dress = {};
  const reading = [];
  for (const dim of ["hour", "weather", "haze", "size", "theme"]) {
    const hit = hits.get(dim);
    if (!hit) continue;
    dress[dim] = hit.entry.set;
    reading.push(hit.entry.say);
  }

  let world = worldFromTable(padded);
  if (!world && LANDWARD.some((w) => padded.includes(normalise(w)))) world = "farshore";

  const unmet = [];
  for (const gap of UNWIRED) {
    const word = gap.words.find((w) => padded.includes(normalise(w)));
    if (word) unmet.push({ say: gap.say, wanted: gap.wanted, word });
  }

  return { world, dress, reading, unmet };
}

/** Which grammar the words name, or a stable hash pick when they name none.
    The hash pick is what makes an undecided brief still land somewhere, and
    always the same somewhere. */
export function worldForBrief(text, ids = ["lonepalm", "farshore"]) {
  const named = readBrief(text).world;
  if (named && ids.includes(named)) return named;
  return ids[hashSeed(normalise(text).trim() || "somewhere") % ids.length];
}

/** Roll `n` of a brief's seed. Roll 0 IS the words — normalizeSeed of the text
    ITSELF, every word of it, including the ones the vocabulary read. That is
    deliberate and it is the whole "same words, same place" promise: "a village
    at night" and "a village" are different briefs and must be different
    ground, or the seed would depend on which words this table happens to know
    this month. Every later roll is drawn from a stream keyed on the text and
    the roll, so "another one" is reproducible too. */
export function seedForBrief(text, roll = 0) {
  const t = String(text || "").trim();
  if (roll === 0) {
    const s = normalizeSeed(t);
    if (s) return s;
  }
  return randomSeed(mulberry32(seedChannel(t.toLowerCase() || "somewhere", "brief-roll:" + roll)));
}

/** The whole plan for one press: which world, on which seed, wearing what. */
export function briefToPlan(text, { roll = 0, ids = undefined } = {}) {
  const read = readBrief(text);
  return {
    id: worldForBrief(text, ids),
    seed: seedForBrief(text, roll),
    brief: String(text || "").trim(),
    roll,
    dress: read.dress,
    reading: read.reading,
    unmet: read.unmet,
  };
}
