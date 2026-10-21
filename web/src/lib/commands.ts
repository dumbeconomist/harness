/**
 * The single command registry used by the ⌘K palette AND the quick bar.
 *
 * SAFETY: nothing in this file may approve or deny an approval. `CommandApi` deliberately has no
 * decision method, and a unit test scans this file and runs every command to prove it.
 */
import type { Api } from './api';
import type { Doctor, JournalEntry, Task } from './types';

export type View = 'tasks' | 'approvals' | 'journal' | 'ledger' | 'settings';

export const VIEWS: { id: View; label: string; names: string[] }[] = [
  { id: 'tasks', label: 'Tasks', names: ['tasks'] },
  { id: 'approvals', label: 'Approvals', names: ['approvals'] },
  { id: 'journal', label: 'Activity', names: ['activity', 'journal'] },
  { id: 'ledger', label: 'Ledger', names: ['ledger'] },
  { id: 'settings', label: 'Settings', names: ['settings'] },
];

/** UI side effects a command may request. The host (main app, or quick bar → main) performs them. */
export type UiAction =
  | { type: 'goto'; view: View }
  | { type: 'new-task' }
  | { type: 'toggle-chat' }
  | { type: 'ask-in-chat'; text: string }
  | { type: 'open-thread'; id: string }
  | { type: 'focus-approval' }
  | { type: 'open-task'; id: string };

/** The only API surface commands get. No decision method exists here by construction. */
export type CommandApi = Pick<Api, 'config' | 'createTask' | 'listTasks' | 'latestUndoable' | 'undo' | 'doctor' | 'createThread'>;

export interface CommandCtx {
  api: CommandApi;
  ui: (action: UiAction) => void;
  pendingApprovals: number;
  surface: 'palette' | 'quick';
}

