"""Procedural first-person clips for fparms rigs (FP_<PREFIX>). exec after fparms.py and arcade/fp_rigs.py.

Every clip keys the SAME channels on every frame (weapon bones, grips, camera, shoulders, all finger bones, every
Att_* hand-hold influence), so clips blend cleanly in any engine and the glTF export needs no guessing.
Loop clips are periodic: frame `length` equals frame 0.

Units: metres and degrees. Weapon-aligned bones (Weapon, parts, Grip_*) move in weapon axes: x right, y toward
the muzzle, z up; rotations (pitch about x: + muzzle up, roll about y: + top to the right, yaw about z: + muzzle left).
"""
import bpy, math, random
from mathutils import Vector, Quaternion, Euler

FPS = 30
TAU = math.pi * 2


# ---------------------------------------------------------------- easing

def c01(t): return max(0.0, min(1.0, t))
def ease_smooth(t): t = c01(t); return t * t * (3 - 2 * t)
def ease_io(t): t = c01(t); return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2
def ease_in(t): t = c01(t); return t ** 3
def ease_out(t): t = c01(t); return 1 - (1 - t) ** 3
def back_out(t, s=1.5): t = c01(t) - 1; return 1 + (s + 1) * t ** 3 + s * t ** 2
EASE = {'io': ease_io, 'i': ease_in, 'o': ease_out, 'l': c01, 's': ease_smooth, 'b': back_out}


def win(f, a, b, e='io'):
    """0 before frame a, 1 after b, eased between."""
    return EASE[e]((f - a) / max(1e-6, b - a))


def pulse(f, a, b, c, d, e='io'):
    """0 → 1 over a..b, hold, 1 → 0 over c..d."""
    return win(f, a, b, e) * (1 - win(f, c, d, e))


def kick(f, freq=3.0, damp=0.42, delay=0.0):
    """Unit recoil impulse (damped spring, peak 1 at ~2 frames, small overshoot, settles by ~9 frames)."""
    t = (f - delay) / FPS
    if t <= 0: return 0.0
    w = TAU * freq; wd = w * math.sqrt(1 - damp * damp)
    tp = math.atan2(wd, damp * w) / wd
    peak = math.exp(-damp * w * tp) * math.sin(wd * tp)
    return math.exp(-damp * w * t) * math.sin(wd * t) / peak


class Track:
    """Keyed values with per-segment easing: [(frame, value, ease_into_this_key)], value float or tuple."""
    def __init__(self, keys): self.k = sorted(keys, key=lambda k: k[0])
    def __call__(self, f):
        k = self.k
        if f <= k[0][0]: return k[0][1]
        for (f0, v0, _), (f1, v1, e) in zip(k, k[1:]):
            if f <= f1:
                t = EASE[e]((f - f0) / max(1e-6, f1 - f0))
                if isinstance(v0, (tuple, list)): return tuple(a + (b - a) * t for a, b in zip(v0, v1))
                return v0 + (v1 - v0) * t
        return k[-1][1]


def V(*a): return Vector(a if len(a) == 3 else a[0])


# ---------------------------------------------------------------- poses

def pose(rig, key):
    return {n: Quaternion(q) for n, q in rig[key].items()}


def mix(a, b, t):
    """Slerp pose b over pose a (only bones b defines)."""
    out = dict(a)
    for n, q in b.items(): out[n] = a.get(n, Quaternion()).slerp(q, c01(t))
    return out


def curl(p, bone, deg):
    """Extra curl on a finger bone about its own solved axis (trigger squeeze, idle fidget)."""
    q = p.get(bone)
    if q is None: return p
    ax, ang = q.to_axis_angle()
    if ang < 1e-4: return p
    p = dict(p); p[bone] = Quaternion(ax, ang + math.radians(deg)); return p


class State:
    def __init__(self):
        self.loc = {}; self.rot = {}; self.scale = {}; self.infl = {}; self.fingers = None
    def add(self, bone, loc=None, rot=None):
        if loc is not None: self.loc[bone] = self.loc.get(bone, Vector()) + Vector(loc)
        if rot is not None: self.rot[bone] = self.rot.get(bone, Vector()) + Vector(rot)
        return self


# ---------------------------------------------------------------- authoring

