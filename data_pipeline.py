#!/usr/bin/env python3
"""Build a small, reproducible NFL tracking replay dataset using only stdlib.

Run ``python data_pipeline.py --data-dir ../data-audit --output data/demo.json``.
Without --data-dir, downloads four metadata tables and just two tracking games
into cache/. --games accepts space-separated or comma-separated game IDs.

Public helpers:
  normalize_point(x, y, direction, orientation, play_direction)
  separation_metrics(receiver_track, defender_tracks, threshold=3.0, fps=10)

Directions use the source convention (0 degrees points along positive y).
Separation is geometric distance to the nearest PFF Coverage player, not a
target or catch-probability label. Open time classifies each observed
interval by its starting sample; the endpoint contributes no extra interval.
Curated coaching stories are loaded from data/stories.json, and retained only
when both selected players and plays are present in the exported dataset.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from schema import validate_dataset


SOURCE_URL = "https://github.com/ThompsonJamesBliss/nfl-big-data-bowl-regional-event-data"
SOURCE_REVISION = "85da22eeff2f1d5be106faa9dfe06a1205f2defd"
RAW_BASE = (
    "https://raw.githubusercontent.com/ThompsonJamesBliss/"
    f"nfl-big-data-bowl-regional-event-data/{SOURCE_REVISION}/data/"
)
DEFAULT_GAMES = (2021090900, 2021110100)
FPS = 10
FIELD_LENGTH = 120.0
FIELD_WIDTH = 53.3
OPEN_THRESHOLD = 3.0
ROOT = Path(__file__).resolve().parent
PIPELINE_VERSION = "2.0.0"
METRIC_VERSION = "separation-euclidean-interval-v2"
ROLE_MAP = {
    "pass route": "route",
    "coverage": "coverage",
    "pass rush": "rush",
    "pass block": "block",
    "pass": "pass",
}
MISSING = {"", "NA", "None", "null", "nan"}
DATA_NOTE = (
    "Source CSVs are 2021 season data (weeks 1–8), regardless of the hackathon "
    "or repository date. Demo contains two games unless explicitly selected. "
    "Tracking is sampled at 10 Hz; frameId supplies timing because timestamps "
    "have whole-second precision. Replay begins at ball_snap and stops at "
    "pass_forward, or the observed endpoint for sacks/scrambles. Separation "
    "measures distance to PFF Coverage players, not all defenders or catch "
    "probability. Open time is an illustrative >=3-yard threshold."
)


def normalize_point(x, y, direction, orientation, play_direction):
    """Return (x, y, direction, orientation) with offense moving right.

    A left-moving play is rotated by 180 degrees, including both angles.
    Inputs and output angles are finite; angles are reduced to [0, 360).
    """
    values = tuple(float(v) for v in (x, y, direction, orientation))
    if not all(math.isfinite(v) for v in values):
        raise ValueError("coordinates and angles must be finite")
    if play_direction not in {"left", "right"}:
        raise ValueError(f"invalid play direction: {play_direction!r}")
    x, y, direction, orientation = values
    if play_direction == "left":
        return (
            FIELD_LENGTH - x,
            FIELD_WIDTH - y,
            (direction + 180.0) % 360.0,
            (orientation + 180.0) % 360.0,
        )
    return x, y, direction % 360.0, orientation % 360.0


def separation_metrics(receiver_track, defender_tracks, threshold=3.0, fps=10):
    """Nearest coverage-player distances and observed open-time intervals.

    Tracks are aligned lists of [x, y, ...]. defender_tracks maps IDs to tracks.
    Distance ties resolve by lexical player ID for deterministic output.
    Durations classify each interval using its starting-frame distance >= the
    threshold. There are exactly len(track)-1 observable intervals, including
    zero intervals for a single frame. Distances are in yards; durations seconds.
    """
    if not receiver_track:
        raise ValueError("receiver track cannot be empty")
    if not defender_tracks:
        raise ValueError("at least one coverage defender is required")
    if not math.isfinite(float(threshold)) or threshold < 0:
        raise ValueError("threshold must be finite and nonnegative")
    if not math.isfinite(float(fps)) or fps <= 0:
        raise ValueError("fps must be finite and positive")
    count = len(receiver_track)
    if any(len(track) != count for track in defender_tracks.values()):
        raise ValueError("tracks must have the same number of frames")
    distances = []
    nearest_ids = []
    for index, receiver in enumerate(receiver_track):
        choices = []
        for player_id, track in defender_tracks.items():
            defender = track[index]
            distance = math.hypot(
                float(receiver[0]) - float(defender[0]),
                float(receiver[1]) - float(defender[1]),
            )
            if not math.isfinite(distance):
                raise ValueError("track coordinates must be finite")
            choices.append((distance, str(player_id)))
        distance, nearest_id = min(choices)
        distances.append(distance)
        nearest_ids.append(nearest_id)
    total = longest = current = 0
    for distance in distances[:-1]:
        if distance >= threshold:
            total += 1
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return {
        "separation": distances,
        "nearestId": nearest_ids,
        "peakSeparation": max(distances),
        "separationAtEnd": distances[-1],
        "totalOpenSeconds": round(total / fps, 3),
        "longestOpenSeconds": round(longest / fps, 3),
    }


CSV_CONTRACTS = {
    "games.csv": ({"gameId", "season", "week", "gameDate", "homeTeamAbbr", "visitorTeamAbbr"}, ("gameId",)),
    "players.csv": ({"nflId", "displayName", "officialPosition"}, ("nflId",)),
    "plays.csv": ({"gameId", "playId", "playDescription", "possessionTeam", "defensiveTeam", "passResult", "absoluteYardlineNumber", "yardsToGo", "quarter", "gameClock", "down", "offenseFormation", "pff_passCoverage", "pff_passCoverageType", "playResult"}, ("gameId", "playId")),
    "pffScoutingData.csv": ({"gameId", "playId", "nflId", "pff_role", "pff_positionLinedUp"}, ("gameId", "playId", "nflId")),
    "tracking": ({"gameId", "playId", "nflId", "frameId", "team", "playDirection", "x", "y", "s", "dir", "o", "event", "jerseyNumber"}, ("gameId", "playId", "nflId", "frameId")),
}


def load_csv(path, required_headers=None, primary_key=None):
    """Read a source CSV, rejecting malformed rows and duplicate primary keys."""
    path = Path(path)
    contract = CSV_CONTRACTS.get("tracking" if path.name.startswith("tracking_") else path.name, (set(), ()))
    required_headers = set(contract[0] if required_headers is None else required_headers)
    primary_key = tuple(contract[1] if primary_key is None else primary_key)
    result, seen = [], set()
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        headers = reader.fieldnames or []
        if not headers or len(set(headers)) != len(headers):
            raise ValueError(f"{path.name}: empty or duplicate CSV headers")
        missing = required_headers.union(primary_key) - set(headers)
        if missing:
            raise ValueError(f"{path.name}: missing headers {', '.join(sorted(missing))}")
        for line, row in enumerate(reader, 2):
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f"{path.name}:{line}: row length differs from header")
            if primary_key:
                key = tuple(row[column] for column in primary_key)
                if any(not value.strip() for value in key):
                    raise ValueError(f"{path.name}:{line}: blank primary key")
                if key in seen:
                    raise ValueError(f"{path.name}:{line}: duplicate primary key {key}")
                seen.add(key)
            result.append(row)
    return result


def source_manifest():
    path = ROOT / "data/source-manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("sourceRevision") != SOURCE_REVISION:
        raise ValueError("source manifest revision does not match requested source")
    return manifest["files"]


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_source(path, relative_path):
    """Return manifest status; local overrides remain explicitly unverified."""
    expected = source_manifest().get(relative_path)
    if expected is None:
        return "unmanifested"
    return "verified" if file_digest(path) == expected["sha256"] else "hash_mismatch"


def source_file(relative_path, local_dir, cache_dir, refresh=False, progress=None, retries=3):
    """Use provided source files, or download one pinned source into cache."""
    if local_dir is not None:
        candidates = [local_dir / relative_path, local_dir / Path(relative_path).name]
        for path in candidates:
            if path.is_file():
                return path
        raise FileNotFoundError(f"Missing source file: {relative_path} in {local_dir}")
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("source path must stay inside the data cache")
    path = Path(cache_dir) / SOURCE_REVISION / relative
    if path.exists() and not refresh:
        if verify_source(path, relative_path) == "hash_mismatch":
            raise ValueError(f"cached {relative_path} failed SHA-256 validation; use --refresh")
        if progress:
            progress(f"Using cached {relative_path}")
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(max(1, min(int(retries), 5))):
        temporary = None
        try:
            if progress:
                progress(f"Downloading {relative_path} (attempt {attempt + 1})")
            request = urllib.request.Request(RAW_BASE + relative_path, headers={"User-Agent": "Open-Field/2.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
                    temporary = Path(stream.name)
                    size = 0
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > 256 * 1024 * 1024:
                            raise ValueError("source exceeds 256 MiB per-file limit")
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
            if verify_source(temporary, relative_path) == "hash_mismatch":
                raise ValueError(f"downloaded {relative_path} failed SHA-256 validation")
            temporary.replace(path)
            break
        except (OSError, ValueError) as error:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if attempt + 1 >= max(1, min(int(retries), 5)):
                raise OSError(f"could not retrieve {relative_path}: {error}") from error
            time.sleep(min(2.0, 0.25 * (2 ** attempt)))
    return path


def finite_number(value, label, default=None):
    if value in MISSING:
        if default is not None:
            return float(default)
        raise ValueError(f"missing {label}")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"non-finite {label}")
    return result


def entity_id(row):
    return "ball" if row["team"] == "football" else row["nflId"]


def event_for_frame(rows):
    """Prefer a meaningful football event, then any meaningful player event."""
    ordered = sorted(rows, key=lambda row: row["team"] != "football")
    events = [row["event"] for row in ordered if row["event"] not in MISSING]
    return events[0] if events else ""


def optional_number(value):
    return None if value is None or value in MISSING else finite_number(value, "optional source number")


def source_boolean(value):
    if value is None or value in MISSING:
        return None
    if str(value).lower() in {"1", "true"}:
        return True
    if str(value).lower() in {"0", "false"}:
        return False
    raise ValueError(f"unrecognized source boolean {value!r}")


def normalized_track_point(row, direction, is_ball=False):
    heading = finite_number(row["dir"], "direction", 0 if is_ball else None)
    orientation = finite_number(row["o"], "orientation", 0 if is_ball else None)
    x, y, heading, orientation = normalize_point(finite_number(row["x"], "x"), finite_number(row["y"], "y"), heading, orientation, direction)
    speed = finite_number(row["s"], "speed", 0 if is_ball else None)
    if speed < 0:
        raise ValueError("negative speed")
    if is_ball:
        heading = orientation = 0.0
    # Source coordinates are hundredths of a yard; remove only rotation's
    # binary floating-point residue. Distances retain full floating precision.
    return [round(x, 6), round(y, 6), speed, heading, orientation,
            optional_number(row.get("a")), optional_number(row.get("dis"))]


def in_field(point):
    return 0 <= point[0] <= FIELD_LENGTH and 0 <= point[1] <= FIELD_WIDTH


def play_context(play, game):
    return {
        "season": int(game.get("season", 2021)),
        "week": int(game["week"]) if game.get("week") else None,
        "gameDate": game.get("gameDate", ""),
        "personnelO": play.get("personnelO", ""),
        "personnelD": play.get("personnelD", ""),
        "defendersInBox": optional_number(play.get("defendersInBox")),
        "playAction": source_boolean(play.get("pff_playAction")),
        "dropbackType": play.get("dropBackType", ""),
        "homeScore": optional_number(play.get("preSnapHomeScore")),
        "awayScore": optional_number(play.get("preSnapVisitorScore")),
    }


def penalty_context(play):
    fouls = [{"name": play[f"foulName{i}"], "playerId": None if play.get(f"foulNFLId{i}") in MISSING else play.get(f"foulNFLId{i}")}
             for i in range(1, 4) if play.get(f"foulName{i}") and play[f"foulName{i}"] not in MISSING]
    description = play.get("playDescription", "")
    return {
        "hasPenalty": bool(fouls or "PENALTY" in description.upper()),
        "nullified": bool(re.search(r"\bNo Play\b", description, re.IGNORECASE)),
        "nullifiedSource": "playDescription",
        "yards": optional_number(play.get("penaltyYards")),
        "prePenaltyYards": optional_number(play.get("prePenaltyPlayResult")),
        "fouls": fouls,
    }


def build_play(play, game, tracking, player_details, scouting):
    """Validate and assemble one play, raising ValueError for exclusion."""
    frames = defaultdict(list)
    for row in tracking:
        frames[int(row["frameId"])].append(row)
    snap_frames = [
        frame for frame, rows in frames.items()
        if any(row["event"] == "ball_snap" for row in rows)
    ]
    if not snap_frames:
        raise ValueError("missing ball_snap")
    if len(snap_frames) != 1:
        raise ValueError("multiple ball_snap frames")
    snap = snap_frames[0]
    release_frames = [
        frame for frame, rows in frames.items()
        if frame >= snap and any(row["event"] == "pass_forward" for row in rows)
    ]
    if release_frames:
        end = min(release_frames)
        endpoint_label = "Pass release"
    elif play["passResult"] in {"S", "R"}:
        end = max(frames)
        outcome = "sack" if play["passResult"] == "S" else "scramble"
        endpoint_label = f"Observed endpoint ({outcome})"
    else:
        raise ValueError("missing pass_forward on passing play")
    selected_ids = sorted(frame for frame in frames if snap <= frame <= end)
    if selected_ids != list(range(snap, end + 1)):
        raise ValueError("missing frame in replay window")
    if len(selected_ids) < 2:
        raise ValueError("fewer than two replay frames")
    first_rows = frames[snap]
    expected_ids = {entity_id(row) for row in first_rows}
    if len(first_rows) != 23 or len(expected_ids) != 23 or "ball" not in expected_ids:
        raise ValueError("snap does not contain 22 distinct players and ball")
    offense = play["possessionTeam"]
    defense = play["defensiveTeam"]
    team_counts = Counter(row["team"] for row in first_rows)
    if team_counts != Counter({offense: 11, defense: 11, "football": 1}):
        raise ValueError("snap does not contain 11 players per team")
    directions = {row["playDirection"] for frame in selected_ids for row in frames[frame]}
    if len(directions) != 1:
        raise ValueError("inconsistent playDirection")
    direction = next(iter(directions))
    indexed = {}
    for frame in selected_ids:
        rows = frames[frame]
        by_entity = {entity_id(row): row for row in rows}
        if len(rows) != 23 or set(by_entity) != expected_ids:
            raise ValueError(f"frame {frame} has missing, duplicate or changed entities")
        indexed[frame] = by_entity
    entities = []
    for player_id in sorted(expected_ids, key=lambda item: (item == "ball", item)):
        initial = indexed[snap][player_id]
        is_ball = player_id == "ball"
        scout = scouting.get(player_id, {})
        details = player_details.get(player_id, {})
        role = "ball" if is_ball else ROLE_MAP.get(scout.get("pff_role", "").lower(), "other")
        side = "ball" if is_ball else "offense" if initial["team"] == offense else "defense"
        track = []
        for frame in selected_ids:
            row = indexed[frame][player_id]
            if row["team"] != initial["team"]:
                raise ValueError("entity team changes within play")
            track.append(normalized_track_point(row, direction, is_ball))
        entities.append({
            "id": player_id,
            "name": "Football" if is_ball else details.get("displayName", f"Player {player_id}"),
            "jersey": "" if is_ball else initial["jerseyNumber"],
            "team": initial["team"],
            "side": side,
            "role": role,
            "position": "" if is_ball else scout.get("pff_positionLinedUp", details.get("officialPosition", "")),
            "track": track,
            "fieldStatus": ["in_bounds" if in_field(point) else "outside_field" for point in track],
            "scoutingAvailable": is_ball or player_id in scouting,
            "officialPosition": "" if is_ball else details.get("officialPosition", ""),
            "protection": {
                "blockedPlayerId": None if scout.get("pff_nflIdBlockedPlayer") in MISSING else scout.get("pff_nflIdBlockedPlayer"),
                "blockType": None if scout.get("pff_blockType") in MISSING else scout.get("pff_blockType"),
                **{field: source_boolean(scout.get("pff_" + field)) for field in
                   ("hit", "hurry", "sack", "beatenByDefender", "hitAllowed", "hurryAllowed", "sackAllowed", "backFieldBlock")},
            },
        })
    coverage_tracks = {
        entity["id"]: entity["track"] for entity in entities
        if entity["role"] == "coverage" and entity["side"] == "defense"
    }
    if not coverage_tracks:
        raise ValueError("no PFF Coverage defenders")
    receiver_metrics = []
    for entity in entities:
        if entity["role"] == "route" and entity["side"] == "offense":
            receiver_metrics.append({
                "id": entity["id"],
                **separation_metrics(entity["track"], coverage_tracks, OPEN_THRESHOLD, FPS),
            })
    if not receiver_metrics:
        raise ValueError("no PFF Pass Route players")
    raw_los = finite_number(play["absoluteYardlineNumber"], "line of scrimmage")
    los = raw_los if direction == "right" else FIELD_LENGTH - raw_los
    yards_to_go = int(play["yardsToGo"])
    points = [point for entity in entities for point in entity["track"]]
    pre_ids, pre_excluded = [], []
    for frame in range(snap - 1, min(frames) - 1, -1):
        rows = frames.get(frame, [])
        valid = len(rows) == 23 and {entity_id(row) for row in rows} == expected_ids
        valid = valid and all(row["playDirection"] == direction and row["team"] == indexed[snap][entity_id(row)]["team"] for row in rows)
        if not valid:
            pre_excluded = sorted(f for f in frames if f <= frame)
            break
        try:
            for row in rows:
                normalized_track_point(row, direction, row["team"] == "football")
        except ValueError:
            pre_excluded = sorted(f for f in frames if f <= frame)
            break
        indexed[frame] = {entity_id(row): row for row in rows}
        pre_ids.append(frame)
    pre_ids.reverse()
    pre_snap = {
        "times": [round((f-snap)/FPS, 3) for f in pre_ids], "frameIds": pre_ids,
        "events": [event_for_frame(frames[f]) for f in pre_ids],
        "players": [{"id": e["id"], "track": [normalized_track_point(indexed[f][e["id"]], direction, e["id"] == "ball") for f in pre_ids]} for e in entities],
    }
    missing_scouting = sorted(e["id"] for e in entities if not e["scoutingAvailable"])
    unknown_roles = sorted(e["id"] for e in entities if e["role"] == "other")
    disagreements = []
    for frame in selected_ids:
        tags = Counter(row["event"] for row in frames[frame] if row["event"] not in MISSING)
        missing_count = sum(row["event"] in MISSING for row in frames[frame])
        if len(tags) > 1 or (tags and missing_count):
            disagreements.append({"frameId": frame, "events": dict(tags), "missingCount": missing_count})
    trajectory_flags = []
    for entity in entities:
        if entity["side"] == "ball":
            continue
        for i, point in enumerate(entity["track"]):
            reasons = []
            if point[2] > 13:
                reasons.append("speed_above_13_yd_s")
            if i:
                old = entity["track"][i-1]
                step = math.hypot(point[0]-old[0], point[1]-old[1])
                if step > 2.0:
                    reasons.append("position_jump_above_2_yd_frame")
                if abs(step-(point[2]+old[2])/(2*FPS)) > 0.75:
                    reasons.append("speed_displacement_difference_above_0_75_yd")
            trajectory_flags.extend({"playerId": entity["id"], "frameId": selected_ids[i], "type": reason} for reason in reasons)
    ambiguous_entities = [e for e in entities if e["side"] != "ball" and "outside_field" in e["fieldStatus"]]
    ambiguous_frames = {i for e in ambiguous_entities for i, status in enumerate(e["fieldStatus"]) if status == "outside_field"}
    metric_lookup = {m["id"]: m for m in receiver_metrics}
    route_outside = [(e, i) for e in entities if e["role"] == "route" for i, status in enumerate(e["fieldStatus"][:-1]) if status == "outside_field"]
    quality = {
        "flags": [], "scoutingMissingIds": missing_scouting, "unknownRoleIds": unknown_roles,
        "roleCounts": dict(sorted(Counter(e["role"] for e in entities).items())),
        "fieldAmbiguity": {"entityIds": [e["id"] for e in ambiguous_entities], "frameCount": len(ambiguous_frames),
                           "routeIntervalCount": len(route_outside), "openRouteIntervalCount": sum(e["track"][i][0] >= los and metric_lookup[e["id"]]["separation"][i] >= OPEN_THRESHOLD for e, i in route_outside)},
        "eventDisagreements": disagreements, "trajectoryFlags": trajectory_flags,
        "preSnapExcludedFrames": pre_excluded,
        "measurementNote": "Diagnostic flags are descriptive; field-boundary observations do not establish an illegal route. Motion thresholds are heuristic, not calibrated sensor error bounds.",
    }
    for name, condition in (("scouting_missing", missing_scouting), ("unknown_roles", unknown_roles), ("field_boundary", ambiguous_entities),
                            ("event_disagreement", disagreements), ("trajectory_flag", trajectory_flags), ("pre_snap_incomplete", pre_excluded)):
        if condition:
            quality["flags"].append(name)
    penalty = penalty_context(play)
    return {
        "id": f"{play['gameId']}_{play['playId']}",
        "gameId": int(play["gameId"]),
        "playId": int(play["playId"]),
        "homeTeam": game["homeTeamAbbr"],
        "awayTeam": game["visitorTeamAbbr"],
        "offense": offense,
        "defense": defense,
        "quarter": int(play["quarter"]),
        "clock": play["gameClock"],
        "down": int(play["down"]),
        "yardsToGo": yards_to_go,
        "formation": play["offenseFormation"],
        "coverage": play["pff_passCoverage"],
        "coverageType": play["pff_passCoverageType"],
        "description": play["playDescription"],
        "result": play["passResult"],
        "yards": int(play["playResult"]),
        "context": play_context(play, game),
        "penalty": penalty,
        "quality": quality,
        "preSnap": pre_snap,
        "cohortEligible": not penalty["nullified"] and not any(flag in quality["flags"] for flag in ("scouting_missing", "unknown_roles", "field_boundary", "trajectory_flag", "event_disagreement")),
        "los": round(los, 3),
        "firstDown": round(min(FIELD_LENGTH, max(0.0, los + yards_to_go)), 3),
        "times": [round((frame - snap) / FPS, 3) for frame in selected_ids],
        "frameIds": selected_ids,
        "events": [event_for_frame(frames[frame]) for frame in selected_ids],
        "endpointLabel": endpoint_label,
        "players": entities,
        "metrics": {"receivers": receiver_metrics},
        "bounds": {
            "xMin": min(point[0] for point in points),
            "xMax": max(point[0] for point in points),
            "yMin": min(point[1] for point in points),
            "yMax": max(point[1] for point in points),
        },
    }


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        stream.write("\n")


def json_bytes(payload):
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def write_json_pair(output, payload, provenance):
    """Stage both validated files and roll back replacements on write failure.

    Two separate path replacements cannot be one crash-atomic filesystem
    operation. Shared buildId plus datasetSha256 detect an interrupted pair;
    rollback covers ordinary exceptions without leaving partially written JSON.
    """
    output = Path(output)
    other = output.with_name("provenance.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    body = json_bytes(payload)
    provenance["datasetSha256"] = hashlib.sha256(body).hexdigest()
    targets = [(output, body), (other, json_bytes(provenance))]
    backups = {path: path.read_bytes() if path.exists() else None for path, _ in targets}
    staged, replaced = [], []
    try:
        for path, content in targets:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
                temp = Path(stream.name)
                staged.append((path, temp))
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
        for path, temp in staged:
            os.replace(temp, path)
            replaced.append(path)
    except BaseException:
        for path in reversed(replaced):
            prior = backups[path]
            if prior is None:
                path.unlink(missing_ok=True)
            else:
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".restore.", delete=False) as stream:
                    recovery = Path(stream.name)
                    stream.write(prior)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(recovery, path)
        raise
    finally:
        for _, temp in staged:
            temp.unlink(missing_ok=True)


def validate_output_pair(output):
    """Detect mismatched dataset/provenance after an interrupted publication."""
    output = Path(output)
    data = validate_dataset(json.loads(output.read_text(encoding="utf-8")))
    provenance = json.loads(output.with_name("provenance.json").read_text(encoding="utf-8"))
    if provenance.get("datasetSha256") and provenance["datasetSha256"] != file_digest(output):
        raise ValueError("dataset/provenance SHA-256 mismatch; rebuild or restore the complete pair")
    if data["meta"].get("buildId") != provenance.get("buildId"):
        raise ValueError("dataset/provenance buildId mismatch")
    return data


def cohort_counts(plays, exclusions=()):
    def count(items):
        return {"included": len(items), "eligible": sum(p.get("cohortEligible", True) for p in items),
                "nullified": sum(p["penalty"]["nullified"] for p in items),
                "penalized": sum(p["penalty"]["hasPenalty"] for p in items),
                "fieldAmbiguous": sum("field_boundary" in p["quality"]["flags"] for p in items),
                "scoutingIncomplete": sum(bool(p["quality"]["scoutingMissingIds"] or p["quality"]["unknownRoleIds"]) for p in items)}
    summary = count(plays)
    summary["excluded"] = len(exclusions)
    summary["exclusionRate"] = len(exclusions)/(len(plays)+len(exclusions)) if plays or exclusions else 0
    summary["eligibilityDefinition"] = "Included, non-nullified plays without field-boundary, scouting, event-agreement or heuristic trajectory flags; this is an analysis filter, not a legal or medical determination."
    for output_key, field in (("byGame", "gameId"), ("byOffense", "offense"), ("byCoverage", "coverage")):
        keys = sorted({str(p[field]) for p in plays} | {str(e.get(field, "")) for e in exclusions if e.get(field) is not None})
        summary[output_key] = {}
        for key in keys:
            items = [p for p in plays if str(p[field]) == key]
            item_exclusions = [e for e in exclusions if str(e.get(field)) == key]
            detail = count(items)
            detail["excluded"] = len(item_exclusions)
            detail["exclusionRate"] = len(item_exclusions)/(len(items)+len(item_exclusions)) if items or item_exclusions else 0
            summary[output_key][key] = detail
    return summary


def build_catalog(game_rows, play_rows, output=None):
    counts = Counter(int(row["gameId"]) for row in play_rows)
    entries = [{"gameId": int(row["gameId"]), "season": int(row["season"]), "week": int(row["week"]),
                "date": row["gameDate"], "homeTeam": row["homeTeamAbbr"], "awayTeam": row["visitorTeamAbbr"],
                "sourcePlayCount": counts[int(row["gameId"])],
                "trackingSourceUrl": RAW_BASE + f"tracking/tracking_{row['gameId']}.csv"}
               for row in sorted(game_rows, key=lambda row: int(row["gameId"]))]
    catalog = {"schemaVersion": 1, "sourceRevision": SOURCE_REVISION, "season": 2021,
               "gameCount": len(entries), "sourcePlayCount": len(play_rows), "games": entries,
               "packs": [{"id": "demo", "title": "Original coaching examples: DAL–TB and NYG–KC", "path": "demo.json", "games": list(DEFAULT_GAMES)}],
               "note": "Catalog lists source availability, not downloaded tracking. Packs fetch only explicitly selected games."}
    for file in sorted((ROOT / "data/packs").glob("*/demo.json")):
        pack = json.loads(file.read_text(encoding="utf-8"))
        catalog["packs"].append({"id": file.parent.name, "title": pack["meta"].get("packTitle", file.parent.name),
                                 "path": file.relative_to(ROOT / "data").as_posix(),
                                 "games": sorted({p["gameId"] for p in pack["plays"]}),
                                 "playCount": len(pack["plays"]), "bytes": file.stat().st_size,
                                 "sha256": file_digest(file)})
    if output:
        write_json(Path(output), catalog)
    return catalog


def load_stories(plays, config_path=None):
    """Load curated stories that can be fully replayed in the selected games.

    A custom game selection can have no curated stories; consumers should then
    offer the ordinary play list. A story references receiver metrics rather
    than inferring a target or a defensive assignment.
    """
    config_path = Path(config_path) if config_path else Path(__file__).parent / "data" / "stories.json"
    if not config_path.is_file():
        return []
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(config, list):
        raise ValueError("stories config must be an array")
    by_id = {play["id"]: play for play in plays}
    available_receivers = {
        play["id"]: {receiver["id"] for receiver in play["metrics"]["receivers"]}
        for play in plays
    }
    result = []
    required = {"id", "receiverId", "title", "caption", "focusTime", "compareId", "compareReceiverId"}
    for story in config:
        if not isinstance(story, dict) or not required.issubset(story):
            raise ValueError("each story must contain the documented fields")
        if story["id"] not in by_id or story["compareId"] not in by_id:
            continue
        if story["receiverId"] not in available_receivers[story["id"]]:
            raise ValueError(f"story receiver absent: {story['id']}/{story['receiverId']}")
        if story["compareReceiverId"] not in available_receivers[story["compareId"]]:
            raise ValueError(f"comparison receiver absent: {story['compareId']}/{story['compareReceiverId']}")
        focus_time = float(story["focusTime"])
        if not math.isfinite(focus_time) or not 0 <= focus_time <= by_id[story["id"]]["times"][-1]:
            raise ValueError(f"story focusTime outside replay: {story['id']}")
        result.append(story)
    return result


def build_dataset(data_dir=None, output=Path("data/demo.json"), games=DEFAULT_GAMES,
                  cache_dir=Path("cache"), refresh=False, progress=None, pack_title=None):
    """Generate demo.json and sibling provenance.json; return both payloads."""
    data_dir = Path(data_dir) if data_dir is not None else None
    output, cache_dir = Path(output), Path(cache_dir)
    games = tuple(sorted(set(int(game) for game in games)))
    if not games:
        raise ValueError("select at least one game")
    wanted = set(games)
    sources = []

    def read_source(relative_path):
        path = source_file(relative_path, data_dir, cache_dir, refresh, progress)
        contents = path.read_bytes()
        sources.append({
            "path": relative_path,
            "sourceUrl": RAW_BASE + relative_path,
            "sha256": hashlib.sha256(contents).hexdigest(),
            "bytes": len(contents),
            "origin": "local" if data_dir is not None else "pinned_download_cache",
            "verification": verify_source(path, relative_path),
        })
        return load_csv(path)

    game_rows = read_source("games.csv")
    game_lookup = {int(row["gameId"]): row for row in game_rows}
    if not wanted.issubset(game_lookup):
        raise ValueError(f"unknown game IDs: {sorted(wanted - set(game_lookup))}")
    all_play_rows = read_source("plays.csv")
    play_rows = [row for row in all_play_rows if int(row["gameId"]) in wanted]
    player_rows = read_source("players.csv")
    player_lookup = {row["nflId"]: row for row in player_rows}
    scout_rows = read_source("pffScoutingData.csv")
    scout_lookup = defaultdict(dict)
    for row in scout_rows:
        if int(row["gameId"]) in wanted:
            scout_lookup[(row["gameId"], row["playId"])][row["nflId"]] = row
    plays_by_game = defaultdict(list)
    for row in play_rows:
        plays_by_game[int(row["gameId"])].append(row)
    assembled = []
    excluded = []
    for game_id in games:
        tracking = read_source(f"tracking/tracking_{game_id}.csv")
        track_lookup = defaultdict(list)
        for row in tracking:
            if int(row["gameId"]) != game_id:
                raise ValueError(f"wrong gameId inside tracking_{game_id}.csv")
            track_lookup[row["playId"]].append(row)
        for play in sorted(plays_by_game[game_id], key=lambda row: int(row["playId"])):
            key = (play["gameId"], play["playId"])
            try:
                assembled.append(build_play(
                    play,
                    game_lookup[game_id],
                    track_lookup[play["playId"]],
                    player_lookup,
                    scout_lookup[key],
                ))
            except (ValueError, KeyError) as error:
                excluded.append({"id": "_".join(key), "gameId": game_id, "offense": play["possessionTeam"],
                                 "coverage": play["pff_passCoverage"], "result": play["passResult"], "reason": str(error)})
    if not assembled:
        raise ValueError("all selected plays were excluded")
    seasons = sorted({int(game_lookup[game]["season"]) for game in games})
    if len(seasons) != 1:
        raise ValueError("schemaVersion 1 requires a single season")
    stories = load_stories(assembled)
    verified = all(source["verification"] == "verified" for source in sources)
    source_revision = SOURCE_REVISION if verified else None
    counts = cohort_counts(assembled, excluded)
    config_path = ROOT / "data/stories.json"
    pipeline_hash = file_digest(Path(__file__))
    config_hash = file_digest(config_path) if config_path.exists() else None
    build_spec = {"games": list(games), "files": [{"path": s["path"], "sha256": s["sha256"]} for s in sources],
                  "pipelineSha256": pipeline_hash, "storiesSha256": config_hash,
                  "schemaSha256": file_digest(ROOT / "schema.py"),
                  "sourceManifestSha256": file_digest(ROOT / "data/source-manifest.json"),
                  "metricVersion": METRIC_VERSION, "packTitle": pack_title}
    build_id = hashlib.sha256(json_bytes(build_spec)).hexdigest()[:24]
    payload = {
        "schemaVersion": 1,
        "meta": {
            "sourceUrl": SOURCE_URL,
            "sourceRevision": source_revision,
            "requestedSourceRevision": SOURCE_REVISION,
            "sourceVerification": "verified_manifest" if verified else "unverified_or_modified_source",
            "buildId": build_id,
            "pipelineVersion": PIPELINE_VERSION,
            "metricVersion": METRIC_VERSION,
            "separationPrecision": "full",
            "windowThreshold": OPEN_THRESHOLD,
            "trackFields": ["x", "y", "speed", "direction", "orientation", "acceleration", "displacement"],
            "cohortCounts": counts,
            "packTitle": pack_title or "Original coaching examples",
            "season": seasons[0],
            "gameCount": len({play["gameId"] for play in assembled}),
            "playCount": len(assembled),
            "fps": FPS,
            "fieldLength": FIELD_LENGTH,
            "fieldWidth": FIELD_WIDTH,
            "note": DATA_NOTE,
        },
        "plays": assembled,
        "stories": stories,
        "featured": list(dict.fromkeys(story["id"] for story in stories)),
    }
    provenance = {
        "schemaVersion": 1,
        "sourceUrl": SOURCE_URL,
        "sourceRevision": source_revision,
        "requestedSourceRevision": SOURCE_REVISION,
        "sourceVerification": payload["meta"]["sourceVerification"],
        "buildId": build_id,
        "pipelineVersion": PIPELINE_VERSION,
        "metricVersion": METRIC_VERSION,
        "pipelineSha256": pipeline_hash,
        "schemaSha256": file_digest(ROOT / "schema.py"),
        "storiesSha256": config_hash,
        "sourceManifestSha256": file_digest(ROOT / "data/source-manifest.json"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "selectedGames": list(games),
        "sourceSeason": seasons[0],
        "sourceTotalGames": len(game_rows),
        "sourceTotalPlays": len(all_play_rows),
        "sourceTotalPlayers": len(player_rows),
        "selectedPlayCount": len(play_rows),
        "includedPlayCount": len(assembled),
        "includedStoryCount": len(stories),
        "excludedPlays": excluded,
        "cohortCounts": counts,
        "qualitySummary": {"flaggedPlays": dict(sorted(Counter(flag for p in assembled for flag in p["quality"]["flags"]).items())),
                           "eventDisagreementFrames": sum(len(p["quality"]["eventDisagreements"]) for p in assembled),
                           "trajectoryFlags": sum(len(p["quality"]["trajectoryFlags"]) for p in assembled),
                           "excludedByReason": dict(Counter(e["reason"] for e in excluded))},
        "files": sources,
        "transforms": [
            "Left-moving plays rotated: x=120-x, y=53.3-y, dir/o=(angle+180)%360.",
            "Replay window: ball_snap through first pass_forward inclusive; sacks and scrambles end at observed endpoint.",
            "Require consecutive replay frames with the same 22 players plus ball, 11 players on each team, and finite player values.",
            "Football has no measured heading or body orientation; both stored as 0 placeholders and should not be visualized as ball headings.",
            "PFF Pass Route players measured against nearest PFF Coverage player; rushers are excluded from this separation metric.",
            "Open threshold >=3 yards. Each observed 0.1s interval is classified by its starting-frame separation; final sample adds no duration.",
            "Source coordinates preserved to six decimals after normalization; separation uses full floating-point precision. Timing derives from frameId at 10 Hz.",
            "Optional source acceleration and displacement follow the original five track values. Separate preSnap arrays never change post-snap indices.",
            "Nullified status comes from an explicit No Play description; penalty fields preserve the source. Cohort eligibility is an explicit conservative diagnostic filter.",
        ],
        "limitations": [
            DATA_NOTE,
            "Distance is a geometric coaching aid, not route availability, throw feasibility or a causal estimate.",
            "No explicit target receiver or route-type label; Pass Route includes decoys and checkdown players.",
            "Source body orientation is not gaze; the nearest defender is not a labelled coverage assignment.",
            "Curated stories compare observed spacing beyond the line of scrimmage after 0.5 seconds, not presumed passing decisions.",
        ],
    }
    validate_dataset(payload)
    write_json_pair(output, payload, provenance)
    if output.resolve() == (ROOT / "data/demo.json").resolve():
        build_catalog(game_rows, all_play_rows, ROOT / "data/catalog.json")
    return payload, provenance


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", type=Path, help="Existing CSV directory; accepts flat audit or original tracking/ layout")
    parser.add_argument("--output", type=Path, default=Path("data/demo.json"))
    parser.add_argument("--cache-dir", type=Path, default=Path("cache"), help="Download cache (default: cache/; add to .gitignore)")
    parser.add_argument("--games", nargs="+", help="Game IDs separated by spaces or commas; default: two sample games")
    parser.add_argument("--refresh", action="store_true", help="Redownload selected cached files and validate hashes")
    parser.add_argument("--quiet", action="store_true", help="Suppress source progress messages")
    args = parser.parse_args(argv)
    try:
        games = [int(value) for group in args.games for value in group.split(",")] if args.games else DEFAULT_GAMES
        progress = None if args.quiet else lambda message: print(message, file=sys.stderr)
        payload, provenance = build_dataset(args.data_dir, args.output, games, args.cache_dir, args.refresh, progress)
    except (OSError, ValueError, KeyError) as error:
        print(f"Data build failed: {error}", file=sys.stderr)
        return 1
    print(f"Built {payload['meta']['playCount']} plays from {payload['meta']['gameCount']} games -> {args.output}")
    print(f"Excluded {len(provenance['excludedPlays'])} plays; details in {args.output.with_name('provenance.json')}")
    for item in provenance["excludedPlays"]:
        print(f"  {item['id']}: {item['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
