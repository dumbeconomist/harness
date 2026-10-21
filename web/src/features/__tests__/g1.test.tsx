import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UndoResult } from '../palette/CommandResult';
import { DoctorBanner, DoctorPanel, firstProblem } from '../doctor/Doctor';
import { ChatPane, threadToMsgs } from '../chat/ChatPane';
import { DayBars, LedgerView, fillDays } from '../ledger/LedgerView';
import { QuickBar } from '../quick/QuickBar';
import { createApprovalAlerts, TYPING_GRACE_MS } from '../../lib/alerts';
import type { Api } from '../../lib/api';
import type { CommandCtx } from '../../lib/commands';
import type { Approval, Doctor, JournalEntry, Thread, ThreadMessage } from '../../lib/types';

const entry: JournalEntry = {
  id: 'j1',
  ts: new Date().toISOString(),
  actor: 'user',
  tool: 'tasks_create',
  args_json: '{"title":"Buy milk"}',
  result_json: null,
  approval_id: null,
  idempotency_key: null,
  inverse_json: '{"op":"delete"}',
  undone_at: null,
};

const mkCtx = (over: Record<string, unknown> = {}) => {
  const api = { config: { baseUrl: 'http://x', token: 't' }, undo: vi.fn().mockResolvedValue(entry), ...over };
  const ctx: CommandCtx = { api: api as unknown as CommandCtx['api'], ui: vi.fn(), pendingApprovals: 0, surface: 'palette' };
  return { api, ctx };
};

describe('/undo arm', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the entry but no Confirm until 600ms; Enter/keys cannot undo; click undoes once', async () => {
    const { ctx, api } = mkCtx();
    render(<UndoResult entry={entry} ctx={ctx} />);
    expect(screen.getByTestId('undo-target')).toHaveTextContent('tasks_create “Buy milk”');
    expect(screen.queryByTestId('undo-confirm-cmd')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    act(() => void vi.advanceTimersByTime(599));
    expect(screen.queryByTestId('undo-confirm-cmd')).toBeNull();
    act(() => void vi.advanceTimersByTime(2));
    const btn = screen.getByTestId('undo-confirm-cmd');
    expect(btn).not.toHaveFocus(); // never takes focus on its own
    expect(api.undo).not.toHaveBeenCalled();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(api.undo).toHaveBeenCalledWith('j1');
    expect(screen.getByTestId('undo-done')).toBeInTheDocument();
  });

  it('a different entry re-arms', () => {
    const { ctx } = mkCtx();
    const { rerender } = render(<UndoResult entry={entry} ctx={ctx} />);
    act(() => void vi.advanceTimersByTime(700));
    expect(screen.getByTestId('undo-confirm-cmd')).toBeInTheDocument();
    rerender(<UndoResult entry={{ ...entry, id: 'j2' }} ctx={ctx} />);
    expect(screen.queryByTestId('undo-confirm-cmd')).toBeNull();
  });

  it('says so when there is nothing to undo', () => {
    const { ctx } = mkCtx();
    render(<UndoResult entry={null} ctx={ctx} />);
    expect(screen.getByText('Nothing to undo.')).toBeInTheDocument();
  });
});

const doctor = (over: Partial<Doctor> = {}): Doctor => ({
  ok: false,
  checks: [
    { id: 'hermes_reachable', title: 'Hermes reachable', status: 'fail', message: 'Connection refused', fix: 'Start the locked profile: `hermes -p workbench gateway run`', blocking: true },
    { id: 'hermes_auth', title: 'Hermes auth', status: 'skip', message: 'Skipped', blocking: true },
    { id: 'mcp_connected', title: 'MCP connected', status: 'warn', message: 'Never connected', fix: 'Add WORKBENCH_MCP_TOKEN', blocking: false },
    { id: 'profile_locked', title: 'Profile locked', status: 'ok', message: 'ok', blocking: false },
  ],
  ...over,
});

