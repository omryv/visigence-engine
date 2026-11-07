"""Arcade landmark parts library: the windmill, the watermill, the well, two market stalls, the lookout tower and the
farm plot that the landmark grammar (src/world/worldLandmarks.js) places on the village's hills, brook, square and
fringe. Every part has a `.lite` twin at a fraction of the triangles for phones and the performance tier; the
windmill's sails and the waterwheel are MOVING nodes, children of their part, hinged on their own origin.

exec after vg.py, kit.py, nature.py and hero_corner.py (same globals):
    g['build_landmark_parts']()   every part into the LMK_Parts collection (hidden; the preview copies from it)
    g['review_landmarks']()       one light review render, every landmark in a row (assets/v2/arcade/arcade-landmarks-sheet.png)
    g['ship_landmark_parts']()    assets/v2/arcade/arcade-landmark-parts.glb + src/world/landmarkParts.js (the index)

Contract with the engine (render/LandmarkAssembler.js) and the preview (landmark_preview.py):
  - One top-level glTF node per part, named by its id ('stall.a'; GLTFLoader keeps it in userData.name), standing on
    its origin at game scale, its front toward -Y here (+Z in glTF, the yaw the compiler gives it). Extras:
    arc_outline (metres). A child node named 'Sails' or 'Wheel' with extras.arc_spin {axis, rate, wind?} is a moving
    part: the engine turns it about that axis of its own frame (glTF axes: the sails' axle runs along the front, z;
    the wheel's axle out to the right, x). The waterwheel's height is overridden by the grammar (`wheel.y`).
  - Materials are the kit's ARC_ ones (toon-swapped by the engine) or colour SLOTS named LMK_<Slot>: the stalls'
    awning (LMK_Awning, white x the gradient) takes the landmark's colour; the farm's soil and crops (LMK_Soil,
    LMK_Crop) keep the colour authored here.
"""
import bpy, bmesh, math, random, json
from mathutils import Vector, Matrix

PARTS_COLL_L = 'LMK_Parts'
PARTS_GLB_L = OUT + '/arcade/arcade-landmark-parts.glb'
PARTS_INDEX_L = globals().get('REPO', ROOT) + '/src/world/landmarkParts.js'
LANDMARKS_SHEET = OUT + '/arcade/arcade-landmarks-sheet.png'
LSLOTS = {'LMK_Awning': ('#ffffff', {}), 'LMK_Soil': ('#8f5f40', {'shade': '#a58aa8'}), 'LMK_Crop': ('#86c85a', {'shade': '#9bb6cc'})}
LPARTS, LPART_ORDER = {}, []
SPIN = {'Sails': {'axis': 'z', 'rate': 0.55, 'wind': True}, 'Wheel': {'axis': 'x', 'rate': 0.9}}


def lpart(pid):
    def reg(fn):
        LPARTS[pid] = fn; LPART_ORDER.append(pid); return fn
    return reg


def _lm():
    """The kit's ARC_ materials plus the landmark colour slots, keyed without their prefix."""
    M = {m.name[4:]: m for m in bpy.data.materials if m.name.startswith('ARC_')}
    if 'Wood' not in M: M = materials(); set_look()
    for name, (hex_, kw) in LSLOTS.items():
        M[name[4:]] = bpy.data.materials.get(name) or toon(name, hex_, **kw)
    return M


def _tone(objs, k=1.0, bottom=(0.74, 0.7, 0.8)):
    vgrad(objs, tuple(c * k for c in bottom), (k, k, k), local=True)


def _merge(name, objs):
    objs = [o for o in objs if o is not None]
    ensure_grad(objs)
    return merge(name, objs) if len(objs) > 1 else objs[0]


def lfinish(pid, objs, outline=0.03, moving=()):
    """The still pieces merged into one object named by the part id, standing on its origin; each moving group
    merged into its own child, its mesh re-based on `origin` (the hinge) and parented to the part."""
    ob = _merge(pid, objs)
    ob.name = pid; ob.data.name = pid; ob['arc_outline'] = outline
    for name, parts, origin in moving:
        ch = _merge(name, parts); ch.name = name; ch.data.name = '%s.%s' % (pid, name)
        ch.data.transform(Matrix.Translation(-Vector(origin))); ch.location = origin
        ch.parent = ob; ch.matrix_parent_inverse = Matrix.Identity(4)
        ch['arc_outline'] = outline; ch['arc_spin'] = SPIN[name]
    return ob

