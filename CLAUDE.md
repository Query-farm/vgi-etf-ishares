# vgi-etf-ishares — agent notes

A VGI (DuckDB) worker exposing iShares (BlackRock) US fund data as two base **tables** —
`products` (the catalog) and `holdings` (partitioned + time-travel) — plus table **functions**:
`holding_dates`, `fund_details`, `distributions`, `nav_history` (and the listed backing scan
that shares the `holdings` name). TypeScript, runs on Bun, built on `@query-farm/vgi` (the TS SDK).
Keyless — no secret type, no auth. Modeled on the sibling `vgi-yfinance` worker.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s `tables: [...]`); each
`TableDescriptor` has `function: <scan>` + `arguments: new Arguments([],new Map())` and carries
its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. A scan RPC with
  `function_name = X` runs the registered scan. Required for the table to be scannable.
- **catalog `schemas[].functions`** — the *listing* layer (DuckDB's `schemaContentsFunctions`).
  Controls what shows as a callable `X()` function AND is where the extension discovers a scan's
  capabilities (e.g. `filter_pushdown`).

`products`: backing `productsScan` is **registered but NOT listed** → exposed only as the table
(no redundant `products()`), and it needs no pushdown. `holdings`: backing `holdingsScan` MUST
be **listed** (`functions: [...functions, holdingsScan]`) — proven with haybarn that an unlisted
backing scan gets **no** `pushdown_filters` (the extension can't see its `filter_pushdown`
capability), so the `fund_ticker` partition filter never reaches it. So the backing scan is
`name: "holdings"` — it **shares the `holdings` table's name** (call it with parens,
`FROM ishares.main.holdings()`, to reach the function; bare `FROM ishares.main.holdings` is the
table). Naming it after the table clears VGI311 (a parameterless table function that is exposed as
a same-named table is fine) without hiding the finding — verified under haybarn that ATTACH,
DESCRIBE, and `fund_ticker` pushdown all still work with the shared name. (Earlier it was named
`holdings_scan` and VGI311 was suppressed in `vgi-lint.toml`; that suppression is now removed.)

## `holdings` — hive-partitioned by `fund_ticker`, time-travel on the as-of date

Query `FROM ishares.main.holdings WHERE fund_ticker = 'IVV'` (fund selector) and
`AT (TIMESTAMP => DATE '2025-12-31')` for a past day; an **unfiltered scan streams every fund**
(one partition per fund). Mechanics (all verified under haybarn):
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole catalog), resolves each to a portfolioId, and `queuePush`es one item per
  fund onto a `BoundStorage` queue keyed by the execution id. `process()` pops one fund per tick,
  fetches its holdings, and `out.emit`s a single partition batch tagged with `vgi_partition_values`
  (min==max==ticker). `maxWorkers` workers drain the same queue → work-stealing fan-out. `LIMIT`
  short-circuits the stream, so `SELECT * FROM holdings LIMIT 5` fetches only ~1 fund.
- **No `requiredFieldFilterPaths`** — a bare scan is allowed and defaults to ALL funds (slow;
  prefer a `fund_ticker` filter). Pushdown still narrows it: `onInit` reads
  `deserializeFilters(initCall.pushdown_filters, …).getColumnValues("fund_ticker")` (equality/IN).
- **`filterPushdown: true`** on `holdingsScan` + LISTED → the extension pushes the filter into the
  scan (an unlisted backing scan gets none — proven under haybarn).
- **`supportsTimeTravel: true`** — the AT coordinate arrives as `p.atValue` (a timestamp string
  like `"2025-12-31"`) / `p.atUnit`; `dateArgToYmd` turns it into the iShares `asOfDate`.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own
  ticker; overloading one column broke `WHERE`/`count(DISTINCT ticker)` semantics. The scan tags
  every row of a fund with `fundTicker` (the requested fund ticker, upper-cased).
- The internal iShares `portfolio_id` is NOT exposed as an output column (funds are keyed by
  `ticker`); it's still used internally (`resolveFund`, `productDataUrl`). Constraints (all
  advisory — NOT enforced on scan): `products` PK `[isin]`; `holdings` `notNull
  [fund_ticker, as_of_date]` + advisory composite PK `[fund_ticker, as_of_date, ticker]` (one
  constituent of one fund on one as-of date — `ticker` is null for the rare cash/derivative line
  item, hence advisory). There's no cross-table FK (ticker/isin/etc. recur with different
  meanings). `vgi-lint.toml` no longer suppresses any rule — VGI311 is cleared by the shared
  scan name, VGI807 by the advisory PK, and VGI809 no longer fires.
- The old `holdings(fund, as_of_date)` table FUNCTION was replaced by this table.

## Architecture (keep this separation)

