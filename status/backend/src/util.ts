import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function run(cmd: string, args: string[], timeoutMs = 5000) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** Like run(), but returns stdout even when the command exits non-zero (e.g. `systemctl is-active`). */
export async function runLoose(cmd: string, args: string[], timeoutMs = 5000) {
  try {
    return await run(cmd, args, timeoutMs);
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    if (typeof stdout === 'string') return stdout.trim();
    throw err;
  }
}

export async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Caches an async function's result for ttlMs, sharing in-flight calls. */
export function memo<T>(fn: () => Promise<T>, ttlMs: number) {
  let cached: { at: number; value: Promise<T> } | undefined;
  return () => {
    if (!cached || Date.now() - cached.at > ttlMs) {
      const value = fn();
      cached = { at: Date.now(), value };
      value.catch(() => (cached = undefined));
    }
    return cached.value;
  };
}

export function errorMessage(err: unknown) {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'Timed out';
    const code = (err as NodeJS.ErrnoException).code;
    let message = typeof code === 'string' && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
    // fetch() reports "fetch failed" and hides the real reason (DNS, TLS, refused) in `cause`.
    if (err.cause) message += `: ${errorMessage(err.cause)}`;
    return message;
  }
  return String(err);
}
