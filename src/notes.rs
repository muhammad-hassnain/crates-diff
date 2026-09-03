//! Free-form notes, keyed by arbitrary strings chosen by the frontend
//! (e.g. `serde` for a crate note, `serde@1.0.0..1.0.1` for a transition note).

use serde_json::{json, Value};

use crate::store::Ctx;

/// All notes whose key is exactly `crate` or begins with `crate@`.
pub fn for_crate(ctx: &Ctx, crate_name: &str) -> Value {
    let guard = ctx.notes.lock().unwrap();
    let prefix = format!("{crate_name}@");
    let mut out = serde_json::Map::new();
    for (k, v) in guard.iter() {
        if k == crate_name || k.starts_with(&prefix) {
            out.insert(k.clone(), v.clone());
        }
    }
    json!({ "notes": out })
}

/// Upsert a note. Empty text removes the key.
pub fn set(ctx: &Ctx, key: &str, text: &str) {
    {
        let mut guard = ctx.notes.lock().unwrap();
        if text.trim().is_empty() {
            guard.remove(key);
        } else {
            guard.insert(key.to_string(), Value::String(text.to_string()));
        }
    }
    ctx.save_notes();
}
