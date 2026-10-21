import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyScore } from '../../lib/format';
import {
  availableCommands,
  fuzzyFilter,
  planSubmit,
  suggest,
  type Command,
  type CommandCtx,
  type CommandResult,
} from '../../lib/commands';
import { ResultView } from './CommandResult';

interface Props {
  open: boolean;
  ctx: CommandCtx;
  onClose: () => void;
}

export const filterCommands = (commands: Command[], query: string) => fuzzyFilter(commands, query, fuzzyScore);

/** ⌘K palette: same registry as the quick bar. Running a command can never decide an approval. */
export function CommandPalette({ open, ctx, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<CommandResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(() => availableCommands(ctx), [ctx]);
  const results = useMemo(() => suggest(query, commands, fuzzyScore), [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setResult(null);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const exec = async (c: Command, args: string) => {
    const r = await c.run(args, ctx);
    if (r.kind === 'none') onClose();
    else {
      setResult(r);
      setQuery('');
      setIndex(0);
    }
  };
  const submit = (highlighted: Command | undefined) => {
    const plan = planSubmit(query, highlighted, { freeTextAsk: false }, commands);
    if (plan.action === 'fill') setQuery(plan.text);
    else if (plan.action === 'error') setResult({ kind: 'error', message: plan.message });
    else if (plan.action === 'run') void exec(plan.command, plan.args);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          aria-label="Command"
          placeholder="Type a command or /task, /ask, /find, /goto, /undo, /status…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            setResult(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (e.repeat || e.nativeEvent.isComposing) return;
              submit(results[index]);
            }
          }}
        />
        {result && (
          <div className="palette-result">
            <ResultView
              result={result}
              ctx={ctx}
              onOpenInWorkbench={(q) => {
                ctx.ui({ type: 'ask-in-chat', text: q });
                onClose();
              }}
            />
          </div>
        )}
        <ul role="listbox">
          {results.length === 0 && <li className="muted palette-empty">No matching commands</li>}
          {results.map((a, i) => (
            <li
              key={a.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'active' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                setIndex(i);
                submit(a);
              }}
            >
              <span>
                {a.title}
                {a.usage && <span className="muted"> {a.usage}</span>}
              </span>
              {a.hint && <kbd>{a.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
