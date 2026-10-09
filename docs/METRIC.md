# Coverage Lift

Coverage Lift is an experimental geometric statistic measured in yards over a stated observation interval. It describes the part of a receiver's separation change associated with changing coverage-defender positions under a symmetric decomposition. It is not a catch-probability model, a player-ability grade, or proof that another route caused a defender to move.

## Definition

Let `C(r, D)` be the Euclidean distance from receiver position `r` to the nearest defender in the explicitly selected set `D`. For the receiver and defensive positions at the start and end of an interval, calculate:

| Value | Receiver position | Defensive positions |
| --- | --- | --- |
| `s00` | start | start |
| `s10` | end | start |
| `s01` | start | end |
| `s11` | end | end |

```text
Coverage Lift   = ((s01 - s00) + (s11 - s10)) / 2
Receiver motion = ((s10 - s00) + (s11 - s01)) / 2
Net change      = s11 - s00 = Coverage Lift + Receiver motion
```

Both calculation orders receive equal weight. This removes an arbitrary order choice while making no claim that the mixed configurations describe a physically realized alternative play. Recompute the nearest defender for every evaluation; the defender can change between positions or times.

Positive Coverage Lift means changing defensive positions increased the evaluated spacing. Negative Coverage Lift means they reduced it. A positive component can be larger than the net increase when the other component is negative. Contributions must remain signed; they are not percentages. Shared motion can produce opposing components with zero net separation change.

## Observation rules

- Default lookback: 0.5 seconds, from aligned observations at 10 Hz.
- Default distance threshold: 3 yards; minimum observed window duration: 0.2 seconds.
- Default population: charted PFF Coverage defenders; the all-defender option is a different, explicitly labelled scope.
- Downfield and in-bounds eligibility are explicit options. Retain raw measurements and quality flags.
- Missing history is unavailable, not zero. Do not fabricate continuation beyond the recorded endpoint.
- A continuing window at release is right-censored: its observed duration is known, its eventual closing time is not.
- Compare using full-precision distances. Round only presentation.
- Do not sum overlapping half-second values into total yards created. Opening-event summaries count qualifying episodes, and show their observation rules.
- Blind practice restricts statistics and event confirmation to the currently observed time. It conceals outcomes and future tracks.

## Verified examples

The executable claims in `data/stories.json` are verified by `python tools/validate_metric.py`.

| Example | Interval | Coverage Lift | Receiver motion | Net change |
| --- | --- | ---: | ---: | ---: |
| Evan Engram, `2021110100_2120` | 1.6–2.1 s | +2.637602394 yd | −1.543197074 yd | +1.094405320 yd |
| Tyreek Hill, `2021110100_1396` | 1.8–2.3 s | −0.095512347 yd | +1.755117016 yd | +1.659604669 yd |

Engram remains above three yards from 2.1 seconds through the 3.1-second release. The play description records a pass to Devontae Booker. Hill's opening is associated with his movement through the changing coverage geometry, and lasts through the 4.1-second release. These observations do not establish route intent, defensive responsibility, or the reason for the defender movements.

## Defender allocation and route interactions

An on-demand exact Shapley allocation changes individual defenders from their earlier to later positions across all coalitions, averaged at both receiver positions. The signed defender allocations sum to Coverage Lift, including replacement coverage and opposing effects. It is a decomposition of the selected geometry, not a causal assignment of football responsibility.

Route-assist candidates combine observed defender contributions with proximity and co-movement evidence for another receiver. They remain associations. Ambiguous or unlinked contributions remain unassigned; the interface must not force a teammate explanation. Region analysis measures where space changes and when receivers enter the selected region, rather than inferring a target or intended route.

## Sensitivity and validation

Test additivity, receiver-only and defender-only movement, shared translation, rotations, defender ordering, ties, nearest-defender switches, replacement coverage, missing history, endpoint accounting, and threshold boundaries. Python and JavaScript share fixture expectations. Parameter sensitivity varies thresholds and lookbacks; coordinate jitter is a declared hypothetical sensitivity analysis, not a calibrated confidence interval.

No trainable model is needed for this statistic. Future availability or defender-response models require separately defined labels, baselines, and evaluation on independent games. Rows or frames from the same play must not cross train/test boundaries. Retrospective scouting labels must not be presented as pre-snap predictive knowledge.

## Related work and novelty scope

This project defines and demonstrates Coverage Lift as a coaching metric. It does not claim that separation analysis, space creation, symmetric decompositions, Shapley allocation, or hypothetical defender comparisons are unprecedented. Related work includes [NFL/AWS coverage responsibility](https://aws.amazon.com/blogs/media/nfl-next-gen-stats-and-aws-decode-defense-coverage-patterns/) and [NFL Ghosts](https://arxiv.org/abs/2406.17220). The contribution here is the explicit signed decomposition connected to inspectable tracking, observed openings, sensitivity, and a portable coaching workflow.
