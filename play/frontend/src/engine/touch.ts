// Touch controls state for phones and tablets: a floating virtual stick on the left half, drag-to-look on the right
// half, and hold buttons (fire, jump). Exposes the same surface the game reads from Input (look(), axis-like
// analog values, down(code), fire()) so a client can merge both sources. Pointer Events with one pointer per role,
// so any number of fingers can be down at once. No React state per move: the stick knob is styled directly.

/** True when the primary pointer is a finger (phones, tablets). Hybrid laptops start in mouse mode. */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches === true || ('ontouchstart' in window && navigator.maxTouchPoints > 0 && !window.matchMedia?.('(any-pointer: fine)').matches);
}

type Role = 'stick' | 'look' | 'fire' | 'jump';

interface Finger {
  role: Role;
  x: number;
  y: number;
}

/** Stick travel in CSS pixels before the value saturates, unless the overlay sets --stick-r. */
const STICK_RADIUS = 56;
const DEADZONE = 0.12;
/** Past this fraction of the radius the stick reads full speed (strafe jumping wants a clean 1). */
const SATURATE = 0.85;

export class TouchInput {
  private readonly fingers = new Map<number, Finger>();
  private dx = 0;
  private dy = 0;
  private stickX = 0;
  private stickY = 0;
  private originX = 0;
  private originY = 0;
  private rootX = 0;
  private rootY = 0;
  private radius = STICK_RADIUS;
  private root?: HTMLElement;
  private base?: HTMLElement;
  private knob?: HTMLElement;
  enabled = true;
  /** Radians per CSS pixel of finger travel. Higher than the mouse: a phone screen is small. */
  sensitivity = 0.0065;

  /** Bind to the overlay element. Children mark their role with data-touch="stick|look|fire|jump". */
  attach(root: HTMLElement) {
    this.detach();
    this.root = root;
    this.base = root.querySelector<HTMLElement>('[data-touch-base]') ?? undefined;
    this.knob = root.querySelector<HTMLElement>('[data-touch-knob]') ?? undefined;
    root.addEventListener('pointerdown', this.onDown);
    root.addEventListener('pointermove', this.onMove);
    root.addEventListener('pointerup', this.onUp);
    root.addEventListener('pointercancel', this.onUp);
    root.addEventListener('lostpointercapture', this.onUp);
    // Belt and braces next to touch-action: none, for browsers that still scroll, zoom or open menus.
    root.addEventListener('touchstart', this.prevent, { passive: false });
    root.addEventListener('touchmove', this.prevent, { passive: false });
    root.addEventListener('contextmenu', this.prevent);
    document.addEventListener('gesturestart', this.prevent);
    document.addEventListener('dblclick', this.prevent);
    window.addEventListener('blur', this.reset);
  }

  detach() {
    const root = this.root;
    if (!root) return;
    root.removeEventListener('pointerdown', this.onDown);
    root.removeEventListener('pointermove', this.onMove);
    root.removeEventListener('pointerup', this.onUp);
    root.removeEventListener('pointercancel', this.onUp);
    root.removeEventListener('lostpointercapture', this.onUp);
    root.removeEventListener('touchstart', this.prevent);
    root.removeEventListener('touchmove', this.prevent);
    root.removeEventListener('contextmenu', this.prevent);
    document.removeEventListener('gesturestart', this.prevent);
    document.removeEventListener('dblclick', this.prevent);
    window.removeEventListener('blur', this.reset);
    this.reset();
    this.root = this.base = this.knob = undefined;
  }

  private prevent = (e: Event) => {
    // Plain buttons (menu, scores) keep their taps.
    if (e.target instanceof Element && e.target.closest('[data-touch-ui]')) return;
    if (e.cancelable) e.preventDefault();
  };

