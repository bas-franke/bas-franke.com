import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { botLine, botMood, sinceMidnight, todayPct, useDesk } from '../desk';
import { ago, eur, pct, signedEur } from '../format';
import { feedLevel, useHealth } from '../health';
import { navigate, useLocation } from '../router';
import { useIsDark, useTheme } from '../theme';
import { usePrivacy } from '../privacy';
import { Art, CatArt } from './art';
import { IconEye, IconEyeOff, IconHealth, IconHome, IconLogout, IconLogs, IconMoon, IconMore, IconNotes, IconResearch, IconSettings, IconSun, IconTrades } from './icons';
import { ModeBadge } from './ui';

const GROUPS = [
  {
    title: 'The desk',
    items: [
      { path: '/', label: 'Overview', icon: IconHome },
      { path: '/trades', label: 'Trades', icon: IconTrades },
      { path: '/research', label: 'Research', icon: IconResearch },
      { path: '/notes', label: 'Notes', icon: IconNotes },
    ],
  },
  {
    title: 'Under the hood',
    items: [
      { path: '/health', label: 'Health', icon: IconHealth },
      { path: '/logs', label: 'Logs', icon: IconLogs },
      { path: '/settings', label: 'Settings', icon: IconSettings },
    ],
  },
];
export const NAV = GROUPS.flatMap((g) => g.items);

/** Phone: the four pages you open most get a tab, the rest live behind More. */
const TABS = ['/', '/trades', '/research', '/health'];
const MORE = [
  { path: '/notes', art: 'banner-notes' },
  { path: '/logs', art: 'banner-logs' },
  { path: '/settings', art: 'banner-settings' },
];

function NavLink({ path, children, className, title, onGo }: { path: string; children: ReactNode; className?: string; title?: string; onGo?: () => void }) {
  const { path: here } = useLocation();
  return (
    <a
      href={path}
      className={className}
      title={title}
      aria-current={here === path ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        // Pressing the page you are on resets it (Research goes back to the newest session).
        if (here === path) window.dispatchEvent(new CustomEvent('stonks:reselect', { detail: path }));
        navigate(path);
        onGo?.();
      }}
    >
      {children}
    </a>
  );
}

/** The nav's Health item shows a dot while anything is wrong, on every page. */
function NavIcon({ path, Icon }: { path: string; Icon: typeof IconHome }) {
  const level = feedLevel(useHealth());
  const dot = path === '/health' && (level === 'warn' || level === 'fail');
  return (
    <span className="nav-icon">
      <Icon />
      {dot && <span className={`nav-dot ${level}`} role="img" aria-label={level === 'fail' ? 'Something is failing' : 'Something to look at'} />}
    </span>
  );
}

/** The phone's status bar matches the top bar, also when the theme was picked by hand instead of by the system. */
function useBarColor() {
  const dark = useIsDark();
  useEffect(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--desk').trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
  }, [dark]);
}

function Actions({ onLogout }: { onLogout: () => void }) {
  const theme = useTheme();
  const privacy = usePrivacy();
  useBarColor();
  return (
    <div className="top-actions">
      <button className="icon-btn" onClick={privacy.toggle} aria-pressed={!privacy.hidden} aria-label={privacy.hidden ? 'Show portfolio numbers' : 'Blur portfolio numbers'} title={privacy.hidden ? 'Numbers are blurred: click to show' : 'Numbers are visible: click to blur'}>
        {privacy.hidden ? <IconEyeOff width={18} /> : <IconEye width={18} />}
      </button>
      <button className="icon-btn" onClick={theme.toggle} aria-label={theme.isDark ? 'Switch to light mode' : 'Switch to dark mode'} title={theme.isDark ? 'Light mode' : 'Dark mode'}>
        {theme.isDark ? <IconSun width={18} /> : <IconMoon width={18} />}
      </button>
      <button className="icon-btn" aria-label="Log out" title="Log out" onClick={onLogout}>
        <IconLogout width={18} />
      </button>
    </div>
  );
}

const Brand = () => (
  <NavLink path="/" className="brand" title="Stonks">
    <Art slot="brand-mark" width={34} height={34} fallback={<img src="/icon-64.png" alt="" width={34} height={34} />} />
    <span className="brand-name">Stonks</span>
  </NavLink>
);

