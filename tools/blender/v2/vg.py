"""Visigames v2 asset library: hard-surface modeling, wear materials, PBR baking, GLB export.

Run inside Blender (via the Claude Bridge): exec(open(ROOT + '/tools/blender/v2/vg.py').read(), g)
Conventions: metres, Blender Z up, weapons point down Blender +Y (glTF -Z), characters face -Y (glTF +Z).
"""
import bpy, bmesh, math, os
import numpy as np
from mathutils import Vector, Matrix

ROOT = '/Users/omrydamari/Documents/shooter-engine-main'
OUT = ROOT + '/assets/v2'
SRC = ROOT + '/assets/v2/source'

# ---------------------------------------------------------------- scene

def reset():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves,
                 bpy.data.cameras, bpy.data.lights, bpy.data.node_groups):
        for d in list(coll):
            if d.users == 0 or coll is not bpy.data.node_groups:
                try: coll.remove(d)
                except Exception: pass
    for c in list(bpy.context.scene.collection.children):
        bpy.context.scene.collection.children.unlink(c)
    bpy.context.scene.frame_set(1)

def gpu():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    cp = bpy.context.preferences.addons['cycles'].preferences
    cp.compute_device_type = 'METAL'
    cp.get_devices()
    for d in cp.devices: d.use = True
    sc.cycles.device = 'GPU'

def coll(name):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    return c

def new_obj(name, bm, mat=None, collection=None):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    if mat: me.materials.append(mat)
    return ob

# ---------------------------------------------------------------- 2D helpers

def fillet(pts, r, n=4):
    """Round the corners of a closed 2D polygon. r: float or per-corner list (0 = sharp)."""
    rs = r if isinstance(r, (list, tuple)) else [r] * len(pts)
    out = []
    N = len(pts)
    for i in range(N):
        p = Vector(pts[i]); a = Vector(pts[i - 1]); b = Vector(pts[(i + 1) % N])
        ri = rs[i]
        if ri <= 0:
            out.append((p.x, p.y)); continue
        da = (a - p); db = (b - p)
        la, lb = da.length, db.length
        da.normalize(); db.normalize()
        ang = da.angle(db) if la and lb else 0
        if ang < 1e-3 or ang > math.pi - 1e-3:
            out.append((p.x, p.y)); continue
        t = min(ri / math.tan(ang / 2), la * 0.49, lb * 0.49)
        p1 = p + da * t; p2 = p + db * t
        bis = (da + db).normalized()
        c = p + bis * (t / math.cos(ang / 2)) if math.cos(ang / 2) else p
        a1 = math.atan2(p1.y - c.y, p1.x - c.x); a2 = math.atan2(p2.y - c.y, p2.x - c.x)
        d = a2 - a1
        while d > math.pi: d -= 2 * math.pi
        while d < -math.pi: d += 2 * math.pi
        rad = (p1 - c).length
        for k in range(n + 1):
            aa = a1 + d * k / n
            out.append((c.x + math.cos(aa) * rad, c.y + math.sin(aa) * rad))
    return out

def rrect(w, h, r, cx=0, cy=0, n=4):
    return fillet([(cx - w/2, cy - h/2), (cx + w/2, cy - h/2), (cx + w/2, cy + h/2), (cx - w/2, cy + h/2)], r, n)

def circle(r, n=24, cx=0, cy=0):
    return [(cx + math.cos(2*math.pi*i/n)*r, cy + math.sin(2*math.pi*i/n)*r) for i in range(n)]

# ---------------------------------------------------------------- 3D primitives

def _to3(axis, u, v, w):
    # profile coordinates (u,v) in the plane orthogonal to `axis`, w along axis
    if axis == 'X': return (w, u, v)     # side profile: u=Y, v=Z
    if axis == 'Y': return (u, w, v)     # cross-section: u=X, v=Z
    return (u, v, w)                     # plan: u=X, v=Y

def prism(name, pts, a0, a1, axis='X', mat=None, taper=None):
    """Extrude a closed 2D polygon from a0 to a1 along axis. taper: scale of the far cap (about its centroid)."""
    bm = bmesh.new()
    cu = sum(p[0] for p in pts) / len(pts); cv = sum(p[1] for p in pts) / len(pts)
    ring0 = [bm.verts.new(_to3(axis, u, v, a0)) for u, v in pts]
    s = taper or 1.0
    ring1 = [bm.verts.new(_to3(axis, cu + (u - cu) * s, cv + (v - cv) * s, a1)) for u, v in pts]
    n = len(pts)
    for i in range(n):
        bm.faces.new((ring0[i], ring0[(i+1) % n], ring1[(i+1) % n], ring1[i]))
    bm.faces.new(list(reversed(ring0))); bm.faces.new(ring1)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, mat)