  private reset = () => {
    this.fingers.clear();
    this.stickX = this.stickY = 0;
    this.dx = this.dy = 0;
    this.drawStick(false);
    this.root?.querySelectorAll('[data-touch].on').forEach((el) => el.classList.remove('on'));
  };

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if ((e.target as HTMLElement).closest('[data-touch-ui]')) return;
    e.preventDefault();
    if (!this.enabled) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-touch]');
    const role = (el?.dataset.touch as Role | undefined) ?? 'look';
    // One finger per stick; a second finger on the left half looks instead of stealing the stick.
    const taken = role === 'stick' && [...this.fingers.values()].some((f) => f.role === 'stick');
    const finger: Finger = { role: taken ? 'look' : role, x: e.clientX, y: e.clientY };
    this.fingers.set(e.pointerId, finger);
    try {
      this.root?.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety: without it a finger sliding off the overlay just ends early.
    }
    if (finger.role === 'stick') {
      const r = this.root?.getBoundingClientRect();
      this.rootX = r?.left ?? 0;
      this.rootY = r?.top ?? 0;
      if (this.root) this.radius = parseFloat(getComputedStyle(this.root).getPropertyValue('--stick-r')) || STICK_RADIUS;
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.stickX = this.stickY = 0;
      this.drawStick(true);
    } else if (finger.role === 'fire' || finger.role === 'jump') {
      el?.classList.add('on');
    }
  };

  private onMove = (e: PointerEvent) => {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    e.preventDefault();
    if (f.role === 'stick') {
      let x = (e.clientX - this.originX) / this.radius;
      let y = (e.clientY - this.originY) / this.radius;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      this.stickX = x;
      this.stickY = y;
      this.drawStick(true);
    } else if (this.enabled) {
      // Fire and jump double as look pads, so you can aim while holding the trigger or hopping.
      this.dx += e.clientX - f.x;
      this.dy += e.clientY - f.y;
    }
    f.x = e.clientX;
    f.y = e.clientY;
  };

  private onUp = (e: PointerEvent) => {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    if (f.role === 'stick') {
      this.stickX = this.stickY = 0;
      this.drawStick(false);
    } else if (f.role === 'fire' || f.role === 'jump') {
      const el = this.root?.querySelector(`[data-touch="${f.role}"]`);
      if (el && !this.held(f.role)) el.classList.remove('on');
    }
  };

  private drawStick(active: boolean) {
    const { base, knob } = this;
    if (!base || !knob) return;
    base.classList.toggle('on', active);
    // Floating stick: it centres under the finger; released, it goes back to its resting spot from the CSS.
    base.style.left = active ? `${this.originX - this.rootX}px` : '';
    base.style.top = active ? `${this.originY - this.rootY}px` : '';
    knob.style.transform = `translate(${this.stickX * this.radius}px, ${this.stickY * this.radius}px)`;
  }

  private held(role: Role) {
    for (const f of this.fingers.values()) if (f.role === role) return true;
    return false;
  }

  /** Any finger down (lets the HUD hide hints). */
  get active() {
    return this.fingers.size > 0;
  }

  /** Finger look delta since the last call, in radians, same shape as Input.look(). */
  look() {
    const d = { dx: this.dx * this.sensitivity, dy: this.dy * this.sensitivity };
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  /** Forward amount -1..1 (stick up is forward). */
  get f() {
    return this.shape(-this.stickY);
  }

  /** Strafe amount -1..1 (stick right is right). */
  get s() {
    return this.shape(this.stickX);
  }

  /** Deadzone and saturation per axis, keeping the stick's direction intact. */
  private shape(v: number) {
    const len = Math.hypot(this.stickX, this.stickY);
    if (len < DEADZONE) return 0;
    const scaled = Math.min(1, (len - DEADZONE) / (SATURATE - DEADZONE));
    return (v / len) * scaled;
  }

  /** Same contract as Input.down; only 'Space' (jump) maps to a touch button. */
  down(code: string) {
    return this.enabled && code === 'Space' && this.held('jump');
  }

  /** Fire button held. */
  fire() {
    return this.enabled && this.held('fire');
  }

  dispose() {
    this.detach();
  }
}
