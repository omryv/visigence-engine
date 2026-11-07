"""Arcade hero: the villager-adventurer player character (pack characters.player), and the body Arcade's first-person
arms are to be cut from (fparms.py). Genre-neutral: a tunic, belt, satchel, gloves or bracers and boots, no military cues.
Anime-style lead: spiky hair, and a serious face drawn in ink strokes on the skin (eyes, brows, nose line, mouth).

exec after vg.py, kit.py, nature.py, hero_corner.py, props.py, weapons.py, critters.py and pickups.py (same globals):
    g['hero_stage']()          a small meadow, sky, sun and camera in the current file (collection ARC_HeroStage)
    g['blockouts']()           the three silhouette variants side by side (collection ARC_HeroBlockout)
    g['review_blockouts']()    one light EEVEE render of them
    g['hero']()                the chosen variant in T-pose on its Mixamo skeleton, skinned (collection ARC_Hero)
    g['clips']()               Hero_Idle, _Walk, _Run (loops) and _Jump, _Interact, hand-keyed from procedural poses; the
                               genre clips Hero_Attack (a staff swing), _AimIdle and _AimRun (a weapon held at the chest,
                               loops), _Hit, _Death and _Cheer
    g['review_hero']() / g['turntable']() / g['contact_sheet']()     one light render each
    g['export_hero']()         assets/v2/arcade/characters/arcade-hero.glb, with a Grip_R socket on the right hand where
                               the engine hangs a held thing (gear.py's staff); g['hero_card']() its catalog card
Conventions: metres, Z up, feet on z=0, the hero faces -Y (glTF +Z) with the right hand on -X. 1.80 m tall
with a head of 1/3.5 of that. Colour is the kit's: ARC_ materials x the 'Col' gradient. Skin is ARC_Plaster toned
peach in 'Col', so the theme gains no material for it.
"""
import bpy, bmesh, math, hashlib, os
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

HEIGHT = 1.8
SKIN_TONE = (1.0, 0.76, 0.62)               # 'Col' on ARC_Plaster: the warm peach of the face and hands
CLOTH_FOOT = (0.84, 0.8, 0.9)               # 'Col' at the soles: clothes darken toward the ground, lilac-cool
HERO_REVIEW = OUT + '/arcade/review-work/arcade-hero-blockouts.png'
# Joints of the left side in T-pose; the modelling and the skeleton both read them, so bones sit where the parts bend.
SHOULDER = Vector((0.21, 0.0, 1.17))        # left shoulder pivot (the right one mirrors it)
ELBOW = Vector((0.455, 0.0, 1.166))
WRIST = Vector((0.67, 0.0, 1.165))          # left wrist: the hand is modelled life-size and scaled up about it
HAND_SCALE = 1.3                            # the toon hand: big and readable at every distance
HIP = Vector((0.1, 0.0, 0.7))               # left hip joint
KNEE = Vector((0.106, -0.006, 0.37))
ANKLE = Vector((0.106, 0.0, 0.1))
BALL = Vector((0.106, -0.12, 0.035))
TOE = Vector((0.106, -0.2, 0.035))
# fingers before the hand scale: (name, knuckle y, length, radius); knuckles at x=0.772, z=1.168; the thumb is a curve
HERO_FINGERS = (('Index', -0.034, 0.085, 0.0178), ('Middle', -0.011, 0.09, 0.0182), ('Ring', 0.012, 0.084, 0.0175),
                ('Pinky', 0.033, 0.07, 0.0162))
HERO_THUMB = ((0.705, -0.042, 1.158), (0.75, -0.09, 1.152), (0.792, -0.108, 1.15))
REST_CURL = 6.0                             # the rig's rest fingers: straight, not stiff

# The three blockouts differ in silhouette: spiky hair style and colour, tunic length, sleeves, forearm gear and satchel.
VARIANTS = {
    'A': dict(label='Trail scout', tunic='Mint', skirt=0.56, trousers='Wood', boots='WoodDark', cuff='ButterYellow',
              hair='Roof', style='flame', eyes='LeafGreen', sleeve='rolled', forearm='bracer', satchel='Burlap', strap='WoodDark'),
    'B': dict(label='Meadow tinker', tunic='SkyBlue', skirt=0.42, trousers='Wood', boots='WoodDark', cuff=None,
              hair='Ink', style='swept', eyes='SkyBlue', sleeve='short', forearm='glove', satchel='Wood', strap='Rope'),
    'C': dict(label='Hearth hero', tunic='Plaster', skirt=0.5, vest='CoralPink', trousers='SkyBlue', boots='Wood',
              cuff='WoodDark', hair='Wood', style='soft', eyes='Wood', scarf='Mint', sleeve='rolled', forearm='bracer',
              satchel='Burlap', strap='WoodDark'),
}

# ---------------------------------------------------------------- materials and colour

def hero_mats():
    M = critter_mats()
    for k, (h, kw) in PICK_MATS.items(): M[k[4:]] = toon(k, h, **kw)
    return M

def hero_tone(objs, color=(1, 1, 1), bottom=CLOTH_FOOT, lo=0.0, hi=HEIGHT):
    """'Col' = a flat tone x the ground-up gradient (world Z): skin gets the peach, clothes only the gradient."""
    def fn(w, l):
        t = min(1.0, max(0.0, (w.z - lo) / (hi - lo))) ** 0.7
        return tuple(color[i] * (bottom[i] + (1 - bottom[i]) * t) for i in range(3))
    paint(objs, fn)

def bare(ob):
    """Mark an object as bare skin: hero_tone() paints it with SKIN_TONE."""
    ob['hero_skin'] = True
    return ob

# ---------------------------------------------------------------- blockout parts (left side; the right mirrors)

def about(objs, pivot, axis, deg):
    """Rotate meshes about a world pivot (posing a limb for review)."""
    R = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(deg), 4, axis) @ Matrix.Translation(-Vector(pivot))
    for o in objs: o.data.transform(R); o.data.update()
    return objs

def uvball(name, loc, r, mat, scale=(1, 1, 1), segs=12, rings=8):
    """A smooth UV sphere, cheaper than the kit's icosphere blob at the same silhouette (palms, shoulders, ears)."""
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r)
    for v in bm.verts: v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2])) + Vector(loc)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    return ob

def hand_scale():
    """The toon hand's scale about the wrist (the hand is laid out life-size with its wrist at x=0.69)."""
    return Matrix.Translation(WRIST) @ Matrix.Scale(HAND_SCALE, 4) @ Matrix.Translation(-WRIST - Vector((0.02, 0, 0)))

def finger_joints(y, length, curl):
    """Knuckle, the two finger joints and the tip of a finger along +X, curling toward the palm (-Z) by `curl` degrees."""
    pts = [Vector((0.772, y, 1.168))]
    for share, phi in ((0.45, 0.25), (0.33, 0.6), (0.22, 1.0)):
        t = math.radians(curl * phi); pts.append(pts[-1] + Vector((math.cos(t), 0, -math.sin(t))) * length * share)
    return pts

def hand(M, v, pre, curl=REST_CURL):
    """Palm, four fingers and a thumb in T-pose (palm down, thumb toward -Y), scaled up about the wrist."""
    skin = M['Plaster']; P = []
    P.append(bare(uvball(f'{pre}palm', (0.735, -0.004, 1.165), 0.058, skin, scale=(0.95, 1.08, 0.6), segs=14, rings=9)))
    for n, y, L, r in HERO_FINGERS:
        P.append(bare(tube(f'{pre}{n.lower()}', finger_joints(y, L, curl), [r, r * 0.97, r * 0.92, r * 0.86], skin, segs=8)))
    th = bez(*HERO_THUMB, 5)
    P.append(bare(tube(f'{pre}thumb', th, taper(0.021, 0.018, len(th)), skin, segs=8)))
    if v['forearm'] == 'glove':             # fingerless glove: a leather shell over the palm, fingers bare
        P.append(uvball(f'{pre}glove', (0.733, -0.004, 1.165), 0.062, M['WoodDark'], scale=(0.9, 1.1, 0.66), segs=14, rings=9))
    S = hand_scale()
    for o in P: o.data.transform(S); o.data.update()
    return P

def arm(M, v, pre, curl=REST_CURL):
    skin = M['Plaster']; tunic = M[v['tunic']]; P = []
    P.append(uvball(f'{pre}deltoid', (0.225, 0.0, 1.16), 0.102, tunic, segs=14, rings=9))
    if v['sleeve'] == 'rolled':             # sleeve to mid upper arm, rolled into a fat cuff
        P.append(tube(f'{pre}sleeve', [(0.21, 0, 1.168), (0.36, 0, 1.166)], [0.086, 0.079], tunic, segs=12))
        P.append(torus(f'{pre}roll', 0.078, 0.024, (0.365, 0, 1.166), tunic, axis='X', segs=14, rsegs=6))
    else:                                   # short cap sleeve
        P.append(tube(f'{pre}sleeve', [(0.21, 0, 1.168), (0.3, 0, 1.167)], [0.088, 0.083], tunic, segs=12))
    ua = [(0.29, 0, 1.167), (0.37, 0, 1.166), (0.46, 0, 1.165)]
    P.append(bare(tube(f'{pre}upper', ua, [0.068, 0.064, 0.06], skin, segs=12)))
    fa = [(0.455, 0, 1.165), (0.52, 0, 1.165), (0.6, 0, 1.165), (0.675, 0, 1.165)]
    P.append(bare(tube(f'{pre}fore', fa, [0.06, 0.074, 0.068, 0.054], skin, segs=12)))   # the chunky forearm
    if v['forearm'] == 'bracer':
        P.append(cyl(f'{pre}bracer', 0.077, 0.55, 0.66, axis='X', segs=14, mat=M['Wood'], center=(0, 0, 1.165), r2=0.064))
        P.append(torus(f'{pre}bracertrim', 0.077, 0.01, (0.555, 0, 1.165), M['ButterYellow'], axis='X', segs=14, rsegs=5))
    return P + hand(M, v, pre, curl)