describe('Connection doctor', () => {
  it('renders each check with status and the fix for non-ok ones', async () => {
    const api = { doctor: vi.fn().mockResolvedValue(doctor()) };
    const onResult = vi.fn();
    render(<DoctorPanel api={api} onResult={onResult} />);
    expect(await screen.findByTestId('doctor-check-hermes_reachable')).toHaveAttribute('data-status', 'fail');
    expect(screen.getByTestId('doctor-fix-hermes_reachable')).toHaveTextContent('hermes -p workbench gateway run');
    expect(screen.getByTestId('doctor-check-mcp_connected')).toHaveAttribute('data-status', 'warn');
    expect(screen.getByTestId('doctor-check-profile_locked')).toHaveAttribute('data-status', 'ok');
    expect(screen.queryByTestId('doctor-fix-profile_locked')).toBeNull();
    expect(screen.queryByTestId('doctor-fix-hermes_auth')).toBeNull();
    expect(screen.getByTestId('doctor-summary')).toHaveTextContent('needs attention');
    expect(onResult).toHaveBeenCalled();
    expect(api.doctor).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByTestId('doctor-run-deep'));
    expect(api.doctor).toHaveBeenLastCalledWith(true);
  });

  it('shows an error if the doctor endpoint is unavailable', async () => {
    render(<DoctorPanel api={{ doctor: vi.fn().mockRejectedValue(new Error('HTTP 404')) }} />);
    expect(await screen.findByTestId('doctor-error')).toHaveTextContent('HTTP 404');
  });

  it('banner: first failing check + fix, dismissable, absent when ok', async () => {
    const d = doctor();
    expect(firstProblem(d)?.id).toBe('hermes_reachable');
    const { rerender } = render(<DoctorBanner doctor={d} onFix={vi.fn()} />);
    expect(screen.getByTestId('doctor-banner')).toHaveTextContent('Connection refused');
    expect(screen.getByTestId('doctor-banner')).toHaveTextContent('hermes -p workbench gateway run');
    await userEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByTestId('doctor-banner')).toBeNull();
    rerender(<DoctorBanner doctor={{ ok: true, checks: [] }} onFix={vi.fn()} />);
    rerender(<DoctorBanner doctor={d} onFix={vi.fn()} />);
    expect(screen.getByTestId('doctor-banner')).toBeInTheDocument(); // healthy -> failing again shows afresh
    rerender(<DoctorBanner doctor={{ ok: true, checks: d.checks }} onFix={vi.fn()} />);
    expect(screen.queryByTestId('doctor-banner')).toBeNull(); // warn-only is ok:true -> no banner
  });
});

