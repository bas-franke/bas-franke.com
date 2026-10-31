import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Art } from '../art/Art';
import { addDays, dueLabel, dueState, todayStr } from '../dates';
import { createTask, deleteTask, moveTask, updateTask, useStore, type Status, type Task } from '../store';

const COLUMNS: { status: Status; title: string; hint: string }[] = [
  { status: 'todo', title: 'To do', hint: 'Things waiting for you' },
  { status: 'doing', title: 'In progress', hint: 'What you are on right now' },
  { status: 'done', title: 'Done', hint: 'Worth a little celebration' },
];
const TITLE: Record<Status, string> = { todo: 'To do', doing: 'In progress', done: 'Done' };

interface DragState {
  id: string;
  /** Drop target while dragging: column and the card to insert before (null = end). */
  over: { status: Status; before: string | null } | null;
}

export default function Board() {
  const tasks = useStore((s) => s.tasks);
  const ready = useStore((s) => s.ready);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [tab, setTab] = useState<Status>('todo');

  const cols = useMemo(() => {
    const out: Record<Status, Task[]> = { todo: [], doing: [], done: [] };
    for (const t of tasks) out[t.status].push(t);
    for (const k of Object.keys(out) as Status[]) out[k].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    return out;
  }, [tasks]);

  const total = tasks.length;
  const open = cols.todo.length + cols.doing.length;

  const dropOn = (status: Status, before: string | null) => {
    if (drag && drag.id !== before) moveTask(drag.id, status, before);
    setDrag(null);
  };

  return (
    <div className="board-page">
      <header className="board-banner">
        <Art slot="banner-board" className="board-banner-art" />
        <div className="board-banner-text">
          <h1>Board</h1>
          <p>{total ? `${open} open, ${cols.done.length} done` : 'A quiet wall, ready for its first card'}</p>
        </div>
      </header>

      <div className="board-tabs" role="tablist">
        {COLUMNS.map((c) => (
          <button key={c.status} role="tab" aria-selected={tab === c.status} className={`board-tab ${tab === c.status ? 'on' : ''}`} onClick={() => setTab(c.status)}>
            {c.title} <span>{cols[c.status].length}</span>
          </button>
        ))}
      </div>

      {ready && total === 0 && (
        <div className="board-empty">
          <Art slot="empty-board" className="board-empty-art" />
          <h2>Nothing on the board yet</h2>
          <p>Add your first card below, then drag it along as it moves.</p>
        </div>
      )}

      <div className="board-cols" onDragEnd={() => setDrag(null)}>
        {COLUMNS.map((c) => (
          <Column
            key={c.status}
            {...c}
            active={tab === c.status}
            tasks={cols[c.status]}
            drag={drag}
            setDrag={setDrag}
            dropOn={dropOn}
            onAdd={(title) => createTask({ title, status: c.status })}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  status, title, hint, active, tasks, drag, setDrag, dropOn, onAdd,
}: {
  status: Status; title: string; hint: string; active: boolean; tasks: Task[]; drag: DragState | null;
  setDrag: (d: DragState | null) => void; dropOn: (s: Status, before: string | null) => void;
  onAdd: (title: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const over = drag?.over?.status === status ? drag.over : null;

  const onOver = (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    let before: string | null = null;
    const cards = listRef.current?.querySelectorAll<HTMLElement>('[data-card]') ?? [];
    for (const el of cards) {
      if (el.dataset.card === drag.id) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { before = el.dataset.card!; break; }
    }
    if (drag.over?.status !== status || drag.over.before !== before) setDrag({ ...drag, over: { status, before } });
  };

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  };

  return (
    <section
      className={`board-col col-${status} ${active ? 'active' : ''} ${over ? 'is-over' : ''}`}
      onDragOver={onOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node) && drag?.over?.status === status) setDrag({ ...drag, over: null }); }}
      onDrop={(e) => { e.preventDefault(); if (over) dropOn(status, over.before); }}
    >
      <header className="col-head">
        <Art slot={`column-${status}`} className="col-head-art" />
        <div className="col-head-text">
          <h2>{title} <span className="col-count">{tasks.length}</span></h2>
          <p>{hint}</p>
        </div>
      </header>

      <div className="col-list" ref={listRef}>
        {tasks.map((t) => (
          <div key={t.id} className="col-slot">
            {over?.before === t.id && drag?.id !== t.id && <div className="drop-line" />}
            <Card task={t} dragging={drag?.id === t.id} setDrag={setDrag} />
          </div>
        ))}
        {over && over.before === null && <div className="drop-line" />}
        {tasks.length === 0 && !over && (
          <div className="col-empty">
            <Art slot="empty-column" className="col-empty-art" />
            <p>Nothing here yet</p>
          </div>
        )}
      </div>

      <form className="col-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a card…" aria-label={`Add a card to ${title}`} />
        <button type="submit" className="col-add-btn" disabled={!draft.trim()} aria-label="Add card">+</button>
      </form>
    </section>
  );
}

function Card({ task, dragging, setDrag }: {
  task: Task; dragging: boolean; setDrag: (d: DragState | null) => void;
}) {
  const done = task.status === 'done';
  const state = dueState(task.due, done);
  const [openDetails, setOpenDetails] = useState(!!task.details);
  const [confirm, setConfirm] = useState(false);
  const [title, setTitle] = useState(task.title);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const editing = useRef(false);

  // Follow remote changes unless this card's title is being typed in.
  useEffect(() => { if (!editing.current) setTitle(task.title); }, [task.title]);
  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [title]);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3500);
    return () => clearTimeout(t);
  }, [confirm]);

  const others = (['todo', 'doing', 'done'] as Status[]).filter((s) => s !== task.status);
  const today = todayStr();

  return (
    <article
      ref={cardRef}
      data-card={task.id}
      className={`card due-${state} ${done ? 'is-done' : ''} ${dragging ? 'is-dragging' : ''}`}
    >
      <div className="card-top">
        <span
          className="card-grip"
          draggable
          title="Drag to move"
          aria-hidden="true"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', task.id);
            if (cardRef.current) e.dataTransfer.setDragImage(cardRef.current, 24, 18);
            // Defer so the browser snapshots the drag image before the card dims.
            setTimeout(() => setDrag({ id: task.id, over: null }), 0);
          }}
        >
          <i /><i /><i /><i /><i /><i />
        </span>
        <button
          className={`card-check ${done ? 'on' : ''}`}
          aria-label={done ? 'Mark as to do' : 'Mark as done'}
          onClick={() => moveTask(task.id, done ? 'todo' : 'done')}
        >
          {done ? '✓' : ''}
        </button>
        <textarea
          ref={titleRef}
          className="card-title"
          rows={1}
          value={title}
          placeholder="Untitled card"
          aria-label="Card title"
          onFocus={() => { editing.current = true; }}
          onBlur={() => { editing.current = false; }}
          onChange={(e) => { setTitle(e.target.value); updateTask(task.id, { title: e.target.value }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        />
      </div>

      {openDetails && (
        <textarea
          className="card-details"
          rows={3}
          value={task.details}
          placeholder="Details, links, thoughts…"
          aria-label="Details"
          onChange={(e) => updateTask(task.id, { details: e.target.value })}
        />
      )}

      <div className="card-due">
        <label className={`due-pill due-${state}`}>
          <span>{task.due ? dueLabel(task.due) : 'Due date'}</span>
          <input
            type="date"
            value={task.due ?? ''}
            aria-label="Due date"
            onChange={(e) => updateTask(task.id, { due: e.target.value || null })}
          />
        </label>
        <div className="due-chips">
          {task.due !== today && <button className="mini" onClick={() => updateTask(task.id, { due: today })}>Today</button>}
          {task.due !== addDays(today, 1) && <button className="mini" onClick={() => updateTask(task.id, { due: addDays(today, 1) })}>Tomorrow</button>}
          <button className="mini" onClick={() => updateTask(task.id, { due: addDays(today, 7) })}>Next week</button>
          {task.due && <button className="mini quiet" onClick={() => updateTask(task.id, { due: null })}>Clear</button>}
        </div>
      </div>

      <div className="card-foot">
        <div className="card-move" aria-label="Move to">
          {others.map((s) => (
            <button key={s} className="mini" onClick={() => moveTask(task.id, s)} title={`Move to ${TITLE[s]}`}>
              {s === 'todo' ? '← ' : ''}{TITLE[s]}{s !== 'todo' ? ' →' : ''}
            </button>
          ))}
        </div>
        <button className="mini quiet" onClick={() => setOpenDetails((v) => !v)} aria-expanded={openDetails}>
          {openDetails ? 'Hide details' : task.details ? 'Details' : '+ Details'}
        </button>
        <button
          className={`mini del ${confirm ? 'sure' : ''}`}
          onClick={() => (confirm ? deleteTask(task.id) : setConfirm(true))}
          onBlur={() => setConfirm(false)}
          aria-label={confirm ? 'Confirm delete' : 'Delete card'}
        >
          {confirm ? 'Sure?' : 'Delete'}
        </button>
      </div>
    </article>
  );
}
