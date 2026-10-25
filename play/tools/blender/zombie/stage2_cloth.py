"""
Stage 2 of the Last Light zombie pipeline: dresses the stage-1 bodies with simulated, torn clothes.

    blender --background --factory-startup --python stage2_cloth.py -- [options]

Options:
    --body PATH       stage-1 file (default out/zombie_body.blend next to this script)
    --out PATH        result (default out/zombie_dressed.blend)
    --variants 0,1    only these variants (default all four)
    --frames N        cloth simulation frames (default 45)
    --render DIR      also render studio previews (and a sheet next to reference 2) into DIR
    --standin         ignore stage 1 and dress a simple mannequin (development without stage 1)
    --update          start from the existing --out file and re-dress only --variants (the others stay as they are)
    --rebind          start from the existing --out file and only (re)bind stage-2 objects to the armature

Input contract (from stage 1): one armature (bone names in the shared brief, rest pose = the A-pose of
build_zombies.py, +Y is the front, feet at z = 0) and collections V0..V3, each with the variant's body mesh (the mesh
with the most vertices in the collection that has an Armature modifier; heads, eyes and teeth may be separate objects).

Output: the same file plus, per variant collection Vk, garment objects named `Vk_<Garment>` (Jacket, Shirt, Trousers,
Belt, Boots, Cap, Dress, Apron, Tights, Blouse, Skirt, Shoe, details...), each
  - draped by Blender's cloth simulation against the body (and the garments under it), then given thickness,
  - torn before the simulation (fringed hems and cuffs, holes, a ripped sleeve) so loose strips hang under gravity,
  - using only the material slots Cloth, ClothB, Shirt, Trim and Shoe (stage 3 owns the materials themselves),
  - weighted to the armature by transferring the body's vertex groups, with an Armature modifier and parented to it.
The body gets a vertex group `Covered` (weight 1 where clothes cover the skin) so stage 3 can thin those parts out.

How a garment is made: the body surface of the region the garment covers (picked by the nearest bone and how far along
it a point lies) is copied, decimated to cloth resolution, pushed out from the bone axes (looser for a jacket than for a
shirt), cut (the jacket's front opening, the open shirt neck), torn, pinned at the shoulders or the waist, and dropped
onto the body for a few dozen frames. Gravity pulls the slack into folds; sleeves and trouser legs bunch at the joints.
Details that should stay crisp (lapels, collars, pocket flaps, plackets, belt, braid, apron) are layered on afterwards
by copying the draped garment's own faces outwards ("appliques"), so they follow every fold.
"""

import math
import random
import sys
import time
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        return ARGS[i + 1] if i + 1 < len(ARGS) and not ARGS[i + 1].startswith("--") else True
    return default


BODY = Path(arg("--body", HERE / "out" / "zombie_body.blend"))
OUT = Path(arg("--out", HERE / "out" / "zombie_dressed.blend"))
VARIANTS = [int(v) for v in str(arg("--variants", "0,1,2,3")).split(",")]
FRAMES = int(arg("--frames", 60))
RENDER = arg("--render")
STANDIN = bool(arg("--standin", False)) or not BODY.exists()
REFERENCE = Path(r"C:\Users\buunn\AppData\Local\Temp\claude\C--Projects-bas-franke-com\5cfa0a1c-4b50-4c12-9ad4-13780799ba35\images\2.webp")

SLOTS = ("Cloth", "ClothB", "Shirt", "Trim", "Shoe")
# Placeholder colours only, so previews read; stage 3 replaces every material.
SLOT_COLOURS = {
    "Cloth": (0.06, 0.06, 0.065),
    "ClothB": (0.05, 0.05, 0.05),
    "Shirt": (0.62, 0.56, 0.47),
    "Trim": (0.55, 0.42, 0.18),
    "Shoe": (0.05, 0.035, 0.025),
}
VARIANT_TINT = {
    0: {"Cloth": (0.07, 0.065, 0.065), "ClothB": (0.045, 0.045, 0.045)},
    1: {"Cloth": (0.32, 0.03, 0.03), "ClothB": (0.03, 0.03, 0.035)},
    2: {"Cloth": (0.17, 0.17, 0.17), "ClothB": (0.03, 0.03, 0.03)},
    3: {"Cloth": (0.55, 0.52, 0.48), "ClothB": (0.04, 0.04, 0.05)},
}


def log(*a):
    print("[stage2]", *a, flush=True)


# ---- small helpers -------------------------------------------------------------------------------------------------

def link(obj, coll=None):
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj


def activate(obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def material(name):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        r, g, b = SLOT_COLOURS.get(name, (0.5, 0.5, 0.5))
        bsdf.inputs["Base Color"].default_value = (r, g, b, 1)
        bsdf.inputs["Roughness"].default_value = 0.85 if name != "Trim" else 0.35
        if name == "Trim":
            bsdf.inputs["Metallic"].default_value = 0.8
    return mat


def apply_modifier(obj, name):
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=name)


