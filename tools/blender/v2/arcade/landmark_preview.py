"""Landmark preview: the village's landmarks (src/world/worldLandmarks.js) in the ARC_Village scene, copied from
the LMK_Parts library exactly as the engine places them (the part on its pad, turned to its front; the waterwheel's
axle at the height the grammar put it on the water; a stall's awning in its seed's colour), and the review renders
the landmarks phase ships: the landmarks sheet (landmark_parts.review_landmarks), a top view and a street view of
one seed with the landmarks in the village.

exec after landmark_parts.py and world_preview.py (same globals):
    g['assemble_landmark'](landmark, name, coll, at, yaw, lite=False)   one placed landmark (its objects)
    g['render_landmark_views'](level_json_path)                        assets/v2/arcade/arcade-landmarks-{top,street}.png
"""
import bpy, math
from mathutils import Vector, Matrix

LANDMARKS_TOP = OUT + '/arcade/arcade-landmarks-top.png'
LANDMARKS_STREET = OUT + '/arcade/arcade-landmarks-street.png'


def _slot_material(slot, hex_):
    """A colour slot (LMK_<Slot>) in one colour: the preview's stand-in for the engine's material(slot, hex)."""
    name = 'LMK_%s|%s' % (slot, hex_)
    return bpy.data.materials.get(name) or toon(name, hex_, **LSLOTS.get('LMK_' + slot, ('#ffffff', {}))[1])


def assemble_landmark(L, name, coll, at=(0, 0, 0), yaw=0.0, lite=False):
    """The landmark's part (or its lite twin) copied into `coll` at Blender `at`, turned by `yaw` about Z."""
    LIB = bpy.data.collections.get(PARTS_COLL_L)
    if not LIB: return []
    pid = L['part']
    if lite and LIB.objects.get(pid + '.lite'): pid = pid + '.lite'
    src = LIB.objects.get(pid)
    if not src: return []
    objs = _copy_part(src, coll, Matrix.Translation(Vector(at)) @ Matrix.Rotation(yaw, 4, 'Z'))
    for i, o in enumerate(objs):
        o.name = '%s_%s' % (name, o.name.split('.')[0] if o.parent else pid)
        # the waterwheel's axle sits where the grammar put it on the water (a glTF y is a Blender z)
        if o.parent and o.name.endswith('Wheel') and L.get('wheel') and L['wheel'].get('y') is not None: o.location.z = L['wheel']['y']
    colors = L.get('colors') or {}
    if colors:
        for o in objs:
            if not o.data.materials: continue
            o.data = o.data.copy()
            for si, m in enumerate(o.data.materials):
                if m and m.name.startswith('LMK_') and m.name[4:] in colors: o.data.materials[si] = _slot_material(m.name[4:], colors[m.name[4:]])
    return objs


def render_landmark_views(level_path, top=LANDMARKS_TOP, street=LANDMARKS_STREET, samples=16):
    """One seed's village with its landmarks: the map from above and a street view from the square toward the
    windmill (its hill sits behind the roofs). Two light renders."""
    build_village(level_path)
    level = json.load(open(level_path)); W = level['world']; S = W['square']
    lm = {l['kind']: l for l in W.get('landmarks', [])}
    out_top = render_village_top(top)
    target = lm.get('windmill') or lm.get('lookout')
    if target:
        # stand at the square's far rim from the windmill, look at it (engine axes), pitched a little down
        dx, dz = target['x'] - S['x'], target['z'] - S['z']; l = math.hypot(dx, dz) or 1.0
        at = (S['x'] - dx / l * (S['r'] + 1.5), S['z'] - dz / l * (S['r'] + 1.5))
        look = (dx / l, dz / l, -0.06)
    else:
        at, look = (0.6, 27.5), (0.05, -1.0, -0.05)
    out_street = render_village_street(street, at=at, look=look, lens=26, eye=1.7)
    return {'top': out_top, 'street': out_street, 'landmarks': sorted(lm.keys())}
