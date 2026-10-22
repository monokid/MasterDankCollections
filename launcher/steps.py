"""Everything the launcher needs to know about the machine it is running on.

Kept apart from the GUI so each check is a plain function with a plain answer,
and so the failure messages can be read without starting a window.

The rule throughout: never assume. Every external thing -- node, the
dependencies, a free port, a server that has actually finished starting -- is
checked before it is used, and when it is missing the message says what to do
about it rather than what went wrong.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MIN_NODE_MAJOR = 20
PREFERRED_PORTS = [4317, 4318, 4319, 4320, 4321, 4322, 5190, 5191]

# Stops a console window flashing up for every child process on Windows.
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class StepError(Exception):
    """A check failed in a way the person running this can act on."""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.message = message
        self.hint = hint


# ------------------------------------------------------------------ locating

def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_root(start: Path | None = None) -> Path:
    """The project root, looked for upwards from wherever the exe happens to sit.

    The exe may be double-clicked from the project root, from launcher/, or from
    launcher/dist/ straight after a build, so none of those can be assumed.
    """
    here = (start or app_dir()).resolve()
    for candidate in [here, *here.parents][:6]:
        if (candidate / "package.json").is_file() and (candidate / "tools" / "distill.ts").is_file():
            return candidate
    raise StepError(
        "Can't find the project.",
        "Put this exe inside the MasterDankCollections folder (or its launcher\\ "
        "subfolder) and run it again.")


# -------------------------------------------------------------------- node

def node_exe() -> str:
    exe = shutil.which("node")
    if not exe:
        raise StepError(
            "Node.js isn't installed, or isn't on PATH.",
            "Install the LTS build from nodejs.org, then close and reopen this "
            "launcher so it picks up the new PATH.")
    return exe


def npm_exe() -> str:
    exe = shutil.which("npm")
    if not exe:
        raise StepError(
            "npm isn't on PATH, though node is.",
            "Reinstall Node.js from nodejs.org -- npm ships with it.")
    return exe


def node_version(exe: str) -> tuple[int, str]:
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True,
                             timeout=20, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise StepError(f"Node is installed but wouldn't run: {type(e).__name__}",
                        "Try running `node --version` in a terminal.")
    raw = (out.stdout or "").strip()
    try:
        major = int(raw.lstrip("v").split(".")[0])
    except (ValueError, IndexError):
        raise StepError(f"Couldn't read the Node version from {raw!r}.", "")
    if major < MIN_NODE_MAJOR:
        raise StepError(
            f"Node {raw} is too old; this needs {MIN_NODE_MAJOR} or newer.",
            "Install the current LTS from nodejs.org.")
    return major, raw


# ------------------------------------------------------------- dependencies

def vite_entry(root: Path) -> Path:
    return root / "node_modules" / "vite" / "bin" / "vite.js"


def tsx_entry(root: Path) -> Path:
    return root / "node_modules" / "tsx" / "dist" / "cli.mjs"


def deps_installed(root: Path) -> bool:
    return vite_entry(root).is_file() and tsx_entry(root).is_file()


# ------------------------------------------------------------------- data

def crawls(root: Path) -> list:
    data = root / "data"
    return sorted(data.glob("mdc-crawl-*.json")) if data.is_dir() else []


def catalog_path(root: Path) -> Path:
    return root / "public" / "data" / "catalog.json"


def catalog_stale(root: Path) -> tuple[bool, str]:
    """Does the catalogue need rebuilding, and why?

    Stale means older than anything it is derived from. Rebuilding is seconds,
    so the bias is towards rebuilding when unsure rather than serving a
    catalogue that no longer matches the crawls on disk.
    """
    cat = catalog_path(root)
    if not cat.is_file():
        return True, "no catalogue yet"
    found = crawls(root)
    if not found:
        return False, "no crawls to rebuild from"
    try:
        cat_mtime = cat.stat().st_mtime
    except OSError:
        return True, "catalogue unreadable"

    newer = [p.name for p in found if p.stat().st_mtime > cat_mtime]
    rules = root / "tools" / "rules.json"
    if rules.is_file() and rules.stat().st_mtime > cat_mtime:
        newer.append("rules.json")
    if newer:
        return True, "newer than the catalogue: " + ", ".join(newer[:3])

    # A catalogue that cannot be parsed is worse than none: the app would load
    # and then fail with nothing to say.
    try:
        with open(cat, encoding="utf-8") as fh:
            doc = json.load(fh)
        if not doc.get("tracks"):
            return True, "catalogue has no tracks"
    except (OSError, ValueError):
        return True, "catalogue is corrupt"
    return False, "up to date"


def catalog_summary(root: Path) -> str:
    try:
        with open(catalog_path(root), encoding="utf-8") as fh:
            d = json.load(fh)
        s = d.get("stats", {})
        return (f"{s.get('tracks', 0):,} tracks · {s.get('songs', 0):,} songs · "
                f"{len([e for e in d.get('events', []) if e.get('kind') != 'collection'])} nights")
    except Exception:
        return ""


# ------------------------------------------------------------------- ports

def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port() -> int:
    """A port nothing else is on.

    The preferred list is tried first so the URL is usually the same one twice
    running; failing that the OS picks. Other dev servers are often already
    sitting on the obvious ports, which is exactly the collision this avoids.
    """
    for port in PREFERRED_PORTS:
        if port_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# --------------------------------------------------------------- processes

def run_once(args: list, cwd: Path, on_line=None, timeout: int = 900) -> int:
    """Run a command to completion, streaming its output a line at a time."""
    try:
        proc = subprocess.Popen(
            args, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=NO_WINDOW)
    except OSError as e:
        raise StepError(f"Couldn't start {Path(args[0]).name}: {e}", "")
    started = time.time()
    assert proc.stdout is not None
    for line in proc.stdout:
        if on_line:
            on_line(line.rstrip())
        if time.time() - started > timeout:
            kill_tree(proc)
            raise StepError(f"{Path(args[0]).name} took longer than "
                            f"{timeout // 60} minutes and was stopped.", "")
    return proc.wait()


def kill_tree(proc: subprocess.Popen) -> None:
    """Kill a process and everything it spawned.

    terminate() alone leaves node's children running on Windows, which is how
    you end up with a port still held by a server you thought you closed.
    """
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=20, creationflags=NO_WINDOW)
            return
        except Exception:
            pass
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def wait_until_serving(port: int, proc: subprocess.Popen, timeout: int = 90) -> None:
    """Poll until the server actually answers.

    Vite prints its banner before it is ready to serve, so the banner is not the
    signal -- a real request is. Also watches the process, so a server that dies
    on startup reports that instead of hanging for the full timeout.
    """
    url = f"http://127.0.0.1:{port}/"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise StepError(
                f"The dev server stopped on its own (exit code {proc.returncode}).",
                "The log above should say why.")
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.25)
    raise StepError(f"The server didn't answer on port {port} within {timeout}s.",
                    "Something may be blocking localhost connections.")
