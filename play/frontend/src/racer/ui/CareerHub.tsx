// Career hub: the active cup (round, standings, continue), the four cups as cards (tier, tracks, prizes, lock and
// best result), the garage shortcut with the flown pod, and the pilot's stats.

import { useState } from 'react';
import { CUPS, cupById, cupStandings, cupUnlocked, racerName, racerPod, startCup, type CareerSave, type Cup } from '../core/career';
import { podById } from '../core/pods';
import { trackById } from '../core/tracks';
import { Btn, Confirm, Credits, PodSwatch, TierBadge, TopBar, Trophy } from './menuParts';
import { fmtCredits, fmtTime, ordinal } from './menuStore';

export function CareerHub(props: {
  save: CareerSave;
  commit(s: CareerSave | null): void;
  onBack(): void;
  onGarage(): void;
  onPrerace(s: CareerSave): void;
  onReset(): void;
}) {
  const s = props.save;
  const [confirm, setConfirm] = useState<'retire' | 'reset' | null>(null);
  const active = s.active;
  // The cup to suggest when no cup is running: the first unlocked one not yet won.
  const suggested = CUPS.find((c) => cupUnlocked(s, c) && s.cups[c.id]?.best !== 1) ?? CUPS[0];
  const enter = (cup: Cup) => {
    const next = startCup(s, cup.id);
    props.commit(next);
    props.onPrerace(next);
  };
  return (
    <div className="dr-page">
      <TopBar
        title="Career"
        sub={
          <>
            Pilot <b>{s.pilot}</b>
          </>
        }
        onBack={props.onBack}
        right={<Credits n={s.credits} />}
      />
      <div className="dr-hub">
        <div className="dr-hub-main">
          {active ? (
            <ActiveCupPanel save={s} confirm={confirm === 'retire'} setConfirm={(on) => setConfirm(on ? 'retire' : null)} onContinue={() => props.onPrerace(s)} onRetire={() => props.commit({ ...s, active: null })} />
          ) : (
            <div className="dr-panel dr-hub-intro">
              <div className="dr-kicker">Season</div>
              <h2>Choose your cup</h2>
              <p className="dr-dim">
                Race every track of a cup for points: 10 for a win down to 1 for eighth. Prize money pays per race, and a top 3 overall unlocks the next tier.
              </p>
            </div>
          )}
          <h3 className="dr-section">Cups</h3>
          <div className="dr-cups">
            {CUPS.map((cup) => (
              <CupCard key={cup.id} save={s} cup={cup} suggested={!active && cup === suggested} onEnter={() => enter(cup)} onContinue={() => props.onPrerace(s)} />
            ))}
          </div>
        </div>
        <aside className="dr-hub-side">
          <GarageCard save={s} onGarage={props.onGarage} />
          <StatsPanel save={s} />
          <div className="dr-reset">
            {confirm === 'reset' ? (
              <Confirm>
                <span>Erase this career for good?</span>
                <Btn kind="danger" onClick={props.onReset}>
                  Erase
                </Btn>
                <Btn kind="ghost" onClick={() => setConfirm(null)} autoFocus>
                  Keep it
                </Btn>
              </Confirm>
            ) : (
              <Btn kind="ghost" onClick={() => setConfirm('reset')}>
                New career
              </Btn>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ActiveCupPanel(props: { save: CareerSave; confirm: boolean; setConfirm(on: boolean): void; onContinue(): void; onRetire(): void }) {
  const s = props.save;
  const a = s.active!;
  const cup = cupById(a.cupId);
  const table = cupStandings(a.points);
  const next = trackById(cup.tracks[a.round]);
  return (
    <section className="dr-panel dr-active">
      <div className="dr-active-left">
        <div className="dr-active-head">
          <TierBadge tier={cup.tier} big />
          <div>
            <div className="dr-kicker">Cup in progress</div>
            <h2>{cup.name}</h2>
            <div className="dr-dim">
              Round <b className="dr-hl">{a.round + 1}</b> of {cup.tracks.length} · next: <b>{next.name}</b>
            </div>
          </div>
        </div>
        <ol className="dr-rounds">
          {cup.tracks.map((id, i) => (
            <li key={i} className={i < a.round ? 'done' : i === a.round ? 'next' : ''}>
              <span className="dr-round-n">R{i + 1}</span>
              <span className="dr-round-name">{trackById(id).name}</span>
              <span className="dr-round-res">{i < a.round ? ordinal(a.results[i]) : i === a.round ? 'Next' : ''}</span>
            </li>
          ))}
        </ol>
        <div className="dr-row">
          {props.confirm ? (
            <Confirm>
              <span>Retire? Your points in this cup are lost.</span>
              <Btn kind="danger" onClick={props.onRetire}>
                Retire
              </Btn>
              <Btn kind="ghost" onClick={() => props.setConfirm(false)} autoFocus>
                Stay in
              </Btn>
            </Confirm>
          ) : (
            <>
              <Btn kind="primary" onClick={props.onContinue} autoFocus>
                Continue · Round {a.round + 1}
              </Btn>
              <Btn kind="ghost" onClick={() => props.setConfirm(true)}>
                Retire from cup
              </Btn>
            </>
          )}
        </div>
      </div>
      <Standings save={s} table={table} compact />
    </section>
  );
}

export function Standings(props: { save: CareerSave; table: { id: string; points: number }[]; gained?: Record<string, number>; compact?: boolean }) {
  return (
    <table className={`dr-table dr-standings${props.compact ? ' compact' : ''}`}>
      <thead>
        <tr>
          <th>Pos</th>
          <th>Pilot</th>
          <th className="num">Pts</th>
        </tr>
      </thead>
      <tbody>
        {props.table.map((r, i) => {
          const pod = racerPod(props.save, r.id);
          return (
            <tr key={r.id} className={r.id === 'player' ? 'me' : ''}>
              <td className="pos">{i + 1}</td>
              <td>
                <PodSwatch pod={pod} />
                <span className="name">{racerName(props.save, r.id)}</span>
                <small className="pod">{pod.name}</small>
              </td>
              <td className="num">
                {props.gained?.[r.id] ? <small className="gain">+{props.gained[r.id]}</small> : null}
                <b>{r.points}</b>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CupCard(props: { save: CareerSave; cup: Cup; suggested: boolean; onEnter(): void; onContinue(): void }) {
  const { save: s, cup } = props;
  const locked = !cupUnlocked(s, cup);
  const isActive = s.active?.cupId === cup.id;
  const busy = !!s.active && !isActive;
  const best = s.cups[cup.id]?.best ?? null;
  return (
    <article className={`dr-cup dr-cup-${cup.tier}${locked ? ' locked' : ''}${isActive ? ' active' : ''}`}>
      <div className="dr-cup-head">
        <TierBadge tier={cup.tier} />
        <div>
          <h4>{cup.name}</h4>
          <small>
            {cup.tracks.length} races · {cup.field} pods
          </small>
        </div>
        {best !== null && best <= 3 && (
          <div className="dr-cup-trophy" title={`Best: ${ordinal(best)}`}>
            <Trophy place={best} />
          </div>
        )}
      </div>
      <p className="dr-cup-blurb">{cup.blurb}</p>
      <ol className="dr-cup-tracks">
        {cup.tracks.map((id, i) => {
          const t = trackById(id);
          return (
            <li key={i}>
              <span className="dr-dot" style={{ background: `linear-gradient(135deg, ${t.theme.skyTop}, ${t.theme.rockLit} 60%, ${t.theme.dirt})` }} />
              {t.name}
            </li>
          );
        })}
      </ol>
      <div className="dr-cup-prize">
        <span>
          Win <b>{fmtCredits(cup.prize[0])}</b>
        </span>
        <span>
          Cup bonus <b>{fmtCredits(cup.cupBonus)}</b>
        </span>
      </div>
      <div className="dr-cup-foot">
        <span className="dr-cup-best">{best !== null ? <>Best {ordinal(best)}</> : locked ? 'Locked' : 'Not raced'}</span>
        {locked ? (
          <span className="dr-cup-lock">
            <LockIcon /> Top 3 in {cupById(cup.requires!).name}
          </span>
        ) : isActive ? (
          <Btn kind="primary" onClick={props.onContinue}>
            Continue
          </Btn>
        ) : (
          <Btn kind={props.suggested ? 'primary' : 'normal'} onClick={props.onEnter} disabled={busy} autoFocus={props.suggested} title={busy ? 'Finish or retire from your current cup first' : undefined}>
            {busy ? 'Cup running' : best !== null ? 'Race again' : 'Enter cup'}
          </Btn>
        )}
      </div>
    </article>
  );
}

function GarageCard(props: { save: CareerSave; onGarage(): void }) {
  const pod = podById(props.save.pod);
  const u = props.save.upgrades[pod.id];
  const levels = u ? u.thrust + u.topSpeed + u.handling + u.boost : 0;
  return (
    <button className="dr-panel dr-garage-card" onClick={props.onGarage}>
      <div className="dr-kicker">Garage</div>
      <div className="dr-garage-card-pod">
        <PodSwatch pod={pod} />
        <b>{pod.name}</b>
      </div>
      <div className="dr-dim">
        {levels}/20 upgrades · {props.save.ownedPods.length}/5 pods owned
      </div>
      <span className="dr-garage-card-go">Upgrade &amp; buy pods ›</span>
    </button>
  );
}

function StatsPanel({ save: s }: { save: CareerSave }) {
  const cupsWon = Object.values(s.cups).filter((c) => c.best === 1).length;
  const laps = Object.entries(s.bestLaps).sort((a, b) => a[1] - b[1]);
  return (
    <section className="dr-panel dr-stats">
      <div className="dr-kicker">Pilot record</div>
      <div className="dr-stat-grid">
        <Stat label="Races" v={s.stats.races} />
        <Stat label="Wins" v={s.stats.wins} />
        <Stat label="Podiums" v={s.stats.podiums} />
        <Stat label="Cups won" v={cupsWon} />
      </div>
      <div className="dr-stat-earn">
        Career earnings <b>{fmtCredits(s.stats.earnings)}</b> CR
      </div>
      {laps.length > 0 && (
        <ul className="dr-bestlaps">
          {laps.map(([id, t]) => (
            <li key={id}>
              <span>{trackById(id).name}</span>
              <b>{fmtTime(t)}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="dr-stat">
      <b>{v}</b>
      <span>{label}</span>
    </div>
  );
}

export function LockIcon() {
  return (
    <svg className="dr-lock" viewBox="0 0 16 16" aria-hidden>
      <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="2.5" y="7" width="11" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}
