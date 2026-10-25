"""
SWAT operator, part 2: the head. Ballistic high-cut helmet (ARC rails, NVG shroud, Velcro panels, rim trim,
retention straps), clear ballistic goggles with frame and strap, an over-ear comms headset with boom mic, a black knit
balaclava shaped to a real face, and the eye area (eyes, lids, brows, skin) that shows through the goggles.

    blender --background --factory-startup --python swat_head.py -- [out.blend] [--preview <dir>]

Reference: images/5.webp ("SWAT / character model reference"). Coordinates: metres, Blender +Y is the front, +Z up,
origin at the feet; the character's left side is -X. Everything lands in one collection `Head`, in final world-space
position on the A-posed body from out/swat_body.blend when that file exists (else a 1.83 m mannequin head).
Export objects are low-poly (`Head_*`, together <= 8k tris); dense copies for baking carry the custom property `high`.
"""

import math
import os
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
ARGV = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = Path(ARGV[0]) if ARGV and not ARGV[0].startswith("--") else HERE / "out" / "swat_head.blend"
PREVIEW = Path(ARGV[ARGV.index("--preview") + 1]) if "--preview" in ARGV else None
BODY = HERE / "out" / "swat_body.blend"
BODY_BVH = None  # the body's head skin, so the mask can be kept outside it

# ---- head frame ------------------------------------------------------------------------------------------------------

EYE_DROP = 0.112  # crown to eye line


class Frame:
    """Where the head sits. Everything below is built relative to these numbers."""

    def __init__(self, crown=1.83, cx=0.0, cy=0.0, s=1.0):
        self.crown = crown
        self.cx = cx
        self.cy = cy
        self.s = s

    def p(self, x, y, z_from_crown):
        """Head-local point: x, y in metres from the head centre line, z measured down from the crown."""
        return Vector((self.cx + x * self.s, self.cy + y * self.s, self.crown - z_from_crown * self.s))


def body_frame() -> Frame:
    """Fit to the BODY worker's head: crown from the skin's top, centre and scale from its eyeballs."""
    if not BODY.exists():
        print("[head] no swat_body.blend yet: using the 1.83 m mannequin frame")
        return Frame()
    try:
        with bpy.data.libraries.load(str(BODY), link=False) as (src, dst):
            dst.objects = list(src.objects)
        loaded = [o for o in dst.objects if o is not None]
        for o in loaded:
            bpy.context.scene.collection.objects.link(o)
        bpy.context.view_layer.update()
        objs = {o.name: o for o in loaded}
        skin, eyes = objs.get("Body_Skin"), objs.get("Body_Eyes")
        frame = Frame()
        if skin:
            global BODY_BVH
            from mathutils.bvhtree import BVHTree

            bm = bmesh.new()
            bm.from_mesh(skin.data)
            bm.transform(skin.matrix_world)
            head_top = max(v.co.z for v in bm.verts)
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if all(v.co.z < head_top - 0.36 for v in f.verts)], context="FACES")
            BODY_BVH = BVHTree.FromBMesh(bm)
            bm.free()
        if skin and eyes:
            top = max((skin.matrix_world @ v.co).z for v in skin.data.vertices)
            ev = [eyes.matrix_world @ v.co for v in eyes.data.vertices]
            ez = sum(v.z for v in ev) / len(ev)
            ey = sum(v.y for v in ev) / len(ev)
            ex = sum(v.x for v in ev) / len(ev)
            s_ = (top - ez) / EYE_DROP
            frame = Frame(top, ex, ey - 0.0705 * s_, s_)
            print(f"[head] fitted to the body's eyes: crown {top:.3f}, eye line {ez:.3f}, centre ({ex:.3f}, {frame.cy:.3f}), scale {s_:.3f}")
        for o in loaded:
            bpy.data.objects.remove(o)
        return frame
    except Exception as e:  # a half-written body file must not stop the head
        print("[head] could not read the body file:", e)
        return Frame()


F = Frame()
EYE_X = 0.0315
EYE_R = 0.0121


def eye_centre(side):
    return F.p(side * EYE_X, 0.0705, EYE_DROP)


# ---- small helpers -------------------------------------------------------------------------------------------------

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def coll():
    c = bpy.data.collections.get("Head")
    if not c:
        c = bpy.data.collections.new("Head")
        bpy.context.scene.collection.children.link(c)
    return c


def link(o):
    for c in list(o.users_collection):
        c.objects.unlink(o)
    coll().objects.link(o)
    return o


