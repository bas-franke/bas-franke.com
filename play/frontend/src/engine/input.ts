// Keyboard and mouse state for the game canvas. Pointer lock when available; when the browser refuses it,
// dragging with the left button looks around and the keyboard fires instead. Chrome refuses a new lock for about a
// second after Esc, so one refusal is not taken as "unsupported": only three in a row switch to drag-look, and a
// click still retries the lock (at most once a second) in drag-look mode.
//
// Games can bind named actions to codes: `KeyboardEvent.code` values, `Mouse0`..`Mouse4` for buttons (only while the
// pointer is locked) and `WheelUp` / `WheelDown`, which read as held for one poll per wheel notch (bunny hop on the
// wheel). Raw mouse input asks for pointer lock with `unadjustedMovement` (no OS acceleration) and falls back to a
// plain lock where the browser does not support it.

export type Bindings = Record<string, readonly string[]>;

export class Input {
  private readonly keys = new Set<string>();
  private readonly pressedOnce = new Set<string>();
  private dx = 0;
  private dy = 0;
  private buttons = 0;
  private clickedOnce = false;
  private wheelUp = false;
  private wheelDown = false;
  locked = false;
  /** Pointer lock was refused; use drag-to-look. */
  dragLook = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  /** A promise-based lock request is in flight; its rejection decides what a `pointerlockerror` means. */
  private requesting = false;
  /** Lock refusals in a row; three switch to drag-look. */
  private failures = 0;
  private lastRequest = -Infinity;
  enabled = true;
  /** Radians per mouse count. */
  sensitivity = 0.0022;
  invertY = false;
  /** Ask for raw (unaccelerated) movement when locking the pointer. */
  rawInput = true;
  /** False once the browser said it cannot do raw movement; true while a raw lock is held. */
  rawSupported: boolean | null = null;
  bindings: Bindings = {};
  private readonly delta = { dx: 0, dy: 0 };

  constructor(private readonly target: HTMLElement) {
    target.tabIndex = 0;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('contextmenu', this.prevent);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.target.removeEventListener('wheel', this.onWheel);
    this.target.removeEventListener('contextmenu', this.prevent);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  private prevent = (e: Event) => e.preventDefault();

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (!this.keys.has(e.code)) this.pressedOnce.add(e.code);
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private onBlur = () => {
    this.keys.clear();
    this.buttons = 0;
    this.dragging = false;
  };
  private onMouseDown = (e: MouseEvent) => {
    if (!this.enabled) return;
    this.target.focus();
    this.buttons |= 1 << e.button;
    if (e.button === 0) {
      this.clickedOnce = true;
      if (!this.locked && performance.now() - this.lastRequest >= 1000) this.requestLock();
      if (this.dragLook) {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    }
    e.preventDefault();
  };
  private onMouseUp = (e: MouseEvent) => {
    this.buttons &= ~(1 << e.button);
    if (e.button === 0) this.dragging = false;
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (this.locked) {
      // Browsers can report one huge jump as the lock engages; no real flick moves this far in one event.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    } else if (this.dragging) {
      this.dx += e.clientX - this.lastX;
      this.dy += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  };
  private onWheel = (e: WheelEvent) => {
    if (!this.enabled || !this.locked) return;
    e.preventDefault();
    if (e.deltaY > 0) this.wheelDown = true;
    else if (e.deltaY < 0) this.wheelUp = true;
  };
  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.target;
    if (this.locked) {
      this.failures = 0;
      this.dragLook = false;
      this.dragging = false;
    }
  };
  private onLockError = () => {
    this.locked = false;
    // A promise-based request reports through its rejection (which can retry without raw input).
    if (!this.requesting) this.lockFailed();
  };
  private lockFailed() {
    if (++this.failures >= 3) this.dragLook = true;
  }

  requestLock() {
    this.lastRequest = performance.now();
    const raw = this.rawInput && this.rawSupported !== false;
    try {
      const p = (raw
        ? this.target.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions)
        : this.target.requestPointerLock()) as unknown as Promise<void> | undefined;
      if (!p?.then) return;
      this.requesting = true;
      p.then(
        () => {
          this.requesting = false;
          if (raw) this.rawSupported = true;
        },
        (err: unknown) => {
          this.requesting = false;
          if (raw && (err as { name?: string } | null)?.name === 'NotSupportedError') {
            // No raw movement on this platform: lock without it.
            this.rawSupported = false;
            this.requestLock();
          } else this.lockFailed();
        },
      );
    } catch {
      this.lockFailed();
    }
  }

  exitLock() {
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  down(code: string) {
    return this.keys.has(code);
  }

  /** True once per key press. */
  once(code: string) {
    if (this.pressedOnce.has(code)) {
      this.pressedOnce.delete(code);
      return true;
    }
    return false;
  }

  /** One bound code held. Mouse buttons count only while locked; a wheel notch counts once. */
  private codeDown(code: string) {
    if (code.startsWith('Mouse')) return this.locked && (this.buttons & (1 << (code.charCodeAt(5) - 48))) !== 0;
    if (code === 'WheelDown') {
      const w = this.wheelDown;
      this.wheelDown = false;
      return w;
    }
    if (code === 'WheelUp') {
      const w = this.wheelUp;
      this.wheelUp = false;
      return w;
    }
    return this.keys.has(code);
  }

  /** Any code bound to `action` held. */
  held(action: string) {
    const codes = this.bindings[action];
    if (!codes) return false;
    let on = false;
    // No early exit: every bound wheel pulse is consumed in the same poll.
    for (let i = 0; i < codes.length; i++) if (this.codeDown(codes[i])) on = true;
    return on;
  }

  /** -1..1 from a pair of bound actions. */
  actionAxis(neg: string, pos: string) {
    return (this.held(pos) ? 1 : 0) - (this.held(neg) ? 1 : 0);
  }

  /** Mouse delta since the last call, in radians (the returned object is reused). */
  look() {
    this.delta.dx = this.dx * this.sensitivity;
    this.delta.dy = this.dy * this.sensitivity * (this.invertY ? -1 : 1);
    this.dx = 0;
    this.dy = 0;
    return this.delta;
  }

  /** Fire held: the `fire` binding (left button by default). In drag-look mode the keyboard fires instead. */
  fire() {
    if (this.dragLook) return this.keys.has('KeyF') || this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.held('fire');
    if (this.bindings.fire) return this.held('fire');
    return (this.buttons & 1) !== 0 && this.locked;
  }

  /** Left button press, once. */
  clicked() {
    const c = this.clickedOnce;
    this.clickedOnce = false;
    return c;
  }

  /** -1..1 from a pair of keys. */
  axis(neg: string[], pos: string[]) {
    let v = 0;
    if (neg.some((k) => this.keys.has(k))) v -= 1;
    if (pos.some((k) => this.keys.has(k))) v += 1;
    return v;
  }

  clearOnce() {
    this.pressedOnce.clear();
    this.clickedOnce = false;
    this.wheelUp = this.wheelDown = false;
  }
}
