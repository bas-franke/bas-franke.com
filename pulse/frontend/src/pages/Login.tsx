import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Art } from '../art/Art';

export default function Login({ onDone }: { onDone: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', { method: 'POST', body: { passphrase } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <Art slot="login" className="login-art" />
      <form className="login-card" onSubmit={submit}>
        <h1>pulse</h1>
        <p>Your cozy corner for tasks and notes.</p>
        <input type="password" autoFocus autoComplete="current-password" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        {error && <p className="form-error">{error}</p>}
        <button className="btn" disabled={busy || !passphrase}>Come in</button>
      </form>
    </div>
  );
}
