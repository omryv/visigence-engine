"""An original, lightweight static prop for the studio's import walkthrough."""
import bpy
from pathlib import Path
root = Path(VISIGAMES_ROOT)
collection = bpy.data.collections.new('Visigames Import Demo')
bpy.context.scene.collection.children.link(collection)
previous = list(bpy.context.selected_objects)
active = bpy.context.view_layer.objects.active
bpy.ops.object.select_all(action='DESELECT')
def material(name, color, metallic=0):
    m = bpy.data.materials.new(name); m.diffuse_color = (*color, 1); m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF'); bs.inputs['Base Color'].default_value=(*color,1); bs.inputs['Metallic'].default_value=metallic; bs.inputs['Roughness'].default_value=.42
    return m
shell=material('Demo graphite shell',(.075,.105,.11),.5)
edge=material('Demo brushed metal',(.24,.29,.28),.75)
stripe=material('Demo signal mint',(.25,.8,.55),.2)
objects=[]
def box(name, loc, scale, mat, bevel=.025):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc); o=bpy.context.object; o.name=name; o.dimensions=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    for c in list(o.users_collection): c.objects.unlink(o)
    collection.objects.link(o); o.data.materials.append(mat)
    mod=o.modifiers.new('Soft manufactured edges','BEVEL');mod.width=bevel;mod.segments=3
    o.modifiers.new('Weighted normals','WEIGHTED_NORMAL'); objects.append(o)
box('Supply case', (0,0,.46),(1.25,.8,.84),shell,.065)
box('Case lid',(0,0,.91),(1.3,.85,.12),edge)
for x in [-.49,.49]:
    box('Reinforced band',(x,0,.48),(.075,.84,.91),edge)
    box('Latch',(x,-.446,.77),(.13,.055,.18),stripe,.012)
box('Signal strip',(0,-.414,.51),(.55,.028,.06),stripe,.009)
bpy.ops.object.select_all(action='DESELECT')
for o in objects:o.select_set(True)
bpy.context.view_layer.objects.active=objects[0]
path=root/'assets/studio/import-demo.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True)
for o in objects:bpy.data.objects.remove(o,do_unlink=True)
bpy.data.collections.remove(collection)
for o in previous:
    if o.name in bpy.data.objects:o.select_set(True)
if active and active.name in bpy.data.objects:bpy.context.view_layer.objects.active=active
print({'file':str(path),'bytes':path.stat().st_size,'source':'Original Visigames Blender geometry','purpose':'Static prop import example'})
