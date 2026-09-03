"use strict";

/*
 * crates_diff — fully client-side, diff.rs-style SPA.
 *
 *   #/                        landing (search + New / Most Downloaded / Just Updated)
 *   #/search/<q>             crate search results
 *   #/<crate>                redirect to the newest two versions
 *   #/<crate>/<from>/<to>    the version diff view
 *   #/about                  about
 *
 * All data comes straight from the browser: crates.io REST API for search /
 * versions / summary / repo metadata, static.crates.io for the .crate tarballs
 * (gunzipped + untarred + Myers-diffed here), and the GitHub compare API (optionally
 * via the Worker proxy in ../worker so a token can raise the rate limit). Notes live
 * in localStorage.
 */

const CRATES_API = "https://crates.io/api/v1";
const STATIC = "https://static.crates.io/crates";
const GH_API = "https://api.github.com";

/* ---------------- tiny helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const view = () => document.getElementById("view");
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

const CUBES = '<svg class="cubes" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.5 2.5 4 6v5l7.5 3.5L19 11V6l-7.5-3.5Zm0 2.2L15.9 6 11.5 8 7.1 6l4.4-1.3ZM6 8.1l4.5 2.1v3.3L6 11.4V8.1Zm7 5.4v-3.3L17.5 8v3.3L13 13.5Z"/></svg>';
const MAG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.2-3.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/* ============================================================= *
 *  crates.io + GitHub HTTP
 * ============================================================= */
async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j && j.errors && j.errors[0] && j.errors[0].detail) msg = j.errors[0].detail; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

// GitHub GET, routed through the Worker proxy when window.GH_PROXY is set (the proxy
// adds the token server-side); otherwise a direct, unauthenticated call (60/hr).
async function githubGet(url) {
  const proxy = (window.GH_PROXY || "").trim().replace(/\/$/, "");
  const target = proxy ? proxy + url.slice(GH_API.length) : url;
  const r = await fetch(target, { headers: { Accept: "application/vnd.github+json" } });
  const body = await r.text();
  return { code: r.status, body };
}

/* ============================================================= *
 *  semver
 * ============================================================= */
function parseSemver(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(s).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}
function cmpSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const ai = a.pre.split("."), bi = b.pre.split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (i >= ai.length) return -1;
    if (i >= bi.length) return 1;
    const x = ai[i], y = bi[i], xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (xn) return -1; else if (yn) return 1; else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function sortVersionsDesc(list) {
  list.sort((a, b) => {
    const va = parseSemver(a.num), vb = parseSemver(b.num);
    if (va && vb) return cmpSemver(vb, va);
    if (va && !vb) return -1;
    if (!va && vb) return 1;
    return b.num < a.num ? -1 : b.num > a.num ? 1 : 0;
  });
}

/* ============================================================= *
 *  tarball -> {path: text}
 * ============================================================= */
const filesCache = new Map();
const versionsCache = new Map();