def channels(rig):
    fingers = [p.name for p in rig.pose.bones if 'Hand' in p.name and p.name[-1] in '123' and not p.name.startswith('IK')]
    skip = set(fingers) | {'Root'} | {p.name for p in rig.pose.bones if p.name.startswith(('IK_', 'Pole_', 'Hand_'))}
    skip |= {p.name for p in rig.pose.bones if p.name.startswith(('Left', 'Right'))}
    bones = [p.name for p in rig.pose.bones if p.name not in skip]
    cons = [(p.name, c.name) for p in rig.pose.bones for c in p.constraints if c.name.startswith('Att_')]
    return bones, fingers, cons


def author(rig, name, length, fn, loop=False):
    old = bpy.data.actions.get(name)
    if old: bpy.data.actions.remove(old)
    act = bpy.data.actions.new(name); act.use_fake_user = True
    ad = rig.animation_data or rig.animation_data_create(); ad.action = act
    bones, fingers, cons = channels(rig)
    grip = pose(rig, 'pose_grip'); scaled = dict(rig.get('scale_bones', {}))
    prev = None; stats = {'twist': 0, 'swing': 0, 'short': 0.0}
    for f in range(length + 1):
        st = fn(f)
        for b in bones:
            pb = rig.pose.bones[b]
            pb.location = st.loc.get(b, Vector())
            r = st.rot.get(b)
            pb.rotation_quaternion = Euler([math.radians(a) for a in r], 'YXZ').to_quaternion() if r is not None else Quaternion()
            pb.keyframe_insert('location', frame=f); pb.keyframe_insert('rotation_quaternion', frame=f)
            if b in scaled:
                s = st.scale.get(b, scaled[b]); pb.scale = (s, s, s); pb.keyframe_insert('scale', frame=f)
        fp = st.fingers or grip
        for n in fingers:
            pb = rig.pose.bones[n]; pb.rotation_quaternion = fp.get(n, Quaternion())
            pb.keyframe_insert('rotation_quaternion', frame=f)
        for b, cn in cons:
            c = rig.pose.bones[b].constraints[cn]; c.influence = c01(st.infl.get(cn, 0.0))
            c.keyframe_insert('influence', frame=f)
        prev = solve_arms(rig, prev, key=f)
        for s_, r in prev.items():
            stats['twist'] = max(stats['twist'], abs(r[1])); stats['swing'] = max(stats['swing'], r[2])
            stats['short'] = max(stats['short'], r[3])
    act['arm_stats'] = stats
    for fc in _fcurves(act):
        for k in fc.keyframe_points: k.interpolation = 'LINEAR'
    act.use_frame_range = True; act.frame_start = 0; act.frame_end = length
    act['loop'] = bool(loop)
    return act


def _fcurves(act):
    try: return list(act.fcurves)
    except AttributeError:
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags: out += list(cb.fcurves)
        return out


def arm_report(acts):
    """Worst wrist twist / wrist bend (degrees) and reach shortfall (m) per clip, from the solver while authoring."""
    return {a.name: dict(a['arm_stats']) for a in acts}


# ---------------------------------------------------------------- shared motion layers

def breathe(st, f, n, amp=1.0):
    """Idle drift: two incommensurate sines per axis, periodic over n frames."""
    p = TAU * f / n
    st.add('Weapon', loc=(0.0008 * amp * math.sin(p + 0.7), 0.0004 * amp * math.sin(2 * p),
                          0.0013 * amp * math.sin(p) + 0.0005 * amp * math.sin(2 * p + 1.0)),
           rot=(0.35 * amp * math.sin(p + 0.3), 0.4 * amp * math.sin(p + 1.9), 0.25 * amp * math.sin(p + 2.4)))
    st.add('Shoulders', loc=(0, 0, 0.0012 * amp * math.sin(p)))
    return st


def gait(st, f, n, P, run=False):
    """Two footfalls per cycle: vertical dips on each step, lateral sway, roll/yaw with the stepping foot."""
    p = TAU * f / n
    a = P['run_amp'] if run else P['walk_amp']
    st.add('Weapon', loc=(0.007 * a * math.sin(p), 0.002 * a * math.cos(2 * p), -0.005 * a * (1 - math.cos(2 * p)) / 2 * 2 + 0.003 * a),
           rot=(0.7 * a * math.cos(2 * p), 1.5 * a * math.sin(p), 0.9 * a * math.sin(p + 0.5)))
    st.add('Shoulders', loc=(0.003 * a * math.sin(p), 0, -0.002 * a * (1 - math.cos(2 * p))))
    return st


