// Composed example queries — each combines two or more of the worker's own objects (the holdings
// table read at two dates or for two funds, holdings joined to products, distributions with
// nav_history and products). Each SQL is defined once here and referenced from both the
// schema-level vgi.example_queries list (catalog.ts) and the example list of the object that
// drives the query, so the copies can't drift.

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** holdings × holdings AT (…): how IVV's largest positions moved since the 2025 year-end. */
export const HOLDINGS_DRIFT_EXAMPLE: ExampleQuery = {
  description:
    "Portfolio drift: IVV's ten largest current stock holdings beside their weight on 2025-12-31 " +
    "(the holdings table joined to itself read AT that date, matched on ISIN) and the change in " +
    "percentage points",
  sql:
    "WITH cur AS (SELECT isin, ticker, name, weight_percent FROM ishares.main.holdings WHERE fund_ticker = 'IVV' AND asset_class = 'Equity'), " +
    "prev AS (SELECT isin, weight_percent FROM ishares.main.holdings AT (TIMESTAMP => DATE '2025-12-31') WHERE fund_ticker = 'IVV' AND asset_class = 'Equity') " +
    "SELECT cur.ticker, cur.name, round(prev.weight_percent, 2) AS weight_2025_12_31, round(cur.weight_percent, 2) AS weight_now, " +
    "round(cur.weight_percent - prev.weight_percent, 2) AS change_pp " +
    "FROM cur LEFT JOIN prev USING (isin) ORDER BY cur.weight_percent DESC, cur.ticker LIMIT 10",
};

/** holdings for two funds, self-joined: how much of IVV and IUSG is the same portfolio. */
export const FUND_OVERLAP_EXAMPLE: ExampleQuery = {
  description:
    "Portfolio overlap of IVV (S&P 500) and IUSG (S&P 900 Growth): how many stocks both hold and " +
    "the overlapping weight (sum over shared stocks of the smaller of the two weights, percent points)",
  sql:
    "WITH h AS (SELECT fund_ticker, isin, weight_percent FROM ishares.main.holdings WHERE fund_ticker IN ('IVV', 'IUSG') AND asset_class = 'Equity') " +
    "SELECT count(*) AS shared_stocks, round(sum(least(a.weight_percent, b.weight_percent)), 1) AS overlap_percent " +
    "FROM h a JOIN h b ON a.isin = b.isin WHERE a.fund_ticker = 'IVV' AND b.fund_ticker = 'IUSG'",
};

/** holdings aggregated per bond fund, joined to products for the published SEC yield. */
export const BOND_PORTFOLIO_YIELD_EXAMPLE: ExampleQuery = {
  description:
    "Bond funds bottom-up: weight-averaged yield to maturity and duration computed from the " +
    "holdings of AGG, HYG and TLT, beside each fund's published 30-day SEC yield from products",
  sql:
    "WITH h AS (SELECT fund_ticker, sum(weight_percent * ytm_percent) / sum(weight_percent) AS ytm, sum(weight_percent * duration) / sum(weight_percent) AS dur " +
    "FROM ishares.main.holdings WHERE fund_ticker IN ('AGG', 'HYG', 'TLT') AND ytm_percent IS NOT NULL AND duration IS NOT NULL GROUP BY fund_ticker) " +
    "SELECT p.ticker, p.fund_name, round(h.ytm, 2) AS weighted_ytm_percent, round(h.dur, 2) AS weighted_duration_years, p.thirty_day_sec_yield_percent " +
    "FROM h JOIN ishares.main.products p ON p.ticker = h.fund_ticker ORDER BY weighted_duration_years",
};

/** distributions (last 12 months) ÷ latest nav_history NAV, checked against products. */
export const TTM_YIELD_EXAMPLE: ExampleQuery = {
  description:
    "IVV's trailing-12-month distribution yield recomputed from distributions (per-share payouts " +
    "over the last year) and the latest nav_history NAV, beside the twelve_month_yield_percent " +
    "that products publishes",
  sql:
    "WITH ttm AS (SELECT sum(total_distribution) AS dist FROM ishares.main.distributions('IVV', start_date := CAST(current_date - INTERVAL 1 YEAR AS DATE))), " +
    "nav AS (SELECT max(as_of_date) AS nav_date, arg_max(nav, as_of_date) AS nav FROM ishares.main.nav_history('IVV', start_date := CAST(current_date - INTERVAL 14 DAY AS DATE))) " +
    "SELECT p.ticker, nav.nav_date, round(ttm.dist, 4) AS ttm_distributions, round(nav.nav, 2) AS latest_nav, " +
    "round(100 * ttm.dist / nav.nav, 2) AS computed_ttm_yield_percent, p.twelve_month_yield_percent " +
    "FROM ttm, nav, ishares.main.products p WHERE p.ticker = 'IVV'",
};

/** Every composed example, in the order the schema-level list shows them. */
export const COMPOSED_EXAMPLES: ExampleQuery[] = [
  HOLDINGS_DRIFT_EXAMPLE,
  FUND_OVERLAP_EXAMPLE,
  BOND_PORTFOLIO_YIELD_EXAMPLE,
  TTM_YIELD_EXAMPLE,
];
