import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';

export default function Login({ onLogin, notice }: { onLogin: (user: string) => void; notice?: string }) {
  const [error, setError] = useState<string | undefined>(notice);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ user: string }>('/api/admin/login', {
        method: 'POST',
        json: { username: form.get('username'), password: form.get('password'), remember: form.get('remember') === 'on' },
      });
      onLogin(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login" method="post" action="/api/admin/login" onSubmit={submit}>
        <Link to="/" className="brand">
          inck<span className="dot">.</span>
        </Link>
        <h1>Admin</h1>
        <p className="muted">Configure what gets written, when, and how.</p>
        <label>
          Username
          <input name="username" autoComplete="username" required defaultValue="admin" />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required autoFocus />
        </label>
        <label className="remember">
          <input name="remember" type="checkbox" defaultChecked />
          Keep me signed in for 30 days
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
