// A tiny in-process fake of the iShares endpoints — enough to prove the driver: it records
// every requested URL (so a test can assert the wire contract) and returns canned envelopes
// shaped like the real product-screener JSON and get-product-data JSON. No network. Matches
// the driver's injected `get(url) => Promise<unknown>` signature.

export class FakeIshares {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly responder: (url: string) => unknown) {}

  get = async (url: string): Promise<unknown> => {
    this.calls.push(url);
    return this.responder(url);
  };

  /** Route by URL: the screener path vs get-product-data component. */
  static router(routes: {
    screener?: unknown;
    holdings?: (asOfDate: string | null) => unknown;
    keyFundFacts?: unknown;
    fundamentalsAndRisk?: unknown;
    fundHeader?: unknown;
    fundDownload?: unknown;
  }): FakeIshares {
    return new FakeIshares((url) => {
      if (url.includes("product-screener")) return routes.screener ?? {};
      const u = new URL(url);
      const component = u.searchParams.get("component") ?? "";
      const asOf = u.searchParams.get("asOfDate");
      if (component === "holdings.all") return routes.holdings ? routes.holdings(asOf) : {};
      if (component === "keyFundFacts") return routes.keyFundFacts ?? {};
      if (component === "fundamentalsAndRisk") return routes.fundamentalsAndRisk ?? {};
      if (component === "fundHeader") return routes.fundHeader ?? {};
      if (component === "fundDownload") return routes.fundDownload ?? {};
      return {};
    });
  }
}

// ── product screener ──────────────────────────────────────────────────────────

/** A screener envelope with one ETF, one mutual fund, and fields covering { d, r } pairs,
 *  bare strings, and the "-" / " " "no data" sentinels. */
export function screenerEnvelope(): Record<string, unknown> {
  return {
    "239726": {
      productType: "ISHARES_FUND_DATA",
      productView: ["etf"],
      portfolioId: 239726,
      localExchangeTicker: "IVV",
      fundName: "iShares Core S&P 500 ETF",
      isin: "US4642872000",
      cusip: "464287200",
      sedol: "-", // sentinel → null
      aladdinAssetClass: "Equity",
      aladdinSubAssetClass: "Large Cap",
      aladdinRegion: "North America",
      aladdinCountry: "United States",
      aladdinMarketType: "Developed",
      investmentStyle: "[Index]", // → "Index"
      inceptionDate: { d: "May 15, 2000", r: 20000515 },
      navAmount: { d: "751.20", r: 751.197989 },
      navAmountAsOf: { d: "Jul 07, 2026", r: 20260707 },
      totalNetAssets: { d: "888,066,262,620", r: 888066262620.0 },
      totalNetAssetsFundAsOf: { d: "Jul 07, 2026", r: 20260707 },
      ter: { d: "0.03", r: 0.03 },
      mgt: { d: "0.03", r: 0.03 },
      netr: { d: "0.03", r: 0.03 },
      thirtyDaySecYield: { d: "1.20", r: 1.2 },
      twelveMonTrlYield: { d: "1.25", r: 1.25 },
      dailyPerformanceYearToDate: { d: "8.10", r: 8.1 },
      navOneYearAnnualized: { d: "12.00", r: 12.0 },
      navThreeYearAnnualized: { d: "15.00", r: 15.0 },
      navFiveYearAnnualized: { d: "14.00", r: 14.0 },
      navTenYearAnnualized: { d: "13.00", r: 13.0 },
      navSinceInceptionAnnualized: { d: "7.50", r: 7.5 },
      priceOneYearAnnualized: { d: "11.90", r: 11.9 },
      priceThreeYearAnnualized: { d: "14.90", r: 14.9 },
      priceFiveYearAnnualized: { d: "13.90", r: 13.9 },
      priceTenYearAnnualized: { d: "12.90", r: 12.9 },
      priceSinceInceptionAnnualized: { d: "7.40", r: 7.4 },
      productPageUrl: "/us/products/239726/ishares-core-sp-500-etf",
    },
    "999999": {
      productType: "ISHARES_FUND_DATA",
      productView: ["mutualfund"],
      portfolioId: 999999,
      localExchangeTicker: " ", // sentinel → null ticker
      fundName: "iShares Example Mutual Fund",
      isin: "US0000000000",
      cusip: "000000000",
      sedol: "0000000",
      aladdinAssetClass: "Fixed Income",
      investmentStyle: "[Active]",
      navAmount: { d: "10.00", r: 10.0 },
      ter: "-", // sentinel → null number
      productPageUrl: "/us/products/999999/example",
    },
  };
}

// ── get-product-data envelopes ──────────────────────────────────────────────────

/** Wrap parallel-array columns as a get-product-data component→container→dataPoints tree. */
function component(name: string, containers: Record<string, Record<string, unknown[] | number>>) {
  const containersByNameMap: Record<string, unknown> = {};
  for (const [cName, points] of Object.entries(containers)) {
    const dataPointsByNameMap: Record<string, unknown> = {};
    for (const [pName, value] of Object.entries(points)) dataPointsByNameMap[pName] = { value };
    containersByNameMap[cName] = { dataPointsByNameMap };
  }
  return { componentsByNameMap: { [name]: { containersByNameMap } } };
}

