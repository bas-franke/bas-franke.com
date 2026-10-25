// The racing game at /race: menus (career, quick race, garage) and the race screen. The race itself is a RaceView
// mounted into a full-screen container with the React HUD on top. Labs for the art modules live at /race/lab/<name>.

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { type QuickStart, quickPlay } from '../api';
import { sfx } from '../engine/audio';
import { newCareer, playerRacer, quickRaceRacers } from './core/career';
import { trackById } from './core/tracks';
import { RaceView, type RaceResult } from './RaceView';
import { Hud } from './ui/Hud';
import { Menus, type RaceRequest } from './ui/Menus';
import './ui/racer.css';

type Screen = { kind: 'menu' } | { kind: 'race'; req: RaceRequest; n: number } | { kind: 'results'; req: RaceRequest; result: RaceResult };

export function RacerPage() {
  const navigate = useNavigate();
  /** An Online Race request is in flight (double clicks would open two rooms). */
  const joining = useRef(false);
  const [screen, setScreen] = useState<Screen>(() => {
    // /race?go=<track> jumps straight into a quick race (debug, screenshots).
    const go = new URLSearchParams(location.search).get('go');
    if (go) {
      const def = trackById(go);
      return { kind: 'race', n: 0, req: { kind: 'quick', trackId: def.id, racers: quickRaceRacers(playerRacer(newCareer())) } };
    }
    return { kind: 'menu' };
  });

  useEffect(() => {
    const title = document.title;
    document.title = 'Dustrunners · play';
    document.body.classList.add('racer-body');
    return () => {
      document.title = title;
      document.body.classList.remove('racer-body');
    };
  }, []);

  if (screen.kind === 'race')
    return (
      <RaceScreen
        key={screen.n}
        req={screen.req}
        onFinish={(result) => setScreen({ kind: 'results', req: screen.req, result })}
        onQuit={() => setScreen({ kind: 'menu' })}
        onRestart={() => setScreen({ ...screen, n: screen.n + 1 })}
        onExit={() => navigate('/')}
      />
    );
  return (
    <Menus
      finished={screen.kind === 'results' ? { req: screen.req, result: screen.result } : null}
      onRace={(req) => {
        sfx.unlock();
        setScreen({ kind: 'race', req, n: Date.now() });
      }}
      onExit={() => navigate('/')}
      onOnline={() => {
        // Online race: a quick-play Dustrunners room that starts the moment we are in, like the lobby's Play now.
        if (joining.current) return;
        joining.current = true;
        sfx.unlock();
        quickPlay('dustrunners')
          .then((code) => navigate(`/room/${code}`, { state: { quickStart: true } satisfies QuickStart }))
          .catch((e: unknown) => {
            // No quick-play room: fall back to the create dialog with Dustrunners picked.
            console.warn('Online race: quick play failed, opening the create dialog', e);
            navigate('/?create=dustrunners');
          })
          .finally(() => {
            joining.current = false;
          });
      }}
    />
  );
}

function RaceScreen(props: { req: RaceRequest; onFinish(r: RaceResult): void; onQuit(): void; onRestart(): void; onExit(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<RaceView | null>(null);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const v = new RaceView(host.current!, {
      trackId: props.req.trackId,
      racers: props.req.racers,
      onFinish: (r) => cb.current.onFinish(r),
    });
    v.start();
    setView(v);
    return () => v.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="racer-screen">
      <div className="racer-host" ref={host} />
      {view && <Hud view={view} onQuit={() => cb.current.onQuit()} onRestart={() => cb.current.onRestart()} onExit={() => cb.current.onExit()} />}
    </div>
  );
}

/** /race/lab/<name>: a module's own test bench (racer/lab/<name>.ts exporting `mount(el): () => void`). */
const labs = import.meta.glob<{ mount(el: HTMLElement): () => void }>('./lab/*.ts');

export function RacerLab() {
  const { name } = useParams();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = labs[`./lab/${name}.ts`];
    if (!load) {
      setError(`No lab "${name}". Labs: ${Object.keys(labs).map((k) => k.slice(6, -3)).join(', ')}`);
      return;
    }
    let undo: (() => void) | undefined;
    let alive = true;
    load().then((m) => {
      if (alive) undo = m.mount(host.current!);
    });
    return () => {
      alive = false;
      undo?.();
    };
  }, [name]);
  return (
    <div className="racer-screen">
      <div className="racer-host" ref={host} />
      {error && <p style={{ position: 'absolute', top: 20, left: 20, color: 'white' }}>{error}</p>}
    </div>
  );
}
