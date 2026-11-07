"""Python port of src/world/houseGrammar.js: the same rules, the same PRNG streams, the same plan and expansion.

The Blender preview (house_preview.py) meshes these expansions, so what the art pipeline renders is exactly what
the engine builds for the same key. tools/test/test-house-grammar.mjs compares this port against the JS through
fixtures written by write_house_fixtures(): full plans, plus a digest of every expanded piece and part. Keep the
two files in lockstep (see PARITY RULES in the JS header): every expression in the same operand order, every
stream drawn in the same order whatever branch is taken, numbers out through r4/snap.

Standalone (no bpy): runs inside Blender (after tools/blender/v2/core/grammar_core.py and layout_core.py, then creature_grammar.py, whose PRNG and choice helpers it shares) or
with python3: python3 tools/blender/v2/arcade/house_grammar.py packs/arcade/pack.json tools/test/fixtures/house-plans.json
"""
import json, math

try:
    hash_seed, mulberry32, _choose, _weight_of, _toned, _clamp01, js_str, DIRS64
except NameError:
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from creature_grammar import hash_seed, mulberry32, _choose, _weight_of, _toned, _clamp01, js_str
    from grammar_core import DIRS64

HOUSE_GRAMMAR_VERSION = 1
FACES = ['-y', '+x', '+y', '-x']
NORMALS = {'-y': (0, -1), '+x': (1, 0), '+y': (0, 1), '-x': (-1, 0)}
ZV = [0, 0, 1]
RING = [48, 0, 16, 32, 56, 40]


def r4(v): return math.floor(v * 10000 + 0.5) / 10000
def snap(v): return math.floor(v * 20 + 0.5) / 20
def mix(rng_, t): return rng_[0] + (rng_[1] - rng_[0]) * t
def sc(a, s): return [a[0] * s, a[1] * s, a[2] * s]
def mad(a, b, s): return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def unit(a):
    l = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    return [a[0] / l, a[1] / l, a[2] / l]


def _allows(o, tags):
    return all(t in tags for t in o.get('needs', [])) and not any(t in tags for t in o.get('clash', []))


def house_rng(family, key, stage):
    return mulberry32(hash_seed('%s|%s|%s' % (family, key, stage)))

# ---------------------------------------------------------------- blocks


def _ridge_z(b, K):
    R = b['roof']
    if R['type'] == 'shed': R['zr'] = r4(R['zt']); return
    half = (b['y1'] - b['y0']) / 2 if b['shape'] == 'round' or R['axis'] == 'x' else (b['x1'] - b['x0']) / 2
    R['zr'] = r4(b['zTop'] + K['plate'] + half * R['pitch'])


def _block(id_, shape, x0, x1, y0, y1, storeys, walls, z_top, roof, K):
    b = {'id': id_, 'shape': shape, 'x0': r4(x0), 'x1': r4(x1), 'y0': r4(y0), 'y1': r4(y1), 'storeys': storeys, 'zTop': r4(z_top), 'walls': walls, 'roof': dict(roof)}
    _ridge_z(b, K)
    return b


def _extent(blocks, K):
    x0, x1, y0, y1 = math.inf, -math.inf, math.inf, -math.inf
    for b in blocks:
        pad = 0.5 if b['shape'] == 'round' else K['eave'] + 0.05
        x0 = min(x0, b['x0'] - pad); x1 = max(x1, b['x1'] + pad); y0 = min(y0, b['y0'] - pad); y1 = max(y1, b['y1'] + pad)
    return x0, x1, y0, y1


def _fits(blocks, lot, K):
    x0, x1, y0, y1 = _extent(blocks, K)
    return x1 - x0 <= lot['w'] + 1e-6 and y1 - y0 <= lot['d'] + 1e-6


def _inside(x, y, blocks, skip):
    for i, b in enumerate(blocks):
        if i != skip and b['x0'] + 0.01 < x < b['x1'] - 0.01 and b['y0'] + 0.01 < y < b['y1'] - 0.01: return True
    return False


def _face_point(b, face, u):
    return [u, b['y0']] if face == '-y' else [u, b['y1']] if face == '+y' else [b['x0'], u] if face == '-x' else [b['x1'], u]


def _exposed_spans(bi, face, blocks):
    b = blocks[bi]; along_x = face in ('-y', '+y')
    line = b['y0'] if face == '-y' else b['y1'] if face == '+y' else b['x0'] if face == '-x' else b['x1']
    lo, hi = (b['x0'], b['x1']) if along_x else (b['y0'], b['y1'])
    spans = [[lo, hi]]
    for i, o in enumerate(blocks):
        if i == bi: continue
        p0, p1 = (o['y0'], o['y1']) if along_x else (o['x0'], o['x1'])
        if not (p0 + 0.01 < line < p1 - 0.01): continue
        c0, c1 = (o['x0'], o['x1']) if along_x else (o['y0'], o['y1'])
        nxt = []
        for a, z in spans:
            if c1 <= a or c0 >= z: nxt.append([a, z]); continue
            if c0 > a: nxt.append([a, c0])
            if c1 < z: nxt.append([c1, z])
        spans = nxt
    out = []
    for a, z in spans:
        if z - a < 0.3: continue
        pa, pz = _face_point(b, face, a), _face_point(b, face, z)
        out.append([r4(a), r4(z), a == lo and not _inside(pa[0], pa[1], blocks, bi), z == hi and not _inside(pz[0], pz[1], blocks, bi)])
    return out


def _exposed_at(bi, face, u, blocks, margin):
    for a, z, _, _ in _exposed_spans(bi, face, blocks):
        if a + margin <= u <= z - margin: return True
    return False

# ---------------------------------------------------------------- 2. footprint


def _wing_on(K, main, face, a, H):
    on_x = face != '-y'; face_len = main['y1'] - main['y0'] if on_x else main['x1'] - main['x0']
    proj = snap(2.0 + 1.4 * a[1]); axis = 'x' if on_x else 'y'; extension = axis == main['roof']['axis'] and main['roof']['type'] == 'gable'
    hs_m = (main['y1'] - main['y0']) / 2 if main['roof']['axis'] == 'x' else (main['x1'] - main['x0']) / 2
    ws = snap(max(2.4, min(face_len - 0.4, 2 * hs_m - 0.9, max(2.6, face_len * (0.55 + 0.25 * a[2])))))
    storeys = main['storeys'] - 1 if main['storeys'] > 1 and a[3] < 0.5 else main['storeys']
    for _ in range(8):
        lo, hi = (main['y0'], main['y1']) if on_x else (main['x0'], main['x1'])
        mid = (lo + hi) / 2 if extension or (0.4 <= a[3] <= 0.75) else lo + ws / 2 if a[3] < 0.4 else hi - ws / 2
        if face == '+x': x0, x1, y0, y1 = main['x1'] - 0.3, main['x1'] + proj, mid - ws / 2, mid + ws / 2
        elif face == '-x': x0, x1, y0, y1 = main['x0'] - proj, main['x0'] + 0.3, mid - ws / 2, mid + ws / 2
        else: x0, x1, y0, y1 = mid - ws / 2, mid + ws / 2, main['y0'] - proj, main['y0'] + 0.3
        w = _block('wing', 'rect', x0, x1, y0, y1, storeys, main['walls'], K['plinth'] + storeys * H,
                   {'type': 'gable', 'axis': axis, 'pitch': main['roof']['pitch'], 'covering': main['roof']['covering'], 'ends': [K['over'], K['over']]}, K)
        off = (w['y0'] + w['y1']) / 2 - (main['y0'] + main['y1']) / 2 if axis == 'x' else (w['x0'] + w['x1']) / 2 - (main['x0'] + main['x1']) / 2
        limit = main['roof']['zr'] - abs(off) * main['roof']['pitch'] - 0.3 if extension else main['roof']['zr'] - 0.35
        if w['roof']['zr'] <= limit:
            inner = 0 if face == '+x' else 1
            if extension: w['roof']['ends'][inner] = -0.32
            else:
                t = (main['roof']['zr'] - w['roof']['zr']) / main['roof']['pitch']
                w['roof']['ends'][inner] = r4(-0.32 if t >= hs_m else hs_m - t - 0.35)
            return w
        if storeys > 1: storeys -= 1
        elif ws > 2.45: ws = snap(ws - 0.3)
        else: return None
    return None


def _leanto_on(K, main, face, a, H, on_gable):
    on_x = face in ('+x', '-x'); face_len = main['y1'] - main['y0'] if on_x else main['x1'] - main['x0']
    round_ = main['shape'] == 'round'; open_ = a[5] < 0.5; low = not round_ and main['storeys'] == 1 and not on_gable
    depth = snap((1.5 if low else 1.7) + (0.4 if low else 0.6) * a[2]); ln = min(face_len, snap(max(2.2, face_len * (0.5 + 0.35 * a[1]))))
    pitch = r4((0.28 if low else 0.42) + 0.1 * a[4])
    zt = r4(K['plinth'] + H + 0.45 if round_ or main['storeys'] > 1 else main['zTop'] + 0.3 if on_gable else main['zTop'] - 0.55)
    z_low = zt - depth * pitch
    if z_low < K['plinth'] + (0.95 if open_ else 1.25): return None
    inset = 0.75 if round_ else 0.3
    lo, hi = (main['y0'], main['y1']) if on_x else (main['x0'], main['x1'])
    mid = hi - ln / 2 if a[3] >= 0.5 else (lo + hi) / 2
    if face == '+x': x0, x1, y0, y1, wall, dr = main['x1'] - inset, main['x1'] + depth, mid - ln / 2, mid + ln / 2, main['x1'], 1
    elif face == '-x': x0, x1, y0, y1, wall, dr = main['x0'] - depth, main['x0'] + inset, mid - ln / 2, mid + ln / 2, main['x0'], -1
    else: x0, x1, y0, y1, wall, dr = mid - ln / 2, mid + ln / 2, main['y1'] - inset, main['y1'] + depth, main['y1'], 1
    return _block('leanto', 'rect', x0, x1, y0, y1, 1, 'open' if open_ else 'plank', z_low,
                  {'type': 'shed', 'axis': 'y' if on_x else 'x', 'pitch': pitch, 'covering': main['roof']['covering'], 'ends': [0.3, 0.3], 'zt': zt, 'wall': r4(wall), 'dir': dr}, K)


def _annex_faces(kind, main):
    if main['shape'] == 'round': return [['+x', True], ['-x', True], ['+y', True]] if kind == 'leanto' else []
    x = main['roof']['axis'] == 'x'; gable = main['roof']['type'] == 'gable'
    if kind == 'wing': return [[f, False] for f in (['+x', '-x', '-y'] if x else ['+x', '-x'])]
    if kind == 'tower': return [['-x', False], ['+x', False]]
    gables = [] if not gable else ['+x', '-x'] if x else ['+y']
    eaves = (['+y'] if x else ['+x', '-x']) if gable else ['+x', '-x', '+y'] if x else ['+y', '+x', '-x']
    return [[f, True] for f in gables] + [[f, False] for f in eaves]


def _annex_reserve(kind, face, a):
    if kind == 'tower':
        half = snap(2.3 + 0.7 * a[2]) / 2 - 0.1; return half, half
    out = snap(2.0 + 1.4 * a[1]) if kind == 'wing' else snap(1.7 + 0.6 * a[2])
    return (out, 0) if face in ('+x', '-x') else (0, out)


def _door_fits(blocks, dw):
    if blocks[0]['shape'] == 'round': return True
    for bi, b in enumerate(blocks):
        if b['shape'] != 'rect' or b['walls'] == 'open': continue
        for a, z, ca, cz in _exposed_spans(bi, '-y', blocks):
            if z - a - (0.5 if ca else 0.35) - (0.5 if cz else 0.35) >= dw + 0.3: return True
    return False


def _annex_of(kind, K, main, a, blocks, lot, H, dna, dw):
    faces = _annex_faces(kind, main); first = math.floor(a[0] * len(faces))
    for i in range(len(faces)):
        face, on_gable = faces[(first + i) % len(faces)]
        if kind == 'wing': b = _wing_on(K, main, face, a, H)
        elif kind == 'leanto': b = _leanto_on(K, main, face, a, H, on_gable)
        else:
            round_ = a[4] < 0.55; ts = snap(2.3 + 0.7 * a[2]); cx = main['x0'] if face == '-x' else main['x1']; cy = main['y0']
            walls = 'stone' if main['walls'] == 'stone' else 'plaster' if round_ else 'timber'
            b = _block('tower', 'round' if round_ else 'rect', cx - ts / 2, cx + ts / 2, cy - ts / 2, cy + ts / 2, main['storeys'] + 1, walls,
                       K['plinth'] + (main['storeys'] + 1) * H, {'type': 'cone' if round_ else 'pyramid', 'axis': None if round_ else 'x',
                                                                 'pitch': r4(1.9 + 0.6 * dna['whimsy']), 'covering': main['roof']['covering'], 'ends': [K['over'], K['over']]}, K)
        if b and _fits(blocks + [b], lot, K) and _door_fits(blocks + [b], dw): return b
    return None


