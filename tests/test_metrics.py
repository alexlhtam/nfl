"""Numerical and data-window checks, independently recomputing shipped metrics."""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from data_pipeline import build_play, normalize_point, separation_metrics


class NormalizationTests(unittest.TestCase):
    def test_left_play_is_a_rotation_including_both_angles(self):
        # A player moving left (270 degrees in the source convention) must move
        # right after normalization; a y reflection alone would be incorrect.
        x, y, heading, body = normalize_point(80, 10, 270, 350, "left")
        self.assertEqual(x, 40)
        self.assertAlmostEqual(y, 43.3)
        self.assertEqual(heading, 90)
        self.assertEqual(body, 170)

    def test_normalization_preserves_pairwise_distance_and_velocity(self):
        original_a = (19.25, -0.5, 212.0, 24.0)
        original_b = (31.5, 53.35, 81.0, 125.0)
        a = normalize_point(*original_a, "left")
        b = normalize_point(*original_b, "left")
        self.assertAlmostEqual(math.dist(a[:2], b[:2]),
                               math.dist(original_a[:2], original_b[:2]))
        for angle, transformed in ((original_a[2], a[2]), (original_a[3], a[3])):
            self.assertAlmostEqual(math.sin(math.radians(transformed)),
                                   -math.sin(math.radians(angle)))
            self.assertAlmostEqual(math.cos(math.radians(transformed)),
                                   -math.cos(math.radians(angle)))
        # Legitimate positions outside the sidelines must not be clamped.
        self.assertGreater(a[1], 53.3)
        self.assertLess(b[1], 0)

    def test_right_play_retains_position_and_wraps_angles(self):
        self.assertEqual(normalize_point(20, 17, 450, -10, "right"),
                         (20.0, 17.0, 90.0, 350.0))

    def test_invalid_positions_or_direction_are_rejected(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_point(value, 0, 90, 90, "right")
        with self.assertRaises(ValueError):
            normalize_point(0, 0, 0, 0, "backwards")


class SeparationTests(unittest.TestCase):
    def test_pythagorean_distance_and_changing_nearest_defender(self):
        receiver = [[0, 0], [0, 0], [0, 0]]
        defenders = {"a": [[3, 4], [8, 6], [6, 8]],
                     "b": [[6, 8], [0, 2], [12, 5]]}
        metrics = separation_metrics(receiver, defenders)
        self.assertEqual(metrics["separation"], [5.0, 2.0, 10.0])
        self.assertEqual(metrics["nearestId"], ["a", "b", "a"])
        self.assertEqual(metrics["peakSeparation"], 10)
        self.assertEqual(metrics["separationAtEnd"], 10)
        self.assertEqual(metrics["totalOpenSeconds"], 0.1)
        self.assertEqual(metrics["longestOpenSeconds"], 0.1)

    def test_exact_threshold_and_endpoint_interval_accounting(self):
        # Five intervals, not six. Final frame is open but has no duration.
        distances = [3, 3, 2, 4, 4, 99]
        metrics = separation_metrics([[0, 0]] * 6,
                                     {"d": [[d, 0] for d in distances]}, fps=10)
        self.assertEqual(metrics["totalOpenSeconds"], 0.4)
        self.assertEqual(metrics["longestOpenSeconds"], 0.2)
        self.assertEqual(metrics["separationAtEnd"], 99)

    def test_one_frame_has_no_observed_duration(self):
        metrics = separation_metrics([[0, 0]], {"d": [[100, 0]]})
        self.assertEqual(metrics["totalOpenSeconds"], 0)
        self.assertEqual(metrics["longestOpenSeconds"], 0)

    def test_all_open_duration_equals_elapsed_time(self):
        metrics = separation_metrics([[0, 0]] * 11, {"d": [[5, 0]] * 11})
        self.assertEqual(metrics["totalOpenSeconds"], 1)
        self.assertEqual(metrics["longestOpenSeconds"], 1)

    def test_tied_defenders_are_deterministic(self):
        first = separation_metrics([[0, 0]], {"b": [[3, 4]], "a": [[-3, 4]]})
        second = separation_metrics([[0, 0]], {"a": [[-3, 4]], "b": [[3, 4]]})
        self.assertEqual(first, second)
        self.assertEqual(first["nearestId"], ["a"])

    def test_invalid_tracks_do_not_silently_produce_metrics(self):
        invalid = [([], {"d": [[1, 1]]}, {}),
                   ([[0, 0]], {}, {}),
                   ([[0, 0]], {"d": [[1, 1], [2, 2]]}, {}),
                   ([[0, 0]], {"d": [[float("nan"), 0]]}, {}),
                   ([[0, 0]], {"d": [[1, 1]]}, {"fps": 0}),
                   ([[0, 0]], {"d": [[1, 1]]}, {"threshold": -1})]
        for receiver, defenders, kwargs in invalid:
            with self.subTest(receiver=receiver, kwargs=kwargs), self.assertRaises(ValueError):
                separation_metrics(receiver, defenders, **kwargs)


def synthetic_play_inputs():
    """A complete 23-entity play with known pre-snap and post-release frames."""
    play = {"gameId": "2021090900", "playId": "1", "possessionTeam": "OFF",
            "defensiveTeam": "DEF", "passResult": "C", "absoluteYardlineNumber": "35",
            "yardsToGo": "10", "quarter": "1", "gameClock": "12:00", "down": "1",
            "offenseFormation": "SHOTGUN", "pff_passCoverage": "Cover-2",
            "pff_passCoverageType": "Zone", "playDescription": "Synthetic fixture",
            "playResult": "7"}
    game = {"homeTeamAbbr": "OFF", "visitorTeamAbbr": "DEF"}
    scout = {}
    for index in range(1, 23):
        role = ("Pass Route" if index <= 5 else "Pass Block" if index <= 10
                else "Pass" if index == 11 else "Coverage" if index <= 17 else "Pass Rush")
        scout[str(index)] = {"pff_role": role, "pff_positionLinedUp": "WR"}
    tracking = []
    for frame in range(9, 14):
        event = {10: "ball_snap", 12: "pass_forward", 13: "pass_outcome_caught"}.get(frame, "None")
        for index in range(1, 24):
            team = "OFF" if index <= 11 else "DEF" if index <= 22 else "football"
            tracking.append({"gameId": play["gameId"], "playId": "1", "frameId": str(frame),
                             "nflId": str(index) if index < 23 else "NA", "team": team,
                             "event": event, "x": str(20 + index + frame / 10),
                             "y": str(index), "s": "1", "dir": "90", "o": "90",
                             "playDirection": "right", "jerseyNumber": str(index)})
    return play, game, tracking, {}, scout


class FrameWindowTests(unittest.TestCase):
    def test_replay_contains_snap_to_release_only(self):
        result = build_play(*synthetic_play_inputs())
        self.assertEqual(result["frameIds"], [10, 11, 12])
        self.assertEqual(result["times"], [0, 0.1, 0.2])
        self.assertEqual(result["events"], ["ball_snap", "", "pass_forward"])
        self.assertEqual(result["endpointLabel"], "Pass release")
        self.assertEqual(len(result["players"]), 23)
        self.assertTrue(all(len(p["track"]) == 3 for p in result["players"]))

    def test_missing_entity_or_duplicate_is_rejected(self):
        for change in ("missing", "duplicate"):
            args = list(synthetic_play_inputs())
            target = next(r for r in args[2] if r["frameId"] == "11")
            if change == "missing":
                args[2].remove(target)
            else:
                args[2].append(copy.deepcopy(target))
            with self.subTest(change=change), self.assertRaises(ValueError):
                build_play(*args)

    def test_missing_interior_frame_is_rejected(self):
        args = list(synthetic_play_inputs())
        args[2] = [r for r in args[2] if r["frameId"] != "11"]
        with self.assertRaises(ValueError):
            build_play(*args)

    def test_passing_play_without_release_is_rejected(self):
        args = list(synthetic_play_inputs())
        for row in args[2]:
            if row["event"] == "pass_forward":
                row["event"] = "None"
        with self.assertRaises(ValueError):
            build_play(*args)

    def test_sack_endpoint_is_explicitly_distinguished_from_release(self):
        args = list(synthetic_play_inputs())
        args[0]["passResult"] = "S"
        for row in args[2]:
            if row["event"] in {"pass_forward", "pass_outcome_caught"}:
                row["event"] = "None"
        result = build_play(*args)
        self.assertEqual(result["frameIds"], [10, 11, 12, 13])
        self.assertEqual(result["endpointLabel"], "Observed endpoint (sack)")


class BundledDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / "data/demo.json").read_text(encoding="utf-8"))
        cls.provenance = json.loads((ROOT / "data/provenance.json").read_text(encoding="utf-8"))

    def test_actual_source_is_consistently_labelled_2021(self):
        self.assertEqual(self.data["meta"]["season"], 2021)
        self.assertEqual(self.provenance["sourceSeason"], 2021)
        self.assertEqual(self.data["meta"]["sourceRevision"], self.provenance["sourceRevision"])
        self.assertEqual(self.data["meta"]["playCount"], len(self.data["plays"]))
        self.assertEqual(self.provenance["includedPlayCount"], len(self.data["plays"]))
        self.assertGreater(len(self.data["plays"]), 100)
        self.assertEqual(self.provenance["selectedPlayCount"],
                         len(self.data["plays"]) + len(self.provenance["excludedPlays"]))
        self.assertEqual({p["gameId"] for p in self.data["plays"]}, {2021090900, 2021110100})
        for source in self.provenance["files"]:
            self.assertRegex(source["sha256"], r"^[a-f0-9]{64}$")
            self.assertIn(self.provenance["sourceRevision"], source["sourceUrl"])

    def test_every_frame_has_22_players_plus_ball_and_stops_at_endpoint(self):
        for play in self.data["plays"]:
            with self.subTest(play=play["id"]):
                size = len(play["times"])
                self.assertGreater(size, 1)
                self.assertEqual(len(play["players"]), 23)
                self.assertEqual(len({p["id"] for p in play["players"]}), 23)
                self.assertEqual(sum(p["side"] == "offense" for p in play["players"]), 11)
                self.assertEqual(sum(p["side"] == "defense" for p in play["players"]), 11)
                self.assertEqual(sum(p["side"] == "ball" for p in play["players"]), 1)
                self.assertEqual(play["times"], [round(i / 10, 3) for i in range(size)])
                self.assertEqual(play["frameIds"], list(range(play["frameIds"][0], play["frameIds"][0] + size)))
                self.assertEqual(play["events"][0], "ball_snap")
                self.assertNotIn("pass_forward", play["events"][:-1])
                if play["endpointLabel"] == "Pass release":
                    self.assertEqual(play["events"][-1], "pass_forward")
                else:
                    self.assertIn(play["result"], {"S", "R"})
                for player in play["players"]:
                    self.assertEqual(len(player["track"]), size)
                    for row in player["track"]:
                        self.assertIn(len(row), (5, 6, 7))
                        self.assertTrue(all(value is None and i >= 5 or value is not None and math.isfinite(value) for i, value in enumerate(row)))
                        self.assertGreaterEqual(row[2], 0)
                        self.assertTrue(0 <= row[3] < 360 and 0 <= row[4] < 360)

    def test_every_bundled_receiver_metric_matches_independent_geometry(self):
        # Do not call the production metric function here. Independently check
        # its entire real output, using squared distances and elapsed intervals.
        checked = 0
        for play in self.data["plays"]:
            players = {player["id"]: player for player in play["players"]}
            defenders = [player for player in players.values()
                         if player["side"] == "defense" and player["role"] == "coverage"]
            for metric in play["metrics"]["receivers"]:
                receiver = players[metric["id"]]
                self.assertEqual(receiver["role"], "route")
                self.assertEqual(receiver["side"], "offense")
                expected_distances, expected_ids = [], []
                for frame, point in enumerate(receiver["track"]):
                    squared, player_id = min(
                        (((point[0] - defender["track"][frame][0]) ** 2
                          + (point[1] - defender["track"][frame][1]) ** 2), defender["id"])
                        for defender in defenders)
                    expected_distances.append(math.sqrt(squared))
                    expected_ids.append(player_id)
                with self.subTest(play=play["id"], receiver=metric["id"]):
                    for actual, expected in zip(metric["separation"], expected_distances):
                        self.assertAlmostEqual(actual, expected, places=12)
                    self.assertEqual(metric["nearestId"], expected_ids)
                    self.assertAlmostEqual(metric["peakSeparation"], max(expected_distances), places=12)
                    self.assertAlmostEqual(metric["separationAtEnd"], expected_distances[-1], places=12)
                    durations = [play["times"][i + 1] - play["times"][i]
                                 for i, distance in enumerate(expected_distances[:-1]) if distance >= 3]
                    self.assertAlmostEqual(metric["totalOpenSeconds"], sum(durations), places=3)
                    windows, start = [], None
                    for i, distance in enumerate(expected_distances[:-1]):
                        if distance >= 3 and start is None:
                            start = play["times"][i]
                        if distance < 3 and start is not None:
                            windows.append(play["times"][i] - start)
                            start = None
                    if start is not None:
                        windows.append(play["times"][-1] - start)
                    self.assertAlmostEqual(metric["longestOpenSeconds"], max(windows, default=0), places=3)
                    self.assertLessEqual(metric["totalOpenSeconds"], play["times"][-1])
                checked += 1
        self.assertGreater(checked, 500)


if __name__ == "__main__":
    unittest.main()
