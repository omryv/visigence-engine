"""Arcade nature parts library: the bushes, flower clusters, grass tufts, mushrooms, stump, stepping stone and
signpost the world layout (src/world/worldGrammar.js) scatters over the meadow and along the doorstep walks.

exec after vg.py, kit.py, nature.py and hero_corner.py (same globals):
    g['build_nature_parts']()   every part into the NAT_Parts collection (hidden; the preview copies from it)
    g['review_nature']()        one light review render of the parts in a row (assets/v2/arcade/arcade-nature-review.png)
    g['ship_nature_parts']()    assets/v2/arcade/arcade-nature-parts.glb + src/world/natureParts.js (the index)

Contract with the engine (render/NatureBatch.js) and the preview (world_preview.py):
  - One top-level glTF node per part, named by its id ('bush.round'; GLTFLoader keeps it in userData.name);
    extras: arc_outline (metres, world scale). Parts stand on their origin at game scale, +Y up in glTF.
  - Materials are the kit's ARC_ ones (Leaf, Petal, CoralPink, Lilac, ButterYellow, Stone, Wood, WoodDark, Bark,
    Plaster), authored as their sunlit tone times the 'Col' gradient (vertex colour), so the engine's toon pass
    swaps them for their toon twins like every other Arcade prop.
"""
import bpy, math, random, json
from mathutils import Vector, Matrix

PARTS_COLL_N = 'NAT_Parts'
PARTS_GLB_N = OUT + '/arcade/arcade-nature-parts.glb'
PARTS_INDEX_N = globals().get('REPO', ROOT) + '/src/world/natureParts.js'
NATURE_REVIEW = OUT + '/arcade/arcade-nature-review.png'
NPARTS, NPART_ORDER = {}, []


def npart(pid):
    def reg(fn):
        NPARTS[pid] = fn; NPART_ORDER.append(pid); return fn
    return reg


def _nm():
    return {m.name[4:]: m for m in bpy.data.materials if m.name.startswith('ARC_')}


def nfinish(pid, objs, outline=0.02, grad=None):
    objs = [o for o in objs if o is not None]
    if grad: vgrad(objs, grad, local=True)
    ensure_grad(objs)
    ob = merge(pid, objs) if len(objs) > 1 else objs[0]
    ob.name = pid; ob.data.name = pid; ob['arc_outline'] = outline
    return ob


def _cluster(pid, kinds, spots, rnd, outline):
    parts = []
    for i, (x, y) in enumerate(spots):
        src = kinds[i % len(kinds)]; c = src.copy(); c.data = src.data.copy(); bpy.context.scene.collection.objects.link(c)
        k = rnd.uniform(0.8, 1.15)
        xform(c, scale=(k, k, k), rot=[('Z', rnd.uniform(0, 2 * math.pi))], loc=(x, y, 0.0)); parts.append(c)
    for s in kinds: bpy.data.objects.remove(s, do_unlink=True)
    return nfinish(pid, parts, outline)


def _ring(n, r, rnd, jitter=0.35):
    return [(math.cos(2 * math.pi * i / n + rnd.uniform(-jitter, jitter)) * r * rnd.uniform(0.6, 1.0),
             math.sin(2 * math.pi * i / n + rnd.uniform(-jitter, jitter)) * r * rnd.uniform(0.6, 1.0)) for i in range(n)]

# ---------------------------------------------------------------- bushes and flowers

@npart('bush.round')
def _bush_round():
    M = _nm(); return nfinish('bush.round', [bush('bush.round', M, 0.7, seed=61)], 0.03)


@npart('bush.flowering')
def _bush_flowering():
    M = _nm(); return nfinish('bush.flowering', [bush('bush.flowering', M, 0.66, seed=62, flowers=(M['CoralPink'], 7))], 0.03)


@npart('flowers.daisy')
def _flowers_daisy():
    M = _nm(); rnd = random.Random(71)
    kinds = [daisy(M, M['Petal'], 'd0'), daisy(M, M['Petal'], 'd1')]
    return _cluster('flowers.daisy', kinds, [(0, 0)] + _ring(6, 0.55, rnd), rnd, 0.012)


