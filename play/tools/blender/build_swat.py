"""
Builds the Last Light SWAT operator (survivor.glb) in Blender.

    blender --background --factory-startup --python build_swat.py -- <output-dir> [preview-dir] [standin]

Assembles the part files from tools/blender/swat/out/ (swat_body / swat_head / swat_torso / swat_limbs .blend, see
docs-swat-brief.md) when they exist; any part that is missing (or all of them with `standin`) is replaced by the
modelled pieces in this file.

Reference: the character sheet in the hotel concept art (front / back / side / 3-4, helmet, plate carrier, glove and
boot details). Modelling, in order:
  1. An athletic body graph (Skin modifier) gives the uniform's base shape; a slightly smaller copy is the collider.
  2. The combat uniform is draped over it with Blender's cloth simulation (shrink + gravity, pinned at the shoulders,
     belt line, cuffs and boot tops), then elbow, knee and waist compression folds are carved in.
  3. Hard-surface gear with bevels and booleans: high-cut helmet (rails, NVG shroud, mount and flipped-up tubes, ear
     protection, chin strap), goggles, balaclava head, plate carrier with laser-cut MOLLE, rifle mag pouches with
     bungee tops, admin panel, radio with antenna and PTT cable, cummerbund, battle belt, drop-leg holster with a
     pistol, hard knee pads, gloves with five fingers and knuckle armour, boots with soles, laces and toe caps.
  4. Everything is weighted to the shared skeleton, then one 2048 atlas is baked in Cycles: albedo (material colour,
     edge wear from pointiness, ambient occlusion multiplied in), tangent normals (weave, webbing, stitching, knit,
     leather grain) and roughness.
The skeleton, bone names, clips (idle, walk, run, downed, reload), hold poses and GRIP come from build_zombies.py, so
the game's grip point (models.ts) and animations keep working. The player colour material `Team` is only a small
armband and the helmet patches.
"""

import importlib.util
import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("bz", HERE / "build_zombies.py")
bz = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bz)

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/zombies")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 and ARGS[1] != "standin" else None
bz.OUT = OUT

S = 1.02
ATLAS = 2048
material, prim, box, cyl, join, apply_all, activate, smooth, link, tris = (
    bz.material, bz.prim, bz.box, bz.cyl, bz.join, bz.apply_all, bz.activate, bz.smooth, bz.link, bz.tris)


def P(x, y, z):
    return Vector((x * S, y * S, z * S))


# ---- materials --------------------------------------------------------------------------------------------------------

def palette():
    return {
        "team": material("Team", (0.8, 0.8, 0.8), rough=0.7, spec=0.35),
        "uniform": material("Uniform", (0.0137, 0.0176, 0.0319), rough=0.86, spec=0.3),
        "gear": material("Gear", (0.034, 0.034, 0.036), rough=0.66, spec=0.4),
        "strap": material("Strap", (0.024, 0.024, 0.026), rough=0.58, spec=0.4),
        "polymer": material("Polymer", (0.03, 0.03, 0.032), rough=0.42, spec=0.45),
        "helmet": material("Helmet", (0.016, 0.016, 0.017), rough=0.78, spec=0.3),
        "rubber": material("Rubber", (0.02, 0.02, 0.02), rough=0.9, spec=0.3),
        "leather": material("Leather", (0.022, 0.021, 0.02), rough=0.48, spec=0.5),
        "glove": material("Glove", (0.028, 0.028, 0.03), rough=0.62, spec=0.4),
        "balaclava": material("Balaclava", (0.03, 0.03, 0.032), rough=0.95, spec=0.25),
        "lens": material("Lens", (0.8, 0.82, 0.85), rough=0.04, spec=1.0),
        "metal": material("GearMetal", (0.07, 0.07, 0.075), rough=0.35, metal=0.85),
        "brass": material("Buckle", (0.32, 0.24, 0.12), rough=0.4, metal=0.8),
        "eyes": material("SurvivorEyes", (0.05, 0.045, 0.04), rough=0.05),
    }


# ---- material library (reference sheet samples: nylon, ripstop, rubber, metal, polymer) --------------------------------
#
# Every material of the assembled operator (ours or a part file's, e.g. `Head_Helmet`, `Torso_Pouch`) is mapped to a
# category by name; the category sets the base colour (unless the material is textured, e.g. the SWAT patches), the
# baked bump detail, the roughness range and the edge wear. All detail is fine-scale (barely visible at full-body
# distance): ripstop is a ~5 mm grid, nylon a dense weave.

CATEGORY_KEYS = [
    ("Team", ("team",)),
    ("Lens", ("lens", "glass", "visor_clear")),
    ("Patch", ("patch", "swat", "label", "cross", "text")),
    ("Balaclava", ("balaclava", "mask", "knit")),
    ("Skin", ("skin", "face", "eye", "brow", "lid", "body_base")),
    ("Uniform", ("uniform", "shirt", "trouser", "pant", "sleeve", "collar", "cuff", "combat", "ripstop", "cloth")),
    ("Helmet", ("helmet", "shell")),
    ("Glove", ("glove",)),
    ("Rubber", ("sole", "rubber", "cushion", "bungee", "cord", "goggle", "tread")),
    ("Leather", ("boot", "leather", "shoe")),
    ("GearMetal", ("metal", "screw", "eyelet", "rivet", "antenna_tip", "steel")),
    ("Buckle", ("buckle", "clip", "brass")),
    ("Polymer", ("polymer", "holster", "pistol", "knee", "radio", "headset", "mic", "cup", "rail", "nvg", "mount", "shroud", "plastic", "hard")),
    ("Strap", ("strap", "webbing", "molle", "belt")),
    ("Gear", ("nylon", "gear", "pouch", "carrier", "plate", "cummerbund", "vest", "pocket")),
]


def category(name):
    n = name.lower()
    for cat, keys in CATEGORY_KEYS:
        if any(k in n for k in keys):
            return cat
    return n.split("_")[0].title() if "_" in n else name


# Base colours per category (linear). Navy ripstop uniform (#1f2433), black nylon and polymer, white patches.
LIB_COLOR = {
    "Uniform": (0.0137, 0.0176, 0.0319), "Gear": (0.024, 0.024, 0.026), "Strap": (0.019, 0.019, 0.021),
    "Polymer": (0.021, 0.021, 0.023), "Helmet": (0.016, 0.016, 0.018), "Rubber": (0.015, 0.015, 0.016),
    "Leather": (0.019, 0.018, 0.018), "Glove": (0.02, 0.02, 0.022), "Balaclava": (0.018, 0.018, 0.02),
    "GearMetal": (0.1, 0.1, 0.105), "Buckle": (0.03, 0.03, 0.032), "Patch": (0.72, 0.72, 0.72), "Team": (0.8, 0.8, 0.8),
    "Skin": (0.42, 0.28, 0.22),
}
METAL = {"GearMetal": 0.85}

# Bump layers per category: (strength, distance, [(kind, scale, detail, weight)]); see bake().
DETAIL = {
    "Patch": (0.15, 0.001, [("noise", 400, 3, 0.6)]),
    "Skin": (0.12, 0.0015, [("noise", 300, 6, 0.6), ("noise", 40, 3, 0.3)]),
    "Team": (0.35, 0.003, [("wave", 300, 0, 0.15), ("waveb", 300, 0, 0.15), ("noise", 8, 2, 0.5)]),
    "Uniform": (0.12, 0.0015, [("grid", 200, 0, 0.12), ("wave", 3200, 0, 0.05), ("waveb", 3200, 0, 0.05), ("noise", 6, 2, 0.7)]),
    "Gear": (0.12, 0.0015, [("wave", 2400, 0, 0.12), ("waveb", 2400, 0, 0.12), ("noise", 10, 2, 0.6)]),
    "Strap": (0.15, 0.0015, [("wave", 2600, 0, 0.6), ("noise", 20, 2, 0.3)]),
    "Polymer": (0.3, 0.002, [("noise", 140, 4, 0.6), ("noise", 15, 2, 0.3)]),
    "Helmet": (0.12, 0.0015, [("noise", 300, 5, 0.7), ("noise", 10, 2, 0.3)]),
    "Rubber": (0.6, 0.003, [("noise", 60, 6, 0.7), ("voronoi", 18, 0, 0.4)]),
    "Leather": (0.5, 0.002, [("voronoi", 160, 0, 0.6), ("noise", 70, 6, 0.4), ("noise", 9, 2, 0.4)]),
    "Glove": (0.55, 0.002, [("voronoi", 120, 0, 0.5), ("wave", 300, 0, 0.2), ("noise", 50, 4, 0.4)]),
    "Balaclava": (0.12, 0.0015, [("wave", 2600, 0, 0.4), ("noise", 45, 3, 0.4)]),
    "Lens": (0.02, 0.001, [("noise", 4, 1, 1.0)]),
    "GearMetal": (0.2, 0.001, [("noise", 140, 4, 1.0)]),
    "Buckle": (0.2, 0.001, [("noise", 140, 4, 1.0)]),
    "SurvivorEyes": (0.05, 0.001, [("noise", 50, 2, 1.0)]),
}

