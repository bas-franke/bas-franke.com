"""
Builds the Last Light (zombies) models in Blender and exports them as GLB.

    blender --background --factory-startup --python build_zombies.py -- <output-dir> [only]

Output: zombie.glb (four variants), survivor.glb (rigged + animated); weapons, props and arms only when named.
Everything is procedural: bodies are Skin-modifier meshes over a joint graph, subdivided and roughened with a noise
displacement, then weighted to the armature by distance to the bones. Conventions the frontend relies on
(frontend/src/games/zombies/models.ts):
  * Blender +Y is the front (glTF -Z, yaw 0 in the game); characters have their origin at the feet.
  * Bones: root, hips, spine, chest, neck, head, upperarm/forearm/hand/thigh/shin/foot .L/.R. Every bone's local Z axis
    points forward, so +X rotation bends a bone forward on both sides.
  * Zombie meshes Zombie_<Body|Head|ArmL|ArmR|LegL|LegR>_<variant 0-3> (models.ts keeps one variant, hides parts one by
    one for dismemberment); materials Skin, Cloth, ClothB (tinted per zombie), Blood, Eyes, Teeth, Hair, Shoe. Survivor jacket material is Team (player colour).
  * Guns: one object per weapon id, origin at the pistol grip, barrel towards +Y, children <id>_muzzle and <id>_mag.
The same functions work when pasted into a Blender MCP session; run build_all() there.
"""

import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/zombies")
ONLY = ARGS[1] if len(ARGS) > 1 else None
FPS = 30

# ---- helpers -----------------------------------------------------------------------------------------------------


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    for coll in (bpy.data.meshes, bpy.data.armatures):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)
    bpy.context.scene.render.fps = FPS


_materials = {}


def material(name, color, rough=0.6, metal=0.0, emission=None, strength=1.0, spec=0.5):
    if name in _materials:
        return _materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    try:
        bsdf.inputs["Specular IOR Level"].default_value = spec
    except KeyError:
        pass
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    mat.diffuse_color = (*color, 1.0)
    _materials[name] = mat
    return mat


def link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_all(obj):
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.active_object


def smooth(obj, on=True):
    for p in obj.data.polygons:
        p.use_smooth = on
    return obj


def prim(kind, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0, **kw):
    ops = {
        "cube": bpy.ops.mesh.primitive_cube_add,
        "cyl": bpy.ops.mesh.primitive_cylinder_add,
        "cone": bpy.ops.mesh.primitive_cone_add,
        "sphere": bpy.ops.mesh.primitive_uv_sphere_add,
        "torus": bpy.ops.mesh.primitive_torus_add,
    }
    if kind == "cube":
        kw.setdefault("size", 1)
    ops[kind](location=loc, rotation=rot, **kw)
    obj = bpy.context.active_object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        m = obj.modifiers.new("Bevel", "BEVEL")
        m.width = bevel
        m.segments = 2
        m.limit_method = "ANGLE"
    if kind in ("sphere", "torus") or (kind in ("cyl", "cone") and kw.get("vertices", 32) >= 10):
        smooth(obj)
        if kind in ("cyl", "cone"):
            # Keep the caps flat-shaded: split by angle.
            m = obj.modifiers.new("Split", "EDGE_SPLIT")
            m.split_angle = math.radians(40)
    return obj


def box(size, loc, mat, rot=(0, 0, 0), bevel=0.004):
    return prim("cube", mat, loc=loc, rot=rot, scale=size, bevel=bevel)


def cyl(r, depth, loc, mat, rot=(0, 0, 0), verts=16, r2=None):
    if r2 is None:
        return prim("cyl", mat, loc=loc, rot=rot, radius=r, depth=depth, vertices=verts)
    return prim("cone", mat, loc=loc, rot=rot, radius1=r, radius2=r2, depth=depth, vertices=verts)


def along_y(r, length, start_y, z, mat, x=0.0, verts=16, r2=None):
    """A cylinder lying along +Y from start_y."""
    return cyl(r, length, (x, start_y + length / 2, z), mat, rot=(math.radians(90), 0, 0), verts=verts, r2=r2)


def join(objs, name):
    objs = [apply_all(o) for o in objs]
    activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    return obj


def set_origin(obj, point):
    """Moves the object origin to `point` (world) without moving the geometry."""
    d = Vector(point) - obj.location
    obj.data.transform(__import__("mathutils").Matrix.Translation(-d))
    obj.location = Vector(point)


_noise_tex = {}


def noise_tex(name, scale, kind="CLOUDS"):
    if name not in _noise_tex:
        t = bpy.data.textures.new(name, kind)
        t.use_fake_user = True
        if kind == "CLOUDS":
            t.noise_scale = scale
            t.noise_depth = 2
        elif kind == "VORONOI":
            t.noise_scale = scale
        _noise_tex[name] = t
    return _noise_tex[name]


def skin_mesh(name, verts, edges, radii, subsurf=1, disp=0.0, disp_scale=0.06, mats=(), root=0, seed=0):
    """An organic tube mesh over a joint graph: Skin modifier, subdivision, noise displacement, applied."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([Vector(v) for v in verts], edges, [])
    obj = link(bpy.data.objects.new(name, me))
    mod = obj.modifiers.new("Skin", "SKIN")
    mod.use_smooth_shade = True
    mod.branch_smoothing = 0.6
    sv = me.skin_vertices[0].data
    for i, r in enumerate(radii):
        sv[i].radius = r if isinstance(r, tuple) else (r, r)
    sv[root].use_root = True
    sub = obj.modifiers.new("Sub", "SUBSURF")
    sub.levels = subsurf
    sub.render_levels = subsurf
    if disp:
        d = obj.modifiers.new("Disp", "DISPLACE")
        d.texture = noise_tex(f"n{disp_scale}", disp_scale)
        d.strength = disp
        d.mid_level = 0.5
        d.texture_coords = "GLOBAL"
    for m in mats:
        obj.data.materials.append(m)
    obj = apply_all(obj)
    obj.name = name
    smooth(obj)
    return obj


def paint_faces(obj, pick):
    """Sets each face's material index from pick(centre, normal) -> index."""
    for p in obj.data.polygons:
        p.material_index = pick(p.center, p.normal)


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---- rig -----------------------------------------------------------------------------------------------------------

BONES = [
    # name, parent, head, tail
    ("root", None, (0, 0, 0), (0, 0.25, 0)),
    ("hips", "root", (0, 0, 0.96), (0, 0, 1.08)),
    ("spine", "hips", (0, 0, 1.08), (0, 0.01, 1.26)),
    ("chest", "spine", (0, 0.01, 1.26), (0, 0, 1.45)),
    ("neck", "chest", (0, 0, 1.45), (0, 0.02, 1.56)),
    ("head", "neck", (0, 0.02, 1.56), (0, 0.02, 1.76)),
]
for s, x in (("L", -1), ("R", 1)):
    BONES += [
        (f"upperarm.{s}", "chest", (x * 0.17, 0, 1.42), (x * 0.33, 0.0, 1.17)),
        (f"forearm.{s}", f"upperarm.{s}", (x * 0.33, 0.0, 1.17), (x * 0.44, 0.03, 0.94)),
        (f"hand.{s}", f"forearm.{s}", (x * 0.44, 0.03, 0.94), (x * 0.48, 0.05, 0.8)),
        (f"thigh.{s}", "hips", (x * 0.1, 0, 0.95), (x * 0.11, 0.01, 0.51)),
        (f"shin.{s}", f"thigh.{s}", (x * 0.11, 0.01, 0.51), (x * 0.12, -0.02, 0.09)),
        (f"foot.{s}", f"shin.{s}", (x * 0.12, -0.02, 0.09), (x * 0.12, 0.15, 0.02)),
    ]
JOINT = {name: (Vector(h), Vector(t)) for name, _, h, t in BONES}


def build_armature(name, scale=1.0):
    arm_data = bpy.data.armatures.new(name)
    arm = link(bpy.data.objects.new(name, arm_data))
    activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    for bname, parent, h, t in BONES:
        b = eb.new(bname)
        b.head = Vector(h) * scale
        b.tail = Vector(t) * scale
        b.align_roll(Vector((0, 0, 1)) if bname in ("root",) or bname.startswith("foot") else Vector((0, 1, 0)))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length


def skin_to(obj, arm, allowed, scale=1.0, power=5.0, rigid=None):
    """Weights every vertex to the nearest allowed bones (inverse distance), parents to the armature."""
    groups = {b: obj.vertex_groups.new(name=b) for b in allowed}
    segs = {b: (JOINT[b][0] * scale, JOINT[b][1] * scale) for b in allowed}
    for v in obj.data.vertices:
        if rigid:
            groups[rigid].add([v.index], 1.0, "REPLACE")
            continue
        p = obj.matrix_world @ v.co
        ds = sorted(((seg_dist(p, a, b) + 1e-3, n) for n, (a, b) in segs.items()))[:3]
        ws = [(1.0 / d ** power, n) for d, n in ds]
        total = sum(w for w, _ in ws)
        for w, n in ws:
            if w / total > 0.02:
                groups[n].add([v.index], w / total, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    return obj


ALL_POSED = [b[0] for b in BONES if b[0] != "root"]


def keyframes(arm, name, frames):
    """frames: list of (frame, {bone: (x, y, z) degrees}, hips_offset (x, y, z) or None). Unlisted bones rest."""
    arm.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    for frame, rots, off in frames:
        for bname in ALL_POSED:
            pb = arm.pose.bones[bname]
            r = rots.get(bname, (0, 0, 0))
            pb.rotation_euler = tuple(math.radians(a) for a in r)
            pb.keyframe_insert("rotation_euler", frame=frame)
        hb = arm.pose.bones["hips"]
        hb.location = Vector(off or (0, 0, 0))
        hb.keyframe_insert("location", frame=frame)
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, int(frames[0][0]), act)
    strip.name = name
    try:
        if act.slots:
            strip.action_slot = act.slots[0]
    except AttributeError:
        pass
    arm.animation_data.action = None
    return act


def mirror(p):
    """Copies .L rotations to .R (and the reverse) with the sideways axes flipped."""
    out = dict(p)
    for k, (x, y, z) in p.items():
        if k.endswith(".L"):
            out[k[:-2] + ".R"] = (x, -y, -z)
        elif k.endswith(".R"):
            out[k[:-2] + ".L"] = (x, -y, -z)
    return out


def lerp_pose(a, b, t):
    keys = set(a) | set(b)
    return {k: tuple(a.get(k, (0, 0, 0))[i] * (1 - t) + b.get(k, (0, 0, 0))[i] * t for i in range(3)) for k in keys}


def add(*poses):
    out = {}
    for p in poses:
        for k, v in p.items():
            o = out.get(k, (0, 0, 0))
            out[k] = (o[0] + v[0], o[1] + v[1], o[2] + v[2])
    return out


def export(name, objects, animations=False, skins=False, textures=False):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
        for c in o.children_recursive:
            c.select_set(True)
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
        export_image_format="JPEG" if textures else "NONE",
        export_jpeg_quality=90,
        export_normals=True,
        export_texcoords=textures,
        export_vertex_color="ACTIVE",
        export_animations=animations,
        export_animation_mode="ACTIONS",
        export_skins=skins,
        export_def_bones=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
        export_anim_slide_to_zero=True,
        export_force_sampling=True,
        export_frame_step=1,
    )
    print(f"EXPORTED {path}")


# ---- noise -----------------------------------------------------------------------------------------------------------

def noise(p, scale=1.0):
    from mathutils import noise as mn
    return mn.noise(Vector((p[0] * scale, p[1] * scale, p[2] * scale)))


def grime(obj, blood=0.0, dirt=0.35, seed=0.0, low=0.0, stain=(0.38, 0.03, 0.025)):
    """Vertex colour (multiplies the material): smooth blood stains and dirt, darker towards the ground."""
    attr = obj.data.color_attributes.new(name="Col", type="BYTE_COLOR", domain="POINT")
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        q = p + Vector((seed, seed * 0.7, 0))
        d = 1.0 - dirt * (0.5 + 0.5 * noise(q, 7)) - (low * max(0.0, 0.5 - p.z) * 1.4)
        col = [d, d, d]
        b = noise(q * 1.0 + Vector((3.1, 0, 0)), 5) + 0.35 * noise(q, 19)
        if blood and b > 0.55 - blood:
            k = min(1.0, (b - (0.55 - blood)) / 0.25)
            col = [col[0] * (1 - k) + stain[0] * k, col[1] * (1 - k) + stain[1] * k, col[2] * (1 - k) + stain[2] * k]
        attr.data[v.index].color = (max(0, col[0]), max(0, col[1]), max(0, col[2]), 1.0)
    obj.data.color_attributes.active_color = attr
    return obj


def push_verts(obj, fn):
    """Moves every vertex by fn(co, normal) -> offset vector (object space = world here)."""
    for v in obj.data.vertices:
        off = fn(v.co.copy(), v.normal.copy())
        if off is not None:
            v.co += off


# ---- characters ------------------------------------------------------------------------------------------------------
#
# Bodies are Skin-modifier meshes over joint graphs, subdivided twice, with anatomy and cloth carved into the vertices
# (ribs, sunken belly, wounds, folds), loose cloth strips, modelled faces and hair. A per-character normal map is
# baked in Cycles from procedural bump detail (pores, veins, weave, wrinkles) into one shared 1024 atlas, so every
# part keeps its own object (dismemberment) while sharing one texture.



def survivor_palette():
    return {
        "team": material("Team", (0.5, 0.5, 0.5), rough=0.72, spec=0.35),
        "skin": material("SurvivorSkin", (0.33, 0.2, 0.14), rough=0.55, spec=0.45),
        "pants": material("Pants", (0.075, 0.075, 0.065), rough=0.88),
        "boots": material("Boots", (0.025, 0.02, 0.016), rough=0.45),
        "gear": material("Gear", (0.075, 0.08, 0.06), rough=0.75, metal=0.0),
        "strap": material("Strap", (0.018, 0.018, 0.018), rough=0.6),
        "eyes": material("SurvivorEyes", (0.6, 0.6, 0.58), rough=0.05),
    }


def decimate(obj, ratio):
    d = obj.modifiers.new("Dec", "DECIMATE")
    d.ratio = ratio
    d.use_collapse_triangulate = False
    obj = apply_all(obj)
    return smooth(obj)


def mat_index(obj, mat):
    return list(obj.data.materials).index(mat)


def faces_of(obj, mats):
    ids = {mat_index(obj, m) for m in mats if m.name in obj.data.materials}
    return [p for p in obj.data.polygons if p.material_index in ids]


def group_from_mats(obj, mats, name):
    vg = obj.vertex_groups.new(name=name)
    vs = set()
    for p in faces_of(obj, mats):
        vs.update(p.vertices)
    vg.add(list(vs), 1.0, "REPLACE")
    return vg


def displace_group(obj, group, strength, scale, kind="CLOUDS", tex_name=None, axis="NORMAL"):
    """Applies a noise displacement restricted to a vertex group (cloth folds only on cloth)."""
    t = noise_tex(tex_name or f"{kind}{scale}", scale, kind)
    if kind == "WOOD":
        t.wood_type = "BANDNOISE"
        t.turbulence = 9.0
        t.noise_scale = scale
    d = obj.modifiers.new("Folds", "DISPLACE")
    d.texture = t
    d.strength = strength
    d.mid_level = 0.5
    d.texture_coords = "GLOBAL"
    d.direction = axis
    if group:
        d.vertex_group = group
    return apply_all(obj)


def delete_faces(obj, pick):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    kill = [f for f in bm.faces if pick(f.calc_center_median(), f.normal)]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()


def strip(top, length, width, out, mat, sway=0.0, seed=0, segs=5):
    """A hanging torn cloth strip: quads from `top` downwards, curling outwards, ragged at the end."""
    rng = random.Random(seed)
    out = Vector(out).normalized()
    side = Vector((0, 0, 1)).cross(out).normalized()
    verts, faces = [], []
    for k in range(segs + 1):
        t = k / segs
        c = Vector(top) + Vector((0, 0, -length * t)) + out * (0.02 * t + 0.03 * t * t) + side * (sway * t * t)
        w = width * (1 - 0.55 * t) * (0.8 + 0.4 * rng.random())
        verts += [tuple(c - side * w / 2), tuple(c + side * w / 2)]
        if k:
            a = 2 * (k - 1)
            faces.append((a, a + 1, a + 3, a + 2))
    me = bpy.data.meshes.new("strip")
    me.from_pydata(verts, [], faces)
    obj = link(bpy.data.objects.new("strip", me))
    obj.data.materials.append(mat)
    sol = obj.modifiers.new("Solid", "SOLIDIFY")
    sol.thickness = 0.004
    sub = obj.modifiers.new("Sub", "SUBSURF")
    sub.levels = 1
    obj = apply_all(obj)
    return smooth(obj)


def torso_graph(s, bulk=1.0, gaunt=1.0):
    """Pelvis to neck with shoulder and hip stubs. Radii are (side-to-side, front-to-back)."""
    g = gaunt
    verts = [
        (0, 0.0, 0.92), (0, 0.012, 1.07), (0, 0.016, 1.21), (0, 0.008, 1.35), (0, -0.004, 1.44),
        (0, 0.012, 1.5), (0, 0.022, 1.59),
        (-0.15, -0.005, 1.425), (0.15, -0.005, 1.425), (-0.095, 0, 0.9), (0.095, 0, 0.9),
    ]
    radii = [
        (0.155 * bulk, 0.11 * bulk), (0.13 * bulk * g, 0.085 * bulk * g), (0.145 * bulk * g, 0.1 * bulk * g),
        (0.168 * bulk, 0.112 * bulk), (0.15 * bulk, 0.095 * bulk), (0.052 * bulk, 0.05 * bulk), (0.047, 0.047),
        (0.07 * bulk, 0.065 * bulk), (0.07 * bulk, 0.065 * bulk), (0.098 * bulk, 0.095 * bulk), (0.098 * bulk, 0.095 * bulk),
    ]
    edges = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (4, 7), (4, 8), (0, 9), (0, 10)]
    return verts, edges, radii

def arm_graph(x, bulk=1.0, claw=True):
    verts = [
        (x * 0.155, 0, 1.42), (x * 0.245, 0, 1.3), (x * 0.33, 0, 1.17), (x * 0.385, 0.015, 1.05), (x * 0.44, 0.03, 0.94),
        (x * 0.462, 0.042, 0.875),
    ]
    radii = [0.06 * bulk, 0.044 * bulk, 0.037 * bulk, 0.036 * bulk, 0.027 * bulk, (0.034 * bulk, 0.017 * bulk)]
    edges = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)]
    # Fingers (long and hooked on the zombie) and a thumb.
    for k, dy in enumerate((-0.022, -0.007, 0.008, 0.022)):
        a = len(verts)
        length = (0.05, 0.058, 0.055, 0.045)[k] * (1.15 if claw else 1)
        verts += [(x * 0.475, 0.045 + dy, 0.845), (x * 0.483, 0.05 + dy + (0.012 if claw else 0), 0.845 - length * 0.6),
                  (x * 0.48, 0.06 + dy + (0.03 if claw else 0.005), 0.845 - length)]
        radii += [0.0105 * bulk, 0.0085 * bulk, 0.006 * bulk]
        edges += [(5, a), (a, a + 1), (a + 1, a + 2)]
    a = len(verts)
    verts += [(x * 0.455, 0.07, 0.885), (x * 0.455, 0.095, 0.86)]
    radii += [0.011 * bulk, 0.008 * bulk]
    edges += [(5, a), (a, a + 1)]
    return verts, edges, radii

