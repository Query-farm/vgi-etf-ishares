// Arrow output schemas + row→batch mapping for the six functions.
//
// iShares data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 prices/weights/returns, Int64 counts/ids, and a
// real Arrow DATE (Date32) for every calendar date. `batchFromColumns` defaults to the "rich"
// representation, so a DATE cell is a JS `Date` (at UTC midnight) and an Int64 cell is a
// bigint. Percent-valued columns carry a `_percent` suffix and hold percent-magnitude numbers
// (e.g. 7.38 = 7.38%), matching iShares' raw values.

import { Schema, Field, Utf8, Float64, Int64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type {
  ProductRow,
  HoldingRow,
  HoldingDateRow,
  FundDetailsRow,
  DistributionRow,
  NavHistoryRow,
} from "./ishares.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB
 * binder treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned
 * fund is one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description})
 * for a static result schema, DRY from the Arrow schema + a name→description map. Replaces the
 * retired markdown `vgi.result_columns_md` tag.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** bigint | null for an Int64 cell from a JS number that may be null. */
const bigOrNull = (v: number | null): bigint | null => (v == null ? null : BigInt(Math.trunc(v)));

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_name", new Utf8()),
    f("isin", new Utf8()),
    f("cusip", new Utf8()),
    f("sedol", new Utf8()),
    f("asset_class", new Utf8()),
    f("sub_asset_class", new Utf8()),
    f("region", new Utf8()),
    f("country", new Utf8()),
    f("market_type", new Utf8()),
    f("investment_style", new Utf8()),
    f("product_view", new Utf8()),
    f("inception_date", date()),
    f("nav", new Float64()),
    f("nav_as_of", date()),
    f("net_assets", new Float64()),
    f("net_assets_as_of", date()),
    f("expense_ratio_percent", new Float64()),
    f("management_fee_percent", new Float64()),
    f("net_expense_ratio_percent", new Float64()),
    f("thirty_day_sec_yield_percent", new Float64()),
    f("twelve_month_yield_percent", new Float64()),
    f("ytd_return_percent", new Float64()),
    f("nav_return_1y_percent", new Float64()),
    f("nav_return_3y_percent", new Float64()),
    f("nav_return_5y_percent", new Float64()),
    f("nav_return_10y_percent", new Float64()),
    f("nav_return_since_inception_percent", new Float64()),
    f("price_return_1y_percent", new Float64()),
    f("price_return_3y_percent", new Float64()),
    f("price_return_5y_percent", new Float64()),
    f("price_return_10y_percent", new Float64()),
    f("price_return_since_inception_percent", new Float64()),
    f("product_page_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_name: rows.map((r) => r.fundName),
      isin: rows.map((r) => r.isin),
      cusip: rows.map((r) => r.cusip),
      sedol: rows.map((r) => r.sedol),
      asset_class: rows.map((r) => r.assetClass),
      sub_asset_class: rows.map((r) => r.subAssetClass),
      region: rows.map((r) => r.region),
      country: rows.map((r) => r.country),
      market_type: rows.map((r) => r.marketType),
      investment_style: rows.map((r) => r.investmentStyle),
      product_view: rows.map((r) => r.productView),
      inception_date: rows.map((r) => dateOrNull(r.inceptionDate)),
      nav: rows.map((r) => r.nav),
      nav_as_of: rows.map((r) => dateOrNull(r.navAsOf)),
      net_assets: rows.map((r) => r.netAssets),
      net_assets_as_of: rows.map((r) => dateOrNull(r.netAssetsAsOf)),
      expense_ratio_percent: rows.map((r) => r.expenseRatioPercent),
      management_fee_percent: rows.map((r) => r.managementFeePercent),
      net_expense_ratio_percent: rows.map((r) => r.netExpenseRatioPercent),
      thirty_day_sec_yield_percent: rows.map((r) => r.thirtyDaySecYieldPercent),
      twelve_month_yield_percent: rows.map((r) => r.twelveMonthYieldPercent),
      ytd_return_percent: rows.map((r) => r.ytdReturnPercent),
      nav_return_1y_percent: rows.map((r) => r.navReturn1yPercent),
      nav_return_3y_percent: rows.map((r) => r.navReturn3yPercent),
      nav_return_5y_percent: rows.map((r) => r.navReturn5yPercent),
      nav_return_10y_percent: rows.map((r) => r.navReturn10yPercent),
      nav_return_since_inception_percent: rows.map((r) => r.navReturnSinceInceptionPercent),
      price_return_1y_percent: rows.map((r) => r.priceReturn1yPercent),
      price_return_3y_percent: rows.map((r) => r.priceReturn3yPercent),
      price_return_5y_percent: rows.map((r) => r.priceReturn5yPercent),
      price_return_10y_percent: rows.map((r) => r.priceReturn10yPercent),
      price_return_since_inception_percent: rows.map((r) => r.priceReturnSinceInceptionPercent),
      product_page_url: rows.map((r) => r.productPageUrl),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: holdings_scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("ticker", new Utf8()),
    f("name", new Utf8()),
    f("sector", new Utf8()),
    f("asset_class", new Utf8()),
    f("country", new Utf8()),
    f("currency", new Utf8()),
    f("exchange", new Utf8()),
    f("isin", new Utf8()),
    f("cusip", new Utf8()),
    f("sedol", new Utf8()),
    f("weight_percent", new Float64()),
    f("market_value", new Float64()),
    f("notional_value", new Float64()),
    f("units_held", new Float64()),
    f("price", new Float64()),
    f("accrual_date", date()),
    f("coupon_percent", new Float64()),
    f("maturity_date", date()),
    f("duration", new Float64()),
    f("ytm_percent", new Float64()),
    f("par_value", new Float64()),
    f("market_currency", new Utf8()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      ticker: rows.map((r) => r.ticker),
      name: rows.map((r) => r.name),
      sector: rows.map((r) => r.sector),
      asset_class: rows.map((r) => r.assetClass),
      country: rows.map((r) => r.country),
      currency: rows.map((r) => r.currency),
      exchange: rows.map((r) => r.exchange),
      isin: rows.map((r) => r.isin),
      cusip: rows.map((r) => r.cusip),
      sedol: rows.map((r) => r.sedol),
      weight_percent: rows.map((r) => r.weightPercent),
      market_value: rows.map((r) => r.marketValue),
      notional_value: rows.map((r) => r.notionalValue),
      units_held: rows.map((r) => r.unitsHeld),
      price: rows.map((r) => r.price),
      accrual_date: rows.map((r) => dateOrNull(r.accrualDate)),
      coupon_percent: rows.map((r) => r.couponPercent),
      maturity_date: rows.map((r) => dateOrNull(r.maturityDate)),
      duration: rows.map((r) => r.duration),
      ytm_percent: rows.map((r) => r.ytmPercent),
      par_value: rows.map((r) => r.parValue),
      market_currency: rows.map((r) => r.marketCurrency),
    },
    schema,
  );
}

