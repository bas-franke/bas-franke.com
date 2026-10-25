"""
Zombie pipeline, stage 3 of 3 (FINISH): turns the dressed zombie bodies into the game's zombie.glb.

    blender --background --factory-startup --python stage3_finish.py -- <models-dir> [<preview-dir>|-] [scratch]

Input, newest first: out/zombie_dressed.blend (stage 2), out/zombie_body.blend (stage 1), else a scratch build of the
old procedural zombie from ../build_zombies.py (so this stage works before the others have landed). The input holds the
armature (bone names per the contract) and four variants, in collections V0..V3 or as objects named *_<k>.

Per variant:
  1. join everything into one high-detail mesh (modifiers applied, Multires at its top level, weights for anything that
     was parented to a bone), normalise the material names to the contract and paint procedural colours (dirt, blood,
     livor, veins, lesions, dark eye rims and mouth) into a colour attribute;
  2. decimate a copy to the triangle budget (the low mesh), UV-pack all four low meshes into one atlas;
  3. bake high -> low in Cycles on the GPU: tangent normals (with procedural pores, wrinkles, fabric weave added on the
     high side), ambient occlusion, albedo (colour attribute x procedural detail x cavity/edge wear from the curvature)
     and roughness; AO is multiplied into the albedo;
  4. hair cards (alpha-textured ribbons grown over the scalp: thin and dishevelled, a short crop under the bellhop's cap,
     a bun, long hair) weighted to the head;
  5. split into the dismemberment groups Zombie_<Body|Head|ArmL|ArmR|LegL|LegR>_<k> by each face's dominant bones.
Then the ten clips from build_zombies.py, with a new slow, heavy, foot-dragging walk, and the export (WebP textures, the
hair material patched to alphaMode MASK).
"""

import bmesh
import bpy
import json
import math
import random
import struct
import sys
from pathlib import Path

from mathutils import Vector
from mathutils import noise as mn

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import build_zombies as bz  # noqa: E402  (helpers: armature, colours, keyframes, the old body for scratch builds)

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else HERE.parents[2] / "frontend" / "public" / "models" / "zombies"
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 and ARGS[1] != "-" else None
FORCE_SCRATCH = "scratch" in ARGS[2:]
IN_DIR = HERE / "out"

TRI_BUDGET = 30000
HAIR_BUDGET = {0: 2600, 1: 1000, 2: 2400, 3: 4600}
ATLAS = 2048
ROUGH = 1024
PARTS = ("Body", "Head", "ArmL", "ArmR", "LegL", "LegR")
PART_BONES = {
    "Head": ("head",),
    "ArmL": ("upperarm.L", "forearm.L", "hand.L"),
    "ArmR": ("upperarm.R", "forearm.R", "hand.R"),
    "LegL": ("thigh.L", "shin.L", "foot.L"),
    "LegR": ("thigh.R", "shin.R", "foot.R"),
}
CONTRACT_MATS = ("Skin", "Cloth", "ClothB", "Blood", "Eyes", "Teeth", "Hair", "Shoe", "Shirt", "Trim", "Mouth")
# Fallback colours for contract materials the input does not have (linear RGB).
MAT_COLOR = {
    "Skin": (0.135, 0.13, 0.108), "Cloth": (0.26, 0.25, 0.24), "ClothB": (0.08, 0.08, 0.085), "Blood": (0.03, 0.005, 0.004),
    "Eyes": (0.6, 0.6, 0.55), "Teeth": (0.42, 0.33, 0.17), "Hair": (0.06, 0.05, 0.042), "Shoe": (0.07, 0.045, 0.03),
    "Shirt": (0.4, 0.36, 0.28), "Trim": (0.6, 0.45, 0.2), "Mouth": (0.012, 0.006, 0.005),
}


def log(*a):
    print("[stage3]", *a, flush=True)


# ---- input ----------------------------------------------------------------------------------------------------------

def scratch_build():
    """The old procedural zombie, unbaked and without animation, in collections V0..V3 (stand-in for stage 1/2)."""
    bz.clear_scene()
    bz._materials.clear()
    p = bz.zombie_palette()
    arm = bz.build_armature("Zombie")
    torso = ["hips", "spine", "chest", "neck", "upperarm.L", "upperarm.R", "thigh.L", "thigh.R"]
    for k, base in enumerate(bz.ZOMBIE_VARIANTS):
        spec = dict(base, k=k)
        body, body_extras = bz.zombie_body(p, spec)
        head = bz.zombie_head(f"Zombie_Head_{k}", p, spec)
        limbs, extras = bz.zombie_limbs(p, spec)
        body = bz.join([body] + body_extras, f"Zombie_Body_{k}")
        for side in ("L", "R"):
            for part in ("arm", "leg"):
                key = f"{part}{side}"
                limbs[key] = bz.join([limbs[key]] + extras[key], f"Zombie_{part.capitalize()}{side}_{k}") if extras[key] else limbs[key]
        bz.skin_to(body, arm, torso, power=4)
        bz.skin_to(head, arm, ["neck", "head"], power=6)
        for side in ("L", "R"):
            bz.skin_to(limbs[f"arm{side}"], arm, ["chest", f"upperarm.{side}", f"forearm.{side}", f"hand.{side}"])
            bz.skin_to(limbs[f"leg{side}"], arm, ["hips", f"thigh.{side}", f"shin.{side}", f"foot.{side}"])
        col = bpy.data.collections.new(f"V{k}")
        bpy.context.scene.collection.children.link(col)
        for o in [body, head, limbs["armL"], limbs["armR"], limbs["legL"], limbs["legR"]]:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            col.objects.link(o)
    return "scratch"


def load_input():
    if not FORCE_SCRATCH:
        for name in ("zombie_dressed.blend", "zombie_body.blend"):
            path = IN_DIR / name
            if path.exists():
                bpy.ops.wm.open_mainfile(filepath=str(path))
                bz._materials.clear()
                log("input", path)
                return name
    log("input: scratch build of the old zombie")
    return scratch_build()


def find_armature():
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        raise SystemExit("stage3: no armature in the input")
    arm = next((a for a in arms if all(b in a.data.bones for b, *_ in bz.BONES)), arms[0])
    missing = [b for b, *_ in bz.BONES if b not in arm.data.bones]
    if missing:
        raise SystemExit(f"stage3: armature {arm.name} misses bones {missing}")
    arm.name = "Zombie"
    arm.data.name = "Zombie"
    # The clips are authored against build_zombies' rest pose; report how far the input is from it.
    worst = max((arm.data.bones[b].head_local - Vector(h)).length for b, _, h, _t in bz.BONES)
    log(f"armature rest pose deviates up to {worst * 100:.1f} cm from the clip rig")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    arm.data.pose_position = "REST"
    return arm


def variant_objects(k):
    col = bpy.data.collections.get(f"V{k}")
    objs = list(col.all_objects) if col else [o for o in bpy.data.objects if o.name.endswith(f"_{k}") or o.name.endswith(f"_{k}.001")]
    objs = [o for o in objs if o.type in ("MESH", "CURVES", "CURVE")]
    # Stage 2 keeps the sculpted body and head as *High next to the game-weight copy. The low set (exported) is every
    # object except the *High ones; the high set (normal bake source) swaps each copy for its *High sculpt and
    # duplicates everything else, so both sets can be joined separately.
    by_name = {o.name: o for o in objs}
    low = [o for o in objs if not o.name.endswith("High")]
    high = []
    for o in low:
        src = by_name.get(f"{o.name}High")
        if src is None:
            src = o.copy()
            if o.data:
                src.data = o.data.copy()
            for c in o.users_collection:
                c.objects.link(src)
        high.append(src)
    return low, high


