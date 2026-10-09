"""Build a versioned offline release from this checkout using standard Python.

Run verification separately before publishing: this command packages evidence;
it never turns an unverified feature into a verified requirement.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import APP_VERSION, atomic_write_text, load_data, render_html

ROOT_FILES = ["app.py", "data_pipeline.py", "metrics.py", "schema.py", "README.md", "GUIDE.md", "VALIDATION.md", "requirements.txt", "package.json", "package-lock.json", ".gitignore", ".gitattributes"]
DIRECTORIES = ["web", "data", "docs", "tools", "tests", "research", ".github"]


def source_files():
    paths = [ROOT / name for name in ROOT_FILES if (ROOT / name).is_file()]
    for folder in DIRECTORIES:
        for path in (ROOT / folder).rglob("*"):
            if path.is_file() and not any(part in {"__pycache__", "node_modules", "qa", "recordings"} for part in path.parts) and path.suffix not in {".pyc", ".tmp", ".webm"}:
                paths.append(path)
    return sorted(set(paths), key=lambda path: path.relative_to(ROOT).as_posix())


def git_metadata():
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True))
        return {"commit": commit, "uncommittedChanges": dirty}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "uncommittedChanges": None}


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    data = load_data(ROOT / "data/demo.json")
    html = render_html(data)
    atomic_write_text(output / "Open-Field.html", html)
    payload = {path.relative_to(ROOT).as_posix(): path.read_bytes() for path in source_files()}
    payload["submission/Open-Field.html"] = html.encode("utf-8")
    payload["submission/START-HERE.txt"] = (
        "Open Field / Coverage Lift\n\n"
        "Open Open-Field.html in a current browser for the complete offline tool.\n"
        "Or, from the parent folder, run: python app.py\n"
        "For extra games use Review > Data and practice > Open a game pack, selecting\n"
        "data/packs/week-1-additional/demo.json from this archive.\n"
        "Working Python, full metric definitions, tests, and the five-sentence README\n"
        "are included in the parent folder. Coach notes and drawings can be exported\n"
        "as a portable workspace; no account or network is needed.\n"
        "The statistic is experimental and geometric, not causal decoy credit.\n"
        "Validation is technical; no participant study has been performed.\n"
    ).encode()
    manifest = {
        "applicationVersion": APP_VERSION, "metricVersion": "2.0.0", "git": git_metadata(),
        "dataset": {"season": data["meta"]["season"], "playCount": len(data["plays"]), "sourceRevision": data["meta"].get("sourceRevision"), "buildId": data["meta"].get("buildId")},
        "validation": "See VALIDATION.md and machine-readable reports; no human participant study.",
        "files": {name: {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()} for name, content in sorted(payload.items())},
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    atomic_write_text(output / "manifest.json", manifest_bytes.decode())
    payload["submission/manifest.json"] = manifest_bytes
    archive = output / f"Open-Field-{APP_VERSION}.zip"
    temporary = archive.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, content in sorted(payload.items()):
            info = zipfile.ZipInfo("Open-Field/" + name, date_time=(2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            bundle.writestr(info, content)
    with zipfile.ZipFile(temporary) as bundle:
        if bundle.testzip() is not None:
            raise ValueError("Archive integrity check failed")
    temporary.replace(archive)
    for name in ("open-field.png", "comparison.png"):
        if (ROOT / "docs" / name).is_file():
            shutil.copyfile(ROOT / "docs" / name, output / name)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    atomic_write_text(output / "SHA256SUMS.txt", f"{checksum}  {archive.name}\n")
    print(json.dumps({"archive": str(archive.resolve()), "bytes": archive.stat().st_size, "sha256": checksum, "files": len(payload), "git": manifest["git"]}, indent=2))
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "submission")
    build(parser.parse_args().output)
