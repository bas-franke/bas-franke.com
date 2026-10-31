import { useSyncExternalStore } from 'react';

// Portfolio numbers are blurred until the owner turns the blur off with the eye in the header. Default: blurred. Kept per browser.
const KEY = 'stonks-show-money';
const listeners = new Set<() => void>();

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== '1';
  } catch {
    return true;
  }
};

let hidden = read();
const apply = () => document.documentElement.setAttribute('data-hide-money', hidden ? '1' : '0');
// Apply before React renders so the numbers never flash.
apply();

export function usePrivacy() {
  const value = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => hidden,
  );
  const toggle = () => {
    hidden = !hidden;
    apply();
    try {
      if (hidden) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, '1');
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
    listeners.forEach((l) => l());
  };
  return { hidden: value, toggle };
}
