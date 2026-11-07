"""Python port of src/world/worldLandmarks.js and src/world/routeGraph.js: the seeded graph grammar that places
the village's landmarks (windmill, watermill, well, market stalls, lookout, orchard, farm plot) on the relief and
the water, and the route graph that chains them from the spawn with typed hooks.

Keep it in lockstep with the JS (see PARITY RULES in the JS header): every expression in the same operand order,
every stream drawn in the same order whatever branch is taken, numbers out through r4, integer loop counters, ties
on the lower index. Exec inside Blender after world_terrain.py and before world_grammar.py (same globals), or import
it under python3 (world_grammar.py does, for the fixtures).
"""
import math

try:
    hash_seed, mulberry32, generate_tree, hash3, poly_project, k_near, join_pad, ramp_spurs, rect_stats, _slab, _disc, water_blocks, DIRS64
except NameError:
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from creature_grammar import hash_seed, mulberry32
    from tree_grammar import generate_tree
    from world_terrain import hash3, poly_project, k_near, join_pad, ramp_spurs, rect_stats, _slab, _disc, water_blocks, DIRS64


def lr4(v): return math.floor(v * 10000 + 0.5) / 10000
def _lsq(v): return v * v
def _lstream(seed, name): return mulberry32(hash_seed('%s|world|%s' % (seed, name)))
ORDER = ['windmill', 'watermill', 'well', 'belltower', 'market', 'lookout', 'orchard', 'farm']

# ---------------------------------------------------------------- route graph (src/world/routeGraph.js)

def chain_route(pois, start):
    given = {}; delivered = set(); nodes = []; edges = []; left = [{'p': p, 'i': i} for i, p in enumerate(pois)]
    at = {'x': start['x'], 'z': start['z']}; prev = -1
    while left:
        pick = -1; bd = math.inf; best = None
        for q in range(len(left)):
            p = left[q]['p']; H = p['hook']
            takes = H.get('takes') or []
            ready = H['type'] != 'deliver' or any(item in given for item in takes) or not any((o is not p) and o['hook'].get('gives') and o['hook']['gives'] in takes for o in pois)
            if not ready: continue
            d = math.sqrt((p['x'] - at['x']) * (p['x'] - at['x']) + (p['z'] - at['z']) * (p['z'] - at['z']))
            if d < bd: bd = d; pick = q; best = left[q]
        if pick < 0:
            pick = 0; best = left[0]; bd = math.sqrt((best['p']['x'] - at['x']) ** 2 + (best['p']['z'] - at['z']) ** 2)
        left.pop(pick)
        p = best['p']; H = p['hook']; index = len(nodes)
        hook = {'type': H['type'], 'label': H['label']}
        if H['type'] == 'deliver':
            takes = H.get('takes') or []
            item = next((it for it in takes if it in given and it not in delivered), None)
            if item is None: item = next((it for it in takes if it in given), None)
            if item is not None: hook['item'] = item; hook['from'] = given[item]; delivered.add(item)
            else: hook['type'] = 'visit'; hook['label'] = H.get('visitLabel', H['label'])
        if H.get('gives'):
            hook['gives'] = H['gives']
            if H['gives'] not in given: given[H['gives']] = index
        node = {'index': index, 'id': p['id'], 'kind': p['kind'], 'x': p['x'], 'z': p['z'], 'hook': hook}
        if p.get('life'): node['life'] = list(p['life'])
        if p.get('keeper'): node['keeper'] = p['keeper']
        if p.get('lane'): node['lane'] = p['lane']
        if p.get('pad'): node['pad'] = p['pad']
        if p.get('stand'): node['stand'] = p['stand']
        nodes.append(node)
        edges.append({'a': prev, 'b': index, 'd': lr4(bd), 'via': p.get('lane') or 'square'})
        at = {'x': p['x'], 'z': p['z']}; prev = index
    return {'start': {'x': start['x'], 'z': start['z']}, 'nodes': nodes, 'edges': edges}

