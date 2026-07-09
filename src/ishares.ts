// The iShares driver — pure logic, no network and no SDK. Every fetch* takes an injected
// `get(url) => Promise<any>` so the archetype-proof tests drive it against an in-process
// fake and the worker wires the real HTTP client (client.ts). This module MUST NOT import
// from @query-farm/* — the unit tests import it without the SDK installed.
//
// Two keyless iShares/BlackRock JSON planes back six read paths:
//
//   product-screener-v3.1.jsn                    → products         (the flat catalog of
//     one object per product, keyed by portfolioId, ~80 fields each)
//   .../product-data/api/v2/get-product-data     → holdings, holding_dates, fund_details,
//     ?portfolioId=<id>&component=<C>&asOfDate=…    distributions, nav_history
//
// The get-product-data planes are shaped as nested "components": a component holds named
// containers, each container a `dataPointsByNameMap` where every data point carries PARALLEL
// arrays `value` (raw / typed) and `formattedValue` (display strings) — one entry per row.
// We read the raw `value` arrays and zip them by index into rows.
//
// Every parser is defensive: a missing component / container / data point degrades to an
// empty result or a null cell rather than throwing. `resolveFund` returns null (not a throw)
// on an unresolvable ticker so the caller (functions.ts) can raise a typed SDK error.
//
// Screener scalar fields come in two flavours: a bare value ("Equity", or the sentinel "-" /
// " " for "no data"), or a { d: displayString, r: rawValue } pair. `disp()` reads the human
// string, `num()` the raw number, `ymd()` a YYYYMMDD integer as epoch seconds.
//
// DATES: the driver returns dates as epoch SECONDS at UTC midnight (number | null). The Arrow
// mapping to a real DATE column lives in schema.ts (keeping this module type/SDK-free).

export const ISHARES_HOST = "https://www.ishares.com";

/** The US product screener: one JSON object per product, keyed by portfolioId. */
export const SCREENER_URL =
  `${ISHARES_HOST}/us/product-screener/product-screener-v3.1.jsn` +
  `?dcrPath=/templatedata/config/product-screener-v3/data/en/us-ishares/ishares-product-screener-backend-config` +
  `&siteEntryPassthrough=true`;

// ── shared value coercion ────────────────────────────────────────────────────

/** True for iShares' "no data" sentinels: null, "", "-", or all-whitespace. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" || t === "-";
  }
  return false;
}

/** The display string for a screener field (bare string or a { d, r } pair). Null if blank. */
export function disp(v: unknown): string | null {
  if (isBlank(v)) return null;
  if (typeof v === "object" && v !== null && "d" in (v as any)) {
    const d = (v as any).d;
    return isBlank(d) ? null : String(d);
  }
  return String(v).trim();
}

