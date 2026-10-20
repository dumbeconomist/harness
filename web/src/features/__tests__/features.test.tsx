import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { TasksView } from '../tasks/TasksView';
import { JournalView, UndoButton } from '../journal/JournalView';
import { SettingsView } from '../settings/SettingsView';
import { CommandPalette, filterActions } from '../palette/CommandPalette';
import type { Api } from '../../lib/api';
import type { Approval, JournalEntry, Task } from '../../lib/types';

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  tool: 'tasks_create',
  tier: 1,
  args_json: '{"title":"Buy milk"}',
  summary: 'Create task "Buy milk"',
  status: 'pending',
  requested_by: 'hermes',
  created_at: new Date().toISOString(),
  decided_at: null,
  note: null,
  ...over,
});

describe('ApprovalCard', () => {
  it('shows tool, tier, summary and args', () => {
    render(<ApprovalCard approval={approval({ tier: 2, tool: 'tasks_delete' })} pendingCount={3} onDecide={vi.fn()} />);
    expect(screen.getByText('tasks_delete')).toBeInTheDocument();
    expect(screen.getByTestId('tier-badge')).toHaveTextContent(/Tier 2.*Destructive/);
    expect(screen.getByText(/Buy milk/, { selector: '.ac-summary' })).toBeInTheDocument();
    expect(screen.getByText('+2 more waiting')).toBeInTheDocument();
  });
  it('⌘↵ approves and Esc denies', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<ApprovalCard approval={approval()} pendingCount={1} onDecide={onDecide} />);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', undefined));
    unmount();
    const onDecide2 = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={approval()} pendingCount={1} onDecide={onDecide2} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onDecide2).toHaveBeenCalledWith('deny', undefined));
  });
  it('plain Enter does not approve; note is passed along', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={approval()} pendingCount={1} onDecide={onDecide} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'not now');
    await userEvent.click(screen.getByTestId('deny-btn'));
    expect(onDecide).toHaveBeenCalledWith('deny', 'not now');
  });
  it('shows an error if the decision fails', async () => {
    render(<ApprovalCard approval={approval()} pendingCount={1} onDecide={vi.fn().mockRejectedValue(new Error('gone'))} />);
    await userEvent.click(screen.getByTestId('approve-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent('gone');
  });
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Write spec',
  notes: '',
  status: 'todo',
  goal_id: null,
  created_at: '',
  updated_at: '',
  ...over,
});

describe('TasksView', () => {
  const base = { loaded: true, error: null, selectedId: null, onSelect: vi.fn(), onStatus: vi.fn() };
  it('quick-add creates on Enter and clears input', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<TasksView {...base} tasks={[]} onCreate={onCreate} />);
    const input = screen.getByLabelText('New task');
    await userEvent.type(input, 'Buy milk{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Buy milk');
    await waitFor(() => expect(input).toHaveValue(''));
  });
  it('ignores blank input and keeps text on failure', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('nope'));
    render(<TasksView {...base} tasks={[]} onCreate={onCreate} />);
    const input = screen.getByLabelText('New task');
    await userEvent.type(input, '   {Enter}');
    expect(onCreate).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, 'x{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
    expect(input).toHaveValue('x');
  });
  it('shows empty and loading states', () => {
    const { rerender } = render(<TasksView {...base} tasks={[]} onCreate={vi.fn()} />);
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    rerender(<TasksView {...base} loaded={false} tasks={[]} onCreate={vi.fn()} />);
    expect(screen.getByText(/Loading tasks/)).toBeInTheDocument();
  });
  it('groups by status, selects, and changes status inline', async () => {
    const onSelect = vi.fn();
    const onStatus = vi.fn();
    render(
      <TasksView
        {...base}
        onSelect={onSelect}
        onStatus={onStatus}
        onCreate={vi.fn()}
        tasks={[task(), task({ id: 't2', title: 'Ship it', status: 'doing' })]}
      />,
    );
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Doing/);
    await userEvent.click(screen.getByText('Write spec'));
    expect(onSelect).toHaveBeenCalledWith('t1');
    await userEvent.selectOptions(screen.getByLabelText('Status of Write spec'), 'done');
    expect(onStatus).toHaveBeenCalledWith('t1', 'done');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 'j1',
  ts: new Date().toISOString(),
  actor: 'agent',
  tool: 'tasks_create',
  args_json: '{"title":"Buy milk"}',
  result_json: null,
  approval_id: 'a1',
  idempotency_key: null,
  inverse_json: '{"op":"delete","id":"t1"}',
  undone_at: null,
  ...over,
});