# ---------------------------------------------------------------- windmill

def _windmill(pid, lite):
    M = _lm(); segs = 8 if lite else 12; P = []
    plinth = lathe('wm_plinth', [(0, -0.05), (2.35, -0.05), (2.35, 0.35), (2.15, 0.55), (0, 0.55)], axis='Z', segs=8, mat=M['Stone'])
    tower = lathe('wm_tower', [(0, 0.5), (2.05, 0.5), (1.95, 0.7), (1.6, 4.3), (1.5, 4.45), (0, 4.45)], axis='Z', segs=8, mat=M['Plaster'])
    xform(plinth, rot=[('Z', math.pi / 8)]); xform(tower, rot=[('Z', math.pi / 8)])
    cap = lathe('wm_cap', [(1.75, 4.35), (1.9, 4.65), (1.55, 5.35), (0.95, 6.0), (0.3, 6.55), (0, 6.75)], axis='Z', segs=segs, mat=M['Roof'])
    P += [plinth, tower, cap]
    if not lite:
        for o in (plinth, tower): chunky(o, 0.05)
        chunky(cap, 0.06)
        # A walkway ring at the cap's foot, a door and two windows on the front, a rear window.
        P.append(lathe('wm_ring', [(1.55, 4.25), (1.95, 4.25), (1.95, 4.42), (1.55, 4.42)], axis='Z', segs=8, mat=M['WoodDark']))
        P.append(prism('wm_door', arch_pts(0.95, 1.75, 0.0, 0.0), -2.25, -1.7, axis='Y', mat=M['WoodDark']))
        P.append(rbox('wm_step', (1.3, 0.5, 0.18), (0, -2.35, 0.09), M['Stone'], 0.03))
        for z in (2.3, 3.5): P.append(rbox('wm_win', (0.55, 0.3, 0.7), (0, -1.75 if z < 3 else -1.6, z), M['SkyBlue'], 0.02))
        P.append(rbox('wm_win_b', (0.55, 0.3, 0.7), (0, 1.55, 3.0), M['SkyBlue'], 0.02))
    P.append(rbox('wm_axle_box', (0.7, 0.8, 0.7), (0, -1.95, 5.15), M['WoodDark'], 0.04))
    P.append(cyl('wm_axle', 0.11, -1.7, -2.75, axis='Y', segs=8, mat=M['Iron'], center=(0, 0, 5.15)))
    _tone(P)
    # The sails: a hub and four arms in the XZ plane at the axle's end, each carrying a canvas panel and its lattice.
    hub = (0.0, -2.75, 5.15); S = []
    S.append(cyl('sail_hub', 0.3, -0.18, 0.18, axis='Y', segs=8 if lite else 12, mat=M['WoodDark'], center=hub))
    for k in range(4):
        # each arm is built pointing up from the hub, then swung about the axle (Y) into its quarter
        swing = Matrix.Translation(hub) @ Matrix.Rotation(k * math.pi / 2, 4, 'Y'); pieces = []
        pieces.append(box('sail_arm', (0.15, 0.15, 3.0), (0, 0, 1.6), M['WoodDark']))
        pieces.append(box('sail_panel', (0.6, 0.05, 2.3), (0.36, 0.02, 1.85), M['Petal']))
        if not lite:
            for zz in (0.95, 1.5, 2.05, 2.6): pieces.append(box('sail_bar', (0.66, 0.08, 0.06), (0.36, -0.02, zz), M['WoodDark']))
        for o in pieces: o.data.transform(swing)
        S += pieces
    _tone(S, 0.98)
    return lfinish(pid, P, 0.035, moving=[('Sails', S, hub)])


@lpart('windmill')
def _wm(): return _windmill('windmill', False)
@lpart('windmill.lite')
def _wml(): return _windmill('windmill.lite', True)

# ---------------------------------------------------------------- watermill