/** The raw number for a field (from `.r`, or a numeric bare/`%`-suffixed value). Null otherwise. */
export function num(v: unknown): number | null {
  if (isBlank(v)) return null;
  const raw = typeof v === "object" && v !== null && "r" in (v as any) ? (v as any).r : v;
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[,%]/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * A YYYYMMDD field (from `.r` or a bare value) as epoch SECONDS at UTC midnight. Validates the
 * calendar parts round-trip, so an impossible date like 20261345 returns null (not a rollover).
 */
export function ymd(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  const s = String(Math.trunc(n));
  if (s.length !== 8) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const ms = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  // Reject rolled-over parts (e.g. month 13, day 45).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/** Strip iShares' bracketed/quoted decoration, e.g. "[Index]" → "Index". */
function unbracket(s: string | null): string | null {
  if (s == null) return null;
  const t = s.replace(/[[\]"]/g, "").trim();
  return t === "" ? null : t;
}

/** Decode the handful of HTML entities iShares' narrative text uses (it is entity-encoded). */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Strip HTML tags and collapse whitespace, then decode entities → clean plain text. */
function htmlToText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Join the `.text` of the blocks under `content[key]` (get-product-data narrative content).
 * Returns the raw block text (HTML preserved). Null when absent/empty.
 */
function contentBlocks(content: unknown, key: string): string | null {
  const blocks = (content as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>).text : b))
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .join("\n\n")
    .trim();
  return text === "" ? null : text;
}

// ── DATE-typed function arguments ──────────────────────────────────────────────
//
// Date args on the table functions are real SQL DATE (Arrow Date32), so DuckDB parses and
// type-checks the literal and the SDK hands us a JS Date (rich repr) — no YYYYMMDD strings on
// the SQL surface. These converters accept a Date (the normal case) and, defensively, a
// days-since-epoch number or a YYYY-MM-DD/YYYYMMDD string, so they're robust to the repr.

/**
 * A DATE arg → epoch SECONDS at UTC midnight, or null when absent/invalid. The vgi runtime
 * delivers a DATE argument as a number of epoch MILLISECONDS; we also accept a JS Date, a
 * bigint, a days-since-epoch number, or a YYYY-MM-DD/YYYYMMDD string so the converter is
 * robust to the representation.
 */
export function dateArgToEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const digits = /^\d{8}$/.test(t) ? t : /^(\d{4})-(\d{2})-(\d{2})/.exec(t)?.slice(1, 4).join("");
    return digits ? ymd(Number(digits)) : null;
  }
  let ms: number;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "bigint") ms = Number(v);
  else if (typeof v === "number" && Number.isFinite(v)) {
    // Disambiguate by magnitude: a value >= 1e11 is epoch milliseconds (any date since ~1973);
    // anything smaller is a days-since-epoch count (Date32 raw), so scale it up to ms.
    ms = Math.abs(v) >= 1e11 ? v : v * 86400000;
  } else return null;
  return Number.isNaN(ms) ? null : Math.floor(ms / 86400000) * 86400;
}

