"""Coverage Lift 2.0: transparent geometry, not causal route credit.

The JavaScript twin is web/src/metrics.js. Both implement the same unrounded
metric and return JSON-compatible dictionaries. Public functions accept a
schema-1 play, receiver ID, frame index (where applicable), and options.

coverage_lift splits an observed separation change exactly into coverage and
receiver motion, averaging the two orders of changing those positions. captured
is the positive coverage component capped by the positive actual gain, and is
zero outside the chosen receiver eligibility scope. It is not catch probability.

series rows contain frame/time, nearest-defender measurements, eligibility and
the flat lift fields. windows classifies each actual observed interval using
its starting sample and returns intervals confirmed through minDuration;
rawIntervals/rawTotal retain unfiltered observations. Cutoff options truncate retrospective
analysis. events confirms an observed threshold upcrossing only after the
minimum observed duration. Exact Shapley decomposition runs only on request.

All rates are yards/second, distances yards, times seconds, percentages 0..100.
Jitter ranges are deterministic stress tests, not confidence intervals. Assist
candidates represent co-motion associations and retain an unassigned residual.
"""
from __future__ import annotations

import math
from statistics import median

VERSION = "2.0.0"
EPS = 1e-9
DEFAULTS = {
    "scope": "coverage", "threshold": 3.0, "lookback": 0.5,
    "minDuration": 0.2, "downfieldOnly": True, "inBoundsOnly": True,
    "fieldWidth": 53.3, "fieldLength": 120.0, "maxGap": 0.15,
}


def _options(options=None):
    result = {**DEFAULTS, **(options or {})}
    if result["scope"] not in {"coverage", "all"}:
        raise ValueError("scope must be coverage or all")
    for key in ("threshold", "lookback", "minDuration", "fieldWidth", "fieldLength", "maxGap"):
        value = result[key]
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError(f"{key} must be a finite nonnegative number")
        if key in {"lookback", "fieldWidth", "fieldLength", "maxGap"} and value == 0:
            raise ValueError(f"{key} must be positive")
    return result


def _player(play, player_id):
    return next((p for p in play.get("players", []) if str(p.get("id")) == str(player_id)), None)


def _point(player, frame):
    if player is None or not isinstance(frame, int) or frame < 0:
        return None
    track = player.get("track", [])
    if frame >= len(track):
        return None
    row = track[frame]
    if not isinstance(row, (list, tuple)) or len(row) < 2:
        return None
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in row[:2]):
        return None
    return row[:2]


def frame_at(play, time):
    """Index of the last observation at/before time; clamp to observed bounds."""
    times = play.get("times", [])
    if not times:
        return -1
    lo, hi = 0, len(times) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if times[mid] <= time + EPS:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _end_frame(play, options):
    last = len(play.get("times", [])) - 1
    if "throughTime" in options:
        if not play.get("times") or options["throughTime"] < play["times"][0] - EPS:
            return -1
        last = min(last, frame_at(play, options["throughTime"]))
    if "throughFrame" in options:
        last = min(last, int(options["throughFrame"]))
    return max(-1, last)


def defenders(play, scope="coverage"):
    if scope not in {"coverage", "all"}:
        raise ValueError("scope must be coverage or all")
    return sorted((p for p in play.get("players", [])
                   if p.get("side") == "defense" and (scope == "all" or p.get("role") == "coverage")),
                  key=lambda p: str(p["id"]))


def _eligible(play, point, options):
    if point is None:
        return False, "Missing receiver position"
    if options["inBoundsOnly"] and not (0 <= point[0] <= options["fieldLength"] and 0 <= point[1] <= options["fieldWidth"]):
        return False, "Receiver outside field boundaries"
    if options["downfieldOnly"] and point[0] < float(play.get("los", 0)) - EPS:
        return False, "Receiver behind line of scrimmage"
    return True, ""


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _space(point, positions):
    return min(_dist(point, q) for q in positions)


def _ordered_distances(play, point, frame, options):
    ds = defenders(play, options["scope"])
    if not ds or any(_point(d, frame) is None for d in ds):
        return []
    return sorted((_dist(point, _point(d, frame)), str(d["id"])) for d in ds)


