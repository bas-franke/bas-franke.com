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
  4. Low poly, high detail (prepare_lows / bake): every assembled mesh keeps a full-detail copy as its bake source,
     MOLLE / velcro detail meshes are merged into the panels under them, and the exported meshes are reduced to
     BUDGET triangles (planar dissolve on hard gear, quadric collapse, more for head gear and gloves). One 4096 atlas
     is projected from the sources in Cycles (selected-to-active, cage from the measured deviation): albedo (material
     colour, weave / ripstop, cavities, edge wear, grime, AO multiplied in) and tangent normals (the source geometry
     plus weave, ripstop, webbing, knit and grain bump), roughness / metalness flat. Exported as per-map JPEGs
     (TEX_OUT); all baked materials collapse into one `Survivor` material, `Team` and the lenses stay separate, and
     the weighted pieces are joined into one skinned mesh.
The skeleton, bone names, clips (idle, walk, run, downed, reload), hold poses and GRIP come from build_zombies.py, so
the game's grip point (models.ts) and animations keep working. The player colour material `Team` is only a small
armband and the helmet patches.
"""

import importlib.util
import math
import random
import sys
import tempfile
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("bz", HERE / "build_zombies.py")
bz = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bz)

try:
    sys.stdout.reconfigure(line_buffering=True)  # progress lines reach a redirected log while the bake runs
except AttributeError:
    pass
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/zombies")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 and ARGS[1] != "standin" else None
bz.OUT = OUT

S = 1.02
ATLAS = 4096  # bake resolution; the exported maps are TEX_OUT
# Exported maps: (size, JPEG quality). The albedo keeps the full bake, the normal map is box-filtered down (that also
# anti-aliases the procedural weave), roughness / metalness is low frequency.
TEX_OUT = {"albedo": (4096, 88), "normal": (2048, 92), "orm": (1024, 85)}
TEXDIR = (PREVIEW / "maps") if PREVIEW else Path(tempfile.mkdtemp(prefix="swat_maps_"))
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
    ("Gear", ("patchbase", "patch_base", "backing")),
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


# Base colours per category (linear albedo, as a PBR renderer expects: real black nylon is ~0.03-0.05, not 0.004, or
# the operators read as silhouettes under the game's lights). Navy ripstop uniform, black nylon / polymer / leather,
# white patches.
LIB_COLOR = {
    "Uniform": (0.035, 0.045, 0.08), "Gear": (0.038, 0.038, 0.041), "Strap": (0.032, 0.032, 0.035),
    "Polymer": (0.036, 0.036, 0.039), "Helmet": (0.033, 0.033, 0.036), "Rubber": (0.026, 0.026, 0.027),
    "Leather": (0.032, 0.031, 0.03), "Glove": (0.032, 0.032, 0.034), "Balaclava": (0.028, 0.028, 0.03),
    "GearMetal": (0.16, 0.16, 0.165), "Buckle": (0.045, 0.045, 0.048), "Patch": (0.72, 0.72, 0.72), "Team": (0.8, 0.8, 0.8),
    "Skin": (0.42, 0.28, 0.22),
}
METAL = {"GearMetal": 0.85}

# Bump layers per category: (strength, distance, [(kind, scale, detail, weight)]); see bake().
DETAIL = {
    "Patch": (0.15, 0.001, [("noise", 400, 3, 0.6)]),
    "Skin": (0.12, 0.0015, [("noise", 300, 6, 0.6), ("noise", 40, 3, 0.3)]),
    # "weave": in-surface sine stripes on every axis (period 0.314 / scale m: 210 = 1.5 mm twill, 170 = 1.8 mm
    # Cordura, 260 = 1.2 mm webbing ribs, 125 = 2.5 mm knit); "lines": ripstop threads (57 = 5.5 mm grid).
    "Team": (0.3, 0.002, [("weave", 210, 0, 0.3), ("noise", 8, 2, 0.4)]),
    "Uniform": (0.4, 0.0012, [("lines", 57, 0, 0.45), ("weave", 210, 0, 0.3), ("noise", 6, 2, 0.25)]),
    "Gear": (0.4, 0.0012, [("weave", 170, 0, 0.5), ("noise", 420, 2, 0.15), ("noise", 10, 2, 0.25)]),
    "Strap": (0.35, 0.0012, [("weave", 260, 0, 0.6), ("noise", 20, 2, 0.2)]),
    "Polymer": (0.3, 0.0015, [("noise", 520, 3, 0.5), ("noise", 15, 2, 0.3)]),
    "Helmet": (0.2, 0.0015, [("noise", 380, 4, 0.7), ("noise", 10, 2, 0.3)]),
    "Rubber": (0.6, 0.003, [("noise", 60, 6, 0.7), ("voronoi", 18, 0, 0.4)]),
    "Leather": (0.5, 0.0015, [("voronoi", 380, 0, 0.6), ("noise", 70, 6, 0.4), ("noise", 9, 2, 0.4)]),
    "Glove": (0.45, 0.0015, [("voronoi", 420, 0, 0.4), ("weave", 300, 0, 0.3), ("noise", 50, 4, 0.3)]),
    "Balaclava": (0.3, 0.0015, [("weave", 125, 0, 0.6), ("noise", 45, 3, 0.3)]),
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
WEAR = {"Gear": 0.16, "Polymer": 0.22, "Helmet": 0.1, "Leather": 0.4, "Glove": 0.2, "Strap": 0.12, "Rubber": 0.2, "GearMetal": 0.8, "Buckle": 0.6}
# Dust / grime strength per category (the reference's gear is scuffed and dusty, not showroom clean).
GRIME = {"Gear": 0.16, "Strap": 0.12, "Polymer": 0.07, "Helmet": 0.05, "Glove": 0.12, "Leather": 0.25, "Rubber": 0.3, "Uniform": 0.1}


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


def tuck_trousers(meshes):
    """Trouser hems drape OUTSIDE over the boot collars (body round 4): boots carry tuck_* properties (centre and radii
    of the boot opening, boot top); any trouser vertex around the boot shaft that sits inside the opening (plus 6 mm
    of leather) is pushed out so the shaft never pokes through the drape."""
    boots = [m for m in meshes if "tuck_top" in m.keys()]
    legs = [m for m in meshes if "trouser" in m.name.lower() or "pant" in m.name.lower()]
    for b in boots:
        top, cx, cy, rx, ry = (float(b[k]) for k in ("tuck_top", "tuck_cx", "tuck_cy", "tuck_rx", "tuck_ry"))
        for leg in legs:
            moved = 0
            inv = leg.matrix_world.inverted()
            for v in leg.data.vertices:
                c = leg.matrix_world @ v.co
                if c.z > top + 0.01 or abs(c.x - cx) > rx * 2.0 or abs(c.y - cy) > ry * 2.0:
                    continue
                dx, dy = c.x - cx, c.y - cy
                e = math.hypot(dx / (rx + 0.006), dy / (ry + 0.006))
                if 0.2 < e < 1.0:
                    k = 1.0 / e
                    v.co = inv @ Vector((cx + dx * k, cy + dy * k, c.z))
                    moved += 1
            print("DRAPE", leg.name, "over", b.name, moved)


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


BUDGET = 15500  # triangles for the whole exported operator
# Low meshes the part files designed for their own `_high` bake source (strap, pouch and plate cages, gloves, boots):
# collapse would shred their thin straps, so they are exported as modelled; the budget is paid by the rest.
DESIGNED_KEEP = ("torso_", "limbs_glove", "limbs_knee", "head_helmetgear")
KEEP_THIN = ("strap", "rail", "buckle")  # thin bands (headset band, goggle and chin straps) shred when collapsed
# Share of the budget per mesh relative to its modelled density (first match by name).
DENSITY = [("eye", 0.5), ("face", 0.6), ("foam", 0.5), ("cushion", 0.5), ("buckle", 0.6), ("lens", 0.6),
           ("helmet", 1.6), ("mask", 1.15), ("goggle", 1.0), ("headset", 0.9), ("head_", 0.9),
           ("glove", 0.85), ("boot", 0.75), ("knee", 0.7), ("shirt", 1.6), ("trouser", 1.6), ("pant", 1.6),
           ("patch", 1.0), ("pouch", 0.75), ("holster", 0.9), ("radio", 0.9), ("torso_", 0.8)]
# Organic / cloth meshes: no planar dissolve, smooth shading up to 75 degrees (hard gear splits at 48).
CLOTH = ("shirt", "trouser", "pant", "mask", "face", "eye", "glove", "skin", "body", "balaclava", "armband")
# Pure detail meshes baked into the panel under them instead of being exported (MOLLE rows, velcro fields).
MERGE_INTO = {
    "Torso_Molle": ("Torso_FrontPlate", "Torso_BackPlate"),
    "Torso_CummerbundMolle": ("Torso_Cummerbund",),
    "Torso_Velcro": ("Torso_FrontPlate", "Torso_BackPlate"),
}
# UV texel density multipliers (first match by name): patches stay legible, head gear and gloves are seen close.
TEXEL = [("patch", 1.6), ("eye", 0.4), ("face", 0.5), ("foam", 0.6), ("head_", 1.3), ("glove", 1.25), ("boot", 1.1), ("knee", 1.1)]
TILES = {}  # low mesh name -> its atlas tile (x, y, cell size, UV square size) in pixels
SOURCES = {}  # low mesh name -> its bake sources (own full-detail copy, merged detail meshes)


def axis_pattern(nt, nodes, tc, scale, lines=False, distortion=0.0):
    """Stripes along every axis that lies in the surface (each axis weighted by 1 - |normal component|), so a weave
    or a ripstop grid shows on any orientation without UVs. Wave period is 0.314 / scale metres. lines=True turns the
    sine into thin raised threads (ripstop grid)."""
    def nn(kind, **props):
        n = nt.nodes.new(kind)
        for k, val in props.items():
            setattr(n, k, val)
        nodes.append(n)
        return n

    geo = nn("ShaderNodeNewGeometry")
    sep = nn("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Normal"], sep.inputs["Vector"])
    total = None
    for ax in "XYZ":
        w = nn("ShaderNodeTexWave", wave_type="BANDS", bands_direction=ax)
        w.inputs["Scale"].default_value = scale
        w.inputs["Distortion"].default_value = distortion
        w.inputs["Detail"].default_value = 1.0
        nt.links.new(tc.outputs["Object"], w.inputs["Vector"])
        val = w.outputs["Fac"]
        if lines:
            mr = nn("ShaderNodeMapRange")
            mr.inputs["From Min"].default_value = 0.86
            mr.inputs["From Max"].default_value = 1.0
            nt.links.new(val, mr.inputs["Value"])
            val = mr.outputs["Result"]
        ab = nn("ShaderNodeMath", operation="ABSOLUTE")
        nt.links.new(sep.outputs[ax], ab.inputs[0])
        inv = nn("ShaderNodeMath", operation="SUBTRACT", use_clamp=True)
        inv.inputs[0].default_value = 1.0
        nt.links.new(ab.outputs[0], inv.inputs[1])
        mul = nn("ShaderNodeMath", operation="MULTIPLY")
        nt.links.new(val, mul.inputs[0])
        nt.links.new(inv.outputs[0], mul.inputs[1])
        if total is None:
            total = mul.outputs[0]
        else:
            ad = nn("ShaderNodeMath", operation="ADD")
            nt.links.new(total, ad.inputs[0])
            nt.links.new(mul.outputs[0], ad.inputs[1])
            total = ad.outputs[0]
    return total


def name_weight(name, table, default=1.0):
    n = name.lower()
    for k, w in table:
        if k in n:
            return w
    return default


def is_cloth(name):
    return any(k in name.lower() for k in CLOTH)


def prepare_lows(meshes, budget=BUDGET):
    """The low-poly pass. Every mesh first leaves a full-detail copy behind as its bake source (bevels, MOLLE, folds,
    stitching and laces end up in the normal map, cavities and worn edges in the albedo); pure detail meshes (MOLLE
    rows, velcro fields) are merged into the panel under them. Then hard gear loses its coplanar faces (planar
    dissolve, material borders kept) and every mesh is collapsed (quadric, X-symmetric where the mesh is) to its share
    of the budget: head gear and gloves keep more, hidden bits under the mask and goggles very little."""
    SOURCES.clear()
    names = {m.name for m in meshes}
    keep = []
    for m in meshes:
        c = m.copy()
        c.data = m.data.copy()
        c.name = m.name + "__src"
        bpy.context.collection.objects.link(c)
        for mod in list(c.modifiers):
            c.modifiers.remove(mod)
        c.vertex_groups.clear()
        targets = [t for t in MERGE_INTO.get(m.name, ()) if t in names]
        if targets:
            for t in targets:
                SOURCES.setdefault(t, []).append(c)
            print("MERGED", m.name, "->", targets)
            bpy.data.objects.remove(m, do_unlink=True)
            continue
        SOURCES.setdefault(m.name, []).insert(0, c)
        keep.append(m)
    designed = set(high_sources(keep))
    fixed = {m.name for m in keep if (m.name in designed and m.name.lower().startswith(DESIGNED_KEEP)) or any(k in m.name.lower() for k in KEEP_THIN)}
    for m in keep:
        activate(m)
        if m.data.has_custom_normals:
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
        if not is_cloth(m.name) and m.name not in fixed:
            d = m.modifiers.new("Planar", "DECIMATE")
            d.decimate_type = "DISSOLVE"
            d.angle_limit = math.radians(1.0)
            d.delimit = {"MATERIAL"}
            bpy.ops.object.modifier_apply(modifier=d.name)
    pre = {m.name: tris(m) for m in keep}
    wts = {m.name: name_weight(m.name, DENSITY) for m in keep}

    def share(r):
        return {n: t if n in fixed else min(t, max(min(t, 40), int(wts[n] * r * t))) for n, t in pre.items()}

    lo, hi = 0.0, 4.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if sum(share(mid).values()) > budget:
            hi = mid
        else:
            lo = mid
    target = share(lo)
    for m in keep:
        bb = [m.matrix_world @ Vector(c) for c in m.bound_box]
        cx = (min(v.x for v in bb) + max(v.x for v in bb)) / 2
        sym = abs(cx) < 0.004 and max(v.x for v in bb) - min(v.x for v in bb) > 0.05
        for _ in range(3):
            cur = tris(m)
            if cur <= target[m.name] * 1.04:
                break
            d = m.modifiers.new("Dec", "DECIMATE")
            d.decimate_type = "COLLAPSE"
            d.ratio = target[m.name] / cur
            d.use_symmetry = sym
            d.symmetry_axis = "X"
            activate(m)
            bpy.ops.object.modifier_apply(modifier=d.name)
        activate(m)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(75 if is_cloth(m.name) else 48))
    print("LOWPOLY", sum(pre.values()), "->", sum(tris(m) for m in keep), [(m.name, pre[m.name], tris(m)) for m in keep])
    return keep


def high_sources(meshes):
    """The part files' sculpted / high-detail sources (Head_MaskHigh, Limbs_Glove.R_high, ...) per low mesh."""
    names = {m.name for m in meshes}
    out = {}
    for h in HIGHS:
        targets = HIGH_TARGETS.get(h.name)
        if targets is None and h.get("high_of"):
            targets = [str(h["high_of"])]
        if targets is None:
            base = h.name[:-5] if h.name.lower().endswith("_high") else h.name[:-4] if h.name.endswith("High") else None
            targets = [base] if base else []
        for t in targets:
            if t in names:
                out.setdefault(t, []).append(h)
    return out


