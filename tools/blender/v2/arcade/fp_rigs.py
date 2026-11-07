"""Arcade first-person rigs: the villager hero's first-person arms (fp_hero_source: the hero's look, modelled at life
size for the camera, through fparms' swappable source) holding the Arcade weapons, rebuilt from weapons.py's part
builders so every moving part maps to a bone by its part name.
exec after vg, kit, nature, hero_corner, props, weapons, critters, pickups, hero, fparms and fpanim (one namespace).

    build_arc('Sling')   FP_Sling (armature), FP_Sling_Arms, FP_Sling_Weapon, FP_Sling_String (bands, outline 0),
                         FP_Sling_Round (the pebble; exported as 'Round'), the Muzzle/Sight markers, the grip poses.
    fp_grip_search(...)  how the grips and holds were oriented (see the end of this file).

Weapon-local space is weapons.py's: metres, +Y toward the muzzle, Z up, bore on the Y axis. Camera space is
fparms': the eye at the origin, +Y the view direction. Hands and weapons are life size (the cannon at 0.85); each
weapon is framed with fp_place and checked with fp_clips' arc_coverage through the engine's 60 degree camera.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix, Quaternion

# The first-person arms are the hero's, modelled for the camera. The third-person hero has toon arms built to read at a
# distance: 1.3x hands, 4.6 cm fingers, 15 cm forearms, 0.46 m from shoulder to wrist. Held 30 cm from the eye those fill
# the frame and swallow every grip. So first person gets its own pair in the hero's look (skin arms in the short sky-blue
# sleeve, the dark leather fingerless glove, the kit's materials and 'Col' tones) at life size: 1.8 cm fingers, a 10 cm
# palm, a 7 cm forearm. The reach is 0.60 m, longer than the body's, as first-person arms usually are: the camera never
# sees the shoulder, and the reach decides how far out a weapon can hang. fp_hero_source() builds them in the hero's body
# space (T-pose, facing -Y, palms down) on the same Mixamo bone names, tagged for fparms. The eye is the hero's (measured
# from the shipped file); the shoulders come forward and up in camera space to sit 8 cm behind and 25 cm below the eye (the
# big toon head put them 23 cm behind), the left one further forward for the support hand.
SOURCES['hero'] = dict(file=ROOT + 'assets/v2/arcade/characters/arcade-hero.glb', scale=1.0, eye=(0.0, -0.228, 1.538),
                       shoulder={'R': (0.0, 0.15, 0.12), 'L': (0.04, 0.30, 0.11)}, mesh='FP_HeroArms', arms='FP_Arms_src_heroFP',
                       remap=False, color=GRAD, build='fp_hero_source')
FP_SHOULDER, FP_ELBOW, FP_WRIST = Vector((0.20, 0.0, 1.17)), Vector((0.51, 0.0, 1.166)), Vector((0.80, 0.0, 1.165))
FP_HX = FP_WRIST.x - 0.755            # the hand is laid out for a wrist at x 0.755 and moved out to the real one
FP_KNUCKLE_X = 0.85 + FP_HX
# name, across the palm (y, the thumb is at -y), length from the knuckle, radius, knuckle x offset
FP_FINGERS = (('Index', -0.027, 0.074, 0.0092, 0.002), ('Middle', -0.009, 0.081, 0.0096, 0.004), ('Ring', 0.009, 0.076, 0.0091, 0.0),
              ('Pinky', 0.026, 0.061, 0.0082, -0.01))
FP_THUMB = tuple((x + FP_HX, y, z) for x, y, z in ((0.774, -0.028, 1.158), (0.806, -0.058, 1.153), (0.836, -0.072, 1.151)))
FP_FINGER_R = 0.0095                  # the finger contact solves stop this far from a surface: the finger's own radius


def fp_joints(x0, y, length, curl):
    """Knuckle, two finger joints and the tip of a finger along +X, curling toward the palm (-Z) by `curl` degrees."""
    pts = [Vector((x0, y, 1.166))]
    for share, phi in ((0.45, 0.25), (0.33, 0.6), (0.22, 1.0)):
        t = math.radians(curl * phi); pts.append(pts[-1] + Vector((math.cos(t), 0, -math.sin(t))) * length * share)
    return pts


def fp_skeleton():
    """{bone: (head, tail, parent, roll axis)}: the spine the skin rules read, and both arms to the finger tips."""
    B = {}
    def add(n, h, t, parent, z=(0, 0, 1)): B[J(n)] = (Vector(h), Vector(t), J(parent) if parent else None, Vector(z))
    add('Hips', (0, 0, 0.7), (0, 0, 0.8), None, (0, -1, 0)); add('Spine', (0, 0, 0.8), (0, 0, 0.92), 'Hips', (0, -1, 0))
    add('Spine1', (0, 0, 0.92), (0, 0, 1.04), 'Spine', (0, -1, 0)); add('Spine2', (0, 0, 1.04), (0, 0, 1.2), 'Spine1', (0, -1, 0))
    for S, sx in (('Left', 1), ('Right', -1)):
        m = lambda v, sx=sx: Vector((v[0] * sx, v[1], v[2]))
        add(f'{S}Shoulder', m((0.05, 0, 1.17)), m(FP_SHOULDER), 'Spine2')
        add(f'{S}Arm', m(FP_SHOULDER), m(FP_ELBOW), f'{S}Shoulder')
        add(f'{S}ForeArm', m(FP_ELBOW), m(FP_WRIST), f'{S}Arm')
        mid = next(f for f in FP_FINGERS if f[0] == 'Middle')
        add(f'{S}Hand', m(FP_WRIST), m(fp_joints(FP_KNUCKLE_X + mid[4], mid[1], mid[2], REST_CURL)[0]), f'{S}ForeArm')
        for n, y, L, r, dx in FP_FINGERS:
            j = fp_joints(FP_KNUCKLE_X + dx, y, L, REST_CURL); j.append(j[3] + (j[3] - j[2]).normalized() * 0.012)
            for k in range(4): add(f'{S}Hand{n}{k + 1}', m(j[k]), m(j[k + 1]), f'{S}Hand' if k == 0 else f'{S}Hand{n}{k}')
        th = bez(*FP_THUMB, 5); j = [th[0], th[2], th[4], th[5], th[5] + (th[5] - th[4]).normalized() * 0.012]
        for k in range(4): add(f'{S}HandThumb{k + 1}', m(j[k]), m(j[k + 1]), f'{S}Hand' if k == 0 else f'{S}HandThumb{k}')
    return B


def fp_arm_parts(M):
    """The left arm's parts in T-pose, named for hero.py's skin rules (the right mirrors in the same objects)."""
    skin, tunic, glove = M['Plaster'], M['SkyBlue'], M['WoodDark']; P = []
    P.append(uvball('L_deltoid', (0.215, 0, 1.165), 0.064, tunic, segs=16, rings=10))
    P.append(tube('L_sleeve', [(0.2, 0, 1.168), (0.33, 0, 1.166)], [0.056, 0.051], tunic, segs=16))
    P.append(torus('L_sleevehem', 0.051, 0.007, (0.332, 0, 1.166), tunic, axis='X', segs=16, rsegs=6))
    e, w = FP_ELBOW.x, FP_WRIST.x
    P.append(bare(tube('L_upper', [(0.3, 0, 1.167), ((0.3 + e) / 2, 0, 1.166), (e, 0, 1.166)], [0.043, 0.041, 0.037], skin, segs=16)))
    P.append(bare(tube('L_fore', [(e - 0.005, 0, 1.166), (e + 0.075, 0, 1.166), (e + 0.18, 0, 1.165), (w + 0.002, 0, 1.165)],
                       [0.036, 0.040, 0.034, 0.026], skin, segs=16)))
    P.append(bare(uvball('L_palm', (w + 0.045, -0.001, 1.165), 0.05, skin, scale=(1.0, 0.86, 0.34), segs=16, rings=10)))
    for n, y, L, r, dx in FP_FINGERS:
        j = fp_joints(FP_KNUCKLE_X + dx, y, L, REST_CURL)
        P.append(bare(tube(f'L_{n.lower()}', [j[0] - Vector((0.014, 0, 0))] + j, [r, r, r * 0.96, r * 0.9, r * 0.82], skin, segs=10)))
        P.append(bare(uvball(f'L_{n.lower()}tip', j[3], r * 0.82, skin, segs=10, rings=6)))          # a rounded fingertip
    th = bez(*FP_THUMB, 5)
    P.append(bare(tube('L_thumb', th, taper(0.0118, 0.0096, len(th)), skin, segs=10)))
    P.append(bare(uvball('L_thumbtip', th[-1], 0.0096, skin, segs=10, rings=6)))
    # the fingerless glove: a leather shell over the back and the palm, and a cuff at the wrist
    P.append(uvball('L_glove', (w + 0.046, -0.001, 1.165), 0.053, glove, scale=(0.97, 0.9, 0.42), segs=16, rings=10))
    P.append(tube('L_glovecuff', [(w - 0.013, 0, 1.165), (w + 0.013, 0, 1.165)], [0.029, 0.030], glove, segs=16))
    return P


def fp_hero_source():
    """The first-person arms and their armature (collection FP_Source), tagged fp_source='hero' for fparms.soldier()."""
    col = coll('FP_Source')
    for o in list(col.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)
    def make():
        B = fp_skeleton()
        arm = bpy.data.armatures.new('FP_HeroSource'); rig = bpy.data.objects.new('FP_HeroSource', arm); col.objects.link(rig)
        vl = bpy.context.view_layer
        for o in vl.objects: o.select_set(False)
        rig.select_set(True); vl.objects.active = rig
        with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[rig]):
            bpy.ops.object.mode_set(mode='EDIT')
            eb = arm.edit_bones
            for n, (h, t, parent, z) in B.items():
                b = eb.new(n); b.head = h; b.tail = t; b.align_roll(z); b.use_deform = not n.endswith(LEAVES)
                if parent: b.parent = eb[parent]; b.use_connect = False
            bpy.ops.object.mode_set(mode='OBJECT')
        for p in rig.pose.bones: p.rotation_mode = 'QUATERNION'
        M = hero_mats(); P = fp_arm_parts(M)
        skin = [o for o in P if o.get('hero_skin')]
        hero_tone(skin, SKIN_TONE); hero_tone([o for o in P if o not in skin])
        for o in P: mirror_x(o); skin_part(o, B)
        me = put(merge('FP_HeroArms', P), col); bind_to(me, rig)
        for o in (rig, me): o['fp_source'] = 'hero'
        return rig, me
    return guarded(make)


ARC_FP_OUT = OUT + '/arcade/fp/'
ARC_FP_REVIEW = OUT + '/arcade/review-work/fp'
ARMS_OUTLINE, FP_WEAPON_OUTLINE = 0.006, 0.006       # extras.arc_outline per node (the engine draws 0.4x); strings and bands carry 0
ENGINE_OUTLINE = 0.4                                 # rules.js applies the view-model shells at this multiplier


FP_ASPECT = 1200 / 740          # the review frame; the engine's view-model camera is 60 degrees vertical like arc_view()


def fp_place(point, scale, screen, dist, yaw=0.0, pitch=0.0, roll=0.0):
    """A hip pose (fp_hip arguments) that puts the weapon-local `point` (a grip) at `screen` (x right, y up, -1..1 of
    the half-frame) `dist` metres ahead of the eye, the weapon turned by yaw/pitch/roll: framing chosen on the screen."""
    ty = math.tan(math.radians(30)); tx = ty * FP_ASPECT
    target = Vector((screen[0] * tx * dist, dist, screen[1] * ty * dist))
    R = (Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Rotation(math.radians(pitch), 4, 'X') @ Matrix.Rotation(math.radians(roll), 4, 'Y')).to_3x3()
    return (tuple(target - R @ (Vector(point) * scale)), yaw, pitch, roll)


def fp_hip(t, yaw=0.0, pitch=0.0, roll=0.0):
    """Weapon origin in camera space and its turn: yaw about Z (+ muzzle left), pitch about X (+ up), roll about Y."""
    return (Matrix.Translation(t) @ Matrix.Rotation(math.radians(yaw), 4, 'Z')
            @ Matrix.Rotation(math.radians(pitch), 4, 'X') @ Matrix.Rotation(math.radians(roll), 4, 'Y'))


# Per weapon: the builder (weapons.py id), view-model scale, hip pose, elbow poles, grips (cyl_grip in weapon-local
# space), the moving-part bones [(bone, head, parent)], which builder parts each bone owns (the rest is 'Weapon'),
# the string parts skinned between two bones, the Round part, generated parts, and the hand holds on moving parts.
ARC_RIGS = {
    # Slingshot: the left hand wraps the vertical fork handle, the right pinches the drawn pouch by the cheek. The
    # bands stretch between the fork tips (Weapon) and the pouch (Pouch); the pebble rides in the pouch as 'Round'.
    # Grip_R rests at the pinch; the hold Hand_Pouch_R (a child of Pouch) is what lets the hand release and re-grab.
    # The hero's short arms and big hands rule out a cheek anchor in first person (the pinch hand would fill the
    # frame), so the ready pose is a chest-high partial draw: the pouch 3 cm short of the model's full draw (`ready`
    # moves the pouch, the pebble and the band ends there at build), and every shot completes the draw before it
    # releases. The pouch centre at the ready is (0, -0.128, 0.107).
    'Sling': dict(
        src='slingshot', scale=1.0, ready=0.03,
        hip=fp_place((0, 0, -0.075), 1.0, (-0.02, -0.72), 0.42, 48, 20, 22), sight_eye=0.42,     # the fork hand low centre-left
        poles={'R': (0.5, 0.0, -0.35), 'L': (-0.5, 0.1, -0.4)},
        # the fork hand: knuckles forward, the palm on the handle's front-left (searched: 5 degrees of twist at rest, room
        # for the reload, run and inspect turns)
        grips={'L': dict(center=(0, 0, -0.075), axis=(0, 0, 1), side=(-0.77, 0.64, 0), radius=0.024, tilt=60),
               'R': dict(center=(0, -0.128, 0.107), axis=(0, 0.42, -0.94), side=(1, -0.3, 0), radius=0.012, tilt=0)},
        parts=[('Pouch', (0, -0.128, 0.107), 'Weapon'), ('Pebble', (0, -0.116, 0.108), 'Pouch')],
        owners={'Pouch': ('pouch',)},
        round=('Pebble', ('pebble',)),
        strings={'band-1': ('Weapon', 'Pouch', (0, -0.004, 0.108), (0, -0.15, 0.107)),
                 'band1': ('Weapon', 'Pouch', (0, -0.004, 0.108), (0, -0.15, 0.107))},
        scale_bones={'Pebble': 1.0},
        trigger_finger=False,
        tilt_span={'R': 20, 'L': 15, 'Hand_Pouch_R': 20},
        attach=[('Hand_Pouch_R', 'Pouch', 'R', dict(center=(0, -0.128, 0.107), axis=(0, 0.42, -0.94), side=(1, -0.3, 0), radius=0.012, tilt=0))],
    ),
    # Repeating crossbow, worked as the real one is: the rear (right) hand pumps the lever bar over the hopper (Grip_R
    # rides the Lever, which pivots on the fore pins) and the front (left) hand holds the fore-stock under the hopper,
    # so each arm comes from its own side of the frame. The hopper is the magazine; the string's centre is a bone so it
    # can twang and be drawn by the lever stroke.
    'Repeater': dict(
        src='repeater', scale=1.0,
        hip=fp_place((0, 0, 0.165), 1.0, (0.45, -0.50), 0.40, 8, 2, -4),     # the lever hand (the weapon's top) at the lower right
        poles={'R': (0.55, -0.05, -0.3), 'L': (-0.45, 0.25, -0.5)},
        # grip orientations from a search over wrap direction, palm side and tilt for the least wrist twist and bend
        grips={'R': dict(center=(0, 0, 0.165), axis=(1, 0, 0), side=(0, -0.5, 0.87), radius=0.009, tilt=-40),
               'L': dict(center=(0, 0.16, 0.0), axis=(0, 1, 0), side=(-0.35, 0, -0.94), radius=0.026, tilt=40)},
        parts=[('Lever', (0, 0.27, 0.01), 'Weapon'), ('Mag', (0, 0.15, 0.078), 'Weapon'), ('String', (0, 0.022, 0.036), 'Weapon'),
               ('Trigger', (0, -0.055, -0.02), 'Weapon')],
        grip_parent={'R': 'Lever'},
        owners={'Lever': ('lever-1', 'lever1', 'leverbar'), 'Mag': ('hopper', 'hopband0', 'hopband1', 'flight0', 'flight1', 'flight2'),
                'Trigger': ('trigger',)},
        strings={'string-1': ('Weapon', 'String', (-0.258, 0.2, 0.015), (-0.01, 0.022, 0.036)),
                 'string1': ('Weapon', 'String', (0.258, 0.2, 0.015), (0.01, 0.022, 0.036))},
        trigger_finger=False,
        tilt_span={'R': 15, 'L': 70, 'Hand_Mag_L': 15, 'Hand_Top_L': 15},
        # the reload's holds: the left hand lifts the hopper by its flank, and slaps a new one down from above
        attach=[('Hand_Mag_L', 'Mag', 'L', dict(center=(0, 0.15, 0.078), axis=(0, -1, 0), side=(-0.5, 0, 0.87), radius=0.03, tilt=-20)),
                ('Hand_Top_L', 'Mag', 'L', dict(center=(0, 0.15, 0.121), axis=(0, -1, 0), side=(0, 0, 1), radius=0.0, tilt=-20))],   # on the seated hopper: its own surface
    ),
    # Blunderbuss: the right hand on the stock wrist behind the trigger guard, the left under the forend. The hammer
    # pivots on the lock; the powder horn and the ramrod are generated parts kept at scale 0 outside the reloads.
    'Blunderbuss': dict(
        src='blunderbuss', scale=1.0,
        hip=fp_place((0, -0.21, -0.01), 1.0, (0.64, -1.02), 0.37, 1, 1, -5),     # the stock wrist at the lower right, the barrel straight out
        poles={'R': (0.55, -0.05, -0.3), 'L': (-0.45, 0.25, -0.5)},
        # the wrist is straight and the hand comes from the hip: the palm rides the top of the wrist, the fingers wrap over
        # to the far side and the thumb lies by the hammer it re-cocks (searched: 16 degrees of twist, 5 of bend)
        grips={'R': dict(center=(0, -0.235, -0.004), axis=(0, 1, 0), side=(0.5, 0, 0.87), radius=0.03, tilt=20),     # fingers across, behind the hammer
               'L': dict(center=(0, 0.02, 0.01), axis=(0, 1, 0), side=(-0.35, 0, -0.94), radius=0.028, tilt=40)},     # clear of the lock's frizzen
        parts=[('Hammer', (0.036, -0.155, 0.02), 'Weapon'), ('Trigger', (0, -0.17, -0.025), 'Weapon'),
               ('Horn', (0, -0.28, 0.0), 'Weapon'), ('Ramrod', (0, -0.36, 0.0), 'Weapon')],     # resting inside the butt, out of sight
        owners={'Hammer': ('hammer', 'jaw'), 'Trigger': ('trigger',)},
        no_grip=('guard',),                  # the trigger guard's loop: the fingers wrap the wrist through it, as on a flintlock
        trigger_finger=False,                # the palm rides the top of the wrist: the index wraps it with the others
        extras=[('Horn', 'powder_horn'), ('Ramrod', 'ramrod')],
        scale_bones={'Horn': 0.002, 'Ramrod': 0.002},     # hidden outside the reloads (not 0: see fp_clips HIDE)
        tilt_span={'R': 10, 'L': 70, 'Hand_Horn_L': 10, 'Hand_Ramrod_L': 10, 'Hand_Barrel_R': 10},
        # the reloads swing the gun up across the body (the muzzle is 0.8 m from the wrist, twice the hero's reach), so
        # the right hand moves from the wrist to a hold under the first barrel band for them
        # oriented by fp_grip_search over the frames each is held in (the upright reload pose)
        attach=[('Hand_Horn_L', 'Horn', 'L', dict(center=(0, -0.40, 0.0), axis=(0, 1, 0), side=(-0.71, 0, -0.71), radius=0.02, tilt=80)),
                ('Hand_Ramrod_L', 'Ramrod', 'L', dict(center=(0, -0.46, 0.0), axis=(0, -1, 0), side=(-0.71, 0, -0.71), radius=0.007, tilt=-80)),
                ('Hand_Barrel_R', 'Weapon', 'R', dict(center=(0, 0.12, 0.035), axis=(0, -1, 0), side=(1, 0, 0), radius=0.03, tilt=-40))],
    ),
    # Heavy crossbow: the right hand on the pistol grip, the left under the forend. The string's centre is a bone, the
    # limbs pivot at the prod block so they flex, the crank turns on its disc (the hold on its knob orbits without
    # inheriting the turn), and the loaded bolt is 'Round'.
    'Arbalest': dict(
        src='arbalest', scale=1.0,
        hip=fp_place((0, -0.20, -0.08), 1.0, (0.56, -0.92), 0.40, 7, 2, -5),     # the trigger hand in the corner, the scope just under the eye line
        poles={'R': (0.55, -0.05, -0.3), 'L': (-0.45, 0.25, -0.5)},
        grips={'R': dict(center=(0, -0.20, -0.08), axis=(0, -0.3, -0.95), side=(1, -0.25, 0), radius=0.021, tilt=12),
               'L': dict(center=(0, 0.02, 0.005), axis=(0, 1, 0), side=(-0.35, 0, -0.94), radius=0.03, tilt=40)},
        parts=[('String', (0, 0.022, 0.04), 'Weapon'), ('Limb_L', (-0.05, 0.41, 0.012), 'Weapon'), ('Limb_R', (0.05, 0.41, 0.012), 'Weapon'),
               ('Crank', (0.037, -0.09, 0.0), 'Weapon'), ('Bolt', (0, 0.03, 0.047), 'Weapon'), ('Trigger', (0, -0.12, -0.028), 'Weapon')],
        owners={'Limb_L': ('limb-1', 'limbtip-1'), 'Limb_R': ('limb1', 'limbtip1'), 'Crank': ('crankdisc', 'crankarm', 'crankknob'),
                'Trigger': ('trigger',)},
        round=('Bolt', ('shaft', 'head', 'vane0', 'vane1', 'vane2')),
        strings={'string-1': ('Limb_L', 'String', (-0.348, 0.3, 0.012), (-0.012, 0.022, 0.04)),
                 'string1': ('Limb_R', 'String', (0.348, 0.3, 0.012), (0.012, 0.022, 0.04))},
        scale_bones={'Bolt': 1.0},
        no_inherit=('Hand_Crank_R',),
        tilt_span={'R': 40, 'L': 70, 'Hand_Crank_R': 40, 'Hand_Bolt_L': 10},
        attach=[('Hand_Crank_R', 'Crank', 'R', dict(center=(0.061, -0.09, -0.055), axis=(1, 0, 0), side=(0, 0.3, 0.95), radius=0.0095, tilt=0)),
                ('Hand_Bolt_L', 'Bolt', 'L', dict(center=(0, 0.09, 0.047), axis=(0, -1, 0), side=(-1, 0, 0), radius=0.0055, tilt=-80))],   # a pinch from the left (searched)
    ),
    # Mini cannon: held low, the right hand on the pistol grip, the left round the vertical foregrip. The fuse and its
    # spark are bones (the spark flares on the shot); the ball is a generated 'Round' seated just inside the muzzle lip.
    'Cannon': dict(
        src='cannon', scale=0.85,
        hip=fp_place((0, -0.185, -0.085), 0.85, (0.42, -0.88), 0.42, 6, 2, -4),     # the breech 29 cm out and under the eye line, the trigger hand in view
        poles={'R': (0.5, -0.1, -0.35), 'L': (-0.45, 0.25, -0.55)},
        grips={'R': dict(center=(0, -0.185, -0.085), axis=(0, -0.28, -0.96), side=(1, -0.25, 0), radius=0.022, tilt=12),
               'L': dict(center=(0, 0.06, -0.07), axis=(0, 0, 1), side=(-1, -0.3, 0), radius=0.022, tilt=0)},
        parts=[('Fuse', (0, -0.245, 0.158), 'Weapon'), ('Spark', (-0.008, -0.235, 0.22), 'Fuse'), ('Ball', (0, 0.26, 0.085), 'Weapon'),
               ('Trigger', (0, -0.12, -0.02), 'Weapon')],
        owners={'Fuse': ('fuse',), 'Spark': ('spark',), 'Trigger': ('trigger',)},
        extras=[('Ball', 'cannon_ball', 'Round')],
        scale_bones={'Spark': 1.0, 'Ball': 1.0},
        tilt_span={'R': 40, 'L': 70, 'Hand_Ball_L': 50},
        attach=[('Hand_Ball_L', 'Ball', 'L', dict(center=(0, 0.26, 0.085), axis=(0, 1, 0), side=(-0.6, 0, -0.8), radius=0.042, tilt=0))],
    ),
}


# ---------------------------------------------------------------- generated parts (weapon-local metres)

HORN_MOUTH = (0, 0.72, 0.035)       # the horn's cap when its spout is in the bell mouth (weapon-local); it rests inside the butt
ROD_MOUTH = (0, 0.70, 0.035)        # the ramrod's handle with its tip just past the muzzle; it rests inside the butt too


def _parked(ob, at, rest):
    """Move a generated part built at its working position `at` to its parked rest `rest` (both weapon-local)."""
    ob.data.transform(Matrix.Translation(Vector(rest) - Vector(at))); ob.data.update()
    return ob


def powder_horn(name):
    """A short curved horn with a dark cap and a brass spout, built cap-up on the bore line with its spout in the bell
    mouth (HORN_MOUTH is the cap), then parked inside the butt where its Horn bone rests: hidden parts rest out of
    sight, and the reload lifts it from the belt to the mouth. Short, because the hero's reach ends just past the
    bell at the reload pose."""
    M = prop_mats()
    pts = bez((0, 0.72, 0.035), (0.03, 0.63, 0.07), (0, 0.545, 0.035), 8)
    body = tube(name + '_body', pts, taper(0.026, 0.008, len(pts)), M['ButterYellow'], segs=12)
    cap = ball(name + '_cap', (0, 0.72, 0.035), 0.028, M['WoodDark'], (1, 0.7, 1))
    tip = ball(name + '_tip', (0, 0.545, 0.035), 0.011, M['Iron'])
    return _parked(merge(name, [body, cap, tip]), HORN_MOUTH, (0, -0.28, 0.0))


def ramrod(name):
    """A short wooden rod with a brass ferrule, built on the bore line with its tip just past the muzzle (ROD_MOUTH
    is the handle), parked inside the butt where its Ramrod bone rests; it rams by moving back along the bore (a toon
    rod: a full-length one would put the hand out of reach)."""
    M = prop_mats()
    rod = tube(name + '_rod', [(0, 0.70, 0.035), (0, 0.53, 0.035)], 0.006, M['Wood'], segs=8)
    knob = ball(name + '_knob', (0, 0.70, 0.035), 0.015, M['WoodDark'])
    fer = tube(name + '_ferrule', [(0, 0.56, 0.035), (0, 0.53, 0.035)], 0.0075, M['ButterYellow'], segs=8)
    return _parked(merge(name, [rod, knob, fer]), ROD_MOUTH, (0, -0.36, 0.0))


def cannon_ball(name):
    """The ball, seated just inside the muzzle lip (the bore narrows from r 0.05 at 0.29 to 0.044 at 0.24). Ink-black,
    so it reads against the grey iron barrel it is dropped into."""
    return ball(name, (0, 0.26, 0.085), 0.042, hero_mats()['Ink'])


# ---------------------------------------------------------------- the weapon, from its builder

def arc_stage():
    """The kit's materials and look in this file (the hero import brings plain copies of the same names first, and
    materials() rebuilds them in place), the review sky and sun, 30 fps."""
    materials(); set_look()
    sky(); sun()
    sc = bpy.context.scene; sc.render.fps = 30; sc.render.fps_base = 1.0


def arc_weapon(wid):
    """The static weapon's parts, painted as the shipped GLB is (build_weapons' gradient), still separate objects."""
    M = prop_mats()
    fn = next(f for w, f, _ in WEAPON_BUILDERS if w == wid)
    P, S, markers = fn(M)
    z0, z1, _, _ = _vz(P)
    vgrad([o for o in P if o.data.materials[0].name != 'ARC_Glow'], (0.8, 0.76, 0.86), lo=z0, hi=z1, local=True)
    ensure_grad(P + S)
    return P, S, markers


def skin_span(ob, a, b, p0, p1):
    """Weights along a stretch: all on bone `a` at p0 fading to bone `b` at p1 (weapon-local), so a band or string
    stretches between the two parts it joins."""
    p0, p1 = Vector(p0), Vector(p1); d = p1 - p0; L2 = d.length_squared
    ga = ob.vertex_groups.get(a) or ob.vertex_groups.new(name=a)
    gb = ob.vertex_groups.get(b) or ob.vertex_groups.new(name=b)
    for v in ob.data.vertices:
        t = max(0.0, min(1.0, (v.co - p0).dot(d) / L2))
        ga.add([v.index], 1 - t, 'REPLACE'); gb.add([v.index], t, 'REPLACE')


def _whole(ob, bone):
    ob.vertex_groups.new(name=bone).add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')


def _skin_to(ob, rig, outline, marker=None):
    ob['fp_rig'] = rig.name; ob['arc_outline'] = outline
    if marker: ob['marker'] = marker
    elif 'marker' in ob: del ob['marker']
    m = ob.modifiers.new('Armature', 'ARMATURE'); m.object = rig; ob.parent = rig
    return ob


def arc_markers(rig, Wm, markers, sight_eye=None):
    """Muzzle / Sight empties from the builder's marker table, parented to the Weapon bone in camera space. The
    view model may want its own eye relief on the Sight (a drawn slingshot sits further out than the world prop).
    They are named after the rig (FP_Sling_Muzzle): the plain names belong to weapons.py's export, which deletes
    whatever holds them; export_rig names them by their 'marker' inside the GLB."""
    out = []
    for n, (loc, props) in markers.items():
        e = bpy.data.objects.new(f'{rig.name}_{n}', None); bpy.context.scene.collection.objects.link(e)
        e.empty_display_size = 0.02; e['fp_rig'] = rig.name; e['marker'] = n
        for k, v in props.items(): e[k] = v
        if n == 'Sight' and sight_eye: e['eye'] = sight_eye
        e.matrix_world = Matrix.Translation(Wm @ Vector(loc))
        mw = e.matrix_world.copy()
        e.parent = rig; e.parent_type = 'BONE'; e.parent_bone = 'Weapon'
        bpy.context.view_layer.update(); e.matrix_world = mw
        out.append(e)
    return out


def fp_store_pose(rig, key, pose):
    rig[key] = {n: list(q) for n, q in pose.items()}


def fp_load_pose(rig, key):
    return {n: Quaternion(q) for n, q in rig[key].items()}


def arc_surface(wob):
    """The weapon's contact surface for the grips: every face but the ones in the 'NoGrip' group."""
    from mathutils.bvhtree import BVHTree
    ng = wob.vertex_groups.get('NoGrip')
    if not ng: return surface_bvh([wob])
    skip = {v.index for v in wob.data.vertices if any(x.group == ng.index for x in v.groups)}
    dg = bpy.context.evaluated_depsgraph_get(); ev = wob.evaluated_get(dg); me = ev.to_mesh()
    verts = [wob.matrix_world @ v.co for v in me.vertices]
    polys = [list(p.vertices) for p in me.polygons if not all(i in skip for i in p.vertices)]
    ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)


