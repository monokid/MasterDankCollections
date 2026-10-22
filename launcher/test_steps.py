"""Checks on the launcher's checks. Run: python launcher/test_steps.py

Each test is named after what breaks if it regresses. They exercise the paths
that only happen on someone else's machine -- no project, no crawls, a stale or
corrupt catalogue, a taken port -- because those are exactly the ones nobody
hits while developing.
"""
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import steps
from steps import StepError

passed, failures = 0, []


def test(name):
    def deco(fn):
        global passed
        try:
            fn()
            passed += 1
        except AssertionError as e:
            failures.append(f"{name}\n    {e}")
        except Exception as e:
            failures.append(f"{name}\n    {type(e).__name__}: {e}")
    return deco


def fake_project(tmp: Path, *, crawls=1, catalog=True, tracks=3) -> Path:
    root = tmp / "proj"
    (root / "tools").mkdir(parents=True, exist_ok=True)
    (root / "data").mkdir(parents=True, exist_ok=True)
    (root / "public" / "data").mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text("{}", encoding="utf-8")
    (root / "tools" / "distill.ts").write_text("//", encoding="utf-8")
    for i in range(crawls):
        (root / "data" / f"mdc-crawl-x-{i}.json").write_text("{}", encoding="utf-8")
    if catalog:
        (root / "public" / "data" / "catalog.json").write_text(
            json.dumps({"tracks": [{"id": f"t{i}"} for i in range(tracks)],
                        "stats": {"tracks": tracks, "songs": tracks},
                        "events": []}), encoding="utf-8")
    return root


# ----------------------------------------------------------------- locating

@test("the project is found from the launcher subfolder, not just the root")
def _():
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td))
        (root / "launcher" / "dist").mkdir(parents=True)
        assert steps.find_root(root / "launcher") == root
        assert steps.find_root(root / "launcher" / "dist") == root
        assert steps.find_root(root) == root


@test("being somewhere else entirely says what to do about it")
def _():
    with tempfile.TemporaryDirectory() as td:
        try:
            steps.find_root(Path(td))
            assert False, "should have raised"
        except StepError as e:
            assert "Can't find the project" in e.message
            assert e.hint, "a failure with no hint is just an error message"


# ------------------------------------------------------------------- data

@test("a missing catalogue counts as stale")
def _():
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td), catalog=False)
        stale, why = steps.catalog_stale(root)
        assert stale and "no catalogue" in why, why


@test("a catalogue older than its crawl is stale")
def _():
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td))
        cat = steps.catalog_path(root)
        old = time.time() - 600
        os.utime(cat, (old, old))
        stale, why = steps.catalog_stale(root)
        assert stale and "newer than the catalogue" in why, why


@test("a catalogue newer than everything is left alone")
def _():
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td))
        future = time.time() + 60
        os.utime(steps.catalog_path(root), (future, future))
        stale, why = steps.catalog_stale(root)
        assert not stale, why


@test("a corrupt catalogue is rebuilt rather than served")
def _():
    # Serving it means the app loads and then fails with nothing to say.
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td))
        steps.catalog_path(root).write_text("{not json", encoding="utf-8")
        future = time.time() + 60
        os.utime(steps.catalog_path(root), (future, future))
        stale, why = steps.catalog_stale(root)
        assert stale and "corrupt" in why, why


@test("an empty catalogue is rebuilt too")
def _():
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td))
        steps.catalog_path(root).write_text(
            json.dumps({"tracks": [], "stats": {}}), encoding="utf-8")
        future = time.time() + 60
        os.utime(steps.catalog_path(root), (future, future))
        stale, why = steps.catalog_stale(root)
        assert stale and "no tracks" in why, why


@test("a project with no crawls is not mistaken for one needing a rebuild")
def _():
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td), crawls=0)
        assert steps.crawls(root) == []
        stale, why = steps.catalog_stale(root)
        assert not stale and "no crawls" in why, why


# ------------------------------------------------------------------- ports

@test("a port in use is never handed out")
def _():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", steps.PREFERRED_PORTS[0]))
        held.listen(1)
        assert not steps.port_free(steps.PREFERRED_PORTS[0])
        port = steps.pick_port()
        assert port != steps.PREFERRED_PORTS[0]
        assert steps.port_free(port)


@test("every preferred port being taken still yields one")
def _():
    holders = []
    try:
        for p in steps.PREFERRED_PORTS:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                s.bind(("127.0.0.1", p))
                s.listen(1)
                holders.append(s)
            except OSError:
                s.close()
        port = steps.pick_port()
        assert port not in steps.PREFERRED_PORTS or not holders
        assert steps.port_free(port)
    finally:
        for s in holders:
            s.close()


# -------------------------------------------------------------- dependencies

@test("a project without node_modules is reported as needing an install")
def _():
    with tempfile.TemporaryDirectory() as td:
        root = fake_project(Path(td))
        assert not steps.deps_installed(root)
        (root / "node_modules" / "vite" / "bin").mkdir(parents=True)
        (root / "node_modules" / "vite" / "bin" / "vite.js").write_text("", encoding="utf-8")
        assert not steps.deps_installed(root), "half-installed is not installed"
        (root / "node_modules" / "tsx" / "dist").mkdir(parents=True)
        (root / "node_modules" / "tsx" / "dist" / "cli.mjs").write_text("", encoding="utf-8")
        assert steps.deps_installed(root)


# -------------------------------------------------------------- the machine

@test("this machine's node is found and new enough")
def _():
    exe = steps.node_exe()
    major, raw = steps.node_version(exe)
    assert major >= steps.MIN_NODE_MAJOR, raw


@test("the real project passes every check")
def _():
    root = steps.find_root(Path(__file__).resolve().parent)
    assert (root / "package.json").is_file()
    assert steps.deps_installed(root), "run npm install"
    assert steps.crawls(root), "no crawl files in data/"
    assert steps.vite_entry(root).is_file()
    assert steps.tsx_entry(root).is_file()


print(f"\n{passed} passed, {len(failures)} failed")
for f in failures:
    print(f"  FAIL  {f}")
sys.exit(1 if failures else 0)