def freeze(obj):
    """Replaces the mesh with its evaluated state (current frame, all modifiers) and drops the modifiers."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    mesh = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    if old.users == 0:
        bpy.data.meshes.remove(old)


def smooth_shade(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


# ---- skeleton ------------------------------------------------------------------------------------------------------

STANDIN_BONES = [
    ("root", None, (0, 0, 0), (0, 0.25, 0)),
    ("hips", "root", (0, 0, 0.96), (0, 0, 1.08)),
    ("spine", "hips", (0, 0, 1.08), (0, 0.01, 1.26)),
    ("chest", "spine", (0, 0.01, 1.26), (0, 0, 1.45)),
    ("neck", "chest", (0, 0, 1.45), (0, 0.02, 1.56)),
    ("head", "neck", (0, 0.02, 1.56), (0, 0.02, 1.76)),
]
for _s, _x in (("L", -1), ("R", 1)):
    STANDIN_BONES += [
        (f"upperarm.{_s}", "chest", (_x * 0.17, 0, 1.42), (_x * 0.33, 0.0, 1.17)),
        (f"forearm.{_s}", f"upperarm.{_s}", (_x * 0.33, 0.0, 1.17), (_x * 0.44, 0.03, 0.94)),
        (f"hand.{_s}", f"forearm.{_s}", (_x * 0.44, 0.03, 0.94), (_x * 0.48, 0.05, 0.8)),
        (f"thigh.{_s}", "hips", (_x * 0.1, 0, 0.95), (_x * 0.11, 0.01, 0.51)),
        (f"shin.{_s}", f"thigh.{_s}", (_x * 0.11, 0.01, 0.51), (_x * 0.12, -0.02, 0.09)),
        (f"foot.{_s}", f"shin.{_s}", (_x * 0.12, -0.02, 0.09), (_x * 0.12, 0.15, 0.02)),
    ]


class Skeleton:
    """Bone segments in world space, for 'which bone is this point near, and how far along it'."""

    def __init__(self, arm):
        self.seg = {}
        for b in arm.data.bones:
            if b.name == "root":
                continue
            self.seg[b.name] = (arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local)

    def near(self, p, names=None):
        best = (None, 0.0, 1e9, None)
        for n, (a, b) in self.seg.items():
            if names and n not in names:
                continue
            ab = b - a
            t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
            q = a + ab * t
            d = (p - q).length
            if d < best[2]:
                best = (n, t, d, q)
        return best

    def side(self, name):
        return 1 if name.endswith(".R") else -1 if name.endswith(".L") else 0


# ---- stand-in bodies (only while stage 1 has not delivered) --------------------------------------------------------

def build_standin():
    """An armature and four smooth mannequins (two male, two female builds) in collections V0..V3."""
    log("no stage-1 body: building stand-in mannequins")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    arm_data = bpy.data.armatures.new("Zombie")
    arm = link(bpy.data.objects.new("Zombie", arm_data))
    activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, h, t in STANDIN_BONES:
        b = arm_data.edit_bones.new(name)
        b.head, b.tail = Vector(h), Vector(t)
        if parent:
            b.parent = arm_data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    builds = {0: (1.0, 1.0), 1: (0.97, 0.98), 2: (0.86, 1.06), 3: (0.85, 1.04)}  # shoulder width, hip width
    for k in range(4):
        coll = bpy.data.collections.new(f"V{k}")
        bpy.context.scene.collection.children.link(coll)
        sh, hp = builds[k]
        body = standin_body(f"V{k}_Body", sh, hp, female=k >= 2)
        bpy.context.scene.collection.objects.unlink(body)
        coll.objects.link(body)
        activate(body)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        with bpy.context.temp_override(active_object=arm, selected_objects=[body, arm], object=arm):
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    return arm


def standin_body(name, sh, hp, female):
    pts = {
        "pelvis": ((0, 0, 0.93), (0.15 * hp, 0.11)),
        "waist": ((0, 0.005, 1.06), (0.13 * (1.0 if not female else 0.9), 0.095)),
        "chest": ((0, 0.01, 1.27), (0.16 * sh, 0.11 if not female else 0.12)),
        "upper": ((0, 0, 1.40), (0.17 * sh, 0.1)),
        "neck": ((0, 0.02, 1.50), (0.055, 0.055)),
        "head0": ((0, 0.03, 1.60), (0.075, 0.09)),
        "head1": ((0, 0.02, 1.70), (0.085, 0.1)),
        "top": ((0, 0.01, 1.78), (0.06, 0.07)),
    }
    for s, x in (("L", -1), ("R", 1)):
        pts.update({
            f"shoulder{s}": ((x * 0.17 * sh, 0, 1.41), (0.055, 0.055)),
            f"elbow{s}": ((x * 0.33 * sh, 0.0, 1.17), (0.042, 0.042)),
            f"wrist{s}": ((x * 0.44 * sh, 0.03, 0.94), (0.032, 0.026)),
            f"hand{s}": ((x * 0.48 * sh, 0.05, 0.82), (0.04, 0.018)),
            f"hip{s}": ((x * 0.1 * hp, 0, 0.92), (0.085, 0.085)),
            f"knee{s}": ((x * 0.11, 0.01, 0.51), (0.055, 0.055)),
            f"ankle{s}": ((x * 0.12, -0.02, 0.09), (0.04, 0.04)),
            f"toe{s}": ((x * 0.12, 0.15, 0.03), (0.04, 0.025)),
        })
    edges = [("pelvis", "waist"), ("waist", "chest"), ("chest", "upper"), ("upper", "neck"), ("neck", "head0"), ("head0", "head1"), ("head1", "top")]
    for s in "LR":
        edges += [("upper", f"shoulder{s}"), (f"shoulder{s}", f"elbow{s}"), (f"elbow{s}", f"wrist{s}"), (f"wrist{s}", f"hand{s}"),
                  ("pelvis", f"hip{s}"), (f"hip{s}", f"knee{s}"), (f"knee{s}", f"ankle{s}"), (f"ankle{s}", f"toe{s}")]
    names = list(pts)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([pts[n][0] for n in names], [(names.index(a), names.index(b)) for a, b in edges], [])
    obj = link(bpy.data.objects.new(name, mesh))
    skin = obj.modifiers.new("Skin", "SKIN")
    skin.use_smooth_shade = True
    for i, n in enumerate(names):
        obj.data.skin_vertices[0].data[i].radius = pts[n][1]
    obj.data.skin_vertices[0].data[names.index("pelvis")].use_root = True
    sub = obj.modifiers.new("Sub", "SUBSURF")
    sub.levels = 2
    freeze(obj)
    smooth_shade(obj)
    return obj


# ---- loading stage 1 -----------------------------------------------------------------------------------------------

def load_bodies():
    if STANDIN:
        arm = build_standin()
    elif arg("--update") and OUT.exists():
        log(f"updating {OUT}")
        bpy.ops.wm.open_mainfile(filepath=str(OUT))
        arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    else:
        log(f"loading {BODY}")
        bpy.ops.wm.open_mainfile(filepath=str(BODY))
        arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    # Rest pose, so garments are built on the bind shape.
    arm.data.pose_position = "REST"
    bodies = {}
    for k in VARIANTS:
        coll = bpy.data.collections.get(f"V{k}")
        if coll is None:
            log(f"variant {k}: no collection V{k}, skipped")
            continue
        meshes = [o for o in coll.all_objects if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]
        if not meshes:
            log(f"variant {k}: no skinned mesh, skipped")
            continue
        # The game mesh: exactly Vk_Body (stage 1 also ships Vk_BodyHigh, a dense sculpt only for baking).
        exact = [o for o in meshes if o.name == f"V{k}_Body"]
        named = [o for o in meshes if "body" in o.name.lower() and "high" not in o.name.lower()]
        bodies[k] = (coll, (exact or named or meshes)[0] if exact else max(named or meshes, key=lambda o: len(o.data.vertices)))
    return arm, bodies


# ---- garment shells ------------------------------------------------------------------------------------------------

class Shell:
    """A garment surface cut from the body: positions in world space plus, per vertex, the bone it hugs."""

    def __init__(self, sk, body, keep, target_faces):
        self.sk = sk
        dg = bpy.context.evaluated_depsgraph_get()
        ev = body.evaluated_get(dg)
        src = ev.to_mesh()
        bm = bmesh.new()
        bm.from_mesh(src)
        ev.to_mesh_clear()
        bm.transform(body.matrix_world)
        bm.faces.ensure_lookup_table()
        info = {}
        for v in bm.verts:
            info[v.index] = sk.near(v.co)
        drop = [f for f in bm.faces if not keep(f.calc_center_median(), info[f.verts[0].index], f.normal)]
        bmesh.ops.delete(bm, geom=drop, context="FACES")
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
        self.bm = bm
        # Cloth resolution: decimate dense sculpts down to roughly target_faces.
        if len(bm.faces) > target_faces * 1.3:
            mesh = bpy.data.meshes.new("tmp")
            bm.to_mesh(mesh)
            tmp = link(bpy.data.objects.new("tmp", mesh))
            dec = tmp.modifiers.new("Dec", "DECIMATE")
            dec.ratio = target_faces / len(bm.faces)
            dec.use_collapse_triangulate = False
            freeze(tmp)
            bm.free()
            bm = bmesh.new()
            bm.from_mesh(tmp.data)
            done = tmp.data
            bpy.data.objects.remove(tmp)
            bpy.data.meshes.remove(done)
            self.bm = bm
        # Coarse bodies (the stand-in, low-poly stage-1 drafts) get subdivided up to cloth resolution.
        while len(self.bm.faces) * 4 <= target_faces * 1.2:
            bmesh.ops.subdivide_edges(self.bm, edges=list(self.bm.edges), cuts=1, use_grid_fill=True, smooth=0.6)
        bmesh.ops.smooth_vert(self.bm, verts=list(self.bm.verts), factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)

    def inflate(self, offset, radial, z_scale=None):
        """Pushes the surface off the body: radial (x the distance from the bone axis) plus a flat offset."""
        bm = self.bm
        bm.normal_update()
        for v in bm.verts:
            name, t, d, q = self.sk.near(v.co)
            r = radial(name, t, v.co) if callable(radial) else radial
            dirv = v.co - q
            n = v.normal if v.normal.length > 0.5 else dirv.normalized()
            v.co = q + dirv * r + n * offset
        return self

    def cut(self, drop):
        """Deletes faces where drop(centre, nearest-bone-info) is true."""
        bm = self.bm
        bm.faces.ensure_lookup_table()
        dead = [f for f in bm.faces if drop(f.calc_center_median(), self.sk.near(f.calc_center_median()))]
        bmesh.ops.delete(bm, geom=dead, context="FACES")
        drop_islands(bm, 24)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        return self

    def build(self, name, coll, mat):
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        obj = link(bpy.data.objects.new(name, mesh), coll)
        obj.data.materials.append(material(mat))
        smooth_shade(obj)
        return obj


def drop_islands(bm, min_faces):
    """Deletes connected bits smaller than min_faces (torn-off scraps would fly around in the simulation)."""
    bm.faces.ensure_lookup_table()
    seen = set()
    dead = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        if len(comp) < min_faces:
            dead += comp
    if dead:
        bmesh.ops.delete(bm, geom=dead, context="FACES")
        bm.faces.ensure_lookup_table()


def fringe(sk, band_test, strips=26, seed=1, keep_share=0.55):
    """A drop test that turns a hem band into hanging strips: every face in the band whose angular bucket around its
    bone is 'off' goes, with ragged ends (the band edge wanders with noise)."""
    rng = random.Random(seed)
    phase = rng.random() * 10

    def drop(c, near):
        depth = band_test(c, near)  # 0 outside the band, 0..1 into it (1 = the very edge)
        if depth <= 0:
            return False
        name, t, d, q = near
        a, b = sk.seg[name]
        axis = (b - a).normalized()
        ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((0, 1, 0))
        u = axis.cross(ref).normalized()
        w = axis.cross(u)
        rel = c - q
        ang = math.atan2(rel.dot(w), rel.dot(u))
        bucket = int((ang / (2 * math.pi) + 0.5) * strips + noise.noise(Vector((c.x * 9, c.y * 9, phase))) * 1.2)
        rand = noise.noise(Vector((bucket * 1.7, phase, 0.3))) * 0.5 + 0.5
        ragged = depth + noise.noise(c * 40 + Vector((phase, 0, 0))) * 0.25
        if bucket % 2 == 0 and rand > 1 - keep_share:
            return ragged > 0.25  # a gap between strips, opening up towards the edge
        return ragged > 0.97  # the strip itself only frays at the very end

    return drop


def holes(spots, seed=3):
    """A drop test for ragged holes: spots = [(centre Vector, radius)]."""
    phase = random.Random(seed).random() * 10

    def drop(c, near):
        for p, r in spots:
            jitter = noise.noise(c * 30 + Vector((phase, phase, 0))) * 0.35 * r
            if (c - p).length < r + jitter:
                return True
        return False

    return drop


def any_of(*tests):
    return lambda c, near: any(t(c, near) for t in tests)


# ---- simulation ----------------------------------------------------------------------------------------------------

def pin(obj, weight):
    g = obj.vertex_groups.new(name="Pin")
    for v in obj.data.vertices:
        w = weight(obj.matrix_world @ v.co)
        if w > 0:
            g.add([v.index], min(1.0, w), "REPLACE")
    return g


def collider(obj, thickness=0.011):
    mod = obj.modifiers.new("Collision", "COLLISION")
    obj.collision.thickness_outer = thickness
    obj.collision.thickness_inner = 0.004
    obj.collision.cloth_friction = 6
    obj.collision.damping = 0.4
    return mod


def proxy_collider(body, faces=9000):
    """A decimated copy of the body to collide with (stage-1 sculpts are far too dense for cloth collisions)."""
    dg = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(body.evaluated_get(dg), depsgraph=dg)
    obj = link(bpy.data.objects.new(body.name + "_Collide", mesh))
    obj.matrix_world = body.matrix_world.copy()
    if len(mesh.polygons) > faces:
        dec = obj.modifiers.new("Dec", "DECIMATE")
        dec.ratio = faces / len(mesh.polygons)
        freeze(obj)
    collider(obj)
    obj.hide_render = True
    return obj


def simulate(obj, frames, mass=0.35, tension=12, bending=0.4, shrink=0.0, pressure=0.0, quality=6):
    cloth = obj.modifiers.new("Cloth", "CLOTH")
    s = cloth.settings
    s.quality = quality
    s.mass = mass
    s.tension_stiffness = tension
    s.compression_stiffness = tension
    s.shear_stiffness = tension * 0.4
    s.bending_stiffness = bending
    s.air_damping = 2.0
    s.shrink_min = shrink
    if obj.vertex_groups.get("Pin"):
        s.vertex_group_mass = "Pin"
        s.pin_stiffness = 2.0
    if pressure:
        s.use_pressure = True
        s.uniform_pressure_force = pressure
    cs = cloth.collision_settings
    cs.collision_quality = 4
    cs.distance_min = 0.004
    cs.use_self_collision = False
    cloth.point_cache.frame_start = 1
    cloth.point_cache.frame_end = frames
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    for f in range(1, frames + 1):
        scene.frame_set(f)
    freeze(obj)
    scene.frame_set(1)
    return obj


def surface_tree(objs):
    """One BVH tree over the evaluated (full-resolution, displaced) surfaces of objs, in world space."""
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        tmp = bmesh.new()
        tmp.from_mesh(me)
        tmp.transform(o.matrix_world)
        me2 = bpy.data.meshes.new("tmp")
        tmp.to_mesh(me2)
        tmp.free()
        bm.from_mesh(me2)
        bpy.data.meshes.remove(me2)
        ev.to_mesh_clear()
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def push_out(obj, tree, margin, sk):
    """Moves garment vertices that ended up inside the surfaces under them (the full-resolution body, garments below)
    back out to `margin` above them. The cloth collides against a simplified body, so the real skin can poke through.
    'Above' is measured outwards from the nearest bone axis: a ray from outside towards the axis finds the outermost
    surface underneath, which also works through solidified (two-sided) garments below."""
    mw = obj.matrix_world
    inv = mw.inverted()
    moved = 0
    for v in obj.data.vertices:
        p = mw @ v.co
        name, t, d, q = sk.near(p)
        r = (p - q).length
        if r < 1e-4:
            continue
        u = (p - q) / r
        start = q + u * (r + 0.08)
        hit = tree.ray_cast(start, -u, r + 0.08)
        if hit[0] is None:
            continue
        outer = (hit[0] - q).dot(u)
        if r < outer + margin:
            v.co = inv @ (q + u * (outer + margin))
            moved += 1
    obj.data.update()
    return moved


def thicken(obj, thickness=0.004):
    sol = obj.modifiers.new("Solidify", "SOLIDIFY")
    sol.thickness = thickness
    sol.offset = 1.0
    sol.use_even_offset = False
    sol.use_quality_normals = True
    sol.thickness_clamp = 0.6
    sol.use_rim = True
    freeze(obj)
    return obj


def skin_garment(obj, body, arm):
    """Copies the body's bone weights onto the garment (nearest face, interpolated) and binds it to the armature."""
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    for g in body.vertex_groups:
        if g.name in arm.data.bones:
            obj.vertex_groups.new(name=g.name)
    dt = obj.modifiers.new("Weights", "DATA_TRANSFER")
    dt.object = body
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    apply_modifier(obj, dt.name)
    obj.parent = arm
    obj.matrix_parent_inverse = arm.matrix_world.inverted()
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    return obj


