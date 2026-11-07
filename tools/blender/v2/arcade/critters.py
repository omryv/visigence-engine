"""Arcade enemies: Jelly Slime, Shroomling, Bumble Brute and the King Slime boss. Unrigged critters: the engine
animates each one as a single solid body (prepareRigidBody + RigidAnimator in src/anim/RigidBody.js: bob,
lean, lunge, topple), so every silhouette is a round, squashy shape that reads well moving as one piece.

exec after vg.py, kit.py, nature.py, hero_corner.py, props.py and weapons.py (same globals):
    g['build_critters']()   g['review_critters']()   g['ship_critters']()
Conventions: metres, Z up, the critter faces -Y (glTF +Z, like every engine character), its lowest point is
the floor. The engine rescales each to its catalog height and drops it onto the floor by that lowest point,
so the Bumble Brute's hover is a pack setting (`hover`), not part of the model. Each GLB has up to three
nodes: Body (full outline), Face (thin outline) and Shine (highlights, no outline); extras.arc_outline holds
each node's outline width at the authored scale.
"""
import bpy, bmesh, math, random
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

CRITTER_MATS = {
    'ARC_Slime':     ('#8ff0c4', {'shade': '#76b6c9', 'rim': 0.7}),
    'ARC_SlimeKing': ('#cdaaff', {'shade': '#9c86d8', 'rim': 0.7}),
    'ARC_Ink':       ('#3b2d45', {'rim': 0.0}),
    'ARC_Wing':      ('#e2f5ff', {'shade': '#b3c6e8', 'rim': 0.8}),
}
CRITTER_GLOW = {'ARC_Shine': '#ffffff'}
# id -> (label, catalog height in metres, hover in metres). The review lineup uses the same numbers.
CRITTERS = {'slime': ('JellySlime', 1.2, 0.0), 'shroom': ('Shroomling', 1.5, 0.0), 'bee': ('BumbleBrute', 1.4, 0.45),
            'king': ('KingSlime', 3.0, 0.0)}
CRITTERS_REVIEW = OUT + '/arcade/arcade-critters-review.png'

def critter_mats():
    M = prop_mats()
    for k, (h, kw) in CRITTER_MATS.items(): M[k[4:]] = toon(k, h, **kw)
    for k, h in CRITTER_GLOW.items(): M[k[4:]] = glow(k, h)
    return M

# ---------------------------------------------------------------- surface features

def fdir(az, el):
    """Direction from a critter's centre: az degrees from the front (-Y) toward +X, el degrees up."""
    a, e = math.radians(az), math.radians(el)
    return Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))

class Skin:
    """Ray-casts from a centre point onto a mesh so features sit on its surface."""
    def __init__(self, ob, centre):
        me = ob.data
        self.bvh = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [tuple(p.vertices) for p in me.polygons])
        self.c = Vector(centre)
    def hit(self, d):
        loc, nrm, _, _ = self.bvh.ray_cast(self.c, Vector(d).normalized())
        if loc is None: raise ValueError(f'feature ray {tuple(d)} missed the surface')
        if nrm.dot(loc - self.c) < 0: nrm = -nrm
        return loc, nrm
    def stick(self, name, d, r, mat, scale=(1, 1, 0.45), out=0.0, spin=0.0, subd=3):
        """A blob flattened along the surface normal (eyes, spots, blush, highlights)."""
        loc, nrm = self.hit(d)
        ob = blob(name, (0, 0, 0), r, mat, subd=subd, scale=scale, jitter=0.0)
        q = nrm.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        ob.data.transform(Matrix.Translation(loc + nrm * out) @ q @ Matrix.Rotation(spin, 4, 'Z'))
        return ob
    def line(self, name, dirs, r, mat, out=0.0):
        """A tube drawn on the surface through the given directions (mouths, brows)."""
        pts = []
        for d in dirs:
            loc, nrm = self.hit(d); pts.append(loc + nrm * out)
        return tube(name, pts, r, mat, segs=8)

