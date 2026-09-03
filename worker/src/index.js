/**
 * crates_diff — Cloudflare Worker backend.
 *
 * Two jobs, both keeping secrets off the static site:
 *
 *   GET /oauth/token?code=...   Exchange a GitHub OAuth `code` for a user access
 *                               token (using the OAuth app's client secret, held
 *                               here as env.GITHUB_OAUTH_CLIENT_SECRET). Returns
 *                               { access_token }. This powers "Sign in with GitHub"
 *                               so visitors can post notes as themselves — the
 *                               token is theirs, scoped to public_repo.
 *
 *   GET /repos/:o/:r/tags
 *   GET /repos/:o/:r/compare/…  Read-only GitHub proxy for the History tab, adding
 *                               env.GITHUB_TOKEN so it isn't capped at 60 req/hr.
 *                               (Optional — leave GITHUB_TOKEN unset to skip.)
 *
 * CORS is restricted to the origins below.
 *
 * Secrets (set with `npx wrangler secret put <NAME>`):
 *   GITHUB_OAUTH_CLIENT_ID       the OAuth app's Client ID
 *   GITHUB_OAUTH_CLIENT_SECRET   the OAuth app's Client secret
 *   GITHUB_TOKEN                 (optional) token for the read-only History proxy
 */

const ALLOWED_ORIGINS = [
  "https://muhammad-hassnain.github.io",
  "http://127.0.0.1:8899",
  "http://localhost:8899",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // ---- OAuth code -> token exchange ----
    if (url.pathname === "/oauth/token") {
      if (request.method !== "GET") return json({ error: "only GET" }, 405, cors);
      const code = url.searchParams.get("code");
      if (!code) return json({ error: "missing code" }, 400, cors);
      const resp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "crates-diff" },
        body: JSON.stringify({
          client_id: env.GITHUB_OAUTH_CLIENT_ID,
          client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
          code,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.error) return json({ error: data.error_description || data.error }, 400, cors);
      // Only hand the browser the token itself, nothing else.
      return json({ access_token: data.access_token || null }, 200, cors);
    }

    // ---- read-only GitHub proxy (History tab) ----
    if (request.method !== "GET") return json({ error: "only GET is allowed" }, 405, cors);
    if (!/^\/repos\/[^/]+\/[^/]+\/(tags|compare\/.+)$/.test(url.pathname)) {
      return json({ error: "path not allowed" }, 403, cors);
    }
    const target = "https://api.github.com" + url.pathname + url.search;
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "crates-diff-proxy" };
    if (env.GITHUB_TOKEN) headers["Authorization"] = "Bearer " + env.GITHUB_TOKEN;
    const gh = await fetch(target, { headers });
    const body = await gh.text();
    return new Response(body, { status: gh.status, headers: { ...cors, "Content-Type": "application/json" } });
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
