"""
SWAT operator animation clips for Last Light: the MP5 shouldered at the ready (stock in the shoulder pocket, sights at
the eye line, cheek on the stock, elbows tucked, knees soft, feet shoulder width with the left foot ~22 cm ahead, hips
under the body, slight forward lean), a shouldered combat jog, a low-ready sprint, and the matching pistol set
(two-handed isosceles at eye level, support hand cupping the shooting hand).

    import swat_anim
    actions = swat_anim.build_clips(arm, bz)        # arm: the `Survivor` armature, bz: build_zombies module

Every pose is solved, not hand-keyed: per frame the legs reach foot targets with IK (feet planted flat, or rolled
about the heel / toe so the contact point never slides), the torso leans and the head drops onto the sights, and the
arms reach a *gun transform* G with IK. The right hand always sits on the grip with the same hand-to-gun offset
(HAND_IN_GRIP), so the gun the game hangs on the right hand stays seated in every clip. The game computes that hang
point from the idle pose and `IDLE_GRIP` (models.ts GRIP = (x, z, -y) of IDLE_GRIP in metres, see models_ts_grip()).
Everything is baked to FK eulers through bz.keyframes, in place (no root motion), 30 fps.

Ground speed: client.ts plays `walk` at timeScale speed / 3.6 and `run` at speed / 6 (walk speed 4.2 m/s, sprint 6.3),
so the in-place cycles are built for 3.6 m/s and 6 m/s at timeScale 1: the planted foot moves back at exactly that
speed, which keeps the feet from skating at any speed the game plays them at. At 3.6 m/s nobody walks, so `walk` is a
low, smooth combat jog with the gun shouldered; `run` is a sprint at low ready.

Clips: idle 3.0 s, walk 0.62 s, run 0.66 s, downed 2.0 s, reload 1.5 s,
       idle_pistol 3.0 s, walk_pistol 0.62 s, run_pistol 0.66 s, reload_pistol 1.3 s.
"""

import math

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

FPS = 30

# Gun (grip) pose of the idle's first frame, character space (Blender: x right, y forward, z up). models.ts uses it.
IDLE_GRIP = Vector((0.0, 0.0, 0.0))

# Where the shooter's right eye sits in the head bone's space (rest pose, before the S scale).
EYE_R = Vector((0.032, 0.095, 1.705))
# weapons.glb `mp7` (the MP5SD): origin at the grip, rear sight (mp7_sight) 0.158 above and 0.09 behind it, stock butt
# at y -0.233 (z -0.03..0.1), SD handguard a cylinder r 0.031 round z 0.071 from y 0.165 to 0.31, mag well y 0.08-0.11.
MP5_SIGHT = Vector((0.0, -0.09, 0.158))
EYE_RELIEF = 0.03
GUARD_Z, GUARD_R, GUARD_Y = 0.071, 0.031, (0.165, 0.31)
# weapons.glb `m1911`: rear sight 0.089 above the grip, 0.05 behind; grip down to z -0.078, trigger guard front y ~0.05.
PISTOL_SIGHT = Vector((0.0, -0.05, 0.089))

# Ground speeds the client's timeScale assumes (client.ts: speed / 3.6 for walk, speed / 6 for run).
WALK_SPEED = 3.6
RUN_SPEED = 6.0
WALK_T = 0.62
RUN_T = 0.66

# Sole contact points relative to the ankle (rest foot: ankle 0.092 above the ground): heel and toe pivots (y, z).
HEEL = (-0.055, -0.092)
TOE = (0.165, -0.092)


# The gloves (swat_limbs.py) are modelled curled round a 35 mm cylinder; each glove object stores that cylinder in A-pose
# world space as `grip_center` / `grip_axis` (pointing to the little-finger end) / `grip_radius`. These are the values
# of the current build, used when the props are not in the scene.
GLOVE_GRIP = {
    "R": ((0.4487, 0.0197, 0.8506), (0.6569, -0.7302, 0.1876)),
    "L": ((-0.4487, 0.0197, 0.8506), (-0.6569, -0.7302, 0.1876)),
}
GLOVE_R = 0.0174
HAND_CYL = {}  # side -> (centre, axis, palm direction) in the hand bone's rest frame

# Right hand on the pistol grip (both guns, gun space): the grip centre line at mid-hand height (MP5: 20 degree rake),
# little finger at the bottom, the hand (back of the hand out) on the right of the grip and a little behind it.
_RAKE = math.radians(20)
R_GRIP_C = Vector((0.0, -0.024 * math.tan(_RAKE), -0.024))
R_GRIP_AXIS = Vector((0.0, -math.sin(_RAKE), -math.cos(_RAKE)))
R_GRIP_PALM = Vector((0.85, -0.5, 0.0))