def nearest(play, receiver_id, frame, options=None):
    opts = _options(options)
    receiver = _player(play, receiver_id)
    point = _point(receiver, frame)
    invalid = {"valid": False, "distance": None, "nearestId": None, "secondDistance": None,
               "secondId": None, "within3": 0, "within5": 0, "closingRate": None,
               "separationRate": None, "leverage": None, "nearestSwitch": False}
    if point is None or frame >= len(play.get("times", [])):
        return {**invalid, "reason": "Missing receiver observation"}
    ranked = _ordered_distances(play, point, frame, opts)
    if not ranked:
        return {**invalid, "reason": "Incomplete or absent defender observations"}
    distance, defender_id = ranked[0]
    defender = _player(play, defender_id)
    dp = _point(defender, frame)
    inside = abs(dp[1] - opts["fieldWidth"] / 2) < abs(point[1] - opts["fieldWidth"] / 2)
    deeper = dp[0] > point[0]
    leverage = {"lateral": dp[1] - point[1], "downfield": dp[0] - point[0],
                "inside": inside, "deeper": deeper,
                "label": ("inside" if inside else "outside") + (" / deeper" if deeper else " / shallower")}
    rate, switched = None, False
    previous = _point(receiver, frame - 1)
    if frame > 0 and previous is not None:
        dt = play["times"][frame] - play["times"][frame - 1]
        ranked_before = _ordered_distances(play, previous, frame - 1, opts)
        if ranked_before and 0 < dt <= opts["maxGap"] + EPS:
            rate = (distance - ranked_before[0][0]) / dt
            switched = ranked_before[0][1] != defender_id
    return {"valid": True, "reason": "", "distance": distance, "nearestId": defender_id,
            "secondDistance": ranked[1][0] if len(ranked) > 1 else None,
            "secondId": ranked[1][1] if len(ranked) > 1 else None,
            "within3": sum(x[0] <= 3 for x in ranked), "within5": sum(x[0] <= 5 for x in ranked),
            "closingRate": -rate if rate is not None else None, "separationRate": rate,
            "leverage": leverage, "nearestSwitch": switched}


def _lift_inputs(play, receiver_id, frame, opts):
    times = play.get("times", [])
    if frame < 0 or frame >= len(times) or frame > _end_frame(play, opts):
        return None, "Frame outside observed analysis range"
    if times[frame] - times[0] < opts["lookback"] - EPS:
        return None, "Insufficient lookback history"
    before = frame_at(play, times[frame] - opts["lookback"])
    if before < 0 or before == frame:
        return None, "Insufficient lookback history"
    if any(not 0 < times[i + 1] - times[i] <= opts["maxGap"] + EPS for i in range(before, frame)):
        return None, "Gap in observed lookback history"
    receiver = _player(play, receiver_id)
    b0, b1 = _point(receiver, before), _point(receiver, frame)
    ds = defenders(play, opts["scope"])
    if b0 is None or b1 is None or not ds or any(_point(d, i) is None for d in ds for i in (before, frame)):
        return None, "Incomplete receiver or defender observations"
    return (before, b0, b1, ds, [_point(d, before) for d in ds], [_point(d, frame) for d in ds]), ""


def _decompose(b0, b1, d0, d1):
    s00, s01, s10, s11 = _space(b0, d0), _space(b0, d1), _space(b1, d0), _space(b1, d1)
    coverage = ((s01 - s00) + (s11 - s10)) / 2
    receiver = ((s10 - s00) + (s11 - s01)) / 2
    gain = s11 - s00
    return {"separationBefore": s00, "separationAfter": s11, "coverage": coverage,
            "receiver": receiver, "gain": gain, "rawCaptured": min(max(coverage, 0), max(gain, 0)),
            "hybrids": {"beforeReceiverAfterCoverage": s01, "afterReceiverBeforeCoverage": s10}}


