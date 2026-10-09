# Open Field coaching guide

Open Field asks: **How much of the change in a receiver’s spacing came from defensive movement?** Coverage Lift is the main measurement. The heatmap, replay, route timelines and annotations help a coach investigate the movements behind that number.

## Launch and offline use

Use Python 3.10 or newer. The application and included datasets require no dependencies, account, API key or network connection.

```sh
python app.py
python app.py --port 8766
python app.py --export submission/Open-Field.html
```

The first command starts the app and opens a browser. Use `--no-browser` to run without opening a tab. The exported HTML contains the application and default game pack; open it directly on another computer. Each exported dataset with a build ID must travel with its matching `provenance.json` when loaded through Python.

The default pack has 169 plays from DAL–TB and NYG–KC. In **Coaching workspace → Data and practice**, import `data/packs/week-1-additional/demo.json` for 152 more plays from ATL–PHI and BUF–PIT. These are four games from **2021**, the season actually present in the linked event repository; the supplied slides’ 2023 description does not match these source files. Importing a pack replaces the active library. Load the original pack again before restoring a finding from it.

## Start with the metric

1. Open the Evan Engram example at 2.1 seconds. Coverage Lift is **+2.64 yards**, receiver movement contributes **−1.54 yards**, and their sum is the **+1.09-yard** separation gain over the preceding 0.5 seconds.
2. Inspect the prior defender positions and the nearest-defender connection. Open **Routes & openings → Four distances, no black box** to reproduce the calculation.
3. Compare the Tyreek Hill example at 2.3 seconds. Its Coverage Lift is approximately **−0.10 yards**, while receiver movement contributes **+1.76 yards**. Similar openings can develop through different observed movements.
4. Inspect a negative value, change the lookback, and check sensitivity. A larger positive number is not automatically a better receiver or better play.

The [metric specification](docs/METRIC.md) gives the exact formula, parameter definitions and worked examples. The [presentation script](docs/DEMO.md) provides a short guided demonstration. Numeric claims are executable assertions, not captions inferred from video.

## Inspect the field and routes

**Space now** is the distance from each field location to its nearest defender in the selected scope. Its fixed scale is 0–8+ yards. **Space change** holds the field location fixed and compares defensive positions over the lookback, on a −4 to +4-yard scale. Colour saturation caps the display only; calculations retain their full precision. A map is unavailable until the complete lookback exists.

Select **Coverage role** for charted coverage defenders or **All defenders** to include pass rushers. The included defender count remains visible. Player motion arrows use direction of travel, not eye gaze; body orientation is a separate source measurement.

Click a player or choose one from the player menu. Select a receiver to inspect separation, the second-nearest defender, local defender counts, closing rate and leverage. A nearest-defender identity change is an observed switch, not a verified coverage handoff. Shift-click a second receiver or use the pair selector to inspect two routes on the same field.

Click empty grass to pin a field location; drag to select a region and calculate its history. Region measurements describe sampled spatial geometry. They do not establish a catchable passing lane or prove that one route caused an opening. Geometric defender allocations share interactions consistently; proposed route connections are associations and leave unsupported contributions unassigned.

**Routes & openings** aligns receiver timelines on one clock, with a numeric table as an alternative to the chart. Opening intervals must meet the visible distance threshold, minimum duration and eligibility settings. Downfield and in-bounds checks are enabled by default. Intervals already open when eligibility starts are left-censored; those still open at release or another endpoint are right-censored. The final sample adds no extra duration. “Observed so far” excludes later intervals from summaries; “Whole observed play” includes the recorded continuation.

Rolling Coverage Lift values overlap in time. Do not add them into a total “yards created” statistic. Event counts, peaks and nonoverlapping interval durations answer different questions and retain their denominators.

## Compare and retain a finding

Use **Find a comparison** to retrieve plays with similar context. Matching reasons, mismatches and candidate counts remain visible. An automatically selected comparison is a suggestion, not a matched causal experiment. Both fields share physical and colour scales; each identifies its actual observed time and endpoint.

In **Coaching workspace**:

