"""MasterDankCollections crawler -- GUI front end (and a small CLI).

Four tabs share one selection bar and one console:
  Dig      scan a library folder into one JSON file (the original job, unchanged)
  Cloak    make an anonymised MIRROR COPY of a playlist (originals never touched)
  Check    integrity check, quick or deep
  Spotify  match the tracks on Spotify and create a playlist in your account

Threads never touch Tk: every worker posts a callable to `self.q` (see `ui()`),
and `_drain` runs them on the Tk thread. No token or secret is ever logged.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import random
import subprocess
import sys
import threading
import time
import tkinter as tk
import webbrowser
from tkinter import filedialog, messagebox, ttk

import banner
import cloak
import integrity
import scanner
import spotify_link
import workflow
from widgets import (ACCENT, ART, BAD, BANNER_FONTS, BG, DIM, FG, GREY, MONO_FONTS, OK, PANEL,
                     PANEL_HI, WARN, AnimStrip, CosmicBar, FunkyTitle, Ticker, hsv_hex, pick_font)

APP_TITLE = "DankCrawl"

# key, tab label, title wordmark, banner, flavour set
TABS = [
    ("dig", "\u26cf  Dig", "Mining for Dank", "dig", "dig"),
    ("cloak", "\U0001F47B  Cloak", "Cloaking the Dank", "cloak", "cloak"),
    ("check", "\U0001FA7A  Check", "Checking the Dank", "check", "check"),
    ("spotify", "\U0001F3A7  Spotify", "Orbiting the Dank", "orbit", "orbit"),
]

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

STATUS_ICON = {"ok": "\u2713", "warn": "\u26a0", "fail": "\u2717", "unsupported": "\u25cb", None: ""}
LEVEL_COLOUR = {"ok": OK, "warn": WARN, "fail": BAD, "unsupported": GREY}
LEVEL_ORDER = {"fail": 0, "warn": 1, "unsupported": 2, "ok": 3}
REDIRECT_URI = "http://127.0.0.1:%d/callback" % spotify_link.DEFAULT_PORTS[0]
KONAMI = ["Up", "Up", "Down", "Down", "Left", "Right", "Left", "Right", "b", "a"]

MODE_INFO = {
    "true": ("True anon", "Every file becomes anon_<random number>. Nothing but the audio survives."),
    "kinda": ("Kinda anon", "anon_<Person>_<Phase>_<number>: who it is for and where it sits in the "
                            "set, never what it is."),
    "switcheroo": ("Switcheroo", "Real names swapped for believable fakes, like "
                                 "'Carousel Satyr - Griffin the Gecko'."),
}


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


def open_path(path: str) -> None:
    """Show a folder/file in the OS file manager."""
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa: S606 - the user asked to open it
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:
        pass


class CrawlerApp:
    def __init__(self, root, link_factory=None):
        self.root = root
        self.q = queue.Queue()
        self.worker = None
        self.stop_flag = threading.Event()
        self.started_at = 0.0
        self.last_ui = 0.0
        self.busy = False
        self.job_kind = "dig"
        self.link_factory = link_factory or spotify_link.SpotifyLink
        self.callback_errors = 0
        self.test_mode = bool(os.environ.get("DANKCRAWL_AUTOQUIT_MS"))

        # selection state
        self.sel = None
        self.entries = []
        self.by_iid = {}
        self.sel_token = 0
        self.drag_iid = None
        self.out_auto = ""
        # per-tab state
        self.opened = set()
        self.sash_user = False
        self.cur_tab = "dig"
        self.last_cloak = None
        self.check_results = []
        self.check_sort = ("level", False)
        self.sp = None
        self.sp_matches = []
        self.sp_queries = None          # from a record.csv, else None = use the selection
        self.sp_playlist_url = None
        self.sp_state = None
        self.konami = []
        self.title_clicks = []
        self.typed = ""
        self._tags = set()

        root.title(APP_TITLE)
        root.configure(bg=BG)
        root.minsize(760, 620)
        self._place_window()
        root.report_callback_exception = self._on_tk_error

        self._build_style()
        self._build_widgets()
        root.protocol("WM_DELETE_WINDOW", self._on_close)
        root.bind("<Unmap>", lambda e: self._set_awake(False) if e.widget is root else None)
        root.bind("<Map>", lambda e: self._set_awake(True) if e.widget is root else None)
        root.bind("<FocusOut>", lambda e: root.after(120, self._check_focus))
        root.bind("<FocusIn>", lambda e: self._set_awake(True))
        root.bind("<KeyPress>", self._on_key)
        self.root.after(80, self._drain)

        ms = os.environ.get("DANKCRAWL_AUTOQUIT_MS")
        if ms and ms.isdigit():
            root.after(int(ms), self._on_close)

    # ------------------------------------------------------------ window, errors, lifecycle

    def _place_window(self):
        root = self.root
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        w, h = min(1120, sw - 60), min(980, sh - 90)
        if self.test_mode or os.environ.get("DANKCRAWL_TAB"):
            root.geometry("%dx%d+30+20" % (w, h))
            root.attributes("-topmost", True)
            self.saved = {}
            return
        self.saved = workflow.load_settings()
        geom = self.saved.get("geometry")
        root.geometry(geom if isinstance(geom, str) and geom else "%dx%d" % (w, h))
        # First run keeps the old behaviour (maximised); after that the last choice wins.
        # Maximised rather than true fullscreen: -fullscreen takes the title bar with it,
        # and a window someone cannot obviously close is a hostile thing to send to a friend.
        if self.saved.get("zoomed", True):
            try:
                root.state("zoomed")
            except tk.TclError:
                root.attributes("-zoomed", True)

    def _on_tk_error(self, exc, val, tb):
        import traceback
        self.callback_errors += 1
        traceback.print_exception(exc, val, tb)

    def _on_close(self):
        self.stop_flag.set()
        if not self.test_mode:
            try:
                st = dict(self.saved)
                zoomed = self.root.state() == "zoomed"
                st["zoomed"] = zoomed
                if not zoomed:
                    st["geometry"] = self.root.geometry()
                try:
                    st["sash"] = self.paned.sashpos(0)
                except tk.TclError:
                    pass
                workflow.save_settings(st)
            except Exception:
                pass
        self.root.destroy()

    def _set_awake(self, awake):
        self.strip.set_active(awake)

    def _check_focus(self):
        try:
            self._set_awake(self.root.focus_displayof() is not None
                            and self.root.state() != "iconic")
        except tk.TclError:
            pass

    def ui(self, fn, *args):
        """Thread-safe: run fn(*args) on the Tk thread."""
        self.q.put((fn, args))

    def _drain(self):
        try:
            for _ in range(300):
                fn, args = self.q.get_nowait()
                try:
                    fn(*args)
                except Exception:
                    import traceback
                    self.callback_errors += 1
                    traceback.print_exc()
        except queue.Empty:
            pass
        self.root.after(60, self._drain)

    # ------------------------------------------------------------ styling and small widgets

    def _build_style(self):
        st = ttk.Style()
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        st.configure("TFrame", background=BG)
        st.configure("TLabel", background=BG, foreground=FG)
        st.configure("Dim.TLabel", background=BG, foreground=DIM)
        st.configure("Head.TLabel", background=BG, foreground=ACCENT, font=("Segoe UI", 10, "bold"))
        st.configure("Ok.TLabel", background=BG, foreground=OK)
        st.configure("Warn.TLabel", background=BG, foreground=WARN)
        st.configure("Bad.TLabel", background=BG, foreground=BAD)
        st.configure("TButton", background=PANEL, foreground=FG, borderwidth=0,
                     focuscolor=BG, padding=(14, 7))
        st.map("TButton",
               background=[("active", ACCENT), ("disabled", PANEL_HI)],
               foreground=[("active", BG), ("disabled", DIM)])
        st.configure("Small.TButton", padding=(8, 3))
        st.configure("TEntry", fieldbackground=PANEL, foreground=FG,
                     insertcolor=FG, borderwidth=0)
        st.map("TEntry", fieldbackground=[("disabled", BG), ("readonly", PANEL)],
               foreground=[("disabled", DIM)])
        st.configure("TSpinbox", fieldbackground=PANEL, foreground=FG, arrowcolor=FG,
                     background=PANEL, insertcolor=FG, borderwidth=0)
        st.configure("TNotebook", background=BG, borderwidth=0, tabmargins=(0, 4, 0, 0),
                     lightcolor=BG, darkcolor=BG, bordercolor=BG)
        st.configure("TNotebook.Tab", background=PANEL, foreground=DIM, padding=(18, 8),
                     borderwidth=0, lightcolor=PANEL, bordercolor=BG)
        st.map("TNotebook.Tab",
               background=[("selected", ACCENT), ("active", PANEL_HI)],
               foreground=[("selected", BG), ("active", FG)])
        st.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=FG,
                     borderwidth=0, rowheight=22, lightcolor=PANEL, darkcolor=PANEL)
        st.map("Treeview", background=[("selected", "#3a3270")],
               foreground=[("selected", "#ffffff")])
        st.configure("Treeview.Heading", background=PANEL_HI, foreground=ACCENT,
                     relief="flat", borderwidth=0, padding=(6, 4))
        st.map("Treeview.Heading", background=[("active", "#2d2960")])
        for sbs in ("Vertical.TScrollbar", "TScrollbar"):
            st.configure(sbs, background="#3a3270", troughcolor=BG, arrowcolor=DIM,
                         bordercolor=BG, lightcolor="#3a3270", darkcolor="#3a3270", gripcount=0)
            st.map(sbs, background=[("active", ACCENT)])
        st.configure("TPanedwindow", background=BG)
        st.configure("Sash", sashthickness=8, gripcount=0, background=PANEL_HI)

    def _chk(self, parent, text, var, command=None):
        return tk.Checkbutton(parent, text=text, variable=var, command=command, bg=BG, fg=DIM,
                              selectcolor=PANEL, activebackground=BG, activeforeground=FG,
                              borderwidth=0, highlightthickness=0, anchor="w")

    def _radio(self, parent, text, var, value, command=None):
        return tk.Radiobutton(parent, text=text, variable=var, value=value, command=command,
                              bg=BG, fg=FG, selectcolor=PANEL, activebackground=BG,
                              activeforeground=ACCENT, borderwidth=0, highlightthickness=0,
                              anchor="w")

    def _lbl(self, parent, text="", style="Dim.TLabel", **kw):
        return ttk.Label(parent, text=text, style=style, **kw)

    def _scrolled_tree(self, parent, columns, widths, headings, height, selectmode="browse"):
        wrap = tk.Frame(parent, bg=PANEL)
        tree = ttk.Treeview(wrap, columns=columns, show="headings", height=height,
                            selectmode=selectmode)
        sb = ttk.Scrollbar(wrap, command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        for c, w, (text, anchor) in zip(columns, widths, headings):
            tree.heading(c, text=text, anchor=anchor)
            tree.column(c, width=w, minwidth=24, anchor=anchor, stretch=(w >= 200))
        sb.pack(side="right", fill="y")
        tree.pack(side="left", fill="both", expand=True)
        for lvl, col in LEVEL_COLOUR.items():
            tree.tag_configure(lvl, foreground=col)
        return wrap, tree

    # ------------------------------------------------------------ themed dialogs

    def _dialog(self, heading, body, buttons=("OK",), colour=ACCENT, width=540, default=None):
        """Modal dialog in the app's own colours. Returns the pressed label (None if closed)."""
        top = tk.Toplevel(self.root)
        top.title(APP_TITLE)
        top.configure(bg=BG)
        top.transient(self.root)
        result = [None]
        box = tk.Frame(top, bg=PANEL, padx=22, pady=18)
        box.pack(fill="both", expand=True, padx=14, pady=14)
        tk.Label(box, text=heading, bg=PANEL, fg=colour, font=("Segoe UI", 13, "bold"),
                 anchor="w", justify="left", wraplength=width).pack(fill="x")
        tk.Label(box, text=body, bg=PANEL, fg=FG, anchor="w", justify="left",
                 wraplength=width).pack(fill="x", pady=(10, 14))
        row = tk.Frame(box, bg=PANEL)
        row.pack(fill="x")

        def pick(label):
            result[0] = label
            top.destroy()
        for label in reversed(buttons):
            b = ttk.Button(row, text=label, command=lambda l=label: pick(l))
            b.pack(side="right", padx=(8, 0))
            if label == (default or buttons[0]):
                b.focus_set()
        top.protocol("WM_DELETE_WINDOW", top.destroy)
        top.bind("<Escape>", lambda _e: top.destroy())
        self._centre(top)
        top.grab_set()
        self.root.wait_window(top)
        return result[0]

    def _centre(self, top):
        top.update_idletasks()
        try:
            x = self.root.winfo_rootx() + (self.root.winfo_width() - top.winfo_width()) // 2
            y = self.root.winfo_rooty() + max(40, (self.root.winfo_height() - top.winfo_height()) // 3)
            top.geometry("+%d+%d" % (max(0, x), max(0, y)))
        except tk.TclError:
            pass

    def _tell(self, heading, body, colour=ACCENT):
        self._dialog(heading, body, ("OK",), colour)

    # ------------------------------------------------------------ layout

    def _build_widgets(self):
        root = self.root
        head = tk.Frame(root, bg=BG)
        head.pack(fill="x", padx=20, pady=(12, 0))
        self.title = FunkyTitle(head, TABS[0][2], BG, size=30)
        self.title.pack(anchor="w")
        self.title.bind("<Button-1>", self._on_title_click)
        self.strip = AnimStrip(root, BG, 40)
        self.strip.pack(fill="x", padx=20, pady=(4, 8))

        self.paned = ttk.PanedWindow(root, orient="vertical")
        self.paned.pack(fill="both", expand=True, padx=20, pady=(0, 14))
        upper = tk.Frame(self.paned, bg=BG)
        lower = tk.Frame(self.paned, bg=BG)
        self.paned.add(upper, weight=3)
        self.paned.add(lower, weight=2)

        self.sel_frame = tk.Frame(upper, bg=BG)
        self._build_selection(self.sel_frame)
        self.nb = ttk.Notebook(upper)
        self.nb.pack(fill="both", expand=True)
        self.tab_frames = {}
        for key, label, _t, _b, _f in TABS:
            f = tk.Frame(self.nb, bg=BG, padx=4, pady=10)
            self.tab_frames[key] = f
            self.nb.add(f, text=label)
        self._build_dig(self.tab_frames["dig"])
        self._build_cloak(self.tab_frames["cloak"])
        self._build_check(self.tab_frames["check"])
        self._build_spotify(self.tab_frames["spotify"])

        self._build_console(lower)
        self.nb.bind("<<NotebookTabChanged>>", self._on_tab_changed)
        self.paned.bind("<ButtonRelease-1>", lambda _e: setattr(self, "sash_user", True))

        # Opening state: the DIG banner, exactly as before.
        self._print_banner("dig")
        for line in banner.READY:
            self._log(line, "dim")
        self._log("  Cave mouth: " + app_dir(), "dim")
        self._log("  Say the word.", "dim")
        self.log.yview_moveto(0.0)
        self.opened.add("dig")

        self.root.after(150, self._finish_layout)

    def _finish_layout(self):
        """Things that need real window geometry."""
        self._place_sash(0)
        env_tab = os.environ.get("DANKCRAWL_TAB")
        keys = [t[0] for t in TABS]
        if env_tab in keys:
            self.nb.select(keys.index(env_tab))
        folder = os.environ.get("DANKCRAWL_FOLDER")
        if folder and os.path.isdir(folder):
            self.sel_var.set(folder)
            self._load_selection()
        show = os.environ.get("DANKCRAWL_SHOW")
        if show in ("success", "failure"):
            self._final_banner(show == "success")

    def _place_sash(self, tries):
        """Set the divider once the window has its real size (before that, h is ~1)."""
        h = self.paned.winfo_height()
        if h < 400 and tries < 30:
            self.root.after(100, self._place_sash, tries + 1)
            return
        saved = self.saved.get("sash")
        if isinstance(saved, int):
            self.sash_user = True       # the user dragged it in an earlier session: respect that
            try:
                self.paned.sashpos(0, max(200, min(saved, h - 200)))
            except tk.TclError:
                pass
        else:
            self._autosash()

    def _autosash(self):
        """Fit the divider to the tab on show, until the user drags it themselves."""
        if self.sash_user:
            return
        h = self.paned.winfo_height()
        if h < 400:
            return
        if self.cur_tab == "dig":
            need = 170
        else:
            need = self.sel_frame.winfo_reqheight() + self.nb.winfo_reqheight() + 10
        try:
            self.paned.sashpos(0, max(170, min(need, h - 240)))
        except tk.TclError:
            pass

    def _build_console(self, parent):
        stat_row = tk.Frame(parent, bg=BG)
        stat_row.pack(fill="x", pady=(2, 0))
        self.bar = CosmicBar(stat_row, trough=PANEL, height=18)
        self.bar.pack(fill="x", pady=(2, 5))
        stat = ttk.Frame(stat_row)
        stat.pack(fill="x")
        self.count_lbl = ttk.Label(stat, text="Idle", style="Dim.TLabel")
        self.count_lbl.pack(side="left")
        self.eta_lbl = ttk.Label(stat, text="", style="Dim.TLabel")
        self.eta_lbl.pack(side="right")

        wrap = tk.Frame(parent, bg=PANEL, highlightthickness=0)
        wrap.pack(fill="both", expand=True, pady=(6, 0))
        mono = pick_font(MONO_FONTS, "Courier")
        self.ticker = Ticker(wrap, PANEL, (mono, 9))
        self.ticker.pack(fill="x", padx=10, pady=(6, 0))
        inner = tk.Frame(wrap, bg=PANEL)
        inner.pack(fill="both", expand=True)
        self.log = tk.Text(inner, bg=PANEL, fg=FG, insertbackground=FG,
                           borderwidth=0, font=(mono, 9), wrap="none",
                           height=10, state="disabled")
        sb = ttk.Scrollbar(inner, command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log.pack(side="left", fill="both", expand=True, padx=8, pady=8)
        self.log.tag_configure("ok", foreground=OK)
        self.log.tag_configure("bad", foreground=BAD)
        self.log.tag_configure("warn", foreground=WARN)
        self.log.tag_configure("dim", foreground=DIM)
        self.log.tag_configure("art", foreground=ART)
        self.log.tag_configure("accent", foreground=ACCENT)
        self.banner_font = (pick_font(BANNER_FONTS, mono), 9)
        self.log.bind("<Button-1>", lambda _e: self.log.focus_set())
        self.log.bind("<Key>", self._on_log_key)

    # ------------------------------------------------------------ console

    def _log(self, msg, tag=""):
        self.log.configure(state="normal")
        self.log.insert("end", msg + "\n", tag)
        # The log is a scrollback, not an archive: trim the oldest lines.
        if int(self.log.index("end-1c").split(".")[0]) > 4000:
            self.log.delete("1.0", "1001.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    def say(self, msg, tag=""):
        """Thread-safe log line."""
        self.ui(self._log, msg, tag)

    def _banner_tag(self, name, kind, i, last):
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
                col = ACCENT
            else:
                col = ART
            self.log.tag_configure(tag, font=self.banner_font, foreground=col)
            self._tags.add(tag)
        return tag

    def _print_banner(self, name):
        """Paint a banner: stars stay dim, letters and sprite take a hue ramp top to bottom."""
        rows = banner.pieces(name)
        last = len(rows) - 1
        self.log.configure(state="normal")
        for i, row in enumerate(rows):
            for text, kind in row:
                self.log.insert("end", text, self._banner_tag(name, kind, i, last))
            self.log.insert("end", "\n", self._banner_tag(name, "star", i, last))
        self.log.configure(state="disabled")
        self.log.see("end")

    def _final_banner(self, success):
        self._print_banner("success" if success else "failure")
        if success:
            for line in banner.burst():
                self._log(line, "accent")

    def _on_log_key(self, e):
        if e.char and e.char.isprintable():
            self.typed = (self.typed + e.char.lower())[-4:]
            if self.typed == "dank":
                self.typed = ""
                for line in banner.POEM:
                    self._log(line, "accent")

    def _on_key(self, e):
        self.konami.append(e.keysym)
        self.konami = self.konami[-len(KONAMI):]
        if self.konami == KONAMI:
            self.konami = []
            self.bar.spin(4.0)
            self._log("  The spectrum spins. You know the code.", "accent")

    def _on_title_click(self, _e):
        now = time.monotonic()
        self.title_clicks = [t for t in self.title_clicks if now - t < 3.0] + [now]
        if len(self.title_clicks) >= 7:
            self.title_clicks = []
            self.strip.swarm(5.0)
            self._log("  The amoeba has had an idea. It has had several.", "accent")

    # ------------------------------------------------------------ jobs

    def _begin(self, kind):
        self.job_kind = kind
        self.stop_flag.clear()
        self.started_at = time.time()
        self.busy = True
        self.bar.set_value(0)
        self.eta_lbl.configure(text="")
        self.strip.set_busy(True)
        self.ticker.start(banner.FLAVOUR[kind])
        self._refresh_all()

    def _end(self):
        self.busy = False
        self.bar.stop()
        self.eta_lbl.configure(text="")
        self.strip.set_busy(False)
        self.ticker.stop()
        self._refresh_all()

    def _spawn(self, kind, fn, *args):
        self._begin(kind)

        def runner():
            try:
                fn(*args)
            except Exception as e:  # noqa: BLE001 - surfaced to the user, not swallowed
                self.ui(self._job_failed, "%s: %s" % (type(e).__name__, e))
        self.worker = threading.Thread(target=runner, daemon=True)
        self.worker.start()

    def _job_failed(self, err):
        self._end()
        self._log("  Hit a rock: " + err, "bad")
        self._final_banner(False)
        self._dialog("Well, that's embarrassing",
                     "That tripped over something and stopped:\n\n" + err +
                     "\n\nNot your fault. Send this message to Ian and he'll sort it.",
                     colour=BAD)

    def _stop(self):
        self.stop_flag.set()
        self._log("  Downing tools after this one...", "dim")

    def _on_progress(self, done, total, current, unit="files"):
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
        self.count_lbl.configure(text="{:,} / {:,} {}  {}".format(done, total, unit, current)
                                 if current else "{:,} / {:,} {}".format(done, total, unit))
        elapsed = now - self.started_at
        if done >= max(4, min(30, total // 10)) and done < total:
            self.eta_lbl.configure(
                text="about " + human_time(elapsed / done * (total - done)) + " left")

    def _refresh_all(self):
        free = not self.busy
        for b in self.stop_btns:
            b.configure(state="normal" if self.busy else "disabled")
        self.sel_browse.configure(state="normal" if free else "disabled")
        self._refresh_dig()
        self._refresh_cloak()
        self._refresh_check()
        self._refresh_spotify()

    @staticmethod
    def _en(widget, on):
        widget.configure(state="normal" if on else "disabled")

    # ------------------------------------------------------------ tabs

    def _on_tab_changed(self, _e=None):
        idx = self.nb.index(self.nb.select())
        key, _label, title, ban, _fl = TABS[idx]
        self.cur_tab = key
        self.title.set_text(title)
        if key == "dig":
            self.sel_frame.pack_forget()
        else:
            self.sel_frame.pack(fill="x", before=self.nb, pady=(0, 6))
        if key not in self.opened:
            self.opened.add(key)
            start = self.log.index("end-1c")
            self._print_banner(ban)
            for line in banner.TAB_READY.get(key, []):
                self._log(line, "dim")
            # Show the banner from its top rather than scrolled to its tail.
            self.log.yview(start)
        if key == "spotify":
            self._sp_refresh()
        self.root.after(60, self._autosash)
        if key == "check":
            self._refresh_check()
        if key == "cloak":
            self._update_example()

    # ============================================================ SELECTION

    def _build_selection(self, f):
        row = tk.Frame(f, bg=BG)
        row.pack(fill="x")
        self._lbl(row, "Playlist folder").pack(anchor="w")
        sub = tk.Frame(row, bg=BG)
        sub.pack(fill="x", pady=(4, 0))
        self.sel_var = tk.StringVar()
        self.sel_entry = ttk.Entry(sub, textvariable=self.sel_var)
        self.sel_entry.pack(side="left", fill="x", expand=True, ipady=5)
        self.sel_entry.bind("<Return>", lambda _e: self._load_selection(force=True))
        self.sel_entry.bind("<FocusOut>", lambda _e: self._load_selection(quiet=True))
        self.sel_browse = ttk.Button(sub, text="Browse", command=self._sel_browse)
        self.sel_browse.pack(side="left", padx=(8, 0))

        info = tk.Frame(f, bg=BG)
        info.pack(fill="x", pady=(6, 4))
        self.sel_summary = ttk.Label(info, text="Pick the folder holding the playlist.",
                                     style="Dim.TLabel")
        self.sel_summary.pack(side="left")
        self.phases_var = tk.BooleanVar(value=True)
        self.phases_chk = self._chk(info, "Subfolders are phases", self.phases_var,
                                    self._on_phases_toggle)
        self.phases_chk.pack(side="right")

        body = tk.Frame(f, bg=BG)
        body.pack(fill="x")
        cols = ("inc", "n", "name", "phase", "dur", "fmt", "st")
        wrap, self.tree = self._scrolled_tree(
            body, cols, (34, 40, 380, 130, 70, 60, 50),
            (("\u2611", "center"), ("#", "e"), ("File (drag to reorder)", "w"), ("Phase", "w"),
             ("Length", "e"), ("Format", "center"), ("Check", "center")), 5, "extended")
        wrap.pack(side="left", fill="x", expand=True)
        side = tk.Frame(body, bg=BG)
        side.pack(side="left", padx=(8, 0), anchor="n")
        for text, cmd in (("\u25b2 Up", lambda: self._move(-1)), ("\u25bc Down", lambda: self._move(1)),
                          ("Tick all", lambda: self._tick_all(True)),
                          ("Untick all", lambda: self._tick_all(False))):
            ttk.Button(side, text=text, command=cmd, style="Small.TButton").pack(fill="x", pady=2)
        self.tree.bind("<Button-1>", self._tree_click, add="+")
        self.tree.bind("<B1-Motion>", self._tree_drag)
        self.tree.bind("<ButtonRelease-1>", self._tree_release)
        self.tree.bind("<space>", self._tree_space)

    def _sel_browse(self):
        d = filedialog.askdirectory(initialdir=self.sel_var.get() or os.path.expanduser("~"),
                                    title="Select the playlist folder")
        if d:
            self.sel_var.set(os.path.normpath(d))
            self._load_selection()

    def _load_selection(self, quiet=False, force=False):
        folder = self.sel_var.get().strip().strip('"')
        if not folder or self.busy:
            return
        if not force and self.sel and os.path.normcase(os.path.abspath(folder)) == os.path.normcase(self.sel.folder):
            return
        if not os.path.isdir(folder):
            if not quiet:
                self._tell("Nothing down there but rock.",
                           "That folder does not exist. Point me at the folder with the playlist in it.")
            return
        self.sel_token += 1
        token = self.sel_token
        self.sel_summary.configure(text="Counting what is in there...")
        self._log("  Looking through " + folder, "dim")

        def run():
            try:
                sel = workflow.scan_selection(folder)
            except Exception as e:  # noqa: BLE001
                self.ui(self._sel_failed, "%s: %s" % (type(e).__name__, e))
                return
            self.ui(self._sel_loaded, token, sel)
        threading.Thread(target=run, daemon=True).start()

    def _sel_failed(self, err):
        self.sel_summary.configure(text="Could not read that folder.")
        self._log("  Could not read the folder: " + err, "bad")

    def _sel_loaded(self, token, sel):
        if token != self.sel_token:
            return
        self.sel = sel
        self.entries = sel.entries
        self.by_iid = {e.path: e for e in sel.entries}
        self.phases_var.set(sel.has_subfolders)
        self.phases_chk.configure(state="normal" if sel.has_subfolders else "disabled")
        self.tree.delete(*self.tree.get_children())
        for e in self.entries:
            self.tree.insert("", "end", iid=e.path, values=self._row(e, 0))
        self._renumber()
        self._update_summary()
        n = len(self.entries)
        if n:
            self._log("  Found %d audio file%s%s." % (
                n, "" if n == 1 else "s",
                " in %d phase folder%s" % (len(sel.subfolders), "" if len(sel.subfolders) == 1 else "s")
                if sel.has_subfolders else ""), "ok")
        else:
            self._log("  No audio files in there. Wrong folder?", "warn")
        if sel.non_audio:
            self._log("  (%d other files ignored: art, text, playlists...)" % sel.non_audio, "dim")
        if sel.duplicates_removed:
            self._log("  %d repeat%s of the same file dropped." % (
                sel.duplicates_removed, "" if sel.duplicates_removed == 1 else "s"), "dim")
        if sel.truncated:
            self._log("  That is a LOT of files; I stopped at %d." % workflow.MAX_SCAN_FILES, "warn")
        dups = workflow.duplicate_groups(self.entries)
        if dups:
            self._log("  Heads up: %d name%s appear twice with the same size (maybe the same "
                      "track in two places). Untick the extras if so." % (
                          len(dups), "" if len(dups) == 1 else "s"), "warn")
        self._autofill_output()
        self._update_example()
        self._refresh_all()
        threading.Thread(target=self._load_info, args=(token, list(self.entries)),
                         daemon=True).start()

    def _load_info(self, token, entries):
        for e in entries:
            if token != self.sel_token:
                return
            e.duration = workflow.read_duration(e.path)
            self.ui(self._info_loaded, token, e)
        self.ui(self._update_summary)

    def _info_loaded(self, token, e):
        if token == self.sel_token and self.tree.exists(e.path):
            self.tree.set(e.path, "dur", workflow.human_duration(e.duration))

    def _row(self, e, n):
        return ("\u2611" if e.include else "\u2610", n, e.name,
                e.subfolder if self.phases_var.get() else "",
                workflow.human_duration(e.duration) if e.duration is not None else "...",
                e.fmt, STATUS_ICON.get(e.status, ""))

    def _paint_row(self, e):
        if self.tree.exists(e.path):
            self.tree.item(e.path, tags=((e.status,) if e.status else ()))

    def _renumber(self):
        for i, iid in enumerate(self.tree.get_children(), 1):
            self.tree.set(iid, "n", i)
            e = self.by_iid[iid]
            self.tree.set(iid, "inc", "\u2611" if e.include else "\u2610")
            self.tree.set(iid, "st", STATUS_ICON.get(e.status, ""))
            self._paint_row(e)

    def _sync_order(self):
        self.entries = [self.by_iid[i] for i in self.tree.get_children()]
        self._renumber()

    def _update_summary(self):
        if self.sel is None:
            return
        self.sel_summary.configure(text=workflow.summary_text(self.entries))
        self._refresh_check()

    def _on_phases_toggle(self):
        for e in self.entries:
            if self.tree.exists(e.path):
                self.tree.set(e.path, "phase", e.subfolder if self.phases_var.get() else "")
        self._update_example()

    def _tree_click(self, ev):
        row = self.tree.identify_row(ev.y)
        col = self.tree.identify_column(ev.x)
        self.drag_iid = None
        if not row:
            return
        if col == "#1":
            if self.busy:
                return "break"
            e = self.by_iid[row]
            e.include = not e.include
            self._renumber()
            self._update_summary()
            self._refresh_all()
            return "break"
        self.drag_iid = row

    def _tree_drag(self, ev):
        if not self.drag_iid or self.busy:
            return
        target = self.tree.identify_row(ev.y)
        if target and target != self.drag_iid:
            self.tree.move(self.drag_iid, "", self.tree.index(target))

    def _tree_release(self, _ev):
        if self.drag_iid:
            self.drag_iid = None
            self._sync_order()

    def _tree_space(self, _ev):
        if self.busy:
            return
        for iid in self.tree.selection():
            e = self.by_iid[iid]
            e.include = not e.include
        self._renumber()
        self._update_summary()
        self._refresh_all()

    def _tick_all(self, on):
        if self.busy:
            return
        for e in self.entries:
            e.include = on
        self._renumber()
        self._update_summary()
        self._refresh_all()

    def _move(self, delta):
        if self.busy:
            return
        sel = set(self.tree.selection())
        kids = list(self.tree.get_children())
        order = [i for i in kids if i in sel]
        if delta > 0:
            order.reverse()
        for iid in order:
            i = self.tree.index(iid)
            j = i + delta
            if 0 <= j < len(kids) and kids[j] not in sel:
                self.tree.move(iid, "", j)
                kids = list(self.tree.get_children())
        self._sync_order()

    def _included(self):
        return [e for e in self.entries if e.include]

    def _need_files(self):
        if self.sel is None or not self._included():
            self._tell("Nothing to work on.",
                       "Pick a playlist folder above and make sure at least one file is ticked.")
            return False
        return True

    # ============================================================ DIG

    def _build_dig(self, f):
        self._lbl(f, "Library folder").pack(anchor="w")
        sub = ttk.Frame(f)
        sub.pack(fill="x", pady=(4, 0))
        self.path_var = tk.StringVar(value=app_dir())
        self.path_entry = ttk.Entry(sub, textvariable=self.path_var)
        self.path_entry.pack(side="left", fill="x", expand=True, ipady=5)
        self.dig_browse = ttk.Button(sub, text="Browse", command=self._browse)
        self.dig_browse.pack(side="left", padx=(8, 0))
        ctl = ttk.Frame(f)
        ctl.pack(fill="x", pady=(16, 0))
        self.scan_btn = ttk.Button(ctl, text="Start digging", command=self._start)
        self.scan_btn.pack(side="left")
        self.dig_stop = ttk.Button(ctl, text="Stop", command=self._stop, state="disabled")
        self.dig_stop.pack(side="left", padx=(8, 0))
        self.cache_var = tk.BooleanVar(value=True)
        self._chk(ctl, "Reuse previous scan for unchanged files", self.cache_var).pack(
            side="left", padx=(14, 0))
        self._lbl(f, "Scans names and tags into one small JSON file next to this app. "
                     "Nothing is moved, copied or uploaded.").pack(anchor="w", pady=(14, 0))
        self.stop_btns = [self.dig_stop]

    def _refresh_dig(self):
        free = not self.busy
        self._en(self.scan_btn, free)
        self._en(self.dig_browse, free)
        self._en(self.path_entry, free)

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
        self._log("", "dim")
        self._log("  Headlamp on. Digging into " + root_dir, "ok")
        self._spawn("dig", self._dig_run, root_dir, self.cache_var.get())

    def _dig_run(self, root_dir, use_cache):
        def progress(done, total, current):
            self.ui(self._on_progress, done, total, current)

        doc = scanner.scan(root_dir, progress=progress, should_stop=self.stop_flag.is_set,
                           use_cache=use_cache)
        out = os.path.join(app_dir(), scanner.output_filename(doc["root_name"]))
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        self.ui(self._on_done, doc, out)

    def _on_done(self, doc, out):
        self._end()
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
        self._final_banner(True)

        heading, body = random.choice(CHEERS)
        messagebox.showinfo(heading, body.format(n=c["media"], out=out))

    # ============================================================ CLOAK

    def _build_cloak(self, f):
        left = tk.Frame(f, bg=BG)
        left.pack(side="left", fill="both", expand=True)
        self._lbl(left, "How anonymous?", "Head.TLabel").pack(anchor="w")
        self.mode_var = tk.StringVar(value="true")
        for mode in ("true", "kinda", "switcheroo"):
            name, desc = MODE_INFO[mode]
            self._radio(left, name, self.mode_var, mode, self._update_example).pack(anchor="w")
            self._lbl(left, "      " + desc).pack(anchor="w")
        row = tk.Frame(left, bg=BG)
        row.pack(fill="x", pady=(8, 0))
        self._lbl(row, "A name will look like:").pack(side="left")
        self.example_lbl = ttk.Label(row, text="", style="Ok.TLabel")
        self.example_lbl.pack(side="left", padx=(8, 0))

        grid = tk.Frame(left, bg=BG)
        grid.pack(fill="x", pady=(10, 0))
        self.person_var, self.phase_var = tk.StringVar(), tk.StringVar()
        self.seed_var = tk.StringVar(value="random")
        self.out_var = tk.StringVar()
        # a compact two-row grid
        self._lbl(grid, "Person (for kinda)").grid(row=0, column=0, sticky="w")
        self.person_entry = ttk.Entry(grid, textvariable=self.person_var, width=20)
        self.person_entry.grid(row=1, column=0, sticky="w", padx=(0, 14), ipady=3)
        self._lbl(grid, "Phase (optional)").grid(row=0, column=1, sticky="w")
        self.phase_entry = ttk.Entry(grid, textvariable=self.phase_var, width=20)
        self.phase_entry.grid(row=1, column=1, sticky="w", padx=(0, 14), ipady=3)
        self._lbl(grid, "Seed").grid(row=0, column=2, sticky="w")
        self.seed_entry = ttk.Entry(grid, textvariable=self.seed_var, width=14)
        self.seed_entry.grid(row=1, column=2, sticky="w", ipady=3)
        for v in (self.person_var, self.phase_var):
            v.trace_add("write", lambda *_a: self._update_example())

        orow = tk.Frame(left, bg=BG)
        orow.pack(fill="x", pady=(8, 0))
        self._lbl(orow, "Output folder (a new one, never inside the playlist)").pack(anchor="w")
        o2 = tk.Frame(orow, bg=BG)
        o2.pack(fill="x", pady=(3, 0))
        self.out_entry = ttk.Entry(o2, textvariable=self.out_var)
        self.out_entry.pack(side="left", fill="x", expand=True, ipady=3)
        self.out_browse = ttk.Button(o2, text="Browse", command=self._out_browse, style="Small.TButton")
        self.out_browse.pack(side="left", padx=(8, 0))

        right = tk.Frame(f, bg=BG)
        right.pack(side="left", fill="y", padx=(24, 0))
        self.check_first_var = tk.BooleanVar(value=True)
        self.leave_out_var = tk.BooleanVar(value=True)
        self.open_when_done_var = tk.BooleanVar(value=False)
        self._chk(right, "Check integrity first (quick + deep)", self.check_first_var).pack(anchor="w")
        self._chk(right, "Leave out files that fail", self.leave_out_var).pack(anchor="w")
        self._chk(right, "Also open the output folder when done", self.open_when_done_var).pack(anchor="w")
        self.preview_btn = ttk.Button(right, text="Preview names", command=self._cloak_preview)
        self.preview_btn.pack(fill="x", pady=(14, 0))
        self.cloak_btn = ttk.Button(right, text="Cloak it", command=self._cloak_go)
        self.cloak_btn.pack(fill="x", pady=(6, 0))
        self.cloak_stop = ttk.Button(right, text="Stop", command=self._stop, state="disabled")
        self.cloak_stop.pack(fill="x", pady=(6, 0))
        self.open_anon_btn = ttk.Button(right, text="Open anonymised folder",
                                        command=lambda: self._open_last("anon"))
        self.open_anon_btn.pack(fill="x", pady=(14, 0))
        self.open_rec_btn = ttk.Button(right, text="Open private record",
                                       command=lambda: self._open_last("record"))
        self.open_rec_btn.pack(fill="x", pady=(6, 0))
        self.stop_btns.append(self.cloak_stop)
        self.out_user_set = False
        self.out_entry.bind("<KeyRelease>", lambda _e: setattr(
            self, "out_user_set", self.out_var.get() != self.out_auto))
        self._update_example()

    def _refresh_cloak(self):
        free = not self.busy
        for w in (self.preview_btn, self.cloak_btn):
            self._en(w, free and bool(self._included()))
        self._en(self.out_browse, free)
        for w in (self.person_entry, self.phase_entry, self.seed_entry, self.out_entry):
            self._en(w, free)
        self._en(self.open_anon_btn, bool(self.last_cloak))
        self._en(self.open_rec_btn, bool(self.last_cloak))
        # Phases from subfolders make the free-text Phase field moot.
        phase_from_folders = self._phases_from_folders()
        self._en(self.phase_entry, free and not phase_from_folders)

    def _phases_from_folders(self):
        return bool(self.sel and self.sel.has_subfolders and self.phases_var.get())

    def _update_example(self, *_a):
        inc = self._included()
        ext = os.path.splitext(inc[0].name)[1] if inc else ".mp3"
        self.example_lbl.configure(text=workflow.example_name(
            self.mode_var.get(), self.person_var.get(), self.phase_var.get(), ext or ".mp3",
            self._phases_from_folders()))
        if hasattr(self, "phase_entry"):
            self._refresh_cloak()

    def _autofill_output(self):
        if self.sel and not self.out_user_set:
            self.out_auto = workflow.default_output_dir(self.sel.folder)
            self.out_var.set(self.out_auto)

    def _out_browse(self):
        d = filedialog.askdirectory(initialdir=os.path.dirname(self.sel.folder) if self.sel else None,
                                    title="Choose where the cloaked copy goes")
        if d:
            self.out_var.set(os.path.normpath(d))
            self.out_user_set = True

    def _cloak_options(self):
        if not self._need_files():
            return None
        mode = self.mode_var.get()
        person = self.person_var.get().strip()
        if mode == "kinda" and not person:
            self._tell("Who is this one for?",
                       "Kinda anon needs a Person: the name that goes in every file name, "
                       "like anon_Sam_Peak_03. Type one in the Person box.")
            return None
        try:
            seed = workflow.parse_seed(self.seed_var.get())
        except ValueError as e:
            self._tell("That seed is not a number", str(e))
            return None
        out = self.out_var.get().strip()
        bad = workflow.output_problem(out, [self.sel.folder])
        if bad:
            self._tell("That output folder will not do", bad, BAD)
            return None
        return {"entries": self._included(), "mode": mode, "person": person,
                "phase": self.phase_var.get(), "seed": seed, "out": out,
                "use_phases": self.phases_var.get(), "check": self.check_first_var.get(),
                "drop": self.leave_out_var.get(), "source": self.sel.folder}

    def _cloak_preview(self):
        o = self._cloak_options()
        if not o:
            return
        self._log("  Sketching the new names...", "dim")
        self._begin("cloak")

        def run():
            try:
                plan = cloak.build_plan(**workflow.plan_args(
                    o["entries"], o["mode"], o["person"], o["phase"], o["seed"], o["use_phases"]))
                rows = cloak.preview(plan)
                self.ui(self._show_preview, rows, plan.seed, o["mode"])
            except Exception as e:  # noqa: BLE001
                self.ui(self._job_failed, "%s: %s" % (type(e).__name__, e))
        threading.Thread(target=run, daemon=True).start()

    def _show_preview(self, rows, seed, mode):
        self._end()
        if mode != "kinda" and workflow.parse_seed(self.seed_var.get()) is None and seed is not None:
            # Lock the seed so "Cloak it" produces exactly what was just previewed.
            self.seed_var.set(str(seed))
        top = tk.Toplevel(self.root)
        top.title("Preview names")
        top.configure(bg=BG)
        top.transient(self.root)
        top.geometry("820x520")
        tk.Label(top, text="What the copies will be called", bg=BG, fg=ACCENT,
                 font=("Segoe UI", 13, "bold")).pack(anchor="w", padx=16, pady=(14, 4))
        shown = rows[:200]
        note = "Showing the first %d of %d." % (len(shown), len(rows)) if len(rows) > 200 \
            else "All %d files." % len(rows)
        if mode != "kinda":
            note += "  The seed is locked to %s so Cloak it matches this preview (type 'random' to roll again)." % seed
        tk.Label(top, text=note, bg=BG, fg=DIM, wraplength=780, justify="left").pack(
            anchor="w", padx=16)
        wrap, tree = self._scrolled_tree(top, ("a", "b"), (360, 360),
                                         (("Original (as you have it)", "w"), ("Becomes", "w")), 14)
        wrap.pack(fill="both", expand=True, padx=16, pady=10)
        for a, b in shown:
            tree.insert("", "end", values=(a, b))
        ttk.Button(top, text="Close", command=top.destroy).pack(pady=(0, 14))
        self._centre(top)

    def _cloak_go(self):
        o = self._cloak_options()
        if not o:
            return
        n = len(o["entries"])
        anon = os.path.join(o["out"], "anonymised")
        rec = os.path.join(o["out"], "record")
        body = (
            "Cloaking %d file%s in %s mode.\n\n"
            "\u2022 Your originals are NOT touched. I only read them and work on copies.\n"
            "\u2022 Taken off every copy: all tags, cover art, lyrics and comments.\n"
            "\u2022 The copies go to:\n    %s\n"
            "\u2022 A private record (which new name is which real song) goes to:\n    %s\n\n"
            "The 'record' folder is PRIVATE: never share it.\n"
            "'anonymised' is the ONLY folder to share." % (
                n, "" if n == 1 else "s", MODE_INFO[o["mode"]][0], anon, rec))
        if o["check"]:
            body += ("\n\nI will check each file first (quick and deep)%s." % (
                " and leave out any that fail" if o["drop"] else ""))
        if self._dialog("Ready to cloak?", body, ("Cloak it", "Cancel")) != "Cloak it":
            return
        self._log("", "dim")
        self._log("  Sewing hoods. %d file%s, %s." % (n, "" if n == 1 else "s", MODE_INFO[o["mode"]][0]), "ok")
        self._log("  Originals stay exactly where they are.", "dim")
        self._spawn("cloak", self._cloak_run, o)

    def _cloak_run(self, o):
        def progress(stage, done, total, name):
            label = {"check": "Listening to", "plan": "Planning", "cloak": "Cloaking"}[stage]
            self.ui(self._on_progress, done, total, "%s %s" % (label, name) if name else label)
            if stage == "plan":
                self.ui(self._log, "  Plan drawn up. Copying, stripping, verifying...", "dim")

        run = workflow.run_cloak(
            o["entries"], o["mode"], o["out"], person=o["person"], phase=o["phase"], seed=o["seed"],
            use_phases=o["use_phases"], check_first=o["check"], drop_failed=o["drop"],
            source_root=o["source"], progress=progress, stop=self.stop_flag,
            workers=2)
        self.ui(self._cloak_done, run, o)

    def _cloak_done(self, run, o):
        self._end()
        self._update_summary()
        self.tree_refresh_status()
        r = run.result
        if r is None:
            self._log("  Stopped before anything was copied. Nothing was written.", "warn")
            return
        out = r.out_dir
        self.last_cloak = {"anon": os.path.join(out, "anonymised"), "record": r.record_dir, "out": out}
        self.bar.set_value(1.0)
        self.count_lbl.configure(text="Cloaked {:,} of {:,} files".format(r.copied, len(run.plan or [])))
        summary = workflow.format_cloak_summary(run)
        for line in summary.splitlines():
            self._log("  " + line, "ok" if not (r.failed or r.unstrippable) else "warn")
        for path, why in run.left_out:
            self._log("  Left out (failed the check): %s -- %s" % (
                os.path.basename(path), "; ".join(why[:2])), "warn")
        for path, why in r.failed:
            self._log("  FAILED: %s -- %s" % (os.path.basename(path), why), "bad")
        clean = not (r.failed or r.unstrippable) and r.copied > 0
        self._final_banner(clean)
        self._log("  Share ONLY: " + self.last_cloak["anon"], "ok")
        self._log("  PRIVATE, keep to yourself: " + r.record_dir, "warn")
        self._refresh_all()

        if r.unstrippable:
            self._warn_unstrippable(r)
        tail = ("\n\nThe 'record' folder maps new names back to real songs: keep it PRIVATE.\n"
                "Share only the 'anonymised' folder.")
        what = self._dialog("Cloaked" if clean else "Cloaked, with some trouble",
                            summary + tail,
                            ("Open anonymised folder", "Open private record", "Close"),
                            colour=OK if clean else WARN)
        if what == "Open anonymised folder":
            open_path(self.last_cloak["anon"])
        elif what == "Open private record":
            open_path(r.record_dir)
        if self.open_when_done_var.get():
            open_path(out)

    def _warn_unstrippable(self, r):
        copies = workflow.unstrippable_copies(r)
        names = "\n".join("   " + os.path.basename(p) for p in copies[:12])
        more = "\n   ...and %d more" % (len(copies) - 12) if len(copies) > 12 else ""
        ans = self._dialog(
            "WARNING: some tags could NOT be removed",
            "%d file%s are in a format I cannot strip. They were copied AS THEY ARE, so their tags "
            "(artist, title, maybe more) are STILL IN the copies in the anonymised folder:\n\n%s%s\n\n"
            "Do not share them. I can delete those copies from the anonymised folder now (your "
            "originals are not affected)." % (len(r.unstrippable), "" if len(r.unstrippable) == 1 else "s",
                                              names, more),
            ("Delete those copies", "Leave them"), colour=BAD, default="Delete those copies")
        if ans == "Delete those copies":
            if self._dialog("Delete %d copies?" % len(copies),
                            "These files will be removed from the anonymised folder only:\n\n" + names +
                            more + "\n\nYour originals stay where they are.",
                            ("Delete", "Cancel"), colour=BAD, default="Cancel") == "Delete":
                n = workflow.delete_copies(copies, os.path.join(r.out_dir, "anonymised"))
                self._log("  Deleted %d unstripped cop%s from anonymised/." % (n, "y" if n == 1 else "ies"),
                          "ok")
        else:
            self._log("  Unstripped copies left in anonymised/. Do NOT share those.", "bad")

    def _open_last(self, which):
        if self.last_cloak:
            open_path(self.last_cloak[which])

    # ============================================================ CHECK

    def _build_check(self, f):
        top = tk.Frame(f, bg=BG)
        top.pack(fill="x")
        self.deep_var = tk.StringVar(value="quick")
        self._radio(top, "Quick (seconds)", self.deep_var, "quick", self._on_depth).pack(side="left")
        self._radio(top, "Deep: decode everything (minutes)", self.deep_var, "deep",
                    self._on_depth).pack(side="left", padx=(16, 0))
        self._lbl(top, "Workers").pack(side="left", padx=(24, 6))
        self.workers_var = tk.StringVar(value="4")
        self.workers_spin = ttk.Spinbox(top, from_=1, to=16, width=4, textvariable=self.workers_var)
        self.workers_spin.pack(side="left")
        self.ff_note = ttk.Label(f, text="", style="Warn.TLabel", wraplength=900, justify="left")
        self.ff_note.pack(anchor="w", pady=(6, 0))

        ctl = tk.Frame(f, bg=BG)
        ctl.pack(fill="x", pady=(8, 6))
        self.check_btn = ttk.Button(ctl, text="Check files", command=self._check_go)
        self.check_btn.pack(side="left")
        self.check_stop = ttk.Button(ctl, text="Stop", command=self._stop, state="disabled")
        self.check_stop.pack(side="left", padx=(8, 0))
        self.report_btn = ttk.Button(ctl, text="Save report\u2026", command=self._check_report)
        self.report_btn.pack(side="left", padx=(8, 0))
        self.check_counts = ttk.Label(ctl, text="", style="Dim.TLabel")
        self.check_counts.pack(side="left", padx=(16, 0))
        self.stop_btns.append(self.check_stop)

        cols = ("level", "name", "reason", "engine")
        wrap, self.res_tree = self._scrolled_tree(
            f, cols, (90, 280, 460, 80),
            (("Result", "w"), ("File", "w"), ("What I found", "w"), ("Engine", "w")), 6)
        wrap.pack(fill="both", expand=True)
        for c in cols:
            self.res_tree.heading(c, command=lambda c=c: self._check_sort_by(c))
        self.res_tree.bind("<Double-1>", self._check_detail)
        self._on_depth()

    def _on_depth(self):
        self.workers_var.set("2" if self.deep_var.get() == "deep" else "4")
        self._update_ff_note()

    def _update_ff_note(self):
        note = ""
        if self.deep_var.get() == "deep" and not integrity.have_ffmpeg():
            missing = sorted({e.fmt for e in self.entries
                              if e.include and not integrity.deep_supported(e.fmt)})
            note = ("ffmpeg was not found, so Deep can decode MP3, FLAC, WAV and OGG Vorbis only. "
                    "M4A/AAC, Opus, AIFF and APE files get the quick check. Put ffmpeg.exe next to "
                    "this app to cover them.")
            if missing:
                note += "  In your selection that affects: " + ", ".join(missing) + "."
        self.ff_note.configure(text=note)

    def _refresh_check(self):
        if not hasattr(self, "check_btn"):
            return
        free = not self.busy
        self._en(self.check_btn, free and bool(self._included()))
        self._en(self.report_btn, free and bool(self.check_results))
        self._en(self.workers_spin, free)
        self._update_ff_note()

    def _check_go(self):
        if not self._need_files():
            return
        deep = self.deep_var.get() == "deep"
        try:
            workers = max(1, min(16, int(self.workers_var.get())))
        except ValueError:
            workers = 4
        paths = [e.path for e in self._included()]
        self._log("", "dim")
        self._log("  Stethoscope out. %s check of %d file%s, %d at a time." % (
            "Deep" if deep else "Quick", len(paths), "" if len(paths) == 1 else "s", workers), "ok")
        self._spawn("check", self._check_run, paths, deep, workers)

    def _check_run(self, paths, deep, workers):
        total = len(paths)

        def progress(done, _total, name):      # called from worker threads
            self.ui(self._on_progress, done, total, "Listening to " + name)
        res = integrity.check_many(paths, deep=deep, progress=progress,
                                   stop=self.stop_flag, workers=workers)
        self.ui(self._check_done, res, deep, total)

    def _check_done(self, verdicts, deep, total):
        self._end()
        self.check_results = verdicts
        by_path = {v.path: v for v in verdicts}
        for e in self.entries:
            if e.path in by_path:
                e.status = by_path[e.path].level
        self.tree_refresh_status()
        self._fill_results()
        s = integrity.summarise(verdicts)
        text = workflow.format_check_counts(s)
        self.check_counts.configure(text=text)
        self.bar.set_value(1.0 if len(verdicts) == total else len(verdicts) / max(total, 1))
        self.count_lbl.configure(text="Checked {:,} of {:,} files".format(len(verdicts), total))
        lb = s["by_level"]
        if len(verdicts) < total:
            self._log("  Stopped early: %d of %d files listened to." % (len(verdicts), total), "warn")
        self._log("  " + text, "ok" if not lb["fail"] else "bad")
        for w in s["worst"][:8]:
            self._log("  [%s] %s -- %s" % (w["level"], os.path.basename(w["path"]),
                                           "; ".join(w["reasons"][:2])),
                      "bad" if w["level"] == "fail" else "warn")
        if len(s["worst"]) > 8:
            self._log("  ...and more in the table above.", "dim")
        self._final_banner(lb["fail"] == 0)
        self._refresh_all()

    def tree_refresh_status(self):
        if self.sel is None:
            return
        for e in self.entries:
            if self.tree.exists(e.path):
                self.tree.set(e.path, "st", STATUS_ICON.get(e.status, ""))
                self._paint_row(e)

    def _fill_results(self):
        self.res_tree.delete(*self.res_tree.get_children())
        key, rev = self.check_sort
        vs = list(self.check_results)
        keyfns = {
            "level": lambda v: (LEVEL_ORDER.get(v.level, 9), workflow.natural_key(os.path.basename(v.path))),
            "name": lambda v: workflow.natural_key(os.path.basename(v.path)),
            "reason": lambda v: (v.reasons[0].casefold() if v.reasons else ""),
            "engine": lambda v: v.engine,
        }
        vs.sort(key=keyfns[key], reverse=rev)
        for i, v in enumerate(vs):
            reason = v.reasons[0] if v.reasons else "all good"
            if len(v.reasons) > 1:
                reason += "  (+%d more)" % (len(v.reasons) - 1)
            self.res_tree.insert("", "end", iid=str(i), tags=(v.level,), values=(
                STATUS_ICON.get(v.level, "") + " " + v.level, os.path.basename(v.path), reason, v.engine))
        self._sorted_results = vs

    def _check_sort_by(self, col):
        key, rev = self.check_sort
        self.check_sort = (col, (not rev) if key == col else False)
        self._fill_results()

    def _check_detail(self, ev):
        iid = self.res_tree.identify_row(ev.y)
        if not iid:
            return
        v = self._sorted_results[int(iid)]
        body = "\n".join("\u2022 " + r for r in v.reasons) or "Nothing wrong found."
        extra = "\n\n%s\nChecked by: %s" % (v.path, v.engine)
        self._dialog("%s %s" % (STATUS_ICON.get(v.level, ""), os.path.basename(v.path)),
                     body + extra, ("OK",), colour=LEVEL_COLOUR.get(v.level, ACCENT), width=620)

    def _check_report(self):
        if not self.check_results:
            return
        p = filedialog.asksaveasfilename(title="Save the integrity report", defaultextension=".csv",
                                         initialfile="integrity-report.csv",
                                         filetypes=[("CSV", "*.csv"), ("All files", "*.*")])
        if not p:
            return
        try:
            txt = integrity.write_report(self.check_results, p)
        except OSError as e:
            self._tell("Could not save that", str(e), BAD)
            return
        self._log("  Report saved: %s (and a summary: %s)" % (p, txt), "ok")

    # ============================================================ SPOTIFY

    def _build_spotify(self, f):
        self.sp_top = tk.Frame(f, bg=BG)
        self.sp_top.pack(fill="x")
        # (a) setup wizard
        self.sp_wizard = tk.Frame(self.sp_top, bg=BG)
        self._lbl(self.sp_wizard, "One-time Spotify setup", "Head.TLabel").pack(anchor="w")
        self._lbl(self.sp_wizard, "If someone sent you this app, ask them for the Client ID (or a "
                                  "ready-made spotify_client.json to put next to the app).").pack(anchor="w")
        txt = tk.Text(self.sp_wizard, height=9, bg=PANEL, fg=FG, borderwidth=0, wrap="word",
                      font=("Segoe UI", 9), padx=10, pady=8)
        txt.insert("1.0", spotify_link.setup_instructions(spotify_link.client_id_file()))
        txt.configure(state="disabled")
        txt.pack(fill="x", pady=(6, 6))
        row = tk.Frame(self.sp_wizard, bg=BG)
        row.pack(fill="x")
        ttk.Button(row, text="Copy redirect URI", command=self._sp_copy_uri).pack(side="left")
        ttk.Button(row, text="Open Spotify dashboard",
                   command=lambda: webbrowser.open("https://developer.spotify.com/dashboard")
                   ).pack(side="left", padx=(8, 0))
        row2 = tk.Frame(self.sp_wizard, bg=BG)
        row2.pack(fill="x", pady=(8, 0))
        self._lbl(row2, "Client ID").pack(side="left", padx=(0, 8))
        self.cid_var = tk.StringVar()
        self.cid_entry = ttk.Entry(row2, textvariable=self.cid_var, width=44)
        self.cid_entry.pack(side="left", ipady=3)
        self.cid_save = ttk.Button(row2, text="Save", command=self._sp_save_cid)
        self.cid_save.pack(side="left", padx=(8, 0))
        self.cid_msg = ttk.Label(self.sp_wizard, text="", style="Dim.TLabel")
        self.cid_msg.pack(anchor="w", pady=(4, 0))
        # (b) signed out
        self.sp_signin = tk.Frame(self.sp_top, bg=BG)
        self._lbl(self.sp_signin, "Not signed in", "Head.TLabel").pack(anchor="w")
        self._lbl(self.sp_signin, "Sign in with your own Spotify account. Your browser opens, you "
                                  "approve, and you are done. I never see your password.").pack(anchor="w")
        r3 = tk.Frame(self.sp_signin, bg=BG)
        r3.pack(fill="x", pady=(8, 0))
        self.signin_btn = ttk.Button(r3, text="Sign in with Spotify", command=self._sp_sign_in)
        self.signin_btn.pack(side="left")
        self.signin_cancel = ttk.Button(r3, text="Cancel", command=self._stop, state="disabled")
        self.signin_cancel.pack(side="left", padx=(8, 0))
        self.stop_btns.append(self.signin_cancel)
        self.signin_msg = ttk.Label(self.sp_signin, text="", style="Dim.TLabel", wraplength=900,
                                    justify="left")
        self.signin_msg.pack(anchor="w", pady=(6, 0))
        # (c) signed in
        self.sp_signed = tk.Frame(self.sp_top, bg=BG)
        r4 = tk.Frame(self.sp_signed, bg=BG)
        r4.pack(fill="x")
        self.who_lbl = ttk.Label(r4, text="", style="Ok.TLabel")
        self.who_lbl.pack(side="left")
        self.signout_btn = ttk.Button(r4, text="Sign out", command=self._sp_sign_out, style="Small.TButton")
        self.signout_btn.pack(side="left", padx=(12, 0))

        # the work area, only when signed in
        self.sp_work = tk.Frame(f, bg=BG)
        w1 = tk.Frame(self.sp_work, bg=BG)
        w1.pack(fill="x", pady=(6, 0))
        self._lbl(w1, "Playlist name").pack(side="left", padx=(0, 8))
        self.pl_name_var = tk.StringVar()
        self.pl_name_entry = ttk.Entry(w1, textvariable=self.pl_name_var, width=40)
        self.pl_name_entry.pack(side="left", ipady=3)
        self.public_var = tk.BooleanVar(value=False)
        self._chk(w1, "Public playlist", self.public_var).pack(side="left", padx=(16, 0))
        w2 = tk.Frame(self.sp_work, bg=BG)
        w2.pack(fill="x", pady=(8, 0))
        self.find_btn = ttk.Button(w2, text="Find on Spotify", command=self._sp_find)
        self.find_btn.pack(side="left")
        self.find_stop = ttk.Button(w2, text="Stop", command=self._stop, state="disabled")
        self.find_stop.pack(side="left", padx=(8, 0))
        self.rec_btn = ttk.Button(w2, text="Use a record.csv\u2026", command=self._sp_load_record)
        self.rec_btn.pack(side="left", padx=(8, 0))
        self.use_sel_btn = ttk.Button(w2, text="Use the selection instead", command=self._sp_use_selection)
        self.use_sel_btn.pack(side="left", padx=(8, 0))
        self.src_lbl = ttk.Label(w2, text="", style="Dim.TLabel")
        self.src_lbl.pack(side="left", padx=(12, 0))
        self.stop_btns.append(self.find_stop)

        cols = ("st", "src", "match", "score")
        wrap, self.sp_tree = self._scrolled_tree(
            self.sp_work, cols, (60, 280, 420, 60),
            (("", "center"), ("Your track", "w"), ("Spotify match", "w"), ("Score", "e")), 5)
        wrap.pack(fill="both", expand=True, pady=(8, 0))
        self.sp_tree.tag_configure("matched", foreground=OK)
        self.sp_tree.tag_configure("uncertain", foreground=WARN)
        self.sp_tree.tag_configure("missing", foreground=BAD)
        self.sp_tree.tag_configure("skipped", foreground=GREY)
        self.sp_tree.bind("<Double-1>", lambda _e: self._sp_choose())
        w3 = tk.Frame(self.sp_work, bg=BG)
        w3.pack(fill="x", pady=(8, 0))
        self.choose_btn = ttk.Button(w3, text="Choose match\u2026", command=self._sp_choose,
                                     style="Small.TButton")
        self.choose_btn.pack(side="left")
        self.skip_btn = ttk.Button(w3, text="Skip this track", command=self._sp_skip, style="Small.TButton")
        self.skip_btn.pack(side="left", padx=(6, 0))
        self.accept_btn = ttk.Button(w3, text="Accept all best guesses", command=self._sp_accept_all,
                                     style="Small.TButton")
        self.accept_btn.pack(side="left", padx=(6, 0))
        self.sp_counts = ttk.Label(w3, text="", style="Dim.TLabel")
        self.sp_counts.pack(side="left", padx=(14, 0))
        w4 = tk.Frame(self.sp_work, bg=BG)
        w4.pack(fill="x", pady=(8, 0))
        self.create_btn = ttk.Button(w4, text="Create playlist", command=self._sp_create)
        self.create_btn.pack(side="left")
        self.open_pl_btn = ttk.Button(w4, text="Open playlist in Spotify",
                                      command=lambda: webbrowser.open(self.sp_playlist_url))
        self.open_pl_btn.pack(side="left", padx=(8, 0))
        self.missing_btn = ttk.Button(w4, text="Save list of tracks not found\u2026",
                                      command=self._sp_save_missing)
        self.missing_btn.pack(side="left", padx=(8, 0))

    def _refresh_spotify(self):
        if not hasattr(self, "find_btn"):
            return
        free = not self.busy
        self._en(self.cid_save, free)
        self._en(self.signin_btn, free)
        self._en(self.signout_btn, free)
        self._en(self.find_btn, free)
        self._en(self.rec_btn, free)
        self._en(self.use_sel_btn, free and self.sp_queries is not None)
        have = bool(self.sp_matches)
        row = bool(self.sp_tree.selection()) if have else False
        for w in (self.choose_btn, self.skip_btn):
            self._en(w, free and row)
        self._en(self.accept_btn, free and any(m.status == "uncertain" for m in self.sp_matches))
        self._en(self.create_btn, free and any(m.chosen for m in self.sp_matches))
        self._en(self.missing_btn, free and any(
            m.status == "missing" or (m.status == "uncertain" and m.chosen is None)
            for m in self.sp_matches))
        if self.sp_playlist_url:
            self._en(self.open_pl_btn, True)
        else:
            self._en(self.open_pl_btn, False)
        if self.sp_queries is not None:
            self.src_lbl.configure(text="Source: record.csv (%d tracks)" % len(self.sp_queries))
        else:
            self.src_lbl.configure(text="Source: your selection (%d files)" % len(self._included()))

    def _sp_copy_uri(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(REDIRECT_URI)
        self.cid_msg.configure(text="Copied: " + REDIRECT_URI, style="Ok.TLabel")

    def _sp_save_cid(self):
        cid = self.cid_var.get().strip()
        if not workflow.valid_client_id(cid):
            self.cid_msg.configure(style="Bad.TLabel", text="That does not look right. A Client ID is "
                                   "32 letters and numbers (0-9, a-f), no spaces.")
            return
        path = spotify_link.client_id_file()
        try:
            workflow.write_client_id(path, cid)
        except OSError as e:
            self.cid_msg.configure(style="Bad.TLabel",
                                   text="Could not write %s (%s). Is this folder read-only? "
                                        "Move the app somewhere you can save files." % (path, e))
            return
        self._log("  Client ID saved next to the app. Now sign in.", "ok")
        self.cid_var.set("")
        self._sp_refresh()

    def _sp_refresh(self):
        """Pick the state: no client id -> wizard; signed out -> sign in; else the work area."""
        if self.sp is None:
            self.sp = self.link_factory()
        try:
            spotify_link.resolve_client_id()
            has_cid = True
        except spotify_link.NeedsClientId:
            has_cid = False
        if not has_cid:
            state = "wizard"
        elif not self.sp.is_signed_in():
            state = "signin"
        else:
            state = "signed"
        for fr in (self.sp_wizard, self.sp_signin, self.sp_signed):
            fr.pack_forget()
        {"wizard": self.sp_wizard, "signin": self.sp_signin, "signed": self.sp_signed}[state].pack(fill="x")
        if state == "signed":
            self.sp_work.pack(fill="both", expand=True)
            if not self.pl_name_var.get():
                self.pl_name_var.set(workflow.default_playlist_name(
                    self.person_var.get(), self.sel.folder if self.sel else ""))
            if self.sp.display_name:
                self.who_lbl.configure(text="Signed in as " + self.sp.display_name)
            else:
                self.who_lbl.configure(text="Signed in")
                if not self.test_mode and self.sp_state != "signed":
                    self._sp_fetch_name()
        else:
            self.sp_work.pack_forget()
        self.sp_state = state
        self._refresh_spotify()
        self.root.after(60, self._autosash)

    def _sp_fetch_name(self):
        def run():
            try:
                me = self.sp._api("GET", "/me")
                name = me.get("display_name") or me.get("id") or "Spotify user"
            except spotify_link.SpotifyError:
                self.ui(self._sp_refresh)
                return
            self.sp.display_name = name
            self.ui(lambda: self.who_lbl.configure(text="Signed in as " + name))
        threading.Thread(target=run, daemon=True).start()

    def _sp_sign_in(self):
        self.signin_msg.configure(text="Opening your browser...", style="Dim.TLabel")
        self._log("", "dim")
        self._log("  Radioing the satellite. Your browser will open: approve it there.", "ok")
        self._spawn("orbit", self._sp_sign_in_run)

    def _sp_status(self, msg):
        self.signin_msg.configure(text=msg, style="Dim.TLabel")
        self._log("  " + msg, "dim")

    def _sp_sign_in_run(self):
        try:
            name = self.sp.sign_in(stop=self.stop_flag, status=lambda m: self.ui(self._sp_status, m))
        except spotify_link.NotAllowlisted:
            self.ui(self._sp_signin_problem, "not_allowed",
                    "Spotify said this account is not on the allowed list yet.\n\nAsk the owner of "
                    "DankCrawl to add the email address of YOUR Spotify account in their Spotify "
                    "developer dashboard (User Management), then try again.")
            return
        except spotify_link.NeedsClientId:
            self.ui(self._sp_signin_problem, "needs_id",
                    "There is no Client ID yet. Finish the one-time setup first.")
            return
        except spotify_link.AuthCancelled as e:
            self.ui(self._sp_signin_problem, "cancelled", "Sign-in cancelled. (%s)" % e)
            return
        except spotify_link.SpotifyError as e:
            self.ui(self._sp_signin_problem, "error", str(e))
            return
        self.ui(self._sp_signed_in, name)

    def _sp_signin_problem(self, kind, msg):
        self._end()
        self.signin_msg.configure(text=msg.splitlines()[0] if kind != "not_allowed" else
                                  "Not on the allowed list yet. Ask the owner to add your Spotify email.",
                                  style="Warn.TLabel")
        self._log("  " + msg.splitlines()[0], "warn")
        if kind in ("not_allowed", "error"):
            self._dialog("Spotify would not let us in" if kind == "error" else "Not on the list yet",
                         msg, ("OK",), colour=WARN)
        self._sp_refresh()

    def _sp_signed_in(self, name):
        self._end()
        self._log("  Signed in to Spotify as %s. Docking complete." % name, "ok")
        self._sp_refresh()

    def _sp_sign_out(self):
        if self.sp:
            self.sp.sign_out()
        self.sp_matches = []
        self.sp_tree.delete(*self.sp_tree.get_children())
        self.sp_playlist_url = None
        self.sp_counts.configure(text="")
        self._log("  Signed out. The saved sign-in is gone from this PC.", "dim")
        self._sp_refresh()

    def _sp_load_record(self):
        p = filedialog.askopenfilename(title="Pick the record.csv from a cloak run",
                                       filetypes=[("record.csv", "*.csv"), ("All files", "*.*")])
        if not p:
            return
        try:
            qs, skipped = workflow.load_record_csv(p)
        except (OSError, ValueError) as e:
            self._tell("Could not use that file", str(e), BAD)
            return
        if not qs:
            self._tell("Nothing in there", "That file has no rows with an artist or title.", WARN)
            return
        self.sp_queries = qs
        self._log("  Loaded %d tracks from %s%s." % (
            len(qs), os.path.basename(p), " (%d empty rows skipped)" % skipped if skipped else ""), "ok")
        self._refresh_spotify()

    def _sp_use_selection(self):
        self.sp_queries = None
        self._refresh_spotify()

    def _sp_find(self):
        if self.sp_queries is None and not self._need_files():
            return
        self._log("", "dim")
        self._log("  Scanning the heavens for your tracks...", "ok")
        self._spawn("orbit", self._sp_find_run, self.sp_queries, list(self._included()))

    def _sp_find_run(self, queries, entries):
        if queries is None:
            queries, anon = workflow.queries_from_entries(entries)
            if anon:
                self.ui(self._log, "  %d file%s look already anonymised (anon_...); skipped." % (
                    anon, "" if anon == 1 else "s"), "warn")
            if not queries:
                self.ui(self._sp_no_identities, anon)
                return
        total = len(queries)

        def progress(i, _t, q):
            if q is not None:
                self.ui(self._on_progress, i, total, "Looking up %s" % (
                    " - ".join(x for x in (q.artist, q.title) if x) or q.ref))
        matches = self.sp.find(queries, progress=progress, stop=self.stop_flag)
        self.ui(self._sp_found, matches, total)

    def _sp_no_identities(self, anon):
        self._end()
        self._dialog("Nothing to look up",
                     "The selected files have no real artist or title I can use (they look "
                     "anonymised, or have no tags and no 'Artist - Title' file names).\n\n"
                     "Point the selection at the ORIGINAL, named files, or use 'Use a record.csv...' "
                     "to load the private record from a cloak run.", ("OK",), colour=WARN)

    def _sp_found(self, matches, total):
        self._end()
        self.sp_matches = matches
        self.sp_playlist_url = None
        self._sp_fill()
        c = self._sp_tally()
        if len(matches) < total:
            self._log("  Stopped early: %d of %d looked up." % (len(matches), total), "warn")
        self._log("  Found %d, unsure about %d, nothing for %d." % (c["matched"], c["uncertain"], c["missing"]),
                  "ok" if not c["missing"] else "warn")
        if c["uncertain"]:
            self._log("  The unsure ones wait for you: double-click a row to pick, or accept the guesses.", "dim")
        self.bar.set_value(1.0 if len(matches) == total else len(matches) / max(total, 1))
        self.count_lbl.configure(text="Looked up {:,} of {:,} tracks".format(len(matches), total))
        self._final_banner(c["matched"] + c["uncertain"] > 0)
        self._refresh_all()

    def _sp_row(self, m):
        q = m.query
        src = " - ".join(x for x in (q.artist, q.title) if x) or q.ref
        c = m.chosen or m.best
        match = ""
        score = ""
        if c:
            match = "%s - %s (%s)" % (c.name, ", ".join(c.artists), c.album)
            score = "%d%%" % round(c.score * 100)
        if m.status == "missing":
            icon, tag = "\u2717", "missing"
        elif m.chosen is None:
            icon, tag = ("?", "uncertain") if m.status == "uncertain" else ("\u2013", "skipped")
            if m.status == "matched":
                match = "(skipped)"
        else:
            icon, tag = ("\u2713", "matched")
        return (icon, src, match, score), tag

    def _sp_fill(self):
        self.sp_tree.delete(*self.sp_tree.get_children())
        for i, m in enumerate(self.sp_matches):
            vals, tag = self._sp_row(m)
            self.sp_tree.insert("", "end", iid=str(i), values=vals, tags=(tag,))
        self._sp_update_counts()

    def _sp_tally(self):
        c = {"matched": 0, "uncertain": 0, "missing": 0, "chosen": 0}
        for m in self.sp_matches:
            c[m.status] += 1
            if m.chosen:
                c["chosen"] += 1
        return c

    def _sp_update_counts(self):
        c = self._sp_tally()
        self.sp_counts.configure(text="matched %d  \u00b7  unsure %d  \u00b7  not found %d  \u00b7  "
                                      "will add %d" % (c["matched"], c["uncertain"], c["missing"], c["chosen"]))

    def _sp_redraw(self, idx):
        vals, tag = self._sp_row(self.sp_matches[idx])
        self.sp_tree.item(str(idx), values=vals, tags=(tag,))
        self._sp_update_counts()
        self._refresh_spotify()

    def _sp_selected(self):
        sel = self.sp_tree.selection()
        return int(sel[0]) if sel else None

    def _sp_skip(self):
        i = self._sp_selected()
        if i is not None:
            self.sp_matches[i].chosen = None
            self._sp_redraw(i)

    def _sp_accept_all(self):
        for i, m in enumerate(self.sp_matches):
            if m.status == "uncertain" and m.chosen is None and m.best:
                m.chosen = m.best
                self._sp_redraw(i)

    def _sp_choose(self):
        i = self._sp_selected()
        if i is None or self.busy:
            return
        m = self.sp_matches[i]
        if not m.candidates:
            self._tell("Nothing close", "Spotify has nothing near enough to offer for this one. "
                                        "It will be left off and listed in the not-found file.", WARN)
            return
        top = tk.Toplevel(self.root)
        top.title("Choose a match")
        top.configure(bg=BG)
        top.transient(self.root)
        q = m.query
        tk.Label(top, text="Which one is it?", bg=BG, fg=ACCENT, font=("Segoe UI", 13, "bold")).pack(
            anchor="w", padx=16, pady=(14, 2))
        tk.Label(top, text=" - ".join(x for x in (q.artist, q.title) if x) or q.ref, bg=BG, fg=FG).pack(
            anchor="w", padx=16, pady=(0, 8))
        var = tk.IntVar(value=-1)
        for k, c in enumerate(m.candidates):
            if m.chosen is not None and c.uri == m.chosen.uri:
                var.set(k)
            self._radio(top, "%s - %s (%s)   %d%%   %s" % (
                c.name, ", ".join(c.artists), c.album, round(c.score * 100),
                workflow.human_duration(c.duration_sec)), var, k).pack(anchor="w", padx=22)
        self._radio(top, "Skip this track", var, -1).pack(anchor="w", padx=22, pady=(6, 0))

        def ok():
            k = var.get()
            m.chosen = m.candidates[k] if k >= 0 else None
            top.destroy()
            self._sp_redraw(i)
        row = tk.Frame(top, bg=BG)
        row.pack(fill="x", padx=16, pady=14)
        ttk.Button(row, text="Use this", command=ok).pack(side="right")
        ttk.Button(row, text="Cancel", command=top.destroy).pack(side="right", padx=(0, 8))
        self._centre(top)
        top.grab_set()

    def _sp_create(self):
        n = sum(1 for m in self.sp_matches if m.chosen)
        name = self.pl_name_var.get().strip() or workflow.default_playlist_name(None, "")
        public = self.public_var.get()
        if n == 0:
            self._tell("Nothing to add", "No track has a Spotify match chosen yet.", WARN)
            return
        ok = self._dialog("Create the playlist?",
                          "Add %d track%s to a new %s playlist called:\n\n    %s\n\non your Spotify account."
                          % (n, "" if n == 1 else "s", "PUBLIC" if public else "private", name),
                          ("Create playlist", "Cancel"))
        if ok != "Create playlist":
            return
        self._log("  Launching: %d tracks into orbit as '%s'." % (n, name), "ok")
        self._spawn("orbit", self._sp_create_run, name, public, list(self.sp_matches))

    def _sp_create_run(self, name, public, matches):
        info = self.sp.create_playlist(
            name, matches, description="Made with DankCrawl", public=public,
            progress=lambda added, total: self.ui(self._on_progress, added, total, "tracks added", "tracks"),
            stop=self.stop_flag)
        self.ui(self._sp_created, info, name)

    def _sp_created(self, info, name):
        self._end()
        self.sp_playlist_url = info["url"]
        self.bar.set_value(1.0)
        self._log("  Playlist '%s' is live: %d track%s added%s." % (
            name, info["added"], "" if info["added"] == 1 else "s",
            ", %d skipped" % info["skipped"] if info["skipped"] else ""), "ok")
        if info.get("stopped"):
            self._log("  You stopped it part-way: the playlist has only the tracks added so far.", "warn")
        self._log("  " + info["url"], "accent")
        self._final_banner(not info.get("stopped"))
        self._refresh_all()
        if self._dialog("Playlist created",
                        "'%s' is in your Spotify now with %d track%s." % (
                            name, info["added"], "" if info["added"] == 1 else "s"),
                        ("Open in Spotify", "Close")) == "Open in Spotify":
            webbrowser.open(info["url"])

    def _sp_save_missing(self):
        p = filedialog.asksaveasfilename(title="Save the list of tracks not found",
                                         defaultextension=".csv", initialfile="not-found-on-spotify.csv",
                                         filetypes=[("CSV", "*.csv"), ("All files", "*.*")])
        if not p:
            return
        try:
            spotify_link.save_missing(self.sp_matches, p)
        except OSError as e:
            self._tell("Could not save that", str(e), BAD)
            return
        self._log("  Not-found list saved: " + p, "ok")


# ====================================================================== CLI


def _ensure_stdio():
    """A --windowed exe has no console: attach to the parent's, else go quiet."""
    if sys.stdout is None:
        try:
            if os.name == "nt":
                import ctypes
                if ctypes.windll.kernel32.AttachConsole(-1):
                    sys.stdout = open("CONOUT$", "w", encoding="utf-8")
                    sys.stderr = sys.stdout
        except Exception:
            pass
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = sys.stdout
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")
        except Exception:
            pass


def _cli_progress():
    last = [0.0]

    def progress(label, done, total, name=""):
        now = time.time()
        if now - last[0] < 0.4 and done < total:
            return
        last[0] = now
        print("  %s %d/%d %s" % (label, done, total, name[:40]).ljust(78), end="\r", flush=True)
    return progress


def cli_cloak(argv) -> int:
    ap = argparse.ArgumentParser(prog="dankcrawl.py cloak",
                                 description="Make an anonymised mirror copy of a playlist folder "
                                             "(originals are never touched).")
    ap.add_argument("folder")
    ap.add_argument("--mode", choices=cloak.MODES, default="true")
    ap.add_argument("--person")
    ap.add_argument("--phase")
    ap.add_argument("--seed", help="a whole number, or 'random' (default)")
    ap.add_argument("--out", help="output folder (default: 'DankCloak <date>' next to the playlist)")
    ap.add_argument("--no-check", action="store_true", help="skip the integrity check")
    ap.add_argument("--keep-failed", action="store_true",
                    help="do not leave out files that fail the integrity check")
    ap.add_argument("--no-phases", action="store_true", help="do not treat subfolders as phases")
    a = ap.parse_args(argv)
    if not os.path.isdir(a.folder):
        print("Not a folder: " + a.folder)
        return 2
    if a.mode == "kinda" and not (a.person or "").strip():
        print("--mode kinda needs --person")
        return 2
    try:
        seed = workflow.parse_seed(a.seed)
    except ValueError as e:
        print(e)
        return 2
    sel = workflow.scan_selection(a.folder)
    print(workflow.summary_text(sel.entries))
    if not sel.entries:
        print("No audio files found.")
        return 1
    out = a.out or workflow.default_output_dir(a.folder)
    pr = _cli_progress()
    try:
        run = workflow.run_cloak(
            sel.entries, a.mode, out, person=a.person, phase=a.phase, seed=seed,
            use_phases=sel.has_subfolders and not a.no_phases, check_first=not a.no_check,
            drop_failed=not a.keep_failed, source_root=a.folder,
            progress=lambda st, d, t, n: pr({"check": "checking", "plan": "planning", "cloak": "cloaking"}[st], d, t, n))
    except ValueError as e:
        print("\n" + str(e))
        return 1
    print()
    print(workflow.format_cloak_summary(run))
    for p, why in run.left_out:
        print("  left out: %s -- %s" % (os.path.basename(p), "; ".join(why[:2])))
    r = run.result
    for p, why in r.failed:
        print("  FAILED: %s -- %s" % (os.path.basename(p), why))
    for p in workflow.unstrippable_copies(r):
        print("  WARNING tags remain in: " + p)
    print("share:   " + os.path.join(r.out_dir, "anonymised"))
    print("PRIVATE: " + r.record_dir)
    return 1 if (r.failed or r.unstrippable) else 0


def cli_check(argv) -> int:
    ap = argparse.ArgumentParser(prog="dankcrawl.py check",
                                 description="Check that every audio file is complete and plays cleanly.")
    ap.add_argument("folder")
    ap.add_argument("--deep", action="store_true", help="decode everything (slower)")
    ap.add_argument("--report", help="write a CSV report (and a .txt summary beside it)")
    ap.add_argument("--workers", type=int)
    a = ap.parse_args(argv)
    if not os.path.isdir(a.folder):
        print("Not a folder: " + a.folder)
        return 2
    sel = workflow.scan_selection(a.folder)
    print(workflow.summary_text(sel.entries))
    pr = _cli_progress()
    workers = a.workers or (2 if a.deep else 4)
    vs = integrity.check_many([e.path for e in sel.entries], deep=a.deep, workers=workers,
                              progress=lambda d, t, n: pr("checking", d, t, n))
    print()
    s = integrity.summarise(vs)
    print(workflow.format_check_counts(s))
    for v in sorted(vs, key=lambda v: (LEVEL_ORDER.get(v.level, 9), v.path)):
        if v.level in ("fail", "warn"):
            print("  [%s] %s -- %s" % (v.level, os.path.basename(v.path), "; ".join(v.reasons[:3])))
    if a.report:
        txt = integrity.write_report(vs, a.report)
        print("report:  %s\nsummary: %s" % (a.report, txt))
    return 1 if s["by_level"]["fail"] else 0


def cli_selftest(argv) -> bool:
    log = None
    if "--log" in argv:
        i = argv.index("--log")
        if i + 1 < len(argv):
            log = open(argv[i + 1], "w", encoding="utf-8")

    def say(line):
        print(line)
        if log:
            log.write(line + "\n")
            log.flush()
    ok = workflow.selftest(say)
    if log:
        log.close()
    return ok


def run_cli(argv):
    # A --windowed build has no console attached, so sys.stdout is None and any
    # print() would abort the scan. Keep CLI mode usable from the exe anyway.
    _ensure_stdio()
    if argv and argv[0] == "cloak":
        return cli_cloak(argv[1:])
    if argv and argv[0] == "check":
        return cli_check(argv[1:])

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
    argv = sys.argv[1:]
    if "--selftest" in argv:
        _ensure_stdio()
        sys.exit(0 if cli_selftest(argv) else 1)
    if "--cli" in argv:
        run_cli([a for a in argv if a != "--cli"])
        return
    if argv and argv[0] in ("cloak", "check"):
        sys.exit(run_cli(argv))
    root = tk.Tk()
    app = CrawlerApp(root)
    root.mainloop()
    if app.test_mode and app.callback_errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
