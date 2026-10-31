//! Quick Open: fuzzy file (and, for `@` mentions, folder) search over the snapshot, fzf-style scoring via `nucleo-matcher`.

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

use super::snapshot::{Entry, Snapshot};

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

/// What Quick Open lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuickOpenKind {
    #[default]
    Files,
    /// Files and folders (`@` mentions).
    All,
    Dirs,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// Indices of matched characters in `path` (Unicode scalar values, not bytes), ascending.
    pub indices: Vec<u32>,
}

struct Scored<'a> {
    path: &'a str,
    name: &'a str,
    is_dir: bool,
    score: u32,
    name_matched: bool,
}

/// Returns `None` when `is_cancelled` turns true midway (a newer query arrived).
/// `recent` is most-recent-first.
pub fn search(
    snapshot: &Snapshot,
    recent: &[String],
    query: &str,
    kind: QuickOpenKind,
    is_cancelled: impl Fn() -> bool,
) -> Option<Vec<QuickOpenItem>> {
    let query = query.trim();
    if query.is_empty() {
        // No query: recently opened files that still exist (not for `Dirs`), then (with folders)
        // the shallowest folders.
        let mut items: Vec<QuickOpenItem> = if kind == QuickOpenKind::Dirs {
            Vec::new()
        } else {
            recent
                .iter()
                .filter_map(|path| snapshot.get(path).filter(|e| !e.is_dir && !e.ignored))
                .map(|e| QuickOpenItem { path: e.path.clone(), name: e.name.clone(), is_dir: false, indices: Vec::new() })
                .collect()
        };
        if kind != QuickOpenKind::Files {
            let mut folders: Vec<&Entry> = snapshot.files_and_dirs().filter(|e| e.is_dir).collect();
            let by_depth = |a: &&Entry, b: &&Entry| {
                let depth = |e: &Entry| e.path.matches('/').count();
                depth(a).cmp(&depth(b)).then_with(|| a.path.cmp(&b.path))
            };
            let room = MAX_RESULTS.saturating_sub(items.len());
            if folders.len() > room && room > 0 {
                folders.select_nth_unstable_by(room, by_depth);
            }
            folders.truncate(room);
            folders.sort_unstable_by(by_depth);
            items.extend(folders.into_iter().map(|e| QuickOpenItem {
                path: e.path.clone(),
                name: e.name.clone(),
                is_dir: true,
                indices: Vec::new(),
            }));
        }
        return Some(items);
    }

    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();
    let mut scored = Vec::new();

    let candidates: Box<dyn Iterator<Item = &Entry>> = match kind {
        QuickOpenKind::Files => Box::new(snapshot.files()),
        QuickOpenKind::All => Box::new(snapshot.files_and_dirs()),
        QuickOpenKind::Dirs => Box::new(snapshot.files_and_dirs().filter(|e| e.is_dir)),
    };
    for (i, entry) in candidates.enumerate() {
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
            is_dir: entry.is_dir,
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
            QuickOpenItem { path: s.path.to_owned(), name: s.name.to_owned(), is_dir: s.is_dir, indices }
        })
        .collect();
    Some(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(name: &str) -> (std::path::PathBuf, Snapshot) {
        let dir = std::env::temp_dir().join(format!("brama-quick-open-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/components/deep")).unwrap();
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "").unwrap();
        std::fs::write(dir.join("src/components/button.js"), "").unwrap();
        std::fs::write(dir.join("docs/components.md"), "").unwrap();
        let snapshot = Snapshot::scan(&dir);
        (dir, snapshot)
    }

    fn paths(items: &[QuickOpenItem]) -> Vec<&str> {
        items.iter().map(|i| i.path.as_str()).collect()
    }

    #[test]
    fn files_and_all_kinds() {
        let (dir, snap) = snapshot("kinds");
        let files = search(&snap, &[], "comp", QuickOpenKind::Files, || false).unwrap();
        assert!(files.iter().all(|i| !i.is_dir) && !files.is_empty());
        let all = search(&snap, &[], "comp", QuickOpenKind::All, || false).unwrap();
        assert!(all.iter().any(|i| i.is_dir) && all.iter().any(|i| !i.is_dir));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn dirs_lists_only_folders() {
        let (dir, snap) = snapshot("dirs");
        let recent = vec!["src/main.rs".to_owned()];

        let empty = search(&snap, &recent, "", QuickOpenKind::Dirs, || false).unwrap();
        assert!(empty.iter().all(|i| i.is_dir), "no recent files: {:?}", paths(&empty));
        assert_eq!(paths(&empty), vec!["docs", "src", "src/components", "src/components/deep"], "shallowest first");

        let found = search(&snap, &recent, "comp", QuickOpenKind::Dirs, || false).unwrap();
        assert!(found.iter().all(|i| i.is_dir), "{:?}", paths(&found));
        assert!(paths(&found).contains(&"src/components"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn kind_deserializes_lowercase() {
        let kind: QuickOpenKind = serde_json::from_str("\"dirs\"").unwrap();
        assert_eq!(kind, QuickOpenKind::Dirs);
        assert_eq!(QuickOpenKind::default(), QuickOpenKind::Files);
    }
}