# ---- appliques: details layered on a draped garment ----------------------------------------------------------------

def applique(src, name, coll, mat, keep, offset=0.004, lift=None, thickness=0.003):
    """Copies the faces of `src` where keep(centre) holds, pushes them out by `offset` (plus lift(p) -> Vector) and
    thickens them: lapels, collars, pocket flaps, plackets, belts, braid, apron panels."""
    bm = bmesh.new()
    bm.from_mesh(src.data)
    bm.transform(src.matrix_world)
    bm.normal_update()
    dead = [f for f in bm.faces if not keep(f.calc_center_median())]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    if not bm.faces:
        bm.free()
        return None
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * offset + (lift(v.co) if lift else Vector())
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = link(bpy.data.objects.new(name, mesh), coll)
    obj.data.materials.append(material(mat))
    smooth_shade(obj)
    thicken(obj, thickness)
    return obj


def hard(name, coll, mat, verts, faces, smooth=True, bevel=0.0):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    obj = link(bpy.data.objects.new(name, mesh), coll)
    obj.data.materials.append(material(mat))
    if bevel:
        b = obj.modifiers.new("Bevel", "BEVEL")
        b.width = bevel
        b.segments = 2
        freeze(obj)
    if smooth:
        smooth_shade(obj)
    return obj


