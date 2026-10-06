const DEFAULT_OWNER = "Bedrock-OSS";
const DEFAULT_REPO = "bedrock-wiki";
const DEFAULT_REF = "wiki";
const MAX_PATH_LENGTH = 512;

function sourceConfig(env = {}) {
  return {
    owner: env.WIKI_OWNER || DEFAULT_OWNER,
    repo: env.WIKI_REPO || DEFAULT_REPO,
    ref: env.WIKI_REF || DEFAULT_REF,
    pageTtl: positiveInteger(env.PAGE_CACHE_TTL_SECONDS, 300),
    indexTtl: positiveInteger(env.INDEX_CACHE_TTL_SECONDS, 600),
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function apiResponse(data, status = 200, cacheControl = "no-store", head = false) {
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });

  if (typeof data === "string") {
    headers.set("Content-Type", "text/markdown; charset=utf-8");
    return new Response(head ? null : data, { status, headers });
  }

  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(head ? null : JSON.stringify(data), { status, headers });
}

function apiError(code, message, status, head = false, extraHeaders = {}) {
  const response = apiResponse({ error: { code, message } }, status, "no-store", head);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(response.body, { status, headers });
}

function validMarkdownPath(input) {
  if (!input || input.length > MAX_PATH_LENGTH) return null;

  let path;
  try {
    path = decodeURIComponent(input);
  } catch {
    return null;
  }

  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (!path.startsWith("docs/")) return null;

  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (!path.endsWith(".md")) path += ".md";
  if (path.length > MAX_PATH_LENGTH || !path.startsWith("docs/")) return null;

  return path;
}

function encodePath(path) {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function rawMarkdownUrl(config, path) {
  return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${encodeURIComponent(config.ref)}/${encodePath(path)}`;
}

function repoTreeUrl(config) {
  return `https://api.github.com/repos/${config.owner}/${config.repo}/git/trees/${encodeURIComponent(config.ref)}?recursive=1`;
}

function indexEndpoint(path) {
  return `/v1/pages/${encodePath(path)}`;
}

async function serveIndex(config, head) {
  let upstream;
  try {
    upstream = await fetch(repoTreeUrl(config), {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "dripstoneai-bedrock-wiki-api",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cf: { cacheTtl: config.indexTtl, cacheEverything: true },
    });
  } catch {
    return apiError("upstream_unavailable", "Could not reach the Bedrock Wiki source.", 502, head);
  }

  if (!upstream.ok) {
    const status = upstream.status === 404 ? 404 : upstream.status === 429 ? 503 : 502;
    const headers = upstream.headers.get("retry-after") && status === 503
      ? { "Retry-After": upstream.headers.get("retry-after") }
      : {};
    return apiError("upstream_error", "The Bedrock Wiki index could not be loaded.", status, head, headers);
  }

  let tree;
  try {
    tree = await upstream.json();
  } catch {
    return apiError("invalid_upstream_response", "The Bedrock Wiki source returned an invalid index.", 502, head);
  }

  if (!Array.isArray(tree.tree) || tree.truncated) {
    return apiError("index_unavailable", "The Bedrock Wiki index was incomplete; try again later.", 503, head);
  }

  const pages = tree.tree
    .filter((entry) => entry.type === "blob" && entry.path.startsWith("docs/") && entry.path.endsWith(".md"))
    .map((entry) => ({ path: entry.path, url: indexEndpoint(entry.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": `public, max-age=60, s-maxage=${config.indexTtl}, stale-while-revalidate=86400`,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Wiki-Source": `https://github.com/${config.owner}/${config.repo}/tree/${encodeURIComponent(config.ref)}/docs`,
  });
  const body = JSON.stringify({
    source: `https://github.com/${config.owner}/${config.repo}`,
    ref: config.ref,
    count: pages.length,
    pages,
  });
  return new Response(head ? null : body, { status: 200, headers });
}

async function servePage(path, config, head) {
  const sourceUrl = rawMarkdownUrl(config, path);
  let upstream;
  try {
    upstream = await fetch(sourceUrl, {
      headers: { "User-Agent": "dripstoneai-bedrock-wiki-api" },
      cf: { cacheTtl: config.pageTtl, cacheEverything: true },
    });
  } catch {
    return apiError("upstream_unavailable", "Could not reach the Bedrock Wiki source.", 502, head);
  }

  if (!upstream.ok) {
    if (upstream.status === 404) {
      return apiError("page_not_found", "No Markdown page exists at that path.", 404, head);
    }
    const status = upstream.status === 429 ? 503 : 502;
    const retryAfter = upstream.headers.get("retry-after");
    return apiError(
      "upstream_error",
      "The Bedrock Wiki page could not be loaded.",
      status,
      head,
      retryAfter && status === 503 ? { "Retry-After": retryAfter } : {},
    );
  }

  const body = head ? null : await upstream.text();
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": `public, max-age=60, s-maxage=${config.pageTtl}, stale-while-revalidate=86400`,
    "Content-Type": "text/markdown; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Wiki-Source": sourceUrl,
    "X-Wiki-Ref": config.ref,
  });
  const upstreamEtag = upstream.headers.get("etag");
  const upstreamLastModified = upstream.headers.get("last-modified");
  if (upstreamEtag) headers.set("ETag", upstreamEtag);
  if (upstreamLastModified) headers.set("Last-Modified", upstreamLastModified);

  return new Response(body, { status: 200, headers });
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const head = request.method === "HEAD";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET" && !head) {
      return apiError("method_not_allowed", "Use GET, HEAD, or OPTIONS.", 405, false, { Allow: "GET, HEAD, OPTIONS" });
    }

    if (url.pathname === "/" || url.pathname === "/v1") {
      return apiResponse({
        name: "Bedrock Wiki Markdown API",
        version: 1,
        source: "https://github.com/Bedrock-OSS/bedrock-wiki",
        endpoints: {
          health: "/v1/health",
          index: "/v1/index",
          page: "/v1/pages/docs/<path>.md",
          pageQuery: "/v1/pages?path=docs/<path>.md",
        },
      }, 200, "public, max-age=60", head);
    }

    if (url.pathname === "/v1/health") {
      return apiResponse({ status: "ok" }, 200, "public, max-age=15", head);
    }

    if (url.pathname === "/v1/index") {
      return serveIndex(sourceConfig(env), head);
    }

    if (url.pathname === "/v1/pages" || url.pathname.startsWith("/v1/pages/")) {
      const rawPath = url.pathname === "/v1/pages"
        ? url.searchParams.get("path")
        : url.pathname.slice("/v1/pages/".length);
      if (!rawPath) {
        return apiError("missing_path", "Provide a Markdown path, for example docs/guide/project-setup.md.", 400, head);
      }

      const path = validMarkdownPath(rawPath);
      if (!path) {
        return apiError("invalid_path", "Only safe Markdown paths inside the docs/ directory can be fetched.", 400, head);
      }
      return servePage(path, sourceConfig(env), head);
    }

    return apiError("not_found", "No API route exists at this path.", 404, head);
  },
};
