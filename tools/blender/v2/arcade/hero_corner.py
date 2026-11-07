"""Arcade hero corner: the look-dev scene (look-dev sheet panel 5, mood board panel 1).

A chunky cottage, fences, barrel, trees, bushes, rocks and a painted lawn with a path, built from
kit.py's palette and toon materials and nature.py's foliage. Loader (Claude Bridge execute_code):
    T = '<repo>/tools/blender/v2'
    g = bpy.app.driver_namespace.setdefault('vg', {})
    for f in ('vg.py', 'arcade/kit.py', 'arcade/nature.py', 'arcade/hero_corner.py'): exec(open(f'{T}/{f}').read(), g)
    g['build']()      scene, lighting, camera            g['review']()   one light EEVEE render
    g['ship']()       GLBs + .blend in assets/v2/arcade/
Metres, Z up. The cottage's window gable faces -Y and its door +X; the camera looks in from +X/-Y.
"""
import bpy, math, random
from mathutils import Vector

HX, HY = 2.0, 2.5                 # cottage wall half-extents
Z_WALL, Z_TOP = 0.48, 2.8         # plaster runs from the plinth to the top plate
Z_PLATE = Z_TOP + 0.26            # top of the plate beams: the gables start here
RISE = 2.3
ZR = Z_PLATE + RISE               # ridge (top of the roof slab)
K = RISE / HX                     # roof slope, rise per metre
EAVE, GABLE_OVER, SLAB = HX + 0.6, 0.45, 0.22
DOOR_Y = -0.9                     # door centre along the +X wall
FENCE_SPAN = 2.2

GROUND_AT = (1.6, -1.6)
TREE_AT = (4.9, 3.4)
BARREL_AT = (3.2, 0.25)
ROCKS_AT = (1.4, -7.4)
PATH = [(2.55, -0.9), (3.55, -1.55), (4.25, -2.9), (4.35, -4.5), (5.0, -6.1), (6.2, -7.5), (7.1, -9.2)]
CAM = dict(target=(1.9, -1.5, 1.3), direction=(0.6, -0.8, 0.3), dist=20.0, lens=35, shift_y=0.11)

REVIEW = OUT + '/arcade/arcade-lookdev-review.png'

# ---------------------------------------------------------------- cottage

def _stone_row(a0, a1, fixed, axis, n, rnd):
    cuts = [a0 + (a1 - a0) * k / n for k in range(n + 1)]
    cuts = [cuts[0]] + [c + rnd.uniform(-0.12, 0.12) for c in cuts[1:-1]] + [cuts[-1]]
    spec = []
    for k in range(n):
        l = cuts[k + 1] - cuts[k] - 0.05; c = (cuts[k] + cuts[k + 1]) / 2
        h = 0.5 + rnd.uniform(-0.03, 0.06); d = 0.46 + rnd.uniform(-0.03, 0.03)
        spec.append(((l, d, h), (c, fixed, h / 2)) if axis == 'X' else ((d, l, h), (fixed, c, h / 2)))
    return spec

def _to_wall(objs, face, u0):
    """Move features built on a -Y facing wall at the origin (centred on u=0) onto a cottage face."""
    rot = {'-Y': 0.0, '+X': math.pi / 2, '+Y': math.pi, '-X': -math.pi / 2}[face]
    off = {'-Y': (u0, -HY, 0), '+X': (HX, u0, 0), '+Y': (u0, HY, 0), '-X': (-HX, u0, 0)}[face]
    for o in objs: xform(o, rot=[('Z', rot)], loc=off)
    return objs

def door(M):
    fr = prism('ARC_Door_Frame', arch_pts(1.36, 2.08, 0.0, Z_WALL - 0.02), -0.13, 0.1, axis='Y', mat=M['WoodDark'])
    cut(fr, prism('cut', arch_pts(1.0, 2.19, 0.0, Z_WALL - 0.3), -0.4, 0.4, axis='Y'))
    chunky(fr, 0.035)
    panel = chunky(prism('ARC_Door', arch_pts(1.02, 1.92, 0.0, Z_WALL - 0.02), -0.05, 0.05, axis='Y', mat=M['Wood']), 0.03)
    planks = boxes('ARC_Door_Planks', [((0.035, 0.04, 1.45), (x, -0.06, Z_WALL + 0.78)) for x in (-0.18, 0.18)], M['WoodDark'])
    ring = torus('ARC_Door_Knocker', 0.09, 0.022, (0.26, -0.09, Z_WALL + 0.95), M['ButterYellow'])
    return [fr, panel, planks, ring]

def window(M, name, z0=1.15):
    fr = prism(name + '_Frame', arch_pts(1.24, 1.5, 0.0, z0), -0.12, 0.1, axis='Y', mat=M['Wood'])
    cut(fr, prism('cut', arch_pts(0.88, 1.14, 0.0, z0 + 0.18), -0.4, 0.4, axis='Y'))
    chunky(fr, 0.035)
    glass = prism(name + '_Glass', arch_pts(0.9, 1.15, 0.0, z0 + 0.17), -0.03, 0.05, axis='Y', mat=M['Glass'])
    smooth(glass, 30, weighted=False)
    bars = boxes(name + '_Bars', [((0.07, 0.05, 1.12), (0, -0.05, z0 + 0.74)), ((0.88, 0.05, 0.07), (0, -0.05, z0 + 0.62))], M['WoodDark'])
    sill = rbox(name + '_Sill', (1.5, 0.34, 0.14), (0, -0.1, z0 - 0.02), M['Wood'], 0.04)
    return [fr, glass, bars, sill]

