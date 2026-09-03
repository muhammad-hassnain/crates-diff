"use strict";

/*
 * crates_diff — fully client-side.
 *
 * Everything the Rust backend used to do runs in the browser now:
 *   - crate search / version list / repo metadata  -> crates.io REST API (CORS *)
 *   - whole-crate diff                             -> download the .crate tarball
 *                                                     from static.crates.io (CORS *),
 *                                                     gunzip + untar + Myers diff here
 *   - GitHub commit history                        -> api.github.com compare API (CORS *)
 *   - notes                                        -> localStorage (was server disk)
 *
 * No server, no build step. Suitable for GitHub Pages / any static host.
 */

const CRATES_API = "https://crates.io/api/v1";
const STATIC = "https://static.crates.io/crates";
const GH_API = "https://api.github.com";

const state = {
  crate: null,
  versions: [],
  from: null,
  to: null,
  files: [],       // FileEntry[] for the current transition
  path: null,
  githubLoaded: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ============================================================= *
 *  crates.io + GitHub HTTP
 * ============================================================= */

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j && j.errors && j.errors[0] && j.errors[0].detail) msg = j.errors[0].detail;
    } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

function githubToken() {
  try {
    return (localStorage.getItem("crates_diff_gh_token") || "").trim() || null;
  } catch (_) {
    return null;
  }
}

async function githubGet(url) {
  const headers = { Accept: "application/vnd.github+json" };
  const tok = githubToken();
  if (tok) headers.Authorization = "Bearer " + tok;
  const r = await fetch(url, { headers });
  const body = await r.text();
  return { code: r.status, body };
}

/* ============================================================= *
 *  semver (enough of it): compare + parse, for sorting + intermediates
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
  if (a.pre === null) return 1;   // a release outranks a prerelease
  if (b.pre === null) return -1;
  const ai = a.pre.split("."), bi = b.pre.split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (i >= ai.length) return -1;
    if (i >= bi.length) return 1;
    const x = ai[i], y = bi[i];
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (xn) return -1;
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Newest -> oldest. Valid semver compares numerically; unparseable falls back to
// reverse string order (mirrors the old Rust sort_versions_desc).
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
 *  tarball: fetch .crate -> gunzip -> untar -> {path: text}
 * ============================================================= */

const filesCache = new Map(); // "name@ver" -> Map(path -> text)

async function gunzip(arrayBuffer) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("this browser lacks DecompressionStream (needed to unpack crates)");
  }
  const ds = new DecompressionStream("gzip");
  const stream = new Response(arrayBuffer).body.pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