def setup_gloves(arm):
    """Reads the glove grip cylinders into the hand bones' rest frames."""
    for side in ("L", "R"):
        c, a = GLOVE_GRIP[side]
        o = bpy.data.objects.get(f"Limbs_Glove.{side}")
        if o is not None and "grip_center" in o.keys() and "grip_axis" in o.keys():
            c, a = o["grip_center"], o["grip_axis"]
        inv = (arm.matrix_world @ arm.data.bones[f"hand.{side}"].matrix_local).inverted()
        cl = inv @ Vector(c)
        al = (inv.to_3x3() @ Vector(a)).normalized()
        pl = Vector((-cl.x, 0.0, -cl.z))
        pl = (pl - al * pl.dot(al)).normalized()
        HAND_CYL[side] = (cl, al, pl)


def _hand_on_cyl(side, centre, axis, palm):
    """Hand bone matrix that puts the glove's grip cylinder on `centre` along `axis` (little-finger end), with the
    hand (palm) on the `palm` side of it."""
    cl, al, pl = HAND_CYL[side]

    def frame(a, p):
        a = a.normalized()
        p = (p - a * p.dot(a)).normalized()
        return Matrix((a, p, a.cross(p))).transposed()

    r = frame(axis, palm) @ frame(al, pl).transposed()
    m = r.to_4x4()
    m.translation = centre - r @ cl
    return m


HAND_IN_GRIP = Matrix.Identity(4)  # set by build_clips: the right hand's bone matrix in grip (gun) space


def _hand(wrist, fingers, palm):
    """Hand bone matrix (character space) from the wrist, a point the hand points at, and the +x axis direction
    (left hand: the palm side; right hand: the back of the hand, see the A-pose roll in build_zombies)."""
    y = (fingers - wrist).normalized()
    x = (palm - y * palm.dot(y)).normalized()
    z = x.cross(y)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = wrist
    return m


def _gun(pos, pitch=0.0, roll=0.0, yaw=0.0):
    """Gun transform: at `pos`, barrel along +y, pitched (degrees, + = muzzle up), rolled and yawed."""
    r = Euler((math.radians(pitch), math.radians(roll), math.radians(yaw)), "ZXY").to_matrix().to_4x4()
    r.translation = pos
    return r


def _blend(a, b, t):
    """Blends two transforms (location lerp, rotation slerp)."""
    qa, qb = a.to_quaternion(), b.to_quaternion()
    m = qa.slerp(qb, t).to_matrix().to_4x4()
    m.translation = a.translation.lerp(b.translation, t)
    return m


def _smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def _track(ph, keys):
    """Piecewise smooth blend through keys [(phase, matrix)], holding the ends."""
    if ph <= keys[0][0]:
        return keys[0][1]
    for (t0, m0), (t1, m1) in zip(keys, keys[1:]):
        if ph <= t1:
            return _blend(m0, m1, _smooth((ph - t0) / max(t1 - t0, 1e-6)))
    return keys[-1][1]


