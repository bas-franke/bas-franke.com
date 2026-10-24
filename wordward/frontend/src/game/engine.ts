// Thin wrapper around a three.js renderer: scene, camera, resize handling and a frame loop with a capped dt.
// A small governor watches frame times and lowers the render resolution when a machine cannot keep up (and raises
// it again when there is headroom), so the game stays playable everywhere.
//
// Colour: sRGB output with ACES filmic tone mapping for the warm dusk library. Glow comes from additive sprites
// (toon.ts `glowSprite`/`glowBatch`), not a bloom pass. `stats` exposes frame cost and draw calls for the
// compare/perf tools (dev builds also publish `window.__engine`).

import * as THREE from 'three';

/** Pixel ratios the governor steps through, best first. */
const QUALITY_STEPS = [1.5, 1.25, 1, 0.85, 0.7];

export interface EngineStats {
  /** Frames rendered so far. */
  frames: number;
  /** JS time of the last frame's update callback and render call, ms. */
  lastUpdateMs: number;
  lastRenderMs: number;
  /** Smoothed versions of the above. */
  updateMs: number;
  renderMs: number;
  /** Draw calls and triangles of the last frame (renderer.info). */
  calls: number;
  triangles: number;
  /** Current pixel ratio picked by the governor. */
  ratio: number;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Smoothed frames per second, for the HUD. */
  fps = 60;
  readonly stats: EngineStats = { frames: 0, lastUpdateMs: 0, lastRenderMs: 0, updateMs: 0, renderMs: 0, calls: 0, triangles: 0, ratio: 1 };
  private raf = 0;
  private last = 0;
  private onFrame?: (dt: number, now: number) => void;
  private readonly resize = () => this.fit();
  private readonly observer?: ResizeObserver;
  private quality: number;
  private slowFor = 0;
  private fastFor = 0;

  constructor(
    readonly container: HTMLElement,
    opts: { fov?: number; shadows?: boolean; near?: number; far?: number } = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const maxRatio = Math.min(window.devicePixelRatio || 1, QUALITY_STEPS[0]);
    this.quality = QUALITY_STEPS.findIndex((r) => r <= maxRatio + 1e-3);
    if (this.quality < 0) this.quality = QUALITY_STEPS.length - 1;
    this.renderer.setPixelRatio(QUALITY_STEPS[this.quality]);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.stats.ratio = QUALITY_STEPS[this.quality];
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

  fit() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    // A hidden or collapsed container has no size yet; keep the last good aspect instead of dividing by zero.
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Steps render quality down after sustained slow frames, and back up after a long run of fast ones. */
  private govern(dt: number) {
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * Math.min(1, dt * 2);
    if (document.hidden) return;
    if (dt > 1 / 45) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else {
      this.fastFor += dt;
      this.slowFor = Math.max(0, this.slowFor - dt * 0.5);
    }
    if (this.slowFor > 2.5) {
      this.slowFor = 0;
      if (this.quality < QUALITY_STEPS.length - 1) {
        this.quality++;
        this.renderer.setPixelRatio(QUALITY_STEPS[this.quality]);
        this.stats.ratio = QUALITY_STEPS[this.quality];
        this.fit();
      }
    } else if (this.fastFor > 12 && dt < 1 / 70 && this.quality > 0 && QUALITY_STEPS[this.quality - 1] <= (window.devicePixelRatio || 1) + 1e-3) {
      this.fastFor = 0;
      this.quality--;
      this.renderer.setPixelRatio(QUALITY_STEPS[this.quality]);
      this.stats.ratio = QUALITY_STEPS[this.quality];
      this.fit();
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