def lantern(M, z=1.68):           # hangs clear of the eave, which drops to ~2.3 m this far out
    arm = rbox('ARC_Lantern_Arm', (0.08, 0.5, 0.08), (0, -0.25, z + 0.5), M['Iron'], 0.015)
    body = rbox('ARC_Lantern_Glow', (0.3, 0.3, 0.4), (0, -0.5, z), M['Glow'], 0.03)
    cap = lathe('ARC_Lantern_Cap', [(0.28, z + 0.19), (0.0, z + 0.48)], axis='Z', segs=4, mat=M['Iron'])
    xform(cap, rot=[('Z', math.pi / 4)], loc=(0, -0.5, 0))
    base = rbox('ARC_Lantern_Base', (0.36, 0.36, 0.07), (0, -0.5, z - 0.235), M['Iron'], 0.015)
    return [arm, body, cap, base]

def roof_tiles(M):
    """Three staggered rows of pillow tiles per slope, each tilted a little shallower than the roof so
    its lower edge lifts: the stepped, chunky tile silhouette."""
    al = math.atan(K); th = al - 0.1; ca, sa = math.cos(al), math.sin(al)
    full, half = 1.44, 0.66
    rows = [(0.1, [(-2.25, full), (-0.75, full), (0.75, full), (2.25, full)]),
            (1.25, [(-2.64, half), (-1.5, full), (0.0, full), (1.5, full), (2.64, half)]),
            (2.4, [(-2.25, full), (-0.75, full), (0.75, full), (2.25, full)])]
    L = 1.55; rnd = random.Random(11); bm = bmesh.new()
    for d, row in rows:
        for yc, w in row:
            g = bmesh.ops.create_cube(bm, size=1.0)['verts']
            t = 0.26 * rnd.uniform(0.92, 1.08)
            bmesh.ops.scale(bm, vec=(L, w, t), verts=g)
            bmesh.ops.translate(bm, vec=(L / 2, 0, t / 2), verts=g)
            R = Matrix.Rotation(th + rnd.uniform(-0.02, 0.02), 3, 'Y') @ Matrix.Rotation(rnd.uniform(-0.03, 0.03), 3, 'Z')
            bmesh.ops.rotate(bm, verts=g, cent=(0, 0, 0), matrix=R)
            bmesh.ops.translate(bm, vec=(d * ca, yc, ZR - d * sa), verts=g)
    ob = new_obj('ARC_Roof_Tiles', bm, M['Roof'])
    mirror_x(ob)
    return chunky(ob, 0.08)

def chimney(M, cx=0.75, cy=1.1):
    rnd = random.Random(5); spec = []
    z = ZR - (cx + 0.55) * K - 0.1
    spec.append(((1.0, 1.0, 4.75 - z), (cx, cy, (z + 4.75) / 2)))       # core, mostly under the tiles
    z = 4.75
    for r in range(3):
        h = 0.44
        halves = ([((0.52, 1.08), (cx - 0.27, cy)), ((0.52, 1.08), (cx + 0.27, cy))] if r % 2 == 0 else
                  [((1.08, 0.52), (cx, cy - 0.27)), ((1.08, 0.52), (cx, cy + 0.27))])
        for (sx, sy), (px, py) in halves:
            spec.append(((sx * rnd.uniform(0.97, 1.03), sy * rnd.uniform(0.97, 1.03), h - 0.03), (px + rnd.uniform(-0.02, 0.02), py, z + h / 2)))
        z += h
    spec.append(((1.3, 1.3, 0.3), (cx, cy, z + 0.15)))
    stack = chunky(boxes('ARC_Chimney', spec, M['Stone']), 0.06)
    flue = box('ARC_Chimney_Flue', (0.62, 0.62, 0.05), (cx, cy, z + 0.31), M['StoneDark'])
    return [stack, flue]