- **`src/ishares.ts` — the pure driver.** URL builders + JSON→row parsers, plus thin
  `fetch*` orchestrators and `resolveFund` that take an injected `get(url) => Promise`. NO
  network, NO SDK import. This is what the unit tests exercise. All parsing is defensive: a
  missing component/container/data-point degrades to `[]` / `null` cells, never a throw.
  `resolveFund` returns `number | null` (null = ticker not found) rather than throwing, so this
  module needs no SDK import; `functions.ts` turns null into a typed `ArgumentValidationError`.
- **`src/client.ts` — the only network module.** `makeIsharesGet()` returns the real `get`.
  Its one job beyond `fetch` is setting the browser-like User-Agent iShares requires (the
  default fetch UA gets an interstitial HTML page instead of JSON). No dedicated unit test;
  exercised live by the HTTP-transport E2E test.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Fund data has a stable shape,
  so we emit real typed columns (`Utf8`/`Float64`/`Int64`/`DateDay`), not JSON. Every calendar
  date is a real Arrow **DATE** (`DateDay` → DuckDB `DATE`, no timezone). `batchFromColumns`
  defaults to the **"rich"** representation, so a DATE cell is a **JS `Date`** (built at UTC
  midnight via `dateOrNull(epochSec)`) and an Int64 cell is a **bigint** (`bigOrNull`). The
  driver still returns dates as epoch seconds; the Date conversion lives only here.
  NOTE: dates are DATE, not TIMESTAMP — an earlier version used `Timestamp[s,UTC]`, but casting
  a UTC-midnight TIMESTAMPTZ `::DATE` shifts the day in non-UTC sessions, so it was wrong.
  Percent columns carry a `_percent` suffix and hold **percent points** (iShares' raw values:
  `weight_percent` 7.38 = 7.38%, `expense_ratio_percent` 0.03 = 0.03%). Ratios that aren't
  percents (`pe_ratio`, `pb_ratio`, `beta_3y`) are NOT suffixed.
- **`src/functions.ts`** — six `defineTableFunction`s: five callable functions plus
  `makeProductsScan` (the products-table backing scan). State is a `{done}` flag only (fully
  serializable → HTTP transport safe). Each is a single-shot snapshot.
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the
  entry that wires the real client into the functions.

## iShares endpoint facts (why the design is what it is)

Two keyless JSON planes, both need only the browser User-Agent:

1. **Product screener** — `GET /us/product-screener/product-screener-v3.1.jsn?dcrPath=…&siteEntryPassthrough=true`.
   One ~1.9 MB object keyed by `portfolioId`; each product has ~80 fields. Backs `products`
   and the ticker→portfolioId lookup in `resolveFund`. Scalar fields come as either a bare
   value ("Equity", or the sentinels `"-"` / `" "` meaning "no data") or a `{ d: display,
   r: raw }` pair. Helpers: `disp()` (display string, sentinels→null), `num()` (the raw
   number), `ymd()` (a YYYYMMDD integer → epoch seconds). Only `productType ===
   "ISHARES_FUND_DATA"` rows are products; `productView` (e.g. `["etf"]`) is the filter.

2. **get-product-data** — `GET /varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?appSubType=ISHARES&appType=PRODUCT_PAGE&component=<C>&locale=en_US&portfolioId=<id>&targetSite=us-ishares&userType=individual&excludeContent=true[&asOfDate=YYYYMMDD]`.
   Nested shape: `componentsByNameMap[C].containersByNameMap[container].dataPointsByNameMap[point]`,
   where each point carries **parallel arrays** `value` (raw/typed) and `formattedValue`
   (display). We read `value` and zip by index. Components used:
   - `holdings.all` → container `all`: the holdings columns (`issueName`, `ticker`, `isin`,
     `cusip`, `sedol`, `sectorName`, `assetClass`, `countryOfRisk`, `currencyCode`,
     `exchange`, `holdingPercent`, `marketValue`, `notionalValue`, `unitsHeld`, `unitPrice`,
     `accrualDate`) + scalar `asOfDate` + `dateList` (featured dates). Fixed-income funds add
     `couponRate`, `maturityDate`, `duration`, `yieldToMaturity`, `parValue`,
     `marketCurrencyCode` (null/absent for equity funds — the row count is driven by
     `HOLDING_COLS`, which lists only always-present columns). `parseHoldings` sorts rows by
     `weight` DESC (NULLS last) so `... LIMIT n` returns the top holdings without ORDER BY.
   - `keyFundFacts` → container `default` (scalar points): closingPrice, cusip,
     distributionFrequency, exchange, indexSeriesName, indexTicker, launchDate,
     premiumDiscountClosingPriceNavPercent, sharesOutstanding, thirtyDayAverageVolume,
     thirtyDayMedianBidAskSpread, totalNetAssetsFundLevel. Root also has `fundName` /
     `aladdinFundTicker`.
   - `fundamentalsAndRisk` → container `default`: beta3Yr, numHoldings, priceBook,
     priceEarnings, standardDeviation3Yr, thirtyDaySecYield, twelveMonTrlYld.
   - `fundDownload` → containers `distributions` (exDate, recordDate, payableDate,
     totalDistribution, incomeAmount, short/longTermCapitalGain, returnOnCapital) and
     `historical` (asof, nav, exDividends, sharesOutstanding — daily, back to inception).

