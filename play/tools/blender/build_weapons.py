"""
Builds the Last Light guns (weapons.glb) and first-person arms (arms.glb) in Blender.

    blender --background --factory-startup --python build_weapons.py -- <output-dir> [weapons|arms] [--preview <dir>] [--only m4a1,glock] [--nobake]

Hard-surface modelling from side profiles (extruded silhouettes with bevels and weighted normals) plus small parts, then
every gun is UV-unwrapped and its procedural Cycles materials are baked into one texture set per gun: base colour
(wood grain, edge wear, grime), roughness, metalness and a normal map (rounded edges from the Bevel node, stippling,
checkering, fabric). One material per gun keeps the viewmodel to a draw call or two.

Conventions frontend/src/games/zombies/models.ts relies on:
  * One root object per weapon id, named the id. Origin at the pistol grip, where the right palm sits. Blender +Y is
    the barrel direction (glTF -Z).
  * Children: <id>_muzzle (empty at the muzzle), <id>_sight (empty at the rear sight / optic eye point) and the mesh
    <id>_mag (origin at the top of the magazine, so it can drop down on a reload).
  * arms.glb: meshes ArmR and ArmL, origin at the camera, looking along +Y (glTF -Z). Right palm (the gun origin) at
    PALM, left hand under a rifle handguard at LEFT.
"""

import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def _opt(name, default=None):
    if name in ARGV:
        i = ARGV.index(name)
        val = ARGV[i + 1] if i + 1 < len(ARGV) else default
        del ARGV[i:i + 2]
        return val
    return default


def _flag(name):
    if name in ARGV:
        ARGV.remove(name)
        return True
    return False


PREVIEW = _opt("--preview")
_only = _opt("--only")
ONLY_GUNS = _only.split(",") if _only else None
NOBAKE = _flag("--nobake")
OUT = Path(ARGV[0]) if ARGV else Path("models/zombies")
WHAT = ARGV[1] if len(ARGV) > 1 else None

# Camera-space anchors of the first-person rig (Blender axes: x right, y forward, z up).
PALM = Vector((0.12, 0.33, -0.21))
LEFT = Vector((0.02, 0.53, -0.19))
RAKE = math.radians(18)

# ---- scene helpers -------------------------------------------------------------------------------------------------


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.curves, bpy.data.metaballs):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)


def link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def to_mesh(obj):
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.active_object