def recoil(st, f, P, var):
    """One shot: rearward kick + muzzle climb + per-variant roll/yaw, bolt cycle, trigger, index squeeze, camera kick."""
    k = kick(f, P['freq'], P['damp'])
    rs, ys = var
    st.add('Weapon', loc=(0.002 * rs, -P['kick'] * k, P['kick_up'] * k),
           rot=(P['climb'] * k, P['roll'] * rs * k, P['yaw'] * ys * k))
    st.add('Shoulders', loc=(0, -P['kick'] * 0.35 * k, 0))
    st.add('Camera', rot=(P['cam'] * k, 0, P['cam'] * 0.3 * ys * k))
    if 'Bolt' in P.get('cycle', ('Bolt',)):
        st.add(P.get('bolt_bone', 'Bolt'), loc=(0, -P['bolt'] * pulse(f, 0, 1, 1.5, 3.5, 'o'), 0))
    st.add('Trigger', rot=(-16 * pulse(f, 0, 0.8, 2, 4), 0, 0))
    return k


# ---------------------------------------------------------------- rifle set (AK / M4)

def left(p): return {n: q for n, q in p.items() if n.startswith('Left')}


def base_clips(rig, prefix, P, shoot_extra=None):
    """Idle, Walk, Run, Equip, Unequip and three Shoot variants, shared by every weapon class.
    shoot_extra(st, f, var) adds class layers to a shot (pump rack, warhead launch)."""
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open')
    acts = []
    n_idle = P.get('idle_frames', 60); amp = P.get('idle_amp', 1.0)

    def idle(f):
        st = breathe(State(), f, n_idle, amp)
        st.fingers = curl(grip, 'LeftHandIndex1', 4 * max(0, math.sin(TAU * f / n_idle * 2)) ** 4)
        return st
    acts.append(author(rig, f'{prefix}_Idle', n_idle, idle, loop=True))

    n_walk = P.get('walk_frames', 36)
    def walk(f):
        return gait(breathe(State(), f, n_walk, 0.4 * amp), f, n_walk, P)
    acts.append(author(rig, f'{prefix}_Walk', n_walk, walk, loop=True))

    SP = P['sprint']; n_run = P.get('run_frames', 24); ra = P.get('run_amp', 1.0)
    def run(f):
        st = State().add('Weapon', loc=SP['loc'], rot=SP['rot'])
        st.add('Shoulders', loc=(0, -0.02, -0.02))
        p = TAU * f / n_run
        st.add('Weapon', loc=(0.016 * ra * math.sin(p), 0.006 * ra * math.cos(2 * p), 0.012 * ra * math.cos(2 * p)),
               rot=(3 * ra * math.cos(2 * p), 4 * ra * math.sin(p), 5 * ra * math.sin(p + 0.6)))
        st.add('Shoulders', loc=(0.008 * ra * math.sin(p), 0.006 * ra * math.sin(p + 1.2), 0.006 * ra * math.cos(2 * p)))
        return st
    acts.append(author(rig, f'{prefix}_Run', n_run, run, loop=True))

    OFF = P.get('off', dict(loc=(0.04, -0.12, -0.28), rot=(-50, 25, 30)))
    GL = P.get('off_grip_l', (-0.05, -0.09, -0.09))
    eq_n = P.get('equip_frames', 20)
    def equip(f):
        t = back_out(c01(f / (eq_n - 4)), P.get('equip_back', 1.2))
        st = State().add('Weapon', loc=tuple(a * (1 - t) for a in OFF['loc']), rot=tuple(a * (1 - t) for a in OFF['rot']))
        h = win(f, eq_n * 0.35, eq_n * 0.8)                     # support hand arrives after the gun is up
        st.add('Grip_L', loc=tuple(a * (1 - h) for a in GL), rot=(0, -25 * (1 - h), 0))
        st.fingers = mix(grip, left(opened), 1 - win(f, eq_n * 0.55, eq_n * 0.9))
        st.add('Camera', rot=(-0.6 * pulse(f, eq_n * 0.6, eq_n * 0.75, eq_n * 0.75, eq_n), 0, 0))
        return st
    acts.append(author(rig, f'{prefix}_Equip', eq_n, equip))

    def unequip(f):
        h = win(f, 0, eq_n * 0.35)
        t = ease_in(c01((f - eq_n * 0.15) / (eq_n * 0.85)))
        st = State().add('Weapon', loc=tuple(a * t for a in OFF['loc']), rot=tuple(a * t for a in OFF['rot']))
        st.add('Grip_L', loc=tuple(a * h for a in GL), rot=(0, -25 * h, 0))
        st.fingers = mix(grip, left(opened), h)
        return st
    acts.append(author(rig, f'{prefix}_Unequip', eq_n, unequip))

    rnd = random.Random(prefix)
    for tag, var in (('', (1.0, 0.6)), ('_B', (-0.7, -0.9)), ('_C', (0.4, 0.2))):
        var = (var[0] * (0.85 + 0.3 * rnd.random()), var[1] * (0.85 + 0.3 * rnd.random()))
        def shoot(f, var=var):
            st = State()
            recoil(st, f, P, var)
            sq = pulse(f, 0, 0.8, 2, 5)
            st.fingers = curl(curl(grip, 'RightHandIndex2', 14 * sq), 'RightHandIndex3', 8 * sq)
            if shoot_extra: shoot_extra(st, f, var)
            return st
        acts.append(author(rig, f'{prefix}_Shoot{tag}', P['shoot_frames'], shoot))
    return acts


