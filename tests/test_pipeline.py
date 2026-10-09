"""CSV, provenance, field diagnostics and transactional publication checks."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
import data_pipeline as pipeline
from test_metrics import synthetic_play_inputs
from test_schema import dataset_fixture


class PipelineTests(unittest.TestCase):
    def test_csv_headers_rows_and_duplicate_keys(self):
        cases = ["a,a\n1,2\n", "a,b\n1\n", "a,b\n1,2,3\n", "a,b\n1,2\n1,3\n", "a,b\n,2\n"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.csv"
            for content in cases:
                path.write_text(content)
                with self.subTest(content=content), self.assertRaises(ValueError):
                    pipeline.load_csv(path, {"a", "b"}, ("a",))
            path.write_text("a,b\n1,2\n")
            self.assertEqual(pipeline.load_csv(path, {"a", "b"}, ("a",)), [{"a": "1", "b": "2"}])
            with self.assertRaisesRegex(ValueError, "missing headers"):
                pipeline.load_csv(path, {"a", "c"}, ("a",))

    def test_precision_does_not_move_a_sample_across_threshold(self):
        result = pipeline.separation_metrics([[0,0],[0,0]], {"d": [[2.9999,0],[3.0001,0]]})
        self.assertEqual(result["separation"], [2.9999,3.0001])
        self.assertEqual(result["totalOpenSeconds"], 0)

    def test_local_manifest_mismatch_is_reported_honestly(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "games.csv"; path.write_bytes(b"modified")
            with patch.object(pipeline, "source_manifest", return_value={"games.csv": {"sha256": hashlib.sha256(b"original").hexdigest()}}):
                self.assertEqual(pipeline.source_file("games.csv", Path(tmp), Path(tmp)), path)
                self.assertEqual(pipeline.verify_source(path, "games.csv"), "hash_mismatch")

    def test_revision_cache_rejects_corruption_and_refresh_retries(self):
        content = b"a,b\n1,2\n"; manifest = {"games.csv": {"sha256": hashlib.sha256(content).hexdigest()}}
        with tempfile.TemporaryDirectory() as tmp, patch.object(pipeline, "source_manifest", return_value=manifest):
            path = Path(tmp)/pipeline.SOURCE_REVISION/"games.csv"; path.parent.mkdir(); path.write_bytes(b"broken")
            with self.assertRaisesRegex(ValueError, "--refresh"):
                pipeline.source_file("games.csv", None, Path(tmp))
            with patch.object(pipeline.urllib.request, "urlopen", side_effect=[OSError("transient"), io.BytesIO(content)]) as network, patch.object(pipeline.time, "sleep"):
                result = pipeline.source_file("games.csv", None, Path(tmp), refresh=True)
            self.assertEqual(result, path); self.assertEqual(path.read_bytes(), content); self.assertEqual(network.call_count, 2)
            self.assertFalse(list(path.parent.glob("*.tmp")))

    def test_source_retry_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(pipeline, "source_manifest", return_value={}), patch.object(pipeline.urllib.request, "urlopen", side_effect=OSError("offline")) as network, patch.object(pipeline.time, "sleep"):
            with self.assertRaisesRegex(OSError, "could not retrieve"):
                pipeline.source_file("games.csv", None, Path(tmp), retries=2)
            self.assertEqual(network.call_count, 2)

    def test_metadata_penalties_pre_snap_and_missing_roles(self):
        args = list(synthetic_play_inputs())
        args[0].update(playDescription="PENALTY - No Play.", foulName1="Offensive Holding", foulNFLId1="4", penaltyYards="-10", prePenaltyPlayResult="7", personnelO="1 RB, 1 TE, 3 WR", pff_playAction="1")
        args[4].pop("12")
        result = pipeline.build_play(*args)
        self.assertTrue(result["penalty"]["nullified"]); self.assertTrue(result["penalty"]["hasPenalty"])
        self.assertEqual(result["penalty"]["yards"], -10)
        self.assertTrue(result["context"]["playAction"])
        self.assertEqual(result["preSnap"]["times"], [-.1])
        self.assertEqual(result["times"], [0,.1,.2])
        self.assertEqual(result["quality"]["scoutingMissingIds"], ["12"])
        self.assertIn("unknown_roles", result["quality"]["flags"])
        self.assertFalse(result["cohortEligible"])

    def test_sideline_and_trajectory_flags_preserve_observations(self):
        args = list(synthetic_play_inputs())
        row = next(r for r in args[2] if r["nflId"] == "1" and r["frameId"] == "11")
        row["y"] = "54"; row["s"] = "14"
        result = pipeline.build_play(*args)
        receiver = next(p for p in result["players"] if p["id"] == "1")
        self.assertEqual(receiver["track"][1][1], 54)
        self.assertEqual(receiver["fieldStatus"][1], "outside_field")
        self.assertIn("field_boundary", result["quality"]["flags"])
        self.assertIn("trajectory_flag", result["quality"]["flags"])

    def test_pair_rollback_and_interruption_detection(self):
        data = dataset_fixture(); data["meta"]["buildId"] = "new"; prov = {"buildId":"new"}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)/"demo.json"; other = out.with_name("provenance.json")
            out.write_bytes(b"old-data"); other.write_bytes(b"old-provenance")
            original_replace = pipeline.os.replace; calls = []
            def fail_second(src, dst):
                calls.append(str(dst))
                if len(calls) == 2: raise OSError("simulated second replacement failure")
                return original_replace(src, dst)
            with patch.object(pipeline.os, "replace", side_effect=fail_second), self.assertRaises(OSError):
                pipeline.write_json_pair(out, data, prov)
            self.assertEqual(out.read_bytes(), b"old-data"); self.assertEqual(other.read_bytes(), b"old-provenance")
            pipeline.write_json_pair(out, data, prov)
            self.assertEqual(pipeline.validate_output_pair(out)["meta"]["buildId"], "new")
            damaged = json.loads(other.read_text()); damaged["buildId"] = "old"; other.write_text(json.dumps(damaged))
            with self.assertRaisesRegex(ValueError, "buildId"):
                pipeline.validate_output_pair(out)

    def test_shipped_catalog_lists_source_games_without_embedding_tracking(self):
        catalog = json.loads((ROOT / "data/catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(catalog["gameCount"], 122)
        self.assertEqual(len(catalog["games"]), 122)
        self.assertEqual(len({game["gameId"] for game in catalog["games"]}), 122)
        self.assertTrue(all("players" not in game and "sourcePlayCount" in game for game in catalog["games"]))
        self.assertEqual(sum(game["sourcePlayCount"] for game in catalog["games"]), 8557)

    def test_additional_offline_pack_is_real_valid_and_separate(self):
        path = ROOT / "data/packs/week-1-additional/demo.json"
        data = pipeline.validate_output_pair(path)
        self.assertEqual({p["gameId"] for p in data["plays"]}, {2021091200, 2021091201})
        self.assertEqual({p["offense"] for p in data["plays"]}, {"ATL", "PHI", "BUF", "PIT"})
        self.assertGreater(len(data["plays"]), 100)
        self.assertEqual(data["meta"]["sourceVerification"], "verified_manifest")
        self.assertEqual(data["stories"], [])
        catalog = json.loads((ROOT / "data/catalog.json").read_text(encoding="utf-8"))
        entry = next(pack for pack in catalog["packs"] if pack["id"] == "week-1-additional")
        self.assertEqual(entry["sha256"], pipeline.file_digest(path))


if __name__ == "__main__":
    unittest.main()
