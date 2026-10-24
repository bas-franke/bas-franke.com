// The Rockets map picker: a card per map with a top-down preview drawn from the map's own box data.

import { useEffect, useRef } from 'react';
import { colorHex } from '@shared/protocol';
import type { BoxKind, MapData } from '@shared/rockets/map';
import { MAPS, RANDOM_MAP } from '@shared/rockets/maps';

/** Same base colours arena.ts paints the boxes with; a map's `tint` overrides them per kind. */
const PALETTE: Record<Exclude<BoxKind, 'clip'>, number> = {
  floor: 0xe6d6ae,
  wall: 0x7d93c4,
  platform: 0xf2c14e,
  stair: 0xe8b04a,
  pillar: 0x5ec2e6,
  crate: 0xd9733b,
  ledge: 0xe85d5d,
  tower: 0x8d6bd9,
};
const DEFAULT_ACCENT = 0x3ee0b0;

const kindColor = (map: MapData, kind: Exclude<BoxKind, 'clip'>) => map.tint?.[kind] ?? PALETTE[kind];

/** Scales a 0xRRGGBB colour's channels by `f` (below 1 darkens, above 1 lightens towards white). */
function shade(c: number, f: number) {
  const ch = (v: number) => Math.round(f <= 1 ? v * f : v + (255 - v) * (f - 1));
  return `rgb(${ch((c >> 16) & 255)}, ${ch((c >> 8) & 255)}, ${ch(c & 255)})`;
}

/** Draws the map seen from straight above: higher boxes on top and brighter, spawns as white dots facing in. */
function drawPreview(canvas: HTMLCanvasElement, map: MapData) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = canvas.clientWidth || 160;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const extent = map.half + 2;
  const scale = size / (extent * 2);
  const px = (x: number) => (x + extent) * scale;

  g.fillStyle = shade(map.skyColor, 0.45);
  g.fillRect(0, 0, size, size);

  const boxes = map.boxes.filter((b) => b.kind !== 'clip').sort((a, b) => a.max.y - b.max.y);
  const top = Math.max(1, ...boxes.map((b) => b.max.y));
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(11, 15, 26, 0.55)';
  for (const b of boxes) {
    const kind = b.kind as Exclude<BoxKind, 'clip'>;
    const h = Math.max(0, b.max.y) / top;
    g.fillStyle = shade(kindColor(map, kind), 0.62 + h * 0.55);
    const x = px(b.min.x);
    const y = px(b.min.z);
    const w = Math.max(1, (b.max.x - b.min.x) * scale);
    const d = Math.max(1, (b.max.z - b.min.z) * scale);
    g.fillRect(x, y, w, d);
    if (kind !== 'floor') g.strokeRect(x + 0.5, y + 0.5, w - 1, d - 1);
  }

  const accent = colorHex(map.accent ?? DEFAULT_ACCENT);
  g.strokeStyle = accent;
  g.lineWidth = 1.5;
  for (const p of map.pads) {
    g.beginPath();
    g.arc(px(p.pos.x), px(p.pos.z), Math.max(2, p.radius * scale), 0, Math.PI * 2);
    g.stroke();
  }

  g.fillStyle = '#4ade80';
  for (const p of map.packs) g.fillRect(px(p.x) - 1.5, px(p.z) - 1.5, 3, 3);

  for (const s of map.spawns) {
    const x = px(s.pos.x);
    const y = px(s.pos.z);
    g.strokeStyle = '#0b0f1a';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - Math.sin(s.yaw) * 5, y - Math.cos(s.yaw) * 5);
    g.stroke();
    g.beginPath();
    g.arc(x, y, 2.4, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.stroke();
  }
}

/** The colours a map is recognised by: sky, accent trim and its most visible surfaces. */
function swatches(map: MapData) {
  const colours = [map.skyColor, map.accent ?? DEFAULT_ACCENT, kindColor(map, 'platform'), kindColor(map, 'wall'), kindColor(map, 'pillar')];
  return [...new Set(colours)].slice(0, 5).map(colorHex);
}

export function MapPreview({ map }: { map: MapData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawPreview(ref.current, map);
  }, [map]);
  return <canvas ref={ref} className="map-preview" aria-hidden="true" />;
}

export function MapPicker({ value, editable, onPick }: { value: string; editable: boolean; onPick: (id: string) => void }) {
  return (
    <div className="map-grid" role="radiogroup" aria-label="Map">
      <button
        type="button"
        role="radio"
        aria-checked={value === RANDOM_MAP}
        className={`map-card${value === RANDOM_MAP ? ' active' : ''}`}
        disabled={!editable}
        onClick={() => onPick(RANDOM_MAP)}
      >
        <span className="map-preview random">?</span>
        <span className="map-name">Random</span>
        <span className="map-sub">New map every match</span>
      </button>
      {MAPS.map((m) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === m.id}
          key={m.id}
          className={`map-card${value === m.id ? ' active' : ''}`}
          disabled={!editable}
          onClick={() => onPick(m.id)}
        >
          <MapPreview map={m} />
          <span className="map-name">{m.name}</span>
          <span className="map-swatches">
            {swatches(m).map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}