def _massing(rules, F, style, dna, m, lot):
    K, M = rules['kit'], F['mass']; dw = rules['parts'][style['door']]['w']
    def gene(g): return _clamp01(0.75 * g + 0.25 * m())
    H = snap(K['storey'] * (0.96 + 0.08 * m()))
    pitch = r4(mix(M['pitch'], gene(dna['whimsy'])))
    span = snap(mix(M['span'], gene(dna['size'])))
    length = snap(mix(M['length'], gene(dna['size'])))
    a = [m(), m(), m(), m(), m(), m()]
    shape = 'round' if style.get('shape') == 'round' else 'rect'
    if M.get('square') or shape == 'round': length = span
    n = M['storeys'][0] + min(M['storeys'][1] - M['storeys'][0], math.floor(dna['tall'] * (M['storeys'][1] - M['storeys'][0] + 1)))
    pad = K['eave'] + 0.05; typ = style.get('roof') or ('cone' if shape == 'round' else 'gable')
    axis = 'x' if style.get('ridge') == 'side' else 'y'
    def body(W, D):
        ax = ('x' if W >= D else 'y') if typ in ('hip', 'pyramid') else axis
        return _block('main', shape, -W / 2, W / 2, -D / 2, D / 2, n, style.get('walls') or 'timber', K['plinth'] + n * H,
                      {'type': typ, 'axis': None if shape == 'round' else ax, 'pitch': pitch, 'covering': style.get('covering') or 'tiles', 'ends': [K['over'], K['over']]}, K)
    W = min(length if axis == 'x' else span, snap(lot['w'] - 2 * pad))
    D = W if shape == 'round' else min(span if axis == 'x' else length, snap(lot['d'] - 2 * pad))
    main = body(W, D)
    faces = _annex_faces(style['annex'], main) if style.get('annex') else []
    if faces:
        rx, ry = _annex_reserve(style['annex'], faces[math.floor(a[0] * len(faces))][0], a)
        W = max(M['span'][0] * 0.8, min(W, snap(lot['w'] - 2 * pad - rx)))
        D = W if shape == 'round' else max(M['span'][0] * 0.8, min(D, snap(lot['d'] - 2 * pad - ry)))
        main = body(W, D)
    blocks = [main]
    annex = _annex_of(style['annex'], K, main, a, blocks, lot, H, dna, dw) if faces else None
    if annex: blocks.append(annex)
    x0, x1, y0, y1 = _extent(blocks, K); dx = snap(-(x0 + x1) / 2); dy = snap(-(y0 + y1) / 2)
    for b in blocks:
        b['x0'] = r4(b['x0'] + dx); b['x1'] = r4(b['x1'] + dx); b['y0'] = r4(b['y0'] + dy); b['y1'] = r4(b['y1'] + dy)
        if b['roof']['type'] == 'shed': b['roof']['wall'] = r4(b['roof']['wall'] + (dx if b['roof']['axis'] == 'y' else dy))
    return blocks, H

# ---------------------------------------------------------------- 3. facades


def _bays(a, z, ca, cz, bay, K):
    m0 = 0.5 if ca else 0.35; m1 = 0.5 if cz else 0.35; usable = z - a - m0 - m1
    if usable < K['bay']: return []
    n = max(1, min(math.floor(usable / K['bay']), math.floor(usable / bay + 0.5)))
    return [r4(a + m0 + (i + 0.5) * usable / n) for i in range(n)]


def _cell(u, kind, part=None, shutter=None, sill=None):
    return {'u': u, 'kind': kind, 'part': part, 'shutter': shutter, 'sill': sill}


def _facades(rules, F, style, dna, f, blocks):
    K, FC = rules['kit'], rules['facade']; bay = F['mass']['bay'] * (1.15 - 0.3 * dna['ornament']); main = blocks[0]
    walls, rings, attics = [], [], []
    door = None; dw = rules['parts'][style['door']]['w']
    if main['shape'] == 'rect':
        for bi, b in enumerate(blocks):
            if door: break
            if b['shape'] != 'rect' or b['walls'] == 'open': continue
            best, width = -1, 0
            for si, (a, z, ca, cz) in enumerate(_exposed_spans(bi, '-y', blocks)):
                usable = z - a - (0.5 if ca else 0.35) - (0.5 if cz else 0.35)
                if usable >= dw + 0.3 and z - a > width: best, width = si, z - a
            if best >= 0: door = {'bi': bi, 'si': best}
        if not door: raise ValueError('House: no front wall takes a door')
    door_roll = f()
    for bi, b in enumerate(blocks):
        if b['shape'] == 'round':
            R = (b['x1'] - b['x0']) / 2; cx = (b['x0'] + b['x1']) / 2; cy = (b['y0'] + b['y1']) / 2; cells = []
            win = style['window'] if rules['parts'][style['window']]['w'] <= 0.95 else 'win.slim'
            for s in range(b['storeys']):
                for k in RING:
                    roll = f(); d = DIRS64[k]
                    if _inside(cx + d[0] * (R + 0.4), cy + d[1] * (R + 0.4), blocks, bi): continue
                    if bi == 0 and s == 0 and k == 48: cells.append({'s': s, 'k': k, 'kind': 'door', 'part': style['door'], 'shutter': None, 'sill': None}); continue
                    kind = 'front' if k in (48, 56, 40) else 'back' if k == 16 else 'side'
                    if roll >= FC[kind] * (0.45 if k in (56, 40) else 1): continue
                    sill = 'balcony' if style.get('upper') == 'balcony' and bi == 0 and s == 1 and k == 48 else style['flowers'] if style.get('flowers') and s == 0 else None
                    cells.append({'s': s, 'k': k, 'kind': 'window', 'part': win, 'shutter': None, 'sill': sill})
            rings.append({'b': bi, 'cells': cells})
            continue
        if b['walls'] == 'open': continue
        for face in FACES:
            kind = 'front' if face == '-y' else 'back' if face == '+y' else 'side'
            for si, (a, z, ca, cz) in enumerate(_exposed_spans(bi, face, blocks)):
                us = _bays(a, z, ca, cz, bay, K); n = len(us)
                for s in range(b['storeys']):
                    if b['walls'] == 'belfry' and s == b['storeys'] - 1: continue
                    rolls = [f() for _ in us]
                    is_door = door and door['bi'] == bi and door['si'] == si and face == '-y' and s == 0
                    door_at = ((n - 1) / 2 if n % 2 else n / 2 - (1 if door_roll < 0.5 else 0)) if is_door else -1
                    middle = (n - 1) / 2 if n % 2 and bi == 0 and face == '-y' else -1
                    cells = []
                    for i, u in enumerate(us):
                        if i == door_at: cells.append(_cell(u, 'door', style['door'])); continue
                        if i == middle and s >= 1 and s == b['storeys'] - 1 and style.get('upper') == 'win.oriel': cells.append(_cell(u, 'oriel', 'win.oriel')); continue
                        if i == middle and s >= 1 and s == _top_walled(b) and (style.get('upper') or '').startswith('banner.'): cells.append(_cell(u, 'banner', style['upper'])); continue
                        balcony = i == middle and s == 1 and style.get('upper') == 'balcony'
                        if not balcony and rolls[min(i, n - 1 - i)] >= FC[kind]: cells.append(_cell(u, 'blank')); continue
                        sill = 'balcony' if balcony else style['flowers'] if style.get('flowers') and s == 0 and kind != 'back' else None
                        cells.append(_cell(u, 'window', style['window'], style.get('shutters'), sill))
                    for i in range(1, n):
                        p, q = cells[i - 1], cells[i]
                        if p['kind'] == 'blank' or q['kind'] == 'blank' or q['u'] - p['u'] >= (rules['parts'][p['part']]['w'] + rules['parts'][q['part']]['w']) / 2 + 0.08: continue
                        if q['kind'] == 'window': cells[i] = _cell(q['u'], 'blank')
                        elif p['kind'] == 'window': cells[i - 1] = _cell(p['u'], 'blank')
                    walls.append({'b': bi, 'face': face, 'a': a, 'z': z, 'ca': ca, 'cz': cz, 's': s, 'cells': cells})
        if b['roof']['type'] == 'gable':
            ends = ['-x', '+x'] if b['roof']['axis'] == 'x' else ['-y', '+y']
            half = (b['y1'] - b['y0']) / 2 if b['roof']['axis'] == 'x' else (b['x1'] - b['x0']) / 2
            u = (b['y0'] + b['y1']) / 2 if b['roof']['axis'] == 'x' else (b['x0'] + b['x1']) / 2
            for face in ends:
                roll = f(); kind = 'front' if face == '-y' else 'back' if face == '+y' else 'side'
                if half * b['roof']['pitch'] < 1.5 or roll >= FC['attic'] * FC[kind] or not _exposed_at(bi, face, u, blocks, 0.6): continue
                attics.append({'b': bi, 'face': face, 'u': r4(u), 'part': style.get('attic') or 'win.round'})
    return walls, rings, attics

# ---------------------------------------------------------------- 4. details


def _details(rules, style, dna, x, blocks, walls):
    main = blocks[0]; R = main['roof']; r = [x(), x(), x(), x(), x(), x(), x(), x()]
    chimney = topper = yard = None; dormers = []
    ax = R['axis']; hs = (main['y1'] - main['y0']) / 2 if ax == 'x' else (main['x1'] - main['x0']) / 2
    a0, a1 = (main['x0'], main['x1']) if ax == 'x' else (main['y0'], main['y1'])
    cc = (main['y0'] + main['y1']) / 2 if ax == 'x' else (main['x0'] + main['x1']) / 2
    if style.get('chimney') and main['shape'] == 'rect':
        top = r4(R['zr'] + (0.5 if style['chimney'] == 'ridge' else 0.3) + 0.6 * dna['whimsy']); lean = r4((r[2] - 0.5) * 0.24 * dna['whimsy'])
        if style['chimney'] == 'ridge':
            lo = min((a0 + a1) / 2, a0 + hs) if R['type'] == 'hip' else a0 + 0.6
            hi = max((a0 + a1) / 2, a1 - hs) if R['type'] == 'hip' else a1 - 0.6
            al = lo + (hi - lo) * (0.2 + 0.6 * r[0]); ac = cc + (r[1] - 0.5) * 0.8
            chimney = {'kind': 'ridge', 'x': r4(al if ax == 'x' else ac), 'y': r4(ac if ax == 'x' else al), 'top': top, 'lean': lean, 'pot': r[6] < dna['ornament']}
        else:
            ends = (['-x', '+x'] if r[3] < 0.5 else ['+x', '-x']) if ax == 'x' else ['+y', '-y']
            for face in ends:
                u = cc + (r[1] - 0.5) * hs * 0.6
                if face == '-y' or not _exposed_at(0, face, u, blocks, 0.8): continue
                chimney = {'kind': 'gable', 'face': face, 'u': r4(u), 'top': top, 'lean': lean, 'pot': r[6] < dna['ornament']}
                break
    if style.get('dormer') and main['shape'] == 'rect' and ax == 'x' and R['type'] in ('gable', 'hip') and hs >= 1.9 and R['pitch'] >= 0.85:
        W = main['x1'] - main['x0']; cx = (main['x0'] + main['x1']) / 2
        xs = [main['x0'] + W * 0.28, main['x1'] - W * 0.28] if W >= 5.4 and dna['ornament'] > 0.45 else [cx + (r[4] - 0.5) * 0.8]
        room = W / 2 - hs + 0.5 if R['type'] == 'hip' else W / 2 - 0.4
        for dx in xs:
            if abs(dx - cx) + 0.85 > room: continue
            if chimney and chimney['kind'] == 'ridge' and abs(chimney['x'] - dx) < 1.4: continue
            if _inside(dx, main['y0'] - 0.5, blocks, 0): continue
            y = main['y0'] + 0.75
            dormers.append({'part': style['dormer'], 'x': r4(dx), 'y': r4(y), 'z': r4(R['zr'] - (hs - 0.75) * R['pitch'])})
    if style.get('topper'):
        cx = (main['x0'] + main['x1']) / 2; cy = (main['y0'] + main['y1']) / 2
        if main['shape'] == 'round' or R['type'] == 'pyramid': topper = {'part': style['topper'], 'x': r4(cx), 'y': r4(cy), 'z': r4(R['zr'] - 0.1)}
        elif R['type'] == 'hip': topper = {'part': style['topper'], 'x': r4(cx), 'y': r4(cy), 'z': r4(R['zr'] + 0.18)}
        else:
            end = main['x0'] - R['ends'][0] + 0.35 if ax == 'x' else main['y0'] - R['ends'][0] + 0.35
            topper = {'part': style['topper'], 'x': r4(end if ax == 'x' else cc), 'y': r4(cc if ax == 'x' else end), 'z': r4(R['zr'] + 0.18)}
    if style.get('yard'):
        lean_ = next((b for b in blocks if b['id'] == 'leanto' and b['walls'] == 'open'), None)
        if lean_ and style['yard'] != 'yard.bench':
            yard = {'part': style['yard'], 'x': r4((lean_['x0'] + lean_['x1']) / 2), 'y': r4((lean_['y0'] + lean_['y1']) / 2), 'nx': 0, 'ny': -1}
        else:
            front = next((w for w in walls if w['b'] == 0 and w['face'] == '-y' and w['s'] == 0 and any(c['kind'] == 'door' for c in w['cells'])), None)
            u = main['x0'] + 0.9 if r[5] < 0.5 else main['x1'] - 0.9
            if front:
                d = next(c for c in front['cells'] if c['kind'] == 'door')['u']
                u = front['a'] + 0.8 if abs(front['a'] + 0.8 - d) > abs(front['z'] - 0.8 - d) else front['z'] - 0.8
            yard = {'part': style['yard'], 'x': r4(u), 'y': r4(main['y0'] - (0.5 if style['yard'] == 'yard.bench' else 0.8)), 'nx': 0, 'ny': -1}
    return chimney, dormers, topper, yard

