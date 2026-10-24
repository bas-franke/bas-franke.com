import { Router } from 'express';
import nodemailer from 'nodemailer';

/**
 * Contact form endpoint.
 *
 * Mail is sent over SMTP when SMTP_HOST, SMTP_USER and SMTP_PASS are set in /srv/apps/portfolio/.env
 * (see README.md). Without them, GET /api/contact reports { enabled: false } and the frontend hides the
 * form, so visitors only see the plain e-mail address and nothing silently fails.
 */

const env = process.env;

export function mailEnabled(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

// Small in-memory rate limit: a handful of messages per IP per hour is plenty for a personal site.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, stamps] of hits) {
    const recent = stamps.filter((t) => now - t < WINDOW_MS);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, WINDOW_MS).unref();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const contactRouter = Router();

contactRouter.get('/', (_req, res) => {
  res.json({ enabled: mailEnabled() });
});

contactRouter.post('/', async (req, res) => {
  if (!mailEnabled()) {
    res.status(503).json({ error: 'The contact form is not set up yet. Please e-mail me directly.' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // Honeypot: the "company" field is invisible to people, so anything in it comes from a bot.
  if (text(body.company, 10)) {
    res.json({ ok: true });
    return;
  }

  const name = text(body.name, 120);
  const email = text(body.email, 200);
  const message = text(body.message, 5000);

  if (name.length < 2) {
    res.status(400).json({ error: 'Please tell me your name.' });
    return;
  }
  if (!EMAIL.test(email)) {
    res.status(400).json({ error: 'That e-mail address does not look right.' });
    return;
  }
  if (message.length < 10) {
    res.status(400).json({ error: 'Your message is a little short.' });
    return;
  }
  if (limited(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Too many messages in a row. Please try again in an hour.' });
    return;
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === 'true',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  const to = env.CONTACT_TO ?? env.SMTP_USER!;
  const from = env.CONTACT_FROM ?? env.SMTP_USER!;

  try {
    await transport.sendMail({
      from: { name: 'bas-franke.com', address: from },
      to,
      replyTo: { name, address: email },
      subject: `Message from ${name} via bas-franke.com`,
      text: `From: ${name} <${email}>\nIP: ${req.ip ?? 'unknown'}\n\n${message}\n`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('contact: sending failed', err);
    res.status(502).json({ error: 'Sending failed on my side. Please e-mail me directly.' });
  }
});
