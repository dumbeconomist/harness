import { useState } from 'react';
import { TASK_STATUSES, type Task, type TaskStatus } from '../../lib/types';
import { STATUS_LABEL } from './TasksView';

interface Props {
  task: Task;
  onUpdate: (id: string, patch: Partial<Pick<Task, 'title' | 'notes' | 'status'>>) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}

/** Remount (key on id + updated_at) when the server copy changes so agent edits show up. */
export function TaskDetail({ task, onUpdate, onDelete }: Props) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: Partial<Pick<Task, 'title' | 'notes' | 'status'>>) => {
    setError(null);
    try {
      await onUpdate(task.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };
  const saveTitle = () => {
    const t = title.trim();
    if (!t) return setTitle(task.title);
    if (t !== task.title) void save({ title: t });
  };
  const saveNotes = () => {
    if (notes !== (task.notes ?? '')) void save({ notes });
  };

  return (
    <div className="card task-detail" data-testid="task-detail">
      <input
        className="td-title"
        aria-label="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <textarea
        aria-label="Task notes"
        placeholder="Notes (Hermes may add notes here too)"
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={saveNotes}
      />
      <div className="row between">
        <label className="row gap">
          <span className="muted">Status</span>
          <select
            aria-label="Task status"
            value={task.status}
            onChange={(e) => void save({ status: e.target.value as TaskStatus })}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {confirming ? (
          <span className="row gap">
            <span className="muted">Delete this task?</span>
            <button className="btn small danger" data-testid="td-delete-confirm" onClick={() => void onDelete(task.id)}>
              Delete
            </button>
            <button className="btn small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn small danger" data-testid="td-delete" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
