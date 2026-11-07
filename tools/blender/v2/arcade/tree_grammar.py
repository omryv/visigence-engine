"""Python port of src/world/treeGrammar.js: the same rules, the same PRNG streams, the same plan.

The Blender preview (tree_preview.py) meshes these plans, so what the art pipeline renders is exactly what the
engine builds for the same key. tools/test/test-tree-grammar.mjs compares this port against the JS through
fixtures written by write_tree_fixtures(): full plans plus a digest. Keep the two files in lockstep (see PARITY
RULES in the JS header): every expression in the same operand order, every roll drawn in the same order whatever
branch is taken, numbers out through r4, powers by repeated multiplication.

Standalone (no bpy): runs inside Blender (after tools/blender/v2/core/grammar_core.py and layout_core.py, then creature_grammar.py and house_grammar.py, whose PRNG, choice
helpers and DIRS64 it shares) or with python3:
    python3 tools/blender/v2/arcade/tree_grammar.py packs/arcade/pack.json tools/test/fixtures/tree-plans.json
"""
import json, math

try:
    hash_seed, mulberry32, _choose, _weight_of, _toned, _clamp01, js_str, _allows, DIRS64
except NameError:
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from creature_grammar import hash_seed, mulberry32, _choose, _weight_of, _toned, _clamp01, js_str
    from house_grammar import _allows, DIRS64

TREE_GRAMMAR_VERSION = 1
TREE_SYMBOLS = 'F[]+-/\\LP'
MIN_SEGMENT = 0.15
MIN_SOCKET = 0.45
TRUNK_WALL = 1.15


def tr4(v): return math.floor(v * 10000 + 0.5) / 10000
def _r4v(a): return [tr4(a[0]), tr4(a[1]), tr4(a[2])]
def _tmix(rng_, t): return rng_[0] + (rng_[1] - rng_[0]) * t
def _tmad(a, b, s): return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
def _tcross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def _mod64(k): return ((k % 64) + 64) % 64


def _tunit(a):
    l = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    return [a[0] / l, a[1] / l, a[2] / l]


def tree_rng(species, key, stage):
    return mulberry32(hash_seed('tree|%s|%s|%s' % (species, key, stage)))


def _pitch(st, k, sign):
    c, s = DIRS64[_mod64(k)]; H = st['H']; U = st['U']
    return ([H[0] * c + U[0] * s * sign, H[1] * c + U[1] * s * sign, H[2] * c + U[2] * s * sign],
            [U[0] * c - H[0] * s * sign, U[1] * c - H[1] * s * sign, U[2] * c - H[2] * s * sign])


def _roll(st, k, sign):
    c, s = DIRS64[_mod64(k)]; L = st['L']; U = st['U']
    st['L'] = [L[0] * c + U[0] * s * sign, L[1] * c + U[1] * s * sign, L[2] * c + U[2] * s * sign]
    st['U'] = [U[0] * c - L[0] * s * sign, U[1] * c - L[1] * s * sign, U[2] * c - L[2] * s * sign]