def leg(M, v, pre):
    tr = M[v['trousers']]; P = []
    P.append(tube(f'{pre}thigh', [HIP, (HIP + KNEE) / 2 + Vector((0, 0.002, 0)), KNEE + Vector((0, 0, -0.01))], [0.094, 0.084, 0.072], tr, segs=12))
    P.append(tube(f'{pre}shin', [KNEE + Vector((0, 0.002, 0.01)), (0.106, 0.0, 0.2)], [0.07, 0.064], tr, segs=12))
    P.append(lathe(f'{pre}shaft', [(0.076, 0.06), (0.079, 0.2), (0.088, 0.27), (0.09, 0.3), (0.0, 0.3)], axis='Z', segs=16,
                   mat=M[v['boots']], center=(0.106, 0, 0)))
    P.append(loft(f'{pre}foot', [(0.08, 0.13, 0.0, 0.07), (0.0, 0.135, 0.0, 0.08), (-0.1, 0.105, 0.0, 0.084),
                                  (-0.17, 0.075, 0.0, 0.072), (-0.2, 0.045, 0.006, 0.05)], segs=16, mat=M[v['boots']]))
    xform(P[-1], loc=(0.106, 0, 0))
    P.append(rbox(f'{pre}sole', (0.17, 0.3, 0.024), (0.106, -0.055, 0.012), M['WoodDark'], 0.008))
    if v.get('cuff'):
        P.append(torus(f'{pre}cuff', 0.09, 0.02, (0.106, 0, 0.29), M[v['cuff']], axis='Z', segs=16, rsegs=6))
    return P

def torso(M, v):
    tunic = M[v['tunic']]; P = []
    st = [(0.62, -0.135, 0.125, 0.195, 2.4), (0.8, -0.13, 0.12, 0.176, 2.4), (0.95, -0.155, 0.132, 0.215, 2.4),
          (1.08, -0.175, 0.142, 0.27, 2.4), (1.17, -0.152, 0.13, 0.258, 2.4), (1.235, -0.1, 0.09, 0.18, 2.4)]
    P.append(loft('chest', st, segs=24, mat=tunic, axis='Z'))
    z1 = v['skirt']; flare = [(0.86, -0.155, 0.142, 0.21, 2.4), (0.72, -0.172, 0.158, 0.232, 2.4), (z1, -0.19, 0.178, 0.255, 2.4)]
    P.append(loft('skirt', flare, segs=24, mat=tunic, axis='Z'))
    if v.get('vest'):                       # an open vest over the tunic: body shell with the shirt showing down the front
        for s in (-1, 1):                   # two front panels meeting at the sides, open down the middle
            P.append(loft(f'vest{s}', [(0.84, -0.163, 0.15, 0.1, 2.4, s * 0.126), (0.97, -0.163, 0.145, 0.098, 2.4, s * 0.122),
                                       (1.09, -0.18, 0.15, 0.114, 2.4, s * 0.14), (1.19, -0.152, 0.133, 0.108, 2.4, s * 0.134)],
                          segs=20, mat=M[v['vest']], axis='Z'))
    P.append(loft('belt', [(0.83, -0.163, 0.15, 0.219, 3.0), (0.9, -0.161, 0.148, 0.216, 3.0)], segs=24, mat=M['WoodDark'], axis='Z'))
    P.append(rbox('buckle', (0.075, 0.022, 0.065), (0, -0.168, 0.865), M['ButterYellow'], 0.01))
    P.append(tube('crotch', [(-0.1, 0, 0.66), (0.1, 0, 0.66)], 0.1, M[v['trousers']], segs=12))
    P.append(bare(cyl('neck', 0.086, 1.2, 1.32, axis='Z', segs=14, mat=M['Plaster'])))
    # satchel on the left hip, strap from the right shoulder across the chest and back
    P.append(rbox('satchel', (0.085, 0.23, 0.2), (0.27, -0.03, 0.75), M[v['satchel']], 0.025))
    P.append(rbox('flap', (0.095, 0.235, 0.085), (0.278, -0.03, 0.815), M['WoodDark'] if v['satchel'] != 'Wood' else M['Burlap'], 0.015))
    strap = [(0.25, -0.08, 0.83), (0.19, -0.15, 0.87), (0.1, -0.176, 0.95), (0.0, -0.182, 1.05), (-0.1, -0.166, 1.15),
             (-0.17, -0.1, 1.225), (-0.19, 0.0, 1.258), (-0.17, 0.1, 1.225), (-0.1, 0.142, 1.16), (0.0, 0.153, 1.06),
             (0.1, 0.153, 0.96), (0.2, 0.136, 0.87), (0.26, 0.06, 0.82)]          # one band over the right shoulder, on the surface
    P.append(tube('strap', strap, 0.017, M[v['strap']], segs=8))
    if v.get('scarf'):
        P.append(torus('scarf', 0.12, 0.045, (0, 0, 1.25), M[v['scarf']], axis='Z', segs=18, rsegs=7))
        P.append(tube('scarftail', bez((0.06, -0.14, 1.24), (0.1, -0.2, 1.12), (0.08, -0.19, 1.0), 6), 0.035, M[v['scarf']], segs=8))
    return P

HEAD_C = Vector((0.0, 0.0, 1.545))          # the skull's centre: hair and face features are aimed from here

# Spiky anime hair as clumps: (root az, root el, tip az, tip el, tip lift off the scalp, half-width, bulge), angles as
# critters.fdir (az from the front toward +X, el up). Each style's silhouette is its own, not any existing character's.
HAIR = {
    'flame': [   # ginger: tall flames up and back, flaring out at the sides, a quiff in front
        (0, 60, 8, 86, 0.325, 0.125, 0.03), (20, 75, 30, 88, 0.33, 0.12, 0.03), (-25, 75, -35, 88, 0.33, 0.12, 0.03),
        (45, 60, 72, 70, 0.29, 0.12, 0.03), (-45, 60, -72, 70, 0.29, 0.12, 0.03), (92, 42, 108, 38, 0.26, 0.11, 0.02),
        (-92, 42, -108, 38, 0.26, 0.11, 0.02), (100, 65, 125, 65, 0.28, 0.12, 0.03), (-100, 65, -125, 65, 0.28, 0.12, 0.03),
        (140, 60, 156, 58, 0.29, 0.125, 0.03), (-140, 60, -156, 58, 0.29, 0.125, 0.03), (180, 45, 180, 28, 0.26, 0.125, 0.02),
        (125, 18, 136, -2, 0.18, 0.105, 0.02), (-125, 18, -136, -2, 0.18, 0.105, 0.02), (180, 12, 180, -12, 0.16, 0.11, 0.02),
        (10, 55, 22, 21, 0.03, 0.095, 0.04), (-15, 55, -26, 22, 0.03, 0.095, 0.04), (38, 50, 52, 11, 0.03, 0.08, 0.03),
        (-40, 50, -54, 13, 0.03, 0.08, 0.03), (0, 58, 4, 28, 0.04, 0.085, 0.04),
        (70, 26, 74, -6, 0.015, 0.052, 0.01), (-70, 26, -74, -6, 0.015, 0.052, 0.01)],
    'swept': [   # black: wind-swept back and toward the left side, long trailing spikes, a sideways fringe
        (0, 65, 55, 76, 0.26, 0.125, 0.04), (20, 78, 90, 80, 0.26, 0.12, 0.03), (-60, 70, 10, 85, 0.26, 0.125, 0.04),
        (40, 55, 102, 55, 0.29, 0.12, 0.03), (60, 70, 120, 70, 0.31, 0.125, 0.03), (-30, 62, 42, 82, 0.23, 0.12, 0.04),
        (92, 40, 132, 34, 0.3, 0.12, 0.03), (130, 40, 160, 25, 0.31, 0.12, 0.03), (-82, 45, -112, 46, 0.2, 0.105, 0.02),
        (150, 55, 172, 44, 0.33, 0.125, 0.03), (-150, 55, -166, 44, 0.26, 0.12, 0.03), (112, 20, 142, 4, 0.25, 0.105, 0.02),
        (-116, 20, -140, 4, 0.18, 0.105, 0.02), (180, 20, 186, -6, 0.22, 0.11, 0.02),
        (-20, 55, 20, 21, 0.035, 0.1, 0.04), (5, 55, 44, 13, 0.035, 0.095, 0.04), (-45, 50, -30, 16, 0.03, 0.08, 0.03),
        (30, 50, 62, 17, 0.03, 0.08, 0.03), (70, 26, 74, -6, 0.015, 0.052, 0.01), (-70, 26, -74, -6, 0.015, 0.052, 0.01)],
    'soft': [    # brown: shorter tousled spikes all round, a long fringe swept to the right side
        (0, 70, 0, 88, 0.195, 0.12, 0.03), (25, 78, 30, 88, 0.2, 0.12, 0.03), (-25, 78, -30, 88, 0.2, 0.12, 0.03),
        (50, 62, 58, 80, 0.195, 0.12, 0.03), (-50, 62, -58, 80, 0.195, 0.12, 0.03), (105, 34, 138, 4, 0.12, 0.1, 0.02),
        (-105, 34, -138, 4, 0.12, 0.1, 0.02), (120, 62, 140, 60, 0.18, 0.12, 0.03), (-120, 62, -140, 60, 0.18, 0.12, 0.03),
        (150, 50, 162, 40, 0.195, 0.12, 0.03), (-150, 50, -162, 40, 0.195, 0.12, 0.03), (180, 25, 180, 4, 0.16, 0.12, 0.02),
        (130, 15, 140, -6, 0.13, 0.1, 0.02), (-130, 15, -140, -6, 0.13, 0.1, 0.02),
        (20, 56, -14, 20, 0.035, 0.105, 0.04), (-10, 56, -40, 15, 0.035, 0.1, 0.04), (45, 50, 40, 9, 0.03, 0.08, 0.03),
        (-45, 50, -62, 11, 0.03, 0.08, 0.03), (70, 26, 74, -6, 0.015, 0.052, 0.01), (-70, 26, -74, -6, 0.015, 0.052, 0.01)],
}

class Shell(Skin):
    """critters.Skin over several meshes, hit from OUTSIDE: the outermost surface along each direction from the centre
    (the skull centre sits inside the cheek blob, so a ray from it would stop on the cheek's inner side)."""
    def __init__(self, objs, centre):
        vs, ps = [], []
        for o in objs:
            base = len(vs); vs += [o.matrix_world @ v.co for v in o.data.vertices]
            ps += [tuple(base + i for i in p.vertices) for p in o.data.polygons]
        self.bvh = BVHTree.FromPolygons(vs, ps); self.c = Vector(centre)
    def hit(self, d):
        d = Vector(d).normalized()
        loc, nrm, _, _ = self.bvh.ray_cast(self.c + d * 0.6, -d)
        if loc is None: raise ValueError(f'feature ray {tuple(d)} missed the surface')
        if nrm.dot(d) < 0: nrm = -nrm
        return loc, nrm

