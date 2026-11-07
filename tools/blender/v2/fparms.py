"""First-person ARMS rig: a character's arms and hands in camera space, holding a weapon. The character comes from
SOURCES (arcade/fp_rigs.py adds the Arcade hero and picks it with use_source('hero')).

Camera space as in fp.py: eye at the origin, Blender +Y is the view direction (glTF -Z), Z up, X right.
One armature per weapon (FP_<PREFIX>):

  Root ─┬─ Camera                       camera reference (recoil kick / shake), exported
        ├─ Shoulders ─ {Left,Right}Shoulder ─ Arm ─ ForeArm ─ Hand ─ fingers (Mixamo bone names)
        ├─ Pole_R / Pole_L              elbow targets
        └─ Weapon ─┬─ parts (Mag, Bolt, Slide, Pump, Warhead, Trigger ...)
                   ├─ Grip_R ─ IK_Hand_R    right-hand grip (weapon axes) → wrist IK target
                   └─ Grip_L ─ IK_Hand_L    left-hand grip; may follow Mag_Grip_L (child of Mag) on reloads

IK_Hand_* are the hand controls (Hand-bone frames). solve_arms() is an analytic two-bone IK with an anatomical
elbow hinge and forearm twist bones; clips bake its result as plain FK keys on Arm/ForeArm/ForeArmTwist/Hand, so
the GLB needs no IK at runtime (Unity, Unreal, three.js). Hold blends (Att_*) are COPY_TRANSFORMS on IK_Hand_*,
baked by the glTF exporter's sampling. exec after fp.py.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix, Euler, Quaternion

ROOT = '/Users/omrydamari/Documents/shooter-engine-main/'
SIDES = {'R': 'Right', 'L': 'Left'}
FINGERS = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')

# The character the arms are cut from, one entry per source: its GLB, the uniform scale that makes it life-size, the
# eye in its own (unscaled) units, how far each shoulder is shifted in camera space (up, and twisted for a shouldered
# weapon), the skinned mesh that carries the arms (None: the armature's first mesh child), the cached arms mesh's name,
# whether an import's clashing `Name.001` materials are pointed back at the file's own (a kit's shared materials), and,
# for a file whose materials read a named vertex-colour layer, that layer's name. `build` names a function that makes the
# source in the file instead of importing it (a pair of arms modelled for the camera). arcade/fp_rigs.py adds the
# Arcade hero's entry and picks it with use_source('hero'); nothing is built until a source is chosen.
SOURCES = {}
SOURCE = None


def use_source(name, **over):
    """Pick the source character (a SOURCES key, with keyword overrides). SOLDIER, SCALE, EYE_SRC and SHOULDER_SHIFT
    follow it, so everything below reads one set of names whichever character is in."""
    global SOURCE, SOLDIER, SCALE, EYE_SRC, SHOULDER_SHIFT
    SOURCE = dict(SOURCES[name], name=name, **over)
    SOLDIER = SOURCE['file']; SCALE = SOURCE['scale']; EYE_SRC = Vector(SOURCE['eye'])
    SHOULDER_SHIFT = {s: Vector(v) for s, v in SOURCE['shoulder'].items()}
    return SOURCE

SOLDIER = SCALE = EYE_SRC = SHOULDER_SHIFT = None   # set by use_source(); arcade/fp_rigs.py picks 'hero'


def arm_bones(side):
    s = SIDES[side]
    names = [f'{s}Shoulder', f'{s}Arm', f'{s}ForeArm', f'{s}Hand']
    names += [f'{s}Hand{f}{i}' for f in FINGERS for i in (1, 2, 3)]
    return names


def body_to_cam():
    R = Matrix.Rotation(math.pi, 4, 'Z'); S = Matrix.Scale(SCALE, 4)
    eye = R @ S @ EYE_SRC
    return Matrix.Translation(-eye) @ R @ S


def soldier():
    """The source character: its armature (found by the 'fp_source' tag, imported once) and the skinned mesh."""
    tag = SOURCE['name']
    arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE' and o.get('fp_source') == tag), None)
    if not arm and tag == 'soldier':               # a file from before the tag: the soldier was the only source
        arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE' and 'mixamorig:Hips' in o.data.bones
                    and o.get('fp_source') is None), None)
        if arm: arm['fp_source'] = tag
    if not arm and SOURCE.get('build'):              # a source built in the file: make it, then find it by its tag
        globals()[SOURCE['build']]()
        arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE' and o.get('fp_source') == tag)
    if not arm:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=SOLDIER)
        new = [o for o in bpy.data.objects if o not in before]
        for o in new: o['fp_source'] = tag
        arm = next(o for o in new if o.type == 'ARMATURE' and 'mixamorig:Hips' in o.data.bones)
        if SOURCE.get('remap'): remap_materials(new, SOURCE.get('color'))
    want = SOURCE.get('mesh')
    me = next(o for o in arm.children if o.type == 'MESH' and (not want or o.name.split('.')[0] == want))
    for o in ([arm] + list(arm.children) if want else (arm, me)): o.hide_render = True; o.hide_viewport = True
    return arm, me


def remap_materials(objs, color=None):
    """An imported GLB whose material names clash with ones already in the file gets `Name.001` copies: point its
    slots back at the originals (a kit's shared materials), and name its vertex colours `color` where the materials
    read that layer."""
    import re
    for o in objs:
        if o.type != 'MESH': continue
        for slot in o.material_slots:
            m = slot.material
            base = re.sub(r'\.\d+$', '', m.name) if m else None
            if base and base != m.name and base in bpy.data.materials: slot.material = bpy.data.materials[base]
        if color:
            for a in o.data.color_attributes:
                if a.name != color: a.name = color


def side_of(name):
    return 'R' if name.startswith('Right') else 'L'


def arms_mesh(name=None):
    """Both arms cut from the source character at the shoulder joint, in camera space, groups renamed to bone names.
    Cached per source under SOURCES[...]['arms']."""
    name = name or SOURCE['arms']
    if bpy.data.objects.get(name): return bpy.data.objects[name]
    sarm, sme = soldier()
    keep = {n for s in SIDES for n in arm_bones(s)}
    limb = {n for n in keep if not n.endswith('Shoulder')}
    data = sme.data.copy(); data.name = name
    ob = bpy.data.objects.new(name, data); bpy.context.scene.collection.objects.link(ob)
    # Blender 5 keeps group names on the mesh, so the copy already carries them: rename in place
    if not ob.vertex_groups:
        for g in sme.vertex_groups: ob.vertex_groups.new(name=g.name)
    for g in ob.vertex_groups: g.name = g.name.replace('mixamorig:', '')
    for S in SIDES.values():
        if f'{S}ForeArmTwist' not in ob.vertex_groups: ob.vertex_groups.new(name=f'{S}ForeArmTwist')
    gname = {g.index: g.name for g in ob.vertex_groups}
    rb = rest_bones()
    fore = {s: (rb[f'{S}ForeArm'][0].translation, rb[f'{S}ForeArm'][0].translation + rb[f'{S}ForeArm'][0].to_3x3() @ Vector((0, rb[f'{S}ForeArm'][1], 0)))
            for s, S in SIDES.items()}
    T = body_to_cam() @ sme.matrix_world
    bm = bmesh.new(); bm.from_mesh(data)
    dl = bm.verts.layers.deform.active
    kill = []
    for v in bm.verts:
        d = v[dl]; w = {}
        for gi, wt in d.items():
            n = gname[gi]
            if n[-1] == '4' and n[:-1] + '3' in keep: n = n[:-1] + '3'      # fold finger tips into the last joint
            if n in keep: w[n] = w.get(n, 0) + wt
        if sum(wt for n, wt in w.items() if n in limb) < 0.5:
            kill.append(v); continue
        tot = sum(w.values())
        v.co = T @ v.co
        side = 'R' if v.co.x > 0 else 'L'
        v.co += SHOULDER_SHIFT[side]
        fa = f'{SIDES[side]}ForeArm'
        if fa in w:                                   # hand the distal forearm skin to the twist bone, graded
            h, t = fore[side]; L = (t - h).length
            u = max(0.0, min(1.0, (v.co - h).dot((t - h) / L) / L))
            g = u * u * (3 - 2 * u)
            w[fa + 'Twist'] = w[fa] * g; w[fa] *= (1 - g)
        d.clear()
        for n, wt in w.items(): d[ob.vertex_groups[n].index] = wt / tot
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(data); bm.free()
    for g in list(ob.vertex_groups):
        if g.name not in keep and not g.name.endswith('Twist'): ob.vertex_groups.remove(g)
    for p in data.polygons: p.use_smooth = True
    return ob


def rest_bones():
    """Soldier arm bone rest matrices in camera space (with the shoulder shift) and lengths."""
    sarm, _ = soldier()
    T = body_to_cam() @ sarm.matrix_world
    out = {}
    for s in SIDES:
        for n in arm_bones(s):
            b = sarm.data.bones['mixamorig:' + n]
            M = T @ b.matrix_local
            M = Matrix.Translation(SHOULDER_SHIFT[s]) @ M
            # remove the scale that T carried into the rotation part
            loc, rot, _ = M.decompose()
            out[n] = (Matrix.Translation(loc) @ rot.to_matrix().to_4x4(), b.length * SCALE,
                      b.parent.name.replace('mixamorig:', '') if b.parent else None)
    return out


def hand_axes(side):
    """The soldier hand bone's local axes that point along the palm normal and toward the thumb (T-pose: palms down)."""
    sarm, _ = soldier()
    s = SIDES[side]
    b = sarm.data.bones[f'mixamorig:{s}Hand']
    inv = b.matrix_local.to_3x3().inverted()
    palm = (inv @ Vector((0, 0, -1))).normalized()
    thumb = sarm.data.bones[f'mixamorig:{s}HandThumb1'].head_local - sarm.data.bones[f'mixamorig:{s}HandIndex1'].head_local
    thumb = (inv @ thumb).normalized()
    return palm, thumb


def basis(a, b):
    a = Vector(a).normalized(); b = Vector(b); b = (b - a * b.dot(a)).normalized()
    return Matrix((a, b, a.cross(b))).transposed()


def hand_matrix(side, wrist, direction, palm):
    """World (camera-space) matrix for a Hand bone: Y along `direction` (wrist → knuckles), palm facing `palm`."""
    lp, _ = hand_axes(side)
    local = basis((0, 1, 0), lp)
    R = basis(direction, palm) @ local.inverted()
    M = R.to_4x4(); M.translation = Vector(wrist)
    return M


def cyl_grip(center, axis, side, radius, tilt=0.0, thick=0.016):
    """Hand frame wrapping a cylinder (pistol grip, handguard, pump, tube), weapon-local.
    center: point on the cylinder axis under the palm centre; axis: cylinder direction, oriented so that
    axis × palm_normal points where the fingers wrap; side: from the axis out to the palm; tilt: degrees the
    metacarpals turn about the palm normal (a diagonal power grip). → (wrist, dir, palm) for build_arms_rig."""
    axis = Vector(axis).normalized(); side = Vector(side); side = (side - axis * side.dot(axis)).normalized()
    palm = -side
    d = axis.cross(palm).normalized()
    d = Quaternion(palm, math.radians(tilt)) @ d
    pc = Vector(center) + side * (radius + thick)          # palm-centre bone line, just off the surface
    wrist = pc - d * 0.05                                  # the palm centre sits ~5 cm ahead of the wrist
    return tuple(wrist), tuple(d), tuple(palm)


def build_arms_rig(name, Wm, parts, grips, poles=None, grip_parent=None):
    """Wm: weapon hip matrix (weapon-local → camera). parts: [(bone, local_head, parent)].
    grips: {'R': (wrist, dir, palm), 'L': (...)} in WEAPON-LOCAL space."""
    rb = rest_bones()
    arm = bpy.data.armatures.new(name); ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    arm.display_type = 'STICK'; ob.show_in_front = True
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    ob.select_set(True); vl.objects.active = ob
    with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob]):
        bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    W3 = Wm.to_3x3(); wz = W3 @ Vector((0, 0, 1))

    def bone(n, h, t, parent=None, z=wz, deform=False):
        b = eb.new(n); b.head = Vector(h); b.tail = Vector(t); b.use_deform = deform
        if parent: b.parent = eb[parent]
        b.align_roll(Vector(z))
        return b

    bone('Root', (0, 0, 0), (0, 0.05, 0), z=(0, 0, 1))
    bone('Camera', (0, 0, 0), (0, 0.04, 0), 'Root', z=(0, 0, 1))
    bone('Shoulders', (0, -0.06, -0.27), (0, -0.01, -0.27), 'Root', z=(0, 0, 1))
    bone('Weapon', Wm @ Vector((0, 0, 0)), Wm @ Vector((0, 0.08, 0)), 'Root', deform=True)
    for n, h, p in parts:
        bone(n, Wm @ Vector(h), Wm @ (Vector(h) + Vector((0, 0.04, 0))), p, deform=True)
    for s in SIDES:
        for n in arm_bones(s):
            M, length, parent = rb[n]
            b = eb.new(n); b.use_deform = True
            b.head = M.translation; b.tail = M.translation + M.to_3x3() @ Vector((0, length, 0))
            b.align_roll(M.to_3x3() @ Vector((0, 0, 1)))
            b.parent = eb['Shoulders'] if n.endswith('Shoulder') else eb[parent]
        S = SIDES[s]; fa = eb[f'{S}ForeArm']            # pronation/supination spread along the forearm
        tw = eb.new(f'{S}ForeArmTwist'); tw.use_deform = True
        tw.head = fa.head.copy(); tw.tail = fa.tail.copy(); tw.roll = fa.roll; tw.parent = fa
    for s, (wrist, d, palm) in grips.items():
        wl = Vector(wrist)
        bone(f'Grip_{s}', Wm @ wl, Wm @ (wl + Vector((0, 0.05, 0))), (grip_parent or {}).get(s, 'Weapon'))
        H = hand_matrix(s, Wm @ wl, W3 @ Vector(d), W3 @ Vector(palm))
        b = eb.new(f'IK_Hand_{s}'); b.use_deform = False
        b.head = H.translation; b.tail = H.translation + H.to_3x3() @ Vector((0, 0.06, 0))
        b.align_roll(H.to_3x3() @ Vector((0, 0, 1))); b.parent = eb[f'Grip_{s}']
    poles = poles or {'R': (0.45, -0.05, -0.55), 'L': (-0.45, 0.25, -0.55)}
    for s, p in poles.items():
        bone(f'Pole_{s}', p, Vector(p) + Vector((0, 0.04, 0)), 'Shoulders', z=(0, 0, 1))
    with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob]):
        bpy.ops.object.mode_set(mode='OBJECT')
    for p in ob.pose.bones: p.rotation_mode = 'QUATERNION'
    solve_arms(ob)
    return ob


