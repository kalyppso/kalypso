//! Model prices, read from `pricing.toml` in the app data folder. The file is
//! created from the defaults below on first run and re-read when it changes, so
//! users can correct a price or add a model without restarting.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Deserialize;

use super::usage::Usage;

pub const DEFAULT_TOML: &str = include_str!("pricing.default.toml");

/// US dollars per million tokens.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    /// Writes to the 5-minute cache. Defaults to 1.25 × input.
    pub cache_write: Option<f64>,
    /// Writes to the 1-hour cache. Defaults to 2 × input.
    pub cache_write_1h: Option<f64>,
    /// Defaults to 0.1 × input.
    pub cache_read: Option<f64>,
    /// Higher rates once a prompt is longer than `above` tokens.
    pub long_context: Option<LongContext>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LongContext {
    pub above: u64,
    pub input: f64,
    pub output: f64,
}

#[derive(Debug, Default, Deserialize)]
struct File {
    #[serde(default)]
    models: BTreeMap<String, Price>,
}

#[derive(Debug, Default)]
pub struct Table {
    models: BTreeMap<String, Price>,
}

impl Table {
    pub fn parse(text: &str) -> Result<Self, String> {
        let f: File = toml::from_str(text).map_err(|e| e.to_string())?;
        Ok(Self { models: f.models })
    }

    /// Exact name first, then the longest `prefix*` entry that matches.
    pub fn find(&self, model: &str) -> Option<&Price> {
        self.models.get(model).or_else(|| {
            self.models
                .iter()
                .filter_map(|(k, p)| k.strip_suffix('*').filter(|pre| model.starts_with(pre)).map(|pre| (pre.len(), p)))
                .max_by_key(|(n, _)| *n)
                .map(|(_, p)| p)
        })
    }

    /// Cost in millionths of a dollar, or `None` if the model has no price.
    pub fn cost_micros(&self, model: &str, u: &Usage) -> Option<i64> {
        let p = self.find(model)?;
        let prompt = u.input + u.cache_write_5m + u.cache_write_1h + u.cache_read;
        // Past the long-context threshold every input-side rate scales with input.
        let (input, output, scale) = match &p.long_context {
            Some(lc) if prompt > lc.above => (lc.input, lc.output, lc.input / p.input.max(f64::MIN_POSITIVE)),
            _ => (p.input, p.output, 1.0),
        };
        let write_5m = p.cache_write.unwrap_or(p.input * 1.25) * scale;
        let write_1h = p.cache_write_1h.unwrap_or(p.input * 2.0) * scale;
        let read = p.cache_read.unwrap_or(p.input * 0.1) * scale;
        // tokens × ($ per 1M tokens) = millionths of a dollar.
        let micros = u.input as f64 * input
            + u.output as f64 * output
            + u.cache_write_5m as f64 * write_5m
            + u.cache_write_1h as f64 * write_1h
            + u.cache_read as f64 * read;
        Some(micros.round() as i64)
    }
}

/// The table plus where it came from, reloaded when the file's mtime changes.
pub struct Pricing {
    path: Option<PathBuf>,
    state: Mutex<(Option<SystemTime>, std::sync::Arc<Table>)>,
}

impl Pricing {
    /// Use `<dir>/pricing.toml`, writing the defaults there if it does not exist.
    pub fn load(dir: &Path) -> std::io::Result<Self> {
        let path = dir.join("pricing.toml");
        if !path.exists() {
            std::fs::write(&path, DEFAULT_TOML)?;
        }
        let p = Self { path: Some(path), state: Mutex::new((None, Default::default())) };
        p.table();
        Ok(p)
    }

    /// Built-in defaults only (tests).
    pub fn builtin() -> Self {
        let t = Table::parse(DEFAULT_TOML).expect("default pricing parses");
        Self { path: None, state: Mutex::new((None, std::sync::Arc::new(t))) }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn table(&self) -> std::sync::Arc<Table> {
        let mut st = self.state.lock().expect("pricing mutex poisoned");
        let Some(path) = &self.path else { return st.1.clone() };
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if mtime.is_some() && mtime != st.0 {
            match std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|t| Table::parse(&t)) {
                Ok(t) => {
                    tracing::info!(path = %path.display(), models = t.models.len(), "loaded pricing");
                    st.1 = std::sync::Arc::new(t);
                }
                // Keep the last good table; a typo should not zero everyone's costs.
                Err(e) => tracing::warn!(path = %path.display(), error = %e, "pricing.toml is invalid, keeping previous prices"),
            }
            st.0 = mtime;
        }
        st.1.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64) -> Usage {
        Usage { input, output, ..Default::default() }
    }

    #[test]
    fn defaults_parse_and_price_current_models() {
        let t = Table::parse(DEFAULT_TOML).unwrap();
        // 1M in + 1M out on Opus 5.5 = $4 + $20.
        assert_eq!(t.cost_micros("claude-opus-5-5", &usage(1_000_000, 1_000_000)), Some(24_000_000));
        assert_eq!(t.cost_micros("claude-sonnet-5-5", &usage(1_000, 500)), Some(2_000 + 5_000));
        assert!(t.cost_micros("gpt-unknown", &usage(1, 1)).is_none());
    }

    #[test]
    fn cache_rates_default_from_input() {
        let t = Table::parse("[models.m]\ninput = 10.0\noutput = 50.0\n").unwrap();
        let u = Usage { cache_write_5m: 1_000, cache_write_1h: 1_000, cache_read: 1_000, ..Default::default() };
        assert_eq!(t.cost_micros("m", &u), Some(12_500 + 20_000 + 1_000));
    }

    #[test]
    fn prefix_entries_and_longest_match() {
        let t = Table::parse("[models.\"a*\"]\ninput = 1.0\noutput = 1.0\n[models.\"ab*\"]\ninput = 2.0\noutput = 2.0\n").unwrap();
        assert_eq!(t.find("abc").unwrap().input, 2.0);
        assert_eq!(t.find("axe").unwrap().input, 1.0);
        assert!(t.find("b").is_none());
    }

    #[test]
    fn long_context_rates_apply_past_the_threshold() {
        let t = Table::parse(
            "[models.h]\ninput = 0.1\noutput = 0.5\nlong_context = { above = 100, input = 0.5, output = 2.5 }\n",
        )
        .unwrap();
        assert_eq!(t.cost_micros("h", &usage(100, 10)), Some(10 + 5));
        assert_eq!(t.cost_micros("h", &usage(101, 10)), Some(51 + 25));
        let cached = Usage { input: 2, cache_read: 200, ..Default::default() };
        // 2 × 0.5 + 200 × (0.01 × 5) = 11.
        assert_eq!(t.cost_micros("h", &cached), Some(11));
    }

    #[test]
    fn reloads_on_change_and_keeps_last_good_table() {
        let dir = tempfile::tempdir().unwrap();
        let p = Pricing::load(dir.path()).unwrap();
        assert!(p.table().find("claude-opus-5-5").is_some());
        let path = p.path().unwrap().to_path_buf();

        std::fs::write(&path, "[models.mine]\ninput = 1.0\noutput = 2.0\n").unwrap();
        bump_mtime(&path);
        assert!(p.table().find("mine").is_some());

        std::fs::write(&path, "not toml [").unwrap();
        bump_mtime(&path);
        assert!(p.table().find("mine").is_some());
    }

    fn bump_mtime(path: &Path) {
        let f = std::fs::File::options().write(true).open(path).unwrap();
        let t = f.metadata().unwrap().modified().unwrap() + std::time::Duration::from_secs(5);
        f.set_modified(t).unwrap();
    }
}
