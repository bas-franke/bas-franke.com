import { timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { authEnabled, requireLogin, sessionUser } from './auth.js';
import { config } from './config.js';
import { db, dbEnabled, query } from './db.js';
import { projects } from './projects.js';

// Screenshots of design changes, uploaded by Claude sessions (status/tools/upload-screenshot.mjs) and shown on the
// status page. Stored in Postgres (migration 003_screenshots in db.ts) so they survive redeploys; only the newest
// PER_PROJECT per project are kept.

export const PER_PROJECT = 20;

const MAX_TITLE = 140;
const MAX_NOTE = 1000;
const MAX_SOURCE = 80;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export type ScreenshotMeta = {
  id: string;
  project: string;
  title: string;
  note: string | null;
  source: string | null;
  contentType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  createdAt: string;
  url: string;
};

type MetaRow = {
  id: string;
  project: string;
  title: string;
  note: string | null;
  source: string | null;
  content_type: string;
  width: number | null;
  height: number | null;
  bytes: number;
  created_at: Date;
};

const META_COLUMNS = 'id, project, title, note, source, content_type, width, height, bytes, created_at';

const toMeta = (r: MetaRow): ScreenshotMeta => ({
  id: String(r.id),
  project: r.project,
  title: r.title,
  note: r.note,
  source: r.source,
  contentType: r.content_type,
  width: r.width,
  height: r.height,
  bytes: r.bytes,
  createdAt: r.created_at.toISOString(),
  url: `/api/screenshots/${r.id}/image`,
});

// ---------------------------------------------------------------------------------------------------------------
// Image sniffing: the type from the magic bytes and the size from the header. Returns undefined for anything that is
// not a PNG, JPEG or WebP; width/height are null when the header cannot be read.

export type ImageInfo = { contentType: string; width: number | null; height: number | null };

export function sniffImage(buf: Buffer): ImageInfo | undefined {
  // PNG: signature, then the IHDR chunk with big-endian width and height.
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const ok = buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR';
    return { contentType: 'image/png', width: ok ? buf.readUInt32BE(16) : null, height: ok ? buf.readUInt32BE(20) : null };
  }

  // JPEG: SOI, then walk the marker segments until a start-of-frame (SOF0..SOF15 except DHT/JPG/DAC).
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // no length
      if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan: no SOF found
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 9 > buf.length) break;
        return { contentType: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { contentType: 'image/jpeg', width: null, height: null };
  }

  // WebP: RIFF container with the first chunk VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { contentType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]];
      return {
        contentType: 'image/webp',
        width: 1 + (b0 | ((b1 & 0x3f) << 8)),
        height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
      };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { contentType: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    return { contentType: 'image/webp', width: null, height: null };
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------

const token = () => config.screenshotToken;

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** A valid bearer token, a logged-in session, or local dev (no login and no token configured). */
function mayUpload(req: Request) {
  const expected = token();
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return Boolean(expected) && safeEqual(match[1].trim(), expected!);
  if (sessionUser(req)) return true;
  return !authEnabled() && !expected;
}

/** One string from the query string (repeated keys: the first), trimmed; undefined when missing or empty. */
function param(req: Request, name: string) {
  const raw = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const isId = (id: string) => /^\d{1,18}$/.test(id);

export const screenshotsRouter = express.Router();

screenshotsRouter.post('/', express.raw({ type: IMAGE_TYPES, limit: '8mb' }), async (req, res) => {
  if (!mayUpload(req)) {
    return res.status(401).json({ error: 'Not allowed: send "Authorization: Bearer <SCREENSHOT_TOKEN>" or log in.' });
  }
  if (!dbEnabled()) return res.status(503).json({ error: 'DATABASE_URL is not set: screenshots cannot be stored.' });

  const project = param(req, 'project');
  const names = projects.map((p) => p.name);
  if (!project || !names.includes(project)) {
    return res.status(400).json({ error: `Query parameter "project" must be one of: ${names.join(', ')}` });
  }
  const title = param(req, 'title');
  if (!title) return res.status(400).json({ error: 'Query parameter "title" is required.' });
  if (title.length > MAX_TITLE) return res.status(400).json({ error: `"title" is longer than ${MAX_TITLE} characters.` });
  const note = param(req, 'note') ?? null;
  if (note && note.length > MAX_NOTE) return res.status(400).json({ error: `"note" is longer than ${MAX_NOTE} characters.` });
  const source = param(req, 'source') ?? null;
  if (source && source.length > MAX_SOURCE) {
    return res.status(400).json({ error: `"source" is longer than ${MAX_SOURCE} characters.` });
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(415).json({ error: `Send the image bytes as the body with Content-Type ${IMAGE_TYPES.join(', ')}.` });
  }
  const image = req.body;
  const info = sniffImage(image);
  if (!info) return res.status(400).json({ error: 'The body is not a PNG, JPEG or WebP image.' });

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    // Serialize uploads per project so concurrent prunes cannot interleave.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`screenshots:${project}`]);
    const { rows } = await client.query<MetaRow>(
      `INSERT INTO screenshots (project, title, note, source, content_type, width, height, bytes, image)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${META_COLUMNS}`,
      [project, title, note, source, info.contentType, info.width, info.height, image.length, image],
    );
    const pruned = await client.query(
      `DELETE FROM screenshots
       WHERE project = $1
         AND id NOT IN (SELECT id FROM screenshots WHERE project = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
      [project, PER_PROJECT],
    );
    await client.query('COMMIT');
    res.status(201).json({ screenshot: toMeta(rows[0]), pruned: pruned.rowCount ?? 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

screenshotsRouter.get('/', requireLogin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const uploadsEnabled = dbEnabled() && Boolean(token());
  if (!dbEnabled()) return res.json({ perProject: PER_PROJECT, uploadsEnabled, screenshots: [] });
  const project = param(req, 'project');
  const { rows } = project
    ? await query<MetaRow>(`SELECT ${META_COLUMNS} FROM screenshots WHERE project = $1 ORDER BY created_at DESC, id DESC`, [project])
    : await query<MetaRow>(`SELECT ${META_COLUMNS} FROM screenshots ORDER BY created_at DESC, id DESC`);
  res.json({ perProject: PER_PROJECT, uploadsEnabled, screenshots: rows.map(toMeta) });
});

screenshotsRouter.get('/:id/image', requireLogin, async (req, res) => {
  const id = String(req.params.id);
  if (!isId(id)) return res.status(400).json({ error: 'Invalid screenshot id' });
  if (!dbEnabled()) return res.status(404).json({ error: 'Screenshot not found' });
  const { rows } = await query<{ content_type: string; image: Buffer }>(
    'SELECT content_type, image FROM screenshots WHERE id = $1',
    [id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Screenshot not found' });
  res
    .set('Content-Type', rows[0].content_type)
    .set('Cache-Control', 'private, max-age=31536000, immutable')
    .set('X-Content-Type-Options', 'nosniff')
    .send(rows[0].image);
});

screenshotsRouter.delete('/:id', requireLogin, async (req, res) => {
  const id = String(req.params.id);
  if (!isId(id)) return res.status(400).json({ error: 'Invalid screenshot id' });
  if (!dbEnabled()) return res.status(404).json({ error: 'Screenshot not found' });
  const { rowCount } = await query('DELETE FROM screenshots WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Screenshot not found' });
  res.json({ ok: true });
});

// Body-parser errors (too large, broken stream) carry an HTTP status; pass anything else to the app's handler.
const onBodyError: ErrorRequestHandler = (err, _req, res, next) => {
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json({ error: status === 413 ? 'Image is larger than 8 MB.' : (err as Error).message });
  }
  next(err);
};
screenshotsRouter.use(onBodyError);
