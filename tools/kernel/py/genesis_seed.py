"""genesis_seed.py -- the Genesis Kernel's seed algebra, in Python, stdlib only.

A line-for-line port of src/kernel/seed.js (normalizeSeed, hashSeed, seedChannel,
mulberry32) and src/kernel/core/seedpath.js (seedPath, worldSeedPath,
parseSeedPath, hash64, splitmix32, sfc32, streamFor). It exists so that a generator running outside a
browser -- Blender's Python, a batch tool, a sibling repository's pipeline --
derives the SAME streams from the same seed path as the engine does.

It is right exactly when tools/kernel/py/check_vectors.py exits 0 against
tools/test/kernel/vectors/seed-vectors.json, which tools/kernel/seed-vectors.mjs generates from
the JS. The JS is the reference; this file follows it, never the other way
round. If you change the algebra, change src/kernel/core/seedpath.js, regenerate
the vectors, and then make this match.

Two things a Python port has to do on purpose, because Python will not do
them by accident:

  * Hash UTF-16 CODE UNITS, not code points. JavaScript strings are UTF-16, so
    "\U0001F332" (a tree, outside the BMP) is two units to hashSeed and hash64.
    _units() encodes to UTF-16-LE and reads the 16-bit words back; a lone
    surrogate, which Python can hold and JSON can carry, is encoded with
    "surrogatepass" so it reaches the grammar check and is refused there,
    exactly as the JS refuses it, rather than raising UnicodeEncodeError.
  * Mask to 32 bits after every operation. Python integers do not overflow, so
    every place JS relies on |0, >>>0 or Math.imul wrapping is an explicit
    "& M32" here. Signed-vs-unsigned never matters to the bits: the JS keeps
    some intermediates signed and these are all unsigned, and the xor, add,
    multiply and shifts agree modulo 2**32 either way (">>>" is a LOGICAL shift,
    which on a non-negative Python int is plain ">>").
"""
import re

M32 = 0xFFFFFFFF
TWO32 = 4294967296


def _imul(a, b):
    return (a * b) & M32


def _units(s):
    b = s.encode("utf-16-le", "surrogatepass")
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]


# ---------------------------------------------------------------- src/kernel/seed.js

def normalize_seed(value):
    """normalizeSeed: upper-case, keep [A-Z0-9], three groups of four padded
    with "2". Returns None when nothing survives. (Only ever exercised by the
    vectors on ASCII input: seedPath normalizes seed-SHAPED roots, which are
    ASCII by definition. Python's and JavaScript's upper-casing of other
    scripts follow different Unicode versions and are not relied on.)"""
    raw = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    if not raw:
        return None
    groups = [raw[i:i + 4].ljust(4, "2") for i in range(0, 12, 4)]
    return "-".join(groups[:3])


def hash_seed(s):
    """hashSeed: FNV-1a 32-bit over UTF-16 code units."""
    h = 0x811C9DC5
    for u in _units(s):
        h = _imul(h ^ u, 0x01000193)
    return h


def seed_channel(seed, channel):
    """seedChannel: hashSeed(seed + ":" + channel)."""
    return hash_seed(seed + ":" + channel)


class Mulberry32:
    """mulberry32. next_u32() is the raw draw; random() is next_u32() / 2**32,
    which is what the JS function returns."""

    def __init__(self, seed):
        self.a = seed & M32

    def next_u32(self):
        self.a = (self.a + 0x6D2B79F5) & M32
        a = self.a
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return (t ^ (t >> 14)) & M32

    def random(self):
        return self.next_u32() / TWO32


def channel_rng(seed, channel):
    return Mulberry32(seed_channel(seed, channel))


# --------------------------------------------------------- src/kernel/core/seedpath.js

MAX_INDEX = 9007199254740991
# fullmatch, never "$": Python's "$" also matches before a trailing newline,
# JavaScript's does not, and "k7qn3f2a9xbd\n" must be refused by both.
_SEED_SHAPED = re.compile(r"[A-Za-z0-9 ._-]+")
_INDEX = re.compile(r"0|[1-9][0-9]*")


class SeedPathError(ValueError):
    pass


def _is_banned(c):
    """The banned code units of seedpath.js's header: every control, every
    White_Space unit, and the invisible format characters. An explicit list,
    not Python's own idea of whitespace, so it is the same set as the JS."""
    return (c <= 0x20 or 0x7F <= c <= 0xA0 or c == 0xAD or c == 0x1680
            or 0x2000 <= c <= 0x200F or 0x2028 <= c <= 0x202F
            or 0x205F <= c <= 0x2064 or 0x2066 <= c <= 0x2069
            or c == 0x3000 or c == 0xFEFF)


def _bad_name_reason(s):
    u = _units(s)
    if not u:
        return "is empty"
    i = 0
    while i < len(u):
        c = u[i]
        if c == 0x2F:
            return 'contains "/" at %d' % i
        if c == 0x3A:
            return 'contains ":" at %d' % i
        if _is_banned(c):
            return "contains control, space or invisible U+%04X at %d" % (c, i)
        if 0xD800 <= c <= 0xDBFF:
            d = u[i + 1] if i + 1 < len(u) else 0
            if not (0xDC00 <= d <= 0xDFFF):
                return "contains an unpaired high surrogate at %d" % i
            i += 2
            continue
        if 0xDC00 <= c <= 0xDFFF:
            return "contains an unpaired low surrogate at %d" % i
        i += 1
    return ""