# Roughness per material: (low, high, noise scale).
ROUGH = {
    "Team": (0.6, 0.8, 12), "Uniform": (0.8, 0.95, 8), "Gear": (0.8, 0.93, 10), "Strap": (0.72, 0.86, 14),
    "Polymer": (0.55, 0.72, 20), "Helmet": (0.72, 0.86, 14), "Rubber": (0.85, 0.97, 20), "Leather": (0.45, 0.65, 18),
    "Glove": (0.48, 0.7, 16), "Balaclava": (0.9, 1.0, 10), "Lens": (0.03, 0.08, 6), "GearMetal": (0.25, 0.45, 30),
    "Buckle": (0.3, 0.5, 30), "SurvivorEyes": (0.05, 0.1, 6), "Patch": (0.6, 0.8, 20), "Skin": (0.4, 0.6, 30),
}
# Edge wear brightens convex edges of hard materials a little (scuffed nylon, chipped polymer, worn leather).
WEAR = {"Gear": 0.22, "Polymer": 0.5, "Helmet": 0.18, "Leather": 0.45, "Glove": 0.25, "Strap": 0.15, "Rubber": 0.15, "GearMetal": 0.8, "Buckle": 0.6}


# ---- helpers ----------------------------------------------------------------------------------------------------------

def frame_box(size, center, axes, mat, bevel=0.004):
    """A box oriented by the three unit axes (x, y, z columns)."""
    o = box(size, (0, 0, 0), mat, bevel=bevel)
    o = apply_all(o)
    m = Matrix((axes[0], axes[1], axes[2])).transposed().to_4x4()
    m.translation = center
    o.data.transform(m)
    return o


