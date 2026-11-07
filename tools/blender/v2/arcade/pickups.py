"""Arcade pickups: the pebble pouch (ammo), the honey jar (health) and the fizz-bomb gourd (grenade; the same
model is the thrown grenade, through the pack's `grenade` key). Same toon kit, palette and outlines as the props.

exec after vg.py, kit.py, nature.py, hero_corner.py, props.py and weapons.py (same globals):
    g['build_pickups']()    the three pickups into ARC_Pickups (shown in the ARC_Review scene) + their camera
    g['review_pickups']()   one light EEVEE render (assets/v2/arcade/arcade-pickups-review.png)
    g['ship_pickups']()     assets/v2/arcade/arcade-{pouch,honey,fizzbomb}.glb + the 256 px catalog cards

Contract with the engine (render/CombatEnvironment.js, game/ShooterSession.js spinners, sim/GrenadeSystem.js):
  - One node per file, 'Pickup', standing on its origin at game scale, its front toward -Y here (+Z in glTF).
  - Extras: arc_outline (metres) and arc_bob (metres): the session hovers the node that far above the ground,
    bobs it and turns it about its own vertical axis, like the shrine's crystal.
  - Budgets: each pickup under ~900 triangles; the engine clones one per placement.
"""
import bpy, math
from mathutils import Vector

PICKUP_OUTLINE = 0.009
PICKUP_BOB = 0.12
PICKUPS_REVIEW = OUT + '/arcade/arcade-pickups-review.png'
PICK_MATS = {
    'ARC_Burlap':    ('#f7c983', {'shade': '#d6b9ab'}),
    'ARC_Rope':      ('#f8e1a8', {}),
    'ARC_Honey':     ('#ffb23e', {'shade': '#d9a2a6', 'rim': 0.7}),
    'ARC_Heart':     ('#ff5f6f', {}),
    'ARC_LeafGreen': ('#7cc843', {'shade': '#9bb6cc'}),
}
PICKUP_BUILDERS = []    # (id, builder, label), filled by @pickup


def pickup(pid, label):
    def reg(fn):
        PICKUP_BUILDERS.append((pid, fn, label)); return fn
    return reg


def pick_mats():
    M = prop_mats()
    for k, (h, kw) in PICK_MATS.items(): M[k[4:]] = toon(k, h, **kw)
    return M


def reshape(ob, fn):
    """Move every vertex radially about Z: fn(r, z, angle) -> new r (ribs, scallops, lumps on a lathe)."""
    for v in ob.data.vertices:
        r = math.hypot(v.co.x, v.co.y)
        if r < 1e-6: continue
        a = math.atan2(v.co.y, v.co.x); k = fn(r, v.co.z, a) / r
        v.co.x *= k; v.co.y *= k
    ob.data.update()
    return ob


def heart(w, h, n=16):
    """A heart outline in (u, v), w wide and h tall, its point at v=0."""
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = 16 * math.sin(t) ** 3; y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((x / 32 * w, (y + 17) / 29 * h))
    return pts


def leaf(length, width, n=4):
    """A pointed leaf outline along +u, base at the origin."""
    top = [(length * i / n, width * math.sin(math.pi * i / n) ** 0.8) for i in range(n + 1)]
    return top + [(u, -v) for u, v in reversed(top[1:-1])]

# ---------------------------------------------------------------- pebble pouch (ammo)

