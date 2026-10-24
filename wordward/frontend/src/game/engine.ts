// Thin wrapper around a three.js renderer: scene, camera, resize handling and a frame loop with a capped dt.
// A small governor watches frame times and lowers the render resolution when a machine cannot keep up (and raises
// it again when there is headroom), so the game stays playable everywhere.
//
// Colour: sRGB output, a warm grade (white balance, saturation, warm shadow lift) folded into ACES filmic tone
// mapping for the dusk library. Glow comes from additive sprites
// (toon.ts `glowSprite`/`glowBatch`), not a bloom pass. `stats` exposes frame cost and draw calls for the
// compare/perf tools (dev builds also publish `window.__engine`).
//
// Quality tier: `detectQuality()` guesses 'high' or 'low' once per page from the device (phones, tablets, few CPU
// cores or little memory → 'low'); `?quality=low|high` in the URL or localStorage `ww.quality` overrides it. Modules
// that build heavy content read it at build time (world.ts: floor texture size, bump map, the candle's point light),
// and can follow `engine.quality` / `engine.onQuality(cb)`: the engine drops a 'high' session to 'low' for good when
// the governor has to go below pixel ratio 1 to keep up. Only switch cheap things on a change (visibility, counts),
// never the light set or material defines: those recompile every shader, a long hitch on a phone.

import * as THREE from 'three';

/** Pixel ratios the governor steps through, best first. */
const QUALITY_STEPS = [1.5, 1.25, 1, 0.85, 0.7];
/** Highest pixel ratio a 'low' device starts at (the governor may still climb to QUALITY_STEPS[0]). */
const LOW_START_RATIO = 1.25;
/** A 'high' session turns 'low' once the governor has to go this low. */
const LOW_BELOW_RATIO = 0.85;

// ---- colour grade -------------------------------------------------------------------------------------------------
// A warm "golden lamp light at dusk" grade folded into tone mapping (three's CustomToneMapping slot), so it costs a
// few ALU ops in every shader that already tone maps and no extra pass. Linear values in, then ACES filmic.

/** White balance: warm the whole frame like tungsten/candle light. */
const GRADE_WB = [1.05, 1.0, 0.93];
/** Saturation before the curve (1 = unchanged): ACES desaturates brights, this gives wood and books back a bit. */
const GRADE_SAT = 1.06;
/** Added to the darkest tones only: shadows lift to a warm umber instead of crushing to black. */
const GRADE_LIFT = [0.014, 0.008, 0.002];
const GRADE_EXPOSURE = 1.1;

const g4 = (n: number) => n.toFixed(4);
const v3 = (v: number[]) => `vec3( ${v.map(g4).join(', ')} )`;
const CUSTOM_STUB = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
if (THREE.ShaderChunk.tonemapping_pars_fragment.includes(CUSTOM_STUB)) {
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    CUSTOM_STUB,
    /* glsl */ `vec3 CustomToneMapping( vec3 color ) {
	color *= ${v3(GRADE_WB)};
	float gradeL = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	color = max( mix( vec3( gradeL ), color, ${g4(GRADE_SAT)} ), 0.0 );
	color += ${v3(GRADE_LIFT)} * ( 1.0 - smoothstep( 0.0, 0.2, gradeL ) );
	return ACESFilmicToneMapping( color );
}`,
  );
} else console.warn('engine: three tone mapping chunk changed; warm grade skipped');

// ---- quality tier -------------------------------------------------------------------------------------------------

/** 'high': the full look. 'low': phones and weak machines; modules build cheaper content (see the header). */
export type Quality = 'high' | 'low';

let detected: Quality | null = null;
/**
 * The device's quality tier, decided once per page: an override (`?quality=low|high`, localStorage `ww.quality`),
 * else 'low' on touch-first devices (phones, tablets) and on machines with ≤ 4 cores or ≤ 4 GB of memory.
 */
