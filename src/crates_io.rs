//! crates.io REST access: crate search, full version list, repo resolution.

use semver::Version;
use serde::Serialize;
use serde_json::Value;

use crate::store::Ctx;
use crate::util;

const API: &str = "https://crates.io/api/v1";

#[derive(Serialize)]
pub struct CrateHit {
    pub name: String,
    pub description: String,
    pub max_version: String,
    pub downloads: u64,
}

#[derive(Serialize)]
pub struct VersionInfo {
    pub num: String,
    pub yanked: bool,
    /// "crates.io" for a published version, "local" for an imported build.
    pub source: &'static str,
}

/// Search crates by name/description, most-downloaded first.
pub fn search(agent: &ureq::Agent, q: &str) -> Result<Vec<CrateHit>, String> {
    let q_enc = q
        .as_bytes()
        .iter()
        .map(|b| encode_byte(*b))
        .collect::<String>();
    let url = format!("{API}/crates?q={q_enc}&per_page=20&sort=downloads");
    let body = util::get_text(agent, &url)?;
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("crates").and_then(|c| c.as_array()) {
        for c in arr {
            out.push(CrateHit {
                name: c.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                description: c
                    .get("description")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                max_version: c
                    .get("max_version")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                downloads: c.get("downloads").and_then(|x| x.as_u64()).unwrap_or(0),
            });
        }
    }
    Ok(out)
}

/// All versions of a crate — published (any 0.x / pre-release included, no semver
/// filtering) merged with locally-imported builds — newest first.
pub fn versions(ctx: &Ctx, name: &str) -> Result<Vec<VersionInfo>, String> {
    let url = format!("{API}/crates/{name}/versions");
    let mut out: Vec<VersionInfo> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    match util::get_text(&ctx.agent, &url) {
        Ok(body) => {
            let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            if let Some(arr) = v.get("versions").and_then(|x| x.as_array()) {
                for ver in arr {
                    let num = ver.get("num").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if num.is_empty() {
                        continue;
                    }
                    let yanked = ver.get("yanked").and_then(|x| x.as_bool()).unwrap_or(false);
                    seen.insert(num.clone());
                    out.push(VersionInfo {
                        num,
                        yanked,
                        source: "crates.io",
                    });
                }
            }
        }
        // A crate that only exists locally (never published) is still valid here.
        Err(e) if ctx.local_versions(name).is_empty() => return Err(e),
        Err(_) => {}
    }

    for lv in ctx.local_versions(name) {
        if seen.insert(lv.clone()) {
            out.push(VersionInfo {
                num: lv,
                yanked: false,
                source: "local",
            });
        }
    }

    sort_versions_desc(&mut out);
    Ok(out)
}

/// crates.io -> GitHub (owner, repo), if the crate declares a github repository.
pub fn github_repo(agent: &ureq::Agent, name: &str) -> Option<(String, String)> {
    let url = format!("{API}/crates/{name}");
    let body = util::get_text(agent, &url).ok()?;
    let v: Value = serde_json::from_str(&body).ok()?;
    let repo = v
        .get("crate")
        .and_then(|c| c.get("repository"))
        .and_then(|r| r.as_str())?;
    parse_github(repo)
}

fn parse_github(repo: &str) -> Option<(String, String)> {
    let idx = repo.find("github.com")?;
    let rest = &repo[idx + "github.com".len()..];
    let rest = rest.trim_start_matches(['/', ':']);
    let mut parts = rest.split('/').filter(|s| !s.is_empty());
    let owner = parts.next()?.to_string();
    let mut repo_name = parts.next()?.to_string();
    if let Some(stripped) = repo_name.strip_suffix(".git") {
        repo_name = stripped.to_string();
    }
    Some((owner, repo_name))
}

/// Sort versions newest -> oldest. Valid semver compares numerically; anything
/// unparseable falls back to reverse string order so it still has a place.
fn sort_versions_desc(list: &mut [VersionInfo]) {
    list.sort_by(|a, b| {
        match (Version::parse(&a.num), Version::parse(&b.num)) {
            (Ok(va), Ok(vb)) => vb.cmp(&va),
            (Ok(_), Err(_)) => std::cmp::Ordering::Less,
            (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
            (Err(_), Err(_)) => b.num.cmp(&a.num),
        }
    });
}

fn encode_byte(b: u8) -> String {
    match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
            (b as char).to_string()
        }
        _ => format!("%{b:02X}"),
    }
}
