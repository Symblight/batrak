//! Quick Open: fuzzy file search over the snapshot, fzf-style scoring via `nucleo-matcher`.

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

use super::snapshot::Snapshot;

pub const MAX_RESULTS: usize = 100;
/// How many recently opened files get a boost.
pub const RECENT_CAPACITY: usize = 20;
/// Boost of the most recent file; each older one gets `RECENT_STEP` less.
const RECENT_BOOST: u32 = 200;
const RECENT_STEP: u32 = 10;
/// A match inside the file name counts this many times on top of the full-path score.
const NAME_WEIGHT: u32 = 2;
/// How often the scoring loop checks for a newer query.
const CANCEL_CHECK_EVERY: usize = 2048;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenItem {
    pub path: String,
    pub name: String,
    /// Indices of matched characters in `path` (Unicode scalar values, not bytes), ascending.
    pub indices: Vec<u32>,
}

struct Scored<'a> {
    path: &'a str,
    name: &'a str,
    score: u32,
    name_matched: bool,
}

/// Returns `None` when `is_cancelled` turns true midway (a newer query arrived).
/// `recent` is most-recent-first.
pub fn search(
    snapshot: &Snapshot,
    recent: &[String],
    query: &str,
    is_cancelled: impl Fn() -> bool,
) -> Option<Vec<QuickOpenItem>> {
    let query = query.trim();
    if query.is_empty() {
        // No query: recently opened files that still exist.
        let items = recent
            .iter()
            .filter_map(|path| snapshot.get(path).filter(|e| !e.is_dir && !e.ignored))
            .map(|e| QuickOpenItem { path: e.path.clone(), name: e.name.clone(), indices: Vec::new() })
            .collect();
        return Some(items);
    }

    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();
    let mut scored = Vec::new();

    for (i, entry) in snapshot.files().enumerate() {
        if i % CANCEL_CHECK_EVERY == 0 && is_cancelled() {
            return None;
        }
        let Some(path_score) = pattern.score(Utf32Str::new(&entry.path, &mut buf), &mut matcher) else {
            continue;
        };
        let name_score = pattern.score(Utf32Str::new(&entry.name, &mut buf), &mut matcher);
        let recent_boost = recent
            .iter()
            .position(|p| p == &entry.path)
            .map_or(0, |pos| RECENT_BOOST.saturating_sub(pos as u32 * RECENT_STEP));
        scored.push(Scored {
            path: &entry.path,
            name: &entry.name,
            score: path_score + name_score.unwrap_or(0) * NAME_WEIGHT + recent_boost,
            name_matched: name_score.is_some(),
        });
    }

    let by_rank = |a: &Scored, b: &Scored| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
            .then_with(|| a.path.cmp(b.path))
    };
    if scored.len() > MAX_RESULTS {
        scored.select_nth_unstable_by(MAX_RESULTS, by_rank);
        scored.truncate(MAX_RESULTS);
    }
    scored.sort_unstable_by(by_rank);

    let items = scored
        .into_iter()
        .map(|s| {
            let mut indices = Vec::new();
            if s.name_matched {
                // Highlight inside the file name: that is what made it rank.
                pattern.indices(Utf32Str::new(s.name, &mut buf), &mut matcher, &mut indices);
                let offset = (s.path.chars().count() - s.name.chars().count()) as u32;
                indices.iter_mut().for_each(|i| *i += offset);
            } else {
                pattern.indices(Utf32Str::new(s.path, &mut buf), &mut matcher, &mut indices);
            }
            indices.sort_unstable();
            indices.dedup();
            QuickOpenItem { path: s.path.to_owned(), name: s.name.to_owned(), indices }
        })
        .collect();
    Some(items)
}