# ---------------------------------------------------------------- analytic arm IK (baked FK)
#
# Blender's IK on the soldier's dead-straight T-pose chain may bend the elbow "backwards" and then roll the whole
# forearm 180 degrees to reach the pole, which wrings the wrist. This solver keeps the anatomical elbow hinge
# (rest: forward flexion about +Z for the right arm, -Z for the left, arms along ±X), picks the elbow swivel that
# keeps the wrist inside human twist/bend limits, and spreads the forearm twist over <Side>ForeArmTwist.

TWIST_SHARE = 0.75          # of the hand's twist carried by the forearm (the wrist blend takes the rest)
SWIVEL = range(-110, 111, 5)  # elbow swivel search around the pole direction, degrees


def _rot(m): return m.to_3x3().normalized()


def _swing_twist(q):
    tw = Quaternion((q.w, 0.0, q.y, 0.0))
    if tw.magnitude < 1e-8: return q, Quaternion()
    tw.normalize(); return tw.inverted() @ q, tw   # q = twist @ swing ... (swing applied after twist about Y)


def _ang(q): a = q.angle; return math.degrees(a if a <= math.pi else 2 * math.pi - a)


def solve_side(rig, s, prev=None):
    """Pose Arm/ForeArm/ForeArmTwist/Hand of one side from IK_Hand_<s> and Pole_<s>. Needs an evaluated rig.
    Returns (swivel, twist_deg, swing_deg, short_m)."""
    S = SIDES[s]; pb = rig.pose.bones; bn = rig.data.bones
    A, F, T, H = pb[f'{S}Arm'], pb[f'{S}ForeArm'], pb[f'{S}ForeArmTwist'], pb[f'{S}Hand']
    a, b = bn[f'{S}Arm'].length, bn[f'{S}ForeArm'].length
    Sh = pb[f'{S}Shoulder']
    Sw = Sh.matrix @ Sh.bone.matrix_local.inverted() @ bn[f'{S}Arm'].matrix_local     # Arm world at rest-relative pose
    P0 = Sw.translation
    tgt = pb[f'IK_Hand_{s}'].matrix
    Tp = tgt.translation; Hq = _rot(tgt)
    D = Tp - P0; d = D.length; short = max(0.0, d - (a + b - 1e-4)); d = min(d, a + b - 1e-4); D.normalize()
    cosA = max(-1.0, min(1.0, (a * a + d * d - b * b) / (2 * a * d)))
    sinA = math.sqrt(1 - cosA * cosA)
    pole = pb[f'Pole_{s}'].matrix.translation
    p0 = (pole - P0); p0 = (p0 - D * p0.dot(D)).normalized()
    hinge_rest = Vector((0, 0, 1 if s == 'R' else -1))
    Ar, Fr = _rot(Sw), _rot(Sh.matrix @ Sh.bone.matrix_local.inverted() @ bn[f'{S}ForeArm'].matrix_local)
    yA = Ar.col[1].normalized(); yF = Fr.col[1].normalized()
    RA0 = basis(yA, hinge_rest); RF0 = basis(yF, hinge_rest)
    rest_rel = bn[f'{S}ForeArm'].matrix_local.to_3x3().inverted() @ bn[f'{S}Hand'].matrix_local.to_3x3()
    best = None
    for phi in SWIVEL:
        p = Quaternion(D, math.radians(phi)) @ p0
        E = P0 + a * (cosA * D + sinA * p)
        W = P0 + D * d
        yu = (E - P0).normalized(); yf = (W - E).normalized()
        n = yu.cross(yf)
        if n.length < 1e-6: n = D.cross(p)
        n.normalize()
        RA = basis(yu, n) @ RA0.inverted() @ Ar
        RF = basis(yf, n) @ RF0.inverted() @ Fr
        loc = (RF @ rest_rel).inverted() @ Hq
        sw, tw = _swing_twist(loc.to_quaternion())
        twd = math.degrees(2 * math.atan2(tw.y, tw.w)); twd = (twd + 180) % 360 - 180
        swd = _ang(sw)
        cost = max(0, abs(twd) - 35) * 1.0 + max(0, swd - 40) * 1.6 + abs(phi) * 0.25
        if prev is not None: cost += abs(phi - prev) * 0.3
        if best is None or cost < best[0]: best = (cost, phi, RA, RF, twd, swd)
    _, phi, RA, RF, twd, swd = best
    # write local pose rotations (armature space == world: rigs sit at the origin)
    parentA = Sh.matrix @ Sh.bone.matrix_local.inverted()
    A.rotation_quaternion = (_rot(parentA @ bn[f'{S}Arm'].matrix_local).inverted() @ RA).to_quaternion()
    # ForeArm local = (Arm posed ∘ rest offset)^-1 · RF
    armW = RA; fa_rest_in_arm = bn[f'{S}Arm'].matrix_local.to_3x3().inverted() @ bn[f'{S}ForeArm'].matrix_local.to_3x3()
    F.rotation_quaternion = ((armW @ fa_rest_in_arm).inverted() @ RF).to_quaternion()
    T.rotation_quaternion = Quaternion((0, 1, 0), math.radians(twd * TWIST_SHARE))
    H.rotation_quaternion = ((RF @ rest_rel).inverted() @ Hq).to_quaternion()
    for x in (A, F, T, H): x.location = (0, 0, 0)
    return phi, round(twd), round(swd), round(short, 3)