def arc_grip_pose(rig, wob, cfg, parts):
    """Palm snaps baked into the rig's rest, then contact finger solves for the grip and every hold:
    rig['pose_grip'] (both hands), rig['pose_<hold>'] (that hand only), rig['pose_open'] (relaxed, both hands).
    Faces in the 'NoGrip' group (a trigger guard's loop) are left out of the surface the hands and fingers meet."""
    bvh = arc_surface(wob)
    span = cfg.get('tilt_span', {})
    rig['tilt'] = {s: list(auto_tilt(rig, s, span=span.get(s, 30))) for s in ('R', 'L')}
    for att, parent, side, g in cfg.get('attach', []):
        rig['tilt'][att] = list(auto_tilt(rig, side, bone=att, att=att, span=span.get(att, 30)))
    for s in ('R', 'L'):
        snap_palm(rig, s, bvh); bake_offset(rig, f'Grip_{s}')
    bpy.context.view_layer.update()
    pose = {}
    tr = cfg.get('trigger_finger', True)
    trig = {'bvh': surface_bvh([wob], groups=['Trigger']), 'radius': 0.007} if tr else None
    pose.update(solve_fingers(rig, 'R', bvh, trigger=trig, **{'radius': FP_FINGER_R, **cfg.get('right_solve', {})}))
    pose.update(solve_fingers(rig, 'L', bvh, **{'radius': FP_FINGER_R, **cfg.get('left_solve', {})}))
    fp_store_pose(rig, 'pose_grip', pose)
    for att, parent, side, g in cfg.get('attach', []):
        pbvh = surface_bvh(parts, groups=[parent])
        c = snap_attach(rig, side, att, pbvh)
        fp_store_pose(rig, 'pose_' + att, solve_fingers(rig, side, pbvh, radius=FP_FINGER_R))
        c.influence = 0.0
    bpy.context.view_layer.update()
    opened = {}
    for n, q in pose.items():
        ax, ang = q.to_axis_angle()
        opened[n] = Quaternion(ax, min(ang, math.radians(12 if 'Thumb' in n else 18)))
    fp_store_pose(rig, 'pose_open', opened)
    apply_fingers(rig, pose)
    solve_arms(rig)                                       # the rest pose: arms on the grips, not where the last sweep left them
    return pose


