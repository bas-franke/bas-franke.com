// Hand-drawn canvas textures for the Rockets arenas. Every texture is greyscale on white, so the material colour
// tints it: lines come out as the surface colour darkened rather than black, which keeps the first-person view calm
// and avoids moire at range. All of them tile seamlessly and get mipmaps plus anisotropic filtering.

import * as THREE from 'three';

export type TexKey = 'tiles' | 'turf' | 'bricks' | 'stone' | 'strata' | 'metal' | 'ribs' | 'panels' | 'windows' | 'planks' | 'crate' | 'hazard';

/** World metres covered by one repeat of each texture (the crate is mapped once per face instead). */
export const TEX_SIZE: Record<TexKey, number> = {
  tiles: 8,
  turf: 6,
  bricks: 4,
  stone: 5,
  strata: 6,
  metal: 4,
  ribs: 2,
  panels: 4,
  windows: 4,
  planks: 3,
  crate: 1,
  hazard: 1.2,
};

/** Small seeded PRNG so textures and props look the same for everyone. */
export function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const S = 512;
const grey = (v: number, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

type Paint = (ctx: CanvasRenderingContext2D, rand: () => number) => void;

/** Fills the rectangle and its wrapped copies, so shapes crossing an edge reappear on the other side. */
function wrapRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  for (const ox of [0, -S, S]) for (const oy of [0, -S, S]) if (x + ox < S && x + ox + w > 0 && y + oy < S && y + oy + h > 0) ctx.fillRect(x + ox, y + oy, w, h);
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function speckle(ctx: CanvasRenderingContext2D, rand: () => number, n: number, alpha: number) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = grey(0, alpha * (0.5 + rand()));
    ctx.beginPath();
    ctx.arc(rand() * S, rand() * S, 1 + rand() * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A grid of `cols` x `rows` plates with seams `seam` px wide, optionally staggered by half a plate per row. */
function plates(ctx: CanvasRenderingContext2D, rand: () => number, cols: number, rows: number, seam: number, seamGrey: number, stagger: boolean, shade = [228, 255]) {
  ctx.fillStyle = grey(seamGrey);
  ctx.fillRect(0, 0, S, S);
  const w = S / cols;
  const h = S / rows;
  for (let r = 0; r < rows; r++) {
    const off = stagger && r % 2 ? w / 2 : 0;
    for (let c = 0; c < cols; c++) {
      const x = c * w + off + seam / 2;
      const y = r * h + seam / 2;
      ctx.fillStyle = grey(shade[0] + rand() * (shade[1] - shade[0]));
      wrapRect(ctx, x, y, w - seam, h - seam);
      // Lit top edge and shaded bottom edge give each plate a printed bevel.
      ctx.fillStyle = grey(255, 0.55);
      wrapRect(ctx, x, y, w - seam, 3);
      ctx.fillStyle = grey(0, 0.07);
      wrapRect(ctx, x, y + h - seam - 4, w - seam, 4);
    }
  }
}

const PAINT: Record<TexKey, Paint> = {
  tiles: (ctx, rand) => {
    // Two big tiles per repeat, thin grout at 150 grey: the floor colour roughly halved, never black.
    plates(ctx, rand, 2, 2, 3, 150, false, [238, 255]);
    speckle(ctx, rand, 240, 0.05);
    ctx.strokeStyle = grey(0, 0.05);
    ctx.lineWidth = 2;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) ctx.strokeRect(i * 256 + 26, j * 256 + 26, 204, 204);
  },
  turf: (ctx, rand) => {
    ctx.fillStyle = grey(255);
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = grey(0, 0.035);
      ctx.beginPath();
      ctx.ellipse(rand() * S, rand() * S, 30 + rand() * 60, 20 + rand() * 40, rand() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = grey(0, 0.16);
    ctx.lineWidth = 2;
    for (let i = 0; i < 180; i++) {
      const x = rand() * S;
      const y = rand() * S;
      line(ctx, x - 4, y + 3, x, y - 4);
      line(ctx, x, y - 4, x + 4, y + 3);
    }
  },
  bricks: (ctx, rand) => plates(ctx, rand, 2, 4, 7, 168, true, [225, 255]),
  stone: (ctx, rand) => {
    ctx.fillStyle = grey(160);
    ctx.fillRect(0, 0, S, S);
    const rows = 3;
    const h = S / rows;
    for (let r = 0; r < rows; r++) {
      let x = rand() * S;
      const end = x + S;
      while (x < end - 40) {
        const w = Math.min(end - x, 110 + rand() * 120);
        ctx.fillStyle = grey(218 + rand() * 37);
        wrapRect(ctx, x + 3, r * h + 3, w - 6, h - 6);
        ctx.fillStyle = grey(255, 0.5);
        wrapRect(ctx, x + 3, r * h + 3, w - 6, 3);
        x += w;
      }
    }
    speckle(ctx, rand, 160, 0.06);
  },
  strata: (ctx, rand) => {
    ctx.fillStyle = grey(255);
    ctx.fillRect(0, 0, S, S);
    const bands = 6;
    const ys: number[] = [];
    for (let b = 0; b < bands; b++) ys.push((b / bands) * S + rand() * 20);
    for (let b = 0; b < bands; b++) {
      const k = 1 + Math.floor(rand() * 3);
      const amp = 6 + rand() * 10;
      const phase = rand() * 6;
      const wave = (x: number, y0: number) => y0 + Math.sin((x / S) * Math.PI * 2 * k + phase) * amp;
      ctx.fillStyle = grey([255, 226, 240, 214, 248, 232][b]);
      ctx.beginPath();
      ctx.moveTo(0, wave(0, ys[b]));
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, wave(x, ys[b]));
      ctx.lineTo(S, ys[b] + S / bands + 30);
      ctx.lineTo(0, ys[b] + S / bands + 30);
      ctx.fill();
      ctx.strokeStyle = grey(165);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, wave(x, ys[b]));
      ctx.stroke();
    }
    speckle(ctx, rand, 120, 0.05);
  },
  metal: (ctx, rand) => {
    plates(ctx, rand, 2, 2, 4, 140, false, [232, 250]);
    // Rivets in the plate corners and a faint diamond tread.
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (const [dx, dy] of [[18, 18], [238, 18], [18, 238], [238, 238]]) {
          ctx.fillStyle = grey(130);
          ctx.beginPath();
          ctx.arc(i * 256 + dx, j * 256 + dy, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = grey(255);
          ctx.fillRect(i * 256 + dx - 2, j * 256 + dy - 3, 2, 2);
        }
      }
    }
    ctx.strokeStyle = grey(0, 0.06);
    ctx.lineWidth = 3;
    for (let y = 16; y < S; y += 32) for (let x = 16; x < S; x += 32) line(ctx, x - 6, y + ((x / 32) % 2 ? 6 : -6), x + 6, y + ((x / 32) % 2 ? -6 : 6));
  },
  ribs: (ctx) => {
    const ribs = 4;
    const w = S / ribs;
    for (let i = 0; i < ribs; i++) {
      const g = ctx.createLinearGradient(i * w, 0, (i + 1) * w, 0);
      g.addColorStop(0, grey(200));
      g.addColorStop(0.35, grey(255));
      g.addColorStop(1, grey(190));
      ctx.fillStyle = g;
      ctx.fillRect(i * w, 0, w, S);
    }
  },
  panels: (ctx, rand) => {
    plates(ctx, rand, 2, 3, 4, 150, true, [230, 255]);
    speckle(ctx, rand, 90, 0.04);
  },
  windows: (ctx, rand) => {
    plates(ctx, rand, 1, 2, 4, 160, false, [240, 255]);
    const cols = 4;
    const rows = 4;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const x = c * (S / cols) + 22;
        const y = r * (S / rows) + 26;
        const w = S / cols - 44;
        const h = S / rows - 52;
        const lit = rand() < 0.3;
        ctx.fillStyle = grey(lit ? 250 : 95);
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = grey(lit ? 255 : 150, 0.6);
        ctx.beginPath();
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + w * 0.45, y);
        ctx.lineTo(x + w * 0.7, y);
        ctx.lineTo(x + w * 0.25, y + h);
        ctx.fill();
        ctx.fillStyle = grey(200);
        ctx.fillRect(x - 6, y + h, w + 12, 7);
      }
    }
  },
  planks: (ctx, rand) => {
    const boards = 5;
    const h = S / boards;
    ctx.fillStyle = grey(140);
    ctx.fillRect(0, 0, S, S);
    for (let b = 0; b < boards; b++) {
      const split = rand() * S;
      for (const [x, w] of [[split, S * 0.6], [split + S * 0.6, S * 0.4]] as const) {
        ctx.fillStyle = grey(222 + rand() * 33);
        wrapRect(ctx, x + 3, b * h + 3, w - 6, h - 6);
        ctx.fillStyle = grey(110);
        wrapRect(ctx, x + 12, b * h + h / 2 - 3, 6, 6);
      }
      ctx.strokeStyle = grey(0, 0.08);
      ctx.lineWidth = 2;
      for (let g = 0; g < 3; g++) {
        const y = b * h + 14 + g * (h / 3.5);
        ctx.beginPath();
        for (let x = 0; x <= S; x += 32) ctx.lineTo(x, y + Math.sin((x / S) * Math.PI * 4 + b + g) * 3);
        ctx.stroke();
      }
    }
  },
  crate: (ctx) => {
    ctx.fillStyle = grey(235);
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = grey(0, 0.08);
    ctx.lineWidth = 3;
    for (let y = 100; y < S; y += 104) line(ctx, 0, y, S, y);
    ctx.fillStyle = grey(200);
    const f = 52;
    ctx.fillRect(0, 0, S, f);
    ctx.fillRect(0, S - f, S, f);
    ctx.fillRect(0, 0, f, S);
    ctx.fillRect(S - f, 0, f, S);
    ctx.strokeStyle = grey(200);
    ctx.lineWidth = 48;
    line(ctx, f, f, S - f, S - f);
    ctx.strokeStyle = grey(120);
    ctx.lineWidth = 5;
    ctx.strokeRect(f, f, S - 2 * f, S - 2 * f);
    ctx.strokeRect(2.5, 2.5, S - 5, S - 5);
  },
  hazard: (ctx) => {
    ctx.fillStyle = '#ffd23a';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#16121c';
    // Four diagonal stripes per repeat; drawing past both edges keeps them seamless.
    for (let i = -4; i < 8; i++) {
      const x = (i * S) / 4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + S / 8, 0);
      ctx.lineTo(x + S / 8 + S, S);
      ctx.lineTo(x + S, S);
      ctx.fill();
    }
  },
};

/** Paints texture `key`; the seed varies the jitter per map. */
export function arenaTexture(key: TexKey, seed: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  PAINT[key](ctx, mulberry(seed * 31 + key.length * 977 + key.charCodeAt(0)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 16;
  return tex;
}