# ---------------------------------------------------------------- landmarks (src/world/worldLandmarks.js)

def _orient(a, b, c): return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(a, b, c, d):
    o1 = _orient(a, b, c); o2 = _orient(a, b, d); o3 = _orient(c, d, a); o4 = _orient(c, d, b)
    return ((o1 > 0 and o2 < 0) or (o1 < 0 and o2 > 0)) and ((o3 > 0 and o4 < 0) or (o3 < 0 and o4 > 0))


def _crosses_poly(a, b, polys):
    for pts in polys:
        for i in range(1, len(pts)):
            if _segments_cross(a, b, pts[i - 1], pts[i]): return True
    return False


def _outline(R): return [[R['x0'], R['z0']], [R['x1'], R['z0']], [R['x1'], R['z1']], [R['x0'], R['z1']], [R['x0'], R['z0']]]


def _plot_hook(W, spot, R, lot):
    avoid = [_outline(R), _outline(lot['rect'])]; near = _nearest_lane(spot['x'], spot['z'], W['lanes'], avoid); dx = near['x'] - spot['x']; dz = near['z'] - spot['z']
    edges = [[spot['v'][0], spot['v'][1], spot['hv']], [-spot['v'][0], -spot['v'][1], spot['hv']], [spot['u'][0], spot['u'][1], spot['hu']], [-spot['u'][0], -spot['u'][1], spot['hu']]]
    best = edges[0]; bd = -math.inf
    for e in edges:
        s = e[0] * dx + e[1] * dz
        if s > bd: bd = s; best = e
    return {'x': lr4(spot['x'] + best[0] * (best[2] + 1.0)), 'z': lr4(spot['z'] + best[1] * (best[2] + 1.0)), 'front': [best[0], best[1]], 'avoid': avoid}


def _nearest_lane(x, z, lanes, avoid=None):
    best = None; bd = math.inf; lane = None; any_ = None; ad = math.inf; any_lane = None
    for l in lanes:
        p = poly_project(x, z, l['pts']); a = l['pts'][p[1] - 1]; b = l['pts'][p[1]]
        at = [lr4(a[0] + (b[0] - a[0]) * p[2]), lr4(a[1] + (b[1] - a[1]) * p[2])]
        if p[0] < ad: ad = p[0]; any_ = at; any_lane = l['id']
        if avoid and _crosses_poly([x, z], at, avoid): continue
        if p[0] < bd: bd = p[0]; best = at; lane = l['id']
    return {'x': best[0], 'z': best[1], 'd': bd, 'lane': lane} if best else {'x': any_[0], 'z': any_[1], 'd': ad, 'lane': any_lane}


def _unit(dx, dz):
    l = math.sqrt(dx * dx + dz * dz)
    return [lr4(dx / l), lr4(dz / l)] if l > 0 else [0, 1]


def _claim(rules, W, L, pad, clear, h=None, avoid=None):
    ground = W['ground']; pads = W['pads']; spurs = W['spurs']; mask = W['mask']; lanes = W['lanes']
    L['pad'] = pad; L['clear'] = clear; L['h'] = lr4(ground.sample(L['x'], L['z'])) if h is None else h
    if pad > 0:
        join_pad(rules, pads, {'x': L['x'], 'z': L['z'], 'r': pad, 'h': L['h']})
        L['h'] = pads[-1]['h']
        if h is not None: _disc(ground, L['x'], L['z'], pad, rules['terrain']['pads']['blend'], L['h'])
    near = _nearest_lane(L['x'], L['z'], lanes, avoid)
    L['lane'] = near['lane']
    spur = None
    if near['d'] > 0.5:
        spur = {'id': 'lm:%s' % L['id'], 'w': rules['paths']['spur'], 'pts': [[L['x'], L['z']], [near['x'], near['z']]], 'lane': near['lane']}
        spurs.append(spur); mask.spurs.append(spur)
        ramp_spurs(rules, ground, [spur])
    mask.reserved.append({'id': 'lm:%s' % L['id'], 'x': L['x'], 'z': L['z'], 'r': clear, 'spur': False})
    L['spur'] = spur
    return spur


