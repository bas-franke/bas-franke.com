// The Rockets settings panel, opened from the pause menu. Every control writes straight into the settings store,
// so changes apply live (and are saved) while the panel is open.

import { useEffect, useState } from 'react';
import { VolumeControl } from '../../ui/VolumeControl';
import { useStore } from '../types';
import {
  ACTIONS,
  type Action,
  FOV_MAX,
  FOV_MIN,
  type Quality,
  SENS_MAX,
  SENS_MIN,
  bindKey,
  cmPer360,
  codeLabel,
  horizontalFov,
  resetSettings,
  settings,
} from './settings';
import './settings.css';

const QUALITIES: { id: Quality; label: string; hint: string }[] = [
  { id: 'low', label: 'Low', hint: 'No shadows, no outlines, 1× pixels' },
  { id: 'medium', label: 'Medium', hint: 'Soft shadows, outlines, up to 1.25× pixels' },
  { id: 'high', label: 'High', hint: 'Sharp shadows, outlines, up to 1.5× pixels' },
];

export function SettingsPanel({ onClose, rawSupported }: { onClose: () => void; rawSupported?: boolean | null }) {
  const s = useStore(settings);
  const [capture, setCapture] = useState<{ action: Action; slot: 0 | 1 } | null>(null);
  // Free text while typing a sensitivity, so "1." or "" do not snap back mid-edit.
  const [sensText, setSensText] = useState<string | null>(null);

  // While waiting for a binding, swallow the next key, button or wheel notch before the game or the HUD sees it.
  useEffect(() => {
    if (!capture) return;
    const done = (code: string | null) => {
      if (code !== null) bindKey(capture.action, capture.slot, code);
      setCapture(null);
    };
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const key = (e: KeyboardEvent) => {
      stop(e);
      if (e.code === 'Escape') done(null);
      else if (e.code === 'Backspace' || e.code === 'Delete') done('');
      else done(e.code);
    };
    const mouse = (e: MouseEvent) => {
      stop(e);
      // The click that follows this press must not land on another button.
      window.addEventListener('click', stop, { capture: true, once: true });
      done(`Mouse${e.button}`);
    };
    const wheel = (e: WheelEvent) => {
      stop(e);
      if (e.deltaY !== 0) done(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', mouse, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    window.addEventListener('contextmenu', stop, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', mouse, true);
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('contextmenu', stop, true);
    };
  }, [capture]);

  const setSens = (v: number) => {
    if (Number.isFinite(v)) settings.set({ sensitivity: Math.min(SENS_MAX, Math.max(SENS_MIN, Math.round(v * 1000) / 1000)) });
  };
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);

  return (
    <div className="rk-settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !capture && onClose()}>
      <div className="rk-settings" role="dialog" aria-label="Settings">
        <div className="rk-settings-head">
          <h2>Settings</h2>
          <button className="rk-x" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="rk-settings-body">
          <section>
            <h3>Mouse</h3>
            <div className="rk-row">
              <label htmlFor="rk-sens">Sensitivity</label>
              <input
                id="rk-sens"
                type="range"
                min={SENS_MIN}
                max={10}
                step={0.05}
                value={Math.min(10, s.sensitivity)}
                onChange={(e) => setSens(+e.target.value)}
              />
              <input
                className="rk-num"
                type="number"
                inputMode="decimal"
                min={SENS_MIN}
                max={SENS_MAX}
                step={0.001}
                value={sensText ?? String(s.sensitivity)}
                onChange={(e) => {
                  setSensText(e.target.value);
                  const v = parseFloat(e.target.value);
                  if (v >= SENS_MIN && v <= SENS_MAX) setSens(v);
                }}
                onBlur={() => setSensText(null)}
                aria-label="Sensitivity value"
              />
            </div>
            <p className="rk-note">
              Quake/Source units · {cmPer360(s.sensitivity).toFixed(1)} cm per 360° at 800 DPI
            </p>
            <Toggle label="Invert Y" on={s.invertY} set={(invertY) => settings.set({ invertY })} />
            <Toggle
              label="Raw mouse input"
              on={s.rawInput}
              set={(rawInput) => settings.set({ rawInput })}
              note={
                rawSupported === false
                  ? 'Not supported by this browser: the OS pointer speed applies.'
                  : 'Skips OS mouse acceleration. Takes effect the next time you click in.'
              }
            />
          </section>

          <section>
            <h3>View</h3>
            <div className="rk-row">
              <label htmlFor="rk-fov">Field of view</label>
              <input
                id="rk-fov"
                type="range"
                min={FOV_MIN}
                max={FOV_MAX}
                step={1}
                value={s.fov}
                onChange={(e) => settings.set({ fov: +e.target.value })}
              />
              <span className="rk-val">{s.fov}°</span>
            </div>
            <p className="rk-note">4:3 horizontal, like Quake · {Math.round(horizontalFov(s.fov, aspect))}° across this screen</p>
            <Toggle label="View bob" on={s.bob} set={(bob) => settings.set({ bob })} />
            <Toggle
              label="Reduced motion"
              on={s.reducedMotion}
              set={(reducedMotion) => settings.set({ reducedMotion })}
              note="No bob, gentler screen shake and recoil."
            />
          </section>

          <section>
            <h3>Keys</h3>
            <p className="rk-note">Click a slot, then press a key, a mouse button or roll the wheel. Backspace clears, Esc cancels.</p>
            <div className="rk-binds">
              {ACTIONS.map(({ id, label }) => (
                <div className="rk-bind" key={id}>
                  <span>{label}</span>
                  {([0, 1] as const).map((slot) => {
                    const active = capture?.action === id && capture.slot === slot;
                    return (
                      <button
                        key={slot}
                        className={`rk-key ${active ? 'listening' : ''} ${s.keys[id][slot] ? '' : 'empty'}`}
                        onClick={() => setCapture(active ? null : { action: id, slot })}
                      >
                        {active ? 'Press…' : codeLabel(s.keys[id][slot])}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>Sound</h3>
            <div className="rk-row">
              <label>Master volume</label>
              <VolumeControl className="rk-volume" label="Master volume" />
            </div>
          </section>

          <section>
            <h3>Graphics</h3>
            <div className="rk-seg" role="radiogroup" aria-label="Graphics quality">
              {QUALITIES.map((q) => (
                <button
                  key={q.id}
                  role="radio"
                  aria-checked={s.quality === q.id}
                  className={s.quality === q.id ? 'on' : ''}
                  onClick={() => settings.set({ quality: q.id })}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <p className="rk-note">{QUALITIES.find((q) => q.id === s.quality)?.hint}</p>
            <Toggle label="Show FPS" on={s.showFps} set={(showFps) => settings.set({ showFps })} />
          </section>
        </div>

        <div className="rk-settings-foot">
          <button className="rk-btn ghost" onClick={resetSettings}>
            Reset to defaults
          </button>
          <button className="rk-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, on, set, note }: { label: string; on: boolean; set: (v: boolean) => void; note?: string }) {
  return (
    <div className="rk-toggle-wrap">
      <button className={`rk-toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => set(!on)}>
        <span className="rk-knob" />
        <span>{label}</span>
      </button>
      {note && <p className="rk-note">{note}</p>}
    </div>
  );
}
