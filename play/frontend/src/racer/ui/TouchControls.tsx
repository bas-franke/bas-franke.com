// On-screen touch controls for phones: a horizontal steering stick anywhere on the left half (it appears where the
// thumb lands), and a pedal cluster on the right (THRUST, BRAKE, BOOST) that hit-tests the thumb as it slides so one
// thumb can roll from thrust onto boost. Writes straight into `view.touch`; no React state on the hot path.

import { memo, useEffect, useRef } from 'react';
import type { RaceView } from '../RaceView';

/** Pixels of thumb travel for full lock. */
const STICK_RANGE = 56;

export const TouchControls = memo(function TouchControls({ view }: { view: RaceView }) {
  const stick = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const pedals = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = view.touch;
    t.active = true;
    const stickEl = stick.current!;
    const knobEl = knob.current!;
    const pedalEl = pedals.current!;
    let steerId = -1;
    let ox = 0;
    let oy = 0;
    // Pointers on the pedal cluster and which button each is over.
    const over = new Map<number, string | null>();

    const showStick = (x: number, y: number, dx: number) => {
      stickEl.style.opacity = '1';
      stickEl.style.transform = `translate(${x}px, ${y}px)`;
      knobEl.style.transform = `translateX(${dx}px)`;
    };
    const zone = stickEl.parentElement!;
    const steerDown = (e: PointerEvent) => {
      if (steerId !== -1) return;
      steerId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      showStick(ox, oy, 0);
      e.preventDefault();
    };
    const steerMove = (e: PointerEvent) => {
      if (e.pointerId !== steerId) return;
      const r = zone.getBoundingClientRect();
      let dx = e.clientX - r.left - ox;
      // Let the stick follow the thumb if it drags past the range, so reversing is instant.
      if (Math.abs(dx) > STICK_RANGE) {
        ox += dx - Math.sign(dx) * STICK_RANGE;
        dx = Math.sign(dx) * STICK_RANGE;
      }
      t.steer = dx / STICK_RANGE;
      showStick(ox, oy, dx);
    };
    const steerUp = (e: PointerEvent) => {
      if (e.pointerId !== steerId) return;
      steerId = -1;
      t.steer = 0;
      stickEl.style.opacity = '';
      knobEl.style.transform = '';
    };

    const apply = () => {
      const held = new Set(over.values());
      t.throttle = held.has('thrust') || held.has('boost') ? 1 : 0;
      t.brake = held.has('brake') ? 1 : 0;
      t.boost = held.has('boost');
      for (const b of pedalEl.querySelectorAll<HTMLElement>('[data-btn]')) b.classList.toggle('on', held.has(b.dataset.btn!));
    };
    const hit = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      return el?.closest<HTMLElement>('[data-btn]')?.dataset.btn ?? null;
    };
    const pedalDown = (e: PointerEvent) => {
      pedalEl.setPointerCapture(e.pointerId);
      over.set(e.pointerId, hit(e.clientX, e.clientY));
      apply();
      e.preventDefault();
    };
    const pedalMove = (e: PointerEvent) => {
      if (!over.has(e.pointerId)) return;
      const b = hit(e.clientX, e.clientY);
      // Sliding off every button keeps the last one held (thumbs drift).
      if (b && b !== over.get(e.pointerId)) {
        over.set(e.pointerId, b);
        apply();
      }
    };
    const pedalUp = (e: PointerEvent) => {
      over.delete(e.pointerId);
      apply();
    };

    zone.addEventListener('pointerdown', steerDown);
    zone.addEventListener('pointermove', steerMove);
    zone.addEventListener('pointerup', steerUp);
    zone.addEventListener('pointercancel', steerUp);
    pedalEl.addEventListener('pointerdown', pedalDown);
    pedalEl.addEventListener('pointermove', pedalMove);
    pedalEl.addEventListener('pointerup', pedalUp);
    pedalEl.addEventListener('pointercancel', pedalUp);
    return () => {
      zone.removeEventListener('pointerdown', steerDown);
      zone.removeEventListener('pointermove', steerMove);
      zone.removeEventListener('pointerup', steerUp);
      zone.removeEventListener('pointercancel', steerUp);
      pedalEl.removeEventListener('pointerdown', pedalDown);
      pedalEl.removeEventListener('pointermove', pedalMove);
      pedalEl.removeEventListener('pointerup', pedalUp);
      pedalEl.removeEventListener('pointercancel', pedalUp);
      Object.assign(t, { steer: 0, throttle: 0, brake: 0, boost: false, active: false });
    };
  }, [view]);

  return (
    <div className="hud-touch">
      <div className="hud-touch-steer">
        <div className="hud-stick" ref={stick}>
          <span className="hud-stick-arrow l">‹</span>
          <div className="hud-stick-knob" ref={knob} />
          <span className="hud-stick-arrow r">›</span>
        </div>
        <div className="hud-touch-steer-hint">‹ STEER ›</div>
      </div>
      <div className="hud-pedals" ref={pedals}>
        <button className="hud-pedal boost" data-btn="boost" tabIndex={-1}>BOOST</button>
        <button className="hud-pedal brake" data-btn="brake" tabIndex={-1}>BRAKE</button>
        <button className="hud-pedal thrust" data-btn="thrust" tabIndex={-1}>THRUST</button>
      </div>
    </div>
  );
});
