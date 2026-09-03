//! GitHub commit history between two crate versions, via the compare API.

use serde::Serialize;
use serde_json::Value;

use crate::crates_io;
use crate::store::Ctx;
use crate::util;

const GH: &str = "https://api.github.com";

#[derive(Serialize)]
pub struct CommitFile {
    pub filename: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize)]
pub struct Commit {
    pub short: String,
    pub summary: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct GithubOut {
    pub available: bool,
    pub message: Option<String>,
    pub repo_url: Option<String>,
    pub compare_url: Option<String>,
    pub from_tag: Option<String>,
    pub to_tag: Option<String>,
    pub intermediate_versions: Vec<String>,
    pub commits: Vec<Commit>,
    pub files: Vec<CommitFile>,
}

impl GithubOut {
    fn unavailable(msg: &str) -> Self {
        GithubOut {
            available: false,
            message: Some(msg.to_string()),
            repo_url: None,
            compare_url: None,
            from_tag: None,
            to_tag: None,
            intermediate_versions: Vec::new(),
            commits: Vec::new(),
            files: Vec::new(),
        }
    }
}

/// Extract a trailing semver from a tag name (v1.2.3, crate-1.2.3, 1.2.3).
fn norm_tag(tag: &str) -> Option<String> {
    let t = tag.trim();
    let bytes = t.as_bytes();
    // find the last run that looks like d+.d+.d+ ...
    let mut best: Option<String> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_digit()
                    || matches!(bytes[i], b'.' | b'-' | b'+')
                    || bytes[i].is_ascii_alphabetic())
            {
                i += 1;
            }
            let cand = &t[start..i];
            if cand.split('.').count() >= 3 && cand.chars().next().unwrap().is_ascii_digit() {
                best = Some(cand.to_string());
            }
        } else {
            i += 1;
        }
    }
    best
}

/// {version -> tag_name} for every tag in the repo.
fn version_tags(agent: &ureq::Agent, owner: &str, repo: &str, token: Option<&str>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut page = 1;
    loop {
        let url = format!("{GH}/repos/{owner}/{repo}/tags?per_page=100&page={page}");
        let Ok((code, body)) = util::github_get(agent, &url, token) else {
            break;
        };
        if code != 200 {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(&body) else {
            break;
        };
        let Some(arr) = v.as_array() else { break };
        let n = arr.len();
        for t in arr {
            if let Some(name) = t.get("name").and_then(|x| x.as_str()) {
                if let Some(ver) = norm_tag(name) {
                    if seen.insert(ver.clone()) {
                        out.push((ver, name.to_string()));
                    }
                }
            }
        }
        if n < 100 {
            break;
        }
        page += 1;
        if page > 20 {
            break; // safety cap on huge tag lists
        }
    }
    out
}

pub fn history(ctx: &Ctx, name: &str, from: &str, to: &str) -> GithubOut {
    let Some((owner, repo)) = crates_io::github_repo(&ctx.agent, name) else {
        return GithubOut::unavailable("No GitHub repository is declared for this crate on crates.io.");
    };
    let repo_url = format!("https://github.com/{owner}/{repo}");
    let token = ctx.github_token.as_deref();

    let tags = version_tags(&ctx.agent, &owner, &repo, token);
    let find = |ver: &str| tags.iter().find(|(v, _)| v == ver).map(|(_, t)| t.clone());
    let from_tag = find(from);
    let to_tag = find(to);

    // Intermediate published versions strictly between from and to.
    let intermediate = intermediate_versions(ctx, name, from, to);

    let (Some(bt), Some(ht)) = (from_tag.clone(), to_tag.clone()) else {
        let mut out = GithubOut::unavailable(
            "Couldn't match both versions to git tags in this repo (some crates don't tag every release).",
        );
        out.repo_url = Some(repo_url);
        out.from_tag = from_tag;
        out.to_tag = to_tag;
        out.intermediate_versions = intermediate;
        return out;
    };

    let url = format!("{GH}/repos/{owner}/{repo}/compare/{bt}...{ht}");
    let (code, body) = match util::github_get(&ctx.agent, &url, token) {
        Ok(x) => x,
        Err(e) => {
            let mut out = GithubOut::unavailable(&format!("GitHub compare failed: {e}"));
            out.repo_url = Some(repo_url);
            return out;
        }
    };
    if code != 200 {
        let mut out = GithubOut::unavailable(&format!(
            "GitHub compare returned HTTP {code}{}.",
            if code == 403 { " (rate limited — add a token in .github_token)" } else { "" }
        ));
        out.repo_url = Some(repo_url);
        out.from_tag = Some(bt);
        out.to_tag = Some(ht);
        out.intermediate_versions = intermediate;
        return out;
    }

    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let mut commits = Vec::new();
    if let Some(arr) = v.get("commits").and_then(|x| x.as_array()) {
        for c in arr {
            let sha = c.get("sha").and_then(|x| x.as_str()).unwrap_or("");
            let commit = c.get("commit").cloned().unwrap_or(Value::Null);
            let message = commit
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let summary = message.lines().next().unwrap_or("").to_string();
            let author = commit
                .get("author")
                .and_then(|a| a.get("name"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let date = commit
                .get("author")
                .and_then(|a| a.get("date"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            commits.push(Commit {
                short: sha.chars().take(7).collect(),
                summary,
                message,
                author,
                date,
                url: c.get("html_url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    let mut files = Vec::new();
    if let Some(arr) = v.get("files").and_then(|x| x.as_array()) {
        for f in arr {
            files.push(CommitFile {
                filename: f.get("filename").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                status: f.get("status").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                additions: f.get("additions").and_then(|x| x.as_u64()).unwrap_or(0),
                deletions: f.get("deletions").and_then(|x| x.as_u64()).unwrap_or(0),
            });
        }
    }

    GithubOut {
        available: true,
        message: None,
        repo_url: Some(repo_url),
        compare_url: v.get("html_url").and_then(|x| x.as_str()).map(|s| s.to_string()),
        from_tag: Some(bt),
        to_tag: Some(ht),
        intermediate_versions: intermediate,
        commits,
        files,
    }
}

fn intermediate_versions(ctx: &Ctx, name: &str, from: &str, to: &str) -> Vec<String> {
    use semver::Version;
    let (Ok(lo), Ok(hi)) = (Version::parse(from), Version::parse(to)) else {
        return Vec::new();
    };
    let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
    let Ok(list) = crates_io::versions(ctx, name) else {
        return Vec::new();
    };
    let mut mid: Vec<Version> = list
        .into_iter()
        .filter_map(|v| Version::parse(&v.num).ok())
        .filter(|v| *v > lo && *v < hi)
        .collect();
    mid.sort();
    mid.into_iter().map(|v| v.to_string()).collect()
}