def rifle_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open')
    mag = pose(rig, 'pose_Hand_Mag_L') if 'pose_Hand_Mag_L' in rig else grip
    boltp = pose(rig, 'pose_Hand_Bolt_L') if 'pose_Hand_Bolt_L' in rig else opened
    acts = base_clips(rig, prefix, P)
    for empty in (False, True):
        acts.append(author(rig, f'{prefix}_Reload{"Empty" if empty else ""}', P['reload_empty' if empty else 'reload'],
                           rifle_reload(rig, P, grip, opened, mag, boltp, empty)))
    acts.append(author(rig, f'{prefix}_Inspect', P['inspect'], rifle_inspect(P, grip, opened, mag)))
    return acts


def rifle_reload(rig, P, grip, opened, mag, boltp, empty):
    """Tilt, left hand to the magazine, rock it out and away, new one up and rocked in, slap; empty adds the
    left hand over the top to rack the handle (AK) / slap the bolt catch (M4). Timed off P['R'] beats."""
    B = P['beats_empty' if empty else 'beats']
    L = lambda p: {n: q for n, q in p.items() if n.startswith('Left')}
    tilt = P['reload_tilt']; out = P['mag_out']
    n = P['reload_empty' if empty else 'reload']

    def fn(f):
        st = State()
        # weapon: roll the magazine toward the support hand, dip on the seat, back to hip
        w = win(f, 0, B['tilt']) * (1 - win(f, B['back'], n - 4))
        st.add('Weapon', loc=(-0.02 * w, -0.01 * w, 0.015 * w), rot=(tilt[0] * w, tilt[1] * w, tilt[2] * w))
        seat = pulse(f, B['seat'] - 2, B['seat'], B['seat'], B['seat'] + 5, 'o')
        st.add('Weapon', loc=(0, 0, 0.012 * seat), rot=(-2.5 * seat, 0, 0))
        # left hand: handguard → magazine (arc under), with it out and back in, → handguard
        grab = win(f, B['reach'], B['grab']) * (1 - win(f, B['release'], B['release'] + 5))
        st.infl['Att_Hand_Mag_L'] = grab
        arc = pulse(f, B['reach'], (B['reach'] + B['grab']) / 2, (B['reach'] + B['grab']) / 2, B['grab'])
        arc2 = pulse(f, B['release'], B['release'] + 3, B['release'] + 3, B['regrip'])
        st.add('Grip_L', loc=(-0.03 * (arc + arc2), -0.02 * arc, -0.06 * (arc + arc2)))
        # magazine: rock + drop out, travel off-screen, return, rock in
        rock_out = win(f, B['grab'], B['grab'] + 5)
        away = win(f, B['grab'] + 4, B['away'], 'i') * (1 - win(f, B['away'] + 2, B['back_in'], 'o'))
        rock_in = win(f, B['back_in'], B['seat'], 'o')
        r = rock_out * (1 - rock_in)
        st.add('Mag', loc=(0, out[1] * r + 0.06 * away, out[2] * r - 0.32 * away), rot=(out[0] * r - 35 * away, 12 * away, 0))
        # fingers
        lp = grip
        lp = mix(lp, L(opened), win(f, B['reach'] - 2, B['reach'] + 3))
        lp = mix(lp, L(mag), win(f, B['grab'] - 3, B['grab']))
        lp = mix(lp, L(opened), win(f, B['release'], B['release'] + 3))
        lp = mix(lp, L(grip), win(f, B['regrip'] - 3, B['regrip']))
        if empty:
            # support hand over the top onto the handle / catch, rack, back to the handguard
            b0, b1, b2, b3 = B['bolt']
            hold = win(f, b0, b1) * (1 - win(f, b2 + 1, b3 - 2))
            st.infl['Att_Hand_Bolt_L'] = hold
            over = pulse(f, b0, (b0 + b1) / 2, (b0 + b1) / 2, b1) + pulse(f, b2 + 1, (b2 + b3) / 2, (b2 + b3) / 2, b3)
            st.add('Grip_L', loc=(0.04 * over, -0.02 * over, 0.12 * over))
            st.add('Bolt', loc=(0, -P['bolt'] * 1.1 * win(f, b1, b2, 'io') * (1 - win(f, b2, b2 + 1.2, 'l')), 0))
            st.add('Weapon', rot=(0, P['rack_roll'] * pulse(f, b0 - 4, b1, b2 + 2, b3 + 4), 0))
            snap = pulse(f, b2, b2 + 1, b2 + 1, b2 + 6, 'o')
            st.add('Weapon', loc=(0, -0.006 * snap, 0.004 * snap), rot=(1.5 * snap, 0, 0))
            lp = mix(lp, L(boltp), win(f, b1 - 3, b1) * (1 - win(f, b2 + 1, b2 + 4)))
        st.fingers = lp
        st.add('Camera', rot=(0.5 * seat, 0, 0.3 * seat))
        return st
    return fn