/** A DATE arg → 'YYYYMMDD' for the iShares API URL, or '' when absent/invalid. */
export function dateArgToYmd(v: unknown): string {
  const sec = dateArgToEpoch(v);
  if (sec == null) return "";
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ── products (the screener) ───────────────────────────────────────────────────

export interface ProductRow {
  portfolioId: number;
  ticker: string | null;
  fundName: string | null;
  isin: string | null;
  cusip: string | null;
  sedol: string | null;
  assetClass: string | null;
  subAssetClass: string | null;
  region: string | null;
  country: string | null;
  marketType: string | null;
  investmentStyle: string | null;
  productView: string | null;
  inceptionDate: number | null;
  nav: number | null;
  navAsOf: number | null;
  netAssets: number | null;
  netAssetsAsOf: number | null;
  expenseRatioPercent: number | null;
  managementFeePercent: number | null;
  netExpenseRatioPercent: number | null;
  thirtyDaySecYieldPercent: number | null;
  twelveMonthYieldPercent: number | null;
  ytdReturnPercent: number | null;
  navReturn1yPercent: number | null;
  navReturn3yPercent: number | null;
  navReturn5yPercent: number | null;
  navReturn10yPercent: number | null;
  navReturnSinceInceptionPercent: number | null;
  priceReturn1yPercent: number | null;
  priceReturn3yPercent: number | null;
  priceReturn5yPercent: number | null;
  priceReturn10yPercent: number | null;
  priceReturnSinceInceptionPercent: number | null;
  productPageUrl: string | null;
}

/**
 * Map the screener envelope to product rows. `productView` filters by product type ('etf'
 * default; 'all'/'' = no filter). `ticker`, when non-empty, narrows to that one ticker
 * (case-insensitive).
 */
export function parseProducts(json: unknown, productView = "etf", ticker = ""): ProductRow[] {
  if (json == null || typeof json !== "object") return [];
  const want = productView.trim().toLowerCase();
  const wantTicker = ticker.trim().toUpperCase();
  const rows: ProductRow[] = [];
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    if (raw == null || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (p.productType !== "ISHARES_FUND_DATA") continue;
    const views = Array.isArray(p.productView) ? (p.productView as unknown[]).map((v) => String(v).toLowerCase()) : [];
    if (want !== "all" && want !== "" && !views.includes(want)) continue;
    const tk = disp(p.localExchangeTicker);
    if (wantTicker && (tk ?? "").toUpperCase() !== wantTicker) continue;
    const portfolioId = num(p.portfolioId) ?? Number(key);
    if (!Number.isFinite(portfolioId)) continue;
    rows.push({
      portfolioId,
      ticker: tk,
      fundName: disp(p.fundName),
      isin: disp(p.isin),
      cusip: disp(p.cusip),
      sedol: disp(p.sedol),
      assetClass: disp(p.aladdinAssetClass),
      subAssetClass: disp(p.aladdinSubAssetClass),
      region: disp(p.aladdinRegion),
      country: disp(p.aladdinCountry),
      marketType: disp(p.aladdinMarketType),
      investmentStyle: unbracket(disp(p.investmentStyle)),
      productView: views.length ? views.join(",") : null,
      inceptionDate: ymd(p.inceptionDate),
      nav: num(p.navAmount),
      navAsOf: ymd(p.navAmountAsOf),
      netAssets: num(p.totalNetAssets),
      netAssetsAsOf: ymd(p.totalNetAssetsFundAsOf),
      expenseRatioPercent: num(p.ter),
      managementFeePercent: num(p.mgt),
      netExpenseRatioPercent: num(p.netr),
      thirtyDaySecYieldPercent: num(p.thirtyDaySecYield),
      twelveMonthYieldPercent: num(p.twelveMonTrlYield),
      ytdReturnPercent: num(p.dailyPerformanceYearToDate),
      navReturn1yPercent: num(p.navOneYearAnnualized),
      navReturn3yPercent: num(p.navThreeYearAnnualized),
      navReturn5yPercent: num(p.navFiveYearAnnualized),
      navReturn10yPercent: num(p.navTenYearAnnualized),
      navReturnSinceInceptionPercent: num(p.navSinceInceptionAnnualized),
      priceReturn1yPercent: num(p.priceOneYearAnnualized),
      priceReturn3yPercent: num(p.priceThreeYearAnnualized),
      priceReturn5yPercent: num(p.priceFiveYearAnnualized),
      priceReturn10yPercent: num(p.priceTenYearAnnualized),
      priceReturnSinceInceptionPercent: num(p.priceSinceInceptionAnnualized),
      productPageUrl: disp(p.productPageUrl),
    });
  }
  return rows;
}

export async function fetchProducts(
  get: (url: string) => Promise<unknown>,
  productView = "etf",
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(await get(SCREENER_URL), productView, ticker);
}

// ── fund resolution (accept a numeric portfolioId OR a ticker) ─────────────────

/**
 * Resolve a `fund` argument to a numeric portfolioId. A pure-digit string is taken as the
 * portfolioId directly (no network); anything else is treated as a ticker and looked up in the
 * screener (one ~2 MB fetch). Returns null when a ticker can't be resolved (the caller raises a
 * typed ArgumentValidationError — this module stays SDK-free).
 */
export async function resolveFund(
  get: (url: string) => Promise<unknown>,
  fund: string,
): Promise<number | null> {
  const t = fund.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const wanted = t.toUpperCase();
  const products = parseProducts(await get(SCREENER_URL), "all");
  const hit = products.find((p) => (p.ticker ?? "").toUpperCase() === wanted);
  return hit ? hit.portfolioId : null;
}

// ── get-product-data plumbing ──────────────────────────────────────────────────

/**
 * Build a get-product-data URL for one component of one fund, optionally as-of a date.
 * `excludeContent=true` (the default) strips the large `content` block — narratives,
 * disclaimers, labels — which we don't need for holdings/facts. Pass `includeContent` when
 * the caller specifically wants prose (e.g. the fund objective in the fundHeader `content`).
 */
export function productDataUrl(
  portfolioId: number,
  component: string,
  asOfDate?: string,
  includeContent = false,
): string {
  const p = new URLSearchParams({
    appSubType: "ISHARES",
    appType: "PRODUCT_PAGE",
    component,
    locale: "en_US",
    portfolioId: String(portfolioId),
    targetSite: "us-ishares",
    userType: "individual",
    excludeContent: includeContent ? "false" : "true",
  });
  if (asOfDate && /^\d{8}$/.test(asOfDate)) p.set("asOfDate", asOfDate);
  return `${ISHARES_HOST}/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?${p.toString()}`;
}

type DataPoint = { value?: unknown[]; formattedValue?: unknown; asOfDate?: unknown };

/** Reach a container's dataPointsByNameMap: component → container → data points. */
function pointsOf(json: unknown, component: string, container: string): Record<string, DataPoint> {
  const env = json as any;
  return env?.componentsByNameMap?.[component]?.containersByNameMap?.[container]?.dataPointsByNameMap ?? {};
}

/** The `value` array of a data point (parallel-array column), or []. */
function col(dp: Record<string, DataPoint>, name: string): unknown[] {
  const v = dp[name]?.value;
  return Array.isArray(v) ? v : [];
}

/** One cell of a parallel-array column: the i-th `value` of the named data point. */
function cell(dp: Record<string, DataPoint>, name: string, i: number): unknown {
  return col(dp, name)[i];
}

/** Row count = the longest column among the given data-point names. */
function rowCount(dp: Record<string, DataPoint>, names: string[]): number {
  let n = 0;
  for (const name of names) n = Math.max(n, col(dp, name).length);
  return n;
}

const asStr = (v: unknown): string | null => (isBlank(v) ? null : String(v).trim());
const asNum = (v: unknown): number | null => {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,%]/g, ""));
  return Number.isFinite(n) ? n : null;
};
/** A YYYYMMDD integer/string cell as epoch SECONDS at UTC midnight. */
const asYmd = (v: unknown): number | null => ymd(v);

