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
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost_usd: f64,
    pub source: String,
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
    pub total_tokens: i64,
    pub unpriced_runs: i64,
    pub by_model: Vec<ModelTotal>,
    pub by_day: Vec<DayTotal>,
}

fn row(r: &Row) -> rusqlite::Result<LedgerEntry> {
    Ok(LedgerEntry {
        id: r.get(0)?,
        ts: r.get(1)?,
        run_id: r.get(2)?,
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
        "SELECT substr(ts, 1, 10) AS day, SUM(cost_usd) FROM ledger GROUP BY day ORDER BY day",
    )?;
    let by_day = st
        .query_map([], |r| {
            Ok(DayTotal {
                day: r.get(0)?,
                usd: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let (total_tokens, unpriced_runs): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0),
                COALESCE(SUM(source = 'unpriced'), 0) FROM ledger",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Summary {
        total_usd,
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
        assert_eq!(s.by_day.len(), 2);
        assert_eq!(s.by_day[0].day, "2020-01-01");
        assert_eq!(entries(&c, 2).unwrap().len(), 2);
    }

    #[test]
    fn empty_summary() {
        let db = Db::open_memory().unwrap();
        let s = summary(&db.lock()).unwrap();
        assert_eq!(s.total_usd, 0.0);
        assert!(s.by_model.is_empty() && s.by_day.is_empty());
    }
}
