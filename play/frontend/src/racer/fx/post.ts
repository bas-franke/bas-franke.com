// Post-processing: the final image. A lean custom chain instead of EffectComposer:
//   1. scene -> one linear HDR target (HalfFloat, MSAA on medium/high; no tone mapping, three skips it for targets)
//   2. bloom: soft-threshold prefilter at 1/2 res (1/4 on low), dual-filter down/up chain, wide and soft
//   3. light shafts towards the sun at 1/4 res (not on low)
//   4. composite to the canvas: zoom motion blur towards the vanishing point (stronger with speed and boost, none in the
//      centre, the player's pod kept sharp), chromatic aberration on boost, bloom, sun glow/veil, warm grade, ACES (the
//      only tone mapping), violet-lifted shadows, vignette, sRGB.
// `?nopost` in the labs bypasses it. The returned object also has `bench(n)` (ms per post chain, GPU-synced) for labs.

import * as THREE from 'three';
import type { FxView, PostFx, Quality, WorldContext } from '../world/types';
import { compositeFrag, downFrag, fullscreenVert, prefilterFrag, shaftsFrag, sunVisFrag, upFrag } from './postShaders';

interface QualitySpec {
  samples: number;
  /** Bloom base resolution divisor. */
  bloomDiv: number;
  levels: number;
  taps: number;
  shafts: boolean;
}

const SPECS: Record<Quality, QualitySpec> = {
  high: { samples: 4, bloomDiv: 2, levels: 5, taps: 8, shafts: true },
  medium: { samples: 2, bloomDiv: 2, levels: 4, taps: 8, shafts: true },
  low: { samples: 0, bloomDiv: 4, levels: 3, taps: 6, shafts: false },
};

/** Upper limit of the blur, as a fraction of the distance to the focus point. */
const MAX_BLUR = 0.11;

export interface PostFxDebug extends PostFx {
  /** Render the post chain (not the scene) `n` times and return GPU-synced milliseconds per run. */
  bench(n: number): number;
  /** Override what the composite gets from the view (labs): speed01 / boost. */
  params: { speedOverride: number | null; boostOverride: number | null };
  /** The composite pass's uniforms, for tuning in the lab. */
  uniforms: Record<string, THREE.IUniform>;
}

