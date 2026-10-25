"""
Last Light zombies, stage 1 of 3: the armature and four base bodies with heads.

    blender --background --factory-startup --python stage1_body.py -- [out.blend] [--preview <dir>]

Writes out/zombie_body.blend (next to this script unless a path is given):
  * `Zombie` armature (collection `Rig`) with the bone names the game relies on (root, hips, spine, chest, neck, head,
    upperarm/forearm/hand/thigh/shin/foot .L/.R). Blender +Y is the front, origin at the feet, ~1.78 m tall.
  * Collections V0..V3, one per variant (0 businessman = reference 2, 1 bellhop, 2 housekeeper, 3 businesswoman), each
    with `V<k>_Body` (skinned body with hands, fingers and feet), `V<k>_Head` (skull, face, lids, ears), `V<k>_Eyes`,
    `V<k>_Teeth`, `V<k>_Mouth` (interior and gums) and `V<k>_Nails`.
Every mesh is parented to the armature with automatic (heat) weights on the body and rigid head weights on the head
parts. Detail lives in live modifiers so later stages can choose: Subdivision (viewport 1, render 2) and Displace
(pores, wrinkles, veins) before the Armature modifier. The base meshes (modifiers off) are the export topology.

Modelling: the bodies are Skin-modifier hulls over a joint graph (torso, limbs, palm, 3-joint fingers, thumb, foot),
subdivided, then shaped by scripted sculpt strokes (gaussian push/pull along the normal: collarbones, ribs, sternum,
sunken belly, hip bones, shoulder blades, spine, neck tendons, knees, elbows, knuckles, breasts). Heads are a quad
sphere shaped into a skull and gaunt face (orbits, brow, cheekbones, hollow cheeks and temples, nose, jaw, chin), with
the mouth cut open and rolled inwards, separate milky eyeballs under heavy lid caps, irregular yellowed teeth, a dark
mouth interior and cartilage-shaped ears (helix, antihelix, concha, tragus, lobe).
"""

import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
PREVIEW = None
if "--preview" in ARGS:
    i = ARGS.index("--preview")
    PREVIEW = Path(ARGS[i + 1])
    del ARGS[i : i + 2]
OUT = Path(ARGS[0]) if ARGS else HERE / "out" / "zombie_body.blend"

# ---- rig (same joints as build_zombies.py, so the clips keep working) -----------------------------------------------

BONES = [
    ("root", None, (0, 0, 0), (0, 0.25, 0)),
    ("hips", "root", (0, 0, 0.96), (0, 0, 1.08)),
    ("spine", "hips", (0, 0, 1.08), (0, 0.01, 1.26)),
    ("chest", "spine", (0, 0.01, 1.26), (0, 0, 1.45)),
    ("neck", "chest", (0, 0, 1.45), (0, 0.02, 1.56)),
    ("head", "neck", (0, 0.02, 1.56), (0, 0.02, 1.76)),
]
for _s, _x in (("L", -1), ("R", 1)):
    BONES += [
        (f"upperarm.{_s}", "chest", (_x * 0.17, 0, 1.42), (_x * 0.33, 0.0, 1.17)),
        (f"forearm.{_s}", f"upperarm.{_s}", (_x * 0.33, 0.0, 1.17), (_x * 0.44, 0.03, 0.94)),
        (f"hand.{_s}", f"forearm.{_s}", (_x * 0.44, 0.03, 0.94), (_x * 0.48, 0.05, 0.8)),
        (f"thigh.{_s}", "hips", (_x * 0.1, 0, 0.95), (_x * 0.11, 0.01, 0.51)),
        (f"shin.{_s}", f"thigh.{_s}", (_x * 0.11, 0.01, 0.51), (_x * 0.12, -0.02, 0.09)),
        (f"foot.{_s}", f"shin.{_s}", (_x * 0.12, -0.02, 0.09), (_x * 0.12, 0.15, 0.02)),
    ]
JOINT = {n: (Vector(h), Vector(t)) for n, _, h, t in BONES}

# ---- variants ---------------------------------------------------------------------------------------------------------

VARIANTS = [
    # 0: the reference: a gaunt middle-aged businessman.
    dict(name="businessman", female=False, gaunt=1.0, bulk=0.95, shoulder=0.175, hip=0.15, bust=0.0, belly=0.0, age=1.0,
         jaw=1.0, nose=1.0, brow=1.0, seed=11, head_scale=1.0),
    # 1: a younger bellhop: lean, less wasted.
    dict(name="bellhop", female=False, gaunt=0.6, bulk=0.92, shoulder=0.168, hip=0.145, bust=0.0, belly=0.0, age=0.4,
         jaw=0.95, nose=0.9, brow=0.8, seed=23, head_scale=0.98),
    # 2: a middle-aged housekeeper: heavier, wider hips.
    dict(name="housekeeper", female=True, gaunt=0.45, bulk=1.06, shoulder=0.158, hip=0.172, bust=0.8, belly=0.6, age=0.8,
         jaw=0.85, nose=0.85, brow=0.55, seed=37, head_scale=0.96),
    # 3: a businesswoman: slim, gaunt.
    dict(name="businesswoman", female=True, gaunt=0.85, bulk=0.88, shoulder=0.152, hip=0.158, bust=0.55, belly=0.0, age=0.5,
         jaw=0.8, nose=0.8, brow=0.5, seed=53, head_scale=0.95),
]

BODY_TRIS = 18000
HEAD_TRIS = 9000
HEAD_C = Vector((0, 0.03, 1.665))
HEAD_R = Vector((0.072, 0.098, 0.118))


# ---- helpers ----------------------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.textures, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            block.remove(item)


def link(obj, coll=None):
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj


def activate(obj):
    bpy.context.view_layer.update()
    for o in list(bpy.context.view_layer.objects):
        if o is not None:
            o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifiers(obj):
    activate(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    return obj


def bake_location(obj):
    """Moves the object's location into its mesh (origin back at 0), so later joins and moves stay put."""
    obj.data.transform(Matrix.Translation(obj.location))
    obj.location = (0, 0, 0)
    return obj


def smooth_shade(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def gauss(p, c, r):
    return math.exp(-((p - c).length_squared) / (r * r))


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
    return (p - (a + ab * t)).length


def gauss_seg(p, a, b, r):
    d = seg_dist(p, a, b)
    return math.exp(-(d * d) / (r * r))


def deform(obj, fn):
    """Scripted sculpt stroke: fn(co, normal) -> displacement Vector (or None) for every vertex."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    moves = []
    for v in bm.verts:
        d = fn(v.co.copy(), v.normal.copy())
        if d is not None:
            moves.append((v, d))
    for v, d in moves:
        v.co += d
    bm.to_mesh(me)
    bm.free()
    me.update()


def relax(obj, iterations=2, factor=0.5):
    """Laplacian smoothing pass (like a sculpt Smooth brush over everything) to blend the strokes."""
    mod = obj.modifiers.new("Relax", "SMOOTH")
    mod.factor = factor
    mod.iterations = iterations
    apply_modifiers(obj)


_tex_cache = {}


def tex(name, kind, size, **kw):
    if name in _tex_cache:
        return _tex_cache[name]
    t = bpy.data.textures.new(name, kind)
    t.noise_scale = size
    for k, v in kw.items():
        setattr(t, k, v)
    _tex_cache[name] = t
    return t


def add_detail(obj, layers, subdivide=True):
    """Optional Subdivision (viewport 1, render 2), then Displace layers [(texture, strength)] in local space."""
    if subdivide:
        sub = obj.modifiers.new("Subdivision", "SUBSURF")
        sub.levels = 1
        sub.render_levels = 2
        sub.quality = 3
    for i, (t, strength) in enumerate(layers):
        d = obj.modifiers.new(f"Detail{i}", "DISPLACE")
        d.texture = t
        d.strength = strength
        d.mid_level = 0.5
        d.texture_coords = "LOCAL"


# ---- materials ------------------------------------------------------------------------------------------------------

def principled(name, color, rough=0.5, sss=0.0, sss_radius=(0.8, 0.3, 0.25), spec=0.5):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    try:
        b.inputs["Subsurface Weight"].default_value = sss
        b.inputs["Subsurface Radius"].default_value = sss_radius
        b.inputs["Specular IOR Level"].default_value = spec
    except KeyError:
        pass
    mat.diffuse_color = (*color, 1)
    return mat


def skin_material():
    """Preview skin: pale grey with green-violet mottling and darker veins (stage 3 replaces it with bakes)."""
    mat = principled("Skin", (0.55, 0.52, 0.47), rough=0.55, sss=0.12)
    nt = mat.node_tree
    b = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 22.0
    noise.inputs["Detail"].default_value = 8.0
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.40, 0.40, 0.36, 1)
    ramp.color_ramp.elements[1].color = (0.62, 0.57, 0.52, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = 9.0
    nt.links.new(tc.outputs["Object"], vor.inputs["Vector"])
    vr = nt.nodes.new("ShaderNodeMapRange")
    vr.inputs["From Min"].default_value = 0.0
    vr.inputs["From Max"].default_value = 0.03
    vr.inputs["To Min"].default_value = 0.88
    vr.inputs["To Max"].default_value = 1.0
    nt.links.new(vor.outputs["Distance"], vr.inputs["Value"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], mix.inputs[6])
    veins = nt.nodes.new("ShaderNodeCombineColor")
    nt.links.new(vr.outputs["Result"], veins.inputs[0])
    nt.links.new(vr.outputs["Result"], veins.inputs[1])
    veins.inputs[2].default_value = 1.0
    nt.links.new(veins.outputs["Color"], mix.inputs[7])
    nt.links.new(mix.outputs[2], b.inputs["Base Color"])
    return mat


def eye_material():
    """Milky eyes: off-white with a faint grey clouded iris where the surface faces +Y (object-space normal)."""
    mat = principled("Eyes", (0.78, 0.78, 0.74), rough=0.12, sss=0.2)
    nt = mat.node_tree
    b = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Normal"], sep.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.86
    mr.inputs["From Max"].default_value = 0.95
    nt.links.new(sep.outputs["Y"], mr.inputs["Value"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (0.80, 0.79, 0.74, 1)
    mix.inputs[7].default_value = (0.58, 0.60, 0.60, 1)
    nt.links.new(mr.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(mix.outputs[2], b.inputs["Base Color"])
    return mat


def materials():
    return {
        "skin": skin_material(),
        "eyes": eye_material(),
        "teeth": principled("Teeth", (0.62, 0.52, 0.32), rough=0.35, sss=0.1),
        "mouth": principled("Mouth", (0.09, 0.025, 0.02), rough=0.4),
        "gums": principled("Gums", (0.28, 0.08, 0.07), rough=0.3, sss=0.2),
        "nails": principled("Nails", (0.48, 0.44, 0.36), rough=0.35),
    }


# ---- armature -------------------------------------------------------------------------------------------------------

def build_armature(coll):
    data = bpy.data.armatures.new("Zombie")
    arm = link(bpy.data.objects.new("Zombie", data), coll)
    activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    for name, parent, h, t in BONES:
        b = eb.new(name)
        b.head = Vector(h)
        b.tail = Vector(t)
        b.align_roll(Vector((0, 0, 1)) if name == "root" or name.startswith("foot") else Vector((0, 1, 0)))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        b.use_deform = name != "root"
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm


# ---- body sculpt ----------------------------------------------------------------------------------------------------

def sculpt_body(obj, s, knuckles):
    G = s["gaunt"]
    fem = s["female"]
    rng = random.Random(s["seed"])

    def fn(p, n):
        d = Vector()
        x, y, z = p
        ax = abs(x)
        front = smoothstep(0.1, 0.6, n.y)
        back = smoothstep(0.1, 0.6, -n.y)
        torso = ax < 0.2 and 0.85 < z < 1.5
        if torso:
            # Collarbones: a ridge rising towards the shoulders, a hollow above it.
            zc = 1.432 + 0.018 * (ax / 0.15)
            if 0.015 < ax < 0.17:
                ridge = math.exp(-(((z - zc) / 0.009) ** 2))
                hollow = math.exp(-(((z - zc - 0.022) / 0.012) ** 2))
                d += n * (front * ((0.0045 + 0.003 * G) * ridge - 0.004 * G * hollow))
            # Ribs: arcs that drop towards the flanks, fading at the sternum and under the pectorals.
            if 1.12 < z < 1.38 and n.y > -0.3:
                zr = z + 0.055 * (ax / 0.14) ** 2
                wave = math.cos(2 * math.pi * (zr - 1.12) / 0.031)
                mask = smoothstep(1.12, 1.17, z) * (1 - smoothstep(1.32, 1.38, z)) * (1 - math.exp(-((x / 0.022) ** 2)))
                if fem:
                    mask *= 0.35
                wave += 0.35 * math.sin(x * 61 + z * 17)
                d += n * (0.0016 * G * mask * wave * (0.4 + 0.6 * max(front, smoothstep(0.3, 0.8, abs(n.x)))))
            # Sternum groove.
            if 1.18 < z < 1.43:
                d -= n * (0.003 * G * front * math.exp(-((x / 0.011) ** 2)))
            # A sunken belly under the ribcage.
            if 0.98 < z < 1.14:
                m = smoothstep(0.98, 1.03, z) * (1 - smoothstep(1.1, 1.14, z)) * front
                d -= n * (0.012 * G * m * math.exp(-((x / 0.09) ** 2)))
                d += n * (0.02 * s["belly"] * m * math.exp(-((x / 0.11) ** 2)))
            # Hip bones.
            for sx in (-1, 1):
                d += n * (0.006 * G * gauss(p, Vector((sx * 0.118, 0.055, 0.985)), 0.028))
                # Shoulder blades and the spine groove.
                d += n * (0.006 * (0.4 + G) * back * gauss(p, Vector((sx * 0.085, -0.085, 1.33)), 0.045))
                # Pectorals (men) or breasts (women).
                if fem:
                    c = Vector((sx * 0.082, 0.085, 1.285 - 0.01 * s["bust"]))
                    d += n * (0.034 * s["bust"] * front * gauss(p, c, 0.062))
                else:
                    d += n * (0.004 * (1 - G) * front * gauss(p, Vector((sx * 0.07, 0.09, 1.34)), 0.05))
            if 0.95 < z < 1.46:
                d -= n * (0.0045 * back * math.exp(-((x / 0.012) ** 2)))
        # Neck: two tendons from behind the ears to the top of the sternum, the notch between them, an Adam's apple.
        if 1.43 < z < 1.65 and ax < 0.08:
            for sx in (-1, 1):
                a = Vector((sx * 0.044, -0.008, 1.6))
                bb = Vector((sx * 0.012, 0.046, 1.462))
                d += n * ((0.0045 + 0.0035 * G) * gauss_seg(p, a, bb, 0.008))
            d -= n * (0.006 * G * gauss(p, Vector((0, 0.05, 1.463)), 0.012))
            if not fem:
                d += n * (0.005 * gauss(p, Vector((0, 0.05, 1.535)), 0.011))
        # Bony elbows and knees.
        for sx in (-1, 1):
            S = "R" if sx > 0 else "L"
            el = JOINT[f"forearm.{S}"][0]
            d += n * (0.0045 * gauss(p, el + Vector((0, -0.028, 0.006)), 0.014))
            kn = JOINT[f"shin.{S}"][0]
            d += n * (0.006 * gauss(p, kn + Vector((0, 0.05, 0.0)), 0.026))
            # Wrist bone (ulna head).
            wr = JOINT[f"hand.{S}"][0]
            d += n * (0.0025 * gauss(p, wr + Vector((sx * 0.012, -0.012, 0.004)), 0.008))
        # Knuckles on the back of the hand.
        for k, dorsal in knuckles:
            w = gauss(p, k + dorsal * 0.008, 0.009)
            if w > 0.01:
                d += n * (0.0028 * w * max(0.0, n.dot(dorsal)))
        # A little asymmetric lumpiness: bloating and wasting under the skin.
        d += n * (0.0015 * math.sin(x * 37 + rng.random()) * math.sin(z * 29) * math.sin(y * 41))
        return d

    deform(obj, fn)


# ---- anatomical forms ---------------------------------------------------------------------------------------------
# Every body part is a closed mesh form (ellipsoids, a lofted torso, tapered limb tubes). The forms of one body or head
# are fused into a single surface with a voxel remesh, smoothed (like a sculpt Smooth pass over the seams) and then
# sculpted with the scripted strokes; booleans carve the eye sockets, mouth and nostrils.


class Forms:
    def __init__(self):
        self.bm = bmesh.new()

    def ellipsoid(self, c, r, rot=None, segs=28, rings=18):
        geom = bmesh.ops.create_uvsphere(self.bm, u_segments=segs, v_segments=rings, radius=1.0)
        m = Matrix.Translation(Vector(c)) @ (rot if rot is not None else Matrix.Identity(4)) @ Matrix.Diagonal((r[0], r[1], r[2], 1))
        bmesh.ops.transform(self.bm, matrix=m, verts=geom["verts"])

    def tube(self, pts, radii, segs=24, up=Vector((0, 0, 1)), caps=True):
        """A closed tapered tube through pts; radii are floats or (rx, ry), ry measured towards `up`."""
        pts = [Vector(p) for p in pts]
        rings = []
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            u = up - t * up.dot(t)
            if u.length < 1e-6:
                u = Vector((1, 0, 0)) - t * t.x
            u.normalize()
            v = t.cross(u)
            r = radii[i] if isinstance(radii[i], tuple) else (radii[i], radii[i])
            ring = [self.bm.verts.new(p + v * (math.cos(a) * r[0]) + u * (math.sin(a) * r[1])) for a in (2 * math.pi * k / segs for k in range(segs))]
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for k in range(segs):
                self.bm.faces.new((a[k], a[(k + 1) % segs], b[(k + 1) % segs], b[k]))
        if caps:
            for ring, p, flip in ((rings[0], pts[0], True), (rings[-1], pts[-1], False)):
                c = self.bm.verts.new(p)
                for k in range(segs):
                    q = (ring[k], ring[(k + 1) % segs], c)
                    self.bm.faces.new(q[::-1] if flip else q)
            for p, r in ((pts[0], radii[0]), (pts[-1], radii[-1])):
                rr = r if isinstance(r, tuple) else (r, r)
                m = min(rr)
                self.ellipsoid(p, (m, m, m), segs=16, rings=10)

    def loft(self, sections, segs=48):
        """Closed loft through horizontal cross-sections [(z, centre_y, half_width, front, back, squareness)]."""
        rings = []
        for z, cy, a, bf, bb, n in sections:
            ring = []
            for k in range(segs):
                t = 2 * math.pi * k / segs
                c, s_ = math.cos(t), math.sin(t)
                x = a * math.copysign(abs(c) ** (2 / n), c)
                b = bf if s_ > 0 else bb
                y = cy + b * math.copysign(abs(s_) ** (2 / n), s_)
                ring.append(self.bm.verts.new((x, y, z)))
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for k in range(segs):
                self.bm.faces.new((a[k], a[(k + 1) % segs], b[(k + 1) % segs], b[k]))
        for ring, sec, flip in ((rings[0], sections[0], True), (rings[-1], sections[-1], False)):
            c = self.bm.verts.new((0, sec[1], sec[0]))
            for k in range(segs):
                q = (ring[k], ring[(k + 1) % segs], c)
                self.bm.faces.new(q[::-1] if flip else q)

    def add_mesh(self, obj):
        me = obj.data.copy()
        me.transform(obj.matrix_world)
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)

    def to_object(self, name, coll):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        return link(bpy.data.objects.new(name, me), coll)


def fuse(obj, voxel, smooth_iter=6, smooth_factor=0.5, coarse=None, subdivide=2):
    """Voxel remesh (the union of all forms) then smoothing. With `coarse`, a coarse remesh first rounds every
    concave seam into a fillet (like blocking out with a big brush) and subdivision makes that surface smooth again."""
    if coarse:
        c = obj.modifiers.new("Block", "REMESH")
        c.mode = "VOXEL"
        c.voxel_size = coarse
        c.adaptivity = 0.0
        sub = obj.modifiers.new("Smooth", "SUBSURF")
        sub.levels = subdivide
        apply_modifiers(obj)
        if not voxel:
            smooth_shade(obj)
            return obj
    r = obj.modifiers.new("Fuse", "REMESH")
    r.mode = "VOXEL"
    r.voxel_size = voxel
    r.adaptivity = 0.0
    r.use_smooth_shade = True
    apply_modifiers(obj)
    if smooth_iter:
        # Laplacian smoothing keeps the volume (thin fingers and lips survive) while the seams between forms melt.
        m = obj.modifiers.new("Blend", "LAPLACIANSMOOTH")
        m.iterations = smooth_iter
        m.lambda_factor = smooth_factor
        m.lambda_border = 0.0
        m.use_volume_preserve = True
        m.use_normalized = True
        apply_modifiers(obj)
    smooth_shade(obj)
    return obj


def carve(obj, cutters, coll):
    """Boolean difference of the cutter forms from obj."""
    cut = cutters.to_object("cutter", coll)
    b = obj.modifiers.new("Carve", "BOOLEAN")
    b.operation = "DIFFERENCE"
    b.solver = "EXACT"
    b.object = cut
    apply_modifiers(obj)
    bpy.data.objects.remove(cut, do_unlink=True)
    return obj


def low_copy(high, name, tris_target):
    """Export topology: a decimated copy of the dense sculpt (the dense one stays for normal-map bakes)."""
    me = high.data.copy()
    low = link(bpy.data.objects.new(name, me), high.users_collection[0])
    low.matrix_world = high.matrix_world
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    if n > tris_target:
        d = low.modifiers.new("Decimate", "DECIMATE")
        d.ratio = tris_target / n
        d.use_collapse_triangulate = True
        apply_modifiers(low)
    smooth_shade(low)
    return low


# ---- bodies -----------------------------------------------------------------------------------------------------------

def hand_frame(sx):
    """Wrist, along-the-hand axis, palm normal (towards the body), and the thumb-side axis for side sx (+1 right)."""
    w, t = JOINT[f"hand.{'R' if sx > 0 else 'L'}"]
    d = (t - w).normalized()
    n = Vector((-sx, 0.0, 0.0))
    n = (n - d * n.dot(d)).normalized()
    side = d.cross(n).normalized()
    if side.y < 0:
        side = -side
    return w, d, n, side


FINGERS = [
    # name, offset across the knuckles (towards the thumb side), phalanx lengths, base radius
    ("index", 1.5, (0.042, 0.025, 0.02), 0.0086),
    ("middle", 0.5, (0.047, 0.028, 0.021), 0.009),
    ("ring", -0.5, (0.044, 0.026, 0.02), 0.0084),
    ("pinky", -1.5, (0.034, 0.02, 0.018), 0.0072),
]


def rotate_towards(v, towards, angle):
    axis = v.cross(towards)
    if axis.length < 1e-9:
        return v.copy()
    return (Matrix.Rotation(angle, 3, axis.normalized()) @ v).normalized()


def hand_forms(f, sx, s, tips, knuckles):  # noqa: C901
    w, d, n, side = hand_frame(sx)
    k = 0.95 if s["female"] else 1.0
    thin = 1.0 - 0.1 * s["gaunt"]
    rot = Matrix((side, d, n)).transposed().to_4x4()
    # Palm: a flattened block, thicker at the heel; thenar (thumb) and hypothenar pads.
    f.ellipsoid(w + d * 0.047 * k, (0.041 * k, 0.05 * k, 0.0135 * thin), rot)
    f.ellipsoid(w + d * 0.028 * k + side * 0.017 + n * 0.008, (0.018, 0.026, 0.011), rot)
    f.ellipsoid(w + d * 0.035 * k - side * 0.022 + n * 0.005, (0.013, 0.028, 0.009), rot)
    for i, (name, off, lens, rad) in enumerate(FINGERS):
        base = w + d * (0.088 * k) + side * (off * 0.0215 * k)
        knuckles.append((base.copy(), -n))
        fd = rotate_towards(d, side, math.radians(3 * off))
        curl = [math.radians(a) for a in (16 + 3 * i, 26 + 2 * i, 20)]
        pts = [base - fd * 0.012]
        rads = [rad * 1.08 * thin]
        p = base.copy()
        r = rad * thin
        for j, ln in enumerate(lens):
            fd = rotate_towards(fd, n, curl[j])
            # Each phalanx: thick at the joint, waisted in the middle (bony zombie fingers).
            mid = p + fd * ln * k * 0.5
            p = p + fd * ln * k
            pts += [mid, p.copy()]
            rads += [r * (0.8 if s["gaunt"] > 0.5 else 0.88), r * 0.9]
            r *= 0.88
        f.tube(pts, rads, segs=14, up=-n)
        tips.append((p.copy(), fd.copy(), -n, r))
    tb = w + d * 0.025 + side * 0.026 + n * 0.006
    td = rotate_towards(rotate_towards(d, side, math.radians(40)), n, math.radians(30))
    pts, rads = [tb], [0.0125 * thin]
    p, r = tb.copy(), 0.0118 * thin
    for j, ln in enumerate((0.034, 0.03, 0.026)):
        td = rotate_towards(td, n, math.radians((8, 16, 14)[j]))
        mid = p + td * ln * k * 0.5
        p = p + td * ln * k
        pts += [mid, p.copy()]
        rads += [r * 0.86, r * 0.92]
        r *= 0.87
    f.tube(pts, rads, segs=14, up=-n)
    tips.append((p.copy(), td.copy(), (-n + side * 0.6).normalized(), r))


def body_forms(s):
    f = Forms()
    fh = Forms()
    b = s["bulk"]
    G = s["gaunt"]
    fem = s["female"]
    sh = s["shoulder"]
    hip = s["hip"]
    bel = s["belly"]
    rib = (0.15 - (0.012 if fem else 0)) * b
    waist = (0.124 - 0.014 * G + 0.025 * bel - (0.008 if fem else 0)) * b
    # Torso cross-sections: (z, centre y, half width, front depth, back depth, squareness)
    secs = [
        (0.86, -0.012, hip * 0.86 * b, 0.07 * b, 0.075 * b, 2.4),
        (0.9, -0.012, hip * b, 0.09 * b, 0.105 * b, 2.5),
        (0.97, -0.006, hip * 0.98 * b, (0.095 + 0.02 * bel) * b, 0.1 * b, 2.5),
        (1.04, 0.0, (hip * 0.88 + waist * 0.12) * b, (0.088 - 0.008 * G + 0.035 * bel) * b, 0.085 * b, 2.4),
        (1.1, 0.0, waist, (0.08 - 0.01 * G + 0.03 * bel) * b, 0.08 * b, 2.3),
        (1.18, 0.004, rib * 0.95, (0.09 - 0.004 * G + 0.012 * bel) * b, 0.088 * b, 2.3),
        (1.27, 0.008, rib, 0.1 * b, 0.092 * b, 2.3),
        (1.35, 0.006, rib * 1.04, 0.098 * b, 0.09 * b, 2.4),
        (1.405, 0.0, (sh - 0.02) * b, 0.08 * b, 0.085 * b, 2.6),
        (1.445, -0.004, (sh - 0.065) * b, 0.06 * b, 0.075 * b, 2.4),
        (1.475, 0.0, 0.062 * (0.92 if fem else 1), 0.052, 0.055, 2.1),
        (1.53, 0.012, 0.052 * (0.92 if fem else 1), 0.048, 0.05, 2.1),
        (1.61, 0.022, 0.05 * (0.92 if fem else 1), 0.046, 0.048, 2.1),
    ]
    f.loft(secs)
    tips, knuckles = [], []
    for sx in (-1, 1):
        S = "R" if sx > 0 else "L"
        shj, el = JOINT[f"upperarm.{S}"]
        _, wr = JOINT[f"forearm.{S}"]
        armk = (0.86 + 0.14 * (1 - G)) * b * (0.88 if fem else 1)
        # Deltoid cap, trapezius slope, buttocks, breasts.
        f.ellipsoid((sx * sh * b, -0.004, 1.4), (0.052 * armk, 0.058 * b, 0.062 * armk))
        f.ellipsoid((sx * 0.07, -0.03, 1.45), (0.07, 0.045, 0.035))
        f.ellipsoid((sx * 0.07, -0.068, 0.9), (0.082 * b, 0.065 * b, 0.085 * b))
        if fem:
            f.ellipsoid((sx * 0.078, 0.07 + 0.012 * s["bust"], 1.275 - 0.018 * s["bust"]), (0.062, 0.04 + 0.024 * s["bust"], 0.058))
        upper = [shj + Vector((0, 0, -0.01)), shj.lerp(el, 0.35), shj.lerp(el, 0.65), el]
        f.tube(upper, [0.047 * armk, 0.044 * armk, 0.039 * armk, 0.033 * armk], segs=24)
        fore = [el, el.lerp(wr, 0.22), el.lerp(wr, 0.55), wr]
        f.tube(fore, [(0.034 * armk, 0.032 * armk), (0.039 * armk, 0.034 * armk), (0.032 * armk, 0.027 * armk), (0.027 * armk, 0.019 * armk)], segs=24, up=Vector((0, 1, 0)))
        hand_forms(fh, sx, s, tips, knuckles)
        th, kn = JOINT[f"thigh.{S}"]
        _, an = JOINT[f"shin.{S}"]
        legk = b * (1.05 if fem else 1) * (1 - 0.08 * G)
        thigh = [th + Vector((-sx * 0.01, 0, 0.03)), th.lerp(kn, 0.3), th.lerp(kn, 0.65), kn]
        f.tube(thigh, [0.088 * legk, 0.08 * legk, 0.066 * legk, 0.05 * b], segs=26)
        shin = [kn, kn.lerp(an, 0.28) + Vector((0, -0.014, 0)), kn.lerp(an, 0.6) + Vector((0, -0.006, 0)), an + Vector((0, 0, 0.01))]
        f.tube(shin, [0.049 * b, 0.055 * legk, 0.042 * legk, 0.031], segs=24)
        f.ellipsoid(kn + Vector((0, 0.03, 0)), (0.034, 0.022, 0.03))
        foot = [an + Vector((0, 0, -0.01)), Vector((sx * 0.12, 0.06, 0.04)), Vector((sx * 0.122, 0.13, 0.026)), Vector((sx * 0.124, 0.19, 0.022))]
        f.tube(foot, [(0.033, 0.034), (0.04, 0.03), (0.044, 0.022), (0.036, 0.015)], segs=20, up=Vector((0, 0, 1)))
        f.ellipsoid((sx * 0.12, -0.035, 0.035), (0.03, 0.04, 0.032))
    return f, fh, tips, knuckles


def build_body(s, mats, coll, tag):
    f, fh, tips, knuckles = body_forms(s)
    trunk = f.to_object(f"{tag}_Trunk", coll)
    fuse(trunk, None, coarse=0.0075, subdivide=2)
    hands = fh.to_object(f"{tag}_Hands", coll)
    fuse(hands, 0.0015, smooth_iter=4, smooth_factor=0.6)
    u = Forms()
    u.add_mesh(trunk)
    u.add_mesh(hands)
    bpy.data.objects.remove(trunk, do_unlink=True)
    bpy.data.objects.remove(hands, do_unlink=True)
    high = u.to_object(f"{tag}_BodyHigh", coll)
    fuse(high, 0.0021, smooth_iter=3, smooth_factor=0.6)
    sculpt_body(high, s, knuckles)
    relax(high, 2, 0.4)
    high.data.materials.append(mats["skin"])
    return high, tips


# ---- heads ------------------------------------------------------------------------------------------------------------

def head_forms(s):
    sc = s["head_scale"]
    fem = s["female"]
    f = Forms()
    V = lambda x, y, z: Vector((x, y, z)) * sc  # noqa: E731
    R = lambda x, y, z: (x * sc, y * sc, z * sc)  # noqa: E731
    f.ellipsoid(V(0, -0.01, 0.024), R(0.074, 0.094, 0.094), segs=40, rings=28)
    f.ellipsoid(V(0, 0.028, -0.018), R(0.063, 0.074, 0.08), segs=36, rings=24)
    # Brow ridge (arched), cheekbones and their arches back to the ears.
    f.tube([V(-0.046, 0.078, 0.024), V(-0.026, 0.088, 0.031), V(0, 0.091, 0.029), V(0.026, 0.088, 0.031), V(0.046, 0.078, 0.024)],
           [(0.004 * s["brow"] + 0.004) * sc] * 5, segs=14)
    for sx in (-1, 1):
        f.ellipsoid(V(sx * 0.048, 0.052, -0.013), R(0.016, 0.019, 0.0105))
        # Mandible: from the angle of the jaw to the chin.
        f.tube([V(sx * 0.06, 0.0, -0.06), V(sx * 0.058, 0.012, -0.084), V(sx * 0.04 * s["jaw"], 0.065, -0.104), V(0, 0.09, -0.11)],
               [0.009 * sc, 0.011 * sc, 0.01 * sc, 0.011 * sc], segs=14)
        f.ellipsoid(V(sx * 0.0115 * s["nose"], 0.105, -0.034), R(0.0075, 0.008, 0.0065))
    f.ellipsoid(V(0, 0.05, -0.084), R(0.052, 0.05, 0.03))
    f.ellipsoid(V(0, 0.078, -0.064), R(0.031, 0.028, 0.027))
    f.ellipsoid(V(0, 0.092, -0.107), R(0.017, 0.012, 0.014))
    # Nose: bridge to tip.
    f.tube([V(0, 0.095, 0.02), V(0, 0.109, -0.004), V(0, 0.12, -0.024)], [0.0068 * sc, 0.0085 * sc, 0.011 * sc * s["nose"]], segs=14)
    f.ellipsoid(V(0, 0.119, -0.029), R(0.0125, 0.012, 0.0115))
    # Thin lips, pulled back.
    lip = (0.0034 if not fem else 0.0046) * sc
    f.tube([V(-0.023, 0.099, -0.061), V(-0.012, 0.107, -0.058), V(0, 0.109, -0.0575), V(0.012, 0.107, -0.058), V(0.023, 0.099, -0.061)], [lip] * 5, segs=12)
    f.tube([V(-0.021, 0.097, -0.082), V(-0.01, 0.104, -0.085), V(0, 0.106, -0.0855), V(0.01, 0.104, -0.085), V(0.021, 0.097, -0.082)], [lip * 1.15] * 5, segs=12)
    f.tube([V(0, -0.006, -0.125), V(0, 0.0, -0.05)], [0.042 * sc, 0.045 * sc], segs=24)
    return f


def head_cutters(s, eye_c):
    sc = s["head_scale"]
    f = Forms()
    V = lambda x, y, z: Vector((x, y, z)) * sc  # noqa: E731
    for sx in (-1, 1):
        f.ellipsoid(eye_c[sx] + V(0, 0.01, 0.001), (0.0175 * sc, 0.019 * sc, 0.0145 * sc), segs=28, rings=18)
        f.ellipsoid(V(sx * 0.0068, 0.112, -0.0395), (0.0042 * sc, 0.0075 * sc, 0.003 * sc), segs=12, rings=8)
    # Open mouth: the slit between the lips and the oral cavity behind it.
    f.ellipsoid(V(0, 0.1, -0.0705), (0.023 * sc, 0.03 * sc, 0.0105 * sc), segs=32, rings=16)
    f.ellipsoid(V(0, 0.066, -0.074), (0.023 * sc, 0.036 * sc, 0.019 * sc), segs=32, rings=16)
    return f


def lid_forms(f, s, eye_c, rng):
    """Heavy upper lids and slack lower lids: shells around each eyeball, fused onto the face."""
    sc = s["head_scale"]
    for sx in (-1, 1):
        c = eye_c[sx]
        droop = 0.1 + 0.18 * rng.random()
        for upper in (True, False):
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=28, v_segments=18, radius=0.0146 * sc)
            kill = []
            for fc in bm.faces:
                d = fc.calc_center_median().normalized()
                el = math.asin(max(-1, min(1, d.z)))
                keep = (el > 0.18 - droop and d.y > -0.2) if upper else (el < -0.38 and d.y > -0.2)
                if not keep:
                    kill.append(fc)
            bmesh.ops.delete(bm, geom=kill, context="FACES")
            me = bpy.data.meshes.new("lid")
            bm.to_mesh(me)
            bm.free()
            o = link(bpy.data.objects.new("lid", me))
            sol = o.modifiers.new("T", "SOLIDIFY")
            sol.thickness = 0.0032 * sc
            sol.offset = 1
            apply_modifiers(o)
            o.data.transform(Matrix.Translation(c))
            f.add_mesh(o)
            bpy.data.objects.remove(o, do_unlink=True)


def build_head(s, mats, coll, tag):
    sc = s["head_scale"]
    rng = random.Random(s["seed"] * 7 + 1)
    eye_c = {sx: Vector((sx * 0.032, 0.077, 0.006)) * sc for sx in (-1, 1)}
    head = head_forms(s).to_object(f"{tag}_HeadHigh", coll)
    fuse(head, None, coarse=0.0026, subdivide=1)
    deform(head, lambda p, n: head_strokes(p, n, s))
    carve(head, head_cutters(s, eye_c), coll)
    # Lids and ears fused on in a second pass (keeps the socket and mouth edges crisp).
    f = Forms()
    f.add_mesh(head)
    lid_forms(f, s, eye_c, rng)
    for sx in (-1, 1):
        ear = build_ear(s, sx, mats, rng)
        f.add_mesh(ear)
        bpy.data.objects.remove(ear, do_unlink=True)
    bpy.data.objects.remove(head, do_unlink=True)
    head = f.to_object(f"{tag}_HeadHigh", coll)
    fuse(head, 0.0011, smooth_iter=3, smooth_factor=0.6)
    deform(head, lambda p, n: head_strokes(p, n, s) * 0.25 + head_wrinkles(p, n, s))
    head.data.materials.append(mats["skin"])
    head.data.materials.append(mats["mouth"])
    # Mouth interior: faces behind the lips inside the oral cavity get the Mouth material.
    cav = Vector((0, 0.066, -0.074)) * sc
    for p in head.data.polygons:
        c = p.center
        q = Vector(((c.x - cav.x) / (0.027 * sc), (c.y - cav.y) / (0.04 * sc), (c.z - cav.z) / (0.023 * sc)))
        if q.length < 1.05 and c.y < 0.1 * sc:
            p.material_index = 1
    eyes = []
    for sx in (-1, 1):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.0123 * sc, segments=24, ring_count=16, location=eye_c[sx])
        e = bake_location(bpy.context.active_object)
        e.data.materials.append(mats["eyes"])
        smooth_shade(e)
        eyes.append(e)
    activate(eyes[0])
    eyes[1].select_set(True)
    bpy.ops.object.join()
    eyes_obj = bpy.context.active_object
    eyes_obj.name = f"{tag}_Eyes"
    teeth, gums = build_teeth(s, mats, rng)
    teeth.name = f"{tag}_Teeth"
    gums.name = f"{tag}_Mouth"
    out = [head, eyes_obj, teeth, gums]
    for o in out:
        o.data.transform(Matrix.Translation(HEAD_C))
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)
        smooth_shade(o)
    return out


def head_strokes(p, n, s):
    """Gaunt-face sculpt strokes after the forms are fused (p relative to HEAD_C)."""
    G = s["gaunt"]
    sc = s["head_scale"]
    d = Vector()
    V = lambda x, y, z: Vector((x, y, z)) * sc  # noqa: E731
    for sx in (-1, 1):
        d -= n * ((0.003 + 0.006 * G) * gauss(p, V(sx * 0.047, 0.066, -0.048), 0.019))
        d -= n * (0.005 * G * gauss(p, V(sx * 0.066, 0.042, 0.03), 0.02))
        d -= n * (0.003 * G * gauss(p, V(sx * 0.04, 0.085, -0.02), 0.012))
        d -= n * (0.0025 * (0.5 + s["age"]) * gauss_seg(p, V(sx * 0.017, 0.108, -0.037), V(sx * 0.031, 0.095, -0.078), 0.0035))
    d -= n * (0.0016 * gauss_seg(p, V(0, 0.112, -0.044), V(0, 0.11, -0.054), 0.003))
    d -= n * (0.003 * gauss(p, V(0, 0.1, -0.094), 0.008))
    return d


def head_wrinkles(p, n, s):
    sc = s["head_scale"]
    d = Vector()
    a = s["age"]
    if a <= 0:
        return d
    x, y, z = p / sc
    if n.y > 0.35 and 0.035 < z < 0.085:
        d -= n * (0.0007 * a * (0.5 + 0.5 * math.cos(2 * math.pi * z / 0.0105)) * math.exp(-((x / 0.045) ** 2)))
    for sx in (-1, 1):
        q = Vector((x, y, z)) - Vector((sx * 0.052, 0.07, 0.006))
        if q.length < 0.018:
            ang = math.atan2(q.z, abs(q.x))
            d -= n * (0.0006 * a * (0.5 + 0.5 * math.cos(ang * 9)) * (1 - q.length / 0.018))
    return d


def build_ear(s, sx, mats, rng):
    """A cartilage ear on a disc grid: helix rim, antihelix ridge, concha bowl, tragus and lobe, with a stalk."""
    sc = s["head_scale"]
    rings, segs = 10, 32
    verts, faces = [], []
    H, W = 0.031 * sc, 0.018 * sc
    for i in range(rings + 1):
        for j in range(segs):
            a = 2 * math.pi * j / segs
            r = i / rings
            top = 0.5 + 0.5 * math.sin(a)
            w = W * (0.78 + 0.28 * top)
            py = math.cos(a) * w * r
            pz = math.sin(a) * H * r * (1.08 if math.sin(a) < -0.4 else 1.0)
            hgt = 0.0
            hgt += 0.0048 * math.exp(-(((r - 0.92) / 0.08) ** 2)) * (1 - 0.75 * smoothstep(-0.3, -0.8, math.sin(a)))
            hgt += 0.0032 * math.exp(-(((r - 0.6) / 0.1) ** 2)) * smoothstep(-0.5, 0.3, math.sin(a)) * smoothstep(-0.2, 0.6, -math.cos(a) + 0.4)
            hgt -= 0.0042 * math.exp(-((r / 0.4) ** 2))
            hgt += 0.0035 * math.exp(-(((py - w * 0.72) / (0.0045 * sc)) ** 2 + ((pz + H * 0.08) / (0.0055 * sc)) ** 2))
            verts.append(Vector((hgt * sc, py, pz)))
    for i in range(rings):
        for j in range(segs):
            a = i * segs + j
            b = i * segs + (j + 1) % segs
            faces.append((a, b, b + segs, a + segs))
    me = bpy.data.meshes.new("ear")
    me.from_pydata(verts, [], faces)
    ear = link(bpy.data.objects.new("ear", me))
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    if s["seed"] % 2 == 1 and sx > 0:
        kill = [f for f in bm.faces if (f.calc_center_median() - Vector((0.003, -0.004 * sc, 0.025 * sc))).length < 0.01 * sc]
        bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(me)
    bm.free()
    sol = ear.modifiers.new("Thick", "SOLIDIFY")
    sol.thickness = 0.0042 * sc
    sol.offset = -1
    apply_modifiers(ear)
    f = Forms()
    f.add_mesh(ear)
    f.ellipsoid(Vector((-0.006 * sc, -0.002 * sc, -0.004 * sc)), (0.008 * sc, 0.011 * sc, 0.016 * sc))
    bpy.data.objects.remove(ear, do_unlink=True)
    ear = f.to_object("ear", None)
    ear.data.transform(Matrix.Rotation(math.radians(-20), 4, "Z") @ Matrix.Rotation(math.radians(-8), 4, "Y"))
    if sx < 0:
        ear.data.transform(Matrix.Scale(-1, 4, Vector((1, 0, 0))))
        ear.data.flip_normals()
    ear.data.transform(Matrix.Translation(Vector((sx * 0.071 * sc, 0.0, -0.01 * sc))))
    return ear


def build_teeth(s, mats, rng):
    sc = s["head_scale"]
    objs = []
    R = 0.025 * sc
    cy = 0.097 * sc - R
    mz = -0.0705 * sc
    for top in (True, False):
        n = 12
        for i in range(n):
            a = (i - (n - 1) / 2) / ((n - 1) / 2) * math.radians(62)
            if rng.random() < 0.18 and abs(i - (n - 1) / 2) > 1:
                continue
            w = (0.0064 if abs(i - (n - 1) / 2) < 2 else 0.0054) * sc
            h = (0.011 - 0.003 * abs(math.sin(a))) * sc * (0.75 + 0.45 * rng.random())
            if not top:
                h *= 0.8
            x = math.sin(a) * R
            y = cy + math.cos(a) * R
            z = mz + (0.0105 * sc - h / 2 if top else -0.0105 * sc + h / 2) + (-0.0025 * sc if top else 0.002 * sc)
            bm = bmesh.new()
            bmesh.ops.create_cube(bm, size=1.0)
            bmesh.ops.bevel(bm, geom=bm.verts[:] + bm.edges[:], offset=0.22, segments=2, affect="EDGES")
            m = (Matrix.Translation((x, y, z)) @ Matrix.Rotation(-a + math.radians(rng.uniform(-8, 8)), 4, "Z")
                 @ Matrix.Rotation(math.radians(rng.uniform(-10, 10)), 4, "Y") @ Matrix.Rotation(math.radians(rng.uniform(-12, 12)), 4, "X")
                 @ Matrix.Diagonal((w, 0.0048 * sc, h, 1)))
            bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
            me = bpy.data.meshes.new("tooth")
            bm.to_mesh(me)
            bm.free()
            objs.append(link(bpy.data.objects.new("tooth", me)))
    activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    teeth = bpy.context.active_object
    teeth.data.materials.append(mats["teeth"])
    # Gums and a tongue.
    g = Forms()
    for top in (True, False):
        pts = [Vector((math.sin(a) * R, cy + math.cos(a) * R, mz + (0.0105 if top else -0.0105) * sc)) for a in (math.radians(t) for t in range(-66, 67, 12))]
        g.tube(pts, [0.0045 * sc] * len(pts), segs=10)
    g.ellipsoid(Vector((0, cy + 0.004 * sc, mz - 0.011 * sc)), (0.02 * sc, 0.028 * sc, 0.007 * sc))
    gums = g.to_object("gums", None)
    gums.data.materials.append(mats["gums"])
    return teeth, gums


# ---- nails ----------------------------------------------------------------------------------------------------------

def build_nails(tips, mats, coll, tag):
    objs = []
    for p, fd, dorsal, r in tips:
        side = fd.cross(dorsal).normalized()
        up = side.cross(fd).normalized()
        if up.dot(dorsal) < 0:
            up = -up
        m = Matrix((side, fd, up)).transposed().to_4x4()
        c = p - fd * (r * 0.9) + up * (r * 0.78)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=10, ring_count=6, location=(0, 0, 0))
        nl = bpy.context.active_object
        nl.data.transform(Matrix.Diagonal((r * 0.8, r * 1.2, r * 0.22, 1)))
        nl.data.transform(Matrix.Translation(c) @ m)
        objs.append(nl)
    activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    nails = bpy.context.active_object
    nails.name = f"{tag}_Nails"
    nails.data.materials.append(mats["nails"])
    smooth_shade(nails)
    for c in nails.users_collection:
        c.objects.unlink(nails)
    coll.objects.link(nails)
    return nails


# ---- skinning -------------------------------------------------------------------------------------------------------

def auto_weight(body, arm):
    activate(body)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    # Heat weighting can leave islands unweighted (it reports instead of failing): fill them by distance.
    groups = {g.index: g.name for g in body.vertex_groups}
    missing = [v for v in body.data.vertices if not any(groups.get(g.group) in JOINT and g.weight > 1e-4 for g in v.groups)]
    if missing:
        segs = {n: JOINT[n] for n in JOINT if n != "root"}
        for v in missing:
            ds = sorted((seg_dist(v.co, a, b) + 1e-4, n) for n, (a, b) in segs.items())[:2]
            ws = [(1 / d ** 4, n) for d, n in ds]
            tot = sum(w for w, _ in ws)
            for w, n in ws:
                (body.vertex_groups.get(n) or body.vertex_groups.new(name=n)).add([v.index], w / tot, "REPLACE")
    # Shoulders and hips: smooth the weights so the joints bend without pinching, then keep 4 influences, normalised.
    smooth_weights(body, iterations=4, factor=0.5, around=("upperarm.L", "upperarm.R", "thigh.L", "thigh.R", "neck"))
    return missing


def smooth_weights(obj, iterations, factor, around):
    """Laplacian smoothing of all bone weights near the given joints, then limit 4 influences and normalise."""
    me = obj.data
    names = [g.name for g in obj.vertex_groups]
    n = len(me.vertices)
    W = [dict() for _ in range(n)]
    for v in me.vertices:
        for g in v.groups:
            if g.weight > 1e-5:
                W[v.index][names[g.group]] = g.weight
    nbr = [[] for _ in range(n)]
    for e in me.edges:
        a, b = e.vertices
        nbr[a].append(b)
        nbr[b].append(a)
    centres = [JOINT[j][0] for j in around]
    region = [min((me.vertices[i].co - c).length for c in centres) < 0.12 for i in range(n)]
    for _ in range(iterations):
        nw = [None] * n
        for i in range(n):
            if not region[i] or not nbr[i]:
                continue
            acc = {}
            for j in nbr[i]:
                for k, w in W[j].items():
                    acc[k] = acc.get(k, 0.0) + w / len(nbr[i])
            mixed = {k: W[i].get(k, 0.0) * (1 - factor) + acc.get(k, 0.0) * factor for k in set(W[i]) | set(acc)}
            nw[i] = mixed
        for i in range(n):
            if nw[i] is not None:
                W[i] = nw[i]
    for i in range(n):
        top = sorted(((w, k) for k, w in W[i].items() if k in JOINT and k != "root"), reverse=True)[:4]
        tot = sum(w for w, _ in top) or 1.0
        for g in obj.vertex_groups:
            g.remove([i])
        for w, k in top:
            if w / tot > 1e-3:
                (obj.vertex_groups.get(k) or obj.vertex_groups.new(name=k)).add([i], w / tot, "REPLACE")


def transfer_weights(dst, src, arm):
    """Copies bone weights from the nearest surface of src (the weighted low body) and parents dst to the rig."""
    activate(dst)
    dt = dst.modifiers.new("Weights", "DATA_TRANSFER")
    dt.object = src
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    dst.parent = arm
    dst.modifiers.new("Armature", "ARMATURE").object = arm


def rigid_weight(obj, arm, neck_blend=False):
    head = obj.vertex_groups.new(name="head")
    neck = obj.vertex_groups.new(name="neck")
    for v in obj.data.vertices:
        z = (obj.matrix_world @ v.co).z
        w = smoothstep(1.555, 1.6, z) if neck_blend else 1.0
        head.add([v.index], max(w, 1e-3), "REPLACE")
        if w < 0.999:
            neck.add([v.index], 1 - w, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm


def move_armature_last(obj):
    activate(obj)
    for i, m in enumerate(obj.modifiers):
        if m.type == "ARMATURE":
            bpy.ops.object.modifier_move_to_index(modifier=m.name, index=len(obj.modifiers) - 1)
            break


# ---- build ----------------------------------------------------------------------------------------------------------

def build():
    clear_scene()
    scene = bpy.context.scene
    mats = materials()
    rig = bpy.data.collections.new("Rig")
    scene.collection.children.link(rig)
    arm = build_armature(rig)
    pores = tex("Pores", "STUCCI", 0.004, stucci_type="WALL_OUT", turbulence=4.0)
    wrinkles = tex("Wrinkles", "VORONOI", 0.012, distance_metric="DISTANCE", color_mode="INTENSITY", noise_intensity=1.0)
    wrinkles.weight_1 = 0.0
    wrinkles.weight_2 = 1.0
    wrinkles.weight_3 = -1.0
    veins = tex("Veins", "MARBLE", 0.05, marble_type="SHARPER", turbulence=6.0, noise_depth=3)
    report = []
    for k, s in enumerate(VARIANTS):
        coll = bpy.data.collections.new(f"V{k}")
        scene.collection.children.link(coll)
        tag = f"V{k}"
        print(f"[stage1] {tag} {s['name']}: body", flush=True)
        body_high, tips = build_body(s, mats, coll, tag)
        body = low_copy(body_high, f"{tag}_Body", BODY_TRIS)
        missing = auto_weight(body, arm)
        transfer_weights(body_high, body, arm)
        add_detail(body_high, [(pores, 0.0012), (wrinkles, 0.0009 * (0.5 + s["age"])), (veins, 0.0006)], subdivide=False)
        move_armature_last(body_high)
        print(f"[stage1] {tag}: head", flush=True)
        head_high, eyes, teeth, mouth = build_head(s, mats, coll, tag)
        head = low_copy(head_high, f"{tag}_Head", HEAD_TRIS)
        add_detail(head_high, [(pores, 0.0007), (wrinkles, 0.0006 * (0.4 + s["age"]))], subdivide=False)
        for o in (head, head_high):
            rigid_weight(o, arm, neck_blend=True)
            move_armature_last(o)
        for o in (eyes, teeth, mouth):
            rigid_weight(o, arm)
        nails = build_nails(tips, mats, coll, tag)
        transfer_weights(nails, body, arm)
        for o in (body_high, head_high):
            o["high"] = True
        tri = lambda o: sum(len(p.vertices) - 2 for p in o.data.polygons)  # noqa: E731
        report.append((tag, s["name"], {o.name: tri(o) for o in (body, head, eyes, teeth, mouth, nails, body_high, head_high)}, len(missing)))
        for o in (body, head, eyes, teeth, mouth, nails, body_high, head_high):
            o["variant"] = k
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT))
    for tag, name, tris, missing in report:
        base = sum(v for n, v in tris.items() if not n.endswith("High"))
        print(f"[stage1] {tag} {name}: base tris {base} {tris} (heat-unweighted verts filled: {missing})")
    print(f"[stage1] saved {OUT}")
    return arm, mats


# ---- preview --------------------------------------------------------------------------------------------------------

def preview(arm, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    try:
        scene.eevee.taa_render_samples = 48
        scene.eevee.use_shadows = True
    except AttributeError:
        pass
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.05, 0.05, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.4
    scene.world = world
    bd = bpy.data.materials.new("Backdrop")
    bd.use_nodes = True
    bd.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.035, 0.035, 0.035, 1)
    bd.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.data.materials.append(bd)
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, -2.0, 3), rotation=(math.radians(90), 0, 0))
    back = bpy.context.active_object
    back.data.materials.append(bd)

    def light(name, loc, energy, size, color=(1, 0.97, 0.93)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy = energy
        ld.size = size
        ld.color = color
        lo = link(bpy.data.objects.new(name, ld))
        lo.location = loc
        d = Vector((0, 0, 1.3)) - Vector(loc)
        lo.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

    light("Key", (1.6, 2.6, 2.6), 160, 1.6)
    light("Fill", (-2.2, 2.0, 1.4), 45, 2.5, (0.9, 0.95, 1.0))
    light("Rim", (-0.8, -1.8, 2.4), 110, 1.2)
    cam_data = bpy.data.cameras.new("Cam")
    cam = link(bpy.data.objects.new("Cam", cam_data))
    scene.camera = cam
    # A slight relaxed pose: arms closer to the body like the reference.
    for side, sx in (("L", -1), ("R", 1)):
        pb = arm.pose.bones[f"upperarm.{side}"]
        pb.rotation_euler = (math.radians(4), 0, math.radians(-14 * sx))
        arm.pose.bones[f"forearm.{side}"].rotation_euler = (math.radians(-10), 0, 0)

    def shoot(path, loc, target, lens, res):
        cam.location = loc
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        cam_data.lens = lens
        scene.render.resolution_x, scene.render.resolution_y = res
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)

    for o in bpy.data.objects:
        if o.name.endswith("_Body") or o.name.endswith("_Head"):
            o.hide_render = True
    vcolls = [bpy.data.collections[f"V{k}"] for k in range(len(VARIANTS))]
    for k, c in enumerate(vcolls):
        for other in vcolls:
            other.hide_render = other is not c
        shoot(out_dir / f"v{k}_front.png", (0, 4.2, 1.0), (0, 0, 0.92), 50, (600, 1000))
        shoot(out_dir / f"v{k}_side.png", (4.2, 0.2, 1.0), (0, 0, 0.92), 50, (600, 1000))
        shoot(out_dir / f"v{k}_face.png", (0.18, 0.55, 1.68), (0, 0.04, 1.655), 85, (800, 800))
        shoot(out_dir / f"v{k}_hand.png", (0.85, 0.45, 0.95), (0.46, 0.06, 0.86), 85, (800, 800))


if __name__ == "__main__":
    arm, mats = build()
    if PREVIEW:
        preview(arm, PREVIEW)