**Dates:** date ARGS are real SQL `DATE` (Arrow `DateDay`), never YYYYMMDD strings — SQL types
the literal (`DATE '2026-06-30'`) and DuckDB rejects a non-date, so there's no string parsing
or validation on our side. The vgi runtime hands a DATE arg to `p.args` as a **number of epoch
milliseconds** (verified: `DATE '2026-01-01'` → `1767225600000`). `dateArgToEpoch` /
`dateArgToYmd` (ishares.ts) convert it, and are magnitude-robust (accept epoch-ms, a JS Date, a
bigint, days-since-epoch, or a YYYY-MM-DD string). `holdings` takes one optional `as_of_date`
(omit = latest); it hits iShares' `asOfDate=YYYYMMDD` for **any business day back to ~inception**,
not only the ~3 featured dates in `dateList`. Verified: IVV resolves 2020/2024/2025 days. For
several days, `UNION ALL` per-date calls (the fan-out was removed — one request per call now).
`nav_history`/`distributions` take `start_date`/`end_date` (`DATE`; client-side filter on
as-of/ex-date; named `*_date` because `END` is reserved). Omitted/null = latest/unbounded.

**fund_details descriptions:** the objective/key-benefits prose lives in the `fundHeader`
component's top-level `content` block, which is stripped by `excludeContent=true` (the default
on `productDataUrl`). So `fetchFundDetails` makes a THIRD fetch — `fundHeader` with
`includeContent=true` (4th positional arg → `excludeContent=false`) — and pulls
`content.fund_objective[].text` → `objective` (HTML-stripped + entity-decoded via `htmlToText`)
and `content.key_benefits[].text` → `key_benefits_html` (raw HTML; the `_html` suffix is the
convention that flags un-sanitized HTML in a column).

**Other components exist but are unused** (`performance`, `relatedFunds`, plus
`holdings.{index,cfd,issuers,lookthrus,top}`). Component naming is mixed — some bare
(`fundHeader`, `performance`, `keyFundFacts`), holdings dotted (`holdings.all`). An unknown
component returns an empty `componentsByNameMap`, not an error.

## Fund identifier (`fund` arg)

`resolveFund(get, fund)`: a pure-digit string is the portfolioId (no network); anything else
is a ticker, resolved via one screener fetch (case-insensitive `localExchangeTicker` match).
It returns `number | null` (null = not found) — it does NOT throw, because ishares.ts is
SDK-free. `functions.ts` `resolveOrThrow` converts null into an `ArgumentValidationError`
with a "list tickers via products" hint. A `holdings('IVV', …)` call downloads the screener
once to resolve; a numeric id avoids it. Ticker resolution is not cached — mind tight loops.

## Commands

```bash
bun install
bun test            # 37 tests: SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-ishares-worker` +
`VGI_WORKER_CATALOG_NAME=ishares` and runs `test/sql/*.test`. The `.test` files are
DESCRIBE-based schema asserts (bind-only → no network → deterministic) plus a few
live-invariant asserts that hit iShares (fine for an egress connector). CI runs this, the
reusable `ts-ci.yml`, and a `vgi-lint` gate at `--fail-on info` (currently 100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) —
`bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin
`typescript ^6.0.3` (5.x descends into SDK `.ts` source and reports external errors).

## Gotchas / conventions

- Emit `bigint` (not `number`) for `Int64`/`Timestamp` columns via `batchFromColumns`; date
  fields go through `ymd()` (→ epoch seconds) then `bigOrNull`.
- `noUncheckedIndexedAccess` is on: read parallel-array cells via the `cell(dp, name, i)`
  helper rather than destructuring `NAMES.map(col)` (destructured elements type as possibly
  `undefined` and fail the typecheck).
- vgi-lint rules that bit us and must stay satisfied: catalog/schema descriptions must NOT
  enumerate the worker's own functions (VGI173 — describe purpose/concepts instead); argument
  docs must NOT restate the data type (VGI313 — the `fund` doc says "portfolio_id or exchange
  ticker", never "numeric"); every function needs an agent test task (VGI520 — all six are
  covered in `catalog.ts` `vgi.agent_test_tasks`).
- Don't add a secret type; this worker is keyless by design.

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'ishares' AS ishares (TYPE vgi, LOCATION '/path/to/vgi-etf-ishares/bin/vgi-etf-ishares-worker');
SELECT ticker, net_assets FROM ishares.products WHERE product_view = 'etf' ORDER BY net_assets DESC LIMIT 10;
SELECT ticker, name, weight_percent FROM ishares.holdings('IVV', as_of_date := DATE '2026-06-30');
```
