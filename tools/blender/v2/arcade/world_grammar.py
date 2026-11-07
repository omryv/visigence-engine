"""Python port of src/world/worldGrammar.js: the same rules, the same noise, the same PRNG streams, the same layout.

The Blender preview (world_preview.py) builds a level from this layout, so what the art pipeline renders is exactly
what the engine compiles for the same seed and reserved places. tools/test/test-world-placement.mjs compares this
port against the JS through fixtures written by write_world_fixtures(). Keep the two files in lockstep (see PARITY
RULES in the JS header): every expression in the same operand order, every stream drawn in the same order whatever
branch is taken, numbers out through r4, integer loop counters.

Standalone (no bpy): runs inside Blender (after tools/blender/v2/core/grammar_core.py and layout_core.py, then creature_grammar.py and house_grammar.py, whose PRNG, choice helpers
and generate_house it shares) or with python3:
    python3 tools/blender/v2/arcade/world_grammar.py packs/arcade/pack.json tools/test/fixtures/world-layouts.json
    python3 tools/blender/v2/arcade/world_grammar.py packs/arcade/pack.json tools/test/fixtures/world-layouts-desert.json desert
    python3 tools/blender/v2/arcade/world_grammar.py packs/arcade/pack.json tools/test/fixtures/world-layouts-snow.json snow

A level standing on its seed's Visigenesis world takes its relief as data (ctx['relief'], src/world/kernelGround.js):
the kernel has no Python port, and needs none here, because both ports read the same heights. The fixtures carry three
such villages, their reliefs in tools/test/fixtures/kernel-ground.json (run `node tools/build/kernel-ground-fixtures.mjs`
first when the kernel's ground changes).
"""
import json, math

try:
    hash_seed, mulberry32, _choose, _clamp01, generate_house, DIRS64, make_ground, vnoise, plan_landmarks, poisson_disc
except NameError:
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core'))
    from layout_core import (favor_at, seg_dist, poly_dist, poly_at, poly_length, poly_nearest, rect_circle, rect_rect, rect_has,
                             PointHash, poisson_disc)
    from creature_grammar import hash_seed, mulberry32, _choose, _clamp01
    from house_grammar import generate_house, DIRS64
    from tree_grammar import generate_tree, tree_digest
    from world_terrain import (hash3, vnoise, fbm, make_ground, grade_lanes, pad_targets, join_pad, ramp_spurs, plan_ponds, plan_brook, water_edge,
                               water_blocks, water_rect, rect_stats, level_lots, ramp_walks, level_pads, carve_water, shore_dressing,
                               finish_terrain, grid_hash)
    from world_landmarks import plan_landmarks, level_landmarks, finish_landmarks, landmark_pois, landmark_keeps, chain_route

WORLD_GRAMMAR_VERSION = 3
M32 = 0xFFFFFFFF
M = 4294967296.0


def wr4(v): return math.floor(v * 10000 + 0.5) / 10000
def _sq(v): return v * v
def _imul32(a, b): return (a * b) & M32

# ---------------------------------------------------------------- noise

# hash3, vnoise and fbm live with the terrain (world_terrain.py), which shapes the ground from them.


def world_fields(rules, seed):
    F = rules['fields']; S = rules['paths']['square']
    sv = hash_seed('%s:world:village' % seed); sf = hash_seed('%s:world:forest' % seed); sm = hash_seed('%s:world:moisture' % seed)

    def village(x, z):
        d = math.sqrt(x * x + _sq(z - S['z'])); radial = _clamp01(1 - d / F['village']['radius'])
        return _clamp01(F['village']['radial'] * radial + (1 - F['village']['radial']) * fbm(x, z, sv, F['village']))

    def forest(x, z):
        e = F['forest']['edge']; edge = _clamp01((max(abs(x), abs(z)) - e[0]) / (e[1] - e[0]))
        return _clamp01(fbm(x, z, sf, F['forest']) * (1 - F['forest']['clearing'] * village(x, z)) + F['forest']['rim'] * edge)

    def moisture(x, z): return fbm(x, z, sm, F['moisture'])
    return {'village': village, 'forest': forest, 'moisture': moisture}


_favor_at = favor_at   # tools/blender/v2/core/layout_core.py

# ---------------------------------------------------------------- geometry

def _stream(seed, name): return mulberry32(hash_seed('%s|world|%s' % (seed, name)))


