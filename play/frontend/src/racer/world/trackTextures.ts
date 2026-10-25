// Procedural textures for the race track: the barrier atlas (chevron panels, steel, kerb, stone, checker, banner,
// hazard stripes) with a matching emissive atlas, used by the gantries, bridges and start lines, and the glowing boost
// pad chevrons.

import * as THREE from 'three';
import { rng } from '../core/track';

/** Atlas rows (each a 2:1 cell, 8 rows stacked). */
export const ROW = { chevron: 0, steel: 1, kerb: 2, stone: 3, checker: 4, banner: 5, hazard: 6, grate: 7 } as const;
const ROWS = 8;
const CELL_W = 512;
const CELL_H = 256;

/** v range [bottom, top] of an atlas row, inset so mipmaps do not bleed between rows. */
export function rowV(row: number): [number, number] {
  const inset = 3 / (CELL_H * ROWS);
  return [1 - (row + 1) / ROWS + inset, 1 - row / ROWS - inset];
}

// ---------------------------------------------------------------- barrier atlas

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

/** Speckle wear / grime over a rect. */
function grime(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: () => number, n: number, colors: string[], alpha = 0.25) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = alpha * r();
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = 1 + r() * r() * 6;
    g.fillRect(x + r() * w, y + r() * h, s * (1 + r() * 3), s);
  }
  g.globalAlpha = 1;
}

/** One chevron ">" across a cell: apex at ax, `thick` wide (horizontal), spanning y0..y1. */
function chevronPath(g: CanvasRenderingContext2D, ax: number, y0: number, y1: number, depth: number, thick: number) {
  const my = (y0 + y1) / 2;
  g.beginPath();
  g.moveTo(ax - depth, y0);
  g.lineTo(ax - depth + thick, y0);
  g.lineTo(ax + thick, my);
  g.lineTo(ax - depth + thick, y1);
  g.lineTo(ax - depth, y1);
  g.lineTo(ax, my);
  g.closePath();
}

