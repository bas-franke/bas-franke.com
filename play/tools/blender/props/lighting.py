"""
Last Light hotel lighting props and the luggage trolley (props_lighting.glb), modelled after the props reference
sheet: a polished brass mushroom table lamp, a floor lamp with a cream drum shade on a brass rod cage, a brass wall
sconce with frosted glass tubes, and a brass birdcage luggage trolley.

    blender --background --factory-startup --python lighting.py -- <output-dir> [preview-dir]

Roots: tableLamp, floorLamp, sconce, luggageCart. They override the same names in props.glb (models.ts PROP_PACKS).
Conventions (world.ts / decor.ts rely on them):
  * Blender +Y is the front (glTF -Z); origins at the floor centre; real scale in metres.
  * sconce: origin at the centre of the wall plate, sticking out along +Y (the room side).
  * Glowing parts use the materials Shade (fabric shades), Bulb (bulbs) and SconceGlow (frosted tubes); decor.ts swaps
    them for its own glow materials at runtime.
With a preview-dir, renders each prop in a studio matching the reference sheet (charcoal backdrop, warm key upper left,
rim, glossy dark floor) and writes side-by-side comparisons with the reference panels.
"""

import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/zombies")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None


# ---- helpers ---------------------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def smooth(obj, angle=35):
    for poly in obj.data.polygons:
        poly.use_smooth = True
    activate(obj)
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
    except Exception:
        pass
    return obj


def revolve(name, profile, mat, segments=48, uv_rep=1.0, angle=35):
    """Lathe: profile is [(radius, z), ...] from the bottom up; revolved around Z. Cylindrical UVs (u around, v along)."""
    bm = bmesh.new()
    rings = []
    for k in range(segments + 1):
        a = 2 * math.pi * k / segments
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((r * ca, r * sa, z)) for r, z in profile])
    uv_layer = bm.loops.layers.uv.new()
    lengths = [0.0]
    for i in range(1, len(profile)):
        lengths.append(lengths[-1] + math.dist(profile[i], profile[i - 1]))
    total = lengths[-1] or 1.0
    for k in range(segments):
        for i in range(len(profile) - 1):
            vs = (rings[k][i], rings[k + 1][i], rings[k + 1][i + 1], rings[k][i + 1])
            if len({v.co.to_tuple(6) for v in vs}) < 3:
                continue
            try:
                f = bm.faces.new(vs)
            except ValueError:
                continue
            uvs = ((k / segments, lengths[i] / total), ((k + 1) / segments, lengths[i] / total), ((k + 1) / segments, lengths[i + 1] / total), (k / segments, lengths[i + 1] / total))
            for loop, uv in zip(f.loops, uvs):
                loop[uv_layer].uv = (uv[0] * uv_rep, uv[1] * uv_rep)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return smooth(obj, angle)