def activate(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def apply_mods(o):
    activate(o)
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def mesh_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def ellipsoid(c, r, seg=40, rings=24):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((c.x + v.co.x * r[0] * F.s, c.y + v.co.y * r[1] * F.s, c.z + v.co.z * r[2] * F.s))
    return mesh_obj("blob", bm)


def cylinder(c, r, h, seg=40):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=1, radius2=1, depth=1)
    for v in bm.verts:
        v.co = Vector((c.x + v.co.x * r[0] * F.s, c.y + v.co.y * r[1] * F.s, c.z + v.co.z * h * F.s))
    return mesh_obj("cyl", bm)


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def remesh(o, voxel):
    m = o.modifiers.new("remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel * F.s
    m.adaptivity = 0
    apply_mods(o)


def lap_smooth(o, lam=0.6, it=6):
    m = o.modifiers.new("lap", "LAPLACIANSMOOTH")
    m.lambda_factor = lam
    m.iterations = it
    m.use_volume_preserve = True
    apply_mods(o)


def boolean(o, cutter, op="DIFFERENCE"):
    m = o.modifiers.new("bool", "BOOLEAN")
    m.operation = op
    m.object = cutter
    for solver in ("MANIFOLD", "EXACT"):
        try:
            m.solver = solver
            break
        except TypeError:
            continue
    apply_mods(o)
    bpy.data.objects.remove(cutter)


def smooth_shade(o, angle=40):
    for p in o.data.polygons:
        p.use_smooth = True
    try:
        o.data.set_sharp_from_angle(angle=math.radians(angle))
    except Exception:
        pass


def decimate_to(o, tris):
    for _ in range(6):
        cur = sum(len(p.vertices) - 2 for p in o.data.polygons)
        if cur <= tris * 1.04:
            return
        m = o.modifiers.new("dec", "DECIMATE")
        m.ratio = max(0.03, tris / cur)
        m.use_collapse_triangulate = True
        apply_mods(o)


def decimate_planar(o, tris, angle=12):
    """Hard-surface parts: dissolve coplanar faces first (keeps shapes intact), then collapse what is left."""
    m = o.modifiers.new("planar", "DECIMATE")
    m.decimate_type = "DISSOLVE"
    m.angle_limit = math.radians(angle)
    tri = o.modifiers.new("tri", "TRIANGULATE")
    apply_mods(o)
    decimate_to(o, tris)


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def curve_obj(name, pts, bevel_obj=None, depth=0.0, res=4, closed=False, tilts=None):
    cd = bpy.data.curves.new(name, "CURVE")
    cd.dimensions = "3D"
    cd.resolution_u = res
    cd.twist_mode = "MINIMUM"
    sp = cd.splines.new("BEZIER")
    sp.bezier_points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        bp = sp.bezier_points[i]
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "AUTO"
        if tilts:
            bp.tilt = tilts[i]
    sp.use_cyclic_u = closed
    if bevel_obj is not None:
        cd.bevel_mode = "OBJECT"
        cd.bevel_object = bevel_obj
        cd.use_fill_caps = True
    else:
        cd.bevel_depth = depth
        cd.bevel_resolution = 3
        cd.use_fill_caps = True
    o = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(o)
    activate(o)
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def sweep(name, pts, width, thick, ups=None, base=0.0, centre=None, widths=None):
    """A flat strip (straps, rails): a width x thick rectangle carried along pts. `ups` (or the direction away from
    `centre`) is the thickness direction; the width lies across the path. `base` lifts the strip off the surface."""
    n = len(pts)
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(n - 1, i + 1)] - pts[max(0, i - 1)]).normalized()
        u = ups[i] if ups else (p - centre).normalized()
        u = (u - t * u.dot(t)).normalized()
        sd = t.cross(u).normalized()
        c = p + u * (base + thick / 2) * F.s
        hw, ht = (widths[i] if widths else width) / 2 * F.s, thick / 2 * F.s
        rings.append([bm.verts.new(c + sd * a * hw + u * b * ht) for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    for i in range(n - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(4):
            bm.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bm.normal_update()
    o = mesh_obj(name, bm)
    bv = o.modifiers.new("bev", "BEVEL")
    bv.width = min(width, thick) * 0.3 * F.s
    bv.segments = 2
    apply_mods(o)
    return o


def smooth_path(pts, sub=6):
    """Catmull-Rom through pts, `sub` steps per segment."""
    out = []
    n = len(pts)
    for i in range(n - 1):
        p0, p1, p2, p3 = pts[max(0, i - 1)], pts[i], pts[i + 1], pts[min(n - 1, i + 2)]
        for k in range(sub):
            t = k / sub
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(pts[-1])
    return out


def rect_profile(name, w, h, r=0.0):
    """Closed 2D curve used as a bevel object (strap or rail cross-section)."""
    cd = bpy.data.curves.new(name, "CURVE")
    cd.dimensions = "2D"
    sp = cd.splines.new("POLY")
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    sp.points.add(len(pts) - 1)
    for i, (x, y) in enumerate(pts):
        sp.points[i].co = (x * F.s, y * F.s, 0, 1)
    sp.use_cyclic_u = True
    o = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(o)
    return o


# ---- materials -----------------------------------------------------------------------------------------------------

def principled(name, color, rough=0.5, metal=0.0, **extra):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    for k, v in extra.items():
        if k in b.inputs:
            b.inputs[k].default_value = v
    return m


def add_bump(m, kind="noise", scale=400.0, strength=0.25, detail=6.0, distance=0.0006, coords="Object"):
    """A procedural bump on the material's Principled BSDF (object space, so the scale is in 1/metres)."""
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    if kind == "noise":
        t = nt.nodes.new("ShaderNodeTexNoise")
        t.inputs["Scale"].default_value = scale
        t.inputs["Detail"].default_value = detail
        out = t.outputs["Fac"]
    elif kind == "voronoi":
        t = nt.nodes.new("ShaderNodeTexVoronoi")
        t.inputs["Scale"].default_value = scale
        out = t.outputs["Distance"]
    else:  # knit: vertical ribs of small loops (wave across x, voronoi for the loops)
        w = nt.nodes.new("ShaderNodeTexWave")
        w.wave_type = "BANDS"
        w.bands_direction = "X"
        w.inputs["Scale"].default_value = scale
        w.inputs["Distortion"].default_value = 0.0
        w.inputs["Detail"].default_value = 0.0
        v = nt.nodes.new("ShaderNodeTexVoronoi")
        v.inputs["Scale"].default_value = scale * 2.2
        mx = nt.nodes.new("ShaderNodeMath")
        mx.operation = "MULTIPLY"
        nt.links.new(tc.outputs[coords], w.inputs["Vector"])
        nt.links.new(tc.outputs[coords], v.inputs["Vector"])
        nt.links.new(w.outputs["Fac"], mx.inputs[0])
        nt.links.new(v.outputs["Distance"], mx.inputs[1])
        out = mx.outputs["Value"]
        t = None
    if t is not None:
        nt.links.new(tc.outputs[coords], t.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = distance
    nt.links.new(out, bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def mottle(m, c1, c2, scale=60.0):
    """Base colour varies between c1 and c2 with a noise (worn coatings, skin tone)."""
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = 4.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].color = (*c2, 1)
    nt.links.new(tc.outputs["Object"], n.inputs["Vector"])
    nt.links.new(n.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    return m


def ao_darken(m, strength=0.6, dist=0.012):
    """Multiply the base colour by ambient occlusion so creases and the eyelid fold darken (Cycles)."""
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    bc = b.inputs["Base Color"]
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = dist * F.s
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = strength
    if bc.is_linked:
        nt.links.new(bc.links[0].from_socket, mix.inputs["A"])
    else:
        mix.inputs["A"].default_value = bc.default_value
    nt.links.new(ao.outputs["AO"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], bc)
    return m


def materials():
    M = {}
    M["helmet"] = add_bump(mottle(principled("Head_Helmet", (0.032, 0.034, 0.038), 0.78), (0.024, 0.026, 0.029), (0.055, 0.057, 0.062), 14), "noise", 1300, 0.75, 10, 0.0007)
    M["rail"] = add_bump(principled("Head_Rail", (0.028, 0.029, 0.031), 0.55), "noise", 1500, 0.15)
    M["velcro"] = add_bump(principled("Head_Velcro", (0.075, 0.076, 0.08), 0.97), "noise", 2600, 0.7, 2, 0.0006)
    M["metal"] = principled("Head_Metal", (0.08, 0.08, 0.085), 0.4, 1.0)
    M["slot"] = principled("Head_Slot", (0.004, 0.004, 0.005), 0.9)
    M["lens"] = principled("Head_Lens", (0.95, 0.96, 0.95), 0.02, 0.0, **{"Transmission Weight": 1.0, "IOR": 1.49})
    M["frame"] = add_bump(principled("Head_GoggleFrame", (0.02, 0.02, 0.022), 0.55), "noise", 1200, 0.1)
    M["strap"] = add_bump(principled("Head_Strap", (0.03, 0.031, 0.033), 0.85), "knit", 260, 0.3, 2, 0.0005)
    M["headset"] = add_bump(mottle(principled("Head_Headset", (0.04, 0.042, 0.045), 0.6), (0.03, 0.032, 0.035), (0.06, 0.062, 0.066), 30), "noise", 1100, 0.25, 6, 0.0003)
    M["cushion"] = add_bump(principled("Head_Cushion", (0.015, 0.015, 0.016), 0.38), "voronoi", 900, 0.15)
    M["foam"] = add_bump(principled("Head_Foam", (0.018, 0.018, 0.02), 1.0), "voronoi", 1600, 0.6)
    M["mask"] = add_bump(principled("Head_Mask", (0.009, 0.0095, 0.011), 0.9, **{"Sheen Weight": 0.35, "Sheen Roughness": 0.4}), "knit", 700, 1.0, 2, 0.0012)
    skin = principled("Head_Skin", (0.55, 0.37, 0.29), 0.5, **{"Subsurface Weight": 0.35, "Subsurface Scale": 0.006})
    M["skin"] = ao_darken(add_bump(mottle(skin, (0.48, 0.31, 0.24), (0.6, 0.41, 0.32), 140), "noise", 2400, 0.25, 4, 0.0002), 0.55, 0.008)
    ao_darken(M["mask"], 0.5, 0.02)
    M["eye"] = eye_material()
    M["brow"] = brow_material()
    return M


def gen_image(name, w, h, fn):
    import numpy as np

    img = bpy.data.images.new(name, w, h, alpha=True)
    px = fn(np)
    img.pixels.foreach_set(px.astype("float32").ravel())
    img.pack()
    return img


def eye_material():
    """Sclera with faint veins, a blue-grey iris with radial fibres, a dark limbal ring and the pupil."""

    def fn(np):
        n = 512
        y, x = np.mgrid[0:n, 0:n].astype("float32")
        u = (x / n - 0.5) * 2
        v = (y / n - 0.5) * 2
        r = np.sqrt(u * u + v * v)
        a = np.arctan2(v, u)
        rng = np.random.default_rng(7)
        col = np.zeros((n, n, 4), "float32")
        col[..., 3] = 1
        sclera = np.stack([0.86 + 0 * r, 0.82 + 0 * r, 0.78 + 0 * r], -1)
        veins = (np.sin(a * 23 + np.sin(r * 9) * 2) * 0.5 + 0.5) ** 30 * np.clip((r - 0.5) * 2, 0, 1)
        sclera[..., 1] -= veins * 0.25
        sclera[..., 2] -= veins * 0.25
        fib = np.sin(a * 90 + rng.normal(0, 1) + np.sin(a * 13) * 2) * 0.5 + 0.5
        iris = np.stack([0.32 + 0.12 * fib, 0.40 + 0.12 * fib, 0.46 + 0.12 * fib], -1)
        iris *= (0.75 + 0.35 * np.clip((r - 0.08) / 0.3, 0, 1))[..., None]
        ir = 0.38
        t_iris = np.clip((ir - r) / 0.02, 0, 1)[..., None]
        ring = np.clip(1 - np.abs(r - ir) / 0.03, 0, 1)[..., None]
        c = sclera * (1 - t_iris) + iris * t_iris
        c = c * (1 - ring * 0.6)
        pupil = np.clip((0.13 - r) / 0.01, 0, 1)[..., None]
        c = c * (1 - pupil) + 0.01 * pupil
        col[..., :3] = c
        return col

    img = gen_image("Head_EyeTex", 512, 512, fn)
    m = principled("Head_Eye", (1, 1, 1), 0.08, **{"Coat Weight": 1.0, "Coat Roughness": 0.02})
    nt = m.node_tree
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    nt.links.new(t.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    return m


def brow_material():
    """Alpha cards painted with short dark hairs growing outward along the brow."""

    def fn(np):
        w, h = 512, 128
        img = np.zeros((h, w, 4), "float32")
        rng = np.random.default_rng(3)
        for _ in range(1400):
            x0 = rng.uniform(0.02, 0.98) * w
            dens = np.sin(np.clip(x0 / w, 0, 1) * math.pi) ** 0.5
            if rng.random() > dens:
                continue
            y0 = rng.uniform(0.15, 0.85) * h
            ang = math.radians(rng.normal(12 + 30 * (x0 / w), 8))
            ln = rng.uniform(10, 24)
            for t in np.linspace(0, 1, 18):
                xx = int(x0 + math.cos(ang) * ln * t)
                yy = int(y0 - math.sin(ang) * ln * t * 0.6)
                if 0 <= xx < w and 0 <= yy < h:
                    img[yy, xx, :3] = (0.05, 0.035, 0.025)
                    img[yy, xx, 3] = min(1.0, img[yy, xx, 3] + 0.8 * (1 - t * 0.6))
        return img

    img = gen_image("Head_BrowTex", 512, 128, fn)
    m = principled("Head_Brow", (0.05, 0.035, 0.025), 0.6)
    nt = m.node_tree
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    b = nt.nodes["Principled BSDF"]
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    try:
        m.blend_method = "CLIP"
    except Exception:
        pass
    return m


def set_mat(o, m):
    o.data.materials.clear()
    o.data.materials.append(m)


# ---- the face (skin + eyes) and the balaclava ----------------------------------------------------------------------

def build_head_base():
    """A realistic adult male head and neck: cranium, face mass, brow ridge, cheekbones, jaw, chin, nose, ears."""
    E = EYE_DROP
    parts = [
        ellipsoid(F.p(0, -0.012, 0.098), (0.077, 0.098, 0.099)),  # cranium
        ellipsoid(F.p(0, 0.032, E + 0.03), (0.066, 0.06, 0.078)),  # face mass
        ellipsoid(F.p(0, 0.066, E - 0.017), (0.058, 0.024, 0.013)),  # brow ridge
        ellipsoid(F.p(0.046, 0.054, E + 0.021), (0.019, 0.021, 0.013)),  # cheekbones
        ellipsoid(F.p(-0.046, 0.054, E + 0.021), (0.019, 0.021, 0.013)),
        ellipsoid(F.p(0, 0.036, E + 0.083), (0.054, 0.052, 0.034)),  # jaw
        ellipsoid(F.p(0.042, 0.012, E + 0.072), (0.016, 0.034, 0.03)),  # jaw angles
        ellipsoid(F.p(-0.042, 0.012, E + 0.072), (0.016, 0.034, 0.03)),
        ellipsoid(F.p(0, 0.07, E + 0.104), (0.024, 0.018, 0.018)),  # chin
        ellipsoid(F.p(0, 0.062, E + 0.07), (0.03, 0.022, 0.024)),  # mouth
        cylinder(F.p(0, -0.004, 0.262), (0.056, 0.06), 0.17),  # neck
        ellipsoid(F.p(0.077, -0.006, E + 0.012), (0.013, 0.026, 0.032)),  # ears
        ellipsoid(F.p(-0.077, -0.006, E + 0.012), (0.013, 0.026, 0.032)),
    ]
    # Nose: bridge to tip as a chain of spheres, plus the wings.
    for i in range(9):
        t = i / 8
        y = 0.072 + 0.024 * t
        z = E + 0.004 + 0.042 * t
        r = 0.0055 + 0.0035 * t * t
        parts.append(ellipsoid(F.p(0, y, z), (r * 0.95, r, r * 1.25), 20, 12))
    for side in (1, -1):
        parts.append(ellipsoid(F.p(side * 0.0115, 0.088, E + 0.049), (0.0072, 0.0068, 0.0062), 20, 12))
    head = join(parts, "Head_HeadHigh")
    remesh(head, 0.0022)
    lap_smooth(head, 1.0, 22)
    # Eye sockets, then lid shells around each eyeball, fused in a finer remesh.
    for side in (1, -1):
        c = eye_centre(side)
        boolean(head, ellipsoid(c + Vector((0, 0.0015, 0)), (0.0165, 0.0165, 0.0155), 32, 20))
    lids = [lid_shell(side) for side in (1, -1)]
    head = join([head] + lids, "Head_HeadHigh")
    remesh(head, 0.0013)
    lap_smooth(head, 0.5, 4)
    return head


def lid_shell(side):
    """Upper and lower lid: a shell around the eyeball with an almond-shaped opening."""
    c = eye_centre(side)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=40, radius=1.0)
    rad = EYE_R * 1.1
    kill = []
    for f in bm.faces:
        cen = f.calc_center_median()
        az = math.degrees(math.atan2(cen.x * side, cen.y))  # 0 = looking forward, + = outward
        el = math.degrees(math.asin(max(-1, min(1, cen.z))))
        if abs(az) > 82 or abs(el) > 62 or cen.y < 0.05:
            kill.append(f)
            continue
        # Almond opening, slightly higher and more open on the outer side.
        # Almond: the upper lid peaks a little toward the nose, the lower lid toward the temple.
        k_up = max(0.0, 1 - ((az + 6) / 58) ** 2)
        k_lo = max(0.0, 1 - ((az - 6) / 58) ** 2)
        up = 21 * k_up**0.5
        lo = -12 * k_lo**0.65
        if lo < el < up:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    for v in bm.verts:
        v.co = Vector((c.x + v.co.x * rad * F.s, c.y + v.co.y * rad * F.s, c.z + v.co.z * rad * F.s))
    o = mesh_obj("lid", bm)
    s = o.modifiers.new("sol", "SOLIDIFY")
    s.thickness = 0.0042 * F.s
    s.offset = 1.0
    apply_mods(o)
    return o


def build_eyes(M):
    eyes = []
    for side in (1, -1):
        c = eye_centre(side)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=14, radius=EYE_R * F.s)
        # Cornea bulge at the front.
        for v in bm.verts:
            if v.co.y > 0.6 * EYE_R * F.s:
                v.co.y += (v.co.y / (EYE_R * F.s) - 0.6) * 0.0022 * F.s
        uv = bm.loops.layers.uv.new()
        for f in bm.faces:
            for l in f.loops:
                p = l.vert.co / (EYE_R * F.s)
                l[uv].uv = (0.5 + p.x * 0.5, 0.5 + p.z * 0.5)
        # Look slightly toward the camera side and down a touch, like the reference.
        for v in bm.verts:
            v.co = Matrix.Rotation(math.radians(-1 * side), 3, "Z") @ v.co
            v.co += c
        o = mesh_obj(f"Head_Eye{'R' if side > 0 else 'L'}", bm)
        set_mat(o, M["eye"])
        smooth_shade(o, 180)
        eyes.append(link(o))
    return eyes


def build_brows(M):
    """Two alpha cards following the brow ridge, 1 mm off the skin."""
    out = []
    for side in (1, -1):
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new()
        n = 10
        rows = []
        for i in range(n + 1):
            t = i / n
            x = side * (0.012 + 0.046 * t)
            y = 0.0815 - 0.03 * t * t
            z = EYE_DROP - 0.0185 - 0.006 * math.sin(t * math.pi) + 0.004 * t
            rows.append([bm.verts.new(F.p(x, y + 0.002, z - 0.005)), bm.verts.new(F.p(x, y + 0.002, z + 0.004))])
        for i in range(n):
            a, b = rows[i], rows[i + 1]
            f = bm.faces.new((a[0], b[0], b[1], a[1]) if side > 0 else (a[1], b[1], b[0], a[0]))
            for l in f.loops:
                vi = next(j for j, r in enumerate(rows) if l.vert in r)
                l[uv].uv = (vi / n, 0.0 if l.vert is rows[vi][0] else 1.0)
        o = mesh_obj(f"Head_Brow{'R' if side > 0 else 'L'}", bm)
        set_mat(o, M["brow"])
        out.append(link(o))
    return out


def opening(x, y, z_from_crown):
    """Inside the balaclava's eye opening? A rounded band across the front of the face."""
    E = EYE_DROP
    if y < 0.035:
        return False
    dz_top = E - 0.024  # hidden under the goggle frame
    dz_bot = E + 0.021
    half_w = 0.06
    if abs(x) > half_w:
        return False
    # Rounded corners at the temples, a dip over the nose bridge at the bottom.
    corner = max(0.0, (abs(x) - (half_w - 0.016)) / 0.016)
    top = dz_top + 0.012 * corner**2
    bot = dz_bot - 0.012 * corner**2 - 0.006 * max(0.0, 1 - abs(x) / 0.012)
    return top < z_from_crown < bot


def wrap_outside(o, margin, spread=30):
    """Inflate `o` where the body's head skin comes within `margin` of it (or pokes through). The required push is
    spread smoothly over the surface (never below what a vertex needs) and applied along the mesh's own normals, so
    the mask keeps its shape instead of copying the body's facets."""
    if BODY_BVH is None:
        return 0
    import numpy as np

    me = o.data
    n = len(me.vertices)
    co = np.empty(n * 3, "float32")
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    me.calc_normals_split() if hasattr(me, "calc_normals_split") else None
    nrm = np.empty(n * 3, "float32")
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(n, 3)
    need = np.zeros(n, "float32")
    for i in range(n):
        hit = BODY_BVH.find_nearest(Vector(co[i]))
        if hit[0] is None:
            continue
        sd = (Vector(co[i]) - hit[0]).dot(hit[1])
        # Leave the eye opening's edge alone: the body's own face is meant to be hidden under this head.
        if (F.crown - co[i][2]) / F.s < EYE_DROP + 0.04 and (co[i][1] - F.cy) / F.s > 0.0:
            continue
        if sd < margin * F.s:
            need[i] = margin * F.s - sd
    e = np.empty(len(me.edges) * 2, "int32")
    me.edges.foreach_get("vertices", e)
    e = e.reshape(-1, 2)
    deg = np.bincount(e.ravel(), minlength=n).astype("float32") + 1e-6
    d = need.copy()
    for _ in range(spread):
        acc = np.zeros(n, "float32")
        np.add.at(acc, e[:, 0], d[e[:, 1]])
        np.add.at(acc, e[:, 1], d[e[:, 0]])
        d = np.maximum(need, acc / deg)
    co += nrm * d[:, None]
    me.vertices.foreach_set("co", co.ravel())
    me.update()
    return int((need > 0).sum())


def build_mask(head_high, M):
    """Knit balaclava over the whole head and neck, open around the eyes, bunched on the neck."""
    o = head_high.copy()
    o.data = head_high.data.copy()
    o.name = o.data.name = "Head_MaskHigh"
    bpy.context.scene.collection.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.normal_update()
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        lx, ly, lz = (c.x - F.cx) / F.s, (c.y - F.cy) / F.s, (F.crown - c.z) / F.s
        if opening(lx, ly, lz) or lz > 0.33:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    # Fabric tents from the nose tip down to the chin and out to the cheeks instead of hugging lips and nostrils.
    E = EYE_DROP
    ztip, ytip = E + 0.047, 0.106
    zchin, ychin = E + 0.112, 0.078
    for v in bm.verts:
        lx, ly, lz = (v.co.x - F.cx) / F.s, (v.co.y - F.cy) / F.s, (F.crown - v.co.z) / F.s
        if ly < 0.02 or lz < ztip - 0.012 or lz > zchin + 0.01:
            continue
        t = max(0.0, min(1.0, (lz - ztip) / (zchin - ztip)))
        line = ytip + (ychin - ytip) * t - 0.004 * math.sin(t * math.pi)
        line -= (lx / 0.052) ** 2 * 0.032
        k = max(0.0, min(1.0, (lz - (ztip - 0.012)) / 0.012))
        target = line + 0.0012
        if ly < target:
            v.co.y += (target - ly) * k * F.s
    bm.normal_update()
    for v in bm.verts:
        lx, ly, lz = (v.co.x - F.cx) / F.s, (v.co.y - F.cy) / F.s, (F.crown - v.co.z) / F.s
        off = 0.0022
        if lz > 0.2:  # neck gaiter: loose, bunched folds
            k = min(1.0, (lz - 0.2) / 0.05)
            ang = math.atan2(lx, ly)
            off += 0.005 * k + 0.0016 * k * math.sin(lz * 170 + math.sin(ang * 2) * 2.5 + math.sin(ang * 5) * 0.8)
        v.co += v.normal * off * F.s
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # The opening's edge: relax the boundary loop so it reads as a hem, not voxel steps.
    edge = [v for v in bm.verts if v.is_boundary]
    for _ in range(12):
        new = {}
        for v in edge:
            nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nb) == 2:
                new[v] = v.co * 0.5 + (nb[0].co + nb[1].co) * 0.25
        for v, c in new.items():
            v.co = c
    bm.to_mesh(o.data)
    bm.free()
    # Lower face: fabric spans the nose, lips and chin instead of following them.
    vg = o.vertex_groups.new(name="lower")
    for v in o.data.vertices:
        lx, ly, lz = (v.co.x - F.cx) / F.s, (v.co.y - F.cy) / F.s, (F.crown - v.co.z) / F.s
        if ly > -0.02 and EYE_DROP + 0.022 < lz < EYE_DROP + 0.22:
            w = min(1.0, (lz - EYE_DROP - 0.022) / 0.014) * min(1.0, (EYE_DROP + 0.22 - lz) / 0.07) * min(1.0, (ly + 0.02) / 0.05)
            vg.add([v.index], w, "REPLACE")
    sm = o.modifiers.new("fabric", "SMOOTH")
    sm.factor = 1.0
    sm.iterations = 70
    sm.vertex_group = "lower"
    apply_mods(o)
    # Bunched gaiter folds on the neck (after the smoothing, which would iron them flat).
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.normal_update()
    for v in bm.verts:
        lx, ly, lz = (v.co.x - F.cx) / F.s, (v.co.y - F.cy) / F.s, (F.crown - v.co.z) / F.s
        if lz > 0.215:
            k = min(1.0, (lz - 0.215) / 0.03)
            ang = math.atan2(lx, ly)
            fold = math.sin(lz * 210 + math.sin(ang * 2) * 2.2 + math.sin(ang * 5 + 1) * 0.9)
            v.co += v.normal * (0.005 * k + 0.0042 * k * fold) * F.s
    bm.to_mesh(o.data)
    bm.free()
    print(f"[head] mask kept outside the body's head: {wrap_outside(o, 0.0015, 40)} vertices needed a push")
    s = o.modifiers.new("sol", "SOLIDIFY")
    s.thickness = 0.0024 * F.s
    s.offset = 1.0
    s.use_rim = True
    apply_mods(o)
    lap_smooth(o, 0.3, 3)
    set_mat(o, M["mask"])
    smooth_shade(o, 60)
    return link(o)


def build_face_low(head_high, M):
    """Only the skin that can be seen: the band around the eyes (the rest is under the mask)."""
    o = head_high.copy()
    o.data = head_high.data.copy()
    o.name = o.data.name = "Head_Face"
    bpy.context.scene.collection.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    E = EYE_DROP
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        lx, ly, lz = (c.x - F.cx) / F.s, (c.y - F.cy) / F.s, (F.crown - c.z) / F.s
        if ly < 0.02 or lz < E - 0.042 or lz > E + 0.04 or abs(lx) > 0.075:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(o.data)
    bm.free()
    set_mat(o, M["skin"])
    decimate_to(o, 1300)
    smooth_shade(o, 180)
    return link(o)


# ---- the helmet ----------------------------------------------------------------------------------------------------

# Shell: an ellipsoid standing off the scalp by the pad thickness, cut high over the ears.
SHELL_C = (0.0, -0.014, 0.096)  # head-local centre (x, y, down-from-crown)
SHELL_R = (0.111, 0.134, 0.127)


def rim_drop(phi):
    """Distance below the crown of the shell's lower edge at azimuth phi (0 = front, + = the character's right)."""
    a = abs(math.degrees(phi))
    E = EYE_DROP
    front = E - 0.041  # brow line
    temple = E - 0.03
    ear = E - 0.052  # the high cut over the ears
    back = E + 0.008  # nape
    if a < 40:
        return front + (temple - front) * (a / 40) ** 2
    if a < 62:
        t = (a - 40) / 22
        return temple + (ear - temple) * (0.5 - 0.5 * math.cos(t * math.pi))
    if a < 112:
        return ear
    if a < 140:
        t = (a - 112) / 28
        return ear + (back - ear) * (0.5 - 0.5 * math.cos(t * math.pi))
    return back


def shell_point(phi, theta, grow=0.0):
    sx, sy, sz = SHELL_R
    # Flatten the sides a touch and flare the brim, like a FAST shell.
    flare = 1.0 + 0.045 * max(0.0, math.cos(theta) * -1 + 0.25)
    x = (sx + grow) * math.sin(theta) * math.sin(phi) * flare
    y = (sy + grow) * math.sin(theta) * math.cos(phi) * flare
    z = (sz + grow) * math.cos(theta)
    return F.p(SHELL_C[0] + x, SHELL_C[1] + y, SHELL_C[2] - z)


def theta_at(phi, drop):
    c = (SHELL_C[2] - drop) / SHELL_R[2]
    return math.acos(max(-1.0, min(1.0, c)))


def build_shell(M):
    bm = bmesh.new()
    nphi, nth = 160, 56
    pole = bm.verts.new(shell_point(0, 0))
    rings = []
    for i in range(nphi):
        phi = (i / nphi) * 2 * math.pi - math.pi
        tmax = theta_at(phi, rim_drop(phi))
        ring = []
        for j in range(1, nth + 1):
            th = tmax * (j / nth) ** 0.9
            ring.append(bm.verts.new(shell_point(phi, th)))
        rings.append(ring)
    for i in range(nphi):
        a, b = rings[i], rings[(i + 1) % nphi]
        bm.faces.new((pole, b[0], a[0]))
        for j in range(nth - 1):
            bm.faces.new((a[j], b[j], b[j + 1], a[j + 1]))
    bm.normal_update()
    o = mesh_obj("Head_HelmetHigh", bm)
    for p in o.data.polygons:
        p.use_smooth = True
    s = o.modifiers.new("sol", "SOLIDIFY")
    s.thickness = 0.0075 * F.s
    s.offset = -1.0
    s.use_even_offset = True
    apply_mods(o)
    set_mat(o, M["helmet"])
    # Rim trim: a rubber edge along the lower boundary.
    rim = [shell_point(phi, theta_at(phi, rim_drop(phi)), -0.003) for phi in [(i / 96) * 2 * math.pi - math.pi for i in range(96)]]
    trim = curve_obj("Head_Trim", rim, depth=0.0042 * F.s, res=2, closed=True)
    set_mat(trim, M["rail"])
    return link(o), link(trim)


def surface_frame(phi, theta, grow=0.0):
    """Position, outward normal, tangent along phi, tangent toward the top, on the shell."""
    p = shell_point(phi, theta, grow)
    dp = shell_point(phi + 0.002, theta, grow) - shell_point(phi - 0.002, theta, grow)
    dt = shell_point(phi, theta - 0.002, grow) - shell_point(phi, theta + 0.002, grow)
    n = dp.cross(dt).normalized()
    centre = F.p(*SHELL_C)
    if n.dot(p - centre) < 0:
        n = -n
    return p, n, dp.normalized(), dt.normalized()


def patch(name, phi0, phi1, drop0, drop1, grow, thick, mat, n=12):
    """A curved panel on the shell between two azimuths and two crown distances (Velcro, base plates)."""
    bm = bmesh.new()
    grid = []
    for i in range(n + 1):
        phi = phi0 + (phi1 - phi0) * i / n
        row = []
        for j in range(n // 2 + 1):
            d = drop0 + (drop1 - drop0) * j / (n // 2)
            row.append(bm.verts.new(shell_point(phi, theta_at(phi, d), grow)))
        grid.append(row)
    for i in range(n):
        for j in range(n // 2):
            bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
    o = mesh_obj(name, bm)
    s = o.modifiers.new("sol", "SOLIDIFY")
    s.thickness = thick * F.s
    s.offset = 1.0
    b = o.modifiers.new("bev", "BEVEL")
    b.width = min(0.0015, thick * 0.45) * F.s
    b.segments = 1
    apply_mods(o)
    set_mat(o, mat)
    smooth_shade(o, 35)
    return o


def build_rails(M):
    """ARC rails along both sides, sweeping from the temple back over the ear cut, with slots."""
    parts = []
    for side in (1, -1):
        pts, ups = [], []
        n = 24
        for i in range(n + 1):
            a = math.radians(38 + (156 - 38) * i / n)
            phi = side * a
            d = rim_drop(phi) - 0.017
            th = theta_at(phi, d)
            p, nrm, tp, tt = surface_frame(phi, th, -0.001)
            pts.append(p)
            ups.append(nrm)
        ws = [0.019 + 0.013 * min(1.0, math.sin(math.pi * k / n) * 2.2) for k in range(n + 1)]
        rail = sweep(f"rail{side}", pts, 0.032, 0.014, ups=ups, widths=ws)
        # Slots: a row of rectangular cut-outs along the rail.
        cutters = []
        for i in (4, 7, 10, 13, 16, 19):
            a = math.radians(38 + (156 - 38) * i / n)
            phi = side * a
            th = theta_at(phi, rim_drop(phi) - 0.017)
            p, nrm, tp, tt = surface_frame(phi, th, -0.001)
            bm = bmesh.new()
            bmesh.ops.create_cylinder(bm, cap_ends=True, segments=20, radius1=1.0, radius2=1.0, depth=1.0) if hasattr(bmesh.ops, "create_cylinder") else bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=1.0, radius2=1.0, depth=1.0)
            mat = Matrix((tp, tt, nrm)).transposed()
            for v in bm.verts:
                # An oval slot recessed into the rail's outer face.
                v.co = p + mat @ Vector((v.co.x * 0.0115 * F.s, v.co.y * 0.0068 * F.s, (v.co.z * 0.002 + 0.0135) * F.s))
            cutters.append(mesh_obj("slot", bm))
        slots = join(cutters, "slots")
        set_mat(slots, M["slot"])
        parts.append(slots)
        set_mat(rail, M["rail"])
        smooth_shade(rail, 30)
        parts.append(rail)
        # Screws at both ends.
        for a in (41, 70, 126, 153):
            phi = side * math.radians(a)
            th = theta_at(phi, rim_drop(phi) - 0.017)
            p, nrm, tp, tt = surface_frame(phi, th, 0.0135)
            bm = bmesh.new()
            bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.0036 * F.s, radius2=0.0028 * F.s, depth=0.0016 * F.s)
            rot = nrm.to_track_quat("Z", "Y").to_matrix()
            for v in bm.verts:
                v.co = p + rot @ v.co
            sc = mesh_obj("screw", bm)
            set_mat(sc, M["metal"])
            parts.append(sc)
    # Rail accessories that read at a distance: a strobe on the left rail, a battery counterweight at the back.
    phi = -math.radians(118)
    p, nrm, tp, tt = surface_frame(phi, theta_at(phi, rim_drop(phi) - 0.017), 0.014)
    rot = Matrix((tp, tt, nrm)).transposed()
    strobe = rounded_box(p + nrm * 0.008 * F.s, (0.03, 0.022, 0.016), 0.003, "strobe", rot)
    set_mat(strobe, M["rail"])
    parts.append(strobe)
    phi = math.pi
    p, nrm, tp, tt = surface_frame(phi, theta_at(phi, rim_drop(phi) - 0.05), 0.002)
    rot = Matrix((tp, tt, nrm)).transposed()
    pouch = rounded_box(p + nrm * 0.012 * F.s, (0.075, 0.06, 0.024), 0.006, "counterweight", rot)
    set_mat(pouch, M["velcro"])
    parts.append(pouch)
    return parts


def build_shroud(M):
    """NVG shroud on the front: a base plate following the shell and a skeletonised mount frame."""
    phi = 0.0
    d = rim_drop(0) - 0.034
    th = theta_at(phi, d)
    p, nrm, tp, tt = surface_frame(phi, th, 0.002)
    rot = Matrix((tp, tt, nrm)).transposed()
    base = patch("shroudbase", -0.4, 0.4, rim_drop(0) - 0.074, rim_drop(0) - 0.006, 0.0005, 0.0045, M["rail"])
    parts = [base]

    def box(sx, sy, sz, off, name):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = p + rot @ Vector((v.co.x * sx * F.s + off[0] * F.s, v.co.y * sy * F.s + off[1] * F.s, v.co.z * sz * F.s + off[2] * F.s))
        o = mesh_obj(name, bm)
        b = o.modifiers.new("bev", "BEVEL")
        b.width = 0.0012 * F.s
        b.segments = 2
        apply_mods(o)
        return o

    frame = box(0.066, 0.062, 0.022, (0, 0, 0.0135), "shroudframe")
    boolean(frame, box(0.044, 0.04, 0.06, (0, 0.006, 0.0135), "win"))
    for sx in (0.022, -0.022):
        boolean(frame, box(0.009, 0.024, 0.06, (sx * 1.5, -0.02, 0.0135), "side"))
    boolean(frame, box(0.07, 0.016, 0.014, (0, -0.024, 0.022), "notch"))
    lug = box(0.026, 0.016, 0.016, (0, 0.034, 0.01), "lug")
    ears_l = box(0.013, 0.04, 0.014, (0.039, -0.004, 0.01), "earL")
    ears_r = box(0.013, 0.04, 0.014, (-0.039, -0.004, 0.01), "earR")
    stub = box(0.03, 0.012, 0.026, (0, -0.035, 0.026), "stub")
    shroud = join([frame, lug, ears_l, ears_r, stub], "Head_Shroud")
    set_mat(shroud, M["rail"])
    smooth_shade(shroud, 30)
    parts.append(shroud)
    for sx, sy in ((0.025, 0.02), (-0.025, 0.02), (0.0, -0.027)):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.0028 * F.s, radius2=0.0024 * F.s, depth=0.002 * F.s)
        for v in bm.verts:
            v.co = p + rot @ (v.co + Vector((sx * F.s, sy * F.s, 0.0255 * F.s)))
        sc = mesh_obj("screw", bm)
        set_mat(sc, M["metal"])
        parts.append(sc)
    return parts


def build_velcro(M):
    parts = [
        patch("velTop", -0.42, 0.42, rim_drop(0) - 0.142, rim_drop(0) - 0.074, 0.0004, 0.0024, M["velcro"]),
        patch("velBack", math.pi - 0.38, math.pi + 0.38, rim_drop(math.pi) - 0.09, rim_drop(math.pi) - 0.045, 0.0004, 0.0012, M["velcro"]),
    ]
    for side in (1, -1):
        parts.append(patch("velSide", side * 0.9 - 0.2, side * 0.9 + 0.2, rim_drop(1.6) - 0.085, rim_drop(1.6) - 0.052, 0.0004, 0.0012, M["velcro"]))
    return parts


def build_straps(M):
    """Retention: a Y-strap from the shell on each side to a buckle below the ear, then under the chin."""
    parts = []
    E = EYE_DROP
    hc = F.p(0, 0.0, E + 0.02)
    for side in (1, -1):
        buckle = F.p(side * 0.085, 0.022, E + 0.07)
        for a in (58, 128):
            phi = side * math.radians(a)
            top = shell_point(phi, theta_at(phi, rim_drop(phi)), -0.006)
            pts = [top.lerp(buckle, t) + Vector((side * 0.012 * math.sin(t * math.pi) * F.s, 0, 0)) for t in [k / 10 for k in range(11)]]
            parts.append(sweep("ystrap", pts, 0.017, 0.0022, centre=hc))
    chin = [F.p(0.085, 0.022, E + 0.07), F.p(0.068, 0.05, E + 0.108), F.p(0.03, 0.082, E + 0.128), F.p(0, 0.09, E + 0.13),
            F.p(-0.03, 0.082, E + 0.128), F.p(-0.068, 0.05, E + 0.108), F.p(-0.085, 0.022, E + 0.07)]
    parts.append(sweep("chin", smooth_path(chin, 6), 0.017, 0.0022, centre=hc))
    strap = join(parts, "Head_Straps")
    set_mat(strap, M["strap"])
    smooth_shade(strap, 30)
    out = [strap]
    for side in (1, -1):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        c = F.p(side * 0.087, 0.022, E + 0.07)
        for v in bm.verts:
            v.co = c + Vector((v.co.x * 0.006 * F.s, v.co.y * 0.022 * F.s, v.co.z * 0.016 * F.s))
        b = mesh_obj("buckle", bm)
        bv = b.modifiers.new("bev", "BEVEL")
        bv.width = 0.002 * F.s
        bv.segments = 2
        apply_mods(b)
        set_mat(b, M["rail"])
        out.append(b)
    return out


# ---- goggles -------------------------------------------------------------------------------------------------------

G_HALF = math.radians(80)
G_V = (-0.029, 0.029)  # lens extent in metres around the eye line (down negative, up positive)


def lens_point(theta, v, grow=0.0):
    """A point on the lens surface: a wrap-around band in front of the eyes."""
    rx, ry = 0.093 + grow, 0.102 + grow
    bulge = 0.0045 * (1 - (v / 0.027) ** 2) * math.cos(theta * 0.8)
    x = math.sin(theta) * (rx + bulge)
    y = math.cos(theta) * (ry + bulge) - 0.008
    return F.p(x, y, EYE_DROP - v - 0.001)


def lens_inside(theta, v):
    """Lens outline: rounded corners, a notch for the nose bridge."""
    t = abs(theta) / G_HALF
    if t > 1:
        return False
    top = G_V[1] - 0.008 * t**4
    bot = G_V[0] + 0.012 * t**4
    nose = 0.017 * max(0.0, 1 - abs(theta) / math.radians(16)) ** 0.7
    return bot + nose < v < top


def build_goggles(M):
    nt, nv = 120, 40
    bm = bmesh.new()
    grid = [[None] * (nv + 1) for _ in range(nt + 1)]
    for i in range(nt + 1):
        th = -G_HALF - 0.02 + (2 * G_HALF + 0.04) * i / nt
        for j in range(nv + 1):
            v = G_V[0] - 0.004 + (G_V[1] - G_V[0] + 0.008) * j / nv
            if lens_inside(th, v):
                grid[i][j] = bm.verts.new(lens_point(th, v))
    for i in range(nt):
        for j in range(nv):
            q = (grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1])
            if all(q):
                bm.faces.new(q)
    bm.normal_update()
    lens = mesh_obj("Head_Lens", bm)
    s = lens.modifiers.new("sol", "SOLIDIFY")
    s.thickness = 0.0022 * F.s
    apply_mods(lens)
    set_mat(lens, M["lens"])
    smooth_shade(lens, 180)
    # Frame: a rubber band around the outline that reaches back to the face, built from the lens boundary.
    bm = bmesh.new()
    bm.from_mesh(lens.data)
    # Rebuild a thin outline ribbon: walk the outline in parameter space instead (clean and even).
    bm.free()
    outline = []
    steps = 220
    for k in range(steps):
        a = k / steps * 2 * math.pi
        # March outward from the lens centre to the boundary at this angle.
        dth, dv = math.cos(a), math.sin(a)
        r0, r1 = 0.0, 1.0
        for _ in range(26):
            r = (r0 + r1) / 2
            th = dth * r * (G_HALF + 0.02)
            vv = 0.001 + dv * r * 0.03
            if lens_inside(th, vv):
                r0 = r
            else:
                r1 = r
        outline.append((dth * r0 * (G_HALF + 0.02), 0.001 + dv * r0 * 0.03))
    bm = bmesh.new()
    rings = []
    for th, vv in outline:
        # Normal of the outline in parameter space, pointing outward.
        out_front = lens_point(th, vv, 0.0015)
        out_back = lens_point(th, vv, -0.012)  # toward the face
        lip = lens_point(th * 1.0, vv, 0.0015)
        rings.append((bm.verts.new(out_front), bm.verts.new(out_back)))
    n = len(rings)
    for k in range(n):
        a, b = rings[k], rings[(k + 1) % n]
        bm.faces.new((a[0], b[0], b[1], a[1]))
    fr = mesh_obj("Head_GoggleFrame", bm)
    sol = fr.modifiers.new("sol", "SOLIDIFY")
    sol.thickness = 0.0034 * F.s
    sol.offset = 0.0
    apply_mods(fr)
    # A wider rim around the outside of the lens front.
    bm = bmesh.new()
    ring2 = []
    K = 0.095  # metres per radian along the lens
    m = len(outline)
    for k, (th, vv) in enumerate(outline):
        a, b = outline[(k - 1) % m], outline[(k + 1) % m]
        tx, ty = (b[0] - a[0]) * K, b[1] - a[1]
        nx, ny = ty, -tx
        ln = math.hypot(nx, ny) or 1.0
        nx, ny = nx / ln, ny / ln
        if nx * th * K + ny * (vv - 0.001) < 0:
            nx, ny = -nx, -ny
        inner = lens_point(th, vv, 0.0018)
        outer = lens_point(th + nx * 0.0045 / K, vv + ny * 0.0045, 0.0008)
        ring2.append((bm.verts.new(inner), bm.verts.new(outer)))
    for k in range(n):
        a, b = ring2[k], ring2[(k + 1) % n]
        bm.faces.new((a[0], b[0], b[1], a[1]))
    rim = mesh_obj("rim", bm)
    sol = rim.modifiers.new("sol", "SOLIDIFY")
    sol.thickness = 0.0025 * F.s
    apply_mods(rim)
    fr = join([fr, rim], "Head_GoggleFrame")
    set_mat(fr, M["frame"])
    smooth_shade(fr, 40)
    # Strap: from both frame ends around the back of the helmet.
    pts = []
    for k in range(41):
        phi = math.radians(80 + (360 - 160) * k / 40)
        ph = math.atan2(math.sin(phi), math.cos(phi))
        drop = min(EYE_DROP - 0.006 - 0.02 * math.sin(k / 40 * math.pi), rim_drop(ph) - 0.01)
        a = abs(math.degrees(ph))
        over_rail = max(0.0, min(1.0, (a - 34) / 8, (160 - a) / 8))
        pts.append(shell_point(ph, theta_at(ph, drop), 0.0015 + 0.0105 * over_rail))
    pts = [lens_point(G_HALF + 0.03, 0.001, 0.0)] + pts + [lens_point(-G_HALF - 0.03, 0.001, 0.0)]
    strap = sweep("Head_GoggleStrap", smooth_path(pts, 3), 0.03, 0.0022, centre=F.p(0, -0.01, EYE_DROP))
    set_mat(strap, M["strap"])
    return [link(lens), link(fr), link(strap)]


# ---- headset -------------------------------------------------------------------------------------------------------

def rounded_box(c, size, radius, name, rot=None, segs=4):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) * F.s
    o = mesh_obj(name, bm)
    b = o.modifiers.new("bev", "BEVEL")
    b.width = radius * F.s
    b.segments = segs
    b.limit_method = "NONE"
    apply_mods(o)
    if rot is not None:
        o.data.transform(rot.to_4x4())
    o.data.transform(Matrix.Translation(c))
    smooth_shade(o, 50)
    return o


def cup_prism(c, ry, rz, depth, side, name, bevel=0.006, n_exp=3.4, tilt=None):
    """A superelliptic disc, depth along x: the ComTac-style rounded-rectangle ear cup and its parts."""
    bm = bmesh.new()
    steps = 48
    rings = []
    for x in (-depth / 2, depth / 2):
        ring = []
        for k in range(steps):
            a = k / steps * 2 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            y = ry * math.copysign(abs(ca) ** (2 / n_exp), ca)
            z = rz * math.copysign(abs(sa) ** (2 / n_exp), sa)
            ring.append(bm.verts.new(Vector((x, y, z)) * F.s))
        rings.append(ring)
    for k in range(steps):
        a0, a1, b0, b1 = rings[0][k], rings[0][(k + 1) % steps], rings[1][k], rings[1][(k + 1) % steps]
        bm.faces.new((a0, a1, b1, b0))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[1])
    o = mesh_obj(name, bm)
    bv = o.modifiers.new("bev", "BEVEL")
    bv.width = bevel * F.s
    bv.segments = 4
    bv.limit_method = "ANGLE"
    apply_mods(o)
    rot = tilt if tilt is not None else Matrix.Identity(3)
    o.data.transform(rot.to_4x4())
    o.data.transform(Matrix.Translation(c))
    smooth_shade(o, 35)
    return o