def _watermill(pid, lite):
    # The grammar's box: hw (2.0) along the front (Blender Y, the flow), hd (1.5) toward the brook (Blender +X, the
    # wheel's side); the ridge runs along the flow.
    M = _lm(); P = []; hw, hd, H = 2.0, 1.5, 3.1
    body = rbox('mill_body', (hd * 2, hw * 2, H), (0, 0, H / 2), M['Plaster'], 0.04 if not lite else 0.0); P.append(body)
    for sx in (-1, 1):
        for sy in (-1, 1): P.append(box('mill_post', (0.2, 0.2, H), (sx * (hd - 0.05), sy * (hw - 0.05), H / 2), M['WoodDark']))
    for sx in (-1, 1): P.append(box('mill_beam', (0.2, hw * 2 + 0.1, 0.2), (sx * (hd - 0.05), 0, H - 0.1), M['WoodDark']))
    if not lite:
        for sy in (-1, 1): P.append(box('mill_beam_s', (hd * 2 + 0.1, 0.2, 0.2), (0, sy * (hw - 0.05), 1.5), M['WoodDark']))
        P.append(prism('mill_door', arch_pts(0.9, 1.7, -0.5, 0.0), -hw - 0.12, -hw + 0.2, axis='Y', mat=M['WoodDark']))
        P.append(rbox('mill_win', (0.6, 0.3, 0.7), (0.7, -hw, 2.0), M['SkyBlue'], 0.02))
        P.append(rbox('mill_win2', (0.3, 0.6, 0.7), (-hd, 0.6, 2.0), M['SkyBlue'], 0.02))
        P.append(rbox('mill_chimney', (0.45, 0.45, 1.4), (-0.7, 1.2, H + 0.9), M['Stone'], 0.03))
    roof = prism('mill_roof', [(-hd - 0.45, H - 0.05), (hd + 0.45, H - 0.05), (0, H + 1.55)], -hw - 0.35, hw + 0.35, axis='Y', mat=M['Roof']); P.append(roof)
    if not lite: chunky(roof, 0.05)
    P.append(box('mill_ridge', (0.22, hw * 2 + 0.8, 0.14), (0, 0, H + 1.55), M['WoodDark']))
    # The axle out of the right wall, a bearing post and a flume sloping over the wheel.
    P.append(cyl('mill_axle', 0.1, hd - 0.1, 2.45, axis='X', segs=8, mat=M['Iron'], center=(0, 0, 1.05)))
    P.append(box('mill_bearing', (0.25, 0.25, 1.15), (2.42, 0.55, 0.575), M['WoodDark']))
    P.append(box('mill_flume', (1.2, 0.5, 0.22), (2.35, 0.0, 2.55), M['WoodDark'], ('Y', math.radians(-18))))
    _tone(P)
    # The wheel in the channel: two rims, paddles between them, spokes to the hub.
    n = 8 if lite else 12; c = (2.05, 0.0, 1.05); Wh = []
    for r in (1.25, 1.05): Wh.append(lathe('wheel_rim', [(r, -0.24), (r, 0.24)], axis='X', segs=n, mat=M['WoodDark'], center=c, cap=False))
    for k in range(n):
        # a paddle built at the top of the wheel, then turned about the axle (X) into its slot
        pad = box('wheel_paddle', (0.5, 0.46, 0.07), (0, 0, 1.15), M['Wood']); pad.data.transform(Matrix.Translation(c) @ Matrix.Rotation(2 * math.pi * k / n, 4, 'X')); Wh.append(pad)
    for k in range(2 if lite else 4):
        sp = box('wheel_spoke', (0.44, 0.08, 2.2), (0, 0, 0), M['WoodDark']); sp.data.transform(Matrix.Translation(c) @ Matrix.Rotation(k * math.pi / (2 if lite else 4), 4, 'X')); Wh.append(sp)
    Wh.append(cyl('wheel_hub', 0.18, -0.3, 0.3, axis='X', segs=8, mat=M['Iron'], center=c))
    _tone(Wh, 0.95)
    return lfinish(pid, P, 0.035, moving=[('Wheel', Wh, c)])


@lpart('watermill')
def _mill(): return _watermill('watermill', False)
@lpart('watermill.lite')
def _milll(): return _watermill('watermill.lite', True)

