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

/** Runs `python -m stonks_lab.live <cmd>` with `input` as JSON on stdin and returns its JSON answer. */
export function runLab<T>(cmd: 'describe' | 'prepare' | 'targets', input: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
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

let preparing: Promise<unknown> | null = null;

/**
 * Downloads the candle history `spec` needs in the background (minutes for intraday intervals over many coins).
 * One at a time; the lab also holds a lock, so a second bot process cannot download the same files.
 */
export function preparePy(spec: unknown, onDone: (err: Error | null) => void) {
  if (preparing) return;
  preparing = runLab('prepare', { spec }, 6 * 3600_000).then(
    () => onDone(null),
    (err: Error) => onDone(err),
  ).finally(() => {
    preparing = null;
  });
}
