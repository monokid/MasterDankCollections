"""What every tab is: build once on first show, react to busy/selection changes."""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from .. import theme
from ..context import Context
from ..ui import button, label


class Tab:
    """Base class. A tab owns its widgets; the shell owns the notebook and the lazy build.

    Interface:  build(parent)  creates the widgets (called once, on first show);
                on_show()      the tab became visible;
                set_busy(b)    a job started/ended OR the selection changed: re-derive
                               which controls are enabled (never cache that elsewhere);
                primary()      the Enter-key action.
    """

    key = ""
    uses_selection = True            # Dig has its own folder and hides the shared list

    def __init__(self, ctx: Context):
        self.ctx = ctx
        self.frame: tk.Frame | None = None
        self.stop_btn: ttk.Button | None = None

    def build(self, parent: tk.Frame) -> None:
        raise NotImplementedError

    def on_show(self) -> None:
        pass

    def set_busy(self, busy: bool) -> None:
        pass

    def primary_button(self) -> ttk.Button | None:
        return None

    def primary(self) -> None:
        b = self.primary_button()
        if b is not None and str(b.cget("state")) != "disabled":
            b.invoke()

    # ---- helpers shared by the tabs
    def make_stop(self, parent: tk.Misc) -> ttk.Button:
        """The Stop button: created hidden, shown only while a job runs."""
        self.stop_btn = button(parent, "Stop", self.ctx.stop, "stop")
        self._stop_packed = False
        return self.stop_btn

    def show_stop(self, busy: bool, **pack) -> None:
        if self.stop_btn is None:
            return
        if busy and not self._stop_packed:
            self.stop_btn.pack(**(pack or {"side": "left", "padx": (theme.PAD, 0)}))
            self._stop_packed = True
        elif not busy and self._stop_packed:
            self.stop_btn.pack_forget()
            self._stop_packed = False

    @staticmethod
    def enable(widget: tk.Misc, on: bool) -> None:
        widget.configure(state="normal" if on else "disabled")

    @staticmethod
    def note(parent: tk.Misc, text: str, wrap: int = 760) -> ttk.Label:
        return label(parent, text, wraplength=wrap, justify="left")
