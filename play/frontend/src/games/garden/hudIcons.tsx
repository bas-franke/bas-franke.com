// Small inline SVG art for the Garden Sentinels HUD: tower portraits for the build cards, enemy roster icons, and the
// resource glyphs. Flat cel shading with a highlight shape (no gradients or filters, so many copies on one page never
// fight over ids). Palette: Ceramic Cream #F5E7D6, Amber #FFA940, Mint #4EE6D9, Water Blue #2EB3FF,
// Botanical Green #6BAF4B, Alien Violet #A869FF, slate #334050.

import { useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import type { EnemyKind } from '@shared/garden/enemies';
import type { TowerKind } from '@shared/garden/towers';

const CREAM = '#F5E7D6';
const CREAM_D = '#d9c4ab';
const SLATE = '#334050';
const SLATE_L = '#4a5a6c';
const AMBER = '#FFA940';
const MINT = '#4EE6D9';
const BLUE = '#2EB3FF';
const GREEN = '#6BAF4B';
const GREEN_D = '#4d8a33';
const VIOLET = '#A869FF';
const INK = '#1f2630';

function Ground() {
  return (
    <g>
      <ellipse cx="32" cy="55" rx="24" ry="6.5" fill={GREEN_D} />
      <ellipse cx="32" cy="53.5" rx="22" ry="5.5" fill={GREEN} />
      <path d="M12 53 q2 -5 3 0 M16 54 q1.5 -4 2.5 0 M47 53 q2 -5 3 0 M51 54 q1 -3.5 2 0" stroke="#8fd16a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </g>
  );
}

function Laser() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Ground />
      {/* base */}
      <path d="M19 54 L22.5 41 H41.5 L45 54 Z" fill={CREAM} stroke={CREAM_D} strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="21" y="46" width="22" height="3.2" rx="1.6" fill="var(--gs-team, #2EB3FF)" />
      <path d="M23.5 43 H29 L27 52 H21.7 Z" fill="#fff" opacity="0.35" />
      {/* head */}
      <rect x="17" y="23" width="26" height="18" rx="8" fill={SLATE} />
      <rect x="19.5" y="25" width="12" height="4" rx="2" fill={SLATE_L} />
      <circle cx="26" cy="33" r="4.2" fill={INK} />
      <circle cx="26" cy="33" r="2.6" fill={MINT} />
      <circle cx="25" cy="32" r="0.9" fill="#fff" />
      {/* barrel + glowing emitter */}
      <rect x="38" y="28.5" width="15" height="7" rx="3.5" fill={SLATE_L} />
      <rect x="41" y="28.5" width="2" height="7" fill={SLATE} />
      <circle cx="54.5" cy="32" r="7" fill={AMBER} opacity="0.25" />
      <circle cx="54.5" cy="32" r="4.2" fill={AMBER} />
      <circle cx="53.6" cy="31" r="1.6" fill="#fff4dc" />
      {/* antenna */}
      <path d="M22 23 V16" stroke={SLATE} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="22" cy="15" r="2.2" fill={AMBER} />
    </svg>
  );
}

function Shield() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Ground />
      {/* bubble */}
      <path d="M8 53 A24 24 0 0 1 56 53 Z" fill={MINT} opacity="0.22" />
      <path d="M8 53 A24 24 0 0 1 56 53" fill="none" stroke={MINT} strokeWidth="2" />
      <path d="M15 38 A18 18 0 0 1 28 25" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" opacity="0.8" />
      <path d="M8 53 A24 24 0 0 1 56 53" fill="none" stroke="#c9fff9" strokeWidth="0.8" strokeDasharray="2 4" transform="translate(32 53) scale(0.82) translate(-32 -53)" />
      {/* emitter */}
      <path d="M23 54 L25 45 H39 L41 54 Z" fill={CREAM} stroke={CREAM_D} strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="24.5" y="48" width="15" height="2.6" rx="1.3" fill="var(--gs-team, #2EB3FF)" />
      <rect x="27" y="38" width="10" height="8" rx="3" fill={SLATE} />
      <circle cx="32" cy="35" r="5.5" fill={MINT} />
      <circle cx="30.4" cy="33.4" r="1.8" fill="#fff" opacity="0.9" />
      <path d="M44 22 l1.2 2.6 2.6 1.2 -2.6 1.2 -1.2 2.6 -1.2 -2.6 -2.6 -1.2 2.6 -1.2 z" fill="#fff" />
    </svg>
  );
}

