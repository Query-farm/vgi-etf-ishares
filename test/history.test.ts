// Archetype proof for the per-fund history/detail drivers: fund_details (keyFundFacts +
// fundamentalsAndRisk), distributions, and nav_history. SDK-free.

import { test, expect } from "bun:test";
import {
  parseFundDetails,
  parseDistributions,
  parseNavHistory,
  fetchFundDetails,
  fetchDistributions,
  fetchNavHistory,
} from "../src/ishares.js";
import {
  FakeIshares,
  keyFundFactsEnvelope,
  fundamentalsEnvelope,
  fundHeaderEnvelope,
  fundDownloadEnvelope,
} from "./fake-ishares.js";

test("parseFundDetails merges keyFundFacts + fundamentalsAndRisk + fundHeader into one row", () => {
  const row = parseFundDetails(keyFundFactsEnvelope(), fundamentalsEnvelope(), fundHeaderEnvelope(), 239726);
  expect(row.portfolioId).toBe(239726);
  expect(row.ticker).toBe("IVV");
  expect(row.fundName).toBe("iShares Core S&P 500 ETF");
  expect(row.exchange).toBe("NYSE Arca");
  expect(row.indexName).toBe("S&P 500 Index (USD)");
  expect(row.indexTicker).toBe("SPTR");
  expect(row.distributionFrequency).toBe("Quarterly");
  expect(row.closingPrice).toBe(751.08);
  expect(row.sharesOutstanding).toBe(1182200000.0);
  expect(row.medianBidAskSpreadPercent).toBe(0.01); // "0.01%" parsed to a number
  expect(row.launchDate).toBe(Math.floor(Date.UTC(2000, 4, 15) / 1000));
  // from fundamentalsAndRisk
  expect(row.numHoldings).toBe(509);
  expect(row.peRatio).toBe(26.5);
  expect(row.pbRatio).toBe(4.8);
  expect(row.beta3y).toBe(1.0);
  expect(row.standardDeviation3yPercent).toBe(17.2);
  // narrative from fundHeader.content: objective is decoded plain text, key_benefits stays HTML
  expect(row.objective).toBe(
    "The iShares Core S&P 500 ETF seeks to track the investment results of an index composed of large-capitalization U.S. equities.",
  );
  expect(row.keyBenefitsHtml).toContain("<strong>Exposure</strong>");
});

test("parseFundDetails degrades to nulls on empty envelopes", () => {
  const row = parseFundDetails({}, {}, {}, 5);
  expect(row.portfolioId).toBe(5);
  expect(row.indexName).toBeNull();
  expect(row.numHoldings).toBeNull();
  expect(row.objective).toBeNull();
  expect(row.keyBenefitsHtml).toBeNull();
});

test("parseDistributions maps the distribution history", () => {
  const rows = parseDistributions(fundDownloadEnvelope(), 239726);
  expect(rows.length).toBe(2);
  const d0 = rows[0]!;
  expect(d0.exDate).toBe(Math.floor(Date.UTC(2026, 5, 15) / 1000));
  expect(d0.payableDate).toBe(Math.floor(Date.UTC(2026, 5, 18) / 1000));
  expect(d0.totalDistribution).toBe(1.995653);
  expect(d0.income).toBe(1.995653);
  expect(d0.longTermCapitalGain).toBe(0.0);
});

test("parseNavHistory maps the daily NAV series and nulls '-' ex-dividends", () => {
  const rows = parseNavHistory(fundDownloadEnvelope(), 239726);
  expect(rows.length).toBe(2);
  expect(rows[0]!.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(rows[0]!.nav).toBe(751.2);
  expect(rows[0]!.exDividends).toBeNull(); // "-" cell
  expect(rows[0]!.sharesOutstanding).toBe(1182200000.0);
});

test("fetchFundDetails requests all three components (fundHeader with content)", async () => {
  const fake = FakeIshares.router({
    keyFundFacts: keyFundFactsEnvelope(),
    fundamentalsAndRisk: fundamentalsEnvelope(),
    fundHeader: fundHeaderEnvelope(),
  });
  const row = await fetchFundDetails(fake.get, 239726);
  expect(row.numHoldings).toBe(509);
  expect(row.objective).toContain("seeks to track");
  expect(fake.calls.length).toBe(3);
  expect(fake.calls.some((u) => u.includes("component=keyFundFacts"))).toBe(true);
  expect(fake.calls.some((u) => u.includes("component=fundamentalsAndRisk"))).toBe(true);
  // the fundHeader fetch must request content (excludeContent=false)
  expect(fake.calls.some((u) => u.includes("component=fundHeader") && u.includes("excludeContent=false"))).toBe(true);
});

test("parseDistributions bounds rows by ex-date [start, end]", () => {
  const start = Math.floor(Date.UTC(2026, 3, 1) / 1000); // Apr 1 2026 → drops the Mar 17 row
  const rows = parseDistributions(fundDownloadEnvelope(), 239726, start, null);
  expect(rows.length).toBe(1);
  expect(rows[0]!.exDate).toBe(Math.floor(Date.UTC(2026, 5, 15) / 1000));
});

test("parseNavHistory bounds rows by as-of date [start, end]", () => {
  const end = Math.floor(Date.UTC(2026, 6, 6) / 1000); // Jul 6 → drops the Jul 7 row
  const rows = parseNavHistory(fundDownloadEnvelope(), 239726, null, end);
  expect(rows.length).toBe(1);
  expect(rows[0]!.asOfDate).toBe(end);
});

test("fetchDistributions and fetchNavHistory both read fundDownload", async () => {
  const fake = FakeIshares.router({ fundDownload: fundDownloadEnvelope() });
  expect((await fetchDistributions(fake.get, 239726)).length).toBe(2);
  expect((await fetchNavHistory(fake.get, 239726)).length).toBe(2);
  expect(fake.calls.every((u) => u.includes("component=fundDownload"))).toBe(true);
});
