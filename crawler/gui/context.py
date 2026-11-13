"""The object every tab receives: selection, console, progress, job runner, dialogs.

Tabs never reach into each other or into the app shell; they talk to `Context`. That
keeps each tab a small class and makes the thread rule easy to state: workers only
ever call `ui()`, `say()` and `post_progress()`, and the clock pump runs what they
queued on the Tk thread.
"""
from __future__ import annotations

import queue
import threading
import time
import tkinter as tk
import traceback
from typing import Any, Callable

import banner
from . import dialogs, system, theme
from .console import Console, ProgressPanel
from .settings import Settings


class Context:
    def __init__(self, root: tk.Tk, settings: Settings, link_factory: Callable, test_mode: bool):
        self.root = root
        self.settings = settings
        self.link_factory = link_factory
        self.test_mode = test_mode
        self.q: queue.Queue = queue.Queue()
        self.stop_flag = threading.Event()
        self.busy = False
        self.job_kind = "dig"
        self.callback_errors = 0
        self.opened_paths: list[str] = []         # what open_path was asked for (test mode)
        # Filled in by the app shell once those pieces exist.
        self.console: Console = None               # type: ignore[assignment]
        self.progress: ProgressPanel = None        # type: ignore[assignment]
        self.selection: Any = None
        self.header: Any = None
        self.shell: Any = None
        self._latest: tuple | None = None
        self._started = 0.0
        self._tabs: list = []

    # ---- threads
    def ui(self, fn: Callable, *args: Any) -> None:
        """Run fn(*args) on the Tk thread. The only way a worker may touch the UI."""
        self.q.put((fn, args))

    def say(self, msg: str, tag: str = "") -> None:
        self.ui(self.console.log, msg, tag)

    def post_progress(self, done: int, total: int, current: str = "", unit: str = "files") -> None:
        """Worker-side progress: only the newest value is kept and drawn on the next tick."""
        self._latest = (done, total, current, unit)

    def pump(self) -> None:
        """Called by the clock every tick on the Tk thread."""
        latest, self._latest = self._latest, None
        if latest is not None:
            self.progress.apply(*latest, time.time() - self._started)
        deadline = time.monotonic() + 0.03
        while time.monotonic() < deadline:
            try:
                fn, args = self.q.get_nowait()
            except queue.Empty:
                return
            try:
                fn(*args)
            except Exception:  # noqa: BLE001 - a broken callback must not kill the pump
                self.callback_errors += 1
                traceback.print_exc()

    # ---- tabs
    def register_tab(self, tab: Any) -> None:
        self._tabs.append(tab)

    def refresh(self) -> None:
        """Tell every built tab the selection or busy state changed."""
        for tab in self._tabs:
            tab.set_busy(self.busy)

    def relayout(self) -> None:
        if self.shell is not None:
            self.shell.fit_upper()

    # ---- jobs
    def begin(self, kind: str) -> None:
        self.job_kind = kind
        self.stop_flag.clear()
        self._started = time.time()
        self.busy = True
        self.progress.reset()
        self.header.set_busy(True)
        self.console.ticker.start(banner.FLAVOUR[kind])
        self.refresh()

    def end(self) -> None:
        self.busy = False
        self._latest = None          # a late progress tick must not repaint a finished bar
        self.progress.bar.stop()
        self.progress.eta.configure(text="")
        self.header.set_busy(False)
        self.console.ticker.stop()
        self.refresh()

    def run_job(self, kind: str, fn: Callable, *args: Any) -> None:
        """Run fn(*args) on a worker thread; any exception becomes the 'hit a rock' dialog."""
        self.begin(kind)

        def runner() -> None:
            try:
                fn(*args)
            except Exception as e:  # noqa: BLE001 - surfaced to the user, not swallowed
                self.ui(self.job_failed, "%s: %s" % (type(e).__name__, e))
        threading.Thread(target=runner, daemon=True).start()

    def job_failed(self, err: str) -> None:
        self.end()
        self.console.log("  Hit a rock: " + err, "bad")
        self.console.final_banner(False)
        self.ask("Well, that's embarrassing",
                 "That tripped over something and stopped:\n\n" + err +
                 "\n\nNot your fault. Send this message to Ian and he'll sort it.", colour=theme.BAD)

    def stop(self) -> None:
        self.stop_flag.set()
        self.console.log("  Downing tools after this one...", "dim")

    # ---- dialogs and the OS
    def ask(self, heading: str, body: str, buttons: tuple = ("OK",), colour: str = theme.ACCENT,
            width: int = 540, default: str | None = None) -> str | None:
        return dialogs.ask(self.root, heading, body, buttons, colour, width, default)

    def tell(self, heading: str, body: str, colour: str = theme.ACCENT) -> None:
        self.ask(heading, body, ("OK",), colour)

    def open_path(self, path: str) -> None:
        """Open a folder in Explorer. Scripted/test runs only record the request."""
        if self.test_mode:
            self.opened_paths.append(path)
        else:
            system.open_path(path)

    def need_files(self) -> bool:
        sel = self.selection
        if sel.sel is None or not sel.included():
            self.tell("Nothing to work on.",
                      "Pick a playlist folder above and make sure at least one file is ticked.")
            return False
        return True
