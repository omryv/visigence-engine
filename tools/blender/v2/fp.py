"""First-person weapon rig toolkit (camera space, no hands): an armature of weapon bones plus hand SOCKETS,
a first-person preview camera, clip authoring helpers and GLB export.

Camera space: eye at the origin, Blender +Y is the view direction (glTF -Z), Z up, X right.
The gun mesh is skinned to weapon bones (Weapon, Mag, Bolt, ...). Hand_R / Hand_L are non-deforming socket
bones animated with the gun, so a hand asset can be attached later without re-animating.
exec after vg.py.
"""
import bpy, math
from mathutils import Vector, Matrix, Quaternion, Euler

FPS = 30

def build_rig(name, Wm, parts, sockets):
    """Wm: hip matrix (weapon-local -> camera space).
    parts: [(bone, local_head, parent)] weapon-local heads, bones point along the weapon's +Y; 'Weapon' is implicit.
    sockets: {'Hand_R': local_matrix, 'Hand_L': local_matrix} hand attachment frames in weapon-local space."""
    arm = bpy.data.armatures.new(name); ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    ob.select_set(True); vl.objects.active = ob
    with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob]):
        bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    wz = Wm.to_3x3() @ Vector((0, 0, 1))
    def bone(n, h, t, parent=None, z=wz, deform=True):
        b = eb.new(n); b.head = Vector(h); b.tail = Vector(t); b.use_deform = deform
        if parent: b.parent = eb[parent]
        b.align_roll(Vector(z))
        return b
    bone('Root', (0, 0, 0), (0, 0.05, 0), z=(0, 0, 1), deform=False)
    bone('Weapon', Wm @ Vector((0, 0, 0)), Wm @ Vector((0, 0.08, 0)), 'Root')
    for n, h, p in parts:
        bone(n, Wm @ Vector(h), Wm @ (Vector(h) + Vector((0, 0.04, 0))), p)
    for n, M in sockets.items():
        W = Wm @ M
        bone(n, W @ Vector((0, 0, 0)), W @ Vector((0, 0.06, 0)), 'Weapon', z=W.to_3x3() @ Vector((0, 0, 1)), deform=False)
    with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob]):
        bpy.ops.object.mode_set(mode='OBJECT')
    for p in ob.pose.bones: p.rotation_mode = 'QUATERNION'
    return ob

def frame(y_dir, z_dir, origin):
    """Local frame: +Y along y_dir, +Z toward z_dir, at origin."""
    y = Vector(y_dir).normalized(); z = Vector(z_dir); z = (z - y * z.dot(y)).normalized(); x = y.cross(z)
    m = Matrix((x, y, z)).transposed().to_4x4(); m.translation = Vector(origin)
    return m

def skin(mesh_ob, group):
    vg = mesh_ob.vertex_groups.get(group) or mesh_ob.vertex_groups.new(name=group)
    vg.add(list(range(len(mesh_ob.data.vertices))), 1.0, 'REPLACE')
    return mesh_ob

def bind(mesh_ob, arm_ob):
    m = mesh_ob.modifiers.new('Armature', 'ARMATURE'); m.object = arm_ob
    mesh_ob.parent = arm_ob
    return mesh_ob

def attach(obj, arm_ob, bone):
    """Rigidly attach an object (fx mesh, marker) to a bone, keeping its world placement."""
    mw = obj.matrix_world.copy()
    obj.parent = arm_ob; obj.parent_type = 'BONE'; obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = mw
    return obj

# ---------------------------------------------------------------- camera + preview

def fp_camera(fov=60.0, aspect=(1600, 900)):
    cam = bpy.data.objects.get('FP_Cam')
    if not cam:
        cam = bpy.data.objects.new('FP_Cam', bpy.data.cameras.new('FP_Cam')); bpy.context.scene.collection.objects.link(cam)
    cam.data.sensor_fit = 'VERTICAL'; cam.data.angle = math.radians(fov); cam.data.clip_start = 0.01
    cam.location = (0, 0, 0); cam.rotation_euler = (math.pi / 2, 0, 0)
    sc = bpy.context.scene; sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = aspect
    return cam