def auto_tilt(rig, side, bone=None, att=None, span=70, step=5):
    """Turn a hand hold about its palm normal (pivot: palm centre, so contact is kept) to the angle the arm can
    take with the least wrist bend/twist. bone: the rest bone that defines the hold (IK_Hand_<side> or an attach
    bone); att: its Att_* constraint (hold blended in while measuring). The winning angle is baked into the rest."""
    bone = bone or f'IK_Hand_{side}'
    pbH = rig.pose.bones[f'IK_Hand_{side}']
    c = pbH.constraints.get('Att_' + att) if att else None
    if c: c.influence = 1.0
    target = rig.pose.bones[bone]
    bpy.context.view_layer.update()
    H0 = target.matrix.copy()
    lp, _ = hand_axes(side)
    n = (H0.to_3x3() @ lp).normalized()
    bn = rig.data.bones; S = SIDES[side]
    pc = (H0.translation + H0 @ (bn[f'{S}Hand'].matrix_local.inverted() @ bn[f'{S}HandMiddle1'].head_local)) / 2
    best = None
    for t in range(-span, span + 1, step):
        R = Matrix.Translation(pc) @ Quaternion(n, math.radians(t)).to_matrix().to_4x4() @ Matrix.Translation(-pc)
        target.matrix = R @ H0
        bpy.context.view_layer.update()
        phi, tw, sw, short = solve_side(rig, side)
        cost = max(0, abs(tw) - 30) + 1.6 * max(0, sw - 30) + 40 * short + abs(t) * 0.15
        if best is None or cost < best[0]: best = (cost, t, R @ H0, tw, sw)
    target.matrix = H0; target.location = (0, 0, 0); target.rotation_quaternion = (1, 0, 0, 0)
    _, t, H, tw, sw = best
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    rig.select_set(True); vl.objects.active = rig
    with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[rig]):
        bpy.ops.object.mode_set(mode='EDIT')
        eb = rig.data.edit_bones[bone]
        eb.head = H.translation; eb.tail = H.translation + H.to_3x3() @ Vector((0, eb.length, 0))
        eb.align_roll(H.to_3x3() @ Vector((0, 0, 1)))
        bpy.ops.object.mode_set(mode='OBJECT')
    for p in rig.pose.bones: p.rotation_mode = 'QUATERNION'
    if c: c.influence = 0.0
    bpy.context.view_layer.update()
    return t, tw, sw


