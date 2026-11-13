"""Modal dialogs in the app's own colours. Esc cancels, Enter takes the default button."""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

import workflow
from . import theme
from .logic import query_label
from .tooltip import hide_all
from .ui import scrolled_tree


def centre(top: tk.Toplevel, parent: tk.Misc) -> None:
    top.update_idletasks()
    try:
        x = parent.winfo_rootx() + (parent.winfo_width() - top.winfo_width()) // 2
        y = parent.winfo_rooty() + max(40, (parent.winfo_height() - top.winfo_height()) // 3)
        top.geometry("+%d+%d" % (max(0, x), max(0, y)))
    except tk.TclError:
        pass


def _window(root: tk.Misc, title: str) -> tk.Toplevel:
    hide_all(root)
    top = tk.Toplevel(root)
    top.title(title)
    top.configure(bg=theme.BG)
    top.transient(root)
    top.bind("<Escape>", lambda _e: top.destroy())
    return top


def ask(root: tk.Misc, heading: str, body: str, buttons: tuple = ("OK",),
        colour: str = theme.ACCENT, width: int = 540, default: str | None = None) -> str | None:
    """Show a message and return the pressed button's label (None if closed or Esc)."""
    top = _window(root, "DankCrawl")
    result: list[str | None] = [None]
    box = tk.Frame(top, bg=theme.PANEL, padx=22, pady=18)
    box.pack(fill="both", expand=True, padx=theme.PAD_L - 2, pady=theme.PAD_L - 2)
    tk.Label(box, text=heading, bg=theme.PANEL, fg=colour, font=theme.F_BIG, anchor="w",
             justify="left", wraplength=width).pack(fill="x")
    tk.Label(box, text=body, bg=theme.PANEL, fg=theme.FG, anchor="w", justify="left",
             wraplength=width).pack(fill="x", pady=(10, 14))
    row = tk.Frame(box, bg=theme.PANEL)
    row.pack(fill="x")
    chosen = default or buttons[0]
    focus = None

    def pick(label: str) -> None:
        result[0] = label
        top.destroy()
    for label in reversed(buttons):
        primary = label == chosen
        b = ttk.Button(row, text=label, command=lambda lab=label: pick(lab),
                       style="Primary.TButton" if primary else "TButton")
        b.pack(side="right", padx=(theme.PAD, 0))
        if primary:
            focus = b
    top.bind("<Return>", lambda _e: pick(chosen))
    centre(top, root)
    top.grab_set()
    if focus is not None:
        focus.focus_set()
    root.wait_window(top)
    return result[0]


def show_preview(root: tk.Misc, rows: list, seed: int | None, mode: str) -> None:
    """The 'what will the copies be called' table: the first PREVIEW_ROWS rows only."""
    top = _window(root, "Preview names")
    top.geometry("820x520")
    tk.Label(top, text="What the copies will be called", bg=theme.BG, fg=theme.ACCENT,
             font=theme.F_BIG).pack(anchor="w", padx=theme.PAD_L, pady=(14, 4))
    shown = rows[:theme.PREVIEW_ROWS]
    note = ("Showing the first %d of %d." % (len(shown), len(rows))
            if len(rows) > theme.PREVIEW_ROWS else "All %d files." % len(rows))
    if mode != "kinda" and seed is not None:
        note += ("  The seed is locked to %s so 'Cloak it' matches this preview "
                 "(Advanced > Seed: type 'random' to roll again)." % seed)
    tk.Label(top, text=note, bg=theme.BG, fg=theme.DIM, wraplength=780, justify="left").pack(
        anchor="w", padx=theme.PAD_L)
    wrap, tree = scrolled_tree(top, ("a", "b"), (360, 360),
                               (("Original (as you have it)", "w"), ("Becomes", "w")), 14)
    wrap.pack(fill="both", expand=True, padx=theme.PAD_L, pady=10)
    for a, b in shown:
        tree.insert("", "end", values=(a, b))
    close = ttk.Button(top, text="Close", command=top.destroy, style="Primary.TButton")
    close.pack(pady=(0, 14))
    close.focus_set()
    centre(top, root)


def choose_match(root: tk.Misc, m) -> tuple | None:
    """Let the user pick one of a track's Spotify candidates. -> ('pick', candidate|None) or None."""
    top = _window(root, "Choose a match")
    tk.Label(top, text="Which one is it?", bg=theme.BG, fg=theme.ACCENT, font=theme.F_BIG).pack(
        anchor="w", padx=theme.PAD_L, pady=(14, 2))
    tk.Label(top, text=query_label(m.query), bg=theme.BG, fg=theme.FG).pack(
        anchor="w", padx=theme.PAD_L, pady=(0, theme.PAD))
    var = tk.IntVar(value=-1)
    result: list[tuple | None] = [None]
    for k, c in enumerate(m.candidates):
        if m.chosen is not None and c.uri == m.chosen.uri:
            var.set(k)
        text = "%s - %s (%s)   %d%%   %s" % (c.name, ", ".join(c.artists), c.album,
                                              round(c.score * 100), workflow.human_duration(c.duration_sec))
        tk.Radiobutton(top, text=text, variable=var, value=k, bg=theme.BG, fg=theme.FG,
                       selectcolor=theme.PANEL, activebackground=theme.BG, borderwidth=0,
                       highlightthickness=0, anchor="w").pack(anchor="w", padx=22)
    tk.Radiobutton(top, text="Skip this track", variable=var, value=-1, bg=theme.BG, fg=theme.FG,
                   selectcolor=theme.PANEL, activebackground=theme.BG, borderwidth=0,
                   highlightthickness=0, anchor="w").pack(anchor="w", padx=22, pady=(6, 0))

    def ok() -> None:
        k = var.get()
        result[0] = ("pick", m.candidates[k] if k >= 0 else None)
        top.destroy()
    row = tk.Frame(top, bg=theme.BG)
    row.pack(fill="x", padx=theme.PAD_L, pady=14)
    use = ttk.Button(row, text="Use this", command=ok, style="Primary.TButton")
    use.pack(side="right")
    ttk.Button(row, text="Cancel", command=top.destroy).pack(side="right", padx=(0, theme.PAD))
    top.bind("<Return>", lambda _e: ok())
    centre(top, root)
    top.grab_set()
    use.focus_set()
    root.wait_window(top)
    return result[0]