describe('thread switcher', () => {
  const thread = (id: string, title: string): Thread => ({
    id,
    context_kind: 'task',
    context_id: 't1',
    title,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const rows = (tid: string, text: string): ThreadMessage[] => [
    { id: `${tid}u`, thread_id: tid, role: 'user', content: text, tool_json: null, created_at: '' },
    { id: `${tid}a`, thread_id: tid, role: 'assistant', content: `re: ${text}`, tool_json: null, created_at: '' },
  ];
  const mkApi = () => ({
    listThreads: vi.fn().mockResolvedValue([thread('th2', 'Second'), thread('th1', 'First')]),
    createThread: vi.fn().mockImplementation(async (b: { title?: string }) => thread('th3', b.title ?? '')),
    threadMessages: vi.fn().mockImplementation(async (id: string) => rows(id, id === 'th2' ? 'second q' : 'first q')),
  });
  const cfg = { baseUrl: 'http://core', token: 'tok' };
  const pane = (api: ReturnType<typeof mkApi>) => (
    <ChatPane
      api={api as unknown as Pick<Api, 'listThreads' | 'createThread' | 'threadMessages'>}
      cfg={cfg}
      context={{ kind: 'task', id: 't1' }}
      contextLabel="Task one"
      hidden={false}
      onOpenSettings={vi.fn()}
      onClose={vi.fn()}
    />
  );

  it('loads the newest thread for the context and switches between threads', async () => {
    const api = mkApi();
    render(pane(api));
    expect(await screen.findByText('re: second q')).toBeInTheDocument();
    expect(api.listThreads).toHaveBeenCalledWith('task', 't1');
    const sel = screen.getByLabelText('Thread') as HTMLSelectElement;
    expect(sel.value).toBe('th2');
    expect([...sel.options].map((o) => o.value)).toEqual(['th2', 'th1']);
    await userEvent.selectOptions(sel, 'th1');
    expect(await screen.findByText('re: first q')).toBeInTheDocument();
    expect(screen.queryByText('re: second q')).toBeNull();
  });

  it('New thread starts empty; first send creates it and posts thread_id', async () => {
    const api = mkApi();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(pane(api));
    await screen.findByText('re: second q');
    await userEvent.click(screen.getByTestId('new-thread'));
    expect(screen.queryByText('re: second q')).toBeNull();
    expect((screen.getByLabelText('Thread') as HTMLSelectElement).value).toBe('__new__');
    await userEvent.type(screen.getByLabelText('Message Hermes'), 'brand new{Enter}');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(api.createThread).toHaveBeenCalledWith({ context_kind: 'task', context_id: 't1', title: 'brand new' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.thread_id).toBe('th3');
    expect(body.messages).toEqual([{ role: 'user', content: 'brand new' }]);
    expect(body.context).toEqual({ kind: 'task', id: 't1' });
    expect(await screen.findByText('hi')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('maps tool rows to chips on the assistant reply', () => {
    const msgs = threadToMsgs([
      { id: '1', thread_id: 't', role: 'user', content: 'add a task', tool_json: null, created_at: '' },
      { id: '2', thread_id: 't', role: 'tool', content: '', tool_json: '{"tool":"mcp__workbench__tasks_create","status":"completed"}', created_at: '' },
      { id: '3', thread_id: 't', role: 'assistant', content: 'done', tool_json: null, created_at: '' },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.tools).toEqual([{ name: 'mcp__workbench__tasks_create', status: 'completed' }]);
  });
});

describe('ledger chart', () => {
  it('always renders 14 bars, zero days included', () => {
    const { container } = render(<DayBars data={[{ day: '2026-10-20', usd: 0.5 }]} today={new Date('2026-10-21T10:00:00Z')} />);
    const bars = container.querySelectorAll('[data-testid="day-bar"]');
    expect(bars).toHaveLength(14);
    expect(container.querySelectorAll('rect.zero')).toHaveLength(13);
    expect(bars[0]!.getAttribute('data-day')).toBe('2026-10-08');
    expect(bars[13]!.getAttribute('data-day')).toBe('2026-10-21');
  });
  it('fillDays on an empty summary is 14 zero days', () => {
    const d = fillDays([], new Date('2026-10-21T00:00:00Z'));
    expect(d).toHaveLength(14);
    expect(d.every((x) => x.usd === 0)).toBe(true);
  });
  it('shows today/7d/30d tiles and the per-run table', () => {
    render(
      <LedgerView
        summary={{ total_usd: 1, today_usd: 0.25, last7_usd: 0.75, last30_usd: 1, by_model: [], by_day: [] }}
        entries={[{ id: 'e1', ts: new Date().toISOString(), run_id: 'abcdef123456', model: 'm1', prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.25, source: 'chat' }]}
      />,
    );
    expect(screen.getByTestId('tile-today')).toHaveTextContent('$0.25');
    expect(screen.getByTestId('tile-7d')).toHaveTextContent('$0.75');
    expect(screen.getByTestId('tile-30d')).toHaveTextContent('$1.00');
    expect(screen.getAllByTestId('day-bar')).toHaveLength(14);
    expect(screen.getByTestId('run-row')).toHaveTextContent('abcdef12');
    expect(screen.getByTestId('run-row')).toHaveTextContent('15');
  });
});

describe('QuickBar', () => {
  const mkApi = () => ({
    config: { baseUrl: 'http://x', token: 't' },
    listApprovals: vi.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]),
    createTask: vi.fn().mockResolvedValue({ id: 't1', title: 'milk' }),
    listTasks: vi.fn().mockResolvedValue([]),
    latestUndoable: vi.fn().mockResolvedValue(entry),
    undo: vi.fn(),
    doctor: vi.fn(),
    decide: vi.fn(),
  });

  it('shows the approvals-waiting link; Enter spam in the input never decides and creates one task', async () => {
    const api = mkApi();
    render(<QuickBar api={api as unknown as Api} />);
    expect(await screen.findByTestId('quick-approvals-link')).toHaveTextContent('2 approvals waiting');
    const input = screen.getByLabelText('Quick command');
    expect(input).toHaveFocus();
    await userEvent.type(input, '/task milk');
    for (let i = 0; i < 6; i++) fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    expect(api.decide).not.toHaveBeenCalled();
    expect(await screen.findByTestId('cmd-done')).toHaveTextContent('milk');
  });

  it('Enter on an empty input is inert; arrow-selecting a suggestion then Enter completes it', async () => {
    const api = mkApi();
    render(<QuickBar api={api as unknown as Api} />);
    const input = screen.getByLabelText('Quick command');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/ask ');
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('/undo shows the target and no Confirm is reachable by Enter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mkApi();
    render(<QuickBar api={api as unknown as Api} />);
    const input = screen.getByLabelText('Quick command');
    fireEvent.change(input, { target: { value: '/undo' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByTestId('undo-target');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.undo).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(700)));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.undo).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('free text streams an /ask answer and offers Open in Workbench', async () => {
    const api = mkApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('event: delta\ndata: {"text":"Forty-two"}\n\nevent: done\ndata: {}\n\n', { status: 200 })));
    render(<QuickBar api={api as unknown as Api} />);
    const input = screen.getByLabelText('Quick command');
    await userEvent.type(input, 'meaning of life{Enter}');
    expect(await screen.findByTestId('ask-answer')).toHaveTextContent('Forty-two');
    expect(screen.getByTestId('open-in-workbench')).toBeInTheDocument();
    expect(api.createTask).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Esc calls the shell hide command when present, and only then', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    render(<QuickBar api={mkApi() as unknown as Api} />);
    await userEvent.type(screen.getByLabelText('Quick command'), 'hello{Escape}');
    expect(invoke).toHaveBeenCalledWith('hide_quick', {});
    expect(screen.getByLabelText('Quick command')).toHaveValue('');
    delete window.__TAURI_INTERNALS__;
    await userEvent.type(screen.getByLabelText('Quick command'), 'x{Escape}'); // browser: must not throw
  });
});

describe('approval alerts', () => {
  const ap = (id: string, tier = 1): Approval => ({
    id,
    tool: 'tasks_create',
    tier,
    args_json: '{}',
    summary: `sum ${id}`,
    status: 'pending',
    requested_by: 'hermes',
    created_at: '',
    decided_at: null,
    note: null,
  });
  function setup(background = true, nativePresent = true) {
    let t = 1_000_000;
    const native = { notify: vi.fn(), setBadge: vi.fn() };
    const focusApproval = vi.fn();
    const browserNotify = vi.fn();
    const alerts = createApprovalAlerts({
      now: () => t,
      isBackground: () => background,
      native: () => (nativePresent ? native : undefined),
      browserNotify,
      focusApproval,
    });
    return { alerts, native, focusApproval, browserNotify, advance: (ms: number) => (t += ms) };
  }

  it('notifies once per new approval when backgrounded, with no actions, and sets the badge', () => {
    const { alerts, native } = setup();
    alerts.sync([ap('a')]);
    alerts.sync([ap('a')]);
    expect(native.notify).toHaveBeenCalledTimes(1);
    expect(native.notify).toHaveBeenCalledWith('Approval needed', 'sum a', 'a');
    expect(native.notify.mock.calls[0]).toHaveLength(3);
    expect(native.setBadge).toHaveBeenLastCalledWith(1);
    alerts.sync([]);
    expect(native.setBadge).toHaveBeenLastCalledWith(0);
  });

  it('does not notify while the window is focused, but still sets the badge', () => {
    const { alerts, native } = setup(false);
    alerts.sync([ap('a'), ap('b')]);
    expect(native.notify).not.toHaveBeenCalled();
    expect(native.setBadge).toHaveBeenCalledWith(2);
  });

  it('falls back to the browser notification when there is no native bridge', () => {
    const { alerts, browserNotify, focusApproval } = setup(true, false);
    alerts.sync([ap('a', 2)]);
    expect(browserNotify).toHaveBeenCalledWith('Approval needed (destructive)', 'sum a', 'a', expect.any(Function));
    browserNotify.mock.calls[0]![3]();
    expect(focusApproval).toHaveBeenCalledTimes(1);
  });

  it('focuses the card once when the window activates within 2 minutes and the approval is still pending', () => {
    const { alerts, focusApproval, advance } = setup();
    alerts.sync([ap('a')]);
    advance(30_000);
    alerts.onActivate();
    alerts.onActivate();
    expect(focusApproval).toHaveBeenCalledTimes(1);
  });

  it('does not focus after 2 minutes, after the approval is handled, or without a notification', () => {
    const late = setup();
    late.alerts.sync([ap('a')]);
    late.advance(121_000);
    late.alerts.onActivate();
    expect(late.focusApproval).not.toHaveBeenCalled();

    const handled = setup();
    handled.alerts.sync([ap('a')]);
    handled.alerts.sync([]);
    handled.alerts.onActivate();
    expect(handled.focusApproval).not.toHaveBeenCalled();
    expect(handled.alerts._notifiedCount()).toBe(0);

    const none = setup(false);
    none.alerts.sync([ap('a')]);
    none.alerts.onActivate();
    expect(none.focusApproval).not.toHaveBeenCalled();
  });

  it('does not steal focus if the user typed in an input within the last second', () => {
    const { alerts, focusApproval, advance } = setup();
    alerts.sync([ap('a')]);
    advance(5000);
    alerts.noteTyping();
    advance(TYPING_GRACE_MS - 100);
    alerts.onActivate();
    expect(focusApproval).not.toHaveBeenCalled();
    advance(200); // typing was >1s ago, marker kept: a later activation may focus
    alerts.onActivate();
    expect(focusApproval).toHaveBeenCalledTimes(1);
  });
});