def eyes(S, M, az, el, r, look=(0.0, 0.0), angry=0.0, sink=-0.25):
    """Sclera + pupil + catchlight pairs at +-az; `look` shifts the pupils (in eye radii); angry > 0 adds
    brows whose outer ends rise by that many degrees. Returns (face parts, shine parts)."""
    face, shine = [], []
    loc, _ = S.hit(fdir(az, el)); ang = math.degrees(r / (loc - S.c).length)   # the eye's angular radius
    for s in (-1, 1):
        a = s * az
        face.append(S.stick(f'sclera{s}', fdir(a, el), r, M['Petal'], (0.82, 1.12, 0.42), out=sink * r))
        face.append(S.stick(f'pupil{s}', fdir(a + look[0] * ang * 0.4, el + look[1] * ang * 0.4), r * 0.56, M['Ink'], (0.8, 1.0, 0.5), out=r * 0.1))
        shine.append(S.stick(f'catch{s}', fdir(a - ang * 0.25, el + ang * 0.35), r * 0.2, M['Shine'], (1, 1, 0.5), out=r * 0.32, subd=2))
        if angry:
            b = el + ang * 1.3
            face.append(S.line(f'brow{s}', [fdir(s * (az - ang * 0.9), b), fdir(s * (az + ang * 1.1), b + angry)], r * 0.2, M['Ink'], out=r * 0.1))
    return face, shine

# ---------------------------------------------------------------- bodies

def slime_body(name, R, mat, curl=0.34, seed=0):
    """Jelly drop: flat bulging base, round belly, a soft curl on top. Base on z=0."""
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=4, radius=R)
    for v in bm.verts:
        x, y, z = v.co
        if z < 0: z *= 0.42
        rho = math.hypot(x, y)
        z += curl * R * max(0.0, 1 - rho / (0.38 * R)) ** 2
        v.co = Vector((x * 1.08, y * 1.04, z))
    zmin = min(v.co.z for v in bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, -zmin), verts=bm.verts)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    vgrad([ob], (0.74, 0.78, 0.92), lo=0.0, hi=max(v.co.z for v in ob.data.vertices) * 0.9, local=True)
    return ob

def jelly_slime(M):
    body = slime_body('body', 0.6, M['Slime'])
    S = Skin(body, (0, 0, 0.36))
    face, shine = eyes(S, M, 21, 16, 0.115, look=(0, -0.3))
    face.append(S.line('mouth', [fdir(a, -6 - 4 * (1 - (a / 11) ** 2)) for a in range(-11, 12, 3)], 0.017, M['Ink'], out=0.004))
    face += [S.stick(f'blush{s}', fdir(s * 42, 0), 0.075, M['CoralPink'], (1.3, 0.8, 0.22), out=-0.01, subd=2) for s in (-1, 1)]
    shine.append(S.stick('shine', fdir(-38, 46), 0.085, M['Shine'], (1.6, 0.5, 0.22), out=-0.005, spin=0.7))
    shine.append(S.stick('shine2', fdir(-52, 30), 0.032, M['Shine'], (1, 1, 0.3), out=-0.003, subd=2))
    return {'Body': ([body], 0.022), 'Face': (face, 0.007), 'Shine': (shine, 0.0)}