// ── holdings (component "holdings.all", one request per as-of date) ─────────────

export interface HoldingRow {
  portfolioId: number;
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  ticker: string | null;
  name: string | null;
  sector: string | null;
  assetClass: string | null;
  country: string | null;
  currency: string | null;
  exchange: string | null;
  isin: string | null;
  cusip: string | null;
  sedol: string | null;
  weightPercent: number | null;
  marketValue: number | null;
  notionalValue: number | null;
  unitsHeld: number | null;
  price: number | null;
  accrualDate: number | null;
  // Fixed-income-only fields (null for equity funds).
  couponPercent: number | null;
  maturityDate: number | null;
  duration: number | null;
  ytmPercent: number | null;
  parValue: number | null;
  marketCurrency: string | null;
}

// Names that drive the row count (any populated column suffices; equity funds lack the bond ones).
const HOLDING_COLS = ["issueName", "ticker", "holdingPercent", "marketValue", "unitsHeld"];

/** Map one holdings.all envelope to holding rows, sorted by weight desc (NULLS last). */
export function parseHoldings(
  json: unknown,
  portfolioId: number,
  requestedYmd: number | null,
  fundTicker: string | null = null,
): HoldingRow[] {
  const dp = pointsOf(json, "holdings", "all");
  const n = rowCount(dp, HOLDING_COLS);
  if (n === 0) return [];
  // The resolved as-of: the payload's own asOfDate data point, else the requested date.
  const resolved = asYmd(dp.asOfDate?.value) ?? requestedYmd;
  const rows: HoldingRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      portfolioId,
      fundTicker,
      asOfDate: resolved,
      ticker: asStr(cell(dp, "ticker", i)),
      name: asStr(cell(dp, "issueName", i)),
      sector: asStr(cell(dp, "sectorName", i)),
      assetClass: asStr(cell(dp, "assetClass", i)),
      country: asStr(cell(dp, "countryOfRisk", i)),
      currency: asStr(cell(dp, "currencyCode", i)),
      exchange: asStr(cell(dp, "exchange", i)),
      isin: asStr(cell(dp, "isin", i)),
      cusip: asStr(cell(dp, "cusip", i)),
      sedol: asStr(cell(dp, "sedol", i)),
      weightPercent: asNum(cell(dp, "holdingPercent", i)),
      marketValue: asNum(cell(dp, "marketValue", i)),
      notionalValue: asNum(cell(dp, "notionalValue", i)),
      unitsHeld: asNum(cell(dp, "unitsHeld", i)),
      price: asNum(cell(dp, "unitPrice", i)),
      accrualDate: asYmd(cell(dp, "accrualDate", i)),
      couponPercent: asNum(cell(dp, "couponRate", i)),
      maturityDate: asYmd(cell(dp, "maturityDate", i)),
      duration: asNum(cell(dp, "duration", i)),
      ytmPercent: asNum(cell(dp, "yieldToMaturity", i)),
      parValue: asNum(cell(dp, "parValue", i)),
      marketCurrency: asStr(cell(dp, "marketCurrencyCode", i)),
    });
  }
  // iShares returns holdings weight-descending; enforce it so `... LIMIT 10` is the top holdings
  // without an explicit ORDER BY. NULL weights sort last.
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/**
 * Detailed holdings for one fund on a single as-of date. An empty `asOfDate` fetches the
 * latest holdings; a `YYYYMMDD` value fetches that business day (a weekend / holiday /
 * pre-inception day simply yields no rows). The caller normalizes/validates the date; this
 * appends it only when it is 8 digits (see productDataUrl).
 */