def fp_preview(path, samples=16, bg=(0.18, 0.2, 0.22), res=(1280, 720), eye=None, look=None, fov=60.0):
    """Render what the player sees: 60deg vertical FOV from the eye, soft daylight."""
    gpu(); sc = bpy.context.scene
    cam = fp_camera(fov=fov, aspect=res); sc.cycles.samples = samples; sc.cycles.use_denoising = True
    if eye is not None:
        cam.location = Vector(eye); cam.rotation_euler = (Vector(look) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
    sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
    w = bpy.data.worlds.get('FP_World') or bpy.data.worlds.new('FP_World'); sc.world = w
    nt = w.node_tree; bgn = nt.nodes.get('Background')
    if not nt.nodes.get('FP_Sky'):
        sky = nt.nodes.new('ShaderNodeTexGradient'); sky.name = 'FP_Sky'
        ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.name = 'FP_Ramp'
        mp = nt.nodes.new('ShaderNodeMapping'); tc = nt.nodes.new('ShaderNodeTexCoord')
        mp.inputs['Rotation'].default_value = (0, -math.pi / 2, 0)
        nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs[0], sky.inputs['Vector'])
        nt.links.new(sky.outputs['Fac'], ramp.inputs['Fac']); nt.links.new(ramp.outputs['Color'], bgn.inputs['Color'])
    ramp = nt.nodes['FP_Ramp']
    ramp.color_ramp.elements[0].color = (0.05, 0.05, 0.05, 1); ramp.color_ramp.elements[1].color = (*bg, 1)
    bgn.inputs['Strength'].default_value = 2.2
    sun = bpy.data.objects.get('FP_Sun')
    if not sun:
        sun = bpy.data.objects.new('FP_Sun', bpy.data.lights.new('FP_Sun', 'SUN')); bpy.context.scene.collection.objects.link(sun)
    sun.data.energy = 5.0; sun.data.angle = math.radians(8); sun.rotation_euler = (math.radians(50), math.radians(-25), math.radians(35))
    fill = bpy.data.objects.get('FP_Fill')
    if not fill:
        fill = bpy.data.objects.new('FP_Fill', bpy.data.lights.new('FP_Fill', 'AREA')); bpy.context.scene.collection.objects.link(fill)
    fill.data.energy = 60; fill.data.size = 1.5; fill.location = (-0.8, 0.2, 0.6)
    fill.rotation_euler = (Vector((0.1, 0.3, -0.2)) - fill.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = path; sc.render.film_transparent = False
    bpy.ops.render.render(write_still=True)
    return path

# ---------------------------------------------------------------- clips

def key(ob, bone, frame, loc=None, rot=None):
    """Key a pose bone. loc: local offset (bone space), rot: Euler degrees (x, y, z) in bone space."""
    pb = ob.pose.bones[bone]
    if loc is not None:
        pb.location = Vector(loc); pb.keyframe_insert('location', frame=frame)
    if rot is not None:
        pb.rotation_quaternion = Euler([math.radians(a) for a in rot]).to_quaternion(); pb.keyframe_insert('rotation_quaternion', frame=frame)

def new_clip(ob, name):
    act = bpy.data.actions.new(name); act.use_fake_user = True
    ob.animation_data_create(); ob.animation_data.action = act
    for pb in ob.pose.bones:
        pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0)
    return act

def smooth_keys(act, interp='BEZIER'):
    for fc in _fcurves(act):
        for k in fc.keyframe_points: k.interpolation = interp

def _fcurves(act):
    try: return list(act.fcurves)
    except AttributeError:
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags: out += list(cb.fcurves)
        return out

def cyclic(act):
    for fc in _fcurves(act):
        m = fc.modifiers.new('CYCLES')

def stash_all(ob, actions):
    """Keep every clip on its own muted NLA track so the exporter sees them all."""
    ad = ob.animation_data or ob.animation_data_create()
    for a in actions:
        tr = ad.nla_tracks.new(); tr.name = a.name
        st = tr.strips.new(a.name, int(a.frame_range[0]), a); tr.mute = True
    ad.action = None

def export_fp(objs, path):
    import os
    os.makedirs(os.path.dirname(path), exist_ok=True)
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    for o in objs: o.select_set(True)
    vl.objects.active = objs[0]
    with bpy.context.temp_override(active_object=objs[0], selected_objects=objs):
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
                                  export_extras=True, export_image_format='JPEG', export_jpeg_quality=90, export_animations=True,
                                  export_animation_mode='ACTIONS', export_force_sampling=True, export_frame_step=1,
                                  export_optimize_animation_size=True, export_def_bones=False, export_skins=True, export_materials='EXPORT')
    return os.path.getsize(path)

