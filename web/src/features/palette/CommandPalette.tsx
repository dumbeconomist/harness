import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyScore } from '../../lib/format';

export interface PaletteAction {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}

export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  if (!query.trim()) return actions;
  return actions
    .map((a) => ({ a, s: fuzzyScore(query, `${a.title} ${a.keywords ?? ''}`) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);
}

export function CommandPalette({ open, actions, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterActions(actions, query), [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;
  const run = (a: PaletteAction | undefined) => {
    if (!a) return;
    onClose();
    a.run();
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          aria-label="Command"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
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
              run(results[index]);
            }
          }}
        />
        <ul role="listbox">
          {results.length === 0 && <li className="muted palette-empty">No matching commands</li>}
          {results.map((a, i) => (
            <li
              key={a.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'active' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(a)}
            >
              <span>{a.title}</span>
              {a.hint && <kbd>{a.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
