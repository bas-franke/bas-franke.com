import { useState } from 'react';

type State = 'idle' | 'busy' | 'failed';

/** Builds the PDF résumé on demand; the PDF code and pdf-lib only load when clicked. */
export default function ResumeButton() {
  const [state, setState] = useState<State>('idle');

  async function onClick() {
    setState('busy');
    try {
      const { downloadResume } = await import('../resume');
      await downloadResume();
      setState('idle');
    } catch (err) {
      console.error('résumé: building the PDF failed', err);
      setState('failed');
    }
  }

  const label = state === 'busy' ? 'Preparing…' : state === 'failed' ? 'Try again' : 'Download résumé';

  return (
    <button type="button" className="link link--button" onClick={onClick} disabled={state === 'busy'} aria-live="polite">
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 2v8m0 0 3.5-3.5M8 10 4.5 6.5M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}
