"""Python port of src/world/worldTerrain.js: the relief and the water of an Arcade level, the same grid, the same
noise, the same least-cost brook, number for number.

world_grammar.py calls it while it lays the village out; world_preview.py builds the ground mesh and the water from
its output. Keep the two files in lockstep (see PARITY RULES in the JS header): every expression in the same operand
order, every stream drawn in the same order, numbers out through r4, integer loop counters, ties on the lower index.

Standalone (no bpy): runs inside Blender after tools/blender/v2/core/grammar_core.py and layout_core.py, then creature_grammar.py and house_grammar.py (whose PRNG, clamp and
DIRS64 it shares) and tools/blender/v2/core/layout_core.py (the noise, the grid hash, the polyline walks), before
world_grammar.py; or imported by world_grammar.py under python3.
"""
import math, heapq

try:
    hash_seed, mulberry32, _clamp01, DIRS64, hash3, vnoise, fbm, grid_hash, poly_at, poly_length
except NameError:
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core'))
    from creature_grammar import hash_seed, mulberry32, _clamp01
    from house_grammar import DIRS64
    from layout_core import hash3, vnoise, fbm, grid_hash, poly_at, poly_length

_M32 = 0xFFFFFFFF
_MT = 4294967296.0
_SQ2 = 1.4142135623730951
_INV2 = 0.7071067811865476


def _tr4(v): return math.floor(v * 10000 + 0.5) / 10000
def _tsq(v): return v * v
def _timul(a, b): return (a * b) & _M32


def _smooth(v):
    t = _clamp01(v)
    return t * t * (3 - 2 * t)


def _tstream(seed, name): return mulberry32(hash_seed('%s|world|%s' % (seed, name)))

# ---------------------------------------------------------------- noise (shared with the village)

# hash3, vnoise, fbm and grid_hash are theme-neutral: tools/blender/v2/core/layout_core.py.

# ---------------------------------------------------------------- polylines

def poly_project(x, z, pts):
    """(d, i, t): distance to the nearest point of the polyline, the segment's end index, the parameter."""
    d = math.inf; bi = 1; bt = 0
    for i in range(1, len(pts)):
        a = pts[i - 1]; b = pts[i]; dx = b[0] - a[0]; dz = b[1] - a[1]; l2 = dx * dx + dz * dz
        t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2 if l2 > 0 else 0
        t = 0 if t < 0 else 1 if t > 1 else t
        e = math.sqrt(_tsq(x - a[0] - dx * t) + _tsq(z - a[1] - dz * t))
        if e < d: d = e; bi = i; bt = t
    return (d, bi, bt)


def _along(vals, p): return vals[p[1] - 1] + (vals[p[1]] - vals[p[1] - 1]) * p[2]
def _tdist(a, b): return math.sqrt(_tsq(b[0] - a[0]) + _tsq(b[1] - a[1]))


def k_near(dx, dz):
    best = 0; bv = -math.inf
    for k in range(64):
        v = dx * DIRS64[k][0] + dz * DIRS64[k][1]
        if v > bv: bv = v; best = k
    return best

# ---------------------------------------------------------------- the height grid

class HeightGrid:
    def __init__(self, size, cell):
        self.size = size; self.cell = cell; self.res = math.floor(size / cell + 0.5) + 1
        self.h = [0.0] * (self.res * self.res)

    def coord(self, i): return -self.size / 2 + i * self.cell

    def sample(self, x, z):
        res = self.res; scale = (res - 1) / self.size; data = self.h
        fx = (x + self.size / 2) * scale; fz = (z + self.size / 2) * scale
        fx = min(max(fx, 0), res - 1.001); fz = min(max(fz, 0), res - 1.001)
        ix = math.floor(fx); iz = math.floor(fz); tx = fx - ix; tz = fz - iz
        a = data[iz * res + ix]; b = data[iz * res + ix + 1]; c = data[(iz + 1) * res + ix]; d = data[(iz + 1) * res + ix + 1]
        return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz

    def slope(self, x, z):
        e = self.cell; dx = self.sample(x + e, z) - self.sample(x - e, z); dz = self.sample(x, z + e) - self.sample(x, z - e)
        return math.sqrt(dx * dx + dz * dz) / (2 * e)

    def low(self, x, z, r):
        return min(self.sample(x, z), self.sample(x + r, z), self.sample(x - r, z), self.sample(x, z + r), self.sample(x, z - r))

    def blend(self, x0, x1, z0, z1, fn):
        res = self.res; c = self.cell; half = self.size / 2
        i0 = max(0, math.ceil((x0 + half) / c)); i1 = min(res - 1, math.floor((x1 + half) / c))
        j0 = max(0, math.ceil((z0 + half) / c)); j1 = min(res - 1, math.floor((z1 + half) / c))
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                at = j * res + i; h = self.h[at]; r = fn(self.coord(i), self.coord(j), h, at)
                if r: self.h[at] = h + (r[0] - h) * r[1]


