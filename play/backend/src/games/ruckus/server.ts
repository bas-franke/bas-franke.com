// Ruckus: a round-based party game. Each round picks a minigame; pawns move with shared physics, the server
// resolves pawn-vs-pawn contact and the minigame rules, and placements turn into points.

import { clamp, rng as makeRng, shuffle, toTuple } from '../../shared/math.js';
import type { GameClientMsg } from '../../shared/protocol.js';
import { RU } from '../../shared/ruckus/constants.js';
import type { PawnSnap, Phase, RuckusEvent, RuckusScore } from '../../shared/ruckus/protocol.js';
import { MINIGAME_IDS, MINIGAMES, type MinigameId, type RuckusInput, newPawn, stepPawn } from '../../shared/ruckus/world.js';
import type { GameHost, GamePlayer, GameServer } from '../types.js';
import { BOT_PARAMS, RuckusBot } from './bots.js';
import { CoinRush } from './minigames/coins.js';
import { HotPotato } from './minigames/hotpotato.js';
import { FloorIsLava } from './minigames/lava.js';
import { Sumo } from './minigames/sumo.js';
import { Sweeper } from './minigames/sweeper.js';
import type { Minigame, MinigameContext, MPawn } from './minigames/types.js';

interface Participant extends GamePlayer, MPawn {
  points: number;
  last: number;
  lastSeq: number;
  queue: RuckusInput[];
  lastInputAt: number;
  /** Joined mid-round: watches until the next round starts. */
  spectating: boolean;
  brain?: RuckusBot;
}

const factories: Record<MinigameId, () => Minigame> = {
  hotpotato: () => new HotPotato(),
  lava: () => new FloorIsLava(),
  coins: () => new CoinRush(),
  sweeper: () => new Sweeper(),
  sumo: () => new Sumo(),
};

const IDLE: RuckusInput = { seq: 0, mx: 0, mz: 0, dash: false };

class RuckusGame implements GameServer {
  private readonly players = new Map<string, Participant>();
  private readonly rounds = RU.roundsDefault;
  private round = 0;
  private order: MinigameId[] = [];
  private mg!: Minigame;
  private phase: Phase = 'intro';
  private phaseEndsAt = 0;
  private playStart = 0;
  private now = 0;
  private tick = 0;
  private ended = false;
  private events: RuckusEvent[] = [];
  private timer?: NodeJS.Timeout;
  private readonly rng = makeRng((Date.now() ^ 0x51ed270b) >>> 0);
  private readonly contacts = new Map<string, number>();
  private readonly ctx: MinigameContext;

