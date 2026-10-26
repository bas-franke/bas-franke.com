import { Router, type Request } from 'express';
import type { ApiDeps } from './deps.js';
import { enumParam, intParam, iso, MARKET_RE, MAX_LIMIT, MODES, num, patternParam } from './util.js';

// Read-only history: orders, fills, equity curve and the bot log (SPEC.md §7). All lists are newest first.

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const MAX_EQUITY_POINTS = 1500;

export function historyRoutes(deps: ApiDeps) {
  const r = Router();

  /** Shared filters for orders and fills: ?mode=&market=&limit=&before=<id>. */
  const listFilters = (req: Request) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const mode = enumParam(req, 'mode', MODES);
    const market = patternParam(req, 'market', MARKET_RE);
    const before = intParam(req, 'before', 1, Number.MAX_SAFE_INTEGER);
    const limit = intParam(req, 'limit', 1, MAX_LIMIT) ?? 100;
    if (mode) where.push(`mode = $${params.push(mode)}`);
    if (market) where.push(`market = $${params.push(market)}`);
    if (before) where.push(`id < $${params.push(before)}`);
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params, limit };
  };

  r.get('/orders', async (req, res) => {
    const f = listFilters(req);
    const { rows } = await deps.query(
      `SELECT id, mode, client_order_id, exchange_order_id, market, side, order_type, price, amount, filled_amount,
              filled_quote, fee_paid, fee_currency, status, strategy_id, reason, created_at, updated_at
         FROM orders ${f.where} ORDER BY id DESC LIMIT ${f.limit}`,
      f.params,
    );
    res.json({
      orders: rows.map((o) => ({
        id: num(o.id),
        mode: o.mode,
        clientOrderId: o.client_order_id,
        exchangeOrderId: o.exchange_order_id,
        market: o.market,
        side: o.side,
        type: o.order_type,
        price: num(o.price),
        amount: num(o.amount),
        filledAmount: num(o.filled_amount),
        filledQuote: num(o.filled_quote),
        feePaid: num(o.fee_paid),
        feeCurrency: o.fee_currency,
        status: o.status,
        strategyId: o.strategy_id,
        reason: o.reason,
        createdAt: iso(o.created_at),
        updatedAt: iso(o.updated_at),
      })),
    });
  });

  r.get('/fills', async (req, res) => {
    const f = listFilters(req);
    const { rows } = await deps.query(
      `SELECT id, order_id, mode, exchange_trade_id, market, side, price, amount, quote, fee, fee_currency, taker,
              executed_at
         FROM fills ${f.where} ORDER BY id DESC LIMIT ${f.limit}`,
      f.params,
    );
    res.json({
      fills: rows.map((t) => ({
        id: num(t.id),
        orderId: num(t.order_id),
        mode: t.mode,
        exchangeTradeId: t.exchange_trade_id,
        market: t.market,
        side: t.side,
        price: num(t.price),
        amount: num(t.amount),
        quote: num(t.quote),
        fee: num(t.fee),
        feeCurrency: t.fee_currency,
        taker: t.taker,
        executedAt: iso(t.executed_at),
      })),
    });
  });

  // ?mode= (default: the bot's current mode) &days= (default 30). Thinned to at most 1500 points, last kept.
  r.get('/equity', async (req, res) => {
    const mode = enumParam(req, 'mode', MODES) ?? (await deps.getBotSettings()).mode;
    const days = intParam(req, 'days', 1, 3650) ?? 30;
    const { rows } = await deps.query(
      `SELECT ts, total_eur, cash_eur FROM equity_snapshots
        WHERE mode = $1 AND ts > now() - make_interval(days => $2) ORDER BY ts`,
      [mode, days],
    );
    const step = Math.ceil(rows.length / MAX_EQUITY_POINTS) || 1;
    const picked = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
    res.json({
      mode,
      points: picked.map((p) => ({ ts: iso(p.ts), totalEur: num(p.total_eur), cashEur: num(p.cash_eur) })),
    });
  });

  // ?level= is a minimum (warn = warn + error). ?after=<id> returns the oldest `limit` entries after it (live tail),
  // ?before=<id> pages back; either way the response is newest first.
  r.get('/logs', async (req, res) => {
    const level = enumParam(req, 'level', LEVELS);
    const after = intParam(req, 'after', 0, Number.MAX_SAFE_INTEGER);
    const before = intParam(req, 'before', 1, Number.MAX_SAFE_INTEGER);
    const limit = intParam(req, 'limit', 1, MAX_LIMIT) ?? 200;
    const where: string[] = [];
    const params: unknown[] = [];
    if (level) where.push(`level = ANY($${params.push(LEVELS.slice(LEVELS.indexOf(level)))})`);
    if (after !== undefined) where.push(`id > $${params.push(after)}`);
    if (before !== undefined) where.push(`id < $${params.push(before)}`);
    const order = after !== undefined ? 'ASC' : 'DESC';
    const { rows } = await deps.query(
      `SELECT id, ts, level, event, message, data FROM bot_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${order} LIMIT ${limit}`,
      params,
    );
    if (order === 'ASC') rows.reverse();
    res.json({
      logs: rows.map((l) => ({
        id: num(l.id),
        ts: iso(l.ts),
        level: l.level,
        event: l.event,
        message: l.message,
        data: l.data ?? null,
      })),
    });
  });

  return r;
}
