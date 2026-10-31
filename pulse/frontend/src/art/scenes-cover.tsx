// Placeholder scenes for note covers, loading, 404, login and the app icon.
import { Bg, Books, Cloud, Cup, f, Flower, G, Glow, Grad, Hills, Kettle, Lamp, Leaf, m, Moon, NIGHT, Notebook, Pine, Plant, Rain, Stars, st, Sun, Tree, rnd } from './motifs';
import type { Scene } from './scenes-hero';

const wood = m('accent', 52, 'bg-2');
const tint = (k: string, a: string, b: string) => <defs><Grad id={`${k}b`} a={a} b={b} /></defs>;

export const coverRainWindow: Scene = (W, H, k) => (
  <>
    <defs><Grad id={`${k}b`} a={NIGHT[0]} b="#4a4470" /><Glow id={`${k}g`} c="#ffbf5e" /></defs>
    <Bg id={`${k}b`} w={W} h={H} />
    {Array.from({ length: 26 }, (_, i) => (
      <circle key={i} cx={rnd(i) * W} cy={160 + rnd(i + 40) * 400} r={14 + rnd(i + 9) * 34} {...f(['#ffbf5e', '#ff9d7a', '#9cc3ff', '#ffe08a'][i % 4], { opacity: 0.22 + rnd(i + 3) * 0.3 })} />
    ))}
    <Rain w={W} h={H} n={110} o={0.3} />
    <path d="M0 640H1200" {...st('#6a4e48', 0)} />
    <rect x="0" y="650" width={W} height="150" {...f('#5a4038')} />
    <circle cx="930" cy="560" r="300" fill={`url(#${k}g)`} />
    <Lamp x={930} y={660} s={1.5} id={`${k}g`} />
    <Cup x={400} y={660} s={1.6} c="#c9606f" steam />
    {[[260, 300, 30], [560, 250, 40], [760, 420, 24], [1010, 280, 34]].map(([x, y, r], i) => (
      <path key={i} d={`M${x} ${y}q${r} ${r * 2} 0 ${r * 3}`} {...st('#dbe8ff', 3, { opacity: 0.45 })} />
    ))}
  </>
);

export const coverTea: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 24, 'bg-2'), m('accent', 24, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <rect x="0" y="520" width={W} height="280" {...f(wood)} />
    <rect x="170" y="560" width="860" height="70" rx="30" {...f(m('green', 55, 'ink'))} />
    <G x={560} y={570}>
      <g {...st(m('ink', 25, 'bg-2'), 6)}><path className="steam" d="M-10 -250c-20 -20 20 -38 0 -70" /><path className="steam s2" d="M30 -250c-20 -20 20 -38 0 -70" /></g>
      <path d="M130 -130q60 10 40 70q-14 30 -66 22" {...st(m('rose', 62), 16)} />
      <path d="M-120 -160L-190 -230" {...st(m('rose', 62), 24)} />
      <ellipse cx="0" cy="-100" rx="140" ry="110" {...f(m('rose', 62))} />
      <ellipse cx="0" cy="-206" rx="76" ry="22" {...f(m('rose', 50, 'ink'))} />
      <circle cx="0" cy="-232" r="16" {...f(m('rose', 50, 'ink'))} />
      <path d="M-90 -130Q-80 -170 -40 -180" {...st('#fff', 8, { opacity: 0.3 })} />
      <path d="M-100 -90Q0 -60 100 -90" {...st(m('gold', 90), 10)} />
    </G>
    <Cup x={250} y={600} s={2} c={m('blue', 62)} steam />
    <Cup x={880} y={606} s={2} c={m('blue', 62)} steam />
    <Flower x={1060} y={520} s={2} h={60} />
  </>
);

export const coverPlants: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 34, 'bg-2'), m('green', 20, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <path d="M0 0L400 0L100 800H0Z" {...f('#fff', { opacity: 0.12 })} />
    <rect x="60" y="520" width="1080" height="26" rx="10" {...f(wood)} />
    <rect x="60" y="250" width="1080" height="22" rx="10" {...f(wood)} />
    <Plant x={200} y={520} s={2.4} />
    <Plant x={460} y={520} s={1.8} leaf={m('green', 72)} pot={m('blue', 60)} />
    <Plant x={720} y={520} s={2.8} pot={m('rose', 60)} />
    <Plant x={1000} y={520} s={2} leaf={m('green', 90)} />
    <Plant x={300} y={250} s={1.5} pot={m('gold', 70)} />
    <Plant x={700} y={250} s={1.3} leaf={m('green', 70)} />
    <Plant x={960} y={250} s={1.7} pot={m('blue', 55)} />
    <path d="M600 0V120" {...st(m('green', 70), 4)} /><Leaf x={600} y={140} s={3} c={m('green', 80)} />
  </>
);

