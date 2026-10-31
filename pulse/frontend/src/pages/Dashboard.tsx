import { useEffect, useMemo, useRef, useState } from 'react';
import { Art, heroSlot } from '../art/Art';
import { addDays, ago, dueLabel, greeting, longDate, todayStr } from '../dates';
import { Link, navigate } from '../router';
import { createNote, createTask, updateTask, useStore, type Task } from '../store';

function TaskRow({ t, extra }: { t: Task; extra?: string }) {
  const done = t.status === 'done';
  return (
    <li className={`dash-task${done ? ' is-done' : ''}`}>
      <input
        type="checkbox"
        className="dash-check"
        checked={done}
        aria-label={done ? `Mark "${t.title}" as to do` : `Mark "${t.title}" as done`}
        onChange={() => updateTask(t.id, { status: done ? 'todo' : 'done' })}
      />
      <Link to="/board" className="dash-task-title">
        {t.title || 'Untitled task'}
      </Link>
      {t.status === 'doing' && <span className="dash-pill">in progress</span>}
      {extra && <span className="dash-due">{extra}</span>}
    </li>
  );
}

function Ring({ value, total }: { value: number; total: number }) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const frac = total ? value / total : 0;
  return (
    <svg viewBox="0 0 100 100" className="dash-ring" role="img" aria-label={`${value} of ${total} done`}>
      <circle cx="50" cy="50" r={r} className="dash-ring-bg" />
      <circle cx="50" cy="50" r={r} className="dash-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 50 50)" />
      <text x="50" y="49" textAnchor="middle" className="dash-ring-n">{value}/{total}</text>
      <text x="50" y="65" textAnchor="middle" className="dash-ring-l">done</text>
    </svg>
  );
}

