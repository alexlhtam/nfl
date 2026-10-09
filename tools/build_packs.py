#!/usr/bin/env python3
"""Build explicitly selected, offline-importable game packs, never all games.

python tools/build_packs.py --list
python tools/build_packs.py --games 2021091200 2021091201 --name week-1-additional

The output directory contains demo.json and matching provenance.json. Import
demo.json in Open Field, or run python app.py --data <pack>/demo.json --export
<destination>.html to package a standalone offline viewer.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from data_pipeline import build_catalog, build_dataset, load_csv, source_file, validate_output_pair


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="List catalog games without downloading tracking")
    parser.add_argument("--games", nargs="+", default=["2021091200", "2021091201"], help="Explicit IDs; at most eight games per pack")
    parser.add_argument("--name", default="week-1-additional", help="Lowercase letters, digits and hyphens")
    parser.add_argument("--title", help="Optional display title; defaults to the selected games")
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "cache")
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args(argv)
    catalog_file = ROOT / "data/catalog.json"
    if args.list:
        catalog = json.loads(catalog_file.read_text(encoding="utf-8"))
        for game in catalog["games"]:
            print(f"{game['gameId']}  Week {game['week']}  {game['awayTeam']} @ {game['homeTeam']}  {game['sourcePlayCount']} source dropbacks")
        return 0
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", args.name):
        parser.error("--name must contain 1–64 lowercase letters, digits or hyphens")
    try:
        games = sorted({int(value) for group in args.games for value in group.split(",")})
        if not 1 <= len(games) <= 8:
            raise ValueError("select 1–8 games per pack; build separate packs for larger collections")
        title = args.title or ("Week 1: Philadelphia–Atlanta and Pittsburgh–Buffalo" if games == [2021091200, 2021091201]
                               else "Selected games: " + ", ".join(map(str, games)))
        destination = ROOT / "data/packs" / args.name / "demo.json"
        data, provenance = build_dataset(args.data_dir, destination, games, args.cache_dir,
                                        args.refresh, lambda s: print(s, file=sys.stderr), title)
        validate_output_pair(destination)
        game_rows = load_csv(source_file("games.csv", args.data_dir, args.cache_dir))
        play_rows = load_csv(source_file("plays.csv", args.data_dir, args.cache_dir))
        build_catalog(game_rows, play_rows, catalog_file)
        print(f"Built {len(data['plays'])} plays from {len(games)} selected games: {destination.relative_to(ROOT)}")
        print(f"Analysis-eligible plays: {data['meta']['cohortCounts']['eligible']}; source exclusions: {len(provenance['excludedPlays'])}")
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"Pack build failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
