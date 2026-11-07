"""Arcade first-person clips: each weapon's feel, its sound-synced beats and its clip builders, on top of fpanim's
generic layers (breathe, gait, kick, base_clips, author, export_rig). exec after arcade/fp_rigs.py.

    make_arc('Sling')                     authors every Sling_* action on FP_Sling
    export_arc('Sling')                   writes assets/v2/arcade/fp/slingshot.glb (30 fps, NLA tracks, no outline shells)
    arc_review('Sling', 'Sling_Idle', 0)  one light EEVEE frame of the player's view into review-work/fp/
    arc_tile(...) then arc_stitch(...)    pose-sheet tiles at the sound beats, one small render per call, stitched

Beats are frames at 30 fps read off the Arcade sounds (assets/v2/arcade-sounds/): a shot's key move lands on the
shot sound's transient, a reload's moves on the reload sound's hits. Each weapon's `timeline` (its reload markers) and
its equip, unequip, inspect and reload lengths are quoted in seconds by packs/arcade/pack.json, and
tools/test/test-arcade-fp.mjs holds the two together.
"""
import bpy, math, os, random
from mathutils import Vector, Euler

HIDE = 0.002      # a hidden part's scale: not 0, which collapses its faces and grows spikes on the review outline shells
ARC_FILES = {'Sling': 'slingshot', 'Repeater': 'repeater', 'Blunderbuss': 'blunderbuss', 'Arbalest': 'arbalest', 'Cannon': 'cannon'}

ARC_PARAMS = {
    # Slingshot: a snap, not a kick. Shot sound: the release is loud from f0, the band snap peaks at f1.4, the pouch
    # slap at f5, a thud at f8. At 300 rpm the shot restarts every 6 frames, so the hand catches the pouch by f4 (the
    # slap is the pouch landing in it) and is back at the ready by f6; the thud is a settle of the hands at f8. Reload sound: pebble rattles f0.6-6, the load snaps f11.7-16.7 (loudest f15.2),
    # settle clicks f20.6-25.3, 1.08 s in all.
    'Sling': dict(
        kick=0.006, kick_up=0.004, climb=2.5, roll=1.2, yaw=0.7, cam=0.35, freq=4.5, damp=0.5, bolt=0.0, cycle=(),
        shoot_frames=10, idle_frames=60, walk_amp=0.8, run_amp=0.9,
        sprint=dict(loc=(-0.02, -0.03, -0.04), rot=(-12, 5, 6)),
        off=dict(loc=(0.0, -0.03, -0.08), rot=(-30, 10, 10)), off_grip_l=(-0.03, -0.03, -0.06), equip_back=0.8,   # short arms: a shallow off pose
        equip_frames=14, unequip_frames=10, reload=33, reload_empty=40, inspect=96,
        ready=0.03,                     # the rest is this short of the full draw (fp_rigs builds it so)
        hang=(0.0, 0.05, -0.05),       # where the let-go pouch dangles: off the ready rest, weapon-local metres
        tug=0.03,                       # the empty reload's extra band tug
        timeline=dict(magOut=6, magIn=15, commitAmmo=17, bolt=31),   # the reload markers in frames; packs/arcade/pack.json quotes them in seconds
        beats=dict(regrab=4, drawn=6, thud=8, pocket=6, seat=15, press=(12.5, 17.5), settle=(18, 26), tug=(27, 34)),
    ),
    # Repeating crossbow, 600 rpm: the fire slot loops 0.10 s of the shot sound around its lever clack (offset 0.15 s,
    # clack at +0.02 s = f0.6), so the flick lands at f1 and springs back by f3. Reload sound: latch click f12.2, lift
    # f13.8, the old hopper lands f27.5, the new one meets the rail f49.8, seats f54.1, slap f56.9 (loudest), settle f60.
    'Repeater': dict(
        kick=0.012, kick_up=0.004, climb=2.0, roll=0.9, yaw=0.6, cam=0.4, freq=4.2, damp=0.5, bolt=0.0, cycle=(),
        shoot_frames=8, idle_frames=60, walk_amp=0.9, run_amp=0.95, flick=-14, stroke=-30,   # negative: the bar arcs up and forward, into view
        sprint=dict(loc=(-0.02, -0.02, -0.02), rot=(-6, 8, 12)),
        off=dict(loc=(0.0, -0.03, -0.07), rot=(-18, 8, 10)), off_grip_l=(-0.03, -0.03, -0.05), equip_back=0.8,
        equip_frames=18, unequip_frames=12, reload=66, reload_empty=80, inspect=100,
        reload_tilt=(5, 18, 10),
        timeline=dict(magOut=14, magIn=54, commitAmmo=57, bolt=71),   # the reload markers in frames; packs/arcade/pack.json quotes them in seconds
        beats=dict(latch=12, lift=14, land=27, meet=50, seat=54, slap=57, settle=60, stroke=(66, 71, 78)),
    ),
    # Blunderbuss, 75 rpm: the shot sound is a 60 ms crack at f0, so the hammer falls on f0 and the kick rolls from
    # there. Reload sound: horn cap f1.1-4.2, pour taps f7.5 and f9.2, quiet to f46, ram clacks f47.1 (loudest) and f52.1.
    'Blunderbuss': dict(
        kick=0.05, kick_up=0.01, climb=9.0, roll=2.6, yaw=1.6, cam=2.2, freq=2.3, damp=0.38, bolt=0.0, cycle=(),
        shoot_frames=24, idle_frames=60, idle_amp=1.1, walk_amp=1.2, run_amp=1.05, hammer=50,
        sprint=dict(loc=(-0.02, -0.02, -0.02), rot=(-6, 8, 12)),
        off=dict(loc=(0.0, -0.03, -0.07), rot=(-18, 8, 10)), off_grip_l=(-0.03, -0.03, -0.05), equip_back=0.8,
        equip_frames=20, unequip_frames=12, reload=66, reload_empty=96, inspect=110,
        port=dict(hold=(0, 0.51, 0.035), at=(-0.02, 0.29, -0.09), rot=(60, 0, 20)),   # the reload pose: gun tipped up at the chest, the bell mouth 29 cm ahead, 9 cm below the eye, seen edge-on
        belt=dict(horn=(-0.16, 0.14, -0.36), rod=(-0.20, 0.16, -0.34)), ram=0.10,
        timeline=dict(magOut=3, magIn=47, commitAmmo=52, bolt=88),   # the reload markers in frames; packs/arcade/pack.json quotes them in seconds
        beats=dict(cock=(14, 22), swing=(0, 7), horn=(4, 7.5, 12, 16), pour=(7.5, 9.2), rod=(20, 34), ram1=47, ram2=52, rod_out=(58, 60),
                   back=(56, 66), back_empty=(58, 68), prime=(70, 75, 79, 83), cock_empty=(84, 88)),
    ),
    # Heavy crossbow, 50 rpm: tension hiss f0-5, string release at f5.5 (peak), limb slap f7.5, gone by f14. Reload
    # sound (1.03 s): rail ticks f1.8, 4.2, 6.9, 9.4, pre-seat f18.1, seat clunk f20.4 (loudest).
    'Arbalest': dict(
        kick=0.02, kick_up=0.005, climb=3.0, roll=1.2, yaw=0.8, cam=0.9, freq=3.2, damp=0.45, bolt=0.0, cycle=(),
        shoot_frames=36, idle_frames=60, walk_amp=1.0, run_amp=1.0, string_travel=0.25, limb_flex=6, turns=3,
        sprint=dict(loc=(-0.02, -0.02, -0.02), rot=(-6, 6, 10)),
        off=dict(loc=(0.0, -0.03, -0.07), rot=(-16, 6, 8)), off_grip_l=(-0.03, -0.03, -0.05), equip_back=0.8,
        equip_frames=24, unequip_frames=14, reload=31, reload_empty=45, inspect=130,
        reload_tilt=(10, 22, 8),
        timeline=dict(magOut=4, magIn=18, commitAmmo=21, bolt=38),   # the reload markers in frames; packs/arcade/pack.json quotes them in seconds
        beats=dict(release=5.5, slap=7.5, crank=(14, 30), to_crank=(9, 14), from_crank=(30, 36), drop=(31, 34),
                   ticks=(1.8, 4.2, 6.9, 9.4), lay=9, seat=20.4, check=(32, 35, 38, 41, 45)),
    ),
    # Mini cannon, 40 rpm: the boom is loud from f0 (peak f1.5) and rumbles on: bed thumps f12, f17-20, f29-33, f38-47
    # fading. Reload sound: fetch rattles f0.8-9.8, the ball at the lip f15.3/18.8/20.2, drop-in clunk f27.9 (loudest),
    # roll thuds f34.8, 37.8, 42.6, 45.3, 47.2.
    'Cannon': dict(
        kick=0.07, kick_up=0.012, climb=7.0, roll=2.5, yaw=1.5, cam=2.8, freq=1.9, damp=0.36, bolt=0.0, cycle=(),
        shoot_frames=45, idle_frames=60, idle_amp=1.3, walk_amp=1.4, run_amp=1.2, walk_frames=40, run_frames=28,
        sprint=dict(loc=(-0.02, -0.02, -0.03), rot=(-6, 5, 10)),
        off=dict(loc=(0.02, -0.03, -0.08), rot=(-18, 6, 10)), off_grip_l=(-0.03, -0.03, -0.05), equip_back=0.6,
        equip_frames=24, unequip_frames=12, reload=66, inspect=140,
        port=dict(hold=(0, 0.29, 0.085), at=(0.07, 0.34, -0.05), rot=(40, 0, 15)),   # the reload pose: cannon tipped up at the chest, the mouth 34 cm ahead, 5 cm below the eye
        belt=(-0.14, 0.14, -0.38),
        timeline=dict(magOut=10, magIn=28, commitAmmo=43),   # the reload markers in frames; packs/arcade/pack.json quotes them in seconds
        beats=dict(jolts=((12, 1.0), (17.5, 0.9), (20, 0.5), (29, 0.5), (31, 0.3), (33, 0.4), (38, 0.25), (40, 0.2), (44, 0.15)),
                   swing=(0, 10), fetch=(2, 10), lip=(15.3, 18.8, 20.2), rise=(10, 26), drop=28, bounces=((35, 0.012), (38, 0.008), (43, 0.005), (45, 0.003), (47, 0.002)),
                   hand_back=(30, 42), level=(48, 66)),
    ),
}