# ---------------------------------------------------------------- well

def _well(pid, lite):
    M = _lm(); segs = 8 if lite else 12; P = []
    ring = lathe('well_ring', [(0.72, 0.0), (0.98, 0.0), (0.98, 0.85), (0.9, 0.95), (0.72, 0.95), (0.72, 0.1)], axis='Z', segs=segs, mat=M['Stone']); P.append(ring)
    if not lite: chunky(ring, 0.04)
    for sx in (-1, 1): P.append(box('well_post', (0.14, 0.14, 2.15), (sx * 0.86, 0, 1.07), M['WoodDark']))
    P.append(prism('well_roof', [(-0.95, 1.95), (0.95, 1.95), (0, 2.6)], -1.2, 1.2, axis='X', mat=M['Roof']))
    P.append(cyl('well_windlass', 0.1, -0.9, 0.9, axis='X', segs=segs, mat=M['WoodDark'], center=(0, 0, 1.8)))
    if not lite:
        P.append(box('well_crank', (0.08, 0.08, 0.36), (1.0, 0, 1.62), M['Iron']))
        P.append(box('well_crank2', (0.28, 0.08, 0.08), (1.1, 0, 1.44), M['Iron']))
        P.append(cyl('well_rope', 0.02, 1.05, 1.8, axis='Z', segs=6, mat=M['Sand'], center=(0, 0, 0)))
        P.append(lathe('well_bucket', [(0.13, 0.72), (0.19, 1.05), (0.15, 1.05), (0.15, 0.76), (0, 0.76)], axis='Z', segs=8, mat=M['WoodDark']))
    _tone(P)
    return lfinish(pid, P, 0.03)


@lpart('well')
def _wl(): return _well('well', False)
@lpart('well.lite')
def _wll(): return _well('well.lite', True)

# ---------------------------------------------------------------- market stalls

def _stall(pid, variant, lite):
    M = _lm(); P = []; rnd = random.Random(7 + variant)
    counter = rbox('stall_counter', (2.3, 0.85, 0.95), (0, 0.1, 0.475), M['Wood'], 0.04 if not lite else 0.0); P.append(counter)
    P.append(box('stall_top', (2.45, 1.0, 0.08), (0, 0.1, 0.98), M['WoodDark']))
    for sx in (-1, 1):
        for sy in (-1, 1): P.append(box('stall_post', (0.1, 0.1, 2.3), (sx * 1.12, sy * 0.5 + 0.05, 1.15), M['WoodDark']))
    awning = box('stall_awning', (2.6, 1.45, 0.06), (0, -0.05, 2.38), M['Awning'], ('X', math.radians(-14))); P.append(awning)
    if not lite:
        for k in range(6): P.append(box('stall_scallop', (0.4, 0.06, 0.2), (-1.05 + k * 0.42, -0.7, 2.12), M['Awning']))
        if variant == 0:
            P.append(rbox('stall_crate', (0.55, 0.45, 0.35), (-0.7, 0.05, 1.2), M['WoodDark'], 0.02))
            for i, (mat, x, y) in enumerate((('CoralPink', 0.25, 0.0), ('ButterYellow', 0.62, 0.15), ('Mint', 0.45, -0.22), ('CoralPink', -0.68, 0.1))):
                P.append(blob('stall_fruit', (x, y, 1.02 + (0.36 if i == 3 else 0) + 0.15), 0.15, M[mat], subd=2, jitter=0.03, seed=i))
        else:
            for x in (-0.6, 0.55): P.append(lathe('stall_basket', [(0.2, 1.02), (0.27, 1.3), (0.22, 1.3), (0.16, 1.06), (0, 1.06)], axis='Z', segs=8, mat=M['Wood'], center=(x, 0.05, 0)))
            for i, x in enumerate((-0.6, 0.55)): P.append(blob('stall_loaf', (x, 0.05, 1.32), 0.14, M['Sand'], subd=2, jitter=0.05, seed=3 + i))
            P.append(box('stall_sign', (0.7, 0.05, 0.3), (0, -0.55, 1.75), M['Plaster']))
    _tone(P)
    return lfinish(pid, P, 0.03)


