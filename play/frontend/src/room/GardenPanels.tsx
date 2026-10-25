// Waiting-room panels for Garden Sentinels: co-op / versus, and the maps of that mode.

import type { GameMode, RoomView } from '@shared/protocol';
import { GMODES, type GMode, isGMode } from '@shared/garden/constants';
import { RANDOM_GMAP, gmapById, gmapsFor } from '@shared/garden/maps';
import { GardenMapThumb, routeLengths } from './GardenMapThumb';
import './garden-room.css';

const MODE_ICONS: Record<GMode, string> = { coop: '❀', vs: '⚔' };

export function gardenMode(room: RoomView): GMode {
  return isGMode(room.mode) ? room.mode : 'coop';
}

export function gardenMapName(room: RoomView): string {
  return room.map === RANDOM_GMAP ? 'a random garden' : (gmapById(room.map)?.name ?? 'a random garden');
}

export function GardenPanels({
  room,
  isHost,
  playing,
  setMode,
  setMap,
}: {
  room: RoomView;
  isHost: boolean;
  playing: boolean;
  setMode: (m: GameMode) => void;
  setMap: (m: string) => void;
}) {
  const mode = gardenMode(room);
  const maps = gmapsFor(mode);
  const current = gmapById(room.map);
  return (
    <>
      <div className="panel">
        <div className="section-head">
          <h2>Mode</h2>
          <span className="slots">
            {GMODES[mode].name}
            {!isHost && ' · the host picks'}
          </span>
        </div>
        {isHost && (
          <select className="visually-hidden" data-testid="mode-select" aria-label="Game mode" value={mode} disabled={playing} onChange={(e) => setMode(e.target.value as GameMode)}>
            {(Object.keys(GMODES) as GMode[]).map((id) => (
              <option key={id} value={id}>
                {GMODES[id].name}
              </option>
            ))}
          </select>
        )}
        <div className="mode-cards" role="radiogroup" aria-label="Game mode">
          {(Object.keys(GMODES) as GMode[]).map((id) => (
            <button
              type="button"
              role="radio"
              aria-checked={id === mode}
              key={id}
              className={`mode-card${id === mode ? ' active' : ''}`}
              disabled={!isHost || playing}
              onClick={() => setMode(id)}
            >
              <span className="mode-icon" aria-hidden>
                {MODE_ICONS[id]}
              </span>
              <b>{GMODES[id].name}</b>
              <span>{GMODES[id].blurb}</span>
              <em>{id === 'coop' ? '1 to 6 defenders · 30 waves' : '2 to 6 gardens · last one standing'}</em>
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="section-head">
          <h2>Garden</h2>
          <span className="slots">
            {current?.name ?? 'Random garden'}
            {!isHost && ' · the host picks'}
          </span>
        </div>
        {isHost && (
          <select className="visually-hidden" data-testid="map-select" aria-label="Map" value={current ? room.map : RANDOM_GMAP} onChange={(e) => setMap(e.target.value)}>
            <option value={RANDOM_GMAP}>Random garden</option>
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <div className="mode-cards gsr-maps" role="radiogroup" aria-label="Map">
          <button
            type="button"
            role="radio"
            aria-checked={!current}
            className={`mode-card gsr-map${!current ? ' active' : ''}`}
            disabled={!isHost}
            onClick={() => setMap(RANDOM_GMAP)}
          >
            <span className="gsr-thumb gsr-random" aria-hidden>
              {maps.slice(0, 3).map((m, i) => (
                <GardenMapThumb key={m.id} map={m} className={`gsr-stack gsr-stack-${i}`} />
              ))}
              <span className="gsr-q">?</span>
            </span>
            <b>Random</b>
            <span>A different garden every match.</span>
            <em>
              {maps.length} {maps.length === 1 ? 'garden' : 'gardens'} in the hat
            </em>
          </button>
          {maps.map((m) => {
            const lens = routeLengths(m);
            const lo = lens.length ? Math.min(...lens) : 0;
            const hi = lens.length ? Math.max(...lens) : 0;
            const vsOnly = m.modes.length === 1 && m.modes[0] === 'vs';
            return (
              <button
                type="button"
                role="radio"
                aria-checked={m.id === room.map}
                key={m.id}
                className={`mode-card gsr-map${m.id === room.map ? ' active' : ''}`}
                disabled={!isHost}
                onClick={() => setMap(m.id)}
              >
                <span className="gsr-thumb">
                  <GardenMapThumb map={m} />
                  {m.modes.includes('vs') && (
                    <span className="gsr-chip gsr-chip-vs" title={vsOnly ? 'Versus only' : 'Playable in versus'}>
                      ⚔ Versus
                    </span>
                  )}
                </span>
                <b>{m.name}</b>
                <span>{m.blurb}</span>
                <em className="gsr-stats">
                  <span title="Entry portals">
                    <i aria-hidden>◉</i> {m.entries.length} {m.entries.length === 1 ? 'entrance' : 'entrances'}
                  </span>
                  {lens.length > 0 && (
                    <span title={lens.length > 1 ? 'Shortest to longest route' : 'Route length'}>
                      <i aria-hidden>↝</i> {lo === hi ? `${lo} m` : `${lo}–${hi} m`}
                    </span>
                  )}
                </em>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