def coverage_lift(play, receiver_id, frame, options=None):
    opts = _options(options)
    inputs, reason = _lift_inputs(play, receiver_id, frame, opts)
    base = {"frame": frame, "time": play.get("times", [])[frame] if 0 <= frame < len(play.get("times", [])) else None,
            "lookback": opts["lookback"], "scope": opts["scope"]}
    if inputs is None:
        return {**base, "valid": False, "eligible": False, "reason": reason, "coverage": None,
                "receiver": None, "gain": None, "captured": None, "rawCaptured": None,
                "rate": None, "previousFrame": None, "elapsed": None,
                "separationBefore": None, "separationAfter": None,
                "nearestBefore": None, "nearestAfter": None, "nearestSwitch": False}
    before, b0, b1, ds, d0, d1 = inputs
    result = _decompose(b0, b1, d0, d1)
    eligible0, why0 = _eligible(play, b0, opts)
    eligible1, why1 = _eligible(play, b1, opts)
    eligible = eligible0 and eligible1
    elapsed = play["times"][frame] - play["times"][before]
    nearest0 = min((_dist(b0, point), str(d["id"])) for d, point in zip(ds, d0))[1]
    nearest1 = min((_dist(b1, point), str(d["id"])) for d, point in zip(ds, d1))[1]
    end = play["times"][-1]
    return {**base, **result, "valid": True, "eligible": eligible, "reason": why0 or why1,
            "captured": result["rawCaptured"] if eligible else 0.0,
            "rate": result["coverage"] / elapsed, "previousFrame": before, "elapsed": elapsed,
            "nearestBefore": nearest0, "nearestAfter": nearest1, "nearestSwitch": nearest0 != nearest1,
            "endpointTime": end, "releaseLead": end - play["times"][frame] if play.get("endpointLabel") == "Pass release" else None}


def series(play, receiver_id, options=None):
    opts = _options(options)
    receiver = _player(play, receiver_id)
    output = []
    for frame in range(_end_frame(play, opts) + 1):
        near = nearest(play, receiver_id, frame, opts)
        lift = coverage_lift(play, receiver_id, frame, opts)
        eligible, reason = _eligible(play, _point(receiver, frame), opts)
        output.append({**near, **lift, "observationValid": near["valid"],
                       "windowEligible": near["valid"] and eligible,
                       "eligibilityReason": reason, "distance": near["distance"],
                       "nearestId": near["nearestId"]})
    return output


