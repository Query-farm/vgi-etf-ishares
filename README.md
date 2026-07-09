# vgi-etf-ishares

A [VGI](https://query.farm) worker that exposes **iShares (BlackRock)** US fund data as DuckDB
tables and table functions — the full product catalog, a partitioned/time-travel holdings
table, and per-fund distribution and NAV history.

| Object | What it returns | iShares source |
| --- | --- | --- |
| `ishares.products` (table) | Every US product with key facts, one row per fund | product screener |
| `ishares.holdings` (table) | Detailed holdings, partitioned by fund_ticker + AT time travel | `get-product-data` `holdings.all` |
| `ishares.holding_dates(fund)` | Featured holdings as-of dates for a fund | `holdings.all` `dateList` |
| `ishares.fund_details(fund)` | Wide one-row characteristics snapshot | `keyFundFacts` + `fundamentalsAndRisk` |
| `ishares.distributions(fund, start_date, end_date)` | Full distribution (dividend) history | `fundDownload` |
| `ishares.nav_history(fund, start_date, end_date)` | Daily NAV history back to inception | `fundDownload` |

Everything rides iShares' public JSON planes — there is no secret to create and
no login. Funds are identified by their exchange **ticker** (e.g. `IVV`); the fund-scoped
functions resolve a ticker via one product-screener lookup. (iShares' internal portfolio id is
not exposed — ticker is sufficient.)

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE as_of_date = DATE '2026-06-30'`.
- **Percent columns carry a `_percent` suffix and hold percent points**: `expense_ratio_percent`
  = 0.03 means 0.03%; `weight_percent` = 7.38 means 7.38% (weights sum to ~100).

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real
> DuckDB + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Install / attach

### Option A — prebuilt binary (recommended)

Each release ships a self-contained executable per platform, so the host needs **neither Bun
nor `node_modules`**. Archives are named `vgi-etf-ishares-<tag>-<platform>.tar.gz` for
`linux_amd64`, `linux_arm64`, `osx_amd64`, `osx_arm64`, and `windows_amd64`, each with a
SHA256, a keyless **cosign** signature, and a **SLSA** build-provenance attestation.

```bash
tar xzf vgi-etf-ishares-v0.1.0-osx_arm64.tar.gz     # → vgi-etf-ishares-worker
```

```sql
LOAD vgi;
ATTACH 'ishares' AS ishares (TYPE vgi, LOCATION '/path/to/vgi-etf-ishares-worker');
```

### Option B — from source (Bun)

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'ishares' AS ishares (TYPE vgi, LOCATION '/path/to/vgi-etf-ishares/bin/vgi-etf-ishares-worker');
```

`bin/vgi-etf-ishares-worker` is a small wrapper that launches `src/worker.ts` under Bun.

## Usage

### products — the fund catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole catalog
(every product type); filter with `WHERE`.

```sql
-- Ten largest iShares ETFs by net assets:
SELECT ticker, fund_name, net_assets, expense_ratio_percent
FROM ishares.products
WHERE product_view = 'etf'
ORDER BY net_assets DESC
LIMIT 10;

-- Bond ETFs with their 1-year NAV return:
SELECT ticker, fund_name, nav_return_1y_percent
FROM ishares.products
WHERE asset_class = 'Fixed Income';

-- Look up one fund by ticker:
SELECT ticker, fund_name, expense_ratio_percent
FROM ishares.products
WHERE ticker = 'IVV';
```

Filter on `product_view` (`'etf'`, `'mutualfund'`, …), `ticker`, `asset_class`, etc. Columns
include `ticker`, `fund_name`, `isin`/`cusip`/`sedol`, asset class / region /
country, `inception_date` (DATE), `nav`, `net_assets`, `expense_ratio_percent` /
`management_fee_percent` / `net_expense_ratio_percent`, `thirty_day_sec_yield_percent`,
`twelve_month_yield_percent`, `ytd_return_percent`, and annualized `nav_return_*_percent` /
`price_return_*_percent` (1y/3y/5y/10y/since inception). All `*_percent` columns are in
percent points (0.03 = 0.03%).

### holdings — a hive-partitioned, time-travel table

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker), with the as-of
date as a **time-travel coordinate**. Filter `fund_ticker` to pick funds, or scan without a filter
to stream **every** fund's holdings (one partition per fund — hundreds of funds, so prefer a
filter); read a past day with `AT (TIMESTAMP => DATE '…')`.

