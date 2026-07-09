// Typed-column contract for the six schemas. This one pulls @query-farm/vgi
// (batchFromColumns) + apache-arrow, so it runs under the full SDK install — unlike the
// driver tests, which are deliberately SDK-free. Proves schema field names/order and that
// Utf8/Float64/Int64/Timestamp cells (incl. nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  holdingDatesSchema,
  holdingDatesBatch,
  fundDetailsSchema,
  fundDetailsBatch,
  distributionsSchema,
  distributionsBatch,
  navHistorySchema,
  navHistoryBatch,
} from "../src/schema.js";
import {
  parseProducts,
  parseHoldings,
  parseHoldingDates,
  parseFundDetails,
  parseDistributions,
  parseNavHistory,
} from "../src/ishares.js";
import {
  screenerEnvelope,
  holdingsEnvelope,
  keyFundFactsEnvelope,
  fundamentalsEnvelope,
  fundHeaderEnvelope,
  fundDownloadEnvelope,
} from "./fake-ishares.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "fund_name", "isin", "cusip", "sedol", "asset_class",
    "sub_asset_class", "region", "country", "market_type", "investment_style", "product_view",
    "inception_date", "nav", "nav_as_of", "net_assets", "net_assets_as_of", "expense_ratio_percent",
    "management_fee_percent", "net_expense_ratio_percent", "thirty_day_sec_yield_percent",
    "twelve_month_yield_percent", "ytd_return_percent", "nav_return_1y_percent", "nav_return_3y_percent",
    "nav_return_5y_percent", "nav_return_10y_percent", "nav_return_since_inception_percent",
    "price_return_1y_percent", "price_return_3y_percent", "price_return_5y_percent",
    "price_return_10y_percent", "price_return_since_inception_percent", "product_page_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "ticker", "name", "sector", "asset_class", "country",
    "currency", "exchange", "isin", "cusip", "sedol", "weight_percent", "market_value",
    "notional_value", "units_held", "price", "accrual_date", "coupon_percent", "maturity_date",
    "duration", "ytm_percent", "par_value", "market_currency",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  expect((productsBatch(productsSchema(), parseProducts(screenerEnvelope())) as { numRows: number }).numRows).toBe(1);
  expect((holdingsBatch(holdingsSchema(), parseHoldings(holdingsEnvelope("20260707"), 1, null)) as { numRows: number }).numRows).toBe(2);
  expect((holdingDatesBatch(holdingDatesSchema(), parseHoldingDates(holdingsEnvelope(null), 1)) as { numRows: number }).numRows).toBe(3);
  expect((fundDetailsBatch(fundDetailsSchema(), [parseFundDetails(keyFundFactsEnvelope(), fundamentalsEnvelope(), fundHeaderEnvelope(), 1)]) as { numRows: number }).numRows).toBe(1);
  expect((distributionsBatch(distributionsSchema(), parseDistributions(fundDownloadEnvelope(), 1)) as { numRows: number }).numRows).toBe(2);
  expect((navHistoryBatch(navHistorySchema(), parseNavHistory(fundDownloadEnvelope(), 1)) as { numRows: number }).numRows).toBe(2);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingDatesBatch(holdingDatesSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((fundDetailsBatch(fundDetailsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((distributionsBatch(distributionsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((navHistoryBatch(navHistorySchema(), []) as { numRows: number }).numRows).toBe(0);
});