def leg_graph(x, bulk=1.0, boot=1.0):
    verts = [(x * 0.098, 0, 0.93), (x * 0.104, 0.006, 0.72), (x * 0.11, 0.01, 0.51), (x * 0.114, -0.006, 0.32),
             (x * 0.12, -0.02, 0.1), (x * 0.12, -0.055, 0.045), (x * 0.122, 0.07, 0.04), (x * 0.122, 0.15, 0.035)]
    radii = [0.088 * bulk, 0.07 * bulk, 0.05 * bulk, 0.05 * bulk, 0.036 * boot, 0.038 * boot, (0.045 * boot, 0.035 * boot), (0.04 * boot, 0.025 * boot)]
    edges = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (4, 6), (6, 7)]
    return verts, edges, radii


# ---- heads ------------------------------------------------------------------------------------------------------------

HEAD_C = Vector((0, 0.03, 1.665))
HEAD_R = Vector((0.078, 0.099, 0.115))


def head_u(co):
    d = co - HEAD_C
    return Vector((d.x / HEAD_R.x, d.y / HEAD_R.y, d.z / HEAD_R.z))


def bump(u, centre, radius):
    d = (u - Vector(centre)).length
    return max(0.0, 1 - d / radius) ** 2


def head_mesh(name, p, zombie=True):
    """A modelled head: skull, brow, sockets, cheekbones, nose, lips, jaw, chin and ears, plus eyes, mouth and teeth
    (open and rotten on the zombie, with matted hair)."""
    skin = p["skin"]
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 0), segments=72, ring_count=52)
    obj = bpy.context.active_object
    obj.name = name
    for v in obj.data.vertices:
        v.co = HEAD_C + Vector((v.co.x * HEAD_R.x, v.co.y * HEAD_R.y, v.co.z * HEAD_R.z))
    obj.data.materials.append(skin)
    obj.data.materials.append(p["blood"] if zombie else skin)
    gaunt = 1.6 if zombie else 1.0

    def shape(co, n):
        u = head_u(co)
        off = Vector((0, 0, 0))
        # A flatter face plane in front, a fuller cranium behind.
        if u.y > 0.25:
            off.y -= (u.y - 0.25) ** 2 * 0.05
        off.y -= 0.01 * bump(u, (0, -0.9, 0.2), 0.8)
        # Jaw: narrower towards the chin, with a defined angle below the ears; chin forward, throat cut under.
        if u.z < -0.05:
            k = min(1.0, (-0.05 - u.z) / 0.8)
            off.x -= (co.x - HEAD_C.x) * 0.32 * k * max(0.2, u.y + 0.4)
        for sx in (-1, 1):
            off.x += sx * 0.006 * bump(u, (sx * 0.8, 0.1, -0.62), 0.35)
        off += Vector((0, 0.012, -0.006)) * bump(u, (0, 0.8, -0.86), 0.38)
        off += Vector((0, -0.012, 0.01)) * bump(u, (0, 0.3, -1.0), 0.45)
        # Brow ridge (two arches), cheekbones, temples.
        for sx in (-1, 1):
            off.y += 0.011 * gaunt * bump(u, (sx * 0.34, 0.88, 0.34), 0.34)
            off += n * 0.009 * gaunt * bump(u, (sx * 0.6, 0.66, -0.06), 0.3)
            off -= n * 0.007 * gaunt * bump(u, (sx * 0.86, 0.32, 0.32), 0.33)
            # Eye sockets, deep and dark on the dead.
            off.y -= (0.016 * gaunt + (0.008 if zombie else 0.0)) * bump(u, (sx * 0.36, 0.9, 0.12), 0.32)
            # Hollow cheeks.
            off -= n * (0.016 if zombie else 0.004) * bump(u, (sx * 0.6, 0.58, -0.42), 0.36)
        # Nose: bridge to tip, wings at the nostrils.
        if abs(u.x) < 0.3 and u.y > 0.5 and -0.34 < u.z < 0.26:
            w = math.cos(min(1.0, abs(u.x) / 0.3) * math.pi / 2) ** 2
            prof = 0.35 + 0.65 * ((0.26 - u.z) / 0.5)
            tail = 1.0 if u.z > -0.2 else max(0.0, (u.z + 0.34) / 0.14)
            off.y += (0.03 if not zombie else 0.02) * w * prof * tail
        for sx in (-1, 1):
            off.y += 0.009 * bump(u, (sx * 0.17, 0.95, -0.24), 0.15)
        # Lips, philtrum and the line of the mouth.
        off.y += 0.008 * bump(u, (0, 0.95, -0.36), 0.28)
        off.y += 0.006 * bump(u, (0, 0.95, -0.5), 0.22)
        off.y -= 0.005 * bump(u, (0, 0.95, -0.43), 0.1)
        if zombie:
            off += n * (0.005 * noise(co, 45) + 0.0025 * noise(co, 120))
        else:
            off += n * 0.001 * noise(co, 90)
        return off

    push_verts(obj, shape)
    obj = decimate(obj, 0.29)
    if zombie:
        # Open the mouth: cut the lips apart and drop the jaw around its hinge.
        delete_faces(obj, lambda c, n: (lambda u: abs(u.x) < 0.3 and -0.5 < u.z < -0.37 and u.y > 0.62)(head_u(c)))
        hinge = Vector((0, HEAD_C.y - 0.02, HEAD_C.z - 0.03))
        ang = math.radians(16)
        for v in obj.data.vertices:
            u = head_u(v.co)
            if u.z < -0.42 and u.y > -0.35:
                k = min(1.0, (-0.42 - u.z) / 0.15) * min(1.0, (u.y + 0.35) / 0.4)
                d = v.co - hinge
                a = ang * k
                v.co = hinge + Vector((d.x, d.y * math.cos(a) + d.z * math.sin(a), -d.y * math.sin(a) + d.z * math.cos(a)))
    smooth(obj)
    # Wounds and torn skin on the zombie.
    if zombie:
        paint_faces(obj, lambda c, n: 1 if (head_u(c).z < -0.3 and head_u(c).y > 0.75 and abs(head_u(c).x) < 0.36) else 0)
    parts = [obj]
    eye_mat = p["eyes"]
    for sx in (-1, 1):
        parts.append(prim("sphere", eye_mat, loc=(sx * 0.031, HEAD_C.y + 0.062 - (0.008 if zombie else 0), HEAD_C.z + 0.014), radius=0.0122, segments=14, ring_count=10))
        # Ears.
        ear = prim("sphere", skin, loc=(sx * (HEAD_R.x + 0.004), HEAD_C.y - 0.005, HEAD_C.z - 0.005), scale=(0.28, 0.6, 1.0), radius=0.032, segments=14, ring_count=10)
        ear = apply_all(ear)
        for v in ear.data.vertices:
            if (v.co.x - sx * HEAD_R.x) * sx > 0.002:
                v.co.y -= 0.006
        if zombie and sx > 0:
            for v in ear.data.vertices:
                if v.co.z > HEAD_C.z:
                    v.co.z = HEAD_C.z + (v.co.z - HEAD_C.z) * 0.3  # torn ear
        parts.append(ear)
    if zombie:
        mouth = prim("sphere", p["blood"], loc=(0, HEAD_C.y + 0.05, HEAD_C.z - 0.055), scale=(1.0, 0.8, 0.8), radius=0.035, segments=14, ring_count=8)
        parts.append(mouth)
        rng = random.Random(3)
        for row, (zc, drop) in enumerate(((HEAD_C.z - 0.04, 0.0), (HEAD_C.z - 0.072, 1.0))):
            for k in range(9):
                a = (k - 4) / 4 * 1.0
                if rng.random() < 0.18:
                    continue  # missing teeth
                x = math.sin(a) * 0.022 + rng.uniform(-0.001, 0.001)
                y = HEAD_C.y + 0.088 - (1 - math.cos(a)) * 0.028 - drop * 0.006
                h = 0.005 + rng.random() * 0.004
                t = box((0.0042, 0.0038, h), (x, y, zc + (-h / 2 if row == 0 else h / 2)), p["teeth"], rot=(rng.uniform(-0.2, 0.2), 0, rng.uniform(-0.2, 0.2)), bevel=0)
                parts.append(t)
        # Matted hair: clumps of strands lying on the scalp, with bald patches.
        rng = random.Random(11)
        hair_parts = []
        for k in range(46):
            th = rng.uniform(0, math.tau)
            ph = rng.uniform(0.05, 1.25)
            dirn = Vector((math.sin(ph) * math.sin(th), -abs(math.cos(th)) * math.sin(ph) * 0.6 + math.cos(ph) * -0.2, math.cos(ph)))
            if dirn.y > 0.55 and dirn.z < 0.75:
                continue
            if noise(dirn * 2.0, 1.0) > 0.45:
                continue  # bald patch
            root = HEAD_C + Vector((dirn.x * HEAD_R.x, dirn.y * HEAD_R.y, dirn.z * HEAD_R.z)) * 1.02
            down = (Vector((dirn.x * 0.4, dirn.y * 0.4 - 0.2, -1.0))).normalized()
            pts = [root]
            for s in range(3):
                n_out = (pts[-1] - HEAD_C).normalized()
                nxt = pts[-1] + (down * 0.032 + n_out * 0.004 + Vector((rng.uniform(-0.01, 0.01), rng.uniform(-0.01, 0.01), 0)))
                # Keep strands on the outside of the skull.
                rel = nxt - HEAD_C
                uu = Vector((rel.x / HEAD_R.x, rel.y / HEAD_R.y, rel.z / HEAD_R.z))
                if uu.length < 1.03:
                    nxt = HEAD_C + Vector((uu.x * HEAD_R.x, uu.y * HEAD_R.y, uu.z * HEAD_R.z)) * (1.03 / uu.length)
                pts.append(nxt)
            if root.z < HEAD_C.z - 0.03:
                continue
            hair_parts.append(skin_mesh(f"hair{k}", [tuple(q) for q in pts], [(0, 1), (1, 2), (2, 3)], [0.009, 0.007, 0.005, 0.0025], subsurf=0, mats=[p["hair"]]))
        parts += hair_parts
    return join(parts, name)


# ---- zombie ---------------------------------------------------------------------------------------------------------
#
# Four zombie bodies on one armature and one clip set: a ragged civilian, a heavy man in a work jacket, a woman in a
# torn dress and a hospital patient in a gown. Each variant has its own parts named Zombie_<Part>_<k> (Body, Head,
# ArmL, ArmR, LegL, LegR); models.ts keeps one variant per instance and hides the rest. Faces are modelled for rot:
# asymmetric, sunken sockets with clouded eyes and drooping lids, a nose partly gone, a cheek torn open onto the gums
# and molars, broken irregular teeth and a crooked hanging jaw. Skin colour (mottling, bruises, veins, lesions) is in
# the vertex colours; a shared atlas carries a baked normal map (wrinkles, pores, veins, weave) and a baked roughness
# map (wet wounds and lips glossy, dry skin and cloth matte).

ZOMBIE_VARIANTS = [
    dict(key="civilian", bulk=0.97, gaunt=0.8, arm=0.82, leg=0.9, female=False, top="shirt", sleeves=(1.27, 1.1),
         legs="trousers", rips=(0.46, 0.18), feet=("bare", "shoe"), hair="matted", tear=1, nose=0.8, seed=1),
    dict(key="worker", bulk=1.12, gaunt=1.05, arm=0.96, leg=1.03, female=False, top="jacket", sleeves=(0.99, 0.99),
         legs="trousers", rips=(0.13, 0.34), feet=("shoe", "shoe"), hair="short", tear=-1, nose=0.5, seed=2),
    dict(key="woman", bulk=0.85, gaunt=0.9, arm=0.74, leg=0.82, female=True, top="dress", sleeves=(None, None),
         legs="bare", rips=(0, 0), feet=("bare", "bare"), hair="long", tear=-1, nose=1.0, seed=3),
    dict(key="patient", bulk=0.9, gaunt=1.35, arm=0.75, leg=0.83, female=False, top="gown", sleeves=(1.29, 1.29),
         legs="bare", rips=(0, 0), feet=("sock", "bare"), hair="bald", tear=1, nose=1.0, seed=4),
]
ZOMBIE_PARTS = ("Body", "Head", "ArmL", "ArmR", "LegL", "LegR")


def zombie_palette():
    pal = {
        "skin": material("Skin", (0.125, 0.125, 0.098), rough=0.7, spec=0.4),
        "cloth": material("Cloth", (0.3, 0.28, 0.25), rough=0.95, spec=0.2),
        "clothb": material("ClothB", (0.1, 0.1, 0.11), rough=0.92, spec=0.2),
        "blood": material("Blood", (0.09, 0.006, 0.006), rough=0.22, spec=0.75),
        "eyes": material("Eyes", (0.19, 0.2, 0.17), rough=0.12, emission=(0.2, 0.21, 0.16), strength=0.025),
        "teeth": material("Teeth", (0.36, 0.32, 0.25), rough=0.4),
        "hair": material("Hair", (0.022, 0.018, 0.015), rough=0.55, spec=0.4),
        "shoe": material("Shoe", (0.03, 0.025, 0.02), rough=0.5),
    }
    for m in pal.values():
        m.use_backface_culling = True
    return pal


# ---- head -----------------------------------------------------------------------------------------------------------

def _ellipsoid_point(u):
    return HEAD_C + Vector((u.x * HEAD_R.x, u.y * HEAD_R.y, u.z * HEAD_R.z))


def _jaw(hinge, ang, roll, shift):
    """Returns a function moving a point of the lower face with the jaw (weight k): dropped, rolled sideways, shifted."""
    def move(co, k):
        d = co - hinge
        a = ang * k
        d = Vector((d.x, d.y * math.cos(a) + d.z * math.sin(a), -d.y * math.sin(a) + d.z * math.cos(a)))
        r = roll * k
        d = Vector((d.x * math.cos(r) - d.z * math.sin(r), d.y, d.x * math.sin(r) + d.z * math.cos(r)))
        return hinge + d + Vector((shift * k, 0, 0))
    return move


def _jaw_weight(u):
    if u.z >= -0.4 or u.y < -0.45:
        return 0.0
    return min(1.0, (-0.4 - u.z) / 0.14) * min(1.0, (u.y + 0.45) / 0.45)


def zombie_ear(p, sx, torn, seed):
    """An ear: a flattened shell with a rolled rim (helix), a hollow bowl (concha) and a lobe, set at the side of the
    head and tilted back."""
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=16, ring_count=12)
    ear = bpy.context.active_object
    ear.data.materials.append(p["skin"])
    ear.data.materials.append(p["blood"])
    rng = random.Random(seed)
    for v in ear.data.vertices:
        x, y, z = v.co  # x: thickness (outwards), y: front-back, z: up
        r = math.sqrt(y * y + z * z)
        # Teardrop outline: wide at the top, narrowing to the lobe.
        width = 0.017 * (0.7 + 0.3 * max(0.0, z))
        height = 0.031
        ny = y * width
        nz = z * height - 0.004
        th = 0.0045 * x
        if x > 0:
            # Outer face: rim raised, bowl sunk, an antihelix ridge between them.
            th += 0.0045 * max(0.0, r - 0.72) / 0.28
            th -= 0.0065 * max(0.0, 1 - ((y + 0.15) ** 2 + (z + 0.15) ** 2) / 0.3)
            th += 0.0018 * math.exp(-((r - 0.55) ** 2) / 0.01)
        if z < -0.65:
            th *= 1.3  # fleshy lobe
        v.co = Vector((sx * th, ny, nz))
    if torn:
        cut = rng.uniform(0.2, 0.5)
        delete_faces(ear, lambda c, n: c.z > cut * 0.031 - 0.004 and c.y > -0.003)
    smooth(ear)
    paint_faces(ear, lambda c, n: 1 if torn and c.z > 0.003 else 0)
    ear.rotation_euler = (math.radians(-8), 0, math.radians(sx * 14))
    ear.location = HEAD_C + Vector((sx * (HEAD_R.x + 0.003), -0.012, -0.012))
    return apply_all(ear)


def zombie_teeth(p, front_y, jaw_move, seed, missing=0.2):
    """Upper and lower arches of irregular, broken, yellowed teeth on dark gums, front incisors back to molars."""
    rng = random.Random(seed)
    parts = []
    for row, zc in ((0, HEAD_C.z - 0.038), (1, HEAD_C.z - 0.066)):
        n = 14
        gum_pts = []
        for k in range(n):
            a = (k - (n - 1) / 2) / ((n - 1) / 2) * 1.32
            x = math.sin(a) * 0.026
            y = front_y - (1 - math.cos(a)) * 0.045
            molar = abs(a) > 0.75
            gum_pts.append(Vector((x, y, zc + (0.006 if row == 0 else -0.006))))
            if rng.random() < missing and abs(a) > 0.1:
                continue
            w = (0.0066 if molar else 0.0054) * rng.uniform(0.85, 1.15)
            d = (0.0068 if molar else 0.0034) * rng.uniform(0.9, 1.1)
            h = (0.0065 if molar else 0.0105) * rng.uniform(0.75, 1.25)
            broken = rng.random() < 0.3
            if broken:
                h *= rng.uniform(0.35, 0.6)
            sign = -1 if row == 0 else 1
            t = box((w, d, h), (x, y, zc + sign * h / 2), p["teeth"], rot=(rng.uniform(-0.25, 0.25), rng.uniform(-0.2, 0.2), a * 0.9 + rng.uniform(-0.25, 0.25)), bevel=0)
            t = apply_all(t)
            # Taper and chip the biting edge.
            tip = zc + sign * h
            for v in t.data.vertices:
                q = t.matrix_world @ v.co
                if abs(q.z - tip) < h * 0.4:
                    v.co.x *= 0.8
                    if broken and rng.random() < 0.5:
                        v.co.z -= sign * h * 0.25
            parts.append(t)
        # Gums: a swollen dark tube along the arch.
        verts = [tuple(q) for q in gum_pts]
        gum = skin_mesh(f"gum{row}", verts, [(i, i + 1) for i in range(len(verts) - 1)], [0.0045] * len(verts), subsurf=0, mats=[p["blood"]])
        parts.append(gum)
    # Lower row and gum move with the jaw.
    lower_z = HEAD_C.z - 0.052
    for t in parts:
        t2 = t
        for v in t2.data.vertices:
            q = t2.matrix_world @ v.co
            if q.z < lower_z:
                v.co = t2.matrix_world.inverted() @ jaw_move(q, 1.0)
    return parts


