"use strict";

const state = {
  crate: null,
  versions: [],
  from: null,
  to: null,
  files: [],
  path: null,
  githubLoaded: null, // "from..to" key of last github fetch
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

async function api(path) {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({ error: "bad response" }));
  if (data && data.error) throw new Error(data.error);
  return data;
}

/* ---------------- crate search ---------------- */

$("#crate-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchCrates();
});

async function searchCrates() {
  const q = $("#crate-search").value.trim();
  if (!q) return;
  const box = $("#crate-results");
  box.innerHTML = '<div class="spinner">searching…</div>';
  try {
    const { crates } = await api("/api/search?q=" + encodeURIComponent(q));
    box.innerHTML = "";
    if (!crates.length) {
      box.innerHTML = '<div class="empty">no matches</div>';
      return;
    }
    for (const c of crates) {
      const row = el("div", "crate-hit");
      row.innerHTML =
        `<div class="name">${esc(c.name)}</div>` +
        `<div class="meta">v${esc(c.max_version)} · ${c.downloads.toLocaleString()} downloads</div>` +
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
    const { versions } = await api("/api/versions?crate=" + encodeURIComponent(name));
    state.versions = versions;
    const localCount = versions.filter((v) => v.source === "local").length;
    $("#crate-selected").innerHTML =
      `<div class="name" style="font-weight:600">${esc(name)}</div>` +
      `<div class="muted" style="font-size:12px">${versions.length} version(s)` +
      (localCount ? ` · <span class="badge local">${localCount} local</span>` : "") +
      `</div>`;

    const fromSel = $("#ver-from");
    const toSel = $("#ver-to");
    fromSel.innerHTML = "";
    toSel.innerHTML = "";
    versions.forEach((v) => {
      const label = v.num + (v.source === "local" ? "  (local)" : "") + (v.yanked ? "  (yanked)" : "");
      fromSel.appendChild(new Option(label, v.num));
      toSel.appendChild(new Option(label, v.num));
    });
    // default: newest two (list is newest-first) -> from = older, to = newest
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
    const data = await api(
      `/api/files?crate=${encodeURIComponent(state.crate)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    state.files = data.files;
    $("#file-summary").innerHTML =
      `<b>${esc(from)}</b> → <b>${esc(to)}</b> · ${data.changed} changed / ${data.total} files`;
    renderFileList(state.files);
    loadNotes(); // refresh transition-scoped note
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
    const d = await api(
      `/api/diff?crate=${encodeURIComponent(state.crate)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}&path=${encodeURIComponent(path)}`
    );
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
    const { results } = await api(
      `/api/search-content?crate=${encodeURIComponent(state.crate)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}&q=${encodeURIComponent(q)}`
    );
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
    const g = await api(
      `/api/github?crate=${encodeURIComponent(state.crate)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`
    );
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

/* ---------------- notes ---------------- */

let noteTimer = null;

async function loadNotes() {
  if (!state.crate) return;
  let notes = {};
  try {
    const data = await api("/api/notes?crate=" + encodeURIComponent(state.crate));
    notes = data.notes || {};
  } catch (_) {}

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
    noteTimer = setTimeout(() => saveNote(key, ta.value, statusId), 500);
  });
}

async function saveNote(key, text, statusId) {
  try {
    await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, text }),
    });
    const s = document.getElementById(statusId);
    if (s) {
      s.textContent = "saved ✓";
      setTimeout(() => (s.textContent = ""), 1500);
    }
  } catch (_) {
    const s = document.getElementById(statusId);
    if (s) s.textContent = "save failed";
  }
}