  constructor(private readonly host: GameHost) {
    this.ctx = {
      now: 0,
      pawns: [],
      alive: () => this.ctx.pawns.filter((p) => !p.out),
      eliminate: (p) => this.eliminate(p as Participant),
      emit: (e) => this.events.push(e),
      rng: this.rng,
    };
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------

  start() {
    for (const p of this.host.players()) this.addPlayer(p);
    this.order = shuffle(this.rng, MINIGAME_IDS);
    this.beginRound(1);
    this.timer = setInterval(() => this.loop(), 1000 / RU.loopHz);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  addPlayer(p: GamePlayer) {
    if (this.players.has(p.id)) return;
    const part: Participant = {
      ...p,
      body: newPawn(0, 0),
      out: true,
      outAt: -1,
      score: 0,
      points: 0,
      last: 0,
      lastSeq: 0,
      queue: [],
      lastInputAt: 0,
      spectating: this.round > 0,
    };
    if (p.bot) part.brain = new RuckusBot(BOT_PARAMS[this.host.botDifficulty()], makeRng(Math.floor(this.rng() * 1e9)));
    this.players.set(p.id, part);
    // Everyone gets the refreshed standings so the newcomer shows up in the points list straight away.
    this.host.broadcast({ k: 'init', rounds: this.rounds, scores: this.scores() });
    if (this.round > 0) {
      this.host.send(p.id, {
        k: 'round',
        round: this.round,
        rounds: this.rounds,
        mg: this.mg.id,
        layout: this.mg.layout,
        world: this.mg.world,
        left: this.phaseLeft(),
      });
      this.host.send(p.id, { k: 'phase', phase: this.phase, left: this.phaseLeft() });
    }
  }

  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.ctx.pawns = this.ctx.pawns.filter((x) => x !== p);
  }

  onMessage(id: string, m: GameClientMsg) {
    const p = this.players.get(id);
    if (!p || p.bot || m.k !== 'in' || !Array.isArray(m.i)) return;
    for (const raw of m.i as Partial<RuckusInput>[]) {
      if (!raw || typeof raw !== 'object') continue;
      const input: RuckusInput = {
        seq: Number(raw.seq) || 0,
        mx: clamp(Number(raw.mx) || 0, -1, 1),
        mz: clamp(Number(raw.mz) || 0, -1, 1),
        dash: !!raw.dash,
      };
      if (input.seq <= p.lastSeq) continue;
      p.queue.push(input);
    }
    if (p.queue.length > 30) p.queue.splice(0, p.queue.length - 30);
  }

  // ---- rounds -------------------------------------------------------------------------------------------------

  private beginRound(n: number) {
    this.round = n;
    const id = this.order[(n - 1) % this.order.length];
    this.mg = factories[id]();
    const participants = [...this.players.values()];
    const spawns = this.mg.spawns(participants.length);
    participants.forEach((p, i) => {
      p.spectating = false;
      p.body = newPawn(spawns[i].x, spawns[i].z);
      p.body.yaw = Math.atan2(spawns[i].x, spawns[i].z) + Math.PI; // face the centre
      p.out = false;
      p.outAt = -1;
      p.score = 0;
      p.queue = [];
      // A fresh brain per round: no held input or decision timer survives into the next minigame.
      if (p.bot) p.brain = new RuckusBot(BOT_PARAMS[this.host.botDifficulty()], makeRng(Math.floor(this.rng() * 1e9)));
    });
    this.ctx.pawns = participants;
    this.contacts.clear();
    this.setPhase('intro', RU.introSeconds);
    this.host.broadcast({ k: 'round', round: n, rounds: this.rounds, mg: id, layout: this.mg.layout, world: this.mg.world, left: RU.introSeconds });
  }

  private setPhase(phase: Phase, seconds: number, extra: { placements?: string[]; scores?: RuckusScore[] } = {}) {
    this.phase = phase;
    this.phaseEndsAt = this.now + seconds;
    if (phase === 'play') {
      this.playStart = this.now;
      this.ctx.now = 0;
      this.mg.begin?.(this.ctx);
    }
    this.host.broadcast({ k: 'phase', phase, left: seconds, ...extra });
  }

  private phaseLeft() {
    return Math.max(0, this.phaseEndsAt - this.now);
  }

  private finishRound() {
    const tiers = this.mg.placements(this.ctx);
    const placements: string[] = [];
    let rank = 0;
    for (const tier of tiers) {
      const pts = RU.placementPoints[Math.min(rank, RU.placementPoints.length - 1)];
      for (const id of tier) {
        const p = this.players.get(id);
        if (p) {
          p.points += pts;
          p.last = pts;
        }
        placements.push(id);
      }
      rank += tier.length;
    }
    for (const p of this.players.values()) if (!placements.includes(p.id)) p.last = 0;
    this.setPhase('results', RU.resultsSeconds, { placements, scores: this.scores() });
  }

  private endMatch() {
    if (this.ended) return;
    this.ended = true;
    const scores = this.scores().sort((a, b) => b.points - a.points);
    const tie = scores.length > 1 && scores[0].points === scores[1].points;
    this.setPhase('final', RU.finalSeconds, { scores });
    this.host.broadcast({ k: 'end', scores, winner: scores[0] && !tie ? scores[0].id : null });
    this.host.matchEnded();
  }

  private eliminate(p: Participant) {
    if (p.out) return;
    p.out = true;
    p.outAt = this.ctx.now;
    this.events.push({ k: 'out', id: p.id });
  }

  // ---- loop ---------------------------------------------------------------------------------------------------

  private lastLoop = performance.now();
  private acc = 0;

  /** Advances the simulation by however much wall-clock time passed (timers are not exact), in fixed sub-steps. */
  private loop() {
    const nowMs = performance.now();
    this.acc += Math.min(0.25, (nowMs - this.lastLoop) / 1000);
    this.lastLoop = nowMs;
    let substeps = 0;
    while (this.acc >= RU.dt - 1e-9 && substeps < 10) {
      this.acc -= RU.dt;
      substeps++;
      this.now += RU.dt;
      this.tick++;
      if (this.phase === 'play') {
        this.ctx.now = this.now - this.playStart;
        this.simulateStep();
      }
    }
    if (substeps === 0) return;
    if (this.phase === 'play') {
      for (const p of this.ctx.pawns as Participant[]) {
        if (p.brain || p.out) continue;
        let n = 0;
        const limit = Math.max(RU.maxCommandsPerLoop, substeps * 3);
        while (p.queue.length && n < limit) {
          this.applyInput(p, p.queue.shift()!);
          p.lastInputAt = this.now;
          n++;
        }
        if (n === 0 && this.now - p.lastInputAt > 0.15) for (let i = 0; i < substeps; i++) this.applyInput(p, IDLE, true);
      }
      this.resolveContacts();
      const timeUp = this.ctx.now >= MINIGAMES[this.mg.id].seconds;
      if (timeUp || this.mg.isOver(this.ctx)) this.finishRound();
    } else if (this.now >= this.phaseEndsAt && !this.ended) {
      if (this.phase === 'intro') this.setPhase('play', MINIGAMES[this.mg.id].seconds);
      else if (this.phase === 'results') {
        if (this.round >= this.rounds) this.endMatch();
        else this.beginRound(this.round + 1);
      }
    } else if (this.ended && this.now >= this.phaseEndsAt) {
      this.stop();
    }
    // Drain stale inputs sent outside the play phase so seq numbers keep advancing.
    if (this.phase !== 'play') {
      for (const p of this.players.values()) {
        if (p.queue.length) p.lastSeq = p.queue[p.queue.length - 1].seq;
        p.queue = [];
      }
    }
    this.flush();
  }

  private simulateStep() {
    for (const p of this.ctx.pawns as Participant[]) {
      if (p.out) continue;
      // Bots get absolute sim time: their decision timers must not jump when the round clock resets.
      if (p.brain) this.applyInput(p, p.brain.think({ now: this.now, self: p, others: this.ctx.alive().filter((o) => o !== p), layout: this.mg.layout, world: this.mg.world, mg: this.mg.id }));
    }
    this.mg.step(RU.dt, this.ctx);
  }

  private applyInput(p: Participant, input: RuckusInput, idle = false) {
    if (!idle) p.lastSeq = input.seq;
    if (p.out) return;
    const res = stepPawn(p.body, input, this.mg.layout, this.mg.world);
    if (res.dashed) this.events.push({ k: 'dash', id: p.id });
    this.mg.afterPawnStep?.(p, this.ctx);
    if (p.body.pos.y < RU.killY) this.eliminate(p);
  }

  /** Pawns push each other; a dash shoves hard and ends the dash. */
  private resolveContacts() {
    const alive = this.ctx.alive() as Participant[];
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (Math.abs(a.body.pos.y - b.body.pos.y) > RU.height) continue;
        let dx = b.body.pos.x - a.body.pos.x;
        let dz = b.body.pos.z - a.body.pos.z;
        let d = Math.hypot(dx, dz);
        const minD = RU.radius * 2;
        if (d >= minD) continue;
        if (d < 1e-4) {
          const ang = this.rng() * Math.PI * 2;
          dx = Math.cos(ang);
          dz = Math.sin(ang);
          d = 1;
        }
        const nx = dx / d;
        const nz = dz / d;
        const push = (minD - d) / 2;
        a.body.pos.x -= nx * push;
        a.body.pos.z -= nz * push;
        b.body.pos.x += nx * push;
        b.body.pos.z += nz * push;

        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const last = this.contacts.get(key) ?? -10;
        const fresh = this.now - last > 0.3;
        const aDash = a.body.dashT > 0;
        const bDash = b.body.dashT > 0;
        let dasher: Participant | null = null;
        if (aDash && !bDash) {
          dasher = a;
          b.body.vel.x += nx * RU.dashShove;
          b.body.vel.z += nz * RU.dashShove;
          b.body.vel.y = Math.max(b.body.vel.y, RU.dashLift);
          b.body.onGround = false;
          a.body.vel.x = -nx * 2;
          a.body.vel.z = -nz * 2;
          a.body.dashT = 0;
        } else if (bDash && !aDash) {
          dasher = b;
          a.body.vel.x -= nx * RU.dashShove;
          a.body.vel.z -= nz * RU.dashShove;
          a.body.vel.y = Math.max(a.body.vel.y, RU.dashLift);
          a.body.onGround = false;
          b.body.vel.x = nx * 2;
          b.body.vel.z = nz * 2;
          b.body.dashT = 0;
        } else if (aDash && bDash) {
          a.body.vel.x -= nx * RU.dashShove * 0.6;
          a.body.vel.z -= nz * RU.dashShove * 0.6;
          b.body.vel.x += nx * RU.dashShove * 0.6;
          b.body.vel.z += nz * RU.dashShove * 0.6;
          a.body.dashT = b.body.dashT = 0;
        } else {
          a.body.vel.x -= nx * RU.contactShove * 0.5;
          a.body.vel.z -= nz * RU.contactShove * 0.5;
          b.body.vel.x += nx * RU.contactShove * 0.5;
          b.body.vel.z += nz * RU.contactShove * 0.5;
        }
        if (fresh) {
          this.contacts.set(key, this.now);
          if (dasher) this.events.push({ k: 'shove', id: dasher === a ? b.id : a.id, by: dasher.id });
          this.mg.onContact?.(a, b, dasher, this.ctx);
        }
      }
    }
  }

  // ---- output -------------------------------------------------------------------------------------------------

  private scores(): RuckusScore[] {
    return [...this.players.values()].map((p) => ({ id: p.id, points: p.points, last: p.last }));
  }

  private flush() {
    if (this.events.length) {
      this.host.broadcast({ k: 'ev', e: this.events });
      this.events = [];
    }
    if (this.round === 0) return;
    const pawns: PawnSnap[] = (this.ctx.pawns as Participant[]).map((p) => ({
      id: p.id,
      p: toTuple(p.body.pos),
      v: toTuple(p.body.vel),
      y: Math.round(p.body.yaw * 1000) / 1000,
      g: p.body.onGround ? 1 : 0,
      out: p.out ? 1 : 0,
      dt: Math.round(p.body.dashT * 1000) / 1000,
      cd: Math.round(p.body.dashCd * 100) / 100,
      st: Math.round(p.body.stun * 100) / 100,
      sc: p.score,
    }));
    const base = { tick: this.tick, t: Date.now(), phase: this.phase, left: Math.round(this.phaseLeft() * 10) / 10, world: this.mg.world };
    for (const p of this.players.values()) {
      if (p.bot) continue;
      const mine = pawns.map((s) => (s.id === p.id ? { ...s, seq: p.lastSeq } : s));
      this.host.send(p.id, { k: 'snap', s: { ...base, pawns: mine } });
    }
  }
}

export function createRuckusGame(host: GameHost): GameServer {
  return new RuckusGame(host);
}
