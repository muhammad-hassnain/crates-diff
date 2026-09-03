# crates_diff — GitHub API proxy (Cloudflare Worker)

A tiny serverless proxy that holds a GitHub token **server-side** so the static site's
**History** tab isn't capped at the unauthenticated 60 requests/hour limit — without
ever shipping the token to the browser.

It forwards only two read endpoints (`/repos/:o/:r/tags` and
`/repos/:o/:r/compare/...`) to `api.github.com`, adding the token, and returns the JSON
with CORS restricted to the origins listed in `src/index.js`.

## Deploy (one time, ~5 minutes)

You run these — they need **your** Cloudflare login and **your** GitHub token, which
must never pass through anyone else's hands.

1. **Cloudflare account:** sign up (free) at <https://dash.cloudflare.com>.
2. **GitHub token:** create one at <https://github.com/settings/tokens> — a *classic*
   token with the **`public_repo`** scope is enough (read-only access to public repos).
3. From this `worker/` folder:
   ```bash
   npx wrangler login                 # opens the browser to authorize
   npx wrangler deploy                # deploys the Worker, prints its URL
   npx wrangler secret put GITHUB_TOKEN   # paste your token when prompted
   ```
   The deploy prints a URL like
   `https://crates-diff-gh-proxy.<your-subdomain>.workers.dev`.
4. **Point the site at it:** put that URL in [`../docs/config.js`](../docs/config.js):
   ```js
   window.GH_PROXY = "https://crates-diff-gh-proxy.<your-subdomain>.workers.dev";
   ```
   Commit and push — GitHub Pages redeploys, and the History tab now uses your token.

## Notes

- **Leaving `GH_PROXY` empty** (the default) keeps everything working — the site just
  calls GitHub directly, unauthenticated (60/hr). The proxy is purely an upgrade.
- `ALLOWED_ORIGINS` in `src/index.js` limits which sites' browsers may use your proxy.
  Add your Pages origin there if it isn't already listed.
- The token stays a Cloudflare **secret** — it's not in this repo and not in the
  deployed JavaScript.
- Free tier is 100,000 requests/day, far more than this needs.
