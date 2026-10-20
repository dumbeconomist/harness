import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { TasksView } from '../tasks/TasksView';
import { JournalView, UndoButton } from '../journal/JournalView';
import { ApprovalsView } from '../approvals/ApprovalsView';
import { LedgerView } from '../ledger/LedgerView';
import { TaskDetail } from '../tasks/TaskDetail';
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

describe('ApprovalCard', () => {
  const card = (over: Partial<Approval> = {}, props: Record<string, unknown> = {}) => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const utils = render(<ApprovalCard approval={approval(over)} pendingCount={1} guardMs={0} onDecide={onDecide} {...props} />);
    return { onDecide, ...utils };
  };
  it('shows tool, tier, summary and full args; never takes focus', () => {
    card({ tier: 2, tool: 'tasks_delete' }, { pendingCount: 3 });
    expect(screen.getByText('tasks_delete')).toBeInTheDocument();
    expect(screen.getByTestId('tier-badge')).toHaveTextContent(/Tier 2.*Destructive/);
    expect(screen.getByText('+2 more waiting', { exact: false })).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });
  it('does not truncate long arguments', () => {
    const long = 'x'.repeat(2000);
    card({ args_json: JSON.stringify({ title: long }) });
    expect(screen.getByTestId('ac-args').textContent).toContain(long);
  });
  it('shows old → new for updates using the task from the store', () => {
    card(
      { tool: 'tasks_update', args_json: JSON.stringify({ id: 't1', title: 'New name', status: 'todo' }) },
      { tasks: [task({ title: 'Old name', status: 'todo' })] },
    );
    expect(screen.getByTestId('ac-changes')).toHaveTextContent('Old name');
    expect(screen.getByTestId('ac-changes')).toHaveTextContent('New name');
    expect(screen.getByTestId('ac-changes')).not.toHaveTextContent('status');
  });
  it('window-level keys never decide; Ctrl+Enter elsewhere does nothing', () => {
    const { onDecide } = card();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDecide).not.toHaveBeenCalled();
  });
  it('⌘↵ with focus inside the card approves; repeat is ignored', async () => {
    const { onDecide } = card();
    const note = screen.getByLabelText('Note (optional)');
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true, repeat: true });
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', undefined));
  });
  it('Esc collapses to a badge and never denies', async () => {
    const { onDecide } = card();
    fireEvent.keyDown(screen.getByLabelText('Note (optional)'), { key: 'Escape' });
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-card')).toBeNull();
    await userEvent.click(screen.getByTestId('approval-badge'));
    expect(screen.getByTestId('approval-card')).toBeInTheDocument();
  });
  it('ignores everything within the mount guard window', async () => {
    const { onDecide } = card({}, { guardMs: 600 });
    fireEvent.keyDown(screen.getByLabelText('Note (optional)'), { key: 'Enter', metaKey: true });
    await userEvent.click(screen.getByTestId('approve-btn'));
    expect(onDecide).not.toHaveBeenCalled();
    await act(async () => void (await new Promise((r) => setTimeout(r, 650))));
    await userEvent.click(screen.getByTestId('approve-btn'));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });
  it('tier 2 needs Review before Approve exists; ⌘↵ does nothing before review', async () => {
    const { onDecide } = card({ tier: 2, tool: 'tasks_delete', args_json: '{"id":"t1"}' }, { tasks: [task()] });
    expect(screen.queryByTestId('approve-btn')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('approval-card'), { key: 'Enter', metaKey: true });
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('review-btn'));
    expect(screen.getByTestId('ac-target')).toHaveTextContent('Write spec');
    await userEvent.click(screen.getByTestId('approve-btn'));
    expect(onDecide).toHaveBeenCalledWith('approve', undefined);
  });
  it('passes the note on deny and shows failures', async () => {
    const { onDecide } = card();
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'not now');
    await userEvent.click(screen.getByTestId('deny-btn'));
    expect(onDecide).toHaveBeenCalledWith('deny', 'not now');
  });
  it('shows an error if the decision fails', async () => {
    render(<ApprovalCard approval={approval()} pendingCount={1} guardMs={0} onDecide={vi.fn().mockRejectedValue(new Error('gone'))} />);
    await userEvent.click(screen.getByTestId('approve-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent('gone');
  });
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
    expect(onUndo).not.toHaveBeenCalled();
    expect(screen.getByTestId('undo-confirm-box')).toHaveTextContent(/delete the task/);
    await userEvent.click(screen.getByTestId('undo-confirm'));
    expect(onUndo).toHaveBeenCalledWith('j1');
  });
  it('explains a 409 stale conflict inline', async () => {
    const err = Object.assign(new Error('Undo the newer edit first'), { code: 'stale' });
    render(<UndoButton entry={entry()} onUndo={vi.fn().mockRejectedValue(err)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await userEvent.click(screen.getByTestId('undo-confirm'));
    expect(await screen.findByTestId('undo-error')).toHaveTextContent(/changed afterwards.*newer edit/);
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
      getHermes: vi.fn().mockResolvedValue({ url: 'http://h/v1', has_key: true, key_persisted: false, reachable: true }),
      putHermes: vi.fn().mockImplementation(async (b) => ({ url: b.url, has_key: true, key_persisted: false, reachable: true })),
      getConnection: vi.fn().mockResolvedValue({ mcp_url: 'http://127.0.0.1:8765/mcp', mcp_token: 'sekret', hermes_config_snippet: 'mcp_servers:\n  workbench: sekret' }),
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
  it('permission switches are off and disabled with a coming-soon label', async () => {
    render(<SettingsView api={mkApi()} health={null} />);
    const web = await screen.findByRole('switch', { name: /Web access/ });
    expect(web).not.toBeChecked();
    expect(web).toBeDisabled();
    expect(screen.getAllByText('coming in G2–G6').length).toBe(6);
    expect(screen.getByTestId('hermes-status')).toHaveTextContent('core unreachable');
  });
  it('saves Hermes url/key, warns when key not persisted', async () => {
    const api = mkApi();
    render(<SettingsView api={api} health={null} />);
    expect(await screen.findByTestId('key-not-persisted')).toBeInTheDocument();
    const url = screen.getByLabelText('Hermes URL');
    await userEvent.clear(url);
    await userEvent.type(url, 'http://z/v1');
    await userEvent.type(screen.getByLabelText('Hermes API key'), 'k1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.putHermes).toHaveBeenCalledWith({ url: 'http://z/v1', api_key: 'k1' });
  });
  it('Clear key sends an empty api_key', async () => {
    const api = mkApi();
    render(<SettingsView api={api} health={null} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Clear key' }));
    expect(api.putHermes).toHaveBeenCalledWith({ api_key: '' });
  });
  it('connection snippet is hidden until revealed', async () => {
    render(<SettingsView api={mkApi()} health={null} />);
    expect(screen.queryByTestId('mcp-snippet')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Reveal snippet/ }));
    expect(await screen.findByTestId('mcp-snippet')).toHaveTextContent('sekret');
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

describe('tier-2 keyboard hardening', () => {
  const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  it('Review then Enter,Enter / Space does not approve; focus leaves the button', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={approval({ tier: 2, tool: 'tasks_delete', args_json: '{"id":"t1"}' })} pendingCount={1} guardMs={80} tasks={[task()]} onDecide={onDecide} />);
    await wait(120);
    const review = screen.getByTestId('review-btn');
    review.focus();
    await userEvent.keyboard('{Enter}');
    await wait(10);
    expect(screen.getByTestId('approval-card')).toHaveFocus();
    await userEvent.keyboard('{Enter}{Enter} {Enter>4/}');
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByTestId('approve-btn')).toBeDisabled(); // re-armed
    await wait(120);
    await userEvent.keyboard('{Enter} {Enter}');
    expect(onDecide).not.toHaveBeenCalled();
  });
  it('keyboard-activated Confirm (detail 0) needs the opt-in box for tier 2', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={approval({ tier: 2 })} pendingCount={1} guardMs={0} onDecide={onDecide} />);
    await userEvent.click(screen.getByTestId('review-btn'));
    expect(screen.getByTestId('approve-btn')).toHaveTextContent('Confirm');
    fireEvent.click(screen.getByTestId('approve-btn'), { detail: 0 });
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText(/Allow keyboard/));
    fireEvent.click(screen.getByTestId('approve-btn'), { detail: 0 });
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
  });
});