# ---------------------------------------------------------------- the plan


def generate_house(rules, family, key, lot=None):
    F = (rules.get('families') or {}).get(family)
    if not F: raise ValueError('Unknown house family: %s' % family)
    K = rules['kit']; L = lot or rules['lot']; k = js_str(key)
    d = house_rng(family, k, 'dna')
    size = d(); tall = d(); whimsy = _clamp01(0.7 * d() + 0.3 * (1 - size)); ornament = d(); tone = d() * 2 - 1; palette_roll = d()
    dna = {'size': size, 'tall': tall, 'whimsy': whimsy, 'ornament': ornament, 'tone': tone}
    base = F['palettes'][math.floor(palette_roll * len(F['palettes']))]
    palette = {slot: _toned(h, tone) for slot, h in base.items()}
    c = house_rng(family, k, 'plan'); tags = set(); style = {}
    for step in F['plan']:
        chance_roll, pick_roll = c(), c()
        chance = 1 if 'chance' not in step else _clamp01(step['chance'] * (0.6 + 0.8 * dna[step.get('gene', 'ornament')]))
        if chance_roll >= chance: continue
        option = _choose(pick_roll, [o for o in step['options'] if _allows(o, tags)], lambda o: _weight_of(o, dna))
        if not option:
            if 'chance' not in step: raise ValueError('House %s: no allowed option for required slot "%s"' % (family, step['slot']))
            continue
        for t in option.get('tags', []): tags.add(t)
        style[step['slot']] = option['id']
    if F.get('form') == 'flat': return _generate_flat(rules, F, family, k, L, dna, palette, style)
    blocks, H = _massing(rules, F, style, dna, house_rng(family, k, 'mass'), L)
    walls, rings, attics = _facades(rules, F, style, dna, house_rng(family, k, 'facade'), blocks)
    chimney, dormers, topper, yard = _details(rules, style, dna, house_rng(family, k, 'detail'), blocks, walls)
    colliders = [{'x0': b['x0'], 'x1': b['x1'], 'y0': b['y0'], 'y1': b['y1'], 'h': r4(max(b['roof']['zr'], b['zTop']))} for b in blocks]
    x0, x1, y0, y1 = _extent(blocks, K)
    top = max([b['roof']['zr'] for b in blocks] + [chimney['top'] if chimney else 0])
    return {'version': HOUSE_GRAMMAR_VERSION, 'family': family, 'key': k, 'lot': L, 'dna': dna, 'palette': palette, 'colors': rules['colors'], 'style': style,
            'storey': H, 'tile': F['mass'].get('tile', 1), 'blocks': blocks, 'walls': walls, 'rings': rings, 'attics': attics, 'chimney': chimney,
            'dormers': dormers, 'topper': topper, 'yard': yard, 'colliders': colliders, 'bounds': [r4(x0), r4(x1), r4(y0), r4(y1), r4(top)]}

# ---------------------------------------------------------------- expansion


def house_slot_color(plan, slot):
    if slot == 'Roof' and plan['blocks'][0]['roof'].get('covering') == 'thatch': return plan['colors']['thatch']
    key = slot[0].lower() + slot[1:]
    return plan['palette'].get(key) or plan['colors'].get(key) or plan['palette']['wall']


def _wall_slot(walls): return 'Masonry' if walls in ('stone', 'belfry') else 'Plank' if walls == 'plank' else 'TimberDark' if walls == 'log' else 'Wall'
def _storey_slot(b, s): return ('Masonry' if s == 0 else 'Wall') if b['walls'] == 'mixed' else _wall_slot(b['walls'])
def _timber_storey(b, s): return b['walls'] == 'timber' or (b['walls'] == 'mixed' and s >= 1) or (b['walls'] == 'belfry' and s == b['storeys'] - 1)
def _top_walled(b): return b['storeys'] - 2 if b['walls'] == 'belfry' else b['storeys'] - 1
LOG = [[0.19, 0], [0.095, 0.165], [-0.095, 0.165], [-0.19, 0], [-0.095, -0.165], [0.095, -0.165]]


def _rect(a, b): return [[-a / 2, -b / 2], [a / 2, -b / 2], [a / 2, b / 2], [-a / 2, b / 2]]