def disc(name, coll, mat, centre, normal, r, depth, n=12):
    """A button / rivet: a short cylinder facing along `normal`."""
    normal = normal.normalized()
    ref = Vector((0, 0, 1)) if abs(normal.z) < 0.9 else Vector((1, 0, 0))
    u = normal.cross(ref).normalized()
    w = normal.cross(u)
    verts = []
    for k in (0, 1):
        for i in range(n):
            a = 2 * math.pi * i / n
            verts.append(centre + (u * math.cos(a) + w * math.sin(a)) * r + normal * depth * k)
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return hard(name, coll, mat, verts, faces)


def join(objs, name):
    objs = [o for o in objs if o]
    if not objs:
        return None
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs, object=objs[0]):
        bpy.ops.object.join()
    objs[0].name = name
    objs[0].data.name = name
    return objs[0]


def surface_point(obj, p, direction):
    """First hit of a ray from far outside `p` towards it, on `obj` (to place buttons and buckles on the cloth)."""
    origin = p + direction * 0.4
    ok, loc, nrm, _ = obj.ray_cast(obj.matrix_world.inverted() @ origin, -direction)
    if ok:
        return obj.matrix_world @ loc, (obj.matrix_world.to_3x3() @ nrm).normalized()
    return p, direction


# ---- garments ------------------------------------------------------------------------------------------------------

UPPER = {"hips", "spine", "chest", "neck", "upperarm.L", "upperarm.R", "forearm.L", "forearm.R"}
LEGS = {"hips", "thigh.L", "thigh.R", "shin.L", "shin.R"}
FEET = {"shin.L", "shin.R", "foot.L", "foot.R"}