export default function Dashboard() {
  const tasks = useStore((s) => s.tasks);
  const notes = useStore((s) => s.notes);
  const [title, setTitle] = useState('');
  const [tick, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const d = useMemo(() => {
    const today = todayStr();
    const weekEnd = addDays(today, 7);
    const open = tasks.filter((t) => t.status !== 'done');
    const todays = tasks.filter((t) => t.due === today);
    const dueToday = open.filter((t) => t.due === today);
    const overdue = open.filter((t) => t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!));
    const upcoming = open.filter((t) => t.due && t.due > today && t.due <= weekEnd).sort((a, b) => a.due!.localeCompare(b.due!));
    const groups: { due: string; items: Task[] }[] = [];
    for (const t of upcoming) {
      const g = groups[groups.length - 1];
      if (g && g.due === t.due) g.items.push(t);
      else groups.push({ due: t.due!, items: [t] });
    }
    const weekAgo = Date.now() - 7 * 86_400_000;
    return {
      dueToday,
      todayDone: todays.length - dueToday.length,
      todayTotal: todays.length,
      overdue,
      groups,
      todo: tasks.filter((t) => t.status === 'todo').length,
      doing: tasks.filter((t) => t.status === 'doing').length,
      done: tasks.filter((t) => t.status === 'done').length,
      weekDone: tasks.filter((t) => t.status === 'done' && new Date(t.updatedAt).getTime() >= weekAgo).length,
    };
  }, [tasks, tick]);

  const recent = useMemo(() => notes.slice(0, 4), [notes]);
  const now = new Date();
  const summary =
    d.dueToday.length || d.overdue.length
      ? [
          d.dueToday.length ? `${d.dueToday.length} ${d.dueToday.length === 1 ? 'thing' : 'things'} today` : 'Nothing due today',
          d.overdue.length ? `${d.overdue.length} overdue` : '',
        ].filter(Boolean).join(', ')
      : d.todayTotal
        ? 'Everything for today is done. Lovely.'
        : 'A clear day ahead.';

  const add = () => {
    const v = title.trim();
    if (!v) return;
    createTask({ title: v, due: todayStr() });
    setTitle('');
    input.current?.focus();
  };

  return (
    <div className="dash">
      <section className="dash-hero dash-rise" style={{ ['--i' as string]: 0 }}>
        <Art slot={heroSlot()} className="dash-hero-art" />
        <div className="dash-hero-shade" />
        <div className="dash-hero-text">
          <p className="dash-date">{longDate()}</p>
          <h1>{greeting()}</h1>
          <p className="dash-summary">{summary}</p>
          <form className="dash-add" onSubmit={(e) => (e.preventDefault(), add())}>
            <input ref={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add something for today, press Enter" aria-label="Quick add task for today" />
            <button type="submit" disabled={!title.trim()}>Add</button>
          </form>
        </div>
      </section>

      <div className="dash-grid">
        <section className="dash-card dash-rise" style={{ ['--i' as string]: 1 }}>
          <div className="dash-strip"><Art slot="card-today" /></div>
          <div className="dash-body">
            <h2>Today</h2>
            {d.dueToday.length ? (
              <ul className="dash-list">{d.dueToday.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
            ) : (
              <div className="dash-empty">
                <div className="dash-empty-art"><Art slot="empty-today" /></div>
                <p>{d.todayTotal ? 'All done for today. Put your feet up.' : 'Nothing due today. Enjoy the quiet.'}</p>
              </div>
            )}
          </div>
        </section>

        <section className={`dash-card dash-rise dash-rose${d.overdue.length ? '' : ' is-calm'}`} style={{ ['--i' as string]: 2 }}>
          <div className="dash-strip"><Art slot="card-overdue" /></div>
          <div className="dash-body">
            <h2>Overdue{d.overdue.length > 0 && <span className="dash-count">{d.overdue.length}</span>}</h2>
            {d.overdue.length ? (
              <ul className="dash-list">
                {d.overdue.map((t) => (
                  <TaskRow key={t.id} t={t} extra={dueLabel(t.due)} />
                ))}
              </ul>
            ) : (
              <p className="dash-calm">Nothing overdue. You are on top of it.</p>
            )}
          </div>
        </section>

        <section className="dash-card dash-rise" style={{ ['--i' as string]: 3 }}>
          <div className="dash-strip"><Art slot="card-upcoming" /></div>
          <div className="dash-body">
            <h2>Coming up</h2>
            {d.groups.length ? (
              d.groups.map((g) => (
                <div key={g.due} className="dash-day">
                  <h3>{dueLabel(g.due)}</h3>
                  <ul className="dash-list">{g.items.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
                </div>
              ))
            ) : (
              <p className="dash-calm">Nothing planned for the next 7 days.</p>
            )}
          </div>
        </section>

        <section className="dash-card dash-rise" style={{ ['--i' as string]: 4 }}>
          <div className="dash-strip"><Art slot="card-notes" /></div>
          <div className="dash-body">
            <div className="dash-head">
              <h2>Recent notes</h2>
              <button className="dash-btn" onClick={() => navigate(`/notes/${createNote().id}`)}>New note</button>
            </div>
            {recent.length ? (
              <ul className="dash-notes">
                {recent.map((n) => (
                  <li key={n.id}>
                    <Link to={`/notes/${n.id}`} className="dash-note">
                      <span className="dash-thumb"><Art slot={n.cover || 'cover-books'} /></span>
                      <span className="dash-note-text">
                        <b>{n.title || 'Untitled'}</b>
                        <small>{ago(n.updatedAt)}</small>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dash-calm">No notes yet. Jot the first one down.</p>
            )}
          </div>
        </section>

        <div className="dash-widgets">
          <section className="dash-card dash-widget dash-rise" style={{ ['--i' as string]: 5 }}>
            <Ring value={d.todayTotal ? d.todayDone : d.weekDone} total={d.todayTotal || d.weekDone} />
            <p>{d.todayTotal ? "Today's tasks" : 'Done this week'}</p>
            {d.todayTotal > 0 && <small>{d.weekDone} done this week</small>}
          </section>

          <Link to="/board" className="dash-card dash-widget dash-counts dash-rise" style={{ ['--i' as string]: 6 }}>
            <div><b>{d.todo}</b><span>To do</span></div>
            <div><b>{d.doing}</b><span>In progress</span></div>
            <div><b>{d.done}</b><span>Done</span></div>
          </Link>

          <section className="dash-card dash-widget dash-clock dash-rise" style={{ ['--i' as string]: 7 }}>
            <b>{now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</b>
            <span>{now.toLocaleDateString(undefined, { weekday: 'long' })}</span>
            <small>{now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</small>
          </section>
        </div>
      </div>
    </div>
  );
}