/** The sidebar on desktop, a rail of icons on tablets. Phones get TopBar and TabBar instead. */
export function Rail({ onLogout }: { onLogout: () => void }) {
  const { overview: o } = useDesk();
  return (
    <aside className="rail">
      <Brand />
      <nav className="rail-nav" aria-label="Main">
        {GROUPS.map((g) => (
          <div className="rail-group" key={g.title}>
            <span className="rail-title">{g.title}</span>
            {g.items.map(({ path, label, icon: Icon }) => (
              <NavLink key={path} path={path} title={label}>
                <NavIcon path={path} Icon={Icon} />
                <span className="rail-label">{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="rail-foot">
        {o && (
          <NavLink path="/" className="rail-bot" title={botLine(o)}>
            <span className="rail-cat">
              <CatArt mood={botMood(o)} width={72} />
            </span>
            <span className="rail-bot-text">
              <b>{botLine(o)}</b>
              <span>{o.lastTickAt ? `looked ${ago(o.lastTickAt)}` : o.bot.mode === 'live' ? 'live money' : 'paper money'}</span>
            </span>
          </NavLink>
        )}
        <Actions onLogout={onLogout} />
      </div>
    </aside>
  );
}

export const TopBar = ({ onLogout }: { onLogout: () => void }) => (
  <header className="topbar">
    <Brand />
    <Actions onLogout={onLogout} />
  </header>
);

const Mover = ({ change }: { change: number | null }) =>
  change === null ? null : (
    <span className={`tick-move ${change >= 0 ? 'up' : 'down'}`}>
      <span aria-hidden="true">{change >= 0 ? '▲' : '▼'}</span>
      <span className="sr-only">{change >= 0 ? 'up' : 'down'}</span> {pct(Math.abs(change), 1)}
    </span>
  );

/** The tape over every page: what the portfolio and the market did today, and how the bot is. */
export function Ticker() {
  const { overview: o, day } = useDesk();
  const last = (k: 'btc' | 'eth') => day?.[k][day[k].length - 1]?.[1] ?? null;
  return (
    <div className="ticker" role="group" aria-label="Today at a glance">
      <div className="tick">
        <span className="tick-name">Portfolio</span>
        <span className="tick-value money">{o ? eur(o.equityEur) : '–'}</span>
        {o && <Mover change={todayPct(o)} />}
      </div>
      {o?.todayPnlEur !== null && o?.todayPnlEur !== undefined && (
        <div className="tick">
          <span className="tick-name">Today</span>
          <span className={`tick-value money ${o.todayPnlEur >= 0 ? 'up' : 'down'}`}>{signedEur(o.todayPnlEur)}</span>
        </div>
      )}
      {(['btc', 'eth'] as const).map((k) => (
        <div className="tick" key={k} title={`${k.toUpperCase()}-EUR price, change today`}>
          <span className="tick-name">{k.toUpperCase()}</span>
          <span className="tick-value">{last(k) === null ? '–' : eur(last(k))}</span>
          {day && <Mover change={sinceMidnight(day[k])} />}
        </div>
      ))}
      {o && (
        <div className="tick tick-end">
          <ModeBadge mode={o.bot.mode} />
          <span className={`tick-bot ${botMood(o)}`}>
            <span className="tick-lamp" aria-hidden="true" />
            {botLine(o)}
          </span>
        </div>
      )}
    </div>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="more-sheet"
      aria-label="More pages"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="more-grid">
        {MORE.map(({ path, art }) => {
          const { label, icon: Icon } = NAV.find((n) => n.path === path)!;
          return (
            <NavLink key={path} path={path} className="more-tile" onGo={onClose}>
              <Art slot={art} />
              <span>
                <Icon width={18} height={18} /> {label}
              </span>
            </NavLink>
          );
        })}
      </div>
    </dialog>
  );
}

export function TabBar() {
  const { path: here } = useLocation();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [here]);
  return (
    <>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((p) => {
          const { label, icon: Icon } = NAV.find((n) => n.path === p)!;
          return (
            <NavLink key={p} path={p} title={label}>
              <span className="tab-icon">
                <NavIcon path={p} Icon={Icon} />
              </span>
              <span className="tab-label">{label}</span>
            </NavLink>
          );
        })}
        <button type="button" aria-haspopup="dialog" aria-expanded={more} aria-current={MORE.some((m) => m.path === here) ? 'page' : undefined} onClick={() => setMore(true)}>
          <span className="tab-icon">
            <span className="nav-icon">
              <IconMore />
            </span>
          </span>
          <span className="tab-label">More</span>
        </button>
      </nav>
      <MoreSheet open={more} onClose={() => setMore(false)} />
    </>
  );
}

export const logout = (after: () => void) => void api.logout().finally(after);