class Solver:
    """Poses the armature from targets and reads the result back as local eulers (degrees) per bone."""

    def __init__(self, arm, bz):
        self.arm = arm
        self.bz = bz
        self.made = []
        self.t = {}
        self.prev = {}
        self.diag = {}
        bpy.context.view_layer.objects.active = arm
        for side in ("L", "R"):
            for k in ("leg", "knee", "foot"):
                self.t[f"{k}{side}"] = self._empty()
            c = arm.pose.bones[f"shin.{side}"].constraints.new("IK")
            c.name = "anim_ik"
            c.target = self.t[f"leg{side}"]
            c.pole_target = self.t[f"knee{side}"]
            # +90 keeps the thigh and shin unrolled (the knee cap faces the pole); -90 rolls the leg 180 degrees,
            # which twists the trousers and boots round at the hip and the ankle.
            c.pole_angle = math.radians(90)
            c.chain_count = 2
            c = arm.pose.bones[f"foot.{side}"].constraints.new("COPY_ROTATION")
            c.name = "anim_rot"
            c.target = self.t[f"foot{side}"]
        bones = arm.data.bones
        self.foot_rest = {s: bones[f"foot.{s}"].matrix_local.to_3x3() for s in ("L", "R")}
        self.leg_len = {s: bones[f"thigh.{s}"].length + bones[f"shin.{s}"].length for s in ("L", "R")}
        self.arm_len = {s: bones[f"upperarm.{s}"].length + bones[f"forearm.{s}"].length for s in ("L", "R")}
        self.scale = (bones["head"].head_local.z / 1.56) if bones["head"].head_local.z else 1.0
        self.want = {}
        # Rest twist of each hand about its forearm (the arms are solved analytically, see _arm).
        self.rest_twist = {}
        for side in ("L", "R"):
            fa = bones[f"forearm.{side}"].matrix_local.to_3x3()
            ha = bones[f"hand.{side}"].matrix_local.to_3x3()
            self.rest_twist[side] = self._twist(fa.col[0], fa.col[1], ha.col[0])

    @staticmethod
    def _twist(x, f, hx):
        """Angle of hx about the axis f, measured from x (radians)."""
        hp = hx - f * hx.dot(f)
        xp = x - f * x.dot(f)
        if hp.length < 1e-6 or xp.length < 1e-6:
            return 0.0
        hp.normalize()
        xp.normalize()
        return math.atan2(xp.cross(hp).dot(f), xp.dot(hp))

    def _empty(self):
        e = bpy.data.objects.new("anim_target", None)
        bpy.context.collection.objects.link(e)
        self.made.append(e)
        return e

    def _place(self, key, m):
        self.t[key].matrix_world = self.arm.matrix_world @ m

    def _note(self, key, v):
        self.diag[key] = max(self.diag.get(key, 0.0), v)

    def eye(self):
        """Right eye position (character space) for the current pose."""
        bpy.context.view_layer.update()
        hb = self.arm.pose.bones["head"]
        local = self.arm.data.bones["head"].matrix_local.inverted() @ (EYE_R * self.scale)
        return hb.matrix @ local

    def joint(self, bone):
        bpy.context.view_layer.update()
        return self.arm.pose.bones[bone].head.copy()

    def base(self, rots, hips=(0, 0, 0)):
        """Sets the FK part (spine, chest, neck, head, hips rotation) and the hips offset (character space)."""
        arm = self.arm
        for pb in arm.pose.bones:
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = tuple(math.radians(a) for a in rots.get(pb.name, (0, 0, 0)))
            pb.location = (0, 0, 0)
        # hips bone axes: local x = -X, local y = +Z (up), local z = +Y (forward).
        dx, dy, dz = hips
        arm.pose.bones["hips"].location = (-dx, dz, dy)

    def legs(self, feet, knees_up=False):
        """feet: {side: (ankle position, pitch degrees (+ = toe up), toe-out degrees)}. Knees track over the toes.
        An ankle out of reach is pulled up towards the hip (noted as `leg_clamp`) so the knee never snaps straight."""
        for s, (pos, pitch, toe_out) in feet.items():
            sx = -1 if s == "L" else 1
            yaw = -sx * toe_out
            hip = self.joint(f"thigh.{s}")
            d = pos - hip
            reach = self.leg_len[s] * 0.975
            if d.length > reach:
                self._note("leg_clamp", d.length - reach)
                pos = hip + d.normalized() * reach
            self._note("leg_ext", d.length / self.leg_len[s])
            self.want[f"leg{s}"] = pos.copy()
            self._place(f"leg{s}", Matrix.Translation(pos))
            fwd = Matrix.Rotation(math.radians(yaw), 3, "Z") @ Vector((0, 1, 0))
            knee = (hip + pos) * 0.5 + fwd * 0.6 + Vector((sx * 0.06, 0, 0))
            if knees_up:  # lying / sitting: knee caps to the sky
                knee = (hip + pos) * 0.5 + fwd * 0.15 + Vector((sx * 0.08, 0, 0.6))
            self._place(f"knee{s}", Matrix.Translation(knee))
            rot = Matrix.Rotation(math.radians(yaw), 3, "Z") @ Matrix.Rotation(math.radians(pitch), 3, "X") @ self.foot_rest[s]
            self._place(f"foot{s}", rot.to_4x4())

    def fit_gun(self, g, left_fn, slack=0.97):
        """Pulls the gun back towards the right shoulder when the right hand could not reach it."""
        sh = self.joint("upperarm.R")
        w = (g @ HAND_IN_GRIP).translation
        reach = self.arm_len["R"] * slack
        if (w - sh).length > reach:
            g = g.copy()
            g.translation += sh + (w - sh).normalized() * reach - w
        return g

    def _arm(self, side, hand_m, pole, share=0.6):
        """Analytic two-bone arm: the elbow bends about the upper arm's own hinge axis (local x, like the rest pose),
        pointing towards `pole`; `share` of the hand's roll goes into the forearm so the wrist does not candy-wrap."""
        arm = self.arm
        pbs, bones = arm.pose.bones, arm.data.bones
        a, b = bones[f"upperarm.{side}"].length, bones[f"forearm.{side}"].length
        S = self.joint(f"upperarm.{side}")
        W = hand_m.translation.copy()
        d = W - S
        L = d.length
        self._note(f"arm_ext{side}", L / (a + b))
        Lc = min(max(L, abs(a - b) + 1e-4), (a + b) * 0.9995)
        dn = d.normalized()
        pp = Vector(pole) - S
        pp = pp - dn * pp.dot(dn)
        pp = pp.normalized() if pp.length > 1e-6 else Vector((0, 0, -1))
        ca = (a * a + Lc * Lc - b * b) / (2 * a * Lc)
        sa = math.sqrt(max(0.0, 1 - ca * ca))
        E = S + dn * a * ca + pp * a * sa
        Wc = S + dn * Lc
        u = (E - S).normalized()
        f = (Wc - E).normalized()
        x = u.cross(f)
        if x.length < 1e-4:
            x = u.cross(-pp)
        x.normalize()
        up = Matrix((x, u, x.cross(u))).transposed().to_4x4()
        up.translation = S
        H = hand_m.to_3x3()
        tw = self._twist(x, f, H.col[0]) - self.rest_twist[side]
        tw = (tw + math.pi) % math.tau - math.pi
        self._note(f"wrist_twist{side}", abs(math.degrees(tw * (1 - share))))
        xf = Matrix.Rotation(tw * share, 3, f) @ x
        fa = Matrix((xf, f, xf.cross(f))).transposed().to_4x4()
        fa.translation = E
        hm = H.to_4x4()
        hm.translation = Wc
        for bone, m in ((f"upperarm.{side}", up), (f"forearm.{side}", fa), (f"hand.{side}", hm)):
            pbs[bone].matrix = m
            bpy.context.view_layer.update()
            pbs[bone].location = (0, 0, 0)
        self.want[f"arm{side}"] = W

    def arms(self, gun, left, elbows):
        self._arm("R", gun @ HAND_IN_GRIP, elbows[0])
        self._arm("L", left, elbows[1])

    def read(self):
        """Local eulers (degrees) of every posed bone after constraints (continuous with the previous frame), plus
        the hips offset as set."""
        bpy.context.view_layer.update()
        arm = self.arm
        pbs = arm.pose.bones
        for s in ("L", "R"):
            if f"arm{s}" in self.want:
                self._note(f"hand_err{s}", (pbs[f"hand.{s}"].head - self.want[f"arm{s}"]).length)
            if f"leg{s}" in self.want:
                self._note(f"foot_err{s}", (pbs[f"foot.{s}"].head - self.want[f"leg{s}"]).length)
        out = {}
        for pb in pbs:
            if pb.name == "root":
                continue
            m = arm.convert_space(pose_bone=pb, matrix=pb.matrix, from_space="POSE", to_space="LOCAL")
            prev = self.prev.get(pb.name)
            e = m.to_euler("XYZ", prev) if prev is not None else m.to_euler("XYZ")
            self.prev[pb.name] = e
            out[pb.name] = tuple(math.degrees(a) for a in e)
        loc = arm.pose.bones["hips"].location
        return out, (loc[0], loc[1], loc[2])

    def close(self):
        for pb in self.arm.pose.bones:
            for c in list(pb.constraints):
                if c.name.startswith("anim_"):
                    pb.constraints.remove(c)
        for e in self.made:
            bpy.data.objects.remove(e, do_unlink=True)
        for pb in self.arm.pose.bones:
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)
        bpy.context.view_layer.update()