def solve_arms(rig, prev=None, key=None):
    """Solve both arms for the current frame (evaluates the rig first). key=frame → keyframe the arm bones."""
    bpy.context.view_layer.update()
    out = {}
    for s in SIDES:
        if f'IK_Hand_{s}' not in rig.pose.bones: continue
        out[s] = solve_side(rig, s, (prev or {}).get(s, (None,))[0] if prev else None)
        if key is not None:
            S = SIDES[s]
            for n in (f'{S}Arm', f'{S}ForeArm', f'{S}ForeArmTwist', f'{S}Hand'):
                rig.pose.bones[n].keyframe_insert('rotation_quaternion', frame=key)
    return out


def add_attach(rig, Wm, side, name, parent, grip):
    """A hand-hold on a moving part: bone `name` (child of `parent`, e.g. Mag / Bolt / Warhead) whose rest is the
    Hand matrix holding it, plus a COPY_TRANSFORMS on IK_Hand_<side> (constraint 'Att_<name>', influence 0).
    Clips blend the hand onto the part by keying that influence. grip: cyl_grip(...) in weapon-local space."""
    wrist, d, palm = grip
    W3 = Wm.to_3x3()
    H = hand_matrix(side, Wm @ Vector(wrist), W3 @ Vector(d), W3 @ Vector(palm))
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    rig.select_set(True); vl.objects.active = rig
    with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[rig]):
        bpy.ops.object.mode_set(mode='EDIT')
        eb = rig.data.edit_bones
        b = eb.get(name) or eb.new(name); b.use_deform = False
        b.head = H.translation; b.tail = H.translation + H.to_3x3() @ Vector((0, 0.06, 0))
        b.align_roll(H.to_3x3() @ Vector((0, 0, 1))); b.parent = eb[parent]
        bpy.ops.object.mode_set(mode='OBJECT')
    rig.pose.bones[name].rotation_mode = 'QUATERNION'
    pb = rig.pose.bones[f'IK_Hand_{side}']
    c = pb.constraints.get('Att_' + name) or pb.constraints.new('COPY_TRANSFORMS')
    c.name = 'Att_' + name; c.target = rig; c.subtarget = name; c.influence = 0.0
    return name


