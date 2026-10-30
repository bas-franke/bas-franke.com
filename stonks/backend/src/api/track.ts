import { Router } from 'express';
import { OPEN_STATUSES } from '../bot/store.js';
import type { ApiDeps } from './deps.js';
import { ConflictError, enumParam, fail, MODES, num } from './util.js';

// Portfolio vs buy and hold BTC / ETH for the Overview (SPEC.md §5a). Purely informative: reads equity_snapshots
// and track_points (one row a minute), and fills BTC/ETH from Bitvavo candles where no track points exist yet.

/** Expected vs actual starts over from now for that mode (SPEC.md §5b). Deletes nothing: the runner reads this mark and restarts its count. */
export async function markTrackingReset(deps: ApiDeps, mode: string): Promise<void> {
  await deps.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('tracking_reset', jsonb_build_object($1::text, $2::bigint), now())
     ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now()`,
    [mode, (deps.now ?? Date.now)()],
  );
}

/** Worth of a coin that counts as a real position; below it is dust the bot could not sell anyway. */
const POSITION_MIN_EUR = 5;

export const RANGES = ['day', 'week', 'month', 'year', 'all'] as const;
const SPAN_MS: Record<Exclude<(typeof RANGES)[number], 'all'>, number> = {
  day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
};
const MAX_POINTS = 500;
/** Candles fill the price lines before the first track point when it starts later than this after `from`. */
const GAP_MS = 10 * 60_000;

type Pt = [number, number];
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

/** At most `max` points, evenly thinned, last one kept. */
export function thin(points: Pt[], max = MAX_POINTS): Pt[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

export function trackRoutes(deps: ApiDeps) {
  const r = Router();
  const now = deps.now ?? Date.now;

  r.get('/compare', async (req, res) => {
    const range = enumParam(req, 'range', RANGES) ?? 'month';
    const mode = enumParam(req, 'mode', MODES) ?? (await deps.getBotSettings()).mode;
    const to = now();
    let from: number;
    if (range === 'all') {
      // "All" = the start of this mode's portfolio history (cleared from Settings resets it).
      const { rows } = await deps.query(
        `SELECT min(ts) AS first FROM (
           SELECT ts FROM equity_snapshots WHERE mode = $1
           UNION ALL SELECT ts FROM track_points WHERE mode = $1 AND portfolio_eur IS NOT NULL) x`,
        [mode],
      );
      const first = rows[0]?.first ? ms(rows[0].first) : NaN;
      from = Number.isFinite(first) ? Math.min(first, to - 3_600_000) : to - SPAN_MS.day;
    } else from = to - SPAN_MS[range];

    const pf = await deps.query(
      `SELECT ts, total_eur AS v FROM equity_snapshots WHERE mode = $1 AND ts >= to_timestamp($2 / 1000.0)
       UNION ALL
       SELECT ts, portfolio_eur AS v FROM track_points WHERE mode = $1 AND portfolio_eur IS NOT NULL AND ts >= to_timestamp($2 / 1000.0)
       ORDER BY ts`,
      [mode, from],
    );
    const portfolio: Pt[] = pf.rows.map((x) => [ms(x.ts), Number(x.v)] as Pt).filter((p) => Number.isFinite(p[0]) && p[1] > 0);
    // The race starts where the portfolio does: BTC/ETH never go back further than its first point, so all three are
    // indexed to 100 at the same moment, and after a clear (no portfolio points yet) they start again from scratch.
    const start = portfolio.length ? Math.max(from, portfolio[0][0]) : to;
    const tp = await deps.query(
      'SELECT ts, btc_eur, eth_eur FROM track_points WHERE ts >= to_timestamp($1 / 1000.0) ORDER BY ts',
      [start - GAP_MS],
    );
    const track = (col: 'btc_eur' | 'eth_eur'): Pt[] => {
      if (start >= to) return [];
      const pts = tp.rows.filter((x) => x[col] !== null).map((x) => [ms(x.ts), Number(x[col])] as Pt).filter((p) => p[1] > 0);
      // the last price at or just before the start becomes the point at the start
      const before = pts.filter((p) => p[0] <= start).pop();
      const after = pts.filter((p) => p[0] > start && p[0] <= to);
      return before ? [[start, before[1]], ...after] : after;
    };
    const prices = async (market: string, tracked: Pt[]): Promise<Pt[]> => {
      const first = tracked.length ? tracked[0][0] : to;
      if (start >= to || first - start <= GAP_MS || !deps.priceHistory) return tracked;
      try {
        const hist = (await deps.priceHistory(market, start, first)).filter((p) => p[0] >= start && p[0] < first);
        return [...hist, ...tracked];
      } catch {
        return tracked; // the chart still shows what was tracked
      }
    };
    const [btc, eth] = await Promise.all([prices('BTC-EUR', track('btc_eur')), prices('ETH-EUR', track('eth_eur'))]);
    res.json({
      mode,
      range,
      from: new Date(from).toISOString(),
      start: new Date(start).toISOString(),
      to: new Date(to).toISOString(),
      portfolio: thin(portfolio),
      btc: thin(btc),
      eth: thin(eth),
    });
  });

  // Settings > "Clear portfolio history": the portfolio line (and "All") starts again from now. Trading never reads it.
  r.post('/portfolio-history/clear', async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.confirm !== 'CLEAR') fail('Type CLEAR to confirm (confirm: "CLEAR").');
    const mode = (await deps.getBotSettings()).mode;
    const a = await deps.query('DELETE FROM equity_snapshots WHERE mode = $1', [mode]);
    const b = await deps.query('DELETE FROM track_points WHERE mode = $1', [mode]);
    await markTrackingReset(deps, mode);
    const removed = (a.rowCount ?? 0) + (b.rowCount ?? 0);
    await deps.log('warn', 'portfolio_history_cleared', `Portfolio history of the ${mode} account cleared (${removed} points); charts start again from now`, { mode, removed });
    res.json({ ok: true, mode, removed });
  });

  // Settings > "Clear trades and logs". Stops and the position's average entry are read from the fills, so it refuses
  // while a coin is held, and while orders are working or just ended (a late fill still needs its order). Ids keep counting.
  r.post('/trades-and-logs/clear', async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.confirm !== 'CLEAR') fail('Type CLEAR to confirm (confirm: "CLEAR").');
    const mode = (await deps.getBotSettings()).mode;
    const { balances } = (await deps.getOverview()) as { balances?: { symbol: string; eurValue: unknown }[] };
    const held = (balances ?? []).filter((b) => b.symbol.toUpperCase() !== 'EUR' && (num(b.eurValue) ?? 0) >= POSITION_MIN_EUR);
    if (held.length) throw new ConflictError(`The bot still holds ${held.map((b) => b.symbol).join(', ')}. Clear this once it is out of the position.`);
    const { rows } = await deps.query(
      `SELECT count(*) AS n FROM orders WHERE status = ANY($1) OR status = 'unknown' OR updated_at > now() - interval '15 minutes'`,
      [OPEN_STATUSES],
    );
    if (Number(rows[0]?.n ?? 0) > 0) throw new ConflictError('Orders are working or ended in the last 15 minutes. Try again once they have settled.');
    const a = await deps.query('DELETE FROM fills');
    const b = await deps.query('DELETE FROM orders');
    const c = await deps.query('DELETE FROM bot_logs');
    for (const m of MODES) await markTrackingReset(deps, m);
    const removed = { fills: a.rowCount ?? 0, orders: b.rowCount ?? 0, logs: c.rowCount ?? 0 };
    await deps.log('warn', 'trades_and_logs_cleared', 'All trades and logs cleared, live and paper', { mode, ...removed });
    res.json({ ok: true, mode, removed });
  });

  return r;
}
