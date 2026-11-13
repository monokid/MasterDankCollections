"""The window: header, shared selection, tabs (built lazily), progress and console.

Test/scripting switches (environment): DANKCRAWL_AUTOQUIT_MS closes the window after that
many ms and switches off settings I/O and folder opening; DANKCRAWL_TAB picks the tab;
DANKCRAWL_FOLDER loads a playlist folder; DANKCRAWL_SHOW=success|failure paints that art;
DANKCRAWL_ADVANCED=1 opens every Advanced section.
"""
from __future__ import annotations

import importlib
import os
import sys
import tkinter as tk
from dataclasses import dataclass
from tkinter import ttk

import banner
from . import clock as clockmod
from . import system, theme
from .console import Console, ProgressPanel
from .context import Context
from .header import Header
from .selection import SelectionPanel
from .settings import Settings
from .tooltip import hide_all, tip_tabs

APP_TITLE = "DankCrawl"
TAB_STRIP_PX = 36          # height the notebook's tab row needs above a tab's content


@dataclass(frozen=True)
class TabSpec:
    key: str
    icon: str
    label: str
    mnemonic: str          # the letter underlined (Alt+letter jumps to the tab)
    title: str             # the wordmark shown while this tab is open
    banner: str
    tip: str
    module: str
    cls: str


# Order matters: Cloak is the main job, Dig is the power-user original and goes last.
TAB_SPECS = [
    TabSpec("cloak", "\U0001F47B", "Cloak", "C", "Cloaking the Dank", "cloak", "tab_cloak", "cloak", "CloakTab"),
    TabSpec("check", "\U0001FA7A", "Check", "k", "Checking the Dank", "check", "tab_check", "check", "CheckTab"),
    TabSpec("spotify", "\U0001F3A7", "Spotify", "S", "Orbiting the Dank", "orbit", "tab_spotify", "spotify", "SpotifyTab"),
    TabSpec("dig", "⛏", "Dig (library scan)", "D", "Mining for Dank", "dig", "tab_dig", "dig", "DigTab"),
]
SPEC = {t.key: t for t in TAB_SPECS}


def tab_text(spec: TabSpec) -> tuple[str, int]:
    """Notebook label and the index of the underlined letter. Tk counts a character
    outside the BMP (the emoji) as two, so the offset is measured in UTF-16 units."""
    prefix = spec.icon + "  "
    units = len(prefix.encode("utf-16-le")) // 2
    return prefix + spec.label, units + spec.label.index(spec.mnemonic)


