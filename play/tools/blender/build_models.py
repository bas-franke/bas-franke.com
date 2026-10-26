"""
Builds every 3D model used by play.bas-franke.com in Blender and exports them as GLB.

    blender --background --factory-startup --python build_models.py -- <output-dir>

Everything is procedural (primitives, bevels, simple Principled materials), so the models are reproducible and tiny.
Conventions the frontend relies on:
  * Blender +Y is the model's front (glTF -Z, which is yaw 0 in the games). Rockets point along -Y (glTF +Z) because
    three.js' Object3D.lookAt aims +Z at the target.
  * Origin at the feet for characters, at the centre for props.
  * A material named "Team" is recoloured per player at runtime.
The same functions work when pasted into a Blender MCP session; run build_all() there.
"""

import math
import sys
from pathlib import Path

import bpy

OUT = Path(sys.argv[sys.argv.index("--") + 1]) if "--" in sys.argv else Path("models")


# ---- helpers -----------------------------------------------------------------------------------------------------

def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    # Materials are shared between models (and kept alive with a fake user); only orphaned meshes go.
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


_materials = {}


def material(name, color, rough=0.6, metal=0.0, emission=None, strength=1.0):
    key = (name, color, rough, metal, emission, strength)
    if key in _materials:
        return _materials[key]
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    r, g, b = color
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission:
        er, eg, eb = emission
        bsdf.inputs["Emission Color"].default_value = (er, eg, eb, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    _materials[key] = mat
    return mat


def _finish(obj, mat, smooth=False, bevel=None):
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        mod.limit_method = "ANGLE"
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
        try:
            bpy.ops.object.shade_auto_smooth(angle=math.radians(45))
        except Exception:
            pass
    return obj


def cube(size, loc, mat, rot=(0, 0, 0), bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return _finish(obj, mat, bevel=bevel)


def cylinder(radius, depth, loc, mat, rot=(0, 0, 0), verts=24, r2=None, smooth=True):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc, rotation=rot, vertices=verts)
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=radius, radius2=r2, depth=depth, location=loc, rotation=rot, vertices=verts)
    return _finish(bpy.context.active_object, mat, smooth=smooth)