@lpart('stall.a')
def _sa(): return _stall('stall.a', 0, False)
@lpart('stall.a.lite')
def _sal(): return _stall('stall.a.lite', 0, True)
@lpart('stall.b')
def _sb(): return _stall('stall.b', 1, False)
@lpart('stall.b.lite')
def _sbl(): return _stall('stall.b.lite', 1, True)

# ---------------------------------------------------------------- lookout

def _lookout(pid, lite):
    M = _lm(); P = []; top = 4.4; s0, s1 = 0.95, 0.6
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for cx, cy in corners: P.append(strut('lk_leg', (cx * s0, cy * s0, 0.0), (cx * s1, cy * s1, top), 0.22, 0.22, M['WoodDark']))
    for z in ((1.6, 3.1) if not lite else (2.4,)):
        t = z / top; s = s0 + (s1 - s0) * t
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            P.append(strut('lk_brace', (a[0] * s, a[1] * s, z), (b[0] * s, b[1] * s, z), 0.12, 0.1, M['Wood']))
    P.append(rbox('lk_deck', (1.95, 1.95, 0.16), (0, 0, top + 0.08), M['Wood'], 0.03 if not lite else 0.0))
    for cx, cy in corners: P.append(box('lk_rail_post', (0.09, 0.09, 1.0), (cx * 0.9, cy * 0.9, top + 0.66), M['WoodDark']))
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        P.append(strut('lk_rail', (a[0] * 0.9, a[1] * 0.9, top + 1.05), (b[0] * 0.9, b[1] * 0.9, top + 1.05), 0.07, 0.07, M['WoodDark']))
    for cx, cy in corners: P.append(box('lk_roof_post', (0.09, 0.09, 1.0), (cx * 0.9, cy * 0.9, top + 1.7), M['WoodDark']))
    roof = lathe('lk_roof', [(1.5, top + 2.1), (1.55, top + 2.25), (0.06, top + 3.1)], axis='Z', segs=4, mat=M['Roof']); xform(roof, rot=[('Z', math.pi / 4)]); P.append(roof)
    if not lite:
        for sx in (-1, 1): P.append(box('lk_ladder_rail', (0.07, 0.07, top + 0.2), (sx * 0.26, -1.05, (top + 0.2) / 2), M['WoodDark']))
        for k in range(8): P.append(box('lk_rung', (0.56, 0.06, 0.06), (0, -1.05, 0.45 + k * 0.52), M['Wood']))
        P.append(box('lk_flag_pole', (0.05, 0.05, 1.1), (0, 0, top + 3.5), M['Iron']))
        P.append(box('lk_flag', (0.6, 0.03, 0.35), (0.32, 0, top + 3.85), M['CoralPink']))
    _tone(P)
    return lfinish(pid, P, 0.03)


@lpart('lookout')
def _lk(): return _lookout('lookout', False)
@lpart('lookout.lite')
def _lkl(): return _lookout('lookout.lite', True)

# ---------------------------------------------------------------- farm plot

def _farm(pid, lite):
    M = _lm(); P = []; rnd = random.Random(11)
    for k in range(5):
        y = -1.6 + k * 0.8
        P.append(rbox('farm_ridge', (5.4, 0.5, 0.22), (0, y, 0.1), M['Soil'], 0.05 if not lite else 0.0))
        if not lite and k % 2 == 0:
            for j in range(7):
                x = -2.4 + j * 0.8 + rnd.uniform(-0.08, 0.08); h = rnd.uniform(0.32, 0.46)
                P.append(lathe('farm_crop', [(0.16, 0.2), (0.06, 0.2 + h * 0.8), (0, 0.2 + h)], axis='Z', segs=5, mat=M['Crop'], center=(x, y, 0)))
    # A scarecrow at the back corner: post, crossbar, a sackcloth body, a straw head and a hat.
    sx, sy = 2.35, 1.95
    P.append(box('farm_post', (0.1, 0.1, 1.9), (sx, sy, 0.95), M['WoodDark']))
    P.append(box('farm_cross', (1.2, 0.1, 0.1), (sx, sy, 1.45), M['WoodDark']))
    P.append(rbox('farm_body', (0.5, 0.32, 0.6), (sx, sy, 1.2), M['Plaster'], 0.03 if not lite else 0.0))
    P.append(blob('farm_head', (sx, sy, 1.85), 0.2, M['ButterYellow'], subd=2, jitter=0.05, seed=5))
    P.append(lathe('farm_hat', [(0.32, 1.96), (0.32, 2.0), (0.19, 2.0), (0.16, 2.24), (0, 2.24)], axis='Z', segs=8, mat=M['WoodDark'], center=(sx, sy, 0)))
    if not lite:
        P.append(cyl('farm_bird', 0.07, 0, 0.12, axis='Z', segs=6, mat=M['StoneDark'], center=(sx - 0.5, sy, 1.5)))
    _tone(P, 1.0, (0.8, 0.76, 0.84))
    return lfinish(pid, P, 0.025)