```sql
-- Top 10 current holdings of IVV (already weight-ordered):
SELECT ticker, name, weight_percent, market_value
FROM ishares.holdings
WHERE fund_ticker = 'IVV'
ORDER BY weight_percent DESC
LIMIT 10;

-- Holdings as of a past date (time travel — any business day works):
SELECT ticker, weight_percent
FROM ishares.holdings AT (TIMESTAMP => DATE '2025-12-31')
WHERE fund_ticker = 'IVV';

-- Several funds at once (partition fan-out):
SELECT fund_ticker, ticker, weight_percent
FROM ishares.holdings
WHERE fund_ticker IN ('IVV', 'AGG');

-- Every fund at once (streams all partitions — slow; each fund is a partition):
SELECT fund_ticker, count(*) AS n
FROM ishares.holdings
GROUP BY fund_ticker;

-- A bond fund also fills coupon / maturity / duration / ytm:
SELECT ticker, coupon_percent, maturity_date, duration, ytm_percent
FROM ishares.holdings
WHERE fund_ticker = 'AGG'
LIMIT 5;
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the
`ticker` column (each row's own constituent ticker). Filter it to pick funds, or omit it to stream
all funds. The as-of date is time travel: omit it for
the latest holdings, or `AT (TIMESTAMP => DATE '…')` for **any business day back to roughly the
fund's inception** (`holding_dates` only lists the dates iShares features in its UI). Rows come
back **weight-descending**. Join `holdings.fund_ticker` to `products.ticker` for fund-level
facts. Columns: `fund_ticker`, `as_of_date` (DATE), `ticker`, `name`,
`sector`, `asset_class`, `country`, `currency`, `exchange`, `isin`, `cusip`, `sedol`,
`weight_percent`, `market_value`, `notional_value`, `units_held`, `price`, `accrual_date`
(DATE), plus the fixed-income-only `coupon_percent`, `maturity_date` (DATE), `duration`,
`ytm_percent`, `par_value`, `market_currency` (null for equity funds).

> A backing `holdings_scan()` function is also exposed (it's what the table scans, and it's what
> lets DuckDB push the `fund_ticker` filter) — prefer the `holdings` table, which adds the `AT`
> time travel.

### holding_dates — featured as-of dates

```sql
SELECT as_of_date FROM ishares.holding_dates('IVV') ORDER BY as_of_date DESC;
```

### fund_details — one-row characteristics snapshot

```sql
SELECT ticker, index_name, num_holdings, pe_ratio, beta_3y, thirty_day_sec_yield_percent
FROM ishares.fund_details('IVV');
```

Adds facts not in `products`: exchange, tracked index name/ticker, shares outstanding,
premium/discount, 30-day average volume, median bid-ask spread, number of holdings, P/E, P/B
(ratios), 3-year beta (ratio) & standard deviation (percent), yields, and the fund's
**`objective`** (clean plain text) and **`key_benefits_html`** (raw HTML — the `_html` suffix
flags the format).

```sql
SELECT objective FROM ishares.fund_details('IVV');
```

### distributions — dividend history

```sql
-- Recent distributions:
SELECT ex_date, total_distribution, income, long_term_capital_gain
FROM ishares.distributions('IVV')
ORDER BY ex_date DESC
LIMIT 8;

-- Total distributions since a start date:
SELECT sum(total_distribution) AS ttm_income
FROM ishares.distributions('IVV', start_date := DATE '2025-01-01');
```

Amounts are **per-share dollars**, not percentages. `start_date`/`end_date` bound the ex-date
range (inclusive SQL `DATE`s; omit for unbounded).

### nav_history — daily NAV series

```sql
SELECT as_of_date, nav, shares_outstanding
FROM ishares.nav_history('IVV', start_date := DATE '2026-01-01')
ORDER BY as_of_date DESC;
```

This is **fund NAV**, not a market-price candle series. Old funds return thousands of rows —
bound the range with `start_date`/`end_date`.

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install haybarn-unittest
echo "INSTALL vgi FROM community;" | uvx haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check);
CI runs it as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-ishares-worker --fail-on info
```

The pure request/response logic lives in `src/ishares.ts` and is fully unit-tested against
an in-process fake (`test/fake-ishares.ts`) — no network. The single module that touches the
network is `src/client.ts` (it sets the browser-like User-Agent iShares requires); it is
verified live rather than in the unit suite.

## Layout

```
src/ishares.ts    Pure driver: URL builders + JSON parsers + fetch orchestrators (no network, no SDK)
src/client.ts     Real fetch client (browser User-Agent; keyless)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The six defineTableFunction() definitions
src/catalog.ts    The `ishares` catalog descriptor (no secret type)
src/worker.ts     Worker entry: wires the real client into the functions
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from iShares' public product website JSON endpoints (the US product screener and
the BlackRock `get-product-data` API). It is provided for personal, informational use;
consult iShares' terms before any redistribution or commercial use. This worker is not
affiliated with or endorsed by BlackRock / iShares.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
