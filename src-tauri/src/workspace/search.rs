//! Find in Files: ripgrep's searcher over the snapshot's file list, streamed per file.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use serde::{Deserialize, Serialize};

pub const MAX_MATCHES: usize = 2000;
pub const MAX_FILE_SIZE: u64 = 1024 * 1024;
/// Longer lines are cut to a window around the first match.
const MAX_LINE_BYTES: usize = 500;
const CONTEXT_BEFORE_MATCH: usize = 80;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    /// Comma-separated globs, relative to the root. Empty = everything.
    pub include: String,
    pub exclude: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based.
    pub line: u64,
    pub text: String,
    /// `[start, end)` in UTF-16 code units of `text`, ready for JS string slicing.
    pub ranges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SearchEvent {
    File { path: String, matches: Vec<LineMatch> },
    Done { total: usize, limit_hit: bool, cancelled: bool },
    Error { message: String },
}

/// Searches `files` (relative paths with sizes) and calls `emit` from worker threads
/// once per file with matches, then once with `Done`. Blocking; call from a background thread.
pub fn run(
    root: &Path,
    files: Vec<(String, u64)>,
    options: &SearchOptions,
    cancel: &AtomicBool,
    emit: &(dyn Fn(SearchEvent) + Sync),
) {
    let matcher = match build_matcher(options) {
        Ok(m) => m,
        Err(message) => return emit(SearchEvent::Error { message }),
    };
    let (include, exclude) = match (globs(&options.include), globs(&options.exclude)) {
        (Ok(i), Ok(e)) => (i, e),
        (Err(message), _) | (_, Err(message)) => return emit(SearchEvent::Error { message }),
    };
    let files: Vec<String> = files
        .into_iter()
        .filter(|(path, size)| {
            *size <= MAX_FILE_SIZE
                && include.as_ref().is_none_or(|g| g.is_match(path))
                && !exclude.as_ref().is_some_and(|g| g.is_match(path))
        })
        .map(|(path, _)| path)
        .collect();

    let next = AtomicUsize::new(0);
    let total = AtomicUsize::new(0);
    let limit_hit = AtomicBool::new(false);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());

    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(0))
                    .line_number(true)
                    .build();
                loop {
                    if cancel.load(Ordering::Relaxed) || limit_hit.load(Ordering::Relaxed) {
                        break;
                    }
                    let Some(path) = files.get(next.fetch_add(1, Ordering::Relaxed)) else {
                        break;
                    };
                    let mut sink = FileSink {
                        matcher: &matcher,
                        matches: Vec::new(),
                        cancel,
                        total: &total,
                        limit_hit: &limit_hit,
                    };
                    // Unreadable files are skipped, like ripgrep does.
                    let _ = searcher.search_path(&matcher, root.join(path), &mut sink);
                    if !sink.matches.is_empty() && !cancel.load(Ordering::Relaxed) {
                        emit(SearchEvent::File { path: path.clone(), matches: sink.matches });
                    }
                }
            });
        }
    });

    emit(SearchEvent::Done {
        total: total.load(Ordering::Relaxed).min(MAX_MATCHES),
        limit_hit: limit_hit.load(Ordering::Relaxed),
        cancelled: cancel.load(Ordering::Relaxed),
    });
}

fn build_matcher(options: &SearchOptions) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .fixed_strings(!options.regex)
        .line_terminator(Some(b'\n'))
        .build(&options.query)
        .map_err(|e| e.to_string())
}

/// `"src, *.test.js"` → a set where each glob also matches everything under it (`src/**`).
fn globs(list: &str) -> Result<Option<GlobSet>, String> {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for glob in list.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        let glob = glob.trim_start_matches("./").trim_end_matches('/');
        builder.add(Glob::new(glob).map_err(|e| e.to_string())?);
        builder.add(Glob::new(&format!("{glob}/**")).map_err(|e| e.to_string())?);
        any = true;
    }
    if !any {
        return Ok(None);
    }
    builder.build().map(Some).map_err(|e| e.to_string())
}

struct FileSink<'a> {
    matcher: &'a RegexMatcher,
    matches: Vec<LineMatch>,
    cancel: &'a AtomicBool,
    total: &'a AtomicUsize,
    limit_hit: &'a AtomicBool,
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let mut line = mat.bytes();
        while let [rest @ .., b'\n' | b'\r'] = line {
            line = rest;
        }
        let mut ranges = Vec::new();
        let _ = self.matcher.find_iter(line, |m| {
            if m.start() < m.end() {
                ranges.push((m.start(), m.end()));
            }
            true
        });
        if ranges.is_empty() {
            return Ok(true);
        }

        let before = self.total.fetch_add(ranges.len(), Ordering::Relaxed);
        if before >= MAX_MATCHES {
            self.limit_hit.store(true, Ordering::Relaxed);
            return Ok(false);
        }
        let room = MAX_MATCHES - before;
        let full = ranges.len() >= room;
        ranges.truncate(room);
        if full {
            self.limit_hit.store(true, Ordering::Relaxed);
        }

        self.matches.push(to_line_match(mat.line_number().unwrap_or(0), line, &ranges));
        Ok(!full)
    }
}

/// Decodes the line and converts byte ranges to UTF-16 ranges, cutting very long lines
/// to a window that starts a little before the first match.
fn to_line_match(line_number: u64, line: &[u8], ranges: &[(usize, usize)]) -> LineMatch {
    let text = String::from_utf8_lossy(line);
    let (mut start, mut end) = (0, text.len());
    if text.len() > MAX_LINE_BYTES {
        start = ranges[0].0.saturating_sub(CONTEXT_BEFORE_MATCH).min(text.len());
        while !text.is_char_boundary(start) {
            start -= 1;
        }
        end = (start + MAX_LINE_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
    }
    let window = &text[start..end];
    let utf16 = |byte: usize| -> Option<u32> {
        let rel = byte.checked_sub(start)?.min(window.len());
        window.is_char_boundary(rel).then(|| window[..rel].encode_utf16().count() as u32)
    };
    let ranges = ranges
        .iter()
        .filter(|(s, _)| *s >= start && *s < end)
        .filter_map(|&(s, e)| Some([utf16(s)?, utf16(e)?]))
        .collect();
    LineMatch { line: line_number, text: window.to_owned(), ranges }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_ranges_and_long_lines() {
        let m = to_line_match(3, "let ё = foo;".as_bytes(), &[(9, 12)]);
        assert_eq!(&m.text, "let ё = foo;");
        assert_eq!(m.ranges, vec![[8, 11]]);

        let long = format!("{}needle", "x".repeat(1000));
        let m = to_line_match(1, long.as_bytes(), &[(1000, 1006)]);
        assert_eq!(&m.text[m.ranges[0][0] as usize..m.ranges[0][1] as usize], "needle");
    }

    #[test]
    fn globs_match_dirs_and_patterns() {
        let set = globs("src, *.md").unwrap().unwrap();
        assert!(set.is_match("src/a/b.js"));
        assert!(set.is_match("docs/readme.md"));
        assert!(!set.is_match("lib/a.js"));
        assert!(globs("  ").unwrap().is_none());
    }
}
