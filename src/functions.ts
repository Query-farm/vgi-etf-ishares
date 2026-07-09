// The six VGI table functions: products, holdings, holding_dates, fund_details,
// distributions, nav_history. All keyless, all single-shot snapshots — state is just a
// `done` flag (fully serializable; no socket / batch / Date), so the HTTP transport can
// round-trip it. The iShares `get` client is injected so worker.ts wires the real fetch
// and tests wire a fake.

import {
  defineTableFunction,
  ArgumentValidationError,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8, DateDay } from "@query-farm/apache-arrow";
import {
  fetchProducts,
  fetchHoldings,
  fetchHoldingDates,
  fetchFundDetails,
  fetchDistributions,
  fetchNavHistory,
  resolveFund,
  dateArgToYmd,
  dateArgToEpoch,
} from "./ishares.js";
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
  resultColumnsSchema,
} from "./schema.js";

/** The injected HTTP getter: URL in, parsed JSON out. */
export type IsharesGet = (url: string) => Promise<unknown>;

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from each Arrow schema via resultColumnsSchema — replaces the retired markdown tag).

const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the required partition filter.",
  as_of_date: "Holdings as-of date (the time-travel coordinate).",
  ticker: "Constituent ticker (the holding's own ticker; distinct from fund_ticker).",
  name: "Constituent / issue name.",
  sector: "GICS-style sector.",
  asset_class: "Constituent asset class.",
  country: "Country of risk.",
  currency: "Constituent currency.",
  exchange: "Listing exchange.",
  isin: "Constituent ISIN.",
  cusip: "Constituent CUSIP.",
  sedol: "Constituent SEDOL.",
  weight_percent: "Percent of the fund, 0–100 (7.38 = 7.38%).",
  market_value: "Market value held, in the fund's currency.",
  notional_value: "Notional value held, in the fund's currency.",
  units_held: "Quantity held — shares, units, or par.",
  price: "Unit price of the holding.",
  accrual_date: "Accrual date, when applicable.",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  maturity_date: "Maturity date (fixed income only).",
  duration: "Duration in years (fixed income only).",
  ytm_percent: "Yield to maturity, percent points (fixed income only).",
  par_value: "Par value (fixed income only).",
  market_currency: "Market currency (fixed income only).",
};

const HOLDING_DATES_DESCS: Record<string, string> = {
  as_of_date: "An available holdings as-of date.",
};

const FUND_DETAILS_DESCS: Record<string, string> = {
  ticker: "Exchange ticker.",
  fund_name: "Full fund name.",
  asset_class: "Asset class.",
  exchange: "Listing exchange.",
  index_name: "Tracked index name.",
  index_ticker: "Tracked index ticker.",
  cusip: "Fund CUSIP.",
  launch_date: "Fund launch date.",
  distribution_frequency: "e.g. Quarterly.",
  closing_price: "Latest closing price.",
  nav: "Latest NAV per share.",
  premium_discount_percent: "Close vs NAV, percent points.",
  shares_outstanding: "Shares outstanding.",
  total_net_assets: "Fund-level net assets.",
  thirty_day_avg_volume: "30-day average volume.",
  median_bid_ask_spread_percent: "30-day median bid-ask spread, percent points.",
  num_holdings: "Number of holdings.",
  pe_ratio: "Price/earnings ratio (not a percent).",
  pb_ratio: "Price/book ratio (not a percent).",
  beta_3y: "3-year beta (ratio, not a percent).",
  standard_deviation_3y_percent: "3-year standard deviation, percent points.",
  thirty_day_sec_yield_percent: "30-day SEC yield, percent points.",
  twelve_month_yield_percent: "Trailing 12-month yield, percent points.",
  objective: "Investment objective, plain text.",
  key_benefits_html: "Key benefits, raw HTML (per the _html suffix).",
};

