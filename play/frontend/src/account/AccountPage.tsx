import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccountError, NICKNAME_MAX, PASSWORD_MIN, changePassword, cleanNickname, deleteAccount, loadAccount, logout, saveName, updateNickname, useAccount } from '../identity';
import { Header } from '../ui/Header';
import { AccountPitch, ForgotForm, LoginForm, NoMailNote, RegisterForm } from './forms';
import './account.css';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/** `/account`: guests change their nickname or sign in; logged-in players manage their profile. */
export function AccountPage() {
  const account = useAccount();
  useEffect(() => void loadAccount(), []);

  return (
    <div className="page acct-page">
      <Header />
      <div className="acct-wrap">
        <Link to="/" className="acct-back">
          ← Back to the games
        </Link>
        {account.user ? <Profile /> : <Guest />}
      </div>
    </div>
  );
}

function Avatar({ name, big }: { name: string; big?: boolean }) {
  return (
    <span className={`acct-avatar${big ? ' big' : ''}`} aria-hidden="true">
      {(name.trim()[0] || '?').toUpperCase()}
    </span>
  );
}

/** Nickname field that saves on submit; `onSave` decides where it goes (cookie for guests, account when logged in). */
function NicknameForm({ initial, onSave }: { initial: string; onSave: (name: string) => Promise<void> | void }) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<{
    busy?: boolean;
    saved?: boolean;
    error?: string;
  }>({});
  useEffect(() => setValue(initial), [initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = cleanNickname(value);
    if (!name) return setState({ error: 'Pick a nickname.' });
    setState({ busy: true });
    try {
      await onSave(name);
      setState({ saved: true });
    } catch (err) {
      setState({ error: message(err) });
    }
  };
  const dirty = cleanNickname(value) !== initial;

  return (
    <form className="acct-inline" onSubmit={(e) => void submit(e)}>
      <label className="field">
        Nickname
        <span className="acct-inline-row">
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setState({});
            }}
            maxLength={NICKNAME_MAX}
            autoComplete="nickname"
          />
          <button className="btn primary" type="submit" disabled={state.busy || !dirty}>
            {state.saved && !dirty ? 'Saved' : 'Save'}
          </button>
        </span>
      </label>
      {state.error && <p className="error">{state.error}</p>}
    </form>
  );
}

function Guest() {
  const account = useAccount();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');

  return (
    <>
      <section className="panel acct-card">
        <div className="acct-head">
          <Avatar name={account.name} big />
          <div>
            <h1>{account.name || 'Guest'}</h1>
            <span className="acct-tag">guest</span>
          </div>
        </div>
        <NicknameForm initial={account.name} onSave={saveName} />
        <p className="acct-note">Your nickname, settings and progress are saved in this browser.</p>
      </section>

      {account.enabled ? (
        <section className="panel acct-card">
          {account.mail ? (
            <div className="acct-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
                Log in
              </button>
              <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
                Create account
              </button>
            </div>
          ) : (
            <h2>Log in</h2>
          )}
          {account.mail ? <AccountPitch /> : <NoMailNote />}
          {(mode === 'login' || !account.mail) && (
            <LoginForm autoFocus={false} mail={account.mail} onForgot={account.mail ? () => setMode('forgot') : undefined} onRegister={account.mail ? () => setMode('register') : undefined} />
          )}
          {account.mail && mode === 'register' && <RegisterForm autoFocus={false} initialNickname={account.name} onLogin={() => setMode('login')} />}
          {account.mail && mode === 'forgot' && <ForgotForm onBack={() => setMode('login')} />}
        </section>
      ) : (
        account.loaded && (
          <section className="panel acct-card">
            <p className="acct-note">Accounts aren't available right now. You don't need one: everything works as a guest.</p>
          </section>
        )
      )}
    </>
  );
}

function Profile() {
  const { user } = useAccount();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  if (!user) return null;

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <>
      <section className="panel acct-card">
        <div className="acct-head">
          <Avatar name={user.nickname} big />
          <div>
            <h1>{user.nickname}</h1>
            <span className="acct-email">{user.email}</span>
          </div>
          <button type="button" className="btn small acct-logout" onClick={() => void doLogout()} disabled={loggingOut}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
        <NicknameForm
          initial={user.nickname}
          onSave={async (name) => {
            await updateNickname(name);
          }}
        />
        <p className="acct-note">Your nickname, settings and progress sync to every device you log in on.</p>
      </section>

      <section className="panel acct-card">
        <h2>Change password</h2>
        <PasswordForm />
      </section>

      <section className="panel acct-card acct-danger">
        <h2>Delete account</h2>
        <DeleteForm
          onDeleted={() => {
            navigate('/account', { replace: true });
            window.scrollTo(0, 0);
          }}
        />
      </section>
    </>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [state, setState] = useState<{
    busy?: boolean;
    done?: boolean;
    error?: string;
    field?: string;
  }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < PASSWORD_MIN)
      return setState({
        error: `At least ${PASSWORD_MIN} characters.`,
        field: 'password',
      });
    setState({ busy: true });
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setState({ done: true });
    } catch (err) {
      setState({
        error: message(err),
        field: err instanceof AccountError ? err.field : undefined,
      });
    }
  };

  return (
    <form className="acct-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        Current password
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="field">
        New password
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={PASSWORD_MIN} placeholder={`${PASSWORD_MIN}+ characters`} required />
      </label>
      {state.error && <p className="error">{state.error}</p>}
      {state.done && <p className="acct-ok">Password changed.</p>}
      <div className="acct-actions">
        <span />
        <button className="btn primary" type="submit" disabled={state.busy}>
          {state.busy ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

function DeleteForm({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});

  if (!open) {
    return (
      <>
        <p className="acct-note">Removes your account and its synced data from the server. What's saved in this browser stays, and you carry on as a guest.</p>
        <div className="acct-actions">
          <span />
          <button type="button" className="btn danger" onClick={() => setOpen(true)}>
            Delete my account
          </button>
        </div>
      </>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try {
      await deleteAccount(password);
      onDeleted();
    } catch (err) {
      setState({ error: message(err) });
    }
  };

  return (
    <form className="acct-form" onSubmit={(e) => void submit(e)}>
      <p className="acct-note">This can't be undone. Enter your password to confirm.</p>
      <label className="field">
        Password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </label>
      {state.error && <p className="error">{state.error}</p>}
      <div className="acct-actions">
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="btn danger" type="submit" disabled={state.busy}>
          {state.busy ? 'Deleting…' : 'Delete forever'}
        </button>
      </div>
    </form>
  );
}
