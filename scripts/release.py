"""Release a version (D-0136): the whole suite on this PC, then the tag.

    python scripts/release.py vX.Y.Z [--dry-run] [--publish]

Preconditions (exit 2 when one fails): the version is vMAJOR.MINOR.PATCH, newer than every v* tag
and equal to v<package.json version>; the working tree is clean; HEAD equals origin/main.

The suite is package.json's own "test" script, every test file, release-only ones included, with no
60 s ceiling. Its leading VAR=value words are set in the environment and the rest runs through the
local tsx, so the same words work from cmd.exe, PowerShell and a POSIX shell. A receipt (command,
counts, seconds, exit code) goes to <system temp>/release-receipts/<version>.json.

On pass the local annotated tag is made. school is a public repository, so a push and a GitHub
release speak publicly as Bdo (D-0134 high): the command stops after the local tag and prints the
brief he accepts, unless --publish is given. With --publish it pushes the tag, which starts
.github/workflows/release.yml, and creates the release as a draft, because release.yml reuses a
draft for the tag and refuses to touch one already published.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
SUMMARY_RE = re.compile(r"^(?:\S+\s+)?(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$")
PUBLIC = True


def git(*args: str) -> tuple[int, str]:
    done = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)
    return done.returncode, (done.stdout if done.returncode == 0 else done.stderr).strip()


def parse_version(text: str) -> tuple[int, int, int] | None:
    m = VERSION_RE.match(text)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def suite_command() -> tuple[dict[str, str], list[str], str]:
    """package.json's test script split into its env assignments and an argv that runs it here."""
    script = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]["test"]
    words = shlex.split(script)
    env: dict[str, str] = {}
    while words and ASSIGN_RE.match(words[0]):
        key, _, value = words.pop(0).partition("=")
        env[key] = value
    if not words or words[0] != "tsx":
        raise ValueError(f"package.json test script is not a tsx command: {script}")
    tsx = ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    return env, ["node", str(tsx), *words[1:]], script


def preconditions(version: str) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []
    parsed = parse_version(version)
    checks.append(("version is vMAJOR.MINOR.PATCH", parsed is not None, version))
    _, tags_out = git("tag", "-l", "v*")
    tags = [t for t in tags_out.splitlines() if parse_version(t)]
    newest = max(tags, key=parse_version, default=None)  # type: ignore[arg-type]
    newer = parsed is not None and (newest is None or parsed > parse_version(newest))
    checks.append(("newer than every v* tag", newer, f"newest tag {newest or 'none'}"))
    declared = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version")
    checks.append(("equals package.json version", version == f"v{declared}", f"package.json v{declared}"))
    code, status = git("status", "--porcelain")
    checks.append(("working tree is clean", code == 0 and status == "", status.splitlines()[0] if status else "clean"))
    _, head = git("rev-parse", "HEAD")
    code, remote = git("rev-parse", "origin/main")
    checks.append(("HEAD equals origin/main", code == 0 and head == remote,
                   f"HEAD {head[:9]}, origin/main {remote[:9] if code == 0 else 'missing'}"))
    tsx = ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    checks.append(("node_modules/tsx is installed (npm ci)", tsx.exists(), str(tsx.relative_to(ROOT))))
    return checks


def run_suite(version: str) -> tuple[int, Path, dict]:
    env_add, argv, script = suite_command()
    env = dict(os.environ, **env_add)
    print(f"release: running the whole suite: {script}")
    start = time.monotonic()
    proc = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    counts: dict[str, float] = {}
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(line)
        m = SUMMARY_RE.match(line.strip())
        if m:
            counts[m.group(1)] = float(m.group(2))
    code = proc.wait()
    seconds = round(time.monotonic() - start, 1)
    receipt = {
        "command": script,
        "argv": argv,
        "env": env_add,
        "counts": {k: int(v) for k, v in counts.items() if k != "duration_ms"},
        "seconds": seconds,
        "exit_code": code,
        "version": version,
        "head": git("rev-parse", "HEAD")[1],
    }
    folder = Path(tempfile.gettempdir()) / "release-receipts"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{version}.json"
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    return code, path, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Whole suite on this PC, then the release tag.")
    parser.add_argument("version", help="vMAJOR.MINOR.PATCH, equal to package.json's version")
    parser.add_argument("--dry-run", action="store_true", help="print preconditions and steps, run nothing")
    parser.add_argument("--publish", action="store_true", help="also push the tag and create the release")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    version = args.version
    try:
        checks = preconditions(version)
        _, _, script = suite_command()
    except (OSError, ValueError, KeyError) as exc:
        print(f"release: refused: {exc}")
        return 2
    ok = all(holds for _, holds, _ in checks)
    for name, holds, detail in checks:
        print(f"  [{'ok' if holds else 'NO'}] {name} ({detail})")
    publish = args.publish or not PUBLIC
    steps = [f"run the whole suite: {script}",
             f"write {Path(tempfile.gettempdir()) / 'release-receipts' / (version + '.json')}",
             f'git tag -a {version} -m "{version}: whole suite passed on this PC"']
    if publish:
        steps += [f"git push origin {version}",
                  f"gh release create {version} --verify-tag --draft --generate-notes --notes-file <receipt summary>"]
    else:
        steps.append("stop and print the brief: push the tag and publish the release (public repository)")
    if args.dry_run:
        print(f"release: dry run of {version}; the real run would {'proceed' if ok else 'refuse (exit 2)'}")
        for number, step in enumerate(steps, 1):
            print(f"  step {number}: {step}")
        print("release: dry run, nothing run")
        return 0
    if not ok:
        print("release: refused: a precondition does not hold")
        return 2
    code, receipt_path, receipt = run_suite(version)
    print(f"release: receipt {receipt_path}")
    if code != 0:
        print(f"release: whole suite failed (exit {code}) in {receipt['seconds']} s; no tag")
        return 1
    summary = (f"{version}: whole suite passed on this PC: {receipt['counts'].get('pass', '?')} passed, "
               f"{receipt['counts'].get('fail', 0)} failed in {receipt['seconds']} s ({script})")
    tag_code, tag_out = git("tag", "-a", version, "-m", f"{version}: whole suite passed on this PC")
    if tag_code != 0:
        print(f"release: git tag failed: {tag_out}")
        return 1
    print(f"release: tagged {version} locally. {summary}")
    if not publish:
        print(f"release: brief for Bdo: push {version} and publish the release")
        return 0
    push_code, push_out = git("push", "origin", version)
    if push_code != 0:
        print(f"release: git push failed: {push_out}")
        return 1
    notes = receipt_path.with_suffix(".md")
    notes.write_text(summary + "\n", encoding="utf-8", newline="\n")
    done = subprocess.run(["gh", "release", "create", version, "--verify-tag", "--draft", "--generate-notes",
                           "--notes-file", str(notes)], cwd=ROOT, check=False)
    if done.returncode != 0:
        print(f"release: gh release create failed (exit {done.returncode}); the tag is pushed")
        return 1
    print(f"release: {version} pushed; release.yml fills the draft and verifies it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
