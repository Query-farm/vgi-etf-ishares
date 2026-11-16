#!/usr/bin/env bash
# The SQLLogic suite now runs through the starter-standard ci/run-integration.sh over
# every transport (stdio, launch, http). Kept so `./run_tests.sh` still works:
# it is `make test-sql-all`. One transport: `make test-sql TRANSPORT=launch`.
exec make -C "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" test-sql-all