def lathe(name, prof, axis='Y', segs=32, mat=None, center=(0, 0, 0), cap=True):
    """prof: list of (radius, along) from one end to the other. Revolved around axis through center."""
    bm = bmesh.new()
    rings = []
    for r, a in prof:
        ring = []
        for k in range(segs):
            t = 2 * math.pi * k / segs
            u, v = math.cos(t) * r, math.sin(t) * r
            if axis == 'Y': co = (u, a, v)
            elif axis == 'X': co = (a, u, v)
            else: co = (u, v, a)
            ring.append(bm.verts.new(Vector(co) + Vector(center)))
        rings.append(ring)
    for j in range(len(rings) - 1):
        A, B = rings[j], rings[j+1]
        for k in range(segs):
            bm.faces.new((A[k], A[(k+1) % segs], B[(k+1) % segs], B[k]))
    if cap:
        if prof[0][0] > 1e-6: bm.faces.new(list(reversed(rings[0])))
        if prof[-1][0] > 1e-6: bm.faces.new(rings[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, mat)

def loft(name, stations, segs=32, mat=None, axis='Y', cap=True):
    """Organic sweep: stations (along, top, bottom, half_width[, power[, x_off]]) become superellipse rings.
    power 2 = ellipse, higher = boxier. Good for stocks, grips, forends and magazines."""
    bm = bmesh.new(); rings = []
    for st in stations:
        a, zt, zb, hw = st[:4]; pw = st[4] if len(st) > 4 else 2.6; xo = st[5] if len(st) > 5 else 0.0
        zc, hz = (zt + zb) / 2, (zt - zb) / 2; e = 2.0 / pw; ring = []
        for k in range(segs):
            t = 2 * math.pi * k / segs; c, s_ = math.cos(t), math.sin(t)
            x = xo + hw * math.copysign(abs(c) ** e, c); z = zc + hz * math.copysign(abs(s_) ** e, s_)
            # axis 'Z': stations run downward; 'top/bottom' become front/back along Y
            ring.append(bm.verts.new((x, a, z) if axis == 'Y' else (x, z, a) if axis == 'Z' else (a, x, z)))
        rings.append(ring)
    for j in range(len(rings) - 1):
        A, B = rings[j], rings[j + 1]
        for k in range(segs):
            bm.faces.new((A[k], A[(k + 1) % segs], B[(k + 1) % segs], B[k]))
    if cap:
        bm.faces.new(list(reversed(rings[0]))); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_obj(name, bm, mat)
    ob.data.shade_smooth()
    return ob

def cyl(name, r, a0, a1, axis='Y', segs=24, mat=None, center=(0, 0, 0), r2=None):
    return lathe(name, [(r, a0), (r2 if r2 is not None else r, a1)], axis, segs, mat, center)

def box(name, size, loc=(0, 0, 0), mat=None, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    if rot: bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rot[1], 3, rot[0]))
    bmesh.ops.translate(bm, vec=loc, verts=bm.verts)
    return new_obj(name, bm, mat)

def boxes(name, specs, mat=None):
    """Many boxes in one object (cutters, rail teeth). specs: [(size, loc)] or [(size, loc, (axis, angle))]."""
    bm = bmesh.new()
    for s in specs:
        size, loc = s[0], s[1]
        g = bmesh.ops.create_cube(bm, size=1.0)['verts']
        bmesh.ops.scale(bm, vec=size, verts=g)
        if len(s) > 2 and s[2]: bmesh.ops.rotate(bm, verts=g, cent=(0, 0, 0), matrix=Matrix.Rotation(s[2][1], 3, s[2][0]))
        bmesh.ops.translate(bm, vec=loc, verts=g)
    return new_obj(name, bm, mat)

def merge(name, objs):
    """Join objects into one, keeping materials and custom (weighted) normals."""
    objs = [o for o in objs if o.type == 'MESH']
    base = objs[0]
    for o in objs:
        if o.data.users > 1: o.data = o.data.copy()
    with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    base.name = name; base.data.name = name
    return base

def text_mesh(name, body, size, matrix, extrude=0.001, font=None):
    """Text as a mesh object. matrix: world matrix mapping text X (reading dir), Y (up), Z (out of surface)."""
    cu = bpy.data.curves.new(name, 'FONT'); cu.body = body; cu.size = size; cu.extrude = extrude
    cu.align_x = 'CENTER'; cu.align_y = 'CENTER'
    if font: cu.font = bpy.data.fonts.load(font, check_existing=True)
    to = bpy.data.objects.new(name + '_c', cu); bpy.context.scene.collection.objects.link(to)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(to.evaluated_get(dg))
    bpy.data.objects.remove(to, do_unlink=True); bpy.data.curves.remove(cu)
    me.transform(matrix)
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob

def side_matrix(side, loc, tilt=0.0):
    """Matrix for text lying on a +X or -X facing surface, readable from that side (Z up)."""
    if side < 0: cols = ((0, -1, 0), (0, 0, 1), (-1, 0, 0))
    else: cols = ((0, 1, 0), (0, 0, 1), (1, 0, 0))
    m = Matrix((cols[0], cols[1], cols[2])).transposed().to_4x4()
    return Matrix.Translation(loc) @ Matrix.Rotation(tilt, 4, 'X') @ m

# ---------------------------------------------------------------- modifiers

def apply_mods(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    if old.users == 0: bpy.data.meshes.remove(old)
    return ob

def cut(ob, *cutters, keep=False, op='DIFFERENCE'):
    for c in cutters:
        m = ob.modifiers.new('cut', 'BOOLEAN')
        m.operation = op; m.object = c; m.solver = 'EXACT'
        try: m.material_mode = 'INDEX'
        except Exception: pass
        before = ob.data.copy(); n0 = len(before.vertices)
        apply_mods(ob)
        # guard: a failed boolean can collapse the mesh; keep the uncut part instead
        if op == 'DIFFERENCE' and len(ob.data.vertices) < n0 * 0.5:
            print(f'WARNING cut {c.name} collapsed {ob.name} ({n0} -> {len(ob.data.vertices)} verts); reverted')
            bad = ob.data; ob.data = before; bpy.data.meshes.remove(bad)
        else:
            bpy.data.meshes.remove(before)
        if not keep: bpy.data.objects.remove(c, do_unlink=True)
    _clean_slots(ob)
    return ob

def _clean_slots(ob):
    me = ob.data
    good = [i for i, m in enumerate(me.materials) if m is not None]
    if len(good) == len(me.materials) or not good: return
    remap = {i: good.index(i) if i in good else 0 for i in range(len(me.materials))}
    idx = [0] * len(me.polygons); me.polygons.foreach_get('material_index', idx)
    mats = [me.materials[i] for i in good]
    me.materials.clear()
    for m in mats: me.materials.append(m)
    me.polygons.foreach_set('material_index', [remap.get(i, 0) for i in idx])
    me.update()

def bevel(ob, width=0.0012, segs=2, angle=35, harden=False):
    m = ob.modifiers.new('bevel', 'BEVEL')
    m.width = width; m.segments = segs; m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle); m.harden_normals = harden
    m.miter_outer = 'MITER_ARC'; m.profile = 0.6
    apply_mods(ob)
    return ob

def smooth(ob, angle=40, weighted=True):
    me = ob.data
    me.shade_smooth()
    try: me.set_sharp_from_angle(angle=math.radians(angle))
    except Exception: pass
    if weighted:
        m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); m.keep_sharp = True; m.weight = 60
        apply_mods(ob)
    return ob

def finish(ob, width=0.0012, segs=2, angle=35):
    """Standard hard-surface finish: angle-limited bevel + smooth + weighted normals."""
    if width > 0: bevel(ob, width, segs, angle)
    return smooth(ob, angle + 5)

def xform(ob, loc=None, rot=None, scale=None):
    if scale: ob.data.transform(Matrix.Diagonal((*scale, 1)) if len(scale) == 3 else Matrix.Scale(scale, 4))
    if rot:
        for axis, ang in rot: ob.data.transform(Matrix.Rotation(ang, 4, axis))
    if loc: ob.data.transform(Matrix.Translation(loc))
    ob.data.update()
    return ob

