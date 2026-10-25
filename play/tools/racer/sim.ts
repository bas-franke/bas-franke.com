// Headless race simulation: runs full races (no rendering) with the career fields and reports finishing times, wall hits,
// rock hits, pod contacts, wrecks, airtime, overtakes, stuck/backwards pods and the finishing spread. The player's pod is flown by the AI at a
// chosen skill, standing in for a beginner or a good player.
//
//   tsx tools/racer/sim.ts [--tracks redrock,falls] [--cup dust|mesa|canyon|sun|quick|all] [--player 0.3] [--runs 1]
//                          [--solo] [--difficulty 0-3 (quick races: Rookie, Racer, Ace, Legend)] [-v]
// (tsx lives in play/backend/node_modules/.bin; needs Node 22+.)

import { CUPS, cupRacers, newCareer, playerRacer, quickRaceRacers, startCup } from '../../frontend/src/racer/core/career';
import { Race, type Racer, type RacerSetup } from '../../frontend/src/racer/core/race';
import { TRACKS, trackById } from '../../frontend/src/racer/core/tracks';
import { DIFFICULTIES } from '../../frontend/src/racer/ui/menuStore';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const verbose = args.includes('-v');
const playerSkill = Number(opt('player', '0.9'));
const runs = Number(opt('runs', '1'));
const cupArg = opt('cup', 'all');
const trackArg = opt('tracks', '');

// What the player plausibly flies by the time they reach each cup.
const playerPod: Record<string, [string, number]> = { dust: ['ember', 0], mesa: ['ember', 2], canyon: ['tide', 2], sun: ['crimson', 5], quick: ['ember', 0] };

function field(cup: string): RacerSetup[] {
  let s = newCareer('Player');
  const [podId, up] = playerPod[cup];
  s = { ...s, pod: podId, ownedPods: [podId], upgrades: { [podId]: { thrust: up, topSpeed: up, handling: up, boost: up } } };
  if (cup === 'quick') {
    const d = DIFFICULTIES[Number(opt('difficulty', '2'))];
    return quickRaceRacers(playerRacer(s), 8, d.skill, d.upgrades);
  }
  s = startCup(s, cup);
  return cupRacers(s);
}

const fmt = (t: number) => (Number.isFinite(t) ? t.toFixed(1) : '-');

const cups = cupArg === 'all' ? CUPS.map((c) => c.id) : cupArg.split(',');
for (const cup of cups) {
  const trackIds = trackArg ? trackArg.split(',') : cup === 'quick' ? TRACKS.map((t) => t.id) : CUPS.find((c) => c.id === cup)!.tracks;
  console.log(`\n=== ${cup} cup, player skill ${playerSkill} on ${playerPod[cup][0]}+${playerPod[cup][1]} ===`);
  for (const id of trackIds) {
    for (let run = 0; run < runs; run++) {
      const def = trackById(id);
      const all = field(cup);
      const solo = args.includes('--solo');
      const setups = solo ? all.filter((r) => !r.ai) : all;
      let rearEnds = 0;
      const wall = new Map<Racer, number>();
      const contact = new Map<Racer, number>();
      const rocks = new Map<Racer, number>();
      const air = new Map<Racer, number>();
      const lastImpact = new Map<Racer, number>();
      const wrecks = new Map<Racer, number>();
      let race!: Race;
      race = new Race(def, setups, {
        onWreck: (r) => wrecks.set(r, (wrecks.get(r) ?? 0) + 1),
        onImpact: (r, k) => {
          if (k < 0.12) return;
          const prev = lastImpact.get(r) ?? -1;
          if (race.time - prev > 0.3) {
            const nearRock = race.track.obstacles.some((o) => Math.abs(o.s - r.state.s) < o.r + 4 && Math.abs(o.x - r.state.x) < o.r + 5);
            const m = nearRock ? rocks : r.state.scrape > 0 && r.state.scrape < 0.02 ? wall : contact;
            if (m === contact) {
              // Nose-to-tail or side by side?
              let near = Infinity;
              let lat = 0;
              for (const o of race.racers) {
                if (o === r) continue;
                const d = o.state.s - r.state.s;
                if (Math.abs(d) < Math.abs(near)) {
                  near = d;
                  lat = o.state.x - r.state.x;
                }
              }
              if (Math.abs(lat) < 5) rearEnds++;
            }
            m.set(r, (m.get(r) ?? 0) + 1);
          }
          lastImpact.set(r, race.time);
        },
      });
      race.autopilot = true;
      (race as unknown as { playerAi: object }).playerAi = { skill: playerSkill, bias: 0, aggression: 0.6 };
      race.time = -0.01;
      const stuck = new Map<Racer, number>();
      const backwards = new Map<Racer, number>();
      const overtakes = new Map<Racer, number>();
      const prevPos = new Map<Racer, number>(race.racers.map((r) => [r, r.position]));
      let speedSum = 0;
      let speedN = 0;
      const dt = 1 / 60;
      while (race.time < 600) {
        race.update(dt);
        if (race.time < 0) continue;
        for (const r of race.racers) {
          if (r.finish !== null) continue;
          if (race.time > 6 && r.state.v < 25 && r.wrecked <= 0) stuck.set(r, (stuck.get(r) ?? 0) + dt);
          if (r.state.h > 0.5) air.set(r, (air.get(r) ?? 0) + dt);
          if (Math.abs(r.state.psi) > 1.0) backwards.set(r, (backwards.get(r) ?? 0) + dt);
          if (r.position < prevPos.get(r)! && race.time > 3) overtakes.set(r, (overtakes.get(r) ?? 0) + 1);
          prevPos.set(r, r.position);
        }
        speedSum += race.player.state.v;
        speedN++;
        if (race.racers.every((r) => r.finish !== null)) break;
      }
      const order = [...race.racers].sort((a, b) => (a.finish ?? 1e9) - (b.finish ?? 1e9));
      const first = order[0].finish ?? NaN;
      const last = order[order.length - 1].finish ?? NaN;
      const p = race.player;
      const total = (m: Map<Racer, number>) => [...m.values()].reduce((a, b) => a + b, 0);
      console.log(
        `${id.padEnd(9)} L=${Math.round(race.track.raceLength)} player P${order.indexOf(p) + 1}/${order.length} ${fmt(p.finish ?? NaN)}s avg ${Math.round(speedSum / speedN)}m/s | ` +
          `win ${fmt(first)} spread ${fmt(last - first)}s | walls ${total(wall)} rocks ${total(rocks)} air ${fmt(total(air) / race.racers.length)}s contacts ${total(contact)} (${rearEnds} nose-to-tail) passes ${total(overtakes)} wrecks ${total(wrecks)} (player ${wrecks.get(p) ?? 0}) stuck ${fmt(total(stuck))}s back ${fmt(total(backwards))}s`,
      );
      if (verbose) {
        for (const r of order) {
          console.log(
            `   ${(r.ai ? `${r.name} (${r.ai.skill.toFixed(2)})` : `PLAYER (${playerSkill})`).padEnd(24)} ${r.pod.id.padEnd(8)} ${fmt(r.finish ?? NaN).padStart(6)} walls ${wall.get(r) ?? 0} rocks ${rocks.get(r) ?? 0} contacts ${contact.get(r) ?? 0} passes ${overtakes.get(r) ?? 0} wrecks ${wrecks.get(r) ?? 0} stuck ${fmt(stuck.get(r) ?? 0)}`,
          );
        }
      }
    }
  }
}
