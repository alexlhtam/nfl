# Open Field — coaching and submission guide

## Run the tool

Use Python 3.10 or newer. No package installation, API key, account, or network connection is needed to use the included plays.

```sh
python app.py
```

The app starts on your computer and opens the browser. If that port is occupied, choose another one:

```sh
python app.py --port 8766
```

For a presentation machine, export one self-contained file. All data, styling, controls, and calculations are embedded; the file works without an internet connection.

```sh
python app.py --export submission/open-field.html
```

Open the resulting HTML file in a browser. To run on a machine without automatically opening a browser, use `python app.py --no-browser`. The `/health` endpoint reports the loaded play count and season.

## What a coach can investigate

The question is **“Where did space open, who arrived there, and for how long?”** The tool combines defensive spacing with the actual movements and timing of receivers. It is intended for retrospective coaching review, scouting discussion, and broadcast explanation.

1. Choose a play and a receiver. Scrub from the snap to the recorded endpoint.
2. In **Space now**, inspect the distance to the nearest coverage defender around the route.
3. Switch to **Space change** to see areas defenders have vacated or closed during the preceding half-second.
4. Inspect the receiver's separation timeline and the intervals meeting the chosen distance threshold.
5. Compare with another play using the same clock, scales, and threshold. Use the formation, coverage, and play descriptions for context.
6. Export a field image for the coaching discussion. An image records one moment; retain the interactive HTML to inspect the sequence.

A revealing comparison is an opening that a receiver enters before the throw versus an opening that closes before another receiver arrives. Another is a receiver staying covered while a teammate's separation increases. These are observed sequences, not automatic judgments about play design or defensive responsibility.

## Three demonstrated observations

The included story buttons select real plays and named receivers. They are examples for coaching discussion, not evidence that one route caused a teammate's separation.

| Example | What to inspect | Recorded evidence |
| --- | --- | --- |
| Hill opens and stays open | Game `2021110100`, play `1396`, Tyreek Hill | Already 3.38 yards beyond the line of scrimmage at 1.6 seconds, his separation grows from 0.891 yards to 3.121 at 2.3 seconds, then 5.777 at the 4.1-second release. |
| A window closes before release | Game `2021110100`, play `2032`, Mecole Hardman | Separation is 3.216 yards at 3.1 seconds and 10.132 at 4.1, then falls to 2.856 at 6.2 and 1.794 at the 7.2-second release. |
| Different space on the same play | Game `2021090900`, play `3633`, Chris Godwin and Rob Gronkowski | Between 1.5 and 2.9 seconds, Godwin remains within 2.124 yards of Anthony Brown while Gronkowski's separation from Keanu Neal grows from 3.054 to 6.266 yards. |

For a short presentation, show Hill first, compare Hardman using the same threshold and clock, then use the third example to ask which movements the coach wants to review. The recorded pass outcome is context; the chart measures separation rather than throw feasibility.

## Metric definitions

For a fixed field location `q` and frame `t`, coverage space is the smallest Euclidean distance in yards from `q` to any player whose PFF role is Coverage:

```text
space(q, t) = min over coverage defenders d of distance(q, position(d, t))
change(q, t) = space(q, t) - space(q, t - 0.5 seconds)
```

The location `q` is held fixed for the change calculation. Positive change means coverage defenders have moved farther from that location; negative change means at least one has moved closer. This is not a time-averaged movement-density map. Frames with insufficient history have no change estimate.

The absolute map uses a consistent 0–8-yard colour scale, with larger distances capped for display. The change map uses a consistent -4 to +4-yard scale. Capping affects colour only, not the underlying separation measurements. The legend identifies units and the scale used.

For a selected receiver, separation is the distance to the closest Coverage defender at each recorded frame. A distance window is a continuous interval in which this separation meets or exceeds the user-selected threshold (3 yards by default). **Downfield windows only** is enabled by default: an interval also requires the receiver to be at or beyond the line of scrimmage at its start. Turn it off to include the whole route, such as a backfield release or screen. The full separation curve remains visible in both modes. Duration counts observed frame intervals, not an extra interval after the final sample. The threshold is an adjustable descriptive choice, not a calibrated definition of a catchable pass. Changing it can materially change window duration.

## Source data and reproducibility

