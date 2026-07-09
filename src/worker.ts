// vgi-etf-ishares stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'ishares' AS ish (TYPE vgi, LOCATION '/path/to/vgi-etf-ishares/bin/vgi-etf-ishares-worker');
//   SELECT * FROM ish.products WHERE product_view = 'etf' ORDER BY net_assets DESC LIMIT 10;
//   SELECT * FROM ish.holdings('IVV', as_of_date := DATE '2026-06-30');
//   SELECT * FROM ish.nav_history('IVV', start_date := DATE '2026-01-01');
//
// Keyless: no CREATE SECRET is needed. `products` is a base TABLE (backed by a zero-arg scan
// function that is registered for scan dispatch but not listed as a callable function); the
// other five are table functions. All take the injected HTTP client (client.ts).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeIsharesGet } from "./client.js";
import {
  makeProductsScan,
  makeHoldingsScan,
  makeHoldingDatesFunction,
  makeFundDetailsFunction,
  makeDistributionsFunction,
  makeNavHistoryFunction,
} from "./functions.js";
import { makeCatalog } from "./catalog.js";

const get = makeIsharesGet();

// The callable table functions (products and holdings are base tables, not functions).
const functions = [
  makeHoldingDatesFunction(get),
  makeFundDetailsFunction(get),
  makeDistributionsFunction(get),
  makeNavHistoryFunction(get),
];

// Backing scans for the base tables: registered so scan RPCs resolve, but NOT added to the
// catalog's `functions` (so DuckDB exposes them only as the `products` / `holdings` tables).
const productsScan = makeProductsScan(get);
const holdingsScan = makeHoldingsScan(get);

const registry = new FunctionRegistry();
for (const fn of functions) registry.register(fn);
registry.register(productsScan);
registry.register(holdingsScan);

const catalogInterface = new ReadOnlyCatalogInterface(
  makeCatalog(functions, productsScan, holdingsScan),
  registry,
);

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: [...functions, productsScan, holdingsScan], catalogInterface }).run();