class Dresser:
    def __init__(self, k, coll, body, arm, sk):
        self.k, self.coll, self.body, self.arm, self.sk = k, coll, body, arm, sk
        self.rng = random.Random(100 + k)
        self.colliders = [proxy_collider(body)]
        self.made = []
        self.before = set(coll.objects)

    def name(self, part):
        return f"V{self.k}_{part}"

    def drape(self, shell, part, mat, pin_w, frames=FRAMES, **sim):
        obj = shell.build(self.name(part), self.coll, mat)
        pin(obj, pin_w)
        log(f"  {part}: {len(obj.data.vertices)} verts, simulating {frames} frames")
        t0 = time.time()
        simulate(obj, frames, **sim)
        log(f"  {part}: simulated in {time.time() - t0:.1f} s")
        under = [self.body] + [o for o in self.colliders[1:]]
        n = push_out(obj, surface_tree(under), 0.004 if len(under) == 1 else 0.006, self.sk)
        log(f"  {part}: pushed {n} vertices back out")
        return obj

    def settle(self, obj, thickness=0.004, collide=True):
        thicken(obj, thickness)
        if collide:
            self.colliders.append(obj)
            collider(obj, 0.004)
        self.made.append(obj)
        return obj

    def finish(self):
        for c in self.colliders:
            for m in [m for m in c.modifiers if m.type == "COLLISION"]:
                c.modifiers.remove(m)
        bpy.data.objects.remove(self.colliders[0])
        # Everything this variant gained (garments, appliques, buttons, laces) is bound to the armature.
        self.made = [o for o in self.coll.objects if o not in self.before and o.type == "MESH"]
        for obj in self.made:
            skin_garment(obj, self.body, self.arm)
        self.mark_covered()

    def mark_covered(self):
        """Body vertices that sit under a garment: weight 1 in `Covered` (stage 3 can thin them, they never show)."""
        old = self.body.vertex_groups.get("Covered")
        if old:
            self.body.vertex_groups.remove(old)
        g = self.body.vertex_groups.new(name="Covered")
        garments = [o for o in self.made if o.name in bpy.data.objects]
        dg = bpy.context.evaluated_depsgraph_get()
        covered = []
        for v in self.body.data.vertices:
            p = self.body.matrix_world @ v.co
            n = (self.body.matrix_world.to_3x3() @ v.normal).normalized()
            for o in garments:
                ok, *_ = o.ray_cast(o.matrix_world.inverted() @ (p + n * 0.002), o.matrix_world.to_3x3().inverted() @ n, distance=0.06)
                if ok:
                    covered.append(v.index)
                    break
        if covered:
            g.add(covered, 1.0, "REPLACE")
        log(f"  body: {len(covered)} of {len(self.body.data.vertices)} vertices covered")

    # -- shared pieces --

    def shirt(self, part="Shirt", mat="Shirt", open_neck=True, tail=0.88, sleeve_end=0.96, torn=True, loose=1.09):
        sk = self.sk
        keep = lambda c, near, n: near[0] in UPPER and c.z > tail and not (near[0] == "neck" and near[1] > 0.3) and not (
            near[0].startswith("forearm") and near[1] > sleeve_end)
        sh = Shell(sk, self.body, keep, 9000).inflate(0.006, lambda n, t, p: loose + (0.04 if n.startswith(("upper", "fore")) else 0.0))
        cuts = []
        if open_neck:
            # An open collar: a V down the front to the second button.
            cuts.append(lambda c, near: c.y > 0 and abs(c.x) < 0.015 + max(0.0, c.z - 1.3) * 0.45 and c.z > 1.3)
        if torn:
            cuts.append(fringe(sk, lambda c, near: max(0.0, 1 - (c.z - tail) / 0.07) if c.z < tail + 0.07 and near[0] in ("hips", "spine") else 0.0,
                               strips=30, seed=self.k * 7 + 1))
            cuts.append(fringe(sk, lambda c, near: max(0.0, (near[1] - (sleeve_end - 0.12)) / 0.12) if near[0].startswith("forearm") and near[1] > sleeve_end - 0.12 else 0.0,
                               strips=14, seed=self.k * 7 + 2))
            cuts.append(holes([(Vector((0.07 * (1 if self.k % 2 else -1), 0.1, 1.12)), 0.03), (Vector((-0.1, -0.08, 1.3)), 0.025)], seed=self.k))
        sh.cut(any_of(*cuts) if cuts else (lambda c, near: False))
        obj = self.drape(sh, part, mat, lambda p: 1.0 if p.z > 1.38 and abs(p.x) < 0.2 else 0.0, mass=0.2, tension=16, bending=0.6, shrink=-0.015)
        self.settle(obj, 0.0025)
        return obj

    def collar(self, garment, part, mat, height=0.05, flare=0.012, z0=1.40):
        """A shirt or jacket collar: the neck band of the garment, copied outwards and stood up."""
        sk = self.sk

        def keep(c):
            n, t, d, q = sk.near(c)
            return n in ("neck", "chest") and c.z > z0 and c.z < z0 + 0.12

        return applique(garment, self.name(part), self.coll, mat, keep, offset=0.004,
                        lift=lambda p: Vector((0, 0, height * 0.3)) + (p - Vector((0, 0.02, p.z))).normalized() * flare * max(0.0, p.z - z0) * 8)

    def trousers(self, part="Trousers", mat="ClothB", hem=0.9, waist=1.03, loose=1.2, torn=True):
        sk = self.sk
        keep = lambda c, near, n: near[0] in LEGS and c.z < waist and not (near[0].startswith("shin") and near[1] > hem)
        sh = Shell(sk, self.body, keep, 9000).inflate(0.012, lambda n, t, p: loose + (0.14 if n.startswith("shin") else 0.06 if n.startswith("thigh") else 0.0))
        cuts = []
        if torn:
            cuts.append(fringe(sk, lambda c, near: max(0.0, (near[1] - (hem - 0.1)) / 0.1) if near[0].startswith("shin") and near[1] > hem - 0.1 else 0.0,
                               strips=22, seed=self.k * 11 + 3, keep_share=0.45))
            knee = sk.seg["shin.R" if self.k % 2 == 0 else "shin.L"][0]
            cuts.append(holes([(knee + Vector((0, 0.06, -0.04)), 0.035), (sk.seg["thigh.L"][0].lerp(sk.seg["thigh.L"][1], 0.55) + Vector((0, 0.07, 0)), 0.02)], seed=self.k + 9))
        sh.cut(any_of(*cuts) if cuts else (lambda c, near: False))
        obj = self.drape(sh, part, mat, lambda p: 1.0 if p.z > waist - 0.05 else 0.0, mass=0.4, tension=22, bending=2.0, shrink=-0.01)
        return self.settle(obj, 0.003)

    def belt(self, trousers, part="Belt", mat="Shoe", z=0.99, width=0.04):
        belt = applique(trousers, self.name(part), self.coll, mat, lambda c: z - width / 2 < c.z < z + width / 2, offset=0.005, thickness=0.004)
        if belt is None:
            return None
        p, n = surface_point(belt, Vector((0, 0, z)), Vector((0, 1, 0)))
        buckle = disc(self.name("Buckle"), self.coll, "Trim", p, n, 0.026, 0.008, n=4)
        buckle.rotation_euler = (0, 0, 0)
        self.made += [belt, buckle]
        return belt

    def boots(self, part="Boots", mat="Shoe", top=0.82, sides=("L", "R"), laces=True):
        sk = self.sk
        allowed = {f"shin.{s}" for s in sides} | {f"foot.{s}" for s in sides}
        keep = lambda c, near, n: near[0] in allowed and (near[0].startswith("foot") or near[1] > top)
        sh = Shell(sk, self.body, keep, 2400).inflate(0.009, lambda n, t, p: 1.12 if n.startswith("foot") else 1.06)
        bm = sh.bm
        for v in bm.verts:
            if v.co.z < 0.03:
                v.co.z = max(0.0, v.co.z - 0.012)  # the sole sits on the floor
        obj = sh.build(self.name(part), self.coll, mat)
        sub = obj.modifiers.new("Sub", "SUBSURF")
        sub.levels = 1
        freeze(obj)
        # Wear: dents and creases across the toe and ankle.
        for v in obj.data.vertices:
            p = obj.matrix_world @ v.co
            v.co += v.normal * noise.noise(p * 22) * 0.003
        thicken(obj, 0.005)
        self.made.append(obj)
        if laces:
            for s in sides:
                a, b = sk.seg[f"foot.{s}"]
                for i in range(5):
                    q = a.lerp(b, 0.12 + i * 0.12) + Vector((0, 0, 0.06 - i * 0.008))
                    p, n = surface_point(obj, q, Vector((0, 0.3, 1)).normalized())
                    side = Vector((1, 0, 0))
                    lace = hard(self.name(f"Lace{s}{i}"), self.coll, mat,
                                [p - side * 0.022 + n * 0.002, p + side * 0.022 + n * 0.002, p + side * 0.022 + n * 0.006 + Vector((0, 0.006, 0)), p - side * 0.022 + n * 0.006 + Vector((0, 0.006, 0))],
                                [(0, 1, 2, 3)])
                    thicken(lace, 0.003)
                    self.made.append(lace)
        return obj

    # -- variants --

    def businessman(self):
        """Reference 2: open stained shirt, torn charcoal suit jacket with lapels and pockets, belt, trousers, boots."""
        sk = self.sk
        shirt = self.shirt(tail=0.86)
        self.collar(shirt, "ShirtCollar", "Shirt", height=0.04, flare=0.01, z0=1.42)
        trousers = self.trousers()
        self.belt(trousers)
        self.boots()

        # Jacket: hip length, open down the front, sleeves to the wrist; torn hem, frayed cuffs, a ripped right sleeve.
        hem = 0.8
        keep = lambda c, near, n: (near[0] in UPPER or near[0].startswith("thigh")) and c.z > hem and not (near[0] == "neck" and near[1] > 0.15) and not (
            near[0].startswith("forearm") and near[1] > 0.93)
        sh = Shell(sk, self.body, keep, 10000).inflate(0.02, lambda n, t, p: 1.2 + (0.07 if n.startswith(("upper", "fore")) else 0.0) + (0.1 if p.z < 1.0 else 0.0))
        opening = lambda c, near: c.y > 0.03 and abs(c.x) < 0.055 + max(0.0, c.z - 1.02) * 0.5 and near[0] not in ("upperarm.L", "upperarm.R")
        hem_tear = fringe(sk, lambda c, near: max(0.0, 1 - (c.z - hem) / 0.09) if c.z < hem + 0.09 and not near[0].startswith(("fore", "upper")) else 0.0, strips=24, seed=21, keep_share=0.5)
        cuff_tear = fringe(sk, lambda c, near: max(0.0, (near[1] - 0.78) / 0.15) if near[0].startswith("forearm") and near[1] > 0.78 else 0.0, strips=12, seed=22, keep_share=0.6)
        rip = lambda c, near: near[0] == "upperarm.R" and 0.55 < near[1] < 0.78 and (c - near[3]).normalized().y < -0.2
        worn = holes([(Vector((-0.13, 0.13, 1.16)), 0.022), (Vector((0.16, -0.12, 1.24)), 0.03), (Vector((0.08, -0.1, 0.92)), 0.025)], seed=23)
        sh.cut(any_of(opening, hem_tear, cuff_tear, rip, worn))
        jacket = self.drape(sh, "Jacket", "Cloth", lambda p: 1.0 if p.z > 1.36 and abs(p.x) < 0.22 else 0.25 if p.z > 1.3 else 0.0,
                            mass=0.5, tension=30, bending=4.0, shrink=-0.012)
        self.settle(jacket, 0.006)

        # Lapels: the front edge of the jacket from the collar to the button point, rolled back over the chest.
        def lapel(c):
            if c.y < 0.02 or c.z < 1.1 or c.z > 1.47:
                return False
            width = 0.03 + (c.z - 1.1) * 0.32
            edge = 0.055 + max(0.0, c.z - 1.02) * 0.5
            return edge < abs(c.x) < edge + width

        applique(jacket, self.name("Lapels"), self.coll, "Cloth", lapel, offset=0.006, thickness=0.005,
                 lift=lambda p: Vector((0, 0.004, 0)))
        self.collar(jacket, "JacketCollar", "Cloth", height=0.03, flare=0.016, z0=1.41)
        # Flap pockets and a breast pocket.
        for sx, z0, z1, w in ((-1, 0.94, 0.985, 0.075), (1, 0.94, 0.985, 0.075), (-1, 1.27, 1.29, 0.05)):
            cx = sx * 0.12
            applique(jacket, self.name(f"Pocket{'L' if sx < 0 else 'R'}{int(z0 * 100)}"), self.coll, "Cloth",
                     lambda c, cx=cx, z0=z0, z1=z1, w=w: c.y > 0 and z0 < c.z < z1 and abs(c.x - cx) < w, offset=0.004, thickness=0.004)
        # Two buttons where the jacket would close.
        for z in (1.02, 1.1):
            p, n = surface_point(jacket, Vector((-0.04, 0, z)), Vector((0, 1, 0)))
            self.made.append(disc(self.name(f"JacketButton{int(z * 100)}"), self.coll, "Trim", p, n, 0.009, 0.004))
        # Shirt buttons down the placket.
        for i in range(5):
            z = 1.26 - i * 0.085
            p, n = surface_point(shirt, Vector((0.012, 0, z)), Vector((0, 1, 0)))
            self.made.append(disc(self.name(f"ShirtButton{i}"), self.coll, "Shirt", p, n, 0.005, 0.002))

    def bellhop(self):
        sk = self.sk
        shirt = self.shirt(open_neck=False, tail=0.95, torn=False)
        self.trousers(hem=0.94)
        self.boots(laces=False)
        hem = 0.98
        keep = lambda c, near, n: near[0] in UPPER and c.z > hem and not (near[0] == "neck" and near[1] > 0.4) and not (near[0].startswith("forearm") and near[1] > 0.95)
        sh = Shell(sk, self.body, keep, 5600).inflate(0.012, lambda n, t, p: 1.07 + (0.06 if n.startswith(("upper", "fore")) else 0.0))
        sh.cut(any_of(
            fringe(sk, lambda c, near: max(0.0, (near[1] - 0.82) / 0.13) if near[0].startswith("forearm") and near[1] > 0.82 else 0.0, strips=12, seed=31),
            holes([(Vector((0.12, 0.12, 1.08)), 0.03), (Vector((-0.17, -0.02, 1.32)), 0.025)], seed=32),
            lambda c, near: near[0] == "upperarm.L" and near[1] > 0.6 and (c - near[3]).normalized().y > 0.3,
        ))
        jacket = self.drape(sh, "Jacket", "Cloth", lambda p: 1.0 if p.z > 1.36 and abs(p.x) < 0.22 else 0.0, mass=0.4, tension=20, bending=1.5, shrink=-0.015)
        self.settle(jacket, 0.006)
        self.collar(jacket, "Collar", "Cloth", height=0.05, flare=0.002, z0=1.42)
        # Braid on the shoulders and cuffs, a stripe down each trouser leg.
        applique(jacket, self.name("Epaulettes"), self.coll, "Trim",
                 lambda c: c.z > 1.38 and 0.1 < abs(c.x) < 0.2 and abs(c.y) < 0.05, offset=0.004, thickness=0.004)
        trousers = bpy.data.objects[self.name("Trousers")]
        applique(trousers, self.name("Stripes"), self.coll, "Trim",
                 lambda c: abs(abs(c.x) - (0.17 if c.z > 0.55 else 0.165)) < 0.012 and c.z < 0.95 and c.z > 0.12, offset=0.003, thickness=0.002)
        # Brass buttons, two columns of four.
        for col in (-0.05, 0.05):
            for i in range(4):
                z = 1.3 - i * 0.075
                p, n = surface_point(jacket, Vector((col, 0, z)), Vector((0, 1, 0)))
                self.made.append(disc(self.name(f"Button{i}{'L' if col < 0 else 'R'}"), self.coll, "Trim", p, n, 0.009, 0.005))
        self.pillbox()

    def pillbox(self):
        """The bellhop's pillbox cap, tilted over one ear, with a brass band."""
        head = self.sk.seg["head"]
        c0 = head[1] + Vector((0.035, -0.01, -0.035))
        n, r, h = 20, 0.065, 0.06
        verts, faces = [], []
        for rr, z in ((r, 0.0), (r, h), (r * 0.97, h + 0.006)):
            for i in range(n):
                a = 2 * math.pi * i / n
                verts.append(Vector((math.cos(a) * rr, math.sin(a) * rr * 0.92, z)))
        for k in range(2):
            faces += [(k * n + i, k * n + (i + 1) % n, (k + 1) * n + (i + 1) % n, (k + 1) * n + i) for i in range(n)]
        faces.append(tuple(range(2 * n, 3 * n)))
        cap = hard(self.name("Cap"), self.coll, "Cloth", verts, faces)
        band = disc(self.name("CapBand"), self.coll, "Trim", Vector((0, 0, 0.004)), Vector((0, 0, 1)), r * 1.02, 0.014, n=20)
        for o in (cap, band):
            o.location = c0
            o.rotation_euler = (0.12, -0.28, 0)
            freeze(o)
            self.made.append(o)
        thicken(cap, 0.003)

    def skirt_tube(self, part, mat, top_z, bottom_z, top_pad, bottom_r, slit=None, fray=True):
        """A skirt or dress skirt: a tube from the hips (just outside the body) to bottom_z, draped by the cloth sim."""
        sk = self.sk
        dg = bpy.context.evaluated_depsgraph_get()
        ev = self.body.evaluated_get(dg)
        mesh = ev.to_mesh()
        mw = self.body.matrix_world
        # The hips at that height only (the hands hang at the same height in the A-pose).
        ring = [p for p in (mw @ v.co for v in mesh.vertices) if abs(p.z - top_z) < 0.02 and sk.near(p)[0] in ("hips", "spine", "thigh.L", "thigh.R")]
        ev.to_mesh_clear()
        rx = max(abs(p.x) for p in ring) + top_pad if ring else 0.17
        ry = max(abs(p.y) for p in ring) + top_pad if ring else 0.12
        rows, cols = 22, 56
        verts, faces = [], []
        for j in range(rows + 1):
            t = j / rows
            z = top_z + (bottom_z - top_z) * t
            sx = rx + (bottom_r - rx) * t
            sy = ry + (bottom_r * 0.8 - ry) * t
            for i in range(cols):
                a = 2 * math.pi * i / cols
                verts.append((math.sin(a) * sx, math.cos(a) * sy, z))
        for j in range(rows):
            for i in range(cols):
                faces.append((j * cols + i, j * cols + (i + 1) % cols, (j + 1) * cols + (i + 1) % cols, (j + 1) * cols + i))
        bm = bmesh.new()
        m = bpy.data.meshes.new("tmp")
        m.from_pydata(verts, [], faces)
        bm.from_mesh(m)
        bpy.data.meshes.remove(m)
        sh = Shell.__new__(Shell)
        sh.sk, sh.bm = sk, bm
        cuts = []
        if slit:
            cuts.append(lambda c, near: c.y < -0.05 and abs(c.x) < 0.018 and c.z < slit)
        if fray:
            depth = 0.08
            cuts.append(fringe(sk, lambda c, near: max(0.0, 1 - (c.z - bottom_z) / depth) if c.z < bottom_z + depth else 0.0, strips=34, seed=self.k * 5 + 40, keep_share=0.4))
            cuts.append(holes([(Vector((0.1, 0.15, (top_z + bottom_z) / 2)), 0.03)], seed=self.k + 41))
        sh.cut(any_of(*cuts) if cuts else (lambda c, near: False))
        obj = self.drape(sh, part, mat, lambda p: 1.0 if p.z > top_z - 0.025 else 0.0, mass=0.3, tension=12, bending=0.3, shrink=-0.01)
        return self.settle(obj, 0.003)

    def tights(self, part="Tights", mat="ClothB"):
        sk = self.sk
        keep = lambda c, near, n: (near[0] in LEGS or near[0].startswith("foot")) and c.z < 0.98
        sh = Shell(sk, self.body, keep, 4200).inflate(0.0025, 1.0)
        # Ladders: long thin runs down the shins.
        ladders = [(Vector((s * 0.115, 0.05, z)), 0.012) for s, z in ((1, 0.3), (1, 0.36), (1, 0.42), (-1, 0.66), (-1, 0.6))]
        sh.cut(holes(ladders, seed=self.k + 50))
        obj = sh.build(self.name(part), self.coll, mat)
        thicken(obj, 0.0015)
        self.made.append(obj)
        return obj

    def housekeeper(self):
        sk = self.sk
        self.tights()
        self.boots(part="Shoes", top=0.94, laces=False)
        # Bodice (short sleeves), then the skirt tube to just below the knee.
        keep = lambda c, near, n: near[0] in UPPER and c.z > 0.94 and not (near[0] == "neck" and near[1] > 0.25) and not near[0].startswith("forearm") and not (
            near[0].startswith("upperarm") and near[1] > 0.55)
        sh = Shell(sk, self.body, keep, 4800).inflate(0.006, lambda n, t, p: 1.05 + (0.05 if n.startswith("upper") else 0.0))
        sh.cut(any_of(
            fringe(sk, lambda c, near: max(0.0, (near[1] - 0.4) / 0.15) if near[0].startswith("upperarm") and near[1] > 0.4 else 0.0, strips=12, seed=61),
            holes([(Vector((-0.12, 0.12, 1.2)), 0.025)], seed=62),
        ))
        bodice = self.drape(sh, "Dress", "Cloth", lambda p: 1.0 if p.z > 1.36 and abs(p.x) < 0.22 else 0.0, mass=0.25, tension=12, bending=0.3, shrink=-0.02)
        self.settle(bodice, 0.003)
        skirt = self.skirt_tube("DressSkirt", "Cloth", 0.98, 0.42, 0.012, 0.25)
        self.collar(bodice, "Collar", "Shirt", height=0.02, flare=0.02, z0=1.41)
        # Apron: a panel over the front of the skirt and a bib on the chest, with ties at the back.
        applique(skirt, self.name("Apron"), self.coll, "Shirt", lambda c: c.y > 0.03 and abs(c.x) < 0.17 and c.z > 0.5, offset=0.005, thickness=0.002)
        applique(bodice, self.name("ApronBib"), self.coll, "Shirt", lambda c: c.y > 0.04 and abs(c.x) < 0.09 and 1.0 < c.z < 1.3, offset=0.004, thickness=0.002)
        applique(skirt, self.name("ApronTies"), self.coll, "Shirt", lambda c: c.y < -0.02 and 0.9 < c.z < 0.97, offset=0.004, thickness=0.002)

    def businesswoman(self):
        sk = self.sk
        self.shirt(part="Blouse", mat="Cloth", tail=0.9, sleeve_end=0.6, loose=1.07)
        blouse = bpy.data.objects[self.name("Blouse")]
        self.collar(blouse, "BlouseCollar", "Cloth", height=0.025, flare=0.02, z0=1.42)
        self.skirt_tube("Skirt", "ClothB", 1.0, 0.46, 0.01, 0.13, slit=0.62)
        # One shoe left (a low pump on the left foot); the right foot is bare.
        self.boots(part="Shoe", top=0.97, sides=("L",), laces=False)

    def dress(self):
        log(f"variant {self.k}: dressing {self.body.name}")
        [self.businessman, self.bellhop, self.housekeeper, self.businesswoman][self.k]()
        self.finish()


