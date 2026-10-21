import commandsSrc from '../commands.ts?raw';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMANDS,
  availableCommands,
  describeEntry,
  parseInput,
  parseSlash,
  planSubmit,
  resolveView,
  type CommandApi,
  type CommandCtx,
} from '../commands';
import type { JournalEntry } from '../types';

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
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
  ...over,
});

/** An API where every method is a spy, plus a trap for anything that decides approvals. */
function spyCtx() {
  const decide = vi.fn();
  const api = {
    config: { baseUrl: 'http://x', token: 't' },
    createTask: vi.fn().mockResolvedValue({ id: 't1', title: 'x' }),
    listTasks: vi.fn().mockResolvedValue([]),
    latestUndoable: vi.fn().mockResolvedValue(entry()),
    undo: vi.fn().mockResolvedValue(entry()),
    doctor: vi.fn().mockResolvedValue({ ok: true, checks: [] }),
    decide,
  };
  const ui = vi.fn();
  const ctx: CommandCtx = { api: api as unknown as CommandApi, ui, pendingApprovals: 2, surface: 'palette' };
  return { api, ui, ctx, decide };
}

describe('command registry', () => {
  it('has the contract slash commands', () => {
    expect(COMMANDS.filter((c) => c.slash).map((c) => c.slash)).toEqual(['task', 'ask', 'find', 'goto', 'undo', 'status']);
  });

  it('ids are unique', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no command id or title is an approve/deny verb (only "Review pending approval" mentions approvals)', () => {
    for (const c of COMMANDS) {
      expect(c.id).not.toMatch(/^(approve|deny|decide|reject|allow)/i);
      expect(c.title).not.toMatch(/^(approve|deny|decide|reject|allow)/i);
    }
  });

  it('the registry source never references the decision API', () => {
    const src = commandsSrc
      .split('\n')
      .filter((l: string) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    expect(src).not.toMatch(/\.decide\b/);
    expect(src).not.toMatch(/\/decision/);
    expect(src).not.toMatch(/['"`]approve['"`]|['"`]deny['"`]/);
    // and the CommandApi type does not include it
    expect(src).toMatch(/Pick<Api, 'config' \| 'createTask' \| 'listTasks' \| 'latestUndoable' \| 'undo' \| 'doctor' \| 'createThread' \| 'listThreads'>/);
  });

  it('running EVERY command with plausible args never calls decide, and never undoes by itself', async () => {
    for (const c of COMMANDS) {
      for (const args of ['', 'hello', 'ledger', 'approve', 'deny']) {
        const { ctx, api, decide } = spyCtx();
        await c.run(args, ctx);
        expect(decide).not.toHaveBeenCalled();
        expect(api.undo).not.toHaveBeenCalled();
      }
    }
  });

  it('review-approval is hidden unless one is pending and only requests focus', async () => {
    const { ctx, ui } = spyCtx();
    expect(availableCommands({ ...ctx, pendingApprovals: 0 }).some((c) => c.id === 'focus-approval')).toBe(false);
    const cmd = availableCommands(ctx).find((c) => c.id === 'focus-approval')!;
    await cmd.run('', ctx);
    expect(ui).toHaveBeenCalledWith({ type: 'focus-approval' });
  });
});

describe('slash parser', () => {
  it('splits name and args', () => {
    expect(parseSlash('/task buy  milk ')).toEqual({ name: 'task', args: 'buy  milk', hasSpace: true });
    expect(parseSlash('/undo')).toEqual({ name: 'undo', args: '', hasSpace: false });
    expect(parseSlash('hello /task')).toBeNull();
  });
  it('classifies input', () => {
    expect(parseInput('')).toEqual({ kind: 'empty' });
    expect(parseInput('what is up').kind).toBe('text');
    const t = parseInput('/task buy milk');
    expect(t.kind === 'command' && t.command.id === 'task' && t.args === 'buy milk').toBe(true);
    const p = parseInput('/t');
    expect(p.kind === 'partial' && p.matches.map((m) => m.id)).toEqual(['task']);
    expect(parseInput('/').kind).toBe('partial');
    expect(parseInput('/nope x')).toEqual({ kind: 'unknown', name: 'nope' });
  });
  it('resolves /goto targets', () => {
    expect(resolveView('activity')).toBe('journal');
    expect(resolveView('led')).toBe('ledger');
    expect(resolveView('a')).toBeNull(); // approvals or activity: ambiguous
  });
});

describe('planSubmit', () => {
  const ask = { freeTextAsk: true };
  it('free text is /ask in the quick bar', () => {
    const p = planSubmit('what is due?', undefined, ask);
    expect(p.action === 'run' && p.command.id === 'ask' && p.args === 'what is due?').toBe(true);
  });
  it('a bare arg-taking slash command completes instead of running; empty Enter never runs a write', () => {
    expect(planSubmit('/task', undefined, ask)).toEqual({ action: 'fill', text: '/task ' });
    expect(planSubmit('', COMMANDS[0], ask)).toEqual({ action: 'fill', text: '/task ' });
    expect(planSubmit('', undefined, ask)).toEqual({ action: 'none' });
  });
  it('runs /task with args and reports unknown commands', () => {
    const p = planSubmit('/task buy milk', undefined, ask);
    expect(p.action === 'run' && p.command.id === 'task' && p.args === 'buy milk').toBe(true);
    expect(planSubmit('/zzz', undefined, ask).action).toBe('error');
  });
  it('palette mode (no free-text ask) runs the highlighted command for plain text', () => {
    const g = COMMANDS.find((c) => c.id === 'go-ledger')!;
    const p = planSubmit('ledg', g, { freeTextAsk: false });
    expect(p.action === 'run' && p.command.id === 'go-ledger').toBe(true);
  });
});

describe('command behaviours', () => {
  const byId = (id: string) => COMMANDS.find((c) => c.id === id)!;
  it('/task creates a task through the user API', async () => {
    const { ctx, api } = spyCtx();
    const r = await byId('task').run('buy milk', ctx);
    expect(api.createTask).toHaveBeenCalledWith({ title: 'buy milk' });
    expect(r.kind).toBe('done');
    expect((await byId('task').run('  ', ctx)).kind).toBe('error');
  });
  it('/undo only looks up the entry', async () => {
    const { ctx, api } = spyCtx();
    const r = await byId('undo').run('', ctx);
    expect(r.kind).toBe('undo');
    expect(api.undo).not.toHaveBeenCalled();
  });
  it('/goto requests navigation; bad targets are errors', () => {
    const { ctx, ui } = spyCtx();
    byId('goto').run('ledger', ctx);
    expect(ui).toHaveBeenCalledWith({ type: 'goto', view: 'ledger' });
    expect(byId('goto').run('moon', ctx)).toMatchObject({ kind: 'error' });
  });
  it('/find filters tasks client-side', async () => {
    const { ctx, api } = spyCtx();
    api.listTasks.mockResolvedValue([
      { id: '1', title: 'Buy milk', notes: '', status: 'todo' },
      { id: '2', title: 'Other', notes: 'has MILK inside', status: 'todo' },
      { id: '3', title: 'Nope', notes: '', status: 'todo' },
    ]);
    const r = await byId('find').run('milk', ctx);
    expect(r.kind === 'find' && r.tasks.map((t) => t.id)).toEqual(['1', '2']);
  });
  it('describeEntry names the tool and title', () => {
    expect(describeEntry(entry())).toBe('tasks_create “Buy milk”');
  });
});