# The polyline and rectangle helpers are theme-neutral (tools/blender/v2/core/layout_core.py).
_seg_dist = seg_dist; _poly_dist = poly_dist; _poly_at = poly_at; _poly_length = poly_length; _poly_nearest = poly_nearest
_rect_circle = rect_circle; _rect_rect = rect_rect; _rect_has = rect_has


class _Mask:
    def __init__(self, rules, lanes, square, reserved, spurs):
        self.rules = rules; self.lanes = lanes; self.square = square; self.reserved = reserved; self.spurs = spurs; self.lots = []; self.zones = []; self.water = None

    def blocked(self, x, z, pad=0, lots=True, zones=False, spurs=True, wet=False, ground=None, water=True):
        P = self.rules['paths']
        # water='ponds': only the ponds count, for a thing that means to stand on the brook's bank
        if water and self.water and water_blocks(self.rules, {'ponds': self.water['ponds'], 'brook': None} if water == 'ponds' else self.water, x, z, pad, wet): return True
        for c in self.reserved:
            if _sq(x - c['x']) + _sq(z - c['z']) < _sq(c['r'] + pad): return True
        if _sq(x - self.square['x']) + _sq(z - self.square['z']) < _sq(self.square['r'] + P['verge'] + pad): return True
        for l in self.lanes:
            if _poly_dist(x, z, l['pts']) < l['w'] / 2 + P['verge'] + pad: return True
        if spurs:
            for s in self.spurs:
                if _poly_dist(x, z, s['pts']) < s['w'] / 2 + pad: return True
        if lots:
            for L in self.lots:
                if _rect_has(L['rect'], x, z, self.rules['houses']['margin'] + pad): return True
        if zones:
            for zn in self.zones:
                if _sq(x - zn['x']) + _sq(z - zn['z']) < _sq(zn['r'] + pad): return True
        return False

# ---------------------------------------------------------------- 2. paths

def _make_lanes(rules, seed):
    P = rules['paths']; ws = hash_seed('%s:world:wobble' % seed); out = []
    n = math.floor((P['spine'][0] - P['spine'][1]) / P['step'] + 0.5); pts = []
    for i in range(n + 1):
        z = P['spine'][0] - i * P['step']
        pts.append([wr4(P['wobble'] * (2 * vnoise(z / P['wobbleScale'] + 3.1, 0.5, ws) - 1)), wr4(z)])
    out.append({'id': 'spine', 'axis': 'z', 'w': P['width'], 'base': 0, 'pts': pts})
    m = math.floor((2 * P['laneEnd']) / P['step'] + 0.5)
    for li in range(len(P['lanes'])):
        z0 = P['lanes'][li]; lp = []
        for i in range(m + 1):
            x = -P['laneEnd'] + i * P['step']
            lp.append([wr4(x), wr4(z0 + P['wobble'] * (2 * vnoise(x / P['wobbleScale'] + 7.7 * (li + 1), 2.5, ws) - 1))])
        out.append({'id': 'lane%d' % li, 'axis': 'x', 'w': P['laneWidth'], 'base': z0, 'pts': lp})
    return out


def _make_spurs(rules, lanes, reserved):
    out = []
    for c in reserved:
        if not c['spur']: continue
        best = None; bd = math.inf
        for l in lanes:
            p = _poly_nearest(c['x'], c['z'], l['pts']); d = math.sqrt(_sq(p[0] - c['x']) + _sq(p[1] - c['z']))
            if d < bd: bd = d; best = p
        if best and bd > 0.5: out.append({'id': c['id'], 'w': rules['paths']['spur'], 'pts': [[wr4(c['x']), wr4(c['z'])], [wr4(best[0]), wr4(best[1])]]})
    return out

# ---------------------------------------------------------------- 3. lots

def _door_u(plan):
    # a walled courtyard is entered by its gateway, which stands on the door's line
    if (plan.get('court') or {}).get('gate'): return plan['court']['gate']['u']
    for w in plan['walls']:
        if w['b'] == 0 and w['face'] == '-y':
            for c in w['cells']:
                if c['kind'] == 'door': return c['u']
    for r in plan.get('rings', []):
        for c in r['cells']:
            if c['kind'] == 'door': return 0
    return 0


