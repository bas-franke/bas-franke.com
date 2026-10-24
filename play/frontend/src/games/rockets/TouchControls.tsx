import { useEffect, useRef, useState } from 'react';
import { isTouchDevice, type TouchInput } from '../../engine/touch';
import { FullscreenIcon, useFullscreen } from '../../ui/fullscreen';
import './touch.css';

/** True while the player is using a touchscreen. Starts from the device type, then follows the last pointer used. */
export function useTouchMode() {
  const [touch, setTouch] = useState(isTouchDevice);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setTouch(true);
      else if (e.pointerType === 'mouse') setTouch(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);
  return touch;
}

/**
 * On-screen controls for phones and tablets. Left half: a floating move stick. Right half: drag to look.
 * Fire and jump are hold buttons that also look while dragged. All event handling lives in TouchInput.
 * Ruckus uses the same overlay with one action button (`fireLabel="Dash!"`, no jump) and the menu buttons top left.
 */
export function TouchControls({
  touch,
  onMenu,
  onScores,
  fireLabel = 'Fire!',
  jump = true,
  className = '',
}: {
  touch: TouchInput;
  onMenu: () => void;
  onScores: (show: boolean) => void;
  fireLabel?: string;
  jump?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const fs = useFullscreen();

  useEffect(() => {
    if (!root.current) return;
    touch.attach(root.current);
    return () => touch.detach();
  }, [touch]);

  return (
    <div className={`touch ${className}`} ref={root}>
      <div className="touch-stick-zone" data-touch="stick" />
      <div className="touch-stick" data-touch-base>
        <div className="touch-knob" data-touch-knob />
      </div>
      {jump && (
        <div className="touch-btn touch-jump" data-touch="jump">
          <span>Jump</span>
        </div>
      )}
      <div className="touch-btn touch-fire" data-touch="fire">
        <span>{fireLabel}</span>
      </div>
      <div className="touch-ui">
        <button
          data-touch-ui
          aria-label="Scores"
          onPointerDown={() => onScores(true)}
          onPointerUp={() => onScores(false)}
          onPointerCancel={() => onScores(false)}
          onPointerLeave={() => onScores(false)}
        >
          ≡
        </button>
        <button data-touch-ui aria-label="Menu" onPointerDown={onMenu}>
          ❚❚
        </button>
        {fs.supported && (
          // A click, not pointerdown: browsers only grant fullscreen from a completed tap.
          <button data-touch-ui aria-label={fs.active ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => void fs.toggle()}>
            <FullscreenIcon active={fs.active} />
          </button>
        )}
      </div>
    </div>
  );
}
