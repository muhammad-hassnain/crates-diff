//! tiny_http server: static frontend + JSON API. A small fixed thread pool
//! pulls requests off the shared server so slow tarball fetches don't block the UI.

use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::crates_io;
use crate::diffing;
use crate::github;
use crate::notes;
use crate::store::Ctx;
use crate::util;

pub fn serve(ctx: Arc<Ctx>, addr: &str, workers: usize) {
    let server = Arc::new(match Server::http(addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    });
    println!("crates_diff serving on http://{addr}");
    println!("open that URL in your browser (Ctrl-C to stop)");

    let mut handles = Vec::new();
    for _ in 0..workers.max(1) {
        let server = Arc::clone(&server);
        let ctx = Arc::clone(&ctx);
        handles.push(thread::spawn(move || loop {
            match server.recv() {
                Ok(req) => route(&ctx, req),
                Err(_) => break,
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}

fn route(ctx: &Ctx, mut request: Request) {
    let url = request.url().to_string();
    let path = util::path_only(&url).to_string();
    let method = request.method().clone();

    // --- static frontend ---
    if method == Method::Get {
        match path.as_str() {
            "/" | "/index.html" => return serve_static(request, ctx, "index.html", "text/html; charset=utf-8"),
            "/app.js" => return serve_static(request, ctx, "app.js", "application/javascript; charset=utf-8"),
            "/style.css" => return serve_static(request, ctx, "style.css", "text/css; charset=utf-8"),
            _ => {}
        }
    }

    // --- JSON API ---
    let q = util::parse_query(&url);
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();

    let result: Result<Value, String> = match (&method, path.as_str()) {
        (Method::Get, "/api/search") => {
            crates_io::search(&ctx.agent, &get("q")).map(|hits| json!({ "crates": hits }))
        }
        (Method::Get, "/api/versions") => {
            crates_io::versions(ctx, &get("crate")).map(|vs| json!({ "crate": get("crate"), "versions": vs }))
        }
        (Method::Get, "/api/files") => diffing::file_list(ctx, &get("crate"), &get("from"), &get("to"))
            .map(|fl| serde_json::to_value(fl).unwrap())
            .ok_or_else(|| "could not load one of the versions".to_string()),
        (Method::Get, "/api/diff") => {
            diffing::file_diff(ctx, &get("crate"), &get("from"), &get("to"), &get("path"))
                .map(|fd| serde_json::to_value(fd).unwrap())
                .ok_or_else(|| "file or version not found".to_string())
        }
        (Method::Get, "/api/search-content") => {
            diffing::content_search(ctx, &get("crate"), &get("from"), &get("to"), &get("q"))
                .map(|hits| json!({ "results": hits }))
                .ok_or_else(|| "could not load one of the versions".to_string())
        }
        (Method::Get, "/api/github") => {
            Ok(serde_json::to_value(github::history(ctx, &get("crate"), &get("from"), &get("to"))).unwrap())
        }
        (Method::Get, "/api/notes") => Ok(notes::for_crate(ctx, &get("crate"))),
        (Method::Post, "/api/notes") => {
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            match serde_json::from_str::<Value>(&body) {
                Ok(v) => {
                    let key = v.get("key").and_then(|x| x.as_str()).unwrap_or("");
                    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
                    if key.is_empty() {
                        Err("missing note key".to_string())
                    } else {
                        notes::set(ctx, key, text);
                        Ok(json!({ "ok": true }))
                    }
                }
                Err(e) => Err(format!("bad JSON body: {e}")),
            }
        }
        _ => {
            return send(request, 404, "application/json; charset=utf-8", b"{\"error\":\"not found\"}".to_vec());
        }
    };

    match result {
        Ok(v) => send_json(request, 200, &v),
        Err(e) => send_json(request, 500, &json!({ "error": e })),
    }
}

fn serve_static(request: Request, ctx: &Ctx, file: &str, ctype: &str) {
    let path = ctx.web.join(file);
    match std::fs::read(&path) {
        Ok(bytes) => send(request, 200, ctype, bytes),
        Err(_) => send(
            request,
            404,
            "text/plain; charset=utf-8",
            format!("missing {}", path.display()).into_bytes(),
        ),
    }
}

fn send_json(request: Request, status: u16, value: &Value) {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    send(request, status, "application/json; charset=utf-8", body);
}

fn send(request: Request, status: u16, ctype: &str, body: Vec<u8>) {
    let header = Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes())
        .unwrap_or_else(|_| Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]).unwrap());
    let resp = Response::from_data(body).with_status_code(status).with_header(header);
    let _ = request.respond(resp);
}