def cottage(M):
    C = coll('ARC_Cottage'); rnd = random.Random(7); obs = []
    def add(ob, w=0.04):
        put(ob, C); ob['arc_outline'] = w; obs.append(ob); return ob
    blocks = []
    for s in (-1, 1):
        blocks += _stone_row(-(HX + 0.26), HX + 0.26, s * (HY + 0.03), 'X', 3, rnd)
        blocks += _stone_row(-(HY - 0.2), HY - 0.2, s * (HX + 0.03), 'Y', 4, rnd)
    add(chunky(boxes('ARC_Cottage_Plinth', blocks, M['Stone']), 0.08))
    add(chunky(box('ARC_Cottage_Walls', (2 * HX, 2 * HY, Z_TOP - Z_WALL + 0.02), (0, 0, (Z_TOP + Z_WALL) / 2), M['Plaster']), 0.03), 0.025)
    add(chunky(prism('ARC_Cottage_Gables', [(-HX + 0.02, Z_PLATE - 0.02), (HX - 0.02, Z_PLATE - 0.02), (0, ZR - 0.15)], -HY, HY, axis='Y', mat=M['Plaster']), 0.03), 0.025)
    beams = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            beams.append(((0.3, 0.3, Z_TOP - Z_WALL + 0.05), (sx * HX, sy * HY, (Z_TOP + Z_WALL) / 2)))
        beams.append(((0.24, 0.22, Z_TOP - Z_WALL), (sx * (HX + 0.02), 0.95, (Z_TOP + Z_WALL) / 2)))
        beams.append(((0.3, 2 * HY + 0.36, 0.28), (sx * (HX + 0.04), 0, Z_TOP + 0.13)))
    for sy in (-1, 1):
        beams.append(((2 * HX + 0.36, 0.3, 0.28), (0, sy * (HY + 0.04), Z_TOP + 0.13)))
    add(chunky(boxes('ARC_Cottage_Beams', beams, M['Wood']), 0.05))
    tim = []
    for sy in (-1, 1):
        y = sy * (HY + 0.05)
        tim.append(box('kp', (0.24, 0.14, ZR - 0.5 - Z_PLATE), (0, y, (Z_PLATE + ZR - 0.5) / 2), M['WoodDark']))
        yb = sy * (HY + GABLE_OVER - 0.12); zb = ZR - SLAB - 0.13
        for sx in (-1, 1):
            tim.append(strut('br', (sx * 1.55, y, Z_PLATE + 0.02), (sx * 0.14, y, Z_PLATE + 1.35), 0.2, 0.13, M['WoodDark']))
            tim.append(strut('bb', (0, yb, zb), (sx * (EAVE - 0.05), yb, zb - (EAVE - 0.05) * K), 0.26, 0.16, M['Wood']))
    add(chunky(merge('ARC_Cottage_Timbers', tim), 0.04), 0.035)
    ez = ZR - EAVE * K
    add(chunky(prism('ARC_Roof_Slab', [(-EAVE, ez - SLAB), (-EAVE, ez), (0, ZR), (EAVE, ez), (EAVE, ez - SLAB), (0, ZR - SLAB)],
                     -(HY + GABLE_OVER), HY + GABLE_OVER, axis='Y', mat=M['Roof']), 0.04))
    add(roof_tiles(M), 0.045)
    caps = [lathe(f'cap{i}', [(0.2, -0.66), (0.31, -0.52), (0.31, 0.52), (0.2, 0.66)], axis='Y', segs=8, mat=M['Roof'],
                  center=(0, yc, ZR + 0.12)) for i, yc in enumerate((-2.2, -0.74, 0.74, 2.2))]
    add(smooth(merge('ARC_Roof_Ridge', caps), 50, weighted=False), 0.045)
    stack, flue = chimney(M)
    add(stack, 0.04); add(flue, 0.0)
    for o in _to_wall(door(M), '+X', DOOR_Y): add(o, 0.03 if o.name in ('ARC_Door_Frame', 'ARC_Door') else 0.0)
    for o in _to_wall(window(M, 'ARC_Window_Front'), '-Y', -0.1): add(o, 0.03 if o.name.endswith(('Frame', 'Sill')) else 0.0)
    for o in _to_wall(window(M, 'ARC_Window_Side'), '-X', -0.8): add(o, 0.03 if o.name.endswith(('Frame', 'Sill')) else 0.0)
    for o in _to_wall(lantern(M), '+X', -1.97): add(o, 0.02 if o.name == 'ARC_Lantern_Glow' else 0.0)
    add(rbox('ARC_Door_Step', (0.62, 1.5, 0.26), (HX + 0.52, DOOR_Y, 0.13), M['Stone'], 0.06))
    # baked gradients: each part darkens toward its own base, so every piece reads grounded
    for o in obs:
        if o.name in ('ARC_Lantern_Glow',): continue
        warm = o.name.startswith(('ARC_Roof', 'ARC_Chimney'))
        vgrad([o], (0.8, 0.76, 0.86) if warm else (0.78, 0.76, 0.86), power=0.8)
    return obs

# ---------------------------------------------------------------- props

def fence_post(M, name):
    bm = bmesh.new(); g = bmesh.ops.create_cube(bm, size=1.0)['verts']
    bmesh.ops.scale(bm, vec=(0.26, 0.26, 1.3), verts=g); bmesh.ops.translate(bm, vec=(0, 0, 0.65), verts=g)
    for v in bm.verts:
        if v.co.z > 1.0 and v.co.y > 0: v.co.z += 0.12      # slanted top
    return chunky(new_obj(name, bm, M['Wood']), 0.05)

def fence_modules(M):
    """ARC_Fence_Section: a post at the origin plus rails to the next post FENCE_SPAN along +X (rails on
    the -Y face). ARC_Fence_Post closes a run. Both carry local gradients so instances work anywhere."""
    post = fence_post(M, 'ARC_Fence_Section')
    rails = chunky(boxes('rails', [((FENCE_SPAN + 0.12, 0.1, 0.2), (FENCE_SPAN / 2, -0.18, 0.48), ('Y', 0.025)),
                                   ((FENCE_SPAN + 0.12, 0.1, 0.2), (FENCE_SPAN / 2, -0.18, 0.98), ('Y', -0.02))], M['Wood']), 0.035)
    sec = merge('ARC_Fence_Section', [post, rails])
    end = fence_post(M, 'ARC_Fence_Post')
    vgrad([sec, end], (0.74, 0.7, 0.8), lo=0.0, hi=1.45, local=True)
    for o in (sec, end): o['arc_outline'] = 0.03
    return sec, end

