// A small bloom for the neon maps: the scene is drawn into a linear half-float target (MSAA, so the ink lines stay
// clean), its bright parts are thresholded and blurred down and back up a mip chain (dual filter), and the result is
// added back before ACES tone mapping (then a saturation lift, since ACES greys the neon out). Neon strips, the furnace core, the low sun and billboards get a soft halo.

import * as THREE from 'three';

const LEVELS = 5;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

export interface Bloom {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}

export function createBloom(renderer: THREE.WebGLRenderer, opts: { threshold?: number; strength?: number; saturation?: number } = {}): Bloom {
  const half = { type: THREE.HalfFloatType, depthBuffer: false } as const;
  const scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const mips = Array.from({ length: LEVELS }, () => new THREE.WebGLRenderTarget(1, 1, half));
  const size = new THREE.Vector2();

  // One big triangle covering the screen.
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri);
  quad.frustumCulled = false;
  const cam = new THREE.OrthographicCamera();

  const down = new THREE.ShaderMaterial({
    uniforms: { src: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: opts.threshold ?? 0.85 }, first: { value: 1 } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D src;
      uniform vec2 texel;
      uniform float threshold;
      uniform float first;
      varying vec2 vUv;
      vec3 pick(vec2 uv) {
        vec3 c = texture2D(src, uv).rgb;
        if (first > 0.5) {
          // Soft knee: only what is brighter than the threshold blooms.
          float l = max(c.r, max(c.g, c.b));
          float k = clamp(l - threshold + 0.25, 0.0, 0.5);
          float w = max(k * k * 2.0, l - threshold) / max(l, 1e-4);
          c *= w;
        }
        return c;
      }
      void main() {
        vec3 c = pick(vUv) * 4.0;
        c += pick(vUv + texel * vec2(-1.0, -1.0));
        c += pick(vUv + texel * vec2(1.0, -1.0));
        c += pick(vUv + texel * vec2(-1.0, 1.0));
        c += pick(vUv + texel * vec2(1.0, 1.0));
        gl_FragColor = vec4(c / 8.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const up = new THREE.ShaderMaterial({
    uniforms: { src: { value: null }, texel: { value: new THREE.Vector2() } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D src;
      uniform vec2 texel;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(src, vUv + texel * vec2(-2.0, 0.0)).rgb;
        c += texture2D(src, vUv + texel * vec2(2.0, 0.0)).rgb;
        c += texture2D(src, vUv + texel * vec2(0.0, -2.0)).rgb;
        c += texture2D(src, vUv + texel * vec2(0.0, 2.0)).rgb;
        c += texture2D(src, vUv + texel * vec2(-1.0, -1.0)).rgb * 2.0;
        c += texture2D(src, vUv + texel * vec2(1.0, -1.0)).rgb * 2.0;
        c += texture2D(src, vUv + texel * vec2(-1.0, 1.0)).rgb * 2.0;
        c += texture2D(src, vUv + texel * vec2(1.0, 1.0)).rgb * 2.0;
        gl_FragColor = vec4(c / 12.0, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const combine = new THREE.ShaderMaterial({
    uniforms: { src: { value: scene.texture }, bloom: { value: mips[0].texture }, strength: { value: opts.strength ?? 0.7 }, saturation: { value: opts.saturation ?? 1.25 } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D src;
      uniform sampler2D bloom;
      uniform float strength;
      uniform float saturation;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(src, vUv).rgb + texture2D(bloom, vUv).rgb * strength;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        // ACES greys the neon out; push the colour back (the comic look wants it loud).
        float grey = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor.rgb = max(mix(vec3(grey), gl_FragColor.rgb, saturation), 0.0);
        #include <colorspace_fragment>
      }`,
    toneMapped: true,
    depthTest: false,
    depthWrite: false,
  });

  const pass = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quad, cam);
  };

  return {
    render(world, camera) {
      renderer.getDrawingBufferSize(size);
      if (scene.width !== size.x || scene.height !== size.y) {
        scene.setSize(size.x, size.y);
        mips.forEach((m, i) => m.setSize(Math.max(1, size.x >> (i + 1)), Math.max(1, size.y >> (i + 1))));
      }
      const prev = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      renderer.setRenderTarget(scene);
      renderer.render(world, camera);
      renderer.autoClear = false;
      // Down the chain, thresholding on the first step.
      let src = scene.texture;
      mips.forEach((m, i) => {
        down.uniforms.src.value = src;
        down.uniforms.first.value = i === 0 ? 1 : 0;
        down.uniforms.texel.value.set(1 / (i === 0 ? scene.width : mips[i - 1].width), 1 / (i === 0 ? scene.height : mips[i - 1].height));
        renderer.setRenderTarget(m);
        renderer.clear();
        pass(down, m);
        src = m.texture;
      });
      // Back up, adding each blurred level onto the one above it.
      for (let i = LEVELS - 1; i > 0; i--) {
        up.uniforms.src.value = mips[i].texture;
        up.uniforms.texel.value.set(0.5 / mips[i].width, 0.5 / mips[i].height);
        pass(up, mips[i - 1]);
      }
      renderer.autoClear = autoClear;
      pass(combine, prev);
    },
    dispose() {
      scene.dispose();
      for (const m of mips) m.dispose();
      tri.dispose();
      down.dispose();
      up.dispose();
      combine.dispose();
    },
  };
}
