// Mail to the owner when the bot needs attention (SendGrid's v3 API over fetch, like play/backend/src/mail.ts). log.ts
// calls notifyLog for every line, so events raise alerts without the engine knowing about mail. Nothing here throws
// or is awaited by the trading loop, and it must not call log() (a failed mail would log, which would mail...).
// Only the log line's message goes out, never its data, and known secrets are cut from it first.

const DEDUP_MS = 30 * 60_000;
/** After a failed send the next occurrence may try again this soon, so an outage of SendGrid is not hammered. */
const RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const DASHBOARD = 'https://stonks.bas-franke.com';

/** Warnings that mean the bot is not doing its work; every 'error' line mails too, unless it is listed below. */
const WARN_EVENTS = new Set(['decision_held', 'stale_candles', 'stop_skipped']);
/** Errors the bot keeps working through. The owner's rule: stonks only mails fills (tradeMail.ts) and a bot that is not working. */
const NOT_BOT_FAILURES = new Set(['login_disabled', 'login_paused', 'family_code_changed']);

/** Sender address; bas-franke.com must be authenticated in SendGrid (or this address verified as a single sender). */
const MAIL_FROM = 'stonks@bas-franke.com';

const settings = () => ({
  key: process.env.SENDGRID_API_KEY ?? '',
  from: MAIL_FROM,
  to: process.env.STONKS_ALERT_EMAIL ?? '',
});

export function alertsConfigured(): boolean {
  const { key, to } = settings();
  return Boolean(key && to);
}

export const shouldAlert = (level: string, event: string) => (level === 'error' && !NOT_BOT_FAILURES.has(event)) || (level === 'warn' && WARN_EVENTS.has(event));

/** Cuts anything that looks like a credential out of text that leaves the server. */
export function scrub(text: string): string {
  let out = text;
  for (const name of ['SENDGRID_API_KEY', 'BITVAVO_API_KEY', 'BITVAVO_API_SECRET', 'STONKS_ADMIN_PASSWORD', 'DATABASE_URL']) {
    const value = process.env[name];
    if (value) out = out.split(value).join('[hidden]');
  }
  return out.replace(/postgres(ql)?:\/\/\S+/gi, '[hidden]').replace(/\bSG\.[\w-]+\.[\w-]+/g, '[hidden]');
}

/** For the Health page. Kept in memory: a restart starts empty. */
export const alertStats = { lastSentAt: null as number | null, lastError: null as string | null };

export async function deliver(subject: string, text: string, html?: string): Promise<{ ok: boolean; error?: string }> {
  const { key, from, to } = settings();
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: 'stonks bot' },
        subject: scrub(subject),
        content: [{ type: 'text/plain', value: scrub(text) }, ...(html ? [{ type: 'text/html', value: scrub(html) }] : [])],
        // Click tracking rewrites links through SendGrid's domain.
        tracking_settings: { click_tracking: { enable: false, enable_text: false } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      alertStats.lastSentAt = Date.now();
      alertStats.lastError = null;
      return { ok: true };
    }
    return failed(scrub(`SendGrid answered ${res.status}: ${(await res.text()).slice(0, 200)}`));
  } catch (err) {
    return failed(scrub(err instanceof Error ? err.message : String(err)));
  }
}

function failed(error: string) {
  alertStats.lastError = error;
  console.error(`[stonks] alert mail failed: ${error}`);
  return { ok: false, error };
}

const seen = new Map<string, { at: number; suppressed: number }>();

/** From log(): mails the event unless the same event went out in the last 30 minutes. Returns at once, never throws. */
export function notifyLog(level: string, event: string, message: string, now = Date.now()): void {
  try {
    if (!shouldAlert(level, event) || !alertsConfigured()) return;
    const last = seen.get(event);
    if (last && now - last.at < DEDUP_MS) {
      last.suppressed++;
      return;
    }
    const suppressed = last?.suppressed ?? 0;
    const entry = { at: now, suppressed: 0 };
    seen.set(event, entry);
    const lines = [
      message,
      '',
      `Event: ${event} (${level})`,
      `Time: ${new Date(now).toISOString()}`,
      ...(suppressed ? [`${suppressed} more of these were not mailed since the last mail.`] : []),
      '',
      DASHBOARD,
    ];
    void deliver(`[stonks] ${event}`, lines.join('\n')).then((r) => {
      if (r.ok) return;
      entry.at = now - DEDUP_MS + RETRY_MS;
      entry.suppressed += suppressed + 1;
    });
  } catch (err) {
    try {
      console.error('[stonks] alert failed', err instanceof Error ? err.message : err);
    } catch {
      /* nothing left to do */
    }
  }
}

/** For tests. */
export const resetAlerts = () => seen.clear();