def fence_run(sec, end, C, start, heading, n, turn=0.0, originals=False):
    """Linked instances along a gently bending line; originals=True places the module objects themselves."""
    p = Vector((start[0], start[1], 0.0)); a = heading; placed = []
    for i in range(n):
        o = sec if (i == 0 and originals) else sec.copy()
        put(o, C); o.location = p; o.rotation_euler = (0, 0, a + random.Random(i).uniform(-0.03, 0.03))
        placed.append(o)
        p = p + Vector((math.cos(a), math.sin(a), 0)) * FENCE_SPAN; a += turn
    e = end if originals else end.copy()
    put(e, C); e.location = p; e.rotation_euler = (0, 0, a - turn)
    return placed + [e]

def barrel(M):
    body = lathe('body', [(0.0, 0.0), (0.37, 0.0), (0.42, 0.2), (0.45, 0.5), (0.42, 0.8), (0.37, 1.0), (0.32, 1.0), (0.0, 0.96)],
                 axis='Z', segs=12, mat=M['Wood'], cap=False)
    smooth(body, 20, weighted=False)      # sharp between staves, soft around the bulge
    bands = [lathe(f'band{i}', [(r - 0.01, z), (r + 0.028, z + 0.01), (r + 0.028, z + 0.11), (r - 0.01, z + 0.12), (r - 0.01, z)],
                   axis='Z', segs=12, mat=M['Iron'], cap=False) for i, (r, z) in enumerate(((0.425, 0.14), (0.425, 0.74)))]
    for b in bands: smooth(b, 20, weighted=False)
    ob = merge('ARC_Barrel', [body] + bands)
    vgrad([ob], (0.72, 0.68, 0.8), lo=0.0, hi=1.0, local=True)
    ob['arc_outline'] = 0.03
    return ob

# ---------------------------------------------------------------- nature

EXTRA_TREES = [('pine', (-6.4, 4.4), 1.1, 5), ('sapling', (-5.2, -1.0), 1.0, 6), ('sapling', (8.6, 0.0), 0.9, 7), ('pine', (9.6, 9.4), 0.95, 8)]
BUSHES = [(2.45, -2.5, 0.55, 'CoralPink'), (-2.55, -3.0, 0.62, None), (4.25, -0.35, 0.5, 'ButterYellow'), (-2.5, 1.6, 0.55, None),
          (-3.3, -5.2, 0.5, None), (-3.0, -7.6, 0.58, 'Lilac'), (6.9, 3.6, 0.6, None), (9.6, 5.8, 0.55, 'CoralPink')]
FLOWER_CLUSTERS = [(3.0, -3.3, 4, 0.7), (5.4, -3.2, 5, 0.9), (1.7, -5.2, 5, 0.9), (3.4, -6.6, 4, 0.8), (6.5, -5.4, 4, 0.8),
                   (-0.4, -4.4, 5, 1.0), (5.8, -1.4, 3, 0.6), (0.2, -8.6, 4, 0.8), (7.8, -3.0, 4, 0.9), (-1.6, -6.6, 4, 0.8),
                   (6.3, 1.9, 4, 0.8), (-3.4, -1.0, 4, 0.8), (8.8, -7.0, 4, 0.9), (-4.2, 2.6, 4, 0.9)]

def rocks(M, C):
    spec = [('ARC_Rock_A', (1.5, 1.15, 0.95), (0.0, 0.0), 0.5), ('ARC_Rock_B', (0.95, 0.8, 0.62), (1.05, -0.55), 1.3),
            ('ARC_Rock_C', (0.7, 0.62, 0.45), (-0.55, -0.8), 2.2)]
    out = []
    for i, (name, size, (dx, dy), yaw) in enumerate(spec):
        r = rock(name, size, M['Stone'], seed=20 + i, yaw=yaw)
        vgrad([r], (0.72, 0.7, 0.84), lo=0.0, hi=size[2], local=True)
        r.location = (ROCKS_AT[0] + dx, ROCKS_AT[1] + dy, 0.0); r['arc_outline'] = 0.04
        out.append(put(r, C))
    return out

def _catmull(pts, steps=4):
    P = [Vector((x, y, 0.0)) for x, y in pts]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for s in range(steps):
            t = s / steps
            out.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    return out + [P[-2]]

def _blocked(x, y, S, clear=0.95):
    """True where dressing must not grow: the cottage, rocks, trunks, barrel and the path."""
    if abs(x) < HX + 0.55 and abs(y) < HY + 0.55: return True
    for (px, py), rad in ((ROCKS_AT, 1.3), (TREE_AT, 0.95), (BARREL_AT, 0.6), ((HX + 0.55, DOOR_Y), 0.9)):
        if math.hypot(x - px, y - py) < rad: return True
    for kind, (px, py), s, _ in EXTRA_TREES:
        if math.hypot(x - px, y - py) < 0.6 * s: return True
    return min((Vector((x, y, 0.0)) - p).length for p in S) < clear

