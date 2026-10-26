import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Small "?" bubble with a plain-language explanation. Works with hover, focus and tap. */
export function Tip({ children, align }: { children: ReactNode; align?: 'left' }) {
  const id = useId();
  return (
    <span className={`tip${align === 'left' ? ' align-left' : ''}`}>
      <button type="button" aria-describedby={id} aria-label="What does this mean?">
        ?
      </button>
      <span role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <h2>{title}</h2>
          <div className="body">{children}</div>
          <div className="actions">{actions}</div>
        </>
      )}
    </dialog>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="knob">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 5v6" />
          <path d="M8 7.8a6 6 0 1 0 8 0" />
        </svg>
      </span>
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const ModeBadge = ({ mode }: { mode: string }) =>
  mode === 'live' ? (
    <span className="chip live pulse">
      <span className="dot" />
      Live money
    </span>
  ) : (
    <span className="chip brass">
      <span className="dot" />
      Paper
    </span>
  );

export function Skeleton({ h = 18, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} />;
}

// ---------- data loading ----------

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => n === seq.current && setState({ data, loading: false }),
      (error: Error) => n === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run, setData: (data: T) => setState({ data, loading: false }) };
}

/** Run `fn` every `ms` while the tab is visible. */
export function useVisibleInterval(fn: () => void, ms: number, enabled = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let t: number | undefined;
    const start = () => {
      stop();
      t = window.setInterval(() => saved.current(), ms);
    };
    const stop = () => t !== undefined && clearInterval(t);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        saved.current();
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms, enabled]);
}

// ---------- toast ----------

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="error-box row">
      <span>Couldn’t load this: {error.message}</span>
      <span className="spacer" />
      {onRetry && (
        <button className="btn small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