def rifle_inspect(P, grip, opened, mag):
    n = P['inspect']
    L = lambda p: {n_: q for n_, q in p.items() if n_.startswith('Left')}
    k1 = P['insp_right']; k2 = P['insp_left']
    loc = Track([(0, (0, 0, 0), 'l'), (18, k1[0], 'io'), (48, k1[0], 'l'), (70, k2[0], 'io'), (92, k2[0], 'l'), (n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])
    rot = Track([(0, (0, 0, 0), 'l'), (18, k1[1], 'io'), (48, tuple(a * 1.08 for a in k1[1]), 's'), (70, k2[1], 'io'),
                 (92, tuple(a * 1.05 for a in k2[1]), 's'), (n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])

    def fn(f):
        st = State().add('Weapon', loc=loc(f), rot=rot(f))
        breathe(st, f, n, 0.6)
        # mag check on the left-side beat: palm the magazine, give it a tug, back to the handguard
        m = win(f, 74, 80) * (1 - win(f, 88, 94))
        st.infl['Att_Hand_Mag_L'] = m
        tug = pulse(f, 81, 83, 84, 87, 's')
        st.add('Mag', loc=(0, 0.004 * tug, -0.012 * tug), rot=(4 * tug, 0, 0))
        st.add('Grip_L', loc=(-0.02 * pulse(f, 72, 77, 77, 80) - 0.02 * pulse(f, 88, 91, 91, 95), 0,
                              -0.04 * pulse(f, 72, 77, 77, 80) - 0.04 * pulse(f, 88, 91, 91, 95)))
        lp = mix(grip, L(opened), win(f, 72, 76) * (1 - win(f, 92, 97)))
        lp = mix(lp, L(mag), m)
        st.fingers = curl(lp, 'RightHandIndex1', -8 * win(f, 10, 20) * (1 - win(f, n - 16, n - 6)))
        return st
    return fn


# ---------------------------------------------------------------- pistol

def pistol_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open')
    magp = pose(rig, 'pose_Hand_Mag_L'); slidep = pose(rig, 'pose_Hand_Slide_L')
    acts = base_clips(rig, prefix, P)
    for empty in (False, True):
        n = P['reload_empty'] if empty else P['reload']

        def fn(f, empty=empty, n=n):
            st = State()
            w = win(f, 0, 7) * (1 - win(f, n - 14, n - 3))
            t = P['reload_tilt']
            st.add('Weapon', loc=(-0.015 * w, -0.03 * w, 0.02 * w), rot=(t[0] * w, t[1] * w, t[2] * w))
            # magazine: drops free, returns from below in the hand, seats
            drop = win(f, 4, 13, 'i')
            up = win(f, 16, 27, 'o'); seat = win(f, 27, 30, 'o')
            z = -0.26 * drop * (1 - up) - 0.06 * up * (1 - seat)
            st.add('Mag', loc=(0, -0.012 * drop * (1 - seat), z))
            hold = win(f, 13, 16) * (1 - win(f, 31, 35))
            st.infl['Att_Hand_Mag_L'] = hold
            away = win(f, 2, 12) * (1 - win(f, 13, 17)) + pulse(f, 31, 35, 35, 42)
            st.add('Grip_L', loc=(-0.05 * away, -0.04 * away, -0.16 * away))
            lp = mix(grip, left(opened), win(f, 2, 6) * (1 - win(f, 38, 42)))
            lp = mix(lp, left(magp), hold)
            bump = pulse(f, 28, 30, 30, 35, 'o')
            st.add('Weapon', loc=(0, 0, 0.01 * bump), rot=(-3 * bump, 0, 0))
            if empty:
                # slide locked back from the start; left hand over the top, pull, release, back to the cup
                rack = win(f, 40, 45) * (1 - win(f, 49, 53))
                st.infl['Att_Hand_Slide_L'] = rack
                over = pulse(f, 38, 41, 41, 45) + pulse(f, 49, 52, 52, 56)
                st.add('Grip_L', loc=(-0.05 * over, -0.03 * over, 0.04 * over))
                dip = pulse(f, 36, 41, 50, 56)                   # bring the slide down and across to the hand
                st.add('Weapon', loc=(-0.02 * dip, -0.02 * dip, -0.05 * dip), rot=(0, -18 * dip, 8 * dip))
                back = 1 - win(f, 47.5, 48.5, 'l')
                st.add('Slide', loc=(0, -P['bolt'] * (back + 0.25 * pulse(f, 45, 47, 47, 48)), 0))
                lp = mix(lp, left(slidep), rack)
                snap = pulse(f, 48, 49, 49, 54, 'o')
                st.add('Weapon', loc=(0, -0.006 * snap, 0.004 * snap), rot=(2 * snap, 0, 0))
            st.fingers = lp
            return st
        acts.append(author(rig, f'{prefix}_Reload{"Empty" if empty else ""}', n, fn))

    n = P['inspect']
    loc = Track([(0, (0, 0, 0), 'l'), (16, (-0.03, -0.04, 0.03), 'io'), (38, (-0.03, -0.04, 0.03), 'l'), (54, (-0.02, -0.05, 0.03), 'io'),
                 (78, (-0.02, -0.05, 0.03), 'l'), (n - 4, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])
    rot = Track([(0, (0, 0, 0), 'l'), (16, (8, -45, 22), 'io'), (38, (10, -50, 25), 's'), (54, (4, 50, -12), 'io'),
                 (78, (6, 54, -14), 's'), (n - 4, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])

    def inspect(f):
        st = State().add('Weapon', loc=loc(f), rot=rot(f)); breathe(st, f, n, 0.5)
        chk = win(f, 58, 62) * (1 - win(f, 72, 76))             # press check on the left-side beat
        st.infl['Att_Hand_Slide_L'] = chk
        st.add('Slide', loc=(0, -0.012 * pulse(f, 63, 66, 68, 71, 's'), 0))
        st.add('Grip_L', loc=(0, 0, 0.08 * (pulse(f, 55, 58, 58, 62) + pulse(f, 72, 75, 75, 79))))
        st.fingers = mix(mix(grip, left(opened), pulse(f, 55, 58, 76, 80)), left(slidep), chk)
        return st
    acts.append(author(rig, f'{prefix}_Inspect', n, inspect))
    return acts


# ---------------------------------------------------------------- shotgun

def shotgun_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open'); shellp = pose(rig, 'pose_Hand_Shell_L')
    PB = P['pump']

    def pump_rack(st, f, var=None, at=9):
        """Pump back and forward with a weapon dip; `at`: first frame of the stroke."""
        back = win(f, at, at + 4) * (1 - win(f, at + 5, at + 9))
        st.add('Pump', loc=(0, -PB * back, 0))
        st.add('Weapon', loc=(0, -0.006 * back, -0.006 * back), rot=(-1.5 * back, 4 * back, 0))
        st.add('Camera', rot=(0.3 * back, 0, 0))
    acts = base_clips(rig, prefix, P, shoot_extra=pump_rack)

    def port_cycle(st, f, t0):
        """One shell from below the screen into the loading port: rise, push up and forward, gone."""
        rise = win(f, t0, t0 + 7, 'o'); push = win(f, t0 + 7, t0 + 11)
        drop = win(f, t0 + 11, t0 + 16, 'i')
        z = -0.24 * (1 - rise) + 0.04 * push - 0.2 * drop
        y = -0.03 * (1 - push) + 0.045 * push * (1 - drop) - 0.03 * drop
        st.add('Shell', loc=(0.012 * (1 - rise), y, z))
        st.scale['Shell'] = 0.0 if (push > 0.97 and f < t0 + 16) else 1.0

    for empty in (False, True):
        n = P['reload_empty'] if empty else P['reload']

        def fn(f, empty=empty, n=n):
            st = State()
            w = win(f, 0, 8) * (1 - win(f, n - 14, n - 2))
            t = P['reload_tilt']
            st.add('Weapon', loc=(-0.02 * w, -0.01 * w, 0.02 * w), rot=(t[0] * w, t[1] * w, t[2] * w))
            if empty:
                # open the action, drop one into the ejection port, close, then two into the loading port
                st.add('Pump', loc=(0, -PB * win(f, 6, 10) * (1 - win(f, 34, 38)), 0))
                hold = win(f, 12, 16) * (1 - win(f, 28, 32)) + win(f, 40, 44) * (1 - win(f, 72, 76))
                a = win(f, 14, 22, 'o'); d = win(f, 22, 27, 'i')
                if f < 34:
                    st.add('Shell', loc=(0.035 * (1 - d) + 0.02 * (1 - a), -0.02, 0.09 * (1 - d) - 0.22 * (1 - a) + 0.045 * d))
                    st.scale['Shell'] = 1.0 if 12 <= f < 27 else 0.0
                else:
                    for t0 in (42, 58):
                        if t0 - 2 <= f < t0 + 16: port_cycle(st, f, t0)
                st.infl['Att_Hand_Shell_L'] = hold
                away = pulse(f, 10, 13, 13, 16) + pulse(f, 28, 31, 31, 34) + pulse(f, 38, 41, 41, 44) + pulse(f, 72, 75, 75, 79)
                chamber = pulse(f, 34, 36, 36, 40, 'o')
                st.add('Weapon', loc=(0, -0.006 * chamber, 0), rot=(1.2 * chamber, 0, 0))
            else:
                hold = win(f, 4, 8) * (1 - win(f, 56, 60))
                for t0 in (8, 24, 40):
                    if t0 - 2 <= f < t0 + 16: port_cycle(st, f, t0)
                st.infl['Att_Hand_Shell_L'] = hold
                away = pulse(f, 2, 5, 5, 8) + pulse(f, 56, 59, 59, 64)
            st.add('Grip_L', loc=(-0.03 * away, -0.08 * away, -0.08 * away))
            lp = mix(grip, left(opened), c01(away * 1.5))
            st.fingers = mix(lp, left(shellp), hold)
            return st
        acts.append(author(rig, f'{prefix}_Reload{"Empty" if empty else ""}', n, fn))

    n = P['inspect']
    loc = Track([(0, (0, 0, 0), 'l'), (22, (-0.05, 0.0, 0.04), 'io'), (50, (-0.05, 0.0, 0.04), 'l'), (74, (-0.03, 0.0, 0.03), 'io'),
                 (98, (-0.03, 0.0, 0.03), 'l'), (n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])
    rot = Track([(0, (0, 0, 0), 'l'), (22, (10, -48, 24), 'io'), (50, (12, -52, 26), 's'), (74, (4, 44, -10), 'io'),
                 (98, (5, 47, -11), 's'), (n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])

    def inspect(f):
        st = State().add('Weapon', loc=loc(f), rot=rot(f)); breathe(st, f, n, 0.6)
        chk = pulse(f, 80, 84, 88, 93)                       # half-rack to check the chamber
        st.add('Pump', loc=(0, -PB * 0.45 * chk, 0))
        return st
    acts.append(author(rig, f'{prefix}_Inspect', n, inspect))
    return acts


# ---------------------------------------------------------------- launcher

def launcher_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open'); whp = pose(rig, 'pose_Hand_Warhead_L')

    def launch(st, f, var):
        go = win(f, 0, 2, 'l')
        st.add('Warhead', loc=(0, 1.8 * go, 0))
        st.scale['Warhead'] = 0.0 if f >= 2 else 1.0
        k = kick(f, 5.0, 0.3)                                # the blast shakes the camera harder than the recoil
        st.add('Camera', rot=(0.8 * k * var[1], 0.6 * k, 0.8 * k * var[0]))
    acts = base_clips(rig, prefix, P, shoot_extra=launch)

    n = P['reload']

    def reload(f):
        st = State()
        w = win(f, 0, 14) * (1 - win(f, 64, n - 2))
        t = P['reload_tilt']
        st.add('Weapon', loc=(-0.04 * w, 0.0, -0.03 * w), rot=(t[0] * w, t[1] * w, t[2] * w))
        hold = win(f, 14, 18) * (1 - win(f, 58, 62))
        st.infl['Att_Hand_Warhead_L'] = hold
        away = pulse(f, 8, 12, 12, 18) + pulse(f, 58, 62, 62, 70)
        st.add('Grip_L', loc=(-0.05 * away, -0.05 * away, -0.15 * away))
        # the new warhead: up from below, lined up ahead of the tube, pushed home, locked with a twist
        rise = win(f, 16, 38, 'o'); home = win(f, 40, 52, 'io')
        st.add('Warhead', loc=(0.05 * (1 - rise), 0.14 * (1 - home) - 0.25 * (1 - rise), -0.42 * (1 - rise)),
               rot=(-25 * (1 - rise), 18 * pulse(f, 52, 55, 55, 58), 0))
        st.scale['Warhead'] = 0.0 if f < 15 else 1.0
        clunk = pulse(f, 51, 53, 53, 58, 'o')
        st.add('Weapon', loc=(0, -0.012 * clunk, 0), rot=(-2 * clunk, 0, 0))
        st.fingers = mix(mix(grip, left(opened), c01(away * 1.5)), left(whp), hold)
        return st
    acts.append(author(rig, f'{prefix}_Reload', n, reload))

    n = P['inspect']
    loc = Track([(0, (0, 0, 0), 'l'), (30, (-0.05, 0.02, 0.03), 'io'), (60, (-0.05, 0.02, 0.03), 'l'), (88, (-0.06, 0.0, 0.06), 'io'),
                 (116, (-0.06, 0.0, 0.06), 'l'), (n - 8, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])
    rot = Track([(0, (0, 0, 0), 'l'), (30, (10, -32, 22), 'io'), (60, (12, -35, 24), 's'), (88, (18, 12, -12), 'io'),
                 (116, (19, 14, -13), 's'), (n - 8, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])

    def inspect(f):
        st = State().add('Weapon', loc=loc(f), rot=rot(f)); breathe(st, f, n, 0.8)
        return st
    acts.append(author(rig, f'{prefix}_Inspect', n, inspect))
    return acts


# ---------------------------------------------------------------- export

def export_rig(rig, path, actions):
    import os
    os.makedirs(os.path.dirname(path), exist_ok=True)
    col = rig.users_collection[0]
    objs = [o for o in col.objects if o.type in ('ARMATURE', 'MESH', 'EMPTY')]
    for o in objs: o.hide_render = False; o.hide_set(False)
    ad = rig.animation_data
    for tr in list(ad.nla_tracks): ad.nla_tracks.remove(tr)
    for a in actions:
        tr = ad.nla_tracks.new(); tr.name = a.name
        tr.strips.new(a.name, int(a.frame_range[0]), a); tr.mute = False
    ad.action = None
    # engine-facing marker names must be exact (Muzzle, Sight, Round): park clashing names for the export
    renamed = []
    for o in objs:
        base = o.get('marker')
        if base and o.name != base:
            clash = bpy.data.objects.get(base)
            if clash: renamed.append((clash, clash.name)); clash.name = base + '__parked'
            renamed.append((o, o.name)); o.name = base
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    for o in objs: o.hide_viewport = False; o.select_set(True)
    vl.objects.active = rig
    with bpy.context.temp_override(active_object=rig, selected_objects=objs):
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
                                  export_extras=True, export_image_format='JPEG', export_jpeg_quality=88, export_animations=True,
                                  export_animation_mode='NLA_TRACKS', export_force_sampling=True, export_frame_step=1,
                                  export_optimize_animation_size=True, export_def_bones=False, export_skins=True,
                                  export_materials='EXPORT', export_nla_strips=True)
    for o, n in reversed(renamed): o.name = n
    return os.path.getsize(path)
