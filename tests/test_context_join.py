import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("join_context", ROOT / "tools/join_context.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContextJoinTests(unittest.TestCase):
    def setUp(self):
        self.play = {"id": "2021090900_97", "homeTeam": "TB", "awayTeam": "DAL", "offense": "TB", "quarter": 1,
                     "players": [{"id": "44", "side": "offense"}]}
        self.row = {"old_game_id": "2021090900", "play_id": "97.0", "home_team": "TB", "away_team": "DAL", "posteam": "TB", "qtr": "1",
                    "receiver_player_id": "00-1", "receiver_player_name": "A.Player", "epa": "0.25"}

    def test_valid_target_requires_crosswalk_and_onfield_player(self):
        data, report = module.validated_join([self.play], [self.row], [{"gsis_id": "00-1", "nfl_id": "44"}])
        self.assertEqual(data[self.play["id"]]["targetId"], "44")
        self.assertEqual(report["targetMapped"], 1)

    def test_unmapped_target_is_not_guessed_by_name(self):
        data, report = module.validated_join([self.play], [self.row], [])
        self.assertIsNone(data[self.play["id"]]["targetId"])
        self.assertEqual(len(report["unresolvedTargets"]), 1)

    def test_team_mismatch_rejected(self):
        data, report = module.validated_join([self.play], [{**self.row, "home_team": "NYG"}], [])
        self.assertFalse(data)
        self.assertEqual(len(report["rejected"]), 1)

    def test_duplicate_keys_raise(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            module.validated_join([self.play], [self.row, self.row], [])

    def test_conflicting_crosswalk_raises(self):
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            module.validated_join([], [], [{"gsis_id": "00-1", "nfl_id": "44"}, {"gsis_id": "00-1", "nfl_id": "45"}])


if __name__ == "__main__":
    unittest.main()