def _make_lots(rules, ctx, lanes, mask, fields, ground):
    H = rules['houses']; P = rules['paths']; rng = _stream(ctx['seed'], 'lots'); families = list((ctx.get('mix') or {}).items())
    bound = rules['size'] / 2 - rules['margin']
    found = []
    if not families or not ctx.get('houseRules'): return found
    for lane in lanes:
        for side in (-1, 1):
            length = _poly_length(lane['pts']); setback = H['setback']['spine'] if lane['id'] == 'spine' else H['setback']['lane']
            u = 1.5
            while u < length - 1.5:
                rf = rng(); rt = rng(); at = _poly_at(lane['pts'], u)
                nx = side if lane['axis'] == 'z' else 0; nz = side if lane['axis'] == 'x' else 0
                off = lane['w'] / 2 + P['verge'] + setback
                ox = lane['base'] if lane['axis'] == 'z' else at['x']; oz = lane['base'] if lane['axis'] == 'x' else at['z']
                px = ox + nx * (off + 6); pz = oz + nz * (off + 6); v = fields['village'](px, pz)
                family = _choose(rf, families, lambda fw: fw[1] * max(0.05, 1 + (H['near'].get(fw[0], 0)) * (2 * v - 1)))[0]
                lw, ld = H['lots'].get(family) or [rules.get('lot', {}).get('w', 7.6), rules.get('lot', {}).get('d', 10)]
                cx = ox + nx * (off + ld / 2); cz = oz + nz * (off + ld / 2)
                hw = lw / 2 if lane['axis'] == 'x' else ld / 2; hd = ld / 2 if lane['axis'] == 'x' else lw / 2
                rect = {'x0': wr4(cx - hw), 'x1': wr4(cx + hw), 'z0': wr4(cz - hd), 'z1': wr4(cz + hd)}
                ok = v >= H['threshold'] and rt < v + 0.15
                if ok and (rect['x0'] < -bound or rect['x1'] > bound or rect['z0'] < -bound or rect['z1'] > bound): ok = False
                if ok and lane['id'] != 'spine' and (rect['x0'] < P['avenue'] and rect['x1'] > -P['avenue']): ok = False
                if ok:
                    for c in mask.reserved:
                        if _rect_circle(rect, c['x'], c['z'], c['r'] + H['margin']): ok = False; break
                if ok and _rect_circle(rect, mask.square['x'], mask.square['z'], mask.square['r'] + P['verge'] + H['margin']): ok = False
                if ok:
                    for L in found:
                        if _rect_rect(rect, L['rect'], H['gap']): ok = False; break
                if ok:
                    m = H['margin']; done = False
                    for l in lanes:
                        for k in range(9):
                            t = k / 8
                            edge = [[rect['x0'] + (rect['x1'] - rect['x0']) * t, rect['z0']], [rect['x0'] + (rect['x1'] - rect['x0']) * t, rect['z1']],
                                    [rect['x0'], rect['z0'] + (rect['z1'] - rect['z0']) * t], [rect['x1'], rect['z0'] + (rect['z1'] - rect['z0']) * t]]
                            for ex, ez in edge:
                                if _poly_dist(ex, ez, l['pts']) < l['w'] / 2 + P['verge'] + m: ok = False; done = True; break
                            if done: break
                        if done: break
                if ok:
                    for s in mask.spurs:
                        stop = False
                        for k in range(9):
                            t = k / 8
                            if _rect_has(rect, s['pts'][0][0] + (s['pts'][1][0] - s['pts'][0][0]) * t, s['pts'][0][1] + (s['pts'][1][1] - s['pts'][0][1]) * t, s['w'] / 2 + H['margin']): ok = False; stop = True; break
                        if stop: break
                if ok and mask.water and water_rect(rules, mask.water, rect, H['margin']): ok = False
                y = 0
                if ok and ground:
                    st = rect_stats(ground, rect)
                    if st['hi'] - st['lo'] > rules['terrain']['lots']['range']: ok = False
                    else: y = wr4(st['mean'])
                if not ok: u += 2; continue
                fx = -nx; fz = -nz
                found.append({'index': len(found), 'lane': lane['id'], 'family': family, 'x': wr4(cx), 'z': wr4(cz), 'w': lw, 'd': ld, 'front': [fx, fz], 'rect': rect, 'score': wr4(v), 'setback': setback, 'y': y})
                u += lw + H['gap']
    kept = sorted(sorted(found, key=lambda L: L['index']), key=lambda L: -L['score'])[:H['max']]
    kept = sorted(kept, key=lambda L: L['index'])
    out = []
    for i, L in enumerate(kept):
        plan = generate_house(ctx['houseRules'], L['family'], '%s|lot%d' % (ctx['seed'], L['index']), {'w': L['w'], 'd': L['d']})
        e = dict(L); e.update({'slot': i, 'key': plan['key'], 'door': wr4(_door_u(plan)), 'plan': plan}); out.append(e)
    return out


