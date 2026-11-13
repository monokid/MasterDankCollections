"""The one `after` loop for the whole window.

Header animation, the console ticker, the progress-bar comet and the worker-thread
queue pump all hang off this single timer instead of each owning an `after` chain.
Animations are skipped while the window is minimised (nothing is drawn) or, for the
decorative ones, unfocused; the pump never skips, because jobs must keep moving.
"""
from __future__ import annotations

import tkinter as tk
import traceback
from typing import Callable

from . import theme

ALWAYS, VISIBLE, AWAKE = "always", "visible", "awake"


class Clock:
    def __init__(self, root: tk.Misc, tick_ms: int = theme.TICK_MS):
        self.root = root
        self.tick_ms = tick_ms
        self.awake = True            # the window has focus
        self.visible = True          # the window is not minimised
        self.errors = 0
        self._n = 0
        self._subs: list[tuple[Callable[[], None], int, str]] = []
        self._job: str | None = None
        root.bind("<Unmap>", lambda e: self._set(visible=False) if e.widget is root else None, "+")
        root.bind("<Map>", lambda e: self._set(visible=True) if e.widget is root else None, "+")
        root.bind("<FocusIn>", lambda e: self._set(awake=True), "+")
        root.bind("<FocusOut>", lambda e: root.after(150, self._check_focus), "+")

    def add(self, fn: Callable[[], None], every: int = 1, when: str = AWAKE) -> None:
        """Call `fn` every `every` ticks while the window state matches `when`."""
        self._subs.append((fn, max(1, every), when))

    def start(self) -> None:
        if self._job is None:
            self._job = self.root.after(self.tick_ms, self._tick)

    def stop(self) -> None:
        if self._job is not None:
            try:
                self.root.after_cancel(self._job)
            except tk.TclError:
                pass
            self._job = None

    def _set(self, awake: bool | None = None, visible: bool | None = None) -> None:
        if awake is not None:
            self.awake = awake
        if visible is not None:
            self.visible = visible
            if not visible:
                self.awake = False

    def _check_focus(self) -> None:
        try:
            self.awake = self.root.focus_displayof() is not None and self.root.state() != "iconic"
        except tk.TclError:
            pass

    def _tick(self) -> None:
        self._n += 1
        for fn, every, when in self._subs:
            if self._n % every:
                continue
            if when == AWAKE and not self.awake:
                continue
            if when == VISIBLE and not self.visible:
                continue
            try:
                fn()
            except tk.TclError:
                pass
            except Exception:  # noqa: BLE001 - one bad subscriber must not stop the loop
                self.errors += 1
                traceback.print_exc()
        try:
            self._job = self.root.after(self.tick_ms, self._tick)
        except tk.TclError:
            self._job = None
