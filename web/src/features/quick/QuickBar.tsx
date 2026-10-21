import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api as defaultApi, type Api } from '../../lib/api';
import { fuzzyScore } from '../../lib/format';
import {
  availableCommands,
  planSubmit,
  suggest,
  type Command,
  type CommandCtx,
  type CommandResult,
  type UiAction,
} from '../../lib/commands';
import { hideQuickWindow, openMainWindow } from '../../lib/native';
import { postHandoff } from '../../lib/handoff';
import { connectEvents } from '../../lib/sse';
import { ResultView } from '../palette/CommandResult';

/** Count of pending approvals, kept live over SSE. Display only: the quick bar can never decide one. */
export function useApprovalCount(api: Api): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .listApprovals('pending')
        .then((a) => live && setN(a.length))
        .catch(() => undefined);
    void load();
    const stop =
      typeof EventSource === 'undefined'
        ? () => undefined
        : connectEvents({
            cfg: api.config,
            onStatus: (s) => s === 'open' && void load(),
            onEvent: (e) => (e.type === 'approval.created' || e.type === 'approval.decided') && void load(),
          });
    return () => {
      live = false;
      stop();
    };
  }, [api]);
  return n;
}

/** Hand an action to the main window: native shell if present, otherwise navigate this tab to the app. */
export function sendToMain(action?: UiAction) {
  if (action) postHandoff(action);
  if (!openMainWindow()) window.location.hash = '#/';
}

export function QuickBar({ api = defaultApi }: { api?: Api }) {
  const [input, setInput] = useState('');
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<CommandResult | null>(null);
  // With an empty input, Enter only acts on a suggestion the user explicitly arrowed to (so Enter spam is inert).
  const [navigated, setNavigated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const waiting = useApprovalCount(api);

  const ctx: CommandCtx = useMemo(
    () => ({ api, ui: (a) => sendToMain(a), pendingApprovals: waiting, surface: 'quick' }),
    [api, waiting],
  );
  const commands = useMemo(() => availableCommands(ctx), [ctx]);
  const list = useMemo(() => suggest(input, commands, fuzzyScore), [commands, input]);

  // Focus our own input when the window is shown. (The quick window has no approval card.)
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    focus();
    const vis = () => document.visibilityState === 'visible' && focus();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  const reset = useCallback(() => {
    setInput('');
    setIndex(0);
    setResult(null);
    setNavigated(false);
  }, []);

  const hide = useCallback(() => {
    reset(); // aborts any streaming answer (ResultView unmounts)
    hideQuickWindow();
  }, [reset]);

  const exec = async (c: Command, args: string) => {
    // Clear first: a held or repeated Enter then finds nothing to re-run.
    setInput('');
    setIndex(0);
    setNavigated(false);
    setResult(null);
    const r = await c.run(args, ctx);
    setResult(r);
  };

  const submit = (highlighted: Command | undefined, explicit = navigated) => {
    const plan = planSubmit(input, input.trim() === '' && !explicit ? undefined : highlighted, { freeTextAsk: true }, commands);
    if (plan.action === 'fill') setInput(plan.text);
    else if (plan.action === 'error') setResult({ kind: 'error', message: plan.message });
    else if (plan.action === 'run') void exec(plan.command, plan.args);
  };

  const showList = list.length > 0 && (input.trim() === '' || input.trimStart().startsWith('/') || result === null);
  const hint =
    input.trim() && !input.trimStart().startsWith('/') ? 'Enter to ask Hermes' : 'Type a command, or just ask Hermes';

  return (
    <div className="quick" data-testid="quick-bar">
      <input
        ref={inputRef}
        className="quick-input"
        aria-label="Quick command"
        placeholder="Ask Hermes, or /task, /find, /goto, /undo, /status…"
        value={input}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setInput(e.target.value);
          setIndex(0);
          setNavigated(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            hide();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setNavigated(true);
            setIndex((i) => Math.min(list.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setNavigated(true);
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.repeat || e.nativeEvent.isComposing) return;
            submit(list[index]);
          }
        }}
      />
      <div className="quick-body">
        {result && (
          <ResultView result={result} ctx={ctx} onOpenInWorkbench={(q) => sendToMain({ type: 'ask-in-chat', text: q })} />
        )}
        {showList && (
          <ul role="listbox" className="quick-list" aria-label="Suggestions">
            {list.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === index}
                className={i === index ? 'active' : ''}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  setIndex(i);
                  setNavigated(true);
                  inputRef.current?.focus();
                  submit(c);
                }}
              >
                <span>
                  {c.title}
                  {c.usage && <span className="muted"> {c.usage}</span>}
                </span>
                {c.hint && <kbd>{c.hint}</kbd>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="quick-foot">
        <span className="muted">{hint} · Esc to close</span>
        {waiting > 0 && (
          <button
            className="link"
            data-testid="quick-approvals-link"
            onClick={() => sendToMain({ type: 'focus-approval' })}
          >
            {waiting} approval{waiting === 1 ? '' : 's'} waiting → Open
          </button>
        )}
      </footer>
    </div>
  );
}
