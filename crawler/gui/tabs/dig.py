"""Dig tab: the original library scan. A folder, Start, Stop; nothing else up front."""
from __future__ import annotations

import json
import os
import random
import tkinter as tk
from tkinter import filedialog

import scanner
from .. import system, theme
from ..logic import human_time
from ..ui import Collapsible, button, check, entry, heading, label
from .base import Tab

# Shown when a scan finishes, picked at random so running it twice is not a vending machine.
CHEERS = [
    ("Rich seam.", "{n:,} tracks hauled up out of the dark.\n\nThe good stuff:\n{out}\n\n"
                   "Send that back and your shift is over. Go have a biscuit."),
    ("Beautiful haul.", "{n:,} tracks catalogued and not one of them harmed.\n\nHere it is:\n{out}\n\n"
                        "Ship it over, put your feet up, you absolute legend."),
    ("All dug out.", "{n:,} tracks, every one present and accounted for.\n\nYour nugget:\n{out}\n\n"
                     "Fire it back whenever. That is the whole job."),
    ("Groovy.", "{n:,} tracks read, zero moved, zero harmed.\n\nIt lives here:\n{out}\n\n"
                "Bung that back to Ian and you are a free person."),
]


class DigTab(Tab):
    key = "dig"
    uses_selection = False

    def build(self, parent: tk.Frame) -> None:
        self.frame = parent
        heading(parent, "Scan a music library", "info_dig").pack(anchor="w")
        label(parent, "Library folder").pack(anchor="w", pady=(theme.PAD, 0))
        row = tk.Frame(parent, bg=theme.BG)
        row.pack(fill="x", pady=(theme.PAD_S, 0))
        self.path_var = tk.StringVar(value=system.app_dir())
        self.path_entry = entry(row, self.path_var, "dig_folder")
        self.path_entry.pack(side="left", fill="x", expand=True, ipady=5)
        self.browse_btn = button(row, "Browse", self._browse, "dig_browse")
        self.browse_btn.pack(side="left", padx=(theme.PAD, 0))
        ctl = tk.Frame(parent, bg=theme.BG)
        ctl.pack(fill="x", pady=(theme.PAD_L, 0))
        self.go_btn = button(ctl, "Start digging", self._go, "dig_go", primary=True)
        self.go_btn.pack(side="left")
        self.make_stop(ctl)
        self.adv = Collapsible(parent, "Advanced", self.ctx.settings, "adv_dig", self.ctx.relayout)
        self.adv.pack(anchor="w", pady=(theme.PAD_L, 0))
        self.cache_var = tk.BooleanVar(value=True)
        check(self.adv.body, "Reuse previous scan for unchanged files", self.cache_var,
              "dig_cache").pack(anchor="w")

    def primary_button(self):
        return self.go_btn

    def set_busy(self, busy: bool) -> None:
        if self.frame is None:
            return
        for w in (self.go_btn, self.browse_btn, self.path_entry):
            self.enable(w, not busy)
        self.show_stop(busy)

    def _browse(self) -> None:
        d = filedialog.askdirectory(initialdir=self.path_var.get() or system.app_dir(),
                                    title="Select the library root folder")
        if d:
            self.path_var.set(os.path.normpath(d))

    def _go(self) -> None:
        root_dir = self.path_var.get().strip()
        if not os.path.isdir(root_dir):
            self.ctx.tell("Nothing down there but rock.",
                          "Point me at the folder with all the music in it and we'll have another go.")
            return
        con = self.ctx.console
        con.log("", "dim")
        con.log("  Headlamp on. Digging into " + root_dir, "ok")
        self.ctx.run_job("dig", self._work, root_dir, self.cache_var.get())

    def _work(self, root_dir: str, use_cache: bool) -> None:
        ctx = self.ctx
        doc = scanner.scan(root_dir, progress=lambda done, total, cur: ctx.post_progress(done, total, cur),
                           should_stop=ctx.stop_flag.is_set, use_cache=use_cache)
        out = os.path.join(system.app_dir(), scanner.output_filename(doc["root_name"]))
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        ctx.ui(self._done, doc, out)

    def _done(self, doc: dict, out: str) -> None:
        ctx, con = self.ctx, self.ctx.console
        ctx.end()
        c = doc["counts"]
        ctx.progress.finish("{:,} files".format(c["media"]))
        ctx.progress.eta.configure(text="done in " + human_time(doc["elapsed_sec"]))
        if doc.get("partial"):
            con.log("  Called it early -- the haul below is partial.", "bad")
        con.log("  Struck it: {:,} tracks across {:,} seams, {:,} carrying tags, {:,} duds".format(
            c["media"], c["dirs"], c["with_tags"], c["errors"]), "ok")
        con.log("  " + ", ".join((k or "no ext") + " " + str(v) for k, v in list(c["by_ext"].items())[:6]), "dim")
        if c["excluded"]:
            con.log("  Left {:,} bits of gravel where they lay (cover art, Thumbs.db, playlists...)".format(
                c["excluded"]), "dim")
        con.log("  Bagged up: " + out, "ok")
        con.log("  Send that file back. You are done. \\o/", "ok")
        con.final_banner(True)
        heading_text, body = random.choice(CHEERS)
        ctx.ask(heading_text, body.format(n=c["media"], out=out), ("OK",), theme.OK)