def windows(play, receiver_id, options=None):
    opts = _options(options)
    end_frame = _end_frame(play, opts)
    times = play.get("times", [])[:end_frame + 1]
    receiver = _player(play, receiver_id)
    rows = []
    for i in range(len(times)):
        near = nearest(play, receiver_id, i, opts)
        eligible, reason = _eligible(play, _point(receiver, i), opts)
        rows.append({"distance": near["distance"], "eligible": eligible and near["valid"], "reason": reason})
    intervals, active, eligible_seconds = [], None, 0.0
    for i in range(max(0, len(times) - 1)):
        dt = times[i + 1] - times[i]
        valid_interval = 0 < dt <= opts["maxGap"] + EPS and rows[i]["eligible"] and rows[i + 1]["distance"] is not None
        if valid_interval:
            eligible_seconds += dt
        is_open = valid_interval and rows[i]["distance"] >= opts["threshold"]
        if is_open and active is None:
            previous_eligible = i > 0 and rows[i - 1]["eligible"] and 0 < times[i] - times[i - 1] <= opts["maxGap"] + EPS
            active = {"start": times[i], "startFrame": i,
                      "leftCensored": not previous_eligible or rows[i - 1]["distance"] >= opts["threshold"]}
        if active is not None and not is_open:
            natural = rows[i]["eligible"] and rows[i]["distance"] is not None and rows[i]["distance"] < opts["threshold"]
            intervals.append({**active, "end": times[i], "endFrame": i, "duration": times[i] - active["start"],
                              "rightCensored": not natural,
                              "endReason": "threshold crossed" if natural else "eligibility or observation ended"})
            active = None
    if active is not None:
        natural = bool(rows and rows[-1]["eligible"] and rows[-1]["distance"] is not None and rows[-1]["distance"] < opts["threshold"])
        intervals.append({**active, "end": times[-1], "endFrame": len(times) - 1,
                          "duration": times[-1] - active["start"], "rightCensored": not natural,
                          "endReason": "threshold crossed" if natural else ("analysis cutoff" if end_frame < len(play.get("times", [])) - 1 else "tracking ended")})
    raw_intervals = intervals
    raw_total = sum(w["duration"] for w in raw_intervals)
    intervals = []
    for window in raw_intervals:
        if window["duration"] + EPS < opts["minDuration"]:
            continue
        confirm = next((i for i in range(window["startFrame"], window["endFrame"] + 1)
                        if times[i] >= window["start"] + opts["minDuration"] - EPS), None)
        if confirm is not None and all(rows[i]["eligible"] and rows[i]["distance"] >= opts["threshold"]
                                       for i in range(window["startFrame"], confirm + 1)):
            intervals.append(window)
    total = sum(w["duration"] for w in intervals)
    first = next((w["start"] for w in intervals if not w["leftCensored"]), None)
    release = play.get("endpointLabel") == "Pass release"
    endpoint = play.get("times", [0])[-1] if play.get("times") else 0
    return {"intervals": intervals, "total": total, "longest": max((w["duration"] for w in intervals), default=0.0),
            "rawIntervals": raw_intervals, "rawTotal": raw_total,
            "rawLongest": max((w["duration"] for w in raw_intervals), default=0.0),
            "rawPercentEligible": 100 * raw_total / eligible_seconds if eligible_seconds > 0 else None,
            "minDuration": opts["minDuration"],
            "percentEligible": 100 * total / eligible_seconds if eligible_seconds > 0 else None,
            "timeToFirst": first, "releaseLead": endpoint - first if release and first is not None else None,
            "lastWindowToRelease": endpoint - intervals[-1]["end"] if release and intervals else None,
            "eligibleSeconds": eligible_seconds, "observedUntil": times[-1] if times else None,
            "threshold": opts["threshold"], "scope": opts["scope"]}


def events(play, receiver_id, options=None):
    opts = _options(options)
    output = []
    for window in windows(play, receiver_id, opts)["intervals"]:
        if window["leftCensored"] or window["duration"] + EPS < opts["minDuration"]:
            continue
        frame = window["startFrame"]
        lift = coverage_lift(play, receiver_id, frame, opts)
        if not lift["valid"] or not lift["eligible"] or lift["separationBefore"] >= opts["threshold"] or lift["gain"] <= 0:
            continue
        # A duration ending in a below-threshold observation does not prove that
        # the threshold remained met at that endpoint: check every hold sample.
        confirm = next((i for i in range(frame, window["endFrame"] + 1)
                        if play["times"][i] >= window["start"] + opts["minDuration"] - EPS), None)
        if confirm is None or any((lambda n: not n["valid"] or n["distance"] < opts["threshold"])(nearest(play, receiver_id, i, opts))
                                  or not _eligible(play, _point(_player(play, receiver_id), i), opts)[0]
                                  for i in range(frame, confirm + 1)):
            continue
        peak = max(nearest(play, receiver_id, i, opts)["distance"] for i in range(frame, window["endFrame"] + 1))
        output.append({**lift, "onsetFrame": frame, "onset": window["start"],
                       "confirmedAt": play["times"][confirm], "end": window["end"], "duration": window["duration"],
                       "leftCensored": False, "rightCensored": window["rightCensored"], "peakSeparation": peak,
                       "receiverId": str(receiver_id), "playId": play.get("id")})
    return output


def default_receiver(play, options=None):
    opts = _options(options)
    rows = []
    for player in play.get("players", []):
        if player.get("side") == "offense" and player.get("role") == "route":
            found = events(play, player["id"], opts)
            win = windows(play, player["id"], opts)
            rows.append((max((e["captured"] for e in found), default=0), win["longest"], str(player["id"])))
    return sorted(rows, key=lambda row: (-row[0], -row[1], row[2]))[0][2] if rows else None


