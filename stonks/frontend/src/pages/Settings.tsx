import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, unwrapFamilies, unwrapMarkets } from '../api';
import { ErrorBox, ModeBadge, Modal, Segmented, Skeleton, Tip, useAsync, useToast } from '../components/ui';
import { eur, familyLabel, humanize } from '../format';
import { navigate, takeHandoff } from '../router';
import { INTERVALS, type BotSettings, type FamilyInfo, type Interval, type MarketInfo, type ParamDescription, type StrategySpec } from '../types';

type Draft = Omit<BotSettings, 'enabled'>;

const normParams = (f?: FamilyInfo): (ParamDescription & { key: string })[] => {
  if (!f) return [];
  const raw = f.params;
  if (Array.isArray(raw)) return raw.map((p) => ({ ...p, key: p.key ?? p.name ?? '' })).filter((p) => p.key);
  return Object.entries(raw).map(([key, p]) => ({ ...p, key }));
};
const isMulti = (family: string, f?: FamilyInfo) => f?.multiMarket ?? family === 'rotation_momentum';

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).slice(0, 6).padStart(6, '0');
};
const specId = (s: StrategySpec) => {
  const m = s.markets.length === 1 ? s.markets[0].split('-')[0].toLowerCase() : `${s.markets.length}m`;
  return `${s.family}-${m}-${s.interval}-${hash(JSON.stringify([s.params, s.risk, s.execution, s.markets]))}`;
};

