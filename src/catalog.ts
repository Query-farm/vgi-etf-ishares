// The `ishares` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). iShares' public product/holdings endpoints are KEYLESS, so — unlike the
// azure workers — there is NO secret type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is
// catalog-qualified (ishares.main.<fn>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments } from "@query-farm/vgi";
import { productsSchema, holdingsSchema, resultColumnsSchema } from "./schema.js";

const REPO = "https://github.com/Query-farm/vgi-etf-ishares";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Local exchange ticker (e.g. IVV).",
  fund_name: "Full fund name as marketed, e.g. 'iShares Core S&P 500 ETF'.",
  isin: "ISIN identifier.",
  cusip: "CUSIP identifier.",
  sedol: "SEDOL identifier.",
  asset_class: "Asset class (Equity, Fixed Income, …).",
  sub_asset_class: "Finer classification within asset_class, e.g. Large Cap, Credit, Inflation.",
  region: "Geographic region.",
  country: "Country exposure.",
  market_type: "Developed / Emerging.",
  investment_style: "e.g. Index.",
  product_view: "Product type(s), comma-joined (etf, mutualfund, …). Filter on this.",
  inception_date: "Fund inception date.",
  nav: "Net asset value per share, in the fund's currency (USD for US-listed funds).",
  nav_as_of: "As-of date for nav.",
  net_assets: "Total net assets (fund AUM) in USD.",
  net_assets_as_of: "As-of date for net_assets.",
  expense_ratio_percent: "Expense ratio, percent points (0.03 = 0.03%).",
  management_fee_percent: "Management fee, percent points.",
  net_expense_ratio_percent: "Net expense ratio, percent points.",
  thirty_day_sec_yield_percent: "30-day SEC yield, percent points.",
  twelve_month_yield_percent: "Trailing 12-month yield, percent points.",
  ytd_return_percent: "Year-to-date return, percent points.",
  nav_return_1y_percent: "Annualized 1-year NAV return, percent points.",
  nav_return_3y_percent: "Annualized 3-year NAV return, percent points.",
  nav_return_5y_percent: "Annualized 5-year NAV return, percent points.",
  nav_return_10y_percent: "Annualized 10-year NAV return, percent points.",
  nav_return_since_inception_percent: "Annualized since-inception NAV return, percent points.",
  price_return_1y_percent: "Annualized 1-year market-price return, percent points.",
  price_return_3y_percent: "Annualized 3-year market-price return, percent points.",
  price_return_5y_percent: "Annualized 5-year market-price return, percent points.",
  price_return_10y_percent: "Annualized 10-year market-price return, percent points.",
  price_return_since_inception_percent: "Annualized since-inception market-price return, percent points.",
  product_page_url: "Path to the fund page on ishares.com.",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "screener",
    "expense ratio",
    "net assets",
    "ticker",
  ]),
  "vgi.doc_llm":
    "The iShares product catalog as a plain table (query it directly, no arguments): one row per " +
    "US fund with ticker, name, identifiers, classification, net assets, NAV, expense ratio, " +
    "yields, and annualized returns. It returns every product type — narrow it with a WHERE clause " +
    "on product_view, asset_class, ticker, and so on. Percent columns hold percent points (0.03 " +
    "means 0.03%). Start here to find a fund's ticker for the other functions.",
  "vgi.doc_md":
    "## products\n\n" +
    "The iShares US product catalog as a base table — one row per fund. It takes no arguments; " +
    "query it directly and filter with a WHERE clause (e.g. `WHERE product_view = 'etf' ORDER BY " +
    "net_assets DESC`; see the example queries). " +
    "It returns every product type; narrow it on product_view, ticker, asset_class, and so on. " +
    "Percent columns (`*_percent`) are in **percent points** (an expense ratio of 0.03 means " +
    "0.03%). The ticker column is the key for the other functions.",
  "vgi.example_queries": JSON.stringify([
    { description: "Ten largest iShares ETFs by net assets", sql: "SELECT ticker, fund_name, net_assets FROM ishares.main.products WHERE product_view = 'etf' ORDER BY net_assets DESC LIMIT 10" },
    { description: "Cheapest bond ETFs by expense ratio", sql: "SELECT ticker, fund_name, expense_ratio_percent FROM ishares.main.products WHERE asset_class = 'Fixed Income' ORDER BY expense_ratio_percent LIMIT 10" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, fund_name, expense_ratio_percent FROM ishares.main.products WHERE ticker = 'IVV'" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. IVV) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  as_of_date: "Holdings as-of date — set it via time travel: AT (TIMESTAMP => DATE '…').",
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
  weight_percent: "Percent of the fund, 0–100 (7.38 = 7.38%; weights sum to ~100).",
  market_value: "Market value held, in the fund's currency.",
  notional_value: "Notional value held, in the fund's currency.",
  units_held: "Quantity held — shares, units, or par (contract-dependent).",
  price: "Unit price of the holding, in the fund's currency.",
  accrual_date: "Accrual date, when applicable.",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  maturity_date: "Maturity date (fixed income only).",
  duration: "Duration in years (fixed income only).",
  ytm_percent: "Yield to maturity, percent points (fixed income only).",
  par_value: "Par value (fixed income only).",
  market_currency: "Market currency (fixed income only).",
};

/** Table-level metadata for the holdings base table (ticker-partitioned, time-travel). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "as of date",
    "time travel",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed portfolio holdings for iShares funds as a hive-partitioned, time-travel table. It is " +
    "partitioned by fund_ticker (the FUND's ticker, distinct from the constituent `ticker` column): " +
    "filter `WHERE fund_ticker = '…'` (or `fund_ticker IN (…)`) to pick funds, or scan with no " +
    "filter to stream EVERY fund's holdings (hundreds of funds — slow, so prefer a filter). The " +
    "as-of date is a time-travel coordinate: omit it for the latest holdings, or read a past day " +
    "with `AT (TIMESTAMP => DATE '2025-12-31')` — any business day back to ~inception, not just the " +
    "featured holding_dates. Rows come back weight-descending; weight_percent is in percent points " +
    "(7.38 = 7.38%); fixed-income funds also fill coupon/maturity/duration/ytm. Join " +
    "on fund_ticker to products.ticker for fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed fund holdings as a **hive-partitioned, time-travel table**. Partitioned by " +
    "`fund_ticker` (the fund's ticker) with the as-of date as the **time-travel version**. " +
    "`fund_ticker` is distinct from `ticker` (the constituent's own ticker). Filter " +
    "`WHERE fund_ticker = 'IVV'` for one fund's latest holdings, or read a past date with " +
    "`AT (TIMESTAMP => DATE '2025-12-31')` (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('IVV','AGG')` fans out per partition; an unfiltered scan streams every " +
    "fund (hundreds of partitions — slow). `weight_percent` is in percent points (7.38 = 7.38%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": JSON.stringify([
    { description: "Top 10 current holdings of IVV", sql: "SELECT ticker, name, weight_percent FROM ishares.main.holdings WHERE fund_ticker = 'IVV' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "IVV holdings as of a past date (time travel)", sql: "SELECT ticker, weight_percent FROM ishares.main.holdings AT (TIMESTAMP => DATE '2025-12-31') WHERE fund_ticker = 'IVV'" },
    { description: "Two funds at once (partition fan-out)", sql: "SELECT ticker, name, weight_percent FROM ishares.main.holdings WHERE fund_ticker IN ('IVV', 'AGG')" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "iShares ETFs",
  "vgi.doc_llm":
    "iShares (BlackRock) US fund data as SQL tables and table functions. Reach for it to screen the fund " +
    "lineup on key facts (net assets, fees, yields, returns), to inspect what a fund holds — " +
    "including on historical dates, so you can measure how a portfolio changed over time — and " +
    "to pull per-fund history like distributions and daily NAV. " +
    "The central concept is the fund, identified by its exchange ticker " +
    "(e.g. IVV); start from the catalog to find that key, then drill into a specific fund. Data " +
    "is iShares' public product feed: best-effort, for informational use.",
  "vgi.doc_md":
    "## iShares ETFs\n\n" +
    "iShares (BlackRock) US fund data, exposed as DuckDB tables and table functions.\n\n" +
    "Two ideas run through everything. First, the **fund** is the unit of the data and is keyed " +
    "by an exchange `ticker` (e.g. `IVV`) — begin at the catalog to " +
    "discover that key, then drill into a fund. Second, fund holdings are **point-in-time**: you " +
    "can ask for a fund's constituents as of any past business day, which makes day-over-day " +
    "portfolio comparison possible.\n\n" +
    "Data is provided for informational use; review iShares' " +
    "terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "iShares",
    "BlackRock",
    "holdings",
    "portfolio",
    "fund",
    "NAV",
    "distributions",
    "dividends",
    "expense ratio",
    "index fund",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No
  // expected_result — iShares data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "largest_etfs",
      description: "The largest iShares ETFs by net assets",
      sql: "SELECT ticker, fund_name, net_assets FROM ishares.main.products ORDER BY net_assets DESC LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the iShares Core S&P 500 ETF",
      sql: "SELECT ticker, name, weight_percent FROM ishares.main.holdings WHERE fund_ticker = 'IVV' ORDER BY weight_percent DESC LIMIT 5",
    },
  ]),
  // Agent-suitability suite (catalog only). Each task carries a deterministic check_sql that
  // asserts specific ground truth; reference_sql is deliberately omitted (live data + free-form
  // analyst queries won't reproduce an exact result set). success_criteria records what a
  // correct answer looks like for the LLM judge.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "ivv_exists",
      prompt: "Does iShares offer an ETF with the ticker IVV, and what is it called?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.products WHERE ticker = 'IVV'",
      success_criteria: "The answer confirms IVV is the iShares Core S&P 500 ETF, found via the products function.",
    },
    {
      name: "ivv_top_holding",
      prompt: "What is the single largest holding of the iShares Core S&P 500 ETF (IVV) right now?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.holdings WHERE fund_ticker = 'IVV'",
      success_criteria: "The answer names IVV's top holding by weight, obtained from the holdings table.",
    },
    {
      name: "ivv_holdings_past_date",
      prompt: "What were the top holdings of IVV as of the end of 2025?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.holdings AT (TIMESTAMP => DATE '2025-12-31') WHERE fund_ticker = 'IVV'",
      success_criteria: "The answer reports IVV's holdings as of 2025-12-31 using the holdings table's AT time travel.",
    },
    {
      name: "ivv_holdings_scan",
      prompt: "Using the holdings backing scan function (call it with parentheses), list a few IVV constituents by weight.",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.holdings() WHERE fund_ticker = 'IVV'",
      success_criteria: "The answer returns IVV constituents via the holdings() backing scan function filtered by ticker.",
    },
    {
      name: "ivv_expense_ratio",
      prompt: "What is the expense ratio of the iShares Core S&P 500 ETF (IVV)?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.products WHERE ticker = 'IVV' AND expense_ratio_percent IS NOT NULL",
      success_criteria: "The answer reports IVV's expense ratio (a small percentage) from the products function.",
    },
    {
      name: "ivv_tracked_index",
      prompt: "Which index does the iShares Core S&P 500 ETF (IVV) track?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.fund_details('IVV') WHERE index_name IS NOT NULL",
      success_criteria: "The answer names IVV's tracked index (the S&P 500), obtained from the fund_details function.",
    },
    {
      name: "ivv_recent_nav",
      prompt: "What was the iShares Core S&P 500 ETF's (IVV) net asset value on its most recent valuation date?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.nav_history('IVV') WHERE nav > 0",
      success_criteria: "The answer reports a recent IVV NAV per share, obtained from the nav_history function.",
    },
    {
      name: "ivv_last_distribution",
      prompt: "When did the iShares Core S&P 500 ETF (IVV) most recently pay a distribution, and how much?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.distributions('IVV')",
      success_criteria: "The answer gives IVV's most recent distribution (ex-date and per-share amount) from the distributions function.",
    },
    {
      name: "ivv_holdings_dates",
      prompt: "Which recent holdings as-of dates does iShares feature for the Core S&P 500 ETF (IVV)?",
      check_sql: "SELECT count(*) > 0 FROM ishares.main.holding_dates('IVV')",
      success_criteria: "The answer lists one or more featured holdings dates for IVV from the holding_dates function.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "iShares Fund Data",
  "vgi.doc_llm":
    "Functions that return iShares fund data at two levels. At the catalog level you screen the " +
    "whole lineup on key facts and resolve a fund's key. At the fund level you drill into one " +
    "fund — its holdings (for any past business day, enabling day-over-day comparison), its " +
    "characteristics, and its distribution and NAV history. A fund is keyed by its exchange " +
    "`ticker` (e.g. `IVV`); resolve the key at the catalog level first.",
  "vgi.doc_md":
    "## iShares fund data\n\n" +
    "Work happens at two levels. **Catalog level:** screen the lineup on key facts and find a " +
    "fund's key. **Fund level:** drill into a single fund — its constituents, characteristics, " +
    "and time series. A fund is keyed by its exchange `ticker` (e.g. `IVV`).\n\n" +
    "Holdings are point-in-time: request a fund's constituents as of any past business day to " +
    "compare a portfolio across dates.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "NAV history", "distributions", "portfolio"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The product list and per-fund characteristics." },
    { name: "holdings", title: "Holdings", description: "Detailed portfolio holdings and their available dates." },
    { name: "history", title: "History", description: "Per-fund distribution and daily NAV time series." },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "Ten largest iShares ETFs by net assets", sql: "SELECT ticker, fund_name, net_assets FROM ishares.main.products ORDER BY net_assets DESC LIMIT 10" },
    { description: "Top holdings of IVV", sql: "SELECT ticker, name, weight_percent FROM ishares.main.holdings WHERE fund_ticker = 'IVV' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Recent daily NAV history for IVV", sql: "SELECT as_of_date, nav FROM ishares.main.nav_history('IVV', start_date := DATE '2026-01-01') ORDER BY as_of_date DESC" },
  ]),
};

/**
 * @param functions    the callable table functions (holding_dates, fund_details, distributions,
 *                      nav_history) — NOT products or holdings, which are base tables.
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown/time-travel scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch but exposed to DuckDB only as tables.
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "ishares",
    defaultSchema: "main",
    comment:
      "iShares (BlackRock) US fund data as DuckDB tables: products (catalog) & holdings " +
      "(ticker-partitioned, time-travel) tables, plus fund_details, distributions, nav_history — vgi-etf-ishares",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "iShares fund data: product catalog, detailed holdings, and per-fund history.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // Each fund has a unique ISIN (advisory — not enforced on scan).
            primaryKey: [["isin"]],
            // The US product catalog is ~530 funds (all product types); headroom to ~700.
            inlinedCardinality: { estimate: 530n, max: 700n },
            comment:
              "Every iShares US product with its key facts, one row per fund. Query directly " +
              "(no arguments) and filter with WHERE; percent columns are in percent points.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // fund_ticker and as_of_date are always populated (the scan stamps every row with its
            // fund and the resolved as-of date).
            notNull: ["fund_ticker", "as_of_date"],
            // Advisory composite key (NOT enforced on scan): a holdings row is one constituent of
            // one fund on one as-of date, so (fund_ticker, as_of_date, ticker) is how an agent
            // references a row. `ticker` completes the key for securities; a small number of
            // non-equity line items (cash, derivatives) carry a null constituent ticker.
            primaryKey: [["fund_ticker", "as_of_date", "ticker"]],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all partitions).
            // The as-of date is the time-travel coordinate: AT (TIMESTAMP => DATE '…').
            supportsTimeTravel: true,
            // Whole-table estimate: ~530 funds × ~500 constituents each. A single-fund filter
            // scans one partition (~500 rows); a bond fund like AGG can reach ~13,258.
            inlinedCardinality: { estimate: 265000n, max: 400000n },
            comment:
              "Detailed fund holdings, hive-partitioned by fund_ticker (filter WHERE fund_ticker = … for " +
              "one fund, or scan unfiltered for all) with the as-of date as a time-travel coordinate " +
              "(AT (TIMESTAMP => DATE '…')).",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}
