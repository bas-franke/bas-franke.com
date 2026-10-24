// Results: the finishing order with times (projected ones for pods still racing are marked), best laps, and per
// mode the rewards: career points, prize money and the cup standings (with a celebration when the cup is over),
// or time trial records. The award itself was applied once by Menus (menuStore.applyFinished).

import { useEffect } from 'react';
import { cupById, CUPS, POINTS, cupStandings, type CareerSave } from '../core/career';
import { podById } from '../core/pods';
import { trackById } from '../core/tracks';
import { sfx } from '../../engine/audio';
import type { RaceResult } from '../RaceView';
import { Standings } from './CareerHub';
import { Btn, CreditIcon, Credits, PodSwatch, Trophy } from './menuParts';
import { fmtCredits, fmtTime, ordinal, type Applied } from './menuStore';
import type { RaceRequest } from './Menus';

export function Results(props: {
  finished: { req: RaceRequest; result: RaceResult };
  applied: Applied;
  save: CareerSave | null;
  onNext(s: CareerSave): void;
  onHub(): void;
  onRetry(): void;
  onSetup(): void;
  onTitle(): void;
}) {
  const { req, result } = props.finished;
  const { award } = props.applied;
  const save = props.save;
  const def = trackById(result.trackId);
  const pos = result.playerPosition;
  const career = req.kind === 'career';
  const trial = req.kind === 'trial';
  const cup = career && req.cupId ? cupById(req.cupId) : null;
  const winner = result.order[0]?.time ?? 0;
  const fastest = Math.min(...result.order.map((o) => (Number.isFinite(o.bestLap) ? o.bestLap : Infinity)));
  const cupDone = award?.cupDone ?? null;

  useEffect(() => {
    if (cupDone ? cupDone.position <= 3 : pos <= 3 && !trial) sfx.play('win');
  }, [cupDone, pos, trial]);

  const gained: Record<string, number> = {};
  result.order.forEach((o, i) => (gained[o.player ? 'player' : o.id] = POINTS[i] ?? 0));
  const table = cupDone ? cupDone.standings : save?.active ? cupStandings(save.active.points) : [];

  return (
    <div className="dr-page dr-results">
      <header className="dr-res-head">
        <div className={`dr-res-pos p${Math.min(pos, 4)}`}>
          {trial ? (
            <span className="dr-res-time">{fmtTime(result.playerTime)}</span>
          ) : (
            <>
              <b>{pos}</b>
              <sup>{ordinal(pos).slice(-2)}</sup>
            </>
          )}
        </div>
        <div className="dr-res-title">
          <div className="dr-kicker">
            {cup ? `${cup.name} · round ${(req.round ?? 0) + 1}/${cup.tracks.length}` : trial ? 'Time trial' : 'Quick race'} · {def.name}
          </div>
          <h1>{trial ? 'Run complete' : pos === 1 ? 'Victory!' : pos <= 3 ? 'Podium finish' : `Finished ${ordinal(pos)}`}</h1>
          <div className="dr-res-sub">
            Time <b>{fmtTime(result.playerTime)}</b> · Best lap <b>{fmtTime(result.playerBestLap)}</b>
            {(award?.newBestLap || props.applied.newLapRecord) && <span className="dr-badge dr-badge-cyan">New best lap</span>}
          </div>
        </div>
        {save && <Credits n={save.credits} />}
      </header>

      <div className="dr-res-body">
        {!trial && (
          <section className="dr-panel dr-res-table">
            <table className="dr-table">
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Pilot</th>
                  <th className="num">Time</th>
                  <th className="num hide-xs">Best lap</th>
                  {career && <th className="num">Pts</th>}
                </tr>
              </thead>
              <tbody>
                {result.order.map((o, i) => (
                  <tr key={o.id} className={`${o.player ? 'me' : ''} ${i < 3 ? `dr-podium dr-p${i + 1}` : ''}`}>
                    <td className="pos">{i + 1}</td>
                    <td>
                      <PodSwatch pod={podById(o.podId)} />
                      <span className="name">{o.name}</span>
                    </td>
                    <td className="num">
                      {i === 0 ? fmtTime(o.time) : `+${(o.time - winner).toFixed(3)}`}
                      {o.projected && <small className="proj" title="Still racing: projected time">est.</small>}
                    </td>
                    <td className={`num hide-xs${o.bestLap === fastest ? ' fastest' : ''}`}>{fmtTime(o.bestLap)}</td>
                    {career && <td className="num">{POINTS[i] ? `+${POINTS[i]}` : ''}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {result.order.some((o) => o.projected) && <p className="dr-foot">est. = still racing when you finished; time projected from their pace.</p>}
          </section>
        )}

        <aside className="dr-res-side">
          {career && award && (
            <section className="dr-panel dr-earn">
              <div className="dr-kicker">Earned</div>
              <div className="dr-earn-row">
                <div>
                  <b className="dr-hl">+{award.points}</b>
                  <span>points</span>
                </div>
                <div>
                  <b>
                    <CreditIcon />+{fmtCredits(award.prize)}
                  </b>
                  <span>prize</span>
                </div>
                {cupDone && cupDone.bonus > 0 && (
                  <div>
                    <b>
                      <CreditIcon />+{fmtCredits(cupDone.bonus)}
                    </b>
                    <span>cup bonus</span>
                  </div>
                )}
              </div>
            </section>
          )}
          {career && !award && (
            <section className="dr-panel">
              <p className="dr-dim">This race no longer matches your career save, so it did not count.</p>
            </section>
          )}
          {cup && cupDone && <CupCelebration cupName={cup.name} position={cupDone.position} bonus={cupDone.bonus} unlocked={props.applied.unlocked} />}
          {career && save && table.length > 0 && (
            <section className="dr-panel">
              <div className="dr-kicker">{cupDone ? 'Final standings' : 'Cup standings'}</div>
              <Standings save={save} table={table} gained={gained} compact />
            </section>
          )}
          {trial && (
            <section className="dr-panel dr-records">
              <div>
                <span>Best lap</span>
                <b>{fmtTime(result.playerBestLap)}</b>
                {props.applied.newLapRecord ? <em className="dr-badge dr-badge-cyan">Record</em> : <small>record {fmtTime(props.applied.trialBefore?.lap)}</small>}
              </div>
              <div>
                <span>Run ({req.laps ?? def.laps} laps)</span>
                <b>{fmtTime(result.playerTime)}</b>
                {props.applied.newRunRecord ? <em className="dr-badge dr-badge-cyan">Record</em> : <small>record {fmtTime(props.applied.trialBefore?.run)}</small>}
              </div>
            </section>
          )}
        </aside>
      </div>

      <div className="dr-res-actions">
        {career ? (
          save?.active ? (
            <>
              <Btn kind="primary" onClick={() => props.onNext(save)} autoFocus>
                Next race · {trackById(cupById(save.active.cupId).tracks[save.active.round]).name}
              </Btn>
              <Btn onClick={props.onHub}>Career hub</Btn>
            </>
          ) : (
            <Btn kind="primary" onClick={props.onHub} autoFocus>
              Back to career hub
            </Btn>
          )
        ) : (
          <>
            <Btn kind="primary" onClick={props.onRetry} autoFocus>
              Retry
            </Btn>
            <Btn onClick={props.onSetup}>{trial ? 'Change track' : 'Change setup'}</Btn>
            <Btn kind="ghost" onClick={props.onTitle}>
              Main menu
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

function CupCelebration(props: { cupName: string; position: number; bonus: number; unlocked: string[] }) {
  const p = props.position;
  return (
    <section className={`dr-panel dr-celebrate${p === 1 ? ' gold' : ''}`}>
      {p <= 3 && (
        <div className="dr-celebrate-trophy">
          <Trophy place={p} />
        </div>
      )}
      <div>
        <div className="dr-kicker">Cup complete</div>
        <h2>{p === 1 ? `${props.cupName} champion!` : `${ordinal(p)} overall`}</h2>
        {props.bonus > 0 && (
          <div className="dr-celebrate-bonus">
            Cup bonus <b>+{fmtCredits(props.bonus)}</b> CR
          </div>
        )}
        {props.unlocked.map((id) => (
          <div key={id} className="dr-unlock">
            Unlocked <b>{cupById(id).name}</b> · class {cupById(id).tier}
          </div>
        ))}
        {p > 3 && <p className="dr-dim">Finish in the top 3 to unlock {CUPS.find((c) => c.requires && cupById(c.requires).name === props.cupName)?.name ?? 'the next cup'}.</p>}
      </div>
    </section>
  );
}
