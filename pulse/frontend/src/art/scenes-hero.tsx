// Rich placeholder scenes for the four dashboard heroes and the two page banners (1600 wide).
import type { ReactNode } from 'react';
import { Bg, Books, Candle, Cloud, f, G, Glow, Grad, Hills, Kettle, Lamp, m, Moon, Mug, NIGHT, Notebook, Pen, Plant, Rain, Sill, st, Stars, Sun, Tree, Win } from './motifs';

export type Scene = (w: number, h: number, k: string) => ReactNode;

const wood = m('accent', 52, 'bg-2');

export const heroMorning: Scene = (W, H, k) => (
  <>
    <defs>
      <Grad id={`${k}s`} a={m('rose', 40, 'bg-2')} b={m('gold', 55, 'bg-2')} />
      <Grad id={`${k}w`} a={m('accent', 14, 'bg-2')} b={m('accent', 22, 'bg-2')} />
    </defs>
    <Bg id={`${k}w`} w={W} h={H} />
    <rect x="500" y="50" width="760" height="400" {...f(`url(#${k}s)`)} />
    <Sun x={960} y={340} r={58} c={m('gold', 90, 'card')} />
    <Hills w={W} h={450} y={300} gap={36} layers={[[m('blue', 40, 'bg-2'), 30], [m('blue', 55, 'bg-2'), 26], [m('green', 55, 'bg-2'), 24], [m('green', 75, 'bg-2'), 20]]} />
    <ellipse cx="760" cy="350" rx="260" ry="22" {...f(m('card', 80), { opacity: 0.45 })} />
    <ellipse cx="1100" cy="388" rx="220" ry="18" {...f(m('card', 80), { opacity: 0.4 })} />
    <Win W={W} H={H} x={500} y={50} w={760} h={400} wall={`url(#${k}w)`} frame={m('accent', 45, 'bg-2')} />
    <Sill x={470} y={448} w={820} c={wood} />
    <Kettle x={700} y={448} s={1.1} anim />
    <Mug x={880} y={448} s={1.1} c={m('rose', 65)} />
    <Plant x={1120} y={448} s={1.2} />
    <Plant x={250} y={600} s={1.7} leaf={m('green', 80)} />
    <rect x="1370" y="110" width="130" height="170" rx="10" {...f(m('card', 80))} />
    <rect x="1384" y="124" width="102" height="142" rx="6" {...f(m('green', 30, 'bg-2'))} />
  </>
);

export const heroDay: Scene = (W, H, k) => (
  <>
    <defs>
      <Grad id={`${k}s`} a={m('blue', 45, 'bg-2')} b={m('blue', 18, 'bg-2')} />
      <Grad id={`${k}w`} a={m('gold', 18, 'bg-2')} b={m('accent', 14, 'bg-2')} />
    </defs>
    <Bg id={`${k}w`} w={W} h={H} />
    <rect x="260" y="40" width="780" height="400" {...f(`url(#${k}s)`)} />
    <Sun x={900} y={130} r={44} c={m('gold', 90, 'card')} />
    <Cloud x={420} y={140} s={1.5} c={m('card', 100)} />
    <Cloud x={720} y={210} s={1} c={m('card', 100)} />
    <Hills w={W} h={440} y={290} gap={34} layers={[[m('green', 40, 'bg-2'), 28], [m('green', 58, 'bg-2'), 24], [m('green', 75, 'bg-2'), 20]]} />
    <Tree x={560} y={400} s={0.9} />
    <Win W={W} H={H} x={260} y={40} w={780} h={400} wall={`url(#${k}w)`} frame={m('accent', 45, 'bg-2')} />
    <rect x="0" y="470" width={W} height="130" {...f(wood)} />
    <rect x="0" y="470" width={W} height="10" {...f('#fff', { opacity: 0.18 })} />
    <Notebook x={560} y={500} s={1.3} open />
    <Pen x={720} y={490} r={-14} />
    <Mug x={860} y={474} s={1.2} />
    <Plant x={1130} y={474} s={1.5} />
    <Plant x={140} y={474} s={1.2} leaf={m('green', 70)} pot={m('rose', 60)} />
    <Books x={1330} y={474} s={1.2} />
    <G x={1330} y={330} s={1}>
      <circle r="52" {...f(m('card', 100), { stroke: m('accent', 55), strokeWidth: 6 })} />
      <path d="M0 -34V0L22 14" {...st(m('ink', 70, 'bg-2'), 5)} />
    </G>
  </>
);

