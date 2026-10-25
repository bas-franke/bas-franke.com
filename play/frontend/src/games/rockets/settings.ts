// Player settings for Rockets: mouse, field of view, key bindings, graphics quality and the FPS readout. Volume is
// site-wide and lives in engine/audio.ts.
// Kept in localStorage (when the browser allows it) and shared through a tiny store, so the panel, the HUD and the
// client all see changes the moment they happen.
//
// Units follow Quake and Source so players can bring their numbers along: sensitivity is degrees per mouse count
// divided by 0.022 (m_yaw), and FOV is the horizontal angle on a 4:3 screen, widened for wider screens (Hor+).

import * as THREE from 'three';
import type { Input } from '../../engine/input';
import { setInkVisible } from '../../engine/toon';
import { createStore } from '../types';

export type Quality = 'low' | 'medium' | 'high';
export type Action = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'fire';

export interface RocketsSettings {
  /** Quake/Source sensitivity: degrees per mouse count is this times 0.022. */
  sensitivity: number;
  invertY: boolean;
  /** Horizontal FOV in degrees on a 4:3 screen (80..110). */
  fov: number;
  /** Pointer lock with unadjustedMovement: no OS mouse acceleration. */
  rawInput: boolean;
  /** Two slots per action; '' is an empty slot. */
  keys: Record<Action, [string, string]>;
  quality: Quality;
  showFps: boolean;
  /** View and weapon bob while running. */
  bob: boolean;
  /** Calmer camera: no bob, softer shake and kicks. Defaults to the OS prefers-reduced-motion setting. */
  reducedMotion: boolean;
}

export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'forward', label: 'Forward' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Strafe left' },
  { id: 'right', label: 'Strafe right' },
  { id: 'jump', label: 'Jump' },
  { id: 'fire', label: 'Fire' },
];

export const SENS_MIN = 0.1;
export const SENS_MAX = 20;
export const FOV_MIN = 80;
export const FOV_MAX = 110;

const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export const DEFAULTS: RocketsSettings = {
  sensitivity: 5.7,
  invertY: false,
  fov: 100,
  rawInput: true,
  keys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    jump: ['Space', 'WheelDown'],
    fire: ['Mouse0', ''],
  },
  quality: 'high',
  showFps: true,
  bob: true,
  reducedMotion: prefersReducedMotion(),
};

/** What each graphics preset means. `pixelRatio` caps the renderer (the engine governor can still go lower). */
export const QUALITY: Record<Quality, { pixelRatio: number; shadows: boolean; shadowMap: number; outlines: boolean }> = {
  low: { pixelRatio: 1, shadows: false, shadowMap: 512, outlines: false },
  medium: { pixelRatio: 1.25, shadows: true, shadowMap: 1024, outlines: true },
  high: { pixelRatio: 1.5, shadows: true, shadowMap: 2048, outlines: true },
};

const KEY = 'rockets.settings.v1';
const clampNum = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Merges whatever was stored over the defaults, dropping anything malformed. */
function sanitize(raw: unknown): RocketsSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RocketsSettings, unknown>>;
  const keys = { ...DEFAULTS.keys };
  const rk = (r.keys && typeof r.keys === 'object' ? r.keys : {}) as Record<string, unknown>;
  for (const { id } of ACTIONS) {
    const v = rk[id];
    if (Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'string' && c.length < 32)) keys[id] = [v[0], v[1]];
  }
  return {
    sensitivity: clampNum(r.sensitivity, SENS_MIN, SENS_MAX, DEFAULTS.sensitivity),
    invertY: typeof r.invertY === 'boolean' ? r.invertY : DEFAULTS.invertY,
    fov: Math.round(clampNum(r.fov, FOV_MIN, FOV_MAX, DEFAULTS.fov)),
    rawInput: typeof r.rawInput === 'boolean' ? r.rawInput : DEFAULTS.rawInput,
    keys,
    quality: r.quality === 'low' || r.quality === 'medium' || r.quality === 'high' ? r.quality : DEFAULTS.quality,
    showFps: typeof r.showFps === 'boolean' ? r.showFps : DEFAULTS.showFps,
    bob: typeof r.bob === 'boolean' ? r.bob : DEFAULTS.bob,
    reducedMotion: typeof r.reducedMotion === 'boolean' ? r.reducedMotion : DEFAULTS.reducedMotion,
  };
}

