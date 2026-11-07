"""Blender preview of the creature grammar: assembles blueprints (creature_grammar.py, identical to the engine's)
from the parts library (creature_parts.py) the way render/CreatureAssembler.js does, renders a family sheet for
review and the studio's catalog cards.

exec after creature_parts.py and creature_grammar.py (same globals):
    g['sheet_creatures']()     every family, hostile and friendly variants, in the review scene
    g['review_creatures']()    one light EEVEE render of the sheet
    g['cards_creatures']()     256 px catalog cards, one per roster entry

Assembly rules shared with the engine:
  - the body sits at the creature origin; every other part goes on its parent's socket (parent = the part
    chosen for the step's `on` slot, default the body), right side first, then mirrored across X for pairs;
  - CRT_<Slot> colour slots take the blueprint's palette (body, accent, trim, leaf) or shared colours;
  - the face is projected onto the body: rays from face.c at (azimuth, elevation) place flattened eyes,
    pupils, catchlights, brows, mouth and blush on the surface, sized from face.r x the eye gene;
  - surface patterns are scattered over the target part's pattern zone by Poisson-disc sampling on the
    sphere of directions (same PRNG as the grammar), then projected the same way.
"""
import bpy, math, json
from mathutils import Vector, Matrix

CREATURE_COLL = 'ARC_Creatures'
SHEET_REVIEW = OUT + '/arcade/arcade-creatures-review.png'
SX = Matrix.Diagonal((-1, 1, 1, 1))
PAIR_COLORS = {'Body': 'body', 'Accent': 'accent', 'Trim': 'trim', 'Leaf': 'leaf'}
SHARED = {'Wood': 'wood', 'Gold': 'gold', 'Stone': 'stone', 'Wing': 'wing', 'Ink': 'ink', 'White': 'white'}


def bl(v):
    """glTF (Y up, +Z front) -> Blender (Z up, -Y front)."""
    return Vector((v[0], -v[2], v[1]))


def slot_color(bp, slot):
    pal, col = bp['palette'], bp['colors']
    if slot in PAIR_COLORS:
        key = PAIR_COLORS[slot]
        return pal.get(key) or {'accent': pal.get('body'), 'trim': col['white'], 'leaf': col['leaf']}.get(key) or pal['body']
    return col[SHARED.get(slot, 'white')]


def preview_mat(slot, hexs):
    name = f'CRTP_{slot}_{hexs}'
    m = bpy.data.materials.get(name)
    if m: return m
    if slot == 'Shine': return glow(name, hexs)
    return toon(name, hexs, **SLOT_SHADE.get(slot, {}))


def _copy(src, coll):
    c = src.copy(); c.data = src.data.copy(); coll.objects.link(c)
    return c


def _recolor(ob, bp):
    for i, m in enumerate(ob.data.materials):
        if m and m.name.startswith('CRT_'):
            slot = m.name[4:]
            ob.data.materials[i] = preview_mat(slot, slot_color(bp, slot))


def _socket_matrix(part_id, socket):
    e = bpy.data.objects.get(f'{part_id}:{socket}')
    if not e: raise KeyError(f'{part_id} has no socket {socket}')
    # from the transform channels, not matrix_local: the library is hidden, so it is never evaluated
    return e.matrix_parent_inverse @ e.matrix_basis

# ---------------------------------------------------------------- face


def _stick(S, name, d, r, mat, scale, out=0.0, spin=0.0, subd=3):
    return S.stick(name, d, r, mat, scale, out=out, spin=spin, subd=subd)