def _bbox(pts, pad):
    x0 = math.inf; x1 = -math.inf; z0 = math.inf; z1 = -math.inf
    for p in pts: x0 = min(x0, p[0]); x1 = max(x1, p[0]); z0 = min(z0, p[1]); z1 = max(z1, p[1])
    return x0 - pad, x1 + pad, z0 - pad, z1 + pad


def _corridor(g, pts, hs, flat, blend):
    x0, x1, z0, z1 = _bbox(pts, flat + blend)

    def fn(x, z, h, at):
        p = poly_project(x, z, pts)
        if p[0] >= flat + blend: return None
        return (_along(hs, p), 1 if p[0] <= flat else 1 - _smooth((p[0] - flat) / blend))
    g.blend(x0, x1, z0, z1, fn)


def _disc(g, x, z, r, blend, target):
    def fn(vx, vz, h, at):
        d = math.sqrt(_tsq(vx - x) + _tsq(vz - z))
        if d >= r + blend: return None
        return (target, 1 if d <= r else 1 - _smooth((d - r) / blend))
    g.blend(x - r - blend, x + r + blend, z - r - blend, z + r + blend, fn)


def _slab(g, R, flat, blend, target):
    def fn(x, z, h, at):
        dx = max(R['x0'] - x, 0, x - R['x1']); dz = max(R['z0'] - z, 0, z - R['z1']); d = math.sqrt(dx * dx + dz * dz)
        if d >= flat + blend: return None
        return (target, 1 if d <= flat else 1 - _smooth((d - flat) / blend))
    g.blend(R['x0'] - flat - blend, R['x1'] + flat + blend, R['z0'] - flat - blend, R['z1'] + flat + blend, fn)

# ---------------------------------------------------------------- 1. relief

def relief_field(rules, seed, fields):
    R = rules['terrain']['relief']; sr = hash_seed('%s:world:relief' % seed); ss = hash_seed('%s:world:swell' % seed)

    def relief(x, z):
        e = R['edge']; rim = _smooth((max(abs(x), abs(z)) - e[0]) / (e[1] - e[0]))
        amp = R['height'] * rim * (1 - R['core'] * fields['village'](x, z))
        return amp * (R['base'] + (1 - R['base']) * fbm(x, z, sr, R)) + R['swell'] * (2 * vnoise(x / R['swellScale'], z / R['swellScale'], ss) - 1)
    return relief


def make_ground(rules, seed, fields, given=None):
    """The grid with its relief: the village's own hills, or `given` ({'res', 'heights'}, row-major, r4) on this very
    grid, which is how a level stands on its seed's Visigenesis world (src/world/kernelGround.js)."""
    T = rules['terrain']; g = HeightGrid(rules['size'], T['grid'])
    if given is not None:
        if given['res'] != g.res or len(given['heights']) != g.res * g.res:
            raise ValueError('make_ground: the given relief is %s^2 (%d heights); this grid is %d^2' % (given['res'], len(given['heights']), g.res))
        for i in range(len(g.h)): g.h[i] = given['heights'][i]
        return g
    relief = relief_field(rules, seed, fields)
    for j in range(g.res):
        for i in range(g.res): g.h[j * g.res + i] = relief(g.coord(i), g.coord(j))
    return g

# ---------------------------------------------------------------- 2. lanes and 3. spurs

def _profile(raw, pts, anchor, h0, grade):
    n = len(pts); h = list(raw)
    h[anchor] = h0
    for i in range(anchor + 1, n):
        d = _tdist(pts[i - 1], pts[i]) * grade; h[i] = min(max(h[i], h[i - 1] - d), h[i - 1] + d)
    for i in range(anchor - 1, -1, -1):
        d = _tdist(pts[i + 1], pts[i]) * grade; h[i] = min(max(h[i], h[i + 1] - d), h[i + 1] + d)
    return [_tr4(v) for v in h]


def _sampled(g, pts):
    raw = [g.sample(p[0], p[1]) for p in pts]; n = len(raw)
    return [v if (i == 0 or i == n - 1) else (raw[i - 1] + 2 * v + raw[i + 1]) / 4 for i, v in enumerate(raw)]