def sphere(radius, loc, mat, scale=(1, 1, 1), seg=24):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc, segments=seg, ring_count=max(8, seg // 2))
    obj = bpy.context.active_object
    obj.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return _finish(obj, mat, smooth=True)


def torus(major, minor, loc, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, rotation=rot, major_segments=40, minor_segments=12)
    return _finish(bpy.context.active_object, mat, smooth=True)


def export(name, objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_normals=True,
        export_texcoords=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
    )
    print(f"EXPORTED {path}")
    clear_scene()


# ---- palette -------------------------------------------------------------------------------------------------------

def palette():
    return {
        "team": material("Team", (0.8, 0.8, 0.8), rough=0.45, metal=0.1),
        "dark": material("Dark", (0.09, 0.1, 0.13), rough=0.5, metal=0.4),
        "steel": material("Steel", (0.35, 0.38, 0.44), rough=0.35, metal=0.8),
        "gun": material("Gun", (0.16, 0.17, 0.2), rough=0.4, metal=0.6),
        "visor": material("Visor", (0.1, 0.9, 0.8), emission=(0.3, 1.0, 0.85), strength=4.0, rough=0.2),
        "thrust": material("Thrust", (1.0, 0.5, 0.2), emission=(1.0, 0.45, 0.1), strength=6.0),
        "orange": material("Orange", (1.0, 0.45, 0.2), emission=(1.0, 0.4, 0.1), strength=2.0, rough=0.4),
        "white": material("White", (0.92, 0.93, 0.95), rough=0.5),
        "black": material("Black", (0.02, 0.02, 0.03), rough=0.4),
        "cross": material("Cross", (0.4, 1.0, 0.75), emission=(0.3, 1.0, 0.7), strength=3.0),
        "gold": material("Gold", (1.0, 0.78, 0.25), rough=0.3, metal=0.9, emission=(1.0, 0.7, 0.2), strength=0.4),
        "ruby": material("Ruby", (0.9, 0.1, 0.25), rough=0.2, emission=(0.9, 0.05, 0.2), strength=0.8),
        "bomb": material("Bomb", (0.06, 0.06, 0.08), rough=0.35, metal=0.3),
        "fuse": material("Fuse", (0.6, 0.5, 0.3), rough=0.9),
        "spark": material("Spark", (1.0, 0.9, 0.4), emission=(1.0, 0.8, 0.2), strength=8.0),
        "eye": material("Eye", (0.98, 0.98, 1.0), rough=0.3),
        "pupil": material("Pupil", (0.03, 0.03, 0.05), rough=0.3),
    }


# ---- models ------------------------------------------------------------------------------------------------------

def droid(p):
    """Rockets player: a stocky hovering robot, 1.8 m tall, front toward +Y."""
    parts = []
    parts.append(cube((0.72, 0.5, 0.78), (0, 0, 1.02), p["team"], bevel=0.06))
    parts.append(cube((0.42, 0.08, 0.4), (0, 0.27, 1.06), p["dark"], bevel=0.02))
    parts.append(cube((0.26, 0.03, 0.06), (0, 0.32, 1.18), p["visor"], bevel=0.0))
    parts.append(sphere(0.3, (0, 0, 1.6), p["dark"]))
    parts.append(cube((0.4, 0.12, 0.14), (0, 0.24, 1.63), p["visor"], bevel=0.03))
    parts.append(cylinder(0.02, 0.3, (0.12, -0.05, 1.98), p["steel"]))
    parts.append(sphere(0.05, (0.12, -0.05, 2.14), p["orange"], seg=12))
    for side in (-1, 1):
        parts.append(sphere(0.19, (side * 0.47, 0, 1.3), p["team"], seg=18))
        parts.append(cylinder(0.09, 0.55, (side * 0.5, 0, 0.98), p["dark"]))
        parts.append(sphere(0.11, (side * 0.5, 0, 0.7), p["steel"], seg=14))
    # Launcher on the right arm.
    parts.append(cylinder(0.1, 0.75, (0.5, 0.3, 0.72), p["gun"], rot=(math.radians(90), 0, 0)))
    parts.append(cylinder(0.13, 0.12, (0.5, 0.66, 0.72), p["gun"], rot=(math.radians(90), 0, 0)))
    parts.append(cylinder(0.06, 0.02, (0.5, 0.73, 0.72), p["thrust"], rot=(math.radians(90), 0, 0)))
    # Hover skirt and thruster.
    parts.append(cylinder(0.3, 0.4, (0, 0, 0.44), p["team"], r2=0.16))
    parts.append(cylinder(0.17, 0.12, (0, 0, 0.2), p["dark"]))
    parts.append(cylinder(0.12, 0.06, (0, 0, 0.13), p["thrust"]))
    export("droid", parts)


def launcher(p):
    """First-person rocket launcher; barrel along +Y, origin near the grip."""
    parts = []
    parts.append(cylinder(0.07, 0.8, (0, 0.25, 0.06), p["gun"], rot=(math.radians(90), 0, 0)))
    parts.append(cylinder(0.1, 0.14, (0, 0.62, 0.06), p["gun"], rot=(math.radians(90), 0, 0), r2=0.12))
    parts.append(cylinder(0.05, 0.02, (0, 0.7, 0.06), p["thrust"], rot=(math.radians(90), 0, 0)))
    parts.append(cube((0.16, 0.34, 0.18), (0, 0.02, 0.04), p["dark"], bevel=0.03))
    parts.append(cube((0.09, 0.3, 0.05), (0.085, 0.25, 0.08), p["orange"], bevel=0.01))
    parts.append(cube((0.07, 0.14, 0.22), (0, -0.08, -0.14), p["dark"], rot=(math.radians(-18), 0, 0), bevel=0.02))
    parts.append(cube((0.04, 0.1, 0.07), (0, 0.3, 0.17), p["steel"], bevel=0.01))
    parts.append(cube((0.03, 0.02, 0.05), (0, 0.36, 0.22), p["visor"], bevel=0.0))
    parts.append(torus(0.075, 0.015, (0, 0.5, 0.06), p["steel"], rot=(math.radians(90), 0, 0)))
    export("launcher", parts)


def rocket(p):
    """Rocket projectile; nose toward -Y (glTF +Z)."""
    parts = []
    parts.append(cylinder(0.09, 0.42, (0, 0.02, 0), p["steel"], rot=(math.radians(90), 0, 0)))
    parts.append(cylinder(0.09, 0.22, (0, -0.3, 0), p["orange"], rot=(math.radians(-90), 0, 0), r2=0.0))
    parts.append(cylinder(0.06, 0.08, (0, 0.27, 0), p["thrust"], rot=(math.radians(90), 0, 0)))
    for i in range(4):
        a = i * math.pi / 2
        fin = cube((0.02, 0.14, 0.14), (math.cos(a) * 0.12, 0.16, math.sin(a) * 0.12), p["gun"], rot=(0, a, 0), bevel=0.0)
        parts.append(fin)
    export("rocket", parts)


def healthpack(p):
    parts = [cube((0.5, 0.5, 0.5), (0, 0, 0), p["white"], bevel=0.05)]
    parts.append(cube((0.3, 0.54, 0.1), (0, 0, 0), p["cross"], bevel=0.0))
    parts.append(cube((0.1, 0.54, 0.3), (0, 0, 0), p["cross"], bevel=0.0))
    parts.append(cube((0.54, 0.3, 0.1), (0, 0, 0), p["cross"], bevel=0.0))
    parts.append(cube((0.54, 0.1, 0.3), (0, 0, 0), p["cross"], bevel=0.0))
    export("healthpack", parts)


def build_all():
    clear_scene()
    p = palette()
    droid(p)
    launcher(p)
    rocket(p)
    healthpack(p)


if __name__ == "__main__":
    build_all()