def _near_lots(rules, lots, x, z, pad):
    reach = pad + rules['terrain']['pads']['blend'] + 1.2
    for L in lots:
        nx = max(L['rect']['x0'], min(x, L['rect']['x1'])); nz = max(L['rect']['z0'], min(z, L['rect']['z1']))
        if _lsq(nx - x) + _lsq(nz - z) < _lsq(reach): return True
    return False


def _spur_grade(g, lanes, x, z, h):
    near = _nearest_lane(x, z, lanes)
    hl = g.sample(near['x'], near['z']); grade = abs(h - hl) / near['d'] if near['d'] > 0.5 else 0
    return grade, near


def _hill_candidates(rules, K, seed, W, kind):
    bound = rules['size'] / 2 - rules['margin']; n = math.floor(bound); sj = hash_seed('%s:world:%s' % (seed, kind)); out = []
    ground = W['ground']; mask = W['mask']; lanes = W['lanes']; rim = K.get('rim') or rules['landmarks']['rim']
    for j in range(n + 1):
        for i in range(n + 1):
            x = -bound + i * 2; z = -bound + j * 2
            if x > bound or z > bound: continue
            far = max(abs(x), abs(z))
            if far < rim[0] or far > rim[1] or abs(x) > bound - K['pad'] or abs(z) > bound - K['pad']: continue
            if mask.blocked(x, z, K['body'], lots=True, zones=False, spurs=True, water=False): continue
            if mask.water and water_blocks(rules, mask.water, x, z, K['pad'] + rules['terrain']['ponds']['terrace'] + rules['terrain']['ponds']['blend'], False): continue
            if _near_lots(rules, W['lots'], x, z, K['pad']): continue
            h = ground.sample(x, z); grade, near = _spur_grade(ground, lanes, x, z, h)
            if grade > rules['landmarks']['grade'] or near['d'] < 2: continue
            out.append({'x': lr4(x), 'z': lr4(z), 'h': lr4(h), 'score': h + rules['landmarks']['luck'] * hash3(i, j, sj), 'idx': len(out)})
    out.sort(key=lambda c: (-c['score'], c['idx']))
    return out


def _place_windmill(rules, K, ctx, W):
    cands = _hill_candidates(rules, K, ctx['seed'], W, 'windmill')
    if not cands: return None
    c = cands[0]
    L = {'kind': 'windmill', 'id': 'windmill', 'x': c['x'], 'z': c['z'], 'front': _unit(K['face'][0], K['face'][1]), 'part': K['part']}
    _claim(rules, W, L, K['pad'], K['clear'])
    return L


def _place_lookout(rules, K, ctx, W, windmill):
    S = W['square']; apart = rules['landmarks']['apart']
    for c in _hill_candidates(rules, K, ctx['seed'], W, 'lookout'):
        if windmill:
            ax = windmill['x'] - S['x']; az = windmill['z'] - S['z']; bx = c['x'] - S['x']; bz = c['z'] - S['z']
            if ax * bx + az * bz > 0 or math.sqrt(_lsq(c['x'] - windmill['x']) + _lsq(c['z'] - windmill['z'])) < apart: continue
        L = {'kind': 'lookout', 'id': 'lookout', 'x': c['x'], 'z': c['z'], 'front': _unit(S['x'] - c['x'], S['z'] - c['z']), 'part': K['part']}
        _claim(rules, W, L, K['pad'], K['clear'])
        return L
    return None


