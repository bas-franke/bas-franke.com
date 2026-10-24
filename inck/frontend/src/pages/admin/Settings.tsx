import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Settings as SettingsData } from '../../types';
import { useAdminCall } from './AdminApp';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function Settings({ onLoggedOut }: { onLoggedOut: () => void }) {
  const call = useAdminCall(onLoggedOut);
  const [s, setS] = useState<SettingsData>();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call(() => api<SettingsData>('/api/admin/settings')).then((d) => d && setS(d)).catch((e) => setError(e.message));
  }, [call]);

  if (!s) return <div className="admin-page">{error && <p className="form-error">{error}</p>}</div>;

  const set = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => setS({ ...s, [key]: value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const { last_run_at: _lr, ...body } = s!;
      const next = await call(() => api<SettingsData>('/api/admin/settings', { method: 'PUT', json: body }));
      if (next) setS(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-page">
      <header className="admin-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">How often, about what, and in which voice.</p>
        </div>
      </header>

      <form onSubmit={save} className="form">
        <fieldset className="panel">
          <legend>Schedule</legend>
          <label className="row">
            <input type="checkbox" checked={s.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Generate articles automatically
          </label>
          <div className="fields">
            <label>
              Every (minutes)
              <input type="number" min={5} max={10080} value={s.interval_minutes} onChange={(e) => set('interval_minutes', Number(e.target.value))} />
            </label>
            <label>
              Max per 24 hours
              <input type="number" min={1} max={200} value={s.max_per_day} onChange={(e) => set('max_per_day', Number(e.target.value))} />
            </label>
            <label>
              Active from
              <select value={s.active_hours_start ?? ''} onChange={(e) => set('active_hours_start', e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Always</option>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </select>
            </label>
            <label>
              Until
              <select value={s.active_hours_end ?? ''} onChange={(e) => set('active_hours_end', e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Always</option>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </select>
            </label>
            <label>
              Timezone
              <input value={s.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Europe/Amsterdam" />
            </label>
          </div>
        </fieldset>

        <fieldset className="panel">
          <legend>Writing</legend>
          <div className="fields">
            <label>
              Language
              <input value={s.language} onChange={(e) => set('language', e.target.value)} />
            </label>
            <label>
              Target length (words)
              <input type="number" min={200} max={4000} step={50} value={s.target_words} onChange={(e) => set('target_words', Number(e.target.value))} />
            </label>
            <label className="wide">
              Tone
              <input value={s.tone} onChange={(e) => set('tone', e.target.value)} />
            </label>
            <label className="wide">
              Audience
              <input value={s.audience} onChange={(e) => set('audience', e.target.value)} />
            </label>
            <label className="wide">
              Extra instructions for the writer
              <textarea rows={4} value={s.extra_instructions} onChange={(e) => set('extra_instructions', e.target.value)} placeholder="e.g. Always end with a practical takeaway. Avoid politics." />
            </label>
          </div>
          <label className="row">
            <input type="checkbox" checked={s.web_search_enabled} onChange={(e) => set('web_search_enabled', e.target.checked)} />
            Let the model search the web for fresh facts and sources
          </label>
          <label className="row">
            <input type="checkbox" checked={s.charts_enabled} onChange={(e) => set('charts_enabled', e.target.checked)} />
            Include data charts when there is something worth charting
          </label>
        </fieldset>

        <fieldset className="panel">
          <legend>Models</legend>
          <div className="fields">
            <label>
              Text model
              <input value={s.text_model} onChange={(e) => set('text_model', e.target.value)} className="mono" />
            </label>
            <label>
              Image model
              <input value={s.image_model} onChange={(e) => set('image_model', e.target.value)} className="mono" />
            </label>
            <label>
              Image quality
              <select value={s.image_quality} onChange={(e) => set('image_quality', e.target.value as SettingsData['image_quality'])}>
                <option value="low">low (cheapest)</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
          </div>
          <label className="row">
            <input type="checkbox" checked={s.images_enabled} onChange={(e) => set('images_enabled', e.target.checked)} />
            Generate a hero illustration for every article
          </label>
          <p className="muted small">Any model name from your OpenAI account works. Reasoning models (gpt-5 family) run with low reasoning effort.</p>
        </fieldset>

        <fieldset className="panel">
          <legend>Site</legend>
          <div className="fields">
            <label>
              Site name
              <input value={s.site_name} onChange={(e) => set('site_name', e.target.value)} />
            </label>
            <label className="wide">
              Tagline
              <input value={s.tagline} onChange={(e) => set('tagline', e.target.value)} />
            </label>
          </div>
        </fieldset>

        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          {saved && <span className="saved">Saved</span>}
        </div>
      </form>
    </div>
  );
}