def grade_lanes(rules, g, lanes, square):
    T = rules['terrain']; P = rules['paths']; L = T['lanes']; spine = lanes[0]
    hs = _tr4(g.sample(square['x'], square['z']))
    anchor = 0; bd = math.inf
    for i in range(len(spine['pts'])):
        d = _tdist(spine['pts'][i], [square['x'], square['z']])
        if d < bd: bd = d; anchor = i
    spine['h'] = _profile(_sampled(g, spine['pts']), spine['pts'], anchor, hs, L['grade'])
    for lane in lanes[1:]:
        a = 0; ad = math.inf
        for i in range(len(lane['pts'])):
            d = poly_project(lane['pts'][i][0], lane['pts'][i][1], spine['pts'])[0]
            if d < ad: ad = d; a = i
        at = poly_project(lane['pts'][a][0], lane['pts'][a][1], spine['pts'])
        lane['h'] = _profile(_sampled(g, lane['pts']), lane['pts'], a, _tr4(_along(spine['h'], at)), L['grade'])
    for lane in lanes: _corridor(g, lane['pts'], lane['h'], lane['w'] / 2 + P['verge'] + L['shoulder'], L['bank'])
    return hs


def pad_targets(rules, g, reserved, square, hs):
    D = rules['terrain']['pads']
    pads = [{'x': c['x'], 'z': c['z'], 'r': _tr4(c['r'] * D['flat']), 'h': _tr4(g.sample(c['x'], c['z']))} for c in reserved if c['id'] in ('spawn', 'site') or c['spur']]
    pads.append({'x': square['x'], 'z': square['z'], 'r': square['r'] + rules['paths']['verge'], 'h': hs})
    n = len(pads); root = list(range(n))

    def find(i):
        while root[i] != i: i = root[i]
        return i
    for i in range(n):
        for j in range(i + 1, n):
            if math.sqrt(_tsq(pads[i]['x'] - pads[j]['x']) + _tsq(pads[i]['z'] - pads[j]['z'])) >= pads[i]['r'] + pads[j]['r'] + 2 * D['blend']: continue
            a = find(i); b = find(j)
            if a != b: root[max(a, b)] = min(a, b)
    s = [0.0] * n; cnt = [0] * n
    for i in range(n):
        a = find(i); s[a] += pads[i]['h']; cnt[a] += 1
    return [dict(p, h=_tr4(s[find(i)] / cnt[find(i)])) for i, p in enumerate(pads)]


def join_pad(rules, pads, p):
    D = rules['terrain']['pads']
    for q in pads:
        if math.sqrt(_tsq(p['x'] - q['x']) + _tsq(p['z'] - q['z'])) < p['r'] + q['r'] + 2 * D['blend']: p['h'] = q['h']; break
    pads.append(p)
    return p


def ramp_spurs(rules, g, spurs):
    S = rules['terrain']['spurs']
    ends = [[_tr4(g.sample(s['pts'][0][0], s['pts'][0][1])), _tr4(g.sample(s['pts'][1][0], s['pts'][1][1]))] for s in spurs]
    for i, s in enumerate(spurs): _corridor(g, s['pts'], ends[i], s['w'] / 2 + S['flat'], S['blend'])

# ---------------------------------------------------------------- 4. water, planned

def _shore_radii(W, r, seed, index):
    ws = hash_seed('%s:world:pond%d' % (seed, index)); out = []
    for k in range(64):
        d = DIRS64[k]
        out.append(_tr4(r * (1 + W['wobble'] * (2 * vnoise(d[0] * W['wobbleScale'] + 7.1, d[1] * W['wobbleScale'] + 3.3, ws) - 1))))
    return out


def plan_ponds(rules, seed, fields, mask):
    W = rules['terrain']['ponds']; bound = rules['size'] / 2 - rules['margin']; out = []; cands = []
    n = math.floor(bound)
    for j in range(n + 1):
        for i in range(n + 1):
            x = -bound + i * 2; z = -bound + j * 2
            if x > bound or z > bound: continue
            if fields['village'](x, z) > W['village']: continue
            cands.append({'x': x, 'z': z, 'm': fields['moisture'](x, z), 'idx': len(cands)})
    cands.sort(key=lambda c: (-c['m'], c['idx']))
    for c in cands:
        if len(out) >= W['max']: break
        if c['m'] < (W['moistMin'] if len(out) < W['min'] else W['moist']): break
        r = _tr4(W['r'][0] + (W['r'][1] - W['r'][0]) * _clamp01((c['m'] - W['moistMin']) / (1 - W['moistMin'])))
        reach = r * (1 + W['wobble'])
        if abs(c['x']) > bound - reach - 1 or abs(c['z']) > bound - reach - 1: continue
        if mask.blocked(c['x'], c['z'], reach + W['clear'], lots=True, zones=False, spurs=True): continue
        if any(math.sqrt(_tsq(p['x'] - c['x']) + _tsq(p['z'] - c['z'])) < p['reach'] + reach + W['apart'] for p in out): continue
        radii = _shore_radii(W, r, seed, len(out))
        out.append({'index': len(out), 'x': _tr4(c['x']), 'z': _tr4(c['z']), 'r': r, 'radii': radii, 'reach': _tr4(max(radii)), 'm': _tr4(c['m'])})
    return out


