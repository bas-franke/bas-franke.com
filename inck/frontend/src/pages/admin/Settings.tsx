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
          <legend>Right now</legend>
          <p className="muted small" style={{ marginTop: 0 }}>
            Part of the articles follow what people are curious about today instead of an evergreen topic. The scout reads Google Trends,
            Wikipedia's most-read pages and Hacker News, searches the web, and picks one lightweight subject (no war, crime, politics or
            disasters).
          </p>
          <label className="slider">
            Share of "right now" articles: <strong>{s.trending_share}%</strong>
            <input type="range" min={0} max={100} step={5} value={s.trending_share} onChange={(e) => set('trending_share', Number(e.target.value))} />
          </label>
          <div className="fields">
            <label className="wide">
              Guidance for the scout
              <textarea rows={3} value={s.trending_guidance} onChange={(e) => set('trending_guidance', e.target.value)} />
            </label>
          </div>
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
              Cover image quality
              <select value={s.image_quality} onChange={(e) => set('image_quality', e.target.value as SettingsData['image_quality'])}>
                <option value="low">low (≈ ½ cent)</option>
                <option value="medium">medium (≈ 4 cents)</option>
                <option value="high">high (expensive)</option>
              </select>
            </label>
            <label>
              Inline figure quality
              <select value={s.figure_quality} onChange={(e) => set('figure_quality', e.target.value as SettingsData['figure_quality'])}>
                <option value="low">low (≈ ½ cent)</option>
                <option value="medium">medium (≈ 4 cents)</option>
                <option value="high">high (expensive)</option>
              </select>
            </label>
          </div>
          <label className="row">
            <input type="checkbox" checked={s.images_enabled} onChange={(e) => set('images_enabled', e.target.checked)} />
            Illustrate articles (cover image plus inline figures)
          </label>
          <div className="fields">
            <label>
              Images per article, at least
              <input type="number" min={1} max={8} value={s.images_min} onChange={(e) => set('images_min', Number(e.target.value))} />
            </label>
            <label>
              At most
              <input type="number" min={1} max={8} value={s.images_max} onChange={(e) => set('images_max', Number(e.target.value))} />
            </label>
          </div>
          <p className="muted small">
            The writer decides how many images each article needs within this range. Every image is one paid image request, so the
            maximum is the main cost lever. Any model name from your OpenAI account works; the gpt-5.4 mini/nano models are the cheapest
            current text models.
          </p>
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