def mirror_x(ob):
    """Duplicate mesh mirrored across X=0 into the same object."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    geom = bmesh.ops.duplicate(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:])['geom']
    vs = [g for g in geom if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.scale(bm, vec=(-1, 1, 1), verts=vs)
    fs = [g for g in geom if isinstance(g, bmesh.types.BMFace)]
    bmesh.ops.reverse_faces(bm, faces=fs)
    bm.to_mesh(ob.data); bm.free(); ob.data.update()
    return ob

# ---------------------------------------------------------------- materials

def _n(nt, kind, loc=(0, 0), **props):
    n = nt.nodes.new(kind); n.location = loc
    for k, v in props.items(): setattr(n, k, v)
    return n

def _link(nt, a, b): nt.links.new(a, b)

def _math(nt, op, a, b=None, clamp=False):
    n = _n(nt, 'ShaderNodeMath', operation=op, use_clamp=clamp)
    for i, x in enumerate((a, b)):
        if x is None: continue
        if isinstance(x, (int, float)): n.inputs[i].default_value = x
        else: _link(nt, x, n.inputs[i])
    return n.outputs[0]

def _mixc(nt, fac, a, b):
    n = _n(nt, 'ShaderNodeMix', data_type='RGBA')
    for sock, x in ((n.inputs[0], fac), (n.inputs[6], a), (n.inputs[7], b)):
        if isinstance(x, (int, float)): sock.default_value = x
        elif isinstance(x, (tuple, list)): sock.default_value = (*x[:3], 1) if len(x) == 3 else x
        else: _link(nt, x, sock)
    return n.outputs[2]

def _mapr(nt, x, a, b, c=0.0, d=1.0):
    n = _n(nt, 'ShaderNodeMapRange', clamp=True)
    _link(nt, x, n.inputs[0]); n.inputs[1].default_value = a; n.inputs[2].default_value = b
    n.inputs[3].default_value = c; n.inputs[4].default_value = d
    return n.outputs[0]

def pbr(name, base, metal=0.0, rough=0.5, *, rough_var=0.08, wear=0.0, wear_col=(0.5, 0.5, 0.5),
        wear_metal=1.0, wear_rough=0.3, edge=0.0025, dirt=0.35, dirt_col=(0.05, 0.045, 0.035),
        bump=0.0, bump_scale=900.0, grain=0.0, grain_scale=(1, 1, 40), scale=60.0, emit=None, emit_strength=0.0,
        coat=0.0, streaks=0.0, rust=0.0, rust_col=(0.16, 0.06, 0.025)):
    """Layered procedural PBR: base, roughness breakup, edge wear, cavity dirt, streaks, rust, micro bump.
    Designed to be baked; key signals are exposed as named nodes VG_METAL for the metal bake."""
    mat = bpy.data.materials.get(name)
    if mat: bpy.data.materials.remove(mat)
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = _n(nt, 'ShaderNodeOutputMaterial', (1400, 0))
    bsdf = _n(nt, 'ShaderNodeBsdfPrincipled', (1100, 0))
    _link(nt, bsdf.outputs[0], out.inputs[0])
    tc = _n(nt, 'ShaderNodeTexCoord', (-1400, 0))
    obj = tc.outputs['Object']
    fine = _n(nt, 'ShaderNodeTexNoise', (-1100, 200)); fine.inputs['Scale'].default_value = scale; fine.inputs['Detail'].default_value = 8
    _link(nt, obj, fine.inputs['Vector'])
    big = _n(nt, 'ShaderNodeTexNoise', (-1100, -100)); big.inputs['Scale'].default_value = scale / 9; big.inputs['Detail'].default_value = 4
    _link(nt, obj, big.inputs['Vector'])
    # edge mask from bevel normal vs true normal
    bev = _n(nt, 'ShaderNodeBevel', (-1100, -400)); bev.inputs['Radius'].default_value = edge; bev.samples = 8
    geo = _n(nt, 'ShaderNodeNewGeometry', (-1100, -600))
    dot = _n(nt, 'ShaderNodeVectorMath', (-900, -450), operation='DOT_PRODUCT')
    _link(nt, bev.outputs[0], dot.inputs[0]); _link(nt, geo.outputs['Normal'], dot.inputs[1])
    edgem = _mapr(nt, dot.outputs['Value'], 0.985, 0.90)
    breakup = _mapr(nt, big.outputs['Fac'], 0.38, 0.62)
    wearm = _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', edgem, breakup, True), wear * 1.6, True)
    # cavity dirt from AO
    ao = _n(nt, 'ShaderNodeAmbientOcclusion', (-1100, -800), samples=12, only_local=True)
    ao.inputs['Distance'].default_value = 0.012
    cav = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', 1.0, ao.outputs['AO']), dirt * 1.5, True)
    # base color
    fine_tint = _mapr(nt, fine.outputs['Fac'], 0.3, 0.7, 0.9, 1.08)
    col = _n(nt, 'ShaderNodeRGB', (-700, 400)); col.outputs[0].default_value = (*base, 1)
    basec = _n(nt, 'ShaderNodeVectorMath', (-500, 400), operation='SCALE')
    _link(nt, col.outputs[0], basec.inputs[0]); _link(nt, fine_tint, basec.inputs['Scale'])
    c = basec.outputs[0]
    if grain:
        gt = _n(nt, 'ShaderNodeMapping', (-1100, 500)); gt.inputs['Scale'].default_value = grain_scale
        _link(nt, obj, gt.inputs['Vector'])
        wave = _n(nt, 'ShaderNodeTexWave', (-900, 500)); wave.inputs['Scale'].default_value = scale * 0.6
        wave.inputs['Distortion'].default_value = 6; wave.inputs['Detail'].default_value = 6
        _link(nt, gt.outputs[0], wave.inputs['Vector'])
        c = _mixc(nt, _math(nt, 'MULTIPLY', wave.outputs['Fac'], grain), c, tuple(x * 0.55 for x in base))
    if streaks:
        sm = _n(nt, 'ShaderNodeMapping', (-1100, 700)); sm.inputs['Scale'].default_value = (14, 14, 0.6)
        _link(nt, obj, sm.inputs['Vector'])
        sn = _n(nt, 'ShaderNodeTexNoise', (-900, 700)); sn.inputs['Scale'].default_value = scale / 6; sn.inputs['Detail'].default_value = 6
        _link(nt, sm.outputs[0], sn.inputs['Vector'])
        c = _mixc(nt, _math(nt, 'MULTIPLY', _mapr(nt, sn.outputs['Fac'], 0.45, 0.7), streaks), c, dirt_col)
    if rust:
        rn = _n(nt, 'ShaderNodeTexNoise', (-900, 900)); rn.inputs['Scale'].default_value = scale / 4; rn.inputs['Detail'].default_value = 10
        _link(nt, obj, rn.inputs['Vector'])
        rustm = _math(nt, 'MAXIMUM', _math(nt, 'MULTIPLY', cav, 1.4), _mapr(nt, rn.outputs['Fac'], 0.62, 0.72))
        rustm = _math(nt, 'MULTIPLY', rustm, rust, True)
        c = _mixc(nt, rustm, c, rust_col)
    c = _mixc(nt, cav, c, dirt_col)
    c = _mixc(nt, wearm, c, wear_col)
    _link(nt, c, bsdf.inputs['Base Color'])
    # roughness
    r = _math(nt, 'ADD', rough - rough_var, _math(nt, 'MULTIPLY', fine.outputs['Fac'], rough_var * 2))
    r = _math(nt, 'ADD', r, _math(nt, 'MULTIPLY', cav, 0.25))
    if rust: r = _math(nt, 'ADD', r, _math(nt, 'MULTIPLY', rustm, 0.35))
    rn2 = _n(nt, 'ShaderNodeMix', data_type='FLOAT'); _link(nt, wearm, rn2.inputs[0]); _link(nt, r, rn2.inputs[2]); rn2.inputs[3].default_value = wear_rough
    rclamp = _math(nt, 'MINIMUM', _math(nt, 'MAXIMUM', rn2.outputs[0], 0.04), 1.0)
    _link(nt, rclamp, bsdf.inputs['Roughness'])
    # metal
    mn = _n(nt, 'ShaderNodeMix', (700, -200), data_type='FLOAT'); mn.name = 'VG_METAL'
    _link(nt, wearm, mn.inputs[0]); mn.inputs[2].default_value = metal; mn.inputs[3].default_value = wear_metal if wear else metal
    if rust:
        mr = _n(nt, 'ShaderNodeMix', data_type='FLOAT'); _link(nt, rustm, mr.inputs[0]); _link(nt, mn.outputs[0], mr.inputs[2]); mr.inputs[3].default_value = 0.0
        mout = mr.outputs[0]; mr.name = 'VG_METAL'; mn.name = 'VG_METAL_PRE'
    else:
        mout = mn.outputs[0]
    _link(nt, mout, bsdf.inputs['Metallic'])
    # normal: small bevel rounding + micro bump
    bev2 = _n(nt, 'ShaderNodeBevel', (600, -500)); bev2.inputs['Radius'].default_value = 0.0007; bev2.samples = 8
    nrm = bev2.outputs[0]
    if bump:
        bn = _n(nt, 'ShaderNodeTexNoise', (400, -700)); bn.inputs['Scale'].default_value = bump_scale; bn.inputs['Detail'].default_value = 2
        _link(nt, obj, bn.inputs['Vector'])
        bp = _n(nt, 'ShaderNodeBump', (800, -600)); bp.inputs['Strength'].default_value = bump; bp.inputs['Distance'].default_value = 0.0004
        _link(nt, bn.outputs['Fac'], bp.inputs['Height']); _link(nt, nrm, bp.inputs['Normal']); nrm = bp.outputs[0]
    _link(nt, nrm, bsdf.inputs['Normal'])
    if coat: bsdf.inputs['Coat Weight'].default_value = coat
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1); bsdf.inputs['Emission Strength'].default_value = emit_strength
    return mat

def glass(name, tint=(0.6, 0.8, 0.7), alpha=0.25, emit=None, strength=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt = mat.node_tree; b = nt.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*tint, 1); b.inputs['Roughness'].default_value = 0.05
    b.inputs['Metallic'].default_value = 0.0; b.inputs['Alpha'].default_value = alpha
    if emit: b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = strength
    mat.surface_render_method = 'BLENDED'
    return mat

def emissive(name, color, strength=4.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    b = mat.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Emission Color'].default_value = (*color, 1)
    b.inputs['Emission Strength'].default_value = strength; b.inputs['Roughness'].default_value = 0.3
    return mat

# ---------------------------------------------------------------- UV + bake

def _ctx(ob):
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    ob.select_set(True); vl.objects.active = ob
    return bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob], selected_editable_objects=[ob])

def unwrap(ob, angle=62, margin=0.004):
    with _ctx(ob):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0, scale_to_bounds=False)
        try: bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method='CONCAVE')
        except TypeError: bpy.ops.uv.pack_islands(rotate=True, margin=margin)
        bpy.ops.object.mode_set(mode='OBJECT')

def _img(name, size, color=False):
    im = bpy.data.images.get(name)
    if im: bpy.data.images.remove(im)
    im = bpy.data.images.new(name, size, size, alpha=False, float_buffer=not color)
    im.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    return im

def _target(ob, img):
    for m in ob.data.materials:
        nt = m.node_tree
        n = nt.nodes.get('VG_BAKE') or nt.nodes.new('ShaderNodeTexImage')
        n.name = 'VG_BAKE'; n.image = img; n.select = True; nt.nodes.active = n

def _bake(ob, kind, img, samples=64, margin=12, **kw):
    sc = bpy.context.scene; sc.cycles.samples = samples
    sc.render.bake.margin = margin; sc.render.bake.use_clear = True
    _target(ob, img)
    with _ctx(ob):
        bpy.ops.object.bake(type=kind, margin=margin, use_clear=True, **kw)

def _metal_swap(ob, on):
    for m in ob.data.materials:
        nt = m.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        if on:
            src = nt.nodes.get('VG_METAL')
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            em = nt.nodes.new('ShaderNodeEmission'); em.name = 'VG_EM'
            if src: nt.links.new(src.outputs[0], em.inputs['Color'])
            else:
                v = bsdf.inputs['Metallic'].default_value; em.inputs['Color'].default_value = (v, v, v, 1)
            nt.links.new(em.outputs[0], out.inputs[0])
        else:
            em = nt.nodes.get('VG_EM')
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            if em: nt.nodes.remove(em)
            nt.links.new(bsdf.outputs[0], out.inputs[0])

def _px(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32); img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)

def _save(img, path, fmt='PNG'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.filepath_raw = path; img.file_format = fmt
    img.save()
    return img

def bake_pbr(ob, name, out_dir, size=1024, samples=12, ao_strength=1.0):
    """Bake the object's procedural materials into one PBR set and swap in a single glTF material."""
    gpu()
    sc = bpy.context.scene
    col = _img(name + '_basecolor', size, True)
    _bake(ob, 'DIFFUSE', col, samples, pass_filter={'COLOR'})
    rough = _img(name + '_rough', size); _bake(ob, 'ROUGHNESS', rough, 16)
    metal = _img(name + '_metal', size)
    _metal_swap(ob, True); _bake(ob, 'EMIT', metal, 4); _metal_swap(ob, False)
    nrm = _img(name + '_normal', size)
    sc.render.bake.normal_space = 'TANGENT'
    _bake(ob, 'NORMAL', nrm, samples, normal_space='TANGENT')
    ao = _img(name + '_ao', size); _bake(ob, 'AO', ao, 32)
    # pack ORM
    A = _px(ao)[..., 0]; R = _px(rough)[..., 0]; M = _px(metal)[..., 0]
    A = 1.0 - (1.0 - A) * ao_strength
    orm = _img(name + '_orm', size)
    o = np.stack([A, R, M, np.ones_like(A)], -1).astype(np.float32)
    orm.pixels.foreach_set(o.ravel())
    # 8-bit file-backed copies for export
    files = {}
    for im, key, cs in ((col, 'basecolor', 'sRGB'), (orm, 'orm', 'Non-Color'), (nrm, 'normal', 'Non-Color')):
        p = f'{out_dir}/{name}_{key}.png'
        im8 = bpy.data.images.new(f'{name}_{key}', size, size, alpha=False)
        im8.colorspace_settings.name = cs
        px = _px(im)
        if key == 'basecolor':
            pass  # sRGB image buffers are linear in Blender; saving converts
        im8.pixels.foreach_set(px.ravel())
        _save(im8, p)
        files[key] = im8
    for im in (col, rough, metal, nrm, ao, orm): bpy.data.images.remove(im)
    mat = gltf_material(name, files['basecolor'], files['orm'], files['normal'])
    ob.data.materials.clear(); ob.data.materials.append(mat)
    return mat, files