def _place_watermill(rules, K, ctx, W):
    B = (W.get('water') or {}).get('brook'); T = rules['terrain']['brook']; ground = W['ground']; mask = W['mask']; lots = W['lots']; walks = W['walks']; spurs = W['spurs']
    if not B or len(B['pts']) < 8: return None
    sj = hash_seed('%s:world:watermill' % ctx['seed']); hd = K['collision']['box'][1]; hw = K['collision']['box'][0]; cands = []
    crossings = spurs + walks
    S = []
    for i in range(len(B['pts'])):
        raw = ground.sample(B['pts'][i][0], B['pts'][i][1]) - T['freeboard']; S.append(raw if i == 0 else min(S[i - 1], raw))
    for i in range(3, len(B['pts']) - 4):
        p = B['pts'][i]
        if any(_lsq(p[0] - b['x']) + _lsq(p[1] - b['z']) < _lsq(b['reach'] + K['keepOff']) for b in B['bridges']): continue
        if _lsq(p[0] - B['basin']['x']) + _lsq(p[1] - B['basin']['z']) < _lsq(K['keepOff'] + 3) or _lsq(p[0] - B['source'][0]) + _lsq(p[1] - B['source'][1]) < _lsq(K['keepOff'] + 2): continue
        if any(poly_project(p[0], p[1], c['pts'])[0] < K['keepOff'] for c in crossings): continue
        drop = ground.sample(B['pts'][i - 3][0], B['pts'][i - 3][1]) - ground.sample(B['pts'][i + 3][0], B['pts'][i + 3][1])
        cands.append({'i': i, 'score': drop + rules['landmarks']['luck'] * 0.5 * hash3(i, 7, sj), 'idx': len(cands)})
    cands.sort(key=lambda c: (-c['score'], c['idx']))
    bound = rules['size'] / 2 - rules['margin']
    for c in cands:
        p = B['pts'][c['i']]; a = B['pts'][c['i'] - 1]; b = B['pts'][c['i'] + 1]; t = _unit(b[0] - a[0], b[1] - a[1])
        n = [-t[1], t[0]]; off = T['w'] / 2 + K['set'] + hd
        for side in (1, -1):
            cx = lr4(p[0] + n[0] * side * off); cz = lr4(p[1] + n[1] * side * off)
            if abs(cx) > bound - K['pad'] or abs(cz) > bound - K['pad']: continue
            if mask.blocked(cx, cz, K['body'], lots=True, zones=False, spurs=True, water=False): continue
            if water_blocks(rules, {'ponds': mask.water['ponds'], 'brook': None}, cx, cz, K['pad'] + rules['terrain']['ponds']['terrace'] + rules['terrain']['ponds']['blend'], False): continue
            front = t
            if front[1] * n[0] * side - front[0] * n[1] * side < 0: front = [lr4(-t[0]), lr4(-t[1])]
            rx = front[1]; rz = -front[0]
            ok = True
            for k in range(9):
                if not ok: break
                u = -1 + k / 4
                edge = [[cx + front[0] * hw * u + rx * hd, cz + front[1] * hw * u + rz * hd], [cx + front[0] * hw * u - rx * hd, cz + front[1] * hw * u - rz * hd],
                        [cx + front[0] * hw + rx * hd * u, cz + front[1] * hw + rz * hd * u], [cx - front[0] * hw + rx * hd * u, cz - front[1] * hw + rz * hd * u]]
                for ex, ez in edge:
                    if poly_project(ex, ez, B['pts'])[0] < T['w'] / 2 + K['set'] * 0.5: ok = False; break
            if not ok: continue
            m = max(hw, hd); R = {'x0': cx - m, 'x1': cx + m, 'z0': cz - m, 'z1': cz + m}
            if _near_lots(rules, lots, cx, cz, K['pad']): continue
            st = rect_stats(ground, R); h = lr4(S[c['i']] + K['bank'])
            if st['hi'] - st['lo'] > K['range'] or abs(st['mean'] - h) > K['fill']: continue
            L = {'kind': 'watermill', 'id': 'watermill', 'x': cx, 'z': cz, 'front': front, 'part': K['part'], 'at': c['i'], 'side': side,
                 'rect': {'x0': lr4(R['x0']), 'x1': lr4(R['x1']), 'z0': lr4(R['z0']), 'z1': lr4(R['z1'])}, 'hw': hw, 'hd': hd,
                 'wheel': {'x': lr4(p[0] + n[0] * side * (T['w'] / 2 - K['wheel']['in'])), 'z': lr4(p[1] + n[1] * side * (T['w'] / 2 - K['wheel']['in'])), 'y': 0}}
            _claim(rules, W, L, K['pad'], K['clear'], h, [B['pts']])
            return L
    return None