function Flower() {
  const petals = [0, 60, 120, 180, 240, 300];
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Ground />
      {/* pot */}
      <path d="M22 44 H42 L39.5 55 H24.5 Z" fill={CREAM} stroke={CREAM_D} strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="20.5" y="41.5" width="23" height="5" rx="2.5" fill={CREAM} stroke={CREAM_D} strokeWidth="1.2" />
      <rect x="23.5" y="48.5" width="17" height="2.6" rx="1.3" fill="var(--gs-team, #2EB3FF)" />
      {/* stem and leaves */}
      <path d="M32 42 C32 36 31 31 32 25" stroke={GREEN_D} strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <path d="M31.5 37 C25 37 21 33 20 29 C26 29 30 32 31.5 37 Z" fill={GREEN} />
      <path d="M32.5 34 C39 34 43 30 44 26 C38 26 34 29 32.5 34 Z" fill={GREEN} />
      {/* bloom */}
      <g transform="translate(32 20)">
        {petals.map((a) => (
          <ellipse key={a} cx="0" cy="-7.5" rx="4.6" ry="7.5" fill={MINT} stroke="#2fc4b8" strokeWidth="0.8" transform={`rotate(${a})`} />
        ))}
        <circle r="5.2" fill={VIOLET} />
        <circle r="2.4" fill={AMBER} />
        <circle cx="-1.6" cy="-1.8" r="1.2" fill="#fff" opacity="0.8" />
      </g>
      {/* pollen motes */}
      <circle cx="12" cy="20" r="1.6" fill={MINT} opacity="0.85" />
      <circle cx="51" cy="14" r="1.3" fill={MINT} opacity="0.75" />
      <circle cx="53" cy="33" r="1.8" fill={MINT} opacity="0.6" />
      <circle cx="10" cy="34" r="1.1" fill={MINT} opacity="0.6" />
    </svg>
  );
}

function Missile() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Ground />
      {/* launching missile + trail */}
      <path d="M44 22 C46 30 41 35 38 38" stroke="#fff" strokeWidth="3.5" fill="none" strokeLinecap="round" opacity="0.6" />
      <g transform="rotate(28 47 13)">
        <rect x="44.5" y="6" width="5" height="13" rx="2.5" fill={CREAM} />
        <path d="M44.5 9 A2.5 3.5 0 0 1 49.5 9 Z" fill="#ff6b5a" />
        <path d="M45.2 19 L47 25 L48.8 19 Z" fill={AMBER} />
      </g>
      {/* base */}
      <path d="M18 54 L21 45 H43 L46 54 Z" fill={CREAM} stroke={CREAM_D} strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="20" y="48.5" width="24" height="2.8" rx="1.4" fill="var(--gs-team, #2EB3FF)" />
      {/* pod */}
      <g transform="rotate(-14 32 36)">
        <rect x="17" y="25" width="30" height="21" rx="6" fill={SLATE} />
        <rect x="19" y="27" width="13" height="3.5" rx="1.75" fill={SLATE_L} />
        {[
          [24, 34],
          [32, 34],
          [40, 34],
          [24, 41],
          [32, 41],
        ].map(([x, y]) => (
          <g key={`${x}${y}`}>
            <circle cx={x} cy={y} r="3.2" fill={INK} />
            <circle cx={x} cy={y} r="2" fill="#ff6b5a" />
          </g>
        ))}
        <circle cx="40" cy="41" r="3.2" fill={INK} />
      </g>
    </svg>
  );
}

