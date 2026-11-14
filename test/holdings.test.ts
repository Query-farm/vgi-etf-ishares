// Archetype proof for ishares.holdings: the get-product-data holdings driver + fund
// resolution + DATE-arg conversion. SDK-free.

import { test, expect } from "bun:test";
import {
  parseHoldings,
  parseHoldingDates,
  dateArgToYmd,
  dateArgToEpoch,
  fetchHoldings,
  fetchHoldingsSkippingErrors,
  resolveFund,
  productDataUrl,
} from "../src/ishares.js";
import { FakeIshares, holdingsEnvelope, bondHoldingsEnvelope, screenerEnvelope } from "./fake-ishares.js";

test("productDataUrl carries the component and an 8-digit asOfDate only when valid", () => {
  const u1 = productDataUrl(239726, "holdings.all");
  expect(u1).toContain("component=holdings.all");
  expect(u1).toContain("portfolioId=239726");
  expect(u1).not.toContain("asOfDate");
  expect(productDataUrl(239726, "holdings.all", "20260630")).toContain("asOfDate=20260630");
  expect(productDataUrl(239726, "holdings.all", "bad")).not.toContain("asOfDate");
});

test("dateArgToYmd handles the runtime's epoch-ms number, plus Date/days/string forms", () => {
  expect(dateArgToYmd(Date.UTC(2026, 5, 30))).toBe("20260630"); // epoch ms — what the runtime sends
  expect(dateArgToYmd(new Date(Date.UTC(2026, 5, 30)))).toBe("20260630"); // JS Date
  expect(dateArgToYmd(Math.floor(Date.UTC(2026, 5, 30) / 86400000))).toBe("20260630"); // days-since-epoch
  expect(dateArgToYmd("2026-06-30")).toBe("20260630"); // string fallback
  expect(dateArgToYmd(null)).toBe(""); // omitted → latest
});

test("dateArgToEpoch returns epoch seconds at UTC midnight (from epoch-ms), null when absent", () => {
  expect(dateArgToEpoch(Date.UTC(2025, 0, 1))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(new Date(Date.UTC(2025, 0, 1)))).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  expect(dateArgToEpoch(null)).toBeNull();
});

test("parseHoldings zips the parallel columns into rows and tolerates '-' cells", () => {
  const rows = parseHoldings(holdingsEnvelope("20260707"), 239726, null);
  expect(rows.length).toBe(2);
  const nvda = rows[0]!;
  expect(nvda.portfolioId).toBe(239726);
  expect(nvda.ticker).toBe("NVDA");
  expect(nvda.name).toBe("NVIDIA CORP");
  expect(nvda.weightPercent).toBe(7.38);
  expect(nvda.marketValue).toBe(65531934693.01);
  expect(nvda.unitsHeld).toBe(332767657.0);
  expect(nvda.sedol).toBeNull(); // "-" cell
  expect(nvda.accrualDate).toBeNull(); // "-" cell
  // equity funds leave the bond-only columns null
  expect(nvda.couponPercent).toBeNull();
  expect(nvda.maturityDate).toBeNull();
  // as-of resolved from the payload's own asOfDate data point
  expect(nvda.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(rows[1]!.sedol).toBe("2046251");
});

test("parseHoldings sorts by weight descending (NULLS last)", () => {
  // Fixture is authored AAPL(7.06) before NVDA(7.38) would break a naive read; assert order.
  const rows = parseHoldings(holdingsEnvelope("20260707"), 239726, null);
  expect(rows.map((r) => r.ticker)).toEqual(["NVDA", "AAPL"]);
  expect(rows[0]!.weightPercent!).toBeGreaterThanOrEqual(rows[1]!.weightPercent!);
});

test("parseHoldings fills the fixed-income-only columns for bond funds", () => {
  const rows = parseHoldings(bondHoldingsEnvelope(), 239458, null);
  expect(rows.length).toBe(2);
  const b0 = rows[0]!;
  expect(b0.couponPercent).toBe(4.63);
  expect(b0.duration).toBe(6.92);
  expect(b0.ytmPercent).toBe(4.5);
  expect(b0.parValue).toBe(540000000.0);
  expect(b0.marketCurrency).toBe("USD");
  expect(b0.maturityDate).toBe(Math.floor(Date.UTC(2034, 1, 15) / 1000));
});

test("parseHoldings returns [] for an empty/unknown envelope, no throw", () => {
  expect(parseHoldings({}, 1, null)).toEqual([]);
  expect(parseHoldings({ componentsByNameMap: {} }, 1, null)).toEqual([]);
});

test("parseHoldingDates reads the dateList", () => {
  const rows = parseHoldingDates(holdingsEnvelope(null), 239726);
  expect(rows.map((r) => r.asOfDate)).toEqual([
    Math.floor(Date.UTC(2026, 6, 7) / 1000),
    Math.floor(Date.UTC(2026, 5, 30) / 1000),
    Math.floor(Date.UTC(2025, 11, 31) / 1000),
  ]);
});

test("resolveFund passes a numeric id through without a network call", async () => {
  const fake = new FakeIshares(() => screenerEnvelope());
  expect(await resolveFund(fake.get, "239726")).toBe(239726);
  expect(fake.calls.length).toBe(0);
});

test("resolveFund maps a ticker via the screener", async () => {
  const fake = new FakeIshares(() => screenerEnvelope());
  expect(await resolveFund(fake.get, "ivv")).toBe(239726);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("product-screener");
});

test("resolveFund returns null on an unknown ticker (caller raises the typed error)", async () => {
  const fake = new FakeIshares(() => screenerEnvelope());
  expect(await resolveFund(fake.get, "ZZZZ")).toBeNull();
});

test("fetchHoldings with no date makes one request for the latest holdings", async () => {
  const fake = FakeIshares.router({ holdings: (d) => holdingsEnvelope(d) });
  const rows = await fetchHoldings(fake.get, 239726);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).not.toContain("asOfDate");
});