export async function fetchHoldings(
  get: (url: string) => Promise<unknown>,
  portfolioId: number,
  asOfDate = "",
  fundTicker: string | null = null,
): Promise<HoldingRow[]> {
  const d = asOfDate.trim();
  const json = await get(productDataUrl(portfolioId, "holdings.all", d || undefined));
  return parseHoldings(json, portfolioId, d ? ymd(Number(d)) : null, fundTicker);
}

// ── holding_dates (the featured as-of date list) ───────────────────────────────

export interface HoldingDateRow {
  portfolioId: number;
  asOfDate: number | null;
}

/** Map a holdings.all envelope's `dateList` to available as-of dates (newest first). */
export function parseHoldingDates(json: unknown, portfolioId: number): HoldingDateRow[] {
  const dp = pointsOf(json, "holdings", "all");
  return col(dp, "dateList").map((d) => ({ portfolioId, asOfDate: asYmd(d) }));
}

export async function fetchHoldingDates(
  get: (url: string) => Promise<unknown>,
  portfolioId: number,
): Promise<HoldingDateRow[]> {
  return parseHoldingDates(await get(productDataUrl(portfolioId, "holdings.all")), portfolioId);
}

// ── fund_details (keyFundFacts + fundamentalsAndRisk, merged to one row) ────────

export interface FundDetailsRow {
  portfolioId: number;
  ticker: string | null;
  fundName: string | null;
  assetClass: string | null;
  exchange: string | null;
  indexName: string | null;
  indexTicker: string | null;
  cusip: string | null;
  launchDate: number | null;
  distributionFrequency: string | null;
  closingPrice: number | null;
  nav: number | null;
  premiumDiscountPercent: number | null;
  sharesOutstanding: number | null;
  totalNetAssets: number | null;
  thirtyDayAvgVolume: number | null;
  medianBidAskSpreadPercent: number | null;
  numHoldings: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  beta3y: number | null;
  standardDeviation3yPercent: number | null;
  thirtyDaySecYieldPercent: number | null;
  twelveMonthYieldPercent: number | null;
  /** Investment objective, as clean plain text (HTML stripped, entities decoded). */
  objective: string | null;
  /** Key benefits, as raw HTML (the `_html` suffix flags the format to consumers). */
  keyBenefitsHtml: string | null;
}

