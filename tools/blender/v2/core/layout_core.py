"""Python port of src/world/layoutCore.js: the theme-neutral pieces every seeded level layout's port shares (Arcade's
village and terrain): named PRNG streams, the lattice hash, value noise and fbm, polyline and
rectangle geometry, the point hash and Bridson's Poisson-disc sampling.

Keep in lockstep with the JS (see PARITY RULES there): every expression in the same operand order, every stream drawn
in the same order whatever branch is taken, numbers out through wr4, integer loop counters.

Standalone (no bpy). Inside Blender, exec it after grammar_core.py and before any theme's layout port; under python3
the ports import it from this folder.
"""
import math

try:
    hash_seed, mulberry32, _clamp01, DIRS64
except NameError:
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from grammar_core import hash_seed, mulberry32, _clamp01, DIRS64

_LM32 = 0xFFFFFFFF
_LMT = 4294967296.0


def wr4(v): return math.floor(v * 10000 + 0.5) / 10000
def _sq(v): return v * v
def _limul(a, b): return (a * b) & _LM32


def layout_stream(seed, domain, name):
    """A stage's own PRNG stream: `domain` is the generator ('world' for the village, 'streets' for the city)."""
    return mulberry32(hash_seed('%s|%s|%s' % (seed, domain, name)))

# ---------------------------------------------------------------- noise

def hash3(ix, iz, seed):
    h = (_limul(ix, 0x27d4eb2d) ^ _limul(iz, 0x165667b1) ^ (seed & _LM32)) & _LM32
    h = _limul(h ^ (h >> 15), 0x85ebca6b)
    h = _limul(h ^ (h >> 13), 0xc2b2ae35)
    h ^= h >> 16
    return (h & _LM32) / _LMT


def _fade(t): return t * t * t * (t * (t * 6 - 15) + 10)


def vnoise(x, z, seed):
    ix = math.floor(x); iz = math.floor(z); u = _fade(x - ix); v = _fade(z - iz)
    a = hash3(ix, iz, seed); b = hash3(ix + 1, iz, seed); c = hash3(ix, iz + 1, seed); d = hash3(ix + 1, iz + 1, seed)
    top = a + (b - a) * u; bottom = c + (d - c) * u
    return top + (bottom - top) * v


def fbm(x, z, seed, F):
    total = 0.0; amp = 1.0; s = 0.0; f = 1 / F['scale']
    for o in range(F['octaves']):
        s += amp * vnoise(x * f + o * 17.3, z * f + o * 11.7, int((seed + o * 7919) % _LMT))
        total += amp; amp *= 0.5; f *= 2
    return _clamp01((s / total - 0.5) * F.get('contrast', 1) + 0.5)


def favor_at(favor, fields, x, z):
    """A class weight conditioned on the fields; a field the level lacks reads 0."""
    w = 1.0
    for name, f in (favor or {}).items(): w *= max(0, 1 + f * (2 * (fields[name](x, z) if name in fields else 0) - 1))
    return w


def grid_hash(values):
    return hash_seed(','.join(str(int(math.floor(v * 1000 + 0.5))) for v in values))

# ---------------------------------------------------------------- geometry

def seg_dist(x, z, a, b):
    dx = b[0] - a[0]; dz = b[1] - a[1]; l2 = dx * dx + dz * dz
    t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2 if l2 > 0 else 0
    t = 0 if t < 0 else 1 if t > 1 else t
    return math.sqrt(_sq(x - a[0] - dx * t) + _sq(z - a[1] - dz * t))


def poly_dist(x, z, pts):
    best = math.inf
    for i in range(1, len(pts)): best = min(best, seg_dist(x, z, pts[i - 1], pts[i]))
    return best


def poly_at(pts, u):
    acc = 0.0
    for i in range(1, len(pts)):
        a = pts[i - 1]; b = pts[i]; l = math.sqrt(_sq(b[0] - a[0]) + _sq(b[1] - a[1]))
        if u <= acc + l or i == len(pts) - 1:
            t = max(0, min(1, (u - acc) / l)) if l > 0 else 0
            return {'x': a[0] + (b[0] - a[0]) * t, 'z': a[1] + (b[1] - a[1]) * t, 'tx': (b[0] - a[0]) / l if l > 0 else 1, 'tz': (b[1] - a[1]) / l if l > 0 else 0}
        acc += l
    return {'x': pts[0][0], 'z': pts[0][1], 'tx': 1, 'tz': 0}