def azel(d):
    """Inverse of fdir: (az, el) in degrees of a direction from the skull centre."""
    d = Vector(d).normalized()
    return math.degrees(math.atan2(d.x, -d.y)), math.degrees(math.asin(max(-1.0, min(1.0, d.z))))

def hairline(az):
    """Lowest elevation the scalp cap reaches at an azimuth: high over the brow, down to the ears, low at the nape."""
    a = abs((az + 180) % 360 - 180)
    return 5 + 41 * math.cos(math.radians(a)) if a <= 90 else 5 - 33 * (a - 90) / 90

def scalp(name, S, mat, lift=0.014, fade=14, subd=3):
    """The hair's base: an icosphere shrink-wrapped onto the skull above the hairline, its edge tucked under the skin."""
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=subd, radius=1.0)
    kill = []
    for v in bm.verts:
        az, el = azel(v.co); lo = hairline(az)
        if el < lo - 3: kill.append(v); continue
        loc, nrm = S.hit(v.co)
        k = min(1.0, max(0.0, (el - lo) / fade))
        v.co = loc + nrm * (lift * (k * k * (3 - 2 * k)) - 0.004)
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    return ob

def hair_clump(name, S, spec, mat, rings=5, segs=6):
    """One hair clump: a flattened cone from a root sunk into the scalp to a tip lifted off it, bowed outward."""
    az0, el0, az1, el1, out, w, bulge = spec
    r0, n0 = S.hit(fdir(az0, el0)); r1, n1 = S.hit(fdir(az1, el1))
    p0 = r0 - n0 * w * 0.35; p2 = r1 + n1 * out
    mid = (p0 + p2) / 2; p1 = mid + (mid - S.c).normalized() * bulge
    pts = bez(p0, p1, p2, rings)
    bm = bmesh.new(); rows = []
    for i, p in enumerate(pts[:-1]):
        t = i / rings; tan = (pts[i + 1] - pts[max(i - 1, 0)]).normalized()
        across = tan.cross((p - S.c).normalized())
        if across.length < 1e-4: across = tan.cross(Vector((0, 0, 1)))
        across.normalize(); up = across.cross(tan).normalized()
        k = (1 - t) ** 0.8 * (1 + 0.18 * math.sin(math.pi * t))
        rows.append([bm.verts.new(p + across * math.cos(a) * w * k + up * math.sin(a) * w * 0.42 * k)
                     for a in (2 * math.pi * j / segs for j in range(segs))])
    tip = bm.verts.new(pts[-1])
    for A, B in zip(rows, rows[1:]):
        for j in range(segs): bm.faces.new((A[j], A[(j + 1) % segs], B[(j + 1) % segs], B[j]))
    for j in range(segs): bm.faces.new((rows[-1][j], rows[-1][(j + 1) % segs], tip))
    bm.faces.new(list(reversed(rows[0])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    return ob

def skull_mesh(name, mat, R=(0.2575, 0.2375, 0.26)):
    """The head as ONE surface, so no seam or outline crosses the face: an ellipsoid shaped per direction from the skull
    centre, with fuller cheeks, a jaw narrowing toward the chin and a small chin point. The nose is only its ink stroke."""
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=15, radius=1.0)
    for v in bm.verts:
        d = v.co.normalized(); az, el = azel(d)
        p = Vector((d.x * R[0], d.y * R[1], d.z * R[2]))
        flat = Vector((d.x, d.y, 0.0))
        if flat.length > 1e-6:
            p += flat.normalized() * 0.018 * math.exp(-(((abs(az) - 42) / 26) ** 2 + ((el + 24) / 16) ** 2))   # cheeks
        p.x *= 1 - 0.14 * min(1.0, max(0.0, (-28 - el) / 50))                                              # jaw
        p += Vector((0, -0.022, -0.012)) * math.exp(-((az / 24) ** 2 + ((el + 52) / 16) ** 2))              # chin
        v.co = HEAD_C + p
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    return ob

def head(M, v):
    """Round head, a firm jaw with a small chin point, ears and spiky hair; face() draws the rest."""
    skin = M['Plaster']; hair = M[v['hair']]
    H = bare(skull_mesh('head', skin)); P = [H]
    for s in (-1, 1): P.append(bare(uvball(f'ear{s}', (s * 0.252, 0.02, 1.515), 0.055, skin, scale=(0.5, 0.8, 1.0), segs=10, rings=7)))
    S = Shell([H], HEAD_C)
    P.append(scalp('scalp', S, hair))
    P += [hair_clump(f'hair{i}', S, c, hair) for i, c in enumerate(HAIR[v['style']])]
    return [H], P

def patch(S, name, dirs, mat, out=0.004):
    """A flat shape drawn on the surface: a fan from its centre through the outline directions (the open grin)."""
    bm = bmesh.new()
    ring = []
    for d in dirs:
        loc, nrm = S.hit(d); ring.append(bm.verts.new(loc + nrm * out))
    c = sum((v.co for v in ring), Vector()) / len(ring)
    loc, nrm = S.hit(c - S.c); mid = bm.verts.new(loc + nrm * out)
    for a, b in zip(ring, ring[1:] + ring[:1]): bm.faces.new((mid, a, b))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bm.faces[0].normal.dot(nrm) < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    return ob

def stroke(S, name, pts, widths, mat, out=0.006):
    """An ink stroke drawn on the surface: a ribbon through (az, el) points, `widths` its half-width in degrees at each,
    so a line can swell and taper like a brush line (lids, brows, creases)."""
    bm = bmesh.new(); L, R = [], []; n = len(pts)
    for i, (az, el) in enumerate(pts):
        (a0, e0), (a1, e1) = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
        l = math.hypot(a1 - a0, e1 - e0) or 1.0; na, ne = -(e1 - e0) / l, (a1 - a0) / l; w = max(widths[i], 0.08)
        for row, k in ((L, 1), (R, -1)):
            loc, nrm = S.hit(fdir(az + na * w * k, el + ne * w * k)); row.append(bm.verts.new(loc + nrm * out))
    fs = [bm.faces.new((L[i], R[i], R[i + 1], L[i + 1])) for i in range(n - 1)]
    bm.normal_update()
    f = fs[len(fs) // 2]
    if f.normal.dot(f.calc_center_median() - S.c) < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    return ob

def ellipse(cx, cy, rx, ry, n=14):
    return [(cx + rx * math.cos(2 * math.pi * k / n), cy + ry * math.sin(2 * math.pi * k / n)) for k in range(n)]

# The hero eye in its own (x outward from the nose, y up) degrees: a wide almond under a low, hooded upper lid that
# hides the top of the iris (a steady, serious look), flat over the inner corner where the brow presses down.
EYE_EL = -2.0
EYE_TOP = [(-13, 0.8), (-8.7, 4.4), (-2.9, 7.2), (2.9, 8.0), (8.7, 7.0), (13.8, 3.8)]
EYE_BOTTOM = [(13.8, 3.8), (10.2, -3.2), (4.4, -7.6), (-2.9, -8.0), (-8.7, -5.4), (-13, 0.8)]
LID_W = [0.7, 1.7, 2.4, 2.6, 2.3, 1.7, 0.4]                       # upper lid, inner corner to the flick
BROW = [(-12, 10.5), (-7, 13.0), (-1.5, 15.0), (5, 16.3), (13, 16.0)]   # low over the eye, pressed down at the nose
BROW_W = [2.2, 2.4, 2.0, 1.3, 0.4]

def eye(S, M, s, iris, a=21.0):
    """One eye at az s*a: white, iris, pupil, two catchlights (same side on both eyes: one light), and ink lids and brow."""
    at = lambda x, y: (a * s + s * x, EYE_EL + y)
    D = lambda pts: [fdir(*at(x, y)) for x, y in pts]
    F = [patch(S, f'white{s}', D(EYE_TOP + EYE_BOTTOM[1:-1]), M['Petal'], out=0.003),
         patch(S, f'iris{s}', D(ellipse(-0.7, 0.3, 6.0, 8.0)), M[iris], out=0.0045),
         patch(S, f'pupil{s}', D(ellipse(-0.7, 0.3, 2.7, 4.0)), M['Ink'], out=0.0055),
         stroke(S, f'lid{s}', [at(x, y) for x, y in EYE_TOP + [(16.4, 5.2)]], LID_W, M['Ink'], out=0.007),
         stroke(S, f'lower{s}', [at(13.8, 3.8), at(10.2, -3.2), at(4.4, -7.6), at(-1.5, -8.1)], [1.1, 0.6, 0.3, 0.12], M['Ink'], out=0.007),
         stroke(S, f'brow{s}', [at(x, y) for x, y in BROW], BROW_W, M['Ink'], out=0.006)]
    c = a * s
    Sh = [patch(S, f'catch{s}', [fdir(x, y) for x, y in ellipse(c - 2.6, EYE_EL + 3.2, 1.5, 1.7, 10)], M['Shine'], out=0.0065),
          patch(S, f'glint{s}', [fdir(x, y) for x, y in ellipse(c + 1.8, EYE_EL - 3.6, 0.7, 0.7, 8)], M['Shine'], out=0.0065)]
    return F, Sh

# A closed, set mouth: one firm line, a touch lower at the corners, a lip shadow under it.
MOUTH = [(-9.5, -19.9), (-5, -19.3), (0, -19.1), (5, -19.3), (9.5, -20.0)]
MOUTH_W = [0.2, 0.5, 0.65, 0.5, 0.2]

def face(M, skull, iris):
    """The hero face, drawn in ink on the skin like the cel line work of an anime lead: hooded eyes, set brows with a
    furrow, a nose stroke on the shadow side and a closed, firm mouth. Serious, not sweet, and the same construction for
    every hero, so they read as one cast."""
    S = Shell(skull, HEAD_C); F, Sh = [], []
    for s in (-1, 1):
        f, sh = eye(S, M, s, iris); F += f; Sh += sh
    F.append(stroke(S, 'mouth', MOUTH, MOUTH_W, M['Ink']))
    F.append(stroke(S, 'lip', [(-3.5, -23.4), (0, -23.9), (3.5, -23.4)], [0.1, 0.35, 0.1], M['Ink']))
    F.append(stroke(S, 'furrow', [(3.2, EYE_EL + 12.0), (2.6, EYE_EL + 15.2)], [0.3, 0.1], M['Ink']))
    F.append(stroke(S, 'nose', [(2.4, -5.0), (3.6, -9.0), (2.0, -11.5)], [0.15, 0.5, 0.2], M['Ink']))   # shadow side: the sun is on -X
    return F, Sh

# ---------------------------------------------------------------- build, stage, review

def hero_parts(key, arms_down=0.0, curl=REST_CURL, spread=0.0):
    """Every part of one variant, toned but not merged: (skull, body parts, face strokes, catchlights). arms_down and
    spread pose the limbs for a review; the defaults are the rig's T-pose."""
    M = hero_mats(); v = VARIANTS[key]
    skull, P = head(M, v)
    P += torso(M, v)
    side = arm(M, v, 'L_', curl) + leg(M, v, 'L_')
    arms = [o for o in side if not o.name.startswith(('L_thigh', 'L_shin', 'L_shaft', 'L_foot', 'L_sole', 'L_cuff'))]
    if arms_down: about(arms, SHOULDER, 'Y', arms_down)
    if spread: about([o for o in side if o not in arms], HIP, 'Y', -spread)
    for o in side: mirror_x(o)
    P += side
    F, Sh = face(M, skull, v['eyes'])
    skin = [o for o in P if o.get('hero_skin')]
    hero_tone(skin, SKIN_TONE); hero_tone([o for o in P if o not in skin])
    ensure_grad(F + Sh)
    return skull, P, F, Sh

def blockout(key, x=0.0, arms_down=50, curl=60):
    """One variant for review: body parts merged into Body (outlined), face strokes into Face, catchlights into Shine."""
    v = VARIANTS[key]; col = coll('ARC_HeroBlockout')
    _, P, F, Sh = hero_parts(key, arms_down, curl, spread=6)
    body = put(merge(f'HERO_{key}_Body', P), col); body['arc_outline'] = 0.014; outline(body, 0.014)
    fc = put(merge(f'HERO_{key}_Face', F), col); fc['arc_outline'] = 0.0
    sh = put(merge(f'HERO_{key}_Shine', Sh), col); sh['arc_outline'] = 0.0
    for o in (body, fc, sh): o.location = (x, 0, 0)
    return {'variant': key, 'label': v['label'], 'tris': tris([body, fc, sh])}

def hero_stage():
    """A round lawn tile, the kit's sky and sun, and a front three-quarter camera in this file."""
    M = hero_mats(); set_look(); sky()
    st = coll('ARC_HeroStage')
    lawn = bpy.data.objects.get('ARC_HeroLawn')
    if not lawn:
        lawn = put(grass_tile('ARC_HeroLawn', M, 3.6, spacing=0.3, rim=0.8, drop=0.25), st)
        paint_ground([put(meadow('ARC_HeroMeadow', M, radius=90.0, z=-0.06), st)], far=60.0)
    sun(collection=st)
    camera((0, 0, 0.92), (0.22, -1.0, 0.36), 6.4, lens=50, collection=st, name='ARC_HeroCam')
    render_setup()
    return lawn

def ground_contact(objs):
    """Paint the lawn with contact shading under whatever stands on it."""
    paint_ground([bpy.data.objects['ARC_HeroLawn']], contacts=contact_points(objs, below=0.06), far=8.0)

def clear(col):
    for o in list(col.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)

def guarded(fn):
    """Run a build; if it fails, remove what it created, so no unpainted part is left standing in the scene."""
    before = set(bpy.data.objects)
    try: return fn()
    except Exception:
        for o in set(bpy.data.objects) - before: bpy.data.objects.remove(o, do_unlink=True)
        raise

def blockouts(keys=('A', 'B', 'C'), gap=1.45):
    hero_stage(); col = coll('ARC_HeroBlockout'); clear(col)
    out = guarded(lambda: [blockout(k, (i - (len(keys) - 1) / 2) * gap) for i, k in enumerate(keys)])
    ground_contact([o for o in col.objects if o.name.endswith('_Body')])
    return out

def review_blockouts(path=HERO_REVIEW, res=(1200, 700), samples=16):
    bpy.context.scene.camera = bpy.data.objects['ARC_HeroCam']
    return render(path, res, samples)

# ---------------------------------------------------------------- the skeleton (Mixamo names, T-pose)

HERO_KEY = 'B'                               # the chosen variant (2026-09-24): black wind-swept hair, sky-blue tunic
HERO_OUTLINE = 0.014
HERO_OUT = OUT + '/arcade/characters/arcade-hero.glb'
CARD_OUT = OUT + '/arcade/catalog'
REVIEW_DIR = OUT + '/arcade/review-work'

def J(n): return 'mixamorig:' + n

def skeleton():
    """{bone: (head, tail, parent, roll axis)} for the 65 bones of the standard Mixamo skeleton, placed on the joints the
    parts were modelled around. The _End and finger-4 bones are the leaves Mixamo files carry (non-deforming)."""
    B = {}
    def add(n, h, t, parent, z=(0, -1, 0)):
        B[J(n)] = (Vector(h), Vector(t), J(parent) if parent else None, Vector(z))
    add('Hips', (0, 0, 0.7), (0, 0, 0.8), None)
    add('Spine', (0, 0, 0.8), (0, 0, 0.92), 'Hips')
    add('Spine1', (0, 0, 0.92), (0, 0, 1.04), 'Spine')
    add('Spine2', (0, 0, 1.04), (0, 0, 1.2), 'Spine1')
    add('Neck', (0, 0, 1.2), (0, 0, 1.3), 'Spine2')
    add('Head', (0, 0, 1.3), (0, 0, 1.805), 'Neck')
    add('HeadTop_End', (0, 0, 1.805), (0, 0, 1.9), 'Head')
    H = hand_scale()
    for S, s in (('Left', 1), ('Right', -1)):
        m = lambda v, s=s: Vector((v[0] * s, v[1], v[2]))
        up = (0, 0, 1)
        add(f'{S}Shoulder', m((0.05, 0, 1.17)), m(SHOULDER), 'Spine2', up)
        add(f'{S}Arm', m(SHOULDER), m(ELBOW), f'{S}Shoulder', up)
        add(f'{S}ForeArm', m(ELBOW), m(WRIST), f'{S}Arm', up)
        add(f'{S}Hand', m(WRIST), m(H @ finger_joints(HERO_FINGERS[1][1], HERO_FINGERS[1][2], REST_CURL)[0]), f'{S}ForeArm', up)
        for n, y, L, r in HERO_FINGERS:
            j = [H @ q for q in finger_joints(y, L, REST_CURL)]
            j.append(j[3] + (j[3] - j[2]).normalized() * 0.015)
            for i in range(4):
                add(f'{S}Hand{n}{i + 1}', m(j[i]), m(j[i + 1]), f'{S}Hand' if i == 0 else f'{S}Hand{n}{i}', up)
        th = [H @ q for q in bez(*HERO_THUMB, 5)]
        j = [th[0], th[2], th[4], th[5], th[5] + (th[5] - th[4]).normalized() * 0.015]
        for i in range(4):
            add(f'{S}HandThumb{i + 1}', m(j[i]), m(j[i + 1]), f'{S}Hand' if i == 0 else f'{S}HandThumb{i}', up)
        add(f'{S}UpLeg', m(HIP), m(KNEE), 'Hips')
        add(f'{S}Leg', m(KNEE), m(ANKLE), f'{S}UpLeg')
        add(f'{S}Foot', m(ANKLE), m(BALL), f'{S}Leg', up)
        add(f'{S}ToeBase', m(BALL), m(TOE), f'{S}Foot', up)
        add(f'{S}Toe_End', m(TOE), m(TOE + Vector((0, -0.04, 0))), f'{S}ToeBase', up)
    return B

LEAVES = ('HeadTop_End', 'Toe_End', '4')

def build_hero_rig(name='Hero'):
    old = bpy.data.objects.get(name)
    if old: bpy.data.objects.remove(old, do_unlink=True)
    arm = bpy.data.armatures.new(name); rig = bpy.data.objects.new(name, arm)
    coll('ARC_Hero').objects.link(rig)
    arm.display_type = 'STICK'; rig.show_in_front = True
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    rig.select_set(True); vl.objects.active = rig
    with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[rig]):
        bpy.ops.object.mode_set(mode='EDIT')
        eb = arm.edit_bones
        for n, (h, t, parent, z) in skeleton().items():
            b = eb.new(n); b.head = h; b.tail = t; b.align_roll(z)
            b.use_deform = not n.endswith(LEAVES)
            if parent: b.parent = eb[parent]; b.use_connect = False
        bpy.ops.object.mode_set(mode='OBJECT')
    for p in rig.pose.bones: p.rotation_mode = 'QUATERNION'
    return rig

# ---------------------------------------------------------------- skin weights: each part blends along its own chain

def smooth01(t): t = min(1.0, max(0.0, t)); return t * t * (3 - 2 * t)

def chain_weights(p, chain, blend):
    """Weights of point p along a bone chain [(bone, head, tail)]: the nearest segment, blended half-and-half with its
    neighbour at each joint and fully its own `blend` metres away from it."""
    best = None
    for i, (b, h, t) in enumerate(chain):
        d = t - h; L = d.length; u = max(0.0, min(L, (p - h).dot(d) / L))
        dist = (p - (h + d * (u / L))).length
        if best is None or dist < best[0] - 1e-9: best = (dist, i, u, L)
    _, i, u, L = best; w = {chain[i][0]: 1.0}
    if i > 0 and u < blend:
        f = 0.5 + 0.5 * smooth01(u / blend); w[chain[i][0]] = f; w[chain[i - 1][0]] = 1 - f
    elif i < len(chain) - 1 and L - u < blend:
        f = 0.5 + 0.5 * smooth01((L - u) / blend); w[chain[i][0]] = f; w[chain[i + 1][0]] = 1 - f
    return w

def mix_weights(a, b, t):
    out = {k: v * (1 - t) for k, v in a.items()}
    for k, v in b.items(): out[k] = out.get(k, 0.0) + v * t
    return out

RULES = (('palm', 'palm'), ('glove', 'palm'), ('index', 'finger:Index'), ('middle', 'finger:Middle'), ('ring', 'finger:Ring'),
         ('pinky', 'finger:Pinky'), ('thumb', 'thumb'), ('deltoid', 'shoulder'), ('sleeve', 'shoulder'), ('roll', 'shoulder'),
         ('upper', 'shoulder'), ('fore', 'fore'), ('bracer', 'fore'), ('thigh', 'thigh'), ('shin', 'thigh'), ('shaft', 'boot'),
         ('cuff', 'boot'), ('foot', 'foot'), ('sole', 'foot'), ('skirt', 'skirt'), ('crotch', 'crotch'), ('belt', 'belt'),
         ('buckle', 'belt'), ('satchel', 'satchel'), ('flap', 'satchel'), ('neck', 'neck'), ('scarf', 'neck'),
         ('chest', 'torso'), ('vest', 'torso'), ('shirt', 'torso'), ('strap', 'torso'))

def rule_of(name):
    n = name.split('.')[0]; n = n[2:] if n.startswith('L_') else n
    return next((r for k, r in RULES if n.startswith(k)), 'head')

def weights_for(rule, p, B):
    """Bone weights of one vertex (world position p) of a part following `rule`; the side comes from the vertex's x."""
    S = 'Left' if p.x >= 0 else 'Right'
    seg = lambda n: (J(n), B[J(n)][0], B[J(n)][1])
    spine = [seg('Hips'), seg('Spine'), seg('Spine1'), seg('Spine2')]
    if rule == 'head': return {J('Head'): 1.0}
    if rule == 'neck': return chain_weights(p, [seg('Spine2'), seg('Neck'), seg('Head')], 0.04)
    if rule in ('torso', 'belt'):
        w = chain_weights(p, spine, 0.05)
        k = smooth01((abs(p.x) - 0.12) / 0.1) * smooth01((p.z - 1.08) / 0.1) * 0.5        # the chest top rides the shoulders
        return mix_weights(w, {J(f'{S}Shoulder'): 1.0}, k) if k > 0 else w
    if rule == 'skirt':
        k = smooth01((HIP.z - 0.02 - p.z) / 0.14) * 0.6 * smooth01(abs(p.x) / 0.12)   # the hem follows the thighs
        return mix_weights({J('Hips'): 1.0}, {J(f'{S}UpLeg'): 1.0}, k)
    if rule == 'crotch': return mix_weights({J('Hips'): 1.0}, {J(f'{S}UpLeg'): 1.0}, 0.5 * smooth01(abs(p.x) / 0.1))
    if rule == 'satchel': return mix_weights({J('Hips'): 1.0}, {J('LeftUpLeg'): 1.0}, 0.25 * smooth01((0.78 - p.z) / 0.1))
    if rule == 'shoulder': return chain_weights(p, [seg(f'{S}Shoulder'), seg(f'{S}Arm'), seg(f'{S}ForeArm')], 0.07)
    if rule == 'fore': return chain_weights(p, [seg(f'{S}Arm'), seg(f'{S}ForeArm'), seg(f'{S}Hand')], 0.05)
    if rule == 'palm': return chain_weights(p, [seg(f'{S}ForeArm'), seg(f'{S}Hand')], 0.03)
    if rule.startswith('finger:'):
        f = rule[7:]
        return chain_weights(p, [seg(f'{S}Hand')] + [seg(f'{S}Hand{f}{i}') for i in (1, 2, 3)], 0.012)
    if rule == 'thumb': return chain_weights(p, [seg(f'{S}Hand')] + [seg(f'{S}HandThumb{i}') for i in (1, 2, 3)], 0.012)
    if rule == 'thigh':
        w = chain_weights(p, [seg(f'{S}UpLeg'), seg(f'{S}Leg'), seg(f'{S}Foot')], 0.05)
        return mix_weights(w, {J('Hips'): 1.0}, 0.45 * smooth01((p.z - (HIP.z - 0.06)) / 0.1))
    if rule == 'boot': return chain_weights(p, [seg(f'{S}Leg'), seg(f'{S}Foot')], 0.05)
    if rule == 'foot': return chain_weights(p, [seg(f'{S}Leg'), seg(f'{S}Foot'), seg(f'{S}ToeBase')], 0.03)
    raise KeyError(rule)

def skin_part(ob, B, rule=None):
    """Write the part's vertex groups (world positions: parts are built in place, at the origin)."""
    rule = rule or rule_of(ob.name); groups = {}
    for v in ob.data.vertices:
        for b, w in weights_for(rule, ob.matrix_world @ v.co, B).items():
            if w < 1e-4: continue
            g = groups.get(b) or groups.setdefault(b, ob.vertex_groups.get(b) or ob.vertex_groups.new(name=b))
            g.add([v.index], w, 'REPLACE')
    return rule

def bind_to(ob, rig):
    m = ob.modifiers.new('Armature', 'ARMATURE'); m.object = rig
    ob.parent = rig
    return ob

def hero(key=HERO_KEY):
    """The final hero in T-pose: the rig, and Body (outlined), Face and Shine skinned to it (collection ARC_Hero)."""
    col = coll('ARC_Hero'); clear(col)
    def make():
        rig = build_hero_rig(); B = skeleton()
        _, P, F, Sh = hero_parts(key)
        rules = {}
        for o in P: rules[o.name] = skin_part(o, B)
        for o in F + Sh: skin_part(o, B, 'head')
        body = put(merge('HERO_Body', P), col); fc = put(merge('HERO_Face', F), col); sh = put(merge('HERO_Shine', Sh), col)
        body['arc_outline'] = HERO_OUTLINE; fc['arc_outline'] = 0.0; sh['arc_outline'] = 0.0
        for o in (body, fc, sh): bind_to(o, rig)
        outline(body, HERO_OUTLINE)
        return rig, (body, fc, sh)
    rig, meshes = guarded(make)
    return {'tris': tris(list(meshes)), 'bones': len(rig.data.bones), 'deform': sum(b.use_deform for b in rig.data.bones),
            'groups': len(meshes[0].vertex_groups), 'height': round(max((m.matrix_world @ v.co).z for m in meshes for v in m.data.vertices), 3)}

# ---------------------------------------------------------------- clips: FK from rest-axis rotations, a two-bone leg IK

HERO_FPS = 30

def rx(d): return Quaternion((1, 0, 0), math.radians(d))
def ry(d): return Quaternion((0, 1, 0), math.radians(d))
def rz(d): return Quaternion((0, 0, 1), math.radians(d))

class Pose:
    """One frame. local[bone]: a rotation about the bone's REST axes applied before its parent's (so an elbow bend stays
    an elbow bend wherever the upper arm points); world[bone]: an absolute rotation from rest in armature space (the
    leg IK writes these); hips: the Hips offset in metres."""
    def __init__(self): self.local = {}; self.world = {}; self.hips = Vector()
    def turn(self, bone, q):
        self.local[J(bone)] = q @ self.local.get(J(bone), Quaternion()); return self

def solve_pose(rig, P):
    """Armature-space posed matrices of every bone, then each bone's local pose matrix (what Blender keys)."""
    bones = sorted(rig.data.bones, key=lambda b: len(b.parent_recursive)); W, M, out = {}, {}, {}
    for b in bones:                                   # parents before their children
        R = b.matrix_local; Q = R.to_quaternion()
        if b.parent:
            Rp = b.parent.matrix_local; head = M[b.parent.name] @ (Rp.inverted() @ R.translation); Wp = W[b.parent.name]
        else:
            head = R.translation + P.hips; Wp = Quaternion()
        W[b.name] = P.world[b.name] if b.name in P.world else Wp @ P.local.get(b.name, Quaternion())
        M[b.name] = Matrix.Translation(head) @ (W[b.name] @ Q).to_matrix().to_4x4()
        base = (M[b.parent.name] @ b.parent.matrix_local.inverted() @ R) if b.parent else R
        out[b.name] = base.inverted() @ M[b.name]
    return out, M, W

def hip_joint(rig, P, S):
    """Where a hip joint is for this frame's Hips offset and rotation (before the leg IK)."""
    hb = rig.data.bones[J('Hips')]; up = rig.data.bones[J(f'{S}UpLeg')]
    Wh = P.world.get(J('Hips'), P.local.get(J('Hips'), Quaternion()))
    return hb.matrix_local.translation + P.hips + Wh @ (up.head_local - hb.head_local)

def leg_ik(rig, P, S, target, pitch=0.0, abd=0.0):
    """Two-bone leg IK in the leg's sagittal plane: put the ankle on `target` (armature space), the foot `pitch` degrees
    toe-down, the whole leg turned `abd` degrees outward. Relative to the rest leg, so the rest pose is exact."""
    bn = rig.data.bones; s = 1 if S == 'Left' else -1
    up, lo = bn[J(f'{S}UpLeg')], bn[J(f'{S}Leg')]
    L1, L2 = up.length, lo.length
    def angles(d):
        D = min(math.hypot(d.y, d.z), L1 + L2 - 1e-4)
        g = math.atan2(-d.y, -d.z)
        A = math.acos(max(-1.0, min(1.0, (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D))))
        C = math.acos(max(-1.0, min(1.0, (L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2))))
        return g, A, C
    g0, A0, C0 = angles(lo.tail_local - up.head_local)
    g, A, C = angles(Vector(target) - hip_joint(rig, P, S))
    a = math.degrees((g - g0) + (A - A0)); k = math.degrees(C0 - C)
    ab = ry(-s * abd)
    P.world[J(f'{S}UpLeg')] = ab @ rx(-a)
    P.world[J(f'{S}Leg')] = ab @ rx(-a + k)
    P.world[J(f'{S}Foot')] = rx(pitch)
    return a, k

def ankle_rest(rig, S): return rig.data.bones[J(f'{S}Foot')].head_local.copy()

def fingers(P, S, curl, thumb=10.0):
    """Curl every finger of one hand (degrees at the three joints) toward the palm."""
    s = 1 if S == 'Left' else -1
    for f in ('Index', 'Middle', 'Ring', 'Pinky'):
        for i, c in enumerate(curl): P.turn(f'{S}Hand{f}{i + 1}', ry(s * c))
    P.turn(f'{S}HandThumb1', rz(-s * thumb * 0.6)); P.turn(f'{S}HandThumb2', ry(s * thumb)); P.turn(f'{S}HandThumb3', ry(s * thumb))
    return P

def arms_down(P, S, down=72.0, fwd=6.0, elbow=14.0, out=0.0):
    """Hang an arm from the T-pose: lowered `down` degrees, swung `fwd` forward, `elbow` bent forward, `out` from the side."""
    s = 1 if S == 'Left' else -1
    P.turn(f'{S}Arm', rx(-fwd) @ ry(s * (down - out)))
    P.turn(f'{S}ForeArm', rz(-s * elbow))
    return P

def key_clip(rig, name, n, fn, loop=True):
    """Author one action: fn(f) -> Pose for f in 0..n; every bone keyed every frame, quaternions kept continuous."""
    old = bpy.data.actions.get(name)
    if old: bpy.data.actions.remove(old)
    act = bpy.data.actions.new(name); act.use_fake_user = True
    ad = rig.animation_data or rig.animation_data_create(); ad.action = act
    prev = {}
    for f in range(n + 1):
        L, _, _ = solve_pose(rig, fn(f))
        for b, m in L.items():
            pb = rig.pose.bones[b]; q = m.to_quaternion()
            if b in prev and prev[b].dot(q) < 0: q.negate()
            prev[b] = q; pb.rotation_quaternion = q; pb.keyframe_insert('rotation_quaternion', frame=f)
            if pb.parent is None: pb.location = m.translation; pb.keyframe_insert('location', frame=f)
    act.use_frame_range = True; act.frame_start = 0; act.frame_end = n
    act['loop'] = bool(loop)
    return act

def cyc(f, n, k=1, ph=0.0): return math.sin(2 * math.pi * (k * f / n + ph))

def ease_win(f, a, b):
    """0 before frame a, 1 after b, eased between."""
    return smooth01((f - a) / max(1e-6, b - a))

def ease_pulse(f, a, b, c, d): return ease_win(f, a, b) * (1 - ease_win(f, c, d))

def stance_base(rig, P, drop, abd=4.0):
    """Both feet planted where they stand at rest, the hips `drop` metres lower (soft knees), the legs a little apart."""
    P.hips += Vector((0, 0, -drop))
    for S in ('Left', 'Right'): leg_ik(rig, P, S, ankle_rest(rig, S), 0.0, abd)
    return P

def idle(rig, n=60):
    """Planted, ready, chest up: breathing through the chest and shoulders, a slow weight shift, hands half closed."""
    def fn(f):
        P = Pose(); b = cyc(f, n)
        P.hips = Vector((0.008 * b, 0, 0.003 * cyc(f, n, 2)))
        P.world[J('Hips')] = rz(1.2 * cyc(f, n, 1, 0.2)) @ ry(1.4 * b)
        stance_base(rig, P, 0.012)
        P.turn('Spine', ry(-0.8 * b)); P.turn('Spine1', rx(-0.8 * cyc(f, n, 2)))
        P.turn('Spine2', rx(-4.0 - 0.8 * cyc(f, n, 2)))              # chest up
        P.turn('Neck', rx(1.5)); P.turn('Head', rx(-3.0 + 1.0 * cyc(f, n, 1, 0.3)) @ rz(2.0 * cyc(f, n, 1, 0.6)))
        for S, s in (('Left', 1), ('Right', -1)):
            P.turn(f'{S}Shoulder', ry(-s * 1.2 * cyc(f, n, 2)))
            arms_down(P, S, 72 - 1.5 * cyc(f, n, 2), 6, 14 + 2 * cyc(f, n, 1, 0.1 * s))
            fingers(P, S, (26, 32, 20))
        return P
    return key_clip(rig, 'Hero_Idle', n, fn)

def hero_gait(rig, name, n, stride, stance, lift, drop, bob, lean, swing, elbow, curl, fly=0.0, arms=None):
    """A looping in-place gait. Each foot is on the ground for `stance` of the cycle, sliding back `stride` metres (the
    ground speed is stride / stance time), then swings forward `lift` high; the hips bob, the torso counter-rotates,
    the arms swing against the legs, or `arms(P, f)` holds them (a weapon carried at the chest)."""
    y0 = {S: ankle_rest(rig, S).y for S in ('Left', 'Right')}
    ball, heel = (BALL - ANKLE).length, 0.08         # toe-off pivots on the ball, heel-strike on the heel: nothing digs in
    def foot(S, ph):
        ph %= 1.0; a = ankle_rest(rig, S)
        if ph < stance:
            u = ph / stance; y = a.y - stride / 2 + stride * u
            pitch = -12 * (1 - smooth01(u / 0.18)) + 22 * smooth01((u - 0.72) / 0.28)
            z = a.z
        else:
            u = (ph - stance) / (1 - stance); y = a.y + stride / 2 - stride * smooth01(u)
            z = a.z + lift * math.sin(math.pi * u) ** 1.3
            pitch = 22 * (1 - smooth01(u / 0.4)) - 12 * smooth01((u - 0.7) / 0.3)
        sp = math.sin(math.radians(pitch))
        return Vector((a.x, y, z + ball * max(0.0, sp) + heel * max(0.0, -sp))), pitch
    def fn(f):
        P = Pose(); p = f / n
        P.hips = Vector((0.006 * cyc(f, n), 0, -drop - bob * math.cos(4 * math.pi * (p - fly))))
        P.world[J('Hips')] = rz(-5 * cyc(f, n, 1, 0.25)) @ ry(1.5 * cyc(f, n)) @ rx(lean * 0.3)
        for S, ph in (('Left', 0.0), ('Right', 0.5)):
            t, pitch = foot(S, p + ph); leg_ik(rig, P, S, t, pitch, 3.0)
        P.turn('Spine', rx(lean * 0.4)); P.turn('Spine1', rz(4 * cyc(f, n, 1, 0.25)) @ rx(lean * 0.3))
        P.turn('Spine2', rz(4 * cyc(f, n, 1, 0.25)) @ rx(lean * 0.3 - 2)); P.turn('Head', rx(-lean * 0.7))
        if arms: arms(P, f); return P
        for S, s in (('Left', 1), ('Right', -1)):
            c = math.cos(2 * math.pi * (p + (0.0 if S == 'Left' else 0.5)))      # +1: this side's arm swung back
            arms_down(P, S, 74, -swing * c, elbow + (elbow * 0.6) * max(0.0, -c), 4)
            fingers(P, S, curl)
        return P
    return key_clip(rig, name, n, fn)

def walk(rig): return hero_gait(rig, 'Hero_Walk', 28, 0.44, 0.6, 0.11, 0.035, 0.018, 4, 24, 14, (30, 36, 24))
def run(rig): return hero_gait(rig, 'Hero_Run', 18, 0.46, 0.36, 0.2, 0.06, 0.025, 12, 48, 80, (70, 80, 60), fly=0.175)

def jump(rig, n=32):
    """Crouch, spring, a tucked hang with the arms up and out, and a soft landing, all in place."""
    hz = [(0, 0.0), (6, -0.13), (10, 0.12), (15, 0.36), (20, 0.3), (25, 0.0), (27, -0.1), (32, 0.0)]
    def track(f, keys):
        for (f0, v0), (f1, v1) in zip(keys, keys[1:]):
            if f <= f1: return v0 + (v1 - v0) * smooth01((f - f0) / (f1 - f0))
        return keys[-1][1]
    def fn(f):
        P = Pose(); h = track(f, hz)
        tuck = 0.2 * ease_pulse(f, 11, 15, 19, 24)
        P.hips = Vector((0, 0, h))
        crouch = ease_pulse(f, 0, 6, 6, 10) + 0.8 * ease_pulse(f, 24, 27, 27, 32)
        P.world[J('Hips')] = rx(10 * crouch)
        for S in ('Left', 'Right'):
            a = ankle_rest(rig, S)
            z = a.z + max(0.0, h - 0.02) - tuck if h > 0.02 else a.z
            leg_ik(rig, P, S, Vector((a.x, a.y + 0.03 * tuck / 0.2, max(a.z, z))), 18 * ease_pulse(f, 8, 11, 20, 25), 4)
        P.turn('Spine1', rx(10 * crouch - 6 * ease_pulse(f, 9, 12, 18, 23))); P.turn('Head', rx(-8 * crouch))
        for S, s in (('Left', 1), ('Right', -1)):
            back = ease_pulse(f, 0, 6, 6, 9); upward = ease_pulse(f, 7, 12, 19, 25)
            arms_down(P, S, 72 - 40 * upward, -35 * back + 70 * upward, 14 + 25 * upward, 20 * upward)
            fingers(P, S, (40, 50, 30))
        return P
    return key_clip(rig, 'Hero_Jump', n, fn, loop=False)

def interact(rig, n=40):
    """Reach forward with the right hand, work something for a beat (a turn and a squeeze), and come back."""
    def fn(f):
        P = Pose(); r = ease_pulse(f, 4, 14, 28, 38); use = ease_pulse(f, 15, 19, 23, 27)
        stance_base(rig, P, 0.012 + 0.03 * r)
        P.world[J('Hips')] = rz(-6 * r)
        P.turn('Spine1', rx(6 * r)); P.turn('Spine2', rx(-3 + 4 * r) @ rz(-5 * r)); P.turn('Head', rx(12 * r) @ rz(-4 * r))
        arms_down(P, 'Left', 72, 6 + 8 * r, 14 + 10 * r)
        fingers(P, 'Left', (26, 32, 20))
        arms_down(P, 'Right', 72 - 22 * r, 6 + 62 * r, 14 + 18 * r - 6 * use)
        P.turn('RightHand', rx(-18 * use) @ ry(-8 * r))
        fingers(P, 'Right', tuple(c * (1 - r) + o * r for c, o in zip((26, 32, 20), (12 + 50 * use, 16 + 55 * use, 10 + 40 * use))))
        return P
    return key_clip(rig, 'Hero_Interact', n, fn, loop=False)

# ---------------------------------------------------------------- genre clips: third person, top-down, collect-a-thon

def arm_ik(rig, P, S, target, pole=(0, 0, -1)):
    """Two-bone arm IK: the wrist on `target` (armature space), the elbow bent toward `pole`, solved against this frame's
    hips, spine and shoulder so it composes with any gait. Writes the arm's and forearm's absolute rotations; the hand
    and fingers keep turning in the forearm's frame."""
    _, M, _ = solve_pose(rig, P)
    bn = rig.data.bones; up, lo = bn[J(f'{S}Arm')], bn[J(f'{S}ForeArm')]
    L1, L2 = up.length, lo.length
    sh = M[J(f'{S}Arm')].translation; d = Vector(target) - sh
    D = min(max(d.length, abs(L1 - L2) + 1e-3), L1 + L2 - 1e-4); dn = d.normalized()
    a = math.acos(max(-1.0, min(1.0, (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D))))
    pv = Vector(pole) - dn * Vector(pole).dot(dn); pv.normalize()
    elbow = sh + (dn * math.cos(a) + pv * math.sin(a)) * L1; wrist = sh + dn * D
    d1 = (elbow - sh).normalized(); e1 = (wrist - elbow).normalized()
    x0 = (up.tail_local - up.head_local).normalized(); n0 = x0.cross(Vector((0, -1, 0))).normalized()
    nb = d1.cross(e1)
    nb = nb.normalized() if nb.length > 1e-4 else d1.cross(Vector((0, -1, 0))).normalized()
    F = lambda x, n: Matrix((x, n.cross(x), n)).transposed()
    F0 = F(x0, n0)
    P.world[J(f'{S}Arm')] = (F(d1, nb) @ F0.transposed()).to_quaternion()
    P.world[J(f'{S}ForeArm')] = (F(e1, nb) @ F0.transposed()).to_quaternion()
    return wrist

# Where the arena's weapon is held (armature space, the hero facing -Y): the engine mounts the pack's world weapon with
# its grip at AIM_GRIP pointing forward, and the hands meet it there and under its fore-end.
AIM_GRIP = Vector((-0.1, -0.3, 1.1))
AIM_FORE = Vector((0.0, -0.52, 1.12))

def aim_arms(P, rig, f=0, n=1, sway=0.0):
    """Both hands on a weapon held level at the chest: the right on the grip, the left under the fore-end."""
    b = sway * cyc(f, n)
    P.turn('RightShoulder', rz(-6)); P.turn('LeftShoulder', rz(4))
    arm_ik(rig, P, 'Right', AIM_GRIP + Vector((0, 0, b)), pole=(-0.6, 0.4, -1))
    arm_ik(rig, P, 'Left', AIM_FORE + Vector((0, 0, b)), pole=(0.8, 0.2, -1))
    P.turn('RightHand', rx(-10) @ ry(35)); P.turn('LeftHand', ry(-70) @ rx(-10))
    fingers(P, 'Right', (62, 72, 50), 34); fingers(P, 'Left', (38, 46, 30), 18)
    return P

def aim_idle(rig, n=40):
    """The arena's stand: squared up behind the weapon, knees soft, breathing through the chest."""
    def fn(f):
        P = Pose(); b = cyc(f, n)
        P.hips = Vector((0.004 * b, 0, -0.01 + 0.004 * cyc(f, n, 2)))
        P.world[J('Hips')] = rz(-8)
        stance_base(rig, P, 0.03, 7.0)
        P.turn('Spine1', rz(5) @ rx(2)); P.turn('Spine2', rx(-2 - 0.8 * cyc(f, n, 2)) @ rz(3))
        P.turn('Neck', rz(2)); P.turn('Head', rx(-2) @ rz(1.5 * cyc(f, n, 1, 0.4)))
        return aim_arms(P, rig, f, n, 0.004)
    return key_clip(rig, 'Hero_AimIdle', n, fn)

def aim_run(rig):
    """The run's legs under a steady carry: the weapon stays level while the hips bob."""
    return hero_gait(rig, 'Hero_AimRun', 18, 0.46, 0.36, 0.18, 0.06, 0.02, 9, 0, 0, (0, 0, 0), fly=0.175,
                     arms=lambda P, f: aim_arms(P, rig, f, 18, 0.006))

def keyed(f, keys):
    """A value eased between (frame, value) keys: the track of one channel of a hand-timed move."""
    for (f0, v0), (f1, v1) in zip(keys, keys[1:]):
        if f <= f1: return v0 + (v1 - v0) * smooth01((f - f0) / (f1 - f0))
    return keys[-1][1]

def attack(rig, n=16):
    """The staff swing (the third-person genre's strike): from a low guard, wound up over the right shoulder by frame 4, a
    flat sweep across the body through frames 4-8 (the melee lands at 0.14 s), a follow-through, and back to the guard.
    In place, with a short lunge onto the left foot."""
    def fn(f):
        P = Pose(); k = keyed(f, [(0, 0), (4, 0.5), (8, 1), (11, 1), (16, 0)])
        P.hips = Vector((0, -0.05 * k, -0.03 - 0.05 * k))
        P.world[J('Hips')] = rz(keyed(f, [(0, 0), (4, -12), (8, 18), (11, 18), (16, 0)]))
        for S, fwd in (('Left', 0.15), ('Right', -0.12)):
            a = ankle_rest(rig, S); leg_ik(rig, P, S, Vector((a.x, a.y - fwd * k, a.z)), 0.0, 5.0)
        P.turn('Spine1', rz(keyed(f, [(0, 0), (4, -20), (8, 22), (11, 24), (16, 0)])) @ rx(6 * k))
        P.turn('Spine2', rz(keyed(f, [(0, 0), (4, -12), (8, 16), (16, 0)])))
        P.turn('Head', rz(keyed(f, [(0, 0), (4, 12), (8, -16), (16, 0)])))
        # the striking arm: its elevation off the T-pose (up +) and its sweep about the vertical (forward +)
        elev = keyed(f, [(0, -62), (4, 30), (6, 12), (8, -8), (11, -14), (16, -62)])
        sweep = keyed(f, [(0, 22), (4, -45), (6, 35), (8, 105), (11, 115), (16, 22)])
        P.turn('RightArm', rz(sweep) @ ry(elev))
        P.turn('RightForeArm', rz(keyed(f, [(0, 25), (4, 95), (6, 45), (8, 12), (11, 18), (16, 25)])))
        P.turn('RightHand', rx(keyed(f, [(0, 0), (4, -30), (8, 12), (16, 0)])))
        fingers(P, 'Right', (72, 82, 64), 42)
        # the free arm counters the swing
        arms_down(P, 'Left', keyed(f, [(0, 66), (4, 50), (8, 62), (16, 66)]), keyed(f, [(0, 10), (4, 38), (8, -22), (16, 10)]), 40)
        fingers(P, 'Left', (40, 50, 30))
        return P
    return key_clip(rig, 'Hero_Attack', n, fn, loop=False)

def hit(rig, n=12):
    """A flinch: the chest thrown back, the hands flying up, and recovered by the end."""
    def fn(f):
        P = Pose(); h = ease_pulse(f, 0, 2, 4, 12)
        stance_base(rig, P, 0.012 + 0.05 * h)
        P.hips += Vector((0, 0.06 * h, 0)); P.world[J('Hips')] = rx(-6 * h)
        P.turn('Spine1', rx(-10 * h)); P.turn('Spine2', rx(-8 * h)); P.turn('Head', rx(-14 * h) @ rz(6 * h))
        for S in ('Left', 'Right'):
            arms_down(P, S, 72 - 30 * h, 6 + 20 * h, 14 + 50 * h, 10 * h)
            fingers(P, S, (10, 12, 8))
        return P
    return key_clip(rig, 'Hero_Hit', n, fn, loop=False)

def death(rig, n=36):
    """Knees give, a stagger back, and down flat on the back with the arms flung out; it holds the last frame."""
    hip0 = rig.data.bones[J('Hips')].head_local.z
    def fn(f):
        P = Pose(); give = ease_win(f, 0, 8); fall = ease_win(f, 7, 20) ** 1.6; land = ease_pulse(f, 19, 21, 22, 28)
        lie = fall
        P.hips = Vector((0, 0.08 * give + 0.4 * lie, -0.12 * give - (hip0 - 0.17 - 0.12) * lie + 0.03 * land))
        P.world[J('Hips')] = rx(-10 * give - 74 * lie)
        if lie < 0.02:
            for S in ('Left', 'Right'): leg_ik(rig, P, S, ankle_rest(rig, S), 0.0, 5.0)
        for S, s in (('Left', 1), ('Right', -1)):
            P.turn(f'{S}UpLeg', rx(18 * give - 8 * lie) @ ry(-s * 6 * lie)); P.turn(f'{S}Leg', rx(-30 * give + 18 * lie))
            arms_down(P, S, 72 - 58 * lie, 10 * give - 30 * lie, 20 + 10 * lie, 0)
            fingers(P, S, (18, 22, 14))
        P.turn('Spine1', rx(6 * give - 4 * lie)); P.turn('Head', rx(-6 * give - 12 * lie) @ rz(18 * lie))
        return P
    return key_clip(rig, 'Hero_Death', n, fn, loop=False)

def cheer(rig, n=40):
    """Level clear: a hop with both fists thrown up, twice, landing soft."""
    def fn(f):
        P = Pose(); hop = max(0.0, math.sin(2 * math.pi * f / (n / 2))) * (1 - ease_win(f, 30, 40))
        up = ease_win(f, 0, 5) * (1 - ease_win(f, 34, 40))
        P.hips = Vector((0, 0, 0.08 * hop - 0.03 * (1 - hop) * up))
        for S in ('Left', 'Right'):
            a = ankle_rest(rig, S); leg_ik(rig, P, S, Vector((a.x, a.y, a.z + max(0.0, 0.08 * hop - 0.01))), 12 * hop, 5.0)
        P.turn('Spine2', rx(-8 * up)); P.turn('Head', rx(-12 * up))
        for S, s in (('Left', 1), ('Right', -1)):
            arms_down(P, S, 72 - 126 * up, 0, 8 * up + 10 * hop, 0)
            fingers(P, S, (80, 90, 70), 40)
        return P
    return key_clip(rig, 'Hero_Cheer', n, fn, loop=False)

CLIPS = (('Hero_Idle', idle), ('Hero_Walk', walk), ('Hero_Run', run), ('Hero_Jump', jump), ('Hero_Interact', interact),
         ('Hero_Attack', attack), ('Hero_AimIdle', aim_idle), ('Hero_AimRun', aim_run), ('Hero_Hit', hit), ('Hero_Death', death),
         ('Hero_Cheer', cheer))

def clips(rig=None):
    rig = rig or bpy.data.objects['Hero']
    out = {name: fn(rig).frame_range[1] for name, fn in CLIPS}
    rig.animation_data.action = bpy.data.actions['Hero_Idle']
    return out

# ---------------------------------------------------------------- review: snapshots of the posed hero, one render each

def snapshot(name, action, frame, place, yaw=0.0, col=None):
    """A static copy of the posed Body/Face/Shine (outline shells included), turned `yaw` degrees and placed at `place`."""
    rig = bpy.data.objects['Hero']; rig.animation_data.action = bpy.data.actions[action]
    bpy.context.scene.frame_set(int(frame)); bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get(); made = []
    T = Matrix.Translation(place) @ Matrix.Rotation(math.radians(yaw), 4, 'Z')
    for src in ('HERO_Body', 'HERO_Face', 'HERO_Shine'):
        ob = bpy.data.objects[src]; me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        me.transform(T @ ob.matrix_world)
        c = bpy.data.objects.new(f'{name}_{src[5:]}', me); (col or coll('ARC_HeroReview')).objects.link(c); made.append(c)
    return made

def review_stage(objs, target, direction, dist, lens=50):
    """Hide the live hero and the blockouts, contact-shade the lawn under the snapshots, aim the review camera."""
    for c in ('ARC_Hero', 'ARC_HeroBlockout'):
        if bpy.data.collections.get(c): bpy.data.collections[c].hide_render = True
    ground_contact([o for o in objs if o.name.endswith('_Body')])
    return camera(target, direction, dist, lens=lens, collection=coll('ARC_HeroStage'), name='ARC_HeroReviewCam')

def review_hero(path=REVIEW_DIR + '/arcade-hero-final.png', res=(1200, 700), samples=16):
    """The refined hero in the first frame of the idle, three-quarter front, filling the frame."""
    col = coll('ARC_HeroReview'); clear(col)
    objs = snapshot('final', 'Hero_Idle', 0, (0, 0, 0), col=col)
    review_stage(objs, (0, 0, 1.02), (0.45, -1.0, 0.3), 5.6)
    return render(path, res, samples)

def turntable(path=REVIEW_DIR + '/arcade-hero-turntable.png', res=(1200, 700), samples=16):
    """Front, three-quarter, side and back in one frame."""
    col = coll('ARC_HeroReview'); clear(col); objs = []
    for i, yaw in enumerate((0, 45, 90, 180)):
        objs += snapshot(f'turn{i}', 'Hero_Idle', 0, ((i - 1.5) * 1.25, 0, 0), yaw, col)
    review_stage(objs, (0, 0, 1.0), (0.0, -1.0, 0.22), 7.4)
    return render(path, res, samples)

SHEET = {'Hero_Idle': (0, 30), 'Hero_Walk': (0, 7, 14), 'Hero_Run': (0, 4, 9), 'Hero_Jump': (6, 15, 27), 'Hero_Interact': (10, 20)}
GENRE_SHEET = {'Hero_Attack': (0, 4, 7, 11), 'Hero_AimIdle': (0,), 'Hero_AimRun': (0, 5, 9), 'Hero_Hit': (3,), 'Hero_Death': (8, 16, 35),
               'Hero_Cheer': (9, 30)}

def contact_sheet(path=REVIEW_DIR + '/arcade-hero-clips.png', res=(1200, 700), samples=16, sheet=SHEET):
    """Key frames of every clip left to right, one render: idle (2), walk (3), run (3), jump (3), interact (2); with
    sheet=GENRE_SHEET the genre clips."""
    col = coll('ARC_HeroReview'); clear(col); objs = []; x = 0.0
    for act, frames in sheet.items():
        for f in frames:
            objs += snapshot(f'{act[5:]}{f}', act, f, (x, 0, 0), 62, col); x += 0.8
        x += 0.3
    x -= 1.1
    for o in objs: o.data.transform(Matrix.Translation((-x / 2, 0, 0)))
    review_stage(objs, (0, 0, 1.0), (0.0, -1.0, 0.25), 17.0, lens=50)
    return render(path, res, samples)

# ---------------------------------------------------------------- ship: the GLB, its measurement and the catalog card

def glb_measure(path):
    """The engine's measurement (tools/build/inspect-pack.mjs inspectGlb): node transforms applied to every primitive's
    accessor box, plus skins, joints and clips, and the catalog revision (sha256, 12 hex)."""
    import json, struct
    data = open(path, 'rb').read(); n = struct.unpack_from('<I', data, 12)[0]; j = json.loads(data[20:20 + n])
    lo, hi = [1e9] * 3, [-1e9] * 3
    def trs(nd):
        if 'matrix' in nd: return Matrix([nd['matrix'][i::4] for i in range(4)])
        t = Matrix.Translation(nd.get('translation', (0, 0, 0))); x, y, z, w = nd.get('rotation', (0, 0, 0, 1))
        sc = nd.get('scale', (1, 1, 1))
        return t @ Quaternion((w, x, y, z)).to_matrix().to_4x4() @ Matrix.Diagonal((*sc, 1))
    def visit(i, parent):
        nd = j['nodes'][i]; world = parent @ trs(nd)
        if 'mesh' in nd:
            for prim in j['meshes'][nd['mesh']]['primitives']:
                acc = j['accessors'][prim['attributes']['POSITION']]
                for c in range(8):
                    p = world @ Vector([(acc['max'] if c >> k & 1 else acc['min'])[k] for k in range(3)])
                    for k in range(3): lo[k] = min(lo[k], p[k]); hi[k] = max(hi[k], p[k])
        for ch in nd.get('children', []): visit(ch, world)
    for r in j['scenes'][j.get('scene', 0)]['nodes']: visit(r, Matrix.Identity(4))
    size = [round(hi[k] - lo[k], 4) for k in range(3)]
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'revision': hashlib.sha256(data).hexdigest()[:12],
            'longest': max(size), 'size': size, 'skins': len(j.get('skins', [])),
            'joints': sum(len(sk['joints']) for sk in j.get('skins', [])), 'clips': len(j.get('animations', [])),
            'clip_names': [a['name'] for a in j.get('animations', [])],
            'nodes': sorted(nd['name'] for nd in j['nodes'] if 'mesh' in nd)}

