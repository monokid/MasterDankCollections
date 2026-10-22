"""MasterDankCollections crawler -- GUI front end.

Drop the exe in the library root, double-click, hit Scan, send back the .json
it writes next to itself. The scan reports what is on disk and nothing more;
every decision about what the folders *mean* happens later, elsewhere.
"""
from __future__ import annotations

import json
import os
import queue
import random
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import banner
import scanner
from widgets import (BANNER_FONTS, MONO_FONTS, CosmicBar, FunkyTitle,
                     hsv_hex, pick_font)

APP_TITLE = "Mining for Dank"

BG = "#0b0a1a"
PANEL = "#151233"
FG = "#e8e4ff"
DIM = "#8f88c4"
ACCENT = "#b388ff"
OK = "#7cf5c4"
BAD = "#ff7b9c"
ART = "#5b4f9e"

# Shown when a scan finishes. Picked at random so running it twice does not
# feel like talking to a vending machine.
CHEERS = [
    ("Rich seam.", "{n:,} tracks hauled up out of the dark.\n\nThe good stuff:\n{out}\n\n"
                   "Send that back and your shift is over. Go have a biscuit."),
    ("Beautiful haul.", "{n:,} tracks catalogued and not one of them harmed.\n\nHere it is:\n{out}\n\n"
                        "Ship it over, put your feet up, you absolute legend."),
    ("All dug out.", "{n:,} tracks, every one present and accounted for.\n\nYour nugget:\n{out}\n\n"
                     "Fire it back whenever. That is the whole job."),
    ("Groovy.", "{n:,} tracks read, zero moved, zero harmed.\n\nIt lives here:\n{out}\n\n"
                "Bung that back to Ian and you are a free person.")
]