def path(M, width=1.45, seed=2):
    rnd = random.Random(seed); S = _catmull(PATH)
    bm = bmesh.new(); rows = []; cols = []
    for i, c in enumerate(S):
        d = (S[min(i + 1, len(S) - 1)] - S[max(i - 1, 0)]).normalized(); n = Vector((-d.y, d.x, 0.0))
        w = width * (0.85 + 0.3 * mnoise.noise(c * 0.6)) / 2
        rows.append([bm.verts.new(c + n * w * rnd.uniform(0.9, 1.1) + Vector((0, 0, 0.012))), bm.verts.new(c + Vector((0, 0, 0.02))),
                     bm.verts.new(c - n * w * rnd.uniform(0.9, 1.1) + Vector((0, 0, 0.012)))])
        cols += [(0.8, 0.74, 0.78), (1.0, 1.0, 1.0), (0.8, 0.74, 0.78)]
    for a, b in zip(rows, rows[1:]):
        bm.faces.new((a[0], a[1], b[1], b[0])); bm.faces.new((a[1], a[2], b[2], b[1]))
    bm.normal_update(); bm.faces.ensure_lookup_table()
    if bm.faces[0].normal.z < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for l in f.loops: l[uv].uv = (l.vert.co.x / 2.0, l.vert.co.y / 2.0)
    ob = new_obj('ARC_Path', bm, M['Sand']); ob.data.shade_smooth()
    order = iter(cols)
    paint([ob], lambda w, l: next(order))
    stones = []
    rs = random.Random(seed + 1)
    for j, i in enumerate((3, 6, 9, 12, 15, 18, 21)):
        if i >= len(S) - 1: break
        d = (S[i + 1] - S[i - 1]).normalized(); n = Vector((-d.y, d.x, 0.0))
        p = S[i] + n * rs.uniform(-0.3, 0.3)
        s = lathe(f'st{j}', [(0.0, 0.1), (0.3, 0.09), (0.42, 0.05), (0.42, -0.02)], axis='Z', segs=7, mat=M['Stone'])
        xform(s, scale=(rs.uniform(0.9, 1.25), rs.uniform(0.7, 0.95), 1.0), rot=[('Z', rs.uniform(0, math.pi))], loc=(p.x, p.y, 0.0))
        stones.append(s)
    st = merge('ARC_SteppingStones', stones); smooth(st, 40, weighted=False)
    vgrad([st], (0.8, 0.78, 0.88), lo=-0.02, hi=0.1)
    st['arc_outline'] = 0.02
    return ob, st

def _copy(src):
    c = src.copy(); c.data = src.data.copy(); bpy.context.scene.collection.objects.link(c)
    return c

def daisy(M, petal, name='daisy'):
    pts = [((0.15 if k % 2 == 0 else 0.075) * math.cos(k * math.pi / 6), (0.15 if k % 2 == 0 else 0.075) * math.sin(k * math.pi / 6)) for k in range(12)]
    f = merge(name, [prism('p', pts, 0.0, 0.03, axis='Z', mat=petal), cyl('e', 0.055, 0.02, 0.06, axis='Z', segs=6, mat=M['ButterYellow'] if petal is not M['ButterYellow'] else M['CoralPink']),
                     cyl('s', 0.016, -0.3, 0.0, axis='Z', segs=3, mat=M['Leaf'])])
    smooth(f, 40, weighted=False)
    xform(f, rot=[('X', 0.3)], loc=(0, 0, 0.3))
    stem = ramp(GRASS, 0.3)
    paint([f], lambda w, l: stem if l.z < 0.22 else (1.0, 1.0, 1.0))
    return f

def flowers(M, S):
    kinds = [daisy(M, M['Petal']), daisy(M, M['CoralPink']), daisy(M, M['Lilac']), daisy(M, M['ButterYellow'])]
    rnd = random.Random(31)
    spots = cluster_spots(FLOWER_CLUSTERS, seed=5, avoid=lambda x, y: _blocked(x, y, S, 0.95))
    ob = scatter(lambda i: _copy(rnd.choices(kinds, weights=(0.55, 0.17, 0.14, 0.14))[0]), 'ARC_Flowers', spots, seed=6, scale=(0.8, 1.15))
    for k in kinds: bpy.data.objects.remove(k, do_unlink=True)
    return ob

def tufts(M, S, fences):
    srcs = [tuft('t0', M, 1), tuft('t1', M, 2, 5, 0.36), tuft('t2', M, 3, 7, 0.5)]
    centres = [(o.location.x, o.location.y, 3, 0.4) for o in fences]
    centres += [(sx * (HX + 0.75), y, 2, 0.35) for sx in (-1, 1) for y in (-2.6, -1.4, 0.4, 1.8)]
    centres += [(x, sy * (HY + 0.75), 2, 0.35) for sy in (-1, 1) for x in (-1.8, -0.3, 1.4)]
    centres += [(ROCKS_AT[0], ROCKS_AT[1], 7, 1.9), (TREE_AT[0], TREE_AT[1], 6, 1.5), (BARREL_AT[0], BARREL_AT[1], 3, 0.9)]
    centres += [(p.x, p.y, 2, 1.25) for p in S[::3]]
    rnd = random.Random(12)
    centres += [(GROUND_AT[0] + rnd.uniform(-7, 7), GROUND_AT[1] + rnd.uniform(-7, 7), 2, 0.5) for _ in range(26)]
    spots = cluster_spots(centres, seed=8, avoid=lambda x, y: _blocked(x, y, S, 0.82) or math.hypot(x - GROUND_AT[0], y - GROUND_AT[1]) > 8.2)
    ob = scatter(lambda i: _copy(srcs[i % 3]), 'ARC_GrassTufts', spots, seed=9, scale=(0.75, 1.25))
    for s in srcs: bpy.data.objects.remove(s, do_unlink=True)
    return ob