export function createPostFx(ctx: WorldContext): PostFxDebug {
  const { renderer, scene, camera, theme } = ctx;
  const spec = SPECS[ctx.quality] ?? SPECS.high;

  const hdr = (w: number, h: number, samples = 0, depth = false) => {
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: depth,
      stencilBuffer: false,
      samples,
    });
    t.texture.generateMipmaps = false;
    return t;
  };

  const sceneRT = hdr(4, 4, spec.samples, true);
  const bloomRTs: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < spec.levels; i++) bloomRTs.push(hdr(4, 4));
  const shaftRT = spec.shafts ? hdr(4, 4) : null;
  const sunVisRT = hdr(1, 1);

  // One full-screen triangle drawn with any of the pass materials.
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const pass = (frag: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}) =>
    new THREE.ShaderMaterial({ vertexShader: fullscreenVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...opts });

  const prefilter = pass(prefilterFrag, {
    tSrc: { value: sceneRT.texture },
    texel: { value: new THREE.Vector2() },
    // Linear HDR: the sky sits around 0.6-1.2, so only sun, glows and hot highlights pass.
    threshold: { value: new THREE.Vector3(1.15, 0.6, 12) },
  });
  const down = pass(downFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });
  const up = pass(upFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, weight: { value: 1 } }, {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    transparent: true,
  });
  const shafts = pass(shaftsFrag, {
    tSrc: { value: sceneRT.texture },
    sunUv: { value: new THREE.Vector2() },
    aspect: { value: 1 },
    threshold: { value: 0.7 },
  });

  const sunVis = pass(sunVisFrag, {
    tSrc: { value: sceneRT.texture },
    sunUv: { value: new THREE.Vector2() },
    rate: { value: 0.2 },
  }, { transparent: true, blending: THREE.NormalBlending });

  const sunColor = new THREE.Color(theme.sunColor);
  const hazeColor = new THREE.Color(theme.haze);
  const composite = pass(compositeFrag, {
    tScene: { value: sceneRT.texture },
    tBloom: { value: bloomRTs[0].texture },
    tShafts: { value: shaftRT ? shaftRT.texture : bloomRTs[0].texture },
    tSunVis: { value: sunVisRT.texture },
    res: { value: new THREE.Vector2(1, 1) },
    aspect: { value: 1 },
    focus: { value: new THREE.Vector2(0.5, 0.56) },
    blur: { value: 0 },
    ca: { value: 0 },
    podMask: { value: new THREE.Vector4(0.5, 0.3, 0.001, 0.001) },
    bloomStrength: { value: 0.32 },
    sunUv: { value: new THREE.Vector2(0.8, 0.8) },
    sunOn: { value: 0 },
    sunColor: { value: sunColor },
    shaftStrength: { value: 0.55 },
    veilStrength: { value: 0.06 },
    hazeColor: { value: hazeColor },
    saturation: { value: 1.14 },
    whiteBalance: { value: new THREE.Vector3(1.05, 1.0, 0.93) },
    lift: { value: new THREE.Vector3(0.022, 0.012, 0.04) },
    contrast: { value: 1.06 },
    hueKeep: { value: 0.55 },
    vignette: { value: 0.22 },
    noiseSeed: { value: 0 },
  });
  // toneMapped: the renderer injects its toneMapping() (ACES + exposure) since this pass draws to the canvas.
  composite.toneMapped = true;
  composite.defines = { TAPS: spec.taps, SHAFTS: spec.shafts ? 1 : 0 };

  let width = 1;
  let height = 1;

  const setSize = (w: number, h: number, pr: number) => {
    width = Math.max(1, Math.floor(w * pr));
    height = Math.max(1, Math.floor(h * pr));
    sceneRT.setSize(width, height);
    let bw = Math.max(1, Math.round(width / spec.bloomDiv));
    let bh = Math.max(1, Math.round(height / spec.bloomDiv));
    for (const rt of bloomRTs) {
      rt.setSize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    shaftRT?.setSize(Math.max(1, Math.round(width / 4)), Math.max(1, Math.round(height / 4)));
    composite.uniforms.res.value.set(width, height);
    composite.uniforms.aspect.value = width / height;
    shafts.uniforms.aspect.value = width / height;
    prefilter.uniforms.texel.value.set(1 / width, 1 / height);
  };
  setSize(renderer.domElement.width || 1, renderer.domElement.height || 1, 1);

  const draw = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  };

  const runChain = () => {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    draw(prefilter, bloomRTs[0]);
    for (let i = 1; i < bloomRTs.length; i++) {
      const src = bloomRTs[i - 1];
      down.uniforms.tSrc.value = src.texture;
      down.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      draw(down, bloomRTs[i]);
    }
    for (let i = bloomRTs.length - 1; i > 0; i--) {
      const src = bloomRTs[i];
      up.uniforms.tSrc.value = src.texture;
      up.uniforms.texel.value.set(0.5 / src.width, 0.5 / src.height);
      // Lower (wider) levels weigh a bit more: the reference's bloom is a broad soft haze.
      up.uniforms.weight.value = 1.15;
      draw(up, bloomRTs[i - 1]);
    }
    if (composite.uniforms.sunOn.value > 0) {
      draw(sunVis, sunVisRT);
      if (shaftRT) draw(shafts, shaftRT);
    }
    draw(composite, null);
    renderer.autoClear = autoClear;
  };

  // --- Sun direction: from the scene's directional light (the sky module owns it), else from the theme.
  const sunDir = new THREE.Vector3(Math.sin(theme.sunAzimuth), Math.tan(theme.sunElevation), Math.cos(theme.sunAzimuth)).normalize();
  let sunLight: THREE.DirectionalLight | null = null;
  let lightSearch = 0;
  const findSun = () => {
    let best: THREE.DirectionalLight | null = null;
    scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (l.isDirectionalLight && (!best || l.intensity > best.intensity)) best = l;
    });
    sunLight = best;
  };

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const smoothFocus = new THREE.Vector2(0.5, 0.56);
  let speedFx = 0;
  let boostFx = 0;
  let frame = 0;
  const params: PostFxDebug['params'] = { speedOverride: null, boostOverride: null };

  const project = (world: THREE.Vector3, out: THREE.Vector3) => out.copy(world).project(camera);

  const updateUniforms = (view: FxView) => {
    const u = composite.uniforms;
    const dt = Math.min(0.1, view.dt);
    frame++;
    const seed = (frame % 64) * 0.618034;
    u.noiseSeed.value = seed;

    // Speed and boost, smoothed so the blur breathes rather than pops.
    const player = view.pods.find((p) => p.isPlayer);
    const boosting = view.boosting || (player?.surge ?? 0) > 0;
    const speedT = params.speedOverride ?? view.speed01;
    const boostT = params.boostOverride ?? (boosting ? 1 : 0);
    speedFx += (speedT - speedFx) * (1 - Math.exp(-dt * 4));
    boostFx += (boostT - boostFx) * (1 - Math.exp(-dt * (boostT > boostFx ? 6 : 2.5)));
    const s = THREE.MathUtils.smoothstep(speedFx, 0.3, 1.05);
    u.blur.value = MAX_BLUR * Math.min(1.4, s * 0.7 + boostFx * 0.45);
    u.ca.value = 0.012 * boostFx;

    // Focus: where the road vanishes, i.e. far ahead of the player, clamped to the middle of the frame.
    camera.getWorldDirection(camDir);
    tmp2.copy(view.playerForward);
    tmp2.y = 0;
    if (tmp2.lengthSq() < 1e-4) tmp2.copy(camDir);
    tmp.copy(camera.position).addScaledVector(tmp2.normalize(), 400);
    project(tmp, tmp);
    let fx = 0.5;
    let fy = 0.56;
    if (tmp.z < 1) {
      fx = THREE.MathUtils.clamp(tmp.x * 0.5 + 0.5, 0.3, 0.7);
      fy = THREE.MathUtils.clamp(tmp.y * 0.5 + 0.5 + 0.02, 0.45, 0.72);
    }
    const kf = 1 - Math.exp(-dt * 8);
    smoothFocus.x += (fx - smoothFocus.x) * kf;
    smoothFocus.y += (fy - smoothFocus.y) * kf;
    u.focus.value.copy(smoothFocus);

    // Keep the player's pod sharp: an ellipse around its projection, sized by its distance.
    if (player) {
      const pos = player.visual.object.getWorldPosition(tmp);
      const dist = Math.max(2, pos.distanceTo(camera.position));
      project(pos, tmp);
      const k = 0.5 / (dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      u.podMask.value.set(tmp.x * 0.5 + 0.5, tmp.y * 0.5 + 0.5 - 0.6 * k, (5.2 * k) / camera.aspect, 3.2 * k);
    } else {
      u.podMask.value.set(0.5, -1, 0.001, 0.001);
    }

    // Sun on screen.
    if (!sunLight && lightSearch-- <= 0) {
      findSun();
      lightSearch = 60;
    }
    if (sunLight) {
      const l = sunLight as THREE.DirectionalLight;
      l.getWorldPosition(tmp);
      l.target.getWorldPosition(tmp2);
      tmp.sub(tmp2);
      if (tmp.lengthSq() > 1e-6) sunDir.copy(tmp).normalize();
    }
    const facing = sunDir.dot(camDir);
    tmp.copy(camera.position).addScaledVector(sunDir, 1000);
    project(tmp, tmp);
    const sx = tmp.x * 0.5 + 0.5;
    const sy = tmp.y * 0.5 + 0.5;
    // Fade out as the sun leaves the frame (a little margin so the veil lingers at the edge).
    const out = Math.max(0, Math.max(-sx, sx - 1, -sy, sy - 1));
    const on = facing > 0 ? THREE.MathUtils.clamp(1 - out / 0.35, 0, 1) * THREE.MathUtils.smoothstep(facing, 0, 0.3) : 0;
    u.sunOn.value = on;
    u.sunUv.value.set(sx, sy);
    shafts.uniforms.sunUv.value.set(sx, sy);
    sunVis.uniforms.sunUv.value.set(sx, sy);
    sunVis.uniforms.rate.value = 1 - Math.exp(-dt * 10);
  };

  return {
    params,
    uniforms: composite.uniforms,
    render(view) {
      updateUniforms(view);
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      runChain();
    },
    setSize,
    bench(n) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) runChain();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (performance.now() - t0) / n;
    },
    dispose() {
      sceneRT.dispose();
      for (const rt of bloomRTs) rt.dispose();
      shaftRT?.dispose();
      sunVisRT.dispose();
      tri.dispose();
      for (const m of [prefilter, down, up, shafts, sunVis, composite]) m.dispose();
    },
  };
}
