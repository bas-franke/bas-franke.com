import { useState } from 'react';

type State = 'idle' | 'busy' | 'failed';

interface Props {
  /** 'primary' is the big hero button, 'nav' the small pill in the header. */
  variant?: 'primary' | 'nav';
}

/** Builds the PDF résumé on demand; the PDF code and pdf-lib only load when clicked. */
export default function ResumeButton({ variant = 'primary' }: Props) {
  const [state, setState] = useState<State>('idle');

  async function onClick() {
    setState('busy');
    try {
      const { downloadResume } = await import('../resumeDownload');
      await downloadResume();
      setState('idle');
    } catch (err) {
      console.error('résumé: building the PDF failed', err);
      setState('failed');
    }
  }

  const idle = variant === 'nav' ? 'Résumé' : 'Download résumé';
  const label = state === 'busy' ? 'Preparing…' : state === 'failed' ? 'Try again' : idle;
  const className = variant === 'nav' ? 'btn btn--small btn--nav' : 'btn btn--primary';

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={state === 'busy'}
      aria-live="polite"
      title="Download my résumé as a PDF"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 2v8m0 0 3.5-3.5M8 10 4.5 6.5M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}