def _make_yards(rules, lots, lanes, pool):
    F = rules['fences']; H = rules['houses']; fences = []; walks = []; stones = []
    budget = F['max']
    for L in lots:
        fx, fz = L['front']; tx = fz; tz = -fx
        ex = L['x'] + fx * (L['d'] / 2 + F['out']); ez = L['z'] + fz * (L['d'] / 2 + F['out'])
        dx = L['x'] + tx * L['door'] + fx * L['d'] / 2; dz = L['z'] + tz * L['door'] + fz * L['d'] / 2
        lane = next(l for l in lanes if l['id'] == L['lane']); near = _poly_nearest(dx, dz, lane['pts'])
        walks.append({'lot': L['slot'], 'w': H['walk'], 'pts': [[wr4(dx), wr4(dz)], [wr4(near[0]), wr4(near[1])]]})
        wl = math.sqrt(_sq(near[0] - dx) + _sq(near[1] - dz)); n = min(H['stones'], math.floor((wl - F['out']) / 0.85))
        if 'nature' in pool:
            for i in range(1, n + 1):
                t = (F['out'] + 0.7 + (i - 1) * 0.85) / wl
                stones.append({'lot': L['slot'], 'part': 'stone.step', 'x': wr4(dx + (near[0] - dx) * t), 'z': wr4(dz + (near[1] - dz) * t), 'k': (L['slot'] * 7 + i * 13) % 64, 's': 1, 'lod': 1})
        if 'fence' not in pool: continue
        for side in (-1, 1):
            frm = side * L['w'] / 2; to = L['door'] + side * F['gap'] / 2
            span = (frm - to) * side
            count = math.floor(span / F['length'])
            for i in range(count):
                if budget <= 0: break
                u = frm - side * (F['length'] / 2 + i * F['length'])
                fences.append({'lot': L['slot'], 'x': wr4(ex + tx * u), 'z': wr4(ez + tz * u), 'front': [fx, fz]})
                budget -= 1
    return fences, walks, stones

# ---------------------------------------------------------------- 4/5. Poisson-disc scatter

_PointHash = PointHash   # tools/blender/v2/core/layout_core.py


def _poisson(rules, cls, seed, mask, fields, placed, opts):
    """Poisson-disc sampling for one class (layout_core.poisson_disc) against the village's mask and fields."""
    def refuse(x, z, roll):
        return mask.blocked(x, z, cls.get('pad', cls.get('foot', 0.5)), **opts) or (cls.get('avenue') is False and abs(x) < rules['paths']['avenue']) \
            or (cls.get('slope') is not None and opts.get('ground') and opts['ground'].slope(x, z) > cls['slope']) \
            or roll >= _clamp01(cls.get('base', 1) * _favor_at(cls.get('favor'), fields, x, z))
    return poisson_disc(_stream(seed, 'scatter:%s' % cls['id']), rules['size'] / 2 - rules['margin'], cls['r'], cls.get('foot', cls['r'] / 2),
                        bool(cls.get('canopy') or cls.get('tree')), cls['max'], placed, refuse)


def _make_scatter(rules, ctx, mask, fields):
    placed = _PointHash(); scatter = []; g = ctx.get('ground'); lean = (rules.get('terrain') or {}).get('lean')
    for cls in rules['classes']:
        if cls.get('prop') and cls['prop'] not in ctx['pool']: continue
        if cls.get('parts') and 'nature' not in ctx['pool']: continue
        if cls.get('tree') and not ('tree' in ctx['pool'] and ctx.get('treeRules')): continue
        pts = _poisson(rules, cls, ctx['seed'], mask, fields, placed, {'lots': True, 'zones': bool(cls.get('zones')), 'spurs': True, 'wet': bool(cls.get('wet')), 'ground': g})
        foot = cls.get('foot', cls['r'] / 2)
        placed.fmax = max(placed.fmax, foot)
        n = 0
        for p in pts:
            item = {'cls': cls['id'], 'x': p['x'], 'z': p['z'], 'k': p['k'], 's': p['s'], 'lod': cls.get('lod', 0)}
            canopy = foot
            if cls.get('tree'):
                plan = generate_tree(ctx['treeRules'], cls['tree'], '%s|%s|%d' % (ctx['seed'], cls['id'], n))
                n += 1
                item['tree'] = plan; item['trunk'] = wr4(plan['trunk'] * p['s']); item['height'] = wr4(plan['clear'] * p['s']); item['crown'] = wr4(plan['crown'] * p['s'])
                canopy = max(foot, wr4(item['crown'] * rules.get('crownFoot', 0.6)))
            elif cls.get('prop'):
                item['prop'] = cls['prop']
                if cls.get('trunk'): item['trunk'] = wr4(cls['trunk'] * p['s']); item['height'] = cls.get('height', 2)
            else: item['part'] = cls['parts'][p['k'] % len(cls['parts'])]
            if cls.get('tint'): item['tint'] = True
            item['y'] = wr4(g.low(p['x'], p['z'], item['trunk'] if 'trunk' in item else (min(foot * 0.5, 0.45) if cls.get('prop') else 0.2))) if g else 0
            if cls.get('lean') and lean and mask.water:
                w = water_edge(mask.water, p['x'], p['z']); dx = w['x'] - p['x']; dz = w['z'] - p['z']; l = math.sqrt(dx * dx + dz * dz)
                if w['e'] < lean['range'] and l > 0: item['lean'] = [wr4(dx / l), wr4(dz / l), wr4(lean['max'] * (1 - max(0, w['e']) / lean['range']))]
            placed.add(p['x'], p['z'], foot, canopy)
            placed.fmax = max(placed.fmax, canopy)
            scatter.append(item)
    return scatter


