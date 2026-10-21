//! The Agents tab's data (`agents_view`), built here so the page only renders it: installed
//! agents and the registry's, matched against the search, ranked, filtered, counted, with the
//! name's matches as UTF-16 ranges for `<mark>`.

use serde::{Deserialize, Serialize};

use super::registry::{AgentUpdate, Distribution, RegistryAgent, RegistryState};
use super::{AgentList, AgentSummary, Scope};

/// The filter chip picked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Filter {
    #[default]
    All,
    /// Installed agents with an update.
    Updates,
    /// Installed agents turned off.
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// It answered `initialize` once.
    Ready,
    NotStarted,
    Off,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    pub id: String,
    pub name: String,
    pub scope: Scope,
    pub enabled: bool,
    pub is_default: bool,
    pub command: String,
    pub args: Vec<String>,
    pub version: Option<String>,
    pub update: Option<AgentUpdate>,
    pub updating: bool,
    pub status: Status,
    /// `[start, end)` in UTF-16 code units of `name`.
    pub name_matches: Vec<[usize; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRow {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub description: String,
    /// What Add writes (`npx -y <package>@<version> …`); `None` for a binary agent.
    pub command_line: Option<String>,
    /// Binary agents can't be added yet.
    pub addable: bool,
    pub name_matches: Vec<[usize; 2]>,
}

/// Installed agents per filter chip; the search doesn't change them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub all: usize,
    pub updates: usize,
    pub off: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsView {
    pub installed: Vec<AgentRow>,
    /// With a project: the user's own agents it lacks (All only).
    pub user_agents: Vec<AgentRow>,
    /// Registry agents not installed (All only).
    pub registry: Vec<RegistryRow>,
    pub counts: Counts,
    pub default_agent: Option<String>,
    pub errors: Vec<String>,
    pub registry_state: RegistryState,
}

/// What the page asked for and what the backend knows besides the list.
pub struct Inputs<'a> {
    pub list: AgentList,
    pub registry: &'a [RegistryAgent],
    pub registry_state: RegistryState,
    /// Whether the agent answered `initialize` once.
    pub reported: &'a dyn Fn(&str) -> bool,
    pub updating: &'a dyn Fn(&str) -> bool,
    pub query: &'a str,
    pub filter: Filter,
}