def _place_square(rules, K, M, ctx, W, rng, T=None):
    S = W['square']; B = (W.get('water') or {}).get('brook'); P = rules['paths']; mask = W['mask']; lanes = W['lanes']; out = []
    INV2 = 0.7071067811865476; diags = [[INV2, INV2], [-INV2, INV2], [-INV2, -INV2], [INV2, -INV2]]
    well_roll = rng(); count_roll = rng(); part_rolls = []; colour_rolls = []; keeper_rolls = []
    for i in range(6):
        part_rolls.append(rng()); colour_rolls.append(rng()); keeper_rolls.append(rng())
    q0 = (B['basin']['q'] + 2) % 4 if B else math.floor(well_roll * 4) % 4
    d = S['r'] * (K or M)['at']
    keepers = rules['landmarks']['keepers']; awnings = M['awnings'] if M else None
    def keeper_of(roll): return keepers[math.floor(roll * len(keepers)) % len(keepers)]
    def free(x, z, r, rr=None):
        if rr is None: rr = r
        for l in lanes:
            if poly_project(x, z, l['pts'])[0] < l['w'] / 2 + r: return False
        for c in mask.reserved:
            if _lsq(x - c['x']) + _lsq(z - c['z']) < _lsq(c['r'] + rr): return False
        if B and _lsq(x - B['basin']['x']) + _lsq(z - B['basin']['z']) < _lsq(B['basin']['r'] + r + 0.4): return False
        return True
    def slide(q, r, rr):
        for s in range(5):
            dd = d + s * 0.35; x = lr4(S['x'] + diags[q][0] * dd); z = lr4(S['z'] + diags[q][1] * dd)
            if free(x, z, r, rr): return [x, z]
        return None
    if K:
        at = slide(q0, K['collision']['circle'], K['collision']['circle'])
        if at:
            x, z = at
            L = {'kind': 'well', 'id': 'well', 'x': x, 'z': z, 'front': _unit(S['x'] - x, S['z'] - z), 'part': K['part'], 'keeper': keeper_of(keeper_rolls[0])}
            L['lane'] = 'square'; mask.reserved.append({'id': 'lm:well', 'x': x, 'z': z, 'r': K['collision']['circle'] + 0.6, 'spur': False})
            out.append(L)
    if T and W.get('towerLot'):
        lot = W['towerLot']
        out.append({'kind': 'belltower', 'id': 'belltower', 'x': lot['x'], 'z': lot['z'], 'front': _unit(S['x'] - lot['x'], S['z'] - lot['z']), 'part': T['part'], 'lane': 'square', 'clear': lr4(max(lot['w'], lot['d']) / 2)})
    elif T:
        reach = T['collision']['circle'] + 0.3; k0 = math.floor(q0 * 16 + 40) % 64
        placed = False
        for s in range(T['slide'] + 1):
            if placed: break
            for i in range(16):
                if placed: break
                dv = DIRS64[(k0 + i * 4) % 64]; dd = S['r'] * T['at'] + s * 0.5; x = lr4(S['x'] + dv[0] * dd); z = lr4(S['z'] + dv[1] * dd)
                if B and _lsq(x - B['basin']['x']) + _lsq(z - B['basin']['z']) < _lsq(B['basin']['r'] + reach + 1): continue
                if not free(x, z, reach, reach) or mask.blocked(x, z, reach, lots=True, zones=False, spurs=True): continue
                L = {'kind': 'belltower', 'id': 'belltower', 'x': x, 'z': z, 'front': _unit(S['x'] - x, S['z'] - z), 'part': T['part'], 'lane': 'square', 'clear': reach + T['clear']}
                mask.reserved.append({'id': 'lm:belltower', 'x': x, 'z': z, 'r': reach + T['clear'], 'spur': False})
                out.append(L); placed = True
            if placed: break
    if not M: return out
    want = min(M['max'], M['min'] + math.floor(count_roll * (M['max'] - M['min'] + 1))); r = max(M['collision']['box'][0], M['collision']['box'][1]) + 0.1; rr = M['collision']['box'][0] + M['collision']['box'][1] + 0.1
    spots = []
    for q in range(1, 4):
        qq = (q0 + q) % 4
        if B and qq == B['basin']['q']: continue
        at = slide(qq, r, rr)
        if at: spots.append(at)
    lane1 = next((l for l in lanes if l['id'] != 'spine' and abs(l['base'] - S['z']) < 3), lanes[1])
    for sx in (1, -1):
        for sz in (1, -1):
            x = lr4(S['x'] + sx * (S['r'] + P['verge'] + M['off'])); z = lr4(S['z'] + sz * (lane1['w'] / 2 + P['verge'] + M['set']))
            spots.append([x, z])
    n = 0
    for s in range(len(spots)):
        if n >= want: break
        x, z = spots[s]
        if not free(x, z, r, rr) or (s >= 2 and mask.blocked(x, z, rr, lots=True, zones=False, spurs=True)): continue
        if any(_lsq(o['x'] - x) + _lsq(o['z'] - z) < _lsq(M['apart']) for o in out): continue
        L = {'kind': 'market', 'id': 'stall%d' % n, 'x': x, 'z': z, 'front': _unit(S['x'] - x, S['z'] - z), 'part': M['parts'][math.floor(part_rolls[n] * len(M['parts'])) % len(M['parts'])],
             'colors': {'Awning': awnings[math.floor(colour_rolls[n] * len(awnings)) % len(awnings)]}, 'keeper': keeper_of(keeper_rolls[n + 1]), 'lane': 'square'}
        mask.reserved.append({'id': 'lm:%s' % L['id'], 'x': x, 'z': z, 'r': r + 0.6, 'spur': False})
        out.append(L); n += 1
    return out


