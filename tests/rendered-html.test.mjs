import assert from "node:assert/strict";
import test from "node:test";
import { collectAccounts } from "../app/account-input.ts";
import { selectedRange } from "../app/date-range.ts";
import { sortResults } from "../app/result-sort.ts";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the finished TikTok data tool", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>TikTok 实时数据助手<\/title>/);
  assert.match(html, /TikTok 实时数据助手/);
  assert.match(html, /<meta[^>]+name="viewport"[^>]+width=device-width/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("health endpoint stays cheap for keepalive checks", async () => {
  const response = await render("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("normalizes one public profile page with complete metrics", async () => {
  const originalFetch = globalThis.fetch;
  const originalCode = process.env.ACCESS_CODE;
  process.env.ACCESS_CODE = "profile-test";
  const hydration = {
    __DEFAULT_SCOPE__: {
      "webapp.user-detail": {
        statusCode: 0,
        userInfo: {
          user: { uniqueId: "demo_creator", nickname: "Demo", secUid: "MS4wLjABAAAA_demo_profile_identifier_123456789", privateAccount: false },
          stats: { followerCount: 1234, videoCount: 9 },
        },
      },
    },
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://www.tiktok.com/@demo_creator")) {
      return new Response(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(hydration)}</script>`);
    }
    if (url.startsWith("https://www.tiktok.com/api/creator/item_list/")) {
      return Response.json({
        statusCode: 0,
        hasMorePrevious: true,
        itemList: [
          { id: "7673556768491883808", createTime: 1786648761, desc: "First", author: { uniqueId: "demo_creator" }, statsV2: { playCount: "710", diggCount: "32", commentCount: "2", collectCount: "3", shareCount: "0" } },
          { id: "7672457680946089249", createTime: 1786383260, desc: "Second", author: { uniqueId: "demo_creator" }, statsV2: { playCount: "423", diggCount: "19", commentCount: "1", shareCount: "1" } },
        ],
      });
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("profile-test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(new Request("http://localhost/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": "profile-test" },
      body: JSON.stringify({ username: "@demo_creator", cursor: 1788310000000 }),
    }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.profile.username, "demo_creator");
    assert.equal(data.items.length, 2);
    assert.deepEqual({ views: data.items[0].views, likes: data.items[0].likes, comments: data.items[0].comments, saves: data.items[0].saves, shares: data.items[0].shares }, { views: 710, likes: 32, comments: 2, saves: 3, shares: 0 });
    assert.equal(data.items[1].saves, null);
    assert.equal(data.nextCursor, 1786383260000);
    assert.equal(data.hasMore, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCode === undefined) delete process.env.ACCESS_CODE;
    else process.env.ACCESS_CODE = originalCode;
  }
});

test("sorts the complete result set and keeps unavailable values last", () => {
  const rows = [
    { id: "high", status: "success", publishedAt: "2026-08-03 08:00:00", fetchedAt: "2026-09-02 10:00:00", views: 100, likes: 8, comments: 4, saves: 2, shares: 1 },
    { id: "low", status: "success", publishedAt: "2026-08-01 08:00:00", fetchedAt: "2026/9/2 9:00:00", views: 20, likes: 3, comments: 1, saves: 0, shares: 0 },
    { id: "missing", status: "success", publishedAt: "2026-08-02 08:00:00", fetchedAt: "", views: null, likes: null, comments: null, saves: null, shares: null },
    { id: "failed", status: "error", publishedAt: "", fetchedAt: "2026-09-02 11:00:00", views: 999, likes: 999, comments: 999, saves: 999, shares: 999 },
  ];
  assert.deepEqual(sortResults(rows, "views", "desc").map((item) => item.id), ["high", "low", "missing", "failed"]);
  assert.deepEqual(sortResults(rows, "views", "asc").map((item) => item.id), ["low", "high", "missing", "failed"]);
  assert.deepEqual(sortResults(rows, "publishedAt", "desc").map((item) => item.id), ["high", "missing", "low", "failed"]);
  assert.deepEqual(rows.map((item) => item.id), ["high", "low", "missing", "failed"]);
});

test("accepts a single Beijing day and caps custom ranges at three months", () => {
  const singleDay = selectedRange("custom", "", "2026-08-13", "2026-08-13");
  assert.equal(singleDay.start, Date.UTC(2026, 7, 13) / 1000 - 8 * 3600);
  assert.equal(singleDay.end - singleDay.start, 86_400);
  assert.match(singleDay.label, /单日/);
  assert.doesNotThrow(() => selectedRange("custom", "", "2026-06-01", "2026-08-31"));
  assert.throws(() => selectedRange("custom", "", "2026-06-01", "2026-09-01"), /最长为 3 个月/);
  assert.throws(() => selectedRange("custom", "", "2026-08-14", "2026-08-13"), /不能早于/);
});

test("normalizes and deduplicates multiple TikTok accounts", () => {
  const parsed = collectAccounts("@Alice, alice\nhttps://www.tiktok.com/@bob/video/1234567890123456789；bad!name");
  assert.deepEqual(parsed.accounts, ["Alice", "bob"]);
  assert.equal(parsed.invalid, 1);
});