export const heroEvening: Scene = (W, H, k) => (
  <>
    <defs>
      <Grad id={`${k}s`} a={m('rose', 55, 'bg-2')} b={m('gold', 70, 'bg-2')} />
      <Grad id={`${k}w`} a={m('accent', 22, 'bg-2')} b={m('accent', 32, 'bg-2')} />
      <Glow id={`${k}g`} c="#ffc766" />
    </defs>
    <Bg id={`${k}w`} w={W} h={H} />
    <rect x="360" y="50" width="760" height="400" {...f(`url(#${k}s)`)} />
    <Sun x={780} y={330} r={70} c="#ffe0a0" />
    <Cloud x={520} y={150} s={1.4} c="#ffd7b8" o={0.7} />
    <Cloud x={980} y={200} s={1} c="#ffc4a8" o={0.6} />
    {[[360, 380, 120, 70], [470, 350, 90, 100], [560, 392, 150, 60], [700, 365, 100, 85], [800, 390, 130, 60], [920, 345, 90, 105], [1010, 380, 130, 70]].map(([x, y, w, h], i) => (
      <g key={i}>
        <rect x={x} y={y} width={w} height={h + 60} {...f(i % 2 ? '#6a3f48' : '#58364a')} />
        <path d={`M${x - 8} ${y}L${x + w / 2} ${y - 36}L${x + w + 8} ${y}Z`} {...f(i % 2 ? '#7a4650' : '#4b2f41')} />
        <rect x={x + 18} y={y + 22} width="14" height="18" rx="3" {...f('#ffd98a')} />
        {w > 100 && <rect x={x + w - 34} y={y + 40} width="14" height="18" rx="3" {...f('#ffd98a', { opacity: 0.8 })} />}
      </g>
    ))}
    <Win W={W} H={H} x={360} y={50} w={760} h={400} wall={`url(#${k}w)`} frame={m('accent', 50, 'bg-2')} />
    <Sill x={330} y={448} w={820} c={wood} />
    <circle cx="1230" cy="380" r="200" fill={`url(#${k}g)`} />
    <Lamp x={1230} y={448} s={1.1} id={`${k}g`} />
    <Plant x={500} y={448} s={1.2} />
    <Mug x={720} y={448} s={1.1} c={m('gold', 70)} />
    <Notebook x={1440} y={600} s={1.4} r={-6} />
    <Plant x={160} y={600} s={1.8} />
  </>
);