function readCStr(bytes, off, len) {
  let end = off;
  const max = off + len;
  while (end < max && bytes[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(bytes.subarray(off, end));
}

function parseOctal(str) {
  const s = str.replace(/[^0-7]/g, "");
  return s ? parseInt(s, 8) : 0;
}

// Minimal tar reader: ustar name+prefix, GNU 'L' long names, and pax 'x' path records.
function untar(bytes) {
  const out = [];
  let off = 0;
  let override = null; // long/pax path for the next file entry
  const dec = new TextDecoder("utf-8");
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) if (block[i] !== 0) { allZero = false; break; }
    if (allZero) break;

    const name = readCStr(bytes, off, 100);
    const size = parseOctal(readCStr(bytes, off + 124, 12));
    const type = String.fromCharCode(bytes[off + 156]);
    const prefix = readCStr(bytes, off + 345, 155);
    const dataStart = off + 512;

    if (type === "L") {
      override = dec.decode(bytes.subarray(dataStart, dataStart + size)).replace(/\0+$/, "");
    } else if (type === "x") {
      const hdr = dec.decode(bytes.subarray(dataStart, dataStart + size));
      const m = /\d+ path=([^\n]*)\n/.exec(hdr);
      if (m) override = m[1];
    } else if (type === "0" || type === "\0" || type === "") {
      let full;
      if (override != null) { full = override; override = null; }
      else if (prefix) full = prefix + "/" + name;
      else full = name;
      out.push({ name: full, data: bytes.subarray(dataStart, dataStart + size) });
    } else {
      // directories, symlinks, etc. — the pax/gnu override only applies to a file
      if (type !== "g") override = null;
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

function stripFirstComponent(p) {
  const i = p.indexOf("/");
  return i < 0 ? "" : p.slice(i + 1);
}

function looksBinary(data) {
  const n = Math.min(8000, data.length);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

function normEol(s) {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function extractTarball(raw) {
  const files = new Map();
  const dec = new TextDecoder("utf-8");
  for (const f of untar(raw)) {
    const rel = stripFirstComponent(f.name);
    if (!rel) continue;
    if (looksBinary(f.data)) continue;
    files.set(rel, normEol(dec.decode(f.data)));
  }
  return files;
}

async function getVersionFiles(name, ver) {
  const key = name + "@" + ver;
  if (filesCache.has(key)) return filesCache.get(key);
  const url = `${STATIC}/${name}/${name}-${ver}.crate`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`couldn't download ${name} ${ver} (HTTP ${r.status})`);
  const buf = await r.arrayBuffer();
  const raw = await gunzip(buf);
  const map = extractTarball(raw);
  filesCache.set(key, map);
  return map;
}

/* ============================================================= *
 *  line diff (Myers) — ports the similar::TextDiff behaviour
 * ============================================================= */

// Rust str::lines(): split on '\n', trailing newline does not yield an empty line.
function rustLines(s) {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Greedy Myers on two line arrays -> ops [{tag:'eq'|'add'|'del', o, n}] (0-based).
function myers(a, b) {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const off = max;
  let v = new Int32Array(2 * max + 1);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ tag: "eq", o: x - 1, n: y - 1 }); x--; y--; }
    if (d > 0) {
      if (x === prevX) { ops.push({ tag: "add", o: null, n: y - 1 }); y--; }
      else { ops.push({ tag: "del", o: x - 1, n: null }); x--; }
    }
  }
  ops.reverse();
  return ops;
}

// Full alignment of two line arrays. Trims common prefix/suffix (keeps Myers input
// small); falls back to a plain replace for pathologically large, dissimilar files.
function diffLines(a, b) {
  const n = a.length, m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ tag: "eq", o: i, n: i });

  const aMid = a.slice(pre, n - suf), bMid = b.slice(pre, m - suf);
  let mid;
  if (aMid.length + bMid.length === 0) {
    mid = [];
  } else if (aMid.length > 2500 || bMid.length > 2500 || aMid.length + bMid.length > 3000) {
    mid = [];
    for (let i = 0; i < aMid.length; i++) mid.push({ tag: "del", o: i, n: null });
    for (let j = 0; j < bMid.length; j++) mid.push({ tag: "add", o: null, n: j });
  } else {
    mid = myers(aMid, bMid);
  }
  for (const op of mid) {
    ops.push({ tag: op.tag, o: op.o == null ? null : op.o + pre, n: op.n == null ? null : op.n + pre });
  }
  for (let i = 0; i < suf; i++) ops.push({ tag: "eq", o: n - suf + i, n: m - suf + i });
  return ops;
}

function countChanges(a, b) {
  let added = 0, removed = 0;
  for (const op of diffLines(rustLines(a), rustLines(b))) {
    if (op.tag === "add") added++;
    else if (op.tag === "del") removed++;
  }
  return [added, removed];
}