def zombie_head(name, p, spec):
    """A rotting head: stretched skin over the skull, asymmetric sagging, deep sockets with clouded eyes and lids, a
    half-gone nose, a torn cheek showing the teeth, a crooked hanging jaw, ears and hair per variant."""
    rng = random.Random(spec["seed"] * 31)
    female = spec["female"]
    tear = spec["tear"]
    sag = 1 if spec["seed"] % 2 else -1  # side whose face slumps
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 0), segments=96, ring_count=68)
    obj = bpy.context.active_object
    obj.name = name
    for v in obj.data.vertices:
        v.co = _ellipsoid_point(v.co)
    obj.data.materials.append(p["skin"])
    obj.data.materials.append(p["blood"])
    obj.data.materials.append(p["hair"])
    g = spec["gaunt"] * (0.85 if female else 1.0)

    def shape(co, n):
        u = head_u(co)
        off = Vector((0, 0, 0))
        if u.y > 0.25:
            off.y -= (u.y - 0.25) ** 2 * 0.05
        off.y -= 0.01 * bump(u, (0, -0.9, 0.2), 0.8)
        # Jaw: narrow towards the chin with a sharp angle below the ears (narrower still on the woman).
        if u.z < -0.05:
            k = min(1.0, (-0.05 - u.z) / 0.8)
            off.x -= (co.x - HEAD_C.x) * (0.3 if female else 0.2) * k * max(0.2, u.y + 0.4)
        for sx in (-1, 1):
            off.x += sx * 0.011 * g * bump(u, (sx * 0.8, 0.1, -0.62), 0.32)
            # Skin stretched over bone: brow ridge, cheekbones and zygomatic arch out; temples and cheeks in.
            off.y += 0.012 * g * bump(u, (sx * 0.34, 0.88, 0.36), 0.32)
            off += n * 0.012 * g * bump(u, (sx * 0.62, 0.62, -0.05), 0.26)
            off += n * 0.006 * g * bump(u, (sx * 0.9, 0.2, -0.08), 0.25)
            off -= n * 0.011 * g * bump(u, (sx * 0.86, 0.32, 0.34), 0.32)
            sl = 1.25 if sx == sag else 1.0
            off.y -= (0.027 * sl) * bump(u, (sx * 0.36, 0.9, 0.11 - (0.05 if sx == sag else 0)), 0.31)
            off -= n * 0.026 * g * sl * bump(u, (sx * 0.58, 0.58, -0.42), 0.34)
            # The slumping side: everything below the eye pulled down.
            if sx == sag and u.x * sx > 0.15 and -0.6 < u.z < 0.2:
                off.z -= 0.004 * min(1.0, (u.x * sx - 0.15) / 0.3)
        # Nose: the bridge stays, the tip and wings are gone into two dark holes (spec nose = how much is gone).
        gone = spec["nose"]
        if abs(u.x) < 0.3 and u.y > 0.5 and -0.34 < u.z < 0.26:
            w = math.cos(min(1.0, abs(u.x) / 0.3) * math.pi / 2) ** 2
            prof = 0.35 + 0.65 * ((0.26 - u.z) / 0.5)
            tail = 1.0 if u.z > -0.2 else max(0.0, (u.z + 0.34) / 0.14)
            keep = 1.0 if u.z > 0.02 else 1.0 - gone * min(1.0, (0.02 - u.z) / 0.12)
            off.y += 0.024 * w * prof * tail * keep
        for sx in (-1, 1):
            off.y -= 0.017 * gone * bump(u, (sx * 0.08, 0.98, -0.2), 0.12)
        # Lips shrunk back from the teeth.
        off.y += 0.002 * bump(u, (0, 0.95, -0.36), 0.26)
        off.y += 0.0015 * bump(u, (0, 0.95, -0.52), 0.2)
        # Lumps and lesions.
        off += n * (0.0045 * noise(co, 45) + 0.002 * noise(co, 140))
        off += n * 0.003 * max(0.0, noise(co + Vector((7, 0, 0)), 30) - 0.35) * 4
        if female:
            off -= n * 0.004 * bump(u, (0, 0.6, -0.8), 0.5)
        return off

    push_verts(obj, shape)
    # Holes: the mouth slit, the torn cheek (ragged edge), the nostril cavities painted dark.
    def mouth_cut(c, n):
        u = head_u(c)
        return u.y > 0.55 and (u.x / 0.31) ** 2 + ((u.z + 0.43) / 0.065) ** 2 + 0.35 * noise(c, 90) < 1.0

    def cheek_cut(c, n):
        if not tear:
            return False
        u = head_u(c)
        d = math.hypot((u.x - tear * 0.52) / 0.3, (u.z + 0.42) / 0.19)
        return u.y > 0.15 and u.x * tear > 0.18 and d + 0.25 * noise(c, 60) < 1.0

    delete_faces(obj, lambda c, n: mouth_cut(c, n) or cheek_cut(c, n))
    obj = decimate(obj, 0.3)
    hinge = Vector((0, HEAD_C.y - 0.02, HEAD_C.z - 0.03))
    jaw_move = _jaw(hinge, math.radians(14), math.radians(6 * sag), 0.005 * sag)
    for v in obj.data.vertices:
        k = _jaw_weight(head_u(v.co))
        if k:
            v.co = jaw_move(v.co, k)
    smooth(obj)

    def paint(c, n):
        u = head_u(c)
        if tear:
            d = math.hypot((u.x - tear * 0.52) / 0.3, (u.z + 0.42) / 0.19)
            if u.y > 0.1 and u.x * tear > 0.14 and d < 1.2:
                return 1  # raw edge of the torn cheek
        if spec["nose"] > 0.4 and abs(u.x) < 0.2 and u.y > 0.75 and -0.3 < u.z < -0.08:
            return 1
        if spec["hair"] == "bald" and abs(u.x - 0.15 * math.sin(u.y * 3)) < 0.04 and u.z > 0.35 and u.y < 0.5:
            return 1  # surgical scar over the scalp
        return 0

    paint_faces(obj, paint)
    parts = [obj]
    # The inside of the mouth and the torn cheek: wet dark flesh (only the lower face, so it never shows in the sockets).
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=24, ring_count=16)
    inner = bpy.context.active_object
    inner.data.materials.append(p["blood"])
    for v in inner.data.vertices:
        v.co = _ellipsoid_point(Vector((v.co.x * 0.86, v.co.y * 0.82, v.co.z * 0.86)))
    delete_faces(inner, lambda c, n: head_u(c).z > -0.18)
    for v in inner.data.vertices:
        k = _jaw_weight(head_u(v.co))
        if k:
            v.co = jaw_move(v.co, k)
    smooth(inner)
    parts.append(inner)
    parts += zombie_teeth(p, HEAD_C.y + 0.082, jaw_move, spec["seed"] * 7, missing=0.22)
    # Clouded eyes deep in the sockets, with heavy lids (one drooping).
    for sx in (-1, 1):
        ey = HEAD_C.y + 0.047
        ez = HEAD_C.z + 0.012 - (0.006 if sx == sag else 0)
        eye = prim("sphere", p["eyes"], loc=(sx * 0.031, ey, ez), radius=0.0108, segments=12, ring_count=8)
        parts.append(eye)
        lid = prim("sphere", p["skin"], loc=(sx * 0.031, ey - 0.001, ez), radius=0.0135, segments=14, ring_count=10)
        lid = apply_all(lid)
        droop = 0.55 if sx == sag else 0.25
        delete_faces(lid, lambda c, n, ez=ez, droop=droop: c.z < ez + 0.0135 * (1 - 2 * droop) or c.y < ey - 0.004)
        parts.append(lid)
        lower = prim("sphere", p["blood"], loc=(sx * 0.031, ey - 0.002, ez - 0.001), radius=0.0132, segments=12, ring_count=8)
        lower = apply_all(lower)
        delete_faces(lower, lambda c, n, ez=ez: c.z > ez - 0.008 or c.y < ey - 0.004)
        parts.append(lower)
        parts.append(zombie_ear(p, sx, torn=(sx == -tear if tear else sx > 0) and spec["key"] != "woman", seed=spec["seed"] + sx))
    parts += zombie_hair(p, spec)
    return join(parts, name)


def _scalp(u):
    """Where hair grows: above the brow and ears, thinner at the temples."""
    return u.z > 0.18 - 0.35 * max(0.0, -u.y) and not (u.y > 0.42 and u.z < 0.78)


def zombie_hair(p, spec):
    style = spec["hair"]
    if style == "bald":
        # A few stitches across the surgical scar.
        out = []
        for k in range(7):
            yy = -0.4 + k * 0.13
            u = Vector((0.15 * math.sin(yy * 3), yy, 0))
            u.z = math.sqrt(max(0.0, 1 - u.x * u.x - u.y * u.y))
            q = _ellipsoid_point(u * 1.005)
            out.append(box((0.016, 0.0018, 0.0018), tuple(q), p["shoe"], rot=(0, 0, 0.2), bevel=0))
        return out
    rng = random.Random(spec["seed"] * 101)
    out = []
    # A matted cap: a shell over the scalp, lumpy, torn into patches.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=64, ring_count=40)
    cap = bpy.context.active_object
    cap.data.materials.append(p["hair"])
    thick = {"short": 1.03, "matted": 1.035, "long": 1.035}[style]
    for v in cap.data.vertices:
        u = v.co.copy()
        v.co = _ellipsoid_point(u * (thick + 0.012 * noise(u * 3, 2.0) + 0.006 * noise(u * 9, 2.0)))
    bald = {"short": 0.55, "matted": 0.25, "long": 0.6}[style]

    def kill(c, n):
        u = head_u(c)
        if not _scalp(u):
            return True
        return noise(u * 2.2 + Vector((spec["seed"], 0, 0)), 1.0) > bald
    delete_faces(cap, kill)
    sol = cap.modifiers.new("Solid", "SOLIDIFY")
    sol.thickness = 0.003
    cap = apply_all(cap)
    cap = decimate(cap, 0.3)
    out.append(cap)
    # Clumps and strands hanging from the scalp.
    count = {"short": 0, "matted": 44, "long": 70}[style]
    length = {"matted": (0.05, 0.11), "long": (0.16, 0.34)}.get(style, (0, 0))
    for k in range(count):
        th = rng.uniform(0, math.tau)
        ph = rng.uniform(0.05, 1.35 if style == "long" else 1.2)
        u = Vector((math.sin(ph) * math.sin(th), math.sin(ph) * math.cos(th), math.cos(ph)))
        if not _scalp(u) or (style != "long" and noise(u * 2.2, 1.0) > 0.45) or u.y > (0.35 if style == "long" else 0.2):
            continue
        root = _ellipsoid_point(u * 1.04)
        ln = rng.uniform(*length)
        segs = 5 if style == "long" else 3
        w = rng.uniform(0.005, 0.011)
        verts, faces = [], []
        pos = root.copy()
        out_dir = (root - HEAD_C).normalized()
        side = Vector((0, 0, 1)).cross(out_dir)
        side = side.normalized() if side.length > 1e-4 else Vector((1, 0, 0))
        for s in range(segs + 1):
            t = s / segs
            verts += [tuple(pos - side * w * (1 - 0.7 * t) / 2), tuple(pos + side * w * (1 - 0.7 * t) / 2)]
            if s:
                a = 2 * (s - 1)
                faces.append((a, a + 1, a + 3, a + 2))
            step = Vector((out_dir.x * 0.25, out_dir.y * 0.25, -1.0)).normalized() * (ln / segs)
            pos = pos + step + Vector((rng.uniform(-0.006, 0.006), rng.uniform(-0.006, 0.006), 0))
            # Keep the strand outside the skull and off the face.
            rel = pos - HEAD_C
            uu = Vector((rel.x / HEAD_R.x, rel.y / HEAD_R.y, rel.z / HEAD_R.z))
            if uu.length < 1.06 and pos.z > HEAD_C.z - 0.14:
                pos = _ellipsoid_point(uu * (1.06 / uu.length))
            if uu.y > 0.45 and pos.z < HEAD_C.z + 0.03:
                pos.y -= 0.02
        me = bpy.data.meshes.new("strand")
        me.from_pydata(verts, [], faces)
        st = link(bpy.data.objects.new("strand", me))
        st.data.materials.append(p["hair"])
        sol = st.modifiers.new("Solid", "SOLIDIFY")
        sol.thickness = 0.0015
        out.append(smooth(apply_all(st)))
    return out


# ---- body -----------------------------------------------------------------------------------------------------------

def zombie_body(p, spec):
    mats = [p["cloth"], p["skin"], p["blood"], p["clothb"]]
    female = spec["female"]
    v, e, r = torso_graph(1, bulk=spec["bulk"], gaunt=spec["gaunt"])
    if female:
        # Narrower shoulders, wider hips.
        v[7] = (-0.13, -0.005, 1.425)
        v[8] = (0.13, -0.005, 1.425)
        r[0] = (r[0][0] * 1.12, r[0][1] * 1.05)
    body = skin_mesh(f"Zombie_Body_{spec['k']}", v, e, r, subsurf=2, disp=0.008, disp_scale=0.05, mats=mats)
    if female:
        push_verts(body, lambda co, n: n * 0.03 * max(0.0, 1 - min((Vector((co.x, co.z)) - Vector((s * 0.068, 1.31))).length for s in (-1, 1)) / 0.075) ** 1.5 if n.y > 0.1 else None)
    if spec["key"] == "worker":
        # A belly that has started to bloat.
        push_verts(body, lambda co, n: n * 0.03 * max(0.0, 1 - (Vector((co.x, co.z - 1.12))).length / 0.16) if n.y > 0.0 else None)
    top = spec["top"]

    def pick(c, n):
        z = c.z
        hole = noise(c, 5) + 0.35 * noise(c, 14)
        trousers = top in ("shirt", "jacket")
        if z < 0.99 + 0.025 * noise(c, 30) and trousers:
            return 2 if hole > 0.58 else 3
        if top == "shirt":
            if z < 1.05 + 0.05 * noise(c, 25):
                return 1
            if n.y > 0.25 and abs(c.x + 0.02 * math.sin(z * 40)) < 0.07 + 0.04 * (1.4 - z) and z > 1.12:
                return 1
            if hole > 0.3:
                return 1
        elif top == "jacket":
            if n.y > 0.3 and abs(c.x - 0.01 * math.sin(z * 30)) < 0.045 and z > 1.0:
                return 1  # open front: bare chest
            if hole > 0.48:
                return 2
        elif top == "dress":
            if z > 1.34 + 0.03 * noise(c, 20) and not (abs(abs(c.x) - 0.09) < 0.025 and n.y < 0.9):
                return 1  # neckline and bare shoulders, thin straps
            if hole > 0.42:
                return 1
        elif top == "gown":
            if n.y < -0.45 and abs(c.x + 0.015 * math.sin(z * 25)) < 0.07 and z > 1.0:
                return 1  # gown open at the back
            if z > 1.46:
                return 1
            if hole > 0.5:
                return 2
        if -0.12 < c.x < -0.02 and 1.17 < z < 1.27 and n.y > 0.2 and top != "jacket":
            return 2  # bite wound
        if 0.04 < c.x < 0.14 and 1.07 < z < 1.13 and n.y > 0.1:
            return 2  # gash
        return 0

    paint_faces(body, pick)
    bare = set()
    for poly in body.data.polygons:
        if poly.material_index in (1, 2):
            bare.update(poly.vertices)
    for i in bare:
        vv = body.data.vertices[i]
        co, nn = vv.co, vv.normal
        if 1.13 < co.z < 1.43 and nn.y > -0.4 and not (female and 1.24 < co.z < 1.38):
            phase = (co.z + 0.28 * abs(co.x)) / 0.031
            groove = (0.5 + 0.5 * math.cos(phase * math.tau)) ** 3
            vv.co -= nn * (0.009 * groove + 0.003) * spec["gaunt"]
            if abs(co.x) < 0.012 and nn.y > 0.5:
                vv.co -= nn * 0.006
        elif 1.0 < co.z <= 1.13 and nn.y > 0.0 and spec["key"] != "worker":
            vv.co -= nn * 0.016 * math.sin((co.z - 1.0) / 0.13 * math.pi)
        # Spine and shoulder blades through the skin on the back.
        if nn.y < -0.5 and 1.0 < co.z < 1.45:
            vv.co += nn * 0.006 * math.exp(-(co.x / 0.012) ** 2) * (0.5 + 0.5 * math.cos(co.z / 0.028 * math.tau))
    for poly in body.data.polygons:
        if poly.material_index == 2:
            for i in poly.vertices:
                body.data.vertices[i].co -= body.data.vertices[i].normal * 0.005
    cloth_vg = group_from_mats(body, [p["cloth"], p["clothb"]], "cloth")
    body = displace_group(body, cloth_vg.name, 0.016 if top == "jacket" else 0.013, 0.05, "WOOD", "folds_z")
    body = decimate(body, 0.62)
    extras = []
    rng = random.Random(spec["seed"] * 5)
    if top == "shirt":
        for k in range(9):
            a = rng.uniform(-math.pi, math.pi)
            if abs(a) < 0.35:
                continue
            tp = Vector((math.sin(a) * 0.135, math.cos(a) * 0.095, 1.065 + rng.uniform(-0.01, 0.02)))
            extras.append(strip(tp, rng.uniform(0.1, 0.24), rng.uniform(0.03, 0.06), (math.sin(a), math.cos(a), 0), p["cloth"], sway=rng.uniform(-0.03, 0.03), seed=k))
        for side in (-1, 1):
            extras.append(strip((side * 0.06, 0.12, 1.32), 0.18, 0.05, (side * 0.3, 1, 0), p["cloth"], sway=side * 0.02, seed=20 + side))
    elif top == "jacket":
        # Jacket hem and collar: a skirt below the waist, a turned-up collar.
        extras.append(skirt(p["cloth"], 1.02, 0.86, 0.165 * spec["bulk"], 0.175 * spec["bulk"], rag=0.15, seed=spec["seed"], front_open=0.045))
        extras.append(collar(p["cloth"], spec))
        for k in range(3):
            a = rng.uniform(1.6, 4.6)
            tp = Vector((math.sin(a) * 0.17, math.cos(a) * 0.12, 0.88))
            extras.append(strip(tp, rng.uniform(0.08, 0.15), 0.04, (math.sin(a), math.cos(a), 0), p["cloth"], seed=30 + k))
    elif top == "dress":
        extras.append(skirt(p["cloth"], 0.98, 0.5, 0.165, 0.27, rag=0.6, seed=spec["seed"]))
        for k in range(7):
            a = rng.uniform(-math.pi, math.pi)
            tp = Vector((math.sin(a) * 0.25, math.cos(a) * 0.25, 0.53))
            extras.append(strip(tp, rng.uniform(0.07, 0.17), rng.uniform(0.03, 0.05), (math.sin(a), math.cos(a), 0), p["cloth"], seed=40 + k))
    elif top == "gown":
        extras.append(skirt(p["cloth"], 0.98, 0.58, 0.16, 0.235, rag=0.25, seed=spec["seed"], back_open=0.07))
        # Ties hanging at the back.
        for side in (-1, 1):
            extras.append(strip((side * 0.05, -0.105, 1.2), 0.16, 0.012, (side * 0.4, -1, 0), p["cloth"], seed=50 + side))
    return body, extras


