"""The progress strip and the console: banners, ticker, success/failure art, easter eggs.

Log writes are buffered and flushed at most every LOG_FLUSH_MS in one Text edit, and
the log is capped at LOG_MAX_LINES, so a chatty job can neither flood the UI thread
nor grow the widget without bound.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

import banner
from widgets import CosmicBar, Ticker, hsv_hex, pick_font
from . import theme
from .logic import human_time


class ProgressPanel:
    """Spectrum bar, a 'n / total' line on the left and the time left on the right."""

    def __init__(self, parent: tk.Misc):
        self.frame = tk.Frame(parent, bg=theme.BG)
        self.bar = CosmicBar(self.frame, trough=theme.PANEL, height=18)
        self.bar.pack(fill="x", pady=(2, 5))
        row = ttk.Frame(self.frame)
        row.pack(fill="x")
        self.count = ttk.Label(row, text="Idle", style="Dim.TLabel")
        self.count.pack(side="left")
        self.eta = ttk.Label(row, text="", style="Dim.TLabel")
        self.eta.pack(side="right")

    def reset(self) -> None:
        self.bar.set_value(0)
        self.eta.configure(text="")

    def finish(self, text: str | None = None, fraction: float = 1.0) -> None:
        self.bar.stop()
        self.bar.set_value(fraction)
        self.eta.configure(text="")
        if text is not None:
            self.count.configure(text=text)

    def apply(self, done: int, total: int, current: str, unit: str, elapsed: float) -> None:
        if not total:
            self.bar.start()
            self.count.configure(text=current)
            return
        self.bar.stop()
        self.bar.set_value(done / total)
        tail = "  " + current if current else ""
        self.count.configure(text="{:,} / {:,} {}{}".format(done, total, unit, tail))
        if max(4, min(30, total // 10)) <= done < total:
            self.eta.configure(text="about " + human_time(elapsed / done * (total - done)) + " left")


class Console:
    """The log pane. `log()` is Tk-thread only; workers go through `Context.say`."""

    def __init__(self, parent: tk.Misc):
        mono = pick_font(theme.MONO_FONTS, "Courier")
        wrap = tk.Frame(parent, bg=theme.PANEL, highlightthickness=0)
        self.frame = wrap
        self.ticker = Ticker(wrap, theme.PANEL, (mono, 9))
        self.ticker.pack(fill="x", padx=10, pady=(6, 0))
        inner = tk.Frame(wrap, bg=theme.PANEL)
        inner.pack(fill="both", expand=True)
        self.text = tk.Text(inner, bg=theme.PANEL, fg=theme.FG, insertbackground=theme.FG,
                            borderwidth=0, font=(mono, 9), wrap="none", height=8, state="disabled")
        sb = ttk.Scrollbar(inner, command=self.text.yview)
        self.text.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.text.pack(side="left", fill="both", expand=True, padx=8, pady=8)
        for tag, col in (("ok", theme.OK), ("bad", theme.BAD), ("warn", theme.WARN),
                         ("dim", theme.DIM), ("art", theme.ART), ("accent", theme.ACCENT)):
            self.text.tag_configure(tag, foreground=col)
        self._banner_font = (pick_font(theme.BANNER_FONTS, mono), 9)
        self._tags: set[str] = set()
        self._pending: list[tuple[str, str]] = []
        self._flush_job: str | None = None
        self._typed = ""
        self.text.bind("<Button-1>", lambda _e: self.text.focus_set())
        self.text.bind("<Key>", self._on_key)

    # -- writing
    def log(self, msg: str, tag: str = "") -> None:
        self._pending.append((msg + "\n", tag))
        if self._flush_job is None:
            self._flush_job = self.text.after(theme.LOG_FLUSH_MS, self.flush)

    def flush(self, follow: bool = True) -> None:
        """Write everything buffered in one edit, trim the scrollback, follow the tail.

        `follow=False` skips `see`, which forces Tk to lay the whole text out (tens of ms)."""
        if self._flush_job is not None:
            self.text.after_cancel(self._flush_job)
            self._flush_job = None
        if not self._pending:
            return
        pending, self._pending = self._pending, []
        t = self.text
        t.configure(state="normal")
        for chunk, tag in pending:
            t.insert("end", chunk, tag)
        extra = int(t.index("end-1c").split(".")[0]) - theme.LOG_MAX_LINES
        if extra > 0:
            t.delete("1.0", "%d.0" % (extra + 1))
        if follow:
            t.see("end")
        t.configure(state="disabled")

    def shutdown(self) -> None:
        if self._flush_job is not None:
            self.text.after_cancel(self._flush_job)
            self._flush_job = None

    def line_count(self) -> int:
        self.flush()
        return int(self.text.index("end-1c").split(".")[0])

    # -- art
    def _banner_tag(self, name: str, kind: str, i: int, last: int) -> str:
        tag = "b_%s_%s_%d" % (name, kind, i)
        if tag not in self._tags:
            t = i / max(last, 1)
            if kind == "word":
                a, b = banner.HUES[name]
                col = hsv_hex(a + (b - a) * t, 0.55, 1.0)
            elif kind == "art":
                a, b = banner.ART_HUES[name]
                col = hsv_hex(a + (b - a) * t, 0.5, 0.98)
            elif kind == "hot":
                col = "#ff8fb8"
            elif kind == "text":
                col = theme.ACCENT
            else:
                col = theme.ART
            self.text.tag_configure(tag, font=self._banner_font, foreground=col)
            self._tags.add(tag)
        return tag

    def print_banner(self, name: str, scroll: bool = True) -> None:
        """Paint a banner: stars stay dim, letters and sprite take a hue ramp top to bottom."""
        self.flush(scroll)
        rows = banner.pieces(name)
        last = len(rows) - 1
        t = self.text
        t.configure(state="normal")
        for i, row in enumerate(rows):
            for text, kind in row:
                t.insert("end", text, self._banner_tag(name, kind, i, last))
            t.insert("end", "\n", self._banner_tag(name, "star", i, last))
        t.configure(state="disabled")
        if scroll:
            t.see("end")

    def final_banner(self, success: bool) -> None:
        self.print_banner("success" if success else "failure")
        if success:
            for line in banner.burst():
                self.log(line, "accent")

    def tab_banner(self, name: str, ready: list[str], first: bool = False) -> None:
        """A tab's banner and intro lines, scrolled so the banner starts at the top of the pane.
        On the very first banner the pane already shows the top, so no scrolling is done."""
        self.flush(not first)
        start = self.text.index("end-1c")
        self.print_banner(name, scroll=False)
        for line in ready:
            self.log(line, "dim")
        self.flush(False)
        if not first:
            self.text.yview(start)

    def opening(self, folder: str, first: bool = False) -> None:
        """The original Dig banner and its intro, shown the first time the Dig tab opens."""
        self.tab_banner("dig", banner.READY + ["  Cave mouth: " + folder, "  Say the word."], first)

    # -- easter egg: typing 'dank' in the log
    def _on_key(self, e: tk.Event) -> None:
        if e.char and e.char.isprintable():
            self._typed = (self._typed + e.char.lower())[-4:]
            if self._typed == "dank":
                self._typed = ""
                for line in banner.POEM:
                    self.log(line, "accent")