ARC_CLASS = {'Sling': 'sling_clips', 'Repeater': 'repeater_clips', 'Blunderbuss': 'blunderbuss_clips', 'Arbalest': 'arbalest_clips', 'Cannon': 'cannon_clips'}


def arc_right(p): return {n: q for n, q in p.items() if n.startswith('Right')}


def arc_unequip(rig, prefix, P, grip, opened):
    """fpanim's unequip at its own length (equip and unequip differ here), the support hand leaving first."""
    n = P.get('unequip_frames', P.get('equip_frames', 20))
    OFF = P.get('off', dict(loc=(0.04, -0.12, -0.28), rot=(-50, 25, 30))); GL = P.get('off_grip_l', (-0.05, -0.09, -0.09))

    def fn(f):
        h = win(f, 0, n * 0.35); t = ease_in(c01((f - n * 0.15) / (n * 0.85)))
        st = State().add('Weapon', loc=tuple(a * t for a in OFF['loc']), rot=tuple(a * t for a in OFF['rot']))
        st.add('Grip_L', loc=tuple(a * h for a in GL), rot=(0, -25 * h, 0))
        st.fingers = mix(grip, left(opened), h)
        return st
    return author(rig, f'{prefix}_Unequip', n, fn)


def arc_place(rig, hold, target, rot, scale=1.0):
    """The Weapon bone location (its rest axes, metres) that puts the weapon-local point `hold` (times the view-model
    `scale`) at the camera-space point `target` under the pose rotation `rot` (pitch, roll, yaw in degrees): the poses
    that bring a part of a long weapon to the hands."""
    M = rig.data.bones['Weapon'].matrix_local; R0 = M.to_3x3(); O = M.translation
    Rq = Euler([math.radians(a) for a in rot], 'YXZ').to_matrix()
    return tuple(R0.inverted() @ (Vector(target) - O) - Rq @ (Vector(hold) * scale))


def arc_swing(rig, PT, t, scale=1.0):
    """The Weapon pose (loc, rot) `t` of the way from the hip to the port pose PT: the held point travels a straight
    line in camera space while the weapon turns about it, so nothing swings out of reach on the way."""
    M = rig.data.bones['Weapon'].matrix_local
    hip = M.translation + M.to_3x3() @ (Vector(PT['hold']) * scale)
    at = hip.lerp(Vector(PT['at']), t); rot = tuple(a * t for a in PT['rot'])
    return arc_place(rig, PT['hold'], at, rot, scale), rot


def arc_local(rig, target, wloc, wrot, head, scale=1.0):
    """The pose location of a part bone (a child of Weapon, axes as the weapon's) that puts its head at the camera-space
    point `target` while the Weapon bone is posed at `wloc`/`wrot`: parts fetched from the belt travel in world space.
    `head` is the bone's rest head in weapon-local (unscaled) units."""
    M = rig.data.bones['Weapon'].matrix_local; R0 = M.to_3x3(); O = M.translation
    Rq = Euler([math.radians(a) for a in wrot], 'YXZ').to_matrix()
    return tuple(Rq.inverted() @ (R0.inverted() @ (Vector(target) - O) - Vector(wloc)) - Vector(head) * scale)


def arc_shots(rig, prefix, P, extra, delay=0.0):
    """The three shot variants with the kick delayed to the sound's release (the crossbow's trigger comes before its
    twang); `extra(st, f, var)` adds the weapon's own mechanics and may replace the fingers."""
    grip = pose(rig, 'pose_grip'); rnd = random.Random(prefix); acts = []
    for tag, var in (('', (1.0, 0.6)), ('_B', (-0.7, -0.9)), ('_C', (0.4, 0.2))):
        var = (var[0] * (0.85 + 0.3 * rnd.random()), var[1] * (0.85 + 0.3 * rnd.random()))

        def shoot(f, var=var):
            st = State(); k = kick(f, P['freq'], P['damp'], delay); rs, ys = var
            st.add('Weapon', loc=(0.002 * rs, -P['kick'] * k, P['kick_up'] * k), rot=(P['climb'] * k, P['roll'] * rs * k, P['yaw'] * ys * k))
            st.add('Shoulders', loc=(0, -P['kick'] * 0.35 * k, 0))
            st.add('Camera', rot=(P['cam'] * k, 0, P['cam'] * 0.3 * ys * k))
            st.add('Trigger', rot=(-16 * pulse(f, delay, delay + 0.8, delay + 2, delay + 4), 0, 0))
            sq = pulse(f, delay, delay + 0.8, delay + 2, delay + 5)
            st.fingers = curl(curl(grip, 'RightHandIndex2', 14 * sq), 'RightHandIndex3', 8 * sq)
            extra(st, f, var)
            return st
        acts.append(author(rig, f'{prefix}_Shoot{tag}', P['shoot_frames'], shoot))
    return acts


