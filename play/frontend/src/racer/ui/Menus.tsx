// Menus: everything outside a race. Title, career hub (cups, standings, stats), garage, quick race and time trial
// setup, the pre-race grid and the results screen, over a live 3D backdrop of the race world (backdrop.ts). This
// file is the screen state machine and the title screen; the screens live in Career*.tsx, Garage.tsx,
// menuRace.tsx and Results.tsx. Keyboard and gamepad navigation come from menuNav.ts.
//
// Dev URL params: ?menu=career|garage|quick|trial opens a screen, ?nobackdrop.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cupById, cupRacers, loadCareer, newCareer, playerRacer, quickRaceRacers, RIVALS, saveCareer, type CareerSave } from '../core/career';
import { podById, type PodDesign } from '../core/pods';
import type { RacerSetup } from '../core/race';
import { TRACKS } from '../core/tracks';
import type { RaceResult } from '../RaceView';
import { menuAudio } from '../audio/menu';
import { Backdrop, type BackdropScene } from './backdrop';
import { CareerHub } from './CareerHub';
import { Garage } from './Garage';
import { Btn, Credits } from './menuParts';
import { PreRace, QuickSetup, TrialSetup } from './menuRace';
import { useMenuNav } from './menuNav';
import { applyFinished, DIFFICULTIES, loadQuick, type QuickSettings } from './menuStore';
import { Results } from './Results';
import './menus.css';

export interface RaceRequest {
  kind: 'career' | 'quick' | 'trial';
  trackId: string;
  racers: RacerSetup[];
  /** Career races: the cup and round this race is for (the award checks it still matches the save). */
  cupId?: string;
  round?: number;
}

export type View =
  | { k: 'title' }
  | { k: 'pilot' }
  | { k: 'career' }
  | { k: 'garage' }
  | { k: 'quick' }
  | { k: 'trial' }
  | { k: 'prerace'; req: RaceRequest }
  | { k: 'results' };

const params = new URLSearchParams(location.search);

/** The race request for the next round of the active cup. */
export function careerRequest(s: CareerSave): RaceRequest {
  const a = s.active!;
  const cup = cupById(a.cupId);
  return { kind: 'career', trackId: cup.tracks[a.round], racers: cupRacers(s), cupId: a.cupId, round: a.round };
}

export function quickRequest(s: CareerSave | null, q: QuickSettings): RaceRequest {
  const d = DIFFICULTIES[q.difficulty] ?? DIFFICULTIES[1];
  const player = playerRacer(s ?? newCareer());
  return { kind: 'quick', trackId: q.trackId, racers: quickRaceRacers(player, q.opponents + 1, d.skill, d.upgrades) };
}

export function trialRequest(s: CareerSave | null, trackId: string): RaceRequest {
  return { kind: 'trial', trackId, racers: [playerRacer(s ?? newCareer())] };
}

/** Loads Exo 2, the HUD's bold italic sans (upright weights too, for body text), and runs the menu ambience. */
function useMenuFontAndAmbience() {
  useEffect(() => {
    menuAudio.startAmbient();
    if (!document.getElementById('dr-font')) {
      const link = document.createElement('link');
      link.id = 'dr-font';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Exo+2:ital,wght@0,500;0,600;0,700;1,500;1,600;1,700;1,800;1,900&display=swap';
      document.head.appendChild(link);
    }
    return () => menuAudio.stopAmbient();
  }, []);
}