def build_face(bp, body, coll):
    """Eyes, pupils, catchlights, brows, mouth and blush projected onto the body (in its local frame)."""
    meta = body['face'] if 'face' in body else None
    if meta is None: return [], []
    c = bl(meta['c']); S = Skin(body, c)
    face = bp['face']; r = meta['r'] * face['eye']; az, el = meta['az'] * (0.9 + 0.1 * face['eye']), meta['el']
    loc, _ = S.hit(fdir(az, el)); ang = math.degrees(r / (loc - S.c).length)
    ink, white, shine = preview_mat('Ink', bp['colors']['ink']), preview_mat('White', bp['colors']['white']), preview_mat('Shine', bp['colors']['shine'])
    blush = preview_mat('Accent', bp['colors']['blush'])
    feats, gloss = [], []
    look = face.get('look', 0)
    for s in (-1, 1):
        a = s * az
        if face['eyes'] == 'round':
            feats.append(_stick(S, f'sclera{s}', fdir(a, el), r, white, (0.82, 1.12, 0.42), out=-0.25 * r))
            feats.append(_stick(S, f'pupil{s}', fdir(a, el - 0.3 * ang + look * ang * 0.4), r * 0.58, ink, (0.8, 1.0, 0.5), out=r * 0.1))
            gloss.append(_stick(S, f'catch{s}', fdir(a - ang * 0.25, el + ang * 0.3), r * 0.2, shine, (1, 1, 0.5), out=r * 0.34, subd=2))
        elif face['eyes'] == 'arc':
            feats.append(S.line(f'arc{s}', [fdir(a - ang * 0.8, el - ang * 0.25), fdir(a, el + ang * 0.45), fdir(a + ang * 0.8, el - ang * 0.25)], r * 0.2, ink, out=r * 0.08))
        else:  # sleepy
            feats.append(S.line(f'lid{s}', [fdir(a - ang * 0.8, el), fdir(a, el - ang * 0.35), fdir(a + ang * 0.8, el)], r * 0.18, ink, out=r * 0.08))
        if face['brows']:
            b = el + ang * 1.35
            feats.append(S.line(f'brow{s}', [fdir(s * (az - ang * 0.9), b), fdir(s * (az + ang * 1.1), b + face['brows'])], r * 0.2, ink, out=r * 0.1))
        if face['blush']:
            feats.append(_stick(S, f'blush{s}', fdir(s * min(az * 1.9, az + ang * 2.4), el - ang * 1.3), r * 0.75, blush, (1.3, 0.8, 0.22), out=-0.08 * r, subd=2))
    m, w, dep = el - ang * 2.1, az * 0.5, ang * 0.55
    kind = face['mouth']
    if kind in ('smile', 'small'):
        ww = w if kind == 'smile' else w * 0.55
        feats.append(S.line('mouth', [fdir(ww * t, m - dep * (1 - t * t)) for t in (-1, -0.5, 0, 0.5, 1)], r * 0.16, ink, out=r * 0.06))
    elif kind == 'frown':
        feats.append(S.line('mouth', [fdir(w * 0.7 * t, m - dep + dep * (1 - t * t)) for t in (-1, -0.5, 0, 0.5, 1)], r * 0.16, ink, out=r * 0.06))
    elif kind == 'w':
        feats.append(S.line('mouth', [fdir(w * 0.6 * t, m - dep * k) for t, k in ((-1, 0), (-0.5, 1), (0, 0.25), (0.5, 1), (1, 0))], r * 0.14, ink, out=r * 0.06))
    elif kind == 'open':
        feats.append(_stick(S, 'mouth', fdir(0, m - dep * 0.6), r * 0.62, ink, (1.2, 0.95, 0.3), out=-0.1 * r))
    elif kind == 'fang':
        feats.append(S.line('mouth', [fdir(w * 0.55 * t, m - dep * 0.2 * (1 - t * t)) for t in (-1, 0, 1)], r * 0.15, ink, out=r * 0.06))
        for s in (-1, 1): feats.append(_stick(S, f'fang{s}', fdir(s * w * 0.3, m - dep * 0.45), r * 0.22, white, (0.7, 1.3, 0.5), out=0.0, subd=2))
    else:  # roar
        feats.append(_stick(S, 'mouth', fdir(0, m - dep * 0.6), r * 0.95, ink, (1.9, 0.8, 0.3), out=-0.12 * r))
        for s in (-1, 1): feats.append(_stick(S, f'tooth{s}', fdir(s * w * 0.35, m + dep * 0.15), r * 0.26, white, (0.9, 1.1, 0.5), out=0.0, subd=2))
    ensure_grad(feats + gloss)            # projected pieces carry no gradient: give them a white one
    return feats, gloss

# ---------------------------------------------------------------- patterns