def context(play, receiver_id, frame, options=None):
    opts = _options(options)
    receiver = _player(play, receiver_id)
    point = _point(receiver, frame)
    near, lift = nearest(play, receiver_id, frame, opts), coverage_lift(play, receiver_id, frame, opts)
    eligible, reason = _eligible(play, point, opts)
    row = receiver["track"][frame] if point is not None else []
    return {**near, **lift, "nearest": near, "lift": lift, "x": point[0] if point else None,
            "y": point[1] if point else None, "speed": row[2] if len(row) > 2 else None,
            "direction": row[3] if len(row) > 3 else None, "orientation": row[4] if len(row) > 4 else None,
            "acceleration": row[5] if len(row) > 5 else None,
            "downfield": point[0] - play.get("los", 0) if point else None,
            "windowEligible": eligible and near["valid"], "eligibilityReason": reason,
            "roleScope": opts["scope"], "quality": play.get("quality", {}),
            "cohortEligible": play.get("cohortEligible", True), "nullified": play.get("penalty", {}).get("nullified", False),
            "instantNearestSwitch": near["nearestSwitch"],
            "observedTime": play["times"][frame] if point is not None and frame < len(play.get("times", [])) else None}


def inspect_point(play, point, frame, options=None):
    opts = _options(options)
    q = [point.get("x"), point.get("y")] if isinstance(point, dict) else list(point)
    invalid = {"valid": False, "reason": "Invalid point or frame", "distance": None, "change": None,
               "previousDistance": None, "changeValid": False, "nearestId": None, "secondDistance": None,
               "within3": 0, "within5": 0}
    if len(q) != 2 or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in q) or not 0 <= frame <= _end_frame(play, opts):
        return invalid
    now = _ordered_distances(play, q, frame, opts)
    if not now:
        return {**invalid, "reason": "Incomplete or absent defender observations"}
    t = play["times"][frame]
    before = frame_at(play, t - opts["lookback"])
    has_history = t - play["times"][0] >= opts["lookback"] - EPS and before < frame
    has_history = has_history and all(0 < play["times"][i + 1] - play["times"][i] <= opts["maxGap"] + EPS for i in range(before, frame))
    old = _ordered_distances(play, q, before, opts) if has_history else []
    return {"valid": True, "reason": "" if old else "Insufficient complete lookback history",
            "x": q[0], "y": q[1], "time": t, "frame": frame, "distance": now[0][0],
            "nearestId": now[0][1], "secondDistance": now[1][0] if len(now) > 1 else None,
            "within3": sum(x[0] <= 3 for x in now), "within5": sum(x[0] <= 5 for x in now),
            "previousDistance": old[0][0] if old else None, "change": now[0][0] - old[0][0] if old else None,
            "changeValid": bool(old), "elapsed": t - play["times"][before] if old else None}