function load(): RocketsSettings {
  try {
    const s = localStorage.getItem(KEY);
    return sanitize(s ? JSON.parse(s) : null);
  } catch {
    return sanitize(null);
  }
}

/** The live settings. `settings.set(patch)` saves and notifies subscribers. */
export const settings = createStore<RocketsSettings>(load());

settings.subscribe(() => {
  const s = settings.get();
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or blocked storage: settings last for this page only.
  }
});

export const resetSettings = () => settings.set(sanitize(null));

/** Binds `action` in `slot`, taking the code away from any other action that had it. */
export function bindKey(action: Action, slot: 0 | 1, code: string) {
  const keys = { ...settings.get().keys };
  if (code)
    for (const { id } of ACTIONS) {
      const k = keys[id];
      if (k[0] === code || k[1] === code) keys[id] = [k[0] === code ? '' : k[0], k[1] === code ? '' : k[1]];
    }
  const k = [...keys[action]] as [string, string];
  k[slot] = code;
  keys[action] = k;
  settings.set({ keys });
}

// ---- conversions ---------------------------------------------------------------------------------------------

/** Radians per mouse count for a Quake/Source sensitivity. */
export const sensRadians = (sens: number) => sens * 0.022 * THREE.MathUtils.DEG2RAD;

/** Centimetres of mouse travel for a full turn at `dpi`. */
export const cmPer360 = (sens: number, dpi = 800) => (360 / (sens * 0.022) / dpi) * 2.54;

/** Vertical FOV (what three.js wants) for a 4:3 horizontal FOV; the same on every aspect ratio (Hor+). */
export const verticalFov = (fov43: number) => 2 * Math.atan(Math.tan((fov43 * THREE.MathUtils.DEG2RAD) / 2) * 0.75) * THREE.MathUtils.RAD2DEG;

/** The actual horizontal FOV on a screen of this aspect ratio, for display. */
export const horizontalFov = (fov43: number, aspect: number) =>
  2 * Math.atan(Math.tan((verticalFov(fov43) * THREE.MathUtils.DEG2RAD) / 2) * aspect) * THREE.MathUtils.RAD2DEG;

// ---- applying -------------------------------------------------------------------------------------------------

/** Pushes mouse and key settings into an Input. Cheap; call on every settings change. */
export function applyInput(input: Input, s = settings.get()) {
  input.sensitivity = sensRadians(s.sensitivity);
  input.invertY = s.invertY;
  input.rawInput = s.rawInput;
  const b: Record<string, string[]> = {};
  for (const { id } of ACTIONS) b[id] = s.keys[id].filter(Boolean);
  input.bindings = b;
}

/**
 * Applies a quality preset to what is in the scene now: sun shadows (on/off and map size) and ink outlines
 * (inverted-hull meshes and crease lines). Call after building the world and whenever the preset changes. Not for
 * the frame loop: it walks the whole scene.
 */
export function applyQuality(scene: THREE.Scene, quality: Quality) {
  const q = QUALITY[quality];
  // Ink materials are shared and cached, so one switch covers everything, including what gets built later.
  setInkVisible(q.outlines);
  scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight) {
      const light = o as THREE.DirectionalLight;
      // Remember which lights were meant to cast, so turning shadows back on restores only those.
      if (light.userData.shadowCaster === undefined) light.userData.shadowCaster = light.castShadow;
      // Toggling castShadow changes the light-state hash, so three recompiles the affected materials by itself.
      light.castShadow = q.shadows && light.userData.shadowCaster === true;
      if (light.shadow.mapSize.x !== q.shadowMap) {
        light.shadow.mapSize.set(q.shadowMap, q.shadowMap);
        light.shadow.map?.dispose();
        light.shadow.map = null;
      }
    }
  });
}

/** A readable name for a bound code: `KeyW` → `W`, `Mouse0` → `Mouse 1`. */
export function codeLabel(code: string) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Mouse')) return ['Left click', 'Middle click', 'Right click', 'Mouse 4', 'Mouse 5'][+code.slice(5)] ?? code;
  const named: Record<string, string> = {
    Space: 'Space',
    WheelUp: 'Wheel up',
    WheelDown: 'Wheel down',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    ShiftLeft: 'L Shift',
    ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl',
    ControlRight: 'R Ctrl',
    AltLeft: 'L Alt',
    AltRight: 'R Alt',
  };
  return named[code] ?? code.replace(/^Numpad/, 'Num ');
}
