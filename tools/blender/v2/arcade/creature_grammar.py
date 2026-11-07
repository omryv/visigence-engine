"""Python port of src/world/creatureGrammar.js: the same rules, the same PRNG, the same blueprint.

The Blender preview (creature_preview.py) assembles creatures from these blueprints, so what the
art pipeline renders is exactly what the engine spawns for the same key. tools/test/
test-creature-grammar.mjs compares this port against the JS through fixtures written by
write_fixtures() - keep the two files in lockstep (see PARITY RULES in the JS header).

Standalone (no bpy): runs inside Blender (after tools/blender/v2/core/grammar_core.py, whose seed hash, PRNG and
choice helpers it uses) or with python3.
"""
import json, math

try:
    hash_seed, mulberry32, _clamp01, _choose, _weight_of, _toned, js_str
except NameError:
    import os, sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core'))
    from grammar_core import M32, _imul, hash_seed, mulberry32, _clamp01, _choose, _weight_of, _toned, js_str

GRAMMAR_VERSION = 1


def creature_rng(key):
    return mulberry32(hash_seed(str(key)))


def generate_creature(rules, family, key, role='hostile', rank='minion'):
    F = (rules.get('families') or {}).get(family)
    if not F: raise ValueError('Unknown creature family: %s' % family)
    rng = creature_rng('%s|%s|%s|%s' % (family, rank, role, js_str(key)))
    size = rng()
    round_ = _clamp01(0.7 * rng() + 0.3 * (1 - size))
    ornament = rng()
    tone = rng() * 2 - 1
    palette_roll, mood_roll = rng(), rng()
    dna = {'size': size, 'round': round_, 'ornament': ornament, 'tone': tone}
    boss = (F.get('boss') or {}) if rank == 'boss' else None
    base = (boss or {}).get('palette') or F['palettes'][math.floor(palette_roll * len(F['palettes']))]
    palette = {slot: _toned(h, tone) for slot, h in base.items()}
    moods = (F.get('moods') or {}).get(role) or rules['moods'][role]
    expression = (boss or {}).get('expression') or _choose(mood_roll, list(moods.keys()), lambda k: moods[k])
    parts, patterns, tags = [], [], set()
    for step in F['plan']:
        chance_roll, pick_roll, extra_a, extra_b = rng(), rng(), rng(), rng()
        if step.get('rank') and rank not in step['rank']: continue
        forced = next((o for o in step['options'] if o.get('part') in boss['require']), None) if boss and boss.get('require') else None
        chance = 1 if 'chance' not in step else _clamp01(step['chance'] * (0.6 + 0.8 * ornament))
        if not forced and chance_roll >= chance: continue

        def allowed(o):
            return (not o.get('rank') or rank in o['rank']) and all(t in tags for t in o.get('needs', [])) \
                and not any(t in tags for t in o.get('clash', []))
        option = forced or _choose(pick_roll, [o for o in step['options'] if allowed(o)], lambda o: _weight_of(o, dna))
        if not option:
            if 'chance' not in step: raise ValueError('Creature %s: no allowed option for required slot "%s"' % (family, step['slot']))
            continue
        for t in option.get('tags', []): tags.add(t)
        if step.get('kind') == 'pattern':
            if option['pattern'] == 'none': continue
            c0, c1 = option['count']; s0, s1 = option['size']
            patterns.append({'slot': step['slot'], 'on': step.get('on', 'body'), 'pattern': option['pattern'], 'color': option.get('color', 'trim'),
                             'count': c0 + math.floor(extra_a * (c1 - c0 + 1)), 'size': s0 + (s1 - s0) * extra_b, 'seed': math.floor(pick_roll * 4294967296)})
            continue
        parts.append({'slot': step['slot'], 'part': option['part'], 'on': None if step['slot'] == 'body' else step.get('on', 'body'),
                      'socket': step.get('socket'), 'pair': bool(step.get('pair'))})
    face = {'expression': expression, **rules['expressions'][expression], 'eye': (F.get('face') or {}).get('eye', 1) * (1 + 0.35 * (1 - size))}
    return {'version': GRAMMAR_VERSION, 'family': family, 'rank': rank, 'role': role, 'key': js_str(key), 'dna': dna, 'palette': palette,
            'colors': rules['colors'], 'face': face, 'parts': parts, 'patterns': patterns, 'hover': F.get('hover', 0)}


def fixture_cases(rules):
    """The cases both sides must agree on: every family x role, a spread of keys, and each boss."""
    cases = []
    for fam in rules['families']:
        for role in ('hostile', 'friendly'):
            for key in ('K7QN-3F2A-9XBD|0', 'TEST-1234-ABCD|7', 'wild|3', 12345):
                cases.append({'family': fam, 'key': key, 'role': role, 'rank': 'minion'})
    for r in rules.get('roster', []):
        if r.get('rank') == 'boss':
            cases.append({'family': r['family'], 'key': 'boss|1', 'role': 'hostile', 'rank': 'boss'})
    return cases


def write_fixtures(pack_path, out_path):
    rules = json.load(open(pack_path))['creatures']
    data = [{'request': c, 'blueprint': generate_creature(rules, c['family'], c['key'], c['role'], c['rank'])} for c in fixture_cases(rules)]
    with open(out_path, 'w') as f: f.write(json.dumps(data, indent=1) + '\n')
    return len(data)


if __name__ == '__main__':
    import sys
    print(write_fixtures(sys.argv[1], sys.argv[2]))