def build_arc(prefix):
    """One weapon's rig: the hero arms, the weapon split over its bones, strings, the Round part, markers, holds."""
    cfg = ARC_RIGS[prefix]; name = 'FP_' + prefix
    use_source('hero')
    for o in list(bpy.data.objects):
        if o.name == name or o.name.startswith(name + '_') or o.get('fp_rig') == name:
            bpy.data.objects.remove(o, do_unlink=True)
    soldier()                                          # the hero comes in before the kit rebuilds its materials
    arc_stage()

    def make():
        Wm = fp_hip(*cfg['hip']) @ Matrix.Diagonal(Vector((cfg['scale'],) * 3).to_4d())
        P, S, markers = arc_weapon(cfg['src'])
        owners = cfg.get('owners', {}); rnd = cfg.get('round')
        base = lambda o: o.name.split('.')[0]
        rounds = [o for o in P if rnd and base(o) in rnd[1]]
        body = [o for o in P if o not in rounds]
        for o in body: _whole(o, next((b for b, names in owners.items() if base(o) in names), 'Weapon'))
        for o in body:
            if base(o) in cfg.get('no_grip', ()): _whole(o, 'NoGrip')       # not a bone: the armature ignores it, the export drops it
        for o in rounds: _whole(o, rnd[0])
        for o in S:
            spec = cfg.get('strings', {}).get(base(o))
            if spec: skin_span(o, *spec)
            else: _whole(o, 'Weapon')
        ready = cfg.get('ready', 0.0)                    # a partial draw as the rest: the pouch end of the bands moves with it
        if ready:
            for o in [o for o in body if base(o) in owners.get(cfg['parts'][0][0], ())] + rounds:
                o.data.transform(Matrix.Translation((0, ready, 0)))
            for o in S:
                gb = o.vertex_groups.get(cfg['parts'][0][0])
                if gb:
                    for v in o.data.vertices:
                        t = next((x.weight for x in v.groups if x.group == gb.index), 0.0); v.co.y += ready * t
        extras = []
        for spec in cfg.get('extras', []):              # generated parts: the powder horn, the ramrod, the cannon ball
            bone, builder = spec[:2]
            e = globals()[builder](name + '_' + builder); _whole(e, bone); e['marker'] = spec[2] if len(spec) > 2 else ''
            extras.append(e)
        ensure_grad(extras)
        wob = merge(name + '_Weapon', body)
        sob = merge(name + '_String', S) if S else None
        rob = merge(name + '_Round', rounds) if rounds else None
        meshes = [wob] + ([sob] if sob else []) + ([rob] if rob else []) + extras
        for o in meshes: o.data.transform(Wm); o.data.update()
        grips = {s: cyl_grip(**g) for s, g in cfg['grips'].items()}
        rig = build_arms_rig(name, Wm, cfg['parts'], grips, cfg.get('poles'), cfg.get('grip_parent'))
        _skin_to(wob, rig, FP_WEAPON_OUTLINE)
        if sob: _skin_to(sob, rig, 0.0)
        if rob: _skin_to(rob, rig, FP_WEAPON_OUTLINE, marker='Round')
        for e in extras: _skin_to(e, rig, FP_WEAPON_OUTLINE, marker=e['marker'] or None)
        if cfg.get('scale_bones'): rig['scale_bones'] = dict(cfg['scale_bones'])
        arc_markers(rig, Wm, markers, cfg.get('sight_eye'))
        aob = bind_arms(rig, name + '_Arms'); aob['fp_rig'] = name; aob['arc_outline'] = ARMS_OUTLINE
        col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
        if col.name not in bpy.context.scene.collection.children: bpy.context.scene.collection.children.link(col)
        col.hide_viewport = col.hide_render = False        # a hidden collection is not evaluated: every solve below would read stale bones
        for o in [rig] + [o for o in bpy.data.objects if o.get('fp_rig') == name]:
            for c in list(o.users_collection): c.objects.unlink(o)
            col.objects.link(o)
        for att, parent, side, g in cfg.get('attach', []):
            add_attach(rig, Wm, side, att, parent, cyl_grip(**g))
        for att in cfg.get('no_inherit', ()):            # a hold that orbits with its part but keeps its own orientation (the crank knob)
            rig.data.bones[att].use_inherit_rotation = False
        arc_grip_pose(rig, wob, cfg, meshes)
        for o in meshes + [aob]:                         # the engine's outlines, for the viewport and the reviews (export skips modifiers)
            if o['arc_outline'] > 0: outline(o, o['arc_outline'] * ENGINE_OUTLINE)
        return rig, meshes + [aob]
    rig, meshes = guarded(make)
    return {'tris': tris(meshes), 'bones': len(rig.data.bones),
            'arms': {s: list(rig['tilt'][s]) for s in rig['tilt'].keys()}, 'elbows': elbow_report(rig)}