const DISTRIBUTIONS_DESCS: Record<string, string> = {
  ex_date: "Ex-dividend date.",
  record_date: "Record date.",
  payable_date: "Payable date.",
  total_distribution: "Total per-share distribution.",
  income: "Income component (per share).",
  short_term_capital_gain: "Short-term capital-gain component (per share).",
  long_term_capital_gain: "Long-term capital-gain component (per share).",
  return_of_capital: "Return-of-capital component (per share).",
};

const NAV_HISTORY_DESCS: Record<string, string> = {
  as_of_date: "Valuation date.",
  nav: "Net asset value per share.",
  ex_dividends: "Ex-dividend amount that day, if any (per share).",
  shares_outstanding: "Shares outstanding.",
};

interface DoneState {
  done: boolean;
}

/** Guard a required string argument; returns the trimmed value or throws ArgumentValidationError. */
function required(fn: string, name: string, v: unknown): string {
  if (v == null || String(v).trim() === "") {
    throw new ArgumentValidationError(`${fn}: ${name} is required`);
  }
  return String(v).trim();
}

/** Resolve a `fund` arg to a portfolioId, raising a typed, discoverable error when a ticker misses. */
async function resolveOrThrow(fn: string, get: IsharesGet, fund: string): Promise<number> {
  const id = await resolveFund(get, fund);
  if (id == null) {
    throw new ArgumentValidationError(
      `${fn}: could not resolve fund '${fund}'. Pass an iShares exchange ticker (e.g. 'IVV'); ` +
        `list valid tickers with SELECT ticker FROM ishares.main.products.`,
    );
  }
  return id;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its resolved portfolioId and its exchange ticker (the partition value). */
interface FundItem {
  id: number;
  ticker: string;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function,
// so users query `FROM ishares.products` (no parens) and filter with WHERE — no arguments.
// This zero-arg scan is registered only for scan dispatch (it is NOT listed among the
// catalog's callable functions). It returns the FULL catalog (every product type); a WHERE on
// `product_view` / `ticker` / `asset_class` narrows it.

export function makeProductsScan(get: IsharesGet) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "iShares US product catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(get, "all");
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column) and time-travelled by as-of date:
//   SELECT * FROM ishares.main.holdings WHERE fund_ticker = 'IVV';
//   SELECT * FROM ishares.main.holdings AT (TIMESTAMP => DATE '2025-12-31') WHERE fund_ticker = 'IVV';
//   SELECT * FROM ishares.main.holdings WHERE fund_ticker IN ('IVV','AGG');   -- fan-out per partition
//   SELECT * FROM ishares.main.holdings;                                      -- ALL funds (every partition)
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE product catalog — resolves each to a portfolioId, and pushes one item per fund
//     onto a BoundStorage work queue keyed by the execution id.
//   • process() pops one fund per tick, fetches its holdings for the AT date, and emits a single
//     partition batch (tagged with vgi_partition_values so DuckDB sees fund_ticker as the key).
// Multiple parallel workers drain the same queue, so the all-funds fan-out is work-stealing and
// bounded by maxWorkers. filterPushdown + being LISTED is what lets DuckDB push fund_ticker here.

export function makeHoldingsScan(get: IsharesGet) {
  const schema = holdingsSchema();
  return defineTableFunction<Record<string, never>, Record<string, never>>({
    name: "holdings_scan",
    description:
      "Backing scan for the holdings table — prefer the `holdings` table (it adds AT time travel " +
      "on the as-of date). Detailed fund holdings, hive-partitioned by fund_ticker: filter WHERE " +
      "fund_ticker = 'IVV' (or fund_ticker IN (…)) for specific funds, or scan with no filter to " +
      "stream every fund's holdings. weight_percent is in percent points; fixed-income funds also " +
      "fill coupon/maturity/duration/ytm.",
    args: {},
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the scan. Each
    // fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund.
    onInit: async ({ initCall, executionId, storage }) => {
      // Pushed fund_ticker value(s) from WHERE (= or IN), if any. Absent → scan all funds.
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const requested = (filters?.getColumnValues("fund_ticker") ?? []).map((t) =>
        String(t).toUpperCase(),
      );
      // Resolve tickers → portfolioIds from the (cached) product catalog. One fetch either way.
      const products = await fetchProducts(get, "all");
      const byTicker = new Map(
        products
          .filter((r) => r.ticker && Number.isFinite(r.portfolioId))
          .map((r) => [String(r.ticker).toUpperCase(), { id: r.portfolioId, ticker: String(r.ticker) }]),
      );
      const targets: FundItem[] =
        requested.length > 0
          ? requested.map((t) => byTicker.get(t)).filter((x): x is FundItem => x != null)
          : [...byTicker.values()];
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Time-travel coordinate: the AT (TIMESTAMP|VERSION) value = the as-of date (empty = latest).
      const asOf = dateArgToYmd(p.atValue);
      // Pop one fund per tick; emit exactly one partition. Skip empty partitions (e.g. a
      // pre-inception date returns no rows) and pop the next. Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        const rows = await fetchHoldings(get, fund.id, asOf, fund.ticker);
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT ticker, name, weight_percent FROM ishares.main.holdings_scan() WHERE fund_ticker = 'IVV' ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of IVV via the backing scan" },
      { sql: "SELECT fund_ticker, count(*) FROM ishares.main.holdings_scan() WHERE fund_ticker IN ('IVV', 'AGG') GROUP BY fund_ticker", description: "Two partitions at once (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The backing scan for the `holdings` table. Prefer querying the `holdings` table, which adds " +
        "AT time travel on the as-of date. Hive-partitioned by fund_ticker (the fund's ticker, " +
        "distinct from the constituent `ticker` column): filter WHERE fund_ticker = '…' (or " +
        "fund_ticker IN (…)) for specific funds, or scan with no filter to stream every fund " +
        "(hundreds of partitions — slow). weight_percent is in percent points (7.38 = 7.38%); " +
        "fixed-income funds also fill coupon/maturity/duration/ytm.",
      "vgi.doc_md":
        "## holdings_scan\n\n" +
        "The backing scan for the **`holdings` table** — prefer the table (it also supports `AT " +
        "(TIMESTAMP => DATE '…')` time travel). Hive-partitioned by `fund_ticker`: filter `WHERE " +
        "fund_ticker = 'IVV'` for one fund, or scan with no filter to stream every fund (see the " +
        "example queries). `fund_ticker` is distinct from the constituent `ticker` column.",
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
    },
  });
}

// ── holding_dates ─────────────────────────────────────────────────────────────

interface FundArgs {
  fund: string;
}

const FUND_ARG_DOC =
  "The fund to look up, given as an exchange " +
  "ticker like 'IVV'. Required, first positional argument.";

export function makeHoldingDatesFunction(get: IsharesGet) {
  const schema = holdingDatesSchema();
  return defineTableFunction<FundArgs, DoneState>({
    name: "holding_dates",
    description:
      "The featured as-of dates iShares surfaces for a fund's holdings (typically the latest " +
      "day plus recent month-/year-ends). `fund` is a ticker (e.g. 'IVV'). Note: holdings() " +
      "also accepts arbitrary business days beyond this list.",
    args: { fund: new Utf8() },
    argDocs: { fund: FUND_ARG_DOC },
    onBind: (p) => {
      required("holding_dates", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const portfolioId = await resolveOrThrow("holding_dates", get, String(p.args.fund));
      const rows = await fetchHoldingDates(get, portfolioId);
      out.emit(holdingDatesBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT as_of_date FROM ishares.main.holding_dates('IVV') ORDER BY as_of_date DESC", description: "Featured holdings dates for IVV" },
      { sql: "SELECT max(as_of_date) AS latest_featured FROM ishares.main.holding_dates('IVV')", description: "The most recent featured holdings date (feed it to holdings())" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The featured holdings as-of dates for a fund (latest plus recent period-ends). Use it to " +
        "discover convenient dates to pass to holdings(); holdings() also accepts any business day, " +
        "so this list is a starting point, not the full set of valid dates.",
      "vgi.doc_md":
        "## holding_dates\n\n" +
        "The as-of dates iShares features for a fund's holdings — the latest day plus recent " +
        "month-/year-ends. Use it to pick a date for `holdings()`.\n\n" +
        "This is *not* the full set of valid dates: `holdings` accepts any business day back to " +
        "inception, not just these (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(holdingDatesSchema(), HOLDING_DATES_DESCS),
    },
  });
}

// ── fund_details ──────────────────────────────────────────────────────────────

export function makeFundDetailsFunction(get: IsharesGet) {
  const schema = fundDetailsSchema();
  return defineTableFunction<FundArgs, DoneState>({
    name: "fund_details",
    description:
      "A wide one-row snapshot of a single fund's key facts and portfolio characteristics: " +
      "exchange, tracked index, shares outstanding, premium/discount, 30-day average volume, " +
      "median bid-ask spread, number of holdings, P/E, P/B, 3-year beta & standard deviation, " +
      "yields, and the fund's investment objective and key benefits. `fund` is a ticker " +
      "or ticker.",
    args: { fund: new Utf8() },
    argDocs: { fund: FUND_ARG_DOC },
    onBind: (p) => {
      required("fund_details", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const portfolioId = await resolveOrThrow("fund_details", get, String(p.args.fund));
      const row = await fetchFundDetails(get, portfolioId);
      out.emit(fundDetailsBatch(schema, [row]));
      state.done = true;
    },
    examples: [
      { sql: "SELECT ticker, index_name, num_holdings, pe_ratio FROM ishares.main.fund_details('IVV')", description: "Key characteristics for IVV" },
      { sql: "SELECT ticker, premium_discount_percent, median_bid_ask_spread_percent FROM ishares.main.fund_details('IVV')", description: "Trading quality: premium/discount and spread" },
      { sql: "SELECT objective FROM ishares.main.fund_details('IVV')", description: "The fund's investment objective (plain text)" },
    ],
    tags: {
      "vgi.category": "catalog",
      "vgi.doc_llm":
        "One-row detail snapshot for a fund: index tracked, shares outstanding, premium/discount, " +
        "trading volume, bid-ask spread, holdings count, valuation ratios (P/E, P/B), 3-year beta " +
        "and standard deviation, yields, and the investment objective plus key benefits. Deeper than " +
        "the wide-but-shallow products row for a single fund; percent columns are in percent points. " +
        "`objective` is plain text; `key_benefits_html` is raw HTML (per the _html suffix).",
      "vgi.doc_md":
        "## fund_details\n\n" +
        "A wide one-row snapshot of a fund's key facts and characteristics — the details beyond what " +
        "`products` carries (index, spread, valuation, risk, and the fund's narrative). Percent " +
        "columns are in percent points. `objective` is clean plain text; `key_benefits_html` is raw " +
        "HTML (the `_html` suffix signals the format).\n\n" +
        "It returns exactly one row; for the whole lineup use `products` (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(fundDetailsSchema(), FUND_DETAILS_DESCS),
    },
  });
}

// ── distributions ─────────────────────────────────────────────────────────────

interface HistoryArgs {
  fund: string;
  start_date: Date | null;
  end_date: Date | null;
}

const RANGE_DOCS = {
  start_date:
    "Optional inclusive lower bound on the day range — omit for no lower bound. Filters " +
    "client-side.",
  end_date:
    "Optional inclusive upper bound on the day range — omit for no upper bound. Named end_date " +
    "because END is a reserved SQL keyword.",
};

export function makeDistributionsFunction(get: IsharesGet) {
  const schema = distributionsSchema();
  return defineTableFunction<HistoryArgs, DoneState>({
    name: "distributions",
    description:
      "Full distribution history for a fund — one row per distribution with ex/record/payable " +
      "dates and the per-share total split into income, short- and long-term capital gains, and " +
      "return of capital. `fund` is a ticker; bound the ex-date range with " +
      "start_date/end_date.",
    args: { fund: new Utf8(), start_date: new DateDay(), end_date: new DateDay() },
    argDefaults: { start_date: null, end_date: null },
    argDocs: { fund: FUND_ARG_DOC, ...RANGE_DOCS },
    onBind: (p) => {
      required("distributions", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const portfolioId = await resolveOrThrow("distributions", get, String(p.args.fund));
      const rows = await fetchDistributions(
        get,
        portfolioId,
        dateArgToEpoch(p.args.start_date),
        dateArgToEpoch(p.args.end_date),
      );
      out.emit(distributionsBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT ex_date, total_distribution FROM ishares.main.distributions('IVV') ORDER BY ex_date DESC LIMIT 8", description: "Recent IVV distributions" },
      { sql: "SELECT sum(total_distribution) AS ttm_income FROM ishares.main.distributions('IVV', start_date := DATE '2025-01-01')", description: "Total distributions since a start date" },
    ],
    tags: {
      "vgi.category": "history",
      "vgi.doc_llm":
        "Distribution (dividend) history for a fund: ex/record/payable dates and the per-share " +
        "amount broken into income, short/long-term capital gains, and return of capital. Amounts " +
        "are per-share dollars, not percents. Bound the ex-date range with start_date/end_date. Use " +
        "it for dividend analysis and yield reconstruction.",
      "vgi.doc_md":
        "## distributions\n\n" +
        "Full distribution history, one row per distribution. Amounts are **per-share** dollars (not " +
        "percentages). Bound the ex-date range with `start_date`/`end_date` (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(distributionsSchema(), DISTRIBUTIONS_DESCS),
    },
  });
}

// ── nav_history ─────────────────────────────────────────────────────────────

export function makeNavHistoryFunction(get: IsharesGet) {
  const schema = navHistorySchema();
  return defineTableFunction<HistoryArgs, DoneState>({
    name: "nav_history",
    description:
      "Daily net-asset-value history for a fund back to inception — one row per business day " +
      "with NAV per share, ex-dividend amount (when any), and shares outstanding. `fund` is a " +
      "ticker; bound the range with start_date/end_date (recommended, as old " +
      "funds return thousands of rows).",
    args: { fund: new Utf8(), start_date: new DateDay(), end_date: new DateDay() },
    argDefaults: { start_date: null, end_date: null },
    argDocs: { fund: FUND_ARG_DOC, ...RANGE_DOCS },
    onBind: (p) => {
      required("nav_history", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const portfolioId = await resolveOrThrow("nav_history", get, String(p.args.fund));
      const rows = await fetchNavHistory(
        get,
        portfolioId,
        dateArgToEpoch(p.args.start_date),
        dateArgToEpoch(p.args.end_date),
      );
      out.emit(navHistoryBatch(schema, rows));
      state.done = true;
    },
    examples: [
      { sql: "SELECT as_of_date, nav FROM ishares.main.nav_history('IVV', start_date := DATE '2026-01-01') ORDER BY as_of_date DESC", description: "IVV NAV since the start of the year" },
      { sql: "SELECT as_of_date, ex_dividends FROM ishares.main.nav_history('IVV') WHERE ex_dividends > 0 ORDER BY as_of_date DESC", description: "Days IVV went ex-dividend" },
    ],
    tags: {
      "vgi.category": "history",
      "vgi.doc_llm":
        "Daily NAV time series for a fund back to inception: NAV per share, ex-dividend amounts, " +
        "and shares outstanding. Use it for NAV-based return series, drawdowns, and asset-growth " +
        "analysis. This is fund NAV, not market-price candles — for traded prices use a market-data " +
        "source. Old funds return thousands of rows, so bound with start_date/end_date.",
      "vgi.doc_md":
        "## nav_history\n\n" +
        "Daily NAV history back to inception, one row per business day. This is **fund NAV**, not a " +
        "market-price candle series. Old funds return thousands of rows — bound with " +
        "`start_date`/`end_date` (see the example queries).",
      "vgi.result_columns_schema": resultColumnsSchema(navHistorySchema(), NAV_HISTORY_DESCS),
    },
  });
}