def _place_basin(rules, rng, square, mask, lots):
    T = rules['terrain']; Bs = T['basin']; B = T.get('brook'); P = rules['paths']
    diags = [[_INV2, _INV2], [-_INV2, _INV2], [-_INV2, -_INV2], [_INV2, -_INV2]]
    start = math.floor(rng() * 4) % 4

    def free(x, z):
        for c in mask.reserved:
            if _tsq(x - c['x']) + _tsq(z - c['z']) < _tsq(c['r'] * B['reserve'] + Bs['r']): return False
        for l in mask.lanes:
            if poly_project(x, z, l['pts'])[0] < l['w'] / 2 + P['verge'] + Bs['r']: return False
        for s in mask.spurs:
            if poly_project(x, z, s['pts'])[0] < s['w'] / 2 + Bs['r']: return False
        for L in lots:
            R = L['rect']
            if x > R['x0'] - Bs['r'] - 1 and x < R['x1'] + Bs['r'] + 1 and z > R['z0'] - Bs['r'] - 1 and z < R['z1'] + Bs['r'] + 1: return False
        return True
    for q in range(4):
        d = diags[(start + q) % 4]
        for s in range(9):
            far = square['r'] + P['verge'] + Bs['r'] + Bs['gap'] + s * 0.5; x = _tr4(square['x'] + d[0] * far); z = _tr4(square['z'] + d[1] * far)
            if free(x, z): return {'x': x, 'z': z, 'r': Bs['r'], 'part': Bs['part'], 'q': (start + q) % 4}
    return None


_STEPS = [(1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, _SQ2), (-1, 1, _SQ2), (1, -1, _SQ2), (-1, -1, _SQ2)]


