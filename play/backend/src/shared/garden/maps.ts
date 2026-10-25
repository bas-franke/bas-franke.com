// Garden Sentinels maps. A map is an ASCII grid (one char per G.cell x G.cell metre cell) plus the routes enemies walk
// from each entry portal to the greenhouse. The server builds the buildable-cell mask from the grid; the client builds
// the whole garden from it (terrain, path, water, bridges, rocks, foliage, lamps, portals, greenhouse).
//
// Grid chars:
//   .  grass: buildable
//   #  path (enemies walk here; not buildable)
//   =  bridge: path over water
//   ~  water (stream / pond; not buildable)
//   o  lily pads on water (decor; not buildable)
//   R  rock cluster (blocked)
//   T  foliage cluster / tree (blocked)
//   f  flower bed (blocked)
//   l  garden lamp (blocked)
//   s  solar panel (blocked)
//   E  entry portal footprint (blocked; each portal is 2x2 cells at the start of a route)
//   G  greenhouse footprint (blocked; 4x4 cells, the goal every route ends in)
//
// Coordinates: cell (col, row) spans x in [col, col+1], y in [row, row+1] in "cell units"; row 0 is the north edge
// (-z in the world). Route points are in cell units too (so 2-wide paths have waypoints on cell corners, 1-wide on
// cell centres). World position: see cellToWorld in board.ts.

import type { GMode } from './constants.js';

export interface GRoute {
  /** Index into `entries`. */
  entry: number;
  /** Polyline in cell units: first point at the portal mouth, last point at the greenhouse door. */
  pts: [number, number][];
  /** Path half-width in cells (enemies spread across it). Usually 1 (a 2-cell-wide path). */
  half: number;
}

export interface GMapDef {
  id: string;
  name: string;
  blurb: string;
  /** Which modes the map can be played in. Versus maps are smaller (every player gets a copy). */
  modes: GMode[];
  grid: string[];
  /**
   * Portal centres in cell units, and the way the portal faces (radians, 0 = facing +y / south, i.e. towards the map).
   * facing = atan2(dx, dy) of the direction the portal mouth looks: east (+x) = PI / 2, west = -PI / 2, north = PI.
   * That equals three.js rotation.y for a model whose front is +z. The route starts at the middle of the mouth side.
   */
  entries: { x: number; y: number; facing: number }[];
  /** Greenhouse centre in cell units. */
  goal: { x: number; y: number };
  routes: GRoute[];
  /** Overall tint of the garden (sunlight warmth 0..1, used by the renderer). */
  mood?: { warmth: number; water: number };
}

export const RANDOM_GMAP = 'random';

