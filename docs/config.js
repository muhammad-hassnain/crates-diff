// Runtime config for the static site.
//
// GH_PROXY: base URL of your GitHub API proxy (the Cloudflare Worker in ../worker).
// The proxy adds your GitHub token server-side, so the History tab isn't capped at
// the 60 requests/hour unauthenticated limit — without ever exposing the token.
//
// Leave it "" and the site calls api.github.com directly (unauthenticated, 60/hr).
// After you deploy the Worker, paste its URL here (no trailing slash), e.g.:
//   window.GH_PROXY = "https://crates-diff-gh-proxy.your-name.workers.dev";
window.GH_PROXY = "";
