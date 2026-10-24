// Keyboard and gamepad navigation for the menus. Arrow keys / d-pad / left stick move the focus spatially to the
// nearest focusable element in that direction, Enter / Space / A press it, Escape / B goes back. The root gets the
// class `dr-kbd` while the keyboard or a pad is in use so the focus highlight only shows then (touch and mouse users
// never see a stray ring).

import { useEffect, useRef } from 'react';
import { menuAudio } from '../audio/menu';

type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]';

function visible(el: HTMLElement) {
  if (el.closest('[inert]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The focusable elements inside `root`; when a modal layer is open only its contents count. */
function candidates(root: HTMLElement): HTMLElement[] {
  const layers = root.querySelectorAll<HTMLElement>('[data-nav-layer]');
  const scope = layers.length ? layers[layers.length - 1] : root;
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

/** Focuses the screen's preferred element (data-autofocus), or the first one. */
export function focusFirst(root: HTMLElement) {
  const list = candidates(root);
  const pick = list.find((el) => el.hasAttribute('data-autofocus')) ?? list[0];
  pick?.focus({ preventScroll: true });
  pick?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function moveFocus(root: HTMLElement, dir: Dir): boolean {
  const list = candidates(root);
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !list.includes(cur)) {
    focusFirst(root);
    return true;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    // Distance along the direction (must be ahead of the current element) and across it (penalised).
    let along: number;
    let across: number;
    if (dir === 'up' || dir === 'down') {
      along = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      if ((dir === 'down' ? by - ay : ay - by) <= 2) continue;
      // Overlapping columns count as straight ahead.
      across = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 ? 0 : Math.abs(bx - ax);
    } else {
      along = dir === 'right' ? b.left - a.right : a.left - b.right;
      if ((dir === 'right' ? bx - ax : ax - bx) <= 2) continue;
      across = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0 ? 0 : Math.abs(by - ay);
    }
    const score = Math.max(-20, along) + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return false;
  best.focus({ preventScroll: true });
  best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

function isTextInput(el: Element | null) {
  return el instanceof HTMLInputElement && el.type !== 'button' && el.type !== 'checkbox';
}

/**
 * Wires keyboard and gamepad navigation to a menu root. `onBack` runs for Escape / B. `screenKey` changes when the
 * screen changes: the preferred element of the new screen gets the focus.
 */
export function useMenuNav(root: React.RefObject<HTMLElement | null>, onBack: () => void, screenKey: string) {
  const back = useRef(onBack);
  back.current = onBack;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // Let the screen render (and lay out) first.
    const id = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !el.contains(active) || !visible(active as HTMLElement)) focusFirst(el);
    });
    return () => cancelAnimationFrame(id);
  }, [root, screenKey]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const kbd = (on: boolean) => el.classList.toggle('dr-kbd', on);
    const dirs: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const onKey = (e: KeyboardEvent) => {
      const typing = isTextInput(document.activeElement);
      if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) {
        e.preventDefault();
        menuAudio.back();
        back.current();
        return;
      }
      const d = dirs[e.key];
      if (d && !(typing && (d === 'left' || d === 'right'))) {
        e.preventDefault();
        kbd(true);
        if (moveFocus(el, d)) menuAudio.hover();
      } else if (e.key === 'Tab') kbd(true);
    };
    const onPointer = () => kbd(false);
    // Clicks on enabled buttons confirm; hovering a new button ticks.
    const onClick = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b && !b.disabled && el.contains(b) && !b.classList.contains('dr-back')) menuAudio.select();
    };
    let hovered: Element | null = null;
    const onOver = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest('button:not(:disabled)');
      if (b !== hovered) {
        hovered = b;
        if (b) menuAudio.hover();
      }
    };
    el.addEventListener('click', onClick);
    el.addEventListener('mouseover', onOver);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);

    // Gamepad: poll, with key-repeat style delays on held directions.
    let raf = 0;
    let held: Dir | null = null;
    let next = 0;
    let prevA = true;
    let prevB = true;
    const poll = (now: number) => {
      raf = requestAnimationFrame(poll);
      const pads = navigator.getGamepads?.() ?? [];
      const pad = [...pads].find((p) => p && p.connected);
      if (!pad) return;
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const dir: Dir | null = b(12) || ay < -0.6 ? 'up' : b(13) || ay > 0.6 ? 'down' : b(14) || ax < -0.6 ? 'left' : b(15) || ax > 0.6 ? 'right' : null;
      if (dir && (dir !== held || now >= next)) {
        next = now + (dir === held ? 110 : 320);
        held = dir;
        kbd(true);
        if (moveFocus(el, dir)) menuAudio.hover();
      } else if (!dir) held = null;
      const A = b(0);
      const B = b(1);
      if (A && !prevA) {
        kbd(true);
        const active = document.activeElement as HTMLElement | null;
        if (active && el.contains(active)) active.click();
        else focusFirst(el);
      }
      if (B && !prevB) {
        menuAudio.back();
        back.current();
      }
      prevA = A;
      prevB = B;
    };
    raf = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      el.removeEventListener('click', onClick);
      el.removeEventListener('mouseover', onOver);
      cancelAnimationFrame(raf);
    };
  }, [root]);
}
