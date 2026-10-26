// The music director: reads the race every frame, works out how intense the moment is (0..1) and drives the music
// (music.ts) with it, eased so the stems move on the beat rather than flicker.
//   intro: calm; countdown: building, with a riser, to a drop on the green light;
//   racing: a base plus speed, boost and pad surges, position changes, close battles, airtime, the knife edge (Q/E),
//     heavy damage (tension: a darker, warbling pad) and the last 10% of the run (the lead comes in);
//   a wreck: a hit, then only the pad until the respawn; the finish: a sting by position; paused: muffled.
// It also ducks the music under part breaks and big hits, so those cues and the engines stay readable.
// `parts` holds this frame's contributions (the lab prints them). No allocation per frame.

import { sfx } from '../../engine/audio';
import type { Race } from '../core/race';
import { withAudioContext } from './context';
import { SynthMusic } from './music';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class MusicDirector {
  music: SynthMusic | null = null;
  /** The eased intensity the music plays at, and the target it eases towards. */
  intensity = 0;
  target = 0;
  readonly parts = { base: 0, speed: 0, boost: 0, battle: 0, position: 0, air: 0, edge: 0, finale: 0, tension: 0 };

  private cancelWait: (() => void) | null = null;
  private offVolume: () => void;
  private dropped = false;
  private wasWrecked = false;
  private finished = false;
  private lastPosition = 0;
  private positionPulse = 0;
  private finaleRise = 0;
  private broken = 0;
  private duckCool = 0;

  constructor(private readonly race: Race) {
    this.offVolume = sfx.subscribe(() => this.music?.setVolume(this.volume()));
  }

  private volume() {
    return Math.min(1, sfx.level * 2);
  }

  /** Starts the music now, or on the first user gesture. */
  start(ctx?: BaseAudioContext) {
    if (this.music || this.cancelWait) return;
    const build = (c: BaseAudioContext) => {
      this.cancelWait = null;
      this.music = new SynthMusic(c);
      this.music.setVolume(this.volume());
    };
    if (ctx) build(ctx);
    else this.cancelWait = withAudioContext(build);
  }

  update(dt: number) {
    const m = this.music;
    if (!m || dt <= 0) return;
    const race = this.race;
    const p = race.player;
    const st = p.state;
    const parts = this.parts;
    let riser = 0;

    if (race.phase === 'intro') this.target = 0.08;
    else if (race.phase === 'countdown' || (race.phase === 'racing' && race.time < 0)) {
      const k = clamp01((race.time + 3) / 3);
      this.target = 0.1 + 0.25 * k;
      riser = k * k;
    } else {
      if (!this.dropped) {
        this.dropped = true;
        m.drop();
        this.intensity = Math.max(this.intensity, 0.45);
        this.lastPosition = p.position;
      }
      const top = p.stats.topSpeed;
      parts.base = 0.3;
      parts.speed = 0.28 * clamp01(st.v / top);
      parts.boost = (st.boosting ? 0.15 : 0) + (st.surge > 0 ? 0.08 : 0);
      // Position changes: a pulse that fades over a few seconds (gaining a place counts more than losing one).
      if (p.position !== this.lastPosition) {
        this.positionPulse = Math.max(this.positionPulse, p.position < this.lastPosition ? 1 : 0.6);
        this.lastPosition = p.position;
      }
      this.positionPulse = Math.max(0, this.positionPulse - dt / 4);
      parts.position = 0.15 * this.positionPulse;
      // A close battle: the nearest pod along the course within ~35 m.
      let gap = Infinity;
      for (const r of race.racers) {
        if (r === p || r.gone || r.wrecked > 0 || r.finish !== null) continue;
        const d = Math.abs(r.progress - p.progress);
        if (d < gap) gap = d;
      }
      parts.battle = 0.15 * clamp01(1 - gap / 35);
      parts.air = st.air ? 0.1 : 0;
      parts.edge = Math.abs(st.roll) > 0.5 ? 0.1 : 0;
      const h = p.parts.health;
      parts.tension = clamp01(Math.max((0.6 - h.hull) / 0.5, (Math.max(p.damage[0], p.damage[1], p.damage[2]) - 0.55) / 0.4));
      // The finale is the last tenth of a base layout's length (long courses repeat it in blocks).
      const finale = p.progress >= race.track.raceLength - 0.1 * race.track.blockLength && p.finish === null;
      if (finale && !m.finale) this.finaleRise = 1;
      this.finaleRise = Math.max(0, this.finaleRise - dt / 2.5);
      riser = this.finaleRise * 0.8;
      parts.finale = finale ? 0.2 : 0;
      m.finale = finale;
      m.air = st.air;
      m.edge = parts.edge > 0;
      m.tension = parts.tension;
      this.target = clamp01(parts.base + parts.speed + parts.boost + parts.position + parts.battle + parts.air + parts.edge + 0.08 * parts.tension + parts.finale);

      // A wreck: a hit and the sparse pad until the respawn, then the stems rebuild from mid intensity.
      const wrecked = p.wrecked > 0;
      if (wrecked && !this.wasWrecked) m.wreckHit();
      if (!wrecked && this.wasWrecked && !this.finished) {
        m.resume();
        this.intensity = 0.3;
      }
      this.wasWrecked = wrecked;
      if (wrecked) this.target = 0.1;

      // Duck under part breaks and big hits.
      this.duckCool -= dt;
      const broken = p.parts.broken.size;
      if (broken > this.broken && !wrecked) {
        m.duck(0.5, 0.6);
        this.duckCool = 0.6;
      } else if (st.impact > 0.4 && this.duckCool <= 0 && !wrecked) {
        m.duck(0.3, 0.25);
        this.duckCool = 0.5;
      }
      this.broken = broken;

      if (p.finish !== null && !this.finished) {
        this.finished = true;
        m.sting(p.position);
      }
      if (this.finished) this.target = 0.1;
    }

    const rate = this.target > this.intensity ? 1.3 : 0.45;
    this.intensity += (this.target - this.intensity) * (1 - Math.exp(-dt * rate));
    m.intensity = this.intensity;
    m.setRiser(riser);
    m.pump();
  }

  setPaused(p: boolean) {
    this.music?.setPaused(p);
  }

  dispose() {
    this.offVolume();
    this.cancelWait?.();
    this.cancelWait = null;
    this.music?.dispose();
    this.music = null;
  }
}