def region_series(play, bounds, options=None):
    opts = _options(options)
    try:
        x0, x1 = max(0, float(bounds["xMin"])), min(opts["fieldLength"], float(bounds["xMax"]))
        y0, y1 = max(0, float(bounds["yMin"])), min(opts["fieldWidth"], float(bounds["yMax"]))
        step = float(opts.get("gridStep", 2.0))
    except (KeyError, ValueError, TypeError):
        return {"valid": False, "reason": "Invalid region bounds", "series": []}
    if not all(math.isfinite(x) for x in (x0, x1, y0, y1, step)) or x1 <= x0 or y1 <= y0 or step <= 0:
        return {"valid": False, "reason": "Region must have positive finite area", "series": []}
    nx, ny = math.ceil((x1 - x0) / step), math.ceil((y1 - y0) / step)
    if nx * ny > 1600:
        return {"valid": False, "reason": "Region exceeds 1600 grid cells; increase gridStep", "series": []}
    points = [[x0 + (i + .5) * (x1 - x0) / nx, y0 + (j + .5) * (y1 - y0) / ny] for j in range(ny) for i in range(nx)]
    area = (x1 - x0) * (y1 - y0)
    routes = [p for p in play.get("players", []) if p.get("side") == "offense" and p.get("role") == "route"]
    output, prior_inside = [], set()
    for frame in range(_end_frame(play, opts) + 1):
        values = [inspect_point(play, q, frame, opts) for q in points]
        good = [v for v in values if v["valid"]]
        changes = [v["change"] for v in good if v["changeValid"]]
        inside, arrivals = set(), []
        for r in routes:
            q = _point(r, frame)
            if q is None or not (x0 <= q[0] <= x1 and y0 <= q[1] <= y1):
                continue
            inside.add(str(r["id"]))
            if not _eligible(play, q, opts)[0]:
                continue
            n = nearest(play, r["id"], frame, opts)
            previous_point = _point(r, frame - 1)
            observed_entry = (frame > 0 and previous_point is not None
                              and 0 < play["times"][frame] - play["times"][frame - 1] <= opts["maxGap"] + EPS)
            entered = observed_entry and str(r["id"]) not in prior_inside
            scope_entered = observed_entry and not entered and not _eligible(play, previous_point, opts)[0]
            inspection = inspect_point(play, q, frame, opts)
            opening_onset = None
            if entered and n["valid"] and n["distance"] >= opts["threshold"]:
                previous_value = None
                for j in range(frame + 1):
                    v = inspect_point(play, q, j, opts)
                    current = v["distance"] if v["valid"] else None
                    if current is not None and current >= opts["threshold"] and previous_value is not None and previous_value < opts["threshold"]:
                        opening_onset = play["times"][j]
                    if current is None or current < opts["threshold"]:
                        opening_onset = None
                    previous_value = current
            arrivals.append({"id": str(r["id"]), "name": r.get("name", str(r["id"])), "entered": entered,
                             "scopeEntered": scope_entered, "leftCensored": not observed_entry or scope_entered,
                             "open": n["valid"] and n["distance"] >= opts["threshold"],
                             "separation": n["distance"], "spaceChange": inspection["change"],
                             "openingOnsetAtArrivalLocation": opening_onset,
                             "openingToArrival": play["times"][frame] - opening_onset if opening_onset is not None else None})
        prior_inside = inside
        fraction = sum(v["distance"] >= opts["threshold"] for v in good) / len(good) if good else None
        output.append({"frame": frame, "time": play["times"][frame],
                       "meanSpace": sum(v["distance"] for v in good) / len(good) if good else None,
                       "openArea": fraction * area if fraction is not None else None, "openFraction": fraction,
                       "meanChange": sum(changes) / len(changes) if changes else None, "arrivals": arrivals})
    return {"valid": True, "reason": "", "area": area, "points": len(points), "gridStep": step,
            "bounds": {"xMin": x0, "xMax": x1, "yMin": y0, "yMax": y1}, "series": output,
            "note": "Grid estimate of observed coverage spacing; arrivals do not establish route causation."}


def sensitivity(play, receiver_id, frame, options=None):
    opts = _options(options)
    baseline = coverage_lift(play, receiver_id, frame, opts)
    thresholds = []
    for threshold in sorted({max(0, opts["threshold"] - .5), opts["threshold"], opts["threshold"] + .5}):
        choice = {**opts, "threshold": threshold}
        win = windows(play, receiver_id, choice)
        thresholds.append({"threshold": threshold, "eventCount": len(events(play, receiver_id, choice)),
                           "total": win["total"], "longest": win["longest"]})
    lookbacks = [coverage_lift(play, receiver_id, frame, {**opts, "lookback": h})
                 for h in sorted({max(.1, opts["lookback"] - .2), opts["lookback"], opts["lookback"] + .2})]
    amplitude = opts.get("jitter", .1)
    samples = min(256, max(4, int(opts.get("jitterSamples", 32))))
    if not isinstance(amplitude, (int, float)) or not math.isfinite(amplitude) or amplitude < 0:
        raise ValueError("jitter must be finite and nonnegative")
    inputs, _ = _lift_inputs(play, receiver_id, frame, opts)
    values = []
    seed = int(opts.get("seed", 12345678)) & 0xffffffff
    def uniform():
        nonlocal seed
        seed = (1664525 * seed + 1013904223) & 0xffffffff
        return (seed / 4294967296 * 2 - 1) * amplitude
    if inputs:
        _, b0, b1, _, d0, d1 = inputs
        for _ in range(samples):
            perturbed = [[p[0] + uniform(), p[1] + uniform()] for p in [b0, b1, *d0, *d1]]
            n = len(d0)
            values.append(_decompose(perturbed[0], perturbed[1], perturbed[2:2 + n], perturbed[2 + n:])["coverage"])
    values.sort()
    sign = lambda x: 1 if x > EPS else -1 if x < -EPS else 0
    return {"baseline": baseline, "thresholds": thresholds, "lookbacks": lookbacks,
            "jitter": {"amplitude": amplitude, "samples": len(values), "min": min(values) if values else None,
                       "max": max(values) if values else None, "median": median(values) if values else None,
                       "p05": values[int((len(values) - 1) * .05)] if values else None,
                       "p95": values[int((len(values) - 1) * .95)] if values else None,
                       "signStable": all(sign(v) == sign(baseline["coverage"]) for v in values) if values else None,
                       "note": "Illustrative independent coordinate jitter, not a confidence interval or a calibrated tracking-error model."}}


