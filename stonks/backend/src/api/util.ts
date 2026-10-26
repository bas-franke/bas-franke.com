import type { Request } from 'express';

/** A bad request: the router turns it into a 400 with this message. */
export class ValidationError extends Error {}

export const fail = (message: string): never => {
  throw new ValidationError(message);
};

/** pg returns numeric/bigint columns as strings. */
export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

const single = (req: Request, name: string): string | undefined => {
  const v = (req.query as Record<string, unknown>)[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') fail(`${name} must be given once`);
  return v as string;
};

/** Optional positive integer query parameter (ids, limits, days). */
export function intParam(req: Request, name: string, min: number, max: number): number | undefined {
  const v = single(req, name);
  if (v === undefined) return undefined;
  if (!/^\d{1,15}$/.test(v)) fail(`${name} must be a whole number`);
  const n = Number(v);
  if (n < min || n > max) fail(`${name} must be between ${min} and ${max}`);
  return n;
}

export function enumParam<T extends string>(req: Request, name: string, values: readonly T[]): T | undefined {
  const v = single(req, name);
  if (v === undefined) return undefined;
  if (!values.includes(v as T)) fail(`${name} must be one of ${values.join(', ')}`);
  return v as T;
}

export function patternParam(req: Request, name: string, re: RegExp): string | undefined {
  const v = single(req, name);
  if (v === undefined) return undefined;
  if (!re.test(v)) fail(`${name} is not valid`);
  return v;
}

export const MODES = ['paper', 'live'] as const;
export const MARKET_RE = /^[A-Z0-9]{1,15}-[A-Z]{2,6}$/;
export const MAX_LIMIT = 500;
