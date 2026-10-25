import { Link } from 'react-router-dom';
import { useAccount } from '../identity';
import './account.css';

/** The header's link to /account: avatar initial and nickname, tagged "guest" until they log in. */
export function AccountChip() {
  const { name, user } = useAccount();
  const nick = user?.nickname || name || 'Guest';
  return (
    <Link to="/account" className="acct-chip" title={user ? `Logged in as ${nick}` : `${nick} (guest)`} aria-label={user ? `Account: ${nick}` : `Account: ${nick}, guest`} data-testid="account-chip">
      <span className="acct-avatar" aria-hidden="true">
        {(nick.trim()[0] || '?').toUpperCase()}
      </span>
      <span className="acct-chip-name">{nick}</span>
      {!user && <span className="acct-tag">guest</span>}
    </Link>
  );
}
