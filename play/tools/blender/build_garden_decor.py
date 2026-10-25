"""
Builds the Garden Sentinels ambient life + cozy decor (decor.glb) in Blender.

    blender --background --factory-startup --python build_garden_decor.py -- <output-dir> [preview-dir]

(with preview-dir it also renders decor_preview.png: a lineup of every prop, critters enlarged x3 in the front row.)

Conventions the ambience module relies on:
  * Blender +Y is the front (glTF -Z), metres, every root is a top-level object named Decor_<name>.
  * Ground props have their origin at the ground centre; flying critters (butterfly, firefly, bird, bee, dragonfly,
    watering_drone) at the body centre.
  * Wing children Decor_<name>_wingL / _wingR have their origin on the hinge; the hinge runs along the body (Blender Y,
    glTF/three.js Z), so flapping is a rotation about the child's local Z in three.js (+ lifts the left wing for
    wingL with rotation.z = -a, the right one for wingR with rotation.z = +a).
  * Decor_watering_drone_prop spins about its local up axis; Decor_sprinkler_head spins about up;
    Decor_windchime_chimes hangs from its origin (sway it about X/Z).
  * Decor_gnome_bot has children Decor_gnome_bot_head and Decor_gnome_bot_can and an idle clip gnome_bot_idle
    (2 s loop, only the children are animated so the root stays free for the game to place).
  * Emissive materials are named Glow*: GlowFirefly, GlowMushroom, GlowAmber, GlowMint.
"""

import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/garden")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None

FLYERS = {"butterfly", "firefly", "bird", "bee", "dragonfly"}


# ---- scene helpers ---------------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def smooth(obj, on=True):
    for p in obj.data.polygons:
        p.use_smooth = on
    return obj


def srgb(hexstr):
    h = hexstr.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def plain(name, hexstr, rough=0.5, metal=0.0, emission=None, strength=1.0, alpha=1.0, double_sided=False):
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    color = srgb(hexstr)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*srgb(emission), 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            if hasattr(mat, attr):
                try:
                    setattr(mat, attr, val)
                except TypeError:
                    pass
    mat.diffuse_color = (*color, 1.0)
    return mat


def palette():
    return {
        "ceramic": plain("Ceramic", "#F5E7D6", rough=0.32),
        "amber": plain("Amber", "#FFA940", rough=0.4),
        "mint": plain("Mint", "#4EE6D9", rough=0.35),
        "blue": plain("WaterBlue", "#2EB3FF", rough=0.3),
        "leaf": plain("Leaf", "#6BAF4B", rough=0.7),
        "violet": plain("Violet", "#A869FF", rough=0.4),
        "wood": plain("Wood", "#8A5A36", rough=0.75),
        "woodlight": plain("WoodLight", "#D9A86C", rough=0.7),
        "stone": plain("Stone", "#B9AE9E", rough=0.85),
        "moss": plain("Moss", "#4F8A3A", rough=0.9),
        "soil": plain("Soil", "#5A3D2B", rough=0.95),
        "ink": plain("Ink", "#1E2433", rough=0.3),
        "metal": plain("Metal", "#A9B0B8", rough=0.35, metal=0.85),
        "wing": plain("Wing", "#D8FFF9", rough=0.2, alpha=0.55, double_sided=True),
        "gfire": plain("GlowFirefly", "#FFE27A", rough=0.4, emission="#FFD45A", strength=6.0),
        "gmush": plain("GlowMushroom", "#4EE6D9", rough=0.4, emission="#4EE6D9", strength=2.5),
        "gamber": plain("GlowAmber", "#FFA940", rough=0.4, emission="#FFA940", strength=3.0),
        "gmint": plain("GlowMint", "#4EE6D9", rough=0.4, emission="#7FF5EA", strength=3.0),
    }


def prim(kind, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0, segs=1, flat=False, **kw):
    ops = {
        "cube": bpy.ops.mesh.primitive_cube_add,
        "cyl": bpy.ops.mesh.primitive_cylinder_add,
        "cone": bpy.ops.mesh.primitive_cone_add,
        "sphere": bpy.ops.mesh.primitive_uv_sphere_add,
        "torus": bpy.ops.mesh.primitive_torus_add,
    }
    if kind == "cube":
        kw.setdefault("size", 1)
    if kind == "sphere":
        kw.setdefault("segments", 10)
        kw.setdefault("ring_count", 6)
    if kind in ("cyl", "cone"):
        kw.setdefault("vertices", 10)
    ops[kind](location=loc, rotation=rot, **kw)
    obj = bpy.context.active_object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        m = obj.modifiers.new("Bevel", "BEVEL")
        m.width = bevel
        m.segments = segs
        m.limit_method = "ANGLE"
    if kind in ("sphere", "torus", "cyl", "cone") and not flat:
        smooth(obj)
        if kind in ("cyl", "cone"):
            m = obj.modifiers.new("Split", "EDGE_SPLIT")
            m.split_angle = math.radians(40)
    return obj


def box(size, loc, mat, rot=(0, 0, 0), bevel=0.0, segs=1):
    return prim("cube", mat, loc=loc, rot=rot, scale=size, bevel=bevel, segs=segs)


def cyl(r, depth, loc, mat, rot=(0, 0, 0), verts=10, **kw):
    return prim("cyl", mat, loc=loc, rot=rot, radius=r, depth=depth, vertices=verts, **kw)


def ball(r, loc, mat, scale=(1, 1, 1), segs=10, rings=6, rot=(0, 0, 0)):
    return prim("sphere", mat, loc=loc, rot=rot, radius=r, scale=scale, segments=segs, ring_count=rings)


def cone(r1, r2, depth, loc, mat, rot=(0, 0, 0), verts=10):
    return prim("cone", mat, loc=loc, rot=rot, radius1=r1, radius2=r2, depth=depth, vertices=verts)


