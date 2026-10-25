#!/usr/bin/env node
// Uploads screenshots of design changes to the status page (status.bas-franke.com, "Screenshots").
// Used by Claude sessions and subagents after changing how a project looks. The status backend keeps the 20 newest
// screenshots per project and deletes older ones on upload. No dependencies; needs Node 18+ (global fetch).
//
//   node status/tools/upload-screenshot.mjs --project play --title "Lobby redesign" [--note "..."] [--source agent] shot.png [more.png ...]
//
// The upload token (the status backend's SCREENSHOT_TOKEN) comes from the env var STATUS_SCREENSHOT_TOKEN or from the
// gitignored file .env.screenshots at the repo root, with lines KEY=value:
//
//   STATUS_SCREENSHOT_TOKEN=...
//   STATUS_URL=https://status.bas-franke.com   (optional; e.g. http://127.0.0.1:3002 for a local backend)

import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.screenshots');
const DEFAULT_URL = 'https://status.bas-franke.com';
const WARN_BYTES = 3 * 1024 * 1024;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const USAGE = `Upload screenshots to the status page.

Usage:
  node status/tools/upload-screenshot.mjs --project <name> --title "<title>" [--note "<text>"] [--source <who>] <file> [more files...]

Options:
  --project  portfolio | status | inck | play | wordward (required)
  --title    short title, at most 140 characters (required); several files get " (1/3)" suffixes
  --note     optional description, at most 1000 characters
  --source   optional, who took it: session, agent, or an agent role (at most 80 characters)
  --help     show this help

Files: .png, .jpg, .jpeg or .webp, at most 8 MB each.

Token: env STATUS_SCREENSHOT_TOKEN, or STATUS_SCREENSHOT_TOKEN=... in ${ENV_FILE}
Server: env STATUS_URL, or STATUS_URL=... in that file (default ${DEFAULT_URL})`;

function fail(message) {
  console.error(`upload-screenshot: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (!['project', 'title', 'note', 'source'].includes(key)) fail(`unknown option --${key} (see --help)`);
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) fail(`--${key} needs a value`);
      opts[key] = value;
    } else opts.files.push(arg);
  }
  return opts;
}

function readEnvFile() {
  const values = {};
  let text;
  try {
    text = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

async function upload({ baseUrl, token, file, project, title, note, source }) {
  const params = new URLSearchParams({ project, title });
  if (note) params.set('note', note);
  if (source) params.set('source', source);
  const url = `${baseUrl}/api/screenshots?${params}`;
  const body = readFileSync(file);
  const type = TYPES[extname(file).toLowerCase()];

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
    });
  } catch (err) {
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
    throw new Error(`cannot reach ${baseUrl} (${cause}). Check STATUS_URL and your network.`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const serverError = json?.error ?? (text.slice(0, 200) || res.statusText);

  if (res.status === 401) {
    throw new Error(
      `${token ? 'the upload token was rejected' : 'no upload token found'} (401: ${serverError}).\n` +
        `  Put STATUS_SCREENSHOT_TOKEN=<token> in ${ENV_FILE} (gitignored) or set the env var STATUS_SCREENSHOT_TOKEN.\n` +
        `  The token must equal SCREENSHOT_TOKEN in the status backend's .env (/srv/apps/status/.env on the server).`,
    );
  }
  if (res.status === 400 || res.status === 415) throw new Error(`rejected (${res.status}): ${serverError}`);
  if (res.status === 413) throw new Error(`too large (413): ${serverError} Save it as JPEG or WebP.`);
  if (res.status === 503) throw new Error(`server cannot store screenshots (503): ${serverError}`);
  if (res.status !== 201 || !json?.screenshot) throw new Error(`unexpected response ${res.status}: ${serverError}`);
  return json;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!opts.project) fail('--project is required (see --help)');
  if (!opts.title?.trim()) fail('--title is required (see --help)');
  if (opts.files.length === 0) fail('give at least one image file (see --help)');

  for (const file of opts.files) {
    if (!TYPES[extname(file).toLowerCase()]) fail(`${file}: only .png, .jpg, .jpeg and .webp are supported`);
    let size;
    try {
      size = statSync(file).size;
    } catch {
      fail(`${file}: file not found`);
    }
    if (size > WARN_BYTES) {
      console.warn(`warning: ${file} is ${(size / 1024 / 1024).toFixed(1)} MB; consider saving it as JPEG or WebP (limit 8 MB).`);
    }
  }

  const fileEnv = readEnvFile();
  const token = (process.env.STATUS_SCREENSHOT_TOKEN ?? fileEnv.STATUS_SCREENSHOT_TOKEN ?? '').trim();
  const baseUrl = (process.env.STATUS_URL ?? fileEnv.STATUS_URL ?? DEFAULT_URL).trim().replace(/\/+$/, '');

  const total = opts.files.length;
  let failed = 0;
  for (const [i, file] of opts.files.entries()) {
    const title = total > 1 ? `${opts.title.trim()} (${i + 1}/${total})` : opts.title.trim();
    try {
      const { screenshot, pruned } = await upload({ baseUrl, token, file, project: opts.project, title, note: opts.note, source: opts.source });
      const size = screenshot.width && screenshot.height ? ` ${screenshot.width}x${screenshot.height}` : '';
      console.log(
        `uploaded ${basename(file)} -> id ${screenshot.id}, project ${screenshot.project}${size}, ` +
          `${pruned} old screenshot${pruned === 1 ? '' : 's'} pruned`,
      );
    } catch (err) {
      failed++;
      console.error(`upload-screenshot: ${file}: ${err.message}`);
      // A bad token or unreachable server fails every file the same way; stop early.
      if (/401|cannot reach/.test(err.message)) break;
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => fail(err?.message ?? String(err)));