export const coverBooks: Scene = (W, H, k) => (
  <>
    <defs><Grad id={`${k}b`} a={m('blue', 24, 'bg-2')} b={m('accent', 22, 'bg-2')} /><Glow id={`${k}g`} c="#ffc766" /></defs>
    <Bg id={`${k}b`} w={W} h={H} />
    <rect x="0" y="640" width={W} height="160" {...f(wood)} />
    <Books x={420} y={660} s={4.2} />
    <G x={760} y={660} r={8}><Books x={0} y={0} s={3} /></G>
    <circle cx="990" cy="480" r="260" fill={`url(#${k}g)`} />
    <Lamp x={990} y={660} s={2} id={`${k}g`} />
    <Notebook x={200} y={670} s={1.6} r={-4} />
  </>
);

export const coverMeadow: Scene = (W, H, k) => (
  <>
    {tint(k, m('blue', 42, 'bg-2'), m('blue', 14, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Sun x={940} y={160} r={60} c={m('gold', 90)} />
    <Cloud x={300} y={170} s={2.2} c={m('card', 100)} />
    <Cloud x={700} y={260} s={1.5} c={m('card', 100)} />
    <Hills w={W} h={H} y={400} gap={70} layers={[[m('green', 45, 'bg-2'), 40], [m('green', 62, 'bg-2'), 36], [m('green', 80, 'bg-2'), 30]]} />
    {Array.from({ length: 46 }, (_, i) => (
      <Flower key={i} x={rnd(i) * W} y={560 + rnd(i + 20) * 230} s={1 + rnd(i + 5) * 1.3} h={36 + rnd(i + 8) * 30} c={m(['rose', 'gold', 'accent', 'blue', 'card'][i % 5], 85)} />
    ))}
  </>
);

export const coverAutumn: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 40, 'bg-2'), m('accent', 30, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Sun x={600} y={300} r={70} c={m('gold', 90)} />
    <Hills w={W} h={H} y={380} gap={0} layers={[[m('accent', 50, 'bg-2'), 20]]} />
    <path d={`M470 380H730L1010 800H190Z`} {...f(m('gold', 60, 'bg-2'))} />
    <path d="M520 380L400 800M680 380L800 800" {...st(m('accent', 40, 'bg-2'), 3, { opacity: 0.5 })} />
    {[[150, 700, 3.2], [330, 560, 2.2], [1050, 700, 3.2], [890, 560, 2.2]].map(([x, y, s], i) => (
      <Tree key={i} x={x} y={y} s={s} c={m(['accent', 'gold', 'rose', 'accent'][i], 85)} />
    ))}
    {Array.from({ length: 34 }, (_, i) => (
      <Leaf key={i} x={rnd(i) * W} y={420 + rnd(i + 3) * 380} r={rnd(i + 8) * 360} s={0.8 + rnd(i + 2) * 1.2} c={m(['accent', 'gold', 'rose'][i % 3], 88)} />
    ))}
  </>
);

export const coverSnow: Scene = (W, H, k) => (
  <>
    <defs><Grad id={`${k}b`} a="#2c3358" b="#c98aa0" /><Glow id={`${k}g`} c="#ffc766" /></defs>
    <Bg id={`${k}b`} w={W} h={H} />
    <Stars w={W} h={300} n={26} seed={4} />
    <Moon x={950} y={150} r={40} />
    <Hills w={W} h={H} y={500} gap={50} layers={[['#d8dff0', 24], ['#f2f4fb', 20]]} />
    <G x={600} y={640}>
      <circle cx="0" cy="-60" r="200" fill={`url(#${k}g)`} opacity="0.5" />
      <rect x="-110" y="-120" width="220" height="120" {...f(m('accent', 45, 'ink'))} />
      <path d="M-130 -120L0 -200L130 -120Z" {...f('#6a3f48')} />
      <path d="M-130 -120L0 -200L130 -120L116 -120L0 -186L-116 -120Z" {...f('#f6f8ff')} />
      <rect x="-70" y="-90" width="50" height="50" rx="6" {...f('#ffd98a')} />
      <rect x="30" y="-80" width="40" height="80" rx="6" {...f(m('ink', 50, 'bg-2'))} />
      <rect x="60" y="-220" width="26" height="60" {...f('#6a3f48')} />
    </G>
    <Pine x={300} y={680} s={2.2} snow />
    <Pine x={190} y={700} s={1.6} snow />
    <Pine x={950} y={690} s={2.4} snow />
    {Array.from({ length: 50 }, (_, i) => <circle key={i} cx={rnd(i) * W} cy={rnd(i + 60) * H} r={2 + rnd(i + 1) * 3} {...f('#fff', { opacity: 0.8 })} />)}
  </>
);

export const coverBread: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 24, 'bg-2'), m('accent', 18, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <rect x="0" y="340" width={W} height="460" {...f(m('card', 80, 'bg-2'))} />
    <path d="M0 440H1200M0 560H1200M0 680H1200M200 340V800M520 340V800M860 340V800" {...st(m('blue', 25, 'bg-2'), 3, { opacity: 0.4 })} />
    <G x={500} y={600}>
      <ellipse cx="0" cy="16" rx="290" ry="40" {...f(m('ink', 30, 'bg-2'), { opacity: 0.25 })} />
      <path d="M-270 0Q-290 -150 -100 -190Q100 -230 240 -150Q300 -80 260 0Q0 40 -270 0Z" {...f(m('accent', 62, 'gold'))} />
      <path d="M-180 -40Q-160 -120 -80 -150M-60 -30Q-30 -130 50 -170M80 -20Q110 -100 180 -130" {...st(m('gold', 70), 14)} />
      <path d="M-200 -70Q-100 -170 100 -190" {...st('#fff', 8, { opacity: 0.25 })} />
    </G>
    <G x={930} y={600}>
      <rect x="-70" y="-150" width="140" height="150" rx="26" {...f(m('rose', 62))} />
      <rect x="-76" y="-176" width="152" height="40" rx="14" {...f(m('card', 100))} />
      <rect x="-50" y="-110" width="100" height="60" rx="10" {...f(m('card', 92))} />
    </G>
    <rect x="130" y="600" width="170" height="70" rx="12" {...f(m('gold', 60))} />
    <rect x="130" y="590" width="170" height="26" rx="10" {...f(m('gold', 85))} />
    <Flower x={1100} y={420} s={2} h={60} />
  </>
);

export const coverHills: Scene = (W, H, k) => (
  <>
    {tint(k, m('rose', 42, 'bg-2'), m('gold', 50, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Sun x={600} y={430} r={80} c="#ffe0a0" />
    <Hills w={W} h={H} y={380} gap={80} layers={[[m('blue', 30, 'bg-2'), 40], [m('blue', 45, 'bg-2'), 36], [m('blue', 62, 'bg-2'), 30], [m('green', 55, 'ink'), 26]]} />
    <Tree x={820} y={640} s={2.1} />
    <Cloud x={220} y={170} s={1.8} c="#ffd9c0" o={0.7} />
  </>
);

export const coverShapes: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 24, 'bg-2'), m('rose', 20, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <circle cx="380" cy="400" r="260" {...f(m('accent', 70), { opacity: 0.9 })} />
    <rect x="560" y="140" width="420" height="420" rx="60" transform="rotate(14 770 350)" {...f(m('blue', 60), { opacity: 0.85 })} />
    <path d="M300 800Q600 380 960 800Z" {...f(m('green', 62), { opacity: 0.9 })} />
    <circle cx="920" cy="220" r="90" {...f(m('gold', 85))} />
    <path d="M80 160Q200 60 320 160" {...st(m('rose', 75), 24)} />
    <circle cx="1060" cy="640" r="60" {...f(m('card', 100), { opacity: 0.8 })} />
  </>
);

export const coverFox: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 32, 'bg-2'), m('accent', 30, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <Hills w={W} h={H} y={420} gap={0} layers={[[m('accent', 40, 'bg-2'), 30]]} />
    {Array.from({ length: 40 }, (_, i) => (
      <Leaf key={i} x={rnd(i) * W} y={430 + rnd(i + 3) * 370} r={rnd(i + 8) * 360} s={1 + rnd(i + 2) * 1.4} c={m(['accent', 'gold', 'rose'][i % 3], 85)} />
    ))}
    <G x={600} y={600}>
      <ellipse cx="0" cy="40" rx="300" ry="30" {...f(m('ink', 30, 'bg-2'), { opacity: 0.2 })} />
      <path d="M-260 30Q-290 -150 -60 -170Q200 -190 270 -30Q280 40 150 40Q-80 60 -260 30Z" {...f('#d9703c')} />
      <path d="M150 40Q330 50 330 -40Q320 -90 250 -80Q330 -30 240 10Z" {...f('#d9703c')} />
      <path d="M300 -20Q330 -80 270 -88Q310 -30 270 -8Z" {...f('#fff6e6')} />
      <path d="M-230 30Q-300 20 -280 -60Q-260 -100 -200 -90L-130 -40Z" {...f('#e98a52')} />
      <path d="M-270 -64L-262 -130L-222 -92Z M-196 -92L-170 -146L-150 -80Z" {...f('#d9703c')} />
      <path d="M-240 -10Q-200 20 -150 4" {...st('#fff6e6', 18)} />
      <path d="M-236 -44q14 10 28 0" {...st('#3a2a22', 4)} />
      <circle cx="-285" cy="-20" r="9" {...f('#3a2a22')} />
    </G>
  </>
);

export const coverOwl: Scene = (W, H, k) => (
  <>
    <defs><Grad id={`${k}b`} a={NIGHT[0]} b="#5a4d80" /></defs>
    <Bg id={`${k}b`} w={W} h={H} />
    <Stars w={W} h={H} n={40} seed={9} />
    <path d="M980 120a120 120 0 1 0 90 170a95 95 0 1 1 -90 -170Z" {...f('#f4e6c0')} />
    <path d="M-20 560Q300 520 640 560T1220 540V620Q600 660 -20 630Z" {...f('#4a3a3a')} />
    <G x={560} y={560}>
      <ellipse cx="0" cy="-120" rx="110" ry="140" {...f(m('accent', 40, 'ink'))} />
      <ellipse cx="0" cy="-90" rx="70" ry="90" {...f('#e6cfa8')} />
      <path d="M-100 -230L-110 -290L-50 -246Z M100 -230L110 -290L50 -246Z" {...f(m('accent', 40, 'ink'))} />
      <circle cx="-44" cy="-190" r="34" {...f('#fff2d0')} /><circle cx="44" cy="-190" r="34" {...f('#fff2d0')} />
      <circle cx="-44" cy="-190" r="16" {...f('#2c211b')} /><circle cx="44" cy="-190" r="16" {...f('#2c211b')} />
      <path d="M-12 -170L12 -170L0 -146Z" {...f('#e0a24a')} />
      <path d="M-60 -100q10 10 20 0M-20 -80q10 10 20 0M20 -100q10 10 20 0" {...st('#b99468', 4)} />
      <path d="M-30 0V-14M30 0V-14" {...st('#e0a24a', 8)} />
    </G>
    <path d="M160 640Q110 480 200 420" {...st('#4a3a3a', 14)} />
    <Leaf x={196} y={430} r={30} s={2} c="#6f9a6a" /><Leaf x={150} y={500} r={-40} s={1.6} c="#6f9a6a" />
  </>
);

export const loadingScene: Scene = (W, H, k) => (
  <>
    {tint(k, m('gold', 24, 'bg-2'), m('accent', 20, 'bg-2'))}
    <Bg id={`${k}b`} w={W} h={H} />
    <circle cx="300" cy="320" r="220" {...f(m('card', 80), { opacity: 0.5 })} />
    <rect x="80" y="440" width="440" height="60" rx="20" {...f(m('ink', 55, 'bg-2'))} />
    <path d="M140 440q0 -16 18 -16M240 440q0 -16 18 -16M340 440q0 -16 18 -16" {...st(m('accent', 90), 8)} />
    <Kettle x={300} y={440} s={3.1} anim />
  </>
);

export const notFound: Scene = (W, H, k) => (
  <>
    <defs><Grad id={`${k}b`} a="#39406a" b={m('blue', 30, 'bg-2')} /><Glow id={`${k}g`} c="#ffc766" /></defs>
    <Bg id={`${k}b`} w={W} h={H} />
    <Hills w={W} h={H} y={360} gap={60} layers={[[m('blue', 30, 'bg-2'), 24], [m('blue', 20, 'bg-2'), 20]]} />
    <path d="M300 600Q420 480 380 380Q350 330 430 300" {...st(m('gold', 40, 'bg-2'), 60)} />
    <rect x="520" y="230" width="22" height="330" rx="8" {...f(m('accent', 40, 'ink'))} />
    <path d="M540 270H680L706 296L680 322H540Z" {...f(m('accent', 62))} />
    <path d="M522 350H400L374 376L400 402H522Z" {...f(m('gold', 70))} />
    <G x={300} y={420}>
      <circle cy="-40" r="160" fill={`url(#${k}g)`} />
      <rect x="-14" y="-60" width="28" height="60" rx="8" {...f(m('ink', 60, 'bg-2'))} />
      <rect x="-12" y="-52" width="24" height="40" rx="6" {...f('#ffd98a')} />
      <path d="M-14 -60Q0 -86 14 -60" {...st(m('ink', 60, 'bg-2'), 4)} />
    </G>
    {[[110, 330, 420, 50], [330, 480, 520, 56], [60, 530, 440, 44], [380, 150, 380, 36]].map(([x, y, w, h], i) => (
      <ellipse key={i} cx={x + w / 2} cy={y} rx={w / 2} ry={h / 2} {...f('#eef0ff', { opacity: 0.28 })} />
    ))}
    <Hills w={W} h={H} y={540} gap={0} layers={[[m('ink', 25, 'bg-2'), 14]]} />
  </>
);

export const loginScene: Scene = (W, H, k) => (
  <>
    <defs><Grad id={`${k}b`} a={m('gold', 24, 'bg-2')} b={m('accent', 24, 'bg-2')} /><Glow id={`${k}g`} c="#ffc766" /></defs>
    <Bg id={`${k}b`} w={W} h={H} />
    <path d="M0 640H1200" {...st(m('ink', 12, 'bg-2'), 3)} />
    <rect x="0" y="720" width={W} height="180" {...f(m('ink', 20, 'bg-2'))} />
    <rect x="360" y="130" width="400" height="600" rx="200" ry="200" {...f(m('green', 55, 'ink'))} />
    <rect x="360" y="330" width="400" height="400" {...f(m('green', 55, 'ink'))} />
    <rect x="395" y="165" width="330" height="565" rx="170" {...f(m('green', 70))} />
    <rect x="395" y="330" width="330" height="400" {...f(m('green', 70))} />
    <rect x="440" y="360" width="100" height="150" rx="14" {...f(m('green', 55, 'ink'), { opacity: 0.35 })} />
    <rect x="580" y="360" width="100" height="150" rx="14" {...f(m('green', 55, 'ink'), { opacity: 0.35 })} />
    <circle cx="690" cy="560" r="16" {...f(m('gold', 90))} />
    <G x={860} y={380}>
      <circle cy="30" r="190" fill={`url(#${k}g)`} />
      <path d="M0 -60V-20" {...st(m('ink', 55, 'bg-2'), 5)} />
      <path d="M-26 -20H26L20 70H-20Z" {...f(m('ink', 55, 'bg-2'))} />
      <rect x="-16" y="-8" width="32" height="68" rx="6" {...f('#ffd98a')} />
    </G>
    <path d="M820 380H700" {...st(m('ink', 55, 'bg-2'), 5)} />
    <rect x="410" y="722" width="300" height="46" rx="14" {...f(m('accent', 55, 'bg-2'))} />
    <path d="M440 740H680" {...st(m('card', 70), 4, { opacity: 0.5 })} />
    <Plant x={190} y={730} s={2.8} />
    <Plant x={1000} y={730} s={2} pot={m('blue', 60)} />
  </>
);

export const iconScene: Scene = (W, H, k) => (
  <>
    <defs><Grad id={`${k}b`} a={m('gold', 70, 'accent')} b={m('accent', 100)} /><Glow id={`${k}g`} c="#fff0c0" /></defs>
    <rect width={W} height={H} rx="120" {...f(`url(#${k}b)`)} />
    <circle cx="256" cy="260" r="220" fill={`url(#${k}g)`} opacity="0.7" />
    <path d="M60 290H160L200 200L260 360L310 240L340 290H452" {...st('#fff6e8', 30)} />
    <path d="M256 70Q300 130 256 170Q212 130 256 70Z" {...f('#fff6e8', { opacity: 0.9 })} />
  </>
);
