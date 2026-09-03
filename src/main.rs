//! crates_diff — browse full-source diffs between any two versions of a Rust
//! crate (no semver restriction), with content search, GitHub history, notes,
//! and support for locally-imported (unpublished) versions.

mod crates_io;
mod diffing;
mod github;
mod notes;
mod server;
mod store;
mod util;

use std::path::PathBuf;
use std::sync::Arc;

use store::Ctx;

fn root_dir() -> PathBuf {
    if let Ok(r) = std::env::var("CRATES_DIFF_ROOT") {
        return PathBuf::from(r);
    }
    // Default to the crate's own directory so `web/` and `data/` resolve no
    // matter where the binary is invoked from.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ctx = Arc::new(Ctx::new(root_dir()));

    match args.first().map(String::as_str) {
        None | Some("serve") => {
            let mut host = "127.0.0.1".to_string();
            let mut port = "7000".to_string();
            let rest = if args.first().map(String::as_str) == Some("serve") {
                &args[1..]
            } else {
                &args[..]
            };
            let mut i = 0;
            while i < rest.len() {
                match rest[i].as_str() {
                    "--port" | "-p" => {
                        if let Some(v) = rest.get(i + 1) {
                            port = v.clone();
                            i += 1;
                        }
                    }
                    "--host" => {
                        if let Some(v) = rest.get(i + 1) {
                            host = v.clone();
                            i += 1;
                        }
                    }
                    other => eprintln!("ignoring unknown arg: {other}"),
                }
                i += 1;
            }
            server::serve(ctx, &format!("{host}:{port}"), 6);
        }
        Some("add-local") => {
            // add-local <crate> <version> <path>
            let (Some(name), Some(ver), Some(path)) =
                (args.get(1), args.get(2), args.get(3))
            else {
                eprintln!("usage: crates_diff add-local <crate> <version> <path-to-source-dir>");
                std::process::exit(2);
            };
            match ctx.import_local(name, ver, &PathBuf::from(path)) {
                Ok(n) => println!(
                    "imported {n} file(s) as local version {name} {ver}\n\
                     it will appear in the version list next to the published versions."
                ),
                Err(e) => {
                    eprintln!("import failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        Some("-h") | Some("--help") | Some("help") => print_help(),
        Some(other) => {
            eprintln!("unknown command: {other}\n");
            print_help();
            std::process::exit(2);
        }
    }
}

fn print_help() {
    println!(
        "crates_diff — full-source diff viewer for Rust crates\n\
\n\
USAGE:\n\
  crates_diff [serve] [--host H] [--port N]     start the web viewer (default 127.0.0.1:7000)\n\
  crates_diff add-local <crate> <ver> <path>    import an unpublished crate source tree\n\
  crates_diff --help\n\
\n\
NOTES:\n\
  * A GitHub token (data-root .github_token file or GITHUB_TOKEN env) lifts the\n\
    GitHub API rate limit for the history tab.\n\
  * Imported local versions live under data/local/<crate>/<ver>/ and are listed\n\
    alongside published versions, sorted by semver."
    );
}
