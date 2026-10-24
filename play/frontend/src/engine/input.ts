// Keyboard and mouse state for the game canvas. Pointer lock when available; when the browser refuses it,
// dragging with the left button looks around and the keyboard fires instead.

export class Input {
  private readonly keys = new Set<string>();
  private readonly pressedOnce = new Set<string>();
  private dx = 0;
  private dy = 0;
  private buttons = 0;
  private clickedOnce = false;
  locked = false;
  /** Pointer lock was refused; use drag-to-look. */
  dragLook = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  enabled = true;
  sensitivity = 0.0022;

  constructor(private readonly target: HTMLElement) {
    target.tabIndex = 0;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
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
    this.target.removeEventListener('contextmenu', this.prevent);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  private prevent = (e: Event) => e.preventDefault();

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
      if (!this.locked && !this.dragLook) this.requestLock();
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
      this.dx += e.movementX;
      this.dy += e.movementY;
    } else if (this.dragging) {
      this.dx += e.clientX - this.lastX;
      this.dy += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  };
  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.target;
  };
  private onLockError = () => {
    this.locked = false;
    this.dragLook = true;
  };

  requestLock() {
    try {
      const p = this.target.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions) as unknown as Promise<void> | undefined;
      p?.catch?.(() => (this.dragLook = true));
    } catch {
      this.dragLook = true;
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

  /** Mouse delta since the last call. */
  look() {
    const d = { dx: this.dx * this.sensitivity, dy: this.dy * this.sensitivity };
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  /** Left button held (fires rockets). In drag-look mode the keyboard fires instead. */
  fire() {
    if (this.dragLook) return this.keys.has('KeyF') || this.keys.has('ControlLeft') || this.keys.has('ControlRight');
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
  }
}
