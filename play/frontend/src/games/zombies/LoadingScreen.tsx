// The Last Light loading screen: a key-art still slowly pushing in, the map and its open wings, a rotating tip and the
// real load progress from client.ts (ZHudState.loading). It fades out once the client reports ready and unmounts
// itself when the fade is done; while fading it no longer takes input.

import { useEffect, useRef, useState } from 'react';
import { ZB } from '@shared/zombies/constants';
import { ARMOR_PRICE, NADE_PRICE } from '@shared/zombies/weapons';
import { pickArt } from './art';
import type { ZHudState } from './client';

const FADE_MS = 600;

const TIPS = [
  `Headshots pay. A kill to the head is worth ${ZB.pointsHead} points, a body kill ${ZB.pointsKill}.`,
  `The knife (V) costs nothing and pays ${ZB.pointsKnife} points a kill. On wave 1 one stab kills: save the bullets.`,
  `Hold E at a torn window to nail the boards back up: ${ZB.pointsBoard} points a board, up to ${ZB.boardPointsCap} a wave.`,
  `A downed teammate has ${ZB.bleedOut} seconds. Hold E next to them for ${ZB.reviveTime} to bring them back, and ${ZB.pointsRevive} points.`,
  'Weapon lockers along the walls sell guns old and new. Use the one that sells your gun again to refill its ammo.',
  `Frag grenades (G) cost ${NADE_PRICE} points and you carry up to ${ZB.nadeMax}. Stand clear: they hurt you too.`,
  `An armor vest (${ARMOR_PRICE} points) soaks up ${Math.round(ZB.armorShare * 100)}% of every hit until it is spent.`,
  `Health comes back on its own ${ZB.regenDelay} seconds after the last hit. Back off, then get back in.`,
  'Your flashlight (F) cuts through the dark, but the lobby lamps flicker. Watch the shadows near the windows.',
  'Bigger squads open more of the hotel: the lounge bar from 4 survivors, the restaurant from 7.',
  'Everything breaks. Grenades and heavy rounds tear through marble, glass and columns, and so do the dead.',
  'Rifles and sniper rounds go through more than one body. Line them up in a doorway.',
  'From wave 6 some of the dead stop shambling and start to jog. Keep an exit open.',
  'Bled out? You are back on your feet at the start of the next wave, if the others hold out that long.',
  `Every hit pays ${ZB.pointsHit} points, so a few body shots before the kill earn more than one clean shot.`,
];

const TIP_MS = 6500;

export function LoadingScreen({ s }: { s: Pick<ZHudState, 'ready' | 'loading' | 'mapName' | 'wings'> }) {
  const [art] = useState(pickArt);
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  const [gone, setGone] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const pct = useRef<HTMLSpanElement>(null);
  const target = useRef(0);
  target.current = s.ready ? 1 : (s.loading?.done ?? 0);

  // The bar eases toward the real progress on its own clock (no React renders per frame) and never moves back.
  useEffect(() => {
    let shown = 0;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const want = target.current;
      if (want > shown) shown = Math.min(want, shown + Math.max(0.04 * dt, (want - shown) * Math.min(1, dt * 4)));
      if (bar.current) bar.current.style.transform = `scaleX(${shown})`;
      if (pct.current) pct.current.textContent = `${Math.floor(shown * 100)}%`;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setTip((i) => (i + 1) % TIPS.length), TIP_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!s.ready) return;
    const t = window.setTimeout(() => setGone(true), FADE_MS + 50);
    return () => window.clearTimeout(t);
  }, [s.ready]);

  if (gone) return null;
  return (
    <div className={`ll-load ${s.ready ? 'out' : ''}`} style={{ ['--fade' as string]: `${FADE_MS}ms` }} aria-busy={!s.ready}>
      {art && <div className="ll-load-art" style={{ backgroundImage: `url(${art.src})` }} />}
      <div className="ll-load-shade" />
      <div className="ll-load-grain" />

      <div className="ll-load-title">
        <div className="ll-load-kicker">Last Light</div>
        <h1>{s.mapName || 'Grand Meridian Hotel'}</h1>
        {s.wings.length > 0 && (
          <ul className="ll-load-wings">
            {s.wings.map((w) => (
              <li key={w.name} className={w.open ? 'open' : ''}>
                {w.name}
                {!w.open && <span>{w.minPlayers}+ survivors</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ll-load-foot">
        <div className="ll-load-tip" key={tip}>
          <b>Tip</b>
          {TIPS[tip]}
        </div>
        <div className="ll-load-status">
          <span>{s.ready ? 'Ready' : (s.loading?.stage ?? 'Loading')}…</span>
          <span ref={pct} className="ll-load-pct">
            0%
          </span>
        </div>
        <div className="ll-load-bar">
          <i ref={bar} />
        </div>
      </div>

      {art?.caption && <div className="ll-load-caption">{art.caption}</div>}
    </div>
  );
}