export type CommandResult =
  | { kind: 'none' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ask'; question: string }
  | { kind: 'undo'; entry: JournalEntry | null }
  | { kind: 'status'; doctor: Doctor }
  | { kind: 'find'; query: string; tasks: Task[] };

export interface Command {
  id: string;
  title: string;
  keywords: string;
  slash?: string;
  usage?: string;
  /** Slash command that needs text after it (Enter completes `/task ` instead of running it bare). */
  takesArgs?: boolean;
  hint?: string;
  available?: (ctx: CommandCtx) => boolean;
  run: (args: string, ctx: CommandCtx) => CommandResult | Promise<CommandResult>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function resolveView(name: string): View | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const exact = VIEWS.find((v) => v.names.includes(n));
  if (exact) return exact.id;
  const pre = VIEWS.filter((v) => v.names.some((x) => x.startsWith(n)));
  return pre.length === 1 ? pre[0]!.id : null;
}

const goto = (view: View, ctx: CommandCtx): CommandResult => {
  ctx.ui({ type: 'goto', view });
  return { kind: 'none' };
};

export const COMMANDS: Command[] = [
  {
    id: 'task',
    title: 'Add task',
    keywords: 'new create todo add',
    slash: 'task',
    usage: '/task <title>',
    takesArgs: true,
    run: async (args, ctx) => {
      const title = args.trim();
      if (!title) return { kind: 'error', message: 'Usage: /task <title>' };
      try {
        const t = await ctx.api.createTask({ title });
        return { kind: 'done', message: `Added task “${t.title}”` };
      } catch (e) {
        return { kind: 'error', message: `Could not add task: ${errMsg(e)}` };
      }
    },
  },
  {
    id: 'ask',
    title: 'Ask Hermes',
    keywords: 'chat question message',
    slash: 'ask',
    usage: '/ask <question>',
    takesArgs: true,
    run: (args) => {
      const question = args.trim();
      return question ? { kind: 'ask', question } : { kind: 'error', message: 'Usage: /ask <question>' };
    },
  },
  {
    id: 'find',
    title: 'Find tasks',
    keywords: 'search lookup',
    slash: 'find',
    usage: '/find <text>',
    takesArgs: true,
    run: async (args, ctx) => {
      const query = args.trim();
      if (!query) return { kind: 'error', message: 'Usage: /find <text>' };
      try {
        const needle = query.toLowerCase();
        const tasks = (await ctx.api.listTasks()).filter((t) => `${t.title}\n${t.notes}`.toLowerCase().includes(needle));
        return { kind: 'find', query, tasks: tasks.slice(0, 20) };
      } catch (e) {
        return { kind: 'error', message: `Search failed: ${errMsg(e)}` };
      }
    },
  },
  {
    id: 'goto',
    title: 'Go to view',
    keywords: 'navigate open',
    slash: 'goto',
    usage: '/goto <tasks|approvals|activity|ledger|settings>',
    takesArgs: true,
    run: (args, ctx) => {
      const view = resolveView(args);
      if (!view) return { kind: 'error', message: 'Usage: /goto <tasks|approvals|activity|ledger|settings>' };
      return goto(view, ctx);
    },
  },
  {
    id: 'undo',
    title: 'Undo last change',
    keywords: 'revert rollback',
    slash: 'undo',
    usage: '/undo',
    run: async (_args, ctx) => {
      try {
        // Only looks up the entry. Undoing requires the armed, explicit Confirm in the result view.
        return { kind: 'undo', entry: await ctx.api.latestUndoable() };
      } catch (e) {
        return { kind: 'error', message: `Could not look up the last change: ${errMsg(e)}` };
      }
    },
  },
  {
    id: 'status',
    title: 'Connection status',
    keywords: 'doctor health hermes check',
    slash: 'status',
    usage: '/status',
    run: async (_args, ctx) => {
      try {
        return { kind: 'status', doctor: await ctx.api.doctor() };
      } catch (e) {
        return { kind: 'error', message: `Doctor unavailable: ${errMsg(e)}` };
      }
    },
  },
  {
    id: 'new-task',
    title: 'New task',
    hint: '⌘N',
    keywords: 'add create todo',
    run: (_a, ctx) => {
      ctx.ui({ type: 'new-task' });
      return { kind: 'none' };
    },
  },
  ...VIEWS.map<Command>((v, i) => ({
    id: `go-${v.id}`,
    title: `Go to ${v.label}`,
    hint: `⌘${i + 1}`,
    keywords: '',
    run: (_a, ctx) => goto(v.id, ctx),
  })),
  {
    id: 'toggle-chat',
    title: 'Toggle Hermes pane',
    hint: '⌘J',
    keywords: 'chat ask show hide',
    run: (_a, ctx) => {
      ctx.ui({ type: 'toggle-chat' });
      return { kind: 'none' };
    },
  },
  {
    id: 'ask-hermes',
    title: 'Ask Hermes in the side pane…',
    keywords: 'chat message',
    run: (_a, ctx) => {
      ctx.ui({ type: 'ask-in-chat', text: '' });
      return { kind: 'none' };
    },
  },
  {
    // Only brings the card into view/focus. Deciding stays exclusively inside the approval card.
    id: 'focus-approval',
    title: 'Review pending approval',
    hint: '⌘⇧A',
    keywords: 'approve deny approval card focus',
    available: (ctx) => ctx.pendingApprovals > 0,
    run: (_a, ctx) => {
      ctx.ui({ type: 'focus-approval' });
      return { kind: 'none' };
    },
  },
];

export const availableCommands = (ctx: Pick<CommandCtx, 'pendingApprovals'> & Partial<CommandCtx>): Command[] =>
  COMMANDS.filter((c) => !c.available || c.available(ctx as CommandCtx));

export type Parsed =
  | { kind: 'empty' }
  | { kind: 'command'; command: Command; args: string }
  | { kind: 'partial'; matches: Command[]; prefix: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'text'; text: string };

/** `/name rest` → pieces. Returns null for text that is not a slash command. */
export function parseSlash(input: string): { name: string; args: string; hasSpace: boolean } | null {
  const m = /^\s*\/(\S*)(\s+([\s\S]*))?$/.exec(input);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: (m[3] ?? '').trim(), hasSpace: m[2] !== undefined };
}