def tube(name, points, radius, mat, closed=False, sides=16):
    """A round tube along a polyline / smooth path (curve with bevel, converted to mesh)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = max(2, sides // 4)
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for p, co in zip(sp.points, points):
        p.co = (*co, 1.0)
    sp.use_cyclic_u = closed
    obj = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(obj)
    cu.materials.append(mat)
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    cube_uv(obj, 4.0)
    return smooth(obj, 50)


def arc(center, radius, a0, a1, n, plane="xz"):
    pts = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        c, s = math.cos(a) * radius, math.sin(a) * radius
        if plane == "xz":
            pts.append((center[0] + c, center[1], center[2] + s))
        else:
            pts.append((center[0], center[1] + c, center[2] + s))
    return pts


def box(name, size, loc, mat, bevel=0.003, segs=3):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segs
        mod.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.data.materials.append(mat)
    cube_uv(obj, 3.0)
    return smooth(obj, 30)


def cube_uv(obj, scale):
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=1.0 / scale)
    bpy.ops.object.mode_set(mode="OBJECT")


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    return obj


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---- materials -------------------------------------------------------------------------------------------------------

def image(name, rgba, noncolor=False):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(rgba[::-1], dtype=np.float32).ravel())
    img.file_format = "JPEG"
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    img.pack()
    return img


def brushed_maps(size=256, seed=3):
    """Polished brass with faint vertical polishing streaks: roughness (G) and metalness (B) for glTF."""
    rng = np.random.default_rng(seed)
    streak = rng.normal(0, 1, size)
    for _ in range(3):
        streak = (streak + np.roll(streak, 1) + np.roll(streak, -1)) / 3
    col = np.tile(streak[None, :], (size, 1)) + rng.normal(0, 0.35, (size, size)) * 0.25
    col = (col - col.min()) / (np.ptp(col) or 1)
    rough = 0.2 + col * 0.12
    rm = np.ones((size, size, 4), np.float32)
    rm[..., 1] = rough
    rm[..., 2] = 1.0
    return rm


def principled(name, color, rough=0.5, metal=0.0, emission=None, strength=1.0, transmission=0.0, alpha=1.0, double=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = not double
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    if transmission:
        b.inputs["Transmission Weight"].default_value = transmission
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(mat, attr, val)
            except Exception:
                pass
    return mat


def materials():
    m = {}
    # Polished, warm gold brass as on the sheet: fully metallic, low roughness with faint polishing streaks.
    brass = principled("PolishedBrass", (1.0, 0.68, 0.3), rough=0.24, metal=1.0)
    nt = brass.node_tree
    b = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image("brass_rm", brushed_maps(), noncolor=True)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tex.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    b.inputs["Metallic"].default_value = 1.0
    m["brass"] = brass
    m["brassDark"] = principled("DarkBrass", (0.55, 0.36, 0.13), rough=0.3, metal=1.0)
    m["shade"] = principled("Shade", (0.92, 0.84, 0.68), rough=0.85, emission=(1.0, 0.78, 0.5), strength=0.9, double=True)
    m["bulb"] = principled("Bulb", (1.0, 0.92, 0.8), rough=0.3, emission=(1.0, 0.72, 0.42), strength=6.0)
    m["glow"] = principled("SconceGlow", (0.95, 0.82, 0.62), rough=0.45, emission=(1.0, 0.6, 0.26), strength=1.3)
    m["deck"] = principled("CartDeck", (0.018, 0.017, 0.018), rough=0.95)
    m["rubber"] = principled("Rubber", (0.012, 0.012, 0.012), rough=0.75)
    return m


# ---- props -----------------------------------------------------------------------------------------------------------

def table_lamp(m):
    """Panel 5: polished brass mushroom dome on a thick cylinder stem and a stepped round base. 0.62 m tall."""
    parts = []
    base = [
        (0.0, 0.0), (0.128, 0.0), (0.133, 0.005), (0.133, 0.02), (0.127, 0.026),
        (0.104, 0.028), (0.1, 0.033), (0.1, 0.042), (0.094, 0.046),
        (0.062, 0.048), (0.058, 0.052), (0.058, 0.062), (0.054, 0.066),
        (0.052, 0.068), (0.052, 0.31), (0.057, 0.314), (0.06, 0.318), (0.06, 0.332), (0.055, 0.336),
        (0.026, 0.338), (0.018, 0.342), (0.018, 0.4), (0.0, 0.4),
    ]
    parts.append(revolve("lampBody", base, m["brass"], 64))
    # Dome: a thick lip at the rim, a half-ellipse up to a small finial; open underneath, brass inside too.
    outer, inner = [], []
    for i in range(19):
        t = i / 18 * (math.pi / 2)
        outer.append((0.215 * math.cos(t), 0.37 + 0.19 * math.sin(t)))
        inner.append((0.203 * math.cos(t), 0.375 + 0.177 * math.sin(t)))
    dome = [(0.203, 0.362), (0.212, 0.358), (0.219, 0.362), (0.221, 0.37)] + outer[1:] + [(0.0, 0.56)]
    parts.append(revolve("dome", dome, m["brass"], 72))
    parts.append(revolve("domeIn", list(reversed(inner[:-1])) + [(0.203, 0.362)], m["brass"], 72))
    parts.append(revolve("finial", [(0.0, 0.555), (0.014, 0.557), (0.016, 0.57), (0.01, 0.581), (0.0, 0.583)], m["brass"], 24))
    # Socket and bulb under the dome.
    parts.append(revolve("socket", [(0.0, 0.4), (0.022, 0.4), (0.022, 0.43), (0.0, 0.43)], m["brassDark"], 24))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.04, location=(0, 0, 0.455), segments=20, ring_count=12)
    bulb = bpy.context.active_object
    bulb.data.materials.append(m["bulb"])
    parts.append(smooth(bulb))
    return join(parts, "tableLamp")


def floor_lamp(m):
    """Panel 6: cream drum shade on a brass column of slender rods with collars, stepped round base. 1.68 m tall."""
    parts = []
    parts.append(revolve("base", [(0.0, 0.0), (0.185, 0.0), (0.19, 0.006), (0.19, 0.024), (0.183, 0.03), (0.135, 0.033), (0.13, 0.04), (0.13, 0.05), (0.12, 0.054), (0.0, 0.054)], m["brass"], 72))
    # Lower collar, rod cage, upper collar.
    parts.append(revolve("collarLow", [(0.0, 0.054), (0.066, 0.054), (0.066, 0.11), (0.062, 0.116), (0.056, 0.12), (0.0, 0.12)], m["brass"], 48))
    parts.append(revolve("collarHigh", [(0.0, 1.2), (0.056, 1.2), (0.062, 1.204), (0.066, 1.21), (0.066, 1.26), (0.03, 1.265), (0.0, 1.265)], m["brass"], 48))
    for k in range(6):
        a = k * math.pi / 3
        r = 0.05
        parts.append(tube("rod", [(r * math.cos(a), r * math.sin(a), 0.115), (r * math.cos(a), r * math.sin(a), 1.205)], 0.009, m["brass"], sides=12))
    parts.append(tube("core", [(0, 0, 0.115), (0, 0, 1.205)], 0.018, m["brassDark"], sides=12))
    # Neck, harp and the drum shade.
    parts.append(revolve("neck", [(0.0, 1.265), (0.015, 1.265), (0.015, 1.4), (0.024, 1.405), (0.024, 1.43), (0.0, 1.43)], m["brass"], 24))
    shade = [(0.235, 1.33), (0.24, 1.332), (0.24, 1.678), (0.235, 1.68)]
    parts.append(revolve("shade", shade, m["shade"], 64))
    parts.append(revolve("shadeIn", [(0.23, 1.676), (0.23, 1.334)], m["shade"], 64))
    for k in range(3):
        a = k * 2 * math.pi / 3
        parts.append(tube("harp", [(0, 0, 1.44), (0.23 * math.cos(a), 0.23 * math.sin(a), 1.67)], 0.003, m["brass"], sides=8))
    parts.append(revolve("trimTop", [(0.24, 1.676), (0.244, 1.678), (0.244, 1.684), (0.238, 1.684)], m["brass"], 64))
    parts.append(revolve("trimLow", [(0.238, 1.326), (0.244, 1.326), (0.244, 1.332), (0.24, 1.334)], m["brass"], 64))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.045, location=(0, 0, 1.5), segments=20, ring_count=12)
    bulb = bpy.context.active_object
    bulb.data.materials.append(m["bulb"])
    parts.append(smooth(bulb))
    return join(parts, "floorLamp")


def sconce(m):
    """Panel 9: a slim brass back plate with three frosted glass tubes in brass sleeves; the middle one sits higher.
    Origin at the wall plate centre; sticks out along +Y."""
    parts = []
    parts.append(box("plate", (0.04, 0.014, 0.22), (0, 0.007, 0.0), m["brass"], bevel=0.004))
    parts.append(box("arm", (0.13, 0.05, 0.05), (0, 0.04, 0.0), m["brass"], bevel=0.006))
    y = 0.072
    tubes = ((-0.045, -0.2, 0.16), (0.0, -0.14, 0.23), (0.045, -0.2, 0.16))
    r = 0.015
    for x, z0, z1 in tubes:
        for a, b in ((z0 + 0.018, -0.022), (0.022, z1 - 0.018)):
            g = revolve("glass", [(0.0, a), (r, a), (r, b), (0.0, b)], m["glow"], 32)
            g.location = (x, y, 0)
            parts.append(g)
        for zc, h in ((z0, 0.018), (-0.022, 0.044), (z1 - 0.018, 0.018)):
            c = revolve("sleeve", [(0.0, zc), (r + 0.003, zc), (r + 0.004, zc + 0.003), (r + 0.004, zc + h - 0.003), (r + 0.003, zc + h), (0.0, zc + h)], m["brass"], 32)
            c.location = (x, y, 0)
            parts.append(c)
    obj = join(parts, "sconce")
    activate(obj)
    bpy.ops.object.transform_apply(location=True)
    return obj


def luggage_cart(m):
    """Panel 13: brass birdcage luggage trolley: dark carpeted deck with a brass rim on four casters, two arched
    frames along the long sides joined by end bars and a top rail with a ball and hanger hook. Length along X, ~1.95 m."""
    parts = []
    L, W = 1.1, 0.6
    deck_z = 0.15
    parts.append(box("deck", (L, W, 0.05), (0, 0, deck_z), m["deck"], bevel=0.01))
    # Brass rim around the deck.
    rim = [(-L / 2, -W / 2, deck_z + 0.03), (L / 2, -W / 2, deck_z + 0.03), (L / 2, W / 2, deck_z + 0.03), (-L / 2, W / 2, deck_z + 0.03)]
    parts.append(tube("rim", rim, 0.012, m["brass"], closed=True))
    parts.append(tube("rimLow", [(p[0], p[1], deck_z - 0.025) for p in rim], 0.008, m["brass"], closed=True))
    # Two arched frames along the long sides (front and back): posts at the deck ends, a rounded-rectangle top.
    post_r = 0.016
    hl = L / 2 - 0.03
    top = 1.8
    corner = 0.3
    for sy in (-1, 1):
        y = sy * (W / 2 - 0.03)
        path = [(-hl, y, deck_z + 0.02), (-hl, y, top - corner)]
        path += [(-hl + corner - math.cos(t) * corner, y, top - corner + math.sin(t) * corner) for t in [i / 12 * (math.pi / 2) for i in range(1, 12)]]
        path += [(-hl + corner, y, top), (hl - corner, y, top)]
        path += [(hl - corner + math.sin(t) * corner, y, top - corner + math.cos(t) * corner) for t in [i / 12 * (math.pi / 2) for i in range(1, 12)]]
        path += [(hl, y, top - corner), (hl, y, deck_z + 0.02)]
        parts.append(tube("arch", path, post_r, m["brass"]))
        for sx in (-1, 1):
            c = revolve("collar", [(0.0, 0.0), (0.026, 0.0), (0.03, 0.008), (0.03, 0.05), (0.022, 0.058), (0.0, 0.058)], m["brass"], 24)
            c.location = (sx * hl, y, deck_z + 0.02)
            parts.append(c)
    # Cross bars at both ends (mid height) and along the top between the two arches.
    for sx in (-1, 1):
        parts.append(tube("endBar", [(sx * hl, -(W / 2 - 0.03), 0.95), (sx * hl, W / 2 - 0.03, 0.95)], 0.011, m["brass"]))
    parts.append(tube("topRail", [(0, -(W / 2 - 0.03), top), (0, W / 2 - 0.03, top)], 0.014, m["brass"]))
    # Ball finial and a hanger hook above the middle of the top rail.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.035, location=(0, 0, top + 0.045), segments=24, ring_count=12)
    ball = bpy.context.active_object
    ball.data.materials.append(m["brass"])
    parts.append(smooth(ball))
    hook = [(0, 0.0, top + 0.08)] + [(0, math.sin(t) * 0.05, top + 0.13 + math.cos(t) * 0.05) for t in [i / 16 * (1.5 * math.pi) for i in range(17)]]
    parts.append(tube("hook", hook, 0.007, m["brass"]))
    # Casters: brass swivel forks, black wheels.
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * (L / 2 - 0.08), sy * (W / 2 - 0.08)
            plate = revolve("swivel", [(0.0, 0.0), (0.035, 0.0), (0.035, 0.012), (0.0, 0.012)], m["brass"], 24)
            plate.location = (x, y, deck_z - 0.04)
            parts.append(plate)
            for fy in (-1, 1):
                parts.append(box("fork", (0.05, 0.006, 0.07), (x, y + fy * 0.022, deck_z - 0.075), m["brass"], bevel=0.002, segs=2))
            bpy.ops.mesh.primitive_cylinder_add(radius=0.055, depth=0.036, vertices=28, location=(x, y, 0.05), rotation=(math.pi / 2, 0, 0))
            wheel = bpy.context.active_object
            wheel.data.materials.append(m["rubber"])
            mod = wheel.modifiers.new("Bevel", "BEVEL")
            mod.width = 0.008
            mod.segments = 3
            bpy.ops.object.modifier_apply(modifier=mod.name)
            parts.append(smooth(wheel))
            hub = revolve("hub", [(0.0, -0.018), (0.02, -0.018), (0.02, 0.018), (0.0, 0.018)], m["brass"], 20)
            hub.rotation_euler = (math.pi / 2, 0, 0)
            hub.location = (x, y, 0.05)
            parts.append(hub)
    obj = join(parts, "luggageCart")
    activate(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True)
    return obj


# ---- studio preview ------------------------------------------------------------------------------------------------------

REF = Path(r"C:\Users\buunn\AppData\Local\Temp\claude\C--Projects-bas-franke-com\5cfa0a1c-4b50-4c12-9ad4-13780799ba35\images\4.webp")
# Reference panel boxes in the 1536 x 1024 sheet (main view of each prop).
PANELS = {"tableLamp": (0, 248, 245, 508), "floorLamp": (384, 248, 640, 508), "sconce": (0, 512, 230, 762), "luggageCart": (0, 766, 230, 1024)}
# Camera per prop: target height, distance, elevation (deg), azimuth (deg, 0 = straight on from the front +Y).
VIEWS = {"tableLamp": (0.3, 1.45, 8, -8), "floorLamp": (0.86, 3.5, 4, 0), "sconce": (0.57, 0.95, 2, -12), "luggageCart": (1.0, 4.9, 5, -14)}


def studio():
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
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 680
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = -0.6
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.03, 0.03, 0.032, 1)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    # Charcoal sweep with a satin finish (the sheet's floor shows soft reflections).
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.data.materials.append(principled("Floor", (0.03, 0.03, 0.032), rough=0.32))
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, -6, 0), rotation=(math.pi / 2, 0, 0))
    wall = bpy.context.active_object
    wall.data.materials.append(principled("Wall", (0.035, 0.035, 0.037), rough=0.9))
    # Warm soft key upper left, a warm rim behind right, and tall soft strips for the vertical streak reflections.
    def area(name, loc, rot, size, energy, color):
        bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
        light = bpy.context.active_object
        light.data.size = size
        light.data.energy = energy
        light.data.color = color
        light.name = name
        return light
    area("key", (-2.4, 2.6, 3.0), (math.radians(-45), math.radians(-38), 0), 2.0, 260, (1.0, 0.86, 0.7))
    area("rim", (2.2, -2.2, 2.4), (math.radians(55), math.radians(40), 0), 1.4, 160, (1.0, 0.78, 0.52))
    area("fill", (2.6, 2.4, 1.2), (math.radians(-70), math.radians(48), 0), 2.5, 30, (0.9, 0.85, 0.8))
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0.6, 3.2))
    top = bpy.context.active_object
    top.scale = (3.0, 2.0, 1)
    top.rotation_euler = (math.pi, 0, 0)
    top.data.materials.append(principled("Softbox", (0, 0, 0), emission=(1.0, 0.88, 0.7), strength=2.4))
    top.visible_camera = False
    for x in (-1.6, 1.6):
        bpy.ops.mesh.primitive_plane_add(size=1, location=(x, 1.6, 1.2), rotation=(math.pi / 2, 0, math.atan2(-x, -1.6)))
        strip = bpy.context.active_object
        strip.scale = (0.25, 2.4, 1)
        strip.data.materials.append(principled("Strip", (0, 0, 0), emission=(1.0, 0.85, 0.65), strength=2.0))
        strip.visible_camera = False


def render(obj, name, out):
    tgt_z, dist, elev, azim = VIEWS[name]
    scene = bpy.context.scene
    for o in bpy.data.objects:
        if o.get("prop"):
            o.hide_render = o is not obj
    obj.location.z = 0.55 if name == "sconce" else 0.0
    e, a = math.radians(elev), math.radians(azim)
    cam_loc = (math.sin(a) * math.cos(e) * dist, math.cos(a) * math.cos(e) * dist, tgt_z + math.sin(e) * dist)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 70
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = cam_loc
    d = np.array((0, 0, tgt_z)) - np.array(cam_loc)
    from mathutils import Vector
    cam.rotation_euler = Vector(d).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = str(out / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)


def compare(out):
    try:
        from PIL import Image
    except Exception:
        print("no Pillow in Blender's Python; comparison sheet skipped")
        return
    ref = Image.open(REF).convert("RGB")
    rows = []
    for name, box_ in PANELS.items():
        r = ref.crop(box_)
        mine = Image.open(out / f"{name}.png").convert("RGB")
        h = 420
        r = r.resize((int(r.width * h / r.height), h))
        mine = mine.resize((int(mine.width * h / mine.height), h))
        row = Image.new("RGB", (r.width + mine.width + 10, h), (20, 20, 20))
        row.paste(r, (0, 0))
        row.paste(mine, (r.width + 10, 0))
        rows.append(row)
    sheet = Image.new("RGB", (max(r.width for r in rows) * 2 + 10, h * 2 + 10), (20, 20, 20))
    for i, row in enumerate(rows):
        sheet.paste(row, ((i % 2) * (sheet.width // 2 + 5), (i // 2) * (h + 10)))
    sheet.save(out / "compare.jpg", quality=88)


# ---- main --------------------------------------------------------------------------------------------------------------

def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_jpeg_quality=85,
    )


def main():
    clear_scene()
    m = materials()
    objs = [table_lamp(m), floor_lamp(m), sconce(m), luggage_cart(m)]
    for o in objs:
        o["prop"] = True
        print(f"{o.name}: {tris(o)} tris, dims {tuple(round(v, 3) for v in o.dimensions)}")
    OUT.mkdir(parents=True, exist_ok=True)
    export(objs, OUT / "props_lighting.glb")
    print(f"wrote {OUT / 'props_lighting.glb'}")
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        studio()
        for o in objs:
            render(o, o.name, PREVIEW)
        compare(PREVIEW)


main()