def generate_tree(rules, species, key):
    S = (rules.get('species') or {}).get(species)
    if not S: raise ValueError('Unknown tree species: %s' % species)
    k = js_str(key); lim = rules['limits']
    d = tree_rng(species, k, 'dna')
    size = d(); age = d(); bushy = d(); gnarl = d(); tone = d() * 2 - 1; palette_roll = d()
    dna = {'size': size, 'age': age, 'bushy': bushy, 'gnarl': gnarl, 'tone': tone}
    base = S['palettes'][math.floor(palette_roll * len(S['palettes']))]
    palette = {slot: _toned(h, tone) for slot, h in base.items()}
    c = tree_rng(species, k, 'style'); tags = set(); style = {}; P = dict(S)
    for step in S.get('plan') or []:
        chance_roll, pick_roll = c(), c()
        chance = 1 if 'chance' not in step else _clamp01(step['chance'] * (0.6 + 0.8 * dna[step.get('gene', 'bushy')]))
        if chance_roll >= chance: continue
        option = _choose(pick_roll, [o for o in step['options'] if _allows(o, tags)], lambda o: _weight_of(o, dna))
        if not option:
            if 'chance' not in step: raise ValueError('Tree %s: no allowed option for required slot "%s"' % (species, step['slot']))
            continue
        for t in option.get('tags', []): tags.add(t)
        style[step['slot']] = option['id']
        P.update(option.get('set', {}))
    w = tree_rng(species, k, 'grow')
    iterations = min(P['depth'][1], P['depth'][0] + math.floor(age * (P['depth'][1] - P['depth'][0] + 1)))
    s = P['axiom']
    choices = []
    for it in range(iterations):
        out = ''
        for ch in s:
            R = P['rules'].get(ch)
            if not R:
                out += ch; continue
            roll_ = w(); opt = _choose(roll_, [o for o in R if _allows(o, tags)], lambda o: _weight_of(o, dna))
            if opt:
                out += opt['to']; choices.append('%s%d' % (ch, next(i for i, o in enumerate(R) if o is opt)))
        s = out
    string = ''
    for ch in s: string += ch if ch in TREE_SYMBOLS else P['tip']
    j = tree_rng(species, k, 'shape')
    hs = _tmix(P['scale'], size); cap = _tmix(P['crown'], size); seg_cap = min(P['segments'], lim['segments'])
    segments = []; candidates = []; stack = []
    st = {'p': [0, 0, 0], 'H': [0, 0, 1], 'L': [0, 1, 0], 'U': [-1, 0, 0], 'r': P['trunk'] * hs, 'd': 0, 'last': -1, 'dead': False}
    pruned = 0; leaves = 0
    for ch in string:
        if ch == 'F':
            jr = j()
            if st['dead']: continue
            if len(segments) >= seg_cap:
                pruned += 1; continue
            ln = P['length'][min(st['d'], len(P['length']) - 1)] * hs * (1 - P['jitter'] * 0.5 + P['jitter'] * jr)
            a = st['H'][0] * st['H'][0] + st['H'][1] * st['H'][1]; b = 2 * (st['p'][0] * st['H'][0] + st['p'][1] * st['H'][1]); cc = st['p'][0] * st['p'][0] + st['p'][1] * st['p'][1] - cap * cap
            if a > 1e-9:
                disc = b * b - 4 * a * cc
                if disc >= 0:
                    t = (-b + math.sqrt(disc)) / (2 * a)
                    if t < ln: ln = t
            end = _tmad(st['p'], st['H'], ln)
            if ln < MIN_SEGMENT or (st['d'] > 0 and end[2] < lim['floor']):
                st['dead'] = True; continue
            r1 = max(P['twig'], st['r'] * P['taper'])
            segments.append({'a': _r4v(st['p']), 'b': _r4v(end), 'r0': tr4(st['r']), 'r1': tr4(r1), 'd': st['d'], 'i': st['last']})
            st['p'] = end; st['r'] = r1; st['last'] = len(segments) - 1
            st['H'] = _tunit([st['H'][0], st['H'][1], st['H'][2] + P['tropism']])
            st['L'] = _tunit(_tcross(st['U'], st['H'])); st['U'] = _tcross(st['H'], st['L'])
        elif ch == '[':
            stack.append(st)
            st = dict(st); st['d'] = st['d'] + 1; st['r'] = max(P['twig'], st['r'] * P['branch'])
        elif ch == ']':
            if stack: st = stack.pop()
        elif ch == '+' or ch == '-':
            jr = j()
            if st['dead']: continue
            k_ = P['leanStep'] if st['d'] == 0 else P['pitch'][0] + math.floor(jr * (P['pitch'][1] - P['pitch'][0] + 1)) + math.floor(gnarl * P['gnarl'])
            H, U = _pitch(st, k_, 1 if ch == '+' else -1)
            if H[2] < DIRS64[P['lean'] if st['d'] == 0 else P['spread']][0]: continue
            st['H'] = H; st['U'] = U
        elif ch == '/' or ch == '\\':
            jr = j()
            if st['dead']: continue
            _roll(st, P['roll'] + math.floor(jr * (2 * P['rollJitter'] + 1)) - P['rollJitter'], 1 if ch == '/' else -1)
        elif ch == 'L' or ch == 'P':
            pr, sr, sc = j(), j(), j()
            if st['dead']: continue
            tip = ch == 'P'; leaf = P['leaf']
            lst = (leaf.get('tips') or leaf['parts']) if tip else leaf['parts']
            rng_ = (leaf.get('tipScale') or leaf['scale']) if tip else leaf['scale']
            part = lst[math.floor(pr * len(lst))]; ext = rules['parts'][part]
            scale = _tmix(rng_, sc) * hs
            for q in range(st['d']): scale *= leaf['byDepth']
            if not tip:
                scale *= 1 - leaf['shrink'] * leaves; leaves += 1
            if ext['bot'] < 0 and st['p'][2] + ext['bot'] * scale < lim['floor']: scale = (st['p'][2] - lim['floor']) / -ext['bot']
            if scale < MIN_SOCKET: continue
            candidates.append({'part': part, 'p': _r4v(st['p']), 'k': math.floor(sr * 64) % 64, 's': tr4(scale), 'd': st['d'], 'tip': tip})
    socket_cap = min(P['sockets'], lim['sockets']); leaf_list = [q for q in candidates if not q['tip']]
    stride = math.floor((len(leaf_list) + socket_cap - 1) / socket_cap) if len(leaf_list) > socket_cap else 1
    keep = set()
    for q in range(len(leaf_list)):
        if q % stride == 0: keep.add(id(leaf_list[q]))
    sockets = [{kk: v for kk, v in q.items() if kk != 'tip'} for q in candidates if q['tip'] or id(q) in keep]
    trunk = tr4((segments[0]['r0'] if segments else P['trunk'] * hs) * TRUNK_WALL)
    clear = 0; crown = trunk * 2; top = 0
    for g in segments:
        if g['d'] == 0 and g['b'][2] > clear: clear = g['b'][2]
        if g['b'][2] > top: top = g['b'][2]
        reach = math.sqrt(g['b'][0] * g['b'][0] + g['b'][1] * g['b'][1]) + g['r1']
        if reach > crown: crown = reach
    for q in sockets:
        ext = rules['parts'][q['part']]; reach = math.sqrt(q['p'][0] * q['p'][0] + q['p'][1] * q['p'][1]) + ext['r'] * q['s']; high = q['p'][2] + ext['top'] * q['s']
        if reach > crown: crown = reach
        if high > top: top = high
    out = {'version': TREE_GRAMMAR_VERSION, 'species': species, 'key': k, 'dna': dna, 'palette': palette, 'colors': rules['colors'], 'style': style,
           'scale': tr4(hs), 'iterations': iterations, 'choices': choices, 'string': string, 'segments': segments, 'sockets': sockets, 'pruned': pruned,
           'trunk': trunk, 'clear': tr4(clear), 'crown': tr4(crown), 'top': tr4(top), 'outline': P['outline']}
    # a species' trunk style for the mesher: 'rings' (a palm's frond scars) or 'ribs' (a cactus); absent for bark
    if P.get('bark'): out['bark'] = P['bark']
    return out