# ---- poses ------------------------------------------------------------------------------------------------------------

def _ready_torso(lean=10, hip_tilt=5, breathe=0.0, yaw=-8.0, head=0.0, cheek=1.0):
    """Upper body for the shouldered ready stance: hips turned a little to the gun side, shoulders squared back to
    the target, leaning into the gun from the hips up, head tilted down and over onto the stock (cheek weld)."""
    return {
        "hips": (hip_tilt, yaw, 0),
        "spine": (lean * 0.55 + breathe, -yaw * 0.45, 0),
        "chest": (lean * 0.45 + breathe * 0.6, -yaw * 0.45, -2 * cheek),
        "neck": (-(lean + hip_tilt) * 0.4 + 6 * cheek + head, 0, 4 * cheek),
        "head": (-(lean + hip_tilt) * 0.3 + 4 * cheek + head, 2 * cheek, 7 * cheek),
    }


def _stance_feet(s, wide=1.0):
    """Ready stance: feet about shoulder width, left foot ~22 cm ahead, right toes turned out (bladed a little)."""
    return {
        "L": (Vector((-0.15 * wide, 0.12, 0.092)) * s, 0.0, 4.0),
        "R": (Vector((0.16 * wide, -0.10, 0.092)) * s, 0.0, 28.0),
    }