/** A holdings.all envelope with two constituents (one carrying a "-" cell) + a dateList. */
export function holdingsEnvelope(asOfDate: string | null): unknown {
  const day = asOfDate ? Number(asOfDate) : 20260707;
  const env = component("holdings", {
    all: {
      issueName: ["NVIDIA CORP", "APPLE INC"],
      ticker: ["NVDA", "AAPL"],
      sectorName: ["Information Technology", "Information Technology"],
      assetClass: ["Equity", "Equity"],
      countryOfRisk: ["United States", "United States"],
      currencyCode: ["USD", "USD"],
      exchange: ["NASDAQ", "NASDAQ"],
      isin: ["US67066G1040", "US0378331005"],
      cusip: ["67066G104", "037833100"],
      sedol: ["-", "2046251"], // a "-" cell → null
      holdingPercent: [7.38, 7.06],
      marketValue: [65531934693.01, 62688091030.46],
      notionalValue: [65531934693.01, 62688091030.46],
      unitsHeld: [332767657.0, 201790031.0],
      unitPrice: [196.93, 310.66],
      accrualDate: ["-", "-"],
      asOfDate: day as unknown as number,
      dateList: [20260707, 20260630, 20251231] as unknown as number[],
    },
  });
  return { fundName: "iShares Core S&P 500 ETF", aladdinFundTicker: "IVV", ...env };
}

/** A bond-fund holdings.all envelope: same columns plus the fixed-income-only fields. */
export function bondHoldingsEnvelope(): unknown {
  const env = component("holdings", {
    all: {
      issueName: ["TREASURY NOTE", "TREASURY BOND"],
      ticker: ["T", "T"],
      sectorName: ["Treasury", "Treasury"],
      assetClass: ["Fixed Income", "Fixed Income"],
      countryOfRisk: ["United States", "United States"],
      currencyCode: ["USD", "USD"],
      exchange: ["-", "-"],
      isin: ["US91282CJL55", "US912810TW33"],
      cusip: ["91282CJL5", "912810TW3"],
      sedol: ["-", "-"],
      holdingPercent: [0.55, 0.42],
      marketValue: [550000000.0, 420000000.0],
      notionalValue: [550000000.0, 420000000.0],
      unitsHeld: [540000000.0, 410000000.0],
      unitPrice: [101.85, 102.44],
      accrualDate: ["-", "-"],
      couponRate: [4.63, 3.88],
      maturityDate: [20340215, 20540515],
      duration: [6.92, 18.4],
      yieldToMaturity: [4.5, 4.62],
      parValue: [540000000.0, 410000000.0],
      marketCurrencyCode: ["USD", "USD"],
      asOfDate: 20260707 as unknown as number,
      dateList: [20260707] as unknown as number[],
    },
  });
  return { fundName: "iShares Core U.S. Aggregate Bond ETF", aladdinFundTicker: "AGG", ...env };
}

/** A keyFundFacts envelope (scalar data points) + root fundName/ticker. */
export function keyFundFactsEnvelope(): unknown {
  const dp = (v: unknown) => ({ value: v });
  return {
    fundName: "iShares Core S&P 500 ETF",
    aladdinFundTicker: "IVV",
    pageScopeData: { ticker: "IVV", productName: "iShares Core S&P 500 ETF" },
    componentsByNameMap: {
      keyFundFacts: {
        containersByNameMap: {
          default: {
            dataPointsByNameMap: {
              assetClass: dp("Equity"),
              closingPrice: dp(751.08),
              cusip: dp("464287200"),
              distributionFrequency: dp("Quarterly"),
              exchange: dp("NYSE Arca"),
              indexSeriesName: dp("S&P 500 Index (USD)"),
              indexTicker: dp("SPTR"),
              launchDate: dp(20000515),
              premiumDiscountClosingPriceNavPercent: dp(-0.02),
              sharesOutstanding: dp(1182200000.0),
              thirtyDayAverageVolume: dp(13002243.0),
              thirtyDayMedianBidAskSpread: dp("0.01%"),
              totalNetAssetsFundLevel: dp(888066262620.0),
            },
          },
        },
      },
    },
  };
}

/** A fundamentalsAndRisk envelope (scalar data points). */
export function fundamentalsEnvelope(): unknown {
  const dp = (v: unknown) => ({ value: v });
  return {
    componentsByNameMap: {
      fundamentalsAndRisk: {
        containersByNameMap: {
          default: {
            dataPointsByNameMap: {
              beta3Yr: dp(1.0),
              numHoldings: dp(509),
              priceBook: dp(4.8),
              priceEarnings: dp(26.5),
              standardDeviation3Yr: dp(17.2),
              thirtyDaySecYield: dp(1.2),
              twelveMonTrlYld: dp(1.25),
            },
          },
        },
      },
    },
  };
}

/**
 * A fundHeader envelope with the `content` narrative block (only present when content is not
 * excluded). fund_objective is entity-encoded plain text; key_benefits is HTML.
 */
export function fundHeaderEnvelope(): unknown {
  return {
    componentsByNameMap: { fundHeader: { containersByNameMap: {} } },
    content: {
      fund_objective: [
        { text: "The iShares Core S&amp;P 500 ETF seeks to track the investment results of an index composed of large-capitalization U.S. equities." },
      ],
      key_benefits: [
        { text: "<p>1. <strong>Exposure</strong> to 500 of the largest U.S. companies</p>" },
      ],
    },
  };
}

/** A fundDownload envelope with distributions + historical (NAV) containers. */
export function fundDownloadEnvelope(): unknown {
  return component("fundDownload", {
    distributions: {
      exDate: [20260615, 20260317],
      recordDate: [20260615, 20260317],
      payableDate: [20260618, 20260320],
      totalDistribution: [1.995653, 1.783517],
      incomeAmount: [1.995653, 1.783517],
      shortTermCapitalGain: [0.0, 0.0],
      longTermCapitalGain: [0.0, 0.0],
      returnOnCapital: [0.0, 0.0],
    },
    historical: {
      asof: [20260707, 20260706],
      nav: [751.20, 754.56],
      exDividends: ["-", "-"], // "-" → null
      sharesOutstanding: [1182200000.0, 1182600000.0],
    },
  });
}
