// Thin wrapper around a three.js renderer: scene, camera, resize handling and a frame loop with a capped dt.
// A small governor watches frame times and lowers the render resolution (and the shadow refresh rate) when a machine
// cannot keep up, and raises it again when there is headroom, so the game stays playable everywhere.
// Dev builds get a perf overlay (F3 or ?perf) and `window.__engine` for the perf harness in play/tools/perf/.

import * as THREE from 'three';

/** Quality levels the governor steps through, best first: pixel ratio and shadow map refreshes per second. */
const QUALITY_STEPS = [
  { ratio: 1.5, shadowHz: 60 },
  { ratio: 1.25, shadowHz: 45 },
  { ratio: 1, shadowHz: 30 },
  { ratio: 0.85, shadowHz: 24 },
  { ratio: 0.7, shadowHz: 15 },
];
/** Frames slower than this count against the current level, frames faster than FAST_DT count towards the next one. */
const SLOW_DT = 1 / 45;
const FAST_DT = 1 / 52;
/** Frames this long are hitches (tab return, shader compile, GC) and are ignored unless they keep coming. */
const HITCH_DT = 0.09;
/** Seconds of fast frames before trying the next level up; doubles each time a step up fails. */
const STEP_UP_COOLDOWN = 20;
const STEP_UP_MAX = 320;
/** A step down this soon after a step up means the step up failed. */
const FAILED_WINDOW = 15;