// Group an alignment into unified-diff hunks with 3 lines of context.
function buildHunks(ops, aLines, bLines) {
  const context = 3;
  const changed = [];
  ops.forEach((op, i) => { if (op.tag !== "eq") changed.push(i); });
  if (!changed.length) return [];

  const groups = [];
  let start = changed[0], prev = changed[0];
  for (let i = 1; i < changed.length; i++) {
    if (changed[i] - prev > context * 2) { groups.push([start, prev]); start = changed[i]; }
    prev = changed[i];
  }
  groups.push([start, prev]);

  const hunks = [];
  for (const [gs, ge] of groups) {
    const s = Math.max(0, gs - context);
    const e = Math.min(ops.length - 1, ge + context);
    const lines = [];
    let oldStart = Infinity, newStart = Infinity, oldLen = 0, newLen = 0;
    for (let i = s; i <= e; i++) {
      const op = ops[i];
      const old = op.o == null ? null : op.o + 1;
      const nw = op.n == null ? null : op.n + 1;
      if (old != null) { oldStart = Math.min(oldStart, old); oldLen++; }
      if (nw != null) { newStart = Math.min(newStart, nw); newLen++; }
      const text = op.o != null ? aLines[op.o] : bLines[op.n];
      lines.push({ tag: op.tag, old, new: nw, text });
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

/* ============================================================= *
 *  the three "endpoints", now local
 * ============================================================= */

function computeFileList(aMap, bMap, from, to) {
  const paths = new Set([...aMap.keys(), ...bMap.keys()]);
  const files = [];
  let changed = 0;
  for (const path of paths) {
    const hasA = aMap.has(path), hasB = bMap.has(path);
    const ta = aMap.get(path) ?? "", tb = bMap.get(path) ?? "";
    const status = statusOf(hasA, hasB, ta, tb);
    let added = 0, removed = 0;
    if (status !== "unchanged") { [added, removed] = countChanges(ta, tb); changed++; }
    files.push({ path, status, added, removed });
  }
  files.sort((x, y) => {
    const xc = x.status !== "unchanged" ? 1 : 0;
    const yc = y.status !== "unchanged" ? 1 : 0;
    if (yc !== xc) return yc - xc;
    const churn = (y.added + y.removed) - (x.added + x.removed);
    if (churn !== 0) return churn;
    return x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
  });
  return { from, to, files, changed, total: files.length };
}

function computeFileDiff(aMap, bMap, path) {
  const hasA = aMap.has(path), hasB = bMap.has(path);
  if (!hasA && !hasB) return null;
  const ta = aMap.get(path) ?? "", tb = bMap.get(path) ?? "";
  const status = statusOf(hasA, hasB, ta, tb);

  if (ta === tb) {
    const arr = rustLines(ta);
    const lines = arr.map((l, i) => ({ tag: "eq", old: i + 1, new: i + 1, text: l }));
    const n = lines.length;
    const hunks = n === 0 ? [] : [{ header: `@@ -1,${n} +1,${n} @@`, lines }];
    return { path, status, hunks };
  }
  const aLines = rustLines(ta), bLines = rustLines(tb);
  const hunks = buildHunks(diffLines(aLines, bLines), aLines, bLines);
  return { path, status, hunks };
}

function computeContentSearch(aMap, bMap, query) {
  const q = query.trim();
  if (!q) return [];
  const ql = q.toLowerCase();
  const paths = new Set([...aMap.keys(), ...bMap.keys()]);
  const hits = [];
  for (const path of paths) {
    let text, side;
    if (bMap.has(path)) { text = bMap.get(path); side = "to"; }
    else if (aMap.has(path)) { text = aMap.get(path); side = "from"; }
    else continue;
    const lines = [];
    const arr = rustLines(text);
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].toLowerCase().includes(ql)) {
        lines.push({ line: i + 1, text: arr[i].replace(/\s+$/, "") });
        if (lines.length >= 12) break;
      }
    }
    if (lines.length) hits.push({ path, side, count: lines.length, lines });
  }
  hits.sort((x, y) => y.count - x.count || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return hits;
}

/* ============================================================= *
 *  GitHub history (compare API)
 * ============================================================= */

function parseGithubRepo(repo) {
  const idx = repo.indexOf("github.com");
  if (idx < 0) return null;
  let rest = repo.slice(idx + "github.com".length).replace(/^[/:]+/, "");
  const parts = rest.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  let name = parts[1];
  if (name.endsWith(".git")) name = name.slice(0, -4);
  return { owner: parts[0], repo: name };
}

async function resolveRepo(name) {
  try {
    const data = await fetchJson(`${CRATES_API}/crates/${encodeURIComponent(name)}`);
    const repo = data && data.crate && data.crate.repository;
    return repo ? parseGithubRepo(repo) : null;
  } catch (_) {
    return null;
  }
}

// Trailing semver out of a tag name (v1.2.3, crate-1.2.3, 1.2.3). Ports norm_tag.
function normTag(tag) {
  const t = tag.trim();
  let best = null, i = 0;
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
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 20; page++) {
    const { code, body } = await githubGet(`${GH_API}/repos/${owner}/${repo}/tags?per_page=100&page=${page}`);
    if (code !== 200) break;
    let arr;
    try { arr = JSON.parse(body); } catch (_) { break; }
    if (!Array.isArray(arr)) break;
    for (const t of arr) {
      const ver = t && t.name ? normTag(t.name) : null;
      if (ver && !seen.has(ver)) { seen.add(ver); out.push([ver, t.name]); }
    }
    if (arr.length < 100) break;
  }
  return out;
}

