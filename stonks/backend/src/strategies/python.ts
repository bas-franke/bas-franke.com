import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Weights } from './types.js';

// The lab's own family code, run on the server for every family without a TypeScript port (SPEC.md §6b). The
// deploy ships stonks_lab's families plus `stonks_lab/live.py` and writes `catalog.json` next to them; the bot only
// ever asks it for the weights at the bar that just closed, never for backtests or research.

export interface PyParam {
  name: string;
  type: 'int' | 'number' | 'boolean' | 'choice';
  default: number | boolean | string;
  min?: number;
  max?: number;
  /** 0 is allowed outside min..max (switches the feature off). */
  zero?: boolean;
  options?: Array<number | string>;
  description: string;
}

export interface PyFamily {
  family: string;
  title: string;
  summary: string;
  version: number;
  /** sha256 of the family's source and all it imports: changes when its logic can change, VERSION or not. */
  codeHash?: string;
  multiMarket: boolean;
  /** Targets depend on where trading started: the bot passes the strategy's start time. */
  anchored: boolean;
  params: PyParam[];
  /** Params that hold a JSON object, e.g. the lead a wrapper family runs (`inner`); `describe` validates them. */
  objectParams?: Array<{ name: string; default: Record<string, unknown> }>;
}

export interface PyDescription {
  error: string | null;
  /** Every market the family reads (traded plus signal-only). */
  markets: string[];
  anchored: boolean;
  explanation: string;
}

const TIMEOUT_MS = 120_000;
let catalog: Map<string, PyFamily> | null = null;

function readCatalog(): PyFamily[] {
  const file = path.join(config.labDir, 'catalog.json');
  if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { families: PyFamily[] }).families;
  // Local development: no deploy wrote it, ask the lab directly (once per process).
  if (!existsSync(path.join(config.labDir, 'stonks_lab', 'live.py'))) return [];
  const r = spawnSync(config.python, ['-m', 'stonks_lab.live', 'catalog'], { cwd: config.labDir, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    console.error(`stonks_lab.live catalog failed: ${r.error?.message ?? r.stdout ?? ''} ${r.stderr ?? ''}`.trim());
    return [];
  }
  return (JSON.parse(r.stdout) as { families: PyFamily[] }).families;
}

/** Every family the server's lab copy can run, by name. Empty when the lab is not installed. */
export function pyFamilies(): Map<string, PyFamily> {
  if (!catalog) {
    try {
      catalog = new Map(readCatalog().map((f) => [f.family, f]));
    } catch (err) {
      console.error(`cannot read the lab's family catalog: ${(err as Error).message}`);
      catalog = new Map();
    }
  }
  return catalog;
}

/** Tests: use this catalog instead of the lab's (null = read the lab again). */
export function setPyCatalog(families: PyFamily[] | null) {
  catalog = families ? new Map(families.map((f) => [f.family, f])) : null;
}

/**
 * What the code behind a family or spec hashes to on this deploy (undefined when the catalog has no hash for it). Give
 * it the spec when you have one: a wrapper runs the family in `params.inner`, which is not part of its own file.
 */
export function codeHashOf(subject: string | { family: string; params?: unknown }): string | undefined {
  const family = typeof subject === 'string' ? subject : subject.family;
  const own = pyFamilies().get(family)?.codeHash;
  const inner = typeof subject === 'string' ? undefined : (subject.params as { inner?: { family?: unknown } } | undefined)?.inner;
  if (!own || typeof inner?.family !== 'string') return own;
  const wrapped = codeHashOf(inner as { family: string; params?: unknown });
  return wrapped ? `${own}+${wrapped}` : own;
}

type LabRunner = (cmd: 'describe' | 'prepare' | 'targets', input: unknown, timeoutMs: number) => Promise<unknown>;
let labRunner: LabRunner | null = null;

/** Tests: answer lab calls with this instead of starting Python (null = Python again). */
export function setLabRunner(run: LabRunner | null) {
  labRunner = run;
}

/** The newest lab calls, for the Health page. Kept in memory: a restart starts empty. */
export const labStats = {
  lastCall: null as { at: number; cmd: string; ms: number } | null,
  lastFailure: null as { at: number; cmd: string; error: string } | null,
};

/** Runs `python -m stonks_lab.live <cmd>` with `input` as JSON on stdin and returns its JSON answer. */
export async function runLab<T>(cmd: 'describe' | 'prepare' | 'targets', input: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const started = Date.now();
  try {
    return await (labRunner ? (labRunner(cmd, input, timeoutMs) as Promise<T>) : spawnLab<T>(cmd, input, timeoutMs));
  } catch (err) {
    labStats.lastFailure = { at: Date.now(), cmd, error: err instanceof Error ? err.message : String(err) };
    throw err;
  } finally {
    labStats.lastCall = { at: started, cmd, ms: Date.now() - started };
  }
}