export default function SettingsPage() {
  const toast = useToast();
  const ov = useAsync(() => api.overview(), []);
  const fam = useAsync(() => api.families().then(unwrapFamilies), []);
  const mk = useAsync(() => api.markets().then(unwrapMarkets), []);
  const [handoff] = useState(() => takeHandoff<{ spec: StrategySpec; rank: number }>());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [liveAsk, setLiveAsk] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);

  useEffect(() => {
    if (!ov.data || draft) return;
    const { enabled: _e, ...rest } = ov.data.bot;
    setSaved(rest);
    setDraft(handoff ? { ...rest, strategy: structuredClone(handoff.spec) } : structuredClone(rest));
  }, [ov.data, draft, handoff]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (ov.error) return <ErrorBox error={ov.error} onRetry={ov.reload} />;
  if (!draft || !saved)
    return (
      <div className="stack">
        <Skeleton h={60} w="40%" />
        <div className="card">
          <Skeleton h={300} />
        </div>
      </div>
    );

  const families = fam.data ?? [];
  const markets: MarketInfo[] = mk.data ?? [];
  const s = draft.strategy;
  const family = families.find((f) => f.family === s.family);
  const params = normParams(family);
  const multi = isMulti(s.family, family);
  const err = (k: string) => errors[k] ?? errors[k.split('.').pop()!];

  const setStrategy = (patch: Partial<StrategySpec>) =>
    setDraft((d) => {
      if (!d) return d;
      const strategy = { ...d.strategy, ...patch };
      strategy.id = specId(strategy);
      return { ...d, strategy };
    });
  const setParam = (k: string, v: number | string | boolean) => setStrategy({ params: { ...s.params, [k]: v } });
  const setRisk = (k: keyof StrategySpec['risk'], v: number | null) => setStrategy({ risk: { ...s.risk, [k]: v } });
  const setExec = <K extends keyof StrategySpec['execution']>(k: K, v: StrategySpec['execution'][K]) =>
    setStrategy({ execution: { ...s.execution, [k]: v } });

  const pickFamily = (name: string) => {
    const f = families.find((x) => x.family === name);
    const defaults = Object.fromEntries(normParams(f).map((p) => [p.key, p.default ?? 0])) as StrategySpec['params'];
    const m = isMulti(name, f) ? markets.slice(0, 10).map((x) => x.market) : [s.markets[0] ?? 'BTC-EUR'];
    const base = m.length === 1 ? m[0].split('-')[0] : 'top-10';
    setStrategy({
      family: name,
      familyVersion: f?.familyVersion ?? f?.version ?? 1,
      params: defaults,
      markets: m,
      name: `${f?.name ?? f?.title ?? familyLabel(name)}, ${base} ${s.interval}`,
    });
  };

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      const patch: Partial<BotSettings> & { confirmLive?: boolean } = {
        mode: draft.mode,
        strategy: draft.strategy,
        maxExposureEur: draft.maxExposureEur,
        dailyLossLimitEur: draft.dailyLossLimitEur,
        paperStartEur: draft.paperStartEur,
      };
      if (draft.mode === 'live' && saved.mode !== 'live') patch.confirmLive = confirmLive;
      const res = await api.updateBot(patch);
      const { enabled: _e, ...rest } = res;
      setSaved(rest);
      setDraft(structuredClone(rest));
      setConfirmLive(false);
      toast('Saved. The bot uses the new settings from its next look at the market.');
    } catch (e) {
      if (e instanceof ApiError) {
        const fe = e.fieldErrors;
        setErrors(Object.keys(fe).length ? fe : { _: e.message, ...fieldFromMessage(e.message) });
      } else setErrors({ _: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const pctField = (label: string, k: keyof StrategySpec['risk'], hint: string) => (
    <Field label={label} error={err(`strategy.risk.${k}`)} hint={hint}>
      <Affix suffix="%">
        <input
          className="input"
          type="number"
          inputMode="decimal"
          min={0}
          step={0.5}
          placeholder="off"
          value={s.risk[k] === null ? '' : +(Number(s.risk[k]) * 100).toFixed(4)}
          onChange={(e) => setRisk(k, e.target.value === '' ? null : Number(e.target.value) / 100)}
          aria-invalid={!!err(`strategy.risk.${k}`)}
        />
      </Affix>
    </Field>
  );

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="page-head">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>How the bot behaves</h1>
          <p className="lede">Nothing changes until you press save. A running bot picks up new settings at its next check.</p>
        </div>
        <ModeBadge mode={saved.mode} />
      </div>

      {handoff && (
        <div className="callout brass" style={{ marginBottom: 18 }}>
          Prefilled with research pick #{handoff.rank}, <b>{handoff.spec.name}</b>. Look it over, then save to use it.
        </div>
      )}
      {fam.error && <ErrorBox error={fam.error} onRetry={fam.reload} />}

      <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
        <Section title="Strategy" intro="Which algorithm runs, on which market, and how often it looks.">
          <div className="form-grid">
            <Field label="Algorithm" error={err('strategy.family')}>
              <select className="input" value={s.family} onChange={(e) => pickFamily(e.target.value)}>
                {!family && <option value={s.family}>{familyLabel(s.family)} (not bot-ready)</option>}
                {families.map((f) => (
                  <option key={f.family} value={f.family}>
                    {f.name ?? f.title ?? familyLabel(f.family)}
                  </option>
                ))}
              </select>
            </Field>
            {!multi && (
              <Field label="Market" error={err('strategy.markets')}>
                <select className="input" value={s.markets[0] ?? ''} onChange={(e) => setStrategy({ markets: [e.target.value] })}>
                  {!markets.some((m) => m.market === s.markets[0]) && <option value={s.markets[0]}>{s.markets[0]}</option>}
                  {markets.map((m) => (
                    <option key={m.market} value={m.market}>
                      {m.market}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Candle interval" error={err('strategy.interval')} hint="How often it decides.">
              <select className="input" value={s.interval} onChange={(e) => setStrategy({ interval: e.target.value as Interval })}>
                {INTERVALS.map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </select>
            </Field>
            <Field label="Name" error={err('strategy.name')}>
              <input className="input" value={s.name} onChange={(e) => setStrategy({ name: e.target.value })} />
            </Field>
          </div>
          {(family?.description ?? family?.summary) && <p className="small soft" style={{ marginTop: 14 }}>{family?.description ?? family?.summary}</p>}
          {!family && fam.data && (
            <div className="callout loss" style={{ marginTop: 14 }}>
              “{familyLabel(s.family)}” isn’t implemented in the bot yet, so it can’t be saved. Pick one of the algorithms above.
            </div>
          )}
          {multi && (
            <div className="field" style={{ marginTop: 16 }}>
              <span className="label">Markets it may hold ({s.markets.length})</span>
              <div className="params">
                {[...new Set([...markets.slice(0, 20).map((x) => x.market), ...s.markets])].map((market) => {
                  const m = { market };
                  const on = s.markets.includes(m.market);
                  return (
                    <button
                      key={m.market}
                      type="button"
                      className={`chip ${on ? 'brass' : 'outline'}`}
                      style={{ cursor: 'pointer', border: on ? '1px solid transparent' : undefined }}
                      aria-pressed={on}
                      onClick={() => setStrategy({ markets: on ? s.markets.filter((x) => x !== m.market) : [...s.markets, m.market] })}
                    >
                      {m.market}
                    </button>
                  );
                })}
              </div>
              {err('strategy.markets') && <span className="error">{err('strategy.markets')}</span>}
            </div>
          )}
          {params.length > 0 && (
            <>
              <div className="eyebrow" style={{ margin: '22px 0 12px' }}>
                Parameters
              </div>
              <div className="form-grid">
                {params.map((p) => (
                  <ParamInput key={p.key} p={p} value={s.params[p.key]} onChange={(v) => setParam(p.key, v)} error={err(`strategy.params.${p.key}`)} />
                ))}
              </div>
            </>
          )}
        </Section>

        <Section title="Placing orders" intro="Limit orders rest on the book and pay the lower maker fee; market orders fill at once and pay taker.">
          <div className="form-grid">
            <Field label="Order type">
              <Segmented
                label="Order type"
                value={s.execution.orderType}
                onChange={(v) => setExec('orderType', v)}
                options={[
                  { value: 'limit', label: 'Limit' },
                  { value: 'market', label: 'Market' },
                ]}
              />
            </Field>
            {s.execution.orderType === 'limit' && (
              <>
                <Field
                  label="Limit offset"
                  error={err('strategy.execution.limitOffsetBps')}
                  hint="Buy this far under the close, sell this far over it. 100 bps = 1%."
                >
                  <Affix suffix="bps">
                    <input
                      className="input"
                      type="number"
                      min={0}
                      step={1}
                      value={s.execution.limitOffsetBps}
                      onChange={(e) => setExec('limitOffsetBps', Number(e.target.value))}
                      aria-invalid={!!err('strategy.execution.limitOffsetBps')}
                    />
                  </Affix>
                </Field>
                <Field label="Give up after" error={err('strategy.execution.timeoutBars')} hint="Candles an unfilled order may wait.">
                  <Affix suffix="bars">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      step={1}
                      value={s.execution.timeoutBars}
                      onChange={(e) => setExec('timeoutBars', Number(e.target.value))}
                    />
                  </Affix>
                </Field>
                <Field label="Then" hint="Skip the trade, or pay taker to get it done.">
                  <select className="input" value={s.execution.fallback} onChange={(e) => setExec('fallback', e.target.value as 'cancel' | 'market')}>
                    <option value="cancel">Cancel it</option>
                    <option value="market">Fill at market</option>
                  </select>
                </Field>
              </>
            )}
          </div>
          {s.execution.orderType === 'limit' && (
            <label className="check" style={{ marginTop: 16 }}>
              <input type="checkbox" checked={s.execution.postOnly} onChange={(e) => setExec('postOnly', e.target.checked)} />
              Post-only: never pay the taker fee on a limit order
            </label>
          )}
        </Section>

        <Section title="Risk" intro="Guard rails. Leave a stop empty to switch it off.">
          <div className="form-grid">
            <Field
              label="Max in coins"
              error={err('maxExposureEur')}
              hint="Most it may have in crypto at once. Empty = the whole portfolio."
            >
              <Affix suffix="€">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={10}
                  placeholder="whole portfolio"
                  value={draft.maxExposureEur ?? ''}
                  onChange={(e) => setDraft({ ...draft, maxExposureEur: e.target.value === '' ? null : Number(e.target.value) })}
                  aria-invalid={!!err('maxExposureEur')}
                />
              </Affix>
            </Field>
            <Field label="Daily loss limit" error={err('dailyLossLimitEur')} hint="Lose this much in one day and the bot switches itself off.">
              <Affix suffix="€">
                <input
                  className="input"
                  type="number"
                  min={1}
                  step={10}
                  value={draft.dailyLossLimitEur}
                  onChange={(e) => setDraft({ ...draft, dailyLossLimitEur: Number(e.target.value) })}
                  aria-invalid={!!err('dailyLossLimitEur')}
                />
              </Affix>
            </Field>
            <Field label="Max weight" error={err('strategy.risk.maxWeight')} hint="Share of equity it may put in coins (100% = all).">
              <Affix suffix="%">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={+(s.risk.maxWeight * 100).toFixed(2)}
                  onChange={(e) => setRisk('maxWeight', Number(e.target.value) / 100)}
                />
              </Affix>
            </Field>
            {pctField('Stop-loss', 'stopLossPct', 'Sell if the price falls this far under the average buy price.')}
            {pctField('Take-profit', 'takeProfitPct', 'Sell once the price is this far above it.')}
            {pctField('Trailing stop', 'trailingStopPct', 'Sell if the price drops this far from its best level since buying.')}
          </div>
        </Section>

        <Section title="Fees" intro="Your Bitvavo fee tier. Every backtest and the paper wallet use the same numbers.">
          <dl className="kv" style={{ maxWidth: 360 }}>
            <dt>
              Maker <span className="tiny">(limit orders that wait)</span>
            </dt>
            <dd>{(draft.fees.maker * 100).toFixed(2)}%</dd>
            <dt>
              Taker <span className="tiny">(orders that fill at once)</span>
            </dt>
            <dd>{(draft.fees.taker * 100).toFixed(2)}%</dd>
          </dl>
        </Section>

        <Section title="Paper or live" intro="Paper simulates orders on live prices. Live places real orders with real money.">
          <div className="stack" style={{ gap: 16 }}>
            <Segmented
              label="Mode"
              value={draft.mode}
              onChange={(v) => {
                if (v === 'live' && saved.mode !== 'live') {
                  setLiveText('');
                  setLiveAsk(true);
                } else {
                  setConfirmLive(false);
                  setDraft({ ...draft, mode: v });
                }
              }}
              options={[
                { value: 'paper', label: 'Paper (practice)' },
                { value: 'live', label: 'Live (real money)' },
              ]}
            />
            {err('mode') && <span className="error small">{err('mode')}</span>}
            {draft.mode === 'live' && saved.mode !== 'live' && (
              <div className="callout loss">Live mode is selected but not saved yet. Saving switches the bot to real orders.</div>
            )}
            <div className="form-grid">
              <Field label="Paper starting money" error={err('paperStartEur')} hint="What the practice wallet starts with.">
                <Affix suffix="€">
                  <input
                    className="input"
                    type="number"
                    min={10}
                    step={100}
                    value={draft.paperStartEur}
                    onChange={(e) => setDraft({ ...draft, paperStartEur: Number(e.target.value) })}
                    aria-invalid={!!err('paperStartEur')}
                  />
                </Affix>
              </Field>
            </div>
          </div>
        </Section>
      </div>

      {(dirty || errors._) && (
        <div className="save-bar">
          <span className={`small ${errors._ || Object.keys(errors).length ? 'loss' : 'soft'}`} style={{ minWidth: 0 }}>
            {errors._ ?? (Object.keys(errors).length ? 'Some fields need a look.' : 'You have unsaved changes.')}
          </span>
          <span className="spacer" />
          <button
            className="btn ghost small"
            onClick={() => {
              setDraft(structuredClone(saved));
              setErrors({});
              setConfirmLive(false);
              if (handoff) navigate('/settings', { replace: true });
            }}
          >
            Discard
          </button>
          <button className={`btn ${draft.mode === 'live' && saved.mode !== 'live' ? 'danger' : 'primary'}`} disabled={saving || !dirty || (!family && !!fam.data)} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      <Modal
        open={liveAsk}
        onClose={() => setLiveAsk(false)}
        title="Switch to live trading?"
        actions={
          <>
            <button className="btn ghost" onClick={() => setLiveAsk(false)}>
              Stay on paper
            </button>
            <button
              className="btn danger"
              disabled={liveText.trim().toUpperCase() !== 'LIVE'}
              onClick={() => {
                setConfirmLive(true);
                setDraft({ ...draft, mode: 'live' });
                setLiveAsk(false);
              }}
            >
              Use real money
            </button>
          </>
        }
      >
        <div className="callout loss">
          In live mode the bot places <b>real orders</b> on your Bitvavo account with <b>real euros</b>. It can lose money, up to{' '}
          {eur(draft.dailyLossLimitEur, true)} a day before it stops itself.
        </div>
        <p className="small">Backtests are not promises. Consider starting with a small max-in-coins amount.</p>
        <div className="field">
          <label htmlFor="live-confirm">
            Type <b>LIVE</b> to confirm
          </label>
          <input id="live-confirm" className="input" autoComplete="off" value={liveText} onChange={(e) => setLiveText(e.target.value)} />
        </div>
      </Modal>
    </div>
  );
}

/** The API answers with one sentence; when it names a field ("execution.limitOffsetBps must be…"), show it there too. */
function fieldFromMessage(msg: string): Record<string, string> {
  const short = msg.replace(/^Strategy is not valid:\s*(Invalid strategy:\s*)?/i, '');
  const strat = /(execution|risk|params)\.(\w+)/.exec(msg);
  if (strat) return { [`strategy.${strat[1]}.${strat[2]}`]: short };
  const top = /(maxExposureEur|dailyLossLimitEur|paperStartEur|mode)/.exec(msg);
  if (top) return { [top[1]]: short };
  const s = /(markets|interval|name|family)/.exec(short);
  if (s && /strategy/i.test(msg)) return { [`strategy.${s[1]}`]: short };
  return {};
}

function Section({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="intro">
        <h3>{title}</h3>
        <p>{intro}</p>
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </section>
  );
}

function Field({ label, hint, error, children }: { label: ReactNode; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

const Affix = ({ suffix, children }: { suffix: string; children: ReactNode }) => (
  <div className="input-affix">
    {children}
    <span className="affix">{suffix}</span>
  </div>
);

function ParamInput({
  p,
  value,
  onChange,
  error,
}: {
  p: ParamDescription & { key: string };
  value: number | string | boolean | undefined;
  onChange: (v: number | string | boolean) => void;
  error?: string;
}) {
  const label = (
    <>
      {p.label ?? humanize(p.key)}
      {p.description && <Tip align="left">{p.description}</Tip>}
    </>
  );
  const t = p.type ?? (typeof p.default === 'boolean' ? 'boolean' : p.options ? 'enum' : 'number');
  if (t === 'boolean' || t === 'bool')
    return (
      <Field label={label} error={error}>
        <label className="check" style={{ minHeight: 42 }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {value ? 'Yes' : 'No'}
        </label>
      </Field>
    );
  if (t === 'enum' || p.options)
    return (
      <Field label={label} error={error}>
        <select className="input" value={String(value ?? p.default ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(p.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </Field>
    );
  if (t === 'string')
    return (
      <Field label={label} error={error}>
        <input className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  const int = t === 'int' || t === 'integer';
  return (
    <Field label={label} error={error} hint={p.min !== undefined && p.max !== undefined ? `${p.min} to ${p.max}` : undefined}>
      <input
        className="input"
        type="number"
        inputMode={int ? 'numeric' : 'decimal'}
        min={p.min}
        max={p.max}
        step={p.step ?? (int ? 1 : 'any')}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        aria-invalid={!!error}
      />
    </Field>
  );
}
