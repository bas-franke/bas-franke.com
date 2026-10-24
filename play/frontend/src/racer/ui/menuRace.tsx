// Race setup screens: the pre-race card (track, starting grid, Race button), quick race setup (track, laps,
// opponents, difficulty) and time trial setup (track, laps, records).

import { useState } from 'react';
import { cupById, type CareerSave } from '../core/career';
import { podById } from '../core/pods';
import { TRACKS, trackById, type TrackDef } from '../core/tracks';
import { Btn, Credits, PodSwatch, TopBar, TrackThumb, trackOutline } from './menuParts';
import { DIFFICULTIES, fmtCredits, fmtTime, loadQuick, loadTrials, saveQuick, type QuickSettings } from './menuStore';
import type { RaceRequest } from './Menus';

export function timeOfDay(def: TrackDef) {
  const e = def.theme.sunElevation;
  return e >= 0.5 ? 'High noon' : e >= 0.33 ? 'Morning' : e >= 0.15 ? 'Golden hour' : 'Sunset';
}

function TrackFacts({ def, laps }: { def: TrackDef; laps: number }) {
  const km = trackOutline(def.id).km;
  return (
    <dl className="dr-facts">
      <div>
        <dt>Laps</dt>
        <dd>{laps}</dd>
      </div>
      <div>
        <dt>Lap</dt>
        <dd>
          {km.toFixed(1)}
          <small>km</small>
        </dd>
      </div>
      <div>
        <dt>Width</dt>
        <dd>
          {def.width}
          <small>m</small>
        </dd>
      </div>
      <div>
        <dt>Pads</dt>
        <dd>{def.boostPads.length}</dd>
      </div>
    </dl>
  );
}

