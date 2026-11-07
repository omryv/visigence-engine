"""check_vectors.py -- does genesis_seed.py reproduce the JS, bit for bit?

    python3 tools/kernel/py/check_vectors.py [path/to/seed-vectors.json]

Loads tools/test/kernel/vectors/seed-vectors.json (written by tools/kernel/seed-vectors.mjs from
src/kernel/core/seedpath.js), recomputes every value with genesis_seed.py, and
exits 0 only when every one of them matches. Each mismatch is printed with the
entry's path and the field, so a port that is wrong in one place says where.
It also checks that every input the JS refuses is refused here too: two
implementations that agree on every valid path but disagree on what IS a path
will still name different streams the day somebody types the edge case.

It also checks the `placements` rows against genesis_placements.py: the
canonical text first (so a mismatch can be diffed as text) and then the hash,
and that every list the JS refuses in `placementsInvalid` is refused here.

It refuses to pass vacuously. A file that is the wrong format, has fewer
than 12 entries, lacks the terrain/erosion/props channels, records fewer
draws than it says, or has no hash64, invalid, world or placements rows (or
placements rows with no astral uid, no non-ASCII text, or no refusals) is a failure, not
"0 values, all match": a sibling repository that copies this checker next to
its own copy of the JSON gets a floor, not just a comparison.

tests/run.sh runs this whenever python3 is on the PATH and fails the suite on a
non-zero exit. Stdlib only; no install step.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import genesis_seed as gs  # noqa: E402
import genesis_placements as gp  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, "..", "..", "test", "kernel", "vectors", "seed-vectors.json")


def main(argv):
    path = argv[1] if len(argv) > 1 else DEFAULT
    with open(path, encoding="utf-8") as f:
        v = json.load(f)
    bad = []
    checked = 0

    # The floor. Each of these is a structural failure of the FILE, reported
    # like a mismatch so the output says what is missing.
    def need(cond, what):
        if not cond:
            bad.append("vectors file: " + what)
        return cond

    need(v.get("format") == 1, "format is %r, expected 1" % v.get("format"))
    draws = v.get("draws")
    need(isinstance(draws, int) and draws >= 8, "draws is %r, expected an integer >= 8" % draws)
    entries = v.get("entries") or []
    need(len(entries) >= 12, "%d entries, expected at least 12" % len(entries))
    need(len(v.get("hash64") or []) >= 3, "fewer than 3 raw hash64 rows")
    need(len(v.get("invalid") or []) >= 10, "fewer than 10 invalid rows")
    need(len(v.get("world") or []) >= 4, "fewer than 4 world rows")
    placements = v.get("placements") or []
    need(len(placements) >= 4, "fewer than 4 placements rows")
    need(any(any(ord(c) > 0xFFFF for c in p.get("canonical", "")) for p in placements),
         "no placements row with an astral character")
    need(any(any(0x7F < ord(c) <= 0xFFFF for c in p.get("canonical", "")) for p in placements),
         "no placements row with BMP non-ASCII text")
    need(len(v.get("placementsInvalid") or []) >= 3, "fewer than 3 placementsInvalid rows")
    for e in entries:
        need(sorted((e.get("seedChannel") or {}).keys()) == ["erosion", "props", "terrain"],
             "%s: seedChannel keys are not exactly terrain/erosion/props" % e.get("path"))
        for f in ("legacy32", "v2"):
            need(len(e.get(f) or []) == draws, "%s: %s has %d draws, expected %r" % (e.get("path"), f, len(e.get(f) or []), draws))
        need(len(e.get("v2State") or []) == 4, "%s: v2State is not four words" % e.get("path"))
    if bad:
        for b in bad:
            print("  MISMATCH " + b)
        print("check_vectors: the vectors file is malformed (%d problems); nothing was compared" % len(bad))
        return 1

    def same(where, field, got, want):
        nonlocal checked
        checked += 1
        if got != want:
            bad.append("%s %s: python %r, js %r" % (where, field, got, want))

    for e in entries:
        inp = e["input"]
        where = e["path"]
        try:
            p = gs.seed_path(inp["root"], *inp["segments"])
        except Exception as err:  # a refusal here is a mismatch, not a crash
            bad.append("%s: seed_path raised %s" % (where, err))
            continue
        same(where, "path", p, e["path"])
        root, segments = gs.parse_seed_path(p)
        same(where, "root", root, e["root"])
        same(where, "hashSeed", gs.hash_seed(root), e["hashSeed"])
        for ch, want in sorted(e["seedChannel"].items()):
            same(where, "seedChannel." + ch, gs.seed_channel(root, ch), want)
        same(where, "legacy32Seed", gs.seed_channel(root, ":".join(segments)), e["legacy32Seed"])
        lg = gs.stream_for(p, "legacy32")
        same(where, "legacy32", [lg.next_u32() for _ in range(draws)], e["legacy32"])
        same(where, "hash64", gs.hash64_hex(p), e["hash64"])
        same(where, "v2State", gs.v2_state(gs.hash64(p)), e["v2State"])
        v2 = gs.stream_for(p)
        same(where, "v2", [v2.next_u32() for _ in range(draws)], e["v2"])

    for h in v["hash64"]:
        same("hash64(%r)" % h["input"], "hex", gs.hash64_hex(h["input"]), h["hex"])

    for inv in v["invalid"]:
        checked += 1
        try:
            got = gs.seed_path(inv["root"], *inv["segments"])
        except (gs.SeedPathError, TypeError):
            continue
        except Exception as err:  # refused, but not the way a caller can catch
            bad.append("invalid %r: python raised %s (%s), not SeedPathError" % (inv, type(err).__name__, err))
            continue
        bad.append("invalid %r: python accepted it as %r, js refuses it" % (inv, got))

    for w in v["world"]:
        try:
            got = gs.world_seed_path(w["typed"], *w["segments"])
        except Exception as err:
            bad.append("world %r: world_seed_path raised %s" % (w["typed"], err))
            continue
        same("world(%r)" % w["typed"], "path", got, w["path"])

    for i, p in enumerate(v["placements"]):
        where = "placements[%d]" % i
        try:
            text = gp.canonical_placements(p["records"])
            h = gp.placements_hash(p["records"])
        except Exception as err:
            bad.append("%s: python raised %s (%s)" % (where, type(err).__name__, err))
            continue
        same(where, "canonical", text, p["canonical"])
        same(where, "hash", h, p["hash"])

    for i, p in enumerate(v["placementsInvalid"]):
        checked += 1
        try:
            got = gp.placements_hash(p["records"])
        except (TypeError, ValueError):
            continue
        bad.append("placementsInvalid[%d]: python accepted it as %r, js refuses it" % (i, got))

    if bad:
        for b in bad:
            print("  MISMATCH " + b)
        print("check_vectors: %d of %d values differ from the JS" % (len(bad), checked))
        return 1
    print("check_vectors: %d entries, %d values, all match the JS" % (len(entries), checked))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