@pickup('pouch', 'Pouch')
def pouch(M):
    """A tied drawstring sling pouch, bulging with shot, three crossbow bolts fanning out of its tuft and a pebble patch
    stitched on the front. Reads as 'ammo' for every weapon in the set."""
    sack = lathe('sack', [(0.0, 0.0), (0.12, 0.004), (0.19, 0.055), (0.205, 0.14), (0.18, 0.22), (0.115, 0.28),
                          (0.074, 0.305), (0.085, 0.33), (0.108, 0.355), (0.09, 0.382), (0.045, 0.396), (0.0, 0.4)],
                 axis='Z', segs=20, mat=M['Burlap'], cap=False)
    # cloth: a lumpy belly, and the tuft above the cord gathered into six lobes
    reshape(sack, lambda r, z, a: r * (1 + 0.035 * math.sin(3 * a + 1.3) * math.sin(math.pi * min(z / 0.3, 1))
                                        + (0.09 * math.cos(6 * a) * min(1, (z - 0.31) / 0.04) if z > 0.31 else 0.0)))
    smooth(sack, 60, weighted=False)
    cord = torus('cord', 0.08, 0.019, (0, 0, 0.305), M['Rope'], axis='Z', segs=12, rsegs=4)
    tail = tube('tail', bez((0.02, -0.078, 0.3), (0.06, -0.13, 0.25), (0.035, -0.15, 0.18), 3), [0.011, 0.01, 0.009, 0.008],
                M['Rope'], segs=5)
    knot = ball('knot', (0.02, -0.088, 0.3), 0.026, M['Rope'], subd=1)
    patch = cyl('patch', 0.066, -0.19, -0.21, axis='Y', segs=12, mat=M['Plaster'], center=(0, 0, 0.14))
    chunky(patch, 0.005)
    dots = [cyl(f'dot{k}', 0.019, -0.206, -0.215, axis='Y', segs=8, mat=M['StoneDark'], center=(x, 0, z))
            for k, (x, z) in enumerate(((0.0, 0.162), (-0.024, 0.124), (0.024, 0.124)))]
    bolts = []
    for i, (lean, turn) in enumerate(((0.5, 2.3), (0.12, 1.0), (0.45, -0.4))):
        d = Vector((math.sin(lean) * math.cos(turn), math.sin(lean) * math.sin(turn), math.cos(lean)))
        base = Vector((0, 0, 0.3)) + Vector((d.x, d.y, 0)) * 0.1; tip = base + d * 0.26
        shaft = tube(f'shaft{i}', [base, tip - d * 0.035], 0.008, M['Wood'], segs=6)
        head = tube(f'head{i}', [tip - d * 0.04, tip], [0.017, 0.002], M['Iron'], segs=6)
        s0 = d.cross(Vector((0, 0, 1))).normalized(); s1 = d.cross(s0); vanes = []
        for k in range(2):             # a crossed pair of fletching vanes, just above the tuft
            side = s0 if k else s1; nrm = d.cross(side)
            vn = prism(f'fl{i}{k}', [(0, -0.024), (0.05, -0.024), (0.036, 0.024), (0.006, 0.024)], -0.002, 0.002, axis='Y',
                       mat=M['CoralPink'])
            # the vane is drawn in (x along the bolt, z across it), y its thickness: onto (d, side, nrm)
            for v in vn.data.vertices: v.co = base + d * (0.15 + v.co.x) + side * v.co.z + nrm * v.co.y
            vn.data.update(); vanes.append(vn)
        bolts += [shaft, head] + vanes
    tone([sack], lo=0.0, hi=0.4); tone([cord, tail, knot], k=0.95)
    ensure_grad(bolts + [patch] + dots)
    return [sack, cord, tail, knot, patch, *dots, *bolts]

# ---------------------------------------------------------------- honey jar (health)

@pickup('honey', 'Honey')
def honey(M):
    """A fat amber honey jar, a scalloped cloth lid tied with twine, a heart tag on the front and a drip down the side."""
    jar = lathe('jar', [(0.0, 0.0), (0.125, 0.0), (0.152, 0.025), (0.163, 0.11), (0.157, 0.215), (0.122, 0.268),
                        (0.096, 0.285), (0.096, 0.3)], axis='Z', segs=14, mat=M['Honey'], cap=True)
    smooth(jar, 50, weighted=False)
    lid = lathe('lid', [(0.0, 0.336), (0.09, 0.334), (0.118, 0.322), (0.132, 0.3), (0.14, 0.268)], axis='Z', segs=16,
                mat=M['CoralPink'], cap=False)
    # the cloth hangs in eight scallops below the twine
    for v in lid.data.vertices:
        if v.co.z < 0.29:
            a = math.atan2(v.co.y, v.co.x); v.co.z += 0.018 * math.cos(8 * a); r = math.hypot(v.co.x, v.co.y)
            k = (r + 0.008 * math.cos(8 * a)) / r; v.co.x *= k; v.co.y *= k
    lid.data.update(); smooth(lid, 60, weighted=False)
    twine = torus('twine', 0.134, 0.01, (0, 0, 0.297), M['Rope'], axis='Z', segs=16, rsegs=4)    # round the lid, over the cloth
    bow = [ball('bow0', (0.03, -0.14, 0.297), 0.022, M['Rope'], (1.3, 0.6, 0.8), subd=1),
           ball('bow1', (0.068, -0.126, 0.297), 0.022, M['Rope'], (1.3, 0.6, 0.8), subd=1)]
    # a flat tag on a round jar: narrow enough that its edges still touch the glass
    tag = prism('tag', rrect(0.11, 0.11, 0.025, 0, 0.135, n=2), -0.166, -0.15, axis='Y', mat=M['Plaster'])
    chunky(tag, 0.004)
    hrt = prism('heart', [(u, v + 0.095) for u, v in heart(0.078, 0.072)], -0.174, -0.164, axis='Y', mat=M['Heart'])
    chunky(hrt, 0.003)
    # the drip hugs the glass: down the shoulder from under the lid, bulging where it gathers
    ca, sa = math.cos(-2.3), math.sin(-2.3)
    drip = tube('drip', [(ca * r, sa * r, z) for r, z in ((0.132, 0.272), (0.148, 0.24), (0.159, 0.208))], [0.017, 0.013, 0.016],
                M['Honey'], segs=6)
    blob_ = ball('dripend', (ca * 0.16, sa * 0.16, 0.2), 0.016, M['Honey'], subd=2)
    tone([jar], bottom=(0.8, 0.66, 0.62), lo=0.0, hi=0.3); tone([lid, twine] + bow, k=0.97, lo=0.26, hi=0.34)
    ensure_grad([tag, hrt, drip, blob_])
    return [jar, lid, twine, *bow, tag, hrt, drip, blob_]

# ---------------------------------------------------------------- fizz-bomb gourd (grenade)