def defender_contributions(play, receiver_id, frame, options=None):
    opts = _options(options)
    lift = coverage_lift(play, receiver_id, frame, opts)
    inputs, reason = _lift_inputs(play, receiver_id, frame, opts)
    if inputs is None:
        return {"valid": False, "reason": reason, "contributions": [], "coverage": None, "total": None, "residual": None, "coalitions": 0}
    _, b0, b1, ds, d0, d1 = inputs
    n = len(ds)
    if n > 11:
        return {"valid": False, "reason": "Exact decomposition is bounded to 11 defenders", "contributions": [],
                "coverage": lift["coverage"], "total": None, "residual": None, "coalitions": 0}
    # f(S) is mean separation at the two fixed receiver endpoints when precisely
    # the defenders in S have moved. Its full-minus-empty value equals V.
    distances = [[[_dist(b, d0[j]), _dist(b, d1[j])] for j in range(n)] for b in (b0, b1)]
    values = []
    for mask in range(1 << n):
        values.append(sum(min(distances[b][j][(mask >> j) & 1] for j in range(n)) for b in range(2)) / 2)
    contributions = []
    for j, d in enumerate(ds):
        value = 0.0
        for mask in range(1 << n):
            if mask & (1 << j):
                continue
            weight = 1 / (n * math.comb(n - 1, mask.bit_count()))
            value += weight * (values[mask | (1 << j)] - values[mask])
        contributions.append({"id": str(d["id"]), "name": d.get("name", str(d["id"])), "value": value,
                              "movement": _dist(d0[j], d1[j]), "distanceBefore": _dist(b0, d0[j]),
                              "distanceAfter": _dist(b1, d1[j])})
    contributions.sort(key=lambda d: (-d["value"], d["id"]))
    total = sum(c["value"] for c in contributions)
    return {"valid": True, "reason": "", "coverage": lift["coverage"], "total": total,
            "residual": lift["coverage"] - total, "coalitions": 1 << n, "contributions": contributions,
            "note": "Exact Shapley allocation of geometric defender motion, not responsibility or causal credit."}