def _fringe_spot(rules, W, lot, ext, gap, probe, used):
    bound = rules['size'] / 2 - rules['margin'] + 2.0; fx, fz = lot['front']; tx = fz; tz = -fx
    sides = [[tx, tz, lot['w'] / 2, ext[0] / 2], [-tx, -tz, lot['w'] / 2, ext[0] / 2], [-fx, -fz, lot['d'] / 2, ext[1] / 2]]
    for dx, dz, half, mine in sides:
        cx = lr4(lot['x'] + dx * (half + gap + mine)); cz = lr4(lot['z'] + dz * (half + gap + mine))
        ux = tx; uz = tz; vx = fx; vz = fz; hu = ext[0] / 2; hv = ext[1] / 2
        corners = [[-hu, -hv], [hu, -hv], [-hu, hv], [hu, hv], [0, 0], [0, -hv], [0, hv]]
        ok = True
        for u, v in corners:
            x = cx + ux * u + vx * v; z = cz + uz * u + vz * v
            if abs(x) > bound or abs(z) > bound or not probe(x, z): ok = False; break
        if ok:
            for o in used:
                if _lsq(o['x'] - cx) + _lsq(o['z'] - cz) < _lsq(o['r'] + max(hu, hv) + 1): ok = False; break
        if ok: return {'x': cx, 'z': cz, 'u': [ux, uz], 'v': [vx, vz], 'hu': hu, 'hv': hv}
    return None


def _fringe_lots(lots):
    return sorted(lots, key=lambda L: (0 if L['family'] == 'farmhouse' else 1, L['score'], L['slot']))


