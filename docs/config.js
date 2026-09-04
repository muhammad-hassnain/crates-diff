// Runtime config for the static site. All values here are PUBLIC (they ship in the
// page). Secrets live only in the Cloudflare Worker.

// Base URL of the Worker (../worker). Serves both the read-only GitHub proxy
// (History tab) and the /oauth/token endpoint (Sign in with GitHub). Leave "" and
// the History tab falls back to unauthenticated GitHub (60/hr) and login is disabled.
//   e.g. "https://crates-diff-gh-proxy.your-name.workers.dev"
window.GH_PROXY = "https://crates-diff-gh-proxy.m-hassnain-gee.workers.dev";

// --- Notes-as-GitHub-issues (optional) ---
// Set BOTH of these to turn on shared, attributed notes stored as issue comments.
// Leave either empty and Notes fall back to per-browser localStorage (no login).

// The OAuth App's Client ID (public). Create the app at
// https://github.com/settings/developers — Authorization callback URL must be this
// site's URL (e.g. https://muhammad-hassnain.github.io/crates-diff/). The matching
// client SECRET goes in the Worker, never here.
window.GH_OAUTH_CLIENT_ID = "Ov23liwkjrNTo1e3S1tr";

// "owner/repo" that stores the notes (issues enabled). Notes are posted as the
// signed-in visitor. e.g. "muhammad-hassnain/crates-diff-notes"
window.NOTES_REPO = "muhammad-hassnain/crates-diff-notes";