def pebbles(M, S):
    rnd = random.Random(41); spots = []
    for i, p in enumerate(S[1::2]):
        j = min(2 * i + 2, len(S) - 1)
        d = (S[j] - S[max(j - 2, 0)]).normalized(); n = Vector((-d.y, d.x, 0.0))
        for side in (-1, 1):
            if rnd.random() < 0.55:
                q = p + n * side * rnd.uniform(0.75, 1.0)
                spots.append((q.x, q.y))
    spots += [(ROCKS_AT[0] + rnd.uniform(-2, 2), ROCKS_AT[1] + rnd.uniform(-1.8, 1.8)) for _ in range(8)]
    spots = [s for s in spots if math.hypot(s[0] - ROCKS_AT[0], s[1] - ROCKS_AT[1]) > 1.2]
    ob = scatter(lambda i: pebble(f'pb{i}', M, (rnd.uniform(0.09, 0.16), rnd.uniform(0.07, 0.12), rnd.uniform(0.05, 0.08)), seed=i), 'ARC_Pebbles', spots, seed=42, scale=(0.8, 1.3))
    vgrad([ob], (0.78, 0.76, 0.86), lo=0.0, hi=0.12); ob['arc_outline'] = 0.012
    return ob

# ---------------------------------------------------------------- look-dev set

def cloud(M, name, loc, r, seed):
    rnd = random.Random(seed); parts = []
    for i in range(5):
        c = (0.0, 0.0, 0.2 * r) if i == 0 else (rnd.uniform(-1.3, 1.3) * r, rnd.uniform(-0.3, 0.3) * r, rnd.uniform(0.0, 0.3) * r)
        parts.append(blob(f'{name}{i}', c, r * (1.1 if i == 0 else rnd.uniform(0.55, 0.85)), M['Cloud'], subd=3, scale=(1, 0.8, 0.7), jitter=0.05, seed=seed * 7 + i))
    ob = merge(name, parts)
    vgrad([ob], (0.84, 0.86, 0.97), local=True)
    ob.location = loc; ob.rotation_euler = (0, 0, math.atan2(0.6, 0.8))
    return ob

def lookdev_set(M, C):
    """Backdrop only (never exported): meadow to the horizon, rolling hills, tree groves, clouds, swatches."""
    md = put(meadow('ARC_LookDev_Meadow', M), C)
    f, r, c0 = Vector((-0.6, 0.8, 0.0)), Vector((0.8, 0.6, 0.0)), Vector((1.8, -1.5, 0.0))
    hills = []
    for i, (d, l, R, h) in enumerate(((78, -48, 42, 7), (98, 8, 58, 10), (82, 58, 40, 6.5), (118, -18, 65, 13), (66, 30, 28, 4.0))):
        p = c0 + f * d + r * l
        hills.append(put(hill(f'ARC_LookDev_Hill{i}', M, (p.x, p.y, -0.3), R, h), C))
    src = [oak('ARC_LookDev_OakA', M, seed=11), oak('ARC_LookDev_OakB', M, seed=12, s=0.85), pine('ARC_LookDev_Pine', M, seed=13),
           sapling('ARC_LookDev_Sapling', M, seed=14)]
    rnd = random.Random(23); trunks = []
    for d, l, n, rad in ((20, -16, 5, 4.5), (26, 6, 6, 5.0), (22, 20, 4, 4.0), (34, -6, 6, 6.0), (15, -24, 3, 3.0), (40, 26, 5, 6.0), (30, -30, 4, 5.0), (46, -2, 5, 6.0)):
        gc = c0 + f * d + r * l
        for _ in range(n):
            a = rnd.uniform(0, 2 * math.pi); dd = rad * math.sqrt(rnd.random())
            p = gc + Vector((math.cos(a) * dd, math.sin(a) * dd, 0.0))
            t = rnd.choices(src, weights=(0.35, 0.25, 0.3, 0.1))[0].copy(); put(t, C); t.name = 'ARC_LookDev_Grove'
            k = rnd.uniform(0.75, 1.25); t.location = p; t.scale = (k, k, k); t.rotation_euler = (0, 0, rnd.uniform(0, 6.28))
            trunks.append((p.x, p.y))
    for s in src: bpy.data.objects.remove(s, do_unlink=True)
    base = Vector((-64.0, 87.0, 0.0))
    for i, (k, z, rr) in enumerate(((-42, 13, 9), (4, 17, 11), (40, 12, 8), (-18, 22, 7))):
        put(cloud(M, f'ARC_LookDev_Cloud{i}', base + r * k + Vector((0, 0, z)), rr, 30 + i), C)
    tone = {'Grass': ramp(GRASS, 0.6), 'Leaf': ramp(LEAF, 0.6), 'Bark': ramp(BARK, 0.6)}
    for i, n in enumerate(('CoralPink', 'ButterYellow', 'Mint', 'SkyBlue', 'Lilac', 'Roof', 'Wood', 'Stone', 'Grass', 'Sand', 'Leaf', 'Glass')):
        b = blob(f'ARC_Swatch_{n}', (0, 0, 0), 0.45, M[n], subd=4, jitter=0.0)
        if n in tone: _set_col(b, [tone[n]] * len(b.data.vertices))
        b.location = (-7 + i * 1.25, -26.0, 0.5); b['arc_outline'] = 0.03; put(b, C)
    return md, hills, trunks