def scatter_dirs(meta, count, seed, kind):
    """Directions over the pattern zone: evenly spaced on a ring, or Poisson-disc (dart throwing with a
    minimum angular distance sized to the count) on the sphere of directions."""
    rng = mulberry32(seed); lo, hi = (math.radians(e) for e in meta['el'])
    dirs = []
    if kind == 'ring':
        el = lo + (hi - lo) * 0.18; off = rng() * 360
        return [fdir(off + 360 * k / count, math.degrees(el)) for k in range(count)]
    z0, z1 = math.sin(lo), math.sin(hi)
    dmin = math.sqrt(2 * math.pi * (z1 - z0) / count) * 0.72
    for _ in range(count * 30):
        if len(dirs) >= count: break
        z = z0 + rng() * (z1 - z0); a = rng() * 2 * math.pi; rxy = math.sqrt(max(0.0, 1 - z * z))
        d = Vector((rxy * math.cos(a), rxy * math.sin(a), z))
        if all(d.angle(p) >= dmin for p in dirs): dirs.append(d)
    return dirs


def build_pattern(bp, pat, target, coll):
    meta = target['pattern'] if 'pattern' in target else None
    if meta is None: return []
    S = Skin(target, bl(meta['c'])); rng = mulberry32(pat['seed'] ^ 0x5bd1e995)
    mat = preview_mat('Trim', bp['palette'].get(pat['color']) or bp['colors']['white'])
    out = []
    for i, d in enumerate(scatter_dirs(meta, pat['count'], pat['seed'], pat['pattern'])):
        r = pat['size'] * (0.8 + 0.4 * rng())
        try: out.append(S.stick(f'spot{i}', d, r, mat, (1, 1, 0.22), out=-0.02 * r, subd=2))
        except ValueError: pass
    ensure_grad(out)
    return out

# ---------------------------------------------------------------- assembly


def assemble(bp, name, coll):
    """Blueprint -> objects in `coll` under one empty named `name` (the creature root, at the origin)."""
    root = bpy.data.objects.new(name, None); coll.objects.link(root)
    lib = bpy.data.collections[PARTS_COLL]
    placed = {}
    for p in bp['parts']:
        src = lib.objects[p['part']]
        if p['on'] is None: M = [(Matrix.Identity(4), False)]
        else:
            parent_part, parent_M, _ = placed[p['on']]
            base = parent_M @ _socket_matrix(parent_part, p['socket'])
            # the left of a pair is the right mirrored across X (a negative-scale matrix; Blender keeps the winding right)
            M = [(base, False)] + ([(SX @ base, True)] if p['pair'] else [])
        for i, (mw, mirror) in enumerate(M):
            c = _copy(src, coll); c.name = f'{name}.{p["slot"]}{"L" if mirror else ""}'
            _recolor(c, bp); c.parent = root; c.matrix_parent_inverse = Matrix.Identity(4); c.matrix_basis = mw
            c['arc_outline'] = src.get('arc_outline', 0.018)
            if i == 0: placed[p['slot']] = (p['part'], mw, c)
            if p['on'] is None:
                feats, gloss = build_face(bp, c, coll)
                for f in feats + gloss:
                    f.parent = root; f.matrix_basis = mw.copy(); coll.objects.link(f) if f.name not in coll.objects else None
                    for u in list(f.users_collection):
                        if u != coll: u.objects.unlink(f)
                    f['arc_outline'] = 0.006 if f in feats else 0.0
    for pat in bp['patterns']:
        part_id, mw, target = placed[pat['on']]
        for s in build_pattern(bp, pat, target, coll):
            for u in list(s.users_collection):
                if u != coll: u.objects.unlink(s)
            if s.name not in coll.objects: coll.objects.link(s)
            s.parent = root; s.matrix_basis = mw.copy(); s['arc_outline'] = 0.008
    for o in root.children:
        if o.type == 'MESH' and o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
    return root


def creature_height(root):
    zs = [(o.matrix_basis @ v.co).z for o in root.children if o.type == 'MESH' for v in o.data.vertices]
    return max(zs) - min(zs)

# ---------------------------------------------------------------- sheet, review, cards