// ── holding_dates ─────────────────────────────────────────────────────────────

export function holdingDatesSchema(): Schema {
  return new Schema([f("as_of_date", date())]);
}

export function holdingDatesBatch(schema: Schema, rows: HoldingDateRow[]) {
  return batchFromColumns(
    {
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
    },
    schema,
  );
}

// ── fund_details ──────────────────────────────────────────────────────────────

export function fundDetailsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_name", new Utf8()),
    f("asset_class", new Utf8()),
    f("exchange", new Utf8()),
    f("index_name", new Utf8()),
    f("index_ticker", new Utf8()),
    f("cusip", new Utf8()),
    f("launch_date", date()),
    f("distribution_frequency", new Utf8()),
    f("closing_price", new Float64()),
    f("nav", new Float64()),
    f("premium_discount_percent", new Float64()),
    f("shares_outstanding", new Float64()),
    f("total_net_assets", new Float64()),
    f("thirty_day_avg_volume", new Float64()),
    f("median_bid_ask_spread_percent", new Float64()),
    f("num_holdings", new Int64()),
    f("pe_ratio", new Float64()),
    f("pb_ratio", new Float64()),
    f("beta_3y", new Float64()),
    f("standard_deviation_3y_percent", new Float64()),
    f("thirty_day_sec_yield_percent", new Float64()),
    f("twelve_month_yield_percent", new Float64()),
    f("objective", new Utf8()),
    f("key_benefits_html", new Utf8()),
  ]);
}

