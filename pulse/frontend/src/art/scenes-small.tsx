// Placeholder scenes for columns, empty states and dashboard cards.
import { Bg, Books, Cloud, Cup, f, G, Grad, Hills, Leaf, m, Notebook, Pen, Plant, Rain, Sill, st, Sun, Tree } from './motifs';
import type { Scene } from './scenes-hero';

const wood = m('accent', 52, 'bg-2');
const tint = (k: string, a: string, b: string) => <defs><Grad id={`${k}b`} a={a} b={b} /></defs>;

const Table = ({ y, W, H }: { y: number; W: number; H: number }) => (
  <>
    <rect x="0" y={y} width={W} height={H - y} {...f(wood)} />
    <rect x="0" y={y} width={W} height="8" {...f('#fff', { opacity: 0.2 })} />
  </>
);

export const Hedgehog = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <G x={x} y={y} s={s}>
    <ellipse cx="0" cy="-2" rx="60" ry="7" {...f(m('ink', 20, 'bg-2'), { opacity: 0.35 })} />
    <path d="M-52 -6Q-60 -70 -10 -78Q50 -80 56 -6Z" {...f(m('accent', 35, 'ink'))} />
    {Array.from({ length: 11 }, (_, i) => (
      <path key={i} d={`M${-46 + i * 9} ${-24 - Math.sin((i / 10) * Math.PI) * 38}l${-5 + i * 0.5} -12`} {...st(m('accent', 25, 'ink'), 3.5)} />
    ))}
    <path d="M24 -8Q18 -44 62 -34Q84 -26 86 -8Z" {...f(m('gold', 55, 'card'))} />
    <circle cx="86" cy="-14" r="4.5" {...f(m('ink', 90, 'ink'))} />
    <circle cx="58" cy="-26" r="3.4" {...f('#2c211b')} />
    <ellipse cx="40" cy="-34" rx="7" ry="9" {...f(m('gold', 55, 'card'))} />
  </G>
);

export const Capybara = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <G x={x} y={y} s={s}>
    <path d="M-70 0Q-80 -60 -20 -70Q40 -76 70 -40L96 -36Q106 -20 94 -10Q60 -4 60 0Z" {...f(m('accent', 45, 'ink'))} />
    <circle cx="-4" cy="-84" r="0" />
    <ellipse cx="52" cy="-62" rx="9" ry="7" {...f(m('accent', 45, 'ink'))} />
    <circle cx="68" cy="-50" r="3.4" {...f('#2c211b')} />
    <ellipse cx="96" cy="-24" rx="5" ry="4" {...f('#2c211b')} />
    <circle cx="30" cy="-84" r="16" {...f(m('gold', 90))} />
    <path d="M30 -100q4 -8 10 -8" {...st(m('green', 80), 3)} />
  </G>
);

export const Bear = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <G x={x} y={y} s={s}>
    <ellipse cx="0" cy="0" rx="62" ry="30" {...f(m('accent', 40, 'ink'))} />
    <circle cx="-66" cy="-8" r="26" {...f(m('accent', 40, 'ink'))} />
    <circle cx="-82" cy="-32" r="9" {...f(m('accent', 40, 'ink'))} />
    <circle cx="-52" cy="-32" r="9" {...f(m('accent', 40, 'ink'))} />
    <ellipse cx="-76" cy="-2" rx="12" ry="9" {...f(m('gold', 50, 'card'))} />
    <path d="M-80 -14q4 4 8 0M-64 -14q4 4 8 0" {...st('#2c211b', 2.5)} />
    <circle cx="-78" cy="-5" r="3" {...f('#2c211b')} />
    <ellipse cx="40" cy="18" rx="22" ry="12" {...f(m('accent', 35, 'ink'))} />
  </G>
);