@npart('flowers.mixed')
def _flowers_mixed():
    M = _nm(); rnd = random.Random(72)
    kinds = [daisy(M, M['CoralPink'], 'm0'), daisy(M, M['Lilac'], 'm1'), daisy(M, M['ButterYellow'], 'm2'), daisy(M, M['Petal'], 'm3')]
    return _cluster('flowers.mixed', kinds, [(0.05, -0.05)] + _ring(7, 0.6, rnd), rnd, 0.012)


@npart('tuft.a')
def _tuft_a():
    M = _nm(); return nfinish('tuft.a', [tuft('tuft.a', M, seed=1, blades=6, h=0.45)], 0.0)


@npart('tuft.b')
def _tuft_b():
    M = _nm(); return nfinish('tuft.b', [tuft('tuft.b', M, seed=3, blades=8, h=0.52)], 0.0)

# ---------------------------------------------------------------- forest floor

def _toadstool(name, M, s, rnd):
    stem = lathe(name + '_s', [(0.0, 0.0), (0.075, 0.0), (0.06, 0.2), (0.055, 0.34), (0.0, 0.35)], axis='Z', segs=10, mat=M['Plaster'])
    cap = lathe(name + '_c', [(0.0, 0.26), (0.1, 0.27), (0.17, 0.3), (0.19, 0.36), (0.14, 0.45), (0.06, 0.5), (0.0, 0.51)], axis='Z', segs=14, mat=M['CoralPink'])
    stem.data.shade_smooth(); cap.data.shade_smooth()
    spots = []
    for i in range(4):
        a = rnd.uniform(0, 2 * math.pi); el = rnd.uniform(0.25, 1.05)
        p = Vector((math.cos(a) * math.cos(el) * 0.165, math.sin(a) * math.cos(el) * 0.165, 0.36 + math.sin(el) * 0.14))
        spots.append(blob(name + '_p%d' % i, p, 0.032, M['Petal'], subd=1, scale=(1, 1, 0.55), jitter=0.0))
    vgrad([stem], (0.8, 0.76, 0.86), lo=0.0, hi=0.3); vgrad([cap], (0.82, 0.74, 0.86), lo=0.26, hi=0.5)
    ob = merge(name, [stem, cap] + spots)
    xform(ob, scale=(s, s, s), rot=[('X', rnd.uniform(-0.12, 0.12)), ('Z', rnd.uniform(0, 2 * math.pi))])
    return ob


@npart('mushrooms')
def _mushrooms():
    M = _nm(); rnd = random.Random(81); parts = []
    for (x, y, s) in ((0.0, 0.0, 1.0), (0.24, -0.12, 0.7), (-0.16, 0.2, 0.55)):
        t = _toadstool('ms', M, s, rnd); t.location = (x, y, 0.0); parts.append(t)
    return nfinish('mushrooms', parts, 0.02)


@npart('stump')
def _stump():
    M = _nm(); rnd = random.Random(82)
    bark = lathe('stump_b', [(0.36, 0.0), (0.4, 0.1), (0.34, 0.26), (0.31, 0.44), (0.0, 0.45)], axis='Z', segs=12, mat=M['Bark'])
    bark.data.shade_smooth(); paint_bark(bark, 0.45, 5)
    top = lathe('stump_t', [(0.0, 0.42), (0.29, 0.42), (0.29, 0.47), (0.0, 0.47)], axis='Z', segs=12, mat=M['Wood'])
    _set_col(top, [(1.0, 1.0, 1.0)] * len(top.data.vertices))
    # growth rings: a darker inset disc
    ring = cyl('stump_r', 0.18, 0.47, 0.475, axis='Z', segs=12, mat=M['WoodDark']); vgrad([ring], (0.9, 0.86, 0.92))
    roots = []
    for i in range(4):
        a = 2 * math.pi * i / 4 + rnd.uniform(-0.3, 0.3)
        r = blob('stump_r%d' % i, (math.cos(a) * 0.36, math.sin(a) * 0.36, 0.05), 0.13, M['Bark'], subd=1, scale=(1.3, 0.8, 0.55), jitter=0.08, seed=i)
        xform(r, rot=[('Z', a)]); _set_col(r, [ramp(BARK, 0.35)] * len(r.data.vertices)); roots.append(r)
    return nfinish('stump', [bark, top, ring] + roots, 0.03)