@lpart('farm.plot')
def _fp(): return _farm('farm.plot', False)
@lpart('farm.plot.lite')
def _fpl(): return _farm('farm.plot.lite', True)

# ---------------------------------------------------------------- build, review, ship

def _remove(ob):
    me = ob.data if ob.type == 'MESH' else None
    bpy.data.objects.remove(ob, do_unlink=True)
    if me and me.users == 0: bpy.data.meshes.remove(me)


def build_landmark_parts():
    """Every part (and its moving children) into LMK_Parts; an earlier build's objects go first."""
    _lm()
    C = bpy.data.collections.get(PARTS_COLL_L) or bpy.data.collections.new(PARTS_COLL_L)
    if C.name not in bpy.data.scenes['Scene'].collection.children: bpy.data.scenes['Scene'].collection.children.link(C)
    for o in [o for o in C.objects if o.parent is not None] + [o for o in C.objects if o.parent is None]: _remove(o)
    stale = [o for o in bpy.data.objects if o.name in LPART_ORDER or o.name in ('Sails', 'Wheel') or o.name.startswith(('Sails.', 'Wheel.'))]
    for o in stale: _remove(o)
    info = {}
    for pid in LPART_ORDER:
        ob = LPARTS[pid]()
        for o in [ob] + list(ob.children):
            for u in list(o.users_collection): u.objects.unlink(o)
            C.objects.link(o)
        info[pid] = tris([ob] + list(ob.children))
    C.hide_render = True; C.hide_viewport = True
    return {'parts': len(info), 'tris': sum(info.values()), 'each': info}


def landmark_parts_index():
    C = bpy.data.collections[PARTS_COLL_L]; idx = {}
    for pid in LPART_ORDER:
        o = C.objects[pid]; objs = [o] + list(o.children)
        foot = 0.0; top = 0.0
        for ob in objs:
            base = ob.matrix_parent_inverse @ ob.matrix_basis if ob.parent else Matrix.Identity(4)
            for v in ob.data.vertices:
                w = base @ v.co; foot = max(foot, math.hypot(w.x, w.y)); top = max(top, w.z)
        e = {'foot': round(foot, 3), 'top': round(top, 3), 'tris': tris(objs)}
        if o.children: e['spin'] = {ch.name.split('.')[0]: dict(SPIN[ch.name.split('.')[0]]) for ch in o.children}
        idx[pid] = e
    return idx


def _copy_part(src, C, M=None):
    """A part and its children copied into C; children keep their local frame (matrix_parent_inverse @ basis)."""
    c = src.copy(); C.objects.link(c); out = [c]
    for ch in src.children:
        cc = ch.copy(); C.objects.link(cc); cc.parent = c
        cc.matrix_parent_inverse = ch.matrix_parent_inverse.copy(); cc.matrix_basis = ch.matrix_basis.copy(); out.append(cc)
    if M is not None: c.matrix_world = M
    return out


