import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeRequest(path, method = "GET") {
  return new Request(`https://api.example.test${path}`, { method });
}

function mockFetch(t, implementation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("health route returns a small JSON response without contacting GitHub", async (t) => {
  mockFetch(t, async () => {
    throw new Error("unexpected upstream request");
  });

  const response = await worker.fetch(makeRequest("/v1/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("page route returns raw Markdown and asks Cloudflare to cache the GitHub fetch", async (t) => {
  let requestedUrl;
  let requestOptions;
  mockFetch(t, async (url, options) => {
    requestedUrl = String(url);
    requestOptions = options;
    return new Response("# Hello\n\nA wiki page.", {
      status: 200,
      headers: { etag: '"abc123"', "last-modified": "Mon, 05 Oct 2026 00:00:00 GMT" },
    });
  });

  const response = await worker.fetch(makeRequest("/v1/pages/docs/guide/project-setup"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("x-wiki-ref"), "wiki");
  assert.equal(response.headers.get("etag"), '"abc123"');
  assert.match(await response.text(), /^# Hello/);
  assert.equal(
    requestedUrl,
    "https://raw.githubusercontent.com/Bedrock-OSS/bedrock-wiki/wiki/docs/guide/project-setup.md",
  );
  assert.equal(requestOptions.cf.cacheTtl, 300);
  assert.equal(requestOptions.cf.cacheEverything, true);
});

test("query-string form fetches the requested markdown path", async (t) => {
  let requestedUrl;
  mockFetch(t, async (url) => {
    requestedUrl = String(url);
    return new Response("# Page", { status: 200 });
  });

  const response = await worker.fetch(makeRequest("/v1/pages?path=docs%2Fguide%2Fproject-setup.md"));
  assert.equal(response.status, 200);
  assert.match(requestedUrl, /docs\/guide\/project-setup\.md$/);
});

test("page routes reject traversal and paths outside docs without fetching upstream", async (t) => {
  let upstreamCalled = false;
  mockFetch(t, async () => {
    upstreamCalled = true;
    return new Response("unexpected", { status: 200 });
  });

  for (const path of [
    "/v1/pages/README.md",
    "/v1/pages/docs/../README.md",
    "/v1/pages/docs/%2e%2e/README.md",
    "/v1/pages/docs%5cREADME.md",
  ]) {
    const response = await worker.fetch(makeRequest(path));
    assert.equal(response.status, 400, path);
  }
  assert.equal(upstreamCalled, false);
});

test("index route returns only documentation markdown pages", async (t) => {
  let requestedUrl;
  let requestOptions;
  mockFetch(t, async (url, options) => {
    requestedUrl = String(url);
    requestOptions = options;
    return Response.json({
      truncated: false,
      tree: [
        { type: "blob", path: "README.md" },
        { type: "blob", path: "docs/guide/intro.md" },
        { type: "blob", path: "docs/guide/data.json" },
        { type: "tree", path: "docs/blocks" },
        { type: "blob", path: "docs/blocks/events.md" },
      ],
    });
  });

  const response = await worker.fetch(makeRequest("/v1/index"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.count, 2);
  assert.deepEqual(body.pages.map((page) => page.path), ["docs/blocks/events.md", "docs/guide/intro.md"]);
  assert.equal(body.pages[0].url, "/v1/pages/docs/blocks/events.md");
  assert.match(requestedUrl, /git\/trees\/wiki\?recursive=1$/);
  assert.equal(requestOptions.cf.cacheTtl, 600);
  assert.equal(requestOptions.cf.cacheEverything, true);
});

test("missing source page becomes a clean 404", async (t) => {
  mockFetch(t, async () => new Response("Not Found", { status: 404 }));
  const response = await worker.fetch(makeRequest("/v1/pages/docs/not-here.md"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { code: "page_not_found", message: "No Markdown page exists at that path." },
  });
});

test("preflight and unsupported methods are handled", async (t) => {
  mockFetch(t, async () => {
    throw new Error("unexpected upstream request");
  });
  const preflight = await worker.fetch(makeRequest("/v1/pages", "OPTIONS"));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");

  const post = await worker.fetch(makeRequest("/v1/pages", "POST"));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
});