def skirt(mat, z0, z1, r0, r1, rag=0.3, seed=0, front_open=0.0, back_open=0.0):
    """A cloth tube from the waist down (dress, gown, jacket hem), flaring, folded, with a ragged torn hem."""
    rng = random.Random(seed)
    rings, segs = 7, 36
    verts, faces = [], []
    for i in range(rings + 1):
        t = i / rings
        z = z0 + (z1 - z0) * t
        r = r0 + (r1 - r0) * t ** 0.8
        for j in range(segs):
            a = j / segs * math.tau
            fold = 1 + 0.06 * math.sin(a * 9 + seed) * t + 0.03 * math.sin(a * 23) * t
            verts.append((math.sin(a) * r * fold, math.cos(a) * r * 0.8 * fold, z))
    for i in range(rings):
        for j in range(segs):
            a, b = i * segs + j, i * segs + (j + 1) % segs
            faces.append((a, b, b + segs, a + segs))
    me = bpy.data.meshes.new("skirt")
    me.from_pydata(verts, [], faces)
    obj = link(bpy.data.objects.new("skirt", me))
    obj.data.materials.append(mat)

    def kill(c, n):
        a = math.atan2(c.x, c.y)
        if front_open and abs(c.x) < front_open and c.y > 0:
            return True
        if back_open and abs(c.x) < back_open and c.y < 0:
            return True
        depth = (z0 - c.z) / (z0 - z1)
        return depth > 1 - rag * (0.5 + 0.5 * noise(Vector((a * 2, seed, 0)), 1.0)) - 0.1 * math.sin(a * 5 + seed)
    delete_faces(obj, kill)
    sol = obj.modifiers.new("Solid", "SOLIDIFY")
    sol.thickness = 0.005
    sub = obj.modifiers.new("Sub", "SUBSURF")
    sub.levels = 1
    obj = apply_all(obj)
    return smooth(obj)


def collar(mat, spec):
    verts, faces = [], []
    segs = 20
    for i in range(2):
        z = 1.47 + i * 0.05
        r = 0.065 + i * 0.012
        for j in range(segs + 1):
            a = math.pi * 0.25 + j / segs * math.pi * 1.5  # open at the front
            verts.append((math.sin(a) * r, -math.cos(a) * r * 0.9 + 0.01, z))
    for j in range(segs):
        faces.append((j, j + 1, segs + 2 + j, segs + 1 + j))
    me = bpy.data.meshes.new("collar")
    me.from_pydata(verts, [], faces)
    obj = link(bpy.data.objects.new("collar", me))
    obj.data.materials.append(mat)
    sol = obj.modifiers.new("Solid", "SOLIDIFY")
    sol.thickness = 0.006
    return smooth(apply_all(obj))


def zombie_limbs(p, spec):
    mats = [p["cloth"], p["skin"], p["blood"], p["clothb"], p["shoe"]]
    out, extras = {}, {}
    k_ = spec["k"]
    for side, x in (("L", -1), ("R", 1)):
        v, e, r = arm_graph(x, bulk=spec["arm"], claw=True)
        palm = Vector(v[5])
        for i in range(6, len(v)):
            q = Vector(v[i])
            v[i] = tuple(palm + (q - palm) * 1.4)
            r[i] = r[i] * 0.85 if not isinstance(r[i], tuple) else r[i]
        arm = skin_mesh(f"Zombie_Arm{side}_{k_}", v, e, r, subsurf=2, disp=0.006, disp_scale=0.1, mats=mats)
        sleeve = spec["sleeves"][0 if x < 0 else 1]

        def arm_pick(c, n, s=sleeve):
            if s is not None and c.z > s + 0.035 * noise(c, 45):
                return 2 if noise(c, 8) > 0.62 else 0
            return 2 if noise(c + Vector((spec["seed"], 0, 0)), 9) > 0.52 else 1
        paint_faces(arm, arm_pick)
        for vv in arm.data.vertices:
            if vv.co.z < 0.95:
                vv.co += vv.normal * 0.002 * max(0.0, math.sin(vv.co.z * 300))
            # Bones of the wrist and elbow show through.
            if 0.92 < vv.co.z < 0.97:
                vv.co += vv.normal * 0.003
        out[f"arm{side}"] = decimate(arm, 0.17)
        ex = []
        if sleeve is not None and sleeve > 1.0:
            ex.append(strip((x * 0.33 + x * 0.04, 0.0, sleeve + 0.01), 0.12, 0.035, (x, 0.3, 0), p["cloth"], seed=40 + x + 7 * k_))
        extras[f"arm{side}"] = ex
        foot = spec["feet"][0 if x < 0 else 1]
        v, e, r = leg_graph(x, bulk=spec["leg"], boot=1.1 if foot == "shoe" else 0.92)
        if foot != "shoe":
            heel = Vector(v[6])
            for kk, dx in enumerate((-0.022, -0.009, 0.004, 0.016, 0.027)):
                a = len(v)
                base = heel + Vector((x * dx, 0.075, -0.012))
                v += [tuple(base), tuple(base + Vector((x * 0.003, 0.028 - kk * 0.003, -0.006)))]
                r += [0.011 if kk == 0 else 0.008, 0.007 if kk == 0 else 0.0055]
                e += [(6, a), (a, a + 1)]
        leg = skin_mesh(f"Zombie_Leg{side}_{k_}", v, e, r, subsurf=2, disp=0.007, disp_scale=0.07, mats=mats)
        rip = spec["rips"][0 if x < 0 else 1]
        trousers = spec["legs"] == "trousers"

        def leg_pick(c, n, rp=rip, foot=foot):
            if c.z < 0.13:
                return {"bare": 1, "shoe": 4, "sock": 3}[foot]
            if not trousers:
                h = noise(c + Vector((spec["seed"], 0, 0)), 8)
                return 2 if h > 0.55 else 1
            if c.z < rp + 0.05 * noise(c, 25):
                return 1
            h = noise(c, 6) + 0.3 * noise(c, 19)
            if h > 0.52:
                return 1
            if h > 0.44:
                return 2
            return 3
        paint_faces(leg, leg_pick)
        if not trousers:
            # Knees, shin bones and ankles under thin skin.
            for vv in leg.data.vertices:
                if 0.45 < vv.co.z < 0.56 and vv.normal.y > 0.3:
                    vv.co += vv.normal * 0.006
                if 0.12 < vv.co.z < 0.45 and vv.normal.y > 0.6:
                    vv.co += vv.normal * 0.003
        vg = group_from_mats(leg, [p["clothb"]], "cloth")
        leg = displace_group(leg, vg.name, 0.012, 0.05, "WOOD", "folds_z")
        out[f"leg{side}"] = decimate(leg, 0.4)
        ex = []
        if trousers and rip > 0.3:
            ex = [strip((x * 0.115 + x * 0.04 * kk, 0.03 - 0.06 * kk, rip + 0.03), 0.14 + 0.05 * kk, 0.04, (x * 0.6, 0.8 - 1.6 * kk, 0), p["clothb"], seed=60 + kk + x + 9 * k_) for kk in range(2)]
        extras[f"leg{side}"] = ex
    return out, extras


# ---- colour -----------------------------------------------------------------------------------------------------------

def zombie_colors(obj, p, spec, blood=0.42, dirt=0.62, low=0.9, head=False):
    """Vertex colour (multiplies the material): dirt, blood and, on skin, livor mottling, bruises, veins and lesions;
    on the head darker sockets, nostrils and lips."""
    skin_ids = {i for i, m in enumerate(obj.data.materials) if m.name == "Skin"}
    teeth_ids = {i for i, m in enumerate(obj.data.materials) if m.name == "Teeth"}
    on_skin = set()
    on_teeth = set()
    for poly in obj.data.polygons:
        if poly.material_index in skin_ids:
            on_skin.update(poly.vertices)
        if poly.material_index in teeth_ids:
            on_teeth.update(poly.vertices)
    attr = obj.data.color_attributes.new(name="Col", type="BYTE_COLOR", domain="POINT")
    seed = spec["seed"] * 3.7
    stain = (0.2, 0.012, 0.01)
    for v in obj.data.vertices:
        p_ = obj.matrix_world @ v.co
        q = p_ + Vector((seed, seed * 0.7, 0))
        d = 1.0 - dirt * (0.5 + 0.5 * noise(q, 7)) - (low * max(0.0, 0.5 - p_.z) * 1.4)
        col = Vector((d, d, d))
        if v.index in on_skin:
            m = noise(q, 4)
            # Livor and bruising: purple-grey blotches, green-grey elsewhere.
            bruise = max(0.0, noise(q + Vector((5, 1, 0)), 3.0) - 0.15) * 1.6
            col = Vector((col.x * (0.95 + 0.1 * m), col.y * (1.0 + 0.06 * m), col.z * 0.9))
            col = col.lerp(Vector((col.x * 0.78, col.y * 0.62, col.z * 0.92)), min(1.0, bruise))
            # Veins: thin dark blue-green lines where a ridged noise crosses zero.
            vein = abs(noise(q * 1.0 + Vector((0, 9, 0)), 16))
            if vein < 0.05:
                k = 1 - vein / 0.05
                col = col.lerp(Vector((col.x * 0.45, col.y * 0.52, col.z * 0.62)), k * 0.85)
            # Lesions: dark weeping spots.
            les = noise(q + Vector((2, 2, 2)), 22)
            if les > 0.48:
                col = col.lerp(Vector((0.18, 0.07, 0.05)), min(1.0, (les - 0.48) * 6))
        if v.index in on_teeth:
            col = Vector((d * 0.88, d * 0.83, d * 0.7))
        b = noise(q * 1.0 + Vector((3.1, 0, 0)), 5) + 0.35 * noise(q, 19)
        if blood and b > 0.55 - blood:
            k = min(1.0, (b - (0.55 - blood)) / 0.25)
            col = col.lerp(Vector(stain), k)
        if head:
            u = head_u(p_)
            if u.length < 0.9:
                col *= 0.28  # inside the mouth
            for sx in (-1, 1):
                col *= 1 - 0.55 * bump(u, (sx * 0.34, 0.9, 0.1), 0.38)
            col *= 1 - 0.4 * bump(u, (0, 0.95, -0.42), 0.3)
            # Blood run from the mouth and nose down the chin.
            if abs(u.x - 0.05 * math.sin(u.z * 9)) < 0.12 and -1.0 < u.z < -0.25 and u.y > 0.5:
                col = col.lerp(Vector(stain), 0.65)
        attr.data[v.index].color = (max(0, col.x), max(0, col.y), max(0, col.z), 1.0)
    obj.data.color_attributes.active_color = attr
    return obj


# ---- maps ---------------------------------------------------------------------------------------------------------------

ZOMBIE_DETAIL = {
    # Wrinkles stretched horizontally, pores, veins (ridged noise), lesion pits.
    "Skin": (0.55, 0.004, [("noise", 140, 8, 0.5), ("noise", 22, 4, 0.5), ("voronoi", 40, 0, 0.35), ("voronoi", 9, 0, 0.2)]),
    "Blood": (0.7, 0.004, [("noise", 60, 6, 1.0), ("noise", 15, 2, 0.6), ("voronoi", 30, 0, 0.4)]),
    "Cloth": (0.55, 0.005, [("wave", 260, 0, 0.14), ("waveb", 260, 0, 0.14), ("noise", 7, 3, 1.0), ("noise", 40, 4, 0.25)]),
    "ClothB": (0.5, 0.005, [("wave", 220, 0, 0.14), ("noise", 7, 3, 1.0)]),
    "Hair": (0.7, 0.003, [("wave", 400, 0, 0.35), ("noise", 60, 3, 0.6)]),
    "Teeth": (0.5, 0.002, [("noise", 120, 4, 1.0)]),
    "Shoe": (0.5, 0.003, [("noise", 90, 6, 1.0)]),
    "Eyes": (0.2, 0.002, [("noise", 200, 3, 1.0)]),
}

# Roughness per material: (low, high, noise scale). Wet wounds and lips glossy, dry skin matte, cloth matte.
ZOMBIE_ROUGH = {
    "Skin": (0.38, 0.85, 14),
    "Blood": (0.12, 0.35, 30),
    "Cloth": (0.82, 1.0, 9),
    "ClothB": (0.8, 1.0, 9),
    "Hair": (0.35, 0.65, 50),
    "Teeth": (0.25, 0.55, 40),
    "Shoe": (0.35, 0.7, 20),
    "Eyes": (0.05, 0.15, 10),
}


def bake_zombie_maps(meshes, size=2048, rough_size=1024):
    """One atlas for every variant and part: a tangent-space normal map baked from procedural bump per material and a
    roughness map baked from procedural noise per material, then the materials are rewired to Image -> Normal Map and
    Image -> Separate (G) -> Roughness so the glTF exporter writes normalTexture and metallicRoughnessTexture."""
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
        if not m.data.uv_layers:
            m.data.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.003, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.003, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    nrm = bpy.data.images.new("ZombieNormal", size, size, alpha=False, float_buffer=False, is_data=True)
    nrm.generated_color = (0.5, 0.5, 1.0, 1.0)
    nrm.colorspace_settings.name = "Non-Color"
    rgh = bpy.data.images.new("ZombieRough", rough_size, rough_size, alpha=False, float_buffer=False, is_data=True)
    rgh.generated_color = (0.7, 0.7, 0.7, 1.0)
    rgh.colorspace_settings.name = "Non-Color"
    used = {mat for m in meshes for mat in m.data.materials}
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 2
    scene.render.bake.margin = 6

    def build_bump(nt, layers):
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nodes = [tc]
        total = None
        for kind, scale, extra, weight in layers:
            if kind == "noise":
                t = nt.nodes.new("ShaderNodeTexNoise")
                t.inputs["Scale"].default_value = scale
                t.inputs["Detail"].default_value = extra
                out = t.outputs["Fac"]
            elif kind == "voronoi":
                t = nt.nodes.new("ShaderNodeTexVoronoi")
                t.feature = "DISTANCE_TO_EDGE"
                t.inputs["Scale"].default_value = scale
                out = t.outputs["Distance"]
            else:
                t = nt.nodes.new("ShaderNodeTexWave")
                t.wave_type = "BANDS"
                t.bands_direction = "X" if kind == "wave" else "Z"
                t.inputs["Scale"].default_value = scale
                t.inputs["Distortion"].default_value = 2.0
                out = t.outputs["Fac"]
            nt.links.new(tc.outputs["Object"], t.inputs["Vector"])
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            mul.inputs[1].default_value = weight
            nt.links.new(out, mul.inputs[0])
            nodes += [t, mul]
            if total is None:
                total = mul.outputs[0]
            else:
                addn = nt.nodes.new("ShaderNodeMath")
                addn.operation = "ADD"
                nt.links.new(total, addn.inputs[0])
                nt.links.new(mul.outputs[0], addn.inputs[1])
                total = addn.outputs[0]
                nodes.append(addn)
        return total, nodes

    # Pass 1: normals.
    temp = {}
    for mat in used:
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        strength, dist, layers = ZOMBIE_DETAIL.get(mat.name, (0.3, 0.002, [("noise", 80, 4, 1.0)]))
        bmp = nt.nodes.new("ShaderNodeBump")
        bmp.inputs["Strength"].default_value = strength
        bmp.inputs["Distance"].default_value = dist
        total, nodes = build_bump(nt, layers)
        nt.links.new(total, bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], bsdf.inputs["Normal"])
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = nrm
        nt.nodes.active = tex
        temp[mat] = nodes + [bmp, tex]
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=6, use_clear=True)
    nrm.pack()
    for mat, nodes in temp.items():
        for n in nodes:
            mat.node_tree.nodes.remove(n)
    # Pass 2: roughness, baked as emission.
    temp = {}
    for mat in used:
        nt = mat.node_tree
        out_node = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        bsdf = nt.nodes.get("Principled BSDF")
        lo, hi, scale = ZOMBIE_ROUGH.get(mat.name, (0.5, 0.8, 10))
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = scale
        nz.inputs["Detail"].default_value = 6
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = 0.3
        mr.inputs["From Max"].default_value = 0.7
        mr.inputs["To Min"].default_value = lo
        mr.inputs["To Max"].default_value = hi
        nt.links.new(nz.outputs["Fac"], mr.inputs["Value"])
        em = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(mr.outputs["Result"], em.inputs["Color"])
        old = out_node.inputs["Surface"].links[0].from_socket if out_node.inputs["Surface"].links else None
        nt.links.new(em.outputs["Emission"], out_node.inputs["Surface"])
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = rgh
        nt.nodes.active = tex
        temp[mat] = ([tc, nz, mr, em, tex], out_node, old)
    bpy.ops.object.bake(type="EMIT", margin=6, use_clear=True)
    rgh.pack()
    for mat, (nodes, out_node, old) in temp.items():
        nt = mat.node_tree
        for n in nodes:
            nt.nodes.remove(n)
        if old:
            nt.links.new(old, out_node.inputs["Surface"])
    # Rewire for export.
    for mat in used:
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = nrm
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.space = "TANGENT"
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        tr = nt.nodes.new("ShaderNodeTexImage")
        tr.image = rgh
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tr.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    scene.render.engine = "BLENDER_WORKBENCH"
    if PREVIEW:
        nrm.save(filepath=str(Path(PREVIEW) / "Zombie_normal.png"))
        rgh.save(filepath=str(Path(PREVIEW) / "Zombie_rough.png"))
    print("BAKED zombie maps")


# ---- build ----------------------------------------------------------------------------------------------------------

def build_zombie(only_variants=None):
    clear_scene()
    p = zombie_palette()
    arm = build_armature("Zombie")
    torso_bones = ["hips", "spine", "chest", "neck", "upperarm.L", "upperarm.R", "thigh.L", "thigh.R"]
    meshes = []
    for k, base in enumerate(ZOMBIE_VARIANTS):
        if only_variants is not None and k not in only_variants:
            continue
        spec = dict(base, k=k)
        body, body_extras = zombie_body(p, spec)
        head = zombie_head(f"Zombie_Head_{k}", p, spec)
        limbs, extras = zombie_limbs(p, spec)
        body = join([body] + body_extras, f"Zombie_Body_{k}")
        for side in ("L", "R"):
            for part in ("arm", "leg"):
                key = f"{part}{side}"
                name = f"Zombie_{part.capitalize()}{side}_{k}"
                limbs[key] = join([limbs[key]] + extras[key], name) if extras[key] else limbs[key]
                limbs[key].name = name
        skin_to(body, arm, torso_bones, power=4)
        skin_to(head, arm, ["neck", "head"], power=6)
        for side in ("L", "R"):
            skin_to(limbs[f"arm{side}"], arm, ["chest", f"upperarm.{side}", f"forearm.{side}", f"hand.{side}"])
            skin_to(limbs[f"leg{side}"], arm, ["hips", f"thigh.{side}", f"shin.{side}", f"foot.{side}"])
        parts = [body, head, limbs["armL"], limbs["armR"], limbs["legL"], limbs["legR"]]
        for m in parts:
            zombie_colors(m, p, spec, head=(m is head))
        meshes += parts
        print("ZOMBIE variant", k, spec["key"], "tris", sum(tris(m) for m in parts), [(m.name, tris(m)) for m in parts])
    bake_zombie_maps(meshes)
    zombie_anims(arm)
    return arm, meshes