def arc_outlines(prefix, on):
    """Show or hide the viewport outline shells of one rig (off around an export and the pose-sheet tiles)."""
    for o in bpy.data.objects:
        if o.get('fp_rig') == 'FP_' + prefix and o.modifiers.get('ARC_Outline'):
            o.modifiers['ARC_Outline'].show_viewport = o.modifiers['ARC_Outline'].show_render = on


# ---------------------------------------------------------------- grip orientation searches (how the grips above were chosen)

def fp_hold_cost(tw, sw, short):
    """The arm solver's discomfort: wrist twist past 35 degrees, wrist bend past 40, and any reach shortfall."""
    return max(0, abs(tw) - 35) + 1.6 * max(0, sw - 40) + 4000 * short


def fp_sphere(step=45, lat=(-45, 0, 45)):
    """Palm-side candidates round a grip: unit vectors on a coarse sphere."""
    return [(math.cos(math.radians(a)) * math.cos(math.radians(b)), math.sin(math.radians(b)), math.sin(math.radians(a)) * math.cos(math.radians(b)))
            for a in range(-180, 180, step) for b in lat]


def fp_grip_search(prefix, s, center, radius, axes, sides, tilts, att=None, action=None, top=4):
    """Score cyl_grip orientations (cylinder axis x palm side x tilt) for one hand by fp_hold_cost: at the rest pose,
    or, with `att` and `action`, over every frame of the clip where that hold is fully on (the pose it is used in)."""
    rig = bpy.data.objects['FP_' + prefix]; arc_show(prefix, action, 0)
    cfg = ARC_RIGS[prefix]
    Wm = fp_hip(*cfg['hip']) @ Matrix.Diagonal(Vector((cfg['scale'],) * 3).to_4d()); W3 = Wm.to_3x3()
    ik = rig.pose.bones[f'IK_Hand_{s}']; frames = [(0, Matrix.Identity(4))]; con = None
    if att:
        parent = next(a[1] for a in cfg['attach'] if a[0] == att); con = ik.constraints['Att_' + att]; frames = []
        for f in range(0, int(bpy.data.actions[action].frame_range[1]) + 1, 2):
            bpy.context.scene.frame_set(f); bpy.context.view_layer.update()
            if con.influence > 0.95:
                pbp = rig.pose.bones[parent]; frames.append((f, (rig.matrix_world @ pbp.matrix) @ pbp.bone.matrix_local.inverted()))
    else:
        for pb in rig.pose.bones: pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0)
    res = []
    for ax in axes:
        for sd in sides:
            for tilt in tilts:
                wrist, d, palm = cyl_grip(center, ax, sd, radius, tilt)
                H0 = hand_matrix(s, Wm @ Vector(wrist), W3 @ Vector(d), W3 @ Vector(palm)); worst = (-1, None)
                for f, P in frames[::2] or frames:
                    if att: bpy.context.scene.frame_set(f); con.mute = True
                    ik.matrix = P @ H0; bpy.context.view_layer.update()
                    _, tw, sw, short = solve_side(rig, s); c = fp_hold_cost(tw, sw, short)
                    if c >= worst[0]: worst = (c, (f, tw, sw, round(short, 3)))
                    if con: con.mute = False
                res.append((round(worst[0], 1), ax, tuple(round(x, 2) for x in sd), tilt, worst[1]))
    ik.location = (0, 0, 0); ik.rotation_quaternion = (1, 0, 0, 0); bpy.context.view_layer.update()
    return sorted(res, key=lambda r: r[0])[:top]