def mesh_obj(name, verts, faces, mats, face_mats=None, smooth_shade=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    for m in (mats if isinstance(mats, (list, tuple)) else [mats]):
        me.materials.append(m)
    if face_mats:
        for p, mi in zip(me.polygons, face_mats):
            p.material_index = mi
    smooth(obj, smooth_shade)
    return obj


def lathe(profile, mats, seg=12, bands=None, loc=(0, 0, 0), scale=(1, 1, 1), smooth_shade=True, name="lathe"):
    """Revolve a (radius, z) profile (bottom to top) around Z. bands[i] = material index of the band between ring i
    and i+1. Rings with radius 0 collapse into a pole."""
    verts, faces, fm, rings = [], [], [], []
    for r, z in profile:
        if r < 1e-6:
            rings.append([len(verts)])
            verts.append((loc[0], loc[1], loc[2] + z * scale[2]))
        else:
            idx = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                idx.append(len(verts))
                verts.append((loc[0] + math.cos(a) * r * scale[0], loc[1] + math.sin(a) * r * scale[1],
                              loc[2] + z * scale[2]))
            rings.append(idx)
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        mi = bands[i] if bands else 0
        for j in range(seg):
            j2 = (j + 1) % seg
            if len(a) == 1 and len(b) == 1:
                continue
            if len(a) == 1:
                faces.append((a[0], b[j2], b[j]))
            elif len(b) == 1:
                faces.append((a[j], a[j2], b[0]))
            else:
                faces.append((a[j], a[j2], b[j2], b[j]))
            fm.append(mi)
    # Cap open ends with a fan so nothing is see-through.
    if len(rings[0]) > 1:
        faces.append(tuple(reversed(rings[0])))
        fm.append(bands[0] if bands else 0)
    if len(rings[-1]) > 1:
        faces.append(tuple(rings[-1]))
        fm.append(bands[-1] if bands else 0)
    return mesh_obj(name, verts, faces, mats, fm, smooth_shade)


def flat_shape(pts, mat, z=0.0, thick=0.0015, two_sided=True, transform=None, name="flat"):
    """A 2D outline in the XY plane (counter-clockwise), top face + (optionally) a flipped bottom face."""
    n = len(pts)
    verts = [(x, y, z + thick / 2) for x, y in pts]
    faces = [tuple(range(n))]
    if two_sided:
        verts += [(x, y, z - thick / 2) for x, y in pts]
        faces.append(tuple(range(2 * n - 1, n - 1, -1)))
    obj = mesh_obj(name, verts, faces, mat, smooth_shade=False)
    if transform is not None:
        obj.data.transform(transform)
    return obj


def join(objs, name):
    for o in objs:
        activate(o)
        bpy.ops.object.convert(target="MESH")
    activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    if len(objs) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.name = name
    obj.data.name = name
    return obj


def set_origin(obj, point):
    d = Vector(point) - obj.location
    obj.data.transform(Matrix.Translation(-d))
    obj.location = Vector(point)


def parent(child, root):
    child.parent = root
    child.matrix_parent_inverse = root.matrix_world.inverted()


def make_root(name, parts, origin=(0, 0, 0)):
    root = join(parts, f"Decor_{name}")
    set_origin(root, origin)
    return root


def make_child(root, suffix, parts, hinge):
    ch = join(parts, f"{root.name}_{suffix}")
    set_origin(ch, hinge)
    parent(ch, root)
    return ch


def tris(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def tree_tris(root):
    return tris(root) + sum(tree_tris(c) for c in root.children)


def mirror_x(pts):
    return [(-x, y) for x, y in reversed(pts)]


def hex_ring(r, n, z, jitter=0.0, seed=0):
    rnd = random.Random(seed)
    return [(math.cos(2 * math.pi * i / n) * r * (1 + rnd.uniform(-jitter, jitter)),
             math.sin(2 * math.pi * i / n) * r * (1 + rnd.uniform(-jitter, jitter))) for i in range(n)]


# ---- critters --------------------------------------------------------------------------------------------------------

def critter_butterfly(p):
    body = [
        ball(0.0075, (0, -0.006, 0), p["ink"], scale=(1, 3.6, 1), segs=8, rings=4),
        ball(0.0085, (0, 0.024, 0.001), p["violet"], segs=8, rings=4),
        ball(0.0024, (-0.003, 0.031, 0.004), p["ink"], segs=5, rings=3),
        ball(0.0024, (0.003, 0.031, 0.004), p["ink"], segs=5, rings=3),
    ]
    for s in (-1, 1):
        body.append(cyl(0.0007, 0.03, (s * 0.006, 0.042, 0.012), p["ink"], rot=(math.radians(-55), s * math.radians(-18), 0), verts=4))
        body.append(ball(0.0022, (s * 0.0105, 0.053, 0.021), p["amber"], segs=5, rings=3))
    root = make_root("butterfly", body)
    # Fore + hind wing as one outline, hinge at x = 0 (the left wing extends to -X).
    outline = [(0, 0.022), (-0.022, 0.044), (-0.05, 0.05), (-0.072, 0.038), (-0.075, 0.016), (-0.058, 0.002),
               (-0.068, -0.018), (-0.062, -0.04), (-0.04, -0.052), (-0.02, -0.042), (-0.004, -0.02), (0, -0.004)]
    spot = [(-0.05, 0.032), (-0.062, 0.03), (-0.064, 0.02), (-0.053, 0.018)]
    spot2 = [(-0.042, -0.022), (-0.052, -0.028), (-0.05, -0.038), (-0.04, -0.034)]
    for side, s in (("wingL", -1), ("wingR", 1)):
        flip = Matrix.Scale(-1, 4, (1, 0, 0)) if s > 0 else Matrix.Identity(4)
        hinge = Matrix.Translation((s * 0.006, 0, 0.002))
        parts = [flat_shape(outline if s < 0 else outline, p["violet"], thick=0.0012, transform=hinge @ flip)]
        for sp in (spot, spot2):
            parts.append(flat_shape(sp, p["amber"], z=0.0011, thick=0.0004, two_sided=False, transform=hinge @ flip))
            parts.append(flat_shape(list(reversed(sp)), p["amber"], z=-0.0011, thick=0.0004, two_sided=False, transform=hinge @ flip))
        ch = make_child(root, side, parts, (s * 0.006, 0, 0.002))
        if s > 0:
            ch.data.flip_normals()
    return root


def critter_firefly(p):
    parts = [
        ball(0.006, (0, 0.004, 0), p["ink"], scale=(1, 1.5, 0.9), segs=8, rings=5),
        ball(0.0045, (0, 0.016, 0.001), p["ink"], segs=8, rings=5),
        ball(0.0075, (0, -0.012, -0.001), p["gfire"], scale=(1, 1.3, 1), segs=8, rings=6),
    ]
    for s in (-1, 1):
        parts.append(cyl(0.0005, 0.012, (s * 0.003, 0.023, 0.006), p["ink"], rot=(math.radians(-50), s * math.radians(-20), 0), verts=4))
    root = make_root("firefly", parts)
    wing = [(0, 0.008), (-0.006, 0.004), (-0.014, -0.006), (-0.01, -0.012), (-0.002, -0.006)]
    for side, s in (("wingL", -1), ("wingR", 1)):
        flip = Matrix.Scale(-1, 4, (1, 0, 0)) if s > 0 else Matrix.Identity(4)
        tr = Matrix.Translation((s * 0.002, 0.006, 0.005))
        ch = make_child(root, side, [flat_shape(wing, p["wing"], two_sided=False, transform=tr @ flip)], (s * 0.002, 0.006, 0.005))
    return root


def critter_bird(p):
    parts = [
        ball(0.034, (0, 0, 0), p["blue"], scale=(1, 1.45, 0.95), segs=8, rings=5),
        ball(0.027, (0, 0.012, -0.012), p["ceramic"], scale=(1, 1.3, 0.9), segs=6, rings=4),
        ball(0.028, (0, 0.044, 0.026), p["blue"], segs=8, rings=5),
        ball(0.016, (0, 0.06, 0.016), p["ceramic"], segs=6, rings=3),
        cone(0.008, 0.0, 0.022, (0, 0.079, 0.026), p["amber"], rot=(math.radians(-90), 0, 0), verts=6),
        ball(0.0055, (-0.017, 0.062, 0.034), p["ink"], segs=5, rings=3),
        ball(0.0055, (0.017, 0.062, 0.034), p["ink"], segs=5, rings=3),
        # crest tuft
        cone(0.007, 0.0, 0.022, (0, 0.036, 0.058), p["amber"], rot=(math.radians(-30), 0, 0), verts=5),
    ]
    tail = [(0.0, 0.0), (0.02, -0.05), (0.008, -0.044), (0.0, -0.056), (-0.008, -0.044), (-0.02, -0.05)]
    parts.append(flat_shape(list(reversed(tail)), p["blue"], thick=0.004,
                            transform=Matrix.Translation((0, -0.038, 0.008)) @ Matrix.Rotation(math.radians(20), 4, "X")))
    root = make_root("bird", parts)
    wing = [(0, 0.02), (-0.03, 0.022), (-0.062, 0.006), (-0.078, -0.018), (-0.05, -0.016), (-0.056, -0.03),
            (-0.03, -0.024), (-0.008, -0.026), (0, -0.012)]
    tip = [(-0.05, 0.012), (-0.062, 0.006), (-0.078, -0.018), (-0.05, -0.016)]
    for side, s in (("wingL", -1), ("wingR", 1)):
        flip = Matrix.Scale(-1, 4, (1, 0, 0)) if s > 0 else Matrix.Identity(4)
        tr = Matrix.Translation((s * 0.028, 0.002, 0.014))
        parts = [flat_shape(wing, p["blue"], thick=0.006, transform=tr @ flip)]
        parts.append(flat_shape(tip, p["ink"], z=0.0032, thick=0.0005, two_sided=False, transform=tr @ flip))
        ch = make_child(root, side, parts, (s * 0.028, 0.002, 0.014))
        if s > 0:
            ch.data.flip_normals()
    return root


def critter_bee(p):
    prof = [(0, -0.022), (0.008, -0.019), (0.012, -0.013), (0.0135, -0.006), (0.0135, 0.002), (0.012, 0.009),
            (0.009, 0.014), (0, 0.016)]
    body = lathe(prof, [p["amber"], p["ink"]], seg=8, bands=[1, 1, 0, 1, 0, 0, 0], name="bee_body")
    body.rotation_euler = (math.radians(-90), 0, 0)
    parts = [
        body,
        ball(0.0095, (0, 0.022, 0.002), p["ink"], segs=8, rings=5),
        ball(0.003, (-0.005, 0.029, 0.004), p["ceramic"], segs=5, rings=3),
        ball(0.003, (0.005, 0.029, 0.004), p["ceramic"], segs=5, rings=3),
    ]
    for s in (-1, 1):
        parts.append(cyl(0.0006, 0.012, (s * 0.004, 0.03, 0.012), p["ink"], rot=(math.radians(-40), s * math.radians(-25), 0), verts=4))
    root = make_root("bee", parts)
    wing = [(0, 0.006), (-0.01, 0.01), (-0.022, 0.004), (-0.024, -0.006), (-0.012, -0.006), (0, -0.002)]
    for side, s in (("wingL", -1), ("wingR", 1)):
        flip = Matrix.Scale(-1, 4, (1, 0, 0)) if s > 0 else Matrix.Identity(4)
        tr = Matrix.Translation((s * 0.004, 0.008, 0.012)) @ Matrix.Rotation(math.radians(-15 * s), 4, "Y")
        make_child(root, side, [flat_shape(wing, p["wing"], two_sided=False, transform=tr @ flip)], (s * 0.004, 0.008, 0.012))
    return root


def critter_dragonfly(p):
    prof = [(0, -0.075), (0.0025, -0.07), (0.003, -0.04), (0.0035, -0.01), (0.0045, 0.0)]
    abdomen = lathe(prof, [p["blue"], p["mint"]], seg=6, bands=[1, 0, 1, 0], name="df_abd")
    abdomen.rotation_euler = (math.radians(-90), 0, 0)
    abdomen.data.transform(Matrix.Rotation(math.radians(-90), 4, "X"))
    abdomen.rotation_euler = (0, 0, 0)
    parts = [
        abdomen,
        ball(0.0075, (0, 0.006, 0), p["mint"], scale=(1, 1.4, 1), segs=8, rings=5),
        ball(0.0062, (-0.0055, 0.02, 0.002), p["blue"], segs=8, rings=5),
        ball(0.0062, (0.0055, 0.02, 0.002), p["blue"], segs=8, rings=5),
        ball(0.0018, (-0.007, 0.024, 0.006), p["ceramic"], segs=4, rings=3),
        ball(0.0018, (0.007, 0.024, 0.006), p["ceramic"], segs=4, rings=3),
    ]
    root = make_root("dragonfly", parts)
    fore = [(0, 0.003), (-0.02, 0.006), (-0.06, 0.004), (-0.068, -0.001), (-0.04, -0.005), (0, -0.003)]
    hind = [(0, 0.003), (-0.03, 0.002), (-0.058, -0.004), (-0.062, -0.01), (-0.03, -0.012), (0, -0.004)]
    for side, s in (("wingL", -1), ("wingR", 1)):
        flip = Matrix.Scale(-1, 4, (1, 0, 0)) if s > 0 else Matrix.Identity(4)
        hinge = (s * 0.004, 0.006, 0.006)
        t1 = Matrix.Translation((hinge[0], hinge[1] + 0.004, hinge[2])) @ Matrix.Rotation(math.radians(6), 4, "Z" if s < 0 else "Z")
        t2 = Matrix.Translation((hinge[0], hinge[1] - 0.006, hinge[2]))
        make_child(root, side, [flat_shape(fore, p["wing"], two_sided=False, transform=t1 @ flip),
                                flat_shape(hind, p["wing"], two_sided=False, transform=t2 @ flip)], hinge)
    return root


# ---- small life on the ground ----------------------------------------------------------------------------------------

def mushroom(p, loc, h, r, cap_mat, gill_mat, stem_mat, spots_mat=None, tilt=0.0, seed=0, seg=10):
    x, y, z = loc
    stem = lathe([(r * 0.42, 0), (r * 0.36, h * 0.5), (r * 0.3, h * 0.85), (r * 0.3, h)], [stem_mat], seg=8,
                 loc=(x, y, z), name="stem")
    capz = z + h * 0.92
    cap = lathe([(r * 0.3, 0), (r, r * 0.02), (r * 1.02, r * 0.18), (r * 0.85, r * 0.55), (r * 0.5, r * 0.82),
                 (0, r * 0.9)], [cap_mat, gill_mat], seg=seg, bands=[1, 0, 0, 0, 0], loc=(x, y, capz), name="cap")
    parts = [stem, cap]
    if spots_mat:
        rnd = random.Random(seed)
        for i in range(5):
            a = rnd.uniform(0, 2 * math.pi)
            el = rnd.uniform(0.45, 1.0)
            px = x + math.cos(a) * r * 0.8 * math.cos(el)
            py = y + math.sin(a) * r * 0.8 * math.cos(el)
            pz = capz + r * 0.2 + r * 0.6 * math.sin(el)
            parts.append(ball(r * 0.13, (px, py, pz), spots_mat, scale=(1, 1, 0.45), segs=6, rings=3))
    if tilt:
        piv = Matrix.Translation(Vector((x, y, z))) @ Matrix.Rotation(tilt, 4, "Y") @ Matrix.Translation(-Vector((x, y, z)))
        for o in parts:
            activate(o)
            bpy.ops.object.convert(target="MESH")
            o.data.transform(o.matrix_world)
            o.matrix_world = Matrix.Identity(4)
            o.data.transform(piv)
    return parts


def grass_tuft(p, loc, n=5, h=0.08, seed=0):
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        a = rnd.uniform(0, 2 * math.pi)
        out.append(cone(0.008, 0.0, h * rnd.uniform(0.7, 1.2), (loc[0] + math.cos(a) * 0.012, loc[1] + math.sin(a) * 0.012,
                                                                 loc[2] + h * 0.45),
                        p["leaf"], rot=(rnd.uniform(-0.35, 0.35), rnd.uniform(-0.35, 0.35), 0), verts=3))
    return out


def prop_mushroom_a(p):
    parts = mushroom(p, (0, 0, 0), 0.13, 0.085, p["amber"], p["ceramic"], p["ceramic"], spots_mat=p["ceramic"], seed=2, seg=12)
    parts += mushroom(p, (0.075, 0.04, 0), 0.06, 0.032, p["gmush"], p["violet"], p["ceramic"], tilt=math.radians(14), seg=8)
    parts += grass_tuft(p, (-0.06, 0.05, 0), n=4, h=0.06, seed=4)
    parts.append(ball(0.06, (0, 0, 0), p["moss"], scale=(1.4, 1.2, 0.18), segs=10, rings=4))
    return make_root("mushroom_a", parts)


def prop_mushroom_b(p):
    parts = []
    parts += mushroom(p, (0, 0, 0), 0.16, 0.055, p["gmush"], p["violet"], p["ceramic"], spots_mat=p["ceramic"], seed=5)
    parts += mushroom(p, (-0.07, 0.03, 0), 0.1, 0.04, p["gmush"], p["violet"], p["ceramic"], tilt=math.radians(-16), seed=6, seg=8)
    parts += mushroom(p, (0.06, -0.035, 0), 0.075, 0.032, p["violet"], p["gmush"], p["ceramic"], tilt=math.radians(18), seg=8)
    parts += mushroom(p, (0.035, 0.06, 0), 0.04, 0.02, p["gmush"], p["violet"], p["ceramic"], tilt=math.radians(10), seg=8)
    parts.append(ball(0.07, (0, 0.01, 0), p["moss"], scale=(1.5, 1.3, 0.16), segs=10, rings=4))
    return make_root("mushroom_b", parts)


# ---- robots ----------------------------------------------------------------------------------------------------------

def watering_can(p, loc):
    x, y, z = loc
    parts = [
        cyl(0.045, 0.08, (x, y, z), p["blue"], verts=12),
        cyl(0.047, 0.012, (x, y, z - 0.034), p["ceramic"], verts=12),
        cyl(0.03, 0.01, (x, y, z + 0.044), p["ceramic"], verts=12),
        cone(0.012, 0.006, 0.09, (x, y + 0.07, z + 0.02), p["blue"], rot=(math.radians(-55), 0, 0), verts=6),
        cone(0.006, 0.016, 0.018, (x, y + 0.108, z + 0.05), p["ceramic"], rot=(math.radians(-55), 0, 0), verts=8),
        prim("torus", p["ceramic"], loc=(x, y - 0.03, z + 0.04), rot=(0, math.radians(90), 0), major_radius=0.03,
             minor_radius=0.006, major_segments=10, minor_segments=4),
    ]
    return parts


def prop_gnome_bot(p):
    body_prof = [(0.0, 0.07), (0.07, 0.072), (0.1, 0.11), (0.112, 0.16), (0.105, 0.21), (0.08, 0.26), (0.05, 0.28)]
    body = lathe(body_prof, [p["ceramic"], p["amber"]], seg=14, bands=[0, 0, 1, 0, 0, 0], name="gb_body")
    parts = [body]
    for s in (-1, 1):
        parts.append(ball(0.032, (s * 0.05, 0.012, 0.022), p["ink"], scale=(1, 1.4, 0.7), segs=10, rings=5))
        parts.append(cyl(0.016, 0.06, (s * 0.05, 0, 0.06), p["metal"], verts=8))
    parts.append(ball(0.022, (0, 0.104, 0.17), p["gmint"], scale=(1, 0.35, 1), segs=10, rings=5))
    parts.append(prim("torus", p["metal"], loc=(0, 0.103, 0.17), rot=(math.radians(90), 0, 0), major_radius=0.024,
                      minor_radius=0.005, major_segments=12, minor_segments=4))
    # left arm hanging, a small mitten
    parts.append(cyl(0.013, 0.09, (-0.112, 0.0, 0.17), p["metal"], rot=(0, math.radians(-14), 0), verts=8))
    parts.append(ball(0.022, (-0.122, 0.0, 0.12), p["ceramic"], segs=8, rings=5))
    parts.append(ball(0.026, (-0.104, 0.0, 0.22), p["ceramic"], segs=8, rings=5))
    root = make_root("gnome_bot", parts)

    hz = 0.33
    head = [
        ball(0.085, (0, 0, hz), p["ceramic"], scale=(1, 0.95, 0.9), segs=12, rings=7),
        ball(0.07, (0, 0.03, hz - 0.005), p["ink"], scale=(1, 0.75, 0.62), segs=12, rings=6),
        ball(0.014, (-0.028, 0.083, hz), p["gmint"], scale=(1, 0.5, 1.15), segs=8, rings=5),
        ball(0.014, (0.028, 0.083, hz), p["gmint"], scale=(1, 0.5, 1.15), segs=8, rings=5),
        # ceramic beard below the visor, it is a gnome after all
        ball(0.055, (0, 0.05, hz - 0.06), p["ceramic"], scale=(1, 0.65, 0.6), segs=10, rings=5),
        cyl(0.02, 0.03, (0, 0, 0.28), p["metal"], verts=8),
        # gnome hat: a slightly bent Leaf-green cone with an amber pompom light
        cyl(0.088, 0.018, (0, 0, hz + 0.05), p["amber"], verts=14),
        cone(0.084, 0.03, 0.09, (0, -0.004, hz + 0.1), p["leaf"], verts=12),
        cone(0.03, 0.0, 0.07, (0, -0.02, hz + 0.175), p["leaf"], rot=(math.radians(-25), 0, 0), verts=10),
        ball(0.016, (0, -0.036, hz + 0.205), p["gamber"], segs=8, rings=5),
        ball(0.016, (-0.085, 0, hz), p["amber"], scale=(0.5, 1, 1), segs=8, rings=4),
        ball(0.016, (0.085, 0, hz), p["amber"], scale=(0.5, 1, 1), segs=8, rings=4),
    ]
    make_child(root, "head", head, (0, 0, 0.28))

    can = [
        ball(0.026, (0.104, 0.0, 0.22), p["ceramic"], segs=8, rings=5),
        cyl(0.013, 0.08, (0.13, 0.03, 0.19), p["metal"], rot=(math.radians(50), math.radians(25), 0), verts=8),
        ball(0.022, (0.15, 0.065, 0.16), p["ceramic"], segs=8, rings=5),
    ] + watering_can(p, (0.165, 0.09, 0.115))
    make_child(root, "can", can, (0.104, 0.0, 0.22))
    return root


def animate_gnome(root):
    head = bpy.data.objects[f"{root.name}_head"]
    can = bpy.data.objects[f"{root.name}_can"]
    keys = {
        head: [(1, (0, 0, 0)), (13, (math.radians(-6), math.radians(8), math.radians(10))), (25, (0, 0, 0)),
               (37, (math.radians(5), math.radians(-6), math.radians(-12))), (49, (0, 0, 0))],
        can: [(1, (0, 0, 0)), (16, (math.radians(28), 0, 0)), (30, (math.radians(30), 0, 0)), (44, (0, 0, 0)),
              (49, (0, 0, 0))],
    }
    for obj, ks in keys.items():
        obj.rotation_mode = "XYZ"
        for f, rot in ks:
            obj.rotation_euler = rot
            obj.keyframe_insert("rotation_euler", frame=f)
        obj.rotation_euler = (0, 0, 0)
        act = obj.animation_data.action
        act.name = f"gnome_bot_idle_{obj.name}"
        track = obj.animation_data.nla_tracks.new()
        track.name = "gnome_bot_idle"
        track.strips.new("gnome_bot_idle", 1, act)
        obj.animation_data.action = None
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 49
    bpy.context.scene.render.fps = 24


def prop_watering_drone(p):
    shell = lathe([(0, -0.035), (0.06, -0.034), (0.11, -0.016), (0.12, 0.0), (0.11, 0.018), (0.07, 0.034), (0, 0.045)],
                  [p["ceramic"], p["gamber"]], seg=16, bands=[0, 0, 1, 1, 0, 0], name="dr_shell")
    parts = [
        shell,
        ball(0.03, (0, 0, -0.04), p["gamber"], scale=(1, 1, 0.55), segs=12, rings=6),
        ball(0.05, (0, -0.02, -0.055), p["blue"], scale=(1, 1, 0.75), segs=12, rings=6),
        cone(0.012, 0.006, 0.05, (0, 0.03, -0.1), p["metal"], verts=6),
        cyl(0.012, 0.035, (0, 0, 0.06), p["metal"], verts=8),
        # face plate with two mint eyes on the front
        ball(0.05, (0, 0.088, 0.008), p["ink"], scale=(1, 0.35, 0.55), segs=12, rings=6),
        ball(0.009, (-0.018, 0.105, 0.01), p["gmint"], scale=(1, 0.5, 1.2), segs=6, rings=4),
        ball(0.009, (0.018, 0.105, 0.01), p["gmint"], scale=(1, 0.5, 1.2), segs=6, rings=4),
    ]
    for s in (-1, 1):
        parts.append(ball(0.03, (s * 0.12, 0, 0.0), p["mint"], scale=(0.45, 1, 0.45), segs=8, rings=5))
    root = make_root("watering_drone", parts)
    blade = [(0.012, -0.012), (0.12, -0.022), (0.13, 0.0), (0.12, 0.018), (0.012, 0.012)]
    prop = [cyl(0.018, 0.016, (0, 0, 0.082), p["amber"], verts=10)]
    for a in (0, math.pi):
        prop.append(flat_shape(blade, p["ceramic"], thick=0.004,
                               transform=Matrix.Translation((0, 0, 0.082)) @ Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(math.radians(10), 4, "X")))
    make_child(root, "prop", prop, (0, 0, 0.082))
    return root


# ---- garden props ----------------------------------------------------------------------------------------------------

def prop_sprinkler(p):
    parts = [
        cone(0.004, 0.012, 0.06, (0, 0, 0.0), p["metal"], verts=6),
        cyl(0.04, 0.02, (0, 0, 0.012), p["ceramic"], verts=12),
        cyl(0.018, 0.08, (0, 0, 0.06), p["ceramic"], verts=10),
        cyl(0.022, 0.012, (0, 0, 0.05), p["mint"], verts=10),
    ]
    root = make_root("sprinkler", parts)
    head = [cyl(0.014, 0.02, (0, 0, 0.11), p["metal"], verts=8),
            ball(0.012, (0, 0, 0.122), p["blue"], segs=8, rings=5)]
    for s in (-1, 1):
        head.append(cyl(0.005, 0.07, (s * 0.035, 0, 0.115), p["metal"], rot=(0, math.radians(90), 0), verts=6))
        head.append(cone(0.008, 0.004, 0.02, (s * 0.072, s * 0.006, 0.12), p["blue"], rot=(math.radians(-90 * s), 0, 0), verts=6))
    make_child(root, "head", head, (0, 0, 0.11))
    return root


def prop_beehive(p):
    parts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(box((0.04, 0.04, 0.42), (sx * 0.15, sy * 0.15, 0.21), p["wood"], rot=(sy * 0.06, -sx * 0.06, 0)))
    parts.append(box((0.42, 0.42, 0.04), (0, 0, 0.44), p["woodlight"], bevel=0.008))
    parts.append(box((0.3, 0.025, 0.025), (0, 0.15, 0.12), p["wood"]))
    parts.append(box((0.3, 0.025, 0.025), (0, -0.15, 0.12), p["wood"]))
    # skep: ribbed straw-coloured dome in amber and cream bands
    prof, bands = [], []
    n = 7
    for i in range(n + 1):
        t = i / n
        r = 0.18 * math.cos(t * math.pi * 0.47) + 0.012
        z = 0.46 + 0.36 * math.sin(t * math.pi * 0.5) ** 0.9
        prof.append((r, z))
        prof.append((r - 0.01, z + 0.02))
        bands += [0, 1 if i % 2 else 0]
    prof.append((0, 0.86))
    parts.append(lathe(prof[:-2] + [prof[-1]], [p["amber"], p["woodlight"]], seg=14, bands=bands, name="skep"))
    parts.append(ball(0.03, (0, 0, 0.86), p["amber"], segs=8, rings=5))
    # entrance and a small landing board
    parts.append(ball(0.045, (0, 0.17, 0.5), p["ink"], scale=(1, 0.4, 0.7), segs=10, rings=5))
    parts.append(box((0.12, 0.06, 0.012), (0, 0.2, 0.465), p["woodlight"]))
    # a mint ceramic name plate
    parts.append(ball(0.03, (0, 0.165, 0.66), p["mint"], scale=(1.3, 0.3, 0.8), segs=10, rings=5))
    return make_root("beehive", parts)


def prop_windchime(p):
    parts = [
        cone(0.05, 0.035, 0.03, (0, 0, 0.015), p["stone"], verts=8),
        cyl(0.012, 1.2, (0, 0, 0.62), p["metal"], verts=8),
    ]
    # hook: short arc over the top to +X
    pts = []
    for i in range(7):
        a = math.pi * i / 6
        pts.append((0.1 - 0.1 * math.cos(a), 1.22 + 0.1 * math.sin(a)))
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        mid = ((x0 + x1) / 2, 0, (z0 + z1) / 2)
        ln = math.hypot(x1 - x0, z1 - z0)
        ang = math.atan2(x1 - x0, z1 - z0)
        parts.append(cyl(0.011, ln + 0.006, mid, p["metal"], rot=(0, ang, 0), verts=8))
    parts.append(ball(0.016, (0.2, 0, 1.22), p["amber"], segs=8, rings=5))
    root = make_root("windchime", parts)
    hang = (0.2, 0, 1.2)
    ch = [
        cyl(0.0015, 0.06, (0.2, 0, 1.17), p["ink"], verts=4),
        cyl(0.06, 0.016, (0.2, 0, 1.135), p["ceramic"], verts=12),
        ball(0.012, (0.2, 0, 1.15), p["amber"], segs=8, rings=4),
    ]
    mats = [p["mint"], p["blue"], p["violet"], p["mint"], p["amber"]]
    for i in range(5):
        a = 2 * math.pi * i / 5
        x, y = 0.2 + math.cos(a) * 0.042, math.sin(a) * 0.042
        ln = 0.22 - i * 0.025
        ch.append(cyl(0.0012, 0.02, (x, y, 1.12), p["ink"], verts=3))
        ch.append(cyl(0.008, ln, (x, y, 1.11 - ln / 2), mats[i], verts=8))
    ch.append(cyl(0.0012, 0.2, (0.2, 0, 1.03), p["ink"], verts=3))
    ch.append(cyl(0.02, 0.01, (0.2, 0, 1.0), p["ceramic"], verts=10))
    leaf = [(0, 0.0), (0.035, -0.04), (0.02, -0.09), (0, -0.11), (-0.02, -0.09), (-0.035, -0.04)]
    ch.append(flat_shape(list(reversed(leaf)), p["gmint"], thick=0.004,
                         transform=Matrix.Translation((0.2, 0, 0.93)) @ Matrix.Rotation(math.radians(90), 4, "X")))
    make_child(root, "chimes", ch, hang)
    return root


def prop_stepping_stone(p):
    ring = hex_ring(0.2, 10, 0, jitter=0.12, seed=3)
    prof_top = [(x * 0.92, y * 0.92) for x, y in ring]
    verts = [(x, y, 0.0) for x, y in ring] + [(x, y, 0.04) for x, y in ring] + [(x, y, 0.05) for x, y in prof_top]
    n = len(ring)
    faces = [tuple(reversed(range(n)))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
        faces.append((n + i, n + j, 2 * n + j, 2 * n + i))
    faces.append(tuple(range(2 * n, 3 * n)))
    stone = mesh_obj("stone", verts, faces, p["stone"], smooth_shade=False)
    parts = [stone]
    rnd = random.Random(8)
    for i in range(4):
        a = rnd.uniform(0, 2 * math.pi)
        parts.append(ball(0.04, (math.cos(a) * 0.19, math.sin(a) * 0.19, 0.012), p["moss"], scale=(1.4, 1, 0.35), segs=8, rings=4,
                          rot=(0, 0, a)))
    return make_root("stepping_stone", parts)


def prop_log(p):
    L, R = 0.9, 0.13
    log = cyl(R, L, (0, 0, R * 0.92), p["wood"], rot=(0, math.radians(90), 0), verts=10)
    parts = [log]
    for s in (-1, 1):
        parts.append(cyl(R * 0.9, 0.012, (s * (L / 2 + 0.004), 0, R * 0.92), p["woodlight"], rot=(0, math.radians(90), 0), verts=10, flat=True))
        parts.append(cyl(R * 0.45, 0.014, (s * (L / 2 + 0.006), 0, R * 0.92), p["wood"], rot=(0, math.radians(90), 0), verts=8, flat=True))
    parts.append(ball(0.2, (-0.1, 0, R * 1.75), p["moss"], scale=(1.6, 0.6, 0.25), segs=12, rings=5))
    parts.append(ball(0.1, (0.28, 0.02, R * 1.72), p["moss"], scale=(1.2, 0.8, 0.3), segs=10, rings=4))
    parts.append(ball(0.07, (0.15, R * 0.85, R * 0.9), p["moss"], scale=(1.4, 0.4, 1.0), segs=8, rings=4))
    # branch stub
    parts.append(cyl(0.04, 0.12, (0.15, -0.09, R * 1.5), p["wood"], rot=(math.radians(50), 0, 0), verts=8))
    parts.append(cyl(0.034, 0.01, (0.15, -0.136, R * 1.5 + 0.04), p["woodlight"], rot=(math.radians(50), 0, 0), verts=8, flat=True))
    parts += mushroom(p, (-0.3, 0.1, R * 1.7), 0.05, 0.03, p["gmush"], p["violet"], p["ceramic"], tilt=math.radians(-10), seg=8)
    parts += mushroom(p, (-0.24, 0.13, R * 1.6), 0.035, 0.02, p["gmush"], p["violet"], p["ceramic"], tilt=math.radians(15), seg=8)
    parts += grass_tuft(p, (0.4, 0.12, 0), n=4, h=0.08, seed=9)
    parts += grass_tuft(p, (-0.35, -0.13, 0), n=4, h=0.07, seed=10)
    return make_root("log", parts)


def flower(p, loc, petal_mat, r=0.03, center_mat=None, seed=0):
    x, y, z = loc
    rnd = random.Random(seed)
    tilt = (rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), 0)
    parts = [cyl(0.004, z - 0.12, (x, y, (z + 0.12) / 2), p["leaf"], verts=4)]
    for i in range(5):
        a = 2 * math.pi * i / 5 + rnd.uniform(0, 0.3)
        parts.append(ball(r * 0.55, (x + math.cos(a) * r * 0.6, y + math.sin(a) * r * 0.6, z), petal_mat,
                          scale=(1, 0.6, 0.25), segs=5, rings=3, rot=(0, 0, a)))
    parts.append(ball(r * 0.35, (x, y, z + 0.004), center_mat or p["gamber"], scale=(1, 1, 0.6), segs=6, rings=4))
    return parts


def prop_planter_box(p):
    W, D, H = 0.8, 0.32, 0.28
    parts = [
        box((W, D, H - 0.04), (0, 0, 0.04 + (H - 0.04) / 2), p["ceramic"], bevel=0.02, segs=2),
        box((W + 0.02, D + 0.02, 0.035), (0, 0, H - 0.01), p["ceramic"], bevel=0.012, segs=2),
        box((W + 0.004, D + 0.004, 0.03), (0, 0, 0.12), p["mint"], bevel=0.01, segs=1),
        box((W - 0.04, D - 0.04, 0.02), (0, 0, H + 0.0), p["soil"]),
    ]
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(box((0.06, 0.06, 0.04), (sx * (W / 2 - 0.05), sy * (D / 2 - 0.05), 0.02), p["woodlight"], bevel=0.008))
    rnd = random.Random(12)
    for i in range(9):
        x = -W / 2 + 0.07 + i * (W - 0.14) / 8 + rnd.uniform(-0.02, 0.02)
        y = rnd.uniform(-0.07, 0.07)
        parts.append(ball(0.055, (x, y, H + 0.04), p["leaf"], scale=(1, 0.8, 0.8), segs=7, rings=4))
    colors = [p["violet"], p["amber"], p["ceramic"], p["blue"], p["violet"], p["amber"], p["mint"]]
    for i, c in enumerate(colors):
        x = -W / 2 + 0.09 + i * (W - 0.18) / (len(colors) - 1) + rnd.uniform(-0.02, 0.02)
        y = rnd.uniform(-0.06, 0.06)
        z = H + rnd.uniform(0.15, 0.24)
        parts += flower(p, (x, y, z), c, r=0.046, center_mat=p["ceramic"] if c is p["amber"] else p["gamber"], seed=i)
    return make_root("planter_box", parts)


def prop_bench(p):
    L, seat = 1.3, 0.44
    parts = []
    for s in (-1, 1):
        x = s * (L / 2 - 0.05)
        parts.append(box((0.09, 0.46, seat - 0.02), (x, 0, (seat - 0.02) / 2), p["ceramic"], bevel=0.03, segs=2))
        parts.append(box((0.11, 0.5, 0.05), (x, 0.0, seat + 0.17), p["ceramic"], bevel=0.02, segs=2))
        parts.append(box((0.07, 0.07, 0.2), (x, 0.17, seat + 0.07), p["ceramic"], bevel=0.02, segs=2))
        parts.append(box((0.08, 0.06, 0.55), (x, -0.2, seat + 0.2), p["ceramic"], rot=(math.radians(-10), 0, 0), bevel=0.02, segs=2))
        parts.append(cyl(0.035, 0.012, (x + s * 0.046, 0.0, seat * 0.5), p["gmint"], rot=(0, math.radians(90), 0), verts=12, flat=True))
        parts.append(box((0.1, 0.48, 0.03), (x, 0, 0.015), p["mint"], bevel=0.008))
    for i in range(4):
        y = 0.16 - i * 0.1
        parts.append(box((L - 0.12, 0.085, 0.035), (0, y, seat), p["woodlight"], bevel=0.008))
    for i in range(3):
        z = seat + 0.14 + i * 0.12
        y = -0.2 - (z - seat) * math.tan(math.radians(10)) + 0.04
        parts.append(box((L - 0.12, 0.03, 0.085), (0, y, z), p["woodlight"], rot=(math.radians(-10), 0, 0), bevel=0.008))
    # a cushion and a tiny potted sprout for coziness
    parts.append(box((0.32, 0.3, 0.06), (-0.3, 0.02, seat + 0.05), p["violet"], bevel=0.025, segs=2))
    parts.append(cone(0.05, 0.065, 0.08, (0.4, 0.06, seat + 0.058), p["amber"], verts=10))
    parts.append(ball(0.045, (0.4, 0.06, seat + 0.13), p["leaf"], segs=8, rings=5))
    return make_root("bench", parts)


# ---- export + preview ------------------------------------------------------------------------------------------------

def export(roots):
    bpy.ops.object.select_all(action="DESELECT")
    for r in roots:
        r.select_set(True)
        for c in r.children_recursive:
            c.select_set(True)
    bpy.context.view_layer.objects.active = roots[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "decor.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
        export_texcoords=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_frame_range=False,
        export_force_sampling=True,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=True,
    )
    print(f"EXPORTED {path} ({Path(path).stat().st_size / 1024:.0f} KB)")


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def render_preview(roots):
    # Lay everything out: props in a back row, critters enlarged x3 in front.
    props = [r for r in roots if r.name[6:] not in FLYERS]
    critters = [r for r in roots if r.name[6:] in FLYERS]
    widths = {"bench": 1.4, "planter_box": 0.9, "log": 1.0, "beehive": 0.5, "windchime": 0.45, "stepping_stone": 0.45,
              "gnome_bot": 0.35, "watering_drone": 0.35, "sprinkler": 0.2, "mushroom_a": 0.25, "mushroom_b": 0.25}
    order = ["windchime", "beehive", "bench", "gnome_bot", "watering_drone", "planter_box", "log", "mushroom_a",
             "mushroom_b", "sprinkler", "stepping_stone"]
    gap = 0.18
    total = sum(widths[n] for n in order) + gap * (len(order) - 1)
    x = -total / 2
    by = {r.name[6:]: r for r in props}
    for n in order:
        r = by[n]
        r.location = (x + widths[n] / 2, 0.3 if n in ("bench", "planter_box", "log", "beehive", "windchime") else 0.9, 0)
        if n == "watering_drone":
            r.location.z = 0.45
        r.rotation_euler = (0, 0, math.radians(-20))
        x += widths[n] + gap
    by["stepping_stone"].location = (by["stepping_stone"].location.x, 1.0, 0)
    xs = [-1.6, -0.8, 0.0, 0.8, 1.6]
    for r, cx in zip(critters, xs):
        r.scale = (3, 3, 3)
        r.location = (cx, 1.7, 0.3)
        r.rotation_euler = (0, 0, math.radians(-25))
    for name in ("butterfly", "dragonfly", "bee", "firefly"):
        for side in ("wingL", "wingR"):
            o = bpy.data.objects.get(f"Decor_{name}_{side}")
            if o:
                o.rotation_euler = (0, math.radians(-25 if side == "wingL" else 25), 0)

    scene = bpy.context.scene
    scene.frame_set(13)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 2000, 900
    world = bpy.data.worlds.new("PrevWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (*srgb("#F3E9DA"), 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    scene.world = world
    scene.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in scene.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
    cam = bpy.data.objects.new("PrevCam", bpy.data.cameras.new("PrevCam"))
    cam.data.lens = 28
    bpy.context.collection.objects.link(cam)
    cam.location = (0.0, 7.4, 2.6)
    look_at(cam, (0.0, 0.9, 0.38))
    scene.camera = cam
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.color = (1.0, 0.9, 0.75)
    sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(150))
    bpy.context.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(plain("PrevGround", "#9CC97E", rough=0.9))
    scene.render.filepath = str(PREVIEW / "decor_preview.png")
    bpy.ops.render.render(write_still=True)
    print(f"PREVIEW {scene.render.filepath}")
    # Close-up of the critters and the gnome bot for checking detail.
    cam.data.lens = 50
    cam.location = (0.0, 4.6, 1.3)
    look_at(cam, (0.0, 1.5, 0.32))
    scene.render.resolution_x, scene.render.resolution_y = 1600, 700
    scene.render.filepath = str(PREVIEW / "decor_preview_close.png")
    bpy.ops.render.render(write_still=True)
    print(f"PREVIEW {scene.render.filepath}")


def build_all():
    clear_scene()
    p = palette()
    builders = [
        ("butterfly", critter_butterfly), ("firefly", critter_firefly), ("bird", critter_bird), ("bee", critter_bee),
        ("dragonfly", critter_dragonfly), ("mushroom_a", prop_mushroom_a), ("mushroom_b", prop_mushroom_b),
        ("gnome_bot", prop_gnome_bot), ("watering_drone", prop_watering_drone), ("sprinkler", prop_sprinkler),
        ("beehive", prop_beehive), ("windchime", prop_windchime), ("stepping_stone", prop_stepping_stone),
        ("log", prop_log), ("planter_box", prop_planter_box), ("bench", prop_bench),
    ]
    roots = []
    for name, fn in builders:
        r = fn(p)
        roots.append(r)
        dims = []
        objs = [r] + list(r.children_recursive)
        pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
        size = [max(v[i] for v in pts) - min(v[i] for v in pts) for i in range(3)]
        kids = ", ".join(c.name for c in r.children)
        print(f"ROOT {r.name}: {tree_tris(r)} tris, size {size[0]:.3f} x {size[1]:.3f} x {size[2]:.3f} m"
              + (f", children: {kids}" if kids else ""))
    animate_gnome(bpy.data.objects["Decor_gnome_bot"])
    export(roots)
    if PREVIEW:
        render_preview(roots)


build_all()
