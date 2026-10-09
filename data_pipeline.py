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
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


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
        "separation": [round(distance, 3) for distance in distances],
        "nearestId": nearest_ids,
        "peakSeparation": round(max(distances), 3),
        "separationAtEnd": round(distances[-1], 3),
        "totalOpenSeconds": round(total / fps, 3),
        "longestOpenSeconds": round(longest / fps, 3),
    }


def load_csv(path):
    """Read a CSV preserving source IDs and explicit NA markers as strings."""
    with Path(path).open("r", encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def source_file(relative_path, local_dir, cache_dir):
    """Use provided source files, or download one pinned source into cache."""
    if local_dir is not None:
        candidates = [local_dir / relative_path, local_dir / Path(relative_path).name]
        for path in candidates:
            if path.is_file():
                return path
        raise FileNotFoundError(f"Missing source file: {relative_path} in {local_dir}")
    path = cache_dir / relative_path
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            RAW_BASE + relative_path,
            headers={"User-Agent": "NFL-Separation-Replay/1.0"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            contents = response.read()
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(contents)
        temporary.replace(path)
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
            # Ball angles are unmeasured; use 0 as a non-directional placeholder.
            heading = finite_number(row["dir"], "direction", 0 if is_ball else None)
            orientation = finite_number(row["o"], "orientation", 0 if is_ball else None)
            x, y, heading, orientation = normalize_point(
                finite_number(row["x"], "x"),
                finite_number(row["y"], "y"),
                heading,
                orientation,
                direction,
            )
            speed = finite_number(row["s"], "speed", 0 if is_ball else None)
            if speed < 0:
                raise ValueError("negative speed")
            if is_ball:
                heading = orientation = 0.0
            track.append([round(v, 3) for v in (x, y, speed, heading, orientation)])
        entities.append({
            "id": player_id,
            "name": "Football" if is_ball else details.get("displayName", f"Player {player_id}"),
            "jersey": "" if is_ball else initial["jerseyNumber"],
            "team": initial["team"],
            "side": side,
            "role": role,
            "position": "" if is_ball else scout.get("pff_positionLinedUp", details.get("officialPosition", "")),
            "track": track,
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
        if not isinstance(story, dict) or set(story) != required:
            raise ValueError("each story must contain exactly the documented fields")
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
                  cache_dir=Path("cache")):
    """Generate demo.json and sibling provenance.json; return both payloads."""
    data_dir = Path(data_dir) if data_dir is not None else None
    output, cache_dir = Path(output), Path(cache_dir)
    games = tuple(sorted(set(int(game) for game in games)))
    if not games:
        raise ValueError("select at least one game")
    wanted = set(games)
    sources = []

    def read_source(relative_path):
        path = source_file(relative_path, data_dir, cache_dir)
        contents = path.read_bytes()
        sources.append({
            "path": relative_path,
            "sourceUrl": RAW_BASE + relative_path,
            "sha256": hashlib.sha256(contents).hexdigest(),
            "bytes": len(contents),
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
                excluded.append({"id": "_".join(key), "reason": str(error)})
    if not assembled:
        raise ValueError("all selected plays were excluded")
    seasons = sorted({int(game_lookup[game]["season"]) for game in games})
    if len(seasons) != 1:
        raise ValueError("schemaVersion 1 requires a single season")
    stories = load_stories(assembled)
    payload = {
        "schemaVersion": 1,
        "meta": {
            "sourceUrl": SOURCE_URL,
            "sourceRevision": SOURCE_REVISION,
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
        "sourceRevision": SOURCE_REVISION,
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
        "files": sources,
        "transforms": [
            "Left-moving plays rotated: x=120-x, y=53.3-y, dir/o=(angle+180)%360.",
            "Replay window: ball_snap through first pass_forward inclusive; sacks and scrambles end at observed endpoint.",
            "Require consecutive replay frames with the same 22 players plus ball, 11 players on each team, and finite player values.",
            "Football has no measured heading or body orientation; both stored as 0 placeholders and should not be visualized as ball headings.",
            "PFF Pass Route players measured against nearest PFF Coverage player; rushers are excluded from this separation metric.",
            "Open threshold >=3 yards. Each observed 0.1s interval is classified by its starting-frame separation; final sample adds no duration.",
            "Position/speed/angle and output separation rounded to three decimals; timing derived from frameId at 10 Hz.",
        ],
        "limitations": [
            DATA_NOTE,
            "Distance is a geometric coaching aid, not route availability, throw feasibility or a causal estimate.",
            "No explicit target receiver or route-type label; Pass Route includes decoys and checkdown players.",
            "Source body orientation is not gaze; the nearest defender is not a labelled coverage assignment.",
            "Curated stories compare observed spacing beyond the line of scrimmage after 0.5 seconds, not presumed passing decisions.",
        ],
    }
    write_json(output, payload)
    write_json(output.with_name("provenance.json"), provenance)
    return payload, provenance


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", type=Path, help="Existing CSV directory; accepts flat audit or original tracking/ layout")
    parser.add_argument("--output", type=Path, default=Path("data/demo.json"))
    parser.add_argument("--cache-dir", type=Path, default=Path("cache"), help="Download cache (default: cache/; add to .gitignore)")
    parser.add_argument("--games", nargs="+", help="Game IDs separated by spaces or commas; default: two sample games")
    args = parser.parse_args(argv)
    try:
        games = [int(value) for group in args.games for value in group.split(",")] if args.games else DEFAULT_GAMES
        payload, provenance = build_dataset(args.data_dir, args.output, games, args.cache_dir)
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