test("fetchHoldings with a date makes one request carrying that asOfDate", async () => {
  const fake = FakeIshares.router({ holdings: (d) => holdingsEnvelope(d) });
  const rows = await fetchHoldings(fake.get, 239726, "20260630");
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("asOfDate=20260630");
  expect(rows[0]!.asOfDate).toBe(Math.floor(Date.UTC(2026, 5, 30) / 1000));
});

test("parseHoldings reads the ce*/marketWeight columns some equity funds publish instead", () => {
  // Since Nov 2026 e.g. IVV carries marketWeight / ceMarketValue / ceNotionalValue in place of
  // holdingPercent / marketValue / notionalValue.
  const env = {
    componentsByNameMap: { holdings: { containersByNameMap: { all: { dataPointsByNameMap: {
      issueName: { value: ["APPLE INC", "NVIDIA CORP"] },
      ticker: { value: ["AAPL", "NVDA"] },
      marketWeight: { value: [6.93, 7.92] },
      ceMarketValue: { value: [58925443785.6, 67347967210.07] },
      ceNotionalValue: { value: [58925443785.6, 67347967210.07] },
      asOfDate: { value: 20261105 },
    } } } } },
  };
  const rows = parseHoldings(env, 239726, null, "IVV");
  expect(rows.map((r) => [r.ticker, r.weightPercent, r.marketValue, r.notionalValue])).toEqual([
    ["NVDA", 7.92, 67347967210.07, 67347967210.07],
    ["AAPL", 6.93, 58925443785.6, 58925443785.6],
  ]);
});

test("fetchHoldingsSkippingErrors yields [] and reports the error when a fund's feed fails", async () => {
  // iShares answers HTTP 500 for some funds' holdings (e.g. IAU); the all-funds scan must skip them.
  const failing = async (_url: string): Promise<unknown> => {
    throw new Error("ishares: HTTP 500");
  };
  const errors: unknown[] = [];
  const rows = await fetchHoldingsSkippingErrors(failing, 239561, "", "IAU", (e) => errors.push(e));
  expect(rows).toEqual([]);
  expect(errors.length).toBe(1);
  // The strict variant (used when the query names its funds) still raises.
  await expect(fetchHoldings(failing, 239561)).rejects.toThrow("HTTP 500");
});

test("fetchHoldingsSkippingErrors passes rows through when the feed succeeds", async () => {
  const fake = FakeIshares.router({ holdings: (d) => holdingsEnvelope(d) });
  const rows = await fetchHoldingsSkippingErrors(fake.get, 239726, "", "IVV");
  expect(rows.length).toBe(2);
});
