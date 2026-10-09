#!/usr/bin/env python3
"""Independently compare an exported pack with its immutable source CSVs.

No downloads or pipeline transformation helpers are used. Source directories
may be repeated; flat CSV layouts and revision-scoped caches are accepted.
Example (the default report is beside the dataset):
  python tools/audit_source.py --data data/demo.json --source-dir ../data-audit
  python tools/audit_source.py --data data/packs/week-1-additional/demo.json \
      --source-dir cache

This checks identity/numerical reproducibility, not sensor accuracy or football
interpretation. A passing report is bound to exact data, manifest and code hashes.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from schema import validate_dataset

MISSING = {None, "", "NA", "None", "null", "nan"}
ROLE = {"pass route": "route", "coverage": "coverage", "pass rush": "rush",
        "pass block": "block", "pass": "pass"}
FIELDS = ("x", "y", "speed", "direction", "orientation", "acceleration", "displacement")
PRIMARY_KEYS = {"games.csv": ("gameId",), "players.csv": ("nflId",),
                "plays.csv": ("gameId", "playId"),
                "pffScoutingData.csv": ("gameId", "playId", "nflId")}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


class Checks:
    """Named counts record actual comparisons, not merely declared coverage."""
    def __init__(self):
        self.counts = Counter()
        self.max_error = defaultdict(float)

    def same(self, actual, expected, label, category="metadataValues"):
        require(actual == expected, f"{label}: expected {expected!r}, got {actual!r}")
        self.counts[category] += 1

    def number(self, actual, expected, label, category, tolerance=1e-9):
        if expected is None:
            self.same(actual, None, label, category)
            return
        require(type(actual) in (int, float) and math.isfinite(actual), f"{label}: missing/nonfinite number")
        error = abs(actual - expected)
        require(error <= tolerance, f"{label}: source difference {error:.12g} exceeds {tolerance:g}; expected {expected!r}, got {actual!r}")
        self.max_error[category] = max(self.max_error[category], error)
        self.counts[category] += 1


def read_csv(path):
    """Audit CSV structure and uniqueness independently of ingestion code."""
    path = Path(path)
    keys = PRIMARY_KEYS.get(path.name, ("gameId", "playId", "nflId", "frameId"))
    seen = set()
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        headers = reader.fieldnames or []
        require(bool(headers) and len(set(headers)) == len(headers), f"{path.name}: duplicate/empty headers")
        require(set(keys) <= set(headers), f"{path.name}: missing primary-key headers")
        for line, row in enumerate(reader, 2):
            require(None not in row and all(v is not None for v in row.values()), f"{path.name}:{line}: malformed row")
            key = tuple(row[k] for k in keys)
            require(all(v.strip() for v in key) and key not in seen, f"{path.name}:{line}: duplicate/blank key {key}")
            seen.add(key)
            yield row


def locate_source(relative, directories, revision):
    relative = Path(relative)
    require(not relative.is_absolute() and ".." not in relative.parts, "manifest path escapes source directory")
    for base in directories:
        base = Path(base)
        for candidate in (base / relative, base / relative.name, base / revision / relative):
            if candidate.is_file():
                return candidate
    raise FileNotFoundError(f"Raw source {relative.as_posix()} missing; supply --source-dir containing the CSV or revision cache")


def verify_sources(provenance, manifest, directories, expected_paths, checks):
    """Compare observed bytes to existing expected hashes, never rewrite them."""
    revision = manifest["sourceRevision"]
    records = provenance["files"]
    checks.same(sorted(r["path"] for r in records), sorted(expected_paths), "provenance source-file set", "sourceSetChecks")
    checks.same(provenance["sourceRevision"], revision, "provenance revision", "sourceSetChecks")
    checks.same(provenance["sourceVerification"], "verified_manifest", "source verification", "sourceSetChecks")
    paths, report = {}, []
    base = manifest["sourceUrl"].replace("https://github.com/", "https://raw.githubusercontent.com/") + f"/{revision}/data/"
    for record in records:
        relative = record["path"]
        require(relative in manifest["files"], f"{relative}: no immutable expected source hash")
        expected = manifest["files"][relative]
        path = locate_source(relative, directories, revision)
        content = path.read_bytes()
        observed = hashlib.sha256(content).hexdigest()
        checks.same(observed, expected["sha256"], relative + " manifest SHA-256", "sourceHashes")
        checks.same(observed, record["sha256"], relative + " provenance SHA-256", "sourceHashes")
        checks.same(len(content), expected["bytes"], relative + " manifest bytes", "sourceByteCounts")
        checks.same(len(content), record["bytes"], relative + " provenance bytes", "sourceByteCounts")
        checks.same(record["sourceUrl"], base + relative, relative + " pinned URL", "sourceUrls")
        checks.same(record["verification"], "verified", relative + " verification", "sourceSetChecks")
        blob = hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()
        if "gitBlobSha1" in expected:
            checks.same(blob, expected["gitBlobSha1"], relative + " pinned Git blob", "gitBlobHashes")
        paths[relative] = path
        report.append({"path": relative, "sha256": observed, "bytes": len(content),
                       "gitBlobSha1": blob, "pinnedBlobChecked": "gitBlobSha1" in expected,
                       "manifestMatch": True, "provenanceMatch": True})
    return paths, report


def optional(value):
    return None if value in MISSING else float(value)


def boolean(value):
    if value in MISSING:
        return None
    require(str(value).lower() in {"0", "1", "false", "true"}, f"unknown source boolean {value!r}")
    return str(value).lower() in {"1", "true"}


def reference_point(row):
    """Use decimal arithmetic for an independent, exact source transform."""
    is_ball = row["team"] == "football"
    left = row["playDirection"] == "left"
    require(row["playDirection"] in {"left", "right"}, "invalid source direction")
    x, y = Decimal(row["x"]), Decimal(row["y"])
    if left:
        x, y = Decimal("120") - x, Decimal("53.3") - y
    def angle(key):
        if is_ball:
            return 0.0  # Deliberate placeholder; football has no measured heading.
        value = Decimal(row[key]) + (Decimal(180) if left else Decimal(0))
        return float((value % 360 + 360) % 360)
    speed = optional(row["s"])
    require(speed is not None or is_ball, "missing player speed")
    return [float(x), float(y), 0.0 if speed is None else speed, angle("dir"), angle("o"),
            optional(row.get("a")), optional(row.get("dis"))]


def identity(row):
    return "ball" if row["team"] == "football" else row["nflId"]


def frame_event(rows):
    candidates = [r["event"] for r in rows if r["team"] == "football" and r["event"] not in MISSING]
    candidates += [r["event"] for r in rows if r["team"] != "football" and r["event"] not in MISSING]
    return candidates[0] if candidates else ""


def audit_exclusion(pid, reason, source, frames):
    """Require raw evidence for every currently emitted exclusion category."""
    events = {r["event"] for rows in frames.values() for r in rows}
    if reason == "missing pass_forward on passing play":
        require(source["passResult"] not in {"S", "R"} and "pass_forward" not in events,
                pid + ": missing-release exclusion is not supported by source")
    elif reason == "missing ball_snap":
        require("ball_snap" not in events, pid + ": missing-snap exclusion is not supported by source")
    else:
        raise ValueError(f"{pid}: unaudited exclusion reason: {reason}")


def audit_play(play, source, game, frames, details, scouting, checks):
    """Compare a single replay with independently indexed raw rows."""
    pid = play["id"]
    snap_candidates = [f for f, rows in frames.items() if any(r["event"] == "ball_snap" for r in rows)]
    require(len(snap_candidates) == 1, pid + ": source requires exactly one snap")
    snap = snap_candidates[0]
    releases = [f for f, rows in frames.items() if f >= snap and any(r["event"] == "pass_forward" for r in rows)]
    require(bool(releases) or source["passResult"] in {"S", "R"}, pid + ": source has no permitted endpoint")
    end = min(releases) if releases else max(frames)
    wanted_frames = list(range(snap, end + 1))
    checks.same(play["frameIds"], wanted_frames, pid + " replay cutoff", "frameWindowChecks")
    label = "Pass release" if releases else "Observed endpoint (sack)" if source["passResult"] == "S" else "Observed endpoint (scramble)"
    checks.same(play["endpointLabel"], label, pid + " endpoint label", "frameWindowChecks")
    for output, raw in {"offense":"possessionTeam", "defense":"defensiveTeam", "clock":"gameClock", "description":"playDescription", "formation":"offenseFormation", "coverage":"pff_passCoverage", "coverageType":"pff_passCoverageType", "result":"passResult"}.items():
        checks.same(play[output], source[raw], pid + " " + output)
    for output, raw in {"quarter":"quarter", "down":"down", "yardsToGo":"yardsToGo", "yards":"playResult", "gameId":"gameId", "playId":"playId"}.items():
        checks.same(play[output], int(source[raw]), pid + " " + output)
    checks.same(play["homeTeam"], game["homeTeamAbbr"], pid + " home team")
    checks.same(play["awayTeam"], game["visitorTeamAbbr"], pid + " away team")
    direction = frames[snap][0]["playDirection"]
    los = float(source["absoluteYardlineNumber"])
    if direction == "left":
        los = 120 - los
    checks.number(play["los"], los, pid + " los", "lineMarkerValues")
    checks.number(play["firstDown"], min(120, max(0, los + int(source["yardsToGo"]))), pid + " first down", "lineMarkerValues")
    context = {"season":int(game["season"]), "week":int(game["week"]), "gameDate":game["gameDate"],
               "personnelO":source.get("personnelO", ""), "personnelD":source.get("personnelD", ""),
               "defendersInBox":optional(source.get("defendersInBox")), "playAction":boolean(source.get("pff_playAction")),
               "dropbackType":source.get("dropBackType", ""), "homeScore":optional(source.get("preSnapHomeScore")),
               "awayScore":optional(source.get("preSnapVisitorScore"))}
    checks.same(play["context"], context, pid + " context", "contextObjects")
    fouls = [{"name":source[f"foulName{i}"], "playerId":None if source.get(f"foulNFLId{i}") in MISSING else source.get(f"foulNFLId{i}")}
             for i in range(1, 4) if source.get(f"foulName{i}") not in MISSING]
    penalty = {"hasPenalty":bool(fouls or "PENALTY" in source["playDescription"].upper()),
               "nullified":bool(re.search(r"\bNo Play\b", source["playDescription"], re.I)),
               "nullifiedSource":"playDescription", "yards":optional(source.get("penaltyYards")),
               "prePenaltyYards":optional(source.get("prePenaltyPlayResult")), "fouls":fouls}
    checks.same(play["penalty"], penalty, pid + " penalty", "penaltyObjects")
    by_id = {p["id"]:p for p in play["players"]}
    snap_rows = {identity(r):r for r in frames[snap]}
    checks.same(set(by_id), set(snap_rows), pid + " snap population", "populationChecks")
    indexed = {}
    for f in wanted_frames:
        rows = frames.get(f, [])
        checks.same(len(rows), 23, f"{pid} frame {f} population", "populationChecks")
        indexed[f] = {identity(r):r for r in rows}
        checks.same(set(indexed[f]), set(by_id), f"{pid} frame {f} identities", "populationChecks")
        for row in rows:
            checks.same(row["playDirection"], direction, pid + " direction", "directionChecks")
    pre_frames = []
    for f in range(snap - 1, min(frames) - 1, -1):
        rows = frames.get(f, [])
        valid = len(rows) == 23 and {identity(r) for r in rows} == set(by_id)
        valid = valid and all(r["playDirection"] == direction and r["team"] == snap_rows[identity(r)]["team"] for r in rows)
        try:
            valid = valid and all(all(v is None or math.isfinite(v) for v in reference_point(r)) for r in rows)
        except (ValueError, ArithmeticError):
            valid = False
        if not valid:
            break
        indexed[f] = {identity(r):r for r in rows}
        pre_frames.append(f)
    pre_frames.reverse()
    checks.same(play["preSnap"]["frameIds"], pre_frames, pid + " pre-snap coverage", "frameWindowChecks")
    omitted = sorted(f for f in frames if f < snap and f not in pre_frames)
    checks.same(play["quality"]["preSnapExcludedFrames"], omitted, pid + " omitted pre-snap", "frameWindowChecks")
    pre_entities = {p["id"]:p for p in play["preSnap"]["players"]}
    for section, ids, entities, counter in ((play, wanted_frames, by_id, "replayTrackValues"), (play["preSnap"], pre_frames, pre_entities, "preSnapTrackValues")):
        for i, frame in enumerate(ids):
            checks.number(section["times"][i], (frame-snap)/10, f"{pid} frame {frame} time", "timeValues")
            checks.same(section["events"][i], frame_event(frames[frame]), f"{pid} frame {frame} event", "eventValues")
            for eid, player in entities.items():
                expected = reference_point(indexed[frame][eid])
                checks.same(len(player["track"][i]), 7, f"{pid} {eid} frame {frame} track width", "trackWidthChecks")
                for k, value in enumerate(expected):
                    checks.number(player["track"][i][k], value, f"{pid} {eid} frame {frame} {FIELDS[k]}", counter)
        checks.counts["preSnapFrames" if counter == "preSnapTrackValues" else "replayFrames"] += len(ids)
        checks.counts["preSnapRows" if counter == "preSnapTrackValues" else "replayRows"] += len(ids) * len(entities)
    for eid, player in by_id.items():
        ball = eid == "ball"
        scout = scouting.get(eid, {})
        info = details.get(eid, {})
        expected_role = "ball" if ball else ROLE.get(scout.get("pff_role", "").lower(), "other")
        checks.same(player["role"], expected_role, pid + " " + eid + " role", "roleValues")
        checks.same(player["scoutingAvailable"], ball or eid in scouting, pid + " " + eid + " scouting", "roleValues")
        checks.same(player["name"], "Football" if ball else info.get("displayName", "Player " + eid), pid + " name")
        checks.same(player["team"], snap_rows[eid]["team"], pid + " team")
        checks.same(player["jersey"], "" if ball else snap_rows[eid]["jerseyNumber"], pid + " jersey")
        checks.same(player["position"], "" if ball else scout.get("pff_positionLinedUp", info.get("officialPosition", "")), pid + " position")
        checks.same(player["officialPosition"], "" if ball else info.get("officialPosition", ""), pid + " official position")
        protection = {"blockedPlayerId": None if scout.get("pff_nflIdBlockedPlayer") in MISSING else scout.get("pff_nflIdBlockedPlayer"),
                      "blockType":None if scout.get("pff_blockType") in MISSING else scout.get("pff_blockType")}
        protection.update({k:boolean(scout.get("pff_"+k)) for k in ("hit", "hurry", "sack", "beatenByDefender", "hitAllowed", "hurryAllowed", "sackAllowed", "backFieldBlock")})
        checks.same(player["protection"], protection, pid + " " + eid + " protection", "protectionObjects")
    # Metrics use independently transformed raw positions, not exported tracks.
    defenders = sorted(eid for eid in by_id if scouting.get(eid, {}).get("pff_role", "").lower() == "coverage")
    for metric in play["metrics"]["receivers"]:
        rid = metric["id"]
        distances = []
        for i, f in enumerate(wanted_frames):
            receiver = reference_point(indexed[f][rid])
            distance, nearest = min((math.dist(receiver[:2], reference_point(indexed[f][did])[:2]), did) for did in defenders)
            distances.append(distance)
            checks.number(metric["separation"][i], distance, f"{pid} {rid} frame {f} separation", "separationValues")
            checks.same(metric["nearestId"][i], nearest, f"{pid} {rid} frame {f} nearest", "nearestDefenderValues")
        flags = [d >= 3 for d in distances[:-1]]
        current = longest = 0
        for flag in flags:
            current = current+1 if flag else 0
            longest = max(longest, current)
        for name, expected in (("peakSeparation", max(distances)), ("separationAtEnd", distances[-1]), ("totalOpenSeconds", sum(flags)/10), ("longestOpenSeconds", longest/10)):
            checks.number(metric[name], expected, pid + " " + rid + " " + name, "metricSummaries")
    missing = sorted(eid for eid in by_id if eid != "ball" and eid not in scouting)
    unknown = sorted(eid for eid, p in by_id.items() if p["role"] == "other")
    checks.same(play["quality"]["scoutingMissingIds"], missing, pid + " missing scouting", "qualityObjects")
    checks.same(play["quality"]["unknownRoleIds"], unknown, pid + " unknown roles", "qualityObjects")
    checks.same(play["quality"]["roleCounts"], dict(Counter(p["role"] for p in by_id.values())), pid + " role counts", "qualityObjects")
    disagreements = []
    for f in wanted_frames:
        tags = Counter(r["event"] for r in frames[f] if r["event"] not in MISSING)
        empty = sum(r["event"] in MISSING for r in frames[f])
        if len(tags) > 1 or tags and empty:
            disagreements.append({"frameId":f, "events":dict(tags), "missingCount":empty})
    checks.same(play["quality"]["eventDisagreements"], disagreements, pid + " event agreement", "qualityObjects")
    outside_ids, outside_frames, trajectory = set(), set(), []
    route_intervals = open_intervals = 0
    metric_lookup = {m["id"]:m for m in play["metrics"]["receivers"]}
    for eid, player in by_id.items():
        points = [reference_point(indexed[f][eid]) for f in wanted_frames]
        statuses = ["in_bounds" if 0 <= p[0] <= 120 and 0 <= p[1] <= 53.3 else "outside_field" for p in points]
        checks.same(player["fieldStatus"], statuses, pid + " " + eid + " field status", "qualityObjects")
        if eid == "ball":
            continue
        for i, point in enumerate(points):
            if statuses[i] == "outside_field":
                outside_ids.add(eid); outside_frames.add(i)
                if player["role"] == "route" and i < len(points)-1:
                    route_intervals += 1
                    open_intervals += int(point[0] >= los and metric_lookup[eid]["separation"][i] >= 3)
            reasons = []
            if point[2] > 13:
                reasons.append("speed_above_13_yd_s")
            if i:
                step = math.dist(point[:2], points[i-1][:2])
                if step > 2:
                    reasons.append("position_jump_above_2_yd_frame")
                if abs(step - (point[2]+points[i-1][2])/20) > .75:
                    reasons.append("speed_displacement_difference_above_0_75_yd")
            trajectory.extend({"playerId":eid, "frameId":wanted_frames[i], "type":reason} for reason in reasons)
    checks.same(play["quality"]["fieldAmbiguity"], {"entityIds":sorted(outside_ids), "frameCount":len(outside_frames), "routeIntervalCount":route_intervals, "openRouteIntervalCount":open_intervals}, pid + " field ambiguity", "qualityObjects")
    checks.same(play["quality"]["trajectoryFlags"], trajectory, pid + " trajectory flags", "qualityObjects")
    expected_flags = [name for name, present in (("scouting_missing", missing), ("unknown_roles", unknown), ("field_boundary", outside_ids), ("event_disagreement", disagreements), ("trajectory_flag", trajectory), ("pre_snap_incomplete", omitted)) if present]
    checks.same(play["quality"]["flags"], expected_flags, pid + " diagnostic flags", "qualityObjects")
    eligible = not penalty["nullified"] and not any(flag != "pre_snap_incomplete" for flag in expected_flags)
    checks.same(play["cohortEligible"], eligible, pid + " cohort eligibility", "cohortChecks")
    checks.counts["plays"] += 1


def audit_dataset(data_path, source_dirs, manifest_path=None):
    data_path = Path(data_path)
    manifest_path = Path(manifest_path or ROOT / "data/source-manifest.json")
    data = json.loads(data_path.read_text(encoding="utf-8"))
    provenance_path = data_path.with_name("provenance.json")
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    checks = Checks()
    checks.same(provenance["datasetSha256"], digest(data_path), "dataset/provenance SHA-256", "artifactHashes")
    checks.same(provenance["buildId"], data["meta"]["buildId"], "build identity", "artifactIdentityChecks")
    checks.same(provenance["sourceManifestSha256"], digest(manifest_path), "manifest/provenance SHA-256", "artifactHashes")
    for key, relative in (("pipelineSha256", "data_pipeline.py"), ("schemaSha256", "schema.py"), ("storiesSha256", "data/stories.json")):
        checks.same(provenance[key], digest(ROOT / relative), relative + " build source hash", "artifactHashes")
    for key in ("sourceRevision", "sourceVerification", "sourceUrl"):
        checks.same(data["meta"][key], provenance[key], "meta/provenance " + key, "artifactIdentityChecks")
    selected = sorted(provenance["selectedGames"])
    expected_paths = list(PRIMARY_KEYS) + [f"tracking/tracking_{game}.csv" for game in selected]
    paths, file_reports = verify_sources(provenance, manifest, source_dirs, expected_paths, checks)
    validate_dataset(data)
    checks.counts["schemaValidations"] = 1
    games = {int(r["gameId"]):r for r in read_csv(paths["games.csv"])}
    details = {r["nflId"]:r for r in read_csv(paths["players.csv"])}
    source_plays = {f'{r["gameId"]}_{r["playId"]}':r for r in read_csv(paths["plays.csv"]) if int(r["gameId"]) in selected}
    scouts = defaultdict(dict)
    for row in read_csv(paths["pffScoutingData.csv"]):
        if int(row["gameId"]) in selected:
            scouts[f'{row["gameId"]}_{row["playId"]}'][row["nflId"]] = row
    exported = {p["id"]:p for p in data["plays"]}
    excluded = {p["id"]:p for p in provenance["excludedPlays"]}
    checks.same(set(exported) | set(excluded), set(source_plays), "every source play included or excluded", "sourceCoverageChecks")
    checks.same(set(exported) & set(excluded), set(), "included/excluded sets disjoint", "sourceCoverageChecks")
    checks.same(provenance["selectedPlayCount"], len(source_plays), "source play denominator", "sourceCoverageChecks")
    for game_id in selected:
        frames_by_play = defaultdict(lambda: defaultdict(list))
        for row in read_csv(paths[f"tracking/tracking_{game_id}.csv"]):
            require(int(row["gameId"]) == game_id, "tracking file contains unexpected game")
            frames_by_play[f'{row["gameId"]}_{row["playId"]}'][int(row["frameId"])].append(row)
        for pid, source in source_plays.items():
            if int(source["gameId"]) != game_id:
                continue
            frames = frames_by_play[pid]
            if pid in exported:
                audit_play(exported[pid], source, games[game_id], frames, details, scouts[pid], checks)
            else:
                # New exclusion types require an explicit independent check.
                audit_exclusion(pid, excluded[pid]["reason"], source, frames)
                checks.counts["excludedPlays"] += 1
    checks.same(data["meta"]["cohortCounts"], provenance["cohortCounts"], "cohort provenance", "cohortChecks")
    checks.same(data["meta"]["cohortCounts"]["included"], len(exported), "cohort included denominator", "cohortChecks")
    checks.same(data["meta"]["cohortCounts"]["excluded"], len(excluded), "cohort exclusion denominator", "cohortChecks")
    counts = data["meta"]["cohortCounts"]
    def check_cohort(values, exclusion_values, actual, label):
        expected = {"included":len(values), "eligible":sum(p["cohortEligible"] for p in values),
                    "nullified":sum(p["penalty"]["nullified"] for p in values), "penalized":sum(p["penalty"]["hasPenalty"] for p in values),
                    "fieldAmbiguous":sum("field_boundary" in p["quality"]["flags"] for p in values),
                    "scoutingIncomplete":sum(bool(p["quality"]["scoutingMissingIds"] or p["quality"]["unknownRoleIds"]) for p in values),
                    "excluded":len(exclusion_values)}
        expected["exclusionRate"] = len(exclusion_values)/(len(values)+len(exclusion_values)) if values or exclusion_values else 0
        for key, value in expected.items():
            checks.same(actual[key], value, label + " " + key, "cohortChecks")
    check_cohort(list(exported.values()), list(excluded.values()), counts, "overall cohort")
    for group, field in (("byGame", "gameId"), ("byOffense", "offense"), ("byCoverage", "coverage")):
        keys = {str(p[field]) for p in [*exported.values(), *excluded.values()]}
        checks.same(set(counts[group]), keys, group + " cohort groups", "cohortChecks")
        for key in keys:
            values = [p for p in exported.values() if str(p[field]) == key]
            exclusion_values = [p for p in excluded.values() if str(p[field]) == key]
            check_cohort(values, exclusion_values, counts[group][key], group + " " + key)
    checks.counts["games"] = len(selected)
    return {"schemaVersion":1, "status":"passed", "generatedAt":datetime.now(timezone.utc).isoformat(),
            "dataFile":data_path.name, "datasetSha256":digest(data_path), "buildId":data["meta"]["buildId"],
            "sourceRevision":manifest["sourceRevision"], "sourceManifestSha256":digest(manifest_path),
            "auditorSha256":digest(__file__), "counts":dict(sorted(checks.counts.items())),
            "maxAbsoluteErrors":dict(sorted(checks.max_error.items())), "files":file_reports,
            "method":{"trackTransform":"Independent Decimal arithmetic from source strings; tolerance 1e-9 yards/degrees/kinematic units.",
                      "window":"Exact source ball_snap to first explicit pass_forward, or observed endpoint for S/R; separate contiguous valid pre-snap suffix.",
                      "separation":"Independent Euclidean distance to PFF Coverage players from raw transformed coordinates; exact >=3 interval membership; no endpoint extrapolation.",
                      "sourceTrust":"Existing pinned manifest and build-provenance hashes, plus pinned Git blob identity where present. No expected hashes are rewritten.",
                      "limits":"Reproducibility audit; does not certify tracking sensor accuracy, coverage assignments, throwing decisions or causal attribution. Unknown future exclusion reasons fail closed."}}


def write_report(path, report):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(report, stream, indent=2, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=ROOT / "data/demo.json")
    parser.add_argument("--source-dir", type=Path, action="append", help="Raw CSV directory or revision cache; may be repeated")
    parser.add_argument("--output", type=Path, help="Defaults to source-audit.json beside the dataset")
    args = parser.parse_args(argv)
    try:
        report = audit_dataset(args.data, args.source_dir or [ROOT / "cache", ROOT.parent / "data-audit"])
        destination = args.output or args.data.with_name("source-audit.json")
        write_report(destination, report)
        c = report["counts"]
        print(f"PASS: {c['plays']} plays, {c['games']} games, {c['replayRows']} replay rows, {c['preSnapRows']} pre-snap rows; report {destination}")
        return 0
    except (ValueError, OSError, KeyError, ArithmeticError) as error:
        print(f"Source audit failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