@npart('stone.step')
def _stone_step():
    M = _nm()
    s = lathe('stone.step', [(0.0, 0.1), (0.3, 0.09), (0.42, 0.05), (0.42, -0.02)], axis='Z', segs=8, mat=M['Stone'])
    xform(s, scale=(1.15, 0.85, 1.0)); smooth(s, 40, weighted=False)
    return nfinish('stone.step', [s], 0.02, grad=(0.8, 0.78, 0.88))


@npart('signpost')
def _signpost():
    M = _nm()
    post = rbox('sp_post', (0.1, 0.1, 1.75), (0, 0, 0.875), M['WoodDark'], bev=0.02)
    cap = blob('sp_cap', (0, 0, 1.78), 0.075, M['WoodDark'], subd=1, jitter=0.0)
    arrow = [(-0.34, -0.09), (0.26, -0.09), (0.4, 0.0), (0.26, 0.09), (-0.34, 0.09)]
    b1 = chunky(prism('sp_b1', arrow, -0.025, 0.025, axis='Y', mat=M['Wood']), 0.015); xform(b1, rot=[('Z', 0.35)], loc=(0.08, 0.0, 1.42))
    b2 = chunky(prism('sp_b2', [(-p[0], p[1]) for p in arrow], -0.025, 0.025, axis='Y', mat=M['Wood']), 0.015); xform(b2, rot=[('Z', -0.4)], loc=(-0.08, 0.0, 1.16))
    # painted marks on the boards: a pale strip each
    s1 = rbox('sp_s1', (0.3, 0.012, 0.05), (0.02, -0.03, 1.42), M['Plaster'], bev=0.004); xform(s1, rot=[('Z', 0.35)])
    s2 = rbox('sp_s2', (0.3, 0.012, 0.05), (-0.02, -0.03, 1.16), M['Plaster'], bev=0.004); xform(s2, rot=[('Z', -0.4)])
    return nfinish('signpost', [post, cap, b1, b2, s1, s2], 0.03, grad=(0.8, 0.76, 0.86))

# ---------------------------------------------------------------- the water's edge (src/world/worldTerrain.js)

def _river_stone(name, M, size, seed, mat='Stone', loc=(0.0, 0.0)):
    """A water-worn stone: a lumpy low-poly pebble, its underside flattened and sunk so it beds into a bank."""
    s = blob(name, (0, 0, 0), 1.0, M[mat], subd=2, scale=size, jitter=0.16, seed=seed)
    for v in s.data.vertices:
        if v.co.z < 0: v.co.z *= 0.3
        v.co.z += size[2] * 0.2
    s.location = (loc[0], loc[1], 0.0)
    return s


@npart('stone.bank.a')
def _stone_bank_a():
    M = _nm(); return nfinish('stone.bank.a', [_river_stone('sba', M, (0.27, 0.21, 0.15), 3)], 0.015, grad=(0.74, 0.72, 0.86))


@npart('stone.bank.b')
def _stone_bank_b():
    M = _nm()
    return nfinish('stone.bank.b', [_river_stone('sbb0', M, (0.34, 0.24, 0.1), 5), _river_stone('sbb1', M, (0.1, 0.085, 0.065), 6, loc=(0.3, 0.14))], 0.015, grad=(0.74, 0.72, 0.86))


@npart('stone.bank.c')
def _stone_bank_c():
    M = _nm()
    return nfinish('stone.bank.c', [_river_stone('sbc0', M, (0.22, 0.18, 0.18), 7, mat='StoneDark'), _river_stone('sbc1', M, (0.16, 0.13, 0.11), 8, loc=(0.2, -0.12))], 0.015, grad=(0.78, 0.76, 0.9))


