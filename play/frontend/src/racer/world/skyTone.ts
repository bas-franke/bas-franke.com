// Inverse tone mapping for sky colours: the theme names the colours it wants ON SCREEN, but everything passes
// through the renderer's ACES filmic curve, which darkens and bleaches. `onScreen` returns the linear scene colour
// that three's ACESFilmicToneMapping maps to the requested colour, so the sky, haze and fog land on the theme's hex
// values (and a fully fogged mountain exactly matches the sky behind it).

import * as THREE from 'three';

// three's ACES fit (tonemapping_pars_fragment), as row-major matrices.
const IN = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777);
const OUT = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
const IN_INV = IN.clone().invert();
const OUT_INV = OUT.clone().invert();

/** Inverse of RRTAndODTFit for one channel: the positive root of the quadratic. */
function fitInverse(y: number): number {
  y = Math.min(Math.max(y, 0), 0.985);
  const a = 1 - 0.983729 * y;
  const b = 0.0245786 - 0.432951 * y;
  const c = -(0.000090537 + 0.238081 * y);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

const v = new THREE.Vector3();

/**
 * Linear scene colour that tone maps to `screen` (a linear colour, e.g. new THREE.Color('#hex')). Pale colours
 * need large HDR values; `cap` limits the brightest channel (scaling the whole colour down, so it shows a little
 * darker) to keep the bloom pass, which starts to pick up values around 0.6-1.2, from flaring the whole sky.
 */
export function onScreen(screen: THREE.Color, renderer: THREE.WebGLRenderer, cap = 1.2, out = new THREE.Color()): THREE.Color {
  if (renderer.toneMapping !== THREE.ACESFilmicToneMapping) out.copy(screen).multiplyScalar(1 / renderer.toneMappingExposure);
  else {
    v.set(screen.r, screen.g, screen.b).applyMatrix3(OUT_INV);
    v.set(fitInverse(v.x), fitInverse(v.y), fitInverse(v.z)).applyMatrix3(IN_INV);
    const k = 0.6 / renderer.toneMappingExposure;
    out.setRGB(Math.max(0, v.x) * k, Math.max(0, v.y) * k, Math.max(0, v.z) * k);
  }
  const m = Math.max(out.r, out.g, out.b);
  return m > cap ? out.multiplyScalar(cap / m) : out;
}

/** Convenience: hex (sRGB) to the scene colour that shows as that hex. */
export function hexOnScreen(hex: string | THREE.Color, renderer: THREE.WebGLRenderer, cap?: number): THREE.Color {
  return onScreen(new THREE.Color(hex), renderer, cap);
}