def bind_arms(rig, name):
    src = arms_mesh()
    ob = bpy.data.objects.new(name, src.data.copy()); bpy.context.scene.collection.objects.link(ob)
    if not ob.vertex_groups:
        for g in src.vertex_groups: ob.vertex_groups.new(name=g.name)
    m = ob.modifiers.new('Armature', 'ARMATURE'); m.object = rig
    ob.parent = rig
    return ob


def islands(bm):
    bm.verts.ensure_lookup_table()
    seen = set(); out = []
    for v in bm.verts:
        if v.index in seen: continue
        idx = [v.index]; seen.add(v.index); stack = [v]
        while stack:
            x = stack.pop()
            for e in x.link_edges:
                y = e.other_vert(x)
                if y.index not in seen: seen.add(y.index); stack.append(y); idx.append(y.index)
        cs = [bm.verts[i].co for i in idx]
        out.append((idx, Vector([min(c[k] for c in cs) for k in range(3)]), Vector([max(c[k] for c in cs) for k in range(3)])))
    return out


def rig_weapon(src, rig, Wm, split):
    """Copy the static weapon mesh into the rig: split = [(bone, pred(mn, mx))] picks loose parts per moving bone,
    the rest skins to 'Weapon'. One skinned mesh, one vertex group per bone."""
    name = rig.name + '_Weapon'
    old = bpy.data.objects.get(name)
    if old: bpy.data.objects.remove(old, do_unlink=True)
    ob = bpy.data.objects.new(name, src.data.copy()); bpy.context.scene.collection.objects.link(ob)
    ob.data.transform(Wm @ src.matrix_world)
    for g in list(ob.vertex_groups): ob.vertex_groups.remove(g)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    Winv = (Wm @ src.matrix_world).inverted()
    owner = {}
    for idx, mn, mx in islands(bm):
        lmn, lmx = Winv @ mn, Winv @ mx          # predicates speak weapon-local space
        lo = Vector([min(lmn[k], lmx[k]) for k in range(3)]); hi = Vector([max(lmn[k], lmx[k]) for k in range(3)])
        b = next((b for b, pred in split if pred(lo, hi)), 'Weapon')
        for i in idx: owner[i] = b
    bm.free()
    counts = {}
    for b in {'Weapon', *[b for b, _ in split]}:
        g = ob.vertex_groups.new(name=b)
        ids = [i for i, o in owner.items() if o == b]; counts[b] = len(ids)
        if ids: g.add(ids, 1.0, 'REPLACE')
    m = ob.modifiers.new('Armature', 'ARMATURE'); m.object = rig
    ob.parent = rig
    return ob, counts


