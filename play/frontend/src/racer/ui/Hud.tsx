// Race HUD, styled after the concept art: LAP / POS top left, TIME / BEST top right, speed arc and boost bar bottom
// left, minimap bottom right, centre messages (countdown, wrong way, finish), the pause menu and touch
// controls on phones. Widgets live in hudParts.tsx and subscribe to their own slices of the per-frame store.

import { memo, useEffect, useState } from 'react';
import type { RaceView } from '../RaceView';
import { Countdown, FinishBanner, IntroHint, Minimap, PosPanel, Speedo, Standings, TimePanel, ToGoPanel, WrongWay } from './hudParts';
import { useHud, wantsTouch } from './hudStore';
import { VolumeControl } from '../../ui/VolumeControl';
import { TouchControls } from './TouchControls';
import './hud.css';

export function Hud({ view, onQuit, onRestart }: { view: RaceView; onQuit(): void; onRestart(): void }) {
  const [touch, setTouch] = useState(wantsTouch);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const paused = view.hud.get().paused;
      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (view.hud.get().phase !== 'finished' || paused) view.setPaused(!paused);
      } else if (paused && e.code === 'KeyR') onRestart();
      else if (paused && e.code === 'KeyQ') onQuit();
    };
    // A touch anywhere switches the on-screen controls on (tablets with a fine pointer, hybrid laptops).
    const first = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setTouch(true);
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', first);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', first);
    };
  }, [view, onQuit, onRestart]);

  return (
    <div className={`hud${touch ? ' touch' : ''}`}>
      <div className="hud-tl">
        <ToGoPanel view={view} />
        <PosPanel view={view} />
        <Standings view={view} />
      </div>
      <div className="hud-tr">
        <TimePanel view={view} />
      </div>
      <div className="hud-bl">
        <Speedo view={view} />
      </div>
      <div className="hud-br">
        <Minimap view={view} />
      </div>
      <Countdown view={view} />
      <WrongWay view={view} />
      <FinishBanner view={view} />
      <IntroHint view={view} touch={touch} />
      {touch && <TouchControls view={view} />}
      <PauseButton view={view} />
      <PauseMenu view={view} onQuit={onQuit} onRestart={onRestart} />
    </div>
  );
}

const PauseButton = memo(function PauseButton({ view }: { view: RaceView }) {
  return (
    <button className="hud-pause-btn" aria-label="Pause" onClick={() => view.setPaused(true)}>
      <i />
      <i />
    </button>
  );
});

const PauseMenu = memo(function PauseMenu({ view, onQuit, onRestart }: { view: RaceView; onQuit(): void; onRestart(): void }) {
  const paused = useHud(view, (s) => s.paused);
  const track = useHud(view, (s) => s.trackName);
  if (!paused) return null;
  return (
    <div className="hud-pause" onPointerDown={(e) => e.target === e.currentTarget && view.setPaused(false)}>
      <div className="hud-pause-card">
        <div className="hud-pause-sub">{track}</div>
        <div className="hud-pause-title">PAUSED</div>
        <button className="hud-pause-item primary" autoFocus onClick={() => view.setPaused(false)}>
          <span>Resume</span>
          <kbd>Esc</kbd>
        </button>
        <button className="hud-pause-item" onClick={onRestart}>
          <span>Restart race</span>
          <kbd>R</kbd>
        </button>
        <button className="hud-pause-item" onClick={onQuit}>
          <span>Quit to menu</span>
          <kbd>Q</kbd>
        </button>
        <VolumeControl className="hud-volume" />
      </div>
    </div>
  );
});