def build_headset(M):
    parts = []
    E = EYE_DROP
    for side in (1, -1):
        tilt = Matrix.Rotation(math.radians(side * -5), 3, "Y") @ Matrix.Rotation(math.radians(10), 3, "X")
        c = F.p(side * 0.099, -0.006, E + 0.014)
        out = tilt @ Vector((side, 0, 0))
        cup = cup_prism(c, 0.034, 0.045, 0.03, side, "cup", 0.009, 3.2, tilt)
        set_mat(cup, M["headset"])
        cover = cup_prism(c + out * 0.017 * F.s, 0.028, 0.038, 0.007, side, "cover", 0.003, 3.0, tilt)
        set_mat(cover, M["rail"])
        inner = cup_prism(c + out * 0.0215 * F.s, 0.021, 0.03, 0.004, side, "inner", 0.0018, 2.6, tilt)
        set_mat(inner, M["headset"])
        parts.append(inner)
        cush = cup_prism(c - out * 0.019 * F.s, 0.034, 0.045, 0.014, side, "cushion", 0.0065, 3.0, tilt)
        set_mat(cush, M["cushion"])
        parts += [cup, cover, cush]
        # Push buttons on the front of the cup and a knob on top.
        for local, r, axis in (((0, 0.033, 0.012), 0.0052, "Y"), ((0, 0.033, -0.008), 0.0052, "Y"), ((0.004, 0.0, 0.046), 0.006, "Z")):
            bm = bmesh.new()
            bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=r * F.s, radius2=r * 0.85 * F.s, depth=0.006 * F.s)
            rot = Matrix.Rotation(math.radians(-90), 3, "X") if axis == "Y" else Matrix.Identity(3)
            for v in bm.verts:
                v.co = c + tilt @ (rot @ v.co + Vector((local[0] * side, local[1], local[2])) * F.s)
            kb = mesh_obj("knob", bm)
            set_mat(kb, M["rail"])
            parts.append(kb)
        # Yoke from the cup top up to the headband.
        top = c + tilt @ Vector((side * 0.004, 0, 0.046)) * F.s
        yoke = rounded_box(top + Vector((0, 0, 0.008)) * F.s, (0.012, 0.026, 0.02), 0.003, "yoke", tilt)
        set_mat(yoke, M["rail"])
        parts.append(yoke)
    # Headband: from one yoke up over the helmet shell and down to the other, padded on top.
    pts = []
    for side in (1, -1):
        c = F.p(side * 0.099, -0.006, E + 0.014)
        seg = [c + Vector((side * 0.01, 0, 0.062)) * F.s]
        phi = side * math.radians(90)
        th0 = theta_at(phi, rim_drop(phi) - 0.004)
        for k in range(11):
            th = th0 * (1 - k / 10)
            seg.append(shell_point(phi, max(th, 0.001), 0.009))
        pts += seg if side > 0 else list(reversed(seg))
    pts = smooth_path(pts, 3)
    hb_centre = F.p(0, -0.006, 0.09)
    band = sweep("headband", pts, 0.024, 0.0045, centre=hb_centre)
    set_mat(band, M["rail"])
    pad = [p for p in pts if (F.crown - p.z) / F.s < 0.02]
    if len(pad) > 2:
        cushion_band = sweep("headpad", pad, 0.03, 0.009, centre=hb_centre, base=0.004)
        set_mat(cushion_band, M["cushion"])
        parts.append(cushion_band)
    parts.append(band)
    # Boom mic from the left cup (-X) round to the mouth.
    c = F.p(-0.099, -0.006, E + 0.014)
    # A long boom from the front of the left cup along the jaw, curving in front of the mouth.
    boom = [c + Vector((-0.012, 0.03, -0.02)) * F.s, F.p(-0.106, 0.052, E + 0.058), F.p(-0.096, 0.082, E + 0.075),
            F.p(-0.068, 0.108, E + 0.083), F.p(-0.034, 0.122, E + 0.082)]
    parts.append(curve_obj("boom", boom, depth=0.0036 * F.s, res=10))
    set_mat(parts[-1], M["rail"])
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=1.0)
    tip = F.p(-0.012, 0.124, E + 0.081)
    for v in bm.verts:
        v.co = tip + Vector((v.co.x * 0.02, v.co.y * 0.014, v.co.z * 0.013)) * F.s
    foam = mesh_obj("micfoam", bm)
    set_mat(foam, M["foam"])
    parts.append(foam)
    # Cable from the cup down into the collar.
    cab = [c + Vector((-0.004, -0.01, -0.044)) * F.s, F.p(-0.094, -0.02, E + 0.12), F.p(-0.08, -0.03, E + 0.2)]
    parts.append(curve_obj("cable", cab, depth=0.0018 * F.s, res=6))
    set_mat(parts[-1], M["cushion"])
    # Join by material so the export keeps few objects.
    by_mat = {}
    for p in parts:
        by_mat.setdefault(p.data.materials[0].name, []).append(p)
    out = []
    for name, objs in by_mat.items():
        o = join(objs, "Head_Headset" if name == "Head_Headset" else f"Head_Headset_{name.split('_')[1]}")
        out.append(link(o))
    return out