def smooth_all(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def hard_surface(obj, bev=0.0012, segs=2, angle=35):
    """Bevelled edges and weighted normals: the hard-surface look at a low triangle count."""
    if bev > 0:
        m = obj.modifiers.new("Bevel", "BEVEL")
        m.width = bev
        m.segments = segs
        m.limit_method = "ANGLE"
        m.angle_limit = math.radians(angle)
        m.harden_normals = True
    smooth_all(obj)
    w = obj.modifiers.new("WNormal", "WEIGHTED_NORMAL")
    w.keep_sharp = True
    w.weight = 50
    return obj


def mesh_obj(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = link(bpy.data.objects.new(name, me))
    me.materials.append(mat)
    return obj


def prof(pts, w, mat, x=0.0, bev=0.0012, segs=2, angle=35):
    """Side silhouette (y, z points, any order around) extruded `w` wide across x, centred on `x`."""
    bm = bmesh.new()
    vs = [bm.verts.new((x - w / 2, y, z)) for (y, z) in pts]
    f = bm.faces.new(vs)
    res = bmesh.ops.extrude_face_region(bm, geom=[f])
    moved = [e for e in res["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(w, 0, 0), verts=moved)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = mesh_obj("prof", bm, mat)
    return hard_surface(obj, bev, segs, angle)


def box(size, loc, mat, rot=(0, 0, 0), bev=0.0008, segs=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    obj = mesh_obj("box", bm, mat)
    obj.location = loc
    obj.rotation_euler = rot
    return hard_surface(obj, bev, segs)


def cyl_between(a, b, r, mat, verts=20, r2=None, cap=True, bev=0.0006):
    a, b = Vector(a), Vector(b)
    d = b - a
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=d.length)
    obj = mesh_obj("cyl", bm, mat)
    obj.location = (a + b) / 2
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return hard_surface(obj, bev, 1, 40)


def cy(r, y0, y1, z, mat, x=0.0, verts=20, r2=None, bev=0.0006):
    """Cylinder along +Y."""
    return cyl_between((x, y0, z), (x, y1, z), r, mat, verts, r2, bev=bev)


def ring_y(r, minor, y, z, mat, x=0.0, segs=24):
    """A torus around the Y axis (barrel bands, scope rings)."""
    bpy.ops.mesh.primitive_torus_add(location=(x, y, z), rotation=(math.radians(90), 0, 0), major_radius=r, minor_radius=minor, major_segments=segs, minor_segments=8)
    t = bpy.context.active_object
    t.data.materials.append(mat)
    smooth_all(t)
    return t


def tube(points, r, mat, res=6, bev_res=4):
    """A pipe through points (trigger guards, sling loops, bails)."""
    cu = bpy.data.curves.new("tube", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = bev_res
    cu.use_fill_caps = True
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(points) - 1)
    for bp, p in zip(sp.bezier_points, points):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    sp.resolution_u = res
    obj = link(bpy.data.objects.new("tube", cu))
    obj.data.materials.append(mat)
    obj = to_mesh(obj)
    smooth_all(obj)
    return obj


def sphere(r, loc, mat, segs=16, rings=10, scale=(1, 1, 1)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r)
    obj = mesh_obj("sph", bm, mat)
    obj.location = loc
    obj.scale = scale
    smooth_all(obj)
    return obj


def join(objs, name):
    objs = [to_mesh(o) if o.type != "MESH" or o.modifiers else o for o in objs]
    for o in objs:
        activate(o)
        bpy.ops.object.convert(target="MESH")
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def set_origin(obj, point):
    d = Vector(point) - obj.location
    obj.data.transform(Matrix.Translation(-d))
    obj.location = Vector(point)


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---- procedural materials (baked later) ----------------------------------------------------------------------------

def _sock(node, ident, out=False):
    for s in (node.outputs if out else node.inputs):
        if s.identifier == ident:
            return s
    raise KeyError(ident)


class NB:
    """Tiny node-graph builder."""

    def __init__(self, mat):
        self.nt = mat.node_tree
        self.n = self.nt.nodes
        self.l = self.nt.links

    def node(self, kind, **props):
        nd = self.n.new(kind)
        for k, val in props.items():
            setattr(nd, k, val)
        return nd

    def link(self, a, b):
        self.l.new(a, b)

    def math(self, op, a, b=None, clamp=False):
        m = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                self.link(v, m.inputs[i])
        return m.outputs[0]

    def mix(self, fac, a, b, blend="MIX"):
        m = self.node("ShaderNodeMix", data_type="RGBA", blend_type=blend)
        if isinstance(fac, (int, float)):
            m.inputs[0].default_value = fac
        else:
            self.link(fac, m.inputs[0])
        for sock, v in ((_sock(m, "A_Color"), a), (_sock(m, "B_Color"), b)):
            if isinstance(v, tuple):
                sock.default_value = (*v, 1.0) if len(v) == 3 else v
            else:
                self.link(v, sock)
        return _sock(m, "Result_Color", out=True)

    def mapr(self, v, a, b, c=0.0, d=1.0):
        m = self.node("ShaderNodeMapRange", clamp=True)
        self.link(v, m.inputs["Value"])
        m.inputs["From Min"].default_value = a
        m.inputs["From Max"].default_value = b
        m.inputs["To Min"].default_value = c
        m.inputs["To Max"].default_value = d
        return m.outputs["Result"]

    def noise(self, vec, scale, detail=4.0, rough=0.55):
        t = self.node("ShaderNodeTexNoise")
        t.inputs["Scale"].default_value = scale
        t.inputs["Detail"].default_value = detail
        t.inputs["Roughness"].default_value = rough
        self.link(vec, t.inputs["Vector"])
        return t


_mats = {}


def pmat(name, base, rough, metal=0.0, wear=None, wear_rough=None, grain=None, bump=0.0, bump_scale=900.0, bump_kind="noise", grime=0.55, emission=None, vary=0.25, scratches=0.0, rough_var=0.18):
    """A procedural Principled material. `wear` is the colour of worn edges; `grain` = (dark, light) for wood;
    `scratches` (0..1) adds fine scuffs along the gun in the wear colour; `rough_var` is the smudge roughness spread."""
    if name in _mats:
        return _mats[name]
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    mat["metal"] = metal
    mat["emissive"] = emission is not None
    nb = NB(mat)
    bsdf = nb.n.get("Principled BSDF")
    tc = nb.node("ShaderNodeTexCoord")
    obj_co = tc.outputs["Object"]
    geo = nb.node("ShaderNodeNewGeometry")
    # Edge mask: where a rounded-edge normal departs from the true normal, the edge sees wear.
    bev = nb.node("ShaderNodeBevel", samples=8)
    bev.inputs["Radius"].default_value = 0.0022
    vm = nb.node("ShaderNodeVectorMath", operation="DOT_PRODUCT")
    nb.link(bev.outputs["Normal"], vm.inputs[0])
    nb.link(geo.outputs["Normal"], vm.inputs[1])
    edge = nb.mapr(_sock(vm, "Value", out=True), 0.985, 0.90)
    wear_noise = nb.noise(obj_co, 160.0, 6.0, 0.7)
    edge = nb.math("MULTIPLY", edge, nb.mapr(wear_noise.outputs["Fac"], 0.38, 0.62), clamp=True)
    # Base colour: grain or flat, broken up by large-scale variation.
    if grain:
        sc = nb.node("ShaderNodeMapping")
        sc.inputs["Scale"].default_value = (14.0, 1.4, 14.0)
        nb.link(obj_co, sc.inputs["Vector"])
        wave = nb.node("ShaderNodeTexWave", wave_type="RINGS", rings_direction="Y")
        wave.inputs["Scale"].default_value = 6.0
        wave.inputs["Distortion"].default_value = 9.0
        wave.inputs["Detail"].default_value = 3.0
        wave.inputs["Detail Scale"].default_value = 2.0
        nb.link(sc.outputs["Vector"], wave.inputs["Vector"])
        fine = nb.noise(sc.outputs["Vector"], 40.0, 8.0, 0.6)
        g = nb.math("MULTIPLY", wave.outputs["Fac"], fine.outputs["Fac"])
        g = nb.mapr(g, 0.08, 0.5)
        col = nb.mix(g, grain[0], grain[1])
    else:
        big = nb.noise(obj_co, 18.0, 3.0)
        v = nb.mapr(big.outputs["Fac"], 0.3, 0.7, 1.0 - vary, 1.0 + vary * 0.4)
        comb = nb.node("ShaderNodeCombineColor")
        for i in range(3):
            nb.link(v, comb.inputs[i])
        col = nb.mix(1.0, base, comb.outputs[0], "MULTIPLY")
    if wear:
        col = nb.mix(edge, col, wear)
    scr = None
    if scratches and wear:
        # Thin contour lines of a noise stretched along the barrel axis, clustered by a second, sparse noise.
        st = nb.node("ShaderNodeMapping")
        st.inputs["Scale"].default_value = (1.0, 0.06, 1.0)
        st.inputs["Rotation"].default_value = (0.0, 0.0, math.radians(4))
        nb.link(obj_co, st.inputs["Vector"])
        line = nb.noise(st.outputs["Vector"], 220.0, 2.0, 0.5)
        d = nb.math("ABSOLUTE", nb.math("SUBTRACT", line.outputs["Fac"], 0.5))
        scr = nb.mapr(d, 0.0, 0.006, 1.0, 0.0)
        patch = nb.noise(obj_co, 22.0, 2.0)
        scr = nb.math("MULTIPLY", scr, nb.mapr(patch.outputs["Fac"], 0.48, 0.62, 0.0, scratches), clamp=True)
        col = nb.mix(scr, col, wear)
    # Grime in the crevices.
    ao = nb.node("ShaderNodeAmbientOcclusion", samples=8, inside=False)
    ao.inputs["Distance"].default_value = 0.012
    grime_f = nb.mapr(ao.outputs["AO"], 0.0, 1.0, grime, 1.0)
    gm = nb.node("ShaderNodeCombineColor")
    for i in range(3):
        nb.link(grime_f, gm.inputs[i])
    col = nb.mix(1.0, col, gm.outputs[0], "MULTIPLY")
    nb.link(col, bsdf.inputs["Base Color"])
    # Roughness: base, smudges, polished edges.
    smudge = nb.noise(obj_co, 45.0, 4.0)
    r = nb.mapr(smudge.outputs["Fac"], 0.3, 0.7, rough * (1 - rough_var), min(1.0, rough * (1 + rough_var)))
    if wear_rough is not None:
        r = nb.math("ADD", nb.math("MULTIPLY", r, nb.math("SUBTRACT", 1.0, edge)), nb.math("MULTIPLY", edge, wear_rough))
        if scr is not None:
            r = nb.math("ADD", nb.math("MULTIPLY", r, nb.math("SUBTRACT", 1.0, scr)), nb.math("MULTIPLY", scr, wear_rough))
    nb.link(r, bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = metal
    # Normal: rounded edges plus surface texture.
    normal = bev.outputs["Normal"]
    if bump > 0:
        if bump_kind == "checker":
            sc2 = nb.node("ShaderNodeMapping")
            sc2.inputs["Rotation"].default_value = (math.radians(45), 0, 0)
            nb.link(obj_co, sc2.inputs["Vector"])
            ck = nb.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Y", wave_profile="TRI")
            ck.inputs["Scale"].default_value = bump_scale
            nb.link(sc2.outputs["Vector"], ck.inputs["Vector"])
            ck2 = nb.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Z", wave_profile="TRI")
            ck2.inputs["Scale"].default_value = bump_scale
            nb.link(sc2.outputs["Vector"], ck2.inputs["Vector"])
            h = nb.math("MINIMUM", ck.outputs["Fac"], ck2.outputs["Fac"])
        elif bump_kind == "voronoi":
            vo = nb.node("ShaderNodeTexVoronoi")
            vo.inputs["Scale"].default_value = bump_scale
            nb.link(obj_co, vo.inputs["Vector"])
            h = vo.outputs["Distance"]
        elif bump_kind == "weave":
            w1 = nb.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="X", wave_profile="SIN")
            w1.inputs["Scale"].default_value = bump_scale
            nb.link(obj_co, w1.inputs["Vector"])
            w2 = nb.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Z", wave_profile="SIN")
            w2.inputs["Scale"].default_value = bump_scale
            nb.link(obj_co, w2.inputs["Vector"])
            fold = nb.noise(obj_co, 30.0, 2.0)
            h = nb.math("ADD", nb.math("MULTIPLY", w1.outputs["Fac"], w2.outputs["Fac"]), nb.math("MULTIPLY", fold.outputs["Fac"], 3.0))
        else:
            h = nb.noise(obj_co, bump_scale, 8.0, 0.6).outputs["Fac"]
        bp = nb.node("ShaderNodeBump")
        bp.inputs["Strength"].default_value = bump
        bp.inputs["Distance"].default_value = 0.0004
        nb.link(h, bp.inputs["Height"])
        nb.link(normal, bp.inputs["Normal"])
        normal = bp.outputs["Normal"]
    nb.link(normal, bsdf.inputs["Normal"])
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 4.0
        mat["emit"] = list(emission)
    mat["base"] = list(base)
    _mats[name] = mat
    return mat


class Mats:
    def __init__(self):
        self.blued = pmat("Blued", (0.032, 0.036, 0.046), 0.32, 0.9, wear=(0.42, 0.42, 0.43), wear_rough=0.18, bump=0.15, bump_scale=1400)
        self.park = pmat("Parkerized", (0.055, 0.058, 0.054), 0.62, 0.75, wear=(0.3, 0.3, 0.3), wear_rough=0.3, bump=0.25, bump_scale=2200)
        self.alu = pmat("Anodized", (0.038, 0.038, 0.041), 0.48, 0.55, wear=(0.55, 0.55, 0.57), wear_rough=0.25, bump=0.1, bump_scale=1800)
        self.steel = pmat("BareSteel", (0.35, 0.35, 0.36), 0.26, 1.0, bump=0.08, bump_scale=1500, grime=0.45)
        self.poly = pmat("Polymer", (0.03, 0.03, 0.032), 0.66, 0.0, wear=(0.085, 0.085, 0.09), wear_rough=0.45, bump=0.18, bump_scale=2500)
        self.stipple = pmat("Stipple", (0.028, 0.028, 0.03), 0.8, 0.0, wear=(0.07, 0.07, 0.075), bump=0.9, bump_scale=900, bump_kind="voronoi")
        self.tan = pmat("PolymerTan", (0.32, 0.25, 0.16), 0.7, 0.0, wear=(0.42, 0.36, 0.26), bump=0.18, bump_scale=2500)
        self.walnut = pmat("Walnut", (0.2, 0.08, 0.03), 0.42, 0.0, wear=(0.36, 0.2, 0.1), wear_rough=0.6, grain=((0.09, 0.035, 0.014), (0.26, 0.11, 0.045)), bump=0.12, bump_scale=600)
        self.beech = pmat("Beech", (0.32, 0.15, 0.06), 0.45, 0.0, wear=(0.48, 0.27, 0.12), wear_rough=0.6, grain=((0.17, 0.07, 0.025), (0.42, 0.2, 0.08)), bump=0.12, bump_scale=600)
        self.checker = pmat("WalnutCheckered", (0.16, 0.065, 0.025), 0.55, 0.0, grain=((0.08, 0.03, 0.012), (0.2, 0.08, 0.035)), bump=1.2, bump_scale=420, bump_kind="checker")
        self.rubber = pmat("Rubber", (0.022, 0.022, 0.022), 0.9, 0.0, bump=0.5, bump_scale=1600)
        self.copper = pmat("Copper", (0.62, 0.3, 0.17), 0.3, 1.0, grime=0.6)
        self.brass = pmat("Brass", (0.64, 0.45, 0.17), 0.28, 1.0, wear=(0.8, 0.62, 0.3), grime=0.5)
        self.shell = pmat("ShellRed", (0.38, 0.04, 0.035), 0.5, 0.0, bump=0.1)
        self.black = pmat("Recess", (0.006, 0.006, 0.007), 0.85, 0.0, grime=1.0)
        self.lens = pmat("Lens", (0.012, 0.016, 0.024), 0.05, 0.3, grime=1.0, vary=0.0)
        self.white = pmat("SightDot", (0.8, 0.78, 0.7), 0.5, 0.0, grime=1.0, vary=0.0)
        self.olive = pmat("OliveCordura", (0.15, 0.15, 0.09), 0.9, 0.0, bump=0.6, bump_scale=900, bump_kind="weave")
        self.reticle = pmat("Reticle", (0.9, 0.05, 0.03), 0.4, 0.0, emission=(1.0, 0.06, 0.03), grime=1.0, vary=0.0)
        self.tritium = pmat("Tritium", (0.4, 0.9, 0.3), 0.4, 0.0, emission=(0.35, 1.0, 0.25), grime=1.0, vary=0.0)


# ---- baking --------------------------------------------------------------------------------------------------------

_device = None


def setup_cycles():
    global _device
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    if _device is None:
        _device = "CPU"
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for t in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
                try:
                    prefs.compute_device_type = t
                except TypeError:
                    continue
                prefs.get_devices()
                devs = [d for d in prefs.devices if d.type == t]
                if devs:
                    for d in prefs.devices:
                        d.use = d.type == t
                    _device = "GPU"
                    print("CYCLES device", t, [d.name for d in devs])
                    break
        except Exception as e:  # noqa: BLE001
            print("GPU setup failed", e)
    sc.cycles.device = _device
    return sc


def new_image(name, size, data=False):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color" if data else "sRGB"
    return img


def bake_set(name, objs, size):
    """UV-unwraps `objs` into one atlas and bakes their materials into one texture set; returns the baked material."""
    sc = setup_cycles()
    sc.cycles.samples = 6
    sc.render.bake.margin = 6
    sc.render.bake.use_clear = True
    # One UV space for all objects.
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
        if not o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(58), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    imgs = {
        "col": new_image(f"{name}_col", size),
        "rough": new_image(f"{name}_rough", size, True),
        "metal": new_image(f"{name}_metal", size, True),
        "nrm": new_image(f"{name}_nrm", size, True),
    }
    mats = {m for o in objs for m in o.data.materials if m}
    targets = {}
    for m in mats:
        tn = m.node_tree.nodes.new("ShaderNodeTexImage")
        tn.name = "BAKE"
        targets[m] = tn

    def target(img):
        for m, tn in targets.items():
            tn.image = img
            for n in m.node_tree.nodes:
                n.select = False
            tn.select = True
            m.node_tree.nodes.active = tn

    target(imgs["col"])
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"})
    target(imgs["rough"])
    bpy.ops.object.bake(type="ROUGHNESS")
    target(imgs["nrm"])
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
    # Metalness: emit each material's constant as a grey.
    for m in mats:
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        val = float(m.get("metal", 0.0))
        bsdf.inputs["Emission Color"].default_value = (val, val, val, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 1.0
    sc.cycles.samples = 1
    target(imgs["metal"])
    bpy.ops.object.bake(type="EMIT")
    for img in imgs.values():
        img.pack()
    for m, tn in targets.items():
        m.node_tree.nodes.remove(tn)
        # Restore emission for emissive materials, clear it for the rest.
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Emission Strength"].default_value = 4.0 if m.get("emissive") else 0.0
    baked = baked_material(name, imgs)
    # Swap every non-emissive slot to the baked material; emissive bits (reticles, tritium) keep a plain glow.
    for o in objs:
        for i, slot in enumerate(o.material_slots):
            m = slot.material
            if m and m.get("glass"):
                continue  # clear, tinted optics glass stays its own (blended) material
            if m and m.get("emissive"):
                o.material_slots[i].material = glow_material(m)
            else:
                o.material_slots[i].material = baked
    for o in objs:
        merge_slots(o)
    return baked


def merge_slots(o):
    """Collapses duplicate material slots (after the swap most slots are the same baked material)."""
    me = o.data
    uniq = []
    remap = {}
    for i, m in enumerate(me.materials):
        if m not in uniq:
            uniq.append(m)
        remap[i] = uniq.index(m)
    idx = [remap.get(p.material_index, 0) for p in me.polygons]
    me.materials.clear()
    for m in uniq:
        me.materials.append(m)
    # Clearing the slot list resets every face to slot 0: put the remapped indices back afterwards.
    for p, i in zip(me.polygons, idx):
        p.material_index = i


def baked_material(name, imgs):
    mat = bpy.data.materials.new(f"Gun_{name}")
    mat.use_fake_user = True
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")

    def tex(img):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img
        return t

    nt.links.new(tex(imgs["col"]).outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex(imgs["rough"]).outputs["Color"], bsdf.inputs["Roughness"])
    nt.links.new(tex(imgs["metal"]).outputs["Color"], bsdf.inputs["Metallic"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tex(imgs["nrm"]).outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


_glows = {}


def glow_material(src):
    if src.name in _glows:
        return _glows[src.name]
    mat = bpy.data.materials.new(f"{src.name}Glow")
    mat.use_fake_user = True
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    base = src.get("base", [1, 0, 0])
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    em = src.get("emit", base)
    bsdf.inputs["Emission Color"].default_value = (*em, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 8.0
    bsdf.inputs["Roughness"].default_value = 0.4
    _glows[src.name] = mat
    return mat


# ---- gun kit -------------------------------------------------------------------------------------------------------

def P(*pts):
    return list(pts)


class Gun:
    def __init__(self, gid, size=1024):
        self.id = gid
        self.size = size
        self.parts = []
        self.magp = []
        # Moving sub-parts (slide, bolt, pump) the viewmodel animates: `g.part = "slide"` routes what follows there.
        self.part = None
        self.partp = {}
        self.muzzle = (0, 0.2, 0.07)
        self.sight = (0, 0, 0.09)
        # Long guns are drawn in their own coordinates; `shift` then moves the hand's grip point to the origin.
        self.shift = Vector((0, 0, 0))
        # Optional length warp: (old y, new y) knots, piecewise linear, applied to everything but the magazine in done(),
        # so a long gun can be shortened in its plain stretches while round details keep their shape.
        self.warp = None

    def warp_y(self, y):
        k = self.warp
        if y <= k[0][0]:
            return y + k[0][1] - k[0][0]
        for (a, a2), (b, b2) in zip(k, k[1:]):
            if y <= b:
                return a2 + (y - a) * (b2 - a2) / (b - a)
        return y + k[-1][1] - k[-1][0]

    def apply_warp(self):
        bpy.context.view_layer.update()
        for o in self.parts + [o for ps in self.partp.values() for o in ps]:
            if o.type != "MESH":
                continue
            mw = o.matrix_world.copy()
            inv = mw.inverted()
            for v in o.data.vertices:
                w = mw @ v.co
                w.y = self.warp_y(w.y)
                v.co = inv @ w
        self.muzzle = (self.muzzle[0], self.warp_y(self.muzzle[1]), self.muzzle[2])
        self.sight = (self.sight[0], self.warp_y(self.sight[1]), self.sight[2])

    def add(self, o, mag=False):
        if mag:
            self.magp.append(o)
        elif self.part:
            self.partp.setdefault(self.part, []).append(o)
        else:
            self.parts.append(o)
        return o

    def p(self, pts, w, mat, x=0.0, bev=0.0012, segs=2, mag=False):
        return self.add(prof(pts, w, mat, x, bev, segs), mag)

    def b(self, size, loc, mat, rot=(0, 0, 0), bev=0.0008, mag=False):
        return self.add(box(size, loc, mat, rot, bev), mag)

    def c(self, r, y0, y1, z, mat, x=0.0, verts=20, r2=None, mag=False, bev=0.0006):
        return self.add(cy(r, y0, y1, z, mat, x, verts, r2, bev), mag)

    def cz(self, r, x, y, z0, z1, mat, verts=16, mag=False):
        return self.add(cyl_between((x, y, z0), (x, y, z1), r, mat, verts), mag)

    def cx(self, r, x0, x1, y, z, mat, verts=16):
        return self.add(cyl_between((x0, y, z), (x1, y, z), r, mat, verts))

    def t(self, pts, r, mat, mag=False):
        return self.add(tube(pts, r, mat), mag)

    def ring(self, r, minor, y, z, mat, x=0.0, segs=24):
        return self.add(ring_y(r, minor, y, z, mat, x, segs))

    def s(self, r, loc, mat, scale=(1, 1, 1), mag=False):
        return self.add(sphere(r, loc, mat, scale=scale), mag)

    def done(self):
        if self.warp:
            self.apply_warp()
        for o in self.parts + self.magp + [o for ps in self.partp.values() for o in ps]:
            o.location = o.location + self.shift
        self.muzzle = tuple(Vector(self.muzzle) + self.shift)
        self.sight = tuple(Vector(self.sight) + self.shift)
        root = join(self.parts, self.id)
        mag = join(self.magp, f"{self.id}_mag") if self.magp else None
        subs = [join(ps, f"{self.id}_{name}") for name, ps in self.partp.items()]
        if not NOBAKE:
            bake_set(self.id, [root] + ([mag] if mag else []) + subs, self.size)
        if mag:
            vs = [v.co for v in mag.data.vertices]
            top = max(v.z for v in vs)
            set_origin(mag, (sum(v.x for v in vs) / len(vs), sum(v.y for v in vs) / len(vs), top))
            mag.parent = root
        for sub in subs:
            vs = [v.co for v in sub.data.vertices]
            mid = lambda a: (min(getattr(v, a) for v in vs) + max(getattr(v, a) for v in vs)) / 2
            set_origin(sub, (mid("x"), mid("y"), mid("z")))
            sub.parent = root
        for name, loc in ((f"{self.id}_muzzle", self.muzzle), (f"{self.id}_sight", self.sight)):
            e = link(bpy.data.objects.new(name, None))
            e.empty_display_size = 0.02
            e.location = loc
            e.parent = root
        n = tris(root) + (tris(mag) if mag else 0) + sum(tris(o) for o in subs)
        print(f"GUN {self.id} tris {n} sight_z {self.sight[2]:.3f} sight_y {self.sight[1]:.3f} muzzle_y {self.muzzle[1]:.3f}")
        return root


def grip_pts(d, zt, zb, rake, y0=0.0, bulge=0.003, grooves=0):
    """Pistol-grip silhouette centred on the origin, raked back towards the bottom."""
    tn = math.tan(math.radians(rake))
    pts = []
    n = 6
    for i in range(n + 1):  # front strap, top to bottom
        t = i / n
        z = zt + (zb - zt) * t
        y = y0 + d / 2 + z * tn + math.sin(t * math.pi) * bulge
        if grooves and 0.15 < t < 0.9:
            y -= 0.0025 * abs(math.sin(t * math.pi * grooves))
        pts.append((y, z))
    yb = y0 - d / 2 + zb * tn
    pts += [(yb + d * 0.5, zb - 0.004), (yb + 0.004, zb - 0.002)]
    for i in range(n + 1):  # back strap, bottom to top
        t = 1 - i / n
        z = zt + (zb - zt) * t
        y = y0 - d / 2 + z * tn - math.sin(t * math.pi) * bulge * 1.5
        pts.append((y, z))
    return pts


def grip(g, mat, d=0.046, w=0.028, zt=0.04, zb=-0.07, rake=18, y0=0.0, grooves=0, bev=0.0045):
    return g.p(grip_pts(d, zt, zb, rake, y0, grooves=grooves), w, mat, bev=bev, segs=3)


def guard(g, mat, yb, yf, zt, zb, r=0.0027):
    g.t([(0, yb, zt), (0, yb + 0.003, zb + 0.004), (0, yb + 0.012, zb), (0, yf - 0.01, zb - 0.001), (0, yf, zb + 0.009), (0, yf + 0.003, zt)], r, mat)


def trigger(g, mat, y, z):
    g.p(P((y, z), (y + 0.005, z), (y + 0.0075, z - 0.012), (y + 0.003, z - 0.023), (y, z - 0.021), (y + 0.002, z - 0.011)), 0.006, mat, bev=0.0008)


def rail(g, mat, y0, y1, z, w=0.021, x=0.0, up=True):
    """Picatinny rail with its top at height z (teeth facing up, or down when up is False)."""
    s = 1 if up else -1
    g.b((w, y1 - y0, 0.0045), (x, (y0 + y1) / 2, z - s * 0.0047), mat, bev=0.0006)
    k = y0 + 0.004
    while k < y1 - 0.004:
        g.b((w + 0.0018, 0.0052, 0.0028), (x, k + 0.0026, z - s * 0.0014), mat, bev=0.0)
        k += 0.01


def side_rail(g, mat, y0, y1, z, x, w=0.021):
    sx = 1 if x > 0 else -1
    g.b((0.0045, y1 - y0, w), (x - sx * 0.0047, (y0 + y1) / 2, z), mat, bev=0.0006)
    k = y0 + 0.004
    while k < y1 - 0.004:
        g.b((0.0028, 0.0052, w + 0.0018), (x - sx * 0.0014, k + 0.0026, z), mat, bev=0.0)
        k += 0.01


def barrel(g, M, y0, y1, z, r, mat=None, verts=24):
    g.c(r, y0, y1, z, mat or M.blued, verts=verts)
    g.c(r * 0.52, y1 - 0.002, y1 + 0.0004, z, M.black, verts=16)


def scope(g, M, y0, y1, z, r=0.0127, obj=0.024, oc=0.0195, mount_z=None, mat=None):
    """Rifle scope from the eyepiece at y0 to the objective at y1; returns the eye point."""
    mat = mat or M.blued
    L = y1 - y0
    g.c(r, y0 + 0.07, y1 - 0.09, z, mat, verts=28)
    g.c(r, y1 - 0.09, y1 - 0.045, z, mat, r2=obj, verts=28)
    g.c(obj, y1 - 0.045, y1, z, mat, verts=28)
    g.c(obj * 0.88, y1 - 0.002, y1 + 0.0004, z, M.lens, verts=24)
    g.c(oc, y0, y0 + 0.045, z, M.rubber, verts=28)
    g.c(r * 1.05, y0 + 0.045, y0 + 0.07, z, mat, r2=r, verts=28)
    g.c(oc * 0.8, y0 - 0.0004, y0 + 0.002, z, M.lens, verts=24)
    mid = y0 + 0.07 + (L - 0.16) * 0.45
    g.cz(0.0085, 0, mid, z + r * 0.8, z + r + 0.013, mat, verts=18)
    g.cz(0.009, 0, mid, z + r + 0.011, z + r + 0.017, M.alu, verts=18)
    g.cx(0.0085, r * 0.8, r + 0.013, mid, z, mat, verts=18)
    g.cx(0.009, r + 0.011, r + 0.017, mid, z, M.alu, verts=18)
    for yr in (y0 + 0.09, y1 - 0.11):
        g.ring(r + 0.0015, 0.0028, yr, z, M.blued)
        if mount_z is not None:
            g.b((0.012, 0.016, z - mount_z - r), (0, yr, (z - r + mount_z) / 2), M.blued, bev=0.0012)
    return (0, y0 - 0.004, z)


def reddot(g, M, y, z, base_z):
    """Aimpoint-style tube on a riser mount, bored open with tinted glass front and rear; returns the eye point."""
    hollow(g.c(0.0175, y - 0.035, y + 0.035, z, M.alu, verts=28), 0.0145, y - 0.05, y + 0.05, z)
    hollow(g.c(0.0195, y + 0.028, y + 0.04, z, M.alu, verts=28), 0.0145, y - 0.05, y + 0.05, z)
    hollow(g.c(0.0195, y - 0.04, y - 0.028, z, M.alu, verts=28), 0.0145, y - 0.05, y + 0.05, z)
    glass = mp5_glass()
    g.c(0.0145, y + 0.033, y + 0.034, z, glass, verts=28, bev=0.0)
    g.c(0.0145, y - 0.034, y - 0.033, z, glass, verts=28, bev=0.0)
    g.cz(0.006, 0.0, y + 0.005, z + 0.015, z + 0.023, M.alu)
    g.cx(0.006, 0.015, 0.023, y + 0.005, z, M.alu)
    g.b((0.022, 0.05, z - base_z - 0.012), (0, y, (z - 0.012 + base_z) / 2), M.alu, bev=0.002)
    g.cx(0.0035, -0.016, 0.016, y, base_z + 0.006, M.steel, verts=10)
    g.s(0.0016, (0, y + 0.02, z), M.reticle)
    # The viewmodel holds the eye 6 mm above the sight point; this puts the eye on the optical axis.
    return (0, y - 0.06, z - 0.006)


def holo(g, M, y, base_z):
    """EOTech-style holographic sight; returns the eye point."""
    g.b((0.034, 0.1, 0.018), (0, y, base_z + 0.009), M.alu, bev=0.002)
    wz = base_z + 0.037
    for sx in (-1, 1):
        g.b((0.0045, 0.05, 0.04), (sx * 0.0175, y + 0.018, base_z + 0.034), M.alu, bev=0.0015)
    g.b((0.039, 0.052, 0.0045), (0, y + 0.018, base_z + 0.054), M.alu, bev=0.0015)
    glass = mp5_glass()
    g.b((0.029, 0.0015, 0.032), (0, y + 0.04, wz), glass, bev=0)
    g.b((0.029, 0.0015, 0.032), (0, y - 0.006, wz), glass, bev=0)
    g.add(ring_y(0.0042, 0.00045, y + 0.03, wz, M.reticle, segs=20))
    g.s(0.0007, (0, y + 0.03, wz), M.reticle)
    for k in range(3):
        g.b((0.006, 0.004, 0.006), (-0.008 + k * 0.008, y - 0.048, base_z + 0.012), M.rubber)
    return (0, y - 0.06, wz - 0.006)


def aperture(g, M, y, z, r=0.0045, base=0.012, ears=True, mat=None):
    mat = mat or M.park
    g.ring(r, 0.0018, y, z, mat, segs=20)
    g.b((0.01, 0.006, base), (0, y, z - r - base / 2 + 0.001), mat)
    if ears:
        for sx in (-1, 1):
            g.p(P((y - 0.006, z - r - base + 0.002), (y + 0.006, z - r - base + 0.002), (y + 0.004, z + r + 0.003), (y - 0.004, z + r + 0.003)), 0.003, mat, x=sx * 0.0085, bev=0.0006)
    return (0, y - 0.004, z)


def post(g, M, y, z, h=0.012, ears=True, mat=None):
    """Front sight post (top at z), optionally between protective ears."""
    mat = mat or M.park
    g.b((0.0024, 0.004, h), (0, y, z - h / 2), mat, bev=0.0003)
    if ears:
        for sx in (-1, 1):
            g.p(P((y - 0.007, z - h), (y + 0.007, z - h), (y + 0.005, z + 0.002), (y - 0.005, z + 0.002)), 0.0028, mat, x=sx * 0.0075, bev=0.0006)


def cartridge(g, M, base, tip_dir, length, r, mag=True):
    """A rifle round: brass case, copper-jacketed bullet."""
    base = Vector(base)
    d = Vector(tip_dir).normalized()
    neck = base + d * (length * 0.7)
    g.add(cyl_between(base, neck, r, M.brass, 12), mag)
    g.add(cyl_between(neck, base + d * length, r * 0.74, M.copper, 12, r2=r * 0.25), mag)


def screw(g, M, x, y, z, r=0.0028, mat=None):
    sx = 1 if x >= 0 else -1
    g.add(cyl_between((x - sx * 0.0005, y, z), (x + sx * 0.0008, y, z), r, mat or M.blued, 12))


def serrations(g, mat, y0, n, step, z, h, w):
    for k in range(n):
        g.b((w, step * 0.45, h), (0, y0 + k * step, z), mat, bev=0.0002)


def sling_loop(g, M, y, z, x=0.0):
    g.t([(x, y - 0.012, z), (x, y - 0.008, z - 0.012), (x, y + 0.008, z - 0.012), (x, y + 0.012, z)], 0.0015, M.steel)


def band(g, mat, y, z0, z1, w, t=0.006):
    """A barrel band hugging the stock and barrel (rectangular loop)."""
    hw = w / 2
    g.t([(-hw, y, z0), (hw, y, z0), (hw, y, z1), (-hw, y, z1), (-hw, y, z0 + 0.0001)], 0.0016, mat)
    g.b((w + 0.003, t, 0.003), (0, y, z1), mat, bev=0.0006)


def curved_mag(g, mat, y_front, y_back, z_top, depth, curve, w, ribs=0, rib_mat=None):
    """Curved box magazine (STANAG / AK) as a side silhouette."""
    n = 8
    front, back = [], []
    for i in range(n + 1):
        t = i / n
        dy = curve * t * t
        z = z_top - depth * t
        front.append((y_front + dy, z))
        back.append((y_back + dy * 1.08, z - 0.004 * t))
    g.p(front + back[::-1], w, mat, bev=0.0018, mag=True)
    if ribs:
        for k in range(ribs):
            t = 0.25 + 0.6 * k / max(1, ribs - 1)
            dy = curve * t * t
            z = z_top - depth * t
            for sx in (-1, 1):
                g.b((0.0016, 0.006, 0.012), (sx * (w / 2 + 0.0006), (y_front + y_back) / 2 + dy - 0.004, z), rib_mat or mat, bev=0.0005, mag=True)
    # Floor plate.
    t = 1.0
    dy = curve
    g.b((w + 0.003, abs(y_front - y_back) + 0.008, 0.006), (0, (y_front + y_back) / 2 + dy * 1.04, z_top - depth - 0.002), mat, bev=0.0015, mag=True)


# ---- the guns ------------------------------------------------------------------------------------------------------

def g_m1911(M):
    g = Gun("m1911", 640)
    bz = 0.068
    # Slide: rounded top, rear serrations, ejection port, barrel bushing, both sights.
    g.part = "slide"
    g.p(P((-0.06, 0.051), (0.155, 0.051), (0.157, 0.078), (0.15, 0.084), (-0.052, 0.084), (-0.06, 0.079)), 0.0232, M.blued, bev=0.0016, segs=3)
    serrations(g, M.blued, -0.055, 11, 0.0034, 0.067, 0.022, 0.0245)
    g.b((0.0022, 0.03, 0.011), (0.0112, 0.033, 0.072), M.black, bev=0.0004)
    g.c(0.0109, 0.15, 0.162, bz, M.blued, verts=28)
    g.c(0.0062, 0.153, 0.1625, bz, M.steel, verts=20)
    g.c(0.0048, 0.161, 0.1629, bz, M.black, verts=16)
    g.b((0.0028, 0.007, 0.0065), (0, 0.145, 0.0868), M.blued, bev=0.0004)
    for sx in (-1, 1):
        g.b((0.006, 0.008, 0.007), (sx * 0.0048, -0.046, 0.0872), M.blued, bev=0.0006)
    g.part = None
    # Frame: dust cover with the spring plug, beavertail, grip frame.
    g.p(P((-0.045, 0.037), (0.15, 0.037), (0.15, 0.0515), (-0.045, 0.0515)), 0.021, M.blued)
    g.c(0.0065, 0.148, 0.158, 0.044, M.blued, verts=20)
    g.p(P((-0.078, 0.047), (-0.036, 0.047), (-0.032, 0.035), (-0.055, 0.03), (-0.08, 0.042)), 0.019, M.blued, bev=0.002)
    grip(g, M.blued, d=0.047, w=0.025, zt=0.042, zb=-0.074, rake=16)
    for sx in (-1, 1):
        g.p(grip_pts(0.04, 0.032, -0.066, 16, y0=0.001, bulge=0.002), 0.0045, M.checker, x=sx * 0.0145, bev=0.0016)
        screw(g, M, sx * 0.0172, -0.003, 0.022)
        screw(g, M, sx * 0.0172, -0.017, -0.05)
    # Hammer, thumb safety, slide stop, magazine release.
    g.p(P((-0.067, 0.068), (-0.058, 0.07), (-0.055, 0.088), (-0.061, 0.096), (-0.071, 0.092), (-0.07, 0.08)), 0.0075, M.blued, bev=0.0008)
    g.p(P((-0.04, 0.056), (-0.022, 0.056), (-0.018, 0.064), (-0.04, 0.064)), 0.004, M.blued, x=-0.0137, bev=0.0006)
    g.p(P((-0.005, 0.044), (0.05, 0.047), (0.052, 0.053), (0.0, 0.055)), 0.003, M.blued, x=-0.0122, bev=0.0006)
    g.cx(0.0045, 0.0105, 0.0128, 0.015, 0.03, M.blued, verts=14)
    guard(g, M.blued, 0.004, 0.05, 0.037, 0.01)
    trigger(g, M.steel, 0.022, 0.036)
    # The sights (blade front, notched rear) ride on the slide, above.
    g.sight = (0, -0.05, 0.0885)
    # Magazine: body inside the grip, baseplate below it.
    g.p(grip_pts(0.031, 0.03, -0.074, 16, bulge=0.0), 0.02, M.blued, bev=0.001, mag=True)
    g.p(grip_pts(0.036, -0.074, -0.08, 16, bulge=0.0), 0.023, M.blued, bev=0.0015, mag=True)
    g.muzzle = (0, 0.163, bz)
    return g.done()


def g_glock(M):
    g = Gun("glock", 640)
    bz = 0.064
    g.part = "slide"
    g.p(P((-0.048, 0.049), (0.14, 0.049), (0.142, 0.077), (0.138, 0.08), (-0.044, 0.08), (-0.048, 0.077)), 0.0254, M.park, bev=0.0028, segs=3)
    serrations(g, M.park, -0.044, 8, 0.0042, 0.064, 0.026, 0.0268)
    g.b((0.0022, 0.03, 0.013), (0.0125, 0.02, 0.07), M.black, bev=0.0004)
    g.c(0.0062, 0.139, 0.1428, bz, M.black, verts=16)
    g.b((0.004, 0.007, 0.006), (0, 0.13, 0.0832), M.park, bev=0.0006)
    g.s(0.0012, (0, 0.1265, 0.084), M.tritium)
    for sx in (-1, 1):
        g.b((0.0065, 0.009, 0.0068), (sx * 0.0053, -0.038, 0.0834), M.park, bev=0.0008)
        g.s(0.001, (sx * 0.0053, -0.0425, 0.084), M.tritium)
    g.part = None
    # Polymer frame: dust cover with an accessory rail, grip with finger grooves and stippling.
    g.p(P((-0.04, 0.034), (0.128, 0.034), (0.132, 0.042), (0.132, 0.05), (-0.04, 0.05)), 0.0225, M.poly, bev=0.0018)
    for k in range(3):
        g.b((0.0235, 0.004, 0.004), (0, 0.095 + k * 0.01, 0.0315), M.poly, bev=0.0004)
    g.p(P((-0.07, 0.05), (-0.036, 0.05), (-0.03, 0.036), (-0.06, 0.032), (-0.072, 0.042)), 0.022, M.poly, bev=0.003)
    grip(g, M.stipple, d=0.05, w=0.0285, zt=0.04, zb=-0.072, rake=22, grooves=3)
    guard(g, M.poly, 0.006, 0.058, 0.035, 0.008, r=0.0032)
    trigger(g, M.poly, 0.025, 0.034)
    g.b((0.002, 0.004, 0.006), (0, 0.0265, 0.027), M.black)
    g.b((0.007, 0.006, 0.006), (0.0115, 0.008, 0.03), M.poly, bev=0.001)
    g.b((0.004, 0.012, 0.004), (-0.0122, 0.035, 0.044), M.park, bev=0.0006)
    # The night sights ride on the slide, above.
    g.sight = (0, -0.044, 0.0855)
    g.p(grip_pts(0.033, 0.03, -0.072, 22, bulge=0.0), 0.021, M.park, bev=0.001, mag=True)
    g.p(grip_pts(0.038, -0.072, -0.079, 22, bulge=0.0), 0.026, M.poly, bev=0.0018, mag=True)
    g.muzzle = (0, 0.143, bz)
    return g.done()


def g_thompson(M):
    g = Gun("thompson", 640)
    bz = 0.075
    # Milled receiver, trigger housing, smooth M1A1 barrel.
    g.p(P((-0.13, 0.045), (0.135, 0.045), (0.135, 0.098), (-0.11, 0.101), (-0.13, 0.088)), 0.034, M.park, bev=0.002)
    g.p(P((-0.075, 0.026), (0.06, 0.026), (0.06, 0.046), (-0.075, 0.046)), 0.03, M.park, bev=0.0015)
    g.c(0.016, 0.135, 0.15, bz, M.park, verts=28)
    barrel(g, M, 0.15, 0.405, bz, 0.0115, M.park)
    # Rear L-sight with protective ears, front blade.
    aperture(g, M, -0.09, 0.109, r=0.003, base=0.009)
    g.b((0.0025, 0.006, 0.01), (0, 0.39, 0.091), M.park, bev=0.0003)
    g.sight = (0, -0.094, 0.109)
    # Cocking knob on top-right slot, selector and safety on the left.
    g.b((0.0022, 0.13, 0.006), (0.0171, 0.0, 0.088), M.black, bev=0.0003)
    g.cx(0.0055, 0.017, 0.03, 0.045, 0.088, M.park, verts=16)
    g.s(0.0065, (0.032, 0.045, 0.088), M.park)
    for yy in (-0.03, 0.01):
        g.p(P((yy, 0.05), (yy + 0.016, 0.05), (yy + 0.012, 0.062), (yy + 0.002, 0.062)), 0.003, M.park, x=-0.0182, bev=0.0006)
    # Walnut furniture.
    grip(g, M.walnut, d=0.044, w=0.03, zt=0.03, zb=-0.075, rake=14)
    g.p(P((-0.09, 0.09), (-0.13, 0.088), (-0.43, 0.081), (-0.436, 0.07), (-0.436, -0.062), (-0.4, -0.064), (-0.2, -0.004), (-0.13, 0.02), (-0.09, 0.036)), 0.036, M.walnut, bev=0.005, segs=3)
    g.p(P((-0.436, 0.07), (-0.442, 0.07), (-0.442, -0.062), (-0.436, -0.062)), 0.037, M.park, bev=0.001)
    g.p(P((0.125, 0.042), (0.29, 0.046), (0.296, 0.056), (0.29, 0.066), (0.125, 0.066)), 0.042, M.walnut, bev=0.006, segs=3)
    guard(g, M.park, 0.006, 0.055, 0.027, -0.002)
    trigger(g, M.park, 0.025, 0.027)
    sling_loop(g, M, 0.27, 0.042)
    sling_loop(g, M, -0.35, -0.03)
    # Stick magazine in front of the trigger guard.
    g.b((0.03, 0.04, 0.016), (0, 0.088, 0.034), M.park, bev=0.0015)
    g.p(P((0.07, 0.045), (0.105, 0.045), (0.105, -0.17), (0.071, -0.172)), 0.023, M.park, bev=0.0012, mag=True)
    for sx in (-1, 1):
        g.b((0.0012, 0.004, 0.17), (sx * 0.0118, 0.081, -0.065), M.park, bev=0.0003, mag=True)
        g.b((0.0012, 0.004, 0.17), (sx * 0.0118, 0.094, -0.065), M.park, bev=0.0003, mag=True)
    g.b((0.025, 0.037, 0.005), (0, 0.088, -0.172), M.park, bev=0.001, mag=True)
    g.muzzle = (0, 0.406, bz)
    return g.done()


def g_trench(M):
    g = Gun("trench", 640)
    bz = 0.045
    g.p(P((0.0, 0.0), (0.2, 0.0), (0.2, 0.06), (0.03, 0.063), (0.0, 0.053)), 0.036, M.blued, bev=0.0022)
    g.b((0.022, 0.07, 0.002), (0, 0.1, -0.0006), M.black, bev=0)
    g.b((0.002, 0.065, 0.024), (0.0182, 0.12, 0.034), M.black, bev=0.0003)
    barrel(g, M, 0.2, 0.71, bz, 0.0118)
    g.c(0.0105, 0.2, 0.6, 0.019, M.blued, verts=20)
    g.c(0.0112, 0.6, 0.615, 0.019, M.blued, verts=20)
    g.b((0.012, 0.012, 0.02), (0, 0.6, 0.032), M.blued, bev=0.001)
    # Perforated heat shield.
    g.c(0.0175, 0.25, 0.6, bz, M.park, verts=24)
    for i in range(9):
        for a in (-70, -35, 0, 35, 70):
            ang = math.radians(a)
            y = 0.27 + i * 0.037 + (0.018 if a in (-35, 35) else 0.0)
            if y > 0.59:
                continue
            p0 = Vector((math.sin(ang) * 0.0168, y, bz + math.cos(ang) * 0.0168))
            n = Vector((math.sin(ang), 0, math.cos(ang)))
            g.add(cyl_between(p0, p0 + n * 0.0012, 0.0042, M.black, 10, bev=0))
    g.b((0.008, 0.04, 0.006), (0, 0.68, 0.028), M.blued, bev=0.0008)
    # Corn-cob pump.
    g.part = "pump"
    g.c(0.0195, 0.23, 0.37, 0.019, M.walnut, verts=24)
    for k in range(9):
        g.ring(0.0196, 0.0022, 0.24 + k * 0.015, 0.019, M.walnut, segs=20)
    g.part = None
    # Hammer, trigger guard, trigger.
    g.p(P((-0.004, 0.044), (0.006, 0.044), (0.008, 0.072), (0.0, 0.08), (-0.01, 0.075)), 0.007, M.blued, bev=0.0008)
    guard(g, M.blued, 0.02, 0.075, 0.0, -0.028)
    trigger(g, M.blued, 0.04, -0.002)
    # Walnut stock with a straight wrist and a steel butt plate.
    g.p(P((0.0, 0.052), (-0.38, 0.03), (-0.39, 0.02), (-0.39, -0.115), (-0.36, -0.118), (-0.1, -0.04), (-0.02, -0.03), (0.0, 0.0)), 0.038, M.walnut, bev=0.005, segs=3)
    g.p(P((-0.39, 0.02), (-0.396, 0.02), (-0.396, -0.115), (-0.39, -0.115)), 0.039, M.blued, bev=0.001)
    sling_loop(g, M, -0.3, -0.09)
    # Sights: bead front, groove rear.
    g.s(0.0022, (0, 0.703, 0.059), M.brass)
    g.sight = (0, 0.012, 0.066)
    # Token "magazine": a shell at the loading port.
    g.c(0.0097, 0.055, 0.067, 0.008, M.brass, verts=16, mag=True)
    g.c(0.0093, 0.067, 0.122, 0.008, M.shell, verts=16, mag=True)
    g.shift = Vector((0, 0.05, -0.006))
    g.muzzle = (0, 0.711, bz)
    return g.done()


def g_kar98k(M):
    g = Gun("kar98k", 640)
    bz = 0.034
    g.p(P((0.5, 0.02), (0.5, -0.002), (0.15, -0.016), (0.06, -0.022), (-0.03, -0.035), (-0.07, -0.075), (-0.1, -0.062), (-0.2, -0.054),
          (-0.46, -0.095), (-0.465, -0.09), (-0.465, 0.045), (-0.44, 0.049), (-0.1, 0.031), (-0.06, 0.021), (0.05, 0.02)), 0.04, M.beech, bev=0.005, segs=3)
    g.p(P((-0.465, 0.045), (-0.471, 0.045), (-0.471, -0.09), (-0.465, -0.09)), 0.041, M.blued, bev=0.001)
    g.c(0.017, -0.06, 0.16, bz, M.blued, verts=28)
    g.c(0.0125, 0.16, 0.24, bz, M.blued, verts=24, r2=0.0108)
    barrel(g, M, 0.24, 0.6, bz, 0.0098)
    g.c(0.0105, 0.5, 0.51, bz, M.blued, verts=20)
    post(g, M, 0.59, 0.053, h=0.01, mat=M.blued)
    g.p(P((0.18, 0.045), (0.24, 0.045), (0.24, 0.05), (0.18, 0.056)), 0.018, M.blued, bev=0.0008)
    band(g, M.blued, 0.33, -0.006, 0.047, 0.042)
    band(g, M.blued, 0.44, -0.002, 0.046, 0.04)
    g.b((0.042, 0.03, 0.03), (0, 0.49, 0.018), M.blued, bev=0.002)
    g.c(0.003, 0.36, 0.52, 0.006, M.steel, verts=10)
    # Bolt: body, turned-down handle with a pear knob, safety flag.
    g.part = "bolt"
    g.c(0.0095, -0.075, 0.02, bz + 0.004, M.steel, verts=20)
    g.add(cyl_between((0.006, -0.045, bz + 0.004), (0.046, -0.05, bz - 0.032), 0.0042, M.steel, 14))
    g.s(0.0095, (0.049, -0.051, bz - 0.036), M.steel)
    g.b((0.003, 0.012, 0.014), (0, -0.08, bz + 0.016), M.steel, bev=0.0006)
    g.part = None
    guard(g, M.blued, -0.035, 0.02, -0.03, -0.058)
    trigger(g, M.blued, -0.015, -0.032)
    sling_loop(g, M, -0.33, -0.075, x=-0.021)
    # Scope on turret mounts.
    eye = scope(g, M, -0.08, 0.2, 0.085, r=0.013, obj=0.022, oc=0.019, mount_z=0.05)
    g.sight = eye
    # Token "magazine": a stripper clip of five in the open action.
    g.b((0.004, 0.006, 0.05), (0, -0.018, 0.058), M.steel, bev=0.0004, mag=True)
    for k in range(5):
        cartridge(g, M, (0, -0.015, 0.04 + k * 0.0085), (0, 1, 0), 0.08, 0.0055, mag=True)
    g.shift = Vector((0, 0.065, 0.045))
    g.muzzle = (0, 0.6, bz)
    return g.done()


def g_garand(M):
    g = Gun("garand", 640)
    bz = 0.035
    g.p(P((0.36, 0.02), (0.36, -0.002), (0.14, -0.018), (0.06, -0.026), (-0.02, -0.04), (-0.06, -0.072), (-0.1, -0.06), (-0.2, -0.052),
          (-0.48, -0.1), (-0.485, -0.095), (-0.485, 0.04), (-0.46, 0.044), (-0.1, 0.026), (-0.06, 0.02), (0.05, 0.02)), 0.042, M.walnut, bev=0.005, segs=3)
    g.p(P((-0.485, 0.04), (-0.491, 0.04), (-0.491, -0.095), (-0.485, -0.095)), 0.043, M.park, bev=0.001)
    g.p(P((-0.07, 0.015), (0.15, 0.015), (0.15, 0.055), (0.0, 0.06), (-0.07, 0.05)), 0.03, M.park, bev=0.002)
    aperture(g, M, -0.055, 0.075, r=0.0038, base=0.016)
    for sx in (-1, 1):
        g.cx(0.0075, sx * 0.016, sx * 0.024, -0.055, 0.06, M.park, verts=18)
    g.sight = (0, -0.059, 0.075)
    barrel(g, M, 0.15, 0.62, bz, 0.0115, M.park)
    g.p(P((0.17, 0.04), (0.36, 0.042), (0.365, 0.05), (0.36, 0.058), (0.17, 0.058)), 0.03, M.walnut, bev=0.006, segs=3)
    g.c(0.0175, 0.16, 0.172, bz, M.park, verts=24)
    g.c(0.0135, 0.56, 0.625, bz, M.park, verts=24)
    g.b((0.01, 0.04, 0.012), (0, 0.6, bz + 0.012), M.park, bev=0.001)
    post(g, M, 0.615, bz + 0.033, h=0.012)
    band(g, M.park, 0.36, -0.004, 0.06, 0.042)
    # Operating rod on the right with its handle.
    g.b((0.006, 0.4, 0.008), (0.02, 0.27, 0.024), M.park, bev=0.001)
    g.p(P((0.05, 0.02), (0.075, 0.02), (0.07, 0.045), (0.05, 0.045)), 0.008, M.park, x=0.022, bev=0.0012)
    g.b((0.024, 0.012, 0.004), (0, 0.035, 0.058), M.steel, bev=0.0004)
    guard(g, M.park, -0.035, 0.02, -0.03, -0.058)
    trigger(g, M.park, -0.015, -0.032)
    sling_loop(g, M, -0.33, -0.08)
    sling_loop(g, M, 0.34, -0.004)
    # Token "magazine": the en bloc clip with eight rounds, visible in the open receiver.
    for sx in (-1, 1):
        g.b((0.0012, 0.05, 0.022), (sx * 0.0085, 0.02, 0.05), M.park, bev=0.0003, mag=True)
    for k in range(8):
        x = (k % 2 - 0.5) * 0.008
        cartridge(g, M, (x, -0.005, 0.034 + (k // 2) * 0.0075), (0, 1, 0), 0.075, 0.0052, mag=True)
    g.shift = Vector((0, 0.065, 0.045))
    g.muzzle = (0, 0.626, bz)
    return g.done()


def sweep_y(sec, y0, y1, mat, bev=0.0012, segs=2, angle=35):
    """Cross-section (x, z points around) extruded along +Y from y0 to y1 (receivers, rails, housings)."""
    bm = bmesh.new()
    vs = [bm.verts.new((x, y0, z)) for (x, z) in sec]
    f = bm.faces.new(vs)
    res = bmesh.ops.extrude_face_region(bm, geom=[f])
    moved = [e for e in res["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, y1 - y0, 0), verts=moved)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = mesh_obj("sweep", bm, mat)
    return hard_surface(obj, bev, segs, angle)


def rrect(w, h, r, cx=0.0, cz=0.0, n=4):
    """Rounded rectangle (x, z) points, counter-clockwise."""
    pts = []
    for (sx, sz, a0) in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        ccx, ccz = cx + sx * (w / 2 - r), cz + sz * (h / 2 - r)
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((ccx + math.cos(a) * r, ccz + math.sin(a) * r))
    return pts


def stamp_text(text, size, loc, side, mat, depth=0.00035):
    """Raised stamped lettering on a receiver side (side -1: left, read with the muzzle on the viewer's left)."""
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body = text
    cu.size = size
    cu.extrude = depth
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.resolution_u = 3
    o = link(bpy.data.objects.new("txt", cu))
    o.data.materials.append(mat)
    # Text x -> along the gun (towards the rear on the left side), text y -> up, text normal -> out of the side.
    if side < 0:
        m = Matrix(((0, 0, -1), (-1, 0, 0), (0, 1, 0))).to_4x4()
    else:
        m = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0))).to_4x4()
    o.matrix_world = Matrix.Translation(loc) @ m
    o = to_mesh(o)
    smooth_all(o)
    return o


def hollow(o, r, y0, y1, z):
    """Bores a hole along +Y through `o` (optic housings)."""
    cut = cyl_between((0, y0, z), (0, y1, z), r, o.data.materials[0], 32, bev=0.0)
    for m in list(cut.modifiers):
        cut.modifiers.remove(m)
    b = o.modifiers.new("Bore", "BOOLEAN")
    b.operation = "DIFFERENCE"
    b.solver = "EXACT"
    b.object = cut
    o = to_mesh(o)
    bpy.data.objects.remove(cut, do_unlink=True)
    return o


def hollow_x(o, r, x, y, z):
    """Drills a hole across x through `o` at (y, z) (lightening holes in sight ears)."""
    cut = cyl_between((x - 0.01, y, z), (x + 0.01, y, z), r, o.data.materials[0], 16, bev=0.0)
    for m in list(cut.modifiers):
        cut.modifiers.remove(m)
    b = o.modifiers.new("Hole", "BOOLEAN")
    b.operation = "DIFFERENCE"
    b.solver = "EXACT"
    b.object = cut
    o = to_mesh(o)
    bpy.data.objects.remove(cut, do_unlink=True)
    return o


def mp5_glass():
    mat = bpy.data.materials.get("SightGlass")
    if mat:
        return mat
    mat = bpy.data.materials.new("SightGlass")
    mat.use_nodes = True
    mat["glass"] = True
    mat["metal"] = 0.0
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.55, 0.45, 0.32, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.04
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Alpha"].default_value = 0.16
    try:
        mat.surface_render_method = "BLENDED"
    except AttributeError:
        mat.blend_method = "BLEND"
    return mat


def mp5_optic(g, M, body, y, base_z):
    """Boxy micro red dot (T2 style) on a Picatinny clamp: square-shouldered housing, lens tubes front and rear,
    turrets, a cross-bolt; tinted glass with the dot inside. Returns the eye point."""
    oz = base_z + 0.024  # optical axis
    L = 0.05
    # Clamp base on the rail, cross bolt and recoil lug.
    g.add(sweep_y(rrect(0.03, 0.009, 0.0015, 0, base_z + 0.0045), y - 0.024, y + 0.024, body, bev=0.0008))
    for sx in (-1, 1):
        g.add(sweep_y(P((sx * 0.0135, base_z + 0.008), (sx * 0.0175, base_z + 0.002), (sx * 0.0175, base_z - 0.004), (sx * 0.0135, base_z - 0.004)), y - 0.02, y + 0.02, body, bev=0.0005))
    g.cx(0.0034, -0.019, 0.019, y + 0.006, base_z + 0.002, M.steel, verts=12)
    g.cx(0.0048, 0.017, 0.021, y + 0.006, base_z + 0.002, body, verts=6)
    # Riser between clamp and housing.
    g.add(sweep_y(rrect(0.022, 0.012, 0.002, 0, base_z + 0.013), y - 0.02, y + 0.018, body, bev=0.001))
    # Housing: a squared body with big chamfers, square-shouldered lens frames front and rear (open, so the scene
    # shows through the glass), a short sunshade over the front.
    hollow(g.add(sweep_y(rrect(0.031, 0.031, 0.007, 0, oz, n=3), y - L / 2 + 0.006, y + L / 2 - 0.004, body, bev=0.0012)), 0.0128, y - L, y + L, oz)
    hollow(g.add(sweep_y(rrect(0.036, 0.036, 0.0085, 0, oz + 0.001, n=4), y + L / 2 - 0.008, y + L / 2 + 0.01, body, bev=0.0015)), 0.0142, y - L, y + L, oz)
    hollow(g.add(sweep_y(rrect(0.036, 0.036, 0.0085, 0, oz + 0.001, n=4), y - L / 2 - 0.006, y - L / 2 + 0.008, body, bev=0.0015)), 0.0142, y - L, y + L, oz)
    g.ring(0.0142, 0.0012, y - L / 2 - 0.006, oz, body, segs=32)
    g.ring(0.0142, 0.0012, y + L / 2 + 0.01, oz, body, segs=32)
    # Turrets: elevation on top, windage on the right, the battery/brightness knob on the left.
    g.cz(0.0075, 0, y + 0.002, oz + 0.013, oz + 0.022, body, verts=20)
    g.cz(0.0062, 0, y + 0.002, oz + 0.021, oz + 0.0235, body, verts=20)
    g.cx(0.0075, 0.012, 0.022, y + 0.002, oz, body, verts=20)
    g.cx(0.0062, 0.021, 0.0235, y + 0.002, oz, body, verts=20)
    g.cx(0.0085, -0.023, -0.012, y - 0.004, oz - 0.002, body, verts=24)
    for k in range(10):  # grip ribs on the knob
        a = k / 10 * math.tau
        g.b((0.009, 0.0016, 0.0016), (-0.0175, y - 0.004 + math.cos(a) * 0.0086, oz - 0.002 + math.sin(a) * 0.0086), body, rot=(a, 0, 0), bev=0.0002)
    # Glass (front and rear, tinted, see-through) and the dot.
    glass = mp5_glass()
    g.c(0.0142, y + L / 2 + 0.0035, y + L / 2 + 0.0045, oz, glass, verts=28, bev=0.0)
    g.c(0.0142, y - L / 2 + 0.002, y - L / 2 + 0.003, oz, glass, verts=28, bev=0.0)
    g.s(0.0011, (0, y + 0.01, oz), M.reticle)
    return (0, y - L / 2 - 0.03, oz)


def g_mp7(M):
    """MP5SD (the `mp7` id): stamped receiver, integral suppressor with the slim SD handguard, cocking tube, boxy red
    dot on a rail, Navy trigger group, curved 30-round magazine, collapsed A3 stock; worn black finish."""
    g = Gun("mp7", 2048)
    finish = pmat("MP5Black", (0.055, 0.054, 0.054), 0.4, 0.5, wear=(0.46, 0.44, 0.4), wear_rough=0.2, bump=0.35, bump_scale=1700, grime=0.45, vary=0.35, scratches=0.4, rough_var=0.4)
    coat = pmat("MP5Coat", (0.028, 0.028, 0.029), 0.7, 0.25, wear=(0.2, 0.2, 0.2), wear_rough=0.4, bump=0.9, bump_scale=650, bump_kind="voronoi", grime=0.55, vary=0.35)
    poly = pmat("MP5Polymer", (0.02, 0.02, 0.021), 0.6, 0.0, wear=(0.09, 0.09, 0.095), wear_rough=0.4, bump=0.2, bump_scale=2400, vary=0.2)
    stip = pmat("MP5Stipple", (0.018, 0.018, 0.019), 0.78, 0.0, wear=(0.075, 0.075, 0.08), bump=0.85, bump_scale=1100, bump_kind="voronoi")
    hgm = pmat("MP5Handguard", (0.021, 0.021, 0.022), 0.74, 0.0, wear=(0.09, 0.09, 0.095), wear_rough=0.5, bump=0.6, bump_scale=900, bump_kind="voronoi", vary=0.25)
    red = pmat("MP5Red", (0.55, 0.035, 0.03), 0.55, 0.0, grime=0.8, vary=0.1)
    white = pmat("MP5White", (0.7, 0.68, 0.62), 0.55, 0.0, grime=0.8, vary=0.1)
    optic = pmat("OpticAlu", (0.03, 0.03, 0.032), 0.45, 0.5, wear=(0.5, 0.5, 0.52), wear_rough=0.25, bump=0.12, bump_scale=1800)
    bz = 0.085  # bore / suppressor axis
    ry0, ry1 = -0.178, 0.112  # receiver ends
    # Stamped receiver: square-sided tube with a round top, rear end cap.
    rec = [(0.0215, 0.046)] + [(math.cos(math.radians(a)) * 0.0215, 0.091 + math.sin(math.radians(a)) * 0.0215) for a in range(0, 181, 15)] + [(-0.0215, 0.046)]
    g.add(sweep_y(rec, ry0, ry1, finish, bev=0.0016, segs=3))
    g.add(sweep_y(rrect(0.046, 0.074, 0.008, 0, 0.081), ry0 - 0.008, ry0 + 0.002, finish, bev=0.0015))
    for sx in (-1, 1):
        x = sx * 0.0222
        # Pressed stiffening ribs along the sides, the stock rail groove up top, spot welds at the front.
        g.b((0.0018, ry1 - ry0 - 0.03, 0.0042), (x, (ry0 + ry1) / 2 - 0.005, 0.098), finish, bev=0.0008)
        g.b((0.0016, 0.13, 0.0034), (x, -0.075, 0.064), finish, bev=0.0007)
        g.b((0.0014, 0.075, 0.012), (x, 0.065, 0.06), finish, bev=0.0012)
        for k in range(4):
            g.cx(0.0017, x - sx * 0.0004, x + sx * 0.001, 0.02 + k * 0.022, 0.081, finish, verts=10)
        # Trigger-housing push pins and the front pin.
        for (py, pz) in ((-0.162, 0.058), (-0.04, 0.052), (0.09, 0.052)):
            g.cx(0.0034, x - sx * 0.0005, x + sx * 0.0016, py, pz, M.steel, verts=14)
            g.cx(0.0019, x + sx * 0.0012, x + sx * 0.0021, py, pz, M.black, verts=10)
    # Stamped markings: model and serial line on the left (camera side), on the right for the third-person view.
    letter = pmat("MP5Letter", (0.3, 0.29, 0.27), 0.4, 0.8, grime=0.7, vary=0.2)
    g.add(stamp_text("MP5", 0.014, Vector((-0.0229, 0.068, 0.061)), -1, letter))
    g.add(stamp_text("S  E  F", 0.0058, Vector((-0.0182, -0.004, 0.037)), -1, red, depth=0.0002))
    g.add(stamp_text("Kal. 9mm x19  SD3", 0.0042, Vector((-0.0217, -0.04, 0.084)), -1, finish, depth=0.0002))
    g.add(stamp_text("MP5 SD3", 0.008, Vector((0.0217, 0.03, 0.084)), 1, finish))
    # Cocking tube over the suppressor, tied in at the receiver; slot for the handle; front sight base and hooded post.
    tz = bz + 0.031
    g.c(0.0105, ry1 - 0.01, 0.335, tz, finish, verts=24)
    g.c(0.0112, ry1 - 0.012, ry1 + 0.012, tz, finish, verts=24)
    g.b((0.0024, 0.15, 0.003), (-0.0098, 0.24, tz + 0.001), M.black, bev=0.0002)
    g.add(sweep_y(P((-0.0105, tz), (0.0105, tz), (0.012, bz + 0.01), (-0.012, bz + 0.01)), ry1 - 0.004, ry1 + 0.04, finish, bev=0.002))
    g.add(sweep_y(P((-0.012, tz + 0.004), (0.012, tz + 0.004), (0.016, bz + 0.012), (0.016, bz - 0.004), (-0.016, bz - 0.004), (-0.016, bz + 0.012)), 0.3, 0.338, finish, bev=0.002))
    g.c(0.0285, 0.302, 0.336, bz, finish, verts=36)
    fz = tz + 0.026
    g.ring(0.0108, 0.0022, 0.322, fz - 0.002, finish, segs=24)
    g.p(P((0.31, tz + 0.006), (0.334, tz + 0.006), (0.33, fz - 0.008), (0.314, fz - 0.008)), 0.014, finish, bev=0.002)
    post(g, M, 0.322, fz - 0.003, h=0.012, ears=False, mat=finish)
    # Rear drum sight with protective ears.
    dy, dz = -0.152, 0.124
    g.cx(0.0105, -0.0105, 0.0105, dy, dz, finish, verts=28)
    for k in range(18):  # knurled drum rim
        a = k / 18 * math.tau
        g.b((0.0024, 0.0016, 0.0016), (-0.0095, dy + math.cos(a) * 0.0104, dz + math.sin(a) * 0.0104), finish, rot=(a, 0, 0), bev=0.0002)
    for k in range(4):  # the four apertures, the one in use on top
        a = k * math.pi / 2 + math.pi / 2
        g.cx(0.0019, -0.0108, -0.0085, dy + math.cos(a) * 0.0062, dz + math.sin(a) * 0.0062, M.black, verts=10)
    g.c(0.0022, dy - 0.009, dy + 0.009, dz + 0.0105, M.black, verts=12)
    g.add(sweep_y(rrect(0.028, 0.012, 0.003, 0, 0.113), dy - 0.016, dy + 0.016, finish, bev=0.0012))
    g.cx(0.0028, -0.0155, 0.0155, dy + 0.009, 0.111, M.steel, verts=10)
    # Protective ears: chamfered plates either side of the drum with a lightening hole, joined low at the front.
    for sx in (-1, 1):
        ear = g.p(P((dy - 0.017, 0.108), (dy + 0.017, 0.108), (dy + 0.013, 0.131), (dy + 0.006, 0.137), (dy - 0.008, 0.137), (dy - 0.015, 0.128)), 0.0034, finish, x=sx * 0.0128, bev=0.0009)
        hollow_x(ear, 0.0032, sx * 0.0128, dy + 0.004, 0.118)
    g.b((0.029, 0.006, 0.006), (0, dy + 0.014, 0.112), finish, bev=0.0012)
    # Claw mount / Picatinny rail on the rear of the receiver top, right in front of the drum, clamp knobs on the right;
    # the red dot sits on its rear half, close over the drum like on a fielded SD3.
    rz = 0.127
    r0, r1 = -0.131, -0.016
    g.add(sweep_y(P((-0.0125, 0.108), (0.0125, 0.108), (0.0125, rz - 0.006), (-0.0125, rz - 0.006)), r0, r1, finish, bev=0.0012))
    for yy in (r0 + 0.014, r1 - 0.012):
        g.b((0.05, 0.016, 0.009), (0, yy, 0.108), finish, bev=0.0015)
        g.cx(0.0055, 0.024, 0.031, yy, 0.108, finish, verts=18)
    rail(g, finish, r0, r1, rz)
    for k in range(11):  # rail slot numbers as small white ticks
        g.b((0.0011, 0.0012, 0.0006), (-0.0108, r0 + 0.006 + k * 0.01, rz - 0.0012), white, bev=0.0)
    g.sight = mp5_optic(g, M, optic, -0.08, rz)
    # Cocking handle (left, folded forward at the front of the tube): the part that racks.
    g.part = "bolt"
    g.add(cyl_between((-0.009, 0.292, tz + 0.002), (-0.026, 0.286, tz + 0.008), 0.0034, finish, 12))
    g.b((0.01, 0.022, 0.011), (-0.03, 0.29, tz + 0.009), poly, rot=(0, math.radians(-10), 0), bev=0.0025)
    g.part = None
    # Integral suppressor: textured coating, front cap with a chamfer and the bore.
    g.c(0.0262, 0.13, 0.535, bz, coat, verts=40)
    g.c(0.0266, 0.53, 0.548, bz, finish, r2=0.0245, verts=40, bev=0.001)
    g.c(0.0078, 0.546, 0.5486, bz, M.black, verts=16)
    for yy in (0.338, 0.5):
        g.ring(0.0264, 0.0011, yy, bz, finish, segs=40)
    # Slim SD handguard over the rear of the suppressor: tapered polymer sleeve with grip ribs underneath.
    g.c(0.0335, 0.118, 0.13, bz, poly, r2=0.0332, verts=40)
    g.c(0.0332, 0.13, 0.29, bz, hgm, r2=0.0315, verts=40)
    g.c(0.0315, 0.29, 0.3, bz, poly, r2=0.0302, verts=40)
    for k in range(9):
        a = math.radians(-90 + (k - 4) * 14)
        g.add(cyl_between((math.cos(a) * 0.0326, 0.155, bz + math.sin(a) * 0.0326), (math.cos(a) * 0.031, 0.272, bz + math.sin(a) * 0.031), 0.0016, poly, 8))
    # Lower: polymer Navy trigger group, ribbed grip, wide guard, ambidextrous selector with painted pictograms.
    g.p(P((-0.165, 0.047), (0.062, 0.047), (0.062, 0.03), (0.04, 0.022), (-0.045, 0.02), (-0.075, 0.03), (-0.12, 0.04), (-0.165, 0.044)), 0.036, poly, bev=0.003, segs=3)
    grip(g, stip, d=0.046, w=0.032, zt=0.03, zb=-0.082, rake=20, grooves=3)
    guard(g, poly, 0.008, 0.066, 0.026, -0.003, r=0.0042)
    trigger(g, M.steel, 0.032, 0.026)
    for sx in (-1, 1):
        x = sx * 0.0186
        g.cx(0.006, x, x + sx * 0.003, -0.034, 0.037, poly, verts=16)
        g.p(P((-0.036, 0.034), (-0.018, 0.04), (-0.016, 0.046), (-0.034, 0.043)), 0.0028, poly, x=x + sx * 0.003, bev=0.0006)
        for k, mat in enumerate((white, red, red, red)):
            a = math.radians(140 - k * 30)
            g.cx(0.0024, x, x + sx * 0.0006, -0.034 + math.cos(a) * 0.011, 0.037 + math.sin(a) * 0.011, mat, verts=10)
        g.b((0.0006, 0.007, 0.0024), (x + sx * 0.0004, -0.05, 0.03), red, bev=0.0)
    # Magazine well, paddle release and the curved 30-round magazine with witness holes.
    g.add(sweep_y(rrect(0.031, 0.03, 0.003, 0, 0.034), 0.066, 0.118, finish, bev=0.0012))
    g.p(P((0.058, 0.022), (0.068, 0.022), (0.066, 0.006), (0.054, 0.004)), 0.016, poly, bev=0.0015)
    g.cx(0.0045, 0.0145, 0.0185, 0.108, 0.03, M.steel, verts=14)
    curved_mag(g, finish, 0.113, 0.077, 0.03, 0.195, 0.065, 0.0235, ribs=0)
    for k in range(4):
        t = 0.3 + k * 0.17
        z = 0.03 - 0.195 * t
        yy = 0.095 + 0.065 * t * t
        for sx in (-1, 1):
            g.add(cyl_between((sx * 0.0112, yy, z), (sx * 0.0124, yy, z), 0.0026, M.black, 10), mag=True)
        g.add(cyl_between((-0.0124, yy, z), (-0.0126, yy, z), 0.0015, white, 8), mag=True)
    # A3 stock, collapsed: struts along the receiver sides, a curved butt plate with a rubber pad, the latch.
    for sx in (-1, 1):
        x = sx * 0.0245
        g.add(cyl_between((x, -0.236, 0.1), (x, -0.05, 0.1), 0.0042, finish, 14))
        g.add(cyl_between((x, -0.236, 0.055), (x, -0.13, 0.055), 0.0042, finish, 14))
        g.cx(0.0048, x - sx * 0.002, x + sx * 0.002, -0.05, 0.1, finish, verts=14)
    g.p(P((-0.226, 0.118), (-0.238, 0.122), (-0.248, 0.112), (-0.25, 0.05), (-0.246, -0.015), (-0.238, -0.03), (-0.226, -0.028), (-0.232, 0.04)), 0.054, finish, bev=0.004, segs=3)
    g.p(P((-0.248, 0.112), (-0.258, 0.11), (-0.262, 0.04), (-0.258, -0.026), (-0.246, -0.015), (-0.25, 0.05)), 0.05, M.rubber, bev=0.004, segs=3)
    g.b((0.016, 0.02, 0.012), (0, -0.205, 0.128), finish, bev=0.003)
    sling_loop(g, M, -0.19, 0.046, x=0.0)
    for sx in (-1, 1):
        g.t([(sx * 0.024, 0.32, bz - 0.004), (sx * 0.034, 0.318, bz - 0.006), (sx * 0.034, 0.306, bz - 0.006), (sx * 0.024, 0.305, bz - 0.004)], 0.0016, M.steel)
    g.muzzle = (0, 0.549, bz)
    # Real SD3 proportions: modelled long up front, so shorten the handguard and the suppressor (sight radius ~0.41 m,
    # receiver end to muzzle ~0.6 m); the receiver, front sight block and the magazine keep their scale.
    g.warp = [(0.118, 0.118), (0.3, 0.235), (0.338, 0.273), (0.549, 0.42)]
    return g.done()


def g_m4a1(M):
    g = Gun("m4a1", 640)
    bz = 0.085
    g.p(P((-0.085, 0.03), (0.105, 0.03), (0.105, 0.066), (-0.085, 0.066)), 0.03, M.alu, bev=0.0018)
    g.p(P((0.045, -0.01), (0.105, -0.01), (0.11, 0.03), (0.04, 0.03)), 0.032, M.alu, bev=0.002)
    grip(g, M.stipple, d=0.04, w=0.029, zt=0.032, zb=-0.07, rake=22)
    guard(g, M.alu, 0.012, 0.072, 0.03, 0.006)
    trigger(g, M.steel, 0.032, 0.03)
    g.p(P((-0.03, 0.05), (-0.01, 0.05), (-0.012, 0.058), (-0.028, 0.06)), 0.003, M.alu, x=-0.0163, bev=0.0006)
    g.cx(0.0035, 0.015, 0.018, 0.055, 0.045, M.alu)
    # Upper receiver: flat top, forward assist, ejection port, charging handle.
    g.p(P((-0.09, 0.066), (0.125, 0.066), (0.125, 0.102), (-0.09, 0.102)), 0.032, M.alu, bev=0.0018)
    rail(g, M.alu, -0.085, 0.122, 0.11)
    g.b((0.0022, 0.05, 0.016), (0.0165, 0.015, 0.082), M.black, bev=0.0003)
    g.b((0.0014, 0.05, 0.017), (0.0172, 0.04, 0.073), M.alu, bev=0.0003)
    g.add(cyl_between((0.012, -0.055, 0.09), (0.026, -0.047, 0.084), 0.0055, M.alu, 16))
    g.p(P((-0.105, 0.095), (-0.09, 0.095), (-0.09, 0.101), (-0.105, 0.101)), 0.03, M.alu, bev=0.0008)
    # Buffer tube and the collapsible stock.
    g.c(0.0165, -0.29, -0.09, 0.08, M.alu, verts=24)
    g.c(0.0185, -0.1, -0.09, 0.08, M.alu, verts=10)
    g.p(P((-0.305, 0.104), (-0.205, 0.104), (-0.17, 0.095), (-0.17, 0.062), (-0.25, 0.0), (-0.305, -0.04)), 0.04, M.poly, bev=0.003, segs=3)
    g.p(P((-0.305, 0.104), (-0.318, 0.104), (-0.318, -0.04), (-0.305, -0.04)), 0.042, M.rubber, bev=0.003)
    # Quad rail handguard, A-frame front sight, barrel, birdcage.
    g.b((0.044, 0.25, 0.042), (0, 0.25, bz), M.alu, bev=0.004)
    rail(g, M.alu, 0.125, 0.37, 0.11)
    for sx in (-1, 1):
        side_rail(g, M.alu, 0.14, 0.365, bz, sx * 0.027)
    rail(g, M.alu, 0.14, 0.365, bz - 0.026, up=False)
    barrel(g, M, 0.375, 0.52, bz, 0.0095, M.park)
    g.p(P((0.38, 0.075), (0.41, 0.075), (0.402, 0.134), (0.392, 0.134)), 0.018, M.park, bev=0.0012)
    post(g, M, 0.397, 0.139, h=0.008, mat=M.park)
    g.c(0.0112, 0.52, 0.566, bz, M.park, verts=20)
    for a in (0, 90, 180, 270):
        ang = math.radians(a)
        g.b((0.0026 if a in (0, 180) else 0.0024, 0.03, 0.0026 if a in (90, 270) else 0.0024), (math.sin(ang) * 0.0104, 0.548, bz + math.cos(ang) * 0.0104), M.black, bev=0)
    sling_loop(g, M, -0.27, 0.06)
    # Holographic sight, flip-up rear behind it.
    eye = holo(g, M, -0.005, 0.11)
    aperture(g, M, -0.07, 0.124, r=0.0028, base=0.012, ears=False, mat=M.alu)
    g.sight = eye
    curved_mag(g, M.alu, 0.103, 0.05, 0.03, 0.2, 0.034, 0.022, ribs=4)
    g.muzzle = (0, 0.567, bz)
    return g.done()


def g_ak12(M):
    g = Gun("ak12", 640)
    bz = 0.075
    g.p(P((-0.11, 0.028), (0.17, 0.028), (0.17, 0.096), (-0.11, 0.096), (-0.12, 0.086), (-0.12, 0.04)), 0.036, M.park, bev=0.0018)
    for (yy, zz) in ((-0.09, 0.04), (0.15, 0.04), (0.15, 0.085), (-0.06, 0.05)):
        for sx in (-1, 1):
            g.add(cyl_between((sx * 0.0178, yy, zz), (sx * 0.0186, yy, zz), 0.0022, M.park, 10, bev=0))
    rail(g, M.park, -0.105, 0.165, 0.106)
    g.b((0.036, 0.27, 0.006), (0, 0.03, 0.098), M.park, bev=0.0015)
    g.p(P((-0.06, 0.068), (0.105, 0.068), (0.105, 0.078), (-0.05, 0.082)), 0.003, M.park, x=0.0195, bev=0.0006)
    g.b((0.0022, 0.07, 0.006), (0.0182, 0.08, 0.088), M.black, bev=0.0002)
    g.cx(0.004, 0.018, 0.034, 0.12, 0.088, M.steel)
    g.s(0.006, (0.036, 0.12, 0.088), M.steel)
    # Gas tube, polymer handguard with rails, barrel and muzzle device.
    g.c(0.0105, 0.17, 0.39, 0.1, M.park, verts=20)
    g.p(P((0.17, 0.042), (0.38, 0.046), (0.385, 0.08), (0.38, 0.114), (0.17, 0.118)), 0.052, M.poly, bev=0.004, segs=3)
    rail(g, M.poly, 0.18, 0.375, 0.124)
    for sx in (-1, 1):
        side_rail(g, M.poly, 0.28, 0.37, 0.078, sx * 0.0285, w=0.018)
    barrel(g, M, 0.38, 0.535, bz, 0.0095, M.park)
    g.b((0.022, 0.03, 0.04), (0, 0.4, 0.088), M.park, bev=0.002)
    post(g, M, 0.4, 0.138, h=0.024, mat=M.park)
    g.c(0.0135, 0.53, 0.6, bz, M.park, verts=24)
    for k in range(3):
        for sx in (-1, 1):
            g.b((0.0026, 0.012, 0.004), (sx * 0.0128, 0.545 + k * 0.017, bz), M.black, bev=0)
    g.c(0.0062, 0.5992, 0.601, bz, M.black, verts=16)
    grip(g, M.stipple, d=0.043, w=0.03, zt=0.028, zb=-0.075, rake=20)
    guard(g, M.park, 0.018, 0.075, 0.028, 0.004)
    trigger(g, M.steel, 0.04, 0.027)
    # Folding telescoping stock.
    g.p(P((-0.12, 0.094), (-0.18, 0.1), (-0.34, 0.106), (-0.356, 0.092), (-0.356, -0.035), (-0.33, -0.042), (-0.2, 0.034), (-0.12, 0.042)), 0.04, M.poly, bev=0.003, segs=3)
    g.b((0.032, 0.11, 0.012), (0, -0.27, 0.113), M.poly, bev=0.003)
    g.p(P((-0.356, 0.106), (-0.37, 0.106), (-0.37, -0.035), (-0.356, -0.035)), 0.042, M.rubber, bev=0.003)
    eye = reddot(g, M, 0.02, 0.141, 0.106)
    g.sight = eye
    curved_mag(g, M.poly, 0.12, 0.068, 0.03, 0.22, 0.075, 0.026, ribs=5)
    g.muzzle = (0, 0.601, bz)
    return g.done()


def g_benelli(M):
    g = Gun("benelli", 640)
    bz = 0.078
    g.p(P((-0.1, 0.035), (0.16, 0.035), (0.16, 0.1), (-0.08, 0.1), (-0.1, 0.09)), 0.036, M.alu, bev=0.002)
    g.b((0.024, 0.07, 0.002), (0, 0.07, 0.0345), M.black, bev=0)
    g.b((0.0022, 0.07, 0.022), (0.0182, 0.06, 0.07), M.black, bev=0.0003)
    g.add(cyl_between((0.018, 0.09, 0.07), (0.036, 0.092, 0.07), 0.004, M.steel, 14))
    g.cx(0.0075, 0.034, 0.044, 0.092, 0.07, M.steel, verts=18)
    rail(g, M.alu, -0.06, 0.13, 0.108)
    eye = aperture(g, M, -0.045, 0.124, r=0.0055, base=0.012, mat=M.alu)
    g.sight = eye
    barrel(g, M, 0.16, 0.66, bz, 0.0115)
    g.c(0.0125, 0.16, 0.55, 0.05, M.alu, verts=22)
    g.c(0.0135, 0.55, 0.57, 0.05, M.alu, verts=22)
    g.b((0.02, 0.02, 0.04), (0, 0.53, 0.064), M.alu, bev=0.002)
    g.p(P((0.17, 0.028), (0.43, 0.03), (0.435, 0.05), (0.43, 0.074), (0.17, 0.076)), 0.046, M.poly, bev=0.005, segs=3)
    for k in range(6):
        for sx in (-1, 1):
            g.b((0.0012, 0.008, 0.032), (sx * 0.0232, 0.26 + k * 0.022, 0.052), M.black, bev=0.0002)
    g.b((0.006, 0.03, 0.01), (0, 0.635, 0.093), M.alu, bev=0.001)
    post(g, M, 0.64, 0.104, h=0.01, mat=M.alu)
    grip(g, M.stipple, d=0.042, w=0.03, zt=0.035, zb=-0.07, rake=20)
    guard(g, M.alu, 0.016, 0.075, 0.035, 0.008)
    trigger(g, M.steel, 0.036, 0.034)
    g.p(P((-0.1, 0.09), (-0.2, 0.1), (-0.38, 0.1), (-0.39, 0.085), (-0.39, -0.04), (-0.36, -0.046), (-0.22, 0.03), (-0.1, 0.04)), 0.04, M.poly, bev=0.003, segs=3)
    g.b((0.034, 0.12, 0.016), (0, -0.28, 0.108), M.poly, bev=0.004)
    g.p(P((-0.39, 0.1), (-0.405, 0.1), (-0.405, -0.04), (-0.39, -0.04)), 0.042, M.rubber, bev=0.003)
    # Token "magazine": a shell at the loading port.
    g.c(0.0097, 0.03, 0.042, 0.03, M.brass, verts=16, mag=True)
    g.c(0.0093, 0.042, 0.097, 0.03, M.shell, verts=16, mag=True)
    g.muzzle = (0, 0.661, bz)
    return g.done()


def g_m249(M):
    g = Gun("m249", 640)
    bz = 0.09
    g.p(P((-0.15, 0.03), (0.22, 0.03), (0.22, 0.116), (-0.13, 0.12), (-0.15, 0.1)), 0.058, M.park, bev=0.0022)
    g.p(P((-0.12, 0.12), (0.12, 0.12), (0.12, 0.134), (-0.1, 0.138)), 0.056, M.park, bev=0.002)
    rail(g, M.park, -0.06, 0.1, 0.146, w=0.021)
    g.cx(0.004, 0.029, 0.045, 0.15, 0.09, M.steel)
    g.s(0.0075, (0.047, 0.15, 0.09), M.steel)
    aperture(g, M, -0.11, 0.156, r=0.0035, base=0.02)
    g.sight = (0, -0.114, 0.156)
    barrel(g, M, 0.22, 0.68, bz, 0.012, M.park)
    g.b((0.032, 0.2, 0.01), (0, 0.33, bz + 0.016), M.park, bev=0.003)
    g.t([(0, 0.3, bz + 0.014), (0, 0.32, bz + 0.06), (0, 0.4, bz + 0.065), (0, 0.42, bz + 0.014)], 0.005, M.poly)
    g.c(0.011, 0.22, 0.52, 0.058, M.park, verts=20)
    g.b((0.03, 0.04, 0.05), (0, 0.52, 0.073), M.park, bev=0.002)
    for sx in (-1, 1):
        g.b((0.008, 0.28, 0.008), (sx * 0.012, 0.36, 0.042), M.park, bev=0.0012)
        g.b((0.012, 0.02, 0.012), (sx * 0.012, 0.22, 0.042), M.rubber, bev=0.002)
    g.c(0.0125, 0.68, 0.72, bz, M.park, verts=20)
    for a in (0, 90, 180, 270):
        ang = math.radians(a)
        g.b((0.0026, 0.025, 0.0026), (math.sin(ang) * 0.0118, 0.705, bz + math.cos(ang) * 0.0118), M.black, bev=0)
    g.b((0.008, 0.012, 0.06), (0, 0.66, bz + 0.032), M.park, bev=0.001)
    post(g, M, 0.66, 0.158, h=0.008)
    g.p(P((0.22, 0.035), (0.38, 0.045), (0.38, 0.078), (0.22, 0.078)), 0.05, M.poly, bev=0.004, segs=3)
    grip(g, M.stipple, d=0.044, w=0.032, zt=0.03, zb=-0.075, rake=18)
    guard(g, M.park, 0.018, 0.078, 0.03, 0.002)
    trigger(g, M.steel, 0.04, 0.029)
    g.p(P((-0.15, 0.106), (-0.48, 0.096), (-0.49, 0.08), (-0.49, -0.05), (-0.46, -0.056), (-0.25, 0.0), (-0.15, 0.035)), 0.042, M.poly, bev=0.003, segs=3)
    g.p(P((-0.49, 0.08), (-0.505, 0.08), (-0.505, -0.05), (-0.49, -0.05)), 0.044, M.rubber, bev=0.003)
    # 100-round soft pouch and the belt feeding up into the tray.
    g.b((0.07, 0.11, 0.105), (-0.03, 0.12, -0.028), M.olive, bev=0.008, mag=True)
    g.b((0.072, 0.112, 0.02), (-0.03, 0.12, 0.024), M.olive, bev=0.006, mag=True)
    for k in range(6):
        z = 0.03 + k * 0.016
        cartridge(g, M, (-0.04 + k * 0.004, 0.108, z), (1, 0, 0), 0.057, 0.0045, mag=True)
        g.b((0.008, 0.014, 0.003), (-0.04 + k * 0.004 + 0.03, 0.108, z), M.steel, bev=0.0004, mag=True)
    g.muzzle = (0, 0.72, bz)
    return g.done()


def g_barrett(M):
    g = Gun("barrett", 640)
    bz = 0.11
    g.p(P((-0.33, 0.1), (0.5, 0.1), (0.5, 0.15), (-0.3, 0.156), (-0.33, 0.14)), 0.064, M.park, bev=0.003)
    rail(g, M.park, -0.25, 0.45, 0.164, w=0.022)
    g.p(P((-0.33, 0.03), (0.2, 0.03), (0.2, 0.1), (-0.33, 0.1)), 0.056, M.park, bev=0.003)
    for k in range(5):
        g.b((0.002, 0.06, 0.02), (0.0322, 0.1 + k * 0.07, 0.125), M.black, bev=0)
    # Fluted barrel, the arrowhead muzzle brake.
    g.c(0.02, 0.5, 1.05, bz, M.park, verts=28)
    for a in range(0, 360, 45):
        ang = math.radians(a)
        g.b((0.004 if a % 180 else 0.003, 0.4, 0.003 if a % 180 else 0.004), (math.sin(ang) * 0.0195, 0.79, bz + math.cos(ang) * 0.0195), M.black, bev=0)
    g.p(P((1.05, 0.088), (1.17, 0.083), (1.2, 0.095), (1.2, 0.125), (1.17, 0.137), (1.05, 0.132)), 0.07, M.park, bev=0.004, segs=3)
    for k in range(3):
        for sx in (-1, 1):
            g.p(P((1.07 + k * 0.04, 0.095), (1.09 + k * 0.04, 0.1), (1.09 + k * 0.04, 0.12), (1.07 + k * 0.04, 0.125)), 0.003, M.black, x=sx * 0.0352, bev=0)
    g.c(0.011, 1.1995, 1.2012, bz, M.black, verts=16)
    g.t([(0, 0.1, 0.165), (0, 0.13, 0.205), (0, 0.27, 0.205), (0, 0.3, 0.165)], 0.006, M.park)
    for sx in (-1, 1):
        g.b((0.01, 0.35, 0.012), (sx * 0.03, 0.72, 0.082), M.park, bev=0.002)
        g.b((0.03, 0.03, 0.014), (sx * 0.03, 0.9, 0.082), M.rubber, bev=0.004)
    g.p(P((-0.33, 0.14), (-0.58, 0.14), (-0.6, 0.12), (-0.6, -0.04), (-0.56, -0.05), (-0.45, 0.0), (-0.33, 0.03)), 0.05, M.park, bev=0.004, segs=3)
    g.p(P((-0.6, 0.12), (-0.625, 0.12), (-0.625, -0.04), (-0.6, -0.04)), 0.054, M.rubber, bev=0.004)
    g.c(0.009, -0.55, -0.4, -0.05, M.park, verts=16)
    grip(g, M.stipple, d=0.046, w=0.032, zt=0.03, zb=-0.08, rake=15)
    guard(g, M.park, 0.018, 0.08, 0.03, 0.0)
    trigger(g, M.steel, 0.04, 0.029)
    eye = scope(g, M, -0.27, 0.2, 0.22, r=0.017, obj=0.03, oc=0.022, mount_z=0.164)
    g.sight = eye
    g.p(P((0.07, 0.035), (0.18, 0.035), (0.18, -0.1), (0.07, -0.1)), 0.035, M.park, bev=0.002, mag=True)
    g.b((0.038, 0.115, 0.008), (0, 0.125, -0.103), M.park, bev=0.002, mag=True)
    g.muzzle = (0, 1.2, bz)
    return g.done()


GUNS = [g_m1911, g_glock, g_thompson, g_trench, g_kar98k, g_garand, g_mp7, g_m4a1, g_ak12, g_benelli, g_m249, g_barrett]


def build_weapons():
    M = Mats()
    roots = []
    for fn in GUNS:
        gid = fn.__name__[2:]
        if ONLY_GUNS and gid not in ONLY_GUNS:
            continue
        roots.append(fn(M))
    return roots


# ---- first-person arms ---------------------------------------------------------------------------------------------

def metaball_mesh(name, caps, mat, res=0.0017, decimate=None):
    """Organic shapes from capsules [(a, b, radius)]; radius is the visible radius."""
    mb = bpy.data.metaballs.new(name)
    mb.resolution = res
    mb.threshold = 0.6
    obj = link(bpy.data.objects.new(name, mb))
    for a, b, r in caps:
        a, b = Vector(a), Vector(b)
        d = b - a
        el = mb.elements.new(type="CAPSULE" if d.length > 1e-5 else "BALL")
        el.co = (a + b) / 2
        el.radius = r / 0.454
        el.stiffness = 2.0
        if d.length > 1e-5:
            el.size_x = d.length / 2
            el.rotation = d.normalized().to_track_quat("X", "Z")
    obj = to_mesh(obj)
    obj.name = name
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    if decimate:
        m = obj.modifiers.new("Dec", "DECIMATE")
        m.ratio = decimate
        obj = to_mesh(obj)
    smooth_all(obj)
    return obj


def sleeve_mesh(name, wrist, elbow, r0, r1, mat, seed=0.0, extra=0.28):
    """Jacket sleeve from the wrist past the elbow, with compression folds and a cuff."""
    w, e = Vector(wrist), Vector(elbow)
    axis = (e - w).normalized()
    end = e + axis * extra
    side = axis.cross(Vector((0, 0, 1)))
    if side.length < 1e-3:
        side = Vector((1, 0, 0))
    side.normalize()
    up = side.cross(axis).normalized()
    rings, segs = 26, 22
    bm = bmesh.new()
    loops = []
    total = (end - w).length
    for i in range(rings):
        t = i / (rings - 1)
        c = w + (end - w) * t
        r = r0 + (r1 - r0) * min(1.0, t * 1.6)
        ring = []
        for j in range(segs):
            a = j / segs * math.tau
            fold = 0.0
            if t > 0.12:
                fold = 0.07 * math.sin(t * 38 + math.sin(a * 2 + seed) * 2.2 + seed) * math.sin(a * 3 + t * 9 + seed) * min(1.0, (t - 0.12) * 4)
            if t < 0.09:
                fold = 0.11  # cuff
            rr = r * (1 + fold)
            ring.append(bm.verts.new(c + (side * math.cos(a) + up * math.sin(a)) * rr))
        loops.append(ring)
    for i in range(rings - 1):
        for j in range(segs):
            bm.faces.new((loops[i][j], loops[i][(j + 1) % segs], loops[i + 1][(j + 1) % segs], loops[i + 1][j]))
    bm.faces.new(loops[0][::-1])
    _ = total
    obj = mesh_obj(name, bm, mat)
    m = obj.modifiers.new("Sub", "SUBSURF")
    m.levels = 1
    smooth_all(obj)
    return to_mesh(obj)


def build_arms():
    sleeve = pmat("SleeveFabric", (0.075, 0.08, 0.07), 0.92, 0.0, bump=0.5, bump_scale=700, bump_kind="weave", grime=0.6, vary=0.15)
    glove = pmat("GloveLeather", (0.035, 0.034, 0.036), 0.62, 0.0, wear=(0.09, 0.085, 0.08), wear_rough=0.45, bump=0.35, bump_scale=1600, grime=0.6)
    skin = pmat("FingerSkin", (0.5, 0.33, 0.26), 0.55, 0.0, bump=0.2, bump_scale=2400, grime=0.75, vary=0.1)
    pad = pmat("KnucklePad", (0.025, 0.025, 0.027), 0.8, 0.0, bump=0.4, bump_scale=900, grime=0.5)
    steel = pmat("WatchSteel", (0.5, 0.5, 0.52), 0.3, 1.0, grime=0.6)
    face = pmat("WatchFace", (0.02, 0.03, 0.025), 0.15, 0.0, grime=1.0, vary=0.0)
    X = Vector((1, 0, 0))
    Z = Vector((0, 0, 1))

    # Right hand around a pistol grip at PALM, raked RAKE.
    A = Vector((0, math.sin(RAKE), math.cos(RAKE)))
    B = Vector((0, math.cos(RAKE), -math.sin(RAKE)))

    def surf(theta, h, extra):
        t = math.radians(theta)
        return PALM + A * h + X * math.cos(t) * (0.0145 + extra) + B * math.sin(t) * (0.022 + extra)

    glove_caps, skin_caps = [], []
    for h, fr in ((0.006, 0.0088), (-0.013, 0.0084), (-0.031, 0.0076)):
        mcp, pip, dip, tip = surf(-38, h + 0.002, 0.017), surf(28, h, fr), surf(100, h - 0.002, fr), surf(158, h - 0.003, fr * 0.92)
        glove_caps += [(mcp, pip, fr * 1.08), (pip, dip, fr * 1.04)]
        skin_caps += [(dip, tip, fr * 0.9), (tip, tip, fr * 0.88)]
    # Index finger along the guard onto the trigger.
    i_mcp = surf(-28, 0.026, 0.016)
    i_pip = PALM + A * 0.03 + X * 0.021 + B * 0.032
    i_dip = PALM + A * 0.025 + X * 0.013 + B * 0.052
    i_tip = PALM + A * 0.017 + X * 0.005 + B * 0.058
    glove_caps += [(i_mcp, i_pip, 0.0088), (i_pip, i_dip, 0.0084)]
    skin_caps += [(i_dip, i_tip, 0.0078), (i_tip, i_tip, 0.0076)]
    # Thumb over the back strap, down the left side.
    t_cmc, t_mcp, t_ip, t_tip = surf(-115, 0.0, 0.03), surf(-160, 0.034, 0.016), surf(172, 0.044, 0.011), surf(135, 0.047, 0.0095)
    glove_caps += [(t_cmc, t_mcp, 0.012), (t_mcp, t_ip, 0.0102)]
    skin_caps += [(t_ip, t_tip, 0.0092), (t_tip, t_tip, 0.009)]
    # Palm and the back of the hand, wrist.
    wrist_r = PALM + A * (-0.022) - B * 0.062 + X * 0.036
    glove_caps += [
        (surf(-95, -0.028, 0.022), surf(-45, 0.012, 0.02), 0.021),
        (surf(-75, 0.022, 0.021), surf(-50, -0.034, 0.02), 0.019),
        (i_mcp, surf(-40, -0.03, 0.016), 0.011),
        (surf(-90, -0.01, 0.026), wrist_r, 0.024),
    ]
    hand_r = metaball_mesh("HandR", glove_caps, glove, decimate=0.35)
    tips_r = metaball_mesh("TipsR", skin_caps, skin, decimate=0.5)
    # Knuckle pad on the back of the hand.
    knuck = (surf(-38, 0.026, 0.017) + surf(-38, -0.029, 0.017)) / 2
    nrm = (X * math.cos(math.radians(-38)) + B * math.sin(math.radians(-38))).normalized()
    kp = box((0.012, 0.016, 0.062), knuck + nrm * 0.008, pad, bev=0.004)
    kp.rotation_euler = nrm.to_track_quat("X", "Z").to_euler()
    elbow_r = Vector((0.27, 0.04, -0.42))
    sleeve_r = sleeve_mesh("SleeveR", wrist_r - (wrist_r - elbow_r).normalized() * -0.012, elbow_r, 0.034, 0.05, sleeve, seed=0.3)
    cuff_r = cyl_between(wrist_r + (elbow_r - wrist_r).normalized() * 0.006, wrist_r + (elbow_r - wrist_r).normalized() * 0.03, 0.03, glove, 22, r2=0.033)
    arm_r = join([hand_r, tips_r, kp, sleeve_r, cuff_r], "ArmR")

    # Left hand cupping a rifle handguard from below.
    C = Vector((PALM.x, 0.52, PALM.z + 0.085))

    def wrap(phi, y, extra):
        p = math.radians(phi)
        return Vector((C.x + math.sin(p) * (0.024 + extra), y, C.z - math.cos(p) * (0.024 + extra)))

    gl, sk = [], []
    for y, fr in ((0.558, 0.0086), (0.541, 0.0088), (0.524, 0.0084), (0.508, 0.0076)):
        mcp, pip, dip, tip = wrap(18, y - 0.004, 0.016), wrap(62, y, fr), wrap(100, y + 0.002, fr), wrap(128, y + 0.003, fr * 0.92)
        gl += [(mcp, pip, fr * 1.08), (pip, dip, fr * 1.04)]
        sk += [(dip, tip, fr * 0.9), (tip, tip, fr * 0.88)]
    lt_cmc, lt_mcp, lt_ip, lt_tip = wrap(-35, 0.5, 0.03), wrap(-70, 0.52, 0.016), wrap(-98, 0.55, 0.011), wrap(-118, 0.575, 0.0095)
    gl += [(lt_cmc, lt_mcp, 0.012), (lt_mcp, lt_ip, 0.0102)]
    sk += [(lt_ip, lt_tip, 0.0092), (lt_tip, lt_tip, 0.009)]
    wrist_l = Vector((C.x - 0.05, 0.47, C.z - 0.06))
    gl += [
        (wrap(-10, 0.5, 0.022), wrap(14, 0.555, 0.02), 0.021),
        (wrap(-30, 0.545, 0.021), wrap(5, 0.505, 0.02), 0.019),
        (wrap(-25, 0.5, 0.024), wrist_l, 0.024),
    ]
    hand_l = metaball_mesh("HandL", gl, glove, decimate=0.35)
    tips_l = metaball_mesh("TipsL", sk, skin, decimate=0.5)
    elbow_l = Vector((-0.2, 0.3, -0.45))
    dir_l = (elbow_l - wrist_l).normalized()
    sleeve_l = sleeve_mesh("SleeveL", wrist_l + dir_l * 0.012, elbow_l, 0.034, 0.05, sleeve, seed=1.7)
    cuff_l = cyl_between(wrist_l + dir_l * 0.006, wrist_l + dir_l * 0.03, 0.03, glove, 22, r2=0.033)
    # Wristwatch just above the glove cuff, face turned towards the camera side.
    wpos = wrist_l + dir_l * 0.05
    band_ = cyl_between(wpos - dir_l * 0.009, wpos + dir_l * 0.009, 0.0345, pad, 24)
    out = Vector((-0.6, -0.2, 0.75)).normalized()
    out = (out - dir_l * out.dot(dir_l)).normalized()
    case = cyl_between(wpos + out * 0.03, wpos + out * 0.041, 0.016, steel, 28)
    glass = cyl_between(wpos + out * 0.0405, wpos + out * 0.0418, 0.0135, face, 28)
    arm_l = join([hand_l, tips_l, sleeve_l, cuff_l, band_, case, glass], "ArmL")
    for o in (arm_r, arm_l):
        set_origin(o, (0, 0, 0))
    if not NOBAKE:
        bake_set("arms", [arm_r, arm_l], 768)
    print("ARMS tris", tris(arm_r), tris(arm_l))
    _ = Z
    return [arm_r, arm_l]


# ---- previews ------------------------------------------------------------------------------------------------------

def preview_scene(res=(1280, 720), samples=48):
    sc = setup_cycles()
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.get("Dark") or bpy.data.worlds.new("Dark")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.003, 0.0035, 0.005, 1)
    bg.inputs[1].default_value = 1.0
    sc.world = world
    return sc


def add_light(kind, loc, target, energy, color, size=0.05, spot=50):
    d = bpy.data.lights.new(kind, kind)
    d.energy = energy
    d.color = color
    d.shadow_soft_size = size
    if kind == "SPOT":
        d.spot_size = math.radians(spot)
        d.spot_blend = 0.5
    o = link(bpy.data.objects.new(kind, d))
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return o


def camera(loc, target=None, rot=None, lens=50, vfov=None):
    cd = bpy.data.cameras.new("Cam")
    if vfov:
        cd.sensor_fit = "VERTICAL"
        cd.angle = math.radians(vfov)
    else:
        cd.lens = lens
    c = link(bpy.data.objects.new("Cam", cd))
    c.location = loc
    if rot:
        c.rotation_euler = rot
    else:
        c.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = c
    return c


def render(path):
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path)


def preview_guns(roots):
    preview_scene((1800, 1300), 64)
    made = []
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.62))
    floor = bpy.context.active_object
    floor.data.materials.append(pmat("PrevFloor", (0.04, 0.04, 0.04), 0.7))
    made.append(floor)
    spots = []
    for i, r in enumerate(roots):
        r.location = (0, (i % 3) * 1.55 - 1.4, 0.75 - (i // 3) * 0.42)
        spots.append(r.location.copy())
    made.append(add_light("AREA", (2.2, 0.0, 1.6), (0, 0, 0.1), 900, (1.0, 0.78, 0.55), size=1.2))
    made.append(add_light("AREA", (-1.5, -2.5, 0.5), (0, 0, 0.1), 120, (0.45, 0.6, 1.0), size=2.0))
    made.append(add_light("AREA", (0.6, 3.0, 1.2), (0, 0, 0.1), 160, (0.9, 0.9, 1.0), size=1.0))
    made.append(camera((3.6, 0.15, 0.1), target=(0, 0.15, 0.1), lens=24))
    render(Path(PREVIEW) / "guns_side.png")
    for o in made:
        bpy.data.objects.remove(o, do_unlink=True)
    for r in roots:
        r.location = (0, 0, 0)


def preview_closeups(roots):
    preview_scene((1100, 700), 96)
    for r in roots:
        r.hide_render = True
    for r in roots:
        if r.name not in ("m4a1", "m1911", "kar98k", "thompson", "ak12", "trench"):
            continue
        r.hide_render = False
        dims = max(0.25, max(v.co.y for v in r.data.vertices) - min(v.co.y for v in r.data.vertices))
        cy_ = (max(v.co.y for v in r.data.vertices) + min(v.co.y for v in r.data.vertices)) / 2
        made = [
            add_light("SPOT", (0.5, cy_ + 0.3, 0.9), (0, cy_, 0.05), 140 * dims, (1.0, 0.75, 0.5), size=0.05, spot=60),
            add_light("AREA", (-0.8, cy_ - 0.8, 0.2), (0, cy_, 0.05), 25 * dims, (0.4, 0.55, 1.0), size=1.0),
            camera((dims * 1.25, cy_ - dims * 0.55, 0.12 + dims * 0.18), target=(0, cy_, 0.04), lens=50),
        ]
        render(Path(PREVIEW) / f"close_{r.name}.png")
        for o in made:
            bpy.data.objects.remove(o, do_unlink=True)
        r.hide_render = True
    for r in roots:
        r.hide_render = False


def preview_fp(roots, arms):
    """What the player sees: camera at the origin, arms and gun at the client's hip pose."""
    preview_scene((1280, 720), 96)
    hip = Vector((0.01, 0.02, 0.07))
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -1.62))
    floor = bpy.context.active_object
    floor.data.materials.append(pmat("PrevFloor", (0.04, 0.04, 0.04), 0.7))
    made = [floor, camera((0, 0, 0), rot=(math.radians(90), 0, 0), vfov=72)]
    made.append(add_light("SPOT", (0.6, 1.2, 1.4), (0.1, 0.5, -0.2), 260, (1.0, 0.72, 0.45), size=0.1, spot=40))
    made.append(add_light("POINT", (-0.3, -0.2, 0.25), (0, 0, 0), 2.5, (0.62, 0.7, 0.85), size=0.2))
    for a in arms:
        a.location = hip
    for name in ("m4a1", "m1911", "ak12", "kar98k"):
        gun = next((r for r in roots if r.name == name), None)
        if not gun:
            continue
        for r in roots:
            r.hide_render = r is not gun
        gun.location = PALM + hip
        left = next(a for a in arms if a.name == "ArmL")
        left.location = hip + (Vector((0.06, -0.17, -0.01)) if name == "m1911" else Vector((0, 0, 0)))
        render(Path(PREVIEW) / f"fp_{name}.png")
        gun.location = (0, 0, 0)
    for r in roots:
        r.hide_render = False
    for a in arms:
        a.location = (0, 0, 0)
    for o in made:
        bpy.data.objects.remove(o, do_unlink=True)


# ---- export --------------------------------------------------------------------------------------------------------

def export(name, objects):
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
        export_image_format="JPEG",
        export_jpeg_quality=80,
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
        export_vertex_color="NONE",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
    )
    print(f"EXPORTED {path}")


def main():
    random.seed(7)
    clear_scene()
    roots, arms = [], []
    if WHAT in (None, "weapons", "guns"):
        roots = build_weapons()
    if WHAT in (None, "arms") or PREVIEW:
        arms = build_arms()
    if PREVIEW:
        Path(PREVIEW).mkdir(parents=True, exist_ok=True)
        if roots:
            preview_guns(roots)
            preview_closeups(roots)
        if roots and arms:
            preview_fp(roots, arms)
    if roots and not ONLY_GUNS:
        export("weapons", roots)
    if arms and WHAT in (None, "arms"):
        export("arms", arms)


if __name__ == "__main__":
    main()
