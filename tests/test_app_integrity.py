"""Pack integrity and source-scoped optional context, using local files only."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
import app
from test_schema import dataset_fixture

PINNED = "85da22eeff2f1d5be106faa9dfe06a1205f2defd"


class PackIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "pack" / "demo.json"
        self.path.parent.mkdir()
        self.data = dataset_fixture()
        self.data["meta"].update(season=2021, buildId="test-build", sourceRevision=PINNED,
                                 sourceVerification="verified_manifest")
        self.patch = patch.object(app, "ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write_pack(self, *, provenance=True, build_id="test-build", digest=None):
        content = json.dumps(self.data, allow_nan=False).encode("utf-8")
        self.path.write_bytes(content)
        if provenance:
            self.path.with_name("provenance.json").write_text(json.dumps({
                "buildId": build_id,
                "datasetSha256": digest or hashlib.sha256(content).hexdigest(),
            }), encoding="utf-8")

    def write_context(self, target=None):
        play = self.data["plays"][0]
        if target is None:
            target = next(p["id"] for p in play["players"] if p["role"] == "route")
        (self.root / "data").mkdir(exist_ok=True)
        (self.root / "data" / "outcome-context.json").write_text(json.dumps({
            "plays": {play["id"]: {"targetId": target, "sentinel": "context fixture"}},
            "report": {"purpose": "test"}, "sources": [],
        }), encoding="utf-8")

    def test_declared_build_requires_complete_pack(self):
        self.write_pack(provenance=False)
        with self.assertRaisesRegex(ValueError, "provenance"):
            app.load_data(self.path)

    def test_provenance_build_and_byte_digest_are_both_required(self):
        for build_id, digest, message in (("different", None, "different builds"),
                                          ("test-build", "0" * 64, "checksum")):
            with self.subTest(message=message):
                self.write_pack(build_id=build_id, digest=digest)
                with self.assertRaisesRegex(ValueError, message):
                    app.load_data(self.path)

    def test_valid_complete_pack_loads_without_mutation(self):
        self.write_pack()
        original = self.path.read_bytes()
        loaded = app.load_data(self.path)
        expected = copy.deepcopy(self.data)
        expected['meta']['datasetSha256'] = hashlib.sha256(original).hexdigest()
        self.assertEqual(loaded, expected)
        self.assertEqual(self.path.read_bytes(), original)

    def test_legacy_pack_without_build_identifier_remains_supported(self):
        self.data["meta"].pop("buildId")
        self.write_pack(provenance=False)
        expected = copy.deepcopy(self.data)
        expected['meta']['datasetSha256'] = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.assertEqual(app.load_data(self.path), expected)

    def test_only_verified_pinned_source_receives_external_context(self):
        self.write_context()
        for verification, revision in (("local_override", PINNED), ("unverified", PINNED),
                                       (None, PINNED), ("verified_manifest", "other-revision")):
            with self.subTest(verification=verification, revision=revision):
                self.data["meta"].update(sourceVerification=verification, sourceRevision=revision)
                self.write_pack()
                loaded = app.load_data(self.path)
                self.assertNotIn("outcomeContext", loaded["plays"][0])
                self.assertNotIn("outcomeContext", loaded["meta"])
        self.data["meta"].update(sourceVerification="verified_manifest", sourceRevision=PINNED)
        self.write_pack()
        loaded = app.load_data(self.path)
        self.assertEqual(loaded["plays"][0]["outcomeContext"]["sentinel"], "context fixture")
        self.assertIn("sha256", loaded["meta"]["outcomeContext"])

    def test_context_target_must_identify_an_offensive_player(self):
        defender = next(p["id"] for p in self.data["plays"][0]["players"] if p["side"] == "defense")
        for target in ("unknown-id", defender):
            with self.subTest(target=target):
                self.write_context(target)
                self.write_pack()
                self.assertNotIn("outcomeContext", app.load_data(self.path)["plays"][0])

    def test_failed_atomic_export_preserves_previous_output_and_cleans_temporary(self):
        destination = self.root / "coaching.html"
        destination.write_text("previous good export", encoding="utf-8")
        with patch.object(app.os, "replace", side_effect=OSError("simulated write failure")):
            with self.assertRaises(OSError):
                app.atomic_write_text(destination, "replacement export")
        self.assertEqual(destination.read_text(encoding="utf-8"), "previous good export")
        self.assertEqual(list(self.root.glob(".open-field-*")), [])


if __name__ == "__main__":
    unittest.main()