def _rot_yz(y, z, deg):
    c, sn = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return y * c - z * sn, y * sn + z * c


def _planted(contact_y, pitch):
    """Ankle (y, z) for a foot whose flat-foot contact point (under the ankle) is at contact_y, rolled by pitch about
    the heel (pitch > 0, toe up) or the toe (pitch < 0, heel up), so the pivot stays put on the ground."""
    py, pz = HEEL if pitch > 0 else TOE
    ry, rz = _rot_yz(py, pz, pitch)
    return contact_y + py - ry, -rz


def _gait(s, ph, period, speed, travel, ahead, lift, width, toe_out, land_pitch, off_pitch):
    """In-place jog / run cycle: each foot lands `ahead` of the hips, stays planted (moving back at exactly `speed`)
    for `travel` metres, rolling heel to toe, then swings forward low. Returns feet and the stance share."""
    stance = travel / speed / period
    feet = {}
    for side, off in (("L", 0.0), ("R", 0.5)):
        p = (ph + off) % 1.0
        sx = -1 if side == "L" else 1
        if p < stance:
            k = p / stance
            cy = ahead - travel * k
            pitch = land_pitch * max(0.0, 1 - k / 0.3) ** 2 + off_pitch * max(0.0, (k - 0.55) / 0.45) ** 1.5
            y, z = _planted(cy, pitch)
        else:
            k = (p - stance) / (1 - stance)
            y0, z0 = _planted(ahead - travel, off_pitch)
            y1, z1 = _planted(ahead, land_pitch)
            # Hermite: leaves backwards with the ground, comes through and settles onto the landing point.
            h00, h10 = 2 * k ** 3 - 3 * k ** 2 + 1, k ** 3 - 2 * k ** 2 + k
            h01, h11 = -2 * k ** 3 + 3 * k ** 2, k ** 3 - k ** 2
            tsw = (1 - stance) * period
            y = h00 * y0 + h10 * (-speed * tsw * 0.25) + h01 * y1 + h11 * (-speed * tsw * 0.12)
            z = z0 + (z1 - z0) * _smooth(k) + lift * math.sin(math.pi * k) ** 1.2 * (1 - 0.35 * k)
            pitch = off_pitch + (land_pitch - off_pitch) * _smooth(k)
            pitch += -10 * math.sin(math.pi * min(1.0, k * 1.4))  # toes trail through the swing
        feet[side] = (Vector((sx * width, y, z)) * s, pitch, toe_out)
    return feet, stance


def _bob(ph, stance, amp):
    """Hips drop through each mid-stance and rise in the flight phase."""
    return amp * (0.5 + 0.5 * math.cos(math.tau * (2 * ph - stance)))


def _rifle_left(g, slide=0.0):
    """Support hand under the MP5SD handguard: the handguard runs through the curled fingers from the index finger
    (front) to the little finger, palm under it and to the left, fingers wrapping up its right side, thumb along its
    left. `slide` moves the hand back along the handguard (metres)."""
    palm = Vector((-0.4, 0.0, -0.9)).normalized()
    centre = Vector((0.0, 0.215 - slide, GUARD_Z)) + palm * (GUARD_R - GLOVE_R)
    rot = g.to_3x3()
    return _hand_on_cyl("L", g @ centre, rot @ Vector((0, -1, 0)), rot @ palm)


def _pistol_left(g):
    """Support hand cupping the shooting hand: palm on the open left side of the grip, fingers wrapping forward over
    the right hand's fingers round the front strap, little finger at the bottom, thumb forward along the frame."""
    rot = g.to_3x3()
    centre = Vector((-0.012, 0.028, -0.036))
    return _hand_on_cyl("L", g @ centre, rot @ R_GRIP_AXIS, rot @ Vector((-1.0, 0.15, -0.1)))