function Beacon() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Ground />
      {/* aura rings */}
      <ellipse cx="32" cy="52" rx="22" ry="5" fill="none" stroke="#9cf06a" strokeWidth="1.4" opacity="0.8" />
      <ellipse cx="32" cy="52" rx="15" ry="3.4" fill="none" stroke="#9cf06a" strokeWidth="1.2" opacity="0.6" />
      {/* pylon */}
      <path d="M22 54 L28 34 H36 L42 54 Z" fill={CREAM} stroke={CREAM_D} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M28 34 L36 34 L33 54 H31 Z" fill={SLATE} opacity="0.85" />
      <rect x="24" y="47" width="16" height="2.6" rx="1.3" fill="var(--gs-team, #2EB3FF)" />
      <rect x="25" y="31" width="14" height="4.5" rx="2.25" fill={SLATE} />
      {/* floating crystal */}
      <ellipse cx="32" cy="18" rx="11" ry="11" fill="#7be35a" opacity="0.18" />
      <path d="M32 5 L40 17 L32 28 L24 17 Z" fill="#7be35a" stroke={GREEN_D} strokeWidth="1" strokeLinejoin="round" />
      <path d="M32 5 L40 17 L32 17 Z" fill="#b4ff8e" />
      <path d="M24 17 L32 17 L32 28 Z" fill={GREEN} />
      <path d="M29 10 L31 8" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M14 14 l1 2 2 1 -2 1 -1 2 -1 -2 -2 -1 2 -1 z M50 24 l0.8 1.6 1.6 0.8 -1.6 0.8 -0.8 1.6 -0.8 -1.6 -1.6 -0.8 1.6 -0.8 z" fill="#d8ffc4" />
    </svg>
  );
}

const TOWER_ART: Record<TowerKind, () => JSX.Element> = { laser: Laser, shield: Shield, slow: Flower, missile: Missile, beacon: Beacon };

export function TowerIcon({ kind, team }: { kind: TowerKind; team?: string }) {
  const Art = TOWER_ART[kind];
  return (
    <span className="gs-tower-icon" style={team ? ({ ['--gs-team' as string]: team } as CSSProperties) : undefined}>
      <Art />
    </span>
  );
}

// ---- enemies (32 x 32) ---------------------------------------------------------------------------------------------

function Runner() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 13 L8 3 L14 9 Z" fill="#ff8a3d" />
      <path d="M26 13 L24 3 L18 9 Z" fill="#ff8a3d" />
      <path d="M8.5 9 L9 5.5 L12 8.5 Z M23.5 9 L23 5.5 L20 8.5 Z" fill="#ffd2ad" />
      <path d="M5 15 C5 9 10 7.5 16 7.5 C22 7.5 27 9 27 15 C27 22 21 27 16 27 C11 27 5 22 5 15 Z" fill="#ff8a3d" />
      <path d="M8 17 C10 23 13 26 16 26 C19 26 22 23 24 17 C21 19 18 19.5 16 22 C14 19.5 11 19 8 17 Z" fill="#fff4e6" />
      <circle cx="11.5" cy="14.5" r="2.2" fill={INK} />
      <circle cx="20.5" cy="14.5" r="2.2" fill={INK} />
      <circle cx="11" cy="13.8" r="0.8" fill="#fff" />
      <circle cx="20" cy="13.8" r="0.8" fill="#fff" />
      <ellipse cx="16" cy="21.5" rx="1.8" ry="1.2" fill={INK} />
      <path d="M14 4 L16 1.5 L18 4 L16 6 Z" fill={MINT} />
    </svg>
  );
}