export function fundDetailsBatch(schema: Schema, rows: FundDetailsRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_name: rows.map((r) => r.fundName),
      asset_class: rows.map((r) => r.assetClass),
      exchange: rows.map((r) => r.exchange),
      index_name: rows.map((r) => r.indexName),
      index_ticker: rows.map((r) => r.indexTicker),
      cusip: rows.map((r) => r.cusip),
      launch_date: rows.map((r) => dateOrNull(r.launchDate)),
      distribution_frequency: rows.map((r) => r.distributionFrequency),
      closing_price: rows.map((r) => r.closingPrice),
      nav: rows.map((r) => r.nav),
      premium_discount_percent: rows.map((r) => r.premiumDiscountPercent),
      shares_outstanding: rows.map((r) => r.sharesOutstanding),
      total_net_assets: rows.map((r) => r.totalNetAssets),
      thirty_day_avg_volume: rows.map((r) => r.thirtyDayAvgVolume),
      median_bid_ask_spread_percent: rows.map((r) => r.medianBidAskSpreadPercent),
      num_holdings: rows.map((r) => bigOrNull(r.numHoldings)),
      pe_ratio: rows.map((r) => r.peRatio),
      pb_ratio: rows.map((r) => r.pbRatio),
      beta_3y: rows.map((r) => r.beta3y),
      standard_deviation_3y_percent: rows.map((r) => r.standardDeviation3yPercent),
      thirty_day_sec_yield_percent: rows.map((r) => r.thirtyDaySecYieldPercent),
      twelve_month_yield_percent: rows.map((r) => r.twelveMonthYieldPercent),
      objective: rows.map((r) => r.objective),
      key_benefits_html: rows.map((r) => r.keyBenefitsHtml),
    },
    schema,
  );
}

// ── distributions ─────────────────────────────────────────────────────────────

export function distributionsSchema(): Schema {
  return new Schema([
    f("ex_date", date()),
    f("record_date", date()),
    f("payable_date", date()),
    f("total_distribution", new Float64()),
    f("income", new Float64()),
    f("short_term_capital_gain", new Float64()),
    f("long_term_capital_gain", new Float64()),
    f("return_of_capital", new Float64()),
  ]);
}

export function distributionsBatch(schema: Schema, rows: DistributionRow[]) {
  return batchFromColumns(
    {
      ex_date: rows.map((r) => dateOrNull(r.exDate)),
      record_date: rows.map((r) => dateOrNull(r.recordDate)),
      payable_date: rows.map((r) => dateOrNull(r.payableDate)),
      total_distribution: rows.map((r) => r.totalDistribution),
      income: rows.map((r) => r.income),
      short_term_capital_gain: rows.map((r) => r.shortTermCapitalGain),
      long_term_capital_gain: rows.map((r) => r.longTermCapitalGain),
      return_of_capital: rows.map((r) => r.returnOfCapital),
    },
    schema,
  );
}

// ── nav_history ───────────────────────────────────────────────────────────────

export function navHistorySchema(): Schema {
  return new Schema([
    f("as_of_date", date()),
    f("nav", new Float64()),
    f("ex_dividends", new Float64()),
    f("shares_outstanding", new Float64()),
  ]);
}

export function navHistoryBatch(schema: Schema, rows: NavHistoryRow[]) {
  return batchFromColumns(
    {
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      nav: rows.map((r) => r.nav),
      ex_dividends: rows.map((r) => r.exDividends),
      shares_outstanding: rows.map((r) => r.sharesOutstanding),
    },
    schema,
  );
}