def assist_candidates(play, receiver_id, frame, options=None):
    opts = _options(options)
    lift = coverage_lift(play, receiver_id, frame, opts)
    decomposition = defender_contributions(play, receiver_id, frame, opts)
    note = "Co-motion associations only. Unassigned value preserves ambiguous or absent evidence; no causal route credit is inferred."
    if not lift["valid"] or not decomposition["valid"]:
        return {"valid": False, "reason": lift.get("reason") or decomposition.get("reason"), "candidates": [],
                "unassigned": None, "allocationBudget": None, "coveragePositive": None, "note": note}
    budget = lift["captured"]
    positive = [d for d in decomposition["contributions"] if d["value"] > EPS]
    positive_sum = sum(d["value"] for d in positive)
    if budget <= EPS or positive_sum <= EPS:
        return {"valid": True, "reason": "No eligible positive captured coverage lift", "candidates": [],
                "unassigned": 0.0, "allocationBudget": 0.0, "coveragePositive": max(lift["coverage"], 0), "note": note}
    before = lift["previousFrame"]
    routes = [r for r in play.get("players", []) if r.get("side") == "offense" and r.get("role") == "route" and str(r["id"]) != str(receiver_id)]
    candidates = {}
    for contribution in positive:
        d = _player(play, contribution["id"])
        d0, d1 = _point(d, before), _point(d, frame)
        dv = [d1[0] - d0[0], d1[1] - d0[1]]
        dm = math.hypot(*dv)
        ranked = []
        for r in routes:
            a0, a1 = _point(r, before), _point(r, frame)
            if a0 is None or a1 is None:
                continue
            av = [a1[0] - a0[0], a1[1] - a0[1]]
            am = math.hypot(*av)
            if min(dm, am) / lift["elapsed"] < .5:
                continue
            alignment = (dv[0] * av[0] + dv[1] * av[1]) / (dm * am)
            alignment = min(1.0, max(-1.0, alignment))
            distances = [_dist(_point(d, i), _point(r, i)) for i in range(before, frame + 1)
                         if _point(d, i) is not None and _point(r, i) is not None]
            if len(distances) != frame - before + 1:
                continue
            mean_distance = sum(distances) / len(distances)
            fraction = sum(x <= 6 for x in distances) / len(distances)
            score = max(0, (alignment - .5) / .5) * max(0, 1 - mean_distance / 6) * fraction
            if fraction >= .6 and score > .2:
                ranked.append((score, str(r["id"]), r, alignment, mean_distance))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        if not ranked:
            continue
        score, rid, r, alignment, mean_distance = ranked[0]
        # Only a distinct best association gets a fraction of the geometric
        # budget. Equal candidate fits produce zero allocation, not false credit.
        second_score = ranked[1][0] if len(ranked) > 1 else 0
        margin = max(0, min(1, score - second_score))
        allocated = budget * contribution["value"] / positive_sum * margin
        candidate = candidates.setdefault(rid, {"id": rid, "name": r.get("name", rid), "associatedValue": 0.0,
                                                "score": 0.0, "defenderIds": [], "evidence": []})
        candidate["associatedValue"] += allocated
        candidate["score"] = max(candidate["score"], score)
        candidate["defenderIds"].append(contribution["id"])
        candidate["evidence"].append({"defenderId": contribution["id"], "alignment": alignment,
                                       "meanDistance": mean_distance, "coMotionScore": score,
                                       "distinctnessMargin": margin, "associatedValue": allocated})
    result = sorted(candidates.values(), key=lambda c: (-c["associatedValue"], c["id"]))
    return {"valid": True, "reason": "", "candidates": result, "allocationBudget": budget,
            "unassigned": max(0, budget - sum(c["associatedValue"] for c in result)),
            "coveragePositive": max(lift["coverage"], 0), "note": note}


def compare_matches(play, plays, options=None):
    opts = options or {}
    weights = {"offense": 1, "coverage": 3, "coverageType": 1, "formation": 2, "down": 2,
               "yardsToGoBand": 2, "dropBackType": 1, "personnelO": 1}
    def value(p, key):
        if key == "yardsToGoBand":
            n = p.get("yardsToGo")
            return None if n is None else "short" if n <= 3 else "medium" if n <= 7 else "long"
        if key == "dropBackType":
            return p.get(key, p.get("context", {}).get("dropbackType", p.get("context", {}).get(key)))
        return p.get(key, p.get("context", {}).get(key))
    result = []
    for candidate in plays:
        if candidate.get("id") == play.get("id") and not opts.get("includeSame"):
            continue
        matched, mismatches, score, maximum = [], [], 0, 0
        for key, weight in weights.items():
            a, b = value(play, key), value(candidate, key)
            if a in (None, "", "NA") or b in (None, "", "NA"):
                continue
            maximum += weight
            if a == b:
                score += weight
                matched.append(key)
            else:
                mismatches.append({"field": key, "selected": a, "candidate": b})
        result.append({"playId": candidate.get("id"), "score": score / maximum if maximum else 0,
                       "reasons": matched, "mismatches": mismatches, "comparedWeight": maximum})
    return sorted(result, key=lambda r: (-r["score"], str(r["playId"])))[:int(opts.get("limit", 25))]