function Skitter() {
  const spikes = Array.from({ length: 10 }, (_, i) => (i * 36 * Math.PI) / 180);
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      {spikes.map((a, i) => (
        <path
          key={i}
          d={`M${16 + Math.cos(a - 0.28) * 8.5} ${17 + Math.sin(a - 0.28) * 8.5} L${16 + Math.cos(a) * 14} ${17 + Math.sin(a) * 14} L${16 + Math.cos(a + 0.28) * 8.5} ${17 + Math.sin(a + 0.28) * 8.5} Z`}
          fill="#2fc4b8"
        />
      ))}
      <circle cx="16" cy="17" r="9.5" fill={MINT} />
      <path d="M9 13 A8 8 0 0 1 15 8.4" stroke="#c9fff9" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="12.6" cy="17" r="2.4" fill={INK} />
      <circle cx="19.4" cy="17" r="2.4" fill={INK} />
      <circle cx="12" cy="16.3" r="0.9" fill="#fff" />
      <circle cx="18.8" cy="16.3" r="0.9" fill="#fff" />
      <path d="M14 21.5 Q16 23 18 21.5" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function Disruptor() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 7 V3" stroke="#7d47d6" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="2.8" r="2" fill={AMBER} />
      <path d="M4 16 l3 -2 -1 3 3 -1" stroke={AMBER} strokeWidth="1.3" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M28 16 l-3 -2 1 3 -3 -1" stroke={AMBER} strokeWidth="1.3" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <ellipse cx="16" cy="28" rx="7" ry="1.6" fill={INK} opacity="0.25" />
      <path d="M16 6.5 C23 6.5 26 11 26 16 C26 21 21.5 25 16 25 C10.5 25 6 21 6 16 C6 11 9 6.5 16 6.5 Z" fill={VIOLET} />
      <path d="M8.8 12 A8 7 0 0 1 14 8" stroke="#dcc4ff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="16" cy="16" r="5" fill={INK} />
      <circle cx="16" cy="16" r="3.2" fill="#ff5ad1" />
      <circle cx="15" cy="15" r="1" fill="#fff" />
      <path d="M10 23.5 L8.5 27 M16 25 V28.5 M22 23.5 L23.5 27" stroke="#7d47d6" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Brute() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 10 L11 2 L14 9 Z" fill="#7ff5ec" stroke="#1d9c94" strokeWidth="0.8" />
      <path d="M14 8 L17 0.5 L19.5 8 Z" fill={MINT} stroke="#1d9c94" strokeWidth="0.8" />
      <path d="M19 9 L23 3 L23.5 10.5 Z" fill="#7ff5ec" stroke="#1d9c94" strokeWidth="0.8" />
      <path d="M4 22 C3 14 8 8.5 16 8.5 C24 8.5 29 14 28 22 C27.5 27 23 29.5 16 29.5 C9 29.5 4.5 27 4 22 Z" fill="#2a9d96" />
      <path d="M7 16 C8 12 11 10.5 14 10.5" stroke="#5fd8cf" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M8 19 H24 C23.5 23 20 25 16 25 C12 25 8.5 23 8 19 Z" fill="#1f6e69" />
      <circle cx="11.5" cy="17" r="2" fill="#ffe36b" />
      <circle cx="20.5" cy="17" r="2" fill="#ffe36b" />
      <path d="M11 22 L12.5 20.5 L14 22 M18 22 L19.5 20.5 L21 22" stroke="#fff" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
      <path d="M3 24 L1 29 H7 Z M29 24 L31 29 H25 Z" fill="#1f6e69" />
    </svg>
  );
}

function Colossus() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 1 L28 11 L23 30 H9 L4 11 Z" fill={VIOLET} />
      <path d="M16 1 L28 11 L16 14 Z" fill={MINT} />
      <path d="M16 1 L4 11 L16 14 Z" fill={BLUE} />
      <path d="M4 11 L16 14 L9 30 Z" fill="#7d47d6" />
      <path d="M28 11 L16 14 L23 30 Z" fill={AMBER} />
      <path d="M16 14 L9 30 H23 Z" fill="#ff6fb5" />
      <path d="M16 1 L28 11 L23 30 H9 L4 11 Z M4 11 L16 14 L28 11 M16 14 L9 30 M16 14 L23 30 M16 1 V14" fill="none" stroke="#fff" strokeWidth="0.8" strokeLinejoin="round" opacity="0.7" />
      <circle cx="13" cy="20" r="1.8" fill="#fff" />
      <circle cx="19" cy="20" r="1.8" fill="#fff" />
      <circle cx="13" cy="20" r="0.9" fill={INK} />
      <circle cx="19" cy="20" r="0.9" fill={INK} />
    </svg>
  );
}

const ENEMY_ART: Record<EnemyKind, () => JSX.Element> = { runner: Runner, skitter: Skitter, disruptor: Disruptor, brute: Brute, colossus: Colossus };

export function EnemyIcon({ kind }: { kind: EnemyKind }) {
  const Art = ENEMY_ART[kind];
  return (
    <span className={`gs-enemy-icon gs-e-${kind}`}>
      <Art />
    </span>
  );
}

// ---- glyphs --------------------------------------------------------------------------------------------------------

