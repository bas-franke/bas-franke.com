// Waiting-room panels for Dustrunners: the track picker (a card per course with its outline seen from above, drawn
// from the racer's own centreline data) and the way to the solo career and time trials on /race.

import { Link } from 'react-router-dom';
import type { RoomView } from '@shared/protocol';
import { DR_TRACKS, drTrackById } from '@shared/dustrunners/tracks';
import { RANDOM_MAP } from '@shared/rockets/maps';
import { TRACKS, type TrackDef } from '../racer/core/tracks';
import './dustrunners-room.css';

const defOf = (id: string): TrackDef | undefined => TRACKS.find((t) => t.id === id);

export function dustrunnersTrackName(room: RoomView): string {
  return drTrackById(room.map)?.name ?? 'Random track';
}

/** Course length in metres along the control points (they are ~20 m apart, so this is close to the real thing). */
function trackLength(def: TrackDef) {
  let d = 0;
  for (let i = 1; i < def.points.length; i++) d += Math.hypot(def.points[i][0] - def.points[i - 1][0], def.points[i][1] - def.points[i - 1][1]);
  return d;
}

/** The course from above, fitted into a square: dirt-coloured ribbon, green start dot, chequered finish. */
function TrackThumb({ def }: { def: TrackDef }) {
  const xs = def.points.map((p) => p[0]);
  const zs = def.points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...zs) - minZ) || 1;
  const pad = 10;
  const size = 100 - pad * 2;
  const offX = pad + (size - ((Math.max(...xs) - minX) / span) * size) / 2;
  const offZ = pad + (size - ((Math.max(...zs) - minZ) / span) * size) / 2;
  const pts = def.points.map((p) => [offX + ((p[0] - minX) / span) * size, offZ + ((p[1] - minZ) / span) * size] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [sx, sy] = pts[0];
  const [fx, fy] = pts[pts.length - 1];
  const t = def.theme;
  return (
    <svg className="drr-thumb" viewBox="0 0 100 100" aria-hidden style={{ background: `linear-gradient(160deg, ${t.skyHorizon}, ${t.sand})` }}>
      <path d={d} fill="none" stroke={t.rockShade} strokeWidth="7" strokeLinejoin="round" strokeLinecap="round" opacity="0.55" />
      <path d={d} fill="none" stroke={t.dirt} strokeWidth="3.6" strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke="#fff" strokeWidth="0.6" strokeDasharray="2 3" opacity="0.6" />
      <circle cx={sx} cy={sy} r="3.2" fill="#3ee07a" stroke="#14100c" strokeWidth="1" />
      <rect x={fx - 3.2} y={fy - 3.2} width="6.4" height="6.4" fill="#fff" stroke="#14100c" strokeWidth="1" />
      <path d={`M${fx - 3.2} ${fy - 3.2}h3.2v3.2h-3.2zM${fx} ${fy}h3.2v3.2h-3.2z`} fill="#14100c" />
    </svg>
  );
}

export function DustrunnersPanels({ room, isHost, playing, setMap }: { room: RoomView; isHost: boolean; playing: boolean; setMap: (m: string) => void }) {
  const current = drTrackById(room.map);
  return (
    <div className="panel">
      <div className="section-head">
        <h2>Track</h2>
        <span className="slots">
          {current?.name ?? 'Random track'}
          {!isHost && ' · the host picks'}
        </span>
      </div>
      {/* The cards are the picker; this select stays for keyboard users and the screenshot tool. */}
      {isHost && (
        <select className="visually-hidden" data-testid="map-select" aria-label="Track" value={current ? room.map : RANDOM_MAP} disabled={playing} onChange={(e) => setMap(e.target.value)}>
          <option value={RANDOM_MAP}>Random track</option>
          {DR_TRACKS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <div className="mode-cards drr-tracks" role="radiogroup" aria-label="Track">
        <button type="button" role="radio" aria-checked={!current} className={`mode-card drr-track${!current ? ' active' : ''}`} disabled={!isHost || playing} onClick={() => setMap(RANDOM_MAP)}>
          <span className="drr-thumb drr-random" aria-hidden>
            ?
          </span>
          <b>Random</b>
          <span>A different canyon every race.</span>
          <em>{DR_TRACKS.length} tracks in the hat</em>
        </button>
        {DR_TRACKS.map((t) => {
          const def = defOf(t.id);
          return (
            <button
              type="button"
              role="radio"
              aria-checked={t.id === room.map}
              key={t.id}
              className={`mode-card drr-track${t.id === room.map ? ' active' : ''}`}
              disabled={!isHost || playing}
              onClick={() => setMap(t.id)}
            >
              {def ? <TrackThumb def={def} /> : <span className="drr-thumb" aria-hidden />}
              <b>{t.name}</b>
              {def && <span>{def.blurb}</span>}
              {def && (
                <em>
                  {(trackLength(def) / 1000).toFixed(1)} km · {def.jumps.length} {def.jumps.length === 1 ? 'jump' : 'jumps'}
                </em>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Under the game card: the solo side of Dustrunners still lives on its own page. */
export function DustrunnersSoloLink() {
  return (
    <Link className="btn small drr-solo" to="/race">
      Career &amp; time trials (solo)
    </Link>
  );
}
