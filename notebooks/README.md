# iShares notebooks

[01 · Which IVV equity weights changed between two year-end snapshots?](01_historical_weights_need_matched_identifiers.ipynb) reads IVV at December 31, 2024 and December 31, 2025, reconciles equity ISIN groups, and compares matched weights. A separate experiment raises the reporting threshold from 0.20 to 0.50 percentage points.

## Run

Requirements: [uv](https://docs.astral.sh/uv/), Python 3.13+ (uv can install it), and internet access to GitHub/package sources and iShares. No API key, Bun installation or worker checkout is needed.

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py --timeout 300
```

The locked environment uses Haybarn 2.0.0rc11. Visible SQL attaches `github-auto://Query-farm/vgi-etf-ishares@v0.4.0`, release commit `8bb3494cd93feb0bfc2a9ebefa78e48f3965bd9e`. VGI downloads the native platform asset, verifies the published SHA-256 and caches the executable. Upgrade the release deliberately and rerun defaults and the experiment.

Optional editor kernel:

```sh
uv run --locked python -m ipykernel install --user --name vgi-etf-ishares-notebooks --display-name "Python (vgi-etf-ishares notebooks)"
```

Use this directory as the working directory, then Restart Kernel → Run All. The runner creates a temporary kernel registration and saves a notebook only after every cell succeeds.

## Separate experiment

```sh
uv run --locked python execute.py --timeout 300 --parameters '{"MIN_CHANGE_PP":0.50}' --output-dir artifacts/threshold-050
```

Overrides require a separate destination. Branding, docs, runner and locked environment accompany the copy. Restore 0.20 for defaults. Generated artifacts, extracted charts and virtual environments are ignored.

## Data and limitations

Source: [iShares IVV product and holdings page](https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf). The real published worker requests two historical `holdings.all` snapshots from the public iShares JSON endpoint. Both scans select only IVV. Its product screener cache is process-local for 24 hours; holdings requests go live. There is no synthetic or replay fallback.

The `AT` coordinates are calendar DATE values, without timezone. UTC acquisition bounds are displayed separately. The worker uses a payload date when available, otherwise the requested coordinate; checking its resolved date does not prove the endpoint supplied one. Empty snapshots or mismatched dates stop execution. Historical responses can be revised and do not provide an immutable revision ID. The experiment compares complete snapshot fingerprints before attributing differences to the threshold.

The released worker has a nonpartition holdings-filter limitation. This notebook pushes only the supported fund partition selector and materializes all returned lines before applying asset-class, identifier and threshold filters locally. Missing equity ISINs are counted and excluded from matching, repeated ISIN rows are summed within each snapshot, and incomplete equity weight groups stop the comparison. A full outer join keeps one-sided identifiers separate rather than replacing their absent comparison weight with zero. ISIN changes can still break economic continuity; this is not issuer-level reconciliation.

Weights are reported percent points and remain unnormalized. Cash and derivative lines stay in diagnostics; missing weights are unavailable, not zero. iShares notes that holdings values can differ from the fund's NAV valuation and accounting book. Differences in two reported weights do not identify trades, turnover, returns or causal drivers. This example provides no investment recommendation.
