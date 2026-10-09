"""Run or export Open Field, a dependency-free NFL coaching replay tool.

Usage:
    python app.py
    python app.py --no-browser --port 8765
    python app.py --export submission/open-field.html
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
from urllib.parse import urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = ROOT / "data" / "demo.json"
TEMPLATE = ROOT / "web" / "index.html"


def encode_json_for_html(data: dict) -> str:
    """Serialize real data without allowing source text to close a script tag."""
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return (encoded.replace("&", "\\u0026").replace("<", "\\u003c")
            .replace(">", "\\u003e").replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


def load_data(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("schemaVersion") != 1:
        raise ValueError("This app requires Open Field data schema version 1.")
    if not isinstance(data.get("plays"), list) or not data["plays"]:
        raise ValueError("The data file contains no plays. Build a dataset first.")
    if not isinstance(data.get("meta"), dict):
        raise ValueError("The data file is missing source metadata.")
    return data


def render_html(data: dict, template_text: str | None = None) -> str:
    template = TEMPLATE.read_text(encoding="utf-8") if template_text is None else template_text
    if template.count("__ROUTE_DATA__") != 1:
        raise ValueError("The app template must contain exactly one data placeholder.")
    return template.replace("__ROUTE_DATA__", encode_json_for_html(data))


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
            args.export.parent.mkdir(parents=True, exist_ok=True)
            args.export.write_text(html, encoding="utf-8")
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