function intermediateVersions(from, to) {
  const lo0 = parseSemver(from), hi0 = parseSemver(to);
  if (!lo0 || !hi0) return [];
  let lo = lo0, hi = hi0;
  if (cmpSemver(lo, hi) > 0) { lo = hi0; hi = lo0; }
  return state.versions
    .map((v) => v.num)
    .filter((num) => {
      const p = parseSemver(num);
      return p && cmpSemver(p, lo) > 0 && cmpSemver(p, hi) < 0;
    })
    .sort((a, b) => cmpSemver(parseSemver(a), parseSemver(b)))
    ;
}

async function githubHistory(name, from, to) {
  const rr = await resolveRepo(name);
  if (!rr) {
    return { available: false, message: "No GitHub repository is declared for this crate on crates.io." };
  }
  const { owner, repo } = rr;
  const repo_url = `https://github.com/${owner}/${repo}`;
  const intermediate = intermediateVersions(from, to);

  let tags;
  try {
    tags = await versionTags(owner, repo);
  } catch (e) {
    return { available: false, message: "Couldn't list git tags: " + e.message, repo_url };
  }
  const find = (ver) => { const t = tags.find(([v]) => v === ver); return t ? t[1] : null; };
  const fromTag = find(from), toTag = find(to);

  if (!fromTag || !toTag) {
    return {
      available: false,
      message: "Couldn't match both versions to git tags in this repo (some crates don't tag every release).",
      repo_url, from_tag: fromTag, to_tag: toTag, intermediate_versions: intermediate,
    };
  }

  const { code, body } = await githubGet(`${GH_API}/repos/${owner}/${repo}/compare/${fromTag}...${toTag}`);
  if (code !== 200) {
    return {
      available: false,
      message: `GitHub compare returned HTTP ${code}` + (code === 403 ? " (rate limited — add a token in the header)" : "") + ".",
      repo_url, from_tag: fromTag, to_tag: toTag, intermediate_versions: intermediate,
    };
  }
  let v;
  try { v = JSON.parse(body); } catch (_) { v = {}; }

  const commits = (v.commits || []).map((c) => {
    const commit = c.commit || {};
    const message = commit.message || "";
    return {
      short: (c.sha || "").slice(0, 7),
      summary: message.split("\n")[0] || "",
      author: (commit.author && commit.author.name) || "",
      date: (commit.author && commit.author.date) || "",
      url: c.html_url || "",
    };
  });

  return {
    available: true,
    repo_url,
    compare_url: v.html_url || null,
    from_tag: fromTag,
    to_tag: toTag,
    intermediate_versions: intermediate,
    commits,
  };
}

/* ============================================================= *
 *  crate search
 * ============================================================= */

$("#crate-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchCrates();
});