/** Filled by the map author (see docs in this file). Order = order in the room's map picker. */
export const GMAPS: GMapDef[] = [
  // Generated from the level-design scratch tool, then checked with play/tools/garden/checkmaps.ts.
  {
    id: "greenhouse-commons",
    name: "Greenhouse Commons",
    blurb: "Three portals, two streams and the domed greenhouse. Every path meets at the U-bend by its door.",
    modes: ["coop"],
    grid: [
      'TT..f..TRTRTTR~~RRTTTTTTTT.TTTTTTTTRTT..',
      'T............T~~RT....l......l.......l.T',
      'EE########....~~R....#################EE',
      'EE#########...~~R...##################EE',
      '....l....###..~~...###.............##..R',
      '..........###==######...~~~..RR~~~.##...',
      'T..........##==#####..~~~~~~.R~~~~~##..T',
      'TTT.RT.......~~.......~~~~~~RR~~~~~##..T',
      'TTTTTT.......~~l........f~~RRR~~~~~##..T',
      'TRTTTT...####==##......TTTTRTRR~~~.##..T',
      'TTTTT.f..#####==##.....TTTGGGGR~~..##..T',
      'TTTTT.f.l##..~~~###....T.TGGGGR~~..##..T',
      'RTTTR....##.R~~..###fffTT.GGGGs~~..##l.T',
      'TTTTT...f##.R~~R..##.ffTT.GGGGs~~..##.TT',
      'TTTT....###.R~~Rf.##.......##.R~~R.##..T',
      'T......###..R~~R..##....ss.##.R~~R.##..T',
      'T...f.###..R~~RR..##..#######.R~~R.##..T',
      'EE######...R~~RR..##f.#######l.~~R.##..R',
      'EE#####l...R~~RRR.##f.##.......~~R.##..T',
      '........RR~~~~~~R.##..##.......~~..##..T',
      '.......RR~~~~o~~~l#############==####.fT',
      'T.fffTfR~~~~~o~~R.############===####..T',
      'TTffTRTff~~ooo~~R.............~~....l..T',
      'TTTTTRTTRT~~~~~RR........TT...~~..T.....',
      'TTTTTTTRRTTTRRRRRTTTTTRTTTTTTT~~TTTTTTT.',
    ],
    entries: [{ x: 1, y: 3, facing: Math.PI / 2 }, { x: 1, y: 18, facing: Math.PI / 2 }, { x: 39, y: 3, facing: -Math.PI / 2 }],
    goal: { x: 28, y: 12 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 3], [9, 3], [12, 6], [19, 6], [22, 3], [36, 3], [36, 21], [23, 21], [23, 17], [28, 17], [28, 14]] },
      { entry: 1, half: 1, pts: [[2, 18], [6, 18], [10, 14], [10, 10], [16, 10], [19, 13], [19, 21], [23, 21], [23, 17], [28, 17], [28, 14]] },
      { entry: 2, half: 1, pts: [[38, 3], [36, 3], [36, 21], [23, 21], [23, 17], [28, 17], [28, 14]] },
    ],
    mood: { warmth: 0.62, water: 0.6 },
  },
  {
    id: "lily-moat",
    name: "Lily Moat",
    blurb: "The greenhouse sits on an island in a lily pond. Everything crosses one long bridge to reach it.",
    modes: ["coop"],
    grid: [
      'TTTTTRTTT...TTTTTT.EE..TTRRRRRR..TTTTT..',
      'T..l............T..EE..T~~~~~~....fl....',
      'EE########.........##l.R~o~o~~=#######EE',
      'EE########.........##..R~~~~~~########EE',
      'T.......#############..TRT....##........',
      '........#############..RTTf...##....f...',
      'Tf.ff...##....l.f.......TTff..##f...ff.T',
      'RR......##.....R~~~~~~~~~RR...##....TTTT',
      '~RRR...l##..T.~~~~~~~~~~~~R...###....TRT',
      '~~~....###.R.~~~~~GGGG~~~~~R...###l...TT',
      '~~~~~~===~~~~~oo~~GGGG~ooo~RRR..###...TT',
      'RR~~~===~~~~~~oo~~GGGG~~oo~~~~R..##.R.TT',
      'TRRR.##....TT~ooo~GGGG~~~~~~~~~~~==~~~~~',
      'TTT..##.....T~~o~~~==~~~~~TTT.~~~==~~~~~',
      'TTT..##....TTT~~~o~==~~~~R~~RR.R.##.RRTT',
      'TTT..##l..R.TTT~~~~==~~~RR~~R....##...TT',
      'TTT..##......TRT.Rl##.RRRR~~Rff..##...TT',
      'TTT..###........f..##..fTR~~..f..##l..RR',
      'TTT...###..........##....R~~....###...TT',
      'TRRR...###f........##...f.~~f..###....TT',
      'RR~~~...##################==#####..ffRTT',
      'R~~o~~...#################==####.....RRT',
      '~~~~o~~R..l.f.............~.l....~~~~~TR',
      'R~~~~~RR......sss......sss~R...R~~~~~~~R',
      'TRRRRRR....TTTTTTTTTTTT.R~~Rf..TR~~~~~RR',
      'TTTTTTTTTTTTTTTTTTTTTTTTT~~RTTTRRRTTTRRT',
    ],
    entries: [{ x: 1, y: 3, facing: Math.PI / 2 }, { x: 20, y: 1, facing: 0 }, { x: 39, y: 3, facing: -Math.PI / 2 }],
    goal: { x: 20, y: 11 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 3], [9, 3], [9, 9], [6, 12], [6, 17], [10, 21], [20, 21], [20, 13]] },
      { entry: 1, half: 1, pts: [[20, 2], [20, 5], [9, 5], [9, 9], [6, 12], [6, 17], [10, 21], [20, 21], [20, 13]] },
      { entry: 2, half: 1, pts: [[38, 3], [31, 3], [31, 8], [34, 11], [34, 18], [31, 21], [20, 21], [20, 13]] },
    ],
    mood: { warmth: 0.5, water: 0.9 },
  },
  {
    id: "terraced-rockery",
    name: "Terraced Rockery",
    blurb: "Long switchbacks down a rock garden, and a narrow gravel gorge the fast ones like to take.",
    modes: ["coop"],
    grid: [
      'TTTRTRRRTTREE..RTRT~TTR..RRRTTRTRRRR',
      'RRTTRRRRR..EE......~..f..........TTT',
      'RTTRTTRR...##l....~~....f.........TR',
      'RTRRRRTR...#######==#########......R',
      'TRRTRRRR...#######==##########l...RR',
      'RRRRTRRT..........~~.l......###...RR',
      'RRTRR..R.........RR~R...ff...###..RR',
      'TRRT....RRRRRTTRRRR~RR...R....##..TR',
      'RTR...........f...R~~RRRRR...###....',
      'RT.................~~.....f.###....T',
      'RT.....############==#############EE',
      'RR....#############=##############EE',
      'R....###......fl...~...........f.l.R',
      'R...###.........f..~RRR............R',
      'R...##f..RRR.ffRRR.~~~RRRRRR......RT',
      'TT.l###...........~~~~~R..........sT',
      'TT...###...........~~~~...lf..GGGGsT',
      'RR....########################GGGGsR',
      'T......#######################GGGGTT',
      'RRRRR.....#...................GGGG.T',
      'R~~~R.....#..lRRRR....RRR..RR.f....R',
      '~~o~~.....########################EE',
      'R~~~RTT.....f....................lEE',
      'RRRRTRTTTR..RRRTTRRRT.RRTRTTRR......',
    ],
    entries: [{ x: 12, y: 1, facing: 0 }, { x: 35, y: 11, facing: -Math.PI / 2 }, { x: 35, y: 22, facing: -Math.PI / 2 }],
    goal: { x: 32, y: 18 },
    routes: [
      { entry: 0, half: 1, pts: [[12, 2], [12, 4], [28, 4], [31, 7], [31, 8], [28, 11], [8, 11], [5, 14], [5, 15], [8, 18], [30, 18]] },
      { entry: 1, half: 1, pts: [[34, 11], [28, 11], [8, 11], [5, 14], [5, 15], [8, 18], [30, 18]] },
      { entry: 2, half: 0.5, pts: [[34, 21.5], [10.5, 21.5], [10.5, 17.5], [30, 17.5]] },
    ],
    mood: { warmth: 0.78, water: 0.3 },
  },
  {
    id: "seedling-plot",
    name: "Seedling Plot",
    blurb: "A tidy allotment: two portals, three long rows and a little brook.",
    modes: ["vs"],
    grid: [
      'T.l.......~ff...f.TT',
      'EE########=######.TT',
      'EE#######==######.TR',
      'T.......l~~...l##.TT',
      'TT..f....~~....##..T',
      'TTl#######=#######EE',
      'TR.#######=#######EE',
      'TT.##.....~~.......T',
      'TT.##..l..~~..GGGGTT',
      'TT.#######==##GGGGRT',
      'TTl#######==##GGGGTT',
      'TT........~~.lGGGGTT',
      'TTTTTTTTTR~RRTTRTTTT',
      'TTTTRTRTTR~RRTTTRRTT',
    ],
    entries: [{ x: 1, y: 2, facing: Math.PI / 2 }, { x: 19, y: 6, facing: -Math.PI / 2 }],
    goal: { x: 16, y: 10 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 2], [16, 2], [16, 6], [4, 6], [4, 10], [14, 10]] },
      { entry: 1, half: 1, pts: [[18, 6], [16, 6], [4, 6], [4, 10], [14, 10]] },
    ],
    mood: { warmth: 0.7, water: 0.35 },
  },
  {
    id: "sprout-spiral",
    name: "Sprout Spiral",
    blurb: "One portal, one path curling inwards to a greenhouse in the middle of a fern ring.",
    modes: ["vs"],
    grid: [
      'T.l....l.........l.T',
      'EE################.T',
      'EE################fT',
      'T...........l...##.T',
      'TTTTTTTTT..TRTT.##.T',
      'TTff.TTRTTTTTTT.##lT',
      'TTf....l..GGGGR.##.T',
      'TTf.######GGGGT.##.R',
      'TTT.######GGGGT.##~~',
      'TTT.##....GGGGR.==~~',
      'TTT.##.......lf~=#lR',
      'RRR.###########==#.T',
      '~~~~###########=##.T',
      '~~~~.flfff....~~...T',
      'TTTTTRTTTTTRTR~~TTTT',
    ],
    entries: [{ x: 1, y: 2, facing: Math.PI / 2 }],
    goal: { x: 12, y: 8 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 2], [17, 2], [17, 12], [5, 12], [5, 8], [10, 8]] },
    ],
    mood: { warmth: 0.55, water: 0.5 },
  },
  {
    id: "sunflower-terraces",
    name: "Sunflower Terraces",
    blurb: "Four portals, one on every side, all spiralling into the horseshoe around the greenhouse. Bring friends.",
    modes: ["coop"],
    grid: [
      'TT..EETTTTTTTTTRTRTT....TTTTTTTTTRTTTTT..T',
      'TT..EE..TTTTTRTTTT..f..l.......l.........T',
      'TT.l##..fTTTRRTTT...####################EE',
      'TT..##..fTTTTTTRR...####################EE',
      'TT..##..fffff.ffff.f##................l..T',
      'T...##..RRRRR.RRRR..##.ffffff...RRRRR....T',
      'T...##......l.......##.RRRRRR...R~~~~..TTT',
      'TT..########################..TT~~~~~~TTTT',
      'TT..########################..TT~~~~~~TRTT',
      'RT...l........##.....l....##..TTT~~~~RRTTT',
      'TTffff.ffff...##.ff....ff.##.....~~.RR..TT',
      'TTRRRRRRRRRR..##f.TTRTTT..##.l...~~.l....T',
      'TTTTRTTTTTTff.##f.TGGGG...######==####..TT',
      'TTTTTTTTTTTT..##.sTGGGG.s.######==####..TR',
      'TTTRTTTRTTT...##.s.GGGG.s.##....~~f.##..TT',
      'TTTTTTTTRTT...##...GGGG...##....~RR.##..RT',
      'TTfRRRRRRRRR..##....##f...##..T~~RRf##..TT',
      'T..ffff.ffff..##....##....##..~~~~Rf##..TT',
      'T.............##l...##....##..~~~~R.##..TT',
      'EE##############....########l.T~~.R.##..TT',
      'EE##############....########..f.....##..TT',
      '...l..........................f.....##..TT',
      'T....RR...~~RRRfffffff..........ff..##l.RT',
      'TTTTTR~~~~~~~~RRRRRRRR..##############..TT',
      'TTTTTT~~o~~o~~R.TTTTTT..##############..TT',
      'TTTTTT~~~~~~~RTTTTTTTT..##........ff....TT',
      'TTTTTTTTT~~TTTTTTTTTTT..EE.TffffRffff..TTT',
      'TTTTRTTTTTTTTTTTTTTTTTT.EETTTTTRTTTTTRTTTT',
    ],
    entries: [{ x: 5, y: 1, facing: 0 }, { x: 41, y: 3, facing: -Math.PI / 2 }, { x: 25, y: 27, facing: Math.PI }, { x: 1, y: 20, facing: Math.PI / 2 }],
    goal: { x: 21, y: 14 },
    routes: [
      { entry: 0, half: 1, pts: [[5, 2], [5, 8], [15, 8], [27, 8], [27, 20], [21, 20], [21, 16]] },
      { entry: 1, half: 1, pts: [[40, 3], [21, 3], [21, 8], [27, 8], [27, 20], [21, 20], [21, 16]] },
      { entry: 2, half: 1, pts: [[25, 26], [25, 24], [37, 24], [37, 13], [27, 13], [27, 20], [21, 20], [21, 16]] },
      { entry: 3, half: 1, pts: [[2, 20], [15, 20], [15, 8], [27, 8], [27, 20], [21, 20], [21, 16]] },
    ],
    mood: { warmth: 0.88, water: 0.35 },
  },
  {
    id: "koi-crossing",
    name: "Koi Crossing",
    blurb: "Koi ponds everywhere and a bridge every few steps. Short walks, lots of narrow crossings to hold.",
    modes: ["coop"],
    grid: [
      'RTTTT.TTTTTTTTTTTRT.......TRR~~TT..R~~......',
      '........TTTTRRRRTT.....l.....~~.....~~..l...',
      '...l......TTT~~TT....########==######=####EE',
      'EE####.....T~~~~.R..#########==######=####EE',
      'EE####..fff.~~~~~~.###......f~...l...~~....T',
      '....##..R....RRR~~===..R...RR~.....R~~~~RR.T',
      'T...##........l..##=~~~RRR.R~~RTTTRR~~o~~RTT',
      '~~~~==......#######..~~~~.RR~~RRRTTTR~~~T.TT',
      '~~~~==~.R..########.....~~~~~~~~RTTTRRRTT.TT',
      'T..l##~~~.###....###.....T~~~~~~R........TTT',
      'T...###~~=##......###..R.T~~oo~~R........TTT',
      'T....###===........###l.~~~~~~~RR.....GGGGTT',
      'TT....###=~~RRTT....#==~~~..~~RR...###GGGGTT',
      'TT....###..~~~~~TRR~~===.....~RR..####GGGGRT',
      'T....###f..~o~o~~~~~~.###....~~..###l.GGGGTT',
      'T...###....~~~~o~~~RR.f###..R~~.###.......TT',
      'Tf.l##....f~~~o~~~RR....###..~~###........TT',
      'T.R.##....RRR~~~TRT.R....####==##......RRRTR',
      '~~~~##....RRRRTTTTTTR.....####==......RTTTTT',
      '~~~~==~~..fTTTTTTTTRT.....l...~~.R...TTTTTTT',
      'R...#=~~~~~~~TTTTTTTTR.......RR~~.RRRTTTTTTT',
      'EE####..~~~~~~TTTTTTTTTTT...fRR~~~~~TTTTTTTT',
      'EE####.R~~~~~~RTTTRTTTTTTT.fRR~~o~o~~RTTTTTT',
      'T...l..RR~~~~RRTRTTRTTTTRTTTTRR~~~~~TTTTTTTT',
      'TR......RRRRTTTTTTTRTTTTTTTTTTRRRRTRTTTTTTTT',
      'TTRTTTTTTTTTTTTTTTTTTRTTRTTTTTTTTTTTTTTTTTRT',
    ],
    entries: [{ x: 1, y: 4, facing: Math.PI / 2 }, { x: 1, y: 22, facing: Math.PI / 2 }, { x: 43, y: 3, facing: -Math.PI / 2 }],
    goal: { x: 40, y: 13 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 4], [5, 4], [5, 10], [8, 13], [13, 8], [17, 8], [27, 18], [31, 18], [36, 13], [38, 13]] },
      { entry: 1, half: 1, pts: [[2, 22], [5, 22], [5, 16], [8, 13], [13, 8], [17, 8], [27, 18], [31, 18], [36, 13], [38, 13]] },
      { entry: 2, half: 1, pts: [[42, 3], [22, 3], [17, 8], [27, 18], [31, 18], [36, 13], [38, 13]] },
    ],
    mood: { warmth: 0.58, water: 0.95 },
  },
  {
    id: "moonlit-orchard",
    name: "Moonlit Orchard",
    blurb: "Long rows between the fruit trees under a cool moon. Two orchards, two approaches, one door.",
    modes: ["coop"],
    grid: [
      'TT.........TT..EE.TRTR.EETTTTTTRTff.....',
      'T.l......l.....EE..TT..EE..l........l...',
      'EE###############......###############EE',
      'EE###############......###############EE',
      'T..f...........##.f....##..............T',
      '.......T..T..T.##l.....##.T..T..T.......',
      'R..............##......##.............fT',
      'T...#############.RRRR.#############..TT',
      'T.f.#############.R~~R.#############..TR',
      'T...##.l..........~~~~...l........##..TT',
      'R...##..T..T..T..R~~~~R..T..T..T..##..TT',
      'R...##............~~o~............##l..T',
      'T...#############.~~~~.#############...T',
      'T...#############.R~~..#############..TT',
      'Rf.............##.R....##.............TT',
      'T..T..T..T..T..##......##..T..T..T..T.TT',
      'TT......T.....l##f.....##..TTR........TT',
      'TTTTT..TTT.....##......##..TTTTTTTT...TR',
      'TTTTTTTTTRTT...##########...TTTRTTTTTTTT',
      'TTTTRTTTTTTTT..##########...TTTRTTTTTTTT',
      'TTTTTRTTRTTRT...f..##..l..ffTTRTTTTTRRTT',
      'TTTTTTTTTTTRR.....GGGG......TTTTTTTTTTTT',
      'TTTTTTTTRTTTf.....GGGG.T....TTRRTTTTTTTT',
      'TTTTTTRTTTTRRTTT..GGGGTTTTTTTTTTTTTTTTTT',
      'TTTTTTRTTTTTTTTTRTGGGGTTTTTTRTTTTRTTTTTT',
      'TTRTTTRTTTTTTTTTTTTTTTTTTTTTTTTTTRTTTTTT',
    ],
    entries: [{ x: 1, y: 3, facing: Math.PI / 2 }, { x: 39, y: 3, facing: -Math.PI / 2 }, { x: 16, y: 1, facing: 0 }, { x: 24, y: 1, facing: 0 }],
    goal: { x: 20, y: 23 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 3], [16, 3], [16, 8], [5, 8], [5, 13], [16, 13], [16, 19], [20, 19], [20, 21]] },
      { entry: 1, half: 1, pts: [[38, 3], [24, 3], [24, 8], [35, 8], [35, 13], [24, 13], [24, 19], [20, 19], [20, 21]] },
      { entry: 2, half: 1, pts: [[16, 2], [16, 8], [5, 8], [5, 13], [16, 13], [16, 19], [20, 19], [20, 21]] },
      { entry: 3, half: 1, pts: [[24, 2], [24, 8], [35, 8], [35, 13], [24, 13], [24, 19], [20, 19], [20, 21]] },
    ],
    mood: { warmth: 0.25, water: 0.3 },
  },
  {
    id: "twin-beds",
    name: "Twin Beds",
    blurb: "Two lanes run side by side around a flower bed and meet right at the greenhouse door.",
    modes: ["vs"],
    grid: [
      'T.f.lTTTTT.l.RRR.....T',
      'EE##################.R',
      'EE##################.T',
      'T.....f.f.......l.##TT',
      'TTRTRTTTT...f.....##TT',
      'TTRTTTTT..##########TT',
      'TTTGGGG..l##########TT',
      'TTTGGGG#####.ffffff.TT',
      'RTTGGGG#####.ffffff.TR',
      'TTTGGGG...##########TT',
      'TTTTTTTTT.##########TT',
      'TTT.....T...f.....##TT',
      'R..lf.f.l....f.l..##TT',
      'EE##################.T',
      'EE##################lT',
      'T...f.TTTTTTTTTT.....T',
    ],
    entries: [{ x: 1, y: 2, facing: Math.PI / 2 }, { x: 1, y: 14, facing: Math.PI / 2 }],
    goal: { x: 5, y: 8 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 2], [19, 2], [19, 6], [11, 6], [11, 8], [7, 8]] },
      { entry: 1, half: 1, pts: [[2, 14], [19, 14], [19, 10], [11, 10], [11, 8], [7, 8]] },
    ],
    mood: { warmth: 0.66, water: 0.3 },
  },
  {
    id: "pebble-loop",
    name: "Pebble Loop",
    blurb: "One path loops all the way round a lily pond before crossing to the greenhouse on its island.",
    modes: ["vs"],
    grid: [
      'T..l.....fl.....TTRT',
      'EE#############l.TTT',
      'EE##############..RT',
      'T.............###..T',
      'TTTTTTTRRR~~~..###.R',
      'TT.....l~GGGG~~.##.T',
      'TTf.###==GGGG~~~##.T',
      'TT..##===GGGG~~~##lT',
      'TTT.##f~~GGGG~~~##fT',
      'TTT.##..~~~~~~~###.T',
      'TTTl###...~~~.###..T',
      'TTT..###########..TT',
      'TTTT..#########..fTT',
      'RTTTT....l....l.TTTT',
      'TTTTRTTTTRTTTRTTTTRT',
    ],
    entries: [{ x: 1, y: 2, facing: Math.PI / 2 }],
    goal: { x: 11, y: 7 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 2], [14, 2], [17, 5], [17, 9], [14, 12], [7, 12], [5, 10], [5, 7], [9, 7]] },
    ],
    mood: { warmth: 0.45, water: 0.8 },
  },
  {
    id: "windmill-meadow",
    name: "Windmill Meadow",
    blurb: "Four portals and long switchbacks round an open meadow. The moths cut straight across it to the door.",
    modes: ["coop"],
    grid: [
      'T.TEE..TTTTTTTTTfRTTRTTfTTTTTRTTTRTTTTTT',
      'R..EE..RTTTRTTT..f....f.RTTRTTT...f....T',
      'Tf.##.....TT......f..f..ff.fTT...l####EE',
      'T..##..............RR.............####EE',
      'T.f##l.....f.l.....RR...l.f.......##...T',
      'TT.##...#######...f..f..#######...##...T',
      'TT.##.R.#######..f.l..f.#######~~.##.TTT',
      'T..##~~.##...##.........##...##~~.##.TTT',
      'T..##~~.##...##...GGGG..##...##~~.##..TT',
      'T..##~~.##.f.##...GGGG..##...##.R.##...T',
      'RT.##~~.##.ff##...GGGG..##...##...##TT.R',
      'TT.##...##...##...GGGG.l##...##l.T##.R.T',
      'T..##.f.##R..##....##...##f..##..T##..RT',
      'T.l#######...##....##...##.T.#######..TT',
      'T..#######...##....##...##.TT#######..TT',
      'TT......##...##....##...##...##.....TT.T',
      'T...fff.##...##....##...##T..##.ff..RT.T',
      '.....f..##l..#############...##..R..fRTT',
      '........##...#############...##.R.~~~RRT',
      'EE########.......l......l....##..~~~~~RT',
      'EE########.RRR~~~~~RRRRR.~~~~==~~~~~~~RT',
      'TTRl.......R~~~ooo~~~~~~~~~~~==~..~~~~RT',
      'T.TT........~~~~~o~o~~RRTf.R.##.RRRRRRRT',
      'TT...RTTT....~~~~~~~~RRTT....##l.TTRTTTT',
      'TTTTTTTTTTTTRTTT~~RRRRTTTT...EE.TTTTTTTT',
      'TTTTTTTTTTTTTTTTRRRTTTTTTTT..EETTTTTTTTT',
    ],
    entries: [{ x: 4, y: 1, facing: 0 }, { x: 1, y: 20, facing: Math.PI / 2 }, { x: 39, y: 3, facing: -Math.PI / 2 }, { x: 30, y: 25, facing: Math.PI }],
    goal: { x: 20, y: 10 },
    routes: [
      { entry: 0, half: 1, pts: [[4, 2], [4, 14], [9, 14], [9, 6], [14, 6], [14, 18], [20, 18], [20, 12]] },
      { entry: 1, half: 1, pts: [[2, 20], [9, 20], [9, 6], [14, 6], [14, 18], [20, 18], [20, 12]] },
      { entry: 2, half: 1, pts: [[38, 3], [35, 3], [35, 14], [30, 14], [30, 6], [25, 6], [25, 18], [20, 18], [20, 12]] },
      { entry: 3, half: 1, pts: [[30, 24], [30, 6], [25, 6], [25, 18], [20, 18], [20, 12]] },
    ],
    mood: { warmth: 0.74, water: 0.55 },
  },
  {
    id: "dandelion-hill",
    name: "Dandelion Hill",
    blurb: "Three long rows down a dandelion slope. The moths ignore the rows and drift straight down the hill.",
    modes: ["vs"],
    grid: [
      'TTTTTTTTTEETTTRTTTTT',
      'T..lf....EEl.......T',
      'EE################.T',
      'EE################lT',
      'T.R..........~~.##.R',
      'TTfT..TTTf..~~~~##RR',
      'TTff...l....~~~.##.T',
      'TT.###############.R',
      'TT.###############.T',
      'RTf##...........l..f',
      'RTl##TTTR....TRTTTfT',
      'TT.##.T.....TGGGGTfT',
      'TTf##########GGGGTTT',
      'TR.##########GGGGTRT',
      'TT....ff.l.f.GGGGTTT',
    ],
    entries: [{ x: 1, y: 3, facing: Math.PI / 2 }, { x: 10, y: 1, facing: 0 }],
    goal: { x: 15, y: 13 },
    routes: [
      { entry: 0, half: 1, pts: [[2, 3], [17, 3], [17, 8], [4, 8], [4, 13], [13, 13]] },
      { entry: 1, half: 1, pts: [[10, 2], [10, 3], [17, 3], [17, 8], [4, 8], [4, 13], [13, 13]] },
    ],
    mood: { warmth: 0.8, water: 0.3 },
  },
]; // END GMAPS

export const gmapById = (id: string) => GMAPS.find((m) => m.id === id);
export const gmapsFor = (mode: GMode) => GMAPS.filter((m) => m.modes.includes(mode));
export const GMAP_LIST = () => GMAPS.map(({ id, name, blurb, modes }) => ({ id, name, blurb, modes }));

export const BUILDABLE = '.';
export const isBuildableChar = (c: string | undefined) => c === BUILDABLE;
