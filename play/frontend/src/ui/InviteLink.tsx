// The room's invite link with a copy button: in the waiting room and in every game's pause menu. Clicks and keys
// inside it stop here, so copying never resumes a game, grabs pointer lock or types into the game's controls.

import { type KeyboardEvent, type SyntheticEvent, useEffect, useRef, useState } from 'react';
import './InviteLink.css';

/** `room` for the waiting room; `hud` a neutral dark pause card; the others match one game's pause menu. */
export type InviteVariant = 'room' | 'hud' | 'rockets' | 'll' | 'garden' | 'dustrunners';

export const roomLink = (code: string) => `${location.origin}/room/${code.toUpperCase()}`;

export function InviteLink({
  code,
  variant = 'hud',
  className = '',
  label = 'Invite friends',
  hint,
}: {
  code: string;
  variant?: InviteVariant;
  className?: string;
  label?: string;
  /** A line under the link; defaults to how joining mid-match works. */
  hint?: string | null;
}) {
  const url = roomLink(code);
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = (s: 'copied' | 'manual') => {
    setState(s);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), s === 'copied' ? 1600 : 4000);
  };

  /** Selecting the text is the fallback when the clipboard API is missing (http, old browsers) or refused. */
  const selectText = () => {
    const el = input.current;
    if (!el) return false;
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  };

  const copy = async (e: SyntheticEvent) => {
    e.stopPropagation();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      flash('copied');
    } catch {
      flash(selectText() ? 'copied' : 'manual');
    }
  };

  // Keep the game's window/document listeners out of it, except Escape (which still closes the menu).
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const stopKey = (e: KeyboardEvent) => e.key !== 'Escape' && e.stopPropagation();

  return (
    <div
      className={`invite-link invite-${variant} ${className}`.trim()}
      data-testid="invite-link"
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onKeyDown={stopKey}
      onKeyUp={stopKey}
    >
      <div className="invite-head">
        <span className="invite-label">{label}</span>
        <span className="invite-code" title="Room code">
          <span className="invite-code-label">Code</span>
          <b>{code.toUpperCase()}</b>
        </span>
      </div>
      <div className="invite-row">
        <input ref={input} className="invite-url" readOnly value={url} aria-label="Room link" onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
        <button type="button" className={`invite-copy${state === 'copied' ? ' copied' : ''}`} onClick={copy} data-testid="copy-invite">
          {state === 'copied' ? 'Copied' : state === 'manual' ? 'Press Ctrl+C' : 'Copy link'}
        </button>
      </div>
      {hint !== null && <p className="invite-hint">{hint ?? 'Friends can join any time; during a match they wait for the next one.'}</p>}
    </div>
  );
}
