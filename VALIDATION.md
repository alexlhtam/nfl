# Validation record

Validated on 9 October 2026. The metric and application are experimental; validation here concerns data, calculations, software behavior and reproducibility.

## Source data

The two included packs contain **321 plays from four 2021 games**, with four excluded source plays recorded explicitly. Independent raw-CSV auditing checked **280,347 entity observations**: 233,818 replay observations and 46,529 pre-snap observations, each retaining seven motion values. All **47,532 separation samples** were independently recomputed. Coordinate and separation comparisons matched at reported precision; the largest floating-point difference was approximately 8.53×10⁻¹⁴ in angle transformation.

The audits verify source hashes, metadata, scouting roles, timing, normalization, penalties, quality flags, cohort denominators, and exclusion reasons. Reports:

- [Original pack source audit](data/source-audit.json)
- [Additional pack source audit](data/packs/week-1-additional/source-audit.json)
- [Original provenance](data/provenance.json) and [additional provenance](data/packs/week-1-additional/provenance.json)

The verified external context join matches all 321 plays and maps 252 recorded targets through player IDs; targets are never guessed by name. [Join evidence](data/outcome-context.json) records source checksums and unresolved/rejected counts. Browser imports inherit this context only when the exact imported bytes match a known pack checksum; altered files remain usable after schema/geometry validation but are labelled unverified and do not inherit outcome claims.

## Metric evidence

The original pack passes **21,076 valid decompositions and 119 qualifying opening events**; the additional pack passes **18,936 decompositions and 108 opening events**. Together, that is **40,012 decompositions and 227 events** under the recorded default options. All four featured numerical claim sets pass. The validation checks signed additivity, captured-value bounds, exact defender allocation conservation, and association budgets.

- [Original metric report](data/metric-validation.json)
- [Additional metric report](data/packs/week-1-additional/metric-validation.json)
- [Definition and worked examples](docs/METRIC.md)

The minimum-hold rule requires observed above-threshold samples through the confirmation time. A closing sample cannot certify a hold ending at that same instant. Raw intervals remain separately available. Regional arrival requires actual geometric entry; crossing an eligibility boundary while already inside is labelled separately.

## Python and cross-runtime checks

The full local suite passed **93 tests**. It includes synthetic and real geometry, nearest-defender switches, replacement coverage, shared translation, threshold precision, eligibility and censoring, signed allocations, coordinate-jitter sensitivity, malformed source data, download/cache integrity, paired-output rollback, source audits, optional context joins, safe HTML embedding, live HTTP serving, and offline export.

Python and JavaScript share numeric fixtures and full-result parity checks. Both dataset validators reject 50 shared corruption cases and accept both complete real packs, including legacy and nullable track extensions.

```sh
python -m unittest discover -s tests -v
node tests/metrics_js.cjs
python tools/validate_metric.py
python tools/validate_metric.py --data data/packs/week-1-additional/demo.json --output data/packs/week-1-additional/metric-validation.json
```

## Real-browser behavior

The exported HTML passed 43 scenarios in Microsoft Edge through Playwright at desktop and 390-pixel mobile widths. The app made no runtime HTTP requests and produced no JavaScript errors in these checks. Interface and analytical checks also passed under sixfold CPU throttling; synchronization waits for completed rendering rather than fixed delays.

- `tests/browser_features.cjs`: replay, comparisons, snap/release/downfield/manual alignment, shared physical scales, selection/clock behavior, search and empty states, region masks, lane overlay, keyboard inspection, enlargement, accessibility controls, receiver tables, pre-snap restoration, atomic state rejection, and mobile layout.
- `tests/analytical_browser.cjs`: exact Engram/Hill values, consecutive-frame nearest-defender markers, minimum-hold qualification, defender-scope counts, signed export values, blind-mode future-coordinate invariance, ordinary-replay concealment, and invalidation of stale diagnostics.
- `tests/workspace_browser.cjs`: saved moments, notes on both comparison plays, playlists, filters, workspace round trips, full-precision CSV, native 2000×1500 PNG, HTML findings, encoded and decoded WebM, drawings, practice, extra packs, mobile controls, and memory fallback when storage is unavailable.
- `tests/workspace_integrity.cjs`: known versus altered pack hashes, stripped forged outcome context, isolation of notes between datasets with identical play IDs, exact-identity import checks, restoration of original findings, negative-time drawings, and future-note exclusion from blind images/reports.

Reports and screenshots are written to `submission/qa/` by the scripts. [GitHub run 37922792353](https://github.com/alexlhtam/nfl/actions/runs/37922792353) passed on commit `ba69d19`: Python 3.10 and 3.12 on Windows and Linux, all four Chromium suites, the portable-workspace suite on Firefox, numerical claim reproduction, and release generation. The attached pull request also shows checks for subsequent documentation-only revisions.

## Research baseline

A separate research experiment evaluates 0.5-second motion projection using four independent held-out game folds and **188,342 observed targets**. Features are current position, speed and travel direction; targets never extend beyond release or the observed endpoint. A held-out game's frames and plays never enter training.

The equal-game mean endpoint error is **1.4819 yards** for stationary projection and **0.3888 yards** for constant velocity. Training-only constrained shrinkage also yields **0.3888 yards**: it does not improve the baseline. Per-game errors, corrected equal-game RMSE, split IDs and source hashes are in [the report](data/model-validation.json).

No forecast is enabled in the coaching app. Four games do not establish season-wide generalization, and correlated frames are not treated as independent evidence of statistical significance.

## Scope and limitations

There are **no human reviewers or participant studies**, now or planned, as explicitly directed by the user. Backlog items 94–95 were withdrawn; no expert-validated coaching usefulness or performance improvement is claimed. The remaining requirements and their implementation evidence are tracked in [the acceptance matrix](docs/requirements.json).

Coverage Lift is an exact decomposition of selected observed geometry. Hybrid positions are mathematical reference configurations, not a claim about a feasible alternative play. Shared motion can create opposing signed contributions with zero net gain. Separation, lane geometry, leverage and co-movement do not establish catch probability, gaze, responsibility, route intent or causal decoy credit.

## Release

The release builder embeds the modular assets and a verified default pack into one HTML file, includes both packs and working Python, fixes archive entry timestamps, and writes per-file SHA-256 hashes plus Git metadata. Native image export redraws the field and charts at output resolution; it does not enlarge a screen capture.

```sh
python app.py --export submission/Open-Field.html
npm ci
npx playwright install chromium firefox
npm run test:browser
node tests/workspace_browser.cjs submission --firefox
node tools/capture_demo.cjs submission
python tools/release.py --output submission
```

Line endings are fixed by `.gitattributes` so checked-in source bytes and provenance hashes agree across platforms. Raw-source auditing is independently repeatable with `tools/audit_source.py` and the pinned CSVs; raw CSVs are not required for ordinary offline use.

Independent verification of clean commit `ba69d19` produced two byte-identical release archives, verified all 64 manifest file checksums, and regenerated the packaged HTML byte-for-byte after extraction. The extracted package ran the 93-test suite: 91 passed and two optional raw-CSV audits were skipped because their caches are deliberately excluded from the release. Both raw-source audits had passed separately on the full local sources. Final delivery is rebuilt from its recorded commit and accompanied by a fresh archive checksum and verification receipt.