def _make_zones(rules, ctx, mask, fields):
    W = rules.get('wildlife')
    if not W: return []
    cls = {'id': 'wildlife', 'r': W['r'], 'foot': W.get('foot', W['zone']), 'max': W['max'], 'base': W['base'], 'favor': W['favor'], 'pad': W.get('pad', W['zone']), 'slope': W.get('slope')}
    return [{'x': p['x'], 'z': p['z'], 'r': W['zone']} for p in _poisson(rules, cls, ctx['seed'], mask, fields, _PointHash(), {'lots': True, 'zones': False, 'spurs': True, 'ground': ctx.get('ground')})]

# ---------------------------------------------------------------- 6. pickups and signs

def _make_pickups(rules, ctx, lanes, mask):
    K = rules['pickups']; rng = _stream(ctx['seed'], 'pickups'); out = []
    for id_ in (ctx.get('pickups') or []):
        for i in range(K['each']):
            done = False; t = 0
            while t < 24 and not done:
                t += 1
                li = math.floor(rng() * len(lanes)); lane = lanes[li]; u = rng() * _poly_length(lane['pts']); side = -1 if rng() < 0.5 else 1
                at = _poly_at(lane['pts'], u); nx = side if lane['axis'] == 'z' else 0; nz = side if lane['axis'] == 'x' else 0
                x = wr4(at['x'] + nx * (lane['w'] / 2 + K['offset'])); z = wr4(at['z'] + nz * (lane['w'] / 2 + K['offset']))
                if mask.blocked(x, z, 0, lots=True, zones=False, spurs=False): continue
                if abs(x) > rules['size'] / 2 - rules['margin'] or abs(z) > rules['size'] / 2 - rules['margin']: continue
                if any(_sq(p['x'] - x) + _sq(p['z'] - z) < _sq(K['apart']) for p in out): continue
                out.append({'id': id_, 'x': x, 'z': z}); done = True
    return out


def _make_signs(rules, ctx, lanes, mask):
    S = rules.get('signs'); out = []
    if not S or 'nature' not in ctx['pool']: return out
    spine = lanes[0]; rng = _stream(ctx['seed'], 'signs')
    for lane in lanes[1:]:
        side = -1 if rng() < 0.5 else 1; spin_roll = rng()
        c = _poly_nearest(0, lane['pts'][0][1], spine['pts']); at = _poly_nearest(c[0], c[1], lane['pts'])
        x = wr4(at[0] + side * (spine['w'] / 2 + S['offset'])); z = wr4(at[1] - (lane['w'] / 2 + S['offset']))
        if mask.blocked(x, z, 0, lots=True, zones=False, spurs=False): continue
        if _sq(x - mask.square['x']) + _sq(z - mask.square['z']) < _sq(mask.square['r'] + 1): continue
        out.append({'part': S['part'], 'x': x, 'z': z, 'k': math.floor(spin_roll * 4) * 16 % 64, 's': 1, 'lod': 0})
    return out

# ---------------------------------------------------------------- the layout

