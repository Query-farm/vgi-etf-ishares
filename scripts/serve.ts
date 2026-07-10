// Serve the vgi-etf-ishares worker over HTTP with the standardized VGI landing surface.
//
//   GET  /                                     → the shared vendored VGI landing.html
//   GET  /describe.json                        → the worker's catalog introspection
//   GET  /describe/{catalog}/{schema}/{t}.json → lazy per-object columns
//   GET  /health                               → JSON health endpoint
//   POST /                                     → the VGI RPC transport (what DuckDB attaches to)
//
// Run it:  PORT=8787 bun run scripts/serve.ts   (default port 8787)
// Attach:  ATTACH 'ishares' AS ishares (TYPE vgi, LOCATION 'http://localhost:8787');
//
// Everything below the worker's own identity — protocol assembly, state-token
// signing, CORS, the landing surface, Bun.serve — lives in the SDK's
// serveVgiWorker. Set VGI_SIGNING_KEY (64 hex chars) for any real deployment;
// without it the SDK generates an ephemeral key and warns.

import { serveVgiWorker } from "@query-farm/vgi/serve";
import { makeWorkerParts } from "../src/parts.js";

const { registry, catalogInterface } = makeWorkerParts();

serveVgiWorker({
  name: "ishares",
  doc: "iShares (BlackRock) US fund data: product catalog, multi-day holdings, and per-fund history.",
  version: "0.1.0",
  repositoryUrl: "https://github.com/Query-farm/vgi-etf-ishares",
  serverId: "vgi-etf-ishares",
  registry,
  catalogInterface,
});