export function detectQuality(): Quality {
  if (detected) return detected;
  const pick = (v: string | null | undefined): Quality | null => (v === 'low' || v === 'high' ? v : null);
  let forced: Quality | null = null;
  try {
    forced = pick(new URLSearchParams(location.search).get('quality')) ?? pick(localStorage.getItem('ww.quality'));
  } catch {}
  if (forced) return (detected = forced);
  const nav = navigator as Navigator & { deviceMemory?: number };
  const touchFirst = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  const weak = (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  return (detected = touchFirst || weak ? 'low' : 'high');
}

export interface EngineStats {
  /** Frames rendered so far. */
  frames: number;
  /** JS time of the last frame's update callback and render call, ms. */
  lastUpdateMs: number;
  lastRenderMs: number;
  /** Smoothed versions of the above. */
  updateMs: number;
  renderMs: number;
  /** Smoothed time between frames (rAF), ms. */
  frameMs: number;
  /** Draw calls and triangles of the last frame (renderer.info). */
  calls: number;
  triangles: number;
  /** Current pixel ratio picked by the governor. */
  ratio: number;
  /** Current quality tier. */
  quality: Quality;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Smoothed frames per second, for the HUD. */
  fps = 60;
  readonly stats: EngineStats;
  private raf = 0;
  private last = 0;
  private onFrame?: (dt: number, now: number) => void;
  private readonly resize = () => this.fit();
  private readonly observer?: ResizeObserver;
  /** Index into QUALITY_STEPS. */
  private level: number;
  /** Lowest index (best ratio) the governor may climb back to; lowered after a failed climb. */
  private ceiling: number;
  private slowFor = 0;
  private fastFor = 0;
  /** Seconds since the last step up (a drop soon after one marks that ratio as too much). */
  private sinceUp = Infinity;
  private tier: Quality;
  private readonly qualityListeners = new Set<(q: Quality) => void>();

  constructor(
    readonly container: HTMLElement,
    opts: { fov?: number; shadows?: boolean; near?: number; far?: number } = {},
  ) {
    this.tier = detectQuality();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const dpr = window.devicePixelRatio || 1;
    const maxRatio = Math.min(dpr, QUALITY_STEPS[0]);
    const startRatio = this.tier === 'low' ? Math.min(maxRatio, LOW_START_RATIO) : maxRatio;
    this.level = QUALITY_STEPS.findIndex((r) => r <= startRatio + 1e-3);
    if (this.level < 0) this.level = QUALITY_STEPS.length - 1;
    this.ceiling = Math.max(0, QUALITY_STEPS.findIndex((r) => r <= maxRatio + 1e-3));
    this.renderer.setPixelRatio(QUALITY_STEPS[this.level]);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.CustomToneMapping;
    this.renderer.toneMappingExposure = GRADE_EXPOSURE;
    this.stats = { frames: 0, lastUpdateMs: 0, lastRenderMs: 0, updateMs: 0, renderMs: 0, frameMs: 16.7, calls: 0, triangles: 0, ratio: QUALITY_STEPS[this.level], quality: this.tier };
    if (opts.shadows ?? true) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
    }
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 45, 1, opts.near ?? 0.05, opts.far ?? 1000);
    container.appendChild(this.renderer.domElement);
    this.fit();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(container);
    } else window.addEventListener('resize', this.resize);
    if (import.meta.env.DEV) (window as unknown as { __engine?: Engine }).__engine = this;
  }

  /** The current quality tier ('high' | 'low'); starts at `detectQuality()`. */
  get quality(): Quality {
    return this.tier;
  }

  /** Sets the tier (a settings toggle, or the governor) and tells the listeners. */
  setQuality(q: Quality) {
    if (q === this.tier) return;
    this.tier = q;
    this.stats.quality = q;
    for (const cb of this.qualityListeners) cb(q);
  }

  /** Calls `cb` whenever the tier changes; returns the unsubscribe function. */
  onQuality(cb: (q: Quality) => void): () => void {
    this.qualityListeners.add(cb);
    return () => this.qualityListeners.delete(cb);
  }

  fit() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    // A hidden or collapsed container has no size yet; keep the last good aspect instead of dividing by zero.
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private setLevel(level: number) {
    this.level = level;
    const ratio = QUALITY_STEPS[level];
    this.renderer.setPixelRatio(ratio);
    this.stats.ratio = ratio;
    this.fit();
    if (ratio <= LOW_BELOW_RATIO + 1e-3) this.setQuality('low');
  }

  /**
   * Steps render resolution down after sustained slow frames (under ~45 fps for 2.5 s), and tries one step up after
   * a long run of frames at the display's rate (works on 60 Hz screens too). A step up that has to be undone within
   * 20 s lowers the ceiling, so the governor does not keep bouncing between two ratios.
   */
  private govern(dt: number) {
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * Math.min(1, dt * 2);
    this.stats.frameMs += (dt * 1000 - this.stats.frameMs) * 0.05;
    if (document.hidden) return;
    this.sinceUp += dt;
    if (dt > 1 / 45) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else {
      this.slowFor = Math.max(0, this.slowFor - dt * 0.5);
      // "Fast" = keeping up with a 60 Hz display or better.
      if (dt < 1 / 55) this.fastFor += dt;
      else this.fastFor = 0;
    }
    if (this.slowFor > 2.5) {
      this.slowFor = 0;
      this.fastFor = 0;
      if (this.level < QUALITY_STEPS.length - 1) {
        if (this.sinceUp < 20) this.ceiling = Math.min(QUALITY_STEPS.length - 1, this.level + 1);
        this.setLevel(this.level + 1);
      }
    } else if (this.fastFor > 15 && this.level > this.ceiling) {
      this.fastFor = 0;
      this.sinceUp = 0;
      this.setLevel(this.level - 1);
    }
  }

  start(onFrame: (dt: number, now: number) => void) {
    this.onFrame = onFrame;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.govern(dt);
      this.frame(dt, now / 1000);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Advances the simulation by hand (dev tooling: hidden tabs get no animation frames). */
  step(dt: number) {
    this.simTime += dt;
    this.frame(dt, this.simTime);
  }

  /** Runs the frame callback and renders, timing both. */
  private frame(dt: number, t: number) {
    const t0 = performance.now();
    this.onFrame?.(dt, t);
    const t1 = performance.now();
    this.renderer.render(this.scene, this.camera);
    const t2 = performance.now();
    const s = this.stats;
    s.lastUpdateMs = t1 - t0;
    s.lastRenderMs = t2 - t1;
    s.updateMs += (s.lastUpdateMs - s.updateMs) * 0.05;
    s.renderMs += (s.lastRenderMs - s.renderMs) * 0.05;
    s.calls = this.renderer.info.render.calls;
    s.triangles = this.renderer.info.render.triangles;
    s.frames++;
  }
  private simTime = 0;

  stop() {
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.qualityListeners.clear();
    this.observer?.disconnect();
    const w = window as unknown as { __engine?: Engine };
    if (w.__engine === this) delete w.__engine;
    window.removeEventListener('resize', this.resize);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