/** Per-frame cost, smoothed. Read by the perf overlay and the perf harness. */
export interface EngineStats {
  /** ms in the game's frame callback (simulation, interpolation, effects), smoothed, and for the last frame. */
  updateMs: number;
  lastUpdateMs: number;
  /** ms in renderer.render (JS side of the draw, plus whatever the driver blocks on), smoothed and last frame. */
  renderMs: number;
  lastRenderMs: number;
  /** Draw calls and triangles of the last frame, shadow pass included. */
  calls: number;
  triangles: number;
  /** Frames that refreshed the shadow map, and all frames, since start. */
  shadowFrames: number;
  frames: number;
  ratio: number;
  shadowHz: number;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Smoothed frames per second, for the HUD. */
  fps = 60;
  /**
   * Shadow map refreshes per second. null follows the quality level; 0 keeps it static (call invalidateShadows()
   * after moving casters); any other number is a fixed rate.
   */
  shadowHz: number | null = null;
  readonly stats: EngineStats = { updateMs: 0, lastUpdateMs: 0, renderMs: 0, lastRenderMs: 0, calls: 0, triangles: 0, shadowFrames: 0, frames: 0, ratio: 1, shadowHz: 0 };
  private raf = 0;
  private last = 0;
  private onFrame?: (dt: number, now: number) => void;
  /** Replaces the plain `renderer.render(scene, camera)` each frame (a game's own post-processing chain). */
  renderHook?: () => void;
  private readonly resize = () => this.fit();
  private readonly observer?: ResizeObserver;
  private quality: number;
  /** Highest pixel ratio the governor may use: the screen's, capped by the quality setting. */
  private maxRatio: number;
  private slowFor = 0;
  private fastFor = 0;
  private hitches = 0;
  private clock = 0;
  /** Seconds of fast frames needed to step up from each level. */
  private readonly cooldown = QUALITY_STEPS.map(() => STEP_UP_COOLDOWN);
  private upAt = -Infinity;
  private shadowDue = 0;
  private shadowDirty = true;
  private overlay?: HTMLDivElement;
  private overlayAt = 0;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === 'F3') {
      e.preventDefault();
      this.toggleOverlay();
    }
  };

  constructor(
    readonly container: HTMLElement,
    opts: { fov?: number; shadows?: boolean; near?: number; far?: number } = {},
  ) {
    const dpr = window.devicePixelRatio || 1;
    // MSAA keeps the ink outlines clean on normal screens; on dense (2x+) screens the pixels are small enough that
    // its cost is not worth it. No stencil: nothing uses it, and dropping it saves memory bandwidth.
    this.renderer = new THREE.WebGLRenderer({ antialias: dpr < 2, stencil: false, powerPreference: 'high-performance' });
    this.maxRatio = Math.min(dpr, QUALITY_STEPS[0].ratio);
    this.quality = this.levelFor(this.maxRatio);
    this.renderer.setPixelRatio(QUALITY_STEPS[this.quality].ratio);
    this.stats.ratio = QUALITY_STEPS[this.quality].ratio;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    if (opts.shadows ?? true) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      // The arena never moves, so the shadow map is refreshed on a budget instead of every frame.
      this.renderer.shadowMap.autoUpdate = false;
    }
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 75, 1, opts.near ?? 0.05, opts.far ?? 300);
    container.appendChild(this.renderer.domElement);
    this.fit();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(container);
    } else window.addEventListener('resize', this.resize);
    if (import.meta.env.DEV) {
      (window as unknown as { __engine: Engine }).__engine = this;
      window.addEventListener('keydown', this.onKey);
      if (new URLSearchParams(location.search).has('perf')) this.toggleOverlay();
    }
  }

  fit() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Refreshes the shadow map on the next frame (after adding, removing or moving shadow casters). */
  invalidateShadows() {
    this.shadowDirty = true;
  }

  /**
   * Compiles every shader the scene can need and uploads its geometry and textures now, so nothing hitches the first
   * time an effect, model or late pass shows up mid-match. Pooled objects that are hidden right now are shown for the
   * duration (lights excepted: they set the shader light count), `extra` objects (one of each model the game spawns
   * later) are added, and everything is drawn once into a single pixel, shadow pass included. Call after building the
   * world, before play starts; the next frame repaints the whole canvas.
   */
  warmup(extra: THREE.Object3D[] = []) {
    const { scene, camera, renderer } = this;
    for (const o of extra) scene.add(o);
    const shown: THREE.Object3D[] = [];
    const culled: THREE.Object3D[] = [];
    const empty: THREE.InstancedMesh[] = [];
    scene.traverse((o) => {
      if (!o.visible && !(o as THREE.Light).isLight) {
        o.visible = true;
        shown.push(o);
      }
      if (o.frustumCulled) {
        o.frustumCulled = false;
        culled.push(o);
      }
      const inst = o as THREE.InstancedMesh;
      if (inst.isInstancedMesh && inst.count === 0) {
        inst.count = 1;
        empty.push(inst);
      }
    });
    renderer.compile(scene, camera);
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, 1, 1);
    if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    for (const o of shown) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
    for (const o of empty) o.count = 0;
    for (const o of extra) scene.remove(o);
    this.invalidateShadows();
  }

  /** Best level whose pixel ratio fits under `ratio`. */
  private levelFor(ratio: number) {
    const level = QUALITY_STEPS.findIndex((q) => q.ratio <= ratio + 1e-3);
    return level < 0 ? QUALITY_STEPS.length - 1 : level;
  }

  /**
   * Caps the pixel ratio at min(cap, devicePixelRatio), for the graphics setting. Jumps straight to the matching
   * level (up or down); the governor can still go lower, but never steps up past the cap.
   */
  setMaxPixelRatio(cap: number) {
    this.maxRatio = Math.min(cap, window.devicePixelRatio || 1);
    this.cooldown.fill(STEP_UP_COOLDOWN);
    this.upAt = -Infinity;
    this.setQuality(this.levelFor(this.maxRatio));
  }

  /**
   * Turns shadow casting on or off for every light that was built to cast, and optionally resizes their shadow maps.
   * Same bookkeeping as settings.applyQuality (light.userData.shadowCaster), so either can be used.
   */
  setShadows(on: boolean, mapSize?: number) {
    this.scene.traverse((o) => {
      const light = o as THREE.DirectionalLight;
      if (!light.isLight || !light.shadow) return;
      if (light.userData.shadowCaster === undefined) light.userData.shadowCaster = light.castShadow;
      light.castShadow = on && light.userData.shadowCaster === true;
      if (mapSize && light.shadow.mapSize.x !== mapSize) {
        light.shadow.mapSize.set(mapSize, mapSize);
        light.shadow.map?.dispose();
        light.shadow.map = null;
      }
    });
    this.invalidateShadows();
  }

  private setQuality(level: number) {
    this.quality = level;
    this.renderer.setPixelRatio(QUALITY_STEPS[level].ratio);
    this.stats.ratio = QUALITY_STEPS[level].ratio;
    this.fit();
    this.slowFor = 0;
    this.fastFor = 0;
  }

  /** Steps render quality down after sustained slow frames, and back up after a long run of fast ones. */
  private govern(dt: number) {
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * Math.min(1, dt * 2);
    if (document.hidden) return;
    // One long frame is a hitch, not a slow machine; a run of them is a slow machine.
    if (dt >= HITCH_DT) {
      if (++this.hitches < 4) return;
    } else this.hitches = 0;
    this.clock += dt;
    if (dt > SLOW_DT) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else {
      if (dt < FAST_DT) this.fastFor += dt;
      this.slowFor = Math.max(0, this.slowFor - dt * 0.5);
    }
    if (this.slowFor > 2.5) {
      if (this.quality < QUALITY_STEPS.length - 1) {
        // Back down right after stepping up: that level is out of reach for now, so wait longer next time.
        if (this.clock - this.upAt < FAILED_WINDOW) {
          this.cooldown[this.quality + 1] = Math.min(STEP_UP_MAX, this.cooldown[this.quality + 1] * 2);
          this.upAt = -Infinity;
        }
        this.setQuality(this.quality + 1);
      } else this.slowFor = 0;
    } else if (
      this.fastFor > this.cooldown[this.quality] &&
      this.quality > 0 &&
      QUALITY_STEPS[this.quality - 1].ratio <= this.maxRatio + 1e-3
    ) {
      this.upAt = this.clock;
      this.setQuality(this.quality - 1);
    }
  }

  /** Decides whether this frame re-renders the shadow map. */
  private shadows(dt: number) {
    const map = this.renderer.shadowMap;
    if (!map.enabled) return;
    const hz = this.shadowHz ?? QUALITY_STEPS[this.quality].shadowHz;
    this.stats.shadowHz = hz;
    this.shadowDue -= dt;
    if (this.shadowDirty || (hz > 0 && this.shadowDue <= 0)) {
      map.needsUpdate = true;
      this.shadowDirty = false;
      // Never let a backlog build up after a hitch.
      this.shadowDue = hz > 0 ? Math.max(this.shadowDue + 1 / hz, 0) : 0;
      this.stats.shadowFrames++;
    }
  }

  start(onFrame: (dt: number, now: number) => void) {
    this.onFrame = onFrame;
    this.last = performance.now();
    const stats = this.stats;
    const info = this.renderer.info.render;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.govern(dt);
      const t0 = performance.now();
      this.onFrame?.(dt, now / 1000);
      const t1 = performance.now();
      this.shadows(dt);
      if (this.renderHook) this.renderHook();
      else this.renderer.render(this.scene, this.camera);
      const t2 = performance.now();
      stats.lastUpdateMs = t1 - t0;
      stats.lastRenderMs = t2 - t1;
      stats.updateMs += (stats.lastUpdateMs - stats.updateMs) * 0.05;
      stats.renderMs += (stats.lastRenderMs - stats.renderMs) * 0.05;
      stats.calls = info.calls;
      stats.triangles = info.triangles;
      stats.frames++;
      if (this.overlay && now - this.overlayAt > 250) this.drawOverlay(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private toggleOverlay() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = undefined;
      return;
    }
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:8px;bottom:8px;z-index:50;padding:6px 8px;background:rgba(0,0,0,.7);color:#9f9;' +
      'font:12px/1.35 ui-monospace,Consolas,monospace;white-space:pre;pointer-events:none;border-radius:4px';
    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(el);
    this.overlay = el;
  }

  private drawOverlay(now: number) {
    this.overlayAt = now;
    const s = this.stats;
    const mem = this.renderer.info.memory;
    this.overlay!.textContent =
      `${this.fps.toFixed(0)} fps  q${this.quality} x${s.ratio}  shadow ${s.shadowHz} Hz\n` +
      `update ${s.updateMs.toFixed(2)} ms  render ${s.renderMs.toFixed(2)} ms\n` +
      `${s.calls} calls  ${(s.triangles / 1000).toFixed(1)}k tris\n` +
      `${mem.geometries} geo  ${mem.textures} tex  ${this.renderer.info.programs?.length ?? 0} programs`;
  }

  dispose() {
    this.stop();
    this.observer?.disconnect();
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKey);
    this.overlay?.remove();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(disposeMaterial);
      else if (mat) disposeMaterial(mat);
    });
    this.renderer.dispose();
    // Without this the WebGL context lives on until GC, and browsers cap live contexts at ~16.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    if (import.meta.env.DEV) {
      const w = window as unknown as { __engine?: Engine };
      if (w.__engine === this) delete w.__engine;
    }
  }
}

/** Disposes a material and every texture it holds (Material.dispose leaves .map and friends alone). */
function disposeMaterial(mat: THREE.Material) {
  for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
  mat.dispose();
}

/** A canvas-drawn label sprite (player names). */
export function makeLabel(text: string, color = '#ffffff'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const scale = 2;
  const font = `600 ${28 * scale}px "Space Grotesk", system-ui, sans-serif`;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36 * scale;
  const h = 48 * scale;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  const r = 14 * scale;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.fill();
  // Ink outline under the letters so dark player colours stay readable.
  ctx.lineWidth = 6 * scale;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, w / 2, h / 2 + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  const aspect = w / h;
  sprite.scale.set(0.5 * aspect, 0.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export const colorHex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