pub fn build(inputs: Inputs<'_>) -> AgentsView {
    let Inputs { list, registry: entries, registry_state, reported, updating, query, filter } = inputs;
    let query = Query::new(query);
    let counts = Counts {
        all: list.agents.len(),
        updates: list.agents.iter().filter(|a| a.update.is_some()).count(),
        off: list.agents.iter().filter(|a| !a.enabled).count(),
    };
    let default_agent = list.default_agent.clone();
    let entry_of = |a: &AgentSummary| a.registry_id.as_ref().and_then(|id| entries.iter().find(|e| &e.id == id));
    let row = |a: AgentSummary| -> Option<(u8, AgentRow)> {
        let entry = entry_of(&a);
        let command_line = std::iter::once(a.command.as_str()).chain(a.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
        let (vendor, description) = entry.map_or(("", ""), |e| (e.vendor.as_str(), e.description.as_str()));
        let rank = query.rank(&a.name, &[&a.id, vendor, description, &command_line])?;
        let status = if !a.enabled {
            Status::Off
        } else if reported(&a.id) {
            Status::Ready
        } else {
            Status::NotStarted
        };
        let row = AgentRow {
            is_default: default_agent.as_deref() == Some(a.id.as_str()),
            updating: updating(&a.id),
            name_matches: query.highlights(&a.name),
            status,
            id: a.id,
            name: a.name,
            scope: a.scope,
            enabled: a.enabled,
            command: a.command,
            args: a.args,
            version: a.version,
            update: a.update,
        };
        Some((rank, row))
    };
    let keep = |a: &AgentSummary| match filter {
        Filter::All => true,
        Filter::Updates => a.update.is_some(),
        Filter::Off => !a.enabled,
    };
    let installed_entries: Vec<&str> = list.agents.iter().filter_map(|a| a.registry_id.as_deref()).collect();
    let installed = query.sort(list.agents.iter().filter(|a| keep(a)).cloned().filter_map(row).collect(), |r| (!r.is_default, &r.name));
    let (user_agents, registry) = if filter == Filter::All {
        let user = query.sort(list.user_agents.into_iter().filter_map(row).collect(), |r| (false, &r.name));
        let registry = entries
            .iter()
            .filter(|e| !installed_entries.contains(&e.id.as_str()))
            .filter_map(|e| {
                let launch = e.npx_launch();
                let command_line = launch.as_ref().map(|k| std::iter::once(k.command.as_str()).chain(k.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" "));
                let rank = query.rank(&e.name, &[&e.id, &e.vendor, &e.description, command_line.as_deref().unwrap_or("")])?;
                let row = RegistryRow {
                    id: e.id.clone(),
                    name: e.name.clone(),
                    vendor: e.vendor.clone(),
                    description: e.description.clone(),
                    addable: matches!(e.distribution, Distribution::Npx { .. }),
                    command_line,
                    name_matches: query.highlights(&e.name),
                };
                Some((rank, row))
            })
            .collect();
        (user, query.sort(registry, |r| (false, &r.name)))
    } else {
        (Vec::new(), Vec::new())
    };
    AgentsView { installed, user_agents, registry, counts, default_agent, errors: list.errors, registry_state }
}

/// A search: its terms, folded (lowercase, no accents).
struct Query {
    whole: String,
    terms: Vec<String>,
}

impl Query {
    fn new(text: &str) -> Query {
        let whole = fold(text.trim()).text;
        let terms = whole.split_whitespace().map(str::to_owned).collect();
        Query { whole, terms }
    }

    /// `None` when a term matches none of the fields; else the rank (lower first): the name starts
    /// with the query, a word of it does, it contains it, another field matches. All rows are rank
    /// 0 without a query.
    fn rank(&self, name: &str, others: &[&str]) -> Option<u8> {
        if self.terms.is_empty() {
            return Some(0);
        }
        let name = fold(name).text;
        let others: Vec<String> = others.iter().map(|f| fold(f).text).collect();
        let all_match = self.terms.iter().all(|t| name.contains(t.as_str()) || others.iter().any(|f| f.contains(t.as_str())));
        if !all_match {
            return None;
        }
        Some(if name.starts_with(&self.whole) {
            0
        } else if name.split(|c: char| !c.is_alphanumeric()).any(|w| w.starts_with(&self.whole)) {
            1
        } else if name.contains(&self.whole) {
            2
        } else {
            3
        })
    }

    /// Where the terms occur in `name` (first occurrence each), merged, in UTF-16 offsets.
    fn highlights(&self, name: &str) -> Vec<[usize; 2]> {
        let folded = fold(name);
        let mut ranges: Vec<[usize; 2]> = self
            .terms
            .iter()
            .filter_map(|t| {
                let start = folded.text.find(t.as_str())?;
                let end = start + t.len();
                Some([folded.origin_start(start), folded.origin_end(end)])
            })
            .collect();
        ranges.sort_unstable();
        let mut merged: Vec<[usize; 2]> = Vec::new();
        for range in ranges {
            match merged.last_mut() {
                Some(last) if range[0] <= last[1] => last[1] = last[1].max(range[1]),
                _ => merged.push(range),
            }
        }
        merged
    }

    /// Rows by rank, then `key` (`(not default, name)`), case-insensitively.
    fn sort<T>(&self, mut rows: Vec<(u8, T)>, key: impl Fn(&T) -> (bool, &String)) -> Vec<T> {
        rows.sort_by_cached_key(|(rank, row)| {
            let (late, name) = key(row);
            // With a query the default isn't put first: the best match is.
            (*rank, self.terms.is_empty() && late, fold(name).text)
        });
        rows.into_iter().map(|(_, row)| row).collect()
    }
}

/// Text folded for matching, with where each of its bytes came from in the original.
struct Folded {
    text: String,
    /// Per byte of `text`: the UTF-16 range of the original char it came from.
    origin: Vec<[usize; 2]>,
}

impl Folded {
    fn origin_start(&self, byte: usize) -> usize {
        self.origin.get(byte).map_or(0, |r| r[0])
    }

    fn origin_end(&self, byte: usize) -> usize {
        byte.checked_sub(1).and_then(|b| self.origin.get(b)).map_or(0, |r| r[1])
    }
}

/// Lowercase without accents: each char decomposed (NFD), combining marks dropped.
fn fold(text: &str) -> Folded {
    let nfd = icu_normalizer::DecomposingNormalizerBorrowed::new_nfd();
    let mut folded = Folded { text: String::new(), origin: Vec::new() };
    let mut at = 0;
    let mut buf = [0u8; 4];
    for c in text.chars() {
        let range = [at, at + c.len_utf16()];
        at = range[1];
        for d in nfd.normalize(c.encode_utf8(&mut buf)).chars().filter(|d| !is_combining(*d)).flat_map(char::to_lowercase) {
            folded.text.push(d);
            folded.origin.extend(std::iter::repeat_n(range, d.len_utf8()));
        }
    }
    folded
}

fn is_combining(c: char) -> bool {
    matches!(c, '\u{0300}'..='\u{036F}' | '\u{1AB0}'..='\u{1AFF}' | '\u{1DC0}'..='\u{1DFF}' | '\u{20D0}'..='\u{20FF}' | '\u{FE20}'..='\u{FE2F}')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::registry;

    fn agent(id: &str, name: &str, command: &str, args: &[&str]) -> AgentSummary {
        AgentSummary {
            id: id.into(),
            name: name.into(),
            scope: Scope::User,
            version: None,
            registry_id: None,
            update: None,
            enabled: true,
            command: command.into(),
            args: args.iter().map(|&a| a.into()).collect(),
        }
    }

    fn list() -> AgentList {
        let mut claude = agent("claude", "Claude Code", "npx", &["-y", "@agentclientprotocol/claude-agent-acp@0.90.0"]);
        claude.registry_id = Some("claude-acp".into());
        claude.update = Some(AgentUpdate { to: "0.94.0".into(), pin: false });
        let mut codex = agent("codex", "Codex", "codex-acp", &[]);
        codex.enabled = false;
        AgentList {
            agents: vec![
                claude,
                codex,
                agent("zed", "Zébulon Agent", "zbl", &["--acp"]),
                agent("repo", "Repo", "./run", &["--model", "claude-opus"]),
            ],
            default_agent: Some("repo".into()),
            known: Vec::new(),
            user_agents: vec![agent("mine", "Mine", "mine", &[])],
            errors: vec!["agents.json:3:4: oops".into()],
        }
    }

    fn view(query: &str, filter: Filter) -> AgentsView {
        let entries = registry::parse(registry::tests::FIXTURE).unwrap();
        build(Inputs {
            list: list(),
            registry: &entries,
            registry_state: RegistryState { checked_at: None, offline: true, checking: false },
            reported: &|id| id == "repo",
            updating: &|id| id == "claude",
            query,
            filter,
        })
    }

    fn names(view: &AgentsView) -> (Vec<&str>, Vec<&str>) {
        (view.installed.iter().map(|r| r.name.as_str()).collect(), view.registry.iter().map(|r| r.name.as_str()).collect())
    }

    #[test]
    fn without_a_query_the_default_leads_then_names() {
        let all = view("", Filter::All);
        assert_eq!(names(&all), (vec!["Repo", "Claude Code", "Codex", "Zébulon Agent"], vec!["Gemini CLI", "goose"]), "Claude's entry is installed");
        assert_eq!(all.counts, Counts { all: 4, updates: 1, off: 1 });
        let repo = &all.installed[0];
        assert!(repo.is_default && repo.status == Status::Ready);
        let claude = &all.installed[1];
        assert!(claude.updating && claude.status == Status::NotStarted && claude.update.is_some());
        assert_eq!(all.installed[2].status, Status::Off);
        assert_eq!(all.user_agents.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["mine"]);
        assert_eq!(all.errors, ["agents.json:3:4: oops"]);
        assert!(all.registry_state.offline);

        let gemini = &all.registry[0];
        assert_eq!(gemini.command_line.as_deref(), Some("npx -y @google/gemini-cli@0.65.0 --acp"));
        assert!(gemini.addable);
        assert!(!all.registry[1].addable && all.registry[1].command_line.is_none(), "binary");
    }

    #[test]
    fn filters_narrow_the_installed_agents_and_counts_ignore_the_query() {
        let table = [
            (Filter::Updates, "", vec!["Claude Code"]),
            (Filter::Off, "", vec!["Codex"]),
            (Filter::Off, "claude", vec![]),
        ];
        for (filter, query, expected) in table {
            let v = view(query, filter);
            assert_eq!(names(&v).0, expected, "{filter:?} {query:?}");
            assert!(v.registry.is_empty() && v.user_agents.is_empty(), "All only");
            assert_eq!(v.counts, Counts { all: 4, updates: 1, off: 1 }, "{filter:?} {query:?}");
        }
    }

    #[test]
    fn every_term_matches_some_field_and_ranks_by_the_name() {
        let table: [(&str, Vec<&str>, Vec<&str>); 9] = [
            ("cl", vec!["Claude Code", "Repo"], vec!["Gemini CLI"]),
            // Name starts with it, a word starts with it, the command line has it.
            ("co", vec!["Codex", "Claude Code"], vec![]),
            ("claude", vec!["Claude Code", "Repo"], vec![]),
            ("ZEBU", vec!["Zébulon Agent"], vec![]),
            ("zébu", vec!["Zébulon Agent"], vec![]),
            ("agent zeb", vec!["Zébulon Agent"], vec![]),
            ("google", vec![], vec!["Gemini CLI"]),
            ("  block ", vec![], vec!["goose"]),
            ("claude nothing", vec![], vec![]),
        ];
        for (query, installed, registry) in table {
            let v = view(query, Filter::All);
            assert_eq!(names(&v), (installed, registry), "{query:?}");
        }
        assert_eq!(names(&view("industries", Filter::All)).0, ["Claude Code"], "the vendor of its registry entry");
    }

    #[test]
    fn name_matches_are_utf16_ranges_of_the_name() {
        let v = view("bulon zé", Filter::All);
        assert_eq!(v.installed[0].name_matches, [[0, 7]], "two terms, merged");
        let v = view("agent", Filter::All);
        let zed = v.installed.iter().find(|r| r.id == "zed").unwrap();
        assert_eq!(zed.name_matches, [[8, 13]]);
        let emoji = Query::new("x");
        assert_eq!(emoji.highlights("🤖 x"), [[3, 4]], "an emoji is two UTF-16 units");
        let decomposed = Query::new("e");
        assert_eq!(decomposed.highlights("Ze\u{301}"), [[1, 2]], "a combining mark isn't matched");
        assert!(view("", Filter::All).installed.iter().all(|r| r.name_matches.is_empty()));
    }
}