def grip_socket(rig, col):
    """Grip_R: an empty on the right hand bone, in the closed fist (between the wrist and the middle knuckle, below the
    palm), its axes the armature's at rest. A held thing modelled standing on its grip with its shaft along Y (gear.py's
    staff) hangs off it with no offset of its own."""
    old = bpy.data.objects.get('Grip_R')
    if old: bpy.data.objects.remove(old, do_unlink=True)
    bn = rig.data.bones; hand, knuckle = bn[J('RightHand')], bn[J('RightHandMiddle1')]
    at = hand.head_local.lerp(knuckle.head_local, 0.62) + Vector((0, 0, -0.035))
    e = bpy.data.objects.new('Grip_R', None); e.empty_display_size = 0.05; col.objects.link(e)
    e.parent = rig; e.parent_type = 'BONE'; e.parent_bone = J('RightHand')
    # A bone child hangs off the bone's TAIL: placed from the rest bone, never the current pose.
    e.matrix_parent_inverse = Matrix.Identity(4)
    e.matrix_basis = Matrix.Translation((0, -hand.length, 0)) @ hand.matrix_local.inverted() @ Matrix.Translation(at)
    return e

def export_hero(path=HERO_OUT):
    """Body/Face/Shine without their outline shells, skinned to the rig, and every Hero_ clip as its own animation."""
    rig = bpy.data.objects['Hero']; tmp = coll('ARC_Export'); made = []
    for src, node in (('HERO_Body', 'Body'), ('HERO_Face', 'Face'), ('HERO_Shine', 'Shine')):
        o = bpy.data.objects[src]
        clash = bpy.data.objects.get(node)
        if clash: bpy.data.objects.remove(clash, do_unlink=True)
        c = o.copy(); c.data = o.data.copy(); c.name = node; c.data.name = node
        for m in list(c.modifiers):
            if m.type != 'ARMATURE': c.modifiers.remove(m)
        if 'hero_skin' in c: del c['hero_skin']                              # a build tag, not engine data
        for a in [a for a in c.data.color_attributes if a.name != GRAD]: c.data.color_attributes.remove(a)
        i = c.data.materials.find('ARC_Outline')
        if i >= 0: c.data.materials.pop(index=i)
        tmp.objects.link(c); c.parent = rig; made.append(c)
    made.append(grip_socket(rig, tmp))
    ad = rig.animation_data; keep = ad.action
    for tr in list(ad.nla_tracks): ad.nla_tracks.remove(tr)
    for name, _ in CLIPS:
        a = bpy.data.actions[name]; tr = ad.nla_tracks.new(); tr.name = name; tr.strips.new(name, 0, a)
    ad.action = None
    sc = bpy.context.scene; sc.render.fps = HERO_FPS; sc.render.fps_base = 1.0      # a new file starts at 24
    os.makedirs(os.path.dirname(path), exist_ok=True)
    gltf_mode(True)
    try:
        vl = bpy.context.view_layer
        for o in vl.objects: o.select_set(False)
        for o in [rig] + made: o.hide_set(False); o.select_set(True)
        vl.objects.active = rig
        with bpy.context.temp_override(active_object=rig, selected_objects=[rig] + made):
            bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
                                      export_extras=True, export_animations=True, export_animation_mode='NLA_TRACKS',
                                      export_force_sampling=True, export_frame_step=1, export_optimize_animation_size=True,
                                      export_def_bones=False, export_skins=True, export_materials='EXPORT', export_nla_strips=True)
    finally:
        gltf_mode(False)
        for tr in list(ad.nla_tracks): ad.nla_tracks.remove(tr)
        ad.action = keep
        for o in made:
            me = o.data; bpy.data.objects.remove(o, do_unlink=True)
            if me is not None and me.users == 0: bpy.data.meshes.remove(me)
    return glb_measure(path)

def hero_card(out=CARD_OUT):
    """The 256 px catalog card: the idle's first frame on the studio's dark-slate ground (hero_corner.thumbnails)."""
    col = coll('ARC_HeroReview'); clear(col)
    objs = snapshot('card', 'Hero_Idle', 0, (0, 0, 0), 0, col)
    return thumbnails(out, thumbs={'hero': ([o.name for o in objs], True)})