def zombie_anims(arm):
    def base(t=0.0):
        s = math.sin(t * math.tau)
        return {
            "hips": (8, 0, 0), "spine": (14 + 2 * s, 0, 3), "chest": (12, 0, 5), "neck": (12, 0, 0), "head": (-8, 6, 15 + 3 * s),
            "upperarm.L": (80 + 4 * s, 0, -18), "upperarm.R": (68 - 3 * s, 0, 14), "forearm.L": (26, 0, 0), "forearm.R": (38, 0, 0),
            "hand.L": (-14, 0, 0), "hand.R": (-20, 0, 0),
            "thigh.L": (6, 0, -3), "thigh.R": (2, 0, 5), "shin.L": (-10, 0, 0), "shin.R": (-6, 0, 0), "foot.L": (4, 0, 0), "foot.R": (6, 0, 0),
        }

    def cycle(name, seconds, fn, keys=12):
        n = round(seconds * FPS)
        keyframes(arm, name, [(round(i * n / keys) + 1, *fn(i / keys)) for i in range(keys + 1)])

    def walk(ph):
        s = math.sin(ph * math.tau)
        c = math.cos(ph * math.tau)
        b = base(ph)
        b.update({
            "hips": (8, 7 * s, 4 * s), "spine": (15, -5 * s, 3), "chest": (12, -4 * s, 5 + 2 * c),
            "head": (-8 + 3 * math.sin(ph * 2 * math.tau), 10 * s, 16),
            "thigh.L": (26 * s + 2, 0, -3), "thigh.R": (-13 * s - 2, 0, 7),
            "shin.L": (-8 - 42 * max(0, c), 0, 0), "shin.R": (-10 - 16 * max(0, -c), 0, 0),
            "foot.L": (10 * max(0, c) - 6 * s, 0, 0), "foot.R": (-12, 0, 6),
            "upperarm.L": (82 + 8 * s, 0, -18), "upperarm.R": (68 - 9 * s, 0, 14), "forearm.L": (24 + 6 * c, 0, 0), "forearm.R": (36 - 6 * c, 0, 0),
        })
        return b, (-0.03 * s, -0.035 + 0.03 * abs(c), 0)

    def jog(ph):
        s = math.sin(ph * math.tau)
        c = math.cos(ph * math.tau)
        b = base(ph)
        b.update({
            "hips": (14, 10 * s, 5 * s), "spine": (18, -8 * s, 0), "chest": (14, -6 * s, 3), "head": (-14, 8 * s, 10),
            "thigh.L": (38 * s + 8, 0, -3), "thigh.R": (-36 * s + 8, 0, 3),
            "shin.L": (-15 - 60 * max(0, c), 0, 0), "shin.R": (-15 - 60 * max(0, -c), 0, 0),
            "foot.L": (12 * max(0, c), 0, 0), "foot.R": (12 * max(0, -c), 0, 0),
            "upperarm.L": (80 - 25 * s, 0, -12), "upperarm.R": (80 + 25 * s, 0, 12), "forearm.L": (30, 0, 0), "forearm.R": (30, 0, 0),
        })
        return b, (0, -0.06 + 0.06 * abs(c), 0)

    def crawl(ph):
        s = math.sin(ph * math.tau)
        c = math.cos(ph * math.tau)
        return {
            "hips": (82, 0, 5 * s), "spine": (4, 0, -4 * s), "chest": (-6, 6 * s, 0), "neck": (-30, 0, 0), "head": (-30, 8 * s, 6),
            "upperarm.L": (150 + 28 * s, 0, -25), "upperarm.R": (150 - 28 * s, 0, 25), "forearm.L": (20 + 30 * max(0, -c), 0, 0),
            "forearm.R": (20 + 30 * max(0, c), 0, 0), "hand.L": (-30, 0, 0), "hand.R": (-30, 0, 0),
            "thigh.L": (-4 + 6 * s, 0, -6), "thigh.R": (-2 - 6 * s, 0, 8), "shin.L": (-10, 0, 0), "shin.R": (-25, 0, 0), "foot.L": (-40, 0, 0), "foot.R": (-40, 0, 0),
        }, (0, -0.74, 0.03 * s)

    cycle("idle", 2.4, lambda ph: (base(ph), (0, -0.02 + 0.008 * math.sin(ph * math.tau), 0)), keys=6)
    cycle("walk", 1.3, walk)
    cycle("jog", 0.8, jog)
    cycle("crawl", 1.6, crawl)

    b0 = base()
    swing_up = add(b0, {"upperarm.L": (70, 0, 10), "upperarm.R": (75, 0, -10), "forearm.L": (20, 0, 0), "forearm.R": (10, 0, 0), "chest": (-14, 0, 0), "spine": (-6, 0, 0)})
    strike = add(b0, {"upperarm.L": (-20, 0, 12), "upperarm.R": (-16, 0, -14), "forearm.L": (-10, 0, 0), "chest": (16, 0, 0), "spine": (10, 0, 0), "head": (10, 0, 0)})
    keyframes(arm, "attack", [
        (1, b0, (0, -0.02, 0)), (10, swing_up, (0, 0, -0.03)), (17, strike, (0, -0.06, 0.06)), (23, lerp_pose(strike, b0, 0.4), (0, -0.05, 0.04)), (31, b0, (0, -0.02, 0)),
    ])

    reach = add(b0, {"upperarm.L": (24, 0, 8), "upperarm.R": (34, 0, -6), "forearm.L": (-16, 0, 0), "forearm.R": (-26, 0, 0), "chest": (10, 0, 0), "spine": (6, 0, 0), "hand.L": (20, 0, 0), "hand.R": (20, 0, 0)})
    yank = add(b0, {"upperarm.L": (-18, 0, 4), "upperarm.R": (-10, 0, -4), "forearm.L": (50, 0, 0), "forearm.R": (40, 0, 0), "chest": (-16, 0, 0), "spine": (-8, 0, 0), "hand.L": (-30, 0, 0), "hand.R": (-30, 0, 0)})
    keyframes(arm, "tear", [(1, reach, (0, -0.02, 0.05)), (14, lerp_pose(reach, yank, 0.25), (0, -0.03, 0.03)), (24, yank, (0, -0.06, -0.08)), (41, reach, (0, -0.02, 0.05))])

    hands_down = add(b0, {"upperarm.L": (-10, 0, 10), "upperarm.R": (-4, 0, -10), "forearm.L": (-20, 0, 0), "forearm.R": (-30, 0, 0), "spine": (26, 0, 0), "chest": (22, 0, 0)})
    knee_up = add(hands_down, {"thigh.L": (85, 0, -8), "shin.L": (-105, 0, 0), "thigh.R": (-10, 0, 0), "hips": (20, 0, 0)})
    over = add(b0, {"hips": (35, 0, 0), "thigh.L": (40, 0, 0), "shin.L": (-60, 0, 0), "thigh.R": (60, 0, 8), "shin.R": (-95, 0, 0), "upperarm.L": (-30, 0, 15), "upperarm.R": (-30, 0, -15)})
    land = add(b0, {"thigh.L": (45, 0, 0), "thigh.R": (35, 0, 0), "shin.L": (-70, 0, 0), "shin.R": (-60, 0, 0), "foot.L": (25, 0, 0), "foot.R": (25, 0, 0), "spine": (20, 0, 0)})
    keyframes(arm, "vault", [(1, b0, (0, -0.02, 0)), (9, hands_down, (0, -0.1, 0.05)), (18, knee_up, (0, 0.05, 0.1)), (27, over, (0, 0.0, 0.1)), (34, land, (0, -0.22, 0)), (40, b0, (0, -0.02, 0))])

    claw_up = {"upperarm.L": (160, 0, -20), "upperarm.R": (150, 0, 25), "forearm.L": (20, 0, 0), "forearm.R": (35, 0, 0), "head": (-30, 0, 10), "chest": (-10, 0, 0), "hand.L": (-30, 0, 0), "hand.R": (-30, 0, 0)}
    claw_down = {"upperarm.L": (110, 0, -10), "upperarm.R": (125, 0, 10), "forearm.L": (40, 0, 0), "forearm.R": (30, 0, 0), "head": (-10, 0, 15), "chest": (15, 0, 0), "spine": (20, 0, 0)}
    crouch = add(b0, {"spine": (25, 0, 0), "hips": (25, 0, 0), "thigh.L": (65, 0, -5), "thigh.R": (55, 0, 5), "shin.L": (-110, 0, 0), "shin.R": (-95, 0, 0), "foot.L": (35, 0, 0), "foot.R": (30, 0, 0)})
    keyframes(arm, "rise", [(1, claw_up, (0, 0, 0)), (12, claw_down, (0, -0.1, 0)), (22, add(claw_up, {"spine": (20, 0, 0)}), (0, -0.2, 0)), (34, crouch, (0, -0.35, 0)), (49, b0, (0, -0.02, 0))])

    slump = add(b0, {"thigh.L": (40, 0, -5), "thigh.R": (30, 0, 8), "shin.L": (-80, 0, 0), "shin.R": (-70, 0, 0), "spine": (-20, 0, 0), "head": (-30, 10, 0)})
    lie_back = {"hips": (-88, 0, 4), "spine": (-4, 0, 0), "chest": (-4, 0, -4), "neck": (-6, 0, 0), "head": (-20, 30, 15), "upperarm.L": (-6, 0, 52), "upperarm.R": (12, 0, -40), "forearm.L": (20, 0, 0), "forearm.R": (45, 0, 0),
                "thigh.L": (8, 0, -10), "thigh.R": (25, 0, 12), "shin.L": (-10, 0, 0), "shin.R": (-40, 0, 0), "foot.L": (-30, 0, 0), "foot.R": (-30, 0, 0)}
    keyframes(arm, "death_back", [(1, b0, (0, -0.02, 0)), (8, slump, (0, -0.3, -0.05)), (18, lerp_pose(slump, lie_back, 0.6), (0, -0.62, -0.1)), (27, lie_back, (0, -0.8, -0.12)), (31, add(lie_back, {"head": (6, 0, 0), "spine": (4, 0, 0)}), (0, -0.78, -0.12)), (37, lie_back, (0, -0.8, -0.12))])
    lie_fwd = {"hips": (88, 0, -4), "spine": (6, 0, 0), "chest": (2, 0, 4), "neck": (-20, 0, 0), "head": (-20, -40, 10), "upperarm.L": (150, 0, -40), "upperarm.R": (40, 0, 30), "forearm.L": (30, 0, 0), "forearm.R": (80, 0, 0),
               "thigh.L": (-4, 0, -8), "thigh.R": (14, 0, 10), "shin.L": (-15, 0, 0), "shin.R": (-50, 0, 0), "foot.L": (-40, 0, 0), "foot.R": (-30, 0, 0)}
    stumble = add(b0, {"spine": (30, 0, 0), "chest": (20, 0, 0), "thigh.L": (30, 0, 0), "shin.L": (-30, 0, 0), "thigh.R": (-10, 0, 0)})
    keyframes(arm, "death_fwd", [(1, b0, (0, -0.02, 0)), (9, stumble, (0, -0.1, 0.12)), (19, lerp_pose(stumble, lie_fwd, 0.6), (0, -0.55, 0.25)), (28, lie_fwd, (0, -0.84, 0.3)), (32, add(lie_fwd, {"chest": (-6, 0, 0)}), (0, -0.82, 0.3)), (37, lie_fwd, (0, -0.84, 0.3))])


# ---- survivor ---------------------------------------------------------------------------------------------------------

def build_survivor():
    clear_scene()
    p = survivor_palette()
    S = 1.02
    arm = build_armature("Survivor", S)
    mats = [p["team"], p["skin"], p["pants"], p["boots"], p["gear"], p["strap"]]
    sc = lambda pts: [(a * S, b * S, c * S) for a, b, c in pts]  # noqa: E731
    v, e, r = torso_graph(1, bulk=1.17, gaunt=1.15)
    body = skin_mesh("Survivor_Body", sc(v), e, r, subsurf=2, disp=0.004, disp_scale=0.08, mats=mats)
    # Jacket down to the hips, a high collar, trousers below.
    paint_faces(body, lambda c, n: 2 if c.z < 0.97 * S else (1 if c.z > 1.56 * S else 0))
    vg = group_from_mats(body, [p["team"], p["pants"]], "cloth")
    body = displace_group(body, vg.name, 0.01, 0.06, "WOOD", "folds_s")
    collar = prim("torus", p["team"], loc=(0, 0.005, 1.49 * S), major_radius=0.066, minor_radius=0.012, major_segments=20, minor_segments=6)
    hem = prim("torus", p["team"], loc=(0, 0.004, 0.985 * S), scale=(1.0, 0.72, 1.0), major_radius=0.165, minor_radius=0.018, major_segments=24, minor_segments=6)
    belt = prim("torus", p["strap"], loc=(0, 0.004, 0.955 * S), scale=(1.0, 0.72, 1.0), major_radius=0.16, minor_radius=0.016, major_segments=24, minor_segments=6)
    body = join([body, collar, hem, belt], "Survivor_Body")
    limbs = []
    for side, x in (("L", -1), ("R", 1)):
        v, e, r = arm_graph(x, bulk=1.0, claw=False)
        r = [(rr * 1.45 if i < 4 else rr) if not isinstance(rr, tuple) else rr for i, rr in enumerate(r)]
        a = skin_mesh(f"Survivor_Arm{side}", sc(v), e, r, subsurf=2, mats=mats)
        paint_faces(a, lambda c, n: 0 if c.z > 0.965 * S else 5)  # sleeve to the wrist, gloves
        vg = group_from_mats(a, [p["team"]], "cloth")
        a = displace_group(a, vg.name, 0.007, 0.045, "WOOD", "folds_s2")
        cuff = prim("torus", p["team"], loc=(x * 0.425 * S, 0.026 * S, 0.975 * S), rot=(0, math.radians(x * -24), 0), major_radius=0.036, minor_radius=0.012, major_segments=16, minor_segments=6)
        patch = box((0.012, 0.07, 0.06), (x * 0.235 * S, 0.0, 1.31 * S), p["gear"], rot=(0, math.radians(x * -33), 0), bevel=0.006)
        a = join([decimate(a, 0.55), cuff, patch], f"Survivor_Arm{side}")
        v, e, r = leg_graph(x, bulk=1.18, boot=1.35)
        r = [rr * 1.08 if (not isinstance(rr, tuple) and i < 3) else rr for i, rr in enumerate(r)]
        l = skin_mesh(f"Survivor_Leg{side}", sc(v), e, r, subsurf=2, mats=mats)
        paint_faces(l, lambda c, n: 3 if c.z < 0.25 * S else 2)
        vg = group_from_mats(l, [p["pants"]], "cloth")
        l = displace_group(l, vg.name, 0.013, 0.05, "WOOD", "folds_s3")
        extras = [
            box((0.03, 0.12, 0.13), (x * 0.19 * S, 0.0, 0.66 * S), p["pants"], bevel=0.015),  # cargo pocket
            box((0.024, 0.11, 0.02), (x * 0.195 * S, 0.0, 0.73 * S), p["pants"], bevel=0.008),  # pocket flap
            box((0.11, 0.05, 0.12), (x * 0.112 * S, 0.075 * S, 0.5 * S), p["gear"], rot=(math.radians(-6), 0, 0), bevel=0.02),  # knee pad
            prim("torus", p["boots"], loc=(x * 0.115 * S, -0.008 * S, 0.24 * S), major_radius=0.05, minor_radius=0.012, major_segments=16, minor_segments=6),  # boot collar
            box((0.1, 0.27, 0.035), (x * 0.122 * S, 0.06 * S, 0.016), p["strap"], bevel=0.012),  # sole
        ]
        if x > 0:
            extras.append(box((0.045, 0.1, 0.17), (x * 0.18 * S, 0.02, 0.8 * S), p["strap"], rot=(math.radians(8), 0, 0), bevel=0.01))  # holster
        l = join([l] + extras, f"Survivor_Leg{side}")
        limbs.append((side, a, l))
    head = head_mesh("Survivor_Head", {"skin": p["skin"], "blood": p["skin"], "eyes": p["eyes"]}, zombie=False)
    activate(head)
    head.scale = (S, S, S)
    bpy.ops.object.transform_apply(scale=True)
    # Plate carrier with mag pouches, shoulder straps, cummerbund; a pack on the back.
    vest_parts = [
        box((0.3, 0.06, 0.33), (0, 0.15, 1.28 * S), p["gear"], bevel=0.025),
        box((0.3, 0.06, 0.33), (0, -0.135, 1.29 * S), p["gear"], bevel=0.025),
        box((0.06, 0.11, 0.17), (-0.175, 0.0, 1.2 * S), p["gear"], bevel=0.02),
        box((0.06, 0.11, 0.17), (0.175, 0.0, 1.2 * S), p["gear"], bevel=0.02),
    ]
    for sx in (-1, 1):
        sh = box((0.065, 0.3, 0.025), (sx * 0.1, 0.005, 1.46 * S), p["gear"], rot=(0, math.radians(sx * 8), 0), bevel=0.01)
        vest_parts.append(sh)
    for k, px in enumerate((-0.085, 0.0, 0.085)):
        vest_parts.append(box((0.075, 0.05, 0.12), (px, 0.2, 1.2 * S), p["gear"], bevel=0.014))
        vest_parts.append(box((0.078, 0.052, 0.028), (px, 0.202, 1.27 * S), p["gear"], bevel=0.01))
        vest_parts.append(box((0.03, 0.006, 0.03), (px, 0.228, 1.255 * S), p["strap"], bevel=0.003))
    vest_parts.append(box((0.12, 0.04, 0.08), (0.05, 0.195, 1.37 * S), p["gear"], bevel=0.012))  # admin pouch
    vest_parts.append(box((0.04, 0.05, 0.14), (-0.2, 0.06, 1.22 * S), p["gear"], bevel=0.012))  # radio
    vest_parts.append(cyl(0.004, 0.18, (-0.21, 0.06, 1.35 * S), p["strap"], verts=6))  # antenna
    for row in range(4):
        vest_parts.append(box((0.29, 0.004, 0.006), (0, 0.181, (1.14 + row * 0.03) * S), p["strap"], bevel=0))  # MOLLE webbing
        vest_parts.append(box((0.29, 0.004, 0.006), (0, -0.166, (1.2 + row * 0.03) * S), p["strap"], bevel=0))
    pack = [
        box((0.3, 0.17, 0.42), (0, -0.26, 1.24 * S), p["gear"], bevel=0.05),
        box((0.31, 0.12, 0.08), (0, -0.25, 1.47 * S), p["gear"], bevel=0.035),
        box((0.08, 0.08, 0.2), (-0.17, -0.26, 1.16 * S), p["gear"], bevel=0.02),
        box((0.08, 0.08, 0.2), (0.17, -0.26, 1.16 * S), p["gear"], bevel=0.02),
        box((0.22, 0.015, 0.025), (0, -0.35, 1.3 * S), p["strap"], bevel=0.004),
        box((0.22, 0.015, 0.025), (0, -0.35, 1.12 * S), p["strap"], bevel=0.004),
        cyl(0.045, 0.32, (0, -0.24, 1.03 * S), p["team"], rot=(0, math.radians(90), 0), verts=14),  # bedroll
    ]
    vest = join(vest_parts + pack, "Survivor_Vest")
    # Helmet: shell, brim, side rails, a night-vision mount, straps.
    shell = prim("sphere", p["gear"], loc=(0, 0.018, 1.71 * S), scale=(1.0, 1.1, 0.86), radius=0.128, segments=28, ring_count=16)
    shell = apply_all(shell)
    activate(shell)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    cut = 1.665 * S
    for vv in shell.data.vertices:
        if vv.co.z < cut:
            vv.co.z = cut + (vv.co.z - cut) * 0.12
            # Lower at the back and the ears than over the brow.
            if vv.co.y < 0.0:
                vv.co.z -= 0.035 * min(1.0, -vv.co.y / 0.1)
    helmet_parts = [shell]
    for sx in (-1, 1):
        helmet_parts.append(box((0.012, 0.11, 0.022), (sx * 0.127, 0.01, 1.69 * S), p["strap"], bevel=0.004))
        helmet_parts.append(cyl(0.004, 0.11, (sx * 0.09, 0.04, 1.62 * S), p["strap"], rot=(math.radians(15), 0, 0), verts=6))
    helmet_parts.append(box((0.05, 0.02, 0.04), (0, 0.145, 1.75 * S), p["strap"], bevel=0.006))
    helmet_parts.append(box((0.06, 0.08, 0.025), (0, -0.07, 1.82 * S), p["gear"], bevel=0.01))
    helmet = join(helmet_parts, "Survivor_Helmet")
    skin_to(body, arm, ["hips", "spine", "chest", "neck", "upperarm.L", "upperarm.R", "thigh.L", "thigh.R"], scale=S)
    skin_to(vest, arm, ["spine", "chest"], scale=S, power=2)
    skin_to(head, arm, ["neck", "head"], scale=S, power=6)
    skin_to(helmet, arm, ["head"], scale=S, rigid="head")
    for side, a, l in limbs:
        skin_to(a, arm, ["chest", f"upperarm.{side}", f"forearm.{side}", f"hand.{side}"], scale=S)
        skin_to(l, arm, ["hips", f"thigh.{side}", f"shin.{side}", f"foot.{side}"], scale=S)
    meshes = [body, vest, head, helmet] + [m for _, a, l in limbs for m in (a, l)]
    for m in meshes:
        grime(m, dirt=0.4, low=0.6, blood=0.12, stain=(0.18, 0.1, 0.05))
    bake_normals("Survivor", meshes, SURVIVOR_DETAIL)
    print("SURVIVOR tris", sum(tris(m) for m in meshes), [(m.name, tris(m)) for m in meshes])
    survivor_anims(arm)
    return arm, meshes


