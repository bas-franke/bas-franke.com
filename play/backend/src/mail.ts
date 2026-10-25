// Transactional mail (account activation, password reset) through SendGrid's v3 API. Without SENDGRID_API_KEY the
// mail is not sent: the link is logged instead and handed back to the caller, which is how local development works.

import { config } from './config.js';

export const mailConfigured = () => Boolean(config.sendgridApiKey);

export interface Mail {
  to: string;
  subject: string;
  /** Plain text body; the HTML version is built from it. */
  text: string;
  /** The one link the mail is about, shown as a button in the HTML version. */
  link: { url: string; label: string };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function html(mail: Mail) {
  const paragraphs = mail.text
    .split(/\n{2,}/)
    .filter((p) => !p.includes(mail.link.url))
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#0f1117;padding:32px 16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8eaf0">
<div style="max-width:480px;margin:0 auto;background:#181b24;border-radius:14px;padding:28px">
<div style="font-weight:800;font-size:22px;margin-bottom:20px">play<span style="color:#ff7a59">.</span></div>
${paragraphs}
<p style="margin:24px 0"><a href="${escapeHtml(mail.link.url)}" style="display:inline-block;background:#ff7a59;color:#1a0d08;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${escapeHtml(mail.link.label)}</a></p>
<p style="margin:0;font-size:13px;color:#9aa0b0">Or open this link: <a href="${escapeHtml(mail.link.url)}" style="color:#9aa0b0">${escapeHtml(mail.link.url)}</a></p>
</div></body></html>`;
}

/** Sends the mail; returns false (after logging) when it could not be delivered or mail is not configured. */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!config.sendgridApiKey) {
    console.log(`[mail] SENDGRID_API_KEY not set; would send "${mail.subject}" to ${mail.to}: ${mail.link.url}`);
    return false;
  }
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.sendgridApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: mail.to }] }],
        from: { email: config.mailFrom, name: config.mailFromName },
        subject: mail.subject,
        content: [
          { type: 'text/plain', value: mail.text },
          { type: 'text/html', value: html(mail) },
        ],
        // Click tracking rewrites links through SendGrid's domain; one-time account links should stay as they are.
        tracking_settings: { click_tracking: { enable: false, enable_text: false } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[mail] SendGrid answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[mail] SendGrid request failed', err);
    return false;
  }
}
