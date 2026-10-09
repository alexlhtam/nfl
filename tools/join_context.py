"""Join optional nflverse targets/outcomes using verified IDs, never name guesses.

The pinned release assets are identified by SHA-256 because release URLs can change.
Context remains separate from tracking-derived metrics and is hidden in blind mode.
"""
from __future__ import annotations
import argparse
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import atomic_write_text

SOURCES = {
    "pbp": {"url": "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2021.csv.gz", "sha256": "e8743a568f99667a8bdcd29ba12224ee1782ad2b7916bee78ee335c099383739", "name": "play_by_play_2021.csv.gz"},
    "players": {"url": "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv", "sha256": "97d15de28f366d0548bd0cb10a55f1f41e73752d10054c710075277fba6ef29e", "name": "players.csv"},
}


def fetch_verified(source, cache):
    path = cache / source["name"]
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == source["sha256"]:
        return path
    cache.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            print(f"Downloading {source['name']} (attempt {attempt + 1})", file=sys.stderr)
            request = urllib.request.Request(source["url"], headers={"User-Agent": "Open-Field/2.0"})
            with urllib.request.urlopen(request, timeout=45) as response:
                content = response.read()
            if hashlib.sha256(content).hexdigest() != source["sha256"]:
                raise ValueError(f"{source['name']}: release changed; review and explicitly update the pinned digest")
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_bytes(content)
            temporary.replace(path)
            return path
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(0.5 * 2**attempt)


def integer_id(value):
    if value in (None, "", "NA", "NaN"):
        return None
    number = float(value)
    if not math.isfinite(number) or number != int(number):
        raise ValueError(f"Not an integer identifier: {value}")
    return str(int(number))


def finite_optional(value):
    if value in (None, "", "NA", "NaN", "nan"):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def validated_join(plays, pbp_rows, player_rows):
    crosswalk = {}
    for row in player_rows:
        gsis, nfl = row.get("gsis_id"), integer_id(row.get("nfl_id"))
        if not gsis or not nfl:
            continue
        if gsis in crosswalk and crosswalk[gsis] != nfl:
            raise ValueError(f"Conflicting GSIS/NFL identifier mapping: {gsis}")
        crosswalk[gsis] = nfl
    wanted = {p["id"]: p for p in plays}
    context, unmatched, target_unmatched, rejected = {}, [], [], []
    seen = set()
    for row in pbp_rows:
        game, play = integer_id(row.get("old_game_id")), integer_id(row.get("play_id"))
        if game is None or play is None:
            continue
        key = f"{game}_{play}"
        if key not in wanted:
            continue
        if key in seen:
            raise ValueError(f"Duplicate matching play-by-play key: {key}")
        seen.add(key)
        p = wanted[key]
        if row.get("home_team") != p["homeTeam"] or row.get("away_team") != p["awayTeam"]:
            rejected.append({"id": key, "reason": "home/away team mismatch"})
            continue
        if row.get("posteam") and row["posteam"] != p["offense"]:
            rejected.append({"id": key, "reason": "possession mismatch"})
            continue
        if row.get("qtr") and integer_id(row["qtr"]) != str(p["quarter"]):
            rejected.append({"id": key, "reason": "quarter mismatch"})
            continue
        gsis = row.get("receiver_player_id") or None
        target = crosswalk.get(gsis) if gsis else None
        target_status = "not recorded"
        if gsis:
            if target and any(q["id"] == target and q["side"] == "offense" for q in p["players"]):
                target_status = "verified player crosswalk and on-field offense"
            else:
                target_unmatched.append({"id": key, "gsisId": gsis, "mappedNflId": target})
                target, target_status = None, "unresolved; no name-based guess"
        context[key] = {
            "source": "nflverse play-by-play", "joinStatus": "verified game/play/team/quarter",
            "targetId": target, "targetGSISId": gsis, "targetName": row.get("receiver_player_name") or None,
            "targetStatus": target_status, "epa": finite_optional(row.get("epa")),
            "airYards": finite_optional(row.get("air_yards")), "yardsAfterCatch": finite_optional(row.get("yards_after_catch")),
            "yardsGained": finite_optional(row.get("yards_gained")), "playType": row.get("play_type") or None,
            "penalty": row.get("penalty") == "1", "nullified": row.get("play_type") == "no_play",
            "note": "Retrospective outcome context; EPA is not route-level causal credit.",
        }
    unmatched = sorted(set(wanted) - set(context))
    return context, {"requestedPlays": len(wanted), "matchedPlays": len(context), "targetMapped": sum(v["targetId"] is not None for v in context.values()), "unmatchedPlays": unmatched, "unresolvedTargets": target_unmatched, "rejected": rejected, "crosswalkCount": len(crosswalk)}


def build(datasets, output, cache):
    paths = {key: fetch_verified(source, cache) for key, source in SOURCES.items()}
    plays = []
    for dataset in datasets:
        plays.extend(json.loads(dataset.read_text(encoding="utf-8"))["plays"])
    plays = list({p["id"]: p for p in plays}.values())
    with paths["players"].open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not {"gsis_id", "nfl_id"}.issubset(reader.fieldnames or []):
            raise ValueError(f"Player crosswalk lacks required IDs; columns: {reader.fieldnames}")
        player_rows = list(reader)
    with gzip.open(paths["pbp"], "rt", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not {"old_game_id", "play_id", "home_team", "away_team", "receiver_player_id"}.issubset(reader.fieldnames or []):
            raise ValueError("Play-by-play lacks required join columns")
        context, report = validated_join(plays, reader, player_rows)
    payload = {"schemaVersion": 1, "sources": SOURCES, "documentation": "https://nflfastr.com/reference/fast_scraper.html", "report": report, "plays": context}
    atomic_write_text(output, json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n")
    print(json.dumps(report, indent=2))
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", nargs="+", type=Path, default=[ROOT / "data/demo.json"])
    parser.add_argument("--output", type=Path, default=ROOT / "data/outcome-context.json")
    parser.add_argument("--cache", type=Path, default=ROOT / "cache/context")
    args = parser.parse_args()
    build(args.data, args.output, args.cache)