# ---- previews ------------------------------------------------------------------------------------------------------

def tint_previews(k):
    for slot, rgb in VARIANT_TINT.get(k, {}).items():
        mat = bpy.data.materials.get(slot)
        if mat:
            mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)


def render_previews(arm, bodies, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = "GPU"
    except Exception:
        pass
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 683, 1024
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.05, 0.055, 1)
    scene.world = world
    # Grey cyclorama, a soft key from the front left, a rim from behind.
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    floor = bpy.context.active_object
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, -2.2, 6), rotation=(math.pi / 2, 0, 0))
    wall = bpy.context.active_object
    grey = bpy.data.materials.new("Backdrop")
    grey.use_nodes = True
    grey.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.16, 0.17, 1)
    grey.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    for o in (floor, wall):
        o.data.materials.append(grey)
    key = bpy.data.lights.new("Key", "AREA")
    key.energy, key.size = 260, 3.0
    ko = link(bpy.data.objects.new("Key", key))
    ko.location = (-1.6, 2.4, 2.6)
    ko.rotation_euler = (math.radians(55), 0, math.radians(-145))
    rim = bpy.data.lights.new("Rim", "AREA")
    rim.energy, rim.size = 160, 1.5
    ro = link(bpy.data.objects.new("Rim", rim))
    ro.location = (1.4, -1.6, 2.4)
    ro.rotation_euler = (math.radians(-50), 0, math.radians(30))
    cam = bpy.data.cameras.new("Cam")
    cam.lens = 70
    co = link(bpy.data.objects.new("Cam", cam))
    scene.camera = co
    # A slight shamble pose: head tilted, one arm raised, so the cloth reads as worn, not displayed.
    arm.data.pose_position = "POSE"
    pb = arm.pose.bones
    for b in pb:
        b.rotation_mode = "XYZ"
    pose = {"head": (0.1, 0.25, 0.15), "neck": (0.1, 0, 0.05), "chest": (0.12, 0, 0.05), "upperarm.R": (0.15, 0, 0.1), "forearm.R": (0.2, 0, 0)}
    for name, r in pose.items():
        if name in pb:
            pb[name].rotation_euler = r
    files = []
    all_colls = [c for c in bpy.data.collections if c.name.startswith("V")]
    for o in bpy.data.objects:
        if o.name.endswith("High") or "High" in o.name.split("_")[-1]:
            o.hide_render = True  # stage-1 bake sources overlap the game meshes
    for k, (coll, body) in bodies.items():
        for c in all_colls:
            c.hide_render = c is not coll
        tint_previews(k)
        for name, loc, rot in (("front", (0.55, 4.6, 1.0), (math.radians(89), 0, math.radians(173))), ("side", (3.6, 2.8, 1.05), (math.radians(88), 0, math.radians(128)))):
            co.location = loc
            co.rotation_euler = rot
            path = out_dir / f"v{k}_{name}.png"
            scene.render.filepath = str(path)
            bpy.ops.render.render(write_still=True)
            files.append(path)
            log(f"  rendered {path.name}")
    arm.data.pose_position = "REST"
    sheet(files, out_dir)


