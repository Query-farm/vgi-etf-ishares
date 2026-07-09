// Archetype proof for ishares.products: the screener driver. Imports ONLY our own src +
// the fake — NO @query-farm/* — so it runs without the SDK installed. Proves { d, r } and
// sentinel coercion, productView filtering, and the screener URL contract.

import { test, expect } from "bun:test";
import { parseProducts, fetchProducts, num, disp, ymd, SCREENER_URL } from "../src/ishares.js";
import { FakeIshares, screenerEnvelope } from "./fake-ishares.js";

test("num reads .r pairs, numeric strings, and rejects sentinels", () => {
  expect(num({ d: "0.03", r: 0.03 })).toBe(0.03);
  expect(num("1,182,200,000")).toBe(1182200000);
  expect(num("-")).toBeNull();
  expect(num(" ")).toBeNull();
  expect(num(null)).toBeNull();
});

test("disp reads display strings and nulls sentinels", () => {
  expect(disp({ d: "May 15, 2000", r: 20000515 })).toBe("May 15, 2000");
  expect(disp("Equity")).toBe("Equity");
  expect(disp("-")).toBeNull();
  expect(disp(" ")).toBeNull();
});

test("ymd converts a YYYYMMDD field to epoch seconds at UTC midnight", () => {
  expect(ymd({ r: 20000515 })).toBe(Math.floor(Date.UTC(2000, 4, 15) / 1000));
  expect(ymd(20260707)).toBe(Math.floor(Date.UTC(2026, 6, 7) / 1000));
  expect(ymd("-")).toBeNull();
  expect(ymd(2026)).toBeNull(); // not 8 digits
});

test("parseProducts maps a product and defaults to the ETF view", () => {
  const rows = parseProducts(screenerEnvelope());
  expect(rows.length).toBe(1); // the mutual fund is filtered out
  const ivv = rows[0]!;
  expect(ivv.portfolioId).toBe(239726);
  expect(ivv.ticker).toBe("IVV");
  expect(ivv.fundName).toBe("iShares Core S&P 500 ETF");
  expect(ivv.sedol).toBeNull(); // "-" sentinel
  expect(ivv.investmentStyle).toBe("Index"); // brackets stripped
  expect(ivv.expenseRatioPercent).toBe(0.03);
  expect(ivv.netAssets).toBe(888066262620.0);
  expect(ivv.navReturn1yPercent).toBe(12.0);
  expect(ivv.priceReturnSinceInceptionPercent).toBe(7.4);
  expect(ivv.inceptionDate).toBe(Math.floor(Date.UTC(2000, 4, 15) / 1000));
  expect(ivv.productView).toBe("etf");
});

test("parseProducts 'all' returns every product type; a specific view filters", () => {
  expect(parseProducts(screenerEnvelope(), "all").length).toBe(2);
  const mf = parseProducts(screenerEnvelope(), "mutualfund");
  expect(mf.length).toBe(1);
  expect(mf[0]!.ticker).toBeNull(); // " " sentinel
  expect(mf[0]!.expenseRatioPercent).toBeNull(); // "-" sentinel
});

test("parseProducts narrows to a single ticker (case-insensitive) across all views", () => {
  const one = parseProducts(screenerEnvelope(), "all", "ivv");
  expect(one.length).toBe(1);
  expect(one[0]!.portfolioId).toBe(239726);
  expect(parseProducts(screenerEnvelope(), "all", "ZZZZ")).toEqual([]);
});

test("parseProducts tolerates junk without throwing", () => {
  expect(parseProducts(null)).toEqual([]);
  expect(parseProducts({ x: 1 })).toEqual([]);
  expect(parseProducts({ "1": { productType: "OTHER" } })).toEqual([]);
});

test("fetchProducts hits the screener URL once", async () => {
  const fake = new FakeIshares(() => screenerEnvelope());
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(1);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toBe(SCREENER_URL);
});