def is_seed_shaped(s):
    if not isinstance(s, str) or not _SEED_SHAPED.fullmatch(s):
        return False
    return len(re.sub(r"[^A-Za-z0-9]", "", s)) == 12


def _canonical_root(root):
    if not isinstance(root, str):
        raise TypeError("seed_path: root must be a string")
    if is_seed_shaped(root):
        return normalize_seed(root)
    why = _bad_name_reason(root)
    if why:
        raise SeedPathError("seed_path: root %r %s" % (root, why))
    return root


def _check_segment(seg, where):
    if not isinstance(seg, str):
        raise TypeError("seed_path: segment %d must be a string" % where)
    k = seg.find(":")
    name = seg if k < 0 else seg[:k]
    why = _bad_name_reason(name)
    if why:
        raise SeedPathError("seed_path: segment %d %r: name %s" % (where, seg, why))
    if k >= 0:
        index = seg[k + 1:]
        if not _INDEX.fullmatch(index):
            raise SeedPathError("seed_path: segment %d %r: index must be a non-negative decimal integer" % (where, seg))
        # Length first: int() of a string past 4300 digits raises a plain
        # ValueError on Python 3.11+, which is not a SeedPathError. 2^53 - 1
        # has 16 digits, so anything longer is out of range without asking.
        if len(index) > 16 or int(index) > MAX_INDEX:
            raise SeedPathError("seed_path: segment %d %r: index exceeds 2^53 - 1" % (where, seg))
    return seg


def seed_path(root, *segments):
    """seedPath(root, ...segments) -> canonical path string. The root must be
    the engine's seed (already normalized), not raw user input; see
    world_seed_path."""
    out = _canonical_root(root)
    for i, seg in enumerate(segments):
        out += "/" + _check_segment(seg, i)
    return out


def world_seed_path(typed, *segments):
    """worldSeedPath: seed_path(normalize_seed(typed), ...), the root the
    engine builds the world from. Raises where the engine would roll a random
    seed. (normalize_seed upper-cases with Python's Unicode tables; the vectors
    pin ASCII input only.)"""
    seed = normalize_seed(typed)
    if seed is None:
        raise SeedPathError("world_seed_path: no seed survives normalize_seed(%r)" % (typed,))
    return seed_path(seed, *segments)


def parse_seed_path(path):
    """parseSeedPath(path) -> (root, segments); only canonical paths parse."""
    if not isinstance(path, str):
        raise TypeError("parse_seed_path: path must be a string")
    parts = path.split("/")
    canon = seed_path(parts[0], *parts[1:])
    if canon != path:
        raise SeedPathError("parse_seed_path: %r is not canonical; seed_path gives %r" % (path, canon))
    return parts[0], parts[1:]


def hash64(s):
    """hash64 -> (hi, lo): FNV-1a 64-bit over UTF-16 code units. Python has big
    integers, so this is the plain definition; the JS does the same thing in
    two uint32 limbs, and the vectors are what prove the two agree. A
    non-string raises TypeError, as the JS does."""
    if not isinstance(s, str):
        raise TypeError("hash64: expected a string, got %s" % type(s).__name__)
    h = 0xCBF29CE484222325
    for u in _units(s):
        h = ((h ^ u) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return (h >> 32, h & M32)


def hex64(h):
    return "%08x%08x" % h


def hash64_hex(s):
    return hex64(hash64(s))


class SplitMix32:
    def __init__(self, state):
        self.s = state & M32

    def next_u32(self):
        self.s = (self.s + 0x9E3779B9) & M32
        t = self.s ^ (self.s >> 16)
        t = _imul(t, 0x21F0AAAD)
        t ^= t >> 15
        t = _imul(t, 0x735A2D97)
        return (t ^ (t >> 15)) & M32

    def mix(self, x):
        self.s = (self.s ^ x) & M32


class Sfc32:
    def __init__(self, a, b, c, d):
        self.a, self.b, self.c, self.d = a & M32, b & M32, c & M32, d & M32

    def next_u32(self):
        a, b, c, d = self.a, self.b, self.c, self.d
        t = (a + b + d) & M32
        self.d = (d + 1) & M32
        self.a = b ^ (b >> 9)
        self.b = (c + (c << 3)) & M32
        c = ((c << 21) | (c >> 11)) & M32
        self.c = (c + t) & M32
        return t

    def random(self):
        return self.next_u32() / TWO32


SFC32_DISCARD = 12


def v2_state(h):
    hi, lo = h
    sm = SplitMix32(lo)
    a, b = sm.next_u32(), sm.next_u32()
    sm.mix(hi)
    c, d = sm.next_u32(), sm.next_u32()
    return [a, b, c, d]


def stream_for(path, mode="v2"):
    """streamFor(path, {mode}) -> an object with next_u32() and random()."""
    root, segments = parse_seed_path(path)
    if not segments:
        raise SeedPathError("stream_for: %r has no segments -- name the channel" % path)
    if mode == "legacy32":
        return Mulberry32(seed_channel(root, ":".join(segments)))
    if mode == "v2":
        g = Sfc32(*v2_state(hash64(path)))
        for _ in range(SFC32_DISCARD):
            g.next_u32()
        return g
    raise SeedPathError("stream_for: unknown mode %r" % (mode,))
