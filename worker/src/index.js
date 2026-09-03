/**
 * crates_diff — GitHub API proxy (Cloudflare Worker).
 *
 * Holds a GitHub token as a secret (env.GITHUB_TOKEN) and forwards only the two
 * read endpoints the site uses — /repos/:o/:r/tags and /repos/:o/:r/compare/... —
 * to api.github.com with that token attached. The token never reaches the browser,
 * so the History tab isn't stuck at the 60 requests/hour unauthenticated limit.
 *
 * CORS is restricted to the origins below so a random site can't drive your token
 * through a visitor's browser. Add your Pages origin if it differs.
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
    if (request.method !== "GET") return json({ error: "only GET is allowed" }, 405, cors);

    // Only proxy the exact GitHub read paths the app needs.
    if (!/^\/repos\/[^/]+\/[^/]+\/(tags|compare\/.+)$/.test(url.pathname)) {
      return json({ error: "path not allowed" }, 403, cors);
    }

    const target = "https://api.github.com" + url.pathname + url.search;
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "crates-diff-proxy",
    };
    if (env.GITHUB_TOKEN) headers["Authorization"] = "Bearer " + env.GITHUB_TOKEN;

    const gh = await fetch(target, { headers });
    const body = await gh.text();
    return new Response(body, {
      status: gh.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
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
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