# ---------------------------------------------------------------- scene

def _mats():
    return {m.name[4:]: m for m in bpy.data.materials if m.name.startswith('ARC_')}

def build():
    reset()
    M = materials(); set_look()
    C = {k: coll(k) for k in ('ARC_LookDev', 'ARC_Cottage', 'ARC_Props', 'ARC_Nature', 'ARC_Lighting')}
    P, N = C['ARC_Props'], C['ARC_Nature']
    cottage(M)
    sec, end = fence_modules(M)
    fences = fence_run(sec, end, P, (-1.8, -9.8), math.radians(100), 3, turn=math.radians(4), originals=True)
    fences += fence_run(sec, end, P, (3.9, 1.0), math.radians(37), 3, turn=math.radians(-3))
    b = put(barrel(M), P); b.location = (*BARREL_AT, 0.0); b.rotation_euler = (0, 0, 0.3)
    S = _catmull(PATH, 8)
    t = put(oak('ARC_Tree', M, seed=4), N); t.location = (*TREE_AT, 0.0)
    for i, (kind, (x, y), s, seed) in enumerate(EXTRA_TREES):
        o = put((pine if kind == 'pine' else sapling)(f'ARC_{kind.title()}_{"ABCD"[i]}', M, seed=seed, s=s), N)
        o.location = (x, y, 0.0); o.rotation_euler = (0, 0, seed * 1.3)
    rocks(M, N)
    pa, st = path(M); put(pa, N); put(st, N)
    for i, (x, y, r, fl) in enumerate(BUSHES):
        bb = put(bush(f'ARC_Bush_{"ABCDEFGH"[i]}', M, r, seed=40 + i, flowers=(M[fl], 6) if fl else None), N)
        bb.location = (x, y, 0.0); bb.rotation_euler = (0, 0, i * 0.9)
    put(flowers(M, S), N); put(tufts(M, S, fences), N); put(pebbles(M, S), N)
    g = put(grass_tile('ARC_Ground', M, 8.5, 0.45, center=GROUND_AT), N)
    md, hills, trunks = lookdev_set(M, C['ARC_LookDev'])
    touching = list(C['ARC_Cottage'].objects) + list(P.objects) + [o for o in N.objects if o.name.startswith(('ARC_Tree', 'ARC_Pine', 'ARC_Sapling', 'ARC_Rock', 'ARC_Bush'))]
    paint_ground([g, md] + hills, contact_points(touching, below=0.3) + trunks, worn=[(p.x, p.y) for p in S])
    ensure_grad([o for o in bpy.data.objects if o.type == 'MESH'])
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
    sky(); sun(collection=C['ARC_Lighting'])
    camera(**CAM, collection=C['ARC_Lighting'])
    render_setup()
    return {k: tris(list(c.objects)) for k, c in C.items()}

def review(path=REVIEW, res=(1200, 700), samples=16):
    return render(path, res, samples)

THUMBS = {  # catalog id -> (source objects, keep world placement) for the studio's 256 px asset cards
    'barrel': (['ARC_Barrel'], False), 'rocks': (['ARC_Rock_A', 'ARC_Rock_B', 'ARC_Rock_C'], True),
    'fence': (['ARC_Fence_Section', 'ARC_Fence_Post'], False), 'cottage': ('ARC_Cottage', True),
    'oak': (['ARC_Tree'], False), 'pine': (['ARC_Pine_A'], False), 'sapling': (['ARC_Sapling_B'], False),
}

