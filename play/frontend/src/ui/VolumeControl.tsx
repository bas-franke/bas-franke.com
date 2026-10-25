// The site-wide volume control: a mute button and a slider, bound to the shared setting in engine/audio.ts.
// Every game shows one in its menu; changing it anywhere changes it everywhere and is remembered.

import { useSyncExternalStore } from 'react';
import { sfx } from '../engine/audio';

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export const useVolume = () => useSyncExternalStore(sfx.subscribe, sfx.snapshot, sfx.snapshot);

export function VolumeControl({ className = '', label = 'Volume' }: { className?: string; label?: string }) {
  const { volume, muted } = useVolume();
  const level = muted ? 0 : volume;
  return (
    <div className={`volume-control ${className}`}>
      <button type="button" className="volume-mute" aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} onClick={() => sfx.setMuted(!muted)}>
        <SpeakerIcon level={level} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={level}
        aria-label={label}
        onChange={(e) => sfx.setVolume(+e.target.value)}
        // Arrow keys belong to the slider here, not to menu navigation or the game. Esc still reaches the menus.
        onKeyDown={(e) => SLIDER_KEYS.has(e.key) && e.stopPropagation()}
      />
      <span className="volume-val">{Math.round(level * 100)}%</span>
    </div>
  );
}

function SpeakerIcon({ level }: { level: number }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {level === 0 ? (
        <path d="M17 9l5 6M22 9l-5 6" />
      ) : (
        <>
          <path d="M16.5 9.5a3.5 3.5 0 0 1 0 5" />
          {level > 0.5 && <path d="M19 7a7 7 0 0 1 0 10" />}
        </>
      )}
    </svg>
  );
}
