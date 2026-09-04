# crates_diff

A small, self-contained tool for browsing **full-source diffs between any
two versions of a Rust crate**

**Live:** <https://muhammad-hassnain.github.io/crates-diff/> — a fully
client-side, [diff.rs](https://diff.rs)-style single-page app (in `docs/`) that runs the
whole thing in the browser: a landing page (search + New / Most Downloaded / Just Updated
from the crates.io summary API) leads into a version diff view that fetches crate tarballs
straight from `static.crates.io`.

**Local**
You can also use this locally (as an in-house auditing tools for Rust crate diffs):

It has:

- **Crate search** against crates.io.
- **Full version list** (published + locally-imported builds), newest first.
- **Whole-crate diff**: every file's status (added/removed/modified/unchanged)
  with per-file line counts, and a full unified diff for any file.
- **Content search** across a version transition (jump to matching lines).
- **GitHub history**: commits between the two versions' tags.
- **Notes** per crate and per version-transition  
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

You can also use this to diff against unpublished versions:

```bash
./target/release/crates_diff add-local <crate> <version> <path-to-source-dir>

# example: if you have a crate named `hello` with version `0.3.10` sitting on your Desktop
./target/release/crates_diff add-local hello 0.3.10 ~/Desktop/hello-0.3.10
```

Imported versions live under `data/local/<crate>/<version>/`.

## GitHub token (optional)

It also fetches GitHub commits between two selected versions. By default, the API 
allows 60 requests/hour, if you want to increase this, please use a Github Access token.  
You can Generate a GitHub personal access token from [token page](https://github.com/settings/tokens/new). Please select Generate new token (classic). Then, name your token, select an expiration date, and grant the token at least the `public_repo` scope by checking the box.

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
tarball unpack (gzip + tar) and the line diff (Myers) run in JavaScript, and notes are pushed to a seperate github repo as issues`. 
It's a hash-routed SPA — `#/` landing, `#/search/<q>`,
`#/<crate>/<from>/<to>` for a diff (deep-linkable). 
The deployed UI does not Local/unpublished crates for that, use the Rust binary.

## `worker/` — Cloudflare Worker backend

A small Worker (all secrets stay server-side) that adds two things when deployed:

- **Sign in with GitHub → shared notes.** The Notes tab can store notes as issue
  comments in a notes repo (`muhammad-hassnain/crates-diff-notes`), posted *as the
  signed-in visitor* — the giscus/utterances model. The Worker holds the OAuth client
  secret and does the `code → token` exchange.
- **History-tab proxy.** Holds a GitHub token so the History tab isn't capped at 60
  requests/hour.

Both are optional: leave the values in `docs/config.js` empty and the site still works —
History falls back to unauthenticated GitHub, and Notes fall back to per-browser
`localStorage` (no login). See [`worker/README.md`](worker/README.md) for the one-time
setup (OAuth app + deploy + secrets + config).