def covers(highs, low):
    """True when the high sources carry every material category of the low (then their albedo can be projected too:
    a single-material glove or boot sculpt would paint the low's armour, soles or laces in its one colour)."""
    cats = lambda o: {category(m.name) for m in o.data.materials if m}  # noqa: E731
    have = set().union(*(cats(h) for h in highs)) if highs else set()
    return cats(low) <= have


def dilate(a, mask, iters):
    """Grows baked islands into the empty atlas around them (4-neighbour average), so mip maps and the downsampled
    export never bleed black into the seams."""
    m = mask.copy()
    s0, s1 = a.shape[:2]
    shifts = [((slice(1, None), slice(None)), (slice(None, -1), slice(None))), ((slice(None, -1), slice(None)), (slice(1, None), slice(None))),
              ((slice(None), slice(1, None)), (slice(None), slice(None, -1))), ((slice(None), slice(None, -1)), (slice(None), slice(1, None)))]
    for _ in range(iters):
        if m.all():
            break
        acc = np.zeros((s0, s1, 3), np.float32)
        cnt = np.zeros((s0, s1), np.float32)
        mf = m.astype(np.float32)
        for dst, src in shifts:
            acc[dst] += a[src][..., :3] * mf[src][..., None]
            cnt[dst] += mf[src]
        new = (~m) & (cnt > 0)
        a[new, :3] = acc[new] / cnt[new][:, None]
        m |= new
    return a