async function searchCrates() {
  const q = $("#crate-search").value.trim();
  if (!q) return;
  const box = $("#crate-results");
  box.innerHTML = '<div class="spinner">searching…</div>';
  try {
    const { crates } = await fetchJson(`${CRATES_API}/crates?q=${encodeURIComponent(q)}&per_page=20&sort=downloads`);
    box.innerHTML = "";
    if (!crates || !crates.length) {
      box.innerHTML = '<div class="empty">no matches</div>';
      return;
    }
    for (const c of crates) {
      const row = el("div", "crate-hit");
      row.innerHTML =
        `<div class="name">${esc(c.name)}</div>` +
        `<div class="meta">v${esc(c.max_version)} · ${(c.downloads || 0).toLocaleString()} downloads</div>` +
        `<div class="desc">${esc(c.description || "")}</div>`;
      row.onclick = () => loadCrate(c.name);
      box.appendChild(row);
    }
  } catch (err) {
    box.innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

/* ---------------- load a crate + versions ---------------- */

async function loadCrate(name) {
  state.crate = name;
  state.path = null;
  $("#crate-selected").innerHTML = `<div class="spinner">loading ${esc(name)} versions…</div>`;
  $("#version-pickers").style.display = "none";
  try {
    const data = await fetchJson(`${CRATES_API}/crates/${encodeURIComponent(name)}/versions`);
    const versions = (data.versions || [])
      .filter((v) => v.num)
      .map((v) => ({ num: v.num, yanked: !!v.yanked, source: "crates.io" }));
    sortVersionsDesc(versions);
    state.versions = versions;

    $("#crate-selected").innerHTML =
      `<div class="name" style="font-weight:600">${esc(name)}</div>` +
      `<div class="muted" style="font-size:12px">${versions.length} version(s)</div>`;

    const fromSel = $("#ver-from");
    const toSel = $("#ver-to");
    fromSel.innerHTML = "";
    toSel.innerHTML = "";
    versions.forEach((v) => {
      const label = v.num + (v.yanked ? "  (yanked)" : "");
      fromSel.appendChild(new Option(label, v.num));
      toSel.appendChild(new Option(label, v.num));
    });
    if (versions.length >= 2) {
      toSel.selectedIndex = 0;
      fromSel.selectedIndex = 1;
    }
    $("#version-pickers").style.display = "block";
    loadNotes();
    if (versions.length >= 2) compare();
  } catch (err) {
    $("#crate-selected").innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

$("#load-diff").addEventListener("click", compare);

$("#swap-versions").addEventListener("click", () => {
  const f = $("#ver-from"), t = $("#ver-to");
  if (!f.value && !t.value) return;
  [f.value, t.value] = [t.value, f.value];
  compare();
});

/* ---------------- compare two versions ---------------- */

async function compare() {
  const from = $("#ver-from").value;
  const to = $("#ver-to").value;
  if (!from || !to) return;
  state.from = from;
  state.to = to;
  state.path = null;
  state.githubLoaded = null;
  $("#file-list").innerHTML = '<div class="spinner">downloading & diffing…</div>';
  $("#file-summary").textContent = "";
  setPane("diff", '<div class="empty">Select a file to view its diff.</div>');
  try {
    const [aMap, bMap] = await Promise.all([
      getVersionFiles(state.crate, from),
      getVersionFiles(state.crate, to),
    ]);
    state.aMap = aMap;
    state.bMap = bMap;
    const data = computeFileList(aMap, bMap, from, to);
    state.files = data.files;
    $("#file-summary").innerHTML =
      `<b>${esc(from)}</b> → <b>${esc(to)}</b> · ${data.changed} changed / ${data.total} files`;
    renderFileList(state.files);
    loadNotes();
    if ($("#pane-github").classList.contains("active")) loadGithub();
  } catch (err) {
    $("#file-list").innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

function renderFileList(files) {
  const list = $("#file-list");
  list.innerHTML = "";
  if (!files.length) {
    list.innerHTML = '<div class="empty">no files</div>';
    return;
  }
  for (const f of files) {
    const row = el("div", "file-row" + (f.status === "unchanged" ? " unchanged" : ""));
    row.dataset.path = f.path;
    let stat = "";
    if (f.status !== "unchanged") {
      stat = `<span class="stat"><span class="a">+${f.added}</span> <span class="d">-${f.removed}</span></span>`;
    }
    let badge = "";
    if (f.status === "added") badge = '<span class="badge added">A</span>';
    else if (f.status === "removed") badge = '<span class="badge removed">D</span>';
    else if (f.status === "modified") badge = '<span class="badge modified">M</span>';
    row.innerHTML = `${badge}<span class="path" title="${esc(f.path)}">${esc(f.path)}</span>${stat}`;
    row.onclick = () => openFile(f.path);
    list.appendChild(row);
  }
}

/* ---------------- open a single file diff ---------------- */

async function openFile(path) {
  state.path = path;
  document.querySelectorAll(".file-row").forEach((r) =>
    r.classList.toggle("active", r.dataset.path === path)
  );
  switchTab("diff");
  setPane("diff", '<div class="spinner">loading diff…</div>');
  try {
    const d = computeFileDiff(state.aMap, state.bMap, path);
    if (!d) { setPane("diff", '<div class="empty">file not found</div>'); return; }
    setPane("diff", renderDiff(d));
  } catch (err) {
    setPane("diff", `<div class="empty">error: ${esc(err.message)}</div>`);
  }
}

function renderDiff(d) {
  const head =
    `<div class="pad"><span class="mono">${esc(d.path)}</span> ` +
    `<span class="badge ${d.status === "unchanged" ? "" : d.status}">${esc(d.status)}</span></div>`;
  if (!d.hunks.length) {
    return head + '<div class="empty">empty file (no content)</div>';
  }
  let out = '<div class="diff">';
  for (const h of d.hunks) {
    out += `<div class="hunk-header">${esc(h.header)}</div>`;
    for (const ln of h.lines) {
      const sign = ln.tag === "add" ? "+" : ln.tag === "del" ? "-" : " ";
      const o = ln.old == null ? "" : ln.old;
      const n = ln.new == null ? "" : ln.new;
      out +=
        `<div class="dline ${ln.tag}">` +
        `<span class="ln">${o}</span><span class="ln">${n}</span>` +
        `<span class="sign">${sign}</span>` +
        `<span class="tx">${esc(ln.text) || "&nbsp;"}</span></div>`;
    }
  }
  out += "</div>";
  return head + out;
}

/* ---------------- content search ---------------- */

$("#content-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") contentSearch();
});

async function contentSearch() {
  const q = $("#content-search").value.trim();
  if (!state.crate || !state.from) return;
  if (!q) {
    renderFileList(state.files);
    $("#file-summary").innerHTML =
      `<b>${esc(state.from)}</b> → <b>${esc(state.to)}</b> · ${state.files.length} files`;
    return;
  }
  $("#file-list").innerHTML = '<div class="spinner">searching file contents…</div>';
  try {
    const results = computeContentSearch(state.aMap, state.bMap, q);
    $("#file-summary").innerHTML = `${results.length} file(s) contain <b>${esc(q)}</b>`;
    const list = $("#file-list");
    list.innerHTML = "";
    if (!results.length) {
      list.innerHTML = '<div class="empty">no matches</div>';
      return;
    }
    const ql = q.toLowerCase();
    for (const r of results) {
      const row = el("div", "file-row");
      row.innerHTML =
        `<span class="path" title="${esc(r.path)}">${esc(r.path)}</span>` +
        `<span class="stat">${r.count}×</span>`;
      row.onclick = () => openFile(r.path);
      list.appendChild(row);
      for (const m of r.lines.slice(0, 4)) {
        const hl = esc(m.text).replace(
          new RegExp("(" + ql.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"),
          "<b>$1</b>"
        );
        const mline = el("div", "match-line", `${m.line}: ${hl}`);
        mline.onclick = () => openFile(r.path);
        list.appendChild(mline);
      }
    }
  } catch (err) {
    $("#file-list").innerHTML = `<div class="empty">error: ${esc(err.message)}</div>`;
  }
}

/* ---------------- tabs ---------------- */

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) =>
    p.classList.toggle("active", p.id === "pane-" + name)
  );
  if (name === "github" && state.crate && state.from && state.githubLoaded !== state.from + ".." + state.to) {
    loadGithub();
  }
}

function setPane(name, html) {
  $("#pane-" + name).innerHTML = html;
}

/* ---------------- github ---------------- */

async function loadGithub() {
  if (!state.crate || !state.from || !state.to) return;
  state.githubLoaded = state.from + ".." + state.to;
  setPane("github", '<div class="spinner">fetching commit history…</div>');
  try {
    const g = await githubHistory(state.crate, state.from, state.to);
    setPane("github", renderGithub(g));
  } catch (err) {
    setPane("github", `<div class="empty">error: ${esc(err.message)}</div>`);
  }
}

function renderGithub(g) {
  let head = "";
  if (g.repo_url) {
    head += `<div class="pad"><a href="${esc(g.repo_url)}" target="_blank" rel="noopener">${esc(g.repo_url)}</a>`;
    if (g.compare_url) head += ` · <a href="${esc(g.compare_url)}" target="_blank" rel="noopener">compare on GitHub ↗</a>`;
    head += "</div>";
  }
  if (g.intermediate_versions && g.intermediate_versions.length) {
    head += '<div class="pad muted" style="font-size:12px">intermediate releases: ' +
      g.intermediate_versions.map((v) => `<span class="pill">${esc(v)}</span>`).join("") + "</div>";
  }
  if (!g.available) {
    return head + `<div class="empty">${esc(g.message || "no GitHub data")}</div>`;
  }
  if (!g.commits.length) {
    return head + '<div class="empty">no commits between these tags</div>';
  }
  let out = head + `<div class="pad muted" style="font-size:12px">${g.commits.length} commit(s) · tags ${esc(g.from_tag)} → ${esc(g.to_tag)}</div>`;
  for (const c of g.commits) {
    out +=
      `<div class="commit">` +
      `<div class="summary">${esc(c.summary)}</div>` +
      `<div class="meta">` +
      `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="mono">${esc(c.short)}</a> · ` +
      `${esc(c.author || "?")} · ${esc((c.date || "").slice(0, 10))}</div>` +
      `</div>`;
  }
  return out;
}

/* ---------------- notes (localStorage) ---------------- */

const NOTES_KEY = "crates_diff_notes";
let noteTimer = null;

function readNotes() {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}") || {};
  } catch (_) {
    return {};
  }
}
function writeNotes(obj) {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(obj));
    return true;
  } catch (_) {
    return false;
  }
}

