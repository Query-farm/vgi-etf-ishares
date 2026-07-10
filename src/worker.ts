// vgi-etf-ishares stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'ishares' AS ish (TYPE vgi, LOCATION '/path/to/vgi-etf-ishares/bin/vgi-etf-ishares-worker');
//   SELECT * FROM ish.products WHERE product_view = 'etf' ORDER BY net_assets DESC LIMIT 10;
//   SELECT * FROM ish.holdings('IVV', as_of_date := DATE '2026-06-30');
//   SELECT * FROM ish.nav_history('IVV', start_date := DATE '2026-01-01');
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();