export const heroNight: Scene = (W, H, k) => (
  <>
    <defs>
      <Grad id={`${k}s`} a={NIGHT[0]} b={NIGHT[1]} />
      <Grad id={`${k}w`} a="#3a2b33" b="#4a3535" />
      <Glow id={`${k}g`} c="#ffbf5e" />
    </defs>
    <Bg id={`${k}w`} w={W} h={H} />
    <rect x="300" y="40" width="780" height="400" {...f(`url(#${k}s)`)} />
    <Stars w={W} h={300} n={30} />
    <Moon x={900} y={140} r={36} />
    {[[330, 330, 60], [420, 300, 80], [520, 340, 50], [640, 310, 90], [760, 345, 70], [880, 320, 80], [990, 340, 60]].map(([x, y, w], i) => (
      <g key={i}>
        <rect x={x} y={y} width={w} height="140" {...f(i % 2 ? '#262e52' : '#2d3560')} />
        <rect x={x + 10} y={y + 20} width="9" height="12" rx="2" {...f('#ffd98a', { opacity: 0.8 })} />
        <rect x={x + 26} y={y + 50} width="9" height="12" rx="2" {...f('#ffd98a', { opacity: i % 3 ? 0.25 : 0.8 })} />
      </g>
    ))}
    <Rain w={W} h={H} n={90} o={0.28} />
    <Win W={W} H={H} x={300} y={40} w={780} h={400} wall={`url(#${k}w)`} frame="#6a4e48" />
    <rect x="0" y="470" width={W} height="130" {...f('#5a4038')} />
    <circle cx="1220" cy="360" r="260" fill={`url(#${k}g)`} />
    <Lamp x={1220} y={474} s={1.25} id={`${k}g`} />
    <Notebook x={640} y={510} s={1.5} open />
    <Mug x={860} y={474} s={1.2} c="#7d9cc4" />
    <Plant x={1420} y={474} s={1.3} />
    <Plant x={150} y={474} s={1.3} leaf="#6f9a6a" />
  </>
);

export const bannerBoard: Scene = (W, H, k) => (
  <>
    <defs>
      <Grad id={`${k}b`} a={m('gold', 22, 'bg-2')} b={m('accent', 24, 'bg-2')} />
    </defs>
    <Bg id={`${k}b`} w={W} h={H} />
    <path d="M0 120H1600M0 280H1600" {...st(m('ink', 10, 'bg-2'), 3, { opacity: 0.5 })} />
    {[
      [120, 60, -4, 'accent'], [380, 90, 3, 'green'], [620, 50, -2, 'blue'], [870, 100, 4, 'rose'], [1110, 60, -3, 'gold'], [1350, 90, 2, 'accent'],
      [250, 230, 3, 'blue'], [740, 240, -3, 'gold'], [1230, 230, 4, 'green'],
    ].map(([x, y, r, c], i) => (
      <G key={i} x={x as number} y={y as number} r={r as number}>
        <rect width="190" height={i > 5 ? 120 : 140} rx="10" {...f(m(c as string, 38))} />
        <path d="M20 40H150M20 62H170M20 84H120" {...st(m(c as string, 80, 'card'), 5, { opacity: 0.55 })} />
        <rect x="52" y="-12" width="86" height="26" rx="4" transform="rotate(-2)" {...f(m(['gold', 'rose', 'blue', 'green'][i % 4], 70), { opacity: 0.8 })} />
      </G>
    ))}
    {[[215, 62], [475, 92], [715, 52], [965, 102], [1205, 62], [1445, 92]].map(([x, y], i) => (
      <circle key={i} cx={x} cy={y} r="7" {...f(m('rose', 90, 'ink'))} />
    ))}
  </>
);

export const bannerNotes: Scene = (W, H, k) => (
  <>
    <defs>
      <Grad id={`${k}b`} a={m('blue', 20, 'bg-2')} b={m('accent', 22, 'bg-2')} />
      <Glow id={`${k}c`} c="#ffc766" />
    </defs>
    <Bg id={`${k}b`} w={W} h={H} />
    <rect x="0" y="320" width={W} height="80" {...f(wood)} />
    <Hills w={W} h={320} y={200} gap={34} layers={[[m('blue', 25, 'bg-2'), 24], [m('green', 28, 'bg-2'), 20]]} />
    <rect x="0" y="320" width={W} height="80" {...f(wood)} />
    <Books x={420} y={322} s={2} />
    <Books x={640} y={322} s={1.5} />
    <Notebook x={900} y={330} s={1.5} open />
    <Pen x={1060} y={308} r={-20} />
    <Candle x={1230} y={322} s={1.9} id={`${k}c`} />
    <Plant x={1420} y={322} s={1.6} />
    <Plant x={160} y={322} s={1.4} />
  </>
);
