import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { TASK_STATUSES, type Task, type TaskStatus } from '../../lib/types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  doing: 'Doing',
  blocked: 'Blocked',
  done: 'Done',
};
const GROUP_ORDER: TaskStatus[] = ['doing', 'todo', 'blocked', 'done'];

interface Props {
  tasks: Task[];
  loaded: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (title: string) => Promise<void> | void;
  onStatus: (id: string, status: TaskStatus) => Promise<void> | void;
  onRetry?: () => void;
}

export function TasksView({ tasks, loaded, error, selectedId, onSelect, onCreate, onStatus, onRetry }: Props) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener('workbench:focus-quick-add', focus);
    return () => window.removeEventListener('workbench:focus-quick-add', focus);
  }, []);

  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      await onCreate(t);
      setTitle('');
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not add task');
    } finally {
      setBusy(false);
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'SELECT') return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-task-row]'));
    const cur = rows.findIndex((r) => r.contains(document.activeElement));
    const next = rows[Math.min(rows.length - 1, Math.max(0, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
      next.click();
    }
  };

  const groups = GROUP_ORDER.map((s) => ({ status: s, items: tasks.filter((t) => t.status === s) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <section className="view" aria-label="Tasks">
      <header className="view-head">
        <h1>Tasks</h1>
        <span className="muted">{tasks.length} total</span>
      </header>
      <div className="quick-add">
        <input
          ref={inputRef}
          aria-label="New task"
          placeholder="Add a task and press Enter…"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      {addError && (
        <p className="inline-error" role="alert">
          {addError}
        </p>
      )}
      {error && (
        <div className="state error" role="alert">
          <p>Couldn’t load tasks: {error}</p>
          {onRetry && (
            <button className="btn" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {!loaded && !error && <div className="state muted">Loading tasks…</div>}
      {loaded && !error && tasks.length === 0 && (
        <div className="state empty">
          <strong>No tasks yet</strong>
          <p>Add one above, or ask Hermes in the side pane to “add a task to buy milk”.</p>
        </div>
      )}
      <ul className="task-list" onKeyDown={onListKey}>
        {groups.map((g) => (
          <li key={g.status} className="group">
            <h2 className="group-title">
              {STATUS_LABEL[g.status]} <span className="count">{g.items.length}</span>
            </h2>
            <ul>
              {g.items.map((t) => (
                <li key={t.id}>
                  <div
                    className={`task-row${t.id === selectedId ? ' selected' : ''}${t.status === 'done' ? ' done' : ''}`}
                    data-task-row
                    data-testid="task-row"
                    tabIndex={0}
                    role="button"
                    aria-pressed={t.id === selectedId}
                    onClick={() => onSelect(t.id)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                        e.preventDefault();
                        onSelect(t.id);
                      }
                    }}
                  >
                    <span className={`dot ${t.status}`} aria-hidden />
                    <span className="task-title">{t.title}</span>
                    <select
                      aria-label={`Status of ${t.title}`}
                      value={t.status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => void onStatus(t.id, e.target.value as TaskStatus)}
                    >
                      {TASK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