def _place_orchard(rules, K, ctx, W, used):
    mask = W['mask']; ground = W['ground']; lots = W['lots']; cols = K['grid'][0]; rows = K['grid'][1]; sp = K['spacing']
    if not ctx.get('treeRules') or 'tree' not in ctx['pool']: return None
    ext = [(cols - 1) * sp + 2 * K['margin'], (rows - 1) * sp + 2 * K['margin']]
    def probe(x, z): return not mask.blocked(x, z, K['margin'], lots=True, zones=False, spurs=True) and ground.slope(x, z) <= K['slope']
    for lot in _fringe_lots(lots):
        spot = _fringe_spot(rules, W, lot, ext, K['gap'], probe, used)
        if not spot: continue
        trees = []
        for r in range(rows):
            for c in range(cols):
                u = (c - (cols - 1) / 2) * sp; v = (r - (rows - 1) / 2) * sp
                x = lr4(spot['x'] + spot['u'][0] * u + spot['v'][0] * v); z = lr4(spot['z'] + spot['u'][1] * u + spot['v'][1] * v); i = r * cols + c
                plan = generate_tree(ctx['treeRules'], K['tree'], '%s|orchard|%d' % (ctx['seed'], i)); s = K['scale']
                trees.append({'x': x, 'z': z, 'k': (i * 23 + 5) % 64, 's': s, 'tree': plan, 'trunk': lr4(plan['trunk'] * s), 'height': lr4(plan['clear'] * s), 'crown': lr4(plan['crown'] * s), 'y': 0})
        m = max(spot['hu'], spot['hv'])
        R = {'x0': lr4(spot['x'] - m), 'x1': lr4(spot['x'] + m), 'z0': lr4(spot['z'] - m), 'z1': lr4(spot['z'] + m)}
        hk = _plot_hook(W, spot, R, lot)
        L = {'kind': 'orchard', 'id': 'orchard', 'x': hk['x'], 'z': hk['z'], 'front': hk['front'], 'trees': trees, 'lot': lot['slot'], 'rect': R, 'centre': [spot['x'], spot['z']]}
        _claim(rules, W, L, K['pad'], K['clear'], None, hk['avoid'])
        for t in trees: mask.reserved.append({'id': 'lm:orchard-tree', 'x': t['x'], 'z': t['z'], 'r': K['margin'], 'spur': False})
        return L
    return None


def _place_farm(rules, K, ctx, W, used):
    mask = W['mask']; ground = W['ground']; lots = W['lots']; ext = K['size']
    if (rules['landmarks'].get('prop') or 'landmark') not in ctx['pool']: return None
    def probe(x, z): return not mask.blocked(x, z, 0.6, lots=True, zones=False, spurs=True)
    for lot in _fringe_lots(lots):
        spot = _fringe_spot(rules, W, lot, ext, K['gap'], probe, used)
        if not spot: continue
        m = max(spot['hu'], spot['hv'])
        R = {'x0': lr4(spot['x'] - m), 'x1': lr4(spot['x'] + m), 'z0': lr4(spot['z'] - m), 'z1': lr4(spot['z'] + m)}
        st = rect_stats(ground, R)
        if st['hi'] - st['lo'] > K['range']: continue
        hk = _plot_hook(W, spot, R, lot); level = lr4(st['mean'])
        G = {'x0': lr4(min(R['x0'], hk['x'] - 0.5)), 'x1': lr4(max(R['x1'], hk['x'] + 0.5)), 'z0': lr4(min(R['z0'], hk['z'] - 0.5)), 'z1': lr4(max(R['z1'], hk['z'] + 0.5))}
        L = {'kind': 'farm', 'id': 'farm', 'x': hk['x'], 'z': hk['z'], 'front': hk['front'], 'part': K['part'], 'rect': R, 'slab': G, 'level': level, 'lot': lot['slot'], 'centre': [spot['x'], spot['z']]}
        _claim(rules, W, L, K['pad'], K['clear'], None, hk['avoid'])
        mask.reserved.append({'id': 'lm:farm-plot', 'x': spot['x'], 'z': spot['z'], 'r': m + 0.5, 'spur': False})
        return L
    return None