# ---- assembly ------------------------------------------------------------------------------------------------------

def make_low(high, name, tris, planar=False):
    """A decimated export copy of a dense object; the dense one keeps `high` for baking."""
    low = high.copy()
    low.data = high.data.copy()
    low.name = low.data.name = name
    coll().objects.link(low)
    if planar:
        decimate_planar(low, tris)
    else:
        decimate_to(low, tris)
    high["high"] = 1
    high.hide_render = False
    return low


def main():
    global F
    reset()
    F = body_frame()
    M = materials()
    head = build_head_base()
    face = build_face_low(head, M)
    eyes = build_eyes(M)
    brows = build_brows(M)
    mask_high = build_mask(head, M)
    set_mat(head, M["skin"])
    link(head)
    head["high"] = 1
    head.hide_render = True  # only for baking; the mask covers it
    shell, trim = build_shell(M)
    rails = build_rails(M)
    shroud = build_shroud(M)
    velcro = build_velcro(M)
    straps = build_straps(M)
    goggles = build_goggles(M)
    headset = build_headset(M)

    hardware = join(rails + shroud + velcro + [trim], "Head_HelmetParts")
    link(hardware)
    for o in straps:
        link(o)
    buckle = join([o for o in straps if o.name.startswith("buckle")], "Head_Buckles")
    link(buckle)

    # Export copies within the 8k budget.
    lows = [
        make_low(shell, "Head_Helmet", 1700),
        make_low(hardware, "Head_HelmetGear", 1150, planar=True),
        make_low(mask_high, "Head_Mask", 1200),
    ]
    for o in (shell, hardware, mask_high):
        o.hide_render = True
    # Decimation cuts corners: keep the export mask outside the body's head too.
    mlow = bpy.data.objects.get("Head_Mask")
    if mlow:
        print(f"[head] export mask: {wrap_outside(mlow, 0.0035, 6)} vertices needed a push")
    decimate_to(face, 700)
    for o in headset:
        decimate_planar(o, {"Head_Headset": 380, "Head_Headset_Rail": 320}.get(o.name, 180), 6)
    for o in goggles:
        decimate_to(o, 360)
    strap_obj = bpy.data.objects.get("Head_Straps")
    if strap_obj:
        decimate_to(strap_obj, 300)
    decimate_to(buckle, 60)
    for o in eyes:
        decimate_to(o, 350)

    total = 0
    for o in coll().objects:
        if o.type == "MESH" and not o.get("high"):
            total += tri_count(o)
    print(f"[head] export tris: {total}")
    for o in sorted(coll().objects, key=lambda o: o.name):
        if o.type == "MESH":
            print(f"   {o.name:22s} {tri_count(o):7d} tris {'(high)' if o.get('high') else ''}  {[m.name for m in o.data.materials]}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    if PREVIEW:
        preview(PREVIEW)
    # Drop helper objects not in the Head collection, then save.
    for o in list(bpy.context.scene.collection.objects):
        bpy.data.objects.remove(o)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT), compress=True)
    print("[head] saved", OUT)


