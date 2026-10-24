import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { CATEGORY_LABEL, CATEGORY_ORDER, type AdminTopic, type Category, type TopicKind } from '../../types';
import { useAdminCall } from './AdminApp';

export default function Topics({ onLoggedOut }: { onLoggedOut: () => void }) {
  const call = useAdminCall(onLoggedOut);
  const [topics, setTopics] = useState<AdminTopic[]>([]);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<number>();
  const [draft, setDraft] = useState({ name: '', description: '', category: 'world' as Category, kind: 'field' as TopicKind });

  const load = useCallback(() => call(() => api<AdminTopic[]>('/api/admin/topics')).then((t) => t && setTopics(t)).catch((e) => setError(e.message)), [call]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(undefined);
    try {
      await call(fn);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(undefined);
    }
  };

  const update = (id: number, patch: Partial<AdminTopic>) => act(id, () => api(`/api/admin/topics/${id}`, { method: 'PATCH', json: patch }));
  const plan = (t: AdminTopic) => act(t.id, () => api(`/api/admin/topics/${t.id}/plan`, { method: 'POST', json: { extend: t.sections > 0 } }));
  const writeNext = (t: AdminTopic) => act(t.id, () => api('/api/admin/generate', { method: 'POST', json: { topic_id: t.id } }));
  const remove = (t: AdminTopic) => {
    if (!confirm(`Delete “${t.name}” and its ${t.stories} ${t.stories === 1 ? 'story' : 'stories'}? This cannot be undone.`)) return;
    act(t.id, () => api(`/api/admin/topics/${t.id}`, { method: 'DELETE' }));
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await call(() => api('/api/admin/topics', { method: 'POST', json: draft }));
      setDraft({ name: '', description: '', category: 'world', kind: 'field' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="admin-page">
      <header className="admin-head">
        <div>
          <h1>Topics</h1>
          <p className="muted">
            Each topic gets a generated curriculum (sections of short standalone stories, from zero to deeper). The scheduler writes the next
            unwritten item of a random enabled topic, weighted and favouring topics with fewer stories; “right now” stories are filed into
            whichever topic fits, or a new one.
          </p>
        </div>
      </header>

      {error && <p className="form-error">{error}</p>}

      <form onSubmit={add} className="panel add-row add-row-topic">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="New topic, e.g. The Sudan civil war" required />
        <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="One line for the planner (optional)" />
        <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })} aria-label="Category">
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as TopicKind })} aria-label="Kind">
          <option value="field">Field (lasting subject)</option>
          <option value="event">Event (happening now)</option>
        </select>
        <button className="btn btn-primary" type="submit">
          Add topic
        </button>
      </form>

      <div className="topic-list">
        {topics.map((t) => (
          <TopicRow
            key={t.id}
            topic={t}
            busy={busyId === t.id}
            onChange={(patch) => update(t.id, patch)}
            onPlan={() => plan(t)}
            onWrite={() => writeNext(t)}
            onDelete={() => remove(t)}
          />
        ))}
      </div>
    </div>
  );
}

function TopicRow({
  topic,
  busy,
  onChange,
  onPlan,
  onWrite,
  onDelete,
}: {
  topic: AdminTopic;
  busy: boolean;
  onChange: (p: Partial<AdminTopic>) => void;
  onPlan: () => void;
  onWrite: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(topic.name);
  const [description, setDescription] = useState(topic.description);
  useEffect(() => {
    setName(topic.name);
    setDescription(topic.description);
  }, [topic]);
  const dirty = name !== topic.name || description !== topic.description;

  return (
    <div className={`panel topic ${topic.enabled ? '' : 'topic-off'}`}>
      <label className="switch" title={topic.enabled ? 'Enabled' : 'Disabled'}>
        <input type="checkbox" checked={topic.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        <span />
      </label>
      <div className="topic-fields">
        <input className="topic-name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="topic-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes for the planner" />
        <div className="topic-selects">
          <select value={topic.category} onChange={(e) => onChange({ category: e.target.value as Category })} aria-label="Category">
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <select value={topic.kind} onChange={(e) => onChange({ kind: e.target.value as TopicKind })} aria-label="Kind">
            <option value="field">Field</option>
            <option value="event">Event</option>
          </select>
          <Link to={`/t/${topic.slug}`} className="small">
            view hub →
          </Link>
        </div>
      </div>
      <label className="topic-weight" title="Relative chance of being picked">
        Weight
        <input type="range" min={0} max={10} value={topic.weight} onChange={(e) => onChange({ weight: Number(e.target.value) })} />
        <span className="mono">{topic.weight}</span>
      </label>
      <span className="muted small topic-count">
        {topic.stories} {topic.stories === 1 ? 'story' : 'stories'}
        <br />
        {topic.sections ? `${topic.written}/${topic.planned} planned written` : 'no curriculum yet'}
        {topic.heat > 0 && (
          <>
            <br />
            <span className="trend-heat" title={topic.heat_reason}>
              hot {topic.heat}/5
            </span>{' '}
            <button className="link-btn" onClick={() => onChange({ heat: 0 })} disabled={busy} type="button">
              cool down
            </button>
          </>
        )}
      </span>
      <div className="topic-actions">
        {dirty && (
          <button className="btn btn-primary" onClick={() => onChange({ name, description })} disabled={busy}>
            Save
          </button>
        )}
        <button className="btn" onClick={onPlan} disabled={busy} title={topic.sections ? 'Add new sections and items to the curriculum' : 'Generate the curriculum'}>
          {busy ? 'Working…' : topic.sections ? 'Extend plan' : 'Plan'}
        </button>
        <button className="btn" onClick={onWrite} disabled={busy} title="Write the next unwritten item now">
          Write next
        </button>
        <button className="btn btn-ghost danger" onClick={onDelete} disabled={busy} aria-label={`Delete ${topic.name}`}>
          Delete
        </button>
      </div>
    </div>
  );
}