# ---- normal maps --------------------------------------------------------------------------------------------------

# Procedural bump per material: (strength, distance, [(kind, scale, detail/extra, weight)]). ZOMBIE_DETAIL is in the
# zombie section.
SURVIVOR_DETAIL = {
    "Team": (0.35, 0.006, [("noise", 5, 2, 1.0), ("noise", 18, 2, 0.3), ("wave", 300, 0, 0.08)]),
    "SurvivorSkin": (0.12, 0.002, [("noise", 160, 6, 0.6), ("noise", 25, 2, 0.4)]),
    "Pants": (0.35, 0.005, [("wave", 240, 0, 0.1), ("waveb", 240, 0, 0.1), ("noise", 6, 2, 1.0)]),
    "Boots": (0.5, 0.003, [("noise", 70, 6, 1.0), ("noise", 12, 2, 0.4)]),
    "Gear": (0.35, 0.003, [("wave", 160, 0, 0.25), ("waveb", 160, 0, 0.25), ("noise", 10, 2, 0.6)]),
    "Strap": (0.6, 0.002, [("wave", 320, 0, 1.0)]),
}

BAKE_SIZE = 1024


def bake_normals(prefix, meshes, detail):
    """UV-packs every part into one atlas and bakes the procedural bump of each material into a shared normal map,
    then rewires the materials to Principled + Normal Map(image) so the glTF exporter embeds it."""
    # One atlas for all parts.
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
        if not m.data.uv_layers:
            m.data.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.004, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    img = bpy.data.images.new(f"{prefix}Normal", BAKE_SIZE, BAKE_SIZE, alpha=False, float_buffer=False, is_data=True)
    img.generated_color = (0.5, 0.5, 1.0, 1.0)
    img.colorspace_settings.name = "Non-Color"
    used = set()
    for m in meshes:
        for mat in m.data.materials:
            used.add(mat)
    temp = {}
    for mat in used:
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        tc = nt.nodes.new("ShaderNodeTexCoord")
        bmp = nt.nodes.new("ShaderNodeBump")
        strength, dist, layers = detail.get(mat.name, (0.3, 0.002, [("noise", 80, 4, 1.0)]))
        bmp.inputs["Strength"].default_value = strength
        bmp.inputs["Distance"].default_value = dist
        total = None
        nodes = [tc, bmp]
        for kind, scale, extra, weight in layers:
            if kind == "noise":
                t = nt.nodes.new("ShaderNodeTexNoise")
                t.inputs["Scale"].default_value = scale
                t.inputs["Detail"].default_value = extra
                out = t.outputs["Fac"]
            elif kind == "voronoi":
                t = nt.nodes.new("ShaderNodeTexVoronoi")
                t.feature = "DISTANCE_TO_EDGE"
                t.inputs["Scale"].default_value = scale
                out = t.outputs["Distance"]
            else:
                t = nt.nodes.new("ShaderNodeTexWave")
                t.wave_type = "BANDS"
                t.bands_direction = "X" if kind == "wave" else "Z"
                t.inputs["Scale"].default_value = scale
                t.inputs["Distortion"].default_value = 2.0
                out = t.outputs["Fac"]
            nt.links.new(tc.outputs["Object"], t.inputs["Vector"])
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            mul.inputs[1].default_value = weight
            nt.links.new(out, mul.inputs[0])
            nodes += [t, mul]
            if total is None:
                total = mul.outputs[0]
            else:
                addn = nt.nodes.new("ShaderNodeMath")
                addn.operation = "ADD"
                nt.links.new(total, addn.inputs[0])
                nt.links.new(mul.outputs[0], addn.inputs[1])
                total = addn.outputs[0]
                nodes.append(addn)
        nt.links.new(total, bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], bsdf.inputs["Normal"])
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.nodes.active = tex
        temp[mat] = (nodes, tex)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 2
    scene.render.bake.margin = 6
    scene.render.bake.use_clear = True
    scene.render.bake.normal_space = "TANGENT"
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=6, use_clear=True)
    img.pack()
    # Rewire: drop the procedural bump, feed the baked map through a Normal Map node.
    for mat, (nodes, tex) in temp.items():
        nt = mat.node_tree
        for n in nodes:
            nt.nodes.remove(n)
        bsdf = nt.nodes.get("Principled BSDF")
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.space = "TANGENT"
        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    scene.render.engine = "BLENDER_WORKBENCH"
    if PREVIEW:
        img.save(filepath=str(Path(PREVIEW) / f"{prefix}_normal.png"))
    print("BAKED", prefix)


# ---- survivor hold poses (IK) -----------------------------------------------------------------------------------------

# Where the rifle grip is held in the idle pose, character space (Blender: x right, y forward, z up). models.ts hangs
# bones.grip here (glTF: x, z, -y).
GRIP = Vector((0.15, 0.36, 1.2))
TORSO_AIM = {"spine": (4, -10, 0), "chest": (2, -14, 0), "neck": (-2, 12, 0), "head": (-2, 10, 0), "hips": (0, 0, 0)}


def solve_hold(arm, base, right_wrist, right_aim, left_wrist, left_aim):
    """Poses `base`, solves both arms with IK so the wrists reach the targets and the hands point at the aim points,
    and returns the arm rotations as local eulers (degrees)."""
    for pb in arm.pose.bones:
        pb.rotation_euler = tuple(math.radians(a) for a in base.get(pb.name, (0, 0, 0)))
        pb.location = (0, 0, 0)
    made = []

    def empty(pos):
        e = link(bpy.data.objects.new("ikt", None))
        e.location = pos
        made.append(e)
        return e

    for side, wrist, aim, pole in (("R", right_wrist, right_aim, Vector((0.55, -0.1, 0.8))), ("L", left_wrist, left_aim, Vector((-0.6, 0.2, 0.8)))):
        c = arm.pose.bones[f"forearm.{side}"].constraints.new("IK")
        c.target = empty(wrist)
        c.pole_target = empty(pole)
        c.pole_angle = math.radians(-90)
        c.chain_count = 2
        d = arm.pose.bones[f"hand.{side}"].constraints.new("DAMPED_TRACK")
        d.target = empty(aim)
        d.track_axis = "TRACK_Y"
    bpy.context.view_layer.update()
    out = {}
    for side in ("R", "L"):
        for b in ("upperarm", "forearm", "hand"):
            pb = arm.pose.bones[f"{b}.{side}"]
            m = arm.convert_space(pose_bone=pb, matrix=pb.matrix, from_space="POSE", to_space="LOCAL")
            out[pb.name] = tuple(math.degrees(a) for a in m.to_euler("XYZ"))
        tail = arm.matrix_world @ arm.pose.bones[f"forearm.{side}"].tail
        want = right_wrist if side == "R" else left_wrist
        print(f"HOLD {side} wrist error {(tail - want).length:.3f} m")
    for side in ("R", "L"):
        for b in ("forearm", "hand"):
            pb = arm.pose.bones[f"{b}.{side}"]
            for c in list(pb.constraints):
                pb.constraints.remove(c)
    for e in made:
        bpy.data.objects.remove(e, do_unlink=True)
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    return out


def survivor_anims(arm):
    g = GRIP
    hold = solve_hold(
        arm,
        TORSO_AIM,
        right_wrist=g + Vector((0.025, -0.065, 0.045)),
        right_aim=g + Vector((-0.03, 0.02, -0.08)),
        left_wrist=g + Vector((-0.07, 0.2, 0.0)),
        left_aim=g + Vector((-0.01, 0.27, 0.06)),
    )
    aim = dict(TORSO_AIM)
    aim.update(hold)
    mag = solve_hold(
        arm,
        TORSO_AIM,
        right_wrist=g + Vector((0.025, -0.065, 0.045)),
        right_aim=g + Vector((-0.03, 0.02, -0.08)),
        left_wrist=g + Vector((-0.05, 0.05, -0.16)),
        left_aim=g + Vector((0.0, 0.1, -0.08)),
    )
    reload_pose = dict(TORSO_AIM)
    reload_pose.update(mag)

    def cycle(name, seconds, fn, keys=12):
        n = round(seconds * FPS)
        keyframes(arm, name, [(round(i * n / keys) + 1, *fn(i / keys)) for i in range(keys + 1)])

    def idle(ph):
        s = math.sin(ph * math.tau)
        return add(aim, {"chest": (1.2 * s, 0, 0), "thigh.L": (4, 0, -5), "thigh.R": (-3, 0, 5), "shin.L": (-6, 0, 0), "shin.R": (-3, 0, 0), "foot.L": (2, 0, 0)}), (0, -0.012 + 0.005 * s, 0)

    def walk(ph):
        s = math.sin(ph * math.tau)
        c = math.cos(ph * math.tau)
        return add(aim, {
            "hips": (4, 5 * s, 2 * s), "spine": (0, -3 * s, 0), "chest": (0, -2 * s, 0),
            "thigh.L": (28 * s, 0, -2), "thigh.R": (-28 * s, 0, 2),
            "shin.L": (-8 - 45 * max(0, c), 0, 0), "shin.R": (-8 - 45 * max(0, -c), 0, 0),
            "foot.L": (12 * max(0, c) - 4 * s, 0, 0), "foot.R": (12 * max(0, -c) + 4 * s, 0, 0),
        }), (0, -0.03 + 0.028 * abs(c), 0)

    def run(ph):
        s = math.sin(ph * math.tau)
        c = math.cos(ph * math.tau)
        return add(aim, {
            "hips": (12, 7 * s, 3 * s), "spine": (8, -4 * s, 0), "chest": (4, -3 * s, 0), "neck": (-8, 0, 0), "head": (-6, 0, 0),
            "thigh.L": (46 * s + 12, 0, -2), "thigh.R": (-46 * s + 12, 0, 2),
            "shin.L": (-20 - 75 * max(0, c), 0, 0), "shin.R": (-20 - 75 * max(0, -c), 0, 0),
            "foot.L": (15 * max(0, c), 0, 0), "foot.R": (15 * max(0, -c), 0, 0),
        }), (0, -0.07 + 0.07 * abs(c), 0)

    cycle("idle", 2.6, idle, keys=6)
    cycle("walk", 1.0, walk)
    cycle("run", 0.66, run)
    downed = {
        "hips": (-80, 0, 0), "spine": (25, 0, 0), "chest": (20, 0, 0), "neck": (20, 0, 0), "head": (10, 0, 0),
        "upperarm.R": (95, 0, 15), "forearm.R": (35, 0, 0), "hand.R": (-10, 0, 0), "upperarm.L": (-20, 0, 50), "forearm.L": (40, 0, 0),
        "thigh.L": (15, 0, -10), "thigh.R": (40, 0, 8), "shin.L": (-20, 0, 0), "shin.R": (-60, 0, 0),
    }
    keyframes(arm, "downed", [(1, downed, (0, -0.84, -0.05)), (30, add(downed, {"chest": (4, 0, 0), "head": (6, 0, 0)}), (0, -0.83, -0.05)), (61, downed, (0, -0.84, -0.05))])
    tilt = add(aim, {"hand.R": (0, 0, 12)})
    keyframes(arm, "reload", [(1, aim, None), (9, lerp_pose(aim, reload_pose, 0.6), None), (16, add(reload_pose, {"head": (12, 0, 0)}), None), (28, reload_pose, None), (37, tilt, None), (46, aim, None)])


# ---- previews -------------------------------------------------------------------------------------------------------

PREVIEW = None


def preview(name, target=(0, 0, 1.0), dist=3.0, frames=((0, None),), angles=(30,), elev=12, action=None, arm=None, lens=50):
    """Renders Workbench PNGs of the current scene into PREVIEW (if set)."""
    if not PREVIEW:
        return
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.film_transparent = False
    cam_data = bpy.data.cameras.new("PrevCam")
    cam_data.lens = lens
    cam = link(bpy.data.objects.new("PrevCam", cam_data))
    scene.camera = cam
    t = Vector(target)
    if arm:
        arm.animation_data_create()
        for tr in arm.animation_data.nla_tracks:
            tr.mute = True
        for pb in arm.pose.bones:
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)
    if arm and action:
        act = bpy.data.actions[action]
        for tr in arm.animation_data.nla_tracks:
            tr.mute = True
        arm.animation_data.action = act
        try:
            if act.slots:
                arm.animation_data.action_slot = act.slots[0]
        except AttributeError:
            pass
    for frame, _ in frames:
        scene.frame_set(frame or 1)
        for ang in angles:
            a = math.radians(ang)
            e = math.radians(elev)
            cam.location = t + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
            d = t - cam.location
            cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(Path(PREVIEW) / f"{name}_{action or 'rest'}_{frame or 0}_{ang}.png")
            bpy.ops.render.render(write_still=True)
    if arm:
        arm.animation_data.action = None
        for tr in arm.animation_data.nla_tracks:
            tr.mute = False
    bpy.data.objects.remove(cam, do_unlink=True)


def dramatic(name, objects_for_gun=None, target=(0, 0, 1.0), dist=2.4, angles=(25,), elev=8, arm=None, action=None, frame=1, lens=55, res=560, samples=24, energy=260):
    """Cycles render under one hard spot from above on a near-black background, vertex colours shown."""
    if not PREVIEW:
        return
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("Dark") if not bpy.data.worlds.get("Dark") else bpy.data.worlds["Dark"]
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.005, 0.007, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world
    made = []
    spot_data = bpy.data.lights.new("Spot", "SPOT")
    spot_data.energy = energy
    spot_data.spot_size = math.radians(55)
    spot_data.spot_blend = 0.4
    spot_data.color = (1.0, 0.82, 0.6)
    spot_data.shadow_soft_size = 0.05
    spot = link(bpy.data.objects.new("Spot", spot_data))
    spot.location = Vector(target) + Vector((0.4, 0.9, 2.2))
    spot.rotation_euler = (Vector(target) - spot.location).to_track_quat("-Z", "Y").to_euler()
    rim_data = bpy.data.lights.new("Rim", "SPOT")
    rim_data.energy = 60
    rim_data.color = (0.5, 0.62, 1.0)
    rim_data.spot_size = math.radians(40)
    rim = link(bpy.data.objects.new("Rim", rim_data))
    rim.location = Vector(target) + Vector((-1.2, -1.6, 0.8))
    rim.rotation_euler = (Vector(target) - rim.location).to_track_quat("-Z", "Y").to_euler()
    made += [spot, rim]
    bpy.ops.mesh.primitive_plane_add(size=12, location=(target[0], target[1], 0))
    floor = bpy.context.active_object
    floor.data.materials.append(material("PrevFloor", (0.05, 0.05, 0.05), rough=0.8))
    made.append(floor)
    # Show vertex colours: multiply them into Base Color for the render only.
    patched = []
    for mat in bpy.data.materials:
        if not mat.use_nodes or mat.name == "PrevFloor":
            continue
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        if not bsdf or bsdf.inputs["Base Color"].is_linked:
            continue
        ca = nt.nodes.new("ShaderNodeVertexColor")
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[6].default_value = bsdf.inputs["Base Color"].default_value
        nt.links.new(ca.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        patched.append((mat, ca, mix))
    cam_data = bpy.data.cameras.new("PrevCam")
    cam_data.lens = lens
    cam = link(bpy.data.objects.new("PrevCam", cam_data))
    made.append(cam)
    scene.camera = cam
    if arm:
        arm.animation_data_create()
        for tr in arm.animation_data.nla_tracks:
            tr.mute = True
        arm.animation_data.action = None
        for pb in arm.pose.bones:
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)
        if action:
            act = bpy.data.actions[action]
            arm.animation_data.action = act
            try:
                if act.slots:
                    arm.animation_data.action_slot = act.slots[0]
            except AttributeError:
                pass
    scene.frame_set(frame)
    t = Vector(target)
    for ang in angles:
        a = math.radians(ang)
        e = math.radians(elev)
        cam.location = t + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
        cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(Path(PREVIEW) / f"{name}_{action or 'rest'}_{frame}_{ang}.png")
        bpy.ops.render.render(write_still=True)
    if arm:
        arm.animation_data.action = None
        for tr in arm.animation_data.nla_tracks:
            tr.mute = False
    for mat, ca, mix in patched:
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        col = mix.inputs[6].default_value[:]
        nt.nodes.remove(mix)
        nt.nodes.remove(ca)
        bsdf.inputs["Base Color"].default_value = col
    for o in made:
        bpy.data.objects.remove(o, do_unlink=True)
    scene.render.engine = "BLENDER_WORKBENCH"