export function PreRace(props: { req: RaceRequest; save: CareerSave | null; onBack(): void; onRace(): void; onGarage?(): void }) {
  const { req, save } = props;
  const def = trackById(req.trackId);
  const laps = req.laps ?? def.laps;
  const cup = req.kind === 'career' && save?.active ? cupById(save.active.cupId) : null;
  const points = save?.active?.points ?? {};
  const title = cup ? cup.name : req.kind === 'trial' ? 'Time trial' : 'Quick race';
  return (
    <div className="dr-page">
      <TopBar
        title={title}
        sub={cup ? `Round ${(req.round ?? 0) + 1} of ${cup.tracks.length}` : `${req.racers.length} pods`}
        onBack={props.onBack}
        right={save ? <Credits n={save.credits} /> : null}
      />
      <div className="dr-pre">
        <section className="dr-panel dr-track-card">
          <div className="dr-track-art">
            <TrackThumb def={def} />
          </div>
          <div className="dr-track-info">
            <div className="dr-kicker">{timeOfDay(def)}</div>
            <h2>{def.name}</h2>
            <p className="dr-dim">{def.blurb}</p>
            <TrackFacts def={def} laps={laps} />
            {cup && (
              <div className="dr-prize-line">
                Win pays <b>{fmtCredits(cup.prize[0])}</b> CR · 10 pts
              </div>
            )}
          </div>
        </section>
        <section className="dr-panel dr-grid">
          <div className="dr-kicker">Starting grid</div>
          <ol className="dr-grid-list">
            {req.racers.map((r, i) => (
              <li key={r.id} className={r.ai ? '' : 'me'}>
                <span className="dr-grid-pos">{i + 1}</span>
                <PodSwatch pod={r.pod} />
                <span className="dr-grid-name">
                  {r.name}
                  <small>{r.pod.name}</small>
                </span>
                {cup ? (
                  <span className="dr-grid-pts">
                    {points[r.ai ? r.id : 'player'] ?? 0}
                    <small>pts</small>
                  </span>
                ) : null}
                <span className="dr-grid-skill" title="Skill">
                  {r.ai ? Array.from({ length: 5 }, (_, k) => <i key={k} className={k < Math.round(r.ai!.skill * 5) ? 'on' : ''} />) : <em>You</em>}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <div className="dr-pre-actions">
          <Btn kind="primary" className="dr-race-btn" onClick={props.onRace} autoFocus>
            Race
          </Btn>
          {props.onGarage && <Btn onClick={props.onGarage}>Garage</Btn>}
        </div>
      </div>
    </div>
  );
}

function Stepper(props: { label: string; value: number; min: number; max: number; set(v: number): void }) {
  return (
    <div className="dr-opt">
      <span className="dr-opt-label">{props.label}</span>
      <div className="dr-stepper">
        <button onClick={() => props.set(Math.max(props.min, props.value - 1))} disabled={props.value <= props.min} aria-label={`Fewer ${props.label}`}>
          −
        </button>
        <b>{props.value}</b>
        <button onClick={() => props.set(Math.min(props.max, props.value + 1))} disabled={props.value >= props.max} aria-label={`More ${props.label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function TrackGrid(props: { selected: string; onPick(id: string): void; extra?(def: TrackDef): React.ReactNode }) {
  return (
    <div className="dr-tracks">
      {TRACKS.map((t) => (
        <button key={t.id} className={`dr-track-tile${t.id === props.selected ? ' on' : ''}`} onClick={() => props.onPick(t.id)} data-autofocus={t.id === props.selected ? '' : undefined}>
          <TrackThumb def={t} />
          <span className="dr-track-tile-text">
            <b>{t.name}</b>
            <small>
              {timeOfDay(t)} · {trackOutline(t.id).km.toFixed(1)} km
            </small>
            {props.extra?.(t)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function QuickSetup(props: { save: CareerSave | null; onBack(): void; onPreview(id: string): void; onRace(q: QuickSettings): void }) {
  const [q, setQ] = useState(loadQuick);
  const set = (patch: Partial<QuickSettings>) => {
    const next = { ...q, ...patch };
    setQ(next);
    saveQuick(next);
    if (patch.trackId) props.onPreview(patch.trackId);
  };
  const pod = podById(props.save?.pod ?? 'ember');
  const def = trackById(q.trackId);
  return (
    <div className="dr-page">
      <TopBar title="Quick race" sub="Pick a track and a field" onBack={props.onBack} />
      <div className="dr-setup">
        <TrackGrid selected={q.trackId} onPick={(id) => set({ trackId: id })} />
        <section className="dr-panel dr-options">
          <div className="dr-kicker">{timeOfDay(def)}</div>
          <h2>{def.name}</h2>
          <p className="dr-dim">{def.blurb}</p>
          <Stepper label="Laps" value={q.laps} min={1} max={5} set={(v) => set({ laps: v })} />
          <Stepper label="Opponents" value={q.opponents} min={1} max={7} set={(v) => set({ opponents: v })} />
          <div className="dr-opt dr-opt-col">
            <span className="dr-opt-label">Difficulty</span>
            <div className="dr-seg">
              {DIFFICULTIES.map((d, i) => (
                <button key={d.name} className={i === q.difficulty ? 'on' : ''} onClick={() => set({ difficulty: i })} aria-pressed={i === q.difficulty}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>
          <div className="dr-yourpod">
            <PodSwatch pod={pod} /> Your pod <b>{pod.name}</b>
            {props.save ? <small>career upgrades</small> : <small>stock</small>}
          </div>
          <Btn kind="primary" className="dr-race-btn" onClick={() => props.onRace(q)}>
            Race
          </Btn>
        </section>
      </div>
    </div>
  );
}

export function TrialSetup(props: { save: CareerSave | null; onBack(): void; onPreview(id: string): void; onRace(trackId: string, laps: number): void }) {
  const [q, setQ] = useState(loadQuick);
  const [laps, setLaps] = useState(3);
  const records = loadTrials();
  const def = trackById(q.trackId);
  const rec = records[def.id];
  const pick = (id: string) => {
    const next = { ...q, trackId: id };
    setQ(next);
    saveQuick(next);
    props.onPreview(id);
  };
  const pod = podById(props.save?.pod ?? 'ember');
  return (
    <div className="dr-page">
      <TopBar title="Time trial" sub="Alone on the track. Beat your ghost times." onBack={props.onBack} />
      <div className="dr-setup">
        <TrackGrid
          selected={q.trackId}
          onPick={pick}
          extra={(t) => (records[t.id]?.lap ? <em className="dr-tile-rec">Best lap {fmtTime(records[t.id].lap)}</em> : <em className="dr-tile-rec dim">No record</em>)}
        />
        <section className="dr-panel dr-options">
          <div className="dr-kicker">{timeOfDay(def)}</div>
          <h2>{def.name}</h2>
          <div className="dr-records">
            <div>
              <span>Best lap</span>
              <b>{fmtTime(rec?.lap)}</b>
            </div>
            <div>
              <span>Best run{rec?.runLaps ? ` (${rec.runLaps} laps)` : ''}</span>
              <b>{fmtTime(rec?.run)}</b>
            </div>
            {props.save?.bestLaps[def.id] !== undefined && (
              <div>
                <span>Career best lap</span>
                <b>{fmtTime(props.save.bestLaps[def.id])}</b>
              </div>
            )}
          </div>
          <Stepper label="Laps" value={laps} min={1} max={5} set={setLaps} />
          <div className="dr-yourpod">
            <PodSwatch pod={pod} /> Your pod <b>{pod.name}</b>
          </div>
          <Btn kind="primary" className="dr-race-btn" onClick={() => props.onRace(def.id, laps)}>
            Start
          </Btn>
        </section>
      </div>
    </div>
  );
}