def king_slime(M):
    body = slime_body('body', 1.0, M['SlimeKing'], curl=0.12)
    top = max(v.co.z for v in body.data.vertices)
    S = Skin(body, (0, 0, 0.6))
    face, shine = eyes(S, M, 20, 18, 0.17, look=(0, -0.4), angry=7)
    face.append(S.stick('mouth', fdir(0, -10), 0.16, M['Ink'], (1.9, 0.75, 0.3), out=-0.02))
    face += [S.stick(f'tooth{s}', fdir(s * 6, -5.5), 0.045, M['Petal'], (0.9, 1.1, 0.5), out=0.0) for s in (-1, 1)]
    face += [S.stick(f'blush{s}', fdir(s * 40, -2), 0.11, M['CoralPink'], (1.3, 0.8, 0.22), out=-0.015, subd=2) for s in (-1, 1)]
    shine.append(S.stick('shine', fdir(-40, 44), 0.13, M['Shine'], (1.7, 0.5, 0.2), out=-0.01, spin=0.7))
    shine.append(S.stick('shine2', fdir(-55, 28), 0.05, M['Shine'], (1, 1, 0.3), out=-0.005, subd=2))
    # the trapped gem: a big crystal stuck in the belly, half sunk
    loc, nrm = S.hit(fdir(28, -26))
    gm = gem('gem', 0.12, 0.42, M['Crystal'])
    q = nrm.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    gm.data.transform(Matrix.Translation(loc - nrm * 0.18) @ q @ Matrix.Rotation(0.3, 4, 'Y'))
    vgrad([gm], (0.74, 0.76, 1.0))
    # crown: a gold band with five points, each tipped with a pastel gem, tilted a little
    parts = [lathe('band', [(0.36, 0.0), (0.4, 0.0), (0.44, 0.24), (0.4, 0.24), (0.36, 0.02), (0.36, 0.0)], axis='Z', segs=24,
                   mat=M['ButterYellow'], cap=False)]
    gems = (M['CoralPink'], M['Mint'], M['SkyBlue'], M['Mint'], M['CoralPink'])
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5; d = Vector((math.cos(a), math.sin(a), 0))
        sp = lathe(f'spike{k}', [(0.075, 0.0), (0.0, 0.2)], axis='Z', segs=8, mat=M['ButterYellow'])
        xform(sp, loc=d * 0.42 + Vector((0, 0, 0.22))); parts.append(sp)
        parts.append(ball(f'crowngem{k}', d * 0.42 + Vector((0, 0, 0.44)), 0.045, gems[k]))
    parts.append(gem('jewel', 0.06, 0.12, M['CoralPink']))
    xform(parts[-1], rot=[('X', math.pi / 2)], loc=(0, -0.36, 0.12))    # points out of the band's front
    for p in parts: smooth(p, 40, weighted=False)
    vgrad(parts, (0.82, 0.74, 0.74), lo=0.0, hi=0.46, local=True)
    crown = merge('crown', parts)
    xform(crown, rot=[('Y', 0.12), ('X', -0.06)], loc=(0.05, 0.02, top - 0.2))
    return {'Body': ([body, gm, crown], 0.035), 'Face': (face, 0.011), 'Shine': (shine, 0.0)}

def shroomling(M):
    cap = lathe('cap', [(0.0, 1.2), (0.25, 1.17), (0.45, 1.07), (0.56, 0.94), (0.585, 0.85), (0.53, 0.8), (0.3, 0.83), (0.0, 0.85)],
                axis='Z', segs=28, mat=M['CoralPink'], cap=False)
    cap.data.materials.append(M['Plaster'])
    for p in cap.data.polygons:                 # underside = cream gills
        if p.normal.z < -0.35: p.material_index = 1
    smooth(cap, 50, weighted=False)
    vgrad([cap], (0.78, 0.72, 0.84), lo=0.8, hi=1.2, local=True)
    CS = Skin(cap, (0, 0, 0.9)); rnd = random.Random(8); spots = []
    for i, (az, el, r) in enumerate(((0, 38, 0.1), (-58, 30, 0.08), (62, 34, 0.09), (150, 40, 0.1), (-140, 32, 0.085), (100, 60, 0.07),
                                     (-95, 58, 0.075), (20, 70, 0.065), (205, 62, 0.07))):
        spots.append(CS.stick(f'spot{i}', fdir(az, el), r, M['Plaster'], (1, 1, 0.3), out=-0.012, spin=rnd.uniform(0, 3), subd=2))
    vgrad(spots, (0.9, 0.88, 0.92))
    stem = lathe('stem', [(0.0, 0.1), (0.24, 0.1), (0.3, 0.24), (0.315, 0.45), (0.28, 0.68), (0.23, 0.84), (0.0, 0.86)], axis='Z', segs=22,
                 mat=M['Plaster'], cap=False)
    smooth(stem, 50, weighted=False); vgrad([stem], (0.74, 0.7, 0.8), lo=0.1, hi=0.86, local=True)
    feet = [ball(f'foot{s}', (s * 0.15, -0.06, 0.075), 0.12, M['Wood'], (0.85, 1.25, 0.62)) for s in (-1, 1)]
    arms = []
    for s in (-1, 1):   # stubby arms hanging off the stem, splayed a little
        a = ball(f'arm{s}', (0, 0, 0), 0.075, M['Plaster'], (0.75, 0.75, 1.25))
        xform(a, rot=[('Y', s * 0.35)], loc=(s * 0.33, 0, 0.4)); arms.append(a)
    vgrad(feet + arms, (0.78, 0.74, 0.84))
    cap_all = merge('cap', [cap] + spots)
    xform(cap_all, rot=[('X', 0.07)])
    S = Skin(stem, (0, 0, 0.5))
    face, shine = eyes(S, M, 19, 6, 0.072, look=(0, -0.2), angry=8)
    face.append(S.line('frown', [fdir(a, -13 + 4 * (1 - (a / 12) ** 2)) for a in range(-12, 13, 3)], 0.013, M['Ink'], out=0.003))
    face += [S.stick(f'blush{s}', fdir(s * 38, -4), 0.05, M['CoralPink'], (1.3, 0.8, 0.22), out=-0.008, subd=2) for s in (-1, 1)]
    return {'Body': ([cap_all, stem] + feet + arms, 0.02), 'Face': (face, 0.006), 'Shine': (shine, 0.0)}

