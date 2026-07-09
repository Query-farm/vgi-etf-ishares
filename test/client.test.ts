// Cache behavior of the real client's `get`. The client is otherwise verified live, but the
// 24 h screener memoization is pure logic, so it's unit-tested here with an injected
// fetch (call-counting) and an injected clock. No network.

import { test, expect } from "bun:test";
import { makeIsharesGet } from "../src/client.js";
import { SCREENER_URL, productDataUrl } from "../src/ishares.js";

/** A fake fetch that counts calls and returns a canned JSON body. */
function countingFetch(body: unknown = { ok: 1 }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const HOLDINGS_URL = productDataUrl(239726, "holdings.all");

test("screener is fetched once then served from cache within the TTL", async () => {
  const { impl, calls } = countingFetch();
  let clock = 1_000_000;
  const get = makeIsharesGet(impl, { now: () => clock });
  await get(SCREENER_URL);
  await get(SCREENER_URL);
  clock += 60 * 60 * 1000; // +1 h, still within the 24 h TTL
  await get(SCREENER_URL);
  expect(calls.length).toBe(1);
});

test("screener is refetched after the TTL expires", async () => {
  const { impl, calls } = countingFetch();
  let clock = 0;
  const get = makeIsharesGet(impl, { now: () => clock });
  await get(SCREENER_URL);
  clock += 24 * 60 * 60 * 1000 + 1; // just past 24 h
  await get(SCREENER_URL);
  expect(calls.length).toBe(2);
});

test("non-screener URLs are never cached", async () => {
  const { impl, calls } = countingFetch();
  const get = makeIsharesGet(impl);
  await get(HOLDINGS_URL);
  await get(HOLDINGS_URL);
  expect(calls.length).toBe(2);
});

test("concurrent first screener requests coalesce into a single fetch", async () => {
  const { impl, calls } = countingFetch();
  const get = makeIsharesGet(impl);
  await Promise.all([get(SCREENER_URL), get(SCREENER_URL), get(SCREENER_URL)]);
  expect(calls.length).toBe(1);
});

test("screenerCacheMs: 0 disables caching", async () => {
  const { impl, calls } = countingFetch();
  const get = makeIsharesGet(impl, { screenerCacheMs: 0 });
  await get(SCREENER_URL);
  await get(SCREENER_URL);
  expect(calls.length).toBe(2);
});

test("a failed screener fetch is evicted so the next call retries", async () => {
  const calls: string[] = [];
  let failNext = true;
  const impl = (async (url: string) => {
    calls.push(url);
    if (failNext) {
      failNext = false;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "down" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: 1 }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const get = makeIsharesGet(impl);
  await expect(get(SCREENER_URL)).rejects.toThrow(/HTTP 503/);
  const ok = await get(SCREENER_URL); // cache was evicted → retries and succeeds
  expect(ok).toEqual({ ok: 1 });
  expect(calls.length).toBe(2);
});