export function barrierAtlas(theme: { banners: string[]; rockLit: string; rockShade: string }, anisotropy: number) {
  const W = CELL_W;
  const Hh = CELL_H;
  const { c, g } = canvas(W, Hh * ROWS);
  const { c: ce, g: ge } = canvas(W, Hh * ROWS);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, Hh * ROWS);
  const r = rng(9137);
  const y0 = (row: number) => row * Hh;

  // Chevron panel: black, steel top rim, dark footing, two big yellow chevrons pointing towards +u (direction of travel).
  {
    const y = y0(ROW.chevron);
    g.fillStyle = '#17171a';
    g.fillRect(0, y, W, Hh);
    grime(g, 0, y, W, Hh, r, 500, ['#2c2c30', '#000', '#3a2a20']);
    const top = y + 22;
    const bot = y + Hh - 24;
    for (let k = 0; k < 2; k++) {
      const ax = k * 256 + 135;
      for (const [gg, glow] of [[g, false], [ge, true]] as const) {
        chevronPath(gg, ax, top + 6, bot - 6, 100, 86);
        gg.fillStyle = glow ? '#c99a10' : '#f7c51e';
        gg.fill();
      }
      // Paint wear on the chevron.
      g.save();
      chevronPath(g, ax, top + 6, bot - 6, 100, 86);
      g.clip();
      const grad = g.createLinearGradient(0, top, 0, bot);
      grad.addColorStop(0, 'rgba(255,240,170,0.35)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(120,60,0,0.35)');
      g.fillStyle = grad;
      g.fillRect(0, y, W, Hh);
      grime(g, 0, y, W, Hh, r, 260, ['#5a3a12', '#222', '#b8860b'], 0.35);
      g.restore();
    }
    // Rim and footing, panel seams and bolts.
    g.fillStyle = '#8d8f93';
    g.fillRect(0, y, W, 16);
    g.fillStyle = '#5c5e62';
    g.fillRect(0, y + 14, W, 6);
    g.fillStyle = '#2a2420';
    g.fillRect(0, bot + 6, W, Hh - (bot - y) - 6);
    g.fillStyle = '#0a0a0b';
    for (const sx of [0, 255]) g.fillRect(sx, y + 16, 3, Hh - 16);
    g.fillStyle = '#6b6d70';
    for (const sx of [12, 244, 268, 500]) for (const sy of [y + 30, y + Hh - 36]) g.fillRect(sx, sy, 5, 5);
    // Yellow pin stripe under the rim, slightly emissive.
    for (const gg of [g, ge]) {
      gg.fillStyle = gg === g ? '#e3b21b' : '#6e5306';
      gg.fillRect(0, y + 20, W, 3);
    }
  }

  // Steel: weathered grey panels with vertical seams, rivets and rust runs.
  {
    const y = y0(ROW.steel);
    const grad = g.createLinearGradient(0, y, 0, y + Hh);
    grad.addColorStop(0, '#6f6a64');
    grad.addColorStop(1, '#46403b');
    g.fillStyle = grad;
    g.fillRect(0, y, W, Hh);
    for (let k = 0; k < 4; k++) {
      g.fillStyle = '#3d3a37';
      g.fillRect(k * 128, y, 3, Hh);
      g.fillStyle = '#a5a29c';
      g.fillRect(k * 128 + 3, y, 2, Hh);
      for (let j = 0; j < 6; j++) {
        g.fillStyle = '#46423e';
        g.fillRect(k * 128 + 10, y + 18 + j * 40, 5, 5);
        g.fillRect(k * 128 + 113, y + 18 + j * 40, 5, 5);
      }
    }
    for (let k = 0; k < 14; k++) {
      const x = r() * W;
      const rg = g.createLinearGradient(0, y, 0, y + Hh);
      rg.addColorStop(0, 'rgba(120,64,30,0.55)');
      rg.addColorStop(1, 'rgba(120,64,30,0)');
      g.fillStyle = rg;
      g.fillRect(x, y + r() * 60, 3 + r() * 10, Hh * (0.3 + r() * 0.7));
    }
    grime(g, 0, y, W, Hh, r, 700, ['#3a2a20', '#2a2a2a', '#b0aaa0', '#7a4a2a']);
    g.fillStyle = '#8c8780';
    g.fillRect(0, y, W, 8);
  }

  // Kerb: red / white blocks with a bevel.
  {
    const y = y0(ROW.kerb);
    for (let k = 0; k < 4; k++) {
      const red = k % 2 === 0;
      for (const [gg, glow] of [[g, false], [ge, true]] as const) {
        gg.fillStyle = red ? (glow ? '#4a0a08' : '#d0281f') : glow ? '#4a4a4a' : '#efebe4';
        gg.fillRect(k * 128, y, 128, Hh);
      }
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(k * 128, y, 128, 14);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(k * 128, y + Hh - 16, 128, 16);
      g.fillRect(k * 128 + 125, y, 3, Hh);
    }
    grime(g, 0, y, W, Hh, r, 500, ['#6a4a30', '#3a2a20', '#c08050']);
  }

  // Stone: sandstone blocks with mortar.
  {
    const y = y0(ROW.stone);
    g.fillStyle = '#5a3a2a';
    g.fillRect(0, y, W, Hh);
    const rows = 3;
    for (let j = 0; j < rows; j++) {
      const bh = Hh / rows;
      let x = j % 2 ? -64 : 0;
      while (x < W) {
        const bw = 110 + Math.floor(r() * 3) * 34;
        const c0 = new THREE.Color(theme.rockLit).lerp(new THREE.Color(theme.rockShade), 0.15 + r() * 0.35);
        g.fillStyle = `#${c0.getHexString()}`;
        g.fillRect(x + 3, y + j * bh + 3, bw - 6, bh - 6);
        g.fillStyle = 'rgba(255,220,180,0.25)';
        g.fillRect(x + 3, y + j * bh + 3, bw - 6, 6);
        x += bw;
      }
    }
    grime(g, 0, y, W, Hh, r, 900, ['#3a2018', '#e0a070', '#7a4028']);
  }

  // Checker: 8 x 4 squares.
  {
    const y = y0(ROW.checker);
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 8; k++) {
        const white = (j + k) % 2 === 0;
        g.fillStyle = white ? '#f2efe8' : '#151515';
        g.fillRect(k * 64, y + j * 64, 64, 64);
        if (white) {
          ge.fillStyle = '#303030';
          ge.fillRect(k * 64, y + j * 64, 64, 64);
        }
      }
    }
    grime(g, 0, y, W, Hh, r, 400, ['#8a6040', '#5a4030']);
  }

  // Banner: team colour with the race name, drawn squashed because the gantry stretches it.
  {
    const y = y0(ROW.banner);
    const bg = theme.banners[0] ?? '#2c63c7';
    g.fillStyle = bg;
    g.fillRect(0, y, W, Hh);
    g.fillStyle = '#111';
    g.fillRect(0, y, W, 26);
    g.fillRect(0, y + Hh - 26, W, 26);
    for (const gg of [g, ge]) {
      gg.fillStyle = gg === g ? '#f7c51e' : '#5a4808';
      gg.fillRect(0, y + 26, W, 6);
      gg.fillRect(0, y + Hh - 32, W, 6);
      gg.save();
      gg.translate(W / 2, y + Hh / 2 + 4);
      gg.scale(0.5, 1);
      gg.font = 'italic 900 100px "Arial Black", Arial, sans-serif';
      gg.textAlign = 'center';
      gg.textBaseline = 'middle';
      gg.fillStyle = gg === g ? '#ffffff' : '#9a9a9a';
      gg.fillText('DUSTRUNNERS', 0, 0);
      gg.restore();
    }
  }

  // Hazard stripes.
  {
    const y = y0(ROW.hazard);
    g.fillStyle = '#18181a';
    g.fillRect(0, y, W, Hh);
    for (const gg of [g, ge]) {
      gg.save();
      gg.beginPath();
      gg.rect(0, y, W, Hh);
      gg.clip();
      gg.fillStyle = gg === g ? '#f2bd1d' : '#3a2c04';
      for (let k = -4; k < 10; k++) {
        gg.beginPath();
        gg.moveTo(k * 64, y + Hh);
        gg.lineTo(k * 64 + 32, y + Hh);
        gg.lineTo(k * 64 + 32 + Hh, y);
        gg.lineTo(k * 64 + Hh, y);
        gg.closePath();
        gg.fill();
      }
      gg.restore();
    }
    grime(g, 0, y, W, Hh, r, 500, ['#3a2a20', '#000', '#8a6a30']);
  }

  // Grate / dark steel.
  {
    const y = y0(ROW.grate);
    g.fillStyle = '#3a3836';
    g.fillRect(0, y, W, Hh);
    g.fillStyle = '#26241f';
    for (let k = 0; k < W; k += 16) g.fillRect(k, y, 4, Hh);
    for (let k = 0; k < Hh; k += 32) g.fillRect(0, y + k, W, 3);
    grime(g, 0, y, W, Hh, r, 600, ['#6a4a30', '#141414', '#7a7672']);
  }

  const make = (cv: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = anisotropy;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: make(c), emissiveMap: make(ce) };
}

