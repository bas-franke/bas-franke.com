import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Art } from '../art/Art';
import { COVERS } from '../art/slots';
import { SaveStatus } from '../components/SaveStatus';
import { ago } from '../dates';
import { Link, navigate } from '../router';
import { createNote, deleteNote, updateNote, useStore, type Note } from '../store';

/** Id of a note just created, whose title should take focus once the editor shows. */
let focusTitleFor = '';

const snippet = (body: string) => body.replace(/\s+/g, ' ').trim().slice(0, 120);

/** Keeps the caret where it was when the text of a focused field is replaced from outside (another tab). */
function useKeepCaret<T extends HTMLInputElement | HTMLTextAreaElement>(value: string) {
  const ref = useRef<T>(null);
  const sel = useRef({ s: 0, e: 0 });
  const remember = () => {
    const el = ref.current;
    if (el) sel.current = { s: el.selectionStart ?? 0, e: el.selectionEnd ?? 0 };
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    const { s, e } = sel.current;
    if (el.selectionStart !== s || el.selectionEnd !== e) el.setSelectionRange(Math.min(s, value.length), Math.min(e, value.length));
  }, [value]);
  return { ref, onSelect: remember, onChange: remember };
}

function Editor({ note }: { note: Note }) {
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState(false);
  const title = useKeepCaret<HTMLInputElement>(note.title);
  const body = useKeepCaret<HTMLTextAreaElement>(note.body);

  useEffect(() => {
    setConfirming(false);
    setPicking(false);
  }, [note.id]);

  useEffect(() => {
    if (focusTitleFor === note.id) {
      focusTitleFor = '';
      title.ref.current?.focus();
    }
  }, [note.id, title.ref]);

  useLayoutEffect(() => {
    const el = body.ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 220)}px`;
  }, [note.body, note.id, body.ref]);

  const cover = note.cover || 'cover-books';

  return (
    <article className="ne" key={note.id}>
      <Link to="/notes" className="ne-back">‹ All notes</Link>
      <div className="ne-cover">
        <Art slot={cover} className="ne-cover-art" />
        <div className="ne-cover-tools">
          <button className="chip" onClick={() => setPicking((p) => !p)} aria-expanded={picking}>Change cover</button>
          <button className={`chip${note.pinned ? ' on' : ''}`} onClick={() => updateNote(note.id, { pinned: !note.pinned })} aria-pressed={note.pinned}>
            {note.pinned ? 'Pinned' : 'Pin'}
          </button>
        </div>
      </div>
      {picking && (
        <div className="ne-covers" role="listbox" aria-label="Cover">
          {COVERS.map((c) => (
            <button
              key={c}
              role="option"
              aria-selected={c === cover}
              className={`ne-pick${c === cover ? ' on' : ''}`}
              onClick={() => updateNote(note.id, { cover: c })}
              title={c.replace('cover-', '')}
            >
              <Art slot={c} />
            </button>
          ))}
        </div>
      )}
      <input
        ref={title.ref}
        className="ne-title"
        placeholder="Untitled"
        value={note.title}
        onChange={(e) => {
          title.onChange();
          updateNote(note.id, { title: e.target.value });
        }}
        onSelect={title.onSelect}
        aria-label="Title"
      />
      <div className="ne-meta">
        <span>Edited {ago(note.updatedAt)}</span>
        <SaveStatus compact />
        <span className="ne-spacer" />
        {confirming ? (
          <span className="ne-confirm">
            Delete this note?
            <button className="chip danger" onClick={() => { deleteNote(note.id); navigate('/notes'); }}>Yes, delete</button>
            <button className="chip" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <button className="chip quiet" onClick={() => setConfirming(true)}>Delete</button>
        )}
      </div>
      <textarea
        ref={body.ref}
        className="ne-body"
        placeholder="Start writing…"
        value={note.body}
        onChange={(e) => {
          body.onChange();
          updateNote(note.id, { body: e.target.value });
        }}
        onSelect={body.onSelect}
        aria-label="Note"
      />
    </article>
  );
}

export default function Notes({ path }: { path: string }) {
  const notes = useStore((s) => s.notes);
  const [q, setQ] = useState('');
  const id = path.split('/')[2] || '';
  const current = notes.find((n) => n.id === id);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const found = t ? notes.filter((n) => n.title.toLowerCase().includes(t) || n.body.toLowerCase().includes(t)) : notes;
    return [...found.filter((n) => n.pinned), ...found.filter((n) => !n.pinned)];
  }, [notes, q]);

  const add = () => {
    const n = createNote();
    focusTitleFor = n.id;
    setQ('');
    navigate(`/notes/${n.id}`);
  };

  return (
    <div className={`notes${id ? ' editing' : ''}`}>
      <section className="nl">
        <div className="nl-banner"><Art slot="banner-notes" className="nl-banner-art" /><h1>Notes</h1></div>
        <div className="nl-bar">
          <input className="nl-search" type="search" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
          <button className="btn" onClick={add}>New note</button>
        </div>
        {notes.length === 0 ? (
          <div className="nl-empty"><Art slot="empty-notes" className="empty-art" /><p>No notes yet. Write the first one.</p></div>
        ) : list.length === 0 ? (
          <div className="nl-empty"><Art slot="empty-search" className="empty-art" /><p>Nothing matches "{q}".</p></div>
        ) : (
          <ul className="nl-list">
            {list.map((n) => (
              <li key={n.id}>
                <Link to={`/notes/${n.id}`} className={`nl-row${n.id === id ? ' on' : ''}`}>
                  <span className="nl-thumb"><Art slot={n.cover || 'cover-books'} /></span>
                  <span className="nl-text">
                    <strong>{n.pinned && <i className="nl-pin" aria-label="Pinned">★</i>}{n.title || 'Untitled'}</strong>
                    <span className="nl-snip">{snippet(n.body) || 'Empty note'}</span>
                    <small>{ago(n.updatedAt)}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="ne-wrap">
        {current ? (
          <Editor note={current} />
        ) : (
          <div className="ne-none">
            <Art slot="empty-notes" className="empty-art" />
            <p>{id ? 'That note is gone.' : 'Pick a note or start a new one.'}</p>
            {id && <Link to="/notes" className="btn ghost">Back to notes</Link>}
          </div>
        )}
      </section>
    </div>
  );
}
