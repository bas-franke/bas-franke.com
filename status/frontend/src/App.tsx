import { useCallback, useEffect, useState } from 'react';
import Art from './Art';
import Login from './Login';
import type { CheckGroup, CheckResult, CheckStatus, Fix, Report } from './types';

const POLL_MS = 60_000;

const LABEL: Record<CheckStatus, string> = { ok: 'OK', warn: 'Warning', fail: 'Action needed', skip: 'Skipped' };

const HEADLINE: Record<CheckStatus, string> = {
  ok: 'All systems operational',
  warn: 'Running, with a few warnings',
  fail: 'Some things need your attention',
  skip: 'Nothing to check yet',
};

const PROVIDER_ART: Record<string, string> = {
  'name.com': 'provider-dns',
  AWS: 'provider-aws',
  GitHub: 'provider-github',
  Server: 'provider-server',
  "Let's Encrypt": 'provider-tls',
  Status: 'provider-status',
};

function worst(checks: CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  if (checks.every((c) => c.status === 'skip')) return 'skip';
  return 'ok';
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
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

  return (
    <div className="app">
      <nav className="topbar">
        <div className="brand">
          <Art name="mascot" className="brand-mascot" />
          <span className="mono">
            bas-franke<span className="accent">.com</span>/status
          </span>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => load(true)} disabled={loading}>
            <span className={loading ? 'spin' : ''}>↻</span> {loading ? 'Checking…' : 'Check now'}
          </button>
          {user && (
            <button className="btn btn-ghost" onClick={logout} title={`Signed in as ${user}`}>
              Sign out
            </button>
          )}
        </div>
      </nav>

      <main className="page">
        {error && (
          <section className="state-card">
            <Art name="state-offline" className="state-art" />
            <h2>Can't reach the status API</h2>
            <p className="muted">{error}</p>
            <p className="muted">
              If this persists, the status backend is down. On the server run <code>pm2 logs status --lines 50</code>.
            </p>
          </section>
        )}

        {!report && !error && (
          <section className="state-card">
            <Art name="state-loading" className="state-art" />
            <h2>Running checks…</h2>
            <p className="muted">Pinging DNS, certificates, servers and deploys.</p>
          </section>
        )}

        {report && <Overview report={report} />}
        {report && <h2 className="section-label">Infrastructure &amp; projects</h2>}
        {report && report.groups.map((g) => <Group key={g.id} group={g} />)}
      </main>

      <footer className="footer">
        <Art name="footer-cat" className="footer-cat" />
        <p className="mono muted">checks run every 60s · 200 OK is a lifestyle</p>
      </footer>
    </div>
  );
}

function Overview({ report }: { report: Report }) {
  const checks = report.groups.flatMap((g) => g.checks);
  const overall = worst(checks);
  const counted = checks.filter((c) => c.status !== 'skip').length;
  const passing = report.summary.ok;
  const pct = counted ? Math.round((passing / counted) * 100) : 100;

  return (
    <section className={`hero hero-${overall}`}>
      <div className="hero-text">
        <span className={`status-tag tag-${overall}`}>
          <span className="pulse" /> {LABEL[overall]}
        </span>
        <h1>{HEADLINE[overall]}</h1>
        <p className="muted">
          {passing} of {counted} checks passing · checked {timeAgo(report.generatedAt)} in{' '}
          {(report.durationMs / 1000).toFixed(1)}s
        </p>
        <div className="progress" aria-label={`${pct}% of checks passing`}>
          <span className={`progress-bar bar-${overall}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="stats">
          {(['fail', 'warn', 'ok', 'skip'] as const).map((s) => (
            <div key={s} className={`stat stat-${s}`}>
              <span className="stat-value">{report.summary[s]}</span>
              <span className="stat-label">{LABEL[s]}</span>
            </div>
          ))}
        </div>
      </div>
      <Art name={`state-${overall === 'skip' ? 'ok' : overall}`} className="hero-art" />
    </section>
  );
}

function Group({ group }: { group: CheckGroup }) {
  const status = worst(group.checks);
  const counted = group.checks.filter((c) => c.status !== 'skip');
  const passing = counted.filter((c) => c.status === 'ok').length;
  // Fully green groups start collapsed so problems stand out.
  const [open, setOpen] = useState(status !== 'ok');

  return (
    <section className="group">
      <button className="group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="group-icon">
          <Art name={`group-${group.id}`} fallback="group-default" />
        </span>
        <span className="group-title">
          <h2>{group.title}</h2>
          {group.subtitle && <span className="muted small mono">{group.subtitle}</span>}
        </span>
        <span className={`count-pill tag-${status}`}>
          {passing}/{counted.length} passing
        </span>
        <span className={`chevron ${open ? 'chevron-open' : ''}`}>›</span>
      </button>
      {open && (
        <ul className="checks">
          {group.checks.map((c) => (
            <Check key={c.id} check={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Check({ check }: { check: CheckResult }) {
  return (
    <li className={`check check-${check.status}`}>
      <span className={`dot dot-${check.status}`} title={LABEL[check.status]} />
      <div className="check-body">
        <div className="check-row">
          <span className="check-title">{check.title}</span>
          <span className="provider">
            <Art name={PROVIDER_ART[check.provider] ?? 'provider-status'} className="provider-icon" />
            {check.provider}
          </span>
        </div>
        <p className="detail mono">{check.detail}</p>
        {check.fix && <FixBlock fix={check.fix} open={check.status === 'fail'} />}
      </div>
    </li>
  );
}

function FixBlock({ fix, open }: { fix: Fix; open: boolean }) {
  return (
    <details className="fix" open={open}>
      <summary>
        <span className="fix-label">How to fix</span> {fix.summary}
      </summary>
      <ol>
        {fix.steps.map((step, i) => (
          <li key={i}>
            <p>{step.text}</p>
            {step.code && <CodeBlock code={step.code} />}
          </li>
        ))}
      </ol>
      {fix.doc && (
        <a className="doc-link" href={fix.doc} target="_blank" rel="noreferrer">
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
        className="copy"
        onClick={() =>
          navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}