class App:
    def __init__(self, root: tk.Tk, link_factory=None):
        self.root = root
        self.test_mode = bool(os.environ.get("DANKCRAWL_AUTOQUIT_MS"))
        self.scripted = self.test_mode or bool(os.environ.get("DANKCRAWL_TAB"))
        self.settings = Settings(persist=not self.scripted)
        self.ctx = Context(root, self.settings, link_factory or self._default_link, self.test_mode)
        ctx = self.ctx
        ctx.shell = self
        self.tabs: dict = {}
        self.frames: dict = {}
        self.cur = ""
        self.sash_user = False
        self._fit_pending = False
        self._konami: list[str] = []

        root.title(APP_TITLE)
        root.configure(bg=theme.BG)
        root.minsize(*theme.MIN_SIZE)
        self._place_window()
        root.report_callback_exception = self._on_tk_error
        theme.apply_style(root)
        self._build()
        self._wire_clock()
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.bind("<KeyPress>", self._on_key, "+")
        root.bind("<Return>", self._on_return)
        self._open_start_tab()
        root.after(150, self._finish_layout)
        ms = os.environ.get("DANKCRAWL_AUTOQUIT_MS")
        if ms and ms.isdigit():
            root.after(int(ms), self.close)

    def _default_link(self):
        """The Spotify link, imported only when the Spotify tab first needs it. Scripted runs
        must never read (or, on a client-id mismatch, delete) the real sign-in token."""
        import spotify_link
        if not self.scripted:
            return spotify_link.SpotifyLink()
        import tempfile
        return spotify_link.SpotifyLink(
            token_file=os.path.join(tempfile.gettempdir(), "dankcrawl-scripted-spotify.json"))

    @property
    def callback_errors(self) -> int:
        return self.ctx.callback_errors + self.clock.errors

    # ------------------------------------------------------------ window
    def _place_window(self) -> None:
        root = self.root
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        w, h = min(theme.DEFAULT_SIZE[0], sw - 60), min(theme.DEFAULT_SIZE[1], sh - 90)
        if self.scripted:
            root.geometry("%dx%d+30+20" % (w, h))
            root.attributes("-topmost", True)
            return
        geom = self.settings.get("geometry")
        root.geometry(geom if isinstance(geom, str) and geom else "%dx%d" % (w, h))
        if self.settings.get("zoomed", False):
            try:
                root.state("zoomed")
            except tk.TclError:
                root.attributes("-zoomed", True)

    def _on_tk_error(self, exc, val, tb) -> None:
        import traceback
        self.ctx.callback_errors += 1
        traceback.print_exception(exc, val, tb)

    def close(self) -> None:
        self.ctx.stop_flag.set()
        self.selection.cancel()
        hide_all(self.root)
        self.console.shutdown()
        self.clock.stop()
        if not self.scripted:
            try:
                zoomed = self.root.state() == "zoomed"
                st = self.settings
                st.set("zoomed", zoomed)
                if not zoomed:
                    st.set("geometry", self.root.geometry())
                st.set("sash", self.paned.sashpos(0))
                st.set("tab", self.cur)
                st.save()
            except (tk.TclError, OSError):
                pass
        self.root.destroy()

    # ------------------------------------------------------------ layout
    def _build(self) -> None:
        ctx, root = self.ctx, self.root
        ctx.header = self.header = Header(root, SPEC["cloak"].title)
        self.header.pack()
        self.paned = ttk.PanedWindow(root, orient="vertical")
        self.paned.pack(fill="both", expand=True, padx=theme.PAD_WINDOW, pady=(0, 14))
        self.upper = tk.Frame(self.paned, bg=theme.BG)
        lower = tk.Frame(self.paned, bg=theme.BG)
        self.paned.add(self.upper, weight=3)
        self.paned.add(lower, weight=2)

        ctx.selection = self.selection = SelectionPanel(ctx)
        self.sel_frame = self.selection.build(self.upper)
        self.nb = ttk.Notebook(self.upper)
        self.nb.pack(fill="both", expand=True)
        for spec in TAB_SPECS:
            f = tk.Frame(self.nb, bg=theme.BG, padx=4, pady=10)
            self.frames[spec.key] = f
            text, underline = tab_text(spec)
            self.nb.add(f, text=text, underline=underline)
        self.nb.enable_traversal()
        tip_tabs(self.nb, [t.tip for t in TAB_SPECS])

        ctx.progress = ProgressPanel(lower)
        ctx.progress.frame.pack(fill="x")
        ctx.console = self.console = Console(lower)
        self.header.on_swarm = lambda: self.console.log(
            "  The amoeba has had an idea. It has had several.", "accent")
        self.console.frame.pack(fill="both", expand=True, pady=(6, 0))
        self.paned.bind("<ButtonRelease-1>", lambda _e: setattr(self, "sash_user", True))

    def _wire_clock(self) -> None:
        """All animation and the worker-queue pump share one timer."""
        self.clock = clockmod.Clock(self.root)
        c, h, bar = self.clock, self.header, self.ctx.progress.bar
        c.add(self.ctx.pump, 1, clockmod.ALWAYS)
        c.add(h.strip.step, 2, clockmod.AWAKE)
        c.add(h.title.step, 12, clockmod.AWAKE)
        c.add(self.console.ticker.step, 3, clockmod.VISIBLE)
        c.add(lambda: bar.step() if bar.animating else None, 1, clockmod.VISIBLE)
        c.start()

    def _open_start_tab(self) -> None:
        """Show the remembered tab straight away; the event is bound only afterwards so
        Tk's initial 'first tab selected' event cannot build a tab nobody asked for."""
        env_tab = os.environ.get("DANKCRAWL_TAB")
        start = env_tab if env_tab in SPEC else self.settings.get("tab", "cloak")
        if start not in SPEC:
            start = "cloak"
        self.nb.select([t.key for t in TAB_SPECS].index(start))
        self._on_tab_changed()
        self.root.after_idle(lambda: self.nb.bind("<<NotebookTabChanged>>", self._on_tab_changed))

    def _finish_layout(self) -> None:
        """Things that need the window's real size: the divider, scripted extras."""
        if self.scripted and os.environ.get("DANKCRAWL_ADVANCED"):
            for tab in self.tabs.values():
                if hasattr(tab, "adv"):
                    tab.adv.set_open(True, notify=False)
        folder = os.environ.get("DANKCRAWL_FOLDER")
        if folder and os.path.isdir(folder):
            self.selection.var.set(folder)
            self.selection.load()
        show = os.environ.get("DANKCRAWL_SHOW")
        if show in ("success", "failure"):
            self.console.final_banner(show == "success")
        self._place_sash(0)

    def _place_sash(self, tries: int) -> None:
        if self.paned.winfo_height() < 300 and tries < 30:
            self.root.after(100, self._place_sash, tries + 1)
            return
        saved = self.settings.get("sash")
        if isinstance(saved, int):
            self.sash_user = True
            h = self.paned.winfo_height()
            try:
                self.paned.sashpos(0, max(200, min(saved, h - 130)))
            except tk.TclError:
                pass
        self.fit_upper()

    def fit_upper(self) -> None:
        """Size the upper pane to the open tab (the console gets the rest). Called whenever
        content appears or disappears; once the user has dragged the divider it only grows."""
        if self._fit_pending:
            return
        self._fit_pending = True
        self.root.after_idle(self._fit)

    def _fit(self) -> None:
        self._fit_pending = False
        self.root.update_idletasks()        # reqheight is stale until Tk has propagated geometry
        h = self.paned.winfo_height()
        frame = self.frames.get(self.cur)
        if h < 300 or frame is None:
            return
        sel = self.sel_frame.winfo_reqheight() + 6 if self.sel_frame.winfo_manager() == "pack" else 0
        need = sel + TAB_STRIP_PX + frame.winfo_reqheight() + 8
        pos = self.paned.sashpos(0)
        target = max(pos, min(need, h - 130)) if self.sash_user else max(200, min(need, h - 130))
        if target != pos:
            try:
                self.paned.sashpos(0, target)
            except tk.TclError:
                pass

    # ------------------------------------------------------------ tabs
    def _ensure_tab(self, key: str):
        tab = self.tabs.get(key)
        if tab is None:
            spec = SPEC[key]
            cls = getattr(importlib.import_module("gui.tabs." + spec.module), spec.cls)
            tab = self.tabs[key] = cls(self.ctx)
            tab.build(self.frames[key])
            self.ctx.register_tab(tab)
            tab.set_busy(self.ctx.busy)
            first = len(self.tabs) == 1
            if key == "dig":
                self.console.opening(system.app_dir(), first)
            else:
                self.console.tab_banner(spec.banner, banner.TAB_READY.get(key, []), first)
        return tab

    def _on_tab_changed(self, _e=None) -> None:
        idx = self.nb.index(self.nb.select())
        spec = TAB_SPECS[idx]
        self.cur = spec.key
        self.header.set_title(spec.title)
        tab = self._ensure_tab(spec.key)
        if tab.uses_selection:
            if self.sel_frame.winfo_manager() != "pack":
                self.sel_frame.pack(fill="x", before=self.nb, pady=(0, 6))
        else:
            self.sel_frame.pack_forget()
        tab.on_show()
        self.fit_upper()

    # ------------------------------------------------------------ keys
    def _on_return(self, e: tk.Event):
        w = e.widget
        if isinstance(w, (tk.Text, ttk.Treeview)):
            return None
        if isinstance(w, (ttk.Button, tk.Button)):
            if str(w.cget("state")) != "disabled":
                w.invoke()
            return "break"
        tab = self.tabs.get(self.cur)
        if tab is not None and not self.ctx.busy:
            tab.primary()
        return "break"

    def _on_key(self, e: tk.Event) -> None:
        self._konami.append(e.keysym)
        del self._konami[:-len(theme.KONAMI)]
        if self._konami == theme.KONAMI:
            self._konami = []
            self.ctx.progress.bar.spin(4.0)
            self.console.log("  The spectrum spins. You know the code.", "accent")


def run(link_factory=None) -> int:
    """Open the window and block until it closes. Returns the process exit code."""
    root = tk.Tk()
    app = App(root, link_factory)
    root.mainloop()
    return 1 if app.test_mode and app.callback_errors else 0


if __name__ == "__main__":
    sys.exit(run())