def app_dir() -> str:
    """Where the exe (or script) lives -- the default library root."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def human_time(sec) -> str:
    if sec is None or sec < 0:
        return "--"
    sec = int(sec)
    if sec < 60:
        return "%ds" % sec
    if sec < 3600:
        return "%dm %02ds" % (sec // 60, sec % 60)
    return "%dh %02dm" % (sec // 3600, (sec % 3600) // 60)


class CrawlerApp:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.worker = None
        self.stop_flag = threading.Event()
        self.started_at = 0.0
        self.last_ui = 0.0

        root.title(APP_TITLE)
        root.configure(bg=BG)
        root.geometry("980x760")
        root.minsize(680, 560)
        # Maximised rather than true fullscreen: -fullscreen takes the title bar
        # with it, and a window someone cannot obviously close is a hostile
        # thing to send to a friend.
        try:
            root.state("zoomed")
        except tk.TclError:
            root.attributes("-zoomed", True)

        self._build_style()
        self._build_widgets()
        self.root.after(80, self._drain)

    def _build_style(self):
        st = ttk.Style()
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        st.configure("TFrame", background=BG)
        st.configure("TLabel", background=BG, foreground=FG)
        st.configure("Dim.TLabel", background=BG, foreground=DIM)
        st.configure("TButton", background=PANEL, foreground=FG, borderwidth=0,
                     focuscolor=BG, padding=(14, 7))
        st.map("TButton",
               background=[("active", ACCENT), ("disabled", "#221f45")],
               foreground=[("active", BG), ("disabled", DIM)])
        st.configure("TEntry", fieldbackground=PANEL, foreground=FG,
                     insertcolor=FG, borderwidth=0)

    def _build_widgets(self):
        pad = {"padx": 20}

        title = FunkyTitle(self.root, "Mining for Dank", BG, size=30)
        title.pack(anchor="w", pady=(14, 12), **pad)

        row = ttk.Frame(self.root)
        row.pack(fill="x", **pad)
        ttk.Label(row, text="Library folder", style="Dim.TLabel").pack(anchor="w")
        sub = ttk.Frame(row)
        sub.pack(fill="x", pady=(4, 0))
        self.path_var = tk.StringVar(value=app_dir())
        self.path_entry = ttk.Entry(sub, textvariable=self.path_var)
        self.path_entry.pack(side="left", fill="x", expand=True, ipady=5)
        ttk.Button(sub, text="Browse",
                   command=self._browse).pack(side="left", padx=(8, 0))

        ctl = ttk.Frame(self.root)
        ctl.pack(fill="x", pady=(16, 0), **pad)
        self.scan_btn = ttk.Button(ctl, text="Start digging", command=self._start)
        self.scan_btn.pack(side="left")
        self.stop_btn = ttk.Button(ctl, text="Stop", command=self._stop,
                                   state="disabled")
        self.stop_btn.pack(side="left", padx=(8, 0))
        self.cache_var = tk.BooleanVar(value=True)
        tk.Checkbutton(ctl, text="Reuse previous scan for unchanged files",
                       variable=self.cache_var, bg=BG, fg=DIM, selectcolor=PANEL,
                       activebackground=BG, activeforeground=FG, borderwidth=0,
                       highlightthickness=0).pack(side="left", padx=(14, 0))

        self.bar = CosmicBar(self.root, trough=PANEL, height=18)
        self.bar.pack(fill="x", pady=(16, 5), **pad)

        stat = ttk.Frame(self.root)
        stat.pack(fill="x", **pad)
        self.count_lbl = ttk.Label(stat, text="Idle", style="Dim.TLabel")
        self.count_lbl.pack(side="left")
        self.eta_lbl = ttk.Label(stat, text="", style="Dim.TLabel")
        self.eta_lbl.pack(side="right")

        wrap = tk.Frame(self.root, bg=PANEL, highlightthickness=0)
        wrap.pack(fill="both", expand=True, pady=(14, 18), **pad)
        mono = pick_font(MONO_FONTS, "Courier")
        self.log = tk.Text(wrap, bg=PANEL, fg=FG, insertbackground=FG,
                           borderwidth=0, font=(mono, 9), wrap="none",
                           height=8, state="disabled")
        sb = ttk.Scrollbar(wrap, command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log.pack(side="left", fill="both", expand=True, padx=8, pady=8)
        self.log.tag_configure("ok", foreground=OK)
        self.log.tag_configure("bad", foreground=BAD)
        self.log.tag_configure("dim", foreground=DIM)
        self.log.tag_configure("art", foreground=ART)
        self.banner_font = (pick_font(BANNER_FONTS, mono), 9)

        self._paint_banner()
        for line in banner.READY:
            self._log(line, "dim")
        self._log("  Cave mouth: " + app_dir(), "dim")
        self._log("  Say the word.", "dim")
        # The banner is tall; keep it in frame rather than scrolling past it.
        self.log.yview_moveto(0.0)

    def _paint_banner(self):
        """Stars stay dim; the letters take the same hue ramp as the progress
        bar, running top to bottom."""
        lines = banner.BANNER
        last = max(len(lines) - 1, 1)
        for i, line in enumerate(lines):
            tag = "bnr%d" % i
            lit = any(c in line for c in "█║═")
            self.log.tag_configure(
                tag, font=self.banner_font,
                foreground=(hsv_hex(0.88 - (i / last) * 0.46, 0.55, 1.0)
                            if lit else ART))
            self._log(line, tag)

    def _log(self, msg, tag=""):
        self.log.configure(state="normal")
        self.log.insert("end", msg + "\n", tag)
        self.log.see("end")
        self.log.configure(state="disabled")

    def _browse(self):
        d = filedialog.askdirectory(initialdir=self.path_var.get() or app_dir(),
                                    title="Select the library root folder")
        if d:
            self.path_var.set(os.path.normpath(d))

    def _start(self):
        root_dir = self.path_var.get().strip()
        if not os.path.isdir(root_dir):
            messagebox.showerror(
                APP_TITLE,
                "Nothing down there but rock.\n\n"
                "Point me at the folder with all the music in it and "
                "we'll have another go.")
            return
        self.stop_flag.clear()
        self.scan_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.path_entry.configure(state="disabled")
        self.bar.set_value(0)
        self.eta_lbl.configure(text="")
        self.started_at = time.time()
        self._log("", "dim")
        self._log("  Headlamp on. Digging into " + root_dir, "ok")
        self.worker = threading.Thread(target=self._run, args=(root_dir,),
                                       daemon=True)
        self.worker.start()

    def _stop(self):
        self.stop_flag.set()
        self._log("  Downing tools after this one...", "dim")

    def _run(self, root_dir):
        def progress(done, total, current):
            self.q.put(("progress", done, total, current))

        try:
            doc = scanner.scan(root_dir, progress=progress,
                               should_stop=self.stop_flag.is_set,
                               use_cache=self.cache_var.get())
            out = os.path.join(app_dir(),
                               scanner.output_filename(doc["root_name"]))
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
            self.q.put(("done", doc, out))
        except Exception as e:
            self.q.put(("fail", "%s: %s" % (type(e).__name__, e)))

    def _drain(self):
        try:
            while True:
                msg = self.q.get_nowait()
                kind = msg[0]
                if kind == "progress":
                    self._on_progress(msg[1], msg[2], msg[3])
                elif kind == "done":
                    self._on_done(msg[1], msg[2])
                elif kind == "fail":
                    self._on_fail(msg[1])
        except queue.Empty:
            pass
        self.root.after(80, self._drain)

    def _on_progress(self, done, total, current):
        now = time.time()
        if total and now - self.last_ui < 0.08 and done < total:
            return
        self.last_ui = now
        if not total:
            self.bar.start()
            self.count_lbl.configure(text=current)
            return
        self.bar.stop()
        self.bar.set_value(done / total)
        self.count_lbl.configure(text="{:,} / {:,} files".format(done, total))
        elapsed = now - self.started_at
        if done > 30:
            remaining = elapsed / done * (total - done)
            self.eta_lbl.configure(text="about " + human_time(remaining) + " left")

    def _reset_controls(self):
        self.scan_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.path_entry.configure(state="normal")
        self.bar.stop()

    def _on_done(self, doc, out):
        self._reset_controls()
        c = doc["counts"]
        self.bar.set_value(1.0)
        self.count_lbl.configure(text="{:,} files".format(c["media"]))
        self.eta_lbl.configure(text="done in " + human_time(doc["elapsed_sec"]))
        if doc.get("partial"):
            self._log("  Called it early -- the haul below is partial.", "bad")
        self._log("  Struck it: {:,} tracks across {:,} seams, {:,} carrying tags, "
                  "{:,} duds".format(c["media"], c["dirs"], c["with_tags"],
                                     c["errors"]), "ok")
        top = ", ".join((k or "no ext") + " " + str(v)
                        for k, v in list(c["by_ext"].items())[:6])
        self._log("  " + top, "dim")
        if c["excluded"]:
            self._log("  Left {:,} bits of gravel where they lay "
                      "(cover art, Thumbs.db, playlists...)".format(c["excluded"]),
                      "dim")
        self._log("  Bagged up: " + out, "ok")
        self._log("  Send that file back. You are done. \\o/", "ok")

        heading, body = random.choice(CHEERS)
        messagebox.showinfo(heading, body.format(n=c["media"], out=out))

    def _on_fail(self, err):
        self._reset_controls()
        self._log("  Hit a rock: " + err, "bad")
        messagebox.showerror(
            "Well, that's embarrassing",
            "The scan tripped over something and stopped:\n\n" + err +
            "\n\nNot your fault. Send this message to Ian and he'll sort it.")


def run_cli(argv):
    # A --windowed build has no console attached, so sys.stdout is None and any
    # print() would abort the scan. Keep CLI mode usable from the exe anyway.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = sys.stdout

    root_dir = argv[0] if argv else app_dir()
    last = [0.0]

    def progress(done, total, current):
        now = time.time()
        if now - last[0] < 0.5 and done < total:
            return
        last[0] = now
        pct = (done * 100.0 / total) if total else 0
        print("  {:,}/{:,} ({:.0f}%)".format(done, total, pct), end="\r", flush=True)

    doc = scanner.scan(root_dir, progress=progress)
    out = os.path.join(os.getcwd(), scanner.output_filename(doc["root_name"]))
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    c = doc["counts"]
    print("\n{:,} media files, {:,} dirs, {:,} tagged, {:,} errors in {}s".format(
        c["media"], c["dirs"], c["with_tags"], c["errors"], doc["elapsed_sec"]))
    print("by ext:   " + str(c["by_ext"]))
    print("excluded: {:,} non-media {}".format(c["excluded"], c["excluded_by_ext"]))
    print("saved:    " + out)
    return doc


def main():
    if "--cli" in sys.argv:
        args = [a for a in sys.argv[1:] if a != "--cli"]
        run_cli(args)
        return
    root = tk.Tk()
    CrawlerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