- Save an exact moment, parameter settings and comparison as a bookmark or replay link.
- Attach a timestamped note to either play and its selected receiver.
- Add arrows, circles or text to the field, and enter coach-supplied concept or assignment labels separately from source facts.
- Build playlists and save filter combinations.
- Export the full-precision metric table, a native-resolution annotated image, an HTML findings report, or a short replay clip.
- Export a workspace file to carry notes and drawings to another computer. A replay link carries analysis state but does not transport the dataset or notes.

Notes use browser storage when available and remain in memory when storage is blocked. Export the workspace before closing a browser session that cannot persist data. Imported findings require the same dataset identity; a similar play ID is insufficient.

Replay clips use the browser’s WebM encoder. Current Chromium browsers are supported when `MediaRecorder` and canvas capture are available; unsupported browsers show an explicit message. No server or external video service is involved.

## Readability and practice

View settings control heat opacity, defender reference positions, motion arrows, links, player-role layers, contours, route trails, labels, larger text, high contrast, distinct role shapes, zoom and reduced motion. Frame controls and player menus work by keyboard. Receiver tables expose numeric content without relying on colour.

Pre-snap context uses separate source frames and pauses post-snap metrics. It does not synthesize positions before the recorded sequence. Return to the snap before exporting an analytical image or clip.

Self-directed practice hides the future continuation and outcome. Ordinary replay mode hides analytical overlays. These are review aids with no automatic “correct throw” grading. **No coach review, participant study or claim of measured coaching usefulness exists or is planned.**

## Source and provenance

Tracking and scouting source: [NFL regional event repository](https://github.com/ThompsonJamesBliss/nfl-big-data-bowl-regional-event-data), pinned at `85da22eeff2f1d5be106faa9dfe06a1205f2defd`. Raw-file hashes, transformations, exclusions, role completeness, event agreement and cohort counts are recorded beside each pack. The source/event’s terms apply to NFL and PFF data.

Optional retrospective target and outcome context comes from [nflverse](https://github.com/nflverse/nflverse-data), with the [nflfastR field documentation](https://nflfastr.com/reference/fast_scraper.html). Joins require game/play IDs, team and quarter agreement, a player identifier crosswalk, and an on-field offensive target. The tool never infers target identity from a name. EPA and pass outcome are context, not route-level credit; practice hides them.

All plays face right after rotation: left-moving positions become `x=120−x`, `y=53.3−y`, with direction and orientation rotated 180 degrees. Time comes from frame IDs at 10 Hz because the source timestamp strings have whole-second precision. Replay stops at the first forward-pass release, or the recorded sack/scramble endpoint. Passing plays with no release event are excluded. Source acceleration and displacement are retained alongside position, speed, travel direction and orientation.

Nullified plays, penalties, ambiguous field positions, missing scouting and heuristic trajectory flags stay identifiable. Cohort eligibility is an explicit conservative analysis filter, not a football ruling. Local source overrides are labelled unverified and do not inherit the pinned source’s verification claim.

## Rebuild and verify

```sh
python data_pipeline.py --output data/demo.json
python tools/build_packs.py --help
python tools/join_context.py --data data/demo.json data/packs/week-1-additional/demo.json
python -m unittest discover -s tests -v
python tools/validate_metric.py
python app.py --export submission/Open-Field.html
npm ci
npx playwright install chromium firefox
npm run test:browser
node tests/workspace_browser.cjs submission --firefox
python tools/release.py --output submission
```

Data rebuilding and optional context downloads require a network connection unless verified cached files exist. Use `python data_pipeline.py --help` for local CSV inputs and game selection. The cache is revision-aware; hashes are checked before reuse, downloads retry a bounded number of times, and paired dataset/provenance writes are staged before replacement.

Browser checks need Node.js and Playwright only for development. `OPEN_FIELD_BROWSER` can specify an existing Chromium executable, and `OPEN_FIELD_PLAYWRIGHT` an installed Playwright module. Browser reports and screenshots are written under `submission/qa/`. The application itself remains dependency-free.

The research-only motion evaluation uses independent held-out games and training-only calibration. It is separate from observed Coverage Lift and is not enabled as a predicted catch or responsibility model. See `data/model-validation.json` for errors and limitations.

The release contains Python source, the interactive visualization, data packs, metric and validation documentation, reproducible checks, screenshots and the five-sentence README. It supports both the event’s visualization/comparison and new metric formats; the statistic’s originality is its proposed formulation and application, not a claim that related spatial analytics have never existed.
