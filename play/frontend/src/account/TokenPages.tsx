import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PASSWORD_MIN, activate, resetPassword, takeReturn, useAccount } from '../identity';
import { Header } from '../ui/Header';
import { ResendButton } from './forms';
import './account.css';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/**
 * `/account/activate/:token`: the link from the welcome mail. The token is only spent when the visitor presses the
 * button, so mail scanners that open links (and run their scripts) can't use it up.
 */
export function ActivatePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<{ busy?: boolean; failed?: boolean }>({});
  const [email, setEmail] = useState('');
  const { mail } = useAccount();

  const go = async () => {
    setState({ busy: true });
    try {
      const next = takeReturn();
      const { reloading } = await activate(token, next);
      if (!reloading) navigate(next, { replace: true });
    } catch {
      setState({ failed: true });
    }
  };

  return (
    <div className="page acct-page">
      <Header />
      <div className="panel notice-panel acct-card">
        {state.failed ? (
          <>
            <h2>That link didn't work</h2>
            <p>It may have been used already, or it expired. If your account is already active, just log in. Otherwise we can send a fresh link.</p>
            <div className="acct-actions acct-center">
              <Link className="btn primary" to="/account">
                Log in
              </Link>
            </div>
            {mail && (
              <form className="acct-form acct-resend" onSubmit={(e) => e.preventDefault()}>
                <label className="field">
                  Email for a fresh link
                  <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                <div className="acct-actions acct-center">{email.includes('@') && <ResendButton email={email.trim()} />}</div>
              </form>
            )}
          </>
        ) : (
          <>
            <h2>Almost there</h2>
            <p>Press the button to activate your account. You'll be logged in right away.</p>
            <div className="acct-actions acct-center">
              <button type="button" className="btn primary big" onClick={() => void go()} disabled={state.busy} data-testid="activate">
                {state.busy ? 'Activating…' : 'Activate my account'}
              </button>
            </div>
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
      const next = takeReturn();
      const { reloading } = await resetPassword(token, password, next);
      if (!reloading) navigate(next, { replace: true });
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
