"""Run or export Open Field, a dependency-free NFL coaching replay tool.

Usage:
    python app.py
    python app.py --no-browser --port 8765
    python app.py --export submission/open-field.html
"""

from __future__ import annotations

import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
import threading
from urllib.parse import urlsplit
import webbrowser
import os
import tempfile

from schema import validate_dataset

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = ROOT / "data" / "demo.json"
TEMPLATE = ROOT / "web" / "index.html"
APP_VERSION = "2.1.0"
ASSETS = {"__STYLE__": "styles.css", "__METRICS_JS__": "metrics.js", "__SCHEMA_JS__": "schema.js",
          "__APP_JS__": "app.js", "__WORKSPACE_JS__": "workspace.js", "__SIDE_PROJECT_JS__": "side-project.js"}


def encode_json_for_html(data: dict) -> str:
    """Serialize real data without allowing source text to close a script tag."""
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return (encoded.replace("&", "\\u0026").replace("<", "\\u003c")
            .replace(">", "\\u003e").replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


def load_data(path: Path) -> dict:
    content = path.read_bytes()
    data = json.loads(content.decode("utf-8"))
    validate_dataset(data)
    provenance_path = path.with_name("provenance.json")
    if data["meta"].get("buildId"):
        if not provenance_path.is_file():
            raise ValueError("This dataset declares a buildId but its provenance.json is missing; supply the complete pack.")
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        if provenance.get("buildId") != data["meta"]["buildId"]:
            raise ValueError("Data and provenance belong to different builds; rebuild the complete pack.")
        if provenance.get("datasetSha256") != hashlib.sha256(content).hexdigest():
            raise ValueError("Dataset bytes do not match the provenance checksum; rebuild the complete pack.")
    context_path = ROOT / "data" / "outcome-context.json"
    verified_source = (data["meta"].get("sourceVerification") == "verified_manifest"
                       and data["meta"].get("sourceRevision") == "85da22eeff2f1d5be106faa9dfe06a1205f2defd")
    if context_path.is_file() and data["meta"].get("season") == 2021 and verified_source:
        context_content = context_path.read_bytes()
        context = json.loads(context_content)
        for play in data["plays"]:
            joined = context.get("plays", {}).get(play["id"])
            if joined:
                target = joined.get("targetId")
                if target and not any(player["id"] == target and player["side"] == "offense" for player in play["players"]):
                    continue
                play["outcomeContext"] = joined
        data["meta"]["outcomeContext"] = {"sha256": hashlib.sha256(context_content).hexdigest(), "sources": context.get("sources"), "report": context.get("report"), "playIndex": context.get("plays", {})}
    trusted_packs = []
    for pack_path in [ROOT / "data/demo.json", *sorted((ROOT / "data" / "packs").glob("*/demo.json"))]:
        pair_path = pack_path.with_name("provenance.json")
        if not pack_path.is_file() or not pair_path.is_file():
            continue
        provenance = json.loads(pair_path.read_text(encoding="utf-8"))
        digest = hashlib.sha256(pack_path.read_bytes()).hexdigest()
        if (provenance.get("sourceVerification") == "verified_manifest"
                and provenance.get("sourceRevision") == "85da22eeff2f1d5be106faa9dfe06a1205f2defd"
                and provenance.get("datasetSha256") == digest):
            trusted_packs.append({"sha256": digest, "buildId": provenance.get("buildId"),
                                  "path": pack_path.relative_to(ROOT).as_posix()})
    if trusted_packs:
        data["meta"]["trustedGamePacks"] = trusted_packs
    data["meta"]["datasetSha256"] = hashlib.sha256(content).hexdigest()
    return data


def side_project_bundle() -> tuple[dict, dict[str, bytes]]:
    """Read the local presentation bundle; return browser payload and hash inputs."""
    folder = (ROOT / "web" / "side-projects" / "fruit-fly-in-the-pocket").resolve()

    def read_required(path: Path) -> bytes:
        try:
            content = path.read_bytes()
        except FileNotFoundError as error:
            raise ValueError(f"Required side-project asset is missing: {path.name}") from error
        if not content:
            raise ValueError(f"Required side-project asset is empty: {path.name}")
        return content

    metadata_bytes = read_required(folder / "project.json")
    metadata = json.loads(metadata_bytes.decode("utf-8"))
    if not isinstance(metadata, dict):
        raise ValueError("Side-project project.json must contain an object.")
    for key in ("title", "description", "summary"):
        if not isinstance(metadata.get(key), str) or not metadata[key].strip():
            raise ValueError(f"Side-project {key} must be a nonempty string.")
    if type(metadata.get("slideCount")) is not int or metadata["slideCount"] < 1:
        raise ValueError("Side-project slideCount must be a positive integer.")
    if not isinstance(metadata.get("sections"), list) or any(
        not isinstance(section, dict) or any(not isinstance(section.get(key), str) for key in ("title", "description"))
        for section in metadata["sections"]
    ):
        raise ValueError("Side-project sections must contain title and description strings.")
    if "previewCaption" in metadata and not isinstance(metadata["previewCaption"], str):
        raise ValueError("Side-project previewCaption must be a string.")
    assets = {"project.json": metadata_bytes}
    for key, extension in (("presentation", ".pptx"), ("preview", ".png")):
        name = metadata.get(key)
        if (not isinstance(name, str) or not name or any(character in name for character in ("/", "\\", ":"))
                or Path(name).suffix.lower() != extension):
            raise ValueError(f"Side-project {key} must name a local {extension} file within its asset folder.")
        path = (folder / name).resolve()
        if not path.is_relative_to(folder):
            raise ValueError(f"Side-project {key} resolves outside its asset folder.")
        assets[name] = read_required(path)
    presentation, preview = assets[metadata["presentation"]], assets[metadata["preview"]]
    payload = {**metadata,
               "presentationBase64": base64.b64encode(presentation).decode("ascii"),
               "presentationSha256": hashlib.sha256(presentation).hexdigest(),
               "previewDataUrl": "data:image/png;base64," + base64.b64encode(preview).decode("ascii")}
    return payload, assets


def render_html(data: dict, template_text: str | None = None) -> str:
    template = TEMPLATE.read_text(encoding="utf-8") if template_text is None else template_text
    side_project = None
    if template.count("__ROUTE_DATA__") != 1:
        raise ValueError("The app template must contain exactly one data placeholder.")
    if template_text is None:
        if template.count("__SIDE_PROJECT_DATA__") != 1:
            raise ValueError("The app template must contain exactly one side-project data placeholder.")
        digest = hashlib.sha256()
        for token, filename in ASSETS.items():
            if token not in template:
                continue
            content = (ROOT / "web" / "src" / filename).read_text(encoding="utf-8")
            digest.update(filename.encode() + b"\0" + content.encode())
            # The maintained sources are embedded verbatim, never fetched at runtime.
            if filename.endswith(".js") and "</script" in content.lower():
                raise ValueError(f"Unsafe script terminator in source asset: {filename}")
            template = template.replace(token, content)
        side_project, side_assets = side_project_bundle()
        for filename, content in sorted(side_assets.items()):
            digest.update(("side-project/" + filename).encode() + b"\0" + content)
        data = {**data, "meta": {**data.get("meta", {}), "application": {
            "version": APP_VERSION, "sourceHash": digest.hexdigest(),
            "metricVersion": "2.0.0", "validation": "technical; no participant study"}}}
    replacements = {"__ROUTE_DATA__": encode_json_for_html(data)}
    if side_project is not None:
        replacements["__SIDE_PROJECT_DATA__"] = encode_json_for_html(side_project)
    # One substitution pass preserves literal placeholder text inside payloads.
    return re.sub("|".join(map(re.escape, replacements)), lambda match: replacements[match.group()], template)


def atomic_write_text(path: Path, content: str) -> None:
    """Replace an export only once a complete UTF-8 document has been flushed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=".open-field-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def make_handler(html: str, data: dict):
    document = html.encode("utf-8")
    health = json.dumps({"status": "ok", "schemaVersion": 1,
                         "playCount": len(data["plays"]),
                         "season": data["meta"].get("season")}).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            if path in ("/", "/index.html"):
                body, mime, status = document, "text/html; charset=utf-8", 200
            elif path == "/health":
                body, mime, status = health, "application/json; charset=utf-8", 200
            elif path == "/favicon.ico":
                body, mime, status = b"", "image/x-icon", 204
            else:
                body, mime, status = b"Not found", "text/plain; charset=utf-8", 404
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            # Keep the hackathon launch terminal quiet; failed requests remain visible.
            if len(args) > 1 and str(args[1]) not in ("200", "204"):
                super().log_message(format, *args)

    return Handler


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Open Field: coverage-space and route-timing replay")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="Prepared dataset JSON")
    parser.add_argument("--export", type=Path, metavar="HTML", help="Write a complete offline HTML app and exit")
    parser.add_argument("--port", type=int, default=8765, help="Local server port (0 chooses a free port)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; local computer by default")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open a browser")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    try:
        data = load_data(args.data)
        html = render_html(data)
        if args.export:
            atomic_write_text(args.export, html)
            print(f"Exported {len(data['plays'])} plays to {args.export.resolve()}")
            return 0
        server = ThreadingHTTPServer((args.host, args.port), make_handler(html, data))
    except (OSError, ValueError, KeyError) as exc:
        print(f"Open Field could not start: {exc}", file=sys.stderr)
        if isinstance(exc, FileNotFoundError):
            print("Prepare data with: python data_pipeline.py --output data/demo.json", file=sys.stderr)
        return 1
    host, port = server.server_address[:2]
    url = f"http://{host}:{port}"
    print(f"Open Field is ready: {url}", flush=True)
    print(f"{len(data['plays'])} plays | {data['meta'].get('season', 'Unknown')} season | Ctrl+C to stop", flush=True)
    if not args.no_browser:
        timer = threading.Timer(0.6, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nOpen Field stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