def _gltf_group():
    g = bpy.data.node_groups.get('glTF Material Output')
    if g: return g
    g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    g.interface.new_socket('Thickness', in_out='INPUT', socket_type='NodeSocketFloat')
    return g

def gltf_material(name, col, orm, nrm, emissive_img=None, emit_strength=1.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_backface_culling = True
    nt = mat.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = _n(nt, 'ShaderNodeOutputMaterial', (600, 0)); b = _n(nt, 'ShaderNodeBsdfPrincipled', (300, 0))
    _link(nt, b.outputs[0], out.inputs[0])
    tc = _n(nt, 'ShaderNodeTexImage', (-400, 300)); tc.image = col; _link(nt, tc.outputs[0], b.inputs['Base Color'])
    to = _n(nt, 'ShaderNodeTexImage', (-400, 0)); to.image = orm
    sp = _n(nt, 'ShaderNodeSeparateColor', (-100, 0)); _link(nt, to.outputs[0], sp.inputs[0])
    _link(nt, sp.outputs[1], b.inputs['Roughness']); _link(nt, sp.outputs[2], b.inputs['Metallic'])
    grp = _n(nt, 'ShaderNodeGroup', (300, -400)); grp.node_tree = _gltf_group()
    _link(nt, sp.outputs[0], grp.inputs['Occlusion'])
    tn = _n(nt, 'ShaderNodeTexImage', (-400, -300)); tn.image = nrm
    nm = _n(nt, 'ShaderNodeNormalMap', (-100, -300)); _link(nt, tn.outputs[0], nm.inputs['Color']); _link(nt, nm.outputs[0], b.inputs['Normal'])
    if emissive_img:
        te = _n(nt, 'ShaderNodeTexImage', (-400, -600)); te.image = emissive_img
        _link(nt, te.outputs[0], b.inputs['Emission Color']); b.inputs['Emission Strength'].default_value = emit_strength
    return mat

# ---------------------------------------------------------------- export

def export_glb(objs, path, extras=None, anim=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    for o in objs: o.select_set(True)
    vl.objects.active = objs[0]
    if extras:
        for k, v in extras.items(): objs[0][k] = v
    with bpy.context.temp_override(active_object=objs[0], selected_objects=objs):
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                                  export_yup=True, export_extras=True, export_image_format='JPEG', export_jpeg_quality=92,
                                  export_animations=anim, export_materials='EXPORT', export_tangents=False)
    return os.path.getsize(path)

def stats(objs):
    dg = bpy.context.evaluated_depsgraph_get(); tris = 0
    for o in objs:
        if o.type != 'MESH': continue
        m = o.evaluated_get(dg).to_mesh(); m.calc_loop_triangles(); tris += len(m.loop_triangles); o.evaluated_get(dg).to_mesh_clear()
    return tris

def bounds(objs):
    import itertools
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type == 'MESH' for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi

# ---------------------------------------------------------------- review renders

def studio(target_objs, path, res=(1600, 1000), samples=96, cam_dir=(1.0, -0.35, 0.28), lens=70, fill=1.25,
           bg=(0.035, 0.038, 0.045), key=(1.0, 0.95, 0.9), rim=(0.6, 0.75, 1.0), ortho=False, floor=True):
    gpu()
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.cycles.samples = samples; sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.render.film_transparent = False
    rig = coll('VG_Studio')
    for o in list(rig.objects): bpy.data.objects.remove(o, do_unlink=True)
    lo, hi = bounds(target_objs); c = (lo + hi) / 2; rad = (hi - lo).length / 2
    w = bpy.data.worlds.get('VG_World') or bpy.data.worlds.new('VG_World'); sc.world = w
    bgn = w.node_tree.nodes.get('Background'); bgn.inputs[0].default_value = (*bg, 1); bgn.inputs[1].default_value = 1.0
    d = Vector(cam_dir).normalized()
    cam = bpy.data.objects.new('VG_Cam', bpy.data.cameras.new('VG_Cam')); rig.objects.link(cam)
    cam.data.lens = lens
    dist = rad * fill / math.tan(cam.data.angle / 2) if not ortho else rad * 3
    if ortho: cam.data.type = 'ORTHO'; cam.data.ortho_scale = rad * 2 * fill
    cam.location = c + d * dist
    cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.clip_end = dist * 10
    sc.camera = cam
    def area(name, loc, energy, color, size):
        L = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA')); rig.objects.link(L)
        L.data.energy = energy; L.data.color = color; L.data.size = size
        L.location = loc; L.rotation_euler = (c - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    s = rad
    area('VG_Key', c + Vector((s * 2.5, -s * 2.0, s * 2.6)), 520 * s * s, key, s * 2.0)
    area('VG_Fill', c + Vector((-s * 2.8, -s * 1.5, s * 0.8)), 110 * s * s, (0.85, 0.9, 1.0), s * 3)
    area('VG_Rim', c + Vector((-s * 0.5, s * 3.0, s * 1.8)), 1200 * s * s, rim, s * 1.6)
    area('VG_Top', c + Vector((0, 0, s * 3.5)), 90 * s * s, (1, 1, 1), s * 4)
    # floor
    if not floor:
        sc.render.filepath = path; os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.render.render(write_still=True); return path
    fl = box('VG_Floor', (rad * 30, rad * 30, 0.001), (c.x, c.y, lo.z - 0.0006))
    rig.objects.link(fl); bpy.context.scene.collection.objects.unlink(fl)
    fm = bpy.data.materials.get('VG_FloorMat') or bpy.data.materials.new('VG_FloorMat')
    fb = fm.node_tree.nodes.get('Principled BSDF'); fb.inputs['Base Color'].default_value = (*[x * 0.55 for x in bg], 1); fb.inputs['Roughness'].default_value = 0.42
    fl.data.materials.append(fm)
    sc.render.filepath = path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    return path

# ---------------------------------------------------------------- wood + shipping

def wood(name, light=(0.13, 0.058, 0.024), dark=(0.062, 0.026, 0.011), rough=0.42, *, axis='Y', ring=150.0,
         wear=0.35, dirt=0.45, varnish=0.25):
    """Walnut-style wood: stretched distorted rings along `axis`, varnish, edge wear to raw wood."""
    mat = pbr(name, light, 0.0, rough, rough_var=0.1, wear=wear, wear_col=tuple(min(1, c * 1.9) for c in light),
              wear_metal=0.0, wear_rough=0.6, dirt=dirt, bump=0.08, bump_scale=600, scale=70, coat=varnish)
    nt = mat.node_tree
    tc = next(n for n in nt.nodes if n.type == 'TEX_COORD')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = {'Y': (1, 0.06, 1), 'X': (0.06, 1, 1), 'Z': (1, 1, 0.06)}[axis]
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    wv = nt.nodes.new('ShaderNodeTexWave'); wv.wave_type = 'RINGS'
    wv.inputs['Scale'].default_value = ring; wv.inputs['Distortion'].default_value = 14
    wv.inputs['Detail'].default_value = 6; wv.inputs['Detail Scale'].default_value = 1.5
    nt.links.new(mp.outputs[0], wv.inputs['Vector'])
    rgb = next(n for n in nt.nodes if n.type == 'RGB')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*dark, 1); ramp.color_ramp.elements[1].color = (*light, 1)
    ramp.color_ramp.elements[0].position = 0.2; ramp.color_ramp.elements[1].position = 0.95
    nt.links.new(wv.outputs['Fac'], ramp.inputs['Fac'])
    for l in list(rgb.outputs[0].links):
        nt.links.new(ramp.outputs['Color'], l.to_socket)
    return mat

def marker(name, loc, **props):
    e = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(e)
    e.location = loc; e.empty_display_size = 0.02
    for k, v in props.items(): e[k] = v
    return e

FX_PREFIX = ('lens', 'reticle', 'glow', 'fx_')

def ship(name, out_path, blend_path, review=None, size=1024, samples=12, cams=((-1, 0.35, 0.3),), keep_fx=FX_PREFIX,
         markers=()):
    """Merge baked parts, unwrap, bake PBR, render review shots, export GLB and save the source .blend."""
    import hashlib
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and not o.name.startswith('VG_')]
    fx = [o for o in meshes if o.name.startswith(keep_fx)]
    body = merge(name, [o for o in meshes if o not in fx])
    fxo = merge(name + '_fx', fx) if fx else None
    unwrap(body, angle=60, margin=0.003)
    bake_pbr(body, name, os.path.dirname(out_path) + '/textures', size=size, samples=samples)
    shots = []
    if review:
        for i, cd in enumerate(cams[:1]):
            p = f'{review}/{name}.png'
            studio([body] + ([fxo] if fxo else []), p, res=(1200, 700), samples=24, cam_dir=cd, lens=85, fill=1.1)
            shots.append(p)
    objs = [body] + ([fxo] if fxo else []) + [bpy.data.objects[m] for m in markers]
    nbytes = export_glb(objs, out_path)
    os.makedirs(os.path.dirname(blend_path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=blend_path, copy=True)
    lo, hi = bounds([body] + ([fxo] if fxo else []))
    size3 = [round(hi.x - lo.x, 4), round(hi.z - lo.z, 4), round(hi.y - lo.y, 4)]  # glTF x, y(up), z
    return {'bytes': nbytes, 'tris': stats([body] + ([fxo] if fxo else [])), 'size': size3, 'longest': max(size3),
            'sha': hashlib.sha256(open(out_path, 'rb').read()).hexdigest()[:12], 'shots': shots}

def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]

def thumbnail(glb, out, cam_dir=(-1, 0.55, 0.42), res=256, samples=16):
    """Catalog thumbnail matching the studio's existing dark-slate previews."""
    reset()
    objs = [o for o in import_glb(glb) if o.type == 'MESH']
    bg = (0.0065, 0.0115, 0.0165)
    studio(objs, out, res=(res, res), samples=samples, cam_dir=cam_dir, lens=70, fill=1.08, bg=bg, floor=False)
    return out