def layout_world(rules, ctx):
    seed = str(ctx['seed']); pool = set(ctx.get('pool') or [])
    house_rules = ctx.get('houseRules'); mix = ctx.get('mix') or (house_rules or {}).get('mix') or {}
    reserved = [{'id': c['id'], 'x': wr4(c['x']), 'z': wr4(c['z']), 'r': c['r'], 'spur': bool(c.get('spur'))} for c in (ctx.get('reserved') or [])]
    fields = world_fields(rules, seed)
    lanes = _make_lanes(rules, seed)
    square = {'x': 0, 'z': rules['paths']['square']['z'], 'r': rules['paths']['square']['r']}
    spurs = _make_spurs(rules, lanes, reserved)
    mask = _Mask(rules, lanes, square, reserved, spurs)
    T = rules.get('terrain'); ground = make_ground(rules, seed, fields, ctx.get('relief')) if T else None
    pads = []; water = None
    if ground:
        hs = grade_lanes(rules, ground, lanes, square)
        pads = pad_targets(rules, ground, reserved, square, hs)
        ramp_spurs(rules, ground, spurs)
    lots = _make_lots(rules, {'seed': seed, 'mix': mix, 'houseRules': house_rules}, lanes, mask, fields, ground) if 'house' in pool else []
    mask.lots = lots
    # A bell tower (the snow village's) takes the lot nearest the square before the water and the yards.
    tower_lot = None
    LM = rules.get('landmarks') or {}
    if ground and (LM.get('kinds') or {}).get('belltower') and (LM.get('prop') or 'landmark') in pool and lots:
        bi = 0; bd = math.inf
        for i, L in enumerate(lots):
            d = (L['x'] - square['x']) * (L['x'] - square['x']) + (L['z'] - square['z']) * (L['z'] - square['z'])
            if d < bd: bd = d; bi = i
        tower_lot = lots.pop(bi)
        reserved.append({'id': 'lm:belltower-lot', 'x': tower_lot['x'], 'z': tower_lot['z'], 'r': wr4(max(tower_lot['w'], tower_lot['d']) / 2), 'spur': False})
    if ground:
        water = {'ponds': plan_ponds(rules, seed, fields, mask), 'brook': None}
        mask.water = water
        water['brook'] = plan_brook(rules, seed, fields, mask, ground, lanes, spurs, square, water['ponds'], lots)
        bs = (water['brook'] or {}).get('basin')
        if bs: join_pad(rules, pads, {'x': bs['x'], 'z': bs['z'], 'r': wr4(bs['r'] + 1.4), 'h': wr4(ground.sample(bs['x'], bs['z']))})
        fields['shore'] = lambda x, z: _clamp01(1 - water_edge(water, x, z)['e'] / T['shore'])
        fields['bank'] = lambda x, z: _clamp01(1 - water_edge(water, x, z)['e'] / T['bank'])
    fences, walks, stones = _make_yards(rules, lots, lanes, pool)
    # Landmarks (world_landmarks.py) read the relief, the brook, the square and the lots, and claim their pads,
    # spurs and clearance before the scatter; the route graph chains them from the spawn.
    landmarks = (plan_landmarks(rules, {'seed': seed, 'treeRules': ctx.get('treeRules'), 'pool': pool},
                                {'lanes': lanes, 'square': square, 'spurs': spurs, 'mask': mask, 'fields': fields, 'ground': ground, 'pads': pads, 'water': water, 'lots': lots, 'walks': walks, 'reserved': reserved, 'towerLot': tower_lot})
                 if ground and rules.get('landmarks') and (rules['landmarks'].get('prop') or 'landmark') in pool else [])
    spawn = next((c for c in reserved if c['id'] == 'spawn'), {'x': 0, 'z': 28})
    route = chain_route(landmark_pois(landmarks), spawn) if landmarks else None
    terrain = None; shore = []
    if ground:
        level_lots(rules, ground, lots + [tower_lot] if tower_lot else lots)
        ramp_walks(rules, ground, walks, lots)
        level_landmarks(rules, ground, landmarks)
        level_pads(rules, ground, pads)
        water['keep'] = landmark_keeps(landmarks)
        surface = carve_water(rules, ground, water, lanes)
        shore = shore_dressing(rules, seed, ground, water, lanes, spurs + walks)['flora'] if 'nature' in pool else []
        terrain = finish_terrain(ground, surface)
        finish_landmarks(rules, ground, water, landmarks)
        for f in fences: f['y'] = wr4(ground.low(f['x'], f['z'], 0.3))
        for st in stones: st['y'] = wr4(ground.sample(st['x'], st['z']))
    zones = _make_zones(rules, {'seed': seed, 'ground': ground}, mask, fields)
    mask.zones = zones
    scatter = _make_scatter(rules, {'seed': seed, 'pool': pool, 'treeRules': ctx.get('treeRules'), 'ground': ground}, mask, fields)
    pickups = _make_pickups(rules, {'seed': seed, 'pickups': ctx.get('pickups')}, lanes, mask)
    signs = _make_signs(rules, {'seed': seed, 'pool': pool}, lanes, mask)
    for p in pickups + signs: p['y'] = wr4(ground.sample(p['x'], p['z'])) if ground else 0
    return {'version': WORLD_GRAMMAR_VERSION, 'seed': seed, 'lanes': lanes, 'square': square, 'spurs': spurs, 'lots': lots, 'fences': fences, 'walks': walks,
            'stones': stones, 'zones': zones, 'scatter': scatter, 'pickups': pickups, 'signs': signs, 'terrain': terrain, 'water': water, 'shore': shore,
            'landmarks': landmarks, 'route': route}