@npart('reeds')
def _reeds():
    """A reed clump for the shallows: tall bent blades (the tuft's, taller and slimmer) and three cattails."""
    M = _nm(); parts = [tuft('reeds_b', M, seed=9, blades=9, h=0.95)]
    xform(parts[0], scale=(0.75, 0.75, 1.0))
    for i, (x, y, h) in enumerate(((0.05, 0.02, 1.12), (-0.08, 0.06, 0.98), (0.03, -0.08, 0.86))):
        stem = cyl('reeds_s%d' % i, 0.013, 0.0, h, axis='Z', segs=4, mat=M['Leaf'], center=(x, y, 0))
        _set_col(stem, [ramp(GRASS, 0.25 + 0.6 * v.co.z / h) for v in stem.data.vertices])
        head = lathe('reeds_h%d' % i, [(0.0, h - 0.03), (0.028, h), (0.036, h + 0.08), (0.03, h + 0.16), (0.0, h + 0.19)], axis='Z', segs=6, mat=M['WoodDark'], center=(x, y, 0))
        head.data.shade_smooth(); vgrad([head], (0.72, 0.64, 0.74)); parts += [stem, head]
    return nfinish('reeds', parts, 0.0)


def _pad(name, M, r=0.3, notch=0.34, segs=18, z=0.0):
    """A lily pad: a flat disc with its wedge cut, dark at the rim and bright toward the notch."""
    pts = [(0.03, 0.0)] + [(math.cos(notch + (2 * math.pi - 2 * notch) * k / segs) * r, math.sin(notch + (2 * math.pi - 2 * notch) * k / segs) * r) for k in range(segs + 1)]
    pad = prism(name, pts, z, z + 0.018, axis='Z', mat=M['Leaf'])
    _set_col(pad, [ramp(LEAF, 0.75 - 0.4 * math.hypot(v.co.x, v.co.y) / r) for v in pad.data.vertices])
    return pad


@npart('lily.pad')
def _lily_pad():
    M = _nm(); return nfinish('lily.pad', [_pad('lp', M)], 0.01)


@npart('lily.bloom')
def _lily_bloom():
    """A pad with a water lily on it: a cup of pointed petals, blush at the base, a butter-yellow heart."""
    M = _nm(); rnd = random.Random(93); parts = [_pad('lb_pad', M, r=0.32, notch=0.3)]
    for ring, (n, rad, tilt, s) in enumerate(((7, 0.07, 0.75, 1.0), (6, 0.045, 1.05, 0.8))):
        for k in range(n):
            a = 2 * math.pi * (k + 0.5 * ring) / n + rnd.uniform(-0.1, 0.1)
            p = blob('lb_p%d_%d' % (ring, k), (0, 0, 0), 1.0, M['Petal'], subd=1, scale=(0.075 * s, 0.03 * s, 0.012), jitter=0.0)
            xform(p, rot=[('Y', -tilt), ('Z', a)], loc=(math.cos(a) * rad, math.sin(a) * rad, 0.05 + 0.02 * ring))
            vgrad([p], (1.0, 0.72, 0.8), lo=0.03, hi=0.12); parts.append(p)
    heart = blob('lb_h', (0, 0, 0.07), 0.03, M['ButterYellow'], subd=1, scale=(1, 1, 0.7), jitter=0.0); parts.append(heart)
    return nfinish('lily.bloom', parts, 0.01)


