"""Validate old/new replay contracts and reject damaged imported packs."""
import copy
import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
from data_pipeline import build_play
from schema import validate_dataset
from test_metrics import synthetic_play_inputs


def dataset_fixture():
    play = build_play(*synthetic_play_inputs())
    return {"schemaVersion": 1, "meta": {"fps": 10, "playCount": 1, "gameCount": 1,
            "fieldLength": 120, "fieldWidth": 53.3, "separationPrecision": "full"},
            "plays": [play], "stories": [], "featured": []}


class SchemaTests(unittest.TestCase):
    def test_accepts_legacy_and_extended_tracks_without_mutation(self):
        data = dataset_fixture()
        self.assertIs(validate_dataset(data), data)
        data["meta"].pop("separationPrecision")
        for player in data["plays"][0]["players"]:
            player["track"] = [row[:5] for row in player["track"]]
        self.assertIs(validate_dataset(data), data)

    def test_bad_identity_role_and_population(self):
        for change in ("duplicate", "wrong_team", "wrong_role", "missing_player"):
            data = dataset_fixture(); play = data["plays"][0]
            if change == "duplicate": play["players"][1]["id"] = play["players"][0]["id"]
            elif change == "wrong_team": play["players"][0]["team"] = "BAD"
            elif change == "wrong_role": play["players"][0]["role"] = "coverage"
            else: play["players"].pop()
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "players"):
                validate_dataset(data)

    def test_corrupt_alignment_timing_and_finite_values(self):
        for change in ("short_track", "time_gap", "nan", "angle", "negative_speed", "pre_snap"):
            data = dataset_fixture(); play = data["plays"][0]
            if change == "short_track": play["players"][0]["track"].pop()
            elif change == "time_gap": play["times"][1] = .15
            elif change == "nan": play["players"][0]["track"][0][0] = float("nan")
            elif change == "angle": play["players"][0]["track"][0][3] = 360
            elif change == "negative_speed": play["players"][0]["track"][0][2] = -1
            else: play["preSnap"]["times"][0] = .1
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_dataset(data)

    def test_metrics_are_verified_not_merely_well_shaped(self):
        for change in ("distance", "nearest", "duration", "duplicate", "wrong_id"):
            data = dataset_fixture(); ms = data["plays"][0]["metrics"]["receivers"]; m = ms[0]
            if change == "distance": m["separation"][1] += .01
            elif change == "nearest": m["nearestId"][0] = "ball"
            elif change == "duration": m["totalOpenSeconds"] = 99
            elif change == "duplicate": ms.append(copy.deepcopy(m))
            else: m["id"] = "ball"
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "metrics"):
                validate_dataset(data)

    def test_unknown_extension_values_still_must_be_json_finite(self):
        data = dataset_fixture(); data["newMetric"] = {"value": float("inf")}
        with self.assertRaisesRegex(ValueError, "newMetric"):
            validate_dataset(data)

    def test_release_cutoff_and_story_references(self):
        data = dataset_fixture(); data["plays"][0]["events"][-1] = ""
        with self.assertRaisesRegex(ValueError, "release"):
            validate_dataset(data)
        data = dataset_fixture(); data["featured"] = ["missing"]
        with self.assertRaisesRegex(ValueError, "featured"):
            validate_dataset(data)

    def test_optional_context_and_protection_fields_reject_wrong_types(self):
        for change in ("score", "play_action", "blocked_id", "protection_bool", "foul", "penalty_yards", "scouting_bool"):
            data = dataset_fixture(); play = data["plays"][0]
            if change == "score": play["context"]["homeScore"] = "7"
            elif change == "play_action": play["context"]["playAction"] = 1
            elif change == "blocked_id": play["players"][0]["protection"]["blockedPlayerId"] = 5
            elif change == "protection_bool": play["players"][0]["protection"]["hit"] = "false"
            elif change == "foul": play["penalty"]["fouls"] = [{"name": None}]
            elif change == "penalty_yards": play["penalty"]["yards"] = True
            else: play["players"][0]["scoutingAvailable"] = "yes"
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_dataset(data)

    def test_derived_identity_and_context_consistency(self):
        for change in ("first_down", "ball_role", "scouting", "flags", "pre_event", "pre_gap"):
            data = dataset_fixture(); play = data["plays"][0]
            if change == "first_down": play["firstDown"] += 1
            elif change == "ball_role": play["players"][0]["role"] = "ball"
            elif change == "scouting": play["quality"]["scoutingMissingIds"] = [play["players"][0]["id"]]
            elif change == "flags": play["quality"]["flags"] = [None]
            elif change == "pre_event": play["preSnap"]["events"][0] = {}
            else:
                play["preSnap"]["frameIds"][0] -= 1
                play["preSnap"]["times"][0] -= .1
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_dataset(data)


if __name__ == "__main__":
    unittest.main()
