# Validation record

Validated on 9 October 2026 against the actual files in this repository.

## Dataset

- 169 included plays from two 2021 games; 171 source plays considered.
- Two passing plays lacking an explicit `pass_forward` event are excluded and listed in `data/provenance.json`.
- 5,359 frames, 23 entities per frame, and 123,257 player/ball positions independently checked against the source CSVs.
- All 788 receiver series and 25,016 separation samples independently recomputed.
- Source CSV SHA-256 hashes checked for all six input files.
- A fresh download from pinned source commit `85da22eeff2f1d5be106faa9dfe06a1205f2defd` reproduced `data/demo.json` byte for byte.
- The source season is 2021; the slide description of 2023 does not match these files.

## Automated Python checks

`python -m unittest discover -s tests -v`: **22 tests passed**.

Coverage includes physical coordinate rotation and angular conventions, known-distance synthetic examples, nearest-defender changes and ties, exact-threshold intervals, endpoint accounting, malformed frame rejection, actual-data metric comparisons, throw cutoffs, JSON embedding, a real HTTP server, and standalone HTML export without external assets.

The two-game demonstration can be rebuilt from local CSVs or the pinned public source. The provenance file records processing choices and source hashes separately from the compact app dataset.

## Browser checks

The real exported HTML was exercised in Microsoft Edge through Playwright at a 1440-pixel desktop viewport and a 390-pixel mobile viewport. The optional reproducible script is `tests/browser_smoke.cjs`.

Passed flows:

- Offline opening with no HTTP requests or external dependencies.
- Correct curated default play and receiver.
- Two-play comparison and explicit endpoint state when the shorter play ends.
- Full half-second history required for the change map.
- PNG export with actual field content, numerical colour legends, each play's actual timestamp, endpoint labels, and the insufficient-history state.
- Same-play comparison with two different receivers.
- Empty search, player-name search, and offense filtering.
- Downfield-window toggle and separation-threshold adjustment.
- Method-dialog opening and keyboard dismissal.
- Frame stepping and playback stopping at the observed release.
- Mobile single-play and comparison layouts without horizontal overflow.
- Zero JavaScript runtime errors during the exercised flows.

Additional executed JavaScript checks verified shared physical scale in comparisons, field-grid cell alignment, fixed-location change calculations, nearest preceding-frame selection, threshold interval accounting, and the downfield eligibility mask. Field snapshots preserve the canvas aspect ratio.

## Visual review

Desktop, comparison, mobile, and exported-image views were opened and visually inspected. The app preserves distance units, consistent colour scales, all-player context, and visible endpoint labels. The included preview illustrates the actual dataset and interface, rather than synthetic trajectories.

These checks establish correctness of the implemented geometric calculations and demonstrated workflows. They do not validate receiver availability, catch probability, causal route credit, or a season-wide scouting ranking.
