// The real iShares HTTP client — the ONE module that touches the network, so (like the
// yfinance worker's Yahoo client) it is exercised live, not by the unit tests, which drive
// the pure driver in ishares.ts through an injected fake `get`.
//
// Both iShares planes — the product screener and the BlackRock get-product-data API — are
// keyless and un-gated, so there is no login/crumb handshake. The one non-obvious
// requirement is a browser-like User-Agent; the default fetch UA is rejected with an
// interstitial HTML page instead of JSON.
//
// SCREENER CACHE: the ~1.9 MB product screener backs both `products` and every ticker→
// portfolioId resolution, and it changes at most once a day. So the client memoizes just
// that one URL with a 24 h TTL (shared across queries in a long-lived stdio/HTTP process).
// Everything else — holdings, fund_details, distributions, nav_history — always goes live.
// The in-flight Promise is cached (not only the resolved value) so concurrent first requests
// coalesce into a single fetch; a failed fetch is evicted so the next call retries.

import type { IsharesGet } from "./functions.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Default screener cache lifetime: 24 hours. */
export const SCREENER_CACHE_MS = 24 * 60 * 60 * 1000;

type FetchLike = typeof globalThis.fetch;

export interface IsharesClientOptions {
  /** Screener cache TTL in ms (default 24 h). Pass 0 to disable caching. */
  screenerCacheMs?: number;
  /** Injectable clock (ms since epoch) — for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Build the injectable `get(url) => parsed JSON` the table functions call. `fetchImpl`
 * defaults to the platform fetch; pass one in for Cloudflare or to stub the network.
 * The product screener response is memoized for `screenerCacheMs` (default 24 h).
 */
export function makeIsharesGet(
  fetchImpl: FetchLike = globalThis.fetch,
  opts: IsharesClientOptions = {},
): IsharesGet {
  const ttl = opts.screenerCacheMs ?? SCREENER_CACHE_MS;
  const now = opts.now ?? (() => Date.now());
  let screener: { at: number; value: Promise<unknown> } | null = null;

  const rawGet = async (url: string): Promise<unknown> => {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ishares: HTTP ${res.status} for ${url} — ${body.slice(0, 200)}`);
    }
    return res.json();
  };

  return async (url: string): Promise<unknown> => {
    if (ttl > 0 && url.includes("/product-screener/")) {
      const t = now();
      if (!screener || t - screener.at >= ttl) {
        const value = rawGet(url);
        screener = { at: t, value };
        // Evict a rejected fetch so the next call retries instead of caching the error.
        value.catch(() => {
          if (screener && screener.value === value) screener = null;
        });
      }
      return screener.value;
    }
    return rawGet(url);
  };
}
