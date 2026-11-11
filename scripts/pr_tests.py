"""The tests a pull request runs (D-0136): only those its change touches, stopped at 60 s.

Same command locally, in .github/workflows/ci.yml and in the workstation's local verify.

Selection, for each changed file (committed since the merge base with --base, default origin/main,
plus uncommitted and untracked files):
  - a test file (tests/**/*.test.ts, *.test.tsx) runs itself;
  - any other file runs, by the repository's conventions, tests/<basename>.test.ts(x) (source
    modules), every test file that imports it directly (`from "../src/core/x.ts"`, `@/src/core/x`,
    `import("...")`) and every test whose source names it (fixtures, data, prompts, config);
  - failing those, the first glob in scripts/test_map.json that matches it;
  - failing that, nothing if it matches the map's "no_tests" globs (docs and images no test reads),
    else the map's "*" entry (a small smoke set), never the whole suite.
Only a change that is all "no_tests" runs nothing. Tests listed under "release_only" are never run
here (scripts/release.py runs them); if that drops every selected test, the smoke set runs instead.

The runner is the repository's own: `tsx --test` with NODE_ENV=test, as `npm test` runs it.
Exit 0 pass, 1 fail or over the ceiling, 2 refused before running.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

CEILING_S = 60.0
ROOT = Path(__file__).resolve().parent.parent
MAP_PATH = ROOT / "scripts" / "test_map.json"
TEST_DIR = "tests"
TEST_RE = re.compile(r"^tests/(?:.+/)?[^/]+\.test\.tsx?$")
SOURCE_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
IMPORT_RE = re.compile(r"""(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']""")


def refuse(message: str) -> int:
    print(f"pr-tests: refused: {message}")
    return 2


def git(*args: str) -> str:
    done = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout


def changed_files(base: str) -> list[str]:
    names: set[str] = set()
    names.update(git("diff", "--name-only", f"{base}...HEAD").splitlines())
    names.update(git("diff", "--name-only", "HEAD").splitlines())
    names.update(git("ls-files", "--others", "--exclude-standard").splitlines())
    return sorted(n.strip().replace("\\", "/") for n in names if n.strip())


def load_map() -> dict:
    data = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    if not isinstance(data.get("*"), list) or not data["*"]:
        raise ValueError(f'{MAP_PATH.name} needs a non-empty "*" smoke entry')
    return data


def all_tests() -> list[str]:
    found = []
    for path in (ROOT / TEST_DIR).rglob("*"):
        rel = path.relative_to(ROOT).as_posix()
        if path.is_file() and TEST_RE.match(rel) and "/fixtures/" not in rel:
            found.append(rel)
    return sorted(found)


def strip_ext(rel: str) -> str:
    for ext in SOURCE_EXT:
        if rel.endswith(ext):
            return rel[: -len(ext)]
    return rel


def import_index(tests: list[str]) -> dict[str, set[str]]:
    """Map each repo-relative module (extension stripped) to the test files that import it directly."""
    index: dict[str, set[str]] = {}
    for test in tests:
        text = (ROOT / test).read_text(encoding="utf-8", errors="replace")
        here = Path(test).parent
        for spec in IMPORT_RE.findall(text):
            if spec.startswith("@/"):
                target = Path(spec[2:])
            elif spec.startswith("."):
                target = here / spec
            else:
                continue
            rel = os.path.normpath(target.as_posix()).replace("\\", "/")
            index.setdefault(strip_ext(rel), set()).add(test)
            index.setdefault(rel, set()).add(test)
    return index


def table_globs(table: dict) -> list[str]:
    return [k for k in table if k not in ("*", "release_only", "no_tests") and not k.startswith("_")]


def matches(rel: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(rel, glob) for glob in globs)


def mention_hits(rel: str, texts: dict[str, str], name_counts: dict[str, int]) -> set[str]:
    """Tests whose source names the file: its path from the root or from tests/, or, for a file
    that is not a source module (data, fixture, prompt), its file name when no other tracked file
    has that name, or its fixture folder."""
    # A root file is named from tests/ as ../<name>; its bare name is too common to count.
    needles = {rel, strip_ext(rel)} if "/" in rel else {f"../{rel}", f"../{strip_ext(rel)}"}
    if rel.startswith("tests/"):
        needles |= {rel[len("tests/"):], strip_ext(rel[len("tests/"):])}
    if not rel.endswith(SOURCE_EXT) and name_counts.get(Path(rel).name, 0) <= 1:
        needles.add(Path(rel).name)
    parts = rel.split("/")
    if len(parts) > 3 and parts[:2] == ["tests", "fixtures"]:
        needles.add(parts[2])
    needles = {n for n in needles if len(n) > 3}
    return {test for test, text in texts.items() if any(f'"{n}' in text or f"'{n}" in text or f"/{n}" in text
                                                        for n in needles)}


def select(changed: list[str], table: dict, tests: list[str]) -> tuple[list[str], list[str]]:
    """Return (selected tests, one reason line per changed file that is not "no_tests")."""
    present = set(tests)
    by_name: dict[str, list[str]] = {}
    for test in tests:
        stem = re.sub(r"\.test\.tsx?$", "", Path(test).name)
        by_name.setdefault(stem, []).append(test)
    imports = import_index(tests)
    texts = {t: (ROOT / t).read_text(encoding="utf-8", errors="replace") for t in tests}
    no_tests = list(table.get("no_tests", []))
    name_counts: dict[str, int] = {}
    for tracked in git("ls-files").splitlines():
        name = tracked.rsplit("/", 1)[-1]
        name_counts[name] = name_counts.get(name, 0) + 1
    chosen: set[str] = set()
    reasons: list[str] = []
    for rel in changed:
        if TEST_RE.match(rel) and rel in present:
            chosen.add(rel)
            reasons.append(f"{rel}: itself")
            continue
        hits: set[str] = set()
        if (ROOT / rel).exists():
            stem = strip_ext(Path(rel).name)
            hits = set(by_name.get(stem, [])) if rel.endswith(SOURCE_EXT) else set()
            hits |= imports.get(strip_ext(rel), set()) | imports.get(rel, set()) | mention_hits(rel, texts, name_counts)
            hits.discard(rel)
        how = "convention"
        if not hits:
            for glob in table_globs(table):
                if fnmatch.fnmatchcase(rel, glob):
                    hits = {t for t in table[glob] if t in present}
                    how = f"table {glob}"
                    break
        if not hits and matches(rel, no_tests):
            continue
        if not hits:
            hits = {t for t in table["*"] if t in present}
            how = "smoke *"
        chosen |= hits
        reasons.append(f"{rel}: {how} -> {len(hits)}")
    return sorted(chosen), reasons


def kill_tree(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, check=False)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait()


def runner_argv(tests: list[str]) -> list[str]:
    tsx = ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    if not tsx.exists():
        raise FileNotFoundError("node_modules/tsx is missing; run npm ci first")
    return ["node", str(tsx), "--test", "--test-reporter=spec", *tests]


SUMMARY_RE = re.compile(r"^\S*\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$")


def run(tests: list[str]) -> int:
    argv = runner_argv(tests)
    env = dict(os.environ, NODE_ENV="test")
    kwargs: dict = {"cwd": ROOT, "env": env, "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT,
                    "text": True, "encoding": "utf-8", "errors": "replace"}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    start = time.monotonic()
    proc = subprocess.Popen(argv, **kwargs)
    lines: list[str] = []
    import threading

    def pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.append(line)
            sys.stdout.write(line)
            sys.stdout.flush()

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        proc.wait(timeout=CEILING_S)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        reader.join(timeout=5)
        print(f"over the 60 s pull-request ceiling: {len(tests)} test files ({' '.join(tests)}); "
              "move the slow test to the release suite")
        return 1
    reader.join(timeout=10)
    seconds = time.monotonic() - start
    counts = {}
    for line in lines:
        m = SUMMARY_RE.match(line.strip().lstrip("ℹ").strip())
        if m:
            counts[m.group(1)] = int(m.group(2))
    passed = counts.get("pass", 0)
    if proc.returncode != 0:
        print(f"pr-tests: {counts.get('fail', '?')} failed, {passed} passed in {seconds:.1f} s "
              f"(exit {proc.returncode})")
        return 1
    print(f"pr-tests: {passed} passed in {seconds:.1f} s")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="origin/main", help="git ref to diff against (default origin/main)")
    parser.add_argument("--dry-run", action="store_true", help="print the selection, run nothing")
    parser.add_argument("--list-all", action="store_true", help="print the whole suite and exit")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    try:
        table = load_map()
        tests = all_tests()
        if args.list_all:
            for test in tests:
                print(test)
            print(f"pr-tests: {len(tests)} test files in the whole suite (release_only: "
                  f"{len(table.get('release_only', []))})")
            return 0
        changed = changed_files(args.base)
    except (RuntimeError, ValueError, OSError) as exc:
        return refuse(str(exc))
    release_only = set(table.get("release_only", []))
    selected, reasons = select(changed, table, tests)
    left = sorted(set(selected) & release_only)
    selected = [t for t in selected if t not in release_only]
    print(f"pr-tests: {len(changed)} changed files against {args.base}; "
          f"{len(reasons)} need tests; {len(selected)} test files chosen")
    for reason in reasons:
        print(f"  {reason}")
    for test in left:
        print(f"  {test}: release-only, dropped here; python scripts/release.py runs it")
    if not reasons:
        print("pr-tests: every change matches no_tests; nothing to run")
        return 0
    if not selected:
        selected = [t for t in table["*"] if t in set(tests) and t not in release_only]
        print(f"  every selected test was dropped; running the smoke set * ({len(selected)} files)")
        if not selected:
            return refuse('the "*" smoke set has no runnable test')
    if args.dry_run:
        for test in selected:
            print(f"  would run {test}")
        print(f"pr-tests: dry run, {len(selected)} test files selected, none run")
        return 0
    try:
        return run(selected)
    except FileNotFoundError as exc:
        return refuse(str(exc))


if __name__ == "__main__":
    sys.exit(main())
