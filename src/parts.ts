// Single source of truth for what this worker serves.
//
// Both entrypoints consume this: `src/worker.ts` (stdio, spawned by DuckDB) and
// `scripts/serve.ts` (HTTP). They used to build the registry and catalog
// separately, so adding a function meant remembering to register it twice —
// miss one and the HTTP transport quietly serves a stale catalog.
//
// Keyless: no CREATE SECRET is needed. `products` and `holdings` are base TABLEs
// (backed by scan functions that are registered for scan dispatch but not listed
// as callable functions); the other four are table functions. All take the
// injected HTTP client (client.ts).

import { FunctionRegistry, ReadOnlyCatalogInterface } from "@query-farm/vgi";
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

export function makeWorkerParts() {
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

  return {
    registry,
    catalogInterface,
    /** Everything the registry serves, including the table-backing scans. */
    servedFunctions: [...functions, productsScan, holdingsScan],
  };
}