@npart('bridge.plank')
def _bridge_plank():
    """
    The footbridge a lane takes over the brook. Local X runs along the lane (the walking direction, the engine turns
    it onto the lane's tangent); local Y runs with the water. The deck sits on the lane's own ground (the terrain
    keeps the lane's height under it), so only its planks stand proud; below its two edges a stone culvert face
    drops into the channel with a dark arched mouth the water runs into.
    """
    M = _nm(); rnd = random.Random(95); parts = []
    L, Wd, n = 4.4, 3.5, 10
    for i in range(n):
        x = -L / 2 + (i + 0.5) * L / n
        p = rbox('bp_plank%d' % i, (L / n - 0.035, Wd + rnd.uniform(-0.06, 0.06), 0.07), (x, rnd.uniform(-0.03, 0.03), 0.035 + rnd.uniform(-0.008, 0.008)), M['Wood'], bev=0.012,
                 rot=('Z', rnd.uniform(-0.025, 0.025)))
        t = rnd.uniform(0.84, 1.0); vgrad([p], (t * 0.86, t * 0.8, t * 0.88), (t, t, t)); parts.append(p)
    for sy in (-1, 1):
        y = sy * (Wd / 2 - 0.02)
        kerb = rbox('bp_kerb%d' % sy, (L + 0.1, 0.14, 0.13), (0, y, 0.12), M['WoodDark'], bev=0.02); parts.append(kerb)
        for j, x in enumerate((-2.05, -0.68, 0.68, 2.05)):
            post = rbox('bp_post%d_%d' % (sy, j), (0.12, 0.12, 0.88), (x, y, 0.5), M['WoodDark'], bev=0.02)
            cap = rbox('bp_cap%d_%d' % (sy, j), (0.16, 0.16, 0.05), (x, y, 0.96), M['Wood'], bev=0.015); parts += [post, cap]
        rail = rbox('bp_rail%d' % sy, (L, 0.1, 0.09), (0, y, 0.86), M['Wood'], bev=0.02); vgrad([rail], (0.9, 0.86, 0.92)); parts.append(rail)
        # The culvert face under this edge: two piers, a lintel, rounded arch shoulders, a dark mouth set back.
        fy = sy * (Wd / 2 + 0.1)
        for k, (x0, x1) in enumerate(((-2.35, -1.55), (-1.55, -0.85), (0.85, 1.55), (1.55, 2.35))):
            b = rbox('bp_pier%d_%d' % (sy, k), (x1 - x0 - 0.03, 0.24, 0.84), ((x0 + x1) / 2, fy, -0.42), M['Stone'], bev=0.04)
            t = 0.8 + 0.06 * ((k * 7 + sy) % 3); vgrad([b], (t * 0.82, t * 0.8, t * 0.92), (t, t, t)); parts.append(b)
        lintel = rbox('bp_lintel%d' % sy, (1.72, 0.26, 0.2), (0, fy, -0.1), M['Stone'], bev=0.04); vgrad([lintel], (0.86, 0.84, 0.94)); parts.append(lintel)
        for sx in (-1, 1):
            # an upper corner of the mouth, filled so the opening reads as an arch
            sh = prism('bp_sh%d_%d' % (sy, sx), [(0.0, 0.0), (-sx * 0.34, 0.0), (0.0, -0.3)], -0.12, 0.12, axis='Y', mat=M['Stone'])
            xform(sh, loc=(sx * 0.85, fy, -0.2)); parts.append(sh)
        mouth = rbox('bp_mouth%d' % sy, (1.7, 0.05, 0.78), (0, sy * (Wd / 2 - 0.15), -0.45), M['StoneDark'], bev=0.0)
        _set_col(mouth, [(0.2, 0.19, 0.26)] * len(mouth.data.vertices)); parts.append(mouth)
    return nfinish('bridge.plank', parts, 0.02)


@npart('pool.basin')
def _pool_basin():
    """The stone pool the brook ends in at the square: a kerb ring with a low wall inside and capstones round the rim."""
    M = _nm(); rnd = random.Random(97)
    ring = lathe('pb_ring', [(1.42, -0.06), (1.41, 0.14), (1.34, 0.26), (1.22, 0.31), (1.11, 0.26), (1.08, 0.12), (1.06, -0.5)], axis='Z', segs=20, mat=M['Stone'])
    smooth(ring, 40, weighted=False); vgrad([ring], (0.7, 0.68, 0.82), lo=-0.5, hi=0.31)
    parts = [ring]
    for k in range(12):
        a = 2 * math.pi * k / 12 + rnd.uniform(-0.08, 0.08)
        c = blob('pb_cap%d' % k, (math.cos(a) * 1.25, math.sin(a) * 1.25, 0.3), 1.0, M['Stone'] if k % 3 else M['StoneDark'], subd=1, scale=(0.2, 0.15, 0.07), jitter=0.0)
        xform(c, rot=[('Z', a + math.pi / 2)]); vgrad([c], (0.82, 0.8, 0.92)); parts.append(c)
    return nfinish('pool.basin', parts, 0.025)