def tree_slot_color(plan, slot):
    key = slot[0].lower() + slot[1:]
    return plan['palette'].get(key) or plan['colors'].get(key) or plan['palette']['leaf']


def tree_digest(plan):
    def num(v): return str(math.floor(v * 10000 + 0.5))
    rows = [','.join(num(v) for v in (g['a'] + g['b'] + [g['r0'], g['r1'], g['d'], g['i']])) for g in plan['segments']]
    for q in plan['sockets']: rows.append(','.join([q['part']] + [num(v) for v in q['p']] + [str(q['k']), num(q['s']), str(q['d'])]))
    return {'segments': len(plan['segments']), 'sockets': len(plan['sockets']), 'trunk': plan['trunk'], 'clear': plan['clear'],
            'crown': plan['crown'], 'top': plan['top'], 'hash': hash_seed('\n'.join(rows))}


def tree_fixture_cases(rules):
    cases = []
    for species in rules['species']:
        for i in range(20): cases.append({'species': species, 'key': 'fixture|%d' % i})
        cases.append({'species': species, 'key': 'K7QN-3F2A-9XBD|%s|0' % species})
    return cases


def write_tree_fixtures(pack_path, out_path, biome=None):
    from house_grammar import apply_biome
    rules = apply_biome(json.load(open(pack_path)), biome)['trees']; data = []
    for c in tree_fixture_cases(rules):
        plan = generate_tree(rules, c['species'], c['key'])
        data.append({'request': c, 'plan': plan, 'digest': tree_digest(plan)})
    with open(out_path, 'w') as f: f.write(json.dumps(data, separators=(',', ':')) + '\n')
    return len(data)


if __name__ == '__main__':
    import sys
    print(write_tree_fixtures(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
