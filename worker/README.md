# crates_diff — Cloudflare Worker backend

One tiny Worker, two jobs, both keeping secrets off the static site:

1. **Sign in with GitHub** — `GET /oauth/token?code=…` exchanges a GitHub OAuth
   `code` for the visitor's access token, using the OAuth app's **client secret**
   (held here, never in the browser). This powers shared, attributed **Notes**:
   each note is an issue comment posted *as the signed-in visitor* in the notes repo.
2. **History-tab proxy** (optional) — `GET /repos/:o/:r/tags` and
   `/repos/:o/:r/compare/…` forwarded to GitHub with an optional `GITHUB_TOKEN`, so
   the History tab isn't capped at 60 requests/hour.

CORS is restricted to the origins in `src/index.js` — add yours if it differs.

## Setup

You run these — they need **your** accounts and secrets, which must never pass
through anyone else's hands.

### 1. Notes repo
Already created: **`muhammad-hassnain/crates-diff-notes`** (public, issues on). Notes
are stored there as issues (one per crate / per version-transition) with comments.

### 2. GitHub OAuth App
At <https://github.com/settings/developers> → **New OAuth App**:
- **Homepage URL:** `https://muhammad-hassnain.github.io/crates-diff/`
- **Authorization callback URL:** `https://muhammad-hassnain.github.io/crates-diff/`
  (exactly the site URL — the app strips the `?code=` itself)

Copy the **Client ID** and generate a **Client secret**.

### 3. Deploy the Worker + set secrets
From this `worker/` folder:
```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID       # paste the Client ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET   # paste the Client secret
# optional — raises the History tab's rate limit:
# Prefer a FINE-GRAINED token: "Public repositories (read-only)" — no account/private
# access. (A classic `public_repo` token also works but grants write to all your public
# repos; avoid a classic token with the `repo` scope, or the proxy could read your
# private repos' tags/compare.)
npx wrangler secret put GITHUB_TOKEN
```
`deploy` prints the Worker URL, e.g.
`https://crates-diff-gh-proxy.<your-subdomain>.workers.dev`.

### 4. Point the site at it — `../docs/config.js`
```js
window.GH_PROXY          = "https://crates-diff-gh-proxy.<your-subdomain>.workers.dev";
window.GH_OAUTH_CLIENT_ID = "<the OAuth Client ID>";
window.NOTES_REPO         = "muhammad-hassnain/crates-diff-notes";
```
Commit and push. Done — a **Sign in with GitHub** button appears, and the Notes tab
becomes attributed comment threads.

## Behaviour & safety notes

- **Until this is configured**, the Notes tab falls back to per-browser
  `localStorage` notes (no login), so the site always works.
- The visitor's token is scoped to **`public_repo`** and stored in *their own*
  browser — the same model utterances/giscus use. The Worker only ever holds the
  client secret and does the code→token exchange.
- Any signed-in GitHub user can post; notes are attributed to their account, so you
  can moderate or block abusers on the notes repo like any GitHub issues.
- Free Cloudflare tier is 100k requests/day — far more than this needs.
