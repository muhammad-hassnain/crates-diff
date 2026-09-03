//! Whole-crate diffing: per-file change list, unified per-file diffs, and
//! full-text content search across a version transition. No trait/snippet
//! extraction — every file of the crate is compared in full.

use std::collections::BTreeMap;

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

use crate::store::Ctx;

#[derive(Serialize)]
pub struct FileEntry {
    pub path: String,
    /// "added" | "removed" | "modified" | "unchanged"
    pub status: &'static str,
    pub added: usize,
    pub removed: usize,
}

#[derive(Serialize)]
pub struct FileList {
    pub from: String,
    pub to: String,
    pub files: Vec<FileEntry>,
    pub changed: usize,
    pub total: usize,
}

#[derive(Serialize)]
pub struct DiffLine {
    /// "eq" | "add" | "del"
    pub tag: &'static str,
    pub old: Option<usize>,
    pub new: Option<usize>,
    pub text: String,
}

#[derive(Serialize)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize)]
pub struct FileDiff {
    pub path: String,
    pub status: &'static str,
    pub hunks: Vec<Hunk>,
}

#[derive(Serialize)]
pub struct SearchLine {
    pub line: usize,
    pub text: String,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    /// which version the matched content came from
    pub side: &'static str,
    pub count: usize,
    pub lines: Vec<SearchLine>,
}

fn status_of(a: Option<&String>, b: Option<&String>) -> &'static str {
    match (a, b) {
        (None, Some(_)) => "added",
        (Some(_), None) => "removed",
        (Some(x), Some(y)) if x == y => "unchanged",
        _ => "modified",
    }
}

fn count_changes(a: &str, b: &str) -> (usize, usize) {
    let diff = TextDiff::from_lines(a, b);
    let (mut added, mut removed) = (0, 0);
    for ch in diff.iter_all_changes() {
        match ch.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

/// Union of both versions' files with per-file status and line counts.
/// Changed files sort first (by descending churn), then unchanged alphabetically.
pub fn file_list(ctx: &Ctx, name: &str, from: &str, to: &str) -> Option<FileList> {
    let a = ctx.version_files(name, from)?;
    let b = ctx.version_files(name, to)?;
    let mut files = Vec::new();
    let mut changed = 0;
    let paths: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    for path in paths {
        let ta = a.get(path);
        let tb = b.get(path);
        let status = status_of(ta, tb);
        let (added, removed) = if status == "unchanged" {
            (0, 0)
        } else {
            count_changes(ta.map(String::as_str).unwrap_or(""), tb.map(String::as_str).unwrap_or(""))
        };
        if status != "unchanged" {
            changed += 1;
        }
        files.push(FileEntry {
            path: path.clone(),
            status,
            added,
            removed,
        });
    }
    let total = files.len();
    files.sort_by(|x, y| {
        let xc = x.status != "unchanged";
        let yc = y.status != "unchanged";
        yc.cmp(&xc)
            .then((y.added + y.removed).cmp(&(x.added + x.removed)))
            .then(x.path.cmp(&y.path))
    });
    Some(FileList {
        from: from.to_string(),
        to: to.to_string(),
        files,
        changed,
        total,
    })
}

/// Unified diff of a single file. An unchanged file renders as all-context lines
/// so the whole crate can be browsed, not just what changed.
pub fn file_diff(ctx: &Ctx, name: &str, from: &str, to: &str, path: &str) -> Option<FileDiff> {
    let a = ctx.version_files(name, from)?;
    let b = ctx.version_files(name, to)?;
    if !a.contains_key(path) && !b.contains_key(path) {
        return None;
    }
    let ta = a.get(path).cloned().unwrap_or_default();
    let tb = b.get(path).cloned().unwrap_or_default();
    let status = status_of(a.get(path), b.get(path));

    if ta == tb {
        // Unchanged: show the file as-is (one hunk of context lines).
        let mut lines = Vec::new();
        for (i, l) in ta.lines().enumerate() {
            lines.push(DiffLine {
                tag: "eq",
                old: Some(i + 1),
                new: Some(i + 1),
                text: l.to_string(),
            });
        }
        let n = lines.len();
        let hunks = if n == 0 {
            Vec::new()
        } else {
            vec![Hunk {
                header: format!("@@ -1,{n} +1,{n} @@"),
                lines,
            }]
        };
        return Some(FileDiff {
            path: path.to_string(),
            status,
            hunks,
        });
    }

    let diff = TextDiff::from_lines(&ta, &tb);
    let mut hunks = Vec::new();
    for group in diff.grouped_ops(3) {
        let mut lines = Vec::new();
        let (mut old_start, mut new_start) = (usize::MAX, usize::MAX);
        let (mut old_len, mut new_len) = (0usize, 0usize);
        for op in &group {
            for ch in diff.iter_changes(op) {
                let old = ch.old_index().map(|i| i + 1);
                let new = ch.new_index().map(|i| i + 1);
                if let Some(o) = old {
                    old_start = old_start.min(o);
                    old_len += 1;
                }
                if let Some(n) = new {
                    new_start = new_start.min(n);
                    new_len += 1;
                }
                let tag = match ch.tag() {
                    ChangeTag::Equal => "eq",
                    ChangeTag::Insert => "add",
                    ChangeTag::Delete => "del",
                };
                lines.push(DiffLine {
                    tag,
                    old,
                    new,
                    text: ch.value().trim_end_matches('\n').to_string(),
                });
            }
        }
        if old_start == usize::MAX {
            old_start = 0;
        }
        if new_start == usize::MAX {
            new_start = 0;
        }
        hunks.push(Hunk {
            header: format!("@@ -{old_start},{old_len} +{new_start},{new_len} @@"),
            lines,
        });
    }
    Some(FileDiff {
        path: path.to_string(),
        status,
        hunks,
    })
}

/// Case-insensitive substring search across the transition. Searches the `to`
/// version of each file, falling back to `from` for files deleted in `to`, so
/// results reflect the code as it stands after the change.
pub fn content_search(
    ctx: &Ctx,
    name: &str,
    from: &str,
    to: &str,
    query: &str,
) -> Option<Vec<SearchHit>> {
    let q = query.trim();
    if q.is_empty() {
        return Some(Vec::new());
    }
    let a = ctx.version_files(name, from)?;
    let b = ctx.version_files(name, to)?;
    let ql = q.to_lowercase();

    let mut hits = Vec::new();
    let paths: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    for path in paths {
        let (text, side): (&String, &'static str) = match b.get(path) {
            Some(t) => (t, "to"),
            None => match a.get(path) {
                Some(t) => (t, "from"),
                None => continue,
            },
        };
        let mut lines = Vec::new();
        for (i, l) in text.lines().enumerate() {
            if l.to_lowercase().contains(&ql) {
                lines.push(SearchLine {
                    line: i + 1,
                    text: l.trim_end().to_string(),
                });
                if lines.len() >= 12 {
                    break;
                }
            }
        }
        if !lines.is_empty() {
            hits.push(SearchHit {
                path: path.clone(),
                side,
                count: lines.len(),
                lines,
            });
        }
    }
    hits.sort_by(|x, y| y.count.cmp(&x.count).then(x.path.cmp(&y.path)));
    Some(hits)
}

/// Small helper so the server can hand notes/other code a stable version map
/// without importing store internals. (Currently unused outside; kept for reuse.)
#[allow(dead_code)]
pub fn both_versions(
    ctx: &Ctx,
    name: &str,
    from: &str,
    to: &str,
) -> Option<(BTreeMap<String, String>, BTreeMap<String, String>)> {
    Some((ctx.version_files(name, from)?, ctx.version_files(name, to)?))
}
