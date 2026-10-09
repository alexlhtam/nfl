"""Independent raw-source audit tests; full CSV audits run when caches exist."""
import copy
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
from data_pipeline import build_play
from test_metrics import synthetic_play_inputs
from tools.audit_source import Checks, audit_dataset, audit_exclusion, audit_play, reference_point, verify_sources


def fixture():
    source, game, rows, details, scouting = synthetic_play_inputs()
    game.update(season="2021", week="1", gameDate="09/09/2021")
    for row in rows:
        row.update(a="0.17", dis="0.1")
    play = build_play(source, game, rows, details, scouting)
    frames = defaultdict(list)
    for row in rows:
        frames[int(row["frameId"])].append(row)
    return play, source, game, frames, details, scouting


class SourceAuditTests(unittest.TestCase):
    def test_decimal_reference_rotation_retains_motion_and_outside_field(self):
        row = {"team":"OFF", "playDirection":"left", "x":"80.31", "y":"-0.67",
               "s":"7.31", "dir":"271.25", "o":"350.2", "a":"1.17", "dis":"0.73"}
        self.assertEqual(reference_point(row), [39.69,53.97,7.31,91.25,170.2,1.17,.73])
        row.update(team="football", s="NA", dir="NA", o="NA", a="NA", dis="NA")
        self.assertEqual(reference_point(row), [39.69,53.97,0,0,0,None,None])

    def test_full_synthetic_source_parity_including_pre_snap(self):
        checks = Checks()
        audit_play(*fixture(), checks)
        self.assertEqual(checks.counts["plays"], 1)
        self.assertEqual(checks.counts["replayRows"], 69)
        self.assertEqual(checks.counts["preSnapRows"], 23)
        self.assertEqual(checks.counts["replayTrackValues"], 69*7)
        self.assertEqual(checks.counts["separationValues"], 15)

    def test_detects_kinematic_drift_even_when_geometry_unchanged(self):
        for field in (2,3,4,5,6):
            args = fixture()
            args[0]["players"][0]["track"][1][field] += .01
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "source difference"):
                audit_play(*args, Checks())

    def test_detects_pre_snap_and_context_corruption(self):
        for change in ("pre_snap", "score", "penalty", "quality", "exclusion", "role"):
            args = fixture(); play = args[0]
            if change == "pre_snap": play["preSnap"]["players"][0]["track"][0][5] = 99
            elif change == "score": play["context"]["homeScore"] = 7
            elif change == "penalty": play["penalty"]["nullified"] = True
            elif change == "quality": play["quality"]["fieldAmbiguity"]["frameCount"] = 4
            elif change == "exclusion": play["quality"]["preSnapExcludedFrames"] = [8]
            else: play["players"][0]["role"] = "block"
            with self.subTest(change=change), self.assertRaises(ValueError):
                audit_play(*args, Checks())

    def test_manifest_expected_hash_is_not_derived_from_corrupt_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"games.csv"; path.write_bytes(b"original")
            expected = hashlib.sha256(b"original").hexdigest()
            manifest = {"sourceRevision":"abc", "sourceUrl":"https://github.com/o/r", "files":{"games.csv":{"sha256":expected, "bytes":8}}}
            record = {"path":"games.csv", "sha256":expected, "bytes":8,
                      "verification":"verified", "sourceUrl":"https://raw.githubusercontent.com/o/r/abc/data/games.csv"}
            provenance = {"sourceRevision":"abc", "sourceVerification":"verified_manifest", "files":[record]}
            verify_sources(provenance, manifest, [Path(tmp)], ["games.csv"], Checks())
            path.write_bytes(b"tampered")
            # Even a forged provenance matching observed bytes cannot replace
            # the independently stored expected hash in the source manifest.
            provenance["files"][0]["sha256"] = hashlib.sha256(b"tampered").hexdigest()
            with self.assertRaisesRegex(ValueError, "manifest SHA-256"):
                verify_sources(provenance, manifest, [Path(tmp)], ["games.csv"], Checks())
            self.assertEqual(manifest["files"]["games.csv"]["sha256"], expected)

    def test_exclusions_require_actual_raw_evidence_and_known_reason(self):
        args = fixture(); source, frames = args[1], args[3]
        for reason in ("missing ball_snap", "missing pass_forward on passing play", "unsupported reason"):
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                audit_exclusion("fixture", reason, source, frames)
        audit_exclusion("fixture", "missing ball_snap", source, {})
        audit_exclusion("fixture", "missing pass_forward on passing play", source, {})

    def test_full_raw_audit_when_original_source_is_available(self):
        source = ROOT.parent / "data-audit"
        if not (source / "tracking_2021090900.csv").is_file():
            self.skipTest("Optional original CSV cache absent; run tools/audit_source.py when available")
        report = audit_dataset(ROOT/"data/demo.json", [source])
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["counts"]["plays"], 169)
        self.assertEqual(report["counts"]["excludedPlays"], 2)

    def test_full_raw_audit_when_additional_source_is_available(self):
        source = ROOT/"cache"
        if not list(source.glob("*/tracking/tracking_2021091200.csv")):
            self.skipTest("Optional additional CSV cache absent; run tools/audit_source.py when available")
        report = audit_dataset(ROOT/"data/packs/week-1-additional/demo.json", [source])
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["counts"]["plays"], 152)
        self.assertEqual(report["counts"]["gitBlobHashes"], 2)


if __name__ == "__main__":
    unittest.main()