describe('round-4 guards', () => {
  const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  it('Review is inert during the mount guard and Approve is not rendered with it', async () => {
    render(<ApprovalCard approval={approval({ tier: 2 })} pendingCount={1} guardMs={80} onDecide={vi.fn()} />);
    expect(screen.getByTestId('review-btn')).toBeDisabled();
    expect(screen.queryByTestId('approve-btn')).toBeNull();
    await wait(120);
    expect(screen.getByTestId('review-btn')).toBeEnabled();
  });
  it('after Review the tier-2 re-arm is 1000ms', async () => {
    render(<ApprovalCard approval={approval({ tier: 2 })} pendingCount={1} guardMs={50} onDecide={vi.fn()} />);
    await wait(80);
    await userEvent.click(screen.getByTestId('review-btn'));
    expect(screen.getByTestId('approve-btn')).toBeDisabled();
    await wait(600);
    expect(screen.getByTestId('approve-btn')).toBeDisabled();
    await wait(500);
    expect(screen.getByTestId('approve-btn')).toBeEnabled();
  });
  it('re-arms all rows when the id set changes', async () => {
    const onDecide = vi.fn();
    const rows = [approval({ id: 'a1' }), approval({ id: 'a2' }), approval({ id: 'a3' })];
    const { rerender } = render(<ApprovalsView guardMs={80} onDecide={onDecide} approvals={rows} />);
    await wait(120);
    expect(screen.getAllByTestId('row-approve')[0]).toBeEnabled();
    rerender(<ApprovalsView guardMs={80} onDecide={onDecide} approvals={rows.slice(1)} />);
    screen.getAllByTestId('row-approve').forEach((b) => expect(b).toBeDisabled());
    await wait(120);
    screen.getAllByTestId('row-approve').forEach((b) => expect(b).toBeEnabled());
  });
});

