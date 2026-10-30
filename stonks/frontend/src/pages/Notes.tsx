import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PageBanner } from '../components/art';
import { ErrorBox, Skeleton } from '../components/ui';
import './notes.css';

const DRAFT_KEY = 'stonks-notes-draft';
const MAX = 50_000;
const DEBOUNCE_MS = 400;

type Draft = { text: string; at: number };
type Phase = 'loading' | 'saving' | 'saved' | 'error';

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (!d || typeof d.text !== 'string' || typeof d.at !== 'number') return null;
    return d;
  } catch {
    return null;
  }
}

function writeDraft(text: string, at = Date.now()) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, at }));
  } catch {
    /* a full or blocked store still leaves the server copy */
  }
}

export default function NotesPage() {
  const [text, setText] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef('');
  const saved = useRef('');
  const known = useRef(false);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const pumpRef = useRef<() => Promise<void>>(async () => {});

  pumpRef.current = async () => {
    if (busy.current) return;
    const value = latest.current;
    if (value === saved.current) {
      if (alive.current) setPhase('saved');
      return;
    }
    busy.current = true;
    if (alive.current) setPhase('saving');
    try {
      await api.saveNotes(value);
      saved.current = value;
      known.current = true;
    } catch {
      busy.current = false;
      if (alive.current) setPhase('error');
      return;
    }
    busy.current = false;
    if (latest.current !== saved.current) void pumpRef.current();
    else if (alive.current) setPhase('saved');
  };

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void pumpRef.current();
    }, DEBOUNCE_MS);
  };

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    void pumpRef.current();
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (latest.current !== saved.current) void pumpRef.current();
    };
  }, []);

  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    const phone = window.matchMedia('(max-width: 760px)').matches;
    if (!meta || !phone) return;
    const previous = meta.getAttribute('content');
    meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', block, { passive: false });
    document.addEventListener('gesturechange', block, { passive: false });
    return () => {
      if (previous != null) meta.setAttribute('content', previous);
      document.removeEventListener('gesturestart', block);
      document.removeEventListener('gesturechange', block);
    };
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  useEffect(() => {
    let cancel = false;
    setLoadError(null);
    api.notes().then(
      (n) => {
        if (cancel) return;
        const local = readDraft();
        const serverAt = n.updatedAt ? Date.parse(n.updatedAt) : 0;
        const localNewer = !!local && local.text !== n.text && local.at > serverAt;
        const next = localNewer ? local.text : n.text;
        latest.current = next;
        saved.current = n.text;
        known.current = true;
        if (!localNewer) writeDraft(next, serverAt || Date.now());
        setText(next);
        setPhase(localNewer ? 'saving' : 'saved');
        if (localNewer) void pumpRef.current();
      },
      (e) => {
        if (cancel) return;
        const local = readDraft();
        if (local) {
          latest.current = local.text;
          saved.current = local.text;
          known.current = false;
          setText(local.text);
          setPhase('error');
          return;
        }
        setLoadError(e instanceof Error ? e : new Error('Could not load notes'));
      },
    );
    return () => {
      cancel = true;
    };
  }, [attempt]);

  if (loadError) return <ErrorBox error={loadError} onRetry={() => setAttempt((n) => n + 1)} />;
  if (text === null)
    return (
      <div className="stack notes-page">
        <Skeleton h={48} w="30%" />
        <Skeleton h={360} />
      </div>
    );

  const label = phase === 'saving' ? 'Saving…' : phase === 'error' ? (known.current ? 'Couldn’t save' : 'Couldn’t load') : phase === 'saved' ? 'Saved' : '';

  return (
    <div className="notes-page">
      <PageBanner
        art="banner-notes"
        eyebrow="Notes"
        title="Scratch pad"
        aside={
          <div className="notes-status" aria-live="polite">
            {label && <span className={phase === 'error' ? 'loss small' : 'muted small'}>{label}</span>}
            {phase === 'error' && (
              <button className="btn small" type="button" onClick={() => (known.current ? flush() : setAttempt((n) => n + 1))}>
                Try again
              </button>
            )}
          </div>
        }
      />
      <label className="sr-only" htmlFor="notes">
        Notes
      </label>
      <textarea
        id="notes"
        className="input notes-input"
        value={text}
        maxLength={MAX}
        placeholder="Write something…"
        autoFocus
        spellCheck
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          latest.current = next;
          writeDraft(next);
          if (next === saved.current) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            setPhase('saved');
            return;
          }
          setPhase('saving');
          schedule();
        }}
        onBlur={flush}
      />
    </div>
  );
}
