import { useState, type FormEvent } from 'react';

export default function Login({ onLogin }: { onLogin: (user: string) => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.get('username'),
          password: form.get('password'),
          remember: form.get('remember') === 'on',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Login failed (HTTP ${res.status}).`);
      onLogin(body.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      {/* Real form with name/autocomplete attributes so password managers offer to save and fill it. */}
      <form className="login" method="post" action="/api/login" onSubmit={submit}>
        <p className="eyebrow">bas-franke.com</p>
        <h1>System status</h1>

        <label>
          Username
          <input name="username" autoComplete="username" required autoFocus defaultValue="admin" />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <label className="remember">
          <input name="remember" type="checkbox" defaultChecked />
          Keep me signed in for 30 days
        </label>

        {error && <p className="login-error">{error}</p>}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
