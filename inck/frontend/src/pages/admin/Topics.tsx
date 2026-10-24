import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Topic } from '../../types';
import { useAdminCall } from './AdminApp';

export default function Topics({ onLoggedOut }: { onLoggedOut: () => void }) {
  const call = useAdminCall(onLoggedOut);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState({ name: '', description: '' });

  const load = useCallback(() => call(() => api<Topic[]>('/api/admin/topics')).then((t) => t && setTopics(t)).catch((e) => setError(e.message)), [call]);
  useEffect(() => {
    load();
  }, [load]);

  const update = async (id: number, patch: Partial<Topic>) => {
    setError(undefined);
    try {
      await call(() => api(`/api/admin/topics/${id}`, { method: 'PATCH', json: patch }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (t: Topic) => {
    if (!confirm(`Delete topic “${t.name}”? Its ${t.articles} article(s) stay but lose their topic.`)) return;
    await call(() => api(`/api/admin/topics/${t.id}`, { method: 'DELETE' })).catch((e) => setError(e.message));
    load();
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await call(() => api('/api/admin/topics', { method: 'POST', json: draft }));
      setDraft({ name: '', description: '' });
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
          <p className="muted">The scheduler picks a random enabled topic, weighted, favouring ones that had fewer articles this week.</p>
        </div>
      </header>

      {error && <p className="form-error">{error}</p>}

      <form onSubmit={add} className="panel add-row">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="New topic, e.g. Ocean science" required />
        <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Notes for the writer (optional)" />
        <button className="btn btn-primary" type="submit">
          Add topic
        </button>
      </form>

      <div className="topic-list">
        {topics.map((t) => (
          <TopicRow key={t.id} topic={t} onChange={(patch) => update(t.id, patch)} onDelete={() => remove(t)} />
        ))}
      </div>
    </div>
  );
}

function TopicRow({ topic, onChange, onDelete }: { topic: Topic; onChange: (p: Partial<Topic>) => void; onDelete: () => void }) {
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
        <input className="topic-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes for the writer" />
      </div>
      <label className="topic-weight" title="Relative chance of being picked">
        Weight
        <input type="range" min={0} max={10} value={topic.weight} onChange={(e) => onChange({ weight: Number(e.target.value) })} />
        <span className="mono">{topic.weight}</span>
      </label>
      <span className="muted small topic-count">{topic.articles} articles</span>
      <div className="topic-actions">
        {dirty && (
          <button className="btn btn-primary" onClick={() => onChange({ name, description })}>
            Save
          </button>
        )}
        <button className="btn btn-ghost danger" onClick={onDelete} aria-label={`Delete ${topic.name}`}>
          Delete
        </button>
      </div>
    </div>
  );
}
