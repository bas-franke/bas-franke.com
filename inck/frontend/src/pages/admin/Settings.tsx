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
            Write stories automatically
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
              Story length (words)
              <input type="number" min={80} max={600} step={10} value={s.target_words} onChange={(e) => set('target_words', Number(e.target.value))} />
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
              <textarea rows={4} value={s.extra_instructions} onChange={(e) => set('extra_instructions', e.target.value)} placeholder="e.g. End every story with a question to think about." />
            </label>
          </div>
          <label className="row">
            <input type="checkbox" checked={s.web_search_enabled} onChange={(e) => set('web_search_enabled', e.target.checked)} />
            Let the model search the web (used for “right now” stories, event topics and their curricula)
          </label>
          <p className="muted small">
            Every story is written to stand alone: no prior knowledge, every term explained, one idea per story, told as a short story rather
            than a lecture.
          </p>
        </fieldset>

        <fieldset className="panel">
          <legend>Right now</legend>
          <p className="muted small" style={{ marginTop: 0 }}>
            The trend radar discovers by itself what the world is talking about: it reads news headlines (BBC, NYT), Google Trends, Wikipedia's
            most-read pages and Hacker News, searches the web, and turns each trend into a topic with a heat score (a conflict, a crash, a
            crisis, a technology), curriculum and history included. “Right now” stories serve those hot topics, hottest first, and curriculum
            runs favour them too; hot topics are shown prominently on the site.
          </p>
          <label className="slider">
            Share of “right now” stories: <strong>{s.trending_share}%</strong>
            <input type="range" min={0} max={100} step={5} value={s.trending_share} onChange={(e) => set('trending_share', Number(e.target.value))} />
          </label>
          <div className="fields">
            <label>
              Rescan trends every (hours)
              <input type="number" min={1} max={48} value={s.radar_hours} onChange={(e) => set('radar_hours', Number(e.target.value))} />
            </label>
            <label className="wide">
              National news for (country codes, e.g. NL, US, GB)
              <input
                value={(s.local_countries ?? []).join(', ')}
                onChange={(e) => set('local_countries', e.target.value.toUpperCase().split(',').map((c) => c.trim()))}
              />
              <span className="muted small">
                The radar also looks for what people in these countries are talking about. Those topics only appear in the feed of visitors
                from that country (by IP); anyone can still find them under Topics or in search. Leave empty for global news only.
              </span>
            </label>
            <label className="wide">
              Guidance for the radar and scout
              <textarea rows={3} value={s.trending_guidance} onChange={(e) => set('trending_guidance', e.target.value)} />
            </label>
          </div>
        </fieldset>

        <fieldset className="panel">
          <legend>Pictures</legend>
          <label className="row">
            <input type="checkbox" checked={s.images_enabled} onChange={(e) => set('images_enabled', e.target.checked)} />
            Allow pictures
          </label>
          <p className="muted small" style={{ marginTop: 0 }}>
            Pictures follow relevance: a story in a topic everyone is talking about (heat 4–5) always gets at least one, a warm topic (2–3)
            gets one when it helps, and stories in cool topics only get one when it is essential.
          </p>
          <div className="fields">
            <label>
              At most per story
              <select value={s.images_max} onChange={(e) => set('images_max', Number(e.target.value))}>
                <option value={0}>0</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
            <label>
              Image model
              <input value={s.image_model} onChange={(e) => set('image_model', e.target.value)} className="mono" />
            </label>
            <label>
              Quality
              <select value={s.image_quality} onChange={(e) => set('image_quality', e.target.value as SettingsData['image_quality'])}>
                <option value="low">low (≈ ½ cent)</option>
                <option value="medium">medium (≈ 4 cents)</option>
                <option value="high">high (expensive)</option>
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className="panel">
          <legend>Text model</legend>
          <div className="fields">
            <label>
              Model
              <input value={s.text_model} onChange={(e) => set('text_model', e.target.value)} className="mono" />
            </label>
          </div>
          <p className="muted small">
            Used for planning curricula, scouting and writing. Any model name from your OpenAI account works; gpt-5.4-mini is a good balance
            of quality and price for 200-word stories, gpt-5.4-nano is cheaper.
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