@pickup('fizzbomb', 'Fizzbomb')
def fizzbomb(M):
    """A ribbed lilac gourd with a stubby stem, one leaf and a curled fuse ending in a glowing spark."""
    body = lathe('gourd', [(0.0, 0.0), (0.075, 0.004), (0.135, 0.035), (0.158, 0.095), (0.146, 0.165), (0.1, 0.21),
                           (0.055, 0.232), (0.046, 0.246)], axis='Z', segs=24, mat=M['Lilac'], cap=False)
    reshape(body, lambda r, z, a: r * (1 - 0.17 * (0.5 - 0.5 * math.cos(8 * a)) * math.sin(math.pi * min(z / 0.24, 1)) ** 0.7))
    smooth(body, 70, weighted=False)
    stem = cyl('stem', 0.045, 0.24, 0.272, axis='Z', segs=8, mat=M['WoodDark'], r2=0.036)
    chunky(stem, 0.006)
    fuse = tube('fuse', bez((0.0, 0.0, 0.265), (0.02, -0.02, 0.36), (0.075, -0.02, 0.335), 6), taper(0.012, 0.009, 7),
                M['Rope'], segs=6)
    spark = ball('spark', (0.08, -0.02, 0.335), 0.032, M['Glow'], subd=2)
    lf = prism('leaf', leaf(0.1, 0.034), -0.003, 0.003, axis='Y', mat=M['LeafGreen'])
    xform(lf, rot=[('Y', -0.5), ('Z', 2.2)], loc=(-0.03, 0.02, 0.255))
    # the grooves between the ribs darker than the lobes, over the usual bottom-up gradient
    def rib(w, l):
        t = min(1.0, max(0.0, l.z / 0.25)); g = 0.5 + 0.5 * math.cos(8 * math.atan2(l.y, l.x)); k = 0.68 + 0.32 * g ** 0.6
        return tuple((b + (1 - b) * t) * k for b in (0.76, 0.72, 0.88))
    paint([body], rib); tone([stem, fuse, lf], k=0.95)
    ensure_grad([spark])
    return [body, stem, fuse, spark, lf]

# ---------------------------------------------------------------- build, review, ship

def build_pickups():
    """Every pickup merged into ARC_P_<Label> in ARC_Pickups (linked into the review scene), outlined, lined up on the
    review meadow hovering at their bob height; returns their triangles and sizes."""
    M = pick_mats()
    sc, back, _ = _review_scene()
    P = bpy.data.collections.get('ARC_Pickups') or bpy.data.collections.new('ARC_Pickups')
    if P.name not in sc.collection.children: sc.collection.children.link(P)
    _clear(P)
    info, made = {}, []
    for i, (pid, fn, label) in enumerate(PICKUP_BUILDERS):
        ob = put(merge(f'ARC_P_{label}', fn(M)), P)
        ob['arc_outline'] = PICKUP_OUTLINE; ob['arc_bob'] = PICKUP_BOB
        outline(ob, PICKUP_OUTLINE)
        vs = [v.co for v in ob.data.vertices]     # the mesh itself, not the outline shell
        info[pid] = {'tris': tris([ob]), 'size': [round(max(c[k] for c in vs) - min(c[k] for c in vs), 3) for k in range(3)]}
        made.append(ob)
    gap = 0.62; x0 = -gap * (len(made) - 1) / 2
    for i, ob in enumerate(made):
        ob.location = LINEUP + SIDE * (x0 + gap * i) + Vector((0, 0, PICKUP_BOB))
        ob.rotation_euler = (0, 0, FACE + 0.35)
    cam = bpy.data.objects.get('ARC_PickupCam') or bpy.data.objects.new('ARC_PickupCam', bpy.data.cameras.new('ARC_PickupCam'))
    if cam.name not in back.objects: back.objects.link(cam)
    t = LINEUP + Vector((0, 0, 0.3)); d = Vector((0.6, -0.8, 0.5)).normalized()
    cam.location = t + d * 2.9; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 50; cam.data.clip_start = 0.05; cam.data.clip_end = 1000
    return info


def review_pickups(path=PICKUPS_REVIEW, res=(1200, 700), samples=16):
    """One light EEVEE render of the pickups (everything else in the review scene hidden for it)."""
    sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    sc.camera = bpy.data.objects['ARC_PickupCam']
    try: return render_review(path, res, samples, hide=[c.name for c in sc.collection.children if c.name not in ('ARC_ReviewSet', 'ARC_Pickups')])
    finally: sc.camera = keep


def ship_pickups(out=OUT + '/arcade'):
    """One GLB per pickup (a 'Pickup' node, no outline shell) and a 256 px catalog card each."""
    res = {}
    for pid, _, label in PICKUP_BUILDERS:
        res[pid] = export_nodes([('Pickup', [bpy.data.objects[f'ARC_P_{label}']], None, (0, 0, 0), True)], f'{out}/arcade-{pid}.glb')
    res['cards'] = thumbnails(thumbs={pid: ([f'ARC_P_{label}'], False) for pid, _, label in PICKUP_BUILDERS})
    return res
