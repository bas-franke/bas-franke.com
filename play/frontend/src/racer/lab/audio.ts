// Lab: the race soundscape without the renderer.
//   /race/lab/audio?track=redrock&secs=24
// "Live" runs an autopilot race (listener = a chase-camera spot behind the player) through RaceAudio on the shared
// context, with buttons for every cue and for the menu sounds. "Render offline" runs the same race faster than real
// time into an OfflineAudioContext and prints peak / RMS per second (dBFS) to the page and the console, so levels can
// be checked without listening (headless screenshots cannot hear). `window.__audioLab` holds the last report.

import * as THREE from 'three';
import { quickRaceRacers, playerRacer, newCareer } from '../core/career';
import { Race } from '../core/race';
import { trackById } from '../core/tracks';
import { menuAudio } from '../audio/menu';
import { RaceAudio } from '../audio/sound';

const CHASE_BACK = 13;
const CHASE_UP = 4;

function makeRace(trackId: string, events: ConstructorParameters<typeof Race>[2] = {}) {
  const racers = quickRaceRacers(playerRacer(newCareer()));
  const race = new Race(trackById(trackId), racers, events);
  race.autopilot = true;
  return race;
}

function chase(race: Race, out: THREE.Vector3) {
  const st = race.player.state;
  const f = race.track.frameAt(st.s);
  return race.track.toWorld(st.s, st.x, 1.5, out).addScaledVector(f.tangent, -CHASE_BACK).addScaledVector(f.up, CHASE_UP);
}

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const trackId = p.get('track') ?? 'redrock';
  const secs = Math.round(Number(p.get('secs') ?? 24));
  el.style.cssText = 'position:absolute;inset:0;overflow:auto;background:#1b1410;color:#f3e2c8;font:14px/1.5 system-ui;padding:16px';
  el.innerHTML = `
    <h2 style="margin:0 0 8px">Race audio lab: ${trackId}</h2>
    <div data-row="live"></div>
    <div data-row="cues" style="margin-top:8px"></div>
    <div data-row="menu" style="margin-top:8px"></div>
    <pre data-out style="margin-top:12px;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap"></pre>`;
  const out = el.querySelector('[data-out]') as HTMLElement;
  const row = (name: string) => el.querySelector(`[data-row="${name}"]`) as HTMLElement;
  const button = (r: string, label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:0 6px 6px 0;padding:6px 10px;background:#3a2a1e;color:inherit;border:1px solid #a86;border-radius:4px;cursor:pointer';
    b.onclick = fn;
    row(r).appendChild(b);
    return b;
  };
  const log = (s: string) => {
    out.textContent += s + '\n';
    console.log(s);
  };

  // ---- live -------------------------------------------------------------------------------------------------------
  let live: { race: Race; audio: RaceAudio; raf: number } | null = null;
  const lis = new THREE.Vector3();
  const stopLive = () => {
    if (!live) return;
    cancelAnimationFrame(live.raf);
    live.audio.dispose();
    live = null;
  };
  button('live', 'Live race (from grid)', () => {
    stopLive();
    let audio: RaceAudio | null = null;
    const race = makeRace(trackId, {
      onCountdown: (n) => audio?.countdown(n),
      onImpact: (r, k) => audio?.impact(k, r === race.player),
      onPad: (r) => audio?.pad(r === race.player),
      onLap: (r, _t, best) => r === race.player && audio?.lap(best),
      onFinish: (r) => r === race.player && audio?.finish(r.position),
    });
    race.time = -3.2;
    audio = new RaceAudio(race);
    audio.start();
    let last = performance.now();
    const state = { race, audio, raf: 0 };
    const loop = (now: number) => {
      state.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      race.update(dt);
      audio!.update(dt, chase(race, lis));
    };
    state.raf = requestAnimationFrame(loop);
    live = state;
  });
  button('live', 'Stop', stopLive);
  button('live', 'Mute toggle', () => {
    if (!live) return;
    const a = live.audio as unknown as { muted: boolean };
    live.audio.setMuted(!a.muted);
  });
  button('live', `Render ${secs}s offline + levels`, () => void renderOffline());

  button('cues', 'Countdown 3', () => live?.audio.countdown(3));
  button('cues', 'GO', () => live?.audio.countdown(0));
  button('cues', 'Pad', () => live?.audio.pad(true));
  button('cues', 'Impact 0.2', () => live?.audio.impact(0.2, true));
  button('cues', 'Impact 0.9', () => live?.audio.impact(0.9, true));
  button('cues', 'Lap', () => live?.audio.lap(false));
  button('cues', 'Best lap', () => {
    if (!live) return;
    live.race.player.lap = Math.max(2, live.race.player.lap);
    live.audio.lap(true);
  });
  for (const pos of [1, 2, 5]) button('cues', `Finish P${pos}`, () => live?.audio.finish(pos));

  button('menu', 'hover', () => menuAudio.hover());
  button('menu', 'select', () => menuAudio.select());
  button('menu', 'back', () => menuAudio.back());
  button('menu', 'purchase', () => menuAudio.purchase());
  button('menu', 'error', () => menuAudio.error());
  button('menu', 'ambient on', () => menuAudio.startAmbient());
  button('menu', 'ambient off', () => menuAudio.stopAmbient());

  // ---- offline ----------------------------------------------------------------------------------------------------
  let played: AudioBufferSourceNode | null = null;
  async function renderOffline() {
    const sr = 44100;
    const ctx = new OfflineAudioContext(2, sr * secs, sr);
    let audio: RaceAudio | null = null;
    const race = makeRace(trackId, {
      onCountdown: (n) => audio?.countdown(n),
      onImpact: (r, k) => audio?.impact(k, r === race.player),
      onPad: (r) => audio?.pad(r === race.player),
      onLap: (r, _t, best) => r === race.player && audio?.lap(best),
    });
    race.time = -3.2;
    const mix: Record<string, number> = {};
    // ?solo=engine,cues mutes every other bus.
    const solo = p.get('solo')?.split(',');
    if (solo) for (const b of ['engine', 'rivals', 'ambience', 'cues']) mix[b] = solo.includes(b) ? 1 : 0;
    audio = new RaceAudio(race, { context: ctx, voices: 3, mix });
    const a = audio;
    const dt = 1 / 30;
    const marks: string[] = [];
    // Scripted cues on top of the race, to hear them in context.
    const script: [number, string, () => void][] = [
      [9, 'wall hit 0.8', () => a.impact(0.8, true)],
      [12, 'pad', () => a.pad(true)],
      [15, 'lap (best)', () => ((race.player.lap = 2), a.lap(true))],
      [secs - 4, 'finish P1', () => a.finish(1)],
    ];
    const t0 = performance.now();
    let cpu = 0;
    for (let i = 1; i < secs / dt; i++) {
      const at = i * dt;
      void ctx.suspend(at).then(() => {
        const c0 = performance.now();
        race.update(dt);
        a.update(dt, chase(race, lis));
        for (const s of script) {
          if (at - dt < s[0] - 1e-6 && at >= s[0] - 1e-6) {
            s[2]();
            marks.push(`${s[0]}s ${s[1]}`);
          }
        }
        cpu += performance.now() - c0;
        void ctx.resume();
      });
    }
    log(`rendering ${secs}s on ${trackId}...`);
    const buf = await ctx.startRendering();
    a.dispose();
    const wall = performance.now() - t0;
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const lines: string[] = [];
    let peak = 0;
    let sum = 0;
    for (let s = 0; s < secs; s++) {
      let pk = 0;
      let sq = 0;
      const a0 = s * sr;
      const a1 = Math.min(L.length, a0 + sr);
      for (let j = a0; j < a1; j++) {
        const m = Math.max(Math.abs(L[j]), Math.abs(R[j]));
        if (m > pk) pk = m;
        sq += (L[j] * L[j] + R[j] * R[j]) / 2;
      }
      sum += sq;
      peak = Math.max(peak, pk);
      const rms = Math.sqrt(sq / (a1 - a0));
      lines.push(`${String(s).padStart(3)}s  peak ${db(pk).toFixed(1).padStart(6)} dB  rms ${db(rms).toFixed(1).padStart(6)} dB  ${'#'.repeat(Math.max(0, Math.round(40 + db(rms))))}`);
    }
    const rms = Math.sqrt(sum / L.length);
    const report = {
      track: trackId,
      peakDb: +db(peak).toFixed(2),
      rmsDb: +db(rms).toFixed(2),
      clipped: peak >= 1,
      speedEnd: Math.round(race.player.state.v * 7.2),
      cpuMsPerFrame: +(cpu / (secs / dt)).toFixed(3),
      renderMs: Math.round(wall),
      marks,
    };
    lines.forEach((l) => log(l));
    log(`overall peak ${report.peakDb} dB, rms ${report.rmsDb} dB, clipped ${report.clipped}, cpu ${report.cpuMsPerFrame} ms/update, render ${report.renderMs} ms`);
    log(`cues: ${marks.join(', ')}`);
    (window as unknown as { __audioLab: unknown }).__audioLab = { report, lines };
    // Offer playback of the render.
    button('live', 'Play render', () => {
      played?.stop();
      const ctxLive = new AudioContext();
      const src = ctxLive.createBufferSource();
      src.buffer = buf;
      src.connect(ctxLive.destination);
      src.start();
      src.onended = () => void ctxLive.close();
      played = src;
    });
  }

  if (p.has('offline')) void renderOffline();

  return () => {
    stopLive();
    played?.stop();
    menuAudio.stopAmbient();
    el.innerHTML = '';
  };
}