# ---------------------------------------------------------------- build, review, ship

def build_nature_parts():
    materials()
    C = bpy.data.collections.get(PARTS_COLL_N) or bpy.data.collections.new(PARTS_COLL_N)
    if C.name not in bpy.data.scenes['Scene'].collection.children: bpy.data.scenes['Scene'].collection.children.link(C)
    doomed = list(C.objects); meshes = [o.data for o in doomed if o.type == 'MESH']
    for o in doomed: bpy.data.objects.remove(o, do_unlink=True)
    for me in meshes:
        if me.users == 0: bpy.data.meshes.remove(me)
    info = {}
    for pid in NPART_ORDER:
        ob = NPARTS[pid]()
        for u in list(ob.users_collection): u.objects.unlink(ob)
        C.objects.link(ob)
        info[pid] = tris([ob])
    C.hide_render = True; C.hide_viewport = True
    return {'parts': len(info), 'tris': sum(info.values()), 'each': info}


def nature_parts_index():
    C = bpy.data.collections[PARTS_COLL_N]; idx = {}
    for pid in NPART_ORDER:
        o = C.objects[pid]; foot = max(math.hypot(v.co.x, v.co.y) for v in o.data.vertices)
        idx[pid] = {'foot': round(foot, 3), 'tris': tris([o])}
    return idx


def review_nature(path=NATURE_REVIEW, res=(1200, 700), samples=16, gap=1.35):
    """The parts in a row on the review set, one light render."""
    C = bpy.data.collections[PARTS_COLL_N]; sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    tmp = bpy.data.collections.get('NAT_Review') or bpy.data.collections.new('NAT_Review')
    if tmp.name not in sc.collection.children: sc.collection.children.link(tmp)
    for o in list(tmp.objects): bpy.data.objects.remove(o, do_unlink=True)
    side = Vector((0.8, 0.6, 0.0)); n = len(NPART_ORDER)
    for i, pid in enumerate(NPART_ORDER):
        c = C.objects[pid].copy(); tmp.objects.link(c)
        c.matrix_world = Matrix.Translation(LINEUP + side * (i - (n - 1) / 2) * gap) @ Matrix.Rotation(FACE, 4, 'Z')
        if c.get('arc_outline', 0) > 0: outline(c, c['arc_outline'])
    cam = bpy.data.objects.get('ARC_NatureCam') or bpy.data.objects.new('ARC_NatureCam', bpy.data.cameras.new('ARC_NatureCam'))
    if cam.name not in tmp.objects: tmp.objects.link(cam)
    t = LINEUP + Vector((0, 0, 0.55)); d = Vector((0.6, -0.8, 0.42)).normalized()
    cam.location = t + d * 16.5; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 35; cam.data.clip_start = 0.1; cam.data.clip_end = 1000; sc.camera = cam
    hide = tuple(x for x in ('ARC_Gameplay', 'ARC_Weapons', 'ARC_Critters', 'ARC_Creatures', 'ARC_Houses') if bpy.data.collections.get(x))
    try: return render_review(path, res, samples, hide=hide)
    finally:
        sc.camera = keep
        for o in list(tmp.objects):
            if o.type != 'CAMERA': bpy.data.objects.remove(o, do_unlink=True)


WATER_REVIEW = OUT + '/arcade/arcade-water-parts-review.png'


def water_material():
    """The preview's toon water (the engine's is ArcadeToon water()): open-water blue, the kit's toon shade and rim."""
    m = bpy.data.materials.get('ARC_Water')
    return m if m else toon('ARC_Water', '#5fb4cf', shade='#8ea9d8', rim=0.2)