def review_landmarks(path=LANDMARKS_SHEET, res=(1600, 700), samples=16, gap=5.6, dist=52.0):
    """Every landmark in a row on the review set (the sails and the wheel turned a little), one light render."""
    C = bpy.data.collections[PARTS_COLL_L]; sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    tmp = bpy.data.collections.get('LMK_Review') or bpy.data.collections.new('LMK_Review')
    if tmp.name not in sc.collection.children: sc.collection.children.link(tmp)
    for o in list(tmp.objects): bpy.data.objects.remove(o, do_unlink=True)
    side = Vector((0.8, 0.6, 0.0)); order = ['lookout', 'stall.a', 'well', 'windmill', 'watermill', 'stall.b', 'farm.plot']; n = len(order)
    for i, pid in enumerate(order):
        M = Matrix.Translation(LINEUP + side * (i - (n - 1) / 2) * gap) @ Matrix.Rotation(FACE, 4, 'Z')
        for c in _copy_part(C.objects[pid], tmp, M):
            if c.parent and c.name.startswith('Sails'): c.rotation_euler = (0, math.radians(20), 0)
            if c.parent and c.name.startswith('Wheel'): c.rotation_euler = (math.radians(12), 0, 0)
            if c.get('arc_outline', 0) > 0: outline(c, c['arc_outline'])
    cam = bpy.data.objects.get('ARC_LandmarkCam') or bpy.data.objects.new('ARC_LandmarkCam', bpy.data.cameras.new('ARC_LandmarkCam'))
    if cam.name not in tmp.objects: tmp.objects.link(cam)
    t = LINEUP + Vector((0, 0, 2.4)); d = Vector((0.6, -0.8, 0.5)).normalized()
    cam.location = t + d * dist; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 38; cam.data.clip_start = 0.1; cam.data.clip_end = 1000; sc.camera = cam
    hide = tuple(x for x in ('ARC_Gameplay', 'ARC_Weapons', 'ARC_Critters', 'ARC_Creatures', 'ARC_Houses') if bpy.data.collections.get(x))
    try: return render_review(path, res, samples, hide=hide)
    finally:
        sc.camera = keep
        for o in [o for o in tmp.objects if o.parent is not None] + [o for o in tmp.objects if o.parent is None]:
            if o.type != 'CAMERA': bpy.data.objects.remove(o, do_unlink=True)


def cards_landmarks(out=OUT + '/arcade/catalog'):
    """The catalog card 'landmark': the windmill with the well and a stall at its foot."""
    C = bpy.data.collections[PARTS_COLL_L]; tmp = bpy.data.collections.get('LMK_Card') or bpy.data.collections.new('LMK_Card')
    if tmp.name not in bpy.context.scene.collection.children: bpy.context.scene.collection.children.link(tmp)
    for o in list(tmp.objects): bpy.data.objects.remove(o, do_unlink=True)
    names = []
    for pid, off, yaw in (('windmill', (0, 1.5, 0), 0.0), ('well', (-2.9, -2.4, 0), 0.4), ('stall.a', (3.0, -2.2, 0), -0.5)):
        for c in _copy_part(C.objects[pid], tmp, Matrix.Translation(Vector(off)) @ Matrix.Rotation(yaw, 4, 'Z')): names.append(c.name)
    try: return thumbnails(out=out, thumbs={'landmark': (names, True)})
    finally:
        for o in [o for o in tmp.objects if o.parent is not None] + [o for o in tmp.objects if o.parent is None]: bpy.data.objects.remove(o, do_unlink=True)


def ship_landmark_parts(path=PARTS_GLB_L, index=PARTS_INDEX_L):
    C = bpy.data.collections[PARTS_COLL_L]
    objs = [o for o in C.objects if o.parent is None] + [o for o in C.objects if o.parent is not None]
    gltf_mode(True)
    try:
        C.hide_viewport = False
        bpy.context.view_layer.update()
        size = export_glb(objs, path)
    finally:
        gltf_mode(False); C.hide_viewport = True
    idx = landmark_parts_index()
    with open(index, 'w') as f:
        f.write('// Generated by tools/blender/v2/arcade/landmark_parts.py (ship_landmark_parts): the landmark parts library\n'
                '// index - every part id with its footprint radius (metres), its height and triangle count, and the moving nodes it\n'
                '// carries (`spin`: axis and rate). The landmark rules are validated against it; the budgets test sums it per tier.\n'
                'export const LANDMARK_PARTS = ' + json.dumps(idx, indent=1, sort_keys=True) + ';\n')
    return {'kb': round(size / 1024, 1), 'parts': len(idx), 'tris': tris(objs), 'each': {k: v['tris'] for k, v in idx.items()}}