# ---- preview renders -----------------------------------------------------------------------------------------------

LOWS = ("Head_Helmet", "Head_HelmetGear", "Head_Mask", "Head_Face")


def preview(outdir: Path):
    outdir.mkdir(parents=True, exist_ok=True)
    for o in coll().objects:
        if o.get("high"):
            o.hide_render = False
        if o.name in LOWS:
            o.hide_render = True
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dev in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = dev
            prefs.get_devices()
            for d in prefs.devices:
                d.use = True
            sc.cycles.device = "GPU"
            break
        except Exception:
            continue
    sc.cycles.samples = 160
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    # A light-grey studio like the reference sheet: the backdrop reads about #d0d0d2.
    wn = world.node_tree.nodes
    bg_light = wn["Background"]
    bg_light.inputs["Color"].default_value = (0.08, 0.082, 0.086, 1)
    bg_light.inputs["Strength"].default_value = 1.0
    bg_cam = wn.new("ShaderNodeBackground")
    bg_cam.inputs["Color"].default_value = (0.62, 0.63, 0.65, 1)
    lp = wn.new("ShaderNodeLightPath")
    mix = wn.new("ShaderNodeMixShader")
    world.node_tree.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    world.node_tree.links.new(bg_light.outputs["Background"], mix.inputs[1])
    world.node_tree.links.new(bg_cam.outputs["Background"], mix.inputs[2])
    world.node_tree.links.new(mix.outputs["Shader"], wn["World Output"].inputs["Surface"])
    sc.world = world
    # A dark mannequin neck/shoulder hint so the gaiter does not float.
    bpy.ops.mesh.primitive_cylinder_add(radius=0.2 * F.s, depth=0.2 * F.s, location=F.p(0, -0.02, 0.4))
    body = bpy.context.active_object
    body.data.materials.append(principled("prev_body", (0.02, 0.022, 0.035), 0.8))
    E = EYE_DROP

    def light(name, loc, energy, size, color=(1, 1, 1)):
        l = bpy.data.lights.new(name, "AREA")
        l.energy = energy
        l.size = size
        l.color = color
        o = bpy.data.objects.new(name, l)
        o.location = loc
        sc.collection.objects.link(o)
        d = F.p(0, 0, E) - o.location
        o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

    light("key", F.p(0.55, 0.55, E - 0.95), 12, 0.6)
    light("fill", F.p(-0.9, 0.5, E - 0.1), 2.5, 1.5)
    light("front", F.p(0.0, 1.1, E + 0.15), 4.5, 0.8)
    light("rim", F.p(-0.3, -0.9, E - 0.6), 9, 0.8)
    cam_d = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam

    def shot(name, loc, target, lens, w, h, hide=()):
        hidden = []
        dense = ("Head_HeadHigh", "Head_MaskHigh", "Head_HelmetHigh", "Head_HelmetParts")
        for o in coll().objects:
            if (any(o.name.startswith(k) for k in hide) or (len(hide) > 4 and o.name in dense)) and not o.hide_render:
                o.hide_render = True
                hidden.append(o)
        cam.location = loc
        cam.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
        cam_d.lens = lens
        sc.render.resolution_x = w
        sc.render.resolution_y = h
        sc.render.filepath = str(outdir / f"{name}.png")
        bpy.ops.render.render(write_still=True)
        for o in hidden:
            o.hide_render = False

    t = F.p(0, 0.01, E + 0.035)
    shot("headgog", F.p(0.03, 0.62, E + 0.03), t, 85, 404, 488)
    shot("mask", F.p(0.2, 0.52, E + 0.005), F.p(0.012, 0.05, E + 0.045), 85, 312, 488)
    shot("left", F.p(-0.66, 0.06, E + 0.0), F.p(0, 0.01, E + 0.04), 85, 542, 480)
    shot("helmet", F.p(0.38, 0.5, E - 0.13), F.p(0, 0.0, E - 0.01), 85, 420, 480, hide=("Head_Lens", "Head_Goggle"))
    shot("front", F.p(0, 0.75, E + 0.04), F.p(0, 0.0, E + 0.06), 70, 540, 480)
    shot("headset", F.p(0.45, 0.42, E - 0.03), F.p(0.09, 0.0, E + 0.03), 85, 480, 480,
         hide=("Head_Helmet", "Head_Mask", "Head_Lens", "Head_Goggle", "Head_Face", "Head_Eye", "Head_Brow", "Head_Straps", "Head_Buckles"))
    for o in coll().objects:
        if o.get("high"):
            o.hide_render = True
        if o.name in LOWS:
            o.hide_render = False


main()