function useNarrow() {
  const q = '(max-width: 760px), (max-aspect-ratio: 4/5)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

function initialView(finished: boolean): View {
  if (finished) return { k: 'results' };
  const m = params.get('menu');
  if (m === 'career') return loadCareer() ? { k: 'career' } : { k: 'pilot' };
  if (m === 'garage' && loadCareer()) return { k: 'garage' };
  if (m === 'quick' || m === 'trial' || m === 'pilot') return { k: m };
  if (m === 'prerace') {
    const s = loadCareer();
    if (s?.active) return { k: 'prerace', req: careerRequest(s) };
  }
  return { k: 'title' };
}

export function Menus(props: { finished: { req: RaceRequest; result: RaceResult } | null; onRace(req: RaceRequest): void; onExit(): void }) {
  useMenuFontAndAmbience();
  const [view, setView] = useState<View>(() => initialView(!!props.finished));
  // Award the finished race (once; cached per result) before the save is read below.
  const [applied] = useState(() => (props.finished ? applyFinished(props.finished.req, props.finished.result) : null));
  const [save, setSave] = useState<CareerSave | null>(loadCareer);
  const [garagePod, setGaragePod] = useState<string>(() => save?.pod ?? 'ember');
  const [previewTrack, setPreviewTrack] = useState<string>(() => loadQuick().trackId);
  const [idleTrack] = useState(() => props.finished?.result.trackId ?? TRACKS[Math.floor(Math.random() * TRACKS.length)].id);
  const narrow = useNarrow();
  const root = useRef<HTMLDivElement>(null);
  const bgHost = useRef<HTMLDivElement>(null);
  const backdrop = useRef<Backdrop | null>(null);
  const [bgOk, setBgOk] = useState(true);

  const commit = useCallback((s: CareerSave | null) => {
    if (s) saveCareer(s);
    setSave(s);
  }, []);

  const go = useCallback((v: View) => {
    setView(v);
    root.current?.querySelector('.dr-scroll')?.scrollTo({ top: 0 });
  }, []);

  const back = useCallback(() => {
    switch (view.k) {
      case 'title':
        return;
      case 'garage':
        return go({ k: 'career' });
      case 'prerace':
        return go(view.req.kind === 'career' ? { k: 'career' } : { k: view.req.kind });
      case 'results': {
        const kind = props.finished?.req.kind ?? 'quick';
        return go(kind === 'career' ? { k: 'career' } : { k: kind });
      }
      default:
        return go({ k: 'title' });
    }
  }, [view, go, props.finished]);

  useMenuNav(root, back, view.k === 'prerace' ? `prerace-${view.req.trackId}` : view.k);

  // The live backdrop: created once, disposed when the menus unmount (that is, when a race starts).
  useEffect(() => {
    const b = new Backdrop(bgHost.current!);
    backdrop.current = b;
    setBgOk(b.ok);
    return () => {
      b.dispose();
      backdrop.current = null;
    };
  }, []);

  const heroPod: PodDesign = podById(save?.pod ?? 'ember');
  const scene = useMemo<BackdropScene>(() => {
    const rivals = RIVALS.slice(0, 3).map((r) => podById(r.pod));
    const nextCareerTrack = save?.active ? cupById(save.active.cupId).tracks[save.active.round] : null;
    switch (view.k) {
      case 'garage':
        return { kind: 'showcase', trackId: nextCareerTrack ?? idleTrack, pod: podById(garagePod), focus: narrow ? [0.5, 0.2] : [0.3, 0.52] };
      case 'prerace':
        return { kind: 'flyby', trackId: view.req.trackId, pod: heroPod, rivals };
      case 'quick':
      case 'trial':
        return { kind: 'flyby', trackId: previewTrack, pod: heroPod, rivals: view.k === 'trial' ? [] : rivals };
      case 'career':
        return { kind: 'flyby', trackId: nextCareerTrack ?? idleTrack, pod: heroPod, rivals };
      default:
        return { kind: 'flyby', trackId: props.finished?.result.trackId ?? idleTrack, pod: heroPod, rivals };
    }
  }, [view, garagePod, previewTrack, idleTrack, heroPod, save?.active, narrow, props.finished]);

  // Debounced, so browsing track cards does not rebuild the world on every focus change.
  useEffect(() => {
    const id = window.setTimeout(() => backdrop.current?.set(scene), 450);
    return () => clearTimeout(id);
  }, [scene]);

  const race = (req: RaceRequest) => props.onRace(req);

  let body: React.ReactNode;
  switch (view.k) {
    case 'title':
      body = <Title save={save} onCareer={() => go(save ? { k: 'career' } : { k: 'pilot' })} onQuick={() => go({ k: 'quick' })} onTrial={() => go({ k: 'trial' })} onExit={props.onExit} />;
      break;
    case 'pilot':
      body = (
        <PilotEntry
          onBack={back}
          onStart={(name) => {
            commit(newCareer(name));
            go({ k: 'career' });
          }}
        />
      );
      break;
    case 'career':
      body = save ? (
        <CareerHub
          save={save}
          commit={commit}
          onBack={back}
          onGarage={() => {
            setGaragePod(save.pod);
            go({ k: 'garage' });
          }}
          onPrerace={(s) => go({ k: 'prerace', req: careerRequest(s) })}
          onReset={() => {
            commit(null);
            go({ k: 'pilot' });
          }}
        />
      ) : null;
      break;
    case 'garage':
      body = save ? <Garage save={save} commit={commit} onBack={back} viewPod={garagePod} setViewPod={setGaragePod} /> : null;
      break;
    case 'quick':
      body = <QuickSetup save={save} onBack={back} onPreview={setPreviewTrack} onRace={(q) => race(quickRequest(save, q))} />;
      break;
    case 'trial':
      body = <TrialSetup save={save} onBack={back} onPreview={setPreviewTrack} onRace={(id) => race(trialRequest(save, id))} />;
      break;
    case 'prerace':
      body = <PreRace req={view.req} save={save} onBack={back} onRace={() => race(view.req)} onGarage={view.req.kind === 'career' ? () => go({ k: 'garage' }) : undefined} />;
      break;
    case 'results':
      body = props.finished && applied ? (
        <Results
          finished={props.finished}
          applied={applied}
          save={save}
          onNext={(s) => go({ k: 'prerace', req: careerRequest(s) })}
          onHub={() => go({ k: 'career' })}
          onRetry={() => race({ ...props.finished!.req })}
          onSetup={() => go({ k: props.finished!.req.kind === 'trial' ? 'trial' : 'quick' })}
          onTitle={() => go({ k: 'title' })}
        />
      ) : null;
      break;
  }

  return (
    <div className={`dr-menu dr-view-${view.k}`} ref={root}>
      <div className={`dr-bg${bgOk ? '' : ' dr-bg-static'}`} ref={bgHost} />
      <div className="dr-shade" />
      <div className="dr-scroll">
        <div className="dr-screen" key={view.k === 'prerace' ? `prerace-${view.req.trackId}` : view.k}>
          {body}
        </div>
      </div>
    </div>
  );
}

function Title(props: { save: CareerSave | null; onCareer(): void; onQuick(): void; onTrial(): void; onExit(): void }) {
  const s = props.save;
  const careerSub = !s
    ? 'Start your racing career'
    : s.active
      ? `${cupById(s.active.cupId).name} · round ${s.active.round + 1}/${cupById(s.active.cupId).tracks.length}`
      : `${s.pilot} · ${s.stats.wins} wins`;
  return (
    <div className="dr-title">
      <div className="dr-logo">
        <div className="dr-logo-streaks" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <h1 className="dr-logo-word">
          <span>DUST</span>
          <span>RUNNERS</span>
        </h1>
        <div className="dr-logo-sub">Canyon podracing circuit</div>
      </div>
      <nav className="dr-title-menu">
        <TitleItem n="01" label="Career" sub={careerSub} onClick={props.onCareer} autoFocus extra={s ? <Credits n={s.credits} /> : null} />
        <TitleItem n="02" label="Quick Race" sub="Any track, any field, right now" onClick={props.onQuick} />
        <TitleItem n="03" label="Time Trial" sub="Just you, the canyon and the clock" onClick={props.onTrial} />
        <button className="dr-exit" onClick={props.onExit}>
          <span>‹</span> play.bas-franke.com
        </button>
      </nav>
      <div className="dr-controls">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> select
        </span>
        <span>
          <kbd>Enter</kbd> confirm
        </span>
        <span>
          <kbd>Esc</kbd> back
        </span>
        <span className="dr-controls-pad">
          <kbd className="dr-pad-a">A</kbd> / <kbd className="dr-pad-b">B</kbd> gamepad
        </span>
      </div>
    </div>
  );
}

function TitleItem(props: { n: string; label: string; sub: string; onClick(): void; autoFocus?: boolean; extra?: React.ReactNode }) {
  return (
    <button className="dr-title-item" onClick={props.onClick} data-autofocus={props.autoFocus ? '' : undefined}>
      <span className="dr-title-n">{props.n}</span>
      <span className="dr-title-label">{props.label}</span>
      <span className="dr-title-sub">{props.sub}</span>
      {props.extra && <span className="dr-title-extra">{props.extra}</span>}
    </button>
  );
}

function PilotEntry(props: { onStart(name: string): void; onBack(): void }) {
  const [name, setName] = useState('');
  const clean = name.trim().slice(0, 16);
  return (
    <div className="dr-pilot" data-nav-layer>
      <div className="dr-panel dr-pilot-card">
        <div className="dr-kicker">New career</div>
        <h2>Pilot licence</h2>
        <p className="dr-dim">Every legend of the circuit started somewhere. Sign your name, take the starter Ember and 500 credits, and enter the Dust Cup.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (clean) props.onStart(clean);
          }}
        >
          <label className="dr-field">
            <span>Pilot name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="Your name" autoComplete="nickname" data-autofocus enterKeyHint="go" />
          </label>
          <div className="dr-row">
            <Btn kind="ghost" onClick={props.onBack}>
              Cancel
            </Btn>
            <button className="dr-btn dr-btn-primary" type="submit" disabled={!clean}>
              <span>Sign &amp; start</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