def world_digest(layout):
    def pt(p): return [p['x'], p['z'], p['k'], p['s'], p['lod'], p.get('y', 0)]
    T = layout.get('terrain'); W = layout.get('water'); B = W.get('brook') if W else None
    return {
        'version': layout['version'], 'seed': layout['seed'],
        'lanes': [[l['id'], l['w'], l['base'], l['pts'], l.get('h')] for l in layout['lanes']], 'square': layout['square'], 'spurs': [[s['id'], s['w'], s['pts']] for s in layout['spurs']],
        'lots': [[L['index'], L['slot'], L['lane'], L['family'], L['x'], L['z'], L['w'], L['d'], L['front'], L['score'], L['setback'], L['key'], L['door'], L['plan']['dna'], L.get('y', 0)] for L in layout['lots']],
        'fences': [[f['lot'], f['x'], f['z'], f['front'], f.get('y', 0)] for f in layout['fences']], 'walks': [[w['lot'], w['w'], w['pts']] for w in layout['walks']],
        'stones': [[s['lot'], s['part']] + pt(s) for s in layout['stones']], 'zones': [[z['x'], z['z'], z['r']] for z in layout['zones']],
        'scatter': [[s['cls'], s.get('prop') or s.get('part') or s['tree']['species']] + pt(s) + [s.get('trunk'), s.get('height'), 1 if s.get('tint') else 0, s.get('crown'), tree_digest(s['tree'])['hash'] if s.get('tree') else None, s.get('lean')] for s in layout['scatter']],
        'pickups': [[p['id'], p['x'], p['z'], p.get('y', 0)] for p in layout['pickups']], 'signs': [[s['part']] + pt(s) for s in layout['signs']],
        'terrain': [T['res'], T['cell'], T['min'], T['max'], grid_hash(T['heights']), grid_hash(T['depth'])] if T else None,
        'ponds': [[p['x'], p['z'], p['r'], p['reach'], p['level'], grid_hash(p['radii'])] for p in W['ponds']] if W else None,
        'brook': [B['pts'], B['surface'], B['w'], B['depth'], [[b['lane'], b['x'], b['z'], b['front'], b['reach'], b['at']] for b in B['bridges']],
                  [B['basin']['x'], B['basin']['z'], B['basin']['r'], B['basin']['level'], B['basin']['y'], B['basin']['q']]] if B else None,
        'shore': [[s['kind'], s['part']] + pt(s) for s in (layout.get('shore') or [])],
        'landmarks': [[L['kind'], L['id'], L['x'], L['z'], L['front'], L['k'], L.get('pad'), L.get('y', 0), L['spur']['pts'] if L.get('spur') else None, L.get('lane'), L.get('part'), L.get('colors'),
                       L.get('keeper'), L.get('wheel'), L.get('rect'), L.get('level'), L.get('centre'), [[t['x'], t['z'], t['k'], t['s'], t['trunk'], t['height'], t['crown'], t['y'], tree_digest(t['tree'])['hash']] for t in (L.get('trees') or [])]]
                      for L in (layout.get('landmarks') or [])],
        'route': [layout['route']['start'], [[n['kind'], n['id'], n['x'], n['z'], n['hook']['type'], n['hook']['label'], n['hook'].get('item'), n['hook'].get('from'), n['hook'].get('gives'), n.get('life'), n.get('keeper'), n.get('lane'), n.get('stand')] for n in layout['route']['nodes']],
                  [[e['a'], e['b'], e['d'], e['via']] for e in layout['route']['edges']]] if layout.get('route') else None,
    }

# ---------------------------------------------------------------- fixtures