def _creature_coll():
    sc = bpy.data.scenes['ARC_Review']
    C = bpy.data.collections.get(CREATURE_COLL) or bpy.data.collections.new(CREATURE_COLL)
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in list(C.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)
    return C


def rules_from_pack(path):
    return json.load(open(path))['creatures']


def sheet_creatures(pack=None, per_family=3):
    """Each family as a little group: one hostile at roster height and two friendly variants, plus the boss."""
    rules = rules_from_pack(pack or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json'))
    C = _creature_coll()
    roster = {r['family']: r for r in rules['roster'] if not r.get('rank')}
    fams = list(rules['families'])
    f = Vector((-0.6, 0.8, 0.0)); right = Vector((0.8, 0.6, 0.0))
    info = {}
    for i, fam in enumerate(fams):
        col, row = i % 3, i // 3
        centre = LINEUP + right * (col - 1) * 4.6 + f * (row * 3.4 - 1.2)
        H = roster[fam]['height']
        for j in range(per_family):
            role = 'hostile' if j == 0 else 'friendly'
            bp = generate_creature(rules, fam, f'sheet|{j}', role)
            root = assemble(bp, f'CR_{fam}_{j}', C)
            h = creature_height(root)
            k = (H if j == 0 else H * (0.55 + 0.12 * j)) / max(h, 1e-6)
            root.scale = (k, k, k)
            root.location = centre + right * (j - 1) * 1.35 + Vector((0, 0, bp['hover'] * k * 0.8))
            root.rotation_euler = (0, 0, FACE + (j - 1) * 0.25)
            info[f'{fam}/{j}'] = {'parts': [p['part'] for p in bp['parts']], 'face': bp['face']['expression']}
    boss = next(r for r in rules['roster'] if r.get('rank') == 'boss')
    bp = generate_creature(rules, boss['family'], 'sheet|boss', 'hostile', 'boss')
    root = assemble(bp, 'CR_boss', C); k = boss['height'] / creature_height(root)
    root.scale = (k, k, k); root.location = LINEUP + right * 7.2 + f * 2.4; root.rotation_euler = (0, 0, FACE - 0.2)
    return info


def review_creatures(path=SHEET_REVIEW, res=(1200, 700), samples=16):
    sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    cam = bpy.data.objects.get('ARC_CreatureCam') or bpy.data.objects.new('ARC_CreatureCam', bpy.data.cameras.new('ARC_CreatureCam'))
    back = bpy.data.collections['ARC_ReviewSet']
    if cam.name not in back.objects: back.objects.link(cam)
    t = LINEUP + Vector((0.8, 0.6, 0)) * 1.2 + Vector((-0.6, 0.8, 0)) * 1.4 + Vector((0, 0, 0.7))
    d = Vector((0.6, -0.8, 0.46)).normalized()
    cam.location = t + d * 15.0; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 35; cam.data.shift_y = 0.04; cam.data.clip_start = 0.1; cam.data.clip_end = 1000
    sc.camera = cam
    try: return render_review(path, res, samples, hide=('ARC_Gameplay', 'ARC_Weapons', 'ARC_Critters'))
    finally: sc.camera = keep


def cards_creatures(pack=None, out=OUT + '/arcade/catalog'):
    """Catalog cards for every roster entry, from a generated representative (key 'card')."""
    rules = rules_from_pack(pack or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json'))
    C = _creature_coll(); cards = {}
    for i, r in enumerate(rules['roster']):
        bp = generate_creature(rules, r['family'], 'card', 'hostile', r.get('rank', 'minion'))
        root = assemble(bp, f'CARD_{r["id"]}', C); root.location = LINEUP + Vector((40 + i * 6, 0, 0)); root.rotation_euler = (0, 0, FACE)
        names = [o.name for o in root.children if o.type == 'MESH']
        _flatten(root)
        cards[r['id']] = (names, True)
    try: return thumbnails(out=out, thumbs=cards)
    finally: _creature_coll()


def _flatten(root):
    """Bake the root's transform into its children and drop the parent (thumbnail scenes copy objects alone)."""
    R = Matrix.LocRotScale(root.location, root.rotation_euler.to_quaternion(), root.scale)
    for o in list(root.children):
        mw = R @ o.matrix_basis
        o.parent = None; o.matrix_world = mw