def review_water_parts(path=WATER_REVIEW, res=(1200, 700), samples=16):
    """The water's parts on the review set: the footbridge (raised onto its piers so its culvert faces show), the
    square's pool, lily pads on a disc of water, reed clumps and the three bank stones. One light render."""
    C = bpy.data.collections[PARTS_COLL_N]; sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    tmp = bpy.data.collections.get('NAT_Review') or bpy.data.collections.new('NAT_Review')
    if tmp.name not in sc.collection.children: sc.collection.children.link(tmp)
    for o in list(tmp.objects): bpy.data.objects.remove(o, do_unlink=True)
    side = Vector((0.8, 0.6, 0.0)); deep = Vector((-0.6, 0.8, 0.0))
    lay = [('bridge.plank', 0.0, 0.9, 0.84, 0.0), ('pool.basin', -4.3, 0.4, 0.0, 0.0),
           ('lily.pad', 3.25, 0.05, 0.004, 0.6), ('lily.pad', 4.0, 0.6, 0.004, 2.2), ('lily.bloom', 3.7, -0.35, 0.004, 1.0), ('lily.bloom', 4.35, 0.05, 0.004, 4.0),
           ('reeds', 2.5, 1.1, 0.0, 0.3), ('reeds', 4.9, 1.0, 0.0, 2.0),
           ('stone.bank.a', -1.5, -1.9, 0.0, 0.4), ('stone.bank.b', -0.45, -2.0, 0.0, 1.2), ('stone.bank.c', 0.6, -1.9, 0.0, 2.5)]
    for pid, u, v, z, yaw in lay:
        c = C.objects[pid].copy(); tmp.objects.link(c)
        c.matrix_world = Matrix.Translation(LINEUP + side * u + deep * v + Vector((0, 0, z))) @ Matrix.Rotation(FACE + yaw, 4, 'Z')
        if c.get('arc_outline', 0) > 0: outline(c, c['arc_outline'])
    for name, r, u, v, z in (('NAT_ReviewWater', 1.35, 3.8, 0.15, 0.0), ('NAT_ReviewPool', 1.08, -4.3, 0.4, 0.12)):
        w = cyl(name, r, z, z + 0.003, axis='Z', segs=40, mat=water_material(), center=tuple(LINEUP + side * u + deep * v))
        ensure_grad([w])
        for c in list(w.users_collection): c.objects.unlink(w)
        tmp.objects.link(w)
    cam = bpy.data.objects.get('ARC_NatureCam') or bpy.data.objects.new('ARC_NatureCam', bpy.data.cameras.new('ARC_NatureCam'))
    if cam.name not in tmp.objects: tmp.objects.link(cam)
    t = LINEUP + deep * 0.1 + Vector((0, 0, 0.5)); d = Vector((0.6, -0.8, 0.5)).normalized()
    cam.location = t + d * 13.5; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 35; cam.data.clip_start = 0.1; cam.data.clip_end = 1000; sc.camera = cam
    hide = tuple(x for x in ('ARC_Gameplay', 'ARC_Weapons', 'ARC_Critters', 'ARC_Creatures', 'ARC_Houses') if bpy.data.collections.get(x))
    try: return render_review(path, res, samples, hide=hide)
    finally:
        sc.camera = keep
        for o in list(tmp.objects):
            if o.type != 'CAMERA': bpy.data.objects.remove(o, do_unlink=True)


def ship_nature_parts(path=PARTS_GLB_N, index=PARTS_INDEX_N):
    C = bpy.data.collections[PARTS_COLL_N]
    objs = [o for o in C.objects]
    gltf_mode(True)
    try:
        C.hide_viewport = False
        bpy.context.view_layer.update()
        size = export_glb(objs, path)
    finally:
        gltf_mode(False); C.hide_viewport = True
    idx = nature_parts_index()
    with open(index, 'w') as f:
        f.write('// Generated by tools/blender/v2/arcade/nature_parts.py (ship_nature_parts): the nature parts library\n'
                '// index - every part id with its footprint radius (metres) and triangle count. The world rules are validated against it.\n'
                'export const NATURE_PARTS = ' + json.dumps(idx, indent=1, sort_keys=True) + ';\n')
    return {'kb': round(size / 1024, 1), 'parts': len(idx), 'tris': tris(objs)}