function spawnLab<T>(cmd: string, input: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, ['-m', 'stonks_lab.live', cmd], {
      cwd: config.labDir,
      env: { ...process.env, STONKS_DATA_DIR: config.labDataDir, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot start the lab's Python (${config.python}): ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      let answer: (T & { error?: string }) | undefined;
      try {
        answer = JSON.parse(text);
      } catch {
        answer = undefined;
      }
      if (answer?.error) return reject(new Error(answer.error));
      if (code !== 0 || !answer) {
        const why = signal ? `was stopped (${signal}) after ${timeoutMs / 1000} s` : `exited with ${code}`;
        return reject(new Error(`stonks_lab.live ${cmd} ${why}: ${Buffer.concat(err).toString('utf8').slice(-500)}`));
      }
      resolve(answer);
    });
    child.stdin.on('error', () => {}); // a crash before reading stdin shows up in 'close'
    child.stdin.end(JSON.stringify(input));
  });
}

const described = new Map<string, PyDescription>();

/** What the family needs for this spec (cached per spec: the answer only depends on it). */
export async function describePy(spec: unknown): Promise<PyDescription> {
  const key = JSON.stringify(spec);
  const hit = described.get(key);
  if (hit) return hit;
  const d = await runLab<PyDescription>('describe', { spec });
  if (described.size > 50) described.clear();
  described.set(key, d);
  return d;
}

/** The cached explanation of a spec `describePy` has seen, if any. */
export const cachedExplanation = (spec: unknown) => described.get(JSON.stringify(spec))?.explanation;

export type PyTargets = { warming: string[] } | { warming?: undefined; hold: string; t?: number | null } | { warming?: undefined; hold?: undefined; t: number | null; weights: Weights };

/**
 * Target weights decided at `bar` (open time of the last closed bar). The lab reads its own full candle history
 * (the same the backtest saw); until that has been downloaded once it answers `{ warming }` straight away.
 */
export const targetsPy = (spec: unknown, bar: number, startTime?: number) =>
  runLab<PyTargets>('targets', { spec, bar, ...(startTime !== undefined ? { startTime } : {}) });

export type PyPrepared = { busy: true } | { ready: boolean; failed?: Record<string, string> };

/** Between two tries while the lab's lock is taken: long enough not to start Python for nothing on every tick. */
export const PREPARE_BUSY_MS = 60_000;
/** After a failed prepare: 1 minute, doubling up to 30, so an outage neither floods the log nor Bitvavo. */
export const PREPARE_FAIL_MS = 60_000;
export const PREPARE_FAIL_MAX_MS = 30 * 60_000;

let preparing: Promise<unknown> | null = null;
let notBefore = 0;
let failures = 0;
let preparedSpec = '';

/** Forgets the pause after earlier prepares. */
export function resetPrepare() {
  notBefore = 0;
  failures = 0;
}

/**
 * Downloads the candle history `spec` needs in the background (minutes for intraday intervals over many coins).
 * One at a time; the lab also holds a lock, so a second bot process cannot download the same files. `onDone` only
 * fires for a real outcome: null when everything is there, an Error when something failed. A busy lab says nothing
 * about this spec, so that stays silent, and the caller's next tick (still warming) calls this again; both wait.
 */
export function preparePy(spec: unknown, onDone: (err: Error | null) => void) {
  const key = JSON.stringify(spec);
  if (key !== preparedSpec) resetPrepare(); // another strategy does not sit out this one's pause
  preparedSpec = key;
  if (preparing || Date.now() < notBefore) return;
  const failed = (err: Error) => {
    notBefore = Date.now() + Math.min(PREPARE_FAIL_MS * 2 ** failures++, PREPARE_FAIL_MAX_MS);
    onDone(err);
  };
  preparing = runLab<PyPrepared>('prepare', { spec }, 6 * 3600_000).then((answer) => {
    if ('busy' in answer) {
      notBefore = Date.now() + PREPARE_BUSY_MS;
    } else if (answer.ready) {
      resetPrepare();
      onDone(null);
    } else {
      const what = Object.entries(answer.failed ?? {}).map(([k, v]) => `${k}: ${v}`);
      failed(new Error(`not complete, tries again later (${what.join('; ').slice(0, 500) || 'no details'})`));
    }
  }, failed).finally(() => {
    preparing = null;
  });
}
