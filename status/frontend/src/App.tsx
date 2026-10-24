import { useCallback, useEffect, useState } from 'react';
import Login from './Login';
import type { CheckGroup, CheckResult, CheckStatus, Fix, Report } from './types';

const POLL_MS = 60_000;

const LABEL: Record<CheckStatus, string> = { ok: 'OK', warn: 'Warning', fail: 'Action needed', skip: 'Skipped' };

function worst(checks: CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  if (checks.every((c) => c.status === 'skip')) return 'skip';
  return 'ok';
}

function timeAgo(iso: string) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

type Auth = { state: 'checking' } | { state: 'login' } | { state: 'in'; user: string | null };

export default function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });

  useEffect(() => {
    fetch('/api/me')
      .then(async (res) => {
        if (res.status === 401) return setAuth({ state: 'login' });
        const body = await res.json();
        setAuth({ state: 'in', user: body.user ?? null });
      })
      // Backend unreachable: show the dashboard, which explains the error.
      .catch(() => setAuth({ state: 'in', user: null }));
  }, []);

  if (auth.state === 'checking') return null;
  if (auth.state === 'login') return <Login onLogin={(user) => setAuth({ state: 'in', user })} />;
  return <Dashboard user={auth.user} onLoggedOut={() => setAuth({ state: 'login' })} />;
}

function Dashboard({ user, onLoggedOut }: { user: string | null; onLoggedOut: () => void }) {
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [, tick] = useState(0);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/status${refresh ? '?refresh=1' : ''}`);
        if (res.status === 401) return onLoggedOut();
        if (!res.ok) throw new Error(`The status API returned HTTP ${res.status}.`);
        setReport(await res.json());
        setError(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [onLoggedOut],
  );

  useEffect(() => {
    load();
    const poll = setInterval(() => load(), POLL_MS);
    const clock = setInterval(() => tick((n) => n + 1), 10_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  async function logout() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    onLoggedOut();
  }

  const overall = report ? worst(report.groups.flatMap((g) => g.checks)) : undefined;

  return (
    <main className="page">
      <header className="header">
        <div>
          <p className="eyebrow">bas-franke.com</p>
          <h1>System status</h1>
        </div>
        <div className="actions">
          <button className="refresh" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Checking…' : 'Check now'}
          </button>
          {user && (
            <button onClick={logout} title={`Signed in as ${user}`}>
              Sign out
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="banner banner-fail">
          <strong>Cannot load status.</strong> {error} If this persists, the status backend is down. On the server run{' '}
          <code>pm2 logs status --lines 50</code>.
        </div>
      )}

      {report && overall && (
        <>
          <div className={`banner banner-${overall}`}>
            <strong>
              {overall === 'ok' ? 'All systems operational' : overall === 'warn' ? 'Running, with warnings' : 'Setup incomplete or something is down'}
            </strong>
            <span className="counts">
              {(['fail', 'warn', 'ok', 'skip'] as const).map((s) =>
                report.summary[s] ? (
                  <span key={s} className={`count count-${s}`}>
                    {report.summary[s]} {LABEL[s].toLowerCase()}
                  </span>
                ) : null,
              )}
            </span>
            <span className="meta">
              Checked {timeAgo(report.generatedAt)} in {(report.durationMs / 1000).toFixed(1)}s
            </span>
          </div>

          {report.groups.map((g) => (
            <Group key={g.id} group={g} />
          ))}
        </>
      )}

      {!report && !error && <p className="muted">Running checks…</p>}
    </main>
  );
}

function Group({ group }: { group: CheckGroup }) {
  const status = worst(group.checks);
  return (
    <section className="group">
      <div className="group-head">
        <span className={`dot dot-${status}`} />
        <h2>{group.title}</h2>
        {group.subtitle && <span className="muted small">{group.subtitle}</span>}
      </div>
      <ul className="checks">
        {group.checks.map((c) => (
          <Check key={c.id} check={c} />
        ))}
      </ul>
    </section>
  );
}

function Check({ check }: { check: CheckResult }) {
  return (
    <li className={`check check-${check.status}`}>
      <div className="check-row">
        <span className={`pill pill-${check.status}`}>{LABEL[check.status]}</span>
        <span className="check-title">{check.title}</span>
        <span className="provider">{check.provider}</span>
      </div>
      <p className="detail">{check.detail}</p>
      {check.fix && <FixBlock fix={check.fix} open={check.status === 'fail'} />}
    </li>
  );
}

function FixBlock({ fix, open }: { fix: Fix; open: boolean }) {
  return (
    <details className="fix" open={open}>
      <summary>How to fix: {fix.summary}</summary>
      <ol>
        {fix.steps.map((step, i) => (
          <li key={i}>
            <p>{step.text}</p>
            {step.code && <CodeBlock code={step.code} />}
          </li>
        ))}
      </ol>
      {fix.doc && (
        <a href={fix.doc} target="_blank" rel="noreferrer">
          Full instructions ↗
        </a>
      )}
    </details>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <pre>{code}</pre>
      <button
        onClick={() =>
          navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
