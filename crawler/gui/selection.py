"""The shared playlist folder and file list that Cloak, Check and Spotify all work on.

Large folders must never freeze the window, so a scan result is inserted into the
Treeview in slices (one `after` each), and track lengths are read on a background
thread and delivered in batches.
"""
from __future__ import annotations

import os
import threading
import time
import tkinter as tk
from tkinter import filedialog
from typing import Callable

import workflow
from . import logic, theme
from .context import Context
from .logic import STATUS_ICON, TICK, UNTICK, plural
from .tooltip import HELP, heading_resolver, tip_regions
from .ui import button, entry, label, scrolled_tree

COLUMNS = ("inc", "n", "name", "phase", "dur", "st")
_BASE_COLUMNS = ("inc", "n", "name", "dur", "st")


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%d %s" % (n, unit) if unit == "B" else "%.1f %s" % (n, unit)
        n /= 1024
    return ""


class SelectionPanel:
    def __init__(self, ctx: Context):
        self.ctx = ctx
        self.sel: workflow.Selection | None = None
        self.entries: list[workflow.FileEntry] = []
        self.by_iid: dict[str, workflow.FileEntry] = {}
        self._token = 0
        self._drag: str | None = None
        self.on_loaded: list[Callable[[], None]] = []
        self.frame: tk.Frame = None                # type: ignore[assignment]

    # ------------------------------------------------------------ build
    def build(self, parent: tk.Misc) -> tk.Frame:
        f = self.frame = tk.Frame(parent, bg=theme.BG)
        label(f, "Playlist folder").pack(anchor="w")
        row = tk.Frame(f, bg=theme.BG)
        row.pack(fill="x", pady=(theme.PAD_S, 0))
        self.var = tk.StringVar()
        self.entry = entry(row, self.var, "sel_folder")
        self.entry.pack(side="left", fill="x", expand=True, ipady=5)
        self.entry.bind("<Return>", lambda _e: (self.load(force=True), "break")[1])
        self.entry.bind("<FocusOut>", lambda _e: self.load(quiet=True))
        self.browse_btn = button(row, "Browse", self._browse, "sel_browse")
        self.browse_btn.pack(side="left", padx=(theme.PAD, 0))

        info = tk.Frame(f, bg=theme.BG)
        info.pack(fill="x", pady=(6, 4))
        self.summary = label(info, "Pick the folder holding the playlist.")
        self.summary.pack(side="left")
        self.more_btn = button(info, "⋯", self._more_menu, "sel_more", small=True)
        self.more_btn.pack(side="right")
        self.down_btn = button(info, "▼", lambda: self.move(1), "sel_down", small=True)
        self.down_btn.pack(side="right", padx=(0, theme.PAD_S))
        self.up_btn = button(info, "▲", lambda: self.move(-1), "sel_up", small=True)
        self.up_btn.pack(side="right", padx=(0, theme.PAD_S))

        self.phases_var = tk.BooleanVar(value=True)
        self.menu = tk.Menu(f, tearoff=0, bg=theme.PANEL, fg=theme.FG, activebackground=theme.ACCENT,
                            activeforeground=theme.BG, borderwidth=0, disabledforeground=theme.GREY)
        self.menu.add_command(label="Tick all", command=lambda: self.tick_all(True))
        self.menu.add_command(label="Untick all", command=lambda: self.tick_all(False))
        self.menu.add_separator()
        self.menu.add_command(label="Sort by name", command=lambda: self.sort_by_name(False))
        self.menu.add_command(label="Reverse order", command=self.reverse)
        self.menu.add_separator()
        self.menu.add_checkbutton(label="Subfolders are phases", variable=self.phases_var,
                                  command=self.on_phases_toggle)

        self._build_tree(f)
        return f

    def _build_tree(self, f: tk.Frame) -> None:
        wrap, self.tree = scrolled_tree(
            f, COLUMNS, (34, 44, 380, 130, 70, 52),
            ((TICK, "center"), ("#", "e"), ("Name", "w"), ("Phase", "w"), ("Length", "e"),
             ("Check", "center")), theme.SELECTION_ROWS, "extended", stretch=("name",))
        wrap.pack(fill="x")
        self.tree.configure(displaycolumns=_BASE_COLUMNS)
        heads = {"inc": "col_inc", "n": "col_n", "name": "col_name", "phase": "col_phase",
                 "dur": "col_dur", "st": "col_st"}
        heading_hit = heading_resolver(self.tree, heads)

        def hit(e: tk.Event):
            h = heading_hit(e)
            if h:
                return h
            iid = self.tree.identify_row(e.y)
            ent = self.by_iid.get(iid)
            if not ent:
                return ("blank", HELP["sel_tree"])
            text = "%s · %s\n%s" % (ent.fmt or "?", human_size(ent.size), ent.path)
            return (iid, text)
        tip_regions(self.tree, hit, list(heads.values()))
        self.tree.bind("<Configure>", lambda _e: self._fit_name_column(), add="+")
        self.tree.bind("<Button-1>", self._click, add="+")
        self.tree.bind("<B1-Motion>", self._drag_motion)
        self.tree.bind("<ButtonRelease-1>", self._release)
        self.tree.bind("<space>", self._space)

    def cancel(self) -> None:
        """Abandon any scan or length-reading still in flight (a newer token wins)."""
        self._token += 1

    # ------------------------------------------------------------ queries
    def included(self) -> list:
        return [e for e in self.entries if e.include]

    @property
    def folder(self) -> str:
        return self.sel.folder if self.sel else ""

    def phases_from_folders(self) -> bool:
        return bool(self.sel and self.sel.has_subfolders and self.phases_var.get())

    # ------------------------------------------------------------ loading
    def _browse(self) -> None:
        d = filedialog.askdirectory(initialdir=self.var.get() or os.path.expanduser("~"),
                                    title="Select the playlist folder")
        if d:
            self.var.set(os.path.normpath(d))
            self.load()

    def load(self, quiet: bool = False, force: bool = False) -> None:
        folder = self.var.get().strip().strip('"')
        if not folder or self.ctx.busy:
            return
        if (not force and self.sel
                and os.path.normcase(os.path.abspath(folder)) == os.path.normcase(self.sel.folder)):
            return
        if not os.path.isdir(folder):
            if not quiet:
                self.ctx.tell("Nothing down there but rock.",
                              "That folder does not exist. Point me at the folder with the "
                              "playlist in it.")
            return
        self._token += 1
        token = self._token
        self.summary.configure(text="Counting what is in there...")
        self.ctx.console.log("  Looking through " + folder, "dim")

        def run() -> None:
            try:
                sel = workflow.scan_selection(folder)
            except Exception as e:  # noqa: BLE001
                self.ctx.ui(self._failed, "%s: %s" % (type(e).__name__, e))
                return
            self.ctx.ui(self._loaded, token, sel)
        threading.Thread(target=run, daemon=True).start()

    def _failed(self, err: str) -> None:
        self.summary.configure(text="Could not read that folder.")
        self.ctx.console.log("  Could not read the folder: " + err, "bad")

    def _loaded(self, token: int, sel: workflow.Selection) -> None:
        if token != self._token:
            return
        self.sel = sel
        self.entries = list(sel.entries)
        self.by_iid = {e.path: e for e in self.entries}
        self.phases_var.set(sel.has_subfolders)
        self.menu.entryconfigure("Subfolders are phases", state="normal" if sel.has_subfolders else "disabled")
        self._show_phase_column()
        self.tree.delete(*self.tree.get_children())
        self.summary.configure(text="Reading %s..." % plural(len(self.entries), "file"))
        self._insert(token, 0)

    def _insert(self, token: int, start: int) -> None:
        """Insert one slice of rows, then yield to the event loop for the next."""
        if token != self._token:
            return
        end = min(start + theme.BATCH_ROWS, len(self.entries))
        phases = self.phases_var.get()
        for i in range(start, end):
            e = self.entries[i]
            self.tree.insert("", "end", iid=e.path, values=self._row(e, i + 1, phases),
                             tags=((e.status,) if e.status else ()))
        if end < len(self.entries):
            self.ctx.root.after(1, self._insert, token, end)
        else:
            self._finish_load(token)

    def _finish_load(self, token: int) -> None:
        sel, log = self.sel, self.ctx.console.log
        n = len(self.entries)
        if n:
            extra = " in %s" % plural(len(sel.subfolders), "phase folder") if sel.has_subfolders else ""
            log("  Found %s%s." % (plural(n, "audio file"), extra), "ok")
        else:
            log("  No audio files in there. Wrong folder?", "warn")
        if sel.non_audio:
            log("  (%d other files ignored: art, text, playlists...)" % sel.non_audio, "dim")
        if sel.duplicates_removed:
            log("  %s of the same file dropped." % plural(sel.duplicates_removed, "repeat"), "dim")
        if sel.truncated:
            log("  That is a LOT of files; I stopped at %d." % workflow.MAX_SCAN_FILES, "warn")
        dups = workflow.duplicate_groups(self.entries)
        if dups:
            log("  Heads up: %s appear twice with the same size (maybe the same track in two "
                "places). Untick the extras if so." % plural(len(dups), "name"), "warn")
        self.update_summary()
        for cb in self.on_loaded:
            cb()
        self.ctx.refresh()
        threading.Thread(target=self._read_durations, args=(token, list(self.entries)),
                         daemon=True).start()

    def _read_durations(self, token: int, entries: list) -> None:
        """Worker: read every length, handing results to the UI a batch at a time."""
        batch: list[tuple[str, float | None]] = []
        last = time.monotonic()
        for e in entries:
            if token != self._token:
                return
            e.duration = workflow.read_duration(e.path)
            batch.append((e.path, e.duration))
            if len(batch) >= 50 or time.monotonic() - last > 0.15:
                self.ctx.ui(self._apply_durations, token, batch)
                batch, last = [], time.monotonic()
        if batch:
            self.ctx.ui(self._apply_durations, token, batch)
        self.ctx.ui(self.update_summary)

    def _apply_durations(self, token: int, batch: list) -> None:
        if token != self._token:
            return
        tree = self.tree
        for iid, dur in batch:
            if tree.exists(iid):
                tree.set(iid, "dur", workflow.human_duration(dur))

    # ------------------------------------------------------------ rows
    @staticmethod
    def _row(e: workflow.FileEntry, n: int, phases: bool) -> tuple:
        return (TICK if e.include else UNTICK, n, e.name, e.subfolder if phases else "",
                workflow.human_duration(e.duration) if e.duration is not None else "...",
                STATUS_ICON.get(e.status, ""))

    def _show_phase_column(self) -> None:
        show = bool(self.sel and self.sel.has_subfolders and self.phases_var.get())
        self.tree.configure(displaycolumns=COLUMNS if show else _BASE_COLUMNS)
        self._fit_name_column()

    def _fit_name_column(self) -> None:
        """Give the Name column whatever the fixed columns leave. Tk only stretches on a
        resize, so without this the Phase column pushes Length/Check off the right edge."""
        shown = self.tree.cget("displaycolumns")
        fixed = sum(int(self.tree.column(c, "width")) for c in shown if c != "name")
        room = self.tree.winfo_width() - fixed - 4
        if room > 120 and int(self.tree.column("name", "width")) != room:
            self.tree.column("name", width=room)

    def _renumber(self) -> None:
        for i, iid in enumerate(self.tree.get_children(), 1):
            self.tree.set(iid, "n", i)

    def _sync_order(self) -> None:
        self.entries = [self.by_iid[i] for i in self.tree.get_children()]
        self._renumber()

    def refresh_status(self) -> None:
        """Repaint the Check column and row colours after a Check or Cloak run."""
        for e in self.entries:
            if self.tree.exists(e.path):
                self.tree.set(e.path, "st", STATUS_ICON.get(e.status, ""))
                self.tree.item(e.path, tags=((e.status,) if e.status else ()))

    def update_summary(self) -> None:
        if self.sel is not None:
            self.summary.configure(text=workflow.summary_text(self.entries))
        self.ctx.refresh()

    # ------------------------------------------------------------ interaction
    def _set_included(self, entries: list, on: bool | None) -> None:
        for e in entries:
            e.include = (not e.include) if on is None else on
            if self.tree.exists(e.path):
                self.tree.set(e.path, "inc", TICK if e.include else UNTICK)
        self.update_summary()

    def _click(self, ev: tk.Event):
        row, col = self.tree.identify_row(ev.y), self.tree.identify_column(ev.x)
        self._drag = None
        if not row:
            return None
        if self.tree.column(col, "id") == "inc":
            if not self.ctx.busy:
                self._set_included([self.by_iid[row]], None)
            return "break"
        self._drag = row
        return None

    def _drag_motion(self, ev: tk.Event) -> None:
        if not self._drag or self.ctx.busy:
            return
        target = self.tree.identify_row(ev.y)
        if target and target != self._drag:
            self.tree.move(self._drag, "", self.tree.index(target))

    def _release(self, _ev: tk.Event) -> None:
        if self._drag:
            self._drag = None
            self._sync_order()

    def _space(self, _ev: tk.Event) -> None:
        if not self.ctx.busy:
            self._set_included([self.by_iid[i] for i in self.tree.selection()], None)

    def tick_all(self, on: bool) -> None:
        if not self.ctx.busy:
            self._set_included(self.entries, on)

    def _apply_order(self, order: list[str]) -> None:
        self.tree.set_children("", *order)
        self._sync_order()

    def move(self, delta: int) -> None:
        if self.ctx.busy:
            return
        order = logic.move_order(list(self.tree.get_children()), self.tree.selection(), delta)
        self._apply_order(order)
        sel = self.tree.selection()
        if sel:
            self.tree.see(sel[0])

    def sort_by_name(self, reverse: bool) -> None:
        if not self.ctx.busy:
            names = {e.path: e.name for e in self.entries}
            self._apply_order(logic.sorted_by_name(list(self.tree.get_children()), names, reverse))

    def reverse(self) -> None:
        if not self.ctx.busy:
            self._apply_order(list(reversed(self.tree.get_children())))

    def on_phases_toggle(self) -> None:
        self._show_phase_column()
        phases = self.phases_var.get()
        for e in self.entries:
            if self.tree.exists(e.path):
                self.tree.set(e.path, "phase", e.subfolder if phases else "")
        for cb in self.on_loaded:
            cb()

    def _more_menu(self) -> None:
        b = self.more_btn
        self.menu.tk_popup(b.winfo_rootx(), b.winfo_rooty() + b.winfo_height())

    def set_busy(self, busy: bool) -> None:
        state = "disabled" if busy else "normal"
        for w in (self.browse_btn, self.more_btn, self.up_btn, self.down_btn, self.entry):
            w.configure(state=state)