def bumble_brute(M):
    ab = lathe('abdomen', [(0.0, -0.02), (0.28, 0.02), (0.4, 0.15), (0.44, 0.32), (0.42, 0.48), (0.34, 0.62), (0.2, 0.72), (0.0, 0.76)],
               axis='Y', segs=24, mat=M['ButterYellow'], cap=False)
    ab.data.materials.append(M['WoodDark'])
    for p in ab.data.polygons:                  # crisp stripes: brown bands by position along the abdomen
        y = p.center.y
        if 0.12 < y < 0.24 or 0.36 < y < 0.48 or 0.58 < y < 0.8: p.material_index = 1
    smooth(ab, 50, weighted=False)
    sting = lathe('sting', [(0.05, 0.74), (0.0, 0.88)], axis='Y', segs=8, mat=M['Iron'])
    abd = merge('abdomen', [ab, sting])
    xform(abd, rot=[('X', -0.3)], loc=(0, 0.1, 0.6))
    thorax = ball('thorax', (0, -0.1, 0.64), 0.3, M['ButterYellow'], (1, 1.05, 0.95))
    collar = torus('collar', 0.25, 0.075, (0, -0.26, 0.65), M['Plaster'], axis='Y', segs=18, rsegs=8)
    head = ball('head', (0, -0.42, 0.68), 0.27, M['ButterYellow'], (1.05, 0.95, 0.95))
    legs = []
    for s in (-1, 1):
        for i, y in enumerate((-0.2, 0.0, 0.2)):
            legs.append(tube(f'leg{s}{i}', bez((s * 0.12, y, 0.44), (s * 0.2, y - 0.02, 0.34), (s * 0.17, y - 0.05, 0.2), 5), 0.022, M['WoodDark'], segs=8))
            legs.append(ball(f'legfoot{s}{i}', (s * 0.17, y - 0.05, 0.19), 0.035, M['WoodDark']))
        legs.append(tube(f'antenna{s}', bez((s * 0.08, -0.46, 0.92), (s * 0.12, -0.5, 1.08), (s * 0.2, -0.66, 1.12), 6), 0.015, M['WoodDark'], segs=8))
        legs.append(ball(f'antennaknob{s}', (s * 0.2, -0.66, 1.12), 0.045, M['WoodDark']))
    vgrad([thorax, collar, head, abd], (0.76, 0.72, 0.84), lo=0.3, hi=1.0)
    ensure_grad(legs)
    wings = []
    for s in (-1, 1):
        for i, (r, back) in enumerate(((0.34, 0.0), (0.24, 0.2))):
            w = ball(f'wing{s}{i}', (0, 0, 0), r, M['Wing'], (0.52, 1.0, 0.06))
            xform(w, loc=(0, r * 0.85, 0))                         # hinge at the wing root
            # sweep up and back, roll the outer edge up, then fan out to this side (+X for s = 1)
            xform(w, rot=[('X', 0.55 + 0.25 * i), ('Y', -s * (0.55 + 0.1 * i)), ('Z', -s * (0.25 + 0.35 * i))], loc=(s * 0.12, -0.1 + back, 0.88))
            wings.append(w)
    vgrad(wings, (0.86, 0.9, 1.0))
    S = Skin(head, (0, -0.42, 0.68))
    face, shine = eyes(S, M, 26, 10, 0.1, look=(0, -0.3), angry=9)
    face.append(S.line('mouth', [fdir(a, -18 + 3.5 * (1 - (a / 14) ** 2)) for a in range(-14, 15, 4)], 0.014, M['Ink'], out=0.003))
    return {'Body': ([abd, thorax, collar, head] + legs, 0.02), 'Wings': (wings, 0.01), 'Face': (face, 0.006), 'Shine': (shine, 0.0)}

