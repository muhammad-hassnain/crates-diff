# crates_diff

A small, self-contained Rust tool for browsing **full-source diffs between any
two versions of a Rust crate**
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
web/             zero-build HTML/CSS/JS frontend
data/            created at runtime (caches, notes.json, local/)
```

No database, no npm, no build step for the frontend.