def arc_common(rig, prefix, P, shot, delay=0.0):
    """Idle, Walk, Run and Equip from fpanim, Unequip at its own length, the shots with a delayed kick."""
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open')
    acts = [a for a in base_clips(rig, prefix, P, shoot_extra=lambda st, f, var: None) if not a.name.endswith(('_Unequip', '_Shoot', '_Shoot_B', '_Shoot_C'))]
    acts.append(arc_unequip(rig, prefix, P, grip, opened))
    return acts + arc_shots(rig, prefix, P, shot, delay)


def arc_inspect(rig, prefix, P, keys, extra=None):
    """A look at the weapon: `keys` [(frame, loc, rot)] held pairs, the breathe under it, `extra(st, f)` on top."""
    n = P['inspect']
    loc = Track([(0, (0, 0, 0), 'l')] + [(fr, l, e) for fr, l, r, e in keys] + [(n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])
    rot = Track([(0, (0, 0, 0), 'l')] + [(fr, r, e) for fr, l, r, e in keys] + [(n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])

    def fn(f):
        st = State().add('Weapon', loc=loc(f), rot=rot(f)); breathe(st, f, n, 0.6)
        if extra: extra(st, f)
        return st
    return author(rig, f'{prefix}_Inspect', n, fn)


# ---------------------------------------------------------------- slingshot

def sling_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open'); B = P['beats']; hang = P['hang']

    def shot(st, f, var):
        # the ready is a partial draw: frame 0 completes it, the pinch lets go at f1 and the pouch flies past the fork
        # (the snap peaks f1.4), swings back and dangles; the hand darts to it on the slap (f5) and draws it back to
        # the ready by the thud (f8); the pebble is gone from the release, a new one sits in by the draw
        full = pulse(f, 0, 0.6, 0.9, 1.2, 'o')
        regrab = win(f, B['regrab'] - 0.8, B['regrab'])
        st.infl['Att_Hand_Pouch_R'] = c01((1 - win(f, 0.9, 1.4, 'l')) + regrab)
        fly = win(f, 1.0, 2.2, 'o'); back = win(f, 2.2, 3.8, 'io'); draw = win(f, B['regrab'], B['drawn'], 'io')
        y = -P['ready'] * full + (0.15 * fly - (0.15 - hang[1]) * back) * (1 - draw)
        z = hang[2] * back * (1 - draw) + 0.01 * math.sin(TAU * f / 1.6) * pulse(f, 2, 2.5, 3.5, 5.5)
        st.add('Pouch', loc=(0.004 * var[0] * pulse(f, 1, 2, 3, 5), y, z), rot=(-25 * pulse(f, 1.4, 2.2, 3, 5) * (1 - draw), 0, 0))
        gone = 2 <= f < B['drawn'] - 0.5; away = win(f, 1, 2, 'l') if f < B['drawn'] - 0.5 else 0.0
        st.add('Pebble', loc=(0, 0.6 * away, 0.01 * away - (0.6 if gone else 0.0)))
        st.scale['Pebble'] = HIDE if gone else 1.0
        k = pulse(f, 1, 1.8, 1.8, 5, 'o')                       # the fork springs forward as the tension drops
        thud = pulse(f, B['thud'] - 1, B['thud'], B['thud'], B['thud'] + 2, 'o')
        st.add('Weapon', loc=(0, 0.006 * k, 0.004 * k - 0.003 * thud), rot=(-3.5 * k + 1.5 * full - 0.8 * thud, 0, 0))
        st.fingers = mix(grip, arc_right(opened), pulse(f, 1, 1.5, B['regrab'] - 1.5, B['regrab'] + 0.5))
    acts = [a for a in base_clips(rig, prefix, P, shoot_extra=shot) if not a.name.endswith(('_Equip', '_Unequip'))]

    def equip(f, out=False):
        # the fork comes up first, the pouch dangling; the draw hand arrives on it late and draws to the ready. Unequip
        # runs it backwards at its own length: the draw hand lets go and drops, then the fork goes down.
        n = P['unequip_frames' if out else 'equip_frames']
        u = (n - f) / n if out else f / n                         # 0 = away, 1 = up
        t = back_out(c01(u * n / (n - 3)), P.get('equip_back', 0.8)) if not out else ease_out(c01(u))
        OFF = P['off']; st = State().add('Weapon', loc=tuple(a * (1 - t) for a in OFF['loc']), rot=tuple(a * (1 - t) for a in OFF['rot']))
        h = win(u, 0.55, 0.9)                                    # the draw hand: belt → pouch
        st.infl['Att_Hand_Pouch_R'] = win(u, 0.8, 0.92)
        st.add('Grip_R', loc=(0.04 * (1 - h), -0.03 * (1 - h), -0.12 * (1 - h)), rot=(-25 * (1 - h), 0, 15 * (1 - h)))
        hw = 1 - win(u, 0.86, 1.0, 'io')
        st.add('Pouch', loc=(0, hang[1] * hw, hang[2] * hw), rot=(-20 * hw, 0, 0))
        st.fingers = mix(grip, arc_right(opened), 1 - h)
        st.add('Camera', rot=(-0.5 * pulse(u, 0.6, 0.75, 0.75, 1.0), 0, 0))
        return st
    acts.append(author(rig, f'{prefix}_Equip', P['equip_frames'], equip))
    acts.append(author(rig, f'{prefix}_Unequip', P['unequip_frames'], lambda f: equip(f, True)))

    def reload(f, empty=False):
        st = State()
        pocket = B['pocket']; seat = B['seat']; s0, s1 = B['settle']
        # let go, the pouch dangles; the right hand drops to the pebble pouch at the belt and fumbles on the rattles,
        # comes back to the dangling pouch, thumbs the pebble home on the loudest snap, and draws on the settle clicks
        st.infl['Att_Hand_Pouch_R'] = c01((1 - win(f, 0, 2)) + win(f, pocket + 4.5, pocket + 6))
        hw = win(f, 0, 3, 'o') * (1 - win(f, s0, s1, 'io'))
        lift = pulse(f, pocket + 5, seat - 1, seat + 2, s0 + 4)              # the pouch held up into view for the thumbing
        st.add('Pouch', loc=(0.01 * lift, hang[1] * hw - 0.01 * lift, hang[2] * hw + 0.10 * lift), rot=(-20 * hw + 30 * lift, 0, 0))
        away = win(f, 1, pocket, 'io') * (1 - win(f, pocket + 1, pocket + 5.5, 'io'))
        jit = 0.006 * math.sin(TAU * f / 1.3) * pulse(f, 0.6, 1.5, pocket - 0.5, pocket + 0.5)
        st.add('Grip_R', loc=(0.05 * away + jit, -0.04 * away, -0.15 * away), rot=(-30 * away, 0, 20 * away))
        st.scale['Pebble'] = 1.0 if f >= seat else HIDE
        p0, p1 = B['press']; press = pulse(f, p0, seat, seat + 0.5, p1)
        st.fingers = curl(mix(grip, arc_right(opened), c01(away * 1.4)), 'RightHandThumb1', 25 * press)
        w = win(f, 0, 6) * (1 - win(f, s0 + 2, s1 + 1))
        st.add('Weapon', loc=(0.01 * w, -0.02 * w, -0.03 * w), rot=(-8 * w, 6 * w, 4 * w))
        st.add('Camera', rot=(0.4 * pulse(f, seat - 1, seat, seat, seat + 4), 0, 0))
        if empty:                                                # a band tug past the anchor, let back
            t0, t1 = B['tug']; t = pulse(f, t0, t0 + 3, t0 + 4, t1, 'io')
            st.add('Pouch', loc=(0, -P['tug'] * t, 0.004 * t)); st.add('Weapon', rot=(1.5 * t, 0, 0))
        return st
    acts.append(author(rig, f'{prefix}_Reload', P['reload'], reload))
    acts.append(author(rig, f'{prefix}_ReloadEmpty', P['reload_empty'], lambda f: reload(f, True)))

    n = P['inspect']
    loc = Track([(0, (0, 0, 0), 'l'), (16, (-0.03, -0.02, 0.04), 'io'), (40, (-0.03, -0.02, 0.04), 'l'), (56, (0.02, -0.04, 0.05), 'io'),
                 (78, (0.02, -0.04, 0.05), 'l'), (n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])
    rot = Track([(0, (0, 0, 0), 'l'), (16, (6, -24, 12), 'io'), (40, (8, -27, 13), 's'), (56, (-4, 22, -9), 'io'),
                 (78, (-2, 25, -10), 's'), (n - 6, (0, 0, 0), 'io'), (n, (0, 0, 0), 'l')])

    def inspect(f):
        st = State().add('Weapon', loc=loc(f), rot=rot(f)); breathe(st, f, n, 0.5)
        # the pouch is let go for the look and dangles, gets a pluck on the second beat, is pinched and drawn again
        let = win(f, 8, 12) * (1 - win(f, 76, 80))
        st.infl['Att_Hand_Pouch_R'] = 1 - let
        hw = win(f, 10, 14, 'o') * (1 - win(f, 80, 88, 'io'))
        pluck = 0.03 * math.sin(TAU * (f - 61) / 3.0) * pulse(f, 58, 61, 61, 66, 'o') if f > 61 else -0.02 * pulse(f, 58, 61, 61, 62)
        st.add('Pouch', loc=(0, hang[1] * hw + pluck, hang[2] * hw), rot=(-20 * hw, 0, 0))
        st.add('Grip_R', loc=(0.04 * let, -0.03 * let, -0.06 * let), rot=(-15 * let, 0, 10 * let))
        st.fingers = mix(grip, arc_right(opened), let)
        return st
    acts.append(author(rig, f'{prefix}_Inspect', n, inspect))
    return acts


# ---------------------------------------------------------------- repeating crossbow

def repeater_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open'); magp = pose(rig, 'pose_Hand_Mag_L'); topp = pose(rig, 'pose_Hand_Top_L')
    B = P['beats']

    def shot(st, f, var):
        # the right hand flicks the lever onto its stop on the clack (f1) and it springs back by f3; the string is drawn a
        # touch and twangs
        flick = pulse(f, 0, 1, 1.2, 3, 'o')
        st.add('Lever', rot=(P['flick'] * flick, 0, 0)); st.add('Grip_R', rot=(-0.6 * P['flick'] * flick, 0, 0))   # the hand turns 40% of the lever
        tw = 0.012 * math.sin(TAU * (f - 1) / 1.4) * pulse(f, 1, 1.3, 2.5, 4) if f >= 1 else 0.0
        st.add('String', loc=(0, -0.02 * pulse(f, 0, 0.9, 0.9, 1.3, 'l') + tw, 0))
        st.add('Weapon', loc=(0, 0, -0.003 * flick), rot=(0, -1.5 * flick * var[0], 0))
    acts = arc_common(rig, prefix, P, shot)

    def reload(f, empty=False):
        n = P['reload_empty' if empty else 'reload']; st = State(); t = P['reload_tilt']
        w = win(f, 0, 8) * (1 - win(f, n - 10, n - 3))
        st.add('Weapon', loc=(-0.02 * w, -0.01 * w, 0.015 * w), rot=(t[0] * w, t[1] * w, t[2] * w))
        # the left hand: fore-stock → hopper (lifts it off on the latch click and tosses it), drops for the next, rides it
        # up to the rail, seats it, comes over the top and slaps it down on the loudest hit, back under the fore-stock
        hold = win(f, 8, 11) * (1 - win(f, 20, 22)) + win(f, 38, 40) * (1 - win(f, B['slap'] - 2.5, B['slap'] - 1.5))
        top = win(f, B['slap'] - 2.5, B['slap'] - 1.0) * (1 - win(f, B['slap'] + 3, B['slap'] + 7))
        st.infl['Att_Hand_Mag_L'] = hold; st.infl['Att_Hand_Top_L'] = top
        latch = pulse(f, B['latch'] - 1, B['latch'], B['latch'], B['latch'] + 2, 'o')
        up = win(f, B['lift'], B['lift'] + 6, 'o'); toss = win(f, B['lift'] + 5, B['land'], 'i')
        rise = win(f, 40, B['meet'], 'o'); seat = win(f, B['meet'], B['seat'], 'io')
        old = f < 34
        if old: st.add('Mag', loc=(-0.15 * toss, 0.02 * up + 0.05 * toss, 0.06 * up + 0.30 * toss), rot=(-35 * toss, 3 * latch, -10 * toss))
        else: st.add('Mag', loc=(-0.12 * (1 - rise), 0, -0.30 * (1 - rise) + 0.05 * rise * (1 - seat)), rot=(-15 * (1 - rise), 0, 0))
        st.scale['Mag'] = HIDE if B['land'] <= f < 40 else 1.0
        meet = pulse(f, B['meet'] - 0.5, B['meet'], B['meet'], B['meet'] + 3, 'o')
        slap = pulse(f, B['slap'] - 0.6, B['slap'], B['slap'], B['slap'] + 5, 'o')
        st.add('Weapon', loc=(0, 0, -0.004 * meet - 0.012 * slap), rot=(1.5 * slap, -2 * meet, 0))
        st.add('Camera', rot=(0.5 * slap, 0, 0.2 * slap))
        # between holds the hand drops down-left to fetch the next hopper (from the fore-stock grip)
        dip = pulse(f, 22, 30, 32, 38)
        st.add('Grip_L', loc=(-0.05 * dip, -0.04 * dip, -0.16 * dip), rot=(-25 * dip, 0, 15 * dip))
        lp = mix(grip, left(opened), win(f, 5, 8) * (1 - win(f, n - 8, n - 4)))
        lp = mix(mix(lp, left(magp), hold), left(topp), top)
        if empty:                                                # a full lever stroke, drawing the string, on the bolt marker
            s0, s1, s2 = B['stroke']; stroke = win(f, s0, s1, 'io') * (1 - win(f, s1, s2, 'o'))
            st.add('Lever', rot=(P['stroke'] * stroke, 0, 0)); st.add('Grip_R', rot=(-0.6 * P['stroke'] * stroke, 0, 0))
            st.add('String', loc=(0, -0.06 * stroke, 0))
            st.add('Weapon', loc=(0, -0.08 * stroke, 0.01 * stroke), rot=(2 * stroke, 0, 0))   # drawn in to the body as it pumps
        st.fingers = lp
        return st
    acts.append(author(rig, f'{prefix}_Reload', P['reload'], reload))
    acts.append(author(rig, f'{prefix}_ReloadEmpty', P['reload_empty'], lambda f: reload(f, True)))

    def insp(st, f):
        tap = pulse(f, 28, 31, 31, 34, 'o') + pulse(f, 36, 39, 39, 42, 'o')
        st.infl['Att_Hand_Mag_L'] = win(f, 22, 26) * (1 - win(f, 44, 48))
        st.add('Grip_L', loc=(0, 0.02 * tap, 0.01 * tap))
        half = pulse(f, 66, 72, 74, 80)
        st.add('Lever', rot=(-25 * half, 0, 0)); st.add('Grip_R', rot=(15 * half, 0, 0)); st.add('String', loc=(0, -0.03 * half, 0))
        st.fingers = mix(mix(grip, left(opened), pulse(f, 18, 22, 48, 52)), left(magp), st.infl['Att_Hand_Mag_L'])
    acts.append(arc_inspect(rig, prefix, P, [(18, (-0.03, -0.02, 0.03), (4, -16, 6), 'io'), (44, (-0.03, -0.02, 0.03), (5, -18, 7), 's'),
                                              (60, (0.02, -0.03, 0.03), (-2, 14, -5), 'io'), (86, (0.02, -0.03, 0.03), (-1, 15, -6), 's')], insp))
    return acts


# ---------------------------------------------------------------- blunderbuss

def blunderbuss_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open'); B = P['beats']
    hornp = pose(rig, 'pose_Hand_Horn_L'); rodp = pose(rig, 'pose_Hand_Ramrod_L'); barp = pose(rig, 'pose_Hand_Barrel_R')
    PT = P['port']

    def shot(st, f, var):
        # the hammer falls on frame 0 (the crack is at f0.3); once the kick has settled the thumb reaches up and re-cocks it
        c0, c1 = B['cock']; fall = win(f, 0, 0.6, 'o'); cock = win(f, c0, c1, 'io')
        st.add('Hammer', rot=(-P['hammer'] * fall * (1 - cock), 0, 0))
        reach = pulse(f, c0 - 2, c0 + 1, c1 - 1, c1 + 2)
        st.add('Weapon', rot=(0, 3 * reach, 0), loc=(0, 0, -0.004 * reach))
        st.fingers = curl(st.fingers, 'RightHandThumb1', -25 * reach)
    acts = arc_common(rig, prefix, P, shot)

    def reload(f, empty=False):
        n = P['reload_empty' if empty else 'reload']; st = State()
        # the gun swings up across the body (the right hand slides from the wrist to the barrel hold); the horn pours into
        # the bell on the taps, the ramrod comes over the muzzle and rams on the two clacks; then everything goes home
        sw0, sw1 = B['swing']; b0, b1 = B['back']
        if empty: b0, b1 = B['back_empty']
        # a third of the way up both the wrist and the barrel hold are within reach: the hand changes over there
        mid = (sw0 + sw1) / 2; bmid = (b0 + b1) / 2
        port = Track([(sw0, 0.0, 'l'), (mid, 0.35, 'io'), (sw1, 1.0, 'io'), (b0, 1.0, 'l'), (bmid, 0.35, 'io'), (b1, 0.0, 'io')])(f)
        sc = ARC_RIGS[prefix]['scale']; wloc, wrot = arc_swing(rig, PT, port, sc)
        st.add('Weapon', loc=wloc, rot=wrot)
        st.infl['Att_Hand_Barrel_R'] = win(f, mid - 1.5, mid + 1.5) * (1 - win(f, bmid - 1.5, bmid + 1.5))
        h0, h1, h2, h3 = B['horn']
        st.scale['Horn'] = 1.0 if h0 <= f < h3 else HIDE
        rise = win(f, h0, h1, 'o'); gone = win(f, h2, h3, 'i'); pour = pulse(f, h1, B['pour'][0], B['pour'][1] + 1, h2)
        tap = sum(pulse(f, t - 0.5, t, t, t + 1, 'o') for t in B['pour']) + pulse(f, 2.4, 2.6, 2.6, 3.4, 'o') + pulse(f, 4.0, 4.2, 4.2, 5.0, 'o')
        horn_rest = ARC_RIGS[prefix]['parts'][2][1]; rod_rest = ARC_RIGS[prefix]['parts'][3][1]
        mouth_h = (Vector(HORN_MOUTH) - Vector(horn_rest)) * sc; mouth_r = (Vector(ROD_MOUTH) - Vector(rod_rest)) * sc
        belt_h = Vector(arc_local(rig, P['belt']['horn'], wloc, wrot, horn_rest, sc))            # the horn from the belt to the mouth, in world
        st.add('Horn', loc=tuple(belt_h * (1 - rise) * (1 - gone) + belt_h * gone + mouth_h * rise * (1 - gone)),
               rot=(-8 * tap - 20 * (1 - rise), 0, 6 * math.sin(TAU * f / 1.1) * pour))
        st.infl['Att_Hand_Horn_L'] = win(f, h0, h0 + 1.5) * (1 - win(f, h2 + 2, h3))
        r0, r1 = B['rod']; o0, o1 = B['rod_out']
        st.scale['Ramrod'] = 1.0 if r0 <= f < o1 else HIDE
        rr = win(f, r0, r1, 'o'); ro = win(f, o0, o1, 'i')
        depth = Track([(r0, 0.4, 'l'), (r1 + 2, 0.4, 'l'), (B['ram1'], 1.0, 'i'), (B['ram1'] + 3, 0.7, 'o'), (B['ram2'], 1.0, 'i'), (o0, 0.4, 'io')])(f)
        belt_r = Vector(arc_local(rig, P['belt']['rod'], wloc, wrot, rod_rest, sc))
        st.add('Ramrod', loc=tuple(belt_r * (1 - rr) * (1 - ro) + belt_r * ro + (mouth_r + Vector((0, -P['ram'] * depth, 0))) * rr * (1 - ro)),
               rot=(-25 * (1 - rr) - 25 * ro, 0, 0))
        st.infl['Att_Hand_Ramrod_L'] = win(f, r0 + 1, r0 + 4) * (1 - win(f, o0 - 1, o0 + 1))
        clack = sum(pulse(f, t - 0.5, t, t, t + 4, 'o') for t in (B['ram1'], B['ram2']))
        st.add('Weapon', loc=(0, -0.008 * clack, -0.006 * clack), rot=(-2 * clack, 0, 0)); st.add('Camera', rot=(0.5 * clack, 0, 0))
        away = pulse(f, h3, h3 + 2, r0 - 2, r0) + pulse(f, o1, o1 + 2, b1 - 6, b1 - 2)   # the left hand between holds: below the gun
        st.add('Grip_L', loc=(-0.04 * away, -0.03 * away, -0.08 * away), rot=(-20 * away, 0, 10 * away))
        lp = mix(grip, left(opened), win(f, 0, 3) * (1 - win(f, b1 - 4, b1)))
        lp = mix(lp, left(hornp), st.infl['Att_Hand_Horn_L']); lp = mix(lp, left(rodp), st.infl['Att_Hand_Ramrod_L'])
        rp = mix(grip, arc_right(barp), st.infl['Att_Hand_Barrel_R'])
        if empty:
            # the hammer is down from the last shot; back at the hip the gun rolls to show the lock, the right thumb
            # primes the pan with a flick over the frizzen, then cocks the hammer on the bolt marker
            st.add('Hammer', rot=(-P['hammer'] * (1 - win(f, B['cock_empty'][0], B['cock_empty'][1], 'io')), 0, 0))
            p0, p1, p2, p3 = B['prime']
            rk = pulse(f, p0, p1, B['cock_empty'][1], B['cock_empty'][1] + 4)
            st.add('Weapon', rot=(0, 14 * rk, 0), loc=(-0.02 * rk, -0.02 * rk, 0.01 * rk))
            flick = pulse(f, p1, p1 + 2, p2, p3) * (0.5 + 0.5 * math.sin(TAU * f / 2.2))
            rp = curl(rp, 'RightHandThumb1', -22 * flick)
            reach = pulse(f, B['cock_empty'][0] - 2, B['cock_empty'][0], B['cock_empty'][1], B['cock_empty'][1] + 3)
            rp = curl(rp, 'RightHandThumb1', -25 * reach)
        st.fingers = dict(lp); st.fingers.update(arc_right(rp))
        return st
    acts.append(author(rig, f'{prefix}_Reload', P['reload'], reload))
    acts.append(author(rig, f'{prefix}_ReloadEmpty', P['reload_empty'], lambda f: reload(f, True)))

    def insp(st, f):
        rock = pulse(f, 34, 37, 40, 44)
        st.add('Hammer', rot=(-20 * rock, 0, 0))
        st.fingers = curl(grip, 'RightHandThumb1', -20 * pulse(f, 32, 35, 42, 46))
    acts.append(arc_inspect(rig, prefix, P, [(20, (-0.03, -0.05, 0.03), (6, -18, 8), 'io'), (50, (-0.03, -0.05, 0.03), (7, -20, 9), 's'),
                                              (64, (0.0, -0.03, 0.02), (6, 4, -14), 'io'), (92, (0.0, -0.03, 0.02), (7, 5, -15), 's')], insp))
    return acts


# ---------------------------------------------------------------- heavy crossbow

def arbalest_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open'); B = P['beats']
    crankp = pose(rig, 'pose_Hand_Crank_R'); boltp = pose(rig, 'pose_Hand_Bolt_L')
    R = B['release']; c0, c1 = B['crank']; t0, t1 = B['to_crank']; f0, f1 = B['from_crank']

    def crank_hand(st, f, on, turn):
        st.infl['Att_Hand_Crank_R'] = on
        st.add('Crank', rot=(turn, 0, 0))

    def shot(st, f, var):
        # trigger squeeze under the tension hiss, the string snaps forward on the release, the limbs straighten, the limb
        # slap; the right hand goes to the crank and three turns draw the string back to the nut; a new bolt drops in
        rel = win(f, R, R + 0.7, 'o'); draw = win(f, c0, c1, 'io')
        fl = 0.02 * math.sin(TAU * (f - R) / 1.5) * pulse(f, R + 0.5, R + 1, R + 2, R + 5) if f > R else 0.0
        st.add('String', loc=(0, P['string_travel'] * rel * (1 - draw) + fl, 0))
        flex = P['limb_flex'] * rel * (1 - draw)
        st.add('Limb_L', rot=(0, 0, -flex)); st.add('Limb_R', rot=(0, 0, flex))
        slap = pulse(f, B['slap'] - 0.5, B['slap'], B['slap'], B['slap'] + 2.5, 'o')
        st.add('Weapon', rot=(-1.2 * slap, 0.8 * slap * var[0], 0))
        gone = R + 0.5 <= f < B['drop'][0]; away = win(f, R, R + 1, 'l') if f < B['drop'][0] else 0.0
        st.add('Bolt', loc=(0, 1.0 * away, 0.06 * (1 - win(f, B['drop'][0], B['drop'][1], 'o')) * (f >= B['drop'][0]) - (0.6 if gone else 0.0)))
        st.scale['Bolt'] = HIDE if gone else 1.0
        on = win(f, t0, t1) * (1 - win(f, f0, f1))
        crank_hand(st, f, on, 360 * P['turns'] * draw)
        st.add('Weapon', loc=(0.02 * on, -0.06 * on, 0.05 * on), rot=(4 * on, -24 * on, -3 * on))    # pulled in and canted: the crank turns in view
        latch = pulse(f, c1 - 0.5, c1, c1, c1 + 3, 'o')
        st.add('Weapon', loc=(0, 0, -0.004 * latch), rot=(0, 2 * draw * math.sin(TAU * f / 5.3), 0))
        sq = win(f, 0, R) * (1 - win(f, R + 0.5, R + 4))
        st.fingers = mix(curl(curl(grip, 'RightHandIndex2', 14 * sq), 'RightHandIndex3', 8 * sq), arc_right(crankp), on)
    acts = arc_common(rig, prefix, P, shot, delay=R)

    def reload(f, empty=False):
        n = P['reload_empty' if empty else 'reload']; st = State(); t = P['reload_tilt']
        w = win(f, 0, 5) * (1 - win(f, n - 8, n - 2))
        st.add('Weapon', loc=(-0.05 * w, -0.10 * w, 0.03 * w), rot=(t[0] * w, t[1] * w, t[2] * w))   # in to the body and rolled to the left hand
        # the left hand brings a bolt from up-left, lays it on the rail on the ticks, pushes it back to the nut, seats it
        st.infl['Att_Hand_Bolt_L'] = win(f, 1, 3) * (1 - win(f, B['seat'], B['seat'] + 1.5))
        st.scale['Bolt'] = 1.0 if f >= 2 else HIDE
        lay = win(f, 2, B['lay'], 'o'); push = win(f, B['lay'] + 2, B['seat'], 'io')
        tick = 0.006 * sum(pulse(f, x - 0.6, x, x, x + 0.8, 'o') for x in B['ticks'])
        st.add('Bolt', loc=(-0.05 * (1 - lay), -0.03 * (1 - lay) + 0.035 * lay * (1 - push), 0.10 * (1 - lay) + tick), rot=(12 * (1 - lay), 0, 0))   # from the body, laid 3.5 cm ahead of the nut
        seat = pulse(f, B['seat'] - 0.5, B['seat'], B['seat'], B['seat'] + 4, 'o')
        st.add('Weapon', loc=(0, 0, -0.006 * seat), rot=(1.5 * seat, 0, 0)); st.add('Camera', rot=(0.4 * seat, 0, 0))
        back = pulse(f, B['seat'] + 1, B['seat'] + 4, B['seat'] + 6, B['seat'] + 10)       # the hand drops away under the stock
        st.add('Grip_L', loc=(-0.015 * back, -0.01 * back, -0.03 * back))
        lp = mix(grip, left(opened), win(f, 0, 2) * (1 - win(f, B['seat'] + 8, B['seat'] + 11)))
        lp = mix(lp, left(boltp), st.infl['Att_Hand_Bolt_L'])
        rp = grip
        if empty:                                                # a check on the crank: a grip and a quarter-turn wiggle on the bolt marker
            k0, k1, k2, k3, k4 = B['check']
            on = win(f, k0, k1) * (1 - win(f, k3, k4)); wig = pulse(f, k1, k2, k2, k3)
            crank_hand(st, f, on, 90 * wig)
            rp = mix(grip, arc_right(crankp), on)
        st.fingers = dict(lp); st.fingers.update(arc_right(rp))
        return st
    acts.append(author(rig, f'{prefix}_Reload', P['reload'], reload))
    acts.append(author(rig, f'{prefix}_ReloadEmpty', P['reload_empty'], lambda f: reload(f, True)))

    def insp(st, f):
        pl = pulse(f, 72, 74, 74, 75, 'o'); tw = 0.012 * math.sin(TAU * (f - 75) / 1.6) * pulse(f, 75, 75.5, 77, 80) if f > 75 else 0.0
        st.add('String', loc=(0, 0.015 * pl + tw, 0))
        on = win(f, 100, 104) * (1 - win(f, 114, 118)); wig = pulse(f, 104, 107, 109, 113)
        crank_hand(st, f, on, 60 * wig)
        st.fingers = mix(grip, arc_right(crankp), on)
    acts.append(arc_inspect(rig, prefix, P, [(20, (-0.03, -0.04, 0.02), (6, -14, 8), 'io'), (50, (-0.03, -0.04, 0.02), (7, -15, 9), 's'),
                                              (65, (0.02, -0.02, 0.03), (3, 6, 16), 'io'), (98, (0.02, -0.02, 0.03), (4, 7, 17), 's')], insp))
    return acts


# ---------------------------------------------------------------- mini cannon

def cannon_clips(rig, prefix, P):
    grip = pose(rig, 'pose_grip'); opened = pose(rig, 'pose_open'); ballp = pose(rig, 'pose_Hand_Ball_L'); B = P['beats']
    PT = P['port']

    def shot(st, f, var):
        # boom on frame 0: the spark flares, the ball is gone, the heavy kick; the bed thumps on the rumble jolts
        st.scale['Spark'] = 1.0 + 1.4 * pulse(f, 0, 0.8, 1, 4, 'o') - 0.6 * pulse(f, 4, 8, 20, 30)
        go = win(f, 0, 2, 'l'); st.add('Ball', loc=(0, 1.5 * go, 0.05 * go - (0.6 if f >= 2 else 0.0))); st.scale['Ball'] = HIDE if f >= 2 else 1.0
        jolt = sum(a * pulse(f, x - 1, x, x, x + 3, 'o') for x, a in B['jolts'])
        st.add('Weapon', loc=(0, -0.006 * jolt, -0.008 * jolt), rot=(-1.8 * jolt, 0.6 * jolt * var[0], 0))
        st.add('Camera', rot=(0.5 * jolt, 0, 0.3 * jolt * var[1]))
    acts = arc_common(rig, prefix, P, shot)

    def reload(f):
        n = P['reload']; st = State()
        # the cannon tips up across the body; the left hand fetches the ball from the belt on the rattles, lifts it to
        # the lip, drops it in on the clunk; it settles on the thuds while the hand returns and the cannon levels
        sw0, sw1 = B['swing']; l0, l1 = B['level']
        port = win(f, sw0, sw1, 'io') * (1 - win(f, l0, l1, 'io'))
        wloc, wrot = arc_swing(rig, PT, port, ARC_RIGS[prefix]['scale'])
        st.add('Weapon', loc=wloc, rot=wrot)
        e0, e1 = B['fetch']; r0, r1 = B['rise']; d = B['drop']; hb0, hb1 = B['hand_back']
        fetch = win(f, e0, e0 + 4, 'io') * (1 - win(f, r0 - 1, r0 + 1))
        jit = 0.005 * math.sin(TAU * f / 1.2) * pulse(f, e0 + 1, e0 + 2, e1 - 1, e1)
        st.add('Grip_L', loc=(-0.04 * fetch + jit, -0.03 * fetch, -0.10 * fetch), rot=(-25 * fetch, 0, 15 * fetch))
        st.infl['Att_Hand_Ball_L'] = win(f, r0 - 1, r0) * (1 - win(f, d, d + 2))
        st.scale['Ball'] = 1.0 if f >= r0 else HIDE
        rise = win(f, r0, r1, 'io'); drop = win(f, d - 1.5, d, 'i')
        knock = 0.006 * sum(pulse(f, x - 0.5, x, x, x + 0.8, 'o') for x in B['lip'])
        bounce = sum(a * pulse(f, x - 0.8, x, x, x + 1.6, 'o') for x, a in B['bounces'])
        belt = Vector(arc_local(rig, P['belt'], wloc, wrot, (0, 0.26, 0.085), ARC_RIGS[prefix]['scale']))   # the ball from the belt, in world
        lip = Vector((-0.02 + knock, 0.03, 0.035)) * (1 - drop)                                         # just over the lip, then dropped in
        st.add('Ball', loc=tuple(belt * (1 - rise) + lip * rise + Vector((0, 0, bounce))))
        clunk = pulse(f, d - 0.5, d, d, d + 4, 'o')
        st.add('Weapon', loc=(0, -0.006 * clunk, -0.008 * clunk), rot=(-2 * clunk, 0, 0)); st.add('Camera', rot=(0.6 * clunk, 0, 0))
        back = pulse(f, hb0, hb0 + 3, hb1 - 4, hb1)
        st.add('Grip_L', loc=(-0.04 * back, -0.03 * back, -0.08 * back), rot=(-20 * back, 0, 10 * back))
        lp = mix(grip, left(opened), win(f, e0, e0 + 2) * (1 - win(f, hb1 - 3, hb1)))
        st.fingers = mix(lp, left(ballp), st.infl['Att_Hand_Ball_L'])
        return st
    acts.append(author(rig, f'{prefix}_Reload', P['reload'], reload))

    def insp(st, f):
        pat = pulse(f, 40, 44, 44, 48, 'o') + pulse(f, 50, 54, 54, 58, 'o')
        st.add('Grip_L', loc=(0.0, 0.03 * pat, 0.05 * pat), rot=(-10 * pat, 0, 0))
        st.scale['Spark'] = 1.0 + 0.3 * math.sin(TAU * f / 4.0) * pulse(f, 84, 90, 108, 114)
        st.fingers = mix(grip, left(opened), pat)
    acts.append(arc_inspect(rig, prefix, P, [(30, (-0.04, -0.03, 0.04), (5, -9, -14), 'io'), (60, (-0.04, -0.03, 0.04), (6, -10, -15), 's'),
                                              (80, (-0.02, -0.04, 0.05), (-6, 10, 14), 'io'), (116, (-0.02, -0.04, 0.05), (-7, 11, 15), 's')], insp))
    return acts


# ---------------------------------------------------------------- make, export, review

def make_arc(prefix):
    arc_show(prefix)                                       # this rig in view and evaluated (the others hidden), or the solver reads stale bones
    rig = bpy.data.objects['FP_' + prefix]
    acts = globals()[ARC_CLASS[prefix]](rig, prefix, ARC_PARAMS[prefix])
    return rig, acts


def export_arc(prefix, acts=None):
    """The GLB: 30 fps, every <Prefix>_* action as an NLA track, the kit materials on their glTF branch, outline
    shells off (the engine grows its own from extras.arc_outline)."""
    arc_show(prefix)                                       # its collection visible, or the selection export writes an empty file
    rig = bpy.data.objects['FP_' + prefix]
    acts = acts or sorted([a for a in bpy.data.actions if a.name.startswith(prefix + '_')], key=lambda a: a.name)
    sc = bpy.context.scene; sc.render.fps = 30; sc.render.fps_base = 1.0
    bpy.data.orphans_purge(do_recursive=True)               # stale meshes from rebuilds would push .001 names into the file
    for o in bpy.data.objects:
        if o.get('fp_rig') == rig.name and o.type == 'MESH': o.data.name = o.name
    arc_outlines(prefix, False); gltf_mode(True)
    try: size = export_rig(rig, ARC_FP_OUT + ARC_FILES[prefix] + '.glb', acts)
    finally: gltf_mode(False); arc_outlines(prefix, True)
    return {'file': ARC_FILES[prefix] + '.glb', 'kb': round(size / 1024, 1), 'clips': [a.name for a in acts], 'arms': arm_report(acts)}


def arc_view():
    """The player's view: FP_ReviewCam at the eye looking down +Y, 60 degrees vertical, as the scene camera; every 3D
    viewport looks through it in Material Preview so the work can be watched live."""
    sc = bpy.context.scene
    cam = bpy.data.objects.get('FP_ReviewCam')
    if not cam:
        cam = bpy.data.objects.new('FP_ReviewCam', bpy.data.cameras.new('FP_ReviewCam')); sc.collection.objects.link(cam)
    cam.data.clip_start = 0.01; cam.data.sensor_fit = 'VERTICAL'; cam.data.angle = math.radians(60)
    cam.location = (0, 0, 0); cam.rotation_euler = Vector((0, 1, 0)).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    for w in bpy.data.window_managers[0].windows:
        for a in w.screen.areas:
            if a.type == 'VIEW_3D':
                sp = a.spaces[0]; sp.region_3d.view_perspective = 'CAMERA'; sp.shading.type = 'MATERIAL'
    return cam


def arc_show(prefix, action=None, frame=0):
    """One rig in view (the file holds all five at the same eye), on the given action and frame."""
    for c in bpy.data.collections:
        if c.name.startswith('FP_'): c.hide_render = c.hide_viewport = c.name != 'FP_' + prefix
    rig = bpy.data.objects['FP_' + prefix]
    ad = rig.animation_data or rig.animation_data_create()
    ad.action = bpy.data.actions[action] if action else None
    bpy.context.scene.frame_set(int(frame)); bpy.context.view_layer.update()


def arc_review(prefix, action=None, frame=0, path=None, res=(1200, 740), samples=16, eye=None, look=None):
    """One light EEVEE frame of the player's view (keep it small: one render per call, the Mac overheats).
    eye/look: a side camera instead, for checking the grips from outside."""
    arc_view(); arc_show(prefix, action, frame)
    render_setup(res, samples)
    sc = bpy.context.scene
    if eye:
        cam = bpy.data.objects.get('FP_SideCam')
        if not cam:
            cam = bpy.data.objects.new('FP_SideCam', bpy.data.cameras.new('FP_SideCam')); sc.collection.objects.link(cam)
        cam.data.clip_start = 0.01; cam.data.lens = 40
        cam.location = eye; cam.rotation_euler = (Vector(look) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
        sc.camera = cam
    path = path or f'{ARC_FP_REVIEW}/{prefix.lower()}-{(action or "rest").lower()}-{int(frame):03d}.png'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


COVER_CENTER = (0.3, 0.7, 0.3, 0.7)      # the frame's central box (x0, x1, y0, y1 of 0..1): where the aim is read


def arc_coverage(prefix, action=None, frame=0, grid=(96, 60)):
    """How much of the player's view the arms and the weapon cover on one frame: fractions of the whole frame and of its
    central box, rasterised through the review camera at the engine's 60 degree view. The numbers a review reads first."""
    from bpy_extras.object_utils import world_to_camera_view
    arc_view(); arc_show(prefix, action, frame)
    sc = bpy.context.scene; cam = sc.camera; sc.render.resolution_x, sc.render.resolution_y = 1200, 740
    dg = bpy.context.evaluated_depsgraph_get(); W, H = grid
    cells = {'arms': set(), 'weapon': set()}
    for o in [o for o in bpy.data.objects if o.get('fp_rig') == 'FP_' + prefix and o.type == 'MESH']:
        ev = o.evaluated_get(dg); me = ev.to_mesh(); me.calc_loop_triangles()
        P = [world_to_camera_view(sc, cam, ev.matrix_world @ v.co) for v in me.vertices]
        out = cells['arms' if o.name.endswith('_Arms') else 'weapon']
        for t in me.loop_triangles:
            a, b, c = (P[i] for i in t.vertices)
            if min(a.z, b.z, c.z) <= 0.005: continue
            x0, x1 = max(0, int(min(a.x, b.x, c.x) * W)), min(W - 1, int(max(a.x, b.x, c.x) * W))
            y0, y1 = max(0, int(min(a.y, b.y, c.y) * H)), min(H - 1, int(max(a.y, b.y, c.y) * H))
            d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
            if abs(d) < 1e-12: continue
            for gx in range(x0, x1 + 1):
                for gy in range(y0, y1 + 1):
                    px, py = (gx + 0.5) / W, (gy + 0.5) / H
                    l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / d
                    l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / d
                    if l1 >= 0 and l2 >= 0 and l1 + l2 <= 1: out.add((gx, gy))
        ev.to_mesh_clear()
    cx0, cx1, cy0, cy1 = COVER_CENTER
    inside = lambda s: sum(1 for gx, gy in s if cx0 <= (gx + 0.5) / W <= cx1 and cy0 <= (gy + 0.5) / H <= cy1)
    ncenter = sum(1 for gx in range(W) for gy in range(H) if cx0 <= (gx + 0.5) / W <= cx1 and cy0 <= (gy + 0.5) / H <= cy1)
    r = lambda v: round(v, 3)
    return {k: r(len(v) / (W * H)) for k, v in cells.items()} | {k + '_center': r(inside(v) / ncenter) for k, v in cells.items()}


def arc_sweep(prefix, step=3, actions=None):
    """arc_coverage over every clip (every `step` frames): each clip's worst arms cover of the frame and of its centre."""
    out = {}
    for a in sorted(actions or [a.name for a in bpy.data.actions if a.name.startswith(prefix + '_')]):
        n = int(bpy.data.actions[a].frame_range[1]); worst = (0, 0, 0, 0)
        for f in list(range(0, n + 1, step)) + [n]:
            c = arc_coverage(prefix, a, f)
            if c['arms'] > worst[0]: worst = (c['arms'], f, *worst[2:])
            if c['arms_center'] > worst[2]: worst = (worst[0], worst[1], c['arms_center'], f)
        out[a] = {'arms': worst[0], 'at': worst[1], 'center': worst[2], 'center_at': worst[3]}
    return out


def arc_tile(prefix, action, frame, res=(400, 247), samples=12):
    return arc_review(prefix, action, frame, f'{ARC_FP_REVIEW}/tiles/{prefix.lower()}-{action.lower()}-{int(frame):03d}.png', res, samples)


def arc_stitch(paths, out, cols=4):
    """Tiles of one size into a grid, top-left first; no rendering."""
    import numpy as np
    ims = [bpy.data.images.load(p, check_existing=False) for p in paths]
    w, h = ims[0].size; rows = -(-len(ims) // cols)
    sheet = np.zeros((rows * h, cols * w, 4), dtype=np.float32); sheet[..., 3] = 1.0
    for i, im in enumerate(ims):
        px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)     # rows bottom-up
        r, c = i // cols, i % cols
        sheet[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = px
    img = bpy.data.images.new('FP_Sheet', cols * w, rows * h, alpha=True)
    img.pixels = sheet.ravel().tolist()
    img.filepath_raw = out; img.file_format = 'PNG'; img.save()
    bpy.data.images.remove(img)
    for im in ims: bpy.data.images.remove(im)
    return out