# ---- weapons --------------------------------------------------------------------------------------------------------

def gun_palette():
    return {
        "steel": material("GunSteel", (0.05, 0.052, 0.056), rough=0.38, metal=0.9),
        "blued": material("GunBlued", (0.03, 0.036, 0.048), rough=0.28, metal=0.85),
        "poly": material("Polymer", (0.035, 0.035, 0.036), rough=0.62),
        "wood": material("Wood", (0.3, 0.13, 0.055), rough=0.42, spec=0.45),
        "wooddark": material("WoodDark", (0.16, 0.07, 0.032), rough=0.48),
        "brass": material("Brass", (0.62, 0.43, 0.16), rough=0.3, metal=1.0),
        "lens": material("Lens", (0.02, 0.03, 0.05), rough=0.04, metal=0.6, emission=(0.05, 0.12, 0.2), strength=0.4),
        "rubber": material("Rubber", (0.02, 0.02, 0.02), rough=0.92),
        "olive": material("Olive", (0.16, 0.17, 0.1), rough=0.65),
        "shell": material("ShellRed", (0.42, 0.05, 0.04), rough=0.5),
    }


class Gun:
    def __init__(self, gid):
        self.id = gid
        self.parts = []
        self.mag = []
        self.muzzle = (0, 0.2, 0.06)

    def b(self, size, loc, mat, rx=0, bevel=0.0025, mag=False):
        o = box(size, loc, mat, rot=(math.radians(rx), 0, 0), bevel=bevel)
        (self.mag if mag else self.parts).append(o)
        return o

    def c(self, r, length, y0, z, mat, x=0.0, verts=14, r2=None, mag=False):
        o = along_y(r, length, y0, z, mat, x=x, verts=verts, r2=r2)
        (self.mag if mag else self.parts).append(o)
        return o

    def ring(self, r, minor, y, z, mat):
        o = prim("torus", mat, loc=(0, y, z), rot=(0, math.radians(90), 0), major_radius=r, minor_radius=minor, major_segments=16, minor_segments=6)
        self.parts.append(o)
        return o

    def grip(self, mat, y=-0.012, rx=-18, w=0.031, d=0.048, h=0.11):
        return self.b((w, d, h), (0, y, -0.02), mat, rx=rx, bevel=0.006)

    def guard(self, mat, y=0.032):
        self.ring(0.019, 0.003, y, 0.018, mat)
        self.b((0.004, 0.006, 0.018), (0, y - 0.004, 0.022), mat)

    def done(self):
        root = join(self.parts, self.id)
        set_origin(root, (0, 0, 0))
        if self.mag:
            mag = join(self.mag, f"{self.id}_mag")
            c = sum((v.co for v in mag.data.vertices), Vector()) / len(mag.data.vertices)
            set_origin(mag, (c.x, c.y, max(v.co.z for v in mag.data.vertices)))
            mag.parent = root
            mag.matrix_parent_inverse = root.matrix_world.inverted()
        e = link(bpy.data.objects.new(f"{self.id}_muzzle", None))
        e.empty_display_size = 0.02
        e.location = self.muzzle
        e.parent = root
        print("GUN", self.id, "tris", tris(root))
        return root


def gun_m1911(m):
    g = Gun("m1911")
    g.b((0.029, 0.215, 0.032), (0, 0.067, 0.068), m["blued"])
    g.b((0.026, 0.15, 0.022), (0, 0.04, 0.042), m["blued"])
    g.grip(m["blued"], rx=-14)
    g.b((0.035, 0.036, 0.082), (0, -0.01, -0.016), m["wooddark"], rx=-14, bevel=0.005)
    g.guard(m["blued"])
    g.b((0.008, 0.012, 0.014), (0, -0.044, 0.082), m["blued"])
    g.b((0.005, 0.008, 0.006), (0, 0.168, 0.087), m["blued"])
    g.b((0.016, 0.006, 0.007), (0, -0.028, 0.087), m["blued"])
    g.c(0.0085, 0.012, 0.172, 0.068, m["steel"])
    for k in range(7):
        g.b((0.03, 0.002, 0.024), (0, -0.03 + k * 0.006, 0.069), m["steel"], bevel=0)
    g.b((0.022, 0.03, 0.115), (0, -0.016, -0.03), m["blued"], rx=-14, mag=True)
    g.muzzle = (0, 0.18, 0.068)
    return g.done()


def gun_glock(m):
    g = Gun("glock")
    g.b((0.0255, 0.186, 0.03), (0, 0.062, 0.069), m["steel"], bevel=0.003)
    g.b((0.028, 0.15, 0.022), (0, 0.048, 0.043), m["poly"], bevel=0.004)
    g.b((0.02, 0.05, 0.008), (0, 0.11, 0.029), m["poly"])
    g.grip(m["poly"], rx=-22, w=0.032, d=0.052)
    g.guard(m["poly"])
    g.b((0.005, 0.007, 0.006), (0, 0.15, 0.087), m["steel"])
    g.b((0.016, 0.006, 0.007), (0, -0.025, 0.087), m["steel"])
    for k in range(5):
        g.b((0.027, 0.002, 0.02), (0, -0.02 + k * 0.005, 0.07), m["poly"], bevel=0)
    g.b((0.022, 0.032, 0.122), (0, -0.018, -0.035), m["poly"], rx=-22, mag=True)
    g.muzzle = (0, 0.157, 0.069)
    return g.done()


def gun_thompson(m):
    g = Gun("thompson")
    g.b((0.05, 0.26, 0.062), (0, 0.05, 0.062), m["blued"], bevel=0.006)
    g.c(0.012, 0.29, 0.18, 0.062, m["blued"])
    for k in range(10):
        g.c(0.018, 0.005, 0.19 + k * 0.012, 0.062, m["blued"], verts=12)
    g.c(0.016, 0.06, 0.43, 0.062, m["blued"])
    g.b((0.04, 0.3, 0.06), (0, -0.25, 0.036), m["wood"], rx=5, bevel=0.008)
    g.b((0.042, 0.03, 0.125), (0, -0.4, 0.012), m["wood"], rx=5, bevel=0.008)
    g.b((0.04, 0.02, 0.13), (0, -0.418, 0.012), m["blued"], rx=5)
    g.grip(m["wood"], rx=-14, w=0.034, d=0.05)
    g.b((0.034, 0.05, 0.105), (0, 0.24, 0.0), m["wood"], rx=8, bevel=0.008)
    g.guard(m["blued"])
    g.b((0.01, 0.02, 0.012), (0, 0.04, 0.098), m["steel"])
    g.b((0.014, 0.012, 0.022), (0, -0.05, 0.102), m["blued"])
    g.b((0.004, 0.006, 0.014), (0, 0.47, 0.082), m["blued"])
    g.b((0.024, 0.034, 0.2), (0, 0.11, -0.05), m["blued"], mag=True)
    g.muzzle = (0, 0.49, 0.062)
    return g.done()


def gun_trench(m):
    g = Gun("trench")
    g.b((0.044, 0.2, 0.06), (0, 0.05, 0.065), m["blued"], bevel=0.006)
    g.c(0.0115, 0.52, 0.15, 0.08, m["blued"])
    g.c(0.019, 0.3, 0.2, 0.08, m["steel"], verts=10)
    g.c(0.01, 0.4, 0.15, 0.052, m["blued"])
    g.c(0.021, 0.15, 0.2, 0.052, m["wooddark"], verts=12)
    for k in range(6):
        g.c(0.0225, 0.004, 0.21 + k * 0.022, 0.052, m["wooddark"], verts=12)
    g.b((0.032, 0.09, 0.05), (0, -0.04, 0.03), m["wood"], rx=-24, bevel=0.008)
    g.b((0.038, 0.3, 0.06), (0, -0.23, 0.02), m["wood"], rx=7, bevel=0.01)
    g.b((0.04, 0.025, 0.125), (0, -0.385, -0.008), m["rubber"], rx=7)
    g.b((0.007, 0.018, 0.016), (0, -0.04, 0.097), m["steel"])
    g.guard(m["blued"], y=0.03)
    g.b((0.004, 0.006, 0.008), (0, 0.66, 0.095), m["brass"])
    g.c(0.0095, 0.065, 0.02, 0.036, m["shell"], mag=True)
    g.c(0.0098, 0.012, 0.008, 0.036, m["brass"], mag=True)
    g.muzzle = (0, 0.67, 0.08)
    return g.done()


def gun_kar98k(m):
    g = Gun("kar98k")
    g.b((0.042, 0.76, 0.05), (0, 0.17, 0.045), m["wood"], bevel=0.01)
    g.b((0.04, 0.27, 0.11), (0, -0.33, 0.0), m["wood"], rx=4, bevel=0.012)
    g.b((0.041, 0.02, 0.12), (0, -0.47, -0.002), m["steel"], rx=4)
    g.b((0.032, 0.09, 0.055), (0, -0.05, 0.02), m["wood"], rx=-20, bevel=0.01)
    g.c(0.009, 0.66, 0.11, 0.077, m["blued"])
    g.c(0.016, 0.22, -0.08, 0.075, m["blued"])
    g.b((0.032, 0.32, 0.016), (0, 0.38, 0.087), m["wood"], bevel=0.006)
    for y in (0.3, 0.53):
        g.b((0.046, 0.02, 0.066), (0, y, 0.058), m["blued"], bevel=0.003)
    rod = cyl(0.0045, 0.06, (0.03, -0.04, 0.074), m["steel"], rot=(0, math.radians(90), 0), verts=8)
    g.parts.append(rod)
    g.parts.append(prim("sphere", m["steel"], loc=(0.062, -0.04, 0.062), radius=0.009, segments=10, ring_count=6))
    g.b((0.005, 0.007, 0.016), (0, 0.75, 0.094), m["blued"])
    g.b((0.02, 0.04, 0.012), (0, 0.02, 0.1), m["blued"])
    g.guard(m["blued"], y=0.0)
    g.b((0.03, 0.08, 0.012), (0, 0.04, 0.014), m["blued"], mag=True)
    g.muzzle = (0, 0.77, 0.077)
    return g.done()


def gun_garand(m):
    g = Gun("garand")
    g.b((0.044, 0.7, 0.052), (0, 0.15, 0.045), m["wood"], bevel=0.01)
    g.b((0.042, 0.27, 0.115), (0, -0.34, 0.0), m["wood"], rx=4, bevel=0.012)
    g.b((0.043, 0.02, 0.125), (0, -0.48, -0.002), m["steel"], rx=4)
    g.b((0.034, 0.09, 0.056), (0, -0.05, 0.02), m["wood"], rx=-20, bevel=0.01)
    g.b((0.04, 0.22, 0.05), (0, 0.0, 0.075), m["blued"], bevel=0.005)
    g.c(0.009, 0.62, 0.11, 0.08, m["blued"])
    g.b((0.034, 0.36, 0.03), (0, 0.33, 0.092), m["wood"], bevel=0.008)
    g.c(0.013, 0.07, 0.65, 0.068, m["blued"])
    g.b((0.03, 0.02, 0.032), (0, -0.09, 0.108), m["blued"])
    g.b((0.01, 0.2, 0.01), (0.026, 0.12, 0.072), m["blued"])
    g.b((0.005, 0.007, 0.018), (0, 0.72, 0.1), m["blued"])
    g.guard(m["blued"], y=0.0)
    g.b((0.026, 0.05, 0.03), (0, 0.0, 0.105), m["brass"], mag=True)
    g.muzzle = (0, 0.74, 0.08)
    return g.done()


def gun_mp7(m):
    g = Gun("mp7")
    g.b((0.048, 0.26, 0.07), (0, 0.04, 0.058), m["poly"], bevel=0.008)
    g.b((0.024, 0.24, 0.012), (0, 0.04, 0.099), m["steel"])
    for k in range(10):
        g.b((0.026, 0.008, 0.006), (0, -0.06 + k * 0.022, 0.107), m["steel"], bevel=0)
    g.c(0.007, 0.07, 0.17, 0.062, m["steel"])
    g.c(0.011, 0.045, 0.235, 0.062, m["steel"])
    g.grip(m["poly"], rx=-10, w=0.032, d=0.045)
    g.guard(m["poly"])
    g.b((0.02, 0.03, 0.07), (0, 0.135, 0.005), m["poly"], rx=30, bevel=0.005)
    for x in (-0.018, 0.018):
        g.c(0.004, 0.12, -0.13, 0.06, m["steel"], x=x, verts=8)
    g.b((0.045, 0.012, 0.065), (0, -0.135, 0.055), m["rubber"], bevel=0.004)
    g.b((0.03, 0.055, 0.04), (0, 0.02, 0.13), m["poly"], bevel=0.006)
    g.b((0.022, 0.004, 0.026), (0, 0.048, 0.133), m["lens"], bevel=0)
    g.b((0.02, 0.03, 0.17), (0, -0.016, -0.06), m["poly"], rx=-10, mag=True)
    g.muzzle = (0, 0.28, 0.062)
    return g.done()


def gun_m4a1(m):
    g = Gun("m4a1")
    g.b((0.034, 0.2, 0.05), (0, 0.03, 0.036), m["steel"], bevel=0.004)
    g.b((0.037, 0.22, 0.045), (0, 0.045, 0.078), m["steel"], bevel=0.004)
    g.b((0.05, 0.3, 0.052), (0, 0.31, 0.078), m["steel"], bevel=0.006)
    for k in range(13):
        g.b((0.026, 0.009, 0.006), (0, 0.17 + k * 0.022, 0.107), m["steel"], bevel=0)
        g.b((0.006, 0.009, 0.02), (0.027, 0.17 + k * 0.022, 0.078), m["steel"], bevel=0)
        g.b((0.006, 0.009, 0.02), (-0.027, 0.17 + k * 0.022, 0.078), m["steel"], bevel=0)
    g.c(0.009, 0.13, 0.46, 0.078, m["blued"])
    g.c(0.012, 0.05, 0.585, 0.078, m["blued"], verts=10)
    g.b((0.01, 0.02, 0.06), (0, 0.44, 0.11), m["steel"])
    g.b((0.034, 0.07, 0.044), (0, 0.08, 0.125), m["poly"], bevel=0.006)
    g.b((0.026, 0.004, 0.03), (0, 0.11, 0.128), m["lens"], bevel=0)
    g.c(0.014, 0.2, -0.25, 0.072, m["steel"])
    g.b((0.04, 0.16, 0.075), (0, -0.25, 0.05), m["poly"], rx=-4, bevel=0.008)
    g.b((0.042, 0.02, 0.12), (0, -0.335, 0.035), m["rubber"])
    g.grip(m["poly"], rx=-22, w=0.03, d=0.045)
    g.guard(m["steel"])
    g.b((0.01, 0.03, 0.01), (0.022, -0.04, 0.09), m["steel"])
    g.b((0.024, 0.065, 0.1), (0, 0.09, -0.02), m["steel"], rx=8, mag=True)
    g.b((0.024, 0.064, 0.08), (0, 0.108, -0.1), m["steel"], rx=18, mag=True)
    g.muzzle = (0, 0.61, 0.078)
    return g.done()


def gun_ak12(m):
    g = Gun("ak12")
    g.b((0.045, 0.3, 0.058), (0, 0.04, 0.054), m["steel"], bevel=0.005)
    g.b((0.044, 0.28, 0.026), (0, 0.035, 0.094), m["steel"], bevel=0.011)
    g.b((0.026, 0.3, 0.008), (0, 0.06, 0.11), m["steel"])
    g.b((0.052, 0.24, 0.056), (0, 0.31, 0.06), m["poly"], bevel=0.01)
    g.c(0.012, 0.26, 0.19, 0.1, m["steel"])
    g.c(0.009, 0.15, 0.42, 0.064, m["steel"])
    g.c(0.015, 0.065, 0.565, 0.064, m["steel"], verts=10)
    g.b((0.03, 0.06, 0.042), (0, 0.06, 0.135), m["poly"], bevel=0.006)
    g.b((0.022, 0.004, 0.026), (0, 0.087, 0.138), m["lens"], bevel=0)
    g.grip(m["poly"], rx=-22, w=0.032, d=0.048)
    g.guard(m["steel"], y=0.04)
    g.b((0.035, 0.26, 0.062), (0, -0.23, 0.045), m["poly"], rx=-3, bevel=0.01)
    g.b((0.04, 0.02, 0.13), (0, -0.36, 0.035), m["rubber"])
    g.b((0.012, 0.02, 0.02), (0.028, 0.08, 0.06), m["steel"])
    g.b((0.024, 0.07, 0.075), (0, 0.125, 0.0), m["poly"], rx=10, mag=True)
    g.b((0.024, 0.07, 0.07), (0, 0.142, -0.065), m["poly"], rx=20, mag=True)
    g.b((0.024, 0.07, 0.06), (0, 0.168, -0.122), m["poly"], rx=30, mag=True)
    g.muzzle = (0, 0.63, 0.064)
    return g.done()


def gun_benelli(m):
    g = Gun("benelli")
    g.b((0.045, 0.22, 0.066), (0, 0.05, 0.062), m["steel"], bevel=0.006)
    g.c(0.011, 0.48, 0.16, 0.082, m["steel"])
    g.c(0.012, 0.38, 0.16, 0.052, m["steel"])
    g.c(0.024, 0.2, 0.18, 0.06, m["poly"], verts=14)
    g.b((0.02, 0.015, 0.026), (0, 0.0, 0.106), m["steel"])
    g.b((0.005, 0.01, 0.014), (0, 0.63, 0.096), m["steel"])
    g.grip(m["poly"], rx=-22)
    g.guard(m["steel"])
    g.b((0.04, 0.3, 0.06), (0, -0.22, 0.045), m["poly"], rx=3, bevel=0.01)
    g.b((0.042, 0.025, 0.13), (0, -0.375, 0.035), m["rubber"])
    g.b((0.02, 0.06, 0.008), (0.024, 0.06, 0.066), m["steel"])
    g.c(0.0095, 0.065, 0.02, 0.034, m["shell"], mag=True)
    g.c(0.0098, 0.012, 0.008, 0.034, m["brass"], mag=True)
    g.muzzle = (0, 0.64, 0.082)
    return g.done()