def build_clips(arm, bz, rest_grip_out=None):
    """Builds every clip on `arm` (the Survivor armature). Returns the actions; sets IDLE_GRIP."""
    global IDLE_GRIP, HAND_IN_GRIP
    setup_gloves(arm)
    HAND_IN_GRIP = _hand_on_cyl("R", R_GRIP_C, R_GRIP_AXIS, R_GRIP_PALM)
    print("ANIM hand in grip: wrist", tuple(round(v, 3) for v in HAND_IN_GRIP.translation),
          "hand dir", tuple(round(v, 2) for v in HAND_IN_GRIP.col[1][:3]))
    sol = Solver(arm, bz)
    s = sol.scale
    actions = []

    def key(name, seconds, fn, n=None):
        frames = n or round(seconds * FPS)
        keys = []
        # bz.keyframes leaves each clip as an NLA strip; evaluated while solving, the strips would write the previous
        # clip's first frame over the pose being solved (the first frame of every clip came out wrong).
        if arm.animation_data:
            arm.animation_data.action = None
            arm.animation_data.use_nla = False
        sol.diag = {}
        sol.prev = {}
        for i in range(frames + 1):
            rots, off = fn(i / frames)
            keys.append((i + 1, rots, off))
        actions.append(bz.keyframes(arm, name, keys))
        print("ANIM", name, " ".join(f"{k}={v:.3f}" for k, v in sorted(sol.diag.items())))

    def hips_off(drop, fwd=0.0, side=0.0):
        return (side * s, fwd * s, -drop * s)

    def rifle_at_eye(torso, hips, pitch=0.0, extra=Vector((0, 0, 0))):
        """Gun with the rear sight on the right eye line (EYE_RELIEF in front of it), for the posed torso."""
        sol.base(torso, hips=hips)
        pos = sol.eye() + Vector((0.0, EYE_RELIEF, 0.0)) - MP5_SIGHT + extra * s
        return _gun(pos, pitch=pitch)

    def pistol_at_eye(torso, hips, ahead=0.42, pitch=0.0, extra=Vector((0, 0, 0))):
        sol.base(torso, hips=hips)
        pos = sol.eye() + Vector((-0.03, ahead * s, -0.01)) - PISTOL_SIGHT + extra * s
        return _gun(pos, pitch=pitch)

    def pose(torso, hips, feet, g, left_fn, elbows):
        sol.base(torso, hips=hips)
        g = sol.fit_gun(g, left_fn)
        sol.legs(feet)
        sol.arms(g, left_fn(g), elbows)
        return sol.read()

    RIFLE_ELBOWS = ((0.3, 0.02, 1.08), (-0.2, 0.3, 0.92))
    PISTOL_ELBOWS = ((0.4, 0.15, 1.0), (-0.4, 0.15, 1.0))

    # Rifle ready ----------------------------------------------------------------------------------------------------
    def idle_hips(b=0.0):
        return hips_off(0.045 + 0.003 * b, fwd=0.01)

    def idle_rifle(ph):
        b = math.sin(ph * math.tau)
        torso = _ready_torso(breathe=0.7 * b)
        g = rifle_at_eye(torso, idle_hips(b), pitch=0.5 * b)
        return pose(torso, idle_hips(b), _stance_feet(s), g, _rifle_left, RIFLE_ELBOWS)

    # The idle frame defines where the game hangs the gun: record it (first frame, b = 0).
    torso0 = _ready_torso()
    IDLE_GRIP = sol.fit_gun(rifle_at_eye(torso0, idle_hips()), _rifle_left).translation.copy()

    def walk_rifle(ph):
        feet, st = _gait(s, ph, WALK_T, WALK_SPEED, travel=0.62, ahead=0.25, lift=0.11, width=0.11, toe_out=8,
                         land_pitch=10, off_pitch=-24)
        hips = hips_off(0.075 + _bob(ph, st, 0.018), fwd=0.02)
        sway = math.sin(ph * math.tau)
        torso = _ready_torso(lean=12, breathe=0.5 * math.cos(ph * math.tau * 2), yaw=-8 + 3 * sway)
        torso["hips"] = (torso["hips"][0], torso["hips"][1], 3 * sway)
        g = rifle_at_eye(torso, hips, pitch=0.6 * math.cos(ph * math.tau * 2))
        return pose(torso, hips, feet, g, _rifle_left, RIFLE_ELBOWS)

    def run_rifle(ph):
        feet, st = _gait(s, ph, RUN_T, RUN_SPEED, travel=0.74, ahead=0.3, lift=0.24, width=0.1, toe_out=6,
                         land_pitch=8, off_pitch=-32)
        hips = hips_off(0.06 + _bob(ph, st, 0.035), fwd=0.04)
        sway = math.sin(ph * math.tau)
        torso = _ready_torso(lean=18, hip_tilt=8, yaw=-6 + 7 * sway, head=-8, cheek=0.0)
        torso["neck"] = (-4, 0, 0)
        torso["head"] = (-6, 0, 0)
        torso["hips"] = (8, -6 + 7 * sway, 4 * sway)
        # Low ready: stock still in the shoulder, muzzle down ~30 degrees, gun lower and tucked in.
        g = rifle_at_eye(torso, hips, pitch=-30, extra=Vector((0.03, -0.04, -0.14)))
        return pose(torso, hips, feet, g, _rifle_left, ((0.32, -0.02, 1.0), (-0.24, 0.2, 0.88)))

    key("idle", 3.0, idle_rifle, n=12)
    key("walk", WALK_T, walk_rifle)
    key("run", RUN_T, run_rifle)

    def reload_rifle(ph):
        # Gun comes down off the eye and cants; left hand strips the mag, fetches a new one from the vest, seats it,
        # slaps the cocking handle and goes back to the handguard; the gun comes back up.
        dip = _smooth(ph / 0.12) * (1 - _smooth((ph - 0.84) / 0.14))
        torso = _ready_torso(head=7 * dip, cheek=1 - dip)
        hips = idle_hips()
        g = rifle_at_eye(torso, hips, pitch=-12 * dip, extra=Vector((-0.02, -0.08, -0.1)) * dip)
        g = g @ Matrix.Rotation(math.radians(-24 * dip), 4, "Y")
        g = sol.fit_gun(g, _rifle_left)

        def left(gm):
            guard = _rifle_left(gm)
            mag = _hand(gm @ Vector((-0.05, 0.06, -0.09)), gm @ Vector((0.0, 0.14, -0.05)), gm.to_3x3() @ Vector((1, 0, -0.1)))
            mag_out = _hand(gm @ Vector((-0.06, 0.04, -0.26)), gm @ Vector((-0.01, 0.12, -0.21)), gm.to_3x3() @ Vector((1, 0, -0.1)))
            pouch = _hand(Vector((-0.06, 0.12, 1.12)) * s, Vector((0.02, 0.18, 1.06)) * s, Vector((1, -0.2, 0)))
            handle = _hand(gm @ Vector((-0.07, 0.2, 0.06)), gm @ Vector((-0.04, 0.3, 0.11)), gm.to_3x3() @ Vector((1, 0, 0)))
            return _track(ph, [(0.1, guard), (0.2, mag), (0.3, mag_out), (0.42, pouch), (0.56, mag_out), (0.64, mag),
                               (0.7, handle), (0.76, handle @ Matrix.Translation((0, 0.04, 0))), (0.86, guard)])

        return pose(torso, hips, _stance_feet(s), g, left, RIFLE_ELBOWS)

    key("reload", 1.5, reload_rifle)

    # Pistol: isosceles, arms extended ------------------------------------------------------------------------------
    def pistol_torso(b=0.0, lean=9, head=-2):
        return {**_ready_torso(lean=lean, hip_tilt=4, breathe=b, yaw=0, head=head, cheek=0.0)}

    def pistol_feet():
        return {"L": (Vector((-0.15, 0.07, 0.092)) * s, 0.0, 8.0), "R": (Vector((0.16, -0.06, 0.092)) * s, 0.0, 14.0)}

    def idle_pistol(ph):
        b = math.sin(ph * math.tau)
        hips = hips_off(0.04 + 0.003 * b, fwd=0.01)
        torso = pistol_torso(0.7 * b)
        g = pistol_at_eye(torso, hips, pitch=0.5 * b)
        return pose(torso, hips, pistol_feet(), g, _pistol_left, PISTOL_ELBOWS)

    def walk_pistol(ph):
        feet, st = _gait(s, ph, WALK_T, WALK_SPEED, travel=0.62, ahead=0.25, lift=0.11, width=0.11, toe_out=8,
                         land_pitch=10, off_pitch=-24)
        hips = hips_off(0.075 + _bob(ph, st, 0.018), fwd=0.02)
        sway = math.sin(ph * math.tau)
        torso = pistol_torso(0.4 * math.cos(ph * math.tau * 2), lean=11)
        torso["hips"] = (torso["hips"][0], 4 * sway, 3 * sway)
        torso["spine"] = (torso["spine"][0], -2 * sway, 0)
        torso["chest"] = (torso["chest"][0], -2 * sway, 0)
        g = pistol_at_eye(torso, hips, pitch=0.5 * math.cos(ph * math.tau * 2))
        return pose(torso, hips, feet, g, _pistol_left, PISTOL_ELBOWS)

    def run_pistol(ph):
        feet, st = _gait(s, ph, RUN_T, RUN_SPEED, travel=0.74, ahead=0.3, lift=0.24, width=0.1, toe_out=6,
                         land_pitch=8, off_pitch=-32)
        hips = hips_off(0.06 + _bob(ph, st, 0.035), fwd=0.04)
        sway = math.sin(ph * math.tau)
        torso = pistol_torso(lean=18, head=-6)
        torso["hips"] = (8, 6 * sway, 4 * sway)
        torso["spine"] = (torso["spine"][0], -3 * sway, 0)
        torso["chest"] = (torso["chest"][0], -3 * sway, 0)
        # Compressed ready: gun pulled in to the chest, muzzle forward and down a little.
        g = pistol_at_eye(torso, hips, ahead=0.2, pitch=-12, extra=Vector((0.02, 0.0, -0.3)))
        return pose(torso, hips, feet, g, _pistol_left, ((0.34, -0.05, 1.0), (-0.34, -0.02, 1.0)))

    def reload_pistol(ph):
        dip = _smooth(ph / 0.12) * (1 - _smooth((ph - 0.84) / 0.14))
        hips = hips_off(0.04, fwd=0.01)
        torso = pistol_torso(head=-2 + 8 * dip)
        g = pistol_at_eye(torso, hips, pitch=10 * dip, extra=Vector((0.0, -0.18, -0.22)) * dip)
        g = g @ Matrix.Rotation(math.radians(-28 * dip), 4, "Y")
        g = sol.fit_gun(g, _pistol_left)

        def left(gm):
            cup = _pistol_left(gm)
            mag = _hand(gm @ Vector((-0.05, -0.02, -0.16)), gm @ Vector((0.0, 0.03, -0.1)), gm.to_3x3() @ Vector((1, 0, 0)))
            belt = _hand(Vector((-0.12, 0.08, 0.98)) * s, Vector((-0.06, 0.16, 0.94)) * s, Vector((1, -0.2, 0.2)))
            rack = _hand(gm @ Vector((-0.06, -0.04, 0.12)), gm @ Vector((0.03, -0.0, 0.11)), gm.to_3x3() @ Vector((0, 0, -1)))
            return _track(ph, [(0.14, cup), (0.26, mag), (0.42, belt), (0.58, mag), (0.68, rack),
                               (0.75, rack @ Matrix.Translation((0, 0, 0.05))), (0.86, cup)])

        return pose(torso, hips, pistol_feet(), g, left, PISTOL_ELBOWS)

    key("idle_pistol", 3.0, idle_pistol, n=12)
    key("walk_pistol", WALK_T, walk_pistol)
    key("run_pistol", RUN_T, run_pistol)
    key("reload_pistol", 1.3, reload_pistol)

    # Downed: sat back on the ground, propped on the left elbow (forearm flat on the floor), left leg out straight,
    # right knee up with the boot planted, pistol held out one-handed towards the feet. Solved like the rest.
    def downed(ph):
        b = math.sin(ph * math.tau)
        torso = {
            "hips": (-40, 4, 0), "spine": (-15 + 1.2 * b, 0, 0), "chest": (-10 + 1.5 * b, -4, 0),
            "neck": (36, 0, 0), "head": (24 - 1.5 * b, 4, 0),
        }
        hips = (0.0, -0.22 * s, -0.72 * s)
        sol.base(torso, hips=hips)
        hy = -0.22 * s
        ly, lz = _planted(0.0, 62)
        feet = {
            "L": (Vector((-0.17 * s, hy + 0.86 * s + ly, lz)), 62.0, 14.0),
            "R": (Vector((0.16 * s, hy + 0.46 * s, 0.092 * s)), 0.0, 10.0),
        }
        sol.legs(feet, knees_up=True)
        shR = sol.joint("upperarm.R")
        shL = sol.joint("upperarm.L")
        g = _gun(shR + Vector((-0.12, 0.44, 0.02 + 0.006 * b)) * s, pitch=-6 + 0.6 * b)
        g = sol.fit_gun(g, None)
        # Elbow on the floor under the shoulder, forearm flat on the floor pointing forward and in, palm down.
        elbow = Vector((shL.x - 0.04 * s, shL.y - 0.03 * s, 0.08 * s))
        wrist = elbow + Vector((0.08, 0.25, 0.015)) * s
        left = _hand(wrist, wrist + Vector((0.2, 0.9, 0.0)), Vector((0, 0, -1)))
        sol.arms(g, left, ((0.34, -0.05, 0.6), (shL.x - 0.3, shL.y - 0.25, -0.4)))
        return sol.read()

    key("downed", 2.0, downed, n=20)

    sol.close()
    arm.animation_data.use_nla = True

    if rest_grip_out is not None:
        rest_grip_out[:] = list(IDLE_GRIP)
    return actions


def models_ts_grip():
    """IDLE_GRIP converted to the y-up space models.ts uses (x, z, -y)."""
    return (round(IDLE_GRIP.x, 4), round(IDLE_GRIP.z, 4), round(-IDLE_GRIP.y, 4))
