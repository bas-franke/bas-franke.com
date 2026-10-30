import { Router } from 'express';
import type { ApiDeps } from './deps.js';
import { markTrackingReset, RANGES } from './track.js';
import { enumParam, fail, MODES } from './util.js';

// Bot monitoring (SPEC.md §5b): expected vs actual, and a way to test the alert mail.

export function trackingRoutes(deps: ApiDeps) {
  const r = Router();

  r.get('/tracking', async (req, res) => {
    if (!deps.tracking) fail('Tracking is not available.');
    const range = enumParam(req, 'range', RANGES) ?? 'month';
    const mode = enumParam(req, 'mode', MODES) ?? ((await deps.getBotSettings()).mode as (typeof MODES)[number]);
    res.json(await deps.tracking!(mode, range));
  });

  // Gap, slippage, fees and decisions count from now again. The runner applies it at its next minute.
  r.post('/tracking/reset', async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.confirm !== 'RESET') fail('Type RESET to confirm (confirm: "RESET").');
    const mode = (await deps.getBotSettings()).mode;
    await markTrackingReset(deps, mode);
    await deps.log('warn', 'tracking_reset', `Expected vs actual of the ${mode} account starts over from now`, { mode });
    res.json({ ok: true, mode });
  });

  r.get('/health/detail', async (_req, res) => {
    if (!deps.healthDetail) fail('Health detail is not available.');
    res.json(await deps.healthDetail!());
  });

  r.post('/bot/test-alert', async (_req, res) => {
    if (!deps.sendTestAlert) fail('Alerts are not available.');
    const result = await deps.sendTestAlert!();
    await deps.log('info', 'alert_test', result.ok ? 'Test alert mail sent' : `Test alert mail not sent: ${result.error}`);
    res.json(result);
  });

  return r;
}