def build_house(rules, plan):
    if plan.get('form') == 'flat': return _build_flat(rules, plan)
    K = rules['kit']; P = K['plinth']; H = plan['storey']; blocks = plan['blocks']; st = plan['style']
    j = house_rng(plan['family'], plan['key'], 'jitter'); pieces, parts = [], []
    tile_scale = plan['tile']

    def prism(s, o, org, u, v, w, poly, w0, w1, bev, g, round_=False):
        pieces.append({'k': 'prism', 's': s, 'o': o, 'f': [r4(x) for x in list(org) + list(u) + list(v) + list(w)], 'p': [[r4(q[0]), r4(q[1])] for q in poly],
                       'w': [r4(w0), r4(w1)], 'b': bev, 'g': [r4(g[0]), r4(g[1])], 'r': 1 if round_ else 0})

    def box(s, o, c, size, bev, g):
        prism(s, o, c, [1, 0, 0], [0, 1, 0], ZV, _rect(size[0], size[1]), -size[2] / 2, size[2] / 2, bev, g)

    def strut(s, o, p0, p1, width, depth, side, bev, g):
        dv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]; ln = math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2])
        u = sc(dv, 1 / ln)
        prism(s, o, mad(p0, dv, 0.5), u, cross(side, u), side, _rect(ln, width), -depth / 2, depth / 2, bev, g)

    def place(id_, x, y, z, nx, ny):
        parts.append({'id': id_, 'm': [r4(v) for v in (x, y, z, -ny, nx, 0, -nx, -ny, 0, 0, 0, 1)]})
        return len(parts) - 1

    def hang(id_, on, socket, pair):
        parts.append({'id': id_, 'on': on, 'socket': socket, 'pair': pair})

    def caps(p0, p1):
        dv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]; ln = math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2])
        if ln < 0.3: return
        n = max(1, math.floor(ln / 1.4 + 0.5)); X = sc(dv, 1 / ln); Y = unit(cross(ZV, X)); Zl = cross(X, Y); sx = ln / n / 1.32
        cover = blocks[0]['roof']['covering']; id_ = 'roof.ridge.thatch' if cover == 'thatch' else 'roof.ridge.snow' if cover == 'snow' else 'roof.ridge'
        for i in range(n):
            c = mad(mad(p0, dv, (i + 0.5) / n), Zl, 0.1)
            parts.append({'id': id_, 'm': [r4(v) for v in c + sc(X, sx) + Y + Zl]})

    TL, TW, TT = K['tile'][0] * tile_scale, K['tile'][1] * tile_scale, K['tile'][2]

    def tile(top, R, Dn, N, w, ln, thick, bev, g, lift=0.08):
        t = thick * (0.92 + 0.16 * j()); tilt = lift + 0.04 * j(); lat = (j() - 0.5) * 0.04
        cs = 1 / math.sqrt(1 + tilt * tilt); sn = tilt * cs
        u = [Dn[0] * cs + N[0] * sn, Dn[1] * cs + N[1] * sn, Dn[2] * cs + N[2] * sn]
        n = [N[0] * cs - Dn[0] * sn, N[1] * cs - Dn[1] * sn, N[2] * cs - Dn[2] * sn]
        c = mad(mad(mad(top, R, lat), u, ln / 2), n, t / 2)
        prism('Roof', 0.045, c, u, R, n, _rect(ln, w), -t / 2, t / 2, bev, g)

    def roll(top, R, Dn, N, lo, hi, ln, g):
        t = 0.5 * (0.92 + 0.16 * j()); tilt = 0.15 + 0.04 * j(); cs = 1 / math.sqrt(1 + tilt * tilt); sn = tilt * cs
        u = [Dn[0] * cs + N[0] * sn, Dn[1] * cs + N[1] * sn, Dn[2] * cs + N[2] * sn]
        n = [N[0] * cs - Dn[0] * sn, N[1] * cs - Dn[1] * sn, N[2] * cs - Dn[2] * sn]
        c = min(0.4 * t, 0.2 * ln)
        prism('Roof', 0.045, top, u, n, R, [[c, 0], [ln - c, 0], [ln, c], [ln, t - c], [ln - c, t], [c, t], [0, t - c], [0, c]], lo, hi, 0.12, g, True)

    def blanket(T0, R, Dn, N, Ls, q, r, g):
        rectangular = q[0] == r[0] and q[1] == r[1]; i = 0.14 if rectangular else 0; back = 0.3; t = 0.2
        poly = [[q[0], -Ls + back], [q[1], -Ls + back], [r[0], 0]] if r[0] == r[1] else [[q[0] + i, -Ls + back], [q[1] - i, -Ls + back], [r[1] - i, 0], [r[0] + i, 0]]
        prism('Snow', 0.035, T0, R, sc(Dn, -1), N, poly, 0, t, 0.08, g)
        lo = q[0] + i; hi = q[1] - i; width = hi - lo; n = max(1, math.floor(width / 1.7 + 0.5)); cuts = [lo]
        for k in range(1, n): cuts.append(lo + width * k / n + (j() - 0.5) * 0.4)
        cuts.append(hi)
        for k in range(n):
            th = 0.36 * (0.88 + 0.24 * j()); d = 0.5 * (0.9 + 0.2 * j()); sag = 0.05 * j(); c = min(0.4 * th, 0.3 * d)
            org = mad(mad(T0, Dn, Ls - d + 0.1), N, -sag)
            prism('Snow', 0.035, org, Dn, N, R, [[c, 0], [d - c, 0], [d, c], [d, th - c], [d - c, th], [c, th], [0, th - c], [0, c]],
                  cuts[k] - (0.08 if k > 0 else 0), cuts[k + 1] + (0.08 if k < n - 1 else 0), 0.1, g, True)

    def slope(T0, R, Dn, N, Ls, q, r, g, cover):
        thatch = cover == 'thatch'
        poly = [[q[0], -Ls], [q[1], -Ls], [r[0], 0]] if r[0] == r[1] else [[q[0], -Ls], [q[1], -Ls], [r[1], 0], [r[0], 0]]
        prism('Roof', 0.04, T0, R, sc(Dn, -1), N, poly, -0.3 if thatch else -K['slab'], 0, 0.04, g)
        if cover == 'snow': blanket(T0, R, Dn, N, Ls, q, r, g); return
        ln = 1.6 * tile_scale if thatch else TL; step0 = 1.05 * tile_scale if thatch else K['row'] * tile_scale
        span = Ls - 0.1 - ln; rows = math.floor(span / step0 + 0.5) + 1 if span > 0 else 1; step = span / (rows - 1) if rows > 1 else 0
        for k in range(rows):
            dd = 0.1 + k * step; dm = dd + ln / 2
            lo = r[0] + (q[0] - r[0]) * dm / Ls; hi = r[1] + (q[1] - r[1]) * dm / Ls; width = hi - lo
            if width < 0.5: continue
            top = mad(T0, Dn, dd)
            if thatch: roll(top, R, Dn, N, lo - 0.15, hi + 0.15, ln, g); continue
            m = max(1, math.floor(width / TW + 0.5)); p = width / m
            if k % 2 == 0:
                for i in range(m): tile(mad(top, R, lo + (i + 0.5) * p), R, Dn, N, p - 0.06, ln, TT, 0.07, g)
            else:
                hw = p / 2 - 0.06
                tile(mad(top, R, lo + hw / 2), R, Dn, N, hw, ln, TT, 0.07, g)
                for i in range(m - 1): tile(mad(top, R, lo + (i + 1) * p), R, Dn, N, p - 0.06, ln, TT, 0.07, g)
                tile(mad(top, R, hi - hw / 2), R, Dn, N, hw, ln, TT, 0.07, g)

    # ---------------------------------------------------------------- walls, plinth, frame
    for bi, b in enumerate(blocks):
        cx = (b['x0'] + b['x1']) / 2; cy = (b['y0'] + b['y1']) / 2; W = b['x1'] - b['x0']; D = b['y1'] - b['y0']
        if b['shape'] == 'round':
            R = W / 2
            ring = [[DIRS64[k * 4][0] * R, DIRS64[k * 4][1] * R] for k in range(16)]
            prism(_wall_slot(b['walls']), 0.025, [cx, cy, 0], [1, 0, 0], [0, 1, 0], ZV, ring, P, b['zTop'] + 0.02, 0.03, [P, b['zTop']], True)
            chord = 2 * (R + 0.26) * DIRS64[2][1] - 0.05
            for k in range(16):
                d = DIRS64[k * 4 + 2]; h = P + 0.02 + (j() * 0.09 - 0.03); dd = 0.46 + (j() - 0.5) * 0.06
                prism('Stone', 0.04, [cx + d[0] * (R + 0.03), cy + d[1] * (R + 0.03), h / 2], [-d[1], d[0], 0], [d[0], d[1], 0], ZV, _rect(chord, dd), -h / 2, h / 2, 0.08, [0, P + 0.08])
            bands = [b['storeys'] - 1] if b['walls'] == 'stone' else list(range(b['storeys']))
            band = [[DIRS64[k * 4][0] * (R + 0.06), DIRS64[k * 4][1] * (R + 0.06)] for k in range(16)]
            for s in bands:
                z = b['zTop'] + 0.13 if s == b['storeys'] - 1 else P + (s + 1) * H
                prism('Timber', 0.04, [cx, cy, 0], [1, 0, 0], [0, 1, 0], ZV, band, z - 0.13, z + 0.13, 0.05, [z - 0.13, z + 0.13], True)
            continue
        if b['walls'] == 'open':
            R = b['roof']; along_y = R['axis'] == 'y'
            outer = (b['x1'] if along_y else b['y1']) if R['dir'] > 0 else (b['x0'] if along_y else b['y0'])
            run = abs(outer - R['wall']); zu = R['zr'] - run * R['pitch'] - K['slab'] * math.sqrt(1 + R['pitch'] * R['pitch'])
            a0, a1 = (b['y0'], b['y1']) if along_y else (b['x0'], b['x1']); oc = outer - R['dir'] * 0.15
            at = [a0 + 0.15, (a0 + a1) / 2, a1 - 0.15] if a1 - a0 > 3.2 else [a0 + 0.15, a1 - 0.15]
            for al in at: box('Timber', 0.035, [oc, al, zu / 2] if along_y else [al, oc, zu / 2], [0.22, 0.22, zu], 0.04, [0, zu])
            box('Timber', 0.035, [oc, (a0 + a1) / 2, zu - 0.12] if along_y else [(a0 + a1) / 2, oc, zu - 0.12], [0.26, a1 - a0 + 0.1, 0.24] if along_y else [a1 - a0 + 0.1, 0.26, 0.24], 0.04, [zu - 0.24, zu])
            continue
        walled = _top_walled(b) + 1
        s0 = 0
        for s in range(1, walled + 1):
            if s < walled and _storey_slot(b, s) == _storey_slot(b, s0): continue
            z0 = P + s0 * H; z1 = b['zTop'] + 0.02 if s == b['storeys'] else P + s * H
            box(_storey_slot(b, s0), 0.025, [cx, cy, (z0 + z1) / 2], [W, D, z1 - z0], 0.03, [z0, z1])
            s0 = s
        if walled < b['storeys']:
            zf = P + walled * H
            box('Plank', 0.035, [cx, cy, zf + 0.06], [W + 0.34, D + 0.34, 0.2], 0.05, [zf - 0.04, zf + 0.16])
            place('bell.hang', cx, cy, b['zTop'], 0, -1)
        if b['roof']['type'] == 'shed':
            R = b['roof']; along_y = R['axis'] == 'y'
            outer = (b['x1'] if along_y else b['y1']) if R['dir'] > 0 else (b['x0'] if along_y else b['y0'])
            zu = R['zr'] - K['slab'] * math.sqrt(1 + R['pitch'] * R['pitch']) - 0.02
            C = [1, 0, 0] if along_y else [0, 1, 0]; A = [0, 1, 0] if along_y else [1, 0, 0]
            prism('Plank', 0.025, [0, 0, 0], C, ZV, A, [[outer, b['zTop']], [R['wall'], b['zTop']], [R['wall'], zu]], b['y0'] if along_y else b['x0'], b['y1'] if along_y else b['x1'], 0.03, [b['zTop'], zu])
        for face in FACES:
            nx, ny = NORMALS[face]; along_x = face in ('-y', '+y')
            for a, z, ca, cz in _exposed_spans(bi, face, blocks):
                ext = 0.26 if along_x else -0.2; lo = a - (ext if ca else 0); hi = z + (ext if cz else 0); ln = hi - lo
                n = max(1, math.floor(ln / 1.45 + 0.5)); cuts = [lo]
                for k in range(1, n): cuts.append(lo + ln * k / n + (j() - 0.5) * 0.24)
                cuts.append(hi)
                for k in range(n):
                    l = cuts[k + 1] - cuts[k] - 0.05; u = (cuts[k] + cuts[k + 1]) / 2
                    h = P + 0.02 + (j() * 0.09 - 0.03); dd = 0.46 + (j() - 0.5) * 0.06; px, py = _face_point(b, face, u)
                    box('Stone', 0.04, [px + nx * 0.03, py + ny * 0.03, h / 2], [l, dd, h] if along_x else [dd, l, h], 0.08, [0, P + 0.08])
                for s in range(b['storeys']):
                    top = s == b['storeys'] - 1
                    if not top and not _timber_storey(b, s + 1) and not _timber_storey(b, s): continue
                    zc = b['zTop'] + 0.13 if top else P + (s + 1) * H; lo2 = a - (0.18 if ca else 0); hi2 = z + (0.18 if cz else 0)
                    px, py = _face_point(b, face, (lo2 + hi2) / 2); dp = 0.3 if top else 0.26; hp = 0.28 if top else 0.24
                    box('Timber', 0.04, [px + nx * 0.04, py + ny * 0.04, zc], [hi2 - lo2, dp, hp] if along_x else [dp, hi2 - lo2, hp], 0.05, [zc - hp, zc + hp])
                if b['walls'] == 'log':
                    opn = []
                    for w in plan['walls']:
                        if w['b'] == bi and w['face'] == face and w['a'] == a:
                            for c in w['cells']:
                                if c['kind'] == 'blank': continue
                                dm = rules['parts'][c['part']]; zb = P - 0.02 if c['kind'] == 'door' else P + w['s'] * H + K['sill']
                                opn.append([c['u'] - dm['w'] / 2 - 0.08, c['u'] + dm['w'] / 2 + 0.08, zb - 0.1, zb + dm['h'] + 0.1])
                    rows = max(1, math.floor((b['zTop'] - P) / 0.36)); step = (b['zTop'] - P) / rows; org = _face_point(b, face, 0)
                    A = [1, 0, 0] if along_x else [0, 1, 0]; out = [nx, ny, 0]
                    for k in range(rows):
                        zc = P + (k + 0.5) * step; ext = 0.34 if k % 2 == (0 if along_x else 1) else 0.1
                        runs = [[a - (ext if ca else 0), z + (ext if cz else 0)]]
                        for u0, u1, zb, zt in opn:
                            if zc < zb or zc > zt: continue
                            nxt = []
                            for p0, p1 in runs:
                                if u0 > p0: nxt.append([p0, min(p1, u0)])
                                if u1 < p1: nxt.append([max(p0, u1), p1])
                            runs = nxt
                        for p0, p1 in runs:
                            if p1 - p0 > 0.3: prism('Log', 0.03, [org[0] + nx * 0.02, org[1] + ny * 0.02, zc], out, ZV, A, LOG, p0, p1, 0.03, [P, b['zTop']], True)
                if b['walls'] == 'belfry':
                    zf = P + (b['storeys'] - 1) * H + 0.16; zr = zf + 0.95; px, py = _face_point(b, face, (a + z) / 2)
                    box('Timber', 0.035, [px + nx * 0.1, py + ny * 0.1, zr], [z - a + 0.1, 0.18, 0.18] if along_x else [0.18, z - a + 0.1, 0.18], 0.04, [zf, zr])
                    nb = 2 if z - a > 2.6 else 1; bw = (z - a - 0.3) / nb
                    for k in range(nb):
                        for sg in (-1, 1):
                            u0 = a + 0.15 + k * bw; p0 = _face_point(b, face, u0 if sg < 0 else u0 + bw); p1 = _face_point(b, face, u0 + bw if sg < 0 else u0)
                            strut('TimberDark', 0.03, [p0[0] + nx * 0.1, p0[1] + ny * 0.1, zf + 0.05], [p1[0] + nx * 0.1, p1[1] + ny * 0.1, zr - 0.08], 0.14, 0.1, [nx, ny, 0], 0.03, [zf, zr])
                if b['walls'] == 'plank':
                    opn = []
                    for w in plan['walls']:
                        if w['b'] == bi and w['face'] == face and w['a'] == a:
                            for c in w['cells']:
                                if c['kind'] != 'blank': opn.append([c['u'], rules['parts'][c['part']]['w'] / 2 + 0.12])
                    u = a + 0.3
                    while u < z - 0.2:
                        if not any(abs(u - cu) < half for cu, half in opn):
                            px, py = _face_point(b, face, u); z1 = b['zTop'] - 0.02
                            box('TimberDark', 0.02, [px + nx * 0.03, py + ny * 0.03, (P + z1) / 2], [0.1, 0.06, z1 - P] if along_x else [0.06, 0.1, z1 - P], 0.02, [P, z1])
                        u += 0.55
        for x, y in ((b['x0'], b['y0']), (b['x1'], b['y0']), (b['x1'], b['y1']), (b['x0'], b['y1'])):
            if _inside(x, y, blocks, bi): continue
            sx = 1 if x > cx else -1; sy = 1 if y > cy else -1
            zm = P
            if b['walls'] == 'log': continue
            if b['walls'] in ('stone', 'mixed', 'belfry'):
                zm = b['zTop'] if b['walls'] == 'stone' else P + (b['storeys'] - 1) * H if b['walls'] == 'belfry' else P + H
                n = max(1, math.floor((zm - P) / 0.42))
                for k in range(n):
                    h = (zm - P) / n; z = P + (k + 0.5) * h; long_ = k % 2 == 0
                    sxz = [0.66, 0.4] if long_ else [0.4, 0.66]
                    box('Stone', 0.035, [x - sx * (sxz[0] / 2 - 0.06), y - sy * (sxz[1] / 2 - 0.06), z], [sxz[0], sxz[1], h - 0.04], 0.05, [P, zm])
            if b['walls'] != 'stone' and b['zTop'] - zm > 0.3:
                box('Timber', 0.04, [x, y, (zm + b['zTop'] + 0.05) / 2], [0.3, 0.3, b['zTop'] + 0.05 - zm], 0.05, [zm, b['zTop']])

    # ---------------------------------------------------------------- roofs
    for bi, b in enumerate(blocks):
        R = b['roof']; K2 = R['pitch']; n2 = math.sqrt(1 + K2 * K2); thatch = R['covering'] == 'thatch'; z_plate = b['zTop'] + K['plate']
        if R['type'] == 'cone':
            Rr = (b['x1'] - b['x0']) / 2; cx = (b['x0'] + b['x1']) / 2; cy = (b['y0'] + b['y1']) / 2; E = Rr + 0.45; ez = R['zr'] - E * K2; Ls = E * n2; g = [ez, R['zr']]
            pieces.append({'k': 'lathe', 's': 'Roof', 'o': 0.04, 'c': [r4(cx), r4(cy), 0], 'p': [[r4(q[0]), r4(q[1])] for q in ([0, R['zr']], [E, ez], [E, ez - 0.2], [0, R['zr'] - 0.2 * n2])], 'n': 16, 'g': [r4(g[0]), r4(g[1])]})
            if R['covering'] == 'snow':
                pieces.append({'k': 'lathe', 's': 'Snow', 'o': 0.035, 'c': [r4(cx), r4(cy), 0], 'p': [[r4(q[0]), r4(q[1])] for q in ([0, R['zr'] + 0.3], [E - 0.12, ez + 0.3], [E + 0.08, ez + 0.14], [E + 0.02, ez - 0.02], [E - 0.3, ez + 0.3 * K2 - 0.05], [0, R['zr'] - 0.05])], 'n': 16, 'g': [r4(g[0]), r4(g[1])]})
                if not (bi == 0 and plan['topper']): place('roof.spire', cx, cy, R['zr'] + 0.2, 0, -1)
                continue
            ln = 1.2 * tile_scale if thatch else TL; step0 = 0.8 * tile_scale if thatch else K['row'] * tile_scale
            span = Ls - 0.35 - ln; rows = math.floor(span / step0 + 0.5) + 1 if span > 0 else 1; step = span / (rows - 1) if rows > 1 else 0
            for k in range(rows):
                dd = 0.35 + k * step; top = R['zr'] - dd / n2 * K2; r0 = dd / n2
                if thatch:
                    r1 = (dd + ln) / n2; bottom = R['zr'] - (dd + ln) / n2 * K2
                    pieces.append({'k': 'lathe', 's': 'Roof', 'o': 0.045, 'c': [r4(cx), r4(cy), 0], 'p': [[r4(q[0]), r4(q[1])] for q in ([r0, top + 0.02], [r1 + 0.12, bottom - 0.04], [r1 + 0.02, bottom - 0.3], [r0 - 0.1, top - 0.25])], 'n': 16, 'g': [r4(g[0]), r4(g[1])]})
                    continue
                rm = (dd + ln / 2) / n2; circ = 2 * math.pi * rm
                nt = 8 if circ / 8 <= TW * 1.15 else 16 if circ / 16 <= TW * 1.15 else 32
                if circ / nt < 0.45: continue
                for i in range(nt):
                    d = DIRS64[(i * 2 + (k % 2)) * 32 // nt]
                    Dn = [d[0] / n2, d[1] / n2, -K2 / n2]; N = [d[0] * K2 / n2, d[1] * K2 / n2, 1 / n2]
                    tile([cx + d[0] * r0, cy + d[1] * r0, top], [-d[1], d[0], 0], Dn, N, circ / nt - 0.06, ln, TT, 0.07, g)
            if not (bi == 0 and plan['topper']): place('roof.spire', cx, cy, R['zr'] - 0.1, 0, -1)
            continue
        along_x = R['axis'] == 'x'; A = [1, 0, 0] if along_x else [0, 1, 0]; C = [0, 1, 0] if along_x else [1, 0, 0]
        def at(al, ac, z, along_x=along_x): return [al, ac, z] if along_x else [ac, al, z]
        a0, a1 = (b['x0'], b['x1']) if along_x else (b['y0'], b['y1']); c0, c1 = (b['y0'], b['y1']) if along_x else (b['x0'], b['x1'])
        if R['type'] == 'shed':
            outer = c1 if R['dir'] > 0 else c0; run = abs(outer - R['wall']) + K['eave'] + 0.1; Ls = run * n2
            T0 = at(0, R['wall'] - R['dir'] * 0.1, R['zr'] + 0.1 * K2); Dn = mad(sc(C, R['dir'] / n2), ZV, -K2 / n2); N = mad(sc(C, R['dir'] * K2 / n2), ZV, 1 / n2)
            slope(T0, A, Dn, N, Ls, [a0 - R['ends'][0], a1 + R['ends'][1]], [a0 - R['ends'][0], a1 + R['ends'][1]], [R['zr'] - run * K2, R['zr']], R['covering'])
            continue
        hs = (c1 - c0) / 2; cc = (c0 + c1) / 2; E = hs + K['eave']; Ls = E * n2; g = [R['zr'] - E * K2, R['zr']]
        def down(sg, C=C, n2=n2, K2=K2): return [mad(sc(C, sg / n2), ZV, -K2 / n2), mad(sc(C, sg * K2 / n2), ZV, 1 / n2)]
        if R['type'] == 'gable':
            e0 = a0 - R['ends'][0]; e1 = a1 + R['ends'][1]
            for sg in (-1, 1):
                Dn, N = down(sg); slope(at(0, cc, R['zr']), A, Dn, N, Ls, [e0, e1], [e0, e1], g, R['covering'])
            prism('Wall' if b['walls'] == 'mixed' else _wall_slot(b['walls']), 0.025, at(0, cc, 0), C, ZV, A, [[-hs + 0.02, z_plate - 0.02], [hs - 0.02, z_plate - 0.02], [0, R['zr'] - 0.15]], a0, a1, 0.03, [z_plate, R['zr']])
            caps(at(e0 + 0.3, cc, R['zr']), at(e1 - 0.3, cc, R['zr']))
            zb = R['zr'] - K['slab'] * n2 - 0.1
            for i, al, face, line in ((0, e0 + 0.12, '-x' if along_x else '-y', a0 - 0.05), (1, e1 - 0.12, '+x' if along_x else '+y', a1 + 0.05)):
                if R['ends'][i] > 0.15 and not thatch:
                    for sg in (-1, 1): strut('Timber', 0.035, at(al, cc, zb), at(al, cc + sg * (E - 0.05), zb - (E - 0.05) * K2), 0.26, 0.16, A, 0.04, g)
                if not _timber_storey(b, b['storeys'] - 1) or hs * K2 < 1.2 or not _exposed_at(bi, face, cc, blocks, 0.6): continue
                kh = R['zr'] - 0.5 - z_plate
                box('TimberDark', 0.035, at(line, cc, (z_plate + R['zr'] - 0.5) / 2), [0.14, 0.24, kh] if along_x else [0.24, 0.14, kh], 0.04, [z_plate, R['zr']])
                for sg in (-1, 1): strut('TimberDark', 0.035, at(line, cc + sg * 0.78 * hs, z_plate + 0.02), at(line, cc + sg * 0.14, z_plate + 0.58 * hs * K2), 0.2, 0.13, A, 0.04, [z_plate, R['zr']])
            continue
        ha = (a1 - a0) / 2; ca = (a0 + a1) / 2; EA = ha + K['eave']; hr = max(0, ha - hs)
        for sg in (-1, 1):
            Dn, N = down(sg); slope(at(ca, cc, R['zr']), A, Dn, N, Ls, [-EA, EA], [-hr, hr], g, R['covering'])
        for sg in (-1, 1):
            Dn = mad(sc(A, sg / n2), ZV, -K2 / n2); N = mad(sc(A, sg * K2 / n2), ZV, 1 / n2)
            slope(at(ca + sg * hr, cc, R['zr']), C, Dn, N, Ls, [-E, E], [0, 0], g, R['covering'])
        if hr > 0.2: caps(at(ca - hr, cc, R['zr']), at(ca + hr, cc, R['zr']))
        for sa in (-1, 1):
            for sb in (-1, 1): caps(at(ca + sa * hr, cc, R['zr']), at(ca + sa * EA, cc + sb * E, R['zr'] - E * K2))
        if R['type'] == 'pyramid' and not (bi == 0 and plan['topper']): place('roof.spire', ca if along_x else cc, cc if along_x else ca, R['zr'] - 0.1, 0, -1)

    # ---------------------------------------------------------------- openings
    for w in plan['walls']:
        b = blocks[w['b']]; nx, ny = NORMALS[w['face']]; along_x = w['face'] in ('-y', '+y'); z0 = P + w['s'] * H
        timber = _timber_storey(b, w['s']); proud = 0.14 if b['walls'] == 'log' else 0
        for i, c in enumerate(w['cells']):
            qx, qy = _face_point(b, w['face'], c['u']); px = qx + nx * proud; py = qy + ny * proud
            if timber and i > 0:
                u = (w['cells'][i - 1]['u'] + c['u']) / 2; sx, sy = _face_point(b, w['face'], u)
                box('Timber', 0.035, [sx + nx * 0.02, sy + ny * 0.02, z0 + H / 2], [0.24, 0.22, H] if along_x else [0.22, 0.24, H], 0.05, [z0, z0 + H])
            if c['kind'] == 'blank':
                if timber:
                    half = (abs(w['cells'][1]['u'] - w['cells'][0]['u']) if len(w['cells']) > 1 else w['z'] - w['a'] - 1) / 2 - 0.2
                    flip = -1 if c['u'] > (w['a'] + w['z']) / 2 else 1
                    p0 = _face_point(b, w['face'], c['u'] - flip * half); p1 = _face_point(b, w['face'], c['u'] + flip * half)
                    strut('TimberDark', 0.03, [p0[0] + nx * 0.04, p0[1] + ny * 0.04, z0 + 0.3], [p1[0] + nx * 0.04, p1[1] + ny * 0.04, z0 + H - 0.3], 0.2, 0.12, [nx, ny, 0], 0.04, [z0, z0 + H])
                continue
            dims = rules['parts'][c['part']]
            z = P - 0.02 if c['kind'] == 'door' else z0 + 0.25 if c['kind'] in ('oriel', 'banner') else z0 + K['sill']
            idx = place(c['part'], px, py, z, nx, ny)
            if c['kind'] == 'door':
                if st.get('lantern'): hang(st['lantern'], idx, 'lamp', False)
                if st.get('canopy'): hang(st['canopy'], idx, 'canopy', False)
                if st.get('sign'): hang(st['sign'], idx, 'sign', False)
                box('Stone', 0.04, [px + nx * 0.5, py + ny * 0.5, 0.13], [dims['w'] + 0.14, 0.62, 0.26] if along_x else [0.62, dims['w'] + 0.14, 0.26], 0.06, [0, 0.26])
            if c['shutter']: hang(c['shutter'], idx, 'shutter', True)
            if c['sill']: hang(c['sill'], idx, 'sill', False)
            if _storey_slot(b, w['s']) == 'Masonry' and c['kind'] not in ('oriel', 'banner'):
                zl = z + dims['h'] + 0.14
                box('Stone', 0.035, [px + nx * 0.05, py + ny * 0.05, zl], [dims['w'] + 0.3, 0.24, 0.22] if along_x else [0.24, dims['w'] + 0.3, 0.22], 0.05, [zl - 0.11, zl + 0.11])
        if _storey_slot(b, w['s']) == 'Masonry':
            count = math.floor((w['z'] - w['a']) / 1.1)
            for k in range(count):
                u = w['a'] + (k + 0.5 + (j() - 0.5) * 0.6) * (w['z'] - w['a']) / count; zs = z0 + 0.45 + j() * (H - 0.9); sw = 0.46 + 0.3 * j(); sh = 0.24 + 0.12 * j()
                if u < w['a'] + 0.6 or u > w['z'] - 0.6: continue
                if any(c['kind'] != 'blank' and abs(u - c['u']) < rules['parts'][c['part']]['w'] / 2 + sw / 2 + 0.12 for c in w['cells']): continue
                px, py = _face_point(b, w['face'], u)
                box('Stone', 0.03, [px + nx * 0.03, py + ny * 0.03, zs], [sw, 0.16, sh] if along_x else [0.16, sw, sh], 0.05, [zs - sh / 2, zs + sh / 2])
    for a in plan['attics']:
        b = blocks[a['b']]; nx, ny = NORMALS[a['face']]; px, py = _face_point(b, a['face'], a['u'])
        place(a['part'], px, py, b['zTop'] + K['plate'] + 0.22, nx, ny)
    for rg in plan['rings']:
        b = blocks[rg['b']]; R = (b['x1'] - b['x0']) / 2; cx = (b['x0'] + b['x1']) / 2; cy = (b['y0'] + b['y1']) / 2
        for c in rg['cells']:
            d = DIRS64[c['k']]; dims = rules['parts'][c['part']]
            if c['kind'] == 'door':
                t = [-d[1], d[0], 0]; rad = [d[0], d[1], 0]; zt = P + dims['h'] + 0.4
                prism('Stone', 0.04, [cx + d[0] * (R + 0.02), cy + d[1] * (R + 0.02), 0], t, rad, ZV, _rect(dims['w'] + 0.6, 0.64), 0, zt, 0.06, [0, zt])
                idx = place(c['part'], cx + d[0] * (R + 0.34), cy + d[1] * (R + 0.34), P - 0.02, d[0], d[1])
                if st.get('lantern'): hang(st['lantern'], idx, 'lamp', False)
                box('Stone', 0.04, [cx + d[0] * (R + 0.8), cy + d[1] * (R + 0.8), 0.13], [0.9, 0.9, 0.26], 0.06, [0, 0.26])
                continue
            idx = place(c['part'], cx + d[0] * (R - 0.03), cy + d[1] * (R - 0.03), P + c['s'] * H + K['sill'], d[0], d[1])
            if c['sill']: hang(c['sill'], idx, 'sill', False)
        if b['walls'] != 'stone': continue
        for s in range(b['storeys']):
            for k in range(4, 64, 8):
                kk = (k + math.floor(j() * 3)) % 64; zs = P + s * H + 0.5 + j() * (H - 1.0); sw = 0.46 + 0.3 * j(); sh = 0.24 + 0.12 * j()
                if any(c['s'] == s and min(abs(c['k'] - kk), 64 - abs(c['k'] - kk)) < 4 for c in rg['cells']): continue
                d = DIRS64[kk]
                prism('Stone', 0.03, [cx + d[0] * (R + 0.02), cy + d[1] * (R + 0.02), zs], [-d[1], d[0], 0], [d[0], d[1], 0], ZV, _rect(sw, 0.16), -sh / 2, sh / 2, 0.05, [zs - sh / 2, zs + sh / 2])

    # ---------------------------------------------------------------- chimney, dormers, topper, yard
    ch = plan['chimney']
    if ch:
        main = blocks[0]; R = main['roof']; s = 1.0 if ch['kind'] == 'ridge' else 0.95
        if ch['kind'] == 'ridge':
            across = abs(ch['y'] - (main['y0'] + main['y1']) / 2) if R['axis'] == 'x' else abs(ch['x'] - (main['x0'] + main['x1']) / 2)
            x, y, z0 = ch['x'], ch['y'], R['zr'] - across * R['pitch'] - 0.7
        else:
            nx, ny = NORMALS[ch['face']]; px, py = _face_point(main, ch['face'], ch['u']); along_x = ch['face'] in ('-y', '+y')
            box('Stone', 0.04, [px + nx * 0.36, py + ny * 0.36, (main['zTop'] + 0.2) / 2], [1.4, 0.76, main['zTop'] + 0.2] if along_x else [0.76, 1.4, main['zTop'] + 0.2], 0.06, [0, main['zTop']])
            x, y, z0 = px + nx * 0.32, py + ny * 0.32, main['zTop']
        zc = max(ch['top'] - 1.62, z0 + 0.1)
        box('Stone', 0.04, [x, y, (z0 + zc) / 2], [s, s, zc - z0], 0.06, [z0, ch['top']])
        z = zc
        for rr in range(3):
            off = ch['lean'] * (rr + 1); h = 0.44
            halves = [[[0.52 * s, 1.08 * s], [-0.27 * s, 0]], [[0.52 * s, 1.08 * s], [0.27 * s, 0]]] if rr % 2 == 0 else [[[1.08 * s, 0.52 * s], [0, -0.27 * s]], [[1.08 * s, 0.52 * s], [0, 0.27 * s]]]
            for (hx, hy), (ox, oy) in halves:
                box('Stone', 0.04, [x + ox + off, y + oy, z + h / 2], [hx * (0.97 + 0.06 * j()), hy * (0.97 + 0.06 * j()), h - 0.03], 0.06, [z0, ch['top']])
            z += h
        off = ch['lean'] * 3
        box('Stone', 0.04, [x + off, y, z + 0.15], [1.3 * s, 1.3 * s, 0.3], 0.06, [z0, ch['top']])
        cap = 0.16 if blocks[0]['roof']['covering'] == 'snow' else 0
        if cap: box('Snow', 0.035, [x + off, y, z + 0.3 + cap / 2], [1.24 * s, 1.24 * s, cap + 0.04], 0.07, [z0, ch['top']])
        box('StoneDark', 0, [x + off, y, z + 0.32 + cap], [0.62 * s, 0.62 * s, 0.05], 0.01, [z0, ch['top']])
        if ch['pot']: place('chimney.pot', x + off, y, z + 0.3 + cap, 0, -1)
    for d in plan['dormers']: place(d['part'], d['x'], d['y'], d['z'], 0, -1)
    if plan['topper']: place(plan['topper']['part'], plan['topper']['x'], plan['topper']['y'], plan['topper']['z'], 0, -1)
    if plan['yard']: place(plan['yard']['part'], plan['yard']['x'], plan['yard']['y'], 0, plan['yard']['nx'], plan['yard']['ny'])
    return {'pieces': pieces, 'parts': parts}


def house_digest(built):
    """src/world/houseGrammar.js houseDigest: every number at 1e-4, hashed."""
    def num(v): return str(math.floor(v * 10000 + 0.5))
    def flat(a): return ','.join(flat(v) if isinstance(v, list) else num(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v) for v in a)
    def cell(v): return flat(v) if isinstance(v, list) else num(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v
    rows = []
    for p in built['pieces']:
        fields = [p['k'], p['s'], p['o'], p['f'], p['p'], p['w'], p['b'], p['g'], p['r']] if p['k'] == 'prism' else [p['k'], p['s'], p['o'], p['c'], p['p'], p['n'], p['g']]
        rows.append('|'.join(cell(v) for v in fields))
    for p in built['parts']:
        rows.append('%s|%s' % (p['id'], flat(p['m'])) if 'm' in p else '%s|%d|%s|%d' % (p['id'], p['on'], p['socket'], 1 if p['pair'] else 0))
    return {'pieces': len(built['pieces']), 'parts': len(built['parts']), 'hash': hash_seed('\n'.join(rows))}

# ---------------------------------------------------------------- flat-roofed families (the desert village)
#
# A family with "form": "flat" is built from flat-roofed blocks: rounded plaster (or sandstone) walls, a parapet
# round every roof, beam ends (vigas) under it, and one ground-level annex (a lower wing, a wing with an outside stair
# up to its roof terrace, or a walled courtyard in front with a gateway) plus one roof crown (a roof room set back on
# the roof, a dome on a drum, or the lookout's shelter). Blocks carry z0, so a roof room stands on its house; a wall is
# covered by a neighbour only where the neighbour stands at that height.

FLAT_CORNERS = ((1, -1, 48), (1, 1, 0), (-1, 1, 16), (-1, -1, 32))   # rect corners, CCW from the front-right, with the arc's first direction


def _flat_block(id_, x0, x1, y0, y1, z0, storeys, walls, z_top, ph):
    return {'id': id_, 'shape': 'rect', 'x0': r4(x0), 'x1': r4(x1), 'y0': r4(y0), 'y1': r4(y1), 'z0': r4(z0), 'storeys': storeys, 'zTop': r4(z_top),
            'walls': walls, 'roof': {'type': 'flat', 'parapet': r4(ph), 'zr': r4(z_top + ph)}}


def _inside_z(x, y, z, blocks, skip):
    for i, b in enumerate(blocks):
        if i != skip and b['z0'] - 0.01 < z < b['zTop'] + 0.01 and b['x0'] + 0.01 < x < b['x1'] - 0.01 and b['y0'] + 0.01 < y < b['y1'] - 0.01: return True
    return False


def _flat_spans(bi, face, blocks, z):
    """The stretches of a face no other block covers AT HEIGHT z: [[a, z, cornerA, cornerZ]]."""
    b = blocks[bi]; along_x = face in ('-y', '+y')
    line = b['y0'] if face == '-y' else b['y1'] if face == '+y' else b['x0'] if face == '-x' else b['x1']
    lo, hi = (b['x0'], b['x1']) if along_x else (b['y0'], b['y1'])
    spans = [[lo, hi]]
    for i, o in enumerate(blocks):
        if i == bi or not (o['z0'] - 0.01 < z < o['zTop'] + 0.01): continue
        p0, p1 = (o['y0'], o['y1']) if along_x else (o['x0'], o['x1'])
        if not (p0 + 0.01 < line < p1 - 0.01): continue
        c0, c1 = (o['x0'], o['x1']) if along_x else (o['y0'], o['y1'])
        nxt = []
        for a, zz in spans:
            if c1 <= a or c0 >= zz: nxt.append([a, zz]); continue
            if c0 > a: nxt.append([a, c0])
            if c1 < zz: nxt.append([c1, zz])
        spans = nxt
    out = []
    for a, zz in spans:
        if zz - a < 0.3: continue
        pa, pz = _face_point(b, face, a), _face_point(b, face, zz)
        out.append([r4(a), r4(zz), a == lo and not _inside_z(pa[0], pa[1], z, blocks, bi), zz == hi and not _inside_z(pz[0], pz[1], z, blocks, bi)])
    return out


def _flat_extent(blocks, court, stair, pad, fp):
    x0, x1, y0, y1 = math.inf, -math.inf, math.inf, -math.inf
    for i, b in enumerate(blocks):
        if b['z0'] > 1.0: continue
        x0 = min(x0, b['x0'] - pad); x1 = max(x1, b['x1'] + pad); y0 = min(y0, b['y0'] - (fp if i == 0 else pad)); y1 = max(y1, b['y1'] + pad)
    for R in (court, stair):
        if R: x0 = min(x0, R['x0'] - 0.1); x1 = max(x1, R['x1'] + 0.1); y0 = min(y0, R['y0'] - 0.1); y1 = max(y1, R['y1'] + 0.1)
    return x0, x1, y0, y1


def _flat_fits(blocks, court, stair, lot, pad, fp):
    x0, x1, y0, y1 = _flat_extent(blocks, court, stair, pad, fp)
    return x1 - x0 <= lot['w'] + 1e-6 and y1 - y0 <= lot['d'] + 1e-6


def _flat_massing(rules, F, style, dna, m, lot):
    K, FK, M = rules['kit'], rules['flat'], F['mass']; P = K['plinth']

    def gene(g): return _clamp01(0.75 * g + 0.25 * m())
    H = snap(K['storey'] * (0.96 + 0.08 * m()))
    span = snap(mix(M['span'], gene(dna['size'])))
    length = snap(mix(M['length'], gene(dna['size'])))
    ph = snap(mix(FK['parapet'], gene(dna['ornament'])))
    a = [m() for _ in range(8)]
    if M.get('square'): length = span
    n = M['storeys'][0] + min(M['storeys'][1] - M['storeys'][0], math.floor(dna['tall'] * (M['storeys'][1] - M['storeys'][0] + 1)))
    pad = FK['pad']; fp = max(pad, rules['parts'].get(style.get('canopy') or '', {}).get('out', 0))
    walls = style.get('walls') or 'adobe'; annex = style.get('annex'); CT = FK['court']; T = FK['wall']
    ww = snap(2.4 + 1.0 * a[1]) if annex == 'wing' else snap(3.3 + 0.7 * a[1]) if annex == 'terrace' else 0
    cd = snap(mix(CT['depth'], a[2])) if annex == 'court' else 0
    W = max(M['span'][0] * 0.8, min(length, snap(lot['w'] - 2 * pad - ww)))
    D = max(M['span'][0] * 0.8, min(span, snap(lot['d'] - pad - fp - (cd + CT['t'] if cd else 0))))
    main = _flat_block('main', -W / 2, W / 2, -D / 2, D / 2, P, n, walls, P + n * H, ph)
    blocks = [main]; court = stair = None
    if annex in ('wing', 'terrace'):
        faces = ['+x', '-x']; first = math.floor(a[0] * 2)
        for i in range(2):
            sg = 1 if faces[(first + i) % 2] == '+x' else -1
            wd = snap(max(2.4, D - FK['stair']['w'] - 0.3)) if annex == 'terrace' else snap(max(2.4, min(D - 0.4, D * (0.55 + 0.3 * a[2]))))
            back = annex == 'terrace' or a[3] >= 0.5
            y0 = main['y1'] - wd if back else main['y0']; y1 = main['y1'] if back else main['y0'] + wd
            x0 = main['x1'] - 0.3 if sg > 0 else main['x0'] - ww; x1 = main['x1'] + ww if sg > 0 else main['x0'] + 0.3
            w = _flat_block('wing', x0, x1, y0, y1, P, 1, walls, P + H, snap(ph * 0.85) if n > 1 else snap(max(0.25, ph - 0.25)))
            st = None
            if annex == 'terrace':
                inner = x0 + 0.65 if sg > 0 else x1 - 0.65; outer = x1 if sg > 0 else x0
                st = {'x0': r4(min(inner, outer)), 'x1': r4(max(inner, outer)), 'y0': r4(y0 - FK['stair']['w']), 'y1': r4(y0), 'dir': sg, 'top': w['zTop']}
            if _flat_fits(blocks + [w], None, st, lot, pad, fp):
                blocks.append(w); stair = st; break
    elif annex == 'court':
        c = {'x0': main['x0'], 'x1': main['x1'], 'y0': r4(main['y0'] - cd - CT['t']), 'y1': main['y0'], 't': CT['t'], 'h': snap(mix(CT['h'], a[4])), 'gate': None}
        if _flat_fits(blocks, c, None, lot, pad, fp): court = c
    # centre the whole house (courtyard and stair included) on the lot
    x0, x1, y0, y1 = _flat_extent(blocks, court, stair, pad, fp); dx = snap(-(x0 + x1) / 2); dy = snap(-(y0 + y1) / 2)
    for R in blocks + [q for q in (court, stair) if q]:
        R['x0'] = r4(R['x0'] + dx); R['x1'] = r4(R['x1'] + dx); R['y0'] = r4(R['y0'] + dy); R['y1'] = r4(R['y1'] + dy)
    # the crown on the main roof
    dome = None
    if style.get('crown') == 'loft':
        lw = snap(max(2.2, (W - 2 * T) * (0.45 + 0.2 * a[6]))); ld = snap(max(2.2, (D - 2 * T) * (0.45 + 0.2 * a[7])))
        ly1 = main['y1'] - T; lx0 = main['x0'] + T if a[5] < 0.5 else main['x1'] - T - lw
        blocks.append(_flat_block('loft', lx0, lx0 + lw, ly1 - ld, ly1, main['zTop'], 1, 'stone' if walls == 'stone' else 'adobe', main['zTop'] + snap(H * 0.92), snap(ph * 0.85)))
    elif style.get('crown') == 'dome':
        R = r4(min(max(FK['dome']['r'][0], min(W, D) * 0.3), FK['dome']['r'][1]))
        cx = (main['x0'] + main['x1']) / 2 + (a[5] - 0.5) * max(0, W / 2 - R - T - 0.3); cy = (main['y0'] + main['y1']) / 2 + max(0, D / 2 - R - T - 0.3) * 0.5
        dome = {'x': r4(cx), 'y': r4(cy), 'r': R, 'z0': main['zTop'], 'drum': FK['dome']['drum'], 'top': r4(main['zTop'] + FK['dome']['drum'] + 1.03 * R)}
    return blocks, H, court, stair, dome


def _flat_facades(rules, F, style, dna, f, blocks, stair):
    K, FC, FK = rules['kit'], rules['facade'], rules['flat']; bay = F['mass']['bay'] * (1.15 - 0.3 * dna['ornament'])
    walls = []; dw = rules['parts'][style['door']]['w']; P = K['plinth']
    door_si = -1; width = 0
    for si, (a, z, ca, cz) in enumerate(_flat_spans(0, '-y', blocks, P + 0.5)):
        usable = z - a - (0.5 if ca else 0.35) - (0.5 if cz else 0.35)
        if usable >= dw + 0.3 and z - a > width: door_si, width = si, z - a
    if door_si < 0: raise ValueError('House: no front wall takes a door')
    door_roll = f()
    for bi, b in enumerate(blocks):
        hb = (b['zTop'] - b['z0']) / b['storeys']
        for face in FACES:
            kind = 'front' if face == '-y' else 'back' if face == '+y' else 'side'
            if stair and b['id'] == 'wing' and face == '-y': continue
            for s in range(b['storeys']):
                for si, (a, z, ca, cz) in enumerate(_flat_spans(bi, face, blocks, b['z0'] + (s + 0.5) * hb)):
                    us = _bays(a, z, ca, cz, bay, K); n = len(us)
                    rolls = [f() for _ in us]
                    is_door = bi == 0 and face == '-y' and s == 0 and si == door_si
                    door_at = ((n - 1) / 2 if n % 2 else n / 2 - (1 if door_roll < 0.5 else 0)) if is_door else (n - 1) // 2 if b['id'] == 'loft' and face == '-y' and n else -1
                    middle = (n - 1) / 2 if n % 2 and bi == 0 and face == '-y' else -1
                    cells = []
                    for i, u in enumerate(us):
                        if i == door_at: cells.append(_cell(u, 'door', style['door'] if is_door else FK['roofDoor'])); continue
                        up = style.get('upper')
                        if i == middle and s >= 1 and s == b['storeys'] - 1 and up in ('win.mashrabiya', 'banner.tall'): cells.append(_cell(u, 'oriel' if up == 'win.mashrabiya' else 'banner', up)); continue
                        balcony = i == middle and s == 1 and up == 'balcony.desert'
                        if not balcony and rolls[min(i, n - 1 - i)] >= FC[kind]: cells.append(_cell(u, 'blank')); continue
                        sill = 'balcony.desert' if balcony else style['flowers'] if style.get('flowers') and s == 0 and kind != 'back' else None
                        cells.append(_cell(u, 'window', style['window'], style.get('shutters'), sill))
                    for i in range(1, n):
                        p, q = cells[i - 1], cells[i]
                        if p['kind'] == 'blank' or q['kind'] == 'blank' or q['u'] - p['u'] >= (rules['parts'][p['part']]['w'] + rules['parts'][q['part']]['w']) / 2 + 0.08: continue
                        if q['kind'] == 'window': cells[i] = _cell(q['u'], 'blank')
                        elif p['kind'] == 'window': cells[i - 1] = _cell(p['u'], 'blank')
                    walls.append({'b': bi, 'face': face, 'a': a, 'z': z, 'ca': ca, 'cz': cz, 's': s, 'cells': cells})
    return walls


def _flat_details(rules, style, dna, x, blocks, walls, court, dome, H):
    FK = rules['flat']; main = blocks[0]; T = FK['wall']; r = [x(), x(), x(), x(), x(), x(), x(), x()]
    chimney = topper = yard = None
    loft = next((b for b in blocks if b['id'] == 'loft'), None)
    if style.get('chimney') == 'stack':
        side = -1 if r[0] < 0.5 else 1
        if loft and (loft['x0'] + loft['x1']) / 2 * side > (main['x0'] + main['x1']) / 2 * side: side = -side
        cx = main['x0'] + T + 0.55 if side < 0 else main['x1'] - T - 0.55
        chimney = {'kind': 'stack', 'x': r4(cx), 'y': r4(main['y1'] - T - 0.55), 'z0': main['zTop'], 'top': r4(main['roof']['zr'] + 0.75 + 0.5 * dna['whimsy'])}
    if style.get('topper'):
        if dome: topper = {'part': style['topper'], 'x': dome['x'], 'y': dome['y'], 'z': r4(dome['top'] - 0.06), 's': 1}
        elif style.get('crown') == 'lookout':
            s = r4(min(main['x1'] - main['x0'], main['y1'] - main['y0']) / 3.9)
            topper = {'part': style['topper'], 'x': r4((main['x0'] + main['x1']) / 2), 'y': r4((main['y0'] + main['y1']) / 2), 'z': main['zTop'], 's': s}
    front = next((w for w in walls if w['b'] == 0 and w['face'] == '-y' and w['s'] == 0 and any(c['kind'] == 'door' for c in w['cells'])), None)
    d = next(c for c in front['cells'] if c['kind'] == 'door')['u']
    if court: court['gate'] = {'u': d, 'part': FK['court']['gate']}
    if style.get('yard'):
        u = front['a'] + 0.8 if abs(front['a'] + 0.8 - d) > abs(front['z'] - 0.8 - d) else front['z'] - 0.8
        yard = {'part': style['yard'], 'x': r4(u), 'y': r4(main['y0'] - 0.8), 'nx': 0, 'ny': -1}
    return chimney, topper, yard


def _generate_flat(rules, F, family, k, L, dna, palette, style):
    K = rules['kit']; FK = rules['flat']
    blocks, H, court, stair, dome = _flat_massing(rules, F, style, dna, house_rng(family, k, 'mass'), L)
    walls = _flat_facades(rules, F, style, dna, house_rng(family, k, 'facade'), blocks, stair)
    chimney, topper, yard = _flat_details(rules, style, dna, house_rng(family, k, 'detail'), blocks, walls, court, dome, H)
    ground = [b for b in blocks if b['z0'] < 1.0]
    top = max([b['roof']['zr'] for b in blocks] + [dome['top'] if dome else 0, chimney['top'] if chimney else 0])
    colliders = [{'x0': b['x0'], 'x1': b['x1'], 'y0': b['y0'], 'y1': b['y1'], 'h': r4(top if i == 0 else b['roof']['zr'])} for i, b in enumerate(ground)]
    if stair: colliders.append({'x0': stair['x0'], 'x1': stair['x1'], 'y0': stair['y0'], 'y1': stair['y1'], 'h': stair['top']})
    if court:
        t = court['t']; g = court['gate']; half = FK['court']['gw'] / 2 + 0.46
        colliders.append({'x0': court['x0'], 'x1': r4(court['x0'] + t), 'y0': court['y0'], 'y1': court['y1'], 'h': court['h']})
        colliders.append({'x0': r4(court['x1'] - t), 'x1': court['x1'], 'y0': court['y0'], 'y1': court['y1'], 'h': court['h']})
        for a0, a1 in ((court['x0'] + t, g['u'] - half), (g['u'] + half, court['x1'] - t)):
            if a1 - a0 > 0.2: colliders.append({'x0': r4(a0), 'x1': r4(a1), 'y0': court['y0'], 'y1': r4(court['y0'] + t), 'h': court['h']})
    x0, x1, y0, y1 = _flat_extent(blocks, court, stair, FK['pad'], max(FK['pad'], rules['parts'].get(style.get('canopy') or '', {}).get('out', 0)))
    return {'version': HOUSE_GRAMMAR_VERSION, 'form': 'flat', 'family': family, 'key': k, 'lot': L, 'dna': dna, 'palette': palette, 'colors': rules['colors'], 'style': style,
            'storey': H, 'tile': 1, 'blocks': blocks, 'walls': walls, 'rings': [], 'attics': [], 'chimney': chimney, 'dormers': [], 'topper': topper, 'yard': yard,
            'court': court, 'stair': stair, 'dome': dome, 'colliders': colliders, 'bounds': [r4(x0), r4(x1), r4(y0), r4(y1), r4(top)]}


def _round_rect(x0, x1, y0, y1, rc, cx, cy):
    """A rounded rectangle as a convex polygon (3 points per corner, from DIRS64), relative to (cx, cy)."""
    pts = []
    for sx, sy, k0 in FLAT_CORNERS:
        ox = (x1 - rc if sx > 0 else x0 + rc) - cx; oy = (y1 - rc if sy > 0 else y0 + rc) - cy
        for q in range(3):
            d = DIRS64[(k0 + q * 8) % 64]
            pts.append([ox + d[0] * rc, oy + d[1] * rc])
    return pts


def _build_flat(rules, plan):
    K, FK = rules['kit'], rules['flat']; P = K['plinth']; H = plan['storey']; blocks = plan['blocks']; st = plan['style']
    rc, T = FK['round'], FK['wall']
    pieces, parts = [], []

    def prism(s, o, org, u, v, w, poly, w0, w1, bev, g, round_=False):
        pieces.append({'k': 'prism', 's': s, 'o': o, 'f': [r4(x) for x in list(org) + list(u) + list(v) + list(w)], 'p': [[r4(q[0]), r4(q[1])] for q in poly],
                       'w': [r4(w0), r4(w1)], 'b': bev, 'g': [r4(g[0]), r4(g[1])], 'r': 1 if round_ else 0})

    def box(s, o, c, size, bev, g):
        prism(s, o, c, [1, 0, 0], [0, 1, 0], ZV, _rect(size[0], size[1]), -size[2] / 2, size[2] / 2, bev, g)

    def lathe(s, o, c, prof, n, g):
        pieces.append({'k': 'lathe', 's': s, 'o': o, 'c': [r4(c[0]), r4(c[1]), 0], 'p': [[r4(q[0]), r4(q[1])] for q in prof], 'n': n, 'g': [r4(g[0]), r4(g[1])]})

    def place(id_, x, y, z, nx, ny, s=1):
        parts.append({'id': id_, 'm': [r4(v) for v in (x, y, z, -ny * s, nx * s, 0, -nx * s, -ny * s, 0, 0, 0, s)]})
        return len(parts) - 1

    def hang(id_, on, socket, pair):
        parts.append({'id': id_, 'on': on, 'socket': socket, 'pair': pair})

    def slot_of(b, s): return ('Masonry' if s == 0 else 'Wall') if b['walls'] == 'mixed' else 'Masonry' if b['walls'] == 'stone' else 'Wall'

    def column(s, x, y, z0, z1, r, g):
        prism(s, 0.03, [x, y, 0], [1, 0, 0], [0, 1, 0], ZV, [[DIRS64[k * 8][0] * r, DIRS64[k * 8][1] * r] for k in range(8)], z0, z1, 0.05, g, True)

    for bi, b in enumerate(blocks):
        cx, cy = (b['x0'] + b['x1']) / 2, (b['y0'] + b['y1']) / 2; ground = b['z0'] < 1.0
        hb = (b['zTop'] - b['z0']) / b['storeys']; ph = b['roof']['parapet']; zt = b['zTop']
        # the plinth band under a ground block, then one rounded wall prism per run of storeys with the same colour slot
        if ground: prism('Stone', 0.04, [cx, cy, 0], [1, 0, 0], [0, 1, 0], ZV, _round_rect(b['x0'] - 0.07, b['x1'] + 0.07, b['y0'] - 0.07, b['y1'] + 0.07, rc + 0.07, cx, cy), -0.05, P + 0.02, 0.06, [0, P])
        s0 = 0
        for s in range(1, b['storeys'] + 1):
            if s < b['storeys'] and slot_of(b, s) == slot_of(b, s0): continue
            z0 = b['z0'] + s0 * hb - (0 if ground else 0.02); z1 = zt + 0.02 if s == b['storeys'] else b['z0'] + s * hb
            prism(slot_of(b, s0), 0.025, [cx, cy, 0], [1, 0, 0], [0, 1, 0], ZV, _round_rect(b['x0'], b['x1'], b['y0'], b['y1'], rc, cx, cy), z0, z1, 0.05, [z0, z1])
            s0 = s
        # the parapet: straight runs on the exposed stretches, a round column at every exposed corner
        top = slot_of(b, b['storeys'] - 1); zp = zt + ph / 2; kind = st.get('parapet') or 'plain'
        for face in FACES:
            nx, ny = NORMALS[face]; along_x = face in ('-y', '+y')
            for a, z, ca, cz in _flat_spans(bi, face, blocks, zp):
                a0 = a + (rc if ca else 0); a1 = z - (rc if cz else 0)
                if plan['stair'] and b['id'] == 'wing' and face == '-y':
                    # the parapet opens where the stair arrives on the terrace
                    S = plan['stair']
                    if S['dir'] > 0: a0 = max(a0, S['x0'] + 0.9)
                    else: a1 = min(a1, S['x1'] - 0.9)
                if a1 - a0 < 0.25: continue
                px, py = _face_point(b, face, (a0 + a1) / 2); ox, oy = px - nx * T / 2, py - ny * T / 2
                if kind == 'crenel':
                    lo = ph * 0.55
                    box(top, 0.03, [ox, oy, zt + lo / 2], [a1 - a0, T, lo] if along_x else [T, a1 - a0, lo], 0.06, [zt, zt + ph])
                    cnt = max(1, math.floor((a1 - a0) / 0.95))
                    for q in range(cnt):
                        u = a0 + (q + 0.5) * (a1 - a0) / cnt; qx, qy = _face_point(b, face, u)
                        box(top, 0.03, [qx - nx * T / 2, qy - ny * T / 2, zt + (ph + 0.2) / 2], [0.55, T + 0.02, ph + 0.2] if along_x else [T + 0.02, 0.55, ph + 0.2], 0.07, [zt, zt + ph + 0.2])
                else:
                    box(top, 0.03, [ox, oy, zt + ph / 2], [a1 - a0, T, ph] if along_x else [T, a1 - a0, ph], 0.09, [zt, zt + ph])
                    if kind == 'stepped' and face == '-y' and a1 - a0 > 2.2:
                        sw = snap((a1 - a0) / 3); box(top, 0.03, [ox, oy, zt + (ph + 0.32) / 2], [sw, T + 0.02, ph + 0.32], 0.09, [zt, zt + ph + 0.32])
                if b['walls'] != 'stone' and face != '+y':
                    # beam ends under the parapet, evenly along the run
                    cnt = math.floor((a1 - a0) / FK['viga'])
                    for q in range(cnt):
                        u = a0 + (q + 0.5) * (a1 - a0) / cnt; qx, qy = _face_point(b, face, u)
                        box('Timber', 0.03, [qx + nx * 0.14, qy + ny * 0.14, zt - 0.16], [0.17, 0.34, 0.17] if along_x else [0.34, 0.17, 0.17], 0.04, [zt - 0.3, zt])
                if top == 'Masonry':
                    box('Stone', 0.03, [ox, oy, zt + ph + 0.05], [a1 - a0 + 0.04, T + 0.08, 0.1] if along_x else [T + 0.08, a1 - a0 + 0.04, 0.1], 0.04, [zt + ph, zt + ph + 0.1])
        for sx, sy, _ in FLAT_CORNERS:
            x = b['x1'] if sx > 0 else b['x0']; y = b['y1'] if sy > 0 else b['y0']
            if _inside_z(x - sx * 0.05, y - sy * 0.05, zp, blocks, bi): continue
            lift = 0.3 if kind == 'stepped' else 0.2 if kind == 'crenel' else 0.0
            column(top, x - sx * rc, y - sy * rc, zt, zt + ph + lift, rc, [zt, zt + ph + lift])
    # openings
    for w in plan['walls']:
        b = blocks[w['b']]; nx, ny = NORMALS[w['face']]; along_x = w['face'] in ('-y', '+y')
        hb = (b['zTop'] - b['z0']) / b['storeys']; z0 = b['z0'] + w['s'] * hb; slot = slot_of(b, w['s'])
        for c in w['cells']:
            if c['kind'] == 'blank': continue
            px, py = _face_point(b, w['face'], c['u']); dims = rules['parts'][c['part']]
            z = z0 - 0.02 if c['kind'] == 'door' else z0 + 0.25 if c['kind'] in ('oriel', 'banner') else z0 + K['sill']
            idx = place(c['part'], px, py, z, nx, ny)
            if c['kind'] == 'door':
                if z0 < 1.0:
                    if st.get('lantern'): hang(st['lantern'], idx, 'lamp', False)
                    if st.get('canopy'): hang(st['canopy'], idx, 'canopy', False)
                    if st.get('sign'): hang(st['sign'], idx, 'sign', False)
                    box('Stone', 0.04, [px + nx * 0.5, py + ny * 0.5, 0.13], [dims['w'] + 0.14, 0.62, 0.26] if along_x else [0.62, dims['w'] + 0.14, 0.26], 0.06, [0, 0.26])
            if c.get('shutter'): hang(c['shutter'], idx, 'shutter', True)
            if c.get('sill'): hang(c['sill'], idx, 'sill', False)
    # the walled courtyard: side walls, the front wall either side of the gateway, stone caps, a paved yard
    C = plan['court']
    if C:
        t, ch = C['t'], C['h']; g = C['gate']; half = FK['court']['gw'] / 2 + 0.46; wslot = slot_of(blocks[0], 0)
        runs = [(C['x0'] + t / 2, C['y0'], C['x0'] + t / 2, C['y1']), (C['x1'] - t / 2, C['y0'], C['x1'] - t / 2, C['y1']),
                (C['x0'], C['y0'] + t / 2, g['u'] - half + 0.1, C['y0'] + t / 2), (g['u'] + half - 0.1, C['y0'] + t / 2, C['x1'], C['y0'] + t / 2)]
        for ax, ay, bx, by in runs:
            ln = abs(bx - ax) + abs(by - ay)
            if ln < 0.3: continue
            mx, my = (ax + bx) / 2, (ay + by) / 2; along = abs(bx - ax) > abs(by - ay)
            box(wslot, 0.03, [mx, my, ch / 2], [ln, t, ch] if along else [t, ln, ch], 0.1, [0, ch])
            box('Stone', 0.03, [mx, my, ch + 0.06], [ln + 0.08, t + 0.1, 0.12] if along else [t + 0.1, ln + 0.08, 0.12], 0.04, [ch, ch + 0.12])
        box('Stone', 0.0, [(C['x0'] + C['x1']) / 2, (C['y0'] + t + C['y1']) / 2, 0.02], [C['x1'] - C['x0'] - 2 * t, C['y1'] - C['y0'] - t, 0.05], 0.02, [0, 0.05])
        place(g['part'], g['u'], C['y0'] + t / 2, 0, 0, -1)
    # the outside stair up to the wing's roof terrace: one solid cheek under the flight, a tread per step on it, and a
    # low rail along the open side
    S = plan['stair']
    if S:
        n = max(3, math.ceil(S['top'] / FK['stair']['rise'])); L = S['x1'] - S['x0']; tr = L / n; rs = S['top'] / n; wslot = slot_of(blocks[1], 0)
        lo, hi = (S['x1'], S['x0']) if S['dir'] > 0 else (S['x0'], S['x1'])
        ymid = (S['y0'] + S['y1']) / 2; wd = S['y1'] - S['y0']
        prism(wslot, 0.03, [0, ymid, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [[lo, 0.0], [hi, 0.0], [hi, S['top'] - rs]], -wd / 2, wd / 2, 0.04, [0, S['top']])
        for i in range(n):
            xc = lo + (hi - lo) * (i + 0.5) / n; z0 = max(0.0, (i - 1) * rs); z1 = (i + 1) * rs
            box('Stone', 0.03, [xc, ymid, (z0 + z1) / 2], [tr + 0.01, wd, z1 - z0], 0.03, [0, S['top']])
        prism(wslot, 0.03, [0, S['y0'] + 0.1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [[lo, rs], [lo, rs + 0.5], [hi, S['top'] + 0.5], [hi, S['top']]], -0.1, 0.1, 0.05, [0, S['top'] + 0.5])
    # the dome: a drum, then the dome itself, its finial the topper
    D = plan['dome']
    if D:
        R, zb = D['r'], D['z0'] + D['drum']
        lathe(slot_of(blocks[0], blocks[0]['storeys'] - 1), 0.03, [D['x'], D['y']], [[0, D['z0'] - 0.05], [R + 0.12, D['z0'] - 0.05], [R + 0.12, zb], [0, zb]], 16, [D['z0'], zb])
        lathe('Roof', 0.04, [D['x'], D['y']], [[0, zb - 0.02], [R * 1.02, zb - 0.02], [R * 1.02, zb + 0.08], [R * 0.97, zb + 0.36 * R], [R * 0.86, zb + 0.62 * R],
                                                 [R * 0.66, zb + 0.84 * R], [R * 0.38, zb + 0.98 * R], [0, zb + 1.03 * R]], 16, [zb, zb + 1.03 * R])
    # the chimney stack, vents near its top
    ch = plan['chimney']
    if ch:
        box('Wall', 0.03, [ch['x'], ch['y'], (ch['z0'] + ch['top']) / 2], [0.9, 0.9, ch['top'] - ch['z0']], 0.07, [ch['z0'], ch['top']])
        box('Stone', 0.03, [ch['x'], ch['y'], ch['top'] + 0.07], [1.1, 1.1, 0.14], 0.04, [ch['top'], ch['top'] + 0.14])
        for q in (-1, 1): box('StoneDark', 0.0, [ch['x'], ch['y'] + q * 0.45, ch['top'] - 0.3], [0.44, 0.04, 0.22], 0.0, [ch['top'] - 0.4, ch['top']])
    tp = plan['topper']
    if tp: place(tp['part'], tp['x'], tp['y'], tp['z'], 0, -1, tp['s'])
    if plan['yard']: place(plan['yard']['part'], plan['yard']['x'], plan['yard']['y'], 0, plan['yard']['nx'], plan['yard']['ny'])
    return {'pieces': pieces, 'parts': parts}

# ---------------------------------------------------------------- fixtures


def _overlay(base, patch):
    """src/world/pack.js overlay: objects merge key by key, arrays and plain values replace, None deletes."""
    if patch is None: return None
    if not isinstance(patch, dict) or not isinstance(base, dict): return patch
    out = dict(base)
    for k, v in patch.items():
        m = _overlay(base.get(k), v)
        if m is None: out.pop(k, None)
        else: out[k] = m
    return out


def apply_biome(manifest, biome):
    """src/world/pack.js applyBiome: the manifest as a biome sees it (the theme's own world when biome is None)."""
    B = (manifest.get('biomes') or {}).get(biome) if biome else None
    if not B: return manifest
    out = dict(manifest); whole = set(B.get('replace') or [])
    for key, value in B.items():
        if key in ('label', 'blurb', 'replace'): continue
        if key == 'props':
            out['props'] = [dict(p, **value[p['id']]) if value.get(p['id']) else p for p in manifest.get('props', []) if not (p['id'] in value and value[p['id']] is None)]
            continue
        if key in whole: out[key] = value
        else:
            m = _overlay(manifest.get(key), value)
            if m is None: out.pop(key, None)
            else: out[key] = m
    return out


def house_fixture_cases(rules, lots=None):
    """Every family over a spread of keys (enough to reach every annex, roof and covering); with `lots` (the world's
    lot per family) every other case builds on its village lot, as the layout does."""
    cases = [{'family': fam, 'key': key} for fam in rules['families'] for key in
             ['K7QN-3F2A-9XBD|0', 'TEST-1234-ABCD|7', 12345] + ['fx|%d' % i for i in range(22)]]
    if lots:
        for i, c in enumerate(cases):
            if i % 2 and c['family'] in lots: c['lot'] = {'w': lots[c['family']][0], 'd': lots[c['family']][1]}
    return cases


def write_house_fixtures(pack_path, out_path, biome=None):
    pack = apply_biome(json.load(open(pack_path)), biome); rules = pack['houses']; data = []
    lots = (pack.get('world') or {}).get('houses', {}).get('lots') if biome else None
    for c in house_fixture_cases(rules, lots):
        plan = generate_house(rules, c['family'], c['key'], c.get('lot'))
        data.append({'request': c, 'plan': plan, 'built': house_digest(build_house(rules, plan))})
    with open(out_path, 'w') as f: f.write(json.dumps(data, separators=(',', ':')) + '\n')
    return len(data)


if __name__ == '__main__':
    import sys
    print(write_house_fixtures(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
