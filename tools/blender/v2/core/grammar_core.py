"""Python port of src/world/grammarCore.js plus the engine's seed hash and PRNG: the pieces every seeded generator's
port shares (Arcade's creatures, houses, trees and village).

Keep in lockstep with the JS (hashSeed and mulberry32 in the repository kernel's src/kernel/seed.js, which the engine
imports; grammarCore.js): the same weight order, the same floor(x + 0.5) rounding, the same clamps. hash_seed and
mulberry32 are checked against the kernel's own cross-language vectors (tools/test/kernel/vectors/seed-vectors.json, legacy32) by
tools/test/test-kernel-parity.mjs.

Standalone (no bpy). Inside Blender, exec it (then layout_core.py) before any theme's grammar; under python3 the
theme ports import it from this folder.
"""
import math

M32 = 0xFFFFFFFF


def _imul(a, b):
    return (a * b) & M32


def hash_seed(s):
    """FNV-1a, 32-bit, over UTF-16 code units (the kernel's src/kernel/seed.js hashSeed)."""
    h = 0x811C9DC5
    for ch in str(s).encode('utf-16-le').decode('utf-16-le'):
        for unit in ([ord(ch)] if ord(ch) < 0x10000 else [0xD800 + ((ord(ch) - 0x10000) >> 10), 0xDC00 + ((ord(ch) - 0x10000) & 0x3FF)]):
            h = _imul((h ^ unit) & M32, 0x01000193)
    return h & M32


def mulberry32(seed):
    """The kernel's src/kernel/seed.js mulberry32 (src/utils/math.js re-exports it), in unsigned 32-bit arithmetic."""
    state = [seed & M32]

    def nxt():
        a = state[0] = (state[0] + 0x6D2B79F5) & M32
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296
    return nxt


def _clamp01(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def _choose(roll, items, weight):
    """Weighted choice with a pre-drawn roll in [0, 1); None when nothing has weight."""
    total = 0
    for it in items: total += weight(it)
    if not total > 0: return None
    t = roll * total
    for it in items:
        t -= weight(it)
        if t < 0: return it
    return items[-1]


def _weight_of(option, dna):
    w = option.get('w', 1)
    for gene, f in option.get('favor', {}).items():
        w *= max(0.05, 1 + f * (2 * dna[gene] - 1))
    return w


def _allows(option, tags):
    return all(t in tags for t in option.get('needs', [])) and not any(t in tags for t in option.get('clash', []))


def _toned(hexs, tone):
    n = int(hexs[1:], 16)
    return '#' + ''.join('%02x' % min(255, max(0, math.floor(c + tone * 14 + 0.5))) for c in ((n >> 16) & 255, (n >> 8) & 255, n & 255))


def js_str(key):
    """String(key) as JavaScript prints it (integral floats without '.0')."""
    if isinstance(key, float) and key.is_integer(): return str(int(key))
    return str(key)


def _dirs64():
    c, s = 0, 1
    for _ in range(4):
        nc, ns = math.sqrt((1 + c) / 2), math.sqrt((1 - c) / 2); c, s = nc, ns
    q = [[1, 0]]
    for k in range(1, 16):
        a, b = q[k - 1][0], q[k - 1][1]; q.append([a * c - b * s, a * s + b * c])
    out = []
    for k in range(64):
        quad, i = math.floor(k / 16), k % 16; a, b = q[i][0], q[i][1]
        out.append([a, b] if quad == 0 else [-b, a] if quad == 1 else [-a, -b] if quad == 2 else [b, -a])
    return out


DIRS64 = _dirs64()
