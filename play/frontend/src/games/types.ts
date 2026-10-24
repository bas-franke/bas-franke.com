// What the room page needs from a game client, and a tiny store for HUD state.

import { useSyncExternalStore } from 'react';
import type { GameServerMsg, RoomView } from '@shared/protocol';
import type { RoomSocket } from '../net/socket';

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((prev: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const s of subs) s();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface ClientContext {
  you: string;
  socket: RoomSocket;
  /** Latest room view: names and colours of everyone. */
  room(): RoomView;
  /** Ask the room page to leave the match (back to the waiting room UI). */
  leave(): void;
}

export interface GameClient {
  mount(container: HTMLElement): void;
  unmount(): void;
  onMessage(m: GameServerMsg): void;
  onRoom(room: RoomView): void;
  /** Called by the HUD when the escape menu opens/closes so the game can release the pointer. */
  setPaused(paused: boolean): void;
}
