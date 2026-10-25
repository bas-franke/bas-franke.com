import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PASSWORD_MIN, activate, resetPassword, takeReturn } from '../identity';
import { Header } from '../ui/Header';
import './account.css';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/** `/account/activate/:token`: the link from the welcome mail. Activates, logs in, and goes back to where they were. */
export function ActivatePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice; a token can only be used once.
    if (started.current) return;
    started.current = true;
    activate(token)
      .then(() => navigate(takeReturn(), { replace: true }))
      .catch((err: unknown) => setError(message(err)));
  }, [token, navigate]);

  return (
    <div className="page acct-page">
      <Header />
      <div className="panel notice-panel acct-card">
        {error ? (
          <>
            <h2>That link didn't work</h2>
            <p>{error} Links expire after a while; log in to get a fresh one.</p>
            <div className="acct-actions acct-center">
              <Link className="btn primary" to="/account">
                Go to my account
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2>Activating your account…</h2>
            <p>One moment.</p>
          </>
        )}
      </div>
    </div>
  );
}

/** `/account/reset/:token`: the link from the forgot-password mail. */
export function ResetPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) return setState({ error: `At least ${PASSWORD_MIN} characters.` });
    setState({ busy: true });
    try {
      await resetPassword(token, password);
      navigate(takeReturn(), { replace: true });
    } catch (err) {
      setState({ error: message(err) });
    }
  };

  return (
    <div className="page acct-page">
      <Header />
      <form className="panel notice-panel acct-card acct-left" onSubmit={(e) => void submit(e)}>
        <h2>Pick a new password</h2>
        <p>You'll be logged in right after.</p>
        <label className="field">
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={PASSWORD_MIN}
            placeholder={`${PASSWORD_MIN}+ characters`}
            required
            autoFocus
          />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <div className="acct-actions">
          <Link className="acct-link" to="/account">
            Request a new link
          </Link>
          <button className="btn primary" type="submit" disabled={state.busy}>
            {state.busy ? 'Saving…' : 'Save and log in'}
          </button>
        </div>
      </form>
    </div>
  );
}
