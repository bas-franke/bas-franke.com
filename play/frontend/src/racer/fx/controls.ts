// Player controls: keyboard (WASD / arrows, Space or Shift to boost, S/Down for the air brakes, C to look back),
// gamepad (right trigger throttle, left trigger air brakes, left stick or d-pad to steer, A or RB to boost, Y or the
// right stick pushed down to look back) and touch (on-screen pads set `touch`). Digital steering ramps in and out so a
// key tap is a small correction and a hold a full turn; an analog stick gets a soft centre and only light smoothing.
// Owned by the feel agent.

import type { PodInput } from '../core/physics';

/** Shared with the chase camera: whether the player is holding look-back. */
export const lookState = { back: false };

const DEADZONE = 0.12;

export class Controls {
  private keys = new Set<string>();
  private steer = 0;
  /** Set by on-screen touch controls. */
  touch = { steer: 0, throttle: 0, brake: 0, boost: false, active: false };
  private readonly down = (e: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };
  private readonly up = (e: KeyboardEvent) => this.keys.delete(e.code);
  private readonly blur = () => this.keys.clear();

  constructor() {
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', this.blur);
  }

  read(dt: number): PodInput {
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    let throttle = k('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = k('KeyS', 'ArrowDown') ? 1 : 0;
    let steerTarget = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    let boost = k('Space', 'ShiftLeft', 'ShiftRight');
    let back = k('KeyC');
    let analog = false;

    const pad = navigator.getGamepads?.().find((g) => g && g.connected);
    if (pad) {
      const b = (i: number) => pad.buttons[i]?.value ?? 0;
      const pressed = (i: number) => !!pad.buttons[i]?.pressed;
      throttle = Math.max(throttle, b(7));
      brake = Math.max(brake, b(6));
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > DEADZONE) {
        // Rescale past the dead zone, with a gentle curve for fine control around the centre.
        const m = (Math.abs(ax) - DEADZONE) / (1 - DEADZONE);
        steerTarget = Math.sign(ax) * Math.pow(m, 1.4);
        analog = true;
      }
      if (pressed(14)) steerTarget = -1;
      if (pressed(15)) steerTarget = 1;
      boost = boost || pressed(0) || pressed(5);
      back = back || pressed(3) || pressed(11);
    }
    if (this.touch.active) {
      throttle = Math.max(throttle, this.touch.throttle);
      brake = Math.max(brake, this.touch.brake);
      if (this.touch.steer) {
        steerTarget = this.touch.steer;
        analog = true;
      }
      boost = boost || this.touch.boost;
    }
    lookState.back = back;

    if (analog) {
      this.steer += (steerTarget - this.steer) * (1 - Math.exp(-dt * 18));
    } else {
      // Keys: ramp towards full lock, snap back faster, and reverse faster still.
      const reversing = steerTarget !== 0 && Math.sign(steerTarget) !== Math.sign(this.steer) && this.steer !== 0;
      const rate = reversing ? 10 : steerTarget === 0 ? 7 : 4.5;
      this.steer += Math.max(-rate * dt, Math.min(rate * dt, steerTarget - this.steer));
    }
    return { throttle, brake, steer: this.steer, boost };
  }

  pressed(code: string) {
    return this.keys.has(code);
  }

  dispose() {
    lookState.back = false;
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.blur);
  }
}
