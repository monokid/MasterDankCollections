"""Hover tooltips for every kind of widget, driven by one shared popup window.

One popup is reused for the whole app (creating a Toplevel per widget is what makes
naive tooltip code slow). It is an override-redirect window, so it never takes
focus. Text comes from `help_texts.HELP` by key, so wording lives in one file.
"""
from __future__ import annotations

import textwrap
import tkinter as tk
from typing import Callable

from . import theme
from .help_texts import HELP

# widget path -> key. tests/test_gui_help.py walks the live widget tree against this.
REGISTRY: dict[str, str] = {}

_Resolver = Callable[[tk.Event], "tuple[object, str] | None"]


def wrap(text: str, width: int = theme.TIP_WRAP) -> str:
    return textwrap.fill(text, width)


class _Popup:
    """The single shared tooltip window plus the hover timer."""

    def __init__(self, root: tk.Misc):
        self.root = root
        self.win: tk.Toplevel | None = None
        self.label: tk.Label | None = None
        self._job: str | None = None
        self.shown_for: object = None

    def _ensure(self) -> None:
        if self.win is not None:
            return
        win = tk.Toplevel(self.root)
        win.withdraw()
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        frame = tk.Frame(win, bg=theme.TIP_BORDER, padx=1, pady=1)
        frame.pack()
        self.label = tk.Label(frame, bg=theme.TIP_BG, fg=theme.FG, font=theme.F_BASE,
                              justify="left", padx=10, pady=6)
        self.label.pack()
        self.win = win

    def schedule(self, owner: object, text: str, where: Callable[[], tuple[int, int]],
                 delay: int = theme.TIP_DELAY_MS) -> None:
        self.hide()
        self.shown_for = owner
        self._job = self.root.after(delay, self._show, text, where)

    def _show(self, text: str, where: Callable[[], tuple[int, int]]) -> None:
        self._job = None
        if not text:
            return
        try:
            self._ensure()
            self.label.configure(text=wrap(text))
            self.win.update_idletasks()
            x, y = where()
            w, h = self.win.winfo_reqwidth(), self.win.winfo_reqheight()
            sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
            x = max(0, min(x, sw - w - 4))
            if y + h > sh - 4:
                y = max(0, y - h - 36)
            self.win.geometry("+%d+%d" % (x, y))
            self.win.deiconify()
            self.win.lift()
        except tk.TclError:
            pass

    def hide(self) -> None:
        if self._job is not None:
            try:
                self.root.after_cancel(self._job)
            except tk.TclError:
                pass
            self._job = None
        self.shown_for = None
        if self.win is not None:
            try:
                self.win.withdraw()
            except tk.TclError:
                pass


_popups: dict[str, _Popup] = {}


def _popup(widget: tk.Misc) -> _Popup:
    root = widget._root()
    key = str(root)
    p = _popups.get(key)
    if p is None or p.root is not root:
        p = _popups[key] = _Popup(root)
    return p


def hide_all(widget: tk.Misc) -> None:
    """Dismiss any open tooltip (called when a dialog opens)."""
    _popup(widget).hide()


def _below(widget: tk.Misc) -> Callable[[], tuple[int, int]]:
    return lambda: (widget.winfo_rootx() + 8, widget.winfo_rooty() + widget.winfo_height() + 4)


def tip(widget: tk.Misc, key: str, text_fn: Callable[[], str] | None = None) -> tk.Misc:
    """Give `widget` the tooltip registered under `key` (KeyError if there is none).

    `text_fn` makes the text dynamic (e.g. which formats lack a decoder); `key`'s
    text is then only the fallback shown when text_fn returns nothing.
    """
    base = HELP[key]
    REGISTRY[str(widget)] = key
    pop = _popup(widget)

    def enter(_e: tk.Event) -> None:
        text = (text_fn() if text_fn else "") or base
        pop.schedule(widget, text, _below(widget))

    def leave(_e: tk.Event | None = None) -> None:
        if pop.shown_for is widget:
            pop.hide()
    widget.bind("<Enter>", enter, add="+")
    widget.bind("<Leave>", leave, add="+")
    widget.bind("<ButtonPress>", leave, add="+")
    widget.bind("<FocusOut>", leave, add="+")
    widget.bind("<Destroy>", leave, add="+")
    return widget


def tip_regions(widget: tk.Misc, resolver: _Resolver, keys: list[str] | None = None) -> None:
    """Tooltips for parts of one widget (tree headings, rows, notebook tabs).

    `resolver(event)` returns (region id, text) for the pointer position or None.
    The popup follows the pointer within a region and hides when it leaves.
    """
    for k in keys or []:
        HELP[k]
    REGISTRY[str(widget)] = (keys or ["-"])[0]
    widget._tip_keys = list(keys or [])           # type: ignore[attr-defined]
    pop = _popup(widget)
    cur: list[object] = [None]

    def motion(e: tk.Event) -> None:
        hit = resolver(e)
        if hit is None:
            cur[0] = None
            if pop.shown_for is widget:
                pop.hide()
            return
        if hit[0] == cur[0]:
            return
        cur[0] = hit[0]
        x, y = e.x_root + 12, e.y_root + 20
        pop.schedule(widget, hit[1], lambda: (x, y))
        pop.shown_for = widget

    def leave(_e: tk.Event | None = None) -> None:
        cur[0] = None
        if pop.shown_for is widget:
            pop.hide()
    widget.bind("<Motion>", motion, add="+")
    widget.bind("<Leave>", leave, add="+")
    widget.bind("<ButtonPress>", leave, add="+")
    widget.bind("<FocusOut>", leave, add="+")


def heading_resolver(tree: "tk.Misc", columns: dict[str, str]) -> _Resolver:
    """Resolver for a Treeview's column headers: `columns` maps column id -> help key."""
    def resolve(e: tk.Event):
        if tree.identify_region(e.x, e.y) != "heading":
            return None
        try:
            col = tree.column(tree.identify_column(e.x), "id")
        except tk.TclError:
            return None
        key = columns.get(col)
        return (col, HELP[key]) if key else None
    return resolve


def tip_headings(tree: "tk.Misc", columns: dict[str, str]) -> None:
    tip_regions(tree, heading_resolver(tree, columns), list(columns.values()))


def tip_tabs(notebook: "tk.Misc", keys: list[str]) -> None:
    """Tooltips on the tab labels of a ttk.Notebook, one key per tab in order."""
    def resolve(e: tk.Event):
        if notebook.identify(e.x, e.y) != "label":
            return None
        try:
            i = notebook.index("@%d,%d" % (e.x, e.y))
        except tk.TclError:
            return None
        return (i, HELP[keys[i]]) if 0 <= i < len(keys) else None
    tip_regions(notebook, resolve, keys)
