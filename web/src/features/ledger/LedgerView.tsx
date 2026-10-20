import type { LedgerSummary } from '../../lib/types';
import { usd } from '../../lib/format';

export function DayBars({ data }: { data: LedgerSummary['by_day'] }) {
  const W = 480;
  const H = 120;
  const pad = 4;
  const max = Math.max(...data.map((d) => d.usd), 0.0001);
  const bw = (W - pad * 2) / Math.max(data.length, 1);
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="bars" role="img" aria-label="Spend by day">
      {data.map((d, i) => {
        const h = Math.max(2, (d.usd / max) * H);
        return (
          <g key={d.day}>
            <rect x={pad + i * bw + 2} y={H - h} width={Math.max(bw - 4, 2)} height={h} rx={3} className="bar">
              <title>{`${d.day}: ${usd(d.usd)}`}</title>
            </rect>
            {data.length <= 14 && (
              <text x={pad + i * bw + bw / 2} y={H + 13} textAnchor="middle" className="axis">
                {d.day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function LedgerView({ summary }: { summary: LedgerSummary | null }) {
  return (
    <section className="view" aria-label="Ledger">
      <header className="view-head">
        <h1>Ledger</h1>
        <span className="muted">Model spend</span>
      </header>
      {!summary ? (
        <div className="state muted">Loading ledger…</div>
      ) : summary.by_model.length === 0 && summary.total_usd === 0 ? (
        <div className="state empty">
          <strong>No spend recorded</strong>
          <p>Chat with Hermes and each run’s token cost shows up here.</p>
        </div>
      ) : (
        <>
          <div className="total" data-testid="ledger-total">
            <span className="muted">Total spend</span>
            <strong>{usd(summary.total_usd)}</strong>
          </div>
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
                  <td>{m.model}</td>
                  <td className="num">{m.tokens.toLocaleString()}</td>
                  <td className="num">{usd(m.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 className="group-title">By day</h2>
          {summary.by_day.length > 0 ? <DayBars data={summary.by_day} /> : <p className="muted">No daily data.</p>}
        </>
      )}
    </section>
  );
}
