"""Small widget factories so every tab builds controls the same way.

Each factory takes a help key and attaches its tooltip, which is what makes "every
control has a tooltip" true by construction rather than by remembering to.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Callable

from . import theme
from .tooltip import tip

LEVEL_COLOUR = {"ok": theme.OK, "warn": theme.WARN, "fail": theme.BAD, "unsupported": theme.GREY}
MATCH_COLOUR = {"matched": theme.OK, "uncertain": theme.WARN, "missing": theme.BAD,
                "skipped": theme.GREY}


def label(parent: tk.Misc, text: str = "", style: str = "Dim.TLabel", **kw) -> ttk.Label:
    return ttk.Label(parent, text=text, style=style, **kw)


def button(parent: tk.Misc, text: str, command: Callable, key: str, *, primary: bool = False,
           small: bool = False, link: bool = False, state: str = "normal") -> ttk.Button:
    style = "Primary.TButton" if primary else "Link.TButton" if link else \
        "Small.TButton" if small else "TButton"
    return tip(ttk.Button(parent, text=text, command=command, style=style, state=state), key)


def check(parent: tk.Misc, text: str, var: tk.Variable, key: str, command: Callable | None = None,
          bg: str = theme.BG) -> tk.Checkbutton:
    return tip(tk.Checkbutton(parent, text=text, variable=var, command=command, bg=bg, fg=theme.FG,
                              selectcolor=theme.PANEL, activebackground=bg,
                              activeforeground=theme.ACCENT, borderwidth=0, highlightthickness=0,
                              anchor="w"), key)


def entry(parent: tk.Misc, var: tk.Variable, key: str, width: int | None = None, **kw) -> ttk.Entry:
    opts = {"width": width} if width else {}
    return tip(ttk.Entry(parent, textvariable=var, **opts, **kw), key)


def info_icon(parent: tk.Misc, key: str, bg: str = theme.BG,
              text_fn: Callable[[], str] | None = None) -> tk.Label:
    """The small (i) next to a section title; its tooltip is the longer explanation."""
    return tip(tk.Label(parent, text="ⓘ", bg=bg, fg=theme.DIM, font=theme.F_HEAD,
                        cursor="question_arrow"), key, text_fn)


def heading(parent: tk.Misc, text: str, info_key: str | None = None) -> tk.Frame:
    row = tk.Frame(parent, bg=theme.BG)
    label(row, text, "Head.TLabel").pack(side="left")
    if info_key:
        info_icon(row, info_key).pack(side="left", padx=(theme.PAD_S + 2, 0))
    return row


def mono_label(parent: tk.Misc, mono: str, bg: str = theme.BG, fg: str = theme.OK) -> tk.Label:
    return tk.Label(parent, bg=bg, fg=fg, font=(mono, 9), anchor="w")


class Collapsible(tk.Frame):
    """An 'Advanced' section: closed by default, and it remembers how you left it."""

    def __init__(self, parent: tk.Misc, title: str, settings, setting_key: str,
                 on_toggle: Callable[[], None] | None = None, key: str = "adv_toggle"):
        super().__init__(parent, bg=theme.BG)
        self.title, self._settings, self._skey, self._on_toggle = title, settings, setting_key, on_toggle
        self.toggle_btn = button(self, "", self.toggle, key, link=True)
        self.toggle_btn.pack(anchor="w")
        self.body = tk.Frame(self, bg=theme.BG, padx=theme.PAD_L, pady=theme.PAD_S)
        self.is_open = False
        self.set_open(bool(settings.get(setting_key, False)), notify=False)

    def set_open(self, on: bool, notify: bool = True) -> None:
        self.is_open = on
        self.toggle_btn.configure(text=("▾ " if on else "▸ ") + self.title)
        if on:
            self.body.pack(fill="x")
        else:
            self.body.pack_forget()
        self._settings.set(self._skey, on)
        if notify and self._on_toggle:
            self._on_toggle()

    def toggle(self) -> None:
        self.set_open(not self.is_open)


class Segmented(tk.Frame):
    """Two or three mutually exclusive choices drawn as one joined button strip."""

    def __init__(self, parent: tk.Misc, var: tk.StringVar, options: list[tuple[str, str, str]],
                 command: Callable[[], None] | None = None):
        super().__init__(parent, bg=theme.PANEL_HI, padx=2, pady=2)
        self.buttons: list[tk.Radiobutton] = []
        for text, value, key in options:
            rb = tk.Radiobutton(self, text=text, variable=var, value=value, command=command,
                                indicatoron=False, bg=theme.PANEL, fg=theme.DIM,
                                selectcolor=theme.ACCENT, activebackground=theme.PANEL_HI,
                                activeforeground=theme.FG, borderwidth=0, highlightthickness=0,
                                padx=22, pady=6, font=theme.F_BOLD, cursor="hand2")
            rb.pack(side="left", padx=1)
            tip(rb, key)
            self.buttons.append(rb)
        self._var = var
        var.trace_add("write", lambda *_a: self._recolour())
        self._values = [o[1] for o in options]
        self._recolour()

    def _recolour(self) -> None:
        for rb, value in zip(self.buttons, self._values):
            on = self._var.get() == value
            rb.configure(fg=theme.BG if on else theme.DIM)

    def set_enabled(self, on: bool) -> None:
        for rb in self.buttons:
            rb.configure(state="normal" if on else "disabled")


def scrolled_tree(parent: tk.Misc, columns: tuple, widths: tuple, headings: tuple, height: int,
                  selectmode: str = "browse", stretch: tuple | None = None):
    """A Treeview with a scrollbar and the status colour tags. -> (frame, tree)."""
    wrap = tk.Frame(parent, bg=theme.PANEL)
    tree = ttk.Treeview(wrap, columns=columns, show="headings", height=height, selectmode=selectmode)
    sb = ttk.Scrollbar(wrap, command=tree.yview)
    tree.configure(yscrollcommand=sb.set)
    for i, (c, w, (text, anchor)) in enumerate(zip(columns, widths, headings)):
        tree.heading(c, text=text, anchor=anchor)
        tree.column(c, width=w, minwidth=24, anchor=anchor,
                    stretch=(c in stretch) if stretch is not None else (w >= 200))
    sb.pack(side="right", fill="y")
    tree.pack(side="left", fill="both", expand=True)
    for name, col in {**LEVEL_COLOUR, **MATCH_COLOUR}.items():
        tree.tag_configure(name, foreground=col)
    return wrap, tree
