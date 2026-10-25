// Debug: where do pods get stuck? Runs a race and prints, for each pod slower than 25 m/s for over a second, its
// track position and the rock formations around it.
//   tsx tools/racer/stuck.ts <trackId> [--solo]

import { newCareer, playerRacer, quickRaceRacers } from '../../frontend/src/racer/core/career';
import { Race } from '../../frontend/src/racer/core/race';
import { trackById } from '../../frontend/src/racer/core/tracks';

const id = process.argv[2] ?? 'archway';
const solo = process.argv.includes('--solo');
const all = quickRaceRacers(playerRacer(newCareer('P')), 8, 0.7, 2);
const race = new Race(trackById(id), solo ? all.filter((r) => !r.ai) : all, {});
race.autopilot = true;
const slow = new Map<object, number>();
const reported = new Set<string>();
while (race.time < 300) {
  race.update(1 / 60);
  if (race.time < 6) continue;
  for (const r of race.racers) {
    if (r.finish !== null) continue;
    const t = r.state.v < 25 ? (slow.get(r) ?? 0) + 1 / 60 : 0;
    slow.set(r, t);
    const key = `${r.name}@${Math.round(r.state.s / 20)}`;
    if (t > 1 && !reported.has(key)) {
      reported.add(key);
      const near = race.track.obstacles.filter((o) => Math.abs(o.s - r.state.s) < 30);
      const w = race.track.frameAt(r.state.s).width;
      console.log(`${r.name} s=${r.state.s.toFixed(1)} x=${r.state.x.toFixed(1)} v=${r.state.v.toFixed(1)} w=${w.toFixed(0)} onRock=${r.state.onRock}`);
      for (const o of near) console.log(`   ${o.kind} g${o.group} side${o.side} s=${o.s.toFixed(1)} x=${o.x.toFixed(1)} r=${o.r.toFixed(1)}`);
    }
  }
  if (race.racers.every((r) => r.finish !== null)) break;
}
