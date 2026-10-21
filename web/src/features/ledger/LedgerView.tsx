import type { LedgerEntry, LedgerSummary } from '../../lib/types';
import { timeAgo, usd } from '../../lib/format';

export const CHART_DAYS = 14;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Exactly `n` consecutive days ending at the latest of (last data day, today); missing days are $0. */
export function fillDays(data: LedgerSummary['by_day'], today = new Date(), n = CHART_DAYS): { day: string; usd: number }[] {
  const byDay = new Map(data.map((d) => [d.day, d.usd]));
  const last = data.reduce((m, d) => (d.day > m ? d.day : m), isoDay(today));
  const end = new Date(`${last}T00:00:00Z`);
  const out: { day: string; usd: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = isoDay(new Date(end.getTime() - i * 86_400_000));
    out.push({ day, usd: byDay.get(day) ?? 0 });
  }
  return out;
}

export function DayBars({ data, today }: { data: LedgerSummary['by_day']; today?: Date }) {
  const days = fillDays(data, today);
  const W = 480;
  const H = 120;
  const padL = 40;
  const padR = 4;
  const top = 12;
  const max = Math.max(...days.map((d) => d.usd), 0);
  const scale = max > 0 ? max : 1;
  const bw = (W - padL - padR) / days.length;
  const ch = H - top;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="bars" role="img" aria-label="Spend by day, last 14 days" data-testid="day-chart">
        <line x1={padL} x2={W - padR} y1={top} y2={top} className="axis-line grid" />
        <line x1={padL} x2={W - padR} y1={H} y2={H} className="axis-line" />
        <text x={padL - 4} y={top + 3} textAnchor="end" className="axis" data-testid="y-max">
          {usd(max)}
        </text>
        <text x={padL - 4} y={H + 3} textAnchor="end" className="axis">
          $0
        </text>
        {days.map((d, i) => {
          const zero = d.usd <= 0;
          const h = zero ? 2 : Math.max(2, (d.usd / scale) * ch);
          return (
            <g key={d.day}>
              <rect
                x={padL + i * bw + 2}
                y={H - h}
                width={Math.max(bw - 4, 2)}
                height={h}
                rx={zero ? 1 : 3}
                className={zero ? 'bar zero' : 'bar'}
                data-testid="day-bar"
                data-day={d.day}
                data-usd={d.usd}
              >
                <title>{`${d.day} (UTC): ${usd(d.usd)}`}</title>
              </rect>
              {(i % 2 === 0 || i === days.length - 1) && (
                <text x={padL + i * bw + bw / 2} y={H + 13} textAnchor="middle" className="axis">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted chart-note" data-testid="chart-utc-note">
        Days are UTC, so a bar can differ from your local date near midnight.
      </figcaption>
    </figure>
  );
}

/** Today / 7d / 30d, from the summary (falls back to by_day where the core predates the fields). */
export function spendTiles(s: LedgerSummary): { id: string; label: string; usd: number | null }[] {
  const days = fillDays(s.by_day);
  const sum = (n: number) => days.slice(-n).reduce((t, d) => t + d.usd, 0);
  return [
    { id: 'today', label: 'Today', usd: s.today_usd ?? days[days.length - 1]!.usd },
    { id: '7d', label: 'Last 7 days', usd: s.last7_usd ?? sum(7) },
    { id: '30d', label: 'Last 30 days', usd: s.last30_usd ?? null },
  ];
}

function RunTable({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) return <p className="muted">No runs yet.</p>;
  return (
    <table className="table" data-testid="run-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Run</th>
          <th>Model</th>
          <th className="num">Tokens</th>
          <th className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} data-testid="run-row">
            <td title={e.ts}>{timeAgo(e.ts)}</td>
            <td>
              <code title={e.run_id}>{e.run_label || e.run_id.slice(-6)}</code>
            </td>
            <td>{e.model}</td>
            <td className="num">{(e.prompt_tokens + e.completion_tokens).toLocaleString()}</td>
            <td className="num">
              {usd(e.cost_usd)}{' '}
              {e.source === 'unpriced' && (
                <span className="badge unpriced" title="No price on file for this model">
                  unpriced
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LedgerView({ summary, entries = [] }: { summary: LedgerSummary | null; entries?: LedgerEntry[] }) {
  return (
    <section className="view" aria-label="Ledger">
      <header className="view-head">
        <h1>Ledger</h1>
        <span className="muted">Model spend</span>
      </header>
      {!summary ? (
        <div className="state muted">Loading ledger…</div>
      ) : (
        <>
          <div className="tiles" data-testid="spend-tiles">
            {spendTiles(summary).map((t) => (
              <div key={t.id} className="tile" data-testid={`tile-${t.id}`}>
                <span className="muted">{t.label}</span>
                <strong>{t.usd == null ? '—' : usd(t.usd)}</strong>
              </div>
            ))}
          </div>
          <h2 className="group-title">Last 14 days</h2>
          <DayBars data={summary.by_day} />
          {summary.by_model.length === 0 && summary.total_usd === 0 && !summary.total_tokens && (
            <div className="state empty">
              <strong>No spend recorded</strong>
              <p>Chat with Hermes and each run’s token cost shows up here.</p>
            </div>
          )}
          <div className="total" data-testid="ledger-total">
            <span className="muted">Total spend</span>
            <strong>{usd(summary.total_usd)}</strong>
            {summary.total_tokens != null && (
              <span className="muted" data-testid="ledger-tokens">
                {summary.total_tokens.toLocaleString()} tokens
              </span>
            )}
          </div>
          {(summary.unpriced_runs ?? 0) > 0 && (
            <p className="inline-warn" data-testid="ledger-unpriced-note">
              {summary.unpriced_runs} run{summary.unpriced_runs === 1 ? '' : 's'} used a model with no price on file, so the
              total above understates real spend.
            </p>
          )}
          <h2 className="group-title">By model</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.by_model.map((m) => (
                <tr key={m.model}>
                  <td>
                    {m.model}{' '}
                    {(m.priced === false || m.usd === 0) && (
                      <span className="badge unpriced" data-testid="unpriced-badge" title="No price on file for this model">
                        unpriced
                      </span>
                    )}
                  </td>
                  <td className="num">{m.tokens.toLocaleString()}</td>
                  <td className="num">{usd(m.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 className="group-title">Runs</h2>
          <RunTable entries={entries} />
        </>
      )}
    </section>
  );
}