// ---------------------------------------------------------------- boost pad

/** Pad textures: a dark metal base (static) and two glowing chevrons per tile pointing towards +v (scrolled). */
export function padTextures(anisotropy: number) {
  const { c, g } = canvas(256, 256);
  g.fillStyle = '#2b2420';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#1b1714';
  for (let k = 0; k < 256; k += 12) g.fillRect(k, 0, 4, 256);
  const r = rng(77);
  grime(g, 0, 0, 256, 256, r, 300, ['#4a3020', '#000', '#6a5040']);
  // Chevrons faintly in the base too, so the pad reads in shadow.
  const { c: ce, g: ge } = canvas(256, 256);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, 256, 256);
  const drawChev = (gg: CanvasRenderingContext2D, cy: number, fill: string, blur: number) => {
    gg.save();
    gg.shadowColor = fill;
    gg.shadowBlur = blur;
    gg.fillStyle = fill;
    gg.beginPath();
    // "^" pointing up the canvas (canvas top = +v).
    gg.moveTo(22, cy + 80);
    gg.lineTo(128, cy - 20);
    gg.lineTo(234, cy + 80);
    gg.lineTo(234, cy + 126);
    gg.lineTo(128, cy + 26);
    gg.lineTo(22, cy + 126);
    gg.closePath();
    gg.fill();
    gg.restore();
  };
  // Drawn at -108 too so the tile wraps seamlessly in v.
  for (const cy of [-108, 20, 148]) drawChev(ge, cy, '#ff9a30', 16);
  for (const cy of [-108, 20, 148]) drawChev(ge, cy, '#ffc070', 0);
  const base = new THREE.CanvasTexture(c);
  base.colorSpace = THREE.SRGBColorSpace;
  base.wrapS = base.wrapT = THREE.RepeatWrapping;
  base.anisotropy = anisotropy;
  const glow = new THREE.CanvasTexture(ce);
  glow.colorSpace = THREE.SRGBColorSpace;
  glow.wrapS = glow.wrapT = THREE.RepeatWrapping;
  glow.anisotropy = anisotropy;
  return { map: base, emissiveMap: glow };
}
