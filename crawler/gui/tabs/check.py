"""Check tab: Quick or Thorough, one button, a coloured results table."""
from __future__ import annotations

import os
import tkinter as tk
from tkinter import filedialog

import integrity
import workflow
from .. import logic, theme
from ..logic import plural
from ..help_texts import HELP
from ..tooltip import heading_resolver, tip_regions
from ..ui import LEVEL_COLOUR, Segmented, button, heading, info_icon, label, scrolled_tree
from .base import Tab

COLS = ("level", "name", "reason", "engine")
HEAD_KEYS = {"level": "col_res_level", "name": "col_res_name", "reason": "col_res_reason",
             "engine": "col_res_engine"}


class CheckTab(Tab):
    key = "check"

    def build(self, parent: tk.Frame) -> None:
        self.frame = parent
        ctx = self.ctx
        self.mode_var = tk.StringVar(value="quick")
        self.verdicts: list = []
        self.shown: list = []
        self.sort = ("level", False)
        self._fill_job: str | None = None

        heading(parent, "Are my files OK?", "info_check").pack(anchor="w")
        row = tk.Frame(parent, bg=theme.BG)
        row.pack(fill="x", pady=(theme.PAD, 0))
        self.seg = Segmented(row, self.mode_var, [("Quick", "quick", "check_quick"),
                                                  ("Thorough", "thorough", "check_thorough")],
                             self._mode_changed)
        self.seg.pack(side="left")
        self.go_btn = button(row, "Check files", self._go, "check_go", primary=True)
        self.go_btn.pack(side="left", padx=(theme.PAD_L, 0))
        self.make_stop(row)
        self.ff_icon = info_icon(row, "check_ffmpeg", text_fn=self._ffmpeg_text)

        res = tk.Frame(parent, bg=theme.BG)
        res.pack(fill="x", pady=(theme.PAD, 0))
        self.summary = label(res, "", "TLabel")
        self.summary.pack(side="left")
        self.report_btn = button(res, "Save report…", self._report, "check_report", link=True)

        wrap, self.tree = scrolled_tree(
            parent, COLS, (110, 280, 440, 80),
            (("Result", "w"), ("File", "w"), ("What I found", "w"), ("Engine", "w")), 6,
            stretch=("reason",))
        wrap.pack(fill="both", expand=True, pady=(theme.PAD_S, 0))
        for c in COLS:
            self.tree.heading(c, command=lambda c=c: self._sort_by(c))
        hit = heading_resolver(self.tree, HEAD_KEYS)
        tip_regions(self.tree, lambda e: hit(e) or ("body", HELP["check_table"]), list(HEAD_KEYS.values()) + ["check_table"])
        self.tree.bind("<Double-1>", self._detail)
        self.hint = label(parent, "Double-click a row to see the plain-language reason.")
        self.hint.pack(anchor="w", pady=(theme.PAD_S, 0))
        ctx.selection.on_loaded.append(self._refresh_ffmpeg)
        self._refresh_ffmpeg()

    # ------------------------------------------------------------ state
    def primary_button(self):
        return self.go_btn

    def on_show(self) -> None:
        self._refresh_ffmpeg()

    def deep(self) -> bool:
        return self.mode_var.get() == "thorough"

    def _mode_changed(self) -> None:
        self._refresh_ffmpeg()

    def _missing_formats(self) -> list[str]:
        if not self.deep() or integrity.have_ffmpeg():
            return []
        return sorted({e.fmt for e in self.ctx.selection.included()
                       if e.fmt and not integrity.deep_supported(e.fmt)})

    def _ffmpeg_text(self) -> str:
        missing = self._missing_formats()
        text = HELP["check_ffmpeg"]
        if missing:
            text += " In your selection this affects: " + ", ".join(missing) + "."
        return text

    def _refresh_ffmpeg(self) -> None:
        """The info icon appears only when Thorough would skip some of the selected files."""
        if self.frame is None:
            return
        if self._missing_formats():
            if self.ff_icon.winfo_manager() != "pack":
                self.ff_icon.pack(side="left", padx=(theme.PAD, 0))
        else:
            self.ff_icon.pack_forget()

    def set_busy(self, busy: bool) -> None:
        if self.frame is None:
            return
        free = not busy
        self.enable(self.go_btn, free and bool(self.ctx.selection.included()))
        self.seg.set_enabled(free)
        self.enable(self.report_btn, free and bool(self.verdicts))
        self.show_stop(busy)
        self._refresh_ffmpeg()

    # ------------------------------------------------------------ run
    def _go(self) -> None:
        ctx = self.ctx
        if not ctx.need_files():
            return
        deep = self.deep()
        workers = logic.auto_workers(deep)
        paths = [e.path for e in ctx.selection.included()]
        ctx.console.log("", "dim")
        ctx.console.log("  Stethoscope out. %s check of %s, %d at a time." % (
            "Thorough" if deep else "Quick", plural(len(paths), "file"), workers), "ok")
        ctx.run_job("check", self._work, paths, deep, workers)

    def _work(self, paths: list, deep: bool, workers: int) -> None:
        ctx, total = self.ctx, len(paths)
        res = integrity.check_many(
            paths, deep=deep, workers=workers, stop=ctx.stop_flag,
            progress=lambda done, _t, name: ctx.post_progress(done, total, "Listening to " + name))
        ctx.ui(self._done, res, total)

    def _done(self, verdicts: list, total: int) -> None:
        ctx, con = self.ctx, self.ctx.console
        ctx.end()
        self.verdicts = verdicts
        by_path = {v.path: v for v in verdicts}
        for e in ctx.selection.entries:
            v = by_path.get(e.path)
            if v:
                e.status = v.level
        ctx.selection.refresh_status()
        self._fill()
        s = integrity.summarise(verdicts)
        lb = s["by_level"]
        self.summary.configure(text=logic.check_line(lb))
        self.report_btn.pack(side="left", padx=(theme.PAD_L, 0))
        ctx.progress.finish("Checked {:,} of {:,} files".format(len(verdicts), total),
                            len(verdicts) / max(total, 1))
        if len(verdicts) < total:
            con.log("  Stopped early: %d of %d files listened to." % (len(verdicts), total), "warn")
        con.log("  " + workflow.format_check_counts(s), "ok" if not lb["fail"] else "bad")
        for w in s["worst"][:8]:
            con.log("  [%s] %s -- %s" % (w["level"], os.path.basename(w["path"]), "; ".join(w["reasons"][:2])),
                    "bad" if w["level"] == "fail" else "warn")
        if len(s["worst"]) > 8:
            con.log("  ...and more in the table above.", "dim")
        con.final_banner(lb["fail"] == 0)
        ctx.refresh()

    # ------------------------------------------------------------ table
    def _fill(self) -> None:
        """Rebuild the table in slices so thousands of rows never block the window."""
        if self._fill_job is not None:
            self.tree.after_cancel(self._fill_job)
            self._fill_job = None
        self.tree.delete(*self.tree.get_children())
        self.shown = logic.sort_results(self.verdicts, *self.sort)
        self._fill_from(0)

    def _fill_from(self, start: int) -> None:
        end = min(start + theme.BATCH_ROWS, len(self.shown))
        for i in range(start, end):
            v = self.shown[i]
            self.tree.insert("", "end", iid=str(i), tags=(v.level,), values=logic.result_row(v))
        self._fill_job = self.tree.after(1, self._fill_from, end) if end < len(self.shown) else None

    def _sort_by(self, col: str) -> None:
        key, rev = self.sort
        self.sort = (col, (not rev) if key == col else False)
        self._fill()

    def _detail(self, ev: tk.Event) -> None:
        iid = self.tree.identify_row(ev.y)
        if not iid:
            return
        v = self.shown[int(iid)]
        body = "\n".join("• " + r for r in v.reasons) or "Nothing wrong found."
        self.ctx.ask("%s %s" % (logic.STATUS_ICON.get(v.level, ""), os.path.basename(v.path)),
                     body + "\n\n%s\nChecked by: %s" % (v.path, v.engine), ("OK",),
                     colour=LEVEL_COLOUR.get(v.level, theme.ACCENT), width=620)

    def _report(self) -> None:
        if not self.verdicts:
            return
        p = filedialog.asksaveasfilename(title="Save the integrity report", defaultextension=".csv",
                                         initialfile="integrity-report.csv",
                                         filetypes=[("CSV", "*.csv"), ("All files", "*.*")])
        if not p:
            return
        try:
            txt = integrity.write_report(self.verdicts, p)
        except OSError as e:
            self.ctx.tell("Could not save that", str(e), theme.BAD)
            return
        self.ctx.console.log("  Report saved: %s (and a summary: %s)" % (p, txt), "ok")