def sheet(files, out_dir):
    """Puts reference 2 and the front renders side by side in one image (Blender images + numpy, no PIL)."""
    try:
        import numpy as np
    except ImportError:
        return
    fronts = [f for f in files if f.name.endswith("_front.png")]
    tiles = []
    h = 1024
    srcs = ([REFERENCE] if REFERENCE.exists() else []) + fronts
    for f in srcs:
        img = bpy.data.images.load(str(f))
        w0, h0 = img.size
        w = int(w0 * h / h0)
        img.scale(w, h)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
        tiles.append(px)
        bpy.data.images.remove(img)
    if not tiles:
        return
    out = np.concatenate(tiles, axis=1)
    img = bpy.data.images.new("sheet", out.shape[1], out.shape[0], alpha=True)
    img.pixels = out.ravel()
    img.filepath_raw = str(Path(out_dir) / "sheet.png")
    img.file_format = "PNG"
    img.save()
    log(f"  sheet: {Path(out_dir) / 'sheet.png'}")


# ---- main ----------------------------------------------------------------------------------------------------------

def main():
    if arg("--rebind") and OUT.exists():
        bpy.ops.wm.open_mainfile(filepath=str(OUT))
        arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
        arm.data.pose_position = "REST"
        for k in VARIANTS:
            coll = bpy.data.collections.get(f"V{k}")
            body = coll and bpy.data.objects.get(f"V{k}_Body")
            if not body:
                continue
            for o in coll.objects:
                if o.get("stage2") and not any(m.type == "ARMATURE" for m in o.modifiers):
                    skin_garment(o, body, arm)
                    log(f"  bound {o.name}")
        bpy.ops.wm.save_as_mainfile(filepath=str(OUT), compress=True)
        return
    arm, bodies = load_bodies()
    sk = Skeleton(arm)
    for k in sorted(bodies):
        coll, body = bodies[k]
        for o in list(coll.all_objects):
            if o.name.startswith(f"V{k}_") and o is not body and o.get("stage2"):
                bpy.data.objects.remove(o)  # re-runs replace stage-2 garments
        before = set(bpy.data.objects)
        Dresser(k, coll, body, arm, sk).dress()
        for o in set(bpy.data.objects) - before:
            o["stage2"] = True
    for slot in SLOTS:
        material(slot).use_fake_user = True
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT), compress=True)
    log(f"saved {OUT}")
    if RENDER:
        render_previews(arm, bodies, RENDER)


main()