/** Scalar data point (keyFacts/fundamentals containers hold single values, not arrays). */
function scalar(dp: Record<string, DataPoint>, name: string): unknown {
  const p = dp[name];
  if (!p) return null;
  return p.value !== undefined ? p.value : p.formattedValue;
}

/**
 * Merge keyFundFacts + fundamentalsAndRisk + fundHeader envelopes into one fund-details row.
 * The fundHeader envelope must be fetched with content included (excludeContent=false) — the
 * objective/key-benefits prose lives in its top-level `content` block.
 */
export function parseFundDetails(
  keyFacts: unknown,
  fundamentals: unknown,
  fundHeader: unknown,
  portfolioId: number,
): FundDetailsRow {
  const kf = pointsOf(keyFacts, "keyFundFacts", "default");
  const fr = pointsOf(fundamentals, "fundamentalsAndRisk", "default");
  const content = (fundHeader as { content?: unknown } | null | undefined)?.content;
  const objectiveRaw = contentBlocks(content, "fund_objective");
  const keyBenefitsHtml = contentBlocks(content, "key_benefits");
  const root = keyFacts as any;
  return {
    portfolioId,
    ticker: asStr(root?.aladdinFundTicker ?? root?.pageScopeData?.ticker),
    fundName: asStr(root?.fundName ?? root?.pageScopeData?.productName),
    assetClass: asStr(scalar(kf, "assetClass")),
    exchange: asStr(scalar(kf, "exchange")),
    indexName: asStr(scalar(kf, "indexSeriesName")),
    indexTicker: asStr(scalar(kf, "indexTicker")),
    cusip: asStr(scalar(kf, "cusip")),
    launchDate: asYmd(scalar(kf, "launchDate")),
    distributionFrequency: asStr(scalar(kf, "distributionFrequency")),
    closingPrice: asNum(scalar(kf, "closingPrice")),
    nav: asNum(scalar(kf, "navAmount")),
    premiumDiscountPercent: asNum(scalar(kf, "premiumDiscountClosingPriceNavPercent")),
    sharesOutstanding: asNum(scalar(kf, "sharesOutstanding")),
    totalNetAssets: asNum(scalar(kf, "totalNetAssetsFundLevel")),
    thirtyDayAvgVolume: asNum(scalar(kf, "thirtyDayAverageVolume")),
    medianBidAskSpreadPercent: asNum(scalar(kf, "thirtyDayMedianBidAskSpread")),
    numHoldings: asNum(scalar(fr, "numHoldings")),
    peRatio: asNum(scalar(fr, "priceEarnings")),
    pbRatio: asNum(scalar(fr, "priceBook")),
    beta3y: asNum(scalar(fr, "beta3Yr")),
    standardDeviation3yPercent: asNum(scalar(fr, "standardDeviation3Yr")),
    thirtyDaySecYieldPercent: asNum(scalar(fr, "thirtyDaySecYield")),
    twelveMonthYieldPercent: asNum(scalar(fr, "twelveMonTrlYld")),
    objective: objectiveRaw ? htmlToText(objectiveRaw) : null,
    keyBenefitsHtml: keyBenefitsHtml,
  };
}

export async function fetchFundDetails(
  get: (url: string) => Promise<unknown>,
  portfolioId: number,
): Promise<FundDetailsRow> {
  const [keyFacts, fundamentals, fundHeader] = await Promise.all([
    get(productDataUrl(portfolioId, "keyFundFacts")),
    get(productDataUrl(portfolioId, "fundamentalsAndRisk")),
    // fundHeader carries the objective / key-benefits prose in its `content` block, which is
    // only present when content is NOT excluded — hence includeContent=true here.
    get(productDataUrl(portfolioId, "fundHeader", undefined, true)),
  ]);
  return parseFundDetails(keyFacts, fundamentals, fundHeader, portfolioId);
}