# ---- preparing the high mesh ----------------------------------------------------------------------------------------

def canonical(name_hint):
    n = name_hint.lower()
    rules = [
        ("Skin", ("skin", "body", "flesh")), ("Blood", ("blood", "wound", "gore")), ("Eyes", ("eye",)),
        ("Teeth", ("teeth", "tooth", "nail")), ("Mouth", ("mouth", "gum", "tongue", "lip")), ("Hair", ("hair", "brow")),
        ("Shoe", ("shoe", "boot", "sole", "lace")), ("Shirt", ("shirt", "blouse", "apron", "collar", "sock")),
        ("Trim", ("trim", "button", "brass", "badge", "buckle", "braid", "epaulet", "band")),
        ("ClothB", ("clothb", "trouser", "pant", "skirt", "tights", "leg")), ("Cloth", ("cloth", "jacket", "suit", "coat", "dress", "uniform", "cap")),
    ]
    for canon, keys in rules:
        if n == canon.lower() or n.startswith(canon.lower() + "."):
            return canon
    for canon, keys in rules:
        if any(k in n for k in keys):
            return canon
    return "Cloth"


CANON = {}


def canon_mat(name, source=None):
    if name in CANON:
        return CANON[name]
    clash = bpy.data.materials.get(name)
    if clash:
        clash.name = f"in_{name}"
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    col = MAT_COLOR[name]
    # Skin keeps the pipeline's own pale grey-green (stage 1 sculpts shape, the colour is painted here).
    if name not in ("Skin", "Blood") and source and source.node_tree and source.node_tree.nodes.get("Principled BSDF"):
        sb = source.node_tree.nodes["Principled BSDF"]
        if not sb.inputs["Base Color"].is_linked:
            col = tuple(sb.inputs["Base Color"].default_value)[:3]
    bsdf.inputs["Base Color"].default_value = (*col, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.7
    bsdf.inputs["Metallic"].default_value = 0.9 if name == "Trim" else 0.0
    if name == "Eyes":
        bsdf.inputs["Emission Color"].default_value = (0.3, 0.3, 0.27, 1)
        bsdf.inputs["Emission Strength"].default_value = 0.04
    mat.use_backface_culling = name != "Hair"
    CANON[name] = mat
    return mat


def bone_weights_for(obj, arm):
    """Objects parented to a bone, or with no weights at all, get weights (bone parent, else nearest bones)."""
    if obj.parent_type == "BONE" and obj.parent_bone:
        g = obj.vertex_groups.get(obj.parent_bone) or obj.vertex_groups.new(name=obj.parent_bone)
        g.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
        return
    if any(g.name in arm.data.bones for g in obj.vertex_groups):
        return
    allowed = [b for b, *_ in bz.BONES if b != "root"]
    segs = {b: (arm.data.bones[b].head_local, arm.data.bones[b].tail_local) for b in allowed}
    groups = {b: obj.vertex_groups.get(b) or obj.vertex_groups.new(name=b) for b in allowed}
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        ds = sorted((bz.seg_dist(p, a, b) + 1e-3, n) for n, (a, b) in segs.items())[:2]
        ws = [(1.0 / d ** 5, n) for d, n in ds]
        tot = sum(w for w, _ in ws)
        for w, n in ws:
            groups[n].add([v.index], w / tot, "REPLACE")


SEGMENTS = [(Vector(h), Vector(t)) for name, (h, t) in bz.JOINT.items() if name != "root"]


def outward(p, n):
    """1 if a surface at p with normal n faces away from the nearest bone (outwards), else -1."""
    best = None
    bd = 1e9
    for a, b in SEGMENTS:
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
        q = a + ab * t
        d = (p - q).length
        if d < bd:
            bd, best = d, q
    return 1 if n.dot(p - best) >= 0 else -1


def clean_mesh(o):
    """Merges duplicate vertices, dissolves degenerate faces and makes the winding consistent per connected piece.
    Closed pieces (skin, solidified cloth) get outward normals from that; open pieces (torn single-layer cloth) are
    flipped as a whole when most of their faces point at the skeleton, so the game's backface culling shows them."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, dist=2e-4, edges=bm.edges)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.faces.ensure_lookup_table()
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        seen = set()
        mw = o.matrix_world
        rot = mw.to_3x3()
        for f in bm.faces:
            if f.index in seen:
                continue
            comp, stack, closed = [], [f], True
            seen.add(f.index)
            while stack:
                g = stack.pop()
                comp.append(g)
                for e in g.edges:
                    if len(e.link_faces) != 2:
                        closed = False
                    for h in e.link_faces:
                        if h.index not in seen:
                            seen.add(h.index)
                            stack.append(h)
            if closed:
                continue
            score = sum(outward(mw @ g.calc_center_median(), (rot @ g.normal).normalized()) * g.calc_area() for g in comp)
            if score < 0:
                bmesh.ops.reverse_faces(bm, faces=comp)
    bm.to_mesh(o.data)
    bm.free()


def darken_face(low):
    """Dark, bruised skin around the eyes and the mouth (found from the Eyes and Mouth faces), redder rims."""
    mats = [m.name if m else "" for m in low.data.materials]
    centers = {"Eyes": [], "Mouth": []}
    for poly in low.data.polygons:
        name = mats[poly.material_index] if poly.material_index < len(mats) else ""
        if name in centers:
            centers[name].append(poly.center.copy())
    eyes = centers["Eyes"]
    pts = []
    if eyes:
        left = [c for c in eyes if c.x < 0]
        right = [c for c in eyes if c.x >= 0]
        for side in (left, right):
            if side:
                pts.append((sum(side, Vector()) / len(side), 0.042, 0.9))
    if centers["Mouth"]:
        m = centers["Mouth"]
        pts.append((sum(m, Vector()) / len(m), 0.045, 0.75))
    attr = low.data.color_attributes.get("Col")
    if not attr or not pts:
        return
    skin = {i for i, n in enumerate(mats) if n == "Skin"}
    on_skin = set()
    for poly in low.data.polygons:
        if poly.material_index in skin:
            on_skin.update(poly.vertices)
    touched = 0
    log(f"  face darkening around {len(pts)} points: {[tuple(round(x, 3) for x in c) for c, _r, _a in pts]}")
    for v in low.data.vertices:
        if v.index not in on_skin:
            continue
        k = 0.0
        for c, rad, amt in pts:
            d = (v.co - c).length
            if d < rad * 1.6:
                k = max(k, amt * max(0.0, 1 - d / (rad * 1.6)) ** 1.3)
        if k > 0:
            touched += 1
            col = attr.data[v.index].color
            r, g, b = col[0], col[1], col[2]
            # Towards a dark, bruised purple-red.
            attr.data[v.index].color = (r * (1 - k) + r * 0.32 * k, g * (1 - k) + g * 0.18 * k, b * (1 - k) + b * 0.2 * k, 1.0)
    log(f"  face darkening touched {touched} skin vertices")


def prepare(k, arm, objs, detail):
    """Joins one variant's objects into one mesh. detail: the bake source (every modifier applied, Multires and
    Subdivision at their top level). Otherwise the exported mesh: subdivision skipped, then each object decimated on its
    own if the variant is over budget (decimating the joined mesh would collapse layered thin cloth into spikes)."""
    meshes = []
    for o in objs:
        if o.type != "MESH":
            # Curves (hair from stage 1/2): converted to a mesh like everything else; the cards replace hair anyway.
            bpy.ops.object.select_all(action="DESELECT")
            o.hide_set(False)
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
            try:
                bpy.ops.object.convert(target="MESH")
            except RuntimeError:
                continue
            o = bpy.context.active_object
        o.hide_set(False)
        o.hide_viewport = False
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        if o.data.shape_keys:
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        for mod in list(o.modifiers):
            if mod.type == "ARMATURE":
                o.modifiers.remove(mod)
                continue
            if mod.type in ("MULTIRES", "SUBSURF") and not detail:
                o.modifiers.remove(mod)
                continue
            if mod.type == "MULTIRES":
                mod.levels = mod.total_levels
            if mod.type == "SUBSURF":
                mod.levels = max(mod.levels, mod.render_levels)
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError as e:
                log("could not apply", mod.name, "on", o.name, e)
                o.modifiers.remove(mod)
        bone_weights_for(o, arm)
        # Unparent but keep the world transform, so joining bakes it in.
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        meshes.append(o)
    if not meshes:
        raise SystemExit(f"stage3: variant {k} has no meshes")
    if not detail:
        for o in meshes:
            clean_mesh(o)
        target = TRI_BUDGET - HAIR_BUDGET[k] - 400
        total = sum(bz.tris(o) for o in meshes)
        if total > target:
            # Weighted budget: the face keeps its detail (decimating the head into slivers gave white facets and a
            # mask-like face); boots, garments and the mostly covered body give the triangles up.
            def weight(o):
                n = o.name.lower()
                if any(x in n for x in ("head", "eye", "teeth", "mouth", "nail")):
                    return 6.0
                if any(x in n for x in ("boot", "shoe", "lace", "belt", "buckle", "button")):
                    return 0.45
                if "body" in n:
                    return 0.8
                return 1.0
            sizes = [(o, bz.tris(o), weight(o)) for o in meshes]
            lo, hi = 0.0, 10.0
            for _ in range(40):
                r = (lo + hi) / 2
                kept = sum(t if t < 600 else min(1.0, r * w) * t for _o, t, w in sizes)
                lo, hi = (r, hi) if kept < target else (lo, r)
            r = lo
            for o, t, w in sizes:
                ratio = min(1.0, r * w)
                if t < 600 or ratio > 0.97:
                    continue
                bpy.ops.object.select_all(action="DESELECT")
                o.select_set(True)
                bpy.context.view_layer.objects.active = o
                mod = o.modifiers.new("Decimate", "DECIMATE")
                mod.ratio = ratio
                mod.use_collapse_triangulate = True
                bpy.ops.object.modifier_apply(modifier=mod.name)
                clean_mesh(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    high = bpy.context.active_object
    high.name = f"{'High' if detail else 'Low'}_{k}"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # Normalise materials to the contract names (shared across variants).
    for i, slot in enumerate(high.material_slots):
        src = slot.material
        name = canonical(src.name if src else "Cloth")
        high.data.materials[i] = canon_mat(name, src)
    # Hair is replaced by cards: drop any hair geometry the input had.
    hair_ids = {i for i, m in enumerate(high.data.materials) if m == CANON.get("Hair")}
    if hair_ids:
        bm = bmesh.new()
        bm.from_mesh(high.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in hair_ids], context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(high.data)
        bm.free()
    for poly in high.data.polygons:
        poly.use_smooth = True
    # Procedural colour: dirt, blood, livor, veins, lesions; on the head darker sockets, nostrils, lips, blood runs.
    while high.data.color_attributes:
        high.data.color_attributes.remove(high.data.color_attributes[0])
    if not detail:
        spec = dict(bz.ZOMBIE_VARIANTS[k], k=k)
        bz.zombie_colors(high, None, spec, blood=0.26, dirt=0.8, head=True)
        darken_face(high)
    log(f"variant {k}: {'high' if detail else 'low'} mesh {bz.tris(high)} tris")
    return high


# ---- low mesh, UVs --------------------------------------------------------------------------------------------------

def mark_seams(low, arm):
    """Seams from the anatomy: between bone groups (each face belongs to its dominant bone) and down the back of each
    bone's cylinder (down the sole for feet), so every limb segment, the head and the torso rings unwrap as a few
    large islands instead of thousands of triangles."""
    gidx = {g.index: g.name for g in low.vertex_groups}
    frames = {}
    for b in arm.data.bones:
        h, t = b.head_local, b.tail_local
        axis = (t - h).normalized()
        front = Vector((0, 0, 1)) if b.name.startswith("foot") else Vector((0, 1, 0))
        front = (front - axis * front.dot(axis)).normalized()
        if front.length < 0.5:
            front = Vector((1, 0, 0))
        frames[b.name] = (h, axis, front, axis.cross(front))
    vbone = []
    for v in low.data.vertices:
        best, bw = "hips", -1.0
        for e in v.groups:
            n = gidx.get(e.group)
            if n in frames and e.weight > bw:
                best, bw = n, e.weight
        vbone.append(best)
    bm = bmesh.new()
    bm.from_mesh(low.data)
    bm.faces.ensure_lookup_table()
    fbone = []
    for f in bm.faces:
        count = {}
        for v in f.verts:
            count[vbone[v.index]] = count.get(vbone[v.index], 0) + 1
        fbone.append(max(count, key=count.get))

    def angle(co, bone):
        h, axis, front, side = frames[bone]
        d = co - h
        return math.atan2(d.dot(side), d.dot(front))

    for e in bm.edges:
        e.seam = False
        fs = e.link_faces
        if len(fs) != 2:
            continue
        b0, b1 = fbone[fs[0].index], fbone[fs[1].index]
        if b0 != b1:
            e.seam = True
            continue
        a0 = angle(e.verts[0].co, b0)
        a1 = angle(e.verts[1].co, b0)
        if abs(a0 - a1) > math.pi:
            e.seam = True
        # The face gets an island of its own (a ring at the ears), so the unwrap cannot squash it around the eye and
        # mouth holes.
        if b0 in ("head", "neck") and (abs(a0) < math.pi / 2) != (abs(a1) < math.pi / 2):
            e.seam = True
    bm.to_mesh(low.data)
    bm.free()


def components(low):
    """Face index sets of the connected pieces of a mesh."""
    bm = bmesh.new()
    bm.from_mesh(low.data)
    bm.faces.ensure_lookup_table()
    seen = set()
    out = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]
        comp = []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g.index)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        out.append(comp)
    bm.free()
    return out


def select_faces(low, faces):
    sel = set(faces)
    for poly in low.data.polygons:
        poly.select = poly.index in sel


def unwrap(lows, arm):
    for m in lows:
        bm = bmesh.new()
        bm.from_mesh(m.data)
        bmesh.ops.dissolve_degenerate(bm, dist=0.0008, edges=bm.edges)
        bm.to_mesh(m.data)
        bm.free()
    # Each variant gets its own quadrant of the atlas: unwrapped and packed on its own, then scaled in. (Packing all four
    # together let islands of different variants overlap, and each variant's bake overwrote the others.)
    for k, m in enumerate(lows):
        while m.data.uv_layers:
            m.data.uv_layers.remove(m.data.uv_layers[0])
        m.data.uv_layers.new(name="UVMap")
        mark_seams(m, arm)
        comps = components(m)
        small = [i for c in comps if len(c) < 160 for i in c]
        big = [i for c in comps if len(c) >= 160 for i in c]
        big_set = set(big)
        bpy.ops.object.select_all(action="DESELECT")
        m.select_set(True)
        bpy.context.view_layer.objects.active = m
        select_faces(m, big)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_mode(type="FACE")
        bpy.ops.uv.unwrap(method="ANGLE_BASED", margin=0.002, fill_holes=True)
        bpy.ops.object.mode_set(mode="OBJECT")
        # A torn garment can still unwrap into a degenerate or exploded island: those faces fall back to projection.
        uvd = m.data.uv_layers[0].data
        bad = []
        for poly in m.data.polygons:
            if poly.index not in big_set:
                continue
            pts = [uvd[li].uv for li in poly.loop_indices]
            if any(not (math.isfinite(u.x) and math.isfinite(u.y)) for u in pts):
                bad.append(poly.index)
        if bad:
            log(f"variant {k}: {len(bad)} faces with broken UVs, projected instead")
            small += bad
        if small:
            select_faces(m, small)
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, area_weight=0.7, scale_to_bounds=False)
            bpy.ops.object.mode_set(mode="OBJECT")
        select_faces(m, range(len(m.data.polygons)))
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
        bpy.ops.object.mode_set(mode="OBJECT")
        us = [d.uv.x for d in m.data.uv_layers[0].data]
        vs = [d.uv.y for d in m.data.uv_layers[0].data]
        log(f"variant {k}: uv extent x {min(us):.3f}..{max(us):.3f} y {min(vs):.3f}..{max(vs):.3f}")
        ox, oy = (k % 2) * 0.5, (k // 2) * 0.5
        uv = m.data.uv_layers[0].data
        for d in uv:
            d.uv = (ox + d.uv.x * 0.5, oy + d.uv.y * 0.5)
        log(f"variant {k}: {len(comps)} pieces, unwrapped")


# ---- baking ---------------------------------------------------------------------------------------------------------

def use_gpu():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = kind
            except TypeError:
                continue
            prefs.get_devices()
            devs = [d for d in prefs.devices if d.type == kind]
            if devs:
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                log("baking on", kind, [d.name for d in devs])
                return
    except Exception as e:  # noqa: BLE001
        log("no GPU:", e)
    scene.cycles.device = "CPU"


def image(name, size, data, color=(0.5, 0.5, 1.0, 1.0)):
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False, is_data=data)
    img.generated_color = color
    img.colorspace_settings.name = "Non-Color" if data else "sRGB"
    return img


class Temp:
    """Temporary nodes added to the canonical materials for one bake pass."""

    def __init__(self, target):
        self.nodes = []
        self.relinks = []
        self.target = target

    def add(self, nt, kind, **props):
        n = nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        self.nodes.append((nt, n))
        return n

    def surface(self, mat, socket):
        nt = mat.node_tree
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].links else None
        self.relinks.append((nt, old, out))
        nt.links.new(socket, out.inputs["Surface"])

    def target_node(self, mat):
        nt = mat.node_tree
        t = self.add(nt, "ShaderNodeTexImage")
        t.image = self.target
        nt.nodes.active = t

    def undo(self):
        for nt, n in self.nodes:
            nt.nodes.remove(n)
        for nt, old, out in self.relinks:
            if old:
                nt.links.new(old, out.inputs["Surface"])


def tex(tmp, nt, kind, coord, scale, detail=0.0, **props):
    t = tmp.add(nt, kind, **props)
    t.inputs["Scale"].default_value = scale
    if "Detail" in t.inputs:
        t.inputs["Detail"].default_value = detail
    nt.links.new(coord, t.inputs["Vector"])
    return t


def remap(tmp, nt, sock, a, b, lo, hi):
    mr = tmp.add(nt, "ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = a
    mr.inputs["From Max"].default_value = b
    mr.inputs["To Min"].default_value = lo
    mr.inputs["To Max"].default_value = hi
    nt.links.new(sock, mr.inputs["Value"])
    return mr.outputs["Result"]


def vmul(tmp, nt, a, b):
    m = tmp.add(nt, "ShaderNodeVectorMath", operation="MULTIPLY")
    nt.links.new(a, m.inputs[0])
    if isinstance(b, tuple):
        m.inputs[1].default_value = b
    else:
        nt.links.new(b, m.inputs[1])
    return m.outputs[0]


def vscale(tmp, nt, a, s):
    m = tmp.add(nt, "ShaderNodeVectorMath", operation="SCALE")
    nt.links.new(a, m.inputs[0])
    nt.links.new(s, m.inputs["Scale"])
    return m.outputs[0]


def mix(tmp, nt, fac, a, b):
    m = tmp.add(nt, "ShaderNodeMix", data_type="RGBA", blend_type="MIX")
    nt.links.new(fac, m.inputs["Factor"])
    nt.links.new(a, m.inputs[6])
    nt.links.new(b, m.inputs[7])
    return m.outputs[2]


def blood_mask(tmp, nt, vcol):
    """Where the painted colour is blood (red well above green and blue)."""
    sep = tmp.add(nt, "ShaderNodeSeparateColor")
    nt.links.new(vcol, sep.inputs["Color"])
    mx = tmp.add(nt, "ShaderNodeMath", operation="MAXIMUM")
    nt.links.new(sep.outputs["Green"], mx.inputs[0])
    nt.links.new(sep.outputs["Blue"], mx.inputs[1])
    red = tmp.add(nt, "ShaderNodeMath", operation="SUBTRACT")
    nt.links.new(sep.outputs["Red"], red.inputs[0])
    nt.links.new(mx.outputs[0], red.inputs[1])
    return remap(tmp, nt, red.outputs[0], 0.07, 0.2, 0.0, 1.0)


def blood(tmp, nt, vcol, col):
    """Blood dark, brown-red and clotted (the painted red reads as bright paint otherwise)."""
    m = tmp.add(nt, "ShaderNodeMix", data_type="RGBA", blend_type="MIX")
    nt.links.new(blood_mask(tmp, nt, vcol), m.inputs["Factor"])
    nt.links.new(col, m.inputs[6])
    m.inputs[7].default_value = (0.032, 0.006, 0.004, 1.0)
    return m.outputs[2]


def bake_pass(pairs, kind, samples=4, project=True, **kw):
    """Bakes each (high, low) pair into the image set on the canonical materials: projected high -> low (selected to
    active) for normals, or on the low mesh itself (which carries the painted colour attribute through decimation) for
    colour, roughness and AO, where layered thin cloth makes projection rays miss or hit the wrong layer.
    Nothing is cleared: images start at a neutral fill, so a missed ray stays neutral."""
    scene = bpy.context.scene
    scene.cycles.samples = samples
    bake = scene.render.bake
    bake.use_selected_to_active = True
    bake.cage_extrusion = 0.012
    bake.max_ray_distance = 0.06
    bake.margin = 6
    everything = [o for o in scene.objects if o.type == "MESH"]
    for i, (high, low) in enumerate(pairs):
        # All four variants stand at the origin: only this pair may exist for the bake, and the low mesh (which lies
        # on the high surface) must not occlude or catch any ray.
        for o in everything:
            o.hide_render = o not in ((high, low) if project else (low,))
        for attr in ("visible_camera", "visible_diffuse", "visible_glossy", "visible_shadow", "visible_transmission", "visible_volume_scatter"):
            setattr(low, attr, not project)
        bpy.ops.object.select_all(action="DESELECT")
        if project:
            high.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type=kind, use_clear=False, use_selected_to_active=project, cage_extrusion=0.016, max_ray_distance=0.036, margin=16, **kw)
    for o in everything:
        o.hide_render = False
    for _high, low in pairs:
        for attr in ("visible_camera", "visible_diffuse", "visible_glossy", "visible_shadow", "visible_transmission", "visible_volume_scatter"):
            setattr(low, attr, True)


def bake_all(pairs):
    use_gpu()
    mats = [m for m in CANON.values() if m.name != "Hair" and m.users]
    alb = image("ZombieAlbedo", ATLAS, False, (0.05, 0.045, 0.04, 1))
    nrm = image("ZombieNormal", ATLAS, True)
    rgh = image("ZombieRough", ROUGH, True, (0.85, 0.85, 0.85, 1))
    ao = image("ZombieAO", ATLAS // 2, True, (1, 1, 1, 1))

    # Normals: the high geometry plus procedural micro detail per material (pores, wrinkles, weave, leather grain).
    tmp = Temp(nrm)
    for mat in mats:
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        base = mat.name
        strength, dist, layers = bz.ZOMBIE_DETAIL.get(base, (0.3, 0.002, [("noise", 80, 4, 1.0)]))
        tc = tmp.add(nt, "ShaderNodeTexCoord")
        total = None
        for kind, scale, extra, weight in layers:
            if kind == "noise":
                t = tex(tmp, nt, "ShaderNodeTexNoise", tc.outputs["Object"], scale, extra)
                out = t.outputs["Fac"]
            elif kind == "voronoi":
                t = tex(tmp, nt, "ShaderNodeTexVoronoi", tc.outputs["Object"], scale, feature="DISTANCE_TO_EDGE")
                out = t.outputs["Distance"]
            else:
                t = tex(tmp, nt, "ShaderNodeTexWave", tc.outputs["Object"], scale, wave_type="BANDS", bands_direction="X" if kind == "wave" else "Z")
                t.inputs["Distortion"].default_value = 2.0
                out = t.outputs["Fac"]
            mul = tmp.add(nt, "ShaderNodeMath", operation="MULTIPLY")
            mul.inputs[1].default_value = weight
            nt.links.new(out, mul.inputs[0])
            if total is None:
                total = mul.outputs[0]
            else:
                a = tmp.add(nt, "ShaderNodeMath", operation="ADD")
                nt.links.new(total, a.inputs[0])
                nt.links.new(mul.outputs[0], a.inputs[1])
                total = a.outputs[0]
        bmp = tmp.add(nt, "ShaderNodeBump")
        bmp.inputs["Strength"].default_value = strength
        bmp.inputs["Distance"].default_value = dist
        nt.links.new(total, bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], bsdf.inputs["Normal"])
    # Skin, eyes, teeth, mouth: projected from the sculpt. Cloth: only its own surface plus the fabric detail (rays
    # between layered, torn garments land on the wrong layer and flip the shading into black shards).
    dummy = image("ZombieScratch", 64, True)
    sculpted = {"Skin", "Eyes", "Teeth", "Mouth", "Blood"}
    for project in (True, False):
        nodes = []
        for mat in mats:
            nt = mat.node_tree
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = nrm if (mat.name in sculpted) == project else dummy
            nt.nodes.active = t
            nodes.append((nt, t))
        bake_pass(pairs, "NORMAL", samples=2, project=project, normal_space="TANGENT")
        for nt, t in nodes:
            nt.nodes.remove(t)
    bpy.data.images.remove(dummy)
    tmp.undo()
    nrm.pack()
    log("baked normals")

    # Ambient occlusion from the high mesh (cloth folds, armpits, collar, the mouth).
    tmp = Temp(ao)
    for mat in mats:
        tmp.target_node(mat)
    bake_pass(pairs, "AO", samples=48, project=False)
    tmp.undo()
    ao.pack()
    log("baked AO")

    # Albedo: colour attribute x procedural detail x cavity / edge wear from the curvature, as emission.
    tmp = Temp(alb)
    for mat in mats:
        nt = mat.node_tree
        name = mat.name
        bsdf = nt.nodes["Principled BSDF"]
        base = tuple(bsdf.inputs["Base Color"].default_value)[:3]
        tc = tmp.add(nt, "ShaderNodeTexCoord")
        co = tc.outputs["Object"]
        vc = tmp.add(nt, "ShaderNodeVertexColor", layer_name="Col")
        col = vc.outputs["Color"]
        if name not in ("Cloth", "ClothB"):
            col = vmul(tmp, nt, col, base)
        geo = tmp.add(nt, "ShaderNodeNewGeometry")
        cavity = remap(tmp, nt, geo.outputs["Pointiness"], 0.38, 0.5, 0.0, 1.0)  # 0 in creases, 1 on flats/ridges
        if name == "Skin":
            # Pale grey-green with blotchy subsurface reds, dark veins, the pores darker.
            col = vscale(tmp, nt, col, remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 7, 4).outputs["Fac"], 0.3, 0.7, 0.62, 1.08))
            # Smudges of grime on the skin.
            col = vscale(tmp, nt, col, remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 2.2, 5).outputs["Fac"], 0.45, 0.72, 1.0, 0.55))
            red = remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 3.5, 3).outputs["Fac"], 0.5, 0.75, 0.0, 0.55)
            col = mix(tmp, nt, red, col, vmul(tmp, nt, col, (1.35, 0.82, 0.8)))
            ridge = tex(tmp, nt, "ShaderNodeTexNoise", co, 24, 3)
            sub = tmp.add(nt, "ShaderNodeMath", operation="SUBTRACT")
            nt.links.new(ridge.outputs["Fac"], sub.inputs[0])
            sub.inputs[1].default_value = 0.5
            ab = tmp.add(nt, "ShaderNodeMath", operation="ABSOLUTE")
            nt.links.new(sub.outputs[0], ab.inputs[0])
            vein = remap(tmp, nt, ab.outputs[0], 0.0, 0.02, 1.0, 0.0)
            col = mix(tmp, nt, vein, col, vmul(tmp, nt, col, (0.5, 0.56, 0.72)))
            pores = remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexVoronoi", co, 160, feature="DISTANCE_TO_EDGE").outputs["Distance"], 0.0, 0.08, 0.86, 1.0)
            col = vscale(tmp, nt, col, pores)
            col = vscale(tmp, nt, col, remap(tmp, nt, cavity, 0.0, 1.0, 0.55, 1.05))
        elif name in ("Cloth", "ClothB", "Shirt"):
            wa = tex(tmp, nt, "ShaderNodeTexWave", co, 520, wave_type="BANDS", bands_direction="X")
            wb = tex(tmp, nt, "ShaderNodeTexWave", co, 520, wave_type="BANDS", bands_direction="Z")
            w = tmp.add(nt, "ShaderNodeMath", operation="MULTIPLY")
            nt.links.new(wa.outputs["Fac"], w.inputs[0])
            nt.links.new(wb.outputs["Fac"], w.inputs[1])
            col = vscale(tmp, nt, col, remap(tmp, nt, w.outputs[0], 0.0, 1.0, 0.9, 1.04))
            col = vscale(tmp, nt, col, remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 3, 3).outputs["Fac"], 0.3, 0.7, 0.72, 1.06))
            # Grime collects in folds, edges are rubbed lighter.
            col = vscale(tmp, nt, col, remap(tmp, nt, cavity, 0.0, 1.0, 0.5, 1.1))
            if name == "Shirt":
                st = remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 2.6, 2).outputs["Fac"], 0.45, 0.68, 0.0, 1.0)
                col = mix(tmp, nt, st, col, vmul(tmp, nt, col, (0.72, 0.58, 0.38)))
        elif name == "Shoe":
            col = vscale(tmp, nt, col, remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 14, 6).outputs["Fac"], 0.35, 0.65, 0.55, 1.25))
            col = vscale(tmp, nt, col, remap(tmp, nt, cavity, 0.0, 1.0, 0.45, 1.25))
        else:
            col = vscale(tmp, nt, col, remap(tmp, nt, cavity, 0.0, 1.0, 0.6, 1.05))
        if name in ("Cloth", "ClothB", "Shirt"):
            # Filthy: big blotches of grime and vertical drip streaks, as in reference 2.
            col = vscale(tmp, nt, col, remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 1.6, 4).outputs["Fac"], 0.35, 0.7, 0.2, 0.92))
            col = vscale(tmp, nt, col, remap(tmp, nt, tex(tmp, nt, "ShaderNodeTexNoise", co, 6.5, 6).outputs["Fac"], 0.3, 0.7, 0.55, 1.0))
            streak = tex(tmp, nt, "ShaderNodeTexWave", co, 9, 3, wave_type="BANDS", bands_direction="X")
            streak.inputs["Distortion"].default_value = 12.0
            col = vscale(tmp, nt, col, remap(tmp, nt, streak.outputs["Fac"], 0.0, 1.0, 0.55, 1.0))
        col = blood(tmp, nt, vc.outputs["Color"], col)
        em = tmp.add(nt, "ShaderNodeEmission")
        nt.links.new(col, em.inputs["Color"])
        tmp.surface(mat, em.outputs["Emission"])
        tmp.target_node(mat)
    bake_pass(pairs, "EMIT", samples=4, project=False)
    tmp.undo()
    log("baked albedo")

    # Roughness: wet mouth, eyes and blood glossy; dry skin matte with oily patches; cloth matte.
    tmp = Temp(rgh)
    for mat in mats:
        nt = mat.node_tree
        name = mat.name
        lo, hi, scale = bz.ZOMBIE_ROUGH.get(name, (0.25, 0.5, 30) if name == "Mouth" else (0.5, 0.8, 10))
        tc = tmp.add(nt, "ShaderNodeTexCoord")
        nz = tex(tmp, nt, "ShaderNodeTexNoise", tc.outputs["Object"], scale, 6)
        r = remap(tmp, nt, nz.outputs["Fac"], 0.3, 0.7, lo, hi)
        # Blood is wet: glossy where the painted colour is blood.
        vc = tmp.add(nt, "ShaderNodeVertexColor", layer_name="Col")
        wet = tmp.add(nt, "ShaderNodeMix", data_type="FLOAT")
        nt.links.new(blood_mask(tmp, nt, vc.outputs["Color"]), wet.inputs["Factor"])
        nt.links.new(r, wet.inputs[2])
        wet.inputs[3].default_value = 0.32
        r = wet.outputs[0]
        em = tmp.add(nt, "ShaderNodeEmission")
        nt.links.new(r, em.inputs["Color"])
        tmp.surface(mat, em.outputs["Emission"])
        tmp.target_node(mat)
    bake_pass(pairs, "EMIT", samples=2, project=False)
    tmp.undo()
    rgh.pack()
    log("baked roughness")

    # AO into the albedo (the game has its own ambient occlusion only on screen, so keep it subtle).
    import numpy as np
    a = np.empty(ATLAS * ATLAS * 4, dtype=np.float32)
    alb.pixels.foreach_get(a)
    o = np.empty((ATLAS // 2) * (ATLAS // 2) * 4, dtype=np.float32)
    ao.pixels.foreach_get(o)
    o = o.reshape(ATLAS // 2, ATLAS // 2, 4)[:, :, 0]
    o = np.repeat(np.repeat(o, 2, axis=0), 2, axis=1)
    a = a.reshape(ATLAS, ATLAS, 4)
    k = 0.35 + 0.65 * o
    a[:, :, :3] *= k[:, :, None]
    alb.pixels.foreach_set(a.ravel())
    alb.pack()
    bpy.data.images.remove(ao)

    # Wire the maps for export.
    for mat in mats:
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
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
        tr.image = rgh
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tr.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        for img in (alb, nrm, rgh):
            img.save(filepath=str(PREVIEW / f"{img.name}.png"))
    return alb, nrm, rgh


# ---- hair cards -----------------------------------------------------------------------------------------------------

def hair_texture():
    """512 x 512 strand cards: thin wavy strands with tapered tips in alpha, slightly varied brightness."""
    import numpy as np
    n = 512
    img = bpy.data.images.new("ZombieHair", n, n, alpha=True)
    rng = np.random.default_rng(7)
    y = np.linspace(0, 1, n)[:, None]  # along the card (0 root, 1 tip)
    x = np.linspace(0, 1, n)[None, :]
    alpha = np.zeros((n, n), np.float32)
    shade = np.zeros((n, n), np.float32)
    for _ in range(46):
        x0 = rng.uniform(0.04, 0.96)
        w = rng.uniform(0.004, 0.012)
        wave = 0.03 * np.sin(y * rng.uniform(4, 12) + rng.uniform(0, 6)) * y
        length = rng.uniform(0.55, 1.0)
        d = np.abs(x - (x0 + wave))
        strand = np.clip(1 - d / w, 0, 1) * (y < length) * np.clip((length - y) / 0.25, 0, 1)
        alpha = np.maximum(alpha, strand)
        shade = np.maximum(shade, strand * rng.uniform(0.55, 1.0))
    alpha *= np.clip(1.15 - 0.4 * y, 0, 1)
    # Dull, greasy ash brown; greyer towards the tips. Colour is baked in: glTF cannot carry a multiply node.
    lum = 0.55 + 0.45 * shade
    tip = np.clip(y * 1.2, 0, 1)
    r = lum * (0.105 + 0.05 * tip)
    g = lum * (0.09 + 0.045 * tip)
    b = lum * (0.075 + 0.04 * tip)
    px = np.stack([r * np.ones_like(x), g * np.ones_like(x), b * np.ones_like(x), alpha], axis=-1).astype(np.float32)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def hair_material(img):
    mat = CANON.get("Hair") or canon_mat("Hair")
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in ("OUTPUT_MATERIAL", "BSDF_PRINCIPLED"):
            nt.nodes.remove(n)
    bsdf = nt.nodes["Principled BSDF"]
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Specular IOR Level"].default_value = 0.2
    mat.surface_render_method = "DITHERED"
    mat.use_backface_culling = False
    return mat


def head_frame(low):
    """Centre and radii of the skull from the vertices weighted mostly to the head bone."""
    g = low.vertex_groups.get("head")
    pts = []
    if g:
        gi = g.index
        for v in low.data.vertices:
            for e in v.groups:
                if e.group == gi and e.weight > 0.8:
                    pts.append(v.co.copy())
                    break
    if len(pts) < 50:
        return Vector((0, 0.03, 1.665)), Vector((0.08, 0.1, 0.115))
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    # The skull: the upper two thirds of the head region (the jaw and neck stretch the box downwards).
    top = hi.z
    rz = (hi.z - lo.z) * 0.36
    c = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2 - (hi.y - lo.y) * 0.04, top - rz))
    r = Vector(((hi.x - lo.x) / 2 * 0.98, (hi.y - lo.y) / 2 * 0.95, rz))
    return c, r


def grow_hair(k, low, mat):
    """Hair cards over the scalp for variant k; returns the card mesh object (weighted to the head)."""
    c, r = head_frame(low)
    rng = random.Random(1000 + k)
    style = {0: "thin", 1: "crop", 2: "bun", 3: "long"}[k]
    budget = HAIR_BUDGET[k]
    verts, faces, uvs = [], [], []

    def ell(u):
        return Vector((c.x + r.x * u.x, c.y + r.y * u.y, c.z + r.z * u.z))

    def outside(p, pad=1.025):
        d = Vector(((p.x - c.x) / r.x, (p.y - c.y) / r.y, (p.z - c.z) / r.z))
        if d.length < pad:
            return ell(d.normalized() * pad)
        return p

    def card(points, width, u0):
        """A ribbon through points, flat against the head (its side vector tangent to the scalp)."""
        n = len(points)
        base = len(verts)
        for i, p in enumerate(points):
            fwd = (points[min(i + 1, n - 1)] - points[max(i - 1, 0)]).normalized()
            out = Vector(((p.x - c.x) / r.x, (p.y - c.y) / r.y, (p.z - c.z) / r.z)).normalized()
            side = fwd.cross(out)
            if side.length < 1e-4:
                side = Vector((1, 0, 0))
            side.normalize()
            w = width * (1.0 - 0.55 * i / (n - 1))
            verts.append(p - side * w)
            verts.append(p + side * w)
            t = i / (n - 1)
            uvs.append((u0, t))
            uvs.append((u0 + 0.25, t))
        for i in range(n - 1):
            a = base + i * 2
            faces.append((a, a + 1, a + 3, a + 2))

    def strand(root_u, length, segs, droop, width, wild=0.0, target=None):
        p = ell(root_u * 0.995)
        normal = Vector((root_u.x / r.x, root_u.y / r.y, root_u.z / r.z)).normalized()
        # Comb direction: back and down over the skull, tangent to it, plus a little lift at the root.
        comb = Vector((root_u.x * 0.6, -0.8, -0.35 - 0.6 * max(0.0, -root_u.z))).normalized()
        comb = (comb - normal * comb.dot(normal)).normalized()
        d = (comb + normal * 0.25).normalized()
        pts = [p]
        step = length / segs
        for s in range(segs):
            if target is not None:
                d = d.lerp((target - p).normalized(), 0.35)
            else:
                # Follow the scalp (tangent) and sag with gravity once past the edge of the skull.
                q = Vector(((p.x - c.x) / r.x, (p.y - c.y) / r.y, (p.z - c.z) / r.z))
                nrm = q.normalized()
                tangent = (d - nrm * d.dot(nrm)).normalized()
                d = (tangent * (1.0 - 0.5 * droop) + Vector((0, -0.05, -1.0)) * droop * 0.5).normalized()
            jitter = Vector((mn.noise(p * 30 + Vector((k, s, 0))), mn.noise(p * 30 + Vector((0, k, s))), 0)) * wild
            p = outside(p + (d + jitter) * step)
            pts.append(p)
        card(pts, width, rng.choice((0.0, 0.25, 0.5, 0.75)))
        return segs * 2

    def scalp_point(front_limit, back_low=-0.55):
        """Random point on the hair-bearing part of the skull (top, sides, back; not the face or below the ears)."""
        for _ in range(200):
            u = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.2, 1)))
            if u.length < 0.2:
                continue
            u.normalize()
            if u.z < back_low:
                continue
            if u.y > front_limit and u.z < 0.75:  # forehead and face
                continue
            if u.z < 0.05 and abs(u.x) > 0.75 and u.y > -0.3:  # in front of the ears
                continue
            return u
        return Vector((0, 0, 1))

    used = 0
    if style == "thin":
        # Thin, greasy, dishevelled: sparse cards, bald patches, some strands sticking out.
        while used < budget:
            u = scalp_point(0.35)
            if mn.noise(u * 2.4 + Vector((3, 1, 0))) > 0.3:  # bald patches
                used += 1
                continue
            wild = 0.35 if rng.random() < 0.15 else 0.08
            used += strand(u, rng.uniform(0.06, 0.13), 5, rng.uniform(0.3, 0.8), rng.uniform(0.009, 0.014), wild)
    elif style == "crop":
        # Short crop at the back and sides, under the pillbox cap.
        while used < budget:
            u = scalp_point(0.1, back_low=-0.6)
            if u.z > 0.55:
                used += 1
                continue
            used += strand(u, rng.uniform(0.025, 0.045), 3, 0.8, 0.011, 0.1)
    elif style == "bun":
        bun = ell(Vector((0, -0.82, 0.42)) * 1.08)
        while used < budget * 0.7:
            u = scalp_point(0.4)
            used += strand(u, ((ell(u) - bun).length) * 1.1, 5, 0.2, 0.013, 0.05, target=bun)
        # The bun itself: curled cards around a ball.
        for i in range(int((budget * 0.3) / 10)):
            a = rng.uniform(0, math.tau)
            b = rng.uniform(-1, 1)
            rad = 0.042
            pts = []
            for s in range(6):
                t = a + s * 0.5
                pts.append(bun + Vector((math.cos(t) * rad * math.sqrt(1 - b * b), -0.02 + math.sin(t) * rad * 0.8, b * rad + math.sin(t * 0.5) * 0.004)))
            card(pts, 0.012, 0.25)
            used += 10
    else:
        # Long, matted, falling to the shoulders.
        while used < budget:
            u = scalp_point(0.45)
            used += strand(u, rng.uniform(0.25, 0.4), 7, 1.0, rng.uniform(0.012, 0.018), 0.08)
    mesh = bpy.data.meshes.new(f"Hair_{k}")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    uvl = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            uvl.data[li].uv = uvs[vi]
        poly.use_smooth = True
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(f"Hair_{k}", mesh)
    bpy.context.scene.collection.objects.link(obj)
    g = obj.vertex_groups.new(name="head")
    g.add(list(range(len(verts))), 1.0, "REPLACE")
    log(f"variant {k}: hair {style}, {len(faces) * 2} tris")
    return obj


# ---- split into dismemberment groups --------------------------------------------------------------------------------

def split_parts(k, low, arm):
    gidx = {g.index: g.name for g in low.vertex_groups}
    part_of_bone = {b: part for part, bones in PART_BONES.items() for b in bones}
    vpart = []
    for v in low.data.vertices:
        acc = {}
        for e in v.groups:
            part = part_of_bone.get(gidx.get(e.group), "Body")
            acc[part] = acc.get(part, 0.0) + e.weight
        vpart.append(acc)
    face_part = []
    for poly in low.data.polygons:
        acc = {}
        for vi in poly.vertices:
            for part, w in vpart[vi].items():
                acc[part] = acc.get(part, 0.0) + w
        face_part.append(max(acc, key=acc.get) if acc else "Body")
    out = []
    for part in PARTS:
        obj = low.copy()
        obj.data = low.data.copy()
        obj.name = f"Zombie_{part}_{k}"
        obj.data.name = obj.name
        bpy.context.scene.collection.objects.link(obj)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if face_part[f.index] != part], context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(obj.data)
        bm.free()
        obj.parent = arm
        mod = obj.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
        out.append(obj)
        log(f"  {obj.name}: {bz.tris(obj)} tris")
    bpy.data.objects.remove(low)
    return out


# ---- animation ------------------------------------------------------------------------------------------------------

def shamble(arm):
    """The walk: 1.3 s, slow and heavy. The left leg steps, the right one drags its toe through each stride; the body
    rolls over the planted leg, the head lolls to one side, the left arm swings a little, the right hangs dead."""
    base = {
        "hips": (6, 0, 0), "spine": (10, 0, 3), "chest": (8, 0, 5), "neck": (10, 0, 0), "head": (-6, 6, 9),
        "hand.L": (-16, 0, 0), "hand.R": (-24, 0, 0),
    }

    def pose(ph):
        s = math.sin(ph * math.tau)
        c = math.cos(ph * math.tau)
        lift = max(0.0, c)  # left leg in swing for the first half
        drag = max(0.0, -c)  # right leg swings (dragging) for the second half
        b = dict(base)
        b.update({
            # Weight rolls onto the planted leg: hips tilt and twist, the torso counters.
            "hips": (6 + 2 * abs(s), 3 * s, 9 * s),
            "spine": (11 + 2 * abs(c), -4 * s, 3 - 3 * s),
            "chest": (8, -3 * s, 5 + 2 * c),
            "neck": (10 + 3 * abs(s), 0, -3 * s),
            "head": (-6 + 3 * math.sin(ph * 2 * math.tau + 0.6), 6 + 4 * s, 9 + 3 * s),
            # Left: a proper, if stiff, step.
            "thigh.L": (24 * s + 4, 0, -2), "shin.L": (-10 - 38 * lift, 0, 0), "foot.L": (12 * lift - 8 * s, 0, 0),
            # Right: barely lifts, the knee stays stiff, the foot turned out and scuffing.
            "thigh.R": (-12 * s + 2, 0, 8), "shin.R": (-6 - 9 * drag, 0, 0), "foot.R": (-14 + 8 * drag, 0, 10),
            # Arms: left swings slightly against the step, the right hangs, bouncing with each footfall.
            "upperarm.L": (22 - 9 * s, 0, -10), "forearm.L": (30 + 6 * c, 0, 0),
            "upperarm.R": (6 + 3 * s + 3 * abs(c), 0, 10), "forearm.R": (12 + 4 * abs(s), 0, 0),
        })
        # Hips location (lateral, vertical, forward) in bone space: sway over the planted foot, dip on the dragging leg.
        return b, (-0.045 * s, -0.04 + 0.025 * lift - 0.015 * drag, 0)

    n = round(1.3 * bz.FPS)
    keys = 16
    bz.keyframes(arm, "walk", [(round(i * n / keys) + 1, *pose(i / keys)) for i in range(keys + 1)])


def animate(arm):
    # The clips are keyed at build_zombies.FPS; the input file may carry another scene rate (stage 1 saves at 24).
    bpy.context.scene.render.fps = bz.FPS
    bpy.context.scene.render.fps_base = 1.0
    arm.data.pose_position = "POSE"
    bz.zombie_anims(arm)
    # Replace the old walk with the heavy shamble.
    ad = arm.animation_data
    for t in list(ad.nla_tracks):
        if t.name == "walk":
            ad.nla_tracks.remove(t)
    old = bpy.data.actions.get("walk")
    if old:
        old.name = "walk_old"
        old.use_fake_user = False
        bpy.data.actions.remove(old)
    shamble(arm)
    log("clips:", sorted(t.name for t in ad.nla_tracks))


# ---- export ---------------------------------------------------------------------------------------------------------

def export(arm):
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for c in arm.children_recursive:
        c.select_set(True)
    bpy.context.view_layer.objects.active = arm
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "zombie.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
        export_materials="EXPORT", export_image_format="WEBP", export_image_quality=80, export_image_webp_fallback=False,
        export_normals=True, export_texcoords=True, export_vertex_color="NONE", export_animations=True,
        export_animation_mode="ACTIONS", export_skins=True, export_def_bones=False, export_morph=False,
        export_lights=False, export_cameras=False, export_extras=False, export_anim_slide_to_zero=True,
        export_force_sampling=True, export_frame_step=1,
    )
    patch_glb(path)
    log(f"EXPORTED {path} ({path.stat().st_size / 1e6:.2f} MB)")
    return path


def patch_glb(path):
    """Hair: alpha-tested and double-sided (the exporter writes BLEND for dithered alpha)."""
    data = path.read_bytes()
    magic, version, total = struct.unpack_from("<III", data, 0)
    jlen, jtype = struct.unpack_from("<II", data, 12)
    doc = json.loads(data[20:20 + jlen])
    for m in doc.get("materials", []):
        if m.get("name") in ("Cloth", "ClothB", "Shirt"):
            m["doubleSided"] = True  # torn garments: the inside of a tear must not show through
        if m.get("name") == "Hair":
            m["alphaMode"] = "MASK"
            m["alphaCutoff"] = 0.35
            m["doubleSided"] = True
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    rest = data[20 + jlen:]
    out = struct.pack("<III", magic, version, 12 + 8 + len(js) + len(rest)) + struct.pack("<II", len(js), jtype) + js + rest
    path.write_bytes(out)


# ---- main -----------------------------------------------------------------------------------------------------------

def main():
    random.seed(3)
    src = load_input()
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    arm = find_armature()
    sets = [variant_objects(k) for k in range(4)]  # duplicates made before anything is modified
    lows = [prepare(k, arm, low, False) for k, (low, _h) in enumerate(sets)]
    highs = [prepare(k, arm, high, True) for k, (_l, high) in enumerate(sets)]
    for m in CONTRACT_MATS:
        canon_mat(m)
    unwrap(lows, arm)
    bake_all(list(zip(highs, lows)))
    for h in highs:
        bpy.data.objects.remove(h)
    hmat = hair_material(hair_texture())
    parts = []
    for k, low in enumerate(lows):
        while low.data.color_attributes:
            low.data.color_attributes.remove(low.data.color_attributes[0])
        hair = grow_hair(k, low, hmat)
        # The hair joins the head group (decapitation takes it along).
        groups = split_parts(k, low, arm)
        head = next(o for o in groups if o.name.startswith("Zombie_Head_"))
        bpy.ops.object.select_all(action="DESELECT")
        hair.select_set(True)
        head.select_set(True)
        bpy.context.view_layer.objects.active = head
        bpy.ops.object.join()
        parts += groups
        log(f"variant {k}: {sum(bz.tris(o) for o in groups)} tris total")
    # Anything else from the input (helpers, stray meshes) stays out of the export.
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o not in parts:
            bpy.data.objects.remove(o)
    animate(arm)
    export(arm)
    log("source:", src)


if __name__ == "__main__":
    main()
