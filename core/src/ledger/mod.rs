//! Usage / cost ledger.

pub mod prices;

use rusqlite::{params, Connection, Row};
use serde::Serialize;

use crate::db::{new_id, now};
use crate::error::ApiResult;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LedgerEntry {
    pub id: String,
    pub ts: String,
    pub run_id: String,
    /// Short distinguishable tail of `run_id` (UUIDv7 prefixes look identical).
    pub run_label: String,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost_usd: f64,
    pub source: String,
}

/// The last 6 characters of a run id.
pub fn run_label(run_id: &str) -> String {
    let n = run_id.chars().count();
    run_id.chars().skip(n.saturating_sub(6)).collect()
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ModelTotal {
    pub model: String,
    pub priced: bool,
    pub usd: f64,
    pub tokens: i64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct DayTotal {
    pub day: String,
    pub usd: f64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Summary {
    pub total_usd: f64,
    pub today_usd: f64,
    pub last7_usd: f64,
    pub last30_usd: f64,
    pub total_tokens: i64,
    pub unpriced_runs: i64,
    pub by_model: Vec<ModelTotal>,
    pub by_day: Vec<DayTotal>,
}

fn row(r: &Row) -> rusqlite::Result<LedgerEntry> {
    let run_id: String = r.get(2)?;
    Ok(LedgerEntry {
        id: r.get(0)?,
        ts: r.get(1)?,
        run_label: run_label(&run_id),
        run_id,
        model: r.get(3)?,
        prompt_tokens: r.get(4)?,
        completion_tokens: r.get(5)?,
        cost_usd: r.get(6)?,
        source: r.get(7)?,
    })
}

/// Record a model call. Cost is computed from the price table; unknown models
/// are stored with cost 0 and `source = "unpriced"`.
pub fn record(
    conn: &Connection,
    run_id: &str,
    model: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> ApiResult<LedgerEntry> {
    let (cost_usd, priced) = prices::cost(model, prompt_tokens, completion_tokens);
    let e = LedgerEntry {
        id: new_id(),
        ts: now(),
        run_id: run_id.to_string(),
        run_label: run_label(run_id),
        model: model.to_string(),
        prompt_tokens,
        completion_tokens,
        cost_usd,
        source: if priced { "chat" } else { "unpriced" }.to_string(),
    };
    conn.execute(
        "INSERT INTO ledger(id, ts, run_id, model, prompt_tokens, completion_tokens, cost_usd, source)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            e.id,
            e.ts,
            e.run_id,
            e.model,
            e.prompt_tokens,
            e.completion_tokens,
            e.cost_usd,
            e.source
        ],
    )?;
    Ok(e)
}

pub fn entries(conn: &Connection, limit: usize) -> ApiResult<Vec<LedgerEntry>> {
    let mut st = conn.prepare(
        "SELECT id, ts, run_id, model, prompt_tokens, completion_tokens, cost_usd, source
         FROM ledger ORDER BY rowid DESC LIMIT ?1",
    )?;
    let rows = st.query_map(params![limit as i64], row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn summary(conn: &Connection) -> ApiResult<Summary> {
    summary_at(conn, chrono::Utc::now().date_naive())
}

/// Spend between `from` and `to` (inclusive UTC days, `YYYY-MM-DD`).
fn sum_between(conn: &Connection, from: &str, to: &str) -> ApiResult<f64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0.0) FROM ledger WHERE substr(ts, 1, 10) BETWEEN ?1 AND ?2",
        params![from, to],
        |r| r.get(0),
    )?)
}

/// `summary` relative to an explicit UTC `today` (so tests are deterministic).
/// `by_day` always holds exactly the last 14 days ending today, zero days included.
pub fn summary_at(conn: &Connection, today: chrono::NaiveDate) -> ApiResult<Summary> {
    let day = |back: u64| {
        (today - chrono::Days::new(back))
            .format("%Y-%m-%d")
            .to_string()
    };
    let today_s = day(0);
    let today_usd = sum_between(conn, &today_s, &today_s)?;
    let last7_usd = sum_between(conn, &day(6), &today_s)?;
    let last30_usd = sum_between(conn, &day(29), &today_s)?;
    let total_usd: f64 =
        conn.query_row("SELECT COALESCE(SUM(cost_usd), 0.0) FROM ledger", [], |r| {
            r.get(0)
        })?;
    let mut st = conn.prepare(
        "SELECT model, SUM(cost_usd), SUM(prompt_tokens + completion_tokens) FROM ledger
         GROUP BY model ORDER BY SUM(cost_usd) DESC, model",
    )?;
    let by_model = st
        .query_map([], |r| {
            let model: String = r.get(0)?;
            Ok(ModelTotal {
                priced: prices::price_for(&model).is_some(),
                model,
                usd: r.get(1)?,
                tokens: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut st = conn.prepare(
        "SELECT substr(ts, 1, 10) AS day, SUM(cost_usd) FROM ledger
         WHERE day BETWEEN ?1 AND ?2 GROUP BY day",
    )?;
    let sums: std::collections::HashMap<String, f64> = st
        .query_map(params![day(13), today_s], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let by_day = (0..14u64)
        .rev()
        .map(|back| {
            let d = day(back);
            DayTotal {
                usd: sums.get(&d).copied().unwrap_or(0.0),
                day: d,
            }
        })
        .collect();
    let (total_tokens, unpriced_runs): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0),
                COALESCE(SUM(source = 'unpriced'), 0) FROM ledger",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Summary {
        total_usd,
        today_usd,
        last7_usd,
        last30_usd,
        total_tokens,
        unpriced_runs,
        by_model,
        by_day,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn record_and_summarize() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let e = record(&c, "r1", "claude-sonnet-4", 1_000_000, 0).unwrap();
        assert_eq!(e.source, "chat");
        assert!((e.cost_usd - 3.0).abs() < 1e-9);
        let h = record(&c, "r2", "hermes-agent", 500, 500).unwrap();
        assert_eq!(h.source, "unpriced");
        assert_eq!(h.cost_usd, 0.0);
        record(&c, "r3", "claude-sonnet-4", 0, 1_000_000).unwrap();
        c.execute(
            "UPDATE ledger SET ts = '2020-01-01T00:00:00.000Z' WHERE run_id = 'r3'",
            [],
        )
        .unwrap();

        let s = summary(&c).unwrap();
        assert!((s.total_usd - 18.0).abs() < 1e-9);
        assert_eq!(s.by_model.len(), 2);
        assert_eq!(s.total_tokens, 2_001_000);
        assert_eq!(s.unpriced_runs, 1);
        assert!(s.by_model[0].priced && !s.by_model[1].priced);
        assert_eq!(s.by_model[0].model, "claude-sonnet-4");
        assert_eq!(s.by_model[0].tokens, 2_000_000);
        assert_eq!(s.by_day.len(), 14);
        assert!((s.today_usd - 3.0).abs() < 1e-9);
        assert!((s.last30_usd - 3.0).abs() < 1e-9);
        assert_eq!(entries(&c, 2).unwrap().len(), 2);
    }

    #[test]
    fn run_labels_are_the_last_six_chars() {
        assert_eq!(run_label("01a15bfe-9218-7555-a204-379bf138875d"), "38875d");
        assert_eq!(run_label("abc"), "abc");
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let e = record(&c, "run-123456789", "m", 1, 1).unwrap();
        assert_eq!(e.run_label, "456789");
        assert_eq!(entries(&c, 1).unwrap()[0].run_label, "456789");
    }

    #[test]
    fn empty_summary() {
        let db = Db::open_memory().unwrap();
        let s = summary(&db.lock()).unwrap();
        assert_eq!(s.total_usd, 0.0);
        assert!(s.by_model.is_empty());
        assert_eq!(s.by_day.len(), 14);
        assert!(s.by_day.iter().all(|d| d.usd == 0.0));
    }

    #[test]
    fn windows_and_zero_fill() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 3, 2).unwrap();
        // Each run costs $3 (1M prompt tokens of claude-sonnet-4).
        for (run, ts) in [
            ("a", "2026-03-02T23:59:59.999Z"), // today
            ("b", "2026-03-01T00:00:00.000Z"), // 1 day ago
            ("c", "2026-02-24T12:00:00.000Z"), // 6 days ago (last7 edge)
            ("d", "2026-02-23T12:00:00.000Z"), // 7 days ago
            ("e", "2026-02-17T12:00:00.000Z"), // 13 days ago (chart edge)
            ("f", "2026-02-16T12:00:00.000Z"), // 14 days ago (out of chart)
            ("g", "2026-01-31T12:00:00.000Z"), // 30 days ago (out of last30)
            ("h", "2026-02-01T12:00:00.000Z"), // 29 days ago (last30 edge)
        ] {
            record(&c, run, "claude-sonnet-4", 1_000_000, 0).unwrap();
            c.execute(
                "UPDATE ledger SET ts = ?2 WHERE run_id = ?1",
                params![run, ts],
            )
            .unwrap();
        }
        let s = summary_at(&c, today).unwrap();
        assert!((s.total_usd - 24.0).abs() < 1e-9);
        assert!((s.today_usd - 3.0).abs() < 1e-9);
        assert!((s.last7_usd - 9.0).abs() < 1e-9);
        assert!((s.last30_usd - 21.0).abs() < 1e-9);
        assert_eq!(s.by_day.len(), 14);
        assert_eq!(s.by_day[0].day, "2026-02-17");
        assert_eq!(s.by_day[13].day, "2026-03-02");
        assert!((s.by_day[0].usd - 3.0).abs() < 1e-9);
        assert_eq!(s.by_day[1].usd, 0.0);
        assert!((s.by_day[13].usd - 3.0).abs() < 1e-9);
        let nonzero = s.by_day.iter().filter(|d| d.usd > 0.0).count();
        assert_eq!(nonzero, 5); // e, d, c, b, a
    }
}