def poly_length(pts):
    l = 0.0
    for i in range(1, len(pts)): l += math.sqrt(_sq(pts[i][0] - pts[i - 1][0]) + _sq(pts[i][1] - pts[i - 1][1]))
    return l


def poly_nearest(x, z, pts):
    best = None; bd = math.inf
    for i in range(1, len(pts)):
        a = pts[i - 1]; b = pts[i]; dx = b[0] - a[0]; dz = b[1] - a[1]; l2 = dx * dx + dz * dz
        t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2 if l2 > 0 else 0
        t = 0 if t < 0 else 1 if t > 1 else t
        px = a[0] + dx * t; pz = a[1] + dz * t; d = math.sqrt(_sq(x - px) + _sq(z - pz))
        if d < bd: bd = d; best = [px, pz]
    return best


def rect_circle(R, cx, cz, r):
    nx = max(R['x0'], min(cx, R['x1'])); nz = max(R['z0'], min(cz, R['z1']))
    return _sq(nx - cx) + _sq(nz - cz) < r * r


def rect_rect(A, B, gap): return A['x0'] < B['x1'] + gap and B['x0'] < A['x1'] + gap and A['z0'] < B['z1'] + gap and B['z0'] < A['z1'] + gap
def rect_has(R, x, z, m): return x > R['x0'] - m and x < R['x1'] + m and z > R['z0'] - m and z < R['z1'] + m

# ---------------------------------------------------------------- Poisson-disc sampling

class PointHash:
    def __init__(self, cell=2):
        self.cell = cell; self.map = {}; self.fmax = 0

    def add(self, x, z, r, c=None):
        k = (math.floor(x / self.cell), math.floor(z / self.cell))
        self.map.setdefault(k, []).append((x, z, r, r if c is None else c))

    def near(self, x, z, d):
        i0 = math.floor((x - d) / self.cell); i1 = math.floor((x + d) / self.cell); j0 = math.floor((z - d) / self.cell); j1 = math.floor((z + d) / self.cell)
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                b = self.map.get((i, j))
                if b:
                    for p in b: yield p


def poisson_disc(rng, bound, r, foot, canopy, cap, placed, refuse):
    """Bridson's Poisson-disc sampling for one class (layoutCore.js poissonDisc): refuse(x, z, roll) is the mask,
    the fields and the class's own rules; a refused candidate is a ghost that keeps the spacing."""
    own = PointHash(); out = []; reach = foot + placed.fmax

    def crowded(x, z):
        for p in placed.near(x, z, reach):
            if _sq(x - p[0]) + _sq(z - p[1]) < _sq(foot + (p[3] if canopy else p[2])): return True
        for q in own.near(x, z, r):
            if _sq(x - q[0]) + _sq(z - q[1]) < r * r: return True
        return False

    active = []

    def consider(x, z):
        if x < -bound or x > bound or z < -bound or z > bound or crowded(x, z): return False
        own.add(x, z, r); active.append((x, z))
        roll = rng(); spin = rng(); size = rng(); keep = rng()
        if not refuse(x, z, roll): out.append({'x': wr4(x), 'z': wr4(z), 'k': math.floor(spin * 64) % 64, 's': wr4(0.85 + 0.3 * size), 'keep': keep})
        return True

    for s in range(6): consider(wr4((rng() * 2 - 1) * bound), wr4((rng() * 2 - 1) * bound))
    guard = math.ceil(_sq((2 * bound) / (r / math.sqrt(2)))) * 4
    while active and guard > 0:
        guard -= 1
        ai = math.floor(rng() * len(active)); ax, az = active[ai]
        grew = False
        for k in range(8):
            d = DIRS64[math.floor(rng() * 64) % 64]; dist = r * (1 + rng())
            if consider(wr4(ax + d[0] * dist), wr4(az + d[1] * dist)): grew = True
        if not grew:
            active[ai] = active[-1]; active.pop()
    if len(out) > cap:
        kept = sorted(out, key=lambda p: (p['keep'], p['x'], p['z']))[:cap]
        ids = set(id(p) for p in kept)
        out = [p for p in out if id(p) in ids]
    return [{k: v for k, v in p.items() if k != 'keep'} for p in out]