describe('Undo button', () => {
  it('is enabled and calls onUndo when undoable', async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined);
    render(<UndoButton entry={entry()} onUndo={onUndo} />);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledWith('j1');
  });
  it('is disabled once undone', () => {
    render(<UndoButton entry={entry({ undone_at: new Date().toISOString() })} onUndo={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Undone' })).toBeDisabled();
  });
  it('is absent when there is no inverse (reads, undo entries)', () => {
    render(<UndoButton entry={entry({ inverse_json: null })} onUndo={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows actor and disables in feed after undone', () => {
    render(<JournalView entries={[entry(), entry({ id: 'j2', actor: 'user', undone_at: 'x' })]} onUndo={vi.fn()} />);
    expect(screen.getByText('Hermes')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getAllByTestId('journal-entry')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Undone' })).toBeDisabled();
  });
});

describe('SettingsView', () => {
  const mkApi = (): Api =>
    ({
      getPermissions: vi.fn().mockResolvedValue({ web: false, files: false, mail: false, terminal: false, calendar: false, code: false }),
      getPolicies: vi.fn().mockResolvedValue({}),
      putPermissions: vi.fn().mockImplementation(async (p) => p),
      putPolicies: vi.fn().mockImplementation(async (p) => p),
    }) as unknown as Api;

  it('locks tier-2 tools to always ask, allows tier-1 auto', async () => {
    const api = mkApi();
    render(<SettingsView api={api} health={{ ok: true, version: '0.1', hermes: { reachable: true } }} />);
    const t2 = await screen.findByLabelText(/tasks_delete/);
    expect(t2).toBeDisabled();
    expect(t2).toHaveValue('ask');
    expect(within2(t2).queryByText('Auto-approve')).toBeNull();
    const t1 = screen.getByLabelText(/tasks_create/);
    expect(t1).toBeEnabled();
    await userEvent.selectOptions(t1, 'auto');
    expect(api.putPolicies).toHaveBeenCalledWith({ tasks_create: 'auto' });
  });
  it('permissions default off and toggle persists full object', async () => {
    const api = mkApi();
    render(<SettingsView api={api} health={null} />);
    const web = await screen.findByRole('switch', { name: /Web access/ });
    await waitFor(() => expect(web).toBeEnabled());
    expect(web).not.toBeChecked();
    await userEvent.click(web);
    expect(api.putPermissions).toHaveBeenCalledWith(expect.objectContaining({ web: true, terminal: false }));
    expect(screen.getByTestId('hermes-status')).toHaveTextContent('core unreachable');
  });
  it('shows Hermes reachability', async () => {
    render(<SettingsView api={mkApi()} health={{ ok: true, version: '0.1', hermes: { reachable: false } }} />);
    expect(screen.getByTestId('hermes-status')).toHaveTextContent('Hermes is not reachable');
    await screen.findByRole('switch', { name: /Web access/ });
  });
});

function within2(el: HTMLElement) {
  return {
    queryByText: (t: string) => Array.from(el.querySelectorAll('option')).find((o) => o.textContent === t) ?? null,
  };
}

describe('CommandPalette', () => {
  const actions = [
    { id: 'a', title: 'New task', run: vi.fn() },
    { id: 'b', title: 'Go to Ledger', run: vi.fn() },
  ];
  it('fuzzy filters', () => {
    expect(filterActions(actions, 'gtl').map((a) => a.id)).toEqual(['b']);
    expect(filterActions(actions, 'zzz')).toEqual([]);
  });
  it('runs the highlighted action on Enter and closes on Esc', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open actions={actions} onClose={onClose} />);
    await userEvent.type(screen.getByLabelText('Command'), 'ledg{Enter}');
    expect(actions[1]!.run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    await userEvent.type(screen.getByLabelText('Command'), '{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