/** Classify what the user typed. A complete `/name` (or `/name args`) is a command; `/ta` is a partial. */
export function parseInput(input: string, commands: Command[] = COMMANDS): Parsed {
  if (!input.trim()) return { kind: 'empty' };
  const s = parseSlash(input);
  if (!s) return { kind: 'text', text: input.trim() };
  const slashes = commands.filter((c) => c.slash);
  const exact = slashes.find((c) => c.slash === s.name);
  if (exact) return { kind: 'command', command: exact, args: s.args };
  if (!s.hasSpace) {
    const matches = slashes.filter((c) => c.slash!.startsWith(s.name));
    if (matches.length > 0 || s.name === '') return { kind: 'partial', matches: matches.length ? matches : slashes, prefix: s.name };
  }
  return { kind: 'unknown', name: s.name };
}

export function fuzzyFilter(commands: Command[], query: string, score: (q: string, t: string) => number): Command[] {
  if (!query.trim()) return commands;
  return commands
    .map((c) => ({ c, s: score(query, `${c.title} ${c.slash ? '/' + c.slash : ''} ${c.keywords}`) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);
}

/** Human summary of a journal entry for the /undo confirmation. */
export function describeEntry(e: JournalEntry): string {
  let args: Record<string, unknown> | null = null;
  if (typeof e.args_json === 'string') {
    try {
      args = JSON.parse(e.args_json) as Record<string, unknown>;
    } catch {
      args = null;
    }
  } else args = e.args_json;
  const label = typeof args?.title === 'string' ? ` “${args.title}”` : typeof args?.id === 'string' ? ` (${args.id.slice(0, 8)})` : '';
  return `${e.tool}${label}`;
}

/** Time the Confirm button stays hidden after /undo shows its target. */
export const UNDO_ARM_MS = 600;

export type Plan =
  | { action: 'run'; command: Command; args: string }
  | { action: 'fill'; text: string }
  | { action: 'error'; message: string }
  | { action: 'none' };

const planFor = (c: Command): Plan =>
  c.slash && c.takesArgs ? { action: 'fill', text: `/${c.slash} ` } : { action: 'run', command: c, args: '' };

/**
 * What should Enter do? Pure, so both surfaces behave identically and tests can pin it down.
 * Never returns anything but a command from the registry, so it cannot decide an approval.
 */
export function planSubmit(
  input: string,
  highlighted: Command | undefined,
  opts: { freeTextAsk: boolean },
  commands: Command[] = COMMANDS,
): Plan {
  const p = parseInput(input, commands);
  switch (p.kind) {
    case 'empty':
      return highlighted ? planFor(highlighted) : { action: 'none' };
    case 'command':
      if (p.command.takesArgs && !p.args) return { action: 'fill', text: `/${p.command.slash} ` };
      return { action: 'run', command: p.command, args: p.args };
    case 'partial': {
      const pick = highlighted && p.matches.includes(highlighted) ? highlighted : p.matches[0];
      return pick ? planFor(pick) : { action: 'none' };
    }
    case 'unknown':
      return { action: 'error', message: `Unknown command /${p.name}. Try /task, /ask, /find, /goto, /undo or /status.` };
    case 'text': {
      if (opts.freeTextAsk) {
        const ask = commands.find((c) => c.id === 'ask');
        return ask ? { action: 'run', command: ask, args: p.text } : { action: 'none' };
      }
      return highlighted ? planFor(highlighted) : { action: 'none' };
    }
  }
}

/** Suggestions for the current input (slash prefix → matching slash commands, otherwise fuzzy). */
export function suggest(
  input: string,
  commands: Command[],
  score: (q: string, t: string) => number,
): Command[] {
  const p = parseInput(input, commands);
  if (p.kind === 'empty') return commands;
  if (p.kind === 'command') return [p.command];
  if (p.kind === 'partial') return p.matches;
  if (p.kind === 'unknown') return [];
  return fuzzyFilter(commands, p.text, score);
}
