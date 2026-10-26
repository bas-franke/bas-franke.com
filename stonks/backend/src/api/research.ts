import { Router } from 'express';
import type { ApiDeps } from './deps.js';
import { fail, iso, num } from './util.js';

// Research lab uploads (SPEC.md §7 "Research payload"). The payload is validated and rebuilt from known fields,
// so the dashboard only ever renders the documented shape. v2 adds per-timeframe `buckets` (§8). The newest KEEP rows are kept.

const KEEP = 200;
const MAX_TOP_POINTS = 1000; // SPEC says ≤ 400; a little slack so a slightly long curve does not fail the upload
const MAX_BENCHMARK_POINTS = 5000; // daily candles since 2019 are ~2900
const MAX_SPEC_JSON = 20_000;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: unknown, path: string): Json {
  if (!isObj(v)) fail(`${path} must be an object`);
  return v as Json;
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') fail(`${path} must be a string`);
  if ((v as string).length > max) fail(`${path} is longer than ${max} characters`);
  return v as string;
}

const optStr = (v: unknown, path: string, max: number) => (v === undefined || v === null ? null : str(v, path, max));

function finite(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path} must be a number`);
  return v as number;
}

function strArray(v: unknown, path: string, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) fail(`${path} must be an array`);
  const a = v as unknown[];
  if (a.length > maxItems) fail(`${path} has more than ${maxItems} items`);
  return a.map((s, i) => str(s, `${path}[${i}]`, maxLen));
}

function range(v: unknown, path: string): [string, string] {
  const a = strArray(v, path, 2, 40);
  if (a.length !== 2) fail(`${path} must be [from, to]`);
  return [a[0], a[1]];
}

function points(v: unknown, path: string, max: number): [number, number][] {
  if (!Array.isArray(v)) fail(`${path} must be an array of [t, eur]`);
  const a = v as unknown[];
  if (a.length > max) fail(`${path} has more than ${max} points`);
  return a.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) fail(`${path}[${i}] must be [t, eur]`);
    const [t, eur] = p as unknown[];
    return [finite(t, `${path}[${i}][0]`), finite(eur, `${path}[${i}][1]`)];
  });
}

/** Flat map of primitive values (metrics, lineage): numbers, null, short strings, or short arrays of those. */
function flat(v: unknown, path: string, maxKeys: number) {
  const o = obj(v, path);
  const keys = Object.keys(o);
  if (keys.length > maxKeys) fail(`${path} has more than ${maxKeys} keys`);
  const out: Json = {};
  for (const k of keys) {
    if (k.length > 60) fail(`${path} has a key longer than 60 characters`);
    if (k === '__proto__') fail(`${path} has a forbidden key`); // would set the copy's prototype instead
    const x = o[k];
    const ok = (y: unknown) =>
      y === null ||
      typeof y === 'boolean' ||
      (typeof y === 'number' && Number.isFinite(y)) ||
      (typeof y === 'string' && y.length <= 300);
    if (!(ok(x) || (Array.isArray(x) && x.length <= 10 && x.every(ok)))) fail(`${path}.${k} has an unsupported value`);
    out[k] = x;
  }
  return out;
}

function benchmark(v: unknown, path: string) {
  const b = obj(v, path);
  return {
    name: str(b.name, `${path}.name`, 200),
    returnPct: finite(b.returnPct, `${path}.returnPct`),
    maxDrawdownPct: finite(b.maxDrawdownPct, `${path}.maxDrawdownPct`),
    equity: points(b.equity, `${path}.equity`, MAX_BENCHMARK_POINTS),
  };
}

function spec(v: unknown, path: string) {
  const s = obj(v, path);
  str(s.id, `${path}.id`, 200);
  str(s.name, `${path}.name`, 200);
  str(s.family, `${path}.family`, 100);
  strArray(s.markets, `${path}.markets`, 50, 30);
  str(s.interval, `${path}.interval`, 10);
  if (JSON.stringify(s).length > MAX_SPEC_JSON) fail(`${path} is too large`);
  return s; // any further keys are the family's business; plain parsed JSON, size-limited
}

function entry(v: unknown, path: string) {
  const e = obj(v, path);
  const rank = finite(e.rank, `${path}.rank`);
  if (!Number.isInteger(rank) || rank < 1 || rank > 5) fail(`${path}.rank must be 1 to 5`);
  if (typeof e.botReady !== 'boolean') fail(`${path}.botReady must be true or false`);
  const x = obj(e.explanation, `${path}.explanation`);
  return {
    rank,
    spec: spec(e.spec, `${path}.spec`),
    botReady: e.botReady as boolean,
    metrics: flat(e.metrics, `${path}.metrics`, 60),
    equity: points(e.equity, `${path}.equity`, MAX_TOP_POINTS),
    buyHoldEquity: e.buyHoldEquity === undefined ? [] : points(e.buyHoldEquity, `${path}.buyHoldEquity`, MAX_TOP_POINTS),
    explanation: {
      summary: str(x.summary, `${path}.explanation.summary`, 2000),
      howItWorks: x.howItWorks === undefined ? [] : strArray(x.howItWorks, `${path}.explanation.howItWorks`, 20, 1000),
      whenItWins: optStr(x.whenItWins, `${path}.explanation.whenItWins`, 2000),
      whenItLoses: optStr(x.whenItLoses, `${path}.explanation.whenItLoses`, 2000),
      vsBuyHold: optStr(x.vsBuyHold, `${path}.explanation.vsBuyHold`, 2000),
    },
    lineage: e.lineage === undefined || e.lineage === null ? null : flat(e.lineage, `${path}.lineage`, 20),
  };
}

/** A ranked list of 0..5 (min given) entries, unique ranks, rank 1 first. */
function topList(v: unknown, path: string, min: number) {
  if (!Array.isArray(v) || v.length < min || v.length > 5) fail(`${path} must have ${min} to 5 entries`);
  const top = (v as unknown[]).map((e, i) => entry(e, `${path}[${i}]`));
  if (new Set(top.map((t) => t.rank)).size !== top.length) fail(`${path} ranks must be unique`);
  return top.sort((a, b) => a.rank - b.rank);
}

/** Timeframe buckets (SPEC.md §8), in display order. */
export const BUCKETS = ['minute', 'hourly', 'daily', 'weekly'] as const;
export type Bucket = (typeof BUCKETS)[number];

const optFinite = (v: unknown, path: string) => (v === undefined || v === null ? null : finite(v, path));

function bucket(v: unknown, path: string) {
  const b = obj(v, path);
  return {
    label: optStr(b.label, `${path}.label`, 100) ?? '',
    intervals: b.intervals === undefined ? [] : strArray(b.intervals, `${path}.intervals`, 12, 10),
    profile: b.profile === undefined || b.profile === null ? null : flat(b.profile, `${path}.profile`, 20),
    holdScore: optFinite(b.holdScore, `${path}.holdScore`),
    luckLine: b.luckLine === undefined || b.luckLine === null ? null : flat(b.luckLine, `${path}.luckLine`, 20),
    benchmark: b.benchmark === undefined || b.benchmark === null ? null : benchmark(b.benchmark, `${path}.benchmark`),
    notes: optStr(b.notes, `${path}.notes`, 4000) ?? '',
    top: topList(b.top ?? [], `${path}.top`, 0),
  };
}

/** Validates a research upload and returns the cleaned copy that gets stored. Throws ValidationError. */
export function validateResearch(body: unknown) {
  const p = obj(body, 'payload');
  const generatedAt = str(p.generatedAt, 'generatedAt', 40);
  if (Number.isNaN(Date.parse(generatedAt))) fail('generatedAt must be an ISO date');
  const s = obj(p.summary, 'summary');
  // v2 (SPEC §8): `buckets` per timeframe; `top` stays (= the daily bucket) and may then be empty.
  let buckets: Partial<Record<Bucket, ReturnType<typeof bucket>>> | undefined;
  if (p.buckets !== undefined) {
    const raw = obj(p.buckets, 'buckets');
    buckets = {};
    for (const k of BUCKETS) if (raw[k] !== undefined && raw[k] !== null) buckets[k] = bucket(raw[k], `buckets.${k}`);
    if (!Object.keys(buckets).length) fail(`buckets must contain at least one of ${BUCKETS.join(', ')}`);
  }
  const top = topList(p.top ?? (buckets ? [] : undefined), 'top', buckets ? 0 : 1);
  const benchmarks = p.benchmarks === undefined ? [] : p.benchmarks;
  if (!Array.isArray(benchmarks) || benchmarks.length > 10) fail('benchmarks must be an array of at most 10');
  return {
    generatedAt,
    summary: {
      experiments: finite(s.experiments, 'summary.experiments'),
      families: finite(s.families, 'summary.families'),
      rounds: finite(s.rounds, 'summary.rounds'),
      dataRange: range(s.dataRange, 'summary.dataRange'),
      notes: optStr(s.notes, 'summary.notes', 4000) ?? '',
    },
    benchmark: benchmark(p.benchmark, 'benchmark'),
    benchmarks: (benchmarks as unknown[]).map((b, i) => benchmark(b, `benchmarks[${i}]`)),
    top,
    ...(buckets ? { buckets } : {}),
  };
}

function researchCount(p: ReturnType<typeof validateResearch>) {
  return p.buckets ? Object.values(p.buckets).reduce((n, b) => n + (b?.top.length ?? 0), 0) : p.top.length;
}

export function researchRoutes(deps: ApiDeps) {
  const r = Router();

  r.get('/research', async (_req, res) => {
    const { rows } = await deps.query(
      'SELECT id, created_at, payload FROM research_snapshots ORDER BY id DESC LIMIT 1',
    );
    if (!rows.length) {
      res.json({ empty: true });
      return;
    }
    res.json({ ...rows[0].payload, id: num(rows[0].id), createdAt: iso(rows[0].created_at) });
  });

  r.post('/research', async (req, res) => {
    const payload = validateResearch(req.body);
    const { rows } = await deps.query('INSERT INTO research_snapshots (payload) VALUES ($1) RETURNING id', [
      JSON.stringify(payload),
    ]);
    await deps.query(
      `DELETE FROM research_snapshots WHERE id NOT IN (SELECT id FROM research_snapshots ORDER BY id DESC LIMIT ${KEEP})`,
    );
    const id = num(rows[0].id);
    await deps.log('info', 'research_upload', `research snapshot ${id} uploaded (${researchCount(payload)} strategies)`, {
      id,
      generatedAt: payload.generatedAt,
    });
    res.json({ ok: true, id });
  });

  return r;
}
