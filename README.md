# dripstoneai bedrock wiki markdown api

A lightweight Cloudflare Worker that serves raw Markdown from the [`Bedrock-OSS/bedrock-wiki`](https://github.com/Bedrock-OSS/bedrock-wiki) repository. It gives dripstoneAI stable, CORS-enabled URLs for retrieving articles, plus an index that helps an AI tool discover available pages.

The Worker proxies the wiki's `wiki` branch directly. It does not mirror or transform article content. Responses identify the upstream source with `X-Wiki-Source` and, for pages, `X-Wiki-Ref`.

## api routes

| Method | Route | Result |
| --- | --- | --- |
| `GET` | `/` or `/v1` | API overview |
| `GET` | `/v1/health` | Small health response |
| `GET` | `/v1/index` | JSON index of Markdown files under `docs/` |
| `GET` | `/v1/pages/docs/<path>.md` | Raw Markdown; `.md` may be omitted |
| `GET` | `/v1/pages?path=docs/<path>.md` | Equivalent query-string form |

Example page request:

```text
GET https://YOUR-WORKER.workers.dev/v1/pages/docs/guide/project-setup.md
```

The index returns `source`, `ref`, `count`, and a `pages` array. Each page contains its repository-relative `path` and a ready-to-fetch API `url`.

## caching and access

- Page fetches are cached at Cloudflare's edge for 300 seconds; the index fetch is cached for 600 seconds.
- Public responses also include browser/CDN cache headers and `stale-while-revalidate`.
- CORS is open (`Access-Control-Allow-Origin: *`) so a browser-based dripstoneAI tool can call the API.
- This is a public read-only proxy with no API key or user-specific data. It only allows Markdown files inside `docs/`.
- The source repository is community maintained. Please retain attribution to Bedrock OSS and review the repository's content licensing before redistributing cached copies or using content beyond retrieval.

## local development

Requirements: Node.js 20+ and a Cloudflare account only if you later choose to publish the Worker.

1. Open this project folder in a terminal.
2. Install the development dependency with `npm install`.
3. Run the tests with `npm test`.
4. Start a local Worker preview with `npm run dev`.

Wrangler reads `wrangler.toml`; the default source is the public Bedrock Wiki `wiki` branch. To preview against another source, update `WIKI_OWNER`, `WIKI_REPO`, or `WIKI_REF` in that file. Cache durations can be adjusted with `PAGE_CACHE_TTL_SECONDS` and `INDEX_CACHE_TTL_SECONDS`.

## publish later (not done)

When you decide to publish it, authenticate Wrangler with your Cloudflare account and run `npm run deploy` from this project folder. This project has **not** been deployed, and no Cloudflare settings or DNS records were changed as part of its creation.

## files

- `src/index.js` — Worker routes, validation, upstream requests, CORS, and caching.
- `wrangler.toml` — Worker name, source settings, and cache defaults.
- `test/index.test.js` — network-mocked tests for the API behavior.