// ── distributions (component "fundDownload", container "distributions") ─────────

export interface DistributionRow {
  portfolioId: number;
  exDate: number | null;
  recordDate: number | null;
  payableDate: number | null;
  totalDistribution: number | null;
  income: number | null;
  shortTermCapitalGain: number | null;
  longTermCapitalGain: number | null;
  returnOfCapital: number | null;
}

const DISTRIBUTION_COLS = [
  "exDate",
  "recordDate",
  "payableDate",
  "totalDistribution",
  "incomeAmount",
  "shortTermCapitalGain",
  "longTermCapitalGain",
  "returnOnCapital",
];

/** Map a fundDownload envelope's distributions, optionally bounded to [startSec, endSec] by ex-date. */
export function parseDistributions(
  json: unknown,
  portfolioId: number,
  startSec: number | null = null,
  endSec: number | null = null,
): DistributionRow[] {
  const dp = pointsOf(json, "fundDownload", "distributions");
  const n = rowCount(dp, DISTRIBUTION_COLS);
  const rows: DistributionRow[] = [];
  for (let i = 0; i < n; i++) {
    const exDate = asYmd(cell(dp, "exDate", i));
    if (startSec != null && (exDate == null || exDate < startSec)) continue;
    if (endSec != null && (exDate == null || exDate > endSec)) continue;
    rows.push({
      portfolioId,
      exDate,
      recordDate: asYmd(cell(dp, "recordDate", i)),
      payableDate: asYmd(cell(dp, "payableDate", i)),
      totalDistribution: asNum(cell(dp, "totalDistribution", i)),
      income: asNum(cell(dp, "incomeAmount", i)),
      shortTermCapitalGain: asNum(cell(dp, "shortTermCapitalGain", i)),
      longTermCapitalGain: asNum(cell(dp, "longTermCapitalGain", i)),
      returnOfCapital: asNum(cell(dp, "returnOnCapital", i)),
    });
  }
  return rows;
}

export async function fetchDistributions(
  get: (url: string) => Promise<unknown>,
  portfolioId: number,
  startSec: number | null = null,
  endSec: number | null = null,
): Promise<DistributionRow[]> {
  return parseDistributions(await get(productDataUrl(portfolioId, "fundDownload")), portfolioId, startSec, endSec);
}

// ── nav_history (component "fundDownload", container "historical") ──────────────

export interface NavHistoryRow {
  portfolioId: number;
  asOfDate: number | null;
  nav: number | null;
  exDividends: number | null;
  sharesOutstanding: number | null;
}

const NAV_COLS = ["asof", "nav", "exDividends", "sharesOutstanding"];

/** Map a fundDownload envelope's daily NAV series, optionally bounded to [startSec, endSec]. */
export function parseNavHistory(
  json: unknown,
  portfolioId: number,
  startSec: number | null = null,
  endSec: number | null = null,
): NavHistoryRow[] {
  const dp = pointsOf(json, "fundDownload", "historical");
  const n = rowCount(dp, NAV_COLS);
  const rows: NavHistoryRow[] = [];
  for (let i = 0; i < n; i++) {
    const asOfDate = asYmd(cell(dp, "asof", i));
    if (startSec != null && (asOfDate == null || asOfDate < startSec)) continue;
    if (endSec != null && (asOfDate == null || asOfDate > endSec)) continue;
    rows.push({
      portfolioId,
      asOfDate,
      nav: asNum(cell(dp, "nav", i)),
      exDividends: asNum(cell(dp, "exDividends", i)),
      sharesOutstanding: asNum(cell(dp, "sharesOutstanding", i)),
    });
  }
  return rows;
}

export async function fetchNavHistory(
  get: (url: string) => Promise<unknown>,
  portfolioId: number,
  startSec: number | null = null,
  endSec: number | null = null,
): Promise<NavHistoryRow[]> {
  return parseNavHistory(await get(productDataUrl(portfolioId, "fundDownload")), portfolioId, startSec, endSec);
}