def plan_landmarks(rules, ctx, W):
    R = rules['landmarks']; K = R['kinds']; rng = _lstream(ctx['seed'], 'landmarks'); out = []
    windmill = _place_windmill(rules, K['windmill'], ctx, W) if K.get('windmill') else None
    if windmill: out.append(windmill)
    watermill = _place_watermill(rules, K['watermill'], ctx, W) if K.get('watermill') else None
    if watermill: out.append(watermill)
    out.extend(_place_square(rules, K.get('well'), K.get('market'), ctx, W, rng, K.get('belltower')))
    lookout = _place_lookout(rules, K['lookout'], ctx, W, windmill) if K.get('lookout') else None
    if lookout: out.append(lookout)
    used = [{'x': l['x'], 'z': l['z'], 'r': l.get('clear', 2)} for l in out]
    orchard = _place_orchard(rules, K['orchard'], ctx, W, used) if K.get('orchard') else None
    if orchard:
        out.append(orchard)
        used.append({'x': orchard['centre'][0], 'z': orchard['centre'][1], 'r': max(orchard['rect']['x1'] - orchard['rect']['x0'], orchard['rect']['z1'] - orchard['rect']['z0']) / 2})
    farm = _place_farm(rules, K['farm'], ctx, W, used) if K.get('farm') else None
    if farm: out.append(farm)
    for L in out:
        k = K[L['kind']]
        L['hook'] = dict(k['hook'])
        if k.get('life'): L['life'] = list(k['life'])
        L['collision'] = k.get('collision')
        L['k'] = k_near(L['front'][0], L['front'][1])
    return out


def level_landmarks(rules, g, landmarks):
    for L in landmarks:
        if L.get('slab'): _slab(g, L['slab'], 0.3, rules['terrain']['lots']['skirt'], L['level'])


def finish_landmarks(rules, g, water, landmarks):
    K = rules['landmarks']['kinds']; B = (water or {}).get('brook')
    for L in landmarks:
        L['y'] = lr4(L['h'] if L.get('pad') else g.sample(L['x'], L['z']))
        if L.get('level') is not None: L['plot'] = {'x': L['centre'][0], 'z': L['centre'][1], 'y': L['level']}
        for t in (L.get('trees') or []): t['y'] = lr4(g.low(t['x'], t['z'], t['trunk']))
        if L.get('wheel') and B:
            pr = poly_project(L['wheel']['x'], L['wheel']['z'], B['pts']); s = B['surface'][pr[1] - 1] + (B['surface'][pr[1]] - B['surface'][pr[1] - 1]) * pr[2]
            L['wheel']['y'] = lr4(s + K['watermill']['wheel']['r'] - K['watermill']['wheel']['dip'] - L['y'])


def landmark_pois(landmarks):
    out = []
    for L in landmarks:
        c = L.get('collision'); reach = ((c['circle'] + 1.3) if c.get('circle') else (c['box'][0] + c['box'][1] + 1.1)) if c else 0
        out.append({'id': L['id'], 'kind': L['kind'], 'x': L['x'], 'z': L['z'], 'hook': L['hook'], 'life': L.get('life'), 'keeper': L.get('keeper'), 'lane': L.get('lane'), 'pad': L.get('pad', 0),
                    'stand': [lr4(L['x'] + L['front'][0] * reach), lr4(L['z'] + L['front'][1] * reach)] if reach else [L['x'], L['z']]})
    return out


def landmark_keeps(landmarks):
    return [{'x': L['x'], 'z': L['z'], 'f': L['front'], 'hw': L['hw'] + 0.1, 'hd': L['hd'] + 0.1} for L in landmarks if L['kind'] == 'watermill']