/** The green leaf on a disc: the gold / cost glyph from the concept's purchase cards. */
export function Leaf() {
  return (
    <svg className="gs-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9.5" fill={GREEN} />
      <path d="M5 15 C5 8 9 4.5 15.5 4.5 C15.5 11 12 15 5 15 Z" fill="#e9ffd9" />
      <path d="M5.5 14.5 L12 8" stroke={GREEN_D} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Greenhouse heart: lives. */
export function Heart() {
  return (
    <svg className="gs-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 18 C4 13.5 1 10.5 1 6.8 C1 4 3.2 2 5.8 2 C7.6 2 9 3 10 4.4 C11 3 12.4 2 14.2 2 C16.8 2 19 4 19 6.8 C19 10.5 16 13.5 10 18 Z" fill="#ff6f7d" />
      <path d="M6.5 6.5 L10 4.4 L13.5 6.5 V11 H6.5 Z" fill="#fff" opacity="0.92" />
      <path d="M10 4.6 V11 M6.5 8.4 H13.5" stroke="#ff6f7d" strokeWidth="0.9" />
      <path d="M3.8 5.4 A2.6 2.6 0 0 1 6 3.6" stroke="#ffd0d5" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Skull() {
  return (
    <svg className="gs-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 1.5 C14.8 1.5 18 4.6 18 8.8 C18 11.6 16.6 13.2 15 14 V17 C15 17.8 14.4 18.5 13.5 18.5 H6.5 C5.6 18.5 5 17.8 5 17 V14 C3.4 13.2 2 11.6 2 8.8 C2 4.6 5.2 1.5 10 1.5 Z" fill="#f4f1ea" />
      <circle cx="6.8" cy="9.2" r="2.3" fill={INK} />
      <circle cx="13.2" cy="9.2" r="2.3" fill={INK} />
      <path d="M10 11.5 L8.8 13.8 H11.2 Z" fill={INK} />
      <path d="M8 15.5 V18 M10 15.5 V18 M12 15.5 V18" stroke={INK} strokeWidth="1" />
    </svg>
  );
}

export function IncomeArrow() {
  return (
    <svg className="gs-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9.5" fill={AMBER} />
      <path d="M10 15 V5.5 M6 9.2 L10 5.2 L14 9.2" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Trophy() {
  return (
    <svg className="gs-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 3 H15 V8 C15 11 12.8 13 10 13 C7.2 13 5 11 5 8 Z" fill={AMBER} />
      <path d="M5 4.5 H2.5 C2.5 8 4 9.5 5.6 9.8 M15 4.5 H17.5 C17.5 8 16 9.5 14.4 9.8" stroke={AMBER} strokeWidth="1.4" fill="none" />
      <path d="M8.5 13 H11.5 L12 16 H8 Z" fill="#e08a1e" />
      <rect x="6" y="16" width="8" height="2.5" rx="1" fill={GREEN} />
      <path d="M7 4.5 V8" stroke="#fff3d6" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10 5.5 l0.9 1.8 2 0.3 -1.45 1.4 0.35 2 -1.8 -0.95 -1.8 0.95 0.35 -2 -1.45 -1.4 2 -0.3 z" fill="#fff3d6" />
    </svg>
  );
}

// ---- rendered portraits ---------------------------------------------------------------------------------------------

/** Which file (if any) worked per portrait name, remembered for the session so failed lookups are not retried. */
const PORTRAIT_EXT = ['webp', 'png'] as const;
const portraitOk = new Map<string, number>(); // name -> index into PORTRAIT_EXT, or PORTRAIT_EXT.length when none

/**
 * A portrait PNG/WebP rendered from the Blender models (/models/garden/portraits/<name>.webp|png), falling back to the
 * inline SVG art when neither exists.
 */
export function Portrait({ name, fallback }: { name: string; fallback: ReactNode }) {
  const [i, setI] = useState(() => portraitOk.get(name) ?? 0);
  if (i >= PORTRAIT_EXT.length) return <>{fallback}</>;
  return (
    <img
      className="gs-portrait"
      src={`/models/garden/portraits/${name}.${PORTRAIT_EXT[i]}`}
      alt=""
      draggable={false}
      onLoad={() => portraitOk.set(name, i)}
      onError={() => {
        portraitOk.set(name, i + 1);
        setI(i + 1);
      }}
    />
  );
}
