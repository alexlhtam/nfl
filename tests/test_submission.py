"""Submission checks: offline export, safe embedding, and actual HTTP startup."""
from __future__ import annotations

import importlib
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class HtmlEmbeddingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = importlib.import_module("app")

    def test_embedded_json_cannot_close_script_element(self):
        value = {"name": "</script><script>alert('injected')</script>",
                 "less": "A < B", "unicode": "coach\u2028route\u2029field"}
        encoded = self.app.encode_json_for_html(value)
        self.assertNotIn("<", encoded)
        self.assertEqual(json.loads(encoded), value)

    def test_template_replaces_data_and_preserves_json_values(self):
        value = {"label": "Robert's route", "values": [1.25, 0, None]}
        template = "<!doctype html><script>const DATA=__ROUTE_DATA__;</script>"
        result = self.app.render_html(value, template_text=template)
        self.assertNotIn("__ROUTE_DATA__", result)
        match = re.search(r"const DATA=(.*);</script>", result)
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match.group(1)), value)


class DeliveryTests(unittest.TestCase):
    def test_export_runs_without_network_or_external_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "coaching-tool.html"
            result = subprocess.run(
                [sys.executable, str(ROOT / "app.py"), "--export", str(destination)],
                cwd=ROOT, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(destination.is_file())
            html = destination.read_text(encoding="utf-8")
            self.assertGreater(len(html), 10000)
            self.assertNotIn("__ROUTE_DATA__", html)
            self.assertRegex(html.lower(), r"<!doctype html>")
            self.assertNotRegex(html, r"(?i)<script[^>]+\bsrc\s*=")
            self.assertNotRegex(html, r"(?i)<link[^>]+\brel\s*=\s*[\"']stylesheet")
            self.assertNotRegex(html, r"\bfetch\s*\(")

    def test_server_serves_working_app_and_health(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "app.py"), "--no-browser", "--port", str(port)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + 12
            health = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    out, err = process.communicate()
                    self.fail(f"Server exited during startup: {out} {err}")
                try:
                    with urlopen(base + "/health", timeout=0.5) as response:
                        health = json.load(response)
                    break
                except (URLError, TimeoutError, ConnectionError):
                    time.sleep(0.1)
            self.assertIsNotNone(health, "Server did not become ready")
            self.assertGreater(health["playCount"], 0)
            self.assertEqual(health["season"], 2021)
            self.assertIn("schemaVersion", health)
            with urlopen(base + "/", timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("text/html", response.headers["Content-Type"])
                html = response.read().decode("utf-8")
            self.assertNotIn("__ROUTE_DATA__", html)
            self.assertIn("<canvas", html)
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/missing-file", timeout=2)
            self.assertEqual(error.exception.code, 404)
        finally:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