def img_array(img):
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def write_texture(a, name, out_size, quality, data, normal=False):
    """Box-downsamples a baked map to `out_size`, writes it as a JPEG of the given quality and loads it back as a
    packed file image: the glTF exporter embeds those bytes unchanged (no second lossy pass, per-map quality)."""
    while a.shape[0] > out_size:
        n = a.shape[0] // 2
        a = a.reshape(n, 2, n, 2, 4).mean(axis=(1, 3))
        if normal:
            v = a[..., :3] * 2 - 1
            v /= np.maximum(np.linalg.norm(v, axis=2, keepdims=True), 1e-6)
            a[..., :3] = v * 0.5 + 0.5
    a = np.ascontiguousarray(a, dtype=np.float32)
    a[..., 3] = 1.0
    size = a.shape[0]
    tmp = bpy.data.images.new(name + "_tmp", size, size, alpha=False, is_data=data)
    tmp.pixels.foreach_set(a.ravel())
    TEXDIR.mkdir(parents=True, exist_ok=True)
    path = TEXDIR / f"{name}.jpg"
    tmp.filepath_raw = str(path)
    tmp.file_format = "JPEG"
    tmp.save(quality=quality)
    bpy.data.images.remove(tmp)
    if name in bpy.data.images:
        bpy.data.images[name].name = name + "_baked"
    img = bpy.data.images.load(str(path))
    img.name = name
    if data:
        img.colorspace_settings.name = "Non-Color"
    img.pack()
    print("TEXTURE", name, size, "q", quality, path.stat().st_size, "bytes")
    return img


