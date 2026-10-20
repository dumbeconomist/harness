//! Per-1M-token USD prices by model-name prefix. Unknown models are unpriced.

/// (prefix, input USD per 1M tokens, output USD per 1M tokens).
/// The longest matching prefix wins, so order does not matter.
pub const PRICES: &[(&str, f64, f64)] = &[
    ("claude-opus-4", 15.0, 75.0),
    ("claude-3-opus", 15.0, 75.0),
    ("claude-opus", 15.0, 75.0),
    ("claude-sonnet", 3.0, 15.0),
    ("claude-3-7-sonnet", 3.0, 15.0),
    ("claude-3-5-sonnet", 3.0, 15.0),
    ("claude-haiku-4", 1.0, 5.0),
    ("claude-haiku", 1.0, 5.0),
    ("claude-3-5-haiku", 0.8, 4.0),
    ("claude-3-haiku", 0.25, 1.25),
    ("gpt-4o-mini", 0.15, 0.6),
    ("gpt-4o", 2.5, 10.0),
    ("gpt-4.1-mini", 0.4, 1.6),
    ("gpt-4.1", 2.0, 8.0),
    ("gpt-4-turbo", 10.0, 30.0),
    // Hermes is a local/self-hosted brain: deliberately unpriced.
];

/// Strip a provider prefix ("anthropic/claude-...") and lowercase.
fn normalize(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .trim()
        .to_ascii_lowercase()
}

pub fn price_for(model: &str) -> Option<(f64, f64)> {
    let m = normalize(model);
    PRICES
        .iter()
        .filter(|(p, _, _)| m.starts_with(p))
        .max_by_key(|(p, _, _)| p.len())
        .map(|(_, i, o)| (*i, *o))
}

/// Returns `(cost_usd, priced)`. Unknown models cost 0 and are flagged unpriced.
pub fn cost(model: &str, prompt_tokens: i64, completion_tokens: i64) -> (f64, bool) {
    match price_for(model) {
        Some((i, o)) => (
            (prompt_tokens as f64 * i + completion_tokens as f64 * o) / 1_000_000.0,
            true,
        ),
        None => (0.0, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_known_models() {
        let (c, priced) = cost("claude-sonnet-4-5", 1_000_000, 1_000_000);
        assert!(priced);
        assert!((c - 18.0).abs() < 1e-9);
        let (c, _) = cost("claude-opus-4-1", 1_000_000, 0);
        assert!((c - 15.0).abs() < 1e-9);
        assert!(price_for("claude-haiku-4-5").is_some());
        assert!(price_for("anthropic/claude-3-5-haiku-latest").is_some());
        assert!(price_for("GPT-4o-2024-08-06").is_some());
    }

    #[test]
    fn longest_prefix_wins() {
        assert_eq!(price_for("gpt-4o-mini-2024").unwrap().0, 0.15);
        assert_eq!(price_for("gpt-4o-2024").unwrap().0, 2.5);
    }

    #[test]
    fn hermes_and_unknown_are_unpriced() {
        assert_eq!(cost("hermes-agent", 1000, 1000), (0.0, false));
        assert_eq!(cost("hermes", 1, 1), (0.0, false));
        assert_eq!(cost("mystery", 1, 1), (0.0, false));
    }
}