async function gunzip(arrayBuffer) {
  if (typeof DecompressionStream === "undefined") throw new Error("this browser lacks DecompressionStream (needed to unpack crates)");
  const ds = new DecompressionStream("gzip");
  const stream = new Response(arrayBuffer).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function readCStr(bytes, off, len) {
  let end = off; const max = off + len;
  while (end < max && bytes[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(bytes.subarray(off, end));
}
function parseOctal(str) { const s = str.replace(/[^0-7]/g, ""); return s ? parseInt(s, 8) : 0; }
function untar(bytes) {
  const out = []; let off = 0; let override = null; const dec = new TextDecoder("utf-8");
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    let allZero = true; for (let i = 0; i < 512; i++) if (block[i] !== 0) { allZero = false; break; }
    if (allZero) break;
    const name = readCStr(bytes, off, 100);
    const size = parseOctal(readCStr(bytes, off + 124, 12));
    const type = String.fromCharCode(bytes[off + 156]);
    const prefix = readCStr(bytes, off + 345, 155);
    const dataStart = off + 512;
    if (type === "L") {
      override = dec.decode(bytes.subarray(dataStart, dataStart + size)).replace(/\0+$/, "");
    } else if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(bytes.subarray(dataStart, dataStart + size)));
      if (m) override = m[1];
    } else if (type === "0" || type === "\0" || type === "") {
      let full;
      if (override != null) { full = override; override = null; }
      else if (prefix) full = prefix + "/" + name; else full = name;
      out.push({ name: full, data: bytes.subarray(dataStart, dataStart + size) });
    } else if (type !== "g") { override = null; }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}
function stripFirstComponent(p) { const i = p.indexOf("/"); return i < 0 ? "" : p.slice(i + 1); }
function looksBinary(data) { const n = Math.min(8000, data.length); for (let i = 0; i < n; i++) if (data[i] === 0) return true; return false; }
function normEol(s) { return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
function extractTarball(raw) {
  const files = new Map(); const dec = new TextDecoder("utf-8");
  for (const f of untar(raw)) {
    const rel = stripFirstComponent(f.name);
    if (!rel || looksBinary(f.data)) continue;
    files.set(rel, normEol(dec.decode(f.data)));
  }
  return files;
}
async function getVersionFiles(name, ver) {
  const key = name + "@" + ver;
  if (filesCache.has(key)) return filesCache.get(key);
  const r = await fetch(`${STATIC}/${name}/${name}-${ver}.crate`);
  if (!r.ok) throw new Error(`couldn't download ${name} ${ver} (HTTP ${r.status})`);
  const map = extractTarball(await gunzip(await r.arrayBuffer()));
  filesCache.set(key, map);
  return map;
}

/* ============================================================= *
 *  line diff (Myers)
 * ============================================================= */
function rustLines(s) { if (s === "") return []; const p = s.split("\n"); if (p[p.length - 1] === "") p.pop(); return p; }
function myers(a, b) {
  const n = a.length, m = b.length, max = n + m; if (max === 0) return [];
  const off = max; let v = new Int32Array(2 * max + 1); const trace = []; let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]; else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  const ops = []; let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]; const k = x - y; let prevK;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1; else prevK = k - 1;
    const prevX = vv[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ tag: "eq", o: x - 1, n: y - 1 }); x--; y--; }
    if (d > 0) { if (x === prevX) { ops.push({ tag: "add", o: null, n: y - 1 }); y--; } else { ops.push({ tag: "del", o: x - 1, n: null }); x--; } }
  }
  ops.reverse();
  return ops;
}
function diffLines(a, b) {
  const n = a.length, m = b.length;
  let pre = 0; while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ tag: "eq", o: i, n: i });
  const aMid = a.slice(pre, n - suf), bMid = b.slice(pre, m - suf);
  let mid;
  if (aMid.length + bMid.length === 0) mid = [];
  else if (aMid.length > 2500 || bMid.length > 2500 || aMid.length + bMid.length > 3000) {
    mid = [];
    for (let i = 0; i < aMid.length; i++) mid.push({ tag: "del", o: i, n: null });
    for (let j = 0; j < bMid.length; j++) mid.push({ tag: "add", o: null, n: j });
  } else mid = myers(aMid, bMid);
  for (const op of mid) ops.push({ tag: op.tag, o: op.o == null ? null : op.o + pre, n: op.n == null ? null : op.n + pre });
  for (let i = 0; i < suf; i++) ops.push({ tag: "eq", o: n - suf + i, n: m - suf + i });
  return ops;
}
function countChanges(a, b) {
  let added = 0, removed = 0;
  for (const op of diffLines(rustLines(a), rustLines(b))) { if (op.tag === "add") added++; else if (op.tag === "del") removed++; }
  return [added, removed];
}
function buildHunks(ops, aLines, bLines) {
  const context = 3; const changed = [];
  ops.forEach((op, i) => { if (op.tag !== "eq") changed.push(i); });
  if (!changed.length) return [];
  const groups = []; let start = changed[0], prev = changed[0];
  for (let i = 1; i < changed.length; i++) { if (changed[i] - prev > context * 2) { groups.push([start, prev]); start = changed[i]; } prev = changed[i]; }
  groups.push([start, prev]);
  const hunks = [];
  for (const [gs, ge] of groups) {
    const s = Math.max(0, gs - context), e = Math.min(ops.length - 1, ge + context);
    const lines = []; let oldStart = Infinity, newStart = Infinity, oldLen = 0, newLen = 0;
    for (let i = s; i <= e; i++) {
      const op = ops[i];
      const old = op.o == null ? null : op.o + 1, nw = op.n == null ? null : op.n + 1;
      if (old != null) { oldStart = Math.min(oldStart, old); oldLen++; }
      if (nw != null) { newStart = Math.min(newStart, nw); newLen++; }
      lines.push({ tag: op.tag, old, new: nw, text: op.o != null ? aLines[op.o] : bLines[op.n] });
    }
    if (oldStart === Infinity) oldStart = 0;
    if (newStart === Infinity) newStart = 0;
    hunks.push({ header: `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, lines });
  }
  return hunks;
}
function statusOf(hasA, hasB, ta, tb) {
  if (!hasA && hasB) return "added";
  if (hasA && !hasB) return "removed";
  if (ta === tb) return "unchanged";
  return "modified";
}
function computeFileList(aMap, bMap) {
  const paths = new Set([...aMap.keys(), ...bMap.keys()]); const files = []; let changed = 0;
  for (const path of paths) {
    const hasA = aMap.has(path), hasB = bMap.has(path), ta = aMap.get(path) ?? "", tb = bMap.get(path) ?? "";
    const status = statusOf(hasA, hasB, ta, tb); let added = 0, removed = 0;
    if (status !== "unchanged") { [added, removed] = countChanges(ta, tb); changed++; }
    files.push({ path, status, added, removed });
  }
  files.sort((x, y) => {
    const xc = x.status !== "unchanged" ? 1 : 0, yc = y.status !== "unchanged" ? 1 : 0;
    if (yc !== xc) return yc - xc;
    const churn = (y.added + y.removed) - (x.added + x.removed);
    if (churn !== 0) return churn;
    return x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
  });
  return { files, changed, total: files.length };
}
function computeFileDiff(aMap, bMap, path) {
  const hasA = aMap.has(path), hasB = bMap.has(path);
  if (!hasA && !hasB) return null;
  const ta = aMap.get(path) ?? "", tb = bMap.get(path) ?? "", status = statusOf(hasA, hasB, ta, tb);
  if (ta === tb) {
    const arr = rustLines(ta), lines = arr.map((l, i) => ({ tag: "eq", old: i + 1, new: i + 1, text: l })), n = lines.length;
    return { path, status, hunks: n === 0 ? [] : [{ header: `@@ -1,${n} +1,${n} @@`, lines }] };
  }
  const aLines = rustLines(ta), bLines = rustLines(tb);
  return { path, status, hunks: buildHunks(diffLines(aLines, bLines), aLines, bLines) };
}
function computeContentSearch(aMap, bMap, query) {
  const q = query.trim(); if (!q) return [];
  const ql = q.toLowerCase(); const paths = new Set([...aMap.keys(), ...bMap.keys()]); const hits = [];
  for (const path of paths) {
    let text; if (bMap.has(path)) text = bMap.get(path); else if (aMap.has(path)) text = aMap.get(path); else continue;
    const lines = [], arr = rustLines(text);
    for (let i = 0; i < arr.length; i++) { if (arr[i].toLowerCase().includes(ql)) { lines.push({ line: i + 1, text: arr[i].replace(/\s+$/, "") }); if (lines.length >= 12) break; } }
    if (lines.length) hits.push({ path, count: lines.length, lines });
  }
  hits.sort((x, y) => y.count - x.count || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return hits;
}

/* ============================================================= *
 *  GitHub history
 * ============================================================= */
function parseGithubRepo(repo) {
  const idx = repo.indexOf("github.com"); if (idx < 0) return null;
  const rest = repo.slice(idx + "github.com".length).replace(/^[/:]+/, "");
  const parts = rest.split("/").filter(Boolean); if (parts.length < 2) return null;
  let name = parts[1]; if (name.endsWith(".git")) name = name.slice(0, -4);
  return { owner: parts[0], repo: name };
}
async function resolveRepo(name) {
  try {
    const data = await fetchJson(`${CRATES_API}/crates/${encodeURIComponent(name)}`);
    const repo = data && data.crate && data.crate.repository;
    return repo ? parseGithubRepo(repo) : null;
  } catch (_) { return null; }
}
function normTag(tag) {
  const t = tag.trim(); let best = null, i = 0;
  const isDigit = (c) => c >= "0" && c <= "9";
  const isAlpha = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
  while (i < t.length) {
    if (isDigit(t[i])) {
      const start = i;
      while (i < t.length && (isDigit(t[i]) || t[i] === "." || t[i] === "-" || t[i] === "+" || isAlpha(t[i]))) i++;
      const cand = t.slice(start, i);
      if (cand.split(".").length >= 3 && isDigit(cand[0])) best = cand;
    } else i++;
  }
  return best;
}
async function versionTags(owner, repo) {
  const out = [], seen = new Set();
  for (let page = 1; page <= 20; page++) {
    const { code, body } = await githubGet(`${GH_API}/repos/${owner}/${repo}/tags?per_page=100&page=${page}`);
    if (code !== 200) break;
    let arr; try { arr = JSON.parse(body); } catch (_) { break; }
    if (!Array.isArray(arr)) break;
    for (const t of arr) { const ver = t && t.name ? normTag(t.name) : null; if (ver && !seen.has(ver)) { seen.add(ver); out.push([ver, t.name]); } }
    if (arr.length < 100) break;
  }
  return out;
}
function intermediateVersions(versions, from, to) {
  const lo0 = parseSemver(from), hi0 = parseSemver(to); if (!lo0 || !hi0) return [];
  let lo = lo0, hi = hi0; if (cmpSemver(lo, hi) > 0) { lo = hi0; hi = lo0; }
  return versions.map((v) => v.num).filter((num) => { const p = parseSemver(num); return p && cmpSemver(p, lo) > 0 && cmpSemver(p, hi) < 0; })
    .sort((a, b) => cmpSemver(parseSemver(a), parseSemver(b)));
}
async function githubHistory(name, from, to, versions) {
  const rr = await resolveRepo(name);
  if (!rr) return { available: false, message: "No GitHub repository is declared for this crate on crates.io." };
  const { owner, repo } = rr, repo_url = `https://github.com/${owner}/${repo}`;
  const intermediate = intermediateVersions(versions, from, to);
  let tags; try { tags = await versionTags(owner, repo); } catch (e) { return { available: false, message: "Couldn't list git tags: " + e.message, repo_url }; }
  const find = (ver) => { const t = tags.find(([v]) => v === ver); return t ? t[1] : null; };
  const fromTag = find(from), toTag = find(to);
  if (!fromTag || !toTag) return { available: false, message: "Couldn't match both versions to git tags in this repo (some crates don't tag every release).", repo_url, from_tag: fromTag, to_tag: toTag, intermediate_versions: intermediate };
  const { code, body } = await githubGet(`${GH_API}/repos/${owner}/${repo}/compare/${fromTag}...${toTag}`);
  if (code !== 200) return { available: false, message: `GitHub compare returned HTTP ${code}` + (code === 403 ? " (rate limited — deploy the Worker proxy to add a token)" : "") + ".", repo_url, from_tag: fromTag, to_tag: toTag, intermediate_versions: intermediate };
  let v; try { v = JSON.parse(body); } catch (_) { v = {}; }
  const commits = (v.commits || []).map((c) => { const commit = c.commit || {}; const message = commit.message || ""; return { short: (c.sha || "").slice(0, 7), summary: message.split("\n")[0] || "", author: (commit.author && commit.author.name) || "", date: (commit.author && commit.author.date) || "", url: c.html_url || "" }; });
  return { available: true, repo_url, compare_url: v.html_url || null, from_tag: fromTag, to_tag: toTag, intermediate_versions: intermediate, commits };
}

/* ============================================================= *
 *  data fetchers used by views
 * ============================================================= */
async function fetchVersions(name) {
  if (versionsCache.has(name)) return versionsCache.get(name);
  const data = await fetchJson(`${CRATES_API}/crates/${encodeURIComponent(name)}/versions`);
  const versions = (data.versions || []).filter((v) => v.num).map((v) => ({ num: v.num, yanked: !!v.yanked }));
  sortVersionsDesc(versions);
  versionsCache.set(name, versions);
  return versions;
}

/* ============================================================= *
 *  ROUTER
 * ============================================================= */
function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function parseRoute() {
  let h = location.hash.replace(/^#/, "");
  if (!h || h === "/") return { name: "landing" };
  const parts = h.replace(/^\//, "").split("/").map(decodeURIComponent);
  if (parts[0] === "about") return { name: "about" };
  if (parts[0] === "search") return { name: "search", q: parts.slice(1).join("/") };
  if (parts.length === 1) return { name: "crate", crate: parts[0] };
  if (parts.length >= 3) return { name: "compare", crate: parts[0], from: parts[1], to: parts[2] };
  return { name: "landing" };
}

async function route() {
  const r = parseRoute();
  try {
    if (r.name === "landing") return renderLanding();
    if (r.name === "about") return renderAbout();
    if (r.name === "search") return renderSearch(r.q);
    if (r.name === "crate") return redirectCrate(r.crate);
    if (r.name === "compare") return renderCompare(r.crate, r.from, r.to);
  } catch (err) {
    view().innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

/* ============================================================= *
 *  LANDING
 * ============================================================= */
function crateCard(c) {
  const ver = c.newest_version || c.max_version || "";
  return `<a class="crate-card" href="#/${encodeURIComponent(c.name)}">
    <div class="head"><span class="name">${esc(c.name)}</span><span class="ver">${esc(ver)}</span>${CUBES}</div>
    <div class="desc">${esc(c.description || "")}</div></a>`;
}
function searchBar(value) {
  return `<form class="search-box" id="search-form">
    ${MAG}
    <input type="search" id="q" placeholder="Search for crates" value="${esc(value || "")}" autocomplete="off">
    <button class="primary" type="submit">Search</button>
  </form>`;
}
async function renderLanding() {
  view().innerHTML = `<div class="landing">
    <div class="hero">
      <h1><b>crates</b>_diff</h1>
      <p>Full-source diffs between any two versions of a Rust crate — in your browser.</p>
    </div>
    <div class="search-hero">${searchBar("")}</div>
    <div id="cols" class="columns">
      <div class="column"><h2>New Crates</h2><div class="card-list" id="col-new"><div class="spinner">loading…</div></div></div>
      <div class="column"><h2>Most Downloaded</h2><div class="card-list" id="col-dl"><div class="spinner">loading…</div></div></div>
      <div class="column"><h2>Just Updated</h2><div class="card-list" id="col-upd"><div class="spinner">loading…</div></div></div>
    </div>
  </div>`;
  wireSearchForm();
  try {
    const s = await fetchJson(`${CRATES_API}/summary`);
    const fill = (id, arr) => { const box = $("#" + id); box.innerHTML = (arr || []).slice(0, 8).map(crateCard).join("") || '<div class="empty">none</div>'; };
    fill("col-new", s.new_crates);
    fill("col-dl", s.most_downloaded);
    fill("col-upd", s.just_updated);
  } catch (err) {
    for (const id of ["col-new", "col-dl", "col-upd"]) { const b = $("#" + id); if (b) b.innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`; }
  }
}

function wireSearchForm() {
  const f = $("#search-form");
  if (!f) return;
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#q").value.trim();
    if (q) navigate(`#/search/${encodeURIComponent(q)}`);
  });
}

/* ============================================================= *
 *  SEARCH RESULTS
 * ============================================================= */
async function renderSearch(q) {
  view().innerHTML = `<div class="results">
    <a class="back" href="#/">← home</a>
    <div style="margin:14px 0 18px">${searchBar(q)}</div>
    <div id="hits"><div class="spinner">searching…</div></div>
  </div>`;
  wireSearchForm();
  try {
    const { crates } = await fetchJson(`${CRATES_API}/crates?q=${encodeURIComponent(q)}&per_page=30&sort=downloads`);
    const box = $("#hits");
    if (!crates || !crates.length) { box.innerHTML = '<div class="empty">no matches</div>'; return; }
    box.innerHTML = crates.map((c) => `<a class="result-row" href="#/${encodeURIComponent(c.name)}">
      <div class="head"><span class="name">${esc(c.name)}</span><span class="meta">v${esc(c.max_version)} · ${(c.downloads || 0).toLocaleString()} downloads</span></div>
      <div class="desc">${esc(c.description || "")}</div></a>`).join("");
  } catch (err) {
    $("#hits").innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

/* ============================================================= *
 *  CRATE -> redirect to newest two
 * ============================================================= */
async function redirectCrate(name) {
  view().innerHTML = `<div class="loading">loading ${esc(name)} versions…</div>`;
  const versions = await fetchVersions(name);
  if (!versions.length) { view().innerHTML = `<div class="empty">no versions found for ${esc(name)}</div>`; return; }
  const to = versions[0].num, from = (versions[1] || versions[0]).num;
  location.replace("#/" + encodeURIComponent(name) + "/" + encodeURIComponent(from) + "/" + encodeURIComponent(to));
}

/* ============================================================= *
 *  COMPARE VIEW
 * ============================================================= */
const cmp = {};

async function renderCompare(name, from, to) {
  Object.assign(cmp, { crate: name, from, to, versions: [], aMap: null, bMap: null, files: [], path: null, tab: "diff", githubLoaded: null });

  view().innerHTML = `<div class="compare">
    <div class="cmp-bar">
      <div class="crate-name"><a href="#/${encodeURIComponent(name)}">${esc(name)}</a></div>
      <div class="cmp-vers">
        <select id="ver-from"></select>
        <button class="swap" id="swap" title="Swap from ⇄ to">⇄</button>
        <span class="arrow">→</span>
        <select id="ver-to"></select>
      </div>
      <div class="summary" id="summary"></div>
    </div>
    <div class="cmp-body">
      <div class="cmp-side">
        <div class="side-search"><input type="search" id="content-search" placeholder="search inside files…  (Enter)"></div>
        <div class="file-summary" id="file-summary"></div>
        <div class="file-list" id="file-list"><div class="spinner">downloading & diffing…</div></div>
      </div>
      <div class="cmp-main">
        <div class="tabs" id="tabs">
          <div class="tab active" data-tab="diff">Diff</div>
          <div class="tab" data-tab="github">GitHub</div>
          <div class="tab" data-tab="notes">Notes</div>
        </div>
        <div class="tabpanes">
          <div class="tabpane active" id="pane-diff"><div class="empty">Select a file to view its diff.</div></div>
          <div class="tabpane" id="pane-github"><div class="empty">Commit history for this transition appears here.</div></div>
          <div class="tabpane" id="pane-notes"></div>
        </div>
      </div>
    </div>
  </div>`;

  // versions -> selects
  let versions;
  try { versions = await fetchVersions(name); }
  catch (err) { $("#file-list").innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`; return; }
  cmp.versions = versions;
  if (!versions.some((v) => v.num === from) || !versions.some((v) => v.num === to)) {
    // requested versions don't exist — fall back to newest two
    to = versions[0] ? versions[0].num : to;
    from = versions[1] ? versions[1].num : to;
    cmp.from = from; cmp.to = to;
  }
  const fromSel = $("#ver-from"), toSel = $("#ver-to");
  for (const v of versions) {
    const label = v.num + (v.yanked ? "  (yanked)" : "");
    fromSel.appendChild(new Option(label, v.num));
    toSel.appendChild(new Option(label, v.num));
  }
  fromSel.value = from; toSel.value = to;

  fromSel.addEventListener("change", onVersionChange);
  toSel.addEventListener("change", onVersionChange);
  $("#swap").addEventListener("click", () => { const f = $("#ver-from"), t = $("#ver-to"); [f.value, t.value] = [t.value, f.value]; onVersionChange(); });
  $("#content-search").addEventListener("keydown", (e) => { if (e.key === "Enter") contentSearch(); });
  $("#tabs").querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  loadNotes();
  await loadDiff();
}

function onVersionChange() {
  const from = $("#ver-from").value, to = $("#ver-to").value;
  if (!from || !to) return;
  location.hash = `#/${encodeURIComponent(cmp.crate)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
}

async function loadDiff() {
  const { crate, from, to } = cmp;
  cmp.path = null; cmp.githubLoaded = null;
  $("#file-list").innerHTML = '<div class="spinner">downloading & diffing…</div>';
  $("#summary").innerHTML = `<b>${esc(from)}</b> → <b>${esc(to)}</b>`;
  setPane("diff", '<div class="empty">Select a file to view its diff.</div>');
  try {
    const [aMap, bMap] = await Promise.all([getVersionFiles(crate, from), getVersionFiles(crate, to)]);
    cmp.aMap = aMap; cmp.bMap = bMap;
    const data = computeFileList(aMap, bMap);
    cmp.files = data.files;
    $("#file-summary").innerHTML = `${data.changed} changed / ${data.total} files`;
    $("#summary").innerHTML = `<b>${esc(from)}</b> → <b>${esc(to)}</b> · ${data.changed} changed`;
    renderFileList(cmp.files);
    const firstChanged = cmp.files.find((f) => f.status !== "unchanged");
    if (firstChanged) openFile(firstChanged.path);
    if (cmp.tab === "github") loadGithub();
    loadNotes();
  } catch (err) {
    $("#file-list").innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

function renderFileList(files) {
  const list = $("#file-list"); list.innerHTML = "";
  if (!files.length) { list.innerHTML = '<div class="empty">no files</div>'; return; }
  for (const f of files) {
    const row = el("div", "file-row" + (f.status === "unchanged" ? " unchanged" : ""));
    row.dataset.path = f.path;
    let stat = f.status !== "unchanged" ? `<span class="stat"><span class="a">+${f.added}</span> <span class="d">-${f.removed}</span></span>` : "";
    let badge = f.status === "added" ? '<span class="badge added">A</span>' : f.status === "removed" ? '<span class="badge removed">D</span>' : f.status === "modified" ? '<span class="badge modified">M</span>' : "";
    row.innerHTML = `${badge}<span class="path" title="${esc(f.path)}">${esc(f.path)}</span>${stat}`;
    row.onclick = () => openFile(f.path);
    list.appendChild(row);
  }
}

function openFile(path) {
  cmp.path = path;
  document.querySelectorAll(".file-row").forEach((r) => r.classList.toggle("active", r.dataset.path === path));
  switchTab("diff");
  const d = computeFileDiff(cmp.aMap, cmp.bMap, path);
  setPane("diff", d ? renderDiff(d) : '<div class="empty">file not found</div>');
}

function renderDiff(d) {
  const head = `<div class="file-head"><span class="mono">${esc(d.path)}</span> <span class="badge ${d.status === "unchanged" ? "" : d.status}">${esc(d.status)}</span></div>`;
  if (!d.hunks.length) return head + '<div class="empty">empty file (no content)</div>';
  let out = '<div class="diff">';
  for (const h of d.hunks) {
    out += `<div class="hunk-header">${esc(h.header)}</div>`;
    for (const ln of h.lines) {
      const sign = ln.tag === "add" ? "+" : ln.tag === "del" ? "-" : " ";
      out += `<div class="dline ${ln.tag}"><span class="ln">${ln.old == null ? "" : ln.old}</span><span class="ln">${ln.new == null ? "" : ln.new}</span><span class="sign">${sign}</span><span class="tx">${esc(ln.text) || "&nbsp;"}</span></div>`;
    }
  }
  return head + out + "</div>";
}

function contentSearch() {
  const q = $("#content-search").value.trim();
  if (!q) { renderFileList(cmp.files); $("#file-summary").innerHTML = `${cmp.files.length} files`; return; }
  const results = computeContentSearch(cmp.aMap, cmp.bMap, q);
  $("#file-summary").innerHTML = `${results.length} file(s) contain <b>${esc(q)}</b>`;
  const list = $("#file-list"); list.innerHTML = "";
  if (!results.length) { list.innerHTML = '<div class="empty">no matches</div>'; return; }
  const ql = q.toLowerCase();
  for (const r of results) {
    const row = el("div", "file-row");
    row.innerHTML = `<span class="path" title="${esc(r.path)}">${esc(r.path)}</span><span class="stat">${r.count}×</span>`;
    row.onclick = () => openFile(r.path);
    list.appendChild(row);
    for (const m of r.lines.slice(0, 4)) {
      const hl = esc(m.text).replace(new RegExp("(" + ql.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<b>$1</b>");
      const mline = el("div", "match-line", `${m.line}: ${hl}`);
      mline.onclick = () => openFile(r.path);
      list.appendChild(mline);
    }
  }
}

/* ---------------- tabs ---------------- */
function switchTab(name) {
  cmp.tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
  if (name === "github" && cmp.aMap && cmp.githubLoaded !== cmp.from + ".." + cmp.to) loadGithub();
}
function setPane(name, html) { const p = $("#pane-" + name); if (p) p.innerHTML = html; }

/* ---------------- github ---------------- */
async function loadGithub() {
  cmp.githubLoaded = cmp.from + ".." + cmp.to;
  setPane("github", '<div class="spinner">fetching commit history…</div>');
  try { setPane("github", renderGithub(await githubHistory(cmp.crate, cmp.from, cmp.to, cmp.versions))); }
  catch (err) { setPane("github", `<div class="empty">error: ${esc(err.message)}</div>`); }
}
function renderGithub(g) {
  let head = "";
  if (g.repo_url) {
    head += `<div class="pad"><a href="${esc(g.repo_url)}" target="_blank" rel="noopener">${esc(g.repo_url)}</a>`;
    if (g.compare_url) head += ` · <a href="${esc(g.compare_url)}" target="_blank" rel="noopener">compare on GitHub ↗</a>`;
    head += "</div>";
  }
  if (g.intermediate_versions && g.intermediate_versions.length) {
    head += '<div class="pad muted" style="font-size:12.5px">intermediate releases: ' + g.intermediate_versions.map((v) => `<span class="pill">${esc(v)}</span>`).join("") + "</div>";
  }
  if (!g.available) return head + `<div class="empty">${esc(g.message || "no GitHub data")}</div>`;
  if (!g.commits.length) return head + '<div class="empty">no commits between these tags</div>';
  let out = head + `<div class="pad muted" style="font-size:12.5px">${g.commits.length} commit(s) · tags ${esc(g.from_tag)} → ${esc(g.to_tag)}</div>`;
  for (const c of g.commits) {
    out += `<div class="commit"><div class="summary-line">${esc(c.summary)}</div><div class="meta"><a href="${esc(c.url)}" target="_blank" rel="noopener" class="mono">${esc(c.short)}</a> · ${esc(c.author || "?")} · ${esc((c.date || "").slice(0, 10))}</div></div>`;
  }
  return out;
}

/* ============================================================= *
 *  AUTH — Sign in with GitHub (OAuth via the Worker)
 * ============================================================= */
const USER_TOKEN_KEY = "crates_diff_user_token";
const authState = { token: null, user: null };

function notesEnabled() { return !!(window.GH_OAUTH_CLIENT_ID && window.NOTES_REPO && (window.GH_PROXY || "").trim()); }
function getUserToken() { try { return localStorage.getItem(USER_TOKEN_KEY) || null; } catch (_) { return null; } }
function setUserToken(t) { try { localStorage.setItem(USER_TOKEN_KEY, t); } catch (_) {} authState.token = t; }
function clearUserToken() { try { localStorage.removeItem(USER_TOKEN_KEY); } catch (_) {} authState.token = null; authState.user = null; }

function login() {
  const cid = window.GH_OAUTH_CLIENT_ID;
  const redirect = location.origin + location.pathname;   // must match the OAuth app's callback URL
  const state = encodeURIComponent(location.hash || "#/");
  location.href = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(cid)}&scope=public_repo&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
}
function logout() { clearUserToken(); renderAuth(); if (parseRoute().name === "compare") loadNotes(); }

// If we came back from GitHub with ?code=..., exchange it for a token via the Worker.
async function handleOAuthCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return;
  const state = params.get("state") || "#/";
  const proxy = (window.GH_PROXY || "").trim().replace(/\/$/, "");
  try {
    const r = await fetch(`${proxy}/oauth/token?code=${encodeURIComponent(code)}`);
    const d = await r.json();
    if (d.access_token) setUserToken(d.access_token);
  } catch (_) {}
  // Drop the ?code=... and restore the route we were on.
  history.replaceState(null, "", location.origin + location.pathname + (decodeURIComponent(state) || "#/"));
}

async function loadUser() {
  authState.token = getUserToken();
  if (!authState.token) { authState.user = null; return; }
  try {
    const r = await fetch(`${GH_API}/user`, { headers: { Authorization: "Bearer " + authState.token, Accept: "application/vnd.github+json" } });
    if (r.status === 401) { clearUserToken(); return; }
    const u = await r.json();
    authState.user = { login: u.login, avatar: u.avatar_url, html_url: u.html_url };
  } catch (_) { authState.user = null; }
}

function renderAuth() {
  const slot = document.getElementById("auth-slot");
  if (!slot) return;
  if (!notesEnabled()) { slot.innerHTML = ""; return; }
  if (authState.user) {
    slot.innerHTML = `<span class="auth-user"><img src="${esc(authState.user.avatar)}" alt="" width="20" height="20"><span>${esc(authState.user.login)}</span><a href="#" id="logout">sign out</a></span>`;
    const lo = document.getElementById("logout");
    if (lo) lo.onclick = (e) => { e.preventDefault(); logout(); };
  } else {
    slot.innerHTML = `<a href="#" id="login" class="signin">Sign in with GitHub</a>`;
    const li = document.getElementById("login");
    if (li) li.onclick = (e) => { e.preventDefault(); login(); };
  }
}

// GitHub API call for notes. Uses the visitor's token when signed in (needed for
// writes, and raises read limits); reads work unauthenticated on a public repo too.
async function notesApi(path, opts = {}) {
  const headers = Object.assign({ Accept: "application/vnd.github+json" }, opts.headers || {});
  if (authState.token) headers.Authorization = "Bearer " + authState.token;
  if (opts.body) headers["Content-Type"] = "application/json";
  const r = await fetch(`${GH_API}${path}`, { method: opts.method || "GET", headers, body: opts.body });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error((data && data.message) || `HTTP ${r.status}`);
  return data;
}

/* ============================================================= *
 *  ISSUE-BACKED NOTES (shared, attributed)
 *  crate note   -> issue titled  crate:<name>
 *  transition   -> issue titled  diff:<name>@<from>..<to>
 *  each note is a comment on that issue.
 * ============================================================= */
const issueMap = new Map(); // key -> issue number (session cache)

async function findIssueNumber(key) {
  if (issueMap.has(key)) return issueMap.get(key);
  const q = encodeURIComponent(`repo:${window.NOTES_REPO} in:title "${key}"`);
  const res = await notesApi(`/search/issues?q=${q}&per_page=20`);
  const hit = (res.items || []).find((i) => i.title === key);
  const num = hit ? hit.number : null;
  if (num != null) issueMap.set(key, num);
  return num;
}
async function ensureIssue(key) {
  let num = await findIssueNumber(key);
  if (num != null) return num;
  const created = await notesApi(`/repos/${window.NOTES_REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: key, body: `Notes thread for \`${key}\`, managed by crates_diff.`, labels: ["note"] }),
  });
  issueMap.set(key, created.number);
  return created.number;
}
async function loadComments(key) {
  const num = await findIssueNumber(key);
  if (num == null) return [];
  const arr = await notesApi(`/repos/${window.NOTES_REPO}/issues/${num}/comments?per_page=100`);
  return (arr || []).map((c) => ({ id: c.id, body: c.body, login: c.user && c.user.login, avatar: c.user && c.user.avatar_url, url: c.html_url, date: c.created_at }));
}
async function postComment(key, text) {
  const num = await ensureIssue(key);
  await notesApi(`/repos/${window.NOTES_REPO}/issues/${num}/comments`, { method: "POST", body: JSON.stringify({ body: text }) });
}

function relDate(iso) {
  const d = new Date(iso); if (isNaN(d)) return "";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 2592000) return Math.floor(s / 86400) + "d ago";
  return d.toISOString().slice(0, 10);
}
function noteText(body) { return esc(body).replace(/\n/g, "<br>"); }

function threadHtml(id, label, key) {
  return `<div class="thread" data-key="${esc(key)}" id="${id}">
    <div class="thread-title">${label}</div>
    <div class="thread-list"><div class="spinner">loading notes…</div></div>
    <div class="composer"></div>
  </div>`;
}

async function renderThread(id, key) {
  const root = document.getElementById(id);
  if (!root) return;
  const list = $(".thread-list", root), composer = $(".composer", root);
  // composer
  if (!authState.token) {
    composer.innerHTML = `<button class="primary" data-act="login">Sign in with GitHub to add a note</button>`;
    const b = $('[data-act="login"]', composer); if (b) b.onclick = login;
  } else {
    composer.innerHTML = `<textarea rows="3" placeholder="add a note…"></textarea><div class="composer-row"><span class="as muted">as <b>${esc(authState.user ? authState.user.login : "you")}</b></span><button class="primary" data-act="post">Post note</button></div><div class="composer-status muted"></div>`;
    const btn = $('[data-act="post"]', composer), ta = $("textarea", composer), st = $(".composer-status", composer);
    btn.onclick = async () => {
      const text = ta.value.trim(); if (!text) return;
      btn.disabled = true; st.textContent = "posting…";
      try { await postComment(key, text); ta.value = ""; st.textContent = ""; await renderThread(id, key); }
      catch (e) { st.textContent = "error: " + e.message; btn.disabled = false; }
    };
  }
  // list
  try {
    const notes = await loadComments(key);
    if (!notes.length) { list.innerHTML = '<div class="muted" style="font-size:13px">No notes yet.</div>'; return; }
    list.innerHTML = notes.map((n) => `<div class="note">
      <img class="note-av" src="${esc(n.avatar)}" alt="" width="24" height="24">
      <div class="note-main">
        <div class="note-head"><a href="https://github.com/${esc(n.login)}" target="_blank" rel="noopener"><b>${esc(n.login)}</b></a> <a href="${esc(n.url)}" target="_blank" rel="noopener" class="muted">${esc(relDate(n.date))}</a></div>
        <div class="note-body">${noteText(n.body)}</div>
      </div></div>`).join("");
  } catch (e) {
    list.innerHTML = `<div class="empty">couldn't load notes: ${esc(e.message)}</div>`;
  }
}

function renderIssueNotes() {
  const crateKey = `crate:${cmp.crate}`;
  const transKey = `diff:${cmp.crate}@${cmp.from}..${cmp.to}`;
  setPane("notes", `<div class="notes-wrap">
    ${threadHtml("thread-crate", `Notes on <b>${esc(cmp.crate)}</b>`, crateKey)}
    ${threadHtml("thread-trans", `Notes on <b>${esc(cmp.from)} → ${esc(cmp.to)}</b>`, transKey)}
    <div class="muted" style="font-size:12px;padding:0 16px 16px">Notes are public GitHub issue comments in <a href="https://github.com/${esc(window.NOTES_REPO)}" target="_blank" rel="noopener">${esc(window.NOTES_REPO)}</a>.</div>
  </div>`);
  renderThread("thread-crate", crateKey);
  renderThread("thread-trans", transKey);
}

/* ---------------- notes dispatcher ---------------- */
function loadNotes() {
  if (notesEnabled()) return renderIssueNotes();
  return renderLocalNotes();
}

/* ---------------- notes (localStorage fallback) ---------------- */
const NOTES_KEY = "crates_diff_notes";
let noteTimer = null;
function readNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}") || {}; } catch (_) { return {}; } }
function writeNotes(o) { try { localStorage.setItem(NOTES_KEY, JSON.stringify(o)); return true; } catch (_) { return false; } }
function renderLocalNotes() {
  const notes = readNotes();
  const crateKey = cmp.crate, transKey = `${cmp.crate}@${cmp.from}..${cmp.to}`;
  let html = `<div class="note-block">`;
  html += `<label>Crate note — <b>${esc(cmp.crate)}</b></label>`;
  html += `<textarea id="note-crate" rows="5" placeholder="general notes about this crate…">${esc(notes[crateKey] || "")}</textarea>`;
  html += `<div class="note-status" id="status-crate"></div>`;
  html += `<label>Transition note — <b>${esc(cmp.from)} → ${esc(cmp.to)}</b></label>`;
  html += `<textarea id="note-trans" rows="6" placeholder="notes about what changed between these versions…">${esc(notes[transKey] || "")}</textarea>`;
  html += `<div class="note-status" id="status-trans"></div>`;
  html += `<div class="muted" style="font-size:12px;margin-top:8px">Notes are saved in this browser only (localStorage).</div></div>`;
  setPane("notes", html);
  wireNote("note-crate", crateKey, "status-crate");
  wireNote("note-trans", transKey, "status-trans");
}
function wireNote(id, key, statusId) {
  const ta = document.getElementById(id); if (!ta) return;
  ta.addEventListener("input", () => {
    const s = document.getElementById(statusId); if (s) s.textContent = "saving…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(key, ta.value, statusId), 400);
  });
}
function saveNote(key, text, statusId) {
  const notes = readNotes();
  if (text) notes[key] = text; else delete notes[key];
  const ok = writeNotes(notes);
  const s = document.getElementById(statusId);
  if (s) { s.textContent = ok ? "saved ✓" : "save failed"; if (ok) setTimeout(() => (s.textContent = ""), 1500); }
}

/* ============================================================= *
 *  ABOUT
 * ============================================================= */
function renderAbout() {
  view().innerHTML = `<div class="results">
    <a class="back" href="#/">← home</a>
    <h2>About</h2>
    <p class="muted" style="line-height:1.6">
      <b>crates_diff</b> shows full-source diffs between any two versions of a Rust crate —
      every file, not just what a changelog mentions. It runs entirely in your browser:
      crate tarballs are downloaded straight from <span class="mono">static.crates.io</span>,
      then unpacked and diffed locally. The GitHub tab pulls commit history for the transition,
      and notes are saved in this browser only.
    </p>
    <p class="muted">Source: <a href="https://github.com/muhammad-hassnain/crates-diff" target="_blank" rel="noopener">github.com/muhammad-hassnain/crates-diff</a></p>
  </div>`;
}

/* ---------------- boot ---------------- */
async function boot() {
  await handleOAuthCallback();   // turns ?code=... into a stored token, restores the hash
  await loadUser();              // resolves the signed-in identity (if any)
  renderAuth();
  window.addEventListener("hashchange", route);
  route();
}
boot();
