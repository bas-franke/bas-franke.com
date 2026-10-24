import { useCallback, useEffect, useState } from 'react';
import { AnalyticsPanel, HeadlineStats } from './Visitors';
import Art from './Art';
import Login from './Login';
import type { AnalyticsReport, CheckGroup, CheckResult, CheckStatus, Fix, Report, SiteAnalytics } from './types';

const POLL_MS = 60_000;

/** Visitor-number ranges offered above the project blocks (the backend accepts exactly these). */
const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
];

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

/** Shared infrastructure first, then the projects with the most visitors in the selected range. */
function orderGroups(groups: CheckGroup[], sites: Map<string, SiteAnalytics>) {
  const visitors = (g: CheckGroup) => sites.get(g.id)?.totals.visitors ?? -1;
  return [...groups].sort((a, b) => {
    if (a.id === 'shared') return -1;
    if (b.id === 'shared') return 1;
    return visitors(b) - visitors(a);
  });
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
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<AnalyticsReport>();
  const [analyticsError, setAnalyticsError] = useState<string>();
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
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

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const res = await fetch(`/api/analytics?days=${days}`);
      if (res.status === 401) return onLoggedOut();
      if (!res.ok) throw new Error(`The analytics API returned HTTP ${res.status}.`);
      setAnalytics(await res.json());
      setAnalyticsError(undefined);
    } catch (err) {
      setAnalyticsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyticsLoading(false);
    }
  }, [days, onLoggedOut]);

  useEffect(() => {
    load();
    const poll = setInterval(() => load(), POLL_MS);
    const clock = setInterval(() => tick((n) => n + 1), 10_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  useEffect(() => {
    loadAnalytics();
    const poll = setInterval(loadAnalytics, POLL_MS);
    return () => clearInterval(poll);
  }, [loadAnalytics]);

  async function logout() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    onLoggedOut();
  }

  const sites = new Map((analytics?.sites ?? []).map((s) => [s.site, s]));
  // Wait for the visitor numbers as well, so the project blocks appear in their final order straight away.
  const shown = report && (analytics || analyticsError) ? report : undefined;

  return (
    <div className="app">
      <nav className="topbar">
        <div className="brand">
          <Art name="mascot" className="brand-mascot" />
          <span className="mono">
            <span className="accent">status</span>.bas-franke.com
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

        {!shown && !error && (
          <section className="state-card">
            <Art name="state-loading" className="state-art" />
            <h2>Running checks…</h2>
            <p className="muted">Pinging DNS, certificates, servers and deploys.</p>
          </section>
        )}

        {shown && <Overview report={shown} />}

        {shown && (
          <div className="section-row">
            <h2 className="section-label">Infrastructure &amp; projects</h2>
            <div className="seg" role="group" aria-label="Visitor numbers for the last">
              {RANGES.map((r) => (
                <button key={r.days} className={days === r.days ? 'on' : ''} aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {shown && analytics && !analytics.enabled && <AnalyticsSetup analytics={analytics} />}
        {shown && analyticsError && <p className="muted small">Visitor numbers are unavailable: {analyticsError}</p>}

        {shown &&
          orderGroups(shown.groups, sites).map((g) => (
            <Group key={g.id} group={g} site={sites.get(g.id)} days={days} timezone={analytics?.timezone} dim={analyticsLoading} />
          ))}
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

/** Shown while the status backend has no database: page views are dropped until it gets one. */
function AnalyticsSetup({ analytics }: { analytics: AnalyticsReport }) {
  return (
    <section className="analytics-setup">
      <p>
        <strong>Visitor analytics are off.</strong> <span className="muted">{analytics.detail}</span>
      </p>
      {analytics.fix && <FixBlock fix={analytics.fix} open={false} />}
    </section>
  );
}

function Group({ group, site, days, timezone, dim }: { group: CheckGroup; site?: SiteAnalytics; days: number; timezone?: string; dim: boolean }) {
  const status = worst(group.checks);
  const counted = group.checks.filter((c) => c.status !== 'skip');
  const passing = counted.filter((c) => c.status === 'ok').length;
  // Blocks always start collapsed: the header already carries the state and the headline visitor numbers.
  const [open, setOpen] = useState(false);

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
        {site && <HeadlineStats site={site} days={days} dim={dim} />}
        <span className={`count-pill tag-${status}`}>
          {passing}/{counted.length} passing
        </span>
        <span className={`chevron ${open ? 'chevron-open' : ''}`}>›</span>
      </button>
      {open && site && <AnalyticsPanel site={site} days={days} timezone={timezone} dim={dim} />}
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
