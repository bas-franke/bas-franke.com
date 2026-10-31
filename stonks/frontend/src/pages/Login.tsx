import { useState } from 'react';
import { api, ApiError } from '../api';
import { Art } from '../components/art';
import './login.css';

export default function Login({ onIn }: { onIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onIn();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 401
          ? 'That’s not the password. Take a breath and try again.'
          : status === 429
            ? 'Too many tries. Have a cup of tea and come back in ten minutes.'
            : `Couldn’t reach the server (${(err as Error).message}).`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-art">
        <Art slot="login-door" />
      </div>
      <div className="login-side">
        <div className="card login-card">
          <Art slot="brand-mark" className="login-mark" width={48} height={48} fallback={<img className="login-mark" src="/icon-64.png" alt="" width={48} height={48} />} />
          <h1>Stonks</h1>
          <p className="soft">A quiet little trading desk. Please let yourself in.</p>
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input
                id="pw"
                className="input"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
              />
              {error && <span className="error">{error}</span>}
            </div>
            <button className="btn primary" disabled={busy || !password}>
              {busy ? 'Opening the door…' : 'Come in'}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
