import { useEffect, useState } from 'react';
import { useStore } from '../store';

/** Subtle "saved" state: Saving… while edits are unsent, Saved just now after, Offline when the live link is down. */
export function SaveStatus({ compact = false }: { compact?: boolean }) {
  const pending = useStore((s) => s.pending);
  const savedAt = useStore((s) => s.savedAt);
  const live = useStore((s) => s.live);
  const error = useStore((s) => s.error);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const recent = savedAt && Date.now() - savedAt < 4000;
  const text = error ? 'Could not save, retrying' : pending ? 'Saving…' : recent ? 'Saved' : live ? 'All saved' : 'Offline';
  const mood = error ? 'bad' : pending ? 'busy' : live ? 'ok' : 'off';
  return (
    <span className={`save-status ${mood}${compact ? ' compact' : ''}`} role="status" aria-live="polite">
      <i className="dot" />
      {text}
      {!compact && live && <small>live</small>}
    </span>
  );
}