def plan_brook(rules, seed, fields, mask, g, lanes, spurs, square, ponds, lots):
    T = rules['terrain']; B = T.get('brook'); W = T['ponds']; P = rules['paths']; rng = _tstream(seed, 'brook')
    # a world without a brook (the desert: its water is the oasis) has none, and no pool at the square either
    if not B: return None
    bound = rules['size'] / 2 - rules['margin']
    basin = _place_basin(rules, rng, square, mask, lots)
    if not basin: return None
    # the spring stands at least `fall` over the pool: a brook runs down (see the JS)
    sj = hash_seed('%s:world:spring' % seed); pool_h = g.sample(basin['x'], basin['z'])
    src = None; best = -math.inf
    rings = math.floor((B['from'][1] - B['from'][0]) / 2 + 0.5)
    for ri in range(rings + 1):
        for k in range(64):
            rad = B['from'][0] + ri * 2; d = DIRS64[k]; x = _tr4(square['x'] + d[0] * rad); z = _tr4(square['z'] + d[1] * rad)
            if abs(x) > bound - 2 or abs(z) > bound - 2: continue
            if mask.blocked(x, z, B['w'] / 2 + B['bank'] + 1, lots=True, zones=False, spurs=True): continue
            if _tsq(x - basin['x']) + _tsq(z - basin['z']) < _tsq(B['minLen']): continue
            if g.sample(x, z) - pool_h < B['fall']: continue
            score = g.sample(x, z) + B['wet'] * fields['moisture'](x, z) + B['jitter'] * hash3(k, ri, sj)
            if score > best: best = score; src = {'x': x, 'z': z}
    if not src: return None
    res = g.res; N = res * res; blocked = [0] * N; pen = [0.0] * N; fac = [0.0] * N
    sm = hash_seed('%s:world:meander' % seed)
    for j in range(res):
        for i in range(res):
            at = j * res + i; x = g.coord(i); z = g.coord(j)
            fac[at] = 1 + B['meander'] * vnoise(x / B['meanderScale'], z / B['meanderScale'], sm)
            no = abs(x) > bound - 1 or abs(z) > bound - 1
            if not no:
                for c in mask.reserved:
                    if _tsq(x - c['x']) + _tsq(z - c['z']) < _tsq(c['r'] * B['reserve'] + B['w'] / 2 + B['bank'] * 0.5): no = True; break
            if not no and _tsq(x - square['x']) + _tsq(z - square['z']) < _tsq(square['r'] + P['verge'] + B['w'] / 2): no = True
            if not no:
                for L in lots:
                    m = B['w'] / 2 + B['bank'] + B['yard']; R = L['rect']
                    if x > R['x0'] - m and x < R['x1'] + m and z > R['z0'] - m and z < R['z1'] + m: no = True; break
            if not no:
                for p in ponds:
                    d = math.sqrt(_tsq(x - p['x']) + _tsq(z - p['z']))
                    if d < p['reach'] + W['terrace'] + W['blend'] + B['w'] / 2 and d < p['radii'][k_near(x - p['x'], z - p['z'])] + W['terrace'] + W['blend'] + B['w'] / 2: no = True; break
            blocked[at] = 1 if no else 0
            if no: continue
            for l in lanes:
                if poly_project(x, z, l['pts'])[0] < l['w'] / 2 + P['verge'] + B['w'] / 2: pen[at] += B['lane']
            for s in spurs:
                if poly_project(x, z, s['pts'])[0] < s['w'] / 2 + B['w'] / 2: pen[at] += B['spur']

    def node(x, z): return math.floor((z + g.size / 2) / g.cell + 0.5) * res + math.floor((x + g.size / 2) / g.cell + 0.5)
    frm = node(src['x'], src['z']); to = node(basin['x'], basin['z'])
    blocked[frm] = 0; blocked[to] = 0
    cost = [math.inf] * N; prev = [-1] * N; done = [0] * N; heap = []
    cost[frm] = 0; heapq.heappush(heap, (0, frm))
    while heap:
        d, c = heapq.heappop(heap)
        if done[c]: continue
        done[c] = 1
        if c == to: break
        ci = c % res; cj = (c - ci) // res
        for di, dj, ln in _STEPS:
            ni = ci + di; nj = cj + dj
            if ni < 0 or nj < 0 or ni >= res or nj >= res: continue
            n = nj * res + ni
            if blocked[n] or done[n]: continue
            nd = d + ln * g.cell * (fac[c] + fac[n]) * 0.5 + B['up'] * max(0, g.h[n] - g.h[c]) + pen[n]
            if nd < cost[n]: cost[n] = nd; prev[n] = c; heapq.heappush(heap, (nd, n))
    if not done[to]: return None
    path = []; c = to
    while c >= 0:
        i = c % res; path.append([g.coord(i), g.coord((c - i) // res)]); c = prev[c]
    path.reverse()
    path.append([basin['x'], basin['z']])
    pts = path
    for _ in range(2):
        pts = [p if (i == 0 or i == len(pts) - 1) else [(pts[i - 1][0] + 2 * p[0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * p[1] + pts[i + 1][1]) / 4] for i, p in enumerate(pts)]
    pts = [[_tr4(p[0]), _tr4(p[1])] for p in pts]
    bridges = []
    for l in lanes:
        reach = l['w'] / 2 + P['verge'] + B['cross']
        a = -1; b = -1
        for i in range(len(pts)):
            near = poly_project(pts[i][0], pts[i][1], l['pts'])[0] < reach + 0.5
            if near and a < 0: a = i
            if near: b = i
            elif a >= 0: break
        if a < 0 or a == 0 or b == len(pts) - 1: continue
        mid = pts[math.floor((a + b) / 2)]; pr = poly_project(mid[0], mid[1], l['pts']); s0 = l['pts'][pr[1] - 1]; s1 = l['pts'][pr[1]]
        sl = _tdist(s0, s1); tx = (s1[0] - s0[0]) / sl; tz = (s1[1] - s0[1]) / sl
        cx = s0[0] + (s1[0] - s0[0]) * pr[2]; cz = s0[1] + (s1[1] - s0[1]) * pr[2]
        nx = -tz; nz = tx
        if (pts[b + 1][0] - pts[a - 1][0]) * nx + (pts[b + 1][1] - pts[a - 1][1]) * nz < 0: nx = -nx; nz = -nz
        edge = l['w'] / 2 + P['verge'] * 0.6
        cross = [[_tr4(cx - nx * reach), _tr4(cz - nz * reach)], [_tr4(cx - nx * edge), _tr4(cz - nz * edge)], [_tr4(cx), _tr4(cz)],
                 [_tr4(cx + nx * edge), _tr4(cz + nz * edge)], [_tr4(cx + nx * reach), _tr4(cz + nz * reach)]]
        pts = pts[:a] + cross + pts[b + 1:]
        bridges.append({'lane': l['id'], 'x': _tr4(cx), 'z': _tr4(cz), 'front': [_tr4(tx), _tr4(tz)], 'reach': _tr4(reach), 'at': a + 2})
    for br in bridges:
        for i in range(len(pts)):
            if pts[i][0] == br['x'] and pts[i][1] == br['z']: br['at'] = i; break
    return {'pts': pts, 'w': B['w'], 'depth': B['depth'], 'source': [pts[0][0], pts[0][1]], 'basin': basin, 'bridges': bridges}


def water_edge(water, x, z):
    best = math.inf; tx = x; tz = z
    for p in water['ponds']:
        d = math.sqrt(_tsq(x - p['x']) + _tsq(z - p['z'])); e = d - p['radii'][k_near(x - p['x'], z - p['z'])]
        if e < best: best = e; tx = p['x']; tz = p['z']
    B = water.get('brook')
    if B:
        pr = poly_project(x, z, B['pts']); e = pr[0] - B['w'] / 2
        if e < best:
            a = B['pts'][pr[1] - 1]; b = B['pts'][pr[1]]; best = e; tx = a[0] + (b[0] - a[0]) * pr[2]; tz = a[1] + (b[1] - a[1]) * pr[2]
        bs = B['basin']; eb = math.sqrt(_tsq(x - bs['x']) + _tsq(z - bs['z'])) - bs['r']
        if eb < best: best = eb; tx = bs['x']; tz = bs['z']
    return {'e': best, 'x': tx, 'z': tz}


def water_blocks(rules, water, x, z, pad, wet):
    W = rules['terrain']['ponds']
    for p in water['ponds']:
        d = math.sqrt(_tsq(x - p['x']) + _tsq(z - p['z']))
        if d - p['reach'] > W['terrace'] + pad: continue
        if d < p['radii'][k_near(x - p['x'], z - p['z'])] + (-W['wetIn'] if wet else W['terrace'] * 0.5) + pad: return True
    B = water.get('brook')
    if B:
        if poly_project(x, z, B['pts'])[0] < B['w'] / 2 + (0 if wet else rules['terrain']['brook']['bank']) + pad: return True
        if _tsq(x - B['basin']['x']) + _tsq(z - B['basin']['z']) < _tsq(B['basin']['r'] + pad + (0 if wet else 0.3)): return True
    return False


def water_rect(rules, water, R, margin):
    W = rules['terrain']['ponds']; B = water.get('brook')
    for p in water['ponds']:
        nx = max(R['x0'], min(p['x'], R['x1'])); nz = max(R['z0'], min(p['z'], R['z1']))
        if _tsq(nx - p['x']) + _tsq(nz - p['z']) < _tsq(p['reach'] + W['clear'] + margin): return True
    if not B: return False
    bank = rules['terrain']['brook']['bank']
    for k in range(9):
        t = k / 8
        edge = [[R['x0'] + (R['x1'] - R['x0']) * t, R['z0']], [R['x0'] + (R['x1'] - R['x0']) * t, R['z1']], [R['x0'], R['z0'] + (R['z1'] - R['z0']) * t], [R['x1'], R['z0'] + (R['z1'] - R['z0']) * t]]
        for ex, ez in edge:
            if poly_project(ex, ez, B['pts'])[0] < B['w'] / 2 + bank + margin: return True
    for e in (B['pts'][0], B['pts'][-1]):
        if e[0] > R['x0'] - margin and e[0] < R['x1'] + margin and e[1] > R['z0'] - margin and e[1] < R['z1'] + margin: return True
    bs = B['basin']; nx = max(R['x0'], min(bs['x'], R['x1'])); nz = max(R['z0'], min(bs['z'], R['z1']))
    return _tsq(nx - bs['x']) + _tsq(nz - bs['z']) < _tsq(bs['r'] + margin + 0.3)

# ---------------------------------------------------------------- 5. lots and walks, 6. pads

def rect_stats(g, R):
    lo = math.inf; hi = -math.inf; s = 0.0
    for j in range(3):
        for i in range(3):
            h = g.sample(R['x0'] + (R['x1'] - R['x0']) * i / 2, R['z0'] + (R['z1'] - R['z0']) * j / 2)
            lo = min(lo, h); hi = max(hi, h); s += h
    return {'lo': lo, 'hi': hi, 'mean': s / 9}


def level_lots(rules, g, lots):
    T = rules['terrain']
    for L in lots: _slab(g, L['rect'], rules['houses']['margin'], T['lots']['skirt'], L['y'])


def ramp_walks(rules, g, walks, lots):
    T = rules['terrain']
    ends = [[next(L for L in lots if L['slot'] == w['lot'])['y'], _tr4(g.sample(w['pts'][1][0], w['pts'][1][1]))] for w in walks]
    for i, w in enumerate(walks): _corridor(g, w['pts'], ends[i], w['w'] / 2 + T['walks']['flat'], T['walks']['blend'])


def level_pads(rules, g, pads):
    for p in pads: _disc(g, p['x'], p['z'], p['r'], rules['terrain']['pads']['blend'], p['h'])

# ---------------------------------------------------------------- 7. the carve

def in_keep(keep, x, z, m=0):
    """Is (x, z) inside one of the kept oriented rectangles ({x, z, f, hw, hd}, world_landmarks.py), grown by m?"""
    for R in keep:
        dx = x - R['x']; dz = z - R['z']; u = dx * R['f'][0] + dz * R['f'][1]; v = dx * R['f'][1] - dz * R['f'][0]
        if abs(u) < R['hw'] + m and abs(v) < R['hd'] + m: return True
    return False


def _under_bridge(brook, lanes, P, x, z):
    for br in brook['bridges']:
        if _tsq(x - br['x']) + _tsq(z - br['z']) > _tsq(br['reach'] + 0.5): continue
        l = next(q for q in lanes if q['id'] == br['lane'])
        if poly_project(x, z, l['pts'])[0] < l['w'] / 2 + P['verge'] * 0.6: return True
    return False


def carve_water(rules, g, water, lanes):
    T = rules['terrain']; W = T['ponds']; B = T.get('brook'); Bs = T['basin']; P = rules['paths']
    surface = [-math.inf] * (g.res * g.res)
    for p in water['ponds']:
        s = 0.0
        for k in range(64): s += g.sample(p['x'] + DIRS64[k][0] * p['radii'][k], p['z'] + DIRS64[k][1] * p['radii'][k])
        rim = s / 64
        p['level'] = _tr4(rim - W['freeboard'])
        far = p['reach'] + W['terrace'] + W['blend']

        def fn(x, z, h, at, p=p, rim=rim):
            d = math.sqrt(_tsq(x - p['x']) + _tsq(z - p['z'])); R = p['radii'][k_near(x - p['x'], z - p['z'])]; e = d - R
            if e >= W['terrace'] + W['blend']: return None
            if d < R and W.get('frozen'): return (p['level'] - W['frozen'], 1)
            if d < R:
                surface[at] = p['level']; return (p['level'] - W['depth'] * _smooth((1 - d / R) / W['shelf']), 1)
            if e < W['terrace']: return (p['level'] + W['freeboard'] * _smooth(e / W['lip']), 1)
            return (rim, 1 - _smooth((e - W['terrace']) / W['blend']))
        g.blend(p['x'] - far, p['x'] + far, p['z'] - far, p['z'] + far, fn)
    K = water.get('brook')
    if K:
        bs = K['basin']; n = len(K['pts'])
        bs['y'] = _tr4(g.sample(bs['x'], bs['z']))
        S = []
        for i in range(n - 1):
            raw = g.sample(K['pts'][i][0], K['pts'][i][1]) - B['freeboard']
            S.append(_tr4(raw if i == 0 else min(S[i - 1], raw)))
        bs['level'] = _tr4(min(S[n - 2], bs['y'] - Bs['freeboard']))
        S.append(bs['level'])
        K['surface'] = S
        x0, x1, z0, z1 = _bbox(K['pts'], K['w'] / 2 + B['bank']); keep = water.get('keep') or []

        def fb(x, z, h, at):
            pr = poly_project(x, z, K['pts'])
            if pr[0] >= K['w'] / 2 + B['bank'] or _under_bridge(K, lanes, P, x, z): return None
            # A landmark's rectangle on the bank (the mill house) keeps its pad: the bank is cut up to its wall.
            if keep and in_keep(keep, x, z): return None
            if _tsq(x - bs['x']) + _tsq(z - bs['z']) < _tsq(bs['r'] + 0.35) or (pr[1] == n - 1 and pr[2] >= 1): return None
            s = _along(S, pr); bed = s - K['depth']
            if pr[0] <= K['w'] / 2 + 0.3: surface[at] = max(surface[at], s)
            target = bed if pr[0] <= K['w'] / 2 else bed + (h - bed) * _smooth((pr[0] - K['w'] / 2) / B['bank'])
            return (min(h, target), 1)
        g.blend(x0, x1, z0, z1, fb)

        def fp(x, z, h, at):
            d = math.sqrt(_tsq(x - bs['x']) + _tsq(z - bs['z']))
            if d >= bs['r']: return None
            surface[at] = bs['level']
            return (min(h, bs['level'] - Bs['depth'] * _smooth((bs['r'] - d) / (bs['r'] * 0.5))), 1)
        g.blend(bs['x'] - bs['r'], bs['x'] + bs['r'], bs['z'] - bs['r'], bs['z'] + bs['r'], fp)
    return surface

# ---------------------------------------------------------------- shore dressing

def shore_dressing(rules, seed, g, water, lanes, crossings):
    T = rules['terrain']; B = T.get('brook'); W = T['ponds']; P = rules['paths']; out = []; fords = []
    K = water.get('brook')
    if K:
        for ci, c in enumerate(crossings):
            a = c['pts'][0]; b = c['pts'][1]; l = _tdist(a, b)
            if not (l > 0): continue
            bi = -1; bd = K['w'] / 2
            for i in range(1, len(K['pts']) - 1):
                d = poly_project(K['pts'][i][0], K['pts'][i][1], [a, b])[0]
                if d < bd: bd = d; bi = i
            if bi < 0: continue
            cx = K['pts'][bi][0]; cz = K['pts'][bi][1]; ux = (b[0] - a[0]) / l; uz = (b[1] - a[1]) / l
            fords.append({'x': cx, 'z': cz})
            for s in (-1, 0, 1):
                x = _tr4(cx + ux * s * B['ford']); z = _tr4(cz + uz * s * B['ford'])
                out.append({'part': 'stone.step', 'x': x, 'z': z, 'k': (ci * 11 + (s + 1) * 21) % 64, 's': 1, 'lod': 0, 'y': _tr4(_along(K['surface'], poly_project(x, z, K['pts'])) - 0.06), 'kind': 'ford'})
        rng = _tstream(seed, 'banks'); parts = B['stones']; length = poly_length(K['pts']); n = math.floor((length - 0.8) / B['spacing']); keep = water.get('keep') or []
        count = 0
        for i in range(n + 1):
            u = 0.4 + i * B['spacing']; at = poly_at(K['pts'], u)
            for side in (-1, 1):
                a = rng(); b = rng(); c = rng()
                off = K['w'] / 2 + 0.12 + a * 0.25; x = _tr4(at['x'] - at['tz'] * side * off); z = _tr4(at['z'] + at['tx'] * side * off)
                if _under_bridge(K, lanes, P, x, z) or any(_tsq(x - br['x']) + _tsq(z - br['z']) < _tsq(br['reach'] + 0.4) for br in K['bridges']): continue
                if keep and in_keep(keep, x, z, 0.4): continue
                if any(_tsq(x - f['x']) + _tsq(z - f['z']) < _tsq(B['ford'] * 1.6) for f in fords): continue
                if _tsq(x - K['basin']['x']) + _tsq(z - K['basin']['z']) < _tsq(K['basin']['r'] + 0.4): continue
                out.append({'part': parts[math.floor(b * len(parts)) % len(parts)], 'x': x, 'z': z, 'k': math.floor(c * 64) % 64, 's': _tr4(0.8 + 0.45 * a), 'lod': count % 2, 'y': _tr4(g.sample(x, z) - 0.04), 'kind': 'bank'})
                count += 1
        for q in range(5):
            d = DIRS64[(q * 13) % 64]; x = _tr4(K['source'][0] + d[0] * 0.9); z = _tr4(K['source'][1] + d[1] * 0.9)
            out.append({'part': parts[q % len(parts)], 'x': x, 'z': z, 'k': (q * 23) % 64, 's': _tr4(1.05 + 0.1 * (q % 2)), 'lod': 0, 'y': _tr4(g.sample(x, z) - 0.04), 'kind': 'spring'})
    rng = _tstream(seed, 'lilies')
    for p in water['ponds']:
        want = math.floor(p['r'] * W['lilies']); mine = []; t = 0
        while t < want * 3 and len(mine) < want:
            t += 1
            kr = rng(); sr = rng(); spin = rng(); bloom = rng()
            k = math.floor(kr * 64) % 64; s = 0.3 + 0.45 * sr; x = _tr4(p['x'] + DIRS64[k][0] * s * p['radii'][k]); z = _tr4(p['z'] + DIRS64[k][1] * s * p['radii'][k])
            if any(_tsq(q['x'] - x) + _tsq(q['z'] - z) < _tsq(W['lilyApart']) for q in mine): continue
            it = {'part': 'lily.bloom' if bloom < W['bloom'] else 'lily.pad', 'x': x, 'z': z, 'k': math.floor(spin * 64) % 64, 's': _tr4(0.85 + 0.3 * sr), 'lod': 1 if len(mine) % 3 == 2 else 0, 'y': _tr4(p['level'] + 0.01), 'kind': 'lily'}
            mine.append(it); out.append(it)
    return {'flora': out, 'fords': fords}

# ---------------------------------------------------------------- the finished terrain

def finish_terrain(g, surface):
    heights = [0.0] * len(g.h); depth = [0.0] * len(g.h); lo = math.inf; hi = -math.inf
    for i in range(len(g.h)):
        h = _tr4(g.h[i]); heights[i] = h
        depth[i] = _tr4(max(0, surface[i] - g.h[i])) if surface[i] > -math.inf else 0
        lo = min(lo, h); hi = max(hi, h)
    return {'size': g.size, 'cell': g.cell, 'res': g.res, 'min': lo, 'max': hi, 'heights': heights, 'depth': depth}
