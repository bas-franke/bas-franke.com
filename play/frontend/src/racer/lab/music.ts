// Lab: the race music and its director, without the renderer.
//   /race/lab/music
// "Manual" plays the music at the slider's intensity with buttons for every event (drop, wreck, part break, finish
// stings, pause...). "Live race" runs an autopilot race headless through the director and prints what drives the
// intensity each moment. `window.__musicLab` holds the current SynthMusic / MusicDirector.

import { newCareer, playerRacer, quickRaceRacers } from '../core/career';
import { Race } from '../core/race';
import { trackById } from '../core/tracks';
import { currentAudioContext, withAudioContext } from '../audio/context';
import { MusicDirector } from '../audio/director';
import { SynthMusic } from '../audio/music';

export function mount(el: HTMLElement): () => void {
  const trackId = new URLSearchParams(location.search).get('track') ?? 'redrock';
  el.style.cssText = 'position:absolute;inset:0;overflow:auto;background:#10131c;color:#d8e4f8;font:14px/1.5 system-ui;padding:16px';
  el.innerHTML = `
    <h2 style="margin:0 0 8px">Race music lab</h2>
    <p style="margin:0 0 12px;opacity:.7">Click anything to start the audio. Manual: the slider sets the intensity. Live: an autopilot race on ${trackId} drives the director.</p>
    <div data-row="mode"></div>
    <label style="display:block;margin:8px 0">Intensity <input data-int type="range" min="0" max="1" step="0.01" value="0.4" style="width:320px;vertical-align:middle"> <b data-iv>0.40</b></label>
    <label style="display:block;margin:8px 0">Damage (tension) <input data-ten type="range" min="0" max="1" step="0.01" value="0" style="width:200px;vertical-align:middle"></label>
    <div data-row="toggles"></div>
    <div data-row="events" style="margin-top:4px"></div>
    <div data-row="finish" style="margin-top:4px"></div>
    <pre data-out style="margin-top:12px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap"></pre>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const out = q<HTMLElement>('[data-out]');
  const slider = q<HTMLInputElement>('[data-int]');
  const tension = q<HTMLInputElement>('[data-ten]');
  const iv = q<HTMLElement>('[data-iv]');
  const button = (row: string, label: string, fn: (b: HTMLButtonElement) => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:0 6px 6px 0;padding:6px 10px;background:#1f2a40;color:inherit;border:1px solid #5a7ab0;border-radius:4px;cursor:pointer';
    b.onclick = () => withAudioContext(() => fn(b));
    q<HTMLElement>(`[data-row="${row}"]`).appendChild(b);
    return b;
  };

  let music: SynthMusic | null = null;
  let live: { race: Race; director: MusicDirector } | null = null;
  let raf = 0;
  let last = performance.now();
  let paused = false;
  const lab = window as unknown as { __musicLab: unknown };

  const stop = () => {
    live?.director.dispose();
    live = null;
    music?.dispose();
    music = null;
  };
  const manual = () => {
    const ctx = currentAudioContext();
    if (!ctx) return null;
    if (!music) {
      stop();
      music = new SynthMusic(ctx);
      music.drop();
      lab.__musicLab = music;
    }
    return music;
  };
  const current = () => live?.director.music ?? music;

  button('mode', 'Manual', () => manual());
  button('mode', 'Live race (from grid)', () => {
    stop();
    const race = new Race(trackById(trackId), quickRaceRacers(playerRacer(newCareer())), {});
    race.autopilot = true;
    race.time = -4.5;
    const director = new MusicDirector(race);
    director.start(currentAudioContext()!);
    live = { race, director };
    lab.__musicLab = director;
  });
  button('mode', 'Stop', () => stop());

  const toggle = (label: string, key: 'air' | 'edge' | 'finale') =>
    button('toggles', label, (b) => {
      const m = manual();
      if (!m) return;
      m[key] = !m[key];
      b.style.background = m[key] ? '#3d5a8a' : '#1f2a40';
    });
  toggle('Airborne', 'air');
  toggle('Knife edge (Q/E)', 'edge');
  toggle('Final stretch', 'finale');
  button('toggles', 'Pause', (b) => {
    paused = !paused;
    current()?.setPaused(paused);
    b.style.background = paused ? '#3d5a8a' : '#1f2a40';
  });

  button('events', 'Green light (drop)', () => manual()?.drop());
  button('events', 'Countdown riser', () => {
    const m = manual();
    if (!m) return;
    const t0 = performance.now();
    const id = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / 3000);
      m.setRiser(k * k);
      if (k >= 1) {
        clearInterval(id);
        m.setRiser(0);
        m.drop();
      }
    }, 30);
  });
  button('events', 'Boost (+0.2 for 3 s)', () => {
    if (!manual()) return;
    boost = 3;
  });
  button('events', 'Part break (duck)', () => manual()?.duck(0.5, 0.6));
  button('events', 'Wreck (4 s, then respawn)', () => {
    const m = manual();
    if (!m) return;
    m.wreckHit();
    setTimeout(() => m === music && m.resume(), 4000);
  });
  for (const pos of [1, 2, 6]) button('finish', `Finish P${pos}`, () => manual()?.sting(pos));
  button('finish', 'Back to play', () => {
    const m = manual();
    if (!m) return;
    m.mode = 'play';
    m.drop();
  });

  let boost = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    iv.textContent = Number(slider.value).toFixed(2);
    if (live) {
      live.race.update(dt);
      live.director.update(dt);
      const d = live.director;
      const p = live.race.player;
      const f = (x: number) => x.toFixed(2);
      const pt = d.parts;
      out.textContent =
        `phase ${live.race.phase}  t ${live.race.time.toFixed(1)}  P${p.position}  ${(p.progress / live.race.track.raceLength * 100).toFixed(0)}%  v ${p.state.v.toFixed(0)}\n` +
        `intensity ${f(d.intensity)} -> ${f(d.target)}  mode ${d.music?.mode}\n` +
        `base ${f(pt.base)} speed ${f(pt.speed)} boost ${f(pt.boost)} position ${f(pt.position)} battle ${f(pt.battle)} air ${f(pt.air)} edge ${f(pt.edge)} finale ${f(pt.finale)} tension ${f(pt.tension)}`;
      slider.value = String(d.intensity);
    } else if (music) {
      boost = Math.max(0, boost - dt);
      music.intensity = Math.min(1, Number(slider.value) + (boost > 0 ? 0.2 : 0));
      music.tension = Number(tension.value);
      music.pump();
      out.textContent = `manual  intensity ${music.intensity.toFixed(2)}  mode ${music.mode}  air ${music.air}  edge ${music.edge}  finale ${music.finale}`;
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    stop();
  };
}
