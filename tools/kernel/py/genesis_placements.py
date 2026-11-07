"""genesis_placements.py -- placementsHash, in Python, stdlib only.

A port of canonicalPlacements and placementsHash from
src/kernel/terrain/fingerprint.js: the canonical text of a list of placement
records (what stands on the ground), and the 32-bit FNV-1a hash of that text.
A Python pipeline that writes placements -- Blender's, in the sibling
repositories -- computes the SAME number the engine's fingerprint prints for
the same records, so "the same world, furnished the same way" can be checked
across the language boundary.

It is right exactly when tools/kernel/py/check_vectors.py passes against the
`placements` rows of tools/test/kernel/vectors/seed-vectors.json, which
tools/kernel/seed-vectors.mjs writes from the JS. The JS is the reference. Every rule
is spelled out in the comment above PLACEMENT_QUANTUM in fingerprint.js; the
ones Python gets wrong by default, and this file therefore does on purpose:

  * Sort by UTF-16 CODE UNIT, not by code point. sorted() over str compares
    code points, which orders an astral character before U+E000-U+FFFF where
    JavaScript orders it after. _cu() is the UTF-16-BE encoding, whose byte
    order is the code-unit order.
  * Write strings with json.dumps(ensure_ascii=False). The default escapes
    every non-ASCII character; JSON.stringify writes them as themselves. The
    remaining escapes (control characters, quote, backslash) agree.
  * Round with floor-and-compare, ties toward +infinity, as Math.round does --
    not round(), which ties to even -- over the DOUBLE v * 10000.
  * Hash the UTF-16-LE bytes of the text (each code unit's low byte, then its
    high byte), not its UTF-8.

What the JS refuses, this refuses too, with TypeError or ValueError: a
non-string uid, a lone surrogate in any string, a count of quanta past
2**53 - 1, and any value that is not None, bool, int, float, str, list/tuple
or dict.
"""
import json
import math

QUANTA_PER_UNIT = 10000.0
MAX_SAFE = 9007199254740991
_FNV_OFFSET = 0x811C9DC5
_FNV_PRIME = 0x01000193


def _cu(s):
    """The code-unit sort key (and a well-formedness check: a lone surrogate
    cannot be encoded strictly, which is the refusal the JS makes)."""
    try:
        return s.encode("utf-16-be")
    except UnicodeEncodeError:
        raise TypeError("placementsHash: a string holds a lone surrogate")


def _string(s):
    _cu(s)
    return json.dumps(s, ensure_ascii=False)


def _number(v):
    if not math.isfinite(v):
        return "null"
    x = float(v) * QUANTA_PER_UNIT
    f = math.floor(x)
    q = f + (1 if x - f >= 0.5 else 0)
    if abs(q) > MAX_SAFE:
        raise ValueError("placementsHash: %r is past the exact range of the quantized form" % v)
    return str(int(q))  # int(-0.0) is 0: minus zero is written as 0


def canonical_value(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _number(v)
    if isinstance(v, str):
        return _string(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_value(x) for x in v) + "]"
    if isinstance(v, dict):
        for k in v:
            if not isinstance(k, str):
                raise TypeError("placementsHash: a key is a %s, not a string" % type(k).__name__)
        keys = sorted(v.keys(), key=_cu)
        return "{" + ",".join(_string(k) + ":" + canonical_value(v[k]) for k in keys) + "}"
    raise TypeError("placementsHash: a %s has no JSON form" % type(v).__name__)


def canonical_placements(records):
    if not isinstance(records, (list, tuple)):
        raise TypeError("canonicalPlacements: records must be a list")
    rows = []
    for i, r in enumerate(records):
        uid = r.get("uid") if isinstance(r, dict) else None
        if uid is not None and not isinstance(uid, str):
            raise TypeError("canonicalPlacements: record %d has a %s uid -- a uid is a string" % (i, type(uid).__name__))
        text = canonical_value(r)
        rows.append((_cu(uid or ""), _cu(text), text))
    rows.sort(key=lambda row: (row[0], row[1]))
    return "[" + ",".join(row[2] for row in rows) + "]"


def hash_string(s):
    """fingerprint.js hashString: FNV-1a 32-bit over the UTF-16-LE bytes."""
    h = _FNV_OFFSET
    for b in s.encode("utf-16-le", "surrogatepass"):
        h = ((h ^ b) * _FNV_PRIME) & 0xFFFFFFFF
    return h


def placements_hash(records):
    """None for None ("no placements were given"), else the hash of the
    canonical text -- so [] hashes to hash_string("[]"), not None."""
    if records is None:
        return None
    return hash_string(canonical_placements(records))
