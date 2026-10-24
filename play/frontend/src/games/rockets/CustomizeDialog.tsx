import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  BACKPACKS,
  BODY_COLORS,
  BOOTS,
  DEFAULT_LOOK,
  EARS,
  EMBLEMS,
  FACES,
  HELMETS,
  type Look,
  PATTERNS,
  SHOULDERS,
  TRIM_COLORS,
  VISOR_COLORS,
  VISOR_SHAPES,
  randomLook,
} from '@shared/rockets/cosmetics';
import { Modal } from '../../ui/Modal';
import { animateCharacter, buildCharacter } from './character';
import { loadLook, saveLook } from './look';
import './customize.css';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const label = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace('-', ' ');

type Choice = 'helmet' | 'visorShape' | 'face' | 'ears' | 'shoulders' | 'pattern' | 'backpack' | 'boots' | 'emblem';
/** The part pickers, in order, with their headings. */
const CHOICES: [Choice, string, readonly string[]][] = [
  ['helmet', 'Helmet', HELMETS],
  ['visorShape', 'Visor', VISOR_SHAPES],
  ['face', 'Face', FACES],
  ['ears', 'Ears', EARS],
  ['shoulders', 'Shoulders', SHOULDERS],
  ['pattern', 'Paint', PATTERNS],
  ['backpack', 'Backpack', BACKPACKS],
  ['boots', 'Boots', BOOTS],
  ['emblem', 'Emblem', EMBLEMS],
];

/**
 * The robot customiser: a live, turning 3D preview next to colour swatches and part pickers. Every change is saved
 * in this browser (look.ts) and handed to `onChange`, which tells the room. The preview is the game's own robot
 * (character.ts buildCharacter), so what you see here is what other players see.
 */
export function CustomizeDialog({ onChange, onClose }: { onChange: (look: Look) => void; onClose: () => void }) {
  const [look, setLook] = useState<Required<Look>>(loadLook);
  const update = (next: Required<Look>) => {
    setLook(next);
    saveLook(next);
    onChange(next);
  };
  const set = <K extends keyof Look>(key: K, value: Look[K]) => update({ ...look, [key]: value });

  const swatches = (key: 'body' | 'trim' | 'visor', colors: readonly number[]) => (
    <div className="rk-swatches" role="radiogroup" aria-label={`${label(key)} colour`}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={look[key] === c}
          aria-label={hex(c)}
          className={`rk-swatch${look[key] === c ? ' active' : ''}`}
          style={{ background: hex(c) }}
          onClick={() => set(key, c)}
        />
      ))}
    </div>
  );
  const variants = (key: Choice, name: string, list: readonly string[]) => (
    <div className="rk-variants" role="radiogroup" aria-label={name}>
      {list.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={look[key] === v}
          className={`rk-variant${look[key] === v ? ' active' : ''}`}
          onClick={() => set(key, v as Look[Choice])}
        >
          {label(v)}
        </button>
      ))}
    </div>
  );

  return (
    <Modal label="Customize robot" size="lg" onClose={onClose}>
      <div className="modal-head">
        <div>
          <span className="step">Rockets</span>
          <h2>Customize robot</h2>
        </div>
        <button type="button" className="btn small ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="rk-custom">
        <RobotPreview look={look} />
        <div className="rk-custom-controls">
          <section>
            <h3>Body</h3>
            {swatches('body', BODY_COLORS)}
            <p className="rk-custom-note">Team modes paint the body in your team's colour.</p>
          </section>
          <section>
            <h3>Trim</h3>
            {swatches('trim', TRIM_COLORS)}
          </section>
          <section>
            <h3>Lights</h3>
            {swatches('visor', VISOR_COLORS)}
          </section>
          <div className="rk-custom-parts">
            {CHOICES.map(([key, name, list]) => (
              <section key={key}>
                <h3>{name}</h3>
                {variants(key, name, list)}
              </section>
            ))}
          </div>
          <div className="rk-custom-actions">
            <button type="button" className="btn small" onClick={() => update(randomLook())}>
              Randomize
            </button>
            <button type="button" className="btn small ghost" onClick={() => update({ ...DEFAULT_LOOK })}>
              Reset
            </button>
            <button type="button" className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** A small three.js view of the robot turning on a plinth; drag to spin it. Its renderer is disposed on unmount. */
function RobotPreview({ look }: { look: Look }) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<{ setLook: (look: Look) => void } | null>(null);

  useEffect(() => {
    const holder = box.current;
    if (!holder) return;
    // A fresh canvas per mount: the old one's context is released on unmount and cannot be reused.
    const el = document.createElement('canvas');
    holder.appendChild(el);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true });
    } catch {
      el.remove();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a6a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(-2, 4, -3);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
    camera.position.set(0, 1.3, -5.8);
    camera.lookAt(0, 0.92, -0.2);
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.8, 0.06, 32), new THREE.MeshBasicMaterial({ color: 0x1a2236 }));
    plinth.position.y = -0.03;
    scene.add(plinth);
    const turn = new THREE.Group();
    scene.add(turn);

    let robot: THREE.Group | null = null;
    view.current = {
      setLook(next) {
        if (robot) turn.remove(robot);
        robot = buildCharacter(next);
        turn.add(robot);
      },
    };
    view.current.setLook(look);

    let spin = 0.6;
    let drag: number | null = null;
    const down = (e: PointerEvent) => ((drag = e.clientX), el.setPointerCapture(e.pointerId));
    const move = (e: PointerEvent) => {
      if (drag === null) return;
      turn.rotation.y += (e.clientX - drag) * 0.012;
      drag = e.clientX;
    };
    const up = () => (drag = null);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    const state = { speed: 0, vx: 0, vz: 0, yaw: 0, onGround: true, vy: 0, pitch: 0, t: 0, dt: 0 };
    let last = performance.now();
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.floor(w * renderer.getPixelRatio()) || el.height !== Math.floor(h * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(h, 1);
        camera.updateProjectionMatrix();
      }
      if (drag === null) turn.rotation.y += spin * dt;
      state.t += dt;
      state.dt = dt;
      state.pitch = Math.sin(state.t * 0.7) * 0.15;
      if (robot) animateCharacter(robot, state);
      renderer.render(scene, camera);
    };
    tick();
    spin = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.6;

    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      plinth.geometry.dispose();
      (plinth.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
      view.current = null;
    };
    // The renderer lives as long as the dialog; look changes go through view.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.setLook(look);
  }, [look]);

  return <div ref={box} className="rk-preview" role="img" aria-label="Robot preview (drag to turn)" />;
}
