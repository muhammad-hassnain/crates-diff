//! Small shared helpers: HTTP GET wrappers, query-string parsing, percent-decode.

use std::collections::HashMap;
use std::io::Read;

pub const USER_AGENT: &str =
    "crates_diff (local crate-diff viewer; https://github.com/)";

/// GET a URL as text with our User-Agent (crates.io rejects blank UAs).
pub fn get_text(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    let resp = agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?;
    resp.into_string().map_err(|e| format!("read {url}: {e}"))
}

/// GET a URL as raw bytes (crate tarballs).
pub fn get_bytes(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, String> {
    let resp = agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(64 * 1024 * 1024) // 64 MB safety cap
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {url}: {e}"))?;
    Ok(buf)
}

/// GET a GitHub API URL, attaching an auth token when present. Returns
/// (status_code, body). Non-200s return the body too so callers can inspect.
pub fn github_get(
    agent: &ureq::Agent,
    url: &str,
    token: Option<&str>,
) -> Result<(u16, String), String> {
    let mut req = agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json");
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    match req.call() {
        Ok(resp) => {
            let code = resp.status();
            let body = resp.into_string().unwrap_or_default();
            Ok((code, body))
        }
        // ureq treats >=400 as Err(Status); surface it rather than bailing.
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Ok((code, body))
        }
        Err(e) => Err(format!("GET {url}: {e}")),
    }
}

/// Parse the `?a=1&b=two` part of a request path into a map (percent-decoded).
pub fn parse_query(raw_url: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(q) = raw_url.splitn(2, '?').nth(1) else {
        return map;
    };
    for pair in q.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut it = pair.splitn(2, '=');
        let k = percent_decode(it.next().unwrap_or(""));
        let v = percent_decode(it.next().unwrap_or(""));
        map.insert(k, v);
    }
    map
}

/// The path portion of a request URL, before any `?`.
pub fn path_only(raw_url: &str) -> &str {
    raw_url.splitn(2, '?').next().unwrap_or(raw_url)
}

/// Minimal application/x-www-form-urlencoded percent-decode (+ -> space).
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_val(bytes[i + 1]);
                let lo = hex_val(bytes[i + 2]);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push(h << 4 | l);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
