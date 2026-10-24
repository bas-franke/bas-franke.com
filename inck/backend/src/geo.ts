import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Reader, type CountryResponse } from 'maxmind';
import { config } from './config.js';

/**
 * Visitor country from the IP address, for country-specific news. Uses the free db-ip.com "IP to Country Lite"
 * database (CC BY 4.0), downloaded into the data folder and refreshed monthly; without it every visitor counts as
 * "unknown" and simply sees the global feed.
 */
const file = () => path.join(config.dataDir, 'geo', 'dbip-country-lite.mmdb');
const MAX_AGE_MS = 35 * 24 * 3600_000;

let reader: Reader<CountryResponse> | undefined;

const monthUrl = (d: Date) => `https://download.db-ip.com/free/dbip-country-lite-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.mmdb.gz`;

async function download() {
  const now = new Date();
  // The new month's file appears a day or two into the month, so fall back to last month's.
  for (const d of [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))]) {
    const res = await fetch(monthUrl(d), { signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
    if (!res?.ok) continue;
    const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(file(), bytes);
    return true;
  }
  return false;
}

/** Loads the database, downloading it first when it is missing or older than a month. Never throws. */
export async function loadGeo() {
  try {
    const age = await stat(file()).then((s) => Date.now() - s.mtimeMs, () => Infinity);
    if (age > MAX_AGE_MS && !(await download()) && age === Infinity) {
      console.warn('geo: could not download the country database; everyone sees the global feed');
      return;
    }
    reader = new Reader<CountryResponse>(await readFile(file()));
    console.log('geo: country database loaded');
  } catch (err) {
    console.warn('geo: country database unavailable:', (err as Error).message);
  }
}

/** ISO 3166-1 alpha-2 code (upper case) of the visitor, or null when unknown (local addresses, no database). */
export function countryOf(ip: string | undefined): string | null {
  if (config.devCountry) return config.devCountry;
  if (!ip || !reader) return null;
  try {
    return reader.get(ip.replace(/^::ffff:/, ''))?.country?.iso_code?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

/** "NL" or "nl " → "NL"; anything that is not two letters → null (global). */
export const normalizeCountry = (value: unknown) => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
};
