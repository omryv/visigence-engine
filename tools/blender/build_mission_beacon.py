"""Original extraction marker; exports only task-created geometry and restores selection."""
import bpy
from pathlib import Path
root=Path(VISIGAMES_ROOT)
previous=list(bpy.context.selected_objects);active=bpy.context.view_layer.objects.active
collection=bpy.data.collections.new('Visigames Mission Beacon');bpy.context.scene.collection.children.link(collection)
objects=[];materials=[]
def mat(name,color,metal=0,emission=0):
 m=bpy.data.materials.new(name);materials.append(m);m.use_nodes=True;b=m.node_tree.nodes.get('Principled BSDF');b.inputs['Base Color'].default_value=(*color,1);b.inputs['Metallic'].default_value=metal;b.inputs['Roughness'].default_value=.4
 b.inputs['Emission Color'].default_value=(*color,1);b.inputs['Emission Strength'].default_value=emission
 return m
def box(name,location,dimensions,material):
 bpy.ops.mesh.primitive_cube_add(size=1,location=location);o=bpy.context.object;objects.append(o);o.name=name;o.dimensions=dimensions;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 for c in list(o.users_collection):c.objects.unlink(o)
 collection.objects.link(o);o.data.materials.append(material);m=o.modifiers.new('Machined edge','BEVEL');m.width=.018;m.segments=2;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
try:
 bpy.ops.object.select_all(action='DESELECT')
 shell=mat('Beacon graphite',(.055,.075,.09),.65);light=mat('Extraction cyan',(.06,.72,.84),0,2.8);trim=mat('Brushed alloy',(.25,.3,.34),.8)
 box('Weighted base',(0,0,.055),(.5,.5,.11),shell);box('Beacon housing',(0,0,.48),(.26,.26,.8),shell)
 for y in [-.137,.137]:
  box('Identification light',(0,y,.56),(.13,.016,.48),light)
 box('Protective crown',(0,0,.92),(.31,.31,.065),trim)
 bpy.ops.object.select_all(action='DESELECT')
 for o in objects:o.select_set(True)
 bpy.context.view_layer.objects.active=objects[0]
 path=root/'assets/studio/mission-beacon.glb';bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True)
 print({'file':str(path),'bytes':path.stat().st_size,'creator':'Visigence','source':'Original Blender geometry','license':'CC0-1.0'})
finally:
 for o in objects:
  mesh=o.data;bpy.data.objects.remove(o,do_unlink=True)
  if mesh.users==0:bpy.data.meshes.remove(mesh)
 bpy.data.collections.remove(collection)
 for m in materials:
  if m.users==0:bpy.data.materials.remove(m)
 for o in previous:
  if o.name in bpy.data.objects:o.select_set(True)
 if active and active.name in bpy.data.objects:bpy.context.view_layer.objects.active=active
