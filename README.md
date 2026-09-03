# crates_diff

A small, self-contained tool for browsing **full-source diffs between any
two versions of a Rust crate**

**Live (no install):** <https://muhammad-hassnain.github.io/crates-diff/> — a fully
client-side, [diff.rs](https://diff.rs)-style single-page app (in `docs/`) that runs the
whole thing in the browser: a landing page (search + New / Most Downloaded / Just Updated
from the crates.io summary API) leads into a version diff view that fetches crate tarballs
straight from `static.crates.io`, then gunzips, untars, and diffs them locally. No server.
The Rust version below is the original, and is still the way to diff **local/unpublished**
builds.

It has:

- **Crate search** against crates.io.
- **Full version list** (published + locally-imported builds), newest first.
- **Whole-crate diff**: every file's status (added/removed/modified/unchanged)
  with per-file line counts, and a full unified diff for any file.
- **Content search** across a version transition (jump to matching lines).
- **GitHub history**: commits between the two versions' tags.
- **Notes** per crate and per version-transition (free-form, autosaved — no
  audit questions).
- **Local (unpublished) versions**: import a crate source tree so it shows up in
  the version list next to the published versions.

## Build

```bash
cargo build --release
```

## Run the viewer

```bash
./target/release/crates_diff            # serves http://127.0.0.1:7000
# or: cargo run --release
```

Open <http://127.0.0.1:7000>, search a crate, pick two versions, hit **Compare**.

Options: `--host <H>` and `--port <N>`.

## Import an unpublished version

Some builds never hit crates.io (e.g. a newer local checkout). Import the source
tree and it appears in the version list, sorted by semver:

```bash
./target/release/crates_diff add-local <crate> <version> <path-to-source-dir>

# example: the arrayref 0.3.10 build sitting on the Desktop
./target/release/crates_diff add-local arrayref 0.3.10 ~/Desktop/arrayref-0.3.10
```

Imported versions live under `data/local/<crate>/<version>/`.

## GitHub token (optional)

The history tab uses the GitHub API (60 requests/hour unauthenticated). To lift
that, drop a token in a `.github_token` file at the project root, or set
`GITHUB_TOKEN`. Public-repo read access is enough.

## Layout

```
src/
  main.rs        CLI (serve / add-local)
  server.rs      tiny_http server + JSON API
  crates_io.rs   crates.io search / versions / repo resolution
  store.rs       source caching, tarball extraction, local imports, notes store
  diffing.rs     file list, per-file unified diff, content search
  github.rs      commit history via the GitHub compare API
  notes.rs       note persistence
  util.rs        HTTP + query-string helpers
web/             zero-build HTML/CSS/JS frontend (talks to the Rust server)
docs/            fully client-side port (deployed to GitHub Pages) — no backend
data/            created at runtime (caches, notes.json, local/)
```

## The `docs/` client-side build

`docs/` is a standalone rewrite of the frontend that needs no server — it's what's
deployed to GitHub Pages. crates.io, `static.crates.io`, and the GitHub API all send
`Access-Control-Allow-Origin: *`, so the browser can fetch everything directly; the
tarball unpack (gzip + tar) and the line diff (Myers) run in JavaScript, and notes are
kept in `localStorage`. It's a hash-routed SPA — `#/` landing, `#/search/<q>`,
`#/<crate>/<from>/<to>` for a diff (deep-linkable). Local/unpublished imports are the one
thing it can't do — use the Rust binary for those.

## `worker/` — optional GitHub token proxy

The History tab uses the GitHub API, which is capped at 60 requests/hour when
unauthenticated. `worker/` is a small Cloudflare Worker that holds a token as a secret and
proxies those calls server-side, so the token is never exposed in the static site. It's
entirely optional — leave `docs/config.js`'s `GH_PROXY` empty and the site calls GitHub
directly. See [`worker/README.md`](worker/README.md) to deploy it.

No database, no npm, no build step for the frontend.