Source: [NFL Big Data Bowl regional event repository](https://github.com/ThompsonJamesBliss/nfl-big-data-bowl-regional-event-data).

The supplied repository contains 2021 season data, despite event slide text referring to 2023 pre-throw inputs and post-throw outputs. This submission uses the files actually present in that linked repository. It does not relabel them as 2023 or invent missing post-throw trajectories. The source revision, file hashes, processing counts, and exclusions are recorded in `data/provenance.json`.

The default bundled games are Tampa Bay–Dallas (2021-09-09) and Kansas City–New York Giants (2021-11-01). The pipeline reads games, plays, players, scouting labels, and the relevant per-game tracking files. The source data remains subject to the source/event's terms; this project does not assert a new licence over NFL or PFF data.

Rebuild from the pinned public source revision (downloads only the two default games and metadata, caching raw files locally):

```sh
python data_pipeline.py --output data/demo.json
```

Rebuild from an existing directory containing the CSV files:

```sh
python data_pipeline.py --data-dir /path/to/csvs --output data/demo.json
```

Use `python data_pipeline.py --help` for the game-selection syntax. The pipeline supports adding other games from the same source schema; this is not a season-wide ranking trained on the two demonstration games.

## Coordinate and time handling

- All plays are rotated so the offense moves to the right. For leftward source plays, `x` becomes `120 - x`, `y` becomes `53.3 - y`, and direction/orientation rotate by 180 degrees.
- Relative time uses tracking frame identifiers at 10 frames per second, because source timestamp strings have only whole-second precision.
- Playback begins at the observed snap and stops at the first forward-pass release when present. Sacks and scrambles without a release stop at their observed endpoint, explicitly labelled in the app; ordinary passing plays missing the release event are excluded.
- The dataset retains all tracked players and the football, while coverage distances use the charted Coverage role. A pass rusher is still visible but is not part of this coverage-space calculation.
- Comparison is aligned on seconds since snap. Once the shorter play ends, its endpoint is identified; no additional movement is generated.

## Interpretation limits

Distance does not incorporate reaction time, momentum, passing-lane obstruction, ball travel, or the quarterback's ability to release a throw. Several defenders can produce the same minimum distance as one defender, which is why the player markers remain important. Large empty areas can be irrelevant to the offense; inspect the receiver routes alongside the map.

PFF roles and coverage labels are retrospective scouting information. The app is a review tool, not a live predictive model. A defender moving away can reflect planned zone responsibility, a response to another route, or other causes. The data does not establish target identity, route-design intent, gaze, or individual coverage assignments, and the tool does not automatically award decoy credit or assign blame.

Some source tracks extend only a few frames after the throw. This tool deliberately focuses on the observed development up to release; it cannot assess general catch or after-catch outcomes from those missing trajectories. Play descriptions and final results are contextual observations, not generated predictions.

## Verify the submission

```sh
python -m unittest discover -s tests -v
python app.py --export submission/open-field.html
```

Tests cover coordinate transformations, numerical distance and interval calculations, independent checks against bundled real tracking, release cutoffs, finite aligned data, safe offline HTML export, and a running HTTP server. Browser checks and selected demonstration evidence are recorded in `VALIDATION.md`.

An optional browser regression script is included at `tests/browser_smoke.cjs`. It uses Playwright to exercise the real exported app, including controls, comparisons, PNG downloads, offline operation, and a 390-pixel mobile viewport. The app itself does not require Node.js or Playwright.

```sh
npm install --no-save playwright
npx playwright install chromium
python app.py --export submission/Open-Field.html
node tests/browser_smoke.cjs submission
```

Browser screenshots and a machine-readable report are written into that export directory and its `qa/` subdirectory. An existing browser executable can be specified with `OPEN_FIELD_BROWSER`; `OPEN_FIELD_PLAYWRIGHT` can point to an existing Playwright module. The default runtime and Python tests remain dependency-free.

## Event deliverables

- Working Python: `app.py`, `data_pipeline.py`, and tests.
- Visualization: the interactive local app and its self-contained HTML export.
- Output screenshot: exported from the tool or the included demonstration image.
- README: the root `README.md` contains five explanatory sentences.
- Reproducibility: processed demonstration data, source provenance, methodology, and validation notes.

The submission format is **Visualization / Comparison Tool**.