def thumbnails(out=OUT + '/arcade/catalog', res=256, samples=16, thumbs=None):
    """Toon-shaded catalog cards on the studio's dark-slate ground, one small EEVEE render each."""
    main = bpy.context.scene; win = bpy.context.window; made = []
    t = bpy.data.scenes.new('ARC_Thumbs'); t.render.engine = 'BLENDER_EEVEE'
    t.render.resolution_x = t.render.resolution_y = res; t.render.film_transparent = False
    t.eevee.taa_render_samples = samples; t.view_settings.view_transform = 'Standard'
    w = sky().copy(); w.name = 'ARC_ThumbWorld'
    for n in w.node_tree.nodes:
        if n.type == 'BACKGROUND' and n.inputs['Strength'].default_value == 1.0 and n.inputs['Color'].is_linked:
            w.node_tree.links.remove(n.inputs['Color'].links[0]); n.inputs['Color'].default_value = (0.016, 0.028, 0.04, 1)
    t.world = w
    L = bpy.data.objects['ARC_Sun'].copy(); t.collection.objects.link(L)
    cam = bpy.data.objects.new('ARC_ThumbCam', bpy.data.cameras.new('ARC_ThumbCam')); t.collection.objects.link(cam); t.camera = cam
    cam.data.type = 'ORTHO'
    try:
        for cid, (names, keep) in (thumbs or THUMBS).items():
            srcs = list(bpy.data.collections[names].objects) if isinstance(names, str) else [bpy.data.objects[n] for n in names]
            parts = []
            for i, s in enumerate(srcs):
                c = s.copy(); t.collection.objects.link(c); parts.append(c)
                if not keep: c.matrix_world = Matrix.Translation((FENCE_SPAN * i, 0, 0)) if cid == 'fence' else Matrix.Identity(4)
            if cid == 'rocks':
                for c in parts: c.location.x -= ROCKS_AT[0]; c.location.y -= ROCKS_AT[1]
            t.frame_set(1); bpy.context.view_layer.update()
            win.scene = t; bpy.context.view_layer.update()
            lo, hi = bounds(parts); c0 = (lo + hi) / 2; rad = (hi - lo).length / 2
            d = Vector((0.6, -0.8, 0.55)).normalized()
            cam.location = c0 + d * rad * 4; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
            cam.data.ortho_scale = rad * 2.15; cam.data.clip_end = rad * 10
            os.makedirs(out, exist_ok=True); t.render.filepath = f'{out}/{cid}.png'
            bpy.ops.render.render(write_still=True, scene=t.name); made.append(t.render.filepath)
            win.scene = main
            for c in parts: bpy.data.objects.remove(c, do_unlink=True)
    finally:
        win.scene = main
        for o in list(t.collection.objects): bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.scenes.remove(t); bpy.data.worlds.remove(w)
    return made

def ship(out=OUT + '/arcade'):
    """GLBs (palette x COLOR_0 [x painted texture], no outlines) + the source .blend."""
    bpy.data.orphans_purge(do_recursive=True)   # stale meshes would push .001 suffixes into GLB mesh names
    ob = bpy.data.objects; M = _mats(); res = {}
    res['cottage'] = export_nodes([('Cottage', list(coll('ARC_Cottage').objects), (0, 0, 0), (0, 0, 0), False)], f'{out}/arcade-cottage.glb')
    res['fence'] = export_nodes([('Fence_Section', [ob['ARC_Fence_Section']], None, (0, 0, 0), True),
                                 ('Fence_Post', [ob['ARC_Fence_Post']], None, (FENCE_SPAN, 0, 0), True)], f'{out}/arcade-fence.glb')
    res['barrel'] = export_nodes([('Barrel', [ob['ARC_Barrel']], None, (0, 0, 0), True)], f'{out}/arcade-barrel.glb')
    res['tree_oak'] = export_nodes([('Tree_Oak', [ob['ARC_Tree']], None, (0, 0, 0), True)], f'{out}/arcade-tree-oak.glb')
    res['tree_pine'] = export_nodes([('Tree_Pine', [ob['ARC_Pine_A']], None, (0, 0, 0), True)], f'{out}/arcade-tree-pine.glb')
    res['tree_sapling'] = export_nodes([('Tree_Sapling', [ob['ARC_Sapling_B']], None, (0, 0, 0), True)], f'{out}/arcade-tree-sapling.glb')
    res['rocks'] = export_nodes([(n[4:], [ob[n]], None, (ob[n].location.x - ROCKS_AT[0], ob[n].location.y - ROCKS_AT[1], 0), True)
                                 for n in ('ARC_Rock_A', 'ARC_Rock_B', 'ARC_Rock_C')], f'{out}/arcade-rocks.glb')
    res['ground'] = export_nodes([('Ground', [ob['ARC_Ground'], ob['ARC_Path'], ob['ARC_SteppingStones'], ob['ARC_Pebbles']], (*GROUND_AT, 0), (0, 0, 0), False)],
                                 f'{out}/arcade-ground.glb')
    kit_parts = [bush('src_Bush', M, 0.6, 1), bush('src_Bush_Flowering', M, 0.6, 2, (M['CoralPink'], 6)), tuft('src_Tuft_A', M, 1),
                 tuft('src_Tuft_B', M, 3, 7, 0.5), daisy(M, M['Petal'], 'src_Daisy_White'), daisy(M, M['CoralPink'], 'src_Daisy_Pink'),
                 pebble('src_Pebble', M, (0.14, 0.11, 0.07), 3)]
    ensure_grad(kit_parts)
    try:
        res['dressing'] = export_nodes([(o.name[4:], [o], None, (i * 1.6, 0, 0), True) for i, o in enumerate(kit_parts)], f'{out}/arcade-dressing.glb')
    finally:
        for o in kit_parts:
            me = o.data; bpy.data.objects.remove(o, do_unlink=True); bpy.data.meshes.remove(me)
    hero = [o for c in ('ARC_Cottage', 'ARC_Props', 'ARC_Nature') for o in coll(c).objects if o.type == 'MESH']
    res['hero'] = export_nodes([(o.name[4:], [o], (0, 0, 0), (0, 0, 0), False) for o in hero], f'{out}/arcade-hero-corner.glb')
    bpy.ops.wm.save_as_mainfile(filepath=f'{out}/arcade-lookdev.blend')
    return res