export const Robin = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <G x={x} y={y} s={s}>
    <path d="M26 -30L56 -20L30 -12Z" {...f(m('ink', 60, 'bg-2'))} />
    <path d="M-2 -6V10M12 -6V10" {...st(m('ink', 55, 'bg-2'), 3)} />
    <ellipse cx="0" cy="-34" rx="34" ry="30" {...f(m('accent', 40, 'ink'))} />
    <path d="M-6 -52Q30 -66 30 -34Q26 -4 0 -4Q-30 -10 -22 -40Z" {...f(m('accent', 90))} />
    <circle cx="20" cy="-48" r="4" {...f('#2c211b')} />
    <path d="M-34 -30Q-52 -22 -44 -6" {...st(m('accent', 40, 'ink'), 10)} />
  </G>
);

export const columnTodo: Scene = (W, H, k) => (
  <>
    {tint(k, m('green', 26, 'bg-2'), m('gold', 22, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Table y={238} W={W} H={H} />
    <G x={190} y={250} r={-6}>
      <rect x="-48" y="-150" width="96" height="150" rx="8" {...f(m('card', 100))} />
      <rect x="-40" y="-142" width="80" height="134" rx="5" {...f(m('green', 40))} />
      <ellipse cx="0" cy="-86" rx="30" ry="32" {...f(m('card', 100))} />
      <path d="M0 -70V-98M0 -86Q-14 -90 -16 -102M0 -92Q12 -96 14 -108" {...st(m('green', 90, 'ink'), 3.5)} />
      <path d="M-24 -30H24" {...st(m('card', 90), 4)} />
    </G>
    <G x={400} y={248}>
      <path d="M42 -48L84 -90" {...st(m('blue', 70), 12)} />
      <path d="M-40 -90Q-14 -130 42 -90" {...st(m('blue', 55), 8)} />
      <path d="M-46 -90H44L36 0H-38Z" {...f(m('blue', 72))} />
      <ellipse cx="-2" cy="-90" rx="46" ry="8" {...f(m('blue', 50, 'ink'))} />
      <path d="M84 -90l16 6M86 -80l14 12M90 -72l10 18" {...st(m('blue', 50), 3)} />
      <circle cx="108" cy="-52" r="4" {...f(m('blue', 60), { opacity: 0.7 })} />
      <circle cx="112" cy="-30" r="4" {...f(m('blue', 60), { opacity: 0.6 })} />
    </G>
  </>
);

export const columnDoing: Scene = (W, H, k) => (
  <>
    {tint(k, m('blue', 30, 'bg-2'), m('gold', 30, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Sun x={480} y={70} r={26} c={m('gold', 90)} />
    <Cloud x={130} y={70} s={0.9} />
    <path d={`M0 ${H}V240Q150 200 300 232T${W} 224V${H}Z`} {...f(m('accent', 36, 'ink'))} />
    <path d={`M0 ${H}V270Q150 240 300 262T${W} 256V${H}Z`} {...f(m('accent', 28, 'ink'))} />
    <path d="M300 238V130" {...st(m('green', 80), 7)} />
    <path d="M300 160Q250 150 240 110Q290 104 300 160Z" {...f(m('green', 75))} />
    <path d="M300 140Q350 128 362 86Q310 84 300 140Z" {...f(m('green', 88))} />
    <circle cx="150" cy="262" r="5" {...f(m('accent', 20, 'ink'))} />
    <circle cx="430" cy="270" r="6" {...f(m('accent', 20, 'ink'))} />
  </>
);

export const columnDone: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 30, 'bg-2'), m('rose', 22, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Table y={232} W={W} H={H} />
    <G x={300} y={246}>
      <circle cx="-44" cy="-56" r="30" {...f(m('rose', 88))} />
      <circle cx="12" cy="-70" r="30" {...f(m('accent', 90))} />
      <path d="M50 -40Q40 -92 78 -88Q98 -72 78 -40Z" {...f(m('green', 72))} />
      <circle cx="-8" cy="-48" r="26" {...f(m('gold', 90))} />
      <path d="M-44 -86q4 -10 10 -12M12 -100q-2 -10 6 -14" {...st(m('green', 90, 'ink'), 3)} />
      <path d="M-100 -40H100Q94 4 0 4T-100 -40Z" {...f(m('blue', 62))} />
      <path d="M-86 -28Q0 -18 86 -28" {...st('#fff', 3, { opacity: 0.3 })} />
    </G>
  </>
);

export const emptyBoard: Scene = (W, H, k) => (
  <>
    {tint(k, m('accent', 14, 'bg-2'), m('gold', 18, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <rect x="260" y="110" width="150" height="110" rx="8" {...f(m('card', 90))} />
    <rect x="272" y="122" width="126" height="86" rx="4" {...f(m('blue', 22, 'bg-2'))} />
    <rect x="130" y="392" width="540" height="22" rx="8" {...f(wood)} />
    <path d="M190 414V470M610 414V470" {...st(wood, 10)} />
    <Plant x={400} y={392} s={1.8} />
    <Cup x={250} y={392} s={1} />
    <Books x={560} y={392} s={0.8} />
  </>
);

export const emptyColumn: Scene = (W, H, k) => (
  <>
    {tint(k, m('green', 20, 'bg-2'), m('gold', 20, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <path d={`M40 330Q300 300 560 330L580 372Q300 400 20 372Z`} {...f(m('blue', 32))} />
    <path d="M60 346Q300 322 540 346" {...st('#fff', 3, { opacity: 0.35 })} />
    <Hedgehog x={290} y={330} s={1.5} />
    <ellipse cx="150" cy="336" rx="16" ry="9" {...f(m('ink', 40, 'bg-2'))} />
    <G x={470} y={332} r={-20}><path d="M-34 0Q0 -14 34 0Q0 8 -34 0Z" {...f(m('card', 100))} /></G>
  </>
);

export const emptyNotes: Scene = (W, H, k) => (
  <>
    {tint(k, m('blue', 18, 'bg-2'), m('accent', 20, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Table y={380} W={W} H={H} />
    <Notebook x={360} y={470} s={2.1} open />
    <Pen x={500} y={470} r={-18} s={1.3} />
    <Cup x={600} y={430} s={1.5} steam />
    <Plant x={140} y={400} s={1.5} />
  </>
);

export const emptyToday: Scene = (W, H, k) => (
  <>
    {tint(k, m('blue', 36, 'bg-2'), m('gold', 26, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Sun x={640} y={110} r={36} c={m('gold', 90)} />
    <Cloud x={200} y={110} s={1.3} />
    <Hills w={W} h={H} y={380} gap={40} layers={[[m('green', 50, 'bg-2'), 26], [m('green', 72, 'bg-2'), 22]]} />
    <Tree x={140} y={470} s={2.4} />
    <Tree x={660} y={470} s={2.4} />
    <path d="M200 320Q400 470 600 320" {...st(m('rose', 60), 10)} />
    <path d="M200 320Q400 460 600 320" {...st(m('rose', 80), 4, { opacity: 0.6 })} />
    <Bear x={420} y={400} s={1.1} />
    <G x={470} y={250}><text style={{ fill: m('ink', 50, 'bg-2'), font: '700 30px serif' }}>z</text></G>
  </>
);

export const emptySearch: Scene = (W, H, k) => (
  <>
    {tint(k, m('blue', 22, 'bg-2'), m('green', 24, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <path d="M60 140Q120 120 180 140" {...st('#fff', 6, { opacity: 0.5 })} />
    <Capybara x={380} y={410} s={2} />
    <path d="M150 330Q150 520 400 520T650 330Z" {...f(m('card', 92))} />
    <path d="M170 360Q400 330 630 360Q600 470 400 480T170 360Z" {...f(m('blue', 55), { opacity: 0.85 })} />
    <path d="M230 392Q400 372 570 392" {...st('#fff', 4, { opacity: 0.4 })} />
    <circle cx="200" cy="320" r="14" {...f('#fff', { opacity: 0.6 })} />
    <circle cx="610" cy="290" r="10" {...f('#fff', { opacity: 0.5 })} />
    <circle cx="640" cy="236" r="16" {...f('#fff', { opacity: 0.4 })} />
  </>
);

export const cardToday: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 38, 'bg-2'), m('blue', 24, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Sun x={480} y={90} r={40} c={m('gold', 90)} />
    <Hills w={W} h={H} y={250} gap={26} layers={[[m('green', 40, 'bg-2'), 18], [m('green', 62, 'bg-2'), 14]]} />
    <Sill x={30} y={310} w={540} c={wood} />
    <Robin x={200} y={310} s={1.4} />
    <G x={420} y={226}>
      <circle r="62" {...f(m('card', 100), { stroke: m('accent', 55), strokeWidth: 7 })} />
      <path d="M0 -42V0L26 16" {...st(m('ink', 70, 'bg-2'), 6)} />
    </G>
    <Plant x={520} y={310} s={0.9} />
  </>
);

export const cardOverdue: Scene = (W, H, k) => (
  <>
    {tint(k, m('blue', 30, 'bg-2'), m('accent', 22, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <rect x="0" y="40" width={W} height="260" {...f(m('accent', 28, 'ink'), { opacity: 0.35 })} />
    <path d={`M0 300H${W}`} {...st(m('ink', 30, 'bg-2'), 3)} />
    <rect x="0" y="300" width={W} height="100" {...f(m('ink', 18, 'bg-2'))} />
    <ellipse cx="180" cy="350" rx="110" ry="12" {...f(m('blue', 50), { opacity: 0.5 })} />
    <G x={330} y={300}>
      <circle cx="-72" cy="-40" r="44" {...st(m('ink', 70, 'bg-2'), 7)} />
      <circle cx="82" cy="-40" r="44" {...st(m('ink', 70, 'bg-2'), 7)} />
      <path d="M-72 -40L-20 -96L30 -96L82 -40M-20 -96L-4 -40H-72M-4 -40L30 -96" {...st(m('accent', 80), 7)} />
      <path d="M20 -108H52M-28 -104L-20 -96" {...st(m('ink', 70, 'bg-2'), 7)} />
    </G>
    <Leaf x={80} y={90} r={30} c={m('accent', 80)} />
    <Leaf x={500} y={140} r={-20} c={m('gold', 85)} />
    <Rain w={W} h={H} n={50} o={0.5} c={m('blue', 70)} />
  </>
);

export const cardUpcoming: Scene = (W, H, k) => (
  <>
    {tint(k, m('blue', 36, 'bg-2'), m('rose', 22, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Sun x={420} y={140} r={30} c={m('gold', 90)} />
    <Hills w={W} h={H} y={190} gap={50} layers={[[m('blue', 45, 'bg-2'), 20], [m('green', 50, 'bg-2'), 26], [m('green', 72, 'bg-2'), 22]]} />
    <path d="M250 400Q150 350 300 310Q430 280 330 250Q290 236 340 224L352 224Q310 240 360 260Q470 296 340 322Q210 354 320 400Z" {...f(m('gold', 70, 'bg-2'))} />
    <Tree x={110} y={330} s={0.9} />
    <Tree x={500} y={310} s={0.7} />
  </>
);

export const cardNotes: Scene = (W, H, k) => (
  <>
    {tint(k, m('accent', 20, 'bg-2'), m('gold', 22, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Table y={330} W={W} H={H} />
    <Notebook x={300} y={380} s={2.8} open />
    <G x={380} y={250}>
      <path d="M0 0V50" {...st(m('green', 80), 3)} />
      {[0, 72, 144, 216, 288].map((a) => (
        <ellipse key={a} cx="0" cy="-12" rx="7" ry="14" transform={`rotate(${a})`} {...f(m('rose', 80))} />
      ))}
      <circle r="5" {...f(m('gold', 90))} />
    </G>
    <Leaf x={190} y={250} r={-30} s={1.4} c={m('green', 80)} />
    <Pen x={500} y={360} r={-12} />
  </>
);