def place_markers(rig, Wm, src_markers):
    """Muzzle / Sight empties from the static weapon file, re-parented to the Weapon bone in camera space."""
    out = []
    for n, mk in src_markers.items():
        name = n
        old = bpy.data.objects.get(name)
        if old and old is not mk and old.get('fp_rig') == rig.name: bpy.data.objects.remove(old, do_unlink=True)
        e = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(e)
        e.empty_display_size = 0.02; e['fp_rig'] = rig.name; e['marker'] = n
        for k in mk.keys():
            if k not in ('weapon',): e[k] = mk[k]
        e.matrix_world = Wm @ mk.matrix_world
        mw = e.matrix_world.copy()
        e.parent = rig; e.parent_type = 'BONE'; e.parent_bone = 'Weapon'
        bpy.context.view_layer.update(); e.matrix_world = mw
        out.append(e)
    return out


def review(path, eye=(0, 0, 0), look=(0, 1, 0), lens=None, fov=60.0, res=(960, 540), samples=12, ortho=None):
    """Light EEVEE frame (default: exactly the player's view). Keep it small: the Mac overheats on heavy renders."""
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    try: sc.eevee.taa_render_samples = samples
    except Exception: pass
    cam = bpy.data.objects.get('FP_ReviewCam')
    if not cam:
        cam = bpy.data.objects.new('FP_ReviewCam', bpy.data.cameras.new('FP_ReviewCam')); sc.collection.objects.link(cam)
    cam.data.clip_start = 0.01; cam.data.sensor_fit = 'VERTICAL'
    if ortho: cam.data.type = 'ORTHO'; cam.data.ortho_scale = ortho
    else:
        cam.data.type = 'PERSP'
        if lens: cam.data.lens = lens
        else: cam.data.angle = math.radians(fov)
    cam.location = Vector(eye)
    cam.rotation_euler = (Vector(look) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    w = bpy.data.worlds.get('FP_Review') or bpy.data.worlds.new('FP_Review'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.42, 0.45, 0.5, 1); bg.inputs['Strength'].default_value = 1.2
    sun = bpy.data.objects.get('FP_ReviewSun')
    if not sun:
        sun = bpy.data.objects.new('FP_ReviewSun', bpy.data.lights.new('FP_ReviewSun', 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 3.5; sun.rotation_euler = (math.radians(55), math.radians(-20), math.radians(30))
    sc.view_settings.view_transform = 'AgX'
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


# ---------------------------------------------------------------- grips: palm snap + finger contact solver

def surface_bvh(obs, groups=None):
    """BVH of evaluated meshes in world space; groups limits it to faces whose vertices all sit in those groups."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get(); verts = []; polys = []
    for ob in obs:
        ev = ob.evaluated_get(dg); me = ev.to_mesh(); base = len(verts)
        allowed = None
        if groups:
            gi = {ob.vertex_groups[g].index for g in groups if g in ob.vertex_groups}
            allowed = {v.index for v in ob.data.vertices if any(x.group in gi and x.weight > 0.5 for x in v.groups)}
        verts += [ob.matrix_world @ v.co for v in me.vertices]
        polys += [[base + i for i in p.vertices] for p in me.polygons if allowed is None or all(i in allowed for i in p.vertices)]
        ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)


def _near(bvh, p):
    hit = bvh.find_nearest(p)
    return hit[3] if hit and hit[0] is not None else 9.0


def palm_point(rig, side, depth=0.018):
    """Palm contact point and palm normal of the posed hand (world)."""
    S = SIDES[side]; bn = rig.data.bones
    H = hand_world(rig, side)
    lp, _ = hand_axes(side)
    n = (H.to_3x3() @ lp).normalized()
    a = H.translation; b = H @ (bn[f'{S}Hand'].matrix_local.inverted() @ bn[f'{S}HandMiddle1'].head_local)
    return (a + b) / 2 + n * depth, n


def hand_world(rig, side):
    """Where the hand is asked to be: the IK_Hand control (Hand-bone frame, after grips and hold blends)."""
    return rig.matrix_world @ rig.pose.bones[f'IK_Hand_{side}'].matrix


def snap_palm(rig, side, bvh, gap=0.004, iters=4):
    """Slide the grip (rest) along the palm normal until the palm rests `gap` off the weapon surface."""
    moved = 0.0
    for _ in range(iters):
        bpy.context.view_layer.update()
        p, n = palm_point(rig, side)
        hit = bvh.ray_cast(p - n * 0.05, n, 0.2)
        if hit[0] is None: break
        d = (hit[0] - p).dot(n) - gap
        if abs(d) < 0.0008: break
        pb = rig.pose.bones[f'Grip_{side}']
        # move in the grip bone's local frame: world delta → bone local
        M = (rig.matrix_world @ pb.matrix).to_3x3().normalized()
        pb.location = pb.location + M.inverted() @ (n * d); moved += d
    return moved


def bake_offset(rig, bone):
    """Move a bone's (and its children's) REST by its current pose location, then zero the pose: grip fixes found
    by snap_palm become part of the rig instead of something every clip must carry."""
    pb = rig.pose.bones[bone]
    delta = pb.bone.matrix_local.to_3x3() @ Vector(pb.location)      # armature space; call with the rig at rest
    pb.location = (0, 0, 0)
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    rig.select_set(True); vl.objects.active = rig
    with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[rig]):
        bpy.ops.object.mode_set(mode='EDIT')
        eb = rig.data.edit_bones[bone]
        for b in [eb] + list(eb.children_recursive):
            b.head += delta; b.tail += delta
        bpy.ops.object.mode_set(mode='OBJECT')
    for p in rig.pose.bones: p.rotation_mode = 'QUATERNION'
    return delta


def snap_attach(rig, side, att, bvh, gap=0.004):
    """Palm snap for an attach bone: temporarily drive the hand onto it, measure, shift the attach rest."""
    pb = rig.pose.bones[f'IK_Hand_{side}']; c = pb.constraints['Att_' + att]
    c.influence = 1.0; bpy.context.view_layer.update()
    p, n = palm_point(rig, side)
    hit = bvh.ray_cast(p - n * 0.05, n, 0.2)
    if hit[0] is not None:
        d = (hit[0] - p).dot(n) - gap
        vl = bpy.context.view_layer
        for o in vl.objects: o.select_set(False)
        rig.select_set(True); vl.objects.active = rig
        with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[rig]):
            bpy.ops.object.mode_set(mode='EDIT')
            eb = rig.data.edit_bones[att]; eb.head += n * d; eb.tail += n * d
            bpy.ops.object.mode_set(mode='OBJECT')
        for p_ in rig.pose.bones: p_.rotation_mode = 'QUATERNION'
    bpy.context.view_layer.update()
    return c


def finger_axis(rig, side, name, towards):
    """Local rotation axis (±X or ±Z) that swings the bone's tail toward `towards` (world direction)."""
    bn = rig.data.bones; b = bn[name]
    M = hand_world(rig, side) @ bn[f'{SIDES[side]}Hand'].matrix_local.inverted() @ b.matrix_local
    tail = M @ Vector((0, b.length, 0)); best = None
    for ax in (Vector((1, 0, 0)), Vector((-1, 0, 0)), Vector((0, 0, 1)), Vector((0, 0, -1))):
        R = Quaternion(ax, math.radians(20)).to_matrix().to_4x4()
        t2 = (M @ R) @ Vector((0, b.length, 0))
        s = (t2 - tail).dot(towards)
        if best is None or s > best[0]: best = (s, ax)
    return best[1]


def solve_fingers(rig, side, bvh, radius=0.0075, weights=(1.0, 1.15, 0.85), limits=(95, 105, 80), step=2.5,
                  fingers=FINGERS, thumb_limits=(35, 45, 50), trigger=None):
    """Curl each finger until it touches the surface; returns {bone: quaternion}. Pure FK math on top of the
    evaluated hand, so it is fast and does not need depsgraph updates per step.
    trigger: {'bvh': BVH, 'radius': r} → the index curls onto the trigger instead of wrapping the grip."""
    bpy.context.view_layer.update()
    S = SIDES[side]; pb = rig.pose.bones; bones = rig.data.bones; w = rig.matrix_world
    Hm = hand_world(rig, side)
    palm_n = (Hm.to_3x3() @ hand_axes(side)[0]).normalized()
    out = {}
    if 'Thumb' in fingers:
        out.update(solve_thumb(rig, side, bvh))
    for f in fingers:
        if f == 'Thumb': continue
        names = [f'{S}Hand{f}{i}' for i in (1, 2, 3)]
        ax = [finger_axis(rig, side, n, palm_n) for n in names]
        lim = thumb_limits if f == 'Thumb' else limits
        surf = bvh; rad = radius
        if f == 'Index' and trigger: surf = trigger['bvh']; rad = trigger.get('radius', radius)
        rels = []
        prev = bones[f'{S}Hand'].matrix_local
        for n in names:
            rels.append(prev.inverted() @ bones[n].matrix_local); prev = bones[n].matrix_local
        # parent world matrix of joint 1 = posed hand; rest pose of fingers is their own rest (no pose rotation yet)
        def chain(angles):
            M = Hm; segs = []
            for i, n in enumerate(names):
                M = M @ rels[i] @ Quaternion(ax[i], math.radians(angles[i])).to_matrix().to_4x4()
                L = bones[n].length * (1.35 if i == 2 else 1.0)      # the distal bone ends short of the fingertip
                ts = (0.6, 1.0) if i == 0 else (0.35, 0.7, 1.0)          # the knuckle itself sits on the palm contact
                segs.append([M @ Vector((0, L * t, 0)) for t in ts])
            return segs
        def touching(angles, upto=3):
            return any(_near(surf, p) < rad for s in chain(angles)[:upto] for p in s)
        ang = [0.0, 0.0, 0.0]
        if touching(ang):                              # starts inside the part: open it until it is clear
            k = 0.0
            while touching(ang) and k < 35:
                k += step; ang = [-k * weights[i] for i in range(3)]
            for i, n in enumerate(names): out[n] = Quaternion(ax[i], math.radians(ang[i]))
            continue
        # phase 1: curl the whole finger together until something touches
        t = 0.0
        while t < 1.0:
            nxt = [min(lim[i], (t + step / 100) * 100 * weights[i]) for i in range(3)]
            if touching(nxt): break
            ang = nxt; t += step / 100
        # phase 2: let the outer joints keep closing on their own
        for j in (1, 2):
            while ang[j] < lim[j]:
                nxt = list(ang); nxt[j] = min(lim[j], ang[j] + step)
                if touching(nxt): break
                ang = nxt
        if f == 'Index' and trigger and ang[0] >= lim[0] - step:
            ang = list(trigger.get('fallback', (30, 40, 25)))          # never met the trigger: rest along it
        for i, n in enumerate(names):
            out[n] = Quaternion(ax[i], math.radians(ang[i]))
    return out


def solve_thumb(rig, side, bvh, radius=0.009, step=8):
    """Thumb: two degrees of freedom at the base (flexion + swing across the palm) and a shared curl on the outer
    joints. Picks the pose that stays out of the part, rests on its surface and wraps round toward the palm side."""
    S = SIDES[side]; bn = rig.data.bones
    Hm = hand_world(rig, side)
    palm_n = (Hm.to_3x3() @ hand_axes(side)[0]).normalized()
    names = [f'{S}HandThumb{i}' for i in (1, 2, 3)]
    rels = []; prev = bn[f'{S}Hand'].matrix_local
    for n in names:
        rels.append(prev.inverted() @ bn[n].matrix_local); prev = bn[n].matrix_local
    ax_c = [finger_axis(rig, side, n, palm_n) for n in names]
    ax_s = Vector((0, 0, 1)) if abs(ax_c[0].z) < 0.5 else Vector((1, 0, 0))   # the other base axis
    pc, _ = palm_point(rig, side)
    best = None
    for a in range(-40, 81, step):
        for b in range(-50, 51, step):
            for c in (0, 20, 40, 60):
                M = Hm; pts = []
                q1 = Quaternion(ax_c[0], math.radians(a)) @ Quaternion(ax_s, math.radians(b))
                for i, n in enumerate(names):
                    q = q1 if i == 0 else Quaternion(ax_c[i], math.radians(c))
                    M = M @ rels[i] @ q.to_matrix().to_4x4()
                    L = bn[n].length * (1.35 if i == 2 else 1.0)
                    pts += [M @ Vector((0, L * t, 0)) for t in ((0.6, 1.0) if i == 0 else (0.5, 1.0))]
                ds = [_near(bvh, p) for p in pts]
                if min(ds) < radius * 0.85: continue           # inside the part
                tip = pts[-1]
                cost = abs(ds[-1] - radius) * 60 + abs(ds[-3] - radius) * 30 - (tip - pc).dot(palm_n) * 25 + (abs(a) + abs(b)) * 0.01
                if best is None or cost < best[0]: best = (cost, a, b, c)
    if best is None: return {n: Quaternion() for n in names}
    _, a, b, c = best
    out = {names[0]: Quaternion(ax_c[0], math.radians(a)) @ Quaternion(ax_s, math.radians(b))}
    for i in (1, 2): out[names[i]] = Quaternion(ax_c[i], math.radians(c))
    return out


def apply_fingers(rig, pose, frame=None):
    for n, q in pose.items():
        pb = rig.pose.bones[n]; pb.rotation_quaternion = q
        if frame is not None: pb.keyframe_insert('rotation_quaternion', frame=frame)


def blend_pose(a, b, t):
    return {n: a.get(n, Quaternion()).slerp(b.get(n, Quaternion()), t) for n in set(a) | set(b)}


def elbow_report(rig):
    bpy.context.view_layer.update()
    out = {}
    for s, S in SIDES.items():
        pb = rig.pose.bones.get(f'{S}ForeArm')
        if pb:
            w = rig.matrix_world
            out[s] = {'elbow': [round(x, 3) for x in w @ pb.head], 'wrist': [round(x, 3) for x in w @ pb.tail],
                      'target': [round(x, 3) for x in w @ rig.pose.bones[f'IK_Hand_{s}'].head]}
    return out