describe('ApprovalsView guards', () => {
  const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  it('double-click on row 1 cannot approve row 2; rows are inert after a decision', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalsView guardMs={100} onDecide={onDecide} approvals={[approval({ id: 'a1' }), approval({ id: 'a2' })]} />);
    expect(screen.getAllByTestId('row-approve')[0]).toBeDisabled(); // armed after mount
    await wait(140);
    await userEvent.dblClick(screen.getAllByTestId('row-approve')[0]!);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve');
    expect(screen.getAllByTestId('row-approve')[1]).toBeDisabled();
  });
  it('tier-2 row: Review then Enter,Enter does not approve', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalsView guardMs={60} onDecide={onDecide} approvals={[approval({ tier: 2, tool: 'tasks_delete' })]} />);
    await wait(100);
    screen.getByTestId('row-review').focus();
    await userEvent.keyboard('{Enter}');
    await wait(10);
    await userEvent.keyboard('{Enter}{Enter}');
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('LedgerView', () => {
  it('shows tokens and unpriced badges', () => {
    render(
      <LedgerView
        summary={{
          total_usd: 0,
          total_tokens: 1234,
          unpriced_runs: 2,
          by_model: [{ model: 'hermes-agent', usd: 0, tokens: 1234, priced: false }],
          by_day: [],
        }}
      />,
    );
    expect(screen.getByTestId('ledger-tokens')).toHaveTextContent('1,234 tokens');
    expect(screen.getByTestId('unpriced-badge')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-unpriced-note')).toHaveTextContent('2 runs');
  });
});

describe('TaskDetail', () => {
  it('edits notes on blur, shows agent notes, confirms delete', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn();
    render(<TaskDetail task={task({ notes: 'from agent' })} onUpdate={onUpdate} onDelete={onDelete} />);
    const notes = screen.getByLabelText('Task notes');
    expect(notes).toHaveValue('from agent');
    await userEvent.type(notes, '!');
    await userEvent.tab();
    expect(onUpdate).toHaveBeenCalledWith('t1', { notes: 'from agent!' });
    await userEvent.click(screen.getByTestId('td-delete'));
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('td-delete-confirm'));
    expect(onDelete).toHaveBeenCalledWith('t1');
  });
});

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