def gun_m249(m):
    g = Gun("m249")
    g.b((0.075, 0.36, 0.088), (0, 0.06, 0.07), m["steel"], bevel=0.008)
    g.b((0.07, 0.16, 0.03), (0, 0.02, 0.127), m["steel"], bevel=0.006)
    g.c(0.012, 0.44, 0.24, 0.07, m["blued"])
    g.c(0.016, 0.05, 0.665, 0.07, m["blued"], verts=10)
    g.b((0.03, 0.2, 0.012), (0, 0.34, 0.093), m["steel"])
    g.c(0.012, 0.26, 0.24, 0.04, m["steel"])
    g.b((0.02, 0.14, 0.012), (0, 0.29, 0.15), m["poly"], bevel=0.004)
    for y in (0.23, 0.35):
        g.b((0.012, 0.012, 0.06), (0, y, 0.12), m["poly"])
    for x in (-0.016, 0.016):
        g.c(0.006, 0.3, 0.36, 0.03, m["steel"], x=x, verts=8)
    g.b((0.07, 0.12, 0.05), (0, 0.27, 0.045), m["poly"], bevel=0.008)
    g.b((0.05, 0.3, 0.08), (0, -0.28, 0.05), m["poly"], rx=-2, bevel=0.01)
    g.b((0.052, 0.025, 0.13), (0, -0.44, 0.04), m["rubber"])
    g.grip(m["poly"], rx=-22, w=0.034, d=0.05)
    g.guard(m["steel"], y=0.03)
    for k in range(5):
        g.b((0.014, 0.016, 0.008), (-0.045, 0.09 + k * 0.006, 0.035 - k * 0.014), m["brass"], bevel=0)
    g.b((0.1, 0.095, 0.11), (-0.025, 0.1, -0.035), m["olive"], bevel=0.008, mag=True)
    g.muzzle = (0, 0.69, 0.07)
    return g.done()


def gun_barrett(m):
    g = Gun("barrett")
    g.b((0.07, 0.62, 0.08), (0, 0.12, 0.075), m["steel"], bevel=0.008)
    g.b((0.06, 0.36, 0.055), (0, 0.0, 0.025), m["steel"], bevel=0.006)
    g.c(0.017, 0.56, 0.43, 0.085, m["blued"])
    g.b((0.065, 0.095, 0.05), (0, 1.03, 0.085), m["steel"], bevel=0.008)
    for y in (1.0, 1.035, 1.065):
        g.b((0.07, 0.014, 0.03), (0, y, 0.085), m["poly"], bevel=0)
    g.c(0.022, 0.34, -0.06, 0.18, m["blued"])
    g.c(0.022, 0.06, 0.28, 0.18, m["blued"], r2=0.03)
    g.c(0.03, 0.05, 0.34, 0.18, m["blued"])
    g.c(0.024, 0.07, -0.12, 0.18, m["blued"], r2=0.019)
    g.c(0.027, 0.004, 0.391, 0.18, m["lens"])
    g.c(0.021, 0.004, -0.124, 0.18, m["lens"])
    for y in (0.0, 0.2):
        g.b((0.03, 0.025, 0.06), (0, y, 0.135), m["steel"])
    g.b((0.022, 0.08, 0.022), (0.018, 0.08, 0.205), m["blued"])
    g.b((0.05, 0.3, 0.1), (0, -0.33, 0.06), m["steel"], bevel=0.01)
    g.b((0.052, 0.03, 0.15), (0, -0.495, 0.05), m["rubber"])
    g.b((0.03, 0.1, 0.04), (0, -0.36, 0.125), m["poly"], bevel=0.006)
    g.grip(m["poly"], rx=-14, w=0.034, d=0.05)
    g.guard(m["steel"])
    for x in (-0.02, 0.02):
        g.c(0.008, 0.36, 0.5, 0.045, m["steel"], x=x, verts=8)
    g.b((0.04, 0.11, 0.1), (0, 0.13, -0.03), m["steel"], mag=True)
    g.muzzle = (0, 1.08, 0.085)
    return g.done()


GUNS = [gun_m1911, gun_glock, gun_thompson, gun_trench, gun_kar98k, gun_garand, gun_mp7, gun_m4a1, gun_ak12, gun_benelli, gun_m249, gun_barrett]


def build_weapons():
    clear_scene()
    m = gun_palette()
    roots = []
    for i, fn in enumerate(GUNS):
        r = fn(m)
        roots.append(r)
    return roots


# ---- props ----------------------------------------------------------------------------------------------------------

def prop_palette():
    return {
        "paint": material("LockerPaint", (0.09, 0.13, 0.1), rough=0.55, metal=0.45),
        "peg": material("Pegboard", (0.08, 0.07, 0.06), rough=0.85),
        "placard": material("Placard", (0.55, 0.5, 0.4), rough=0.9),
        "indicator": material("Indicator", (1.0, 0.55, 0.15), emission=(1.0, 0.45, 0.1), strength=6.0),
        "bulb": material("Bulb", (1.0, 0.85, 0.6), emission=(1.0, 0.72, 0.42), strength=12.0),
        "enamel": material("Enamel", (0.11, 0.17, 0.14), rough=0.4, metal=0.5),
        "cable": material("Cable", (0.02, 0.02, 0.02), rough=0.6),
        "plank": material("Plank", (0.36, 0.27, 0.18), rough=0.88),
        "nail": material("Nail", (0.25, 0.24, 0.22), rough=0.5, metal=0.9),
        "olive": material("NadeOlive", (0.16, 0.18, 0.09), rough=0.6, metal=0.2),
        "steel": material("PropSteel", (0.4, 0.4, 0.4), rough=0.4, metal=0.9),
        "chain": material("Chain", (0.3, 0.29, 0.27), rough=0.5, metal=0.8),
        "bark": material("Bark", (0.075, 0.065, 0.055), rough=0.95),
    }


def dent(obj, amount=0.008, scale=4):
    sub = obj.modifiers.new("Sub", "SUBSURF")
    sub.subdivision_type = "SIMPLE"
    sub.levels = 2
    d = obj.modifiers.new("Dent", "DISPLACE")
    d.texture = noise_tex(f"dent{scale}", 1.0 / scale)
    d.strength = amount
    d.texture_coords = "GLOBAL"
    return obj


def prop_locker(p):
    parts = [
        box((1.0, 0.03, 2.0), (0, -0.235, 1.0), p["paint"]),
        box((0.03, 0.5, 2.0), (-0.485, 0, 1.0), p["paint"]),
        box((0.03, 0.5, 2.0), (0.485, 0, 1.0), p["paint"]),
        box((1.0, 0.5, 0.03), (0, 0, 1.985), p["paint"]),
        box((1.0, 0.5, 0.12), (0, 0, 0.06), p["paint"]),
        box((0.94, 0.45, 0.02), (0, 0, 0.75), p["paint"]),
        box((1.0, 0.04, 0.16), (0, 0.23, 1.9), p["paint"]),
        box((0.6, 0.01, 0.1), (0, 0.255, 1.9), p["placard"], bevel=0),
        box((0.94, 0.01, 1.0), (0, -0.215, 1.3), p["peg"], bevel=0),
    ]
    for o in parts[1:3]:
        dent(o, 0.006)
    # Two pegs that hold the gun, and a door hanging open.
    for x in (-0.25, 0.25):
        parts.append(cyl(0.008, 0.12, (x, -0.15, 1.2), p["steel"], rot=(math.radians(90), 0, 0), verts=8))
    door = box((0.47, 0.025, 1.84), (0, 0, 0), p["paint"])
    for k in range(5):
        parts.append(box((0.3, 0.012, 0.012), (0, 0, 0), p["peg"], bevel=0))
    door.location = (0.5 + 0.22 * math.cos(math.radians(20)), 0.25 + 0.22 * math.sin(math.radians(20)), 1.04)
    door.rotation_euler = (0, 0, math.radians(20))
    dent(door, 0.01)
    for k, vent in enumerate(parts[-5:]):
        vent.location = (door.location.x + 0.005, door.location.y + 0.02, 1.6 + k * 0.04)
        vent.rotation_euler = door.rotation_euler
    parts.append(door)
    parts.append(prim("sphere", p["indicator"], loc=(0, 0.2, 2.03), radius=0.03, segments=12, ring_count=8))
    parts.append(cyl(0.035, 0.02, (0, 0.2, 2.005), p["steel"], verts=12))
    obj = join(parts, "locker")
    set_origin(obj, (0, 0, 0))
    grime(obj, blood=0.25, dirt=0.4, stain=(0.32, 0.14, 0.06))
    return obj


def prop_lamp(p):
    parts = [prim("sphere", p["bulb"], loc=(0, 0, 0), radius=0.035, segments=14, ring_count=10)]
    parts.append(cyl(0.02, 0.05, (0, 0, 0.045), p["steel"], verts=12))
    bpy.ops.mesh.primitive_cone_add(radius1=0.21, radius2=0.045, depth=0.14, location=(0, 0, 0.06), vertices=28, end_fill_type="NOTHING")
    shade = bpy.context.active_object
    shade.data.materials.append(p["enamel"])
    sol = shade.modifiers.new("Solid", "SOLIDIFY")
    sol.thickness = 0.004
    smooth(shade)
    parts.append(shade)
    parts.append(cyl(0.05, 0.02, (0, 0, 0.135), p["enamel"], verts=16))
    parts.append(cyl(0.004, 1.0, (0, 0, 0.645), p["cable"], verts=6))
    obj = join(parts, "lamp")
    set_origin(obj, (0, 0, 0))
    return obj


def prop_board(p):
    plank = box((1.9, 0.035, 0.18), (0, 0, 0), p["plank"], bevel=0.006)
    sub = plank.modifiers.new("Sub", "SUBSURF")
    sub.subdivision_type = "SIMPLE"
    sub.levels = 2
    d = plank.modifiers.new("Warp", "DISPLACE")
    d.texture = noise_tex("grain", 0.08)
    d.strength = 0.012
    d.texture_coords = "GLOBAL"
    parts = [plank]
    for x in (-0.86, 0.86):
        for z in (-0.045, 0.045):
            parts.append(cyl(0.006, 0.006, (x + random.uniform(-0.02, 0.02), 0.02, z), p["nail"], rot=(math.radians(90), 0, 0), verts=8))
    obj = join(parts, "board")
    set_origin(obj, (0, 0, 0))
    grime(obj, dirt=0.5)
    return obj


def prop_nade(p):
    body = prim("sphere", p["olive"], loc=(0, 0, 0), scale=(1, 1, 1.25), radius=0.03, segments=20, ring_count=14)
    body = apply_all(body)
    for v in body.data.vertices:
        a = math.atan2(v.co.y, v.co.x)
        v.co += v.normal * 0.0025 * (max(0, math.sin(a * 8)) + max(0, math.sin(v.co.z * 260)))
    parts = [body, cyl(0.011, 0.022, (0, 0, 0.044), p["steel"], verts=12), box((0.012, 0.004, 0.07), (0.016, 0, 0.022), p["steel"], rot=(0, math.radians(-12), 0), bevel=0.001)]
    parts.append(prim("torus", p["steel"], loc=(-0.016, 0, 0.05), rot=(math.radians(90), 0, 0), major_radius=0.011, minor_radius=0.0015, major_segments=12, minor_segments=4))
    obj = join(parts, "nade")
    set_origin(obj, (0, 0, 0))
    return obj


def prop_fence(p):
    parts = []
    for x in (-1.25, 1.25):
        parts.append(cyl(0.03, 2.2, (x, 0, 1.1), p["chain"], verts=10))
    parts.append(cyl(0.018, 2.5, (0, 0, 2.1), p["chain"], rot=(0, math.radians(90), 0), verts=8))
    step = 0.12
    rng = random.Random(4)
    for sign in (-1, 1):
        k = -2.0
        while k < 2.5:
            # Lines at 45 degrees clipped to the panel x in [-1.22, 1.22], z in [0.05, 2.08].
            x0, z0 = k, 0.05
            x1, z1 = k + 2.03, 2.08
            if sign < 0:
                x0, x1 = -x0, -x1
            t0, t1 = 0.0, 1.0
            for a, b, lo, hi in ((x0, x1, -1.22, 1.22), (z0, z1, 0.05, 2.08)):
                if abs(b - a) < 1e-9:
                    continue
                ta, tb = (lo - a) / (b - a), (hi - a) / (b - a)
                t0, t1 = max(t0, min(ta, tb)), min(t1, max(ta, tb))
            if t1 > t0 + 0.02 and rng.random() > 0.04:
                ax, az = x0 + (x1 - x0) * t0, z0 + (z1 - z0) * t0
                bx, bz = x0 + (x1 - x0) * t1, z0 + (z1 - z0) * t1
                length = math.hypot(bx - ax, bz - az)
                w = box((0.004, 0.004, length), ((ax + bx) / 2, rng.uniform(-0.01, 0.01), (az + bz) / 2), p["chain"], rot=(0, math.atan2(bx - ax, bz - az), 0), bevel=0)
                parts.append(w)
            k += step
    obj = join(parts, "fence")
    set_origin(obj, (0, 0, 0))
    grime(obj, dirt=0.4, blood=0.3, stain=(0.3, 0.13, 0.05))
    return obj


def prop_tree(p):
    rng = random.Random(7)
    verts, edges, radii = [(0, 0, -0.3)], [], [0.26]

    def grow(i0, d, length, r, depth):
        pos = Vector(verts[i0])
        n = 4
        for s in range(n):
            d = (d + Vector((rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), rng.uniform(-0.1, 0.25)))).normalized()
            pos = pos + d * (length / n)
            verts.append(tuple(pos))
            radii.append(max(0.012, r * (1 - (s + 1) / (n + 1.5))))
            edges.append((i0, len(verts) - 1))
            i0 = len(verts) - 1
            if depth > 0 and s >= 1 and rng.random() < 0.55:
                side = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0.2, 0.9))).normalized()
                grow(i0, side, length * 0.55, radii[-1] * 0.7, depth - 1)
        if depth > 0:
            for _ in range(2):
                side = (d + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0, 0.6)))).normalized()
                grow(i0, side, length * 0.6, radii[-1] * 0.85, depth - 1)

    grow(0, Vector((0, 0, 1)), 3.6, 0.24, 2)
    tree = skin_mesh("tree", verts, edges, radii, subsurf=0, disp=0.02, disp_scale=0.3, mats=[p["bark"]])
    print("TREE tris", tris(tree))
    return tree


def build_props():
    clear_scene()
    p = prop_palette()
    objs = [prop_locker(p), prop_lamp(p), prop_board(p), prop_nade(p), prop_fence(p), prop_tree(p)]
    # Spread them out for the preview; the client reads each by name and resets its position.
    for i, o in enumerate(objs):
        o.location.x += (i - 2.5) * 2.6
        if o.name == "lamp":
            o.location.z += 2.0
        if o.name in ("nade",):
            o.scale = (8, 8, 8)
    return objs


# ---- first-person arms ----------------------------------------------------------------------------------------------

def build_arms():
    """Camera at the origin looking along +Y. Right hand closes around a grip at GRIP; the left supports at LEFT_HAND."""
    clear_scene()
    sleeve = material("Sleeve", (0.13, 0.14, 0.12), rough=0.85)
    glove = material("Glove", (0.035, 0.035, 0.035), rough=0.7)
    out = []
    for name, elbow, wrist, palm, fingers_dir in (
        ("ArmR", (0.26, 0.05, -0.42), (0.13, 0.3, -0.235), (0.12, 0.33, -0.21), (-1, 0.15, -0.3)),
        ("ArmL", (-0.2, 0.32, -0.42), (0.0, 0.5, -0.22), (0.02, 0.53, -0.19), (1, 0.1, 0.3)),
    ):
        e, w, pm = Vector(elbow), Vector(wrist), Vector(palm)
        fd = Vector(fingers_dir).normalized()
        verts = [tuple(e - (w - e).normalized() * 0.25), tuple(e), tuple(e.lerp(w, 0.55)), tuple(w), tuple(pm)]
        radii = [0.06, 0.055, 0.045, 0.034, (0.036, 0.02)]
        edges = [(0, 1), (1, 2), (2, 3), (3, 4)]
        for k in range(4):
            off = Vector((0, 0, 0.012 * (k - 1.5))) + Vector((0, 0.01 * (k - 1.5), 0))
            a = len(verts)
            b0 = pm + off + fd * 0.035
            b1 = b0 + fd * 0.025 + Vector((0, -0.02, -0.01))
            b2 = b1 + Vector((0, -0.025, -0.008)) - fd * 0.01
            verts += [tuple(b0), tuple(b1), tuple(b2)]
            radii += [0.011, 0.0095, 0.008]
            edges += [(4, a), (a, a + 1), (a + 1, a + 2)]
        a = len(verts)
        verts += [tuple(pm + Vector((0, 0.03, 0.02))), tuple(pm + Vector((0, 0.05, 0.03)) + fd * 0.02)]
        radii += [0.012, 0.0095]
        edges += [(4, a), (a, a + 1)]
        obj = skin_mesh(name, verts, edges, radii, subsurf=1, mats=[sleeve, glove])
        cut = e.lerp(w, 0.75)
        paint_faces(obj, lambda c, n, cut=cut, w=w: 1 if (c - cut).dot((w - cut).normalized()) > 0 else 0)
        out.append(obj)
    print("ARMS tris", sum(tris(o) for o in out))
    return out


# ---- main -----------------------------------------------------------------------------------------------------------

def build_all():
    random.seed(1)
    if ONLY in (None, "zombie"):
        arm, meshes = build_zombie()
        export("zombie", [arm], animations=True, skins=True, textures=True)
    if ONLY in (None, "survivor"):
        arm, meshes = build_survivor()
        export("survivor", [arm], animations=True, skins=True, textures=True)
    # Guns and first-person arms now come from build_weapons.py; they are only built here when asked for by name.
    if ONLY == "weapons":
        roots = build_weapons()
        for i, r in enumerate(roots):
            r.location.x = (i % 3) * 1.6
            r.location.z = (i // 3) * 0.35
        preview("weapons", target=(1.6, 0.2, 0.55), dist=3.6, angles=(90,), elev=4, lens=40)
        for r in roots:
            r.location = (0, 0, 0)
        export("weapons", roots)
    # Props now come from build_props.py; only built here when asked for by name.
    if ONLY == "props":
        objs = build_props()
        preview("props", target=(-5.2, 0, 1.2), dist=5, angles=(25,), elev=12)
        for o in objs:
            o.location = (0, 0, 0)
            o.scale = (1, 1, 1)
        export("props", objs)
    if ONLY == "arms":
        objs = build_arms()
        export("arms", objs)


if __name__ == "__main__":
    build_all()