BUILDERS = {'slime': jelly_slime, 'shroom': shroomling, 'bee': bumble_brute, 'king': king_slime}

# ---------------------------------------------------------------- build, review, ship

def _mesh_bounds(objs):
    vs = [v.co for o in objs for v in o.data.vertices]
    return Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))), Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))

def build_critters():
    M = critter_mats()
    sc, back, G = _review_scene()
    C = bpy.data.collections.get('ARC_Critters') or bpy.data.collections.new('ARC_Critters')
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    _clear(C)
    info = {}; placed = {}
    for cid, fn in BUILDERS.items():
        label, height, hover = CRITTERS[cid]
        nodes = fn(M); objs = []
        for node, (parts, width) in nodes.items():
            if not parts: continue
            ensure_grad(parts)
            ob = put(merge(f'ARC_C_{label}_{node}', parts), C); ob['arc_outline'] = width
            if width > 0: outline(ob, width)
            objs.append(ob)
        lo, hi = _mesh_bounds(objs)
        placed[cid] = (objs, height / (hi.z - lo.z), hover)
        info[cid] = {'tris': tris(objs), 'model_height': round(hi.z - lo.z, 3), 'width': round(hi.x - lo.x, 3), 'depth': round(hi.y - lo.y, 3)}
    f = Vector((-0.6, 0.8, 0.0))
    for cid, off in (('slime', SIDE * -3.6 + f * -0.6), ('shroom', SIDE * -1.4 + f * -0.2), ('bee', SIDE * 0.9 + f * -0.4), ('king', SIDE * 3.8 + f * 1.2)):
        objs, k, hover = placed[cid]
        for o in objs:
            o.location = LINEUP + off + Vector((0, 0, hover)); o.rotation_euler = (0, 0, FACE + 0.15); o.scale = (k, k, k)
    return info

def review_critters(path=CRITTERS_REVIEW, res=(1200, 700), samples=16):
    """One light EEVEE render of the critter lineup from the props camera (props and weapons hidden)."""
    sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    sc.camera = bpy.data.objects['ARC_ReviewCam']
    try: return render_review(path, res, samples, hide=('ARC_Gameplay', 'ARC_Weapons'))
    finally: sc.camera = keep

def ship_critters(out=OUT + '/arcade'):
    """One GLB per critter (Body, Face, Shine and Wings nodes at the authored scale) + 256 px catalog cards."""
    ob = bpy.data.objects; res = {}
    for cid, (label, _, _) in CRITTERS.items():
        nodes = [(o.name.rsplit('_', 1)[1], [o], None, (0, 0, 0), True) for o in bpy.data.collections['ARC_Critters'].objects
                 if o.name.startswith(f'ARC_C_{label}_')]
        res[cid] = export_nodes(sorted(nodes), f'{out}/arcade-{cid}.glb')
    cards = {cid: ([o.name for o in bpy.data.collections['ARC_Critters'].objects if o.name.startswith(f'ARC_C_{label}_')], True)
             for cid, (label, _, _) in CRITTERS.items()}
    res['cards'] = thumbnails(thumbs=cards)
    return res