def baked(o):
    """Applies location/rotation/scale so vertex coordinates are world coordinates."""
    o = apply_all(o)
    activate(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o


def flat_band(center, radius, height, mat, thick=0.004):
    """A flat strap around a limb: an open short cylinder with thickness (not a rope torus)."""
    o = baked(prim("cyl", mat, loc=tuple(center), radius=radius, depth=height, vertices=32))
    bz.delete_faces(o, lambda c, n: abs(n.z) > 0.9)
    return smooth(solidify(o, thick))


def mesh_obj(name, verts, faces, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([Vector(v) for v in verts], [], faces)
    me.update()
    o = link(bpy.data.objects.new(name, me))
    o.data.materials.append(mat)
    return o


def tube(name, pts, radius, mat, res=6):
    """A curve through `pts` with a round bevel, converted to a mesh (cables, cords, laces)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = 2
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (*p, 1.0)
    sp.use_smooth = True
    o = link(bpy.data.objects.new(name, cu))
    cu.materials.append(mat)
    o = apply_all(o)
    return smooth(o)


def smooth_curve(pts, n=8):
    """Catmull-Rom resample of a polyline."""
    pts = [Vector(p) for p in pts]
    out = []
    for i in range(len(pts) - 1):
        p0 = pts[max(0, i - 1)]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[min(len(pts) - 1, i + 2)]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(pts[-1])
    return out


def boolean(target, cutter, op="DIFFERENCE"):
    m = target.modifiers.new("Bool", "BOOLEAN")
    m.operation = op
    m.object = cutter
    m.solver = "EXACT"
    target = apply_all(target)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return target


def bevel_mod(obj, width, segments=2, angle=40):
    m = obj.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(angle)
    return apply_all(obj)


def solidify(obj, t, offset=1.0):
    m = obj.modifiers.new("Solid", "SOLIDIFY")
    m.thickness = t
    m.offset = offset
    return apply_all(obj)


# ---- body and uniform -------------------------------------------------------------------------------------------------

def body_graph(k=1.0):
    """Athletic body: (verts, edges, radii). k scales the radii (collider vs cloth)."""
    v, e, r = [], [], []

    def node(p, rad, parent=None):
        v.append(tuple(c * S for c in p))
        r.append(tuple(x * S * k for x in rad) if isinstance(rad, tuple) else rad * S * k)
        if parent is not None:
            e.append((parent, len(v) - 1))
        return len(v) - 1

    pelvis = node((0, -0.005, 0.9), (0.19, 0.138))
    hips = node((0, 0.0, 0.98), (0.192, 0.136), pelvis)
    waist = node((0, 0.004, 1.08), (0.178, 0.128), hips)
    lower = node((0, 0.006, 1.2), (0.196, 0.138), waist)
    chest = node((0, 0.01, 1.32), (0.218, 0.148), lower)
    upper = node((0, 0.0, 1.41), (0.232, 0.136), chest)
    neck0 = node((0, 0.0, 1.47), (0.075, 0.075), upper)
    node((0, 0.012, 1.55), (0.06, 0.064), neck0)
    for x in (-1, 1):
        sh = node((x * 0.175, 0.0, 1.415), (0.09, 0.09), upper)
        a1 = node((x * 0.25, 0.0, 1.31), (0.086, 0.082), sh)
        el = node((x * 0.33, 0.004, 1.17), (0.07, 0.07), a1)
        fa = node((x * 0.385, 0.016, 1.07), (0.064, 0.06), el)
        node((x * 0.432, 0.028, 0.965), (0.047, 0.043), fa)
        th = node((x * 0.098, 0.0, 0.92), (0.125, 0.122), pelvis)
        t2 = node((x * 0.105, 0.006, 0.72), (0.112, 0.112), th)
        kn = node((x * 0.11, 0.01, 0.51), (0.088, 0.09), t2)
        ca = node((x * 0.115, -0.006, 0.34), (0.084, 0.086), kn)
        node((x * 0.12, -0.016, 0.19), (0.072, 0.074), ca)
    return v, e, r


def drape(cloth, collider, frames=30, shrink=0.05, pin=None):
    """Runs Blender's cloth simulation on `cloth` over `collider` for `frames` frames and applies the result."""
    scene = bpy.context.scene
    col = collider.modifiers.new("Collision", "COLLISION")
    collider.collision.thickness_outer = 0.004
    collider.collision.cloth_friction = 6.0
    mod = cloth.modifiers.new("Cloth", "CLOTH")
    s = mod.settings
    s.quality = 6
    s.mass = 0.2
    s.air_damping = 2.0
    s.tension_stiffness = 14
    s.compression_stiffness = 14
    s.shear_stiffness = 8
    s.bending_stiffness = 0.25
    s.shrink_min = shrink
    if pin:
        s.vertex_group_mass = pin
        s.pin_stiffness = 2.0
    mod.collision_settings.use_collision = True
    mod.collision_settings.distance_min = 0.003
    mod.collision_settings.use_self_collision = False
    mod.point_cache.frame_start = 1
    mod.point_cache.frame_end = frames
    scene.frame_start = 1
    scene.frame_end = frames
    for f in range(1, frames + 1):
        scene.frame_set(f)
    activate(cloth)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    scene.frame_set(1)
    collider.modifiers.remove(col)
    return cloth


def build_uniform(p):
    v, e, r = body_graph(1.0)
    cloth = bz.skin_mesh("Survivor_Body", v, e, r, subsurf=2, mats=[p["uniform"]])
    v2, e2, r2 = body_graph(0.86)
    collider = bz.skin_mesh("collider", v2, e2, r2, subsurf=1)
    # Pin where the fabric is held: shoulders and collar, the belt line, the cuffs, the boot tops.
    pin = cloth.vertex_groups.new(name="pin")
    wrists = [P(x * 0.432, 0.028, 0.965) for x in (-1, 1)]
    for vv in cloth.data.vertices:
        c = vv.co
        w = 0.0
        if c.z > 1.37 * S and abs(c.x) < 0.24 * S:
            w = 1.0
        elif 0.95 * S < c.z < 1.0 * S:
            w = 1.0
        elif c.z < 0.22 * S:
            w = 1.0
        elif min((c - wv).length for wv in wrists) < 0.045:
            w = 1.0
        if w:
            pin.add([vv.index], w, "REPLACE")
    drape(cloth, collider, pin="pin")
    bpy.data.objects.remove(collider, do_unlink=True)
    if "pin" in cloth.vertex_groups:
        cloth.vertex_groups.remove(cloth.vertex_groups["pin"])
    # Compression folds: rings around the elbows and knees, horizontal ripples above the belt, a bunched blouse above
    # the boots.
    joints = []
    for x in (-1, 1):
        joints.append((P(x * 0.33, 0.004, 1.17), (P(x * 0.385, 0.016, 1.07) - P(x * 0.25, 0, 1.31)).normalized(), 0.07, 0.006, 150))
        joints.append((P(x * 0.11, 0.01, 0.51), Vector((0, 0, 1)), 0.08, 0.007, 120))
        joints.append((P(x * 0.12, -0.016, 0.24), Vector((0, 0, 1)), 0.06, 0.008, 160))
    rnd = random.Random(7)
    phase = [rnd.random() * 6.28 for _ in joints]

    def folds(co, n):
        off = 0.0
        for i, (c, axis, rad, amp, freq) in enumerate(joints):
            d = co - c
            if d.length > rad * 2.2:
                continue
            along = d.dot(axis)
            g = math.exp(-(d.length / rad) ** 2)
            ang = math.atan2(d.cross(axis).dot(Vector((0, 0, 1))), d.dot(Vector((1, 0, 0))) + 1e-6)
            off += amp * g * math.sin(along * freq + phase[i] + 1.6 * math.sin(ang * 3 + phase[i]))
        z = co.z / S
        if 1.0 < z < 1.12:
            off += 0.004 * math.exp(-((z - 1.03) / 0.035) ** 2) * math.sin(z * 260 + co.x * 30)
        return n * off

    bz.push_verts(cloth, folds)
    # Seams: a sunken line down the outside of each trouser leg and sleeve, and around the shoulders.
    for vv in cloth.data.vertices:
        c = vv.co
        if c.z < 0.94 * S and abs(abs(c.x) - (0.105 * S + 0.0)) < 0.2 and abs(c.y) < 0.006 and abs(c.x) > 0.15 * S:
            vv.co -= vv.normal * 0.0025
    smooth(cloth)
    cargo = []
    for x in (-1, 1):
        # Cargo pocket with a flap and two pleats on each thigh; a small pocket on each shin.
        cargo += [
            box((0.03, 0.14, 0.15), P(x * 0.225, 0.006, 0.665), p["uniform"], bevel=0.018),
            box((0.026, 0.145, 0.03), P(x * 0.233, 0.006, 0.745), p["uniform"], bevel=0.01),
            box((0.024, 0.006, 0.13), P(x * 0.235, 0.04, 0.665), p["uniform"], bevel=0.002),
            box((0.024, 0.006, 0.13), P(x * 0.235, -0.028, 0.665), p["uniform"], bevel=0.002),
            box((0.022, 0.08, 0.08), P(x * 0.19, 0.02, 0.36), p["uniform"], bevel=0.012),
            # Sleeve pockets on the upper arm (reference: shoulder pocket with velcro).
            frame_box((0.022, 0.09, 0.1), P(x * 0.33, 0.0, 1.29), (Vector((1, 0, 0)).lerp(Vector((math.copysign(0.5, x), 0, 0.86)), 0.0), Vector((0, 1, 0)), Vector((0, 0, 1))), p["uniform"], bevel=0.01),
            # Cuffs with hook-and-loop tabs.
            bz.prim("torus", p["uniform"], loc=tuple(P(x * 0.428, 0.027, 0.975)), rot=(0, math.radians(x * -22), 0), major_radius=0.049 * S, minor_radius=0.012, major_segments=20, minor_segments=6),
            box((0.02, 0.03, 0.022), P(x * 0.462, 0.03, 0.985), p["strap"], rot=(0, math.radians(x * -22), 0), bevel=0.004),
        ]
    # Shirt collar (mock neck) under the balaclava.
    cargo.append(bz.prim("torus", p["uniform"], loc=tuple(P(0, 0.005, 1.5)), major_radius=0.07 * S, minor_radius=0.018, major_segments=24, minor_segments=6))
    return cloth, cargo


# ---- hands -----------------------------------------------------------------------------------------------------------

def glove(p, x):
    """A gloved hand with five jointed fingers closed around a grip, built on the hand bone's rest frame."""
    head, tail = bz.JOINT[f"hand.{'R' if x > 0 else 'L'}"]
    head, tail = head * S, tail * S
    down = (tail - head).normalized()
    inward = Vector((-x, 0, 0))
    inward = (inward - down * inward.dot(down)).normalized()
    fwd = down.cross(inward) * (-x)
    if fwd.y < 0:
        fwd = -fwd
    v, e, r = [], [], []

    def node(pt, rad, parent=None):
        v.append(tuple(pt))
        r.append(rad)
        if parent is not None:
            e.append((parent, len(v) - 1))
        return len(v) - 1

    wrist = node(head, (0.03, 0.026))
    palm = node(head + down * 0.05, (0.036, 0.018), wrist)
    fingers = [(0.031, 0.05, 0.0105), (0.011, 0.054, 0.011), (-0.009, 0.051, 0.0105), (-0.027, 0.043, 0.0095)]
    for spread, length, rad in fingers:
        base = node(head + down * 0.092 + fwd * spread, (rad * 1.15, rad), palm)
        dirv = down.copy()
        pt = Vector(v[base])
        parent = base
        for seg, (frac, curl) in enumerate(((0.5, 60), (0.3, 55), (0.24, 40))):
            # Curl each segment towards the palm.
            rot = Matrix.Rotation(math.radians(curl), 3, fwd.cross(down).normalized() * (1 if x > 0 else -1))
            dirv = (rot @ dirv).normalized()
            if dirv.dot(inward) < 0 and seg == 0:
                dirv = (Matrix.Rotation(math.radians(-2 * curl), 3, fwd.cross(down).normalized() * (1 if x > 0 else -1)) @ down).normalized()
            pt = pt + dirv * length * frac
            parent = node(pt, rad * (1.0 - 0.1 * seg), parent)
    # Thumb from the base of the palm, forwards and around.
    tb = node(head + down * 0.03 + fwd * 0.028 + inward * 0.01, 0.014, wrist)
    t1 = node(Vector(v[tb]) + (fwd * 0.6 + down * 0.6 + inward * 0.3).normalized() * 0.035, 0.012, tb)
    t2 = node(Vector(v[t1]) + (fwd * 0.2 + down * 0.6 + inward * 0.8).normalized() * 0.028, 0.0105, t1)
    node(Vector(v[t2]) + (down * 0.4 + inward * 0.9).normalized() * 0.022, 0.0095, t2)
    hand = bz.skin_mesh(f"Survivor_Glove{x}", v, e, r, subsurf=2, mats=[p["glove"]], root=wrist)
    hand = bz.decimate(hand, 0.4)
    # Knuckle armour plate across the back of the hand, finger guards on the first segments, a padded palm and the
    # wrist strap with a tab.
    back = -inward
    parts = [hand]
    parts.append(frame_box((0.022, 0.07, 0.03), head + down * 0.083 + back * 0.014 + fwd * 0.003, (back, fwd, down), p["polymer"], bevel=0.009))
    for spread, length, rad in fingers:
        parts.append(frame_box((0.012, 0.02, 0.022), head + down * 0.112 + fwd * spread + back * 0.008, (back, fwd, down), p["polymer"], bevel=0.005))
    parts.append(bz.prim("torus", p["glove"], loc=tuple(head + down * 0.006), rot=tuple(down.to_track_quat("Z", "Y").to_euler()), major_radius=0.031, minor_radius=0.008, major_segments=18, minor_segments=5))
    parts.append(frame_box((0.008, 0.028, 0.022), head + down * 0.006 + back * 0.034, (back, fwd, down), p["strap"], bevel=0.003))
    return join(parts, f"Survivor_Glove{'R' if x > 0 else 'L'}")


# ---- head, helmet, goggles --------------------------------------------------------------------------------------------

def build_head(p):
    head = bz.head_mesh("Survivor_Head", {"skin": p["balaclava"], "blood": p["balaclava"], "eyes": p["eyes"]}, zombie=False)
    head = bz.decimate(head, 0.55)
    activate(head)
    head.scale = (S, S, S)
    bpy.ops.object.transform_apply(scale=True)
    eye_z = (bz.HEAD_C.z + 0.014) * S

    def band(radius, height, keep, mat, cy, thick, segs=56):
        o = baked(prim("cyl", mat, loc=(0, cy, eye_z), radius=radius, depth=height, vertices=segs))
        bz.delete_faces(o, lambda c, n: c.y < cy + keep or abs(n.z) > 0.9)
        o = solidify(o, thick)
        return smooth(o)

    frame = band(0.083, 0.054, 0.026, p["rubber"], 0.064 * S, 0.008)
    lens = band(0.087, 0.04, 0.03, p["lens"], 0.064 * S, 0.003)
    # A nose bridge notch: pull the lower middle of frame and lens up.
    for o in (frame, lens):
        for vv in o.data.vertices:
            if abs(vv.co.x) < 0.02 and vv.co.z < eye_z - 0.012:
                vv.co.z += 0.012 * (1 - abs(vv.co.x) / 0.02)
    strap = bz.prim("torus", p["strap"], loc=(0, bz.HEAD_C.y * S, eye_z + 0.006), scale=(0.97, 1.2, 1.0), major_radius=0.09, minor_radius=0.008, major_segments=36, minor_segments=5)
    vents = [box((0.012, 0.004, 0.008), (sx * 0.05, 0.145, eye_z + 0.024), p["rubber"], bevel=0.001) for sx in (-1, 1)]
    return join([head, frame, lens, strap] + vents, "Survivor_Head")


def build_helmet(p):
    cz = 1.712 * S
    shell = baked(prim("sphere", p["helmet"], loc=(0, 0.018, cz), scale=(1.03, 1.13, 0.9), radius=0.132, segments=48, ring_count=24))
    # Flatten everything below the brim line, then cut the high-cut ear profile and the rear with booleans.
    brim = 1.67 * S
    for vv in shell.data.vertices:
        if vv.co.z < brim:
            vv.co.z = brim + (vv.co.z - brim) * 0.12
    # High cut: the shell stops above the ears (a sloped line from the brow to behind the ear).
    for vv in shell.data.vertices:
        c = vv.co
        if abs(c.x) > 0.075 and -0.06 < c.y < 0.09:
            lim = 1.705 * S + 0.12 * max(0.0, c.y - 0.02) - 0.1 * min(0.0, c.y + 0.02)
            if c.z < lim:
                c.z = lim + (c.z - lim) * 0.1
    shell = solidify(shell, 0.011, offset=-1.0)
    shell = bevel_mod(shell, 0.003, segments=2, angle=50)
    smooth(shell)
    parts = [shell]
    for sx in (-1, 1):
        # Side rails (ARC style) with slots and screws, following the shell.
        rail = box((0.012, 0.15, 0.022), (sx * 0.134, 0.012, 1.708 * S), p["polymer"], rot=(math.radians(-6), 0, math.radians(sx * 3)), bevel=0.003)
        rail = apply_all(rail)
        for k in range(5):
            slot = box((0.03, 0.012, 0.007), (sx * 0.14, -0.045 + k * 0.028, 1.707 * S), p["polymer"], rot=(math.radians(-6), 0, 0), bevel=0)
            rail = boolean(rail, apply_all(slot))
        parts.append(rail)
        for k in (-1, 1):
            parts.append(cyl(0.0055, 0.006, (sx * 0.141, 0.012 + k * 0.06, 1.71 * S), p["metal"], rot=(0, math.radians(90), 0), verts=10))
        # Ear protection: cup, cushion, a small side box and the headband arching under the shell.
        parts += [
            cyl(0.043, 0.032, (sx * 0.097, 0.012, 1.655 * S), p["polymer"], rot=(0, math.radians(90), 0), verts=24),
            cyl(0.037, 0.012, (sx * 0.08, 0.012, 1.655 * S), p["rubber"], rot=(0, math.radians(90), 0), verts=20),
            box((0.012, 0.03, 0.02), (sx * 0.116, 0.028, 1.64 * S), p["polymer"], bevel=0.004),
            box((0.012, 0.014, 0.075), (sx * 0.1, 0.012, 1.705 * S), p["strap"], bevel=0.003),
        ]
        # Chin strap from the shell down under the jaw.
        a = Vector((sx * 0.105, 0.04, 1.665 * S))
        b = Vector((sx * 0.07, 0.07, 1.585 * S))
        c = Vector((0, 0.085, 1.565 * S))
        parts.append(tube(f"chin{sx}", smooth_curve([a, b, c], 6), 0.004, p["strap"], res=4))
    # NVG shroud: a bevelled plate with three screws, the mount, the arm and the flipped-up binocular tubes.
    shroud = box((0.06, 0.02, 0.048), (0, 0.156, 1.752 * S), p["metal"], rot=(math.radians(-14), 0, 0), bevel=0.006)
    parts.append(shroud)
    for sx, sz in ((-0.02, 0.012), (0.02, 0.012), (0, -0.014)):
        parts.append(cyl(0.004, 0.004, (sx, 0.168, 1.752 * S + sz), p["metal"], rot=(math.radians(76), 0, 0), verts=8))
    parts += [
        box((0.036, 0.034, 0.03), (0, 0.18, 1.742 * S), p["polymer"], bevel=0.006),
        box((0.026, 0.05, 0.016), (0, 0.19, 1.77 * S), p["polymer"], rot=(math.radians(55), 0, 0), bevel=0.004),
        box((0.07, 0.03, 0.03), (0, 0.205, 1.795 * S), p["polymer"], bevel=0.006),
    ]
    for sx in (-1, 1):
        tube_o = cyl(0.016, 0.075, (sx * 0.024, 0.205, 1.83 * S), p["polymer"], rot=(math.radians(-12), 0, 0), verts=18)
        cap = cyl(0.017, 0.012, (sx * 0.024, 0.213, 1.868 * S), p["rubber"], rot=(math.radians(-12), 0, 0), verts=18)
        parts += [tube_o, cap]
    parts += [
        box((0.085, 0.045, 0.055), (0, -0.12, 1.722 * S), p["gear"], rot=(math.radians(-24), 0, 0), bevel=0.012),  # counterweight pouch
        box((0.08, 0.004, 0.04), (0, -0.142, 1.728 * S), p["strap"], rot=(math.radians(-24), 0, 0), bevel=0.001),
        box((0.052, 0.006, 0.032), (0, -0.147, 1.745 * S), p["team"], rot=(math.radians(-24), 0, 0), bevel=0.002),  # team patch
        box((0.006, 0.042, 0.028), (0.131, -0.035, 1.745 * S), p["team"], bevel=0.002),
        box((0.075, 0.08, 0.006), (0, -0.01, 1.817 * S), p["strap"], rot=(math.radians(-6), 0, 0), bevel=0.003),  # loop velcro on top
        box((0.05, 0.05, 0.005), (0.05, 0.06, 1.792 * S), p["strap"], rot=(math.radians(18), math.radians(18), 0), bevel=0.002),
        cyl(0.007, 0.012, (0.0, -0.13, 1.79 * S), p["rubber"], verts=10),  # strobe
    ]
    return join(parts, "Survivor_Helmet")


# ---- plate carrier, belt, holster -------------------------------------------------------------------------------------

def molle_panel(size, center, mat, rows, bend=0.0, facing=1):
    """A laser-cut panel: a slab with rows of slots cut through (booleans), optionally bent around the torso."""
    w, d, h = size
    slab = box(size, center, mat, bevel=0.018)
    slab = apply_all(slab)
    cutters = []
    cols = max(2, int(w / 0.038))
    for row in range(rows):
        z = center[2] + h / 2 - 0.03 - row * 0.032
        for c in range(cols):
            xx = center[0] - w / 2 + 0.02 + c * ((w - 0.04) / max(1, cols - 1))
            cutters.append(apply_all(box((0.026, d * 3, 0.008), (xx, center[1], z), mat, bevel=0)))
    if cutters:
        cut = join(cutters, "cut")
        slab = boolean(slab, cut)
    if bend:
        m = slab.modifiers.new("Bend", "SIMPLE_DEFORM")
        m.deform_method = "BEND"
        m.angle = bend * facing
        m.deform_axis = "Z"
        slab = apply_all(slab)
    return slab


def build_carrier(p):
    G, T, M = p["gear"], p["strap"], p["metal"]
    z = lambda h: h * S  # noqa: E731
    parts = [
        molle_panel((0.38, 0.065, 0.38), (0, 0.16, z(1.27)), G, rows=5),
        molle_panel((0.38, 0.065, 0.39), (0, -0.15, z(1.28)), G, rows=6),
        box((0.16, 0.05, 0.12), (0, 0.168, z(1.035)), G, rot=(math.radians(6), 0, 0), bevel=0.02),  # groin flap
        box((0.13, 0.08, 0.06), (0, 0.112, z(1.5)), G, rot=(math.radians(-32), 0, 0), bevel=0.02),  # throat collar
    ]
    # Cummerbund: curved side panels with MOLLE, wrapping from the front plate to the back plate.
    for sx in (-1, 1):
        cb = baked(prim("cyl", G, loc=(0, 0.0, z(1.2)), radius=0.228, depth=0.19, vertices=48))
        bz.delete_faces(cb, lambda c, n, sx=sx: c.x * sx < 0.12 or abs(n.z) > 0.9)
        cb = solidify(cb, 0.018)
        for k in range(4):
            cb = boolean(cb, apply_all(box((0.06, 0.03, 0.008), (sx * 0.2, -0.06 + k * 0.04, z(1.24)), G, rot=(0, 0, math.radians(90)), bevel=0)))
        parts.append(smooth(cb))
        # Shoulder straps with a padded sleeve and a small buckle.
        parts += [
            box((0.075, 0.31, 0.032), (sx * 0.105, 0.008, z(1.462)), G, rot=(0, math.radians(sx * 8), 0), bevel=0.012),
            box((0.085, 0.13, 0.034), (sx * 0.11, 0.07, z(1.448)), T, rot=(math.radians(12), math.radians(sx * 8), 0), bevel=0.012),
            box((0.03, 0.012, 0.03), (sx * 0.11, 0.14, z(1.395)), p["brass"], bevel=0.004),
        ]
    # Three rifle mag pouches: open tops, the mags showing, bungee cords with pull tabs.
    for k, px in enumerate((-0.085, 0.0, 0.085)):
        pouch = box((0.09, 0.06, 0.13), (px * 1.12, 0.238, z(1.165)), G, bevel=0.014)
        pouch = apply_all(pouch)
        pouch = boolean(pouch, apply_all(box((0.07, 0.04, 0.05), (px * 1.12, 0.238, z(1.235)), G, bevel=0.0)))
        mag = box((0.066, 0.03, 0.075), (px * 1.12, 0.238, z(1.22)), p["polymer"], rot=(math.radians(4), 0, 0), bevel=0.004)
        cord = bz.prim("torus", p["rubber"], loc=(px * 1.12, 0.238, z(1.258)), scale=(1.0, 0.45, 0.25), major_radius=0.036, minor_radius=0.004, major_segments=20, minor_segments=5)
        tab = box((0.024, 0.006, 0.026), (px * 1.12, 0.266, z(1.26)), T, bevel=0.002)
        parts += [pouch, mag, cord, tab]
    # Two pistol mag pouches and a tourniquet pouch above, the admin panel with a zip at the top of the chest.
    for px in (-0.05, 0.05):
        parts.append(box((0.045, 0.034, 0.075), (px, 0.222, z(1.31)), G, bevel=0.012))
        parts.append(box((0.049, 0.038, 0.022), (px, 0.224, z(1.348)), G, rot=(math.radians(-8), 0, 0), bevel=0.008))  # flap
    parts += [
        box((0.14, 0.04, 0.095), (0.0, 0.214, z(1.405)), G, bevel=0.016),
        box((0.144, 0.044, 0.026), (0.0, 0.216, z(1.448)), G, rot=(math.radians(-6), 0, 0), bevel=0.01),  # flap
        box((0.12, 0.006, 0.006), (0.0, 0.241, z(1.445)), M, bevel=0.001),
        box((0.014, 0.008, 0.02), (0.05, 0.243, z(1.44)), M, bevel=0.002),
        box((0.1, 0.004, 0.045), (0.0, 0.241, z(1.4)), T, bevel=0.002),  # name-tape velcro
    ]
    # Radio on the left shoulder side: pouch, radio body, knobs, antenna; PTT cable to a button on the chest.
    rx, ry, rz = -0.232, 0.07, z(1.3)
    parts += [
        box((0.055, 0.06, 0.16), (rx, ry, rz), G, bevel=0.012),
        box((0.045, 0.048, 0.11), (rx, ry + 0.004, rz + 0.07), p["polymer"], bevel=0.006),
        cyl(0.008, 0.014, (rx + 0.008, ry, rz + 0.132), p["rubber"], verts=12),
        cyl(0.006, 0.012, (rx - 0.012, ry + 0.012, rz + 0.13), p["metal"], verts=10),
    ]
    antenna = [Vector((rx - 0.01, ry - 0.005, rz + 0.13)), Vector((rx - 0.015, ry - 0.02, rz + 0.22)), Vector((rx - 0.03, ry - 0.05, rz + 0.3))]
    parts.append(tube("antenna", smooth_curve(antenna, 4), 0.0035, p["rubber"]))
    ptt = Vector((-0.075, 0.244, z(1.36)))
    cable = [Vector((rx + 0.005, ry + 0.03, rz + 0.12)), Vector((rx + 0.04, ry + 0.09, rz + 0.16)), Vector((-0.13, 0.19, z(1.43))), Vector((-0.1, 0.23, z(1.4))), ptt]
    parts.append(tube("ptt_cable", smooth_curve(cable, 6), 0.0032, p["rubber"]))
    parts += [box((0.034, 0.02, 0.046), ptt + Vector((0, 0.008, 0)), p["polymer"], bevel=0.006), cyl(0.009, 0.006, ptt + Vector((0, 0.02, 0)), p["rubber"], rot=(math.radians(90), 0, 0), verts=12)]
    # Back: hydration carrier with MOLLE, two pouches, a drag handle.
    parts += [
        molle_panel((0.28, 0.06, 0.26), (0, -0.228, z(1.25)), G, rows=4),
        box((0.1, 0.05, 0.12), (-0.08, -0.27, z(1.11)), G, bevel=0.015),
        box((0.1, 0.05, 0.12), (0.08, -0.27, z(1.11)), G, bevel=0.015),
        bz.prim("torus", T, loc=(0, -0.205, z(1.47)), rot=(math.radians(90), 0, 0), scale=(1.0, 1.0, 0.6), major_radius=0.042, minor_radius=0.009, major_segments=16, minor_segments=5),
    ]
    # Battle belt: padded belt, inner belt, cobra-style buckle, pouches, a dump pouch.
    parts += [
        bz.prim("torus", T, loc=(0, 0.004, z(0.968)), scale=(1.0, 0.75, 1.0), major_radius=0.2, minor_radius=0.026, major_segments=40, minor_segments=8),
        bz.prim("torus", G, loc=(0, 0.004, z(0.94)), scale=(1.0, 0.74, 0.6), major_radius=0.196, minor_radius=0.012, major_segments=40, minor_segments=6),
        box((0.06, 0.022, 0.04), (0, 0.16, z(0.968)), p["brass"], bevel=0.006),
        box((0.03, 0.026, 0.024), (0, 0.168, z(0.968)), M, bevel=0.004),
        box((0.06, 0.05, 0.08), (-0.18, 0.09, z(0.95)), G, rot=(0, 0, math.radians(-40)), bevel=0.012),
        box((0.055, 0.045, 0.09), (-0.212, -0.02, z(0.95)), G, rot=(0, 0, math.radians(-80)), bevel=0.012),
        box((0.14, 0.05, 0.1), (0, -0.162, z(0.95)), G, bevel=0.02),
    ]
    return join(parts, "Survivor_Vest")


def build_holster(p):
    """Drop-leg holster on the right thigh with a pistol: hanger from the belt, platform, holster shell, two straps."""
    x = 1
    G, T = p["gear"], p["strap"]
    parts = [
        box((0.05, 0.03, 0.12), P(x * 0.205, 0.0, 0.89), G, bevel=0.01),
        box((0.03, 0.09, 0.19), P(x * 0.222, 0.0, 0.775), G, rot=(0, math.radians(6), 0), bevel=0.012),
        box((0.045, 0.075, 0.17), P(x * 0.246, 0.008, 0.765), p["polymer"], rot=(0, math.radians(6), 0), bevel=0.012),
        box((0.038, 0.034, 0.075), P(x * 0.244, -0.012, 0.875), p["polymer"], rot=(math.radians(-14), math.radians(6), 0), bevel=0.008),  # pistol grip
        box((0.04, 0.05, 0.02), P(x * 0.244, 0.006, 0.86), p["metal"], rot=(0, math.radians(6), 0), bevel=0.004),  # slide end
        box((0.045, 0.02, 0.06), P(x * 0.249, 0.044, 0.84), p["polymer"], rot=(math.radians(-20), math.radians(6), 0), bevel=0.006),  # retention hood
    ]
    for zz, rr in ((0.81, 0.122), (0.69, 0.112)):
        parts.append(flat_band(P(x * 0.106, 0.004, zz), rr * S, 0.032, T))
        parts.append(box((0.02, 0.012, 0.03), P(x * 0.06, 0.11, zz), p["brass"], bevel=0.004))
    return join(parts, "Survivor_Holster")


# ---- knees and boots --------------------------------------------------------------------------------------------------

def knee_pad(p, x):
    c = P(x * 0.112, 0.074, 0.505)
    shell = baked(prim("sphere", p["polymer"], loc=tuple(c), scale=(0.72, 0.3, 0.86), radius=0.105, segments=28, ring_count=16))
    bz.delete_faces(shell, lambda cc, n: cc.y < c.y - 0.005)
    shell = solidify(shell, 0.008)
    shell = smooth(bevel_mod(shell, 0.002, 1, 60))
    parts = [
        shell,
        box((0.05, 0.01, 0.016), c + Vector((0, 0.03, 0.02)), p["rubber"], bevel=0.004),
        box((0.05, 0.01, 0.016), c + Vector((0, 0.028, -0.025)), p["rubber"], bevel=0.004),
    ]
    return join(parts, f"Survivor_Knee{'R' if x > 0 else 'L'}")


def boot(p, x):
    v = [P(x * 0.12, -0.016, 0.27), P(x * 0.12, -0.02, 0.12), P(x * 0.12, -0.065, 0.055), P(x * 0.12, 0.06, 0.05), P(x * 0.121, 0.16, 0.042)]
    e = [(0, 1), (1, 2), (1, 3), (3, 4)]
    r = [(0.058, 0.06), (0.052, 0.056), (0.042, 0.04), (0.05, 0.042), (0.045, 0.03)]
    upper = bz.skin_mesh(f"Survivor_Boot{x}", [tuple(q) for q in v], e, r, subsurf=2, mats=[p["leather"]], root=0)
    # Flatten the bottom onto the sole.
    for vv in upper.data.vertices:
        if vv.co.z < 0.03:
            vv.co.z = 0.03
    parts = [upper]
    sole = box((0.112, 0.31, 0.034), P(x * 0.121, 0.045, 0.017), p["rubber"], bevel=0.012)
    sole = apply_all(sole)
    # Tread lugs: grooves across the sole.
    lugs = [apply_all(box((0.13, 0.008, 0.012), P(x * 0.121, -0.09 + k * 0.025, 0.0), p["rubber"], bevel=0)) for k in range(11)]
    sole = boolean(sole, join(lugs, "lugs"))
    parts.append(sole)
    parts += [
        prim("sphere", p["rubber"], loc=tuple(P(x * 0.121, 0.165, 0.045)), scale=(1.05, 0.9, 0.62), radius=0.05, segments=20, ring_count=10),  # toe cap
        box((0.1, 0.09, 0.03), P(x * 0.121, -0.07, 0.05), p["rubber"], bevel=0.012),  # heel counter
        bz.prim("torus", p["leather"], loc=tuple(P(x * 0.12, -0.016, 0.275)), major_radius=0.058 * S, minor_radius=0.014, major_segments=22, minor_segments=6),  # padded collar
    ]
    # Laces: a zig-zag cord over the tongue from the instep up the shaft, with metal eyelets.
    lace = []
    for k in range(8):
        t = k / 7
        yy = 0.1 - t * 0.12
        zz = 0.075 + t * 0.18
        side = 0.024 if k % 2 == 0 else -0.024
        lace.append(P(x * 0.12 + side, yy + 0.045 - 0.02 * t, zz))
        parts.append(cyl(0.004, 0.004, P(x * 0.12 + 0.026, yy + 0.043 - 0.02 * t, zz), p["metal"], rot=(0, math.radians(90), 0), verts=8))
        parts.append(cyl(0.004, 0.004, P(x * 0.12 - 0.026, yy + 0.043 - 0.02 * t, zz), p["metal"], rot=(0, math.radians(90), 0), verts=8))
    parts.append(tube(f"lace{x}", lace, 0.0028, p["strap"]))
    parts.append(box((0.04, 0.03, 0.17), P(x * 0.12, 0.03, 0.16), p["leather"], rot=(math.radians(-28), 0, 0), bevel=0.012))  # tongue
    return join(parts, f"Survivor_Boot{'R' if x > 0 else 'L'}")


def armband(p, x):
    band = bz.prim("torus", p["team"], loc=tuple(P(x * 0.262, 0.0, 1.29)), rot=(0, math.radians(x * -50), 0), scale=(1.0, 1.0, 1.7), major_radius=0.088, minor_radius=0.008, major_segments=24, minor_segments=6)
    patch = box((0.012, 0.07, 0.05), P(x * 0.33, 0.0, 1.24), p["team"], rot=(0, math.radians(x * -40), 0), bevel=0.004)
    return join([band, patch], "Survivor_Armband")


def fitted_armband(p, arm, sleeve):
    """The Team band around the left upper arm, sized to the actual sleeve: a flat band just outside the cloth."""
    b = arm.data.bones["upperarm.L"]
    h = arm.matrix_world @ b.head_local
    t = arm.matrix_world @ b.tail_local
    axis = (t - h).normalized()
    c = h + (t - h) * 0.45
    rs = []
    for v in sleeve.data.vertices:
        q = sleeve.matrix_world @ v.co
        d = q - c
        along = d.dot(axis)
        if abs(along) < 0.025:
            radial = (d - axis * along).length
            if radial < 0.14:
                rs.append(radial)
    r = (sorted(rs)[int(len(rs) * 0.92)] if rs else 0.06) + 0.004
    o = baked(prim("cyl", p["team"], loc=tuple(c), radius=r, depth=0.028, vertices=32))
    bz.delete_faces(o, lambda cc, n: abs(n.z) > 0.9)
    o = smooth(solidify(o, 0.004))
    o.data.transform(Matrix.Translation(c) @ axis.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Translation(-c))
    o.name = "Survivor_Armband"
    return o


# ---- weights ----------------------------------------------------------------------------------------------------------

REGIONS = {
    "torso": ["hips", "spine", "chest", "neck", "head"],
    "armL": ["chest", "upperarm.L", "forearm.L", "hand.L"],
    "armR": ["chest", "upperarm.R", "forearm.R", "hand.R"],
    "legL": ["hips", "thigh.L", "shin.L", "foot.L"],
    "legR": ["hips", "thigh.R", "shin.R", "foot.R"],
}
REGION_OF = {"hips": "torso", "spine": "torso", "chest": "torso", "neck": "torso", "head": "torso"}
for _s in "LR":
    for _b in ("upperarm", "forearm", "hand"):
        REGION_OF[f"{_b}.{_s}"] = f"arm{_s}"
    for _b in ("thigh", "shin", "foot"):
        REGION_OF[f"{_b}.{_s}"] = f"leg{_s}"


def weight_by_region(obj, arm, power=5.0):
    """Each vertex picks a body region by its nearest bone, then gets inverse-distance weights among that region's
    bones only, so a sleeve near the hip never follows the hip."""
    names = [b[0] for b in bz.BONES if b[0] != "root"]
    segs = {n: (bz.JOINT[n][0] * S, bz.JOINT[n][1] * S) for n in names}
    groups = {n: obj.vertex_groups.new(name=n) for n in names}
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        nearest = min(names, key=lambda n: bz.seg_dist(p, *segs[n]))
        allowed = REGIONS[REGION_OF[nearest]]
        ds = sorted((bz.seg_dist(p, *segs[n]) + 1e-3, n) for n in allowed)[:3]
        ws = [(1.0 / d ** power, n) for d, n in ds]
        total = sum(w for w, _ in ws)
        for w, n in ws:
            if w / total > 0.02:
                groups[n].add([v.index], w / total, "REPLACE")
    obj.parent = arm
    m = obj.modifiers.new("Armature", "ARMATURE")
    m.object = arm
    return obj


# ---- baking -----------------------------------------------------------------------------------------------------------

def use_gpu():
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type == kind for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == kind
                    bpy.context.scene.cycles.device = "GPU"
                    print("CYCLES GPU", kind)
                    return
            except TypeError:
                continue
    except Exception as exc:  # noqa: BLE001
        print("GPU setup failed", exc)
    bpy.context.scene.cycles.device = "CPU"


def bake(meshes, size=ATLAS):
    """UV atlas for every part; bakes AO, albedo (with edge wear), normals and roughness; rewires the materials so
    the glTF exporter writes baseColor, normal and metallicRoughness textures."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    use_gpu()
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
        if not m.data.uv_layers:
            m.data.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.001, area_weight=0.7, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.0015, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    used = {mat for m in meshes for mat in m.data.materials if mat and category(mat.name) != "Lens"}
    for mat in used:
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        cat = category(mat.name)
        keep_tex = cat in ("Patch", "Skin", "SurvivorEyes", "Team") or mat.name.lower().endswith("eyes")
        if bsdf and cat in LIB_COLOR and bsdf.inputs["Base Color"].links and not keep_tex:
            for l in list(bsdf.inputs["Base Color"].links):
                mat.node_tree.links.remove(l)
        if bsdf and cat in LIB_COLOR and not bsdf.inputs["Base Color"].links:
            bsdf.inputs["Base Color"].default_value = (*LIB_COLOR[cat], 1.0)
            bsdf.inputs["Metallic"].default_value = METAL.get(cat, 0.0)
    # Clear ballistic lenses stay their own (unbaked) transparent material.
    for m in meshes:
        for mat in m.data.materials:
            if mat and category(mat.name) == "Lens":
                bsdf = mat.node_tree.nodes.get("Principled BSDF")
                bsdf.inputs["Base Color"].default_value = (0.8, 0.82, 0.85, 1.0)
                bsdf.inputs["Roughness"].default_value = 0.04
                bsdf.inputs["Alpha"].default_value = 0.22
                for out in ("Emission Strength",):
                    if out in bsdf.inputs:
                        bsdf.inputs[out].default_value = 0.0
                try:
                    mat.surface_render_method = "BLENDED"
                except AttributeError:
                    mat.blend_method = "BLEND"

    def new_img(name, s, data, fill):
        img = bpy.data.images.new(name, s, s, alpha=False, float_buffer=False, is_data=data)
        img.generated_color = fill
        if data:
            img.colorspace_settings.name = "Non-Color"
        return img

    def run(kind, img, setup, samples=2, **kw):
        temp = {}
        for mat in used:
            nt = mat.node_tree
            nodes = setup(mat, nt) or []
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = img
            nt.nodes.active = t
            temp[mat] = nodes + [t]
        scene.cycles.samples = samples
        bpy.ops.object.select_all(action="DESELECT")
        for m in meshes:
            m.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.bake(type=kind, margin=8, use_clear=True, **kw)
        for mat, nodes in temp.items():
            for n in nodes:
                mat.node_tree.nodes.remove(n)

    def emit(mat, nt, sock):
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].links else None
        em = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(sock, em.inputs["Color"])
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
        mat["_old"] = 1
        restore.append((nt, out, old))
        return em

    # AO.
    ao = new_img("SurvivorAO", size // 2, True, (1, 1, 1, 1))
    scene.render.bake.use_selected_to_active = False
    run("AO", ao, lambda mat, nt: [], samples=48)
    # Albedo: material colour x subtle large-scale variation, brightened on worn convex edges (pointiness).
    alb = new_img("SurvivorAlbedo", size, False, (0, 0, 0, 1))
    restore = []

    def albedo_setup(mat, nt):
        bsdf = nt.nodes.get("Principled BSDF")
        base = tuple(bsdf.inputs["Base Color"].default_value)[:3]
        linked = bsdf.inputs["Base Color"].links[0].from_socket if bsdf.inputs["Base Color"].links else None
        nodes = []

        def nn(kind, **props):
            n = nt.nodes.new(kind)
            for k, val in props.items():
                setattr(n, k, val)
            nodes.append(n)
            return n

        tc = nn("ShaderNodeTexCoord")
        nz = nn("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 4.0
        nz.inputs["Detail"].default_value = 3.0
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        mr = nn("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = 0.3
        mr.inputs["From Max"].default_value = 0.7
        mr.inputs["To Min"].default_value = 0.82
        mr.inputs["To Max"].default_value = 1.12
        nt.links.new(nz.outputs["Fac"], mr.inputs["Value"])
        col = nn("ShaderNodeVectorMath", operation="SCALE")
        if linked is not None:
            nt.links.new(linked, col.inputs[0])
        else:
            col.inputs[0].default_value = base
        nt.links.new(mr.outputs["Result"], col.inputs["Scale"])
        out_sock = col.outputs[0]
        wear = WEAR.get(category(mat.name), 0.0)
        if wear:
            geo = nn("ShaderNodeNewGeometry")
            wr = nn("ShaderNodeMapRange")
            wr.inputs["From Min"].default_value = 0.52
            wr.inputs["From Max"].default_value = 0.6
            wr.inputs["To Min"].default_value = 0.0
            wr.inputs["To Max"].default_value = wear
            nt.links.new(geo.outputs["Pointiness"], wr.inputs["Value"])
            grit = nn("ShaderNodeTexNoise")
            grit.inputs["Scale"].default_value = 60.0
            nt.links.new(tc.outputs["Object"], grit.inputs["Vector"])
            gm = nn("ShaderNodeMath", operation="MULTIPLY")
            nt.links.new(wr.outputs["Result"], gm.inputs[0])
            nt.links.new(grit.outputs["Fac"], gm.inputs[1])
            mix = nn("ShaderNodeMix", data_type="RGBA", blend_type="MIX")
            nt.links.new(gm.outputs[0], mix.inputs["Factor"])
            nt.links.new(out_sock, mix.inputs[6])
            mix.inputs[7].default_value = (0.13, 0.13, 0.135, 1.0)
            out_sock = mix.outputs[2]
        nodes.append(emit(mat, nt, out_sock))
        return nodes

    run("EMIT", alb, albedo_setup, samples=4)
    for nt, out, old in restore:
        if old:
            nt.links.new(old, out.inputs["Surface"])
    # AO into the albedo (numpy), at the albedo's resolution.
    ao.scale(size, size)
    a = np.empty(size * size * 4, dtype=np.float32)
    o = np.empty(size * size * 4, dtype=np.float32)
    alb.pixels.foreach_get(a)
    ao.pixels.foreach_get(o)
    a = a.reshape(-1, 4)
    o = o.reshape(-1, 4)
    a[:, :3] *= (0.3 + 0.7 * o[:, :1])
    alb.pixels.foreach_set(a.ravel())
    alb.pack()
    # Normals.
    nrm = new_img("SurvivorNormal", size, True, (0.5, 0.5, 1.0, 1.0))

    def normal_setup(mat, nt):
        bsdf = nt.nodes.get("Principled BSDF")
        strength, dist, layers = DETAIL.get(category(mat.name), (0.15, 0.0015, [("noise", 200, 4, 1.0)]))
        nodes = []
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nodes.append(tc)
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
            elif kind == "grid":
                t = nt.nodes.new("ShaderNodeTexBrick")
                t.inputs["Scale"].default_value = scale
                t.inputs["Mortar Size"].default_value = 0.04
                out = t.outputs["Fac"]
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
                ad = nt.nodes.new("ShaderNodeMath")
                ad.operation = "ADD"
                nt.links.new(total, ad.inputs[0])
                nt.links.new(mul.outputs[0], ad.inputs[1])
                total = ad.outputs[0]
                nodes.append(ad)
        bmp = nt.nodes.new("ShaderNodeBump")
        bmp.inputs["Strength"].default_value = strength
        bmp.inputs["Distance"].default_value = dist
        nt.links.new(total, bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], bsdf.inputs["Normal"])
        nodes.append(bmp)
        return nodes

    run("NORMAL", nrm, normal_setup, samples=2, normal_space="TANGENT")
    nrm.pack()
    # Roughness (G) and metalness (B), baked as emission.
    orm = new_img("SurvivorORM", size // 2, True, (1, 0.7, 0, 1))
    restore = []

    def rough_setup(mat, nt):
        bsdf = nt.nodes.get("Principled BSDF")
        lo, hi, scale = ROUGH.get(category(mat.name), (0.5, 0.8, 10))
        metal = bsdf.inputs["Metallic"].default_value
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
        cmb = nt.nodes.new("ShaderNodeCombineColor")
        cmb.inputs["Red"].default_value = 1.0
        nt.links.new(mr.outputs["Result"], cmb.inputs["Green"])
        cmb.inputs["Blue"].default_value = metal
        em = emit(mat, nt, cmb.outputs["Color"])
        return [tc, nz, mr, cmb, em]

    run("EMIT", orm, rough_setup, samples=2)
    for nt, out, old in restore:
        if old:
            nt.links.new(old, out.inputs["Surface"])
    orm.pack()
    for mat in used:
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        ta = nt.nodes.new("ShaderNodeTexImage")
        ta.image = alb
        nt.links.new(ta.outputs["Color"], bsdf.inputs["Base Color"])
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = nrm
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.space = "TANGENT"
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        tr = nt.nodes.new("ShaderNodeTexImage")
        tr.image = orm
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tr.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        for l in list(bsdf.inputs["Alpha"].links):
            nt.links.remove(l)
        bsdf.inputs["Alpha"].default_value = 1.0
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        for img in (alb, nrm, orm, ao):
            img.save(filepath=str(PREVIEW / f"{img.name}.png"))
    print("BAKED survivor maps")


# ---- build ------------------------------------------------------------------------------------------------------------

SWAT_OUT = HERE / "swat" / "out"
PART_FILES = {"body": "swat_body.blend", "head": "swat_head.blend", "torso": "swat_torso.blend", "limbs": "swat_limbs.blend"}
BONE_NAMES = [b[0] for b in bz.BONES]
BUDGET = 30000


def load_part(path):
    """Appends every object of a part file into this scene (applied transforms, final world positions per the
    brief). High-poly bake sources (custom property `high`) are dropped."""
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = list(src.objects)
    objs = [o for o in dst.objects if o is not None]
    for o in objs:
        if not o.users_collection:
            bpy.context.collection.objects.link(o)
    for o in list(objs):
        if o.get("high"):
            bpy.data.objects.remove(o, do_unlink=True)
            objs.remove(o)
    print("PART", path.name, [o.name for o in objs])
    return objs


def meshes_of(objs):
    out = []
    for o in objs:
        if o.type == "MESH":
            out.append(o)
        elif o.type in ("CURVE", "FONT", "SURFACE"):
            out.append(apply_all(o))
    for o in out:
        # Bake transforms into the mesh (part files should already have applied transforms).
        o.parent = None
        for m in list(o.modifiers):
            if m.type == "ARMATURE":
                o.modifiers.remove(m)
        activate(o)
        bpy.ops.object.convert(target="MESH")
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        o.data.validate(clean_customdata=False)
    return out


def has_weights(obj):
    return any(g.name in BONE_NAMES for g in obj.vertex_groups)


def transfer_weights(obj, src):
    """Copies bone weights from the nearest surface of the body (data transfer), so gear follows the skin under it."""
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    for name in BONE_NAMES:
        if name in src.vertex_groups:
            obj.vertex_groups.new(name=name)
    dt = obj.modifiers.new("Weights", "DATA_TRANSFER")
    dt.object = src
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    n = obj.name.lower()
    no_arms = (n.startswith("torso_") and "patch" not in n) or any(k in n for k in ("knee", "boot", "belt", "holster"))
    region_cleanup(obj, ARM_REF[0], no_arms)


ARM_REF = [None]


def region_cleanup(obj, arm, no_arms=False):
    """After a weight transfer, drops weights from bones outside each vertex's own body region (a hip pouch next to
    the A-posed hand must not follow the hand) and renormalises."""
    if arm is None:
        return
    segs = {b.name: (arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for b in arm.data.bones if b.name in REGION_OF}
    if no_arms:
        segs = {k: v for k, v in segs.items() if not REGION_OF[k].startswith("arm")}
    idx = {g.index: g.name for g in obj.vertex_groups}
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        nearest = min(segs, key=lambda n: bz.seg_dist(p, *segs[n]))
        allowed = set(REGIONS[REGION_OF[nearest]])
        ws = [(g.group, g.weight) for g in v.groups if idx.get(g.group) in REGION_OF]
        keep = [(gi, w) for gi, w in ws if idx[gi] in allowed]
        total = sum(w for _, w in keep)
        for gi, w in ws:
            g = obj.vertex_groups[idx[gi]]
            if idx[gi] not in allowed or total <= 0:
                g.remove([v.index])
            else:
                g.add([v.index], w / total, "REPLACE")
        if total <= 0:
            obj.vertex_groups[nearest].add([v.index], 1.0, "REPLACE")


RIGID = {"helmet": "head", "goggle": "head", "headset": "head", "nvg": "head", "shroud": "head", "mic": "head", "holster": "thigh.R", "pistol": "thigh.R"}


def bind(obj, arm, src):
    """Weights for one exported mesh: its own if it has bone groups, rigid for head gear, else from the body (or by
    region for the stand-in), then parented to the armature."""
    n = obj.name.lower()
    rigid = next((b for k, b in RIGID.items() if k in n), None)
    if rigid and not has_weights(obj):
        for g in list(obj.vertex_groups):
            obj.vertex_groups.remove(g)
        obj.vertex_groups.new(name=rigid).add([v.index for v in obj.data.vertices], 1.0, "REPLACE")
    elif not has_weights(obj):
        if src is not None:
            transfer_weights(obj, src)
        else:
            for g in list(obj.vertex_groups):
                obj.vertex_groups.remove(g)
            weight_by_region(obj, arm)
            return obj
    obj.parent = arm
    if not any(m.type == "ARMATURE" for m in obj.modifiers):
        m = obj.modifiers.new("Armature", "ARMATURE")
        m.object = arm
    return obj


def fit_budget(meshes, budget=BUDGET):
    """Decimates the densest meshes until the whole operator fits the triangle budget."""
    total = sum(tris(m) for m in meshes)
    if total <= budget:
        return meshes
    out = []
    keep = 1500  # small pieces are left alone
    big = sum(tris(m) for m in meshes if tris(m) > keep)
    small = total - big
    ratio = max(0.2, (budget - small) / max(1, big))
    for m in meshes:
        out.append(bz.decimate(m, ratio) if tris(m) > keep else m)
    return out


def standin_parts(p, need):
    """Our own modelled pieces for any part file that has not landed yet."""
    parts = {}
    if "body" in need:
        uniform, extras = build_uniform(p)
        parts["body"] = [bz.decimate(join([uniform] + extras, "Survivor_Body"), 0.85)]
    if "head" in need:
        parts["head"] = [build_head(p), bz.decimate(build_helmet(p), 0.55)]
    if "torso" in need:
        parts["torso"] = [bz.decimate(build_carrier(p), 0.55), build_holster(p)]
    if "limbs" in need:
        parts["limbs"] = [bz.decimate(glove(p, x), 0.75) for x in (-1, 1)] + [bz.decimate(knee_pad(p, x), 0.5) for x in (-1, 1)] + [bz.decimate(boot(p, x), 0.7) for x in (-1, 1)]
    return parts


def build():
    bz.clear_scene()
    random.seed(3)
    p = palette()
    # `standin` on the command line ignores the part files (our own modelled pieces only).
    found = {} if "standin" in ARGS else {k: SWAT_OUT / f for k, f in PART_FILES.items() if (SWAT_OUT / f).exists()}
    print("PARTS found:", sorted(found), "stand-ins:", sorted(set(PART_FILES) - set(found)))
    arm = None
    src = None  # weight source: the body (hidden or not) from the body part
    parts = {}
    if "body" in found:
        objs = load_part(found["body"])
        arm = next((o for o in objs if o.type == "ARMATURE"), None)
        meshes = [o for o in objs if o.type == "MESH"]
        # The bare body is only a weight source once the gear parts cover hands and head; the uniform is exported.
        bodies = [m for m in meshes if "body" in m.name.lower() and "uniform" not in m.name.lower()]
        src = max(bodies, key=lambda m: len(m.data.vertices)) if bodies else None
        export_body = [m for m in meshes if m is not src]
        if src is not None and not ({"head", "limbs"} <= set(found)):
            export_body.append(src)
            src_copy = src.copy()
            src_copy.data = src.data.copy()
            bpy.context.collection.objects.link(src_copy)
            src = src_copy
        parts["body"] = export_body
        for m in export_body:
            for mod in list(m.modifiers):
                if mod.type == "ARMATURE":
                    m.modifiers.remove(mod)
    if arm is None:
        arm = bz.build_armature("Survivor", S)
    ARM_REF[0] = arm
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    if arm.animation_data:
        arm.animation_data_clear()
    for k in ("head", "torso", "limbs"):
        if k in found:
            parts[k] = meshes_of(load_part(found[k]))
    # The head part brings its own face and eyes: drop the body's eyes. Brow cards are alpha-textured slivers behind
    # the goggles; an alpha texture would make the exporter write a separate multi-MB PNG, so they go too.
    if "head" in found and "body" in parts:
        for m in [m for m in parts["body"] if "eye" in m.name.lower()]:
            parts["body"].remove(m)
            bpy.data.objects.remove(m, do_unlink=True)
    if "head" in parts:
        for m in [m for m in parts["head"] if "brow" in m.name.lower()]:
            parts["head"].remove(m)
            bpy.data.objects.remove(m, do_unlink=True)
    parts.update(standin_parts(p, [k for k in PART_FILES if k not in parts]))
    meshes = [m for ms in parts.values() for m in ms]
    if not any(mat and mat.name == "Team" for m in meshes for mat in m.data.materials):
        sleeve = next((m for m in meshes if "shirt" in m.name.lower()), None)
        meshes.append(fitted_armband(p, arm, sleeve) if sleeve else armband(p, -1))
    print("PRE-BUDGET tris", sum(tris(m) for m in meshes))
    meshes = fit_budget(meshes)
    print("SURVIVOR tris", sum(tris(m) for m in meshes), [(m.name, tris(m)) for m in meshes])
    bake(meshes)
    for m in meshes:
        bind(m, arm, src)
    if src is not None and src.name not in [m.name for m in meshes]:
        bpy.data.objects.remove(src, do_unlink=True)
    bz.survivor_anims(arm)
    return arm, meshes


# ---- preview sheet ----------------------------------------------------------------------------------------------------

def preview_sheet(arm):
    """Cycles renders front / back / side / 3-4 in the idle pose on a dark studio floor, combined into one sheet."""
    if not PREVIEW:
        return
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    use_gpu()
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 520
    scene.render.resolution_y = 900
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    act = bpy.data.actions.get("idle")
    arm.animation_data_create()
    arm.animation_data.action = act
    try:
        if act.slots:
            arm.animation_data.action_slot = act.slots[0]
    except AttributeError:
        pass
    scene.frame_set(1)
    gun = []
    wpath = HERE.parent.parent / "frontend" / "public" / "models" / "zombies" / "weapons.glb"
    if wpath.exists():
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(wpath))
        new = [o for o in bpy.data.objects if o not in before]
        root = next((o for o in new if o.name == "m4a1"), None)
        for o in new:
            if root is None or (o is not root and root not in o.parents_recursive if hasattr(o, "parents_recursive") else False):
                pass
        keep = {root} | set(root.children_recursive) if root else set()
        for o in new:
            if o not in keep:
                bpy.data.objects.remove(o, do_unlink=True)
        if root:
            root.parent = None
            root.location = bz.GRIP
            root.rotation_euler = (0, 0, 0)
            root.rotation_mode = "XYZ"
            gun = [root] + list(root.children_recursive)
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.42, 0.43, 0.45, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world
    floor = prim("cube", material("Floor", (0.38, 0.385, 0.4), rough=0.7), loc=(0, 0, -0.05), scale=(8, 8, 0.1))
    lights = []
    for loc, energy, col, size in (((2.0, 2.5, 3.2), 420, (1.0, 0.97, 0.94), 2.5), ((-2.5, 1.5, 2.0), 220, (0.95, 0.97, 1.0), 3.0), ((0.5, -2.5, 2.6), 300, (1.0, 1.0, 1.0), 2.0)):
        ld = bpy.data.lights.new("key", "AREA")
        ld.energy = energy
        ld.color = col
        ld.size = size
        lo = link(bpy.data.objects.new("key", ld))
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 1.1)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        lights.append(lo)
    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 85
    cam = link(bpy.data.objects.new("cam", cam_d))
    scene.camera = cam
    files = []
    for name, ang in (("front", 0), ("back", 180), ("side", 90), ("34", 35)):
        a = math.radians(ang)
        cam.location = (math.sin(a) * 5.2, math.cos(a) * 5.2, 1.05)
        cam.rotation_euler = (Vector((0, 0, 0.95)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = str(PREVIEW / f"op_{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
    # Head close-up like the reference's helmet detail.
    cam.location = (0.55, 0.75, 1.78)
    cam.rotation_euler = (Vector((0, 0.02, 1.7)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.resolution_x = 700
    scene.render.resolution_y = 520
    scene.render.filepath = str(PREVIEW / "op_head.png")
    bpy.ops.render.render(write_still=True)
    # Sheet.
    imgs = [bpy.data.images.load(f) for f in files]
    w, h = imgs[0].size
    sheet = np.zeros((h, w * 4, 4), dtype=np.float32)
    for i, im in enumerate(imgs):
        px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
        sheet[:, i * w:(i + 1) * w] = px
    out = bpy.data.images.new("sheet", w * 4, h, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = str(PREVIEW / "op_sheet.png")
    out.file_format = "PNG"
    out.save()
    for o in [floor, cam] + lights + gun:
        bpy.data.objects.remove(o, do_unlink=True)


def report_bounds(meshes):
    """Debug: posed (evaluated) bounds of every mesh at the current frame; flags anything outside a person's box."""
    dg = bpy.context.evaluated_depsgraph_get()
    for m in meshes:
        ev = m.evaluated_get(dg)
        me = ev.to_mesh()
        if len(me.vertices):
            xs = [ev.matrix_world @ v.co for v in me.vertices]
            mn = [min(c[i] for c in xs) for i in range(3)]
            mx = [max(c[i] for c in xs) for i in range(3)]
            if max(mx[i] - mn[i] for i in range(3)) > 1.0 or mx[2] > 2.2 or mn[2] < -0.2:
                print("POSED-BIG", m.name, [round(x, 2) for x in mn], [round(x, 2) for x in mx])
        ev.to_mesh_clear()


def main():
    arm, meshes = build()
    bpy.context.scene.frame_set(1)
    report_bounds(meshes)
    bz.export("survivor", [arm], animations=True, skins=True, textures=True)
    preview_sheet(arm)


if __name__ == "__main__":
    main()