def _reserved_like_compiler(clear, spawn_z=28, sites=None, cover_rows=4, gates=((12, -31), (-12, -8), (12, 15))):
    """The places src/world/shooterProject.js reserves for a shooter mission: the spawn, every pad site, the cover
    rows and the gates. The fixtures vary these the way missions do, so the parity covers the spur logic too."""
    out = [{'id': 'spawn', 'x': 0, 'z': spawn_z, 'r': clear['spawn']}]
    for x, z in (sites or [(x, z) for z in (-27, -17, -7, 10, 20, 29) for x in (-10, 10)]): out.append({'id': 'site', 'x': x, 'z': z, 'r': clear['site'], 'spur': True})
    for i in range(cover_rows):
        for side in (-1, 1): out.append({'id': 'cover', 'x': side * (5 + 0.7 * ((i + 1) % 3)), 'z': -26 + i * 9, 'r': clear['cover']})
    for x, z in gates: out.append({'id': 'gate', 'x': x, 'z': z, 'r': clear['gate'], 'spur': True})
    return out


def world_fixture_cases(rules, pack):
    props = [p['id'] for p in pack['props']]; clear = rules['clear']; cases = []
    seeds = ['K7QN-3F2A-9XBD', 'TEST-1234-ABCD', 'AAAA-BBBB-CCCC', 'HOUS-E5AR-EFUN'] + ['fx-%d' % i for i in range(12)]
    for i, seed in enumerate(seeds):
        pool = props if i % 4 != 3 else [p for p in props if p not in ('tree', 'fence')]
        cases.append({'seed': seed, 'reserved': _reserved_like_compiler(clear, cover_rows=2 + (i % 3) * 2, gates=[(12, -31), (-12, -8), (12, 15)][:1 + i % 3]),
                      'pool': pool, 'pickups': ['ammoSupply', 'healthSupply', 'grenadeSupply'][:1 + i % 3]})
    cases.append({'seed': 'exploration', 'reserved': _reserved_like_compiler(clear, sites=[(-8, 18), (10, -17), (-10, -27), (10, 10)] + [(x, z) for z in (-27, -17, -7, 10, 20, 29) for x in (-10, 10)], cover_rows=0, gates=[]),
                  'pool': [p for p in props if p not in ('ammoSupply', 'grenadeSupply')], 'pickups': ['healthSupply']})
    cases.append({'seed': 'no-houses', 'reserved': _reserved_like_compiler(clear), 'pool': [p for p in props if p != 'house'], 'pickups': []})
    cases.append({'seed': 'no-flora', 'reserved': _reserved_like_compiler(clear), 'pool': [p for p in props if p != 'nature'], 'pickups': []})
    return cases


def kernel_fixture_cases(rules, pack, grounds):
    """Villages on the kernel's ground: one case per entry of kernel-ground.json (tools/build/kernel-ground-fixtures.mjs
    wrote it from src/world/kernelGround.js), the relief named by its index, so the parity covers every step that shapes
    a world's ground rather than the village's own hills."""
    props = [p['id'] for p in pack['props']]; clear = rules['clear']
    return [{'seed': g['inputs']['seed'], 'reserved': _reserved_like_compiler(clear, cover_rows=2 + 2 * (i % 2)), 'pool': props,
             'pickups': ['ammoSupply', 'healthSupply', 'grenadeSupply'][:1 + i % 3], 'reliefRef': i} for i, g in enumerate(grounds)]


def write_world_fixtures(pack_path, out_path, biome=None):
    """The village cases, then (when kernel-ground.json sits beside out_path) the same villages on the kernel's ground."""
    import os
    from house_grammar import apply_biome
    pack = apply_biome(json.load(open(pack_path)), biome); rules = pack['world']; data = []
    kernel_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), 'kernel-ground.json')
    grounds = json.load(open(kernel_path)) if os.path.exists(kernel_path) else []
    for c in world_fixture_cases(rules, pack) + kernel_fixture_cases(rules, pack, grounds):
        ctx = dict(c); ctx['houseRules'] = pack['houses']; ctx['treeRules'] = pack['trees']
        if 'reliefRef' in c: ctx['relief'] = {'res': grounds[c['reliefRef']]['res'], 'heights': grounds[c['reliefRef']]['heights']}
        data.append({'request': c, 'digest': world_digest(layout_world(rules, ctx))})
    with open(out_path, 'w') as f: f.write(json.dumps(data, separators=(',', ':')) + '\n')
    return len(data)


if __name__ == '__main__':
    import sys
    print(write_world_fixtures(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
