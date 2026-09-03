//! On-disk layout, crate-source caching, and local (unpublished) version support.
//!
//! ```text
//! <root>/data/
//!   cache/<crate>/<version>.json   extracted text files of a crates.io version
//!   local/<crate>/<version>/...    a crate source tree the user imported by hand
//!   notes.json                     all saved notes
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use flate2::read::GzDecoder;
use serde_json::{Map, Value};
use tar::Archive;

use crate::util;

/// Shared, thread-safe application state.
pub struct Ctx {
    pub agent: ureq::Agent,
    pub data: PathBuf,
    pub web: PathBuf,
    pub github_token: Option<String>,
    /// All saved notes, keyed by an arbitrary string the frontend chooses.
    /// Persisted to `data/notes.json`.
    pub notes: Mutex<Map<String, Value>>,
}

impl Ctx {
    pub fn new(root: PathBuf) -> Self {
        let data = root.join("data");
        let web = root.join("web");
        let _ = fs::create_dir_all(data.join("cache"));
        let _ = fs::create_dir_all(data.join("local"));
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(60))
            .build();
        let github_token = load_github_token(&root);
        let notes = Mutex::new(load_notes(&data));
        Ctx {
            agent,
            data,
            web,
            github_token,
            notes,
        }
    }

    /// Persist the current notes map to `data/notes.json`.
    pub fn save_notes(&self) {
        let guard = self.notes.lock().unwrap();
        let path = self.data.join("notes.json");
        if let Ok(json) = serde_json::to_string_pretty(&*guard) {
            let _ = fs::write(path, json);
        }
    }

    fn cache_file(&self, name: &str, ver: &str) -> PathBuf {
        self.data.join("cache").join(name).join(format!("{ver}.json"))
    }

    fn local_dir(&self, name: &str, ver: &str) -> PathBuf {
        self.data.join("local").join(name).join(ver)
    }

    /// Every locally-imported version number for a crate (unpublished builds).
    pub fn local_versions(&self, name: &str) -> Vec<String> {
        let dir = self.data.join("local").join(name);
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    if let Some(v) = e.file_name().to_str() {
                        out.push(v.to_string());
                    }
                }
            }
        }
        out
    }

    /// `{relative_path -> text}` for one crate version. Resolution order:
    /// imported local tree, then the extract cache, then a fresh tarball download.
    /// Returns None only if the version can't be obtained at all.
    pub fn version_files(&self, name: &str, ver: &str) -> Option<BTreeMap<String, String>> {
        let local = self.local_dir(name, ver);
        if local.is_dir() {
            return Some(read_tree(&local));
        }

        let cache = self.cache_file(name, ver);
        if cache.is_file() {
            if let Ok(txt) = fs::read_to_string(&cache) {
                if let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(&txt) {
                    return Some(map);
                }
            }
        }

        let url = format!("https://static.crates.io/crates/{name}/{name}-{ver}.crate");
        let bytes = util::get_bytes(&self.agent, &url).ok()?;
        let files = extract_tarball(&bytes);
        // Cache even an empty extract so we don't re-download a bad version.
        if let Some(parent) = cache.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&files) {
            let _ = fs::write(&cache, json);
        }
        Some(files)
    }

    /// Copy a crate source directory into `data/local/<crate>/<version>/` so it
    /// shows up in the version list alongside published versions.
    pub fn import_local(&self, name: &str, ver: &str, src: &Path) -> Result<usize, String> {
        if !src.is_dir() {
            return Err(format!("source path is not a directory: {}", src.display()));
        }
        let dest = self.local_dir(name, ver);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let n = copy_tree(src, &dest)?;
        Ok(n)
    }
}

fn load_notes(data: &Path) -> Map<String, Value> {
    let path = data.join("notes.json");
    if let Ok(txt) = fs::read_to_string(path) {
        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&txt) {
            return m;
        }
    }
    Map::new()
}

fn load_github_token(root: &Path) -> Option<String> {
    if let Ok(v) = std::env::var("GITHUB_TOKEN") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    let f = root.join(".github_token");
    if let Ok(v) = fs::read_to_string(f) {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    None
}

/// Normalize CRLF / lone CR to LF so a line-ending-only change isn't a diff.
fn norm_eol(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// True if the blob looks binary (a NUL byte in the first 8 KB).
fn looks_binary(bytes: &[u8]) -> bool {
    let n = bytes.len().min(8000);
    bytes[..n].contains(&0)
}

/// Extract text files from a `.crate` (gzip tar), stripping the leading
/// `crate-version/` path component so keys are package-relative.
fn extract_tarball(bytes: &[u8]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let dec = GzDecoder::new(bytes);
    let mut ar = Archive::new(dec);
    let Ok(entries) = ar.entries() else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(path) = entry.header().path() else {
            continue;
        };
        let rel = strip_first_component(&path.to_string_lossy());
        if rel.is_empty() {
            continue;
        }
        let mut e = entry;
        let mut buf = Vec::new();
        use std::io::Read;
        if e.read_to_end(&mut buf).is_err() {
            continue;
        }
        if looks_binary(&buf) {
            continue;
        }
        let text = String::from_utf8_lossy(&buf);
        out.insert(rel, norm_eol(&text));
    }
    out
}

fn strip_first_component(p: &str) -> String {
    match p.split_once('/') {
        Some((_, rest)) => rest.to_string(),
        None => String::new(),
    }
}

/// Read a directory tree into `{relative_path -> text}`, skipping binaries and a
/// few noise dirs (target/.git). Used for imported local versions.
fn read_tree(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if matches!(name.as_str(), "target" | ".git" | "node_modules") {
                    continue;
                }
                stack.push(p);
            } else if let Ok(bytes) = fs::read(&p) {
                if looks_binary(&bytes) {
                    continue;
                }
                if let Ok(rel) = p.strip_prefix(root) {
                    let key = rel.to_string_lossy().replace('\\', "/");
                    out.insert(key, norm_eol(&String::from_utf8_lossy(&bytes)));
                }
            }
        }
    }
    out
}

/// Recursively copy a source tree (skipping target/.git/node_modules). Returns
/// the number of files copied.
fn copy_tree(src: &Path, dest: &Path) -> Result<usize, String> {
    let mut count = 0;
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let rel = p.strip_prefix(src).map_err(|e| e.to_string())?;
            let target = dest.join(rel);
            if p.is_dir() {
                if matches!(name.as_str(), "target" | ".git" | "node_modules") {
                    continue;
                }
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                stack.push(p);
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::copy(&p, &target).map_err(|e| e.to_string())?;
                count += 1;
            }
        }
    }
    Ok(count)
}