def bake(meshes, size=ATLAS):
    """One UV atlas for every low mesh; albedo (material colour, weave, cavity, edge wear, grime) and tangent normals
    (geometry of the full-detail sources + procedural weave / ripstop / grain bump) are projected per mesh from its
    bake sources (selected-to-active, cage from the measured low-to-high deviation), AO is baked on the lows together
    (contact shadows between parts) and multiplied in, roughness / metalness are baked flat. All baked materials then
    share these maps; they are written as per-map JPEGs (see TEX_OUT)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    use_gpu()
    baked = [m for m in meshes if any(mat and category(mat.name) != "Lens" for mat in m.data.materials)]
    stage1 = high_sources(meshes)
    sources = {m.name: SOURCES.get(m.name, []) for m in baked}
    all_src = {s for ss in SOURCES.values() for s in ss} | set(HIGHS)
    for s in all_src:
        s.hide_set(False)
    # UVs: islands from one smart projection of the lows; each mesh packs its own islands into a square tile, and the
    # tiles are shelf-packed into the atlas at a texel density weighted per piece (TEXEL: head gear, gloves, patches
    # more, hidden bits less). Per-mesh tiles also keep the projections cheap: each bakes into an image the size of
    # its tile instead of the whole atlas.
    for m in meshes:
        while m.data.uv_layers:
            m.data.uv_layers.remove(m.data.uv_layers[0])
        m.data.uv_layers.new(name="UVMap")
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    tp = time.time()
    bpy.ops.uv.smart_project(angle_limit=math.radians(52), island_margin=0.003, area_weight=0.7, scale_to_bounds=False)
    print("UV smart project", round(time.time() - tp, 1), "s")
    bpy.ops.object.mode_set(mode="OBJECT")
    W, PAD = size, 4
    area3d = {m.name: max(1e-6, sum(p.area for p in m.data.polygons) * abs(m.matrix_world.determinant()) ** (2 / 3)) for m in meshes}
    wt = {m.name: name_weight(m.name, TEXEL) for m in meshes}
    d_est = 0.8 * W / math.sqrt(sum(area3d[n] * wt[n] ** 2 for n in area3d) / 0.7)
    local, uarea = {}, {}
    scene.tool_settings.use_uv_select_sync = True  # every UV of the selected faces takes part in the pack
    for m in meshes:
        activate(m)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        est = max(16.0, d_est * wt[m.name] * math.sqrt(area3d[m.name] / 0.7))
        tp = time.time()
        bpy.ops.uv.pack_islands(rotate=True, shape_method="AABB", margin_method="FRACTION", margin=min(0.06, 3.0 / est))  # concave packing costs ~15 s per mesh
        bpy.ops.object.mode_set(mode="OBJECT")
        print("UV pack", m.name, round(time.time() - tp, 1), "s")
        uvd = m.data.uv_layers.active.data
        arr = np.empty(len(uvd) * 2, dtype=np.float32)
        uvd.foreach_get("uv", arr)
        arr = arr.reshape(-1, 2)
        arr -= arr.min(axis=0)
        ext = max(1e-6, float(arr.max()))
        arr /= ext
        local[m.name] = arr
        ua = 0.0
        for p in m.data.polygons:
            q = arr[list(p.loop_indices)]
            ua += abs(float(np.dot(q[:, 0], np.roll(q[:, 1], -1)) - np.dot(q[:, 1], np.roll(q[:, 0], -1)))) / 2
        uarea[m.name] = max(0.05, ua)
    scene.tool_settings.use_uv_select_sync = False

    def shelf(d):
        sides = {n: max(8, int(d * wt[n] * math.sqrt(area3d[n] / uarea[n]))) for n in local}
        x = y = row = 0
        pos = {}
        for n in sorted(sides, key=lambda k: -sides[k]):
            c = sides[n] + 2 * PAD
            if x + c > W:
                y += row
                x = row = 0
            pos[n] = (x, y, c, sides[n])
            x += c
            row = max(row, c)
        return pos, y + row

    lo_d, hi_d = 1.0, 4.0 * W
    for _ in range(40):
        mid = (lo_d + hi_d) / 2
        if shelf(mid)[1] <= W:
            lo_d = mid
        else:
            hi_d = mid
    tiles = shelf(lo_d)[0]
    TILES.clear()
    TILES.update(tiles)
    for m in meshes:
        x, y, c, side = tiles[m.name]
        uvd = m.data.uv_layers.active.data
        uvd.foreach_set("uv", ((local[m.name] * side + np.array([x + PAD, y + PAD])) / W).astype(np.float32).ravel())
    print("UV tiles", len(tiles), "texels per metre (weight 1)", round(lo_d), "atlas use",
          round(sum(uarea[n] * tiles[n][3] ** 2 for n in tiles) / W ** 2, 3))
    used = {mat for m in list(baked) + list(all_src) for mat in m.data.materials if mat and category(mat.name) != "Lens"}
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

    everything = [o for o in scene.objects if o.type == "MESH"]

    def show(objs, active):
        keep = set(objs)
        for o in everything:
            o.hide_render = o not in keep
        bpy.ops.object.select_all(action="DESELECT")
        for o in keep:
            o.select_set(True)
        bpy.context.view_layer.objects.active = active

    cages = {}
    dg = bpy.context.evaluated_depsgraph_get()

    def cage(low, srcs):
        """Cage extrusion from how far the sources stand off the low (97th percentile of the nearby source vertices)."""
        key = (low.name, tuple(s.name for s in srcs))
        if key in cages:
            return cages[key]
        mw = low.matrix_world
        tree = BVHTree.FromPolygons([mw @ v.co for v in low.data.vertices], [tuple(p.vertices) for p in low.data.polygons])
        ds = []
        for s in srcs:
            sw = s.matrix_world
            vs = s.data.vertices
            step = max(1, len(vs) // 15000)
            for i in range(0, len(vs), step):
                hit = tree.find_nearest(sw @ vs[i].co, 0.035)
                if hit[0] is not None:
                    ds.append(hit[3])
        d = sorted(ds)[int(len(ds) * 0.97)] if ds else 0.008
        e = min(0.022, max(0.003, d * 1.3 + 0.0015))
        cages[key] = (e, e * 2.2 + 0.002)
        return cages[key]

    def run(kind, img, setup, jobs=None, samples=2, arr=None, data=False, **kw):
        """jobs None: one bake into `img` on all lows together. Else [(low, sources)] projected one low at a time into
        its tile of the atlas array `arr` (a tile-sized image, the low's UVs moved into it for the bake)."""
        temp = {}
        nodes_img = []
        for mat in used:
            nt = mat.node_tree
            nodes = setup(mat, nt) or []
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = img
            nt.nodes.active = t
            nodes_img.append(t)
            temp[mat] = nodes + [t]
        scene.cycles.samples = samples
        if jobs is None:
            show(baked, baked[0])
            bpy.ops.object.bake(type=kind, margin=0, use_clear=False, use_selected_to_active=False, **kw)
        else:
            for low, srcs in jobs:
                if not srcs:
                    continue
                e, dist = cage(low, srcs)
                x, y, c, _side = TILES[low.name]
                tile = bpy.data.images.new("SurvivorTile", c, c, alpha=False, is_data=data)
                if data:
                    tile.colorspace_settings.name = "Non-Color"
                tile.pixels.foreach_set(np.ascontiguousarray(arr[y:y + c, x:x + c]).ravel())
                for t in nodes_img:
                    t.image = tile
                uvd = low.data.uv_layers.active.data
                keep_uv = np.empty(len(uvd) * 2, dtype=np.float32)
                uvd.foreach_get("uv", keep_uv)
                uvd.foreach_set("uv", ((keep_uv.reshape(-1, 2) * W - np.array([x, y])) / c).astype(np.float32).ravel())
                show([low] + srcs, low)
                try:
                    bpy.ops.object.bake(type=kind, margin=0, use_clear=False, use_selected_to_active=True, cage_extrusion=e, max_ray_distance=dist, **kw)
                    arr[y:y + c, x:x + c] = img_array(tile)
                except RuntimeError as exc:
                    print("BAKE FAILED", kind, low.name, exc)
                uvd.foreach_set("uv", keep_uv)
                bpy.data.images.remove(tile)
        for mat, nodes in temp.items():
            for n in nodes:
                mat.node_tree.nodes.remove(n)

    def emit(mat, nt, sock):
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output) if any(n.type == "OUTPUT_MATERIAL" and n.is_active_output for n in nt.nodes) else next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].links else None
        em = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(sock, em.inputs["Color"])
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
        restore.append((nt, out, old))
        return em

    def unemit():
        for nt, out, old in restore:
            if old:
                nt.links.new(old, out.inputs["Surface"])
        restore.clear()

    restore = []
    t0 = time.time()
    # Coverage mask (which atlas texels belong to a face), for the margin dilation.
    mask_img = new_img("SurvivorMask", size, True, (0, 0, 0, 1))
    run("EMIT", mask_img, lambda mat, nt: _mask_setup(mat, nt, emit), samples=1)
    unemit()
    mask = img_array(mask_img)[..., 0] > 0.5
    small = mask.reshape(size // 2, 2, size // 2, 2).any(axis=(1, 3))
    print("BAKE mask", round(float(mask.mean()), 3), "of the atlas covered", round(time.time() - t0, 1), "s")
    # AO on the lows together (contact shadows between pouches, plates, straps), sources hidden.
    ao = new_img("SurvivorAO", size // 2, True, (1, 1, 1, 1))
    if scene.world is None:
        scene.world = bpy.data.worlds.new("bake")
    scene.world.light_settings.distance = 0.12  # crease-scale occlusion, not room-scale
    run("AO", ao, lambda mat, nt: [], samples=48)
    print("BAKE ao", round(time.time() - t0, 1), "s")

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

        def mrange(sock, a, b, c, d):
            r = nn("ShaderNodeMapRange")
            r.inputs["From Min"].default_value = a
            r.inputs["From Max"].default_value = b
            r.inputs["To Min"].default_value = c
            r.inputs["To Max"].default_value = d
            nt.links.new(sock, r.inputs["Value"])
            return r.outputs["Result"]

        def scale_col(sock, fac):
            sc = nn("ShaderNodeVectorMath", operation="SCALE")
            nt.links.new(sock, sc.inputs[0])
            nt.links.new(fac, sc.inputs["Scale"])
            return sc.outputs[0]

        tc = nn("ShaderNodeTexCoord")
        nz = nn("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 4.0
        nz.inputs["Detail"].default_value = 3.0
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        col = nn("ShaderNodeVectorMath", operation="SCALE")
        alpha_src = None
        if linked is not None and bsdf.inputs["Alpha"].links:
            alpha_src = bsdf.inputs["Alpha"].links[0].from_socket
        elif linked is not None and "Alpha" in linked.node.outputs and linked.node.type == "TEX_IMAGE":
            alpha_src = linked.node.outputs["Alpha"]
        if linked is not None and alpha_src is not None:
            # Text/emblem textures with a transparent background (white SWAT letters): composite over the black
            # patch backing, since the exported material is opaque.
            mixa = nn("ShaderNodeMix", data_type="RGBA", blend_type="MIX")
            nt.links.new(alpha_src, mixa.inputs["Factor"])
            mixa.inputs[6].default_value = (0.035, 0.035, 0.038, 1.0)
            nt.links.new(linked, mixa.inputs[7])
            nt.links.new(mixa.outputs[2], col.inputs[0])
        elif linked is not None:
            nt.links.new(linked, col.inputs[0])
        else:
            col.inputs[0].default_value = base
        nt.links.new(mrange(nz.outputs["Fac"], 0.3, 0.7, 0.84, 1.1), col.inputs["Scale"])
        out_sock = col.outputs[0]
        cat_g = category(mat.name)
        geo_c = nn("ShaderNodeNewGeometry")
        if cat_g in ("Uniform", "Gear", "Strap", "Balaclava", "Team", "Glove"):
            # Fabric: the weave (and the ripstop grid on the uniform) in the colour, so the cloth reads as cloth.
            weave = axis_pattern(nt, nodes, tc, {"Uniform": 210, "Gear": 170, "Strap": 260, "Balaclava": 125, "Team": 210, "Glove": 300}[cat_g], distortion=0.6)
            out_sock = scale_col(out_sock, mrange(weave, 0.0, 2.0, 0.9, 1.06))
            if cat_g == "Uniform":
                grid = axis_pattern(nt, nodes, tc, 57, lines=True)
                out_sock = scale_col(out_sock, mrange(grid, 0.0, 1.0, 1.0, 1.16))
        # Cavities (concave creases between pouches, folds, MOLLE rows) darker, from the full-detail source.
        cav_strength = 0.4 if cat_g in ("Uniform", "Gear", "Strap", "Balaclava") else 0.35
        out_sock = scale_col(out_sock, mrange(geo_c.outputs["Pointiness"], 0.44, 0.5, 1.0 - cav_strength, 1.0))
        if cat_g in GRIME:
            # Dust and grime: soft noise patches of dusty grey, heavier low on the boots (kicked-up dust).
            amount = GRIME[cat_g]
            dn = nn("ShaderNodeTexNoise")
            dn.inputs["Scale"].default_value = 3.5
            dn.inputs["Detail"].default_value = 8.0
            dn.inputs["Roughness"].default_value = 0.65
            nt.links.new(tc.outputs["Object"], dn.inputs["Vector"])
            mask_s = mrange(dn.outputs["Fac"], 0.55, 0.8, 0.0, amount)
            if cat_g in ("Leather", "Rubber"):
                sz = nn("ShaderNodeSeparateXYZ")
                nt.links.new(geo_c.outputs["Position"], sz.inputs["Vector"])
                addm = nn("ShaderNodeMath", operation="ADD", use_clamp=True)
                nt.links.new(mask_s, addm.inputs[0])
                nt.links.new(mrange(sz.outputs["Z"], 0.0, 0.2, 0.45, 0.0), addm.inputs[1])
                mask_s = addm.outputs[0]
            # Grime collects in the creases.
            cv = nn("ShaderNodeMath", operation="ADD", use_clamp=True)
            nt.links.new(mask_s, cv.inputs[0])
            nt.links.new(mrange(geo_c.outputs["Pointiness"], 0.4, 0.48, amount * 0.6, 0.0), cv.inputs[1])
            dmix = nn("ShaderNodeMix", data_type="RGBA", blend_type="MIX")
            nt.links.new(cv.outputs[0], dmix.inputs["Factor"])
            nt.links.new(out_sock, dmix.inputs[6])
            dmix.inputs[7].default_value = (0.1, 0.094, 0.082, 1.0)
            out_sock = dmix.outputs[2]
        wear = WEAR.get(cat_g, 0.0)
        if wear:
            # Worn convex edges: scuffed lighter where the full-detail bevels are, broken up by grit.
            grit = nn("ShaderNodeTexNoise")
            grit.inputs["Scale"].default_value = 90.0
            grit.inputs["Detail"].default_value = 6.0
            nt.links.new(tc.outputs["Object"], grit.inputs["Vector"])
            gm = nn("ShaderNodeMath", operation="MULTIPLY")
            nt.links.new(mrange(geo_c.outputs["Pointiness"], 0.52, 0.6, 0.0, wear), gm.inputs[0])
            nt.links.new(mrange(grit.outputs["Fac"], 0.35, 0.65, 0.2, 1.6), gm.inputs[1])
            mix = nn("ShaderNodeMix", data_type="RGBA", blend_type="MIX", clamp_factor=True)
            nt.links.new(gm.outputs[0], mix.inputs["Factor"])
            nt.links.new(out_sock, mix.inputs[6])
            mix.inputs[7].default_value = (0.17, 0.17, 0.175, 1.0)
            out_sock = mix.outputs[2]
        nodes.append(emit(mat, nt, out_sock))
        return nodes

    # Albedo: a flat bake on the lows first (anything a projection misses), then projected from the sources.
    alb = new_img("SurvivorAlbedo", size, False, (0, 0, 0, 1))
    run("EMIT", alb, albedo_setup, samples=2)
    unemit()
    a_alb = img_array(alb)
    run("EMIT", None, albedo_setup, jobs=[(m, sources[m.name]) for m in baked], samples=2, arr=a_alb)
    unemit()
    # ... and from the part files' high sources where they carry all of the low's materials (cavities and worn edges
    # of the MOLLE rows, bindings and stitch beads).
    alb_high = [(m, stage1[m.name]) for m in baked if m.name in stage1 and covers(stage1[m.name], m)]
    print("ALBEDO from high sources:", [m.name for m, _ in alb_high])
    run("EMIT", None, albedo_setup, jobs=alb_high, samples=2, arr=a_alb)
    unemit()
    print("BAKE albedo", round(time.time() - t0, 1), "s")

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
                nt.links.new(tc.outputs["Object"], t.inputs["Vector"])
                out = t.outputs["Fac"]
                nodes.append(t)
            elif kind == "voronoi":
                t = nt.nodes.new("ShaderNodeTexVoronoi")
                t.feature = "DISTANCE_TO_EDGE"
                t.inputs["Scale"].default_value = scale
                nt.links.new(tc.outputs["Object"], t.inputs["Vector"])
                out = t.outputs["Distance"]
                nodes.append(t)
            else:  # "weave" (in-surface sine stripes) or "lines" (ripstop threads)
                out = axis_pattern(nt, nodes, tc, scale, lines=kind == "lines", distortion=0.0 if kind == "lines" else 0.6)
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            mul.inputs[1].default_value = weight
            nt.links.new(out, mul.inputs[0])
            nodes.append(mul)
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

    # Normals: projected from each low's own full-detail copy (and merged detail meshes), then from the part files'
    # sculpted sources where they exist; texels a projection misses keep the previous pass (flat to start with).
    a_nrm = np.empty((size, size, 4), dtype=np.float32)
    a_nrm[:] = (0.5, 0.5, 1.0, 1.0)
    run("NORMAL", None, normal_setup, jobs=[(m, sources[m.name]) for m in baked], samples=1, arr=a_nrm, data=True, normal_space="TANGENT")
    run("NORMAL", None, normal_setup, jobs=[(m, stage1[m.name]) for m in baked if m.name in stage1], samples=1, arr=a_nrm, data=True, normal_space="TANGENT")
    for low_name, hs in stage1.items():
        print("BAKED HIGH", low_name, "<-", [h.name for h in hs])
    print("BAKE normal", round(time.time() - t0, 1), "s")
    # Roughness (G) and metalness (B), baked flat on the lows.
    orm = new_img("SurvivorORM", size // 2, True, (1, 0.7, 0, 1))

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

    run("EMIT", orm, rough_setup, samples=1)
    unemit()
    print("BAKE orm", round(time.time() - t0, 1), "s")
    # Margins, AO into the albedo, then the export maps.
    a_alb = dilate(a_alb, mask, 24)
    a_ao = dilate(img_array(ao), small, 12)
    a_ao = np.repeat(np.repeat(a_ao, 2, axis=0), 2, axis=1)
    a_alb[..., :3] *= (0.2 + 0.8 * a_ao[..., :1])
    a_nrm = dilate(a_nrm, mask, 24)
    a_orm = dilate(img_array(orm), small, 12)
    tex = {
        "alb": write_texture(a_alb, "SurvivorAlbedo", *TEX_OUT["albedo"], data=False),
        "nrm": write_texture(a_nrm, "SurvivorNormal", *TEX_OUT["normal"], data=True, normal=True),
        "orm": write_texture(a_orm, "SurvivorORM", *TEX_OUT["orm"], data=True),
    }
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        ao.save(filepath=str(PREVIEW / "SurvivorAO.png"))
    for img in (alb, orm, ao, mask_img):
        bpy.data.images.remove(img)
    for s in all_src:
        bpy.data.objects.remove(s, do_unlink=True)
    HIGHS.clear()
    SOURCES.clear()
    for o in meshes:
        o.hide_render = False
    # One shared material for everything baked (one draw call per skinned mesh); `Team` (recoloured per player) and
    # the clear lenses stay separate.
    shared = bpy.data.materials.new("Survivor")
    shared.use_nodes = True
    for mat in [shared] + [m for m in used if m.name == "Team"]:
        wire_maps(mat, tex)
    for m in meshes:
        for i, mat in enumerate(m.data.materials):
            if mat in used and mat.name != "Team":
                m.data.materials[i] = shared
    print("BAKED survivor maps", round(time.time() - t0, 1), "s")


def _mask_setup(mat, nt, emit):
    rgb = nt.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = (1, 1, 1, 1)
    return [rgb, emit(mat, nt, rgb.outputs[0])]


def wire_maps(mat, tex):
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    for l in list(bsdf.inputs["Base Color"].links) + list(bsdf.inputs["Normal"].links) + list(bsdf.inputs["Roughness"].links) + list(bsdf.inputs["Metallic"].links) + list(bsdf.inputs["Alpha"].links):
        nt.links.remove(l)
    ta = nt.nodes.new("ShaderNodeTexImage")
    ta.image = tex["alb"]
    nt.links.new(ta.outputs["Color"], bsdf.inputs["Base Color"])
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = tex["nrm"]
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.space = "TANGENT"
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    tr = nt.nodes.new("ShaderNodeTexImage")
    tr.image = tex["orm"]
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tr.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    bsdf.inputs["Alpha"].default_value = 1.0


# ---- build ------------------------------------------------------------------------------------------------------------

SWAT_OUT = HERE / "swat" / "out"
HIGHS = []
# Which low mesh a high-detail bake source projects onto (by name); `_high` / `High` suffixes are matched generically.
HIGH_TARGETS = {
    "Torso_Molle": ["Torso_FrontPlate", "Torso_BackPlate"],
    "Torso_CummerbundMolle": ["Torso_Cummerbund"],
    "Head_HeadHigh": ["Head_Face"],
    "Head_HelmetParts": ["Head_HelmetGear", "Head_Helmet"],
}
PART_FILES = {"body": "swat_body.blend", "head": "swat_head.blend", "torso": "swat_torso.blend", "limbs": "swat_limbs.blend"}
BONE_NAMES = [b[0] for b in bz.BONES]


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
            # Kept for the high-to-low normal bake (bake_high), never exported.
            objs.remove(o)
            if o.type == "MESH":
                HIGHS.append(o)
            else:
                bpy.data.objects.remove(o, do_unlink=True)
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
    # Carrier, belt and pouches ride the torso only: thigh weights tear them apart when the legs spread.
    torso_only = n.startswith("torso_") and not any(k in n for k in ("holster", "thigh", "sleeve"))
    region_cleanup(obj, ARM_REF[0], no_arms, torso_only)


ARM_REF = [None]


def region_cleanup(obj, arm, no_arms=False, torso_only=False):
    """After a weight transfer, drops weights from bones outside each vertex's own body region (a hip pouch next to
    the A-posed hand must not follow the hand) and renormalises."""
    if arm is None:
        return
    segs = {b.name: (arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for b in arm.data.bones if b.name in REGION_OF}
    if no_arms:
        segs = {k: v for k, v in segs.items() if not REGION_OF[k].startswith("arm")}
    if torso_only:
        segs = {k: v for k, v in segs.items() if REGION_OF[k] == "torso"}
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
    if "glove" in n and ARM_REF[0] is not None and src is not None:
        return glove_weights(obj, arm)
    if "boot" in n and ARM_REF[0] is not None and src is not None:
        return boot_weights(obj, arm)
    rigid = obj.get("bone") if obj.get("bone") in BONE_NAMES else next((b for k, b in RIGID.items() if k in n), None)
    if obj.get("bone") in BONE_NAMES:
        for g in list(obj.vertex_groups):
            obj.vertex_groups.remove(g)
        obj.vertex_groups.new(name=rigid).add([v.index for v in obj.data.vertices], 1.0, "REPLACE")
    elif rigid and not has_weights(obj):
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


def glove_weights(obj, arm):
    """Gloves follow the hand bone fully; only the cuff (just behind the wrist) blends into the forearm."""
    side = "L" if obj.name.rstrip("_high").endswith("L") or ".l" in obj.name.lower() else "R"
    b = arm.data.bones[f"hand.{side}"]
    head = arm.matrix_world @ b.head_local
    d = (arm.matrix_world @ b.tail_local - head).normalized()
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    gh = obj.vertex_groups.new(name=f"hand.{side}")
    gf = obj.vertex_groups.new(name=f"forearm.{side}")
    for v in obj.data.vertices:
        t = (obj.matrix_world @ v.co - head).dot(d)
        w = max(0.0, min(1.0, (t + 0.03) / 0.04))  # 0 at 3 cm behind the wrist, 1 at 1 cm past it
        gh.add([v.index], w, "REPLACE")
        if w < 1.0:
            gf.add([v.index], 1.0 - w, "REPLACE")
    obj.parent = arm
    if not any(m.type == "ARMATURE" for m in obj.modifiers):
        m = obj.modifiers.new("Armature", "ARMATURE")
        m.object = arm
    return obj


def boot_weights(obj, arm):
    """Boots: the shaft follows the shin, the foot box the foot, blended over 8 cm around the ankle (a transferred
    blend tore the boot apart in the wide ready stance)."""
    side = "L" if obj.name.endswith("L") or ".l" in obj.name.lower() else "R"
    ankle = (arm.matrix_world @ arm.data.bones[f"foot.{side}"].head_local).z
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    gs = obj.vertex_groups.new(name=f"shin.{side}")
    gf = obj.vertex_groups.new(name=f"foot.{side}")
    for v in obj.data.vertices:
        z = (obj.matrix_world @ v.co).z
        w = max(0.0, min(1.0, (z - (ankle - 0.05)) / 0.14))  # 1 = shin; a soft ankle
        if w > 0:
            gs.add([v.index], w, "REPLACE")
        if w < 1:
            gf.add([v.index], 1.0 - w, "REPLACE")
    obj.parent = arm
    if not any(m.type == "ARMATURE" for m in obj.modifiers):
        m = obj.modifiers.new("Armature", "ARMATURE")
        m.object = arm
    return obj


def join_skinned(meshes):
    """One skinned mesh for the whole operator once every piece is weighted: three primitives (the shared baked
    material, Team, the clear lenses) instead of a draw call per piece and material."""
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    body = next((m for m in meshes if "shirt" in m.name.lower()), meshes[0])
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = "Survivor_Mesh"
    body.data.name = "Survivor_Mesh"
    print("JOINED", tris(body), "tris,", len(body.data.vertices), "verts, materials", [m.name for m in body.data.materials])
    return [body]


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
    tuck_trousers(meshes)
    if not any(mat and mat.name == "Team" for m in meshes for mat in m.data.materials):
        sleeve = next((m for m in meshes if "shirt" in m.name.lower()), None)
        meshes.append(fitted_armband(p, arm, sleeve) if sleeve else armband(p, -1))
    print("PRE-BUDGET tris", sum(tris(m) for m in meshes))
    meshes = prepare_lows(meshes)
    print("SURVIVOR tris", sum(tris(m) for m in meshes), [(m.name, tris(m)) for m in meshes])
    bake(meshes)
    for m in meshes:
        bind(m, arm, src)
    if src is not None and src.name not in [m.name for m in meshes]:
        bpy.data.objects.remove(src, do_unlink=True)
    meshes = join_skinned(meshes)
    build_anims(arm)
    return arm, meshes


ANIM_MODULE = HERE / "swat" / "swat_anim.py"
PREVIEW_GRIP = [None]  # where the idle holds the rifle grip (Blender space), for the preview
PREVIEW_GUN = "mp7"  # the MP5SD in weapons.glb, the gun the idle stance holds


def build_anims(arm):
    """The SWAT clips: from the ANIM worker's swat/swat_anim.py (build_clips(arm, bz): shouldered-MP5 ready idle,
    tactical walk, run, downed, reload, plus idle/walk/run/reload_pistol) when it exists, else the clips ported from
    build_zombies.py. The new idle holds the grip at swat_anim.models_ts_grip(), which models.ts must use for `grip`."""
    if ANIM_MODULE.exists():
        try:
            spec = importlib.util.spec_from_file_location("swat_anim", ANIM_MODULE)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod.build_clips(arm, bz)
            if hasattr(mod, "models_ts_grip"):
                gx, gy, gz = mod.models_ts_grip()
                PREVIEW_GRIP[0] = Vector((gx, -gz, gy))  # glTF y-up back to Blender z-up
                print("ANIM grip (models.ts GRIP):", (round(gx, 4), round(gy, 4), round(gz, 4)))
            print("ANIM clips from swat_anim.py:", sorted(a.name for a in bpy.data.actions))
            return
        except Exception as exc:  # noqa: BLE001
            print("ANIM swat_anim.py failed, falling back to the ported clips:", exc)
            for act in list(bpy.data.actions):
                bpy.data.actions.remove(act)
            if arm.animation_data:
                arm.animation_data_clear()
    bz.survivor_anims(arm)


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
    # Previews run after the export: show only the idle action, not every clip's NLA track blended together.
    arm.animation_data.use_nla = False
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
        root = next((o for o in new if o.name == PREVIEW_GUN), None)
        for o in new:
            if root is None or (o is not root and root not in o.parents_recursive if hasattr(o, "parents_recursive") else False):
                pass
        keep = {root} | set(root.children_recursive) if root else set()
        for o in new:
            if o not in keep:
                bpy.data.objects.remove(o, do_unlink=True)
        if root:
            root.parent = None
            root.location = PREVIEW_GRIP[0] or bz.GRIP
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
    # The idle (shouldered MP5 ready stance) in the stance reference's three views: front 3/4, side, rear 3/4, all from
    # the character's left so the gun points screen-right like the reference.
    scene.render.resolution_x = 700
    scene.render.resolution_y = 900
    pfiles = []
    for name, ang in (("f34", 40), ("side", 90), ("r34", 140)):
        a_ = math.radians(ang)
        cam.location = (math.sin(a_) * 5.0, math.cos(a_) * 5.0, 1.15)
        cam.rotation_euler = (Vector((0, 0, 1.0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = str(PREVIEW / f"op_p_{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        pfiles.append(path)
    pimgs = [bpy.data.images.load(f) for f in pfiles]
    pw, ph = pimgs[0].size
    psheet = np.zeros((ph, pw * 3, 4), dtype=np.float32)
    for i, im in enumerate(pimgs):
        psheet[:, i * pw:(i + 1) * pw] = np.array(im.pixels[:], dtype=np.float32).reshape(ph, pw, 4)
    pout = bpy.data.images.new("sheet_pose", pw * 3, ph, alpha=False)
    pout.pixels.foreach_set(psheet.ravel())
    pout.filepath_raw = str(PREVIEW / "op_sheet_pose.png")
    pout.file_format = "PNG"
    pout.save()
    # The same four views in the rest (A-like) pose without the rifle, like the reference sheet, so plates, patches
    # and pouches are not hidden behind the arms.
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    for o in gun:
        o.hide_render = True
    scene.render.resolution_x = 520
    scene.render.resolution_y = 900
    afiles = []
    for name, ang in (("front", 0), ("left", -90), ("back", 180), ("34", 35)):
        a_ = math.radians(ang)
        cam.location = (math.sin(a_) * 5.2, math.cos(a_) * 5.2, 1.05)
        cam.rotation_euler = (Vector((0, 0, 0.95)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = str(PREVIEW / f"op_a_{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        afiles.append(path)
    imgs = [bpy.data.images.load(f) for f in afiles]
    sheet = np.zeros((h, w * 4, 4), dtype=np.float32)
    for i, im in enumerate(imgs):
        sheet[:, i * w:(i + 1) * w] = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
    out = bpy.data.images.new("sheet_a", w * 4, h, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = str(PREVIEW / "op_sheet_a.png")
    out.file_format = "PNG"
    out.save()
    # Close-ups in the rest pose (texture / normal-map detail): chest rig, helmet, boots, glove and knee.
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    cam_d.lens = 85
    cfiles = []
    for name, eye, look in (("chest", (0.75, 1.9, 1.35), (0, 0.15, 1.22)), ("helmet", (0.55, 0.8, 1.8), (0, 0.02, 1.7)),
                            ("boots", (0.55, 1.25, 0.3), (0, 0.04, 0.14)), ("glove", (-1.05, 0.9, 1.05), (-0.42, 0.02, 0.88)),
                            ("knee", (0.6, 1.3, 0.62), (0.05, 0.05, 0.5)), ("back", (-0.5, -1.7, 1.3), (0, -0.12, 1.15))):
        cam.location = eye
        cam.rotation_euler = (Vector(look) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()
        path = str(PREVIEW / f"op_c_{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        cfiles.append(path)
    cimgs = [bpy.data.images.load(f) for f in cfiles]
    cw, ch = cimgs[0].size
    csheet = np.zeros((ch * 2, cw * 3, 4), dtype=np.float32)
    for i, im in enumerate(cimgs):
        r, c = 1 - i // 3, i % 3  # first row on top (image rows run bottom-up)
        csheet[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = np.array(im.pixels[:], dtype=np.float32).reshape(ch, cw, 4)
    cout = bpy.data.images.new("sheet_close", cw * 3, ch * 2, alpha=False)
    cout.pixels.foreach_set(csheet.ravel())
    cout.filepath_raw = str(PREVIEW / "op_sheet_close.png")
    cout.file_format = "PNG"
    cout.save()
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


def export_glb(arm):
    """bz.export with the settings the baked maps need: the JPEG maps are embedded as written (per-map quality, see
    write_texture), tangents go along so the normal map matches Blender's MikkTSpace bake on the low-poly mesh."""
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for c in arm.children_recursive:
        c.select_set(True)
    bpy.context.view_layer.objects.active = arm
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "survivor.glb")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
        export_materials="EXPORT", export_image_format="JPEG", export_image_quality=90, export_normals=True,
        export_tangents=True, export_texcoords=True, export_vertex_color="NONE", export_animations=True,
        export_animation_mode="ACTIONS", export_skins=True, export_def_bones=False, export_morph=False,
        export_lights=False, export_cameras=False, export_extras=False, export_anim_slide_to_zero=True,
        export_force_sampling=True, export_frame_step=1,
    )
    print("EXPORTED", path, Path(path).stat().st_size, "bytes")


def main():
    arm, meshes = build()
    bpy.context.scene.frame_set(1)
    report_bounds(meshes)
    export_glb(arm)
    preview_sheet(arm)


if __name__ == "__main__":
    main()
