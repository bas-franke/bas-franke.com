import { useCallback, useEffect, useState } from 'react';
import { api, unwrapMarkets } from '../api';
import { EmptyState } from '../components/art';
import { ErrorBox, Segmented, Skeleton, useAsync } from '../components/ui';
import { amount, dateTime, eur, num, price } from '../format';
import type { Fill, Order } from '../types';

const PAGE = 50;
type Tab = 'orders' | 'fills';

const pick = <T,>(...v: T[]) => v.find((x) => x !== undefined && x !== null);

/** Fees are in EUR on Bitvavo EUR markets; anything else is shown with its currency. */
const feeText = (fee: unknown, currency?: string | null) =>
  fee === undefined || fee === null ? '–' : !currency || currency === 'EUR' ? eur(fee) : `${amount(fee)} ${currency}`;

const statusChip = (s: string) => {
  const k = s.toLowerCase();
  const open = ['new', 'open', 'pending', 'awaitingtrigger'].includes(k) || k.includes('partial');
  const cls = k === 'filled' ? 'gain' : open ? 'brass' : k.includes('reject') || k.includes('error') ? 'loss' : '';
  const label = k === 'new' ? 'open' : s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return <span className={`chip ${cls}`}>{label}</span>;
};

export default function TradesPage() {
  const [tab, setTab] = useState<Tab>('orders');
  const [mode, setMode] = useState<'' | 'paper' | 'live'>('');
  const [market, setMarket] = useState('');
  const [rows, setRows] = useState<(Order | Fill)[]>([]);
  const [state, setState] = useState<{ loading: boolean; error?: Error; done: boolean }>({ loading: true, done: false });
  const markets = useAsync(() => api.markets().then(unwrapMarkets), []);

  const load = useCallback(
    async (before?: string | number) => {
      setState((s) => ({ ...s, loading: true, error: undefined }));
      try {
        const q = { mode: mode || undefined, market: market || undefined, limit: PAGE, before };
        const got = tab === 'orders' ? (await api.orders(q)).orders : (await api.fills(q)).fills;
        setRows((r) => (before ? [...r, ...got] : got));
        setState({ loading: false, done: got.length < PAGE });
      } catch (e) {
        setState((s) => ({ ...s, loading: false, error: e as Error }));
      }
    },
    [tab, mode, market],
  );

  useEffect(() => {
    setRows([]);
    load();
  }, [load]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <span className="eyebrow">Trades</span>
          <h1>Every order, every fill</h1>
          <p className="lede">What the bot asked for (orders) and what actually happened on the exchange (fills), newest first.</p>
        </div>
      </div>

      <div className="row">
        <Segmented<Tab>
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'orders', label: 'Orders' },
            { value: 'fills', label: 'Fills' },
          ]}
        />
        <span className="spacer" />
        <Segmented
          label="Mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: '', label: 'All' },
            { value: 'paper', label: 'Paper' },
            { value: 'live', label: 'Live' },
          ]}
        />
        <select className="input" style={{ width: 'auto', minWidth: 150 }} value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market">
          <option value="">All markets</option>
          {(markets.data ?? []).map((m) => (
            <option key={m.market} value={m.market}>
              {m.market}
            </option>
          ))}
        </select>
      </div>

      <section className="card" style={{ padding: '8px 24px' }}>
        {state.error && (
          <div style={{ padding: '14px 0' }}>
            <ErrorBox error={state.error} onRetry={() => load()} />
          </div>
        )}
        {state.loading && rows.length === 0 && (
          <div className="stack" style={{ padding: '16px 0', gap: 12 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={22} />
            ))}
          </div>
        )}
        {!state.loading && !state.error && rows.length === 0 && (
          <EmptyState title={tab === 'orders' ? 'No orders yet' : 'No fills yet'}>
            {mode || market
              ? 'Nothing matches these filters.'
              : 'Once the bot is switched on and the strategy asks for a trade, it will show up here.'}
          </EmptyState>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            {tab === 'orders' ? <OrdersTable rows={rows as Order[]} /> : <FillsTable rows={rows as Fill[]} />}
          </div>
        )}
        {rows.length > 0 && !state.done && (
          <div className="row" style={{ justifyContent: 'center', padding: '14px 0 10px' }}>
            <button className="btn" disabled={state.loading} onClick={() => load(rows[rows.length - 1].id)}>
              {state.loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
        {rows.length > 0 && state.done && <p className="tiny muted" style={{ textAlign: 'center', padding: '12px 0' }}>That’s everything.</p>}
      </section>
    </div>
  );
}

function OrdersTable({ rows }: { rows: Order[] }) {
  return (
    <table className="data cards">
      <thead>
        <tr>
          <th>When</th>
          <th>Market</th>
          <th>Side</th>
          <th>Type</th>
          <th className="r">Price</th>
          <th className="r">Amount</th>
          <th className="r">Filled</th>
          <th className="r">Fee</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => {
          const filled = num(pick(o.filled, o.filledAmount));
          const amt = num(o.amount);
          const fee = pick(o.feeEur, o.feePaid, o.fee);
          return (
            <tr key={String(o.id)} title={o.reason ?? undefined}>
              <td data-label="When" className="nowrap">
                {dateTime(pick(o.createdAt, o.created_at))}
                {o.mode === 'live' && <span className="chip live" style={{ marginLeft: 8, padding: '0 7px' }}>live</span>}
              </td>
              <td data-label="Market">{o.market}</td>
              <td data-label="Side">
                <span className={`side ${o.side}`}>{o.side}</span>
              </td>
              <td data-label="Type" className="hide-sm">
                {pick(o.type, o.orderType) ?? '–'}
              </td>
              <td data-label="Price" className="r">
                {o.price === null || o.price === undefined ? <span className="muted">market</span> : price(o.price)}
              </td>
              <td data-label="Amount" className="r">
                {amount(amt)}
              </td>
              <td data-label="Filled" className="r">
                {Number.isFinite(filled) ? (amt ? `${Math.round((filled / amt) * 100)}%` : amount(filled)) : '–'}
              </td>
              <td data-label="Fee" className="r">
                {feeText(fee, o.feeCurrency)}
              </td>
              <td data-label="Status">{statusChip(o.status)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FillsTable({ rows }: { rows: Fill[] }) {
  return (
    <table className="data cards">
      <thead>
        <tr>
          <th>When</th>
          <th>Market</th>
          <th>Side</th>
          <th className="r">Price</th>
          <th className="r">Amount</th>
          <th className="r">Value</th>
          <th className="r">Fee</th>
          <th>Liquidity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => {
          const fee = pick(f.feeEur, f.fee);
          const liq = f.liquidity ?? (f.taker === undefined ? undefined : f.taker ? 'taker' : 'maker');
          return (
            <tr key={String(f.id)}>
              <td data-label="When" className="nowrap">
                {dateTime(pick(f.executedAt, f.ts, f.createdAt, f.created_at))}
                {f.mode === 'live' && <span className="chip live" style={{ marginLeft: 8, padding: '0 7px' }}>live</span>}
              </td>
              <td data-label="Market">{f.market}</td>
              <td data-label="Side">
                <span className={`side ${f.side}`}>{f.side}</span>
              </td>
              <td data-label="Price" className="r">
                {price(f.price)}
              </td>
              <td data-label="Amount" className="r">
                {amount(f.amount)}
              </td>
              <td data-label="Value" className="r">
                {eur(num(f.price) * num(f.amount))}
              </td>
              <td data-label="Fee" className="r">
                {feeText(fee, f.feeCurrency)}
              </td>
              <td data-label="Liquidity">{liq ? <span className={`chip ${liq === 'maker' ? 'gain' : 'brass'}`}>{liq}</span> : '–'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