function loadNotes() {
  if (!state.crate) return;
  const notes = readNotes();
  const crateKey = state.crate;
  const transKey = state.from && state.to ? `${state.crate}@${state.from}..${state.to}` : null;

  let html = `<div class="note-block">`;
  html += `<label>Crate note — <b>${esc(state.crate)}</b></label>`;
  html += `<textarea id="note-crate" rows="5" placeholder="general notes about this crate…">${esc(notes[crateKey] || "")}</textarea>`;
  html += `<div class="note-status" id="status-crate"></div>`;
  if (transKey) {
    html += `<label>Transition note — <b>${esc(state.from)} → ${esc(state.to)}</b></label>`;
    html += `<textarea id="note-trans" rows="6" placeholder="notes about what changed between these versions…">${esc(notes[transKey] || "")}</textarea>`;
    html += `<div class="note-status" id="status-trans"></div>`;
  }
  html += `<div class="muted" style="font-size:11px;margin-top:10px">Notes are saved in this browser only (localStorage).</div>`;
  html += `</div>`;
  setPane("notes", html);

  wireNote("note-crate", crateKey, "status-crate");
  if (transKey) wireNote("note-trans", transKey, "status-trans");
}

function wireNote(id, key, statusId) {
  const ta = document.getElementById(id);
  if (!ta) return;
  ta.addEventListener("input", () => {
    document.getElementById(statusId).textContent = "saving…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(key, ta.value, statusId), 400);
  });
}

function saveNote(key, text, statusId) {
  const notes = readNotes();
  if (text) notes[key] = text; else delete notes[key];
  const ok = writeNotes(notes);
  const s = document.getElementById(statusId);
  if (s) {
    s.textContent = ok ? "saved ✓" : "save failed";
    if (ok) setTimeout(() => (s.textContent = ""), 1500);
  }
}

/* ---------------- github token field ---------------- */

(function initToken() {
  const input = $("#gh-token");
  if (!input) return;
  try { input.value = localStorage.getItem("crates_diff_gh_token") || ""; } catch (_) {}
  input.addEventListener("input", () => {
    try { localStorage.setItem("crates_diff_gh_token", input.value.trim()); } catch (_) {}
  });
})();
